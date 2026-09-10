/**
 * 契约测试：锁住「两半之间」与「插件与 DSH 之间」那些**不能漂移**的常量。
 *
 * 这类测试的价值在于失败得很早、很明确。如果不锁，漂移的表现通常是运行时症状——
 * 面板空白（端点前缀不一致）、插件静默不加载（loader entry 的 name 与包名不一致）、
 * 依赖悄悄溜进客户端 bundle（require 到不存在的模块）——
 * 这些都要花很久才能定位，而这里读一遍源码文本就能挡住。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/**
 * 读出 lib 下所有 .js 的文本。
 *
 * 只做文本匹配、不做 AST 解析：这类契约要挡的是「字符串常量漂移」与
 * 「不该出现的 import 出现了」，正则足够且更不容易因为语法演进失效。
 * @returns {{path:string,text:string}[]}
 */
function readLib() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(join(root, 'lib'));
  return files.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

const manifest = JSON.parse(read('package.json'));
const client = read('lib/client.js');
const host = read('lib/host.js');
const patch = read('cordis.patch.yml');

test('包名在三处必须一致：package.json / 客户端注册 id / loader entry 的 name', () => {
  const registerId = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*"([^"]+)"/.exec(client)?.[1];
  assert.equal(registerId, manifest.name, '客户端注册 id 必须等于包名（客户端模块系统按它装配）');

  const entryName = /name:\s*(\S+)/.exec(patch)?.[1];
  assert.equal(entryName, manifest.name, 'cordis.patch.yml 的 entry name 必须等于包名（它是客户端 roster 的唯一输入）');
});

test('版本号在 package.json 与宿主常量之间一致', () => {
  const version = /export const VERSION = '([^']+)'/.exec(host)?.[1];
  assert.equal(version, manifest.version, 'host.js 的 VERSION 必须跟 package.json 一致（/health 会报它）');
});

test('端点前缀在宿主与客户端之间一致', () => {
  const hostPrefix = /export const ROUTE_PREFIX = '([^']+)'/.exec(read('lib/src/http.js'))?.[1];
  const clientEndpoint = /const ENDPOINT = "([^"]+)"/.exec(client)?.[1];
  assert.ok(hostPrefix !== undefined, 'host 侧必须导出 ROUTE_PREFIX');
  assert.equal(clientEndpoint, hostPrefix, '客户端 ENDPOINT 必须等于宿主 ROUTE_PREFIX，否则面板会空白');
  assert.equal(hostPrefix, '/sub-agent/api');
});

