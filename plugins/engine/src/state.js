/**
 * Values several modules share for the length of one route call. A module
 * cannot assign a binding it imports, so they live on this object, and
 * handleRoute resets them at the start of every call.
 */
export const state = {
  /** variables.json as read this call, null until something reads it. */
  sharedVars: null,
  /** sharedVars as last read or written, to tell whether it changed. */
  sharedVarsSaved: "",
  /** The regex scripts loadRegexScripts found for the chat asked last. */
  regexScriptsFor: null,
  /** The engine's regex service when it has one: patterns run in the host's
   *  compiled regex engine instead of this interpreter, which is tens of
   *  times slower on a pattern that rescans long replies. */
  hostRegex: null,
  /** The default preset's id once defaultPresetId has found it. */
  defaultPresetFound: null,
};
