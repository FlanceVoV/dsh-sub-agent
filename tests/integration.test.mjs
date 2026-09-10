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
import { createTaskBoard } from '../lib/src/tasks.js';

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
 * `stopReason` 可以给一个**函数**：任务链路要验「上游失败 → 下游阻塞 → 重试后恢复」，
 * 那就必须能让同一个假运行时在第二次跑时给出不同的结果。
 */
function makeFakeDsh({ chunkDelayMs = 50, stopReason = 'completed', output = '子 agent 的产出', usage = { outputTokens: 10, inputTokens: 5 } } = {}) {
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
          // usage 可以显式给 null：模拟「provider 一个字都没产出就失败了」这种真实情况
          // （本地推理服务没起来时就是这个样子——stopReason 是 error，却没有任何错误文本）。
          ...(usage === null ? {} : { usage }),
        });
        return { stopReason: typeof stopReason === 'function' ? stopReason() : stopReason, output };
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
  // 任务清单服务：宿主装配里它在 runtime 之后构造并挂订阅，
  // 这里保持同样的顺序，否则测试验的就不是真机上的那套接法。
  const tasks = createTaskBoard({ ctx: fake.ctx, store, runtime, config, log: silentLog });
  const detachTasks = tasks.attach();
  const context = {
    ctx: fake.ctx, store, runtime, tasks, config, log: silentLog,
    dataDir: tempDataDir(), dbPath: 'y', version: '0.2.0',
  };
  const built = buildTools(context);
  const close = () => {
    detachTasks();
    tasks.dispose();
    runtime.detach();
    store.close();
  };
  return { ...fake, store, runtime, tasks, config, context, built, close };
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

  hub.close();
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
  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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

  hub.close();
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
  hub.close();
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

  hub.close();
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

//#region 任务清单与依赖图（0.2.0）
//
// 这一组测的是**新的那一层**：清单怎么变成一条真会自己走的链路。
// 关键不是「函数返回了没有」，而是三件事：
//   1. 依赖没完成时**真的没有人被启动**（不能出现「等待依赖」的任务偷偷跑起来）；
//   2. 依赖一完成，下游**真的被宿主激活**（这是本功能存在的理由）；
//   3. 上游失败时下游**真的停住**，并且重试上游之后能恢复（否则链路会静默死掉）。

/** 三个角色，覆盖一条典型的「调研 → 实现 → 评审」链路。 */
function seedChainAgents(store) {
  seedAgent(store, { name: '研究员' });
  seedAgent(store, { name: '工程师', modelId: 'deepseek-v4.1' });
  seedAgent(store, { name: '审核员', modelId: 'deepseek-v4.1', toolPolicy: 'readonly' });
}

/**
 * 等链路走到某个状态。
 *
 * 每次循环都显式 `flush()` 一下：自动激活本身是 0ms 定时器，测试不该依赖
 * 「定时器和 spawn 的相对顺序」这种和实现细节耦合的时序。
 * @param {object} hub - 运行态。
 * @param {string} planId - 清单 id。
 * @param {Function} predicate - 判定。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<object>} 命中时的清单视图。
 */
