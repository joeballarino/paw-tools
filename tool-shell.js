/* tool-shell.js
 * Shared UI + API contract for ALL PAW tools
 *
 * Contract sent to worker:
 * {
 *   tool: "tool_id" | "" (omit for generic assistant),
 *   message: "user text only",
 *   history: [{ role:"user"|"assistant", content:"..." }, ...],
 *   prefs: { ... },              // tool-specific
 *   ...extraPayload              // optional, tool-specific (merged at top-level)
 * }
 */

(function () {
  // ==========================================================
  // EMBED MODE (LOCKED)
  // ----------------------------------------------------------
  // When this tool is rendered inside another page (iframe),
  // we must disable the outer shell styling (app/frame/panel)
  // to avoid "containers inside containers".
  //
  // Triggers embed mode when:
  // - URL includes ?embed=1
  // - Page is inside an iframe (or cross-origin iframe)
  // ==========================================================
  (function setEmbedMode() {
    try {
      const p = new URLSearchParams(location.search);
      if (p.get("embed") === "1") {
        document.documentElement.dataset.embed = "1";
        return;
      }
    } catch {}

    try {
      if (window.self !== window.top) {
        document.documentElement.dataset.embed = "1";
      }
    } catch {
      // Cross-origin iframe access throws; assume embedded
      document.documentElement.dataset.embed = "1";
    }
  })();

  const _instances = Object.create(null);

  function clampStr(s, max) {
    s = String(s || "");
    return s.length > max ? s.slice(0, max) : s;
  }

  function qs(sel) { return document.querySelector(sel); }
  function el(tag, cls) { const d = document.createElement(tag); if (cls) d.className = cls; return d; }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function nowMs() { return (typeof performance !== "undefined" ? performance.now() : Date.now()); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function defaultKey(toolId) {
    return "paw_history_" + (toolId ? toolId : "assistant");
  }

  function loadHistory(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveHistory(key, history, maxItems) {
    try {
      const trimmed = Array.isArray(history) ? history.slice(-maxItems) : [];
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {}
  }

  function normalizeText(t) {
    return String(t || "").replace(/\r\n/g, "\n");
  }

  function pushHistory(history, role, content, maxItems) {
    history.push({ role, content: String(content || "") });
    if (history.length > maxItems) history.splice(0, history.length - maxItems);
  }

  function renderHistory($messages, history, addMsg) {
    for (const h of (history || [])) {
      if (!h || !h.role) continue;
      addMsg(h.role === "user" ? "user" : "bot", h.content, { behavior: "auto" });
    }
  }

  function addThinking($messages) {
    const msg = el("div", "msg assistant");
    msg.innerHTML = '<div class="bubble"><p>Thinking…</p></div>';
    $messages.appendChild(msg);
    try { $messages.scrollTo({ top: $messages.scrollHeight, behavior: "auto" }); } catch {}
    return msg;
  }

  function addMsgFactory($messages) {
    return function addMsg(who, text, opts = {}) {
      const msg = el("div", "msg " + (who === "user" ? "user" : "assistant"));
      const bubble = el("div", "bubble");
      const p = el("p");
      p.textContent = String(text || "");
      bubble.appendChild(p);
      msg.appendChild(bubble);
      $messages.appendChild(msg);
      try { $messages.scrollTo({ top: $messages.scrollHeight, behavior: opts.behavior || "smooth" }); } catch {}
    };
  }

  // ─────────────────────────────────────────────
  // Deliverable output (copy-first result card)
  // ─────────────────────────────────────────────

  function defaultIsDeliverableReply(reply, ctx) {
    const r = String(reply || "").trim();
    if (!r) return false;

    // Only for tools (not the generic assistant route)
    if (!ctx || !ctx.toolId) return false;

    // Never elevate errors or follow-up questions
    if (/^Error reaching the assistant\b/i.test(r)) return false;
    if (/^Upstream error\b/i.test(r)) return false;

    // Common “need more info” openers
    if (/^(one|a couple|a few)\s+quick\s+(question|questions|clarifiers)\b/i.test(r)) return false;
    if (/^(to write|before i write|to draft|to generate)\b/i.test(r)) return false;
    if (/\b(i need|i'll need|need a few|need some|please provide|please share)\b/i.test(r)) return false;

    // If it contains a direct question prompt, do not elevate.
    if (/[?]\s*$/.test(r)) return false;
    if (/\b(what|which|when|where|who|why|how)\b[^.\n]{0,120}\?/i.test(r)) return false;
    if (/\b(can you|could you|would you|do you|are you)\b[^.\n]{0,120}\?/i.test(r)) return false;

    // Any question marks at all usually means it’s not final copy.
    const qMarks = (r.match(/\?/g) || []).length;
    if (qMarks >= 1) return false;

    // Typical deliverables are longer than short chat replies
    return r.length >= 240;
  }

  function makeDeliverableUI($messages) {
    const wrap = el("div", "deliverable");
    wrap.style.display = "none";

    const card = el("div", "deliverable-card");

    const head = el("div", "deliverable-head");
    const title = el("div", "deliverable-title");
    title.textContent = "Your MLS Description";

    const actions = el("div", "deliverable-actions");

    const copyBtn = el("button", "btn primary");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";

    const refineBtn = el("button", "btn");
    refineBtn.type = "button";
    refineBtn.textContent = "Refine";

    actions.appendChild(copyBtn);
    actions.appendChild(refineBtn);

    head.appendChild(title);
    head.appendChild(actions);

    const body = el("div", "deliverable-body");
    const text = el("pre", "deliverable-text");
    text.setAttribute("tabindex", "0");
    body.appendChild(text);

    card.appendChild(head);
    card.appendChild(body);

    wrap.appendChild(card);

    $messages.parentNode.insertBefore(wrap, $messages);

    async function copyToClipboard(v) {
      const t = String(v || "");
      if (!t) return false;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(t); return true; } catch {}
      }

      try {
        const ta = el("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return !!ok;
      } catch {
        return false;
      }
    }

    function ensureToast(){
      let t = qs("#pawToast");
      if (t) return t;
      t = el("div", "toast");
      t.id = "pawToast";
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      document.body.appendChild(t);
      return t;
    }
    function showToast(msg){
      const t = ensureToast();
      t.textContent = String(msg || "");
      t.classList.add("show");
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => t.classList.remove("show"), 950);
    }

    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(text.textContent);
      if (ok) showToast("Copied to clipboard");
    });

    refineBtn.addEventListener("click", () => {
      const input = qs("#input");
      if (!input) return;
      input.focus();
      const starter = "Revise the MLS description above: ";
      if (!String(input.value || "").trim()) {
        input.value = starter;
        try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
      }
      try { input.dispatchEvent(new Event("input")); } catch {}
    });

    return { wrap, text };
  }

  function buildPayload(cfg, message, history, extraPayload) {
    const prefs = cfg.getPrefs ? cfg.getPrefs() : {};
    const tool = String(cfg.toolId || "").trim();

    const payload = {
      tool: tool || "",
      message: String(message || ""),
      history: Array.isArray(history) ? history : [],
      prefs: prefs || {},

      // Compatibility fields
      tool_id: tool || "",
      text: String(message || "")
    };

    const extra = (extraPayload && typeof extraPayload === "object") ? extraPayload : {};
    for (const k of Object.keys(extra)) {
      if (k === "tool" || k === "tool_id" || k === "message" || k === "text" || k === "prefs" || k === "history") continue;
      payload[k] = extra[k];
    }

    return payload;
  }

  // ─────────────────────────────────────────────
  // Tips modal (shared)
  // ─────────────────────────────────────────────
  function ensureTipsModal() {
    let modal = qs("#pawTipsModal");
    if (modal) return modal;

    modal = el("div", "modal");
    modal.id = "pawTipsModal";
    modal.setAttribute("aria-hidden", "true");

    const card = el("div", "modal-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "pawTipsTitle");

    const head = el("div", "modal-head");
    const title = el("div", "modal-title");
    title.id = "pawTipsTitle";
    title.textContent = "Tips & How To";

    const close = el("button", "modal-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";

    head.appendChild(title);
    head.appendChild(close);

    const body = el("div", "modal-body");
    body.id = "pawTipsBody";

    card.appendChild(head);
    card.appendChild(body);
    modal.appendChild(card);
    document.body.appendChild(modal);

    function closeModal(){
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }

    close.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    return modal;
  }

  function renderTipsHTML(tipsText) {
    const raw = String(tipsText || "").trim();
    if (!raw) return "<p style=\"margin:0;\">No tips available.</p>";

    // Supports both:
    // - multi-line text
    // - single-line bullets separated by "•"
    let parts = [];
    if (raw.includes("•")) {
      parts = raw.split("•").map(s => s.trim()).filter(Boolean);
    } else {
      parts = raw.split("\n").map(s => s.trim()).filter(Boolean);
    }

    let html = "<ul style=\"margin:0; padding-left:18px;\">";
    for (const p of parts) {
      html += "<li style=\"margin:6px 0;\">" + escapeHtml(p) + "</li>";
    }
    html += "</ul>";
    return html;
  }

  function init(config) {
    const cfg = Object.assign({
      apiEndpoint: "",
      toolId: "",
      historyKey: null,
      maxHistoryItems: 16,
      sendHistoryItems: 8,
      minThinkMs: 500,
      maxMessageChars: 8000,

      // Deliverable behavior
      deliverableTitle: "",
      deliverableAckText: "",      // no longer used (kept for compatibility)
      isDeliverableReply: defaultIsDeliverableReply,

      inputPlaceholder: "",
      tipsText: "",
      enableDisclaimer: false,
      disclaimerTrigger: null,
      getDisclaimerText: null,
      getPrefs: null,
      getExtraPayload: null,
      onResponse: null,
    }, config || {});

    const key = cfg.historyKey || defaultKey(cfg.toolId);
    const history = loadHistory(key);

    const $messages = qs("#messages");
    const $input = qs("#input");
    const $send = qs("#send");
    const $tips = qs("#tips");

    if (!$messages || !$input || !$send || !$tips) {
      console.log("PAW shell: missing required DOM nodes.");
      return;
    }

    if (cfg.inputPlaceholder) $input.placeholder = cfg.inputPlaceholder;

    function autoGrow() {
      $input.style.height = "auto";
      $input.style.height = Math.min($input.scrollHeight, 520) + "px";
    }
    $input.addEventListener("input", autoGrow);
    autoGrow();

    const addMsg = addMsgFactory($messages);

    // Deliverable UI
    const deliverable = makeDeliverableUI($messages);
    if (cfg.deliverableTitle) {
      deliverable.wrap.querySelector(".deliverable-title").textContent = String(cfg.deliverableTitle);
    }

    function showDeliverable(text) {
      deliverable.text.textContent = String(text || "").trim();
      deliverable.wrap.style.display = "block";
      try { deliverable.wrap.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {}
    }

    function clearDeliverable() {
      deliverable.text.textContent = "";
      deliverable.wrap.style.display = "none";
    }

    function push(role, content) {
      pushHistory(history, role, content, cfg.maxHistoryItems);
      saveHistory(key, history, cfg.maxHistoryItems);
    }

    function reset() {
      history.length = 0;
      saveHistory(key, history, cfg.maxHistoryItems);
      clearDeliverable();
      try { $messages.innerHTML = ""; } catch {}
      autoGrow($input);
      try { $messages.scrollTo({ top: 0, behavior: "auto" }); } catch {}
    }

    // Tips: modal, not chat
    if (cfg.tipsText) {
      const tipsModal = ensureTipsModal();
      $tips.addEventListener("click", () => {
        const body = qs("#pawTipsBody");
        if (body) body.innerHTML = renderTipsHTML(cfg.tipsText);
        tipsModal.classList.add("show");
        tipsModal.setAttribute("aria-hidden", "false");
      });
    }

    // Restore prior history
    if (history.length) renderHistory($messages, history, addMsg);

    $send.addEventListener("click", () => { sendFromInput(); });
    $input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendFromInput();
      }
    });

    function sendFromInput() {
      const raw = String($input.value || "");
      if (!raw.trim()) return;
      $input.value = "";
      autoGrow();
      sendMessage(raw);
    }

    async function sendMessage(text, extraPayload = {}, options = {}) {
      const opts = Object.assign({
        echoUser: true,
        behavior: "auto",
      }, options || {});

      const safeText = clampStr(normalizeText(text).trim(), cfg.maxMessageChars);
      if (!safeText) return;

      if (opts.echoUser) {
        addMsg("user", safeText, { behavior: opts.behavior });
        push("user", safeText);
      }

      const thinking = addThinking($messages);
      const t0 = nowMs();

      const ctx = { toolId: cfg.toolId, prefs: (cfg.getPrefs ? cfg.getPrefs() : {}) };

      const extra = (cfg.getExtraPayload ? (cfg.getExtraPayload(safeText, ctx) || {}) : (extraPayload || {}));
      const outboundHistory = history.slice(-cfg.sendHistoryItems);

      const payload = buildPayload(cfg, safeText, outboundHistory, extra);

      let res;
      let data = null;
      let reply = "";

      try {
        res = await fetch(cfg.apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        data = await res.json().catch(() => null);
        reply = (data && typeof data.reply === "string") ? data.reply : "";
      } catch {
        reply = "Error reaching the assistant. Please try again.";
      }

      const dt = nowMs() - t0;
      if (dt < cfg.minThinkMs) await sleep(cfg.minThinkMs - dt);

      thinking.remove();

      // Allow tool pages to intercept/handle responses
      let skipDefault = false;
      if (typeof cfg.onResponse === "function") {
        try {
          const r = cfg.onResponse(data, Object.assign({}, ctx, { lastUserText: safeText })) || {};
          if (r && r.skipDefault === true) skipDefault = true;
        } catch {}
      }

      if (!skipDefault) {
        const useDeliverable = (cfg.isDeliverableReply || defaultIsDeliverableReply)(reply, ctx);

        if (useDeliverable) {
          showDeliverable(reply);
          // IMPORTANT: no extra “Done — …” chat bubble (prevents box-in-box + confusion)
          push("assistant", String(reply || "").trim());
        } else {
          addMsg("bot", reply, { behavior: "smooth" });
          push("assistant", String(reply || "").trim());
        }
      }
    }

    const instance = {
      reset,
      send: (text) => sendMessage(text),
      sendExtra: (text, extra, options) => sendMessage(text, extra || {}, options || {}),
      clearDeliverable,
    };

    _instances[cfg.toolId || "assistant"] = instance;
    return instance;
  }

  window.PAWToolShell = { init };
})();
