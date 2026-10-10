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
var clone = (value) => JSON.parse(JSON.stringify(value));
function terms(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function matches(query, record, id) {
  if (String(query) === String(id))
    return true;
  const wanted = terms(query), words = terms([record.name, record.title, record.scriptName, record.memo].filter(Boolean).join(" "));
  return wanted.length > 0 && wanted.every((term) => words.some((word) => word.startsWith(term)));
}
function merge(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("patch must be an object");
  for (const [key, value] of Object.entries(patch)) {
    if (forbidden.has(key))
      throw new Error("Unsafe field");
    if (key.startsWith("/"))
      throw new Error("patch uses stored property names, for example {disabled:true}; JSON pointers are only for inspection fields");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (target[key] !== undefined && target[key] !== null && (typeof target[key] !== "object" || Array.isArray(target[key])))
        throw new Error("Field type changed: " + key);
      if (!target[key])
        target[key] = {};
      merge(target[key], value);
    } else {
      if (target[key] !== undefined && target[key] !== null && value !== null && (typeof target[key] !== typeof value || Array.isArray(target[key]) !== Array.isArray(value)))
        throw new Error("Field type changed: " + key);
      target[key] = clone(value);
    }
  }
  return target;
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
function assertRevision(expected, row) {
  if (expected !== row.revision)
    throw new Error("Record changed or revision missing. Inspect the target again.");
}
function assertReferences(kind, record, host) {
  const reference = (directory, id) => {
    if (typeof id !== "string" || !idPattern.test(id))
      throw new Error("Invalid reference ID");
    return directory + "/" + id + (directory === "characters" ? "/card.json" : directory === "chats" ? ".meta.json" : ".json");
  };
  const references = [];
  if (kind === "group")
    for (const id of record.memberIds ?? [])
      references.push(reference("characters", id));
  if (kind === "chat") {
    for (const [key, directory] of [["characterId", "characters"], ["groupId", "groups"], ["personaId", "personas"], ["presetId", "presets"]])
      if (record[key])
        references.push(reference(directory, record[key]));
  }
  if (kind === "settings" && record.personaId)
    references.push(reference("personas", record.personaId));
  if (kind === "persona")
    for (const id of record.boundCharacterIds ?? [])
      references.push(reference("characters", id));
  if (["persona", "chat"].includes(kind))
    for (const id of record.lorebookIds ?? [])
      references.push(reference("lorebooks", id));
  if (kind === "character") {
    for (const id of record.studio?.linkedLorebookIds ?? [])
      references.push(reference("lorebooks", id));
    if (record.studio?.embeddedLorebookId)
      references.push(reference("lorebooks", record.studio.embeddedLorebookId));
    for (const id of record.studio?.characterRegexIds ?? [])
      references.push(reference("regex", id));
  }
  if (kind === "lorebook")
    for (const id of record.linkedCharacterIds ?? [])
      references.push(reference("characters", id));
  if (["regex", "databank"].includes(kind)) {
    const scopes = kind === "regex" ? ["global", "character", "chat", "preset"] : ["global", "character", "chat"];
    const scope = record.scope ?? "global";
    if (!scopes.includes(scope))
      throw new Error("Invalid scope");
    if (scope !== "global") {
      if (!record.scopeTargetId)
        throw new Error("Scoped record needs scopeTargetId");
      references.push(reference({ character: "characters", chat: "chats", preset: "presets" }[scope], record.scopeTargetId));
    }
  }
  for (const file of references)
    host.fs.read(file);
  if (kind === "group" && (record.mutedIds ?? []).some((id) => !record.memberIds.includes(id)))
    throw new Error("Muted IDs must be group members");
  if (kind === "lorebook") {
    for (const entry of record.entries ?? [])
      if (entry.status !== undefined && !["normal", "constant", "vectorized"].includes(entry.status))
        throw new Error("Invalid lore entry status");
  }
  if (kind === "regex" && record.findRegex && !record.findRegex.includes("{{")) {
    const literal = record.findRegex.match(/^\/(.*)\/([a-z]*)$/s);
    new RegExp(literal ? literal[1] : record.findRegex, record.flags || (literal ? literal[2] : ""));
  }
  if (kind === "lorebook") {
    const ids = record.entries.map(itemId);
    if (ids.some((id) => id === undefined) || new Set(ids.map(String)).size !== ids.length)
      throw new Error("Lore entries need unique IDs");
  }
}
function serialize(row) {
  return { path: row.file, expectedRevision: row.revision, content: JSON.stringify(row.record, null, 2) + `
` };
}
function setDocument(record, content) {
  if (typeof content !== "string" || !content.trim() || content.length > 2 * 1024 * 1024)
    throw new Error("Provide nonempty document content under 2 MB");
  const chunks = [];
  for (let i = 0;i < content.length; i += 850) {
    const text = content.slice(i, i + 1000);
    if (text.trim())
      chunks.push({ i: chunks.length, text });
    if (i + 1000 >= content.length)
      break;
  }
  record.chunks = chunks;
  record.size = content.length;
}
function editData(kind, args, host) {
  args = argumentsFor(kind, args, true);
  const spec = definitions[kind], operation = args.operation ?? "patch";
  if (kind === "regex" && ["name", "find", "replace", "placements", "enabled"].some((key) => own(args.patch ?? {}, key)))
    throw new Error("Regex data uses scriptName, findRegex, replaceString, placement, and disabled; inspect the stored shape");
  if (kind === "persona" && own(args.patch ?? {}, "isDefault"))
    throw new Error("Default persona selection belongs in settings.json personaId");
  if (operation === "patch" && args.content === undefined && (!args.patch || !Object.keys(args.patch).length))
    throw new Error("Provide the fields to change");
  if (operation === "create") {
    if (!spec.template || !idPattern.test(args.id ?? ""))
      throw new Error("Creation needs a unique ID and an entity template; chat creation uses its app route");
    const record = JSON.parse(host.fs.read("_templates/" + spec.template + ".json"));
    delete record._note;
    if (!spec.card)
      record.id = args.id;
    if (kind === "lorebook")
      record.entries = [];
    if (kind === "group") {
      record.memberIds = [];
      record.mutedIds = [];
    }
    if (kind === "persona") {
      record.boundCharacterIds = [];
      record.lorebookIds = [];
      record.isDefault = false;
    }
    if (kind === "databank") {
      record.chunks = [];
      record.size = 0;
      record.addedAt = Date.now();
    }
    if (own(record, "createdAt"))
      record.createdAt = Date.now();
    if (record.studio && own(record.studio, "createdAt"))
      record.studio.createdAt = Date.now();
    merge(record, args.patch ?? {});
    if (kind === "databank")
      setDocument(record, args.content);
    if (record.id !== undefined && record.id !== args.id)
      throw new Error("ID must match the new file");
    assertReferences(kind, record, host);
    const file = spec.directory + "/" + args.id + (spec.card ? "/card.json" : ".json");
    return { writes: [{ path: file, expectedRevision: null, content: JSON.stringify(record, null, 2) + `
` }], result: { kind, id: args.id, operation } };
  }
  if (!args.query && !spec.single)
    throw new Error("Choose an exact record ID or unique name");
  const rows = records(kind, args, host).filter((row2) => row2.record);
  if (rows.length !== 1)
    throw new Error("Edit needs exactly one matching record");
  const row = rows[0];
  assertRevision(args.revision, row);
  if (kind === "databank" && (args.item !== undefined || own(args.patch ?? {}, "chunks") || own(args.patch ?? {}, "size")))
    throw new Error("Provide document content instead of editing chunks or measured size directly");
  if (kind === "databank" && args.content !== undefined)
    setDocument(row.record, args.content);
  if (kind === "chat" && args.message !== undefined) {
    const file = "chats/" + row.id + ".jsonl", version = host.fs.readVersioned(file);
    if (args.transcriptRevision !== version.revision)
      throw new Error("Transcript changed or revision missing. Inspect the message again.");
    const messages = version.text.split(`
`).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const targets = messages.filter((message2) => String(message2.id) === String(args.message));
    if (targets.length !== 1 || operation !== "patch")
      throw new Error("Choose one existing message to patch; structural chat changes use app routes");
    const message = targets[0], patch = args.patch ?? {};
    if (Object.keys(patch).some((key) => !["text", "hidden", "bookmarked", "bookmarkLabel", "translation", "extra"].includes(key)))
      throw new Error("Use chat routes for message identity, role, ordering, or swipe selection");
    if (own(patch, "text") && (typeof patch.text !== "string" || !patch.text.trim()))
      throw new Error("Message text must be nonempty");
    if (own(patch, "text") && message.swipes?.length && (!Number.isInteger(message.swipe) || message.swipe < 0 || message.swipe >= message.swipes.length))
      throw new Error("Invalid active swipe; repair it through the chat UI first");
    merge(message, patch);
    if (own(patch, "text")) {
      const swipes = message.swipes?.length ? message.swipes.slice() : [message.text];
      swipes[message.swipe ?? 0] = message.text;
      message.swipes = swipes;
      message.edited = true;
      delete message.translation;
    }
    row.record.updatedAt = Date.now();
    row.record.tainted = true;
    return { writes: [{ path: file, expectedRevision: version.revision, content: messages.map((message2) => JSON.stringify(message2)).join(`
`) + `
` }, serialize(row)], result: { kind, id: row.id, message: args.message, operation } };
  }
  const items = itemRows(row, spec, args);
  let target = row.record;
  if (args.item !== undefined || ["add-item", "remove-item"].includes(operation)) {
    if (!items)
      throw new Error("This entity has no item collection");
    if (operation === "add-item") {
      let item = clone(args.patch ?? {});
      if (kind === "lorebook") {
        const template = JSON.parse(host.fs.read("_templates/_lorebook.json"));
        item = merge({ ...clone(template.entries[0]), title: "New entry", memo: "", keys: [], secondaryKeys: [], content: "" }, item);
        if (!own(args.patch ?? {}, "uid"))
          delete item.uid;
      }
      if (kind === "lorebook" && item.uid === undefined && item.id === undefined)
        item.uid = Math.max(0, ...row.record.entries.map((entry) => Number(entry.uid) || 0)) + 1;
      if (itemId(item) === undefined || row.record[items.collection].some((entry) => String(itemId(entry)) === String(itemId(item))))
        throw new Error("New item needs a unique ID");
      row.record[items.collection].push(item);
    } else {
      if (items.entries.length !== 1)
        throw new Error("Choose one item by ID or unique name");
      target = items.entries[0];
      if (operation === "remove-item")
        row.record[items.collection] = row.record[items.collection].filter((item) => item !== target);
      else {
        if (operation !== "patch")
          throw new Error("Unknown edit operation");
        if (["id", "uid", "i"].some((key) => own(args.patch ?? {}, key)))
          throw new Error("Do not change item IDs");
        merge(target, args.patch ?? {});
      }
    }
  } else {
    if (operation !== "patch")
      throw new Error("Unknown edit operation");
    merge(target, args.patch ?? {});
  }
  if (target === row.record && args.patch && own(args.patch, "id"))
    throw new Error("Do not change record IDs");
  assertReferences(kind, row.record, host);
  if (kind === "chat")
    row.record.updatedAt = Date.now();
  return { writes: [serialize(row)], result: { kind, id: row.id ?? kind, operation, item: args.item ?? null } };
}

// .agents/skills/persona-editing/edit.source.js
function edit(args, host) {
  return editData("persona", args, host);
}
export {
  edit
};
