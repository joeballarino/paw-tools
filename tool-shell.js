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

  function appendThinking($messages) {
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
    $messages.appendChild(wrap);
    $messages.scrollTop = $messages.scrollHeight;
    return wrap;
  }

  function getEl(id) {
    return document.getElementById(id);
  }

  function pickFirst(...els) {
    for (const el of els) {
      if (el) return el;
    }
    return null;
  }

  function getCSRFTokenFromMeta() {
    try {
      const el = document.querySelector('meta[name="paw-csrf-token"]');
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

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { reply: text };
    }

    if (!res.ok) {
      const msg =
        (data && (data.error || data.message)) ||
        "Request failed (" + res.status + ")";
      throw new Error(msg);
    }

    return data;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function buildPayloadBase(toolId, history, prefs, extra) {
    const payload = {
      toolId,
      history,
      prefs,
    };
    if (extra && typeof extra === "object") payload.extra = extra;
    return payload;
  }

  window.PAWToolShell = {
    init: function (config) {
      config = config || {};

      // -------------------------------------------------
      // Embed mode (Circle / iframe-safe)
      // -------------------------------------------------
      // WHY THIS LIVES HERE (shared shell):
      // - Tool pages always include the same outer wrappers: .app > .frame > .panel.
      // - In Circle (and other embeds), the host already provides padding/containers.
      // - When both host + tool apply borders/shadows/padding, you see "double boxes".
      //
      // Contract:
      // - paw-ui.css has an embed-only ruleset keyed off: html[data-embed="1"] ...
      // - This shell is responsible for setting that attribute deterministically so
      //   embeds stay clean and this bug doesn't keep coming back.
      //
      // Override:
      // - Append ?embed=1 to force embed styling
      // - Or pass { embedMode: true/false } in init(config)
      (function setEmbedMode() {
        let forced = null;
        if (typeof config.embedMode === "boolean") forced = config.embedMode;

        let isEmbed = false;
        if (forced !== null) {
          isEmbed = forced;
        } else {
          try {
            const qs = new URLSearchParams(window.location.search || "");
            const q = (qs.get("embed") || "").toLowerCase();
            if (q === "1" || q === "true" || q === "yes") isEmbed = true;

            // Auto-detect iframe embedding (Circle, etc.)
            if (!isEmbed) {
              try {
                isEmbed = window.self !== window.top;
              } catch (e) {
                isEmbed = true;
              }
            }
          } catch (e) {}
        }

        if (isEmbed) {
          try {
            document.documentElement.setAttribute("data-embed", "1");
          } catch (e) {}
        } else {
          // Allow tools site to remain styled normally.
          try {
            document.documentElement.removeAttribute("data-embed");
          } catch (e) {}
        }
      })();

      const toolId = String(config.toolId || "");
      const apiEndpoint = String(config.apiEndpoint || "");
      const sendHistoryItems = clamp(Number(config.sendHistoryItems || 10), 0, 50);
      const maxHistoryItems = clamp(Number(config.maxHistoryItems || 20), 0, 100);

      const getPrefs =
        typeof config.getPrefs === "function" ? config.getPrefs : null;
      const getExtraPayload =
        typeof config.getExtraPayload === "function" ? config.getExtraPayload : null;
      const onResponse =
        typeof config.onResponse === "function" ? config.onResponse : null;

      const enableDisclaimer = !!config.enableDisclaimer;
      const disclaimerTrigger =
        config.disclaimerTrigger instanceof RegExp ? config.disclaimerTrigger : null;
      const getDisclaimerText =
        typeof config.getDisclaimerText === "function" ? config.getDisclaimerText : () => "";

      const deliverableMode = !!config.deliverableMode;

      // Standard IDs
      const $messages = getEl("messages");
      const $input = getEl("input");
      const $send = getEl("send");
      const $reset = getEl("reset");
      const $tips = getEl("tips");

      // Backward/forward compat IDs (optional)
      const $prompt = getEl("prompt");
      const $submitBtn = getEl("submitBtn");
      const $form = pickFirst(getEl("toolForm"), document.querySelector("form"));

      const inputEl = pickFirst($input, $prompt);
      const sendBtnEl = pickFirst($send, $submitBtn);

      if (!$messages || !inputEl || !sendBtnEl) {
        console.warn(
          "[PAWToolShell] Missing required DOM elements. Need #messages + #input/#prompt + #send/#submitBtn."
        );
      }

      const history = [];
      let isSending = false;
      let disclaimerShown = false;

      function pushHistory(role, content) {
        history.push({ role, content });
        while (history.length > maxHistoryItems) history.shift();
      }

      function getHistoryForSend() {
        if (sendHistoryItems <= 0) return [];
        return history.slice(-sendHistoryItems);
      }

      function setPlaceholder(txt) {
        try {
          inputEl.setAttribute("placeholder", txt || "");
        } catch (e) {}
      }

      if (typeof config.inputPlaceholder === "string" && config.inputPlaceholder) {
        setPlaceholder(config.inputPlaceholder);
      }

      function clearComposer({ keepFocus = true } = {}) {
        try {
          inputEl.value = "";
          // Keep composer height sane if a tool adds autosize behavior.
          inputEl.style.height = "";
          if (keepFocus) inputEl.focus();
        } catch (e) {}
      }

      function maybeAppendDisclaimerOnce() {
        if (!enableDisclaimer) return;
        if (disclaimerShown) return;
        const disclaimer = getDisclaimerText();
        if (!disclaimer) return;
        appendMessage($messages, "ai", disclaimer);
        disclaimerShown = true;
      }

      async function postToWorker(payload) {
        const token = getCSRFTokenFromMeta();
        const url = apiEndpoint.replace(/\/+$/, "") + "/api";
        return await postJSON(url, payload, token);
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

          // UX: clear input immediately after a successful submit so messages don't stick.
          clearComposer({ keepFocus: true });

          // Optional: show disclaimer if they trigger certain keywords in the ask tool
          if (enableDisclaimer && disclaimerTrigger && disclaimerTrigger.test(trimmed)) {
            maybeAppendDisclaimerOnce();
          }

          thinkingNode = appendThinking($messages);

          const prefs = getPrefs ? getPrefs() : {};
          const extraPayload = getExtraPayload ? getExtraPayload(trimmed) : {};

          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, extraPayload);

          const data = await postToWorker(payload);

          removeNode(thinkingNode);

          if (onResponse) {
            try {
              const result = onResponse(data);
              if (result && result.skipDefault) return;
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

        const echoUser = options.echoUser !== false;

        isSending = true;
        let thinkingNode = null;

        try {
          if (echoUser) {
            appendMessage($messages, "user", msg);
            pushHistory("user", msg);
          }

          thinkingNode = appendThinking($messages);

          const prefs = getPrefs ? getPrefs() : {};
          // IMPORTANT: sendExtra MUST still flow through getExtraPayload() (listing highlights relies on it)
          const extraFromHook = getExtraPayload ? getExtraPayload(msg) : {};
          const mergedExtra = Object.assign({}, extraFromHook || {}, extraPayload || {});
          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, mergedExtra);

          const data = await postToWorker(payload);

          removeNode(thinkingNode);

          if (onResponse) {
            try {
              const result = onResponse(data);
              if (result && result.skipDefault) return data;
            } catch (e) {}
          }

          const reply = data && typeof data.reply === "string" ? data.reply : "";
          if (reply) {
            appendMessage($messages, "ai", reply);
            pushHistory("assistant", reply);
            maybeAppendDisclaimerOnce();
          }

          return data;
        } catch (err) {
          removeNode(thinkingNode);
          appendMessage($messages, "ai", "Something went wrong. Please try again.");
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
        clearComposer({ keepFocus: true });
        disclaimerShown = false;
      }

      // -----------------------------
      // Wire UI events (standard)
      // -----------------------------
      sendBtnEl.addEventListener("click", function () {
        sendMessage(inputEl.value);
      });

      // Optional: tools may include a <form>; prevent default submit
      if ($form) {
        $form.addEventListener("submit", function (e) {
          try {
            e.preventDefault();
          } catch (x) {}
          sendMessage(inputEl.value);
        });
      }

      // Enter behavior:
      // - Enter sends
      // - Shift+Enter inserts newline
      inputEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage(inputEl.value);
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
