
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

      /**
       * 右下角拖拽缩放。
       *
       * 用**指针起始尺寸 + 位移**来算，而不是每次在旧值上累加：累加会把每一次
       * pointermove 的舍入误差滚起来，拖久了面板会自己漂。
       * 面板在右侧贴边时，往左拖是**变大**——所以宽度要按指针到左边界的距离算，
       * 而不是简单地把 dx 加上去（真机上那样会越拖越小，方向感完全反过来）。
       */
      const resizeStateRef = React.useRef(null);
      const onResizeDown = React.useCallback((event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const card = event.currentTarget.parentElement;
        const rect = card?.getBoundingClientRect();
        resizeStateRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          width: rect?.width ?? panel.width,
          height: rect?.height ?? panel.height,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }, [panel.width, panel.height]);

      const onResizeMove = React.useCallback((event) => {
        const start = resizeStateRef.current;
        if (start === null) return;
        event.stopPropagation();
        const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
        const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
        // 面板贴右侧时向左拖＝变宽：宽度用「指针到面板右边界的距离」算，
        // 而那正是 dragging 过程中的 rect.right，这里用起始右边界的近似值即可（拖动中右边界不变）。
        const right = event.currentTarget.parentElement?.getBoundingClientRect?.().right ?? viewportWidth;
        const nextWidth = Math.min(viewportWidth - 24, Math.max(PANEL_MIN_W, right - event.clientX));
        const nextHeight = Math.min(viewportHeight - 24, Math.max(PANEL_MIN_H, start.height + (event.clientY - start.startY)));
        panelObservable.set({
          ...panelObservable.getSnapshot(),
          width: Math.round(nextWidth),
          height: Math.round(nextHeight),
        });
      }, []);

      const onResizeUp = React.useCallback((event) => {
        if (resizeStateRef.current === null) return;
        resizeStateRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }, []);

      /** 一键放大/还原：拖拽之外的快捷方式（省得每次都去对那个小把手）。 */
      const toggleLarge = React.useCallback(() => {
        const current = panelObservable.getSnapshot();
        const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
        const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
        const isLarge = current.width >= Math.min(900, viewportWidth - 60);
        panelObservable.set({
          ...current,
          width: isLarge ? PANEL_DEFAULT_W : Math.min(960, viewportWidth - 48),
          height: isLarge ? PANEL_DEFAULT_H : Math.min(820, viewportHeight - 64),
        });
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
        showCard ? h("div", {
          key: "card",
          className: "sbh-card",
          // 尺寸由状态驱动（可拖拽缩放），不是写死的——所以内部元素才有「可用空间」可言。
          style: { width: panel.width, height: panel.expanded === true ? panel.height : undefined },
        }, [
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
              key: "large",
              type: "button",
              className: "sbh-icon",
              title: "放大 / 还原（也可以直接拖右下角自由缩放）",
              onClick: (event) => { event.stopPropagation(); toggleLarge(); },
            }, "⤢"),
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
              // 而不是一份配置清单。width 传下去是为了让图在**首帧**就知道可用宽度
              // （否则会先按默认尺寸画一遍再缩回，看起来像闪一下）。
              h(PanelTasks, {
                key: "tasks",
                frame: state.tasks,
                width: panel.width,
                onOpenRun: (runId) => setOpenRunId(runId),
              }),

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
          // 右下角的缩放把手。只在展开态出现：收起态是一颗球，没有「角」可拖。
          panel.expanded === true
            ? h("div", {
              key: "resize",
              className: "sbh-resize",
              title: "拖拽缩放面板",
              onPointerDown: onResizeDown,
              onPointerMove: onResizeMove,
              onPointerUp: onResizeUp,
            }, h("span", { key: "grip", className: "sbh-resize__grip" }))
            : null,
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
