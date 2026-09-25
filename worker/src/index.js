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
  normalizeRu,
} from "./extract.js";
import { semanticScores, reindex, dbInfo } from "./semantic.js";

const PAGE_SIZE_FULL = 15;
const ARCHIVE_RESULTS_LIMIT = 3;
const FB_CACHE_TTL = 900; // 15 минут — свежие посты подтягиваются быстро, но не на каждый запрос
const DB_TEASER_CAP = 2; // сколько настоящих записей структурированной базы видит один IP бесплатно
const DB_TEASER_TTL = 2592000; // 30 дней — не "в день", это и путало при тестировании
const SINGLE_TIER_CAP = 5; // разовый токен (200 сом, 1 раздел) — не весь раздел, а 5 лучших совпадений

// Тарифы с 2026-09-25 (rec.tier токена = id тарифа в боте):
//   "db"  — 1500 сом, только структурированная база, 6 месяцев;
//   "pro" — 4500 сом, база + архив публикаций + пособия + ИИ-помощник fund4pro, 6 месяцев.
// Старые бессрочные коды ("basic"/"standard"/"premium", выданные вручную "full") сохраняют всё,
// что им обещали при покупке: база + архив публикаций.
const PLAN_DB = "db";
// Сколько проектов в fund4pro (ИИ-помощник по проектным предложениям) даёт код этого тарифа.
// Старые "standard"/"premium" (4900/8900 сом) — не меньше нового "pro".
const FUND4PRO_PROJECTS = { pro: 2, standard: 2, premium: 2 };

