/**
 * 版本兼容性判定的测试。
 *
 * 这一层的价值全在**边界**上：`0.1.2-rc.1` 这种预发布版本号是最容易被朴素比较写错的地方,
 * 而错了的后果不是崩溃，是「该警告的没警告」或「不该警告的乱警告」——
 * 两者都会让人不再相信这条警告。所以下面把边界成对地钉住。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  TESTED_HARNESS_VERSION,
  SUPPORTED_HARNESS_RANGE,
  compareVersions,
  describeHarness,
  detectHarness,
  harnessWarning,
  parseVersion,
  satisfies,
} from '../lib/src/version.js';

/**
 * 造一个最小的 DSH 安装布局，并把 `process.argv[1]` 指向它的入口脚本。
 * @param {string} version - 要假装安装的 DSH 版本。
 * @param {{bom?:boolean}} [options] - 额外选项。
 * @returns {string} 临时根目录（调用方负责清理）。
 */
function fakeHarnessInstall(version, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sbh-ver-'));
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(dshDir, 'lib'), { recursive: true });
  const manifest = JSON.stringify({ name: '@deepseek-ai/dsh', version });
  writeFileSync(
    join(dshDir, 'package.json'),
    options.bom === true ? `\uFEFF${manifest}` : manifest,
  );
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '');
  process.argv[1] = join(dshDir, 'lib', 'bin.js');
  return root;
}

test('解析版本号：接受预发布标识，拒绝垃圾输入', () => {
  assert.deepEqual(parseVersion('0.1.2-rc.1'), { segments: [0, 1, 2], prerelease: ['rc', '1'] });
  assert.deepEqual(parseVersion('v0.1.2'), { segments: [0, 1, 2], prerelease: [] });
  assert.deepEqual(parseVersion('1.2'), { segments: [1, 2], prerelease: [] });
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion(42), null);
});

test('比较版本号：主版本优先', () => {
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1);
  assert.equal(compareVersions('0.1.3', '0.1.2'), 1);
  assert.equal(compareVersions('0.1.2', '0.1.2'), 0);
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1);
  assert.equal(compareVersions('0.1', '0.1.0'), 0, '缺位要按 0 补齐');
  assert.equal(compareVersions('junk', '0.1.0'), null);
});

test('比较版本号：预发布标识低于同号正式版', () => {
  // 这是最关键的一对：把 rc 当成「更高」会让 0.1.2-rc.1 < 0.1.2 判反，区间下界就会失效。
  assert.equal(compareVersions('0.1.2-rc.1', '0.1.2'), -1);
  assert.equal(compareVersions('0.1.2', '0.1.2-rc.1'), 1);
  assert.equal(compareVersions('0.1.2-rc.1', '0.1.2-rc.2'), -1);
  assert.equal(compareVersions('0.1.2-rc.10', '0.1.2-rc.9'), 1, '数字标识符要按数值比，不能按字符串比');
  assert.equal(compareVersions('0.1.2-alpha', '0.1.2-beta'), -1);
  assert.equal(compareVersions('0.1.2-1', '0.1.2-alpha'), -1, '数字标识符优先级低于字母');
  assert.equal(compareVersions('0.1.2-rc', '0.1.2-rc.1'), -1, '标识符少的一方更低');
});

test('区间判定：下界含、上界不含', () => {
  assert.equal(satisfies('0.1.2-rc.1'), true, '下界自身必须算通过（否则等于声明了自己都不兼容）');
  assert.equal(satisfies('0.1.2'), true, '同号的正式版高于下界，应当通过');
  assert.equal(satisfies('0.1.9'), true, '同一 0.1.x 内应当通过');
  assert.equal(satisfies(TESTED_HARNESS_VERSION), true);

  assert.equal(satisfies('0.1.2-rc.0'), false, '低于下界');
  assert.equal(satisfies('0.1.1'), false, '低于下界');
  assert.equal(satisfies('0.2.0'), false, '上界自身必须被排除');
  assert.equal(satisfies('1.0.0'), false);
  assert.equal(satisfies('junk'), false, '无法判定按保守拒绝');
});

test('区间声明与已验证版本自洽', () => {
  assert.equal(SUPPORTED_HARNESS_RANGE, '>=0.1.2-rc.1 <0.2.0');
  assert.equal(satisfies(TESTED_HARNESS_VERSION), true, '声明区间必须包含自己验证过的版本');
});

