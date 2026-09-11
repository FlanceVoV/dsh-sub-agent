/**
 * 团队模式（群组讨论 + 群主派活）的测试。
 *
 * 这一层值得单独测，因为它有三个**只有真跑一遍才会暴露**的性质：
 *
 *  1. **轮流制**：同一时刻只能有一个人在说。它不是提示词里的礼貌要求，而是驱动循环的
 *     串行结构——一旦有人把循环写成并发，症状是「四个人同时抢话」外加费用翻倍。
 *     这里用「任意时刻在跑的运行 ≤ 1」把它钉住。
 *  2. **必然终止**：轮次上限一到就强制收尾。模型不会主动停，所以这条不能靠它自觉；
 *     不测的话，一次线上事故就是「群聊跑了 40 轮」，账单会替我们发现。
 *  3. **派活与回报是一条闭环**：群主派出去的任务真的开跑，跑完宿主把汇报发回群里并
 *     把群主叫回来。这条断掉的表现非常隐蔽——讨论看起来很热闹，活却没人干。
 *
 * 用真 sqlite + 假 runtime + **真的任务看板**（createTaskBoard）：假 runtime 让我们精确
 * 控制「谁在第几轮说了什么」，而任务链那一半必须是真货——派活、依赖、自动激活、
 * 汇报回群，全都在那半边，用假货测等于没测。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HubStore } from '../lib/src/store.js';
import { createTaskBoard } from '../lib/src/tasks.js';
import { createHandler } from '../lib/src/http.js';
import { buildTools } from '../lib/src/tools.js';
import {
  createTeamBoard,
  groupRules,
  parseDirective,
  parseTeamDeclaration,
  renderTranscript,
} from '../lib/src/team.js';

/** 每个用例一份独立临时库（sqlite 是文件，不能共享）。 */
const dirs = [];
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sbh-team-'));
  dirs.push(dir);
  return new HubStore({ dbPath: join(dir, 'hub.db'), log: undefined }).open();
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* WAL 偶尔还占着文件，删不掉就算了 */
    }
  }
});

/** 静默 logger：测试不该往 stdout 里灌日志。 */
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 用户声明团队的原文（就是需求里那三行）。 */
const DECLARATION = [
  '团队名称：发布项目组',
  '团队负责人：@群主甲',
  '团队成员：@成员乙 @成员丙',
].join('\n');

/** 全量 config（团队相关键必须齐，否则会被默认值掩盖掉被测行为）。 */
function config(overrides = {}) {
  return {
    taskAutoActivate: true,
    taskUpstreamChars: 2000,
    teamMaxRounds: 3,
    teamMessageChars: 300,
    teamTranscriptChars: 6000,
    teamMaxNudges: 1,
    ...overrides,
  };
}

/**
 * 假运行时。
 *
 * 只实现团队驱动与任务看板真正用到的那几个方法。`start` **不会**自动完成——
 * 什么时候结束由测试决定，这正是「谁在第几轮说了什么」能被精确断言的前提。
 */
