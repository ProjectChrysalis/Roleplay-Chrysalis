import { unslugTitle } from "./entries.js";

/** A timestamp in any shape chat files carry: epoch milliseconds, ISO 8601,
 *  "June 19, 2023 2:20pm", or a file-name stamp like 2024-07-12@01h31m37s123ms
 *  (also "2024-6-5 @14h 56m 50s 682ms"). null when it is none of these. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function chatTime(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const meridiem = /(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i.exec(v);
  if (meridiem) {
    const month = MONTHS.indexOf(meridiem[1].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const hour = (Number(meridiem[4]) % 12) + (meridiem[6].toLowerCase() === "pm" ? 12 : 0);
    return new Date(Number(meridiem[3]), month, Number(meridiem[2]), hour, Number(meridiem[5])).getTime();
  }
  const stamp = /(\d{4})-(\d{1,2})-(\d{1,2}) ?@(\d{1,2})h ?(\d{1,2})m ?(\d{1,2})s(?: ?(\d{1,3})ms)?/.exec(v);
  if (stamp) return Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6]), Number(stamp[7] || 0));
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

export function normalizeChatLines(raw) {
  // raw: {character?: string, file?: string, lines: [public chat-line objects]}
  if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return null;
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const header = raw.lines[0] && typeof raw.lines[0].mes !== "string" ? raw.lines[0] : null;
  let last = (header && chatTime(header.create_date)) ?? Date.now();
  const msgs = [];
  for (const l of raw.lines) {
    if (!l || typeof l.mes !== "string") continue;
    const isUser = l.is_user === true;
    // our own backups tuck the fields the public line shape has no room for
    // into extra.chry — a hidden turn, a bookmark, a generated picture, a
    // translation, and the model/usage/reasoning stamp on the reply
    const own = l.extra && typeof l.extra === "object" && l.extra.chry && typeof l.extra.chry === "object" ? l.extra.chry : null;
    const x = own || {};
    const foreign = !own && l.extra && typeof l.extra === "object" ? l.extra : {};
    // elsewhere is_system marks a turn hidden from the model, and narration
    // is its own message type; our backups use is_system for system turns
    const role = isUser ? "user" : own ? (l.is_system === true ? "system" : "char") : foreign.type === "narrator" ? "system" : "char";
    const at = chatTime(l.send_date) ?? last;
    last = at;
    const swipes = Array.isArray(l.swipes) && l.swipes.length ? l.swipes.map(String) : [l.mes];
    // thinking rides each swipe; the active swipe's is the message's own
    const info = Array.isArray(l.swipe_info) ? l.swipe_info : [];
    const thought = (e) => (e && typeof e.reasoning === "string" && e.reasoning ? { reasoning: e.reasoning } : null);
    const swipeMeta = swipes.map((_, i) => thought(info[i]?.extra));
    const active = typeof l.swipe_id === "number" && l.swipe_id >= 0 && l.swipe_id < swipes.length ? l.swipe_id : 0;
    const reasoning = thought(foreign) ?? swipeMeta[active];
    const imported = !own && (reasoning || swipeMeta.some(Boolean))
      ? { ...(reasoning ?? {}), ...(typeof foreign.model === "string" && foreign.model ? { model: foreign.model } : {}), ...(swipes.length > 1 ? { swipeMeta } : {}) }
      : null;
    msgs.push({
      id: uid("e"), name: typeof l.name === "string" ? l.name : (isUser ? "User" : "Character"),
      charId: (l.extra && typeof l.extra.chry_char_id === "string" && l.extra.chry_char_id) || null,
      role, text: l.mes, at, swipes, swipe: active,
      ...((own ? x.hidden === true : l.is_system === true) ? { hidden: true } : {}),
      ...(x.bookmarked === true || x.bookmark ? { bookmarked: true } : {}),
      ...(typeof x.bookmarkLabel === "string" ? { bookmarkLabel: x.bookmarkLabel } : typeof x.bookmark === "string" ? { bookmarkLabel: x.bookmark } : {}),
      ...(x.edited === true ? { edited: true } : {}),
      ...(x.greeting === true ? { greeting: true } : {}),
      ...(x.picture ? { picture: x.picture } : {}),
      ...(typeof x.translation === "string" && x.translation ? { translation: x.translation } : {}),
      ...(x.extra && typeof x.extra === "object" ? { extra: x.extra } : imported ? { extra: imported } : {}),
    });
  }
  if (!msgs.length) return null;
  const title = (raw.character ? raw.character + " — " : "") + unslugTitle(raw.file || "imported chat");
  return { title, msgs, header };
}
