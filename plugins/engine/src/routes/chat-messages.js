import { saveChat, transcriptSince, transcriptVersion, wholeTranscript } from "../chat-files.js";
import { expandMacros } from "../macros.js";
import { applyStashVars } from "../passes.js";
import { chatPersona, chatUserName } from "../prompt.js";
import { cardGreetings, loadRegexScripts, runRegexScripts, saveMacros } from "../regex.js";
import { setSummaryParts, summaryParts } from "../summaries.js";
import { editReplayThinking, restoreSwipeThinking, syncSwipeThinking } from "../thinking.js";
import { uid } from "../util.js";
import { globalVars, transcriptMacros } from "../variables.js";

export function getChatRoute(c) {
  const { req, op, ok, chat, meta, members } = c;
  if (!op && req.method === "GET") {
    const memberList = members.map((m) => ({ id: m.id, name: m.name }));
    // ?since=<version>: only what changed after the copy the client holds
    const part = req.query?.since ? transcriptSince(chat.msgs, String(req.query.since)) : null;
    if (part) return ok({ meta, ...part, members: memberList });
    const version = transcriptVersion(chat.msgs);
    return ok({ meta, messages: wholeTranscript(chat.msgs), ...(version ? { version } : {}), members: memberList });
  }
}
export function patchChatRoute(c) {
  const { req, id, op, ok, readJson, writeJson, body, meta } = c;
  if (!op && req.method === "PATCH") {
    const b = body();
    // no-op guard: the client PATCHes lorebookIds before EVERY generation on
    // book-bound chats — an identical write still touches the file, fires
    // look_changed, and the client's hydrate wipes its staged streaming
    // bubble mid-generation. Nothing changed → no write, no event.
    const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
    const keys = ["title", "presetId", "presetLocked", "personaId", "personaLocked", "model", "authorNote", "lorebookIds", "chatLorebookIds", "userName", "characterId", "groupId",
      "authorNoteObject", "folderId", "chatTags", "backgroundId", "temporary", "summary",
      "memoryCutoffMessageId", "parentChatId", "parentMessageId"];
    // summaries edited in place: [{ id, text }] in order. A part keeps the
    // stretch it covers; one left out or emptied is gone.
    const partsIn = Array.isArray(b.summaryParts) ? b.summaryParts : null;
    if (!partsIn && keys.every((k) => !(k in b) || same(b[k], meta[k]))) return ok(meta);
    const prevPersonaId = meta.personaId;
    const partsNow = partsIn ? summaryParts(meta) : null;
    for (const k of keys) {
      if (k in b) meta[k] = b[k];
    }
    if (partsIn) {
      setSummaryParts(meta, partsIn.map((p) => {
        const known = p && partsNow.find((x) => x.id === p.id);
        return known ? { ...known, text: String(p.text || "") } : null;
      }));
    } else if ("summary" in b) {
      setSummaryParts(meta, summaryParts(meta));
    }
    // switching personas only affects NEW messages ({{user}}, staged turns):
    // past user messages keep the name they were sent under — a chat can
    // mix personas, so history is never rewritten
    if ("personaId" in b && b.personaId !== prevPersonaId) {
      const persona = b.personaId ? readJson("personas/" + b.personaId + ".json", null) : null;
      if (persona && persona.name) meta.userName = persona.name;
    }
    // Settings and automatic binding repairs do not represent chat activity.
    writeJson("chats/" + id + ".meta.json", meta);
    return ok(meta);
  }
}
export function forkChatRoute(c) {
  const { req, fsx, id, op, ok, err, body, chat, meta, forkTitle } = c;
  if (op === "fork" && req.method === "POST") {
    const b = body();
    const idx = typeof b.messageId === "string" && b.messageId ? chat.msgs.findLastIndex((m) => m.id === b.messageId) : chat.msgs.length - 1;
    if (idx < 0) return err(404, "message not found");
    const nid = uid("c");
    const nmeta = { ...meta, id: nid, title: forkTitle(fsx, meta.title), createdAt: Date.now(), updatedAt: Date.now(),
      // branch parentage — the UI's branch tree walks these
      parentChatId: id, parentMessageId: b.messageId || null };
    delete nmeta.tainted;
    const msgs = chat.msgs.slice(0, idx + 1).map((m) => ({ ...m }));
    saveChat(fsx, nid, nmeta, msgs);
    return ok({ meta: nmeta, messages: msgs }, 201);
  }
}
export function deleteChatRoute(c) {
  const { req, fsx, id, op, ok } = c;
  if (!op && req.method === "DELETE") {
    try { fsx.remove("chats/" + id + ".jsonl"); } catch {}
    try { fsx.remove("chats/" + id + ".meta.json"); } catch {}
    return ok({ ok: true });
  }
}
// append a finished message without generating anything (a picture the
// user drew for the scene). Speaks as the chat's character unless a
// member id is given; hidden messages stay out of the prompt.
export function addMessageRoute(c) {
  const { req, fsx, seg, id, op, ok, err, body, touch, chat, meta, members, onSave } = c;
  if (op === "messages" && !seg[3] && req.method === "POST") {
    const b = body();
    const speaker = b.role === "user" ? null : members.find((m) => m.id === b.charId) || members[0] || null;
    const text = onSave(String(b.text || "").trim().slice(0, 20000), speaker ? "ai_output" : "user_input", speaker || members[0] || null);
    const attachments = Array.isArray(b.attachments)
      ? b.attachments.filter((a) => a && typeof a.url === "string" && a.url).slice(0, 8)
      : [];
    if (!text && !attachments.length) return err(400, "text or attachments required");
    if (b.role !== "user" && !speaker) return err(400, "chat has no participating characters");
    const who = chatPersona(fsx, meta);
    const msg = {
      id: uid(), name: speaker ? speaker.name : who.userName, charId: speaker ? speaker.id : null,
      ...(!speaker && who.personaId ? { personaId: who.personaId } : {}),
      role: speaker ? "char" : "user", text, at: Date.now(), swipes: [text], swipe: 0,
      ...(b.hidden === true ? { hidden: true } : {}),
      ...(b.picture === true ? { picture: true } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    chat.msgs.push(msg);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ message: msg }, 201);
  }
}
// message edit (text) or flag flips (hide-from-AI, bookmarks)
export function editMessageRoute(c) {
  const { req, fsx, seg, id, op, ok, err, body, touch, chat, meta, members } = c;
  if (op === "messages" && seg[3] && !seg[4] && req.method === "PATCH") {
    const mid = seg[3];
    const idx = chat.msgs.findLastIndex((m) => m.id === mid);
    if (idx < 0) return err(404, "message not found");
    const b = body();
    const msg = chat.msgs[idx];
    if (b.swipeIndex !== undefined && b.swipeIndex !== (msg.swipe || 0)) return err(409, "Reply changed, try again");
    let next = { ...msg };
    if (typeof b.text === "string" && b.text.trim()) {
      // scripts opted into edit-time rewriting clean the stored text itself
      // (the edit is an explicit user action — destructive by nature)
      const speaker = members.find((x) => x.id === msg.charId) || members[0] || null;
      const text = runRegexScripts(
        loadRegexScripts(fsx, meta, members), meta, members, b.text,
        [msg.role === "user" ? "user_input" : "ai_output"], null, saveMacros(fsx, meta, chat.msgs, speaker), "edit",
      );
      const swipes = msg.swipes && msg.swipes.length ? msg.swipes.slice() : [msg.text];
      swipes[msg.swipe || 0] = text;
      next = { ...next, text, swipes, edited: true, translation: undefined, extra: { ...next.extra, replay: undefined } };
    }
    // a message's translation dies with its text: every route that swaps
    // the displayed text (edit, swipe switch/append, continue, cancel
    // commit) drops it so a stale translation never rides a new text
    if (typeof b.translation === "string") next.translation = b.translation; // inline translation
    if (b.translation === null) delete next.translation;
    // reasoning edits are SEPARATE from the reply text: the model's
    // thinking is editable on its own (active swipe's reasoning, or one
    // think segment of a tool-using reply's parts)
    if (typeof b.reasoning === "string") {
      const extra = { ...next.extra };
      if (b.reasoning.trim()) extra.reasoning = b.reasoning;
      else delete extra.reasoning;
      extra.replay = editReplayThinking(extra.replay, b.reasoning);
      if (!b.reasoning.trim()) delete extra.reasoningMs;
      next = { ...next, extra };
    }
    if (b.think && typeof b.think.index === "number" && typeof b.think.text === "string" && Array.isArray(next.extra?.parts)) {
      const parts = next.extra.parts.map((p, i) => (i === b.think.index && p && p.type === "thinking" ? { ...p, text: b.think.text } : p));
      const thinkingIndex = next.extra.parts.slice(0, b.think.index).filter((p) => p?.type === "thinking").length;
      const isThinking = next.extra.parts[b.think.index]?.type === "thinking";
      next = { ...next, extra: { ...next.extra, parts,
        ...(isThinking ? { replay: editReplayThinking(next.extra.replay, b.think.text, thinkingIndex),
          reasoning: parts.filter((p) => p?.type === "thinking").map((p) => p.text).join("\n") } : {}),
      } };
    }
    if (b.removeThinking === true) {
      const extra = { ...next.extra };
      delete extra.reasoning;
      delete extra.reasoningMs;
      if (extra.replay) extra.replay = editReplayThinking(extra.replay, "");
      if (Array.isArray(extra.parts)) {
        extra.parts = extra.parts.filter((p) => p?.type !== "thinking");
        if (!extra.parts.length) delete extra.parts;
      }
      next = { ...next, extra };
    }
    if ("hidden" in b) next.hidden = b.hidden === true;
    if ("bookmarked" in b) next.bookmarked = b.bookmarked === true;
    if ("bookmarkLabel" in b) next.bookmarkLabel = b.bookmarkLabel;
    if (typeof b.text === "string" || typeof b.reasoning === "string" || b.think || b.removeThinking === true) {
      for (let i = idx + 1; i < chat.msgs.length; i++) {
        const later = chat.msgs[i];
        if (later.extra?.replay) chat.msgs[i] = syncSwipeThinking({ ...later,
          extra: { ...later.extra, replay: editReplayThinking(later.extra.replay) },
        });
      }
    }
    chat.msgs[idx] = syncSwipeThinking(next);
    next = chat.msgs[idx];
    applyStashVars(req, meta);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ message: next });
  }
}
// message delete: single, truncate-below (?scope=below) or truncate-above.
// (!seg[4]: sub-routes like /swipes/:idx DELETE are matched further down)
export function deleteMessageRoute(c) {
  const { req, fsx, seg, id, op, ok, err, touch, chat, meta } = c;
  if (op === "messages" && seg[3] && !seg[4] && req.method === "DELETE") {
    const mid = seg[3];
    const scope = req.query && req.query.scope;
    const idx = chat.msgs.findLastIndex((m) => m.id === mid);
    if (idx < 0) return err(404, "message not found");
    // below keeps the anchor — only what comes after it dies
    const kept = scope === "below" ? chat.msgs.slice(0, idx + 1) : scope === "above" ? chat.msgs.slice(idx) : chat.msgs.filter((_, i) => i !== idx);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), kept);
    return ok({ ok: true, remaining: kept.length });
  }
}
// set the active swipe on ANY message (the swipe-picker modal); greetings
// re-run macros exactly like the chevron navigation does
export function addSwipeRoute(c) {
  const { req, fsx, seg, id, op, ok, err, body, touch, chat, meta } = c;
  if (op === "messages" && seg[3] && seg[4] === "swipe" && req.method === "POST") {
    const mid = seg[3];
    const idx = chat.msgs.findLastIndex((m) => m.id === mid);
    if (idx < 0) return err(404, "message not found");
    const msg = chat.msgs[idx];
    const swipes = msg.swipes && msg.swipes.length ? msg.swipes : [msg.text];
    const want = Math.floor(Number(body().index));
    if (!(want >= 0 && want < swipes.length)) return err(400, "swipe index out of range");
    const text = expandMacros(String(swipes[want]), transcriptMacros(chat.msgs, { userName: chatUserName(fsx, meta), charName: msg.name, personaText: "", chatId: id, vars: meta.chatVars || (meta.chatVars = {}), globals: globalVars(fsx), summary: String(meta.summary || "") }));
    const savedExtra = syncSwipeThinking(msg, false).extra;
    chat.msgs[idx] = { ...msg, text, swipe: want, swipes, translation: undefined, extra: restoreSwipeThinking(savedExtra, want) };
    saveChat(fsx, id, touch(meta), chat.msgs);
    return ok({ message: chat.msgs[idx], swipe: want, count: swipes.length });
  }
}
// delete one swipe variant from a message
export function deleteSwipeRoute(c) {
  const { req, fsx, seg, id, op, ok, err, touch, chat, meta } = c;
  if (op === "messages" && seg[3] && seg[4] === "swipes" && seg[5] && req.method === "DELETE") {
    const mid = seg[3];
    const sidx = Math.floor(Number(seg[5]));
    const idx = chat.msgs.findLastIndex((m) => m.id === mid);
    if (idx < 0) return err(404, "message not found");
    const msg = chat.msgs[idx];
    const swipes = msg.swipes && msg.swipes.length ? msg.swipes.slice() : [msg.text];
    if (swipes.length <= 1) return err(400, "cannot delete the only swipe");
    if (!(sidx >= 0 && sidx < swipes.length)) return err(400, "swipe index out of range");
    swipes.splice(sidx, 1);
    const oldSwipe = msg.swipe || 0;
    const swipe = sidx < oldSwipe ? oldSwipe - 1 : Math.min(oldSwipe, swipes.length - 1);
    const metaLeft = Array.isArray(msg.extra?.swipeMeta) && msg.extra.swipeMeta.length === swipes.length + 1 ? msg.extra.swipeMeta.slice() : null;
    if (metaLeft) metaLeft.splice(sidx, 1);
    chat.msgs[idx] = { ...msg, swipes, swipe, text: swipes[swipe], translation: undefined, extra: sidx === oldSwipe ? restoreSwipeThinking({ ...msg.extra, swipeMeta: metaLeft }, swipe) : { ...msg.extra, ...(metaLeft ? { swipeMeta: metaLeft } : {}) } };
    saveChat(fsx, id, touch(meta), chat.msgs);
    return ok({ message: chat.msgs[idx], swipe, count: swipes.length });
  }
}
// move a message up/down one position (message hover menu)
export function moveMessageRoute(c) {
  const { req, fsx, seg, id, op, ok, err, body, touch, chat, meta } = c;
  if (op === "messages" && seg[3] && seg[4] === "move" && req.method === "POST") {
    const mid = seg[3];
    const dir = body().dir === -1 ? -1 : 1;
    const idx = chat.msgs.findLastIndex((m) => m.id === mid);
    const to = idx + dir;
    if (idx < 0) return err(404, "message not found");
    if (to < 0 || to >= chat.msgs.length) return err(400, "cannot move past the end");
    const msgs = chat.msgs.slice();
    const tmp = msgs[idx]; msgs[idx] = msgs[to]; msgs[to] = tmp;
    saveChat(fsx, id, touch({ ...meta, tainted: true }), msgs);
    return ok({ ok: true });
  }
}
// delete all messages (chat reset — keeps the chat, reseeds greeting)
export function resetChatRoute(c) {
  const { req, fsx, id, op, ok, readJson, touch, meta } = c;
  if (op === "reset" && req.method === "POST") {
    let msgs = [];
    if (meta.characterId) {
      const card = readJson("characters/" + meta.characterId + "/card.json", null);
      if (card) {
        const greetings = cardGreetings(fsx, meta, meta.characterId, card);
        if (greetings.length) {
          const g = expandMacros(greetings[0], transcriptMacros([], { userName: chatUserName(fsx, meta), charName: card.name, personaText: "", chatId: id, vars: meta.chatVars || (meta.chatVars = {}), globals: globalVars(fsx), summary: String(meta.summary || "") }));
          msgs = [{ id: uid(), name: card.name, charId: meta.characterId, role: "char", text: g, at: Date.now(), swipes: greetings, swipe: 0, greeting: true }];
        }
      }
    }
    const fresh = { ...meta, tainted: undefined };
    delete fresh.tainted;
    saveChat(fsx, id, touch(fresh), msgs);
    return ok({ meta: fresh, messages: msgs });
  }
}
