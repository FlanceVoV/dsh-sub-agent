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

/** 图的尺寸。**横向**（左 → 右）用于整页宽的设置页。 */
const GRAPH_METRICS = Object.freeze({
  padX: 12, padY: 12, gapX: 44, gapY: 18, nodeW: 190, nodeH: 72, maxTitleLines: 2,
});

/**
 * **纵向**（上 → 下）流水线：给悬浮球面板用。
 *
 * 为什么面板要换方向：348px 里横向放不下一层以上——用户只能看到「第一个任务」和
 * 半个「第二个任务」，那比不画还糟。纵向下每个节点占满整行、层与层向下推进，
 * 既不用横向滚动，也符合「链路往下走」的阅读直觉。
 *
 * 层内节点**均分宽度**（`graphLayout` 里算）：并行的任务并排，而不是各自缩成一条。
 */
const GRAPH_METRICS_VERTICAL = Object.freeze({
  padX: 8, padY: 8, gapX: 10, gapY: 26, nodeW: 296, nodeH: 74, maxTitleLines: 2,
});

/** 节点内边距 + 正文字号推出来的每行可用单位数（1 单位 = 一个汉字宽）。 */
const NODE_TEXT_INSET = 22;
const NODE_TEXT_UNIT_PX = 11;

/**
 * 节点宽度的上下限。
 * 下限是「还读得出来」：再窄标题就只能放 2-3 个字，图会变成一排色块。
 * 上限是「别为了撑满而撑满」：超宽屏上一列 400px 的任务卡并不比 240px 更好读，
 * 多出来的宽度留给列间距与留白。
 */
const GRAPH_MIN_NODE_W = 132;
const GRAPH_MAX_NODE_W = 240;

/** 判「太窄、该用纵向」的门槛：低于这个宽度，横向连第二列都露不全。 */
const NARROW_GRAPH_W = 430;

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
 * 贪心折行（内部用）：填满一行再换，最后一行放不下就截断。
 * @param {string} source - 文本。
 * @param {number} maxUnits - 每行最大单位数。
 * @param {number} maxLines - 最多几行。
 * @returns {{lines:string[],fits:boolean}} `fits` 为 false 表示内容被截断了。
 */
function wrapOnce(source, maxUnits, maxLines) {
  const lines = [];
  let current = "";
  let used = 0;
  let consumed = 0;
  for (const char of source) {
    const code = char.codePointAt(0) ?? 0;
    const cost = code < 0x2e80 ? 0.55 : 1;
    if (used + cost > maxUnits) {
      if (lines.length === maxLines - 1) break; // 已经是最后一行：剩下的交给截断
      lines.push(current);
      current = "";
      used = 0;
    }
    current += char;
    used += cost;
    consumed += 1;
  }
  if (current !== "" && lines.length < maxLines) lines.push(current);
  const fits = consumed >= source.length;
  if (!fits && lines.length === maxLines) {
    // 关键：**必须为省略号腾出一格**。最后一行正好填满时如果直接调用 truncateVisual，
    // 它会因为「没超宽」而原样返回——于是被截掉的标题看起来是完整的，
    // 那是在骗读图的人（比不显示还糟）。
    const last = lines[maxLines - 1];
    let out = "";
    let used = 0;
    for (const char of last) {
      const code = char.codePointAt(0) ?? 0;
      const cost = code < 0x2e80 ? 0.55 : 1;
      if (used + cost > maxUnits - 1) break;
      out += char;
      used += cost;
    }
    lines[maxLines - 1] = `${out}…`;
  }
  return { lines, fits };
}

/**
 * 折行（最多 maxLines 行，放不下就截断）。
 *
 * 不是简单的贪心：中文标题贪心填满之后，最后一行经常只剩一个字——
 * 「更新 README 与变更记 / 录」这种断法在流程图里非常显眼。
 * 所以对**能完整放下**的文本再试几档更窄的行宽，取「最后一行最宽」的那一个；
 * 需要截断的文本没有可优化的余地，直接用贪心结果。
 *
 * @param {string} text - 文本。
 * @param {number} maxUnits - 每行最大单位数。
 * @param {number} maxLines - 最多几行。
 * @returns {string[]}
 */
