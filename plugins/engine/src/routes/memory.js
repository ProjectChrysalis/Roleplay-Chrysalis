import { saveChat } from "../chat-files.js";
import { loadMemories, memoryExtractPrompt, memoryTranscript, mergeMemories, parseMemoriesReply, saveMemories } from "../memories.js";
import { applyStashVars, llmFailReason, pendingOut } from "../passes.js";
import { chatPersona } from "../prompt.js";
import { SCENE_ENTRY_PROMPT, parseSceneReply } from "../scenes.js";
import { DEFAULT_SUMMARY_PROMPT, MERGE_SUMMARY_PROMPT, RETIRED_SUMMARY_PROMPT, countWords, setSummaryParts, summaryParts } from "../summaries.js";
import { uid } from "../util.js";

export function memoriesRoute(c) {
  const { req, fsx, seg, id, op, ok, err, body } = c;
  if (op === "memories" && seg.length === 3) {
    if (req.method === "GET") return ok({ memories: loadMemories(fsx, id) });
    if (req.method === "POST") {
      const b = body();
      const text = String(b.text || "").trim().slice(0, 500);
      if (!text) return err(400, "text required");
      const list = loadMemories(fsx, id);
      const entry = {
        id: uid("mem"), text,
        importance: Math.min(5, Math.max(1, Math.floor(Number(b.importance)) || 3)),
        pinned: b.pinned === true, at: Date.now(),
      };
      saveMemories(fsx, id, [...list, entry]);
      return ok({ memory: entry });
    }
  }
}
export function memoryRoute(c) {
  const { req, fsx, seg, id, op, ok, err, body } = c;
  if (op === "memories" && seg.length === 4) {
    const mid = seg[3];
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(mid)) return err(400, "invalid memory id");
    const list = loadMemories(fsx, id);
    const idx = list.findIndex((e) => e.id === mid);
    if (req.method === "PATCH") {
      if (idx < 0) return err(404, "memory not found");
      const b = body();
      const e = { ...list[idx] };
      if (typeof b.text === "string" && b.text.trim()) e.text = b.text.trim().slice(0, 500);
      if (b.importance != null) e.importance = Math.min(5, Math.max(1, Math.floor(Number(b.importance)) || 3));
      if (b.pinned !== undefined) e.pinned = b.pinned === true;
      const next = list.slice();
      next[idx] = e;
      saveMemories(fsx, id, next);
      return ok({ memory: e });
    }
    if (req.method === "DELETE") {
      if (idx < 0) return err(404, "memory not found");
      saveMemories(fsx, id, list.filter((e) => e.id !== mid));
      return ok({ ok: true });
    }
  }
}
// manual extraction: an LLM pass over the recent transcript appends
// durable facts to the vault (deduped)
export function extractMemoriesRoute(c) {
  const { req, host, fsx, seg, id, op, ok, err, chat, meta, memoryModelOf } = c;
  if (op === "memories" && seg[3] === "extract" && req.method === "POST") {
    const reply = host.llm.results.memory;
    if (!reply) {
      const transcript = memoryTranscript(chat.msgs, 24);
      if (!transcript) return err(400, "nothing to extract from yet");
      host.llm.request("memory", {
        messages: [{ role: "user", content: memoryExtractPrompt(transcript) }],
        ...(memoryModelOf() ? { model: memoryModelOf() } : {}),
      });
      return pendingOut(meta);
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    const incoming = parseMemoriesReply(reply.text);
    if (!incoming.length) return err(422, "the model returned no extractable facts");
    const { list, added } = mergeMemories(loadMemories(fsx, id), incoming);
    saveMemories(fsx, id, list);
    return ok({ added, total: list.length });
  }
}
// Messages above the cutoff stay in the chat but leave the prompt; the
// summaries stand in for them. Compacting writes ONE new summary for the
// next stretch and moves the cutoff down, keeping the newest turns
// verbatim. Earlier summaries are never rewritten by it, so old detail
// does not wear away a little with every compaction. Only when the list
// outgrows its word budget are the oldest ones merged into one.
// Each compaction remembers what it did, so undo takes it back exactly;
// redo rewrites the latest summary over the same messages.
//   POST /chats/:id/compact       { keepRecent?, upTo?, redo? }
//   POST /chats/:id/compact/undo
export function undoCompactRoute(c) {
  const { req, fsx, seg, id, op, ok, err, touch, chat, meta } = c;
  if (op === "compact" && seg[3] === "undo" && !seg[4] && req.method === "POST") {
    const history = Array.isArray(meta.compactions) ? meta.compactions.slice() : [];
    const prev = history.pop();
    if (!prev) return err(400, "nothing to undo");
    if (typeof prev.add === "string") {
      const parts = summaryParts(meta).filter((p) => p.id !== prev.add);
      const at = prev.merged ? parts.findIndex((p) => p.id === prev.merged.id) : -1;
      if (at >= 0 && Array.isArray(prev.merged.parts)) parts.splice(at, 1, ...prev.merged.parts);
      setSummaryParts(meta, parts);
    } else {
      // recorded when one summary was rewritten each time: it comes back whole
      setSummaryParts(meta, [{ id: "s0", text: String(prev.summary || "") }]);
    }
    meta.memoryCutoffMessageId = prev.cutoffMessageId || null;
    meta.compactions = history;
    saveChat(fsx, id, touch(meta), chat.msgs);
    return ok({ summary: meta.summary, cutoffMessageId: meta.memoryCutoffMessageId, compactions: history.length });
  }
}
export function compactRoute(c) {
  const { req, host, fsx, seg, id, op, ok, err, readJson, body, touch, chat, meta, members, memoryModelOf } = c;
  if (op === "compact" && !seg[3] && req.method === "POST") {
    const b = body();
    const scfg = (readJson("settings.json", {}).ui || {}).summary || {};
    const history = Array.isArray(meta.compactions) ? meta.compactions : [];
    const parts = summaryParts(meta);
    const indexOf = (mid) => (mid ? Math.max(0, chat.msgs.findIndex((m) => m.id === mid)) : 0);
    const turnsIn = (from, to) => chat.msgs.slice(from, to).filter((m) => (m.role === "user" || m.role === "char") && m.hidden !== true);
    const redo = b.redo === true;
    let fromIdx, toIdx;
    // what the new summary is written against: every summary before it
    let earlier = parts;
    if (redo) {
      const last = parts[parts.length - 1];
      if (!last) return err(400, "nothing to redo");
      if (!last.to) return err(400, "the latest summary was not written from a stretch of messages");
      fromIdx = indexOf(last.from);
      toIdx = chat.msgs.findIndex((m) => m.id === last.to);
      if (toIdx < 0) return err(409, "the messages the latest summary covered are gone");
      earlier = parts.slice(0, -1);
    } else if (req.stash && req.stash.compact) {
      // pass B folds exactly the stretch pass A chose, even if a message
      // landed in between
      fromIdx = indexOf(req.stash.compact.from);
      toIdx = chat.msgs.findIndex((m) => m.id === req.stash.compact.to);
      if (toIdx < 0) return err(409, "the chat changed while summarizing; try again");
    } else {
      fromIdx = indexOf(meta.memoryCutoffMessageId);
      if (typeof b.upTo === "string" && b.upTo) {
        toIdx = chat.msgs.findIndex((m) => m.id === b.upTo);
        if (toIdx < 0) return err(404, "message not found");
      } else {
        // the newest `keep` turns stay verbatim; the cutoff lands on the
        // first of them
        const keep = Math.min(50, Math.max(1, Math.floor(Number(b.keepRecent ?? scfg.keepRecent)) || 4));
        toIdx = -1;
        for (let i = chat.msgs.length - 1, seen = 0; i >= 0; i--) {
          const m = chat.msgs[i];
          if ((m.role === "user" || m.role === "char") && m.hidden !== true && ++seen === keep) { toIdx = i; break; }
        }
      }
    }
    const covered = toIdx > fromIdx ? turnsIn(fromIdx, toIdx) : [];
    if (!covered.length) return err(400, redo ? "the latest summary covers no messages" : "nothing new to summarize yet");
    const words = Math.max(25, Math.floor(Number(scfg.targetLength) || 300));
    const reply = host.llm.results.summary;
    if (!reply) {
      const { userName } = chatPersona(fsx, meta);
      const charName = (members[0] && members[0].name) || "";
      const fill = (t) => String(t)
        .split("{{words}}").join(String(words)).split("{{limit}}").join(String(words))
        .split("{{user}}").join(userName).split("{{char}}").join(charName);
      const own = typeof scfg.prompt === "string" && scfg.prompt.trim() && !scfg.prompt.startsWith(RETIRED_SUMMARY_PROMPT);
      const before = earlier.map((p) => p.text.trim()).join("\n\n");
      const transcript = covered.map((m) => (m.role === "user" ? m.name || userName : m.name || charName) + ": " + String(m.text || "")).join("\n\n");
      const model = memoryModelOf() ? { model: memoryModelOf() } : {};
      host.llm.request("summary", {
        messages: [
          { role: "system", content: fill(own ? scfg.prompt : DEFAULT_SUMMARY_PROMPT).split("{{summary}}").join(before) },
          { role: "user", content: (before ? "Earlier in the story, already summarized (context only):\n" + before + "\n\n" : "") + "Messages to summarize:\n\n" + transcript },
        ],
        ...model,
      });
      // The list has a word budget. When this summary would take it past
      // that, the oldest half is merged into one in the same pass. The
      // newest summary is never part of a merge.
      let merge = null;
      const budget = Math.max(words * 2, Math.floor(Number(scfg.maxWords) || 1500));
      if (!redo && parts.length >= 3 && parts.reduce((n, p) => n + countWords(p.text), 0) + words > budget) {
        const old = parts.slice(0, Math.max(2, Math.floor(parts.length / 2)));
        merge = old.map((p) => p.id);
        host.llm.request("merge", {
          messages: [
            { role: "system", content: fill(MERGE_SUMMARY_PROMPT) },
            { role: "user", content: old.map((p, i) => "Summary " + (i + 1) + ":\n" + p.text.trim()).join("\n\n") },
          ],
          ...model,
        });
      }
      return pendingOut(meta, redo ? undefined : { compact: { from: (chat.msgs[fromIdx] || {}).id || null, to: chat.msgs[toIdx].id, merge } });
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    const text = String(reply.text || "").trim();
    if (!text) return err(502, "the model returned an empty summary");
    if (redo) {
      setSummaryParts(meta, [...earlier, { ...parts[parts.length - 1], text, at: Date.now() }]);
    } else {
      const record = { add: uid("sum"), cutoffMessageId: meta.memoryCutoffMessageId || null, at: Date.now() };
      let next = parts.slice();
      // a merge that failed or came back empty is skipped, not fatal: the
      // list just stays long until the next compaction tries again
      const ids = req.stash && req.stash.compact && Array.isArray(req.stash.compact.merge) ? req.stash.compact.merge : null;
      const mergeReply = host.llm.results.merge;
      const mergedText = mergeReply && mergeReply.model !== "error" ? String(mergeReply.text || "").trim() : "";
      if (ids && mergedText && ids.every((pid, i) => next[i] && next[i].id === pid)) {
        const old = next.slice(0, ids.length);
        const one = {
          id: uid("sum"), text: mergedText, from: old[0].from || null, to: old[old.length - 1].to || null, at: Date.now(),
          merged: old.reduce((n, p) => n + (p.merged || 1), 0),
        };
        next = [one, ...next.slice(ids.length)];
        record.merged = { id: one.id, parts: old };
      }
      next.push({ id: record.add, text, from: meta.memoryCutoffMessageId || null, to: chat.msgs[toIdx].id, at: Date.now() });
      setSummaryParts(meta, next);
      meta.compactions = [...history, record].slice(-20);
      meta.memoryCutoffMessageId = chat.msgs[toIdx].id;
    }
    applyStashVars(req, meta);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ summary: text, parts: summaryParts(meta).length, cutoffMessageId: meta.memoryCutoffMessageId, covered: covered.length, compactions: (meta.compactions || []).length, genMs: reply.genTimeMs ?? 0 });
  }
}
// Drafts an entry (title, keys, content) from a stretch of the chat.
// Nothing is saved here: the caller edits the draft and puts it in a
// lorebook, where the usual key scan brings it back.
//   POST /chats/:id/scene   { from, to }   message ids, both included
export function sceneRoute(c) {
  const { req, host, fsx, seg, op, ok, err, body, chat, meta, members, memoryModelOf } = c;
  if (op === "scene" && !seg[3] && req.method === "POST") {
    const b = body();
    const a = chat.msgs.findIndex((m) => m.id === b.from);
    const z = chat.msgs.findIndex((m) => m.id === b.to);
    if (a < 0 || z < 0) return err(404, "message not found");
    const span = chat.msgs.slice(Math.min(a, z), Math.max(a, z) + 1)
      .filter((m) => (m.role === "user" || m.role === "char") && m.hidden !== true);
    if (!span.length) return err(400, "no messages in that range");
    const reply = host.llm.results.scene;
    if (!reply) {
      const { userName } = chatPersona(fsx, meta);
      const charName = (members[0] && members[0].name) || "";
      host.llm.request("scene", {
        messages: [
          { role: "system", content: SCENE_ENTRY_PROMPT.split("{{user}}").join(userName).split("{{char}}").join(charName) },
          { role: "user", content: span.map((m) => (m.role === "user" ? m.name || userName : m.name || charName) + ": " + String(m.text || "").slice(0, 6000)).join("\n\n") },
        ],
        ...(memoryModelOf() ? { model: memoryModelOf() } : {}),
      });
      return pendingOut(meta);
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    const draft = parseSceneReply(reply.text);
    if (!draft) return err(502, "the model returned nothing to keep");
    return ok({ draft, covered: span.length });
  }
}
