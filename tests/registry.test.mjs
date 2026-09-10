/**
 * 校验与翻译的测试。
 *
 * 这一层的价值全在「把错误挡在运行之前，并且说清楚为什么」。
 * 所以测试重点是：**拒绝的理由**是否具体、**默认值**是否安全、
 * 以及工具策略有没有被真的落到 DSH 的 ToolRestriction 上。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_META,
  defaultConfig,
  applyConfigPatch,
  describeConfig,
  normalizeConfig,
  resolveDbPath,
  validateConfigPatch,
} from '../lib/src/config.js';
import {
  READONLY_TOOL_ALLOW,
  describeToolPolicy,
  findNameConflict,
  toAgentOptions,
  toToolFilter,
  validateAgentInput,
} from '../lib/src/registry.js';

/** 一份「本机可用路由/传输」的目录快照。 */
const catalog = {
  routes: [
    {
      id: 'deepseek-official',
      models: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1' }],
      credential: { ref: 'DEEPSEEK_API_KEY', configured: true, source: 'env', writable: false },
    },
  ],
  transports: [
    { name: 'spawn', supportsModelBinding: true },
    { name: 'fork', supportsModelBinding: false },
  ],
};

/** 一个合法的输入。 */
const valid = {
  name: '研究员',
  transport: 'spawn',
  modelProvider: 'deepseek-official',
  modelId: 'deepseek-v4.1-flash',
};

test('合法输入被接受，字段被归一化', () => {
  const result = validateAgentInput({ ...valid, name: '  研究员  ', note: ' 备注 ' }, { mode: 'create', catalog });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.name, '研究员', '名字首尾空白应被去掉');
  assert.equal(result.value.note, '备注');
  assert.equal(result.value.toolPolicy, 'inherit', '工具策略默认继承父级（已确认的决策）');
  assert.equal(result.value.maxContext, 0);
});

test('名字是 @ 句柄：空白与过长都要拒绝，并说明原因', () => {
  const spaced = validateAgentInput({ ...valid, name: '研 究 员' }, { mode: 'create', catalog });
  assert.equal(spaced.ok, false);
  assert.match(spaced.errors.join(' '), /空白字符/);
  assert.match(spaced.errors.join(' '), /token/, '要解释为什么（@ 按空格切分），而不是只说「非法」');

  const tooLong = validateAgentInput({ ...valid, name: 'x'.repeat(49) }, { mode: 'create', catalog });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.errors.join(' '), /48/);

  const empty = validateAgentInput({ ...valid, name: '   ' }, { mode: 'create', catalog });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(' '), /必填/);
});

test('agent 提供商：未知要拒绝，不支持模型绑定的更要拒绝', () => {
  const unknown = validateAgentInput({ ...valid, transport: 'acp' }, { mode: 'create', catalog });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /未知的 agent 提供商/);
  assert.match(unknown.errors.join(' '), /spawn, fork/, '错误里要列出本机可用项');

  const noBinding = validateAgentInput({ ...valid, transport: 'fork' }, { mode: 'create', catalog });
  assert.equal(noBinding.ok, false);
  assert.match(
    noBinding.errors.join(' '), /不支持 agentOptions/,
    '这是本插件的立足点：不能指定模型的传输必须在保存前就被拒绝',
  );
});

test('模型提供商：未知要拒绝；模型不在清单里只警告不拒绝', () => {
  const unknownProvider = validateAgentInput({ ...valid, modelProvider: '不存在的路由' }, { mode: 'create', catalog });
  assert.equal(unknownProvider.ok, false);
  assert.match(unknownProvider.errors.join(' '), /未知的模型提供商/);

  // DSH 的模型清单可能不完整（新模型、适配器自带目录），而权威判断在 DSH 自己那里，
  // 所以这里只警告——挡住反而是越权。
  const unknownModel = validateAgentInput({ ...valid, modelId: '还没发布的模型' }, { mode: 'create', catalog });
  assert.equal(unknownModel.ok, true);
  assert.match(unknownModel.warnings.join(' '), /不在/);
});

test('凭据未配置时给出警告（但仍是合法配置）', () => {
  const result = validateAgentInput(
    { ...valid, credentialRef: 'MISSING_KEY' },
    {
      mode: 'create',
      catalog: { ...catalog, routes: [{ ...catalog.routes[0], credential: { ref: 'MISSING_KEY', configured: false, source: 'unknown', writable: false } }] },
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /尚未配置/);
});

test('数值字段：非整数或负数被拒绝', () => {
  const negative = validateAgentInput({ ...valid, maxContext: -5 }, { mode: 'create', catalog });
  assert.equal(negative.ok, false);
  assert.match(negative.errors.join(' '), /maxContext/);

  const fractional = validateAgentInput({ ...valid, maxTokens: 1.5 }, { mode: 'create', catalog });
  assert.equal(fractional.ok, false);
  assert.match(fractional.errors.join(' '), /maxTokens/);
});

test('工具策略枚举被约束', () => {
  const bad = validateAgentInput({ ...valid, toolPolicy: 'read-only' }, { mode: 'create', catalog });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /inherit \| readonly \| none/);
});

