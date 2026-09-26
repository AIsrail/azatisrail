/**
 * Календарь фандрайзинга — «что подавать когда» (тариф «Расширенный», 4500 сом).
 *
 * Три вида отметок (решение владельца 2026-09-26):
 *   deadline — реальная дата приёма из поля deadline ("до 15.10.2026", окна NED и т.п.);
 *   expected — ежегодная программа, текущий цикл прошёл: ставим в тот же месяц следующего
 *              года как «ожидается» (не как дедлайн — точная дата неизвестна);
 *   plan     — постоянно открытые инвесторы и доноры без дедлайна: не фальшивый срок, а
 *              «план обращений» — по несколько в месяц, чтобы не писать всем в один день.
 * Персонально: если покупатель описал себя (profile), в календарь идут только близкие по
 * смыслу записи (эмбеддинги, semantic.js). Без профиля — все конкурсы с датами, без плана.
 * Окно: текущий месяц … декабрь этого года + 6 месяцев; если до конца окна остаётся меньше
 * 4 месяцев — продлеваем ещё на 6. Прошедшие месяцы не показываем.
 * Считается на лету — это разбор дат по ~500 записям, кэш не нужен.
 */

import { semanticScores } from "./semantic.js";
import { deadlineDates, recordDeadlineClass } from "./extract.js";

const MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const REGION_RANK = { kg: 0, regional: 1 };
const PLAN_PER_MONTH = 3;
const PROFILE_MAX_RECORDS = 80;
const PROFILE_REL_MIN = 0.75;
const ANNUAL_RE = /ежегодн|раз в год|annual|каждый год/i;
// Дата, перед которой стоит "до"/"дедлайн" — это срок подачи; прочие даты в тексте могут быть
// датами заседаний, объявления итогов и т.п.
const DUE_BEFORE_RE = /(до|дедлайн|deadline|срок)\s*:?\s*$/i;

function monthKey(y, m) {
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function calendarWindow(now = new Date()) {
  const startY = now.getUTCFullYear();
  const startM = now.getUTCMonth();
  let endY = startY + 1;
  let endM = 5; // декабрь этого года + 6 месяцев = июнь следующего
  const monthsLeft = () => (endY - startY) * 12 + (endM - startM);
  while (monthsLeft() < 4) {
    endM += 6;
    if (endM > 11) {
      endM -= 12;
      endY += 1;
    }
  }
  const months = [];
  for (let i = 0; i <= monthsLeft(); i++) {
    const y = startY + Math.floor((startM + i) / 12);
    const m = (startM + i) % 12;
    months.push({ key: monthKey(y, m), label: `${MONTH_NAMES[m]} ${y}`, items: [] });
  }
  return months;
}

// Будущие сроки подачи из текста дедлайна: даты с "до ..." перед ними, а если таких нет —
// последняя будущая дата (для диапазонов "28.09.2026 – 26.10.2026" это конец приёма).
function dueDates(text, now) {
  const t = text || "";
  const all = deadlineDates(t).filter((d) => d >= now);
  if (!all.length) return [];
  const due = [];
  const re = /(\d{1,2})\.(\d{1,2})\.(\d{4})/g;
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    const d = Date.UTC(+m[3], +m[2] - 1, +m[1], 23, 59, 59);
    if (d >= now && DUE_BEFORE_RE.test(before)) due.push(d);
  }
  return due.length ? Array.from(new Set(due)).sort((a, b) => a - b) : [Math.max(...all)];
}

function item(r, kind, date) {
  return {
    id: r.id,
    kind,
    date: date ? new Date(date).toISOString().slice(0, 10) : null,
    name: r.name,
    region: r.region,
    sheet: r.sheet,
    amount: r.amount || null,
    deadline: r.deadline || null,
    url: r.url || (r.urls && r.urls[0]) || null,
  };
}

