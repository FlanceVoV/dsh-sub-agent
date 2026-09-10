/**
 * 集成测试：用**假的 DSH 上下文**把整条链路跑通。
 *
 * 为什么值得写：宿主侧所有真实风险都在「缝」上——事件订阅带不带 `global:true`、
 * `start()` 在发布时才 resolve 导致的时序、dispose 有没有调、忙/未启用的拒绝是否真的生效。
 * 这些都不是单元测试能发现的，所以这里用一个最小的假 ctx + 假 subagents 服务，
 * 让 runtime / tools / http 三层在接近真实的时序下跑一遍。
 *
 * 假件只模拟**契约**（接口形状与事件时序），不模拟 DSH 的实现细节——
 * 这样测试锁住的是我依赖的那部分契约，而不是我对 DSH 内部的猜测。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { normalizeConfig } from '../lib/src/config.js';
import { buildTools } from '../lib/src/tools.js';
import { createHandler, ROUTE_PREFIX } from '../lib/src/http.js';
import { HubRuntime } from '../lib/src/runtime.js';
import { HubStore } from '../lib/src/store.js';

const dirs = [];
function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'sbh-int-'));
  dirs.push(dir);
  return join(dir, 'hub.db');
}
/**
 * 造一个临时数据目录。
 *
 * 必须是真的临时目录而不是占位字符串：配置改动会**写文件**，
 * 用占位路径会让测试往进程 cwd 里丢垃圾，或者直接失败。
 */
function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sbh-data-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL 偶尔还占着 */ }
  }
});

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 造一个假的 DSH 上下文。
 *
 * `spawned` 记录每次 spawn 的请求（用于断言 agentOptions 真的带上了模型），
 * `emit` 把会话事件喂给注册过的监听者（用于验证 `{global:true}` 订阅链路）。
 */
function makeFakeDsh({ chunkDelayMs = 50, stopReason = 'completed', output = '子 agent 的产出' } = {}) {
  /** @type {Map<string,Function[]>} */
  const listeners = new Map();
  const spawned = [];
  const disposed = [];
  let childSeq = 0;

  const ctx = {
    get(name) {
      if (name === 'subagents') return subagents;
      if (name === 'agents') return { get: (id) => ({ session: { id } }) };
      if (name === 'tools') return toolsService;
      if (name === 'systemPrompt') return promptService;
      if (name === 'llm') return { listProviders: () => [], listConfigurableProviders: () => [] };
      if (name === 'settings') return { describe: () => [] };
      return undefined;
    },
    on(event, handler, options) {
      if (options?.global !== true) {
        // 这条断言本身就是回归保护：不带 global 就收不到子会话事件，
        // 是本插件最容易踩且最难察觉的坑。
        throw new Error('测试失败：session/event 订阅必须带 {global:true}');
      }
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const list = listeners.get(event) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn) { return fn(); },
    webServer: { register() { return () => {}; }, host: '127.0.0.1' },
  };

  const emit = (sessionId, type, data) => {
    const event = { type, seq: 1, time: Date.now(), data };
    for (const handler of listeners.get('session/event') ?? []) {
      handler({ id: sessionId }, event);
    }
  };

  const subagents = {
    list: () => ['spawn', 'fork'],
    getProvider: (name) => ({
      name,
      inheritsParentContext: false,
      capabilities: { agentOptions: name === 'spawn', outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    }),
    async start(name, request) {
      const sessionId = `child-${++childSeq}`;
      spawned.push({ name, sessionId, request });
      const run = {
        id: sessionId,
        localAgent: undefined,
        dispose: async () => { disposed.push(sessionId); },
        result: undefined,
      };
      run.result = (async () => {
        // 关键时序：先让 start() 的调用方完成「发布后设置 sessionId」这一步，
        // 再开始吐事件。否则事件会被 sessionId 尚未写上的过滤器丢掉——
        // 这正是真实世界里 start() 在发布时 resolve 所造成的时序。
        await new Promise((resolve) => setTimeout(resolve, 0));
        emit(sessionId, 'user/message', { content: request.prompt });
        emit(sessionId, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'x'.repeat(40) } });
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        emit(sessionId, 'assistant/message', {
          message: { content: [{ type: 'text', text: output }] },
          usage: { outputTokens: 10, inputTokens: 5 },
        });
        return { stopReason, output };
      })();
      return run;
    },
  };

  /** 捕获注册的工具定义。 */
  const registered = new Map();
  const toolsService = {
    register(definition) {
      registered.set(definition.name, definition);
      return () => { registered.delete(definition.name); };
    },
  };

  /** 捕获提示词段。 */
  const sections = [];
  const promptService = {
    section(section) {
      sections.push(section);
      return () => {
        const index = sections.indexOf(section);
        if (index >= 0) sections.splice(index, 1);
      };
    },
  };

  return { ctx, subagents, spawned, disposed, registered, sections, emit };
}