test('update 模式：未提供的字段沿用原值', () => {
  const existing = {
    name: '研究员', transport: 'spawn', modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1-flash',
    apiBase: 'https://api.deepseek.com', credentialRef: 'DEEPSEEK_API_KEY', maxContext: 100000,
    maxTokens: 4096, reasoningEffort: 'high', toolPolicy: 'inherit', persona: '', note: '',
  };
  const result = validateAgentInput({ toolPolicy: 'none' }, { mode: 'update', existing, catalog });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.name, '研究员', '没提供的字段必须保持原值');
  assert.equal(result.value.maxContext, 100000);
  assert.equal(result.value.reasoningEffort, 'high');
  assert.equal(result.value.toolPolicy, 'none', '提供了的字段要用新值');
});

test('非对象请求体被拒绝而不是崩溃', () => {
  for (const body of [null, [], 'x', 42]) {
    const result = validateAgentInput(body, { mode: 'create', catalog });
    assert.equal(result.ok, false, `body=${JSON.stringify(body)} 应当被拒绝`);
  }
});

test('AgentOptions 翻译：只带 DSH 真正支持的字段', () => {
  const options = toAgentOptions({
    modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1-flash',
    reasoningEffort: '', maxTokens: 0, maxContext: 999999,
  });
  assert.deepEqual(options, { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' });
  assert.equal('maxContext' in options, false, 'AgentOptions 没有上下文窗口字段——绝不能假装能设');

  const withExtras = toAgentOptions({
    modelProvider: 'p', modelId: 'm', reasoningEffort: 'high', maxTokens: 8192,
  });
  assert.deepEqual(withExtras, { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 8192 });
});

test('工具策略 → ToolRestriction：inherit 不传，none 是空白名单，readonly 是 fail-closed 白名单', () => {
  assert.equal(toToolFilter({ toolPolicy: 'inherit' }, []), undefined, 'inherit 不该传 toolFilter');
  assert.deepEqual(toToolFilter({ toolPolicy: 'none' }, []), { allow: [] });
  assert.deepEqual(toToolFilter({ toolPolicy: 'readonly' }, []), { allow: [...READONLY_TOOL_ALLOW] });

  // 用户覆盖白名单。
  const custom = toToolFilter({ toolPolicy: 'readonly' }, ['read', 'glob']);
  assert.deepEqual(custom, { allow: ['read', 'glob'] });

  // 描述要如实说明「强制」与「fail-closed」，不能让人以为只是建议。
  const detail = describeToolPolicy({ toolPolicy: 'readonly' }, []);
  assert.equal(detail.enforced, true);
  assert.match(detail.summary, /fail-closed/);
  assert.match(detail.summary, /未列出的工具一律不可见且不可执行/);

  const inheritDetail = describeToolPolicy({ toolPolicy: 'inherit' }, []);
  assert.equal(inheritDetail.enforced, false, 'inherit 不该声称强制了什么');
  assert.equal(inheritDetail.allow, null);
});

test('重名检查：只判未归档范围，且更新自己时不算冲突', () => {
  const store = {
    getAgentByName: (name) => (name === '研究员' ? { id: 'a1' } : undefined),
  };
  assert.match(findNameConflict({ store }, '研究员') ?? '', /必须唯一/);
  assert.equal(findNameConflict({ store }, '研究员', 'a1'), null, '更新自己不该报冲突');
  assert.equal(findNameConflict({ store }, '别的名字'), null);
});

test('配置归一化：未知键与类型不符都只警告，并且保留默认值', () => {
  const defaults = defaultConfig();
  const { config, warnings } = normalizeConfig(
    { maxConcurrentRuns: 4, 未知键: 1, runTimeoutMs: '很久' },
    { maxConcurrentRuns: 8, retentionDays: 30 },
  );

  assert.equal(config.maxConcurrentRuns, 8, '用户层覆盖部署层');
  assert.equal(config.runTimeoutMs, defaults.runTimeoutMs, '类型不符应保留默认值');
  assert.equal(config.retentionDays, 30);
  assert.ok(warnings.some((line) => line.includes('未知键')), `应当警告未知键：${warnings.join(' | ')}`);
  assert.ok(warnings.some((line) => line.includes('runTimeoutMs')), '应当指出哪个键类型不符');
});

test('配置归一化：非对象层被忽略', () => {
  const { config, warnings } = normalizeConfig(undefined, 'not an object');
  assert.equal(config.maxConcurrentRuns, defaultConfig().maxConcurrentRuns);
  assert.match(warnings.join(' '), /expected an object/);
});

test('dbPath 解析：空值走默认路径，显式值被采用', () => {
  assert.match(resolveDbPath({ dbPath: '' }, 'D:\\data'), /subagent-hub\.db$/);
  assert.equal(resolveDbPath({ dbPath: ' D:\\x\\mine.db ' }, 'D:\\data'), 'D:\\x\\mine.db');
});

test('界面改配置：只接受已知键、类型要对、运行中不可能生效的要明确拒绝', () => {
  const current = defaultConfig();

  const ok = validateConfigPatch({ maxConcurrentRuns: 4 }, current);
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.deepEqual(ok.value, { maxConcurrentRuns: 4 });

  // 未知键：拒绝，并点名。
  const unknown = validateConfigPatch({ 并发上限: 4 }, current);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /未知配置项 "并发上限"/);

  // 类型不符：拒绝。写下去的值会持久化，静默纠正等于把错误固化。
  for (const bad of [-1, 0, 1.5, '4', null, []]) {
    const result = validateConfigPatch({ maxConcurrentRuns: bad }, current);
    assert.equal(result.ok, false, `maxConcurrentRuns=${JSON.stringify(bad)} 应当被拒绝`);
  }

  // 运行中不可能生效的项：拒绝，而且必须告诉用户「去哪改、要不要重启」。
  for (const key of Object.keys(CONFIG_META).filter((name) => CONFIG_META[name].live !== true)) {
    const result = validateConfigPatch({ [key]: key === 'logToStdout' ? false : 'D:/x.db' }, current);
    assert.equal(result.ok, false, `${key} 不该能在界面里改`);
    assert.match(result.errors.join(' '), /不能在界面里改/);
    assert.match(result.errors.join(' '), /config\.json/, `${key} 的拒绝理由要指出配置文件`);
  }

  // 值没变就不算改动（避免写一堆无意义的 diff）。
  const same = validateConfigPatch({ maxConcurrentRuns: current.maxConcurrentRuns }, current);
  assert.equal(same.ok, true);
  assert.deepEqual(same.value, {});

  // 非对象体。
  for (const body of [null, [], 'x', 42]) {
    assert.equal(validateConfigPatch(body, current).ok, false);
  }
});

test('界面改配置：数组类型的白名单也能改', () => {
  const current = defaultConfig();
  const result = validateConfigPatch({ readonlyToolAllow: ['read', 'glob'] }, current);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.value.readonlyToolAllow, ['read', 'glob']);

  const bad = validateConfigPatch({ readonlyToolAllow: ['read', 42] }, current);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /readonlyToolAllow/);
});