test('区间外（0.2.5）必须给出 false 与一条可读警告', () => {
  const saved = process.argv[1];
  const root = fakeHarnessInstall('0.2.5');
  try {
    const info = describeHarness(undefined);
    assert.equal(info.detected, '0.2.5');
    assert.equal(info.compatible, false, '超出上界必须是 false，而不是 null');

    const warning = harnessWarning(undefined);
    assert.equal(typeof warning, 'string', '区间外必须产出警告，否则就是静默降级');
    assert.match(warning, /0\.2\.5/, '警告里要有检测到的版本，否则用户不知道自己在跑什么');
    assert.match(warning, /0\.1\.2-rc\.1/, '警告里要有已验证版本');
    assert.match(warning, /health/, '警告里要指出去哪里看被关掉的能力');
  } finally {
    process.argv[1] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('区间内（0.1.9）不产警告', () => {
  const saved = process.argv[1];
  const root = fakeHarnessInstall('0.1.9');
  try {
    assert.equal(describeHarness(undefined).compatible, true);
    assert.equal(harnessWarning(undefined), null, '兼容时不该打扰用户');
  } finally {
    process.argv[1] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('低于下界的预发布版（0.1.2-rc.0）判为不兼容', () => {
  const saved = process.argv[1];
  const root = fakeHarnessInstall('0.1.2-rc.0');
  try {
    assert.equal(describeHarness(undefined).compatible, false);
    assert.notEqual(harnessWarning(undefined), null);
  } finally {
    process.argv[1] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('带 BOM 的 package.json 也要能解析（Windows 工具常常写出 BOM）', () => {
  const saved = process.argv[1];
  const root = fakeHarnessInstall('0.1.5', { bom: true });
  try {
    // JSON.parse 遇到 BOM 会抛错；不处理的话这里会退化成「无法判定」。
    assert.equal(detectHarness(undefined).version, '0.1.5', 'BOM 不该让版本探测失效');
  } finally {
    process.argv[1] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectHarness：从 dsh 入口脚本解析版本', () => {
  const saved = process.argv[1];
  const root = fakeHarnessInstall('0.1.2-rc.1');
  try {
    // ctx 传 undefined：走不到服务，只能靠锚点。
    const seen = detectHarness(undefined);
    assert.equal(seen.version, '0.1.2-rc.1', '必须能从入口脚本解析到版本');
    assert.equal(seen.source, 'dsh entry');
    assert.equal(seen.reason, null);
  } finally {
    process.argv[1] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectHarness：版本服务优先于磁盘', () => {
  const ctx = { get: (name) => (name === 'dshVersion' ? '0.1.5' : undefined) };
  const seen = detectHarness(ctx);
  assert.equal(seen.version, '0.1.5');
  assert.equal(seen.source, 'ctx.dshVersion');
  assert.equal(seen.path, null, '来自服务的版本没有 manifest 路径');
});

test('detectHarness：服务里的垃圾值不算数，要退回磁盘探测', () => {
  const ctx = { get: (name) => (name === 'dshVersion' ? 'not-a-version' : undefined) };
  const seen = detectHarness(ctx);
  assert.notEqual(seen.source, 'ctx.dshVersion');
});

test('无法判定必须是 null，不能折叠成 true 或 false', () => {
  const saved = process.argv[1];
  process.argv[1] = '/definitely/not/a/dsh/install/bin.js';
  let info;
  try {
    info = describeHarness(undefined);
  } finally {
    process.argv[1] = saved;
  }
  assert.equal(info.detected, null);
  assert.notEqual(info.compatible, true, '判不出来时绝不能声称兼容');
  assert.notEqual(info.compatible, false, '判不出来时也不该声称不兼容');
  assert.equal(info.compatible, null);
  assert.equal(typeof info.reason, 'string', '判不出来必须给出原因，否则用户无从下手');
  assert.equal(info.tested, TESTED_HARNESS_VERSION);
  assert.equal(info.supported, SUPPORTED_HARNESS_RANGE);
});

test('/health 用的描述里不含 manifest 绝对路径', () => {
  const info = describeHarness({ get: () => undefined });
  assert.equal(Object.hasOwn(info, 'path'), false, '不要把本机安装路径塞进响应里');
});
