/** What a regex script does, with its name: two scripts with the same
 *  signature rewrite the same text the same way. Order, folder and the
 *  on/off switch are left out. */
export function regexSignature(s) {
  return JSON.stringify([
    String(s.scriptName ?? ""), String(s.findRegex ?? ""), String(s.flags ?? ""), String(s.replaceString ?? ""),
    (Array.isArray(s.trimStrings) ? s.trimStrings : []).map(String),
    (Array.isArray(s.placement) ? s.placement : []).map(String).sort(),
    s.markdownOnly === true, s.promptOnly === true, s.runOnEdit === true,
    typeof s.minDepth === "number" ? s.minDepth : null, typeof s.maxDepth === "number" ? s.maxDepth : null,
    s.macroMode && s.macroMode !== "none" ? s.macroMode : "none",
  ]);
}

// numeric placement of the portable regex format: 1 user input, 2 AI
// output, 3 slash command, 5 world info, 6 reasoning (0, the retired
// display-only slot, has no meaning any more)
const PLACEMENT = { 1: "user_input", 2: "ai_output", 3: "slash", 5: "wi", 6: "reasoning" };
export function normalizeRegex(raw) {
  if (!raw || typeof raw.findRegex !== "string") return null;
  let find = raw.findRegex;
  let flags = "";
  const m = /^\/(.*)\/([a-z]*)$/s.exec(find);
  if (m) { find = m[1]; flags = m[2]; }
  const placement = Array.isArray(raw.placement)
    ? Array.from(new Set(raw.placement.map((n) => PLACEMENT[n]).filter(Boolean)))
    : ["ai_output"];
  return {
    scriptName: typeof raw.scriptName === "string" ? raw.scriptName : "imported",
    ...(typeof raw.folder === "string" && raw.folder.trim() ? { folder: raw.folder.trim() } : {}),
    ...(raw._studioScope && typeof raw._studioScope === "object" ? { _studioScope: raw._studioScope } : {}),
    findRegex: find, replaceString: typeof raw.replaceString === "string" ? raw.replaceString : "",
    placement,
    // WHEN it applies: neither flag = the saved text is rewritten
    markdownOnly: raw.markdownOnly === true,
    promptOnly: raw.promptOnly === true,
    runOnEdit: raw.runOnEdit === true,
    trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.map(String) : [],
    flags,
    minDepth: typeof raw.minDepth === "number" && raw.minDepth >= -1 ? raw.minDepth : null,
    maxDepth: typeof raw.maxDepth === "number" && raw.maxDepth >= 0 ? raw.maxDepth : null,
    disabled: raw.disabled === true,
    ...(raw.substituteRegex === 1 ? { macroMode: "raw" } : raw.substituteRegex === 2 ? { macroMode: "escaped" } : {}),
  };
}
