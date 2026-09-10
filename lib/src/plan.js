/**
 * 任务清单与依赖图的**纯领域逻辑**。
 *
 * 为什么单独一个文件、且**不 import 任何东西**：这一层要回答的问题是
 * 「这份清单合不合法」「现在哪些任务能跑、哪些在等谁、哪些已经没救了」——
 * 它是宿主（调度、工具）与界面（链路图配色）**共用的同一个判断**。
 * 一旦这份判断分散到 sqlite 查询、HTTP 处理与 React 组件里，
 * 迟早出现「图上是绿的、调度器却不动」这种自相矛盾的状态。
 *
 * 所以这一层的边界是刻意画死的：
 *  - 不知道 DSH、不知道 sqlite、不知道时间（不调 Date.now）、不碰磁盘；
 *  - 入参是普通对象（下面 `TASK_SHAPE` 描述的字段），出参是普通对象；
 *  - 于是它可以被穷举测试，而且宿主与浏览器两端拿到的是同一份结论。
 *
 * ## 两个刻意的设计决定
 *
 * 1. **状态是算出来的，不是存下来的。** 任务的状态是
 *    「自己的运行结果 + 依赖们的结果 + 有没有被人工取消」的函数。
 *    落库的状态会有第二个真相来源：进程被杀、手工改库、事件丢失都会让它和事实漂移，
 *    而漂移的表现是「面板说完成、链路却卡住」。所以库里只存**事实**
 *    （run_id / run_status / cancelled_at），状态每次读取时现算（几十个任务，代价可忽略）。
 *
 * 2. **等待与阻塞是两种不同的东西。** 「依赖还没跑完」会自己好，
 *    「上游失败了」不会自己好——把它们都画成「等待」等于骗人：
 *    用户会一直等一个永远不会动的流水线。所以 `waiting`（等依赖）与
 *    `blocked`（上游失败/取消）分开，后者只能靠重试上游或取消本任务来解除。
 *
 * @module dsh-subagent-hub/plan
 */

/**
 * 任务状态枚举（**派生结果**，不落库）。每个状态的语义：
 *
 * | 状态 | 含义 | 会自己变吗 |
 * | --- | --- | --- |
 * | `waiting` | 依赖还没完成，不能派发 | 会（依赖完成后变 `ready`） |
 * | `ready` | 依赖已全部完成，等待被激活 | 会（激活后变 `running`） |
 * | `running` | 已派发（含排队），有 run_id | 会（运行结束后变终态） |
 * | `done` | 运行成功完成 | 不会 |
 * | `failed` | 运行失败/超时/被取消 | 不会（除非重试） |
 * | `blocked` | 上游有失败/取消的任务，本任务永远不可能就绪 | 不会（除非重试上游） |
 * | `cancelled` | 人工取消了这个任务 | 不会（除非重试） |
 */
export const TASK_STATES = Object.freeze([
  'waiting', 'ready', 'running', 'done', 'failed', 'blocked', 'cancelled',
]);

/** 运行走到终态的状态（与 store 的 RUN_STATUSES 的终态部分一致）。 */
export const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'error', 'timeout', 'cancelled']);

/** 运行还在进行中的状态。 */
export const LIVE_RUN_STATUSES = Object.freeze(['queued', 'running']);

/** 任务 id 的形状：要能出现在 URL 与工具参数里，所以限制成安全字符集。 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 单个清单的任务数上限。不是性能问题，是「看得懂」的问题：一层画不下几十个节点的图没有意义。 */
export const MAX_TASKS_PER_PLAN = 64;

/** 字段长度上限：超过的输入是错的，不该静默截断进库。 */
const LIMITS = Object.freeze({ title: 160, brief: 8000, note: 2000, agent: 120, planTitle: 160 });

const TERMINAL_SET = new Set(TERMINAL_RUN_STATUSES);
const LIVE_SET = new Set(LIVE_RUN_STATUSES);

