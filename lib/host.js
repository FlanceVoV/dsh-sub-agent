/**
 * dsh-subagent-hub 宿主（Node 侧）入口。
 *
 * 分工（高内聚低耦合的落点）：
 *  - 本文件：只做生命周期与装配。没有任何领域逻辑。
 *  - lib/src/store.js     存储（sqlite）：agent 配置、运行台账、评价、轮次、设置、任务清单。
 *  - lib/src/discovery.js 自发现：向 DSH 问「本机能用哪些路由/模型/传输/凭据」。
 *  - lib/src/registry.js  校验与翻译：配置 → AgentOptions / ToolRestriction（纯逻辑）。
 *  - lib/src/plan.js      任务清单的纯逻辑：校验、环检测、状态派生、分层（零依赖，可穷举测试）。
 *  - lib/src/tasks.js     任务清单的应用服务：建清单、激活任务、监测依赖完成（唯一碰调度处）。
 *  - lib/src/runtime.js   运行时：起子 agent、折遥测、守并发与超时（唯一碰 DSH 内部 API 处之一）。
 *  - lib/src/http.js      传输层：JSON + SSE，与面板之间的唯一 seam。
 *  - lib/client.js        浏览器侧悬浮球、配置页、任务链路图、@ 源（另一个碰 DSH 的地方）。
 *
 * `inject` 里只写「离了它插件就不该存在」的服务。其余（subagents / tools / systemPrompt /
 * sessionProjections / agents / llm / settings / credentials / sessions）一律用 ctx.get()
 * 防御式取用：取不到就把对应能力关掉并**说清楚关了什么**，而不是让插件整体起不来。
 * 理由：本插件横跨 DSH 的多个子系统，任一子系统在别的组合里缺席都不该导致全盘失效。
 *
 * @module dsh-subagent-hub
 */
import { buildTools } from './src/tools.js';
import { loadUserConfig, normalizeConfig, resolveDbPath } from './src/config.js';
import { createHandler, ROUTE_PREFIX } from './src/http.js';
import { ensureDir, resolveDataDir } from './src/io.js';
import { createLogger, describeError, formatLogMessage, isOwnMessage, resolveNamedLogger } from './src/log.js';
import { HubRuntime } from './src/runtime.js';
import { HubStore } from './src/store.js';
import { createTaskBoard } from './src/tasks.js';
import { harnessWarning } from './src/version.js';

/** 稳定插件名（与 package.json 的 name 一致）。 */
export const name = 'subagent-hub';

/** 插件版本（与 package.json 的 version 一致，由 tests/contract.test.mjs 锁住）。 */
export const VERSION = '0.2.0';

/** 需要的宿主服务：只有 webServer（注册 HTTP 路由，本插件离了它没有出口）。 */
export const inject = ['webServer'];

/** 保留策略的检查频率（每小时看一眼有没有该清理的记录）。 */
const RETENTION_CHECK_MS = 60 * 60 * 1000;

/**
 * 挂载插件。
 * @param {object} ctx - 宿主 cordis 上下文。
 * @param {unknown} entryConfig - cordis entry config（可缺省）。
 */
