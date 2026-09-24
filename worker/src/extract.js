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

// Донор без узкой ниши (SDG/ЦУР, "социально-экономические проекты", благотворительность
// широкого профиля, "уязвимые слои населения", "дети и молодёжь" и т.п.) по смыслу подходит
// под ЛЮБУЮ социальную тему, если явно не ограничен другим направлением — иначе запрос вроде
// "сирота" почти ничего не найдёт буквально, хотя половина базы формально готова его принять.
// "Если не запрещено — значит разрешено": такие записи участвуют в поиске даже без буквального
// совпадения ключевых слов (см. search() в index.js).
// "благотворительн\w*" намеренно не включён отдельным триггером — это общее институциональное
// слово ("Благотворительный фонд X"), которое ничего не говорит о широте фокуса конкретного X.
export const BROAD_SCOPE_KW =
  /социально.?эконом|\bsdg\b|цел\w* устойчивого развития|\bцур\b|развивающихся стран|широк\w* спектр|разные (проект|направлен)|любы?х?\s*(проект|сфер|направлен)|уязвим\w*\s*(груп|сло|населен|люд)|бедн\w*\s*(слo|населен|люд)|без\s+вся\w*\s*условий|гражданского общества|местных сообществ|детей и молодеж|дети,?\s*молодеж|социальн\w*\s*(проблем|новаторск)|разн\w*\s*социальн/i;

export function classifyGeneralist(text) {
  return BROAD_SCOPE_KW.test(text || "");
}

// --- Поиск по запросу: общая логика для index.js (структурированная база, архивы) и
// telegram.js (сжатие подсказки покупателя разового тарифа в ключевые слова) ---

// Служебные слова, которые не несут поисковой нагрузки — если их не выкинуть, длинная
// фраза из бота ("гранты для инвалидов, у меня реабилитационный центр в Токмаке...")
// требует буквального совпадения каждого слова и почти никогда ничего не находит.
export const STOPWORDS_RU = new Set([
  "для", "меня", "мне", "нам", "нас", "вас", "их", "его", "её", "мой", "моя", "моё", "мои",
  "наш", "наша", "наше", "наши", "я", "мы", "он", "она", "оно", "они", "вы", "ты", "у", "в",
  "во", "с", "со", "и", "а", "но", "или", "что", "это", "эта", "этот", "это", "эти", "как",
  "там", "тут", "при", "за", "до", "по", "от", "к", "ко", "из", "на", "не", "же", "ли", "бы",
  "уже", "ещё", "если", "чтобы", "есть", "был", "была", "было", "были", "лет", "года", "год",
  "годы", "работает", "работаю", "которая", "который", "которое", "которые", "очень", "просто",
  "только", "также", "тоже", "свой", "своя", "своё", "то", "все", "всё", "всех",
]);

// Грубый стемминг: у русских слов обычно 5-8 буквенный корень и переменное окончание
// ("инвалидов" / "инвалидностью" / "инвалидность" — не совпадут буквально, но совпадут
// первые 6 букв). Короткие слова (≤6 букв) не трогаем — там урезание не нужно и рискованно.
function stemWord(w) {
  return w.length > 6 ? w.slice(0, 6) : w;
}

// "грант"/"гранты"/"грантов" и т.п. не несут поисковой нагрузки в БАЗЕ ГРАНТОВ — это слово
// (или его часть, "Микрогранты") встречается почти в каждой записи, поэтому совпадение только
// по нему давало ложные топ-совпадения (конкурс по стройиндустрии — на запрос "гранты для
// молодёжи", просто потому что в сумме гранта было слово "гранты"). В общем русском это не
// стоп-слово — но в этом домене корень "грант" так же неинформативен, как и стоп-слова выше.
const GRANT_ROOT_RE = /^грант/i;

// "ё" и "е" на практике взаимозаменяемы в русских текстах (одни источники пишут "молодёжь",
// другие — "молодежь"), но как буквы они разные — без нормализации то же слово в запросе и в
// записи базы может буквально не совпасть только из-за этого. Применяется и к запросу, и к
// тексту записей (см. recordHay и т.п. в index.js), иначе нормализация с одной стороны бесполезна.
export function normalizeRu(text) {
  return (text || "").toLowerCase().replace(/ё/g, "е");
}

export function extractQueryWords(q) {
  const raw = normalizeRu(q).replace(/[^a-zа-я0-9]+/gi, " ").split(/\s+/).filter(Boolean);
  return raw.filter((w) => w.length >= 3 && !STOPWORDS_RU.has(w) && !GRANT_ROOT_RE.test(w)).map(stemWord);
}

// Многословный запрос должен требовать все значимые слова где-то в тексте (без служебных
// слов) — иначе длинная фраза почти никогда ничего не найдёт.
export function matchesQuery(hay, q) {
  const words = extractQueryWords(q);
  if (!words.length) return true;
  return words.every((w) => hay.includes(w));
}

// Мягкий поиск: хватит совпадения хотя бы одного значимого слова. Используется как fallback,
// когда строгий AND-поиск не нашёл вообще ничего — лучше показать примерно похожее, чем пусто.
export function matchesQueryLoose(hay, q) {
  const words = extractQueryWords(q);
  if (!words.length) return true;
  return words.some((w) => hay.includes(w));
}

// Сколько из значимых слов запроса нашлось в тексте — чтобы среди мягких совпадений
// самые тематически близкие (несколько слов) не терялись за записями, зацепившимися
// только за одно общее слово вроде "гранты".
export function scoreQueryWords(hay, words) {
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

// В базе грантов почти любая запись содержит "гранты" — простой подсчёт совпавших слов
// не отличает такое общее слово от узкого/редкого ("инвалид", "реабилитац"), из-за чего
// запись, реально совпавшая по теме, проигрывает записям, случайно зацепившимся за общие
// слова. Здесь редкие слова (df мало) весят намного больше частых — как IDF в полнотекстовом
// поиске. hayList — тексты всего пула кандидатов, по которому меряется частота слова.
export function makeRelevanceScorer(hayList, words) {
  const n = hayList.length || 1;
  const df = {};
  for (const w of words) {
    df[w] = hayList.reduce((c, h) => c + (h.includes(w) ? 1 : 0), 0) || 1;
  }
  return (hay) => words.reduce((s, w) => s + (hay.includes(w) ? Math.log((n + 1) / df[w]) : 0), 0);
}
