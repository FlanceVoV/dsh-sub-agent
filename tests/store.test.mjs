/**
 * 存储层的测试。
 *
 * 覆盖三类容易出错的地方：
 *  1. **身份守卫**：拿错文件必须拒绝，而不是往别人的库里写。
 *  2. **排名与回归的口径**：这两件事只要口径漂了，页面上的名次就是误导性的。
 *  3. **清理**：保留策略必须在事务里同时删评价与运行，不能留下孤儿。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_ID, HubStore } from '../lib/src/store.js';
import { HubRuntime } from '../lib/src/runtime.js';

/** 每个测试用独立临时目录，避免互相污染。 */
const dirs = [];
function tempDbPath(name = 'hub.db') {
  const dir = mkdtempSync(join(tmpdir(), 'sbh-test-'));
  dirs.push(dir);
  return join(dir, name);
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 文件偶尔还占着，测试结束后系统会回收 */
    }
  }
});

/** 打开一个临时库。 */
function openStore() {
  return new HubStore({ dbPath: tempDbPath(), log: undefined }).open();
}

/** 造一个 agent 输入。 */
function agentInput(overrides = {}) {
  return {
    name: '研究员',
    transport: 'spawn',
    modelProvider: 'deepseek-official',
    modelId: 'deepseek-v4.1-flash',
    toolPolicy: 'inherit',
    ...overrides,
  };
}

test('身份守卫：拒绝打开别人的库', () => {
  const path = tempDbPath('foreign.db');
  const foreign = new DatabaseSync(path);
  foreign.exec('PRAGMA application_id = 1234567');
  foreign.close();

  assert.throws(
    () => new HubStore({ dbPath: path, log: undefined }).open(),
    /refusing to use/,
    '不属于本插件的库必须被拒绝，而不是被覆写',
  );
});

test('agent 的增删改查与「名字在未归档范围内唯一」', () => {
  const store = openStore();
  const agent = store.insertAgent(agentInput());
  assert.equal(agent.name, '研究员');
  assert.equal(agent.archivedAt, null);
  assert.equal(agent.toolPolicy, 'inherit');
  assert.ok(agent.id.length > 0);

  // 名字是 @ 的句柄：未归档范围内必须唯一。
  assert.throws(() => store.insertAgent(agentInput()), /UNIQUE|constraint/i);

  // 归档后不占用句柄，同名可以重新添加。
  assert.equal(store.archiveAgent(agent.id), true);
  assert.equal(store.getAgentByName('研究员'), undefined);
  const reused = store.insertAgent(agentInput());
  assert.equal(reused.name, '研究员');

  // 归档的不出现在默认列表里，但显式要就要得到。
  assert.equal(store.listAgents().length, 1);
  assert.equal(store.listAgents({ includeArchived: true }).length, 2);

  const updated = store.updateAgent(reused.id, { maxContext: 64000, toolPolicy: 'readonly' });
  assert.equal(updated.maxContext, 64000);
  assert.equal(updated.toolPolicy, 'readonly');
  assert.equal(updated.name, '研究员', '未提供的字段应保持原值');

  store.close();
});

test('运行记录：落库与读回的字段一一对应', () => {
  const store = openStore();
  const agent = store.insertAgent(agentInput());
  const run = store.insertRun({
    agentId: agent.id,
    agentName: agent.name,
    parentSessionId: 'session-parent',
    prompt: '查一下 X',
    taskKey: 'task-X',
  });

  assert.equal(run.status, 'queued');
  assert.equal(run.prompt, '查一下 X');
  assert.equal(run.taskKey, 'task-X');
  assert.equal(run.sessionId, '');

  store.updateRun(run.id, {
    sessionId: 'child-uuid',
    status: 'completed',
    tokensIn: 120,
    tokensOut: 3400,
    tokPerS: 42.5,
    outputTail: '结论是……',
    truncated: 1,
    structuredJson: JSON.stringify({ ok: true }),
  });

  const read = store.getRun(run.id);
  assert.equal(read.sessionId, 'child-uuid');
  assert.equal(read.status, 'completed');
  assert.equal(read.tokensOut, 3400);
  assert.equal(read.tokPerS, 42.5);
  assert.equal(read.truncated, true);
  assert.deepEqual(read.structured, { ok: true });

  // 过滤与排序。
  assert.equal(store.listRuns({ parentSessionId: 'session-parent' }).length, 1);
  assert.equal(store.listRuns({ parentSessionId: '别的会话' }).length, 0);
  assert.equal(store.listRuns({ taskKey: 'task-X' }).length, 1);
  assert.equal(store.countFinishedRuns(), 1);

  store.close();
});

