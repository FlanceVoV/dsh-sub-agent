/**
 * 团队模式（team mode）：群组讨论 + 群主调度 + 任务链执行。
 *
 * ## 它解决的是什么问题
 *
 * 单个子 agent 的委派是「一问一答」：主对话派活、子 agent 干完、结果回到主对话。
 * 一旦任务需要**多个角色的判断**（谁方案更稳、谁在哪些约束上被卡住），
 * 一问一答就退化成「主对话替所有人转述」——而主对话没有各方的独立上下文，
 * 转述出来的共识通常是它自己的观点被复述三遍。
 *
 * 团队模式把这件事搬到一个**真正的群聊**里：群主（负责人）主持、成员各自发言、
 * 轮流制（同一时刻只有一个人在说）、最后由群主把结论固化成一条任务链。
 * 这一层是「讨论」，任务链那一层是「执行」，两者共用同一套子 agent 运行时。
 *
 * ## 三条设计决定（及其理由）
 *
 * 1. **驱动在宿主，不在主对话。** 讨论由本模块的异步循环串行推进（`#drive`），
 *    每次只起一个子 agent 的运行并等它落地。好处有三：
 *    - 主对话的回合结束**不会**掐断讨论（这正是子 agent 链路踩过的老坑）；
 *    - 「一个没说完，下一个必须等」是循环结构本身保证的，不靠提示词自律；
 *    - 面板关掉、窗口刷新都不影响群聊继续。
 *    代价是进程重启会丢驱动者——所以 `attach()` 把「讨论中」对账成「已暂停」，
 *    而不是让界面继续显示一场没人推动的讨论。
 *
 * 2. **群主是唯一的调度者。** 每次有人发言之后，话语权都回到群主：它读记录、
 *    下判断、用最后一行 `@名字` / `@用户` / `@收尾` 指定下一棒。成员之间不直接接龙，
 *    因为「谁下一个说」需要一个对全局负责的人来判断，而人是会漏的，模型更会。
 *    这条也让讨论**必然收敛**：轮次上限一到，宿主强制进入收尾。
 *
 * 3. **群聊记录是唯一的共享上下文。** 子 agent 之间不共享上下文（这是 DSH 的既定事实），
 *    所以群聊记录就是它们的共享记忆：每轮发言时按字符预算截取最近若干条注入提示词。
 *    预算必须存在——否则一场四人群聊跑三轮就能把输入预算吃穿。
 *
 * @module dsh-subagent-hub/team
 */
import { describeError } from './log.js';
import { contentToText } from './runtime.js';

/** 讨论阶段（`teams.phase`）。 */
export const TEAM_PHASES = Object.freeze(['discuss', 'execute', 'done']);

/** 群聊消息的类别（`team_messages.kind`）。 */
export const MESSAGE_KINDS = Object.freeze(['chat', 'directive', 'notice', 'status']);

/** 已结算的运行状态（与 plan.js 的口径一致，这里不 import 以免多一条依赖）。 */
const TERMINAL_STATUSES = new Set(['completed', 'error', 'timeout', 'cancelled']);

/**
 * 长度上限。
 *
 * `message` 是**群规**（「简短精炼，拒绝长篇大论」）的执行点：超了不删，
 * 但在提示词里被硬截断、并在记录里标 `overlong`，面板上会显示一个「超长」角标。
 * 不删的理由：删了就没人知道它到底说了什么，而那可能正是结论。
 */
const LIMITS = Object.freeze({
  name: 60,
  mission: 4000,
  declaration: 2000,
  message: 600,
});

/** 声明里三行的识别式（中英文都收，全角半角冒号都收）。 */
const DECLARATION_PATTERNS = Object.freeze({
  name: /^\s*(?:团队名称|团队名|队伍名称|team\s*name)\s*[:：]\s*(.*)$/i,
  owner: /^\s*(?:团队负责人|负责人|群主|队长|team\s*(?:owner|lead|leader))\s*[:：]\s*(.*)$/i,
  members: /^\s*(?:团队成员|成员|队员|team\s*members?)\s*[:：]\s*(.*)$/i,
});

/**
 * @ 句柄的抽取式。
 *
 * 排除空白、逗号、分号、冒号、斜杠、反斜杠与各类括号——「@架构师DSF4.1（负责统筹）」
 * 里的句柄是 `架构师DSF4.1`，把括号也吃进去会让这个名字永远对不上花名册。
 */
const MENTION_RE = /@([^\s@,，、;；:：/\\|（）()【】\[\]「」<>]+)/g;

/** 显式的「下一步」标记。群主自然写 @名字 也行，标记只是给不确定的模型一条明路。 */
const NEXT_MARKER_RE = /^(?:【下一步】|下一步\s*[:：]|下一位\s*[:：]|接下来\s*[:：]|@发言|发言\s*[:：]|→|->|➡)\s*/;

/** 行首的列表/引用符号（正文里的 `- 我觉得…` 不该被当成指令行）。 */
const LIST_PREFIX_RE = /^\s*(?:[-*>+]|\d+[.、)])\s*/;

//#region 纯函数：声明解析、指令解析、记录渲染

/**
 * 抽出所有 @句柄（去重、保序）。
 * @param {string} text - 文本。
 * @returns {string[]}
 */
function mentionsOf(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(MENTION_RE)) {
    const name = match[1].trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 解析用户的团队声明。
 *
 * 输入是**用户原文**（不是模型转述的版本）：团队名与成员是「谁是 @ 的句柄」这件事的
 * 权威来源，多经一道转述就多一个改错名字的机会。工具那边传的就是用户那几行原文。
 *
 * @param {string} text - 用户消息里的声明块。
 * @returns {{ok:boolean,spec:object|undefined,errors:string[],warnings:string[]}}
 */
export function parseTeamDeclaration(text) {
  const errors = [];
  const warnings = [];
  const source = String(text ?? '');
  if (source.trim() === '') {
    return {
      ok: false,
      spec: undefined,
      errors: ['声明是空的：需要「团队名称：…」「团队负责人：@…」「团队成员：@…」三行'],
      warnings,
    };
  }

  let name = '';
  let owner = '';
  const members = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    for (const [key, pattern] of Object.entries(DECLARATION_PATTERNS)) {
      const matched = pattern.exec(line);
      if (matched === null) continue;
      const value = matched[1].trim();
      if (key === 'name') {
        name = value.slice(0, LIMITS.name);
      } else if (key === 'owner') {
        const found = mentionsOf(value);
        owner = found.length > 0 ? found[0] : value.split(/[\s,，、;；]+/)[0].slice(0, LIMITS.name);
      } else {
        // 成员一行可能是「@a @b @c」，也可能是「a、b、c」——两种都收，@ 优先。
        const found = mentionsOf(value);
        const list = found.length > 0 ? found : value.split(/[\s,，、;；/]+/).filter((item) => item !== '');
        for (const item of list) {
          const clean = item.trim().slice(0, LIMITS.name);
          if (clean !== '' && !members.includes(clean)) members.push(clean);
        }
      }
      break;
    }
  }

  if (name === '') {
    name = '未命名团队';
    warnings.push('声明里没有「团队名称」，先用「未命名团队」占位');
  }
  if (owner === '') errors.push('声明里没有「团队负责人」——讨论需要一个主持人');
  if (members.length === 0) errors.push('声明里没有「团队成员」——一个只有群主的团队无法讨论');

  // 负责人同时出现在成员里是自然的写法（「团队负责人：@a」+「团队成员：@a@b」），
  // 不是错误：这里把它从成员列表里摘掉，免得群主给自己点名、同一个人算两个席位。
  const ownerIndex = members.indexOf(owner);
  if (ownerIndex >= 0) members.splice(ownerIndex, 1);

  if (errors.length > 0) return { ok: false, spec: undefined, errors, warnings };
  return {
    ok: true,
    spec: { name, owner, members, declaration: source.slice(0, LIMITS.declaration) },
    errors: [],
    warnings,
  };
}

/**
 * 判断一行是不是「点名」指令行，并解析出目标。
 * @param {string} body - 去掉行首符号后的正文。
 * @param {Set<string>} players - 团队成员（含群主）。
 * @returns {{kind:string,to:string[],reason:string}|undefined} 不是指令行时返回 undefined。
 */
function readDirectiveLine(body, players) {
  if (body === '') return undefined;
  // ⚠ 中文后面**不能写 \b**：JS 的 \b 只认 ASCII 单词字符，而汉字是「非单词字符」，
  // 所以 `@用户\b` 在「@用户」这种整行只有两个字的情况下永远不匹配——
  // 这一条真的踩过：群主的 @用户 / @等待 被当成「点名了一个不存在的人」。
  // 改用「后面不是汉字/字母数字」的前瞻：既拦得住「@等待我一下」这种半截话，也不误伤正常指令。
  const STOP = '(?![\\w\\u4e00-\\u9fff])';
  if (new RegExp(`^@?(?:用户|user)${STOP}`, 'i').test(body)) return { kind: 'user', to: [], reason: body };
  if (new RegExp(`^@?(?:等待|等任务|等汇报|等结果|等执行|wait)${STOP}`, 'i').test(body)) {
    return { kind: 'wait', to: [], reason: body };
  }
  if (/^@?(?:收尾|总结|散会|结束讨论|结束|结案|finalize|wrap\s*up)/i.test(body)) {
    return { kind: 'close', to: [], reason: body };
  }
  const found = mentionsOf(body).filter((mention) => players.has(mention));
  if (found.length > 0) return { kind: 'speak', to: found, reason: body };
  const unknown = mentionsOf(body);
  return {
    kind: 'invalid',
    to: [],
    reason: unknown.length > 0
      ? `点名的人不在团队里：${unknown.map((item) => `@${item}`).join(' ')}`
      : `这一行看不出要谁发言：${body.slice(0, 60)}`,
  };
}

