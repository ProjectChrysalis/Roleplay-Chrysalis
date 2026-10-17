export function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function rollDice(arg) {
  const a = String(arg).trim();
  let m = /^(\d+)$/.exec(a);
  if (m) return 1 + Math.floor(Math.random() * Number(m[1])); // bare N = 1dN
  m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(a);
  if (!m) return "";
  const n = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const mod = m[3] ? Number(m[3]) : 0;
  if (n < 1 || n > 100 || sides < 2 || sides > 10000) return "";
  let total = mod;
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total);
}
/** "3 minutes" / "2 hours" / "5 days" — coarse humanized span for {{idle_duration}}. */
export function humanIdle(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const mins = Math.floor(s / 60);
  if (mins < 60) return mins + " minute" + (mins === 1 ? "" : "s");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " hour" + (hours === 1 ? "" : "s");
  const days = Math.floor(hours / 24);
  return days + " day" + (days === 1 ? "" : "s");
}
/**
 * Macro expansion. `mc` carries everything the macros can touch:
 *   userName/charName/personaText/chatId — identity
 *   card: {description, personality, scenario, mesExamples, systemPrompt,
 *     postHistory, creatorNotes, version} — card-field macros
 *   vars — chat-local variable map ({{setvar}} writes INTO this object;
 *     callers that saveChat afterwards persist the mutations)
 *   globals — variables every chat shares (same contract; see globalVars)
 *   group/groupNotMuted — member name lists; model; lastMessageId; genType;
 *     maxContext/maxResponse — the preset's token limits
 *   lastMessage/lastUserMessage/lastCharMessage/idleText — chat context
 *   summary — the running chat summary
 *   words — summarize-prompt budget ({{words}}/{{limit}})
 *
 * Text is evaluated once, in document order: a variable set early is visible
 * to everything after it, and only the taken branch of a conditional runs.
 * A macro nobody defines stays as written (its arguments still expand), so a
 * later pass or another tool can pick it up.
 *
 * Syntax: {{name}}, {{name::a::b}}, {{name a}} and {{name:a}} (one argument);
 * {{if cond}}…{{else}}…{{/if}} with ! to negate; {{setvar::x}}…{{/setvar}} and
 * other block forms; variable shorthand {{.x}} (chat) / {{$x}} (shared) with
 * = += -= ++ -- == != > >= < <= || ?? ||= ??=; a leading # keeps a block's
 * whitespace (so {{#if}} works), otherwise blocks are trimmed and dedented.
 */
const MACRO_OPS = ["++", "--", "??=", "??", "||=", "||", "-=", "==", "!=", ">=", ">", "<=", "<", "+=", "="];
const MACRO_VAR = "[a-zA-Z](?:[\\w-]*\\w)?";
const MACRO_BAD = { kind: "bad", closing: false, keep: false, name: "", args: [] };
const macroFalsy = (v) => { const s = String(v == null ? "" : v).trim().toLowerCase(); return s === "" || s === "off" || s === "false" || s === "0"; };

/** Split text into literal runs (strings) and {{…}} macros. Braces are
 *  matched, so a macro can carry macros in its arguments; an opener that
 *  never closes is ordinary text. */
