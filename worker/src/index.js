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
const DB_TEASER_CAP = 2; // сколько настоящих записей структурированной базы видит один IP бесплатно
const DB_TEASER_TTL = 2592000; // 30 дней — не "в день", это и путало при тестировании
const SINGLE_TIER_CAP = 3; // разовый токен (200 сом, 1 раздел) — не весь раздел, а 3 лучших совпадения

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

async function getDbTeaserUsed(env, ip) {
  const n = await env.TOKENS_KV.get(`db_teaser:${ip}`);
  return n ? parseInt(n, 10) || 0 : 0;
}

async function addDbTeaserUsed(env, ip, n) {
  const used = await getDbTeaserUsed(env, ip);
  await env.TOKENS_KV.put(`db_teaser:${ip}`, String(used + n), { expirationTtl: DB_TEASER_TTL });
}

// Многословный запрос ("гранты нко климат") должен требовать все слова где-то в тексте,
// а не точное совпадение всей фразы подряд — иначе такой запрос никогда ничего не найдёт.
function matchesQuery(hay, q) {
  const words = q.split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}

const CRYPTO_QUERY_RE = /крипто|blockchain|блокчейн|биткоин|bitcoin|ethereum|эфириум|web3|nft|defi/i;

// Целевой микс результатов: примерно 50% Кыргызстан / 30% региональные (ЦА) / 20% международные —
// по просьбе владельца, чтобы местные и близкие возможности не терялись среди тысяч глобальных.
// Крипто-специфичные записи скрываются, если явно не спросили про крипто (максимум 1, в конце).
function rerankByRegion(records, q) {
  const cryptoAllowed = CRYPTO_QUERY_RE.test(q || "");
  const crypto = [];
  const rest = [];
  for (const r of records) {
    if (r.is_crypto && !cryptoAllowed) crypto.push(r);
    else rest.push(r);
  }

  const kg = rest.filter((r) => r.region === "kg");
  const regional = rest.filter((r) => r.region === "regional");
  const intl = rest.filter((r) => r.region !== "kg" && r.region !== "regional");

  const buckets = [
    { items: kg, weight: 5 },
    { items: regional, weight: 3 },
    { items: intl, weight: 2 },
  ];
  const cursors = buckets.map(() => 0);
  const out = [];
  let remaining = kg.length + regional.length + intl.length;
  while (remaining > 0) {
    for (let bi = 0; bi < buckets.length; bi++) {
      const b = buckets[bi];
      for (let k = 0; k < b.weight && cursors[bi] < b.items.length; k++) {
        out.push(b.items[cursors[bi]]);
        cursors[bi]++;
        remaining--;
      }
    }
  }
  if (!cryptoAllowed && crypto.length) out.push(crypto[0]);
  return out;
}

async function fetchRecentFbPosts(env) {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) return [];

  const cached = await env.FUNDING_KV.get("fb_recent_cache", "json");
  if (cached) return cached;

  try {
    // limit=50 — чем шире окно, тем меньше риск потерять тематический пост, если с момента
    // публикации вышло много постов на другие темы.
    const apiUrl = `https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/posts?fields=message,created_time,permalink_url&limit=50&access_token=${env.FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    const posts = (data.data || [])
      .map((p) => {
        const title = extractTitle(p.message);
        if (!title) return null;
        // Ссылка ведёт на сам пост на странице FB (не на внешний сайт донора) — держит
        // трафик и вовлечённость на странице Connect4Pro, а не уводит с неё сразу.
        const url = p.permalink_url || extractSourceUrl(p.message) || null;
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

async function search(env, url, request) {
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
  filtered = rerankByRegion(filtered, q);

  const total = filtered.length;

  if (tier === "teaser") {
    // Без токена — до DB_TEASER_CAP настоящих записей суммарно на IP (не за день — это
    // путало при тестировании), дальше только count. Основной стимул оплатить, но новый
    // посетитель сразу видит хотя бы пару реальных записей, а не только архив постов.
    const ip = (request && request.headers.get("cf-connecting-ip")) || "unknown";
    const used = await getDbTeaserUsed(env, ip);
    const left = Math.max(0, DB_TEASER_CAP - used);
    const visibleTotal = Math.min(total, left);
    const results = filtered.slice(0, visibleTotal);
    if (results.length) await addDbTeaserUsed(env, ip, results.length);
    return json({ total, visibleTotal, tier, scope: null, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results });
  }

  if (tier === "single") {
    // Разовый токен — не весь раздел (несправедливо: одни разделы в разы больше других),
    // а до SINGLE_TIER_CAP лучших совпадений. scope.hint (собран ботом при покупке)
    // приходит с фронтенда как q, поэтому rerankByRegion уже отранжировал по нему.
    const visibleTotal = Math.min(total, SINGLE_TIER_CAP);
    const results = filtered.slice(0, visibleTotal);
    return json({ total, visibleTotal, tier, scope, page: 1, pageSize: SINGLE_TIER_CAP, hasMore: false, results });
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
    scope: scope && scope.sheet ? { sheet: String(scope.sheet), hint: scope.hint ? String(scope.hint) : undefined } : null,
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
