import { state } from "./state.js";

/** settings.json selects the active preset; legacy flags are the fallback.
 *  Presets run to hundreds of kilobytes and a library holds hundreds, so
 *  presets/_default.json names the last one found (null: none is marked)
 *  and how many presets there were. A named one is checked against its
 *  preset before it is trusted, "none" only while the count holds, and
 *  saving a preset as the default rewrites it. */
const DEFAULT_PRESET_HINT = "presets/_default.json";
function isDefaultPreset(text) {
  if (!text.includes('"isDefault"')) return false;
  const cand = JSON.parse(text);
  return !!(cand && cand.studio && cand.studio.isDefault === true);
}
export function defaultPresetId(fsx) {
  let selected;
  try { selected = JSON.parse(fsx.read("settings.json"))?.presetId; } catch {}
  if (typeof selected === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(selected)) {
    try { if (JSON.parse(fsx.read("presets/" + selected + ".json"))) return (state.defaultPresetFound = selected); } catch {}
  }
  if (state.defaultPresetFound) return state.defaultPresetFound;
  let names = [];
  try { names = fsx.list("presets").filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch {}
  let hint = {};
  try { hint = JSON.parse(fsx.read(DEFAULT_PRESET_HINT)) || {}; } catch {}
  const hinted = hint.id;
  if (hinted === null && hint.files === names.length) return (state.defaultPresetFound = "default");
  if (typeof hinted === "string" && hinted !== "default" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(hinted)) {
    try { if (isDefaultPreset(fsx.read("presets/" + hinted + ".json"))) return (state.defaultPresetFound = hinted); } catch {}
  }
  let found = null;
  for (const f of names.sort((a, b) => a === b ? 0 : a === "default.json" ? 1 : b === "default.json" ? -1 : a.localeCompare(b))) {
    try { if (isDefaultPreset(fsx.read("presets/" + f))) { found = f.slice(0, -5); break; } } catch {}
  }
  rememberDefaultPreset(fsx, found, names.length);
  return (state.defaultPresetFound = found || "default");
}
export function rememberDefaultPreset(fsx, id, files) {
  try { fsx.write(DEFAULT_PRESET_HINT, JSON.stringify({ id, files }) + "\n"); } catch {}
}
