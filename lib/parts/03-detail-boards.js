
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
