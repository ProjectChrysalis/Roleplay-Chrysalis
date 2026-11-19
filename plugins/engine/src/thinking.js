const THINKING_FIELDS = ["reasoning", "reasoningMs", "parts", "tools", "replay"];
export function syncSwipeThinking(msg, overwrite = true) {
  const extra = { ...msg.extra };
  const count = msg.swipes?.length || 1;
  extra.swipeMeta = Array.from({ length: count }, (_, i) => extra.swipeMeta?.[i] ?? null);
  if (!overwrite && extra.swipeMeta[msg.swipe || 0] != null) return { ...msg, extra };
  const own = { ...extra.swipeMeta[msg.swipe || 0] };
  for (const key of THINKING_FIELDS) {
    if (extra[key] === undefined) delete own[key];
    else own[key] = extra[key];
  }
  for (const key of ["model", "usage", "genMs", "params", "presetName", "createdAt", "startedAt", "finishedAt", "continuations", "sourceInfo"]) if (extra[key] !== undefined) own[key] = extra[key];
  extra.swipeMeta[msg.swipe || 0] = own;
  return { ...msg, extra };
}
export function restoreSwipeThinking(extra, index) {
  const next = { ...extra };
  for (const key of [...THINKING_FIELDS, "model", "usage", "genMs", "params", "presetName", "createdAt", "startedAt", "finishedAt", "continuations", "sourceInfo"]) delete next[key];
  const own = extra?.swipeMeta?.[index];
  if (own) {
    for (const key of THINKING_FIELDS) if (own[key] !== undefined) next[key] = own[key];
    for (const key of ["model", "usage", "genMs", "params", "presetName", "createdAt", "startedAt", "finishedAt", "continuations", "sourceInfo"]) if (own[key] !== undefined) next[key] = own[key];
  }
  return next;
}
// Signed blocks cannot be reused after their thinking has changed.
export function editReplayThinking(replay, text, thinkingIndex) {
  if (!Array.isArray(replay?.messages)) return undefined;
  let index = 0;
  let inserted = false;
  const messages = replay.messages.map((m) => {
    if (m.role !== "assistant") return m;
    const content = m.content.flatMap((block) => {
      const { thinkingSignature, textSignature, thoughtSignature, ...clean } = block;
      if (block.type !== "thinking") return [clean];
      if (block.redacted) return [];
      if (text === undefined) return [clean];
      const current = block.thinking?.trim() ? index++ : -1;
      if (thinkingIndex !== undefined && current !== thinkingIndex) return [clean];
      if (!text.trim() || (thinkingIndex === undefined && inserted)) return [];
      inserted = true;
      return [{ type: "thinking", thinking: text }];
    });
    return { ...m, content };
  });
  if (typeof text === "string" && text.trim() && !inserted && thinkingIndex === undefined) {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (last) last.content.unshift({ type: "thinking", thinking: text });
  }
  return { ...replay, messages };
}

export function continuedSwipeMeta(original, continuation) {
  return { ...continuation, createdAt: original?.createdAt, startedAt: original?.startedAt,
    finishedAt: original?.finishedAt, sourceInfo: original?.sourceInfo,
    continuations: [...(original?.continuations || []), continuation] };
}
/** Puts the preset's prefill back on a committed reply. A prefill that leaves
 *  a think block open (e.g. "<think>") hands that block to the model, whose
 *  thinking comes back already split from the answer: the text before the tag
 *  starts the message and the text after it starts the reasoning. Servers
 *  that echo the prefill are detected, not doubled. */
export function withPrefill(text, reply, preset) {
  const prefill = reply.assistantPrefill;
  if (!prefill) return text;
  let head = prefill;
  const tags = presetThinkTags(preset);
  if (tags) {
    const at = prefill.lastIndexOf(tags.open);
    if (at >= 0 && at > prefill.lastIndexOf(tags.close)) {
      head = prefill.slice(0, at);
      const seed = prefill.slice(at + tags.open.length).trim();
      if (seed && !String(reply.reasoning || "").startsWith(seed)) {
        reply.reasoning = reply.reasoning ? seed + " " + reply.reasoning : seed;
        let seeded = false;
        if (Array.isArray(reply.parts)) reply.parts = reply.parts.map((p) => {
          if (seeded || p.type !== "thinking") return p;
          seeded = true;
          return { ...p, text: seed + " " + p.text };
        });
      }
    }
  }
  if (!head.trim()) return text;
  return text.startsWith(head) ? text : head + text;
}
/** The inline think tags a preset parses, or null. Presets saved while
 *  reasoning was switched off carry the tags only in their sampler settings. */
export function presetThinkTags(preset) {
  const tags = preset && preset.reasoningTags;
  if (tags && typeof tags.open === "string" && tags.open && typeof tags.close === "string" && tags.close) return { open: tags.open, close: tags.close };
  const r = preset && preset.studio && preset.studio.samplers && preset.studio.samplers.reasoning;
  if (r && r.autoParse && typeof r.thinkTagOpen === "string" && r.thinkTagOpen && typeof r.thinkTagClose === "string" && r.thinkTagClose) return { open: r.thinkTagOpen, close: r.thinkTagClose };
  return null;
}