function macroItems(text) {
  const items = [];
  const n = text.length;
  let i = 0, last = 0;
  while (i < n) {
    let at = text.indexOf("{{", i);
    if (at < 0) break;
    while (text.charCodeAt(at + 2) === 123) at++; // "{{{x}}": the first brace is literal
    let depth = 0, k = at, end = -1;
    while (k < n - 1) {
      const c = text.charCodeAt(k);
      if (c === 123 && text.charCodeAt(k + 1) === 123) { depth++; k += 2; }
      else if (c === 125 && text.charCodeAt(k + 1) === 125) { depth--; k += 2; if (depth === 0) { end = k; break; } }
      else k++;
    }
    if (end < 0) { i = at + 2; continue; }
    if (at > last) items.push(text.slice(last, at));
    items.push({ raw: text.slice(at, end), inner: text.slice(at + 2, end - 2), head: MACRO_BAD, pair: -1 });
    last = i = end;
  }
  if (last < n) items.push(text.slice(last));
  return items;
}
/** Split on "::" outside nested macros. */
function macroSplit(s) {
  const out = [];
  let depth = 0, from = 0;
  for (let k = 0; k < s.length - 1; k++) {
    const c = s.charCodeAt(k), d = s.charCodeAt(k + 1);
    if (c === 123 && d === 123) { depth++; k++; }
    else if (c === 125 && d === 125) { if (depth > 0) depth--; k++; }
    else if (c === 58 && d === 58 && depth === 0) { out.push(s.slice(from, k)); from = k + 2; k++; }
  }
  out.push(s.slice(from));
  return out;
}
/** What a macro's inside says: flags, then a comment, a variable expression
 *  or a name with arguments. Anything else is "bad" and stays as written. */
function macroHead(inner) {
  let s = inner.replace(/^\s+/, "");
  let closing = false, keep = false;
  // {{//}} … {{///}} is a comment block; a lone {{// note}} is a comment line
  if (s.trim() === "///") return { kind: "comment", closing: true, keep, name: "//", args: [], tail: "" };
  for (;;) {
    if (s.startsWith("//")) return { kind: "comment", closing, keep, name: "//", args: [], tail: s.slice(2) };
    const c = s[0];
    if (c === "/") closing = true;
    else if (c === "#") keep = true;
    else if (c !== "!" && c !== "?" && c !== "~" && c !== ">") break;
    s = s.slice(1).replace(/^\s+/, "");
  }
  if (s[0] === "." || s[0] === "$") {
    const m = new RegExp("^" + MACRO_VAR).exec(s.slice(1));
    if (!m) return MACRO_BAD;
    let rest = s.slice(1 + m[0].length).replace(/^\s+/, "");
    let op = "";
    if (rest) {
      op = MACRO_OPS.find((o) => rest.startsWith(o)) || "";
      if (!op) return MACRO_BAD;
      rest = rest.slice(op.length);
    }
    return { kind: "var", closing, keep, name: m[0], args: [], global: s[0] === "$", op, value: rest.trim() };
  }
  const m = /^[a-zA-Z][\w-]*/.exec(s);
  if (!m) return MACRO_BAD;
  let rest = s.slice(m[0].length);
  if (rest && !/^[\s:|]/.test(rest)) return MACRO_BAD;
  rest = rest.replace(/^\s+/, "");
  let args;
  if (rest.startsWith("::")) {
    rest = rest.slice(2);
    args = macroSplit(rest).map((x) => x.trim());
  } else {
    if (rest[0] === ":") rest = rest.slice(1);
    args = rest.trim() ? [rest.trim()] : [];
  }
  return { kind: "macro", closing, keep, name: m[0].toLowerCase(), args, tail: rest };
}
// block forms: the macro takes the text up to its {{/name}} as one more
// argument when it was written with exactly this many
const MACRO_BLOCK = new Map([["if", 1], ["setvar", 1], ["addvar", 1], ["setglobalvar", 1], ["addglobalvar", 1], ["trim", 0]]);
/** Parse text and pair each block opener with its closer. A closer also ends
 *  any block left open inside it; an opener without a closer is not a block. */
function macroDoc(text) {
  const items = macroItems(text);
  const open = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it === "string") continue;
    const h = (it.head = macroHead(it.inner));
    if (h.kind !== "macro" && h.kind !== "comment") continue;
    if (h.closing) {
      for (let s = open.length - 1; s >= 0; s--) {
        if (items[open[s]].head.name !== h.name) continue;
        items[open[s]].pair = i;
        open.length = s;
        break;
      }
    } else if (h.kind === "comment" ? !h.tail.trim() : MACRO_BLOCK.get(h.name) === h.args.length) {
      open.push(i);
    }
  }
  return items;
}
/** Trim a block and drop the indentation its first line carries, so a block
 *  can sit on its own indented lines without leaking that layout. */
