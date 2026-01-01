// tool-shell.js
(function () {
  "use strict";

  // ─────────────────────────────────────────────
  // Shared Tool Shell (messages + composer + API)
  // ─────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function el(tag, className) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    return n;
  }

  // ─────────────────────────────────────────────
  // Toast (non-blocking confirmations)
  // ─────────────────────────────────────────────
  let $toast = null;
  function ensureToast(){
    if ($toast) return $toast;
    $toast = el("div", "toast");
    $toast.setAttribute("role", "status");
    $toast.setAttribute("aria-live", "polite");
    document.body.appendChild($toast);
    return $toast;
  }
  function showToast(msg){
    try {
      const t = ensureToast();
      t.textContent = String(msg || "");
      t.classList.add("show");
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => t.classList.remove("show"), 950);
    } catch {}
  }

  function scrollToBottom(behavior) {
    try {
      const m = $("messages");
      m.scrollIntoView({ block: "end", behavior: behavior || "smooth" });
    } catch {}
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function nowMs() { return Date.now(); }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function normalizeText(t) { return String(t || "").replace(/\r\n/g, "\n"); }

  function trimHistory(history, maxItems) {
    if (!Array.isArray(history)) return [];
    const h = history.filter(Boolean);
    if (h.length <= maxItems) return h;
    return h.slice(h.length - maxItems);
  }

  function toHistoryItem(role, content) {
    return { role: role, content: String(content || "") };
  }

  function buildPayload(cfg, text, extra, history) {
    const prefs = cfg.getPrefs ? cfg.getPrefs() : {};
    return {
      tool_id: cfg.toolId || "",
      text: String(text || ""),
      prefs: prefs || {},
      extra: extra || {},
      history: history || []
    };
  }

  function renderMessage(role, content) {
    const $messages = $("messages");
    const msg = el("div", "msg " + (role === "user" ? "user" : "assistant"));
    const bubble = el("div", "bubble");
    const p = el("p");
    p.textContent = String(content || "");
    bubble.appendChild(p);
    msg.appendChild(bubble);
    $messages.appendChild(msg);
    scrollToBottom("smooth");
    return msg;
  }

  function renderThinking() {
    const $messages = $("messages");
    const thinking = el("div", "msg assistant");
    thinking.innerHTML =
      '<div class="bubble"><p>Thinking…</p></div>';
    $messages.appendChild(thinking);
    scrollToBottom("auto");
    return thinking;
  }

  // ─────────────────────────────────────────────
  // Deliverable output (copy-first result card)
  // ─────────────────────────────────────────────

  function defaultIsDeliverableReply(reply, ctx) {
    const r = String(reply || "").trim();
    if (!r) return false;

    // Only for tools (not the generic assistant route)
    if (!ctx || !ctx.toolId) return false;

    // Never treat errors or quick-followups as deliverables
    if (/^Error reaching the assistant\b/i.test(r)) return false;
    if (/^Upstream error\b/i.test(r)) return false;
    if (/^One quick question\b/i.test(r)) return false;

    return true;
  }

  function createDeliverableCard($messages) {
    // Inject a result section right above the message thread
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

    // Place it before the messages container
    $messages.parentNode.insertBefore(wrap, $messages);

    return { wrap, text, copyBtn, refineBtn };
  }

  async function copyToClipboard(text) {
    const t = String(text || "");
    if (!t) return false;

    // Modern API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(t);
        return true;
      } catch {}
    }

    // Fallback
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

  function autoGrow(textarea) {
    try {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 520) + "px";
    } catch {}
  }

  function init(config) {
    const cfg = Object.assign({
      apiEndpoint: "",
      toolId: "",                 // "" => generic assistant route
      minThinkMs: 550,
      maxHistoryItems: 16,
      sendHistoryItems: 8,
      maxMessageChars: 8000,
      deliverableMode: true,       // tools: elevate final output into a copy-first card
      deliverableTitle: "Your MLS Description",
      deliverableAckText: "Done — your MLS description is ready above.",
      isDeliverableReply: defaultIsDeliverableReply,
      getPrefs: null,
      getExtraPayload: null,
      onResponse: null,
      tipsText: "",
      inputPlaceholder: ""
    }, config || {});

    const $messages = $("messages");
    const $input = $("input");
    const $send = $("send");

    // Apply placeholder if provided
    if (cfg.inputPlaceholder) {
      try { $input.placeholder = cfg.inputPlaceholder; } catch {}
    }

    // Deliverable card (inserted above messages)
    const deliverable = cfg.deliverableMode ? createDeliverableCard($messages) : null;
    if (deliverable) {
      deliverable.text.textContent = "";
      deliverable.wrap.style.display = "none";
    }

    if (deliverable) {
      deliverable.copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(deliverable.text.textContent);
      if (!ok) return;
      showToast("Copied to clipboard");
    });

    deliverable.refineBtn.addEventListener("click", () => {
      // Make revisions obvious: jump user into the composer with a starter instruction.
      try {
        $input.focus();
        const starter = "Revise the MLS description above: ";
        if (!String($input.value || "").trim()) {
          $input.value = starter;
          $input.setSelectionRange($input.value.length, $input.value.length);
          autoGrow($input);
        }
        scrollToBottom("smooth");
      } catch {}
    });
    }

    // Simple in-memory chat history for context
    let history = [];

    async function send(text, extra, opts) {
      const userText = normalizeText(text).trim();
      if (!userText) return;

      // echo user message unless suppressed
      if (!opts || opts.echoUser !== false) {
        renderMessage("user", userText);
      }

      // record to history
      history.push(toHistoryItem("user", userText));
      history = trimHistory(history, cfg.maxHistoryItems);

      // show thinking
      const thinking = renderThinking();
      const start = nowMs();

      // build payload with limited history window for request
      const historyToSend = trimHistory(history, cfg.sendHistoryItems);
      const extraPayload = cfg.getExtraPayload ? (cfg.getExtraPayload(userText, { prefs: cfg.getPrefs ? cfg.getPrefs() : {}, toolId: cfg.toolId }) || {}) : (extra || {});
      const payload = buildPayload(cfg, userText, extraPayload, historyToSend);

      let replyText = "";
      let json = null;

      try {
        const res = await fetch(cfg.apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const raw = await res.text();
        json = safeJsonParse(raw);

        if (json && typeof json.reply === "string") {
          replyText = json.reply;
        } else if (typeof raw === "string" && raw.trim()) {
          // some workers might return plain text
          replyText = raw;
        } else {
          replyText = "Error reaching the assistant. Please try again.";
        }
      } catch (e) {
        replyText = "Error reaching the assistant. Please try again.";
      }

      // enforce minimum think time for smoother UX
      const elapsed = nowMs() - start;
      const wait = clamp(cfg.minThinkMs - elapsed, 0, cfg.minThinkMs);
      if (wait) await new Promise(r => setTimeout(r, wait));

      // remove thinking
      try { thinking.remove(); } catch {}

      const ctx = { prefs: cfg.getPrefs ? cfg.getPrefs() : {}, toolId: cfg.toolId };

      // Deliverable mode: elevate final result into a card
      if (deliverable && cfg.isDeliverableReply(replyText, ctx)) {
        deliverable.text.textContent = String(replyText || "").trim();
        deliverable.wrap.style.display = "block";
        renderMessage("assistant", cfg.deliverableAckText);
      } else {
        renderMessage("assistant", replyText);
      }

      // record assistant reply to history
      history.push(toHistoryItem("assistant", replyText));
      history = trimHistory(history, cfg.maxHistoryItems);

      // allow tool page to react to JSON payloads (e.g., local highlights)
      if (cfg.onResponse) {
        try { cfg.onResponse(json, ctx); } catch {}
      }
    }

    function onSend() {
      const text = $input.value || "";
      if (!String(text).trim()) return;
      $input.value = "";
      autoGrow($input);
      send(text, null, null);
    }

    $send.addEventListener("click", onSend);
    $input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });

    $input.addEventListener("input", () => autoGrow($input));
    autoGrow($input);

    // Exposed helpers for tool pages
    return {
      send: (text) => send(text, null, null),
      sendExtra: (text, extra, opts) => send(text, extra, opts || {}),
      reset: () => {
        history = [];
        if (deliverable) {
          deliverable.text.textContent = "";
          deliverable.wrap.style.display = "none";
        }
        try { $messages.innerHTML = ""; } catch {}
      }
    };
  }

  // Expose
  window.PAWToolShell = { init: init };
})();
