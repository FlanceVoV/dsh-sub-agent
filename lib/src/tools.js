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

    return [
      '## 子 agent（subagent-hub）',
      '',
      '本对话可以使用若干**子 agent**：它们是同一套 DSH agent 运行时、只是跑在**另一个模型**上的独立智能体。',
      '它们看不到本对话的历史（不继承上下文），所以每次委派都要把任务讲清楚、给足背景。',
      '',
      '已配置的子 agent：',
      roster,
      '',
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
      '### 评价量规（`subagent_evaluate`）',
      '按四个维度各打 0-100 分，总分由工具按均值算：',
      ...RUBRIC_DIMENSIONS.map((dimension) => `  - ${dimension.key}（${dimension.label}）：${dimension.hint}`),
      '打分要基于子 agent 的实际产出，不要因为「它很努力」给高分。没有拿到结果就打低分并说明原因。',
    ].join('\n');
  };

  //#endregion

  //#region 工具

  /** `subagent_run` 工具定义。 */
  const runTool = buildTool({
    name: 'subagent_run',
    description: [
      '把一个任务委派给已配置的子 agent（另一个模型上的独立 DSH agent，看不到本对话历史）。',
      '用户消息里出现 @名字 时就调用它；要 @ 多个就发起多次调用（并发安全）。',
      '默认会等到子 agent 跑完并把它的产出返回给你；也可以 wait=false 先拿到 run_id。',
      '正在忙的子 agent 会被拒绝，不要重试。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: '子 agent 的名字（@ 后面的那个）或它的 id' },
        prompt: { type: 'string', description: '交给子 agent 的完整任务：它看不到本对话，所以背景、目标、产出要求都要写清楚' },
        wait: { type: 'boolean', description: '是否等它跑完再返回（默认 true）。false 时立刻返回 run_id' },
        task_key: { type: 'string', description: '可选：任务标识。同一 task_key 跨轮重跑就能做回归对比' },
        round_id: { type: 'string', description: '可选：轮次 id（先用 POST /sub-agent/api/rounds 建轮）' },
      },
      required: ['agent', 'prompt'],
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

      const wanted = String(args?.agent ?? '').trim();
      const prompt = String(args?.prompt ?? '');
      if (wanted === '' || prompt.trim() === '') {
        return { ...empty, agent: wanted, error: 'agent 与 prompt 都必填' };
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
      for (const tool of [runTool, evaluateTool, rosterTool]) {
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
    log.debug(`model-facing layer installed: tools=${toolsService !== undefined} prompt=${promptService !== undefined}`);
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