/**
 * 从群主的发言里读「下一步」。
 *
 * 只看**最后 6 行非空行**，且只认三种形态：行首 `@名字`、行首 `@用户`/`@收尾`、
 * 或带显式标记（`【下一步】`、`→` 等）的行。这样「我同意 @研究员 的看法」这种正文
 * 里的提及不会被误当成调度指令——它既不在末尾、也不在行首。
 *
 * @param {string} text - 群主的发言。
 * @param {Iterable<string>} players - 团队成员（含群主）。
 * @returns {{kind:'speak'|'user'|'close'|'wait'|'missing'|'invalid',to:string[],reason:string,line:string}}
 */
export function parseDirective(text, players) {
  const names = players instanceof Set ? players : new Set(players ?? []);
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-6)
    .reverse();

  for (const raw of lines) {
    const base = raw.replace(LIST_PREFIX_RE, '');
    const marked = NEXT_MARKER_RE.test(base);
    const body = marked ? base.replace(NEXT_MARKER_RE, '').trim() : base;
    // 指令行只认三种：带显式标记、行首 @、或单独一行就是「@xxx」。
    if (!marked && !body.startsWith('@')) continue;
    const parsed = readDirectiveLine(body, names);
    if (parsed === undefined) continue;
    return { ...parsed, line: raw };
  }
  return { kind: 'missing', to: [], reason: '', line: '' };
}

/**
 * 一条发言渲染成记录里的一行。
 * @param {object} message - 群聊消息。
 * @param {number} perMessageChars - 单条截断上限。
 * @returns {string}
 */
function formatMessage(message, perMessageChars) {
  const text = String(message.text ?? '').trim();
  const clipped = text.length > perMessageChars ? `${text.slice(0, perMessageChars)}…（已截断）` : text;
  if (message.role === 'user') return `用户：${clipped}`;
  if (message.role === 'system') return `（系统）${clipped}`;
  const tag = message.role === 'owner' ? '（群主）' : '';
  return `@${message.speaker}${tag}：${clipped}`;
}

/**
 * 把群聊记录压成提示词里的一段。
 *
 * 从**最新往回**取：一场讨论里最近的几轮才是决定下一步的依据，
 * 开头的寒暄与自我介绍不该挤掉它们。超预算时明确写出省略了多少条，
 * 否则模型会以为那就是全部发言。
 *
 * @param {object[]} messages - 消息（按 seq 升序）。
 * @param {{maxChars?:number,perMessageChars?:number}} [options] - 预算。
 * @returns {string}
 */
