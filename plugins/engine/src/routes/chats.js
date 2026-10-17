import { chatPersonaId, chatPresetId, loadChat, saveChat } from "../chat-files.js";
import { expandMacros } from "../macros.js";
import { pageOf, readPage } from "../paging.js";
import { chatMembers, chatUserName } from "../prompt.js";
import { cardGreetings, regexOnSave, saveMacros } from "../regex.js";
import { chatSearchTerms, searchChatLibrary } from "../search.js";
import { uid } from "../util.js";
import { transcriptMacros } from "../variables.js";
import { addMessageRoute, addSwipeRoute, deleteChatRoute, deleteMessageRoute, deleteSwipeRoute, editMessageRoute, forkChatRoute, getChatRoute, moveMessageRoute, patchChatRoute, resetChatRoute } from "./chat-messages.js";
import { cancelledRoute, continueRoute, imagePromptRoute, impersonateRoute, nextSpeakerRoute, sendRoute, swipeRoute } from "./generate.js";
import { compactRoute, extractMemoriesRoute, memoriesRoute, memoryRoute, sceneRoute, undoCompactRoute } from "./memory.js";

export function chatsRoute(c) {
  const { req, fsx, head, id, ok, err, readJson, body, touch } = c;
  if (head === "chats") {
    if ((req.method === "GET" || req.method === "POST") && id === "search") {
      const b = req.method === "GET" ? req.query || {} : body();
      if (typeof b.query !== "string" || !b.query.trim()) return err(400, "Search text required");
      if (b.query.length > 200) return err(400, "Search text is too long");
      if (!chatSearchTerms(b.query).length) return err(400, "Search text required");
      if (b.mode && !["all", "messages", "titles"].includes(b.mode)) return err(400, "Invalid search mode");
      try { return ok(searchChatLibrary(fsx, b)); } catch { return err(500, "Could not search chats"); }
    }
    if (req.method === "GET" && !id) {
      let names = [];
      try { names = fsx.list("chats").filter((f) => f.endsWith(".meta.json")); } catch {}
      // list payload carries a preview + count so chat lists render without
      // fetching every transcript (the studio UI shows both per chat)
      const read = (f, text) => {
        let m;
        try { m = JSON.parse(text); } catch { return null; }
        if (!m || typeof m !== "object") return null;
        let bytes = text.length;
        const { listing, ...meta } = m;
        // the boot sweep deletes chats that were created and never went
        // anywhere, judging from these fields. A saved listing can only be
        // older than the transcript, so one that says "empty" is checked
        // against the transcript, which is at most a greeting long.
        if (listing && typeof listing.messageCount === "number" && (listing.messageCount > 1 || listing.hasUser === true)) {
          Object.assign(meta, { messageCount: listing.messageCount, preview: String(listing.preview || ""), hasUser: listing.hasUser === true });
        } else {
          try {
            const transcript = fsx.read("chats/" + meta.id + ".jsonl");
            bytes += transcript.length;
            const lines = transcript.split("\n").filter((l) => l.trim());
            meta.messageCount = lines.length;
            const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
            meta.preview = last ? String(last.text || "").slice(0, 160) : "";
            // a raw substring test keeps this cheap: these lines are
            // engine-written JSON
            meta.hasUser = lines.some((l) => l.includes('"role":"user"'));
            // remembered, so the next list skips this transcript
            if (lines.length > 1) fsx.write("chats/" + f, JSON.stringify({ ...m, listing: { messageCount: meta.messageCount, preview: meta.preview, hasUser: meta.hasUser } }, null, 2) + "\n");
          } catch { meta.messageCount = 0; meta.preview = ""; meta.hasUser = false; }
        }
        return { item: meta, bytes };
      };
      const newest = (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
      const r = readPage(fsx, names, pageOf(req.query, Number(req.query?.budget) || 0) || { offset: 0, end: Infinity, budget: Infinity }, (f) => "chats/" + f, read);
      return ok(req.query?.offset != null ? { chats: r.items.sort(newest), next: r.next, total: r.total } : { chats: r.items.sort(newest) });
    }

    if (req.method === "POST" && !id) {
      const b = body();
      const cid = uid("c");
      // a new chat follows the current preset and persona; a caller that
      // names one locks the chat to it
      const meta = {
        id: cid,
        title: b.title || "New chat",
        characterId: b.characterId || null,
        groupId: b.groupId || null,
        presetId: b.presetId || null,
        presetLocked: !!b.presetId && b.presetLocked !== false,
        personaId: b.personaId || null,
        personaLocked: !!b.personaId && b.personaLocked !== false,
        model: b.model || null,
        userName: "User",
        authorNote: null,
        lorebookIds: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      meta.userName = typeof b.userName === "string" && b.userName ? b.userName : chatUserName(fsx, meta);
      // seed the greeting (all greetings as swipes → swipe chevrons rotate them)
      const msgs = [];
      if (meta.characterId) {
        const card = readJson("characters/" + meta.characterId + "/card.json", null);
        if (card) {
          const greetings = cardGreetings(fsx, meta, meta.characterId, card);
          if (greetings.length) {
            const g = expandMacros(greetings[0], transcriptMacros([], { userName: chatUserName(fsx, meta), charName: card.name, personaText: "", chatId: meta.id, vars: {}, summary: "" }));
            msgs.push({ id: uid(), name: card.name, charId: meta.characterId, role: "char", text: g, at: Date.now(), swipes: greetings, swipe: 0, greeting: true });
          }
          meta.title = card.name;
        }
      }
      if (meta.groupId) {
        const g = readJson("groups/" + meta.groupId + ".json", null);
        if (g) {
          meta.title = g.name;
          if (b.openingMessage && String(b.openingMessage).trim()) {
            msgs.push({ id: uid(), name: "System", charId: null, role: "system", text: String(b.openingMessage), at: Date.now(), swipes: [String(b.openingMessage)], swipe: 0 });
          }
          // group-only greetings: a member carrying them opens with one of
          // them (random pick, all variants as swipes) instead of never
          // greeting — the v3 card field, or its legacy extension spelling
          for (const mid of g.memberIds || []) {
            const card = readJson("characters/" + mid + "/card.json", null);
            if (!card) continue;
            const gg = Array.isArray(card.group_only_greetings) ? card.group_only_greetings
              : card.extensions && Array.isArray(card.extensions.group_greetings) ? card.extensions.group_greetings : [];
            const who = { id: mid, name: card.name, card };
            const list = gg.map(String).filter((t) => t.trim()).map((t) => regexOnSave(fsx, meta, [who], t, "ai_output", saveMacros(fsx, meta, [], who)));
            if (!list.length) continue;
            const pick = Math.floor(Math.random() * list.length);
            const text = list[pick].split("{{user}}").join(meta.userName).split("{{char}}").join(card.name);
            msgs.push({ id: uid(), name: card.name, charId: mid, role: "char", text, at: Date.now(), swipes: list, swipe: pick, greeting: true });
          }
        }
      }
      saveChat(fsx, cid, meta, msgs);
      // the answer says what the chat runs with; the file keeps only locks
      return ok({ meta: { ...meta, presetId: chatPresetId(fsx, meta), personaId: chatPersonaId(fsx, meta) }, messages: msgs }, 201);
    }

    if (!id) return err(400, "chat id required");
    const chat = loadChat(fsx, id);
    if (!chat) return err(404, "chat not found");
    const meta = chat.meta;
    const members = chatMembers(fsx, meta);
    const group = meta.groupId ? readJson("groups/" + meta.groupId + ".json", null) : null;
    const modelOf = () => (body().model != null ? body().model : meta.model);
    // summaries and facts can run on a model of their own (Settings, Memory),
    // usually a cheaper one than the storyteller
    const memoryModelOf = () => {
      const chosen = String(((readJson("settings.json", {}).ui || {}).memory || {}).model || "").trim();
      return chosen || modelOf();
    };
    // stored-text regex for a message about to be saved in this chat
    const onSave = (text, placement, speaker) => regexOnSave(fsx, meta, members, text, placement, saveMacros(fsx, meta, chat.msgs, speaker));
    // PASS A of a generation writes no transcript — but a page reload inside
    // that window must not let the client's abandoned-chat sweep judge this
    // chat deletable (server-side it is still just a greeting). Persist the
    // taint, meta only: the sweep exempts tainted chats, and pass B re-runs
    // this route fresh so the user message still appends exactly once.
    const markGenerating = () => {
      if (!meta.tainted) saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    };
    // Spend is only recorded when the engine actually had rates for the model.
    // An unpriced generation carries NO cost — a stored 0 would read as "free"
    // everywhere it is summed.
    const genUsage = (reply) => {
      const u = reply.usage;
      if (!u || typeof u !== "object") return u;
      const { priced, costTotal, ...rest } = u;
      return priced === true ? { ...rest, costTotal } : rest;
    };
    // Forking a fork must not grow the title: every fork numbers off the SAME
    // root name, so a chain reads "Tavern fork 2", "Tavern fork 3", never
    // "Tavern fork fork fork". The number is the first free one across existing
    // chats, so deleting fork 2 lets the next fork reclaim it.
    const FORK_SUFFIX = /(?:\s*[—–-]?\s*fork(?:\s+\d+)?)+$/i;
    const forkTitle = (fsx, title) => {
      const base = String(title || "Chat").replace(FORK_SUFFIX, "").trim() || "Chat";
      const taken = new Set();
      let files = [];
      try { files = fsx.list("chats").filter((f) => f.endsWith(".meta.json")); } catch {}
      for (const f of files) {
        let m = null;
        try { m = JSON.parse(fsx.read("chats/" + f)); } catch {}
        const t = m && typeof m.title === "string" ? m.title.trim() : "";
        if (!t.toLowerCase().startsWith(base.toLowerCase())) continue;
        const rest = t.slice(base.length);
        const hit = /^\s*[—–-]?\s*fork(?:\s+(\d+))?$/i.exec(rest);
        if (hit) taken.add(hit[1] ? Number(hit[1]) : 1);
      }
      let n = 1;
      while (taken.has(n)) n++;
      return n === 1 ? base + " fork" : base + " fork " + n;
    };
    const generationPreset = () => typeof req.stash?.presetName === "string" ? { presetName: req.stash.presetName } : {};
    const swipeMetaEntry = (reply) => ({ ...generationPreset(), model: reply.model, usage: genUsage(reply), genMs: reply.genTimeMs ?? 0,
      params: reply.requestParams, reasoning: reply.reasoning, reasoningMs: reply.reasoningTimeMs, ...toolX(reply) });
    // per-swipe generation facts (model, usage, timing). A message's extra
    // describes its ACTIVE swipe only, so every swipe's own numbers ride this
    // index-aligned array; null entries are swipes without generation data
    // (client-cancelled commits, padded history from before this existed)
    const pushSwipeMeta = (extra, swipesLen, entry) => {
      // pad unknown/misaligned history with nulls so indices always match swipes
      const base = Array.isArray(extra?.swipeMeta) && extra.swipeMeta.length === swipesLen - 1
        ? extra.swipeMeta.slice()
        : Array.from({ length: Math.max(0, swipesLen - 1) }, () => null);
      base.push(entry ?? null);
      return { ...extra, swipeMeta: base };
    };
    // do names ride this prompt? (mirror of the assembly's names-behavior check)
    const namesRidePrompt = (preset, isGroup) => {
      const v = preset && preset.studio && preset.studio.namesBehavior;
      return v === "content" || v === "completion" || ((!v || v === "default") && isGroup);
    };
    // models echo the speaker prefix when names ride the prompt; strip a leading
    // "Name:" so the reply doesn't render the character's own name twice
    const stripEchoedName = (text, preset, isGroup, name) => {
      if (!name || !namesRidePrompt(preset, isGroup)) return String(text || "");
      const t = String(text || "");
      const prefix = name + ":";
      return t.startsWith(prefix) ? t.slice(prefix.length).trimStart() : t;
    };
    // tool calls the model made land on the committed message's extra bag:
    // the flat trace (chip/dialog) and the interleaved parts (body rendering)
    const toolX = (r) => ({
      replay: r.replay,
      ...(Array.isArray(r.toolTrace) && r.toolTrace.length ? { tools: r.toolTrace } : {}),
      ...(Array.isArray(r.parts) && r.parts.length ? { parts: r.parts } : {}),
    });

    const chatCtx = { ...c, chat, meta, members, group, modelOf, memoryModelOf, onSave, markGenerating, genUsage, forkTitle, generationPreset, swipeMetaEntry, pushSwipeMeta, stripEchoedName, toolX };
    for (const handle of CHAT_ROUTES) {
      const r = handle(chatCtx);
      if (r !== undefined) return r;
    }
  }
}

/** Per-chat routes, tried in this order. */
const CHAT_ROUTES = [
  getChatRoute,
  patchChatRoute,
  forkChatRoute,
  deleteChatRoute,
  sendRoute,
  nextSpeakerRoute,
  swipeRoute,
  cancelledRoute,
  continueRoute,
  imagePromptRoute,
  addMessageRoute,
  memoriesRoute,
  memoryRoute,
  extractMemoriesRoute,
  undoCompactRoute,
  compactRoute,
  sceneRoute,
  impersonateRoute,
  editMessageRoute,
  deleteMessageRoute,
  addSwipeRoute,
  deleteSwipeRoute,
  moveMessageRoute,
  resetChatRoute,
];
