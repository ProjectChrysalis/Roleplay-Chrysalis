import { state } from "../state.js";
import { storeMedia } from "../media.js";
import { backupRoute } from "./backup.js";
import { bootstrapRoute } from "./bootstrap.js";
import { charactersRoute } from "./characters.js";
import { chatsRoute } from "./chats.js";
import { databankRoute } from "./databank.js";
import { entitiesRoute } from "./entities.js";
import { promptPreviewRoute, worldInfoStatusRoute } from "./inspect.js";
import { libraryRoute, settingsRoute } from "./settings.js";
import { translateRoute } from "./translate.js";

/** The host as guest objects whose functions call the host's without a
 *  receiver. On engines that hand the plugin host objects directly, each
 *  method call (host.fs.read(...)) serialized its object again: about a
 *  millisecond a call, which a route reading thousands of files paid in full. */
function ownHost(v, depth = 0) {
  if (typeof v === "function") return (...args) => v(...args);
  if (v === null || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => ownHost(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = ownHost(v[k], depth + 1);
  return o;
}

export function handleRoute(req, host) {
  host = ownHost(host);
  state.hostRegex = host.regex && typeof host.regex.matches === "function" ? host.regex : null;
  const fsx = host.fs;
  // a host that keeps the module loaded between calls must not hand one
  // call's shared variables to the next
  state.sharedVars = null;
  state.sharedVarsSaved = "";
  state.defaultPresetFound = null;
  state.regexScriptsFor = null;
  const seg = req.path.split("?")[0].split("/").filter(Boolean);
  const head = seg[0];
  const id = seg[1];
  const op = seg[2];
  const ok = (json, status = 200) => ({ status, json });
  const err = (status, msg) => ({ status, json: { error: msg } });
  // ids are interpolated into fs paths — refuse path-shaped ids outright
  // ("..", ".", anything with a dot) before any route touches the disk
  if (id != null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) {
    return err(400, "invalid id");
  }
  const readJson = (rel, fb) => { try { return JSON.parse(fsx.read(rel)); } catch { return fb; } };
  const writeJson = (rel, v) => fsx.write(rel, JSON.stringify(storeMedia(v, fsx), null, 2) + "\n");
  const body = () => (req.body && typeof req.body === "object" ? req.body : {});
  const touch = (meta) => { meta.updatedAt = Date.now(); return meta; };
  const c = { req, host, fsx, seg, head, id, op, ok, err, readJson, writeJson, body, touch };
  for (const route of ROUTES) {
    const r = route(c);
    if (r !== undefined) return r;
  }
  return null; // unmatched
}

/** Route groups, tried in this order: the first answer wins. */
const ROUTES = [
  bootstrapRoute,
  charactersRoute,
  entitiesRoute,
  libraryRoute,
  settingsRoute,
  promptPreviewRoute,
  worldInfoStatusRoute,
  backupRoute,
  translateRoute,
  databankRoute,
  chatsRoute,
];
