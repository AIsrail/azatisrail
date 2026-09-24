/**
 * @c4faq_bot — приём оплаты за доступ к базе доноров.
 * Флоу: /start (или диплинк /start <tariff_id> с сайта) -> выбор тарифа ->
 *       (для разового: выбор раздела) -> приветствие + реквизиты ->
 *       покупатель шлёт фото чека -> бот форвардит его владельцу с кнопками ✅/❌ ->
 *       владелец подтверждает -> бот сам выдаёт код доступа и присылает покупателю.
 *
 * Состояние живёт в TOKENS_KV (тот же namespace, что и коды доступа):
 *  - _admin_chat            — { chat_id } куда слать уведомления о новых чеках
 *  - pending:<chat_id>      — текущий шаг покупателя (тариф/раздел), TTL 1 час
 *  - payreq:<request_id>    — заявка на подтверждение, ждёт решения владельца, TTL 24 часа
 */

import { issueTokenRecord } from "./index.js";
import { extractTitle, extractSourceUrl, extractExcerpt, extractQueryWords } from "./extract.js";

const PAY_REQUISITES = "MBank или О!Деньги: 0702 271 827";

const TARIFFS = [
  { id: "basic", label: "Базовая", price: "1900 сом" },
  { id: "standard", label: "Стандартная", price: "4900 сом" },
  { id: "premium", label: "Полноценная", price: "8900 сом" },
  { id: "single", label: "Разовый доступ (1 раздел)", price: "200 сом" },
];

// value — как хранится в базе (r.sheet), label — понятный текст для покупателя.
const SHEETS = [
  { value: "Доноры", label: "Доноры и гранты" },
  { value: "Инвесторы межд", label: "Инвесторы — международные и региональные" },
  { value: "Инвесторы КР", label: "Инвесторы — в Кыргызстане" },
  { value: "Финансы МСБ КР", label: "Финансирование для МСБ в Кыргызстане (кредиты, льготы)" },
  { value: "Акселераторы и др.", label: "Акселераторы и центры поддержки бизнеса" },
  { value: "Стажировки и стипендии", label: "Стажировки и стипендии (для специалистов)" },
];

// Те же темы, что используются для секторных тегов в основной базе — так свободный
// текст покупателя ложится на ту же систему, что уже размечает записи.
const SECTOR_KW = [
  ["Технологии/ИИ", /\b(ии|ai\b|искусственн\w* интеллект|цифров\w* эконом|data\b|кибер|программн\w* обеспечен|deep ?tech|хакатон)/i],
  ["Климат/экология", /клима|эколог|устойчив\w* развит|зелён|зелен\w+ (энерг|финанс|техн)|выброс|природн\w* (наслед|решен)|биоразнообраз|возобновляем\w* энерг/i],
  ["Здравоохранение", /здравоохран|медицин\w*|пациент/i],
  ["Образование", /образовательн|edtech|школ\w*|студент\w*|высш\w* образован/i],
  ["Женщины/гендер", /женщин|гендер\w*|девуш\w*|women\b/i],
  ["Сельское хозяйство", /сельск\w* хозяйств|агро[а-я]*|фермер|продовольств/i],
  ["Права человека/демократия", /демократ|прав\w* человека|гражданск\w* обществ|миграц|конфликт/i],
  ["Медиа/журналистика", /журналист|медиа\b|сми\b|расследовательск/i],
  ["Бизнес/МСБ", /стартап|предпринимат|мсб\b|малого и среднего бизнеса|бизнес-|венчур/i],
  ["Инвалидность/инклюзия", /инвалид|инклюз|ограниченн\w* возможностями|овз\b|особ\w* потребностями|disabilit/i],
];

const SKIP_HINT_RE = /^(-|пропустить|нет|skip)$/i;

// Короткий текст (пара слов) — используем как есть. Длинный (скопированное описание
// организации) — вытаскиваем из него узнаваемые темы, чтобы не искать по всему абзацу
// буквально (это почти никогда не совпадёт с текстом записи в базе). Если тема не
// распозналась — берём значимые слова (без "для/у/меня/в Токмаке/5 лет..."), а не
// обрубок первых 60 символов: обрубок почти гарантированно ничего не найдёт в базе.
function distillHint(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || SKIP_HINT_RE.test(trimmed)) return null;
  if (trimmed.length <= 60) return trimmed;
  const found = SECTOR_KW.filter(([, re]) => re.test(trimmed)).map(([label]) => label);
  if (found.length) return found[0];
  const words = extractQueryWords(trimmed).slice(0, 6);
  return words.length ? words.join(" ") : trimmed.slice(0, 60);
}

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

async function handleChannelPost(env, post) {
  const text = post.text || post.caption || "";
  const title = extractTitle(text);
  if (!title) return;
  const sourceUrl = extractSourceUrl(text);
  const username = post.chat && post.chat.username;
  const tgUrl = username && post.message_id ? `https://t.me/${username}/${post.message_id}` : null;
  const url = sourceUrl || tgUrl;
  if (!url) return;

  const archive = (await env.FUNDING_KV.get("archive", "json")) || [];
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    title,
    excerpt: extractExcerpt(text),
    url,
    tg_url: tgUrl,
  };
  archive.unshift(entry);
  await env.FUNDING_KV.put("archive", JSON.stringify(archive));
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
    inline_keyboard: SHEETS.map((s, i) => [{ text: s.label, callback_data: `sheet:${i}` }]),
  };
}

function greeting() {
  return "Здравствуйте! 🙏 Спасибо за интерес к базе доноров, инвесторов и грантов Connect4Pro.\n\n";
}