async function waitForPlan(hub, planId, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await hub.tasks.flush();
    const view = hub.tasks.board(planId);
    if (view !== undefined && predicate(view)) return view;
    if (Date.now() > deadline) {
      const states = hub.tasks.board(planId)?.tasks.map((task) => `${task.id}:${task.state}`).join(', ');
      throw new Error(`等待链路状态超时（当前 ${states}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const parentExec = { agent: { session: { id: 'parent-1' } }, signal: new AbortController().signal };

test('链路：建清单即激活第一层，依赖完成后宿主自动激活下游，直到整条链路走完', async () => {
  const hub = makeHub();
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  const planTool = hub.registered.get('subagent_plan');
  assert.ok(planTool !== undefined, 'subagent_plan 必须被注册（任务清单的入口）');

  const created = await planTool.execute({
    title: '三段链路',
    // 这个用例要看**中间态**（谁在等谁），所以显式关掉「等整条链路跑完」。
    // 默认是等的——理由是：主对话一旦结束回合，就没有人在等这条链路了（见下一个用例）。
    wait_for_chain: false,
    tasks: [
      { id: 'spec', title: '调研现状', agent: '研究员', brief: '把 X 的现状调研清楚' },
      { id: 'impl', title: '按结论实现', agent: '工程师', brief: '按上游结论实现', deps: ['spec'] },
      { id: 'review', title: '独立评审', agent: '审核员', brief: '独立复核实现', deps: ['impl'] },
    ],
  }, parentExec);

  assert.equal(created.error, '');
  assert.equal(created.started.length, 1, '只有没有依赖的那一层该被立刻激活');
  assert.equal(created.started[0].task_id, 'spec');
  const planId = created.plan_id;

  // 建单之后立刻看：下游必须如实写着「在等谁」，而不是含糊地「待办」。
  const initial = hub.tasks.board(planId);
  assert.equal(initial.tasks.find((task) => task.id === 'impl').state, 'waiting');
  assert.deepEqual(initial.tasks.find((task) => task.id === 'impl').waitingFor, ['spec']);
  assert.equal(initial.tasks.find((task) => task.id === 'review').state, 'waiting');
  assert.equal(hub.spawned.length, 1, '等待依赖的任务绝不能被提前启动');

  const finished = await waitForPlan(hub, planId, (view) => view.progress.done === 3);
  assert.deepEqual(finished.tasks.map((task) => task.state), ['done', 'done', 'done']);
  assert.equal(finished.progress.percent, 100);
  assert.equal(hub.spawned.length, 3, '三项任务各跑一次');
  assert.deepEqual(hub.spawned.map((item) => item.request.label), ['研究员', '工程师', '审核员'],
    '推进顺序必须与依赖一致');

  // 上游产出真的进了下游提示词——没有这一条，「流水线」就只是三次互不相干的调用。
  const prompts = hub.spawned.map((item) => item.request.prompt[0].text);
  assert.match(prompts[0], /任务清单上下文/);
  assert.match(prompts[0], /你的任务：spec「调研现状」/);
  assert.match(prompts[0], /把 X 的现状调研清楚/, '任务的 brief 必须在提示词里');
  assert.match(prompts[1], /上游任务 spec「调研现状」/);
  assert.match(prompts[1], /子 agent 的产出/, '上游产出的正文要带过去');
  assert.match(prompts[2], /上游任务 impl/);
  assert.match(prompts[1], /不要写「如上所述」/, '要写清「产出会被直接交给下游」的约束');

  // 任务与运行的双向联系：任务里有 run_id，运行里有 task_key（回归按任务聚合）。
  const implTask = hub.store.getTask(planId, 'impl');
  assert.equal(hub.store.getRun(implTask.runId).taskKey, 'impl');
  assert.equal(implTask.attempts, 1);

  hub.close();
});

test('链路：subagent_plan 默认等整条链路跑完，并把各任务产出一起带回来', async () => {
  const hub = makeHub();
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  const created = await hub.registered.get('subagent_plan').execute({
    title: '一口气跑完',
    tasks: [
      { id: 'a', title: '第一步', agent: '研究员' },
      { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
    ],
  }, parentExec);

  // 关键：工具**返回时链路已经跑完**。默认不等的话，主对话一结束回合，
  // 就再没有任何人在等这条链路——「子 agent 没跑完，主对话已经结束」正是这个原因。
  assert.equal(created.error, '');
  assert.equal(created.settled, true, '默认必须等到链路结算（而不是建完就撒手）');
  assert.match(created.chain, /进度 2\/2/);
  assert.match(created.chain, /各任务产出：/, '产出要随结果一起回给主对话，省掉一轮追问');
  assert.match(created.chain, /子 agent 的产出/);
  const view = hub.tasks.board(created.plan_id);
  assert.deepEqual(view.tasks.map((task) => task.state), ['done', 'done']);
  assert.equal(hub.spawned.length, 2);

  hub.close();
});

test('链路：主对话结束了回合也不会彻底卡死——父 agent 被钉住，回来时能接着推', async () => {
  const hub = makeHub({ fake: { chunkDelayMs: 60 } });
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  // 关掉「等链路」＝模拟主对话建完就结束了回合。
  const created = await hub.registered.get('subagent_plan').execute({
    title: '回合结束的链路',
    wait_for_chain: false,
    tasks: [
      { id: 'a', title: '第一步', agent: '研究员' },
      { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
      { id: 'c', title: '第三步', agent: '审核员', deps: ['b'] },
    ],
  }, parentExec);
  const planId = created.plan_id;
  assert.equal(hub.spawned.length, 1);

  // 关键一步：从此刻起**按会话查不到活动 agent 了**（等于主对话那个回合已经不在了）。
  // 后面的激活只能靠「建单时钉住的父 agent 实例」，钉不住就走不下去。
  const realCtx = hub.ctx;
  const originalGet = realCtx.get;
  realCtx.get = (name) => {
    if (name === 'agents') return { get: () => undefined, bySession: () => undefined, resolve: () => undefined };
    return originalGet.call(realCtx, name);
  };

  // 第一项跑完 → 下游仍然会被激活（父 agent 实例已经被钉住，不再依赖「查得到活动会话」）。
  const chained = await waitForPlan(hub, planId, (view) => view.progress.done === 3);
  assert.deepEqual(chained.tasks.map((task) => task.state), ['done', 'done', 'done'],
    '钉住的父 agent 让链路在主对话离开之后仍然走得下去');
  assert.equal(hub.spawned.length, 3);

  realCtx.get = originalGet;
  hub.close();
});

test('链路：父 agent 拿不到时如实记下原因，并在主对话回到会话时自动续跑', async () => {
  // 这个用例模拟「父会话那一刻查不到活动 agent」：先是修不好，然后才可用。
  let resolvable = false;
  const hub = makeHub({ fake: { chunkDelayMs: 30 } });
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  // 让 agents.get() 在 resolvable=false 时查不到（等价于「活动会话暂时不在」）。
  const realCtx = hub.ctx;
  const originalGet = realCtx.get;
  realCtx.get = (name) => {
    if (name === 'agents' && resolvable !== true) return { get: () => undefined, bySession: () => undefined, resolve: () => undefined };
    return originalGet.call(realCtx, name);
  };

  // 建单时连父 agent 都不给（面板路径才会这样），于是激活失败并**写清原因**。
  const created = hub.tasks.createPlan({
    title: '等父会话回来',
    tasks: [{ id: 'a', title: '第一步', agent: '研究员' }],
  }, { parentSessionId: 'parent-1', invokedBy: 'panel' });
  assert.equal(created.started.length, 0);
  const stalled = hub.tasks.board(created.board.plan.id);
  assert.equal(stalled.tasks[0].state, 'ready', '任务停在「可执行」，而不是假装配发');
  assert.match(stalled.plan.activationError, /无法自动激活/);
  assert.match(stalled.plan.activationError, /手动放行/, '要给出可执行的下一步');

  // 主对话回来了（同一会话里出现用户消息）→ 自动续跑。
  resolvable = true;
  hub.emit('parent-1', 'user/message', { content: [{ type: 'text', text: '继续' }] });
  const resumed = await waitForPlan(hub, created.board.plan.id, (view) => view.progress.done === 1);
  assert.equal(resumed.tasks[0].state, 'done');
  assert.equal(resumed.plan.activationError, '', '重新跑起来之后，那条「卡住了」的提示要被清掉');

  realCtx.get = originalGet;
  hub.close();
});

test('链路：关掉自动激活后，下游只标「可执行」；打开的那一刻才放行', async () => {
  const hub = makeHub();
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  const created = await hub.registered.get('subagent_plan').execute({
    title: '手动链路',
    auto_activate: false,
    tasks: [
      { id: 'a', title: '第一步', agent: '研究员' },
      { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
    ],
  }, parentExec);
  const planId = created.plan_id;
  assert.equal(created.started.length, 0, 'auto_activate:false 时连第一层也不该自动跑');
  assert.equal(hub.spawned.length, 0);

  let view = hub.tasks.board(planId);
  assert.equal(view.plan.autoActivate, false);
  assert.equal(view.tasks[0].state, 'ready');
  assert.equal(view.tasks[1].state, 'waiting');
  assert.match(view.next, /可立即激活：a/);

  // 手动激活第一个任务。
  const activated = await hub.registered.get('subagent_tasks').execute(
    { action: 'activate', plan_id: planId },
    parentExec,
  );
  assert.equal(activated.error, '');
  assert.match(activated.text, /已激活：a/);

  // 它跑完之后，下游**仍然**不能自己跑起来。
  await waitForPlan(hub, planId, (view2) => view2.progress.done === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await hub.tasks.flush();
  view = hub.tasks.board(planId);
  assert.equal(view.tasks[1].state, 'ready');
  assert.equal(view.tasks[1].runId, '', '关掉自动激活后，任何自动路径都不许放行下游');
  assert.equal(hub.spawned.length, 1);

  // 打开自动激活 → 已经就绪的任务立刻被放行（否则用户看到的是「改了没用」）。
  const toggled = hub.tasks.setAutoActivate(planId, true);
  assert.equal(toggled.started.length, 1);
  const done = await waitForPlan(hub, planId, (view2) => view2.progress.done === 2);
  assert.deepEqual(done.tasks.map((task) => task.state), ['done', 'done']);

  hub.close();
});

test('链路：上游失败 → 下游「被上游阻塞」（不是「等待」）→ 重试上游后链路自己恢复', async () => {
  let failNext = true;
  const hub = makeHub({ fake: { stopReason: () => (failNext ? 'error' : 'completed'), usage: null } });
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  const created = await hub.registered.get('subagent_plan').execute({
    title: '会失败的链路',
    tasks: [
      { id: 'a', title: '第一步', agent: '研究员' },
      { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
    ],
  }, parentExec);
  const planId = created.plan_id;

  const broken = await waitForPlan(hub, planId, (view) => view.tasks[0].state === 'failed');
  assert.equal(broken.tasks[0].state, 'failed');
  assert.equal(broken.tasks[0].note.length > 0, true, '失败原因要留在任务上，否则界面只能显示一个红色的点');
  // DSH 偶尔会给出「error 但没有任何错误文本」；那时唯一可靠的线索是「一个 token 都没产出」，
  // 说明模型根本没被调用成功——把往哪查说出来，比「没有更多信息」有用得多。
  assert.match(broken.tasks[0].note, /一个 token 都没产出/);
  assert.match(broken.tasks[0].note, /本地推理服务/, '要给出可查的方向，而不是让人从零开始排查');
  assert.equal(broken.tasks[1].state, 'blocked', '上游失败不该被含糊成「等待」——它不会自己好');
  assert.deepEqual(broken.tasks[1].blockedBy, ['a']);
  assert.equal(hub.spawned.length, 1, '被阻塞的下游绝不能被启动');
  assert.match(broken.next, /需要重试上游或取消本任务/);

  // 重试下游：必须被拒，并说清为什么（只重试它是没用的）。
  const premature = hub.tasks.retry(planId, 'b');
  assert.equal(premature.ok, false);
  assert.match(premature.error, /先重试或取消那些上游任务/);

  // 重试上游 → 这次成功 → 下游被自动激活并完成。
  failNext = false;
  const retried = hub.tasks.retry(planId, 'a');
  assert.equal(retried.ok, true, retried.error);
  const recovered = await waitForPlan(hub, planId, (view) => view.progress.done === 2);
  assert.deepEqual(recovered.tasks.map((task) => task.state), ['done', 'done']);
  assert.equal(hub.store.getTask(planId, 'a').attempts, 2, '重试要留下次数');

  hub.close();
});

test('校验：非法的清单当场被拒（环、未知 agent、悬空依赖），且不会往库里写半个清单', async () => {
  const hub = makeHub();
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();
  const planTool = hub.registered.get('subagent_plan');

  const cyclic = await planTool.execute({
    title: '环',
    tasks: [
      { id: 'a', title: 'A', agent: '研究员', deps: ['b'] },
      { id: 'b', title: 'B', agent: '研究员', deps: ['a'] },
    ],
  }, parentExec);
  assert.match(cyclic.error, /形成了环/);

  const unknownAgent = await planTool.execute({
    title: '错名字',
    tasks: [{ id: 'a', title: 'A', agent: '研究猿' }],
  }, parentExec);
  assert.match(unknownAgent.error, /不是已配置的子 agent/);

  assert.equal(hub.store.listPlans().length, 0, '被拒的清单不该留下任何痕迹');
  assert.equal(hub.spawned.length, 0);

  hub.close();
});

test('子 agent 可以查看任务清单（只读）：看得到自己在链路里的位置，但改不动链路', async () => {
  const hub = makeHub({ fake: { chunkDelayMs: 120 } });
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  const created = await hub.registered.get('subagent_plan').execute({
    title: '可见性链路',
    // 要看运行中的状态，所以不等整条链路跑完。
    wait_for_chain: false,
    tasks: [
      { id: 'a', title: '第一步', agent: '研究员' },
      { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
    ],
  }, parentExec);
  const planId = created.plan_id;

  // 等第一次运行真的进入 running（会话 id 是在发布之后才写进遥测的）。
  const started = await waitForPlan(hub, planId, (view) => view.tasks[0].runStatus !== 'queued');
  assert.equal(started.tasks[0].state, 'running');
  const childSessionId = hub.spawned[0].sessionId;

  const tasksTool = hub.registered.get('subagent_tasks');
  const seen = await tasksTool.execute({}, { agent: { session: { id: childSessionId } } });
  assert.equal(seen.is_sub_agent, true, '要能识别出调用者是子 agent');
  assert.match(seen.text, /你是子 agent/);
  assert.match(seen.text, /你的任务是 .*\/a/, '要指出它自己在链路里的位置');
  assert.match(seen.text, /第二步/, '它也该看到下游在等它');
  assert.match(seen.text, /等待依赖/, '状态语言与界面一致');

  const denied = await tasksTool.execute(
    { action: 'cancel', plan_id: planId, task_id: 'b' },
    { agent: { session: { id: childSessionId } } },
  );
  assert.equal(denied.text, '');
  assert.match(denied.error, /子 agent 不能用/);
  assert.match(denied.error, /写进你的产出里/, '拒绝要给一条可执行的替代路径');
  assert.equal(hub.tasks.board(planId).tasks[1].cancelledAt, null, '被拒的写操作不能有任何副作用');

  // 主对话（父会话）不受这条限制。
  const allowed = await tasksTool.execute({ plan_id: planId, detail: true }, parentExec);
  assert.equal(allowed.is_sub_agent, false);
  assert.match(allowed.text, /任务清单「可见性链路」/);

  hub.close();
});

test('HTTP：清单的增删改查与手动激活，等待中的任务被明确拒绝并说明在等谁', async () => {
  const hub = makeHub({ fake: { chunkDelayMs: 300 } });
  seedChainAgents(hub.store);
  const handler = createHandler(hub.context);

  const created = await invoke(handler, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/tasks`,
    body: {
      parentSessionId: 'parent-1',
      title: 'HTTP 链路',
      tasks: [
        { id: 'a', title: '第一步', agent: '研究员' },
        { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = created.body.plan.plan.id;
  assert.equal(created.body.started.length, 1);

  // 列表里能一次看到全部链路（面板要按它画图）。
  const listed = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/tasks` });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.plans.length, 1);
  assert.deepEqual(listed.body.plans[0].edges, [{ from: 'a', to: 'b' }], '依赖图由依赖本身推出来');

  // 单条链路：带说明书（详情页要用）。
  const one = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/tasks/${planId}` });
  assert.equal(one.status, 200);
  assert.equal(one.body.plan.tasks[0].brief, '');

  // 状态快照里必须带上任务图：面板要在同一帧里看到「谁在跑」和「任务到哪一步」。
  const state = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/state?sessionId=s-1` });
  assert.equal(state.body.tasks.plans.length, 1);
  assert.equal(state.body.tasks.plans[0].plan.id, planId);

  // 「等待依赖」的任务不许被手动激活——拒绝信息要说出它在等谁。
  const tooEarly = await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/tasks/${planId}/b/activate` });
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.error, /在等 a 完成/);

  // 不存在的清单与任务：404 / 409，而不是 500。
  const missing = await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/tasks/pl_nope` });
  assert.equal(missing.status, 404);
  const noTask = await invoke(handler, { method: 'POST', url: `${ROUTE_PREFIX}/tasks/${planId}/zz/activate` });
  assert.equal(noTask.status, 409);
  assert.match(noTask.body.error, /没有任务「zz」/);

  const done = await waitForPlan(hub, planId, (view) => view.progress.done === 2);
  assert.equal(done.tasks[1].state, 'done');

  // 改与删：PATCH 只开放 autoActivate（清单名与说明改了会让链路与回归对不上）。
  const patched = await invoke(handler, {
    method: 'PATCH', url: `${ROUTE_PREFIX}/tasks/${planId}`, body: { autoActivate: false },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.plan.plan.autoActivate, false);
  const badPatch = await invoke(handler, { method: 'PATCH', url: `${ROUTE_PREFIX}/tasks/${planId}`, body: { title: '改名' } });
  assert.equal(badPatch.status, 400);

  const removed = await invoke(handler, { method: 'DELETE', url: `${ROUTE_PREFIX}/tasks/${planId}` });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removedTasks, 2);
  assert.equal((await invoke(handler, { method: 'GET', url: `${ROUTE_PREFIX}/tasks/${planId}` })).status, 404);

  hub.close();
});

test('subagent_run 绑定 task_id：产物与链路现状一起回来，不会重复派发同一项任务', async () => {
  const hub = makeHub();
  seedChainAgents(hub.store);
  hub.store.setEnabled(true);
  hub.built.install();

  const created = await hub.registered.get('subagent_plan').execute({
    title: '绑定链路',
    auto_activate: false,
    tasks: [
      { id: 'a', title: '第一步', agent: '研究员', brief: '先做这件事' },
      { id: 'b', title: '第二步', agent: '工程师', deps: ['a'] },
    ],
  }, parentExec);
  const planId = created.plan_id;

  const runTool = hub.registered.get('subagent_run');
  // 想跑还没轮到的那一项：拒绝，并说清它在等谁。
  const tooEarly = await runTool.execute({ task_id: 'b', plan_id: planId }, parentExec);
  assert.match(tooEarly.error, /在等 a 完成/);
  assert.match(tooEarly.note, /宿主会自动激活/, '要告诉模型不要自己轮询');

  // 跑第一项：agent 与 prompt 都由清单决定，所以不该再传 prompt。
  const conflict = await runTool.execute({ task_id: 'a', plan_id: planId, prompt: '另起一段' }, parentExec);
  assert.match(conflict.error, /不要再传 prompt/);

  const ran = await runTool.execute({ task_id: 'a', plan_id: planId }, parentExec);
  assert.equal(ran.status, 'completed');
  assert.equal(ran.agent, '研究员', 'agent 来自清单，而不是参数');
  assert.equal(ran.output, '子 agent 的产出');
  assert.match(ran.note, /链路「绑定链路」：进度 1\/2/, '结果里要带链路现状');
  assert.match(ran.note, /可立即激活：b/, '关掉自动激活时，可执行的任务要提示出来');

  // 打开自动激活：就绪的 b 会**在那一刻**被放行（改了立刻生效，而不是等下一次事件）。
  const toggled = hub.tasks.setAutoActivate(planId, true);
  assert.equal(toggled.started.length, 1, '打开自动激活的当下就该放行已就绪的任务');
  assert.equal(toggled.started[0].taskId, 'b');

  // 于是同一项任务再被手动派发一次就会被拒绝——「不会重复派发」正是要守住的东西。
  const duplicate = await runTool.execute({ task_id: 'b', plan_id: planId }, parentExec);
  assert.equal(duplicate.status, 'rejected');
  assert.match(duplicate.error, /已经在跑了|已经完成/);

  const finished = await waitForPlan(hub, planId, (view) => view.progress.done === 2);
  assert.equal(finished.next, '', '全部完成后不该再有「下一步」');
  assert.equal(hub.spawned.length, 2, '两项任务各只跑一次');

  const replay = await runTool.execute({ task_id: 'b', plan_id: planId }, parentExec);
  assert.match(replay.error, /已经完成了/, '已完成的任务不该被再跑一遍');
  assert.equal(hub.spawned.length, 2);

  hub.close();
});
//#endregion
