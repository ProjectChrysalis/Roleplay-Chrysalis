const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const LEASE_MS = 90_000;
function read(host, path) { try { return JSON.parse(host.fs.read(path)); } catch { return null; } }
function config(host, chatId) {
  const meta = read(host, "chats/" + chatId + ".meta.json");
  const settings = read(host, "settings.json") || {};
  let presetId = meta?.presetLocked && meta.presetId ? meta.presetId : settings.presetId;
  if (!presetId) {
    let names = [];
    try { names = host.fs.list("presets").filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort(); } catch {}
    presetId = names.find((f) => read(host, "presets/" + f)?.studio?.isDefault)?.slice(0, -5) || "default";
  }
  if (!meta || !VALID_ID.test(presetId)) return null;
  const preset = read(host, "presets/" + presetId + ".json");
  const cache = preset?.studio?.samplers?.cache;
  const refresh = cache?.refresh;
  if (refresh?.enabled !== true || (cache.pinned !== undefined && cache.enabled === false)) return null;
  const windowMs = cache.ttl === "long" ? 3_600_000 : 300_000;
  const intervalMs = Math.max(30_000, Math.min(windowMs - 30_000, (Number(refresh.intervalSeconds) || (windowMs === 300_000 ? 270 : 3300)) * 1000));
  const max = Math.max(1, Math.min(20, Math.floor(Number(refresh.maxRefreshes) || 3)));
  return { intervalMs, max, notifications: refresh.notifications !== false,
    fingerprint: fingerprint([presetId, preset, settings.model, meta.model, meta.personaId, meta.authorNote, meta.chatLorebookIds, meta.lorebookIds]) };
}
function fingerprint(value) {
  const text = JSON.stringify(value);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return (a >>> 0).toString(16) + ":" + (b >>> 0).toString(16);
}
function load(host) { return host.store.get("refresh") || { leases: {}, cycles: {} }; }
function save(host, state) { host.store.put("refresh", state); }
function present(state, chatId, now) {
  return Object.values(state.leases).some((l) => l.chatId === chatId && l.until > now);
}
function prune(state, now) {
  for (const [id, lease] of Object.entries(state.leases)) if (lease.until <= now) delete state.leases[id];
  for (const id of Object.keys(state.cycles)) if (!present(state, id, now)) delete state.cycles[id];
}
function status(cycle) {
  if (!cycle) return { state: "waiting", message: "Waiting for a new reply" };
  const { token, fingerprint, captureId, ...publicStatus } = cycle;
  return publicStatus;
}
export function handleRoute(req, host) {
  if (req.path.split("?")[0].replace(/^\//, "") !== "cache-refresh" || req.method !== "POST") return null;
  const b = req.body || {};
  if (!VALID_ID.test(b.clientId || "") || (b.chatId != null && !VALID_ID.test(b.chatId))) return { status: 400, json: { error: "Invalid cache refresh session" } };
  const now = Date.now();
  const state = load(host);
  prune(state, now);
  if (b.chatId) state.leases[b.clientId] = { chatId: b.chatId, until: now + LEASE_MS, busy: b.busy === true };
  else delete state.leases[b.clientId];
  const cfg = b.chatId ? config(host, b.chatId) : null;
  const cycle = state.cycles[b.chatId];
  if (cycle && (!cfg || cfg.fingerprint !== cycle.fingerprint)) delete state.cycles[b.chatId];
  if (b.stop && state.cycles[b.chatId]) Object.assign(state.cycles[b.chatId], { state: "stopped", message: "Cache refresh stopped", nextAt: null, token: null });
  prune(state, now);
  save(host, state);
  return { status: 200, json: { enabled: !!cfg, now, ...status(state.cycles[b.chatId]) } };
}
export function llmRequest(ctx, host) {
  if (ctx.key !== "reply" || !ctx.plugin.endsWith(".engine")) return null;
  const id = ctx.request.sessionId;
  if (!VALID_ID.test(id || "")) return null;
  const state = load(host);
  delete state.cycles[id];
  const cfg = config(host, id);
  let captureCache = false;
  if (present(state, id, Date.now()) && cfg) {
    state.serial = (state.serial || 0) + 1;
    captureCache = String(state.serial);
    state.cycles[id] = { state: "pending", message: "Waiting for a new reply", captureId: captureCache, fingerprint: cfg.fingerprint };
  }
  save(host, state);
  return { captureCache };
}
export function llmResponse(ctx, host) {
  if (ctx.key !== "reply" || !ctx.plugin.endsWith(".engine") || !ctx.request.captureCache) return null;
  const id = ctx.request.sessionId;
  const cfg = config(host, id);
  const state = load(host);
  const pending = state.cycles[id];
  if (!cfg || !present(state, id, Date.now()) || pending?.state !== "pending"
    || pending.captureId !== ctx.request.captureCache || pending.fingerprint !== cfg.fingerprint) return null;
  const info = ctx.result.cacheRefresh;
  const nextAt = info?.startedAt + cfg.intervalMs;
  state.cycles[id] = { fingerprint: cfg.fingerprint, token: info?.token,
    state: info?.token && nextAt > Date.now() ? "scheduled" : "paused",
    message: info?.reason || (!info?.token ? "Engine update required for cache refresh" : nextAt <= Date.now() ? "Refresh deadline elapsed during generation" : "Cache refresh scheduled"),
    nextAt: info?.token && nextAt > Date.now() ? nextAt : null, expiresAt: info?.expiresAt,
    remaining: cfg.max, count: 0, events: [], usage: [] };
  save(host, state);
  return null;
}
export function onTick(ctx, host) {
  const now = Date.now();
  const state = load(host);
  prune(state, now);
  const reply = host.llm.results.refresh;
  if (ctx.chatId && reply) {
    const cycle = state.cycles[ctx.chatId];
    const cfg = cycle && config(host, ctx.chatId);
    if (!cycle || !present(state, ctx.chatId, now) || cycle.token !== ctx.token || !cfg || cycle.fingerprint !== cfg.fingerprint) return null;
    cycle.remaining--;
    cycle.count++;
    const hit = reply.model !== "error" && Number.isFinite(reply.usage?.cacheRead) && reply.usage.cacheRead > 0;
    const message = reply.model === "error" ? "Cache refresh failed: " + (reply.error || "Unknown error")
      : hit ? "Cache refreshed" : reply.usage?.cacheWrite > 0 ? "Cache missed, refresh stopped" : "Cache use was not confirmed, refresh stopped";
    cycle.events.push({ at: now, id: ctx.token + ":" + cycle.count, message, type: hit ? "success" : "warning", notify: cfg.notifications });
    cycle.events = cycle.events.slice(-20);
    const { priced, costTotal, ...usage } = reply.usage || {};
    cycle.usage.push({ at: now, ...usage, ...(priced === true ? { costTotal } : {}) });
    cycle.expiresAt = reply.cacheRefresh?.expiresAt;
    cycle.nextAt = hit && cycle.remaining > 0 ? reply.cacheRefresh.startedAt + cfg.intervalMs : null;
    cycle.state = !hit ? "paused" : cycle.remaining > 0 ? "scheduled" : "complete";
    cycle.message = !hit ? message : cycle.remaining > 0 ? message : "Refresh limit reached";
    if (!hit || !cycle.nextAt) cycle.token = null;
    save(host, state);
    return { chatId: ctx.chatId, ...status(cycle) };
  }
  for (const [id, cycle] of Object.entries(state.cycles)) {
    if (cycle.state !== "scheduled") continue;
    const cfg = config(host, id);
    if (!cfg || cfg.fingerprint !== cycle.fingerprint) { delete state.cycles[id]; continue; }
    if (cycle.expiresAt <= now) { Object.assign(cycle, { state: "paused", nextAt: null, token: null, message: "Refresh session expired" }); continue; }
    if (Object.values(state.leases).some((l) => l.chatId === id && l.until > now && l.busy)) continue;
    if (cycle.nextAt > now) continue;
    host.llm.request("refresh", { refreshToken: cycle.token });
    save(host, state);
    return { chatId: id, token: cycle.token };
  }
  save(host, state);
  return null;
}
