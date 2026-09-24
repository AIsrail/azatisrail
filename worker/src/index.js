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

import { handleTelegramWebhook, notifyAdminFallback } from "./telegram.js";
import {
  extractTitle,
  extractSourceUrl,
  extractExcerpt,
  extractDeadlineStatus,
  classifyArchiveRegion,
  extractQueryWords,
  matchesQuery,
  matchesQueryLoose,
  makeRelevanceScorer,
} from "./extract.js";

const PAGE_SIZE_FULL = 15;
const ARCHIVE_RESULTS_LIMIT = 3;
const FB_CACHE_TTL = 900; // 15 минут — свежие посты подтягиваются быстро, но не на каждый запрос
const DB_TEASER_CAP = 2; // сколько настоящих записей структурированной базы видит один IP бесплатно
const DB_TEASER_TTL = 2592000; // 30 дней — не "в день", это и путало при тестировании
const SINGLE_TIER_CAP = 5; // разовый токен (200 сом, 1 раздел) — не весь раздел, а 5 лучших совпадений

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
    if (url.pathname === "/api/admin/records" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      return denied || (await listManualRecords(env));
    }
    if (url.pathname === "/api/admin/records" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      return denied || (await addManualRecord(request, env));
    }
    if (url.pathname === "/api/admin/records" && request.method === "DELETE") {
      const denied = requireAdmin(request, env);
      return denied || (await removeManualRecord(env, url));
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
  const buyer = { buyer_chat_id: rec.buyer_chat_id, buyer_label: rec.buyer_label };
  if (rec.scope && rec.scope.sheet) return { tier: "single", scope: rec.scope, ...buyer };
  return { tier: "full", scope: null, ...buyer };
}

async function getDbTeaserUsed(env, ip) {
  const n = await env.TOKENS_KV.get(`db_teaser:${ip}`);
  return n ? parseInt(n, 10) || 0 : 0;
}

async function addDbTeaserUsed(env, ip, n) {
  const used = await getDbTeaserUsed(env, ip);
  await env.TOKENS_KV.put(`db_teaser:${ip}`, String(used + n), { expirationTtl: DB_TEASER_TTL });
}

// Уведомляем владельца только один раз на токен, а не на каждый повторный поиск/перезагрузку
// страницы — иначе один "промах" покупателя спамит одним и тем же уведомлением многократно.
async function notifyFallbackOnce(env, token, details) {
  const key = `fallback_notified:${token}`;
  if (await env.TOKENS_KV.get(key)) return;
  await env.TOKENS_KV.put(key, "1", { expirationTtl: 2592000 });
  await notifyAdminFallback(env, { token, ...details });
}

const CRYPTO_QUERY_RE = /крипто|blockchain|блокчейн|биткоин|bitcoin|ethereum|эфириум|web3|nft|defi/i;

// Крипто-специфичные записи скрываются, если явно не спросили про крипто (максимум 1, в конце).
// Общая логика для rerankByRegion и разового тарифа (rankForSingleTier).
function suppressCryptoRecords(records, q) {
  const cryptoAllowed = CRYPTO_QUERY_RE.test(q || "");
  const crypto = [];
  const rest = [];
  for (const r of records) {
    if (r.is_crypto && !cryptoAllowed) crypto.push(r);
    else rest.push(r);
  }
  return { rest, cryptoTail: !cryptoAllowed && crypto.length ? [crypto[0]] : [] };
}

// Целевой микс результатов: примерно 50% Кыргызстан / 30% региональные (ЦА) / 20% международные —
// по просьбе владельца, чтобы местные и близкие возможности не терялись среди тысяч глобальных.
function rerankByRegion(records, q) {
  const { rest, cryptoTail } = suppressCryptoRecords(records, q);

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
  out.push(...cryptoTail);
  return out;
}

function regionRank(r) {
  if (r.region === "kg") return 0;
  if (r.region === "regional") return 1;
  return 2;
}

// "easy" — посольские программы, госсоцзаказ, безусловные малые гранты (Pollination,
// Awesome и т.п.) и записи, добавленные владельцем вручную (см. addManualRecord — их
// специально подбирают под конкретный случай). Первому покупателю разового тарифа (обычно
// без опыта подачи заявок) это даёт куда больше практической пользы, чем формально
// подходящий по теме, но конкурентный международный фонд, требующий трека/английского/питча.
// Бонус, а не жёсткая сортировка: сильное тематическое совпадение (например, специализированный
// фонд именно по нужной теме) не должно тонуть под записями, зацепившимися за одно общее слово
// только потому, что те помечены "easy" — обошлись без этого один раз, повторять не будем.
const EASY_BONUS = 1.5;
const KG_BONUS = 1;
const REGIONAL_BONUS = 0.5;

