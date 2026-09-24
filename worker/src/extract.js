/**
 * Разбор постов Connect4Pro (FB/TG) в формате "👉 Заголовок / 💸 Тип / 📅 Дедлайн / текст / ---
 * реклама --- / ... / Подробности: ссылка" в компактную запись {title, excerpt, url}.
 * Общий для telegram.js (захват новых постов канала) и index.js (живой поиск по странице FB).
 */

// Собственные/перекрёстные домены — не показывать как "ссылку на источник".
export const HOUSE_DOMAINS = [
  "t.me/connect4_pro",
  "t.me/kginvest",
  "t.me/bilim4kg",
  "grantmanual.tilda.ws",
  "pro4dev.tilda.ws",
  "connect4funds.tilda.ws",
  "connect4baza.tilda.ws",
  "facebook.com/connect4kg",
  "fund4.pro",
  "fund4pro",
  "azatisrail.cc",
  "azatisrail.org",
];

const URL_RE = /https?:\/\/[^\s,;]+/gi;
const TITLE_RE = /^👉\s*(.+?)\s*\n/;

export function extractTitle(text) {
  const m = TITLE_RE.exec(text || "");
  if (m) return m[1].trim();
  const firstLine = (text || "").split("\n")[0].trim();
  return firstLine ? firstLine.slice(0, 140) : null;
}

export function extractSourceUrl(text) {
  const urls = (text || "").match(URL_RE) || [];
  const real = urls.filter((u) => !HOUSE_DOMAINS.some((d) => u.toLowerCase().includes(d)));
  return real[0] || null;
}

export function extractExcerpt(text) {
  let body = (text || "").replace(/^👉[^\n]*\n/, "");
  const parts = body.split("\n\n");
  body = parts.length > 1 ? parts.slice(1).join("\n\n") : body;
  body = body.replace(/\s*---\s*/g, " ").replace(/\s+/g, " ").trim();
  return body.slice(0, 260);
}

export function parsePost(text) {
  const title = extractTitle(text);
  if (!title) return null;
  return {
    title,
    excerpt: extractExcerpt(text),
    url: extractSourceUrl(text),
  };
}

// --- Дедлайн и регион: чтобы бесплатный архив-тизер не дублировал платную базу ---
// (показывает только то, что уже неактуально — прошедшие дедлайны — или международные
// возможности без дедлайна, куда абсолютное большинство местных пользователей не идёт).

const MONTHS_RU = {
  январь: 0, января: 0, февраль: 1, февраля: 1, март: 2, марта: 2, апрель: 3, апреля: 3,
  май: 4, мая: 4, июнь: 5, июня: 5, июль: 6, июля: 6, август: 7, августа: 7,
  сентябрь: 8, сентября: 8, октябрь: 9, октября: 9, ноябрь: 10, ноября: 10, декабрь: 11, декабря: 11,
};

const DEADLINE_RE = /📅\s*Дедлайн:\s*([^\n]+)/i;
const DEADLINE_DATE_RE = /(\d{1,2})[\s-]+([а-яёА-ЯЁ]+)(?:\s+(\d{4}))?/;
const ROLLING_RE = /регулярн|постоянно|любое время|ежемесячно|открытый приём|открытый прием|эмес|нет\s*$/i;
const UNSPECIFIED_RE = /не\s*указан/i;

// "passed" — дедлайн уже прошёл, "open" — известен и ещё впереди, "none" — не указан/regular.
export function extractDeadlineStatus(text, postDateISO) {
  const m = DEADLINE_RE.exec(text || "");
  if (!m) return "none";
  const raw = m[1].trim();
  if (UNSPECIFIED_RE.test(raw) || ROLLING_RE.test(raw)) return "none";
  const dm = DEADLINE_DATE_RE.exec(raw);
  if (!dm) return "none";
  const day = parseInt(dm[1], 10);
  const month = MONTHS_RU[dm[2].toLowerCase()];
  if (month === undefined) return "none";
  const postDate = postDateISO ? new Date(postDateISO) : null;
  let year = dm[3] ? parseInt(dm[3], 10) : (postDate ? postDate.getUTCFullYear() : new Date().getUTCFullYear());
  let deadline = new Date(Date.UTC(year, month, day, 23, 59, 59));
  if (!dm[3] && postDate && deadline < postDate) {
    deadline = new Date(Date.UTC(year + 1, month, day, 23, 59, 59));
  }
  return deadline.getTime() < Date.now() ? "passed" : "open";
}

const KG_KW = /кыргызстан|кыргызск|\bкр\b|бишкек|\bош\b|таласск|нарынск|джалал-абад|баткен/i;
const REGIONAL_KW = /центральн\w* ази|\bца\b|региональн|astana ?hub|астана ?хаб|казахстан|узбекистан|таджикистан|туркменистан|снг\b/i;

export function classifyArchiveRegion(text) {
  const t = text || "";
  if (KG_KW.test(t)) return "kg";
  if (REGIONAL_KW.test(t)) return "regional";
  return "international";
}
