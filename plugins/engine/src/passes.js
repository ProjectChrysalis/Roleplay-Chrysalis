import { state } from "./state.js";
import { globalVarsChanged } from "./variables.js";

// The sandbox module is re-evaluated FRESH on every pass, so module-level
// Maps stashed in pass A are always gone by pass B (this silently broke
// gen timing, the sampler snapshot, prefill and {{setvar}} for every
// generation). State rides the kernel's GenerateResult echoes instead —
// genTimeMs / requestParams / assistantPrefill — and {{setvar}} writes ride
// the runtime's `stash` (pass A returns it, pass B receives it on ctx).
export const pendingOut = (meta, extra) => ({
  __llmPending: true,
  ...((meta.chatVars && Object.keys(meta.chatVars).length) || (meta.wiTimed && Object.keys(meta.wiTimed).length) || globalVarsChanged() || extra
    ? {
        stash: {
          ...(meta.chatVars && Object.keys(meta.chatVars).length ? { vars: meta.chatVars } : {}),
          ...(globalVarsChanged() ? { globals: state.sharedVars } : {}),
          ...(meta.wiTimed && Object.keys(meta.wiTimed).length ? { wiTimed: meta.wiTimed } : {}),
          ...(extra && typeof extra === "object" ? extra : {}),
        },
      }
    : {}),
});
export function applyStashVars(req, meta) {
  const v = req && req.stash && req.stash.vars;
  if (v && typeof v === "object" && Object.keys(v).length) {
    meta.chatVars = { ...meta.chatVars, ...v };
    // a deleted variable travels as null so the merge can drop it
    for (const k of Object.keys(meta.chatVars)) if (meta.chatVars[k] == null) delete meta.chatVars[k];
  }
  const t = req && req.stash && req.stash.wiTimed;
  if (t && typeof t === "object") meta.wiTimed = t;
  // shared variables written in pass A: adopt them so the save that follows writes them
  const g = req && req.stash && req.stash.globals;
  if (g && typeof g === "object" && !Array.isArray(g)) { state.sharedVars = g; state.sharedVarsSaved = ""; }
}
// The kernel synthesizes {model:"error", error} when the provider call throws
// (content filter, bad key, transport failure) — surface that cause instead of
// the generic connectivity hint so a filtered turn reads as filtered.
export function llmFailReason(reply) {
  const cause = reply && typeof reply.error === "string" ? reply.error.trim() : "";
  return cause || "Model failed. Check the connection in Settings.";
}
