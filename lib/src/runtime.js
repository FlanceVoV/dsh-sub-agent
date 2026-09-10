/**
 * 运行时：起子 agent、实时折出遥测、守住并发与超时。
 *
 * 这是全插件**唯一**直接依赖 DSH 内部 API 的地方（配合 tools.js），因此这里的每个
 * 访问都是防御式的：服务取不到、能力不满足、抛错，都被翻译成**明确的失败**而不是崩溃。
 *
 * 三个已核实的关键事实决定了本文件的形状：
 *  1. `ctx.subagents.start(transport, request)` 在**发布时**就 resolve，不是完成时。
 *     所以必须 `await run.result` 并且**无论如何都 `run.dispose()`**，否则工作不会收敛。
 *  2. 子会话的事件只有带 `{global:true}` 才能收到（按会话作用域过滤会全部漏掉）。
 *  3. `ctx.subagents` **没有**并发闸，调用方必须自己限流（DSH 内置的 subagent 工具
 *     也是自己在 workflow 侧限流的）。@ 多个子 agent 是真金白银，闸必须有。
 *
 * tok/s 的口径也说清楚：DSH 没有任何现成的实时速率。权威值来自
 * `assistant/message` 的 `usage.outputTokens` 与该轮解码时长的比值（这正是
 * `dsh-session-stats` 投影的算法）；流式进行中还没有 usage，就用「本步已产出字符数 ÷
 * 校准出的 chars-per-token ÷ 解码秒数」估算，并**明确标记这是估算**——
 * chars-per-token 由上一个完成步的（字符数 ÷ 权威 token 数）自动校准，
 * 因此中文与英文的差异会被自愈，而不是拿一个写死的常数糊过去。
 *
 * @module dsh-subagent-hub/runtime
 */
import { describeError } from './log.js';
import { safeGet } from './discovery.js';
import { toAgentOptions, toToolFilter } from './registry.js';

/** 第一次校准之前的 chars-per-token 初值（英语约 4、中文约 1.5，取折中）。 */
const INITIAL_CHARS_PER_TOKEN = 3;

/**
 * 兜底上下文窗口：1M。
 *
 * 用户明确指定了这个默认值，而且它也确实是本机主流路由的真实量级
 * （deepseek-v4-* 与 qwen3.8-* 都是 1,000,000）。取值的优先级见 RunTelemetry.contextWindow：
 * 适配器自报的窗口 > agent 配置的 maxContext > 这个兜底。
 */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** 判定「一个 chunk 是否真的产出了内容」（用于找解码起点，与 dsh-session-stats 同口径）。 */
function isContentDelta(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false;
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text !== '';
  if (chunk.type === 'reasoning-delta') return typeof chunk.text === 'string' && chunk.text !== '';
  return false;
}

/**
 * 一次运行的实时遥测（纯内存；落库只在终态做一次）。
 */
export class RunTelemetry {
  /**
   * @param {{runId:string,sessionId:string,label:string,agentName:string,windowMs:number,startedAt:number,contextBudget?:number}} init - 初始信息。
   */
  constructor(init) {
    this.runId = init.runId;
    this.sessionId = init.sessionId;
    this.label = init.label;
    this.agentName = init.agentName;
    this.windowMs = init.windowMs;
    this.startedAt = init.startedAt;
    this.status = 'running';

    /** 权威计数。 */
    this.tokensIn = 0;
    this.tokensOut = 0;
    /**
     * **当前上下文占用**（不是累计）：最近一步 `usage.inputTokens`。
     *
     * 为什么用这个而不是累计输入：累计只增不减，而我们要回答的是
     * 「子 agent 的上下文是不是快满了」。最近一步送出的 prompt 大小就是那个答案，
     * 而且**子 agent 自己压缩上下文之后它会真的变小**——颜色必须跟着回去，
     * 所以这个量天然会上下波动，不能是单调的。
     */
    this.contextUsed = 0;
    /**
     * 上下文窗口。三层取值：`request/context` 事件里适配器自报的窗口 →
     * 该 agent 配置的 maxContext → 兜底默认值（见 DEFAULT_CONTEXT_WINDOW）。
     */
    this.contextWindow = Number.isSafeInteger(init.contextBudget) && init.contextBudget > 0
      ? init.contextBudget
      : DEFAULT_CONTEXT_WINDOW;
    /** 窗口是「适配器自报」还是「兜底」——界面上要能区分事实与默认值。 */
    this.contextWindowSource = Number.isSafeInteger(init.contextBudget) && init.contextBudget > 0 ? 'configured' : 'default';
    /** 解码时长累计（毫秒）：每个完成步的「首个内容 chunk → assistant/message」。 */
    this.decodeMs = 0;
    /** 当前步的解码起点（毫秒时间戳），未开始为 null。 */
    this.stepDecodeStart = null;
    /** 当前步已产出的内容字符数。 */
    this.stepChars = 0;
    /** 本步是否已经拿到权威 usage。 */
    this.stepUsageSeen = false;
    /** chars-per-token 校准系数（由已完成步自动校准）。 */
    this.charsPerToken = INITIAL_CHARS_PER_TOKEN;
    this.calibrated = false;

    /** 输出与推理的实时缓冲（详情页用）。 */
    this.output = '';
    this.reasoning = '';
    /** 已完成的助手消息（权威文本，按步追加）。 */
    this.messages = [];
    /** 输入（子 agent 收到的用户消息）。 */
    this.input = '';
    /** 工具活动。 */
    this.tools = [];
    /** 步与轮计数。 */
    this.steps = 0;
    this.turns = 0;
    this.lastEventAt = init.startedAt;
    /** 终态信息。 */
    this.stopReason = '';
    this.error = '';
    this.diagnostic = '';
    this.endedAt = null;
  }