function macroDedent(s) {
  if (!s) return "";
  const lines = s.split("\n");
  const first = lines.find((l) => l.trim() !== "");
  const base = first ? /^[ \t]*/.exec(first)[0].length : 0;
  if (!base) return s.trim();
  return lines.map((l) => (/^[ \t]*/.exec(l)[0].length >= base ? l.slice(base) : l.replace(/^\s+/, ""))).join("\n").trim();
}

const macroStore = (mc, global) => (global ? mc.globals || (mc.globals = {}) : mc.vars || (mc.vars = {}));
const macroHas = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] != null;
const macroGet = (mc, global, k) => { const o = macroStore(mc, global); return macroHas(o, k) ? String(o[k]) : ""; };
/** Add to a variable: numbers sum, a JSON list gains an item, anything else
 *  appends as text. Returns the new value. */
function macroAdd(mc, global, k, v) {
  const o = macroStore(mc, global);
  const cur = macroHas(o, k) ? String(o[k]) : "";
  if (cur[0] === "[") {
    try {
      const arr = JSON.parse(cur);
      if (Array.isArray(arr)) { arr.push(v); return (o[k] = JSON.stringify(arr)); }
    } catch { /* not a list */ }
  }
  const inc = Number(v), base = Number(cur || 0);
  return (o[k] = Number.isNaN(inc) || Number.isNaN(base) ? cur + v : String(base + inc));
}
/** {{.name}} / {{$name}} with an optional operator. The right-hand side only
 *  expands when the operator needs it. */
function macroVar(h, mc, sub) {
  const o = macroStore(mc, h.global), k = h.name;
  const cur = () => (macroHas(o, k) ? String(o[k]) : "");
  let cached = null;
  const val = () => (cached == null ? (cached = sub(h.value).trim()) : cached);
  const cmp = (f) => { const x = Number(cur()), y = Number(val()); return !Number.isNaN(x) && !Number.isNaN(y) && f(x, y) ? "true" : "false"; };
  switch (h.op) {
    case "": return cur();
    case "=": o[k] = val(); return "";
    case "++": return macroAdd(mc, h.global, k, "1");
    case "--": return macroAdd(mc, h.global, k, "-1");
    case "+=": macroAdd(mc, h.global, k, val()); return "";
    case "-=": { const y = Number(val()); if (!Number.isNaN(y)) macroAdd(mc, h.global, k, String(-y)); return ""; }
    case "||": return macroFalsy(cur()) ? val() : cur();
    case "??": return macroHas(o, k) ? cur() : val();
    case "||=": if (macroFalsy(cur())) o[k] = val(); return cur();
    case "??=": if (!macroHas(o, k)) o[k] = val(); return cur();
    case "==": return cur() === val() ? "true" : "false";
    case "!=": return cur() !== val() ? "true" : "false";
    case ">": return cmp((x, y) => x > y);
    case ">=": return cmp((x, y) => x >= y);
    case "<": return cmp((x, y) => x < y);
    case "<=": return cmp((x, y) => x <= y);
  }
  return "";
}

const MACRO_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MACRO_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const p2 = (n) => String(n).padStart(2, "0");
/** Format a date from pattern letters (YYYY MM DD HH mm ss, month and day
 *  names, 12-hour clock, offset); [bracketed] text is literal. */