function accessRegionBonus(r) {
  let bonus = r.access_tier === "easy" ? EASY_BONUS : 0;
  if (r.region === "kg") bonus += KG_BONUS;
  else if (r.region === "regional") bonus += REGIONAL_BONUS;
  return bonus;
}

// Когда строгий AND-поиск ничего не дал и в ход идёт мягкий поиск по отдельным словам,
// региональный микс (rerankByRegion) не годится: он раскладывает по 50/30/20 вслепую и
// задвигает единственную тематически точную запись (например, специализированный
// международный фонд) под общие местные записи, зацепившиеся только за одно общее слово.
// Здесь порядок определяет число совпавших слов, регион — только тай-брейк при равенстве.
function relevanceRerank(pairs, q) {
  const cryptoAllowed = CRYPTO_QUERY_RE.test(q || "");
  const crypto = [];
  const rest = [];
  for (const p of pairs) {
    if (p.r.is_crypto && !cryptoAllowed) crypto.push(p);
    else rest.push(p);
  }
  rest.sort((a, b) => b.score - a.score || regionRank(a.r) - regionRank(b.r));
  const out = rest.map((p) => p.r);
  if (!cryptoAllowed && crypto.length) out.push(crypto[0].r);
  return out;
}

const SINGLE_SEEN_TTL = 7776000; // 90 дней — сколько помним, что этому IP уже показывали

async function getSingleSeen(env, ip) {
  const arr = await env.TOKENS_KV.get(`single_seen:${ip}`, "json");
  return Array.isArray(arr) ? arr : [];
}

async function addSingleSeen(env, ip, ids) {
  const cur = await getSingleSeen(env, ip);
  const next = Array.from(new Set([...cur, ...ids.filter(Boolean)])).slice(-200);
  await env.TOKENS_KV.put(`single_seen:${ip}`, JSON.stringify(next), { expirationTtl: SINGLE_SEEN_TTL });
}

// Итоговая сортировка для разового тарифа: непоказанные этому IP записи — вперёд (при
// повторной оплате открывает новое, а не повтор); внутри — релевантность (если считали) плюс
// бонус за простой/местный доступ. Бонус умеренный (+1.5/+1/+0.5), а не отдельная категория
// впереди всего: иначе один нерелевантный "easy"-грант (зацепился за общее слово вроде
// "гранты") обходит специализированный фонд именно по нужной теме — то, ради чего вообще
// делали релевантный скоринг. Это НЕ фильтрация — count/total не меняется, только порядок.
function rankForSingleTier(records, seenIds, scoreById) {
  const arr = records.slice();
  arr.sort((a, b) => {
    const seenA = seenIds.has(a.id) ? 1 : 0;
    const seenB = seenIds.has(b.id) ? 1 : 0;
    if (seenA !== seenB) return seenA - seenB;
    const scoreA = (scoreById ? scoreById.get(a.id) || 0 : 0) + accessRegionBonus(a);
    const scoreB = (scoreById ? scoreById.get(b.id) || 0 : 0) + accessRegionBonus(b);
    return scoreB - scoreA;
  });
  return arr;
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
        const date = (p.created_time || "").slice(0, 10);
        return {
          date,
          title,
          excerpt: extractExcerpt(p.message),
          url,
          deadlineStatus: extractDeadlineStatus(p.message, date),
          region: classifyArchiveRegion(p.message),
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

  const archiveHay = (r) => [r.title, r.excerpt].filter(Boolean).join(" ").toLowerCase();
  let filtered = merged;
  if (q) {
    filtered = merged.filter((r) => matchesQuery(archiveHay(r), q));
    if (filtered.length === 0) filtered = merged.filter((r) => matchesQueryLoose(archiveHay(r), q));
  }
  // Бесплатный тизер не должен дублировать платную базу: показываем только то, что уже
  // неактуально (дедлайн прошёл), или международные возможности без указанного дедлайна —
  // туда абсолютное большинство местных пользователей всё равно не идёт.
  const freeEligible = filtered.filter(
    (r) => r.deadlineStatus === "passed" || (r.deadlineStatus === "none" && r.region === "international")
  );
  const total = freeEligible.length;
  const results = freeEligible.slice(0, ARCHIVE_RESULTS_LIMIT);
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
    const archiveFullHay = (r) => [r.title, r.excerpt].filter(Boolean).join(" ").toLowerCase();
    const strict = filtered.filter((r) => matchesQuery(archiveFullHay(r), q));
    filtered = strict.length ? strict : filtered.filter((r) => matchesQueryLoose(archiveFullHay(r), q));
  }
  const total = filtered.length;

  // Разовый токен (200 сом) покупается за доступ к одному разделу структурированной базы,
  // не к архиву публикаций — иначе за 200 сом отдавался бы весь архив (339 записей) без
  // ограничений, что и было багом. Архив публикаций доступен только с basic/standard/premium.
  if (tier === "teaser" || tier === "single") {
    return json({ total, tier, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results: [] });
  }

  const start = (page - 1) * PAGE_SIZE_FULL;
  const end = Math.min(start + PAGE_SIZE_FULL, total);
  const results = start < total ? filtered.slice(start, end) : [];
  return json({ total, tier, page, pageSize: PAGE_SIZE_FULL, hasMore: end < total, results });
}