export function apply(ctx, entryConfig) {
  // 用**具名** logger：日志出口靠这个名字把别人的日志过滤掉。
  const log = createLogger(resolveNamedLogger(ctx));
  const dataDir = resolveDataDir(ctx, 'subagent-hub');
  ensureDir(dataDir);

  const { config, warnings } = normalizeConfig(entryConfig, loadUserConfig(dataDir));
  for (const warning of warnings) log.warn(warning);

  // 版本兼容性：**只警告，不阻止加载**。
  // 本插件用的是 DSH 的内部接口，版本漂移的天然表现是「能力静默关闭」；
  // 启动时说一句，用户才有可能把「面板缺了一块」与「版本不对」联系起来。
  const versionWarning = harnessWarning(ctx);
  if (versionWarning !== null) log.warn(versionWarning);

  attachLogSink(ctx, config, log);

  const dbPath = resolveDbPath(config, dataDir);
  const context = {
    ctx,
    dataDir,
    dbPath,
    config,
    log,
    store: undefined,
    runtime: undefined,
    tasks: undefined,
    initError: undefined,
  };

  // 打开存储与运行时。`apply` 保持同步（宿主启动顺序与本插件无关），
  // 但 sqlite 打开是同步的，所以这里没有需要 await 的东西——失败就直接降级：
  // 路由仍然挂上，面板会看到 initError 而不是一个空白页。
  try {
    context.store = new HubStore({ dbPath, log }).open();
  } catch (error) {
    context.initError = `存储打开失败：${describeError(error)}`;
    log.error(context.initError);
  }

  if (context.store !== undefined) {
    // schema 升级要说一句：0.2.0 给任务清单加了表，只加表所以是幂等的，
    // 但用户至少该知道库被改过（否则「面板多了一块」像是凭空出现的）。
    if (context.store.schemaUpgrade !== null) {
      log.info(`数据库 schema 已升级：v${context.store.schemaUpgrade.from} → v${context.store.schemaUpgrade.to}（补建任务清单所需的表）`);
    }
    // 一次性迁移：把旧版「按会话的启用开关」合并成全局开关。
    // 不做的话，升级后原本开着的部署会变成关着——用户看到的是「配置都在但什么都没有」。
    try {
      const migration = context.store.migrateEnableScope();
      if (migration.migrated) {
        log.info(`启用开关已迁移为全局：合并了 ${migration.sources} 条按会话的旧记录，当前状态 = ${context.store.isEnabled() ? '已启用' : '未启用'}`);
      }
    } catch (error) {
      log.warn(`启用开关迁移失败（不影响启动）：${describeError(error)}`);
    }

    context.runtime = new HubRuntime({
      ctx,
      store: context.store,
      config,
      log,
    });
    const listening = context.runtime.attach();
    if (!listening) {
      log.warn('没有收到子 agent 的实时事件：悬浮球将只能看到终态，详情页不会有逐 token 输出');
    }
    if (typeof context.runtime.resolveParent === 'function') {
      try {
        const repaired = context.runtime.reconcileStaleRuns();
        if (repaired > 0) log.info(`启动对账：把 ${repaired} 条上次进程遗留的「运行中」记录标为中断`);
      } catch (error) {
        log.warn(`启动对账失败：${describeError(error)}`);
      }
    }

    // 任务清单服务：它订阅运行时事件，负责「依赖完成 → 激活下游」。
    // 放在 runtime 之后构造是硬性的：它要挂订阅，也要用 runtime 起运行。
    try {
      context.tasks = createTaskBoard({
        ctx,
        store: context.store,
        runtime: context.runtime,
        config,
        log,
      });
      ctx.effect(() => context.tasks.attach(), 'subagent-hub: task board');
    } catch (error) {
      context.tasks = undefined;
      log.warn(`任务清单服务未启用（@ 委派与面板不受影响）：${describeError(error)}`);
    }
  }

  // 路由先挂上：即使上面的初始化失败了，也要能通过 /health 看到原因。
  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createHandler({
      ...context,
      version: VERSION,
      // 存储或运行时缺席时给一个会明确报错的替身，而不是让请求 500 得莫名其妙。
      store: context.store ?? createUnavailableStore(),
      runtime: context.runtime ?? createUnavailableRuntime(),
    }),
  };
  ctx.effect(() => ctx.webServer.register(route), 'subagent-hub: /sub-agent/api route');

  // 模型侧入口（工具 + 提示词注入）。缺服务就只记一条日志，不影响面板。
  const tools = buildTools(context);
  for (const warning of tools.warnings) log.warn(warning);
  ctx.effect(() => tools.install(), 'subagent-hub: model-facing tools and prompt section');

  if (context.store !== undefined) {
    scheduleInterval(ctx, () => prune(context), RETENTION_CHECK_MS);
  }

  log.info(
    `ready: db=${dbPath} maxConcurrent=${config.maxConcurrentRuns} `
    + `timeout=${config.runTimeoutMs}ms transports=${tools.transports.join(',') || '(none)'}`,
  );
}

