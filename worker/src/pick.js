/**
 * Разовый подбор (200 сом, только в Telegram): 5 лучших возможностей под описание покупателя.
 *
 * Эмбеддинги (semantic.js) хорошо находят "про что" запись, но плохо различают, кому она
 * реально доступна: на "инвестиции стартап КР" рядом оказываются кино-фонд и гонконгский
 * венчур. Поэтому в два шага:
 *   1. по смыслу берём ~40 кандидатов со всей базы (не из одного раздела: акселератор АП и
 *      Enactus лежат в других разделах, чем инвестфонды), закрытые по дедлайну — выкидываем;
 *   2. LLM выбирает 5 по правилам владельца: сначала Кыргызстан, затем регион (ЦА/Азия/
 *      Евразия), международные — только если действительно подходят и приём не закрыт.
 * Итог сортируется по географии (КР → регион → мир), внутри — в порядке, выбранном LLM.
 * Если LLM недоступна или ответила мусором — те же кандидаты по близости и географии.
 */

import { semanticScores } from "./semantic.js";
import { isRecordDeadlinePassed, normalizeRu, matchesQueryLoose } from "./extract.js";

const PICK_MODEL = "@cf/openai/gpt-oss-120b";
const LOCAL_CANDIDATES = 28; // КР + регион
const INTL_CANDIDATES = 12;
// Близость ниже этого у лучшей записи — по теме в базе по сути ничего нет (см. SEM_WEAK в index.js).
const WEAK_TOP = 0.2;
// Фоновой работе после ответа вебхуку дают ~30 с (waitUntil); gpt-oss-120b отвечает за 10-20 с.
// Не успела — подборка по близости и географии без отбора LLM.
const LLM_TIMEOUT_MS = 22000;
const CRYPTO_QUERY_RE = /крипто|blockchain|блокчейн|биткоин|bitcoin|ethereum|web3|nft|defi/i;

export const REGION_LABEL = { kg: "Кыргызстан", regional: "Центральная Азия / регион", international: "международная" };
const REGION_RANK = { kg: 0, regional: 1 };
const regionRank = (r) => REGION_RANK[r.region] ?? 2;

function todayRu() {
  return new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bishkek" });
}

const SYSTEM_PROMPT = (today) => `Ты — эксперт-фандрайзер Connect4Pro в Кыргызстане. Сегодня ${today}.
Пользователь заплатил за подбор 5 самых подходящих возможностей финансирования из базы. Выбери ровно 5 записей из списка кандидатов.
Правила, по порядку важности:
1. Запись должна реально подходить запросу: тип поддержки (грант, инвестиции, кредит, акселератор), сфера и кто может подать. Узкопрофильные программы не по теме (например, кино-фонд на запрос про стартапы) не выбирай. Для стартапов подходят и инвестфонды, и бизнес-ангелы, и акселераторы, и конкурсы стартапов.
   Предпочитай тех, кто реально даёт деньги или программу с финансированием. Госагентства и посредники, которые только "помогают найти инвесторов", справочные сайты и агрегаторы — только если настоящих источников не хватает.
   Программу, привязанную к конкретной области или городу Кыргызстана, выбирай только если запрос про эту же местность.
2. География: сначала Кыргызстан, затем регион (Центральная Азия, Азия, Евразия). Международные программы выбирай, только если они явно подходят запросу, открыты для заявителей из КР и приём не закрыт (дедлайн впереди, регулярный или без дедлайна).
3. Не выбирай записи с прошедшим дедлайном без признаков регулярного приёма.
4. Если по-настоящему подходящих меньше 5 — всё равно верни 5, слабые в конце.
Ответь ТОЛЬКО JSON без пояснений: {"picks":[{"id":"...","why":"одно короткое предложение по-русски: почему подходит именно под этот запрос"}]}`;