function makeRuntime() {
  const listeners = new Set();
  const runs = new Map();
  const settled = new Map();
  let seq = 0;
  return {
    start(input) {
      seq += 1;
      const id = `run-${seq}`;
      runs.set(id, {
        id,
        agentName: input.agent.name,
        parentSessionId: input.parentSessionId,
        parentAgentName: input.parentAgent?.name,
        prompt: input.prompt,
        busy: true,
        elapsedMs: 0,
      });
      return { ok: true, run: { id } };
    },
    waitFor(id) {
      if (settled.has(id)) return Promise.resolve(settled.get(id));
      return new Promise((resolve) => { runs.get(id).resolve = resolve; });
    },
    /** 让一次运行落地（并像真 runtime 那样发一帧 run 事件）。 */
    settle(id, outcome = {}) {
      const record = runs.get(id);
      assert.ok(record !== undefined, `没有这次运行：${id}`);
      const result = { runId: id, status: 'completed', output: '', elapsedMs: 120, ...outcome };
      record.busy = false;
      record.elapsedMs = result.elapsedMs;
      settled.set(id, result);
      record.resolve?.(result);
      for (const listener of listeners) {
        listener({
          kind: 'run',
          runId: id,
          summary: { runId: id, agentName: record.agentName, status: result.status, busy: false, elapsedMs: result.elapsedMs },
        });
      }
    },
    snapshot() {
      return {
        runs: [...runs.values()].map((run) => ({
          runId: run.id, agentName: run.agentName, busy: run.busy, elapsedMs: run.elapsedMs, tokPerS: 0,
        })),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // 真 runtime 的 `resolveParent` 拿不到会话就返回 error。桩必须照着来：
    // 一句「永远成功」会把「工具没把父会话传进来」这种缺陷整个盖住——
    // 真机上团队一开就报「找不到会话  对应的活动 agent」（空串），正是这么来的。
    resolveParent(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { error: `找不到会话 ${sessionId ?? ''} 对应的活动 agent（该会话可能尚未在本进程打开）` };
      }
      return { agent: { name: 'parent-agent' } };
    },
    cancel: () => false,
    detail: () => undefined,
    /** 测试用：当前在跑的运行。 */
    busy: () => [...runs.values()].filter((run) => run.busy === true),
    /** 测试用：最近一次启动的运行。 */
    last: () => [...runs.values()].at(-1),
    count: () => runs.size,
  };
}

/** 让事件循环跑几轮（驱动是异步的，断言前必须给它机会走到下一步）。 */
function flush(rounds = 10) {
  return new Promise((resolve) => {
    let left = rounds;
    const step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

/** 装配一套「存储 + 任务看板 + 团队看板」，并把团队模式打开。 */
function makeTeamHub(overrides = {}) {
  const store = openStore();
  store.setEnabled(true);
  store.setTeamMode(base.teamMode !== false);
  for (const name of ['群主甲', '成员乙', '成员丙']) {
    store.insertAgent({
      name, transport: 'spawn', modelProvider: 'p', modelId: 'm', maxContext: 0,
      maxTokens: 0, toolPolicy: 'inherit', persona: '',
    });
  }
  const runtime = makeRuntime();
  const cfg = config(overrides);
  const tasks = createTaskBoard({ ctx: {}, store, runtime, config: cfg, log });
  const detachTasks = tasks.attach();
  const team = createTeamBoard({ ctx: {}, store, runtime, tasks, config: cfg, log });
  const detachTeam = team.attach();
  return {
    store, runtime, tasks, team, config: cfg,
    close() { detachTeam?.(); detachTasks?.(); store.close(); },
  };
}
/** 允许个别用例在装配前改开关（默认团队模式开着）。 */
const base = { teamMode: true };

//#region 声明解析

test('声明解析：需求里那三行原文', () => {
  const parsed = parseTeamDeclaration(DECLARATION);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.spec, {
    name: '发布项目组',
    owner: '群主甲',
    members: ['成员乙', '成员丙'],
    declaration: DECLARATION,
  });
  assert.deepEqual(parsed.errors, []);
});

test('声明解析：群主同时出现在成员里——从成员列表里摘掉，不算错误', () => {
  // 「团队负责人：@甲」+「团队成员：@甲@乙」是很自然的写法。
  // 不摘掉的话，群主会给自己点名，同一个人算两个席位。
  const parsed = parseTeamDeclaration([
    '团队名称：T',
    '团队负责人：@甲',
    '团队成员：@甲、@乙',
  ].join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.owner, '甲');
  assert.deepEqual(parsed.spec.members, ['乙']);
});

test('声明解析：全角冒号、顿号、无 @ 的成员写法都收', () => {
  const parsed = parseTeamDeclaration([
    '团队名称:T2',
    '负责人: @甲',
    '成员: 乙、丙',
  ].join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.name, 'T2');
  assert.equal(parsed.spec.owner, '甲');
  assert.deepEqual(parsed.spec.members, ['乙', '丙']);
});

test('声明解析：@句柄不含全角括号（「@甲（负责统筹）」的句柄是「甲」）', () => {
  const parsed = parseTeamDeclaration([
    '团队名称：T3',
    '团队负责人：@甲（负责统筹）',
    '团队成员：@乙（后端）@丙（前端）',
  ].join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.owner, '甲');
  assert.deepEqual(parsed.spec.members, ['乙', '丙']);
});

test('声明解析：缺群主 / 缺成员都要说清缺什么，而不是悄悄开一个残缺的团队', () => {
  const noOwner = parseTeamDeclaration('团队名称：T\n团队成员：@甲@乙');
  assert.equal(noOwner.ok, false);
  assert.match(noOwner.errors.join('\n'), /团队负责人/);

  const noMembers = parseTeamDeclaration('团队名称：T\n团队负责人：@甲');
  assert.equal(noMembers.ok, false);
  assert.match(noMembers.errors.join('\n'), /团队成员/);

  const empty = parseTeamDeclaration('   ');
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join('\n'), /空/);
});

test('声明解析：没写团队名只警告，用占位名继续（组队比名字重要）', () => {
  const parsed = parseTeamDeclaration('团队负责人：@甲\n团队成员：@乙');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.name, '未命名团队');
  assert.equal(parsed.warnings.length, 1);
});

//#endregion

//#region 指令解析

const PLAYERS = ['群主甲', '成员乙', '成员丙'];

test('指令解析：最后一行 @名字 = 点名发言（可以一行点多人，按顺序）', () => {
  const directive = parseDirective('我们先定接口。\n@成员乙 @成员丙', PLAYERS);
  assert.equal(directive.kind, 'speak');
  assert.deepEqual(directive.to, ['成员乙', '成员丙']);
});

test('指令解析：@用户 / @收尾 / @等待 三种特殊指令', () => {
  assert.equal(parseDirective('这需要你拍板\n@用户：选 A 还是 B', PLAYERS).kind, 'user');
  assert.equal(parseDirective('够了\n@收尾', PLAYERS).kind, 'close');
  assert.equal(parseDirective('等他们跑完\n@等待', PLAYERS).kind, 'wait');
  assert.equal(parseDirective('【下一步】@用户', PLAYERS).kind, 'user');
  assert.equal(parseDirective('下一步：@成员乙', PLAYERS).kind, 'speak');
});

test('指令解析：正文里的提及不算指令（「我同意 @成员乙 的看法」不该被当成调度）', () => {
  const directive = parseDirective('我同意 @成员乙 的看法，另外 @成员丙 的担心也成立。\n这一轮先这样。', PLAYERS);
  assert.equal(directive.kind, 'missing');
});

test('指令解析：点了不在团队里的人 → invalid，并说清点的是谁', () => {
  const directive = parseDirective('@路人丁 你来说', PLAYERS);
  assert.equal(directive.kind, 'invalid');
  assert.match(directive.reason, /@路人丁/);
});

test('指令解析：完全没给指令 → missing（宿主会提醒一次，然后按已有内容收尾）', () => {
  const directive = parseDirective('我说完了，大家辛苦。', PLAYERS);
  assert.equal(directive.kind, 'missing');
  assert.equal(directive.line, '');
});

//#endregion

//#region 记录渲染与群规

test('群聊记录：从最新往回取，超预算时如实写出省略了多少条', () => {
  const messages = Array.from({ length: 20 }, (_item, index) => ({
    role: 'member', speaker: `成员${index}`, kind: 'chat', text: 'x'.repeat(50),
  }));
  const text = renderTranscript(messages, { maxChars: 300, perMessageChars: 60 });
  assert.match(text, /更早的 \d+ 条发言因长度限制已省略/);
  assert.ok(text.includes('@成员19'), '最新的那条必须在');
  assert.ok(!text.includes('@成员0'), '最旧的那些被省略');
});

test('群聊记录：一条发言都没有时给一句人话，而不是空字符串', () => {
  assert.equal(renderTranscript([]), '（还没有人发言）');
});

test('群规把「短 / 可以争论 / 独立思考」写成可执行要求（不是口号）', () => {
  const rules = groupRules(100).join('\n');
  assert.match(rules, /不超过 100 字/);
  assert.match(rules, /可以争论/);
  assert.match(rules, /独立思考/);
  assert.match(rules, /第一性原理/);
});

//#endregion

//#region 服务：开关与建群

test('团队模式关着时开不了团队，并且明确告诉用户去把开关打开', () => {
  const previous = base.teamMode;
  base.teamMode = false;
  const hub = makeTeamHub();
  base.teamMode = previous;
  try {
    const result = hub.team.open({ declaration: DECLARATION, mission: 'x', parentSessionId: 's1' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /团队模式没有打开/);
    assert.equal(hub.store.listTeams().length, 0, '拒绝之后不该留下半个团队');
  } finally {
    hub.close();
  }
});

test('声明的成员没配置成子 agent → 拒绝，并列出已配置的名字（不猜、不改名）', () => {
  const hub = makeTeamHub();
  try {
    const result = hub.team.open({
      declaration: '团队名称：X\n团队负责人：@不存在的甲\n团队成员：@群主甲',
      mission: 'x',
      parentSessionId: 's1',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /@不存在的甲/);
    assert.match(result.errors.join('\n'), /已配置的是/);
  } finally {
    hub.close();
  }
});

test('建群：留下团队记录与一条系统发言，并立刻让群主开场', async () => {
  const hub = makeTeamHub();
  try {
    const opened = hub.team.open({
      declaration: DECLARATION, mission: '把 0.3.0 发出去', parentSessionId: 's1', parentAgent: { name: 'parent' },
    });
    assert.equal(opened.ok, true);
    const team = opened.team;
    assert.equal(team.status, 'discussing');
    assert.deepEqual(team.members, ['成员乙', '成员丙']);

    const messages = hub.store.listTeamMessages(team.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].text, /发布项目组/);

    await flush();
    const first = hub.runtime.last();
    assert.equal(first.agentName, '群主甲', '开场发言的是群主');
    assert.match(first.prompt, /群主（负责人）/);
    assert.match(first.prompt, /群规/);
    assert.match(first.prompt, /团队使命：把 0.3.0 发出去/);
  } finally {
    hub.close();
  }
});

//#endregion

//#region 服务：轮流制与收敛

test('轮流制：群主点名 → 成员说 → 话语权回到群主，同一时刻只有一个人在说', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;

    await flush();
    const ownerRun = hub.runtime.last();
    assert.equal(hub.runtime.busy().length, 1, '同一时刻只有一个运行（轮流制的硬边界）');

    hub.runtime.settle(ownerRun.id, { output: '先定接口。\n@成员乙 @成员丙' });
    await flush();
    const second = hub.runtime.last();
    assert.equal(hub.runtime.busy().length, 1);
    assert.equal(second.agentName, '成员乙', '按群主点名的顺序逐个发言');
    assert.match(second.prompt, /你是「发布项目组」的成员/);

    hub.runtime.settle(second.id, { output: '同意，但并发闸要先改。' });
    await flush();
    const third = hub.runtime.last();
    assert.equal(third.agentName, '成员丙', '队列里还有一位，先让他说完');

    hub.runtime.settle(third.id, { output: '我没意见。' });
    await flush();
    const fourth = hub.runtime.last();
    assert.equal(fourth.agentName, '群主甲', '成员说完之后话语权回到群主');
    assert.equal(hub.team.get(team.id).rounds, 2);

    hub.runtime.settle(fourth.id, { output: '那就这么定。\n@收尾' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'closed');
    const messages = hub.store.listTeamMessages(team.id);
    assert.deepEqual(
      messages.map((message) => message.speaker || message.role),
      ['system', '群主甲', '成员乙', '成员丙', '群主甲', 'system'],
    );
  } finally {
    hub.close();
  }
});

test('群主漏给「下一步」：先提醒一次，再漏就按已有内容收尾（不无限空转）', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;

    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '我觉得应该这样（但没有点名）。' });
    await flush();
    const nudged = hub.store.listTeamMessages(team.id).filter((message) => message.role === 'system');
    assert.equal(nudged.length, 2, '系统发言：建群 + 一次协议提示');
    assert.match(nudged[1].text, /没有给出下一步/);
    assert.equal(hub.team.get(team.id).status, 'discussing', '提醒之后继续讨论');

    hub.runtime.settle(hub.runtime.last().id, { output: '还是没点名。' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'closed', '提醒用完就收尾');
  } finally {
    hub.close();
  }
});

