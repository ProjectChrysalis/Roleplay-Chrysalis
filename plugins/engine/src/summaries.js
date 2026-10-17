// Used when settings.json carries no summary prompt of its own.
export const DEFAULT_SUMMARY_PROMPT = "You keep notes on a roleplay between {{user}} and {{char}}. Summarize only the messages you are given. Earlier summaries are context: do not repeat what they already say. Keep names, relationships, promises, places, possessions, injuries, and unresolved threads; drop small talk and repetition. Past tense, third person, plain prose, at most {{words}} words. Reply with only the summary.";
// How the default began when one summary was rewritten on every compaction.
// A settings file still carrying it gets the current default instead: that
// wording asks for the whole story again, which is what parts avoid.
export const RETIRED_SUMMARY_PROMPT = "You keep the running summary of a roleplay between {{user}} and {{char}}. Rewrite it so it covers everything so far";
export const MERGE_SUMMARY_PROMPT = "These are consecutive summaries of one roleplay, oldest first. Combine them into a single summary. Keep names, relationships, promises, places, possessions, injuries, and unresolved threads, and keep events in order; add nothing new. Past tense, third person, plain prose, at most {{words}} words. Reply with only the summary.";
export const countWords = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
/** A chat's summaries, oldest first. Each covers its own stretch of messages
 *  (`from` up to, not including, `to`) and is written once: a later
 *  compaction adds a part, it never rewrites one. meta.summary is always
 *  their text joined, which is what the prompt and {{summary}} read. A
 *  summary written straight into meta.summary (an older chat, or an edit on
 *  disk) counts as one part. */
export function summaryParts(meta) {
  const parts = (Array.isArray(meta.summaryParts) ? meta.summaryParts : [])
    .filter((p) => p && typeof p.text === "string" && p.text.trim());
  const flat = String(meta.summary || "").trim();
  if (flat === parts.map((p) => p.text.trim()).join("\n\n")) return parts;
  return flat ? [{ id: "s0", text: flat }] : [];
}
export function setSummaryParts(meta, parts) {
  const clean = parts.filter((p) => p && typeof p.text === "string" && p.text.trim());
  if (clean.length) meta.summaryParts = clean; else delete meta.summaryParts;
  meta.summary = clean.map((p) => p.text.trim()).join("\n\n");
}