  /**
   * 折一个子会话事件进来。
   * @param {object} event - `{type, seq, time, data}`。
   * @returns {boolean} 是否改变了对外可见的状态（决定要不要推给订阅者）。
   */
  fold(event) {
    const { type, data } = event;
    const at = typeof event.time === 'number' ? event.time : Date.now();
    this.lastEventAt = at;

    switch (type) {
      case 'user/message': {
        // 子 agent 的输入。合成注入（agent.inject）与真实提示都在这里，用 source 区分。
        const text = contentToText(data?.content);
        if (text !== '') this.input = text;
        return true;
      }
      case 'assistant/chunk': {
        const chunk = data?.chunk;
        if (isContentDelta(chunk)) {
          if (this.stepDecodeStart === null) this.stepDecodeStart = at;
          this.stepChars += chunk.text.length;
          if (chunk.type === 'reasoning-delta') this.reasoning += chunk.text;
          else this.output += chunk.text;
          return true;
        }
        // 有些适配器会在流中途报 usage：那是比估算更硬的数字，直接用。
        if (chunk?.type === 'usage' && chunk.usage !== undefined) {
          this.applyUsage(chunk.usage);
          return true;
        }
        return false;
      }
      case 'assistant/message': {
        this.steps += 1;
        if (data?.usage !== undefined) this.applyUsage(data.usage);
        else this.finishStepWithoutUsage();
        const text = contentToText(data?.message?.content);
        if (text !== '') {
          this.messages.push(text);
          // 权威文本到位后，用消息本身覆盖实时缓冲，避免流式拼接的重复/丢字。
          this.output = this.messages.join('\n\n');
        }
        return true;
      }
      case 'turn/start': {
        this.turns += 1;
        return true;
      }
      case 'request/context': {
        // 适配器自报的「本请求所属模型路由的上下文窗口」。这是最权威的窗口来源：
        // 它来自真正要处理这次请求的适配器，而不是我们的配置或猜测。
        if (Number.isSafeInteger(data?.contextWindow) && data.contextWindow > 0) {
          this.contextWindow = data.contextWindow;
          this.contextWindowSource = 'adapter';
          return true;
        }
        return false;
      }
      case 'tool/call': {
        this.tools.push({
          seq: event.seq,
          name: typeof data?.name === 'string' ? data.name : '',
          callId: data?.callId ?? null,
          at,
          done: false,
        });
        return true;
      }
      case 'tool/result': {
        const match = [...this.tools].reverse().find((item) => item.callId === data?.callId && item.done === false);
        if (match !== undefined) {
          match.done = true;
          match.isError = data?.isError === true;
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * 应用一次权威 usage。
   *
   * 解码时长按 `dsh-session-stats` 的口径：**首个内容 chunk 的时间 → 本步 assistant/message
   * 的时间**。这样才排除了「首 token 之前」的网络与排队时间，得到的才是解码速率。
   * @param {object} usage - TokenUsage。
   */
  applyUsage(usage) {
    const input = numberOr(usage?.inputTokens ?? usage?.uncachedInputTokens, null);
    if (input !== null) {
      this.tokensIn += input;
      // **覆盖**而不是累加：最近一步送出的 prompt 大小 = 当前上下文占用。
      // 子 agent 自己压缩上下文之后，下一个请求的 prompt 会变小，这里就跟着回落——
      // 所以这个量天然可升可降，正是液面需要的行为。
      this.contextUsed = input;
    }
    const output = numberOr(usage?.outputTokens, null);
    if (output !== null) this.tokensOut += output;

    if (this.stepDecodeStart !== null) {
      const decoded = Math.max(0, this.lastEventAt - this.stepDecodeStart);
      this.decodeMs += decoded;
      // 用「本步字符数 ÷ 本步权威 token 数」校准系数：中英混排/代码/不同分词器
      // 的差异会被上一个完成步自动吸收，而不是靠写死的常数。
      if (output !== null && output > 0 && this.stepChars > 0 && decoded > 0) {
        this.charsPerToken = clamp(this.stepChars / output, 0.5, 12);
        this.calibrated = true;
      }
    }
    this.stepDecodeStart = null;
    this.stepChars = 0;
    this.stepUsageSeen = true;
  }

  /**
   * 本步没有 usage 时也要把解码时长收进累计（否则速率会被稀释）。
   * @returns {void}
   */
  finishStepWithoutUsage() {
    if (this.stepDecodeStart !== null) {
      this.decodeMs += Math.max(0, this.lastEventAt - this.stepDecodeStart);
    }
    this.stepDecodeStart = null;
    this.stepChars = 0;
  }

  /**
   * 标记终止。
   * @param {{status:string,stopReason?:string,error?:string,diagnostic?:string,endedAt?:number}} outcome - 终态。
   * @returns {void}
   */
  settle(outcome) {
    this.status = outcome.status;
    this.stopReason = outcome.stopReason ?? '';
    this.error = outcome.error ?? '';
    this.diagnostic = outcome.diagnostic ?? '';
    this.endedAt = outcome.endedAt ?? Date.now();
    this.finishStepWithoutUsage();
  }

  /**
   * 当前速率视图。
   *
   * 有权威解码时长就报权威值；只有正在流的当前步还没结束时，才用估算并标记出来。
   * 宁可显示「~42 tok/s（估算）」，也不把一个猜出来的数字当成事实。
   * @param {number} [now] - 当前时间。
   * @returns {{value:number,estimated:boolean}}
   */
  rate(now = Date.now()) {
    let ms = this.decodeMs;
    let tokens = this.tokensOut;
    let estimated = false;

    if (this.stepDecodeStart !== null) {
      // 正在解码：权威 token 数还没到，用字符数 ÷ 校准系数估。
      const liveMs = Math.max(0, now - this.stepDecodeStart);
      ms += liveMs;
      tokens += this.stepChars / this.charsPerToken;
      estimated = true;
    } else if (this.stepUsageSeen && this.decodeMs === 0) {
      estimated = true;
    }
    if (ms <= 0) return { value: 0, estimated };
    return { value: Math.round((tokens / (ms / 1000)) * 10) / 10, estimated };
  }

  /**
   * 对外快照（悬浮球用：小、稳、无大正文）。
   * @param {number} [now] - 当前时间。
   * @returns {object}
   */
  summary(now = Date.now()) {
    const rate = this.rate(now);
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      agentName: this.agentName,
      label: this.label,
      status: this.status,
      busy: this.status === 'running' || this.status === 'queued',
      tokPerS: rate.value,
      tokPerSEstimated: rate.estimated,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      // 上下文占用：液面高度与三档配色都由这三个字段决定。
      contextUsed: this.contextUsed,
      contextWindow: this.contextWindow,
      contextRatio: contextRatio(this.contextUsed, this.contextWindow),
      contextStage: contextStage(this.contextUsed, this.contextWindow),
      contextWindowSource: this.contextWindowSource,
      elapsedMs: (this.endedAt ?? now) - this.startedAt,
      steps: this.steps,
      turns: this.turns,
      tools: this.tools.length,
      outputChars: this.output.length,
      stopReason: this.stopReason,
      error: this.error,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lastEventAt: this.lastEventAt,
    };
  }
}

/** 上下文占用的三档阈值（含下界，不含上界）。绿 → 黄 → 红。 */
export const CONTEXT_STAGES = Object.freeze([
  { stage: 'ok', below: 0.6 },
  { stage: 'warn', below: 0.85 },
  { stage: 'crit', below: Infinity },
]);

/**
 * 上下文占用比例（0..1）。窗口未知时返回 0，不猜。
 * @param {number} used - 当前占用的 token 数。
 * @param {number} window - 上下文窗口。
 * @returns {number}
 */
export function contextRatio(used, window) {
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return 0;
  return Math.max(0, Math.min(1, used / window));
}

/**
 * 上下文占用的档位：ok / warn / crit。
 *
 * 阈值只写在这里一处，界面与测试都读它——否则「多少算红」会在两端各写一份，
 * 迟早出现「颜色和数字说的不是同一件事」。
 * @param {number} used - 当前占用的 token 数。
 * @param {number} window - 上下文窗口。
 * @returns {'ok'|'warn'|'crit'}
 */
export function contextStage(used, window) {
  const ratio = contextRatio(used, window);
  for (const entry of CONTEXT_STAGES) {
    if (ratio < entry.below) return entry.stage;
  }
  return 'crit';
}

/**
 * 子 agent 运行时。
 */
export class HubRuntime {
  /**
   * @param {{ctx:object,store:object,config:object,log:object}} deps - 依赖。
   */
  constructor({ ctx, store, config, log }) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.log = log;
    /** @type {Map<string,RunTelemetry>} runId → 遥测。 */
    this.live = new Map();
    /** @type {Map<string,object>} runId → 句柄（controller/run/promise）。 */
    this.handles = new Map();
    /** 排队中的启动请求。 */
    this.queue = [];
    /** 正在运行的 runId 集合。 */
    this.active = new Set();
    /** SSE 订阅者。 */
    this.listeners = new Set();
    /** runId → 等待终态的 deferred（供工具「等它跑完再回答」用）。 */
    this.waiters = new Map();
    /** runId → 终态摘要（waiter 已结算后仍可查，避免竞态）。 */
    this.settled = new Map();
    /** 全局会话事件订阅的注销函数。 */
    this.unsubscribe = undefined;
  }

  /**
   * 挂上全局会话事件监听。
   *
   * `{global:true}` 不是优化而是**必要条件**：不带它时事件按会话作用域过滤，
   * 子会话的事件一条都收不到。
   * @returns {boolean} 是否成功挂上。
   */
  attach() {
    const on = this.ctx?.on;
    if (typeof on !== 'function') {
      this.log.warn('ctx.on 不可用：无法接收子 agent 的实时事件（悬浮球将只有终态）');
      return false;
    }
    const handler = (session, event) => this.#onSessionEvent(session, event);
    try {
      const dispose = on.call(this.ctx, 'session/event', handler, { global: true });
      this.unsubscribe = typeof dispose === 'function' ? dispose : undefined;
      return true;
    } catch (error) {
      this.log.warn(`订阅 session/event 失败：${describeError(error)}`);
      return false;
    }
  }

  /**
   * 卸载。
   * @returns {void}
   */
  detach() {
    try {
      this.unsubscribe?.();
    } catch {
      /* 卸载失败不该影响宿主退出 */
    }
    this.unsubscribe = undefined;
  }

  /**
   * 会话事件分发：只看我们关心的那些子会话。
   * @param {object} session - 会话对象。
   * @param {object} event - 事件。
   * @returns {void}
   */
  #onSessionEvent(session, event) {
    if (this.live.size === 0) return;
    const sessionId = session?.id ?? event?.sessionId;
    if (typeof sessionId !== 'string') return;
    for (const telemetry of this.live.values()) {
      if (telemetry.sessionId !== sessionId) continue;
      let changed = false;
      try {
        changed = telemetry.fold(event);
      } catch (error) {
        this.log.debug(`fold failed for run ${telemetry.runId}: ${describeError(error)}`);
      }
      if (changed) this.#emit({ kind: 'run', runId: telemetry.runId, summary: telemetry.summary() });
    }
  }

  /**
   * 推送一条给订阅者（订阅者异常不影响别人）。
   * @param {object} frame - 帧。
   * @returns {void}
   */
  #emit(frame) {
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        this.log.debug(`listener failed: ${describeError(error)}`);
      }
    }
  }

  /**
   * 订阅运行时事件（SSE 用）。
   * @param {Function} listener - 回调。
   * @returns {Function} 注销函数。
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * 解析父 agent。
   *
   * `SubagentStartRequest.parent` 必须是**活的 Agent 实例**——没有 `ctx.agent` 这种东西，
   * 所以要么由工具执行身份直接给（`exec.agent`），要么按会话 id 去 agents 注册表里查。
   * @param {string} parentSessionId - 父会话 id。
   * @returns {{agent:object}|{error:string}}
   */
  resolveParent(parentSessionId) {
    const agents = safeGet(this.ctx, 'agents');
    if (agents === undefined) return { error: 'ctx.agents 不可用：无法定位父 agent' };
    for (const method of ['get', 'bySession', 'resolve']) {
      const fn = agents[method];
      if (typeof fn !== 'function') continue;
      try {
        const agent = fn.call(agents, parentSessionId);
        if (agent !== null && agent !== undefined) return { agent };
      } catch (error) {
        this.log.debug(`agents.${method}(${parentSessionId}) failed: ${describeError(error)}`);
      }
    }
    return { error: `找不到会话 ${parentSessionId} 对应的活动 agent（该会话可能尚未在本进程打开）` };
  }

  /**
   * 起一次运行（会排队，不阻塞调用方）。
   *
   * @param {object} input - 运行输入。
   * @param {object} input.agent - agent 配置。
   * @param {string} input.prompt - 交给子 agent 的任务。
   * @param {object} input.parentAgent - 父 Agent 实例。
   * @param {string} input.parentSessionId - 父会话 id。
   * @param {string} [input.taskKey] - 任务标识（跨轮回归用）。
   * @param {string} [input.roundId] - 轮 id。
   * @param {string} [input.invokedBy] - 触发来源（'tool' | 'panel'）。
   * @returns {{ok:true,run:object}|{ok:false,error:string}}
   */
  start(input) {
    const subagents = safeGet(this.ctx, 'subagents');
    if (subagents === undefined || typeof subagents.start !== 'function') {
      return { ok: false, error: 'ctx.subagents 不可用：本部署没有装配子 agent 运行时' };
    }

    // 输入预算闸：maxContext 改不了模型的窗口（AgentOptions 里根本没有这个字段），
    // 但我们能在**打给 provider 之前**拒绝明显超预算的任务，把它变成一个说得清的错误，
    // 而不是让用户等到 provider 抛 CONTEXT_WINDOW_EXCEEDED。
    const budget = this.#checkBudget(input.agent, input.prompt);
    if (budget !== null) return { ok: false, error: budget };

    const record = this.store.insertRun({
      agentId: input.agent.id,
      agentName: input.agent.name,
      parentSessionId: input.parentSessionId,
      label: input.agent.name,
      prompt: input.prompt,
      roundId: input.roundId,
      taskKey: input.taskKey,
      invokedBy: input.invokedBy,
    });

    const telemetry = new RunTelemetry({
      runId: record.id,
      // 子会话 id 在 start() resolve 之前还不知道；先留空，发布后补上。
      sessionId: '',
      label: input.agent.name,
      agentName: input.agent.name,
      windowMs: this.config.tokPerSecondWindowMs,
      startedAt: Date.now(),
      // agent 配置的 maxContext 作为窗口的**中间层**：
      // 适配器自报（request/context）> agent 配置 > 兜底 1M。
      contextBudget: input.agent.maxContext,
    });
    telemetry.status = 'queued';
    this.live.set(record.id, telemetry);

    // 每次运行从一开始就挂一个 deferred：调用方（工具）可能立刻就 await 它，
    // 也可能在它已经跑完之后才来问——所以终态还要在 settled 里留一份。
    let resolveWaiter;
    const promise = new Promise((resolve) => { resolveWaiter = resolve; });
    this.waiters.set(record.id, { promise, resolve: resolveWaiter });

    this.queue.push({ record, telemetry, input });
    this.#emit({ kind: 'run', runId: record.id, summary: telemetry.summary() });
    this.#pump();
    return { ok: true, run: record };
  }

  /**
   * 输入预算检查。
   * @param {object} agent - agent 配置。
   * @param {string} prompt - 任务文本。
   * @returns {string|null} 超限时返回错误文本。
   */
  #checkBudget(agent, prompt) {
    if (!Number.isSafeInteger(agent.maxContext) || agent.maxContext <= 0) return null;
    // 粗估：按 3 字符/token 折中（这里只需要判断「量级明显不对」，不需要精确）。
    const estimatedTokens = Math.ceil(prompt.length / 3);
    // 给子 agent 的后续工具往返留出余量：任务本身不该吃掉整个窗口。
    const allowed = Math.floor(agent.maxContext * 0.5);
    if (estimatedTokens > allowed) {
      return `任务文本约 ${estimatedTokens} tokens，超过该子 agent 配置的输入预算`
        + `（maxContext=${agent.maxContext}，仅允许用其一半 ≈ ${allowed} tokens）。`
        + '请拆分任务，或调大该子 agent 的 maxContext。注意：maxContext 是本插件的护栏，'
        + '不是模型真实窗口——真实窗口由 DSH 的模型目录决定，无法按子 agent 单独调小。';
    }
    return null;
  }

  /**
   * 尽量把队列里的运行推起来（受 maxConcurrentRuns 限制）。
   *
   * 每次启动任务时都重新读一遍 `this.config.maxConcurrentRuns`（而不是构造时快照），
   * 就是为了让界面改并发上限能**立刻**生效——调大之后排队的任务马上被放出去。
   * @returns {void}
   */
  #pump() {
    while (this.queue.length > 0 && this.active.size < this.config.maxConcurrentRuns) {
      const job = this.queue.shift();
      void this.#launch(job);
    }
  }

  /**
   * 配置变更后重新评估队列。
   *
   * 光把新值写进 config 是不够的：队列只在下一次有任务结束时才会被重新看一遍，
   * 所以「调大并发」的即时效果就是把 pump 显式再跑一次。
   * 调小并发时不做任何事——已经在跑的不该被砍掉，那会让正在做的工作白费；
   * 多出来的部分会在它们自然收敛后按新上限放行。
   *
   * @returns {{maxConcurrentRuns:number,active:number,queued:number}}
   */
  reconfigure() {
    this.#pump();
    return {
      maxConcurrentRuns: this.config.maxConcurrentRuns,
      active: this.active.size,
      queued: this.queue.length,
    };
  }

  /**
   * 真正启动一次运行。
   * @param {{record:object,telemetry:RunTelemetry,input:object}} job - 队列项。
   * @returns {Promise<void>}
   */
  async #launch(job) {
    const { record, telemetry, input } = job;
    const subagents = safeGet(this.ctx, 'subagents');
    this.active.add(record.id);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      this.log.warn(`run ${record.id} 超过 ${this.config.runTimeoutMs}ms，取消`);
      controller.abort(new Error('subagent run timeout'));
    }, this.config.runTimeoutMs);
    timer.unref?.();

    this.handles.set(record.id, { controller, run: undefined });

    try {
      const request = {
        label: input.agent.name,
        prompt: [{ type: 'text', text: input.prompt }],
        parent: input.parentAgent,
        signal: controller.signal,
        agentOptions: toAgentOptions(input.agent),
      };
      const toolFilter = toToolFilter(input.agent, this.config.readonlyToolAllow);
      if (toolFilter !== undefined) request.toolFilter = toolFilter;
      if (typeof input.agent.persona === 'string' && input.agent.persona !== '') {
        request.persona = input.agent.persona;
      }

      const run = await subagents.start(input.agent.transport, request);
      this.handles.get(record.id).run = run;

      // 发布后才知道子会话 id —— 它就是需求 2 里「查看调用的会话是哪个」的答案。
      const sessionId = String(run?.id ?? '');
      telemetry.sessionId = sessionId;
      telemetry.startedAt = Date.now();
      telemetry.status = 'running';
      this.store.updateRun(record.id, {
        sessionId,
        status: 'running',
        startedAt: telemetry.startedAt,
        label: input.agent.name,
      });
      this.#emit({ kind: 'run', runId: record.id, summary: telemetry.summary() });

      const result = await run.result;
      const endedAt = Date.now();
      const stopReason = String(result?.stopReason ?? '');
      const status = this.#statusFromStopReason(stopReason, controller.signal.aborted);
      // `SubagentResult.output` 的类型是 **`ContentBlock[]`，不是 `string`**
      // （`dsh-subagent/lib/types/types.d.ts:219`）。这里曾经写成 `String(result?.output ?? '')`，
      // 于是数组被 JS 强制转成 `"[object Object],[object Object]"`——
      // **运行完全成功，但用户和主对话只看到一串 [object Object]**。
      // 真机第一次 @ 调用就是这么暴露的。用 contentToText 提取文本块，字符串则原样透传。
      const output = contentToText(result?.output) || telemetry.output;

      telemetry.settle({ status, stopReason, diagnostic: String(result?.diagnostic ?? ''), endedAt });
      this.#persist(record.id, telemetry, {
        output,
        structured: result?.structured,
        truncated: output.length > this.config.outputTailChars,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const endedAt = Date.now();
      telemetry.settle({
        status: aborted ? 'timeout' : 'error',
        stopReason: aborted ? 'timeout' : 'error',
        error: aborted ? '超过运行时长上限，已取消' : describeError(error),
        endedAt,
      });
      this.#persist(record.id, telemetry, { output: telemetry.output, structured: undefined, truncated: false });
      this.log.warn(`run ${record.id} 失败：${describeError(error)}`);
    } finally {
      clearTimeout(timer);
      const handle = this.handles.get(record.id);
      // 无论成功失败都必须 dispose：run 是「一次性的前台委派」，
      // 不 dispose 就等于留下一个永不收敛的子 agent。
      try {
        await handle?.run?.dispose?.();
      } catch (error) {
        this.log.debug(`dispose(${record.id}) failed: ${describeError(error)}`);
      }
      this.handles.delete(record.id);
      this.active.delete(record.id);
      this.#emit({ kind: 'run', runId: record.id, summary: telemetry.summary() });
      this.#pump();
    }
  }

  /**
   * 把 DSH 的 stopReason 映射成本插件的状态枚举。
   * @param {string} stopReason - DSH 的终止原因。
   * @param {boolean} aborted - 是否被本插件取消。
   * @returns {string}
   */
  #statusFromStopReason(stopReason, aborted) {
    if (aborted) return 'timeout';
    switch (stopReason) {
      case 'completed': return 'completed';
      case 'cancelled':
      case 'canceled': return 'cancelled';
      case 'error':
      case 'failed': return 'error';
      default:
        // 未知原因也算完成：结果拿到了就是拿到了，不因为枚举没认出来就丢弃。
        return stopReason === '' ? 'completed' : 'completed';
    }
  }

  /**
   * 等一次运行走到终态。
   *
   * 已经结算过的运行会立刻返回（`settled` 缓存），因此调用方不必担心
   * 「我先启动了它、处理别的事、再回来 await」这种时序。
   * @param {string} runId - run id。
   * @returns {Promise<object>|undefined} 未知 runId 时返回 undefined。
   */
  waitFor(runId) {
    const settled = this.settled.get(runId);
    if (settled !== undefined) return Promise.resolve(settled);
    const waiter = this.waiters.get(runId);
    return waiter === undefined ? undefined : waiter.promise;
  }

  /**
   * 结算一次运行的 deferred 并缓存终态摘要。
   * @param {string} runId - run id。
   * @param {RunTelemetry} telemetry - 遥测。
   * @param {string} output - 最终输出。
   * @returns {void}
   */
  #settleWaiter(runId, telemetry, output) {
    const payload = {
      ...telemetry.summary(),
      output,
      wasQueued: false,
    };
    this.settled.set(runId, payload);
    const waiter = this.waiters.get(runId);
    this.waiters.delete(runId);
    try {
      waiter?.resolve(payload);
    } catch (error) {
      this.log.debug(`resolve waiter(${runId}) failed: ${describeError(error)}`);
    }
  }

  /**
   * 写终态（内存遥测保留，供详情页继续回看）。
   * @param {string} runId - run id。
   * @param {RunTelemetry} telemetry - 遥测。
   * @param {{output:string,structured:unknown,truncated:boolean}} extra - 额外字段。
   * @returns {void}
   */
  #persist(runId, telemetry, extra) {
    try {
      this.store.updateRun(runId, {
        status: telemetry.status,
        endedAt: telemetry.endedAt,
        durationMs: (telemetry.endedAt ?? Date.now()) - telemetry.startedAt,
        stepMs: telemetry.decodeMs,
        tokensIn: telemetry.tokensIn,
        tokensOut: telemetry.tokensOut,
        tokPerS: telemetry.rate().value,
        stopReason: telemetry.stopReason,
        error: telemetry.error,
        diagnostic: telemetry.diagnostic,
        outputTail: extra.output.slice(0, this.config.outputTailChars),
        truncated: extra.truncated ? 1 : 0,
        structuredJson: extra.structured === undefined ? null : JSON.stringify(extra.structured),
      });
    } catch (error) {
      this.log.warn(`写运行记录 ${runId} 失败：${describeError(error)}`);
    }
    // 落库失败也要结算等待者：让调用方拿到「运行结束了，但记录没写成功」，
    // 而不是永远挂着——永久 pending 比一个明确的失败更糟。
    this.#settleWaiter(runId, telemetry, extra.output);
  }

  /**
   * 取消一次运行。
   * @param {string} runId - run id。
   * @returns {boolean} 是否发出取消。
   */
  cancel(runId) {
    const handle = this.handles.get(runId);
    const telemetry = this.live.get(runId);
    if (handle === undefined) {
      // 还在队列里：直接从队列摘掉。
      const index = this.queue.findIndex((job) => job.record.id === runId);
      if (index >= 0) {
        const [job] = this.queue.splice(index, 1);
        job.telemetry.settle({ status: 'cancelled', stopReason: 'cancelled' });
        this.#persist(runId, job.telemetry, { output: '', structured: undefined, truncated: false });
        this.#emit({ kind: 'run', runId, summary: job.telemetry.summary() });
        return true;
      }
      return false;
    }
    telemetry && (telemetry.stopReason = 'cancelled');
    try {
      handle.controller.abort(new Error('cancelled by user'));
      return true;
    } catch (error) {
      this.log.debug(`abort(${runId}) failed: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * 取消某个父会话下所有还在跑的运行（会话关闭/用户要求停止时用）。
   * @param {string} parentSessionId - 父会话 id。
   * @returns {number} 取消数量。
   */
  cancelByParent(parentSessionId) {
    let count = 0;
    for (const [runId, telemetry] of this.live) {
      if (telemetry.status !== 'running' && telemetry.status !== 'queued') continue;
      const record = this.store.getRun(runId);
      if (record?.parentSessionId !== parentSessionId) continue;
      if (this.cancel(runId)) count += 1;
    }
    return count;
  }

  /**
   * 悬浮球用的全局快照。
   * @returns {object}
   */
  snapshot() {
    const now = Date.now();
    const runs = [...this.live.values()].map((telemetry) => telemetry.summary(now));
    const busy = runs.filter((run) => run.busy);
    return {
      busyCount: busy.length,
      activeCount: this.active.size,
      queuedCount: this.queue.length,
      maxConcurrentRuns: this.config.maxConcurrentRuns,
      // 超时上限要给界面：它是**唯一真实存在的「总量」**，因此也是液体进度条唯一诚实的取值依据
      // （「这个子 agent 还能跑多久」）。没有它，进度就只能是装饰性的猜测。
      runTimeoutMs: this.config.runTimeoutMs,
      maxParallelPerSession: this.config.maxParallelPerSession,
      // 主要速率 = 所有在跑运行的和（用户问「现在多快」，答案就是总算力）。
      tokPerS: Math.round(busy.reduce((sum, run) => sum + run.tokPerS, 0) * 10) / 10,
      anyEstimated: busy.some((run) => run.tokPerSEstimated),
      runs: runs.sort((left, right) => {
        if (left.busy !== right.busy) return left.busy ? -1 : 1;
        return right.startedAt - left.startedAt;
      }).slice(0, 50),
    };
  }

  /**
   * 详情页用的实时内容。
   * @param {string} runId - run id。
   * @returns {object|undefined}
   */
  detail(runId) {
    const telemetry = this.live.get(runId);
    if (telemetry === undefined) return undefined;
    return {
      ...telemetry.summary(),
      input: telemetry.input,
      output: telemetry.output,
      reasoning: telemetry.reasoning,
      tools: telemetry.tools,
      charsPerToken: Math.round(telemetry.charsPerToken * 100) / 100,
      calibrated: telemetry.calibrated,
    };
  }

  /**
   * 启动时对账：把上次进程留在 running/queued 的记录标成中断。
   *
   * 不做这件事的话，被强杀的进程会留下永远「运行中」的幽灵记录，
   * 悬浮球与排名都会被污染。
   * @returns {number} 修正条数。
   */
  reconcileStaleRuns() {
    const db = this.store.require();
    const now = Date.now();
    const result = db.prepare(`
      UPDATE runs SET status = 'cancelled', ended_at = ?, stop_reason = 'interrupted',
                      error = '进程在运行期间退出，本次运行没有结果'
      WHERE status IN ('queued', 'running')
    `).run(now);
    return Number(result.changes ?? 0);
  }

  /**
   * 这个会话是不是**本插件派出去的子 agent 会话**。
   *
   * 存在的理由只有一个：工具边界需要区分「派活的人」与「干活的人」。
   * 子 agent 手里也有同一套工具，而任务清单的写操作（激活/取消/重试）属于调度者——
   * 放开的话，A 任务可以取消 B 任务，链路的推进权就不再属于派活的那一方了。
   * @param {string} sessionId - 会话 id。
   * @returns {boolean}
   */
  isChildSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    for (const telemetry of this.live.values()) {
      if (telemetry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * 清掉内存里的遥测（保留设置项开关为「不保留历史运行」时用）。
   * @returns {void}
   */
  clearLive() {
    this.live.clear();
  }
}

/**
 * 把内容块数组折成纯文本。
 *
 * 接受三种输入：字符串（原样返回）、`ContentBlock[]`（提取 text 块）、其它（空串）。
 * 之所以要兼容字符串：调用方有的地方从 DSH 拿 `ContentBlock[]`，
 * 有的地方从自己的遥测拿已经拼好的字符串，用同一个函数就不会有人再写 `String(array)`。
 *
 * @param {unknown} content - ContentBlock[] 或 string。
 * @returns {string}
 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 数值兜底。
 * @param {unknown} value - 值。
 * @param {number|null} fallback - 兜底。
 * @returns {number|null}
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 夹取值。
 * @param {number} value - 值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
