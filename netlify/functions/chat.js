// netlify/functions/chat.js
// LLM answers for the site chat widget. Returns { reply: string } or
// { reply: null } — the widget falls back to its scripted flow on null.
//
// Env vars to set in Netlify → Site settings → Environment variables:
//   ANTHROPIC_API_KEY = your Anthropic API key (server-side ONLY)
//   CHAT_MODEL        = (optional) model override

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.CHAT_MODEL || 'claude-haiku-4-5-20251001';

// CORS so the widget can post from apexbim.co and its subdomains.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, body) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) });

const SYSTEM = `You are the website assistant for Apex BIM Studio (Apex BIM Studio LLC, Utah). Apex builds an AI-powered pipeline that turns manufacturer shop-drawing PDFs into parametric, validation-checked Revit families — transformers today, switchgear in active development. Nobody else builds the family from the shop drawing when none exists.

STATUS: Private beta. There is a development pilot at Cache Valley Electric — the founder's own electrical contracting firm. Always disclose that affiliation if Cache Valley Electric comes up. The founder's background is electrical contracting plus data-center MEP project engineering.

EVIDENCE — these are the ONLY numbers you may cite:
- 96.5/100 mean extraction accuracy across 20 real drawings (internal eval harness).
- 19 human-verified transformer families, each passing 6/6 validation checks in Revit 2025.
- Minutes per family, versus 2–4 hours to model one manually.

HOW IT WORKS: PDF upload → AI extraction with per-field confidence scores (amber flags low confidence) → a human reviews and approves in a web UI → the family is generated inside live Revit with Apex parameters and connectors → every AI write is a named Revit transaction, so one Ctrl+Z undoes it → nested survey/layout points export to Trimble-compatible CSV. Compatibility today: Revit 2025.

PRICING: Pilot-first — there is no price list. We run a pilot on the prospect's own project drawings and set pricing together after they've seen it work. NEVER quote any dollar amount, turnaround SLA, free-family offer, or revision policy — none of those exist.

ROADMAP (always label as coming/planned, never as available today): per-section switchgear geometry, in-Revit equipment-register pane, conduit auto-routing, ACC/Navisworks integrations, drawing-revision and as-built reconciliation.

IP & CONFIDENTIALITY: The client owns every family. NDA on request. Drawings are never shared or resold.

NEXT STEP to offer: book a demo at /demo (live pipeline on a real drawing), or the pilot ask — run it on their next project's drawings.

RULES:
- Reply in 1–3 short sentences, plain text, no markdown.
- If asked anything outside these facts, say you'll connect them with the team — do not guess or invent.
- Lead with the visitor's risk or outcome, not features.
- Be respectful about competitors.
- Do not collect emails, phone numbers, or other sensitive info in chat — point visitors to the demo form so it's captured properly.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!API_KEY) return json(200, { reply: null });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad JSON' }); }

  const message = (body.message || '').toString().slice(0, 1000);
  if (!message) return json(200, { reply: null });

  const transcript = Array.isArray(body.transcript) ? body.transcript.slice(-10).join('\n').slice(0, 2000) : '';
  const userContent = (transcript ? `Conversation so far:\n${transcript}\n\n` : '') + `Visitor: ${message}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!res.ok) {
      console.error('[chat] anthropic error:', res.status, await res.text());
      return json(200, { reply: null });
    }
    const data = await res.json();
    const reply = data && data.content && data.content[0] && data.content[0].text ? data.content[0].text : null;
    return json(200, { reply });
  } catch (e) {
    console.error('[chat] exception:', e.message);
    return json(200, { reply: null });
  }
};