test('轮次上限必然终止：maxRounds=2 时群主的第 2 次发言就是收尾轮', async () => {
  const hub = makeTeamHub({ teamMaxRounds: 2 });
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;

    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '开场。\n@成员乙' });
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '我补充一句。' });
    await flush();
    const finalRun = hub.runtime.last();
    assert.equal(finalRun.agentName, '群主甲');
    assert.match(finalRun.prompt, /收尾（轮次已到上限/);

    // 收尾轮即使群主还想点名，也必须在这一次之后结束。
    hub.runtime.settle(finalRun.id, { output: '我的总结是……\n@成员乙 你再来一轮' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'closed');
    assert.equal(hub.runtime.busy().length, 0, '收尾之后不该再有人被叫起来说话');
  } finally {
    hub.close();
  }
});

test('群主 @用户：讨论挂起并写明等谁拍板；用户说一句就解锁', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;

    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '这个得你定。\n@用户：选 A 还是 B' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'awaiting_user');
    assert.equal(hub.runtime.busy().length, 0, '等用户时不该有人在跑');
    const notice = hub.store.listTeamMessages(team.id).at(-1);
    assert.match(notice.text, /@用户/);

    const said = hub.team.userSay(team.id, '选 A');
    assert.equal(said.ok, true);
    assert.equal(said.message.role, 'user');
    assert.equal(hub.team.get(team.id).status, 'discussing');
    await flush();
    assert.equal(hub.runtime.last().agentName, '群主甲', '用户说完话语权回到群主');
  } finally {
    hub.close();
  }
});

test('群主 @等待：没有任何任务在跑时会被拦下来（否则这场会无声地死在那里）', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;

    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '等结果。\n@等待' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'discussing', '链上没人干活，等下去就是死锁');
    const last = hub.store.listTeamMessages(team.id).at(-1);
    assert.match(last.text, /没有在跑、也没有就绪/);

    // 再犟一次也必须被终止：任何「提醒 → 再提醒」的路径都是无限花费。
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '我说了等结果。\n@等待' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'closed', '反复给不可执行的指令要收尾，不能无限空转');
    assert.equal(hub.runtime.busy().length, 0);
  } finally {
    hub.close();
  }
});

test('暂停与收尾：暂停之后不再自动往下走；关掉团队模式会顺手暂停讨论', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    await flush();
    const first = hub.runtime.last();

    hub.team.pause(team.id, '测试暂停');
    assert.equal(hub.team.get(team.id).status, 'paused');
    // 正在说话的那位跑完之后，不该有人被接着叫起来。
    hub.runtime.settle(first.id, { output: '我说完了。\n@成员乙' });
    await flush();
    assert.equal(hub.runtime.busy().length, 0, '暂停之后不再自动发言');
    assert.equal(hub.team.get(team.id).status, 'paused');

    hub.team.start(team.id, { parentAgent: { name: 'parent' } });
    await flush();
    assert.equal(hub.runtime.busy().length, 1, '点「继续」就接着走');

    const paused = hub.team.setTeamMode(false);
    assert.equal(paused.teamMode, false);
    assert.deepEqual(paused.paused, [team.id]);
    assert.equal(hub.team.get(team.id).status, 'paused');
  } finally {
    hub.close();
  }
});