// Семантический поиск (см. semantic.js). Абсолютная косинусная близость EmbeddingGemma зависит от
// запроса: у "стартап" лучшая запись ~0.53, у "ГЭС" ~0.25, у "кондитерский цех" ~0.17. Поэтому всё
// меряется относительно лучшей записи по этому запросу (rel = sim / top, лучшая = 1).
// В выдачу — записи с rel ≥ SEM_REL_MIN и sim ≥ SEM_MIN (совсем посторонние отсекаются).
const SEM_REL_MIN = 0.7;
const SEM_MIN = 0.12;
// Очки = SEM_SCALE * rel + accessRegionBonus (до +2.5 за местный/простой доступ). При 10 бонус
// +2.5 перевешивает до 25% отставания по близости: местная/простая запись из верхней части
// выдачи обходит международную, но явно посторонняя местная — нет (её и так нет в выдаче).
const SEM_SCALE = 10;
const SEM_KEYWORD_BONUS = 1;
// Для узких запросов (например, "швейный цех") порог по близости может оставить 1-2 записи —
// показываем не меньше SEM_MIN_RESULTS лучших по близости, если они выше SEM_MIN.
const SEM_MIN_RESULTS = 5;
// Если даже лучшая запись дальше этого порога — в базе по теме по сути ничего нет (например,
// "кондитерский цех": ~0.17). Выдача показывается, но для разового тарифа это считается
// промахом (queryFallback): покупателю — пояснение, владельцу — уведомление, как и раньше.
const SEM_WEAK = 0.2;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/funding" || url.pathname === "/funding.html") {
      return Response.redirect(url.origin + "/", 301);
    }
    if (url.pathname === "/api/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, ctx);
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

async function handleApi(request, env, url, ctx) {
  try {
    if (url.pathname === "/api/search" && request.method === "GET") {
      return await search(env, url, request, ctx);
    }
    if (url.pathname === "/api/db-info" && request.method === "GET") {
      return json(await dbInfo(env));
    }
    if (url.pathname === "/api/archive-search" && request.method === "GET") {
      return await archiveSearch(env, url);
    }
    if (url.pathname === "/api/archive-full" && request.method === "GET") {
      return await archiveFullSearch(env, url);
    }
    if (url.pathname === "/api/fund4pro/redeem" && request.method === "POST") {
      return await fund4proRedeem(request, env);
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
      return denied || (await addManualRecord(request, env, ctx));
    }
    if (url.pathname === "/api/admin/records" && request.method === "DELETE") {
      const denied = requireAdmin(request, env);
      return denied || (await removeManualRecord(env, url));
    }
    if (url.pathname === "/api/admin/reindex" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      return denied || json({ ok: true, ...(await reindex(env, { force: url.searchParams.get("force") === "1" })) });
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
  const meta = { plan: rec.tier || "full", expires_at: rec.expires_at || null };
  if (rec.scope && rec.scope.sheet) return { tier: "single", scope: rec.scope, ...buyer, ...meta };
  return { tier: "full", scope: null, ...buyer, ...meta };
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
// Ниже почти любого реального совпадения по ключевым словам (даже слабого — одно общее
// слово вроде "гранты" уже даёт больше), но выше нуля: генералист-доноры дополняют
// список, а не соревнуются на равных с записями, реально упомянувшими тему запроса.
const GENERALIST_BASE_SCORE = 0.5;

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
  rest.sort((a, b) => (b.score + accessRegionBonus(b.r)) - (a.score + accessRegionBonus(a.r)));
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

// Топ-N по чистому скору часто скучивается в одной узкой группе (например, несколько местных
// благотворительных фондов одного типа) — покупатель получает не "5 вариантов", а "1 вариант
// 5 раз". group = регион + уровень доступа (это уже разделяет, например, местные религиозные
// фонды от посольских программ, хотя оба региона "kg"). Не более cap-2 подряд из одной
// группы — но только если есть чем разбавить; если разнообразия в самих данных нет,
// оставшиеся слоты всё равно заполняются лучшими по скору, а не пустуют.
function diversifyTop(ranked, cap) {
  const maxSameGroup = Math.max(1, cap - 2);
  const groupOf = (r) => `${r.region || "international"}:${r.access_tier || "standard"}`;
  const counts = {};
  const picked = [];
  const deferred = [];
  for (const r of ranked) {
    if (picked.length >= cap) {
      deferred.push(r);
      continue;
    }
    const key = groupOf(r);
    if ((counts[key] || 0) < maxSameGroup) {
      picked.push(r);
      counts[key] = (counts[key] || 0) + 1;
    } else {
      deferred.push(r);
    }
  }
  for (const r of deferred) {
    if (picked.length >= cap) break;
    picked.push(r);
  }
  return picked;
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

  const archiveHay = (r) => normalizeRu([r.title, r.excerpt].filter(Boolean).join(" "));
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

  const { tier, plan } = await resolveAccess(env, token);
  const all = (await env.FUNDING_KV.get("archive_full", "json")) || [];

  let filtered = all;
  if (category) filtered = filtered.filter((r) => r.category === category);
  if (subcategory) filtered = filtered.filter((r) => r.subcategory === subcategory);
  if (q) {
    const archiveFullHay = (r) => normalizeRu([r.title, r.excerpt].filter(Boolean).join(" "));
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
  // Тариф 1500 сом — только база доноров; архив публикаций входит в 4500.
  if (plan === PLAN_DB) {
    return json({ total, tier, plan, archiveLocked: true, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results: [] });
  }

  const start = (page - 1) * PAGE_SIZE_FULL;
  const end = Math.min(start + PAGE_SIZE_FULL, total);
  const results = start < total ? filtered.slice(start, end) : [];
  return json({ total, tier, page, pageSize: PAGE_SIZE_FULL, hasMore: end < total, results });
}

function recordHay(r) {
  return normalizeRu(
    [r.name, r.description, r.amount, (r.sectors || []).join(" "), (r.tags || []).join(" ")].filter(Boolean).join(" ")
  );
}

async function search(env, url, request, ctx) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const category = url.searchParams.get("category") || "";
  const token = url.searchParams.get("token") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const sheetParam = url.searchParams.get("sheet") || "";
  const ip = (request && request.headers.get("cf-connecting-ip")) || "unknown";
  return json(await performSearch(env, ctx, { q, category, token, page, sheetParam, ip }));
}

// Вынесено из search(): переиспользуется ботом (telegram.js) для мгновенной выдачи результатов
// разового тарифа прямо в чат, без похода покупателя на сайт с кодом доступа.
export async function performSearch(env, ctx, { q = "", category = "", token = "", page = 1, sheetParam = "", ip = "unknown" } = {}) {
  const { tier, scope, buyer_chat_id, buyer_label, plan, expires_at } = await resolveAccess(env, token);
  // Разовый токен форсит свой раздел — запрос клиента по sheet игнорируется.
  const sheet = tier === "single" ? scope.sheet : sheetParam;

  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  let base = all;
  if (sheet) base = base.filter((r) => r.sheet === sheet);
  if (category) base = base.filter((r) => Array.isArray(r.categories) && r.categories.includes(category));

  let candidates = base;
  let relevanceRanked = null;
  let scoreById = null;
  let queryFallback = false;
  const sem = q ? await semanticScores(env, ctx, base, q, all.length) : null;
  if (q && sem) {
    // Основной путь: ранжирование по смыслу (см. SEM_* выше). Поиск по словам ниже — запасной,
    // на случай если Workers AI недоступен или индекс векторов ещё строится.
    const top = Math.max(...sem.values());
    const sims = [...sem.values()].sort((a, b) => b - a);
    const nth = sims[Math.min(SEM_MIN_RESULTS, sims.length) - 1];
    const cutoff = Math.max(SEM_MIN, Math.min(top * SEM_REL_MIN, nth));
    const pairs = [];
    for (const r of base) {
      const sim = sem.get(r.id);
      const exact = matchesQuery(recordHay(r), q);
      if ((sim !== undefined && sim >= cutoff) || exact) {
        pairs.push({ r, score: SEM_SCALE * ((sim || 0) / top) + (exact ? SEM_KEYWORD_BONUS : 0) });
      }
    }
    if (tier === "single" && pairs.length && pairs.length < SINGLE_TIER_CAP) {
      // Оплаченные 5 мест не должны пустовать: добиваем подборкой по разделу с нулевым скором
      // (идут после настоящих совпадений) и помечаем как промах.
      const have = new Set(pairs.map((p) => p.r.id));
      for (const r of base) if (!have.has(r.id)) pairs.push({ r, score: 0 });
      queryFallback = true;
    }
    if (pairs.length) {
      relevanceRanked = relevanceRerank(pairs, q);
      scoreById = new Map(pairs.map((p) => [p.r.id, p.score]));
      if (tier === "single" && top < SEM_WEAK && !pairs.some((p) => p.score > SEM_SCALE)) queryFallback = true;
    } else if (tier === "single") {
      // Как и в поиске по словам ниже: покупатель разового тарифа не остаётся с пустыми руками.
      candidates = base;
      queryFallback = true;
    } else {
      candidates = [];
    }
  } else if (q) {
    // Длинная фраза (например, подсказка, собранная ботом у покупателя разового тарифа)
    // почти никогда не совпадёт по всем словам буквально — сначала строгий AND-поиск.
    const strict = base.filter((r) => matchesQuery(recordHay(r), q));
    if (strict.length) {
      // Строгие совпадения тоже ранжируются по релевантности (редкие слова весят больше),
      // а не остаются в порядке строк Excel, как было раньше.
      const words = extractQueryWords(q);
      const hays = strict.map(recordHay);
      const scoreOf = makeRelevanceScorer(base.map(recordHay), words);
      const pairs = strict.map((r, i) => ({ r, score: scoreOf(hays[i]) }));
      relevanceRanked = relevanceRerank(pairs, q);
      scoreById = new Map(pairs.map((p) => [p.r.id, p.score]));
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
      // Донор без узкой ниши (SDG, "социально-экономические проекты", "дети и молодёжь" и
      // т.п.) по смыслу подходит под любую социальную тему, даже если ни одно слово запроса
      // не встречается буквально — иначе "сирота" почти ничего не найдёт, хотя половина базы
      // формально готова его принять. Добавляем таких доноров с невысоким базовым весом —
      // они дополняют реальные совпадения, но не перекрывают их.
      const scoredIds = new Set(scored.map((p) => p.r.id));
      const generalistExtra = base
        .filter((r) => r.is_generalist && !scoredIds.has(r.id))
        .map((r) => ({ r, score: GENERALIST_BASE_SCORE }));
      scored = scored.concat(generalistExtra);
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
    return { total, visibleTotal, tier, scope: null, page: 1, pageSize: PAGE_SIZE_FULL, hasMore: false, results };
  }

  if (tier === "single") {
    // Разовый токен — не весь раздел (несправедливо: одни разделы в разы больше других),
    // а до SINGLE_TIER_CAP лучших совпадений, отранжированных rankForSingleTier и
    // разбавленных diversifyTop — иначе топ-5 может оказаться "1 вариант 5 раз"
    // (например, несколько местных фондов одного типа), а не ассорти.
    const visibleTotal = Math.min(total, SINGLE_TIER_CAP);
    const results = diversifyTop(filtered, visibleTotal);
    if (results.length) await addSingleSeen(env, ip, results.map((r) => r.id));
    if (queryFallback && token) await notifyFallbackOnce(env, token, { sheet, q, buyer_chat_id, buyer_label });
    return { total, visibleTotal, tier, scope, expires_at, page: 1, pageSize: SINGLE_TIER_CAP, hasMore: false, results, queryFallback };
  }

  const start = (page - 1) * PAGE_SIZE_FULL;
  const end = Math.min(start + PAGE_SIZE_FULL, total);
  const results = start < total ? filtered.slice(start, end) : [];
  return { total, visibleTotal: total, tier, scope, plan, expires_at, page, pageSize: PAGE_SIZE_FULL, hasMore: end < total, results };
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

// fund4pro (отдельный бот-помощник по проектным предложениям) начисляет проекты покупателю
// тарифа 4500 по тому же коду доступа, что и для сайта. Общего секрета нет: сам код и есть
// секрет — его знает только покупатель, и сайтом по нему он и так пользуется. Один код —
// один чат fund4pro: повтор из того же чата идемпотентен (projects: 0, already: true), из
// другого — отказ, иначе пересланный код раздавал бы проекты всем подряд.
async function fund4proRedeem(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || "").trim().toUpperCase();
  const chatId = body.chat_id !== undefined && body.chat_id !== null ? String(body.chat_id) : "";
  if (!token || !chatId) return json({ ok: false, error: "missing_fields" }, 400);
  const rec = await env.TOKENS_KV.get(token, "json");
  if (!rec || !rec.token) return json({ ok: false, error: "invalid" }, 404);
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return json({ ok: false, error: "expired" }, 403);
  const projects = FUND4PRO_PROJECTS[rec.tier] || 0;
  if (!projects) return json({ ok: false, error: "plan", plan: rec.tier || "full" }, 403);
  if (rec.fund4pro_chat_id) {
    if (rec.fund4pro_chat_id === chatId) {
      return json({ ok: true, already: true, projects: 0, plan: rec.tier, expires_at: rec.expires_at || null });
    }
    return json({ ok: false, error: "used" }, 409);
  }
  rec.fund4pro_chat_id = chatId;
  rec.fund4pro_redeemed_at = new Date().toISOString();
  await env.TOKENS_KV.put(token, JSON.stringify(rec));
  return json({ ok: true, already: false, projects, plan: rec.tier, expires_at: rec.expires_at || null });
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

async function addManualRecord(request, env, ctx) {
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
  // Вектор для новой записи — сразу, чтобы она участвовала в семантическом поиске.
  if (env.AI && ctx) ctx.waitUntil(reindex(env).catch(() => {}));
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
