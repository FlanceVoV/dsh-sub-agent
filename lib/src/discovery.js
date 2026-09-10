/**
 * 自发现：从 DSH 的运行时事实里读出「本机能用哪些路由、哪些模型、窗口多大」。
 *
 * 核心原则是**不内置任何模型清单**。插件不假装自己知道世界，而是问 DSH：
 *   ctx.llm.listProviders()              → 已激活的路由
 *   ctx.llm.listConfigurableProviders()  → 已配置（含未激活）的路由 + 它在 settings 里的位置
 *   ctx.settings.get(ns)                 → 该路由的配置（含 baseURL 与 models[]）
 *   ctx.llm.resolveModelInfo(p, m)       → 该模型的真实上下文窗口（**必须单独一次调用**：
 *                                          listModels 不带窗口，Web 的模型目录也把它丢了）
 *   ctx.credentials.describe(ref)        → 凭据是否已配置（**永远拿不到值**）
 *   ctx.subagents.list() / getProvider() → 「agent 提供商」= 可用的子 agent 传输实现
 *
 * 所有访问都是防御式的：任何一步缺失都降级为空结果，绝不抛错。理由是宿主启动安全——
 * 一个可选服务缺席不该让插件起不来。
 *
 * @module dsh-subagent-hub/discovery
 */
import { describeError } from './log.js';

/**
 * 取一个上下文服务（不存在返回 undefined）。
 * @param {object|undefined} ctx - cordis 上下文。
 * @param {string} key - 服务名。
 * @returns {any}
 */
