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

  function appendMessage($messages, role, text, meta) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = "<p>" + escapeHtml(text) + "</p>";
    wrap.appendChild(bubble);

    // PAW: "Bad response?" reporting link (AI messages only)
    // - Lives in the shared shell so it automatically applies to all tools.
    // - Captures a snapshot (user input + AI output + tool id/title + time) without extra user work.
    if (role !== "user") {
      try {
        attachBadResponseLink(bubble, {
          toolId: meta && meta.toolId,
          toolTitle: meta && meta.toolTitle,
          userMessage: meta && meta.userMessage,
          extraPayload: meta && meta.extraPayload,
          historyTail: meta && meta.historyTail,
          aiOutput: text,
          createdAt: (meta && meta.createdAt) || new Date().toISOString(),
          pageUrl: (meta && meta.pageUrl) || (typeof location !== "undefined" ? location.href : ""),
        });
      } catch (_) {}
    }

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


      // -------------------------
      // PAW: Ensure "Bad response?" link exists under every AI bubble.
      // Why: Some tools (or future tools) may re-render/rehydrate message DOM
      // without going through appendMessage(), or may overwrite bubble.innerHTML
      // after we attached the link. A MutationObserver makes this bulletproof.
      (function setupBadResponseObserver() {
        if (!$messages) return;

        function getLastUserBubbleText() {
          try {
            const userBubbles = $messages.querySelectorAll(".msg.user .bubble");
            if (!userBubbles || !userBubbles.length) return "";
            const last = userBubbles[userBubbles.length - 1];
            return safeText(last && last.textContent);
          } catch (_) {
            return "";
          }
        }

        function getAiBubbleText(bubble) {
          try {
            return safeText(bubble && bubble.textContent);
          } catch (_) {
            return "";
          }
        }

        function ensureLinks() {
          try {
            const aiBubbles = $messages.querySelectorAll(".msg.ai .bubble");
            if (!aiBubbles || !aiBubbles.length) return;

            const toolTitle = (typeof getDeliverableTitle === "function") ? getDeliverableTitle() : "";
            const historyTail = (typeof getHistoryForSend === "function") ? (function () {
              try {
                const h = getHistoryForSend();
                return Array.isArray(h) ? h.slice(-4) : [];
              } catch (_) { return []; }
            })() : [];

            aiBubbles.forEach(function (bubble) {
              // If link row already exists, do nothing.
              const hasRow = bubble && bubble.querySelector && bubble.querySelector(".paw-report-row");
              if (hasRow) return;

              attachBadResponseLink(bubble, {
                toolId: toolId,
                toolTitle: toolTitle,
                userMessage: getLastUserBubbleText(),
                historyTail: historyTail,
                aiOutput: getAiBubbleText(bubble),
                createdAt: new Date().toISOString(),
                pageUrl: (typeof location !== "undefined" ? location.href : ""),
              });
            });
          } catch (_) {}
        }

        // Run once on load in case messages were rendered before shell init.
        ensureLinks();

        // Observe new messages or DOM rewrites and re-ensure.
        try {
          const obs = new MutationObserver(function () {
            // Microtask batch: ensure after DOM settles.
            Promise.resolve().then(ensureLinks);
          });
          obs.observe($messages, { childList: true, subtree: true });
        } catch (_) {}
      })();




      // -------------------------
      // Global composer guardrails
      // -------------------------
      // Consistent PAW UX across all tools:
      // - If the input is empty, the PAW button is disabled and Enter does nothing (sendMessage() already no-ops).
      // - As soon as the user types, PAW becomes enabled.
      // NOTE: Tools that need "no-text actions" (e.g., Analyze after upload) should add a dedicated UI button
      //       rather than relying on empty-submit behavior.
      function ensureSendDisabledStyles() {
        if (window.__pawSendDisabledStyleInjected) return;
        window.__pawSendDisabledStyleInjected = true;
        try {
          const style = document.createElement("style");
          style.setAttribute("data-paw", "send-disabled");
          style.textContent = `
            /* Disabled PAW button state (applies to #send or #submitBtn across tools) */
            #send[disabled], #submitBtn[disabled]{
              opacity: .45 !important;
              cursor: not-allowed !important;
              pointer-events: none !important;
            }
          `;
          document.head.appendChild(style);
        } catch (_) {}
      }

      function updateSendEnabled() {
        try {
          if (!$send || !$input) return;
          ensureSendDisabledStyles();
          const hasText = !!safeText($input.value);
          // Prefer a real disabled attribute for consistent click/keyboard behavior.
          try { $send.disabled = !hasText; } catch (_) {}
          try { $send.setAttribute("aria-disabled", String(!hasText)); } catch (_) {}
        } catch (_) {}
      }
