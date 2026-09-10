/**
 * Agent 配置的校验与增删改。
 *
 * 这一层只做两件事：**把用户的输入变成合法的配置**，以及**把配置翻译成运行时要的东西**
 * （`AgentOptions` 与 `ToolRestriction`）。它不碰 DSH、不碰数据库连接，只依赖 store 的
 * 方法与一份「当前能用的路由/传输」快照——因此它是纯逻辑，可以完全单测。
 *
 * @module dsh-subagent-hub/registry
 */
import { TOOL_POLICIES } from './store.js';

/** 名字的最大长度（它同时是 @ 句柄）。 */
export const MAX_NAME_LENGTH = 48;

/**
 * `readonly` 策略的**白名单**（fail-closed）。
 *
 * 为什么用白名单而不是黑名单：这是一个**安全**策略。黑名单在新工具出现时会静默放行
 * （下一次 DSH 加一个写文件的工具，只读 agent 就突然能写文件了）；白名单在新工具出现时
 * 只是保守地拒绝，代价是「多拒了一个本来安全的工具」，可以由用户在配置里补。
 * 两者都会出错，但错的方向不同——安全策略必须往「拒绝」的方向错。
 *
 * 用户可在 config.json 的 `readonlyToolAllow` 里覆盖这一列表。
 */
export const READONLY_TOOL_ALLOW = Object.freeze([
  'read', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'todo_write', 'ask_user_question',
  'list_agents',
]);

/**
 * 校验一段待写入的 agent 输入。
 *
 * @param {object} input - 原始输入（来自 HTTP 或文件）。
 * @param {{mode:'create'|'update', existing?:object, catalog?:object, readonlyAllow?:string[]}} context - 上下文。
 * @returns {{ok:boolean,errors:string[],warnings:string[],value?:object}}
 */
