/**
 * 日志的测试。
 *
 * 这一层看起来最不重要，但它踩过两次真机的坑，而且两次都是**静默**的：
 *  1. 出口不过滤 → 把所有插件的日志灌进用户终端（真机上出现了不属于本插件的 `hmr: watching %o []`）；
 *  2. 自己拼字符串 → cordis 的 printf 风格格式串被原样打出来，日志没法读。
 * 另外 `Message` 的字段是 `ts` 而不是 `timestamp`，写错的话时间戳会被静默忽略。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOG_NAME, createLogger, formatLogMessage, isOwnMessage, resolveNamedLogger } from '../lib/src/log.js';

/** 造一条 cordis 风格的日志记录。 */
function message(overrides = {}) {
  return { sn: 1, ts: Date.UTC(2026, 8, 10, 13, 8, 14, 300), name: LOG_NAME, type: 'info', level: 1, args: [], ...overrides };
}

test('printf 风格格式串被正确解析，而不是原样打出', () => {
  // 真机上看到的是 `hmr: watching %o []`——这就是自己拼字符串的后果。
  const formatted = formatLogMessage(message({ args: ['hmr: watching %o', []] }));
  assert.doesNotMatch(formatted, /%o/, '格式串不该原样出现在输出里');
  assert.match(formatted, /hmr: watching/, '前缀文字要保留');
  assert.match(formatted, /length/, '%o 应当被 util.inspect 展开（而不是被 JSON 拼成 [] ）');

  assert.match(formatLogMessage(message({ args: ['db=%s max=%d', 'C:/x.db', 4] })), /db=C:\/x\.db max=4/);
});

test('用 ts 而不是 timestamp 取时间', () => {
  // 取错字段的表现是「时间永远是现在」，很难被注意到，所以钉住它。
  const formatted = formatLogMessage(message({ ts: Date.UTC(2026, 8, 10, 13, 8, 14, 300) }));
  assert.match(formatted, /13:08:14\.300/, `应当用 ts 字段，实际：${formatted}`);
});

test('级别与插件名出现在行里', () => {
  const formatted = formatLogMessage(message({ type: 'warn' }));
  assert.match(formatted, /WARN/);
  assert.match(formatted, new RegExp(`\\[${LOG_NAME}\\]`));
});

test('过滤：只认自己的日志（exporter 是全局的）', () => {
  assert.equal(isOwnMessage(message()), true);
  // 别人的日志必须被挡住：不过滤就是把别人的内部日志灌进用户终端。
  assert.equal(isOwnMessage(message({ name: 'cordis-hmr' })), false);
  assert.equal(isOwnMessage({ args: ['没有 name'] }), false);
  assert.equal(isOwnMessage(undefined), false);
  assert.equal(isOwnMessage(null), false);
});

test('畸形参数不抛错——日志系统崩了会把排查线索一起带走', () => {
  assert.doesNotThrow(() => formatLogMessage(message({ args: [undefined] })));
  assert.doesNotThrow(() => formatLogMessage(message({ args: [] })));
  assert.doesNotThrow(() => formatLogMessage({}));
  assert.doesNotThrow(() => formatLogMessage(undefined));
  // 循环引用：util.format 能处理，不该走到兜底分支。
  const circular = { self: null };
  circular.self = circular;
  assert.doesNotThrow(() => formatLogMessage(message({ args: [circular] })));
});

test('具名 logger：拿不到就叫不动，任何异常都退回原对象', () => {
  const named = { info() {} };
  const callable = (name) => { callable.lastName = name; return named; };
  callable.info = () => {};
  assert.equal(resolveNamedLogger({ logger: callable }), named);
  assert.equal(callable.lastName, LOG_NAME, '必须用本插件的名字去造 logger，出口才有得过滤');

  // 抛错的 logger 不该让插件起不来。
  const hostile = () => { throw new Error('boom'); };
  hostile.info = () => {};
  assert.equal(resolveNamedLogger({ logger: hostile }), hostile);

  assert.equal(resolveNamedLogger({}), undefined);
  assert.equal(resolveNamedLogger(undefined), undefined);
});

test('createLogger：宿主没有 logger 时退回 console，且不会抛错', () => {
  const log = createLogger(undefined);
  assert.doesNotThrow(() => log.info('x'));
  assert.doesNotThrow(() => log.debug('x'));
  // debug 在没有宿主 logger 时应当静默（避免刷屏），但也不该抛。
  assert.doesNotThrow(() => createLogger({ info: () => { throw new Error('boom'); } }).info('x'));
});
