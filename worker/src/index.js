/**
 * azatisrail.cc — единый Worker: отдаёт статику сайта (env.ASSETS) и API базы доноров (/api/*).
 * Полный массив записей никогда не уходит клиенту целиком — только отфильтрованная страница.
 *
 * Три независимых поиска:
 *  - /api/archive-search — бесплатно и без ограничений, 2-3 примера из архива уже
 *    опубликованных постов канала/страницы (KV "archive" + живой запрос последних постов
 *    FB). Публичный контент, ограничивать нечего — это тизер основной базы.
 *  - /api/search — структурированная платная база (KV "records", 482 записи). Без токена
 *    не отдаёт ни одной записи, только total. tier: full | single (разовый токен,
 *    форсит scope.sheet — запрос клиента по sheet игнорируется).
 *  - /api/archive-full — платный полный архив публикаций (KV "archive_full"), с категориями
 *    (Гранты/Бизнес,НКО | Инвестиции | Обучение). Без токена — только total, как и /api/search.
 */

import { handleTelegramWebhook } from "./telegram.js";
import { extractTitle, extractSourceUrl, extractExcerpt } from "./extract.js";

const PAGE_SIZE_FULL = 15;
const ARCHIVE_RESULTS_LIMIT = 3;
const FB_CACHE_TTL = 900; // 15 минут — свежие посты подтягиваются быстро, но не на каждый запрос

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
      return await search(env, url);
    }
    if (url.pathname === "/api/archive-search" && request.method === "GET") {
      return await archiveSearch(env, url);
    }
    if (url.pathname === "/api/archive-full" && request.method === "GET") {
      return await archiveFullSearch(env, url);
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

// Многословный запрос ("гранты нко климат") должен требовать все слова где-то в тексте,
// а не точное совпадение всей фразы подряд — иначе такой запрос никогда ничего не найдёт.
function matchesQuery(hay, q) {
  const words = q.split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}

async function fetchRecentFbPosts(env) {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) return [];

  const cached = await env.FUNDING_KV.get("fb_recent_cache", "json");
  if (cached) return cached;

  try {
    const apiUrl = `https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/posts?fields=message,created_time,permalink_url&limit=25&access_token=${env.FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    const posts = (data.data || [])
      .map((p) => {
        const title = extractTitle(p.message);
        if (!title) return null;
        const url = extractSourceUrl(p.message) || p.permalink_url || null;
        if (!url) return null;
        return {
          date: (p.created_time || "").slice(0, 10),
          title,
          excerpt: extractExcerpt(p.message),
          url,
        };
      })
      .filter(Boolean);
    // Короткий кэш — не дёргаем Graph API на каждый отдельный поиск.
    await env.FUNDING_KV.put("fb_recent_cache", JSON.stringify(posts), { expirationTtl: FB_CACHE_TTL });
    return posts;
  } catch (e) {
    return [];
  }
}

async function archiveSearch(env, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();

  const [stored, recent] = await Promise.all([
    env.FUNDING_KV.get("archive", "json"),
    fetchRecentFbPosts(env),
  ]);

  const seenTitles = new Set();
  const merged = [];
  for (const r of recent.concat(stored || [])) {
    const key = (r.title || "").trim().toLowerCase();
    if (!key || seenTitles.has(key)) continue;
    seenTitles.add(key);
    merged.push(r);
  }
  merged.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  let filtered = merged;
  if (q) {
    filtered = merged.filter((r) => {
      const hay = [r.title, r.excerpt].filter(Boolean).join(" ").toLowerCase();
      return matchesQuery(hay, q);
    });
  }
  const total = filtered.length;
  const results = filtered.slice(0, ARCHIVE_RESULTS_LIMIT);
  return json({ total, results });
}

async function archiveFullSearch(env, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const category = url.searchParams.get("category") || "";
  const subcategory = url.searchParams.get("subcategory") || "";
  const token = url.searchParams.get("token") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

  const { tier } = await resolveAccess(env, token);
  const all = (await env.FUNDING_KV.get("archive_full", "json")) || [];

  let filtered = all;
  if (category) filtered = filtered.filter((r) => r.category === category);
  if (subcategory) filtered = filtered.filter((r) => r.subcategory === subcategory);
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.title, r.excerpt].filter(Boolean).join(" ").toLowerCase();
      return matchesQuery(hay, q);
    });
  }
  const total = filtered.length;

  if (tier === "teaser") {
    return json({ total, tier, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results: [] });
  }

  const start = (page - 1) * PAGE_SIZE_FULL;
  const end = Math.min(start + PAGE_SIZE_FULL, total);
  const results = start < total ? filtered.slice(start, end) : [];
  return json({ total, tier, page, pageSize: PAGE_SIZE_FULL, hasMore: end < total, results });
}

async function search(env, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const category = url.searchParams.get("category") || "";
  const token = url.searchParams.get("token") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

  const { tier, scope } = await resolveAccess(env, token);
  // Разовый токен форсит свой раздел — запрос клиента по sheet игнорируется.
  const sheet = tier === "single" ? scope.sheet : url.searchParams.get("sheet") || "";

  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  let filtered = all;
  if (sheet) filtered = filtered.filter((r) => r.sheet === sheet);
  if (category) filtered = filtered.filter((r) => Array.isArray(r.categories) && r.categories.includes(category));
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.name, r.description, r.amount, (r.sectors || []).join(" ")].filter(Boolean).join(" ").toLowerCase();
      return matchesQuery(hay, q);
    });
  }

  const total = filtered.length;

  if (tier === "teaser") {
    // Без токена — ни одной записи, только количество совпадений (мотивация оплатить).
    // Бесплатный "вкус" даёт отдельный /api/archive-search по уже публичному архиву постов.
    return json({ total, visibleTotal: 0, tier, scope: null, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results: [] });
  }

  const start = (page - 1) * PAGE_SIZE_FULL;
  const end = Math.min(start + PAGE_SIZE_FULL, total);
  const results = start < total ? filtered.slice(start, end) : [];
  return json({ total, visibleTotal: total, tier, scope, page, pageSize: PAGE_SIZE_FULL, hasMore: end < total, results });
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