test('排名口径：未评价不是 0 分，排序稳定', () => {
  const store = openStore();
  const good = store.insertAgent(agentInput({ name: '甲' }));
  const bad = store.insertAgent(agentInput({ name: '乙' }));
  const untouched = store.insertAgent(agentInput({ name: '丙' }));

  /** 造一次终态运行。 */
  const finish = (agentId, agentName, status, tokPerS) => {
    const run = store.insertRun({ agentId, agentName, parentSessionId: 'p', prompt: 't' });
    store.updateRun(run.id, { status, tokPerS, durationMs: 1000, tokensOut: 100 });
    return run;
  };

  const runGood = finish(good.id, '甲', 'completed', 50);
  finish(good.id, '甲', 'completed', 30);
  finish(bad.id, '乙', 'error', 10);

  // 只给「甲」的一条运行评价。
  store.insertEvaluation({ runId: runGood.id, score: 90, dimensions: { correctness: 90 } });

  const board = store.agentLeaderboard();
  assert.equal(board.length, 3);

  const jia = board.find((row) => row.agentName === '甲');
  assert.equal(jia.runs, 2);
  assert.equal(jia.completed, 2);
  assert.equal(jia.evaluations, 1);
  assert.equal(jia.avgScore, 90, '只有一个评价时均分就是那个分');
  assert.equal(jia.successRate, 1);

  const bing = board.find((row) => row.agentName === '丙');
  assert.equal(bing.runs, 0);
  assert.equal(bing.avgScore, null, '没有任何评价时必须是 null，而不是 0 分');
  assert.equal(bing.successRate, null);

  const yi = board.find((row) => row.agentName === '乙');
  assert.equal(yi.successRate, 0);
  assert.equal(yi.failed, 1);

  // 有分的排前面；没分的（null）不能因为「0 比 90 小」而被排到有分的上面。
  assert.equal(board[0].agentName, '甲');
  assert.equal(board[board.length - 1].agentName, '丙', '无成绩的排最后');

  store.close();
});

test('跨轮回归：同一 task_key 的分数变化被算成 delta', () => {
  const store = openStore();
  const agent = store.insertAgent(agentInput());

  const round1 = store.insertRound({ name: '第 1 轮' });
  const round2 = store.insertRound({ name: '第 2 轮' });

  /** 造一次「已完成 + 已评价」的运行。 */
  const scored = (roundId, score) => {
    const run = store.insertRun({
      agentId: agent.id, agentName: agent.name, parentSessionId: 'p',
      prompt: '同一个任务', taskKey: '同一个任务', roundId,
    });
    store.updateRun(run.id, { status: 'completed' });
    store.insertEvaluation({ runId: run.id, roundId, score, dimensions: { correctness: score } });
    return run;
  };

  scored(round1.id, 80);
  scored(round2.id, 60);

  const regression = store.regressionByTask();
  assert.equal(regression.length, 1);
  const series = regression[0];
  assert.equal(series.taskKey, '同一个任务');
  assert.equal(series.rounds.length, 2);
  assert.equal(series.rounds[0].avgScore, 80);
  assert.equal(series.rounds[1].avgScore, 60);
  assert.equal(series.rounds[1].deltaVsPrevious, -20, '退步 20 分必须被算出来');
  assert.equal(series.overallDelta, -20);

  // 只看某个任务。
  assert.equal(store.regressionByTask('同一个任务').length, 1);
  assert.equal(store.regressionByTask('不存在的任务').length, 0);

  store.close();
});

