/**
 * 找出一段标记文本落在哪些持久化文件里。
 *
 * 为什么单独写一个脚本：
 *  1. **不把敏感串写进命令行**——命令行本身会被记进会话日志，用它当参数等于又抄一遍。
 *     这里只从参数拿「标记」（例如用户名），不是密钥本身。
 *  2. **把「读不了」和「没有」分开报**——上一版对读失败静默 continue，
 *     于是「文件被宿主占用」会被误判成「没命中」。这种静默跳过正是要避免的。
 *
 * 用法：node scripts/scan-marker.mjs <标记> [扫描根目录]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const marker = process.argv[2];
const root = process.argv[3] ?? join(process.env.USERPROFILE ?? '', '.dsh');
if (!marker) {
  console.error('用法：node scripts/scan-marker.mjs <标记> [根目录]');
  process.exit(1);
}

const SKIP = new Set(['node_modules', '.git']);
const results = [];

/**
 * 解开可能由**多个 zstd 帧串联**的文件。
 *
 * 为什么不能直接用 `zstdDecompressSync`：追加写入的日志每写一批就是一个新帧，
 * 而 `zstdDecompressSync` 只解**第一帧**——在 6.85 MB 的日志上它返回了 0.00 MB、
 * 一条事件。于是「日志里没有这段文字」会变成一个**假结论**。
 * 这类失败最危险的地方是它不报错：看起来检查过了，其实什么都没读到。
 *
 * @param {Buffer} buffer - 原始字节。
 * @returns {{text:string,frames:number,failed:number}}
 */
function decompressAllFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const chunks = [];
  let from = 0;
  let frames = 0;
  let failed = 0;
  while (from < buffer.length) {
    const next = buffer.indexOf(MAGIC, from + 1);
    const end = next === -1 ? buffer.length : next;
    const piece = buffer.subarray(from, end);
    try {
      chunks.push(zstdDecompressSync(piece));
      frames += 1;
    } catch {
      // 切分点可能是压缩数据里恰好出现的魔数字节，这种片段解不开，如实计数。
      failed += 1;
    }
    if (next === -1) break;
    from = next;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames, failed };
}

/**
 * 递归扫描并逐个文件给出结论。
 * @param {string} dir - 目录。
 * @param {number} depth - 当前深度。
 */
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    results.push({ file: dir, status: 'unreadable-dir', detail: error.code });
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, depth + 1); continue; }

    let info;
    try {
      info = statSync(full);
    } catch (error) {
      results.push({ file: full, status: 'unreadable-stat', detail: error.code });
      continue;
    }
    if (info.size === 0 || info.size > 64 * 1024 * 1024) continue;

    let buffer;
    try {
      buffer = readFileSync(full);
    } catch (error) {
      // 关键：把「读不到」如实记下来，不要当成「没有」。
      results.push({ file: full, status: 'unreadable', detail: error.code });
      continue;
    }

    let text;
    const isZstd = buffer.length > 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd;
    try {
      if (isZstd) {
        const decoded = decompressAllFrames(buffer);
        text = decoded.text;
        if (decoded.failed > 0) {
          results.push({ file: full, status: 'zstd-partial', detail: `${decoded.frames} 帧解开 / ${decoded.failed} 段失败` });
        }
      } else {
        text = buffer.toString('utf8');
      }
    } catch (error) {
      results.push({ file: full, status: 'decode-failed', detail: error.code ?? error.message });
      continue;
    }
    if (text.includes('\u0000')) continue; // 二进制，跳过
    const count = text.split(marker).length - 1;
    if (count > 0) results.push({ file: full, status: 'HIT', count });
  }
}

walk(root, 0);

const hits = results.filter((r) => r.status === 'HIT');
const problem = results.filter((r) => r.status !== 'HIT');

console.log(`扫描根目录：${root}`);
console.log(`命中 ${hits.length} 个文件：`);
for (const hit of hits) console.log(`  ✔ ${hit.count} 次  ${hit.file.replace(/\\/g, '/')}`);
if (hits.length === 0) console.log('  （无）');

if (problem.length > 0) {
  console.log(`\n⚠ ${problem.length} 个文件**没能检查**（读不到 ≠ 没有，这类必须单独确认）：`);
  for (const item of problem.slice(0, 20)) {
    console.log(`  ? ${item.status}  ${item.file.replace(/\\/g, '/')}  (${item.detail})`);
  }
  if (problem.length > 20) console.log(`  … 还有 ${problem.length - 20} 个`);
}
