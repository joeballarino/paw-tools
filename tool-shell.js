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

  function isAllowedParentOrigin(origin) {
    try {
      var u = new URL(String(origin || ""));
      var h = String(u.hostname || "").toLowerCase();
      // Safe allowlist expansion for Circle test embeds hosted on Pages:
      // we only allow the production Pages hostname and its preview subdomains.
      return (
        h === "proagentworks.circle.so" ||
        h === "proagentworks.com" ||
        h === "www.proagentworks.com" ||
        h === "paw-tools.pages.dev" ||
        h.endsWith(".paw-tools.pages.dev")
      );
    } catch (_) {
      return false;
    }
  }

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
          if (!isAllowedParentOrigin(event.origin)) return;

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

  const PAW_USAGE_LIMIT_HUMAN_MESSAGE =
    "You’ve reached your monthly usage limit for this plan. Upgrade your plan or wait until your next reset date to continue.";

  function humanizeShellErrorMessage(message) {
    const raw = safeText(message);
    if (!raw) return "";
    return raw.toLowerCase() === "usage_limit_reached" ? PAW_USAGE_LIMIT_HUMAN_MESSAGE : raw;
  }

  function formatAssistantErrorText(err) {
    const msg = humanizeShellErrorMessage(err && err.message ? err.message : err);
    if (!msg) return "Error";
    return msg === PAW_USAGE_LIMIT_HUMAN_MESSAGE ? msg : ("Error: " + msg);
  }

  // Shared auth gate for shell-managed requests.
  // Purpose:
  // - Normal AI tool POSTs should not leave the page until PAW auth has had a
  //   chance to finish minting the bearer token.
  // - If auth resolves without a token (for example, outside Circle), preserve
  //   the existing unauthenticated behavior rather than redesigning the flow.
  async function waitForPAWAuthReady() {
    try {
      if (window.PAWAuth && typeof window.PAWAuth.whenReady === "function") {
        await window.PAWAuth.whenReady();
      }
    } catch (_) {}
  }

  const PAWUsage = (function () {
    let _apiEndpoint = "";
    let _summary = null;
    let _loadPromise = null;

    function formatPlanKey(planKey) {
      const raw = String(planKey || "").trim();
      if (!raw) return "";
      return raw
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
    }

    function normalizeSummary(source) {
      const raw = source && typeof source === "object" ? source : {};
      const planKey = String(raw.plan_key || raw.planKey || "").trim();
      const planStatus = String(raw.plan_status || raw.planStatus || "none").trim().toLowerCase();
      const planName = formatPlanKey(planKey);

      let percentUsed = Number(
        raw.percent_used != null ? raw.percent_used :
        raw.percentUsed != null ? raw.percentUsed :
        NaN
      );

      if (!Number.isFinite(percentUsed)) {
        const used = Number(
          raw.usage_consumed_microunits != null ? raw.usage_consumed_microunits :
          raw.usageConsumedMicrounits != null ? raw.usageConsumedMicrounits :
          raw.used
        );
        const limit = Number(
          raw.usage_limit_microunits != null ? raw.usage_limit_microunits :
          raw.usageLimitMicrounits != null ? raw.usageLimitMicrounits :
          raw.limit
        );
        if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
          percentUsed = (used / limit) * 100;
        }
      }

      if (!Number.isFinite(percentUsed)) percentUsed = 0;
      percentUsed = Math.max(0, Math.min(100, Math.round(percentUsed)));

      const overLimit = !!(
        raw.is_over_limit ||
        raw.isOverLimit ||
        raw.over_limit ||
        raw.overLimit
      );

      let warningLevel = String(raw.warning_level || raw.warningLevel || "").trim().toLowerCase();
      if (!warningLevel) {
        if (overLimit) warningLevel = "over";
        else if (percentUsed >= 90) warningLevel = "90";
        else if (percentUsed >= 75) warningLevel = "75";
        else warningLevel = "none";
      }

      if (!planName && planStatus === "none") return null;

      return {
        planName,
        planStatus,
        percentUsed,
        overLimit,
        warningLevel,
        cycleEndAt: raw.cycle_end_at || raw.cycleEndAt || null
      };
    }

    async function fetchSummary() {
      if (!_apiEndpoint) return null;

      const token = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : "";
      if (!token) return null;

      // Assumption: backend exposes a lightweight authenticated summary endpoint
      // at /usage-summary for the currently authenticated PAW user.
      const url = String(_apiEndpoint || "").replace(/\/+$/, "") + "/usage-summary";
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        }
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      if (data && data.summary) return normalizeSummary(data.summary);
      if (data && data.ok === false && data.error === "entitlement_not_found") {
        return normalizeSummary(data.summary || null);
      }
      return normalizeSummary((data && data.data) || data);
    }

    function ensureHeaderPillMount() {
      const row = document.querySelector(".topbar-row0");
      if (!row) return null;

      let right = row.querySelector(".topbar-right");
      if (!right) right = row;

      let slot = right.querySelector(".paw-plan-usage-slot");
      if (!slot) {
        slot = document.createElement("div");
        slot.className = "paw-plan-usage-slot";
        if (right === row) slot.classList.add("is-row-fallback");
        right.insertBefore(slot, right.firstChild || null);
      }

      let pill = slot.querySelector(".paw-plan-usage-pill");
      if (!pill) {
        pill = document.createElement("div");
        pill.className = "paw-plan-usage-pill";
        pill.setAttribute("aria-live", "polite");
        pill.hidden = true;
        slot.appendChild(pill);
      }

      return pill;
    }

    function ensureWarningMount() {
      const topbar = document.querySelector(".panel-topbar");
      if (!topbar) return null;

      let banner = topbar.querySelector(".paw-plan-usage-banner");
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "paw-plan-usage-banner";
        banner.hidden = true;

        const row = topbar.querySelector(".topbar-row0");
        if (row && row.parentNode === topbar) {
          topbar.insertBefore(banner, row.nextSibling);
        } else {
          topbar.appendChild(banner);
        }
      }

      return banner;
    }

    function getWarningClass(summary) {
      if (!summary) return "";
      if (summary.overLimit || summary.warningLevel === "over") return " is-over-limit";
      if (summary.percentUsed >= 90 || summary.warningLevel === "90") return " is-high";
      if (summary.percentUsed >= 75 || summary.warningLevel === "75") return " is-warning";
      return "";
    }

    function getBannerCopy(summary) {
      if (!summary) return "";
      if (summary.overLimit || summary.warningLevel === "over") {
        return "This plan is currently over its tool usage limit.";
      }
      if (summary.percentUsed >= 90 || summary.warningLevel === "90") {
        return "This plan is close to its tool usage limit.";
      }
      if (summary.percentUsed >= 75 || summary.warningLevel === "75") {
        return "This plan has passed 75% of its tool usage limit.";
      }
      return "";
    }

    function render() {
      const pill = ensureHeaderPillMount();
      const slot = pill && pill.parentNode ? pill.parentNode : null;
      if (pill) {
        if (_summary) {
          if (slot) slot.hidden = false;
          pill.textContent = _summary.planName + " " + _summary.percentUsed + "% used";
          pill.hidden = false;
          pill.className = "paw-plan-usage-pill" + getWarningClass(_summary);
        } else {
          if (slot) slot.hidden = true;
          pill.hidden = true;
          pill.className = "paw-plan-usage-pill";
        }
      }

      const banner = ensureWarningMount();
      if (banner) {
        const copy = getBannerCopy(_summary);
        if (!copy) {
          banner.hidden = true;
          banner.textContent = "";
          banner.className = "paw-plan-usage-banner";
        } else {
          banner.textContent = copy;
          banner.hidden = false;
          banner.className = "paw-plan-usage-banner" + getWarningClass(_summary);
        }
      }
    }

    async function load(apiEndpoint) {
      if (apiEndpoint) _apiEndpoint = String(apiEndpoint || "");
      if (_loadPromise) return _loadPromise;

      _loadPromise = (async function () {
        await waitForPAWAuthReady();
        try {
          _summary = await fetchSummary();
        } catch (_) {
          _summary = null;
        }
        render();
        return _summary;
      })();

      return _loadPromise;
    }

    function scheduleRender() {
      try {
        requestAnimationFrame(render);
      } catch (_) {
        setTimeout(render, 0);
      }
    }

    return { load, scheduleRender, getSummary: function () {
      return _summary ? Object.assign({}, _summary) : null;
    } };
  })();

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
    // Wait for PAW auth before normal AI requests so bearer auth is available
    // when Circle identity has already been handed off.
    await waitForPAWAuthReady();

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
      try {
        const originTool = _inferOriginToolFromPage(toolId);
        _setWorksCreateContext({
          toolId: toolId,
          originTool: originTool,
          contentKind: _inferContentKindFromPage(originTool),
          primaryEntityType: _inferPrimaryEntityType("", originTool),
          summary: ""
        });
      } catch (_) {}

      // Phase 3: initialize Circle identity + token minting (in-memory only)
      try { PAWAuth.init(apiEndpoint); } catch (_) {}
      try { PAWUsage.load(apiEndpoint); } catch (_) {}

      const $messages = $("messages");
      const $input = $("input") || $("prompt");
      const $send = $("send") || $("submitBtn");
      const $reset = $("reset");
      const $tips = $("tips");
      const $toolForm = $("toolForm");

      try { PAWUsage.scheduleRender(); } catch (_) {}


      function ensureInlineDeliverableCopyLink(bubble, options) {
        const opts = options && typeof options === "object" ? options : {};
        const onCopy = typeof opts.onCopy === "function" ? opts.onCopy : null;
        const onOpen = typeof opts.onOpen === "function" ? opts.onOpen : null;
        const bubbleOpensModal = opts.bubbleOpensModal !== false;
        if (!bubble || !onCopy) return;

        try {
          const block = bubble.closest && bubble.closest(".paw-message-block");
          const row = block && block.querySelector ? block.querySelector(".paw-report-row") : null;
          if (!row) return;

          if (bubbleOpensModal && onOpen) {
            bubble.style.cursor = "pointer";
            bubble.title = "Click to open copy options";
            bubble.onclick = function () {
              onOpen();
            };
          } else {
            bubble.style.cursor = "";
            bubble.removeAttribute("title");
            bubble.onclick = null;
          }

          if (row.querySelector(".paw-inline-copy-link")) return;

          const feedbackLink = row.querySelector(".paw-report-link");
          const copyLink = document.createElement("a");
          copyLink.href = "#";
          copyLink.className = "paw-inline-copy-link";
          copyLink.textContent = "Copy";
          copyLink.addEventListener("click", function (e) {
            try { e.preventDefault(); } catch (_) {}
            onCopy();
          });

          const separator = document.createElement("span");
          separator.className = "paw-report-separator";
          separator.setAttribute("aria-hidden", "true");
          separator.textContent = "|";

          row.classList.add("paw-report-row--connect-copy");
          if (feedbackLink) {
            row.insertBefore(separator, feedbackLink);
            row.insertBefore(copyLink, separator);
          } else {
            row.appendChild(copyLink);
            row.appendChild(separator);
          }
        } catch (_) {}
      }

      var lastDeliverableState = null;
      var lastInlineDirectCopyMode = false;

      function isElementInViewport(el) {
        try {
          if (!el || !el.getBoundingClientRect) return true;
          const rect = el.getBoundingClientRect();
          const viewH = window.innerHeight || document.documentElement.clientHeight || 0;
          return rect.top >= 0 && rect.bottom <= viewH;
        } catch (_) {
          return true;
        }
      }

      function scrollDeliverableIntoViewIfNeeded(el) {
        try {
          if (!el || isElementInViewport(el)) return;
          requestAnimationFrame(function () {
            try {
              el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
            } catch (_) {
              try { el.scrollIntoView(true); } catch (_) {}
            }
          });
        } catch (_) {}
      }

      function scrollWorkingStateIntoViewIfNeeded(el) {
        try {
          if (!el || isElementInViewport(el)) return;
          requestAnimationFrame(function () {
            try {
              el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
            } catch (_) {
              try { el.scrollIntoView(false); } catch (_) {}
            }
          });
        } catch (_) {}
      }

      function copyInlineDeliverableState(deliverableState) {
        const state = deliverableState && typeof deliverableState === "object" ? deliverableState : {};
        if (String(state.variant || "").toLowerCase() === "email") {
          copyToClipboard(String(state.body || ""));
          showToast("Body copied");
          return;
        }
        copyToClipboard(String(state.text || ""));
        showToast("Copied");
      }

      function getCurrentSaveSnapshot() {
        var shellState = null;
        var prefs = {};
        var extraPayload = {};

        try { shellState = getState(); } catch (_) { shellState = null; }
        try { prefs = getPrefs ? getPrefs() : {}; } catch (_) { prefs = {}; }
        try {
          var currentInput = $input ? String($input.value || "") : "";
          extraPayload = getExtraPayload ? getExtraPayload(currentInput) : {};
        } catch (_) {
          extraPayload = {};
        }

        return {
          toolId: toolId,
          shellState: shellState && typeof shellState === "object" ? shellState : { history: [], input: "" },
          prefs: prefs && typeof prefs === "object" ? prefs : {},
          extraPayload: extraPayload && typeof extraPayload === "object" ? extraPayload : {},
          deliverable: lastDeliverableState && typeof lastDeliverableState === "object" ? lastDeliverableState : null
        };
      }

      try {
        window.PAWToolShell._getCurrentSaveSnapshot = getCurrentSaveSnapshot;
      } catch (_) {}

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
            const lastAiBubble = aiBubbles[aiBubbles.length - 1];

            const toolTitle = (typeof getDeliverableTitle === "function") ? getDeliverableTitle() : "";
            const historyTail = (typeof getHistoryForSend === "function") ? (function () {
              try {
                const h = getHistoryForSend();
                return Array.isArray(h) ? h.slice(-4) : [];
              } catch (_) { return []; }
            })() : [];

            aiBubbles.forEach(function (bubble) {
              // If link row already exists, do nothing.
              const block = bubble && bubble.closest ? bubble.closest(".paw-message-block") : null;
              const hasRow = block && block.querySelector && block.querySelector(".paw-report-row");
              if (!hasRow) {
                attachBadResponseLink(bubble, {
                  toolId: toolId,
                  toolTitle: toolTitle,
                  userMessage: getLastUserBubbleText(),
                  historyTail: historyTail,
                  aiOutput: getAiBubbleText(bubble),
                  createdAt: new Date().toISOString(),
                  pageUrl: (typeof location !== "undefined" ? location.href : ""),
                });
              }

              if (bubble === lastAiBubble && inlineDeliverableCopy) {
                ensureInlineDeliverableCopyLink(bubble, {
                  onCopy: function () {
                    if (!lastDeliverableState) return;
                    if (lastInlineDirectCopyMode) {
                      copyInlineDeliverableState(lastDeliverableState);
                      return;
                    }
                    showDeliverableModal(lastDeliverableState);
                  },
                  onOpen: function () {
                    if (lastDeliverableState) showDeliverableModal(lastDeliverableState);
                  },
                  bubbleOpensModal: !lastInlineDirectCopyMode
                });
              }
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
      const getDeliverableMeta =
        typeof config.getDeliverableMeta === "function" ? config.getDeliverableMeta : null;
      const onResponse = typeof config.onResponse === "function" ? config.onResponse : null;

      // NEW: tool can gate sending (listing uses this for POI modal before write)
      const beforeSend =
        typeof config.beforeSend === "function" ? config.beforeSend : null;
      const composerWorkingConfig =
        config.composerWorkingState && typeof config.composerWorkingState === "object"
          ? config.composerWorkingState
          : null;
      const composerWorkingEnabled = !!($input && composerWorkingConfig && composerWorkingConfig.enabled === true);
      const composerWorkingMessage =
        safeText(composerWorkingConfig && composerWorkingConfig.message) || "PAW is on it";
      const $composer = $input && $input.closest ? $input.closest(".composer") : null;
      const $composerStatusMountParent = $composer && $composer.parentElement ? $composer.parentElement : null;
      const $composerStatusMountBefore =
        $messages && $composerStatusMountParent && $messages.parentElement === $composerStatusMountParent
          ? $messages
          : $composer;
      const $composerMain =
        $input && $input.closest
          ? ($input.closest(".composer-main") || $input.parentElement || null)
          : null;

      const deliverableMode = config.deliverableMode !== false; // default true
      const inlineDeliverableCopy = config.inlineDeliverableCopy === true;
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
      let composerWorkingSnapshot = null;
      let $composerBusyMessage = null;
      let $composerBusyMessageLabel = null;

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
        composerWorkingSnapshot = null;
        clearComposerWorkingUi();
        if ($input) {
            $input.value = "";
            // Auto-grow: return to baseline height when reset clears the composer
            try { resetAutoGrowTextarea($input); } catch (_) {}
            try { updateSendEnabled(); } catch (_) {}
   }

        if ($input && opts.keepFocus) {
          try { $input.focus(); } catch (_) {}
        }
      }

      function ensureComposerBusyMessage() {
        try {
          if (!composerWorkingEnabled) return null;
          if (!$input || (!$composerStatusMountParent && !$composerMain)) return null;
          if (!$composerBusyMessage) {
            const node = document.createElement("div");
            node.className = "paw-composer-status";
            node.setAttribute("aria-live", "polite");
            node.setAttribute("role", "status");
            node.hidden = true;
            const label = document.createElement("span");
            label.className = "paw-composer-status__label";
            const dots = document.createElement("span");
            dots.className = "paw-composer-status__dots";
            dots.setAttribute("aria-hidden", "true");
            for (let i = 0; i < 3; i += 1) {
              dots.appendChild(document.createElement("span"));
            }
            node.appendChild(label);
            node.appendChild(dots);
            $composerBusyMessage = node;
            $composerBusyMessageLabel = label;
          }
          if ($composerStatusMountParent && $composerStatusMountBefore) {
            if (
              $composerBusyMessage.parentNode !== $composerStatusMountParent ||
              $composerBusyMessage.nextSibling !== $composerStatusMountBefore
            ) {
              $composerStatusMountParent.insertBefore($composerBusyMessage, $composerStatusMountBefore);
            }
          } else if ($composerMain) {
            if (
              $composerBusyMessage.parentNode !== $composerMain ||
              $composerBusyMessage !== $composerMain.firstChild
            ) {
              if ($composerMain.firstChild) $composerMain.insertBefore($composerBusyMessage, $composerMain.firstChild);
              else $composerMain.appendChild($composerBusyMessage);
            }
          }
          return $composerBusyMessage;
        } catch (_) {
          return null;
        }
      }

      function setComposerBusyMessageVisible(on) {
        try {
          const node = ensureComposerBusyMessage();
          if (!node) return;
          if (on) {
            if ($composerBusyMessageLabel) $composerBusyMessageLabel.textContent = composerWorkingMessage;
            node.hidden = false;
            return;
          }
          node.hidden = true;
          if ($composerBusyMessageLabel) $composerBusyMessageLabel.textContent = "";
        } catch (_) {}
      }

      function clearComposerWorkingUi() {
        try {
          if (!composerWorkingEnabled) return;
          if ($input) {
            $input.removeAttribute("readonly");
            $input.removeAttribute("data-paw-working");
          }
          if ($composer) $composer.removeAttribute("data-paw-composer-working");
          setComposerBusyMessageVisible(false);
          try { updateSendEnabled(); } catch (_) {}
          pawScheduleLayoutPing();
        } catch (_) {}
      }

      function beginComposerWorkingState(displayText) {
        try {
          if (!composerWorkingEnabled || !$input) return false;
          const text = String(
            typeof displayText === "string" ? displayText : ($input.value || "")
          );
          const rect = $input.getBoundingClientRect ? $input.getBoundingClientRect() : null;
          const height =
            $input.style.height ||
            (rect && rect.height ? Math.max(0, Math.round(rect.height)) + "px" : "");
          composerWorkingSnapshot = {
            text: text,
            scrollTop: $input.scrollTop || 0,
            height: height,
            overflowY: $input.style.overflowY || ""
          };
          $input.value = text;
          if (height) $input.style.height = height;
          $input.style.overflowY = composerWorkingSnapshot.overflowY;
          $input.setAttribute("readonly", "");
          $input.setAttribute("data-paw-working", "1");
          if ($composer) $composer.setAttribute("data-paw-composer-working", "1");
          setComposerBusyMessageVisible(true);
          try { updateSendEnabled(); } catch (_) {}
          try { $input.scrollTop = composerWorkingSnapshot.scrollTop; } catch (_) {}
          requestAnimationFrame(function () {
            try {
              if ($input && composerWorkingSnapshot) $input.scrollTop = composerWorkingSnapshot.scrollTop;
            } catch (_) {}
          });
          pawScheduleLayoutPing();
          return true;
        } catch (_) {
          return false;
        }
      }

      function endComposerWorkingState(options) {
        const opts = options && typeof options === "object" ? options : {};
        const snapshot = composerWorkingSnapshot;
        composerWorkingSnapshot = null;
        clearComposerWorkingUi();
        if (!$input) return;
        if (opts.clear === true) {
          clearComposer({ keepFocus: opts.keepFocus !== false });
          return;
        }
        const restoreText =
          typeof opts.text === "string"
            ? opts.text
            : snapshot && typeof snapshot.text === "string"
              ? snapshot.text
              : String($input.value || "");
        $input.value = restoreText;
        try { autoGrowTextarea($input); } catch (_) {}
        if (snapshot && typeof snapshot.scrollTop === "number") {
          try { $input.scrollTop = snapshot.scrollTop; } catch (_) {}
        }
        try { updateSendEnabled(); } catch (_) {}
        if (opts.keepFocus) {
          try { $input.focus(); } catch (_) {}
        }
        pawScheduleLayoutPing();
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
          '    <div data-deliverable-variant="text">' +
          '      <div class="paw-deliverable-text" style="white-space:pre-wrap; word-break:break-word;"></div>' +
          '      <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:14px;">' +
          '        <button class="btn" type="button" data-action="copy">Copy</button>' +
          '      </div>' +
          '    </div>' +
          '    <div data-deliverable-variant="email" style="display:none;">' +
          '      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;">' +
          '        <div style="font-size:12px; font-weight:800; color:rgba(15,23,42,.68); letter-spacing:.01em; text-transform:uppercase;">Subject</div>' +
          '        <button class="btn" type="button" data-action="copy-subject">Copy Subject</button>' +
          '      </div>' +
          '      <div class="paw-deliverable-email-subject paw-deliverable-text" style="max-height:none; margin-bottom:14px;"></div>' +
          '      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;">' +
          '        <div style="font-size:12px; font-weight:800; color:rgba(15,23,42,.68); letter-spacing:.01em; text-transform:uppercase;">Body</div>' +
          '        <button class="btn" type="button" data-action="copy-body">Copy Body</button>' +
          '      </div>' +
          '      <div class="paw-deliverable-email-body paw-deliverable-text" style="white-space:pre-wrap; word-break:break-word;"></div>' +
          '    </div>' +
          '    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:14px;">' +
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

          if (action === "copy-subject") {
            const subjectEl = modal.querySelector(".paw-deliverable-email-subject");
            const txt = subjectEl ? subjectEl.textContent : "";
            copyToClipboard(txt);
            showToast("Subject copied");
            return;
          }

          if (action === "copy-body") {
            const bodyEl = modal.querySelector(".paw-deliverable-email-body");
            const txt = bodyEl ? bodyEl.textContent : "";
            copyToClipboard(txt);
            showToast("Body copied");
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

      function parseConnectEmailDeliverable(replyText) {
        const text = String(replyText || "").replace(/\r\n?/g, "\n").trim();
        if (!text) return null;

        const match = text.match(/^subject:\s*(.+?)\n\s*\n([\s\S]+)$/i);
        if (!match) return null;

        const subject = String(match[1] || "").trim();
        const body = String(match[2] || "").trim();
        if (!subject || !body) return null;

        return { subject: subject, body: body };
      }

      function stripConnectEmailSignaturePlaceholder(bodyText, deliverableMeta) {
        const meta = deliverableMeta && typeof deliverableMeta === "object" ? deliverableMeta : {};
        if (String(meta.use || "").toLowerCase() !== "once") return String(bodyText || "");

        const normalized = String(bodyText || "").replace(/\r\n?/g, "\n");
        const lines = normalized.split("\n");
        let lastNonEmpty = lines.length - 1;
        while (lastNonEmpty >= 0 && !String(lines[lastNonEmpty] || "").trim()) lastNonEmpty -= 1;
        if (lastNonEmpty < 0) return normalized.trim();
        if (String(lines[lastNonEmpty] || "").trim() !== "[Your Name]") return normalized.trim();

        const kept = lines.slice(0, lastNonEmpty);
        while (kept.length && !String(kept[kept.length - 1] || "").trim()) kept.pop();
        return kept.join("\n").trim();
      }

      function buildDeliverableModalState(title, bodyText, reportMeta) {
        const rawText = String(bodyText || "");
        const meta =
          reportMeta && reportMeta.deliverableMeta && typeof reportMeta.deliverableMeta === "object"
            ? reportMeta.deliverableMeta
            : {};

        if (toolId === "connect" && String(meta.channel || "").toLowerCase() === "email") {
          const parsed = parseConnectEmailDeliverable(rawText);
          if (parsed) {
            return {
              title: String(title || "Your Deliverable"),
              variant: "email",
              subject: parsed.subject,
              body: stripConnectEmailSignaturePlaceholder(parsed.body, meta)
            };
          }
        }

        return {
          title: String(title || "Your Deliverable"),
          variant: "text",
          text: rawText
        };
      }

      function showDeliverableModal(deliverableState) {
        const modal = ensureDeliverableModal();
        const titleEl = modal.querySelector("#pawDeliverableTitle");
        const textWrap = modal.querySelector('[data-deliverable-variant="text"]');
        const emailWrap = modal.querySelector('[data-deliverable-variant="email"]');
        const bodyEl = textWrap ? textWrap.querySelector(".paw-deliverable-text") : null;
        const subjectEl = modal.querySelector(".paw-deliverable-email-subject");
        const emailBodyEl = modal.querySelector(".paw-deliverable-email-body");
        const state = deliverableState && typeof deliverableState === "object" ? deliverableState : {};

        if (titleEl) titleEl.textContent = String(state.title || "Your Deliverable");

        if (String(state.variant || "") === "email") {
          if (textWrap) textWrap.style.display = "none";
          if (emailWrap) emailWrap.style.display = "";
          if (subjectEl) subjectEl.textContent = String(state.subject || "");
          if (emailBodyEl) emailBodyEl.textContent = String(state.body || "");
          if (bodyEl) bodyEl.textContent = "";
        } else {
          if (textWrap) textWrap.style.display = "";
          if (emailWrap) emailWrap.style.display = "none";
          if (bodyEl) bodyEl.textContent = String(state.text || "");
          if (subjectEl) subjectEl.textContent = "";
          if (emailBodyEl) emailBodyEl.textContent = "";
        }

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
        row.style.marginTop = "6px";
        row.style.textAlign = "right";
        row.style.fontSize = "12px";
        const a = document.createElement("a");
        a.href = "#";
        a.className = "paw-report-link";
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
        const messageWrap = appendMessage($messages, "ai", replyText, reportMeta);

        const deliverableMeta =
          reportMeta && reportMeta.deliverableMeta && typeof reportMeta.deliverableMeta === "object"
            ? reportMeta.deliverableMeta
            : null;
        const shouldOpenModal = deliverableMode && (!deliverableMeta || deliverableMeta.openModal !== false);
        const inlineDirectCopyMode = !!(inlineDeliverableCopy && !shouldOpenModal);
        lastInlineDirectCopyMode = inlineDirectCopyMode;

        // Remember the last deliverable so the user can re-open/copy it again.
        lastDeliverableState = buildDeliverableModalState(
          getDeliverableTitle(),
          replyText,
          reportMeta
        );
        try {
          const originTool = _inferOriginToolFromPage(toolId);
          _setWorksCreateContext({
            toolId: toolId,
            originTool: originTool,
            contentKind: _inferContentKindFromPage(originTool),
            primaryEntityType: _inferPrimaryEntityType("", originTool),
            summary: _extractCreateSummary(lastDeliverableState)
          });
        } catch (_) {}

        const openLatestDeliverable = function () {
          showDeliverableModal(lastDeliverableState);
        };
        const copyLatestDeliverable = function () {
          copyInlineDeliverableState(lastDeliverableState);
        };

        if (inlineDeliverableCopy) {
          try {
            const bubble = messageWrap ? messageWrap.querySelector(".bubble") : null;
            if (bubble) {
              ensureInlineDeliverableCopyLink(bubble, {
                onCopy: inlineDirectCopyMode ? copyLatestDeliverable : openLatestDeliverable,
                onOpen: openLatestDeliverable,
                bubbleOpensModal: !inlineDirectCopyMode
              });
            }
          } catch (_) {}
        }

        if (inlineDirectCopyMode) {
          try {
            const deliverableBlock = messageWrap && messageWrap.closest
              ? (messageWrap.closest(".paw-message-block") || messageWrap)
              : messageWrap;
            scrollDeliverableIntoViewIfNeeded(deliverableBlock);
          } catch (_) {}
        }

        if (!shouldOpenModal) {
          $messages.scrollTop = $messages.scrollHeight;
          return;
        }

        // Open a modal with Copy / Revise every time for deliverables.
        showDeliverableModal(lastDeliverableState);

        // UX: allow users to click the most recent AI message to re-open the modal.
        // This solves the common case: they closed the modal, then want to copy again.
        try {
          const aiBubbles = $messages.querySelectorAll(".msg.ai");
          const last = aiBubbles[aiBubbles.length - 1];
          if (last) {
            last.style.cursor = "pointer";
            last.title = "Click to re-open and copy";
            last.onclick = function () {
              showDeliverableModal(lastDeliverableState);
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
        const forceComposerWorking = options.composerWorking === true;
        const shouldUseComposerWorkingState =
          !!(
            composerWorkingEnabled &&
            $input &&
            ((echoUser && safeText($input.value)) || forceComposerWorking)
          );
        const composerDisplayText = shouldUseComposerWorkingState ? String($input.value || "") : "";

        isSending = true;

        // Brand feedback: instant acknowledgement + working ring (click or Enter)
        pawSubmitBump();
        pawSetBusy(true);
        const usedComposerWorkingState = shouldUseComposerWorkingState
          ? beginComposerWorkingState(composerDisplayText)
          : false;

        let sendSucceeded = false;

        // Always-visible progress cue (prevents "nothing is happening" when the chat stream is off-screen)
        if (!composerWorkingEnabled) showWorkingBar("Working…");
        await nextPaint();

        try {
          if (echoUser) {
            appendMessage($messages, "user", msg);
            pushHistory("user", msg);
          }

          const prefs = getPrefs ? getPrefs() : {};
          const baseExtra = getExtraPayload ? getExtraPayload(msg) : {};
          const mergedExtra = Object.assign({}, baseExtra, extraPayload || {});

          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, mergedExtra);
          payload.message = msg;

          const data = await postToWorker(payload);
          sendSucceeded = true;

          if (onResponse) {
            try {
              const r = onResponse(data);
              if (r && r.skipDefault) return data;
            } catch (_) {}
          }

          const reply = safeText(data && data.reply);
          const deliverableMeta = getDeliverableMeta ? getDeliverableMeta(reply, data) : null;
          if (reply) {
            renderDeliverable(reply, {
              toolId: toolId,
              toolTitle: getDeliverableTitle(),
              userMessage: msg,
              extraPayload: extraPayload,
              deliverableMeta: deliverableMeta,
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
          appendMessage($messages, "ai", formatAssistantErrorText(err));
        } finally {
          isSending = false;
          pawSetBusy(false);
          hideWorkingBar();
          if (usedComposerWorkingState) {
            if (sendSucceeded) endComposerWorkingState({ clear: true, keepFocus: true });
            else endComposerWorkingState({ keepFocus: true });
          }
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
        const usedComposerWorkingState = composerWorkingEnabled
          ? beginComposerWorkingState(trimmed)
          : false;

        let sendSucceeded = false;

        // Always-visible progress cue (prevents "nothing is happening" when the chat stream is off-screen)
        if (!composerWorkingEnabled) showWorkingBar("Working…");
        await nextPaint();

        try {
          appendMessage($messages, "user", trimmed);
          pushHistory("user", trimmed);

          const prefs = getPrefs ? getPrefs() : {};
          const extraPayload = getExtraPayload ? getExtraPayload(trimmed) : {};
          const payload = buildPayloadBase(toolId, getHistoryForSend(), prefs, extraPayload);
          payload.message = trimmed;

          const data = await postToWorker(payload);
          sendSucceeded = true;

          if (onResponse) {
            try {
              const r = onResponse(data);
              if (r && r.skipDefault) return;
            } catch (_) {}
          }

          const reply = safeText(data && data.reply);
          const deliverableMeta = getDeliverableMeta ? getDeliverableMeta(reply, data) : null;
          if (reply) {
            renderDeliverable(reply, {
              toolId: toolId,
              toolTitle: getDeliverableTitle(),
              userMessage: trimmed,
              extraPayload: extraPayload,
              deliverableMeta: deliverableMeta,
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
          appendMessage($messages, "ai", formatAssistantErrorText(err));
        } finally {
          isSending = false;
          pawSetBusy(false);
          hideWorkingBar();
          if (usedComposerWorkingState) {
            if (sendSucceeded) endComposerWorkingState({ clear: true, keepFocus: true });
            else endComposerWorkingState({ keepFocus: true });
          }
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
          composerWorkingSnapshot = null;
          clearComposerWorkingUi();
          if ($input) $input.value = "";
          lastDeliverableState = null;
          try { _setWorksCreateContext({ summary: "" }); } catch (_) {}

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
            composerWorkingSnapshot = null;
            clearComposerWorkingUi();
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
//
// SHARED WORK CONTRACT:
// - tool-shell.js owns the shared Work button behavior everywhere it is loaded.
// - tool-shell.js owns Works mode open/close, Work status text, Works root mounting,
//   attached/detached session state, saved-work list rendering, and cross-page handoff.
// - Tool pages may host the button markup and consume the public APIs/events below,
//   but they must not reimplement click/open/close/status/mount behavior locally.
// - If a future tool needs Work-aware behavior, integrate through PAWToolShell.init(),
//   window.__PAWWorks.getActiveWork(), window.__PAWWorks.detachWork(), and the
//   paw:works:* events. Do not add a second Work system in a tool file.
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
  var __worksApiEndpoint = "";
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

// CROSS-PAGE MY WORKS HANDOFF CONTRACT:
// - myworks.html is the only page that writes the one-time launch handoff key.
// - It stores { work_id, bucket, label } so a destination tool can boot with
//   the selected work already attached after page-driven navigation from My Works.
// - tool-shell.js consumes that handoff once on destination boot, attaches the
//   work into shared session state, and clears the handoff immediately.
// - Destination tools should react to active_work after boot; they should not
//   parse this sessionStorage key directly or invent a second handoff path.
var PAW_LAUNCH_WORK_HANDOFF_KEY = "paw:launch_saved_work_handoff:v1";

function consumeLaunchWorkHandoff(){
  try{
    if (__pawActiveWork) return null;
    function normalizeLaunchWork(raw){
      var parsed = raw && typeof raw === "object" ? raw : null;
      var workId = parsed
        ? String(parsed.work_id || parsed.id || "").trim()
        : "";
      var bucket = parsed
        ? String(parsed.bucket || "").trim()
        : "";
      var label = parsed
        ? String(parsed.label || "").trim()
        : "";

      if (!workId) return null;
      if (!bucket) bucket = String(_inferWorkBucketFromPage() || "").trim();

      return {
        id: workId,
        work_id: workId,
        bucket: bucket,
        label: label || "Untitled"
      };
    }

    var handoff = null;

    try{
      if (window.sessionStorage){
        var raw = sessionStorage.getItem(PAW_LAUNCH_WORK_HANDOFF_KEY);
        if (raw){
          try{ sessionStorage.removeItem(PAW_LAUNCH_WORK_HANDOFF_KEY); }catch(_){ }
          var parsed = null;
          try{ parsed = JSON.parse(raw); }catch(_){ parsed = null; }
          handoff = normalizeLaunchWork(parsed);
        }
      }
    }catch(_){ }

    if (!handoff){
      try{
        var qp = new URLSearchParams((window.location && window.location.search) || "");
        handoff = normalizeLaunchWork({
          work_id: qp.get("work_id") || "",
          bucket: qp.get("bucket") || "",
          label: qp.get("label") || ""
        });
      }catch(_){ }
    }

    if (!handoff) return null;

    attachWork(handoff);
    return handoff;
  }catch(_){
    return null;
  }
}


// Exposed helpers for Works mode.
// NOTE: These are intentionally assigned inside ensureWorksRoot() so enterWorksMode()
// can render Works content immediately without changing the fragile container mechanics.
var renderWorksBody = function(){ };
var _touchRecent = function(){ };
var __worksReloadWorksListFn = null;
var __worksEnsureWorksListLoadedFn = null;

function mountWorksRootIntoPanel(){
  try{
    if (!__worksRoot) return;
    var panel = document.querySelector(".panel") || __toolRoot || findToolRoot() || document.body;
    if (!panel) return;
    var topbar = panel.querySelector ? panel.querySelector(".panel-topbar") : null;
    if (topbar && topbar.parentNode === panel){
      panel.insertBefore(__worksRoot, topbar.nextSibling);
    } else {
      panel.appendChild(__worksRoot);
    }
  }catch(_){ }
}

function ensureWorksRoot(){
  if (__worksRoot && document.body.contains(__worksRoot)){
    mountWorksRootIntoPanel();
    return __worksRoot;
  }

  // WORKS ROOT MOUNTING CONTRACT:
  // - This shared root is created once and mounted on document.body.
  // - Works mode reuses the live tool page instead of navigating away:
  //   the active tool surface is hidden, this root is shown, and the
  //   real Work button/status nodes are moved into this header.
  // - Tool pages must not create their own Works container, clone the
  //   Work button, or try to mount content into #pawWorksModeRoot.
  __worksRoot = document.createElement("div");
  __worksRoot.id = "pawWorksModeRoot";
  __worksRoot.setAttribute("role","region");
  __worksRoot.setAttribute("aria-label","My Works");
  __worksRoot.style.position = "relative";
  __worksRoot.style.inset = "auto";
  __worksRoot.style.zIndex = "auto";

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

    if (t.getAttribute("data-paw-works-attach") === "1"){
      var b = t.getAttribute("data-bucket") || "";
      var id = t.getAttribute("data-id") || "";
      var chosen = null;

      try{
        for (var i=0;i<(__worksListItems||[]).length;i++){
          var w = __worksListItems[i];
          if (w && String(w.bucket||"") === String(b) && String(w.id||"") === String(id)){
            chosen = w;
            break;
          }
        }
      }catch(_){ }

      if (!chosen){
        try{
          for (var j=0;j<(__worksRecent||[]).length;j++){
            var wr = __worksRecent[j];
            if (wr && String(wr.bucket||"") === String(b) && String(wr.id||"") === String(id)){
              chosen = wr;
              break;
            }
          }
        }catch(_){ }
      }

      attachWork(chosen || { bucket:b, id:id, label:"Untitled" });
      exitWorksMode();
      return;
    }

    // Detach from this session
    if (t.getAttribute("data-paw-works-detach") === "1"){
      detachWork();
      return;
    }

    if (t.getAttribute("data-paw-works-save-new") === "1"){
      openWorkNameModal("", async function(name){
        try{ if (window.PAWAuth && window.PAWAuth.whenReady) await window.PAWAuth.whenReady().catch(function(){}); }catch(_){ }
        var resolvedBucket = _resolveCreateWorkBucket();
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
          setTimeout(function(){ emitWorksSave("save_updates"); }, 0);
          _touchRecent(nw);
          await reloadWorksList({ append:false });
          emitWorksSave("create");
          _worksToast("Saved.");
        }catch(err){
          _worksToast((err && err.message) ? err.message : "Couldn’t save right now.");
        }
      });
      return;
    }

    if (t.getAttribute("data-paw-works-save-as-new") === "1"){
      openWorkNameModal("", async function(name){
        try{ if (window.PAWAuth && window.PAWAuth.whenReady) await window.PAWAuth.whenReady().catch(function(){}); }catch(_){ }
        var resolvedBucket = _resolveCreateWorkBucket();
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
          setTimeout(function(){ emitWorksSave("save_updates"); }, 0);
          _touchRecent(nw);
          await reloadWorksList({ append:false });
          emitWorksSave("save_as_new");
          _worksToast("Saved.");
        }catch(err){
          _worksToast((err && err.message) ? err.message : "Couldn’t save right now.");
        }
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
      reloadWorksList({ append:true });
      return;
    }

    if (t.getAttribute("data-paw-works-delete") === "1"){
      var deleteBucket = t.getAttribute("data-bucket") || "";
      var deleteId = t.getAttribute("data-id") || "";
      var deleteLabel = t.getAttribute("data-label") || "Untitled";
      if (!deleteBucket || !deleteId) return;
      __worksPendingDelete = { bucket: deleteBucket, id: deleteId, label: deleteLabel };
      openWorkDeleteModal(__worksPendingDelete, async function(){
        try{
          await deleteMyWork(deleteId);
          _removeWorkFromSessionState(deleteBucket, deleteId);
          await reloadWorksList({ append:false });
          _worksToast("Deleted.");
          __worksPendingDelete = null;
        }catch(err){
          var msg = (err && err.message) ? err.message : "Couldn’t delete right now.";
          _worksToast(msg);
          return;
        }
      });
      return;
    }

    if (t.getAttribute("data-paw-works-retry") === "1"){
      reloadWorksList({ append:false });
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

  mountWorksRootIntoPanel();
  // ------------------------------------------------------------
  // Works Mode UI (content inside the already-working container)
  // ------------------------------------------------------------
  // SAFETY PRINCIPLE:
  // - Do NOT change the Works container mechanics (enter/exit, mounting, layout).
  // - Only render content inside .paw-works-mode__body.
  //
  // This is session-only UI: no persistence is assumed here.

  var __worksRecent = [];   // Session-only MRU for active-context convenience.
  var __worksSearchQ = "";
  var __worksBucketFilter = "all"; // all | brand_assets | listings | transactions
  var __worksListLimit = 25;
  var __worksListItems = [];
  var __worksNextCursor = "";
  var __worksListLoading = false;
  var __worksListError = "";
  var __worksListHasLoaded = false;
  var __worksPendingDelete = null;
  var __worksCreateContext = {
    toolId: "",
    originTool: "",
    contentKind: "",
    primaryEntityType: "",
    summary: ""
  };

  function _workTypeLabel(bucket){
    if (bucket === "brand_assets") return "Brand Asset";
    if (bucket === "listings") return "Listing";
    if (bucket === "transactions") return "Transaction";
    return "Work";
  }

  function _workOriginToolLabel(work){
    var raw = "";
    try{
      raw = String(
        (work && work.origin_tool) ||
        ((((work || {}).payload || {}).portable || {}).origin_tool) ||
        ""
      ).trim().toLowerCase();
    }catch(_){ raw = ""; }
    if (raw === "listing") return "Listings";
    if (raw === "guide") return "Guide";
    if (raw === "connect") return "Connect";
    if (raw === "presence") return "Presence";
    if (raw === "transaction" || raw === "transactions") return "Transactions";
    return "";
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

  function _inferOriginToolFromPage(toolId){
    var rawToolId = String(toolId || "").trim().toLowerCase();
    if (rawToolId === "listing_description_writer") return "listing";
    if (rawToolId === "assistant") return "guide";
    if (rawToolId === "connect") return "connect";
    if (rawToolId === "presence") return "presence";
    if (rawToolId === "transactions" || rawToolId === "transaction") return "transactions";
    if (rawToolId === "guide") return "guide";
    try{
      var path = String((window.location && window.location.pathname) || "").toLowerCase();
      if (path.indexOf("listing.html") !== -1) return "listing";
      if (path.indexOf("guide.html") !== -1) return "guide";
      if (path.indexOf("connect.html") !== -1) return "connect";
      if (path.indexOf("presence.html") !== -1) return "presence";
      if (path.indexOf("transactions.html") !== -1) return "transactions";
    }catch(_){ }
    return rawToolId;
  }

  function _inferContentKindFromPage(originTool){
    if (String(originTool || "").toLowerCase() === "listing") return "listing_description";
    return "";
  }

  function _inferPrimaryEntityType(bucket, originTool){
    var normalizedBucket = String(bucket || "").trim().toLowerCase();
    if (normalizedBucket === "listings" || normalizedBucket === "listing") return "property";
    if (normalizedBucket === "transactions" || normalizedBucket === "transaction") return "transaction";

    var normalizedOriginTool = String(originTool || "").trim().toLowerCase();
    if (normalizedOriginTool === "listing") return "property";
    if (normalizedOriginTool === "transactions" || normalizedOriginTool === "transaction") return "transaction";

    try{
      var activeBucket = (__pawActiveWork && __pawActiveWork.bucket) ? String(__pawActiveWork.bucket || "").trim().toLowerCase() : "";
      if (activeBucket === "listings" || activeBucket === "listing") return "property";
      if (activeBucket === "transactions" || activeBucket === "transaction") return "transaction";
    }catch(_){ }

    return "";
  }

  function _normalizeCreateSummary(value){
    var text = String(value || "").replace(/\r\n?/g, "\n");
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length > 280) return text.slice(0, 277).trim() + "...";
    return text;
  }

  function _cloneCreateData(value){
    if (!value || typeof value !== "object") return null;
    try{
      return JSON.parse(JSON.stringify(value));
    }catch(_){
      return null;
    }
  }

  function _hasCreateData(value){
    if (!value || typeof value !== "object") return false;
    for (var key in value){
      if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    }
    return false;
  }

  function _normalizeCreateBucket(bucket){
    var normalized = String(bucket || "").trim().toLowerCase();
    if (normalized === "brand") return "brand_assets";
    if (normalized === "listing") return "listings";
    if (normalized === "transaction" || normalized === "deal" || normalized === "deals") return "transactions";
    return normalized;
  }

  function _getCurrentSaveSnapshot(){
    try{
      if (window.PAWToolShell && typeof window.PAWToolShell._getCurrentSaveSnapshot === "function"){
        var snapshot = window.PAWToolShell._getCurrentSaveSnapshot();
        return snapshot && typeof snapshot === "object" ? snapshot : null;
      }
    }catch(_){ }
    return null;
  }

  function _getSnapshotActiveListing(snapshot){
    try{
      var extraPayload = snapshot && snapshot.extraPayload && typeof snapshot.extraPayload === "object"
        ? snapshot.extraPayload
        : null;
      var listing = extraPayload && extraPayload.active_listing && typeof extraPayload.active_listing === "object"
        ? extraPayload.active_listing
        : null;
      return listing || null;
    }catch(_){
      return null;
    }
  }

  function _getTransactionsSaveContext(snapshot, originTool){
    var normalizedOriginTool = String(originTool || "").trim().toLowerCase();
    if (normalizedOriginTool !== "transactions" && normalizedOriginTool !== "transaction") return null;

    var extraPayload = snapshot && snapshot.extraPayload && typeof snapshot.extraPayload === "object"
      ? snapshot.extraPayload
      : null;
    if (!extraPayload) return null;

    var sessionId = String(
      extraPayload.session_id ||
      extraPayload.contract_session_id ||
      ""
    ).trim();
    var mode = String(
      extraPayload.transactions_mode ||
      extraPayload.transaction_mode ||
      ""
    ).trim().toLowerCase();
    var allowedModes = {
      form_help: true,
      client_report: true,
      write_terms: true,
      negotiation: true
    };

    var context = {};
    if (sessionId) context.session_id = sessionId;
    if (allowedModes[mode]) context.transactions_mode = mode;
    return _hasCreateData(context) ? context : null;
  }

  function _extractCreateSummary(state){
    var deliverable = state && typeof state === "object" ? state : null;
    if (!deliverable) return "";
    if (String(deliverable.variant || "").toLowerCase() === "email"){
      if (deliverable.subject) return _normalizeCreateSummary(deliverable.subject);
      if (deliverable.body) return _normalizeCreateSummary(String(deliverable.body || "").split("\n")[0]);
      return "";
    }
    return _normalizeCreateSummary(String(deliverable.text || "").split("\n")[0]);
  }

  function _setWorksCreateContext(next){
    var patch = next && typeof next === "object" ? next : {};
    __worksCreateContext = {
      toolId: patch.toolId != null ? String(patch.toolId || "") : String(__worksCreateContext.toolId || ""),
      originTool: patch.originTool != null ? String(patch.originTool || "") : String(__worksCreateContext.originTool || ""),
      contentKind: patch.contentKind != null ? String(patch.contentKind || "") : String(__worksCreateContext.contentKind || ""),
      primaryEntityType: patch.primaryEntityType != null ? String(patch.primaryEntityType || "") : String(__worksCreateContext.primaryEntityType || ""),
      summary: patch.summary != null ? String(patch.summary || "") : String(__worksCreateContext.summary || "")
    };
  }

  function _extractCreateSummaryFromWork(work){
    if (!work || typeof work !== "object") return "";
    var summary = "";
    try{ summary = _workPreviewSummary(work); }catch(_){ summary = ""; }
    summary = _normalizeCreateSummary(summary);
    if (!summary || summary === "Untitled") return "";
    return summary;
  }

  function _extractCreateSummaryFromShellState(snapshot){
    var shellState = snapshot && snapshot.shellState && typeof snapshot.shellState === "object"
      ? snapshot.shellState
      : null;
    if (!shellState) return "";

    var input = _normalizeCreateSummary(shellState.input);
    if (input) return input;

    var history = Array.isArray(shellState.history) ? shellState.history : [];
    for (var i = history.length - 1; i >= 0; i--){
      var item = history[i];
      var content = _normalizeCreateSummary(item && item.content);
      if (content) return content;
    }

    return "";
  }

  function _resolveCreateSummary(snapshot, activeWork){
    var deliverableSummary = _extractCreateSummary(snapshot && snapshot.deliverable);
    if (deliverableSummary) return deliverableSummary;

    var activeListing = _getSnapshotActiveListing(snapshot);
    if (activeListing){
      var listingSummary = _extractCreateSummaryFromWork({
        label: activeListing.label || "",
        payload: (activeListing.pds && typeof activeListing.pds === "object") ? { pds: activeListing.pds } : null
      });
      if (listingSummary) return listingSummary;
    }

    var attachedSummary = _extractCreateSummaryFromWork(activeWork);
    if (attachedSummary) return attachedSummary;

    var shellSummary = _extractCreateSummaryFromShellState(snapshot);
    if (shellSummary) return shellSummary;

    return _normalizeCreateSummary(__worksCreateContext.summary);
  }

  function _resolveCreateWorkBucket(snapshot){
    try{
      if (__pawActiveWork && __pawActiveWork.bucket){
        var activeBucket = _normalizeCreateBucket(__pawActiveWork.bucket);
        if (activeBucket === "listings" || activeBucket === "transactions") return activeBucket;
      }
    }catch(_){ }

    if (_getSnapshotActiveListing(snapshot)) return "listings";

    try{
      if (__pawActiveWork && __pawActiveWork.bucket){
        var fallbackActiveBucket = _normalizeCreateBucket(__pawActiveWork.bucket);
        if (fallbackActiveBucket) return fallbackActiveBucket;
      }
    }catch(_){ }

    var fallbackBucket = _normalizeCreateBucket(_inferWorkBucketFromPage());
    return fallbackBucket || "brand_assets";
  }

  function _inferContentKindFromSaveSnapshot(snapshot, originTool){
    var deliverable = snapshot && snapshot.deliverable && typeof snapshot.deliverable === "object"
      ? snapshot.deliverable
      : null;
    var variant = deliverable ? String(deliverable.variant || "").trim().toLowerCase() : "";
    if (variant === "email") return "email";

    var prefs = snapshot && snapshot.prefs && typeof snapshot.prefs === "object" ? snapshot.prefs : null;
    var contentType = prefs ? String(prefs.content_type || "").trim() : "";
    if (contentType) return contentType;

    return _inferContentKindFromPage(originTool) || String(__worksCreateContext.contentKind || "").trim();
  }

  function _buildCreatePayload(snapshot, activeWork, originTool, contentKind, summary, transactionsSaveContext){
    var payload = {};
    var activePayload = activeWork && activeWork.payload && typeof activeWork.payload === "object"
      ? _cloneCreateData(activeWork.payload)
      : null;

    if (activePayload && _hasCreateData(activePayload)){
      payload = activePayload;
    }

    var activeListing = _getSnapshotActiveListing(snapshot);
    if (activeListing && activeListing.pds && typeof activeListing.pds === "object" && !payload.pds){
      var listingPds = _cloneCreateData(activeListing.pds);
      if (listingPds) payload.pds = listingPds;
    }

    var portable = payload.portable && typeof payload.portable === "object"
      ? Object.assign({}, payload.portable)
      : {};
    var deliverable = snapshot && snapshot.deliverable && typeof snapshot.deliverable === "object"
      ? snapshot.deliverable
      : null;
    var shellState = snapshot && snapshot.shellState && typeof snapshot.shellState === "object"
      ? snapshot.shellState
      : null;

    if (originTool && !portable.origin_tool) portable.origin_tool = originTool;
    if (contentKind && !portable.content_kind) portable.content_kind = contentKind;
    if (summary) portable.summary = summary;

    var intentText = _normalizeCreateSummary(shellState && shellState.input);
    if (intentText && !portable.intent_text) portable.intent_text = intentText;

    if (deliverable){
      var variant = String(deliverable.variant || "").trim().toLowerCase();
      if (variant) portable.variant = variant;
      if (variant === "email"){
        if (deliverable.subject) portable.subject = String(deliverable.subject || "");
        if (deliverable.body) portable.body = String(deliverable.body || "");
      } else if (deliverable.text) {
        portable.text = String(deliverable.text || "");
      }
    }

    if (_hasCreateData(portable)) payload.portable = portable;

    var toolState = payload.tool_state && typeof payload.tool_state === "object"
      ? Object.assign({}, payload.tool_state)
      : {};
    var prefs = snapshot && snapshot.prefs && typeof snapshot.prefs === "object"
      ? _cloneCreateData(snapshot.prefs)
      : null;
    var toolId = snapshot && snapshot.toolId ? String(snapshot.toolId || "") : "";
    var hasShellHistory = !!(shellState && Array.isArray(shellState.history) && shellState.history.length);
    var hasShellInput = !!(shellState && typeof shellState.input === "string" && shellState.input.trim());

    toolState.v = toolState.v || 1;
    if (toolId) toolState.toolId = toolId;
    if (hasShellHistory || hasShellInput){
      toolState.shell = {
        history: hasShellHistory ? shellState.history : [],
        input: hasShellInput ? String(shellState.input || "") : ""
      };
    }
    if (transactionsSaveContext){
      var transactionsState = toolState.transactions && typeof toolState.transactions === "object"
        ? Object.assign({}, toolState.transactions)
        : {};
      if (transactionsSaveContext.session_id) {
        toolState.session_id = String(transactionsSaveContext.session_id || "");
        transactionsState.session_id = String(transactionsSaveContext.session_id || "");
      }
      if (transactionsSaveContext.transactions_mode) {
        toolState.transactions_mode = String(transactionsSaveContext.transactions_mode || "");
        transactionsState.mode = String(transactionsSaveContext.transactions_mode || "");
      }
      if (_hasCreateData(transactionsState)) toolState.transactions = transactionsState;
    }
    if (prefs && _hasCreateData(prefs)) toolState.prefs = prefs;
    if (_hasCreateData(toolState)) payload.tool_state = toolState;

    return _hasCreateData(payload) ? payload : {};
  }

  function _resolveCreateOriginTool(snapshot){
    var toolId = snapshot && snapshot.toolId ? String(snapshot.toolId || "") : "";
    if (!toolId) toolId = String(__worksCreateContext.toolId || "");
    return _inferOriginToolFromPage(toolId) || String(__worksCreateContext.originTool || "").trim();
  }

  function _resolveCreatePrimaryEntityType(snapshot, bucket, originTool){
    if (_getSnapshotActiveListing(snapshot)) return "property";
    return _inferPrimaryEntityType(bucket, originTool);
  }

  function _buildCreateMyWorkRequest(bucket, label){
    var snapshot = _getCurrentSaveSnapshot();
    var activeWork = null;
    try{ activeWork = getActiveWork(); }catch(_){ activeWork = null; }
    var resolvedBucket = String(bucket || "").trim() || _resolveCreateWorkBucket(snapshot);
    var normalizedBucket = _normalizeCreateBucket(resolvedBucket) || "brand_assets";
    var originTool = _resolveCreateOriginTool(snapshot);
    var transactionsSaveContext = _getTransactionsSaveContext(snapshot, originTool);
    var contentKind = _inferContentKindFromSaveSnapshot(snapshot, originTool);
    if (transactionsSaveContext && transactionsSaveContext.transactions_mode) {
      contentKind = String(transactionsSaveContext.transactions_mode || "");
    }
    var primaryEntityType = _resolveCreatePrimaryEntityType(snapshot, normalizedBucket, originTool);
    var summary = _resolveCreateSummary(snapshot, activeWork);
    try{
      if (snapshot && snapshot.toolId){
        _setWorksCreateContext({
          toolId: snapshot.toolId,
          originTool: originTool,
          contentKind: contentKind,
          primaryEntityType: primaryEntityType,
          summary: summary
        });
      }
    }catch(_){ }
    var body = {
      bucket: normalizedBucket,
      label: String(label || ""),
      payload: _buildCreatePayload(snapshot, activeWork, originTool, contentKind, summary, transactionsSaveContext)
    };

    if (originTool) body.origin_tool = originTool;
    if (contentKind) body.content_kind = contentKind;
    if (primaryEntityType) body.primary_entity_type = primaryEntityType;
    if (summary) body.summary = summary;
    if (transactionsSaveContext){
      if (transactionsSaveContext.session_id) body.session_id = String(transactionsSaveContext.session_id || "");
      if (transactionsSaveContext.transactions_mode) body.transactions_mode = String(transactionsSaveContext.transactions_mode || "");
    }

    return body;
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

  function _getWorksApiEndpoint(){
    var ep = "";
    try{ ep = String(_getApiEndpoint() || "").trim(); }catch(_){ ep = ""; }
    if (!ep){
      try{ ep = String(__worksApiEndpoint || "").trim(); }catch(_){ ep = ""; }
    }
    return String(ep || "").replace(/\/+$/,"");
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
    var ep = _getWorksApiEndpoint();
    if (!ep) throw new Error("Saving isn’t available right now.");
    var url = String(ep).replace(/\/+$/,"") + "/myworks";
    var body = _buildCreateMyWorkRequest(bucket, label);
    var res = await fetch(url, {
      method: "POST",
      headers: _apiHeadersJsonAuth(),
      body: JSON.stringify(body)
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

  async function deleteMyWork(workId){
    var id = String(workId || "").trim();
    if (!id) throw new Error("Couldn’t delete right now.");
    var ep = _getWorksApiEndpoint();
    if (!ep) throw new Error("Couldn’t delete right now.");
    var url = String(ep).replace(/\/+$/,"") + "/myworks/" + encodeURIComponent(id);
    var res = await fetch(url, {
      method: "DELETE",
      headers: _apiHeadersJsonAuth()
    });

    var text = await res.text();
    var data = null;
    try{ data = JSON.parse(text); }catch(_){ data = { reply: text || "" }; }

    if (!res.ok){
      throw new Error((data && (data.error || data.message || data.reply)) || ("Request failed (" + res.status + ")"));
    }

    return data;
  }

  function _normalizeWorkRow(raw){
    var w = raw && typeof raw === "object" ? raw : {};
    return {
      id: String(w.work_id || w.id || ""),
      work_id: String(w.work_id || w.id || ""),
      bucket: String(w.bucket || ""),
      label: String(w.label || "Untitled"),
      created_at: w.created_at || "",
      updated_at: w.updated_at || "",
      subtitle: String(w.subtitle || ""),
      preview: String(w.preview || ""),
      payload: (w.payload && typeof w.payload === "object") ? w.payload : null
    };
  }

  function _workPreviewSummary(work){
    var w = work && typeof work === "object" ? work : {};
    var payload = (w.payload && typeof w.payload === "object") ? w.payload : {};
    var pdsSummary = "";
    try{ pdsSummary = String((((payload.pds || {}).narrative || {}).summary) || "").trim(); }catch(_){ pdsSummary = ""; }
    if (pdsSummary) return pdsSummary;

    var portableSummary = "";
    try{
      var portable = (payload.portable && typeof payload.portable === "object") ? payload.portable : {};
      portableSummary = String(portable.summary || portable.intent_text || "").trim();
    }catch(_){ portableSummary = ""; }
    if (portableSummary) return portableSummary;

    if (typeof w.preview === "string" && w.preview.trim()) return w.preview.trim();
    if (typeof w.subtitle === "string" && w.subtitle.trim()) return w.subtitle.trim();
    if (typeof w.label === "string" && w.label.trim()) return w.label.trim();
    return "Untitled";
  }

  function _findRecentWorkMatch(work){
    try{
      var bucket = String((work && work.bucket) || "");
      var id = String((work && (work.id || work.work_id)) || "");
      if (!bucket || !id) return null;
      for (var i = 0; i < (__worksRecent || []).length; i++){
        var recent = __worksRecent[i];
        if (!recent) continue;
        if (String(recent.bucket || "") === bucket && String(recent.id || recent.work_id || "") === id){
          return recent;
        }
      }
    }catch(_){ }
    return null;
  }

  function _workMetaSummary(work){
    var bits = [];
    try{
      var recent = _findRecentWorkMatch(work);
      var lastSaved = _formatRelative((work && (work.updated_at || work.created_at)) || "");
      var lastUsed = _formatRelative((recent && recent._last_used) || (work && work._last_used) || "");
      if (lastSaved) bits.push(lastSaved);
      if (lastUsed) bits.push(lastUsed);
    }catch(_){ }
    return bits.join(" • ");
  }

  function _removeWorkFromSessionState(bucket, workId){
    var normalizedBucket = String(bucket || "");
    var normalizedId = String(workId || "");

    try{
      __worksRecent = (__worksRecent || []).filter(function(item){
        if (!item) return false;
        return !(String(item.bucket || "") === normalizedBucket && String(item.id || item.work_id || "") === normalizedId);
      });
    }catch(_){ }

    try{
      if (__pawActiveWork && String(__pawActiveWork.bucket || "") === normalizedBucket && String(__pawActiveWork.id || __pawActiveWork.work_id || "") === normalizedId){
        __pawActiveWork = null;
        updateWorkPill();
        renderContextRow();
        try{ renderWorksBody(); }catch(_){ }
        emitActiveWorkChanged();
      }
    }catch(_){ }
  }

  async function fetchMyWorksList(opts){
    opts = opts || {};
    var ep = _getWorksApiEndpoint();
    if (!ep) throw new Error("Saving isn’t available right now.");
    var params = new URLSearchParams();
    params.set("limit", String(__worksListLimit || 25));
    if (opts.cursor) params.set("cursor", String(opts.cursor));
    if (__worksSearchQ) params.set("q", String(__worksSearchQ));
    if (__worksBucketFilter && __worksBucketFilter !== "all") params.set("bucket", String(__worksBucketFilter));

    var url = String(ep).replace(/\/+$/,"") + "/myworks?" + params.toString();
    var res = await fetch(url, { method:"GET", headers: _apiHeadersJsonAuth() });
    var text = await res.text();
    var data = null;
    try{ data = JSON.parse(text); }catch(_){ data = { reply: text || "" }; }
    if (!res.ok){
      throw new Error((data && (data.error || data.message || data.reply)) || ("Request failed (" + res.status + ")"));
    }

    var list = (data && data.data && Array.isArray(data.data.list)) ? data.data.list : [];
    var next = (data && data.data && data.data.next_cursor) ? String(data.data.next_cursor) : "";
    return { list: list.map(_normalizeWorkRow), nextCursor: next };
  }

  function _ensureWorksListLoaded(){
    try{
      if (__worksListLoading && !__worksListHasLoaded) __worksListLoading = false;
      reloadWorksList({ append:false });
    }catch(_){ }
    try{
      if (window.PAWAuth && typeof window.PAWAuth.whenReady === "function"){
        window.PAWAuth.whenReady().then(function(){
          if (!document.body.classList.contains("paw-works-mode")) return;
          try{
            if (__worksListLoading && !__worksListHasLoaded) __worksListLoading = false;
            reloadWorksList({ append:false });
          }catch(_){ }
        }).catch(function(){});
      }
    }catch(_){ }
  }

  async function reloadWorksList(opts){
    opts = opts || {};
    var append = !!opts.append;
    if (__worksListLoading) return;
    if (!append){
      __worksNextCursor = "";
      __worksListError = "";
      __worksListHasLoaded = false;
      __worksListItems = [];
    } else {
      __worksListError = "";
    }
    var tok = "";
    try{ tok = (window.PAWAuth && window.PAWAuth.getToken) ? window.PAWAuth.getToken() : ""; }catch(_){ tok = ""; }
    if (!tok){
      try{ renderWorksBody(); }catch(_){ }
      return;
    }
    __worksListLoading = true;
    try{ renderWorksBody(); }catch(_){ }

    try{
      var cursor = append ? (__worksNextCursor || "") : "";
      var out = await fetchMyWorksList({ cursor: cursor });
      var incoming = Array.isArray(out.list) ? out.list : [];
      if (append) __worksListItems = (__worksListItems || []).concat(incoming);
      else __worksListItems = incoming;

      try{ __worksListItems.sort(function(a,b){ return _workTimeValue(b) - _workTimeValue(a); }); }catch(_){ }

      __worksNextCursor = out.nextCursor || "";
      __worksListHasLoaded = true;
    }catch(_err){
      __worksListError = "We can’t load your saved works right now. Please try again.";
      if (!append) __worksListItems = [];
    }finally{
      __worksListLoading = false;
      try{ renderWorksBody(); }catch(_){ }
    }
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
    // SAVE EVENT ORDER CONTRACT:
    // - The shell emits paw:works:save_current_output after the user chooses
    //   a shared save action in Works mode.
    // - For a newly created work, the create call happens first, then the new
    //   work is attached, then save_current_output is emitted so the current
    //   tool can PATCH its live tool payload into that work.
    // - Tool pages may listen for this event, but they must not invent a
    //   competing save event or reorder the shared create -> attach -> save flow.
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
            '<div id="pawWorkNameTitle" class="modal-title">Name this work</div>' +
            '<button class="modal-close" id="pawWorkNameClose" aria-label="Close" type="button">✕</button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<label class="paw-workname-label" for="pawWorkNameInput">Work name</label>' +
            '<input id="pawWorkNameInput" class="paw-workname-input" type="text" placeholder="e.g., Spring listing prep" />' +
            '<div id="pawWorkNameNote" style="margin-top:10px; font-size:13px; line-height:1.45; color:rgba(15,23,42,.66);">Nothing is saved automatically. This work is saved only when you click Save.</div>' +
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

  function openWorkNameModal(initialName, onConfirm){
    try{
      var m = ensureWorkNameModal();
      if (!m) return;
      var input = document.getElementById("pawWorkNameInput");
      var note = document.getElementById("pawWorkNameNote");
      var err = document.getElementById("pawWorkNameError");
      var saveBtn = document.getElementById("pawWorkNameSave");
      var snapshot = _getCurrentSaveSnapshot();
      var originTool = _resolveCreateOriginTool(snapshot);
      var transactionsSaveContext = _getTransactionsSaveContext(snapshot, originTool);

      if (err) err.textContent = "";
      if (input) input.value = String(initialName || "");
      if (note) {
        note.textContent = transactionsSaveContext && transactionsSaveContext.session_id
          ? "Nothing is saved automatically. If this Transactions work includes uploaded documents, those attachments are saved only when you click Save."
          : "Nothing is saved automatically. This work is saved only when you click Save.";
      }

      function submit(){
        var v = input ? String(input.value || "").trim() : "";
        if (!v){
          if (err) err.textContent = "Please enter a name.";
          try{ if (input) input.focus(); }catch(_){ }
          return;
        }
        if (err) err.textContent = "";
        try{ if (typeof onConfirm === "function") onConfirm(v); }catch(_){ }
        closeWorkNameModal();
      }

      if (saveBtn) saveBtn.onclick = submit;
      if (input) input.onkeydown = function(e){ if (e.key === "Enter") submit(); };

      m.classList.add("show");
      m.setAttribute("aria-hidden","false");
      setTimeout(function(){ try{ if (input) input.focus(); }catch(_){ } }, 0);
    }catch(_){ }
  }

  function ensureWorkDeleteModal(){
    try{
      var existing = document.getElementById("pawWorkDeleteModal");
      if (existing) return existing;

      var m = document.createElement("div");
      m.id = "pawWorkDeleteModal";
      m.className = "modal";
      m.setAttribute("aria-hidden","true");

      m.innerHTML =
        '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pawWorkDeleteTitle">' +
          '<div class="modal-head">' +
            '<div id="pawWorkDeleteTitle" class="modal-title">Delete this work?</div>' +
            '<button class="modal-close" id="pawWorkDeleteClose" aria-label="Close" type="button">&times;</button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<div id="pawWorkDeleteBody" style="font-size:14px; color:rgba(15,23,42,.86); line-height:1.45;">This cannot be undone.</div>' +
            '<div class="paw-workname-actions">' +
              '<button class="btn" id="pawWorkDeleteCancel" type="button">Cancel</button>' +
              '<button class="btn primary" id="pawWorkDeleteConfirm" type="button">Delete</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.body.appendChild(m);

      var closeBtn = document.getElementById("pawWorkDeleteClose");
      if (closeBtn) closeBtn.addEventListener("click", function(){ closeWorkDeleteModal(); });
      var cancelBtn = document.getElementById("pawWorkDeleteCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", function(){ closeWorkDeleteModal(); });

      m.addEventListener("click", function(e){
        if (e.target === m) closeWorkDeleteModal();
      });

      document.addEventListener("keydown", function(e){
        if (e.key === "Escape") closeWorkDeleteModal();
      });

      return m;
    }catch(_){ return null; }
  }

  function closeWorkDeleteModal(){
    try{
      var m = document.getElementById("pawWorkDeleteModal");
      if (!m) return;
      m.classList.remove("show");
      m.setAttribute("aria-hidden","true");
      __worksPendingDelete = null;
    }catch(_){ }
  }

  function openWorkDeleteModal(work, onConfirm){
    try{
      var m = ensureWorkDeleteModal();
      if (!m) return;

      var body = document.getElementById("pawWorkDeleteBody");
      var confirmBtn = document.getElementById("pawWorkDeleteConfirm");
      var label = String((work && work.label) || "Untitled");

      if (body){
        body.innerHTML = "This permanently deletes &ldquo;" + escapeHtml(label) + "&rdquo;. This cannot be undone.";
      }

      if (confirmBtn){
        confirmBtn.disabled = false;
        confirmBtn.onclick = async function(){
          if (confirmBtn.disabled) return;
          confirmBtn.disabled = true;
          try{
            if (typeof onConfirm === "function") await onConfirm();
            closeWorkDeleteModal();
          }catch(_){
            confirmBtn.disabled = false;
            return;
          }
          confirmBtn.disabled = false;
        };
      }

      m.classList.add("show");
      m.setAttribute("aria-hidden","false");
      setTimeout(function(){ try{ if (confirmBtn) confirmBtn.focus(); }catch(_){ } }, 0);
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
      var list = (__worksListItems || []).slice(0);
      var hasMore = !!__worksNextCursor;

      var html = "";

      if (hasAttached){
        var lastSaved = _formatRelative(__pawActiveWork.updated_at || __pawActiveWork.created_at || __pawActiveWork._last_used);
        html += `
          <div class="paw-works-mode__note paw-works-attached">
            <div class="paw-works-mode__note-title">Working on: ${escapeHtml(attachedName)}</div>
            <div class="paw-works-mode__note-copy">${escapeHtml(attachedType)} • Last saved ${escapeHtml(lastSaved || "—")}</div>
          </div>
        `;
      } else if (__worksListError){
        html += `
          <div class="paw-works-mode__note">
            <div class="paw-works-mode__note-title">We can’t load your saved works right now</div>
            <div class="paw-works-mode__note-copy">Please try again.</div>
          </div>
        `;
      } else {
        html += `
          <div class="paw-works-mode__note">
            <div class="paw-works-mode__note-title">Nothing saved yet</div>
            <div class="paw-works-mode__note-copy">Save what you’re working on, or use a saved work.</div>
          </div>
        `;
      }

      if (!hasAttached){
        html += `
          <div class="paw-works-actions">
            <button class="btn primary" type="button" data-paw-works-save-new="1">Save</button>
          </div>
        `;
      } else {
        html += `
          <div class="paw-works-actions">
            <button class="btn primary" type="button" data-paw-works-save="1">Save updates</button>
            <button class="btn" type="button" data-paw-works-save-as-new="1">Save as new</button>
            <button class="paw-works-linkbtn" type="button" data-paw-works-detach="1">Detach</button>
          </div>
        `;
      }

      html += `
        <div class="paw-works-recents">
          <div class="paw-works-recents__head">
            <div>
              <div class="paw-works-recents__title">Saved works</div>
            </div>
            <div class="paw-works-recents__filters">
              <select class="paw-works-bucket" aria-label="Filter works by type" data-paw-works-bucket="1">
                <option value="all" ${__worksBucketFilter === "all" ? "selected" : ""}>All works</option>
                <option value="brand_assets" ${__worksBucketFilter === "brand_assets" ? "selected" : ""}>Brand Assets</option>
                <option value="listings" ${__worksBucketFilter === "listings" ? "selected" : ""}>Listings</option>
                <option value="transactions" ${__worksBucketFilter === "transactions" ? "selected" : ""}>Transactions</option>
              </select>
              <input class="paw-works-search" type="search" placeholder="Search saved works" value="${escapeHtml(__worksSearchQ||"")}" aria-label="Search works" data-paw-works-search="1"/>
            </div>
          </div>
          <div class="paw-works-list" data-paw-works-list="1">
      `;

      if (__worksListError){
        html += `
            <div class="paw-works-empty">
              <div class="paw-works-empty__title">We can’t load your saved works right now</div>
              <div class="paw-works-empty__body"><button class="btn" type="button" data-paw-works-retry="1">Try again</button></div>
            </div>
        `;
      } else if ((__worksListLoading && !__worksListHasLoaded) || (!__worksListHasLoaded && !__worksListError)){
        html += `
            <div class="paw-works-empty">
              <div class="paw-works-empty__title">Loading saved works…</div>
            </div>
        `;
      } else {
        for (var i=0;i<list.length;i++){
          var w = list[i];
          var type = _workTypeLabel(w.bucket);
          var tool = _workOriginToolLabel(w);
          var meta = _workMetaSummary(w);
          var preview = _workPreviewSummary(w);
          if (!preview || preview === String(w.label || "Untitled")) preview = "Saved work ready to reuse.";
          html += `
            <article class="paw-works-card">
              <div class="paw-works-card__main">
                <div class="paw-works-card__head">
                  <div class="paw-works-card__title">${escapeHtml(String(w.label||"Untitled"))}</div>
                  <div class="paw-works-card__badges">
                    <span class="paw-works-badge">${escapeHtml(type)}</span>
                    ${tool ? `<span class="paw-works-badge paw-works-badge--muted">${escapeHtml(tool)}</span>` : ``}
                  </div>
                </div>
                <div class="paw-works-card__preview">${escapeHtml(preview)}</div>
              </div>
              <div class="paw-works-card__foot">
                <div class="paw-works-card__meta">${escapeHtml(meta || "Saved work ready to reuse.")}</div>
                <div class="paw-works-card__actions">
                  <button class="btn primary" type="button" data-paw-works-attach="1" data-bucket="${escapeHtml(String(w.bucket||""))}" data-id="${escapeHtml(String(w.id||""))}">Use</button>
                  <button class="btn" type="button" data-paw-works-delete="1" data-bucket="${escapeHtml(String(w.bucket||""))}" data-id="${escapeHtml(String(w.id||""))}" data-label="${escapeHtml(String(w.label||"Untitled"))}">Delete</button>
                </div>
              </div>
            </article>
          `;
        }
        if (hasMore){
          html += `
            <div class="paw-works-actions paw-works-actions--list">
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

      try{
        var inp = body.querySelector("[data-paw-works-search=\"1\"]");
        if (inp){
          inp.oninput = function(){
            __worksSearchQ = String(inp.value || "").trim();
            __worksNextCursor = "";
            reloadWorksList({ append:false });
          };
        }
        var bucketSel = body.querySelector("[data-paw-works-bucket=\"1\"]");
        if (bucketSel){
          bucketSel.onchange = function(){
            __worksBucketFilter = String(bucketSel.value || "all");
            __worksNextCursor = "";
            reloadWorksList({ append:false });
          };
        }
      }catch(_){ }
    }catch(_){
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

  __worksReloadWorksListFn = reloadWorksList;
  __worksEnsureWorksListLoadedFn = _ensureWorksListLoaded;

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
        kids.forEach(function(el){
          if (!el || el === __drawer || el === __worksRoot) return;

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

  // WORKS MODE OPEN OWNERSHIP:
  // - Opening Works mode is shell-owned. The shared button click calls this function.
  // - The shell decides what gets hidden, what gets moved, and how the DOM is restored.
  // - Tool pages must not toggle paw-works-mode classes, hide their own surface,
  //   or move the Work button/status locally.
  __toolRoot = findToolRoot();
  if (!__toolRoot){
    // If we can't safely replace the tool UI, the Work button should not be available.
    try{ var btn = document.getElementById("pawMyStuffBtn"); if (btn) btn.style.display = "none"; }catch(_){}
    return;
  }

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
      // DOM MOVEMENT CONTRACT:
      // - We move the real button node, not a copy, so focus/state/ARIA stay consistent.
      // - Comment placeholders preserve the exact original location for full restoration.
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

  var ensuredRoot = ensureWorksRoot();
  var activePanel = document.querySelector(".panel") || __toolRoot || null;
  if (__worksRoot && activePanel && __worksRoot.parentNode !== activePanel){
    mountWorksRootIntoPanel();
  }
  if (!__worksRoot || !activePanel || __worksRoot.parentNode !== activePanel){
    return;
  }
  setWorksMode(true);
  try{ renderWorksBody(); }catch(_){ }
  try{ if (__worksEnsureWorksListLoadedFn) __worksEnsureWorksListLoadedFn(); }catch(_){ }

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
  try{ pawScheduleLayoutPing(); }catch(_){}

  // Stabilize scroll: bring Works to top.
  try{ window.scrollTo(0,0); }catch(_){}
}

function exitWorksMode(){
  if (!__worksModeOn) return;

  // WORKS MODE CLOSE OWNERSHIP:
  // - Closing Works mode is shell-owned whether it comes from the shared button,
  //   Escape, or a "Use" action that attaches a work and returns to the tool.
  // - This function remains the single place that restores the hidden tool
  //   surface and puts the real Work button/status back in their original home.
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

  setWorksMode(false);

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

  function emitActiveWorkChanged(){
    try{
      var aw = __pawActiveWork ? Object.assign({}, __pawActiveWork) : null;
      var ev = new CustomEvent("paw:works:active_changed", {
        detail: { active_work: aw }
      });
      window.dispatchEvent(ev);
    }catch(_){}
  }

  function attachWork(work){
    // ATTACHED/DETACHED WORK OWNERSHIP:
    // - __pawActiveWork is the shared session-only source of truth for the
    //   currently attached work across all tools.
    // - Tool pages may read it through getActiveWork() and react to the
    //   paw:works:active_changed event, but they do not own this state.
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
    emitActiveWorkChanged();
  }

  function detachWork(){
    // Detach clears shared session state only. It does not delete or edit a saved work.
    // Tool pages may call detachWork() from explicit user actions such as reset flows,
    // but they must not clear __pawActiveWork by any local workaround.
    __pawActiveWork = null;
    updateWorkPill();
    renderContextRow();
    try{ renderWorksBody(); }catch(_){}
    // Keep Works mode open; this is a safe action.
    try{
      if (window.PAWToolShell && window.PAWToolShell._toast) window.PAWToolShell._toast("Detached from this session.");
    }catch(_){}
    emitActiveWorkChanged();
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
  __worksApiEndpoint = String(apiEndpoint || "");

  // TOOL INTEGRATION WARNING:
  // - Tool pages host #pawMyStuffBtn in their header, then call PAWToolShell.init().
  // - This init wires the shared button once and keeps Work behavior centralized here.
  // - Tool files may consume shared APIs/events after init, but must not add local
  //   click handlers or duplicate Works mode logic.
  updateWorkPill();

  // Restore a saved-work launch only once on destination boot.
  // Downstream tool pages already know how to react when active work exists.
  consumeLaunchWorkHandoff();

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
  (function bootstrapPlanUsageChrome(){
    function tryRender(){
      try { PAWUsage.scheduleRender(); } catch (_) {}
    }

    tryRender();

    try{
      document.addEventListener("DOMContentLoaded", function(){ tryRender(); }, { once:true });
    }catch(_){}
  })();

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
