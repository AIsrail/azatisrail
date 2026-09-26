/**
 * Акция «Тестировщик Fundan» и обратная связь по разовому подбору (2026-09-26).
 *
 * Акция: разовый подбор за PROMO.price вместо 200 сом в окне PROMO.start…PROMO.end — в обмен на
 * ответы кнопками. Цена сама возвращается к обычной после PROMO.end.
 *
 * Обратная связь — в 3 захода, каждый не больше 2–3 нажатий:
 *   1) сразу после подборки: какие из 5 подошли (мультивыбор) → если < 2, «что не так?»;
 *      за ответ — бонус 2 варианта (один раз на подборку);
 *   2) через 2 дня: что сделали дальше, чего не хватило;
 *   3) через 5 дней: посоветуете ли знакомым → звёзды → отзыв с разрешением на публикацию.
 * Всё хранится в TOKENS_KV под ключом pick:<id> (30 дней): какие записи показали и что про них
 * сказали — по этим данным Claude разбирает, какие записи база подбирает мимо.
 * Отложенные заходы — ключи fu:<время>:<id>:<этап>, их раз в 30 минут забирает cron (см. runFeedbackCron).
 */

import { tg, getAdminChat, formatSingleResult } from "./telegram.js";
import { pickForBuyer } from "./pick.js";

export const PROMO = {
  price: 90,
  start: "2026-09-27T04:00:00Z", // 27.09 10:00 по Бишкеку
  end: "2026-09-30T04:00:00Z", // 30.09 10:00 по Бишкеку
  label: "акция для тестировщиков",
};
export const SINGLE_PRICE = 200;

export function promoActive(now = Date.now()) {
  return now >= Date.parse(PROMO.start) && now < Date.parse(PROMO.end);
}

export function singleAmount(now = Date.now()) {
  return promoActive(now) ? PROMO.price : SINGLE_PRICE;
}

export function promoInfo(now = Date.now()) {
  return { active: promoActive(now), price: PROMO.price, regular: SINGLE_PRICE, start: PROMO.start, end: PROMO.end };
}

function untilRu(iso) {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bishkek" });
}

export function promoLine() {
  return promoActive() ? `🔥 Акция для тестировщиков: ${PROMO.price} сом вместо ${SINGLE_PRICE} — до ${untilRu(PROMO.end)}. Взамен — пара ответов кнопками после подборки.` : "";
}

const PICK_TTL = 30 * 86400;
const DAY = 86400000;
const pickKey = (id) => `pick:${id}`;

async function getPick(env, id) {
  return env.TOKENS_KV.get(pickKey(id), "json");
}
async function savePick(env, rec) {
  await env.TOKENS_KV.put(pickKey(rec.id), JSON.stringify(rec), { expirationTtl: PICK_TTL });
}

function selectKeyboard(rec) {
  const sel = new Set(rec.sel || []);
  const nums = rec.ids.map((_, i) => ({ text: `${sel.has(i + 1) ? "✅ " : ""}${i + 1}`, callback_data: `fbt:${rec.id}:${i + 1}` }));
  return {
    inline_keyboard: [nums, [{ text: "Готово", callback_data: `fbd:${rec.id}` }, { text: "Ни один не подошёл", callback_data: `fbn:${rec.id}` }]],
  };
}

const REASONS = [
  ["sphere", "Не та сфера"],
  ["geo", "Не та страна/регион"],
  ["closed", "Приём закрыт"],
  ["notme", "Не для таких, как я"],
  ["unclear", "Непонятно описано"],
  ["other", "Другое — напишу"],
];
const NEXT_STEPS = [
  ["opened", "Открыл(а) сайты программ"],
  ["preparing", "Готовлю заявку"],
  ["applied", "Подал(а) заявку"],
  ["nothing", "Пока ничего"],
];
const MISSING = [
  ["more", "Больше вариантов"],
  ["help", "Помощь с заявкой"],
  ["dates", "Сроки и суммы"],
  ["contacts", "Контакты"],
  ["ok", "Всего хватило"],
];
const RECOMMEND = [
  ["yes", "Да"],
  ["maybe", "Возможно"],
  ["no", "Нет"],
];

function rows(prefix, id, items, perRow = 2) {
  const out = [];
  for (let i = 0; i < items.length; i += perRow) {
    out.push(items.slice(i, i + perRow).map(([code, text]) => ({ text, callback_data: `${prefix}:${id}:${code}` })));
  }
  return out;
}

