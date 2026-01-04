/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools.
 *
 * HARD CONTRACT (standard for tools):
 * - DOM: #messages, #input, #send, #reset, #tips
 * - API: window.PAWToolShell.init(config) -> returns { sendMessage, sendExtra, reset }
 *
 * Backward/forward compatibility:
 * - Also supports #prompt + #submitBtn + #toolForm if a future tool uses those IDs.
 *
 * IMPORTANT:
 * - Do NOT put prompting logic here — Worker only.
 * - Tool pages provide hooks: getPrefs, getExtraPayload, onResponse.
 * - listing.html relies on sendExtra() also flowing through getExtraPayload() for highlights.
 */

(function () {
  "use strict";

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
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
  }

  function removeNode(node) {
    try {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (e) {}
  }

  function getAuthToken() {
    try {
      const el = document.querySelector('meta[name="paw-auth-token"]');
      const token = el && el.getAttribute("content");
      return token ? String(token) : "";
    } catch (e) {
      return "";
    }
  }

  async function postJSON(url, payload, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok) {
      const msg =
        (data && (data.error || data.message)) || "Request failed (" + res.status + ")";
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  function buildPayloadBase(toolId, history, prefs, extraPayload) {
    return {
      toolId,
      history: history.slice(),
      prefs: prefs || {},
      ...(extraPayload || {}),
    };
  }

  function makeThinkingNode($messages) {
    const wrap = document.createElement("div");
    wrap.className = "msg ai";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = "Thinking...";
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    $messages.scrollTop = $messages.scrollHeight;
    return wrap;
  }

  window.PAWToolShell = {
    init: function (config) {
      config = config || {};

      const toolId = String(config.toolId || "");
      const apiEndpoint = String(config.apiEndpoint || "");
      const sendHistoryItems = Number.isFinite(config.sendHistoryItems)
        ? config.sendHistoryItems
        : 12;

      const getDisclaimerText =
        typeof config.getDisclaimerText === "function" ? config.getDisclaimerText : () => "";

      const getPrefs =
        typeof config.getPrefs === "function" ? config.getPrefs : () => ({});

      const getExtraPayload =
        typeof config.getExtraPayload === "function" ? config.getExtraPayload : () => ({});

      const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

      // Standard IDs (ask.html, listing.html)
      const $messages = byId("messages");
      const $input = byId("input") || byId("prompt"); // compat
      const $send = byId("send") || byId("submitBtn"); // compat
      const $reset = byId("reset");
      const $tips = byId("tips");
      const $form = byId("toolForm"); // optional compat if a tool uses a <form>

      if (!$messages || !$input || !$send) {
        console.error(
          "[PAWToolShell] Missing required DOM elements. Required: #messages and (#input or #prompt) and (#send or #submitBtn)."
        );
        return {
          sendMessage: async function () {},
          sendExtra: async function () {},
          reset: function () {},
        };
      }

      const history = [];
      let isSending = false;
      let disclaimerShown = false;

      function pushHistory(role, content) {
        history.push({ role, content: String(content || "") });
        while (history.length > 50) history.shift();
      }

      function getHistoryForSend() {
        const sliceStart = Math.max(0, history.length - sendHistoryItems);
        return history.slice(sliceStart);
      }

      function setPlaceholder(text) {
        try {
          if (text) $input.placeholder = String(text);
        } catch (e) {}
      }

      if (config.inputPlaceholder) setPlaceholder(config.inputPlaceholder);

      function clearComposer() {
        try {
          $input.value = "";
        } catch (e) {}
      }

      function maybeAppendDisclaimerOnce() {
        if (disclaimerShown) return;
        const disclaimer = getDisclaimerText();
        if (!disclaimer) return;
        appendMessage($messages, "ai", disclaimer);
        disclaimerShown = true;
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

          thinkingNode = makeThinkingNode($messages);

          const prefs = getPrefs();
          const extraPayload = getExtraPayload();

          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, extraPayload);

          const data = await postToWorker(payload);

          removeNode(thinkingNode);

          if (onResponse) {
            try {
              onResponse(data);
            } catch (e) {}
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage($messages, "ai", reply);
            pushHistory("assistant", reply);
            maybeAppendDisclaimerOnce();
          }
        } catch (err) {
          removeNode(thinkingNode);
          appendMessage($messages, "ai", "Something went wrong. Please try again.");
          console.error("[PAWToolShell] sendMessage error:", err);
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
          if (echoUser) {
            appendMessage($messages, "user", msg);
            pushHistory("user", msg);
          }

          thinkingNode = makeThinkingNode($messages);

          const prefs = getPrefs();
          const baseExtra = getExtraPayload();

          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, {
            ...baseExtra,
            ...extraPayload,
            instruction: msg,
          });

          const data = await postToWorker(payload);

          removeNode(thinkingNode);

          if (onResponse) {
            try {
              onResponse(data);
            } catch (e) {}
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage($messages, "ai", reply);
            pushHistory("assistant", reply);
            maybeAppendDisclaimerOnce();
          }
        } catch (err) {
          removeNode(thinkingNode);
          if (echoUser) appendMessage($messages, "ai", "Something went wrong. Please try again.");
          console.error("[PAWToolShell] sendExtra error:", err);
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

        disclaimerShown = false;
      }

      // -----------------------------
      // Wire UI events (standard)
      // -----------------------------
      $send.addEventListener("click", function () {
        sendMessage($input.value);
      });

      // Optional: tools may include a <form>; prevent default submit
      if ($form) {
        $form.addEventListener("submit", function (e) {
          e.preventDefault();
          sendMessage($input.value);
        });
      }

      // Enter behavior:
      // - Enter sends
      // - Shift+Enter inserts newline
      $input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage($input.value);
        }
      });

      if ($reset) {
        $reset.addEventListener("click", function () {
          reset();
        });
      }

      if ($tips && typeof config.tipsText === "string") {
        $tips.addEventListener("click", function () {
          alert(config.tipsText);
        });
      }

      return {
        sendMessage,
        sendExtra,
        reset,
      };
    },
  };
})();
