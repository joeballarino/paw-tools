/* ==========================================================================
   PAW Tool Shell (shared)
   --------------------------------------------------------------------------
   Purpose:
   - Provide consistent “app-like” behavior for all public tool pages.
   - Keep tool pages focused on UI only.
   - All AI prompting + protected configuration lives in the private Worker.

   Required DOM IDs on each tool page:
     #messages  (container)
     #input     (textarea)
     #send      (button)
     #reset     (button)
     #tips      (button, optional but recommended)

   Embed mode:
   - Circle embeds often create “double containers”.
   - paw-ui.css supports embed styling via: html[data-embed="1"]
   - This shell sets that attribute automatically when in an iframe.
   - Force embed mode with: ?embed=1

   IMPORTANT UX GUARANTEE:
   - The composer is cleared immediately after submit so typed text never “sticks”
     (this prevents the “hello doesn’t go away” regression permanently).
   ========================================================================== */

(function () {
  function $(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function appendMessage(messagesEl, role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendThinking(messagesEl) {
    const wrap = document.createElement("div");
    wrap.className = "msg ai paw-thinking";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = "Thinking";
    const dots = document.createElement("span");
    dots.className = "paw-dots";
    dots.innerHTML = '<span class="paw-dot"></span><span class="paw-dot"></span><span class="paw-dot"></span>';
    bubble.appendChild(dots);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function removeNode(node) {
    try { node && node.parentNode && node.parentNode.removeChild(node); } catch (e) {}
  }

  function getAuthToken() {
    // Optional: allow a meta tag if you ever add lightweight auth.
    const el = document.querySelector('meta[name="paw-token"]');
    const t = el && el.getAttribute("content");
    return t ? String(t) : "";
  }

  async function postJSON(url, payload, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { reply: text }; }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ("Request failed (" + res.status + ")");
      throw new Error(msg);
    }
    return data;
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function detectEmbed(config) {
    if (typeof config.embedMode === "boolean") return config.embedMode;

    try {
      const qs = new URLSearchParams(window.location.search || "");
      const q = (qs.get("embed") || "").toLowerCase();
      if (q === "1" || q === "true" || q === "yes") return true;
    } catch (e) {}

    try { return window.self !== window.top; } catch (e) { return true; }
  }

  window.PAWToolShell = {
    init: function (config) {
      config = config || {};

      // Embed mode: removes “double boxes” inside Circle embeds.
      try {
        if (detectEmbed(config)) document.documentElement.setAttribute("data-embed", "1");
        else document.documentElement.removeAttribute("data-embed");
      } catch (e) {}

      const toolId = String(config.toolId || "");
      const apiEndpoint = String(config.apiEndpoint || "").replace(/\/+$/, "");
      const sendHistoryItems = clamp(Number(config.sendHistoryItems || 10), 0, 50);
      const maxHistoryItems = clamp(Number(config.maxHistoryItems || 20), 0, 100);

      const getPrefs = typeof config.getPrefs === "function" ? config.getPrefs : null;
      const getExtraPayload = typeof config.getExtraPayload === "function" ? config.getExtraPayload : null;
      const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

      const enableDisclaimer = !!config.enableDisclaimer;
      const disclaimerTrigger = config.disclaimerTrigger instanceof RegExp ? config.disclaimerTrigger : null;
      const getDisclaimerText = typeof config.getDisclaimerText === "function" ? config.getDisclaimerText : () => "";

      const messagesEl = $("messages");
      const inputEl = $("input");
      const sendBtn = $("send");
      const resetBtn = $("reset");
      const tipsBtn = $("tips");

      if (!messagesEl || !inputEl || !sendBtn) {
        console.warn("[PAWToolShell] Missing required DOM IDs: #messages, #input, #send");
      }

      const history = [];
      let isSending = false;
      let disclaimerShown = false;

      function pushHistory(role, content) {
        history.push({ role, content });
        while (history.length > maxHistoryItems) history.shift();
      }

      function historyForSend() {
        if (sendHistoryItems <= 0) return [];
        return history.slice(-sendHistoryItems);
      }

      function clearComposer(keepFocus = true) {
        try {
          inputEl.value = "";
          inputEl.style.height = "";
          if (keepFocus) inputEl.focus();
        } catch (e) {}
      }

      function maybeShowDisclaimerOnce() {
        if (!enableDisclaimer || disclaimerShown) return;
        const text = getDisclaimerText();
        if (!text) return;
        appendMessage(messagesEl, "ai", text);
        disclaimerShown = true;
      }

      async function callWorker(payload) {
        const token = getAuthToken();
        const url = apiEndpoint + "/api";
        return await postJSON(url, payload, token);
      }

      async function sendMessage(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed || isSending) return;
        if (!apiEndpoint) {
          appendMessage(messagesEl, "ai", "Missing API endpoint configuration.");
          return;
        }

        isSending = true;
        let thinking = null;

        try {
          appendMessage(messagesEl, "user", trimmed);
          pushHistory("user", trimmed);

          // IMPORTANT UX FIX (prevents “hello sticks” forever):
          clearComposer(true);

          if (enableDisclaimer && disclaimerTrigger && disclaimerTrigger.test(trimmed)) {
            maybeShowDisclaimerOnce();
          }

          thinking = appendThinking(messagesEl);

          const prefs = getPrefs ? getPrefs() : {};
          const extra = getExtraPayload ? (getExtraPayload(trimmed) || {}) : {};
          const payload = { toolId, history: historyForSend(), prefs, extra };

          const data = await callWorker(payload);

          removeNode(thinking);

          if (onResponse) {
            try {
              const result = onResponse(data);
              if (result && result.skipDefault) return;
            } catch (e) {}
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage(messagesEl, "ai", reply);
            pushHistory("assistant", reply);
            maybeShowDisclaimerOnce();
          }
        } catch (err) {
          removeNode(thinking);
          appendMessage(messagesEl, "ai", "Something went wrong. Please try again.");
          console.error("[PAWToolShell] sendMessage error:", err);
        } finally {
          isSending = false;
        }
      }

      async function sendExtra(instruction, extraPayload, options) {
        options = options || {};
        const msg = String(instruction || "").trim();
        if (!msg || isSending) return;

        if (!apiEndpoint) {
          appendMessage(messagesEl, "ai", "Missing API endpoint configuration.");
          return;
        }

        isSending = true;
        let thinking = null;

        try {
          if (options.echoUser !== false) {
            appendMessage(messagesEl, "user", msg);
            pushHistory("user", msg);
          }

          thinking = appendThinking(messagesEl);

          const prefs = getPrefs ? getPrefs() : {};
          const baseExtra = getExtraPayload ? (getExtraPayload(msg) || {}) : {};
          const mergedExtra = Object.assign({}, baseExtra, extraPayload || {});
          const payload = { toolId, history: historyForSend(), prefs, extra: mergedExtra };

          const data = await callWorker(payload);

          removeNode(thinking);

          if (onResponse) {
            try {
              const result = onResponse(data);
              if (result && result.skipDefault) return data;
            } catch (e) {}
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage(messagesEl, "ai", reply);
            pushHistory("assistant", reply);
            maybeShowDisclaimerOnce();
          }

          return data;
        } catch (err) {
          removeNode(thinking);
          appendMessage(messagesEl, "ai", "Something went wrong. Please try again.");
          console.error("[PAWToolShell] sendExtra error:", err);
        } finally {
          isSending = false;
        }
      }

      function reset() {
        try { messagesEl.innerHTML = ""; } catch (e) {}
        history.length = 0;
        disclaimerShown = false;
        clearComposer(true);
      }

      // Wire events
      sendBtn.addEventListener("click", function () { sendMessage(inputEl.value); });
      inputEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage(inputEl.value);
        }
      });

      if (resetBtn) resetBtn.addEventListener("click", reset);

      if (tipsBtn && typeof config.tipsText === "string") {
        tipsBtn.addEventListener("click", function () { alert(config.tipsText); });
      }

      return { sendMessage, sendExtra, reset };
    }
  };
})();
