// Netlify Function: POST /.netlify/functions/chat
// Powers the AI Lead Assistant's free-text answers with Claude.
// Falls back gracefully (returns { reply: null }) whenever the key is missing
// or the API errors — the front-end widget then uses its built-in FAQ matcher.
//
// Required env var:  ANTHROPIC_API_KEY
// Optional env vars:
//   CHAT_MODEL            default claude-opus-4-8 (set claude-haiku-4-5 for ~5x lower cost)
//   RATE_LIMIT_MAX        default 12  (max messages per IP per window)
//   RATE_LIMIT_WINDOW_MS  default 60000 (window length in ms)

const SYSTEM = `You are the Apex Assistant, the helpful sales & support chatbot on the APEX BIM Studio website (apexbim.co).

About APEX BIM Studio:
- Turns shop drawings, submittals, and manufacturer data into construction-ready, LOD 400 Revit families — with maintenance clearance zones, embedded equipment data, and nested survey points.
- Average time to generate a coordination-correct family: about 47 seconds.
- Survey points export to a clean CSV for Trimble Field Points and Autodesk survey points, so the installed layout matches the model.
- Also ships an all-in-one Revit modeling add-in (auto-route conduit/duct/pipe, smart bends, hangers & trapeze, sleeves, pull boxes, cable tray, spooling & sheets, layout points) and as-built verification.
- Integrates with Autodesk Revit, Construction Cloud (ACC), BIM 360, Trimble, Navisworks, Procore, Bluebeam, and ReCap.
- Currently in private beta, built hand-in-hand with electrical and mechanical contractors. Based in Millville, Utah.

Style: concise, friendly, professional, and construction-savvy. Keep answers to 2-4 sentences. Use plain text (no markdown).

Rules:
- Never invent specific prices, dates, or features. Pricing lives on the pricing page; for specifics, point users to book a demo or email sales@apexbim.co.
- When there is buying intent, encourage booking a demo.
- Helpful links you can mention: book a demo (/demo), contact us (/contact, sales@apexbim.co), join the waitlist (/waitlist), pricing (/pricing), documentation (/docs).
- If you don't know something, say so briefly and point them to /contact or a demo.`;

// ── In-memory rate limiter ────────────────────────────────────────────────
// Best-effort throttle keyed by client IP. Netlify may run multiple warm
// instances, so the effective global limit is (instances x RATE_LIMIT_MAX);
// this still stops a single client from hammering one instance and keeps API
// cost bounded for casual abuse. For hard global limits, back this with a
// shared store (Netlify Blobs / Upstash). State resets on cold start.
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_HITS = Number(process.env.RATE_LIMIT_MAX) || 12;
const hits = new Map(); // ip -> { count, resetAt }

function rateLimited(ip, now) {
  // Opportunistic prune so the Map can't grow without bound.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }
  const rec = hits.get(ip);
  if (!rec || rec.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_HITS;
}

function clientIp(req) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

export default async (req) => {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Rate limit before any work. Friendly 200 reply (no Claude call) so the
  // widget shows the message instead of silently dropping to its FAQ.
  const now = Date.now();
  if (rateLimited(clientIp(req), now)) {
    return json({ reply: "You're sending messages a little quickly — give me a few seconds, then try again. For anything urgent you can book a demo or email sales@apexbim.co." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ reply: null }); // not configured → widget uses FAQ fallback

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const message = (body && typeof body.message === "string") ? body.message.trim().slice(0, 2000) : "";
  if (!message) return json({ reply: null });

  // Rebuild the recent conversation from the widget's transcript ("user: ..." / "bot: ...").
  const history = Array.isArray(body.transcript) ? body.transcript.slice(-10) : [];
  let messages = history
    .filter((line) => typeof line === "string")
    .map((line) => ({
      role: line.startsWith("user:") ? "user" : "assistant",
      content: line.replace(/^(user:|bot:)\s*/, "").trim().slice(0, 2000),
    }))
    .filter((m) => m.content);

  // The Messages API requires the first turn to be from the user.
  while (messages.length && messages[0].role !== "user") messages.shift();

  // Ensure the latest user message is present as the final turn.
  if (!messages.length || messages[messages.length - 1].role !== "user" ||
      messages[messages.length - 1].content !== message) {
    messages.push({ role: "user", content: message });
  }

  const model = process.env.CHAT_MODEL || "claude-opus-4-8";
  // `effort` is only valid on Fable 5 / Opus 4.5+ / Sonnet 4.6.
  // Haiku 4.5 and Sonnet 4.5 reject it with a 400 — omit it for those.
  const reqBody = { model, max_tokens: 400, system: SYSTEM, messages };
  if (/(opus-4-[5-9])|(sonnet-4-6)|(fable)/i.test(model)) {
    reqBody.output_config = { effort: "low" }; // snappy, cost-efficient
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(reqBody),
    });

    if (!res.ok) return json({ reply: null }); // API error → FAQ fallback

    const data = await res.json();
    const reply = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()
      : "";

    return json({ reply: reply || null });
  } catch {
    return json({ reply: null });
  }
};
