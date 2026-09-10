/**
 * 遥测折叠的测试。
 *
 * 这是全插件最容易被「看起来对」骗过去的一段逻辑（tok/s、估算标记、输出拼接），
 * 所以它必须有测试：一个显示错的速率比不显示速率更糟——用户会据此判断要不要继续花钱。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunTelemetry, contextRatio, contextStage } from '../lib/src/runtime.js';

/** 造一个遥测对象。 */
function makeTelemetry(startedAt = 1_000_000) {
  return new RunTelemetry({
    runId: 'run-1',
    sessionId: 'sess-1',
    label: '研究员',
    agentName: '研究员',
    windowMs: 3000,
    startedAt,
  });
}

/**
 * 造一个事件。
 * @param {string} type - 事件类型。
 * @param {object} data - 负载。
 * @param {number} time - 时间戳。
 * @returns {object}
 */
function event(type, data, time) {
  return { type, seq: 1, time, data };
}

test('折叠一次完整步：权威 usage 决定 token 数与速率', () => {
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;

  assert.equal(telemetry.fold(event('user/message', { content: [{ type: 'text', text: '写个方案' }] }, t0 - 100)) , true);
  assert.equal(telemetry.input, '写个方案');

  // 40 个字符、10 个 token → 校准出 4.0 字符/token，解码时长 1000ms。
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'x'.repeat(20) } }, t0));
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'y'.repeat(20) } }, t0 + 500));
  const changed = telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'z'.repeat(40) }] },
    usage: { outputTokens: 10 },
  }, t0 + 1000));

  assert.equal(changed, true);
  assert.equal(telemetry.tokensOut, 10);
  assert.equal(telemetry.decodeMs, 1000);
  assert.equal(telemetry.calibrated, true);
  assert.equal(telemetry.charsPerToken, 4);

  const rate = telemetry.rate(t0 + 1000);
  assert.equal(rate.estimated, false, '有权威时长与权威 token 数时不该标成估算');
  assert.equal(rate.value, 10, '10 token / 1s = 10 tok/s');

  // 权威文本到位后覆盖实时缓冲，避免流式拼接与真实消息不一致。
  assert.equal(telemetry.output, 'z'.repeat(40));
  assert.deepEqual(telemetry.messages, ['z'.repeat(40)]);
});

test('流式进行中：用上一轮校准出的系数估算，并明确标记为估算', () => {
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;

  // 先用一个完成的步把系数校准到 4.0。
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'x'.repeat(40) } }, t0));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'x'.repeat(40) }] },
    usage: { outputTokens: 10 },
  }, t0 + 1000));
  assert.equal(telemetry.charsPerToken, 4);

  // 第二步正在流：又来了 20 个字符，过了 500ms。
  const t1 = t0 + 2000;
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'a'.repeat(20) } }, t1));
  const rate = telemetry.rate(t1 + 500);

  assert.equal(rate.estimated, true, '权威 usage 还没到，必须标成估算');
  // 权威 10 + 估算 20/4=5 → 15 token；时长 1000+500=1500ms → 10 tok/s。
  assert.equal(rate.value, 10);
});

test('中英混排：系数会随上一个完成步自愈，而不是固定常数', () => {
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;

  // 中文场景：20 个汉字只花了 15 个 token → 系数 1.33，远小于默认的 3。
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: '汉'.repeat(20) } }, t0));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: '汉'.repeat(20) }] },
    usage: { outputTokens: 15 },
  }, t0 + 1000));

  // 校准值 = 本步字符数 ÷ 本步权威 token 数 = 20 / 15。
  assert.ok(
    Math.abs(telemetry.charsPerToken - 20 / 15) < 1e-9,
    `校准系数应为 20/15，实际 ${telemetry.charsPerToken}`,
  );
  assert.ok(telemetry.charsPerToken < 2, `中文场景应校准到 2 以下，实际 ${telemetry.charsPerToken}`);
});

test('推理增量与正文增量分开累计', () => {
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '想想…' } }, t0));
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: '答案' } }, t0 + 100));

  assert.equal(telemetry.reasoning, '想想…');
  assert.equal(telemetry.output, '答案');
});

test('工具调用与结果成对折叠', () => {
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;
  telemetry.fold(event('tool/call', { name: 'read', callId: 'c1' }, t0));
  telemetry.fold(event('tool/call', { name: 'grep', callId: 'c2' }, t0 + 10));
  telemetry.fold(event('tool/result', { callId: 'c2', isError: false }, t0 + 20));

  assert.equal(telemetry.tools.length, 2);
  assert.equal(telemetry.tools[0].done, false, 'c1 还没结果');
  assert.equal(telemetry.tools[1].done, true);
  assert.equal(telemetry.tools[1].isError, false);
});

test('中途上报的 usage 也能被采纳', () => {
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'hi' } }, t0));
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'usage', usage: { outputTokens: 7, inputTokens: 3 } } }, t0 + 200));

  assert.equal(telemetry.tokensOut, 7);
  assert.equal(telemetry.tokensIn, 3);
});

test('summary 反映忙闲、耗时与速率', () => {
  const telemetry = makeTelemetry(1000);
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'x'.repeat(40) } }, 2000));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'x'.repeat(40) }] },
    usage: { outputTokens: 10 },
  }, 3000));

  const running = telemetry.summary(4000);
  assert.equal(running.busy, true);
  assert.equal(running.status, 'running');
  assert.equal(running.outputChars, 40);

  telemetry.settle({ status: 'completed', stopReason: 'completed', endedAt: 5000 });
  const done = telemetry.summary(9000);
  assert.equal(done.busy, false);
  assert.equal(done.status, 'completed');
  assert.equal(done.elapsedMs, 4000, '终态后耗时应当冻结，不再随 now 增长');
});

