/**
 * @c4faq_bot — приём оплаты за доступ к базе доноров.
 * Флоу: /start (или диплинк /start <tariff_id> с сайта) -> выбор тарифа ->
 *       (для разового: выбор раздела) -> приветствие + реквизиты ->
 *       покупатель шлёт фото чека -> бот форвардит его владельцу с кнопками ✅/❌ ->
 *       владелец подтверждает -> бот сам выдаёт код доступа на 6 месяцев (разовый тариф —
 *       сразу присылает 5 вариантов в чат, без кода).
 *
 * Состояние живёт в TOKENS_KV (тот же namespace, что и коды доступа):
 *  - _admin_chat            — { chat_id } куда слать уведомления о новых чеках
 *  - pending:<chat_id>      — текущий шаг покупателя (тариф/раздел), TTL 1 час
 *  - payreq:<request_id>    — заявка на подтверждение, ждёт решения владельца, TTL 24 часа
 */

import { issueTokenRecord } from "./index.js";
import { pickForBuyer, REGION_LABEL } from "./pick.js";
import { extractTitle, extractSourceUrl, extractExcerpt, extractQueryWords } from "./extract.js";

const PAY_REQUISITES = "MBank или О!Деньги: 0702 271 827";

// Тарифы с 2026-09-25. id уходит в rec.tier токена (см. PLAN_DB / FUND4PRO_PROJECTS в index.js).
// "single" — только в Telegram: 5 вариантов сразу в чат, кода для сайта покупатель не получает.
const TARIFFS = [
  { id: "db", label: "Базовый", price: "1500 сом", what: "поиск по всей базе доноров на сайте, 6 месяцев" },
  {
    id: "pro",
    label: "Расширенный",
    price: "4500 сом",
    what: "база + архив публикаций + пособия и шаблоны + ИИ-помощник fund4pro для разработки проектного предложения (2 проекта), 6 месяцев",
  },
  { id: "single", label: "Разовый подбор (5 вариантов)", price: "200 сом", what: "5 вариантов под вашу задачу по всей базе — сразу сюда в чат" },
];

// Старые диплинки (t.me/c4faq_bot?start=basic и т.п. — в постах, на старых страницах) ведут
// на ближайший новый тариф, а не на пустое приветствие.
const LEGACY_TARIFF_IDS = { basic: "db", standard: "pro", premium: "pro" };

const ACCESS_MONTHS = 6;

function accessUntil() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + ACCESS_MONTHS);
  d.setUTCHours(23, 59, 59, 0);
  return d.toISOString();
}

function formatDateRu(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bishkek" });
}

// Юзернейм бота fund4pro (без @) — переменная окружения FUND4PRO_BOT. Задавать её, только когда
// fund4pro уже умеет принимать код (POST /api/fund4pro/redeem в index.js): до этого покупатель
// получает "доступ пришлю отдельно", а владелец — напоминание начислить проекты вручную.
function fund4proText(env) {
  return env.FUND4PRO_BOT
    ? `ИИ-помощник для проектного предложения: отправьте этот же код боту @${env.FUND4PRO_BOT} — он начислит 2 проекта.`
    : `Доступ к ИИ-помощнику fund4pro для проектного предложения (2 проекта) пришлю отдельно.`;
}

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

