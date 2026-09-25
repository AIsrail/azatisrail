/**
 * Семантический поиск по базе доноров: эмбеддинги Workers AI (EmbeddingGemma, понимает русский).
 * Буквальный поиск по словам не знает синонимов ("цех" ≈ "производство", "фермер" ≈ "сельхоз-
 * кредиты") и промахивается, когда нужного слова просто нет в описании записи. Здесь каждая
 * запись один раз превращается в вектор, запрос — при поиске, близость меряется косинусом.
 *
 * Хранение в FUNDING_KV — бинарно, а не JSON: на бесплатном плане Worker'у дано ~10 мс CPU на
 * запрос, и разбор сотен векторов из JSON съел бы заметную часть. Векторы нормализованы и
 * квантованы в int8 (768 байт на запись): точности для ранжирования хватает с запасом.
 *   emb_meta — JSON { model, dim, ids[], hashes[] }
 *   emb_vec  — ArrayBuffer, ids.length * dim байт, в том же порядке, что ids
 *
 * Индекс самовосстанавливается: если в "records" появились записи без вектора (заливка новой
 * базы, ручное добавление в админке) или текст записи изменился, search() в фоне запускает
 * reindex() — отдельная команда после "обнови базу на сайте" не нужна.
 */

export const EMB_MODEL = "@cf/google/embeddinggemma-300m";
const META_KEY = "emb_meta";
const VEC_KEY = "emb_vec";
const LOCK_KEY = "emb_reindex_lock";
const BATCH = 50;
const MAX_TEXT = 1500;

// Префиксы задачи из документации EmbeddingGemma: без них запрос и документ кодируются
// "одинаково", и короткий запрос хуже находит длинные описания.
const QUERY_PREFIX = "task: search result | query: ";
const DOC_PREFIX = "title: none | text: ";

// Теги (tags[] из столбца «Теги» Excel) — сразу после названия: это сжатое описание темы и
// аудитории, и оно не должно отрезаться MAX_TEXT у записей с длинным описанием.
export function recordEmbedText(r) {
  return [r.name, (r.tags || []).join(", "), r.description, (r.sectors || []).join(", "), r.amount]
    .filter(Boolean)
    .join(" | ")
    .slice(0, MAX_TEXT);
}