function macroDateFormat(d, fmt) {
  const h12 = d.getHours() % 12 || 12, off = -d.getTimezoneOffset();
  const zone = (sep) => (off < 0 ? "-" : "+") + p2(Math.floor(Math.abs(off) / 60)) + sep + p2(Math.abs(off) % 60);
  const nth = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const t = {
    YYYY: d.getFullYear(), YY: p2(d.getFullYear() % 100),
    MMMM: MACRO_MONTHS[d.getMonth()], MMM: MACRO_MONTHS[d.getMonth()].slice(0, 3), MM: p2(d.getMonth() + 1), M: d.getMonth() + 1,
    Do: nth(d.getDate()), DD: p2(d.getDate()), D: d.getDate(),
    dddd: MACRO_DAYS[d.getDay()], ddd: MACRO_DAYS[d.getDay()].slice(0, 3), dd: MACRO_DAYS[d.getDay()].slice(0, 2),
    HH: p2(d.getHours()), H: d.getHours(), hh: p2(h12), h: h12,
    mm: p2(d.getMinutes()), m: d.getMinutes(), ss: p2(d.getSeconds()), s: d.getSeconds(),
    A: d.getHours() < 12 ? "AM" : "PM", a: d.getHours() < 12 ? "am" : "pm",
    ZZ: zone(""), Z: zone(":"), X: Math.floor(d.getTime() / 1000), x: d.getTime(),
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|HH|H|hh|h|mm|m|ss|s|A|a|ZZ|Z|X|x/g, (tok, lit) => (lit != null ? lit : String(t[tok])));
}
const macroList = (a) => (a.length !== 1 ? a
  : a[0].indexOf("::") >= 0 ? a[0].split("::").map((x) => x.trim())
  : a[0].replace(/\\,/g, "\u0001").split(",").map((x) => x.replace(/\u0001/g, ",").trim()));
const macroCount = (a) => { const n = Math.floor(Number(a[0])); return a.length && n >= 0 && n <= 1000 ? n : 1; };

