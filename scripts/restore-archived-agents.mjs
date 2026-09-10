/**
 * 把已归档的子 agent 恢复成活跃状态。
 *
 * 为什么需要这个脚本：界面上的「归档」是软删除（历史运行与评价都保留），
 * 但**之前没有恢复入口**——这正是真机上踩到的坑：用户因为一个界面 bug 以为归档没生效、
 * 于是把每个都点了一遍，四个配置全部进了归档状态却没有办法退回。
 *
 * 用法：
 *   node scripts/restore-archived-agents.mjs                 # 只看会恢复什么（默认 dry-run）
 *   node scripts/restore-archived-agents.mjs --apply         # 真的恢复
 *   node scripts/restore-archived-agents.mjs --apply --name Qwen专家   # 只恢复某一个
 *   node scripts/restore-archived-agents.mjs --apply --purge-probe      # 顺带删掉探针残留
 *
 * 默认 dry-run 是刻意的：这是一个直接改用户数据的动作，先看清楚再按下。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本插件的 application_id（'SUBA'）；拿错文件就拒绝，绝不往别的库里写。 */
const APPLICATION_ID = 0x53554241;

/**
 * 解析参数。
 * @param {string[]} argv - process.argv.slice(2)。
 * @returns {{apply:boolean,name:string,dbPath:string,purgeProbe:boolean}}
 */
function parseArgs(argv) {
  const args = { apply: false, name: '', dbPath: '', purgeProbe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--apply') args.apply = true;
    else if (key === '--name' && value !== undefined) { args.name = value; index += 1; }
    else if (key === '--db' && value !== undefined) { args.dbPath = value; index += 1; }
    else if (key === '--purge-probe') args.purgeProbe = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = args.dbPath !== ''
  ? args.dbPath
  : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'subagent-hub', 'subagent-hub.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');

const appId = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0);
if (appId !== APPLICATION_ID) {
  db.close();
  console.error(`✖ 拒绝使用 ${dbPath}：application_id=0x${appId.toString(16)} 不是 subagent-hub（0x${APPLICATION_ID.toString(16)}）`);
  process.exit(1);
}

/** 列出全部 agent 的当前状态。 */
const listAgents = () => db.prepare('SELECT id, name, archived_at FROM agents ORDER BY created_at ASC').all();

const archived = listAgents().filter((row) => row.archived_at !== null && (args.name === '' || row.name === args.name));

console.log(`库：${dbPath}`);
console.log(`当前共 ${listAgents().length} 个 agent，其中已归档 ${listAgents().filter((row) => row.archived_at !== null).length} 个`);
if (archived.length === 0) console.log('没有需要恢复的（或 --name 没匹配到）');
for (const row of archived) {
  console.log(`  待恢复：${row.name}`);
}

if (args.apply && archived.length > 0) {
  const result = db.prepare('UPDATE agents SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL');
  let changed = 0;
  for (const row of archived) changed += Number(result.run(Date.now(), row.id).changes ?? 0);
  console.log(`✔ 已恢复 ${changed} 个`);
}

if (args.apply && args.purgeProbe) {
  const removed = Number(db.prepare("DELETE FROM agents WHERE name = '__delete_probe__'").run().changes ?? 0);
  console.log(`✔ 清掉探针残留 ${removed} 行`);
}

if (!args.apply) console.log('\n（dry-run：加 --apply 才真的写入）');

db.close();