// Кто покупатель — по словам профиля. Эмбеддинги путают "молодёжный ОФ" с "молодёжным
// стартапом", а поле categories в базе это различает (ngo / business / individual).
const PROFILE_CATEGORY = [
  ["ngo", /\bнко\b|\bнпо\b|\bоф\b|обществен\w* (фонд|объединен|организац)|некоммерч|ngo|\bкоо\b/i],
  ["business", /бизнес|\bип\b|\bоосо\b|\bосо\b|компани|стартап|предприним|фермер|цех|производств|магазин/i],
  ["individual", /стипенд|магистрат|учёб|учеб|стажировк|аспирант|phd|студент/i],
];

function profileCategories(profile) {
  return PROFILE_CATEGORY.filter(([, re]) => re.test(profile)).map(([c]) => c);
}

export async function buildCalendar(env, ctx, profile) {
  const now = Date.now();
  const all = (await env.FUNDING_KV.get("records", "json")) || [];
  let pool = all.filter((r) => !r.is_crypto);
  const cats = profile ? profileCategories(profile) : [];
  if (cats.length) {
    // Записи без категорий не отбрасываем — лучше показать лишнее, чем потерять донора.
    pool = pool.filter((r) => !Array.isArray(r.categories) || !r.categories.length || r.categories.some((c) => cats.includes(c)));
  }
  let personal = false;
  if (profile) {
    const sem = await semanticScores(env, ctx, pool, profile, all.length);
    if (sem && sem.size) {
      const top = Math.max(...sem.values());
      pool = pool
        .filter((r) => sem.has(r.id) && sem.get(r.id) >= top * PROFILE_REL_MIN)
        .sort((a, b) => sem.get(b.id) - sem.get(a.id))
        .slice(0, PROFILE_MAX_RECORDS);
      personal = true;
    }
  }

  const months = calendarWindow(new Date(now));
  const byKey = new Map(months.map((m) => [m.key, m]));
  const placeAt = (ts, it) => {
    const d = new Date(ts);
    const m = byKey.get(monthKey(d.getUTCFullYear(), d.getUTCMonth()));
    if (m) m.items.push(it);
    return !!m;
  };

  const planQueue = [];
  for (const r of pool) {
    const text = r.deadline || "";
    const due = dueDates(text, now);
    if (due.length) {
      for (const d of due) placeAt(d, item(r, "deadline", d));
      continue;
    }
    const past = deadlineDates(text).filter((d) => d < now);
    if (past.length && ANNUAL_RE.test(text)) {
      // Ежегодный цикл прошёл — следующий ожидается примерно через год от последней даты.
      const last = new Date(Math.max(...past));
      const next = Date.UTC(last.getUTCFullYear() + 1, last.getUTCMonth(), last.getUTCDate());
      if (next >= now) placeAt(next, item(r, "expected", next));
      continue;
    }
    if (recordDeadlineClass(text, now) === "rolling" && !past.length) planQueue.push(r);
  }

  // План обращений — только в персональном календаре (без профиля это были бы все 300+
  // постоянных программ). Местные вперёд, внутри — по близости к профилю (порядок pool).
  let anytime = [];
  if (personal) {
    planQueue.sort((a, b) => (REGION_RANK[a.region] ?? 2) - (REGION_RANK[b.region] ?? 2));
    let i = 0;
    for (const m of months) {
      for (let k = 0; k < PLAN_PER_MONTH && i < planQueue.length; k++, i++) m.items.push(item(planQueue[i], "plan", null));
    }
    anytime = planQueue.slice(i).map((r) => item(r, "plan", null));
  }

  const kindRank = { deadline: 0, expected: 1, plan: 2 };
  for (const m of months) {
    m.items.sort(
      (a, b) =>
        kindRank[a.kind] - kindRank[b.kind] ||
        (a.date || "").localeCompare(b.date || "") ||
        (REGION_RANK[a.region] ?? 2) - (REGION_RANK[b.region] ?? 2)
    );
  }
  return { personal, months, anytime };
}
