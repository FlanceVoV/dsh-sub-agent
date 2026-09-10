/**
 * 任务清单的**应用服务**：把四样东西缝在一起。
 *
 *  - `plan.js`   纯逻辑：什么合法、谁在等谁、现在能跑什么（无副作用，可穷举测试）
 *  - `store.js`  事实：清单/任务/运行记录（谁被派发过、跑到什么状态）
 *  - `runtime.js`执行：真正把子 agent 跑起来（排队、并发上限、超时、取消都由它管）
 *  - 本文件      **决策**：什么时候把哪些「可执行」的任务真正激活
 *
 * ## 为什么「监测依赖并激活」这件事必须在宿主做，而不是让主 agent 做
 *
 * 主 agent 是一个**回合制**的模型：它调用 `subagent_run(wait=true)` 之后，
 * 整个回合就阻塞在那一次工具调用上，它既看不到兄弟任务什么时候结束，也无法在
 * 两次工具调用之间「守着」；而它一旦结束回合，就更不会有任何代码在跑。
 * 依赖完成是个**事件**，事件必须有常驻的东西来收——那就是插件进程。
 * 所以这里的姿态是：**宿主监测依赖并激活，把结果如实报告给主 agent**，
 * 同时把最终的裁量权留给它（清单级 `autoActivate:false`、单任务激活/重试/取消）。
 * 反过来做（让模型轮询）只会得到两种结果：要么白烧 token 空转，要么链路停在半路没人推。
 *
 * ## 激活的边界（决定都在这里，别处不再重复判断）
 *
 *  - **不替模型改清单**：这里只按 `plan.js` 算出来的 `ready` 顺序启动，顺序即图上的顺序。
 *  - **不额外限流**：并发由 `runtime.maxConcurrentRuns` 一处管（超出排队而不是失败）。
 *    刻意**不**套用 `maxParallelPerSession`：那条限制是给「一次对话里手抖 @ 太多」用的，
 *    而一条清单里的并行度是它自己的设计意图——套上去会让宽链路无故卡住。
 *  - **不猜父 agent**：拿不到活的父 agent 就不启动，把原因写进 `activationError`，
 *    界面上显示「为什么这条链路卡住了」。假装启动成功比卡住更糟。
 *
 * @module dsh-subagent-hub/tasks
 */
import { randomUUID } from 'node:crypto';
import { ROUTE_PREFIX } from './http.js';
import { describeError } from './log.js';
import {
  TERMINAL_RUN_STATUSES,
  describeNext,
  evaluate,
  renderBoardText,
  validatePlanDraft,
} from './plan.js';

/** 清单 id 前缀（界面上要能一眼分辨「这是清单还是任务」）。 */
const PLAN_ID_PREFIX = 'pl_';

/** SSE 与面板每秒推一次的精简视图里保留多少条清单（更早的去设置页看，那里是全量）。 */
const SUMMARY_PLAN_LIMIT = 8;

/** 激活的延后时间：0ms。见 `scheduleActivation` 里的说明。 */
const ACTIVATION_DEFER_MS = 0;

const TERMINAL_SET = new Set(TERMINAL_RUN_STATUSES);

/**
 * 造任务清单服务。
 * @param {{ctx:object,store:object,runtime:object,config:object,log:object}} deps - 依赖。
 * @returns {object} 服务对象。
 */
