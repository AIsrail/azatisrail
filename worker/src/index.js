/**
 * azatisrail.cc — единый Worker: отдаёт статику сайта (env.ASSETS) и API базы доноров (/api/*).
 * Полный массив записей никогда не уходит клиенту целиком — только отфильтрованная страница.
 *
 * Доступ (tier):
 *  - teaser — без токена или истёкший токен: до PAGE_SIZE_TEASER совпадений за запрос,
 *             и не больше TEASER_DAILY_CAP штук суммарно за день на один IP (иначе можно
 *             было бы обойти лимит, просто перебирая разные ключевые слова).
 *  - full   — обычный оплаченный токен: весь массив, постранично.
 *  - single — разовый токен, привязанный к одному разделу (scope.sheet):
 *             весь раздел, но запрос по другим разделам игнорируется (форсится scope.sheet).
 */

import { handleTelegramWebhook } from "./telegram.js";

const PAGE_SIZE_FULL = 15;
const PAGE_SIZE_TEASER = 6;
const TEASER_DAILY_CAP = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/funding" || url.pathname === "/funding.html") {
      return Response.redirect(url.origin + "/", 301);
    }
    if (url.pathname === "/api/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }
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
      return await search(env, url, request);
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

async function resolveAccess(env, token) {
  if (!token) return { tier: "teaser", scope: null };
  const rec = await env.TOKENS_KV.get(token, "json");
  if (!rec) return { tier: "teaser", scope: null };
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return { tier: "teaser", scope: null };
  if (rec.scope && rec.scope.sheet) return { tier: "single", scope: rec.scope };
  return { tier: "full", scope: null };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getTeaserQuotaUsed(env, ip) {
  const n = await env.TOKENS_KV.get(`quota:${ip}:${todayKey()}`);
  return n ? parseInt(n, 10) || 0 : 0;
}

async function addTeaserQuotaUsed(env, ip, n) {
  if (n <= 0) return;
  const used = await getTeaserQuotaUsed(env, ip);
  await env.TOKENS_KV.put(`quota:${ip}:${todayKey()}`, String(used + n), { expirationTtl: 90000 });
}

async function search(env, url, request) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const category = url.searchParams.get("category") || "";
  const token = url.searchParams.get("token") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

  const { tier, scope } = await resolveAccess(env, token);
  // Разовый токен форсит свой раздел — запрос клиента по sheet игнорируется.
  const sheet = tier === "single" ? scope.sheet : url.searchParams.get("sheet") || "";
  const pageSize = tier === "teaser" ? PAGE_SIZE_TEASER : PAGE_SIZE_FULL;

  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  let filtered = all;
  if (sheet) filtered = filtered.filter((r) => r.sheet === sheet);
  if (category) filtered = filtered.filter((r) => Array.isArray(r.categories) && r.categories.includes(category));
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.name, r.description, r.amount, (r.sectors || []).join(" ")].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  const total = filtered.length;

  if (tier !== "teaser") {
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const results = start < total ? filtered.slice(start, end) : [];
    return json({ total, visibleTotal: total, tier, scope, page, pageSize, hasMore: end < total, results });
  }

  // Обход дневного лимита для владельца/тестов: заголовок X-Test-Bypass с тем же
  // значением, что и ADMIN_TOKEN. Дневной счётчик при этом не трогается и не растёт.
  const testBypassHeader = request && request.headers.get("x-test-bypass");
  const isTestBypass = !!(testBypassHeader && env.ADMIN_TOKEN && testBypassHeader === env.ADMIN_TOKEN);

  // Тизер: лимит и на запрос, и суммарно на IP за день — иначе платный доступ
  // обходится перебором разных ключевых слов.
  const ip = (request && request.headers.get("cf-connecting-ip")) || "unknown";
  const quotaUsed = isTestBypass ? 0 : await getTeaserQuotaUsed(env, ip);
  const quotaLeft = isTestBypass ? pageSize : Math.max(0, TEASER_DAILY_CAP - quotaUsed);
  const visibleTotal = Math.min(total, pageSize, quotaLeft);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, visibleTotal);
  const results = start < visibleTotal ? filtered.slice(start, end) : [];
  const hasMore = end < visibleTotal;

  if (results.length && !isTestBypass) await addTeaserQuotaUsed(env, ip, results.length);

  return json({
    total,
    visibleTotal,
    tier,
    scope,
    page,
    pageSize,
    hasMore,
    results,
    quotaExhausted: !isTestBypass && quotaLeft === 0 && total > 0,
  });
}

function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export async function issueTokenRecord(env, { tier, scope, note, expires_at } = {}) {
  const token = genToken();
  const rec = {
    token,
    tier: tier || "full",
    scope: scope && scope.sheet ? { sheet: String(scope.sheet) } : null,
    note: note || "",
    issued_at: new Date().toISOString(),
    expires_at: expires_at || null,
  };
  await env.TOKENS_KV.put(token, JSON.stringify(rec));
  return rec;
}

async function issueToken(request, env) {
  const body = await request.json().catch(() => ({}));
  const rec = await issueTokenRecord(env, body);
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
