/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools
 * DO NOT put prompting logic here — Worker only
 *
 * Contract:
 * - Tool pages include:
 *    #messages (container)
 *    #input (textarea)
 *    #send (button)
 *    #reset (button)
 *    #tips (button)
 * - Tool pages call:
 *    window.PAWToolShell.init({
 *      apiEndpoint, toolId, tipsText,
 *      getPrefs?, getExtraPayload?, onResponse?,
 *      sendHistoryItems?, maxHistoryItems?,
 *      deliverableMode?, deliverableTitle?,
 *      enableDisclaimer?, disclaimerTrigger?, getDisclaimerText?
 *    })
 *
 * Thinking indicator:
 * - CSS lives in paw-ui.css
 * - JS must add/remove a message bubble using:
 *   .msg.ai.paw-thinking
 *   .paw-dots > .paw-dot (x3)
 */

(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function scrollToBottom(el) {
    try {
      el.scrollTop = el.scrollHeight;
    } catch {}
  }

  function appendMessage($messages, role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "ai");

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const p = document.createElement("p");
    p.textContent = String(text || "");

    bubble.appendChild(p);
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    scrollToBottom($messages);
  }

  // ==========================
  // Thinking indicator (markup only; CSS is in paw-ui.css)
  // ==========================
  function appendThinking($messages) {
    const wrap = document.createElement("div");
    wrap.className = "msg ai paw-thinking";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const p = document.createElement("p");
    p.textContent = "Thinking";

    const dots = document.createElement("span");
    dots.className = "paw-dots";
    dots.setAttribute("aria-hidden", "true");

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "paw-dot";
      dots.appendChild(dot);
    }

    p.appendChild(dots);
    bubble.appendChild(p);
    wrap.appendChild(bubble);

    $messages.appendChild(wrap);
    scrollToBottom($messages);

    return wrap;
  }

  function removeThinking(node) {
    try {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch {}
  }
  // ==========================

  function ensureTipsModal() {
    let modal = $("pawTipsModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "pawTipsModal";
    modal.className = "modal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pawTipsTitle">
        <div class="modal-head">
          <div id="pawTipsTitle" class="modal-title">Tips &amp; How To</div>
          <button class="modal-close" id="pawTipsClose" aria-label="Close" type="button">✕</button>
        </div>
        <div class="modal-body">
          <div id="pawTipsBody" style="white-space:pre-wrap;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    };

    $("pawTipsClose").addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });

    return modal;
  }

  function showTips(text) {
    const modal = ensureTipsModal();
    const body = $("pawTipsBody");
    if (body) body.textContent = String(text || "");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function init(config) {
    const apiEndpoint = String(config && config.apiEndpoint ? config.apiEndpoint : "").trim();
    const toolId = String(config && config.toolId ? config.toolId : "").trim();

    const tipsText = String(config && config.tipsText ? config.tipsText : "").trim();

    const sendHistoryItems = Number.isFinite(config.sendHistoryItems) ? config.sendHistoryItems : 10;
    const maxHistoryItems = Number.isFinite(config.maxHistoryItems) ? config.maxHistoryItems : 20;

    const enableDisclaimer = !!(config && config.enableDisclaimer);
    const disclaimerTrigger = config && config.disclaimerTrigger instanceof RegExp ? config.disclaimerTrigger : null;
    const getDisclaimerText =
      typeof config.getDisclaimerText === "function" ? config.getDisclaimerText : () => "";

    const getPrefs = typeof config.getPrefs === "function" ? config.getPrefs : () => ({});
    const getExtraPayload =
      typeof config.getExtraPayload === "function" ? config.getExtraPayload : () => ({});
    const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

    // DOM (by contract)
    const $messages = $("messages");
    const $input = $("input");
    const $send = $("send");
    const $reset = $("reset");
    const $tips = $("tips");

    if (!$messages || !$input || !$send) {
      console.error("[PAWToolShell] Missing required DOM elements (#messages, #input, #send).");
      return {
        sendMessage: async () => {},
        sendExtra: async () => {},
        reset: () => {},
      };
    }

    if (config && typeof config.inputPlaceholder === "string" && config.inputPlaceholder.trim()) {
      $input.setAttribute("placeholder", config.inputPlaceholder.trim());
    }

    // Conversation history: [{ role: "user"|"assistant", content: "..." }]
    let history = [];
    let isSending = false;

    function pushHistory(role, content) {
      history.push({ role, content: String(content || "") });
      if (history.length > maxHistoryItems) {
        history = history.slice(history.length - maxHistoryItems);
      }
    }

    async function postToWorker(payload) {
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return await res.json();
    }

    async function sendMessage(text, options = {}) {
      if (isSending) return;
      const trimmed = String(text || "").trim();
      if (!trimmed) return;
      if (!apiEndpoint) {
        appendMessage($messages, "ai", "Missing API endpoint configuration.");
        return;
      }

      const echoUser = options.echoUser !== false;

      isSending = true;
      let thinkingNode = null;

      try {
        if (echoUser) appendMessage($messages, "user", trimmed);
        if (echoUser) pushHistory("user", trimmed);

        // Optional disclaimer (triggered by user message)
        if (enableDisclaimer && disclaimerTrigger && disclaimerTrigger.test(trimmed)) {
          const d = String(getDisclaimerText() || "").trim();
          if (d) {
            appendMessage($messages, "ai", d);
            pushHistory("assistant", d);
          }
        }

        // Show thinking indicator while waiting
        thinkingNode = appendThinking($messages);

        // Payload assembly
        const prefs = getPrefs() || {};
        const extra = getExtraPayload(trimmed) || {};
        const historyToSend = history.slice(Math.max(0, history.length - sendHistoryItems));

        const payload = Object.assign(
          {
            tool: toolId,
            message: trimmed,
            prefs,
            history: historyToSend,
          },
          extra
        );

        const data = await postToWorker(payload);

        // Remove thinking once we have a response
        removeThinking(thinkingNode);
        thinkingNode = null;

        // Allow tool page to intercept/override rendering
        if (onResponse) {
          const handled = onResponse(data);
          if (handled && handled.skipDefault) {
            isSending = false;
            return;
          }
        }

        const reply = data && typeof data.reply === "string" ? data.reply : "";
        if (reply) {
          appendMessage($messages, "ai", reply);
          pushHistory("assistant", reply);
        } else {
          appendMessage($messages, "ai", "No response received.");
          pushHistory("assistant", "No response received.");
        }
      } catch (err) {
        removeThinking(thinkingNode);
        appendMessage($messages, "ai", "Something went wrong. Please try again.");
        pushHistory("assistant", "Something went wrong. Please try again.");
      } finally {
        isSending = false;
        try {
          $input.value = "";
          $input.focus();
        } catch {}
      }
    }

    // Used by listing tool for background phases / follow-on writes
    async function sendExtra(instruction, extraPayload = {}, options = {}) {
      if (isSending) return;
      const msg = String(instruction || "").trim();
      if (!msg) return;
      if (!apiEndpoint) {
        appendMessage($messages, "ai", "Missing API endpoint configuration.");
        return;
      }

      const echoUser = options.echoUser === true;

      isSending = true;
      let thinkingNode = null;

      try {
        if (echoUser) appendMessage($messages, "user", msg);
        if (echoUser) pushHistory("user", msg);

        // Show thinking indicator while waiting
        thinkingNode = appendThinking($messages);

        const prefs = getPrefs() || {};
        const historyToSend = history.slice(Math.max(0, history.length - sendHistoryItems));

        const payload = Object.assign(
          {
            tool: toolId,
            message: msg,
            prefs,
            history: historyToSend,
          },
          extraPayload || {}
        );

        const data = await postToWorker(payload);

        removeThinking(thinkingNode);
        thinkingNode = null;

        if (onResponse) {
          const handled = onResponse(data);
          if (handled && handled.skipDefault) {
            isSending = false;
            return;
          }
        }

        const reply = data && typeof data.reply === "string" ? data.reply : "";
        if (reply) {
          appendMessage($messages, "ai", reply);
          pushHistory("assistant", reply);
        }
      } catch (err) {
        removeThinking(thinkingNode);
        if (echoUser) appendMessage($messages, "ai", "Something went wrong. Please try again.");
      } finally {
        isSending = false;
      }
    }

    // Wire send button + Enter key
    $send.addEventListener("click", () => sendMessage($input.value));
    $input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage($input.value);
      }
    });

    // Reset
    if ($reset) {
      $reset.addEventListener("click", () => {
        try {
          $messages.innerHTML = "";
          $input.value = "";
          history = [];
        } catch {}
      });
    }

    // Tips
    if ($tips) {
      $tips.addEventListener("click", () => {
        showTips(tipsText || "No tips configured for this tool.");
      });
    }

    return {
      sendMessage,
      sendExtra,
      reset() {
        try {
          $messages.innerHTML = "";
          $input.value = "";
          history = [];
        } catch {}
      },
    };
  }

  window.PAWToolShell = { init };
})();