// Заход 1: сразу после подборки (вызывается из deliverSinglePicks).
export async function startFeedback(env, { chatId, buyerLabel, picks, q, amount }) {
  if (!picks.length) return;
  const id = Math.random().toString(36).slice(2, 10);
  const rec = {
    id,
    chat: chatId,
    buyer: buyerLabel || null,
    q: (q || "").slice(0, 1000),
    ids: picks.map((p) => p.r.id),
    names: picks.map((p) => p.r.name.slice(0, 80)),
    amount: amount || null,
    promo: promoActive(),
    at: new Date().toISOString(),
    sel: [],
  };
  await savePick(env, rec);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Помогите сделать подбор точнее — это 2 нажатия 🙏\n\nКакие из 5 вариантов вам подходят? Отметьте номера и нажмите «Готово».",
    reply_markup: selectKeyboard(rec),
  });
  // Акция длится 3 дня — заходы сжаты: «что дальше» через сутки, оценка и отзыв через двое.
  const t = Date.now();
  await env.TOKENS_KV.put(`fu:${t + DAY}:${id}:2`, "1", { expirationTtl: 10 * 86400 });
  await env.TOKENS_KV.put(`fu:${t + 2 * DAY}:${id}:3`, "1", { expirationTtl: 10 * 86400 });
}

// Бонус за отзыв (решение владельца): оценка звёздами — 2 варианта, текстовый отзыв — 3.
// Один раз на подборку.
const BONUS_STARS = 2;
const BONUS_TEXT = 3;

async function sendBonus(env, rec, count) {
  if (rec.bonusGiven) return;
  rec.bonusGiven = true;
  await savePick(env, rec);
  const seenKey = `single_seen:tg:${rec.chat}`;
  const seen = new Set((await env.TOKENS_KV.get(seenKey, "json")) || []);
  rec.ids.forEach((x) => seen.add(x));
  // Берём с запасом и отбрасываем уже показанные: при небольшом числе подходящих pickForBuyer
  // может вернуть и виденные ранее, а бонус должен быть новым.
  const res = await pickForBuyer(env, null, rec.q, { exclude: seen, count: count + 5 });
  const picks = res.picks.filter((p) => !seen.has(p.r.id)).slice(0, count);
  if (!picks.length) {
    await tg(env, "sendMessage", { chat_id: rec.chat, text: "Спасибо за отзыв! 🙏 Новых подходящих вариантов пока нет — база пополняется, загляните позже." });
    return;
  }
  await tg(env, "sendMessage", {
    chat_id: rec.chat,
    text: `Спасибо за отзыв! 🎁 Ещё ${picks.length} ${picks.length === 2 ? "варианта" : "варианта"}:\n\n` + picks.map((p, i) => formatSingleResult(p, 5 + i)).join("\n\n"),
    disable_web_page_preview: true,
  });
  const next = Array.from(new Set([...seen, ...picks.map((p) => p.r.id)])).slice(-200);
  await env.TOKENS_KV.put(seenKey, JSON.stringify(next), { expirationTtl: 7776000 });
  rec.bonusIds = picks.map((p) => p.r.id);
  await savePick(env, rec);
}

