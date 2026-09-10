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
.sbh-tasks{display:flex;flex-direction:column;gap:7px;padding:9px 12px 11px;min-width:0}
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
/* 图：一层一列（横向）/ 一层一行（纵向），走向即依赖方向。画布可滚动。
   注意 min-width:0 不是装饰：flex 子项的 min-width 默认是 auto，
   里面的 SVG 有多宽它就想长多宽——结果是整张卡片被撑出面板边界，
   底部的提示行与状态行会被一起切掉（真机上看起来就像「面板坏了」）。
   ⚠ 本样式表是模板字符串：里面**不能出现反引号**，否则字符串会提前结束、整个 bundle 都编译不过。 */
.sbh-graph{flex:none;min-width:0;max-width:100%;border-radius:10px;padding:4px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 4%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 7%,transparent)}
.sbh-graph__scroll{overflow:auto;max-width:100%;max-height:46vh;overscroll-behavior:contain}
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
.sbh-tabs{display:flex;gap:4px;overflow:auto;padding:1px;min-width:0}
.sbh-tab{border:1px solid transparent;border-radius:7px;background:transparent;font:inherit;font-size:10.5px;
  color:var(--dsw-alias-label-secondary,#5b5b5b);padding:2px 7px;cursor:pointer;white-space:nowrap}
.sbh-tab:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#101010) 8%,transparent)}
.sbh-tab--on{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 14%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 34%,transparent)}
/* 任务明细（设置页用；面板里放不下这么多字段） */
.sbh-plan{display:flex;flex-direction:column;gap:6px;padding:9px 0 4px;min-width:0;
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
