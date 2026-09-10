/**
 * 客户端 bundle 的离线验证。
 *
 * 为什么要这个脚本：`lib/client.js` 是**手写的单文件 CJS bundle**，没有构建步骤，
 * 因此没有任何东西替你检查它能不能加载。而它恰好是最难现场调试的一块——
 * 出错的表现是「面板就是不出现」，浏览器里只能看到一句无关的报错。
 *
 * 本脚本按 DSH 真实的装配方式执行它：
 *   window.__ModuleLoader__.load({id, factory})  →  取出工厂  →  用真的 React 调工厂
 *   →  检查插件面（apply/inject）  →  用真实的 React SSR 把组件渲染出来
 *
 * 这样能在装进 DSH 之前就抓住「语法没错但加载即崩」这类问题。
 * React 若解析不到（插件源码目录通常没有 node_modules），脚本会降级为
 * 「只做结构与契约检查」，并**如实说明跳过了渲染**，而不是假装通过。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const clientPath = join(root, 'lib', 'client.js');
/** 源码文本（有些断言直接看源码，比如「颜色必须来自主题变量」）。 */
const clientSource = readFileSync(clientPath, 'utf8');

/** 收集失败项；最后统一决定退出码。 */
const failures = [];
/** 收集通过项。 */
const passes = [];
/** 跳过项（带原因）。 */
const skips = [];

/**
 * 断言。
 * @param {boolean} condition - 条件。
 * @param {string} label - 描述。
 * @param {string} [detail] - 失败详情。
 */
function check(condition, label, detail) {
  if (condition) passes.push(label);
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * 尝试解析 React。优先常规解析，其次退到 DSH profile 的 node_modules
 * （插件以 link: 安装时就住在那里旁边）。
 *
 * 关键点：react 与 react-dom **必须来自同一份拷贝**，否则 react-dom 会认为
 * 另一个 React 造出来的 element 是「非法子节点」（`$$typeof` 对不上），
 * 报出与真实问题毫无关系的错误。所以这里先定位 react-dom/server，
 * 再从它自己的位置解析 react —— 这正是 react-dom 内部解析 react 的方式。
 *
 * @returns {{require:Function,compatible:boolean,reason?:string}|undefined}
 */
function resolveReact() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const bases = [
    join(root, 'noop.js'),
    join(home, 'profiles', 'web', 'noop.js'),
    join(home, 'profiles', 'noop.js'),
  ];
  for (const base of bases) {
    try {
      const probe = createRequire(pathToFileURL(base));
      const serverPath = probe.resolve('react-dom/server');
      // 换一个以 react-dom 自身文件为基准的 require：react 会按 react-dom 的
      // 解析路径去找，从而拿到同一份实例。
      const require = createRequire(serverPath);
      const React = require('react');
      const ReactDOMServer = require('react-dom/server');
      // 自证：能渲染一个平凡元素，说明这一对是配套的。
      try {
        ReactDOMServer.renderToStaticMarkup(React.createElement('div', null, 'ok'));
        return { require, compatible: true };
      } catch (error) {
        return { require, compatible: false, reason: error?.message ?? String(error) };
      }
    } catch {
      /* 试下一个基准点 */
    }
  }
  return undefined;
}

/**
 * 造一个最小的 DOM 替身。
 *
 * 只实现本 bundle 真正用到的那几件事（样式标签的创建与挂载、localStorage），
 * 目的是让 `apply()` 能在 Node 里跑完——而不是实现一个 jsdom。
 * @returns {{document:object,localStorage:object,store:Map<string,string>,styles:object[]}}
 */
function makeDomStub() {
  const styles = [];
  const store = new Map();
  const document = {
    getElementById: (id) => styles.find((tag) => tag.id === id) ?? null,
    createElement: () => ({ id: '', dataset: {}, textContent: '', style: {} }),
    head: {
      appendChild(tag) {
        styles.push(tag);
        return tag;
      },
    },
  };
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  return { document, localStorage, store, styles };
}

/**
 * 把 bundle 加载进一个受控的全局环境，返回它的工厂与模块导出。
 * @param {object} globals - 要装上的全局对象。
 * @returns {{exports:object,loadId:string,registration:object}}
 */
function loadBundle(globals) {
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, key in globalThis ? globalThis[key] : undefined);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    let registration;
    globalThis.window = {
      __ModuleLoader__: {
        load(options) {
          if (registration !== undefined) throw new Error(`重复注册：${options?.id}`);
          registration = options;
        },
      },
    };
    // bundle 是 classic script：用同步读取 + 函数构造执行，模拟浏览器的脚本语义。
    const source = readFileSyncCompat(clientPath);
    // eslint-disable-next-line no-new-func
    new Function(source)();
    if (registration === undefined) throw new Error('bundle 没有调用 window.__ModuleLoader__.load()');
    return { registration, restore: () => restore(previous) };
  } catch (error) {
    restore(previous);
    throw error;
  }
}

