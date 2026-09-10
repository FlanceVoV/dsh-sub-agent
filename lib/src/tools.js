/**
 * 模型侧入口：主对话怎么知道有子 agent、怎么调、调完怎么评价。
 *
 * 三个东西，缺一不可：
 *  1. **系统提示词段**：告诉主对话「用户消息里出现 @名字 就是委派」，并附上花名册。
 *     这是需求 4 里「自动注入提示词」的落点。
 *  2. **`subagent_run` 工具**：真正的执行入口。规则（忙则拒绝、未启用则拒绝）在这里强制。
 *  3. **`subagent_evaluate` 工具**：需求 5 的落点——主对话按注入的量规打分。
 *
 * ## 为什么本文件不 import 任何 `@deepseek-ai/*`
 *
 * `ctx.tools.register()` 要的是一个结构性对象 `ToolDefinition =
 * {name, description, parameters, output:{schema, render}, execute, ...}`，其中
 * `parameters` 是**普通 JSON Schema**。DSH 自带的 `defineTool()` 只是把「简写 spec」
 * 编译成 JSON Schema 再加一层参数校验的糖。我们直接写 JSON Schema，
 * 于是整个宿主半边保持零 `@deepseek-ai/*` 依赖——版本升级与跨机搬运都不受影响。
 * 代价是参数校验要自己做（下面每个工具都做了），这本来就是应该做的：
 * 模型给的参数形状不可信。
 *
 * @module dsh-subagent-hub/tools
 */
import { describeError } from './log.js';
import { safeGet } from './discovery.js';
import { renderBoardText } from './plan.js';
import { READONLY_TOOL_ALLOW } from './registry.js';
import { contentToText } from './runtime.js';

/** 提示词段的排序位：紧跟在 DSH 内置的 subagent 工具段（2800）之后。 */
const PROTOCOL_ORDER = 2810;

/** 评价量规的维度（注入到提示词里，也用于打分）。 */
export const RUBRIC_DIMENSIONS = Object.freeze([
  { key: 'correctness', label: '正确性', hint: '结论是否正确、有没有事实性错误' },
  { key: 'completeness', label: '完整性', hint: '是否覆盖了任务要求的全部要点' },
  { key: 'efficiency', label: '效率', hint: '是否用尽量少的步骤与 token 达成目标' },
  { key: 'cost', label: '成本', hint: 'token 消耗是否与任务规模相称（注意：DSH 无价格数据，这里只看 token）' },
]);

/**
 * 造模型侧入口。
 * @param {object} context - 插件运行态（ctx/store/runtime/config/log）。
 * @returns {{install:Function,warnings:string[],transports:string[]}}
 */
