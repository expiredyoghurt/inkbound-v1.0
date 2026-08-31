/**
 * Inkbound: The Last Atlas — Cloudflare Worker backend.
 *
 * Two independent jobs live in this one Worker:
 *
 * 1. KV SYNC — mirrors the Firestore "inkboundSync" collection: one KV
 *    key per synced doc, storing { value, updatedAt }. The game talks
 *    to this via cfPushDoc()/cfListenDoc() (see CF_WORKER_CONFIG near
 *    the top of index.html's <script> block). Requires a KV namespace
 *    bound as INKBOUND_KV (see wrangler.toml or the dashboard binding
 *    steps in worker/README.md).
 *
 * 2. AI MARKING — grades Oracle's Chamber (open-ended comprehension)
 *    answers by INTENT rather than exact wording or a fixed rubric:
 *    "does the student's answer mean roughly the same thing as the
 *    sample answer, given the passage?" It tries providers in this
 *    order, first one that succeeds wins:
 *      1. Google Gemini        (GEMINI_API_KEY secret)
 *      2. Groq                 (GROQ_API_KEY secret)
 *      3. xAI (Grok)           (XAI_API_KEY secret)
 *      4. Cloudflare Workers AI (native "AI" binding — no key needed)
 *    If every provider is unavailable/fails, this returns { ok:false }
 *    and the game's own client-side keyword matching (checkShortAnswer
 *    in index.html) takes over automatically — AI marking is always
 *    an enhancement, never a hard dependency.
 *
 * Optional: set a WORKER_SYNC_KEY secret to require every KV-sync
 * request to send a matching "X-Sync-Key" header. Leave it unset for
 * an open (but still doc-ID-whitelisted) endpoint — fine for a
 * classroom project, same spirit as the Firestore rules' "any
 * signed-in user" model. AI marking routes are read-only from the
 * game's point of view and don't touch KV, so they're not gated by
 * WORKER_SYNC_KEY — anyone hammering /api/grade-intent just burns
 * your own AI provider quota, so keep an eye on usage if you're
 * worried about that.
 */

// Only these doc IDs may be read/written via KV sync — keeps the
// namespace from becoming an arbitrary key/value dumping ground for
// anyone who finds the Worker URL.
const KNOWN_DOC_IDS = new Set([
  "accounts",
  "teacherAccounts",
  "ocOverrides",
  "regionBankOverrides",
  "workshopCostOverrides",
  "stabilityConfig",
  "regattaConfig",
  "classStandingsConfig"
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function checkAuth(request, env) {
  if (!env.WORKER_SYNC_KEY) return true; // no key configured -> open
  return request.headers.get("X-Sync-Key") === env.WORKER_SYNC_KEY;
}

/* =============================================================
   AI MARKING — provider adapters
   Each adapter takes (env, systemPrompt, userPrompt) and returns
   either { pass, note } on success or null on any failure (missing
   key, network error, bad response, unparsable output) so the caller
   can just try the next provider in the chain.
   ============================================================= */

// Pulls a JSON object of the shape {"same_intent": bool, "explanation": str}
// out of a model's raw text response, tolerating markdown code fences.
function parseGradeJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) cleaned = fenced[1].trim();
  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj.same_intent !== "boolean") return null;
    return {
      pass: obj.same_intent,
      note: typeof obj.explanation === "string" ? obj.explanation.slice(0, 300) : ""
    };
  } catch {
    return null;
  }
}

async function callGemini(env, systemPrompt, userPrompt) {
  if (!env.GEMINI_API_KEY) return null;
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    return parseGradeJSON(text);
  } catch {
    return null;
  }
}

async function callGroq(env, systemPrompt, userPrompt) {
  if (!env.GROQ_API_KEY) return null;
  const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseGradeJSON(text);
  } catch {
    return null;
  }
}

async function callXAI(env, systemPrompt, userPrompt) {
  if (!env.XAI_API_KEY) return null;
  const model = env.XAI_MODEL || "grok-4-fast-non-reasoning";
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.XAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseGradeJSON(text);
  } catch {
    return null;
  }
}

// Cloudflare Workers AI — the final fallback. No external API key
// needed, just an "AI" binding in wrangler.toml (see worker/README.md).
// Runs on Cloudflare's own infrastructure, so this is the option most
// likely to still be up even if every external provider above is down
// or unconfigured.
async function callWorkersAI(env, systemPrompt, userPrompt) {
  if (!env.AI) return null;
  const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    const text = result && (result.response || result.result || result.output_text);
    return parseGradeJSON(text);
  } catch {
    return null;
  }
}

const GRADE_PROVIDERS = [
  ["gemini", callGemini],
  ["groq", callGroq],
  ["xai", callXAI],
  ["workers-ai", callWorkersAI]
];

