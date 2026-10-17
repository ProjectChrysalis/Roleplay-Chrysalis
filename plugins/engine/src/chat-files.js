import { chatListing } from "./paging.js";
import { defaultPresetId } from "./presets.js";
import { saveGlobalVars } from "./variables.js";

/** One preset and one persona are current everywhere. A chat locked to its
 *  own keeps it; otherwise a persona locked to the chat's character wins,
 *  then the current one. */
export function chatPresetId(fsx, meta) {
  return meta.presetLocked === true && meta.presetId ? meta.presetId : defaultPresetId(fsx);
}
export function chatPersonaId(fsx, meta) {
  if (meta.personaLocked === true && meta.personaId) return meta.personaId;
  // a group chat's members share the group's lock
  const owner = meta.characterId || meta.groupId;
  if (owner) {
    let bound = [];
    try {
      bound = fsx.list("personas").filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(fsx.read("personas/" + f)); } catch { return null; } })
        .filter((p) => p && p.id && Array.isArray(p.boundCharacterIds) && p.boundCharacterIds.includes(owner));
    } catch {}
    const pick = bound.find((p) => p.autoLock) || bound[0];
    if (pick) return pick.id;
  }
  try { return JSON.parse(fsx.read("settings.json")).personaId || null; } catch { return null; }
}

export function loadChat(fsx, id) {
  const meta = (() => { try { return JSON.parse(fsx.read("chats/" + id + ".meta.json")); } catch { return null; } })();
  if (!meta) return null;
  meta.presetId = chatPresetId(fsx, meta);
  meta.personaId = chatPersonaId(fsx, meta);
  let msgs = [];
  try {
    msgs = fsx.read("chats/" + id + ".jsonl").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { /* new chat */ }
  return { meta, msgs };
}
export function saveChat(fsx, id, meta, msgs) {
  meta.updatedAt = Date.now();
  meta.listing = chatListing(msgs);
  fsx.write("chats/" + id + ".jsonl", msgs.map((m) => JSON.stringify(m)).join("\n") + (msgs.length ? "\n" : ""));
  fsx.write("chats/" + id + ".meta.json", JSON.stringify(meta, null, 2) + "\n");
  saveGlobalVars(fsx);
}
