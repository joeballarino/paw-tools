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

  // ─────────────────────────────────────────────
  // Mobile/compact detection (UI only)
  // ─────────────────────────────────────────────
  // WHY:
  // - Some embed contexts (e.g., certain Circle iframe layouts) can report a
  //   viewport width that prevents our CSS max-width media queries from firing,
  //   even though the user is on a phone.
  // - The Work status line ("Ready" / "Select a work") must be centered on
  //   mobile. We therefore add a lightweight "paw-compact" class that CSS can
  //   rely on in addition to media queries.
  //
  // SAFETY:
  // - This is presentation-only. No data is stored. No behavior changes.
  function applyCompactClass() {
    try {
      const ua = navigator.userAgent || "";
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
      const mqMobile = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
      const compact = !!(uaMobile || mqMobile);
      document.documentElement.classList.toggle("paw-compact", compact);
    } catch (_) {}
  }

  applyCompactClass();
  try {
    window.addEventListener("resize", applyCompactClass, { passive: true });
    window.addEventListener("orientationchange", applyCompactClass, { passive: true });
  } catch (_) {}


  // ─────────────────────────────────────────────
  // Phase 3 — Circle Identity + PAW Session Token
  // ─────────────────────────────────────────────
  // Product intent:
  // - Circle remains the identity source of truth (no extra login).
  // - Tools request identity from the parent (Circle) via postMessage.
  // - The Worker mints a short-lived signed token, used for My Stuff persistence
  //   (and later, usage limits).
  //
  // Privacy intent:
  // - Token is kept in memory only (not localStorage).
  //
  // IMPORTANT:
  // - This is a minimal bridge. Without Circle-side signing, the Worker cannot
  //   cryptographically prove the user_id came from Circle. We mitigate by:
  //     (a) only requesting identity when embedded,
  //     (b) requiring a signed Worker token for all persistence,
  //     (c) short token lifetimes.
  // - If Circle provides a verifiable JWT in the future, we should validate it
  //   in /auth/mint and eliminate spoofing risk.
  // Circle can run on its native *.circle.so domain or on a custom domain.
  // We keep a strict allowlist for the parent (host page) origin to prevent
  // accepting identity messages from arbitrary sites.
  const PAW_CIRCLE_ORIGIN = "https://proagentworks.circle.so";
  const PAW_ALLOWED_PARENT_ORIGINS = [
    PAW_CIRCLE_ORIGIN,
    "https://www.proagentworks.com",
    "https://proagentworks.com"
  ];
  const PAW_IDENTITY_MSG = "paw_identity_v1";
  const PAW_IDENTITY_REQ = "paw_identity_request_v1";

  const PAWAuth = (function () {
    let _apiEndpoint = "";
    let _memberId = "";
    let _token = "";
    let _exp = 0;

    let _readyPromise = null;
    let _readyResolve = null;

    function isInIframe() {
      try { return window.self !== window.top; } catch (e) { return true; }
    }

    function whenReady() {
      if (!_readyPromise) {
        _readyPromise = new Promise((resolve) => { _readyResolve = resolve; });
      }
      return _readyPromise;
    }

    function getToken() { return _token || ""; }
    function getMemberId() { return _memberId || ""; }
    function getMeta() { return { memberId: getMemberId(), exp: _exp || 0 }; }

    async function mintToken(memberId) {
      const url = String(_apiEndpoint || "").replace(/\/+$/,"") + "/auth/mint";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: String(memberId || "").trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data && (data.error || data.message || data.reply) ? (data.error || data.message || data.reply) : "Auth failed";
        throw new Error(msg);
      }
      _token = String(data.token || "");
      _exp = Number(data.exp || 0) || 0;
    }

    function requestIdentityFromParent() {
      // Parent (Circle) must respond with:
      //   window.postMessage({ type: PAW_IDENTITY_MSG, member_id: "<id>" }, "*")
      // ...from origin https://proagentworks.circle.so
      try {
        if (!isInIframe()) return;
        window.parent.postMessage({ type: PAW_IDENTITY_REQ }, "*");
      } catch (_) {}
    }

    function listenForIdentity() {
      window.addEventListener("message", async (event) => {
        try {
          const data = event && event.data ? event.data : null;
          if (!data || typeof data !== "object") return;
          if (data.type !== PAW_IDENTITY_MSG) return;

          // Origin hard check (Circle native + custom domain allowlist)
          if (!PAW_ALLOWED_PARENT_ORIGINS.includes(String(event.origin || ""))) return;

          const memberId = String(data.member_id || data.memberId || "").trim();
          if (!memberId) return;

          // Only set once (do not thrash token)
          if (_memberId && _memberId === memberId && _token) return;

          _memberId = memberId;

          if (_apiEndpoint) {
            try { await mintToken(_memberId); } catch (_) {}
          }

          try { if (_readyResolve) _readyResolve(getMeta()); } catch (_) {}
        } catch (_) {}
      });
    }

    // Attach listener immediately (so we don't miss early messages)
    listenForIdentity();

    async function init(apiEndpoint) {
      if (apiEndpoint) _apiEndpoint = String(apiEndpoint || "");
      whenReady(); // ensure promise exists

      // Only run handshake when embedded in Circle (or any iframe).
      if (isInIframe()) requestIdentityFromParent();

      // If we already have member_id but no token yet, mint.
      if (_memberId && _apiEndpoint && !_token) {
        try { await mintToken(_memberId); } catch (_) {}
      }

      // If not embedded, resolve with empty meta (tools will remain read-only).
      if (!isInIframe()) {
        try { if (_readyResolve) _readyResolve(getMeta()); } catch (_) {}
      }

      return whenReady();
    }

    return { init, whenReady, getToken, getMemberId, getMeta };
  })();



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

    // PAW: "Give feedback" link (AI messages only)
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

  // ==========================================================
  // Works icon: one-time "hello" animation (UI only)
  // ----------------------------------------------------------
  // Product intent:
  // - Subtle brand "I'm here" moment when the tool loads.
  // - Runs ONCE per page load (never repeats on hover/state).
  // - Safe no-op if the Works control isn't present on a page.
  // ==========================================================
  function helloWorksIconOnce(){
    try{
      var btn = document.getElementById("pawMyStuffBtn") || document.querySelector("button.paw-mystuff-btn, a.paw-mystuff-btn");
      if(!btn) return;

      // Prevent double-run if init() is called more than once.
      if(btn.getAttribute("data-works-hello") === "1") return;
      btn.setAttribute("data-works-hello","1");

      var icon = btn.querySelector(".works-paw");
      if(!icon) return;

      // Delay slightly so it isn't lost during initial render.
      setTimeout(function(){
        try{
          icon.classList.add("paw-hello");
          // Remove after animation so future layout changes don't retrigger.
          setTimeout(function(){ try{ icon.classList.remove("paw-hello"); }catch(_){} }, 1400);
        }catch(_){}
      }, 450);
    }catch(_){}
  }


  async function postJSON(url, payload, csrfToken) {
    const headers = { "Content-Type": "application/json" };
    try {
      const t = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : "";
      if (t) headers["Authorization"] = "Bearer " + t;
    } catch (_) {}
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

    // Session context (My Works) — sent for future prompting, but does not imply persistence.
    try {
      if (window.__PAWWorks && window.__PAWWorks.getActiveWork) {
        const aw = window.__PAWWorks.getActiveWork();
        if (aw) payload.active_work = aw;
      }
    } catch (_) {}

    if (extraPayload && typeof extraPayload === "object") {
      for (const k in extraPayload) payload[k] = extraPayload[k];
    }

    return payload;
  }

  window.PAWAuth = PAWAuth;

  window.PAWToolShell = {
    // Auth-only init for pages that don't use the chat shell (e.g., My Stuff).
    authInit: function (apiEndpoint) {
      return PAWAuth.init(apiEndpoint);
    },
    init: function (config) {
      config = config || {};
      window.PAWToolShell._config = config || {};
      window.PAWToolShell._toast = showToast;

      // Ensure embed mode when framed (fixes “double container” look)
      coerceEmbedMode();

      // One-time Works icon intro (subtle brand hello)
      helloWorksIconOnce();

      // My Works drawer + session context (Phase 1)

      const apiEndpoint = safeText(config.apiEndpoint);
      try { if (window.__PAWWorks && window.__PAWWorks.init) window.__PAWWorks.init(apiEndpoint || ""); } catch (_) {}
      const toolId = safeText(config.toolId);

      // Phase 3: initialize Circle identity + token minting (in-memory only)
      try { PAWAuth.init(apiEndpoint); } catch (_) {}

      const $messages = $("messages");
      const $input = $("input") || $("prompt");
      const $send = $("send") || $("submitBtn");
      const $reset = $("reset");
      const $tips = $("tips");
      const $toolForm = $("toolForm");


      // -------------------------
      // PAW: Ensure "Give feedback" link exists under every AI bubble.
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
// Layout ping for Circle iframe auto-height (LOCKED)
// ----------------------------------------------------------
// Problem:
// - Tool pages include an iframe height reporter that relies on DOM MutationObserver
//   (childList/characterData) to know when to re-measure.
// - Textarea auto-grow changes layout styles, but does NOT mutate the DOM.
// Result:
// - The textarea may technically resize, but the parent iframe height won't update,
//   making it appear "stuck" in Circle.
// Solution:
// - Maintain a tiny hidden "ping" node in <body> and update its textContent whenever
//   we change layout (e.g., textarea height). This triggers the MutationObserver and
//   causes the existing reporter to re-measure.
//
// Notes:
// - This is intentionally lightweight and throttled to rAF.
// - No tool-specific code; works everywhere tool-shell.js runs.
// ==========================================================
let __pawLayoutPingEl = null;
let __pawLayoutPingN = 0;
let __pawLayoutPingRaf = 0;

function pawScheduleLayoutPing(){
  try{
    if (__pawLayoutPingRaf) return;
    __pawLayoutPingRaf = requestAnimationFrame(function(){
      __pawLayoutPingRaf = 0;

      // Ensure node exists (lazy to avoid touching DOM during early head execution)
      if (!document || !document.body) return;
      if (!__pawLayoutPingEl){
        __pawLayoutPingEl = document.getElementById("__paw_layout_ping");
        if (!__pawLayoutPingEl){
          __pawLayoutPingEl = document.createElement("span");
          __pawLayoutPingEl.id = "__paw_layout_ping";
          __pawLayoutPingEl.setAttribute("aria-hidden", "true");
          __pawLayoutPingEl.style.cssText =
            "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;";
          __pawLayoutPingEl.appendChild(document.createTextNode("0"));
          document.body.appendChild(__pawLayoutPingEl);
        }
      }

      // CharacterData mutation: triggers the page-level MutationObserver height reporter.
      __pawLayoutPingN += 1;
      if (__pawLayoutPingEl.firstChild && __pawLayoutPingEl.firstChild.nodeType === 3){
        __pawLayoutPingEl.firstChild.nodeValue = String(__pawLayoutPingN);
      } else {
        __pawLayoutPingEl.textContent = String(__pawLayoutPingN);
      }
    });
  } catch(_){}
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
    // Notify Circle iframe auto-height reporter that layout changed.
    pawScheduleLayoutPing();
  } catch(_){}
}

function resetAutoGrowTextarea($ta){
  try{
    if(!$ta) return;
    $ta.style.height = "";
    $ta.style.overflowY = "";
    // Notify Circle iframe auto-height reporter that layout changed.
    pawScheduleLayoutPing();
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
      // - A subtle "Give feedback" link is added under every AI message.
      // - Clicking opens a tiny modal: reason dropdown + optional note + Send.
      //
      // Data captured automatically (no extra user steps):
      // - user message (+ extra payload if tool supplies it)
      // - AI output shown
      // - tool id + tool title
      // - time + page URL
      //
      // Delivery:
      // - Frontend POSTs to Worker endpoint: /give-feedback (DB storage)
      // - Worker stores the snapshot in D1 (no email)

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
          '<div class="modal-title">Give feedback</div>' +
          '<button type="button" class="modal-close" aria-label="Close">×</button>';

        const body = document.createElement("div");
        body.className = "modal-body";
        body.innerHTML =
          '<div class="field">' +
          '<label for="pawBadReason">What happened?</label>' +
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
          '<textarea id="pawBadNote" rows="3" maxlength="500" placeholder="Short note (optional)" style="width:100%;max-width:100%;box-sizing:border-box;"></textarea>' +
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
              if (statusEl) statusEl.textContent = "Saving…";

              const token = getCSRFTokenFromMeta();
              const baseUrl = getPostUrl();
              const url = baseUrl.replace(/\/+$/, "") + "/give-feedback";

              // NOTE: We intentionally do not use postJSON() here because postJSON() prefers
              // `error` over `message` when building the thrown Error. For this reporting modal
              // we want the friendly `message` text if the Worker provides it.
              const headers = { "Content-Type": "application/json" };
              if (token) headers["X-CSRF-Token"] = token;

              const resp = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  kind: "user_feedback",
                  reason,
                  note,
                  snapshot,
                }),
              });

              const respText = await resp.text();
              let res = null;
              try {
                res = JSON.parse(respText);
              } catch (_) {
                res = { message: respText || "" };
              }

              if (!resp.ok) {
                throw new Error(
                  (res && (res.message || res.reply)) ||
                    "Could not send right now. Please try again."
                );
              }

              if (res && res.ok === false) {
                throw new Error(
                  res.message || "Could not send right now. Please try again."
                );
              }

              if (statusEl) statusEl.textContent = "Saved. Thank you!";
              setTimeout(function () {
                try {
                  close();
                } catch (_) {}
              }, 700);
            } catch (err) {
              if (statusEl) {
                statusEl.textContent = (err && err.message) ? String(err.message) : "Could not send right now. Please try again.";
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

        // Feedback link placement must be UNIFORM across all tools:
        // - Lives OUTSIDE the AI bubble (below it, aligned right)
        // - Does not exist before the first AI response (since we inject only when an AI message renders)
        //
        // Implementation note:
        // We wrap each AI bubble in a lightweight container so the feedback row can sit
        // beneath the bubble without being "inside" the bubble DOM (prevents crowding on short answers).
        const ensureMessageBlock = () => {
          try {
            const existingBlock = messageWrap.closest && messageWrap.closest(".paw-message-block");
            if (existingBlock) return existingBlock;

            const parent = messageWrap.parentNode;
            if (!parent) return null;

            const block = document.createElement("div");
            block.className = "paw-message-block";

            // Insert wrapper where the bubble was, then move bubble into wrapper.
            parent.insertBefore(block, messageWrap);
            block.appendChild(messageWrap);

            return block;
          } catch (_) {
            return null;
          }
        };

        const block = ensureMessageBlock() || messageWrap;

        // Avoid duplicates if a tool re-renders.
        // IMPORTANT: Some tools may overwrite bubble.innerHTML after we attach.
        // In that case the DOM row disappears but the flag remains, so we must
        // re-check the DOM rather than relying on the flag alone.
        try {
          const existing = block.querySelector && block.querySelector(".paw-report-row");
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
        a.textContent = "Give feedback";

        a.addEventListener("click", function (e) {
          try { e.preventDefault(); } catch (_) {}
          const snap = messageWrap.__pawBadSnapshot || snapshot || null;
          openBadResponseModal(snap);
        });

        row.appendChild(a);
        block.appendChild(row);
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
        
    // Tips & How To (PAW modal, not browser-native alert)
    // ---------------------------------------------------
    // Contract:
    // - Uses shared .modal styles from paw-ui.css
    // - Close via X, backdrop click, or Escape
    function ensureTipsModal(){
      try{
        var existing = document.getElementById("pawTipsModal");
        if (existing) return existing;

        var m = document.createElement("div");
        m.id = "pawTipsModal";
        m.className = "modal";
        m.setAttribute("aria-hidden","true");

        m.innerHTML =
          '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pawTipsTitle">' +
            '<div class="modal-head">' +
              '<div id="pawTipsTitle" class="modal-title">Tips &amp; How To</div>' +
              '<button class="modal-close" id="pawTipsClose" aria-label="Close" type="button">✕</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div id="pawTipsBody" style="white-space:pre-wrap;"></div>' +
            '</div>' +
          '</div>';

        document.body.appendChild(m);

        // Close controls
        var closeBtn = document.getElementById("pawTipsClose");
        if (closeBtn) closeBtn.addEventListener("click", function(){ closeTipsModal(); });

        m.addEventListener("click", function(e){
          if (e.target === m) closeTipsModal();
        });

        document.addEventListener("keydown", function(e){
          if (e.key === "Escape") closeTipsModal();
        });

        return m;
      }catch(e){ return null; }
    }

    function openTipsModal(text){
      try{
        var m = ensureTipsModal();
        if (!m) return;

        var body = document.getElementById("pawTipsBody");
        if (body) body.textContent = String(text || "");

        m.classList.add("show");
        m.setAttribute("aria-hidden","false");
      }catch(e){}
    }

    function closeTipsModal(){
      try{
        var m = document.getElementById("pawTipsModal");
        if (!m) return;
        m.classList.remove("show");
        m.setAttribute("aria-hidden","true");
      }catch(e){}
    }
$tips.addEventListener("click", function () { openTipsModal(config.tipsText || ""); });
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

// ==========================================================
// My Works Drawer (shared) — Phase 1
// ----------------------------------------------------------
// PURPOSE:
// - The Work pill ("Work: Ready") is present on every tool.
// - Phase 1 makes it REAL: clicking opens a drawer that can
//   attach/detach a single active Work to the current session.
// - Nothing is saved automatically.
// - Brand is wired to the Worker (GET /mystuff/brand). Listings/Deals
//   are placeholders until Worker endpoints exist.
//
// IMPORTANT PRODUCT RULES (LOCKED):
// - Session-first by default.
// - Users explicitly choose what is saved.
// - My Works is the single system of record (tools do not own persistence).
// ==========================================================

(function(){
  "use strict";

  // Session-only context (in-memory, resets on reload).
  var __pawActiveWork = null; // { bucket:"brand"|"listings"|"deals", id:string, label:string }

  // My Works UI refs (shared across all tools)
  // ----------------------------------------------------------
  // IMPORTANT PRODUCT INTENT:
  // - "Work: Ready" is a MODE switch, not a small drawer.
  // - When open, My Works replaces the tool working surface so the
  //   user focuses on selecting/attaching work.
  // - When closed, the tool returns exactly as it was.
  //
  // Engineering notes:
  // - We keep the existing classnames (.paw-drawer__*) for reuse,
  //   but behavior is inline + page-state swap (not modal).
  // ----------------------------------------------------------
  var __drawer = null;
  var __drawerPanel = null;

  // Elements we temporarily hide while My Works is open (tool mode swap).
  var __worksHiddenEls = [];
  var __worksModeOn = false;
  // Scroll position preservation for My Works mode swap.
  // Product intent: entering My Works should feel like a focused "mode", not a page that drifts.
  var __worksPrevScrollY = 0;
  var __worksPrevScrollRestoration = "";
  var __worksIsRestoringScroll = false;

  // Previously focused element before entering Works mode (for accessibility/focus restore).
  var __worksPrevActiveEl = null;

  var __tabBtns = null; // reserved for Bite 3+
  var __panels = null;  // reserved for Bite 3+
  var __brandPanel = null;

  var __apiEndpoint = "";
  var __brandCache = null; // { exists:boolean, brand:{...}, meta:{...} }

  function $(sel, root){ return (root || document).querySelector(sel); }
  function $all(sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel) || []); }
  function norm(v){ return String(v == null ? "" : v).trim(); }
  function escapeHtml(str){
    return String(str||"")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#39;");
  }

  // ------------------------------------------------------------
  // Work pill label update (DO NOT overwrite markup)
  // ------------------------------------------------------------
  function workLabelText(){
    // ==========================================================
    // PAW Work pill: status text (v1)
    // ----------------------------------------------------------
    // PURPOSE:
    // - The Work button should remain a pure ACTION control:
    //     [icon] Work [chevron]
    // - Any state/status (e.g., Ready, current listing/brand label)
    //   should be rendered NEXT TO the button, not inside it.
    //
    // This prevents "Work: Ready" from looking like a single button label,
    // keeps the UI cleaner, and avoids layout shifts on small screens.
    // ==========================================================
    if (__pawActiveWork && __pawActiveWork.label){
      return String(__pawActiveWork.label);
    }
    return "Ready";
  }

  function workModeStatusText(){
    // ==========================================================
    // PAW Work mode status text (clicked state)
    // ----------------------------------------------------------
    // PURPOSE:
    // - In Works mode, the status next to the Work button should become
    //   a helpful context indicator (later: selected saved work name).
    // - For now:
    //     * If a work is attached: show its label
    //     * Otherwise: show a neutral prompt
    // ==========================================================
    if (__pawActiveWork && __pawActiveWork.label){
      return String(__pawActiveWork.label);
    }
    return "Select a Work";
  }


  function updateWorkPill(){
  try{
    var btn = document.getElementById("pawMyStuffBtn");
    if (!btn) return;

    var labelEl = btn.querySelector(".works-label");
    var chevEl  = btn.querySelector(".works-chevron");

    // Ensure an adjacent (non-clickable) status element exists.
    // This keeps status like "Ready" OUT of the button text.
    var head = btn.parentElement; // .tool-head
    var statusEl = head ? head.querySelector(".paw-work-status") : null;
    if (!statusEl && head){
      statusEl = document.createElement("span");
      statusEl.className = "paw-work-status";
      statusEl.setAttribute("aria-live","polite");
      head.appendChild(statusEl);
    }

    // Scoped CSS (injected once). We do this here to avoid touching paw-ui.css.
    if (!document.getElementById("pawWorkStatusStyle")){
      var st = document.createElement("style");
      st.id = "pawWorkStatusStyle";
      st.textContent =
        /* ==========================================================
           PAW Work Status (injected helper styles)
           ----------------------------------------------------------
           IMPORTANT:
           - We *only* define a safe baseline here.
           - Mobile layout (stacking + centered status) is handled via a
             media query to avoid overriding paw-ui.css behavior.
           - This fixes the prior bug where display:inline-flex prevented
             text centering and forced left-justified "Ready / Select a work".
           ========================================================== */
        ".tool-head{ display:flex; align-items:center; gap:10px; }\\n" +
        ".paw-work-status{ font-weight:800; font-size:13px; color:rgba(15,23,42,.68); white-space:nowrap; }\\n" +
        "html[data-embed=\'1\'] .paw-work-status{ color:rgba(15,23,42,.62); }\\n" +
        "@media (max-width: 560px){\\n" +
        "  .tool-head{ width:100%; flex-direction:column; align-items:stretch; justify-content:flex-start; gap:8px; }\\n" +
        "  .paw-work-status{ display:block; width:100%; text-align:center; margin-left:0 !important; padding-left:0 !important; overflow:hidden; text-overflow:ellipsis; }\\n" +
        "}";
      (document.head || document.documentElement).appendChild(st);
    }

    if (__worksModeOn){
      // Works mode (clicked): keep button label stable ("Work"),
      // but SHOW a helpful status next to it (future: selected saved work name).
      if (labelEl) labelEl.textContent = "Work";
      // Keep a single chevron glyph (down). Visual state is communicated via CSS rotation on aria-expanded.
      if (chevEl)  chevEl.textContent = "▾";
      if (statusEl){
        // display controlled by CSS (mobile vs desktop)
        statusEl.style.display = "";
        statusEl.textContent = workModeStatusText();
      }
      btn.setAttribute("aria-expanded","true");
      btn.setAttribute("aria-label","Work mode: " + workModeStatusText());
    } else {
      // Drawer closed: button stays as "Work" (action), status sits next to it.
      if (labelEl) labelEl.textContent = "Work";
      // Keep a single chevron glyph (down). Visual state is communicated via CSS rotation on aria-expanded.
      if (chevEl)  chevEl.textContent = "▾";
            if (statusEl){
        // display controlled by CSS (mobile vs desktop)
        statusEl.style.display = "";
        statusEl.textContent = workLabelText();
      }
      btn.setAttribute("aria-expanded","false");
      btn.setAttribute("aria-label", "Work context: " + workLabelText());
    }

    btn.classList.toggle("is-active", !!__pawActiveWork);
  }catch(_){}
}

  // ------------------------------------------------------------
  // Drawer injection (shared across all tools)
  // ------------------------------------------------------------
  // ------------------------------------------------------------
// Works surface (placeholder)
// ------------------------------------------------------------
var __worksRoot = null;
var __toolRoot = null;

// We MOVE the existing Work button into the Works header so it stays in the same spot
// and becomes the "return to tool" toggle. We restore it on exit.
var __worksBtn = null;
var __worksBtnPlaceholder = null;
var __worksBtnHomeParent = null;

// Work status element ("Ready" / "Select a work") is a sibling of the Work button.
// We move it WITH the button into Works mode so it never gets orphaned behind the overlay,
// and so its DOM order remains deterministic across repeated toggles.
var __worksStatusEl = null;
var __worksStatusPlaceholder = null;
var __worksStatusHomeParent = null;


// Exposed helpers for Works mode.
// NOTE: These are intentionally assigned inside ensureWorksRoot() so enterWorksMode()
// can render Works content immediately without changing the fragile container mechanics.
var renderWorksBody = function(){ };
var _touchRecent = function(){ };

function ensureWorksRoot(){
  if (__worksRoot && document.body.contains(__worksRoot)) return __worksRoot;

  __worksRoot = document.createElement("div");
  __worksRoot.id = "pawWorksModeRoot";
  __worksRoot.setAttribute("role","region");
  __worksRoot.setAttribute("aria-label","My Works");

  // IMPORTANT: Placeholder only. Real My Works rendering comes next.
  __worksRoot.innerHTML = `
    <div class="paw-works-mode__top">
      <div class="paw-works-mode__top-left" data-paw-works-top-left="1"></div>

      <!-- Disabled utilities (Reset / Tips) kept for visual continuity only.
           They do not apply in Works mode. -->
      <div class="paw-works-mode__top-right" data-paw-works-top-right="1">
        <div class="utility-pair paw-seg paw-works-mode__utilities" aria-label="Utilities (disabled)">
          <button class="util-btn" type="button" disabled aria-disabled="true" tabindex="-1">Reset</button>
          <button class="util-btn" type="button" disabled aria-disabled="true" tabindex="-1">Tips &amp; How To</button>
        </div>
      </div>
    </div>

    <!-- Works mode body intentionally left blank for now.
         This avoids "destination page" cues while we build real My Works UI. -->
    <div class="paw-works-mode__body" data-paw-works-body="1">
      <div class="paw-works-mode__note" data-paw-works-fallback="1">
        <div class="paw-works-mode__note-title">Loading</div>
        <div class="paw-works-mode__note-copy">Preparing your works…</div>
      </div>
    </div>
  `;

  __worksRoot.addEventListener("click", function(e){
    var t = e.target;
    if (!t || !t.getAttribute) return;

    // Attach an existing recent work (session-only list for now).
    if (t.getAttribute("data-paw-works-attach") === "1"){
      var b = t.getAttribute("data-bucket") || "";
      var id = t.getAttribute("data-id") || "";
      var chosen = null;

      // Find in recents (preferred), otherwise attach a minimal object.
      try{
        for (var i=0;i<(__worksRecent||[]).length;i++){
          var w = __worksRecent[i];
          if (w && String(w.bucket||"") === String(b) && String(w.id||"") === String(id)){
            chosen = w;
            break;
          }
        }
      }catch(_){}

      attachWork(chosen || { bucket:b, id:id, label:"Untitled" });
      return;
    }

    // Detach from this session
    if (t.getAttribute("data-paw-works-detach") === "1"){
      detachWork();
      return;
    }

    if (t.getAttribute("data-paw-works-open") === "1"){
      try{
        var listEl = __worksRoot ? __worksRoot.querySelector('[data-paw-works-list="1"]') : null;
        var searchEl = __worksRoot ? __worksRoot.querySelector('[data-paw-works-search="1"]') : null;
        if (listEl && typeof listEl.scrollIntoView === "function") listEl.scrollIntoView({ block:"start" });
        if (searchEl && typeof searchEl.focus === "function") searchEl.focus();
      }catch(_){ }
      return;
    }

    if (t.getAttribute("data-paw-works-save-new") === "1"){
      openWorkNameModal("", async function(name, bucket){
        try{ if (window.PAWAuth && window.PAWAuth.whenReady) await window.PAWAuth.whenReady().catch(function(){}); }catch(_){ }
        var resolvedBucket = String(bucket||"") || _inferWorkBucketFromPage() || "brand_assets";
        if (!_getApiEndpoint()){
          _worksToast("Saving isn’t available right now.");
          return;
        }
        var tok = "";
        try{ tok = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : ""; }catch(_){ }
        if (!tok){
          _worksToast("Not signed in yet. Please try again.");
          return;
        }
        try{
          var work = await createMyWork(resolvedBucket, String(name||""));
          var nw = {
            bucket: work.bucket,
            id: work.work_id,
            label: work.label,
            subtitle: "",
            created_at: work.created_at,
            updated_at: work.updated_at
          };
          attachWork(nw);
          _touchRecent(nw);
          renderWorksBody();
          emitWorksSave("create");
          _worksToast("Saved.");
        }catch(err){
          _worksToast((err && err.message) ? err.message : "Couldn’t save right now.");
        }
      }, { defaultBucket: _inferWorkBucketFromPage() });
      return;
    }

    if (t.getAttribute("data-paw-works-save-as-new") === "1"){
      openWorkNameModal("", async function(name, bucket){
        try{ if (window.PAWAuth && window.PAWAuth.whenReady) await window.PAWAuth.whenReady().catch(function(){}); }catch(_){ }
        var resolvedBucket = String(bucket||"") || ((__pawActiveWork && __pawActiveWork.bucket) ? String(__pawActiveWork.bucket) : "") || _inferWorkBucketFromPage() || "brand_assets";
        if (!_getApiEndpoint()){
          _worksToast("Saving isn’t available right now.");
          return;
        }
        var tok = "";
        try{ tok = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : ""; }catch(_){ }
        if (!tok){
          _worksToast("Not signed in yet. Please try again.");
          return;
        }
        try{
          var work = await createMyWork(resolvedBucket, String(name||""));
          var nw = {
            bucket: work.bucket,
            id: work.work_id,
            label: work.label,
            subtitle: "",
            created_at: work.created_at,
            updated_at: work.updated_at
          };
          attachWork(nw);
          _touchRecent(nw);
          renderWorksBody();
          emitWorksSave("save_as_new");
          _worksToast("Saved.");
        }catch(err){
          _worksToast((err && err.message) ? err.message : "Couldn’t save right now.");
        }
      }, {
        defaultBucket: (__pawActiveWork && __pawActiveWork.bucket) ? String(__pawActiveWork.bucket) : _inferWorkBucketFromPage()
      });
      return;
    }

    // Save current output (tools can listen for this event; UI is ready).
    if (t.getAttribute("data-paw-works-save") === "1"){
      try{
        if (__pawActiveWork){
          __pawActiveWork.updated_at = new Date().toISOString();
          _touchRecent(__pawActiveWork);
        }
      }catch(_){ }
      try{ renderWorksBody(); }catch(_){ }
      emitWorksSave("save_updates");
      return;
    }

    if (t.getAttribute("data-paw-works-load-more") === "1"){
      __worksListLimit += 25;
      renderWorksBody();
      return;
    }
  });

  // ESC handling in Works mode:
  // - If a modal is open, close the modal only.
  // - If no modal is open, exit Works mode.
  document.addEventListener("keydown", function(e){
    if (!__worksModeOn) return;
    if (e.key !== "Escape") return;
    try{
      var anyModal = document.querySelector(".modal.show");
      if (anyModal){
        var wn = document.getElementById("pawWorkNameModal");
        if (wn && wn.classList && wn.classList.contains("show")) closeWorkNameModal();
        var tips = document.getElementById("pawTipsModal");
        if (tips && tips.classList && tips.classList.contains("show") && typeof closeTipsModal === "function") closeTipsModal();
        return;
      }
    }catch(_){ }
    exitWorksMode();
  });

  document.body.appendChild(__worksRoot);
  // ------------------------------------------------------------
  // Works Mode UI (content inside the already-working container)
  // ------------------------------------------------------------
  // SAFETY PRINCIPLE:
  // - Do NOT change the Works container mechanics (enter/exit, mounting, layout).
  // - Only render content inside .paw-works-mode__body.
  //
  // This is session-only UI: no persistence is assumed here.

  var __worksRecent = [];   // Most recently used works (session-only)
  var __worksSearchQ = "";
  var __worksListLimit = 25;

  function _workTypeLabel(bucket){
    if (bucket === "brand_assets") return "Brand Asset";
    if (bucket === "listings") return "Listing";
    if (bucket === "transactions") return "Transaction";
    return "Work";
  }

  function _inferWorkBucketFromPage(){
    try{
      var path = String((window.location && window.location.pathname) || "").toLowerCase();
      if (path.indexOf("presence.html") !== -1) return "brand_assets";
      if (path.indexOf("listing.html") !== -1) return "listings";
      if (path.indexOf("transactions.html") !== -1) return "transactions";
      if (path.indexOf("guide.html") !== -1 || path.indexOf("connect.html") !== -1) return "brand_assets";
    }catch(_){ }
    return "brand_assets";
  }


  function _worksToast(msg){
    try{
      if (window.PAWToolShell && window.PAWToolShell._toast) {
        window.PAWToolShell._toast(String(msg||""));
        return;
      }
    }catch(_){ }
    try{ alert(String(msg||"")); }catch(_){ }
  }

  function _getApiEndpoint(){
    try{
      if (__apiEndpoint) return String(__apiEndpoint || "");
      if (window.PAWToolShell && window.PAWToolShell._config && window.PAWToolShell._config.apiEndpoint){
        return String(window.PAWToolShell._config.apiEndpoint || "");
      }
    }catch(_){ }
    return "";
  }

  function _apiHeadersJsonAuth(){
    var headers = { "Content-Type":"application/json" };
    try{
      var t = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : "";
      if (t) headers["Authorization"] = "Bearer " + t;
    }catch(_){ }
    return headers;
  }

  async function createMyWork(bucket, label){
    var ep = _getApiEndpoint();
    if (!ep) throw new Error("Saving isn’t available right now.");
    var url = String(ep).replace(/\/+$/,"") + "/myworks";
    var res = await fetch(url, {
      method: "POST",
      headers: _apiHeadersJsonAuth(),
      body: JSON.stringify({ bucket: bucket, label: label, payload: {} })
    });

    var text = await res.text();
    var data = null;
    try{ data = JSON.parse(text); }catch(_){ data = { reply: text || "" }; }

    if (!res.ok){
      throw new Error((data && (data.error || data.message || data.reply)) || ("Request failed (" + res.status + ")"));
    }

    var work = data && data.data && data.data.work ? data.data.work : null;
    if (!work || !work.work_id) throw new Error("Invalid create response");
    return work;
  }

  function _formatRelative(input){
    try{
      if (!input) return "";
      var d = (input instanceof Date) ? input : new Date(String(input));
      var t = d.getTime();
      if (!isFinite(t)) return "";
      var diff = Date.now() - t;
      if (diff < 0) diff = 0;
      var sec = Math.floor(diff / 1000);
      if (sec < 10) return "just now";
      if (sec < 60) return sec + "s ago";
      var min = Math.floor(sec / 60);
      if (min < 60) return min + "m ago";
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + "h ago";
      var day = Math.floor(hr / 24);
      if (day < 7) return day + "d ago";
      return d.toLocaleDateString();
    }catch(_){ return ""; }
  }

  function _workTimeValue(w){
    try{
      var raw = (w && (w.updated_at || w.created_at || w._last_used)) ? String(w.updated_at || w.created_at || w._last_used) : "";
      var t = raw ? new Date(raw).getTime() : 0;
      return isFinite(t) ? t : 0;
    }catch(_){ return 0; }
  }

  function _dedupeRecent(arr){
    var seen = {};
    var out = [];
    for (var i=0;i<arr.length;i++){
      var w = arr[i];
      if (!w) continue;
      var key = String(w.bucket||"") + "::" + String(w.id||"");
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(w);
    }
    return out;
  }

  _touchRecent = function _touchRecent(work){
    try{
      if (!work || !work.bucket || !work.id) return;
      var w = Object.assign({}, work);
      w._last_used = new Date().toISOString();
      // Put at top
      __worksRecent = [w].concat(__worksRecent || []);
      __worksRecent = _dedupeRecent(__worksRecent).slice(0, 50);
    }catch(_){}
  };

  function emitWorksSave(intent){
    try{
      var ev = new CustomEvent("paw:works:save_current_output", {
        detail: { active_work: getActiveWork(), intent: String(intent || "") }
      });
      window.dispatchEvent(ev);
    }catch(_){ }
  }

  function ensureWorkNameModal(){
    try{
      var existing = document.getElementById("pawWorkNameModal");
      if (existing) return existing;

      var m = document.createElement("div");
      m.id = "pawWorkNameModal";
      m.className = "modal";
      m.setAttribute("aria-hidden","true");

      m.innerHTML =
        '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pawWorkNameTitle">' +
          '<div class="modal-head">' +
            '<div id="pawWorkNameTitle" class="modal-title">Name this work (WS1)</div>' +
            '<button class="modal-close" id="pawWorkNameClose" aria-label="Close" type="button">✕</button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<label class="paw-workname-label" for="pawWorkNameInput">Work name</label>' +
            '<input id="pawWorkNameInput" class="paw-workname-input" type="text" placeholder="e.g., Spring listing prep" />' +
            '<label class="paw-workname-label" for="pawWorkBucketSelect">Save to</label>' +
            '<select id="pawWorkBucketSelect" class="paw-workname-input">' +
              '<option value="brand_assets">Brand Assets</option>' +
              '<option value="listings">Listings</option>' +
              '<option value="transactions">Transactions</option>' +
            '</select>' +
            '<div id="pawWorkNameError" class="paw-workname-error" aria-live="polite"></div>' +
            '<div class="paw-workname-actions">' +
              '<button class="btn" id="pawWorkNameCancel" type="button">Cancel</button>' +
              '<button class="btn primary" id="pawWorkNameSave" type="button">Save</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.body.appendChild(m);

      var closeBtn = document.getElementById("pawWorkNameClose");
      if (closeBtn) closeBtn.addEventListener("click", function(){ closeWorkNameModal(); });
      var cancelBtn = document.getElementById("pawWorkNameCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", function(){ closeWorkNameModal(); });

      m.addEventListener("click", function(e){
        if (e.target === m) closeWorkNameModal();
      });

      document.addEventListener("keydown", function(e){
        if (e.key === "Escape") closeWorkNameModal();
      });

      return m;
    }catch(_){ return null; }
  }

  function closeWorkNameModal(){
    try{
      var m = document.getElementById("pawWorkNameModal");
      if (!m) return;
      m.classList.remove("show");
      m.setAttribute("aria-hidden","true");
    }catch(_){ }
  }

  function openWorkNameModal(initialName, onConfirm, opts){
    try{
      var m = ensureWorkNameModal();
      if (!m) return;
      var input = document.getElementById("pawWorkNameInput");
      var bucketSelect = document.getElementById("pawWorkBucketSelect");
      var err = document.getElementById("pawWorkNameError");
      var saveBtn = document.getElementById("pawWorkNameSave");
      var inferredBucket = _inferWorkBucketFromPage();
      var attachedBucket = (__pawActiveWork && __pawActiveWork.bucket) ? String(__pawActiveWork.bucket) : "";
      var defaultBucket = (opts && opts.defaultBucket) ? String(opts.defaultBucket) : inferredBucket;

      if (err) err.textContent = "";
      if (input) input.value = String(initialName || "");
      if (bucketSelect) bucketSelect.value = defaultBucket;

      function submit(){
        var v = input ? String(input.value || "").trim() : "";
        var bucket = bucketSelect ? String(bucketSelect.value || "") : "";
        if (!bucket) bucket = attachedBucket || inferredBucket;
        if (!v){
          if (err) err.textContent = "Please enter a name.";
          try{ if (input) input.focus(); }catch(_){ }
          return;
        }
        if (err) err.textContent = "";
        try{ if (typeof onConfirm === "function") onConfirm(v, bucket); }catch(_){ }
        closeWorkNameModal();
      }

      if (saveBtn) saveBtn.onclick = submit;
      if (input) input.onkeydown = function(e){ if (e.key === "Enter") submit(); };

      m.classList.add("show");
      m.setAttribute("aria-hidden","false");
      setTimeout(function(){ try{ if (input) input.focus(); }catch(_){ } }, 0);
    }catch(_){ }
  }

  renderWorksBody = function renderWorksBody(){
    try{
      if (!__worksRoot) return;
      var body = __worksRoot.querySelector("[data-paw-works-body=\"1\"]");
      if (!body) return;

      var hasAttached = !!(__pawActiveWork && __pawActiveWork.label);
      var attachedName = hasAttached ? String(__pawActiveWork.label) : "";
      var attachedType = hasAttached ? _workTypeLabel(__pawActiveWork.bucket) : "";

      // Filter recent list by search query
      var q = (__worksSearchQ || "").trim().toLowerCase();
      var list = (__worksRecent || []).slice(0);

      list.sort(function(a,b){
        return _workTimeValue(b) - _workTimeValue(a);
      });

      if (q){
        list = list.filter(function(w){
          var hay = (String(w.label||"") + " " + String(w.subtitle||"") + " " + String(_workTypeLabel(w.bucket)||"")).toLowerCase();
          return hay.indexOf(q) !== -1;
        });
      }

      var visibleList = list.slice(0, __worksListLimit);
      var hasMore = list.length > visibleList.length;

      var html = "";

      // Attached confirmation row (NOT in the top bar)
      if (hasAttached){
        var lastSaved = _formatRelative(__pawActiveWork.updated_at || __pawActiveWork.created_at || __pawActiveWork._last_used);
        html += `
          <div class="paw-works-mode__note paw-works-attached">
            <div class="paw-works-mode__note-title">Working on: ${escapeHtml(attachedName)}</div>
            <div class="paw-works-mode__note-copy">${escapeHtml(attachedType)} • Last saved ${escapeHtml(lastSaved || "—")}</div>
          </div>
        `;
      } else {
        html += `
          <div class="paw-works-mode__note">
            <div class="paw-works-mode__note-title">Nothing saved yet</div>
            <div class="paw-works-mode__note-copy">Save what you’re working on, or open a saved work.</div>
          </div>
        `;
      }

      // Primary actions
      if (!hasAttached){
        html += `
          <div class="paw-works-actions">
            <button class="btn primary" type="button" data-paw-works-save-new="1">Save</button>
            <button class="btn" type="button" data-paw-works-open="1">Open</button>
          </div>
        `;
      } else {
        html += `
          <div class="paw-works-actions">
            <button class="btn primary" type="button" data-paw-works-save="1">Save updates</button>
            <button class="btn" type="button" data-paw-works-save-as-new="1">Save as new</button>
            <button class="paw-works-linkbtn" type="button" data-paw-works-open="1">Switch</button>
            <button class="paw-works-linkbtn" type="button" data-paw-works-detach="1">Detach</button>
          </div>
        `;
      }

      // Search + list header
      html += `
        <div class="paw-works-recents">
          <div class="paw-works-recents__head">
            <div>
              <div class="paw-works-recents__title">Saved works</div>
              <div class="paw-works-recents__sub">Recent in this session</div>
            </div>
            <input class="paw-works-search" type="search" placeholder="Search saved works" value="${escapeHtml(__worksSearchQ||"")}" aria-label="Search works" data-paw-works-search="1"/>
          </div>
          <div class="paw-works-table-head" role="presentation">
            <div>Name</div>
            <div>Type</div>
            <div>Last updated</div>
            <div></div>
          </div>
          <div class="paw-works-list" data-paw-works-list="1">
      `;

      if (!list.length){
        html += `
            <div class="paw-works-empty">
              <div class="paw-works-empty__title">${q ? "No matches" : "You haven't saved anything yet."}</div>
              <div class="paw-works-empty__body">${q ? "Try a different search." : "Create your first work or save what you're working on."}</div>
            </div>
        `;
      } else {
        for (var i=0;i<visibleList.length;i++){
          var w = visibleList[i];
          var type = _workTypeLabel(w.bucket);
          var when = _formatRelative(w.updated_at || w.created_at || w._last_used);
          var rowAction = hasAttached ? "Switch" : "Open";
          html += `
            <div class="paw-works-item paw-works-row">
              <div class="paw-works-col paw-works-col--name">${escapeHtml(String(w.label||"Untitled"))}</div>
              <div class="paw-works-col">${escapeHtml(type)}</div>
              <div class="paw-works-col">${escapeHtml(when || "—")}</div>
              <div class="paw-works-col paw-works-col--action">
                <button class="btn" type="button" data-paw-works-attach="1" data-bucket="${escapeHtml(String(w.bucket||""))}" data-id="${escapeHtml(String(w.id||""))}">${rowAction}</button>
              </div>
            </div>
          `;
        }
        if (hasMore){
          html += `
            <div class="paw-works-actions">
              <button class="btn" type="button" data-paw-works-load-more="1">Load more</button>
            </div>
          `;
        }
      }

      html += `
          </div>
        </div>
      `;

      body.innerHTML = html;

      // Wire search input (scoped)
      try{
        var inp = body.querySelector("[data-paw-works-search=\"1\"]");
        if (inp){
          inp.oninput = function(){
            __worksSearchQ = String(inp.value || "");
            __worksListLimit = 25;
            renderWorksBody();
          };
        }
      }catch(_){}
    }catch(_){
      // Defensive fallback: if rendering fails for any reason, never show a blank surface.
      try{
        if (__worksRoot){
          var body2 = __worksRoot.querySelector('[data-paw-works-body="1"]');
          if (body2){
            body2.innerHTML = '<div class="paw-works-mode__note"><div class="paw-works-mode__note-title">Work mode</div><div class="paw-works-mode__note-copy">We couldn\'t load your works. Please refresh the page.</div></div>';
          }
        }
      }catch(__){}
    }
  };

  return __worksRoot;
}

function findToolRoot(){
  // All PAW tools render inside a shared ".panel" surface.
  // Older builds sometimes wrapped this in ".app". We prefer ".panel"
  // because it maps to the tool surface we want to fully replace.
  var el =
    document.querySelector(".panel") ||
    document.querySelector("body > .app") ||
    document.querySelector(".app") ||
    document.querySelector("main");
  return el || null;
}


  
  // ------------------------------------------------------------
  // Page-state swap: My Works mode replaces the tool working surface
  // ------------------------------------------------------------
  function setWorksMode(on){
    var want = !!on;
    if (__worksModeOn === want) return;

    __worksModeOn = want;

    // Find the shared panel container (all tools use .panel).
    var panel = document.querySelector(".panel");
    if (!panel) panel = document.body;

    // NOTE (product intent):
    // - Works is a temporary "mode" (not a drawer).
    // - In Circle iframes, repeated height/scroll adjustments can cause a
    //   runaway scroll feel. We stabilize by:
    //     1) snapping to a known scroll position once,
    //     2) avoiding viewport-based CSS that can cause iframe resize loops, and
    //     3) restoring the user's previous scroll position on exit.
    if (want){
      // Preserve the user's position so we can return them when Works closes.
      try{
        __worksPrevScrollY = (window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0);
      }catch(_){ __worksPrevScrollY = 0; }

      // Prevent the browser from trying to "helpfully" restore scroll while the DOM swaps.
      try{
        __worksPrevScrollRestoration = (history && history.scrollRestoration) ? history.scrollRestoration : "";
        if (history && typeof history.scrollRestoration === "string") history.scrollRestoration = "manual";
      }catch(_){}

      // Snap to the top ONCE (no smooth scrolling) before we lock scrolling via CSS.
      // This ensures the Works surface is always visible.
      try{
        window.scrollTo(0,0);
        try{ document.documentElement.scrollTop = 0; }catch(_){}
        try{ document.body.scrollTop = 0; }catch(_){}
      }catch(_){}

      // Capture + hide everything in the panel EXCEPT:
      // - the topbar (where the Works button lives)
      // - the My Works expander region itself
      __worksHiddenEls = [];
      try{
        var kids = Array.prototype.slice.call(panel.children || []);
        var topbar = document.querySelector(".panel-topbar");
        kids.forEach(function(el){
          if (!el || el === __drawer || el === topbar) return;

          // Avoid touching unrelated injected nodes (e.g., modals/toasts).
          var prev = (el.style && typeof el.style.display === "string") ? el.style.display : "";
          el.setAttribute("data-paw-works-hide","1");
          el.setAttribute("data-paw-prev-display", prev);
          el.style.display = "none";
          __worksHiddenEls.push(el);
        });
      }catch(_){}

      // Works mode class is applied to BOTH html + body (CSS uses both).
      try{ document.documentElement.classList.add("paw-works-mode"); }catch(_){}
      try{ document.body.classList.add("paw-works-mode"); }catch(_){}
    } else {
      // Restore what we hid, exactly as it was.
      try{
        (__worksHiddenEls || []).forEach(function(el){
          if (!el) return;
          var prev = el.getAttribute("data-paw-prev-display");
          el.style.display = prev || "";
          el.removeAttribute("data-paw-works-hide");
          el.removeAttribute("data-paw-prev-display");
        });
      }catch(_){}
      __worksHiddenEls = [];

      try{ document.documentElement.classList.remove("paw-works-mode"); }catch(_){}
      try{ document.body.classList.remove("paw-works-mode"); }catch(_){}

      // Restore scroll restoration preference.
      try{
        if (history && typeof history.scrollRestoration === "string"){
          history.scrollRestoration = __worksPrevScrollRestoration || "auto";
        }
      }catch(_){}

      // Return the user to where they were before opening Works.
      // We do this AFTER the DOM is restored and the scroll lock is removed.
      try{
        if (!__worksIsRestoringScroll){
          __worksIsRestoringScroll = true;
          setTimeout(function(){
            try{ window.scrollTo(0, __worksPrevScrollY || 0); }catch(_){}
            __worksIsRestoringScroll = false;
          }, 0);
        }
      }catch(_){ __worksIsRestoringScroll = false; }
    }

    // Single layout ping after mode switch; avoids repeated pings that can amplify iframe jitter.
    try{ pawScheduleLayoutPing(); }catch(_ ){}
  }


// ------------------------------------------------------------
// Mode enter/exit (full-page swap)
// ------------------------------------------------------------
function enterWorksMode(){
  if (__worksModeOn) return;

  __toolRoot = findToolRoot();
  if (!__toolRoot){
    // If we can't safely replace the tool UI, the Work button should not be available.
    try{ var btn = document.getElementById("pawMyStuffBtn"); if (btn) btn.style.display = "none"; }catch(_){}
    return;
  }

  __worksModeOn = true;

  // Save scroll + focus to restore exactly.
  try{ __worksPrevScrollY = (window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0); }catch(_){ __worksPrevScrollY = 0; }
  try{ __worksPrevActiveEl = document.activeElement || null; }catch(_){ __worksPrevActiveEl = null; }

  try{
    __worksPrevScrollRestoration = (history && history.scrollRestoration) ? history.scrollRestoration : "";
    if (history && typeof history.scrollRestoration === "string") history.scrollRestoration = "manual";
  }catch(_){}

  // Prepare to move the existing Work button into Works header.
  try{
    __worksBtn = document.getElementById("pawMyStuffBtn");
    if (__worksBtn){
      __worksBtnHomeParent = __worksBtn.parentNode;
      __worksBtnPlaceholder = document.createComment("paw-works-btn-home");
      if (__worksBtnHomeParent) __worksBtnHomeParent.insertBefore(__worksBtnPlaceholder, __worksBtn);

      // Capture the adjacent status element (if it exists) so we can move it into Works mode too.
      // This prevents a stale status node from being left behind under the overlay, which can
      // invert DOM order on subsequent toggles (status appearing to the LEFT of the button).
      try{
        __worksStatusHomeParent = __worksBtnHomeParent;
        __worksStatusEl = __worksBtnHomeParent ? __worksBtnHomeParent.querySelector(".paw-work-status") : null;
        if (__worksStatusEl){
          __worksStatusPlaceholder = document.createComment("paw-works-status-home");
          __worksStatusHomeParent.insertBefore(__worksStatusPlaceholder, __worksStatusEl);
        }
      }catch(_){ __worksStatusEl = null; __worksStatusPlaceholder = null; __worksStatusHomeParent = null; }

    }
  }catch(_){ __worksBtn = null; __worksBtnHomeParent = null; __worksBtnPlaceholder = null; }

  // Apply mode class + swap surfaces.
  try{ document.documentElement.classList.add("paw-works-mode"); }catch(_){}
  try{ document.body.classList.add("paw-works-mode"); }catch(_){}

  // Hide tool completely (no peeking underneath).
  try{ __toolRoot.style.display = "none"; }catch(_){}

  // Ensure Works surface exists + show it.
  ensureWorksRoot();
  try{ renderWorksBody(); }catch(_){ }

  // Mount the Work button into the Works header (same position, no duplicate controls).
  try{
    if (__worksBtn && __worksRoot){
      var topLeft = __worksRoot.querySelector("[data-paw-works-top-left=\"1\"]");
      if (topLeft){
        // Defensive cleanup: remove any orphan status nodes that may have been left from a prior session.
        try{
          var stale = topLeft.querySelectorAll(".paw-work-status");
          for (var i=0;i<stale.length;i++){
            if (__worksStatusEl && stale[i] === __worksStatusEl) continue;
            stale[i].parentNode && stale[i].parentNode.removeChild(stale[i]);
          }
        }catch(_){}

        // Mount in deterministic order: button first, then status.
        topLeft.appendChild(__worksBtn);
        if (__worksStatusEl) topLeft.appendChild(__worksStatusEl);
      }
    }
  }catch(_){}

  updateWorkPill();

  try{ __worksRoot.style.display = "flex"; }catch(_){}

  // Stabilize scroll: bring Works to top.
  try{ window.scrollTo(0,0); }catch(_){}
}

function exitWorksMode(){
  if (!__worksModeOn) return;
  __worksModeOn = false;

  // Hide Works surface.
  try{ if (__worksRoot) __worksRoot.style.display = "none"; }catch(_){}

  // Restore the Work button to its original home before showing the tool.
  try{
    if (__worksBtn && __worksBtnHomeParent){
      if (__worksBtnPlaceholder && __worksBtnPlaceholder.parentNode === __worksBtnHomeParent){
        __worksBtnHomeParent.insertBefore(__worksBtn, __worksBtnPlaceholder);
        __worksBtnHomeParent.removeChild(__worksBtnPlaceholder);
      } else {
        __worksBtnHomeParent.appendChild(__worksBtn);
      }
    }
  }catch(_){}

  // Restore the status element to its original home (immediately after the Work button).
  try{
    if (__worksStatusEl && __worksStatusHomeParent){
      if (__worksStatusPlaceholder && __worksStatusPlaceholder.parentNode === __worksStatusHomeParent){
        __worksStatusHomeParent.insertBefore(__worksStatusEl, __worksStatusPlaceholder);
        __worksStatusHomeParent.removeChild(__worksStatusPlaceholder);
      } else {
        __worksStatusHomeParent.appendChild(__worksStatusEl);
      }
    }
  }catch(_){}

  // Defensive cleanup: remove any leftover status nodes from the Works header.
  try{
    if (__worksRoot){
      var tl = __worksRoot.querySelector("[data-paw-works-top-left=\"1\"]");
      if (tl){
        var stale2 = tl.querySelectorAll(".paw-work-status");
        for (var j=0;j<stale2.length;j++){
          if (__worksStatusEl && stale2[j] === __worksStatusEl) continue;
          stale2[j].parentNode && stale2[j].parentNode.removeChild(stale2[j]);
        }
      }
    }
  }catch(_){}

  // Restore tool surface.
  try{ if (__toolRoot) __toolRoot.style.display = ""; }catch(_){}

  // Ensure deterministic order in the normal tool header as well: button first, then status.
  // (Prevents edge cases where DOM insertion order could drift if the host page mutates the header.)
  try{
    if (__worksBtn && __worksBtn.parentNode){
      var h = __worksBtn.parentNode;
      var s = h.querySelector(".paw-work-status");
      if (s){
        // Ensure button is before status
        if (s.previousSibling !== __worksBtn){
          if (__worksBtn.nextSibling) h.insertBefore(s, __worksBtn.nextSibling);
          else h.appendChild(s);
        }
      }
    }
  }catch(_){}

  try{ document.documentElement.classList.remove("paw-works-mode"); }catch(_){}
  try{ document.body.classList.remove("paw-works-mode"); }catch(_){}

  try{
    if (history && typeof history.scrollRestoration === "string"){
      history.scrollRestoration = __worksPrevScrollRestoration || "auto";
    }
  }catch(_){}

  // Restore scroll position AFTER DOM is restored.
  try{ setTimeout(function(){ try{ window.scrollTo(0, __worksPrevScrollY || 0); }catch(_){ } }, 0); }catch(_){}

  // Restore focus if possible.
  try{
    setTimeout(function(){
      try{
        if (__worksPrevActiveEl && typeof __worksPrevActiveEl.focus === "function") __worksPrevActiveEl.focus();
      }catch(_){}
    }, 0);
  }catch(_){}

  updateWorkPill();
}



  // ------------------------------------------------------------
  // Context actions
  // ------------------------------------------------------------
  function renderContextRow(){
    var v = document.getElementById("pawWorksContextValue");
    var det = document.getElementById("pawWorksDetach");
    if (!v) return;

    if (__pawActiveWork && __pawActiveWork.label){
      v.textContent = String(__pawActiveWork.label);
      if (det) det.style.display = "";
    } else {
      v.textContent = "None";
      if (det) det.style.display = "none";
    }
  }

  function attachWork(work){
    __pawActiveWork = work || null;

    // Session-only MRU list (no persistence). Keeps Work mode useful without becoming a file manager.
    try{
      if (__pawActiveWork && __pawActiveWork.bucket && __pawActiveWork.id){
        _touchRecent({
          bucket: __pawActiveWork.bucket,
          id: __pawActiveWork.id,
          label: __pawActiveWork.label || "Untitled",
          subtitle: __pawActiveWork.subtitle || ""
        });
      }
    }catch(_){}

    updateWorkPill();
    renderContextRow();
    try{ renderWorksBody(); }catch(_){}
  }

  function detachWork(){
    __pawActiveWork = null;
    updateWorkPill();
    renderContextRow();
    try{ renderWorksBody(); }catch(_){}
    // Keep Works mode open; this is a safe action.
    try{
      if (window.PAWToolShell && window.PAWToolShell._toast) window.PAWToolShell._toast("Detached from this session.");
    }catch(_){}
  }

  // Exposed for tool-shell to include in payloads later.
  function getActiveWork(){
    return __pawActiveWork ? Object.assign({}, __pawActiveWork) : null;
  }

  // ------------------------------------------------------------
  // Brand panel (wired to Worker)
  // ------------------------------------------------------------
  async function fetchBrand(){
    if (!__apiEndpoint) return null;
    var url = String(__apiEndpoint).replace(/\/+$/,"") + "/mystuff/brand";
    var headers = { "Content-Type":"application/json" };
    try{
      var t = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : "";
      if (t) headers["Authorization"] = "Bearer " + t;
    }catch(_){}
    var res = await fetch(url, { method:"GET", headers: headers });
    var data = await res.json().catch(function(){ return {}; });
    if (!res.ok) throw new Error((data && (data.error || data.message)) || "Could not load My Brand");
    return data;
  }

  async function fetchBrandSummary(){
    if (!__apiEndpoint) return "";
    var url = String(__apiEndpoint).replace(/\/+$/,"") + "/mystuff/brand/summary";
    var headers = { "Content-Type":"application/json" };
    try{
      var t = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : "";
      if (t) headers["Authorization"] = "Bearer " + t;
    }catch(_){}
    var res = await fetch(url, { method:"GET", headers: headers });
    var data = await res.json().catch(function(){ return {}; });
    if (!res.ok) return "";
    return (data && typeof data.summary === "string") ? data.summary.trim() : "";
  }

  function brandDisplayName(brand){
    var b = brand || {};
    // Prefer display_name, fallback to "My Brand"
    var dn = norm(b.display_name);
    return dn ? "My Brand" : "My Brand";
  }

  async function refreshBrandPanel(){
    if (!__brandPanel) return;

    // Auth may not be ready on first paint; fail softly.
    __brandPanel.innerHTML = '<div class="paw-drawer__loading">Loading your Brand<span class="paw-dots"><span class="paw-dot"></span><span class="paw-dot"></span><span class="paw-dot"></span></span></div>';

    try{
      __brandCache = await fetchBrand();
    }catch(e){
      // Likely auth not ready or endpoint error. Keep message non-technical.
      __brandPanel.innerHTML = `
        <div class="paw-drawer__emptytitle">My Brand isn’t available yet</div>
        <div class="paw-drawer__emptycopy">If you haven’t created it, open Saved Works and create My Brand first.</div>
        <div class="paw-drawer__panelactions">
          <button class="btn primary" type="button" id="pawBrandGoCreate">Open Saved Works</button>
        </div>
      `;
      var go = document.getElementById("pawBrandGoCreate");
      if (go) go.onclick = function(){ try{ window.location.href = "./myworks.html?embed=1"; }catch(_){} };
      return;
    }

    if (!__brandCache || !__brandCache.exists){
      __brandPanel.innerHTML = `
        <div class="paw-drawer__emptytitle">No My Brand yet</div>
        <div class="paw-drawer__emptycopy">Create it once, then PAW can write like you when it adds value.</div>
        <div class="paw-drawer__panelactions">
          <button class="btn primary" type="button" id="pawBrandCreateBtn">Create My Brand</button>
        </div>
      `;
      var c = document.getElementById("pawBrandCreateBtn");
      if (c) c.onclick = function(){ try{ window.location.href = "./myworks.html?embed=1"; }catch(_){} };
      return;
    }

    var updated = (__brandCache.meta && __brandCache.meta.updated_at) ? String(__brandCache.meta.updated_at) : "";
    var updatedNice = "";
    try{ if (updated) updatedNice = (new Date(updated)).toLocaleString(); }catch(_){}

    // Render saved brand summary (derived)
    var summary = "";
    try { summary = await fetchBrandSummary(); } catch(_) {}
    if (!summary) summary = "Saved — ready to use when it adds value.";

    var attached = (__pawActiveWork && __pawActiveWork.bucket === "brand");

    __brandPanel.innerHTML = `
      <div class="paw-drawer__item">
        <div class="paw-drawer__itemhead">
          <div>
            <div class="paw-drawer__itemtitle">My Brand</div>
            <div class="paw-drawer__itemmeta">${updatedNice ? ("Last updated: " + escapeHtml(updatedNice)) : "Saved"}</div>
          </div>
          <div class="paw-drawer__itemactions">
            <button class="btn ${attached ? "" : "primary"}" type="button" id="pawBrandAttachBtn">${attached ? "Attached" : "Attach"}</button>
          </div>
        </div>

        <div class="paw-drawer__itemsnap">${escapeHtml(summary)}</div>
      </div>
    `;

    var a = document.getElementById("pawBrandAttachBtn");
    if (a){
      a.onclick = function(){
        if (__pawActiveWork && __pawActiveWork.bucket === "brand") {
          // clicking "Attached" does nothing; user can detach from footer
          return;
        }
        attachWork({ bucket:"brand", id:"brand", label:"My Brand" });
        try{
          if (window.PAWToolShell && window.PAWToolShell._toast) window.PAWToolShell._toast("Attached: My Brand");
        }catch(_){}
        // Re-render to flip button state
        refreshBrandPanel();
      };
    }
  }

  // ------------------------------------------------------------
  // Public init (called from tool-shell init)
  // ------------------------------------------------------------
  // ------------------------------------------------------------
// Public init (called from PAWToolShell.init)
// ------------------------------------------------------------
function init(apiEndpoint){
  __apiEndpoint = String(apiEndpoint || "");

  updateWorkPill();

  // Wire the Work button as a single toggle in every tool.
  var btn = document.getElementById("pawMyStuffBtn");
  if (!btn) return;

  // Prevent double-run if init() is called more than once.
  if (btn.getAttribute("data-paw-works") === "1") return;
  btn.setAttribute("data-paw-works","1");

  btn.addEventListener("click", function(e){
    try{ e.preventDefault(); }catch(_){}
    if (__worksModeOn) exitWorksMode();
    else enterWorksMode();
  });
}


  // Expose minimal API (no persistence, session-only)
  window.__PAWWorks = {
    init: init,
    getActiveWork: getActiveWork,
    attachWork: attachWork,
    detachWork: detachWork,
    _open: function(){ enterWorksMode(); },
    _close: function(){ exitWorksMode(); }
  };


  // ------------------------------------------------------------
  // Auto-bootstrap (safety net)
  // ------------------------------------------------------------
  // Some legacy tool pages historically relied on tool-local wiring.
  // Now that Works is shell-controlled, we still need the Work button
  // to respond even if a tool page forgets to call PAWToolShell.init().
  //
  // This *only* wires the Work button toggle. It does NOT persist data,
  // does NOT call the Worker, and is safe to run multiple times because
  // init() guards with data-paw-works="1".
  (function bootstrapWorksButton(){
    function tryInit(){
      try{
        var btn = document.getElementById("pawMyStuffBtn");
        if (!btn) return false;
        if (window.__PAWWorks && typeof window.__PAWWorks.init === "function"){
          window.__PAWWorks.init(__apiEndpoint || "");
          return true;
        }
      }catch(_){}
      return false;
    }

    // Try immediately (for pages where header is already in DOM)
    if (tryInit()) return;

    // Otherwise, wait for DOM ready.
    try{
      document.addEventListener("DOMContentLoaded", function(){ tryInit(); }, { once:true });
    }catch(_){}
  })();

})();
