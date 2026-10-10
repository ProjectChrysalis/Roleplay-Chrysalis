// .agents/lib/data-tools.js
var definitions = {
  character: { directory: "characters", template: "_character", fields: ["/description", "/personality", "/scenario"], card: true },
  persona: { directory: "personas", template: "_persona", fields: ["/description", "/pronouns", "/binding"] },
  lorebook: { directory: "lorebooks", template: "_lorebook", fields: ["/settings", "/globalActive"], items: "entries" },
  regex: { directory: "regex", template: "_regex", fields: ["/findRegex", "/replaceString", "/flags", "/placement", "/scope", "/disabled", "/markdownOnly", "/promptOnly"] },
  group: { directory: "groups", template: "_group", fields: ["/memberIds", "/mutedIds", "/mode", "/generationMode"] },
  chat: { directory: "chats", fields: ["/characterId", "/groupId", "/personaId", "/presetId", "/authorNote", "/lorebookIds"] },
  settings: { single: "settings.json", fields: ["/model", "/personaId"] },
  library: { single: "library.json", fields: [] },
  databank: { directory: "databank", template: "_databank", fields: ["/scope", "/scopeTargetId", "/enabled", "/size"], items: "chunks" }
};
var idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
var forbidden = new Set(["__proto__", "prototype", "constructor"]);
var own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function terms(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function matches(query, record, id) {
  if (String(query) === String(id))
    return true;
  const wanted = terms(query), words = terms([record.name, record.title, record.scriptName, record.memo].filter(Boolean).join(" "));
  return wanted.length > 0 && wanted.every((term) => words.some((word) => word.startsWith(term)));
}
function keys(pointer) {
  if (typeof pointer !== "string" || pointer && !pointer.startsWith("/"))
    throw new Error("Fields use JSON pointers, for example /ui/theme");
  return pointer ? pointer.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~")).map((key) => {
    if (forbidden.has(key))
      throw new Error("Unsafe field");
    return key;
  }) : [];
}
function valueAt(record, pointer) {
  return keys(pointer).reduce((value, key) => value && own(value, key) ? value[key] : undefined, record);
}
function selectedFields(record, fields) {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string"))
    throw new Error("fields must be JSON pointers");
  const values = {}, missing = [];
  for (const field of fields) {
    const value = valueAt(record, field);
    if (value === undefined)
      missing.push(field);
    else
      values[field] = value;
  }
  return { values, missing };
}
function read(host, file) {
  const { text, revision } = host.fs.readVersioned(file);
  return { file, text, revision, record: JSON.parse(text) };
}
function records(kind, args, host) {
  const spec = definitions[kind];
  if (!spec)
    throw new Error("Unknown entity kind");
  if (spec.single)
    return [read(host, spec.single)];
  let names = host.fs.list(spec.directory).filter((name) => !name.startsWith("_") && (spec.card || (kind === "chat" ? name.endsWith(".meta.json") : name.endsWith(".json"))));
  if (args.query && idPattern.test(args.query)) {
    const exact = args.query + (spec.card ? "" : kind === "chat" ? ".meta.json" : ".json");
    if (names.includes(exact))
      names = [exact];
  }
  return names.map((name) => {
    const id = kind === "chat" ? name.slice(0, -10) : spec.card ? name : name.slice(0, -5);
    const file = spec.directory + "/" + (spec.card ? id + "/card.json" : name);
    try {
      const result = read(host, file);
      result.id = id;
      return result;
    } catch (error) {
      return { file, id, error: String(error.message ?? error) };
    }
  }).filter((row) => !args.query || (row.record ? matches(args.query, row.record, row.id) : String(args.query) === row.id));
}
function itemId(item) {
  return item.id ?? item.uid ?? item.i;
}
function itemRows(row, spec, args) {
  const collection = args.collection ?? spec.items;
  if (!collection)
    return null;
  if (forbidden.has(collection) || !Array.isArray(row.record[collection]))
    throw new Error("Collection is not an array: " + collection);
  return { collection, entries: row.record[collection].filter((item) => args.item === undefined || matches(args.item, item, itemId(item))) };
}
function page(args) {
  const offset = args.offset ?? 0, limit = args.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("offset must be nonnegative and limit 1 to 50");
  return { offset, limit };
}
function argumentsFor(kind, args, editing) {
  const allowed = new Set(["query", kind, "fields", "collection", "item", "offset", "limit", ...kind === "chat" ? ["message", "messages"] : [], ...editing ? ["operation", "id", "revision", "transcriptRevision", "patch", ...kind === "databank" ? ["content"] : []] : []]);
  for (const key of Object.keys(args))
    if (!allowed.has(key))
      throw new Error("Unknown argument: " + key + ". Use query for the target, fields for inspection, and patch for changes.");
  if (args.query !== undefined && args[kind] !== undefined && args.query !== args[kind])
    throw new Error("Conflicting target names");
  const query = args.query ?? args[kind];
  if (query !== undefined && (typeof query !== "string" || !query.trim()))
    throw new Error("query must be a nonempty name or ID");
  return { ...args, query };
}
function inspectData(kind, args, host) {
  args = argumentsFor(kind, args, false);
  const spec = definitions[kind], { offset, limit } = page(args);
  const all = records(kind, args, host), errors = all.filter((row) => row.error).map(({ file, error }) => ({ file, error }));
  const found = all.filter((row) => row.record);
  const recordOffset = args.query || spec.single ? 0 : offset;
  const results = found.slice(recordOffset, recordOffset + limit).map((row) => {
    const record = row.record;
    const out = { id: row.id ?? record.id ?? kind, name: record.name ?? record.title ?? record.scriptName ?? kind, file: row.file, revision: row.revision };
    if (args.query || spec.single)
      Object.assign(out, selectedFields(record, args.fields ?? spec.fields));
    if (kind === "library" && !args.collection)
      out.collections = Object.entries(record).filter(([, value]) => Array.isArray(value)).map(([name, value]) => ({ name, count: value.length }));
    if ((args.query || spec.single) && (spec.items || args.collection)) {
      const items = itemRows(row, spec, args);
      out.itemCount = items.entries.length;
      out.items = items.entries.slice(args.item === undefined ? offset : 0, (args.item === undefined ? offset : 0) + limit).map((item) => args.item !== undefined ? item : { id: itemId(item), name: item.title ?? item.name ?? item.scriptName ?? item.memo ?? null, enabled: item.enabled ?? null });
      out.itemsMore = items.entries.length > (args.item === undefined ? offset : 0) + limit;
    }
    if (kind === "chat" && (args.message !== undefined || args.messages)) {
      const transcript = host.fs.readVersioned("chats/" + row.id + ".jsonl");
      const messages = transcript.text.split(`
`).filter((line) => line.trim()).map((line) => JSON.parse(line));
      const selected = args.message === undefined ? messages : messages.filter((message) => String(message.id) === String(args.message));
      out.transcriptRevision = transcript.revision;
      out.messageCount = messages.length;
      out.messages = selected.slice(args.message === undefined ? offset : 0, (args.message === undefined ? offset : 0) + limit);
      out.messagesMore = selected.length > offset + limit;
    }
    return out;
  });
  return {
    kind,
    totalMatches: found.length,
    ambiguous: found.length > 1,
    results,
    errors,
    more: found.length > recordOffset + limit,
    guidance: found.length > 1 ? "Choose an exact ID before editing. Do not infer the current selection from unrelated bindings." : null
  };
}

// .agents/skills/chat-editing/inspect.source.js
function inspect(args, host) {
  return inspectData("chat", args, host);
}
export {
  inspect
};
