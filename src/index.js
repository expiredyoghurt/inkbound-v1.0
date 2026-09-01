const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(body, { ...init, headers });
}

async function handleAiHealth(request, env) {
  const hasAi = typeof env.AI !== "undefined";
  return corsResponse(
    JSON.stringify({
      status: hasAi ? "available" : "disabled",
      provider: hasAi ? "cloudflare" : "keyword-fallback",
      timestamp: Date.now(),
    }),
    { status: 200 }
  );
}

async function handleDoc(request, env, collection) {
  const kvKey = `doc:${collection}`;
  const method = request.method;

  if (method === "OPTIONS") {
    return corsResponse(null, { status: 204 });
  }

  if (method === "GET") {
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const deadline = Date.now() + 25000;
    let doc = null;
    let updatedAt = 0;

    while (Date.now() < deadline) {
      const raw = await env.INKBOUND_KV.get(kvKey, "text");
      if (raw) {
        try {
          doc = JSON.parse(raw);
          updatedAt = doc.updatedAt || doc._updatedAt || 0;
        } catch {
          doc = raw;
          updatedAt = Date.now();
        }
      }

      if (updatedAt > since || since === 0) {
        return corsResponse(
          JSON.stringify({ collection, data: doc, updatedAt: updatedAt || Date.now() }),
          { status: 200 }
        );
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    return corsResponse(
      JSON.stringify({ collection, updatedAt: since, timeout: true }),
      { status: 304 }
    );
  }

  if (method === "POST" || method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
    }

    if (typeof body === "object" && body !== null) {
      body.updatedAt = Date.now();
      body._updatedAt = body.updatedAt;
    }

    await env.INKBOUND_KV.put(kvKey, JSON.stringify(body));

    return corsResponse(
      JSON.stringify({ collection, ok: true, updatedAt: body.updatedAt }),
      { status: 200 }
    );
  }

  if (method === "DELETE") {
    await env.INKBOUND_KV.delete(kvKey);
    return corsResponse(JSON.stringify({ collection, deleted: true }), { status: 200 });
  }

  return corsResponse(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return corsResponse(null, { status: 204 });
    }

    if (path === "/api/ai-health") {
      return handleAiHealth(request, env);
    }

    if (path.startsWith("/api/doc/")) {
      const collection = path.replace("/api/doc/", "").split("/")[0];
      if (!collection) {
        return corsResponse(JSON.stringify({ error: "Missing collection name" }), { status: 400 });
      }
      return
