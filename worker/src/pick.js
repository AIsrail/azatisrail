/**
 * Разовый подбор (200 сом, только в Telegram): 5 лучших возможностей под описание покупателя.
 *
 * Эмбеддинги (semantic.js) хорошо находят "про что" запись, но плохо различают, кому она
 * реально доступна: на "инвестиции стартап КР" рядом оказываются кино-фонд и гонконгский
 * венчур. Поэтому в два шага:
 *   1. по смыслу берём ~30 кандидатов со всей базы (не из одного раздела: акселератор АП и
 *      Enactus лежат в других разделах, чем инвестфонды); закрытые по дедлайну — только запасом;
 *   2. LLM выбирает 5 по правилам владельца: сначала Кыргызстан, затем регион (ЦА/Азия/
 *      Евразия), международные — только если действительно подходят и приём не закрыт.
 * Итог: сначала открытый приём, затем постоянный, закрытые в конце; внутри — КР → регион → мир.
 * Если LLM недоступна или ответила мусором — те же кандидаты по близости и географии.
 */

import { semanticScores } from "./semantic.js";
import { recordDeadlineClass, DEADLINE_CLASS_RANK, normalizeRu, matchesQueryLoose } from "./extract.js";

const PICK_MODEL = "@cf/openai/gpt-oss-120b";
const LOCAL_CANDIDATES = 28; // КР + регион
const INTL_CANDIDATES = 12;
// Близость ниже этого у лучшей записи — по теме в базе по сути ничего нет (см. SEM_WEAK в index.js).
const WEAK_TOP = 0.2;
// Качество важнее скорости (решение владельца): ждём LLM до ~55 с. Не успела — подборка по
// близости и географии без LLM.
const LLM_TIMEOUT_MS = 55000;
const MIN_LIVE_CANDIDATES = 12;
const CRYPTO_QUERY_RE = /крипто|blockchain|блокчейн|биткоин|bitcoin|ethereum|web3|nft|defi/i;

export const REGION_LABEL = { kg: "Кыргызстан", regional: "Центральная Азия / регион", international: "международная" };
const REGION_RANK = { kg: 0, regional: 1 };
const regionRank = (r) => REGION_RANK[r.region] ?? 2;

function todayRu() {
  return new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bishkek" });
}

const SYSTEM_PROMPT = (today) => `Ты — эксперт-фандрайзер Connect4Pro в Кыргызстане. Сегодня ${today}.
Пользователь заплатил за подбор 5 самых подходящих возможностей финансирования из базы. Обычно это человек 25-35 лет с небольшим опытом, без опыта подачи заявок. Выбери ровно 5 записей из списка кандидатов.
Правила, по порядку важности:
1. Запись должна реально подходить запросу: тип поддержки, сфера и кто может подать. Тип поддержки должен совпадать с тем, что человек ищет: на запрос про учёбу или стипендию — только стипендии, стажировки и программы обучения (не акселераторы и не гранты на проекты); на запрос про кредит — кредиты, лизинг, льготное финансирование, гранты для бизнеса; на запрос про грант для НКО — гранты, а не инвестиции. Узкопрофильные программы не по теме (например, кино-фонд на запрос про стартапы) не выбирай. Для стартапов подходят и инвестфонды, и бизнес-ангелы, и акселераторы, и конкурсы стартапов.
   Предпочитай тех, кто реально даёт деньги или программу с финансированием. Госагентства и посредники, которые только "помогают найти инвесторов", справочные сайты и агрегаторы — только если настоящих источников не хватает.
   Программу, привязанную к конкретной области или городу Кыргызстана, выбирай только если запрос про эту же местность.
2. География: сначала Кыргызстан, затем регион (Центральная Азия, Азия, Евразия). Международные программы — если они подходят запросу, открыты для заявителей из КР и приём не закрыт (дедлайн впереди, регулярный или без дедлайна). Если такие есть, включи 1-2 из них в пятёрку вместо самых слабых местных: пользователь должен увидеть и реальные международные шансы.
   Программа не обязана быть посвящена именно теме запроса: широкие доноры, которые не запрещают такой профиль (например, гранты НКО на любые социальные проекты), подходят.
3. Сроки: в первую очередь выбирай записи со статусом «ОТКРЫТ» (дедлайн впереди), затем «ПОСТОЯННЫЙ» (регулярный приём или без дедлайна). Записи «ЗАКРЫТ» — только если иначе не набрать 5, и тогда в "why" прямо напиши, что приём закрыт и стоит следить за новым циклом.
4. Честность в "why" важнее убедительности. Пиши только то, что прямо следует из описания записи: не придумывай суммы, условия, сферы и сроки, не повторяй цифры из запроса пользователя как будто их обещает донор. Если связь с запросом косвенная — так и скажи («широкий фонд, стоит уточнить, берут ли такие проекты»). Про сроки — только то, что есть в поле «дедлайн»: если он не указан, не пиши «открытый приём», пиши «сроки уточняйте». Если приём ежегодный, а последняя дата прошла — «приём ежегодный, следующий цикл ожидается». Если по описанию программа только планируется — так и скажи.
5. Если по-настоящему подходящих меньше 5 — всё равно верни 5, слабые в конце.
6. Поле "tip": 1-2 коротких практических совета этому человеку по-русски — что сделать в первую очередь, чтобы реально получить деньги (например: большинству грантов нужна зарегистрированная организация; для кредита подготовьте бизнес-план; начните с программы N, у неё ближайший дедлайн). Без общих слов. Программы называй по названию, никогда не пиши служебные id.
Ответь ТОЛЬКО JSON без пояснений: {"picks":[{"id":"...","why":"одно короткое предложение по-русски: почему подходит именно под этот запрос"}],"tip":"..."}`;