function wrapLabel(text, maxUnits, maxLines) {
  const source = String(text ?? "").trim();
  if (source === "") return [];
  const greedy = wrapOnce(source, maxUnits, maxLines);
  if (!greedy.fits || greedy.lines.length < 2) return greedy.lines;

  let best = greedy;
  let bestTail = visualWidth(greedy.lines[greedy.lines.length - 1]);
  const floor = Math.max(4, Math.ceil(maxUnits * 0.6));
  for (let units = maxUnits - 1; units >= floor; units -= 1) {
    const candidate = wrapOnce(source, units, maxLines);
    if (!candidate.fits) break; // 再窄就放不下了
    const tail = visualWidth(candidate.lines[candidate.lines.length - 1]);
    if (tail > bestTail) {
      best = candidate;
      bestTail = tail;
    }
  }
  return best.lines;
}

/**
 * 连线的贝塞尔路径（水平出入，控制点各占一半间距）。
 *
 * 只用于**相邻层**之间的连线：那种线只穿过两列之间的空隙，不会碰到任何节点。
 * 跨多层的连线走的是 `orthogonalPath`（正交折线走「行间通道」），原因见那边的说明。
 * @param {number} x1 - 起点 x。
 * @param {number} y1 - 起点 y。
 * @param {number} x2 - 终点 x。
 * @param {number} y2 - 终点 y。
 * @param {number} gap - 层间距（决定弯曲程度）。
 * @param {'h'|'v'} [orientation] - 走向。
 * @returns {string}
 */
