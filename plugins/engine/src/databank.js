/** Split text into overlapping chunks — good enough for term-frequency
 *  retrieval without an embedding backend (basic RAG, vector-lite). */
export function chunkText(t, size = 1000, overlap = 150) {
  const parts = [];
  let i = 0;
  while (i < t.length) {
    parts.push(t.slice(i, i + size));
    if (i + size >= t.length) break;
    i += size - overlap;
  }
  return parts.filter((x) => x.trim()).map((text, n) => ({ i: n, text }));
}

export function listDatabank(fsx) {
  let names = [];
  try { names = fsx.list("databank"); } catch { return []; }
  return names
    .filter((f) => f.endsWith(".json") && !f.split("/").pop().startsWith("_"))
    .map((f) => { try { return JSON.parse(fsx.read("databank/" + f)); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

// query terms that match everything and rank nothing — without this list a
// file mentioning "the" often outranks the file actually about the query
export const DB_STOPWORDS = new Set(("the and for are but not you all any can had her was his that this with have " +
  "from they them then than there here what when where which while who whom will your into upon over under " +
  "again once only very just also been being because both each more most other some such too own same about " +
  "after before between during through above below off out up down further once she him his hers its our ours " +
  "their theirs myself yourself himself herself itself ourselves themselves").split(" "));

/** Top chunks by term density against the query — the retrieval half of the
 *  data bank (used by /databank/search AND by assemble() for injection).
 *  Score is hits per 1000 characters so a long chunk can't win on size alone;
 *  the floor (2.0) means a single glancing hit never injects — short dense
 *  chunks clear it easily, long filler does not. */
export function searchDatabank(fsx, query, limit = 3) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !DB_STOPWORDS.has(t))
    .slice(0, 32);
  if (!terms.length) return [];
  const scored = [];
  for (const file of listDatabank(fsx)) {
    if (file.enabled === false) continue;
    for (const c of file.chunks || []) {
      const low = String(c.text || "").toLowerCase();
      let hits = 0;
      for (const t of terms) {
        let i = -1, n = 0;
        while ((i = low.indexOf(t, i + 1)) >= 0 && n < 50) n++;
        hits += n;
      }
      if (hits > 0) {
        const score = Math.round((hits * 1000) / Math.max(200, low.length) * 10) / 10;
        if (score >= 2.0) scored.push({ fileId: file.id, fileName: file.name, chunkIndex: c.i, text: c.text, score });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
