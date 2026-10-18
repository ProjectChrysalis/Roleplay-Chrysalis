import { chatListing } from "./paging.js";
import { defaultPresetId } from "./presets.js";
import { saveGlobalVars } from "./variables.js";

/** One preset and one persona are current everywhere. A chat locked to its
 *  own keeps it; otherwise a persona locked to the chat's character wins,
 *  then the current one. */
export function chatPresetId(fsx, meta) {
  return meta.presetLocked === true && meta.presetId ? meta.presetId : defaultPresetId(fsx);
}
export function chatPersonaId(fsx, meta) {
  if (meta.personaLocked === true && meta.personaId) return meta.personaId;
  // a group chat's members share the group's lock
  const owner = meta.characterId || meta.groupId;
  if (owner) {
    let bound = [];
    try {
      bound = fsx.list("personas").filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(fsx.read("personas/" + f)); } catch { return null; } })
        .filter((p) => p && p.id && Array.isArray(p.boundCharacterIds) && p.boundCharacterIds.includes(owner));
    } catch {}
    const pick = bound.find((p) => p.autoLock) || bound[0];
    if (pick) return pick.id;
  }
  try { return JSON.parse(fsx.read("settings.json")).personaId || null; } catch { return null; }
}

/** Messages read from the end of a transcript when a chat opens. */
const WINDOW = 400;
/** Recent transcript writes kept on the chat meta. */
const LOG_MAX = 24;
/** A transcript slot not read from disk yet. */
const UNREAD = { unread: true };
/** Transcript arrays handed out by loadChat → where they sit in the file. */
const transcripts = new WeakMap();

const parseRecords = (lines) => {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { return null; }
  }
  return out;
};
const arrayIndex = (key) => {
  if (typeof key !== "string" || !key) return -1;
  const c = key.charCodeAt(0);
  if (c < 48 || c > 57 || (c === 48 && key.length > 1)) return -1;
  const n = Number(key);
  return Number.isInteger(n) ? n : -1;
};

/** The transcript as an array whose earlier messages load when something
 *  reaches them, so a route that works near the end of a long chat never
 *  reads the rest. Null when the window holds a line that does not parse:
 *  then the whole file is read and repaired the plain way. */
function openTranscript(fsx, file) {
  const tail = fsx.lines(file, -WINDOW);
  const parsed = parseRecords(tail.lines);
  if (!parsed) return null;
  const target = new Array(tail.total);
  const st = { file, target, offset: tail.from, total: tail.total, raw: new Array(tail.total), version: tail.version, aligned: true, read: (from, to) => fsx.lines(file, from, to) };
  if (st.offset > 0) target.fill(UNREAD, 0, st.offset);
  for (let i = 0; i < parsed.length; i++) { target[st.offset + i] = parsed[i]; st.raw[st.offset + i] = tail.lines[i]; }
  // reading earlier: twice what is loaded each time, so walking back from
  // the end costs a few reads rather than one per message
  const loadTo = (index) => {
    const want = Math.max(0, Math.min(index, st.offset - Math.max(WINDOW, target.length - st.offset)));
    const got = fsx.lines(file, want, st.offset);
    if (got.version !== st.version || got.lines.length !== st.offset - want) throw new Error("This chat changed on disk while it was open. Try again.");
    const earlier = parseRecords(got.lines);
    if (earlier) {
      for (let i = 0; i < earlier.length; i++) { target[want + i] = earlier[i]; st.raw[want + i] = got.lines[i]; }
      st.offset = want;
      return;
    }
    // a line torn by a crash costs that line; positions no longer match the
    // file, so the next save writes the whole transcript
    const head = fsx.lines(file, 0, st.offset);
    if (head.version !== st.version) throw new Error("This chat changed on disk while it was open. Try again.");
    const kept = [];
    for (const line of head.lines) { try { kept.push(JSON.parse(line)); } catch { /* unreadable line */ } }
    const rest = target.slice(st.offset);
    target.length = 0;
    for (const m of kept) target.push(m);
    for (const m of rest) target.push(m);
    st.offset = 0;
    st.aligned = false;
  };
  const reach = (key) => {
    if (st.offset === 0) return;
    const i = arrayIndex(key);
    if (i >= 0 && i < st.offset) loadTo(i);
  };
  const msgs = new Proxy(target, {
    get(t, key, receiver) { reach(key); return Reflect.get(t, key, receiver); },
    // straight onto the array: passing the proxy as receiver sends every
    // write back through defineProperty, which QuickJS rejects for length
    set(t, key, value) {
      if (key === "length" && st.offset > 0 && Number(value) < st.offset) loadTo(Number(value));
      else reach(key);
      return Reflect.set(t, key, value);
    },
    deleteProperty(t, key) { reach(key); return Reflect.deleteProperty(t, key); },
    defineProperty(t, key, desc) { reach(key); return Reflect.defineProperty(t, key, desc); },
    getOwnPropertyDescriptor(t, key) { reach(key); return Reflect.getOwnPropertyDescriptor(t, key); },
  });
  transcripts.set(msgs, st);
  return msgs;
}

export function loadChat(fsx, id) {
  const meta = (() => { try { return JSON.parse(fsx.read("chats/" + id + ".meta.json")); } catch { return null; } })();
  if (!meta) return null;
  meta.presetId = chatPresetId(fsx, meta);
  meta.personaId = chatPersonaId(fsx, meta);
  const file = "chats/" + id + ".jsonl";
  if (typeof fsx.lines === "function") {
    const msgs = openTranscript(fsx, file);
    if (msgs) {
      transcripts.get(msgs).log = Array.isArray(meta.transcriptLog) ? meta.transcriptLog : [];
      return { meta, msgs };
    }
  }
  // Only a transcript that is not there is a new chat. One that could not be
  // read (too big for this call, or the disk said no) must fail the route:
  // taken for empty, the next save would write the chat over with nothing.
  let text = "";
  try { text = fsx.read(file); } catch (error) {
    if (!/ENOENT|no such file/i.test(String(error?.message || error))) throw error;
  }
  const msgs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // a line torn by a crash costs that line, not the chat
    try { msgs.push(JSON.parse(line)); } catch { /* unreadable line */ }
  }
  return { meta, msgs };
}

