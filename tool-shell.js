// paw-api Worker (OpenAI Responses API)
//
// What it does
// - Single endpoint for all tools (assistant + tool-specific routes)
// - Uses OpenAI Responses API
// - Enforces guardrails + Fair Housing safety
// - Returns JSON: { reply: "...", ...optional tool payloads... }
//
// Notes
// - This file is intentionally PRIVATE (not in GitHub)
// - Frontend sends: { tool, message, prefs, history, phase?, selected_highlights? }

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

const OPENAI_API_BASE = "https://api.openai.com/v1/responses";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const DEFAULT_MODEL = "gpt-4.1-mini"; // adjust if you’ve standardized elsewhere
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_ITEM_CHARS = 1200;

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toInputMessage(role, content) {
  return { role, content };
}

function roleTagLine(role, content) {
  const r = String(role || "").toLowerCase();
  const label = r === "assistant" ? "Assistant" : "User";
  return `${label}: ${String(content || "")}`;
}

function clampHistory(history) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-MAX_HISTORY_ITEMS).map((h) => ({
    role: (h && h.role) || "user",
    content: (h && h.content) || "",
  }));
}

function normEnum(v) {
  const s = String(v ?? "").trim();
  return (!s || /^unknown$/i.test(s) || /^choose/i.test(s)) ? "" : s;
}

function normText(v) {
  const s = String(v ?? "").trim();
  return (!s || /^unknown$/i.test(s)) ? "" : s;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = String(x || "").trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) : t;
}

// Detect “agent-provided anchors” we can treat as authoritative references.
// We DO NOT invent these; we only mirror what the agent typed.
function extractAgentAnchors(text) {
  const src = String(text || "");
  if (!src) return [];

  // Capture phrases after common proximity signals.
  // Examples:
  // - "near Lincoln Elementary"
  // - "across the street from Central Park"
  // - "adjacent to Pisgah National Forest"
  // - "next to the greenway"
  const patterns = [
    /\b(across the street from)\s+([^.,;!\n]{3,80})/gi,
    /\b(next to)\s+([^.,;!\n]{3,80})/gi,
    /\b(adjacent to)\s+([^.,;!\n]{3,80})/gi,
    /\b(near)\s+([^.,;!\n]{3,80})/gi,
    /\b(close to)\s+([^.,;!\n]{3,80})/gi,
    /\b(nearby)\s+([^.,;!\n]{3,80})/gi,
  ];

  const anchors = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const phrase = `${m[1]} ${m[2]}`.trim();
      // Avoid capturing trailing filler
      const cleaned = phrase
        .replace(/\s+(and|with|plus)\s*$/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (cleaned.length >= 6) anchors.push(cleaned);
    }
  }

  // If agent provides explicit time/distance, we can echo it (never invent).
  // Example: "5 minutes to downtown"
  const distanceRe = /\b(\d{1,2})\s*(minutes?|mins?|mi|miles?|km)\b[^.\n]{0,80}/gi;
  let dm;
  while ((dm = distanceRe.exec(src)) !== null) {
    const snippet = dm[0].trim();
    if (snippet.length >= 6) anchors.push(snippet);
  }

  return uniq(anchors).slice(0, 8);
}

function hasZip(prefs) {
  const p = prefs || {};
  const z = normText(p.zip) || normText((p.locked && p.locked.zip) || "");
  // Basic ZIP check (US 5-digit or ZIP+4)
  return /\b\d{5}(-\d{4})?\b/.test(z);
}

// ─────────────────────────────────────────────
// Guardrails & system prompts
// ─────────────────────────────────────────────

function baseSystemPrompt() {
  return [
    "You are ProAgent Works, an AI copilot for real estate agents.",
    "Write in a professional, MLS-safe way.",
    "Never include discriminatory language. Be Fair Housing safe.",
    "Avoid unverifiable claims. If something is unknown, write conservatively.",
    "If asked for legal advice, encourage consulting appropriate professionals.",
  ].join("\n");
}

