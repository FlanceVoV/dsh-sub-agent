/**
 * dsh-subagent-hub 浏览器侧 bundle（悬浮球 + 输入栏开关 + 设置页 + @ 源）。
 *
 * 形态说明：DSH 的客户端插件是「懒加载 CJS 模块」——脚本执行只注册一个工厂，
 * 工厂在首次 import 时物化。因此本文件是一个自包含的单文件 bundle：
 *  - 只 `require("react")`：不依赖任何 `@deepseek-ai/*` 包（DSH 的客户端模块系统只允许
 *    8 个种子模块，其余需要声明 external）。依赖面越小，升级时的存活率越高。
 *  - 样式自带，并以 `data-plugin-css` 归属本插件，HMR 失效时能被 DSH 正确回收。
 *  - 领域数据全部来自宿主的 `/sub-agent/api`（普通 HTTP + SSE）。
 *
 * 与宿主的契约只有两处，均由 tests/contract.test.mjs 锁住：
 *  1. ENDPOINT 常量 == lib/src/http.js 的 ROUTE_PREFIX
 *  2. package.json 的 name == __ModuleLoader__.load 的 id == 本文件的注册名
 *
 * 分片顺序（见 scripts/build-client.mjs）：本片打开工厂，中间各片只放声明，
 * **最后一片 `05-settings-tail.js` 收尾**（关掉工厂并列出 exports）。
 * 新分片的文件名必须排在收尾片之前。
 *
 * ⚠ 本文件是 UTF-8。**不要用 PowerShell 的 Get-Content / Set-Content 读写它**：
 *   PS 5.1 的 Get-Content 会按系统 ANSI 代码页解码，把全部中文变成乱码，
 *   而且会吞掉部分换行（字节跨行被当成一个多字节字符）。这个坑真的踩过，
 *   整个文件的中文与部分结构都被破坏，最后只能重写。
 *   改这个文件请用文件编辑工具，或用 Node 读写。
 */