/**
 * 任务事实（本模块所有函数的输入形状，也是 store 返回给宿主的样子）。
 *
 * @typedef {object} TaskFacts
 * @property {string} id - 清单内唯一的任务 id（例如 `t1`）。
 * @property {number} seq - 建单顺序（界面按它稳定排序）。
 * @property {string} title - 一句话任务名。
 * @property {string} brief - 交给子 agent 的完整任务说明。
 * @property {string} agentName - 由哪个子 agent 执行（agent 的 name，即 @ 句柄）。
 * @property {string[]} deps - 依赖的任务 id。
 * @property {string} runId - 已派发的 run id（未派发为空串）。
 * @property {string} runStatus - 落库的 runs.status（未派发为空串）。
 * @property {number|null} cancelledAt - 人工取消时间。
 * @property {number} attempts - 已派发次数（重试会 +1）。
 */

/**
 * 校验并归一化一条任务草稿。
 * @param {unknown} raw - 模型/用户给的任务对象。
 * @param {number} index - 在数组里的下标（用于自动编号与报错定位）。
 * @param {{knownIds:Set<string>, takenIds:Set<string>}} context - 已知 id（依赖可指向）与已占用 id。
 * @returns {{errors:string[], value:object|undefined}} value 仅在无错时有值。
 */
export function normalizeTaskSpec(raw, index, context) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [`tasks[${index}] 必须是对象`], value: undefined };
  }
  const at = `tasks[${index}]`;

  const rawId = raw.id === undefined || raw.id === null || raw.id === '' ? `t${index + 1}` : String(raw.id).trim();
  if (!TASK_ID_PATTERN.test(rawId)) {
    errors.push(`${at}.id「${rawId}」不合法：只允许 1-32 个字母/数字/下划线/连字符`);
  } else if (context.takenIds.has(rawId)) {
    errors.push(`${at}.id「${rawId}」重复：同一个清单里任务 id 必须唯一（依赖靠它指认，重名会让依赖有歧义）`);
  }

  const title = String(raw.title ?? '').trim();
  if (title === '') errors.push(`${at}.title 必填：任务名是链路图上唯一能看的东西，没有它这张图就没法读`);
  else if (title.length > LIMITS.title) errors.push(`${at}.title 超过 ${LIMITS.title} 字`);

  const agentName = String(raw.agent ?? raw.agentName ?? '').trim();
  if (agentName === '') errors.push(`${at}.agent 必填（子 agent 的 @ 句柄）`);
  else if (agentName.length > LIMITS.agent) errors.push(`${at}.agent 超过 ${LIMITS.agent} 字`);
  else if (context.knownAgents !== undefined && !context.knownAgents.has(agentName)) {
    errors.push(`${at}.agent「${agentName}」不是已配置的子 agent`
      + `（当前：${[...context.knownAgents].join('、') || '一个都没有'}）——`
      + '写错的名字不会有人来接这一棒，任务会永远停在「等待激活」');
  }

  const brief = String(raw.brief ?? raw.prompt ?? '').trim();
  if (brief.length > LIMITS.brief) errors.push(`${at}.brief 超过 ${LIMITS.brief} 字`);

  const deps = [];
  const rawDeps = raw.deps ?? raw.depends_on ?? [];
  if (!Array.isArray(rawDeps)) {
    errors.push(`${at}.deps 必须是数组（没有依赖就给 []）`);
  } else {
    for (const dep of rawDeps) {
      const id = String(dep ?? '').trim();
      if (id === '') continue;
      if (id === rawId) errors.push(`${at}.deps 不能依赖自己`);
      // 合法依赖 = 本批里的任务（knownIds）或这条清单里已有的任务（takenIds）。
      else if (!context.knownIds.has(id) && !context.takenIds.has(id)) {
        errors.push(`${at}.deps 指向了不存在的任务「${id}」`);
      }
      if (!deps.includes(id)) deps.push(id);
    }
  }

  if (errors.length > 0) return { errors, value: undefined };
  return {
    errors: [],
    value: { id: rawId, seq: index + 1, title, brief, agentName, deps },
  };
}