/** 组装一套插件运行态。 */
function makeHub(overrides = {}) {
  const fake = makeFakeDsh(overrides.fake);
  const store = new HubStore({ dbPath: tempDbPath(), log: silentLog }).open();
  const { config } = normalizeConfig({
    maxConcurrentRuns: 2,
    runTimeoutMs: 5000,
    outputTailChars: 1000,
    maxParallelPerSession: 2,
    ...overrides.config,
  });
  const runtime = new HubRuntime({ ctx: fake.ctx, store, config, log: silentLog });
  assert.equal(runtime.attach(), true, '事件订阅应当成功挂上');
  const context = { ctx: fake.ctx, store, runtime, config, log: silentLog, dataDir: tempDataDir(), dbPath: 'y', version: '0.1.0' };
  return { ...fake, store, runtime, config, context, built: buildTools(context) };
}

/** 造一个 agent 并返回。 */
function seedAgent(store, overrides = {}) {
  return store.insertAgent({
    name: '研究员',
    transport: 'spawn',
    modelProvider: 'deepseek-official',
    modelId: 'deepseek-v4.1-flash',
    toolPolicy: 'inherit',
    maxTokens: 4096,
    ...overrides,
  });
}

test('端到端：起一次运行，事件被折成遥测，终态落库且已 dispose', async () => {
  const hub = makeHub();
  const agent = seedAgent(hub.store);

  const started = hub.runtime.start({
    agent,
    prompt: '查一下 X',
    parentAgent: { session: { id: 'parent-1' } },
    parentSessionId: 'parent-1',
    taskKey: 'task-X',
  });
  assert.equal(started.ok, true);

  const settled = await hub.runtime.waitFor(started.run.id);
  assert.ok(settled !== undefined, '必须能在终态拿到等待结果');

  // 需求 3：配置里的模型真的进了 AgentOptions。
  assert.equal(hub.spawned.length, 1);
  assert.equal(hub.spawned[0].name, 'spawn');
  assert.deepEqual(hub.spawned[0].request.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash',
    maxTokens: 4096,
  });

  // 需求 2：子会话 id 被记录下来（这就是「调用的会话是哪个」）。
  assert.equal(settled.sessionId, 'child-1');
  assert.equal(settled.status, 'completed');

  // 遥测：token 来自权威 usage，速率由「字符→token」校准 + 解码时长算出。
  assert.equal(settled.tokensOut, 10);
  assert.equal(settled.tokensIn, 5);
  assert.ok(settled.tokPerS > 0, `速率应当大于 0，实际 ${settled.tokPerS}`);
  assert.equal(settled.output, '子 agent 的产出');

  // 关键不变量：run 是一次性前台委派，必须 dispose。
  assert.deepEqual(hub.disposed, ['child-1']);

  // 落库内容与内存终态一致。
  const persisted = hub.store.getRun(started.run.id);
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.sessionId, 'child-1');
  assert.equal(persisted.tokensOut, 10);
  assert.equal(persisted.taskKey, 'task-X');
  assert.equal(persisted.parentSessionId, 'parent-1');
  assert.equal(persisted.outputTail, '子 agent 的产出');

  hub.runtime.detach();
  hub.store.close();
});

test('忙的子 agent 会被拒绝，而不是排队或静默并行', async () => {
  const hub = makeHub({ fake: { chunkDelayMs: 200 } });
  const agent = seedAgent(hub.store);

  const first = hub.runtime.start({ agent, prompt: '第一个', parentAgent: {}, parentSessionId: 'parent-1' });
  assert.equal(first.ok, true);
  // 等它真的进入 running（start() 是异步的，发布前 status 还是 queued）。
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 走 http 的 startRun 路径（面板与工具共用这条规则）。
  const handler = createHandler(hub.context);
  const response = await invoke(handler, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    body: { agent: '研究员', prompt: '第二个', parentSessionId: 'parent-1' },
  });

  assert.equal(response.status, 409, '忙的时候必须拒绝');
  assert.match(response.body.error, /正在忙/);
  assert.match(response.body.error, /不要重试|等它跑完/, '提示里要给出可执行的下一步');

  await hub.runtime.waitFor(first.run.id);
  hub.runtime.detach();
  hub.store.close();
});