export function createTaskBoard({ ctx, store, runtime, config, log }) {
  /** 订阅者（SSE 用来立刻刷新，而不必等下一秒的心跳）。 */
  const listeners = new Set();
  /** runId → {planId, taskId}：运行结束事件只知道 run id，得靠它回到任务上。 */
  const links = new Map();
  /** 待激活的 planId 集合（去重）。 */
  const pending = new Set();
  let flushTimer = null;
  let disposed = false;

  /**
   * 广播一次「任务图变了」。
   * @param {string} planId - 变化的清单（空串表示全局变化）。
   * @returns {void}
   */
  const emit = (planId) => {
    for (const listener of listeners) {
      try {
        listener({ kind: 'tasks', planId });
      } catch (error) {
        log.debug(`task listener failed: ${describeError(error)}`);
      }
    }
  };

  /**
   * 把运行时快照里的实时数字挂到任务上。
   *
   * 为什么不写库：tok/s、已跑时长这类东西每秒都在变，落库等于每秒一次写事务，
   * 换来的只是「重启后还能看到上一次的瞬时值」——那个值本来就没有意义。
   * @param {object[]} tasks - 任务（含 runId）。
   * @returns {Map<string,object>} runId → 实时摘要。
   */
  const liveIndex = (tasks) => {
    const wanted = new Set(tasks.map((task) => task.runId).filter((id) => id !== ''));
    const map = new Map();
    if (wanted.size === 0) return map;
    let snapshot;
    try {
      snapshot = runtime.snapshot();
    } catch (error) {
      log.debug(`runtime.snapshot() failed: ${describeError(error)}`);
      return map;
    }
    for (const run of snapshot.runs ?? []) {
      if (!wanted.has(run.runId)) continue;
      map.set(run.runId, {
        busy: run.busy === true,
        status: run.status,
        tokPerS: run.tokPerS ?? 0,
        tokPerSEstimated: run.tokPerSEstimated === true,
        elapsedMs: run.elapsedMs ?? 0,
        tokensOut: run.tokensOut ?? 0,
        tools: run.tools ?? 0,
        sessionId: run.sessionId ?? '',
        outputChars: run.outputChars ?? 0,
      });
    }
    return map;
  };

  /**
   * 组一份给界面/模型看的清单视图。
   *
   * 状态全部来自 `plan.js` 的现算结果，本函数只做「把事实搬成视图」这件事——
   * 不在这里再判一次「能不能跑」，否则就会出现第二份口径。
   * @param {object} plan - 清单事实。
   * @param {object[]} tasks - 任务事实。
   * @param {{full?:boolean}} [options] - `full:true` 时带上任务说明正文（工具/详情页用）。
   * @returns {object}
   */
  const buildBoard = (plan, tasks, options = {}) => {
    const evaluated = evaluate(tasks);
    const live = liveIndex(tasks);
    const full = options.full === true;
    return {
      plan: {
        id: plan.id,
        title: plan.title,
        note: plan.note,
        autoActivate: plan.autoActivate,
        activationError: plan.activationError,
        parentSessionId: plan.parentSessionId,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      },
      tasks: tasks.map((task) => {
        const state = evaluated.byId[task.id];
        const runtimeInfo = live.get(task.runId);
        return {
          id: task.id,
          seq: task.seq,
          title: task.title,
          agentName: task.agentName,
          deps: [...task.deps],
          state: state?.state ?? 'waiting',
          depth: state?.depth ?? 0,
          runId: task.runId,
          runStatus: task.runStatus,
          attempts: task.attempts,
          note: task.note,
          waitingFor: state?.waitingFor ?? [],
          blockedBy: state?.blockedBy ?? [],
          startedAt: task.startedAt,
          endedAt: task.endedAt,
          cancelledAt: task.cancelledAt,
          live: runtimeInfo ?? null,
          ...(full ? { brief: task.brief } : {}),
        };
      }),
      // 边就是依赖本身：界面画图不需要再推一遍，也不会和 deps 分叉。
      edges: tasks.flatMap((task) => (task.deps ?? [])
        .filter((dep) => tasks.some((item) => item.id === dep))
        .map((dep) => ({ from: dep, to: task.id }))),
      layers: evaluated.layers,
      progress: evaluated.progress,
      ready: evaluated.ready,
      waiting: evaluated.waiting,
      blocked: evaluated.blocked,
      running: evaluated.running,
      done: evaluated.done,
      failed: evaluated.failed,
      cancelled: evaluated.cancelled,
      next: describeNext(evaluated),
      serverNow: Date.now(),
    };
  };

  /**
   * 读一条清单的视图。
   * @param {string} planId - 清单 id。
   * @param {{full?:boolean}} [options] - 选项。
   * @returns {object|undefined}
   */
  const board = (planId, options) => {
    const plan = store.getPlan(planId);
    if (plan === undefined) return undefined;
    return buildBoard(plan, store.listTasks(planId), options);
  };

  /**
   * 读全部清单的视图（新的在前）。
   * @param {{full?:boolean,limit?:number}} [options] - 选项。
   * @returns {object[]}
   */
  const boards = (options = {}) => {
    const plans = store.listPlans({ limit: options.limit ?? 50 });
    return plans.map((plan) => buildBoard(plan, store.listTasks(plan.id), options));
  };

  /**
   * 组一段「上游产出」文本。
   *
   * 为什么必须注入上游产出：子 agent 之间**不共享上下文**（传输实现自报
   * `inheritsParentContext: false`），下游根本没机会看到上游做了什么。
   * 不注入的话，「流水线」就退化成「一串互不相干的独立调用」——
   * 每一棒都得把上一棒的活重做一遍。
   * @param {object[]} deps - 依赖任务（已完成）。
   * @returns {string} 可能为空串。
   */
  const upstreamText = (deps) => {
    const limit = Number.isSafeInteger(config.taskUpstreamChars) && config.taskUpstreamChars > 0
      ? config.taskUpstreamChars
      : 2000;
    const parts = [];
    for (const dep of deps) {
      const run = dep.runId === '' ? undefined : store.getRun(dep.runId);
      if (run === undefined) continue;
      const body = String(run.outputTail ?? '').trim();
      const head = `--- 上游任务 ${dep.id}「${dep.title}」（${dep.agentName}，run ${dep.runId}）---`;
      if (body === '') {
        parts.push(`${head}\n（这一次运行没有留下输出正文）`);
        continue;
      }
      const clipped = body.length > limit
        ? `${body.slice(0, limit)}\n…（此处省略 ${body.length - limit} 个字符；完整正文见 /sub-agent/api/runs/${dep.runId}）`
        : body;
      parts.push(`${head}\n${clipped}`);
    }
    return parts.join('\n\n');
  };

  /**
   * 组交给子 agent 的完整提示词。
   *
   * 这里注入的是**任务上下文**，不是「打招呼」：子 agent 看不到主对话，
   * 不知道自己在一条链路的哪一环、上游给了什么、下游需要什么形状的产出。
   * 所以提示词必须自带这三件事，且明确写出「你的产出会被直接交给下游」。
   * @param {object} plan - 清单。
   * @param {object} task - 任务。
   * @param {object} boardView - 该清单的视图（用于画链路全貌）。
   * @param {object[]} deps - 依赖任务。
   * @returns {string}
   */
  const composePrompt = (plan, task, boardView, deps) => {
    const base = httpBase();
    const doneDeps = deps.filter((dep) => dep.runStatus === 'completed');
    const lines = [
      '【任务清单上下文】由 dsh-subagent-hub 自动注入——你看到的是一个任务链路里的**一项**任务，',
      '不是一段完整对话。主对话你看不到，所以你需要的背景必须由下面这段文字提供。',
      '',
      `清单「${plan.title}」（${plan.id}）｜进度 ${boardView.progress.done}/${boardView.progress.total}`,
      '',
      '链路全貌：',
      renderBoardText({ ...plan }, boardView.tasks.map((item) => ({
        id: item.id,
        seq: item.seq,
        title: item.title,
        brief: '',
        agentName: item.agentName,
        deps: item.deps,
        runId: item.runId,
        runStatus: item.runStatus,
        cancelledAt: item.cancelledAt,
        attempts: item.attempts,
      }))),
      '',
      `你的任务：${task.id}「${task.title}」`,
    ];
    if (task.brief !== '') lines.push('', '任务说明：', task.brief);

    const upstream = upstreamText(doneDeps);
    if (upstream !== '') {
      lines.push('', '上游产出（你的输入材料，不是你该做的事）：', upstream);
    }

    lines.push(
      '',
      '规则：',
      `- 只完成 ${task.id} 这一项。其它任务由别的子 agent 负责，不要替它们做决定。`,
      '- 你的产出会被**直接交给下游任务**当输入：请结论先行，写清具体路径/命令/数字，',
      '  不要写「如上所述」这类只有本对话才懂的指代。',
      '- 明确写出你没做到的部分和不确定的地方——下游会按你的结论往下做。',
    );
    if (base !== '') {
      lines.push(
        '',
        `进度可以随时查（只读）：GET ${base}${ROUTE_PREFIX}/tasks/${plan.id}`,
        `如果你有 subagent_tasks 工具，也可以直接调它。`,
      );
    }
    return lines.join('\n');
  };

  /**
   * 猜一个本机 API 基址（写进给子 agent 的提示词，让它能自查进度）。
   *
   * 拿不到端口时**如实返回空串**，宁可不写这一行：写一个猜出来的地址比不写更糟——
   * 子 agent 会去请求一个不存在的端口，然后花好几步去排查一个我们编出来的错误。
   * @returns {string}
   */
  const httpBase = () => {
    try {
      const server = ctx?.get?.('webServer');
      const port = Number(server?.port);
      if (!Number.isSafeInteger(port) || port <= 0) return '';
      const host = typeof server?.host === 'string' && server.host === '0.0.0.0' ? '127.0.0.1' : (server?.host ?? '127.0.0.1');
      return `http://${host}:${port}`;
    } catch {
      return '';
    }
  };

  /**
   * 读一条清单的全体任务事实 + 视图。
   * @param {string} planId - 清单 id。
   * @returns {{plan:object,tasks:object[],view:object}|undefined}
   */
  const load = (planId) => {
    const plan = store.getPlan(planId);
    if (plan === undefined) return undefined;
    const tasks = store.listTasks(planId);
    return { plan, tasks, view: buildBoard(plan, tasks) };
  };

  /**
   * 排一次「依赖完成后自动激活」。
   *
   * 为什么延后到下一轮事件循环而不是当场激活：这个函数是从**运行结束事件**的回调里被调的，
   * 而激活本身又会触发新的运行事件（`runtime.start` 会立刻广播一次）。
   * 当场做就是事件回调里套事件回调，链一长就会叠成几十层递归；
   * 延后到 0ms 还能把「同一瞬间结束的好几个任务」合并成一次激活。
   * @param {string} planId - 清单 id。
   * @returns {void}
   */
  const scheduleActivation = (planId) => {
    if (disposed) return;
    pending.add(planId);
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, ACTIVATION_DEFER_MS);
    flushTimer.unref?.();
  };

  /**
   * 立刻处理所有待激活的清单（测试与「手动激活」都走这一条）。
   *
   * 每一步都单独兜异常：这个方法是从定时器里 `void flush()` 调用的，
   * 抛出去就是一个没人接的 Promise——库已经关掉、清单被删掉这类**正常**的竞态
   * 都会变成进程级的 unhandled rejection。激活失败该退化成一条日志，而不是崩掉宿主。
   * @returns {Promise<object[]>} 每次激活的结果。
   */
  const flush = async () => {
    const results = [];
    for (const planId of [...pending]) {
      pending.delete(planId);
      try {
        const result = activate(planId, { reason: '依赖完成', invokedBy: 'auto' });
        if (result.started.length > 0 || result.error !== '') results.push({ planId, ...result });
      } catch (error) {
        log.warn(`激活清单 ${planId} 失败（不影响其它链路）：${describeError(error)}`);
      }
    }
    return results;
  };

  /**
   * 激活一条清单里的任务。
   *
   * @param {string} planId - 清单 id。
   * @param {{taskId?:string, parentAgent?:object, parentSessionId?:string, invokedBy?:string, reason?:string, force?:boolean}} [options] - 选项。
   * @returns {{ok:boolean, started:object[], skipped:object[], error:string, board:object|undefined}}
   */
  const activate = (planId, options = {}) => {
    const loaded = load(planId);
    if (loaded === undefined) {
      return { ok: false, started: [], skipped: [], error: `没有这条清单：${planId}`, board: undefined };
    }
    const { plan, view } = loaded;
    const manual = options.invokedBy !== 'auto';
    const targets = options.taskId === undefined ? view.ready : [options.taskId];

    if (targets.length === 0) {
      return { ok: true, started: [], skipped: [], error: '', board: view };
    }

    // 手动指定任务时，状态必须是「可执行」——否则把原因说清楚，而不是硬启动一次
    // （硬启动会让「等待依赖」的任务在上游还没产出时就跑起来，链路的语义就没了）。
    const skipped = [];
    if (options.taskId !== undefined) {
      const state = view.tasks.find((task) => task.id === options.taskId);
      if (state === undefined) {
        return { ok: false, started: [], skipped: [], error: `清单 ${planId} 里没有任务「${options.taskId}」`, board: view };
      }
      if (state.state !== 'ready') {
        return {
          ok: false,
          started: [],
          skipped: [],
          error: describeNotActivatable(state),
          board: view,
        };
      }
    }

    // 自动激活是清单的属性：关掉之后宿主只标记「可执行」，等主 agent/用户来点。
    if (!manual && plan.autoActivate !== true) {
      return { ok: true, started: [], skipped: [], error: '', board: view };
    }

    const parentSessionId = options.parentSessionId ?? plan.parentSessionId;
    let parentAgent = options.parentAgent;
    if (parentAgent === undefined) {
      const resolved = runtime.resolveParent(parentSessionId);
      parentAgent = resolved.agent;
      if (parentAgent === undefined) {
        const message = `无法自动激活「${plan.title}」：${resolved.error}。`
          + '任务链路需要一个活着的父会话——让主对话保持这一轮，或者用 subagent_tasks 手动激活。';
        if (plan.activationError !== message) {
          store.updatePlan(planId, { activationError: message });
          log.warn(message);
          emit(planId);
        }
        return { ok: false, started: [], skipped: [], error: message, board: load(planId)?.view };
      }
    }

    const started = [];
    let failureNote = '';
    for (const taskId of targets) {
      const state = view.tasks.find((task) => task.id === taskId);
      const task = store.getTask(planId, taskId);
      if (state === undefined || task === undefined) continue;
      if (state.state !== 'ready') {
        skipped.push({ taskId, reason: describeNotActivatable(state) });
        continue;
      }
      const agent = store.getAgentByName(task.agentName);
      if (agent === undefined) {
        const message = `任务 ${taskId} 指向的子 agent「${task.agentName}」不存在（可能被归档或改名了）`;
        store.updateTask(planId, taskId, { note: message });
        if (failureNote === '') failureNote = message;
        skipped.push({ taskId, reason: message });
        log.warn(`${message}——清单「${plan.title}」的这条链路会卡住`);
        continue;
      }
      const view2 = load(planId)?.view ?? view;
      const prompt = composePrompt(plan, task, view2, task.deps.map((dep) => store.getTask(planId, dep)).filter((item) => item !== undefined));
      const result = runtime.start({
        agent,
        prompt,
        parentAgent,
        parentSessionId,
        // 任务 id 直接当 task_key：跨轮回归按「同一个任务」聚合，正是它想要的口径。
        taskKey: taskId,
        roundId: null,
        invokedBy: options.invokedBy ?? 'task-board',
      });
      if (!result.ok) {
        // 启动失败必须留下痕迹（而不是只在一行日志里）：
        // 「清单建好了、任务却一个都没跑」正是最需要解释的一种状态，
        // 所以把它写进清单的 activationError——界面、工具输出、HTTP 三处都会显示它。
        const message = `任务 ${taskId} 未能启动：${result.error}`;
        if (failureNote === '') failureNote = message;
        skipped.push({ taskId, reason: result.error });
        log.warn(`激活任务 ${planId}/${taskId} 失败：${result.error}`);
        continue;
      }
      const now = Date.now();
      store.updateTask(planId, taskId, {
        runId: result.run.id,
        runStatus: 'queued',
        attempts: task.attempts + 1,
        startedAt: now,
        endedAt: null,
        note: '',
      });
      links.set(result.run.id, { planId, taskId });
      started.push({ taskId, runId: result.run.id, agentName: agent.name });
      log.info(`清单「${plan.title}」激活任务 ${taskId}（${agent.name}，run ${result.run.id}）｜${options.reason ?? '手动'}`);
    }

    if (failureNote !== '' && plan.activationError !== failureNote) {
      store.updatePlan(planId, { activationError: failureNote });
      emit(planId);
    } else if (started.length > 0 && plan.activationError !== '') {
      // 起来了就把上一次的失败说明清掉：那块提示只该反映**当下**卡在哪。
      store.updatePlan(planId, { activationError: '' });
      emit(planId);
    } else if (started.length > 0 || skipped.length > 0) {
      emit(planId);
    }
    return { ok: true, started, skipped, error: failureNote, board: load(planId)?.view ?? view };
  };

  /**
   * 运行事件 → 任务对账 → 触发下游激活。
   * @param {object} frame - 运行时事件。
   * @returns {void}
   */
  const onRunFrame = (frame) => {
    if (frame?.kind !== 'run' || frame.summary === undefined) return;
    const summary = frame.summary;
    const link = links.get(summary.runId) ?? lookupLink(summary.runId);
    if (link === undefined) return;
    const task = store.getTask(link.planId, link.taskId);
    if (task === undefined || task.runId !== summary.runId) return;

    const status = String(summary.status ?? '');
    const terminal = TERMINAL_SET.has(status);
    // 只在**状态真的变了**或**刚进终态**时写库：运行途中每个 chunk 都会广播一次事件，
    // 每次都写 sqlite 等于拿磁盘换一个每秒都在变的瞬时值。
    const changed = task.runStatus !== status;
    const justEnded = terminal && task.endedAt === null;
    if (!changed && !justEnded) return;

    const patch = {
      runStatus: status,
      startedAt: task.startedAt ?? summary.startedAt ?? Date.now(),
      endedAt: terminal ? (summary.endedAt ?? Date.now()) : null,
    };
    if (terminal) {
      patch.note = status === 'completed'
        ? ''
        : `${status}：${String(summary.error ?? '').trim() || '没有更多信息（见该次运行的详情）'}`;
    }
    // 运行被取消 → 任务就是「已取消」，而不是含混的「失败」。
    // 两者对下游的影响一样（都会让下游阻塞），但对用户的意义完全不同：
    // 「取消」是人做的决定，不该被显示成一个红色故障。
    if (status === 'cancelled') patch.cancelledAt = Date.now();
    store.updateTask(link.planId, link.taskId, patch);
    emit(link.planId);
    if (terminal) {
      log.info(`清单任务 ${link.planId}/${link.taskId} 结束：${status}`);
      // 依赖完成 → 重新算一次可执行集合。这就是需求里「主 agent 监测依赖完成后再激活」的落点。
      scheduleActivation(link.planId);
    }
  };

  /**
   * 进程重启后内存里的 links 是空的，用库里的 run_id 兜底对账。
   * @param {string} runId - run id。
   * @returns {{planId:string,taskId:string}|undefined}
   */
  const lookupLink = (runId) => {
    const task = store.taskByRun(runId);
    if (task === undefined) return undefined;
    const link = { planId: task.planId, taskId: task.id };
    links.set(runId, link);
    return link;
  };

  /**
   * 建一条清单。
   * @param {object} input - `{title,note,autoActivate,tasks}`。
   * @param {{parentSessionId?:string, parentAgent?:object, invokedBy?:string}} [meta] - 来源信息。
   * @returns {{ok:boolean, errors:string[], board:object|undefined, started:object[]}}
   */
  const createPlan = (input, meta = {}) => {
    const checked = validatePlanDraft(input, { knownAgents: store.listAgents().map((agent) => agent.name) });
    if (!checked.ok) return { ok: false, errors: checked.errors, board: undefined, started: [] };

    const id = `${PLAN_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const autoActivate = input.autoActivate === undefined ? config.taskAutoActivate !== false : checked.plan.autoActivate;
    store.insertPlan({
      id,
      title: checked.plan.title,
      note: checked.plan.note,
      parentSessionId: meta.parentSessionId ?? '',
      autoActivate,
    });
    store.insertTasks(id, checked.plan.tasks);
    log.info(`新建任务清单「${checked.plan.title}」（${id}）：${checked.plan.tasks.length} 项任务，`
      + `${autoActivate ? '依赖完成自动激活' : '手动激活'}`);
    // 建单即可执行的任务立刻激活：否则用户看到的是一条「什么都不在跑」的链路，
    // 还得自己去点一下——那正是「自动激活」想要避免的。
    // 但 `autoActivate:false` 是一条**整体**承诺（「这条链路听我的」），
    // 连「建单即就绪」也不能例外——否则关掉自动激活的清单会在建单那一刻自己跑起来，
    // 而这个承诺是用户为了控成本才关的。
    const result = autoActivate
      ? activate(id, {
        parentAgent: meta.parentAgent,
        parentSessionId: meta.parentSessionId,
        invokedBy: meta.invokedBy ?? 'task-board',
        reason: '建单即就绪',
      })
      : { ok: true, started: [], skipped: [], error: '', board: board(id) };
    return {
      ok: true,
      errors: [],
      board: result.board ?? board(id),
      started: result.started,
      skipped: result.skipped,
      activationError: result.error,
    };
  };

  /**
   * 往已有清单里追加任务。
   * @param {string} planId - 清单 id。
   * @param {object} input - `{tasks}`（title 可省，沿用清单名）。
   * @param {{parentAgent?:object, invokedBy?:string}} [meta] - 来源信息。
   * @returns {{ok:boolean, errors:string[], board:object|undefined, started:object[]}}
   */
  const appendTasks = (planId, input, meta = {}) => {
    const plan = store.getPlan(planId);
    if (plan === undefined) return { ok: false, errors: [`没有这条清单：${planId}`], board: undefined, started: [] };
    const existing = store.listTasks(planId);
    const checked = validatePlanDraft(input, {
      knownAgents: store.listAgents().map((agent) => agent.name),
      requireTitle: false,
      takenIds: new Set(existing.map((task) => task.id)),
      baseIds: new Set(existing.map((task) => task.id)),
    });
    if (!checked.ok) return { ok: false, errors: checked.errors, board: board(planId), started: [] };

    const offset = existing.reduce((max, task) => Math.max(max, task.seq), 0);
    store.insertTasks(planId, checked.plan.tasks.map((task, index) => ({ ...task, seq: offset + index + 1 })));
    const result = activate(planId, {
      parentAgent: meta.parentAgent,
      invokedBy: meta.invokedBy ?? 'task-board',
      reason: '追加任务后',
    });
    return { ok: true, errors: [], board: result.board ?? board(planId), started: result.started, skipped: result.skipped };
  };

  /**
   * 重试一个失败/取消的任务（清掉运行事实，让它回到「可执行」）。
   * @param {string} planId - 清单 id。
   * @param {string} taskId - 任务 id。
   * @param {{parentAgent?:object, invokedBy?:string}} [meta] - 来源信息。
   * @returns {{ok:boolean, error:string, board:object|undefined, started:object[]}}
   */
  const retry = (planId, taskId, meta = {}) => {
    const loaded = load(planId);
    const state = loaded?.view.tasks.find((task) => task.id === taskId);
    if (loaded === undefined || state === undefined) {
      return { ok: false, error: `清单 ${planId} 里没有任务「${taskId}」`, board: loaded?.view, started: [] };
    }
    if (state.state === 'blocked') {
      return {
        ok: false,
        error: `任务 ${taskId} 被上游阻塞（${state.blockedBy.join('、')} 失败或取消）：`
          + '光重试它没有用，先重试或取消那些上游任务。',
        board: loaded.view,
        started: [],
      };
    }
    if (state.state !== 'failed' && state.state !== 'cancelled') {
      return {
        ok: false,
        error: `任务 ${taskId} 当前是「${state.state}」，只有失败或被取消的任务才需要重试`,
        board: loaded.view,
        started: [],
      };
    }
    store.updateTask(planId, taskId, {
      runId: '', runStatus: '', endedAt: null, cancelledAt: null, startedAt: null, note: '',
    });
    const result = activate(planId, {
      taskId,
      parentAgent: meta.parentAgent,
      invokedBy: meta.invokedBy ?? 'task-board',
      reason: '重试',
    });
    return { ok: result.ok, error: result.error, board: result.board, started: result.started };
  };

  /**
   * 取消一个任务：正在跑的连运行一起取消，否则只标记。
   * @param {string} planId - 清单 id。
   * @param {string} taskId - 任务 id。
   * @returns {{ok:boolean, error:string, board:object|undefined}}
   */
  const cancelTask = (planId, taskId) => {
    const loaded = load(planId);
    const state = loaded?.view.tasks.find((task) => task.id === taskId);
    if (loaded === undefined || state === undefined) {
      return { ok: false, error: `清单 ${planId} 里没有任务「${taskId}」`, board: loaded?.view };
    }
    if (state.state === 'done') {
      return { ok: false, error: `任务 ${taskId} 已经完成了，取消它不会撤销已产生的结果`, board: loaded.view };
    }
    const cancelledRun = state.runId !== '' && (state.state === 'running') ? runtime.cancel(state.runId) : false;
    store.updateTask(planId, taskId, { cancelledAt: Date.now() });
    emit(planId);
    log.info(`已取消任务 ${planId}/${taskId}${cancelledRun ? '（连带取消了正在跑的那次运行）' : ''}`);
    return { ok: true, error: '', board: board(planId) };
  };

  /**
   * 取消整条清单：在跑的取消运行，没跑的标记取消（已完成的不动）。
   * @param {string} planId - 清单 id。
   * @returns {{ok:boolean, error:string, cancelled:number, board:object|undefined}}
   */
  const cancelPlan = (planId) => {
    const loaded = load(planId);
    if (loaded === undefined) return { ok: false, error: `没有这条清单：${planId}`, cancelled: 0, board: undefined };
    const now = Date.now();
    let count = 0;
    for (const task of loaded.view.tasks) {
      if (task.state === 'done' || task.state === 'cancelled') continue;
      if (task.state === 'running' && task.runId !== '') runtime.cancel(task.runId);
      store.updateTask(planId, task.id, { cancelledAt: now });
      count += 1;
    }
    emit(planId);
    log.info(`已取消清单「${loaded.plan.title}」的 ${count} 个未完成任务`);
    return { ok: true, error: '', cancelled: count, board: board(planId) };
  };

  /**
   * 开关「依赖完成自动激活」。
   * @param {string} planId - 清单 id。
   * @param {boolean} value - 目标状态。
   * @returns {{ok:boolean, error:string, board:object|undefined, started:object[]}}
   */
  const setAutoActivate = (planId, value) => {
    const plan = store.getPlan(planId);
    if (plan === undefined) return { ok: false, error: `没有这条清单：${planId}`, board: undefined, started: [] };
    store.updatePlan(planId, { autoActivate: value === true });
    // 打开自动激活的当下就把已经就绪的任务放行，否则用户看到的还是「改了没用」。
    const started = value === true
      ? activate(planId, { invokedBy: 'panel', reason: '打开自动激活' }).started
      : [];
    return { ok: true, error: '', board: board(planId), started };
  };

  /**
   * 删掉一条清单（连任务一起）。运行记录不删：那是运行台账，属于另一条线。
   * @param {string} planId - 清单 id。
   * @returns {{ok:boolean, error:string, removedTasks:number}}
   */
  const removePlan = (planId) => {
    const plan = store.getPlan(planId);
    if (plan === undefined) return { ok: false, error: `没有这条清单：${planId}`, removedTasks: 0 };
    const removedTasks = store.deletePlan(planId);
    pending.delete(planId);
    emit(planId);
    log.info(`已删除清单「${plan.title}」（${removedTasks} 项任务；运行记录与评价保留）`);
    return { ok: true, error: '', removedTasks };
  };

  /**
   * 是不是本插件派出去的**子 agent 会话**。
   *
   * 用途只有一处：工具边界上区分「派活的人」和「干活的人」——
   * 任务清单的写操作（激活/取消/重试）只该由派活的一方做。
   * 子 agent 手里也有工具，如果放开，A 任务可以取消 B 任务，
   * 而那条链路的推进权就不再属于调度者了。
   * @param {string} sessionId - 工具调用者所在的会话 id。
   * @returns {boolean}
   */
  const isChildSession = (sessionId) => runtime.isChildSession(sessionId);

  /**
   * 把一个「不能立刻激活」的任务讲清楚。
   * @param {object} state - 任务的视图条目。
   * @returns {string}
   */
  const describeNotActivatable = (state) => {
    switch (state.state) {
      case 'waiting':
        return `任务 ${state.id} 还不能跑：它在等 ${state.waitingFor.join('、')} 完成`;
      case 'blocked':
        return `任务 ${state.id} 被上游阻塞：${state.blockedBy.join('、')} 失败或被取消，先处理它们`;
      case 'running':
        return `任务 ${state.id} 已经在跑了（run ${state.runId}，状态 ${state.runStatus}）`;
      case 'done':
        return `任务 ${state.id} 已经完成了`;
      case 'cancelled':
        return `任务 ${state.id} 已被取消：要重跑请先重试（retry）`;
      case 'failed':
        return `任务 ${state.id} 上一次失败了（${state.note === '' ? state.runStatus : state.note}）：要重跑请先重试（retry）`;
      default:
        return `任务 ${state.id} 当前状态是 ${state.state}，无法激活`;
    }
  };

  return {
    attach() {
      const unsubscribe = runtime.subscribe(onRunFrame);
      return () => {
        try {
          unsubscribe?.();
        } catch (error) {
          log.debug(`task board unsubscribe failed: ${describeError(error)}`);
        }
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      pending.clear();
      listeners.clear();
    },
    createPlan,
    appendTasks,
    boards,
    board,
    /**
     * SSE 每秒推的精简视图：条数有界，且不含任务说明正文（那是详情页/工具才需要的）。
     * @returns {{plans:object[], total:number, truncated:boolean}}
     */
    summary() {
      const all = boards({ limit: SUMMARY_PLAN_LIMIT + 1 });
      return {
        plans: all.slice(0, SUMMARY_PLAN_LIMIT),
        total: store.listPlans({ limit: 200 }).length,
        truncated: all.length > SUMMARY_PLAN_LIMIT,
      };
    },
    activate,
    retry,
    cancelTask,
    cancelPlan,
    setAutoActivate,
    removePlan,
    isChildSession,
    /** 测试与排错用：立刻把待激活的都处理掉。 */
    flush,
    /** 纯函数转发（界面与工具渲染共用同一份状态语言）。 */
    evaluateTasks: evaluate,
  };
}