export function buildTools(context) {
  const { ctx, store, runtime, config, log } = context;
  const tasks = context.tasks;
  const warnings = [];

  const toolsService = safeGet(ctx, 'tools');
  const promptService = safeGet(ctx, 'systemPrompt');
  const subagentsService = safeGet(ctx, 'subagents');

  if (toolsService === undefined || typeof toolsService.register !== 'function') {
    warnings.push('ctx.tools 不可用：主对话看不到 subagent_run / subagent_evaluate 工具（悬浮球与面板仍可用）');
  }
  if (promptService === undefined || typeof promptService.section !== 'function') {
    warnings.push('ctx.systemPrompt 不可用：不会注入子 agent 调用协议（主对话不知道 @ 的约定）');
  }
  if (tasks === undefined) {
    warnings.push('任务清单服务不可用：subagent_plan / subagent_tasks 不注册（@ 委派与面板不受影响）');
  }

  const transports = subagentsService === undefined ? [] : listTransports(subagentsService);

  /**
   * 读插件是否已启用。
   *
   * **全局**，不看会话：开关和它控制的东西（全局的 agent 配置）作用域必须一致。
   * 如果这里按会话判，就会出现「在 A 对话里 @ 能调用、在 B 对话里被拒绝」——
   * 而两边看到的是同一份花名册，那是最让人困惑的一种不一致。
   * @returns {boolean}
   */
  const isEnabled = () => store.isEnabled() === true;

  /**
   * 从工具执行身份里取父会话与父 agent。
   * @param {object} exec - 工具执行上下文。
   * @returns {{sessionId:string,agent:object|undefined}}
   */
  const callerOf = (exec) => {
    const agent = exec?.agent;
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : '';
    return { sessionId, agent };
  };

  //#region 提示词段

  /**
   * 注入调用协议。
   *
   * 关于「启用才注入」：`AssembleContext` 只给到 `scope`，**没有会话 id**，因此这里
   * 无法可靠地判断当前会话的开关状态。所以采取的做法是：
   *   - 提示词段**总是**注入（否则主对话不知道 @ 的存在，用户 @ 了也没人理）；
   *   - **强制点在工具边界**：未启用的会话调用 `subagent_run` 会被明确拒绝，
   *     并且提示词里写清楚「被拒绝是因为没启用，请让用户去输入框开启，不要重试」。
   * 这样既能用，又不会让模型陷入无意义的重试。
   */
  const protocolText = () => {
    const agents = store.listAgents().filter((agent) => agent.archivedAt === null);
    if (agents.length === 0) return '';
    const busyNames = new Set(runtime.snapshot().runs.filter((run) => run.busy).map((run) => run.agentName));
    const roster = agents.map((agent) => {
      const policy = agent.toolPolicy === 'inherit' ? '全工具' : agent.toolPolicy === 'readonly' ? '只读' : '无工具';
      const state = busyNames.has(agent.name) ? '忙' : '闲';
      return `  - ${agent.name} → ${agent.modelProvider}/${agent.modelId}（工具：${policy}，当前：${state}）`;
    }).join('\n');

    // 未完成链路的现状：主对话看不到面板、也不会被自动激活的事件打断，
    // 所以每次装配提示词时把「你离开期间链路走到哪了」直接写给它——
    // 否则它下次醒来会重复派发，或者以为链路还在跑而一直等。
    let chainLines = [];
    if (tasks !== undefined && typeof tasks.pendingLines === 'function') {
      try {
        chainLines = tasks.pendingLines(5);
      } catch (error) {
        log.debug(`pendingLines failed: ${describeError(error)}`);
      }
    }

    return [
      '## 子 agent（subagent-hub）',
      '',
      '本对话可以使用若干**子 agent**：它们是同一套 DSH agent 运行时、只是跑在**另一个模型**上的独立智能体。',
      '它们看不到本对话的历史（不继承上下文），所以每次委派都要把任务讲清楚、给足背景。',
      '',
      '已配置的子 agent：',
      roster,
      '',
      ...(chainLines.length === 0 ? [] : [
        '### ⚠ 未完成的任务链路（这一节每次对话都按最新状态重写）',
        ...chainLines,
        '在一条链路跑完之前**不要结束回合**：你的回合一旦结束，主对话就不再等它了。',
        '要继续就调 `subagent_tasks`（它会顺带放行已经就绪的任务）。',
        '',
      ]),
      '### 约定：用户消息里的 @ 就是委派',
      '当用户的消息里出现 `@名字`（例如「@研究员 查一下 X」）时：',
      '1. 对每一个被 @ 的名字调用 `subagent_run`（`agent` 传名字，`prompt` 传你要给它的完整任务）。',
      '   要 @ 多个就**发起多次调用**——不同 agent 的调用是并发安全的，可以并行。',
      '2. 拿到结果后，把子 agent 的产出**作为素材**整合成你自己的回答。不要原样转发，也不要替它编造。',
      '3. 每次委派结束后，调用 `subagent_evaluate` 给这次运行打分（见下）。',
      '',
      '### 硬规则',
      '- **忙的子 agent 不能被 @**：`subagent_run` 会直接拒绝并返回哪个 run 还占着它。',
      '  被拒绝时不要重试，要么等，要么换一个空闲的，要么如实告诉用户。',
      '- 调用被拒绝如果是因为「本会话未启用插件」，**不要重试**：请让用户在输入框那一行的开关里启用它。',
      '- 不确定有哪些子 agent、谁忙谁闲时，先调 `subagent_roster`。',
      '',
      '### 多步任务：先建任务清单，再让链路自己走（`subagent_plan`）',
      '当一个任务**需要多步、且有先后依赖**（例如「先调研 → 再实现 → 最后评审」）时，',
      '先调 `subagent_plan` 把清单与依赖一次性建出来，而不是自己一步一步串行地 @：',
      '',
      '```jsonc',
      '{ "title": "发布 0.2.0", "tasks": [',
      '  { "id": "spec", "title": "调研现状", "agent": "研究员", "brief": "……完整任务说明……" },',
      '  { "id": "impl", "title": "实现与自测", "agent": "工程师", "brief": "……", "deps": ["spec"] },',
      '  { "id": "review", "title": "独立评审", "agent": "审核员", "brief": "……", "deps": ["impl"] } ] }',
      '```',
      '',
      '建完之后：',
      '- 与依赖无关的任务**立刻**被激活；有依赖的进入 `等待依赖`。',
      '- **依赖一完成，宿主会自动激活下游**（这条链路不需要你轮询：你的回合是阻塞的，看不到兄弟任务什么时候结束）。',
      '- 用 `subagent_tasks` 看整条链路的现状：谁在跑、谁完成、谁在等谁、谁被上游失败卡住。',
      '- 上游产出会被自动注入下游的提示词，所以下游不必重做上游的活；你的产出也要写成「能让不相干的人读懂」。',
      '- 清单级 `auto_activate:false` 时宿主只把任务标成「可执行」，由你用 `action:"activate"` 手动放行。',
      '',
      '### 任务清单可以**查看**（`subagent_tasks`，只读）',
      '`subagent_tasks` 默认只读：列出全部清单，或按 `plan_id` / `task_id` 看某一条链路的依赖图与状态。',
      '**子 agent 也可以调它**（写操作会被拒绝）——被委派的子 agent 由此能看到自己在这条链路里的位置、',
      '上游给了什么、下游在等什么。',
      '',
      '### 评价量规（`subagent_evaluate`）',
      '按四个维度各打 0-100 分，总分由工具按均值算：',
      ...RUBRIC_DIMENSIONS.map((dimension) => `  - ${dimension.key}（${dimension.label}）：${dimension.hint}`),
      '打分要基于子 agent 的实际产出，不要因为「它很努力」给高分。没有拿到结果就打低分并说明原因。',
    ].join('\n');
  };

  //#endregion

  //#region 工具

  /**
   * 把一次委派绑定到任务清单里的某一项任务（`subagent_run` 的 `task_id` 分支）。
   *
   * 为什么不复用普通分支：那一条的输入是「agent + prompt」，而任务链路的输入是**清单**——
   * agent 由清单指定、提示词由宿主带上下游产出拼出来、跑完之后还要有人去激活下游。
   * 在模型这侧重复这些事只会产生第二套口径（比如它自己拼的提示词漏了上游产出）。
   *
   * @param {{args:object,sessionId:string,parentAgent:object|undefined,empty:object,boundTask:string}} input - 输入。
   * @returns {Promise<object>} 与 runTool 的 output schema 同形。
   */
  const runTaskBound = async ({ args, sessionId, parentAgent, empty, boundTask }) => {
    if (tasks === undefined) {
      return { ...empty, error: '任务清单服务不可用：本次启动没有装配它（改用 agent + prompt 直接委派）' };
    }
    if (String(args?.prompt ?? '').trim() !== '') {
      return {
        ...empty,
        agent: '',
        error: '绑定了 task_id 时不要再传 prompt',
        note: '任务说明应当写在清单里（brief）——那样下游、面板与回归对比看到的是同一份，'
          + '否则「这次跑的是什么」只存在于这条消息里，链路一断就查不到了。',
      };
    }

    let planId = String(args?.plan_id ?? '').trim();
    if (planId === '') {
      // 只在**唯一**匹配时才替调用方猜：同名任务出现在多条清单里时，猜错比报错更糟。
      const matches = tasks.boards({ limit: 50 }).filter((view) => view.tasks.some((task) => task.id === boundTask));
      if (matches.length === 0) {
        return {
          ...empty,
          error: `没有找到任务「${boundTask}」`,
          note: '先用 subagent_tasks 看现有清单与任务 id；还没有清单就先调 subagent_plan 建一条。',
        };
      }
      if (matches.length > 1) {
        return {
          ...empty,
          error: `任务 id「${boundTask}」在 ${matches.length} 条清单里都存在，无法判断是哪一条`,
          note: `请同时给 plan_id：${matches.map((view) => `${view.plan.id}（${view.plan.title}）`).join('、')}`,
        };
      }
      planId = matches[0].plan.id;
    }

    const view = tasks.board(planId);
    if (view === undefined) {
      return { ...empty, error: `没有这条清单：${planId}`, note: '用 subagent_tasks 列出全部清单。' };
    }
    const task = view.tasks.find((item) => item.id === boundTask);
    if (task === undefined) {
      return {
        ...empty,
        error: `清单「${view.plan.title}」（${planId}）里没有任务「${boundTask}」`,
        note: `这条清单里的任务：${view.tasks.map((item) => `${item.id}（${item.title}）`).join('、')}`,
      };
    }

    const activated = tasks.activate(planId, {
      taskId: boundTask,
      parentAgent,
      parentSessionId: sessionId,
      invokedBy: 'tool',
      reason: '主对话按任务派发',
    });
    if (!activated.ok || activated.started.length === 0) {
      const reason = activated.error !== '' ? activated.error : `任务 ${boundTask} 没能激活`;
      return {
        ...empty,
        agent: task.agentName,
        error: reason,
        note: task.state === 'ready' || task.state === 'waiting' || task.state === 'blocked'
          ? '不要重复调用同一条任务：依赖完成时宿主会自动激活它（`subagent_tasks` 可以看链路现状）。'
          : '见 subagent_tasks 的链路现状。',
      };
    }

    const started = activated.started[0];
    const agent = store.getAgent(started.agentName) ?? store.getAgentByName(started.agentName);
    const model = agent === undefined ? '' : `${agent.modelProvider}/${agent.modelId}`;

    if (args?.wait === false) {
      return {
        ...empty,
        run_id: started.runId,
        agent: started.agentName,
        model,
        status: 'running',
        note: `任务 ${boundTask} 已激活（清单「${view.plan.title}」）。用 subagent_tasks 看链路推进情况。`,
      };
    }

    const settled = await withTimeout(runtime.waitFor(started.runId), config.runTimeoutMs + 30_000);
    if (settled === undefined) {
      return {
        ...empty,
        run_id: started.runId,
        agent: started.agentName,
        model,
        status: 'running',
        note: '等待超时，它可能还在跑。用 subagent_tasks 查状态。',
      };
    }

    // 跑完之后把链路现状带回去：下游此刻可能已经被自动激活了，
    // 不告诉主对话的话，它会以为是别的东西在动（或者干脆再派一次，然后撞上「已经在跑」）。
    const after = tasks.board(planId) ?? view;
    return {
      run_id: started.runId,
      agent: started.agentName,
      model,
      status: String(settled.status ?? ''),
      session_id: String(settled.sessionId ?? ''),
      output: truncateForModel(contentToText(settled.output), 24_000),
      tokens_out: Number(settled.tokensOut ?? 0),
      tok_per_s: Number(settled.tokPerS ?? 0),
      elapsed_ms: Number(settled.elapsedMs ?? 0),
      stop_reason: String(settled.stopReason ?? ''),
      error: String(settled.error ?? ''),
      note: chainNote(after),
    };
  };

  /**
   * 链路现状的一句话（跟在任务绑定式运行的结果后面）。
   * @param {object} view - 清单视图。
   * @returns {string}
   */
  const chainNote = (view) => {
    const parts = [`链路「${view.plan.title}」：进度 ${view.progress.done}/${view.progress.total}`];
    if (view.next !== '') parts.push(view.next);
    if (view.plan.activationError !== '') parts.push(`注意：${view.plan.activationError}`);
    return parts.join('｜');
  };

  /**
   * 把清单渲染成给模型看的文本（工具输出用）。
   * @param {object} view - 清单视图（full）。
   * @param {{detail?:boolean, outputs?:boolean, outputLimit?:number}} [options] - 选项。
   * @returns {string}
   */
  const renderPlanView = (view, options = {}) => {
    const lines = [renderBoardText(view.plan, view.tasks.map((task) => ({
      id: task.id,
      seq: task.seq,
      title: task.title,
      brief: task.brief ?? '',
      agentName: task.agentName,
      deps: task.deps,
      runId: task.runId,
      runStatus: task.runStatus,
      cancelledAt: task.cancelledAt,
      attempts: task.attempts,
    })))];
    if (view.plan.activationError !== '') lines.push(`注意：${view.plan.activationError}`);
    if (options.detail === true) {
      for (const task of view.tasks) {
        if (task.brief === undefined || task.brief === '') continue;
        lines.push('', `任务 ${task.id}「${task.title}」说明：`, task.brief);
      }
    }
    if (options.outputs === true) {
      // 等整条链路跑完之后，各任务的产出就是**这次派发的成果本身**。
      // 让主对话一次性拿到，比让它为每一项再跑一次工具调用省一整个回合。
      const limit = Number.isSafeInteger(options.outputLimit) ? options.outputLimit : 1200;
      const blocks = [];
      for (const task of view.tasks) {
        if (task.state !== 'done' || task.runId === '') continue;
        const body = String(store.getRun(task.runId)?.outputTail ?? '').trim();
        if (body === '') continue;
        const head = `- ${task.id}「${task.title}」（${task.agentName}，run ${task.runId}）`;
        const clipped = body.length > limit
          ? `${body.slice(0, limit).split('\n').join('\n  ')}\n  …（省略 ${body.length - limit} 字符，完整正文见 /sub-agent/api/runs/${task.runId}）`
          : body.split('\n').join('\n  ');
        blocks.push(`${head}：\n  ${clipped}`);
      }
      if (blocks.length > 0) lines.push('', '各任务产出：', ...blocks);
    }
    return lines.join('\n');
  };

  /** `subagent_run` 工具定义。 */
  const runTool = buildTool({
    name: 'subagent_run',
    description: [
      '把一个任务委派给已配置的子 agent（另一个模型上的独立 DSH agent，看不到本对话历史）。',
      '用户消息里出现 @名字 时就调用它；要 @ 多个就发起多次调用（并发安全）。',
      '默认会等到子 agent 跑完并把它的产出返回给你；也可以 wait=false 先拿到 run_id。',
      '正在忙的子 agent 会被拒绝，不要重试。',
      '如果这个任务属于一条已建好的任务清单（subagent_plan），改用 task_id 绑定它：',
      '宿主会带上上游产出、并在完成后自动激活下游，你不需要自己串行编排。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: '子 agent 的名字（@ 后面的那个）或它的 id' },
        prompt: { type: 'string', description: '交给子 agent 的完整任务：它看不到本对话，所以背景、目标、产出要求都要写清楚。绑定了 task_id 时不要给（任务说明写在清单的 brief 里）' },
        wait: { type: 'boolean', description: '是否等它跑完再返回（默认 true）。false 时立刻返回 run_id' },
        task_key: { type: 'string', description: '可选：任务标识。同一 task_key 跨轮重跑就能做回归对比' },
        round_id: { type: 'string', description: '可选：轮次 id（先用 POST /sub-agent/api/rounds 建轮）' },
        task_id: { type: 'string', description: '可选：绑定到任务清单里的某个任务（例如 t3）。给出它之后 agent 与 prompt 都由清单决定' },
        plan_id: { type: 'string', description: '可选：任务所在的清单 id（建单时返回）。只有 task_id 在本机唯一时才可以省略' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        status: { type: 'string' },
        session_id: { type: 'string' },
        output: { type: 'string' },
        tokens_out: { type: 'integer' },
        tok_per_s: { type: 'number' },
        elapsed_ms: { type: 'integer' },
        stop_reason: { type: 'string' },
        error: { type: 'string' },
        note: { type: 'string' },
      },
    },
    // 签名是 `render(args, value)`——**参数在前、值在后**。
    // 写成 `render(value)` 会把参数对象当成值来读：症状是渲染出 undefined，
    // 或在读 `.length` 时直接抛错（真机第一次调用 subagent_roster 时正是这样暴露的）。
    render: (_args, value) => [{ type: 'text', text: renderRunResult(value) }],
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { sessionId, agent: parentAgent } = callerOf(exec);
      const empty = {
        run_id: '', agent: '', model: '', status: 'rejected', session_id: '',
        output: '', tokens_out: 0, tok_per_s: 0, elapsed_ms: 0, stop_reason: '', error: '', note: '',
      };

      if (!isEnabled()) {
        return {
          ...empty,
          agent: String(args?.agent ?? ''),
          error: '子 agent 插件尚未启用（这是全局开关，对所有对话生效）。',
          note: '请让用户在任何对话的输入框那一行把开关打开；这是策略拒绝，重试不会有不同结果。',
        };
      }

      // 绑定了任务清单里的任务 → 走另一条路：agent 与 prompt 由清单决定，
      // 上游产出由宿主注入，完成后由宿主激活下游。这里的「编排」不该由模型重复做一遍。
      const boundTask = String(args?.task_id ?? '').trim();
      if (boundTask !== '') {
        return runTaskBound({ args, sessionId, parentAgent, empty, boundTask });
      }

      const wanted = String(args?.agent ?? '').trim();
      const prompt = String(args?.prompt ?? '');
      if (wanted === '' || prompt.trim() === '') {
        return { ...empty, agent: wanted, error: 'agent 与 prompt 都必填（或者用 task_id 绑定清单里的任务）' };
      }

      const target = store.getAgent(wanted) ?? store.getAgentByName(wanted);
      if (target === undefined) {
        const names = store.listAgents().map((agent) => agent.name);
        return {
          ...empty,
          agent: wanted,
          error: `找不到子 agent "${wanted}"`,
          note: names.length > 0 ? `当前可用：${names.join(', ')}` : '还没有配置任何子 agent，请让用户在插件配置页添加',
        };
      }

      // 「忙的不能被 @」的硬边界。UI 置灰只是礼貌，这里才是规则。
      const snapshot = runtime.snapshot();
      const busy = snapshot.runs.find((run) => run.agentName === target.name && run.busy);
      if (busy !== undefined) {
        return {
          ...empty,
          agent: target.name,
          error: `子 agent "${target.name}" 正在忙（run ${busy.runId}，已跑 ${Math.round(busy.elapsedMs / 1000)}s）`,
          note: '不要重试这一个；等它跑完、换一个空闲的子 agent，或者如实告诉用户。',
        };
      }

      const mine = snapshot.runs.filter((run) => run.busy && run.agentName !== target.name).length;
      if (mine >= config.maxParallelPerSession) {
        return {
          ...empty,
          agent: target.name,
          error: `本对话已有 ${mine} 个子 agent 在跑，达到上限 ${config.maxParallelPerSession}`,
          note: '等其中一些跑完再委派，避免并发把费用与上下文一起推高。',
        };
      }

      const started = runtime.start({
        agent: target,
        prompt,
        parentAgent,
        parentSessionId: sessionId,
        taskKey: typeof args?.task_key === 'string' ? args.task_key : '',
        roundId: typeof args?.round_id === 'string' && args.round_id !== '' ? args.round_id : null,
        invokedBy: 'tool',
      });
      if (!started.ok) return { ...empty, agent: target.name, error: started.error };

      const runId = started.run.id;
      const model = `${target.modelProvider}/${target.modelId}`;

      if (args?.wait === false) {
        return {
          ...empty,
          run_id: runId,
          agent: target.name,
          model,
          status: 'running',
          note: '已启动。用 subagent_roster 看进度，或稍后再委派别的任务。',
        };
      }

      // 等它跑完。给一点宽限，保证「运行超时」是 runtime 报出来的那个原因，
      // 而不是这里先超时导致信息更少。
      const settled = await withTimeout(runtime.waitFor(runId), config.runTimeoutMs + 30_000);
      if (settled === undefined) {
        return {
          ...empty,
          run_id: runId,
          agent: target.name,
          model,
          status: 'running',
          note: '等待超时，它可能还在跑。用 subagent_roster 查状态。',
        };
      }

      return {
        run_id: runId,
        agent: target.name,
        model,
        status: String(settled.status ?? ''),
        session_id: String(settled.sessionId ?? ''),
        // 输出是给主对话当素材用的，所以原样带回（有界截断由 runtime 落库侧负责，
        // 这里是内存里的完整文本）。超长时明确告知被截断，避免主对话以为这就是全部。
        // 用 contentToText 而不是 String()：DSH 侧的 output 是 ContentBlock[]，
        // `String(array)` 会变成 "[object Object],..."。这里拿到的虽然已经是折好的字符串，
        // 但统一走同一个函数，就不会有人再犯同一个错。
        output: truncateForModel(contentToText(settled.output), 24_000),
        tokens_out: Number(settled.tokensOut ?? 0),
        tok_per_s: Number(settled.tokPerS ?? 0),
        elapsed_ms: Number(settled.elapsedMs ?? 0),
        stop_reason: String(settled.stopReason ?? ''),
        error: String(settled.error ?? ''),
        note: settled.tokPerSEstimated === true ? 'tok/s 为估算值（该轮尚未收到权威 usage）' : '',
      };
    },
  });

  /** `subagent_plan` 工具定义：建任务清单与依赖图。 */
  const planTool = buildTool({
    name: 'subagent_plan',
    description: [
      '创建一条任务清单：一次性给出多步任务与它们之间的依赖，形成一条任务链路（依赖图）。',
      '适合「先调研 → 再实现 → 最后评审」这类有先后顺序的多步工作。',
      '没有依赖的任务会立刻被激活；有依赖的先进入「等待依赖」，',
      '并在依赖完成后由宿主自动激活——不需要你自己串行地一步步 @。',
      '上游任务的产出会被自动注入下游任务的提示词，所以下游不必重做上游的活。',
      '默认会**等整条链路跑完**再返回（wait_for_chain），因为一旦你结束了回合，',
      '就没有人在等这条链路了——那正是「子 agent 没跑完、主对话已经结束」这个问题的来源。',
      '返回时会带上各任务的产出摘要。建完也可以用 subagent_tasks 看整条链路。',
      '往已有清单追加任务时给 plan_id。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '清单名（界面上区分多条链路的标识）。追加任务时可以省略' },
        note: { type: 'string', description: '可选：这条链路的目标一句话' },
        auto_activate: {
          type: 'boolean',
          description: '可选：依赖完成后是否自动激活下游（默认跟随插件配置）。false = 只标成「可执行」，等主对话手动激活',
        },
        wait_for_chain: {
          type: 'boolean',
          description: '可选：是否等整条链路跑完再返回（默认 true）。false 时建完立刻返回，你需要自己用 subagent_tasks 跟进',
        },
        timeout_ms: { type: 'integer', description: '可选：等待上限（毫秒），默认取运行超时的两倍、最多 20 分钟' },
        plan_id: { type: 'string', description: '可选：往这条已存在的清单里追加任务' },
        tasks: {
          type: 'array',
          description: '任务列表。依赖用同一批或同清单里的任务 id 指认',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '可选：任务 id（默认 t1、t2…，同清单内唯一）' },
              title: { type: 'string', description: '一句话任务名' },
              agent: { type: 'string', description: '由哪个子 agent 执行（@ 句柄）' },
              brief: { type: 'string', description: '交给子 agent 的完整任务说明（它看不到本对话，越具体越好）' },
              deps: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id；没有就给 []' },
            },
            required: ['title', 'agent'],
          },
        },
      },
      required: ['tasks'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan_id: { type: 'string' },
        title: { type: 'string' },
        chain: { type: 'string' },
        settled: { type: 'boolean' },
        waited_ms: { type: 'integer' },
        started: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { task_id: { type: 'string' }, run_id: { type: 'string' }, agent: { type: 'string' } },
          },
        },
        error: { type: 'string' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.error !== '' ? `任务清单未建立：${value.error}` : value.chain,
    }],
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { sessionId, agent: parentAgent } = callerOf(exec);
      const fail = (error) => ({ plan_id: '', title: '', chain: '', settled: false, waited_ms: 0, started: [], error });
      if (!isEnabled()) {
        return fail('子 agent 插件尚未启用（全局开关）：任务清单与子 agent 一起被关掉了。'
          + '请让用户在输入框那一行打开开关；这是策略拒绝，重试不会有不同结果。');
      }
      if (tasks === undefined) {
        return fail('任务清单服务不可用：本次启动没有装配它（表结构或存储没起来，见 /sub-agent/api/health）');
      }
      if (!Array.isArray(args?.tasks) || args.tasks.length === 0) {
        return fail('tasks 必填：给一个任务数组，每项至少要有 title 与 agent');
      }

      const planId = String(args?.plan_id ?? '').trim();
      const payload = {
        title: String(args?.title ?? ''),
        note: String(args?.note ?? ''),
        tasks: args.tasks,
        ...(typeof args?.auto_activate === 'boolean' ? { autoActivate: args.auto_activate } : {}),
      };
      const result = planId === ''
        ? tasks.createPlan(payload, { parentSessionId: sessionId, parentAgent, invokedBy: 'tool' })
        : tasks.appendTasks(planId, payload, { parentAgent, invokedBy: 'tool' });
      if (!result.ok) return fail(result.errors.join('；'));

      const created = result.board;
      const started = result.started;

      // 等整条链路（默认开）：见工具描述里的理由。等待是有界的，超时就如实说「还在跑」。
      let settled = true;
      let waitedMs = 0;
      let view = created;
      if (args?.wait_for_chain !== false && created.plan.autoActivate === true) {
        const waited = await tasks.waitForChain(created.plan.id, {
          timeoutMs: Number.isSafeInteger(args?.timeout_ms) ? args.timeout_ms : undefined,
        });
        if (waited.view !== undefined) view = waited.view;
        settled = waited.settled;
        waitedMs = waited.waitedMs;
      }

      const chain = [
        renderPlanView(view, { detail: false, outputs: settled }),
        created.plan.autoActivate !== true
          ? '这条清单关掉了自动激活：任务停在「可执行」，需要你用 subagent_tasks 的 action:"activate" 放行'
            + '（或者把清单的 auto_activate 改成 true）。'
          : started.length > 0
            ? `已激活：${started.map((item) => `${item.taskId}（${item.agentName}，run ${item.runId}）`).join('、')}`
            : '当前没有立即激活的任务（都在等依赖）。',
        ...(result.skipped ?? []).map((item) => `未能激活 ${item.taskId}：${item.reason}`),
        created.plan.autoActivate === true && settled === false
          ? `注意：等待 ${Math.round(waitedMs / 1000)}s 后这条链路仍在跑（未超时结束）。`
            + '用 subagent_tasks 看进度；**在这条链路跑完之前不要结束回合**，否则没人接着推它。'
          : '',
        result.activationError === undefined || result.activationError === '' ? '' : `注意：${result.activationError}`,
      ].filter((line) => line !== '').join('\n');

      return {
        plan_id: view.plan.id,
        title: view.plan.title,
        chain,
        settled,
        waited_ms: waitedMs,
        started: started.map((item) => ({ task_id: item.taskId, run_id: item.runId, agent: item.agentName })),
        error: '',
      };
    },
  });

  /** `subagent_tasks` 工具定义：查看（以及手动推进）任务清单。 */
  const tasksTool = buildTool({
    name: 'subagent_tasks',
    description: [
      '查看任务清单与依赖图：谁在跑、谁完成了、谁在等哪一个依赖、谁被上游失败卡住了。',
      '默认只读，**子 agent 也可以调用**（写操作会被拒绝）——被委派的子 agent 由此能看到自己在这条链路里的位置。',
      'action:"activate" 手动激活可执行的任务（清单关掉了自动激活时用）、"retry" 重跑失败的任务、',
      '"cancel" 取消一个任务。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['view', 'activate', 'retry', 'cancel'],
          description: 'view（默认，只读）/ activate / retry / cancel',
        },
        plan_id: { type: 'string', description: '清单 id；只读时省略则列出全部清单' },
        task_id: { type: 'string', description: '任务 id（activate/retry/cancel 必填；也可用来聚焦某一个任务）' },
        detail: { type: 'boolean', description: '只读时带上每个任务的说明正文（较长）' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        is_sub_agent: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.error !== '' ? `任务清单不可用：${value.error}` : value.text,
    }],
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { sessionId } = callerOf(exec);
      const child = tasks === undefined ? false : tasks.isChildSession(sessionId);
      const action = String(args?.action ?? 'view');
      let planId = String(args?.plan_id ?? '').trim();
      const taskId = String(args?.task_id ?? '').trim();
      if (tasks === undefined) {
        return { text: '', is_sub_agent: child, error: '本次启动没有装配任务清单服务（见 /sub-agent/api/health 的 initError）' };
      }

      // 子 agent 的位置对它是**关键信息**：它看不到主对话，只能从这里知道自己是谁、在等谁。
      const self = child ? selfTaskOf(sessionId) : undefined;

      if (action === 'view') {
        // 主对话来问进展 = 它回到会话了：顺手把能跑的任务放行。
        // 这是「主 agent 结束了回合、链路停在半路」的第三个补救入口（另两个见 tasks.js）。
        if (!child && tasks.resumeAll !== undefined) tasks.resumeAll('主对话查看链路');
        if (planId === '' && self !== undefined) planId = self.planId;
        if (planId === '' && child) {
          // 子 agent 不知道自己在哪条清单里（手工起的一次运行）——如实说明，别把它导到别人的链路上。
          return {
            text: '你这次运行没有绑定任务清单（是被直接委派的）。可以让主对话用 subagent_plan 建一条链路。',
            is_sub_agent: true,
            error: '',
          };
        }
        const detail = args?.detail === true;
        const views = planId === ''
          ? tasks.boards({ full: detail, limit: 20 })
          : [tasks.board(planId, { full: detail })].filter((view) => view !== undefined);
        if (views.length === 0) return { text: '', is_sub_agent: child, error: `没有这条清单：${planId}` };
        const blocks = views.map((view) => renderPlanView(view, { detail, outputs: detail }));
        const head = [];
        if (child && self !== undefined) {
          head.push(`你是子 agent：你的任务是 ${self.planId}/${self.taskId}（run ${self.runId}）。下面是这条清单的现状（只读）。`);
        }
        if (views.length > 1) head.push(`共 ${views.length} 条清单：`);
        return { text: [...head, ...blocks].join('\n\n'), is_sub_agent: child, error: '' };
      }

      // ---- 以下都是写操作：只有派活的一方可以做 ----
      if (child) {
        return {
          text: '',
          is_sub_agent: true,
          error: `子 agent 不能用 action:"${action}"：任务清单的写操作属于调度者（主对话）。`
            + '你只负责自己被派的那一项任务；需要改链路请把情况写进你的产出里，由主对话决定。',
        };
      }
      if (planId === '') {
        return { text: '', is_sub_agent: false, error: `action:"${action}" 需要 plan_id（先用 action:"view" 看有哪些清单）` };
      }
      if (action === 'activate') {
        const result = tasks.activate(planId, {
          taskId: taskId === '' ? undefined : taskId,
          invokedBy: 'tool',
          reason: '主对话手动激活',
        });
        if (!result.ok) return { text: '', is_sub_agent: false, error: result.error };
        const view = result.board;
        const lines = [
          result.started.length > 0
            ? `已激活：${result.started.map((item) => `${item.taskId}（${item.agentName}，run ${item.runId}）`).join('、')}`
            : '没有可激活的任务（都在跑、在等依赖，或者已经结束）。',
        ];
        if (result.skipped.length > 0) lines.push(...result.skipped.map((item) => `跳过 ${item.taskId}：${item.reason}`));
        lines.push('', renderPlanView(view, { detail: false }));
        return { text: lines.join('\n'), is_sub_agent: false, error: '' };
      }
      if (taskId === '') {
        return { text: '', is_sub_agent: false, error: `action:"${action}" 需要 task_id` };
      }
      const result = action === 'retry'
        ? tasks.retry(planId, taskId, { invokedBy: 'tool' })
        : tasks.cancelTask(planId, taskId);
      if (!result.ok) return { text: '', is_sub_agent: false, error: result.error };
      const view = result.board;
      const done = action === 'retry'
        ? `已重试 ${taskId}${result.started.length > 0 ? `（run ${result.started[0].runId}）` : ''}`
        : `已取消 ${taskId}`;
      return { text: `${done}\n\n${renderPlanView(view, { detail: false })}`, is_sub_agent: false, error: '' };
    },
  });

  /**
   * 按会话 id 反查「这个子 agent 正在执行哪一项任务」。
   *
   * 用途只有一个：子 agent 调 `subagent_tasks` 时，让它一眼看到自己在链路里的位置。
   * 查不到就返回 undefined（如实说明「这次运行没有绑定清单」），不去猜。
   * @param {string} sessionId - 子会话 id。
   * @returns {{planId:string,taskId:string,runId:string}|undefined}
   */
  const selfTaskOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    let snapshot;
    try {
      snapshot = runtime.snapshot();
    } catch {
      return undefined;
    }
    const run = (snapshot.runs ?? []).find((item) => item.sessionId === sessionId);
    if (run === undefined) return undefined;
    const task = store.taskByRun(run.runId);
    if (task === undefined) return undefined;
    return { planId: task.planId, taskId: task.id, runId: run.runId };
  };

  /** `subagent_evaluate` 工具定义。 */
  const evaluateTool = buildTool({
    name: 'subagent_evaluate',
    description: [
      '给一次子 agent 运行打分（需求 5 的评价闭环）。',
      '按四个维度各给 0-100：correctness/正确性、completeness/完整性、efficiency/效率、cost/成本。',
      '总分由工具按维度均值计算。每次委派后都应该调用它——排名与跨轮回归都建立在这些分数上。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'subagent_run 返回的 run_id' },
        correctness: { type: 'number', description: '正确性 0-100' },
        completeness: { type: 'number', description: '完整性 0-100' },
        efficiency: { type: 'number', description: '效率 0-100' },
        cost: { type: 'number', description: '成本 0-100（只看 token 消耗是否与任务相称）' },
        score: { type: 'number', description: '可选：直接给总分 0-100；给了就以它为准，否则用维度均值' },
        verdict: { type: 'string', description: '一句话结论，例如「可用」「结论有事实错误」' },
        notes: { type: 'string', description: '可选：具体哪里好/哪里差，便于跨轮对比时看懂分数变化' },
      },
      required: ['run_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        evaluation_id: { type: 'string' },
        run_id: { type: 'string' },
        score: { type: 'number' },
        verdict: { type: 'string' },
        recorded: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
    // 签名是 `(args, value)`：见 runTool 里的说明。
    render: (_args, value) => [{
      type: 'text',
      text: value.recorded
        ? `已记录评价：run ${value.run_id} 得 ${value.score} 分${value.verdict === '' ? '' : `（${value.verdict}）`}`
        : `评价未记录：${value.error}`,
    }],
    execute: async (args) => {
      const runId = String(args?.run_id ?? '');
      if (runId === '') {
        return { evaluation_id: '', run_id: '', score: 0, verdict: '', recorded: false, error: 'run_id 必填' };
      }
      const run = store.getRun(runId);
      if (run === undefined) {
        return { evaluation_id: '', run_id: runId, score: 0, verdict: '', recorded: false, error: `没有这次运行：${runId}` };
      }
      const dimensions = {};
      for (const dimension of RUBRIC_DIMENSIONS) {
        const value = args?.[dimension.key];
        if (typeof value === 'number' && Number.isFinite(value)) dimensions[dimension.key] = value;
      }
      let score = typeof args?.score === 'number' && Number.isFinite(args.score) ? args.score : undefined;
      if (score === undefined) {
        const values = Object.values(dimensions);
        if (values.length === 0) {
          return {
            evaluation_id: '', run_id: runId, score: 0, verdict: '', recorded: false,
            error: '至少要给一个维度分，或者直接给 score',
          };
        }
        score = values.reduce((sum, value) => sum + value, 0) / values.length;
      }
      score = Math.max(0, Math.min(100, Math.round(score * 100) / 100));
      const verdict = typeof args?.verdict === 'string' ? args.verdict : '';
      const evaluation = store.insertEvaluation({
        runId,
        roundId: run.roundId,
        score,
        verdict,
        dimensions,
        notes: typeof args?.notes === 'string' ? args.notes : '',
        evaluator: 'main-conversation',
      });
      return { evaluation_id: evaluation.id, run_id: runId, score, verdict, recorded: true, error: '' };
    },
  });

  /** `subagent_roster` 工具定义。 */
  const rosterTool = buildTool({
    name: 'subagent_roster',
    description: '列出已配置的子 agent：模型、工具策略、当前忙闲、以及最近的成绩。不确定该 @ 谁时先调用它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agents: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              model: { type: 'string' },
              tool_policy: { type: 'string' },
              busy: { type: 'boolean' },
              busy_run_id: { type: 'string' },
              tok_per_s: { type: 'number' },
              runs: { type: 'integer' },
              avg_score: { type: 'number' },
            },
          },
        },
        note: { type: 'string' },
      },
    },
    // 签名是 `(args, value)`：见 runTool 里的说明。
    render: (_args, value) => [{
      type: 'text',
      text: value.agents.length === 0
        ? '还没有配置任何子 agent。'
        : ['已配置的子 agent：', ...value.agents.map((agent) => (
          `- ${agent.name}｜${agent.model}｜工具 ${agent.tool_policy}｜${agent.busy ? `忙（${agent.busy_run_id}）` : '闲'}`
          + `｜历史 ${agent.runs} 次${agent.avg_score > 0 ? `，均分 ${agent.avg_score}` : ''}`
        ))].join('\n'),
    }],
    execute: async () => {
      const leaderboard = new Map(store.agentLeaderboard().map((row) => [row.agentId, row]));
      const snapshot = runtime.snapshot();
      const busyByAgent = new Map();
      for (const run of snapshot.runs) {
        if (run.busy && !busyByAgent.has(run.agentName)) busyByAgent.set(run.agentName, run);
      }
      const agents = store.listAgents().map((agent) => {
        const stats = leaderboard.get(agent.id);
        const busy = busyByAgent.get(agent.name);
        return {
          name: agent.name,
          model: `${agent.modelProvider}/${agent.modelId}`,
          tool_policy: agent.toolPolicy,
          busy: busy !== undefined,
          busy_run_id: busy?.runId ?? '',
          tok_per_s: busy?.tokPerS ?? 0,
          runs: stats?.runs ?? 0,
          avg_score: stats?.avgScore ?? 0,
        };
      });
      return { agents, note: transports.length === 0 ? '本部署没有可用的 agent 传输实现：子 agent 无法启动' : '' };
    },
  });

  //#endregion

  /**
   * 注册提示词段与工具。
   * @returns {void}
   */
  const install = () => {
    const disposers = [];
    if (toolsService !== undefined && typeof toolsService.register === 'function') {
      // 任务清单那两个工具只在服务真的装配了才注册：注册一个「一定报错」的工具
      // 会让主对话对着一个用不了的入口浪费一整轮。
      const toolset = [runTool, evaluateTool, rosterTool];
      if (tasks !== undefined) toolset.push(planTool, tasksTool);
      for (const tool of toolset) {
        disposers.push(toolsService.register(tool));
      }
    }
    if (promptService !== undefined && typeof promptService.section === 'function') {
      disposers.push(promptService.section({
        name: 'subagent-hub:protocol',
        order: PROTOCOL_ORDER,
        // 用函数形式：花名册与忙闲会随运行变化，每次装配都取最新的。
        text: protocolText,
      }));
    }
    log.debug(`model-facing layer installed: tools=${toolsService !== undefined} prompt=${promptService !== undefined} tasks=${tasks !== undefined}`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch (error) {
          log.debug(`dispose failed: ${describeError(error)}`);
        }
      }
    };
  };

  return { install, warnings, transports: transports.map((item) => item.name) };
}