export async function tg(env, method, params) {
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

export async function getAdminChat(env) {
  return env.TOKENS_KV.get("_admin_chat", "json");
}

// Разовый токен (200 сом): если даже мягкий поиск ничего не нашёл в оплаченном разделе
// (search() в index.js подставляет вместо этого общую подборку по разделу — queryFallback),
// владелец получает уведомление и может вручную найти 2-3 реальные возможности за пределами
// базы, добавить их (вкладка "Записи вручную" в админке) и ответить покупателю через бота —
// чтобы у него не было чувства, что его "кинули" при оплаченном, но нерелевантном поиске.
export async function notifyAdminFallback(env, { token, sheet, q, buyerLabel, buyerChatId }) {
  const admin = await getAdminChat(env);
  if (!admin) return;
  const reply_markup = buyerChatId
    ? { inline_keyboard: [[{ text: "✍️ Ответить покупателю", callback_data: `areply:${buyerChatId}` }]] }
    : undefined;
  await tg(env, "sendMessage", {
    chat_id: admin.chat_id,
    text:
      `⚠️ Разовый подбор — по запросу в базе мало подходящего\n` +
      `Покупатель: ${buyerLabel || "—"}\n` +
      `Раздел: ${sheet || "—"}\n` +
      `Запрос: ${q ? q.slice(0, 300) : "—"}\n` +
      (token && token !== "—" ? `Код: ${token}\n` : "") +
      `\n` +
      `Стоит вручную найти 2-3 подходящие возможности вне базы, добавить их через вкладку ` +
      `«Записи вручную» в админке и ответить покупателю кнопкой ниже.`,
    reply_markup,
  });
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


function greeting() {
  return "Здравствуйте! 🙏 Спасибо за интерес к базе доноров, инвесторов и грантов Connect4Pro.\n\n";
}

function paymentText(tariffLabel, price, sheet) {
  const sheetLine = sheet ? `Раздел: «${sheet}»\n` : "";
  return (
    greeting() +
    `Тариф: «${tariffLabel}» — ${price}\n${sheetLine}\n` +
    `Оплатите переводом на ${PAY_REQUISITES}\n\n` +
    (sheet
      ? `После оплаты пришлите сюда фото или скриншот чека — как только увижу, сразу пришлю подборку.`
      : `После оплаты пришлите сюда фото или скриншот чека — как только увижу, сразу пришлю код доступа.`)
  );
}

async function handleStart(env, chatId) {
  await clearPending(env, chatId);
  const list = TARIFFS.map((t) => `• ${t.label} — ${t.price}: ${t.what}`).join("\n");
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: greeting() + "Более 450 возможностей для бизнеса и НКО. Тарифы:\n\n" + list + "\n\nВыберите тариф:",
    reply_markup: tariffKeyboard(),
  });
}