test('未启用的会话：工具明确拒绝，并告诉模型不要重试', async () => {
  const hub = makeHub();
  seedAgent(hub.store);
  hub.built.install();

  const runTool = hub.registered.get('subagent_run');
  assert.ok(runTool !== undefined, 'subagent_run 必须被注册');

  const exec = { agent: { session: { id: 'parent-1' } }, signal: new AbortController().signal };

  // 未启用。
  const refused = await runTool.execute({ agent: '研究员', prompt: '干活' }, exec);
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, /尚未启用/);
  assert.match(refused.error, /全局/, '拒绝理由要说明这是全局开关，否则用户会去翻会话设置');
  assert.match(refused.note, /重试/, '必须明确告知这是策略拒绝、重试无用');

  // 启用后同一次调用应当成功。注意开关是**全局**的，不带会话。
  hub.store.setEnabled(true);
  const ok = await runTool.execute({ agent: '研究员', prompt: '干活' }, exec);
  assert.equal(ok.status, 'completed');
  assert.equal(ok.output, '子 agent 的产出');
  assert.equal(hub.spawned.length, 1);

  hub.runtime.detach();
  hub.store.close();
});

test('提示词段注入花名册与 @ 约定；花名册为空时不注入', () => {
  const hub = makeHub();
  hub.built.install();

  const section = hub.sections.find((item) => item.name === 'subagent-hub:protocol');
  assert.ok(section !== undefined, '必须注册协议提示词段');
  assert.equal(typeof section.text, 'function', '花名册会变，所以必须是函数形式');

  assert.equal(section.text(), '', '没有任何子 agent 时不应注入（避免提示词里出现空花名册）');

  seedAgent(hub.store, { name: '研究员' });
  seedAgent(hub.store, { name: '审核员', modelId: 'deepseek-v4.1' });
  const text = section.text();
  assert.match(text, /@名字/);
  assert.match(text, /研究员/);
  assert.match(text, /审核员/);
  assert.match(text, /subagent_run/);
  assert.match(text, /subagent_evaluate/);
  assert.match(text, /忙/, '必须写明「忙的不能被 @」这条硬规则');

  hub.runtime.detach();
  hub.store.close();
});

test('工具：evaluate 能算出总分并落库，roster 反映忙闲', async () => {
  const hub = makeHub();
  const agent = seedAgent(hub.store);
  hub.built.install();

  const started = hub.runtime.start({ agent, prompt: '任务', parentAgent: {}, parentSessionId: 'parent-1' });
  await hub.runtime.waitFor(started.run.id);

  const evaluate = hub.registered.get('subagent_evaluate');
  const evaluated = await evaluate.execute({
    run_id: started.run.id,
    correctness: 90, completeness: 80, efficiency: 70, cost: 60,
    verdict: '可用',
  }, {});

  assert.equal(evaluated.recorded, true);
  assert.equal(evaluated.score, 75, '总分应为四个维度的均值');
  assert.equal(evaluated.verdict, '可用');

  const stored = hub.store.listEvaluations(started.run.id);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].dimensions, { correctness: 90, completeness: 80, efficiency: 70, cost: 60 });

  const roster = await hub.registered.get('subagent_roster').execute({}, {});
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].name, '研究员');
  assert.equal(roster.agents[0].busy, false);
  assert.equal(roster.agents[0].runs, 1);
  assert.equal(roster.agents[0].avg_score, 75);

  // 拒绝：既没给维度也没给总分。
  const empty = await evaluate.execute({ run_id: started.run.id }, {});
  assert.equal(empty.recorded, false);
  assert.match(empty.error, /维度|score/);

  hub.runtime.detach();
  hub.store.close();
});

test('输入预算闸：超过 maxContext 的任务被拒绝，并说明 maxContext 不是模型真窗口', async () => {
  const hub = makeHub();
  const agent = seedAgent(hub.store, { maxContext: 1000 });

  const started = hub.runtime.start({
    agent,
    prompt: 'x'.repeat(4000), // ≈1333 token > 1000/2
    parentAgent: {},
    parentSessionId: 'parent-1',
  });

  assert.equal(started.ok, false);
  assert.match(started.error, /输入预算/);
  assert.match(started.error, /无法按子 agent 单独调小/, '必须把「这是插件护栏、不是模型窗口」说清楚');
  assert.equal(hub.spawned.length, 0, '超预算的任务不该被发出去');

  hub.runtime.detach();
  hub.store.close();
});

