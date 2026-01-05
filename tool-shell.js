/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools.
 *
 * HARD CONTRACT (standard for tools):
 * - DOM: #messages, #input, #send, #reset, #tips
 * - API: window.PAWToolShell.init(config) -> returns { sendMessage, sendExtra, reset }
 *
 * IMPORTANT:
 * - Do NOT put prompting logic here — Worker only.
 * - Tool pages provide hooks: getPrefs, getExtraPayload, onResponse, beforeSend(optional).
 */

(function () {
  "use strict";

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

  function getCSRFTokenFromMeta() {
    const el = document.querySelector('meta[name="csrf-token"]');
    return el ? String(el.getAttribute("content") || "").trim() : "";
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

      // NEW: optional pre-send hook (used by listing.html to gate POIs before writing)
      const beforeSend = typeof config.beforeSend === "function" ? config.beforeSend : null;

      const deliverableMode = config.deliverableMode !== false; // default true
      const deliverableTitle = safeText(config.deliverableTitle || "Deliverable");

      const inputPlaceholder = safeText(config.inputPlaceholder);
      if ($input && inputPlaceholder) $input.setAttribute("placeholder", inputPlaceholder);

      const sendHistoryItems =
        typeof config.sendHistoryItems === "number" ? config.sendHistoryItems : 10;
      const maxHistoryItems =
        typeof config.maxHistoryItems === "number" ? config.maxHistoryItems : 20;

      const enableDisclaimer = !!config.enableDisclaimer;
      const disclaimerTrigger = config.disclaimerTrigger || null;
      const getDisclaimerText =
        typeof config.getDisclaimerText === "function" ? config.getDisclaimerText : null;

      let disclaimerShown = false;
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
          try {
            $input.focus();
          } catch (_) {}
        }
      }

      function maybeAppendDisclaimerOnce() {
        if (disclaimerShown) return;
        if (!getDisclaimerText) return;
        const txt = safeText(getDisclaimerText());
        if (!txt) return;
        disclaimerShown = true;
        appendMessage($messages, "ai", txt);
      }

      function getPostUrl() {
        // IMPORTANT FIX:
        // Your Worker is deployed at the root:
        //   https://paw-api.joe-b40.workers.dev
        // So do NOT append "/api".
        return apiEndpoint.replace(/\/+$/, "");
      }

      async function postToWorker(payload) {
        const token = getCSRFTokenFromMeta();
        const url = getPostUrl();
        return await postJSON(url, payload, token);
      }

      function renderDeliverable(replyText) {
        if (!deliverableMode) {
          appendMessage($messages, "ai", replyText);
          return;
        }

        let card = document.querySelector(".deliverable");
        if (!card) {
          card = document.createElement("div");
          card.className = "deliverable";
          card.innerHTML =
            '<div class="deliverable-card">' +
            '  <div class="deliverable-head">' +
            '    <div class="deliverable-title"></div>' +
            '    <div class="deliverable-actions">' +
            '      <button class="btn" type="button" data-action="copy">Copy</button>' +
            "    </div>" +
            "  </div>" +
            '  <div class="deliverable-body">' +
            '    <div class="deliverable-text"></div>' +
            "  </div>" +
            "</div>";
          $messages.appendChild(card);

          const copyBtn = card.querySelector('[data-action="copy"]');
          if (copyBtn) {
            copyBtn.addEventListener("click", async function () {
              const txt = card.querySelector(".deliverable-text")?.textContent || "";
              try {
                await navigator.clipboard.writeText(txt);
                showToast("Copied");
              } catch (_) {
                showToast("Copy failed");
              }
            });
          }
        }

        const titleEl = card.querySelector(".deliverable-title");
        const bodyEl = card.querySelector(".deliverable-text");

        if (titleEl) titleEl.textContent = deliverableTitle;
        if (bodyEl) bodyEl.textContent = replyText;

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

        try {
          if (echoUser) {
            appendMessage($messages, "user", msg);
            pushHistory("user", msg);
          }

          thinkingNode = appendThinking($messages);

          // Allow tool to inject extra payload
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

        // NEW: allow tools to intercept submits (e.g., POI modal gating)
        if (beforeSend) {
          try {
            const res = await beforeSend(trimmed, { sendExtra, clearComposer });
            if (res && res.cancel === true) return;
          } catch (_) {
            // If hook fails, continue normal send.
          }
        }

        isSending = true;
        let thinkingNode = null;

        try {
          appendMessage($messages, "user", trimmed);
          pushHistory("user", trimmed);

          clearComposer({ keepFocus: true });

          if (enableDisclaimer && disclaimerTrigger && disclaimerTrigger.test(trimmed)) {
            maybeAppendDisclaimerOnce();
          }

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
        }
      }

      function reset() {
        try {
          history = [];
          disclaimerShown = false;
          if ($messages) $messages.innerHTML = "";
          if ($input) $input.value = "";
        } catch (_) {}
      }

      // Wire UI events
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
