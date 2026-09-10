/**
 * 开源前体检：扫出不该公开的个人信息与密钥痕迹。
 *
 * 为什么需要这个：仓库里有一堆**证据性文档**（README、docs/、recon/），
 * 它们天然会写「在我这台机器上是这样的」——而「我这台机器」意味着绝对路径、
 * 用户名、内网/远端地址。这些东西在本地是线索，公开出去就是泄露。
 *
 * 用法：
 *   node scripts/check-publish.mjs            # 扫全部待发布文件
 *   node scripts/check-publish.mjs --strict   # 有任何命中就退出码 1（给 CI/发布前用）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
/** 不参与发布的目录（与 .gitignore / .npmignore 保持一致）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * 检查项。每条给出：说明 + 正则 + 为什么危险。
 * 正则都带 `g`，用于逐处命中。
 */
const CHECKS = [
  {
    id: 'win-path',
    why: 'Windows 绝对路径会泄露用户名与目录结构',
    pattern: /[A-Za-z]:\\{1,2}(?:Users|nvm4w|workspaces)\\[^\s"'`)（），,、。：]+/g,
  },
  {
    id: 'home-path',
    why: '家目录路径同样泄露用户名',
    pattern: /(?:~\/|\/home\/|\/Users\/)[A-Za-z0-9._-]+/g,
  },
  {
    id: 'username',
    why: '本机用户名出现得太多就等于公开了作者身份与机器标识',
    pattern: /\bjiang\b/gi,
  },
  {
    id: 'public-ip',
    why: '非本机回环的 IP 可能是你的内网或远端服务器地址',
    pattern: /\b(?!(?:127|0)\.)(?!255\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(:\d+)?/g,
    allow: /127\.0\.0\.1|0\.0\.0\.0|1\.2\.3\.4|0x53554241/,
  },
  {
    id: 'email',
    why: '邮箱是个人信息',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allow: /example\.(com|org)|@deepseek-ai\/|@agentclientprotocol|@modelcontextprotocol|@earendil-works|@iasiv5|@anthropic-ai|@aws|@aws-sdk|@google|@hono|@img|@joplin|@lexical|@mistralai|@mixmark-io|@octokit|@opentelemetry|@preact|@protobufjs|@smithy|@standard-schema|@tanstack|@types|@vscode|@xterm/,
  },
  {
    id: 'secret',
    why: '疑似密钥/令牌的字面量绝不能公开',
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
  },
  {
    id: 'password-word',
    why: '「密码」字样附近常有不该出现的值',
    pattern: /(?:password|passwd|密码)\s*[:=]\s*\S+/gi,
  },
];

/**
 * 递归收集待发布文件。
 * @param {string} dir - 起始目录。
 * @param {string[]} out - 结果累加。
 * @returns {string[]}
 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) collect(full, out);
    else out.push(full);
  }
  return out;
}

/** 只扫文本文件（二进制跳过）。 */
function readText(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

const files = collect(root);
const findings = [];

for (const file of files) {
  const text = readText(file);
  if (text === undefined) continue;
  const lines = text.split('\n');
  for (const check of CHECKS) {
    lines.forEach((line, index) => {
      const matches = line.match(check.pattern);
      if (matches === null) return;
      for (const raw of matches) {
        if (check.allow !== undefined && check.allow.test(raw)) continue;
        findings.push({
          file: relative(root, file).replace(/\\/g, '/'),
          line: index + 1,
          id: check.id,
          why: check.why,
          preview: raw.length > 64 ? `${raw.slice(0, 61)}…` : raw,
        });
      }
    });
  }
}

const byId = new Map();
for (const finding of findings) {
  const list = byId.get(finding.id) ?? [];
  list.push(finding);
  byId.set(finding.id, list);
}

console.log(`扫描 ${files.length} 个文件，命中 ${findings.length} 处\n`);
for (const check of CHECKS) {
  const list = byId.get(check.id) ?? [];
  if (list.length === 0) continue;
  console.log(`【${check.id}】${list.length} 处 —— ${check.why}`);
  const byFile = new Map();
  for (const finding of list) {
    const arr = byFile.get(finding.file) ?? [];
    arr.push(finding);
    byFile.set(finding.file, arr);
  }
  for (const [file, arr] of byFile) {
    console.log(`  ${file}  (${arr.length} 处，行 ${arr.slice(0, 6).map((f) => f.line).join(',')}${arr.length > 6 ? '…' : ''})`);
    for (const finding of arr.slice(0, 2)) console.log(`      例：${finding.preview}`);
  }
  console.log('');
}

if (findings.length === 0) {
  console.log('未发现需要处理的个人信息或密钥痕迹。');
} else {
  console.log('处理建议：');
  console.log('  - 绝对路径 → 换成相对路径或 <你的目录> 这类占位符');
  console.log('  - 远端 IP / 端口 → 删掉或换成 127.0.0.1');
  console.log('  - 用户名 → 换成「本机用户」这类描述');
  console.log('  - 若命中 secret，**先吊销那个密钥**，再改文件（改文件不能挽回已泄露的密钥）');
}

if (process.argv.includes('--strict') && findings.length > 0) process.exit(1);
