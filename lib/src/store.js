/**
 * 存储：`node:sqlite`（Node ≥22.5 内置，零第三方依赖）。
 *
 * 为什么是 sqlite 而不是 DSH 的 storageDomain 或 JSON 文件：
 *  - DSH 的 `ctx.storageDomain` 是**纯 KV**、全量常驻内存、没有查询与聚合能力，
 *    而本插件需要「按 agent 聚合出排名」「按 task_key 跨轮对比回归」「按时间清理」，
 *    这些都是关系查询，用 KV 只能在 JS 里全表扫描再手算——等于自己写了个数据库。
 *  - 纯 JSON 文件在「运行记录」这种追加型数据上没有并发安全与索引。
 *  - `node:sqlite` 已被 DSH 自己（`dsh-session-query-sqlite`）与本机另一个插件
 *    （memory-helper，65MB WAL 库）在本运行时验证可用，无 flag、无 warning。
 *
 * 为什么**不**复用 `dsh-session-query-sqlite` 的库：它自述是一个「可丢弃的派生索引」
 * （版本一变就原地重建、拒绝含外来表的文件），拿它当业务库会被它重建掉。
 *
 * 身份守卫照抄 memory-helper 的做法：`application_id` 非零且不等于本插件就**拒绝打开**，
 * 而不是往别人的库里写。这是「宁可起不来，也不写错文件」。
 *
 * @module dsh-subagent-hub/store
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { describeError } from './log.js';

/** schema 版本，写入 `PRAGMA user_version`。 */
export const SCHEMA_VERSION = 2;

/** 应用标识，写入 `PRAGMA application_id`（'SUBA'）。 */
export const APPLICATION_ID = 0x53554241;

/**
 * 建表语句。
 *
 * 设计要点：
 *  - `runs.session_id` 指向 DSH 自己的会话日志（需求 2「查看调用的会话是哪个」），
 *    **不复制对话正文**——正文的权威副本永远是 DSH 的会话日志。这里只留一个
 *    `output_tail`（有界）用于排序/回归展示，超长正文靠 session_id 回查。
 *  - `agents.name` 在「未归档」范围内唯一：它就是 @ 的句柄，重名会让 @ 有歧义。
 *    「一个 agent 可以被添加多次」由「允许建多条指向同一模型的配置」满足，而不是靠重名。
 *  - 评价与运行分离：一次运行可以被评价多次（重新评估），历史保留。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  transport       TEXT NOT NULL DEFAULT 'spawn',
  model_provider  TEXT NOT NULL DEFAULT '',
  model_id        TEXT NOT NULL DEFAULT '',
  api_base        TEXT NOT NULL DEFAULT '',
  credential_ref  TEXT NOT NULL DEFAULT '',
  max_context     INTEGER NOT NULL DEFAULT 0,
  max_tokens      INTEGER NOT NULL DEFAULT 0,
  reasoning_effort TEXT NOT NULL DEFAULT '',
  tool_policy     TEXT NOT NULL DEFAULT 'inherit',
  persona         TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_active_name
  ON agents(name) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  agent_name        TEXT NOT NULL DEFAULT '',
  session_id        TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT NOT NULL DEFAULT '',
  label             TEXT NOT NULL DEFAULT '',
  prompt            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'queued',
  queued_at         INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  step_ms           INTEGER NOT NULL DEFAULT 0,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  tok_per_s         REAL NOT NULL DEFAULT 0,
  stop_reason       TEXT NOT NULL DEFAULT '',
  error             TEXT NOT NULL DEFAULT '',
  diagnostic        TEXT NOT NULL DEFAULT '',
  output_tail       TEXT NOT NULL DEFAULT '',
  truncated         INTEGER NOT NULL DEFAULT 0,
  structured_json   TEXT,
  round_id          TEXT,
  task_key          TEXT NOT NULL DEFAULT '',
  invoked_by        TEXT NOT NULL DEFAULT 'tool'
);
CREATE INDEX IF NOT EXISTS runs_agent   ON runs(agent_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_parent  ON runs(parent_session_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_task    ON runs(task_key, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_round   ON runs(round_id);
CREATE INDEX IF NOT EXISTS runs_status  ON runs(status, queued_at DESC);

CREATE TABLE IF NOT EXISTS rounds (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  round_id        TEXT,
  score           REAL NOT NULL DEFAULT 0,
  verdict         TEXT NOT NULL DEFAULT '',
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  notes           TEXT NOT NULL DEFAULT '',
  evaluator       TEXT NOT NULL DEFAULT 'main-conversation',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evaluations_run   ON evaluations(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evaluations_round ON evaluations(round_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * schema v2：任务清单与依赖图。
 *
 * 建表语句单独放一份（而不是塞进 SCHEMA_SQL 里），因为它带来的那套约定值得解释：
 *
 *  - **只存事实，不存状态。** 表里没有任何 `state` 列：任务当前是「等待依赖 / 可执行 /
 *    运行中」是 `plan.js` 每次现算出来的。存下来就会有两个真相来源，
 *    而进程被杀、事件丢失、手工改库都会让它们分叉——分叉的表现是「图上说在跑、链路却不动」。
 *  - **任务 id 是清单内唯一的**（主键是 `plan_id + id` 复合键）。让 id 全局唯一就得让模型
 *    去记 `pl_ab12cd34/t3` 这种东西，而模型真正要写的依赖是「t3」；作用域放在清单里，
 *    模型写起来最短，宿主的路由也没有歧义。
 *  - **`run_status` 是 runs.status 的快照**，只用于「进程重启后仍知道上一次跑到哪」。
 *    它和 runs 表之间没有外键：运行记录是可以按保留策略删掉的，任务不该因为
 *    历史运行被清理就变成孤儿。
 */
const TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plans (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT NOT NULL DEFAULT '',
  auto_activate     INTEGER NOT NULL DEFAULT 1,
  activation_error  TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT NOT NULL,
  plan_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL DEFAULT '',
  brief        TEXT NOT NULL DEFAULT '',
  agent_name   TEXT NOT NULL DEFAULT '',
  deps_json    TEXT NOT NULL DEFAULT '[]',
  run_id       TEXT NOT NULL DEFAULT '',
  run_status   TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  started_at   INTEGER,
  ended_at     INTEGER,
  cancelled_at INTEGER,
  PRIMARY KEY (plan_id, id)
);
CREATE INDEX IF NOT EXISTS tasks_plan ON tasks(plan_id, seq ASC);
CREATE INDEX IF NOT EXISTS tasks_run  ON tasks(run_id);
`;

/** 运行状态枚举（写入 runs.status，UI 与统计都按它分派）。 */
export const RUN_STATUSES = Object.freeze([
  'queued', 'running', 'completed', 'error', 'timeout', 'cancelled',
]);

/** 工具策略枚举。 */
export const TOOL_POLICIES = Object.freeze(['inherit', 'readonly', 'none']);

/**
 * 运行记录存储。
 */
export class HubStore {
  /**
   * @param {{dbPath:string, log:object}} options - 库路径与 logger。
   */
  constructor({ dbPath, log }) {
    this.dbPath = dbPath;
    this.log = log;
    /** @type {DatabaseSync|undefined} */
    this.db = undefined;
    /** @type {{from:number,to:number}|null} 本次打开是否触发了 schema 升级（`open()` 里填）。 */
    this.schemaUpgrade = null;
  }

  /**
   * 打开（必要时创建）数据库并建表。
   * @returns {HubStore} this，便于链式。
   */
  open() {
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');

    // 身份守卫：拿错文件就拒绝，绝不往别人库里写。
    const current = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0);
    if (current !== 0 && current !== APPLICATION_ID) {
      db.close();
      throw new Error(
        `refusing to use ${this.dbPath}: application_id=0x${current.toString(16)} is not subagent-hub `
        + `(0x${APPLICATION_ID.toString(16)}). Point config.dbPath at a dedicated file.`,
      );
    }
    // 升级前先把旧版本号读出来：只加表的迁移是幂等的（CREATE TABLE IF NOT EXISTS），
    // 但「升过级」这件事要说出来——否则用户没法把「多了任务链路」和「库被改过」联系起来。
    const previous = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(SCHEMA_SQL);
    db.exec(TASK_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.schemaUpgrade = previous > 0 && previous < SCHEMA_VERSION ? { from: previous, to: SCHEMA_VERSION } : null;
    this.db = db;
    return this;
  }

  /**
   * 关闭数据库（幂等）。
   * @returns {void}
   */
  close() {
    try {
      this.db?.close();
    } catch (error) {
      this.log?.debug?.(`close failed: ${describeError(error)}`);
    }
    this.db = undefined;
  }

  /**
   * 在立刻事务里执行一段工作，异常则回滚。
   * @param {Function} work - 无参回调，返回值被透传。
   * @returns {any}
   */
  transaction(work) {
    const db = this.require();
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时保留原始异常 */
      }
      throw error;
    }
  }

  /**
   * 取数据库句柄，未打开则抛错（调用方忘了 open 是编程错误，应当早失败）。
   * @returns {DatabaseSync}
   */
  require() {
    if (this.db === undefined) throw new Error('store is not open');
    return this.db;
  }

  //#region agents

  /**
   * 列出 agent 配置。
   * @param {{includeArchived?:boolean}} [options] - 选项。
   * @returns {object[]}
   */
  listAgents(options = {}) {
    const sql = options.includeArchived === true
      ? 'SELECT * FROM agents ORDER BY archived_at IS NOT NULL, created_at ASC'
      : 'SELECT * FROM agents WHERE archived_at IS NULL ORDER BY created_at ASC';
    return this.require().prepare(sql).all().map(rowToAgent);
  }

  /**
   * 按 id 取一个 agent。
   * @param {string} id - agent id。
   * @returns {object|undefined}
   */
  getAgent(id) {
    const row = this.require().prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row === undefined ? undefined : rowToAgent(row);
  }

  /**
   * 按名字取一个未归档的 agent（@ 句柄解析）。
   * @param {string} name - agent 名。
   * @returns {object|undefined}
   */
  getAgentByName(name) {
    const row = this.require()
      .prepare('SELECT * FROM agents WHERE name = ? AND archived_at IS NULL')
      .get(name);
    return row === undefined ? undefined : rowToAgent(row);
  }

  /**
   * 新增 agent。
   * @param {object} input - 已校验的字段。
   * @returns {object} 落库后的 agent。
   */
  insertAgent(input) {
    const now = Date.now();
    const id = randomUUID();
    this.require().prepare(`
      INSERT INTO agents (id, name, note, transport, model_provider, model_id, api_base,
                          credential_ref, max_context, max_tokens, reasoning_effort,
                          tool_policy, persona, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.note ?? '', input.transport, input.modelProvider, input.modelId,
      input.apiBase ?? '', input.credentialRef ?? '', input.maxContext ?? 0, input.maxTokens ?? 0,
      input.reasoningEffort ?? '', input.toolPolicy ?? 'inherit', input.persona ?? '', now, now,
    );
    return this.getAgent(id);
  }

  /**
   * 更新 agent（未提供的字段保持原值）。
   * @param {string} id - agent id。
   * @param {object} patch - 待更新字段。
   * @returns {object|undefined}
   */
  updateAgent(id, patch) {
    const current = this.getAgent(id);
    if (current === undefined) return undefined;
    const merged = { ...current, ...patch };
    this.require().prepare(`
      UPDATE agents SET name = ?, note = ?, transport = ?, model_provider = ?, model_id = ?,
        api_base = ?, credential_ref = ?, max_context = ?, max_tokens = ?, reasoning_effort = ?,
        tool_policy = ?, persona = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.name, merged.note, merged.transport, merged.modelProvider, merged.modelId,
      merged.apiBase, merged.credentialRef, merged.maxContext, merged.maxTokens,
      merged.reasoningEffort, merged.toolPolicy, merged.persona, Date.now(), id,
    );
    return this.getAgent(id);
  }

  /**
   * 归档 agent（软删除：运行历史要保留可读的名字）。
   * @param {string} id - agent id。
   * @returns {boolean} 是否确实改动了行。
   */
  archiveAgent(id) {
    const result = this.require()
      .prepare('UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(Date.now(), Date.now(), id);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * 取消归档。
   *
   * 必须存在，而且要能一键做到：归档是一键的，如果恢复只能靠命令行，
   * 这个不对称本身就是一个陷阱——真机上就是这么丢掉四个配置的。
   *
   * 注意名字唯一索引是**部分索引**（只约束未归档的行），所以恢复时可能撞名：
   * 用户很可能在归档之后又用同一个名字建了一个新的。撞名必须如实拒绝并说清原因，
   * 而不是让数据库抛一个 UNIQUE 约束错误。
   * @param {string} id - agent id。
   * @returns {{ok:true}|{ok:false,reason:'not-archived'|'name-taken'|'missing',conflictWith?:string}}
   */
  restoreAgent(id) {
    const agent = this.getAgent(id);
    if (agent === undefined) return { ok: false, reason: 'missing' };
    if (agent.archivedAt === null) return { ok: false, reason: 'not-archived' };
    const taken = this.getAgentByName(agent.name);
    if (taken !== undefined && taken.id !== id) {
      return { ok: false, reason: 'name-taken', conflictWith: taken.name };
    }
    const result = this.require()
      .prepare('UPDATE agents SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL')
      .run(Date.now(), id);
    return Number(result.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'missing' };
  }

  //#endregion

  //#region runs

  /**
   * 建一条 queued 运行记录。
   * @param {object} input - 运行输入。
   * @returns {object} 落库后的运行记录。
   */
  insertRun(input) {
    const id = randomUUID();
    this.require().prepare(`
      INSERT INTO runs (id, agent_id, agent_name, parent_session_id, label, prompt, status,
                        queued_at, round_id, task_key, invoked_by)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      id, input.agentId, input.agentName ?? '', input.parentSessionId ?? '', input.label ?? '',
      input.prompt ?? '', Date.now(), input.roundId ?? null, input.taskKey ?? '',
      input.invokedBy ?? 'tool',
    );
    return this.getRun(id);
  }

  /**
   * 取一条运行记录。
   * @param {string} id - run id。
   * @returns {object|undefined}
   */
  getRun(id) {
    const row = this.require().prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row === undefined ? undefined : rowToRun(row);
  }

  /**
   * 打补丁更新一条运行记录。
   * @param {string} id - run id。
   * @param {object} patch - 待更新字段（camelCase）。
   * @returns {void}
   */
  updateRun(id, patch) {
    const columns = {
      sessionId: 'session_id', status: 'status', startedAt: 'started_at', endedAt: 'ended_at',
      durationMs: 'duration_ms', stepMs: 'step_ms', tokensIn: 'tokens_in', tokensOut: 'tokens_out',
      tokPerS: 'tok_per_s', stopReason: 'stop_reason', error: 'error', diagnostic: 'diagnostic',
      outputTail: 'output_tail', truncated: 'truncated', structuredJson: 'structured_json',
      roundId: 'round_id', taskKey: 'task_key', label: 'label',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.require().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 列出运行记录。
   * @param {{limit?:number,agentId?:string,parentSessionId?:string,roundId?:string,taskKey?:string,status?:string}} [filter] - 过滤条件。
   * @returns {object[]}
   */
  listRuns(filter = {}) {
    const where = [];
    const values = [];
    for (const [key, column] of [
      ['agentId', 'agent_id'], ['parentSessionId', 'parent_session_id'],
      ['roundId', 'round_id'], ['taskKey', 'task_key'], ['status', 'status'],
    ]) {
      const value = filter[key];
      if (typeof value === 'string' && value !== '') {
        where.push(`${column} = ?`);
        values.push(value);
      }
    }
    const limit = Number.isSafeInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 500) : 50;
    const sql = `SELECT * FROM runs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} `
      + 'ORDER BY queued_at DESC LIMIT ?';
    values.push(limit);
    return this.require().prepare(sql).all(...values).map(rowToRun);
  }

  /**
   * 统计每个 agent 的成绩（排名用）。
   *
   * 「排名」的口径必须写死在一处并说明白，否则不同页面会给出互相矛盾的名次：
   *   - `runs` 只算终态（completed/error/timeout/cancelled），queued/running 不计入
   *   - `avgScore` 只对该 agent 下**已被评价**的运行求均值（未评价不是 0 分）
   *   - `successRate` = completed / 终态总数
   *   - 排序：avgScore 降序 → successRate 降序 → runs 降序 → name 升序（保证稳定）
   *
   * @returns {object[]}
   */
  agentLeaderboard() {
    const rows = this.require().prepare(`
      SELECT a.id                                            AS agent_id,
             a.name                                          AS agent_name,
             a.model_provider                                AS model_provider,
             a.model_id                                      AS model_id,
             a.archived_at                                   AS archived_at,
             COUNT(r.id)                                     AS runs,
             SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN r.status IN ('error','timeout','cancelled') THEN 1 ELSE 0 END) AS failed,
             AVG(CASE WHEN r.tok_per_s > 0 THEN r.tok_per_s END)      AS avg_tok_per_s,
             AVG(CASE WHEN r.duration_ms > 0 THEN r.duration_ms END)  AS avg_duration_ms,
             SUM(r.tokens_out)                               AS tokens_out,
             AVG(e.score)                                    AS avg_score,
             COUNT(e.id)                                     AS evaluations
      FROM agents a
      LEFT JOIN runs r ON r.agent_id = a.id AND r.status NOT IN ('queued','running')
      LEFT JOIN evaluations e ON e.run_id = r.id
      GROUP BY a.id
    `).all();

    return rows.map((row) => {
      const total = Number(row.runs ?? 0);
      const completed = Number(row.completed ?? 0);
      return {
        agentId: row.agent_id,
        agentName: row.agent_name,
        modelProvider: row.model_provider,
        modelId: row.model_id,
        archived: row.archived_at !== null && row.archived_at !== undefined,
        runs: total,
        completed,
        failed: Number(row.failed ?? 0),
        evaluations: Number(row.evaluations ?? 0),
        avgScore: row.avg_score === null || row.avg_score === undefined ? null : round2(row.avg_score),
        successRate: total === 0 ? null : round4(completed / total),
        avgTokPerS: row.avg_tok_per_s === null || row.avg_tok_per_s === undefined ? null : round2(row.avg_tok_per_s),
        avgDurationMs: row.avg_duration_ms === null || row.avg_duration_ms === undefined ? null : Math.round(Number(row.avg_duration_ms)),
        tokensOut: Number(row.tokens_out ?? 0),
      };
    }).sort(compareLeaderboard);
  }

  /**
   * 跨轮回归：同一个 task_key 下，各轮的均分与相对上一轮的变化。
   *
   * 「轮的先后」用 `rounds.rowid`（SQLite 的隐式自增行号）而不是运行时间戳：
   * 同一毫秒内建的两轮时间戳会相同，按时间排序就变成了不确定的顺序，
   * 于是 delta 会随机算成 +20 或 -20——而「这一轮比上一轮退步了没有」正是本功能唯一的产出，
   * 不能依赖一个可能并列的值。没有关联轮次的运行退回按运行时间排。
   *
   * @param {string} [taskKey] - 只看某个任务；缺省看全部。
   * @returns {object[]}
   */
  regressionByTask(taskKey) {
    const values = [];
    let where = "WHERE r.status = 'completed' AND r.task_key <> ''";
    if (typeof taskKey === 'string' && taskKey !== '') {
      where += ' AND r.task_key = ?';
      values.push(taskKey);
    }
    const rows = this.require().prepare(`
      SELECT r.task_key   AS task_key,
             r.round_id    AS round_id,
             r.agent_id    AS agent_id,
             r.agent_name  AS agent_name,
             AVG(e.score)  AS avg_score,
             COUNT(e.id)   AS evaluations,
             COUNT(r.id)   AS runs,
             MIN(r.queued_at) AS first_run_at,
             COALESCE(rd.rowid, 0) AS round_seq
      FROM runs r
      JOIN evaluations e ON e.run_id = r.id
      LEFT JOIN rounds rd ON rd.id = r.round_id
      ${where}
      GROUP BY r.task_key, r.round_id, r.agent_id
      ORDER BY r.task_key ASC, round_seq ASC, first_run_at ASC
    `).all(...values);

    // 同一 (task_key, agent) 的多轮串起来算 delta：这是「退步了没有」的唯一口径。
    const series = new Map();
    for (const row of rows) {
      const key = `${row.task_key}\u0000${row.agent_id}`;
      if (!series.has(key)) series.set(key, []);
      series.get(key).push({
        roundId: row.round_id,
        avgScore: row.avg_score === null ? null : round2(row.avg_score),
        evaluations: Number(row.evaluations ?? 0),
        runs: Number(row.runs ?? 0),
      });
    }

    const out = [];
    for (const [key, points] of series) {
      const [task, agentId] = key.split('\u0000');
      const withDelta = points.map((point, index) => {
        const previous = index === 0 ? undefined : points[index - 1];
        const delta = previous !== undefined && previous.avgScore !== null && point.avgScore !== null
          ? round2(point.avgScore - previous.avgScore)
          : null;
        return { ...point, deltaVsPrevious: delta };
      });
      const first = withDelta[0];
      const last = withDelta[withDelta.length - 1];
      out.push({
        taskKey: task,
        agentId,
        agentName: rows.find((row) => row.task_key === task && row.agent_id === agentId)?.agent_name ?? '',
        rounds: withDelta,
        overallDelta: first.avgScore !== null && last.avgScore !== null && withDelta.length > 1
          ? round2(last.avgScore - first.avgScore)
          : null,
      });
    }
    return out.sort((left, right) => left.taskKey.localeCompare(right.taskKey) || left.agentName.localeCompare(right.agentName));
  }

  /** @returns {number} 终态运行总数。 */
  countFinishedRuns() {
    const row = this.require()
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('queued','running')")
      .get();
    return Number(row?.n ?? 0);
  }

  /**
   * 按保留策略清理运行记录。
   *
   * 先删评价再删运行（外键方向：评价挂在运行上），并且**在一个事务里**完成——
   * 否则中途失败会留下指向不存在运行的评价记录。
   * @param {number} days - 保留天数。
   * @returns {number} 删除的运行条数。
   */
  pruneRuns(days) {
    if (!Number.isSafeInteger(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.transaction(() => {
      const db = this.require();
      db.prepare(`
        DELETE FROM evaluations WHERE run_id IN (
          SELECT id FROM runs WHERE status NOT IN ('queued','running') AND queued_at < ?
        )
      `).run(cutoff);
      const result = db.prepare(`
        DELETE FROM runs WHERE status NOT IN ('queued','running') AND queued_at < ?
      `).run(cutoff);
      return Number(result.changes ?? 0);
    });
  }

  //#endregion

  //#region rounds & evaluations

  /**
   * 建一轮。
   * @param {{name?:string,note?:string}} input - 轮名称与备注。
   * @returns {object} 轮记录。
   */
  insertRound(input = {}) {
    const id = randomUUID();
    const createdAt = Date.now();
    this.require().prepare('INSERT INTO rounds (id, name, note, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name ?? '', input.note ?? '', createdAt);
    return { id, name: input.name ?? '', note: input.note ?? '', createdAt };
  }

  /**
   * 列出轮。
   * @returns {object[]}
   */
  listRounds() {
    return this.require().prepare('SELECT * FROM rounds ORDER BY created_at DESC').all()
      .map((row) => ({ id: row.id, name: row.name, note: row.note, createdAt: Number(row.created_at) }));
  }

  /**
   * 写一条评价。
   * @param {object} input - 评价输入。
   * @returns {object} 评价记录。
   */
  insertEvaluation(input) {
    const id = randomUUID();
    const createdAt = Date.now();
    this.require().prepare(`
      INSERT INTO evaluations (id, run_id, round_id, score, verdict, dimensions_json, notes, evaluator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.runId, input.roundId ?? null, input.score, input.verdict ?? '',
      JSON.stringify(input.dimensions ?? {}), input.notes ?? '',
      input.evaluator ?? 'main-conversation', createdAt,
    );
    return { ...input, id, createdAt };
  }

  /**
   * 取一次运行的全部评价（新的在前）。
   * @param {string} runId - run id。
   * @returns {object[]}
   */
  listEvaluations(runId) {
    return this.require()
      .prepare('SELECT * FROM evaluations WHERE run_id = ? ORDER BY created_at DESC')
      .all(runId)
      .map(rowToEvaluation);
  }

  //#endregion

  //#region plans & tasks

  /**
   * 建一条任务清单。
   * @param {{id:string,title:string,note?:string,parentSessionId?:string,autoActivate?:boolean}} input - 输入（id 由调用方生成）。
   * @returns {object} 落库后的清单。
   */
  insertPlan(input) {
    const now = Date.now();
    this.require().prepare(`
      INSERT INTO plans (id, title, note, parent_session_id, auto_activate, activation_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?)
    `).run(
      input.id, input.title ?? '', input.note ?? '', input.parentSessionId ?? '',
      input.autoActivate === false ? 0 : 1, now, now,
    );
    return this.getPlan(input.id);
  }

  /**
   * 取一条清单。
   * @param {string} id - 清单 id。
   * @returns {object|undefined}
   */
  getPlan(id) {
    const row = this.require().prepare('SELECT * FROM plans WHERE id = ?').get(id);
    return row === undefined ? undefined : rowToPlan(row);
  }

  /**
   * 列出清单（新的在前）。
   * @param {{limit?:number}} [options] - 选项。
   * @returns {object[]}
   */
  listPlans(options = {}) {
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 50;
    return this.require().prepare('SELECT * FROM plans ORDER BY created_at DESC LIMIT ?').all(limit).map(rowToPlan);
  }

  /**
   * 打补丁更新清单。
   * @param {string} id - 清单 id。
   * @param {object} patch - `{title,note,autoActivate,activationError}`。
   * @returns {object|undefined} 更新后的清单。
   */
  updatePlan(id, patch) {
    const columns = {
      title: 'title', note: 'note', autoActivate: 'auto_activate', activationError: 'activation_error',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'autoActivate' ? (patch[key] === false ? 0 : 1) : patch[key]);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(Date.now(), id);
      this.require().prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.getPlan(id);
  }

  /**
   * 删掉一条清单及其任务（**不是取消**：取消语义由 cancelled_at 表达，这里是真的抹掉）。
   * @param {string} id - 清单 id。
   * @returns {number} 删除的任务条数。
   */
  deletePlan(id) {
    return this.transaction(() => {
      const removed = this.require().prepare('DELETE FROM tasks WHERE plan_id = ?').run(id);
      this.require().prepare('DELETE FROM plans WHERE id = ?').run(id);
      return Number(removed.changes ?? 0);
    });
  }

  /**
   * 批量插入任务（一次事务：半个清单落库比整个不落库更难查）。
   * @param {string} planId - 清单 id。
   * @param {object[]} tasks - `{id,seq,title,brief,agentName,deps}`。
   * @returns {object[]} 落库后的任务（按 seq 排序）。
   */
  insertTasks(planId, tasks) {
    const now = Date.now();
    const statement = this.require().prepare(`
      INSERT INTO tasks (id, plan_id, seq, title, brief, agent_name, deps_json, run_id, run_status,
                         attempts, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 0, '', ?, ?)
    `);
    this.transaction(() => {
      for (const task of tasks) {
        statement.run(
          task.id, planId, Number(task.seq ?? 0), task.title ?? '', task.brief ?? '',
          task.agentName ?? '', JSON.stringify(task.deps ?? []), now, now,
        );
      }
    });
    return this.listTasks(planId);
  }

  /**
   * 列出一条清单的任务（按建单顺序）。
   * @param {string} planId - 清单 id。
   * @returns {object[]}
   */
  listTasks(planId) {
    return this.require().prepare('SELECT * FROM tasks WHERE plan_id = ? ORDER BY seq ASC, id ASC').all(planId)
      .map(rowToTask);
  }

  /**
   * 列出所有任务（面板一次要把每条链路的进度都画出来）。
   * @param {{limit?:number}} [options] - 选项。
   * @returns {object[]}
   */
  listAllTasks(options = {}) {
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 5000) : 2000;
    return this.require().prepare('SELECT * FROM tasks ORDER BY plan_id ASC, seq ASC LIMIT ?').all(limit).map(rowToTask);
  }

  /**
   * 取一条任务。
   * @param {string} planId - 清单 id。
   * @param {string} taskId - 任务 id。
   * @returns {object|undefined}
   */
  getTask(planId, taskId) {
    const row = this.require().prepare('SELECT * FROM tasks WHERE plan_id = ? AND id = ?').get(planId, taskId);
    return row === undefined ? undefined : rowToTask(row);
  }

  /**
   * 打补丁更新一条任务。
   * @param {string} planId - 清单 id。
   * @param {string} taskId - 任务 id。
   * @param {object} patch - 待更新字段（camelCase）。
   * @returns {object|undefined} 更新后的任务。
   */
  updateTask(planId, taskId, patch) {
    const columns = {
      seq: 'seq', title: 'title', brief: 'brief', agentName: 'agent_name', depsJson: 'deps_json',
      runId: 'run_id', runStatus: 'run_status', attempts: 'attempts', note: 'note',
      startedAt: 'started_at', endedAt: 'ended_at', cancelledAt: 'cancelled_at',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'depsJson' && Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : patch[key]);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(Date.now(), planId, taskId);
      this.require().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE plan_id = ? AND id = ?`).run(...values);
    }
    return this.getTask(planId, taskId);
  }

  /**
   * 按 run id 反查任务（运行结束事件只知道 run id，链路要靠这一步对账）。
   * @param {string} runId - run id。
   * @returns {object|undefined}
   */
  taskByRun(runId) {
    if (typeof runId !== 'string' || runId === '') return undefined;
    const row = this.require().prepare('SELECT * FROM tasks WHERE run_id = ? LIMIT 1').get(runId);
    return row === undefined ? undefined : rowToTask(row);
  }

  //#endregion

  //#region settings

  /**
   * 读设置项。
   * @param {string} key - 键。
   * @param {any} [fallback] - 缺省值。
   * @returns {any}
   */
  getSetting(key, fallback) {
    const row = this.require().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  /**
   * 写设置项。
   * @param {string} key - 键。
   * @param {any} value - 可 JSON 序列化的值。
   * @returns {void}
   */
  setSetting(key, value) {
    this.require().prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  /**
   * 列出以某前缀开头的设置项（迁移与排错用）。
   * @param {string} [prefix] - 前缀；缺省表示全部。
   * @returns {{key:string,value:any}[]}
   */
  listSettings(prefix = '') {
    const rows = prefix === ''
      ? this.require().prepare('SELECT key, value FROM settings').all()
      : this.require()
        .prepare("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'")
        .all(`${prefix.replace(/[%_\\]/g, (match) => `\\${match}`)}%`);
    return rows.map((row) => ({ key: row.key, value: safeParse(row.value) }));
  }

  /**
   * 删除一个设置项。
   * @param {string} key - 键。
   * @returns {boolean} 是否确实删除了。
   */
  deleteSetting(key) {
    const result = this.require().prepare('DELETE FROM settings WHERE key = ?').run(key);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * 读全局启用开关。
   *
   * 为什么是**全局**而不是按会话：子 agent 的配置本来就是全局的（一张 agents 表），
   * 开关却是按会话的话，新开一个对话就会得到一个「配置都在、却什么都看不见」的界面——
   * 真机上用户就是这么反馈的（「其他窗口不显示已经配置了的子agent」）。
   * 开关的作用域必须和它控制的东西一致：配置是全局的，开关就该是全局的。
   * @returns {boolean}
   */
  isEnabled() {
    return this.getSetting(ENABLE_KEY, false) === true;
  }

  /**
   * 写全局启用开关。
   * @param {boolean} enabled - 目标状态。
   * @returns {boolean} 落库后的状态。
   */
  setEnabled(enabled) {
    this.setSetting(ENABLE_KEY, enabled === true);
    return this.isEnabled();
  }

  /**
   * 一次性迁移：把旧版「按会话的开关」合并成全局开关。
   *
   * 只在不存全局键时执行一次；只要历史上有任何一个会话是开着的，就认为用户是想开着的
   * （升级后不该出现「我明明是开着的，怎么又关了」）。迁移完把旧的按会话键删掉，
   * 免得两套数据并存、以后分不清谁说了算。
   * @returns {{migrated:boolean,sources:number}}
   */
  migrateEnableScope() {
    if (this.getSetting(ENABLE_KEY, undefined) !== undefined) return { migrated: false, sources: 0 };
    const legacy = this.listSettings('session-enabled:');
    if (legacy.length === 0) return { migrated: false, sources: 0 };
    const anyOn = legacy.some((row) => row.value === true);
    this.setSetting(ENABLE_KEY, anyOn);
    for (const row of legacy) this.deleteSetting(row.key);
    return { migrated: true, sources: legacy.length };
  }

  //#endregion
}

/** 全局启用开关的设置键。 */
export const ENABLE_KEY = 'enabled';

/**
 * 排名比较器（口径见 agentLeaderboard 注释）。
 * @param {object} left - 甲。
 * @param {object} right - 乙。
 * @returns {number}
 */
function compareLeaderboard(left, right) {
  const scoreDelta = (right.avgScore ?? -1) - (left.avgScore ?? -1);
  if (scoreDelta !== 0) return scoreDelta;
  const rateDelta = (right.successRate ?? -1) - (left.successRate ?? -1);
  if (rateDelta !== 0) return rateDelta;
  if (right.runs !== left.runs) return right.runs - left.runs;
  return left.agentName.localeCompare(right.agentName);
}

/** @param {number} value @returns {number} */
function round2(value) { return Math.round(Number(value) * 100) / 100; }
/** @param {number} value @returns {number} */
function round4(value) { return Math.round(Number(value) * 10000) / 10000; }

/**
 * 行 → agent 对象（snake_case → camelCase 只在边界做一次）。
 * @param {object} row - sqlite 行。
 * @returns {object}
 */
function rowToAgent(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    transport: row.transport,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    apiBase: row.api_base,
    credentialRef: row.credential_ref,
    maxContext: Number(row.max_context ?? 0),
    maxTokens: Number(row.max_tokens ?? 0),
    reasoningEffort: row.reasoning_effort,
    toolPolicy: row.tool_policy,
    persona: row.persona,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
  };
}

/**
 * 行 → 运行对象。
 * @param {object} row - sqlite 行。
 * @returns {object}
 */
function rowToRun(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    label: row.label,
    prompt: row.prompt,
    status: row.status,
    queuedAt: Number(row.queued_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    durationMs: Number(row.duration_ms ?? 0),
    stepMs: Number(row.step_ms ?? 0),
    tokensIn: Number(row.tokens_in ?? 0),
    tokensOut: Number(row.tokens_out ?? 0),
    tokPerS: Number(row.tok_per_s ?? 0),
    stopReason: row.stop_reason,
    error: row.error,
    diagnostic: row.diagnostic,
    outputTail: row.output_tail,
    truncated: Number(row.truncated ?? 0) === 1,
    structured: row.structured_json === null || row.structured_json === undefined
      ? null
      : safeParse(row.structured_json),
    roundId: row.round_id,
    taskKey: row.task_key,
    invokedBy: row.invoked_by,
  };
}

/**
 * 行 → 清单对象。
 * @param {object} row - sqlite 行。
 * @returns {object}
 */
function rowToPlan(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    parentSessionId: row.parent_session_id,
    autoActivate: Number(row.auto_activate ?? 1) === 1,
    activationError: row.activation_error ?? '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 行 → 任务对象。
 *
 * 注意这里**没有** `state` 字段：任务状态是 `lib/src/plan.js` 现算的（见那边文件头的解释）。
 * 这一层只负责把事实原样搬出来。
 * @param {object} row - sqlite 行。
 * @returns {object}
 */
function rowToTask(row) {
  return {
    planId: row.plan_id,
    id: row.id,
    seq: Number(row.seq ?? 0),
    title: row.title,
    brief: row.brief,
    agentName: row.agent_name,
    deps: safeParse(row.deps_json) ?? [],
    runId: row.run_id ?? '',
    runStatus: row.run_status ?? '',
    attempts: Number(row.attempts ?? 0),
    note: row.note ?? '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    cancelledAt: row.cancelled_at === null || row.cancelled_at === undefined ? null : Number(row.cancelled_at),
  };
}

/**
 * 行 → 评价对象。
 * @param {object} row - sqlite 行。
 * @returns {object}
 */
function rowToEvaluation(row) {
  return {
    id: row.id,
    runId: row.run_id,
    roundId: row.round_id,
    score: Number(row.score ?? 0),
    verdict: row.verdict,
    dimensions: safeParse(row.dimensions_json) ?? {},
    notes: row.notes,
    evaluator: row.evaluator,
    createdAt: Number(row.created_at),
  };
}

/**
 * 宽松解析 JSON（坏数据不应让整行读不出来）。
 * @param {string} text - JSON 文本。
 * @returns {any}
 */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
