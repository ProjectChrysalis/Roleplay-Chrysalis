import { expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const app = path.resolve(import.meta.dir, "..");
function fixture() {
  const templates = Object.fromEntries(fs.readdirSync(path.join(app, "data/_templates")).filter((file) => file.endsWith(".json")).map((file) => ["_templates/" + file, fs.readFileSync(path.join(app, "data/_templates", file), "utf8")]));
  const files: Record<string, string> = { ...templates };
  const put = (file: string, record: unknown) => { files[file] = typeof record === "string" ? record : JSON.stringify(record); };
  put("characters/char/card.json", { name: "Marina", description: "before", extensions: { opaque: true }, studio: { linkedLorebookIds: [], unknown: 9 } });
  put("personas/persona.json", { id: "persona", name: "Traveler", description: "before", boundCharacterIds: ["char"], lorebookIds: [], unknown: 9 });
  put("lorebooks/book.json", { id: "book", name: "Coastal Lore", entries: [{ uid: 4, title: "Harbor", content: "before", status: "normal", keys: ["harbor"], enabled: true, extensions: { opaque: true } }, { uid: 7, title: "Forest", content: "unchanged", status: "constant", enabled: true }], settings: { scanDepth: 4, recursiveScan: true }, extensions: { opaque: true } });
  put("regex/script.json", { id: "script", scriptName: "Clean Labels", findRegex: "^Label: ", replaceString: "", flags: "gm", disabled: false, placement: [2], scope: "global", unknown: 9 });
  put("groups/group.json", { id: "group", name: "Party", memberIds: ["char"], mutedIds: [], mode: "natural", unknown: 9 });
  put("chats/chat.meta.json", { id: "chat", title: "Harbor Scene", characterId: "char", personaId: "persona", presetId: null, lorebookIds: ["book"], updatedAt: 1, unknown: 9 });
  put("chats/chat.jsonl", [{ id: "m1", role: "char", text: "active", swipe: 1, swipes: ["inactive", "active"], translation: "old", at: 5, extra: { reasoning: "keep", usage: { tokens: 7 }, parts: [{ type: "thinking", text: "secret" }] } }, { id: "m2", role: "user", text: "unchanged", at: 6 }].map((item) => JSON.stringify(item)).join("\n") + "\n");
  put("settings.json", { personaId: "persona", ui: { theme: "dark", font: "keep" }, notifications: { errors: true }, unknown: 9 });
  put("library.json", { qrSets: [{ id: "qr", name: "Greetings", replies: [{ id: "reply", message: "hello" }], enabled: true }], themes: [{ id: "theme", name: "Custom", colors: { accent: "blue", text: "keep" }, unknown: 9 }], folders: [{ id: "folder", name: "keep" }] });
  put("databank/doc.json", { id: "doc", name: "Travel Guide", scope: "global", enabled: true, size: 11, chunks: [{ i: 0, text: "before text" }], unknown: 9 });
  const read = (file: string) => { if (files[file] === undefined) throw new Error("Missing file " + file); return files[file]!; };
  const host = { fs: { read, readVersioned: (file: string) => { const text = read(file); return { text, revision: createHash("sha256").update(text).digest("hex") }; }, list: (dir: string) => [...new Set(Object.keys(files).filter((file) => file.startsWith(dir + "/")).map((file) => file.slice(dir.length + 1).split("/")[0]!))] } };
  const apply = (plan: any) => { for (const write of plan.writes) { const current = files[write.path]; expect(current === undefined ? null : createHash("sha256").update(current).digest("hex")).toBe(write.expectedRevision); files[write.path] = write.content; } };
  return { files, put, host, apply, read };
}
async function module(kind: string, hook: string) { return await import(path.join(app, `.agents/skills/${kind}-editing/${hook}.js`)); }
async function inspect(kind: string, args: Record<string, unknown>, host: any) { return (await module(kind, "inspect")).inspect(args, host); }
async function edit(kind: string, args: Record<string, unknown>, host: any) { return (await module(kind, "edit")).edit(args, host); }

it("focused inspectors resolve every stored entity without changing it", async () => {
  const f = fixture(), before = JSON.stringify(f.files);
  for (const [kind, query, field, expected] of [["character", "Marina", "/description", "before"], ["persona", "Traveler", "/description", "before"], ["lorebook", "Coastal", "/settings/scanDepth", 4], ["regex", "Clean", "/disabled", false], ["group", "Party", "/memberIds", ["char"]], ["chat", "Harbor", "/personaId", "persona"], ["settings", undefined, "/ui/font", "keep"], ["library", undefined, "/folders/0/name", "keep"], ["databank", "Travel", "/size", 11]] as const) {
    const result = await inspect(kind, { query, fields: [field, "/absent"] }, f.host);
    expect(result.results[0].values[field]).toEqual(expected); expect(result.results[0].missing).toEqual(["/absent"]);
    expect(result.results[0].revision).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(JSON.stringify(f.files)).toBe(before);
});
it("patches preserve opaque metadata, nested siblings, and unrelated files across entity kinds", async () => {
  const f = fixture();
  for (const [kind, query, patch, file] of [["character", "char", { description: "after" }, "characters/char/card.json"], ["persona", "persona", { pronouns: "they" }, "personas/persona.json"], ["lorebook", "book", { settings: { scanDepth: 8 } }, "lorebooks/book.json"], ["regex", "script", { disabled: true }, "regex/script.json"], ["group", "group", { mutedIds: ["char"] }, "groups/group.json"], ["chat", "chat", { title: "New title" }, "chats/chat.meta.json"], ["settings", undefined, { ui: { theme: "light" } }, "settings.json"], ["databank", "doc", { enabled: false }, "databank/doc.json"]] as const) {
    const before = { ...f.files }, found = (await inspect(kind, { query, fields: [""] }, f.host)).results[0];
    f.apply(await edit(kind, { query, revision: found.revision, patch }, f.host));
    for (const [name, value] of Object.entries(before)) if (name !== file) expect(f.files[name]).toBe(value);
    const record = JSON.parse(f.read(file));
    if (kind === "character") expect(record).toMatchObject({ extensions: { opaque: true }, studio: { unknown: 9 } });
    else if (kind === "lorebook") expect(record).toMatchObject({ extensions: { opaque: true }, settings: { recursiveScan: true } });
    else expect(record.unknown).toBe(9);
  }
  expect(JSON.parse(f.read("settings.json")).ui.font).toBe("keep");
});
it("lore item edits preserve other entries and creation uses complete entry defaults", async () => {
  const f = fixture(); let result = await inspect("lorebook", { query: "book", item: "Harbor" }, f.host);
  expect(result.results[0].items[0].content).toBe("before");
  f.apply(await edit("lorebook", { query: "book", item: 4, revision: result.results[0].revision, patch: { content: "updated", keys: ["port"] } }, f.host));
  let saved = JSON.parse(f.read("lorebooks/book.json")); expect(saved.entries[1].content).toBe("unchanged"); expect(saved.entries[0].extensions).toEqual({ opaque: true });
  result = await inspect("lorebook", { query: "book" }, f.host);
  f.apply(await edit("lorebook", { query: "book", revision: result.results[0].revision, operation: "add-item", patch: { title: "Tower", content: "new lore", keys: ["tower"] } }, f.host));
  saved = JSON.parse(f.read("lorebooks/book.json")); expect(saved.entries[2]).toMatchObject({ uid: 8, content: "new lore", status: "normal", enabled: true });
  result = await inspect("lorebook", { query: "book", offset: 2, limit: 1 }, f.host); expect(result.results[0].items[0].id).toBe(8);
});
it("library item changes preserve other collections and item metadata", async () => {
  const f = fixture(), result = await inspect("library", { collection: "themes", item: "theme" }, f.host);
  f.apply(await edit("library", { collection: "themes", item: "theme", revision: result.results[0].revision, patch: { colors: { accent: "green" } } }, f.host));
  const saved = JSON.parse(f.read("library.json")); expect(saved.themes[0]).toMatchObject({ colors: { accent: "green", text: "keep" }, unknown: 9 }); expect(saved.qrSets[0].replies[0].message).toBe("hello"); expect(saved.folders[0].name).toBe("keep");
});
it("chat pagination selects messages independently from record pagination and text edits preserve swipes", async () => {
  const f = fixture(), page = await inspect("chat", { chat: "chat", messages: true, offset: 1, limit: 1 }, f.host);
  expect(page.results[0].messages[0].id).toBe("m2"); expect(page.results[0].messageCount).toBe(2);
  const target = (await inspect("chat", { query: "chat", message: "m1" }, f.host)).results[0];
  const plan = await edit("chat", { chat: "chat", message: "m1", revision: target.revision, transcriptRevision: target.transcriptRevision, patch: { text: "edited text", bookmarked: true } }, f.host);
  expect(plan.writes).toHaveLength(2); f.apply(plan);
  const messages = f.read("chats/chat.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  expect(messages[0]).toMatchObject({ text: "edited text", swipe: 1, swipes: ["inactive", "edited text"], edited: true, bookmarked: true, at: 5, extra: { reasoning: "keep", usage: { tokens: 7 } } }); expect(messages[0].translation).toBeUndefined(); expect(messages[1].text).toBe("unchanged"); expect(JSON.parse(f.read("chats/chat.meta.json"))).toMatchObject({ unknown: 9, tainted: true });
});
it("data-bank content uses upload chunk boundaries and actual size", async () => {
  const f = fixture(), content = "abcdefghij".repeat(230), result = await inspect("databank", { query: "doc" }, f.host);
  f.apply(await edit("databank", { query: "doc", revision: result.results[0].revision, content }, f.host));
  const saved = JSON.parse(f.read("databank/doc.json")); expect(saved.size).toBe(content.length); expect(saved.unknown).toBe(9); expect(saved.chunks.map((item: any) => item.text)).toEqual([content.slice(0, 1000), content.slice(850, 1850), content.slice(1700, 2700)]);
});
it("rejects ambiguous targets, stale revisions, invalid references, pattern errors, and identity changes", async () => {
  const f = fixture(); f.put("lorebooks/copy.json", { ...JSON.parse(f.read("lorebooks/book.json")), id: "copy", name: "Coastal Lore Copy" });
  const ambiguous = await inspect("lorebook", { query: "Coastal" }, f.host); expect(ambiguous.ambiguous).toBe(true);
  await expect(edit("lorebook", { query: "Coastal", revision: ambiguous.results[0].revision, patch: { name: "wrong" } }, f.host)).rejects.toThrow("exactly one");
  for (const [kind, query, patch] of [["group", "group", { memberIds: ["missing"] }], ["regex", "script", { findRegex: "[" }], ["regex", "script", { "/disabled": true }], ["settings", undefined, { personaId: "../other" }], ["persona", "persona", { id: "changed" }], ["lorebook", "book", { entries: {} }]] as const) {
    const result = await inspect(kind, { query }, f.host); await expect(edit(kind, { query, revision: result.results[0].revision, patch }, f.host)).rejects.toThrow();
  }
  await expect(edit("character", { query: "char", revision: "old", patch: { description: "wrong" } }, f.host)).rejects.toThrow("revision");
});
it("new entities start without sample records and preserve user-supplied extension fields", async () => {
  const f = fixture();
  for (const [kind, patch] of [["character", { name: "New bot", description: "exact", extensions: { custom: "keep" } }], ["persona", { name: "New persona" }], ["lorebook", { name: "New lore" }], ["regex", { scriptName: "New filter", findRegex: "test" }], ["group", { name: "New group" }], ["databank", { name: "New document", scope: "global" }]] as const) {
    const plan = await edit(kind, { operation: "create", id: "new-" + kind, patch, ...(kind === "databank" ? { content: "actual content" } : {}) }, f.host); f.apply(plan);
    const saved = JSON.parse(f.read(plan.writes[0].path)); expect(saved._note).toBeUndefined();
    if (kind === "lorebook") expect(saved.entries).toEqual([]);
    if (kind === "group") expect(saved.memberIds).toEqual([]);
    if (kind === "character") expect(saved.extensions.custom).toBe("keep");
    expect((await inspect(kind, { query: "new-" + kind, fields: [""] }, f.host)).results[0]).toBeDefined();
  }
});
it("explicit null clears a nullable setting while type mismatches fail", async () => {
  const f = fixture(), target = (await inspect("settings", {}, f.host)).results[0];
  f.apply(await edit("settings", { revision: target.revision, patch: { personaId: null } }, f.host)); expect(JSON.parse(f.read("settings.json")).personaId).toBeNull();
  const current = (await inspect("settings", {}, f.host)).results[0]; await expect(edit("settings", { revision: current.revision, patch: { ui: false } }, f.host)).rejects.toThrow("type");
});

it("unknown arguments fail before inspection instead of silently widening the search", async () => {
  const f = fixture();
  await expect(inspect("lorebook", { search: "Coastal Lore" }, f.host)).rejects.toThrow("Unknown argument");
  await expect(inspect("chat", { query: "chat", chat: "other", message: "m1" }, f.host)).rejects.toThrow("Conflicting");
});
