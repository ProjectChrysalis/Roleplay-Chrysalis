import { strHash } from "./macros.js";

// split on natural boundaries (paragraph, line, sentence, word) so chunks
// translate cleanly and concatenate back to the original
/** Cosine similarity of two equal-length vectors; null on shape mismatch. */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / Math.sqrt(na * nb);
}
/** Embedding availability probe, cached: when no connection can embed we
 *  stop paying the extra pass on every send. Re-probes hourly. */
export function embedCap(fsx) {
  try {
    const st = JSON.parse(fsx.read("embed-status.json"));
    if (st && st.ok === false && Date.now() - (st.checkedAt || 0) < 3600e3) return false;
    return true;
  } catch { return true; }
}
export function setEmbedCap(fsx, ok) {
  try { fsx.write("embed-status.json", JSON.stringify({ ok: ok === true, checkedAt: Date.now() }, null, 2)); } catch {}
}
/** Vectorized world-info entries keep their embeddings in a sidecar cache
 *  keyed book#uid, invalidated by content hash. */
export function loadWiVectors(fsx) {
  try {
    const m = JSON.parse(fsx.read("lorebooks/.vectors.json"));
    return m && typeof m === "object" ? m : {};
  } catch { return {}; }
}
function saveWiVectors(fsx, map) {
  try { fsx.write("lorebooks/.vectors.json", JSON.stringify(map, null, 2)); } catch {}
}
function wiVectorKey(book, entry, i) { return (book.id || book.name) + "#" + (entry.uid ?? i); }

/** The books in a chat's scope, read by id. A scope may still name a book
 *  by its name, and only then is the whole folder read to find it. Books
 *  come back in file name order. */
export function loadBoundBooks(fsx, bound) {
  const books = new Map();
  const unresolved = new Set();
  for (const key of bound) {
    if (typeof key !== "string" || !key) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(key)) {
      try {
        const book = JSON.parse(fsx.read("lorebooks/" + key + ".json"));
        if (book && (book.id || book.name) === key) { books.set(key + ".json", book); continue; }
      } catch { /* not stored under its id */ }
    }
    unresolved.add(key);
  }
  if (unresolved.size) {
    let files = [];
    try { files = fsx.list("lorebooks").filter((f) => f.endsWith(".json") && !books.has(f)); } catch {}
    for (const f of files) {
      try {
        const book = JSON.parse(fsx.read("lorebooks/" + f));
        if (book && unresolved.has(book.id || book.name)) books.set(f, book);
      } catch { /* unreadable book */ }
    }
  }
  return [...books.keys()].sort().map((f) => books.get(f));
}

/** Semantic prep shared by send/peek: the bound books' vectorized entries
 *  that lack a cached vector. Returns null when there are none, and no
 *  embedding pass is paid for. */
export function semanticEmbedWork(fsx, meta, extraBookIds) {
  const vecMap = loadWiVectors(fsx);
  const needed = [];
  const bound = new Set([...(meta.lorebookIds || []), ...(meta.chatLorebookIds || []), ...(extraBookIds || [])]);
  const books = loadBoundBooks(fsx, bound);
  for (const book of books) {
    (book.entries || []).forEach((entry, i) => {
      if (entry.enabled === false) return;
      const isVec = entry.vectorized === true || entry.status === "vectorized";
      if (!isVec) return;
      const key = wiVectorKey(book, entry, i);
      const cached = vecMap[key];
      const hash = strHash(String(entry.content || "") + "|" + String(entry.keys || ""));
      if (cached && cached.hash === hash && Array.isArray(cached.vector)) return;
      const text = String(entry.content || "").trim() + "\n" + (entry.keys || []).join(", ");
      if (text.trim()) needed.push({ key, hash, text });
    });
  }
  if (!needed.length) return null;
  return { needed };
}
/** Store freshly embedded entry vectors into the sidecar cache. */
export function cacheWiVectorBatch(fsx, entries, vectors) {
  if (!Array.isArray(entries) || !Array.isArray(vectors)) return;
  const map = loadWiVectors(fsx);
  entries.forEach((e, i) => {
    if (e && vectors[i] && Array.isArray(vectors[i])) map[e.key] = { hash: e.hash, vector: vectors[i] };
  });
  saveWiVectors(fsx, map);
}
