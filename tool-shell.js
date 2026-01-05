/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools.
 *
 * IMPORTANT:
 * - Prompting stays in the Worker.
 * - This file only handles UI wiring + API calls.
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

  
  // Tips modal (shared)
  // We intentionally use an in-page modal instead of window.alert()
  // so Circle embeds feel native and consistent across tools.
  function ensureTipsModal() {
    let modal = document.getElementById("pawTipsModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "pawTipsModal";
    modal.className = "modal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML =
      '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pawTipsTitle">' +
        '<div class="modal-head">' +
          '<div id="pawTipsTitle" class="modal-title">Tips &amp; How To</div>' +
          '<button class="modal-close" type="button" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="modal-body"><div class="paw-tips-text"></div></div>' +
      '</div>';

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) closeBtn.addEventListener("click", () => hideTipsModal());
    modal.addEventListener("click", (e) => { if (e.target === modal) hideTipsModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTipsModal(); });

    return modal;
  }

  function showTipsModal(text) {
    const modal = ensureTipsModal();
    const body = modal.querySelector(".paw-tips-text");
    if (body) body.textContent = String(text || "");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function hideTipsModal() {
    const modal = document.getElementById("pawTipsModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  // Compliance note (optional): show once per session, only when trigger words appear.
  function shouldShowComplianceNote(cfg, userText, toolKey) {
    try {
      if (!cfg || !cfg.complianceNoteText) return false;
      if (!cfg.complianceTrigger) return false;

      const key = "paw_compliance_shown_" + String(toolKey || "default");
      if (sessionStorage.getItem(key) === "1") return false;

      const re = cfg.complianceTrigger;
      if (re && re.test && re.test(String(userText || ""))) return true;
    } catch (_) {}
    return false;
  }

  function markComplianceShown(toolKey) {
    try {
      const key = "paw_compliance_shown_" + String(toolKey || "default");
      sessionStorage.setItem(key, "1");
    } catch (_) {}
  }

  function showComplianceNoteOnce($messages, cfg, toolKey) {
    try {
      if (!cfg || !cfg.complianceNoteText) return;
      appendMessage($messages, "ai", String(cfg.complianceNoteText));
      markComplianceShown(toolKey);
    } catch (_) {}
  }

function coerceEmbedMode(config) {
    try {
      const qp = new URLSearchParams(location.search);
      const embed = qp.get("embed");
      const inFrame = window.self !== window.top;

      // Embed mode styling:
      // - If we're framed OR ?embed=1 is present, remove outer padding/borders
      if (embed === "1" || inFrame) {
        document.documentElement.setAttribute("data-embed", "1");
      }

      // Light public gating (per product requirement):
      // - These tool pages are intended to be embedded inside Circle.
      // - If opened directly (top-level) without ?embed=1 and without a Circle referrer,
      //   redirect to the marketing site.
      //
      // NOTE: Referrer can be blank in some privacy contexts. We DO NOT block iframe embeds.
      const allowDirect =
        embed === "1" ||
        inFrame ||
        (document.referrer && /circle\.so/i.test(document.referrer));

      if (!allowDirect) {
        // Keep it lightweight and immediate.
        window.location.replace("https://www.proagentworks.com");
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
      coerceEmbedMode(config);

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
      // Tracks the most recent user text sent to the Worker (used for one-time compliance note triggers)
      let lastUserText = "";

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

          lastUserText = trimmed;


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
            // Show compliance note only once per session (per tool), only when trigger words appear.
            // This is intentionally non-blocking: it does not change the Worker prompt or output.
            if (shouldShowComplianceNote(config, lastUserText, toolId || "tool")) {
              showComplianceNoteOnce($messages, config, toolId || "tool");
            }
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

        // NEW: allow tool to gate sending
        if (beforeSend) {
          try {
            const res = await beforeSend(trimmed, { sendExtra, clearComposer });
            if (res && res.cancel === true) return;
          } catch (_) {}
        }

        isSending = true;
        let thinkingNode = null;

        try {
          appendMessage($messages, "user", trimmed);
          pushHistory("user", trimmed);

          clearComposer({ keepFocus: true });

          thinkingNode = appendThinking($messages);

          lastUserText = trimmed;


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
          if ($messages) $messages.innerHTML = "";
          if ($input) $input.value = "";
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
          showTipsModal(config.tipsText);
        });
      }

      return { sendMessage, sendExtra, reset };
    },
  };
})();