export function safeGet(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 调用一个方法并把结果规整成数组；任何异常都降级为空数组。
 * @param {any} service - 目标服务。
 * @param {string} method - 方法名。
 * @param {any[]} [args] - 参数。
 * @returns {any[]}
 */
function callList(service, method, args = []) {
  if (service === null || service === undefined) return [];
  const fn = service[method];
  if (typeof fn !== 'function') return [];
  try {
    const value = fn.apply(service, args);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * 按路径取值。
 * @param {any} value - 根值。
 * @param {string[]} path - 路径段。
 * @returns {any}
 */
export function navigate(value, path) {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * 读一个 settings 命名空间。
 * @param {any} settings - settings 服务。
 * @param {unknown} ns - 命名空间。
 * @returns {any}
 */
function readSetting(settings, ns) {
  if (settings === undefined || typeof ns !== 'string' || ns === '') return undefined;
  if (typeof settings.get !== 'function') return undefined;
  try {
    return settings.get(ns);
  } catch {
    return undefined;
  }
}

/**
 * 让面板能一键列出「本机能用的模型路由」。
 *
 * 只做廉价调用（不含 per-model 的 resolveModelInfo，那是用户选定模型后再问一次的事），
 * 所以这个函数可以放心地在每次面板轮询时执行。
 *
 * @param {object|undefined} ctx - cordis 上下文。
 * @param {object} [log] - logger。
 * @returns {{routes:object[],transports:object[],credentialRefs:string[],warnings:string[]}}
 */
export function discoverCatalog(ctx, log) {
  const llm = safeGet(ctx, 'llm');
  const settings = safeGet(ctx, 'settings');
  const warnings = [];
  /** @type {Map<string,object>} */
  const routes = new Map();

  const ensure = (id) => {
    let entry = routes.get(id);
    if (entry === undefined) {
      entry = { id, name: id, active: false, configurable: false, apiBase: '', credentialRef: '', models: new Map() };
      routes.set(id, entry);
    }
    return entry;
  };

  // 1) 已配置的路由：拿 settings 位置，从而读出 baseURL / apiKeyEnv / models[]。
  for (const entry of callList(llm, 'listConfigurableProviders')) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.provider === 'string' ? entry.provider : undefined;
    if (id === undefined || id === '') continue;
    const route = ensure(id);
    route.configurable = true;
    if (typeof entry.displayName === 'string' && entry.displayName !== '') route.name = entry.displayName;

    const section = readSetting(settings, entry.settingsNs);
    const profile = navigate(section, Array.isArray(entry.settingsPath) ? entry.settingsPath : []);
    if (profile !== null && typeof profile === 'object') {
      route.apiBase = typeof profile.baseURL === 'string' ? profile.baseURL
        : typeof profile.api === 'string' ? profile.api : '';
      route.credentialRef = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : '';
      for (const model of Array.isArray(profile.models) ? profile.models : []) {
        if (model === null || typeof model !== 'object') continue;
        const modelId = typeof model.id === 'string' && model.id !== '' ? model.id : undefined;
        if (modelId === undefined) continue;
        route.models.set(modelId.toLowerCase(), {
          id: modelId,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : modelId,
          // settings 里显式写的窗口优先——它就是「用户已经改过」的那个值。
          contextWindow: Number.isSafeInteger(model.contextWindow) ? model.contextWindow : null,
          maxTokens: Number.isSafeInteger(model.maxTokens) ? model.maxTokens : null,
          source: 'settings',
        });
      }
      if (Number.isSafeInteger(profile.defaultContextWindow) && profile.defaultContextWindow > 0) {
        route.defaultContextWindow = profile.defaultContextWindow;
      }
    }
  }

  // 2) 已激活的路由：补齐显示名，并保证它至少出现。
  for (const entry of callList(llm, 'listProviders')) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (id === undefined || id === '') continue;
    const route = ensure(id);
    route.active = true;
    if (typeof entry.name === 'string' && entry.name !== '') route.name = entry.name;
  }

  // 3) 兜底：某些路由的模型清单从 settings 的结构里读不到（适配器自己知道）。
  const declared = declaredModels(settings);
  for (const [providerId, modelIds] of declared) {
    const route = routes.get(providerId);
    if (route === undefined) continue;
    for (const modelId of modelIds) {
      const key = modelId.toLowerCase();
      if (!route.models.has(key)) {
        route.models.set(key, { id: modelId, name: modelId, contextWindow: null, maxTokens: null, source: 'declared' });
      }
    }
  }

  // 4) 「agent 提供商」= ctx.subagents 里注册的传输实现。
  const transports = [];
  const subagents = safeGet(ctx, 'subagents');
  for (const providerName of callList(subagents, 'list')) {
    if (typeof providerName !== 'string' || providerName === '') continue;
    let provider;
    try {
      provider = typeof subagents?.getProvider === 'function' ? subagents.getProvider(providerName) : undefined;
    } catch {
      provider = undefined;
    }
    const capabilities = provider?.capabilities ?? {};
    transports.push({
      name: providerName,
      // 只有支持 agentOptions 的传输才能承载「指定模型」——这是本插件的立足点，
      // UI 必须据此把不能用的传输标出来，而不是让用户选完才发现跑不起来。
      supportsModelBinding: capabilities.agentOptions === true,
      supportsOutputSchema: capabilities.outputSchema === true,
      supportsToolFilter: capabilities.toolFilter === true,
      supportsPersona: capabilities.persona === true,
      inheritsParentContext: provider?.inheritsParentContext === true,
    });
  }
  if (transports.length === 0) {
    warnings.push('ctx.subagents 不可用或没有注册任何传输实现：子 agent 无法启动（需要 @deepseek-ai/dsh-subagent + 至少一个 provider）。');
  }

  const routesOut = [...routes.values()].map((route) => ({
    id: route.id,
    name: route.name,
    active: route.active,
    configurable: route.configurable,
    apiBase: route.apiBase,
    apiBaseSource: route.apiBase === '' ? 'adapter-default' : 'settings',
    credentialRef: route.credentialRef,
    credential: describeCredential(ctx, route.credentialRef, log),
    defaultContextWindow: route.defaultContextWindow ?? null,
    models: [...route.models.values()].sort((left, right) => left.id.localeCompare(right.id)),
  })).sort((left, right) => left.id.localeCompare(right.id));

  return { routes: routesOut, transports, credentialRefs: listCredentialRefs(ctx), warnings };
}

/**
 * 问一个模型的真实信息（窗口、默认输出上限、推理档位）。
 *
 * 单独一个函数的原因：`listModels` 不返回窗口，只有 `resolveModelInfo` 会，
 * 而且它是异步的 per-(provider,model) 调用，不该塞进列表接口里。
 *
 * @param {object|undefined} ctx - cordis 上下文。
 * @param {string} provider - 模型提供商 id。
 * @param {string} model - 模型 id。
 * @returns {Promise<{contextWindow:number|null,maxTokens:number|null,reasoningEfforts:string[],defaultEffort:string,error:string|null}>}
 */
export async function resolveModelDetail(ctx, provider, model) {
  const llm = safeGet(ctx, 'llm');
  const empty = { contextWindow: null, maxTokens: null, reasoningEfforts: [], defaultEffort: '', error: null };
  if (typeof llm?.resolveModelInfo !== 'function') {
    return { ...empty, error: 'ctx.llm.resolveModelInfo 不可用' };
  }
  try {
    const info = await llm.resolveModelInfo(provider, model);
    if (info === null || typeof info !== 'object') return { ...empty, error: '该路由没有报告模型信息' };
    const efforts = Array.isArray(info.reasoning?.efforts) ? info.reasoning.efforts.filter((x) => typeof x === 'string') : [];
    return {
      contextWindow: Number.isSafeInteger(info.context?.contextWindow) ? info.context.contextWindow : null,
      maxTokens: Number.isSafeInteger(info.defaultMaxTokens) ? info.defaultMaxTokens : null,
      reasoningEfforts: efforts,
      defaultEffort: typeof info.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : '',
      error: null,
    };
  } catch (error) {
    return { ...empty, error: describeError(error) };
  }
}

/**
 * 凭据只问「配没配」，永远不问值——DSH 的 credentials 服务也不给值。
 * @param {object|undefined} ctx - cordis 上下文。
 * @param {string} ref - 凭据引用名。
 * @param {object} [log] - logger。
 * @returns {{ref:string,configured:boolean,source:string,writable:boolean}|null}
 */
function describeCredential(ctx, ref, log) {
  if (ref === '') return null;
  const credentials = safeGet(ctx, 'credentials');
  if (typeof credentials?.describe !== 'function') return { ref, configured: false, source: 'unknown', writable: false };
  try {
    const described = credentials.describe(ref);
    return {
      ref,
      configured: described?.configured === true,
      source: typeof described?.source === 'string' ? described.source : 'unknown',
      writable: described?.writable === true,
    };
  } catch (error) {
    log?.debug?.(`credentials.describe(${ref}) failed: ${describeError(error)}`);
    return { ref, configured: false, source: 'unknown', writable: false };
  }
}

/**
 * 列出当前 DSH 认识的凭据引用名（只有名字，没有值）。
 * @param {object|undefined} ctx - cordis 上下文。
 * @returns {string[]}
 */
function listCredentialRefs(ctx) {
  const credentials = safeGet(ctx, 'credentials');
  for (const method of ['list', 'refs', 'names', 'describeAll']) {
    const value = callList(credentials, method);
    if (value.length > 0) {
      const names = value
        .map((item) => (typeof item === 'string' ? item : item?.ref ?? item?.name ?? item?.id))
        .filter((name) => typeof name === 'string' && name !== '');
      if (names.length > 0) return [...new Set(names)].sort();
    }
  }
  return [];
}

/**
 * 从 settings 的各个命名空间里把所有 `models: [{id}]` 抠出来。
 *
 * 用意：即使 DSH 将来改了 `settingsPath` 的语义，只要用户配置里仍有
 * `models: [{ id }]`，面板就还能给出模型下拉——降级而不失效。
 *
 * @param {any} settings - settings 服务。
 * @returns {Map<string,string[]>} provider id → 模型 id 列表。
 */
function declaredModels(settings) {
  const found = new Map();
  if (typeof settings?.describe !== 'function') return found;

  let descriptors;
  try {
    descriptors = settings.describe();
  } catch {
    return found;
  }
  for (const descriptor of callList({ describe: () => descriptors }, 'describe')) {
    const ns = descriptor?.namespace ?? descriptor?.ns ?? descriptor?.id;
    if (typeof ns !== 'string') continue;
    const section = readSetting(settings, ns);
    if (section === null || typeof section !== 'object') continue;
    const candidates = [section, ...Object.values(section.providers ?? {})];
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const providerId = typeof candidate.provider === 'string' ? candidate.provider : undefined;
      for (const model of Array.isArray(candidate.models) ? candidate.models : []) {
        const modelId = typeof model?.id === 'string' && model.id !== '' ? model.id : undefined;
        if (modelId === undefined) continue;
        // 归到 provider 名下：优先 profile 自己声明的 provider，否则用命名空间名。
        const owner = providerId ?? (typeof candidate.id === 'string' ? candidate.id : ns);
        if (!found.has(owner)) found.set(owner, []);
        found.get(owner).push(modelId);
      }
    }
  }
  return found;
}