function edgePath(x1, y1, x2, y2, gap, orientation = "h") {
  const bend = Math.max(14, gap * 0.55);
  if (orientation === "v") {
    return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/**
 * 正交折线路径（跨多层时用）：先出到本列右侧的空隙，再沿**行间通道**横穿，最后进入目标。
 *
 * 为什么跨层连线不能用贝塞尔：一条从第 1 层连到第 4 层的线，贝塞尔会斜穿过中间两列——
 * 那些位置正好是别的任务的方框，于是线从框上压过去，图上看起来像「这三个任务是连着的」。
 * 折线走法把三段各放一处空白：竖段走两列之间、横段走两行之间、收尾竖段贴着目标列的左边线。
 * 结果是**任何一条线都不会穿过任何节点**（verify-client 里按几何断言）。
 *
 * @param {{x:number,y:number}[]} points - 折点（含首尾）。
 * @returns {string}
 */
function orthogonalPath(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${round2(point.x)} ${round2(point.y)}`).join(" ");
}

/** 坐标保留两位小数：SVG 不需要更多精度，路径字符串短一半，读日志也容易。 */
function round2(value) {
  return Math.round(value * 100) / 100;
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
 * 按**实际可用宽度**算尺寸：面板被拖大/拖小、浏览器窗口变化，图都跟着变。
 *
 * 为什么要算而不是给几档固定尺寸：缩放之后图还是老尺寸，就会出现
 * 「框很大、图挤在左边一小块」或者「框很小、图还是按大尺寸画而横向滚动」——
 * 两种都让人以为缩放没生效。这里的规则只有一条：
 * **层数放得下就把宽度平分给每列（撑满），放不下就用最小可读宽度并允许横向滚动**。
 *
 * @param {{width?:number, columns?:number, rows?:number, orientation?:'h'|'v', base?:object}} input - 输入。
 * @returns {object} 尺寸（可直接喂给 `graphLayout`）。
 */
function graphMetricsFor(input = {}) {
  const orientation = input.orientation === "v" ? "v" : "h";
  const base = { ...(orientation === "v" ? GRAPH_METRICS_VERTICAL : GRAPH_METRICS), ...(input.base ?? {}) };
  const available = Number(input.width);
  const columns = Math.max(1, Number(input.columns) || 1);
  if (!Number.isFinite(available) || available <= 0) return base;

  if (orientation === "v") {
    // 纵向：节点宽度就是可用宽度（面板多宽，节点就多宽）。
    return { ...base, nodeW: Math.max(GRAPH_MIN_NODE_W, Math.round(available)) };
  }
  const usable = available - base.padX * 2 - base.gapX * (columns - 1);
  const each = Math.floor(usable / columns);
  return { ...base, nodeW: Math.max(GRAPH_MIN_NODE_W, Math.min(GRAPH_MAX_NODE_W, each)) };
}

/**
 * 任务图布局（纯函数：同样的输入永远得到同样的坐标）。
 *
 * 结果里 `nodes` 与 `edges` 都带上了画图需要的全部信息，组件只负责把它们
 * 变成 SVG 元素——这样布局可以在没有浏览器的地方被验证（见 scripts/verify-client.mjs）。
 *
 * 两种走向共用同一套「分层」语义（层号来自宿主的 `depth`），只是把轴换了一下：
 *  - `h`（横向，默认）：层 → 列，列内节点从上往下排，连线从右边连到左边；
 *  - `v`（纵向，窄面板）：层 → 行，行内节点左右并排，连线从下边连到上边。
 *
 * 横向模式下所有列共用**同一个行网格**（顶对齐，不做逐列垂直居中）。
 * 这不是为了省事：行网格对齐之后，「行与行之间的空隙」才是一条贯穿全图的通道，
 * 跨层的连线才能从通道里横穿过去而不压到任何节点（见 `orthogonalPath`）。
 *
 * @param {object} view - 清单视图（`tasks` 里带 `depth`）。
 * @param {object} [metrics] - 尺寸覆盖。
 * @param {'h'|'v'} [orientation] - 走向。
 * @returns {{width:number,height:number,nodes:object[],edges:object[],columns:string[][],orientation:'h'|'v'}}
 */
function graphLayout(view, metrics = {}, orientation = "h") {
  const size = { ...(orientation === "v" ? GRAPH_METRICS_VERTICAL : GRAPH_METRICS), ...metrics };
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

  /** 造一个节点（尺寸与文案的截断都跟着**这个节点实际的宽**走）。 */
  const makeNode = (task, x, y, w, h, col, row) => {
    const units = Math.max(4, Math.floor((w - NODE_TEXT_INSET) / NODE_TEXT_UNIT_PX));
    return {
      id: task.id,
      task,
      x,
      y,
      w,
      h,
      col,
      row,
      units,
      lines: wrapLabel(task.title, units, size.maxTitleLines),
      // 元信息在这里就截断：SVG 没有 text-overflow，超出的字会被画到框外，
      // 而「画到框外」比截断难看得多。截断规则跟着节点宽度走，所以放在布局里而不是组件里。
      meta: truncateVisual(taskMetaLine(task), units + 4),
      glyph: TASK_STATE_GLYPH[task.state] ?? "·",
      label: TASK_STATE_LABEL[task.state] ?? task.state,
    };
  };

  const placed = new Map();
  const nodes = [];
  let width = 0;
  let height = 0;
  /** 行网格：横向模式下所有列共用；纵向模式下用来算行高。 */
  const rowPitch = size.nodeH + size.gapY;

  if (orientation === "v") {
    // 纵向：每层一行，行内节点均分可用宽度（层内越多就越窄，绝不溢出）。
    const contentW = size.nodeW;
    for (const [rowIndex, depth] of depths.entries()) {
      const list = byDepth.get(depth);
      const gap = list.length > 1 ? size.gapX : 0;
      const each = Math.max(GRAPH_MIN_NODE_W, Math.min(size.nodeW, (contentW - gap * (list.length - 1)) / list.length));
      const rowWidth = each * list.length + gap * (list.length - 1);
      const x0 = size.padX + Math.max(0, (contentW - rowWidth) / 2);
      const y = size.padY + rowIndex * rowPitch;
      list.forEach((task, index) => {
        const node = makeNode(task, x0 + index * (each + gap), y, each, size.nodeH, index, rowIndex);
        placed.set(task.id, node);
        nodes.push(node);
      });
      width = Math.max(width, x0 + rowWidth + size.padX);
      height = y + size.nodeH + size.padY;
    }
  } else {
    // 横向：每层一列，列内节点从上往下排（顶对齐，行网格与其它列对齐）。
    const maxRows = Math.max(1, ...depths.map((depth) => byDepth.get(depth).length));
    height = size.padY * 2 + maxRows * rowPitch - size.gapY;
    width = size.padX * 2
      + (depths.length === 0 ? size.nodeW : (depths.length - 1) * (size.nodeW + size.gapX) + size.nodeW);
    for (const [columnIndex, depth] of depths.entries()) {
      const list = byDepth.get(depth);
      list.forEach((task, index) => {
        const node = makeNode(
          task,
          size.padX + columnIndex * (size.nodeW + size.gapX),
          size.padY + index * rowPitch,
          size.nodeW,
          size.nodeH,
          columnIndex,
          index,
        );
        placed.set(task.id, node);
        nodes.push(node);
      });
    }
  }

  /** 行间通道的 y（第 `row` 行**下方**那条空隙的中心；行网格对齐时它贯穿全图）。 */
  const channelY = (row) => size.padY + (row + 1) * rowPitch - size.gapY / 2;
  /** 列间通道的 x（第 `col` 列**右侧**那条空隙的中心）。 */
  const channelX = (col) => size.padX + col * (size.nodeW + size.gapX) + size.nodeW + size.gapX / 2;

  // 同一个源出发的跨层连线在通道里各占一条**车道**，否则它们会完全重叠成一条线。
  const lanes = new Map();
  for (const edge of edgesIn) {
    if (!lanes.has(edge.from)) lanes.set(edge.from, []);
    lanes.get(edge.from).push(edge);
  }
  for (const list of lanes.values()) {
    list.sort((left, right) => ((placed.get(left.to)?.y ?? 0) - (placed.get(right.to)?.y ?? 0)));
  }

  const stateOf = new Map(tasks.map((task) => [task.id, task.state]));
  const edges = [];
  for (const edge of edgesIn) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const state = edgeVisualState(stateOf.get(edge.from));
    const span = orientation === "v" ? Math.abs(to.row - from.row) : Math.abs(to.col - from.col);
    const key = `${edge.from}->${edge.to}`;

    if (span <= 1) {
      // 相邻层：只穿过两列之间的空隙，贝塞尔最自然，也绝不会碰到别的节点。
      const start = orientation === "v"
        ? { x: from.x + from.w / 2, y: from.y + from.h }
        : { x: from.x + from.w, y: from.y + from.h / 2 };
      const end = orientation === "v"
        ? { x: to.x + to.w / 2, y: to.y }
        : { x: to.x, y: to.y + to.h / 2 };
      edges.push({
        key,
        from: edge.from,
        to: edge.to,
        state,
        style: "curve",
        path: edgePath(start.x, start.y, end.x, end.y, orientation === "v" ? size.gapY : size.gapX, orientation),
      });
      continue;
    }

    // 跨多层：走正交折线（竖段在列间、横段在行间）。
    const laneList = lanes.get(edge.from) ?? [];
    const lane = laneList.indexOf(edge);
    const share = laneList.length <= 1 ? 0.5 : 0.25 + (0.5 * lane) / (laneList.length - 1);
    const points = [];
    if (orientation === "h") {
      // 走在**目标行**上下最近的那条行间通道里，这样最后的竖段只贴着目标列的左边线走一小截。
      const channel = channelY(to.row);
      const laneX = from.x + from.w + size.gapX * share;
      points.push({ x: from.x + from.w, y: from.y + from.h / 2 });
      points.push({ x: laneX, y: from.y + from.h / 2 });
      points.push({ x: laneX, y: channel });
      points.push({ x: to.x, y: channel });
      points.push({ x: to.x, y: to.y + to.h / 2 });
    } else {
      // 纵向：竖着走不了（会穿过中间的行），于是从左右两侧的**边距通道**绕过去。
      const marginX = to.x + to.w / 2 < width / 2 ? size.padX / 2 : width - size.padX / 2;
      const laneY = from.y + from.h + size.gapY * share;
      points.push({ x: from.x + from.w / 2, y: from.y + from.h });
      points.push({ x: from.x + from.w / 2, y: laneY });
      points.push({ x: marginX, y: laneY });
      points.push({ x: marginX, y: to.y - size.gapY / 2 });
      points.push({ x: to.x + to.w / 2, y: to.y - size.gapY / 2 });
      points.push({ x: to.x + to.w / 2, y: to.y });
    }
    edges.push({ key, from: edge.from, to: edge.to, state, style: "ortho", points, path: orthogonalPath(points) });
  }

  return {
    width, height, nodes, edges, orientation,
    columns: depths.map((depth) => byDepth.get(depth).map((task) => task.id)),
  };
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

/**
 * 连线的图例（三种线型各画一小段真线）。
 *
 * 为什么用真的 SVG 线而不是色块：线型的区别（实/虚/流动）只有画出来才说得清，
 * 用色块表示「虚线」是要靠文字解释的——而看不见的东西才最需要图例。
 * @returns {any}
 */
function EdgeLegend() {
  const samples = [
    { state: "done", label: "上游已完成" },
    { state: "active", label: "上游在跑" },
    { state: "pending", label: "还没轮到" },
  ];
  return h("div", { className: "sbh-legend sbh-legend--edges" }, samples.map((sample) => h("span", {
    key: sample.state,
    className: "sbh-legend__item",
  }, [
    h("svg", { key: "s", className: "sbh-legend__line", width: 26, height: 8, viewBox: "0 0 26 8" },
      h("path", { d: "M1 4 H25", className: `sbh-edge sbh-edge--${sample.state}` })),
    h("span", { key: "l" }, sample.label),
  ])));
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
 * 量一个容器的可用宽度（缩放、换窗口、折叠侧栏都会变）。
 *
 * 用 ResizeObserver 而不是只听 window.resize：面板是**被用户拖着**变宽的，
 * 拖拽过程中 window 尺寸根本没变，只听窗口事件的话图会一直停在旧尺寸——
 * 那正是「拖了但没反应」的手感。SSR（verify-client 的静态渲染）里没有这个 API，
 * 量不到就用默认尺寸渲染，绝不因此抛错。
 *
 * @param {object} ref - React ref（挂在被测容器上）。
 * @returns {number} 可用宽度；量不到时为 0（调用方用默认尺寸）。
 */
function useContainerWidth(ref) {
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const node = ref.current;
    if (node === null || node === undefined) return undefined;
    const measure = () => {
      const next = node.clientWidth ?? 0;
      setWidth((previous) => (Math.abs(previous - next) >= 2 ? next : previous));
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    return undefined;
  }, [ref]);
  return width;
}

/** 清单里有几层（列数）。 */
function countColumns(view) {
  const set = new Set();
  for (const task of view?.tasks ?? []) set.add(Number.isFinite(task.depth) ? task.depth : 0);
  return Math.max(1, set.size);
}

/**
 * 依赖图本体（**纯展示 + 自适应**：尺寸跟着容器走，数据全部来自 props）。
 *
 * 走向由**可用宽度**决定：宽了就横向铺开（左 → 右，并行分叉上下并排），
 * 窄到一定程度才退回纵向流水线（那种宽度下横向只能看到第一个任务）。
 * 两条路共用同一套分层与路由，所以图上的含义不会因为窗口大小而变。
 *
 * @param {object} props - `{view, metrics, onOpenRun, orientation, widthHint}`。
 * @returns {any}
 */
function TaskGraph(props) {
  const { view, metrics, onOpenRun, orientation, widthHint } = props;
  const boxRef = React.useRef(null);
  const measured = useContainerWidth(boxRef);
  const columns = countColumns(view);
  const direction = orientation === "v" || orientation === "h"
    ? orientation
    : (measured > 0 && measured < NARROW_GRAPH_W ? "v" : "h");
  // 首帧还没有测量值（ResizeObserver 在 effect 里才给），而此时用默认尺寸画会
  // 「先按大尺寸铺开、量到宽度后再缩回」——用户看到的是图跳一下。
  // 面板自己知道宽度，就先用它，量到真实值再精修。
  const available = measured > 0 ? measured : (Number(widthHint) > 0 ? Number(widthHint) : 0);
  const size = graphMetricsFor({ width: available, columns, orientation: direction, base: metrics });
  const layout = graphLayout(view, size, direction);
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

    return h("div", { className: "sbh-graph", ref: boxRef },
      h("div", {
        key: "scroll",
        className: "sbh-graph__scroll",
      },
        h("svg", {
        className: `sbh-graph__svg sbh-graph__svg--${direction}`,
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
            // 原生 tooltip：图上的文字是**必然**要截断的（SVG 没有 text-overflow），
            // 截断之后还得有一条路能看到全文，否则用户只能去别处找。
            h("title", { key: "tip" }, `${task.id} ${task.title}\n${node.label}｜${node.meta}`),
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
      ])));
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
    h(EdgeLegend, { key: "edges" }),
    // 设置页宽度足够，固定横向（左 → 右）；尺寸仍然跟着实际可用宽度算。
    h(TaskGraph, { key: "graph", view, metrics, onOpenRun, orientation: "h" }),

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
  const { frame, onOpenRun, width } = props;
  const plans = frame !== undefined && Array.isArray(frame.plans) ? frame.plans : [];
  // 注意：hook 必须在任何 return 之前——没有链路时早期返回是常见写法，
  // 但它会让下一个有链路的渲染多出一个 hook，React 会直接报错（这是 hook 规则里最容易踩的一条）。
  const [selected, setSelected] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  // 图的可用宽度 = 面板宽度 - 面板左右内边距 - 图自己的内边距（两个数字写在 CSS 里，
  // 这里只是给首帧一个差不多的起点，量到真实值之后以测量为准）。
  const narrowHint = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) - 40 : undefined;
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
    ? h("div", { key: "tabs", className: "sbh-tabs" }, plans.map((view) => h("button", {
      key: view.plan?.id ?? "",
      type: "button",
      className: `sbh-tab${(view.plan?.id ?? "") === (plan.id ?? "") ? " sbh-tab--on" : ""}`,
      onClick: () => setSelected(view.plan?.id ?? ""),
      title: `${view.plan?.title ?? ""}（${view.progress?.done ?? 0}/${view.progress?.total ?? 0}）`,
    }, `${view.plan?.title ?? "清单"} ${view.progress?.done ?? 0}/${view.progress?.total ?? 0}`)))
    : null;

  /**
   * 面板里的「继续」：主 agent 已经结束回合、链路停在「可执行」时的**人手开关**。
   *
   * 这是三条补救路径里最后一条（另两条在宿主的 tasks.js：钉住父 agent、按会话活动续跑）。
   * 它必须存在：用户不该为了推一下链路而专门回去找主对话再说一句话。
   */
  const resume = async () => {
    setBusy(true);
    try {
      const result = await hub.post(`/tasks/${plan.id}/activate`, {});
      const payload = result?.payload ?? {};
      const started = Array.isArray(payload.started) ? payload.started : [];
      setNotice({
        kind: result?.ok === true ? "ok" : "error",
        text: result?.ok === true
          ? (started.length > 0 ? `已放行 ${started.map((item) => item.taskId).join("、")}` : "没有可放行的任务")
          : (payload.error ?? `HTTP ${result?.status}`),
      });
    } catch (error) {
      setNotice({ kind: "error", text: `放行失败：${error?.message ?? error}` });
    } finally {
      setBusy(false);
    }
  };

  return h("div", { className: "sbh-tasks" }, [
    h("div", { key: "head", className: "sbh-tasks__head" }, [
      h("span", { key: "dot", className: `sbh-dot ${Number(progress.active ?? 0) > 0 ? "sbh-dot--busy" : "sbh-dot--idle"}` }),
      h("span", { key: "t", className: "sbh-tasks__title", title: plan.title }, plan.title ?? "任务清单"),
      h("span", { key: "s", className: "sbh-spacer" }),
      h("span", { key: "p", className: "sbh-tasks__sub" }, `${progress.done ?? 0}/${progress.total ?? 0} · ${progress.percent ?? 0}%`),
      Number(progress.ready ?? 0) > 0
        ? h("button", {
          key: "resume",
          type: "button",
          className: "sbh-mini-btn sbh-mini-btn--primary",
          disabled: busy,
          title: "把已经就绪的任务放行（主对话不在时用它接着推）",
          onClick: () => { void resume(); },
        }, `继续 ${progress.ready} 项`)
        : null,
    ]),
    tabs,
    h(TaskProgress, { key: "progress", progress }),
    h(TaskLegend, { key: "legend", progress }),
    h(EdgeLegend, { key: "edges" }),
    // 走向与尺寸由 TaskGraph 按可用宽度决定：先用手上知道的宽度垫一帧，
    // 量到真实宽度后再精修（面板被拖大时图跟着变宽，窄到一定程度退回纵向）。
    h(TaskGraph, { key: "graph", view: active, onOpenRun, widthHint: narrowHint }),
    active.next !== undefined && active.next !== ""
      ? h("div", { key: "next", className: "sbh-sub sbh-sub--wrap", title: active.next }, active.next)
      : null,
    plan.activationError !== undefined && plan.activationError !== ""
      ? h("div", { key: "err", className: "sbh-alert sbh-alert--warn" }, plan.activationError)
      : null,
    notice !== null
      ? h("div", { key: "notice", className: `sbh-alert sbh-alert--${notice.kind === "ok" ? "ok" : "error"}` }, notice.text)
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
