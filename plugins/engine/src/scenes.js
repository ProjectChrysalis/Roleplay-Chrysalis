export const SCENE_ENTRY_PROMPT = [
  "You turn one scene of a roleplay into a lorebook entry, so it comes back later when the story touches on it again.",
  "Write what happened and what changed: who was there, where, what was decided or promised, injuries, objects that changed hands, how the people involved now stand with each other. Past tense, third person, plain prose, at most 150 words. Use names.",
  "Also give 3 to 6 keys: names, places, objects or distinctive words that would come up when this scene matters again. {{user}} or {{char}} alone is not a key, since it would match every message.",
  'Reply with ONLY a JSON object: {"title": "a short title", "keys": ["key one", "key two"], "content": "the entry"}',
].join("\n");
/** The draft a scene request came back with, or null. A reply that is not
 *  JSON is still an entry: its text becomes the content. */
export function parseSceneReply(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const a = s.indexOf("{"), z = s.lastIndexOf("}");
  if (a >= 0 && z > a) {
    try {
      const o = JSON.parse(s.slice(a, z + 1));
      const content = String((o && o.content) || "").trim();
      if (content) {
        const keys = (Array.isArray(o.keys) ? o.keys : String(o.keys || "").split(","))
          .map((k) => String(k).trim()).filter(Boolean);
        return { title: String(o.title || "").trim().slice(0, 120), keys: [...new Set(keys)].slice(0, 8), content: content.slice(0, 4000) };
      }
    } catch {}
  }
  return { title: "", keys: [], content: s.slice(0, 4000) };
}