/**
 * 把插件日志接出去。
 *
 * 为什么必须自己接：DSH 的 logger 默认**没有任何出口**——cordis 只把消息写进一个
 * 1000 条的进程内环形缓冲，仓库里没有任何包注册 exporter，$DSH_HOME 下也没有日志文件。
 * 也就是说，不接这一根线，本插件的所有日志都是写给空气看的。
 *
 * 姿态是「尽力而为」：拿不到 logger、exporter 形状不同、写 stdout 失败，
 * 都只是让日志退回 console，绝不因此让插件起不来。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} config - 插件配置。
 * @param {object} log - 插件 logger（用于报告失败）。
 * @returns {void}
 */
function attachLogSink(ctx, config, log) {
  if (config.logToStdout !== true) return;
  const logger = ctx?.logger;
  if (typeof logger?.exporter !== 'function') return;
  try {
    ctx.effect(() => logger.exporter({
      export: (message) => {
        // **必须过滤**：exporter 是全局的，cordis 会把**所有** logger 的记录都送进来。
        // 不过滤的后果不是「多几行」，而是把别的插件的内部日志灌进用户终端——
        // 真机首次启动时终端里那句 `hmr: watching %o []` 就是别人的日志，与本插件无关。
        if (isOwnMessage(message) !== true) return;
        try {
          process.stdout.write(`${formatLogMessage(message)}\n`);
        } catch {
          /* 输出端断开（比如管道关了）不该影响宿主 */
        }
      },
    }), 'subagent-hub: stdout log sink');
  } catch (error) {
    log.debug(`注册日志出口失败：${describeError(error)}`);
  }
}

/**
 * 宽松序列化（日志绝不该因为一个循环引用而抛错）。
 * @param {unknown} value - 任意值。
 * @returns {string}
 */
function safeStringify(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 用 cordis 定时器（若可用）挂周期任务，否则退回原生 setInterval + ctx.effect 清理。
 * 这样既不硬依赖 timer 插件，也不会在插件卸载后留下定时器。
 * @param {object} ctx - 宿主上下文。
 * @param {Function} callback - 周期回调。
 * @param {number} ms - 周期。
 * @returns {void}
 */
function scheduleInterval(ctx, callback, ms) {
  try {
    if (typeof ctx.interval === 'function') {
      ctx.interval(callback, ms);
      return;
    }
  } catch {
    /* 落到原生实现 */
  }
  ctx.effect(() => {
    const timer = setInterval(callback, ms);
    timer.unref?.();
    return () => { clearInterval(timer); };
  }, 'subagent-hub: retention check');
}

/**
 * 按保留策略清理运行记录。
 * @param {object} context - 插件运行态。
 * @returns {void}
 */
function prune(context) {
  const days = context.config.retentionDays;
  if (!Number.isSafeInteger(days) || days <= 0) return;
  try {
    const removed = context.store.pruneRuns(days);
    if (removed > 0) context.log.info(`保留策略：清理了 ${removed} 条超过 ${days} 天的运行记录`);
  } catch (error) {
    context.log.warn(`清理运行记录失败：${describeError(error)}`);
  }
}

/**
 * 初始化失败时的存储替身：每个方法都抛同一个可读错误，
 * 这样面板拿到的是「为什么不能用」而不是 `undefined is not a function`。
 * @returns {object}
 */
function createUnavailableStore() {
  const fail = () => {
    throw new Error('存储未就绪：请查看 /sub-agent/api/health 的 initError');
  };
  return new Proxy({}, { get: () => fail });
}

/**
 * 初始化失败时的运行时替身。
 * @returns {object}
 */
function createUnavailableRuntime() {
  return {
    snapshot: () => ({ busyCount: 0, activeCount: 0, queuedCount: 0, maxConcurrentRuns: 0, tokPerS: 0, anyEstimated: false, runs: [] }),
    detail: () => undefined,
    cancel: () => false,
    subscribe: () => () => {},
    start: () => ({ ok: false, error: '运行时未就绪：请查看 /sub-agent/api/health 的 initError' }),
    resolveParent: () => ({ error: '运行时未就绪' }),
  };
}
