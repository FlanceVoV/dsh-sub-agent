/**
 * 配置：默认值即文档，未知键与类型不符都打 warning 而不是静默失效。
 *
 * 两个来源，后者覆盖前者：
 *   1. cordis.patch.yml 的 entry config（部署层）
 *   2. $DSH_HOME/subagent-hub/config.json（用户层，可随时改，不必动 profile）
 *
 * 「打 warning 而不是报错」的理由：配置写错的正确后果是「这一项回到默认值并且
 * 你能看见为什么」，而不是插件起不来。
 *
 * @module dsh-subagent-hub/config
 */
import { join } from 'node:path';
import { readJsonIfExists, writeJsonAtomic } from './io.js';

/** 用户层配置文件名。 */
export const CONFIG_FILE_NAME = 'config.json';

/**
 * 默认配置（这份字面量就是配置文档）。
 * @returns {object}
 */
export function defaultConfig() {
  return {
    /** sqlite 库路径；空 = $DSH_HOME/subagent-hub/subagent-hub.db */
    dbPath: '',
    /** 同时最多几个子 agent 在跑。超出时新调用排队（不失败），这是真实的费用护栏。 */
    maxConcurrentRuns: 2,
    /** 单个子 agent 运行的最长时长（毫秒）；到时取消并记 timeout。 */
    runTimeoutMs: 15 * 60 * 1000,
    /** 同一个父会话同时最多被 @ 几个子 agent。 */
    maxParallelPerSession: 3,
    /** 运行记录里保留的输出正文字符上限；正文更长的部分只留 session 引用。 */
    outputTailChars: 20000,
    /** 运行记录保留天数；0 = 永久。 */
    retentionDays: 0,
    /** tok/s 的滑动窗口（毫秒）。窗口内没有新 chunk 就认为这一轮已经吐完。 */
    tokPerSecondWindowMs: 3000,
    /**
     * `readonly` 工具策略的白名单（fail-closed）。
     * 留空 = 用 registry.js 的 READONLY_TOOL_ALLOW 默认值。
     * 之所以可覆盖：DSH 的工具名会随版本变，用户不该为了补一个工具名而改插件源码。
     */
    readonlyToolAllow: [],
    /** 是否在宿主 stdout 打印插件日志（默认开：DSH 自身没有日志出口，不开就等于没有日志）。 */
    logToStdout: true,
  };
}

/** 每个键的类型，用于校验。 */
const TYPES = {
  dbPath: 'string',
  maxConcurrentRuns: 'positiveInt',
  runTimeoutMs: 'positiveInt',
  maxParallelPerSession: 'positiveInt',
  outputTailChars: 'positiveInt',
  retentionDays: 'nonNegativeInt',
  tokPerSecondWindowMs: 'positiveInt',
  readonlyToolAllow: 'stringArray',
  logToStdout: 'boolean',
};

/**
 * 归一化一层配置。
 * @param {unknown} source - 候选配置。
 * @param {object} target - 被写入的目标（默认值对象）。
 * @param {string} origin - 来源描述（warning 里用）。
 * @param {string[]} warnings - 收集警告。
 * @returns {void}
 */
function applyLayer(source, target, origin, warnings) {
  if (source === undefined || source === null) return;
  if (typeof source !== 'object' || Array.isArray(source)) {
    warnings.push(`${origin}: expected an object, got ${Array.isArray(source) ? 'array' : typeof source}; ignored`);
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    const kind = TYPES[key];
    if (kind === undefined) {
      warnings.push(`${origin}: unknown key "${key}" ignored (see lib/src/config.js for the supported set)`);
      continue;
    }
    if (!isType(value, kind)) {
      warnings.push(`${origin}: "${key}" expected ${kind}, got ${describeValue(value)}; kept the previous value`);
      continue;
    }
    target[key] = value;
  }
}

/**
 * 类型判定。
 * @param {unknown} value - 待判定的值。
 * @param {string} kind - 期望类型。
 * @returns {boolean}
 */
