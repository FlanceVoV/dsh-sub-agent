/**
 * HTTP seam：宿主与面板之间**唯一**的通道（普通 HTTP + JSON + SSE）。
 *
 * 为什么不用 DSH 内部的 RPC/typert：那会把这个插件绑死在 DSH 的内部协议版本上。
 * 用普通 HTTP 换来三重好处——可独立调试（scripts/dev-server.mjs 不启动 DSH 也能看同一份负载）、
 * 可搬运（宿主侧零 `@deepseek-ai/*` 依赖）、可降级（端点连不上时面板显示错误而不是崩）。
 *
 * 为什么实时通道用 SSE 而不是轮询：悬浮球要显示 tok/s、详情页要显示**逐 token 的输出**，
 * 轮询要么太慢（看不出来在动）要么太费（为了流速去拉全文）。SSE 是单向的、
 * 浏览器原生支持、断线自动重连，正好匹配「宿主 → 面板」这个方向。
 *
 * @module dsh-subagent-hub/http
 */
import { describeError } from './log.js';
import { applyConfigPatch, describeConfig, userConfigPath, validateConfigPatch } from './config.js';
import { discoverCatalog, resolveModelDetail } from './discovery.js';
import { describeToolPolicy, findNameConflict, validateAgentInput } from './registry.js';
import { describeHarness } from './version.js';

/**
 * 端点前缀。故意做成常量而非配置项：它是宿主与客户端 bundle 之间的契约，
 * 允许配置就会产生「两边不一致 → 面板空白」的故障模式。改前缀 = 改版本。
 */
export const ROUTE_PREFIX = '/sub-agent/api';

/** SSE 心跳间隔：定期推一份状态快照，即使没有任何事件也能让面板保持新鲜。 */
const SSE_STATE_INTERVAL_MS = 1000;

/**
 * 造一个请求处理器。
 * @param {{ctx:object,store:object,runtime:object,config:object,log:object,version:string}} deps - 依赖。
 * @returns {Function} `(req, res) => Promise<void>`。
 */