async function startTariffFlow(env, chatId, tariff) {
  await clearPending(env, chatId);
  if (tariff.id === "single") {
    // Подбор идёт по всей базе (см. pick.js) — раздел больше не спрашиваем: покупатель не
    // обязан знать, что акселератор и инвестфонд лежат в разных разделах.
    await setPending(env, chatId, { step: "awaiting_hint", tariffId: tariff.id, tariffLabel: tariff.label, price: tariff.price });
    await tg(env, "sendMessage", { chat_id: chatId, text: greeting() + HINT_PROMPT });
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

const HINT_PROMPT =
  `Разовый подбор — это 5 вариантов под вашу задачу, поэтому опишите, что ищете: кто вы (НКО, ` +
  `бизнес, стартап, физлицо), где работаете, на что нужны деньги и какой вид поддержки интересен ` +
  `(грант, инвестиции, кредит, акселератор). Можно скопировать описание организации или проекта ` +
  `(до 1 страницы) — чем подробнее, тем точнее подбор.`;

// Устаревший шаг (раньше разовый тариф выбирал раздел): кнопки из старых сообщений
// ведут в тот же сценарий, что и новый флоу.
async function handleSheetChoice(env, chatId, sheetIndex, callbackQueryId) {
  const sheet = SHEETS[sheetIndex];
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  if (!sheet) return;
  const pending = await getPending(env, chatId);
  const single = TARIFFS.find((t) => t.id === "single");
  const price = (pending && pending.price) || single.price;
  const tariffLabel = (pending && pending.tariffLabel) || single.label;
  await setPending(env, chatId, { step: "awaiting_hint", tariffId: "single", tariffLabel, price });
  await tg(env, "sendMessage", { chat_id: chatId, text: HINT_PROMPT });
}

async function handleHintReply(env, message) {
  const chatId = message.chat.id;
  const pending = await getPending(env, chatId);
  const raw = (message.text || "").trim().slice(0, 4000);
  const hint = distillHint(raw);
  // Без описания подбор из 5 вариантов превращается в лотерею — просим описать задачу.
  if (!hint) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Опишите, пожалуйста, задачу хотя бы парой фраз — без этого подбор не получится.\n\n" + HINT_PROMPT });
    return;
  }
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

// Разовый тариф живёт только в Telegram: 5 вариантов сразу в чат (pick.js), кода для сайта нет.
const SINGLE_SEEN_TTL = 7776000; // 90 дней: при повторной покупке показываем новое

function formatSingleResult({ r, why }, i) {
  const lines = [`${i + 1}. ${r.name.replace(/\s+/g, " ").trim()}`];
  lines.push(`🌍 ${REGION_LABEL[r.region] || "—"}`);
  if (why) lines.push(`✅ ${why}`);
  if (r.amount) lines.push(`💰 ${r.amount.replace(/\s+/g, " ").slice(0, 150)}`);
  if (r.deadline) lines.push(`📅 ${r.deadline.replace(/\s+/g, " ").slice(0, 150)}`);
  if (r.description) {
    const d = r.description.replace(/\s+/g, " ").trim();
    lines.push(d.length > 220 ? d.slice(0, 220) + "…" : d);
  }
  const urls = Array.from(new Set([r.url, ...(r.urls || [])].filter(Boolean))).slice(0, 2);
  lines.push(urls.length ? `🔗 ${urls.join("\n🔗 ")}` : "🔗 Ссылки в базе нет — напишите сюда, пришлю контакты.");
  return lines.join("\n");
}

function formatSingleResultsMessage(picks) {
  return (
    `Вот ${picks.length} наиболее подходящих вариантов — сначала Кыргызстан, затем регион, затем международные:\n\n` +
    picks.map(formatSingleResult).join("\n\n") +
    `\n\nПрограммы меняются: сохраните подходящие и проверьте сроки на сайте программы перед подачей.`
  );
}

async function deliverSinglePicks(env, req) {
  const q = (req.hintRaw || req.hint || "").slice(0, 2000);
  const seenKey = `single_seen:tg:${req.buyer_chat_id}`;
  const seen = new Set((await env.TOKENS_KV.get(seenKey, "json")) || []);
  const { picks, weak } = await pickForBuyer(env, null, q, { exclude: seen });
  if (!picks.length) {
    await tg(env, "sendMessage", {
      chat_id: req.buyer_chat_id,
      text: "Подходящих вариантов сходу не нашлось — посмотрю вручную и пришлю сам, подождите, пожалуйста.",
    });
  } else {
    await tg(env, "sendMessage", { chat_id: req.buyer_chat_id, text: formatSingleResultsMessage(picks), disable_web_page_preview: true });
    const next = Array.from(new Set([...seen, ...picks.map((p) => p.r.id)])).slice(-200);
    await env.TOKENS_KV.put(seenKey, JSON.stringify(next), { expirationTtl: SINGLE_SEEN_TTL });
  }
  if (weak || picks.length < 5) {
    await notifyAdminFallback(env, { token: "—", sheet: "вся база", q, buyerLabel: req.buyer_label, buyerChatId: req.buyer_chat_id });
  }
  return picks.length;
}

async function handleDecision(env, action, requestId, adminUserId, callbackQueryId, callbackMessage, ctx) {
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
        reply_markup: { inline_keyboard: [] },
      });
    }
    return;
  }

  if (req.tariffId === "single") {
    // Подбор с LLM занимает 10-20 с — вебхук Telegram отвечаем сразу, работа идёт в фоне.
    const job = (async () => {
      if (callbackMessage) {
        await tg(env, "editMessageText", {
          chat_id: callbackMessage.chat.id,
          message_id: callbackMessage.message_id,
          text: `${callbackMessage.text}\n\n⏳ Подтверждено, идёт подбор…`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      await tg(env, "sendMessage", { chat_id: req.buyer_chat_id, text: "Оплата подтверждена! Подбираю варианты — это займёт до минуты." });
      const n = await deliverSinglePicks(env, req);
      if (callbackMessage) {
        await tg(env, "editMessageText", {
          chat_id: callbackMessage.chat.id,
          message_id: callbackMessage.message_id,
          text: `${callbackMessage.text}\n\n✅ Подтверждено, отправлено вариантов: ${n}`,
          reply_markup: { inline_keyboard: [] },
        });
      }
    })().catch((e) => console.error("single delivery failed", e));
    if (ctx) ctx.waitUntil(job);
    else await job;
    return;
  }

  const expires_at = accessUntil();
  const tokenRec = await issueTokenRecord(env, {
    tier: req.tariffId,
    scope: null,
    note: `TG ${req.buyer_label}, тариф ${req.tariffLabel} (${req.price}), оплата подтверждена в боте`,
    expires_at,
    buyer_chat_id: req.buyer_chat_id,
    buyer_label: req.buyer_label,
  });

  {
    const until = formatDateRu(expires_at);
    let text =
      `Оплата подтверждена! Код доступа: ${tokenRec.token}\n` +
      `Действует до ${until}.\n\n` +
      `Введите его в поле «Код доступа» на azatisrail.cc.`;
    if (req.tariffId === "pro") {
      text += `\n\n${fund4proText(env)}\nПособия и шаблоны пришлю сюда отдельно.`;
    }
    await tg(env, "sendMessage", { chat_id: req.buyer_chat_id, text });
  }
  if (callbackMessage) {
    const note =
      `✅ Подтверждено, код выдан: ${tokenRec.token} (до ${formatDateRu(expires_at)})` +
        (req.tariffId === "pro"
          ? "\n📚 Не забудьте отправить покупателю пособия и шаблоны." +
            (env.FUND4PRO_BOT ? "" : "\n🤖 И начислить ему 2 проекта в fund4pro вручную.")
          : "");
    await tg(env, "editMessageText", {
      chat_id: callbackMessage.chat.id,
      message_id: callbackMessage.message_id,
      text: `${callbackMessage.text}\n\n${note}`,
      reply_markup: { inline_keyboard: [] },
    });
  }
}

// Ответ покупателю на "промах" поиска (см. notifyAdminFallback) — владелец жмёт кнопку,
// следующее сообщение от него в этом чате пересылается покупателю как есть (текст/фото).
async function handleAdminReplyStart(env, adminChatId, buyerChatId, adminUserId, callbackQueryId, sourceMessage) {
  if (!(await isAdmin(env, adminUserId))) {
    await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Только владелец может отвечать покупателям.", show_alert: true });
    return;
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  await setPending(env, adminChatId, {
    step: "admin_reply",
    buyerChatId,
    sourceMessageId: sourceMessage ? sourceMessage.message_id : null,
  });
  await tg(env, "sendMessage", {
    chat_id: adminChatId,
    text: "Напишите сообщение (текст или фото) — перешлю его покупателю как есть. Для отмены: /cancel",
  });
}

async function handleAdminReplyMessage(env, message, pending) {
  const adminChatId = message.chat.id;
  await tg(env, "copyMessage", {
    chat_id: pending.buyerChatId,
    from_chat_id: adminChatId,
    message_id: message.message_id,
  });
  await clearPending(env, adminChatId);
  // Уведомление о промахе обработано — кнопка "Ответить покупателю" больше не нужна.
  if (pending.sourceMessageId) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: adminChatId,
      message_id: pending.sourceMessageId,
      reply_markup: { inline_keyboard: [] },
    });
  }
  await tg(env, "sendMessage", { chat_id: adminChatId, text: "Отправлено покупателю ✓" });
}

