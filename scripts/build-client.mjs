/**
 * 把 lib/parts/*.js 按顺序拼成 lib/client.js；`--check` 只校验不写。
 *
 * 为什么要有这一步：客户端 bundle 必须是**单文件**（DSH 的客户端模块系统只暴露 8 个种子模块），
 * 但一次性写 2000 行容易出错、也难以复核，所以源码按片维护、发布前拼成一个文件。
 *
 * **分片是唯一的真相来源**，`lib/client.js` 是产物。
 * 直接改 client.js 会让两者漂移，所以 `--check` 会重算并比对，不一致就大声失败——
 * 「两个真相来源」如果不加约束，迟早会变成「谁也不知道哪个才对」。
 *
 * 用 Node 读写文件，**不用 PowerShell**：PS 5.1 的 Get-Content/Set-Content 会按 ANSI 代码页
 * 处理 UTF-8，把中文全变成乱码并且吞掉部分换行——这个坑真的踩过，整份文件只能重写。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const partsDir = join(root, 'lib', 'parts');
const target = join(root, 'lib', 'client.js');
const checkOnly = process.argv.includes('--check');

const parts = readdirSync(partsDir).filter((name) => name.endsWith('.js')).sort();
if (parts.length === 0) {
  console.error('没有分片可拼');
  process.exit(1);
}

const chunks = parts.map((name) => readFileSync(join(partsDir, name), 'utf8'));
const bundle = chunks.join('');

// 编码自检：产物必须是干净的 UTF-8，否则中文又会变成乱码而没人发现。
const replacementChars = (bundle.match(/\uFFFD/g) ?? []).length;
if (replacementChars > 0) {
  console.error(`✖ 产物里有 ${replacementChars} 个 U+FFFD —— 编码在某个环节被破坏了，拒绝写出`);
  process.exit(1);
}

if (checkOnly) {
  if (!existsSync(target)) {
    console.error('✖ lib/client.js 不存在（先跑 node scripts/build-client.mjs）');
    process.exit(1);
  }
  const current = readFileSync(target, 'utf8');
  if (current !== bundle) {
    console.error('✖ lib/client.js 与分片不一致：它被直接改过了，或者改完分片忘了重新构建。');
    console.error('  分片是唯一的真相来源；请把改动落到 lib/parts/*.js，然后跑 node scripts/build-client.mjs。');
    process.exit(1);
  }
  console.log(`✔ lib/client.js 与 ${parts.length} 个分片一致（${bundle.split('\n').length} 行）`);
  process.exit(0);
}

writeFileSync(target, bundle, 'utf8');

const lines = bundle.split('\n').length;
console.log(`拼接 ${parts.length} 片 → lib/client.js`);
for (const [index, name] of parts.entries()) {
  console.log(`  ${name.padEnd(28)} ${chunks[index].split('\n').length} 行`);
}
console.log(`合计 ${lines} 行 / ${Buffer.byteLength(bundle, 'utf8')} 字节`);