// Auto-grow: wire the main composer textarea (works for #input or #prompt)
if ($input) {
  // Run once on load (handles restored drafts/resume flows)
  autoGrowTextarea($input);
  updateSendEnabled();

  $input.addEventListener("input", function(){
    autoGrowTextarea($input);
    updateSendEnabled();
  });

  // Some browsers change layout after fonts load; one more pass is cheap.
  setTimeout(function(){ autoGrowTextarea($input); }, 0);
}

      const getPrefs = typeof config.getPrefs === "function" ? config.getPrefs : null;
      const getExtraPayload =
        typeof config.getExtraPayload === "function" ? config.getExtraPayload : null;
      const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

      // NEW: tool can gate sending (listing uses this for POI modal before write)
      const beforeSend =
        typeof config.beforeSend === "function" ? config.beforeSend : null;

      let lastDeliverableText = "";

      const deliverableMode = config.deliverableMode !== false; // default true
      const getDeliverableTitle =
        typeof config.deliverableTitle === "function"
          ? config.deliverableTitle
          : function () {
              return safeText(config.deliverableTitle || "Deliverable");
            };

      const inputPlaceholder = safeText(config.inputPlaceholder);
      if ($input && inputPlaceholder) $input.setAttribute("placeholder", inputPlaceholder);

      const sendHistoryItems =
        typeof config.sendHistoryItems === "number" ? config.sendHistoryItems : 10;
      const maxHistoryItems =
        typeof config.maxHistoryItems === "number" ? config.maxHistoryItems : 20;

      let history = [];
      let isSending = false;

      // ==========================================================
      // PAW Composer + Paw Submit Contract (LOCKED)
      // ----------------------------------------------------------
      // Goal:
      // - Every tool gets the same paw submit interaction.
      // - Click and Enter behave identically.
      //
      // Visual/behavior hooks (shared CSS in paw-ui.css):
      // - .send.paw-bump               (instant submit acknowledgement)
      // - aria-busy="true" + data-loading="1"  (working ring)
      //
      // Tool page contract:
      // - Submit button must be: <button id="send" class="send">
      // - Composer textarea must be: #input or #prompt
      // ==========================================================

      function pawSubmitBump(){
        try {
          if (!$send) return;
          $send.classList.remove("paw-bump");
          // Force reflow so repeated submits retrigger the animation
          void $send.offsetWidth;
          $send.classList.add("paw-bump");
          setTimeout(function(){ try{ $send.classList.remove("paw-bump"); }catch(_){ } }, 220);
        } catch (_) {}
      }

      function pawSetBusy(on){
        try {
          if (!$send) return;
          if (on) {
            $send.setAttribute("aria-busy", "true");
            $send.setAttribute("data-loading", "1");
          } else {
            $send.removeAttribute("aria-busy");
            $send.removeAttribute("data-loading");
          }
        } catch (_) {}
      }

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
        if ($input) {
            $input.value = "";
            // Auto-grow: return to baseline height when reset clears the composer
            try { resetAutoGrowTextarea($input); } catch (_) {}
            try { updateSendEnabled(); } catch (_) {}
   }
        // Auto-grow: return to baseline height when cleared
        resetAutoGrowTextarea($input);

        if ($input && opts.keepFocus) {
          try { $input.focus(); } catch (_) {}
        }
      }