/**
 * 本地版的 `defineTool`：把「已经是 JSON Schema 的参数」与执行体组装成
 * `ctx.tools.register()` 认的结构。
 *
 * 不 import DSH 的 `defineTool`：(a) 保持宿主半边零 `@deepseek-ai/*` 依赖；
 * (b) 它做的只是「简写 spec → JSON Schema + 参数校验」，而我们直接写 JSON Schema、
 * 校验也自己写在 execute 里（模型的参数形状本来就不可信，必须自己兜）。
 *
 * @param {object} options - 定义。
 * @returns {object} ToolDefinition。
 */
function buildTool(options) {
  const definition = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema,
      render: options.render,
    },
    execute: options.execute,
  };
  if (typeof options.isConcurrencySafe === 'function') {
    definition.isConcurrencySafe = options.isConcurrencySafe;
  }
  if (typeof options.presentCall === 'function') {
    definition.presentCall = options.presentCall;
  }
  return definition;
}

/**
 * 把工具结果渲染成给模型看的一段文本。
 * @param {object} value - 工具返回值。
 * @returns {string}
 */
function renderRunResult(value) {
  if (value.error !== '') {
    return `子 agent ${value.agent || '(未知)'} 未能完成：${value.error}${value.note === '' ? '' : `\n${value.note}`}`;
  }
  const head = `子 agent ${value.agent}（${value.model}）｜${value.status}｜`
    + `${value.elapsed_ms}ms｜输出 ${value.tokens_out} tokens｜${value.tok_per_s} tok/s`
    + `${value.note === '' ? '' : `（${value.note}）`}`;
  const body = value.output === '' ? '（没有产出文本）' : value.output;
  const session = value.session_id === '' ? '' : `\n会话：${value.session_id}`;
  return `${head}${session}\n\n${body}`;
}

/**
 * 截断给模型的文本，并**明确标注**被截断——不能让主对话以为手上是全文。
 * @param {string} text - 原文。
 * @param {number} limit - 上限。
 * @returns {string}
 */
function truncateForModel(text, limit) {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n…（此处省略 ${omitted} 个字符；完整产出可在悬浮球详情页或 /sub-agent/api/runs/<run_id>/detail 查看）`;
}

/**
 * 给一个 promise 加超时。
 * @param {Promise<any>|undefined} promise - 目标 promise。
 * @param {number} ms - 超时毫秒。
 * @returns {Promise<any|undefined>} 超时返回 undefined。
 */
function withTimeout(promise, ms) {
  if (promise === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(undefined); }, ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

/**
 * 列出可用的 agent 传输实现（「agent 提供商」下拉的数据源）。
 * @param {object} subagents - ctx.subagents。
 * @returns {object[]}
 */
function listTransports(subagents) {
  try {
    const names = subagents.list();
    if (!Array.isArray(names)) return [];
    return names.map((name) => ({ name }));
  } catch {
    return [];
  }
}

/** 导出只读白名单的默认值，供文档与测试引用。 */
export { READONLY_TOOL_ALLOW };
