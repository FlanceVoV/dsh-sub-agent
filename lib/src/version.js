/**
 * DSH 版本兼容性判定。
 *
 * 为什么需要这一层：本插件大量使用 DSH 的**内部**接口（`ctx.subagents.start`、
 * `session/event` 的 `{global:true}` 语义、客户端 bundle 的装配约定等），
 * 而 DSH 本体还处在 `0.x` 阶段，这些内部结构随时可能变。
 * 插件对能力的姿态是防御式的（取不到就关掉那项能力），但这带来一个真实的失败模式：
 * **版本漂移会表现为「能力静默关闭」，而不是明确报错。**
 * 这一层的作用就是把「静默」变成「说出来」。
 *
 * 三条刻意的设计约束：
 *
 * 1. **绝不硬失败。** 版本不符只警告，不阻止加载。理由与 `inject` 里只写 webServer 同源：
 *    宁可功能降级并说清楚，也不要让整个插件起不来。
 * 2. **判不出来就说判不出来。** DSH 没有把版本做成服务（已核实：无 `ctx.get('version')`，
 *    `pluginInventory` 的 snapshot 也不带版本），唯一可靠来源是磁盘上的 `package.json`。
 *    探测不到时返回 `compatible: null` 并给出原因，**不猜、不假设通过**。
 * 3. **不 import 任何 `@deepseek-ai/*`。** 契约测试禁止宿主依赖 DSH 内部包；
 *    这里只用 `node:` 内置模块去**读一个路径**，不构成依赖。
 *
 * @module dsh-subagent-hub/version
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** DSH 包名（仅作为模块标识符字符串使用，不构成 import）。 */
const HARNESS_PACKAGE = '@deepseek-ai/dsh';

/**
 * 子路径用**拼接**而不是模板字符串字面量。
 *
 * 理由是诚实的：契约测试（tests/contract.test.mjs）用正则扫源码，挡住宿主侧对 DSH 内部包的
 * 任何 import。`require.resolve('@deepseek-ai/dsh/package.json')` 虽然只是**解析一个路径、
 * 不加载任何代码**，却会命中那条正则。拼接让它既能工作，也不会误触那条保护——
 * 前提是这里确实只用于读 package.json，将来若有人改成 import 真代码，拼接挡不住，
 * 所以 tests/version.test.mjs 里有一条专门盯着这件事的断言。
 */
const HARNESS_PACKAGE_SPECIFIER = `${HARNESS_PACKAGE}/package.json`;

/**
 * 本插件实际开发并验证过的 DSH 版本。**同时是 package.json 里 peerDependencies 的唯一真相来源**
 * （由 tests/contract.test.mjs 锁住，两者漂移会失败）。
 */
export const TESTED_HARNESS_VERSION = '0.1.2-rc.1';

/**
 * 声明的兼容区间：`>=0.1.2-rc.1 <0.2.0`。
 *
 * 为什么上界卡在 `0.2.0` 而不是更宽：`0.x` 的次版本号在语义化版本里允许破坏性变更，
 * 而本插件依赖的是**未公开的内部结构**，把上界放开等于假装兼容没验证过的东西。
 * 宁可让 `0.2.x` 的用户看到一条明确的警告，也不要让他们遇到「面板空白但没报错」。
 */
export const SUPPORTED_HARNESS_RANGE = '>=0.1.2-rc.1 <0.2.0';

/** 版本号形状：任意位数字段 + 可选的预发布标识。 */
const VERSION_SHAPE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * 解析版本号。
 * @param {unknown} text - 版本字符串。
 * @returns {{segments:number[], prerelease:string[]}|null} 解析结果；不合法返回 null。
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = VERSION_SHAPE.exec(text.trim());
  if (match === null) return null;
  return {
    segments: match[1].split('.').map((part) => Number(part)),
    prerelease: match[2] === undefined ? [] : match[2].split('.'),
  };
}

/**
 * 按语义化版本的规则比较两个版本号。
 * @param {string} left - 左操作数。
 * @param {string} right - 右操作数。
 * @returns {number|null} 负数 / 0 / 正数；任一侧不合法返回 null。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;

  const len = Math.max(a.segments.length, b.segments.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (a.segments[index] ?? 0) - (b.segments[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  // 主版本相同时：**有预发布标识的更低**（1.0.0-rc.1 < 1.0.0）。
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const preLen = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < preLen; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    // 数字标识符比字母标识符优先级低。
    if (lNum !== rNum) return lNum ? -1 : 1;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/**
 * 解析一个 `>=a <b` 形式的区间。
 * @param {string} range - 区间表达式。
 * @returns {{lower:string,upper:string}|null} 解析结果。
 */
function parseRange(range) {
  const match = /^\s*>=\s*(\S+)\s+<\s*(\S+)\s*$/.exec(range);
  if (match === null) return null;
  return { lower: match[1], upper: match[2] };
}

/**
 * 判断版本是否落在区间内（下界含、上界不含）。
 * @param {string} version - 待测版本。
 * @param {string} [range] - 区间表达式。
 * @returns {boolean} 落在区间内返回 true；无法判定时返回 false（保守）。
 */
export function satisfies(version, range = SUPPORTED_HARNESS_RANGE) {
  const bounds = parseRange(range);
  if (bounds === null) return false;
  const vsLower = compareVersions(version, bounds.lower);
  const vsUpper = compareVersions(version, bounds.upper);
  if (vsLower === null || vsUpper === null) return false;
  return vsLower >= 0 && vsUpper < 0;
}