const STATUS_LABEL = { open: "ОТКРЫТ", rolling: "ПОСТОЯННЫЙ", passed: "ЗАКРЫТ" };

function candidateLine(r) {
  const desc = (r.description || "").replace(/\s+/g, " ").slice(0, 400);
  return `id=${r.id} | ${r.name.replace(/\s+/g, " ").slice(0, 90)} | география: ${REGION_LABEL[r.region] || "?"} | приём: ${
    STATUS_LABEL[r._dl]
  } | дедлайн: ${
    (r.deadline || "не указан").replace(/\s+/g, " ").slice(0, 70)
  } | ${desc}`;
}

function parseAnswer(text) {
  if (!text) return null;
  let j = text;
  if (typeof text !== "object") {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      j = JSON.parse(text.slice(a, b + 1));
    } catch (e) {
      return null;
    }
  }
  return Array.isArray(j.picks) ? { picks: j.picks, tip: typeof j.tip === "string" ? j.tip.slice(0, 500) : "" } : null;
}

async function llmPick(env, q, candidates, count) {
  const res = await env.AI.run(PICK_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT(todayRu()) },
      { role: "user", content: `Запрос пользователя: ${q}\n\nКандидаты:\n${candidates.map(candidateLine).join("\n")}` },
    ],
    max_tokens: 4000,
    temperature: 0.2,
    // Владелец: покупатель платит за качество, ожидание до минуты допустимо — думаем тщательно.
    reasoning: { effort: "medium" },
  });
  // Разные модели Workers AI отвечают в разных форматах: {response} или OpenAI-подобный {choices}.
  const text =
    (res && res.response) ||
    (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ||
    null;
  const answer = parseAnswer(text);
  if (!answer) return null;
  const { picks, tip } = answer;
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
  return { picks: out, tip };
}

// exclude — id, уже показанные этому покупателю раньше: при повторной покупке он должен
// получить новое, но только если есть из чего выбирать (иначе лучше повторить лучшее).
export async function pickForBuyer(env, ctx, q, { exclude = new Set(), count = 5 } = {}) {
  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  const cryptoOk = CRYPTO_QUERY_RE.test(q);
  const now = Date.now();
  let pool = all.filter((r) => cryptoOk || !r.is_crypto).map((r) => ({ ...r, _dl: recordDeadlineClass(r.deadline, now) }));
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

  // Закрытые по сроку — только запасом, если живых кандидатов мало.
  const live = ranked.filter((r) => r._dl !== "passed");
  const local = live.filter((r) => regionRank(r) < 2).slice(0, LOCAL_CANDIDATES);
  const intl = live.filter((r) => regionRank(r) === 2).slice(0, INTL_CANDIDATES);
  const reserve = local.length + intl.length < MIN_LIVE_CANDIDATES ? ranked.filter((r) => r._dl === "passed").slice(0, 8) : [];
  const candidates = [...local, ...intl, ...reserve];

  let picks = null;
  let tip = "";
  if (env.AI && candidates.length > count) {
    try {
      const answer = await Promise.race([
        llmPick(env, q, candidates, count),
        new Promise((resolve) => setTimeout(() => resolve(null), LLM_TIMEOUT_MS)),
      ]);
      if (answer) ({ picks, tip } = answer);
    } catch (e) {
      picks = null;
    }
  }
  if (!picks || picks.length < count) {
    // Добор (или весь выбор, если LLM не ответила): по близости, местные вперёд.
    const have = new Set((picks || []).map((p) => p.r.id));
    const rest = candidates.filter((r) => !have.has(r.id)).map((r) => ({ r, why: "" }));
    picks = [...(picks || []), ...rest].slice(0, count);
  }
  // Сначала открытый приём, затем постоянный, закрытые в конце; внутри — КР → регион → мир,
  // а при равенстве — порядок LLM (sort стабильный).
  picks.sort(
    (a, b) => DEADLINE_CLASS_RANK[a.r._dl] - DEADLINE_CLASS_RANK[b.r._dl] || regionRank(a.r) - regionRank(b.r)
  );
  return { picks, weak, tip };
}
