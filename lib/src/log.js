/**
 * 日志：把插件日志统一打上 `[subagent-hub]` 前缀，并容忍宿主没有 logger。
 *
 * 之所以要这一层而不是直接用 `ctx.logger`：
 *  - 宿主可能没有日志服务（独立脚本、精简组合），而 `undefined.info` 会立刻炸掉整个 apply；
 *  - DSH 的 `ctx.logger` 是**可调用**的（`ctx.logger(name)` 造具名 logger）。
 *    必须走具名这条路：日志出口只能导出来自本插件的记录，
 *    否则一个第三方插件会把**所有插件的日志**都灌进用户的终端——这是真实发生过的
 *    （首次真机启动时终端里出现了 `hmr: watching %o []`，那根本不是本插件的日志）。
 *
 * @module dsh-subagent-hub/log
 */
import { format as formatPrintf } from 'node:util';

/** 本插件的日志名（同时是日志出口的过滤键）。 */
export const LOG_NAME = 'subagent-hub';

/**
 * 从宿主上下文里取一个**具名** logger。
 *
 * `ctx.logger` 是 callable 的（`LoggerService extends Record<LoggerType, LoggerMethod>`
 * 且可调用），`ctx.logger(name)` 返回一个 name 固定的 logger facade。
 * 拿不到就用原始对象——绝不因为这一步失败而让插件起不来。
 *
 * @param {object|undefined} ctx - cordis 上下文。
 * @returns {any} logger（可能是 undefined）。
 */
export function resolveNamedLogger(ctx) {
  const raw = ctx?.logger;
  if (raw === undefined) return undefined;
  try {
    if (typeof raw === 'function') return raw(LOG_NAME);
  } catch {
    /* 落到未具名 logger */
  }
  return raw;
}

/**
 * 造一个 logger。
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}|undefined} logger - 宿主 logger。
 * @returns {{info:Function,warn:Function,error:Function,debug:Function}}
 */
export function createLogger(logger) {
  const withPrefix = (args) => [`[${LOG_NAME}]`, ...args];
  const call = (level, args) => {
    const fn = logger?.[level];
    if (typeof fn === 'function') {
      try {
        fn.apply(logger, withPrefix(args));
        return;
      } catch {
        /* 落到 console */
      }
    }
    const fallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fallback(...withPrefix(args));
  };
  return {
    info: (...args) => { call('info', args); },
    warn: (...args) => { call('warn', args); },
    error: (...args) => { call('error', args); },
    // debug 只在宿主真的支持时输出：宿主没有就静默，避免刷屏。
    debug: (...args) => {
      if (typeof logger?.debug === 'function') call('debug', args);
    },
  };
}

/**
 * 把一条 cordis 日志记录格式化成一行。
 *
 * 用 `node:util` 的 `format` 而不是自己拼字符串——**这是踩过的坑**：
 * cordis 的日志是 printf 风格的（`logger.info('hmr: watching %o', [])`），
 * 自己拼会把格式串原样打出来，变成 `hmr: watching %o []` 这种没法读的东西。
 *
 * 另外字段名是 `ts` 不是 `timestamp`：写错的话时间戳会被静默忽略、永远显示当前时间。
 *
 * @param {object} message - cordis 的 `Message`：`{sn, ts, name, type, level, args}`。
 * @returns {string}
 */
export function formatLogMessage(message) {
  const type = typeof message?.type === 'string' ? message.type.toUpperCase() : 'INFO';
  const args = Array.isArray(message?.args) ? message.args : [];
  let body = '';
  try {
    body = args.length > 0 ? formatPrintf(...args) : '';
  } catch (error) {
    // 格式化绝不该反过来把日志系统搞崩：失败了就打一条能看懂的替代文本。
    body = `<unformattable log args: ${describeError(error)}>`;
  }
  const at = typeof message?.ts === 'number' ? message.ts : Date.now();
  const time = new Date(at).toISOString().slice(11, 23);
  return `${time} ${type.padEnd(5)} [${message?.name ?? LOG_NAME}] ${body}`;
}

/**
 * 这条日志记录是不是本插件发的。
 *
 * 过滤必须在**出口这一侧**做：exporter 是全局的，cordis 会把所有 logger 的记录都送进来。
 * @param {unknown} message - cordis 的 `Message`。
 * @returns {boolean}
 */
export function isOwnMessage(message) {
  return message?.name === LOG_NAME;
}

/**
 * 把任意异常压成一行可读文本（日志与 API 错误都用它，保证两边措辞一致）。
 * @param {unknown} error - 异常或任意值。
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