test('写配置：落盘 + 就地改内存对象 + 保留文件里原有的其它键', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbh-cfg-'));
  try {
    // 用户手写过的东西不该被界面上的一次保存抹掉。
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ retentionDays: 7, 手写的键: '保留我' }), 'utf8');

    const live = defaultConfig();
    live.retentionDays = 7;
    const result = applyConfigPatch(dir, live, { maxConcurrentRuns: 5 });

    assert.equal(live.maxConcurrentRuns, 5, '内存里的配置必须立刻变（运行时读的就是它）');
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(written.maxConcurrentRuns, 5);
    assert.equal(written.retentionDays, 7, '本次没动的键要保留');
    assert.equal(written['手写的键'], '保留我', '用户手写的未知键也不能被抹掉');
    assert.match(result.file, /config\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置视图：每个键都带 live 标志与人话说明', () => {
  const items = describeConfig(defaultConfig(), 'D:\\data');
  const byKey = new Map(items.map((item) => [item.key, item]));

  // 并发上限必须可热改——这是用户明确要求的。
  assert.equal(byKey.get('maxConcurrentRuns').live, true);
  assert.match(byKey.get('maxConcurrentRuns').label, /并发/);
  assert.ok(byKey.get('maxConcurrentRuns').hint.length > 10, '要有人话说明，不能只有键名');

  // 结构性不可热改的项，标志必须如实为 false 且说明原因。
  assert.equal(byKey.get('dbPath').live, false);
  assert.match(byKey.get('dbPath').hint, /启动/);

  // 每个键都要有 label 与 hint（界面直接渲染它们）。
  for (const item of items) {
    assert.ok(typeof item.label === 'string' && item.label !== '', `${item.key} 缺 label`);
    assert.ok(typeof item.hint === 'string' && item.hint !== '', `${item.key} 缺 hint`);
  }
});