function recordHay(r) {
  return [r.name, r.description, r.amount, (r.sectors || []).join(" ")].filter(Boolean).join(" ").toLowerCase();
}

async function search(env, url, request) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const category = url.searchParams.get("category") || "";
  const token = url.searchParams.get("token") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

  const { tier, scope, buyer_chat_id, buyer_label } = await resolveAccess(env, token);
  // Разовый токен форсит свой раздел — запрос клиента по sheet игнорируется.
  const sheet = tier === "single" ? scope.sheet : url.searchParams.get("sheet") || "";

  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  let base = all;
  if (sheet) base = base.filter((r) => r.sheet === sheet);
  if (category) base = base.filter((r) => Array.isArray(r.categories) && r.categories.includes(category));

  let candidates = base;
  let relevanceRanked = null;
  let scoreById = null;
  let queryFallback = false;
  if (q) {
    // Длинная фраза (например, подсказка, собранная ботом у покупателя разового тарифа)
    // почти никогда не совпадёт по всем словам буквально — сначала строгий AND-поиск.
    const strict = base.filter((r) => matchesQuery(recordHay(r), q));
    if (strict.length) {
      candidates = strict;
    } else {
      // Мягкий поиск с оценкой числа совпавших слов — ранжируем по релевантности, а не
      // по региону, иначе одно общее слово ("гранты") зашумляет топ мимо точных совпадений.
      const words = extractQueryWords(q);
      let scored = [];
      if (words.length) {
        const hays = base.map(recordHay);
        const scoreOf = makeRelevanceScorer(hays, words);
        scored = base.map((r, i) => ({ r, score: scoreOf(hays[i]) })).filter((p) => p.score > 0);
      }
      if (scored.length) {
        relevanceRanked = relevanceRerank(scored, q);
        scoreById = new Map(scored.map((p) => [p.r.id, p.score]));
      } else if (tier === "single") {
        // Разовый токен: если даже мягкий поиск не нашёл ничего в оплаченном разделе — не
        // оставляем покупателя с пустыми руками, показываем подборку по разделу без
        // фильтра по запросу (ниже всё равно ранжируется как обычно для разового тарифа).
        candidates = base;
        queryFallback = true;
      } else {
        candidates = [];
      }
    }
  }

  const ip = (request && request.headers.get("cf-connecting-ip")) || "unknown";
  let filtered;
  if (tier === "single") {
    // Разовый тариф ранжируется иначе, чем полный доступ: сначала непоказанные этому IP
    // записи (повторная оплата открывает новое), среди них — сначала простой/местный доступ
    // (посольства, госсоцзаказ, безусловные малые гранты), а не формально попавшая по
    // ключевым словам, но нереалистичная для новичка международная конкурсная программа.
    const pool = relevanceRanked
      ? relevanceRanked
      : (() => {
          const { rest, cryptoTail } = suppressCryptoRecords(candidates, q);
          return [...rest, ...cryptoTail];
        })();
    const seenIds = new Set(await getSingleSeen(env, ip));
    filtered = rankForSingleTier(pool, seenIds, scoreById);
  } else {
    filtered = relevanceRanked || rerankByRegion(candidates, q);
  }

  const total = filtered.length;

  if (tier === "teaser") {
    // Без токена — до DB_TEASER_CAP настоящих записей суммарно на IP (не за день — это
    // путало при тестировании), дальше только count. Основной стимул оплатить, но новый
    // посетитель сразу видит хотя бы пару реальных записей, а не только архив постов.
    const used = await getDbTeaserUsed(env, ip);
    const left = Math.max(0, DB_TEASER_CAP - used);
    const visibleTotal = Math.min(total, left);
    const results = filtered.slice(0, visibleTotal);
    if (results.length) await addDbTeaserUsed(env, ip, results.length);
    return json({ total, visibleTotal, tier, scope: null, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results });
  }

  if (tier === "single") {
    // Разовый токен — не весь раздел (несправедливо: одни разделы в разы больше других),
    // а до SINGLE_TIER_CAP лучших совпадений, отранжированных rankForSingleTier выше.
    const visibleTotal = Math.min(total, SINGLE_TIER_CAP);
    const results = filtered.slice(0, visibleTotal);
    if (results.length) await addSingleSeen(env, ip, results.map((r) => r.id));
    if (queryFallback && token) await notifyFallbackOnce(env, token, { sheet, q, buyer_chat_id, buyer_label });
    return json({ total, visibleTotal, tier, scope, page: 1, pageSize: SINGLE_TIER_CAP, hasMore: false, results, queryFallback });
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

export async function issueTokenRecord(env, { tier, scope, note, expires_at, buyer_chat_id, buyer_label } = {}) {
  const token = genToken();
  const rec = {
    token,
    tier: tier || "full",
    scope: scope && scope.sheet ? { sheet: String(scope.sheet), hint: scope.hint ? String(scope.hint) : undefined } : null,
    note: note || "",
    issued_at: new Date().toISOString(),
    expires_at: expires_at || null,
    // Только для токенов, выданных ботом за реальную оплату — нужно, чтобы при
    // "промахе" поиска (см. queryFallback в search()) можно было уведомить владельца
    // и ответить покупателю напрямую через бота, а не только показать ему подборку.
    buyer_chat_id: buyer_chat_id || undefined,
    buyer_label: buyer_label || undefined,
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
  // TOKENS_KV также хранит служебные записи (_admin_chat, pending:*, payreq:*, db_teaser:*,
  // fallback_notified:*) — берём только настоящие токены доступа, а не весь namespace.
  const tokens = items
    .filter((it) => it && typeof it === "object" && it.token)
    .sort((a, b) => (b.issued_at || "").localeCompare(a.issued_at || ""));
  return json({ tokens });
}

async function revokeToken(env, url) {
  const token = url.searchParams.get("token");
  if (!token) return json({ error: "missing_token" }, 400);
  await env.TOKENS_KV.delete(token);
  return json({ ok: true });
}

// Записи, добавленные владельцем вручную (обычно — когда поиск для разового тарифа не
// нашёл ничего в базе, см. queryFallback/notifyAdminFallback): попадают в тот же массив
// "records", что и основная база, поэтому сразу участвуют в обычном поиске.
async function listManualRecords(env) {
  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  return json({ records: all.filter((r) => r.source === "manual") });
}

async function addManualRecord(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.sheet || !body.name) return json({ error: "missing_fields" }, 400);
  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  const rec = {
    id: `manual-${Date.now().toString(36)}-${genToken().slice(0, 4)}`,
    sheet: String(body.sheet),
    name: String(body.name),
    description: body.description ? String(body.description) : "",
    amount: body.amount ? String(body.amount) : "",
    deadline: body.deadline ? String(body.deadline) : "",
    region: ["kg", "regional", "international"].includes(body.region) ? body.region : "international",
    categories: Array.isArray(body.categories) ? body.categories.filter((c) => typeof c === "string") : [],
    sectors: Array.isArray(body.sectors) ? body.sectors.filter((s) => typeof s === "string") : [],
    is_crypto: Boolean(body.is_crypto),
    // Владелец добавляет эти записи целенаправленно под конкретный случай (обычно —
    // после queryFallback), поэтому по умолчанию считаем их простыми/доступными для
    // новичка, как посольские программы и госсоцзаказ — см. accessRank в search().
    access_tier: body.access_tier === "standard" ? "standard" : "easy",
    source: "manual",
    added_at: new Date().toISOString(),
  };
  all.push(rec);
  await env.FUNDING_KV.put("records", JSON.stringify(all));
  return json({ ok: true, record: rec });
}

async function removeManualRecord(env, url) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "missing_id" }, 400);
  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return json({ error: "not_found" }, 404);
  await env.FUNDING_KV.put("records", JSON.stringify(next));
  return json({ ok: true });
}