test('宿主重启对账：上次留下的「讨论中」要被改写成「已暂停」，不能假装还在谈', () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', autoStart: false,
    }).team;
    hub.store.updateTeam(team.id, { status: 'discussing' });
    hub.team.attach()();   // 重新走一遍挂载时的对账
    assert.equal(hub.team.get(team.id).status, 'paused');
    assert.match(hub.store.listTeamMessages(team.id).at(-1).text, /宿主重启/);
  } finally {
    hub.close();
  }
});

//#endregion

//#region 服务：派活与回报闭环

test('群主派活：任务真的开跑，跑完宿主把汇报发进群并把群主叫回来', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    await flush();
    const opening = hub.runtime.last();
    assert.equal(opening.agentName, '群主甲');

    // 群主在开场这一轮就把第一批活派出去（讨论与执行是同一场会）。
    const dispatched = hub.team.planTasks(team.id, {
      title: '发布 0.3.0',
      tasks: [{ title: '改接口', agent: '成员乙', brief: '把接口冻结并写清兼容性' }],
    });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.board.plan.autoActivate, true, '团队模式固定自动激活');
    assert.equal(hub.team.get(team.id).planId, dispatched.board.plan.id);

    // 任务被立刻激活 → 成员乙跑起来了。
    await flush();
    const taskRun = hub.runtime.busy().find((run) => run.agentName === '成员乙');
    assert.ok(taskRun !== undefined, '派出去的活必须真的开跑');
    assert.match(taskRun.prompt, /【团队群协议/);
    assert.match(taskRun.prompt, /team_say/);

    // 群聊里能看到派了谁什么活。
    const notice = hub.store.listTeamMessages(team.id).find((message) => /已派发任务链/.test(message.text));
    assert.ok(notice !== undefined);

    // 群主说完开场就挂着等结果（链上确实有人在跑，所以这次 @等待 是成立的）。
    hub.runtime.settle(opening.id, { output: '先让乙动手，我等结果。\n@等待' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'waiting_tasks');

    // 跑完 → 宿主汇报进群 + 群主被叫回来处理。
    hub.runtime.settle(taskRun.id, { output: '接口改完了，产物在 spec/api.md' });
    await flush();
    const reported = hub.store.listTeamMessages(team.id).find((message) => /宿主通知/.test(message.text));
    assert.ok(reported !== undefined, '任务结算必须在群里汇报（模型忘了自己报也有兜底）');
    assert.match(reported.text, /t1/);
    assert.match(reported.text, /已完成/);
    assert.equal(hub.team.get(team.id).status, 'discussing', '汇报之后讨论要继续（不是无声结束）');

    const ownerBack = hub.runtime.busy().find((run) => run.agentName === '群主甲');
    assert.ok(ownerBack !== undefined, '汇报之后群主要被叫回来');
    assert.match(ownerBack.prompt, /执行现状/);
    assert.match(ownerBack.prompt, /t1/);
    assert.match(ownerBack.prompt, /改接口/);
  } finally {
    hub.close();
  }
});

test('重复派活：追加的任务接着已有编号往后排，绝不撞掉已有任务 id', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;

    const first = hub.team.planTasks(team.id, {
      tasks: [{ title: '第一步', agent: '成员乙' }, { title: '第二步', agent: '成员丙' }],
    });
    assert.deepEqual(first.board.tasks.map((task) => task.id), ['t1', 't2']);

    const second = hub.team.planTasks(team.id, { tasks: [{ title: '第三步', agent: '成员乙' }] });
    assert.equal(second.ok, true);
    assert.equal(second.appended, true);
    assert.deepEqual(second.board.tasks.map((task) => task.id), ['t1', 't2', 't3']);
  } finally {
    hub.close();
  }
});

test('派活只能派给自己人；收尾之后不再接活', () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;

    const stranger = hub.team.planTasks(team.id, { tasks: [{ title: 'x', agent: '外人丁' }] });
    assert.equal(stranger.ok, false);
    assert.match(stranger.errors.join('\n'), /不在团队里/);
    assert.match(stranger.errors.join('\n'), /@群主甲/, '拒绝时要把团队成员列出来，方便改');

    const owner = hub.team.planTasks(team.id, { tasks: [{ title: '群主自己也干一段', agent: '群主甲' }] });
    assert.equal(owner.ok, true, '群主也是团队的一员，可以给自己派活');

    hub.team.close(team.id, '结束');
    const after = hub.team.planTasks(team.id, { tasks: [{ title: 'y', agent: '成员乙' }] });
    assert.equal(after.ok, false);
    assert.match(after.errors.join('\n'), /已收尾/);
  } finally {
    hub.close();
  }
});

test('任务说明被注入群协议：成员知道要找谁汇报、什么时候求助', () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;
    const board = hub.store.getTeam(team.id);
    const decorated = hub.team.decorateBrief('把接口冻结。', board);
    assert.match(decorated, /团队群协议/);
    assert.match(decorated, /群主：@群主甲/);
    assert.match(decorated, /team_say/);
    assert.match(decorated, /碰到任何情况/);
    assert.match(decorated, /保持独立思考/);
    assert.match(decorated, /把接口冻结。/);
  } finally {
    hub.close();
  }
});

test('团队模式的提示词摘要让主对话知道群里在谈什么', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '先定接口。\n@成员乙' });
    await flush();

    const lines = hub.team.pendingLines(5);
    const text = lines.join('\n');
    assert.match(text, /正在进行的团队/);
    assert.match(text, /发布项目组/);
    assert.match(text, /群主 @群主甲/);
    assert.match(text, /最后一句/);
    assert.equal(lines.length > 0, true);
  } finally {
    hub.close();
  }
});

//#endregion

//#region HTTP：面板走的那几条路

/**
 * 直接调请求处理器（不起端口）。
 *
 * 与 integration.test.mjs 同一套路：真 handler、假 req/res。
 * 端口是共享资源，测试里最不该出现的就是「在 CI 上撞端口」。
 */
function invoke(handler, request) {
  return new Promise((resolve, reject) => {
    const payload = request.body === undefined ? '' : JSON.stringify(request.body);
    const listeners = new Map();
    const req = {
      method: request.method,
      url: request.url,
      headers: { host: '127.0.0.1:3080' },
      on(event, callback) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(callback);
        return req;
      },
      destroy() {},
    };
    const res = {
      status: 0,
      headersSent: false,
      chunks: [],
      writeHead(status, headers) { res.status = status; res.headers = headers ?? {}; res.headersSent = true; return res; },
      write(chunk) { res.chunks.push(String(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined) res.chunks.push(String(chunk));
        const text = res.chunks.join('');
        let body;
        try { body = text === '' ? undefined : JSON.parse(text); } catch { body = text; }
        resolve({ status: res.status, body });
      },
    };
    Promise.resolve().then(() => handler(req, res)).catch(reject);
    Promise.resolve().then(() => {
      if (payload !== '') for (const callback of listeners.get('data') ?? []) callback(Buffer.from(payload, 'utf8'));
      for (const callback of listeners.get('end') ?? []) callback();
    });
  });
}