window.__ModuleLoader__.load({
  id: "dsh-subagent-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    //#region 契约常量
    /** 宿主端点前缀（必须与 lib/src/http.js 的 ROUTE_PREFIX 一致）。 */
    const ENDPOINT = "/sub-agent/api";
    /** 自定义样式标签的唯一 id。 */
    const CSS_TAG_ID = "dsh-subagent-hub/panel.css";
    /** 输入栏开关的 slot 与 id。 */
    const TOGGLE_SLOT = "conversation.input.right";
    const TOGGLE_ID = "subagent-hub";
    /** 悬浮球的 slot 与 id。 */
    const OVERLAY_SLOT = "shell.overlay";
    const OVERLAY_ID = "subagent-hub";
    /** 配置页的 slot 与 id（设置里的一整个页面）。 */
    const SETTINGS_SLOT = "settings.section";
    const SETTINGS_ID = "subagent-hub";
    /** @ 源的分组名（同一 trigger 下必须唯一）。 */
    const MENTION_GROUP = "subagent";
    /** 本地 UI 记忆（位置/展开态）的键。 */
    const STORAGE_KEY = "dsh-subagent-hub.panel.v1";
    /** 展开态面板宽度（CSS 里用它，视口夹取也用它）。 */
    const PANEL_WIDTH = 348;
    //#endregion

    //#region 样式
    /**
     * 排版约定（「字挤在一起」的根治办法）：
     *  - 每个 label/value 对用 Grid 两列（`minmax(0,1fr) auto`），value 永不换行、永不挤 label；
     *  - 放不下的补充信息另起一行小字（.sbh-field__hint），不再塞进 value；
     *  - 分层用极浅的 hairline，而不是靠间距硬撑。
     *
     * 颜色一律走 DSH 的语义变量（`--dsw-alias-*`），并带字面量兜底；
     * 圆球的颜色因为要「像水」而写死色值（品牌蓝的语义变量在不同主题下差异太大，做不出水感）。
     */
    const CSS = `
.sbh-layer{position:fixed;z-index:2147483000;pointer-events:none}
.sbh-card{pointer-events:auto;box-sizing:border-box;width:${PANEL_WIDTH}px;max-width:calc(100vw - 24px);
  color:var(--dsw-alias-label-primary,#1a1a1a);
  background:var(--dsw-alias-bg-layer-1,#ffffff);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#ffffff) 74%,transparent);
  -webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 14%,transparent);
  border-radius:16px;
  box-shadow:0 18px 44px -16px rgba(0,0,0,.42),0 4px 14px rgba(0,0,0,.14),inset 0 1px 0 rgba(255,255,255,.26);
  font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);
  font-size:12px;line-height:18px;overflow:hidden}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .sbh-card{background:var(--dsw-alias-bg-layer-1,#ffffff)}
}
.sbh-card--wide{width:560px}
.sbh-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:grab;user-select:none;touch-action:none}
.sbh-head--bordered{border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent)}
.sbh-head--dragging{cursor:grabbing}
.sbh-title{font-weight:600;font-size:12.5px;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sbh-spacer{flex:1;min-width:0}
.sbh-rate{font-variant-numeric:tabular-nums;font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);
  font-size:12px;font-weight:600;white-space:nowrap}
.sbh-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;
  border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b5b5b);cursor:pointer;
  font:inherit;font-size:12px;line-height:1}
.sbh-icon:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent)}
.sbh-icon:disabled{opacity:.45;cursor:default}
.sbh-body{border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent);
  max-height:46vh;overflow:auto;overscroll-behavior:contain}
.sbh-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 12px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 6%,transparent)}
.sbh-row:last-child{border-bottom:0}
.sbh-row--agent{align-items:center}
.sbh-row--muted{opacity:.68}
.sbh-row--clickable{cursor:pointer}
.sbh-row--clickable:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 6%,transparent)}
.sbh-row__actions{display:flex;align-items:center;gap:2px;flex:none}
.sbh-dot{width:7px;height:7px;border-radius:50%;flex:none}
.sbh-dot--busy{background:var(--dsw-alias-state-success-primary,#00be6e);animation:sbh-pulse 1.4s ease-in-out infinite}
.sbh-dot--idle{background:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-dot--error{background:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-dot--queued{background:var(--dsw-alias-state-warn-primary,#ffaa00)}
@keyframes sbh-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.sbh-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbh-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbh-metric{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;
  font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px}
.sbh-section{padding:6px 12px 2px;font-size:10.5px;font-weight:600;letter-spacing:.02em;
  color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-empty{padding:10px 12px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-foot{display:flex;align-items:center;gap:8px;padding:7px 12px;
  border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent);
  font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;
  border:1px solid transparent;white-space:nowrap}
.sbh-badge--on{color:var(--dsw-alias-state-success-primary,#0a7b45);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 18%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 38%,transparent)}
.sbh-badge--off{color:var(--dsw-alias-label-secondary,#5b5b5b);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 14%,transparent)}
.sbh-toggle{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px 0 6px;
  border:1px solid transparent;border-radius:8px;background:transparent;cursor:pointer;font:inherit;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#5b5b5b)}
.sbh-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent)}
.sbh-toggle:disabled{opacity:.55;cursor:default}
.sbh-toggle--on{color:var(--dsw-alias-state-success-primary,#0a7b45);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 15%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 34%,transparent)}
.sbh-toggle__mark{font-weight:700}
/* ---- 收起态：玻璃水球 ----
   关键决定：球的视觉**全部由 SVG 画，容器不做 backdrop-filter**。
   backdrop-filter 的模糊区域是圆角矩形，在暗色界面上会露出一块方形底色，
   于是「一颗球」看起来像圆角方块。球的形状必须由球自己决定。 */
.sbh-orb{position:relative;box-sizing:border-box;width:96px;height:96px;
  pointer-events:auto;cursor:grab;touch-action:none;user-select:none;
  filter:drop-shadow(0 10px 18px rgba(0,0,0,.48)) drop-shadow(0 2px 5px rgba(0,0,0,.3));
  transition:transform .26s cubic-bezier(.22,.61,.36,1),opacity .28s ease;
  display:flex;align-items:center;justify-content:center}
.sbh-orb:hover{transform:scale(1.05)}
.sbh-orb:active{cursor:grabbing;transform:scale(.97)}
.sbh-orb--idle{opacity:.9}
/* 在跑 vs 空闲必须看得出来：空闲时水面棱线更淡、波形更慢。
   这条被 tests/contract.test.mjs 盯着——用了却没定义的类名会直接判定失败，
   否则「忙」和「闲」会长得一模一样，而那正是这颗球最该表达的信息。 */
.sbh-orb--busy .sbh-orb__crest{opacity:.6}
.sbh-orb--idle .sbh-orb__crest{opacity:.22}
.sbh-orb--imprecise .sbh-orb__fill{animation:sbh-orb-bob 2.8s ease-in-out infinite}
.sbh-orb__svg{position:absolute;inset:0;width:100%;height:100%;display:block;overflow:visible}
/* 水体：整组随液面纵向平移（带过渡，所以液面变化看得见——压缩之后回落也看得见） */
.sbh-orb__fill{transition:transform .9s cubic-bezier(.22,.61,.36,1)}
.sbh-orb__wave{fill:url(#sbh-orb-water);animation:sbh-orb-flow 3.6s linear infinite}
.sbh-orb--idle .sbh-orb__wave{animation-duration:7s}
.sbh-orb__crest{fill:none;stroke:#fff;stroke-width:1.7;stroke-linecap:round;
  animation:sbh-orb-flow 3.6s linear infinite}
.sbh-orb--idle .sbh-orb__crest{animation-duration:7s}
.sbh-orb__fill--unknown{animation:none}
/* 水的颜色 = **上下文占用**的三档，且跟随主题（用语义变量，不写死色值）。
   stop-color 必须由 CSS 设置才吃得到 var()：写成 SVG 的 XML 属性时 var() 不生效。 */
.sbh-orb--ok .sbh-orb__stop--a{stop-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 46%,#ffffff)}
.sbh-orb--ok .sbh-orb__stop--b{stop-color:var(--dsw-alias-state-success-primary,#00be6e)}
.sbh-orb--ok .sbh-orb__stop--c{stop-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 62%,#052414)}
.sbh-orb--warn .sbh-orb__stop--a{stop-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffaa00) 46%,#ffffff)}
.sbh-orb--warn .sbh-orb__stop--b{stop-color:var(--dsw-alias-state-warn-primary,#ffaa00)}
.sbh-orb--warn .sbh-orb__stop--c{stop-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffaa00) 62%,#3a2400)}
.sbh-orb--crit .sbh-orb__stop--a{stop-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 46%,#ffffff)}
.sbh-orb--crit .sbh-orb__stop--b{stop-color:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-orb--crit .sbh-orb__stop--c{stop-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 62%,#2a0508)}
.sbh-orb--none .sbh-orb__stop--a{stop-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9a9a9a) 40%,#ffffff)}
.sbh-orb--none .sbh-orb__stop--b{stop-color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-orb--none .sbh-orb__stop--c{stop-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9a9a9a) 70%,#1a1a1a)}
@keyframes sbh-orb-flow{from{transform:translateX(0)}to{transform:translateX(100px)}}
@keyframes sbh-orb-bob{0%,100%{transform:translateY(14px)}50%{transform:translateY(2px)}}
.sbh-orb__text{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:1px;
  width:100%;padding:0 12px;box-sizing:border-box;pointer-events:none;text-align:center}
.sbh-orb__name,.sbh-orb__rate,.sbh-orb__time{color:#fff;
  text-shadow:0 1px 3px rgba(0,10,28,.78),0 0 1px rgba(0,10,28,.7)}
.sbh-orb__name{font-size:11px;font-weight:600;line-height:14px;max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbh-orb__rate{font-size:13px;font-weight:700;line-height:17px;font-variant-numeric:tabular-nums;
  font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace)}
.sbh-orb__time{font-size:10.5px;line-height:13px;font-variant-numeric:tabular-nums;opacity:.92}
.sbh-orb__dots{position:absolute;bottom:11px;left:0;right:0;z-index:1;display:flex;justify-content:center;gap:4px}
.sbh-orb__dot{width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.42);
  box-shadow:0 0 2px rgba(0,10,28,.6)}
.sbh-orb__dot--on{background:#fff}
/* ---- 贴边收起态：长条 ----
   不露半个球（既不好看也难点），改成一根竖条：
   高度 = 上下文窗口，从下往上填充 = 占用，颜色同样是那三档。 */
.sbh-strip{position:fixed;box-sizing:border-box;width:16px;height:92px;border-radius:999px;
  pointer-events:auto;cursor:grab;overflow:hidden;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 18%,transparent);
  box-shadow:0 8px 20px -10px rgba(0,0,0,.5);opacity:.9;
  transition:transform .18s ease,opacity .28s ease}
.sbh-strip:hover{transform:scaleX(1.35) scaleY(1.03);opacity:1}
.sbh-strip__fill{position:absolute;left:0;right:0;bottom:0;height:0;
  transition:height .7s cubic-bezier(.22,.61,.36,1),background-color .5s ease}
.sbh-strip--ok .sbh-strip__fill{background-color:var(--dsw-alias-state-success-primary,#00be6e)}
.sbh-strip--warn .sbh-strip__fill{background-color:var(--dsw-alias-state-warn-primary,#ffaa00)}
.sbh-strip--crit .sbh-strip__fill{background-color:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-strip--none .sbh-strip__fill{background-color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-strip__cap{position:absolute;left:0;right:0;top:0;height:2px;
  background:color-mix(in srgb,#ffffff 55%,transparent)}
@media (prefers-reduced-motion:reduce){
  .sbh-orb,.sbh-orb__fill,.sbh-strip,.sbh-strip__fill{transition:none}
  .sbh-orb__wave,.sbh-orb__crest,.sbh-orb--imprecise .sbh-orb__fill{animation:none}
}
/* ---- 详情页 ---- */
.sbh-detail{display:flex;flex-direction:column;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent);
  max-height:60vh;overflow:auto;overscroll-behavior:contain}
.sbh-detail__bar{display:flex;align-items:center;gap:6px;padding:7px 10px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent)}
.sbh-detail__meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;padding:9px 12px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent)}
.sbh-detail__cell{display:flex;flex-direction:column;gap:1px;min-width:0}
.sbh-detail__k{font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9a9a);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.sbh-detail__v{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.sbh-detail__v--mono{font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);font-weight:500;font-size:11px;
  cursor:copy}
.sbh-detail__block{border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent)}
.sbh-detail__head{display:flex;align-items:center;gap:8px;padding:6px 12px 0;
  font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-pre{margin:0;padding:7px 12px 10px;font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);
  font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;max-height:30vh;overflow:auto}
.sbh-pre--out{color:var(--dsw-alias-label-primary,#1a1a1a)}
.sbh-pre--dim{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-style:italic;max-height:16vh}
.sbh-tools{padding:4px 12px 10px;display:flex;flex-direction:column;gap:3px}
.sbh-tools__row{display:flex;align-items:center;gap:7px;min-width:0}
/* ---- 排名与回归 ---- */
.sbh-boards{display:flex;flex-direction:column}
.sbh-table{width:100%;border-collapse:collapse;font-size:11.5px}
.sbh-table th{text-align:left;padding:5px 12px;font-size:10px;font-weight:600;letter-spacing:.02em;
  color:var(--dsw-alias-label-tertiary,#9a9a9a);
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent)}
.sbh-table td{padding:6px 12px;vertical-align:middle;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 5%,transparent)}
.sbh-table tr:last-child td{border-bottom:0}
.sbh-table__num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
  font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace)}
.sbh-table__rank{width:26px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-regression{display:flex;flex-direction:column}
.sbh-regression__series{padding:7px 12px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 5%,transparent)}
.sbh-regression__series:last-child{border-bottom:0}
.sbh-regression__head{display:flex;align-items:center;gap:8px;min-width:0}
.sbh-regression__rounds{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.sbh-regression__round{display:inline-flex;align-items:baseline;gap:3px;padding:1px 7px;border-radius:7px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent);font-size:11px}
.sbh-delta{font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums}
.sbh-delta--up{color:var(--dsw-alias-state-success-primary,#0a7b45)}
.sbh-delta--down{color:var(--dsw-alias-state-error-primary,#e5484d)}
/* ---- 运行护栏 ---- */
.sbh-guards{display:flex;flex-direction:column}
.sbh-field--locked{opacity:.72}
.sbh-check{display:inline-flex;align-items:center;gap:7px;font-size:12px}
.sbh-check input{width:15px;height:15px;accent-color:var(--dsw-alias-interactive-bg-hover,#4d6bfe)}
/* ---- 配置页 ---- */
.sbh-settings{display:flex;flex-direction:column;gap:14px;padding:16px 18px 24px;
  color:var(--dsw-alias-label-primary,#1a1a1a);
  font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);
  font-size:12.5px;line-height:19px;max-width:720px}
.sbh-settings__head{display:flex;align-items:flex-start;gap:10px}
.sbh-settings__title{font-size:15px;font-weight:650;letter-spacing:.01em}
.sbh-settings__sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin-top:2px}
.sbh-settings__section{display:flex;flex-direction:column;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 11%,transparent);
  border-radius:12px;overflow:hidden}
.sbh-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.sbh-field__label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#5b5b5b)}
.sbh-field__hint{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-field__control{display:block;min-width:0}
.sbh-input{box-sizing:border-box;width:100%;padding:5px 8px;font:inherit;font-size:12px;
  color:var(--dsw-alias-label-primary,#1a1a1a);
  background:var(--dsw-alias-bg-base,#fafafa);
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 16%,transparent);
  border-radius:8px}
.sbh-input:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-interactive-bg-hover,#4d6bfe) 45%,transparent);
  outline-offset:-1px}
.sbh-input:disabled{opacity:.6;cursor:not-allowed}
.sbh-textarea{resize:vertical;min-height:56px;font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace)}
.sbh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;padding:12px}
.sbh-form__actions{display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 9%,transparent)}
.sbh-button{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:8px;cursor:pointer;
  font:inherit;font-size:12px;font-weight:600;
  color:var(--dsw-alias-label-primary,#1a1a1a);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 14%,transparent)}
.sbh-button:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 12%,transparent)}
.sbh-button:disabled{opacity:.5;cursor:not-allowed}
.sbh-button--primary{color:#fff;background:var(--dsw-alias-interactive-bg-hover,#4d6bfe);border-color:transparent}
.sbh-alert{padding:7px 12px;font-size:11.5px;line-height:17px}
.sbh-alert--error{color:var(--dsw-alias-state-error-primary,#e5484d);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent)}
.sbh-alert--warn{color:var(--dsw-alias-state-warn-label,#a35b00);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffaa00) 14%,transparent)}
.sbh-alert--ok{color:var(--dsw-alias-state-success-primary,#0a7b45);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 13%,transparent)}

/* ---- 任务链路图（0.2.0）----
   颜色与线型的分工（一类信息只用一个通道，图上才不会互相打架）：
     节点的**底色 + 左侧色条 + 状态字** = 任务状态；
     连线的**实/虚 + 颜色 + 是否流动** = 这条依赖解锁了没有。
   动效只用在两处：运行中节点的呼吸光晕、活跃连线的流动虚线。
   「现在有东西在动」是全图最该突出的信息，到处都动等于哪里都不突出。 */
.sbh-tasks{display:flex;flex-direction:column;gap:7px;padding:9px 12px 11px}
.sbh-tasks__head{display:flex;align-items:center;gap:6px;min-width:0}
.sbh-tasks__title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbh-tasks__sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);white-space:nowrap}
.sbh-progress{display:flex;height:6px;border-radius:999px;overflow:hidden;flex:none;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 12%,transparent)}
.sbh-progress__seg{height:100%;transition:width .4s cubic-bezier(.22,.61,.36,1)}
.sbh-progress__seg--done{background:var(--dsw-alias-state-success-primary,#00be6e)}
.sbh-progress__seg--running{background:var(--dsw-alias-brand-primary,#2f6fed)}
.sbh-progress__seg--ready{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 55%,transparent)}
.sbh-progress__seg--waiting{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 26%,transparent)}
.sbh-progress__seg--blocked{background:var(--dsw-alias-state-warn-primary,#ffaa00)}
.sbh-progress__seg--failed{background:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-progress__seg--cancelled{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 40%,transparent)}
.sbh-legend{display:flex;flex-wrap:wrap;gap:3px 10px;font-size:10.5px;
  color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-legend__item{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.sbh-legend__dot{width:8px;height:8px;border-radius:3px;flex:none;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 26%,transparent)}
.sbh-legend__dot--done{background:var(--dsw-alias-state-success-primary,#00be6e)}
.sbh-legend__dot--waiting{background:transparent;
  border:1px dashed color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 45%,transparent)}
.sbh-legend__dot--running{background:var(--dsw-alias-brand-primary,#2f6fed);animation:sbh-pulse 1.8s ease-in-out infinite}
.sbh-legend__dot--ready{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 55%,transparent)}
.sbh-legend__dot--blocked{background:var(--dsw-alias-state-warn-primary,#ffaa00)}
.sbh-legend__dot--failed{background:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-legend__dot--cancelled{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 40%,transparent)}
.sbh-legend__count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#5b5b5b);font-weight:600}
/* 图：一层一列，左 → 右即依赖方向。画布可横向滚动（终端宽度放下三列已经不窄了）。 */
.sbh-graph{flex:none;border-radius:10px;padding:4px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 4%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent)}
.sbh-graph__scroll{overflow:auto;max-height:38vh;overscroll-behavior:contain}
.sbh-graph__svg{display:block}
.sbh-node{cursor:default}
.sbh-node--clickable{cursor:pointer}
.sbh-node__glow{fill:none;stroke-width:2.5;opacity:0}
.sbh-node__box{stroke-width:1;transition:fill .3s ease,stroke .3s ease}
.sbh-node__accent{transition:fill .3s ease}
.sbh-node__id{font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);font-weight:700}
.sbh-node__title{font-weight:600}
.sbh-node__meta{font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace)}
.sbh-node__chip{font-weight:600}
.sbh-node--clickable:hover .sbh-node__box{stroke-width:2}
.sbh-node--waiting .sbh-node__box{stroke-dasharray:3 3;
  stroke:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 26%,transparent);
  fill:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 4%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--waiting .sbh-node__accent{fill:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 30%,transparent)}
.sbh-node--waiting .sbh-node__title{fill:var(--dsw-alias-label-secondary,#5b5b5b)}
.sbh-node--waiting .sbh-node__chip{fill:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-node--ready .sbh-node__box{stroke:var(--dsw-alias-brand-primary,#2f6fed);
  fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 9%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--ready .sbh-node__accent{fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 60%,transparent)}
.sbh-node--ready .sbh-node__glow{stroke:var(--dsw-alias-brand-primary,#2f6fed);animation:sbh-breathe 2.6s ease-in-out infinite}
.sbh-node--ready .sbh-node__chip{fill:var(--dsw-alias-brand-primary,#2f6fed)}
.sbh-node--running .sbh-node__box{stroke:var(--dsw-alias-state-success-primary,#00be6e);stroke-width:1.5;
  fill:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 10%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--running .sbh-node__accent{fill:var(--dsw-alias-state-success-primary,#00be6e)}
.sbh-node--running .sbh-node__glow{stroke:var(--dsw-alias-state-success-primary,#00be6e);animation:sbh-breathe 1.6s ease-in-out infinite}
.sbh-node--running .sbh-node__chip{fill:var(--dsw-alias-state-success-primary,#0a7b45)}
.sbh-node--done .sbh-node__box{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 45%,transparent);
  fill:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 8%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--done .sbh-node__accent{fill:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 70%,transparent)}
.sbh-node--done .sbh-node__chip{fill:var(--dsw-alias-state-success-primary,#0a7b45)}
.sbh-node--failed .sbh-node__box{stroke:var(--dsw-alias-state-error-primary,#e5484d);
  fill:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 9%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--failed .sbh-node__accent{fill:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-node--failed .sbh-node__chip{fill:var(--dsw-alias-state-error-primary,#e5484d)}
.sbh-node--blocked .sbh-node__box{stroke:var(--dsw-alias-state-warn-primary,#ffaa00);
  fill:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffaa00) 11%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--blocked .sbh-node__accent{fill:var(--dsw-alias-state-warn-primary,#ffaa00)}
.sbh-node--blocked .sbh-node__chip{fill:var(--dsw-alias-state-warn-label,#a35b00)}
.sbh-node--cancelled .sbh-node__box{stroke:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 26%,transparent);
  fill:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 5%,var(--dsw-alias-bg-layer-1,#fff))}
.sbh-node--cancelled .sbh-node__accent{fill:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 30%,transparent)}
.sbh-node--cancelled .sbh-node__title{fill:var(--dsw-alias-label-tertiary,#9a9a9a);text-decoration:line-through}
.sbh-node--cancelled .sbh-node__chip{fill:var(--dsw-alias-label-tertiary,#9a9a9a)}
.sbh-edge{fill:none;stroke-width:1.6}
.sbh-edge--pending{stroke:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 28%,transparent);stroke-dasharray:4 4}
.sbh-edge--done{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 70%,transparent)}
.sbh-edge--active{stroke:var(--dsw-alias-brand-primary,#2f6fed);stroke-dasharray:5 5;animation:sbh-flow 1s linear infinite}
/* 箭头与线同色：分开定义是为了让 marker（在 <defs> 里，不继承连线的样式）也能吃到状态颜色。 */
.sbh-edge__arrow--pending{fill:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 34%,transparent)}
.sbh-edge__arrow--done{fill:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 70%,transparent)}
.sbh-edge__arrow--active{fill:var(--dsw-alias-brand-primary,#2f6fed)}
@keyframes sbh-breathe{0%,100%{opacity:.16}50%{opacity:.6}}
@keyframes sbh-flow{to{stroke-dashoffset:-10}}
/* 清单标签（多条链路时切换） */
.sbh-tabs{display:flex;gap:4px;overflow:auto;padding:1px}
.sbh-tab{border:1px solid transparent;border-radius:7px;background:transparent;font:inherit;font-size:10.5px;
  color:var(--dsw-alias-label-secondary,#5b5b5b);padding:2px 7px;cursor:pointer;white-space:nowrap}
.sbh-tab:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent)}
.sbh-tab--on{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 14%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 34%,transparent)}
/* 任务明细（设置页用；面板里放不下这么多字段） */
.sbh-plan{display:flex;flex-direction:column;gap:6px;padding:9px 0 4px;
  border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent)}
.sbh-plan:first-child{border-top:0}
.sbh-task{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;
  padding:5px 0;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 5%,transparent)}
.sbh-task__badge{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:6px;
  font-size:10px;font-weight:600;white-space:nowrap;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent);
  color:var(--dsw-alias-label-secondary,#5b5b5b)}
.sbh-task__badge--done{color:var(--dsw-alias-state-success-primary,#0a7b45);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 16%,transparent)}
.sbh-task__badge--running{color:var(--dsw-alias-state-success-primary,#0a7b45);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#00be6e) 16%,transparent)}
.sbh-task__badge--ready{color:var(--dsw-alias-brand-primary,#2f6fed);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 16%,transparent)}
.sbh-task__badge--blocked{color:var(--dsw-alias-state-warn-label,#a35b00);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffaa00) 18%,transparent)}
.sbh-task__badge--failed{color:var(--dsw-alias-state-error-primary,#e5484d);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 14%,transparent)}
.sbh-mini-btn{border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 16%,transparent);
  border-radius:7px;background:transparent;font:inherit;font-size:10.5px;padding:2px 7px;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#5b5b5b);white-space:nowrap}
.sbh-mini-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent)}
.sbh-mini-btn:disabled{opacity:.5;cursor:default}
.sbh-mini-btn--primary{color:var(--dsw-alias-brand-primary,#2f6fed);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 40%,transparent)}
.sbh-mini-btn--danger{color:var(--dsw-alias-state-error-primary,#e5484d);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 34%,transparent)}
@media (prefers-reduced-motion:reduce){
  .sbh-node__glow,.sbh-edge--active,.sbh-legend__dot--running,.sbh-dot--busy{animation:none}
}
`;
    //#endregion

    //#region 基础工具
    /**
     * 可观察对象：稳定身份的 {getSnapshot, subscribe}，供 React 订阅。
     * 不用 useSyncExternalStore 是为了兼容任意 React 18 小版本，行为等价且更简单。
     */
    function observable(getSnapshot, subscribe) {
      return { getSnapshot, subscribe };
    }

    /**
     * 订阅一个可观察对象。
     * @param {{getSnapshot:Function,subscribe:Function}|undefined} source - 观察源。
     * @returns {any} 当前值。
     */
    function useObservable(source) {
      const [value, setValue] = React.useState(() => (source === undefined ? undefined : source.getSnapshot()));
      React.useEffect(() => {
        if (source === undefined) {
          setValue(undefined);
          return undefined;
        }
        setValue(source.getSnapshot());
        return source.subscribe(() => { setValue(source.getSnapshot()); });
      }, [source]);
      return value;
    }

    /** 注入一次性样式（幂等：同一个 id 只插一次）。 */
    function ensureCss() {
      if (document.getElementById(CSS_TAG_ID) !== null) return;
      const tag = document.createElement("style");
      tag.id = CSS_TAG_ID;
      tag.dataset.plugin = "dsh-subagent-hub";
      tag.dataset.pluginCss = "dsh-subagent-hub/panel.css";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 千分位。 */
    function group(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 人类可读的时长，按需求指定的四档格式：
     *
     *   25s   →  不足 1 分钟，显示秒
     *   25min →  不足 1 小时，显示分钟（用 "min" 而不是 "m"）
     *   1h    →  整小时，后面不带 0 分
     *   1h25m →  超过 1 小时，显示 时h分m
     *
     * 刻意**不做进位**（65 秒显示 1min 而不是 1min5s）：这是一颗小圆球里的第三行，
     * 秒级精度在这个尺度上没有决策价值，多出来的字符还会把布局挤坏。
     *
     * @param {number} ms - 毫秒。
     * @returns {string}
     */
    function formatDuration(ms) {
      const total = Math.max(0, Math.round((ms ?? 0) / 1000));
      if (total < 60) return `${total}s`;
      const minutes = Math.floor(total / 60);
      if (minutes < 60) return `${minutes}min`;
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
    }

    /** 紧凑 token 数。 */
    function compactTokens(value) {
      const num = Number(value ?? 0);
      if (num < 1000) return String(num);
      if (num < 1000000) return `${(num / 1000).toFixed(num < 10000 ? 1 : 0)}k`;
      return `${(num / 1000000).toFixed(1)}M`;
    }

    /**
     * 读本地 UI 记忆（失败就用默认值：这是纯装饰性状态，不该影响功能）。
     *
     * 记住的是「贴在哪一侧」而不是绝对 x 坐标：窗口宽度会变，
     * 存绝对 x 会让球在换窗口大小之后漂到屏幕中间或屏幕外。
     * @returns {object}
     */
    function loadPanelState() {
      const fallback = { expanded: false, side: "right", x: null, y: null };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return {
          expanded: parsed?.expanded === true,
          side: parsed?.side === "left" ? "left" : "right",
          x: typeof parsed?.x === "number" ? parsed.x : null,
          y: typeof parsed?.y === "number" ? parsed.y : null,
        };
      } catch {
        return fallback;
      }
    }

    /** 写本地 UI 记忆。 */
    function savePanelState(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* 隐私模式下写不了，忽略即可 */
      }
    }

    /**
     * 归一化宿主给的任务图负载。
     *
     * 为什么要过一道手：这一份负载同时来自 `/state`、SSE 心跳与 `/tasks` 三个入口，
     * 而面板会直接把它喂给绘图函数。任何一个入口给了缺字段的对象（老客户端配新宿主、
     * 新客户端配老宿主都会发生），绘图时读到 undefined 就会整块白屏。
     * 这里只保留**确认能画**的字段，画不出来的一律当「没有链路」——面板不该因为
     * 一个可选功能而整体不可用。
     *
     * @param {unknown} raw - 原始负载。
     * @returns {{plans:object[],total:number,truncated:boolean}|undefined} 形状不对时返回 undefined。
     */
    function normalizeTaskFrame(raw) {
      if (raw === null || typeof raw !== "object" || !Array.isArray(raw.plans)) return undefined;
      const plans = [];
      for (const view of raw.plans) {
        if (view === null || typeof view !== "object") continue;
        if (view.plan === undefined || view.plan === null || !Array.isArray(view.tasks)) continue;
        plans.push({
          plan: view.plan,
          tasks: view.tasks,
          edges: Array.isArray(view.edges) ? view.edges : [],
          progress: view.progress ?? { total: view.tasks.length, done: 0, percent: 0 },
          next: typeof view.next === "string" ? view.next : "",
          serverNow: typeof view.serverNow === "number" ? view.serverNow : Date.now(),
        });
      }
      return {
        plans,
        total: Number.isSafeInteger(raw.total) ? raw.total : plans.length,
        truncated: raw.truncated === true,
      };
    }
    //#endregion

    //#region 宿主连接
    /**
     * 与宿主之间的连接：状态拉取 + 写操作 + SSE 实时流。
     *
     * 为什么要 SSE 而不是轮询：tok/s 与「谁在跑」是秒级变化的信息，
     * 轮询要么慢到看不出在动，要么为了新鲜度把整份快照拉爆。
     * 连接失败不崩：面板显示断连，并在下次交互时重试。
     */
    const hub = (() => {
      const listeners = new Set();
      let snapshot = {
        ready: false,
        error: null,
        enabled: false,
        sessionId: "",
        agents: [],
        archivedAgents: [],
        catalog: { routes: [], transports: [], credentialRefs: [], warnings: [] },
        runtime: { busyCount: 0, activeCount: 0, queuedCount: 0, maxConcurrentRuns: 0, tokPerS: 0, anyEstimated: false, runs: [] },
        // 任务链路图（0.2.0）：跟运行时快照走同一条流，面板才能在同一帧里
        // 同时看到「谁在跑」与「任务到哪一步」。
        tasks: { plans: [], total: 0, truncated: false },
        health: null,
      };
      let source = null;
      let currentSessionId = "";

      const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* 单个订阅者出错不该影响别人 */ } } };
      const set = (patch) => { snapshot = { ...snapshot, ...patch }; notify(); };

      /** 拉一次完整状态。 */
      const refresh = async (sessionId) => {
        const target = sessionId ?? currentSessionId;
        currentSessionId = target;
        try {
          const response = await fetch(`${ENDPOINT}/state?sessionId=${encodeURIComponent(target)}`, { headers: { accept: "application/json" } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          set({
            ready: true,
            error: null,
            enabled: data.enabled === true,
            sessionId: target,
            agents: Array.isArray(data.agents) ? data.agents : [],
            archivedAgents: Array.isArray(data.archivedAgents) ? data.archivedAgents : [],
            catalog: data.catalog ?? snapshot.catalog,
            runtime: data.runtime ?? snapshot.runtime,
            tasks: normalizeTaskFrame(data.tasks) ?? snapshot.tasks,
          });
        } catch (error) {
          set({ ready: false, error: `连不上宿主：${error?.message ?? error}` });
        }
      };

      /** 拉健康信息（用于显示能力缺失的原因）。 */
      const refreshHealth = async () => {
        try {
          const response = await fetch(`${ENDPOINT}/health`, { headers: { accept: "application/json" } });
          if (!response.ok) return;
          set({ health: await response.json() });
        } catch {
          /* 健康检查失败不影响主流程 */
        }
      };

      /**
       * 起 SSE。
       *
       * **一直开着**，不随启用状态开关。原因：开关是全局的，一个窗口改了要让**所有**窗口跟上；
       * 而「关着就不连」会让一个本来就关着的窗口永远不知道别处把它打开了——
       * 于是「打开一次对所有对话生效」只在刷新页面之后才成立。
       * 代价是每个窗口一条每秒一帧的小流，换来的是各窗口状态真正一致。
       */
      const openStream = () => {
        if (source !== null) return;
        try {
          source = new EventSource(`${ENDPOINT}/stream`);
          source.addEventListener("state", (event) => {
            try {
              const data = JSON.parse(event.data);
              set({
                runtime: data.runtime ?? snapshot.runtime,
                // 启用状态也走这条流：这样别的窗口一开开关，这里立刻跟着变。
                enabled: data.enabled === true,
                tasks: normalizeTaskFrame(data.tasks) ?? snapshot.tasks,
                error: null,
                ready: true,
              });
            } catch { /* 坏帧忽略 */ }
          });
          // 这里不再监听单独的 tasks 事件：任务图的变化由宿主用**立刻补发一帧 state**
          // 来表达（依赖完成 → 下游被激活那一瞬间是链路最值得看的地方，
          // 延迟到下一秒的心跳会让它看起来像随机发生的）。多一个同形事件只会多一套解析分支。
          source.addEventListener("run", () => { /* 帧内容由下一条 state 覆盖，这里只需触发重绘时机 */ });
          source.onerror = () => {
            // EventSource 自带重连；这里只把状态标出来，不让面板出现假数据。
            set({ error: "实时流断开，正在重连…" });
          };
        } catch (error) {
          set({ error: `无法建立实时流：${error?.message ?? error}` });
        }
      };

      const closeStream = () => {
        try { source?.close(); } catch { /* 已关闭 */ }
        source = null;
      };

      /** 写操作。 */
      const post = async (path, body) => {
        const response = await fetch(`${ENDPOINT}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const text = await response.text();
        let payload;
        try { payload = text === "" ? {} : JSON.parse(text); } catch { payload = { error: text }; }
        if (!response.ok && payload.error === undefined) payload.error = `HTTP ${response.status}`;
        return { ok: response.ok, status: response.status, payload };
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        getSnapshot: () => snapshot,
        refresh,
        refreshHealth,
        post,
        /** 让宿主知道当前会话（只影响会话相关的展示；开关是全局的，与会话无关）。 */
        setSession(sessionId) {
          if (sessionId === currentSessionId) return;
          currentSessionId = sessionId;
          void refresh(sessionId);
        },
        /**
         * 保持实时流开着。
         *
         * 以前这里按启用状态开关流；现在**不再关流**——开关是全局的，
         * 关掉流的那个窗口就再也收不到「别处把它打开了」的通知。
         */
        setEnabled() {
          openStream();
        },
        /** 收尾：摘掉实时流（供热替换/卸载时调用）。 */
        dispose: closeStream,
      };
    })();

    /** 订阅宿主快照的 hook。 */
    const hubObservable = observable(hub.getSnapshot, hub.subscribe);
    function useHub() {
      return useObservable(hubObservable);
    }
    //#endregion

    //#region 输入栏开关（需求 4：标红位置的启用选项）
    /**
     * 输入框底部那一行的启用开关。
     *
     * 落点是 `conversation.input.right`（发送按钮与模型选择器之前）。
     * 这是 DSH 为插件预留的**加法**列表槽——`+` 按钮与权限选择器都是硬编码的，
     * 不是插槽，所以不要去抢它们；`conversation.input.left` 是另一个同性质的座位。
     *
     * 开关是**全局**的：子 agent 的配置本来就是全局的（一张 agents 表、所有对话共用），
     * 开关如果按会话记，新开一个对话就会得到「配置都在、却什么都看不见」的界面。
     * 作用域必须和被控制的对象一致。所以这里不要求 sessionId 非空，也不再把状态按会话存。
     */
    function ComposerToggle(props) {
      const { sessionId, t } = props;
      const state = useHub();
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (typeof sessionId === "string" && sessionId !== "") hub.setSession(sessionId);
      }, [sessionId]);

      React.useEffect(() => {
        // 保持实时流开着，这样别的窗口改开关时这里能立刻跟上。
        hub.setEnabled();
      }, []);

      const enabled = state.enabled === true;
      const label = enabled
        ? (t?.("toggle.on") ?? "子 agent 已启用")
        : (t?.("toggle.off") ?? "子 agent 已关闭");

      const onClick = React.useCallback(async () => {
        if (busy) return;
        setBusy(true);
        const next = !enabled;
        // sessionId 不再需要（开关是全局的），但带上它也无害——宿主会忽略。
        const result = await hub.post("/enable", { sessionId, enabled: next });
        setBusy(false);
        if (!result.ok) {
          await hub.refresh(sessionId);
          return;
        }
        await hub.refresh(sessionId);
      }, [busy, enabled, sessionId]);

      return h("button", {
        type: "button",
        className: `sbh-toggle${enabled ? " sbh-toggle--on" : ""}`,
        onClick,
        disabled: busy,
        title: enabled
          ? "子 agent 已启用（对所有对话生效）：悬浮球可见，消息里的 @名字 会被委派"
          : "启用后才会显示悬浮球、@名字 才会被委派。这是全局开关，对所有对话生效",
        "aria-pressed": enabled,
      }, [
        h("span", { key: "mark", className: "sbh-toggle__mark" }, "@"),
        h("span", { key: "label" }, label),
      ]);
    }
    //#endregion

    //#region 圆形液体球（收起态）
    /** 收起态圆球直径（px），与 CSS 里的 .sbh-orb 保持一致。 */
    const ORB_SIZE = 96;
    /** 贴边长条（收起态）的尺寸，与 CSS 里的 .sbh-strip 保持一致。 */
    const STRIP_WIDTH = 16;
    const STRIP_HEIGHT = 92;
    /** 多个在跑时，轮播切换的间隔。 */
    const ORB_CAROUSEL_MS = 2000;
    /** 空闲多久之后自动贴边收起（「自己收起来」）。 */
    const ORB_TUCK_AFTER_MS = 8000;
    /** 拖动超过多少像素才算「拖动」而不是「点击」。 */
    const DRAG_THRESHOLD = 4;
    /** SVG 里各处渐变与 clip 的 id 前缀（避免与页面上别的 SVG 撞 id）。 */
    const ORB_ID = "sbh-orb";
    /** 球半径（viewBox 是 100×100，圆心 50,50）。 */
    const ORB_R = 48;
    /**
     * 水面波形：一个周期 100 个 user unit，横向铺 3 个周期，从 x=-100 铺到 x=200。
     * 整体平移 100 就是一个完整周期，于是循环无缝。
     * 路径从水面一路封到底部（y=120），所以它既是水面也是水体。
     */
    const ORB_WAVE_BODY = "M-100,3 Q-75,-4 -50,3 T0,3 T50,3 T100,3 T150,3 T200,3 L200,120 L-100,120 Z";
    /** 只画水面那条棱线（水波的高光）。 */
    const ORB_WAVE_CREST = "M-100,3 Q-75,-4 -50,3 T0,3 T50,3 T100,3 T150,3 T200,3";

    /**
     * 圆球的 SVG（纯函数，便于单独验证）。
     *
     * 视觉全部由 SVG 画，容器**不做毛玻璃**——这是踩过的坑：
     * `backdrop-filter` 的模糊区域是一个圆角矩形，在暗色界面上会露出一块明显的方形底色，
     * 于是「一颗球」看起来像个圆角方块。球的形状必须由球自己决定。
     *
     * @param {number} fillY - 水面的 y 坐标（越大水面越低）。
     * @param {boolean} unknown - 是否处于「不知道总量」的不确定态。
     * @returns {object} React 元素。
     */
    function orbSvg(fillY, unknown) {
      return h("svg", { className: "sbh-orb__svg", viewBox: "0 0 100 100", "aria-hidden": "true", key: "svg" }, [
        h("defs", { key: "defs" }, [
          h("clipPath", { id: `${ORB_ID}-clip`, key: "clip" }, h("circle", { cx: 50, cy: 50, r: ORB_R })),
          // 水体：左上偏亮、右下更深，形成体积感。
          // 颜色**不写在这里**——由 CSS 的 .sbh-orb--ok/--warn/--crit 按上下文档位给 stop-color，
          // 这样颜色既跟随主题、又能随档位切换。
          h("linearGradient", { id: `${ORB_ID}-water`, x1: 0.15, y1: 0, x2: 0.75, y2: 1, key: "water" }, [
            h("stop", { offset: "0%", className: "sbh-orb__stop--a", key: "a" }),
            h("stop", { offset: "38%", className: "sbh-orb__stop--b", key: "b" }),
            h("stop", { offset: "100%", className: "sbh-orb__stop--c", key: "c" }),
          ]),
          // 空腔（球内空气）：深靛，带一点从左上来的光。
          h("radialGradient", { id: `${ORB_ID}-air`, cx: 0.34, cy: 0.22, r: 0.95, key: "air" }, [
            h("stop", { offset: "0%", stopColor: "#41527a", key: "a" }),
            h("stop", { offset: "55%", stopColor: "#1e2946", key: "b" }),
            h("stop", { offset: "100%", stopColor: "#0e1526", key: "c" }),
          ]),
          // 镜面高光（柔和的白团）。
          h("radialGradient", { id: `${ORB_ID}-spec`, cx: 0.5, cy: 0.5, r: 0.5, key: "spec" }, [
            h("stop", { offset: "0%", stopColor: "#ffffff", stopOpacity: 0.92, key: "a" }),
            h("stop", { offset: "55%", stopColor: "#ffffff", stopOpacity: 0.22, key: "b" }),
            h("stop", { offset: "100%", stopColor: "#ffffff", stopOpacity: 0, key: "c" }),
          ]),
          // 底部内阴影：让球看起来是实心的。
          h("radialGradient", { id: `${ORB_ID}-inner`, cx: 0.5, cy: 1.02, r: 0.72, key: "inner" }, [
            h("stop", { offset: "0%", stopColor: "#000814", stopOpacity: 0.5, key: "a" }),
            h("stop", { offset: "100%", stopColor: "#000814", stopOpacity: 0, key: "c" }),
          ]),
          // 边缘轮廓：上暗下亮（模拟玻璃的菲涅尔）。
          h("linearGradient", { id: `${ORB_ID}-rim`, x1: 0.2, y1: 0, x2: 0.6, y2: 1, key: "rim" }, [
            h("stop", { offset: "0%", stopColor: "#ffffff", stopOpacity: 0.62, key: "a" }),
            h("stop", { offset: "45%", stopColor: "#ffffff", stopOpacity: 0.1, key: "b" }),
            h("stop", { offset: "100%", stopColor: "#bfe7ff", stopOpacity: 0.72, key: "c" }),
          ]),
        ]),

        // 1) 球内空气。
        h("circle", { cx: 50, cy: 50, r: ORB_R, fill: `url(#${ORB_ID}-air)`, key: "air" }),

        // 2) 水：整组下移 fillY，水面在路径里；波形在内部单独横向流动。
        h("g", { clipPath: `url(#${ORB_ID}-clip)`, key: "clip" }, [
          h("g", {
            className: `sbh-orb__fill${unknown ? " sbh-orb__fill--unknown" : ""}`,
            style: { transform: `translateY(${fillY}px)` },
            key: "fill",
          }, [
            h("path", { className: "sbh-orb__wave", d: ORB_WAVE_BODY, key: "body" }),
            // 水面那条棱线：单独一条描边，「有液体」最直接的视觉信号就靠它。
            h("path", { className: "sbh-orb__crest", d: ORB_WAVE_CREST, key: "crest" }),
          ]),
        ]),

        // 3) 底部内阴影（压在水之上，制造实心感）。
        h("g", { clipPath: `url(#${ORB_ID}-clip)`, key: "innerClip" }, [
          h("circle", { cx: 50, cy: 50, r: ORB_R, fill: `url(#${ORB_ID}-inner)`, key: "inner" }),
        ]),

        // 4) 镜面高光：左上大团 + 一个小亮点；右下再来一点环境反光。
        h("ellipse", {
          cx: 33, cy: 23, rx: 19, ry: 12, fill: `url(#${ORB_ID}-spec)`,
          transform: "rotate(-26 33 23)", key: "spec1",
        }),
        h("ellipse", {
          cx: 29, cy: 19, rx: 6.5, ry: 3.4, fill: "#ffffff", opacity: 0.7,
          transform: "rotate(-26 29 19)", key: "spec2",
        }),
        h("ellipse", {
          cx: 71, cy: 79, rx: 20, ry: 11, fill: "#a9e4ff", opacity: 0.16,
          transform: "rotate(-28 71 79)", key: "bounce",
        }),

        // 5) 玻璃边缘。
        h("circle", {
          cx: 50, cy: 50, r: ORB_R, fill: "none", stroke: `url(#${ORB_ID}-rim)`,
          strokeWidth: 1.8, key: "rim",
        }),
      ]);
    }

    /**
     * 收起态的圆形球（**纯展示**，数据全部由 props 给，便于脱离浏览器验证渲染）。
     *
     * 液面 = **上下文占用率**（最近一步送出的 prompt 大小 ÷ 上下文窗口），不是时间进度。
     *
     * 为什么不是「已跑时间 ÷ 超时」：那是个**只增不减**的量，所以看起来是「死的」；
     * 而且它回答的是「还剩多久被砍」，不是用户真正关心的「这个子 agent 的上下文是不是快满了」。
     * 子 agent 自己压缩上下文之后，下一个请求的 prompt 会真的变小，液面就跟着回落——
     * 这正是需要的行为。
     *
     * 配色由 ratio 分三档（绿/黄/红），颜色本身来自主题变量（见 CSS）。
     */
    function OrbView(props) {
      const {
        name, rateText, timeText, ratio, stage, index, total, busy, imprecise, contextLabel,
        onPointerDown, onPointerMove, onPointerUp, onClick, onPointerEnter, onPointerLeave,
      } = props;

      // ratio 为 null = 还没有任何一步完成（拿不到 prompt 大小）→ 静息水位 + 上下浮动，
      // 明确读作「在跑，但还不知道占了多少」，而不是假装一个精确的值。
      const unknown = ratio === null || ratio === undefined;
      const clamped = Math.max(0, Math.min(1, unknown ? 0 : ratio));
      // ratio=1 时水面在球顶之上（-4 让满水时也露出一条棱线）。
      const fillY = Math.round((100 * (1 - clamped) - 4) * 10) / 10;
      const dots = Math.min(total ?? 0, 6);
      const tone = stage ?? "none";

      return h("div", {
        className: `sbh-orb sbh-orb--${tone}${busy ? " sbh-orb--busy" : " sbh-orb--idle"}${unknown && busy ? " sbh-orb--imprecise" : ""}`,
        onPointerDown, onPointerMove, onPointerUp, onClick, onPointerEnter, onPointerLeave,
        role: "button",
        tabIndex: 0,
        title: `${name}${busy ? "（运行中）" : "（空闲）"}｜${rateText}｜${timeText}${contextLabel === "" ? "" : `｜${contextLabel}`}｜点击展开`,
      }, [
        orbSvg(fillY, unknown && busy),
        h("div", { className: "sbh-orb__text", key: "text" }, [
          h("div", { className: "sbh-orb__name", key: "n" }, name),
          h("div", { className: "sbh-orb__rate", key: "r" }, rateText),
          h("div", { className: "sbh-orb__time", key: "t" }, timeText),
        ]),
        dots > 1
          ? h("div", { className: "sbh-orb__dots", key: "dots" },
            Array.from({ length: dots }, (_, dotIndex) => h("span", {
              key: dotIndex,
              className: `sbh-orb__dot${dotIndex === (index ?? 0) % dots ? " sbh-orb__dot--on" : ""}`,
            })))
          : null,
      ]);
    }

    /**
     * 贴边收起态：一根**长条**（**纯展示**）。
     *
     * 为什么不沿用「半个球露在边上」：既不好看，也不好点。长条同时是个更好的仪表——
     * 高度就是上下文窗口，从下往上填充就是占用，颜色同样是绿/黄/红三档。
     */
    function StripView(props) {
      const {
        name, ratio, stage, busy, contextLabel,
        onPointerDown, onPointerMove, onPointerUp, onClick, onPointerEnter,
      } = props;
      const clamped = Math.max(0, Math.min(1, ratio ?? 0));
      const tone = stage ?? "none";
      return h("div", {
        className: `sbh-strip sbh-strip--${tone}`,
        onPointerDown, onPointerMove, onPointerUp, onClick, onPointerEnter,
        role: "button",
        tabIndex: 0,
        title: `${name}${busy ? "（运行中）" : "（空闲）"}${contextLabel === "" ? "" : `｜${contextLabel}`}｜点击展开`,
      }, [
        h("div", { className: "sbh-strip__cap", key: "cap" }),
        h("div", { className: "sbh-strip__fill", key: "fill", style: { height: `${Math.round(clamped * 100)}%` } }),
      ]);
    }
    //#endregion

    //#region 悬浮球（需求 1）
    /**
     * 悬浮球：**收起时是一颗圆形液体球**（玻璃球 + 有颜色的水 + 居中三行文字，
     * 多个在跑时每 2 秒轮播一个），点击展开成列表面板。
     *
     * 它是 root 作用域的浮层，拿不到会话作用域的标准 props，所以：
     *  - 用 `useSessions` 拿当前会话 id（只影响会话相关的展示）；
     *  - 层级是 click-through 的，卡片/圆球自己打开 pointer-events，否则点不到。
     */
    function SubAgentBall(props) {
      const { useSessions } = props;
      const state = useHub();
      const panel = useObservable(panelObservable);
      const [dragging, setDragging] = React.useState(false);
      const [openRunId, setOpenRunId] = React.useState(null);
      const [carouselIndex, setCarouselIndex] = React.useState(0);
      const [tucked, setTucked] = React.useState(false);
      const [hovered, setHovered] = React.useState(false);
      const dragRef = React.useRef(null);
      /**
       * 「刚刚拖过」的标记，用来吃掉拖动之后紧跟的那次 click。
       *
       * 必须用 ref 而不是 state：native click 在 pointerup 之后触发，
       * 那时 `setDragging(false)` 已经生效，所以状态里读到的永远是 false。
       */
      const justDraggedRef = React.useRef(false);

      const sessionId = typeof useSessions === "function"
        ? useSessions((store) => store?.current)
        : undefined;
      React.useEffect(() => {
        if (typeof sessionId === "string" && sessionId !== "") hub.setSession(sessionId);
      }, [sessionId]);

      // 保持实时流开着（不随启用状态开关）：这样别的窗口改开关时这里能立刻跟上。
      React.useEffect(() => { hub.setEnabled(); }, []);

      // 按秒滴答：让「已跑多久」自己走起来，而不是等下一个事件。
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);

      // 轮播：多个在跑时每 2 秒换一个。只有一个在跑时不动（省掉无意义的闪烁）。
      const busyCount = (state.runtime?.runs ?? []).filter((run) => run.busy).length;
      React.useEffect(() => {
        if (busyCount <= 1) { setCarouselIndex(0); return undefined; }
        const timer = setInterval(() => setCarouselIndex((index) => index + 1), ORB_CAROUSEL_MS);
        return () => clearInterval(timer);
      }, [busyCount]);

      /**
       * 位置：**全方向自由拖拽**。
       *
       * 之前是「松手吸附到左右边缘、之后只能上下移动」——那等于把拖动锁掉了一个维度，
       * 用户说「只能在左边拖」就是这个原因。现在直接存绝对 x/y，想放哪就放哪，
       * 只做视口夹取（不让它跑到屏幕外拿不回来）。
       */
      const boxWidth = panel.expanded === true ? PANEL_WIDTH : ORB_SIZE;
      const boxHeight = panel.expanded === true ? 320 : ORB_SIZE;
      const position = React.useMemo(() => {
        const viewportWidth = typeof window !== "undefined" && typeof window.innerWidth === "number"
          ? window.innerWidth
          : 1200;
        const viewportHeight = typeof window !== "undefined" && typeof window.innerHeight === "number"
          ? window.innerHeight
          : 800;
        if (panel.x === null || panel.y === null) return { right: 16, bottom: 96 };
        return {
          left: Math.max(8, Math.min(panel.x, Math.max(8, viewportWidth - boxWidth - 8))),
          top: Math.max(8, Math.min(panel.y, Math.max(8, viewportHeight - boxHeight - 8))),
        };
      }, [panel.x, panel.y, boxWidth, boxHeight]);

      /** 收起态长条贴哪一侧：按当前位置离哪边近。 */
      const stripSide = React.useMemo(() => {
        const viewportWidth = typeof window !== "undefined" && typeof window.innerWidth === "number"
          ? window.innerWidth
          : 1200;
        const center = (panel.x ?? viewportWidth - 16 - ORB_SIZE) + ORB_SIZE / 2;
        return center < viewportWidth / 2 ? "left" : "right";
      }, [panel.x]);

      const stripPosition = React.useMemo(() => {
        const viewportHeight = typeof window !== "undefined" && typeof window.innerHeight === "number"
          ? window.innerHeight
          : 800;
        const defaultTop = viewportHeight - 96 - ORB_SIZE;
        const top = panel.y === null ? defaultTop : panel.y;
        return {
          [stripSide]: 4,
          top: Math.max(8, Math.min(top, Math.max(8, viewportHeight - STRIP_HEIGHT - 8))),
        };
      }, [panel.y, stripSide]);

      /**
       * 贴边收起：**空闲**一段时间后把球收成一根长条。
       *
       * 只在空闲时收：正在跑的时候把球藏起来，等于把最该看的东西藏起来。
       * 依赖里**不能**放 `now`（它每秒变一次），否则这个 8 秒计时器会被每秒重置、永远不触发——
       * 一个「看起来写了但永远不会发生」的行为。
       */
      React.useEffect(() => {
        if (panel.expanded === true || hovered === true || busyCount > 0) {
          setTucked(false);
          return undefined;
        }
        const timer = setTimeout(() => setTucked(true), ORB_TUCK_AFTER_MS);
        return () => clearTimeout(timer);
      }, [panel.expanded, hovered, busyCount]);

      const onPointerDown = React.useCallback((event) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
        // 新的一次按下要清掉「刚拖过」的标记，否则下一次点击会被上一次拖动吃掉。
        justDraggedRef.current = false;
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }, []);

      const onPointerMove = React.useCallback((event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
        const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
        const x = Math.max(0, Math.min(viewportWidth - 24, event.clientX - drag.dx));
        const y = Math.max(0, Math.min(viewportHeight - 24, event.clientY - drag.dy));
        // 位移超过阈值才算「拖动」。这里用**累积位移**判断，而不是跟 panel.x 比——
        // panel.x 在拖动过程中一直在变，跟它比会在某些路径上永远判定不出移动。
        const totalMoved = Math.abs(event.clientX - (drag.startX ?? event.clientX))
          + Math.abs(event.clientY - (drag.startY ?? event.clientY));
        if (drag.startX === undefined) { drag.startX = event.clientX; drag.startY = event.clientY; }
        if (totalMoved > DRAG_THRESHOLD) drag.moved = true;
        panelObservable.set({ ...panelObservable.getSnapshot(), x, y });
      }, []);

      const onPointerUp = React.useCallback((event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        dragRef.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        if (!drag.moved) return;
        // 拖动过就置位：native click 在 pointerup 之后立刻触发，
        // 靠这个标记把那次 click 吃掉，否则「拖完自己就展开了」。
        justDraggedRef.current = true;
      }, []);

      /**
       * 点击 → 展开/收起。
       *
       * **必须靠 ref 判断「刚刚是不是拖过」**，不能用 `dragging` state：
       * native click 在 pointerup 之后才触发，那时 `setDragging(false)` 已经生效，
       * 所以状态里读到的永远是 false —— 表现就是「拖完自己就展开了」。
       * ref 在 pointerup 里置位、在这次 click 里消费并复位，才能可靠地吃掉那一次点击。
       */
      const onClick = React.useCallback(() => {
        if (justDraggedRef.current) {
          justDraggedRef.current = false;
          return;
        }
        togglePanelExpanded();
      }, []);

      // 需求：启用了才显示悬浮球。
      if (state.enabled !== true) return null;

      const runtime = state.runtime ?? { runs: [], busyCount: 0, tokPerS: 0, anyEstimated: false };
      const busyRuns = (runtime.runs ?? []).filter((run) => run.busy);
      const recentRuns = (runtime.runs ?? []).filter((run) => !run.busy).slice(0, 6);
      const agents = state.agents ?? [];

      // 收起态的轮播：多个在跑时每 2 秒换一个。
      const carouselRun = busyRuns.length > 0
        ? busyRuns[carouselIndex % busyRuns.length]
        : recentRuns[0];
      const orbBusy = busyRuns.length > 0;
      const orbName = carouselRun?.label || carouselRun?.agentName || (orbBusy ? "子 agent" : "子 agent 空闲");
      const orbRate = orbBusy
        ? `${carouselRun?.tokPerSEstimated === true && carouselRun.tokPerS > 0 ? "~" : ""}${carouselRun?.tokPerS ?? 0} tok/s`
        : "—";
      const orbTime = orbBusy
        ? formatDuration(now - (carouselRun?.startedAt ?? now))
        : formatDuration(carouselRun?.elapsedMs ?? 0);

      /**
       * 液面 = 上下文占用率，三档配色。
       *
       * 注意 `contextUsed === 0` 与「没有测量」是两件事：前者是「刚起步、上下文还很小」，
       * 后者是「还没有任何一步完成」。前者给 0（液面见底），后者给 null（不确定态，上下浮动）。
       * 空闲时也没有测量对象，同样给 null。
       */
      const measured = orbBusy && (carouselRun?.contextUsed ?? 0) > 0;
      const orbRatio = measured ? (carouselRun.contextRatio ?? 0) : null;
      const orbStage = orbBusy ? (carouselRun?.contextStage ?? "none") : "none";
      const contextLabel = measured
        ? `上下文 ${compactTokens(carouselRun.contextUsed)} / ${compactTokens(carouselRun.contextWindow)}`
          + `（${Math.round((carouselRun.contextRatio ?? 0) * 100)}%）`
          + `${carouselRun.contextWindowSource === "default" ? "（窗口为默认值 1M）" : ""}`
        : "";

      const rateText = `${runtime.anyEstimated && runtime.tokPerS > 0 ? "~" : ""}${runtime.tokPerS ?? 0} tok/s`;
      const collapsedLabel = busyRuns.length > 0
        ? busyRuns.map((run) => run.agentName).join(" + ")
        : "子 agent";

      // 三种形态：
      //  - 展开：卡片（详情打开时也用卡片，圆球里装不下实时对话）
      //  - 收起且空闲够久：贴边长条
      //  - 其余：圆球
      const showCard = panel.expanded === true || openRunId !== null;
      const showStrip = showCard === false && tucked === true && orbBusy === false;
      const showOrb = showCard === false && showStrip === false;

      return h("div", { className: "sbh-layer", style: showStrip ? stripPosition : position }, [
        showOrb
          ? h(OrbView, {
            key: "orb",
            name: orbName,
            rateText: orbRate,
            timeText: orbTime,
            ratio: orbRatio,
            stage: orbStage,
            index: carouselIndex,
            total: busyRuns.length,
            busy: orbBusy,
            contextLabel,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onClick,
            onPointerEnter: () => setHovered(true),
            onPointerLeave: () => setHovered(false),
          })
          : null,
        showStrip
          ? h(StripView, {
            key: "strip",
            name: orbName,
            ratio: orbRatio ?? 0,
            stage: orbStage,
            busy: orbBusy,
            contextLabel,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onClick,
            // 鼠标移上去就把球还回来：长条只是「别挡着」的待机形态，不是唯一入口。
            onPointerEnter: () => setHovered(true),
            onPointerLeave: () => setHovered(false),
          })
          : null,
        showCard ? h("div", { key: "card", className: `sbh-card${openRunId !== null ? " sbh-card--wide" : ""}` }, [
          // 头部：**展开态**的拖动把手。
          h("div", {
            key: "head",
            className: `sbh-head sbh-head--bordered${dragging ? " sbh-head--dragging" : ""}`,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onClick,
          }, [
            h("span", { key: "dot", className: `sbh-dot ${busyRuns.length > 0 ? "sbh-dot--busy" : "sbh-dot--idle"}` }),
            h("span", { key: "title", className: "sbh-title" }, collapsedLabel),
            h("span", { key: "spacer", className: "sbh-spacer" }),
            h("span", { key: "rate", className: "sbh-rate" }, rateText),
            h("button", {
              key: "chevron",
              type: "button",
              className: "sbh-icon",
              title: "收起",
              onClick: (event) => { event.stopPropagation(); togglePanelExpanded(); },
            }, "▾"),
          ]),
          state.error !== null && state.error !== undefined
            ? h("div", { key: "err", className: "sbh-foot" }, `⚠ ${state.error}`)
            : null,
          // 点开某次运行 → 换成详情面板（需求 2）。返回按钮回到列表。
          // 卡片只在「展开态或详情打开」时渲染，所以这里不需要再判 panel.expanded。
          openRunId !== null
            ? h(RunDetail, { key: "detail", runId: openRunId, onBack: () => setOpenRunId(null) })
            : h("div", { key: "body", className: "sbh-body" }, [
              // 正在跑的：名字 + tok/s + 已跑时长 + 工具数
              busyRuns.length > 0
                ? h("div", { key: "sec-busy", className: "sbh-section" }, `运行中（${busyRuns.length}）`)
                : null,
              ...busyRuns.map((run) => h("div", {
                key: run.runId,
                className: "sbh-row sbh-row--clickable",
                onClick: () => setOpenRunId(run.runId),
                title: "点开看会话与实时输入输出",
              }, [
                h("span", { key: "d", className: "sbh-dot sbh-dot--busy" }),
                h("div", { style: { minWidth: 0 }, key: "meta" }, [
                  h("div", { className: "sbh-name", key: "n", title: run.label || run.agentName },
                    run.label || run.agentName),
                  h("div", { className: "sbh-sub", key: "s", title: run.sessionId },
                    `${formatDuration(now - run.startedAt)}｜${run.tools} 次工具｜输出 ${compactTokens(run.tokensOut)} tok`),
                ]),
                h("div", { className: "sbh-metric", key: "m" }, `${run.tokPerSEstimated ? "~" : ""}${run.tokPerS}`),
              ])),

              // 任务链路图（0.2.0）：谁在做什么、谁在等谁，一眼看到。
              // 放在「运行中」之后、花名册之前——它是「现在在动的东西」的展开，
              // 而不是一份配置清单。
              h(PanelTasks, { key: "tasks", frame: state.tasks, onOpenRun: (runId) => setOpenRunId(runId) }),

              // 已配置但空闲的：让用户随时看到「我有哪些子 agent」。
              h("div", { key: "sec-roster", className: "sbh-section" }, `已配置（${agents.length}）`),
              agents.length === 0
                ? h("div", { key: "none", className: "sbh-empty" }, "还没有配置子 agent。在设置的「子 agent」页里添加一个。")
                : null,
              ...agents.map((agent) => {
                const busyRun = busyRuns.find((run) => run.agentName === agent.name);
                const idle = busyRun === undefined;
                return h("div", { key: agent.id, className: "sbh-row" }, [
                  h("span", { key: "d", className: `sbh-dot ${idle ? "sbh-dot--idle" : "sbh-dot--busy"}` }),
                  h("div", { style: { minWidth: 0 }, key: "meta" }, [
                    h("div", { className: "sbh-name", key: "n", title: agent.name }, agent.name),
                    h("div", { className: "sbh-sub", key: "s", title: `${agent.modelProvider}/${agent.modelId}` },
                      `${agent.modelProvider}/${agent.modelId}｜${agent.toolPolicyDetail?.policy === "readonly" ? "只读" : agent.toolPolicyDetail?.policy === "none" ? "无工具" : "全工具"}`),
                  ]),
                  h("div", { className: "sbh-metric", key: "m" }, idle ? "闲" : `忙 ${busyRun.tokPerS}`),
                ]);
              }),

              // 最近结束的：给「刚才那次怎么样」一个落点。
              recentRuns.length > 0 ? h("div", { key: "sec-recent", className: "sbh-section" }, "最近结束") : null,
              ...recentRuns.map((run) => h("div", {
                key: run.runId,
                className: "sbh-row sbh-row--clickable",
                onClick: () => setOpenRunId(run.runId),
                title: "点开看会话与实时输入输出",
              }, [
                h("span", {
                  key: "d",
                  className: `sbh-dot ${run.status === "completed" ? "sbh-dot--idle" : run.status === "queued" ? "sbh-dot--queued" : "sbh-dot--error"}`,
                }),
                h("div", { style: { minWidth: 0 }, key: "meta" }, [
                  h("div", { className: "sbh-name", key: "n", title: run.label || run.agentName },
                    run.label || run.agentName),
                  h("div", { className: "sbh-sub", key: "s", title: run.error || run.stopReason },
                    `${run.status}${run.error === "" || run.error === undefined ? "" : `：${run.error}`}`),
                ]),
                h("div", { className: "sbh-metric", key: "m" }, formatDuration(run.elapsedMs)),
              ])),
            ]),

          // 底部：常驻的状态与入口提示。
          h("div", { key: "foot", className: "sbh-foot" }, [
            h("span", { key: "badge", className: "sbh-badge sbh-badge--on" }, "已启用"),
            h("span", { key: "spacer", className: "sbh-spacer" }),
            h("span", { key: "hint" },
              runtime.queuedCount > 0
                ? `排队 ${runtime.queuedCount}（上限 ${runtime.maxConcurrentRuns}）`
                : `并发上限 ${runtime.maxConcurrentRuns}`),
          ]),
        ]) : null,
      ]);
    }

    /** 面板 UI 状态（展开/位置/贴哪一侧）也是一个可观察对象，便于拖动时局部重绘。 */
    const panelObservable = (() => {
      let state = loadPanelState();
      const listeners = new Set();
      const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* 忽略 */ } } };
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          state = next;
          savePanelState({ expanded: state.expanded, side: state.side, x: state.x, y: state.y });
          notify();
        },
      };
    })();

    /** 展开/收起并持久化。 */
    function togglePanelExpanded() {
      const current = panelObservable.getSnapshot();
      panelObservable.set({ ...current, expanded: !current.expanded });
    }
    //#endregion

    //#region 详情页（需求 2）
    /**
     * 跟一次运行的实时详情。
     *
     * 用「增量拉取」而不是每轮拉全文：详情页要跟着 token 走，但长产出一次几十 KB，
     * 每 800ms 重传一遍是纯浪费。服务端支持 `outputSince`，这里只拼接新增的那一段。
     *
     * 为什么不用 SSE 把 token 直接推进来：那条流是**全局**的（悬浮球要看所有运行的忙闲），
     * 把每个 token 都广播给每个页面，等于让「只看一眼悬浮球」的代价变得不可接受。
     * 按需拉取让代价只落在真正打开详情页的时候。
     *
     * @param {string|undefined} runId - 运行 id。
     * @returns {object} 详情状态。
     */
    function useRunDetail(runId) {
      const [state, setState] = React.useState({ live: null, run: null, output: "", error: null, source: "" });
      const outputRef = React.useRef("");

      React.useEffect(() => {
        if (typeof runId !== "string" || runId === "") return undefined;
        let cancelled = false;
        outputRef.current = "";
        setState({ live: null, run: null, output: "", error: null, source: "" });

        const tick = async () => {
          try {
            const response = await fetch(
              `${ENDPOINT}/runs/${encodeURIComponent(runId)}/detail?outputSince=${outputRef.current.length}`,
              { headers: { accept: "application/json" } },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (cancelled) return;
            if (payload.reset === true) outputRef.current = "";
            if (typeof payload.outputDelta === "string") {
              outputRef.current += payload.outputDelta;
            } else if (outputRef.current === "" && typeof payload.run?.outputTail === "string") {
              // 进程重启后内存遥测没了，只剩落库的正文尾部——如实回落，别显示空白。
              outputRef.current = payload.run.outputTail;
            }
            setState({
              live: payload.live ?? null,
              run: payload.run ?? null,
              output: outputRef.current,
              error: null,
              source: payload.source ?? "",
            });
          } catch (error) {
            if (!cancelled) setState((previous) => ({ ...previous, error: `拉取详情失败：${error?.message ?? error}` }));
          }
        };

        void tick();
        const timer = setInterval(() => { void tick(); }, 800);
        return () => { cancelled = true; clearInterval(timer); };
      }, [runId]);

      return state;
    }

    /**
     * 详情面板（**纯展示**）：数据全部由 props 给。
     *
     * 之所以把展示与取数分开：这样「拿真实负载渲染出正确的界面」这件事可以脱离浏览器被验证
     * （见 scripts/verify-client.mjs），而不必为了测一次渲染去装 jsdom。
     */
    function RunDetailView(props) {
      const { runId, onBack, t, detail, cancelling, onCancel } = props;
      const live = detail.live;
      const run = detail.run;
      const status = live?.status ?? run?.status ?? "unknown";
      const busy = live?.busy === true;
      const sessionId = live?.sessionId || run?.sessionId || "";
      const rate = live?.tokPerS ?? run?.tokPerS ?? 0;
      const estimated = live?.tokPerSEstimated === true;
      const elapsed = live?.elapsedMs ?? run?.durationMs ?? 0;
      const tokensOut = live?.tokensOut ?? run?.tokensOut ?? 0;
      const tools = live?.tools ?? [];
      const input = live?.input ?? run?.prompt ?? "";

      const block = (title, body, extra) => h("div", { className: "sbh-detail__block", key: title }, [
        h("div", { className: "sbh-detail__head", key: "h" }, [
          h("span", { key: "t" }, title),
          h("span", { key: "s", className: "sbh-spacer" }),
          extra ?? null,
        ]),
        body,
      ]);

      return h("div", { className: "sbh-detail" }, [
        h("div", { className: "sbh-detail__bar", key: "bar" }, [
          h("button", { key: "back", type: "button", className: "sbh-icon", onClick: onBack, title: "返回列表" }, "←"),
          h("span", { key: "name", className: "sbh-name" }, live?.agentName ?? run?.agentName ?? ""),
          h("span", { key: "status", className: `sbh-badge ${busy ? "sbh-badge--on" : "sbh-badge--off"}` }, status),
          h("span", { key: "spacer", className: "sbh-spacer" }),
          busy
            ? h("button", {
              key: "cancel", type: "button", className: "sbh-button", disabled: cancelling, onClick: onCancel,
            }, cancelling ? "取消中…" : "取消")
            : null,
        ]),

        detail.error !== null
          ? h("div", { className: "sbh-alert sbh-alert--error", key: "err" }, detail.error)
          : null,

        // 需求 2 的第一问：调用的会话是哪个。
        h("div", { className: "sbh-detail__meta", key: "meta" }, [
          h("div", { className: "sbh-detail__cell", key: "session" }, [
            h("span", { className: "sbh-detail__k", key: "k" }, "子会话 id"),
            h("code", {
              key: "v",
              className: "sbh-detail__v sbh-detail__v--mono",
              title: sessionId,
              onClick: () => { if (sessionId !== "") void navigator.clipboard?.writeText(sessionId); },
            }, sessionId === "" ? "（尚未发布）" : sessionId),
          ]),
          h("div", { className: "sbh-detail__cell", key: "rate" }, [
            h("span", { className: "sbh-detail__k", key: "k" }, "速度"),
            h("span", { className: "sbh-detail__v", key: "v" },
              `${estimated && rate > 0 ? "~" : ""}${rate} tok/s${estimated && rate > 0 ? "（估算）" : ""}`),
          ]),
          h("div", { className: "sbh-detail__cell", key: "tokens" }, [
            h("span", { className: "sbh-detail__k", key: "k" }, "输出 tokens"),
            h("span", { className: "sbh-detail__v", key: "v" }, group(tokensOut)),
          ]),
          h("div", { className: "sbh-detail__cell", key: "elapsed" }, [
            h("span", { className: "sbh-detail__k", key: "k" }, "耗时"),
            h("span", { className: "sbh-detail__v", key: "v" }, formatDuration(elapsed)),
          ]),
        ]),

        // 输入（交给子 agent 的完整任务）。
        block("输入", h("pre", { className: "sbh-pre", key: "in" }, input === "" ? "（还没有输入）" : input)),

        // 输出（实时）。
        block(
          "输出",
          h("pre", { className: "sbh-pre sbh-pre--out", key: "out" },
            detail.output === "" ? (busy ? "等待首个 token…" : "（没有产出文本）") : detail.output),
          h("span", { key: "len", className: "sbh-field__hint" }, `${group(detail.output.length)} 字符`),
        ),

        // 推理正文（如果有）。分开显示，别和答案混在一起——
        // 速率那个数字把推理 token 也算进去了，分开显示才看得出「快」是快在哪。
        typeof live?.reasoning === "string" && live.reasoning !== ""
          ? block("推理过程", h("pre", { className: "sbh-pre sbh-pre--dim", key: "r" }, live.reasoning))
          : null,

        // 工具活动：说明它到底做了什么。
        tools.length > 0
          ? block("工具活动", h("div", { className: "sbh-tools", key: "tools" }, tools.map((tool, index) => h("div", {
            className: "sbh-tools__row",
            key: `${tool.callId ?? index}`,
          }, [
            h("span", {
              key: "d",
              className: `sbh-dot ${tool.done ? (tool.isError ? "sbh-dot--error" : "sbh-dot--idle") : "sbh-dot--busy"}`,
            }),
            h("span", { key: "n", className: "sbh-detail__v--mono" }, tool.name),
            h("span", { key: "s", className: "sbh-spacer" }),
            h("span", { key: "t", className: "sbh-field__hint" }, tool.done ? (tool.isError ? "失败" : "完成") : "进行中"),
          ]))))
          : null,

        detail.source === "store"
          ? h("div", { className: "sbh-field__hint", key: "src" },
            "这次运行的内存遥测已不在（宿主重启过），显示的是落库的正文尾部；完整对话在 DSH 的会话日志里。")
          : null,
      ]);
    }

    /** 详情面板容器：负责按需增量拉取实时内容。 */
    function RunDetail(props) {
      const detail = useRunDetail(props.runId);
      const [cancelling, setCancelling] = React.useState(false);
      const onCancel = React.useCallback(async () => {
        setCancelling(true);
        try {
          await fetch(`${ENDPOINT}/runs/${encodeURIComponent(props.runId)}/cancel`, { method: "POST" });
        } catch {
          /* 取消失败就让它继续跑；用户会从状态里看到 */
        }
        setCancelling(false);
      }, [props.runId]);
      return h(RunDetailView, { ...props, detail, cancelling, onCancel });
    }
    //#endregion

    //#region 运行护栏（并发上限等）
    /**
     * 读当前配置。
     * @returns {object}
     */
    function useConfig() {
      const [state, setState] = React.useState({ items: [], userConfigPath: "", queued: 0, error: null });
      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const response = await fetch(`${ENDPOINT}/config`, { headers: { accept: "application/json" } });
            if (response.status === 404) {
              // 端点不存在只可能是「宿主还没重启」：客户端是热更新的，宿主不是。
              // 直接把这个原因说出来，而不是抛一个 HTTP 404 让用户去猜。
              if (!cancelled) {
                setState((previous) => ({
                  ...previous,
                  error: "宿主的 /config 端点还不存在——这部分是宿主代码，需要重启一次 dsh web 才会生效。",
                }));
              }
              return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (!cancelled) {
              setState({
                items: payload.items ?? [],
                userConfigPath: payload.userConfigPath ?? "",
                queued: payload.queued ?? 0,
                error: null,
              });
            }
          } catch (error) {
            if (!cancelled) setState((previous) => ({ ...previous, error: `拉取配置失败：${error?.message ?? error}` }));
          }
        };
        void load();
        const timer = setInterval(() => { void load(); }, 10000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);
      return state;
    }

    /**
     * 运行护栏（**纯展示**）：把服务端给的 items 渲染成可编辑表单。
     *
     * 「哪些能改」由服务端决定（`live` 标志），客户端不重复判断——
     * 否则两边规则迟早会漂。不可热改的项照样显示、但标明只能在文件里改，
     * 因为「看不见的配置项」和「不能改的配置项」是两回事。
     */
    function RunGuardsView(props) {
      const { items, userConfigPath, queued, draft, errors, saving, notice, onDraft, onSave, onReset, t } = props;

      const control = (item) => {
        const value = draft[item.key];
        if (item.type === "boolean") {
          return h("label", { className: "sbh-check", key: "c" }, [
            h("input", {
              key: "i",
              type: "checkbox",
              checked: value === true,
              disabled: item.live !== true,
              onChange: (event) => onDraft(item.key, event.target.checked),
            }),
            h("span", { key: "s" }, value === true ? "开" : "关"),
          ]);
        }
        if (item.type === "stringArray") {
          return h("textarea", {
            key: "c",
            className: "sbh-input sbh-textarea",
            rows: 3,
            disabled: item.live !== true,
            value: Array.isArray(value) ? value.join("\n") : "",
            placeholder: "每行一个工具名；留空 = 用内置默认",
            onChange: (event) => onDraft(item.key, event.target.value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "")),
          });
        }
        return h("input", {
          key: "c",
          className: "sbh-input",
          type: "number",
          min: 0,
          disabled: item.live !== true,
          value: String(value ?? 0),
          onChange: (event) => onDraft(item.key, event.target.value === "" ? 0 : Number(event.target.value)),
        });
      };

      return h("div", { className: "sbh-guards" }, [
        h("div", { className: "sbh-section", key: "head" }, t?.("guards.title") ?? "运行护栏"),
        h("div", { className: "sbh-field__hint", key: "intro" },
          "改完立刻对后续行为生效，并写进用户层配置文件。调大并发上限时，排队中的任务会马上升级为运行中。"),

        errors.length > 0 ? h("div", { className: "sbh-alert sbh-alert--error", key: "err" }, errors.join("；")) : null,
        notice !== "" ? h("div", { className: "sbh-alert sbh-alert--ok", key: "ok" }, notice) : null,

        h("div", { className: "sbh-grid", key: "grid" }, items.map((item) => h("label", {
          className: `sbh-field${item.live === true ? "" : " sbh-field--locked"}`,
          key: item.key,
        }, [
          h("span", { className: "sbh-field__label", key: "l" }, [
            item.label,
            item.live === true ? null : h("span", { key: "lock", className: "sbh-badge sbh-badge--off" }, "需重启"),
          ]),
          h("span", { className: "sbh-field__control", key: "c" }, control(item)),
          h("span", { className: "sbh-field__hint", key: "h" }, item.hint),
        ]))),

        h("div", { className: "sbh-form__actions", key: "actions" }, [
          h("button", {
            key: "save", type: "button", className: "sbh-button sbh-button--primary",
            disabled: saving, onClick: () => { void onSave(); },
          }, saving ? "保存中…" : "保存"),
          h("button", { key: "reset", type: "button", className: "sbh-button", onClick: onReset }, "重置为当前值"),
          h("span", { key: "spacer", className: "sbh-spacer" }),
          h("span", { key: "queue", className: "sbh-field__hint" },
            queued > 0 ? `排队中 ${queued}` : "没有排队中的运行"),
        ]),
        h("div", { className: "sbh-field__hint", key: "path" }, `配置文件：${userConfigPath}`),
      ]);
    }

    /** 运行护栏的容器：取数、本地草稿、保存。 */
    function RunGuards() {
      const config = useConfig();
      const [draft, setDraft] = React.useState({});
      const [errors, setErrors] = React.useState([]);
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState("");

      // 服务端值到了就铺进草稿（保留用户还没保存的编辑）。
      React.useEffect(() => {
        if (config.items.length === 0) return;
        setDraft((current) => {
          const next = { ...current };
          for (const item of config.items) {
            if (!(item.key in next)) next[item.key] = item.value;
          }
          return next;
        });
      }, [config.items.length]);

      const onDraft = React.useCallback((key, value) => {
        setDraft((current) => ({ ...current, [key]: value }));
      }, []);

      const onReset = React.useCallback(() => {
        const next = {};
        for (const item of config.items) next[item.key] = item.value;
        setDraft(next);
        setErrors([]);
        setNotice("");
      }, [config.items]);

      const onSave = React.useCallback(async () => {
        setSaving(true);
        setErrors([]);
        setNotice("");
        // 只发**可热改**且**确实变了**的项：把「需重启」的项发出去只会换来一次失败。
        const patch = {};
        for (const item of config.items) {
          if (item.live !== true) continue;
          const value = draft[item.key];
          if (JSON.stringify(value) !== JSON.stringify(item.value)) patch[item.key] = value;
        }
        if (Object.keys(patch).length === 0) {
          setSaving(false);
          setNotice("没有需要保存的改动");
          return;
        }
        try {
          const response = await fetch(`${ENDPOINT}/config`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const payload = await response.json();
          setSaving(false);
          if (!response.ok) {
            setErrors(payload?.errors ?? [payload?.error ?? "保存失败"]);
            return;
          }
          const applied = payload.applied ?? {};
          setNotice(`已保存：${Object.entries(applied).map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.length} 项]` : value}`).join("，")}（立刻生效）`);
        } catch (error) {
          setSaving(false);
          setErrors([`保存失败：${error?.message ?? error}`]);
        }
      }, [draft, config.items]);

      return h(RunGuardsView, {
        items: config.items,
        userConfigPath: config.userConfigPath,
        queued: config.queued,
        draft,
        errors: errors.length > 0 ? errors : (config.error === null ? [] : [config.error]),
        saving,
        notice,
        onDraft,
        onSave,
        onReset,
      });
    }
    //#endregion

    //#region 排名与回归（需求 5）
    /**
     * 排名与跨轮回归的数据。
     *
     * 口径一致性的关键：**这两块的口径完全由宿主决定**（`agentLeaderboard` / `regressionByTask`），
     * 客户端只负责呈现，不自己算名次——否则页面上会出现两套互相矛盾的口径。
     * @returns {object}
     */
    function useBoards() {
      const [state, setState] = React.useState({ leaderboard: [], regression: [], error: null });
      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const [boardResponse, regressionResponse] = await Promise.all([
              fetch(`${ENDPOINT}/leaderboard`, { headers: { accept: "application/json" } }),
              fetch(`${ENDPOINT}/regression`, { headers: { accept: "application/json" } }),
            ]);
            if (!boardResponse.ok || !regressionResponse.ok) {
              throw new Error(`HTTP ${boardResponse.status}/${regressionResponse.status}`);
            }
            const board = await boardResponse.json();
            const regression = await regressionResponse.json();
            if (!cancelled) {
              setState({
                leaderboard: board.leaderboard ?? [],
                regression: regression.regression ?? [],
                error: null,
              });
            }
          } catch (error) {
            if (!cancelled) setState((previous) => ({ ...previous, error: `拉取排名失败：${error?.message ?? error}` }));
          }
        };
        void load();
        const timer = setInterval(() => { void load(); }, 10000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);
      return state;
    }

    /** 排名表 + 跨轮回归表（**纯展示**，数据由 props 给，便于脱离浏览器验证）。 */
    function BoardsView(props) {
      const { leaderboard, regression, error } = props;
      const ranked = leaderboard.filter((row) => row.runs > 0 || row.evaluations > 0);

      return h("div", { className: "sbh-boards" }, [
        error !== null && error !== undefined ? h("div", { className: "sbh-alert sbh-alert--error", key: "err" }, error) : null,

        h("div", { className: "sbh-section", key: "rank-head" }, "排名（按均分 → 成功率 → 次数）"),
        ranked.length === 0
          ? h("div", { className: "sbh-empty", key: "rank-empty" },
            "还没有已完成的运行。委派一次任务并打分后，这里会出现排名。")
          : h("table", { className: "sbh-table", key: "rank" }, [
            h("thead", { key: "h" }, h("tr", null, [
              h("th", { key: "i" }, "#"),
              h("th", { key: "n" }, "子 agent"),
              h("th", { key: "s" }, "均分"),
              h("th", { key: "r" }, "成功率"),
              h("th", { key: "c" }, "次数"),
              h("th", { key: "t" }, "tok/s"),
            ])),
            h("tbody", { key: "b" }, ranked.map((row, index) => h("tr", { key: row.agentId }, [
              h("td", { key: "i", className: "sbh-table__rank" }, String(index + 1)),
              h("td", { key: "n" }, [
                h("div", { key: "nm", className: "sbh-name" }, row.agentName),
                h("div", { key: "md", className: "sbh-sub" }, `${row.modelProvider}/${row.modelId}`),
              ]),
              h("td", { key: "s", className: "sbh-table__num" }, row.avgScore === null ? "—" : String(row.avgScore)),
              h("td", { key: "r", className: "sbh-table__num" },
                row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`),
              h("td", { key: "c", className: "sbh-table__num" },
                row.evaluations > 0 ? `${row.runs}（评 ${row.evaluations}）` : String(row.runs)),
              h("td", { key: "t", className: "sbh-table__num" }, row.avgTokPerS === null ? "—" : String(row.avgTokPerS)),
            ]))),
          ]),

        h("div", { className: "sbh-section", key: "reg-head" }, "跨轮回归（同一 task_key 的分数变化）"),
        regression.length === 0
          ? h("div", { className: "sbh-empty", key: "reg-empty" },
            "还没有跨轮数据。给 subagent_run 传同一个 task_key 并分轮重跑，这里就会显示「这一轮比上一轮退步了没有」。")
          : h("div", { className: "sbh-regression", key: "reg" }, regression.map((series) => h("div", {
            className: "sbh-regression__series",
            key: `${series.taskKey}\u0000${series.agentId}`,
          }, [
            h("div", { className: "sbh-regression__head", key: "h" }, [
              h("span", { key: "t", className: "sbh-name" }, series.taskKey),
              h("span", { key: "a", className: "sbh-sub" }, series.agentName),
              h("span", { key: "s", className: "sbh-spacer" }),
              series.overallDelta === null
                ? h("span", { key: "d", className: "sbh-field__hint" }, "只有一轮，无法比较")
                : h("span", {
                  key: "d",
                  className: `sbh-delta ${series.overallDelta < 0 ? "sbh-delta--down" : series.overallDelta > 0 ? "sbh-delta--up" : ""}`,
                }, `${series.overallDelta > 0 ? "+" : ""}${series.overallDelta}`),
            ]),
            h("div", { className: "sbh-regression__rounds", key: "r" }, series.rounds.map((round, index) => h("span", {
              className: "sbh-regression__round",
              key: `${round.roundId ?? "none"}-${index}`,
              title: round.deltaVsPrevious === null ? "首轮" : `相对上一轮 ${round.deltaVsPrevious > 0 ? "+" : ""}${round.deltaVsPrevious}`,
            }, [
              h("span", { key: "v", className: "sbh-table__num" }, round.avgScore === null ? "—" : String(round.avgScore)),
              round.deltaVsPrevious === null
                ? null
                : h("span", {
                  key: "d",
                  className: `sbh-delta ${round.deltaVsPrevious < 0 ? "sbh-delta--down" : round.deltaVsPrevious > 0 ? "sbh-delta--up" : ""}`,
                }, `${round.deltaVsPrevious > 0 ? "+" : ""}${round.deltaVsPrevious}`),
            ]))),
          ]))),
      ]);
    }

    /** 排名/回归的容器：负责取数与轮询。 */
    function Boards() {
      const boards = useBoards();
      return h(BoardsView, { leaderboard: boards.leaderboard, regression: boards.regression, error: boards.error });
    }
    //#endregion
/**
 * 任务链路图（0.2.0）：把「一条清单走到哪一步」画成一张读得懂的图。
 *
 * ## 为什么整张图画在一个 SVG 里，而不是用 div + CSS 连线
 *
 * 连线要跨过节点之间的空白、要带箭头、要在「依赖已解锁」时改变线型。用 div 做只能靠
 * 绝对定位的假线（一条旋转的 div），一旦层数或节点宽度变了就会错位；而错位的连线
 * 比没有连线更糟——它会让人读出一条**并不存在**的依赖。SVG 里坐标就是坐标。
 *
 * ## 三个刻意的取舍
 *
 * 1. **分层只看宿主的 `depth`。** 「哪些任务能同时跑」是链路的语义，宿主（`plan.js`）
 *    已经算过一遍；这里再算一次就有了第二份口径，两边一旦不一致，图上会说
 *    「它们能并行」而调度器其实是串行跑的。绘图只负责把 depth 摆成一列一列。
 * 2. **颜色/线型各表示一件事。** 状态只走「底色 + 左侧色条 + 状态字」，
 *    依赖是否解锁只走「实线 / 虚线 / 流动虚线」。两套信息用两个通道，才不会互相干扰。
 * 3. **动效只给「正在动的东西」。** 运行中的节点呼吸、活跃连线流动；其余一律静止。
 *
 * 面板（348px 宽）与设置页（整页宽）共用同一份布局函数，只是节点尺寸不同——
 * 图只有一套算法，所以两处不会出现「同一份数据画出来不一样」。
 */

//#region 任务链路的常量与纯函数

/** 状态顺序：图例、进度条分段、排序都按它（固定顺序 = 稳定的视觉）。 */
const TASK_STATE_ORDER = ["running", "ready", "waiting", "done", "failed", "blocked", "cancelled"];

/** 状态文案（与宿主 plan.js 的 STATE_LABELS 同一套语言，界面与提示词不能各说各话）。 */
const TASK_STATE_LABEL = {
  waiting: "等待依赖",
  ready: "可执行",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  blocked: "被上游阻塞",
  cancelled: "已取消",
};

/** 状态图标：只用字体里一定有的几何符号，避免 emoji 在不同系统上大小不一。 */
const TASK_STATE_GLYPH = {
  waiting: "⋯",
  ready: "►",
  running: "●",
  done: "✓",
  failed: "✕",
  blocked: "⊘",
  cancelled: "–",
};

/** 图的尺寸（面板用的是缩小版，见 PanelTasks）。 */
const GRAPH_METRICS = Object.freeze({
  padX: 10, padY: 10, gapX: 40, gapY: 14, nodeW: 180, nodeH: 64, titleUnits: 15, maxTitleLines: 2,
});

/** 面板里的缩小版：宽度只有 348，节点要能一列看懂。 */
const GRAPH_METRICS_COMPACT = Object.freeze({
  padX: 8, padY: 8, gapX: 30, gapY: 12, nodeW: 150, nodeH: 60, titleUnits: 12, maxTitleLines: 2,
});

/**
 * 文本的视觉宽度（以**一个汉字**为 1 个单位）。
 *
 * 为什么要自己算：SVG 里没有 text-overflow，超出的文字会直接画到框外。
 * 而「混排」是常态（中文标题里夹英文与数字），按字符数截断会把
 * 「把 release 0.2.0 发出去」这种标题截得忽长忽短。拉丁字符按 0.55 个单位近似。
 * @param {string} text - 文本。
 * @returns {number}
 */
function visualWidth(text) {
  let total = 0;
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0) ?? 0;
    total += code < 0x2e80 && code !== 0x200b ? 0.55 : 1;
  }
  return total;
}

/**
 * 按视觉宽度截断，超出部分以 … 结尾。
 * @param {string} text - 文本。
 * @param {number} maxUnits - 最大单位数。
 * @returns {string}
 */
function truncateVisual(text, maxUnits) {
  const source = String(text ?? "");
  if (visualWidth(source) <= maxUnits) return source;
  let out = "";
  let used = 0;
  for (const char of source) {
    const code = char.codePointAt(0) ?? 0;
    const cost = code < 0x2e80 ? 0.55 : 1;
    if (used + cost > maxUnits - 1) break;
    out += char;
    used += cost;
  }
  return `${out}…`;
}

/**
 * 折行（最多 maxLines 行，最后一行放不下就用 … 收尾）。
 * @param {string} text - 文本。
 * @param {number} maxUnits - 每行最大单位数。
 * @param {number} maxLines - 最多几行。
 * @returns {string[]}
 */
function wrapLabel(text, maxUnits, maxLines) {
  const source = String(text ?? "").trim();
  if (source === "") return [];
  const lines = [];
  let current = "";
  let used = 0;
  for (const char of source) {
    const code = char.codePointAt(0) ?? 0;
    const cost = code < 0x2e80 ? 0.55 : 1;
    if (used + cost > maxUnits) {
      lines.push(current);
      current = "";
      used = 0;
      if (lines.length === maxLines) break;
    }
    current += char;
    used += cost;
  }
  if (lines.length < maxLines && current !== "") lines.push(current);
  if (lines.length === maxLines) {
    const consumed = lines.join("");
    if (consumed.length < source.length) {
      lines[maxLines - 1] = truncateVisual(lines[maxLines - 1], maxUnits);
    }
  }
  return lines;
}

/**
 * 连线的贝塞尔路径（水平出入，控制点各占一半间距）。
 * @param {number} x1 - 起点 x。
 * @param {number} y1 - 起点 y。
 * @param {number} x2 - 终点 x。
 * @param {number} y2 - 终点 y。
 * @param {number} gap - 层间距（决定弯曲程度）。
 * @returns {string}
 */
function edgePath(x1, y1, x2, y2, gap) {
  const bend = Math.max(14, gap * 0.55);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/**
 * 一条依赖边的视觉状态：由**上游**决定（它解锁了没有）。
 * @param {string} fromState - 上游任务状态。
 * @returns {'done'|'active'|'pending'}
 */
function edgeVisualState(fromState) {
  if (fromState === "done") return "done";
  if (fromState === "running") return "active";
  return "pending";
}

/**
 * 节点第二行（元信息）：一眼看出「这个任务现在卡在哪 / 在做什么」。
 * @param {object} task - 任务视图条目。
 * @returns {string}
 */
function taskMetaLine(task) {
  const agent = task.agentName ?? "";
  const live = task.live ?? null;
  if (task.state === "running") {
    const rate = live !== null && live.tokPerS > 0
      ? ` · ${live.tokPerSEstimated === true ? "~" : ""}${live.tokPerS} tok/s`
      : "";
    const queued = task.runStatus === "queued" ? "排队中" : "运行中";
    const tools = live !== null && live.tools > 0 ? ` · ${live.tools} 工具` : "";
    return `${agent} · ${queued}${rate}${tools}`;
  }
  if (task.state === "waiting") {
    const waiting = Array.isArray(task.waitingFor) && task.waitingFor.length > 0 ? task.waitingFor.join("、") : "上游";
    return `${agent} · 等 ${waiting}`;
  }
  if (task.state === "blocked") {
    const blocked = Array.isArray(task.blockedBy) && task.blockedBy.length > 0 ? task.blockedBy.join("、") : "上游";
    return `${agent} · ${blocked} 失败/取消`;
  }
  if (task.state === "ready") return `${agent} · 等待激活`;
  if (task.state === "failed") return `${agent} · ${task.note !== "" ? truncateVisual(task.note, 22) : "失败"}`;
  if (task.state === "cancelled") return `${agent} · 已被取消`;
  const duration = task.endedAt !== null && task.startedAt !== null ? Math.round((task.endedAt - task.startedAt) / 1000) : null;
  return `${agent}${duration === null ? "" : ` · 用时 ${formatDuration(duration * 1000)}`}`;
}

/**
 * 任务图布局（纯函数：同样的输入永远得到同样的坐标）。
 *
 * 结果里 `nodes` 与 `edges` 都带上了画图需要的全部信息，组件只负责把它们
 * 变成 SVG 元素——这样布局可以在没有浏览器的地方被验证（见 scripts/verify-client.mjs）。
 *
 * @param {object} view - 清单视图（`tasks` 里带 `depth`）。
 * @param {object} [metrics] - 尺寸覆盖。
 * @returns {{width:number,height:number,nodes:object[],edges:object[],columns:string[][]}}
 */
function graphLayout(view, metrics = {}) {
  const size = { ...GRAPH_METRICS, ...metrics };
  const tasks = Array.isArray(view?.tasks) ? view.tasks : [];
  const edgesIn = Array.isArray(view?.edges) ? view.edges : [];

  // 按 (层, 建单顺序) 排：层内顺序稳定，动画与重排都不会让节点跳来跳去。
  const byDepth = new Map();
  for (const task of [...tasks].sort((left, right) => ((left.depth ?? 0) - (right.depth ?? 0)) || ((left.seq ?? 0) - (right.seq ?? 0)))) {
    const depth = Number.isFinite(task.depth) ? task.depth : 0;
    const list = byDepth.get(depth) ?? [];
    list.push(task);
    byDepth.set(depth, list);
  }
  const depths = [...byDepth.keys()].sort((left, right) => left - right);
  const maxRows = Math.max(1, ...depths.map((depth) => byDepth.get(depth).length));
  const height = size.padY * 2 + maxRows * (size.nodeH + size.gapY) - size.gapY;
  const width = size.padX * 2
    + (depths.length === 0 ? size.nodeW : (depths[depths.length - 1] - depths[0]) * (size.nodeW + size.gapX) + size.nodeW);

  const placed = new Map();
  const nodes = [];
  for (const depth of depths) {
    const list = byDepth.get(depth);
    const columnHeight = list.length * (size.nodeH + size.gapY) - size.gapY;
    // 垂直居中：多行的那一列撑开画布，短的列居中——比顶对齐更像一张流程图。
    const offset = size.padY + (height - size.padY * 2 - columnHeight) / 2;
    list.forEach((task, index) => {
      const node = {
        id: task.id,
        task,
        x: size.padX + (depth - depths[0]) * (size.nodeW + size.gapX),
        y: offset + index * (size.nodeH + size.gapY),
        w: size.nodeW,
        h: size.nodeH,
        lines: wrapLabel(task.title, size.titleUnits, size.maxTitleLines),
        // 元信息在布局阶段就截断：SVG 没有 text-overflow，超出的字会被画到框外，
        // 而「画到框外」比截断难看得多。截断规则跟着节点宽度走，所以放在这里而不是组件里。
        meta: truncateVisual(taskMetaLine(task), size.titleUnits + 4),
        glyph: TASK_STATE_GLYPH[task.state] ?? "·",
        label: TASK_STATE_LABEL[task.state] ?? task.state,
      };
      placed.set(task.id, node);
      nodes.push(node);
    });
  }

  const stateOf = new Map(tasks.map((task) => [task.id, task.state]));
  const edges = [];
  for (const edge of edgesIn) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (from === undefined || to === undefined) continue;
    edges.push({
      key: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      state: edgeVisualState(stateOf.get(edge.from)),
      path: edgePath(from.x + from.w, from.y + from.h / 2, to.x, to.y + to.h / 2, size.gapX),
    });
  }

  return { width, height, nodes, edges, columns: depths.map((depth) => byDepth.get(depth).map((task) => task.id)) };
}

/**
 * 进度条的分段（按状态计数，宽度按任务数占比）。
 * @param {object} progress - 宿主给的进度（含各状态计数）。
 * @returns {{segments:object[],percent:number,done:number,total:number}}
 */
function progressView(progress) {
  const safe = progress ?? {};
  const total = Number(safe.total ?? 0);
  const segments = TASK_STATE_ORDER
    .map((state) => ({ state, value: Number(safe[state] ?? 0) }))
    .filter((segment) => segment.value > 0)
    .map((segment) => ({ ...segment, flex: total === 0 ? 0 : (segment.value / total) * 100 }));
  return {
    segments,
    percent: Number(safe.percent ?? 0),
    done: Number(safe.done ?? 0),
    total,
  };
}

//#endregion

//#region 任务链路的组件

/**
 * 分段进度条：**不是**一根「完成度」的条，而是「任务都分布在哪些状态」——
 * 一条链路卡住时，用户要看的是「多少在等、多少被阻塞」，而不是一个百分比。
 */
function TaskProgress(props) {
  const { progress } = props;
  const view = progressView(progress);
  if (view.total === 0) return null;
  return h("div", { className: "sbh-progress", title: `完成 ${view.done}/${view.total}（${view.percent}%）` },
    view.segments.map((segment) => h("div", {
      key: segment.state,
      className: `sbh-progress__seg sbh-progress__seg--${segment.state}`,
      style: { width: `${segment.flex}%` },
      title: `${TASK_STATE_LABEL[segment.state] ?? segment.state} ${segment.value}`,
    })));
}

/** 图例：颜色说明 + 各状态计数（图上有颜色，就必须有对照表）。 */
function TaskLegend(props) {
  const { progress } = props;
  const safe = progress ?? {};
  const items = TASK_STATE_ORDER
    .filter((state) => Number(safe[state] ?? 0) > 0)
    .map((state) => h("span", { key: state, className: "sbh-legend__item" }, [
      h("span", { key: "d", className: `sbh-legend__dot sbh-legend__dot--${state}` }),
      h("span", { key: "l" }, TASK_STATE_LABEL[state]),
      h("span", { key: "c", className: "sbh-legend__count" }, String(safe[state])),
    ]));
  if (items.length === 0) return null;
  return h("div", { className: "sbh-legend" }, items);
}

/** 一张状态徽标（明细列表与面板共用）。 */
function TaskStateBadge(props) {
  const { task } = props;
  const state = task?.state ?? "waiting";
  return h("span", {
    className: `sbh-task__badge sbh-task__badge--${state}`,
    title: TASK_STATE_LABEL[state] ?? state,
  }, [
    h("span", { key: "g" }, TASK_STATE_GLYPH[state] ?? "·"),
    h("span", { key: "l" }, TASK_STATE_LABEL[state] ?? state),
  ]);
}

/**
 * 依赖图本体（**纯展示**：数据全部来自 props，便于脱离浏览器验证）。
 *
 * @param {object} props - `{view, metrics, onOpenRun, highlightTaskId}`。
 * @returns {any}
 */
function TaskGraph(props) {
  const { view, metrics, onOpenRun } = props;
  const layout = graphLayout(view, metrics);
  if (layout.nodes.length === 0) return null;

  const markers = ["pending", "done", "active"].map((state) => h("marker", {
    key: state,
    id: `sbh-graph-arrow-${state}`,
    markerWidth: 7,
    markerHeight: 7,
    refX: 6,
    refY: 3.2,
    orient: "auto",
    markerUnits: "strokeWidth",
  }, h("path", {
    d: "M0,0 L6,3.2 L0,6.4 z",
    className: `sbh-edge__arrow--${state}`,
  })));

  return h("div", { className: "sbh-graph" },
    h("div", { className: "sbh-graph__scroll" },
      h("svg", {
        className: "sbh-graph__svg",
        width: layout.width,
        height: layout.height,
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        xmlns: "http://www.w3.org/2000/svg",
      }, [
        h("defs", { key: "defs" }, markers),

        // 连线先画（画在节点下面）：箭头压在节点上的视觉噪音比断线更难读。
        ...layout.edges.map((edge) => h("path", {
          key: edge.key,
          className: `sbh-edge sbh-edge--${edge.state}`,
          d: edge.path,
          markerEnd: `url(#sbh-graph-arrow-${edge.state})`,
        })),

        ...layout.nodes.map((node) => {
          const task = node.task;
          const clickable = typeof onOpenRun === "function" && task.runId !== "";
          const classes = [
            "sbh-node",
            `sbh-node--${task.state}`,
            clickable ? "sbh-node--clickable" : "",
          ].filter((name) => name !== "").join(" ");
          return h("g", {
            key: node.id,
            className: classes,
            onClick: clickable ? () => onOpenRun(task.runId) : undefined,
          }, [
            h("rect", {
              key: "glow",
              className: "sbh-node__glow",
              x: node.x - 2.5,
              y: node.y - 2.5,
              width: node.w + 5,
              height: node.h + 5,
              rx: 11,
            }),
            h("rect", {
              key: "box",
              className: "sbh-node__box",
              x: node.x,
              y: node.y,
              width: node.w,
              height: node.h,
              rx: 9,
            }),
            h("rect", {
              key: "accent",
              className: "sbh-node__accent",
              x: node.x + 1,
              y: node.y + 8,
              width: 3,
              height: node.h - 16,
              rx: 1.5,
            }),
            h("text", {
              key: "id",
              className: "sbh-node__id",
              x: node.x + 11,
              y: node.y + 17,
              fontSize: 9.5,
            }, node.id),
            h("text", {
              key: "chip",
              className: "sbh-node__chip",
              x: node.x + node.w - 11,
              y: node.y + 17,
              fontSize: 9.5,
              textAnchor: "end",
            }, `${node.glyph} ${node.label}`),
            ...node.lines.map((line, index) => h("text", {
              key: `line-${index}`,
              className: "sbh-node__title",
              x: node.x + 11,
              y: node.y + 36 + index * 12,
              fontSize: 11,
            }, line)),
            h("text", {
              key: "meta",
              className: "sbh-node__meta",
              x: node.x + 11,
              y: node.y + node.h - 8,
              fontSize: 9,
            }, node.meta),
          ]);
        }),
      ]))); // eslint-disable-line
}

/**
 * 一条链路的完整卡片（标题 + 进度 + 图例 + 图 + 明细/操作）。
 *
 * @param {object} props - `{view, metrics, actions, onOpenRun, busy, showTasks}`。
 * @returns {any}
 */
function PlanCard(props) {
  const { view, metrics, actions, onOpenRun, busy, showTasks } = props;
  const plan = view.plan ?? {};
  const progress = view.progress ?? {};
  const head = [
    h("span", { key: "t", className: "sbh-tasks__title", title: plan.title }, plan.title ?? "(未命名清单)"),
    h("span", { key: "s", className: "sbh-spacer" }),
    h("span", { key: "p", className: "sbh-tasks__sub" }, `${progress.done ?? 0}/${progress.total ?? 0} · ${progress.percent ?? 0}%`),
  ];

  return h("div", { className: "sbh-plan" }, [
    h("div", { key: "head", className: "sbh-tasks__head" }, head),

    h("div", { key: "flag", className: "sbh-tasks__head" }, [
      h("span", {
        key: "auto",
        className: `sbh-badge ${plan.autoActivate === true ? "sbh-badge--on" : "sbh-badge--off"}`,
        title: plan.autoActivate === true
          ? "依赖一完成，宿主会自动激活下游任务"
          : "这条清单不自动推进：任务完成后只标成「可执行」，等手动激活",
      }, plan.autoActivate === true ? "自动激活" : "手动激活"),
      plan.activationError !== undefined && plan.activationError !== "" 
        ? h("span", { key: "err", className: "sbh-sub", title: plan.activationError }, truncateVisual(plan.activationError, 26))
        : null,
    ]),

    h(TaskProgress, { key: "progress", progress }),
    h(TaskLegend, { key: "legend", progress }),
    h(TaskGraph, { key: "graph", view, metrics, onOpenRun }),

    view.next !== undefined && view.next !== "" ? h("div", { key: "next", className: "sbh-sub" }, view.next) : null,

    actions !== undefined ? h("div", { key: "actions", className: "sbh-task__actions" }, actions) : null,

    showTasks === false ? null : h("div", { key: "tasks" }, (view.tasks ?? []).map((task) => h("div", {
      key: task.id,
      className: "sbh-task",
    }, [
      h(TaskStateBadge, { key: "badge", task }),
      h("div", { key: "meta", style: { minWidth: 0 } }, [
        h("div", { key: "name", className: "sbh-name", title: task.title },
          `${task.id} ${task.title}`),
        h("div", { key: "sub", className: "sbh-sub" }, [
          taskMetaLine(task),
          task.runId !== "" && typeof onOpenRun === "function"
            ? h("span", {
              key: "run",
              className: "sbh-mini-btn",
              style: { marginLeft: "6px" },
              onClick: () => onOpenRun(task.runId),
            }, "看运行")
            : null,
        ]),
      ]),
      task.attempts > 1 ? h("span", { key: "attempts", className: "sbh-sub" }, `第 ${task.attempts} 次`) : null,
    ]))),
  ]);
}

//#endregion

//#region 面板与设置页的接线

/**
 * 面板里的紧凑区块：最新几条链路 + 一张缩小的图。
 *
 * 只画**最近使用的**那条清单（可以在标签之间切换）：悬浮球面板的职责是
 * 「现在发生了什么」，把全部历史都塞进来会把它变回一个看不懂的列表。
 * @param {object} props - `{frame, onOpenRun}`。
 * @returns {any}
 */
function PanelTasks(props) {
  const { frame, onOpenRun } = props;
  const plans = frame !== undefined && Array.isArray(frame.plans) ? frame.plans : [];
  // 注意：hook 必须在任何 return 之前——没有链路时早期返回是常见写法，
  // 但它会让下一个有链路的渲染多出一个 hook，React 会直接报错（这是 hook 规则里最容易踩的一条）。
  const [selected, setSelected] = React.useState("");
  if (plans.length === 0) return null;

  // 默认选中「现在真的在动」的那条：列表按新建时间倒序，但最新建的一条
  // 未必是正在跑的那条（比如它已经跑完了，而更早的一条还在跑）。
  const alive = plans.find((view) => Number(view.progress?.active ?? 0) > 0
    || Number(view.progress?.ready ?? 0) > 0
    || Number(view.progress?.waiting ?? 0) > 0);
  const active = plans.find((view) => view.plan?.id === selected) ?? alive ?? plans[0];
  const plan = active.plan ?? {};
  const progress = active.progress ?? {};
  const tabs = plans.length > 1
    ? h("div", { className: "sbh-tabs" }, plans.map((view) => h("button", {
      key: view.plan?.id ?? "",
      type: "button",
      className: `sbh-tab${(view.plan?.id ?? "") === (plan.id ?? "") ? " sbh-tab--on" : ""}`,
      onClick: () => setSelected(view.plan?.id ?? ""),
      title: `${view.plan?.title ?? ""}（${view.progress?.done ?? 0}/${view.progress?.total ?? 0}）`,
    }, `${view.plan?.title ?? "清单"} ${view.progress?.done ?? 0}/${view.progress?.total ?? 0}`)))
    : null;

  return h("div", { className: "sbh-tasks" }, [
    h("div", { key: "head", className: "sbh-tasks__head" }, [
      h("span", { key: "dot", className: `sbh-dot ${Number(progress.active ?? 0) > 0 ? "sbh-dot--busy" : "sbh-dot--idle"}` }),
      h("span", { key: "t", className: "sbh-tasks__title", title: plan.title }, plan.title ?? "任务清单"),
      h("span", { key: "s", className: "sbh-spacer" }),
      h("span", { key: "p", className: "sbh-tasks__sub" }, `${progress.done ?? 0}/${progress.total ?? 0}`),
    ]),
    tabs,
    h(TaskProgress, { key: "progress", progress }),
    h(TaskLegend, { key: "legend", progress }),
    h(TaskGraph, { key: "graph", view: active, metrics: GRAPH_METRICS_COMPACT, onOpenRun }),
    active.next !== undefined && active.next !== ""
      ? h("div", { key: "next", className: "sbh-sub", title: active.next }, active.next)
      : null,
    frame.truncated === true
      ? h("div", { key: "more", className: "sbh-sub" }, `共 ${frame.total ?? plans.length} 条清单，设置页可看全部`)
      : null,
  ]);
}

/**
 * 设置页：取全部清单（含任务说明），并给出**手动推进**的入口。
 *
 * 为什么手动入口要放在设置页而不是面板：面板是「看一眼」的地方，
 * 而激活/重试/取消会影响真实花费，应当在用户明确进入配置页时再做。
 * @param {{pollMs?:number}} props - 轮询间隔。
 * @returns {object} `{plans, error, reload, post}`
 */
function useTaskPlans(props = {}) {
  const pollMs = Number.isSafeInteger(props.pollMs) ? props.pollMs : 5000;
  const [state, setState] = React.useState({ plans: [], error: null, loading: true });

  const load = React.useCallback(async () => {
    try {
      const response = await fetch(`${ENDPOINT}/tasks`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const frame = normalizeTaskFrame({ plans: data.plans, total: data.total });
      setState({ plans: frame === undefined ? [] : frame.plans, error: null, loading: false });
    } catch (error) {
      setState((previous) => ({ ...previous, error: `拉取任务清单失败：${error?.message ?? error}`, loading: false }));
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) void load(); };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load, pollMs]);

  return { ...state, reload: load };
}

/**
 * 一条清单的操作按钮（只在能派上用场的状态下出现）。
 *
 * 按钮的出现条件是**状态本身**，不是「有没有权限」：可执行的任务才有「激活」，
 * 有失败/取消的才有「重试」，还有没结束的才有「取消」。这样用户看到的每个按钮
 * 按下去都有意义，而不是点完弹一句「当前状态不能这么做」。
 *
 * @param {object} props - `{view, ops, busy}`。
 * @returns {any}
 */
function PlanActions(props) {
  const { view, ops, busy } = props;
  const planId = view.plan?.id ?? "";
  const progress = view.progress ?? {};
  const tasks = view.tasks ?? [];
  const disabled = busy === true;
  const buttons = [];

  if (Number(progress.ready ?? 0) > 0) {
    buttons.push(h("button", {
      key: "activate",
      type: "button",
      className: "sbh-mini-btn sbh-mini-btn--primary",
      disabled,
      title: "把已经就绪的任务放行（清单关掉了自动激活时用）",
      onClick: () => ops.activate(planId),
    }, `激活 ${progress.ready} 项`));
  }
  const retryable = tasks.filter((task) => task.state === "failed" || task.state === "cancelled");
  if (retryable.length > 0) {
    const target = retryable[0];
    buttons.push(h("button", {
      key: "retry",
      type: "button",
      className: "sbh-mini-btn",
      disabled,
      title: "重跑失败或被取消的任务（会重新花一次运行）",
      onClick: () => ops.retry(planId, target),
    }, `重试 ${target.id}`));
  }
  if (Number(progress.closed ?? 0) < Number(progress.total ?? 0)) {
    buttons.push(h("button", {
      key: "cancel",
      type: "button",
      className: "sbh-mini-btn sbh-mini-btn--danger",
      disabled,
      title: "取消这条清单里所有没完成的任务（在跑的那次运行也会被取消）",
      onClick: () => ops.cancelPlan(planId),
    }, "取消未完成"));
  }
  buttons.push(h("button", {
    key: "auto",
    type: "button",
    className: "sbh-mini-btn",
    disabled,
    title: view.plan?.autoActivate === true ? "改成手动激活（不再自动推进下游）" : "改成依赖完成自动激活下游",
    onClick: () => ops.setAuto(planId, view.plan?.autoActivate !== true),
  }, view.plan?.autoActivate === true ? "改手动" : "改自动"));
  buttons.push(h("button", {
    key: "delete",
    type: "button",
    className: "sbh-mini-btn sbh-mini-btn--danger",
    disabled,
    title: "删掉这条清单（运行记录与评价保留）",
    onClick: () => ops.remove(planId, view.plan?.title ?? ""),
  }, "删除"));

  return h("div", { className: "sbh-task__actions" }, buttons);
}

/**
 * 设置页里的任务链路区块：取数、执行动作、显示结果都在这里。
 *
 * 三种写操作分成三条真实路径（`POST /tasks/<id>/activate`、`PATCH /tasks/<id>`、
 * `DELETE /tasks/<id>`），而不是塞进一个「万能 POST」——HTTP 方法说清了这次改动
 * 的性质（推进 / 改属性 / 删除），出问题时一眼能看出是哪一类。
 *
 * @param {object} props - `{onOpenRun}`。
 * @returns {any}
 */
function TaskBoards(props) {
  const { onOpenRun } = props ?? {};
  const state = useTaskPlans();
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);

  /**
   * 发一个写请求并刷新列表。
   * @param {{method:string,path:string,body?:object,confirmText?:string,label:string}} request - 请求描述。
   * @returns {Promise<void>}
   */
  const send = React.useCallback(async (request) => {
    if (request.confirmText !== undefined
      && typeof window !== "undefined" && typeof window.confirm === "function"
      && window.confirm(request.confirmText) !== true) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${ENDPOINT}${request.path}`, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const payload = await response.json().catch(() => ({}));
      const started = Array.isArray(payload.started) ? payload.started : [];
      setNotice({
        kind: response.ok ? "ok" : "error",
        text: response.ok
          ? (started.length > 0
            ? `${request.label}：已启动 ${started.map((item) => item.taskId).join("、")}`
            : `${request.label}：已更新`)
          : (payload.error ?? payload.errors?.join("；") ?? `HTTP ${response.status}`),
      });
      await state.reload();
    } catch (error) {
      setNotice({ kind: "error", text: `${request.label}失败：${error?.message ?? error}` });
    } finally {
      setBusy(false);
    }
  }, [state]);

  const ops = {
    activate: (planId) => send({ method: "POST", path: `/tasks/${planId}/activate`, body: {}, label: "激活" }),
    retry: (planId, task) => send({
      method: "POST",
      path: `/tasks/${planId}/${task.id}/retry`,
      body: {},
      label: `重试 ${task.id}`,
      confirmText: `重试 ${task.id}「${task.title}」？会再花一次子 agent 运行。`,
    }),
    cancelPlan: (planId) => send({
      method: "POST",
      path: `/tasks/${planId}/cancel`,
      body: {},
      label: "取消未完成任务",
      confirmText: "取消这条链路里所有未完成的任务？（正在跑的那一次也会被取消）",
    }),
    setAuto: (planId, value) => send({
      method: "PATCH",
      path: `/tasks/${planId}`,
      body: { autoActivate: value },
      label: value ? "打开自动激活" : "改为手动激活",
    }),
    remove: (planId, title) => send({
      method: "DELETE",
      path: `/tasks/${planId}`,
      label: "删除清单",
      confirmText: `删除清单「${title}」？（运行记录与评价会保留）`,
    }),
  };

  return h("div", { className: "sbh-boards" }, [
    h("div", { key: "head", className: "sbh-section" }, "任务链路（依赖图：颜色 = 任务状态，实线 = 依赖已解锁）"),
    state.error !== null && state.error !== undefined
      ? h("div", { key: "err", className: "sbh-alert sbh-alert--error" }, state.error)
      : null,
    notice !== null
      ? h("div", {
        key: "notice",
        className: `sbh-alert sbh-alert--${notice.kind === "ok" ? "ok" : "error"}`,
      }, notice.text)
      : null,
    state.plans.length === 0 && state.loading !== true
      ? h("div", { key: "empty", className: "sbh-empty" },
        "还没有任务清单。主对话做多步任务时会用 subagent_plan 建一条；建完之后这里会显示依赖图，"
        + "以及每个子 agent 正在做哪一项、在等谁。")
      : null,
    ...state.plans.map((view) => h(PlanCard, {
      key: view.plan?.id ?? "",
      view,
      onOpenRun,
      actions: h(PlanActions, { view, ops, busy }),
    })),
  ].filter((item) => item !== null));
}

//#endregion

// 导出面统一在 `05-settings-tail.js`：那里是 bundle 的收尾片（它还要关掉工厂），
// 把「插件对外暴露了什么」集中在一处，比每个分片各自往 exports 上挂东西更容易复核。

    //#region 配置页（需求 3）
    /** 空表单。 */
    const EMPTY_FORM = {
      id: "",
      name: "",
      transport: "spawn",
      modelProvider: "",
      modelId: "",
      apiBase: "",
      credentialRef: "",
      maxContext: 0,
      maxTokens: 0,
      reasoningEffort: "",
      toolPolicy: "inherit",
      persona: "",
      note: "",
    };

    /**
     * 取一个路由的第一个模型 id（没有就返回空串）。
     * @param {object|undefined} route - 路由。
     * @returns {string}
     */
    function firstModelOf(route) {
      const models = route?.models ?? [];
      return models.length > 0 ? models[0].id : "";
    }

    /**
     * 选一个适合当默认值的路由。
     *
     * 顺序是：**已激活且有模型** → 有模型 → 无。这个顺序不是审美问题：
     * 本机有几十条只声明了、没配置过的路由（amazon-bedrock、anthropic、xai…），
     * 它们的 `models` 是空数组。按字母序把其中一条当默认，会得到一个
     * 「选了提供商、但模型下拉是空的」的表单——真机上那个「下拉显示着模型、
     * 提交却说 modelId 必填」的 bug 就是从这儿来的。
     *
     * @param {object[]} routes - 目录里的路由。
     * @returns {object|undefined}
     */
    function pickDefaultRoute(routes) {
      const withModels = routes.filter((route) => (route.models ?? []).length > 0);
      return withModels.find((route) => route.active === true) ?? withModels[0];
    }

    /**
     * 保证「当前值一定在选项里」。
     *
     * 为什么必须有这个：原生 `<select>` 在 value 匹配不到任何 option 时会**默默显示第一个选项**。
     * 于是界面上看着「已经选好了」，而状态里其实是空的——提交时抛出「必填」，
     * 用户对着一个明明有内容的输入框被告知它没填。这类「显示与状态不一致」最难查，
     * 因为它把一个状态问题伪装成了一个校验问题。
     *
     * 修法不是「猜一个更聪明的默认值」，而是**让不一致无法隐藏**：不匹配就显示一个明确的占位项。
     *
     * @param {string} current - 当前值。
     * @param {{value:string,label:string}[]} options - 候选。
     * @param {string} placeholder - 占位文案。
     * @returns {{value:string,label:string}[]}
     */
    function optionsWithCurrent(current, options, placeholder) {
      return options.some((option) => option.value === current)
        ? options
        : [{ value: "", label: current === "" ? placeholder : `${current}（不在当前清单里，请重选）` }, ...options];
    }

    /**
     * 把服务端的 agent 记录转成表单值。
     * @param {object} agent - agent 记录。
     * @returns {object}
     */
    function agentToForm(agent) {
      return {
        id: agent.id ?? "",
        name: agent.name ?? "",
        transport: agent.transport ?? "spawn",
        modelProvider: agent.modelProvider ?? "",
        modelId: agent.modelId ?? "",
        apiBase: agent.apiBase ?? "",
        credentialRef: agent.credentialRef ?? "",
        maxContext: agent.maxContext ?? 0,
        maxTokens: agent.maxTokens ?? 0,
        reasoningEffort: agent.reasoningEffort ?? "",
        toolPolicy: agent.toolPolicy ?? "inherit",
        persona: agent.persona ?? "",
        note: agent.note ?? "",
      };
    }

    /**
     * 读一个 fetch 响应。
     * @param {Response} response - 响应。
     * @returns {Promise<{ok:boolean,status:number,payload:any}>}
     */
    async function readResponse(response) {
      const text = await response.text();
      let payload;
      try {
        payload = text === "" ? {} : JSON.parse(text);
      } catch {
        payload = { error: text };
      }
      return { ok: response.ok, status: response.status, payload };
    }

    /**
     * 配置页组件。
     *
     * 三个刻意的产品决定：
     *  1. **「模型提供商 / 模型 ID / agent 提供商」是下拉，不是手打** —— 数据来自
     *     `/state` 里的自发现结果。插件不内置任何模型清单，用户在 DSH 里加了模型，这里自动跟上。
     *  2. **「模型最大上下文」旁边必须写着它是什么** —— 它是本插件的输入预算闸，
     *     **不是**模型真实窗口（`AgentOptions` 里根本没有窗口字段）。不写清楚就是误导。
     *  3. **保存失败必须原样显示服务端的理由** —— 校验都在宿主侧做，客户端不做重复判断，
     *     否则两边规则迟早会漂。
     *
     * `initialForm` 是一个测试缝（也便于将来做「复制一个已有 agent」）：
     * 它让「表单处于某个特定状态时渲染成什么样」可以被离线验证。
     * 之所以需要它：`useEffect` 在 SSR 下不执行，没有这个入口就只能验证「空表单」这一种状态，
     * 而真机上出问题的恰恰是**非空但值不匹配**的状态。
     */
    function AgentSettingsPage(props) {
      const { close, t, initialForm } = props;
      const state = useHub();
      const [form, setForm] = React.useState(() => ({ ...EMPTY_FORM, ...(initialForm ?? {}) }));
      const [errors, setErrors] = React.useState([]);
      const [warnings, setWarnings] = React.useState([]);
      const [notice, setNotice] = React.useState("");
      const [saving, setSaving] = React.useState(false);
      /** 已点击归档、正在等服务端确认的 agent（乐观隐藏，失败会回滚）。 */
      const [archivedLocally, setArchivedLocally] = React.useState([]);
      /** 正在归档哪一个：用来禁用该行的按钮，避免重复点击。 */
      const [archivingId, setArchivingId] = React.useState("");
      /** 正在恢复哪一个。 */
      const [restoringId, setRestoringId] = React.useState("");
      /**
       * 列表（归档/恢复）自己的反馈通道，与表单（保存）的分开。
       * 合成一条的话，保存失败会把错误显示到列表区、归档失败会显示到表单区——
       * 反馈出现在离操作很远的地方，等于没有反馈。
       */
      const [listErrors, setListErrors] = React.useState([]);
      const [listNotice, setListNotice] = React.useState("");

      React.useEffect(() => { void hub.refresh(); }, []);

      const catalog = state.catalog ?? { routes: [], transports: [] };
      const bindable = (catalog.transports ?? []).filter((item) => item.supportsModelBinding === true);
      const routes = catalog.routes ?? [];
      const route = routes.find((item) => item.id === form.modelProvider);
      const models = route?.models ?? [];
      const editing = form.id !== "";

      const set = (patch) => setForm((current) => ({ ...current, ...patch }));

      const resetForm = () => {
        const preferred = pickDefaultRoute(routes);
        setForm({
          ...EMPTY_FORM,
          transport: bindable[0]?.name ?? "spawn",
          modelProvider: preferred?.id ?? "",
          modelId: firstModelOf(preferred),
        });
        setErrors([]);
        setWarnings([]);
        setNotice("");
      };

      React.useEffect(() => {
        // 首次拿到目录后把下拉默认值填上，省掉一次「先选提供商」的点击。
        //
        // 注意默认路由的选法：本机有几十条**未配置**的路由，它们的 `models` 是空数组。
        // 按字母序取 routes[0] 会得到一条「有提供商但没模型」的表单，
        // 而这正是真机上那个「下拉显示着模型、提交却说 modelId 必填」的来源。
        setForm((current) => {
          if (current.modelProvider !== "") return current;
          const preferred = pickDefaultRoute(routes);
          if (preferred === undefined) return current;
          return { ...current, modelProvider: preferred.id, modelId: current.modelId || firstModelOf(preferred) };
        });
      }, [routes.length]);

      const submit = React.useCallback(async () => {
        setSaving(true);
        setNotice("");
        const payload = {
          name: form.name,
          transport: form.transport,
          modelProvider: form.modelProvider,
          modelId: form.modelId,
          apiBase: form.apiBase,
          credentialRef: form.credentialRef,
          maxContext: Number(form.maxContext) || 0,
          maxTokens: Number(form.maxTokens) || 0,
          reasoningEffort: form.reasoningEffort,
          toolPolicy: form.toolPolicy,
          persona: form.persona,
          note: form.note,
        };
        // 客户端只做「新建还是更新」的分派，校验一律交给宿主（单一事实来源）。
        const target = editing
          ? `${ENDPOINT}/agents/${encodeURIComponent(form.id)}`
          : `${ENDPOINT}/agents`;
        const result = await fetch(target, {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).then(readResponse);

        setSaving(false);
        setErrors(result.ok ? [] : (result.payload?.errors ?? [result.payload?.error ?? "保存失败"]));
        setWarnings(result.payload?.warnings ?? []);
        if (result.ok) {
          setNotice(editing ? `已更新「${payload.name}」` : `已添加「${payload.name}」`);
          setForm(EMPTY_FORM);
          await hub.refresh();
        }
      }, [form, editing]);

      /**
       * 归档一个 agent。
       *
       * 真机上出现过「点了没反应」：后端**确实归档成功了**（库里四个 agent 的
       * archived_at 都在同一秒），但用户看不到任何变化，于是把每个都点了一遍。
       * 所以这条路径按三个要求写：
       *
       *  1. **点击立刻有反馈**：先把这个 id 放进本地隐藏集合，行马上消失，
       *     不依赖网络往返。依赖往返的交互在往返出问题时表现就是「没反应」。
       *  2. **失败必须回滚并说出来**：不能没有 try/catch——任何异常都会变成一个
       *     被 `void` 吞掉的 rejected promise，完全静默。
       *  3. **反馈出现在点击附近**：notice/error 渲染在「已配置」这一段里，
       *     而不是放在下面的表单区（那里离点击位置太远，容易被忽略）。
       */
      const archive = React.useCallback(async (agent) => {
        if (archivingId !== "") return;
        setArchivingId(agent.id);
        setListErrors([]);
        setListNotice("");
        setArchivedLocally((current) => (current.includes(agent.id) ? current : [...current, agent.id]));
        // 别让表单继续指向一个已归档的 agent，否则「保存修改」会莫名其妙地报 404。
        if (form.id === agent.id) setForm(EMPTY_FORM);

        try {
          const response = await fetch(`${ENDPOINT}/agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
          const result = await readResponse(response);
          if (!result.ok) {
            // 回滚：界面不能显示一个其实还在的 agent（反过来也一样危险）。
            setArchivedLocally((current) => current.filter((id) => id !== agent.id));
            setListErrors([result.payload?.error ?? `归档失败（HTTP ${result.status}）`]);
            return;
          }
          setListNotice(`已归档「${agent.name}」，列表已更新（历史运行与评价保留）`);
          await hub.refresh();
          // 服务端列表已经不含它了，本地隐藏集合可以清掉，避免无限增长。
          setArchivedLocally([]);
        } catch (error) {
          setArchivedLocally((current) => current.filter((id) => id !== agent.id));
          setListErrors([`归档请求失败：${error?.message ?? error}`]);
        } finally {
          setArchivingId("");
        }
      }, [archivingId, form.id]);

      /**
       * 恢复一个已归档的 agent。
       *
       * 为什么要做：归档是一键的，如果恢复只能靠命令行，这个不对称本身就是陷阱——
       * 真机上用户就是这么把四个配置全点进归档、并且没有回头路的。
       */
      const restore = React.useCallback(async (agent) => {
        if (restoringId !== "") return;
        setRestoringId(agent.id);
        setListErrors([]);
        setListNotice("");
        try {
          const response = await fetch(`${ENDPOINT}/agents/${encodeURIComponent(agent.id)}/restore`, { method: "POST" });
          const result = await readResponse(response);
          if (!result.ok) {
            setListErrors([result.payload?.error ?? `恢复失败（HTTP ${result.status}）`]);
            return;
          }
          setListNotice(`已恢复「${agent.name}」`);
          await hub.refresh();
        } catch (error) {
          setListErrors([`恢复请求失败：${error?.message ?? error}`]);
        } finally {
          setRestoringId("");
        }
      }, [restoringId]);

      const field = (label, control, hint) => h("label", { className: "sbh-field", key: label }, [
        h("span", { className: "sbh-field__label", key: "l" }, label),
        // 控件包一层带 key 的容器：这些子节点是以数组形式传的，React 要求数组里
        // 每个元素都有 key，否则会警告并退化成按位置复用。
        h("span", { className: "sbh-field__control", key: "c" }, control),
        hint === undefined ? null : h("span", { className: "sbh-field__hint", key: "h" }, hint),
      ]);

      const textInput = (key, placeholder) => h("input", {
        className: "sbh-input",
        value: form[key],
        placeholder: placeholder ?? "",
        onChange: (event) => set({ [key]: event.target.value }),
      });

      const numberInput = (key) => h("input", {
        className: "sbh-input",
        type: "number",
        min: 0,
        value: String(form[key]),
        onChange: (event) => set({ [key]: event.target.value === "" ? 0 : Number(event.target.value) }),
      });

      const select = (key, options, onChange) => h("select", {
        className: "sbh-input",
        value: form[key],
        onChange: (event) => {
          if (typeof onChange === "function") onChange(event.target.value);
          else set({ [key]: event.target.value });
        },
      }, options.map((option) => {
        const value = typeof option === "string" ? option : option.value;
        const label = typeof option === "string" ? option : option.label;
        return h("option", { key: value, value }, label);
      }));

      const agents = state.agents ?? [];
      /** 列表里真正要显示的 agent：服务端给的，减去本地已乐观隐藏的。 */
      const visibleAgents = agents.filter((agent) => !archivedLocally.includes(agent.id));
      const archivedAgents = state.archivedAgents ?? [];

      return h("div", { className: "sbh-settings" }, [
        h("div", { className: "sbh-settings__head", key: "head" }, [
          h("div", { key: "title" }, [
            h("div", { className: "sbh-settings__title", key: "t" }, t?.("settings.title") ?? "子 agent"),
            h("div", { className: "sbh-settings__sub", key: "s" },
              t?.("settings.sub") ?? "把配置好的模型发布成可 @ 的子智能体。它们跑在同一套 DSH agent 运行时上，只是模型不同。"),
          ]),
          typeof close === "function"
            ? h("button", { key: "close", type: "button", className: "sbh-icon", onClick: close, title: "关闭" }, "✕")
            : null,
        ]),

        // ---- 已配置列表 ----
        h("div", { className: "sbh-settings__section", key: "list" }, [
          h("div", { className: "sbh-section", key: "list-head" }, `已配置（${visibleAgents.length}）`),

          // 归档/恢复的反馈就放在这一段的顶部——离点击位置最近。
          // 之前它渲染在下面的表单区里，用户点完列表往上看不到任何变化，就以为没生效。
          listErrors.length > 0 ? h("div", { className: "sbh-alert sbh-alert--error", key: "list-err" }, listErrors.join("；")) : null,
          listNotice !== "" ? h("div", { className: "sbh-alert sbh-alert--ok", key: "list-ok" }, listNotice) : null,

          visibleAgents.length === 0
            ? h("div", { className: "sbh-empty", key: "list-empty" }, "还没有子 agent。用下面的表单添加第一个——同一个模型可以添加多次。")
            : null,
          ...visibleAgents.map((agent) => h("div", { className: "sbh-row sbh-row--agent", key: agent.id }, [
            h("span", { className: "sbh-dot sbh-dot--idle", key: "dot" }),
            h("div", { style: { minWidth: 0 }, key: "meta" }, [
              h("div", { className: "sbh-name", key: "nm" }, agent.name),
              h("div", { className: "sbh-sub", key: "md", title: `${agent.modelProvider}/${agent.modelId}` },
                `${agent.modelProvider}/${agent.modelId}`
                + `｜${agent.toolPolicyDetail?.policy === "inherit" ? "全工具" : agent.toolPolicyDetail?.policy === "readonly" ? "只读" : "无工具"}`
                + `${agent.maxContext > 0 ? `｜预算 ${group(agent.maxContext)}` : ""}`),
            ]),
            h("div", { className: "sbh-row__actions", key: "actions" }, [
              h("button", {
                key: "edit", type: "button", className: "sbh-icon", title: "编辑",
                onClick: () => { setForm(agentToForm(agent)); setErrors([]); setNotice(""); },
              }, "✎"),
              h("button", {
                key: "del", type: "button", className: "sbh-icon",
                title: "归档（保留历史运行与评价）",
                disabled: archivingId === agent.id,
                onClick: () => { void archive(agent); },
              }, archivingId === agent.id ? "…" : "🗑"),
            ]),
          ])),
        ]),

        // ---- 已归档（可恢复）----
        // 归档是软删除，所以必须有一个看得见、点得动的回头路。
        archivedAgents.length > 0
          ? h("div", { className: "sbh-settings__section", key: "archived" }, [
            h("div", { className: "sbh-section", key: "archived-head" },
              `已归档（${archivedAgents.length}）— 历史运行与评价都还在，可以恢复`),
            ...archivedAgents.map((agent) => h("div", { className: "sbh-row sbh-row--agent sbh-row--muted", key: agent.id }, [
              h("span", { className: "sbh-dot sbh-dot--idle", key: "dot" }),
              h("div", { style: { minWidth: 0 }, key: "meta" }, [
                h("div", { className: "sbh-name", key: "nm" }, agent.name),
                h("div", { className: "sbh-sub", key: "md", title: `${agent.modelProvider}/${agent.modelId}` },
                  `${agent.modelProvider}/${agent.modelId}`),
              ]),
              h("div", { className: "sbh-row__actions", key: "actions" }, [
                h("button", {
                  key: "restore", type: "button", className: "sbh-button",
                  disabled: restoringId === agent.id,
                  title: "恢复成活跃状态",
                  onClick: () => { void restore(agent); },
                }, restoringId === agent.id ? "恢复中…" : "恢复"),
              ]),
            ])),
          ])
          : null,

        // ---- 运行护栏（并发上限等）----
        h("div", { className: "sbh-settings__section", key: "guards" }, [
          h(RunGuards, { key: "guards-body" }),
        ]),

        // ---- 任务链路（0.2.0）：依赖图 + 手动推进入口 ----
        // 放在护栏之后、排名之前：它是「正在发生的事」，而排名是「历史成绩」。
        h("div", { className: "sbh-settings__section", key: "tasks" }, [
          h(TaskBoards, { key: "tasks-body" }),
        ]),

        // ---- 排名与跨轮回归（需求 5）----
        h("div", { className: "sbh-settings__section", key: "boards" }, [
          h(Boards, { key: "boards-body" }),
        ]),

        // ---- 表单 ----
        h("div", { className: "sbh-settings__section", key: "form" }, [
          h("div", { className: "sbh-section", key: "form-head" }, editing ? `编辑「${form.name}」` : "添加子 agent"),

          errors.length > 0 ? h("div", { className: "sbh-alert sbh-alert--error", key: "err" }, errors.join("；")) : null,
          warnings.length > 0 ? h("div", { className: "sbh-alert sbh-alert--warn", key: "warn" }, warnings.join("；")) : null,
          notice !== "" ? h("div", { className: "sbh-alert sbh-alert--ok", key: "ok" }, notice) : null,

          h("div", { className: "sbh-grid", key: "grid" }, [
            field(t?.("field.name") ?? "名称", textInput("name", "例如 研究员"),
              "它就是 @ 的句柄，不能含空格，未归档范围内唯一"),

            field(t?.("field.transport") ?? "agent 提供商",
              bindable.length > 0
                ? select("transport", optionsWithCurrent(form.transport, bindable.map((item) => ({ value: item.name, label: item.name })), "请选择…"))
                : textInput("transport", "spawn"),
              bindable.length > 0
                ? "子 agent 的传输实现；只有支持 agentOptions 的才能指定模型（不能的不会出现在这里）"
                : "本机没有可用的传输实现，或 ctx.subagents 不可用"),

            field(t?.("field.modelProvider") ?? "模型提供商",
              routes.length > 0
                ? select(
                  "modelProvider",
                  optionsWithCurrent(
                    form.modelProvider,
                    routes.map((item) => ({
                      value: item.id,
                      label: `${item.name}${item.active ? "" : "（未激活）"}${(item.models ?? []).length === 0 ? "（无模型清单）" : ""}`,
                    })),
                    "请选择模型提供商…",
                  ),
                  // 换提供商时必须同时换模型：两个下拉是**一对**，
                  // 只改一半就会造出「provider=A 的清单 + model=B 的 id」这种必然失败的状态。
                  (value) => {
                    const next = routes.find((item) => item.id === value);
                    set({ modelProvider: value, modelId: firstModelOf(next) });
                  },
                )
                : textInput("modelProvider", "deepseek-official"),
              routes.length > 0 ? "来自 DSH 当前的 provider 配置（已激活 ∪ 已配置）" : "读不到 DSH 的 provider 配置，请手填"),

            field(t?.("field.modelId") ?? "模型 ID",
              models.length > 0
                ? select(
                  "modelId",
                  optionsWithCurrent(form.modelId, models.map((item) => ({ value: item.id, label: item.name ?? item.id })), "请选择模型…"),
                )
                : textInput("modelId", "deepseek-v4.1-flash"),
              models.length > 0 ? "来自该 provider 的模型清单" : "读不到模型清单，请手填（DSH 会在调用时给权威判断）"),

            field(t?.("field.maxContext") ?? "模型最大上下文", numberInput("maxContext"),
              "⚠ 这是本插件的「输入预算闸」：预估任务超过它的一半就拒绝启动。它「不是」模型真实窗口——"
              + "窗口由 DSH 的模型目录决定，无法按子 agent 单独调小。0 = 不限。"),

            field(t?.("field.maxTokens") ?? "单次输出上限", numberInput("maxTokens"),
              "传给模型的 maxTokens（输出上限）。0 = 用 DSH 默认。"),

            field(t?.("field.toolPolicy") ?? "工具策略",
              select("toolPolicy", [
                { value: "inherit", label: "继承父级（全工具）" },
                { value: "readonly", label: "只读（fail-closed 白名单）" },
                { value: "none", label: "无工具" },
              ]),
              "由 spawn provider 在子 agent 的创建窗口真正强制：被排除的工具既不可见也不可执行"),

            field(t?.("field.reasoningEffort") ?? "推理档位", textInput("reasoningEffort", "留空 = 用模型默认"),
              "仅在该模型支持时有效"),

            field(t?.("field.apiBase") ?? "api 地址", textInput("apiBase", route?.apiBase || "留空 = 用 DSH 该路由的配置"),
              route?.apiBase
                ? `DSH 中该路由已配置为 ${route.apiBase}（这里只是记录与提示，实际路由以 DSH 的 provider 配置为准）`
                : "只记录与提示；新端点请先在 DSH 的 settings 里配好路由"),

            field(t?.("field.credentialRef") ?? "凭据引用", textInput("credentialRef", route?.credentialRef || "留空 = 用该路由的默认凭据"),
              "只引用 DSH 的凭据名，不在这里存 key——密钥不会落到本插件的库里"),

            field(t?.("field.note") ?? "备注", textInput("note", "可选")),
          ]),

          field(t?.("field.persona") ?? "人格 / 系统提示词（可选）",
            h("textarea", {
              className: "sbh-input sbh-textarea",
              value: form.persona,
              rows: 3,
              placeholder: "留空则沿用 DSH 的默认人格",
              onChange: (event) => set({ persona: event.target.value }),
            })),

          h("div", { className: "sbh-form__actions", key: "actions" }, [
            h("button", {
              key: "save", type: "button", className: "sbh-button sbh-button--primary",
              disabled: saving || form.name.trim() === "",
              onClick: () => { void submit(); },
            }, saving ? "保存中…" : (editing ? "保存修改" : "添加")),
            editing
              ? h("button", { key: "cancel", type: "button", className: "sbh-button", onClick: resetForm }, "取消编辑")
              : null,
            h("span", { key: "spacer", className: "sbh-spacer" }),
            h("span", { key: "counts", className: "sbh-field__hint" },
              `${bindable.length} 个可用传输｜${routes.length} 个路由`),
          ]),
        ]),
      ]);
    }
    //#endregion

    //#region @ 源（需求 4）
    /**
     * 在输入框里打 `@` 时弹出子 agent 候选，选中即把 `@名字 ` 插进草稿。
     *
     * DSH 的输入触发管线本来就是为 `/` 与 `@` 设计的，并且**明确允许业务包注册源**
     * （`ctx.inputTriggers.registerSource`）。所以这里做的是原生集成，不是 DOM hack。
     *
     * 关键的产品决定：**忙的子 agent 不出现在候选里**。
     * 需求说「在忙 agent 不能被 @，要有提示或者直接 @不了」——这里选「直接 @不了」
     * （候选里根本没有它），提示则由悬浮球承担（它一直列着谁忙谁闲），
     * 最后还有工具边界的硬拒绝兜底。三者配合，而不是只靠一句「请勿选择」。
     */
    function buildMentionSource(t) {
      return {
        trigger: "@",
        name: MENTION_GROUP,
        order: -10,
        async candidates(session, request) {
          // 候选要跟着启用状态走：没启用就不该 @。
          const state = hub.getSnapshot();
          const sessionId = session?.sessionId ?? state.sessionId;
          if (typeof sessionId === "string" && sessionId !== "") hub.setSession(sessionId);
          await hub.refresh(typeof sessionId === "string" ? sessionId : undefined);
          const fresh = hub.getSnapshot();
          if (fresh.enabled !== true) return [];

          const query = String(request?.query ?? "").toLowerCase();
          const busy = new Set((fresh.runtime?.runs ?? []).filter((run) => run.busy).map((run) => run.agentName));
          return (fresh.agents ?? [])
            .filter((agent) => !busy.has(agent.name))
            .filter((agent) => query === "" || agent.name.toLowerCase().includes(query))
            .map((agent) => ({
              name: agent.name,
              description: `${agent.modelProvider}/${agent.modelId}`
                + (agent.toolPolicyDetail?.policy === "inherit" ? "" : `｜${agent.toolPolicyDetail?.policy}`),
              // `hint` 显示在候选右侧，用它把「为什么某些 agent 不在这里」说清楚。
              hint: t?.("mention.available") ?? "可委派",
            }));
        },
        onPick(pick) {
          const name = pick?.candidate?.name;
          if (typeof name !== "string" || name === "") return "handled";
          // 插入纯文本而不是引用块：约定就是「消息里出现 @名字」，
          // 主对话按注入的协议解析它，不需要 DSH 额外序列化一个引用对象。
          return { text: `@${name} `, continue: false };
        },
      };
    }
    //#endregion

    //#region 词典
    const zh = {
      "toggle.on": "子 agent 已启用",
      "toggle.off": "子 agent 已关闭",
      "mention.available": "可委派",
      "guards.title": "运行护栏",
      "nav": "子 agent",
      "settings.title": "子 agent",
      "settings.sub": "把配置好的模型发布成可 @ 的子智能体。它们跑在同一套 DSH agent 运行时上，只是模型不同。",
      "field.name": "名称",
      "field.transport": "agent 提供商",
      "field.modelProvider": "模型提供商",
      "field.modelId": "模型 ID",
      "field.maxContext": "模型最大上下文",
      "field.maxTokens": "单次输出上限",
      "field.toolPolicy": "工具策略",
      "field.reasoningEffort": "推理档位",
      "field.apiBase": "api 地址",
      "field.credentialRef": "凭据引用",
      "field.persona": "人格 / 系统提示词（可选）",
      "field.note": "备注",
    };
    const en = {
      "toggle.on": "Sub-agents on",
      "toggle.off": "Sub-agents off",
      "mention.available": "available",
      "guards.title": "Run guards",
      "nav": "Sub-agents",
      "settings.title": "Sub-agents",
      "settings.sub": "Publish configured models as @-mentionable sub-agents. They run on the same DSH agent runtime, just a different model.",
      "field.name": "Name",
      "field.transport": "Agent provider",
      "field.modelProvider": "Model provider",
      "field.modelId": "Model ID",
      "field.maxContext": "Max context",
      "field.maxTokens": "Max output tokens",
      "field.toolPolicy": "Tool policy",
      "field.reasoningEffort": "Reasoning effort",
      "field.apiBase": "API base",
      "field.credentialRef": "Credential ref",
      "field.persona": "Persona / system prompt (optional)",
      "field.note": "Note",
    };
    /** 词典命名空间。 */
    const NS = "subagentHub";
    //#endregion

    //#region 插件面
    /** 客户端插件需要的服务：插槽、语言、输入触发器。 */
    const inject = ["slots", "locale", "inputTriggers"];

    /**
     * 客户端插件体：注册词典、输入栏开关、悬浮球、设置页与 @ 源。
     * @param {object} ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ensureCss();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "subagent-hub: dictionaries");

      // 输入栏底部那一行的启用开关（需求 4 里标红的位置）。
      ctx.slots.inject(TOGGLE_SLOT, () => ctx.slots.register({
        name: TOGGLE_SLOT,
        id: TOGGLE_ID,
        order: 10,
        locale: NS,
      }, ComposerToggle));

      // 全应用浮层：悬浮球（需求 1）。
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: OVERLAY_ID,
        order: 60,
      }, SubAgentBall));

      // 设置里的配置页（需求 3）。用 settings.section（一整个设置页），
      // 而不是 settings.general.item（那个不传任何 props，连当前值都拿不到）。
      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: SETTINGS_ID,
        order: 30,
        locale: NS,
        // 侧栏导航项的名字。官方约定 `label` 是一个**返回已本地化文案的函数**
        // （`dsh-client-ui-agent-preset` 写的是 `label: () => ctx.locale.bind(ns)("nav")`）。
        // 漏掉它不会报任何错，但侧栏那一条会变成一个没有名字的图标——
        // 这正是真机上第一次看到的样子。
        label: () => {
          try {
            if (typeof ctx.locale?.bind === "function") return ctx.locale.bind(NS)("nav");
          } catch {
            /* 落到字面量兜底 */
          }
          return "子 agent";
        },
      }, AgentSettingsPage));

      // 输入框里的 @ 候选（需求 4）。
      const inputTriggers = ctx.get("inputTriggers");
      if (inputTriggers !== undefined && typeof inputTriggers.registerSource === "function") {
        // 词典里的 t 在这里拿不到，用固定文案兜底（候选的 hint 不是关键信息）。
        ctx.effect(() => inputTriggers.registerSource(buildMentionSource(undefined)), "subagent-hub: @ mention source");
      }

      // 首屏拉一次状态：让悬浮球在没有任何交互时就能对上真实情况。
      void hub.refresh();
      void hub.refreshHealth();
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    exports.ComposerToggle = ComposerToggle;
    exports.SubAgentBall = SubAgentBall;
    exports.OrbView = OrbView;
    exports.StripView = StripView;
    exports.AgentSettingsPage = AgentSettingsPage;
    exports.RunDetail = RunDetail;
    exports.RunDetailView = RunDetailView;
    exports.Boards = Boards;
    exports.BoardsView = BoardsView;
    exports.RunGuards = RunGuards;
    exports.RunGuardsView = RunGuardsView;
    // 任务链路（0.2.0，实现见 04-task-graph.js）：
    exports.TaskGraph = TaskGraph;
    exports.TaskProgress = TaskProgress;
    exports.TaskLegend = TaskLegend;
    exports.PlanCard = PlanCard;
    exports.PanelTasks = PanelTasks;
    exports.TaskBoards = TaskBoards;
    exports.normalizeTaskFrame = normalizeTaskFrame;
    exports.buildMentionSource = buildMentionSource;
    exports.endpoint = ENDPOINT;
    /**
     * 测试接缝：把纯函数与常量暴露给 scripts/verify-client.mjs，
     * 使「真实负载 + 真实组件」的渲染可以在 DSH 之外被验证（不需要 jsdom）。
     * 这不改变运行时行为，也不引入新的对外契约。
     */
    exports.__internal = {
      ENDPOINT,
      TOGGLE_SLOT,
      TOGGLE_ID,
      OVERLAY_SLOT,
      OVERLAY_ID,
      SETTINGS_SLOT,
      SETTINGS_ID,
      MENTION_GROUP,
      formatDuration,
      compactTokens,
      group,
      pickDefaultRoute,
      firstModelOf,
      optionsWithCurrent,
      dictionaries: { zh, en },
      hub,
      /**
       * 链路图的纯函数（布局、折行、截断）。
       * 图的**坐标能被断言**才谈得上「清晰」是被验证过的，而不是看着像对的——
       * 连线的错位在现场看起来永远像是「渲染慢」，很难反推。
       */
      taskGraph: {
        visualWidth,
        truncateVisual,
        wrapLabel,
        edgePath,
        edgeVisualState,
        graphLayout,
        progressView,
        taskMetaLine,
        TASK_STATE_ORDER,
        TASK_STATE_LABEL,
        TASK_STATE_GLYPH,
        GRAPH_METRICS,
        GRAPH_METRICS_COMPACT,
      },
    };
    return module.exports;
  },
});