export function createHandler(deps) {
  const { log } = deps;
  return async function handle(req, res) {
    try {
      if (!isSameOriginRequest(req, deps)) {
        sendJson(res, 403, { error: 'forbidden: cross-origin request rejected' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      const method = (req.method ?? 'GET').toUpperCase();

      if (path === '/stream' && method === 'GET') {
        openStream(deps, req, res);
        return;
      }

      const body = method === 'POST' || method === 'PATCH' ? await readJsonBody(req) : undefined;
      const payload = await route(deps, { path, method, url, body, req });
      if (payload === NOT_HANDLED) {
        sendJson(res, 404, { error: `unknown endpoint ${method} ${path}` });
        return;
      }
      sendJson(res, payload.status ?? 200, payload.body);
    } catch (error) {
      log.error(`request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      // 请求体本身不合法是**客户端错误**（400），不是服务端故障（500）。
      // 之前一律回 500，会让「我 JSON 写错了」看起来像「插件炸了」——
      // 排查方向就从改请求变成了翻日志。
      const malformed = error instanceof Error && /^(invalid JSON body|request body too large)/.test(error.message);
      if (!res.headersSent) sendJson(res, malformed ? 400 : 500, { error: describeError(error) });
      else res.end();
    }
  };
}

/** 路由未命中的哨兵。 */
const NOT_HANDLED = Symbol('not-handled');

/**
 * 路由分派。
 * @param {object} deps - 依赖。
 * @param {{path:string,method:string,url:URL,body:any,req:object}} request - 请求上下文。
 * @returns {Promise<{status?:number,body:any}|typeof NOT_HANDLED>}
 */
async function route(deps, request) {
  const { path, method, url, body } = request;
  const { store, runtime, config, ctx, log } = deps;

  // ---- 健康与状态 ----
  if (path === '/health' && method === 'GET') {
    return {
      body: {
        ok: true,
        plugin: 'subagent-hub',
        version: deps.version,
        dataDir: deps.dataDir,
        dbPath: deps.dbPath,
        initError: deps.initError ?? null,
        capabilities: describeCapabilities(ctx, log),
        // 团队模式单独报一块：它是本插件自己装配的服务（不看 ctx 有没有对应子系统），
        // 所以不能用 describeCapabilities 那套「ctx.get 得到吗」的口径。
        team: deps.team === undefined
          ? { available: false, mode: false }
          : { available: true, mode: deps.team.isTeamMode(), teams: deps.team.summary().total },
        // DSH 版本与兼容性。`compatible` 是三态：true / false / null（无法判定）。
        // 探测刻意含在 /health 里而不是只写日志——装完第一件事就是看这个端点。
        harness: describeHarness(ctx),
        routes: ROUTE_PREFIX,
      },
    };
  }

  if ((path === '/state' || path === '/') && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const catalog = discoverCatalog(ctx, deps.log);
    return {
      body: {
        catalog,
        agents: store.listAgents().map((agent) => decorateAgent(agent, config)),
        // 已归档的也要给界面：否则「归档」看起来像删除，而且没有回头路。
        // 真机上就是这么丢掉四个配置的——列表里没有它们，用户以为数据没了。
        archivedAgents: store.listAgents({ includeArchived: true })
          .filter((agent) => agent.archivedAt !== null)
          .map((agent) => decorateAgent(agent, config)),
        runtime: runtime.snapshot(),
        // 任务链路图跟着状态一起给：面板要在**同一帧**里看到「谁在跑」与「任务到哪一步」，
        // 分两个端点拿会有两套时间戳，界面会出现「运行已经结束、任务还写着运行中」的错帧。
        tasks: deps.tasks === undefined ? { plans: [], total: 0, truncated: false } : deps.tasks.summary(),
        // 团队（群组）跟任务图同一帧：群聊与它派出去的任务链必须一起看——
        // 分成两次拉取会出现「群里说派完了、链上还是空的」这种错帧。
        team: deps.team === undefined
          ? { teams: [], total: 0, teamMode: false, active: 0 }
          : deps.team.summary(),
        // 启用开关是**全局**的：配置本来就是全局的，开关的作用域必须和它控制的东西一致。
        // 按会话记会让新对话得到一个「配置都在、却什么都看不见」的界面。
        enabled: readEnabled(store),
        enabledScope: 'global',
        sessionId,
        serverNow: Date.now(),
      },
    };
  }

  // ---- 开关（全局）----
  if (path === '/enable' && method === 'POST') {
    // sessionId 仍然接受但**不再使用**：老客户端会带它，忽略即可，不该因此报错。
    const enabled = store.setEnabled(body?.enabled === true);
    deps.log.info(`sub-agent plugin ${enabled ? 'enabled' : 'disabled'} (global)`);
    return { body: { enabled, scope: 'global' } };
  }

  // ---- 团队模式（群组）----
  //
  // 团队模式是**全局**开关，理由与启用开关相同：成员是全局配置、群聊记录全机一份。
  // 关掉它不只是「不显示」，还会把正在讨论的团队暂停（见 team.js 的 setTeamMode）。
  if (path === '/team/mode' && method === 'POST') {
    if (deps.team === undefined) return { status: 503, body: { error: '团队服务不可用：本次启动没有装配它' } };
    const result = deps.team.setTeamMode(body?.enabled === true);
    return { body: { teamMode: result.teamMode, paused: result.paused, scope: 'global' } };
  }

  if (path === '/team' && method === 'GET') {
    if (deps.team === undefined) return { status: 503, body: { error: '团队服务不可用：本次启动没有装配它' } };
    return { body: { ...deps.team.summary(), serverNow: Date.now() } };
  }

  if (path === '/team' && method === 'POST') {
    if (deps.team === undefined) return { status: 503, body: { error: '团队服务不可用：本次启动没有装配它' } };
    const result = deps.team.open({
      declaration: String(body?.declaration ?? ''),
      mission: String(body?.mission ?? ''),
      parentSessionId: String(body?.parentSessionId ?? ''),
      autoStart: body?.autoStart !== false,
      invokedBy: 'panel',
    });
    if (!result.ok) return { status: 400, body: { errors: result.errors, warnings: result.warnings } };
    return {
      status: 201,
      body: {
        team: deps.team.stateOf(result.team.id),
        warnings: result.warnings,
        startError: result.startError ?? '',
      },
    };
  }

  const teamMatch = /^\/team\/([^/]+)$/.exec(path);
  if (teamMatch !== null && method === 'GET') {
    if (deps.team === undefined) return { status: 503, body: { error: '团队服务不可用：本次启动没有装配它' } };
    const teamId = decodeURIComponent(teamMatch[1]);
    const since = Number(url.searchParams.get('since'));
    const view = deps.team.stateOf(teamId, Number.isSafeInteger(since) && since > 0
      ? { since, limit: clampLimit(url.searchParams.get('limit'), 200) }
      : { limit: clampLimit(url.searchParams.get('limit'), 200) });
    if (view === undefined) return { status: 404, body: { error: `没有这个团队：${teamId}` } };
    return { body: view };
  }

  const teamActionMatch = /^\/team\/([^/]+)\/(say|start|pause|close)$/.exec(path);
  if (teamActionMatch !== null && method === 'POST') {
    if (deps.team === undefined) return { status: 503, body: { error: '团队服务不可用：本次启动没有装配它' } };
    const teamId = decodeURIComponent(teamActionMatch[1]);
    const action = teamActionMatch[2];
    const existing = deps.team.get(teamId);
    if (existing === undefined) return { status: 404, body: { error: `没有这个团队：${teamId}` } };

    if (action === 'say') {
      const said = deps.team.userSay(teamId, String(body?.text ?? ''));
      if (!said.ok) return { status: 400, body: { error: said.error } };
      return { body: { message: said.message, team: deps.team.stateOf(teamId, { limit: 200 }) } };
    }
    if (action === 'start') {
      const result = deps.team.start(teamId, { invokedBy: 'panel' });
      if (!result.ok) return { status: 409, body: { error: result.error } };
      return { body: { team: deps.team.stateOf(teamId) } };
    }
    if (action === 'pause') {
      const result = deps.team.pause(teamId, '用户在面板上暂停了讨论。');
      if (!result.ok) return { status: 409, body: { error: result.error } };
      return { body: { team: deps.team.stateOf(teamId) } };
    }
    const result = deps.team.close(teamId, '用户在面板上结束了这场讨论。');
    if (!result.ok) return { status: 409, body: { error: result.error } };
    return { body: { team: deps.team.stateOf(teamId) } };
  }

  // ---- 运行护栏 / 插件配置（并发上限等）----
  if (path === '/config' && method === 'GET') {
    return {
      body: {
        config: deps.config,
        items: describeConfig(deps.config, deps.dataDir),
        userConfigPath: userConfigPath(deps.dataDir),
        // 排队中的数量：调大并发后它应当立刻开始下降，界面据此给出反馈。
        queued: runtime.snapshot().queuedCount,
      },
    };
  }
  if (path === '/config' && method === 'PATCH') {
    const checked = validateConfigPatch(body, deps.config);
    if (!checked.ok) return { status: 400, body: { errors: checked.errors, warnings: checked.warnings } };
    if (Object.keys(checked.value).length === 0) {
      return { body: { applied: {}, items: describeConfig(deps.config, deps.dataDir), note: '没有实际变化' } };
    }
    const result = applyConfigPatch(deps.dataDir, deps.config, checked.value);
    // 关键一步：改完**立刻**让新的并发上限生效。
    // 否则调大上限之后，已经排队的任务要等下一次有任务结束才被放出去，
    // 用户看到的就是「改了没用」——又一个没有声音的降级。
    if (typeof runtime.reconfigure === 'function') runtime.reconfigure();
    deps.log.info(`config updated: ${JSON.stringify(result.applied)}`);
    return {
      body: {
        applied: result.applied,
        items: describeConfig(deps.config, deps.dataDir),
        file: result.file,
        warnings: checked.warnings,
      },
    };
  }

  // ---- 模型详情（窗口、推理档位）----
  if (path === '/model-detail' && method === 'POST') {
    const provider = String(body?.provider ?? '');
    const model = String(body?.model ?? '');
    if (provider === '' || model === '') return { status: 400, body: { error: 'provider 与 model 必填' } };
    return { body: { detail: await resolveModelDetail(ctx, provider, model) } };
  }

  // ---- agent 配置增删改 ----
  if (path === '/agents' && method === 'POST') {
    const catalog = discoverCatalog(ctx, deps.log);
    const checked = validateAgentInput(body, { mode: 'create', catalog });
    if (!checked.ok) return { status: 400, body: { errors: checked.errors, warnings: checked.warnings } };
    const conflict = findNameConflict({ store }, checked.value.name);
    if (conflict !== null) return { status: 409, body: { errors: [conflict], warnings: checked.warnings } };
    const agent = store.insertAgent(checked.value);
    return { status: 201, body: { agent: decorateAgent(agent, config), warnings: checked.warnings } };
  }

  const agentMatch = /^\/agents\/([^/]+)$/.exec(path);
  if (agentMatch !== null) {
    const id = decodeURIComponent(agentMatch[1]);
    const existing = store.getAgent(id);
    if (existing === undefined) return { status: 404, body: { error: `没有这个 agent：${id}` } };

    if (method === 'PATCH') {
      const catalog = discoverCatalog(ctx, deps.log);
      const checked = validateAgentInput(body, { mode: 'update', existing, catalog });
      if (!checked.ok) return { status: 400, body: { errors: checked.errors, warnings: checked.warnings } };
      const conflict = findNameConflict({ store }, checked.value.name, id);
      if (conflict !== null) return { status: 409, body: { errors: [conflict], warnings: checked.warnings } };
      const agent = store.updateAgent(id, checked.value);
      return { body: { agent: decorateAgent(agent, config), warnings: checked.warnings } };
    }
    if (method === 'DELETE') {
      // 幂等性上要区分两种情况，因为对用户来说它们的意思完全不同：
      //  - 已经是归档状态 → 很可能界面上的列表是旧的、用户又点了一次。
      //    这时回一个**解释清楚**的 409，比一个「没有这个 agent」的 404 有用得多，
      //    否则用户会以为插件坏了。
      //  - 真的不存在 → 404。
      if (existing.archivedAt !== null) {
        return {
          status: 409,
          body: {
            error: `「${existing.name}」已经是归档状态了（可能你之前点过一次）。`
              + '界面上的列表可能是旧的，刷新页面即可看到最新状态——数据是对的。',
            alreadyArchived: true,
          },
        };
      }
      if (!store.archiveAgent(id)) {
        return { status: 409, body: { error: `归档「${existing.name}」失败：状态刚被别处改动，请重试` } };
      }
      return { body: { archived: id, name: existing.name } };
    }
    if (method === 'GET') {
      return { body: { agent: decorateAgent(existing, config) } };
    }
  }

  const restoreMatch = /^\/agents\/([^/]+)\/restore$/.exec(path);
  if (restoreMatch !== null && method === 'POST') {
    const id = decodeURIComponent(restoreMatch[1]);
    const result = store.restoreAgent(id);
    if (result.ok) return { body: { restored: id } };
    if (result.reason === 'missing') return { status: 404, body: { error: `没有这个 agent：${id}` } };
    if (result.reason === 'not-archived') return { status: 409, body: { error: '这个 agent 本来就没被归档' } };
    return {
      status: 409,
      body: {
        error: `恢复失败：已经有一个未归档的 agent 叫「${result.conflictWith}」了。`
          + '名字是 @ 的句柄必须唯一——请先把那个改名或归档，再恢复这一个。',
        nameTaken: true,
      },
    };
  }

  // ---- 任务清单与依赖图 ----
  //
  // 路由全都挂在 `/tasks/<planId>` 下，因为**任务 id 是清单内唯一的**（`t1` 出现在每条清单里）。
  // 把清单放进路径，模型写的依赖可以是最短的 `t3`，而 HTTP 这一层没有歧义。
  if (path === '/tasks' && method === 'GET') {
    if (deps.tasks === undefined) return { status: 503, body: { error: '任务清单不可用：本次启动没有装配任务服务' } };
    const plans = deps.tasks.boards({ full: true, limit: clampLimit(url.searchParams.get('limit'), 50) });
    return { body: { plans, total: plans.length, serverNow: Date.now() } };
  }
  if (path === '/tasks' && method === 'POST') {
    if (deps.tasks === undefined) return { status: 503, body: { error: '任务清单不可用：本次启动没有装配任务服务' } };
    // 面板建的清单没有 exec.agent，父会话只能从 body 里拿（建单即激活需要它）。
    const parentSessionId = String(body?.parentSessionId ?? '');
    const result = deps.tasks.createPlan(body ?? {}, {
      parentSessionId,
      invokedBy: 'panel',
    });
    if (!result.ok) return { status: 400, body: { errors: result.errors } };
    return {
      status: 201,
      body: {
        plan: result.board,
        started: result.started,
        // 「一个都没启动」时必须说明为什么——否则界面只会显示一条安静的链路，
        // 而用户的第一反应是「插件坏了」。
        skipped: result.skipped ?? [],
        activationError: result.activationError ?? '',
      },
    };
  }

  const planMatch = /^\/tasks\/([^/]+)$/.exec(path);
  if (planMatch !== null) {
    if (deps.tasks === undefined) return { status: 503, body: { error: '任务清单不可用：本次启动没有装配任务服务' } };
    const planId = decodeURIComponent(planMatch[1]);
    const view = deps.tasks.board(planId, { full: true });
    if (view === undefined) return { status: 404, body: { error: `没有这条清单：${planId}` } };
    if (method === 'GET') return { body: { plan: view, serverNow: Date.now() } };
    if (method === 'PATCH') {
      if (typeof body?.autoActivate !== 'boolean') {
        return { status: 400, body: { error: '只支持改 autoActivate（布尔）：清单名与任务说明请重建清单' } };
      }
      const result = deps.tasks.setAutoActivate(planId, body.autoActivate);
      if (!result.ok) return { status: 409, body: { error: result.error } };
      return { body: { plan: result.board, started: result.started } };
    }
    if (method === 'DELETE') {
      const result = deps.tasks.removePlan(planId);
      if (!result.ok) return { status: 404, body: { error: result.error } };
      return { body: { removed: planId, removedTasks: result.removedTasks } };
    }
  }

  const planActionMatch = /^\/tasks\/([^/]+)\/(tasks|activate|cancel)$/.exec(path);
  if (planActionMatch !== null && method === 'POST') {
    if (deps.tasks === undefined) return { status: 503, body: { error: '任务清单不可用：本次启动没有装配任务服务' } };
    const planId = decodeURIComponent(planActionMatch[1]);
    const action = planActionMatch[2];
    if (action === 'tasks') {
      const result = deps.tasks.appendTasks(planId, body ?? {}, { invokedBy: 'panel' });
      if (!result.ok) return { status: 400, body: { errors: result.errors } };
      return { status: 201, body: { plan: result.board, started: result.started } };
    }
    if (action === 'activate') {
      const taskId = typeof body?.taskId === 'string' && body.taskId !== '' ? body.taskId : undefined;
      const result = deps.tasks.activate(planId, { taskId, invokedBy: 'panel', reason: '面板手动激活' });
      if (!result.ok) return { status: 409, body: { error: result.error, plan: result.board } };
      return { body: { plan: result.board, started: result.started, skipped: result.skipped } };
    }
    const result = deps.tasks.cancelPlan(planId);
    if (!result.ok) return { status: 404, body: { error: result.error } };
    return { body: { plan: result.board, cancelled: result.cancelled } };
  }

  const taskActionMatch = /^\/tasks\/([^/]+)\/([^/]+)\/(retry|cancel|activate)$/.exec(path);
  if (taskActionMatch !== null && method === 'POST') {
    if (deps.tasks === undefined) return { status: 503, body: { error: '任务清单不可用：本次启动没有装配任务服务' } };
    const planId = decodeURIComponent(taskActionMatch[1]);
    const taskId = decodeURIComponent(taskActionMatch[2]);
    const action = taskActionMatch[3];
    if (action === 'retry') {
      const result = deps.tasks.retry(planId, taskId, { invokedBy: 'panel' });
      if (!result.ok) return { status: 409, body: { error: result.error, plan: result.board } };
      return { body: { plan: result.board, started: result.started } };
    }
    if (action === 'cancel') {
      const result = deps.tasks.cancelTask(planId, taskId);
      if (!result.ok) return { status: 409, body: { error: result.error, plan: result.board } };
      return { body: { plan: result.board } };
    }
    const result = deps.tasks.activate(planId, { taskId, invokedBy: 'panel', reason: '面板手动激活' });
    if (!result.ok) return { status: 409, body: { error: result.error, plan: result.board } };
    return { body: { plan: result.board, started: result.started } };
  }

  // ---- 运行 ----
  if (path === '/runs' && method === 'GET') {
    return {
      body: {
        runs: store.listRuns({
          limit: Number(url.searchParams.get('limit') ?? 50),
          agentId: url.searchParams.get('agentId') ?? undefined,
          parentSessionId: url.searchParams.get('parentSessionId') ?? undefined,
          roundId: url.searchParams.get('roundId') ?? undefined,
          taskKey: url.searchParams.get('taskKey') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
        }),
        runtime: runtime.snapshot(),
      },
    };
  }

  if (path === '/run' && method === 'POST') {
    return startRun(deps, body, 'panel');
  }

  const runMatch = /^\/runs\/([^/]+)(\/detail|\/cancel|\/evaluations)?$/.exec(path);
  if (runMatch !== null) {
    const id = decodeURIComponent(runMatch[1]);
    const suffix = runMatch[2] ?? '';
    if (suffix === '/detail' && method === 'GET') {
      const live = runtime.detail(id);
      const stored = store.getRun(id);
      if (live === undefined && stored === undefined) return { status: 404, body: { error: `没有这次运行：${id}` } };

      // 增量拉取：详情页要**逐 token** 地跟，但每轮把整篇正文重传一遍是浪费
      // （长产出会有几十 KB）。所以支持 `outputSince`：只回「上次之后新增的那一段」，
      // 由客户端拼接。不传就是全量，便于调试与首次打开。
      const sinceRaw = url.searchParams.get('outputSince');
      const since = sinceRaw === null ? null : Math.max(0, Number(sinceRaw) || 0);
      if (live !== undefined && since !== null) {
        const full = typeof live.output === 'string' ? live.output : '';
        const from = Math.min(since, full.length);
        return {
          body: {
            run: stored,
            live: { ...live, output: undefined },
            outputDelta: full.slice(from),
            outputLength: full.length,
            // 客户端用 reset 判断「服务端比我知道的短」，说明该重置而不是拼接。
            reset: since > full.length,
            source: 'live',
            serverNow: Date.now(),
          },
        };
      }

      // 终态之后内存里的遥测仍保留；进程重启后只剩落库的部分，此时如实回落到落库值。
      return { body: { run: stored, live: live ?? null, source: live === undefined ? 'store' : 'live', serverNow: Date.now() } };
    }
    if (suffix === '/cancel' && method === 'POST') {
      return { body: { cancelled: runtime.cancel(id) } };
    }
    if (suffix === '/evaluations' && method === 'GET') {
      return { body: { evaluations: store.listEvaluations(id) } };
    }
    if (suffix === '' && method === 'GET') {
      const run = store.getRun(id);
      if (run === undefined) return { status: 404, body: { error: `没有这次运行：${id}` } };
      return { body: { run, evaluations: store.listEvaluations(id) } };
    }
  }

  // ---- 评价 / 排名 / 回归 ----
  if (path === '/evaluate' && method === 'POST') {
    return evaluate(deps, body);
  }
  if (path === '/leaderboard' && method === 'GET') {
    return { body: { leaderboard: store.agentLeaderboard(), computedAt: Date.now() } };
  }
  if (path === '/regression' && method === 'GET') {
    return { body: { regression: store.regressionByTask(url.searchParams.get('taskKey') ?? undefined) } };
  }
  if (path === '/rounds' && method === 'GET') {
    return { body: { rounds: store.listRounds() } };
  }
  if (path === '/rounds' && method === 'POST') {
    return { status: 201, body: { round: store.insertRound(body ?? {}) } };
  }

  return NOT_HANDLED;
}

/**
 * 起一次运行（工具与面板共用这一条路径，保证两边的规则完全一致）。
 * @param {object} deps - 依赖。
 * @param {object} body - 请求体。
 * @param {string} invokedBy - 触发来源。
 * @returns {{status?:number,body:any}}
 */
export function startRun(deps, body, invokedBy) {
  const { store, runtime } = deps;
  const agentRef = String(body?.agent ?? body?.agentId ?? '');
  const prompt = String(body?.prompt ?? '');
  const parentSessionId = String(body?.parentSessionId ?? '');

  if (prompt.trim() === '') return { status: 400, body: { error: 'prompt 必填' } };
  if (parentSessionId === '') return { status: 400, body: { error: 'parentSessionId 必填' } };

  // 支持按名字（@ 句柄）或按 id 指定，两者都走同一套解析。
  const agent = store.getAgent(agentRef) ?? store.getAgentByName(agentRef);
  if (agent === undefined) {
    const names = store.listAgents().map((item) => item.name);
    return {
      status: 404,
      body: { error: `找不到子 agent "${agentRef}"${names.length > 0 ? `；当前可用：${names.join(', ')}` : '；还没有配置任何子 agent'}` },
    };
  }

  // 「忙的不能被 @」的**硬边界**：UI 置灰只是礼貌，这里才是规则。
  const snapshot = runtime.snapshot();
  const busy = snapshot.runs.find((run) => run.agentName === agent.name && run.busy);
  if (busy !== undefined) {
    return {
      status: 409,
      body: {
        error: `子 agent "${agent.name}" 正在忙（run ${busy.runId}，已跑 ${Math.round(busy.elapsedMs / 1000)}s），本次拒绝。`
          + '等它跑完再 @，或者改用另一个空闲的子 agent。',
        busyRunId: busy.runId,
      },
    };
  }

  const parent = runtime.resolveParent(parentSessionId);
  // 面板触发的运行没有工具执行身份，只能按会话去查活动 agent。
  // 工具触发的运行由 tools.js 直接传 exec.agent，绕开这一查。
  if (parent.agent === undefined && body?.parentAgent === undefined) {
    return { status: 409, body: { error: parent.error } };
  }

  const result = runtime.start({
    agent,
    prompt,
    parentAgent: body?.parentAgent ?? parent.agent,
    parentSessionId,
    taskKey: typeof body?.taskKey === 'string' ? body.taskKey : '',
    roundId: typeof body?.roundId === 'string' && body.roundId !== '' ? body.roundId : null,
    invokedBy,
  });
  if (!result.ok) return { status: 409, body: { error: result.error } };
  return { status: 202, body: { run: result.run } };
}

/**
 * 写一条评价。
 * @param {object} deps - 依赖。
 * @param {object} body - 请求体。
 * @returns {{status?:number,body:any}}
 */
export function evaluate(deps, body) {
  const { store } = deps;
  const runId = String(body?.runId ?? '');
  if (runId === '') return { status: 400, body: { error: 'runId 必填' } };
  const run = store.getRun(runId);
  if (run === undefined) return { status: 404, body: { error: `没有这次运行：${runId}` } };

  const dimensions = normalizeDimensions(body?.dimensions);
  let score = Number(body?.score);
  if (!Number.isFinite(score)) {
    // 允许只给分维度：总分由维度均值算出来，省掉一次「自己算平均」的机会出错。
    const values = Object.values(dimensions);
    if (values.length === 0) return { status: 400, body: { error: 'score 或 dimensions 至少要给一个' } };
    score = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  score = Math.max(0, Math.min(100, score));

  const evaluation = store.insertEvaluation({
    runId,
    roundId: typeof body?.roundId === 'string' && body.roundId !== '' ? body.roundId : run.roundId,
    score: Math.round(score * 100) / 100,
    verdict: typeof body?.verdict === 'string' ? body.verdict : '',
    dimensions,
    notes: typeof body?.notes === 'string' ? body.notes : '',
    evaluator: typeof body?.evaluator === 'string' && body.evaluator !== '' ? body.evaluator : 'main-conversation',
  });
  return { status: 201, body: { evaluation } };
}

/**
 * 归一化维度分数：只接受 0-100 的有限数。
 * @param {unknown} raw - 原始维度。
 * @returns {Record<string, number>}
 */
function normalizeDimensions(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    out[String(key)] = Math.max(0, Math.min(100, Math.round(num * 100) / 100));
  }
  return out;
}

/**
 * 给 UI 的 agent 视图：附上「策略会怎么落地」的人话解释，避免用户猜。
 * @param {object} agent - agent 配置。
 * @param {object} config - 插件配置。
 * @returns {object}
 */
function decorateAgent(agent, config) {
  return { ...agent, toolPolicyDetail: describeToolPolicy(agent, config.readonlyToolAllow) };
}

/**
 * 解析 limit 查询参数（有界：面板要的是「最新的若干条」，不是整库）。
 * @param {string|null} raw - 原始值。
 * @param {number} fallback - 缺省值。
 * @returns {number}
 */
function clampLimit(raw, fallback) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, 200);
}

/**
 * 读全局启用状态（缺省关：需求明确要求「启用了才展示悬浮球」）。
 *
 * 注意：**不再接收 sessionId**。开关是全局的，带会话参数只会让调用方以为它是按会话的。
 * @param {object} store - 存储。
 * @returns {boolean}
 */
function readEnabled(store) {
  return store.isEnabled() === true;
}

/**
 * 开一条 SSE 流。
 * @param {object} deps - 依赖。
 * @param {object} req - 请求。
 * @param {object} res - 响应。
 * @returns {void}
 */
function openStream(deps, req, res) {
  const { runtime, store, log } = deps;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': subagent-hub stream open\n\n');

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      log.debug(`sse write failed: ${describeError(error)}`);
    }
  };

  // enabled 也要推：开关是全局的，一个窗口改了，**其它窗口必须跟着变**——
  // 否则「打开一次就对所有对话生效」只在刷新页面之后才成立，用户会以为没共享成功。
  const frame = () => ({
    runtime: runtime.snapshot(),
    enabled: readEnabled(store),
    // 任务链路图跟着同一帧走：面板要同时看到「谁在跑」和「任务到哪一步」。
    tasks: deps.tasks === undefined ? { plans: [], total: 0, truncated: false } : deps.tasks.summary(),
    team: deps.team === undefined ? { teams: [], total: 0, teamMode: false, active: 0 } : deps.team.summary(),
    serverNow: Date.now(),
  });

  send('state', frame());
  const unsubscribers = [runtime.subscribe((change) => {
    if (change.kind === 'run') send('run', change);
  })];
  // 任务图的变化**立刻**推一帧，而不是等下一秒的心跳：依赖完成 → 下游被激活
  // 这一瞬间正是一条链路最值得看的地方，延迟一秒会让它看起来像是随机发生的。
  if (deps.tasks !== undefined && typeof deps.tasks.subscribe === 'function') {
    unsubscribers.push(deps.tasks.subscribe(() => { send('state', frame()); }));
  }
  // 群聊同理，而且更急：一条新发言是「有人正在说话」的唯一信号，
  // 晚一秒就会出现「球说在跑、群里却还没有那句话」的错帧。
  if (deps.team !== undefined && typeof deps.team.subscribe === 'function') {
    unsubscribers.push(deps.team.subscribe(() => { send('state', frame()); }));
  }
  const timer = setInterval(() => {
    send('state', frame());
  }, SSE_STATE_INTERVAL_MS);
  timer.unref?.();

  const close = () => {
    clearInterval(timer);
    for (const unsubscribe of unsubscribers) unsubscribe();
    try {
      res.end();
    } catch {
      /* 客户端已经走了 */
    }
  };
  req.on?.('close', close);
  req.on?.('error', close);
}

/**
 * 读 JSON 请求体。
 * @param {object} req - 请求。
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // 1MB 上限：请求体里只有配置和任务文本，不该出现大对象。
      if (size > 1024 * 1024) {
        reject(new Error('request body too large (1MB limit)'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${describeError(error)}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 同源防护。
 *
 * 只在宿主绑定到 0.0.0.0（对局域网开放）时才启用——loopback 绑定下不打扰任何调用方；
 * 一旦服务暴露到网络上，就拒绝跨站读取（避免任意网页通过 DNS rebinding / 跨域读取本机数据，
 * 这里的负载包含 agent 配置、运行正文与评价）。
 *
 * @param {object} req - 请求。
 * @param {object} deps - 依赖。
 * @returns {boolean}
 */
function isSameOriginRequest(req, deps) {
  const host = deps.ctx?.get?.('webServer')?.host ?? '127.0.0.1';
  if (host !== '0.0.0.0') return true;
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * 描述当前部署具备哪些能力（面板据此决定显示什么，而不是让用户对着空列表猜）。
 * @param {object} ctx - cordis 上下文。
 * @param {object} log - logger。
 * @returns {object}
 */
function describeCapabilities(ctx, log) {
  const has = (name) => {
    try {
      return typeof ctx?.get === 'function' && ctx.get(name) !== undefined;
    } catch {
      return false;
    }
  };
  void log;
  return {
    subagents: has('subagents'),
    agents: has('agents'),
    tools: has('tools'),
    systemPrompt: has('systemPrompt'),
    llm: has('llm'),
    settings: has('settings'),
    credentials: has('credentials'),
    sessions: has('sessions'),
  };
}

/**
 * 输出 JSON 响应。
 * @param {object} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} value - 负载。
 * @returns {void}
 */
function sendJson(res, status, value) {
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