test('没有内容 chunk 的步不会污染解码时长', () => {
  const telemetry = makeTelemetry(1000);
  // 只有 tool-call 增量、没有任何文本：不应把「首 token 前的等待」算进解码时长。
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'tool-call-delta', index: 0, argumentsDelta: '{}' } }, 2000));
  telemetry.fold(event('assistant/message', {
    message: { content: [] },
    usage: { outputTokens: 5 },
  }, 9000));

  assert.equal(telemetry.decodeMs, 0, '没有内容 chunk 时解码时长应保持 0');
  assert.equal(telemetry.tokensOut, 5);
});

//#region 上下文占用（液面与三档配色的数据源）
test('上下文占用取「最近一步的 prompt 大小」，不是累计输入', () => {
  // 这是液面能回落的关键：子 agent 自己压缩上下文之后，下一个请求的 prompt 会变小。
  // 写成累加的话液面只会单调上涨——用户的原话是「这个进度条不能是死的」。
  const telemetry = makeTelemetry(1000);
  const t0 = 2000;

  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'x'.repeat(40) } }, t0));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'x'.repeat(40) }] },
    usage: { inputTokens: 900_000, outputTokens: 10 },
  }, t0 + 500));
  assert.equal(telemetry.contextUsed, 900_000, '第一步：上下文占了 900k');
  assert.equal(telemetry.tokensIn, 900_000, '累计输入此刻等于它');

  // 第二步：压缩发生了，prompt 变小。
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'y'.repeat(40) } }, t0 + 1000));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'y'.repeat(40) }] },
    usage: { inputTokens: 120_000, outputTokens: 10 },
  }, t0 + 1500));

  assert.equal(telemetry.contextUsed, 120_000, '上下文占用必须能回落（压缩之后）');
  assert.equal(telemetry.tokensIn, 1_020_000, '累计输入仍然只增不减（那是另一件事）');
});

test('窗口来源：agent 配置 > 兜底 1M，request/context 事件最权威', () => {
  const configured = new RunTelemetry({
    runId: 'r', sessionId: 's', label: 'a', agentName: 'a', windowMs: 3000, startedAt: 0, contextBudget: 128_000,
  });
  assert.equal(configured.contextWindow, 128_000);
  assert.equal(configured.contextWindowSource, 'configured');

  // agent 没配 maxContext → 用户要求的兜底 1M。
  const fallback = makeTelemetry(0);
  assert.equal(fallback.contextWindow, 1_000_000, '没设置上下文时默认 1M');
  assert.equal(fallback.contextWindowSource, 'default');

  // 适配器自报的窗口覆盖前两者：它来自真正要处理这次请求的适配器。
  fallback.fold(event('request/context', { provider: 'p', model: 'm', contextWindow: 262_144 }, 10));
  assert.equal(fallback.contextWindow, 262_144);
  assert.equal(fallback.contextWindowSource, 'adapter');
});

test('三档阈值：绿 / 黄 / 红，且只定义在一处', () => {
  assert.equal(contextStage(0, 1000), 'ok');
  assert.equal(contextStage(599, 1000), 'ok', '60% 以下是绿');
  assert.equal(contextStage(600, 1000), 'warn', '60% 起转黄');
  assert.equal(contextStage(849, 1000), 'warn');
  assert.equal(contextStage(850, 1000), 'crit', '85% 起转红');
  assert.equal(contextStage(2000, 1000), 'crit', '超窗口也是红，不会溢出');
  // 窗口非法时不猜：按 0 处理（绿），而不是除出 NaN / Infinity。
  assert.equal(contextStage(100, 0), 'ok');
  assert.equal(contextRatio(100, 0), 0);
});

test('快照把上下文三件套带给界面', () => {
  const telemetry = makeTelemetry(1000);
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'x' } }, 2000));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'x' }] },
    usage: { inputTokens: 300_000, outputTokens: 1 },
  }, 2200));

  const summary = telemetry.summary(3000);
  assert.equal(summary.contextUsed, 300_000);
  assert.equal(summary.contextWindow, 1_000_000);
  assert.equal(summary.contextRatio, 0.3);
  assert.equal(summary.contextStage, 'ok', '30% 是绿档');
  assert.equal(summary.contextWindowSource, 'default');

  // 涨到 90% 时档位要跟着变——界面只读这个字段，不自己算。
  telemetry.fold(event('assistant/chunk', { chunk: { type: 'text-delta', text: 'y' } }, 3000));
  telemetry.fold(event('assistant/message', {
    message: { content: [{ type: 'text', text: 'y' }] },
    usage: { inputTokens: 900_000, outputTokens: 1 },
  }, 3200));
  assert.equal(telemetry.summary(3300).contextStage, 'crit');
});

test('刚起步（还没完成任何一步）时占用是 0，不是「未知」', () => {
  // 0 与「没有测量」是两件事：前者是「上下文还很小」，后者是「还不知道」。
  // 界面据此区分「液面见底」与「不确定态浮动」。
  const telemetry = makeTelemetry(1000);
  assert.equal(telemetry.contextUsed, 0);
  assert.equal(telemetry.summary(1100).contextRatio, 0);
  assert.equal(telemetry.summary(1100).contextStage, 'ok');
});
//#endregion