test('保留策略：在事务里同时清掉运行与它的评价，且不动还活着的运行', () => {
  const store = openStore();
  const agent = store.insertAgent(agentInput());

  const old = store.insertRun({ agentId: agent.id, agentName: agent.name, parentSessionId: 'p', prompt: '老' });
  store.updateRun(old.id, { status: 'completed' });
  store.insertEvaluation({ runId: old.id, score: 50 });
  // 手工把时间推到 100 天前。
  store.require().prepare('UPDATE runs SET queued_at = ? WHERE id = ?').run(Date.now() - 100 * 86400000, old.id);

  const fresh = store.insertRun({ agentId: agent.id, agentName: agent.name, parentSessionId: 'p', prompt: '新' });
  store.updateRun(fresh.id, { status: 'completed' });
  store.insertEvaluation({ runId: fresh.id, score: 70 });

  const running = store.insertRun({ agentId: agent.id, agentName: agent.name, parentSessionId: 'p', prompt: '在跑' });
  store.updateRun(running.id, { status: 'running' });

  const removed = store.pruneRuns(30);
  assert.equal(removed, 1, '只该删掉那条超期的终态运行');
  assert.equal(store.getRun(old.id), undefined);
  assert.equal(store.listEvaluations(old.id).length, 0, '评价必须跟着运行一起删，不能留孤儿');
  assert.notEqual(store.getRun(fresh.id), undefined, '未超期的不该被删');
  assert.notEqual(store.getRun(running.id), undefined, '还在跑的不该被删');

  store.close();
});

test('设置项：JSON 往返，坏数据回退到默认值', () => {
  const store = openStore();
  assert.equal(store.getSetting('session-enabled:s1', false), false);
  store.setSetting('session-enabled:s1', true);
  assert.equal(store.getSetting('session-enabled:s1', false), true);

  store.require().prepare('UPDATE settings SET value = ? WHERE key = ?').run('{坏 JSON', 'session-enabled:s1');
  assert.equal(store.getSetting('session-enabled:s1', false), false, '坏数据应回退到默认值而不是抛错');

  store.close();
});

test('启动对账：把上次进程遗留的「运行中」标成中断', () => {
  const store = openStore();
  const agent = store.insertAgent(agentInput());
  const ghost = store.insertRun({ agentId: agent.id, agentName: agent.name, parentSessionId: 'p', prompt: '幽灵' });
  store.updateRun(ghost.id, { status: 'running' });

  const runtime = new HubRuntime({ ctx: {}, store, config: { maxConcurrentRuns: 2, runTimeoutMs: 1000, outputTailChars: 100, tokPerSecondWindowMs: 3000 }, log: { info() {}, warn() {}, error() {}, debug() {} } });
  const repaired = runtime.reconcileStaleRuns();

  assert.equal(repaired, 1);
  const read = store.getRun(ghost.id);
  assert.equal(read.status, 'cancelled');
  assert.equal(read.stopReason, 'interrupted');
  assert.ok(read.error.length > 0);

  store.close();
});

test('启用开关是全局的，且旧版按会话的开关会被迁移', () => {
  const store = openStore();

  // 缺省关。
  assert.equal(store.isEnabled(), false);

  // 旧版遗留：按会话记的开关（真机上就是这个状态）。
  store.setSetting('session-enabled:session-aaa', false);
  store.setSetting('session-enabled:session-bbb', true);

  const migration = store.migrateEnableScope();
  assert.equal(migration.migrated, true);
  assert.equal(migration.sources, 2);
  // 只要历史上任何一个会话是开着的，就认为用户是想开着的——
  // 升级后不该出现「我明明是开着的，怎么又关了」。
  assert.equal(store.isEnabled(), true, '迁移应当保留「开着」的意图');

  // 旧的按会话键必须被清掉：两套数据并存会让以后分不清谁说了算。
  assert.equal(store.listSettings('session-enabled:').length, 0);

  // 迁移是幂等的：再跑一次不动任何东西。
  assert.equal(store.migrateEnableScope().migrated, false);
  assert.equal(store.isEnabled(), true);

  // 全局写。
  assert.equal(store.setEnabled(false), false);
  assert.equal(store.isEnabled(), false);
  assert.equal(store.setEnabled(true), true);

  store.close();
});

test('迁移：旧记录全是关的，就迁成关的（不凭空打开）', () => {
  const store = openStore();
  store.setSetting('session-enabled:session-aaa', false);
  assert.equal(store.migrateEnableScope().migrated, true);
  assert.equal(store.isEnabled(), false);
  store.close();
});

test('迁移：没有任何旧记录时不动全局键', () => {
  const store = openStore();
  assert.equal(store.migrateEnableScope().migrated, false);
  assert.equal(store.getSetting('enabled', undefined), undefined);
  store.close();
});

test('application_id 与 schema 版本被正确写入', () => {
  const store = openStore();
  const appId = Number(store.require().prepare('PRAGMA application_id').get()?.application_id);
  const version = Number(store.require().prepare('PRAGMA user_version').get()?.user_version);
  assert.equal(appId, APPLICATION_ID);
  assert.equal(version, 1);
  store.close();
});
