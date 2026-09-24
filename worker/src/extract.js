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
