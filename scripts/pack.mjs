/**
 * 打包成可安装的 tgz，并把源码一并装进去（方便开源与二次开发）。
 *
 * 与 `npm pack` 的关系：本脚本就是包一层 npm pack，额外做两件 npm 不管的事：
 *  1. **打之前先跑自检**（分片与产物一致、语法、编码）——打出一个坏包比不打包更糟，
 *     因为它会被装到别的机器上，而那些机器上没有你的调试环境。
 *  2. **列出包里到底有什么**，以及把安装命令直接打印出来。
 *
 * 为什么用 `node <npm-cli.js>` 而不是直接 spawn `npm`：Windows 上 spawn 一个 `.cmd`
 * 会 EINVAL（Node 的安全策略），所以走 node 直接跑 npm 的入口脚本。
 *
 * 用法：
 *   node scripts/pack.mjs            # 自检 → 打包 → 列内容
 *   node scripts/pack.mjs --no-check # 跳过自检（不推荐）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const skipCheck = process.argv.includes('--no-check');

/**
 * 跑一条命令并回显（npm 的输出直接透传给用户）。
 * @param {string} file - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {object} [options] - 选项。
 * @returns {string} stdout。
 */
function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

// ---- 1. 自检 ----
if (!skipCheck) {
  const clientPath = join(root, 'lib', 'client.js');
  const partsDir = join(root, 'lib', 'parts');
  const parts = readdirSync(partsDir).filter((name) => name.endsWith('.js')).sort();
  const expected = parts.map((name) => readFileSync(join(partsDir, name), 'utf8')).join('');
  if (readFileSync(clientPath, 'utf8') !== expected) {
    console.error('✖ lib/client.js 与 lib/parts 不一致：先跑 node scripts/build-client.mjs');
    process.exit(1);
  }
  const bundle = readFileSync(clientPath, 'utf8');
  const replacement = (bundle.match(/\uFFFD/g) ?? []).length;
  if (replacement > 0) {
    console.error(`✖ 客户端产物里有 ${replacement} 个 U+FFFD，编码被破坏了，拒绝打包`);
    process.exit(1);
  }
  // 语法自检：宿主半边全是 ESM，客户端是 classic script，都能被 --check 覆盖。
  for (const file of [clientPath, join(root, 'lib', 'host.js')]) {
    try {
      run(process.execPath, ['--check', file], { capture: true });
    } catch (error) {
      console.error(`✖ 语法检查失败：${file}\n${error.stdout ?? ''}`);
      process.exit(1);
    }
  }
  console.log('✔ 自检通过（产物与分片一致、无编码破坏、语法正常）');
}

// ---- 2. 打包 ----
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 找 npm 自己的入口脚本，绕开 Windows 上 spawn .cmd 的 EINVAL。
const npmCli = join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const useNpmCli = existsSync(npmCli);
const packer = useNpmCli ? process.execPath : 'npm.cmd';
const packArgs = (useNpmCli ? [npmCli] : []).concat(['pack', '--pack-destination', distDir, '--json']);

let raw;
try {
  raw = run(packer, packArgs, { capture: true });
} catch (error) {
  console.error(`✖ 打包失败：${error.stderr ?? error.message}`);
  process.exit(1);
}

const jsonStart = raw.indexOf('[');
const report = JSON.parse(raw.slice(jsonStart));
const entry = report[0];
const tarball = join(distDir, entry.filename);

// ---- 3. 报告 ----
const sizeMb = (statSync(tarball).size / 1024 / 1024).toFixed(2);
console.log(`\n✔ 打包完成：${tarball}`);
console.log(`  文件 ${entry.entryCount} 个，解包后 ${(entry.unpackedSize / 1024 / 1024).toFixed(2)} MB，压缩后 ${sizeMb} MB`);

/** 按顶层目录归类，让人一眼看出包里有什么。 */
const groups = new Map();
for (const file of entry.files) {
  const top = file.path.includes('/') ? `${file.path.split('/')[0]}/` : file.path;
  const group = groups.get(top) ?? { count: 0, bytes: 0 };
  group.count += 1;
  group.bytes += file.size;
  groups.set(top, group);
}
console.log('\n  包内构成：');
for (const [name, group] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`    ${name.padEnd(22)} ${String(group.count).padStart(4)} 个文件  ${(group.bytes / 1024).toFixed(0).padStart(6)} KB`);
}

console.log('\n  在另一台机器上安装：');
console.log(`    dsh plugin --profile web add ${tarball.replace(/\\/g, '/')}`);
console.log('    # 然后重启 dsh web');
console.log('\n  前提（那台机器上也要有）：');
console.log('    - DSH 本体（@deepseek-ai/dsh），且 web profile 可用');
console.log('    - Node ^22.19.0 || >=24（node:sqlite 是内置的，不需要额外依赖）');
console.log('    - 本插件零运行时依赖：不装任何第三方包');