/**
 * 假 ctx：让 tools / systemPrompt / subagents 三处都能被捕获。
 *
 * `subagents.sendMessage` 是「群主把结论直接投回主对话」那条通道的落点，
 * 所以它必须在这里被记下来——否则 `team_report` 只能测出「它调了工具」，
 * 测不出「它到底投给谁、投了什么」。
 */
function makeToolCtx() {
  const registered = new Map();
  const sections = [];
  const sent = [];
  const sendMessage = async (sender, targetId, content, options) => {
    sent.push({ sender, targetId, content, options });
    return 'msg-1';
  };
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: (definition) => { registered.set(definition.name, definition); return () => registered.delete(definition.name); } };
      if (name === 'systemPrompt') return { section: (section) => { sections.push(section); return () => {}; } };
      if (name === 'subagents') return { list: () => ['spawn'], sendMessage };
      return undefined;
    },
    on: undefined,
  };
  return { ctx, registered, sections, sent };
}

/** 把团队看板接到 HTTP handler 上。 */
function handlerOf(hub) {
  return createHandler({
    ctx: {},
    store: hub.store,
    runtime: hub.runtime,
    tasks: hub.tasks,
    team: hub.team,
    config: hub.config,
    log,
    version: '0.3.0',
    dataDir: 'test',
    dbPath: 'test/hub.db',
  });
}

test('HTTP /state 把团队跟任务图放在同一帧里（面板不额外发请求就能画出群组）', async () => {
  const hub = makeTeamHub();
  try {
    hub.team.open({ declaration: DECLARATION, mission: 'M', parentSessionId: 's1', autoStart: false });
    const response = await invoke(handlerOf(hub), { method: 'GET', url: '/sub-agent/api/state?sessionId=s1' });
    assert.equal(response.status, 200);
    assert.equal(response.body.team.teamMode, true);
    assert.equal(response.body.team.teams.length, 1);
    assert.equal(response.body.team.teams[0].name, '发布项目组');
    assert.deepEqual(response.body.team.teams[0].members, ['成员乙', '成员丙']);
  } finally {
    hub.close();
  }
});

test('HTTP 团队开关：关掉它会把正在讨论的团队一起暂停（开关的语义是「别再自动说话」）', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    await flush();

    const response = await invoke(handlerOf(hub), { method: 'POST', url: '/sub-agent/api/team/mode', body: { enabled: false } });
    assert.equal(response.status, 200);
    assert.equal(response.body.teamMode, false);
    assert.deepEqual(response.body.paused, [team.id]);
    assert.equal(hub.team.get(team.id).status, 'paused');

    const back = await invoke(handlerOf(hub), { method: 'POST', url: '/sub-agent/api/team/mode', body: { enabled: true } });
    assert.equal(back.body.teamMode, true);
  } finally {
    hub.close();
  }
});

test('HTTP 团队详情、用户插话、暂停/继续/结束', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: '把 0.3.0 发出去', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    const handler = handlerOf(hub);
    await flush();

    const detail = await invoke(handler, { method: 'GET', url: `/sub-agent/api/team/${team.id}?limit=200` });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.team.name, '发布项目组');
    assert.equal(detail.body.messages.length >= 1, true);
    assert.equal(detail.body.players.length, 3, '群主 + 两个成员');
    assert.equal(detail.body.players[0].role, 'owner');
    assert.equal(detail.body.lastSeq, detail.body.messages.at(-1).seq);

    const missing = await invoke(handler, { method: 'GET', url: '/sub-agent/api/team/nope' });
    assert.equal(missing.status, 404);

    // 群主 @用户 之后，用户在面板里插一句话就能解锁讨论。
    hub.runtime.settle(hub.runtime.last().id, { output: '需要你定。\n@用户：A 还是 B' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'awaiting_user');

    const said = await invoke(handler, { method: 'POST', url: `/sub-agent/api/team/${team.id}/say`, body: { text: '选 A' } });
    assert.equal(said.status, 200);
    assert.equal(said.body.message.role, 'user');
    assert.equal(hub.team.get(team.id).status, 'discussing');
    await flush();
    assert.equal(hub.runtime.busy().length, 1, '用户说完话语权回到群主');

    const paused = await invoke(handler, { method: 'POST', url: `/sub-agent/api/team/${team.id}/pause`, body: {} });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.team.team.status, 'paused');

    const started = await invoke(handler, { method: 'POST', url: `/sub-agent/api/team/${team.id}/start`, body: {} });
    assert.equal(started.status, 200);
    assert.equal(started.body.team.team.status, 'discussing');

    const closed = await invoke(handler, { method: 'POST', url: `/sub-agent/api/team/${team.id}/close`, body: {} });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.team.team.status, 'closed');

    const afterClose = await invoke(handler, { method: 'POST', url: `/sub-agent/api/team/${team.id}/start`, body: {} });
    assert.equal(afterClose.status, 409, '收尾之后不能再起（幽灵讨论比报错更糟）');
    assert.match(afterClose.body.error, /已经收尾/);
  } finally {
    hub.close();
  }
});

test('HTTP：团队服务没装配时如实回 503，而不是一个空列表让人以为「一个团队都没有」', async () => {
  const hub = makeTeamHub();
  try {
    const handler = createHandler({
      ctx: {}, store: hub.store, runtime: hub.runtime, tasks: hub.tasks,
      config: hub.config, log, version: '0.3.0', dataDir: 'test', dbPath: 'test/hub.db',
    });
    const state = await invoke(handler, { method: 'GET', url: '/sub-agent/api/state' });
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.team, { teams: [], total: 0, teamMode: false, active: 0 }, '缺服务时给空帧，面板照常渲染');

    for (const url of ['/sub-agent/api/team', '/sub-agent/api/team/mode']) {
      const response = await invoke(handler, { method: url.endsWith('mode') ? 'POST' : 'GET', url, body: url.endsWith('mode') ? { enabled: true } : undefined });
      assert.equal(response.status, 503, url);
      assert.match(response.body.error, /团队服务不可用/);
    }
  } finally {
    hub.close();
  }
});

//#endregion

//#region 模型侧工具：team_open / team_say / team_task / team_status

/** 装一套模型侧工具并返回工具表。 */
function installTools(hub) {
  const { ctx, registered, sections, sent } = makeToolCtx();
  const built = buildTools({ ctx, store: hub.store, runtime: hub.runtime, tasks: hub.tasks, team: hub.team, config: hub.config, log });
  built.install();
  return { tools: registered, sections, warnings: built.warnings, sent };
}

