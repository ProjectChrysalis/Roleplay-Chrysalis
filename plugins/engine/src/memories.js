import { DB_STOPWORDS } from "./databank.js";
import { uid } from "./util.js";

export function loadMemories(fsx, chatId) {
  try {
    const arr = JSON.parse(fsx.read("chats/" + chatId + ".memories.json"));
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.text === "string" && e.text.trim()) : [];
  } catch { return []; }
}
export function saveMemories(fsx, chatId, list) {
  fsx.write("chats/" + chatId + ".memories.json", JSON.stringify(list, null, 2) + "\n");
}
/** Which memories ride the prompt: pinned entries always, the rest by the
 *  words they share with the recent window (the same retrieval family as
 *  the data bank) with importance breaking ties, inside a character budget.
 *  Words only, on purpose: facts are short and few, and matching them by
 *  meaning cost an embedding call on every send. */
export function recallMemories(list, scanText, budgetChars, maxEntries) {
  const low = String(scanText || "").toLowerCase();
  const picked = list.filter((e) => e.pinned === true);
  let used = picked.reduce((a, e) => a + e.text.length, 0);
  const scored = [];
  for (const e of list) {
    if (e.pinned === true) continue;
    const imp = typeof e.importance === "number" ? e.importance : 3;
    const words = String(e.text).toLowerCase().match(/[a-z0-9']{4,}/g) || [];
    const keys = [...new Set(words.filter((w) => !DB_STOPWORDS.has(w)))];
    const hits = keys.length ? keys.filter((w) => low.includes(w)).length : 0;
    if (hits > 0) scored.push({ e, score: hits * 10 + imp });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { e } of scored) {
    if (picked.length >= maxEntries || used + e.text.length > budgetChars) break;
    picked.push(e);
    used += e.text.length;
  }
  return picked;
}
/** Extraction prompt for the vault: durable facts only, JSON array reply. */
export function memoryExtractPrompt(transcript) {
  return [
    "You maintain the long-term memory of a roleplay chat. From the transcript below, extract durable facts worth recalling in later scenes: character traits, relationships, promises, obligations, injuries, possessions, places, world facts, ongoing plans.",
    "Skip fleeting dialogue, mood, style, and anything a one-paragraph summary would already cover. Each fact is one short standalone sentence, third person.",
    'Reply with ONLY a JSON array, at most 8 entries, like:',
    '[{"text": "Ember promised to guard the traveler map.", "importance": 4}]',
    "importance runs 1 (trivia) to 5 (plot-critical). If nothing qualifies, reply [].",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}
export function parseMemoriesReply(text) {
  const s = String(text || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((e) => e && typeof e === "object" ? {
        text: String(e.text || "").trim().slice(0, 500),
        importance: Math.min(5, Math.max(1, Math.floor(Number(e.importance)) || 3)),
      } : null)
      .filter((e) => e && e.text);
  } catch { return []; }
}
/** Append extracted facts, dropping near-duplicates of what the vault holds. */
export function mergeMemories(existing, incoming) {
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = [...existing];
  const added = [];
  for (const inc of incoming) {
    const n = norm(inc.text);
    if (!n) continue;
    const dup = out.some((e) => { const m = norm(e.text); return m === n || m.includes(n) || n.includes(m); });
    if (dup) continue;
    const entry = { id: uid("mem"), text: inc.text, importance: inc.importance, pinned: false, at: Date.now() };
    out.push(entry);
    added.push(entry);
  }
  return { list: out, added };
}

export function memoryTranscript(msgs, window) {
  return msgs.slice(-window)
    .filter((m) => (m.role === "user" || m.role === "char") && m.hidden !== true)
    .map((m) => (m.role === "user" ? "User" : (m.name || "Character")) + ": " + String(m.text || "").slice(0, 2000))
    .join("\n");
}
