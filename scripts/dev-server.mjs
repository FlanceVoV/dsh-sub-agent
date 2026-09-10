/**
 * 离线宿主预览：不启动 DSH 也能把宿主的 API 跑起来并手动调用。
 *
 * 为什么需要它：**宿主侧代码改动需要重启 `dsh web`**（DSH 的 HMR 被创建为
 * `config:{root:[]}`，即不监听任何模块路径），而重启一次会打断正在用的 GUI 和对话。
 * 有了这个脚本，`lib/src/*` 的绝大部分改动可以在这里先跑通、先用 curl 验完，
 * 再去动 DSH。
 *
 * 它**不**渲染面板：面板需要真实的 React 与 DSH 的插槽环境。
 * 这个脚本只服务宿主半边——它替代的是「重启 DSH 才能试一次」，
 * 不是替代 `scripts/verify-client.mjs`。
 *
 * 用法：
 *   node scripts/dev-server.mjs            # 监听 127.0.0.1:8791，库在临时目录
 *   node scripts/dev-server.mjs --port 9000 --db D:\tmp\hub.db
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../lib/src/config.js';
import { createHandler, ROUTE_PREFIX } from '../lib/src/http.js';
import { buildTools } from '../lib/src/tools.js';
import { HubRuntime } from '../lib/src/runtime.js';
import { HubStore } from '../lib/src/store.js';

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { port: 8791, host: '127.0.0.1', db: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--port' && value !== undefined) args.port = Number(value);
    else if (key === '--host' && value !== undefined) args.host = value;
    else if (key === '--db' && value !== undefined) args.db = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db ?? join(mkdtempSync(join(tmpdir(), 'sbh-dev-')), 'hub.db');

const log = {
  info: (...parts) => console.log('[subagent-hub]', ...parts),
  warn: (...parts) => console.warn('[subagent-hub]', ...parts),
  error: (...parts) => console.error('[subagent-hub]', ...parts),
  debug: () => {},
};

/**
 * 最小的假 DSH 上下文。
 *
 * 刻意只实现 http.js / tools.js / runtime.js 真正会碰的那几个服务，
 * 并且**故意不提供 subagents**：这样面板与工具在「本部署没有子 agent 运行时」
 * 时的降级姿势（明确的错误文案，而不是崩溃）在这里就能被看见。
 * 想试真实启动路径，用 tests/integration.test.mjs 里那个带假 subagents 的实现。
 */
function makeFakeCtx() {
  const listeners = new Map();
  return {
    get(name) {
      if (name === 'agents') return { get: (id) => ({ session: { id } }) };
      if (name === 'tools') return { register: () => () => {} };
      if (name === 'systemPrompt') return { section: () => () => {} };
      if (name === 'llm') return { listProviders: () => [], listConfigurableProviders: () => [] };
      if (name === 'settings') return { describe: () => [] };
      return undefined; // subagents 故意缺席
    },
    on(event, handler, options) {
      if (options?.global !== true) throw new Error('session/event 订阅必须带 {global:true}');
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    effect: (fn) => fn(),
    webServer: { register: () => () => {}, host: args.host },
  };
}

const store = new HubStore({ dbPath, log }).open();
const { config, warnings } = normalizeConfig({});
for (const warning of warnings) log.warn(warning);

const ctx = makeFakeCtx();
const runtime = new HubRuntime({ ctx, store, config, log });
runtime.attach();
runtime.reconcileStaleRuns();
const context = { ctx, store, runtime, config, log, dataDir: join(dbPath, '..'), dbPath, version: 'dev' };
const built = buildTools(context);
for (const warning of built.warnings) log.warn(warning);
built.install();

// 库为空时塞两条示例配置，省得每次都先 curl 一遍创建。
if (store.listAgents().length === 0) {
  store.insertAgent({
    name: '研究员', transport: 'spawn', modelProvider: 'deepseek-official',
    modelId: 'deepseek-v4.1-flash', note: '示例：调研类任务',
  });
  store.insertAgent({
    name: '审核员', transport: 'spawn', modelProvider: 'deepseek-official',
    modelId: 'deepseek-v4.1', toolPolicy: 'readonly', note: '示例：只读审查',
  });
  log.info('已塞入两条示例配置（研究员 / 审核员）');
}

const handler = createHandler(context);
const server = createServer((req, res) => { void handler(req, res); });

server.listen(args.port, args.host, () => {
  const base = `http://${args.host}:${args.port}${ROUTE_PREFIX}`;
  log.info(`离线宿主已就绪：${base}`);
  log.info(`数据库：${dbPath}`);
  log.info('试试：');
  log.info(`  curl.exe -sS ${base}/health`);
  log.info(`  curl.exe -sS "${base}/state?sessionId=s-1"`);
  log.info(`  curl.exe -sS -X POST ${base}/agents -H "content-type: application/json" -d "{\\"name\\":\\"写手\\",\\"transport\\":\\"spawn\\",\\"modelProvider\\":\\"deepseek-official\\",\\"modelId\\":\\"deepseek-v4.1\\"}"`);
  log.info(`  curl.exe -sS -X POST ${base}/enable -H "content-type: application/json" -d "{\\"sessionId\\":\\"s-1\\",\\"enabled\\":true}"`);
  log.info('注意：这里没有 subagents 服务，所以 /run 会明确告诉你运行时不可用——那是刻意的降级演示。');
});

/** 优雅退出：关掉服务器与数据库。 */
const shutdown = () => {
  log.info('正在退出…');
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
