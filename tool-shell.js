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
      const embed = qp.get("embed");
      const inFrame = window.self !== window.top;
      if (!inFrame && embed !== "1") {
        location.replace("https://proagentworks.com");
      }
    } catch (_) {}
  }

  enforceCircleOnly();

  // --------------------------------------------------------------------------
  // Global, always-visible progress cue.
  // This prevents the "nothing happened... then BAM" feeling when the chat/output
  // area is off-screen (common after pasting very large text).
  //
  // This bar is local-only UI; it has no effect on Worker logic.
  // --------------------------------------------------------------------------

  let __pawWorkingBar = null;

  function ensureWorkingBarStyles() {
    if (document.getElementById("paw-working-bar-style")) return;

    const style = document.createElement("style");
    style.id = "paw-working-bar-style";
    style.textContent = `
      .paw-working-bar{
        position: fixed;
        left: 12px;
        right: 12px;
        bottom: 12px;
        z-index: 2147483647; /* stay above modals/overlays */
        display: none;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.92);
        color: white;
        font-size: 14px;
        box-shadow: 0 12px 30px rgba(0,0,0,.35);
        backdrop-filter: blur(10px);
      }
      .paw-working-left{
        display:flex;
        align-items:center;
        gap:10px;
        min-width: 0;
      }
      .paw-working-label{
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 70vw;
      }
      .paw-dots{
        display: inline-flex;
        gap: 4px;
        align-items: center;
      }
      .paw-dot{
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: rgba(255,255,255,.75);
        animation: pawDotPulse 1.2s infinite ease-in-out;
      }
      .paw-dot:nth-child(2){ animation-delay: .15s; }
      .paw-dot:nth-child(3){ animation-delay: .30s; }
      @keyframes pawDotPulse{
        0%, 80%, 100% { transform: translateY(0); opacity: .35; }
        40% { transform: translateY(-2px); opacity: 1; }
      }
      @media (prefers-color-scheme: light) {
        .paw-working-bar{
          background: rgba(15, 23, 42, 0.88);
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
        <div class="paw-working-left">
          <span class="paw-dots" aria-hidden="true">
            <span class="paw-dot"></span>
            <span class="paw-dot"></span>
            <span class="paw-dot"></span>
          </span>
          <span class="paw-working-label" id="pawWorkingLabel">Working…</span>
        </div>
      `;

      document.body.appendChild(__pawWorkingBar);
    }

    try {
      const lbl = __pawWorkingBar.querySelector("#pawWorkingLabel");
      if (lbl) lbl.textContent = String(labelText || "Working…");
      __pawWorkingBar.style.display = "flex";
    } catch (_) {}
  }

  function hideWorkingBar() {
    try {
      if (__pawWorkingBar) __pawWorkingBar.style.display = "none";
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function removeNode(node) {
    try {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (_) {}
  }

  function safeText(v) {
    if (v == null) return "";
    return String(v);
  }

  // Yield one paint so UI (spinners/dots) render before heavy work begins.
  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // Clipboard helper used by deliverable modals.
  // Some embedded contexts (iframes) may restrict clipboard APIs; we fallback to a hidden textarea.
  async function copyToClipboard(text) {
    const txt = String(text || "");
    if (!txt) return false;

    // Preferred modern API
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(txt);
        return true;
      }
    } catch (_) {
      // fall through to legacy path
    }

    // Legacy fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);

      const ok = document.execCommand && document.execCommand("copy");
      removeNode(ta);
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // PAW Tool Shell API
  // --------------------------------------------------------------------------

  window.PAWToolShell = {
    init: function initToolShell(config) {
      const apiEndpoint = safeText(config.apiEndpoint);
      const toolId = safeText(config.toolId);
      const getPrefs = typeof config.getPrefs === "function" ? config.getPrefs : null;

      const $messages = document.getElementById("messages");
      const $input = document.getElementById("input");
      const $send = document.getElementById("send");
      const $reset = document.getElementById("reset");
      const $toolForm = document.getElementById("toolForm");
      const $tips = document.getElementById("tips");

      const deliverableTitle = safeText(config.deliverableTitle || "Your Deliverable");

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
        return history.slice(-sendHistoryItems);
      }

      function appendMessage(container, role, text) {
        if (!container) return null;

        const wrapper = document.createElement("div");
        wrapper.className = role === "assistant" ? "msg assistant" : "msg user";

        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = String(text || "");

        wrapper.appendChild(bubble);
        container.appendChild(wrapper);

        // Keep it simple; tools can handle scroll behavior themselves.
        try {
          container.scrollTop = container.scrollHeight;
        } catch (_) {}

        return wrapper;
      }

      function appendThinking(container) {
        if (!container) return null;

        const wrapper = document.createElement("div");
        wrapper.className = "msg assistant";

        const bubble = document.createElement("div");
        bubble.className = "bubble thinking";
        bubble.innerHTML = `
          <span class="thinking-dots" aria-label="Working">
            <span></span><span></span><span></span>
          </span>
        `;

        wrapper.appendChild(bubble);
        container.appendChild(wrapper);

        try {
          container.scrollTop = container.scrollHeight;
        } catch (_) {}

        return wrapper;
      }

      // Deliverable modal helpers (copy/revise)
      function showDeliverableModal(title, bodyText) {
        const modal = document.getElementById("pawDeliverableModal");
        if (!modal) return;

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

      async function sendExtra(payload) {
        // payload: { message, context, ... } from tool pages
        if (!apiEndpoint || !toolId) return;

        if (isSending) return;
        isSending = true;

        let thinkingNode = null;

        // Always-visible progress cue (prevents "nothing is happening" when the chat stream is off-screen)
        showWorkingBar("Working…");
        await nextPaint();

        try {
          const msg = safeText(payload && payload.message);
          const context = payload && payload.context ? payload.context : {};

          const prefs = getPrefs
            ? getPrefs()
            : {
                type: "",
                tone: "",
                length: "",
              };

          thinkingNode = appendThinking($messages);

          const body = {
            tool_id: toolId,
            message: msg,
            context: context,
            prefs: prefs,
            history: getHistoryForSend(),
          };

          const res = await fetch(apiEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          let data = null;
          try {
            data = await res.json();
          } catch (_) {
            data = null;
          }

          removeNode(thinkingNode);

          if (!res.ok) {
            const errText =
              (data && (data.error || data.message)) ||
              `Something went wrong (${res.status}).`;
            appendMessage($messages, "assistant", errText);
            pushHistory("assistant", errText);
            return;
          }

          const assistantText =
            (data && (data.output || data.text || data.message)) || "";

          if (payload && payload.openDeliverableModal) {
            // Show modal with copy/revise buttons.
            showDeliverableModal(deliverableTitle, assistantText);
          } else {
            appendMessage($messages, "assistant", assistantText);
          }

          pushHistory("assistant", assistantText);

          // Wire Copy button inside modal (if present)
          try {
            const modal = document.getElementById("pawDeliverableModal");
            if (modal) {
              const copyBtn = modal.querySelector("[data-paw-copy]");
              if (copyBtn) {
                copyBtn.onclick = async () => {
                  const ok = await copyToClipboard(assistantText);
                  copyBtn.textContent = ok ? "Copied" : "Copy failed";
                  setTimeout(() => (copyBtn.textContent = "Copy"), 1100);
                };
              }

              const closeBtn = modal.querySelector("[data-paw-close]");
              if (closeBtn) closeBtn.onclick = hideDeliverableModal;
            }
          } catch (_) {}
        } catch (e) {
          removeNode(thinkingNode);
          appendMessage($messages, "assistant", "Network error. Please try again.");
        } finally {
          isSending = false;
          hideWorkingBar();
        }
      }

      async function sendMessage(evt) {
        if (evt && typeof evt.preventDefault === "function") evt.preventDefault();

        if (!apiEndpoint || !toolId) return;
        if (!$input) return;

        const msg = String($input.value || "").trim();
        if (!msg) return;

        // Default: echo user into chat for normal send.
        await sendExtra({ message: msg, context: {}, echoUser: true, openDeliverableModal: false });

        // Clear input after send
        try {
          $input.value = "";
        } catch (_) {}
      }

      function reset() {
        try {
          history = [];
          if ($messages) $messages.innerHTML = "";
          if ($input) $input.value = "";
        } catch (_) {}
      }

      // ------------------------------------------------------------------
      // Draft persistence helpers
      // These are intentionally simple and optional: individual tools can
      // choose to save/restore state locally (e.g., after a crash).
      //
      // SECURITY/PRIVACY NOTE:
      // - Nothing is transmitted; this is local-only state.
      // - Tools should ALWAYS ask the user before restoring (no silent restore),
      //   and Reset should clear any saved draft to avoid "prior listing" leaks.
      function getState() {
        try {
          return {
            history: Array.isArray(history) ? history.slice(0) : [],
            input: $input ? String($input.value || "") : "",
          };
        } catch (_) {
          return { history: [], input: "" };
        }
      }

      function setState(state) {
        try {
          const h = state && Array.isArray(state.history) ? state.history : [];
          history = h.slice(0, maxHistoryItems);

          if ($messages) $messages.innerHTML = "";
          for (const item of history) {
            if (!item) continue;
            const role = item.role === "assistant" ? "assistant" : "user";
            appendMessage($messages, role, item.content || "");
          }

          if ($input && typeof state.input === "string") $input.value = state.input;
        } catch (_) {}
      }

      // Wire events
      if ($send) $send.addEventListener("click", sendMessage);
      if ($toolForm) {
        $toolForm.addEventListener("submit", function (e) {
          e.preventDefault();
          sendMessage(e);
        });
      }

      if ($reset) $reset.addEventListener("click", reset);

      if ($tips && typeof config.tipsText === "string") {
        $tips.addEventListener("click", function () {
          alert(config.tipsText);
        });
      }

      return { sendMessage, sendExtra, reset, getState, setState };
    },
  };
})();
