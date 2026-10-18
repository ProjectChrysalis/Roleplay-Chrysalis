import { b64ToBytes, extractCardFromPng } from "./png.js";

export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
// Backup zips carry chat titles only as slug filenames ("crossroads-at-dusk-fork-cXXXXXXXXXXXX"):
// recover a readable title by dropping the trailing engine id and un-slugging.
export const unslugTitle = (s) => {
  const pretty = String(s)
    .replace(/-[a-z][a-z0-9]{9,}$/i, "")
    .replace(/-/g, " ")
    .replace(/(^|\s)\S/g, (m) => m.toUpperCase())
    .trim();
  return pretty || String(s);
};
export const firstOf = (v) => (Array.isArray(v) ? String(v[0] || "") : v === undefined ? "" : String(v));

/** Collection folders a backup can carry, ours and the foreign layouts'.
 *  Matching one anchors the entry: everything above it is wrapper folders
 *  (data/, default-user/, the install directory someone zipped) and is cut. */
const COLLECTION_DIRS = new Set([
  "characters", "chats", "group chats", "groups", "worlds", "presets", "personas",
  "regex", "lorebooks", "themes", "backgrounds", "extensions", "databank", "memories",
  "assets", "user settings", "openai settings", "textgen settings", "koboldai settings",
  "novelai settings", "instruct", "context", "quickreplies", "user avatars",
]);
/** Files that mean something at a backup's root (and nowhere else). */
const ROOT_FILES = new Set(["card.json", "settings.json", "personas.json", "library.json", "variables.json", "meta.json"]);

/** A zip entry's path as our tree sees it, wrapper folders removed. Unknown
 *  paths ride through untouched — a name we don't recognize is skipped later
 *  anyway, and mangling it would only make the summary harder to read. */
export function normalizeEntryName(raw) {
  const segs = String(raw).split("/").filter((s) => s && s !== ".");
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].toLowerCase() === "user" && segs[i + 1]?.toLowerCase() === "images") return ["user", "images", ...segs.slice(i + 2)].join("/");
    if (COLLECTION_DIRS.has(segs[i].toLowerCase())) return [segs[i].toLowerCase() === "user settings" ? "User Settings" : segs[i].toLowerCase(), ...segs.slice(i + 1)].join("/");
  }
  const base = segs[segs.length - 1] || String(raw);
  return ROOT_FILES.has(base.toLowerCase()) ? base : String(raw);
}

/** Base64 of a binary zip entry, or null for a text/oversized one. The kernel
 *  tags these `__b64__`; an older spelling (`__b64`) is still accepted so a
 *  mismatch here can never again silently drop every PNG card in a backup. */
export const entryBase64 = (e) =>
  e && typeof e === "object" && (e.__b64__ === true || e.__b64 === true) && typeof e.base64 === "string" ? e.base64 : null;

/** PNG tEXt chunk reader for embedded cards ("chara" base64 JSON, v2, or
 *  "ccv3" JSON) — mirrors what the browser-side importer does with .png
 *  cards, so backup zips with PNG characters import fully plugin-side. */
export function cardFromPngBase64(b64) {
  try { return extractCardFromPng(new Uint8Array(b64ToBytes(b64))); } catch { return null; }
}