function candidateLine(r) {
  const desc = (r.description || "").replace(/\s+/g, " ").slice(0, 220);
  return `id=${r.id} | ${r.name.replace(/\s+/g, " ").slice(0, 90)} | география: ${REGION_LABEL[r.region] || "?"} | дедлайн: ${
    (r.deadline || "не указан").replace(/\s+/g, " ").slice(0, 70)
  } | ${desc}`;
}

function parsePicks(text) {
  if (!text) return null;
  if (typeof text === "object") return Array.isArray(text.picks) ? text.picks : null;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(j.picks) ? j.picks : null;
  } catch (e) {
    return null;
  }
}

async function llmPick(env, q, candidates, count) {
  const res = await env.AI.run(PICK_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT(todayRu()) },
      { role: "user", content: `Запрос пользователя: ${q}\n\nКандидаты:\n${candidates.map(candidateLine).join("\n")}` },
    ],
    max_tokens: 4000,
    temperature: 0.2,
  });
  // Разные модели Workers AI отвечают в разных форматах: {response} или OpenAI-подобный {choices}.
  const text =
    (res && res.response) ||
    (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ||
    null;
  const picks = parsePicks(text);
  if (!picks) return null;
  const byId = new Map(candidates.map((r) => [r.id, r]));
  const seen = new Set();
  const out = [];
  for (const p of picks) {
    const r = byId.get(String(p && p.id));
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ r, why: typeof p.why === "string" ? p.why.slice(0, 300) : "" });
    if (out.length >= count) break;
  }
  return out;
}

// exclude — id, уже показанные этому покупателю раньше: при повторной покупке он должен
// получить новое, но только если есть из чего выбирать (иначе лучше повторить лучшее).
export async function pickForBuyer(env, ctx, q, { exclude = new Set(), count = 5 } = {}) {
  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  const cryptoOk = CRYPTO_QUERY_RE.test(q);
  let pool = all.filter((r) => !isRecordDeadlinePassed(r.deadline) && (cryptoOk || !r.is_crypto));
  const fresh = pool.filter((r) => !exclude.has(r.id));
  if (fresh.length >= count * 4) pool = fresh;

  const sem = env.AI ? await semanticScores(env, ctx, pool, q, all.length) : null;
  let ranked;
  let weak = false;
  if (sem) {
    ranked = pool.filter((r) => sem.has(r.id)).sort((a, b) => sem.get(b.id) - sem.get(a.id));
    weak = !ranked.length || sem.get(ranked[0].id) < WEAK_TOP;
  } else {
    // Семантика недоступна — хотя бы записи, где встречается любое слово запроса.
    const hay = (r) => normalizeRu([r.name, r.description, (r.tags || []).join(" ")].join(" "));
    ranked = pool.filter((r) => matchesQueryLoose(hay(r), q));
    weak = ranked.length < count;
  }

  const local = ranked.filter((r) => regionRank(r) < 2).slice(0, LOCAL_CANDIDATES);
  const intl = ranked.filter((r) => regionRank(r) === 2).slice(0, INTL_CANDIDATES);
  const candidates = [...local, ...intl];

  let picks = null;
  if (env.AI && candidates.length > count) {
    try {
      picks = await Promise.race([
        llmPick(env, q, candidates, count),
        new Promise((resolve) => setTimeout(() => resolve(null), LLM_TIMEOUT_MS)),
      ]);
    } catch (e) {
      picks = null;
    }
  }
  if (!picks || picks.length < count) {
    // Добор (или весь выбор, если LLM не ответила): по близости, местные вперёд.
    const have = new Set((picks || []).map((p) => p.r.id));
    const rest = [...local, ...intl].filter((r) => !have.has(r.id)).map((r) => ({ r, why: "" }));
    picks = [...(picks || []), ...rest].slice(0, count);
  }
  // КР → регион → мир; внутри группы — порядок LLM (sort стабильный).
  picks.sort((a, b) => regionRank(a.r) - regionRank(b.r));
  return { picks, weak };
}
