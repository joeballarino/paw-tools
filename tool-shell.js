/* ProAgent Works Tool Shell
 * Shared frontend logic for all tools
 * DO NOT put prompting logic here — Worker only
 */

(function () {
  const DEFAULT_ENDPOINT = "/api/ask";

  function $(id) {
    return document.getElementById(id);
  }

  function scrollToBottom(el) {
    try {
      el.scrollTop = el.scrollHeight;
    } catch {}
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function appendMessage(container, role, text) {
    const div = document.createElement("div");
    div.className = role === "user" ? "paw-msg paw-user" : "paw-msg paw-ai";
    div.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    container.appendChild(div);
    scrollToBottom(container);
  }

  function init(config) {
    const {
      input,
      sendBtn,
      output,
      endpoint = DEFAULT_ENDPOINT,
      getExtraPayload,
      onResponse,
      beforeSend,
    } = config;

    let isSending = false;

    async function sendMessage(text) {
      if (isSending) return;
      const trimmed = String(text || "").trim();
      if (!trimmed) return;

      isSending = true;
      if (beforeSend) beforeSend(trimmed);

      appendMessage(output, "user", trimmed);
      input.value = "";

      const payload = {
        message: trimmed,
      };

      if (getExtraPayload) {
        Object.assign(payload, getExtraPayload(trimmed) || {});
      }

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await res.json();

        if (onResponse) {
          const handled = onResponse(data);
          if (handled && handled.skipDefault) {
            isSending = false;
            return;
          }
        }

        if (data && typeof data.reply === "string") {
          appendMessage(output, "ai", data.reply);
        }
      } catch (err) {
        appendMessage(output, "ai", "Something went wrong. Please try again.");
      } finally {
        isSending = false;
      }
    }

    async function sendExtra(instruction, extraPayload = {}, options = {}) {
      if (isSending) return;

      isSending = true;
      if (options.beforeSend) options.beforeSend(instruction);

      const payload = Object.assign(
        {
          message: instruction,
        },
        extraPayload
      );

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await res.json();

        if (onResponse) {
          const handled = onResponse(data);
          if (handled && handled.skipDefault) {
            isSending = false;
            return;
          }
        }

        if (data && typeof data.reply === "string") {
          appendMessage(output, "ai", data.reply);
        }
      } catch (err) {
        appendMessage(output, "ai", "Something went wrong. Please try again.");
      } finally {
        isSending = false;
      }
    }

    sendBtn.addEventListener("click", () => {
      sendMessage(input.value);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value);
      }
    });

    return {
      sendMessage,
      sendExtra,
      reset() {
        output.innerHTML = "";
        input.value = "";
      },
    };
  }

  window.PAWToolShell = { init };
})();
