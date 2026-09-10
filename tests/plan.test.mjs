/**
 * 任务清单/依赖图的纯逻辑测试。
 *
 * 这一层没有 DSH、没有 sqlite、没有时钟，所以可以被穷举——而它必须被穷举，
 * 因为宿主（调度）与界面（配色）都读同一份结论：一个算错的状态会同时骗过两处，
 * 且症状是「图上说在跑、链路却不动」这种最难查的不一致。
 *
 * 断言方式刻意用**具体值**（哪个任务是什么状态）而不是「不为空」：
 * 「看起来有输出」在状态机上等于没有验证。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_TASKS_PER_PLAN,
  evaluate,
  layering,
  renderBoardText,
  topoOrder,
  validatePlanDraft,
} from '../lib/src/plan.js';

/** 造一条任务事实（只写关心的字段，其余给默认值）。 */
function task(id, overrides = {}) {
  return {
    id,
    seq: Number(String(id).replace(/[^0-9]/g, '')) || 1,
    title: `任务 ${id}`,
    brief: '',
    agentName: '研究员',
    deps: [],
    runId: '',
    runStatus: '',
    cancelledAt: null,
    attempts: 0,
    ...overrides,
  };
}

test('校验：缺 title / 空 tasks / 非对象都拒绝，并给出可行动的理由', () => {
  const noTitle = validatePlanDraft({ tasks: [{ title: 'A', agent: '研究员' }] });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.errors.join('\n'), /title 必填/);

  const noTasks = validatePlanDraft({ title: '发布', tasks: [] });
  assert.equal(noTasks.ok, false);
  assert.match(noTasks.errors.join('\n'), /至少要有一项/);

  const notObject = validatePlanDraft('把任务给我');
  assert.equal(notObject.ok, false);
  assert.match(notObject.errors.join('\n'), /必须是对象/);
});

test('校验：一次报出全部错误，而不是只报第一条', () => {
  const checked = validatePlanDraft({
    title: '发布',
    tasks: [
      { id: 't1', title: '', agent: '研究员' }, // 缺 title
      { id: 't1', title: '重复的 id', agent: '研究猿' }, // id 重复 + agent 写错
      { id: 't3', title: '悬空依赖', agent: '研究员', deps: ['nope'] },
    ],
  }, { knownAgents: ['研究员'] });
  assert.equal(checked.ok, false);
  const all = checked.errors.join('\n');
  assert.match(all, /title 必填/);
  assert.match(all, /出现了 2 次/);
  assert.match(all, /不是已配置的子 agent/);
  assert.match(all, /不存在的任务「nope」/);
});

test('校验：自动编号 t1..tN，且后面的任务可以依赖前面定义的', () => {
  const checked = validatePlanDraft({
    title: '三段链路',
    knownAgents: undefined,
    tasks: [
      { title: '调研', agent: '研究员' },
      { title: '设计', agent: '研究员', deps: ['t1'] },
      { title: '实现', agent: '工程师', deps: ['t2'] },
    ],
  }, { knownAgents: ['研究员', '工程师'] });
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.deepEqual(checked.plan.tasks.map((item) => item.id), ['t1', 't2', 't3']);
  assert.deepEqual(checked.plan.tasks[2].deps, ['t2']);
  assert.equal(checked.plan.autoActivate, true);
});

test('校验：环被拒绝，并且报出**具体**的环路径（可行动的错误）', () => {
  const checked = validatePlanDraft({
    title: '环',
    tasks: [
      { id: 'a', title: 'A', agent: '研究员', deps: ['c'] },
      { id: 'b', title: 'B', agent: '研究员', deps: ['a'] },
      { id: 'c', title: 'C', agent: '研究员', deps: ['b'] },
    ],
  }, { knownAgents: ['研究员'] });
  assert.equal(checked.ok, false);
  const message = checked.errors.join('\n');
  assert.match(message, /形成了环/);
  // 路径必须闭环，模型才能据此找出该断开的那条边。
  const match = /依赖形成了环：(.+?)。/.exec(message);
  assert.ok(match !== null, `错误信息里应当有环路径：${message}`);
  const path = match[1].split(' → ');
  assert.ok(path.length >= 4, `环路径至少要有一进一出：${match[1]}`);
  assert.equal(path[0], path[path.length - 1], `环路径必须首尾相同：${match[1]}`);
});

