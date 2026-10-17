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
  for (const key of ["model", "usage", "genMs", "params", "presetName"]) if (extra[key] !== undefined) own[key] = extra[key];
  extra.swipeMeta[msg.swipe || 0] = own;
  return { ...msg, extra };
}
export function restoreSwipeThinking(extra, index) {
  const next = { ...extra };
  for (const key of [...THINKING_FIELDS, "model", "usage", "genMs", "params", "presetName"]) delete next[key];
  const own = extra?.swipeMeta?.[index];
  if (own) {
    for (const key of THINKING_FIELDS) if (own[key] !== undefined) next[key] = own[key];
    for (const key of ["model", "usage", "genMs", "params", "presetName"]) if (own[key] !== undefined) next[key] = own[key];
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
