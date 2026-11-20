/* generated from packages/core/client-src — run: npm run build:client */
"use strict";
(() => {
  // packages/core/client-src/channels.js
  var PKG = "@derekluo/dsh-channels";
  var CHANNELS = [
    { id: "weixin", row: "weixin-user", badge: { en: "WeChat", zh: "\u5FAE\u4FE1" }, accent: "#07C160", accentSoft: "rgba(7, 193, 96, 0.12)" },
    { id: "telegram", row: "telegram-user", badge: { en: "Telegram", zh: "\u7535\u62A5" }, accent: "#2AABEE", accentSoft: "rgba(42, 171, 238, 0.12)" },
    { id: "feishu", row: "feishu-user", badge: { en: "Feishu", zh: "\u98DE\u4E66" }, accent: "#3370FF", accentSoft: "rgba(51, 112, 255, 0.12)" }
  ];
  var byKind = new Map(CHANNELS.map((channel) => [channel.id, channel]));
  function translator() {
    const lang = String(typeof navigator !== "undefined" && navigator.language || "en").toLowerCase();
    const chinese = lang.startsWith("zh");
    return (en, zh) => chinese ? zh : en;
  }
  function shortSender(senderId) {
    const value = String(senderId ?? "");
    const at = value.indexOf("@");
    const name = at > 0 ? value.slice(0, at) : value;
    return name.length > 12 ? `${name.slice(0, 12)}\u2026` : name;
  }
  function rowData(message) {
    const source = message?.source ?? {};
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const content = source.hasOutputInstruction === true ? blocks.slice(1) : blocks;
    const texts = [];
    let others = 0;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block !== null && block !== void 0) others += 1;
    }
    return {
      text: texts.join("\n").trim(),
      others,
      group: source.group === true,
      senderId: typeof source.senderId === "string" ? source.senderId : ""
    };
  }

  // packages/core/client-src/rows.js
  function definitionFor(channel) {
    return {
      kind: channel.row,
      target: "chat",
      match: (event) => {
        if (event?.type !== "user/message") return null;
        if (event.data?.source?.kind !== channel.id) return null;
        return { id: String(event.data.id), role: "start", exclusive: true };
      },
      start: (_context, match) => rowData(match.event.data),
      // One message is one start; a second start for the same id keeps the
      // earliest state rather than inventing a merge.
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === void 0) return null;
        const start = context.start ?? context.matches[0];
        return {
          key: context.key,
          kind: channel.row,
          id: context.id,
          target: "chat",
          anchorSeq: start?.event?.seq ?? 0,
          location: start?.location ?? { kind: "unresolved" },
          visibility: "visible",
          // A channel message opens an exchange; whole-Turn folding has to keep
          // it visible as the opening input.
          groupTree: "exchange",
          data: context.state
        };
      }
    };
  }
  function createRow(channel, t, h) {
    const metaStyle = {
      display: "flex",
      alignItems: "center",
      gap: 6,
      fontSize: 12,
      lineHeight: "16px",
      color: "var(--dsw-label-tertiary, rgba(128, 128, 128, 0.9))"
    };
    const badgeStyle = {
      display: "inline-flex",
      alignItems: "center",
      padding: "0 6px",
      borderRadius: 999,
      background: channel.accentSoft,
      color: channel.accent,
      fontSize: 11,
      lineHeight: "16px",
      fontWeight: 600
    };
    const bubbleStyle = {
      maxWidth: "min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)",
      padding: "10px 16px",
      borderRadius: "var(--dsw-radius-xl, 20px)",
      background: "var(--dsw-specific-bubble, rgba(128, 128, 128, 0.12))",
      color: "var(--dsw-label-primary, inherit)",
      fontSize: "var(--dsh-content-font-size, 14px)",
      lineHeight: "calc(22px + var(--dsh-content-font-delta, 0px))",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word"
    };
    return function ChannelRowView({ node }) {
      const data = node?.data ?? {};
      const text = typeof data.text === "string" ? data.text : "";
      const meta = [];
      if (data.group === true) meta.push(t("Group", "\u7FA4\u804A"));
      if (typeof data.senderId === "string" && data.senderId !== "") meta.push(shortSender(data.senderId));
      if (Number(data.others) > 0) meta.push(t(`${data.others} attachment(s)`, `${data.others} \u4E2A\u9644\u4EF6`));
      return h(
        "div",
        { "data-channels-chat-row": channel.id, style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 } },
        h(
          "div",
          { style: metaStyle },
          h("span", { style: badgeStyle }, t(channel.badge.en, channel.badge.zh)),
          meta.length > 0 ? h("span", null, meta.join(" \xB7 ")) : null
        ),
        h("div", { style: bubbleStyle }, text === "" ? t("(empty message)", "\uFF08\u7A7A\u6D88\u606F\uFF09") : text)
      );
    };
  }

  // packages/core/client-src/card.js
  function createCard(t, React, h) {
    const text = (value, fallback) => typeof value === "string" && value !== "" ? value : fallback;
    const cell = { padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-divider, rgba(128,128,128,0.2))", fontSize: 13, verticalAlign: "top" };
    const headCell = { ...cell, fontSize: 12, fontWeight: 600, color: "var(--dsw-label-secondary, rgba(128,128,128,1))" };
    const cardStyle = {
      display: "flex",
      flexDirection: "column",
      gap: 16,
      padding: 20,
      borderRadius: "var(--dsw-radius-l, 14px)",
      background: "var(--dsw-alias-panel, rgba(128,128,128,0.06))",
      color: "var(--dsw-alias-label, inherit)"
    };
    const row = (cells) => h("tr", null, ...cells.map((value, index) => h("td", { key: index, style: cell }, value)));
    const stateColor = (state) => state === "accepted" ? "#2f9e44" : state === "pending" ? "#b08900" : state === "unconfirmed" ? "#b08900" : "#c92a2a";
    return function ChannelsStatusCard() {
      const [state, setState] = React.useState({ phase: "loading", data: null, error: "" });
      const load = React.useCallback(() => {
        setState((current) => ({ ...current, phase: "loading", error: "" }));
        const fail = (error) => setState({ phase: "error", data: null, error: String(error && error.message || error) });
        const accept = (payload) => setState({ phase: "ready", data: payload, error: "" });
        fetch("/channels/status", { credentials: "same-origin", headers: { accept: "application/json" } }).then((response) => {
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          return response.json();
        }).then(accept, fail);
      }, []);
      React.useEffect(() => {
        load();
      }, [load]);
      const data = state.data;
      return h(
        "div",
        { "data-channels-card": "", style: cardStyle },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("div", { style: { fontSize: 15, fontWeight: 600 } }, t("Channels", "\u901A\u9053")),
            h(
              "div",
              { style: { fontSize: 12, color: "var(--dsw-label-secondary, rgba(128,128,128,1))" } },
              t("Messages from a chat app, answered by this agent.", "\u6765\u81EA\u804A\u5929\u8F6F\u4EF6\u7684\u6D88\u606F\uFF0C\u7531\u8FD9\u4E2A agent \u6765\u56DE\u7B54\u3002")
            )
          ),
          h("button", {
            type: "button",
            onClick: load,
            style: {
              padding: "6px 12px",
              borderRadius: "var(--dsw-radius-m, 10px)",
              border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))",
              background: "transparent",
              color: "inherit",
              fontSize: 13,
              cursor: "pointer"
            }
          }, state.phase === "loading" ? t("Refreshing\u2026", "\u5237\u65B0\u4E2D\u2026") : t("Refresh", "\u5237\u65B0"))
        ),
        state.phase === "error" ? h("div", { "data-channels-card-error": "", style: { color: "#c92a2a", fontSize: 13 } }, state.error) : null,
        data === null && state.phase !== "error" ? h("div", { style: { fontSize: 13, opacity: 0.7 } }, t("Loading\u2026", "\u52A0\u8F7D\u4E2D\u2026")) : null,
        data !== null ? h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 14 } },
          h("div", { style: { fontSize: 12, opacity: 0.75 } }, `${t("State", "\u72B6\u6001\u76EE\u5F55")}: ${text(data.stateRoot, "\u2014")}`),
          h(
            "table",
            { style: { width: "100%", borderCollapse: "collapse" } },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { style: { ...headCell, textAlign: "left" } }, t("Channel", "\u901A\u9053")),
                h("th", { style: { ...headCell, textAlign: "left" } }, t("Account", "\u8D26\u53F7")),
                h("th", { style: { ...headCell, textAlign: "left" } }, t("Allowed senders", "\u5141\u8BB8\u7684\u53D1\u9001\u8005")),
                h("th", { style: { ...headCell, textAlign: "left" } }, t("Media", "\u5A92\u4F53"))
              )
            ),
            h(
              "tbody",
              null,
              (data.channels || []).map((channel) => h(
                "tr",
                { key: channel.id },
                h("td", { style: cell }, text(channel.label && channel.label.zh, channel.id)),
                h("td", { style: cell }, (channel.accounts || []).map((account) => `${account.label || account.accountId}${account.expired ? t(" (expired)", "\uFF08\u5DF2\u8FC7\u671F\uFF09") : ""}`).join(" \xB7 ") || "\u2014"),
                h("td", { style: cell }, (channel.accounts || []).map((account) => `${account.accountId}: ${account.allowedSenders}`).join(" \xB7 ") || "\u2014"),
                h("td", { style: cell }, ["image", "file", "voice", "video"].filter((kind) => channel.media && channel.media[kind]).join(" \xB7 ") || "\u2014")
              )),
              (data.channels || []).length === 0 ? h("tr", null, h("td", { colSpan: 4, style: { ...cell, opacity: 0.7 } }, t("No channel is mounted.", "\u6CA1\u6709\u6302\u8F7D\u4EFB\u4F55\u901A\u9053\u3002"))) : null
            )
          ),
          h(
            "div",
            { style: { display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, opacity: 0.85 } },
            h("span", null, `${t("Queued inputs", "\u6392\u961F\u8F93\u5165")}: ${Number(data.inboxPending) || 0}`),
            h("span", null, `${t("Outbox", "\u5F85\u91CD\u53D1")}: ${Number(data.outboxPending) || 0}`),
            h("span", null, `${t("Waiting for an answer", "\u7B49\u5F85\u7B54\u590D")}: ${data.interactions && data.interactions.pending ? t("yes", "\u6709") : t("no", "\u65E0")}`)
          ),
          h(PendingPairings, { data, reload: load, t, React, h }),
          h(AllowlistEditor, { data, reload: load, t, React, h }),
          h(SettingsEditor, { data, reload: load, t, React, h }),
          (data.journal || []).length > 0 ? h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t("Recent outbound", "\u6700\u8FD1\u7684\u53D1\u51FA")),
            ...data.journal.map((entry, index) => h(
              "div",
              {
                key: `${entry.kind}-${index}`,
                style: { display: "flex", gap: 10, fontSize: 12, alignItems: "baseline" }
              },
              h("span", { style: { color: stateColor(entry.state), minWidth: 84 } }, String(entry.state)),
              h("span", { style: { opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, text(entry.text, "\u2014"))
            ))
          ) : h("div", { style: { fontSize: 12, opacity: 0.7 } }, t("Nothing has been sent yet.", "\u8FD8\u6CA1\u6709\u53D1\u51FA\u8FC7\u6D88\u606F\u3002"))
        ) : null
      );
    };
  }
  async function postJson(route, body) {
    const response = await fetch(route, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.detail || `${response.status} ${response.statusText}`);
    return result;
  }
  function PendingPairings({ data, reload, t, React, h }) {
    const list = Array.isArray(data.pairings) ? data.pairings : [];
    const [busy, setBusy] = React.useState("");
    const [error, setError] = React.useState("");
    if (list.length === 0) return null;
    const act = (id, action) => {
      setBusy(id);
      setError("");
      postJson("/channels/pairing", { id, action }).then(() => {
        reload();
      }).catch((cause) => setError(String(cause && cause.message || cause))).finally(() => setBusy(""));
    };
    const button = (id, action, label, danger) => h("button", {
      type: "button",
      disabled: busy === id,
      "data-channels-pairing": action,
      onClick: () => act(id, action),
      style: {
        padding: "4px 10px",
        borderRadius: 8,
        border: `1px solid ${danger ? "rgba(201,42,42,0.5)" : "var(--dsw-alias-divider, rgba(128,128,128,0.3))"}`,
        background: "transparent",
        color: danger ? "#c92a2a" : "inherit",
        fontSize: 12,
        cursor: busy === id ? "default" : "pointer",
        opacity: busy === id ? 0.5 : 1
      }
    }, label);
    return h(
      "div",
      { "data-channels-pairings": "", style: { display: "flex", flexDirection: "column", gap: 8 } },
      h("div", { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t("Pending senders", "\u5F85\u6279\u51C6\u7684\u53D1\u9001\u8005")),
      h("div", { style: { fontSize: 12, opacity: 0.75 } }, t("Approve the people you trust. Everyone else stays refused.", "\u53EA\u6279\u51C6\u4F60\u4FE1\u4EFB\u7684\u4EBA\uFF1B\u5176\u4F59\u53D1\u9001\u8005\u7EE7\u7EED\u88AB\u62D2\u7EDD\u3002")),
      ...list.map((pairing) => h(
        "div",
        { key: pairing.id, style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 } },
        h("span", { style: { fontWeight: 600 } }, `${pairing.channel} \xB7 ${pairing.accountId}`),
        h("span", { style: { opacity: 0.85 } }, pairing.senderId),
        h("span", { style: { opacity: 0.6, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, pairing.text || t("(attachment)", "\uFF08\u9644\u4EF6\uFF09")),
        button(pairing.id, "approve", t("Allow", "\u5141\u8BB8"), false),
        button(pairing.id, "deny", t("Deny", "\u62D2\u7EDD"), true)
      )),
      error !== "" ? h("div", { "data-channels-pairings-error": "", style: { color: "#c92a2a", fontSize: 12 } }, error) : null
    );
  }
  function AllowlistEditor({ data, reload, t, React, h }) {
    const [value, setValue] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const list = Array.isArray(data.allowlist) ? data.allowlist : [];
    const send = (patch) => {
      setBusy(true);
      setError("");
      postJson("/channels/allowlist", patch).then(() => {
        setValue("");
        reload();
      }).catch((cause) => setError(String(cause && cause.message || cause))).finally(() => setBusy(false));
    };
    const chip = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 8px",
      borderRadius: 999,
      background: "rgba(128,128,128,0.12)",
      fontSize: 12
    };
    return h(
      "div",
      { "data-channels-allowlist": "", style: { display: "flex", flexDirection: "column", gap: 8 } },
      h("div", { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t("Allowed senders", "\u5141\u8BB8\u7684\u53D1\u9001\u8005")),
      h(
        "div",
        { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        list.length === 0 ? h("span", { style: { fontSize: 12, opacity: 0.7 } }, t("Nobody yet \u2014 every message is refused.", "\u8FD8\u6CA1\u6709\u4EBA \u2014\u2014 \u6240\u6709\u6D88\u606F\u90FD\u4F1A\u88AB\u62D2\u7EDD\u3002")) : list.map(
          (sender) => h(
            "span",
            { key: sender, style: chip },
            h("span", null, sender),
            h("button", {
              type: "button",
              "data-channels-remove": sender,
              disabled: busy,
              onClick: () => send({ remove: sender }),
              title: t("Remove", "\u79FB\u9664"),
              style: { border: "none", background: "transparent", cursor: "pointer", color: "inherit", opacity: 0.7, padding: 0, fontSize: 12 }
            }, "\u2715")
          )
        )
      ),
      h(
        "div",
        { style: { display: "flex", gap: 8 } },
        h("input", {
          value,
          placeholder: t("sender id, e.g. wxid_xxx@im.wechat", "\u53D1\u9001\u8005 id\uFF0C\u4F8B\u5982 wxid_xxx@im.wechat"),
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter" && value.trim() !== "" && !busy) send({ add: value.trim() });
          },
          style: {
            flex: 1,
            padding: "6px 10px",
            borderRadius: "var(--dsw-radius-m, 10px)",
            border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))",
            background: "transparent",
            color: "inherit",
            fontSize: 13
          }
        }),
        h("button", {
          type: "button",
          disabled: busy || value.trim() === "",
          onClick: () => send({ add: value.trim() }),
          style: {
            padding: "6px 14px",
            borderRadius: "var(--dsw-radius-m, 10px)",
            border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))",
            background: "transparent",
            color: "inherit",
            fontSize: 13,
            cursor: busy || value.trim() === "" ? "default" : "pointer",
            opacity: busy || value.trim() === "" ? 0.5 : 1
          }
        }, busy ? t("Saving\u2026", "\u4FDD\u5B58\u4E2D\u2026") : t("Add", "\u6DFB\u52A0"))
      ),
      error !== "" ? h("div", { "data-channels-allowlist-error": "", style: { color: "#c92a2a", fontSize: 12 } }, error) : null
    );
  }
  function SettingsEditor({ data, reload, t, React, h }) {
    const live = data.settings || {};
    const [edits, setEdits] = React.useState({});
    const values = {
      senderPerMinute: String(live.senderPerMinute ?? 6),
      senderPerDay: String(live.senderPerDay ?? 60),
      autoSendFiles: live.autoSendFiles !== false,
      questionsEnabled: live.questionsEnabled !== false,
      approvalsEnabled: live.approvalsEnabled !== false,
      ...edits
    };
    const [busy, setBusy] = React.useState(false);
    const [saved, setSaved] = React.useState("");
    const [error, setError] = React.useState("");
    const save = () => {
      setBusy(true);
      setError("");
      setSaved("");
      postJson("/channels/settings", Object.fromEntries(Object.entries(edits).map(([key, value]) => [key, key === "senderPerMinute" || key === "senderPerDay" ? Number(value) : value]))).then(() => {
        setEdits({});
        setSaved(t("Saved \u2014 it applies to the next message.", "\u5DF2\u4FDD\u5B58 \u2014\u2014 \u4E0B\u4E00\u6761\u6D88\u606F\u5C31\u751F\u6548\u3002"));
        reload();
      }).catch((cause) => setError(String(cause && cause.message || cause))).finally(() => setBusy(false));
    };
    const numberField = (label, key) => h(
      "label",
      { key, style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
      h("span", { style: { opacity: 0.8 } }, label),
      h("input", {
        type: "number",
        min: 0,
        value: values[key],
        disabled: busy,
        onChange: (event) => setEdits((current) => ({ ...current, [key]: event.target.value })),
        style: {
          width: 96,
          padding: "5px 8px",
          borderRadius: "var(--dsw-radius-m, 10px)",
          border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))",
          background: "transparent",
          color: "inherit",
          fontSize: 13
        }
      })
    );
    const toggle = (label, key) => h(
      "label",
      { key, style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
      h("input", {
        type: "checkbox",
        checked: values[key],
        disabled: busy,
        onChange: (event) => setEdits((current) => ({ ...current, [key]: event.target.checked }))
      }),
      h("span", { style: { opacity: 0.85 } }, label)
    );
    return h(
      "div",
      { "data-channels-settings": "", style: { display: "flex", flexDirection: "column", gap: 10 } },
      h("div", { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t("Limits and behaviour", "\u9650\u6D41\u4E0E\u884C\u4E3A")),
      h(
        "div",
        { style: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" } },
        numberField(t("Messages / minute (0 = unlimited)", "\u6BCF\u5206\u949F\u6D88\u606F\u6570\uFF080 = \u4E0D\u9650\uFF09"), "senderPerMinute"),
        numberField(t("Messages / day (0 = unlimited)", "\u6BCF\u5929\u6D88\u606F\u6570\uFF080 = \u4E0D\u9650\uFF09"), "senderPerDay")
      ),
      h(
        "div",
        { style: { display: "flex", gap: 16, flexWrap: "wrap" } },
        toggle(t("Send files the agent produced", "\u53D1\u9001 agent \u4EA7\u751F\u7684\u6587\u4EF6"), "autoSendFiles"),
        toggle(t("Ask questions in the chat", "\u5141\u8BB8\u5728\u804A\u5929\u91CC\u63D0\u95EE"), "questionsEnabled"),
        toggle(t("Approve tool calls in the chat", "\u5141\u8BB8\u5728\u804A\u5929\u91CC\u5BA1\u6279"), "approvalsEnabled")
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 10 } },
        h("button", {
          type: "button",
          disabled: busy || Object.keys(edits).length === 0,
          onClick: save,
          style: {
            padding: "6px 14px",
            borderRadius: "var(--dsw-radius-m, 10px)",
            border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))",
            background: "transparent",
            color: "inherit",
            fontSize: 13,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1
          }
        }, busy ? t("Saving\u2026", "\u4FDD\u5B58\u4E2D\u2026") : t("Save", "\u4FDD\u5B58")),
        saved !== "" ? h("span", { style: { color: "#2f9e44", fontSize: 12 } }, saved) : null,
        error !== "" ? h("span", { "data-channels-settings-error": "", style: { color: "#c92a2a", fontSize: 12 } }, error) : null
      )
    );
  }

  // packages/core/client-src/index.js
  function createClient(require2) {
    const React = require2("react");
    const h = React.createElement;
    function registerRows(ctx, uiConversation) {
      const t = translator();
      const disposers = [];
      for (const channel of CHANNELS) {
        if (!byKind.has(channel.id)) continue;
        const disposeDefinition = uiConversation.events.register(definitionFor(channel));
        let disposeSeat;
        const seat = ctx.slots.inject("conversation.chat.node", () => {
          disposeSeat = ctx.slots.register({ name: "conversation.chat.node", key: channel.row }, createRow(channel, t, h));
          return disposeSeat;
        });
        disposers.push(() => {
          try {
            disposeSeat?.();
            seat?.();
          } finally {
            disposeDefinition?.();
          }
        });
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (error) {
            console.warn("@derekluo/dsh-channels: chat row teardown failed", error);
          }
        }
      };
    }
    return {
      inject: ["slots"],
      apply(ctx) {
        let disposeRows;
        let disposeCard;
        const injection = ctx.inject(["uiConversation", "slots"], (scope) => {
          try {
            disposeRows = registerRows(scope, scope.uiConversation);
          } catch (error) {
            console.warn("@derekluo/dsh-channels: chat row not registered", error);
            disposeRows = () => {
            };
          }
        });
        const card = ctx.inject(["slots"], (scope) => {
          try {
            const disposer = scope.slots.inject("plugins.bundle.config", () => scope.slots.register({ name: "plugins.bundle.config", key: PKG }, createCard(translator(), React, h)));
            disposeCard = typeof disposer === "function" ? disposer : void 0;
          } catch (error) {
            console.warn("@derekluo/dsh-channels: status card not registered", error);
          }
        });
        return () => {
          try {
            disposeRows?.();
          } catch (error) {
            console.warn("@derekluo/dsh-channels: chat row teardown failed", error);
          }
          try {
            if (typeof disposeCard === "function") disposeCard();
          } finally {
            card?.dispose?.();
            injection?.dispose?.();
          }
        };
      }
    };
  }
  window.__ModuleLoader__.load({
    id: PKG,
    factory(require2) {
      return createClient(require2);
    }
  });
})();