test('HTTP：配置增删改、开关、状态与排名端到端', async () => {
  const hub = makeHub();
  const handler = createHandler(hub.context);

  // 健康检查。
  const health = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/health` });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.capabilities.subagents, true);
  assert.equal(health.body.capabilities.agents, true);

  // 版本兼容性必须能从 /health 看到（装完第一件事就是看这个端点）。
  // 假 ctx 里没有 dshVersion 服务，测试进程的 argv[1] 也不是 dsh 入口，
  // 所以这里**合理地**判不出来 —— 关键是它要如实说「判不出来」，而不是谎报兼容。
  assert.ok(health.body.harness !== undefined, '/health 必须带 harness 字段');
  assert.equal(health.body.harness.tested, '0.1.2-rc.1');
  assert.equal(health.body.harness.supported, '>=0.1.2-rc.1 <0.2.0');
  assert.equal(health.body.harness.compatible, null, '判不出来时必须是 null，不能假称 true');
  assert.equal(typeof health.body.harness.reason, 'string', '判不出来要给出原因');

  // 非法配置：transport 不支持 agentOptions（fork 在本假的实现里不支持）。
  const badTransport = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/agents`,
    body: { name: '甲', transport: 'fork', modelProvider: 'deepseek-official', modelId: 'm' },
  });
  assert.equal(badTransport.status, 400);
  assert.match(badTransport.body.errors.join(' '), /agentOptions/);

  // 非法配置：名字带空格（@ 句柄按空格切分）。
  const badName = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/agents`,
    body: { name: '研 究 员', transport: 'spawn', modelProvider: 'deepseek-official', modelId: 'm' },
  });
  assert.equal(badName.status, 400);
  assert.match(badName.body.errors.join(' '), /空白/);

  // 合法创建。
  const created = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/agents`,
    body: { name: '研究员', transport: 'spawn', modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1-flash' },
  });
  assert.equal(created.status, 201);
  const agentId = created.body.agent.id;
  assert.equal(created.body.agent.toolPolicyDetail.policy, 'inherit');
  assert.equal(created.body.agent.toolPolicyDetail.enforced, false, 'inherit 不该声称强制了什么');

  // 重名冲突。
  const conflict = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/agents`,
    body: { name: '研究员', transport: 'spawn', modelProvider: 'deepseek-official', modelId: 'm' },
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.errors.join(' '), /唯一/);

  // 改名成非法值应被拒。
  const badPatch = await invoke(handler, {
    method: 'PATCH', url: `${ROUTE_PREFIX}/agents/${agentId}`, body: { name: '带 空格' },
  });
  assert.equal(badPatch.status, 400);

  // 只读策略要如实声称强制。
  const patched = await invoke(handler, {
    method: 'PATCH', url: `${ROUTE_PREFIX}/agents/${agentId}`, body: { toolPolicy: 'readonly' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.agent.toolPolicyDetail.enforced, true);
  assert.match(patched.body.agent.toolPolicyDetail.summary, /fail-closed/);

  // 开关（按会话）。
  const enabled = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/enable`, body: { sessionId: 's-1', enabled: true },
  });
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.scope, 'global', '开关的作用域必须自报为全局');

  const state = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state?sessionId=s-1` });
  assert.equal(state.body.enabled, true);
  assert.equal(state.body.enabledScope, 'global');
  assert.equal(state.body.agents.length, 1);
  assert.equal(state.body.catalog.transports.length, 2);

  // **这是本次改动的核心**：在 s-1 里启用之后，另一个对话也必须看到「已启用」。
  // 之前按会话记，别的对话拿到的是 false —— 于是配置都在、界面上却什么都没有。
  const otherState = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state?sessionId=s-2` });
  assert.equal(otherState.body.enabled, true, '开关是全局的：别的对话也必须生效');
  assert.equal(otherState.body.agents.length, 1, 'agent 配置本来就是全局的，任何对话都该看得见');

  // 不带会话 id 也必须拿得到（说明它根本不依赖会话）。
  const noSession = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state` });
  assert.equal(noSession.body.enabled, true);

  // 关掉也是全局的。
  await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/enable`, body: { enabled: false } });
  const afterOff = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state?sessionId=s-1` });
  assert.equal(afterOff.body.enabled, false);
  await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/enable`, body: { enabled: true } });

  // 未知端点。
  const missing = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/nope` });
  assert.equal(missing.status, 404);

  // 排名。
  const board = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/leaderboard` });
  assert.equal(board.status, 200);
  assert.equal(board.body.leaderboard.length, 1);
  assert.equal(board.body.leaderboard[0].agentName, '研究员');

  hub.runtime.detach();
  hub.store.close();
});

