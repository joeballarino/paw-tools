/* ProAgent Works Tool Shell
 * Shared frontend logic for all tool pages.
 *
 * Responsibilities:
 * - Tool header/footer chrome
 * - Shared auth/session helpers
 * - Shared UI helpers (messages, thinking state)
 * - Worker request plumbing
 *
 * Notes:
 * - Tool pages supply a toolId and optional hooks (getExtraPayload, onResponse).
 * - The Worker contains all prompting logic and protected configuration.
 * - If inside an iframe OR ?embed=1, sets: <html data-embed="1">
 */

(function () {
  "use strict";

  // ----------------------------
  // Utility
  // ----------------------------

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isEmbedMode() {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("embed") === "1") return true;
    } catch (e) {}
    return window.self !== window.top;
  }

  function setEmbedAttr() {
    if (isEmbedMode()) {
      document.documentElement.setAttribute("data-embed", "1");
    }
  }

  function getToolIdFromBody() {
    const body = document.body;
    if (!body) return "";
    return body.getAttribute("data-tool") || "";
  }

  function getApiEndpointFromMeta() {
    const meta = document.querySelector('meta[name="paw-api"]');
    if (!meta) return "";
    return meta.getAttribute("content") || "";
  }

  function getAuthTokenFromStorage() {
    try {
      return localStorage.getItem("paw_token") || "";
    } catch (e) {
      return "";
    }
  }

  function setAuthTokenToStorage(token) {
    try {
      if (token) localStorage.setItem("paw_token", token);
      else localStorage.removeItem("paw_token");
    } catch (e) {}
  }

  // ----------------------------
  // UI helpers
  // ----------------------------

  function appendMessage(container, role, text) {
    if (!container) return null;

    const msg = document.createElement("div");
    msg.className = "msg " + (role === "user" ? "user" : "ai");

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");

    msg.appendChild(bubble);
    container.appendChild(msg);

    container.scrollTop = container.scrollHeight;
    return msg;
  }

  function appendThinking(container) {
    if (!container) return null;

    const msg = document.createElement("div");
    msg.className = "msg ai";

    const bubble = document.createElement("div");
    bubble.className = "bubble thinking";
    bubble.textContent = "Thinking…";

    msg.appendChild(bubble);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    return msg;
  }

  function removeThinking(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function setDisabled(btn, disabled) {
    if (!btn) return;
    btn.disabled = !!disabled;
    btn.classList.toggle("disabled", !!disabled);
  }

  // ----------------------------
  // Preferences (lightweight)
  // ----------------------------

  function getPrefs() {
    try {
      const raw = localStorage.getItem("paw_prefs");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function setPrefs(next) {
    try {
      localStorage.setItem("paw_prefs", JSON.stringify(next || {}));
    } catch (e) {}
  }

  // ----------------------------
  // Worker request plumbing
  // ----------------------------

  async function postJSON(url, payload, token) {
    const headers = {
      "Content-Type": "application/json",
    };
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

  // ----------------------------
  // Shell init
  // ----------------------------

  setEmbedAttr();

  const toolId = getToolIdFromBody();
  const apiEndpoint = getApiEndpointFromMeta();

  const $messages = qs("#messages");
  const $form = qs("#toolForm");
  const $input = qs("#prompt");
  const $submit = qs("#submitBtn");

  // Tool pages can set these as globals before loading tool-shell.js:
  // - window.PAW_TOOL_CONFIG = { getExtraPayload: fn, onResponse: fn, sendHistoryItems: number }
  const cfg = (window.PAW_TOOL_CONFIG && typeof window.PAW_TOOL_CONFIG === "object") ? window.PAW_TOOL_CONFIG : {};
  const getExtraPayload = cfg.getExtraPayload;
  const onResponse = cfg.onResponse;
  const sendHistoryItems = Number.isFinite(cfg.sendHistoryItems) ? cfg.sendHistoryItems : 12;

  let isSending = false;
  const history = [];

  function pushHistory(role, content) {
    history.push({ role, content });
  }

  async function postToWorker(payload) {
    const token = getAuthTokenFromStorage();
    return await postJSON(apiEndpoint, payload, token);
  }

  async function sendMessage() {
    if (isSending) return;
    if (!$input) return;

    const trimmed = String($input.value || "").trim();
    if (!trimmed) return;

    if (!apiEndpoint) {
      appendMessage($messages, "ai", "Missing API endpoint configuration.");
      return;
    }

    isSending = true;
    setDisabled($submit, true);

    let thinkingNode = null;

    try {
      appendMessage($messages, "user", trimmed);
      pushHistory("user", trimmed);
      $input.value = "";

      thinkingNode = appendThinking($messages);

      const prefs = getPrefs() || {};
      const historyToSend = history.slice(Math.max(0, history.length - sendHistoryItems));

      const extra = typeof getExtraPayload === "function" ? (getExtraPayload(trimmed) || {}) : {};
      const payload = Object.assign(
        { tool: toolId, message: trimmed, prefs, history: historyToSend },
        extra || {}
      );

      const data = await postToWorker(payload);

      removeThinking(thinkingNode);
      thinkingNode = null;

      if (onResponse) {
        const handled = onResponse(data);
        if (handled && handled.skipDefault) return;
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
      setDisabled($submit, false);
      if ($input) $input.focus();
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

      // PATCH: ensure extra messages can also be expanded by tool-specific getExtraPayload hook
      // (listing.html relies on this for background highlight requests that trigger the POI modal).
      const extraFromHook = typeof getExtraPayload === "function" ? (getExtraPayload(msg) || {}) : {};
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
        if (handled && handled.skipDefault) return;
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

  function boot() {
    if ($form) {
      $form.addEventListener("submit", function (e) {
        e.preventDefault();
        sendMessage();
      });
    }

    if ($input) {
      $input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    // Expose a small API for tool pages
    window.PAW_SHELL = {
      sendExtra,
      getPrefs,
      setPrefs,
      setAuthToken: setAuthTokenToStorage,
    };
  }

  boot();
})();
