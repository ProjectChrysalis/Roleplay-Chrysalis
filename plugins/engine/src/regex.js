import { state } from "./state.js";
import { expandMacros, macroCard } from "./macros.js";
import { readFiles } from "./paging.js";
import { chatUserName } from "./prompt.js";
import { globalVars, transcriptMacros } from "./variables.js";

/** Escape a literal so it can be embedded in a regex pattern verbatim. */
const escapeRegexLiteral = (v) => String(v ?? "")
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

/** macroMode "escaped" needs the macro VALUES regex-escaped while the
 *  surrounding pattern stays intact — clone the context with its scalar
 *  fields escaped. */
function macroEscapedContext(mc) {
  if (!mc || typeof mc !== "object") return mc;
  const esc = (v) => (typeof v === "string" ? escapeRegexLiteral(v) : v);
  const out = { ...mc };
  for (const k of ["userName", "charName", "personaText", "chatId", "lastMessage", "lastUserMessage", "lastCharMessage", "idleText", "summary", "group", "groupNotMuted", "model", "input"]) out[k] = esc(out[k]);
  if (out.card && typeof out.card === "object") {
    out.card = { ...out.card };
    for (const k of Object.keys(out.card)) out.card[k] = esc(out.card[k]);
  }
  return out;
}

/** Script execution order: global first, then preset-bound, then scoped
 *  (character/chat); `order` sequences within a class. */
function regexScopeRank(s) {
  const sc = s.scope || "global";
  if (sc === "global") return 0;
  if (sc === "preset") return 1;
  return 2;
}

/** The scripts that can run in this chat. A library holds thousands, most
 *  bound to some other preset, card or chat; a cheap look at the raw file
 *  skips those before they are parsed. The same chat asks again for every
 *  message a call saves, so a call keeps its answer. */
export function loadRegexScripts(fsx, meta, members) {
  const presetId = (meta && meta.presetId) || "default";
  const targets = new Set([meta && meta.id, meta && meta.characterId, ...(members || []).map((x) => x && x.id), presetId].filter(Boolean));
  const key = [...targets].join("|");
  if (state.regexScriptsFor && state.regexScriptsFor.key === key) return state.regexScriptsFor.scripts;
  const elsewhere = (text) => {
    const scope = /"scope"\s*:\s*"(chat|character|preset)"/.exec(text);
    if (!scope) return false;
    const target = /"scopeTargetId"\s*:\s*"([^"\\]*)"/.exec(text);
    return !target || !targets.has(target[1]);
  };
  let scripts = [];
  let files = [];
  try { files = fsx.list("regex").filter((f) => f.endsWith(".json")); } catch {}
  const texts = readFiles(fsx, files.map((f) => "regex/" + f));
  for (const text of texts) {
    if (text == null || (meta && elsewhere(text))) continue;
    try { const script = JSON.parse(text); if (script) scripts.push(script); } catch { /* unreadable script */ }
  }
  scripts = scripts.sort((a, b) =>
    regexScopeRank(a) - regexScopeRank(b) ||
    ((a.order ?? 0) - (b.order ?? 0)) ||
    String(a.scriptName ?? "").localeCompare(String(b.scriptName ?? "")));
  state.regexScriptsFor = meta ? { key, scripts } : null;
  return scripts;
}

/** text.replace(re, fn) with the matching done by hostRegex. */
function replaceWithHost(text, find, flags, fn) {
  let out = "";
  let last = 0;
  for (const m of state.hostRegex.matches(find, flags, text)) {
    const groups = m.groups.map((g) => (g === null ? undefined : g));
    out += text.slice(last, m.index) + fn(m.match, ...groups, m.index, text, ...(m.named ? [m.named] : []));
    last = m.index + m.match.length;
  }
  return out + text.slice(last);
}

/** One script over one string — the studio replace semantics: {{match}} is
 *  the whole (trimmed) match, $n / $<name> pull captured groups — each
 *  trimmed of the script's trim strings, a missing group vanishes — and
 *  macros substitute in the replacement. The FIND side substitutes macros
 *  per the script's macroMode (none / raw / escaped). */
function applyRegexScript(s, input, mc) {
  let find = String(s.findRegex ?? "");
  if (!find || find.length > 500) return String(input);
  if (s.macroMode === "raw") find = expandMacros(find, mc);
  else if (s.macroMode === "escaped") find = expandMacros(find, macroEscapedContext(mc));
  const flags = s.flags ?? "g";
  let re;
  try { re = new RegExp(find, flags); } catch { return String(input); }
  const trims = (Array.isArray(s.trimStrings) ? s.trimStrings : [])
    .map((t) => expandMacros(String(t), mc)).filter(Boolean);
  const trim = (v) => { let out = v; for (const t of trims) out = out.split(t).join(""); return out; };
  const replace = String(s.replaceString ?? "");
  const text = String(input).slice(0, 20000);
  try {
    const replacer = (...args) => {
      // (match, p1..pn, offset, string[, named-groups object]) — a $n beyond
      // the capture count would read the offset and leak it; those vanish
      const last = args[args.length - 1];
      const hasNamed = last != null && typeof last === "object";
      const nGroups = hasNamed ? args.length - 4 : args.length - 3;
      const groups = hasNamed ? last : null;
      let out = replace.replace(/\{\{match\}\}/gi, "\u0000");
      out = out.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
        if (num && Number(num) > nGroups) return "";
        const v = num ? args[Number(num)] : (groups ? groups[name] : undefined);
        return v != null && v !== "" ? trim(String(v)) : "";
      });
      out = out.split("\u0000").join(trim(String(args[0] ?? "")));
      return expandMacros(out, mc);
    };
    return state.hostRegex ? replaceWithHost(text, find, flags, replacer) : text.replace(re, replacer);
  } catch { return String(input); }
}