/**
 * 校验整个清单草稿（新建时用）。
 *
 * 一次把**所有**错误都报出来，而不是遇到第一个就停：这个函数的调用者通常是一个
 * 语言模型，一次给全部错误它能一轮改完；只报第一条会让它来回改好几轮。
 *
 * @param {unknown} input - `{title, note, autoActivate, tasks}`。
 * @param {{knownAgents?:string[], takenIds?:Set<string>, baseIds?:Set<string>, requireTitle?:boolean}} [options] - 外部约束。
 * @returns {{ok:boolean, errors:string[], warnings:string[], plan:object|undefined}}
 */
export function validatePlanDraft(input, options = {}) {
  const errors = [];
  const warnings = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['请求体必须是对象：{title, tasks: [...]}'], warnings, plan: undefined };
  }

  // 追加模式下清单已经有名字了，不该在这里再要一次 title。
  const requireTitle = options.requireTitle !== false;
  const title = String(input.title ?? '').trim();
  if (title === '' && requireTitle) errors.push('title 必填：清单名是界面上区分多条链路的唯一标识');
  else if (title.length > LIMITS.planTitle) errors.push(`title 超过 ${LIMITS.planTitle} 字`);
  const note = String(input.note ?? '').trim();
  if (note.length > LIMITS.note) errors.push(`note 超过 ${LIMITS.note} 字`);

  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length === 0) errors.push('tasks 至少要有一项：空清单没有可看的东西');
  if (rawTasks.length > MAX_TASKS_PER_PLAN) {
    errors.push(`tasks 最多 ${MAX_TASKS_PER_PLAN} 项（当前 ${rawTasks.length}）：`
      + '一条链路要能一眼看懂，装不下的应当分成多条清单');
  }

  const knownAgents = options.knownAgents === undefined ? undefined : new Set(options.knownAgents.map(String));
  const baseIds = options.baseIds ?? new Set();
  // `takenIds` 只表示「这条清单里已经存在的任务 id」（追加模式），用于让依赖能指向它们。
  const takenIds = new Set(options.takenIds ?? []);

  // 先扫一遍 id：既要让「依赖指向同批里后面才定义的任务」能通过，
  // 也要在**本批内部**查重。查重必须独立于其它校验：一条任务因为缺 title 而没被采纳时，
  // 它占用的 id 也已经存在了——否则「两条都叫 t1」会在缺 title 的干扰下溜过去。
  const counts = new Map();
  for (const [index, raw] of rawTasks.entries()) {
    const candidate = raw !== null && typeof raw === 'object' && raw.id !== undefined && raw.id !== null && raw.id !== ''
      ? String(raw.id).trim()
      : `t${index + 1}`;
    if (!TASK_ID_PATTERN.test(candidate)) continue;
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count <= 1) continue;
    if (takenIds.has(id)) errors.push(`任务 id「${id}」这条清单里已经有了：依赖靠 id 指认，重名会让依赖有歧义`);
    else errors.push(`任务 id「${id}」在这一批里出现了 ${count} 次：依赖靠 id 指认，重名会让依赖有歧义`);
  }

  const batchIds = new Set(counts.keys());
  const context = { knownIds: new Set([...baseIds, ...batchIds]), takenIds, knownAgents };
  const tasks = [];
  for (const [index, raw] of rawTasks.entries()) {
    const checked = normalizeTaskSpec(raw, index, context);
    errors.push(...checked.errors);
    if (checked.value === undefined) continue;
    tasks.push(checked.value);
  }

  // 依赖只能指向本批或已有任务；上面逐条判过，这里再兜一层（防止 id 非法时漏判）。
  const seen = new Set([...takenIds, ...baseIds, ...batchIds]);
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!seen.has(dep)) errors.push(`任务「${task.id}」的依赖「${dep}」不存在`);
    }
  }

  if (errors.length === 0) {
    const cycle = detectCycle(tasks, baseIds);
    if (cycle !== null) {
      errors.push(`依赖形成了环：${cycle.join(' → ')}。`
        + '环上的任务互相等待、永远不会就绪，必须打开其中一个依赖');
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings, plan: undefined };
  return {
    ok: true,
    errors: [],
    warnings,
    plan: {
      title,
      note,
      autoActivate: input.autoActivate !== false,
      tasks,
    },
  };
}