// name → (args, mc, head) => text. Returning undefined leaves the macro as written.
const MACROS = Object.assign(Object.create(null), {
  if: () => "", // evaluated by macroIf: its branches must not expand up front
  else: () => "",
  noop: () => "",
  banned: () => "",
  // without a block, {{trim}} eats the newlines around itself once everything else is expanded
  trim: (a) => (a.length ? a[0] : "{{trim}}"),
  newline: (a) => "\n".repeat(macroCount(a)),
  space: (a) => " ".repeat(macroCount(a)),
  reverse: (a) => Array.from(a.join("::")).reverse().join(""),
  // random re-rolls on every resolution; pick is stable per chat+content
  random: (a) => { const o = macroList(a); return o.length ? o[Math.floor(Math.random() * o.length)] : ""; },
  pick: (a, mc, h) => { const o = macroList(a); return o.length ? o[strHash((mc.chatId || "") + "|" + h.tail) % o.length] : ""; },
  roll: (a) => String(rollDice(a[0] || "")),
  time: (a) => {
    const m = /^UTC([+-]\d+)$/i.exec(a[0] || "");
    if (!m) return new Date().toLocaleTimeString();
    const d = new Date(Date.now() + Number(m[1]) * 3600000);
    return (d.getUTCHours() % 12 || 12) + ":" + p2(d.getUTCMinutes()) + (d.getUTCHours() < 12 ? " AM" : " PM");
  },
  isotime: () => macroDateFormat(new Date(), "HH:mm"),
  date: () => new Date().toLocaleDateString(),
  isodate: () => macroDateFormat(new Date(), "YYYY-MM-DD"),
  weekday: () => MACRO_DAYS[new Date().getDay()],
  datetimeformat: (a) => macroDateFormat(new Date(), a.join("::") || "YYYY-MM-DD HH:mm:ss"),
  idle_duration: (a, mc) => mc.idleText || "just now",
  persona: (a, mc) => mc.personaText || "",
  user: (a, mc) => mc.userName || "User",
  char: (a, mc) => mc.charName || "",
  // in a one-on-one chat the "group" is just the character
  group: (a, mc) => (mc.group != null ? mc.group : mc.charName || ""),
  groupnotmuted: (a, mc) => (mc.groupNotMuted != null ? mc.groupNotMuted : mc.group != null ? mc.group : mc.charName || ""),
  description: (a, mc) => (mc.card && mc.card.description) || "",
  personality: (a, mc) => (mc.card && mc.card.personality) || "",
  scenario: (a, mc) => (mc.card && mc.card.scenario) || "",
  mesexamplesraw: (a, mc) => (mc.card && mc.card.mesExamples) || "",
  charprompt: (a, mc) => (mc.card && mc.card.systemPrompt) || "",
  charinstruction: (a, mc) => (mc.card && mc.card.postHistory) || "",
  creatornotes: (a, mc) => (mc.card && mc.card.creatorNotes) || "",
  charversion: (a, mc) => (mc.card && mc.card.version) || "",
  model: (a, mc) => mc.model || "",
  input: (a, mc) => mc.input || "",
  lastgenerationtype: (a, mc) => mc.genType || "",
  lastmessage: (a, mc) => mc.lastMessage || "",
  lastusermessage: (a, mc) => mc.lastUserMessage || "",
  lastcharmessage: (a, mc) => mc.lastCharMessage || "",
  lastmessageid: (a, mc) => (mc.lastMessageId != null ? String(mc.lastMessageId) : ""),
  summary: (a, mc) => mc.summary || "",
  words: (a, mc) => (mc.words != null ? String(mc.words) : undefined),
  maxprompt: (a, mc) => (mc.maxContext != null ? String(mc.maxContext) : undefined),
  maxresponse: (a, mc) => (mc.maxResponse != null ? String(mc.maxResponse) : undefined),
});
for (const [alias, name] of [
  ["idleduration", "idle_duration"], ["charifnotgroup", "group"], ["limit", "words"],
  ["maxprompttokens", "maxprompt"], ["maxcontext", "maxprompt"], ["maxcontexttokens", "maxprompt"], ["maxresponsetokens", "maxresponse"],
  ["chardescription", "description"], ["charpersonality", "personality"], ["charscenario", "scenario"],
  ["mesexamples", "mesexamplesraw"], ["charcreatornotes", "creatornotes"], ["version", "charversion"], ["char_version", "charversion"],
]) MACROS[alias] = MACROS[name];
// the variable macros come in a chat-local and a shared flavour
for (const [v, global] of [["var", false], ["globalvar", true]]) {
  // a call missing its name (or its value, for set/add) is a typo: left as written
  const named = (need, fn) => (a, mc) => (a.length >= need && a[0] ? fn(a, mc) : undefined);
  MACROS["set" + v] = named(2, (a, mc) => { macroStore(mc, global)[a[0]] = a.slice(1).join("::"); return ""; });
  MACROS["add" + v] = named(2, (a, mc) => { macroAdd(mc, global, a[0], a.slice(1).join("::")); return ""; });
  MACROS["inc" + v] = named(1, (a, mc) => macroAdd(mc, global, a[0], "1"));
  MACROS["dec" + v] = named(1, (a, mc) => macroAdd(mc, global, a[0], "-1"));
  MACROS["get" + v] = named(1, (a, mc) => macroGet(mc, global, a[0]));
  MACROS["has" + v] = MACROS[v + "exists"] = named(1, (a, mc) => String(macroHas(macroStore(mc, global), a[0])));
  // null, not a removed key: the write has to survive the merge that commits a turn
  MACROS["delete" + v] = MACROS["flush" + v] = named(1, (a, mc) => { macroStore(mc, global)[a[0]] = null; return ""; });
}
// a bare name is only a condition's subject when the macro needs no argument
const MACRO_NEEDS_ARG = /^(if|else|trim|noop|banned|reverse|random|pick|roll|datetimeformat|newline|space|(set|add|inc|dec|get|has|delete|flush)(global)?var|(global)?varexists)$/;

/** Is this condition true? Empty, "0", "false" and "off" are not. The subject
 *  may be text (macros expand first), a variable ({{if .x}}, also with a
 *  comparison: {{if .x == a}}), or the bare name of a macro ({{if scenario}}). */
