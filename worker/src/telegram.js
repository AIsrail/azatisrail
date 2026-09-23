/**
 * @c4faq_bot — приём оплаты за доступ к базе доноров.
 * Флоу: /start -> выбор тарифа -> (для разового: выбор раздела) -> реквизиты ->
 *       покупатель шлёт фото чека -> бот форвардит его владельцу с кнопками ✅/❌ ->
 *       владелец подтверждает -> бот сам выдаёт код доступа и присылает покупателю.
 *
 * Состояние живёт в TOKENS_KV (тот же namespace, что и коды доступа):
 *  - _admin_chat            — { chat_id } куда слать уведомления о новых чеках
 *  - pending:<chat_id>      — текущий шаг покупателя (тариф/раздел), TTL 1 час
 *  - payreq:<request_id>    — заявка на подтверждение, ждёт решения владельца, TTL 24 часа
 */

import { issueTokenRecord } from "./index.js";

const PAY_REQUISITES = "О!Деньги или Мбанк: 0996 702 271827";

const TARIFFS = [
  { id: "basic", label: "Базовая", price: "1900 сом" },
  { id: "standard", label: "Стандартная", price: "4900 сом" },
  { id: "premium", label: "Полноценная", price: "8900 сом" },
  { id: "single", label: "Разовый доступ (1 раздел)", price: "200 сом" },
];

const SHEETS = [
  "Доноры",
  "Инвесторы межд",
  "Инвесторы КР",
  "Финансы МСБ КР",
  "Акселераторы и др.",
  "Социальные доноры",
  "Стажировки и стипендии",
];

function tgApi(env) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
}

async function tg(env, method, params) {
  const res = await fetch(`${tgApi(env)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

function genId(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getAdminChat(env) {
  return env.TOKENS_KV.get("_admin_chat", "json");
}

async function isAdmin(env, userId) {
  const rec = await getAdminChat(env);
  return !!rec && String(rec.chat_id) === String(userId);
}

async function setPending(env, chatId, data) {
  await env.TOKENS_KV.put(`pending:${chatId}`, JSON.stringify(data), { expirationTtl: 3600 });
}

async function getPending(env, chatId) {
  return env.TOKENS_KV.get(`pending:${chatId}`, "json");
}

async function clearPending(env, chatId) {
  await env.TOKENS_KV.delete(`pending:${chatId}`);
}

function tariffKeyboard() {
  return {
    inline_keyboard: TARIFFS.map((t) => [{ text: `${t.label} — ${t.price}`, callback_data: `tariff:${t.id}` }]),
  };
}

function sheetKeyboard() {
  return {
    inline_keyboard: SHEETS.map((s, i) => [{ text: s, callback_data: `sheet:${i}` }]),
  };
}

async function handleStart(env, chatId) {
  await clearPending(env, chatId);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "База доноров, инвесторов и грантов Connect4Pro — 468 возможностей для бизнеса и НКО.\n\nВыберите тариф, чтобы получить код полного доступа:",
    reply_markup: tariffKeyboard(),
  });
}

async function handleTariffChoice(env, chatId, tariffId, callbackQueryId) {
  const tariff = TARIFFS.find((t) => t.id === tariffId);
  if (!tariff) return;
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });

  if (tariff.id === "single") {
    await setPending(env, chatId, { step: "choose_sheet", tariffId: tariff.id, tariffLabel: tariff.label, price: tariff.price });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Выберите раздел базы, к которому нужен доступ:",
      reply_markup: sheetKeyboard(),
    });
    return;
  }

  await setPending(env, chatId, { step: "await_receipt", tariffId: tariff.id, tariffLabel: tariff.label, price: tariff.price });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `Тариф «${tariff.label}» — ${tariff.price}.\n\nОплатите на:\n${PAY_REQUISITES}\n\nЗатем пришлите сюда фото или скриншот чека — я перешлю его на подтверждение.`,
  });
}

async function handleSheetChoice(env, chatId, sheetIndex, callbackQueryId) {
  const sheet = SHEETS[sheetIndex];
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  if (!sheet) return;
  const pending = await getPending(env, chatId);
  const price = (pending && pending.price) || "200 сом";
  const tariffLabel = (pending && pending.tariffLabel) || "Разовый доступ (1 раздел)";
  await setPending(env, chatId, { step: "await_receipt", tariffId: "single", tariffLabel, price, sheet });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `Раздел «${sheet}», тариф ${price}.\n\nОплатите на:\n${PAY_REQUISITES}\n\nЗатем пришлите сюда фото или скриншот чека — я перешлю его на подтверждение.`,
  });
}

async function handleReceiptPhoto(env, message) {
  const chatId = message.chat.id;
  const pending = await getPending(env, chatId);
  if (!pending || pending.step !== "await_receipt") {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Сначала выберите тариф — отправьте /start." });
    return;
  }
  const admin = await getAdminChat(env);
  if (!admin) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Приём чеков временно недоступен, попробуйте позже." });
    return;
  }

  const requestId = genId(6);
  const from = message.from || {};
  const buyerLabel = from.username ? "@" + from.username : [from.first_name, from.last_name].filter(Boolean).join(" ") || "без имени";

  await env.TOKENS_KV.put(
    `payreq:${requestId}`,
    JSON.stringify({
      buyer_chat_id: chatId,
      buyer_label: buyerLabel,
      tariffId: pending.tariffId,
      tariffLabel: pending.tariffLabel,
      price: pending.price,
      sheet: pending.sheet || null,
      created_at: new Date().toISOString(),
    }),
    { expirationTtl: 86400 }
  );

  await tg(env, "forwardMessage", { chat_id: admin.chat_id, from_chat_id: chatId, message_id: message.message_id });
  await tg(env, "sendMessage", {
    chat_id: admin.chat_id,
    text: `Новый чек от ${buyerLabel}\nТариф: ${pending.tariffLabel} — ${pending.price}${pending.sheet ? "\nРаздел: " + pending.sheet : ""}\nЗаявка: ${requestId}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Подтвердить", callback_data: `confirm:${requestId}` },
          { text: "❌ Отклонить", callback_data: `reject:${requestId}` },
        ],
      ],
    },
  });
  await tg(env, "sendMessage", { chat_id: chatId, text: "Чек получен, ожидайте подтверждения — обычно в течение дня." });
  await clearPending(env, chatId);
}

