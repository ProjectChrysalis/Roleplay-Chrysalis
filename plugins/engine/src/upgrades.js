import { storeMedia } from "./media.js";

function olderThan(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

function readJsonFile(fsx, rel) {
  try { return JSON.parse(fsx.read(rel)); } catch { return null; }
}

function writeJsonFile(fsx, rel, value) {
  fsx.write(rel, JSON.stringify(value, null, 2) + "\n");
}

/** Branch-tree chat (entries with parentId, meta.activeLeafId) → flat
 *  messages along the active path. The leaf's sibling replies become its
 *  swipes. Null when the chat is already flat. */
function flattenTreeChat(jsonl, meta, charName) {
  let entries;
  try { entries = jsonl.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return null; }
  if (!entries.length || !("parentId" in entries[0])) return null;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const trail = [];
  let cur = meta.activeLeafId ? byId.get(meta.activeLeafId) : entries[entries.length - 1];
  while (cur) {
    trail.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const userName = meta.userName || "User";
  const speaker = charName || "Character";
  const flat = trail.map((e) => ({
    id: "e" + Math.random().toString(36).slice(2, 9),
    name: e.role === "user" ? userName : speaker,
    charId: e.role === "user" ? null : meta.characterId,
    role: e.role === "user" ? "user" : "char",
    text: e.text,
    at: e.at || Date.now(),
    swipes: [e.text],
    swipe: 0,
  }));
  const leaf = trail[trail.length - 1];
  if (leaf && leaf.role !== "user" && flat.length) {
    const siblings = entries.filter((e) => e.id !== leaf.id && e.parentId === leaf.parentId && e.role !== "user");
    if (siblings.length) flat[flat.length - 1].swipes = [leaf.text, ...siblings.map((x) => x.text)];
  }
  const nextMeta = {
    ...meta,
    userName,
    presetId: meta.presetId || "default",
    personaId: meta.personaId || null,
    lorebookIds: meta.lorebookIds || [],
    tainted: true,
    updatedAt: Date.now(),
  };
  delete nextMeta.activeLeafId;
  return { lines: flat.map((m) => JSON.stringify(m)), meta: nextMeta };
}

/** Sections preset → prompts + prompt_order. Null when already converted. */
function convertSectionsPreset(p) {
  if (!p || !Array.isArray(p.sections)) return null;
  const params = (p.sampler && p.sampler.params) || {};
  const prompts = p.sections.map((x) => ({
    identifier: x.id,
    name: x.name || x.id,
    role: x.role === "user" || x.role === "assistant" ? x.role : "system",
    ...(x.marker ? { marker: true } : {}),
    ...(typeof x.content === "string" && x.content.trim() ? { content: x.content } : {}),
    ...(x.position && typeof x.position.depth === "number" ? { injection_position: "absolute", injection_depth: x.position.depth } : {}),
  }));
  return {
    id: p.id,
    name: p.name || p.id || "Preset",
    prompts,
    prompt_order: [{ character_id: 100000, order: prompts.map((x) => ({ identifier: x.identifier, enabled: true })) }],
    ...(p.sampler && typeof p.sampler.temperature === "number" ? { temperature: p.sampler.temperature } : {}),
    ...(p.sampler && typeof p.sampler.maxTokens === "number" ? { openai_max_tokens: p.sampler.maxTokens } : {}),
    ...(p.context && typeof p.context.maxTokens === "number" ? { openai_max_context: p.context.maxTokens } : {}),
    ...params,
  };
}

/** Lorebook entries with nested insertion.{order,position,depth,role} →
 *  flat fields. Null when none are nested. */
function flattenLorebookInsertion(b) {
  if (!b || !Array.isArray(b.entries) || !b.entries.some((e) => e && e.insertion)) return null;
  const entries = b.entries.map((e) => {
    if (!e || !e.insertion) return e;
    const { insertion, ...rest } = e;
    return { ...rest, order: insertion.order, position: insertion.position, ...(insertion.depth != null ? { depth: insertion.depth } : {}), ...(insertion.role ? { role: insertion.role } : {}) };
  });
  return { ...b, entries };
}

/** The editor used to give every section that had no generation types of
 *  its own just "normal", so swipes, regenerations and continues sent none of
 *  the preset. A preset where every section is limited to "normal" is that
 *  damage, not a choice: it gets every generation type back. */
function allTriggersWhereNormalOnly(preset) {
  const sections = preset && preset.studio && Array.isArray(preset.studio.sections) ? preset.studio.sections : null;
  if (!sections || !sections.length) return null;
  const normalOnly = (s) => s && Array.isArray(s.injectionTriggers) && s.injectionTriggers.length === 1 && s.injectionTriggers[0] === "normal";
  if (!sections.every(normalOnly)) return null;
  const all = ["normal", "continue", "impersonate", "swipe", "regenerate", "quiet"];
  return { ...preset, studio: { ...preset.studio, sections: sections.map((s) => ({ ...s, injectionTriggers: all })) } };
}

/** Run once by the engine after this app's code moved from `from` to `to`.
 *  Every step is idempotent and only reads data an older version wrote. */
export function onAppUpdate(ctx, host) {
  const fsx = host.fs;
  const from = ctx && typeof ctx.from === "string" ? ctx.from : "0.0.0";
  const done = [];
  if (fsx.media && olderThan(from, "4.20.0")) {
    let ids = [];
    try { ids = fsx.list("characters"); } catch { /* no saved cards */ }
    let migrated = 0, deferred = 0;
    const startedAt = Date.now();
    for (const [index, id] of ids.entries()) {
      if (Date.now() - startedAt > 5000) { deferred += ids.length - index; break; }
      const rel = "characters/" + id + "/card.json";
      const card = readJsonFile(fsx, rel);
      if (!card) continue;
      try {
        const stored = storeMedia(card, fsx);
        if (JSON.stringify(stored) === JSON.stringify(card)) continue;
        writeJsonFile(fsx, rel, stored);
        migrated++;
      } catch { deferred++; }
    }
    if (migrated) done.push("character media: " + migrated);
    if (deferred && host.log) host.log("Character media migration deferred for " + deferred + " cards. Original cards were retained.");
  }
  if (olderThan(from, "4.18.2")) {
    let files = [];
    try { files = fsx.list("presets").filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch { files = []; }
    for (const f of files) {
      const out = allTriggersWhereNormalOnly(readJsonFile(fsx, "presets/" + f));
      if (!out) continue;
      writeJsonFile(fsx, "presets/" + f, out);
      done.push("presets/" + f + " generation types");
    }
  }
  if (!olderThan(from, "4.0.0")) return { upgraded: done };

  const defaultPreset = readJsonFile(fsx, "presets/default.json");
  // the old cramped generation defaults, only while never customized
  if (defaultPreset && defaultPreset.openai_max_context === 16384 && defaultPreset.openai_max_tokens === 1024) {
    writeJsonFile(fsx, "presets/default.json", { ...defaultPreset, openai_max_context: 128000, openai_max_tokens: 4096 });
    done.push("default preset limits");
  }

  let chats = [];
  try { chats = fsx.list("chats").filter((f) => f.endsWith(".jsonl")); } catch { chats = []; }
  for (const f of chats) {
    const metaRel = "chats/" + f.replace(/\.jsonl$/, ".meta.json");
    const meta = readJsonFile(fsx, metaRel) || {};
    const card = meta.characterId ? readJsonFile(fsx, "characters/" + meta.characterId + "/card.json") : null;
    const out = flattenTreeChat(fsx.read("chats/" + f), meta, card && card.name);
    if (!out) continue;
    fsx.write("chats/" + f, out.lines.join("\n") + "\n");
    writeJsonFile(fsx, metaRel, out.meta);
    done.push("chats/" + f);
  }

  for (const [dir, convert] of [["presets", convertSectionsPreset], ["lorebooks", flattenLorebookInsertion]]) {
    let files = [];
    try { files = fsx.list(dir).filter((f) => f.endsWith(".json")); } catch { files = []; }
    for (const f of files) {
      const out = convert(readJsonFile(fsx, dir + "/" + f));
      if (!out) continue;
      writeJsonFile(fsx, dir + "/" + f, { ...out, id: out.id || f.replace(/\.json$/, "") });
      done.push(dir + "/" + f);
    }
  }
  return { upgraded: done };
}