function macroCond(raw, mc, depth) {
  let c = String(raw), not = false;
  const neg = /^\s*!\s*/.exec(c);
  if (neg) { not = true; c = c.slice(neg[0].length); }
  c = macroRun(c, mc, depth + 1).trim();
  if (c[0] === "." || c[0] === "$") {
    const h = macroHead(c);
    if (h.kind === "var") c = macroVar(h, mc, (t) => macroRun(t, mc, depth + 1));
  } else if (/^[a-zA-Z][\w-]*$/.test(c) && MACROS[c.toLowerCase()] && !MACRO_NEEDS_ARG.test(c.toLowerCase())) {
    c = macroRun("{{" + c + "}}", mc, depth + 1);
  }
  return macroFalsy(c) === not;
}
function macroIf(items, i, mc, depth) {
  const it = items[i], h = it.head;
  let body = items, a = i + 1, b = it.pair;
  if (b < 0) {
    // one-line form: {{if::cond::text}}. An opener with no closer stays as written.
    if (h.args.length < 2) return it.raw;
    body = macroDoc(h.args.slice(1).join("::"));
    a = 0;
    b = body.length;
  }
  // the first {{else}} outside any nested block splits the branches
  let split = -1;
  for (let k = a; k < b; k++) {
    const x = body[k];
    if (typeof x === "string") continue;
    if (x.pair > k) { k = x.pair; continue; }
    if (x.head.kind === "macro" && x.head.name === "else" && !x.head.closing) { split = k; break; }
  }
  const yes = macroCond(h.args[0] || "", mc, depth);
  const out = yes ? macroRange(body, a, split < 0 ? b : split, mc, depth + 1)
    : split < 0 ? "" : macroRange(body, split + 1, b, mc, depth + 1);
  return h.keep ? out : macroDedent(out);
}
function macroEval(items, i, mc, depth) {
  const it = items[i], h = it.head;
  if (h.closing) return it.raw; // a closer nothing opened
  if (h.kind === "comment") return "";
  const sub = (t) => macroRun(t, mc, depth + 1);
  if (h.kind === "var") return macroVar(h, mc, sub);
  const fn = h.kind === "macro" ? MACROS[h.name] : null;
  if (!fn) return "{{" + sub(it.inner) + "}}";
  if (h.name === "if") return macroIf(items, i, mc, depth);
  const args = h.args.map(sub);
  if (it.pair > i) {
    const body = macroRange(items, i + 1, it.pair, mc, depth + 1);
    args.push(h.keep ? body : macroDedent(body));
  }
  const out = fn(args, mc, h);
  return out === undefined ? it.raw : String(out);
}
function macroRange(items, a, b, mc, depth) {
  let out = "";
  for (let i = a; i < b; i++) {
    const it = items[i];
    if (typeof it === "string") { out += it; continue; }
    out += macroEval(items, i, mc, depth);
    if (it.pair > i) i = it.pair; // the block's body and closer are consumed
  }
  return out;
}
function macroRun(text, mc, depth) {
  if (depth > 60 || text.indexOf("{{") < 0) return text;
  const items = macroDoc(text);
  return macroRange(items, 0, items.length, mc, depth);
}
export function expandMacros(text, mc) {
  let out = String(text);
  // older spellings: bare angle markers, and the time offset joined by "_"
  if (out.indexOf("<") >= 0) {
    out = out.replace(/<USER>/gi, "{{user}}").replace(/<(?:BOT|CHAR)>/gi, "{{char}}")
      .replace(/<GROUP>/gi, "{{group}}").replace(/<CHARIFNOTGROUP>/gi, "{{charIfNotGroup}}");
  }
  if (out.indexOf("{{") < 0) return out;
  out = out.replace(/\{\{time_(UTC[+-]\d+)\}\}/gi, "{{time::$1}}");
  out = macroRun(out, mc || {}, 0);
  out = out.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, "");
  // \{\{ and \}\} are how a prompt writes literal double braces
  return out.replace(/\\\{\\\{/g, "{{").replace(/\\\}\\\}/g, "}}");
}
/** The card fields macros can read. */
export function macroCard(card) {
  const f = (v) => (v ? String(v) : "");
  return card ? {
    description: f(card.description), personality: f(card.personality), scenario: f(card.scenario),
    mesExamples: f(card.mes_example), systemPrompt: f(card.system_prompt), postHistory: f(card.post_history_instructions),
    creatorNotes: f(card.creator_notes), version: f(card.character_version),
  } : {};
}