const REGEX_WHERE = ["user_input", "ai_output", "slash", "wi", "reasoning"];
/** A script's two axes: WHERE it applies (placement) and WHEN. With neither
 *  "only" flag the text is rewritten as the message is saved; markdownOnly
 *  changes only what is shown; promptOnly only what the model reads; both
 *  together change display and prompt but never the saved text. Scripts saved
 *  before the flags existed listed "display"/"prompt" among their placements;
 *  they read as the flags that reproduce what they used to do. */
export function regexAxes(s) {
  const pl = Array.isArray(s.placement) ? s.placement : [];
  const where = pl.filter((p) => REGEX_WHERE.includes(p));
  if (typeof s.markdownOnly === "boolean" || typeof s.promptOnly === "boolean") {
    return { where, markdownOnly: s.markdownOnly === true, promptOnly: s.promptOnly === true };
  }
  if (pl.includes("prompt") && !where.includes("wi")) where.push("wi");
  const roles = where.some((p) => p === "user_input" || p === "ai_output");
  if (!pl.includes("display")) return { where, markdownOnly: false, promptOnly: true };
  if (!roles && !pl.includes("prompt")) return { where: [...where, "user_input", "ai_output"], markdownOnly: true, promptOnly: false };
  return { where, markdownOnly: true, promptOnly: true };
}

/** Scope + placement + stage + depth gate around applyRegexScript.
 *  `placements` is where the text comes from; `stage` is what is happening
 *  to it: "store" (a message is being saved), "edit" (a saved message was
 *  edited: stored scripts that opted in), or "prompt" (the outgoing prompt). */
export function runRegexScripts(scripts, meta, members, text, placements, depth, mc, stage) {
  const inScope = (s) => {
    const sc = s.scope || "global";
    if (sc === "global") return true;
    if (!s.scopeTargetId) return false;
    if (sc === "chat") return s.scopeTargetId === meta.id;
    if (sc === "character") return s.scopeTargetId === meta.characterId || members.some((x) => x.id === s.scopeTargetId);
    if (sc === "preset") return s.scopeTargetId === (meta.presetId || "default");
    return true;
  };
  let out = String(text);
  for (const s of scripts) {
    if (!s || s.disabled || !inScope(s)) continue;
    const ax = regexAxes(s);
    if (!placements.some((p) => ax.where.includes(p))) continue;
    if (stage === "prompt" ? !ax.promptOnly : ax.markdownOnly || ax.promptOnly) continue;
    if (stage === "edit" && s.runOnEdit !== true) continue;
    if (depth != null && typeof depth === "number") {
      if (s.minDepth != null && s.minDepth >= 0 && depth < s.minDepth) continue;
      if (s.maxDepth != null && s.maxDepth >= 0 && depth > s.maxDepth) continue;
    }
    out = applyRegexScript(s, out, mc);
  }
  return out;
}

/** Macro context for rewriting text as it is saved: the chat's current
 *  persona and the speaking character. */
export function saveMacros(fsx, meta, msgs, speaker) {
  const card = speaker && speaker.card ? speaker.card : null;
  return transcriptMacros(msgs, {
    userName: chatUserName(fsx, meta),
    charName: speaker ? speaker.name : "",
    chatId: meta.id,
    card: macroCard(card),
    vars: meta.chatVars || {},
    globals: globalVars(fsx),
    summary: String(meta.summary || ""),
  });
}

/** A card's greetings (first message, then alternates) as they are saved
 *  into a chat: stored-text regex applies to each. */
export function cardGreetings(fsx, meta, charId, card) {
  const who = { id: charId, name: card.name, card };
  return [card.first_mes || "", ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])]
    .map(String).filter((t) => t.trim())
    .map((t) => regexOnSave(fsx, meta, [who], t, "ai_output", saveMacros(fsx, meta, [], who)));
}

/** Stored-text rewrite for one message about to be saved (user input, a
 *  reply, a greeting, reasoning): the scripts with neither "only" flag. */
export function regexOnSave(fsx, meta, members, text, placement, mc) {
  if (!text) return text;
  return runRegexScripts(loadRegexScripts(fsx, meta, members), meta, members, text, [placement], null, mc, "store");
}
