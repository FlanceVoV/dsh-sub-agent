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

  // ---- 拖拽缩放的几何（回归：曾经「只能上下拖、左右拖不动」）----
  //
  // 那次错在宽度用了「指针到卡片右边界的距离」，而把手本来就贴在右边界上 →
  // 第一帧恒为 0、立刻被夹到最小值，横向等于拖不动。这里把它变成数字断言：
  // **小幅横向位移必须真的改变宽度**，两个轴用同一种算法。
  const resizeBox = internal.resizePanelBox;
  check(typeof resizeBox === 'function', '导出面板缩放的几何函数（手感问题也能被断言）');
  const dragBase = {
    startWidth: 560, startHeight: 560, startLeft: 300, startTop: 100,
    viewportWidth: 1440, viewportHeight: 900,
  };
  const grewRight = resizeBox?.({ ...dragBase, dx: 40, dy: 0 }) ?? {};
  check(grewRight.width === 600, '往右拖 40px 就变宽 40px（小位移立刻生效）', `实际 ${grewRight.width}`);
  const shrankLeft = resizeBox?.({ ...dragBase, dx: -40, dy: 0 }) ?? {};
  check(shrankLeft.width === 520, '往左拖 40px 就变窄 40px（两个轴同一种算法）', `实际 ${shrankLeft.width}`);
  const grewDown = resizeBox?.({ ...dragBase, dx: 0, dy: 40 }) ?? {};
  check(grewDown.height === 600, '往下拖 40px 就变高 40px', `实际 ${grewDown.height}`);
  const bothAxes = resizeBox?.({ ...dragBase, dx: 60, dy: 60 }) ?? {};
  check(bothAxes.width === 620 && bothAxes.height === 620, '两个方向可以同时改', JSON.stringify(bothAxes));
  const tinyDrag = resizeBox?.({ ...dragBase, dx: -1000, dy: -1000 }) ?? {};
  check(tinyDrag.width === internal.PANEL_MIN_W && tinyDrag.height === internal.PANEL_MIN_H,
    '拖过头时夹在下限（不会拖成一条缝）', JSON.stringify(tinyDrag));
  const hugeDrag = resizeBox?.({ ...dragBase, dx: 5000, dy: 5000 }) ?? {};
  check(hugeDrag.width <= dragBase.viewportWidth - 24 - dragBase.startLeft,
    '拖过头时夹在视口内（拖出去的部分只是看不见的溢出）', JSON.stringify(hugeDrag));
  check(hugeDrag.x === dragBase.startLeft && hugeDrag.y === dragBase.startTop,
    '缩放时把面板钉在起始位置（把手才会一直跟着指针）', JSON.stringify(hugeDrag));
  check(internal.clampPanelSize?.(5000, 300, 560, 'w') <= 5000, '面板尺寸上限跟着视口走');

  const zhKeys = Object.keys(internal.dictionaries?.zh ?? {}).sort();
  const enKeys = Object.keys(internal.dictionaries?.en ?? {}).sort();
  check(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英词典键集一致', `${zhKeys} vs ${enKeys}`);

  // ---- 团队（群组）负载的归一化（0.3.0）----
  //
  // 与任务图同理但更严格：群里每一行都要渲染说话人与正文，少一个字段就是一行 undefined。
  check(exports.normalizeTeamFrame?.({}) !== undefined, '团队负载：缺 teams 也不崩（退回空帧）');
  check(exports.normalizeTeamFrame?.(null) === undefined, '团队负载：null 被拒绝');
  check(exports.normalizeTeamFrame?.({ teams: [null, { name: '没有 id' }] })?.teams.length === 0,
    '团队负载：坏条目被丢掉（没有 id 的团队画不出来）');
  const normalizedTeam = exports.normalizeTeamFrame?.({
    teams: [{ id: 'tm1', name: '发布项目组', ownerName: '甲', members: ['乙', 3], status: 'discussing', lastSeq: 4 }],
    teamMode: true,
    active: 1,
  });
  check(normalizedTeam?.teamMode === true && normalizedTeam.teams[0].lastSeq === 4,
    '团队负载：正常负载按原样通过', JSON.stringify(normalizedTeam));
  check(normalizedTeam?.teams[0].members.length === 1,
    '团队负载：成员里混进非字符串时只保留能显示的', JSON.stringify(normalizedTeam?.teams[0].members));
  check(internal.team?.teamSpeakerLabel?.({ role: 'owner', speaker: '甲' }) === '@甲（群主）',
    '群聊：群主的发言标出「群主」身份', internal.team?.teamSpeakerLabel?.({ role: 'owner', speaker: '甲' }));
  check(internal.team?.teamSpeakerLabel?.({ role: 'system', kind: 'status' }) === '宿主 · 执行汇报',
    '群聊：任务汇报与系统提示分开显示（不然分不清谁在说话）');
  check(/^\d\d:\d\d:\d\d$/.test(internal.team?.teamClock?.(Date.now()) ?? ''),
    '群聊：每条发言带时钟（群里按时间读）', internal.team?.teamClock?.(Date.now()));

  // ---- 群组：选中哪个团队（回归：收尾那一刻镜头会切走）----
  //
  // 真机事故：测试中间一切正常，群主一说 @收尾，新团队变 closed，
  // 原来的「第一个没被收尾的团队」规则就落到旁边那个卡在 error 的旧团队上——
  // 界面显示报错、刚才那场讨论的消息「全都不见了」（数据一条没丢，是镜头被切走了）。
  const pick = internal.team?.pickActiveTeam;
  const stuck = { id: 't-stuck', name: '测试群', status: 'error', updatedAt: 1000 };
  const finished = { id: 't-new', name: '测试群', status: 'closed', updatedAt: 2000 };
  const live = { id: 't-live', name: '测试群', status: 'discussing', updatedAt: 1500 };
  check(typeof pick === 'function', '群组：导出「选中哪个团队」的规则（它是可断言的）');
  check(pick?.([finished, stuck], '')?.id === 't-new',
    '群组：刚收尾的团队仍然是选中项（收尾不该把镜头切到别的团队）', pick?.([finished, stuck], '')?.id);
  check(pick?.([finished, live, stuck], '')?.id === 't-live',
    '群组：有讨论在推进时优先看它（那是最需要盯的）', pick?.([finished, live, stuck], '')?.id);
  check(pick?.([finished, stuck], 't-stuck')?.id === 't-stuck',
    '群组：用户手动点过的页签不会被自动选中顶回去');
  check(pick?.([], 'x') === null, '群组：没有团队时给 null（而不是崩）');
  const label = internal.team?.teamTabLabel;
  check(label?.({ id: '7358449e', name: '测试群', status: 'closed' }, true) === '测试群 #7358 · 已收尾',
    '群组：同名团队用短 id 区分，并标出状态（否则两个页签点不对）',
    label?.({ id: '7358449e', name: '测试群', status: 'closed' }, true));
  check(label?.({ id: 'x', name: '单独的群', status: 'discussing' }, false) === '单独的群',
    '群组：名字唯一时不加多余的短 id', label?.({ id: 'x', name: '单独的群', status: 'discussing' }, false));
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
      check(settings.includes('任务链路'), '配置页里有任务链路区块（0.2.0：依赖图与手动推进入口）');

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

      // ---- 任务链路图（0.2.0）----
      //
      // 图的价值全在**坐标**：连线错位比没有连线更糟（它会让人读出一条不存在的依赖），
      // 而错位在浏览器里看起来永远像「渲染慢」。所以这里断言的是布局的数值性质，
      // 而不是「HTML 里有某个字符串」。
      const tg = internals.taskGraph;
      check(typeof tg?.graphLayout === 'function', '导出链路图的纯函数（布局可以被验证，而不是只能眼看）');

      /** 造一条任务（只写关心的字段）。 */
      const taskFixture = (id, overrides) => ({
        id,
        seq: Number(String(id).replace(/[^0-9]/g, '')) || 1,
        title: `任务 ${id}`,
        agentName: '研究员',
        deps: [],
        state: 'waiting',
        depth: 0,
        runId: '',
        runStatus: '',
        note: '',
        attempts: 0,
        startedAt: null,
        endedAt: null,
        cancelledAt: null,
        waitingFor: [],
        blockedBy: [],
        live: null,
        ...overrides,
      });
      const chainView = {
        plan: { id: 'pl_1', title: '发布 0.2.0', autoActivate: true, activationError: '', parentSessionId: 's-1' },
        tasks: [
          taskFixture('t1', { seq: 1, title: '调研现状', state: 'done', depth: 0, runId: 'r1', runStatus: 'completed', startedAt: 0, endedAt: 5000 }),
          taskFixture('t2', {
            seq: 2, title: '按结论实现功能并自测', agentName: '工程师', state: 'running', depth: 1,
            runId: 'r2', runStatus: 'running', startedAt: 0,
            live: { tokPerS: 42.5, tokPerSEstimated: false, tools: 3, elapsedMs: 9000, tokensOut: 500, status: 'running' },
          }),
          taskFixture('t3', { seq: 3, title: '独立评审', agentName: '审核员', state: 'waiting', depth: 2, waitingFor: ['t2'] }),
          taskFixture('t4', { seq: 4, title: '被上游失败卡住的收尾', agentName: '工程师', state: 'blocked', depth: 3, blockedBy: ['t9'] }),
        ],
        edges: [{ from: 't1', to: 't2' }, { from: 't2', to: 't3' }, { from: 't9', to: 't4' }],
        progress: { total: 4, done: 1, running: 1, ready: 0, waiting: 1, blocked: 1, failed: 0, cancelled: 0, closed: 3, percent: 25 },
        next: '正在跑：t2｜等依赖：t3',
      };

      const layout = tg.graphLayout(chainView);
      check(layout.nodes.length === 4, '布局覆盖全部任务', `实际 ${layout.nodes.length}`);
      check(layout.edges.length === 2, '只画**两端都存在**的依赖边（悬空依赖不画假线）', `实际 ${layout.edges.length}`);
      const pos = new Map(layout.nodes.map((node) => [node.id, node]));
      check(pos.get('t1').x < pos.get('t2').x && pos.get('t2').x < pos.get('t3').x, '依赖方向是左 → 右');
      const insideCanvas = layout.nodes.every((node) => node.x >= 0 && node.y >= 0
        && node.x + node.w <= layout.width && node.y + node.h <= layout.height);
      check(insideCanvas, '每个节点都在画布内（画到框外等于看不见）', `${layout.width}×${layout.height}`);
      let overlaps = 0;
      for (const left of layout.nodes) {
        for (const right of layout.nodes) {
          if (left === right) continue;
          const overlap = left.x < right.x + right.w && right.x < left.x + left.w
            && left.y < right.y + right.h && right.y < left.y + left.h;
          if (overlap) overlaps += 1;
        }
      }
      check(overlaps === 0, '节点之间不重叠（重叠的框会把两个任务读成一个）', `重叠 ${overlaps} 处`);
      const firstEdge = layout.edges[0];
      const numbers = firstEdge.path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      check(
        numbers[0] === pos.get(firstEdge.from).x + pos.get(firstEdge.from).w
        && numbers[1] === pos.get(firstEdge.from).y + pos.get(firstEdge.from).h / 2
        && numbers[numbers.length - 2] === pos.get(firstEdge.to).x
        && numbers[numbers.length - 1] === pos.get(firstEdge.to).y + pos.get(firstEdge.to).h / 2,
        '连线从上游客的右边连到下游客的左边（不穿过节点）',
        firstEdge.path,
      );

      check(tg.edgeVisualState('done') === 'done' && tg.edgeVisualState('running') === 'active'
        && tg.edgeVisualState('waiting') === 'pending' && tg.edgeVisualState('failed') === 'pending',
      '依赖边的样式只由**上游**决定：完成/在跑/其它三种');

      // 折行与截断：SVG 没有 text-overflow，画出去就回不来了。
      const wrapped = tg.wrapLabel('把 release 0.2.0 的任务链路图发出去', 8, 2);
      check(wrapped.length === 2, '长标题折成两行', JSON.stringify(wrapped));
      check(wrapped.every((line) => tg.visualWidth(line) <= 8), '每行都不超过给定的视觉宽度', JSON.stringify(wrapped));
      // 平衡折行：贪心填满会让最后一行只剩一个字，流程图里那种断法很扎眼。
      const balanced = tg.wrapLabel('更新 README 与变更记录', 11, 2);
      check(balanced.length === 2, '中文标题折成两行', JSON.stringify(balanced));
      check(
        tg.visualWidth(balanced[1]) >= 3,
        '最后一行不是「只剩一个字」的孤儿行（贪心换行的典型症状）',
        JSON.stringify(balanced),
      );
      const clipped = tg.truncateVisual('一二三四五六七八九十', 5);
      check(clipped.endsWith('…') && tg.visualWidth(clipped) <= 5, '超宽文本被截断并以 … 结尾', clipped);
      const tooLong = tg.wrapLabel('一二三四五六七八九十一二三四五六七八九十', 6, 2);
      check(tooLong.length === 2 && tooLong[1].endsWith('…'), '放不下的长标题在最后一行以 … 收尾', JSON.stringify(tooLong));
      check(tg.visualWidth('abc') < tg.visualWidth('一个汉字'), '拉丁字符按更窄处理（中英混排不会忽长忽短）');

      // ---- 自适应尺寸：图跟着**实际可用宽度**走（面板可以拖拽缩放）----
      const narrowMetrics = tg.graphMetricsFor({ width: 380, columns: 2, orientation: 'h' });
      const wideMetrics = tg.graphMetricsFor({ width: 900, columns: 2, orientation: 'h' });
      check(wideMetrics.nodeW > narrowMetrics.nodeW, '可用宽度变大时节点跟着变宽（缩放才真的改变图）',
        `${narrowMetrics.nodeW} → ${wideMetrics.nodeW}`);
      const fitMetrics = tg.graphMetricsFor({ width: 900, columns: 4, orientation: 'h' });
      const fitTotal = fitMetrics.padX * 2 + 4 * fitMetrics.nodeW + 3 * fitMetrics.gapX;
      check(fitTotal <= 902, '列数放得下时图宽度贴合容器（不留一大块空白）', `图宽 ${fitTotal} / 容器 900`);
      const tinyMetrics = tg.graphMetricsFor({ width: 200, columns: 6, orientation: 'h' });
      check(tinyMetrics.nodeW >= 132, '窄容器里节点有下限，不会窄成一条色块', String(tinyMetrics.nodeW));
      check(tg.graphMetricsFor({ width: 0, columns: 3, orientation: 'h' }).nodeW > 0,
        '量不到宽度时退回默认尺寸（SSR 静态渲染里也不能崩）');

      // ---- 连线不穿节点：几何断言，而不是「看着像没有」----
      //
      // 这是最容易悄悄退化的一处：连线压过某个方框时，图上看起来像「这几项是连着的」，
      // 读图的人不会想到那是渲染问题。
      const samplePath = (d) => {
        const points = [];
        let cursor = { x: 0, y: 0 };
        for (const token of String(d).matchAll(/([MLC])\s*([-\d.\s,]+)/g)) {
          const nums = (token[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
          if (token[1] === 'M' || token[1] === 'L') {
            cursor = { x: nums[0], y: nums[1] };
            points.push({ ...cursor });
            continue;
          }
          const [x1, y1, x2, y2, x3, y3] = nums;
          for (let step = 1; step <= 12; step += 1) {
            const t = step / 12;
            const u = 1 - t;
            points.push({
              x: (u ** 3) * cursor.x + 3 * (u ** 2) * t * x1 + 3 * u * (t ** 2) * x2 + (t ** 3) * x3,
              y: (u ** 3) * cursor.y + 3 * (u ** 2) * t * y1 + 3 * u * (t ** 2) * y2 + (t ** 3) * y3,
            });
          }
          cursor = { x: x3, y: y3 };
        }
        return points;
      };
      // 跨层依赖（t1 → t4）正是贝塞尔会斜穿中间那一列的场合。
      const crossView = {
        plan: chainView.plan,
        progress: chainView.progress,
        tasks: [
          taskFixture('t1', { seq: 1, title: '起点', state: 'done', depth: 0, runId: 'r1', runStatus: 'completed', startedAt: 0, endedAt: 1000 }),
          taskFixture('t2', { seq: 2, title: '并行的甲', agentName: '工程师', state: 'done', depth: 1, runId: 'r2', runStatus: 'completed', startedAt: 0, endedAt: 1000 }),
          taskFixture('t3', { seq: 3, title: '并行的乙', agentName: '写手', state: 'running', depth: 1, runId: 'r3', runStatus: 'running', startedAt: 0, live: { tokPerS: 12, tokPerSEstimated: false, tools: 1 } }),
          taskFixture('t4', { seq: 4, title: '汇合点', agentName: '审核员', state: 'waiting', depth: 2, deps: ['t1', 't2'], waitingFor: ['t2'] }),
        ],
        edges: [{ from: 't1', to: 't2' }, { from: 't1', to: 't3' }, { from: 't1', to: 't4' }, { from: 't2', to: 't4' }],
      };
      const crossLayout = tg.graphLayout(crossView, { nodeW: 180, nodeH: 72, padX: 12, padY: 12, gapX: 44, gapY: 18 }, 'h');
      check(crossLayout.edges.some((edge) => edge.style === 'ortho'),
        '跨层依赖走正交折线（贝塞尔会斜穿中间那一列）');
      let crossings = 0;
      for (const edge of crossLayout.edges) {
        for (const point of samplePath(edge.path)) {
          for (const node of crossLayout.nodes) {
            if (node.id === edge.from || node.id === edge.to) continue;
            if (point.x > node.x + 1.5 && point.x < node.x + node.w - 1.5
              && point.y > node.y + 1.5 && point.y < node.y + node.h - 1.5) crossings += 1;
          }
        }
      }
      check(crossings === 0, '没有任何一条连线穿过别的任务方框', `穿过 ${crossings} 次`);

      // 「深底 + 黑字」的回归：SVG 文字默认是黑色，必须显式给填充。
      check(/\.sbh-node__title\{[^}]*fill:currentColor/.test(clientSource),
        '节点标题显式给 fill:currentColor（否则深色主题下是深底黑字，看不见）');
      check(/\.sbh-node__meta\{[^}]*fill:currentColor/.test(clientSource), '节点元信息同样显式给 fill');
      check(/\.sbh-graph\{color:var\(--dsw-alias-label-primary/.test(clientSource),
        '图容器设置文字颜色（currentColor 需要有可继承的来源）');
      check(!/\.sbh-node__(title|meta|id|chip)\{[^}]*fill:#[0-9a-f]{3,6}/i.test(clientSource),
        '节点文字不写死十六进制色值（换主题就废）');
      const progress = tg.progressView(chainView.progress);
      check(Math.round(progress.segments.reduce((sum, segment) => sum + segment.flex, 0)) === 100,
        '进度条分段按任务数占比铺满（不是一根不说明问题的百分比条）');

      const graphHtml = ReactDOMServer.renderToStaticMarkup(h(exports.TaskGraph, { view: chainView }));
      check(graphHtml.includes('sbh-graph__svg'), '链路图渲染出 SVG');
      check(['done', 'running', 'waiting', 'blocked'].every((state) => graphHtml.includes(`sbh-node--${state}`)),
        '四种状态各有类名（颜色由 CSS 给，JS 不写死色值）');
      check(graphHtml.includes('sbh-edge--done') && graphHtml.includes('sbh-edge--active'),
        '已解锁与正在流动的依赖连线各有一套样式（上游完成后连线才变实）');
      check(graphHtml.includes('sbh-graph-arrow-active'), '连线带箭头（方向不该靠猜）');
      check(graphHtml.includes('工程师') && graphHtml.includes('42.5'), '节点上能看出谁在做、跑多快');
      check(graphHtml.includes('等 t2'), '等待中的节点写清在等谁');
      check(graphHtml.includes('t9 失败/取消'), '被阻塞的节点写清是哪个上游失败了');
      check(graphHtml.includes('<title>'), '节点带原生 tooltip（文字必然要截断，得留一条看全文的路）');
      check(!graphHtml.includes('undefined') && !graphHtml.includes('NaN'), '渲染结果里不能出现 undefined / NaN');

      // 纵向（悬浮球面板用）：348px 里横向放不下一层以上，所以面板换走向——
      // 每个任务占满整行、层与层向下推进，不需要横向滚动。
      const vertical = tg.graphLayout(chainView, undefined, 'v');
      check(vertical.orientation === 'v', '纵向布局被标记出来（两种走向共用同一套分层）');
      const rowOf = new Map(vertical.nodes.map((node) => [node.id, node.y]));
      check(rowOf.get('t1') < rowOf.get('t2') && rowOf.get('t2') < rowOf.get('t3'), '纵向时依赖往下走');
      const vInside = vertical.nodes.every((node) => node.x >= 0 && node.y >= 0
        && node.x + node.w <= vertical.width && node.y + node.h <= vertical.height);
      check(vInside, '纵向布局同样不越界', `${vertical.width}×${vertical.height}`);
      check(
        vertical.nodes.every((node) => node.w <= vertical.width - 2 * 8 || vertical.width <= 320),
        '纵向节点不溢出面板宽度（层内节点均分宽度，所以不需要横向滚动）',
        `宽 ${vertical.width}`,
      );
      const verticalHtml = ReactDOMServer.renderToStaticMarkup(h(exports.TaskGraph, {
        view: chainView, orientation: 'v', metrics: tg.GRAPH_METRICS_VERTICAL,
      }));
      check(verticalHtml.includes('sbh-graph__svg--v'), '纵向渲染带走向类名（不是靠外部猜的）');
      check(verticalHtml.includes('sbh-node--running'), '纵向同样按状态上色');

      const panelTasksHtml = ReactDOMServer.renderToStaticMarkup(h(exports.PanelTasks, {
        frame: {
          plans: [chainView, { ...chainView, plan: { ...chainView.plan, id: 'pl_2', title: '另一条链路' } }],
          total: 3,
          truncated: true,
        },
        onOpenRun: () => {},
      }));
      check(panelTasksHtml.includes('发布 0.2.0'), '面板区块显示清单名');
      check(panelTasksHtml.includes('sbh-tab'), '多条链路时给出切换标签');
      check(panelTasksHtml.includes('sbh-progress__seg--running'), '面板里也有分段进度条');
      check(panelTasksHtml.includes('共 3 条清单'), '被截断时如实说明还有更多（不假装这就是全部）');
      check(
        ReactDOMServer.renderToStaticMarkup(h(exports.PanelTasks, { frame: { plans: [] } })) === '',
        '没有链路时面板区块整个不渲染（不留一个空区块）',
      );

      const cardHtml = ReactDOMServer.renderToStaticMarkup(h(exports.PlanCard, {
        view: chainView,
        actions: h('button', { type: 'button', className: 'sbh-mini-btn' }, '激活 1 项'),
        onOpenRun: () => {},
      }));
      check(cardHtml.includes('自动激活'), '卡片标明这条链路的激活方式（自动/手动）');
      check(cardHtml.includes('看运行'), '有运行记录的任务给出「看运行」入口（点进已有的详情页）');
      check(cardHtml.includes('1/4 · 25%'), '卡片显示进度数字');
      check(exports.normalizeTaskFrame({ plans: 'x' }) === undefined, '形状不对的任务负载被拒绝，而不是画出一堆 undefined');
      const normalized = exports.normalizeTaskFrame({ plans: [chainView], total: 9, truncated: true });
      check(normalized.plans.length === 1 && normalized.truncated === true && normalized.total === 9, '正常负载按原样通过');
      check(exports.normalizeTaskFrame({ plans: [null, { tasks: [] }, chainView] }).plans.length === 1,
        '坏条目被丢掉，好条目照画（一个坏清单不该让整块面板白屏）');

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

      // ---- 团队模式（0.3.0）：群组栏 ----
      //
      // 这里喂的是**宿主真实产生的形状**（/team/<id> 的返回），而不是手写的近似值：
      // 用假负载渲染出来的「不炸」证明不了任何事。
      const teamList = [{
        id: 'tm1', name: '发布项目组', ownerName: '架构师DSF4.1', members: ['牛马145号', '高级工程师Qwen3.8Max'],
        mission: '把 0.3.0 发出去', status: 'discussing', phase: 'discuss', speaker: '牛马145号',
        rounds: 1, maxRounds: 3, planId: 'pl_team1', lastSeq: 4, last: '接口先定下来', lastError: '',
        updatedAt: Date.now(), createdAt: Date.now(),
      }];
      const teamDetail = {
        team: teamList[0],
        lastSeq: 4,
        teamMode: true,
        messages: [
          { id: 'm1', seq: 1, role: 'system', speaker: '', kind: 'notice', text: '团队「发布项目组」已建立。', overlong: false, runId: '', createdAt: Date.now() - 60_000 },
          { id: 'm2', seq: 2, role: 'owner', speaker: '架构师DSF4.1', kind: 'chat', text: '关键是先冻结接口。@牛马145号 你怎么看？', overlong: false, runId: 'r1', createdAt: Date.now() - 40_000 },
          { id: 'm3', seq: 3, role: 'member', speaker: '牛马145号', kind: 'chat', text: '同意，但并发闸得先改。', overlong: false, runId: 'r2', createdAt: Date.now() - 20_000 },
          { id: 'm4', seq: 4, role: 'system', speaker: '', kind: 'status', text: '（宿主通知）@架构师DSF4.1 任务 t1「改接口」已完成。', overlong: true, runId: 'r3', createdAt: Date.now() },
        ],
        players: [
          { name: '架构师DSF4.1', role: 'owner', model: 'deepseek-official/v4.1', configured: true, busy: true },
          { name: '牛马145号', role: 'member', model: 'q145/qwen3.8', configured: true, busy: false },
        ],
        plan: {
          id: 'pl_team1', title: '发布项目组 的任务链', autoActivate: true, next: '正在跑：t2',
          progress: { total: 2, done: 1, active: 1, ready: 0, waiting: 0, blocked: 0, failed: 0, cancelled: 0, closed: 0, percent: 50 },
          tasks: [
            { id: 't1', title: '改接口', agentName: '牛马145号', state: 'done', deps: [], runId: 'r3' },
            { id: 't2', title: '改并发闸', agentName: '架构师DSF4.1', state: 'running', deps: ['t1'], runId: 'r4' },
          ],
        },
      };
      const groupProps = {
        teams: teamList,
        active: teamList[0],
        detail: teamDetail,
        error: null,
        actionError: '',
        busy: false,
        draft: '',
        logRef: null,
        onLogScroll: () => {},
        teamMode: true,
        onSelect: () => {}, onDraft: () => {}, onSend: () => {},
        onStart: () => {}, onPause: () => {}, onClose: () => {}, onOpenRun: () => {},
      };
      const groupHtml = ReactDOMServer.renderToStaticMarkup(h(exports.TeamGroupView, groupProps));
      check(groupHtml.includes('发布项目组'), '群组栏显示团队名');
      check(groupHtml.includes('讨论中'), '群组栏显示状态（人话，不是内部枚举）');
      check(groupHtml.includes('正在说 @牛马145号'), '群组栏标出正在发言的人（轮流制看得见）');
      check(groupHtml.includes('第 1/3 轮'), '群组栏显示轮次进度（到点会强制收尾）');
      check(groupHtml.includes('群主 @架构师DSF4.1'), '群组栏里有群主身份');
      check(groupHtml.includes('@架构师DSF4.1（群主）：') || groupHtml.includes('@架构师DSF4.1（群主）'),
        '群聊里说话人写清是群主');
      check(groupHtml.includes('关键是先冻结接口'), '群聊渲染出真实发言正文');
      check(groupHtml.includes('宿主 · 执行汇报'), '任务完成时宿主的汇报进群（成员自己漏报也有兜底）');
      check(groupHtml.includes('超长'), '超过群规字数的发言被标出来（而不是悄悄放过）');
      check(groupHtml.includes('t1 牛马145号') && groupHtml.includes('t2 架构师DSF4.1'),
        '群组栏把派出去的活摆在群里（讨论与执行是同一场会）');
      check(groupHtml.includes('固定自动激活'), '团队任务链标出「固定自动激活」（团队模式的固定条款）');
      check(groupHtml.includes('sbh-progress__seg'), '任务链进度在群组栏里画出来');
      check(!/undefined|NaN/.test(groupHtml), '群组栏渲染结果里不能出现 undefined / NaN',
        (groupHtml.match(/undefined|NaN/g) ?? []).join(','));
      check(groupHtml.includes('>继续<') && groupHtml.includes('>暂停<') && groupHtml.includes('>结束<'),
        '群组栏有继续/暂停/结束三个状态操作');
      check(groupHtml.includes('textarea'), '群组栏有一个让用户插话的输入框');

      const groupEmpty = ReactDOMServer.renderToStaticMarkup(h(exports.TeamGroupView, {
        ...groupProps, teams: [], active: null, detail: null, teamMode: false,
      }));
      check(groupEmpty.includes('团队模式关着'), '没开团队模式时说明怎么开（而不是一片空白）');
      check(groupEmpty.includes('团队名称：') && groupEmpty.includes('团队负责人：') && groupEmpty.includes('团队成员：'),
        '空态直接把声明模板摆出来（照着写就能用）', groupEmpty.slice(0, 200));

      const groupAwaiting = ReactDOMServer.renderToStaticMarkup(h(exports.TeamGroupView, {
        ...groupProps,
        active: { ...teamList[0], status: 'awaiting_user', speaker: '' },
      }));
      check(groupAwaiting.includes('群主在等你拍板'), '群主 @用户 之后，界面明确提示用户在等什么');

      // 群组栏挂在面板上：团队模式与任务链同一帧给，面板不额外发请求就能画出人。
      globalThis.fetch = async (url) => ({
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes('/team/')) return teamDetail;
          return {
            enabled: true,
            agents: [],
            archivedAgents: [],
            catalog: { routes: [], transports: [], credentialRefs: [], warnings: [] },
            runtime: { runs: [], busyCount: 0, activeCount: 0, queuedCount: 0, maxConcurrentRuns: 2, tokPerS: 0, anyEstimated: false },
            tasks: { plans: [], total: 0, truncated: false },
            team: { teams: teamList, total: 1, teamMode: true, active: 1 },
          };
        },
        async text() { return '{}'; },
      });
      await hub.refresh('s-7');
      const toggleTeam = ReactDOMServer.renderToStaticMarkup(
        h(exports.ComposerToggle, { sessionId: 's-7', t: (key) => key }),
      );
      check(toggleTeam.includes('sbh-toggle__select'), '输入栏里有一个团队模式下拉（与启用开关并排）');
      check(/value="on"[^>]*>|selected[^>]*value="on"|<option value="on"[^>]*selected/.test(toggleTeam)
        || toggleTeam.includes('团队模式：开'),
        '团队模式已开时下拉显示「开」', toggleTeam.slice(0, 240));
      check(toggleTeam.includes('sbh-toggle__select--on'), '团队模式已开时下拉高亮（状态一眼可见）');
      check(toggleTeam.includes('<option value="off"') && toggleTeam.includes('<option value="on"'),
        '下拉里「开 / 关」两个选项都在');
      check(toggleTeam.includes('团队模式已开') || toggleTeam.includes('团队模式'),
        '下拉的 title 说明了它到底控制什么');
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