/** 造一个「某个子 agent 正在这次会话里跑」的执行身份（team_say 靠它认人）。 */
function mockRunSession(store, agentName, sessionId) {
  const agent = store.getAgentByName(agentName);
  const record = store.insertRun({
    agentId: agent.id, agentName, parentSessionId: 's1', label: agentName, prompt: 'x', invokedBy: 'team',
  });
  store.updateRun(record.id, { sessionId, status: 'running' });
  return { agent: { session: { id: sessionId } } };
}

test('team_open：把用户那三行原文变成一场真跑的讨论', async () => {
  const hub = makeTeamHub();
  try {
    const { tools } = installTools(hub);
    assert.ok(tools.has('team_open') && tools.has('team_say') && tools.has('team_task')
      && tools.has('team_status') && tools.has('team_report'),
    '五个团队工具都要注册');

    // `wait:false` 只为这一个用例保留「开完就返回」的旧行为（它测的是建群与父会话传递）。
    // 默认行为（挡住主对话直到群主收尾）在下面单独测。
    const opened = await tools.get('team_open').execute({
      declaration: DECLARATION,
      mission: '把 0.3.0 发出去',
      wait: false,
    }, { agent: { name: '主对话', session: { id: 's1' } } });
    assert.equal(opened.error, '');
    assert.equal(opened.owner, '群主甲');
    assert.deepEqual(opened.members, ['成员乙', '成员丙']);
    assert.equal(opened.started, true);
    assert.equal(opened.settled, false, 'wait:false 时必须如实说还没收尾');
    await flush();
    assert.equal(hub.runtime.busy().length, 1, '开完就开聊，不需要主对话再推一把');
    // 父会话与父 agent 必须**真的**传下去：团队讨论靠它们定位父会话，
    // 空串就是真机上那种「找不到会话  对应的活动 agent」的中断。
    assert.equal(hub.store.getTeam(opened.team_id).parentSessionId, 's1', '团队要记住调用者的会话 id');
    assert.equal(hub.runtime.last().parentSessionId, 's1', '第一次发言的运行要挂在调用者的会话上');
    assert.equal(hub.runtime.last().parentAgentName, '主对话', '父 agent 也要给（起运行时要用）');

    const bad = await tools.get('team_open').execute({ declaration: '团队名称：X' }, { agent: { session: { id: 's1' } } });
    assert.match(bad.error, /团队负责人/);
  } finally {
    hub.close();
  }
});

test('team_open 默认**挡在主对话回合里**等群主收尾，并把结论作为返回值交给它', async () => {
  // 这是「主对话不能结束、结论必须带回主对话」的主通道：
  // 工具不返回，主对话就还在自己的回合里；群主的结论随返回值一起到手，不需要任何推送。
  const hub = makeTeamHub();
  try {
    const { tools } = installTools(hub);
    const pending = tools.get('team_open').execute({
      declaration: DECLARATION,
      mission: '把 0.3.0 发出去',
    }, { agent: { name: '主对话', session: { id: 's1' } } });

    // 还没收尾之前，这个 Promise 必须一直挂着（主对话因此留在回合里）。
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await flush();
    assert.equal(resolved, false, '讨论没结束就不许返回——否则主对话就提前收尾了');

    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '开场：先定接口。\n@成员乙 @成员丙' });
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '同意 A 方案。' });
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '我倾向 B，理由是成本。' });
    await flush();
    const finalTurn = hub.runtime.last();
    assert.equal(finalTurn.agentName, '群主甲');
    hub.runtime.settle(finalTurn.id, { output: '结论：采用 A 方案，接口先冻结；乙负责实现，丙负责评审。\n@收尾' });
    await flush();

    const opened = await pending;
    assert.equal(opened.settled, true, '收尾之后要如实标成已收尾');
    assert.equal(opened.status, 'closed');
    assert.match(opened.conclusion, /采用 A 方案/, '群主最后那段发言就是结论');
    assert.equal(opened.conclusion_from, '群主甲');
    assert.equal(opened.messages.length >= 4, true, '最近发言也要带回去，主对话才知道是怎么谈出来的');
    assert.match(opened.note, /讲给用户/, '要明确告诉主对话「结论要讲给用户」，而不是只说一句完成');
  } finally {
    hub.close();
  }
});

test('team_open 等不到收尾时（超时）如实说「还在跑」，并指明接着用 team_status 等', async () => {
  const hub = makeTeamHub();
  try {
    const { tools } = installTools(hub);
    const opened = await tools.get('team_open').execute({
      declaration: DECLARATION,
      mission: 'M',
      timeout_ms: 120,   // 只等 0.12 秒：讨论当然还没结束
    }, { agent: { name: '主对话', session: { id: 's1' } } });
    assert.equal(opened.settled, false);
    assert.equal(opened.conclusion, '', '没结论就老实给空串');
    assert.match(opened.note, /不要结束回合/);
    assert.match(opened.note, /team_status/);
    assert.equal(hub.runtime.busy().length, 1, '讨论还在继续跑');
  } finally {
    hub.close();
  }
});

test('team_status {wait:true} 接着等，能等到结论并把「已转达」标记上', async () => {
  const hub = makeTeamHub();
  try {
    const { tools } = installTools(hub);
    await tools.get('team_open').execute({
      declaration: DECLARATION, mission: 'M', timeout_ms: 100, wait: false,
    }, { agent: { name: '主对话', session: { id: 's1' } } });
    await flush();
    const teamId = hub.store.listTeams({ limit: 1 })[0].id;
    assert.equal(hub.team.pendingLines().join('\n').includes('结论还没带回主对话'), false, '还没收尾时不进「未转达」清单');

    const waiting = tools.get('team_status').execute({ team_id: teamId, wait: true, wait_ms: 2000 });
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '结论：按 A 走。\n@收尾' });
    await flush();
    const view = await waiting;
    assert.equal(view.settled, true);
    assert.match(view.conclusion, /按 A 走/);

    // 取走之后，提示词里不该再反复提醒同一个结论。
    const lines = hub.team.pendingLines().join('\n');
    assert.equal(lines.includes('结论还没带回主对话'), false, '取走过就不再提醒');
  } finally {
    hub.close();
  }
});

