    // Session row tools for the discovery list: term highlighting, the preview card, content
    // search polling, the delete-source confirmation and the drop targets on the host sidebar's
    // workspaces. Fragment contract: no import/export; uses COLORS / STYLES / Icon / postJson /
    // showAppToast / useTranslate / errorText / fmtTime from earlier fragments and
    // highlightRanges / highlightTerms inlined from lib/highlight.mjs.

    // dataTransfer type of dragged session rows (JSON: [{ source, sourcePath, sessionId, cwd? }])
    const SESSION_DRAG_MIME = "application/x-dsh-chat-import-sessions";
    // host sidebar workspace rows: data-row-key="workspace:<id>" (class names are hashed by the
    // host build and change between releases; the row key is the stable hook)
    const WORKSPACE_ROW_SELECTOR = '[data-row-key^="workspace:"]';
    const WORKSPACE_KEY_PREFIX = "workspace:";

    const MARK_STYLE = {
      // warn (yellow) token: the brand token is grey in several themes and the mark disappears
      background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent)",
      color: "inherit", borderRadius: "2px", padding: "0 1px",
    };

    /** Text with every term wrapped in <mark> (plain string when nothing matches). */
    function Highlight({ text, terms }) {
      const str = typeof text === "string" ? text : "";
      const ranges = highlightRanges(str, terms);
      if (ranges.length === 0) return str;
      const parts = [];
      let at = 0;
      ranges.forEach(([s, e], i) => {
        if (s > at) parts.push(str.slice(at, s));
        parts.push(h("mark", { key: i, style: MARK_STYLE }, str.slice(s, e)));
        at = e;
      });
      if (at < str.length) parts.push(str.slice(at));
      return h(React.Fragment, null, ...parts);
    }

    // host Modal / Button (same require channel as file-import.js); null on an older host
    let ToolsModal = null;
    let ToolsButton = null;
    try {
      const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      ToolsModal = primitives && typeof primitives.Modal === "function" ? primitives.Modal : null;
      ToolsButton = primitives && typeof primitives.Button === "function" ? primitives.Button : null;
    } catch {
      ToolsModal = null;
      ToolsButton = null;
    }

    const TOOL_STYLES = {
      overlay: {
        position: "absolute", inset: 0, zIndex: 20, display: "flex", flexDirection: "column",
        background: COLORS.surface, color: COLORS.text, minHeight: 0,
      },
      head: { display: "flex", alignItems: "flex-start", gap: "8px", padding: "10px 12px", borderBottom: "1px solid " + COLORS.border },
      headMain: { flex: 1, minWidth: 0 },
      title: { fontSize: "14px", fontWeight: 600, lineHeight: "20px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      meta: { fontSize: "12px", color: COLORS.dim, lineHeight: "18px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px 12px" },
      msg: { padding: "8px 0", borderBottom: "1px solid " + COLORS.border },
      role: { fontSize: "11px", fontWeight: 600, letterSpacing: ".02em", textTransform: "uppercase", color: COLORS.dimmer, marginBottom: "2px" },
      text: { fontSize: "13px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
      tool: { fontSize: "12px", color: COLORS.dim, padding: "4px 0", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
      foot: { display: "flex", gap: "8px", padding: "10px 12px", borderTop: "1px solid " + COLORS.border, justifyContent: "flex-end", flexWrap: "wrap" },
      note: { padding: "16px 12px", color: COLORS.dim, fontSize: "13px" },
      rowIcon: {
        flex: "none", width: "22px", height: "22px", padding: 0, border: "none", borderRadius: "6px",
        background: "transparent", color: COLORS.dim, cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      },
      hits: { color: COLORS.accent, fontSize: "11px", lineHeight: "16px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
      dangerBtn: { ...STYLES.toolBtn, color: COLORS.error },
      dragHint: {
        position: "absolute", left: "12px", right: "12px", bottom: "64px", zIndex: 15, pointerEvents: "none",
        padding: "8px 10px", borderRadius: "8px", fontSize: "12px", textAlign: "center",
        background: COLORS.surface, color: COLORS.text, border: "1px dashed " + COLORS.accent,
        boxShadow: COLORS.elevation,
      },
    };

    /**
     * Preview card over the panel: the import dry-run's message sample with the search terms
     * highlighted; scrolls to the first hit. Esc / close returns to the list.
     */
    function SessionPreview({ session, terms, onClose, onImport, onHide, onDelete, busy }) {
      const t = useTranslate();
      const style = TOOL_STYLES;
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const bodyRef = useRef(null);
      useEffect(() => {
        let cancelled = false;
        setState({ loading: true, data: null, error: null });
        postJson("/api-import/preview", toItem(session))
          .then((r) => {
            if (cancelled) return;
            setState(r.ok ? { loading: false, data: r.data, error: null } : { loading: false, data: null, error: r.error || t("preview.error") });
          })
          .catch((err) => { if (!cancelled) setState({ loading: false, data: null, error: errorText(err) }); });
        return () => { cancelled = true; };
      }, [session]);
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);
      // jump to the first highlighted term once the sample is on screen
      useEffect(() => {
        if (!state.data || !bodyRef.current || terms.length === 0) return;
        const first = bodyRef.current.querySelector("mark");
        if (first && typeof first.scrollIntoView === "function") first.scrollIntoView({ block: "center" });
      }, [state.data, terms]);
      const data = state.data;
      const sample = data && data.sample;
      const meta = data
        ? [data.cwd, t("preview.counts", { turns: data.turns || 0, messages: data.messages || 0, tools: data.toolCalls || 0 })].filter(Boolean).join(" · ")
        : session.cwd || "";
      return h("div", { style: style.overlay, role: "dialog", "aria-modal": false, "aria-label": t("preview.title") },
        h("div", { style: style.head },
          h("div", { style: style.headMain },
            h("div", { style: style.title, title: session.title || "" }, h(Highlight, { text: (data && data.title) || session.title || t("noTitle"), terms })),
            h("div", { style: style.meta, title: meta }, meta)),
          h("button", {
            type: "button", style: STYLES.iconBtn, onClick: onClose, title: t("preview.close"), "aria-label": t("preview.close"),
          }, h(Icon, { name: "x" }))),
        h("div", { ref: bodyRef, style: style.body },
          state.loading && h("div", { style: style.note }, t("preview.loading")),
          state.error && h("div", { style: { ...style.note, color: COLORS.error } }, state.error),
          sample && sample.messages.length === 0 && h("div", { style: style.note }, t("preview.empty")),
          sample && sample.messages.map((m, i) => (m.role === "tool"
            ? h("div", { key: i, style: style.tool }, "⚙ ", m.text)
            : h("div", { key: i, style: style.msg },
              h("div", { style: style.role }, t(m.role === "user" ? "preview.role.user" : "preview.role.assistant"),
                m.time ? " · " + fmtTime(m.time) : ""),
              h("div", { style: style.text }, h(Highlight, { text: m.text, terms }))))),
          sample && sample.truncated && h("div", { style: style.note }, t("preview.truncated", { n: sample.messages.length, total: sample.total }))),
        h("div", { style: style.foot },
          h("button", { type: "button", style: STYLES.toolBtn, disabled: busy, onClick: () => onHide(session) },
            t("row.hide")),
          h("button", { type: "button", style: style.dangerBtn, disabled: busy, onClick: () => onDelete([session]) },
            t("row.delete")),
          h("button", { type: "button", style: STYLES.importBtn, disabled: busy, onClick: () => onImport(session) },
            t("import.one"))));
    }

    /**
     * Content search over one list (the scan identified by source / query / epoch). Polls
     * /api-import/search until done; hits = Map(itemKey → { count, snippets }).
     */
    function useContentSearch({ text, source, query, epoch, ready, t }) {
      const [state, setState] = useState({ hits: null, scanned: 0, total: 0, done: false, error: null });
      useEffect(() => {
        if (!text || !ready) {
          setState({ hits: null, scanned: 0, total: 0, done: false, error: null });
          return undefined;
        }
        let cancelled = false;
        (async () => {
          setState({ hits: new Map(), scanned: 0, total: 0, done: false, error: null });
          for (;;) {
            let r;
            try {
              r = await postJson("/api-import/search", { source, query, epoch, text });
            } catch (err) {
              if (!cancelled) setState((s) => ({ ...s, done: true, error: t("error.request", { msg: errorText(err) }) }));
              return;
            }
            if (cancelled) return;
            if (!r.ok) {
              setState((s) => ({ ...s, done: true, error: r.error || t("search.content.error") }));
              return;
            }
            const d = r.data;
            const hits = new Map();
            for (const hit of d.hits || []) hits.set(itemKey(hit), hit);
            setState({ hits, scanned: d.scanned || 0, total: d.total || 0, done: d.done === true, error: d.error || null });
            if (d.done) return;
            await sleep(400);
          }
        })();
        return () => { cancelled = true; };
      }, [text, source, query, epoch, ready]);
      return state;
    }

    /** Confirmation before sending source files to the Recycle Bin (host Modal when available). */
    function DeleteSourceDialog({ sessions, busy, onCancel, onConfirm }) {
      const t = useTranslate();
      const body = h("div", null,
        h("p", { style: { margin: "0 0 8px" } }, t("delete.ask", { n: sessions.length })),
        h("ul", { style: { margin: 0, paddingLeft: "18px", maxHeight: "160px", overflowY: "auto", fontSize: "12px", color: COLORS.dim } },
          sessions.slice(0, 20).map((s) => h("li", { key: itemKey(s), style: { wordBreak: "break-all" } }, s.title || s.sourcePath)),
          sessions.length > 20 ? h("li", null, "…") : null),
        h("p", { style: { margin: "8px 0 0", fontSize: "12px", color: COLORS.dim } }, t("delete.note")));
      if (ToolsModal && ToolsButton) {
        return h(ToolsModal, {
          open: true, onClose: onCancel, title: t("delete.title"), closeLabel: t("delete.cancel"),
          children: body,
          footer: h(React.Fragment, null,
            h(ToolsButton, { variant: "outline", disabled: busy, onClick: onCancel }, t("delete.cancel")),
            h(ToolsButton, { variant: "primary", disabled: busy, autoFocus: true, onClick: onConfirm }, t("delete.confirm"))),
        });
      }
      return h("div", { role: "dialog", "aria-modal": true, "aria-label": t("delete.title"), style: { ...TOOL_STYLES.overlay, zIndex: 30, background: "rgba(0,0,0,.35)", alignItems: "center", justifyContent: "center" } },
        h("div", { style: { background: COLORS.surface, border: "1px solid " + COLORS.border, borderRadius: "12px", padding: "16px", width: "min(420px, 92%)", boxShadow: COLORS.elevation } },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, t("delete.title")),
          body,
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "12px" } },
            h("button", { type: "button", style: STYLES.toolBtn, disabled: busy, onClick: onCancel }, t("delete.cancel")),
            h("button", { type: "button", style: TOOL_STYLES.dangerBtn, disabled: busy, autoFocus: true, onClick: onConfirm }, t("delete.confirm")))));
    }

    /**
     * Drop targets on the host sidebar's workspace rows while session rows are dragged. Listens
     * on document in the capture phase and only reacts to SESSION_DRAG_MIME, so the host's own
     * session / workspace drag-and-drop is untouched. onDrop(items, { id, name }).
     */
    function useSidebarWorkspaceDrop(onDrop) {
      const dropRef = useRef(onDrop);
      dropRef.current = onDrop;
      useEffect(() => {
        let lit = null;
        let litOutline = "";
        const ours = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], SESSION_DRAG_MIME) !== -1);
        const rowOf = (e) => (e.target && typeof e.target.closest === "function" ? e.target.closest(WORKSPACE_ROW_SELECTOR) : null);
        const unlight = () => {
          if (lit) { lit.style.outline = litOutline; lit = null; }
        };
        const light = (row) => {
          if (row === lit) return;
          unlight();
          lit = row;
          litOutline = row.style.outline;
          row.style.outline = "2px solid " + COLORS.accent;
          row.style.outlineOffset = "-2px";
        };
        const onOver = (e) => {
          if (!ours(e)) return;
          const row = rowOf(e);
          if (!row) { unlight(); return; }
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          light(row);
        };
        const onDropEvt = (e) => {
          if (!ours(e)) return;
          const row = rowOf(e);
          unlight();
          if (!row) return;
          e.preventDefault();
          e.stopPropagation();
          let items = [];
          try {
            items = JSON.parse(e.dataTransfer.getData(SESSION_DRAG_MIME) || "[]");
          } catch {
            items = [];
          }
          const key = row.getAttribute("data-row-key") || "";
          const id = key.slice(WORKSPACE_KEY_PREFIX.length);
          const name = (row.textContent || "").trim();
          if (id && Array.isArray(items) && items.length > 0) dropRef.current(items, { id, name });
        };
        const onEnd = () => unlight();
        document.addEventListener("dragenter", onOver, true);
        document.addEventListener("dragover", onOver, true);
        document.addEventListener("drop", onDropEvt, true);
        document.addEventListener("dragend", onEnd, true);
        return () => {
          unlight();
          document.removeEventListener("dragenter", onOver, true);
          document.removeEventListener("dragover", onOver, true);
          document.removeEventListener("drop", onDropEvt, true);
          document.removeEventListener("dragend", onEnd, true);
        };
      }, []);
    }

    /** Hit count + first snippet → row tooltip lines. */
    function hitTip(hit, t) {
      if (!hit) return "";
      const lines = [t("search.content.hits", { n: hit.count })];
      for (const s of hit.snippets || []) lines.push((s.role === "user" ? "› " : "‹ ") + s.text);
      return "\n" + lines.join("\n");
    }