export function renderTranscript(messages, options = {}) {
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 6000;
  const perMessageChars = Number.isSafeInteger(options.perMessageChars) && options.perMessageChars > 0
    ? options.perMessageChars
    : 400;
  const list = Array.isArray(messages) ? messages.filter((item) => item.role !== 'status') : [];
  if (list.length === 0) return '（还没有人发言）';

  const lines = [];
  let used = 0;
  let dropped = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const line = formatMessage(list[index], perMessageChars);
    if (lines.length > 0 && used + line.length > maxChars) {
      dropped = index + 1;
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  const head = dropped > 0 ? [`（更早的 ${dropped} 条发言因长度限制已省略）`] : [];
  return [...head, ...lines].join('\n');
}

/**
 * 群规——每一轮发言的提示词里都要原样带上一遍。
 *
 * 为什么不写进 agent 的 persona：persona 是用户在配置页给**单个子 agent** 写的，
 * 而群规是团队模式的行为约束（短、可争论、独立思考）。混在一起会让用户
 * 「调了 persona 却改了群聊行为」，也会让同一个 agent 在群里和群外表现不一致却没人知道为什么。
 *
 * @param {number} chars - 单条发言字数上限。
 * @returns {string[]}
 */
export function groupRules(chars) {
  return [
    '## 群规（每次发言都按它来）',
    `- **短**：一条发言不超过 ${chars} 字。只讲判断、依据、要谁做什么；不要复述别人、不要客套、不要长篇大论。`,
    '- **言之有物**：结论先行，理由紧随；没有新信息就直说「同意 @某人，无补充」。',
    '- **可以争论**：觉得站不住脚就直接反驳，指出它错在哪一步；一致不是目标，正确才是。',
    '- **第一性原理**：从事实、约束与目标出发推，不要从类比、惯例或「上次是这么做的」出发。',
    '- **独立思考**：别人赞同不能替代你的判断；别人的反对也不能。',
    '- 高内聚低耦合：每个角色只对自己那部分负责，接口（输入/产出）说清楚。',
  ];
}

//#endregion

//#region 服务：团队看板 + 讨论驱动

/**
 * 造团队看板（团队模式的宿主侧服务）。
 *
 * 依赖里 `tasks` 可以缺席（任务清单服务没装配时团队仍能讨论，只是无法固化分工）,
 * 缺席时所有与任务链有关的能力会明确报错，而不是静默失效。
 *
 * @param {{ctx:object,store:object,runtime:object,tasks?:object,config:object,log:object}} deps - 依赖。
 * @returns {object} 团队看板。
 */
export function createTeamBoard({ ctx, store, runtime, tasks, config, log }) {
  /** 订阅者（SSE 用）。 */
  const listeners = new Set();
  /** teamId → 正在跑的那条讨论循环。用它保证**每个团队同时只有一条**驱动链。 */
  const drivers = new Map();
  /**
   * teamId → 父 Agent **实例**（钉住）。
   *
   * 与 tasks.js 里那份同理：讨论要起子 agent，而起子 agent 需要一个**活着的** Agent 对象。
   * 主对话的回合结束后按 sessionId 往往查不到它，所以「谁给过一次有效的父 agent 就记住它」。
   * 只存内存：实例本来就不该被序列化，进程重启后自然退回按会话查找。
   */
  const parentRefs = new Map();
  /** 被显式叫停的团队（暂停/关闭）。驱动在每一步开头看它一眼就退出。 */
  const stopped = new Set();
  /** 已经汇报过的 runId（任务的完成/失败只该在群里通知一次）。 */
  const noticed = new Set();
  const NOTICED_LIMIT = 500;
  /**
   * teamId → 等这场讨论「停下来」的那些等待者。
   *
   * 它解决的是最要紧的一条链路：主对话调 `team_open` 之后**必须留在自己的回合里**，
   * 等群主把结论说完再一起带回去。所以这里给工具层一个可以 await 的「等到有结果为止」。
   * 用事件唤醒（而不是轮询）：每一次状态变化都会走 `emit`，那正是重新判断的时机。
   */
  const waiters = new Map();
  /**
   * 结论已经被带回主对话的团队 id（内存态，见 `markDelivered`）。
   * 它只用来决定提示词里要不要再提一遍「这个团队的结论还没被取走」。
   */
  const delivered = new Set();
  let runtimeUnsubscribe = undefined;
  let disposed = false;

  /** 哪些状态算「这场讨论暂时不会再自己往前走了」。 */
  const SETTLED_STATUSES = new Set(['closed', 'awaiting_user', 'paused', 'error']);

  /**
   * 广播「团队变了」，并叫醒等在它身上的那些等待者。
   * @param {string} teamId - 变化的团队。
   * @returns {void}
   */
  const emit = (teamId) => {
    for (const listener of listeners) {
      try {
        listener({ kind: 'team', teamId });
      } catch (error) {
        log.debug(`team listener failed: ${describeError(error)}`);
      }
    }
    notifyWaiters(teamId);
  };

  /**
   * 若这个团队已经停下，就把它的等待者全部唤醒。
   * @param {string} teamId - 团队 id。
   * @returns {void}
   */
  function notifyWaiters(teamId) {
    const set = waiters.get(teamId);
    if (set === undefined || set.size === 0) return;
    const team = store.getTeam(teamId);
    if (team !== undefined && SETTLED_STATUSES.has(team.status) !== true) return;
    for (const waiter of [...set]) {
      set.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(team);
    }
    waiters.delete(teamId);
  }

  /**
   * 等一场讨论停下来（或超时）。
   *
   * 「停下来」= closed / awaiting_user / paused / error —— 这四态都有一个共同点：
   * **不再有人会自动开口**。discussing 与 waiting_tasks 不算，那两种还会自己往前跑。
   *
   * @param {string} teamId - 团队 id。
   * @param {{timeoutMs?:number}} [options] - 等待上限。
   * @returns {Promise<object|undefined>} 停下时的团队；超时或团队不存在时 undefined。
   */
  const waitFor = (teamId, options = {}) => {
    const current = store.getTeam(teamId);
    if (current === undefined) return Promise.resolve(undefined);
    if (SETTLED_STATUSES.has(current.status)) return Promise.resolve(current);
    const raw = Number(options.timeoutMs);
    const timeoutMs = Number.isSafeInteger(raw) && raw > 0 ? raw : 15 * 60 * 1000;
    return new Promise((resolve) => {
      const set = waiters.get(teamId) ?? new Set();
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          set.delete(waiter);
          if (set.size === 0) waiters.delete(teamId);
          resolve(undefined);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      set.add(waiter);
      waiters.set(teamId, set);
    });
  };

  /**
   * 这场讨论现在是不是「停下来」的状态（closed / awaiting_user / paused / error）。
   *
   * 单独开一个方法而不是让工具层自己写一份状态表：`settled` 的语义必须只有一处定义，
   * 否则「等到了」与「已经停了」迟早会分叉，而分叉的表现就是主对话拿到一个空结论还以为谈完了。
   * @param {string} teamId - 团队 id。
   * @returns {boolean}
   */
  const isSettled = (teamId) => {
    const current = store.getTeam(teamId);
    return current !== undefined && SETTLED_STATUSES.has(current.status);
  };

  /**
   * 取群主的结论（「带回主对话」的就是它）。
   *
   * 定义写死在一处：**群里最后一条群主发言**。为什么不是「最后一条发言」——
   * 收尾之后还会进来系统通知（任务汇报、宿主提示），那之后群主并没有再说话；
   * 而结论恰恰是它最后那一段。没有任何群主发言时返回 undefined（如实说没有结论）。
   *
   * @param {string} teamId - 团队 id。
   * @returns {{text:string,speaker:string,at:number,seq:number}|undefined}
   */
  const conclusionOf = (teamId) => {
    const messages = store.listTeamMessages(teamId, { limit: 500 });
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'owner') continue;
      return { text: String(message.text ?? ''), speaker: message.speaker, at: message.createdAt, seq: message.seq };
    }
    return undefined;
  };

  /**
   * 把「这场讨论现在什么状态、结论是什么」打包给调用方（工具层用）。
   *
   * @param {string} teamId - 团队 id。
   * @param {{settled:boolean,timeoutMs:number}} meta - 等待结果。
   * @returns {object|undefined}
   */
  const report = (teamId, meta) => {
    const team = store.getTeam(teamId);
    if (team === undefined) return undefined;
    const conclusion = conclusionOf(teamId);
    const board = team.planId === '' || tasks === undefined ? undefined : tasks.board(team.planId, { full: false });
    const messages = store.listTeamMessages(teamId, { limit: 8 });
    const { messageChars } = limits();
    return {
      team,
      settled: meta.settled,
      timeoutMs: meta.timeoutMs,
      conclusion,
      plan: board === undefined ? undefined : {
        id: board.plan.id,
        title: board.plan.title,
        autoActivate: board.plan.autoActivate,
        progress: board.progress,
        next: board.next,
        tasks: board.tasks.map((task) => ({
          id: task.id, title: task.title, agent: task.agentName, state: task.state, deps: task.deps, runId: task.runId,
        })),
      },
      messages: messages.map((message) => ({
        seq: message.seq,
        role: message.role,
        speaker: message.speaker,
        kind: message.kind,
        overlong: message.overlong,
        text: String(message.text ?? '').slice(0, messageChars * 2),
      })),
    };
  };

  /** 读配置（测试可能给半份 config，所以每一项都兜底）。 */
  const limits = () => ({
    maxRounds: Number.isSafeInteger(config.teamMaxRounds) && config.teamMaxRounds > 0 ? config.teamMaxRounds : 3,
    messageChars: Number.isSafeInteger(config.teamMessageChars) && config.teamMessageChars > 0 ? config.teamMessageChars : 300,
    transcriptChars: Number.isSafeInteger(config.teamTranscriptChars) && config.teamTranscriptChars > 0
      ? config.teamTranscriptChars
      : 6000,
    maxNudges: Number.isSafeInteger(config.teamMaxNudges) && config.teamMaxNudges >= 0 ? config.teamMaxNudges : 1,
  });

  /**
   * 往群里写一条（并广播）。
   * @param {string} teamId - 团队。
   * @param {object} input - 消息字段。
   * @returns {object} 落库后的消息。
   */
  const post = (teamId, input) => {
    const message = store.insertTeamMessage({ teamId, ...input });
    emit(teamId);
    return message;
  };

  /** 系统发言（宿主自己的话，不是任何模型说的）。 */
  const notice = (teamId, text) => post(teamId, { role: 'system', speaker: '', text, kind: 'notice' });

  /**
   * 读一名成员在花名册里的实时状态。
   * @param {string} name - 成员名。
   * @param {object} snapshot - runtime.snapshot()。
   * @returns {object}
   */
  const playerInfo = (name, snapshot) => {
    const agent = store.getAgentByName(name);
    const run = (snapshot.runs ?? []).find((item) => item.agentName === name && item.busy === true);
    return {
      name,
      model: agent === undefined ? '' : `${agent.modelProvider}/${agent.modelId}`,
      configured: agent !== undefined,
      busy: run !== undefined,
      busyRunId: run?.runId ?? '',
      tokPerS: run?.tokPerS ?? 0,
      elapsedMs: run?.elapsedMs ?? 0,
    };
  };

  /** 安全取运行时快照。 */
  const snapshot = () => {
    try {
      return runtime.snapshot() ?? { runs: [] };
    } catch (error) {
      log.debug(`runtime.snapshot() failed: ${describeError(error)}`);
      return { runs: [] };
    }
  };

  /**
   * 读一个团队的完整视图（面板与工具都用它）。
   * @param {string} teamId - 团队 id。
   * @param {{since?:number,limit?:number}} [options] - 消息读取选项。
   * @returns {object|undefined}
   */
  const stateOf = (teamId, options = {}) => {
    const team = store.getTeam(teamId);
    if (team === undefined) return undefined;
    const messages = store.listTeamMessages(teamId, options);
    const snap = snapshot();
    const players = [
      { name: team.ownerName, role: 'owner' },
      ...team.members.map((name) => ({ name, role: 'member' })),
    ].filter((item) => item.name !== '').map((item) => ({ ...item, ...playerInfo(item.name, snap) }));

    let plan = null;
    if (team.planId !== '' && tasks !== undefined) {
      const board = tasks.board(team.planId, { full: false });
      if (board !== undefined) {
        plan = {
          id: board.plan.id,
          title: board.plan.title,
          autoActivate: board.plan.autoActivate,
          progress: board.progress,
          next: board.next,
          tasks: board.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            agentName: task.agentName,
            state: task.state,
            deps: task.deps,
            // runId 跟着一起给：面板上点一个任务就能跳到那次运行的会话原文——
            // 「他到底怎么干的」是团队模式里最常被追问的事。
            runId: task.runId,
          })),
        };
      }
    }

    return {
      team,
      messages,
      players,
      plan,
      lastSeq: store.lastTeamSeq(teamId),
      teamMode: store.isTeamMode(),
      serverNow: Date.now(),
    };
  };

  /**
   * SSE 每秒推的精简视图：只够面板画出「哪个团队、谁在说、有多少条」，
   * 正文由面板按需增量拉（`/team/<id>?since=`）。
   * @returns {object}
   */
  const summary = () => {
    const teams = store.listTeams({ limit: 20 });
    let ownersLine = 0;
    const list = teams.map((team) => {
      const lastSeq = store.lastTeamSeq(team.id);
      let last = '';
      // 只有前 8 个团队带「最后一句」：一个每秒跑一次的帧不该为了列表的美观去扫全表。
      if (ownersLine < 8 && lastSeq > 0) {
        ownersLine += 1;
        const tail = store.listTeamMessages(team.id, { limit: 1 });
        last = String(tail[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
      }
      return {
        id: team.id,
        name: team.name,
        ownerName: team.ownerName,
        members: team.members,
        mission: team.mission.slice(0, 160),
        status: team.status,
        phase: team.phase,
        speaker: team.speaker,
        rounds: team.rounds,
        maxRounds: team.maxRounds,
        planId: team.planId,
        lastSeq,
        last,
        lastError: team.lastError,
        updatedAt: team.updatedAt,
        createdAt: team.createdAt,
      };
    });
    return {
      teams: list,
      total: list.length,
      teamMode: store.isTeamMode(),
      active: list.filter((item) => item.status === 'discussing' || item.status === 'awaiting_user' || item.status === 'waiting_tasks').length,
      planning: list.filter((item) => item.status === 'discussing').length,
    };
  };

  /**
   * 解析团队声明并核对花名册。
   * @param {string} declaration - 用户原文里的三行。
   * @returns {{ok:boolean,spec:object|undefined,errors:string[],warnings:string[]}}
   */
  const resolveSpec = (declaration) => {
    const parsed = parseTeamDeclaration(declaration);
    if (!parsed.ok) return parsed;
    const known = new Set(store.listAgents().map((agent) => agent.name));
    const unknown = [parsed.spec.owner, ...parsed.spec.members].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        spec: undefined,
        errors: [
          `声明里的人没有配置成子 agent：${[...new Set(unknown)].map((name) => `@${name}`).join('、')}`,
          `已配置的是：${[...known].join('、') || '（一个都没有）'}`,
        ],
        warnings: parsed.warnings,
      };
    }
    return parsed;
  };

  /**
   * 开一个团队。
   *
   * @param {object} input - `{declaration, mission, parentSessionId, parentAgent, invokedBy, autoStart}`。
   * @returns {{ok:boolean, team?:object, errors?:string[], warnings?:string[]}}
   */
  const open = (input = {}) => {
    if (!store.isTeamMode()) {
      return {
        ok: false,
        errors: ['团队模式没有打开：请让用户把输入栏那一行的「团队模式」切到「开」'],
      };
    }
    const parsed = resolveSpec(input.declaration ?? '');
    if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };

    const { maxRounds } = limits();
    const team = store.insertTeam({
      name: parsed.spec.name,
      ownerName: parsed.spec.owner,
      members: parsed.spec.members,
      mission: String(input.mission ?? '').slice(0, LIMITS.mission),
      declaration: parsed.spec.declaration,
      parentSessionId: String(input.parentSessionId ?? ''),
      maxRounds,
    });
    if (input.parentAgent !== undefined) parentRefs.set(team.id, input.parentAgent);
    log.info(`团队「${team.name}」已建立（${team.id}）：群主 @${team.ownerName}，成员 ${team.members.map((name) => `@${name}`).join(' ') || '（无）'}`);
    notice(team.id, `团队「${team.name}」已建立。群主：@${team.ownerName}；成员：${team.members.map((name) => `@${name}`).join(' ') || '（无）'}。使命：${team.mission === '' ? '（未说明）' : team.mission}`);
    emit(team.id);

    if (input.autoStart === false) return { ok: true, team, warnings: parsed.warnings };
    // 没有父 agent 也没有父会话：讨论在第一次发言时必然中断（`startSpeak` 定位不到父 agent），
    // 而那时错误只能落在团队的 status 上——调用方拿到的是一句没有原因的「状态 error」。
    // 所以这里直接不起循环，把原因同步说清楚。
    if (input.parentAgent === undefined && String(input.parentSessionId ?? '').trim() === '') {
      const reason = '讨论没有开始：这次调用既没有父会话 id、也没有父 agent；团队讨论必须有一个活着的父会话。';
      log.warn(`团队「${team.name}」建立但没有开聊：缺父会话与父 agent`);
      notice(team.id, reason);
      emit(team.id);
      return { ok: true, team: store.getTeam(team.id), warnings: parsed.warnings, startError: reason };
    }
    const started = start(team.id, { parentAgent: input.parentAgent, invokedBy: input.invokedBy ?? 'tool' });
    return { ok: true, team: store.getTeam(team.id), warnings: parsed.warnings, startError: started.ok ? '' : started.error };
  };

  /**
   * 起/继续一场讨论。
   * @param {string} teamId - 团队。
   * @param {{parentAgent?:object, parentSessionId?:string, invokedBy?:string}} [options] - 选项。
   * @returns {{ok:boolean, error?:string}}
   */
  const start = (teamId, options = {}) => {
    const team = store.getTeam(teamId);
    if (team === undefined) return { ok: false, error: `没有这个团队：${teamId}` };
    if (team.status === 'closed') return { ok: false, error: `团队「${team.name}」已经收尾了；要接着讨论请重建一个团队` };
    if (!store.isTeamMode()) return { ok: false, error: '团队模式已关闭：先在输入栏把它打开' };
    if (options.parentAgent !== undefined) parentRefs.set(teamId, options.parentAgent);
    // 补记父会话。这不只是「修历史遗留」：面板点「继续」的那一刻**知道**自己在哪个会话里，
    // 而宿主按会话查活动 agent 未必查得到（重启过、或会话尚未在本进程打开）。
    // 团队卡在「找不到父会话」时，这就是唯一能把它救回来的来源。
    const sessionId = typeof options.parentSessionId === 'string' ? options.parentSessionId.trim() : '';
    if (sessionId !== '' && sessionId !== team.parentSessionId) {
      store.updateTeam(teamId, { parentSessionId: sessionId });
      log.info(`团队「${team.name}」的父会话补记为 ${sessionId}`);
    }
    stopped.delete(teamId);
    store.updateTeam(teamId, { status: 'discussing', lastError: '' });
    emit(teamId);
    pump(teamId);
    return { ok: true };
  };

  /**
   * 暂停讨论（运行中的那一次发言会跑完再停）。
   * @param {string} teamId - 团队。
   * @param {string} reason - 说给用户听的原因。
   * @returns {{ok:boolean, error?:string}}
   */
  const pause = (teamId, reason = '已暂停：用户点了暂停') => {
    const team = store.getTeam(teamId);
    if (team === undefined) return { ok: false, error: `没有这个团队：${teamId}` };
    stopped.add(teamId);
    store.updateTeam(teamId, { status: 'paused', speaker: '' });
    notice(teamId, reason);
    emit(teamId);
    return { ok: true };
  };

  /**
   * 收尾：讨论结束，不再自动发言。
   * @param {string} teamId - 团队。
   * @param {string} reason - 结束语。
   * @returns {{ok:boolean, error?:string}}
   */
  const close = (teamId, reason = '讨论已收尾。') => {
    const team = store.getTeam(teamId);
    if (team === undefined) return { ok: false, error: `没有这个团队：${teamId}` };
    stopped.add(teamId);
    store.updateTeam(teamId, { status: 'closed', phase: 'done', speaker: '', queue: [], closedAt: Date.now() });
    notice(teamId, reason);
    emit(teamId);
    return { ok: true };
  };

  /**
   * 把话语权交给某个人（默认排在队尾）。
   *
   * 为什么是队尾而不是队首：群主可能一次点了几个人（「@研究员 @工程师 各说一句」），
   * 那是一个**有序议程**；每说完一个就把群主插到最前面，等于把议程打散成
   * 「群主对每个人都单独回应一遍」，既费轮次又容易让第二个人的问题被忘掉。
   * 排在队尾的效果是：议程走完 → 话语权自然回到群主。
   * @param {object} team - 团队记录。
   * @param {string} name - 点名。
   * @returns {string[]} 落库后的队列。
   */
  const enqueue = (team, name) => {
    const queue = team.queue.filter((item) => item !== name);
    queue.push(name);
    store.updateTeam(team.id, { queue });
    return queue;
  };

  /**
   * 往群里说一句。
   *
   * 成员发言之后**自动把话语权交回群主**：这是「轮流制 + 群主主导发言人」的落点。
   * 成员之间不接龙，因为「下一个该谁说」需要有人对全局负责。
   *
   * @param {object} input - `{teamId, role, speaker, text, kind, runId, runStatus, notifyOwner}`。
   * @returns {{ok:boolean, message?:object, error?:string}}
   */
  const say = (input = {}) => {
    const team = store.getTeam(String(input.teamId ?? ''));
    if (team === undefined) return { ok: false, error: `没有这个团队：${input.teamId}` };
    const text = String(input.text ?? '').trim();
    if (text === '') return { ok: false, error: '发言内容不能为空' };
    const { messageChars } = limits();
    const role = ['owner', 'member', 'user', 'system'].includes(input.role) ? input.role : 'member';
    const message = post(team.id, {
      role,
      speaker: String(input.speaker ?? ''),
      text,
      kind: MESSAGE_KINDS.includes(input.kind) ? input.kind : 'chat',
      overlong: text.length > messageChars,
      runId: String(input.runId ?? ''),
      runStatus: String(input.runStatus ?? ''),
    });

    const wantsOwner = input.notifyOwner !== false && role === 'member';
    // 成员开口（汇报/求助）就该把群主叫醒——包括它正挂着等任务的时候：
    // 「执行中碰到问题 @群主」如果不能在那一刻打断等待，这条约定就是空的。
    if (wantsOwner && (team.status === 'discussing' || team.status === 'waiting_tasks')) {
      store.updateTeam(team.id, { status: 'discussing' });
      enqueue(store.getTeam(team.id) ?? team, team.ownerName);
      emit(team.id);
      pump(team.id);
    }
    return { ok: true, message };
  };

  /**
   * 用户亲自在群里说话（面板里的输入框）。
   *
   * 如果群主正在等用户拍板（`awaiting_user`），这一句就是把讨论**接着往下推**的信号：
   * 话语权回到群主，状态回到「讨论中」。用户没说、群主也没点名的空白期不会自己往前走。
   *
   * @param {string} teamId - 团队。
   * @param {string} text - 用户的话。
   * @returns {{ok:boolean, message?:object, error?:string}}
   */
  const userSay = (teamId, text) => {
    const team = store.getTeam(teamId);
    if (team === undefined) return { ok: false, error: `没有这个团队：${teamId}` };
    const said = say({ teamId, role: 'user', speaker: '用户', text, notifyOwner: false });
    if (!said.ok) return said;
    const fresh = store.getTeam(teamId) ?? team;
    // 收尾之后的插话只留档，不重新开张：那会变成一场没人预期的讨论。
    if (fresh.status === 'closed') {
      emit(teamId);
      return said;
    }
    // 用户说话 = 话语权回到群主。这也正是「群主 @用户 等你拍板」的解锁动作。
    if (fresh.status !== 'discussing') {
      stopped.delete(teamId);
      store.updateTeam(teamId, { status: 'discussing' });
    }
    enqueue(store.getTeam(teamId) ?? fresh, fresh.ownerName);
    emit(teamId);
    pump(teamId);
    return said;
  };

  /**
   * 群主把分工固化成一条任务链（`team_task` 工具的落点）。
   *
   * 为什么由宿主建链而不是让群主直接调 `subagent_plan`：`subagent_plan` 的父会话
   * 取自**工具调用身份**，而群主自己跑在一个子会话里——那样建出来的链会把「父会话」
   * 指向子会话，下游任务的激活与面板归属都会跟着歪。这里显式用团队的父会话，
   * 并在建链前把群规注入每条任务说明。
   *
   * @param {string} teamId - 团队。
   * @param {object} input - `{title, note, tasks}`。
   * @param {{invokedBy?:string}} [meta] - 来源。
   * @returns {{ok:boolean, board?:object, started?:object[], errors?:string[]}}
   */
  const planTasks = (teamId, input = {}, meta = {}) => {
    const team = store.getTeam(teamId);
    if (team === undefined) return { ok: false, errors: [`没有这个团队：${teamId}`] };
    if (tasks === undefined) return { ok: false, errors: ['任务清单服务不可用：本次启动没有装配它'] };
    if (team.status === 'closed') {
      return { ok: false, errors: ['团队已收尾：要再派人干活请让用户重新声明一个团队，或由主对话直接建清单'] };
    }

    const allowed = new Set([team.ownerName, ...team.members]);
    const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
    if (rawTasks.length === 0) return { ok: false, errors: ['tasks 不能为空：至少要有一项任务'] };
    const outsiders = [];
    for (const [index, task] of rawTasks.entries()) {
      const who = String(task?.agent ?? task?.agentName ?? '').trim();
      if (who !== '' && !allowed.has(who)) outsiders.push(`第 ${index + 1} 项的「${who}」`);
    }
    if (outsiders.length > 0) {
      return {
        ok: false,
        errors: [
          `这些执行人不在团队里：${outsiders.join('、')}`,
          `团队成员是：${[...allowed].map((name) => `@${name}`).join(' ')}。团队任务只能派给自己人。`,
        ],
      };
    }

    // 任务 id：给了就用；没给就**接着已有编号往后排**。
    // 这一步必须自己做：`validatePlanDraft` 的自动编号是「本批内第几项」，追加两次就会撞上
    // 已有的 t1（复合主键会直接抛错），而依赖也靠 id 指认、撞了就是错链。
    const existing = team.planId === '' ? [] : store.listTasks(team.planId);
    const used = new Set(existing.map((task) => task.id));
    let next = 1;
    const decoratedTasks = rawTasks.map((task) => {
      const spec = {
        ...task,
        brief: decorateBrief(String(task?.brief ?? ''), team, limits().messageChars),
      };
      const given = String(task?.id ?? '').trim();
      if (given !== '') {
        used.add(given);
        return { ...spec, id: given };
      }
      while (used.has(`t${next}`)) next += 1;
      const id = `t${next}`;
      used.add(id);
      next += 1;
      return { ...spec, id };
    });

    // 「派发」这件事本身是**可以反复发生**的：讨论中想到第一批就先派出去，
    // 拿到汇报后再追加下一批（`team_task` 的第二、三次调用就是续派）。
    const isAppend = team.planId !== '';
    const result = isAppend
      ? tasks.appendTasks(team.planId, { tasks: decoratedTasks }, {
        parentAgent: parentRefs.get(teamId),
        invokedBy: meta.invokedBy ?? 'team',
      })
      : tasks.createPlan({
        title: String(input.title ?? '').trim() === '' ? `团队「${team.name}」的任务链` : input.title,
        note: String(input.note ?? '').slice(0, 2000),
        // 团队模式固定启用任务链：这里**硬写 true**，不看用户的 taskAutoActivate。
        autoActivate: true,
        tasks: decoratedTasks,
      }, {
        parentSessionId: team.parentSessionId,
        parentAgent: parentRefs.get(teamId),
        invokedBy: meta.invokedBy ?? 'team',
      });
    if (!result.ok) return { ok: false, errors: result.errors, board: result.board };

    const planId = result.board?.plan?.id ?? team.planId;
    store.updateTeam(teamId, { planId, phase: 'execute' });
    const dispatchedIds = new Set(decoratedTasks.map((task) => task.id));
    const dispatched = (result.board?.tasks ?? []).filter((task) => dispatchedIds.has(task.id));
    const lines = dispatched.map((task) => `${task.id}「${task.title}」→ @${task.agentName}（${task.state}）`);
    post(teamId, {
      role: 'system',
      speaker: '',
      kind: 'notice',
      text: `${isAppend ? '追加派发到' : '已派发'}任务链 ${planId}（团队模式：固定自动激活）：${lines.join('；')}`
        + (result.error ? `。注意：${result.error}` : ''),
    });
    emit(teamId);
    log.info(`团队「${team.name}」${isAppend ? '追加' : '建立'}任务链 ${planId}：${dispatched.length} 项（启动 ${(result.started ?? []).length} 项）`);
    return { ok: true, board: result.board, started: result.started ?? [], errors: [], appended: isAppend };
  };

  /**
   * 把任务链的现状渲染成一段文字（群主据此判断「要不要调整、还差谁」）。
   *
   * 为什么必须给群主看**真实的任务状态**而不是让它自己回忆：它每轮都是新的一次调用，
   * 上一轮它派了什么、跑到哪一步，只有这张表说了算。没有这段，它会重复派活或者以为活干完了。
   * @param {object} team - 团队。
   * @returns {string}
   */
  const chainText = (team) => {
    if (tasks === undefined) return '（任务清单服务不可用：这次讨论没法派活）';
    if (team.planId === '') return '（还没有任务链：想让人动手就直接用 team_task 派发）';
    const board = tasks.board(team.planId, { full: false });
    if (board === undefined) return `（任务链 ${team.planId} 已经不在了）`;
    const rows = board.tasks.map((task) => {
      const extra = task.state === 'blocked' && task.blockedBy.length > 0
        ? `（被 ${task.blockedBy.join('、')} 卡住）`
        : (task.state === 'waiting' && task.waitingFor.length > 0 ? `（等 ${task.waitingFor.join('、')}）` : '');
      return `- ${task.id}「${task.title}」@${task.agentName}｜${task.state}${extra}${task.note === '' ? '' : `｜${task.note}`}`;
    });
    return [
      `任务链 ${board.plan.id}｜进度 ${board.progress.done}/${board.progress.total}`
      + `（运行中 ${board.progress.active}，就绪 ${board.progress.ready}，被卡 ${board.progress.blocked}，失败 ${board.progress.failed}）`,
      ...rows,
      board.next === '' ? '' : `下一步：${board.next}`,
    ].filter((line) => line !== '').join('\n');
  };

  /**
   * 把群规与求助方式写进任务说明。
   *
   * 这是「成员执行任务时碰到任何情况要 @群主、完成时也要通知群主」的**第一道保险**：
   * 它是提示词层面的话。第二道保险在 `#onRunFrame`：任务结算时宿主自己往群里发一条
   * 完成/失败通知——因为「模型没照做」是可预期的事，不能把协作的关键动作押在它身上。
   * @param {string} brief - 原任务说明。
   * @param {object} team - 团队。
   * @param {number} chars - 发言字数上限。
   * @returns {string}
   */
  const decorateBrief = (brief, team, chars) => [
    `【团队群协议｜团队：${team.name}｜群主：@${team.ownerName}】`,
    `你是这个团队的成员，正在执行团队任务链里的一项。团队群 id：${team.id}`,
    `- 群里发言要短（一条 ≤ ${chars} 字），只讲结论与依据，不要长篇大论。`,
    `- **完成时**：立刻用 team_say 向 @${team.ownerName} 汇报（一句话结论 + 产物位置 + 还需要什么）。`,
    `- **碰到任何情况**（阻塞、歧义、风险、需要别人配合、发现方案本身有问题）：立刻用 team_say @${team.ownerName} 请求处理，不要自己猜着往下做。`,
    '- 保持独立思考：不同意就直说，不要因为别人赞同就附和。',
    '',
    '【你的任务】',
    brief,
  ].join('\n');

  /**
   * 拼一次发言的提示词。
   * @param {object} team - 团队。
   * @param {string} speaker - 发言人。
   * @param {string} mode - 'open' | 'react' | 'finalize' | 'remedy' | 'member'。
   * @param {string} transcript - 群聊记录。
   * @returns {string}
   */
  const composePrompt = (team, speaker, mode, transcript) => {
    const { messageChars } = limits();
    const isOwner = speaker === team.ownerName;
    const head = isOwner
      ? `# 你是「${team.name}」的群主（负责人）：@${speaker}`
      : `# 你是「${team.name}」的成员：@${speaker}`;
    const roster = `- @${team.ownerName}（群主）\n${team.members.map((name) => `- @${name}`).join('\n')}`;

    const duty = [];
    if (isOwner) {
      duty.push(
        '## 你的职责',
        '你既是主持人，也是**派活的人**：谁下一个发言由你定，活也由你派下去。成员之间不接龙——每次都回到你这里。',
        '讨论和执行是**同一场会**：`team_task` 派出去的任务会立刻开跑（没依赖的马上跑，有依赖的等上游），',
        '任务跑完或出事时，宿主会把汇报发到群里并叫你回来处理。所以你可以边谈边派，不必等讨论结束。',
        '',
        '**结论要送回主对话**：主对话一直等在这场讨论上（它调 `team_open` 时不许提前收尾）。',
        '你在收尾前调一次 `team_report`（text 传结论本身）把方案直接投回主对话；',
        '即使投递失败，主对话也会从 `team_open` 的返回值里拿到你的最后一段发言——',
        '所以**最后那段必须写成能独立看懂的结论**，不要写成「详见上文」。',
        '',
        '你的发言最后**必须单独一行**给出下一步指令（三种之一）：',
        `- \`@${team.members[0] ?? '成员'}\`：把话交给他（也可以在一行里点多人，按顺序逐个发言）`,
        '- `@用户`：需要用户拍板才能继续（说明要他决定什么）',
        '- `@等待`：活已经派出去了，你要等它们跑完再继续（链上没有在跑的任务时不要用这条）',
        '- `@收尾`：讨论已经足够，结束讨论并给出总结',
        '没给出指令的话，会有人提醒你补一行——那会浪费一整轮。',
        '',
      );
      if (mode === 'open') {
        duty.push(
          '## 这一轮（开场）',
          '用三到五句话说清你的判断：这件事的关键在哪里、该怎么拆、谁适合哪一段、风险是什么。',
          '**只要能确定第一批该做什么，就直接用 `team_task` 把它派出去**（不必等讨论结束）——先让能动手的人动起来。',
          '然后点名一到两位成员表态或补位。',
          '如果现在信息还不足以派活，就只点名讨论，下一轮再派。',
        );
      } else if (mode === 'finalize') {
        duty.push(
          '## 这一轮：收尾（轮次已到上限，必须结束讨论）',
          '把还没派下去的分工用 `team_task` 补齐（成员名必须来自上面花名册；每项写清产出与依赖），',
          '然后调 **`team_report`** 把这轮的结论投回主对话，',
          '最后给出**最终总结**：目标、方案、分工、风险与验收标准（这段会作为结论原文送到主对话）。',
          '最后一行写 `@收尾`。还有任务在跑也没关系——它们跑完的汇报仍会出现在群里。',
          '如果确实卡在用户身上才能定案，写 `@用户` 并说明要决定什么。',
        );
      } else if (mode === 'remedy') {
        duty.push(
          '## 这一轮：补指令',
          '你上一条发言没有给出「下一步」。现在**只回一行**：`@名字` / `@用户` / `@收尾`，不要写别的。',
        );
      } else {
        duty.push(
          '## 这一轮',
          '结合「执行现状」和刚发生的发言，做三件事里的任意几件：',
          '1) 判断谁的说法站得住、哪里还需要澄清；',
          '2) **调整派活**——发现新的工作就用 `team_task` 追加派发（同一条链上续派），发现派错了就说明怎么改；',
          '3) 点名下一位发言，或者收尾。',
          '分歧消掉且活都派下去了，就直接给结论并 `@收尾`。',
        );
      }
    } else {
      duty.push(
        '## 你的职责',
        '围绕群主的议题给出**你自己的**判断：同意还是反对、理由是什么、你建议怎么做。',
        '你可能会被派到具体任务（见「执行现状」里属于你的那几行）：那些是 `team_task` 派下来的活，',
        '会被单独启动，不需要你在这里开始做；这里只讨论——但如果任务说明有问题，现在就要指出来。',
        '**不要为了「汇报自己说过了」再调一次 `team_say`**：你在这里的发言本身就是汇报，',
        '再说一句「已进群」只会多花一次调用、把群聊记录撑长（真机上两位成员都这么干了一次）。',
        '`team_say` 是留给「执行任务时的完成汇报与求助」的。',
        '如果你被问到的问题超出你的知识或工具能力，直接说不确定，并说需要谁来补。',
        '结尾不需要点名，话语权会自动回到群主。',
      );
    }

    return [
      head,
      `团队使命：${team.mission === '' ? '（用户没有单独说明，见群聊记录里的第一条）' : team.mission}`,
      '',
      ...groupRules(messageChars),
      '',
      '## 团队花名册',
      roster,
      '',
      '## 执行现状',
      chainText(team),
      '',
      ...duty,
      '',
      '## 群聊记录（最近）',
      transcript,
      '',
      '（现在轮到你发言。直接输出发言内容，不要写「以下是发言」之类的前言。）',
    ].join('\n');
  };

  /**
   * 起一次发言运行。
   * @param {object} team - 团队。
   * @param {string} speaker - 发言人。
   * @param {string} prompt - 提示词。
   * @returns {{ok:true,runId:string}|{ok:false,error:string,kind?:string}}
   */
  const startSpeak = (team, speaker, prompt) => {
    const agent = store.getAgentByName(speaker);
    if (agent === undefined) {
      return { ok: false, error: `团队成员「${speaker}」不存在（可能被归档或改名了）`, kind: 'missing-agent' };
    }
    const busy = (snapshot().runs ?? []).find((run) => run.agentName === speaker && run.busy === true);
    if (busy !== undefined) {
      // 同一个 agent 无法同时开两场运行（DSH 侧的硬约束）。这种情况完全可能发生：
      // 群主一边主持、一边在跑它自己的任务。**等**而不是失败，因为它是暂时的。
      return {
        ok: false,
        kind: 'busy',
        error: `@${speaker} 正在忙（run ${busy.runId}，已跑 ${Math.round((busy.elapsedMs ?? 0) / 1000)}s）`,
      };
    }
    let parentAgent = parentRefs.get(team.id);
    if (parentAgent === undefined) {
      const resolved = runtime.resolveParent(team.parentSessionId);
      parentAgent = resolved.agent;
      if (parentAgent === undefined) {
        return { ok: false, kind: 'no-parent', error: `找不到团队的父会话：${resolved.error}` };
      }
      parentRefs.set(team.id, parentAgent);
    }
    const result = runtime.start({
      agent,
      prompt,
      parentAgent,
      parentSessionId: team.parentSessionId,
      taskKey: '',
      roundId: null,
      invokedBy: 'team',
    });
    if (!result.ok) return { ok: false, kind: 'start-failed', error: result.error };
    return { ok: true, runId: result.run.id };
  };

  /**
   * 处理群主给出的指令。
   * @param {object} team - 团队（最新）。
   * @param {object} message - 刚记录下的群主发言。
   * @returns {void}
   */
  const applyDirective = (team, message) => {
    const players = new Set([team.ownerName, ...team.members]);
    const directive = parseDirective(message.text, players);
    const { maxNudges } = limits();
    /**
     * 提醒一次，然后按已有内容收尾。
     *
     * 这个「上限」是驱动循环的**第二道终止保证**（第一道是轮次上限）：
     * 只要有一条路径能「提醒 → 再提醒」，就会有一条路径能永远转下去——
     * 而每一圈都是真实花费。所以下面每一处「不能继续」都走这个函数。
     * @param {string} text - 协议提示正文。
     * @returns {void}
     */
    const nudgeOrFinish = (text) => {
      const nudges = team.nudges + 1;
      if (nudges > maxNudges) {
        finish(team, `群主连续 ${nudges} 次没有给出可执行的下一步，讨论按目前的内容结束。要接着谈就再说一句。`);
        return;
      }
      store.updateTeam(team.id, { nudges, queue: [team.ownerName] });
      notice(team.id, text);
    };

    if (directive.kind === 'speak') {
      // 只收团队成员进队列；群主点到自己等于「我接着补充」，队列留空 → 下一棒仍是群主。
      const queue = directive.to.filter((name) => team.members.includes(name));
      // 已经派过活的团队不因为「又要说两句」就退回讨论阶段——链还在跑，那会是一句谎话。
      store.updateTeam(team.id, { queue, phase: team.phase === 'execute' ? 'execute' : 'discuss', nudges: 0 });
      return;
    }
    if (directive.kind === 'user') {
      store.updateTeam(team.id, { status: 'awaiting_user', queue: [], phase: 'discuss', nudges: 0 });
      notice(team.id, `@用户 群主需要你介入：${directive.reason.slice(0, 200)}`);
      return;
    }
    if (directive.kind === 'wait') {
      // 群主派完活、要等结果才继续：把讨论挂起，等任务结算时由宿主把话语权还给它。
      // 但「等」必须真的有事可等——否则这场会就无声地死在这里了。
      const board = team.planId === '' || tasks === undefined
        ? undefined
        : tasks.board(team.planId, { full: false });
      const pending = board === undefined ? 0 : Number(board.progress.active ?? 0) + Number(board.progress.ready ?? 0);
      if (pending === 0) {
        nudgeOrFinish(
          '（协议提示）你说要等任务，但链上现在**没有在跑、也没有就绪**的任务——这样会一直等下去。'
          + '请改为：先派活（team_task），或点名 `@名字`、`@用户`、`@收尾`。',
        );
        return;
      }
      store.updateTeam(team.id, { status: 'waiting_tasks', queue: [], phase: 'execute', nudges: 0 });
      notice(team.id, `群主在等执行结果：链上还有 ${pending} 项任务在跑或就绪，跑完会把汇报送到这里。`);
      return;
    }
    if (directive.kind === 'close') {
      finish(team, '群主已收尾，讨论结束。');
      return;
    }
    // 没给出指令：提醒一次；提醒过了还是不给，就当讨论到这儿（不能无限空转）。
    nudgeOrFinish(
      `（协议提示）上一条没有给出下一步指令${directive.reason === '' ? '' : `：${directive.reason}`}。请用最后一行点名：@名字 / @用户 / @收尾。`,
    );
  };

  /**
   * 收尾（并如实交代有没有留下任务链）。
   * @param {object} team - 团队。
   * @param {string} reason - 结束语。
   * @returns {void}
   */
  const finish = (team, reason) => {
    const fresh = store.getTeam(team.id) ?? team;
    let closing = reason;
    if (fresh.planId === '') {
      // 收尾不等于「事情安排好了」：没有任务链就等于这场会只产出了讨论。
      // 这句话并进收尾那条系统发言里，而不是再发一条——两条连着说同一件事只会让人划得更快。
      closing += '\n（系统）这个团队**没有建立任务链**：如果结论里有要执行的事，'
        + '请让主对话建清单，或让群主在收尾前用 team_task 把分工定下来。';
    } else if (tasks !== undefined) {
      // 收尾不等于活干完了：如实报一下链上的账，否则「讨论结束了」会被读成「事情做完了」。
      const board = tasks.board(fresh.planId, { full: false });
      if (board !== undefined) {
        const progress = board.progress;
        closing += `\n（系统）收尾时的任务链 ${board.plan.id}：进度 ${progress.done}/${progress.total}`
          + `（运行中 ${progress.active}，就绪 ${progress.ready}，等待 ${progress.waiting}，被卡 ${progress.blocked}，失败 ${progress.failed}）。`
          + '还在跑的任务跑完或出事时，汇报仍会发到这个群里。';
      }
    }
    close(team.id, closing);
  };

  /**
   * 讨论循环。
   *
   * 串行、单驱动（`drivers` 里每个团队只有一条）。每一步：
   *  选发言人 → 起运行 → 等它落地 → 记录发言 → 处理指令/把话语权交回群主。
   *
   * 为什么把「等它落地」写在这里而不是靠运行时事件：事件的顺序与去重都要自己维护，
   * 而 `runtime.waitFor` 已经是官方的「等一次运行走到终态」。顺序执行 = 轮流制。
   *
   * @param {string} teamId - 团队。
   * @returns {Promise<void>}
   */
  const drive = async (teamId) => {
    for (;;) {
      if (disposed) return;
      const team = store.getTeam(teamId);
      if (team === undefined) return;
      if (stopped.has(teamId)) return;
      if (team.status !== 'discussing') return;

      const players = new Set([team.ownerName, ...team.members]);
      const queue = team.queue.filter((name) => players.has(name));
      const speaker = queue.length > 0 ? queue.shift() : team.ownerName;
      store.updateTeam(teamId, { queue });

      const isOwner = speaker === team.ownerName;
      const rounds = isOwner ? team.rounds + 1 : team.rounds;
      // 轮次上限：群主的第 maxRounds 次发言就是收尾轮（含开场那一次），说完就结束讨论。
      // 这条是**必然终止**的保证：不靠模型自觉收尾，靠轮次算出来。
      const mode = !isOwner
        ? 'member'
        : (team.turns === 0 ? 'open' : (team.rounds + 1 >= team.maxRounds ? 'finalize' : (team.nudges > 0 ? 'remedy' : 'react')));

      const { transcriptChars, messageChars } = limits();
      const transcript = renderTranscript(store.listTeamMessages(teamId), {
        maxChars: transcriptChars,
        perMessageChars: messageChars + Math.floor(messageChars / 2),
      });
      const prompt = composePrompt(team, speaker, mode, transcript);

      const started = startSpeak(team, speaker, prompt);
      if (!started.ok) {
        if (started.kind === 'busy') {
          // 忙是暂时的：暂停而不是判死，用户点「继续」就能接着走。
          pause(teamId, `@${speaker} 正在忙（${started.error}）。讨论已暂停，等它跑完点「继续」。`);
          return;
        }
        store.updateTeam(teamId, { status: 'error', speaker: '', lastError: started.error });
        notice(teamId, `讨论中断：${started.error}`);
        emit(teamId);
        log.warn(`团队 ${teamId} 讨论中断：${started.error}`);
        return;
      }

      store.updateTeam(teamId, {
        speaker,
        turns: team.turns + 1,
        rounds,
      });
      emit(teamId);

      const settled = await runtime.waitFor(started.runId);
      if (disposed) return;
      const fresh = store.getTeam(teamId);
      if (fresh === undefined) return;
      if (stopped.has(teamId)) return;

      const text = contentToText(settled?.output ?? '').trim();
      const status = String(settled?.status ?? 'unknown');
      const record = post(teamId, {
        role: isOwner ? 'owner' : 'member',
        speaker,
        text: text === '' ? '（没有输出）' : text,
        kind: 'chat',
        runId: started.runId,
        runStatus: status,
        overlong: text.length > messageChars,
      });

      if (status !== 'completed') {
        notice(teamId, `@${speaker} 这一次发言没有跑完（${status}）${settled?.error ? `：${String(settled.error).slice(0, 200)}` : ''}`);
      }

      // 发言跑完之后状态可能已经变了（用户暂停/关闭了团队）：照旧记录，但不再往下走。
      const after = store.getTeam(teamId);
      if (after === undefined || after.status !== 'discussing' || stopped.has(teamId)) return;

      if (!isOwner) {
        enqueue(after, after.ownerName);
        continue;
      }

      // 收尾轮：不管群主写没写指令，都在这一轮结束讨论。
      if (mode === 'finalize') {
        finish(after, '轮次已到上限，群主已给出最终总结，讨论结束。');
        return;
      }
      applyDirective(after, record);
    }
  };

  /**
   * 推一把讨论循环（幂等：已经在跑就不重复起）。
   * @param {string} teamId - 团队。
   * @returns {void}
   */
  const pump = (teamId) => {
    if (disposed || drivers.has(teamId)) return;
    const promise = drive(teamId)
      .catch((error) => {
        log.warn(`团队 ${teamId} 讨论循环异常：${describeError(error)}`);
        try {
          store.updateTeam(teamId, { status: 'error', lastError: describeError(error), speaker: '' });
          notice(teamId, `讨论中断：${describeError(error)}`);
        } catch (postError) {
          log.debug(`写团队错误状态失败：${describeError(postError)}`);
        }
      })
      .finally(() => { drivers.delete(teamId); });
    drivers.set(teamId, promise);
  };

  /**
   * 任务结算时在群里汇报。
   *
   * 这是「成员执行完成时通知群主」的**宿主侧保险**：提示词里已经要求成员自己用 team_say 汇报，
   * 但提示词是可以被忽略的，而「谁跑完了」这件事宿主是权威知情者。
   * 两条都发会重复——所以这里用 runId 去重，并且在文案里写明是宿主侧的通知。
   * @param {object} frame - 运行时帧。
   * @returns {void}
   */
  const onRunFrame = (frame) => {
    if (frame?.kind !== 'run') return;
    const summaryFrame = frame.summary;
    const runId = String(summaryFrame?.runId ?? '');
    if (runId === '' || String(frame.runId ?? '') !== runId) return;
    if (!TERMINAL_STATUSES.has(String(summaryFrame?.status ?? ''))) return;
    if (noticed.has(runId)) return;

    let team;
    let task;
    try {
      task = store.taskByRun(runId);
      if (task === undefined) return;
      team = store.teamByPlan(task.planId);
    } catch (error) {
      log.debug(`团队汇报查询失败：${describeError(error)}`);
      return;
    }
    if (team === undefined || task === undefined) return;

    noticed.add(runId);
    if (noticed.size > NOTICED_LIMIT) {
      noticed.delete(noticed.values().next().value);
    }

    const status = String(summaryFrame.status ?? '');
    const seconds = Math.round((summaryFrame.elapsedMs ?? 0) / 1000);
    const verb = status === 'completed' ? '已完成' : `未能完成（${status}）`;
    const tail = summaryFrame.error ? `——${String(summaryFrame.error).slice(0, 160)}` : '';
    post(team.id, {
      role: 'system',
      speaker: '',
      kind: 'status',
      text: `（宿主通知）@${team.ownerName} 任务 ${task.id}「${task.title}」（@${task.agentName}）${verb}，用时 ${seconds}s。${tail}`,
      runId,
      runStatus: status,
    });
    // 「讨论中」与「在等任务」两种状态下都该把话语权还给群主：
    // 后者正是它为等结果而挂起的那一刻，任务结算就是它的闹钟。
    if (team.status === 'discussing' || team.status === 'waiting_tasks') {
      store.updateTeam(team.id, { status: 'discussing' });
      enqueue(store.getTeam(team.id) ?? team, team.ownerName);
      pump(team.id);
    }
  };

  //#region 对外

  return {
    /**
     * 挂订阅与启动对账。
     * @returns {Function} 注销函数。
     */
    attach() {
      try {
        runtimeUnsubscribe = runtime.subscribe(onRunFrame);
      } catch (error) {
        log.debug(`订阅运行时事件失败（团队不会自动收到任务汇报）：${describeError(error)}`);
      }
      // 启动对账：进程重启之后没有任何驱动者在跑，继续显示「讨论中」就是在撒谎。
      try {
        for (const team of store.listTeams({ statuses: ['discussing', 'waiting_tasks'], limit: 50 })) {
          store.updateTeam(team.id, { status: 'paused', speaker: '', queue: [] });
          notice(team.id, '（系统）宿主重启过：这场讨论已经停下来了。点「继续」就从群主那里接着往下走。');
        }
      } catch (error) {
        log.warn(`团队对账失败：${describeError(error)}`);
      }
      return () => {
        try {
          runtimeUnsubscribe?.();
        } catch (error) {
          log.debug(`团队注销订阅失败：${describeError(error)}`);
        }
      };
    },
    dispose() {
      disposed = true;
      drivers.clear();
      listeners.clear();
      parentRefs.clear();
      // 插件卸载时把等待者放掉：让一个 `team_open` 永远挂着，比让它收到
      // 「等不到了」然后如实回答更糟（挂着的那一侧是主对话的整个回合）。
      for (const set of waiters.values()) {
        for (const waiter of set) {
          clearTimeout(waiter.timer);
          waiter.resolve(undefined);
        }
      }
      waiters.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isTeamMode: () => store.isTeamMode(),
    /**
     * 团队模式开关。
     *
     * 关掉时**把所有正在讨论的团队暂停**：开关的语义是「别再自动说话了」，
     * 而不是「把它藏起来」——让讨论继续在后台烧 token 才是真正糟糕的行为。
     * @param {boolean} enabled - 目标状态。
     * @returns {{teamMode:boolean, paused:string[]}}
     */
    setTeamMode(enabled) {
      const next = store.setTeamMode(enabled);
      const paused = [];
      if (!next) {
        for (const team of store.listTeams({ statuses: ['discussing', 'waiting_tasks', 'awaiting_user'], limit: 50 })) {
          stopped.add(team.id);
          store.updateTeam(team.id, { status: 'paused', speaker: '', queue: [] });
          notice(team.id, '团队模式已关闭，讨论暂停。重新打开后点「继续」即可接着走。');
          paused.push(team.id);
        }
      }
      log.info(`团队模式 ${next ? '已打开' : '已关闭'}${paused.length > 0 ? `（暂停了 ${paused.length} 个讨论中的团队）` : ''}`);
      for (const id of paused) emit(id);
      return { teamMode: next, paused };
    },
    open,
    start,
    pause,
    close,
    say,
    userSay,
    planTasks,
    stateOf,
    summary,
    /**
     * 等这声讨论停下来（closed / awaiting_user / paused / error），或超时。
     * 工具层靠它把主对话**留在自己的回合里**，直到群主把结论说完。
     */
    waitFor,
    /** 这场讨论现在是不是已经停了（与 `waitFor` 同一份判定）。 */
    isSettled,
    /**
     * 往群里发一条宿主公告。
     *
     * 用在「模型侧的动作失败了」这种场合：失败原因原本只回到模型手里，
     * 而**用户看的是面板**——把它写进群聊，用户才知道为什么主对话没收到结论。
     * @param {string} teamId - 团队 id。
     * @param {string} text - 公告正文。
     * @returns {object|undefined}
     */
    announce: (teamId, text) => {
      const found = store.getTeam(teamId);
      if (found === undefined) return undefined;
      return notice(teamId, text);
    },
    /** 群主的结论（群里最后一条群主发言）——「带回主对话」的就是它。 */
    conclusionOf,
    /** 打包「状态 + 结论 + 任务链 + 最近发言」，供工具层一次性带走。 */
    report,
    get: (teamId) => store.getTeam(teamId),
    list: (options) => store.listTeams(options),
    messages: (teamId, options) => store.listTeamMessages(teamId, options),
    lastSeq: (teamId) => store.lastTeamSeq(teamId),
    parseDeclaration: parseTeamDeclaration,
    resolveSpec,
    /** 供工具层复用：把群规写进任务说明。 */
    decorateBrief: (brief, team) => decorateBrief(brief, team, limits().messageChars),
    /** 面板「继续」：起/继续讨论。 */
    resume: start,
    /** 测试与排错：等某条讨论循环自然结束。 */
    idle: async (teamId) => {
      const running = drivers.get(teamId);
      if (running !== undefined) await running;
    },
    /** 测试与排错：驱动是否在跑。 */
    isDriving: (teamId) => drivers.has(teamId),
    /**
     * 标记「这个团队的结论已经被带回主对话了」。
     *
     * 工具层每次把结论交出去（`team_open` / `team_status` 的返回值）就调一次。
     * 只记在内存里：它描述的是「这一轮对话有没有拿到过」，重启后全部重来一遍
     * 最多让提示词多列一行，不会造成任何错误行为。
     * @param {string} teamId - 团队 id。
     * @returns {void}
     */
    markDelivered(teamId) {
      delivered.add(teamId);
    },
    /**
     * 给提示词用的现状摘要（主对话据此知道群里发生了什么）。
     *
     * 两种「需要主对话知道」的东西：
     *  1. 还在进行的团队（含等你拍板的）；
     *  2. **已经收尾但结论还没被取走的**团队——这是防「讨论完了、结论却没回到主对话」
     *     的最后一道网：只要它没被取走，每一轮提示词里都会带着它，直到有人把它带走。
     * @param {number} [limit] - 最多几条。
     * @returns {string[]}
     */
    pendingLines(limit = 5) {
      const lines = [];
      const teams = store.listTeams({ limit: 20 });
      const active = teams.filter((team) => team.status !== 'closed').slice(0, limit);
      if (active.length > 0) {
        lines.push('### 正在进行的团队（群组模式）');
        for (const team of active) {
          const tail = store.listTeamMessages(team.id, { limit: 1 })[0];
          lines.push(
            `- 「${team.name}」（${team.id}）｜群主 @${team.ownerName}｜成员 ${team.members.map((name) => `@${name}`).join(' ') || '（无）'}`
            + `｜${team.status === 'awaiting_user' ? '**等你拍板**' : team.status}`
            + `${team.status === 'discussing' ? `（第 ${team.rounds}/${team.maxRounds} 轮，正在说：@${team.speaker || '…'}）` : ''}`
            + `${team.planId === '' ? '' : `｜任务链 ${team.planId}`}`
            + `${tail === undefined ? '' : `\n  最后一句：${String(tail.text).replace(/\s+/g, ' ').slice(0, 120)}`}`,
          );
        }
        lines.push('这些团队还没结束：**不要结束回合**，用 `team_status {team_id, wait:true}` 等它。');
      }

      // 收尾了但结论没被取走的：只在最近 12 小时内提醒，且最多 3 条（不堆历史）。
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      const unclaimed = teams
        .filter((team) => team.status === 'closed' && delivered.has(team.id) !== true)
        .filter((team) => (team.closedAt ?? team.updatedAt) >= cutoff)
        .slice(0, 3);
      if (unclaimed.length > 0) {
        lines.push('', '### 已收尾但结论还没带回主对话的团队');
        for (const team of unclaimed) {
          const conclusion = conclusionOf(team.id);
          lines.push(
            `- 「${team.name}」（${team.id}）｜群主 @${team.ownerName}｜收尾于 ${new Date(team.closedAt ?? team.updatedAt).toLocaleString('zh-CN')}`,
            `  结论：${conclusion === undefined ? '（群主没有留下结论）' : conclusion.text.replace(/\s+/g, ' ').slice(0, 200)}`,
          );
        }
        lines.push('把上面的结论讲给用户（或接进当前工作），然后用 `team_status` 取一次即视为已转达。');
      }
      return lines;
    },
    /** 随机 id（工具侧需要给团队起名时用）。 */
  };

  //#endregion
}

//#endregion