async function finishStage1(env, rec, cb) {
  if (cb) {
    await tg(env, "editMessageReplyMarkup", { chat_id: rec.chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if ((rec.sel || []).length < 2 && !rec.reason) {
    await tg(env, "sendMessage", {
      chat_id: rec.chat,
      text: "Что было не так с вариантами? Выберите главное:",
      reply_markup: { inline_keyboard: rows("fbr", rec.id, REASONS) },
    });
    return;
  }
  await tg(env, "sendMessage", { chat_id: rec.chat, text: "Спасибо! Это помогает делать подбор точнее 🙏" });
}

export function isFeedbackCallback(data) {
  return /^(fbt|fbd|fbn|fbr|fb2a|fb2b|fb3|fbst|fbskip|fbpub):/.test(data);
}

let clearPendingFn = async () => {};

async function askStars(env, rec) {
  await tg(env, "sendMessage", {
    chat_id: rec.chat,
    text: "Оцените Fundan — за оценку пришлю ещё 2 варианта, за отзыв текстом — 3 🎁",
    reply_markup: { inline_keyboard: [1, 2, 3, 4, 5].map((n) => [{ text: "⭐".repeat(n), callback_data: `fbst:${rec.id}:${n}` }]) },
  });
}

export async function handleFeedbackCallback(env, cb, setPending, clearPending) {
  if (clearPending) clearPendingFn = clearPending;
  const [kind, id, val] = (cb.data || "").split(":");
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  const rec = await getPick(env, id);
  if (!rec || String(rec.chat) !== String(cb.message.chat.id)) return;
  const drop = () => tg(env, "editMessageReplyMarkup", { chat_id: rec.chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });

  if (kind === "fbt") {
    if (rec.stage1At) return;
    const n = parseInt(val, 10);
    const sel = new Set(rec.sel || []);
    sel.has(n) ? sel.delete(n) : sel.add(n);
    rec.sel = [...sel].sort();
    await savePick(env, rec);
    await tg(env, "editMessageReplyMarkup", { chat_id: rec.chat, message_id: cb.message.message_id, reply_markup: selectKeyboard(rec) });
  } else if (kind === "fbd" || kind === "fbn") {
    if (rec.stage1At) return;
    if (kind === "fbn") rec.sel = [];
    rec.stage1At = new Date().toISOString();
    await savePick(env, rec);
    await finishStage1(env, rec, cb);
  } else if (kind === "fbr") {
    if (rec.reason) return;
    rec.reason = val;
    await savePick(env, rec);
    await drop();
    if (val === "other") {
      await setPending(env, rec.chat, { step: "fb_text", pickId: rec.id, field: "reasonText" });
      await tg(env, "sendMessage", { chat_id: rec.chat, text: "Напишите одним сообщением, что было не так — это очень поможет." });
      return;
    }
    await tg(env, "sendMessage", { chat_id: rec.chat, text: "Спасибо! Учтём — это помогает делать подбор точнее 🙏" });
  } else if (kind === "fb2a") {
    rec.next = val;
    await savePick(env, rec);
    await drop();
    await tg(env, "sendMessage", {
      chat_id: rec.chat,
      text: "Чего вам не хватило?",
      reply_markup: { inline_keyboard: rows("fb2b", rec.id, MISSING) },
    });
  } else if (kind === "fb2b") {
    rec.missing = val;
    await savePick(env, rec);
    await drop();
    await tg(env, "sendMessage", { chat_id: rec.chat, text: "Спасибо! Учтём 🙏" });
  } else if (kind === "fb3") {
    rec.recommend = val;
    await savePick(env, rec);
    await drop();
    await askStars(env, rec);
  } else if (kind === "fbst") {
    if (rec.stars) return;
    rec.stars = parseInt(val, 10);
    await savePick(env, rec);
    await drop();
    await setPending(env, rec.chat, { step: "fb_text", pickId: rec.id, field: "review" });
    await tg(env, "sendMessage", {
      chat_id: rec.chat,
      text:
        (rec.stars >= 4
          ? "Спасибо! 🙌 Напишите пару слов о Fundan и как вас подписать (имя и фамилия, при желании — организация) — пришлю ещё 3 варианта."
          : "Спасибо за честность! Напишите, что улучшить, чтобы вы поставили 5, и как вас зовут — пришлю ещё 3 варианта.") +
        "\n\nИли нажмите «Пропустить» — пришлю 2 варианта за оценку.",
      reply_markup: { inline_keyboard: [[{ text: "Пропустить", callback_data: `fbskip:${rec.id}` }]] },
    });
  } else if (kind === "fbskip") {
    if (rec.bonusGiven) return;
    await drop();
    await clearPendingFn(env, rec.chat);
    await sendBonus(env, rec, BONUS_STARS);
  } else if (kind === "fbpub") {
    rec.publish = val === "yes";
    await savePick(env, rec);
    await drop();
    await tg(env, "sendMessage", { chat_id: rec.chat, text: rec.publish ? "Спасибо! Отзыв появится на сайте после проверки 🙏" : "Хорошо, не публикуем. Спасибо за отзыв!" });
    if (rec.publish) {
      const admin = await getAdminChat(env);
      if (admin) {
        await tg(env, "sendMessage", { chat_id: admin.chat_id, text: `⭐ Новый отзыв (${rec.stars}★) от ${rec.buyer || "покупателя"}, разрешил публикацию:\n\n${rec.review}` });
      }
    }
  }
}

// Текстовые ответы (причина «другое», отзыв, что улучшить).
export async function handleFeedbackText(env, message, pending, clearPending) {
  const rec = await getPick(env, pending.pickId);
  await clearPending(env, message.chat.id);
  if (!rec) return;
  rec[pending.field] = (message.text || "").slice(0, 2000);
  await savePick(env, rec);
  if (pending.field === "reasonText") {
    await tg(env, "sendMessage", { chat_id: rec.chat, text: "Спасибо! Учтём — это помогает делать подбор точнее 🙏" });
  } else if (pending.field === "review") {
    await sendBonus(env, rec, BONUS_TEXT);
    if (rec.stars >= 4) {
      await tg(env, "sendMessage", {
        chat_id: rec.chat,
        text: "Можно опубликовать ваш отзыв на сайте fundan.cc?",
        reply_markup: { inline_keyboard: [[{ text: "Да, публикуйте", callback_data: `fbpub:${rec.id}:yes` }, { text: "Нет", callback_data: `fbpub:${rec.id}:no` }]] },
      });
    } else {
      const admin = await getAdminChat(env);
      if (admin) await tg(env, "sendMessage", { chat_id: admin.chat_id, text: `📝 Отзыв ${rec.stars}★ от ${rec.buyer || "покупателя"} (не для публикации):

${rec.review}` });
    }
  } else {
    await tg(env, "sendMessage", { chat_id: rec.chat, text: "Спасибо, передали команде 🙏" });
  }
}

async function sendStage(env, rec, stage) {
  if (stage === 2 && !rec.next) {
    await tg(env, "sendMessage", {
      chat_id: rec.chat,
      text: "Вчера мы подобрали вам варианты финансирования. Что вы сделали дальше?",
      reply_markup: { inline_keyboard: rows("fb2a", rec.id, NEXT_STEPS) },
    });
  } else if (stage === 3 && !rec.recommend) {
    await tg(env, "sendMessage", {
      chat_id: rec.chat,
      text: "Последний вопрос: посоветуете Fundan знакомым, которые ищут гранты или инвестиции?",
      reply_markup: { inline_keyboard: rows("fb3", rec.id, RECOMMEND, 3) },
    });
  }
}

// Cron раз в 30 минут: отложенные заходы + ежедневная сводка владельцу в 21:00 по Бишкеку.
export async function runFeedbackCron(env, scheduledTime) {
  const now = scheduledTime || Date.now();
  let cursor;
  do {
    const list = await env.TOKENS_KV.list({ prefix: "fu:", cursor });
    for (const k of list.keys) {
      const [, due, id, stage] = k.name.split(":");
      if (Number(due) > now) continue;
      await env.TOKENS_KV.delete(k.name);
      const rec = await getPick(env, id);
      if (rec) await sendStage(env, rec, Number(stage)).catch(() => {});
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  const d = new Date(now);
  if (d.getUTCHours() === 15 && d.getUTCMinutes() < 30) await sendDigest(env, now);
}

export async function feedbackSummary(env, sinceMs) {
  const recs = [];
  let cursor;
  do {
    const list = await env.TOKENS_KV.list({ prefix: "pick:", cursor });
    for (const k of list.keys) {
      const r = await env.TOKENS_KV.get(k.name, "json");
      if (r && Date.parse(r.at) >= sinceMs) recs.push(r);
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  const answered = recs.filter((r) => r.stage1At);
  const fits = answered.map((r) => (r.sel || []).length);
  const reasons = {};
  answered.forEach((r) => r.reason && (reasons[r.reason] = (reasons[r.reason] || 0) + 1));
  const stars = recs.filter((r) => r.stars).map((r) => r.stars);
  return {
    picks: recs.length,
    answered: answered.length,
    avgFit: fits.length ? (fits.reduce((a, b) => a + b, 0) / fits.length).toFixed(1) : "—",
    reasons,
    avgStars: stars.length ? (stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(1) : "—",
    reviews: recs.filter((r) => r.review).length,
  };
}

async function sendDigest(env, now) {
  const admin = await getAdminChat(env);
  if (!admin) return;
  const s = await feedbackSummary(env, now - DAY);
  if (!s.picks) return;
  const label = Object.fromEntries(REASONS);
  const reasons = Object.entries(s.reasons).map(([k, v]) => `${label[k] || k}: ${v}`).join(", ") || "—";
  await tg(env, "sendMessage", {
    chat_id: admin.chat_id,
    text:
      `📊 Сводка за сутки (разовый подбор)\n` +
      `Подборок: ${s.picks}, ответили: ${s.answered}\n` +
      `Подошло в среднем: ${s.avgFit} из 5\n` +
      `Причины «не то»: ${reasons}\n` +
      `Средняя оценка: ${s.avgStars}★, отзывов: ${s.reviews}`,
  });
}