function isType(value, kind) {
  switch (kind) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'positiveInt': return Number.isSafeInteger(value) && value > 0;
    case 'nonNegativeInt': return Number.isSafeInteger(value) && value >= 0;
    case 'stringArray': return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
    default: return false;
  }
}

/**
 * 供 warning 使用的值描述。
 * @param {unknown} value - 任意值。
 * @returns {string}
 */
function describeValue(value) {
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * 归一化配置：defaults ← entryConfig ← fileConfig。
 * @param {unknown} entryConfig - cordis entry config。
 * @param {unknown} [fileConfig] - 用户配置文件内容。
 * @returns {{config:object,warnings:string[]}}
 */
export function normalizeConfig(entryConfig, fileConfig) {
  const config = defaultConfig();
  const warnings = [];
  applyLayer(entryConfig, config, 'cordis.patch.yml config', warnings);
  applyLayer(fileConfig, config, `${CONFIG_FILE_NAME}`, warnings);
  return { config, warnings };
}

/**
 * 读用户层配置文件（不存在或损坏都只是「没有这一层」）。
 * @param {string} dataDir - 数据目录。
 * @returns {unknown|undefined}
 */
export function loadUserConfig(dataDir) {
  return readJsonIfExists(join(dataDir, CONFIG_FILE_NAME));
}

/**
 * 解析实际的 sqlite 路径。
 * @param {object} config - 归一化后的配置。
 * @param {string} dataDir - 数据目录。
 * @returns {string} 绝对路径。
 */
export function resolveDbPath(config, dataDir) {
  const configured = typeof config.dbPath === 'string' ? config.dbPath.trim() : '';
  return configured === '' ? join(dataDir, 'subagent-hub.db') : configured;
}

/**
 * 每个配置项「能不能在界面里改」。
 *
 * 分成两类不是省事，而是**诚实**：
 *  - `live: true`  —— 改完立刻对后续行为生效。运行时的限流闸每启动一个任务都会重新读配置，
 *                     所以调大并发后排队中任务会立刻被放出去。
 *  - `live: false` —— 结构上就不可能在运行中生效（数据库连接已经打开、日志出口已经在 apply 时注册）。
 *                     对这类键**直接拒绝**，并说清「要改哪个文件、要不要重启」，
 *                     比接受一个「看起来保存成功了但其实没生效」的值好得多。
 */
export const CONFIG_META = Object.freeze({
  maxConcurrentRuns: {
    live: true,
    label: '最大并发运行数',
    hint: '同时最多有几个子 agent 在跑。超出上限的调用会排队，不会失败。这是真实的费用护栏——调大之前先想清楚。',
  },
  maxParallelPerSession: {
    live: true,
    label: '单会话并发上限',
    hint: '同一个对话同时最多被 @ 几个子 agent。主对话调用 subagent_run 时按这条拒绝。',
  },
  runTimeoutMs: {
    live: true,
    label: '单次运行超时（毫秒）',
    hint: '到时取消并记为 timeout。只对**之后新启动**的运行生效；已经在跑的仍按启动时的值计时。',
  },
  outputTailChars: {
    live: true,
    label: '保留的输出正文字符数',
    hint: '运行记录里保留的正文上限，更长的部分靠 session_id 回查 DSH 的会话日志（不复制权威副本）。',
  },
  retentionDays: {
    live: true,
    label: '运行记录保留天数',
    hint: '0 = 永久保留。清理时会连带删掉这些运行的评价。',
  },
  tokPerSecondWindowMs: {
    live: true,
    label: 'tok/s 采样窗口（毫秒）',
    hint: '速率估计的滑动窗口。只影响估算值的抖动，不影响权威速率。',
  },
  readonlyToolAllow: {
    live: true,
    label: '只读策略白名单',
    hint: '「只读」子 agent 能用的工具名，逐个换行。留空 = 用内置默认。未列出的工具一律不可见且不可执行（fail-closed）。',
  },
  dbPath: {
    live: false,
    label: '数据库路径',
    hint: '数据库在启动时就打开了，运行中换路径会让已有运行记录失联。',
  },
  logToStdout: {
    live: false,
    label: '日志输出到 stdout',
    hint: '日志出口在插件挂载时注册，运行中无法增删。',
  },
});

/**
 * 校验一份「来自界面的配置改动」。
 *
 * 只接受已知键、只接受类型正确的值、拒绝运行中不可能生效的键。
 * 与 `normalizeConfig` 的关键区别：那个是「读文件时宽容降级」，这个是「写配置时严格拒绝」——
 * 因为写下去的东西会持久化，静默纠正一个写错的值等于把错误固化。
 *
 * @param {unknown} patch - 候选改动。
 * @param {object} current - 当前生效的配置。
 * @returns {{ok:boolean,errors:string[],warnings:string[],value?:object}}
 */
export function validateConfigPatch(patch, current) {
  const errors = [];
  const warnings = [];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['请求体必须是一个 JSON 对象'], warnings };
  }
  const value = {};
  for (const [key, raw] of Object.entries(patch)) {
    const type = TYPES[key];
    if (type === undefined) {
      errors.push(`未知配置项 "${key}"`);
      continue;
    }
    const meta = CONFIG_META[key];
    if (meta !== undefined && meta.live !== true) {
      errors.push(`"${key}"（${meta.label}）不能在界面里改：${meta.hint}要改请编辑 $DSH_HOME/subagent-hub/${CONFIG_FILE_NAME} 并重启 dsh web。`);
      continue;
    }
    if (!isType(raw, type)) {
      errors.push(`"${key}"（${meta?.label ?? key}）期望 ${type}，收到 ${describeValue(raw)}`);
      continue;
    }
    if (raw !== current[key]) value[key] = raw;
  }
  if (Object.keys(patch).length === 0) warnings.push('没有提供任何配置项');
  return { ok: errors.length === 0, errors, warnings, value };
}

