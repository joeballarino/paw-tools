/* tool-shell.js
 * Shared UI + API contract for ALL PAW tools
 *
 * Contract sent to worker:
 * {
 *   tool: "tool_id" | "" (omit for generic assistant),
 *   message: "user text only",
 *   history: [{ role:"user"|"assistant", content:"..." }, ...],
 *   prefs: { ... },              // tool-specific
 *   ...extraPayload              // optional, tool-specific
 * }
 */

(function () {
  const _instances = Object.create(null);

  function clampStr(s, max) {
    s = String(s || "");
    return s.length > max ? s.slice(0, max) : s;
  }

  function qs(sel) { return document.querySelector(sel); }
  function el(tag, cls) { const d = document.createElement(tag); if (cls) d.className = cls; return d; }

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

  function saveHistory(key, history) {
    try { localStorage.setItem(key, JSON.stringify(history)); } catch {}
  }

  function clearHistory(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  function renderHistory($messages, history, addMsgFn) {
    $messages.innerHTML = "";
    for (const h of history) addMsgFn(h.role === "user" ? "you" : "bot", h.content, { scroll: false });
    $messages.scrollTo({ top: $messages.scrollHeight, behavior: "auto" });
  }

  function makeAddMsg($messages, scrollToBottom, opts = {}) {
    const showDisclaimer = !!opts.showDisclaimer;
    const getDisclaimerText = opts.getDisclaimerText || (() => "");

    return function addMsg(who, text, addOpts = {}) {
      const row = el("div", "msg " + (who === "you" ? "you" : "bot"));

      const bubble = el("div", "bubble");
      bubble.textContent = String(text || "");

      if (addOpts.disclaimer && showDisclaimer) {
        const d = el("div", "disclaimer");
        d.textContent = getDisclaimerText();
        bubble.appendChild(d);
      }

      row.appendChild(bubble);
      $messages.appendChild(row);

      if (addOpts.scroll !== false) scrollToBottom(addOpts.behavior || "smooth");
      return row;
    };
  }

  function makeThinkingRow($messages, scrollToBottom) {
    const thinking = el("div", "msg bot");
    thinking.innerHTML =
      '<div class="bubble">' +
        '<span class="thinking">Thinking<span class="dots"><span></span><span></span><span></span></span></span>' +
      "</div>";
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
    if (/^Quick questions\b/i.test(r)) return false;
    if (/^A couple quick questions\b/i.test(r)) return false;
    if (/^A few quick clarifiers\b/i.test(r)) return false;

    // If it's clearly a question-only reply, don't elevate it
    const qMarks = (r.match(/\?/g) || []).length;
    if (qMarks >= 2 && r.length < 420) return false;

    // Typical deliverables are longer than short chat replies
    return r.length >= 180;
  }

  function makeDeliverableUI($messages) {
    // Insert a result section right above the message thread
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

    const copied = el("div", "deliverable-copied");
    copied.textContent = "Copied";

    actions.appendChild(copyBtn);
    actions.appendChild(copied);

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

    return { wrap, text, copyBtn, copied };
  }

  async function copyToClipboard(text) {
    const t = String(text || "");
    if (!t) return false;

    // Modern clipboard API
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
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
      isDeliverableReply: null,    // optional (reply, ctx) => boolean
      storageKey: "",
      embedOnly: false,
      inputPlaceholder: "",
      tipsText: "",
      enableDisclaimer: false,
      disclaimerTrigger: null,
      getDisclaimerText: null,
      getPrefs: null,
      getExtraPayload: null,
      onResponse: null,
    }, config || {});

    const $messages = qs("#messages");
    const $input = qs("#input");
    const $send = qs("#send");
    const $tips = qs("#tips");

    if (!$messages || !$input || !$send || !$tips) {
      console.log("PAW shell: missing required DOM nodes.");
      return;
    }

    // Deliverable UI (copy-first result card)
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

    deliverable.copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(deliverable.text.textContent);
      if (!ok) return;
      deliverable.copied.classList.add("show");
      setTimeout(() => deliverable.copied.classList.remove("show"), 900);
    });

    if (cfg.embedOnly) {
      const p = new URLSearchParams(location.search);
      if (p.get("embed") !== "1") {
        location.replace(location.pathname + "?embed=1");
        return;
      }
      try { document.documentElement.dataset.embed = "1"; } catch {}
    }

    if (cfg.inputPlaceholder) $input.placeholder = cfg.inputPlaceholder;

    const key = cfg.storageKey || defaultKey(cfg.toolId);
    let history = loadHistory(key).filter(h => h && typeof h === "object" && h.content);

    function pushHistory(role, content) {
      history.push({ role, content });
      if (history.length > cfg.maxHistoryItems) history = history.slice(-cfg.maxHistoryItems);
      saveHistory(key, history);
    }

    function scrollToBottom(behavior = "smooth") {
      try { $messages.scrollTo({ top: $messages.scrollHeight, behavior }); } catch {}
    }

    const addMsg = makeAddMsg($messages, scrollToBottom, {
      showDisclaimer: cfg.enableDisclaimer,
      getDisclaimerText: (typeof cfg.getDisclaimerText === "function") ? cfg.getDisclaimerText : (() => "")
    });

    // If user clicks send with empty input, show Tips.
    let lastEmptySendAt = 0;
    function maybeShowTipsFromEmptySend() {
      const tips = String(cfg.tipsText || "").trim();
      if (!tips) return false;

      const t = Date.now();
      // Prevent rapid-fire duplicate tips spam if they keep clicking quickly
      if (t - lastEmptySendAt < 1200) return true;
      lastEmptySendAt = t;

      addMsg("bot", tips, { behavior: "smooth" });
      pushHistory("assistant", tips);
      return true;
    }

    const sendCountKey = "paw_send_count_" + (cfg.toolId || "assistant");
    function getSendCount() { try { return Number(localStorage.getItem(sendCountKey) || "0"); } catch { return 0; } }
    function incSendCount() {
      try {
        const next = getSendCount() + 1;
        localStorage.setItem(sendCountKey, String(next));
        return next;
      } catch {
        return 1;
      }
    }

    let disclaimerShown = false;

    function resetUI() {
      history = [];
      clearHistory(key);
      $messages.innerHTML = "";
      clearDeliverable();
      $input.value = "";
      disclaimerShown = false;
      autoGrow($input);
      try { $messages.scrollTo({ top: 0, behavior: "auto" }); } catch {}
    }

    if (history.length) renderHistory($messages, history, addMsg);

    if (cfg.tipsText) {
      $tips.addEventListener("click", () => {
        addMsg("bot", cfg.tipsText, { behavior: "smooth" });
        pushHistory("assistant", String(cfg.tipsText || "").trim());
      });
    }

    $send.addEventListener("click", () => { sendFromInput(); });

    async function sendMessage(text, extraPayload = {}, options = {}) {
      const opts = Object.assign({
        echoUser: true,      // show/persist user bubble
        behavior: "auto",
      }, options || {});

      const safeText = clampStr(String(text || "").trim(), cfg.maxMessageChars);
      if (!safeText) return;

      if (opts.echoUser) {
        addMsg("you", safeText, { behavior: "auto" });
        pushHistory("user", safeText);
      }

      $send.disabled = true;

      const thinking = makeThinkingRow($messages, scrollToBottom);

      try {
        const sendCount = incSendCount();

        const prefs = (typeof cfg.getPrefs === "function") ? (cfg.getPrefs() || {}) : {};

        const ctx = { prefs, history: history.slice(-cfg.sendHistoryItems), sendCount };

        const extra = (typeof cfg.getExtraPayload === "function")
          ? (cfg.getExtraPayload(safeText, ctx) || {})
          : (extraPayload || {});

        const payload = Object.assign({
          tool: cfg.toolId || "",
          message: safeText,
          history: ctx.history,
          prefs: prefs,
        }, extra || {});

        const t0 = nowMs();

        const res = await fetch(cfg.apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => null);

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
          const reply = (data && data.reply) ? String(data.reply) : "Error reaching the assistant. Please try again.";

          let attachDisclaimer = false;
          if (cfg.enableDisclaimer && !disclaimerShown && cfg.disclaimerTrigger instanceof RegExp) {
            attachDisclaimer = cfg.disclaimerTrigger.test(safeText + " " + reply);
            if (attachDisclaimer) disclaimerShown = true;
          }

          const detector = (typeof cfg.isDeliverableReply === "function") ? cfg.isDeliverableReply : defaultIsDeliverableReply;
          const isDeliverable = !!cfg.deliverableMode && detector(reply, { toolId: cfg.toolId });

          if (isDeliverable) {
            showDeliverable(reply);
            const ack = String(cfg.deliverableAckText || "Done — your MLS description is ready above.").trim();
            if (ack) addMsg("bot", ack, { disclaimer: attachDisclaimer, behavior: "smooth" });
          } else {
            addMsg("bot", reply, { disclaimer: attachDisclaimer, behavior: "smooth" });
          }

          pushHistory("assistant", reply);
        }

      } catch (e) {
        thinking.remove();
        addMsg("bot", "Error reaching the assistant. Please try again.", { behavior: "smooth" });
        pushHistory("assistant", "Error reaching the assistant. Please try again.");
      } finally {
        $send.disabled = false;
      }
    }

    async function sendFromInput() {
      const raw = $input.value.trim();

      // NEW: if empty, show Tips instead of doing nothing
      if (!raw) {
        maybeShowTipsFromEmptySend();
        return;
      }

      $input.value = "";
      autoGrow($input);
      await sendMessage(raw, {}, { echoUser: true });
    }

    $input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        // If empty, show Tips (same as clicking send)
        if (!$input.value.trim()) {
          e.preventDefault();
          maybeShowTipsFromEmptySend();
          return;
        }
        e.preventDefault();
        sendFromInput();
      }
    });

    $input.addEventListener("input", () => autoGrow($input));
    autoGrow($input);

    const $reset = qs("#reset");
    if ($reset) $reset.addEventListener("click", () => resetUI());

    const idKey = cfg.toolId ? cfg.toolId : "assistant";
    _instances[idKey] = { reset: resetUI, sendMessage };

    return { reset: resetUI, sendMessage };
  }

  function reset(toolId) {
    const k = toolId ? toolId : "assistant";
    if (_instances[k] && typeof _instances[k].reset === "function") {
      _instances[k].reset();
      return;
    }
    clearHistory(defaultKey(toolId));
  }

  window.PAWToolShell = { init, reset };
})();