export function validateAgentInput(input, context) {
  const errors = [];
  const warnings = [];
  const mode = context.mode;
  const existing = context.existing;
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};

  if (input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    return { ok: false, errors: ['请求体必须是一个 JSON 对象'], warnings };
  }

  /** 取字段：update 模式下未提供的字段沿用原值。 */
  const field = (key, fallback) => {
    if (key in source) return source[key];
    if (mode === 'update' && existing !== undefined && key in existing) return existing[key];
    return fallback;
  };

  // ---- name：@ 句柄，必须是单个 token ----
  const name = field('name', '');
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('name 必填（它是 @ 的句柄）');
  } else if (name.trim().length > MAX_NAME_LENGTH) {
    errors.push(`name 最长 ${MAX_NAME_LENGTH} 个字符`);
  } else if (/\s/.test(name.trim())) {
    // 理由：@ 的候选是从「空格/行首到空格」切出来的一个 token，带空格的名字永远 @ 不到。
    errors.push('name 不能包含空白字符：@ 的句柄是按空格切分的单个 token');
  }

  // ---- transport：agent 提供商 ----
  const transport = field('transport', 'spawn');
  if (typeof transport !== 'string' || transport === '') {
    errors.push('transport（agent 提供商）必填');
  } else {
    const known = context.catalog?.transports ?? [];
    const match = known.find((item) => item.name === transport);
    if (known.length > 0 && match === undefined) {
      errors.push(`未知的 agent 提供商 "${transport}"；本机可用：${known.map((t) => t.name).join(', ')}`);
    } else if (match !== undefined && match.supportsModelBinding !== true) {
      // 这是本插件的立足点，必须硬失败而不是「跑起来再说」。
      errors.push(`agent 提供商 "${transport}" 不支持 agentOptions，无法承载「指定模型」`);
    }
  }

  // ---- model provider / model ----
  const modelProvider = field('modelProvider', '');
  const modelId = field('modelId', '');
  if (typeof modelProvider !== 'string' || modelProvider === '') {
    errors.push('modelProvider（模型提供商）必填');
  }
  if (typeof modelId !== 'string' || modelId === '') {
    errors.push('modelId（模型 ID）必填');
  }
  if (typeof modelProvider === 'string' && modelProvider !== '' && typeof modelId === 'string' && modelId !== '') {
    const routes = context.catalog?.routes ?? [];
    const route = routes.find((item) => item.id === modelProvider);
    if (routes.length > 0 && route === undefined) {
      errors.push(`未知的模型提供商 "${modelProvider}"；本机可见：${routes.map((r) => r.id).join(', ')}`);
    } else if (route !== undefined && route.models.length > 0) {
      const known = route.models.some((model) => model.id.toLowerCase() === modelId.toLowerCase());
      if (!known) {
        // 只警告：DSH 的模型清单可能不完整（新模型、适配器自带目录），
        // 而 DSH 自己会在真正调用时给出权威判断。挡住反而是越权。
        warnings.push(`模型 "${modelId}" 不在 "${modelProvider}" 当前可见的模型清单里；如果 DSH 认得它就可以正常使用`);
      }
    }
  }

  // ---- 数值字段 ----
  const maxContext = intField(field('maxContext', 0), 'maxContext', errors, { min: 0 });
  const maxTokens = intField(field('maxTokens', 0), 'maxTokens', errors, { min: 0 });

  // ---- 枚举字段 ----
  const toolPolicy = field('toolPolicy', 'inherit');
  if (!TOOL_POLICIES.includes(toolPolicy)) {
    errors.push(`toolPolicy 必须是 ${TOOL_POLICIES.join(' | ')} 之一`);
  }

  // ---- 字符串字段 ----
  const apiBase = stringField(field('apiBase', ''), 'apiBase', errors);
  const credentialRef = stringField(field('credentialRef', ''), 'credentialRef', errors);
  const reasoningEffort = stringField(field('reasoningEffort', ''), 'reasoningEffort', errors);
  const persona = stringField(field('persona', ''), 'persona', errors);
  const note = stringField(field('note', ''), 'note', errors);

  if (apiBase !== '' && !/^https?:\/\//i.test(apiBase)) {
    warnings.push('apiBase 不像一个 http(s) 地址；它只是记录与提示，实际路由以 DSH 的 provider 配置为准');
  }
  if (credentialRef !== '') {
    const credential = (context.catalog?.routes ?? [])
      .map((route) => route.credential)
      .find((item) => item !== null && item !== undefined && item.ref === credentialRef);
    if (credential !== undefined && credential.configured !== true) {
      warnings.push(`凭据 "${credentialRef}" 在 DSH 里尚未配置（source=${credential.source}）；调用会失败`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    errors,
    warnings,
    value: {
      name: name.trim(),
      transport,
      modelProvider,
      modelId,
      apiBase,
      credentialRef,
      maxContext,
      maxTokens,
      reasoningEffort,
      toolPolicy,
      persona,
      note,
    },
  };
}

/**
 * 整数字段校验。
 * @param {unknown} value - 值。
 * @param {string} label - 字段名。
 * @param {string[]} errors - 错误收集。
 * @param {{min:number}} options - 下界。
 * @returns {number}
 */
function intField(value, label, errors, options) {
  if (value === undefined || value === null || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < options.min) {
    errors.push(`${label} 必须是不小于 ${options.min} 的整数`);
    return 0;
  }
  return num;
}

/**
 * 字符串字段校验。
 * @param {unknown} value - 值。
 * @param {string} label - 字段名。
 * @param {string[]} errors - 错误收集。
 * @returns {string}
 */
function stringField(value, label, errors) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${label} 必须是字符串`);
    return '';
  }
  return value.trim();
}

/**
 * 校验「添加/改名」时的重名冲突。
 *
 * 只在**未归档**范围内判重：归档掉的配置不再占用 @ 句柄，允许后来者复用同名。
 *
 * @param {{store:object}} deps - 依赖。
 * @param {string} name - 目标名字。
 * @param {string} [exceptId] - 排除的 agent id（更新自己时用）。
 * @returns {string|null} 冲突时的错误文本。
 */
export function findNameConflict({ store }, name, exceptId) {
  const existing = store.getAgentByName(name);
  if (existing === undefined) return null;
  if (exceptId !== undefined && existing.id === exceptId) return null;
  return `已经有一个未归档的子 agent 叫 "${name}"。名字是 @ 的句柄，必须唯一；请改名，或先归档原来那个。`;
}

/**
 * 把配置翻译成 DSH 的 `AgentOptions`。
 *
 * 重要限制（写在代码里，避免以后被"顺手补上"）：`AgentOptions` 只有
 * `{provider, model, reasoningEffort, maxTokens}`——**没有上下文窗口字段**。
 * 所以 `maxContext` 不会被翻译进这里；它是本插件自己的**输入预算闸**，
 * 由 runtime 在启动前判定（见 runtime.js 的 estimatePromptBudget）。
 *
 * @param {object} agent - 已落库的 agent 配置。
 * @returns {object} AgentOptions。
 */
export function toAgentOptions(agent) {
  const options = { provider: agent.modelProvider, model: agent.modelId };
  if (typeof agent.reasoningEffort === 'string' && agent.reasoningEffort !== '') {
    options.reasoningEffort = agent.reasoningEffort;
  }
  if (Number.isSafeInteger(agent.maxTokens) && agent.maxTokens > 0) {
    options.maxTokens = agent.maxTokens;
  }
  return options;
}

/**
 * 解析只读白名单。
 *
 * 空数组必须回退到默认列表：config 里 `readonlyToolAllow: []` 的语义是
 * 「没配，用默认」，而 `??` 对空数组不会回退（空数组不是 nullish）。
 * 这个区别很关键——把「用默认」误读成「一个工具都不放行」，
 * 会让 readonly 子 agent 静默变成「无工具」，而那与用户的选择不符。
 * @param {unknown} configured - 用户配置。
 * @returns {string[]} 生效的白名单。
 */
function resolveReadonlyAllow(configured) {
  return Array.isArray(configured) && configured.length > 0 ? configured : READONLY_TOOL_ALLOW;
}

/**
 * 把工具策略翻译成 DSH 的 `ToolRestriction`。
 *
 * `inherit` → undefined（不传，子 agent 就继承父级组合的工具集）。
 * 其余策略都由 spawn provider 在**子 agent 的创建窗口**内真正强制：
 * 命名到的工具会从子 agent 的提示词里消失，并且拒绝执行（可见性只有一套）。
 *
 * @param {object} agent - 已落库的 agent 配置。
 * @param {string[]} readonlyAllow - 只读白名单（来自 config；空数组 = 用默认）。
 * @returns {{allow?:string[],deny?:string[]}|undefined}
 */
export function toToolFilter(agent, readonlyAllow) {
  switch (agent.toolPolicy) {
    case 'none':
      // 空 allow = 没有任何工具保持在可见集合里。
      return { allow: [] };
    case 'readonly':
      return { allow: [...resolveReadonlyAllow(readonlyAllow)] };
    case 'inherit':
    default:
      return undefined;
  }
}

/**
 * 面向 UI 的配置视图：把「这个策略会怎么落地」翻译成人话，避免用户猜。
 * @param {object} agent - 已落库的 agent 配置。
 * @param {string[]} readonlyAllow - 只读白名单（空数组 = 用默认）。
 * @returns {object}
 */
export function describeToolPolicy(agent, readonlyAllow) {
  const filter = toToolFilter(agent, readonlyAllow);
  if (filter === undefined) {
    return { policy: agent.toolPolicy, enforced: false, summary: '继承父级：子 agent 拥有与本对话相同的工具集', allow: null, deny: null };
  }
  if (agent.toolPolicy === 'none') {
    return { policy: 'none', enforced: true, summary: '无工具：子 agent 只能思考与作答，不能读文件、不能执行命令', allow: [], deny: null };
  }
  const allow = resolveReadonlyAllow(readonlyAllow);
  return {
    policy: 'readonly',
    enforced: true,
    summary: `只读白名单（fail-closed）：仅放行 ${allow.join(', ')}；未列出的工具一律不可见且不可执行`,
    allow: [...allow],
    deny: null,
  };
}
