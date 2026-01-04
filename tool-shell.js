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
      // Cross-origin iframe safety: assume embed.
      document.documentElement.setAttribute("data-embed", "1");
    }
  })();

  // -----------------------------
  // Helpers
  // -----------------------------
  function byId(id) {
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

  function removeNode(node) {
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

  function getAuthToken() {
    try {
      return localStorage.getItem("paw_token") || "";
    } catch (e) {
      return "";
    }
  }

  // -----------------------------
  // Public API: window.PAWToolShell.init(...)
  // -----------------------------
  window.PAWToolShell = {
    init: function init(config) {
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

      const onResponse =
        typeof config.onResponse === "function" ? config.onResponse : null;

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

      function pushHistory(role, content) {
        history.push({ role, content });
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
          const historyToSend = history.slice(
            Math.max(0, history.length - sendHistoryItems)
          );

          const extra = getExtraPayload(trimmed) || {};
          const payload = Object.assign(
            { tool: toolId, message: trimmed, prefs, history: historyToSend },
            extra || {}
          );

          const data = await postToWorker(payload);

          removeNode(thinkingNode);
          thinkingNode = null;

          if (onResponse) {
            const handled = onResponse(data);
            if (handled && handled.skipDefault) {
              return;
            }
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage($messages, "ai", reply);
            pushHistory("assistant", reply);
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

          thinkingNode = appendThinking($messages);

          const prefs = getPrefs() || {};
          const historyToSend = history.slice(
            Math.max(0, history.length - sendHistoryItems)
          );

          // CRITICAL: allow tool pages to expand special instruction tokens via getExtraPayload()
          // listing.html relies on this for background highlight requests that trigger the POI modal.
          const extraFromHook = getExtraPayload(msg) || {};

          const payload = Object.assign(
            { tool: toolId, message: msg, prefs, history: historyToSend },
            extraFromHook,
            extraPayload || {}
          );

          const data = await postToWorker(payload);

          removeNode(thinkingNode);
          thinkingNode = null;

          if (onResponse) {
            const handled = onResponse(data);
            if (handled && handled.skipDefault) {
              return;
            }
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage($messages, "ai", reply);
            pushHistory("assistant", reply);
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

        const disclaimer = getDisclaimerText();
        if (disclaimer) {
          appendMessage($messages, "ai", disclaimer);
        }
      }

      // -----------------------------
      // Wire UI events (standard)
      // -----------------------------
      $send.addEventListener("click", function () {
        sendMessage($input.value);
      });

      // Prefer form submit if present (some tools might wrap input in a form)
      if ($form) {
        $form.addEventListener("submit", function (e) {
          e.preventDefault();
          sendMessage($input.value);
        });
      }

      // Standard behavior:
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

      if ($tips) {
        $tips.addEventListener("click", function () {
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
    },
  };
})();