test('校验：自依赖与写错的 agent 名当场拒绝（否则任务永远停在等待激活）', () => {
  const checked = validatePlanDraft({
    title: '自依赖',
    tasks: [{ id: 'a', title: 'A', agent: '研究员', deps: ['a'] }],
  }, { knownAgents: ['研究员'] });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /不能依赖自己/);

  const bad = validatePlanDraft({
    title: '错名字',
    tasks: [{ id: 'a', title: 'A', agent: '研究员 ' }],
  }, { knownAgents: ['研究员', '审核员'] });
  // 前后空格被 trim 掉，所以这条应当通过；换个真正不存在的名字再看。
  assert.equal(bad.ok, true, bad.errors.join('\n'));

  const missing = validatePlanDraft({
    title: '错名字',
    tasks: [{ id: 'a', title: 'A', agent: '研究猿' }],
  }, { knownAgents: ['研究员'] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /不是已配置的子 agent/);
});

test('校验：任务数上限是硬拒绝，不是静默截断', () => {
  const tasks = Array.from({ length: MAX_TASKS_PER_PLAN + 1 }, (_unused, index) => ({
    id: `t${index + 1}`, title: `任务 ${index + 1}`, agent: '研究员',
  }));
  const checked = validatePlanDraft({ title: '太多', tasks }, { knownAgents: ['研究员'] });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /最多 64 项/);
});

test('追加任务时，可以依赖这条清单里已有的任务（且不需要再给一次清单名）', () => {
  const checked = validatePlanDraft({
    title: '',
    tasks: [{ id: 't4', title: '追加的复核', agent: '审核员', deps: ['t1', 't2'] }],
  }, {
    knownAgents: ['审核员'],
    takenIds: new Set(['t1', 't2', 't3']),
    baseIds: new Set(['t1', 't2', 't3']),
    requireTitle: false,
  });
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.deepEqual(checked.plan.tasks[0].deps, ['t1', 't2']);

  // 不写 requireTitle 时仍然要求清单名——否则「新建」会被误当成「追加」，产生一堆没有名字的清单。
  const noTitle = validatePlanDraft({ title: '', tasks: [{ id: 't1', title: 'A', agent: '审核员' }] });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.errors.join('\n'), /title 必填/);
});

test('状态派生：没依赖就是 ready，依赖没跑完就是 waiting，且写清楚在等谁', () => {
  const result = evaluate([
    task('t1'),
    task('t2', { deps: ['t1'] }),
    task('t3', { deps: ['t1', 't2'] }),
  ]);
  assert.equal(result.byId.t1.state, 'ready');
  assert.equal(result.byId.t2.state, 'waiting');
  assert.deepEqual(result.byId.t2.waitingFor, ['t1']);
  assert.equal(result.byId.t3.state, 'waiting');
  assert.deepEqual(result.byId.t3.waitingFor, ['t1', 't2']);
  assert.deepEqual(result.ready, ['t1']);
});

test('状态派生：依赖完成后下游变成「可执行」，这正是自动激活的触发条件', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'completed' }),
    task('t2', { deps: ['t1'] }),
    task('t3', { deps: ['t2'] }),
  ]);
  assert.equal(result.byId.t1.state, 'done');
  assert.equal(result.byId.t2.state, 'ready');
  assert.equal(result.byId.t3.state, 'waiting');
  assert.deepEqual(result.ready, ['t2']);
});

test('状态派生：排队与运行都算 running，但 runStatus 如实带出去（排队 ≠ 在跑）', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'queued' }),
    task('t2', { runId: 'r2', runStatus: 'running' }),
    task('t3', { deps: ['t1'] }),
  ]);
  assert.equal(result.byId.t1.state, 'running');
  assert.equal(result.byId.t1.runStatus, 'queued');
  assert.equal(result.byId.t2.state, 'running');
  assert.equal(result.byId.t3.state, 'waiting');
  assert.deepEqual(result.running, ['t1', 't2']);
});

test('状态派生：上游失败 → 下游 blocked（不会自己好），与 waiting 明确区分', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'error' }),
    task('t2', { deps: ['t1'] }),
    task('t3', { deps: ['t2'] }),
  ]);
  assert.equal(result.byId.t1.state, 'failed');
  assert.equal(result.byId.t2.state, 'blocked');
  assert.deepEqual(result.byId.t2.blockedBy, ['t1']);
  // 阻塞会沿着链路传下去：t3 的依赖 t2 永远不可能就绪，所以它也是 blocked 而不是 waiting。
  assert.equal(result.byId.t3.state, 'blocked');
  assert.deepEqual(result.byId.t3.blockedBy, ['t2']);
});

test('状态派生：阻塞优先于等待——同时有失败上游与未完成上游时，报「阻塞」才有用', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'timeout' }),
    task('t2', { runId: 'r2', runStatus: 'running' }),
    task('t3', { deps: ['t1', 't2'] }),
  ]);
  assert.equal(result.byId.t3.state, 'blocked');
  assert.deepEqual(result.byId.t3.blockedBy, ['t1']);
});