/**
 * 环检测（DFS 三色标记），返回一条**具体**的环路径。
 *
 * 为什么返回路径而不是 true/false：错误信息的价值在于可行动。
 * 「有环」会让人盯着十几个节点找半天，「t3 → t5 → t3」直接指出该动哪条边。
 *
 * @param {object[]} tasks - 任务（只用到 id 与 deps）。
 * @param {Set<string>} [baseIds] - 允许出现在依赖里但不在本批内的 id（追加任务时指向已有任务）。
 * @returns {string[]|null} 环路径；无环返回 null。
 */
export function detectCycle(tasks, baseIds = new Set()) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map();
  const stack = [];

  /** 深度优先。 */
  const visit = (id) => {
    const mark = state.get(id);
    if (mark === 'done') return null;
    if (mark === 'open') {
      const from = stack.indexOf(id);
      return [...stack.slice(from), id];
    }
    const task = byId.get(id);
    // 指向本批之外的依赖当作「已完成的外部输入」，不去遍历它。
    if (task === undefined) {
      if (baseIds.has(id)) return null;
      return null;
    }
    state.set(id, 'open');
    stack.push(id);
    for (const dep of task.deps ?? []) {
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * 拓扑分层：同一层的任务之间没有依赖，可以**并行**。
 *
 * 深度取「最长路径」而不是「最早可排的位置」：后者会把一条长链拆散到同一层里，
 * 画出来的图看着并行、实际串行——图要说的是**什么时候能跑**，不是能塞多紧。
 *
 * @param {object[]} tasks - 任务。
 * @returns {{layers:string[][], depth:Map<string,number>}}
 */
export function layering(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map();
  const visiting = new Set();

  /** 记忆化求深度。 */
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    const task = byId.get(id);
    if (task === undefined) return -1; // 外部依赖：不影响分层
    if (visiting.has(id)) return 0; // 有环时的保底（校验应当已经拦掉）
    visiting.add(id);
    let value = 0;
    for (const dep of task.deps ?? []) {
      value = Math.max(value, depthOf(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };

  for (const task of tasks) depthOf(task.id);

  const layers = [];
  for (const task of tasks) {
    const level = depth.get(task.id) ?? 0;
    if (layers[level] === undefined) layers[level] = [];
    layers[level].push(task.id);
  }
  for (let index = 0; index < layers.length; index += 1) {
    if (layers[index] === undefined) layers[index] = [];
  }
  return { layers, depth };
}

/**
 * 算出每个任务的当前状态（本模块的核心）。
 *
 * 算法：先按拓扑序求值（保证算一个任务时它的依赖已经有结论），
 * 再对**没被拓扑序覆盖到的**任务（只可能出现在手改数据库造成的环里）兜底成 `waiting`——
 * 这样即使数据坏了也只会「卡住」而不会死循环或抛错：坏数据不该让整个面板打不开。
 *
 * @param {TaskFacts[]} tasks - 任务事实。
 * @returns {{byId:Record<string,object>, ready:string[], waiting:string[], blocked:string[], running:string[], done:string[], failed:string[], cancelled:string[], progress:object, layers:string[][], depth:Record<string,number>}}
 */
export function evaluate(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const { layers, depth } = layering(tasks);
  const order = topoOrder(tasks);
  const states = {};

  /**
   * 依赖结论 → 本任务结论。
   * @param {TaskFacts} task - 任务事实。
   * @returns {object} 状态条目。
   */
  const decide = (task) => {
    const deps = Array.isArray(task.deps) ? task.deps : [];
    const depStates = deps.map((dep) => states[dep]?.state ?? 'waiting');
    const blockedBy = deps.filter((dep, index) => isClosedFailure(depStates[index]));
    const waitingFor = deps.filter((dep, index) => !isClosedFailure(depStates[index]) && depStates[index] !== 'done');
    const base = {
      id: task.id,
      title: task.title ?? '',
      agentName: task.agentName ?? '',
      deps: [...deps],
      runId: task.runId ?? '',
      runStatus: task.runStatus ?? '',
      attempts: Number(task.attempts ?? 0),
      depth: depth.get(task.id) ?? 0,
      waitingFor,
      blockedBy,
    };

    if (task.cancelledAt !== null && task.cancelledAt !== undefined) return { ...base, state: 'cancelled' };
    const runStatus = String(task.runStatus ?? '');
    if (LIVE_SET.has(runStatus)) return { ...base, state: 'running' };
    if (runStatus === 'completed') return { ...base, state: 'done' };
    if (TERMINAL_SET.has(runStatus)) return { ...base, state: 'failed' };
    if (blockedBy.length > 0) return { ...base, state: 'blocked' };
    if (waitingFor.length > 0) return { ...base, state: 'waiting' };
    return { ...base, state: 'ready' };
  };

  for (const id of order) {
    const task = byId.get(id);
    if (task !== undefined) states[id] = decide(task);
  }
  for (const task of tasks) {
    if (states[task.id] === undefined) states[task.id] = decide(task);
  }

  const bucket = (state) => tasks.filter((task) => states[task.id]?.state === state).map((task) => task.id);
  const ready = bucket('ready');
  // 「可执行」按分层顺序给：先来的先激活，链路的推进顺序才和图上读到的顺序一致。
  ready.sort((left, right) => (states[left].depth - states[right].depth) || (byId.get(left).seq - byId.get(right).seq));

  const done = bucket('done');
  const total = tasks.length;
  return {
    byId: states,
    ready,
    waiting: bucket('waiting'),
    blocked: bucket('blocked'),
    running: bucket('running'),
    done,
    failed: bucket('failed'),
    cancelled: bucket('cancelled'),
    layers,
    depth: Object.fromEntries(depth),
    progress: {
      total,
      done: done.length,
      active: bucket('running').length,
      ready: ready.length,
      waiting: bucket('waiting').length,
      blocked: bucket('blocked').length,
      failed: bucket('failed').length,
      cancelled: bucket('cancelled').length,
      closed: done.length + bucket('failed').length + bucket('cancelled').length + bucket('blocked').length,
      percent: total === 0 ? 0 : Math.round((done.length / total) * 100),
    },
  };
}

/**
 * 返回「卡死」的依赖状态：失败、阻塞、被取消——这三种都不会自己好。
 * @param {string} state - 依赖的状态。
 * @returns {boolean}
 */
function isClosedFailure(state) {
  return state === 'failed' || state === 'blocked' || state === 'cancelled';
}

/**
 * 拓扑序（Kahn）。环上的节点不会出现在结果里——调用方必须自己对剩下的兜底。
 * @param {TaskFacts[]} tasks - 任务事实。
 * @returns {string[]}
 */
export function topoOrder(tasks) {
  const inDegree = new Map();
  const children = new Map();
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    children.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (!ids.has(dep)) continue;
      children.get(dep).push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }
  const queue = tasks.filter((task) => inDegree.get(task.id) === 0).map((task) => task.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  return order;
}

/** 状态的中文短标签（宿主渲染给模型、界面渲染给用户，用同一份，避免两边说法不一致）。 */
export const STATE_LABELS = Object.freeze({
  waiting: '等待依赖',
  ready: '可执行',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  blocked: '被上游阻塞',
  cancelled: '已取消',
});

/**
 * 把一条链路渲染成给模型看的文本。
 *
 * 为什么用分层而不是按建单顺序列：模型真正要判断的是「现在谁在跑、下一个该谁」，
 * 分层把「同时能跑」和「必须排队」的区别直接写出来，模型不必自己在脑子里做拓扑排序。
 *
 * @param {{id:string,title:string,autoActivate:boolean}} plan - 清单。
 * @param {TaskFacts[]} tasks - 任务事实。
 * @param {{focusTaskId?:string, briefLimit?:number}} [options] - 渲染选项。
 * @returns {string}
 */
export function renderBoardText(plan, tasks, options = {}) {
  const evaluated = evaluate(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lines = [];

  const progress = evaluated.progress;
  lines.push(`任务清单「${plan.title}」（${plan.id}，${plan.autoActivate ? '依赖完成自动激活' : '手动激活'}）`);
  lines.push(`进度 ${progress.done}/${progress.total}`
    + `｜运行中 ${progress.active}｜可执行 ${progress.ready}｜等待 ${progress.waiting}`
    + `｜阻塞 ${progress.blocked}｜失败 ${progress.failed}｜取消 ${progress.cancelled}`);

  for (const [index, layer] of evaluated.layers.entries()) {
    if (layer.length === 0) continue;
    lines.push(`第 ${index + 1} 层${layer.length > 1 ? `（可并行 ${layer.length} 项）` : ''}`);
    for (const id of layer) {
      const task = byId.get(id);
      const state = evaluated.byId[id];
      if (task === undefined || state === undefined) continue;
      lines.push(`  ${renderTaskLine(task, state, options)}`);
    }
  }

  const next = describeNext(evaluated);
  if (next !== '') lines.push(next);
  return lines.join('\n');
}

/**
 * 一行任务文本。
 * @param {TaskFacts} task - 任务事实。
 * @param {object} state - 该任务的状态条目。
 * @param {{focusTaskId?:string, briefLimit?:number}} options - 选项。
 * @returns {string}
 */
export function renderTaskLine(task, state, options = {}) {
  const marks = [];
  marks.push(`[${STATE_LABELS[state.state] ?? state.state}]`);
  const head = `${marks.join('')} ${task.id} ${task.title} → ${task.agentName}`;
  const extras = [];
  if (state.state === 'waiting' && state.waitingFor.length > 0) extras.push(`等 ${state.waitingFor.join('、')}`);
  if (state.state === 'blocked' && state.blockedBy.length > 0) extras.push(`上游 ${state.blockedBy.join('、')} 已失败/取消`);
  if (state.runId !== '') extras.push(`run ${state.runId}`);
  if (state.attempts > 1) extras.push(`第 ${state.attempts} 次尝试`);
  const suffix = extras.length === 0 ? '' : `（${extras.join('；')}）`;
  if (options.focusTaskId === task.id && task.brief !== '') {
    const limit = Number.isSafeInteger(options.briefLimit) ? options.briefLimit : 1200;
    const brief = task.brief.length > limit ? `${task.brief.slice(0, limit)}…（已截断）` : task.brief;
    return `${head}${suffix}\n      说明：${brief.split('\n').join('\n      ')}`;
  }
  return `${head}${suffix}`;
}

/**
 * 给模型一句「接下来会怎样」。
 *
 * 这句话的作用是替代一次猜测：自动激活是宿主在做的事，模型看不到，
 * 不写清楚它就会自己去重复派发（然后撞上「任务已经在跑」的拒绝）。
 * @param {object} evaluated - `evaluate` 的返回。
 * @returns {string}
 */
export function describeNext(evaluated) {
  const parts = [];
  if (evaluated.running.length > 0) parts.push(`正在跑：${evaluated.running.join('、')}`);
  if (evaluated.ready.length > 0) parts.push(`可立即激活：${evaluated.ready.join('、')}`);
  if (evaluated.waiting.length > 0) parts.push(`等依赖：${evaluated.waiting.join('、')}`);
  if (evaluated.blocked.length > 0) parts.push(`被阻塞（需要重试上游或取消本任务）：${evaluated.blocked.join('、')}`);
  return parts.length === 0 ? '' : `下一步：${parts.join('｜')}`;
}