test('详情端点：支持增量拉取（outputSince），并如实标记需要重置', async () => {
  const hub = makeHub();
  const agent = seedAgent(hub.store);
  const handler = createHandler(hub.context);

  const started = hub.runtime.start({ agent, prompt: '任务', parentAgent: {}, parentSessionId: 'parent-1' });
  await hub.runtime.waitFor(started.run.id);

  // 全量：不传 outputSince 时给完整内容（首次打开详情页用）。
  const full = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/runs/${started.run.id}/detail` });
  assert.equal(full.status, 200);
  assert.equal(full.body.live.output, '子 agent 的产出');
  assert.equal(full.body.source, 'live');

  // since=0：等价于全量，但走增量通道。
  const fromZero = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/runs/${started.run.id}/detail?outputSince=0` });
  assert.equal(fromZero.body.outputDelta, '子 agent 的产出');
  assert.equal(fromZero.body.outputLength, '子 agent 的产出'.length);
  assert.equal(fromZero.body.reset, false);
  // 增量通道不该再把整篇正文塞在 live 里（那正是要避免的重复传输）。
  assert.equal(fromZero.body.live.output, undefined);

  // since=中间：只回新增的那一段。
  const tail = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/runs/${started.run.id}/detail?outputSince=4` });
  assert.equal(tail.body.outputDelta, '子 agent 的产出'.slice(4));
  assert.equal(tail.body.reset, false);

  // since 超过长度：说明客户端比服务端知道得多，必须让它重置而不是继续拼。
  const beyond = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/runs/${started.run.id}/detail?outputSince=99999` });
  assert.equal(beyond.body.reset, true);
  assert.equal(beyond.body.outputDelta, '');

  // 未知 run。
  const missing = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/runs/不存在/detail` });
  assert.equal(missing.status, 404);

  hub.runtime.detach();
  hub.store.close();
});

test('工具渲染：render 的签名必须是 (args, value)——参数在前、值在后', async () => {
  // 这条测试来自真机上的一次实际故障：三个工具的 render 都写成了 `render(value)`，
  // 于是框架按 `render(args, value)` 调用时，读到的「值」其实是参数对象——
  // subagent_roster 直接 `undefined.length` 抛错，另外两个则静默渲染出 undefined 文案。
  //
  // 之所以原来的测试没抓到：它们只断言 `execute()` 的返回值，从来没跑过 `render()`。
  // 所以这里既做结构性检查（声明了两个形参），也做行为检查（按框架的方式调用）。
  const hub = makeHub();
  const agent = seedAgent(hub.store);
  hub.built.install();

  const started = hub.runtime.start({ agent, prompt: '任务', parentAgent: {}, parentSessionId: 'parent-1' });
  await hub.runtime.waitFor(started.run.id);

  const roster = hub.registered.get('subagent_roster');
  const evaluate = hub.registered.get('subagent_evaluate');
  const run = hub.registered.get('subagent_run');

  for (const tool of [run, evaluate, roster]) {
    assert.ok(
      typeof tool.output.render === 'function' && tool.output.render.length >= 2,
      `${tool.name}.output.render 必须声明 (args, value) 两个形参`,
    );
  }

  // 行为检查：按框架的方式调用，参数在前。
  const rosterBlocks = roster.output.render({}, await roster.execute({}, {}));
  assert.ok(Array.isArray(rosterBlocks) && rosterBlocks.length === 1, 'roster 应当渲染出一个文本块');
  assert.match(rosterBlocks[0].text, /研究员/, '渲染文本里应当出现 agent 名字');
  assert.doesNotMatch(rosterBlocks[0].text, /undefined/, '渲染文本里不该出现 undefined');

  const runBlocks = run.output.render({ agent: '研究员', prompt: '任务' }, {
    run_id: 'r1', agent: '研究员', model: 'deepseek-official/m', status: 'completed', session_id: 'child-1',
    output: '子 agent 的正文', tokens_out: 10, tok_per_s: 5.5, elapsed_ms: 1000, stop_reason: 'completed', error: '', note: '',
  });
  assert.match(runBlocks[0].text, /子 agent 的正文/);
  assert.match(runBlocks[0].text, /5\.5 tok\/s/);
  assert.doesNotMatch(runBlocks[0].text, /undefined/);

  // 失败态也要渲染成「未能完成 + 原因」，而不是被当成成功。
  const failedBlocks = run.output.render({ agent: '研究员', prompt: '任务' }, {
    run_id: 'r2', agent: '研究员', model: 'm', status: 'error', session_id: '', output: '',
    tokens_out: 0, tok_per_s: 0, elapsed_ms: 0, stop_reason: 'error', error: '模型炸了', note: '重试无用',
  });
  assert.match(failedBlocks[0].text, /未能完成/);
  assert.match(failedBlocks[0].text, /模型炸了/);

  const evalBlocks = evaluate.output.render({ run_id: 'r1' }, {
    evaluation_id: 'e1', run_id: 'r1', score: 75, verdict: '可用', recorded: true, error: '',
  });
  assert.match(evalBlocks[0].text, /75/);
  assert.match(evalBlocks[0].text, /可用/);

  const evalFailed = evaluate.output.render({ run_id: 'r1' }, {
    evaluation_id: '', run_id: 'r1', score: 0, verdict: '', recorded: false, error: '至少要给一个维度分',
  });
  assert.match(evalFailed[0].text, /未记录/);
  assert.match(evalFailed[0].text, /至少要给一个维度分/);

  hub.runtime.detach();
  hub.store.close();
});

test('归档：成功、重复点给出解释清楚的错误、名字被释放、列表随之更新', async () => {
  // 这条来自真机：用户点了归档「没反应」，于是把每个都点了一遍。
  // 后端其实全部成功了——所以这里既锁住「成功路径」，也锁住「重复点击时的措辞」：
  // 后者是一个含糊的 404 会让人以为插件坏了，而它其实是「界面旧了，数据是对的」。
  const hub = makeHub();
  const agent = seedAgent(hub.store, { name: '待归档' });
  const handler = createHandler(hub.context);

  const first = await invoke(handler, { method: 'DELETE', url: `${ROUTE_PREFIX}/agents/${agent.id}` });
  assert.equal(first.status, 200);
  assert.equal(first.body.archived, agent.id);
  assert.equal(first.body.name, '待归档', '回包里带上名字，界面才能给出人话反馈');
  assert.notEqual(hub.store.getAgent(agent.id).archivedAt, null, '库里必须真的被标记为归档');

  // 列表随之更新（客户端刷新靠的就是它）。
  const state = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state` });
  assert.equal(state.body.agents.length, 0, '归档后不该再出现在列表里');

  // 重复点：409 且解释清楚，而不是 404。
  const again = await invoke(handler, { method: 'DELETE', url: `${ROUTE_PREFIX}/agents/${agent.id}` });
  assert.equal(again.status, 409, 'agent 是存在的，只是已经归档了，所以不是 404');
  assert.equal(again.body.alreadyArchived, true);
  assert.match(again.body.error, /已经是归档状态/);
  assert.match(again.body.error, /刷新/, '要告诉用户界面可能是旧的、数据是对的');

  // 真的不存在才是 404。
  const missing = await invoke(handler, { method: 'DELETE', url: `${ROUTE_PREFIX}/agents/根本没有这个id` });
  assert.equal(missing.status, 404);

  // 归档释放了 @ 句柄：同名可以重新添加（「一个 agent 可以被添加多次」的前提）。
  const readd = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/agents`,
    body: { name: '待归档', transport: 'spawn', modelProvider: 'deepseek-official', modelId: 'm' },
  });
  assert.equal(readd.status, 201, JSON.stringify(readd.body));

  // 历史保留：归档不删数据，只把它移出活跃集合。
  const all = hub.store.listAgents({ includeArchived: true });
  assert.equal(all.length, 2, '被归档的那条仍在库里（运行历史要保留可读的名字）');
  assert.equal(all.filter((item) => item.archivedAt !== null).length, 1);

  hub.runtime.detach();
  hub.store.close();
});

test('恢复归档：能恢复、撞名时如实拒绝、本来没归档也如实拒绝', async () => {
  const hub = makeHub();
  const handler = createHandler(hub.context);
  const agent = seedAgent(hub.store, { name: '可恢复' });

  // 归档 → /state 里应出现在 archivedAgents（界面靠它给出回头路）。
  await invoke(handler, { method: 'DELETE', url: `${ROUTE_PREFIX}/agents/${agent.id}` });
  const state = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state` });
  assert.equal(state.body.agents.length, 0);
  assert.equal(state.body.archivedAgents.length, 1, '已归档的要给界面，否则归档看起来像删除');
  assert.equal(state.body.archivedAgents[0].name, '可恢复');

  // 恢复。
  const restored = await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/agents/${agent.id}/restore` });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(hub.store.getAgent(agent.id).archivedAt, null, '恢复后必须真的回到活跃状态');

  // 重复恢复：如实说「本来就没归档」，而不是含糊地报错。
  const again = await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/agents/${agent.id}/restore` });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /本来就没被归档/);

  // 不存在的 id。
  const missing = await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/agents/不存在/restore` });
  assert.equal(missing.status, 404);

  // 撞名：归档 A → 用同一个名字建 B（允许，因为 A 已归档）→ 恢复 A 必须被拒。
  // 这是真实会发生的场景：用户归档后又用同名建了一个新的。
  const first = seedAgent(hub.store, { name: '重名' });
  await invoke(handler, { method: 'DELETE', url: `${ROUTE_PREFIX}/agents/${first.id}` });
  const second = await invoke(handler, {
    method: 'POST', url: `${ROUTE_PREFIX}/agents`,
    body: { name: '重名', transport: 'spawn', modelProvider: 'deepseek-official', modelId: 'm' },
  });
  assert.equal(second.status, 201, '归档后同名可以被重新使用');

  const conflict = await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/agents/${first.id}/restore` });
  assert.equal(conflict.status, 409, '同名冲突必须被挡住，而不是让数据库抛约束错误');
  assert.equal(conflict.body.nameTaken, true);
  assert.match(conflict.body.error, /必须唯一/);
  assert.match(conflict.body.error, /改名或归档/, '要给出可执行的下一步');

  hub.runtime.detach();
  hub.store.close();
});