// ==========================================================
// Auto-grow textarea (LOCKED)
// ----------------------------------------------------------
// Goal: ChatGPT-style expanding input across all tools.
// Contract:
// - CSS sets max-height and overflow-y:hidden by default.
// - JS expands height to fit content until max-height, then enables scroll.
// - Reset/clear returns textarea to its baseline height.
// ==========================================================
function autoGrowTextarea($ta){
  try{
    if(!$ta) return;
    // Reset to auto so scrollHeight reflects true content height
    $ta.style.height = "auto";

    // Max height from computed styles (falls back to 320px via CSS var)
    const cs = window.getComputedStyle($ta);
    const maxH = parseFloat(cs.maxHeight || "0") || 320;

    const next = Math.min($ta.scrollHeight, maxH);
    $ta.style.height = next + "px";

    // If we hit max height, allow scrolling within textarea
    if ($ta.scrollHeight > maxH + 1){
      $ta.style.overflowY = "auto";
    } else {
      $ta.style.overflowY = "hidden";
    }
  } catch(_){}
}

function resetAutoGrowTextarea($ta){
  try{
    if(!$ta) return;
    $ta.style.height = "";
    $ta.style.overflowY = "";
  }catch(_){}
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


      // ─────────────────────────────────────────────
      // Bad response reporting (shared across all tools)
      // ─────────────────────────────────────────────
      //
      // UX:
      // - A subtle "Bad response?" link is added under every AI message.
      // - Clicking opens a tiny modal: reason dropdown + optional note + Send.
      //
      // Data captured automatically (no extra user steps):
      // - user message (+ extra payload if tool supplies it)
      // - AI output shown
      // - tool id + tool title
      // - time + page URL
      //
      // Delivery:
      // - Frontend POSTs to Worker endpoint: /report-bad-response
      // - Worker emails the snapshot to joe@joinproagent.com

      function ensureBadResponseModal() {
        let modal = document.getElementById("pawBadResponseModal");
        if (modal) return modal;

        modal = document.createElement("div");
        modal.id = "pawBadResponseModal";
        modal.className = "modal paw-report-modal";
        modal.setAttribute("aria-hidden", "true");

        const card = document.createElement("div");
        card.className = "modal-card paw-report-card";
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-modal", "true");

        const head = document.createElement("div");
        head.className = "modal-head";
        head.innerHTML =
          '<div class="modal-title">Report a bad response</div>' +
          '<button type="button" class="modal-close" aria-label="Close">×</button>';

        const body = document.createElement("div");
        body.className = "modal-body";
        body.innerHTML =
          '<div class="field">' +
          '<label for="pawBadReason">What went wrong?</label>' +
          '<select id="pawBadReason">' +
          '<option value="wrong">Wrong / inaccurate</option>' +
          '<option value="generic">Generic / bland</option>' +
          '<option value="off-brand">Off-brand</option>' +
          '<option value="compliance">Compliance risk</option>' +
          '<option value="other">Other</option>' +
          "</select>" +
          "</div>" +
          '<div class="field">' +
          '<label for="pawBadNote">Optional note</label>' +
          '<textarea id="pawBadNote" rows="3" maxlength="500" placeholder="Short note (optional)"></textarea>' +
          "</div>" +
          '<div class="paw-report-actions">' +
          '<button type="button" class="btn" data-action="cancel">Cancel</button>' +
          '<button type="button" class="btn primary" data-action="send">Send</button>' +
          "</div>" +
          '<div class="paw-report-status" aria-live="polite"></div>';

        card.appendChild(head);
        card.appendChild(body);
        modal.appendChild(card);
        document.body.appendChild(modal);

        // close behavior
        const closeBtn = modal.querySelector(".modal-close");
        const cancelBtn = modal.querySelector('[data-action="cancel"]');

        function close() {
          modal.classList.remove("show");
          modal.setAttribute("aria-hidden", "true");
          try {
            const note = modal.querySelector("#pawBadNote");
            if (note) note.value = "";
            const status = modal.querySelector(".paw-report-status");
            if (status) status.textContent = "";
          } catch (_) {}
        }

        if (closeBtn) closeBtn.addEventListener("click", close);
        if (cancelBtn) cancelBtn.addEventListener("click", close);

        // click outside card closes
        modal.addEventListener("click", function (e) {
          try {
            if (e && e.target === modal) close();
          } catch (_) {}
        });

        // Esc closes
        document.addEventListener("keydown", function (e) {
          try {
            if (!modal.classList.contains("show")) return;
            if (e.key === "Escape") close();
          } catch (_) {}
        });

        // send behavior
        const sendBtn = modal.querySelector('[data-action="send"]');
        if (sendBtn) {
          sendBtn.addEventListener("click", async function () {
            const reasonEl = modal.querySelector("#pawBadReason");
            const noteEl = modal.querySelector("#pawBadNote");
            const statusEl = modal.querySelector(".paw-report-status");
            const snapshot = modal.__pawSnapshot || null;

            if (!snapshot) {
              if (statusEl) statusEl.textContent = "Nothing to report.";
              return;
            }

            const reason = safeText(reasonEl && reasonEl.value) || "other";
            const note = safeText(noteEl && noteEl.value) || "";

            try {
              if (statusEl) statusEl.textContent = "Sending…";

              const token = getCSRFTokenFromMeta();
              const baseUrl = getPostUrl();
              const url = baseUrl.replace(/\/+$/, "") + "/report-bad-response";

              await postJSON(
                url,
                {
                  kind: "bad_response_report",
                  reason,
                  note,
                  snapshot,
                },
                token
              );

              if (statusEl) statusEl.textContent = "Sent. Thank you!";
              setTimeout(function () {
                try {
                  close();
                } catch (_) {}
              }, 700);
            } catch (err) {
              if (statusEl) {
                statusEl.textContent =
                  "Could not send right now. Please try again.";
              }
            }
          });
        }

        return modal;
      }

      function openBadResponseModal(snapshot) {
        const modal = ensureBadResponseModal();
        modal.__pawSnapshot = snapshot || null;

        try {
          const status = modal.querySelector(".paw-report-status");
          if (status) status.textContent = "";
        } catch (_) {}

        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
      }

      function attachBadResponseLink(messageWrap, snapshot) {
        if (!messageWrap) return;

        // Avoid duplicates if a tool re-renders.
        // IMPORTANT: Some tools may overwrite bubble.innerHTML after we attach.
        // In that case the DOM row disappears but the flag remains, so we must
        // re-check the DOM rather than relying on the flag alone.
        try {
          const existing = messageWrap.querySelector && messageWrap.querySelector(".paw-report-row");
          if (existing) {
            messageWrap.__pawHasBadLink = true;
            return;
          }
          // If the flag is set but the DOM row is missing, allow re-injection.
          if (messageWrap.__pawHasBadLink && !existing) {
            messageWrap.__pawHasBadLink = false;
          }
        } catch (_) {}

        if (messageWrap.__pawHasBadLink) return;
        messageWrap.__pawHasBadLink = true;

        // Store snapshot on the message node (keeps the "exact moment" tied to the UI).
        messageWrap.__pawBadSnapshot = snapshot || null;

        const row = document.createElement("div");
        row.className = "paw-report-row";
        // Inline styles as a safety net so the link is visible even if a page forgets to include
        // the global CSS updates. (We still prefer CSS, but this prevents "it does nothing" bugs.)
        row.style.marginTop = "6px";
        row.style.textAlign = "right";
        row.style.fontSize = "12px";

        const a = document.createElement("a");
        a.href = "#";
        a.className = "paw-report-link";
        a.style.textDecoration = "none";
        a.style.opacity = "0.75";
        a.textContent = "Bad response?";

        a.addEventListener("click", function (e) {
          try { e.preventDefault(); } catch (_) {}
          const snap = messageWrap.__pawBadSnapshot || snapshot || null;
          openBadResponseModal(snap);
        });

        row.appendChild(a);
        messageWrap.appendChild(row);
      }

      function hideDeliverableModal() {
        const modal = document.getElementById("pawDeliverableModal");
        if (!modal) return;
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
      }

      function renderDeliverable(replyText, reportMeta) {
        // Always render in-flow for a clean chat experience.
        appendMessage($messages, "ai", replyText, reportMeta);

        // Remember the last deliverable so the user can re-open/copy it again.
        lastDeliverableText = String(replyText || "");

        if (!deliverableMode) return;

        // Open a modal with Copy / Revise every time for deliverables.
        showDeliverableModal(getDeliverableTitle(), replyText);

        // UX: allow users to click the most recent AI message to re-open the modal.
        // This solves the common case: they closed the modal, then want to copy again.
        try {
          const aiBubbles = $messages.querySelectorAll(".msg.ai");
          const last = aiBubbles[aiBubbles.length - 1];
          if (last) {
            last.style.cursor = "pointer";
            last.title = "Click to re-open and copy";
            last.onclick = function () {
              showDeliverableModal(getDeliverableTitle(), lastDeliverableText);
            };
          }
        } catch (_) {}

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

        // Brand feedback: instant acknowledgement + working ring (click or Enter)
        pawSubmitBump();
        pawSetBusy(true);


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
            renderDeliverable(reply, {
              toolId: toolId,
              toolTitle: getDeliverableTitle(),
              userMessage: trimmed,
              extraPayload: extraPayload,
              historyTail: (function () {
                try {
                  const h = getHistoryForSend();
                  return Array.isArray(h) ? h.slice(-4) : [];
                } catch (_) {
                  return [];
                }
              })(),
              createdAt: new Date().toISOString(),
              pageUrl: (typeof location !== "undefined" ? location.href : ""),
            });
            pushHistory("assistant", reply);
          }
          return data;
        } catch (err) {
          removeNode(thinkingNode);
          appendMessage($messages, "ai", "Error: " + String(err && err.message ? err.message : err));
        } finally {
          isSending = false;
          pawSetBusy(false);
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

        // Brand feedback: instant acknowledgement + working ring (click or Enter)
        pawSubmitBump();
        pawSetBusy(true);

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
            renderDeliverable(reply, {
              toolId: toolId,
              toolTitle: getDeliverableTitle(),
              userMessage: trimmed,
              extraPayload: extraPayload,
              historyTail: (function () {
                try {
                  const h = getHistoryForSend();
                  return Array.isArray(h) ? h.slice(-4) : [];
                } catch (_) {
                  return [];
                }
              })(),
              createdAt: new Date().toISOString(),
              pageUrl: (typeof location !== "undefined" ? location.href : ""),
            });
            pushHistory("assistant", reply);
          }
        } catch (err) {
          removeNode(thinkingNode);
          appendMessage($messages, "ai", "Error: " + String(err && err.message ? err.message : err));
        } finally {
          isSending = false;
          pawSetBusy(false);
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

          if ($input) {
            $input.value = typeof st.input === "string" ? st.input : "";
            // Auto-grow: re-measure after restore so height matches restored content
            try {
              if ($input.value) autoGrowTextarea($input);
              else resetAutoGrowTextarea($input);
            } catch (_) {}
          }

          // Ensure we're not showing "Working..." after a restore.
          try { hideWorkingBar(); } catch (_) {}

          return true;
        } catch (_) {
          return false;
        }
      }
return { sendMessage, sendExtra, reset, getState, setState, toast: showToast };
    },
  };
})();