test('状态派生：取消是人工决定，压过运行状态；下游因此也是阻塞', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'completed', cancelledAt: 123 }),
    task('t2', { deps: ['t1'] }),
  ]);
  assert.equal(result.byId.t1.state, 'cancelled');
  assert.equal(result.byId.t2.state, 'blocked');
});

test('分层：深度取最长路径，菱形结构里两条支路汇合到同一层', () => {
  const { layers, depth } = layering([
    task('t1'),
    task('t2', { deps: ['t1'] }),
    task('t3', { deps: ['t1'] }),
    task('t4', { deps: ['t2', 't3'] }),
  ]);
  assert.deepEqual(layers, [['t1'], ['t2', 't3'], ['t4']]);
  assert.equal(depth.get('t4'), 2);
});

test('可执行任务的顺序：先按层，再按建单顺序（图上的推进顺序 = 激活顺序）', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'completed' }),
    task('t5', { seq: 5, deps: ['t1'] }),
    task('t2', { seq: 2 }),
    task('t6', { seq: 6, deps: ['t1'] }),
  ]);
  // t5 与 t6 同层（依赖 t1），都在第 2 层；t2 无依赖在第 1 层。
  assert.deepEqual(result.ready, ['t2', 't5', 't6']);
});

test('进度：done/total 与各桶计数，百分比只算真正完成的', () => {
  const result = evaluate([
    task('t1', { runId: 'r1', runStatus: 'completed' }),
    task('t2', { runId: 'r2', runStatus: 'running' }),
    task('t3', { runId: 'r3', runStatus: 'error' }),
    task('t4'),
  ]);
  assert.deepEqual(result.progress, {
    total: 4, done: 1, active: 1, ready: 1, waiting: 0, blocked: 0, failed: 1, cancelled: 0, closed: 2, percent: 25,
  });
});

test('环安全：数据被手工改成有环时，兜底为 waiting 而不是死循环或抛错', () => {
  const cyclic = [
    task('a', { deps: ['b'] }),
    task('b', { deps: ['a'] }),
  ];
  assert.deepEqual(topoOrder(cyclic), []);
  const result = evaluate(cyclic);
  assert.equal(result.byId.a.state, 'waiting');
  assert.equal(result.byId.b.state, 'waiting');
});

test('渲染给模型的文本：分层、状态标签、等待原因、下一步都在', () => {
  const text = renderBoardText(
    { id: 'pl_1', title: '发布 0.2.0', autoActivate: true },
    [
      task('t1', { title: '调研', runId: 'r1', runStatus: 'completed' }),
      task('t2', { title: '实现', agentName: '工程师', deps: ['t1'], runId: 'r2', runStatus: 'running' }),
      task('t3', { title: '评审', agentName: '审核员', deps: ['t2'] }),
      task('t4', { title: '发布', agentName: '工程师', deps: ['t3'] }),
    ],
  );
  assert.match(text, /任务清单「发布 0.2\.0」（pl_1，依赖完成自动激活）/);
  assert.match(text, /进度 1\/4/);
  assert.match(text, /第 1 层/);
  assert.match(text, /\[已完成\] t1 调研 → 研究员/);
  assert.match(text, /\[运行中\] t2 实现 → 工程师/);
  assert.match(text, /\[等待依赖\] t3 评审 → 审核员（等 t2/);
  assert.match(text, /下一步：正在跑：t2/);
});

test('渲染给模型的文本：blocked 的任务要说清是上游失败，而不是「还在等」', () => {
  const text = renderBoardText(
    { id: 'pl_2', title: '失败链路', autoActivate: false },
    [
      task('t1', { title: '调研', runId: 'r1', runStatus: 'error' }),
      task('t2', { title: '实现', deps: ['t1'] }),
    ],
  );
  assert.match(text, /手动激活/);
  assert.match(text, /\[被上游阻塞\] t2 实现/);
  assert.match(text, /上游 t1 已失败\/取消/);
  assert.match(text, /需要重试上游或取消本任务/);
});

test('渲染：focus 的任务带上说明正文，超长会明确标注被截断', () => {
  const text = renderBoardText(
    { id: 'pl_3', title: '带说明', autoActivate: true },
    [task('t1', { title: '调研', brief: 'A'.repeat(50) })],
    { focusTaskId: 't1', briefLimit: 20 },
  );
  assert.match(text, /说明：A{20}…（已截断）/);
});