/**
 * Listing writer prompt with POI/Highlights discipline:
 * - Only mention selected highlights OR agent-provided anchors
 * - Never invent POIs
 * - Never invent distances; only echo distance/time if agent provided it verbatim
 * - Do not escalate proximity language beyond what agent wrote
 */
function listingWriterSystemPrompt({
  prefs,
  location,
  selectedHighlights,
  agentAnchors,
  zipPresent,
}) {
  const p = prefs || {};
  const tone = normEnum(p.tone) || "general";
  const length = normEnum(p.length) || "standard";
  const listingType = normEnum(p.listing_type) || "general";

  const locked = (p && p.locked) || {};
  const beds = normText(locked.beds || p.beds || "");
  const baths = normText(locked.baths || p.baths || "");
  const sqft = normText(locked.sqft || p.sqft || "");
  const price = normText(locked.price || p.price || "");
  const pool = normText(locked.pool || p.pool || "");
  const porch = normText(locked.porch || p.porch || "");
  const compelling = normText(p.compelling_feature || "");
  const loc = normText(location || "");

  const highlights = Array.isArray(selectedHighlights) ? selectedHighlights : [];
  const anchors = Array.isArray(agentAnchors) ? agentAnchors : [];

  return [
    baseSystemPrompt(),
    "",
    "You are generating MLS-ready listing remarks for a real estate listing.",
    "Output should be a single polished paragraph unless the user explicitly asks for bullets.",
    "Do NOT mention Fair Housing or compliance in the output.",
    "",
    `Style preferences: tone=${tone}, length=${length}, listing_type=${listingType}`,
    loc ? `Location context: ${loc}` : "Location context: (unknown)",
    compelling ? `Most compelling feature: ${compelling}` : "",
    "",
    "Known facts (use only if provided; do not invent):",
    beds ? `- Beds: ${beds}` : "",
    baths ? `- Baths: ${baths}` : "",
    sqft ? `- Sqft: ${sqft}` : "",
    price ? `- Price: ${price} (context only; do not overemphasize)` : "",
    pool ? `- Pool: ${pool}` : "",
    porch ? `- Porch: ${porch}` : "",
    "",
    "Nearby highlights & location claims rules (very important):",
    "- You may mention ONLY:",
    "  (A) items the agent explicitly selected from the 'highlights' list, AND/OR",
    "  (B) explicit anchor phrases the agent typed (e.g., 'near X', 'across the street from Y').",
    "- If an anchor phrase is provided by the agent, you may reuse it, but do NOT strengthen it.",
    "  Example: if agent wrote 'near X', do not change to 'steps from X' or 'walkable to X'.",
    "- Do NOT invent or add new named places, schools, parks, or neighborhoods beyond (A) and (B).",
    "- Do NOT claim distances, drive times, or walkability. Never write 'minutes to' unless the agent already provided the time/distance in their input.",
    zipPresent
      ? "- ZIP is present: you still must NOT invent distances; you may only echo distance/time if the agent provided it verbatim."
      : "- ZIP not present: do not use any time/distance phrasing at all (no 'minutes', no miles).",
    "",
    highlights.length
      ? `Agent-selected highlights (allowed to include as general 'nearby' / 'area attractions' wording): ${highlights
          .map((x) => `"${x}"`)
          .join(", ")}`
      : "Agent-selected highlights: (none)",
    anchors.length
      ? `Agent-provided anchors (allowed; mirror phrasing): ${anchors
          .map((x) => `"${x}"`)
          .join(", ")}`
      : "Agent-provided anchors: (none)",
    "",
    "General writing rules:",
    "- Avoid exaggerations like 'best', 'rare', 'unmatched' unless supported by the agent’s notes.",
    "- Avoid 'minutes to' unless agent provided the exact time/distance.",
    "- Keep it motivating but accurate and MLS-appropriate.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Highlights suggestion prompt (NO WHITELISTS):
 * - Return candidate highlights (named POIs + categories) that *might* apply given the location context
 * - No distances/time
 * - These are OPTIONS for the agent to confirm via UI
 */
function highlightsSystemPrompt() {
  return [
    baseSystemPrompt(),
    "",
    "Task: Suggest possible nearby highlights for a real estate listing given the location context.",
    "Return ONLY JSON with the shape: {\"metro\":\"...\",\"highlights\":[\"...\"]}. (\"metro\" may be empty if unknown.)",
    "",
    "Rules (strict):",
    "- First infer the nearest major city/metro area for this location and set it as the \"metro\" string (e.g., \"Asheville\", \"Raleigh-Durham\").",
    "- The highlights should use BOTH contexts: regional anchors from the metro/region + truly nearby local conveniences.",
    "- Return EXACTLY 5 highlights when city+state are provided. (If you truly cannot, return fewer.)",
    "- Order matters: first 3 = larger-area / widely recognizable anchors (major attractions, downtowns, airports, universities, major parks).",
    "- Next 2 = hyper-local conveniences (parks, greenways, schools, shopping areas) that could plausibly be nearby.",
    "- If the city is small, include regional anchors from the nearest major city/metro area in the same region/state.",
    "- These are optional suggestions ONLY; do not assert they are definitely true.",
    "- You MAY include named POIs (landmarks, parks, downtown areas) and also generic categories.",
    "- Do NOT include any distances, drive times, or walk times (no 'minutes to', no miles, no 'walkable').",
    "- Keep each highlight short (2–6 words ideally).",
    "- Avoid protected-class targeting or demographic-coded items.",
    "- Avoid tiny businesses unless they are truly iconic/regionally known.",
    "- If location is missing/ambiguous, return an empty list.",
    "",
    "Output JSON only.",
  ].join("\n");
}

// ─────────────────────────────────────────────
// OpenAI call
// ─────────────────────────────────────────────

async function callOpenAI(env, payload) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch(OPENAI_API_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg =
      json && json.error && json.error.message ? json.error.message : text;
    throw new Error(msg || "OpenAI API error");
  }
  return json;
}

function extractReply(openaiJson) {
  if (!openaiJson) return "";
  if (typeof openaiJson.output_text === "string") return openaiJson.output_text;
  if (Array.isArray(openaiJson.output)) {
    for (const item of openaiJson.output) {
      if (item && item.type === "message" && Array.isArray(item.content)) {
        const parts = item.content
          .filter(
            (p) => p && p.type === "output_text" && typeof p.text === "string"
          )
          .map((p) => p.text);
        if (parts.length) return parts.join("");
      }
    }
  }
  return "";
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────

async function handleRequest(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ reply: "Not found." }, 404);
  }

  try {
    const bodyText = await request.text();
    const body = safeJsonParse(bodyText) || {};
    const tool = String(body.tool || "");
    const message = String(body.message || "").trim();
    const prefs =
      body && typeof body.prefs === "object" && body.prefs ? body.prefs : {};
    const history = clampHistory(body.history);

    // Tool-specific phases
    const phase = String(body.phase || "").trim();
    const selectedHighlights = Array.isArray(body.selected_highlights)
      ? body.selected_highlights
      : null;

    // Normalize location
    const p = prefs || {};
    const city = normText(p.city);
    const state = normText(p.state).toUpperCase();
    const zip = normText(p.zip) || normText((p.locked && p.locked.zip) || "");
    const location =
      normText(p.location) ||
      ((city && state) ? `${city}, ${state}` : "") ||
      zip ||
      "";

    // Agent-provided anchors (authoritative if present)
    const agentAnchors = extractAgentAnchors(message);

    // Distance gating: ZIP only “unlocks” the ability to echo agent-provided time/distance,
    // but we still never invent any distances.
    const zipPresent = hasZip({ ...p, zip });

    // ─────────────────────────────────────────────
    // LISTING DESCRIPTION WRITER
    // ─────────────────────────────────────────────
    if (tool === "listing_description_writer") {
      // (A) Background highlights fetch
      if (phase === "highlights") {
        // If location is empty/ambiguous, return empty list (no questions).
        if (!location || location.length < 3) {
          return jsonResponse({ reply: "", local: { highlights: [] } }, 200);
        }

        const input = [
          toInputMessage("system", highlightsSystemPrompt()),
          toInputMessage(
            "user",
            [
              "Location context:",
              location,
              "",
              "Property notes (may help suggest relevant highlights):",
              truncate(message, 600),
              "",
              'Return only JSON like: {"metro":"...","highlights":["..."]}',
            ].join("\n")
          ),
        ];

        const payload = {
          model: DEFAULT_MODEL,
          input,
          // JSON mode for Responses API
          text: { format: { type: "json_object" } },
        };

        const openai = await callOpenAI(env, payload);
        const rawText = extractReply(openai);

        let parsed = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }

        const highlightsRaw =
          parsed && Array.isArray(parsed.highlights)
            ? parsed.highlights
                .map((x) => String(x || "").trim())
                .filter(Boolean)
                .slice(0, 12)
            : [];

        // Extra cleanup: remove any accidental time/distance phrasing, dedupe, and cap to 5.
        const seen = new Set();
        const cleaned = [];
        for (const h of highlightsRaw) {
          if (/\b(minutes?|mins?|mi|miles?|km)\b/i.test(h)) continue;
          const key = h.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          cleaned.push(h);
          if (cleaned.length >= 5) break;
        }

        return jsonResponse({ reply: "", local: { highlights: cleaned } }, 200);
      }

      // (B) Apply selected highlights (rewrite / second pass)
      if (phase === "write" && selectedHighlights && selectedHighlights.length) {
        const userMessage = message || "";

        const input = [
          toInputMessage(
            "system",
            listingWriterSystemPrompt({
              prefs,
              location,
              selectedHighlights,
              agentAnchors,
              zipPresent,
            })
          ),
          ...history.map((h) =>
            toInputMessage(
              "user",
              roleTagLine(h.role, h.content).slice(0, MAX_HISTORY_ITEM_CHARS)
            )
          ),
          toInputMessage("user", userMessage),
        ];

        const payload = { model: DEFAULT_MODEL, input };
        const openai = await callOpenAI(env, payload);
        const reply = extractReply(openai).trim();

        return jsonResponse({ reply }, 200);
      }

      // (C) Default first-pass generation (no selected highlights yet)
      const userMessage = message || "";

      const input = [
        toInputMessage(
          "system",
          listingWriterSystemPrompt({
            prefs,
            location,
            selectedHighlights: [],
            agentAnchors,
            zipPresent,
          })
        ),
        ...history.map((h) =>
          toInputMessage(
            "user",
            roleTagLine(h.role, h.content).slice(0, MAX_HISTORY_ITEM_CHARS)
          )
        ),
        toInputMessage("user", userMessage),
      ];

      const payload = { model: DEFAULT_MODEL, input };
      const openai = await callOpenAI(env, payload);
      const reply =
        extractReply(openai).trim() ||
        "Add a few property details and I’ll write the MLS description.";

      return jsonResponse({ reply }, 200);
    }

    // ─────────────────────────────────────────────
    // DEFAULT / ASSISTANT TOOL
    // ─────────────────────────────────────────────

    const userMessage = message || "";

    const input = [
      toInputMessage("system", baseSystemPrompt()),
      ...history.map((h) =>
        toInputMessage(
          "user",
          roleTagLine(h.role, h.content).slice(0, MAX_HISTORY_ITEM_CHARS)
        )
      ),
      toInputMessage("user", userMessage),
    ];

    const payload = { model: DEFAULT_MODEL, input };
    const openai = await callOpenAI(env, payload);
    const reply = extractReply(openai).trim() || "Type a question and I’ll help.";
    return jsonResponse({ reply }, 200);
  } catch (err) {
    return jsonResponse(
      { reply: `Upstream error: ${String(err?.message || err)}` },
      200
    );
  }
}