test('客户端 bundle 只 require("react")', () => {
  // 提取所有 require("...") 的实参。
  const specifiers = [...client.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
  // 工厂的参数名是 require，所以只统计字符串字面量调用。
  const unique = [...new Set(specifiers)];
  assert.deepEqual(unique, ['react'], `DSH 只暴露 8 个平台种子模块，本 bundle 只允许用 react；实际：${unique.join(', ')}`);
});

test('DSH 兼容区间在三处一致：version.js / package.json 的 dsh.harness / peerDependencies', async () => {
  const { SUPPORTED_HARNESS_RANGE, TESTED_HARNESS_VERSION } = await import('../lib/src/version.js');

  assert.equal(
    manifest.dsh.harness.tested, TESTED_HARNESS_VERSION,
    'package.json 的 dsh.harness.tested 必须与 version.js 的 TESTED_HARNESS_VERSION 一致',
  );
  assert.equal(
    manifest.dsh.harness.supported, SUPPORTED_HARNESS_RANGE,
    'package.json 的 dsh.harness.supported 必须与 version.js 的 SUPPORTED_HARNESS_RANGE 一致',
  );

  // peerDependencies 用的 caret 写法必须与代码内声明的区间**语义等价**：
  // `^0.1.2-rc.1` 在 0.x 下等价于 `>=0.1.2-rc.1 <0.2.0`。两者漂移意味着
  // 包管理器看到的兼容范围和插件自己警告的范围不是同一件事。
  assert.equal(
    manifest.peerDependencies['@deepseek-ai/dsh'], `^${TESTED_HARNESS_VERSION}`,
    'peerDependencies 必须用 caret 表达同一区间（0.x 下 caret 的上界就是下一个次版本）',
  );
  assert.equal(
    manifest.peerDependenciesMeta['@deepseek-ai/dsh'].optional, true,
    'DSH 是 peer 而非依赖：必须 optional，否则装插件时会去拉一份 DSH 本体',
  );
  // caret 与区间写法的等价性由下面的显式断言钉死，避免有人把上界改成 0.3.0。
  assert.equal(SUPPORTED_HARNESS_RANGE, '>=0.1.2-rc.1 <0.2.0');
  assert.match(SUPPORTED_HARNESS_RANGE, /<0\.2\.0$/, '上界必须是下一个次版本，放开等于假装兼容没验证过的东西');
});

test('宿主半边不依赖任何 @deepseek-ai/* 包', () => {  const offenders = [];
  for (const file of readLib()) {
    if (file.path.endsWith(`client.js`)) continue;
    if (/from\s+'@deepseek-ai\//.test(file.text) || /require\(\s*'@deepseek-ai\//.test(file.text)) {
      offenders.push(file.path.replace(root, ''));
    }
  }
  assert.deepEqual(
    offenders, [],
    `宿主通过 ctx.get() 取服务，因此不该 import DSH 的内部包（否则升级会漂移）；违规：${offenders.join(', ')}`,
  );
});

test('客户端注册的插槽名与 DSH 的真实插槽一致', () => {
  // 这两个名字来自只读勘察：`conversation.input.right` 是输入框底部那一行的加法座位
  // （发送按钮与模型选择器之前），`shell.overlay` 是全应用浮层。
  const slots = [...client.matchAll(/ctx\.slots\.inject\(\s*([A-Z_]+)/g)].map((match) => match[1]);
  assert.ok(slots.includes('TOGGLE_SLOT'), '开关必须通过 TOGGLE_SLOT 常量注册');
  assert.ok(slots.includes('OVERLAY_SLOT'), '悬浮球必须通过 OVERLAY_SLOT 常量注册');
  assert.match(client, /const TOGGLE_SLOT = "conversation\.input\.right"/, 'TOGGLE_SLOT 必须是 conversation.input.right');
  assert.match(client, /const OVERLAY_SLOT = "shell\.overlay"/, 'OVERLAY_SLOT 必须是 shell.overlay');
});

test('manifest 完整性：dsh.bundle / dsh.client / exports / files', () => {
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './lib/host.js');
  assert.equal(manifest.exports['.'], './lib/host.js');
  assert.equal(manifest.exports['./client'], './lib/client.js', '客户端入口是 exports["./client"]，没有默认值');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch 是让它成为 profile 层的唯一声明');
  assert.equal(manifest.dsh.client.platform, 'web', 'platform 必须字面量等于 "web"，否则整包被忽略');
  assert.deepEqual(manifest.dsh.client.inject, [], 'dsh.client.inject 是包名到达顺序，本插件不依赖别的插件行');
  assert.ok(manifest.files.includes('lib'), 'files 必须包含 lib（否则打包后没有代码）');
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml');
});

test('宿主 inject 只声明 webServer（其余靠防御式 ctx.get）', () => {
  const injectLine = /export const inject = \[([^\]]*)\]/.exec(host)?.[1] ?? '';
  const services = injectLine.split(',').map((item) => item.trim().replace(/['"]/g, '')).filter((item) => item !== '');
  assert.deepEqual(services, ['webServer'], `inject 里只该有离了它插件就不该存在的服务；实际：${services.join(', ')}`);
  // patch 文件里的 inject 也要一致，否则 fiber 的等待集合与代码不一致。
  assert.match(patch, /inject:\s*\n\s*-\s*webServer/, 'cordis.patch.yml 的 inject 必须与 host.js 一致');
});

test('每个 eval 出来的宿主模块都能被解析（防止漏写文件）', () => {
  // host.js 里 import 的相对路径必须真实存在。
  const imports = [...host.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 0, 'host.js 应当 import 各个 src 模块');
  for (const specifier of imports) {
    const target = join(root, 'lib', specifier.replace(/^\.\//, ''));
    assert.ok(existsSync(target), `host.js import 了不存在的文件：${specifier}`);
  }
});

test('样式类名都有对应定义（防止改版漏写 CSS 导致元素静默无样式）', () => {
  // 只检查本插件自己的 sbh- 前缀类名。
  //
  // 注意要把模板字符串里的 `${...}` 一并收进来：条件类名（例如
  // `sbh-toggle${enabled ? " sbh-toggle--on" : ""}`）里的名字才是最容易漏写 CSS 的那批。
  // 所以做法是从每个 className 字面量里**抽出所有** sbh- token，而不是先剥掉插值。
  const used = new Set();
  for (const match of client.matchAll(/className:\s*([`"])([\s\S]*?)\1/g)) {
    for (const token of match[2].match(/sbh-[a-z0-9-]+/g) ?? []) used.add(token);
  }
  assert.ok(used.size >= 10, `应当从 className 里抽出足够多的类名，实际只抽出 ${used.size} 个：${[...used].join(', ')}`);

  const missing = [...used].filter((name) => !client.includes(`.${name}`));
  assert.deepEqual(missing, [], `这些类名在 className 里用到但 CSS 里没有定义：${missing.join(', ')}`);
});

test('客户端对未启用的自我约束：悬浮球在没有启用时不渲染', () => {
  assert.match(client, /if \(state\.enabled !== true\) return null/, '悬浮球必须严格以「已启用」为渲染前提');
});

test('运行状态枚举在 store 与 UI 之间保持一致', async () => {
  const { RUN_STATUSES } = await import('../lib/src/store.js');
  assert.deepEqual([...RUN_STATUSES], ['queued', 'running', 'completed', 'error', 'timeout', 'cancelled']);
  // 客户端按 status 上色，所以至少要认识终态里的几个。
  for (const status of ['completed', 'queued']) {
    assert.ok(client.includes(`"${status}"`), `客户端应当认识状态 "${status}"`);
  }
});

test('lib/client.js 必须与 lib/parts/*.js 完全一致（单一真相来源）', () => {
  // 客户端 bundle 必须是单文件，所以源码按片维护、构建时拼成一个文件。
  // 这带来一个隐患：**两个真相来源**。直接改产物、或改完分片忘了构建，都会让两者漂移，
  // 而漂移的表现是「改了不生效」——最难查的一类问题。
  // 所以这里把「产物 == 各分片按序拼接」钉死，让漂移在测试阶段就暴露。
  const partsDir = join(root, 'lib', 'parts');
  assert.ok(existsSync(partsDir), 'lib/parts 目录应当存在（客户端源码分片）');
  const parts = readdirSync(partsDir).filter((name) => name.endsWith('.js')).sort();
  assert.ok(parts.length > 0, '至少要有一个分片');

  const expected = parts.map((name) => readFileSync(join(partsDir, name), 'utf8')).join('');
  assert.equal(
    client,
    expected,
    'lib/client.js 与分片不一致：改客户端请改 lib/parts/*.js，然后跑 node scripts/build-client.mjs',
  );
});

test('客户端产物必须是干净的 UTF-8（没有替换符）', () => {
  // 中文是这个文件的绝大部分内容，编码一旦被破坏，代码可能仍然「能跑」而界面全是乱码。
  // 这条不是理论风险：这个文件真的被 PowerShell 的 ANSI 读写毁过一次，只能整体重写。
  const replacement = (client.match(/\uFFFD/g) ?? []).length;
  assert.equal(replacement, 0, `客户端源码里出现了 ${replacement} 个 U+FFFD 替换符，编码被破坏了`);
  // 抽查几个必须存在的中文文案（乱码时它们会消失）。
  for (const probe of ['子 agent 已启用', '运行护栏', '收起态：玻璃水球']) {
    assert.ok(client.includes(probe), `客户端源码里应当含有 "${probe}"（编码被破坏时会消失）`);
  }
});
