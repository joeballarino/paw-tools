/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools.
 *
 * IMPORTANT:
 * - Prompting stays in the Worker.
 * - This file only handles UI wiring + API calls.
 */

(function () {
  "use strict";

  // Circle-only product: if a tool page is opened outside an iframe (i.e., outside Circle),
  // redirect to the marketing site. This prevents 'standalone' usage and avoids layout drift.
  // NOTE: embed=1 is still honored for safety/testing, but Circle always runs tools in an iframe.
  function enforceCircleOnly() {
    try {
      const qp = new URLSearchParams(location.search);
      const embed = qp.get('embed');
      const inFrame = window.self !== window.top;
      if (!inFrame && embed !== '1') {
        location.replace('https://proagentworks.com');
      }
    } catch (_) {}
  }

  enforceCircleOnly();

  function $(id) {
    return document.getElementById(id);
  }

  function safeText(s) {
    return String(s || "").trim();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function appendMessage($messages, role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = "<p>" + escapeHtml(text) + "</p>";
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    $messages.scrollTop = $messages.scrollHeight;
    return wrap;
  }

  function appendThinking($messages) {
    const wrap = document.createElement("div");
    wrap.className = "msg ai paw-thinking";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML =
      '<p>Thinking<span class="paw-dots"><span class="paw-dot"></span><span class="paw-dot"></span><span class="paw-dot"></span></span></p>';
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    $messages.scrollTop = $messages.scrollHeight;
    return wrap;
  }

  
  // --- UX helper: always-visible "Working..." strip -------------------------
  // Problem this solves:
  // In embedded/iframe tools (Circle), long text pastes can push the chat stream
  // below the fold. We *do* append an in-stream thinking bubble, but users may
  // not be scrolled to it, so it looks like nothing is happening until results
  // appear "all at once".
  //
  // This lightweight fixed bar gives immediate, always-visible feedback while a
  // request is in-flight. It does NOT change backend behavior.
  let __pawWorkingBar = null;
  let __pawWorkingBarStyleInjected = false;

  function nextPaint() {
    // Ensure the browser gets a chance to render state changes (spinner/dots)
    // before we do any heavier sync work or kick off fetch().
    return new Promise((resolve) => {
      try {
        requestAnimationFrame(() => resolve());
      } catch (_) {
        setTimeout(resolve, 0);
      }
    });
  }

  function ensureWorkingBarStyles() {
    if (__pawWorkingBarStyleInjected) return;
    __pawWorkingBarStyleInjected = true;

    const style = document.createElement("style");
    style.setAttribute("data-paw", "working-bar");
    style.textContent = `
      .paw-working-bar{
        position: fixed;
        left: 12px;
        right: 12px;
        bottom: 12px;
        z-index: 99999;
        pointer-events: none;
        display: none;
      }
      .paw-working-bar .paw-working-inner{
        pointer-events: auto;
        margin: 0 auto;
        max-width: 720px;
        border-radius: 14px;
        padding: 10px 12px;
        box-shadow: 0 12px 30px rgba(0,0,0,.12);
        background: rgba(255,255,255,.96);
        border: 1px solid rgba(0,0,0,.08);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-size: 14px;
        line-height: 1.2;
      }
      /* Dark mode-ish fallback (if host page is dark) */
      @media (prefers-color-scheme: dark){
        .paw-working-bar .paw-working-inner{
          background: rgba(20,20,20,.92);
          border: 1px solid rgba(255,255,255,.10);
          box-shadow: 0 12px 30px rgba(0,0,0,.35);
          color: #f2f2f2;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function showWorkingBar(labelText) {
    ensureWorkingBarStyles();
    if (!__pawWorkingBar) {
      __pawWorkingBar = document.createElement("div");
      __pawWorkingBar.className = "paw-working-bar";
      __pawWorkingBar.setAttribute("role", "status");
      __pawWorkingBar.setAttribute("aria-live", "polite");
      __pawWorkingBar.innerHTML = `
        <div class="paw-working-inner">
          <span class="paw-working-label"></span>
          <span class="paw-dots" aria-hidden="true">
            <span class="paw-dot"></span><span class="paw-dot"></span><span class="paw-dot"></span>
          </span>
        </div>
      `;
      document.body.appendChild(__pawWorkingBar);
    }
    const label = __pawWorkingBar.querySelector(".paw-working-label");
    if (label) label.textContent = safeText(labelText || "Working…");
    __pawWorkingBar.style.display = "block";
  }

  function hideWorkingBar() {
    try {
      if (__pawWorkingBar) __pawWorkingBar.style.display = "none";
    } catch (_) {}
  }
  // --------------------------------------------------------------------------
function removeNode(node) {
    try {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (_) {}
  }

  function showToast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = String(text || "");
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => removeNode(t), 250);
    }, 1800);
  }

  /**
   * Clipboard helper used by the "Copy" button in the Copy/Revise modal.
   *
   * Why this exists:
   * - Some tools run inside an iframe (Circle embed). Clipboard permissions can vary.
   * - `navigator.clipboard.writeText()` is async and may be blocked without a user gesture,
   *   insecure context, or denied permission. We fall back to `document.execCommand("copy")`
   *   for older browsers / stricter embed contexts.
   *
   * IMPORTANT: Keep this lightweight. No backend calls. No analytics. Just copy.
   */
  function copyToClipboard(value) {
    const text = String(value || "");
    // Prefer modern async clipboard when available.
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        // Fire-and-forget: callers in this repo are synchronous.
        navigator.clipboard.writeText(text).catch(() => copyToClipboardFallback(text));
        return;
      }
    } catch (_) {
      // If access throws (rare), use fallback below.
    }
    copyToClipboardFallback(text);
  }

  function copyToClipboardFallback(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = String(text || "");
      // Keep it off-screen so it doesn't shift layout.
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) {
      // Swallow errors—UI will still show the toast from the caller.
      // If you ever need to surface failures, do it at the call site.
    }
  }

  function getCSRFTokenFromMeta() {
    const el = document.querySelector('meta[name="csrf-token"]');
    return el ? String(el.getAttribute("content") || "").trim() : "";
  }

  function coerceEmbedMode() {
    try {
      const qp = new URLSearchParams(location.search);
      const embed = qp.get("embed");
      const inFrame = window.self !== window.top;
      if (embed === "1" || inFrame) {
        document.documentElement.setAttribute("data-embed", "1");
      }
    } catch (_) {}
  }

  async function postJSON(url, payload, csrfToken) {
    const headers = { "Content-Type": "application/json" };
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { reply: text || "" };
    }

    if (!res.ok) {
      const msg =
        (data && (data.reply || data.error || data.message)) ||
        "Request failed (" + res.status + ")";
      throw new Error(msg);
    }

    return data;
  }

  function buildPayloadBase(toolId, history, prefs, extraPayload) {
    const payload = {
      tool: toolId || "",
      message: "",
      history: Array.isArray(history) ? history : [],
      prefs: prefs && typeof prefs === "object" ? prefs : {},
    };

    if (extraPayload && typeof extraPayload === "object") {
      for (const k in extraPayload) payload[k] = extraPayload[k];
    }

    return payload;
  }

  window.PAWToolShell = {
    init: function (config) {
      config = config || {};

      // Ensure embed mode when framed (fixes “double container” look)
      coerceEmbedMode();

      const apiEndpoint = safeText(config.apiEndpoint);
      const toolId = safeText(config.toolId);

      const $messages = $("messages");
      const $input = $("input") || $("prompt");
      const $send = $("send") || $("submitBtn");
      const $reset = $("reset");
      const $tips = $("tips");
      const $toolForm = $("toolForm");

      const getPrefs = typeof config.getPrefs === "function" ? config.getPrefs : null;
      const getExtraPayload =
        typeof config.getExtraPayload === "function" ? config.getExtraPayload : null;
      const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

      // NEW: tool can gate sending (listing uses this for POI modal before write)
      const beforeSend =
        typeof config.beforeSend === "function" ? config.beforeSend : null;

      const deliverableMode = config.deliverableMode !== false; // default true
      const deliverableTitle = safeText(config.deliverableTitle || "Deliverable");

      const inputPlaceholder = safeText(config.inputPlaceholder);
      if ($input && inputPlaceholder) $input.setAttribute("placeholder", inputPlaceholder);

      const sendHistoryItems =
        typeof config.sendHistoryItems === "number" ? config.sendHistoryItems : 10;
      const maxHistoryItems =
        typeof config.maxHistoryItems === "number" ? config.maxHistoryItems : 20;

      let history = [];
      let isSending = false;

      function pushHistory(role, content) {
        const item = {
          role: role === "assistant" ? "assistant" : "user",
          content: String(content || ""),
        };
        history.push(item);
        if (history.length > maxHistoryItems) history = history.slice(-maxHistoryItems);
      }

      function getHistoryForSend() {
        if (!history.length) return [];
        return history.slice(-Math.max(0, sendHistoryItems));
      }

      function clearComposer(opts) {
        opts = opts || {};
        if ($input) $input.value = "";
        if ($input && opts.keepFocus) {
          try { $input.focus(); } catch (_) {}
        }
      }

      function getPostUrl() {
        // IMPORTANT FIX: Worker is at the root, NOT /api
        return apiEndpoint.replace(/\/+$/, "");
      }

      async function postToWorker(payload) {
        const token = getCSRFTokenFromMeta();
        const url = getPostUrl();
        return await postJSON(url, payload, token);
      }

      
      // Render Worker reply.
      // Listing tool uses "deliverableMode" and should keep the chat flow linear:
      // - Always render the deliverable as a normal assistant message in the thread.
      // - Also open a modal with Copy / Revise actions (every time).
      // Assistant tool sets deliverableMode=false, so it will only render in-flow.
      function ensureDeliverableModal() {
        let modal = document.getElementById("pawDeliverableModal");
        if (modal) return modal;

        modal = document.createElement("div");
        modal.id = "pawDeliverableModal";
        modal.className = "modal";
        modal.setAttribute("aria-hidden", "true");

        // IMPORTANT: We reuse the shared .modal styling in paw-ui.css.
        // This keeps UI consistent and avoids tool-specific CSS regressions.
        modal.innerHTML =
          '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pawDeliverableTitle">' +
          '  <div class="modal-head">' +
          '    <div id="pawDeliverableTitle" class="modal-title"></div>' +
          '    <button class="modal-close" data-action="close" aria-label="Close" type="button">✕</button>' +
          '  </div>' +
          '  <div class="modal-body">' +
          '    <div class="paw-deliverable-text" style="white-space:pre-wrap; word-break:break-word;"></div>' +
          '    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:14px;">' +
          '      <button class="btn" type="button" data-action="copy">Copy</button>' +
          '      <button class="btn primary" type="button" data-action="revise">Revise</button>' +
          '    </div>' +
          '  </div>' +
          '</div>';

        document.body.appendChild(modal);

        // Click handlers (delegated)
        modal.addEventListener("click", function (e) {
          const t = e.target;
          if (!t) return;

          // Click outside card closes
          if (t === modal) {
            hideDeliverableModal();
            return;
          }

          const action = t.getAttribute("data-action");
          if (!action) return;

          if (action === "close") {
            hideDeliverableModal();
            return;
          }

          if (action === "copy") {
            const textEl = modal.querySelector(".paw-deliverable-text");
            const txt = textEl ? textEl.textContent : "";
            copyToClipboard(txt);
            showToast("Copied");
            return;
          }

          if (action === "revise") {
            hideDeliverableModal();

            // UX: focus the composer and prompt for the revision request.
            try {
              if ($input) {
                $input.focus();
                // Encourage a revision request without auto-sending anything.
                $input.placeholder =
                  "Tell me what to change (tone, length, highlights, wording, what to emphasize, etc.)";
              }
            } catch (_) {}
            return;
          }
        });

        // Escape closes
        document.addEventListener("keydown", function (e) {
          if (e.key === "Escape") hideDeliverableModal();
        });

        return modal;
      }

      function showDeliverableModal(title, bodyText) {
        const modal = ensureDeliverableModal();
        const titleEl = modal.querySelector("#pawDeliverableTitle");
        const bodyEl = modal.querySelector(".paw-deliverable-text");
        if (titleEl) titleEl.textContent = String(title || "Your Deliverable");
        if (bodyEl) bodyEl.textContent = String(bodyText || "");

        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
      }

      function hideDeliverableModal() {
        const modal = document.getElementById("pawDeliverableModal");
        if (!modal) return;
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
      }

      function renderDeliverable(replyText) {
        // Always render in-flow for a clean chat experience.
        appendMessage($messages, "ai", replyText);

        if (!deliverableMode) return;

        // Also open a modal with Copy / Revise every time for deliverables.
        showDeliverableModal(deliverableTitle, replyText);

        $messages.scrollTop = $messages.scrollHeight;
      }
async function sendExtra(instruction, extraPayload = {}, options = {}) {
        if (isSending) return;

        const msg = safeText(instruction);
        if (!msg) return;

        if (!apiEndpoint) {
          appendMessage($messages, "ai", "Missing API endpoint configuration.");
          return;
        }

        const echoUser = options.echoUser !== false;

        isSending = true;
        let thinkingNode = null;

        // Always-visible progress cue (prevents "nothing is happening" when the chat stream is off-screen)
        showWorkingBar("Working…");
        await nextPaint();

        try {
          if (echoUser) {
            appendMessage($messages, "user", msg);
            pushHistory("user", msg);
          }

          thinkingNode = appendThinking($messages);

          const prefs = getPrefs ? getPrefs() : {};
          const baseExtra = getExtraPayload ? getExtraPayload(msg) : {};
          const mergedExtra = Object.assign({}, baseExtra, extraPayload || {});

          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, mergedExtra);
          payload.message = msg;

          const data = await postToWorker(payload);

          removeNode(thinkingNode);

          if (onResponse) {
            try {
              const r = onResponse(data);
              if (r && r.skipDefault) return data;
            } catch (_) {}
          }

          const reply = safeText(data && data.reply);
          if (reply) {
            renderDeliverable(reply);
            pushHistory("assistant", reply);
          }
          return data;
        } catch (err) {
          removeNode(thinkingNode);
          appendMessage($messages, "ai", "Error: " + String(err && err.message ? err.message : err));
        } finally {
          isSending = false;
          hideWorkingBar();
        }
      }

      async function sendMessage() {
        if (isSending) return;
        if (!$input) return;
        if (!$messages) return;

        const trimmed = safeText($input.value);
        if (!trimmed) return;

        if (!apiEndpoint) {
          appendMessage($messages, "ai", "Missing API endpoint configuration.");
          return;
        }

        // NEW: allow tool to gate sending
        if (beforeSend) {
          try {
            const res = await beforeSend(trimmed, { sendExtra, clearComposer });
            if (res && res.cancel === true) return;
          } catch (_) {}
        }

        isSending = true;
        let thinkingNode = null;

        // Always-visible progress cue (prevents "nothing is happening" when the chat stream is off-screen)
        showWorkingBar("Working…");
        await nextPaint();

        try {
          appendMessage($messages, "user", trimmed);
          pushHistory("user", trimmed);

          clearComposer({ keepFocus: true });

          thinkingNode = appendThinking($messages);

          const prefs = getPrefs ? getPrefs() : {};
          const extraPayload = getExtraPayload ? getExtraPayload(trimmed) : {};
          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, extraPayload);
          payload.message = trimmed;

          const data = await postToWorker(payload);

          removeNode(thinkingNode);

          if (onResponse) {
            try {
              const r = onResponse(data);
              if (r && r.skipDefault) return;
            } catch (_) {}
          }

          const reply = safeText(data && data.reply);
          if (reply) {
            renderDeliverable(reply);
            pushHistory("assistant", reply);
          }
        } catch (err) {
          removeNode(thinkingNode);
          appendMessage($messages, "ai", "Error: " + String(err && err.message ? err.message : err));
        } finally {
          isSending = false;
          hideWorkingBar();
        }
      }

      function reset() {
        // Reset is a "fresh start" for the tool shell UI only:
        // - clears chat thread
        // - clears composer
        // - hides any always-visible working indicator
        //
        // Tool-specific pages (listing.html, ask.html, etc.) may call this as part of a
        // larger "full reset" that also clears their own form fields + local draft storage.
        try {
          history = [];
          if ($messages) $messages.innerHTML = "";
          if ($input) $input.value = "";

          // Hide the fixed "Working..." strip if it is visible.
          try { hideWorkingBar(); } catch (_) {}

          // Best-effort: close any deliverable modal that might be open.
          try {
            const dm = document.getElementById("pawDeliverableModal");
            if (dm) {
              dm.classList.remove("show");
              dm.setAttribute("aria-hidden", "true");
            }
          } catch (_) {}
        } catch (_) {}
      }

      // Wire events
      if ($send) $send.addEventListener("click", sendMessage);
      if ($toolForm) {
        $toolForm.addEventListener("submit", function (e) {
          e.preventDefault();
          sendMessage();
        });
      }

      if ($input) {
        $input.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
          }
        });
      }

      if ($reset) $reset.addEventListener("click", reset);

      if ($tips && typeof config.tipsText === "string") {
        $tips.addEventListener("click", function () {
          alert(config.tipsText);
        });
      }

      
      // ------------------------------------------------------------
      // State helpers (for local save/resume at the tool-page level)
      // ------------------------------------------------------------
      // IMPORTANT:
      // - These DO NOT persist anything themselves.
      // - They only expose enough state so each tool page can store drafts in localStorage.
      // - We intentionally store *history* (user/assistant turns), not raw DOM HTML,
      //   so we can safely re-render without brittle markup coupling.
      function getState() {
        try {
          return {
            history: Array.isArray(history) ? history.map((h) => ({ role: h.role, content: h.content })) : [],
            input: $input ? String($input.value || "") : ""
          };
        } catch (_) {
          return { history: [], input: "" };
        }
      }

      function setState(state) {
        try {
          const st = state && typeof state === "object" ? state : {};
          const hist = Array.isArray(st.history) ? st.history : [];
          history = hist
            .filter((h) => h && (h.role === "user" || h.role === "assistant"))
            .map((h) => ({ role: h.role, content: String(h.content || "") }));

          if ($messages) {
            $messages.innerHTML = "";
            history.forEach((h) => {
              appendMessage($messages, h.role === "user" ? "user" : "assistant", h.content);
            });
          }

          if ($input) $input.value = typeof st.input === "string" ? st.input : "";

          // Ensure we're not showing "Working..." after a restore.
          try { hideWorkingBar(); } catch (_) {}

          return true;
        } catch (_) {
          return false;
        }
      }
return { sendMessage, sendExtra, reset, getState, setState };
    },
  };
})();