async function gradeIntent(env, { passage, prompt, studentAnswer, sampleAnswer, evidence }) {
  const systemPrompt =
    "You are grading a primary-school student's short-answer response to a reading " +
    "comprehension question. Ignore spelling, grammar, and phrasing entirely. Your only " +
    "job is to judge whether the student's answer expresses the SAME underlying idea or " +
    "intent as the reference answer, given the passage and question — not whether the " +
    "wording matches. Different reasoning that is still plausible and supported by the " +
    "passage should also count as matching intent. Be generous with partial or " +
    "differently-worded-but-sound reasoning; be strict only when the student's answer " +
    "means something genuinely different or contradicts the passage. " +
    "Respond with ONLY strict JSON, no markdown fences, no extra text, in exactly this " +
    'shape: {"same_intent": true or false, "explanation": "<one short, encouraging ' +
    'sentence written for a 10-12 year old, explaining the judgement>"}';

  const userPrompt =
    `Passage:\n${passage}\n\n` +
    `Question: ${prompt}\n\n` +
    `Reference answer (compare MEANING only, not exact wording): ${sampleAnswer}\n` +
    (evidence ? `Supporting evidence from the passage: "${evidence}"\n` : "") +
    `\nStudent's answer: ${studentAnswer}`;

  for (const [name, fn] of GRADE_PROVIDERS) {
    const result = await fn(env, systemPrompt, userPrompt);
    if (result) return { ok: true, provider: name, pass: result.pass, note: result.note };
  }
  return { ok: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Simple health check — handy for confirming the Worker deployed
    // and its KV binding exists before pointing the game at it.
    if (url.pathname === "/api/health") {
      return json({ ok: true, kvBound: !!env.INKBOUND_KV, authRequired: !!env.WORKER_SYNC_KEY });
    }

    // AI-marking health check — the game calls this on load (no LLM
    // call made here, just reports which providers are configured) so
    // its status icon reflects reality before anyone reaches the
    // Oracle's Chamber.
    if (url.pathname === "/api/ai-health") {
      const providers = {
        gemini: !!env.GEMINI_API_KEY,
        groq: !!env.GROQ_API_KEY,
        xai: !!env.XAI_API_KEY,
        workersAI: !!env.AI
      };
      const active = GRADE_PROVIDERS.map(p => p[0]).find(name =>
        (name === "gemini" && providers.gemini) ||
        (name === "groq" && providers.groq) ||
        (name === "xai" && providers.xai) ||
        (name === "workers-ai" && providers.workersAI)
      ) || null;
      return json({ ok: true, providers, active });
    }

    // AI marking — grades one Oracle's Chamber answer by intent.
    if (url.pathname === "/api/grade-intent") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Body must be JSON" }, 400);
      }
      const { passage, prompt, studentAnswer } = body || {};
      if (!passage || !prompt || !studentAnswer) {
        return json({ ok: false, error: "passage, prompt, and studentAnswer are required" }, 400);
      }
      const result = await gradeIntent(env, {
        passage: String(passage).slice(0, 6000),
        prompt: String(prompt).slice(0, 1000),
        studentAnswer: String(studentAnswer).slice(0, 2000),
        sampleAnswer: String(body.sampleAnswer || "").slice(0, 1000),
        evidence: String(body.evidence || "").slice(0, 1000)
      });
      return json(result, result.ok ? 200 : 502);
    }

    // ---- everything below this line is KV sync (/api/doc/:id) ----
    const match = url.pathname.match(/^\/api\/doc\/([a-zA-Z0-9_-]+)$/);
    if (!match) {
      return json({ error: "Not found. Use /api/doc/:id, /api/grade-intent, /api/ai-health, or /api/health" }, 404);
    }
    const docId = match[1];

    if (!KNOWN_DOC_IDS.has(docId)) {
      return json({ error: `Unknown doc id "${docId}"` }, 400);
    }

    if (!checkAuth(request, env)) {
      return json({ error: "Unauthorized — missing or wrong X-Sync-Key" }, 401);
    }

    if (!env.INKBOUND_KV) {
      return json({ error: "Worker misconfigured: no INKBOUND_KV binding" }, 500);
    }

    if (request.method === "GET") {
      const raw = await env.INKBOUND_KV.get(docId);
      if (!raw) return json({ value: undefined, updatedAt: 0 });
      try {
        return json(JSON.parse(raw));
      } catch {
        return json({ error: "Corrupt stored value" }, 500);
      }
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Body must be JSON" }, 400);
      }
      const payload = {
        value: body.value,
        updatedAt: typeof body.updatedAt === "number" ? body.updatedAt : Date.now()
      };
      await env.INKBOUND_KV.put(docId, JSON.stringify(payload));
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  }
};