function paymentText(tariffLabel, price, sheet) {
  const sheetLine = sheet ? `Раздел: «${sheet}»\n` : "";
  return (
    greeting() +
    `Тариф: «${tariffLabel}» — ${price}\n${sheetLine}\n` +
    `Оплатите переводом на ${PAY_REQUISITES}\n\n` +
    `После оплаты пришлите сюда фото или скриншот чека — как только увижу, сразу пришлю код доступа.`
  );
}

async function handleStart(env, chatId) {
  await clearPending(env, chatId);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: greeting() + "482 возможностей для бизнеса и НКО. Выберите тариф, чтобы получить код доступа:",
    reply_markup: tariffKeyboard(),
  });
}

async function startTariffFlow(env, chatId, tariff) {
  await clearPending(env, chatId);
  if (tariff.id === "single") {
    await setPending(env, chatId, { step: "choose_sheet", tariffId: tariff.id, tariffLabel: tariff.label, price: tariff.price });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: greeting() + "Выберите раздел базы, к которому нужен доступ:",
      reply_markup: sheetKeyboard(),
    });
    return;
  }
  await setPending(env, chatId, { step: "await_receipt", tariffId: tariff.id, tariffLabel: tariff.label, price: tariff.price });
  await tg(env, "sendMessage", { chat_id: chatId, text: paymentText(tariff.label, tariff.price) });
}

async function handleTariffChoice(env, chatId, tariffId, callbackQueryId) {
  const tariff = TARIFFS.find((t) => t.id === tariffId);
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  if (!tariff) return;
  await startTariffFlow(env, chatId, tariff);
}

async function handleSheetChoice(env, chatId, sheetIndex, callbackQueryId) {
  const sheet = SHEETS[sheetIndex];
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  if (!sheet) return;
  const pending = await getPending(env, chatId);
  const price = (pending && pending.price) || "200 сом";
  const tariffLabel = (pending && pending.tariffLabel) || "Разовый доступ (1 раздел)";
  await setPending(env, chatId, { step: "awaiting_hint", tariffId: "single", tariffLabel, price, sheet: sheet.value, sheetLabel: sheet.label });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `Раздел «${sheet.label}» выбран.\n\n` +
      `Разовый доступ показывает только 5 записей, поэтому напишите, что именно ищете — ` +
      `несколько ключевых слов (например: «климат НКО») или подробнее об организации/проекте ` +
      `(можно скопировать текст, до 1 страницы) — чем точнее опишете, тем точнее подбор.\n\n` +
      `Если пропустить этот шаг — отправьте «-».`,
  });
}

async function handleHintReply(env, message) {
  const chatId = message.chat.id;
  const pending = await getPending(env, chatId);
  const raw = (message.text || "").trim().slice(0, 4000);
  const hint = distillHint(raw);
  await setPending(env, chatId, {
    ...pending,
    step: "await_receipt",
    hintRaw: raw || null,
    hint,
  });
  await tg(env, "sendMessage", { chat_id: chatId, text: paymentText(pending.tariffLabel, pending.price, pending.sheetLabel) });
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
      sheetLabel: pending.sheetLabel || null,
      hint: pending.hint || null,
      hintRaw: pending.hintRaw || null,
      created_at: new Date().toISOString(),
    }),
    { expirationTtl: 86400 }
  );

  await tg(env, "forwardMessage", { chat_id: admin.chat_id, from_chat_id: chatId, message_id: message.message_id });
  await tg(env, "sendMessage", {
    chat_id: admin.chat_id,
    text: `Новый чек от ${buyerLabel}\nТариф: ${pending.tariffLabel} — ${pending.price}${pending.sheetLabel ? "\nРаздел: " + pending.sheetLabel : ""}${pending.hintRaw ? "\nЗапрос: " + pending.hintRaw.slice(0, 300) : ""}\nЗаявка: ${requestId}`,
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

  const scope = req.sheet ? { sheet: req.sheet, hint: req.hint || undefined } : null;
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
      // Кнопки — только в личке бота, никогда в группах/каналах, где он тоже может быть админом.
      if (!cb.message || !cb.message.chat || cb.message.chat.type !== "private") return new Response("ok");
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

    if (update.channel_post) {
      // Захватываем посты только из своего канала connect4_pro — не из любого чата, где бот админ.
      const chat = update.channel_post.chat;
      if (chat && chat.username && chat.username.toLowerCase() === "connect4_pro") {
        await handleChannelPost(env, update.channel_post);
      }
      return new Response("ok");
    }

    const message = update.message;
    if (!message) return new Response("ok");
    // Платёжный флоу — только личка с ботом. Никаких ответов в группах/каналах,
    // где бот тоже состоит (например, другие Tg-группы, где он админ по другой причине).
    if (!message.chat || message.chat.type !== "private") return new Response("ok");
    const chatId = message.chat.id;
    const text = (message.text || "").trim();
    const pendingForHint = text && !text.startsWith("/") ? await getPending(env, chatId) : null;

    if (pendingForHint && pendingForHint.step === "awaiting_hint") {
      await handleHintReply(env, message);
    } else if (text.startsWith("/start")) {
      // Диплинк с сайта: t.me/c4faq_bot?start=basic -> Telegram шлёт "/start basic"
      const payload = text.slice(6).trim();
      const tariff = payload ? TARIFFS.find((t) => t.id === payload) : null;
      if (tariff) {
        await startTariffFlow(env, chatId, tariff);
      } else {
        await handleStart(env, chatId);
      }
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
