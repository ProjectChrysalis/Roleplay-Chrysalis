import { state } from "./state.js";
import { humanIdle } from "./macros.js";

// One file, loaded once per route call.
// Writes made while a prompt is assembled ride the stash with the chat's own
// variables and land on disk when the turn commits (saveChat).
export function globalVars(fsx) {
  if (!state.sharedVars) {
    state.sharedVars = {};
    try {
      const j = JSON.parse(fsx.read("variables.json"));
      if (j && typeof j === "object" && !Array.isArray(j)) state.sharedVars = j;
    } catch { /* none yet */ }
    state.sharedVarsSaved = JSON.stringify(state.sharedVars);
  }
  return state.sharedVars;
}
export const globalVarsChanged = () => !!state.sharedVars && JSON.stringify(state.sharedVars) !== state.sharedVarsSaved;
export function saveGlobalVars(fsx) {
  if (!globalVarsChanged()) return;
  for (const k of Object.keys(state.sharedVars)) if (state.sharedVars[k] == null) delete state.sharedVars[k];
  state.sharedVarsSaved = JSON.stringify(state.sharedVars);
  fsx.write("variables.json", JSON.stringify(state.sharedVars, null, 2) + "\n");
}
/** Shared macro context for a chat's visible transcript (last-message
 *  macros, idle span) — used by assemble() and the swipe/greeting paths. */
export function transcriptMacros(msgs, base) {
  // read from the end: a long transcript loads only as far back as needed
  const lastUser = msgs.findLast((m) => m.role === "user" && m.hidden !== true);
  const lastChar = msgs.findLast((m) => m.role === "char" && m.hidden !== true);
  const last = msgs.findLast((m) => (m.role === "user" || m.role === "char") && m.hidden !== true);
  return {
    ...base,
    lastMessageId: msgs.length ? msgs.length - 1 : "",
    lastMessage: last ? String(last.text || "") : "",
    lastUserMessage: lastUser ? String(lastUser.text || "") : "",
    lastCharMessage: lastChar ? String(lastChar.text || "") : "",
    idleText: humanIdle(Date.now() - (lastUser ? lastUser.at || Date.now() : Date.now())),
  };
}
