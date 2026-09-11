
    //#region 群组（团队模式，0.3.0）
    /**
     * 团队模式的界面：群聊记录 + 花名册 + 它派出去的任务链 + 一个让你插话的输入框。
     *
     * ## 为什么这里**不做**「发言调度」的按钮
     *
     * 讨论由宿主侧的驱动循环自己往前走（群主点名 → 成员发言 → 群主回话 → 派活 → 汇报回群）。
     * 面板要是再给一个「下一位」按钮，就会产生第二个调度者：谁按谁说了算，
     * 而模型那边的上下文里并没有「用户替我点了谁」这件事。所以这里只有
     * 暂停 / 继续 / 结束 三个**状态**操作，和一个人人都有的「插话」——
     * 插话的语义是「用户发言」，它也是群主 @用户 之后解锁讨论的方式。
     *
     * ## 展示与取数分开（与 RunDetailView / RunDetail 同一套路）
     *
     * `TeamGroupView` 是纯展示，数据全从 props 来——这样「真实负载渲染出正确界面」
     * 可以被 scripts/verify-client.mjs 在 DSH 之外验证，不必为了测一次渲染去装 jsdom。
     */

    /** 团队状态的人话。表里没有的状态直接显示原值（宁可露出内部词汇，也不要显示空白）。 */
    const TEAM_STATUS_LABEL = {
      idle: "已建群",
      discussing: "讨论中",
      waiting_tasks: "等执行",
      awaiting_user: "等用户",
      paused: "已暂停",
      closed: "已收尾",
      error: "出错了",
    };

    /** 状态 → 徽标样式类（只挑需要强调的两种，其余用中性样式）。 */
    const TEAM_STATUS_CLASS = {
      discussing: "sbh-badge sbh-badge--on",
      waiting_tasks: "sbh-badge sbh-badge--on",
      awaiting_user: "sbh-badge sbh-badge--warn",
      paused: "sbh-badge sbh-badge--off",
      closed: "sbh-badge sbh-badge--off",
      error: "sbh-badge sbh-badge--error",
      idle: "sbh-badge sbh-badge--off",
    };

    /** 消息角色 → 气泡样式（非字面量 className，故不受契约测试的类名扫描约束；但每条都在 CSS 里）。 */
    const TEAM_MSG_CLASS = {
      owner: "sbh-msg sbh-msg--owner",
      member: "sbh-msg",
      user: "sbh-msg sbh-msg--user",
      system: "sbh-msg sbh-msg--system",
    };

    /** 任务状态 → 徽标类（与链路图共用一套状态词汇）。 */
    const TEAM_TASK_CLASS = {
      done: "sbh-task__badge sbh-task__badge--done",
      running: "sbh-task__badge sbh-task__badge--running",
      ready: "sbh-task__badge sbh-task__badge--ready",
      blocked: "sbh-task__badge sbh-task__badge--blocked",
      failed: "sbh-task__badge sbh-task__badge--failed",
    };

    /** 用户要照着写的那三行。空态里直接把它摆出来——比一段解释更容易照做。 */
    const TEAM_DECLARATION_TEMPLATE = "团队名称：xxx项目组\n团队负责人：@xxxxx\n团队成员：@xxx@xxx@xxx";

    /** 时钟文本（群聊要按时间读，秒级足够）。 */
    function teamClock(timestamp) {
      if (!Number.isFinite(timestamp)) return "";
      const date = new Date(timestamp);
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** 说这句话的是谁（渲染成气泡顶部那行小字）。 */
    function teamSpeakerLabel(message) {
      if (message.role === "user") return "你（用户）";
      if (message.role === "system") return message.kind === "status" ? "宿主 · 执行汇报" : "宿主";
      const tag = message.role === "owner" ? "（群主）" : "";
      return `@${message.speaker}${tag}`;
    }

    /**
     * 挑「现在该看哪个团队」。
     *
     * 这条规则出过一次真事故：原来是「第一个没被收尾的团队」，于是
     * **群主一说 @收尾，正在看的那个团队就变成 closed，选中项立刻掉到旁边那个卡住的旧团队上**——
     * 用户看到的是「测试结束之后突然报错，之前的消息全不见了」。
     * 数据一直都在（消息一条没丢），是界面把镜头切走了；而这种错觉比真的丢数据更难排查。
     *
     * 所以规则改成两条，顺序不能反：
     *   1. **有东西在动的优先**（discussing / waiting_tasks）——那是最需要盯的；
     *   2. 其余按 `updatedAt` 取最近有变化的那一个——刚结束的那场讨论，仍然是最新的事实。
     * 用户手动点过的（selectedId）永远优先，否则切页签会被自动选中顶回去。
     *
     * @param {object[]} teams - 宿主给的团队摘要（按创建时间倒序）。
     * @param {string} selectedId - 用户手动选的团队 id（空串表示没选过）。
     * @returns {object|null}
     */
    function pickActiveTeam(teams, selectedId) {
      if (Array.isArray(teams) !== true || teams.length === 0) return null;
      const chosen = teams.find((team) => team.id === selectedId);
      if (chosen !== undefined) return chosen;
      const live = teams.filter((team) => team.status === "discussing" || team.status === "waiting_tasks");
      const pool = live.length > 0 ? live : teams;
      return [...pool].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
    }

    /**
     * 页签文案：同名团队必须能分开。
     *
     * 真机上用户开了两次「团队模式测试群」——两个页签长得一模一样，
     * 一个已收尾、一个卡在中断，光看名字没法点对。
     *
     * @param {object} team - 团队摘要。
     * @param {boolean} duplicated - 是否存在同名团队。
     * @returns {string}
     */
    function teamTabLabel(team, duplicated) {
      const mark = duplicated === true ? ` #${String(team.id).slice(0, 4)}` : "";
      const status = team.status === "closed" ? "已收尾"
        : team.status === "error" ? "已中断"
          : team.status === "paused" ? "已暂停"
            : team.status === "awaiting_user" ? "等你拍板" : "";
      return `${team.name}${mark}${status === "" ? "" : ` · ${status}`}`;
    }

    /**
     * 一条群聊发言（纯展示）。
     * @param {object} props - `{message}`。
     * @returns {object} React 元素。
     */
    function TeamMessageView(props) {
      const message = props.message;
      const base = TEAM_MSG_CLASS[message.role] ?? "sbh-msg";
      return h("div", { className: message.overlong === true ? `${base} sbh-msg--overlong` : base }, [
        h("div", { key: "who", className: "sbh-msg__who" }, [
          h("span", { key: "name" }, teamSpeakerLabel(message)),
          h("span", { key: "spacer", className: "sbh-spacer" }),
          message.overlong === true ? h("span", { key: "long", title: "超过群规字数上限" }, "超长") : null,
          h("span", { key: "at" }, teamClock(message.createdAt)),
        ]),
        h("div", { key: "text", className: "sbh-msg__text" }, message.text),
      ]);
    }

    /**
     * 群组视图（**纯展示**）。
     * @param {object} props - 见下方 const 解构。
     * @returns {object|null} React 元素。
     */
    function TeamGroupView(props) {
      const {
        teamMode, teams, active, detail, error, actionError, busy, draft,
        logRef, onSelect, onDraft, onSend, onStart, onPause, onClose, onOpenRun, onLogScroll,
      } = props;

      if (teamMode !== true && teams.length === 0) {
        return h("div", { className: "sbh-team" }, [
          h("div", { key: "hint", className: "sbh-empty" },
            "团队模式关着。把输入栏那一行的「团队模式」拉到「开」，然后在消息里这样声明一个团队："),
          h("pre", { key: "tpl", className: "sbh-pre sbh-pre--dim" }, TEAM_DECLARATION_TEMPLATE),
        ]);
      }
      if (teams.length === 0) {
        return h("div", { className: "sbh-team" }, [
          h("div", { key: "hint", className: "sbh-empty" },
            "还没有团队。团队模式已开——在消息里按下面三行声明，宿主就会开一场群聊，群主主持讨论并直接把分工派成任务链："),
          h("pre", { key: "tpl", className: "sbh-pre sbh-pre--dim" }, TEAM_DECLARATION_TEMPLATE),
        ]);
      }

      const messages = Array.isArray(detail?.messages) ? detail.messages : [];
      const players = Array.isArray(detail?.players) ? detail.players : [];
      const plan = detail?.plan ?? null;
      const awaitingUser = active.status === "awaiting_user";
      const closed = active.status === "closed";
      const running = active.status === "discussing" || active.status === "waiting_tasks";

      const planTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
      const doneCount = planTasks.filter((task) => task.state === "done").length;

      // 同名团队要能分开（否则两个「测试群」并排时点不对）。
      const nameCount = new Map();
      for (const team of teams) nameCount.set(team.name, (nameCount.get(team.name) ?? 0) + 1);

      return h("div", { className: "sbh-team" }, [
        // 多个团队时给一排页签（复用清单标签那套样式）。
        teams.length > 1
          ? h("div", { key: "tabs", className: "sbh-tabs" }, teams.map((team) => h("button", {
            key: team.id,
            type: "button",
            className: `sbh-tab${team.id === active.id ? " sbh-tab--on" : ""}`,
            title: `${team.name}｜${TEAM_STATUS_LABEL[team.status] ?? team.status}${team.mission === "" ? "" : `｜${team.mission}`}`,
            onClick: () => onSelect(team.id),
          }, teamTabLabel(team, (nameCount.get(team.name) ?? 0) > 1))))
          : null,

        h("div", { key: "head", className: "sbh-team__head" }, [
          h("span", { key: "name", className: "sbh-team__name", title: active.mission }, active.name),
          h("span", {
            key: "status",
            className: TEAM_STATUS_CLASS[active.status] ?? "sbh-badge sbh-badge--off",
          }, TEAM_STATUS_LABEL[active.status] ?? active.status),
          active.speaker === ""
            ? null
            : h("span", { key: "speaking", className: "sbh-team__meta" }, `正在说 @${active.speaker}`),
          h("span", { key: "spacer", className: "sbh-spacer" }),
          h("span", { key: "rounds", className: "sbh-team__meta" }, `第 ${active.rounds}/${active.maxRounds} 轮`),
        ]),

        // 花名册：谁能说话、谁正忙。忙闲直接影响「为什么现在没人说话」，所以要显示出来。
        h("div", { key: "members", className: "sbh-team__members" }, players.length > 0
          ? players.map((player) => h("span", {
            key: player.name,
            className: `sbh-chip${player.role === "owner" ? " sbh-chip--owner" : ""}${player.busy === true ? " sbh-chip--busy" : ""}`,
            title: `${player.model}${player.configured === false ? "（未配置）" : ""}${player.busy === true ? "｜正在跑" : ""}`,
          }, `${player.role === "owner" ? "群主 " : ""}@${player.name}${player.busy === true ? " ●" : ""}`))
          : h("span", { key: "owner", className: "sbh-chip sbh-chip--owner" }, `群主 @${active.ownerName}`)),

        // 它派出去的任务链：讨论与执行是同一场会，所以链就摆在群聊上面。
        plan === null
          ? null
          : h("div", { key: "plan", className: "sbh-team__plan" }, [
            h("div", { key: "row", className: "sbh-team__planrow" }, [
              h("span", { key: "t", className: "sbh-team__meta" },
                `任务链 ${plan.id}｜${doneCount}/${planTasks.length} 完成${plan.autoActivate === true ? "｜固定自动激活" : ""}`),
              h("span", { key: "spacer", className: "sbh-spacer" }),
              plan.next === "" ? null : h("span", { key: "next", className: "sbh-team__meta", title: plan.next }, plan.next),
            ]),
            h("div", { key: "bar", className: "sbh-progress" }, [
              h("span", {
                key: "seg",
                className: "sbh-progress__seg sbh-progress__seg--done",
                style: { width: `${planTasks.length === 0 ? 0 : Math.round((doneCount / planTasks.length) * 100)}%` },
              }),
            ]),
            h("div", { key: "tasks", className: "sbh-team__planrow" }, planTasks.map((task) => h("button", {
              key: task.id,
              type: "button",
              className: "sbh-mini-btn",
              disabled: typeof onOpenRun !== "function" || task.runId === "" || task.runId === undefined,
              title: `${task.title}｜@${task.agentName}${task.runId === "" || task.runId === undefined ? "" : "（点开看这次运行）"}`,
              onClick: () => onOpenRun?.(task.runId),
            }, h("span", { className: TEAM_TASK_CLASS[task.state] ?? "sbh-task__badge" },
              `${task.id} ${task.agentName}`)))),
          ]),

        error === null || error === undefined
          ? null
          : h("div", { key: "err", className: "sbh-alert sbh-alert--error" }, error),
        actionError === ""
          ? null
          : h("div", { key: "aerr", className: "sbh-alert sbh-alert--error" }, actionError),
        active.lastError === ""
          ? null
          : h("div", { key: "lerr", className: "sbh-alert sbh-alert--warn" }, active.lastError),

        // 群聊记录：有新消息时自动滚到底（但用户手动往上翻的时候不许把他拽回来，见 onLogScroll）。
        h("div", { key: "log", className: "sbh-team__log", ref: logRef, onScroll: onLogScroll }, messages.length === 0
          ? h("div", { key: "none", className: "sbh-empty" }, "群里还没有人说话。")
          : messages.map((message) => h(TeamMessageView, { key: message.id ?? message.seq, message }))),

        h("div", { key: "compose", className: "sbh-team__compose" }, [
          h("div", { key: "row", className: "sbh-team__row" }, [
            h("button", {
              key: "start",
              type: "button",
              className: "sbh-mini-btn sbh-mini-btn--primary",
              disabled: busy || closed || running,
              title: "让群主从当前进度接着主持（暂停后、或需要它继续时用）",
              onClick: onStart,
            }, "继续"),
            h("button", {
              key: "pause",
              type: "button",
              className: "sbh-mini-btn",
              disabled: busy || closed || !running,
              title: "暂停讨论：正在说话的那位会说完，之后不再自动往下走",
              onClick: onPause,
            }, "暂停"),
            h("button", {
              key: "close",
              type: "button",
              className: "sbh-mini-btn sbh-mini-btn--danger",
              disabled: busy || closed,
              title: "结束这场讨论。已经派出去的任务继续跑，跑完的汇报仍会进群",
              onClick: onClose,
            }, "结束"),
            h("span", { key: "spacer", className: "sbh-spacer" }),
            h("span", { key: "count", className: "sbh-team__meta" }, `${messages.length} 条`),
          ]),
          h("textarea", {
            key: "input",
            className: "sbh-input sbh-textarea",
            rows: 2,
            value: draft,
            disabled: busy || active.id === "",
            placeholder: closed ? "这场讨论已经结束了（还能留言，但不会再自动往下走）" : "在群里说一句：群主会接着安排（Enter 发送，Shift+Enter 换行）",
            onChange: (event) => onDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== "Enter" || event.shiftKey === true) return;
              event.preventDefault();
              onSend();
            },
          }),
          h("div", { key: "hint", className: "sbh-team__hint" },
            awaitingUser
              ? "群主在等你拍板：你这一句说完，话语权立刻回到群主。"
              : (active.status === "error"
                // 这一条是给「旧版本建出来、父会话是空串」的那类团队用的：
                // 它们不需要重建，点一下「继续」就会被补记到当前会话上。
                ? "这个团队上一次中断了（原因见上面的提示）。点「继续」会把它补记到当前会话上，再试一次。"
                : "你说话 = 用户发言，之后话语权回到群主；讨论推进仍然是宿主自己走，不需要你代谁传话。")),
        ]),
      ]);
    }

    /**
     * 跟一个团队的详情（群聊记录 + 花名册 + 任务链）。
     *
     * 触发时机有两个来源，缺一不可：
     *   - `lastSeq`（SSE 每秒推的摘要里的消息序号）变了 → 立刻重拉一次（一秒钟看得见新发言）；
     *   - 1.5s 兜底轮询 → 覆盖「流断了 / 宿主没推那一帧」的情况。
     * 只有轮询会让有人的群聊慢一拍，只有 SSE 则会在断流时彻底停住。
     *
     * @param {string} teamId - 团队 id。
     * @param {number} lastSeq - 宿主摘要里的最后消息序号。
     * @param {number} bump - 外部动作（说话/暂停）后强制重拉的计数。
     * @returns {{detail:object|null, error:string|null}}
     */
    function useTeamDetail(teamId, lastSeq, bump) {
      const [state, setState] = React.useState({ detail: null, error: null });

      React.useEffect(() => {
        if (typeof teamId !== "string" || teamId === "") {
          setState({ detail: null, error: null });
          return undefined;
        }
        let cancelled = false;
        const tick = async () => {
          try {
            const response = await fetch(
              `${ENDPOINT}/team/${encodeURIComponent(teamId)}?limit=200`,
              { headers: { accept: "application/json" } },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (!cancelled) setState({ detail: payload, error: null });
          } catch (error) {
            if (!cancelled) {
              setState((previous) => ({ ...previous, error: `拉取群聊失败：${error?.message ?? error}` }));
            }
          }
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, 1500);
        return () => { cancelled = true; clearInterval(timer); };
      }, [teamId, lastSeq, bump]);

      return state;
    }

    /**
     * 群组容器：选团队、取数、发话与状态操作。
     * @param {{onOpenRun?:Function}} props - 打开某次运行的回调（任务节点点进去看会话）。
     * @returns {object} React 元素。
     */
    function TeamPanel(props) {
      const { onOpenRun } = props;
      const state = useHub();
      const frame = state.team ?? { teams: [], total: 0, teamMode: false, active: 0 };
      const teams = frame.teams;

      const [selectedId, setSelectedId] = React.useState("");
      const [draft, setDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [actionError, setActionError] = React.useState("");
      const [bump, setBump] = React.useState(0);
      const logRef = React.useRef(null);
      /**
       * 「用户现在是不是贴在底部」。
       *
       * 群聊在自动推进（每几秒就有一条新发言），无条件滚到底会把正在往上翻记录的人
       * 一次次拽回最新一行——那是聊天界面最让人恼火的一种行为。
       * 用 ref 而不是 state：它只影响滚动，不该触发重渲染。
       */
      const stickRef = React.useRef(true);

      // 默认挑「最需要看的那个」：正在推进的优先，否则取最近有变化的那一个。
      // 判据在 pickActiveTeam 里（它同时被 scripts/verify-client.mjs 断言）——
      // 「收尾之后镜头切到别的团队」那次事故就是这条规则的退化版本。
      const active = pickActiveTeam(teams, selectedId);
      const activeId = active === null ? "" : active.id;
      const fetched = useTeamDetail(activeId, active === null ? 0 : active.lastSeq, bump);
      const detail = fetched.detail;

      // 新消息落地就滚到底——但只在用户本来就贴着底部时。
      // 依赖用「最后一条的 seq」这个数字（不是 messages 数组）：整篇重渲染不该触发滚动。
      const messages = Array.isArray(detail?.messages) ? detail.messages : [];
      const tailSeq = messages.length === 0 ? 0 : messages[messages.length - 1].seq;
      React.useEffect(() => {
        const node = logRef.current;
        if (node === null || node === undefined || typeof node.scrollTop !== "number") return;
        if (stickRef.current !== true) return;
        node.scrollTop = node.scrollHeight;
      }, [tailSeq, activeId]);

      /** 记录「用户有没有贴在底部」（离底 60px 以内就算贴着）。 */
      const onLogScroll = React.useCallback((event) => {
        const node = event?.currentTarget;
        if (node === null || node === undefined) return;
        const distance = Number(node.scrollHeight ?? 0) - Number(node.scrollTop ?? 0) - Number(node.clientHeight ?? 0);
        stickRef.current = distance < 60;
      }, []);

      /** 切团队时重新贴底：新群聊的「上次滚到哪」没有意义。 */
      React.useEffect(() => { stickRef.current = true; }, [activeId]);

      /** 发一个写请求，失败就把原因摆到面板上（不静默吞掉），并回报成功与否。 */
      const call = React.useCallback(async (suffix, body) => {
        if (activeId === "") return false;
        setBusy(true);
        setActionError("");
        const result = await hub.post(`/team/${encodeURIComponent(activeId)}${suffix}`, body ?? {});
        setBusy(false);
        if (!result.ok) {
          setActionError(result.payload?.error ?? `HTTP ${result.status}`);
          return false;
        }
        setBump((value) => value + 1);
        return true;
      }, [activeId]);

      const onSend = React.useCallback(async () => {
        const text = draft.trim();
        if (text === "" || busy) return;
        setDraft("");
        // 发失败就把话放回输入框：用户刚写的东西不该因为一次网络抖动而消失。
        const ok = await call("/say", { text });
        if (ok !== true) setDraft(text);
      }, [busy, call, draft]);

      return h(TeamGroupView, {
        teamMode: frame.teamMode === true,
        teams,
        active: active ?? { id: "", name: "", ownerName: "", status: "idle", rounds: 0, maxRounds: 0, speaker: "", lastError: "", mission: "" },
        detail,
        error: fetched.error,
        actionError,
        busy,
        draft,
        logRef,
        onLogScroll,
        onSelect: (teamId) => setSelectedId(teamId),
        onDraft: (value) => setDraft(value),
        onSend,
        // 「继续」带上当前会话 id：团队若因为定位不到父会话而中断过，
        // 这一下就把它补上了（面板此刻知道自己在哪个会话里，宿主未必查得到）。
        onStart: () => { void call("/start", { parentSessionId: state.sessionId ?? "" }); },
        onPause: () => { void call("/pause"); },
        onClose: () => { void call("/close"); },
        onOpenRun,
      });
    }
    //#endregion