/** Every message of a transcript loadChat returned, as a plain array. */
export function wholeTranscript(msgs) {
  const st = transcripts.get(msgs);
  if (!st) return msgs;
  if (st.offset > 0) void msgs[0];
  return st.target;
}

/** The file version a transcript was read or last saved at. */
export function transcriptVersion(msgs) {
  const st = transcripts.get(msgs);
  return st ? st.version : null;
}

/** A bounded range without materializing the messages between it and the tail. */
export function transcriptPage(msgs, from, limit) {
  const total = msgs.length;
  from = Math.max(0, Math.min(total, Math.floor(Number(from) || 0)));
  const end = Math.min(total, from + limit);
  const st = transcripts.get(msgs);
  const read = (start, stop) => {
    if (!st) return msgs.slice(start, stop);
    const got = st.read(start, stop);
    if (got.version !== st.version) throw new Error("This chat changed on disk while it was open. Try again.");
    const records = parseRecords(got.lines);
    if (!records) throw new Error("This chat contains an unreadable message.");
    return records;
  };
  return { from, messages: read(from, end), total, beforeId: from > 0 ? read(from - 1, from)[0]?.id ?? null : null,
    version: st?.version, next: end < total ? end : null };
}

/** What changed since a client read the transcript at `since`: the messages
 *  from the first one any save since then touched, or null when that is not
 *  known (an older version, or a write that went around saveChat). */
export function transcriptSince(msgs, since, limit) {
  const st = transcripts.get(msgs);
  if (!st || typeof since !== "string" || !since) return null;
  let from;
  if (since === st.version) from = msgs.length;
  else {
    const log = Array.isArray(st.log) ? st.log : [];
    const last = log[log.length - 1];
    if (!Array.isArray(last) || last[0] !== st.version) return null;
    const at = log.findIndex((e) => Array.isArray(e) && e[0] === since);
    if (at < 0) return null;
    from = Math.min(...log.slice(at + 1).map((e) => Number(e[1])));
    if (!Number.isInteger(from) || from < 0) return null;
  }
  from = Math.min(from, msgs.length);
  if (limit) return transcriptPage(msgs, from, limit);
  return { from, messages: msgs.slice(from), total: msgs.length, beforeId: from > 0 ? msgs[from - 1]?.id ?? null : null, version: st.version };
}

/** Log a transcript write as [version after it, first message it changed].
 *  A write that did not start from the last logged version (someone else
 *  wrote the file in between) first logs that version as changed from the
 *  start, so a client holding an older one fetches everything. */
const logWrite = (meta, log, before, after, from) => {
  if (!after) return log;
  const next = Array.isArray(log) ? log.slice() : [];
  const last = next[next.length - 1];
  if (before && !(Array.isArray(last) && last[0] === before)) next.push([before, 0]);
  next.push([after, from]);
  meta.transcriptLog = next.slice(-LOG_MAX);
  return meta.transcriptLog;
};

export function saveChat(fsx, id, meta, msgs) {
  const file = "chats/" + id + ".jsonl";
  const st = transcripts.get(msgs);
  const own = !!st && st.file === file;
  meta.updatedAt = Date.now();
  if (own && st.offset > 0) {
    // the unread messages are older than the window; a user turn among them
    // was already counted
    const listing = chatListing(st.target.slice(st.offset));
    meta.listing = { ...listing, messageCount: st.target.length, hasUser: listing.hasUser || meta.listing?.hasUser === true };
  } else meta.listing = chatListing(own ? st.target : msgs);
  if (own) meta.transcriptLog = st.log;
  if (own && st.aligned && typeof fsx.spliceLines === "function") {
    // records before the first changed message stay on disk as they are
    const t = st.target;
    const end = Math.min(t.length, st.total);
    let from = st.offset;
    while (from < end && JSON.stringify(t[from]) === st.raw[from]) from++;
    if (from < t.length || t.length !== st.total) {
      if (fsx.lines(file, 0, 0).version !== st.version) throw new Error("This chat changed on disk while it was open. Try again.");
      const records = [];
      for (let i = from; i < t.length; i++) records.push(JSON.stringify(t[i]));
      const r = fsx.spliceLines(file, from, records);
      st.raw.length = t.length;
      for (let i = from; i < t.length; i++) st.raw[i] = records[i - from];
      st.total = r.total;
      st.log = logWrite(meta, st.log, st.version, r.version, from);
      st.version = r.version;
    }
  } else {
    const all = own ? wholeTranscript(msgs) : msgs;
    fsx.write(file, all.map((m) => JSON.stringify(m)).join("\n") + (all.length ? "\n" : ""));
    if (typeof fsx.lines === "function") {
      const version = fsx.lines(file, 0, 0).version;
      const log = logWrite(meta, own ? st.log : meta.transcriptLog, null, version, 0);
      if (own) Object.assign(st, { raw: all.map((m) => JSON.stringify(m)), total: all.length, version, aligned: true, log });
    }
  }
  fsx.write("chats/" + id + ".meta.json", JSON.stringify(meta, null, 2) + "\n");
  saveGlobalVars(fsx);
}
