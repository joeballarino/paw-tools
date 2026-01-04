/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools
 * DO NOT put prompting logic here — Worker only
 *
 * Embed handling:
 * - If inside an iframe OR ?embed=1, sets: <html data-embed="1">
 * - paw-ui.css contains the visual embed rules.
 */

(function () {
  // -----------------------------
  // Global embed detection (applies to ALL tools)
  // -----------------------------
  (function setEmbedMode() {
    try {
      const qs = new URLSearchParams(window.location.search);
      const wantsEmbed = qs.get("embed") === "1";
      const inIframe = window.self !== window.top;
      if (wantsEmbed || inIframe) {
        document.documentElement.setAttribute("data-embed", "1");
      }
    } catch (e) {
      // Cross-origin iframe safety: assume embed
      document.documentElement.setAttribute("data-embed", "1");
    }
  })();

  // -----------------------------
  // Helpers
  // -----------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function appendMessage($messages, role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    $messages.scrollTop = $messages.scrollHeight;
    return wrap;
  }

  function appendThinking($messages) {
    const wrap = document.createElement("div");
    wrap.className = "msg ai";
    const bubble = document.createElement("div");
    bubble.className = "bubble thinking";
    bubble.textContent = "Thinking…";
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    $messages.scrollTop = $messages.scrollHeight;
    return wrap;
  }

  function removeThinking(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  async function postJSON(url, payload, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    });

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json() : await res.text();

    if (!res.ok) {
      const msg =
        (data && data.error) ||
        (typeof data === "string" ? data : "") ||
        `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // -----------------------------
  // Shell factory (per-page)
  // -----------------------------
  window.PAWToolShell = function initShell(config) {
    config = config || {};

    const toolId = config.toolId || "";
    const apiEndpoint = config.apiEndpoint || "";
    const sendHistoryItems = Number.isFinite(config.sendHistoryItems)
      ? config.sendHistoryItems
      : 12;

    const getDisclaimerText =
      typeof config.getDisclaimerText === "function" ? config.getDisclaimerText : () => "";

    const getPrefs = typeof config.getPrefs === "function" ? config.getPrefs : () => ({});
    const getExtraPayload =
      typeof config.getExtraPayload === "function" ? config.getExtraPayload : () => ({});
    const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

    const $messages = $("messages");

    // Support both legacy IDs (#input/#send) and newer shared IDs (#prompt/#submitBtn/#toolForm).
    // listing.html uses #input and #send; other tools may use #prompt/#submitBtn.
    const $form = $("toolForm");
    const $input = $("prompt") || $("input");
    const $send = $("submitBtn") || $("send");
    const $reset = $("reset");
    const $tips = $("tips");

    if (!$messages || !$input || !$send) {
      console.error(
        "[PAWToolShell] Missing required DOM elements (#messages and one of: #input/#prompt and #send/#submitBtn)."
      );
      return {
        sendMessage: async () => {},
        sendExtra: async () => {},
        reset: () => {},
      };
    }

    const history = [];
    let isSending = false;

    function pushHistory(role, content) {
      history.push({ role, content });
    }

    function getAuthToken() {
      try {
        return localStorage.getItem("paw_token") || "";
      } catch (e) {
        return "";
      }
    }

    function clearComposer() {
      try {
        $input.value = "";
      } catch (e) {}
    }

    async function postToWorker(payload) {
      const token = getAuthToken();
      return await postJSON(apiEndpoint, payload, token);
    }

    async function sendMessage(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed) return;
      if (isSending) return;

      if (!apiEndpoint) {
        appendMessage($messages, "ai", "Missing API endpoint configuration.");
        return;
      }

      isSending = true;
      let thinkingNode = null;

      try {
        appendMessage($messages, "user", trimmed);
        pushHistory("user", trimmed);
        clearComposer();

        thinkingNode = appendThinking($messages);

        const prefs = getPrefs() || {};
        const historyToSend = history.slice(Math.max(0, history.length - sendHistoryItems));

        const extra = getExtraPayload(trimmed) || {};
        const payload = Object.assign(
          { tool: toolId, message: trimmed, prefs, history: historyToSend },
          extra || {}
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
        appendMessage($messages, "ai", "Something went wrong. Please try again.");
      } finally {
        isSending = false;
      }
    }

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

        thinkingNode = appendThinking($messages);

        const prefs = getPrefs() || {};
        const historyToSend = history.slice(Math.max(0, history.length - sendHistoryItems));

        // IMPORTANT: allow tool pages to expand special instructions via getExtraPayload()
        // listing.html relies on this for background highlight requests that trigger the POI modal.
        const extraFromHook = getExtraPayload(msg) || {};
        const payload = Object.assign(
          { tool: toolId, message: msg, prefs, history: historyToSend },
          extraFromHook,
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

    function reset() {
      try {
        $messages.innerHTML = "";
      } catch (e) {}
      history.length = 0;
      clearComposer();
      const disclaimer = getDisclaimerText();
      if (disclaimer) {
        appendMessage($messages, "ai", disclaimer);
      }
    }

    // -----------------------------
    // Wire UI events
    // -----------------------------

    // Send actions
    $send.addEventListener("click", () => sendMessage($input.value));

    // If a tool uses a <form id="toolForm">, prefer submit behavior (e.g., desktop Enter key in inputs).
    if ($form) {
      $form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendMessage($input.value);
      });
    }

    // Textarea-style composer (listing.html): Enter sends, Shift+Enter newline.
    $input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage($input.value);
      }
    });

    if ($reset) {
      $reset.addEventListener("click", () => reset());
    }

    if ($tips) {
      $tips.addEventListener("click", () => {
        // optional tips panel behavior (page-specific)
        if (typeof config.onTips === "function") config.onTips();
      });
    }

    // Prime disclaimer, if any
    const disclaimer = getDisclaimerText();
    if (disclaimer) {
      appendMessage($messages, "ai", disclaimer);
    }

    return {
      sendMessage,
      sendExtra,
      reset,
    };
  };
})();