/**
 * 把改动写进用户层配置文件，并同步到**正在生效的那个对象**上。
 *
 * 为什么要同时改内存对象：运行时持有的就是这个对象（`runtime.config`），
 * 只写文件的话，用户会看到「保存成功」但行为直到重启才变——
 * 那是本插件一直在避免的那种「没有声音的降级」。
 *
 * @param {string} dataDir - 数据目录。
 * @param {object} liveConfig - 正在生效的配置对象（会被就地修改）。
 * @param {object} patch - 已校验的改动。
 * @returns {{applied:object,file:string}}
 */
export function applyConfigPatch(dataDir, liveConfig, patch) {
  const filePath = join(dataDir, CONFIG_FILE_NAME);
  const existing = readJsonIfExists(filePath);
  // 写回时保留文件里原有的、本次没动的键：用户手写过的东西不该被界面上的一次保存抹掉。
  const merged = { ...(existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}), ...patch };
  writeJsonAtomic(filePath, merged);
  for (const [key, value] of Object.entries(patch)) liveConfig[key] = value;
  return { applied: { ...patch }, file: filePath };
}

/**
 * 给界面的配置视图：当前值 + 每个键的元信息。
 * @param {object} config - 当前生效的配置。
 * @param {string} dataDir - 数据目录。
 * @returns {object[]}
 */
export function describeConfig(config, dataDir) {
  return Object.keys(TYPES).map((key) => {
    const meta = CONFIG_META[key] ?? { live: true, label: key, hint: '' };
    return {
      key,
      value: config[key],
      type: TYPES[key],
      live: meta.live === true,
      label: meta.label,
      hint: meta.hint,
    };
  });
}

/** 用户层配置文件的绝对路径（界面里要显示它，方便用户直接去改不可热改的项）。 */
export function userConfigPath(dataDir) {
  return join(dataDir, CONFIG_FILE_NAME);
}

