/**
 * azatisrail.cc — единый Worker: отдаёт статику сайта (env.ASSETS) и API базы доноров (/api/*).
 * Полный массив записей никогда не уходит клиенту целиком — только отфильтрованная страница.
 */

const PAGE_SIZE_FULL = 15;
const PAGE_SIZE_TEASER = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleApi(request, env, url) {
  try {
    if (url.pathname === "/api/search" && request.method === "GET") {
      return await search(env, url);
    }
    if (url.pathname === "/api/admin/tokens" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      return denied || (await listTokens(env));
    }
    if (url.pathname === "/api/admin/tokens" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      return denied || (await issueToken(request, env));
    }
    if (url.pathname === "/api/admin/tokens" && request.method === "DELETE") {
      const denied = requireAdmin(request, env);
      return denied || (await revokeToken(env, url));
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: "server_error", message: String(e && e.message ? e.message : e) }, 500);
  }
}

function requireAdmin(request, env) {
  const hdr = request.headers.get("X-Admin-Token") || "";
  if (!env.ADMIN_TOKEN || hdr !== env.ADMIN_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

async function getTier(env, token) {
  if (!token) return "teaser";
  const rec = await env.TOKENS_KV.get(token, "json");
  if (!rec) return "teaser";
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return "teaser";
  return "full";
}

async function search(env, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const category = url.searchParams.get("category") || "";
  const sheet = url.searchParams.get("sheet") || "";
  const token = url.searchParams.get("token") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

  const tier = await getTier(env, token);
  const pageSize = tier === "full" ? PAGE_SIZE_FULL : PAGE_SIZE_TEASER;

  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  let filtered = all;
  if (category) filtered = filtered.filter((r) => Array.isArray(r.categories) && r.categories.includes(category));
  if (sheet) filtered = filtered.filter((r) => r.sheet === sheet);
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.name, r.description, r.amount, (r.sectors || []).join(" ")].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  const total = filtered.length;
  const visibleTotal = tier === "full" ? total : Math.min(total, pageSize);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, visibleTotal);
  const results = start < visibleTotal ? filtered.slice(start, end) : [];
  const hasMore = end < visibleTotal;

  return json({ total, visibleTotal, tier, page, pageSize, hasMore, results });
}

function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function issueToken(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = genToken();
  const rec = {
    token,
    tier: body.tier || "full",
    note: body.note || "",
    issued_at: new Date().toISOString(),
    expires_at: body.expires_at || null,
  };
  await env.TOKENS_KV.put(token, JSON.stringify(rec));
  return json({ ok: true, token: rec });
}

async function listTokens(env) {
  const list = await env.TOKENS_KV.list();
  const items = await Promise.all(list.keys.map((k) => env.TOKENS_KV.get(k.name, "json")));
  const tokens = items.filter(Boolean).sort((a, b) => (b.issued_at || "").localeCompare(a.issued_at || ""));
  return json({ tokens });
}

async function revokeToken(env, url) {
  const token = url.searchParams.get("token");
  if (!token) return json({ error: "missing_token" }, 400);
  await env.TOKENS_KV.delete(token);
  return json({ ok: true });
}
