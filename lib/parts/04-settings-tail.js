
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
    };
    return module.exports;
  },
});