test('team_report：群主把结论**直接投回主对话**（投给谁的会话、投了什么都要对）', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 'session-main', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;
    const { tools, sent } = installTools(hub);
    hub.team.say({ teamId: team.id, role: 'owner', speaker: '群主甲', text: '结论：接口先冻结，乙实现、丙评审。' });

    // 群主在自己那一轮里调（exec.agent 就是那个活着的子 agent）。
    const ownerExec = mockRunSession(hub.store, '群主甲', 'child-owner');
    const ok = await tools.get('team_report').execute({ team_id: team.id }, ownerExec);
    assert.equal(ok.ok, true);
    assert.equal(ok.delivered, true);
    assert.equal(sent.length, 1, '必须真的走 subagents.sendMessage');
    assert.equal(sent[0].targetId, 'session-main', '投给团队的父会话');
    assert.equal(sent[0].sender, ownerExec.agent, '发送者必须是那个活着的子 agent（接口要求邻接关系）');
    assert.match(sent[0].content[0].text, /团队结论/);
    assert.match(sent[0].content[0].text, /接口先冻结/);
    assert.equal(typeof sent[0].options.signal?.aborted, 'boolean', '要带 AbortSignal（接口要求）');

    // 只认群主：成员不能替它送。
    const memberExec = mockRunSession(hub.store, '成员乙', 'child-乙');
    const denied = await tools.get('team_report').execute({ team_id: team.id, text: 'x' }, memberExec);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /只有群主/);
    assert.equal(sent.length, 1, '被拒的调用不该投出去');

    // 没有父会话的团队（旧版本留下的）：如实说送不回去，并给出解法。
    hub.store.updateTeam(team.id, { parentSessionId: '' });
    const orphan = await tools.get('team_report').execute({ team_id: team.id, text: 'x' }, ownerExec);
    assert.equal(orphan.ok, false);
    assert.match(orphan.error, /没有父会话/);
    assert.match(orphan.note, /继续/);
  } finally {
    hub.close();
  }
});

test('team_report：投不出去时如实报错，并说明结论没有丢', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 'session-main', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;
    // 造一个「有 subagents 但没有 sendMessage」的部署（也就是 DSH 换实现的样子）。
    const registered = new Map();
    const ctx = {
      get: (name) => {
        if (name === 'tools') return { register: (definition) => { registered.set(definition.name, definition); return () => {}; } };
        if (name === 'systemPrompt') return { section: () => () => {} };
        if (name === 'subagents') return { list: () => ['spawn'] };
        return undefined;
      },
    };
    buildTools({ ctx, store: hub.store, runtime: hub.runtime, tasks: hub.tasks, team: hub.team, config: hub.config, log }).install();

    hub.team.say({ teamId: team.id, role: 'owner', speaker: '群主甲', text: '结论：就这样。' });
    const result = await registered.get('team_report').execute({ team_id: team.id }, mockRunSession(hub.store, '群主甲', 'child-owner-2'));
    assert.equal(result.ok, false);
    assert.match(result.error, /没有 subagents\.sendMessage/);
    assert.match(result.note, /没有丢/);
    // 失败要让**用户**看见：它看的是面板，不是模型的工具返回。
    const last = hub.store.listTeamMessages(team.id).at(-1);
    assert.equal(last.role, 'system');
    assert.match(last.text, /没能直接投进主对话/);
  } finally {
    hub.close();
  }
});

test('team_open 在拿不到父会话/父 agent 时如实说明，而不是起一场注定中断的讨论', async () => {
  const hub = makeTeamHub();
  try {
    const { tools } = installTools(hub);
    // 没有 exec（例如被别的地方用错误签名调用）：父会话与父 agent 都拿不到。
    const opened = await tools.get('team_open').execute({ declaration: DECLARATION, mission: 'M' });
    assert.match(opened.error, /没有父会话|父 agent/);
    assert.equal(opened.started, false);
    await flush();
    assert.equal(hub.runtime.busy().length, 0, '起了就一定会断：宁可不启动');
    assert.equal(hub.team.get(opened.team_id).status, 'idle');
  } finally {
    hub.close();
  }
});

test('救回一个卡在「找不到父会话」的团队：面板点「继续」会把当前会话补上', async () => {
  // 这是真机上发生过的那一条：老版本的工具没把父会话传下去，
  // 库里留下一个 parent_session_id 为空串、status=error 的团队。
  // 光修工具只能让**新**团队正常，已经卡住的那个必须还能救——
  // 否则用户看到的是一张死卡片，而他没有任何操作能让它复活。
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION,
      mission: 'M',
      // 故意制造「空父会话 + error」：这就是真机库里的样子。
      parentSessionId: '',
      autoStart: false,
    }).team;
    hub.store.updateTeam(team.id, { status: 'error', lastError: '找不到团队的父会话：找不到会话  对应的活动 agent' });

    // 1) 不带会话继续 → 仍然定位不到父 agent，如实再次中断（不许假装成功）。
    hub.team.start(team.id, { invokedBy: 'panel' });
    await flush();
    assert.equal(hub.runtime.busy().length, 0);
    assert.equal(hub.team.get(team.id).status, 'error');

    // 2) 带上会话继续 → 父会话被补记，群主真的开口了。
    hub.team.start(team.id, { invokedBy: 'panel', parentSessionId: 's-live' });
    await flush();
    assert.equal(hub.store.getTeam(team.id).parentSessionId, 's-live', '父会话要落库（重启后还在）');
    assert.equal(hub.store.getTeam(team.id).status, 'discussing');
    assert.equal(hub.runtime.busy().length, 1, '讨论真的跑起来了');
    assert.equal(hub.runtime.last().agentName, '群主甲');
    assert.equal(hub.runtime.last().parentSessionId, 's-live');
  } finally {
    hub.close();
  }
});

test('HTTP /team/<id>/start 把 body 里的 parentSessionId 转给团队（面板的「继续」就靠它）', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: '', autoStart: false,
    }).team;
    hub.store.updateTeam(team.id, { status: 'paused' });

    const response = await invoke(handlerOf(hub), {
      method: 'POST',
      url: `/sub-agent/api/team/${team.id}/start`,
      body: { parentSessionId: 's-from-panel' },
    });
    assert.equal(response.status, 200);
    assert.equal(hub.store.getTeam(team.id).parentSessionId, 's-from-panel');
    await flush();
    assert.equal(hub.runtime.busy().length, 1, '补上父会话之后讨论必须真的开跑');
  } finally {
    hub.close();
  }
});

test('team_open 在团队模式关着时明确拒绝，并让用户去把下拉打开（不自己编一个团队）', async () => {
  const previous = base.teamMode;
  base.teamMode = false;
  const hub = makeTeamHub();
  base.teamMode = previous;
  try {
    const { tools } = installTools(hub);
    const result = await tools.get('team_open').execute({ declaration: DECLARATION, mission: 'M' }, { agent: { session: { id: 's1' } } });
    assert.match(result.error, /团队模式没打开/);
    assert.match(result.error, /下拉|输入栏/);
  } finally {
    hub.close();
  }
});

