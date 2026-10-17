export function chatSearchTerms(query) {
  return Array.from(new Set((String(query).toLowerCase().match(/"[^"]+"|[^\s"]+/g) || [])
    .map((term) => term.replace(/^"|"$/g, "").trim()).filter(Boolean)));
}

export function searchChatLibrary(fsx, options) {
  const terms = chatSearchTerms(options.query);
  const mode = options.mode || "all";
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 30)));
  const errors = [];
  const metas = fsx.list("chats").filter((f) => f.endsWith(".meta.json")).map((file) => {
    try { return JSON.parse(fsx.read("chats/" + file)); }
    catch { errors.push({ chatId: file.replace(/\.meta\.json$/, ""), error: "Unreadable chat details" }); return null; }
  }).filter((meta) => meta && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(meta.id)
    && (!options.folderId || meta.folderId === options.folderId)
    && (!options.characterId || (meta.groupId || meta.characterId) === options.characterId))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
  const names = new Map();
  const results = [];
  let total = 0;
  for (const meta of metas) {
    const ownerId = meta.groupId || meta.characterId;
    if (!names.has(ownerId)) {
      let name = "";
      try { name = JSON.parse(fsx.read("characters/" + meta.characterId + "/card.json")).name || ""; } catch {}
      if (!name && meta.groupId) { try { name = JSON.parse(fsx.read("groups/" + meta.groupId + ".json")).name || ""; } catch {} }
      names.set(ownerId, name);
    }
    const fields = mode === "messages" ? [] : [meta.title, names.get(ownerId)];
    const found = new Set();
    for (const term of terms) if (fields.some((field) => String(field || "").toLowerCase().includes(term))) found.add(term);
    let matchCount = 0;
    let messageCount = 0;
    let preview = "";
    const snippets = [];
    let unreadable = false;
    if (mode !== "titles" || terms.every((term) => found.has(term))) {
      let transcript;
      try { transcript = fsx.read("chats/" + meta.id + ".jsonl"); }
      catch { errors.push({ chatId: meta.id, error: "Transcript unavailable" }); continue; }
      for (const line of transcript.split("\n")) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { if (!unreadable) errors.push({ chatId: meta.id, error: "Unreadable message" }); unreadable = true; continue; }
        messageCount++;
        const active = Array.isArray(message.swipes) ? message.swipes[message.swipe ?? 0] : undefined;
        const text = typeof active === "string" ? active : typeof active?.text === "string" ? active.text : typeof active?.content === "string" ? active.content : String(message.text || "");
        preview = text.slice(0, 160);
        if (mode === "titles" || message.picture === true) continue;
        const lower = text.toLowerCase();
        const hits = terms.filter((term) => lower.includes(term));
        if (!hits.length) continue;
        hits.forEach((term) => found.add(term));
        matchCount++;
        const at = Math.min(...hits.map((term) => lower.indexOf(term)));
        const start = Math.max(0, at - 70);
        const snippet = (start ? "…" : "") + text.slice(start, start + 240) + (text.length > start + 240 ? "…" : "");
        snippets.push({ messageId: message.id || null, text: snippet, role: message.role || "char" });
        if (snippets.length > 3) snippets.shift();
      }
    }
    if (!terms.every((term) => found.has(term))) continue;
    total++;
    if (total > offset && results.length < limit) results.push({ meta: { ...meta, messageCount, preview }, matchCount, snippets });
  }
  return { total, offset, limit, results, errors };
}