async function handleDecision(env, action, requestId, adminUserId, callbackQueryId, callbackMessage) {
  if (!(await isAdmin(env, adminUserId))) {
    await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Только владелец может подтверждать оплату.", show_alert: true });
    return;
  }
  const req = await env.TOKENS_KV.get(`payreq:${requestId}`, "json");
  if (!req) {
    await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Заявка не найдена — возможно, уже обработана." });
    return;
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  await env.TOKENS_KV.delete(`payreq:${requestId}`);

  if (action === "reject") {
    await tg(env, "sendMessage", {
      chat_id: req.buyer_chat_id,
      text: "Не удалось найти вашу оплату. Проверьте реквизиты и пришлите чек ещё раз, либо начните заново: /start",
    });
    if (callbackMessage) {
      await tg(env, "editMessageText", {
        chat_id: callbackMessage.chat.id,
        message_id: callbackMessage.message_id,
        text: `${callbackMessage.text}\n\n❌ Отклонено`,
      });
    }
    return;
  }

  const scope = req.sheet ? { sheet: req.sheet } : null;
  const tokenRec = await issueTokenRecord(env, {
    tier: req.tariffId,
    scope,
    note: `TG ${req.buyer_label}, тариф ${req.tariffLabel}, оплата подтверждена в боте`,
    expires_at: null,
  });

  await tg(env, "sendMessage", {
    chat_id: req.buyer_chat_id,
    text: `Оплата подтверждена! Код доступа: ${tokenRec.token}\n\nВведите его в поле «Код доступа» на azatisrail.cc.`,
  });
  if (callbackMessage) {
    await tg(env, "editMessageText", {
      chat_id: callbackMessage.chat.id,
      message_id: callbackMessage.message_id,
      text: `${callbackMessage.text}\n\n✅ Подтверждено, код выдан: ${tokenRec.token}`,
    });
  }
}

export async function handleTelegramWebhook(request, env) {
  const update = await request.json().catch(() => null);
  if (!update) return new Response("ok");

  try {
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const data = cb.data || "";
      if (data.startsWith("tariff:")) {
        await handleTariffChoice(env, chatId, data.slice(7), cb.id);
      } else if (data.startsWith("sheet:")) {
        await handleSheetChoice(env, chatId, parseInt(data.slice(6), 10), cb.id);
      } else if (data.startsWith("confirm:")) {
        await handleDecision(env, "confirm", data.slice(8), cb.from.id, cb.id, cb.message);
      } else if (data.startsWith("reject:")) {
        await handleDecision(env, "reject", data.slice(7), cb.from.id, cb.id, cb.message);
      }
      return new Response("ok");
    }

    const message = update.message;
    if (!message) return new Response("ok");
    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    if (text === "/start") {
      await handleStart(env, chatId);
    } else if (text.startsWith("/admin_init")) {
      const secret = text.replace("/admin_init", "").trim();
      if (secret && env.BOT_ADMIN_SECRET && secret === env.BOT_ADMIN_SECRET) {
        await env.TOKENS_KV.put("_admin_chat", JSON.stringify({ chat_id: chatId }));
        await tg(env, "sendMessage", { chat_id: chatId, text: "Готово — уведомления о новых чеках теперь приходят сюда." });
      } else {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Неверный код." });
      }
    } else if (message.photo && message.photo.length) {
      await handleReceiptPhoto(env, message);
    } else {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Чтобы получить доступ к базе доноров, отправьте /start." });
    }
  } catch (e) {
    console.error("telegram webhook error", e);
  }

  return new Response("ok");
}