test('team_say：靠子会话反查说话人（不让模型自报家门），成员开口就把群主叫醒', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    const { tools } = installTools(hub);
    const exec = mockRunSession(hub.store, '成员乙', 'child-乙');

    // 先让讨论停在「等用户」，这样成员发言是否叫醒群主才看得出来。
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '等任务。\n@等待' });
    await flush();
    hub.team.pause(team.id, '测试');

    const said = await tools.get('team_say').execute({ team_id: team.id, text: '改并发闸时会碰到限流，需要群主定方案。' }, exec);
    assert.equal(said.ok, true);
    assert.equal(said.speaker, '成员乙');
    assert.equal(said.role, 'member');
    const last = hub.store.listTeamMessages(team.id).at(-1);
    assert.equal(last.speaker, '成员乙');

    const stranger = await tools.get('team_say').execute({ team_id: team.id, text: '我是谁？' }, { agent: { session: { id: 'unknown' } } });
    assert.equal(stranger.ok, false);
    assert.match(stranger.error, /认不出你是谁/);
    assert.match(stranger.error, /@群主甲/, '拒绝时把成员列出来，方便模型判断自己是不是走错了');
  } finally {
    hub.close();
  }
});

test('team_say 的 role:"user" 是显式代用户带话（不把模型的话算到用户头上）', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    }).team;
    const { tools } = installTools(hub);
    await flush();
    hub.runtime.settle(hub.runtime.last().id, { output: '要你定。\n@用户：A 还是 B' });
    await flush();
    assert.equal(hub.team.get(team.id).status, 'awaiting_user');

    const relayed = await tools.get('team_say').execute(
      { team_id: team.id, text: '用户说：选 A', role: 'user' },
      { agent: { session: { id: 's1' } } },
    );
    assert.equal(relayed.ok, true);
    assert.equal(relayed.role, 'user');
    assert.equal(hub.store.listTeamMessages(team.id).at(-1).role, 'user');
    assert.equal(hub.team.get(team.id).status, 'discussing', '带话之后讨论继续');
  } finally {
    hub.close();
  }
});

test('team_task：只有群主能派活；派完立刻开跑，任务说明带着群协议', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;
    const { tools } = installTools(hub);

    const member = await tools.get('team_task').execute({
      team_id: team.id,
      tasks: [{ title: '改接口', agent: '成员乙' }],
    }, mockRunSession(hub.store, '成员乙', 'child-乙'));
    assert.equal(member.ok, false);
    assert.match(member.error, /只有群主/);

    const owner = await tools.get('team_task').execute({
      team_id: team.id,
      title: '发布 0.3.0',
      tasks: [{ title: '改接口', agent: '成员乙', brief: '冻结接口' }],
    }, mockRunSession(hub.store, '群主甲', 'child-甲'));
    assert.equal(owner.ok, true);
    assert.equal(owner.plan_id.startsWith('pl_'), true);
    assert.equal(owner.tasks.length, 1);
    assert.equal(owner.tasks[0].agent, '成员乙');

    await flush();
    const taskRun = hub.runtime.busy().find((run) => run.agentName === '成员乙');
    assert.ok(taskRun !== undefined, '派完立刻开跑');
    assert.match(taskRun.prompt, /团队群协议/);
    assert.match(taskRun.prompt, /冻结接口/);
  } finally {
    hub.close();
  }
});

test('team_status：不给 id 列团队，给了 id 给群聊记录；只读，不推着讨论走', async () => {
  const hub = makeTeamHub();
  try {
    const team = hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' }, autoStart: false,
    }).team;
    const { tools } = installTools(hub);

    const list = await tools.get('team_status').execute({});
    assert.equal(list.teams.length, 1);
    assert.equal(list.teams[0].name, '发布项目组');
    assert.equal(list.teams[0].status, 'idle');

    hub.team.say({ teamId: team.id, role: 'owner', speaker: '群主甲', text: '先定接口。' });
    const detail = await tools.get('team_status').execute({ team_id: team.id, limit: 10 });
    assert.equal(detail.name, '发布项目组');
    assert.deepEqual(detail.members, ['群主甲', '成员乙', '成员丙']);
    assert.equal(detail.messages.at(-1).text, '先定接口。');
    assert.equal(hub.team.get(team.id).status, 'idle', '读一次不该把讨论推起来');

    const missing = await tools.get('team_status').execute({ team_id: 'nope' });
    assert.match(missing.error, /没有这个团队/);
  } finally {
    hub.close();
  }
});

test('主对话的提示词里带着团队声明协议，且开关状态说得清楚', () => {
  const hub = makeTeamHub();
  try {
    const { sections } = installTools(hub);
    const text = sections[0].text();
    assert.match(text, /团队模式/);
    assert.match(text, /team_open/);
    assert.match(text, /团队名称：/);
    assert.match(text, /团队负责人：/);
    assert.match(text, /团队成员：/);
    assert.match(text, /固定自动激活/);
    assert.match(text, /现在是\*\*开着\*\*的/);
    // 「主对话不能提前结束、结论要讲给用户」必须写在协议里——
    // 这条不写清，模型就会在 team_open 一返回时说一句「群聊已开始」然后收尾。
    assert.match(text, /不要结束回合/);
    assert.match(text, /讲给用户/);
    assert.match(text, /team_report/);
  } finally {
    hub.close();
  }
});

test('收尾轮要求群主把结论写成人能独立看懂的一段，并投回主对话', async () => {
  const hub = makeTeamHub({ teamMaxRounds: 1 });
  try {
    hub.team.open({
      declaration: DECLARATION, mission: 'M', parentSessionId: 's1', parentAgent: { name: 'parent' },
    });
    await flush();
    // maxRounds=1：群主开场之后，下一轮群主发言就是收尾轮。
    hub.runtime.settle(hub.runtime.last().id, { output: '开场：先定接口。\n@成员乙' });
    await flush();
    assert.equal(hub.runtime.last().agentName, '成员乙');
    hub.runtime.settle(hub.runtime.last().id, { output: '同意，接口我明天冻结。' });
    await flush();

    const finalRun = hub.runtime.last();
    assert.equal(finalRun.agentName, '群主甲');
    assert.match(finalRun.prompt, /收尾（轮次已到上限/);
    assert.match(finalRun.prompt, /team_report/, '收尾轮必须要求它把结论投回主对话');
    assert.match(finalRun.prompt, /能独立看懂/, '结论要能脱离上下文读懂——它是要被带走的');
  } finally {
    hub.close();
  }
});

//#endregion