export async function handleTelegramWebhook(request, env, ctx) {
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
        await handleDecision(env, "confirm", data.slice(8), cb.from.id, cb.id, cb.message, ctx);
      } else if (data.startsWith("reject:")) {
        await handleDecision(env, "reject", data.slice(7), cb.from.id, cb.id, cb.message);
      } else if (data.startsWith("areply:")) {
        await handleAdminReplyStart(env, chatId, data.slice(7), cb.from.id, cb.id, cb.message);
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
    // Фото тоже нужно проверять на pending (ответ покупателю может быть скриншотом) —
    // поэтому pending читаем всегда, а не только для непустого текста, как раньше.
    const pending = await getPending(env, chatId);
    const hasContent = Boolean(text || (message.photo && message.photo.length));

    if (pending && pending.step === "admin_reply" && hasContent) {
      await handleAdminReplyMessage(env, message, pending);
    } else if (pending && pending.step === "awaiting_hint" && text && !text.startsWith("/")) {
      await handleHintReply(env, message);
    } else if (text.startsWith("/cancel")) {
      if (pending) {
        await clearPending(env, chatId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Отменено." });
      } else {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Нечего отменять." });
      }
    } else if (text.startsWith("/start")) {
      // Диплинк с сайта: t.me/c4faq_bot?start=basic -> Telegram шлёт "/start basic"
      const payload = text.slice(6).trim();
      const id = LEGACY_TARIFF_IDS[payload] || payload;
      const tariff = id ? TARIFFS.find((t) => t.id === id) : null;
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
      await tg(env, "sendMessage", { chat_id: chatId, text: "Чтобы выбрать тариф, отправьте /start." });
    }
  } catch (e) {
    console.error("telegram webhook error", e);
  }

  return new Response("ok");
}