/** 还原被替换的全局对象。 */
function restore(previous) {
  for (const [key, value] of previous) {
    if (value === undefined) delete globalThis[key];
    else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

/** 读文件：bundle 是 classic script，必须**同步**读取后立即执行。 */
function readFileSyncCompat(path) {
  return readFileSync(path, 'utf8');
}

//#region 主流程

if (!existsSync(clientPath)) {
  console.error(`✖ 找不到 ${clientPath}`);
  process.exit(1);
}

const dom = makeDomStub();
let exports;
let registration;
try {
  const loaded = loadBundle({ document: dom.document, localStorage: dom.localStorage, EventSource: undefined });
  registration = loaded.registration;
  check(registration.id === 'dsh-subagent-hub', '注册 id 与包名一致', `实际 ${registration.id}`);
  check(typeof registration.factory === 'function', 'factory 是一个函数');

  // 工厂只在这里被调用一次——与 DSH 的懒加载语义一致。
  const requireShim = (specifier) => {
    if (specifier === 'react') {
      const react = resolveReact();
      if (react === undefined) throw new Error('React 解析不到');
      return react.require('react');
    }
    throw new Error(`bundle 不该 require("${specifier}")：DSH 只暴露 8 个平台种子模块`);
  };
  exports = registration.factory(requireShim);
  check(typeof exports === 'object' && exports !== null, 'factory 返回模块对象');
} catch (error) {
  failures.push(`加载 bundle 失败：${error?.message ?? error}`);
}

if (exports !== undefined) {
  check(typeof exports.apply === 'function', '导出 apply（cordis 插件面）');
  check(Array.isArray(exports.inject), '导出 inject 数组');
  check(exports.inject?.includes('slots'), 'inject 里有 slots');
  check(exports.inject?.includes('inputTriggers'), 'inject 里有 inputTriggers（@ 源需要）');
  check(exports.endpoint === '/sub-agent/api', '端点常量与宿主一致', `实际 ${exports.endpoint}`);

  // 样式必须在 apply 里注入（bundle 执行阶段只注册工厂，不该有副作用）。
  check(dom.styles.length === 0, 'bundle 执行阶段不产生副作用（样式在 apply 时才插）');

  // 用一个最小的 ctx 跑 apply，验证注册路径不会抛错。
  try {
    const registered = { slots: [], sources: [], locales: [] };
    const ctx = {
      effect: (fn) => fn(),
      locale: { register: (ns, dicts) => { registered.locales.push({ ns, dicts }); return () => {}; } },
      slots: {
        inject: (key, callback) => { callback(); return () => {}; },
        register: (options) => { registered.slots.push(options); return () => {}; },
      },
      get: (name) => (name === 'inputTriggers'
        ? { registerSource: (source) => { registered.sources.push(source); return () => {}; } }
        : undefined),
    };
    // apply 里会触发没有 EventSource 时的 SSE 分支，所以只验证它不抛错。
    exports.apply(ctx);
    check(dom.styles.length === 1, 'apply 注入了一份样式', `实际 ${dom.styles.length}`);
    check(registered.locales.length === 1, '注册了一份词典');
    check(registered.slots.some((slot) => slot.name === 'conversation.input.right'), '注册了输入栏右侧的开关槽位');
    check(registered.slots.some((slot) => slot.name === 'shell.overlay'), '注册了悬浮球槽位');
    check(registered.slots.some((slot) => slot.name === 'settings.section'), '注册了设置里的配置页槽位（需求 3）');

    // 侧栏导航项必须有名字。漏掉 label 不会报错，只会让那一条变成没有文字的图标——
    // 这是在真机上先看到现象、再回来补的检查，所以它必须留在测试里。
    const settingsSlot = registered.slots.find((slot) => slot.name === 'settings.section');
    check(
      typeof settingsSlot?.label === 'function',
      '配置页注册时带了 label（否则侧栏只有图标没有名字）',
      `实际 label=${typeof settingsSlot?.label}`,
    );
    if (typeof settingsSlot?.label === 'function') {
      try {
        const text = settingsSlot.label();
        check(typeof text === 'string' && text.trim() !== '', 'label() 返回了非空文案', `实际 ${JSON.stringify(text)}`);
      } catch (error) {
        failures.push(`label() 抛错：${error?.message ?? error}`);
      }
    }
    check(registered.sources.length === 1, '注册了一个 @ 源');
    const source = registered.sources[0];
    check(source?.trigger === '@', '@ 源的 trigger 是 @');
    check(typeof source?.candidates === 'function' && typeof source?.onPick === 'function', '@ 源有 candidates 与 onPick');
  } catch (error) {
    failures.push(`apply 执行失败：${error?.message ?? error}\n${error?.stack ?? ''}`);
  }

  // 纯函数抽查。
  const internal = exports.__internal ?? {};
  // 时间格式是需求明确指定的四档：25s / 25min / 1h / 1h25m。
  const durationCases = [
    [0, '0s'], [25_000, '25s'], [59_400, '59s'],
    [60_000, '1min'], [25 * 60_000, '25min'], [59 * 60_000 + 59_000, '59min'],
    [60 * 60_000, '1h'], [3600_000 + 25 * 60_000, '1h25m'], [2 * 3600_000, '2h'],
  ];
  for (const [ms, expected] of durationCases) {
    check(
      internal.formatDuration?.(ms) === expected,
      `formatDuration(${ms}) === ${expected}`,
      `实际 ${internal.formatDuration?.(ms)}`,
    );
  }
  // 刻意不进位：秒级精度在一颗圆球里没有决策价值，还会挤坏布局。
  check(internal.formatDuration?.(65_000) === '1min', '不足 1 分钟的部分被舍去（只有 25s/25min/1h/1h25m 四档）');
  check(internal.compactTokens?.(12_345) === '12k', 'compactTokens 正确', `实际 ${internal.compactTokens?.(12_345)}`);
  const zhKeys = Object.keys(internal.dictionaries?.zh ?? {}).sort();
  const enKeys = Object.keys(internal.dictionaries?.en ?? {}).sort();
  check(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英词典键集一致', `${zhKeys} vs ${enKeys}`);
}

// ---- SSR 渲染（需要 React）----
const react = resolveReact();
if (react === undefined) {
  skips.push('解析不到 react / react-dom：跳过了组件渲染验证（用 link: 装机后会在 DSH 的 node_modules 旁，届时可跑）');
} else if (react.compatible !== true) {
  // 这是**验证环境**的问题，不是 bundle 的问题，所以如实归为跳过而不是失败。
  skips.push(`本机解析到的 react 与 react-dom 不配套（${react.reason}）：跳过了组件渲染验证`);
} else if (exports !== undefined) {
  try {
    const React = react.require('react');
    const ReactDOMServer = react.require('react-dom/server');
    const h = React.createElement;

    // 开关：未启用态。
    const toggleOff = ReactDOMServer.renderToStaticMarkup(
      h(exports.ComposerToggle, { sessionId: 's-1', t: (key) => key }),
    );
    check(toggleOff.includes('sbh-toggle'), '开关渲染出容器类名', toggleOff.slice(0, 120));
    check(!toggleOff.includes('sbh-toggle--on'), '未启用时不带启用样式');

    // 开关是**全局**的：不带会话 id 也必须可用。
    // 以前它要求 sessionId 非空、并把状态按会话存，于是新开的对话里开关是关的、
    // 悬浮球整个不渲染 —— 用户看到的就是「其他窗口不显示已经配置了的子 agent」。
    const toggleGlobal = ReactDOMServer.renderToStaticMarkup(h(exports.ComposerToggle, { t: (key) => key }));
    check(!toggleGlobal.includes('disabled'), '开关不依赖会话 id（全局开关）', toggleGlobal.slice(0, 180));
    const toggleTitle = /title="([^"]*)"/.exec(toggleGlobal)?.[1] ?? '';
    check(toggleTitle.includes('对所有对话生效'), '开关的提示写明了它的作用域是全局', toggleTitle);

    // 开关：已启用态（直接驱动内部快照，模拟宿主返回 enabled）。
    const hub = exports.__internal?.hub;
    if (hub !== undefined) {
      globalThis.fetch = async (url) => ({
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes('/state')) {
            return {
              enabled: true,
              agents: [{
                id: 'a1', name: '研究员', modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1-flash',
                toolPolicy: 'inherit', toolPolicyDetail: { policy: 'inherit', enforced: false, summary: '' },
              }],
              catalog: { routes: [], transports: [{ name: 'spawn', supportsModelBinding: true }], credentialRefs: [], warnings: [] },
              runtime: {
                busyCount: 1, activeCount: 1, queuedCount: 0, maxConcurrentRuns: 2, tokPerS: 42.5, anyEstimated: true,
                runs: [{
                  runId: 'r1', sessionId: 'child-1', agentName: '研究员', label: '研究员', status: 'running',
                  busy: true, tokPerS: 42.5, tokPerSEstimated: true, tokensIn: 10, tokensOut: 900,
                  elapsedMs: 5000, steps: 2, turns: 1, tools: 3, outputChars: 400, stopReason: '', error: '',
                  startedAt: Date.now() - 5000, endedAt: null, lastEventAt: Date.now(),
                }],
              },
            };
          }
          return {};
        },
        async text() { return '{}'; },
      });

      await hub.refresh('s-1');
      const toggleOn = ReactDOMServer.renderToStaticMarkup(
        h(exports.ComposerToggle, { sessionId: 's-1', t: (key) => key }),
      );
      check(toggleOn.includes('sbh-toggle--on'), '已启用时带启用样式', toggleOn.slice(0, 160));

      // 收起态：一颗**圆形液体球**，居中三行文字（名字 / tok/s / 时间）。
      const useSessions = (selector) => selector({ current: 's-1' });
      const ball = ReactDOMServer.renderToStaticMarkup(
        h(exports.SubAgentBall, { useSessions }),
      );
      check(ball.includes('sbh-orb'), '收起态渲染出圆形球');
      check(!ball.includes('sbh-card'), '收起态不渲染卡片（只有球）');
      check(ball.includes('研究员'), '圆球显示子 agent 名字（需求 1）');
      check(ball.includes('42.5'), '圆球显示 tok/s（需求 1）');
      check(ball.includes('~42.5'), '估算速率带 ~ 前缀，不把估算当事实', ball.slice(0, 260));
      check(ball.includes('sbh-orb__svg'), '圆球里有 SVG（液体层）');
      check(ball.includes('sbh-orb__wave'), '液体有波形路径');
      check(ball.includes('clipPath'), '液体被裁进圆形里');
      check(ball.includes('sbh-orb__text'), '文字层存在（居中）');
      check(ball.includes('sbh-orb__name') && ball.includes('sbh-orb__rate') && ball.includes('sbh-orb__time'),
        '三行结构齐全：名字 / 速率 / 时间');

      // 圆球本身是纯展示组件，直接喂数据验证各种状态。
      const orbOf = (props) => ReactDOMServer.renderToStaticMarkup(h(exports.OrbView, {
        name: '本地马喽', rateText: '30 tok/s', timeText: '25min',
        ratio: 0.4, stage: 'ok', index: 0, total: 1, busy: true, contextLabel: '', ...props,
      }));
      const orbBusy = orbOf({});
      check(orbBusy.includes('本地马喽') && orbBusy.includes('30 tok/s') && orbBusy.includes('25min'),
        '三行分别显示 名字 / tok/s / 时间', orbBusy.slice(0, 200));
      // 液面高度：水面 y = 100 × (1 − ratio) − 4。
      // 那个 −4 不是随手写的：ratio=1（液面涨满）时水面在 y=-4，正好在球顶之上，
      // 于是满水时仍能看见一条水波棱线，而不是变成一颗纯色球。
      const expectedFillY = Math.round((100 * (1 - 0.4) - 4) * 10) / 10;
      check(
        orbBusy.includes(`translateY(${expectedFillY}px)`),
        `液面高度由 ratio 决定（ratio 0.4 → translateY(${expectedFillY}px)）`,
        orbBusy.match(/translateY\([^)]*\)/)?.[0] ?? '',
      );
      // 液面越高，y 越小（水往上长）——方向反了的话进度条会倒着走。
      check(
        orbOf({ ratio: 0.9 }).includes('translateY(6px)') && orbOf({ ratio: 0.1 }).includes('translateY(86px)'),
        '液面越高 y 越小（水位方向正确）',
      );

      // ---- 三档配色：绿 / 黄 / 红（配色跟随主题）----
      for (const stage of ['ok', 'warn', 'crit']) {
        check(orbOf({ stage }).includes(`sbh-orb--${stage}`), `圆球带 ${stage} 档的类名`);
      }
      check(orbOf({ stage: 'none' }).includes('sbh-orb--none'), '未测量时是中性档');
      // 颜色必须来自主题变量，而不是写死的色值——否则亮色主题下会很难看。
      for (const [stage, varName] of [['ok', 'success'], ['warn', 'warn'], ['crit', 'error']]) {
        const rule = new RegExp(`\\.sbh-orb--${stage} \\.sbh-orb__stop--b\\{[^}]*var\\(--dsw-alias-state-${varName}-primary`);
        check(rule.test(clientSource), `${stage} 档的水色绑定主题变量 --dsw-alias-state-${varName}-primary`);
      }
      check(!/stop-color="#[0-9a-f]{3,6}"/i.test(clientSource), '水中不应再有写死的十六进制色值（应全走主题变量）');
      // 压缩之后占用会突然变小，档位必须由 ratio 现场算出来、能回到绿色。
      check(orbOf({ ratio: 0.2, stage: 'ok' }).includes('sbh-orb--ok')
        && orbOf({ ratio: 0.95, stage: 'crit' }).includes('sbh-orb--crit'),
        '液面与档位由 ratio 驱动（压缩后回落时颜色会跟着变回绿）');

      // ---- 贴边长条（收起态）----
      const stripOf = (props) => ReactDOMServer.renderToStaticMarkup(h(exports.StripView, {
        name: '本地马喽', ratio: 0.7, stage: 'warn', busy: false, contextLabel: '', ...props,
      }));
      const strip = stripOf({});
      check(strip.includes('sbh-strip'), '收起态渲染出长条');
      check(!strip.includes('sbh-orb'), '长条形态下不渲染圆球（不露半个球在边上）');
      check(strip.includes('height:70%'), '长条填充高度 = 占用比例', strip.slice(0, 220));
      check(strip.includes('sbh-strip--warn'), '长条颜色跟随档位');
      check(strip.includes('sbh-strip__cap'), '长条顶部有高光帽');

      // 不知道总量时不能假装精确：走不确定态，上下浮动。
      const orbUnknown = orbOf({ ratio: null });
      check(orbUnknown.includes('sbh-orb__fill--unknown'), '不知道总量时用不确定态（不假装精确进度）');
      // 多个在跑时要有轮播指示点。
      const orbMulti = orbOf({ total: 3, index: 1 });
      check(orbMulti.includes('sbh-orb__dots'), '多个在跑时显示轮播指示点');
      check((orbMulti.match(/sbh-orb__dot(?![-\w])/g) ?? []).length === 0 || orbMulti.includes('sbh-orb__dot--on'),
        '有一个指示点是高亮的');
      check(!orbOf({ total: 1 }).includes('sbh-orb__dots'), '只有一个在跑时不显示指示点（避免无意义闪烁）');
      // 「收起」现在换的是**形态**（圆球 → 长条），而不是给圆球加个类名。
      check(orbOf({ busy: true }).includes('sbh-orb--busy'), '在跑态有对应样式');
      check(orbOf({ busy: false }).includes('sbh-orb--idle'), '空闲态有对应样式');

      // 未启用时悬浮球必须**不渲染**（需求：启用了才展示悬浮球）。
      await hub.refresh('s-2'); // s-2 在假 fetch 里也返回 enabled:true，所以直接改快照来验证关闭态
      const disabledHub = exports.__internal.hub;
      check(typeof disabledHub.setEnabled === 'function', 'hub 暴露 setEnabled');

      // 直接构造关闭态：用一个返回 enabled:false 的 fetch。
      globalThis.fetch = async (url) => ({
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes('/state')) {
            return { enabled: false, agents: [], catalog: { routes: [], transports: [], credentialRefs: [], warnings: [] }, runtime: { runs: [], busyCount: 0, tokPerS: 0, anyEstimated: false, maxConcurrentRuns: 2, queuedCount: 0 } };
          }
          return {};
        },
        async text() { return '{}'; },
      });
      await hub.refresh('s-3');
      const emptyBall = ReactDOMServer.renderToStaticMarkup(h(exports.SubAgentBall, { useSessions: (sel) => sel({ current: 's-3' }) }));
      check(emptyBall === '', '未启用会话不渲染悬浮球（需求 4 的开关语义）', emptyBall.slice(0, 120));

      // ---- 配置页（需求 3）----
      globalThis.fetch = async (url) => ({
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes('/state')) {
            return {
              enabled: false,
              agents: [{
                id: 'a1', name: '研究员', modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1-flash',
                toolPolicy: 'inherit', maxContext: 128000,
                toolPolicyDetail: { policy: 'inherit', enforced: false, summary: '' },
              }],
              catalog: {
                routes: [{
                  id: 'deepseek-official', name: 'DeepSeek', active: true,
                  apiBase: 'https://api.deepseek.com', apiBaseSource: 'settings', credentialRef: 'DEEPSEEK_API_KEY',
                  models: [{ id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' }, { id: 'deepseek-v4.1', name: 'V4.1' }],
                }],
                transports: [{ name: 'spawn', supportsModelBinding: true }, { name: 'fork', supportsModelBinding: false }],
                credentialRefs: ['DEEPSEEK_API_KEY'],
                warnings: [],
              },
              runtime: { runs: [], busyCount: 0, activeCount: 0, queuedCount: 0, maxConcurrentRuns: 2, tokPerS: 0, anyEstimated: false },
            };
          }
          return {};
        },
        async text() { return '{}'; },
      });
      await hub.refresh('s-4');
      const settings = ReactDOMServer.renderToStaticMarkup(h(exports.AgentSettingsPage, { close: () => {}, t: (key) => key }));
      check(settings.includes('sbh-settings'), '配置页渲染出容器');
      check(settings.includes('研究员'), '配置页列出已配置的子 agent');
      check(settings.includes('deepseek-official/deepseek-v4.1-flash'), '配置页显示模型');
      // 关键：maxContext 必须写明它不是模型窗口，否则这个字段就是误导。
      check(settings.includes('不是'), 'maxContext 的说明里点明了「不是模型窗口」', settings.slice(0, 200));
      check(settings.includes('输入预算闸'), 'maxContext 被说明为输入预算闸');
      check(settings.includes('<select'), '下拉使用 select（模型提供商/模型 ID 应为下拉而非手填）');
      // 注意：这里传的 t 是恒等函数，所以标签渲染出来是词典键本身。
      check(settings.includes('field.credentialRef') && settings.includes('不在这里存 key'), '凭据只引用不存 key 这件事写在了界面上');
      // 不支持模型绑定的传输不该出现在下拉里。
      check(!settings.includes('>fork<'), '不支持 agentOptions 的传输被排除在可选列表外');
      check(settings.includes('>spawn<'), '支持模型绑定的传输出现在可选列表里');
      check(settings.includes('sbh-boards'), '配置页里包含了排名/回归区块（需求 5）');

      // 归档按钮必须真的渲染出来——真机上「点了没反应」时，先要能确认这个控件存在。
      check(settings.includes('🗑'), '列表里有归档按钮');
      check(settings.includes('归档（保留历史运行与评价）'), '归档按钮带 title 说明');
      check(settings.includes('已配置（'), '列表显示已配置数量（归档后这个数字应当变化）');
      // ---- 回归：下拉的「显示与状态不一致」----
      //
      // 真机上出现过：模型 ID 下拉**显示着**一个模型，提交却说 `modelId 必填`。
      // 根因是原生 select 在 value 匹配不到 option 时会默默显示第一个选项，
      // 于是状态空着而界面看着已选好——一个状态问题被伪装成了校验问题。
      //
      // 下面既验证纯函数，也把那个失败状态真的渲染出来看。
      const internals = exports.__internal ?? {};
      check(typeof internals.optionsWithCurrent === 'function', '导出了 optionsWithCurrent 以便验证');
      const withCurrent = internals.optionsWithCurrent?.('', [{ value: 'm1', label: 'M1' }], '请选择模型…') ?? [];
      check(withCurrent.length === 2 && withCurrent[0].value === '', '值不在清单里时插入占位项', JSON.stringify(withCurrent));
      check(
        (internals.optionsWithCurrent?.('m1', [{ value: 'm1', label: 'M1' }], 'x') ?? []).length === 1,
        '值在清单里时不插入占位项',
      );
      check(
        String((internals.optionsWithCurrent?.('旧模型', [{ value: 'm1', label: 'M1' }], 'x') ?? [])[0]?.label ?? '').includes('不在当前清单里'),
        '值不在清单里且非空时，文案要说明它不在清单里（而不是假装已选）',
      );

      // 默认路由必须优先选「真的有模型」的那条：真机上 routes 按字母序的第一条
      // （amazon-bedrock，未配置、无模型）被当成了默认，才会造出「有提供商没模型」的表单。
      const noModels = { id: 'amazon-bedrock', name: 'Bedrock', active: false, models: [] };
      const dormant = { id: 'aaa-dormant', name: 'Dormant', active: false, models: [{ id: 'd1', name: 'D1' }] };
      const activeRoute = { id: 'zzz-active', name: 'Active', active: true, models: [{ id: 'a1', name: 'A1' }] };
      check(
        internals.pickDefaultRoute?.([noModels, dormant, activeRoute])?.id === 'zzz-active',
        '默认路由优先选「已激活且有模型」的那条',
      );
      check(
        internals.pickDefaultRoute?.([noModels, dormant])?.id === 'aaa-dormant',
        '没有已激活路由时，退回「有模型」的那条',
      );
      check(internals.pickDefaultRoute?.([noModels]) === undefined, '全都没有模型时不给默认路由');
      check(internals.firstModelOf?.(activeRoute) === 'a1', 'firstModelOf 取第一条模型');
      check(internals.firstModelOf?.(noModels) === '', '没有模型时 firstModelOf 返回空串');

      // 渲染层面的实证：把表单置成「提供商有模型、但 modelId 不匹配」，下拉必须显式说明。
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            enabled: false,
            agents: [],
            catalog: {
              routes: [noModels, activeRoute],
              transports: [{ name: 'spawn', supportsModelBinding: true }],
              credentialRefs: [],
              warnings: [],
            },
            runtime: { runs: [], busyCount: 0, activeCount: 0, queuedCount: 0, maxConcurrentRuns: 2, tokPerS: 0, anyEstimated: false },
          };
        },
        async text() { return '{}'; },
      });
      await hub.refresh('s-5');
      const misaligned = ReactDOMServer.renderToStaticMarkup(h(exports.AgentSettingsPage, {
        close: () => {},
        t: (key) => key,
        initialForm: { modelProvider: 'zzz-active', modelId: 'A1-but-wrong' },
      }));
      check(misaligned.includes('不在当前清单里'), '模型 ID 与提供商不匹配时，界面必须显式说明（而不是默默显示第一个选项）');

      const aligned = ReactDOMServer.renderToStaticMarkup(h(exports.AgentSettingsPage, {
        close: () => {},
        t: (key) => key,
        initialForm: { modelProvider: 'zzz-active', modelId: 'a1' },
      }));
      check(!aligned.includes('不在当前清单里'), '匹配时不出现「不在清单里」的提示');

      // ---- 详情页（需求 2）----
      globalThis.fetch = async (url) => ({
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes('/detail')) {
            return {
              source: 'live',
              run: { id: 'r1', agentName: '研究员', sessionId: 'child-9', prompt: '查一下 X', outputTail: '' },
              live: {
                runId: 'r1', sessionId: 'child-9', agentName: '研究员', label: '研究员', status: 'running', busy: true,
                tokPerS: 31.2, tokPerSEstimated: false, tokensIn: 12, tokensOut: 500, elapsedMs: 9000,
                steps: 2, turns: 1, tools: 2, outputChars: 20, stopReason: '', error: '', startedAt: Date.now() - 9000,
                endedAt: null, lastEventAt: Date.now(), input: '查一下 X', reasoning: '', calibrated: true,
                charsPerToken: 3.1, tools: [{ seq: 1, name: 'grep', callId: 'c1', at: Date.now(), done: true, isError: false }],
              },
              outputDelta: '已经查到了一部分结论……',
              outputLength: 20,
              reset: false,
              serverNow: Date.now(),
            };
          }
          return {};
        },
        async text() { return '{}'; },
      });
      // 用 props 直接喂真实负载渲染纯展示组件。
      // （SSR 不执行 useEffect，所以取数容器在这里只能验证初始态；纯展示组件才是渲染逻辑的真正验证点。）
      const detailHtml = ReactDOMServer.renderToStaticMarkup(h(exports.RunDetailView, {
        runId: 'r1',
        onBack: () => {},
        onCancel: () => {},
        cancelling: false,
        t: (key) => key,
        detail: {
          source: 'live',
          error: null,
          output: '已经查到了一部分结论……',
          live: {
            runId: 'r1', sessionId: 'child-9', agentName: '研究员', label: '研究员', status: 'running', busy: true,
            tokPerS: 31.2, tokPerSEstimated: false, tokensIn: 12, tokensOut: 500, elapsedMs: 9000,
            steps: 2, turns: 1, tools: 1, outputChars: 13, stopReason: '', error: '', startedAt: Date.now() - 9000,
            endedAt: null, lastEventAt: Date.now(), input: '查一下 X', reasoning: '', calibrated: true,
            charsPerToken: 3.1, tools: [{ seq: 1, name: 'grep', callId: 'c1', at: Date.now(), done: true, isError: false }],
          },
          run: { id: 'r1', agentName: '研究员', sessionId: 'child-9', prompt: '查一下 X', outputTail: '' },
        },
      }));
      check(detailHtml.includes('sbh-detail'), '详情页渲染出容器');
      check(detailHtml.includes('子会话 id'), '详情页显示会话 id 的标签（需求 2 的第一问）');
      check(detailHtml.includes('child-9'), '详情页显示子会话 id 本身');
      check(detailHtml.includes('查一下 X'), '详情页显示输入');
      check(detailHtml.includes('已经查到了一部分结论'), '详情页显示实时输出');
      check(detailHtml.includes('31.2'), '详情页显示 tok/s');
      check(detailHtml.includes('grep'), '详情页显示工具活动');
      check(detailHtml.includes('←'), '详情页有返回按钮');
      check(detailHtml.includes('取消'), '运行中时详情页有取消按钮');

      // ---- 排名与回归（需求 5）----
      const boardsHtml = ReactDOMServer.renderToStaticMarkup(h(exports.BoardsView, {
        error: null,
        leaderboard: [
          { agentId: 'a1', agentName: '研究员', modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1-flash', runs: 4, completed: 4, failed: 0, evaluations: 3, avgScore: 82.5, successRate: 1, avgTokPerS: 40.2, avgDurationMs: 5000, tokensOut: 9000, archived: false },
          { agentId: 'a2', agentName: '审核员', modelProvider: 'deepseek-official', modelId: 'deepseek-v4.1', runs: 2, completed: 1, failed: 1, evaluations: 1, avgScore: 55, successRate: 0.5, avgTokPerS: 20, avgDurationMs: 8000, tokensOut: 3000, archived: false },
          { agentId: 'a3', agentName: '没用过', modelProvider: 'p', modelId: 'm', runs: 0, completed: 0, failed: 0, evaluations: 0, avgScore: null, successRate: null, avgTokPerS: null, avgDurationMs: null, tokensOut: 0, archived: false },
        ],
        regression: [{
          taskKey: '同一个任务', agentId: 'a1', agentName: '研究员',
          rounds: [
            { roundId: 'round-1', avgScore: 80, evaluations: 1, runs: 1, deltaVsPrevious: null },
            { roundId: 'round-2', avgScore: 60, evaluations: 1, runs: 1, deltaVsPrevious: -20 },
          ],
          overallDelta: -20,
        }],
      }));
      check(boardsHtml.includes('82.5'), '排名表显示均分');
      check(boardsHtml.includes('100%') && boardsHtml.includes('50%'), '排名表显示成功率');
      check(boardsHtml.includes('sbh-table__rank'), '排名表有序号列');
      check(!boardsHtml.includes('没用过'), '没有任何运行/评价的 agent 不出现在排名里');
      check(boardsHtml.includes('sbh-delta--down') && boardsHtml.includes('-20'), '回归表标出退步 20 分');
      check(boardsHtml.includes('同一个任务'), '回归表显示 task_key');

      // ---- 运行护栏（并发上限必须能改，不能写死）----
      const guardsHtml = ReactDOMServer.renderToStaticMarkup(h(exports.RunGuardsView, {
        t: (key) => key,
        items: [
          { key: 'maxConcurrentRuns', value: 2, type: 'positiveInt', live: true, label: '最大并发运行数', hint: '同时最多有几个子 agent 在跑。' },
          { key: 'readonlyToolAllow', value: [], type: 'stringArray', live: true, label: '只读策略白名单', hint: '每行一个工具名。' },
          { key: 'logToStdout', value: true, type: 'boolean', live: false, label: '日志输出到 stdout', hint: '日志出口在挂载时注册。' },
          { key: 'dbPath', value: '', type: 'string', live: false, label: '数据库路径', hint: '启动时就打开了。' },
        ],
        userConfigPath: '<DSH_HOME>/subagent-hub/config.json',
        queued: 3,
        draft: { maxConcurrentRuns: 4, readonlyToolAllow: ['read', 'glob'], logToStdout: true, dbPath: '' },
        errors: [],
        saving: false,
        notice: '',
        onDraft: () => {},
        onSave: () => {},
        onReset: () => {},
      }));
      check(guardsHtml.includes('sbh-guards'), '运行护栏区块渲染出来');
      check(guardsHtml.includes('最大并发运行数'), '并发上限出现在界面上（用户要求可改，不能写死）');
      check(guardsHtml.includes('value="4"'), '并发上限显示的是草稿值（可编辑）');
      check(guardsHtml.includes('tool_allow') === false && guardsHtml.includes('只读策略白名单'), '白名单项渲染为多行文本');
      check(guardsHtml.includes('需重启'), '不可热改的项标注「需重启」，而不是假装能改');
      check(guardsHtml.includes('disabled'), '不可热改的输入被禁用');
      check(guardsHtml.includes('排队中 3'), '显示排队数量（调大并发后能立刻看到变化）');
      check(guardsHtml.includes('config.json'), '显示配置文件路径，方便去改不可热改的项');

      // ---- 已归档列表与恢复入口 ----
      // 归档是一键的，恢复如果只能靠命令行，这个不对称本身就是陷阱
      // （真机上用户就是这么把四个配置全点进归档的）。所以必须有看得见的回头路。
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            enabled: false,
            agents: [],
            archivedAgents: [{
              id: 'gone-1', name: '被归档的', modelProvider: 'deepseek-official', modelId: 'deepseek-v4-flash',
              toolPolicy: 'inherit', maxContext: 0,
              toolPolicyDetail: { policy: 'inherit', enforced: false, summary: '' },
            }],
            catalog: { routes: [], transports: [], credentialRefs: [], warnings: [] },
            runtime: { runs: [], busyCount: 0, activeCount: 0, queuedCount: 0, maxConcurrentRuns: 2, tokPerS: 0, anyEstimated: false },
          };
        },
        async text() { return '{}'; },
      });
      await hub.refresh('s-6');
      const withArchived = ReactDOMServer.renderToStaticMarkup(h(exports.AgentSettingsPage, { close: () => {}, t: (key) => key }));
      check(withArchived.includes('被归档的'), '已归档的 agent 仍然可见（归档不是删除）');
      check(withArchived.includes('可以恢复'), '已归档区块说明这些是可以恢复的');
      check(withArchived.includes('>恢复<'), '已归档的每一项都有恢复按钮');
    } else {
      failures.push('__internal.hub 缺失：无法验证启用态渲染');
    }
  } catch (error) {
    failures.push(`SSR 渲染失败：${error?.message ?? error}\n${error?.stack ?? ''}`);
  }
}

// ---- 结果 ----
console.log(`\n客户端 bundle 验证：${passes.length} 项通过，${failures.length} 项失败，${skips.length} 项跳过\n`);
for (const label of passes) console.log(`  ✔ ${label}`);
for (const label of skips) console.log(`  ⚠ 跳过：${label}`);
for (const label of failures) console.log(`  ✖ ${label}`);
console.log('');

if (failures.length > 0) process.exit(1);
//#endregion