test('并发上限可以改，而且调大之后排队中的任务立刻被放行', async () => {
  // 这条测试盯的是「改了没用」这种最难被发现的失败：
  // 配置写进去了、接口也回 200，但队列要等下一个任务结束才会重新看一遍上限。
  const hub = makeHub({ config: { maxConcurrentRuns: 1 }, fake: { chunkDelayMs: 300 } });
  const first = seedAgent(hub.store, { name: '甲' });
  const second = seedAgent(hub.store, { name: '乙' });
  const handler = createHandler(hub.context);

  // 两个不同的 agent：避开「同一个 agent 忙则拒绝」那条规则，专门看队列。
  const runA = hub.runtime.start({ agent: first, prompt: '任务一', parentAgent: {}, parentSessionId: 'p' });
  const runB = hub.runtime.start({ agent: second, prompt: '任务二', parentAgent: {}, parentSessionId: 'p' });
  assert.equal(runA.ok, true);
  assert.equal(runB.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 40));

  let snapshot = hub.runtime.snapshot();
  assert.equal(snapshot.activeCount, 1, '上限是 1，只能有一个在跑');
  assert.equal(snapshot.queuedCount, 1, '另一个必须在排队');
  assert.equal(snapshot.maxConcurrentRuns, 1);

  // 读配置：界面拿到的 items 必须带 live 标志与当前值。
  const read = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/config` });
  assert.equal(read.status, 200);
  const concurrency = read.body.items.find((item) => item.key === 'maxConcurrentRuns');
  assert.ok(concurrency !== undefined, '配置里必须有 maxConcurrentRuns');
  assert.equal(concurrency.value, 1);
  assert.equal(concurrency.live, true, '并发上限必须是可热改的');
  assert.ok(typeof read.body.userConfigPath === 'string' && read.body.userConfigPath.includes('config.json'));

  // 改到 2。
  const patched = await invoke(handler, {
    method: 'PATCH', url: `${ROUTE_PREFIX}/config`, body: { maxConcurrentRuns: 2 },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.applied.maxConcurrentRuns, 2);

  await new Promise((resolve) => setTimeout(resolve, 60));
  snapshot = hub.runtime.snapshot();
  assert.equal(snapshot.maxConcurrentRuns, 2, '运行时必须看到新值');
  assert.equal(snapshot.activeCount, 2, '调大上限后排队任务必须**立刻**被放行');
  assert.equal(snapshot.queuedCount, 0);

  // 落盘：重启后仍然生效。
  const written = JSON.parse(readFileSync(join(hub.context.dataDir, 'config.json'), 'utf8'));
  assert.equal(written.maxConcurrentRuns, 2, '改动必须写进用户层配置文件');

  // 非法的改动被拒，且**不改动**任何状态。
  const bad = await invoke(handler, { method: 'PATCH', url: `${ROUTE_PREFIX}/config`, body: { maxConcurrentRuns: -1 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.errors.join(' '), /maxConcurrentRuns/);
  assert.equal(hub.config.maxConcurrentRuns, 2, '被拒的改动不该污染当前配置');

  const unknown = await invoke(handler, { method: 'PATCH', url: `${ROUTE_PREFIX}/config`, body: { 不存在的键: 1 } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.errors.join(' '), /未知配置项/);

  // 运行中不可能生效的项要明确拒绝，并指出该去哪改——而不是假装保存成功。
  const restartOnly = await invoke(handler, { method: 'PATCH', url: `${ROUTE_PREFIX}/config`, body: { dbPath: 'D:/x.db' } });
  assert.equal(restartOnly.status, 400);
  assert.match(restartOnly.body.errors.join(' '), /不能在界面里改/);
  assert.match(restartOnly.body.errors.join(' '), /重启/, '要告诉用户下一步怎么做');

  await hub.runtime.waitFor(runA.run.id);
  await hub.runtime.waitFor(runB.run.id);
  hub.runtime.detach();
  hub.store.close();
});

test('子 agent 的产出必须折成文本：DSH 的 output 是 ContentBlock[] 而不是字符串', async () => {
  // 真机第一次 @ 调用暴露的：运行完全成功（430 tokens、1803ms），
  // 但主对话只看到 `[object Object],[object Object]`——
  // 因为代码写的是 `String(result.output)`，而 `SubagentResult.output`
  // 的类型是 `ContentBlock[]`（dsh-subagent/lib/types/types.d.ts:219）。
  //
  // 这个 bug 最恶劣的地方：**它不报错**。运行照跑、token 照花，只有产出变成垃圾。
  const hub = makeHub({
    fake: {
      output: [
        { type: 'text', text: '我是 deepseek-v4-flash。' },
        { type: 'text', text: '（第二段）' },
      ],
    },
  });
  const agent = seedAgent(hub.store, { name: '研究员' });
  hub.built.install();

  const started = hub.runtime.start({ agent, prompt: '你什么模型', parentAgent: {}, parentSessionId: 'parent-1' });
  const settled = await hub.runtime.waitFor(started.run.id);

  assert.equal(settled.status, 'completed');
  assert.equal(typeof settled.output, 'string', 'output 必须是字符串');
  assert.doesNotMatch(settled.output, /\[object Object\]/, '绝不能出现被 JS 强转的痕迹');
  assert.match(settled.output, /我是 deepseek-v4-flash/);
  assert.match(settled.output, /第二段/, '多个文本块都要保留');

  // 落库的正文也必须是文本。
  const persisted = hub.store.getRun(started.run.id);
  assert.doesNotMatch(persisted.outputTail, /\[object Object\]/);
  assert.match(persisted.outputTail, /我是 deepseek-v4-flash/);

  // 工具返回给主对话的正文同样必须是文本（render 与值两条路都要干净）。
  // 必须显式启用：不启用的话工具会走「拒绝」分支、output 是空串，
  // 于是断言会在一个完全无关的原因上失败／通过——所以同时断言 status 以消除这个歧义。
  hub.store.setEnabled(true);
  const runTool = hub.registered.get('subagent_run');
  const value = await runTool.execute({ agent: '研究员', prompt: '你什么模型' }, { agent: { session: { id: 'parent-1' } } });
  assert.equal(value.status, 'completed', `工具应当真的跑完，实际 ${value.status}：${value.error}`);
  assert.doesNotMatch(String(value.output), /\[object Object\]/);
  assert.match(String(value.output), /我是 deepseek-v4-flash/);
  const blocks = runTool.output.render({}, value);
  assert.doesNotMatch(blocks[0].text, /\[object Object\]/);
  assert.match(blocks[0].text, /我是 deepseek-v4-flash/);

  hub.runtime.detach();
  hub.store.close();
});

/**
 * 直接调用处理器，用最小的假 req/res 收集响应。
 *
 * 不启真实服务器：这样测试不依赖端口、不依赖 TCP，也不会在 CI 上撞端口。
 *
 * @param {Function} handler - createHandler 的返回值。
 * @param {{method:string,url:string,body?:any,headers?:object}} request - 请求。
 * @returns {Promise<{status:number,body:any,headers:object}>}
 */
function invoke(handler, request) {
  return new Promise((resolve, reject) => {
    const payload = request.body === undefined ? '' : JSON.stringify(request.body);
    const listeners = new Map();
    const req = {
      method: request.method,
      url: request.url,
      headers: { host: '127.0.0.1:3080', ...(request.headers ?? {}) },
      on(event, callback) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(callback);
        return req;
      },
      destroy() {},
    };
    const res = {
      status: 0,
      headers: {},
      chunks: [],
      headersSent: false,
      writeHead(status, headers) {
        res.status = status;
        res.headers = headers ?? {};
        res.headersSent = true;
        return res;
      },
      write(chunk) { res.chunks.push(String(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined) res.chunks.push(String(chunk));
        const text = res.chunks.join('');
        let body;
        try { body = text === '' ? undefined : JSON.parse(text); } catch { body = text; }
        resolve({ status: res.status, body, headers: res.headers });
      },
    };

    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => {
        // 处理器正常返回但没结束响应（例如 SSE）：也当作完成。
        if (!res.headersSent) reject(new Error('handler returned without writing a response'));
      })
      .catch(reject);

    // 触发 body 事件流。
    Promise.resolve().then(() => {
      if (payload !== '') {
        for (const callback of listeners.get('data') ?? []) callback(Buffer.from(payload, 'utf8'));
      }
      for (const callback of listeners.get('end') ?? []) callback();
    });
  });
}