/**
 * 用 `createRequire` 相对某个基准文件解析 DSH 的 package.json。
 *
 * 为什么必须有**基准文件**：插件是以 junction 形式装进 profile 的，
 * 其自身目录并不在 DSH 的 `node_modules` 树下，所以 `require.resolve('@deepseek-ai/dsh/package.json')`
 * 从插件目录出发必然是 MODULE_NOT_FOUND（实测确认）。必须借一个位于 DSH 树内的路径当锚点。
 *
 * @param {string} baseFile - DSH 树内的一个文件路径。
 * @param {string} label - 该锚点的名字（用于日志说明来源）。
 * @returns {{version:string,source:string,path:string}|null} 探测结果。
 */
function readManifestFrom(baseFile, label) {
  try {
    const require = createRequire(baseFile);
    const manifestPath = require.resolve(HARNESS_PACKAGE_SPECIFIER);
    // 防呆：解析到的必须是 DSH 自己，不能是某个碰巧导出同名子路径的包。
    if (!manifestPath.replace(/\\/g, '/').includes(HARNESS_PACKAGE_SPECIFIER)) return null;
    // 去掉 BOM：Windows 上不少工具（含 PowerShell 5.1 的 Set-Content）会写出带 BOM 的 UTF-8，
    // 而 JSON.parse 遇到 BOM 会直接抛错。原生 manifest 没有 BOM，但这层防护很便宜。
    const text = readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
    const version = JSON.parse(text).version;
    if (typeof version !== 'string' || version === '') return null;
    return { version, source: label, path: manifestPath };
  } catch {
    return null;
  }
}

/**
 * 探测当前宿主的 DSH 版本。
 *
 * 来源按可靠性排序：
 *  1. `ctx.get('dshVersion')` —— DSH 目前**并不提供**这个服务（已核实），先试是为了将来有就用；
 *  2. 从 `process.argv[1]`（`dsh` 的入口脚本）所在目录解析；
 *  3. 从 `DSH_HOME` 向上找挂载点。
 *
 * @param {object} [ctx] - 宿主上下文。
 * @returns {{version:string|null,source:string,path:string|null,reason:string|null}} 探测结果。
 */
export function detectHarness(ctx) {
  // 1. 万一将来 DSH 把版本做成了服务。
  try {
    const fromService = typeof ctx?.get === 'function' ? ctx.get('dshVersion') : undefined;
    if (typeof fromService === 'string' && parseVersion(fromService) !== null) {
      return { version: fromService, source: 'ctx.dshVersion', path: null, reason: null };
    }
  } catch {
    /* 服务取用失败不该影响后续探测 */
  }

  // 2. `process.argv[1]` 是 dsh 自己的入口脚本，是最强的锚点。
  const entry = process.argv?.[1];
  if (typeof entry === 'string' && entry !== '') {
    const found = readManifestFrom(entry, 'dsh entry');
    if (found !== null) return { ...found, reason: null };

    // 3. 顺带试一下从入口脚本的祖先目录找（覆盖 monorepo / 非标准布局）。
    let dir = dirname(entry);
    for (let depth = 0; depth < 5 && dir !== '' && dir !== dirname(dir); depth += 1) {
      const probe = readManifestFrom(join(dir, 'index.js'), 'dsh install');
      if (probe !== null) return { ...probe, reason: null };
      dir = dirname(dir);
    }
  }

  return {
    version: null,
    source: 'unavailable',
    path: null,
    reason: '未能从磁盘判定 DSH 版本（既没有 dshVersion 服务，也无法从 dsh 入口脚本解析到 @deepseek-ai/dsh/package.json）',
  };
}

/**
 * 描述当前宿主的版本与兼容性。
 *
 * @param {object} [ctx] - 宿主上下文。
 * @returns {{detected:string|null,source:string,tested:string,supported:string,compatible:boolean|null,reason:string|null}} 版本信息。
 */
export function describeHarness(ctx) {
  const detected = detectHarness(ctx);
  return {
    detected: detected.version,
    source: detected.source,
    // 刻意**不返回** manifest 的绝对路径：它是一个出现在 /health 响应里的本机安装路径，
    // 对排错没有增量价值，却会泄露机器布局。排错要看的是 source 与 reason。
    tested: TESTED_HARNESS_VERSION,
    supported: SUPPORTED_HARNESS_RANGE,
    // 三态是刻意的：true = 已验证兼容，false = 明确超出区间，null = 无法判定。
    // 把「无法判定」折叠成 true 或 false 都是在编造结论。
    compatible: detected.version === null ? null : satisfies(detected.version),
    reason: detected.reason,
  };
}

/**
 * 生成人类可读的兼容性警告；兼容或无法判定时返回 null。
 * @param {object} [ctx] - 宿主上下文。
 * @returns {string|null} 警告文案。
 */
export function harnessWarning(ctx) {
  const info = describeHarness(ctx);
  if (info.compatible !== false) return null;
  return `DSH 版本不在已验证区间内：检测到 ${info.detected}（来源 ${info.source}），`
    + `本插件针对 ${info.tested} 开发、声明兼容 ${info.supported}。`
    + '插件仍会加载并对缺失能力做防御式降级，但部分功能可能不工作——'
    + '请查看 /sub-agent/api/health 的 harness 字段与 capabilities，确认哪些能力被关掉了。';
}