// FNV-1a: дешёвый отпечаток текста записи — чтобы пересчитывать только изменившиеся записи.
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Аббревиатуры модель понимает хуже полных слов ("ГЭС" сама по себе ближе к случайным грантам,
// чем к энергетике) — перед эмбеддингом запроса дописываем расшифровку.
const ABBREV = [
  [/(^|[^а-яё])(микро)?гэс(?![а-яё])/i, "гидроэлектростанция, гидроэнергетика, возобновляемая энергия"],
  [/(^|[^а-яё])овз(?![а-яё])/i, "люди с ограниченными возможностями здоровья, инвалидность"],
  [/(^|[^а-яё])мсб(?![а-яё])/i, "малый и средний бизнес"],
  [/(^|[^а-яё])нко(?![а-яё])/i, "некоммерческая организация, общественный фонд"],
  [/(^|[^а-яё])(ии|ai)(?![а-яёa-z])/i, "искусственный интеллект"],
];

export function expandQuery(q) {
  const extra = ABBREV.filter(([re]) => re.test(q)).map(([, full]) => full);
  return extra.length ? `${q} (${extra.join("; ")})` : q;
}

async function embedTexts(env, texts, isQuery) {
  const prefix = isQuery ? QUERY_PREFIX : DOC_PREFIX;
  const res = await env.AI.run(EMB_MODEL, { text: texts.map((t) => prefix + t) });
  return res.data.map(normalize);
}

async function loadIndex(env) {
  const [meta, buf] = await Promise.all([
    env.FUNDING_KV.get(META_KEY, "json"),
    env.FUNDING_KV.get(VEC_KEY, "arrayBuffer"),
  ]);
  // Несовпадение длины = индекс записывается прямо сейчас (meta и vec — два разных ключа).
  if (!meta || !buf || meta.model !== EMB_MODEL || buf.byteLength !== meta.ids.length * meta.dim) return null;
  return { meta, vec: new Int8Array(buf) };
}

// Для метки "Обновлено ... · N возможностей" на сайте: дата последнего изменения базы (когда
// векторы пересчитывались из-за новых/изменённых записей) и число записей — без разбора
// всего "records" на каждую загрузку страницы.
export async function dbInfo(env) {
  const meta = await env.FUNDING_KV.get(META_KEY, "json");
  if (meta) return { count: meta.ids.length, updated_at: meta.updated_at || null };
  const records = (await env.FUNDING_KV.get("records", "json")) || [];
  return { count: records.length, updated_at: null };
}

export async function reindex(env, { force = false } = {}) {
  const records = (await env.FUNDING_KV.get("records", "json")) || [];
  const old = force ? null : await loadIndex(env);
  const oldPos = new Map();
  if (old) old.meta.ids.forEach((id, i) => oldPos.set(id, { i, h: old.meta.hashes[i] }));

  const texts = records.map(recordEmbedText);
  const hashes = texts.map(hashText);
  const todo = records.map((r, i) => i).filter((i) => {
    const o = oldPos.get(records[i].id);
    return !o || o.h !== hashes[i];
  });

  const fresh = new Map();
  for (let b = 0; b < todo.length; b += BATCH) {
    const chunk = todo.slice(b, b + BATCH);
    const vecs = await embedTexts(env, chunk.map((i) => texts[i]), false);
    chunk.forEach((i, k) => fresh.set(i, vecs[k]));
  }

  const dim = fresh.size ? fresh.values().next().value.length : old ? old.meta.dim : 0;
  if (!dim) return { total: records.length, embedded: 0 };
  const vec = new Int8Array(records.length * dim);
  records.forEach((r, i) => {
    const off = i * dim;
    const f = fresh.get(i);
    if (f) {
      for (let d = 0; d < dim; d++) vec[off + d] = Math.max(-127, Math.min(127, Math.round(f[d] * 127)));
    } else {
      const o = oldPos.get(r.id);
      vec.set(old.vec.subarray(o.i * dim, (o.i + 1) * dim), off);
    }
  });

  await env.FUNDING_KV.put(VEC_KEY, vec.buffer);
  await env.FUNDING_KV.put(
    META_KEY,
    JSON.stringify({ model: EMB_MODEL, dim, ids: records.map((r) => r.id), hashes, updated_at: new Date().toISOString() })
  );
  return { total: records.length, embedded: todo.length };
}

// Фоновый reindex не чаще раза в минуту — иначе при только что залитой базе каждый поиск
// параллельно пересчитывал бы все векторы заново.
async function scheduleReindex(env, ctx) {
  if (!ctx || (await env.FUNDING_KV.get(LOCK_KEY))) return;
  await env.FUNDING_KV.put(LOCK_KEY, "1", { expirationTtl: 60 });
  ctx.waitUntil(reindex(env).catch(() => {}));
}

// Map id → косинусная близость (≈ -1..1) для записей, у которых есть актуальный вектор.
// null — семантика недоступна (нет индекса, AI не ответил): вызывающий откатывается на поиск
// по словам, сайт при этом продолжает работать.
// allCount — сколько всего записей в "records": если меньше/больше, чем векторов, значит записи
// удалили или добавили (удаление само по себе не делает ни одну запись "устаревшей").
export async function semanticScores(env, ctx, records, q, allCount) {
  if (!env.AI) return null;
  try {
    const idx = await loadIndex(env);
    if (!idx) {
      await scheduleReindex(env, ctx);
      return null;
    }
    const { meta, vec } = idx;
    const pos = new Map(meta.ids.map((id, i) => [id, i]));
    let stale = allCount !== undefined && allCount !== meta.ids.length;
    const [qv] = await embedTexts(env, [expandQuery(q)], true);
    const dim = meta.dim;
    const out = new Map();
    for (const r of records) {
      const i = pos.get(r.id);
      if (i === undefined || meta.hashes[i] !== hashText(recordEmbedText(r))) {
        stale = true;
        continue;
      }
      let dot = 0;
      const off = i * dim;
      for (let d = 0; d < dim; d++) dot += qv[d] * vec[off + d];
      out.set(r.id, dot / 127);
    }
    if (stale) await scheduleReindex(env, ctx);
    return out.size ? out : null;
  } catch (e) {
    return null;
  }
}
