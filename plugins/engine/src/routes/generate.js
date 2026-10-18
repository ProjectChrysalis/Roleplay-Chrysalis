import { saveChat } from "../chat-files.js";
import { groupTurnPlan } from "../groups.js";
import { IMAGE_PROMPT_MODES, IMAGE_PROMPT_RULES } from "../image-prompts.js";
import { expandMacros } from "../macros.js";
import { loadMemories, memoryExtractPrompt, memoryTranscript, mergeMemories, parseMemoriesReply, saveMemories } from "../memories.js";
import { applyStashVars, llmFailReason, pendingOut } from "../passes.js";
import { assemble, chatPersona, chatUserName } from "../prompt.js";
import { restoreSwipeThinking, syncSwipeThinking } from "../thinking.js";
import { esc, uid } from "../util.js";
import { globalVars, transcriptMacros } from "../variables.js";
import { cacheWiVectorBatch, embedCap, semanticEmbedWork, setEmbedCap } from "../vectors.js";

// send: append user message; solo + group(list/natural) auto-reply.
// An EMPTY text (a bare "continue" send) generates a reply
// with no user turn — nothing is written into the transcript.
export function sendRoute(c) {
  const { req, host, fsx, id, op, ok, err, readJson, body, touch, chat, meta, members, group, modelOf, memoryModelOf, onSave, markGenerating, genUsage, generationPreset, swipeMetaEntry, stripEchoedName, toolX } = c;
  if (op === "send" && req.method === "POST") {
    const b = body();
    const existingReply = b.replyMessageId && chat.msgs.findLast((m) => m.id === b.replyMessageId);
    if (existingReply) return ok({ reply: existingReply });
    const typed = String(b.text || "").trim();
    if (!typed && b.allowEmpty !== true) return err(400, "text required");
    const text = typed ? onSave(typed, "user_input", members[0] || null).trim() : "";
    const reply = host.llm.results.reply;
    const userMsg = text ? {
      id: typeof b.userMessageId === "string" && b.userMessageId ? b.userMessageId : uid(), name: chatUserName(fsx, meta), charId: null, role: "user",
      ...(chatPersona(fsx, meta).personaId ? { personaId: chatPersona(fsx, meta).personaId } : {}),
      text, at: Date.now(), swipes: [text], swipe: 0,
      // attachments (data-URL images/files) ride on the stored message
      ...(Array.isArray(body().attachments) && body().attachments.length ? { attachments: body().attachments } : {}),
    } : null;
    // manual-trigger groups: user message only, no generation
    if (group && group.mode === "manual") {
      if (!userMsg) return err(400, "nothing to send");
      chat.msgs.push(userMsg);
      applyStashVars(req, meta);
      saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
      return ok({ user: userMsg, reply: null });
    }
    if (!reply) {
      // PASS A: stage the user message + request; NO writes
      let speaker = members[0] || null;
      // a group turn is planned once, here; pass B and the follow-up
      // replies the client runs read the plan from the stash
      let plan = null;
      if (group) {
        const lastChar = chat.msgs.findLast((m) => m.role === "char" && !m.picture);
        plan = groupTurnPlan(group, members, lastChar ? lastChar.charId : null, text).map((m) => m.id);
        speaker = members.find((m) => m.id === plan[0]) || null;
      }
      if (!speaker) return err(400, "chat has no participating characters");
      const staged = userMsg ? [...chat.msgs, userMsg] : chat.msgs;
      // semantic prep: when a bound book has vectorized entries,
      // embed the scan window (+ uncached entries) first — one extra pass
      if (host.llm.embed && embedCap(fsx)) {
        const scanEmbedText = (text ? text + "\n" : "") + staged.slice(-4).map((m) => m.text || "").join("\n");
        const personaIdsA = (() => {
          const pid = meta.personaId || (() => { try { return JSON.parse(fsx.read("settings.json")).personaId; } catch { return null; } })();
          const p = pid ? readJson("personas/" + pid + ".json", null) : null;
          return p && Array.isArray(p.lorebookIds) ? p.lorebookIds : [];
        })();
        const work = semanticEmbedWork(fsx, meta, personaIdsA, scanEmbedText);
        const haveScan = host.llm.embedResults && host.llm.embedResults.scan !== undefined;
        if (work && !haveScan) {
          host.llm.embed("scan", { texts: [scanEmbedText, ...work.needed.map((e) => e.text)] });
          markGenerating();
          return pendingOut(meta, { wiEmbed: work.needed });
        }
        if (work && haveScan) {
          const res = host.llm.embedResults.scan;
          if (Array.isArray(res)) {
            setEmbedCap(fsx, true);
            if (Array.isArray(req.stash && req.stash.wiEmbed) && req.stash.wiEmbed.length) {
              cacheWiVectorBatch(fsx, req.stash.wiEmbed, res.slice(1));
            }
          } else {
            setEmbedCap(fsx, false);
          }
        }
      }
      const scanVecSend = host.llm.embedResults && Array.isArray(host.llm.embedResults.scan) && host.llm.embedResults.scan[0] ? host.llm.embedResults.scan[0] : null;
      const a = assemble(fsx, meta, staged, speaker, text, { scanVec: scanVecSend, gen: "send", model: modelOf() });
      host.llm.request("reply", {
        sessionId: id,
        messages: a.messages,
        systemPrompt: a.systemPrompt,
        ...(modelOf() ? { model: modelOf() } : {}),
        ...(a.presetParams && Object.keys(a.presetParams).length ? { presetParams: a.presetParams } : {}),
        ...(a.reasoning ? { reasoning: a.reasoning } : {}),
        ...(a.reasoningTags ? { reasoningTags: a.reasoningTags } : {}),
        ...(a.thinkingBudget ? { thinkingBudget: a.thinkingBudget } : {}),
        ...(a.promptFormat ? { promptFormat: a.promptFormat } : {}),
        ...(a.assistantPrefill ? { assistantPrefill: a.assistantPrefill } : {}),
        ...(a.cache ? { cache: a.cache } : {}),
        wantsTools: true,
        stream: { chatId: id, name: speaker ? speaker.name : "", speakerId: speaker ? speaker.id : null },
      });
      // auto memory extraction: every N messages a second pass pulls durable
      // facts into the vault (auto-in only — manual runs the extract route)
      const memCfgA = (() => { try { return (JSON.parse(fsx.read("settings.json")).ui || {}).memory || {}; } catch { return {}; } })();
      const interval = Math.max(2, Math.floor(Number(memCfgA.interval)) || 20);
      if (memCfgA.enabled !== false && memCfgA.auto === true && staged.length - (Number(meta.memoryExtractedAt) || 0) >= interval) {
        const transcript = memoryTranscript(staged, 24);
        if (transcript) {
          host.llm.request("memory", {
            messages: [{ role: "user", content: memoryExtractPrompt(transcript) }],
            ...(memoryModelOf() ? { model: memoryModelOf() } : {}),
          });
        }
      }
      markGenerating();
      return pendingOut(meta, { presetName: a.presetName, ...(a.trimmed ? { trimmed: a.trimmed } : {}), ...(plan ? { plan } : {}) });
    }
    // PASS B: commit
    // A failed model call must not eat the user's turn: the user message is
    // truth and the reply is derived, so it commits alone and the 503 names
    // the real cause (content filter, bad key, …). The client's refresh then
    // lands the user bubble instead of wiping its staged copy.
    if (reply.model === "error") {
      if (userMsg && !chat.msgs.findLast((m) => m.id === userMsg.id)) {
        chat.msgs.push(userMsg);
        applyStashVars(req, meta);
        saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
      }
      return err(503, llmFailReason(reply));
    }
    if (userMsg && !chat.msgs.findLast((m) => m.id === userMsg.id)) chat.msgs.push(userMsg);
    let speaker = members[0] || null;
    let replyText = String(reply.text || "").trim();
    const plan = group && req.stash && Array.isArray(req.stash.plan) ? req.stash.plan : null;
    if (group) speaker = (plan && members.find((m) => m.id === plan[0])) || null;
    if (!speaker) return err(400, "chat has no participating characters");
    replyText = stripEchoedName(replyText, readJson("presets/" + (meta.presetId || "default") + ".json", null), !!group, speaker.name);
    // assistant prefill: the committed message starts with it (servers that
    // echo the trailing assistant turn are detected, not doubled)
    const prefill = reply.assistantPrefill;
    if (prefill && !replyText.startsWith(prefill)) replyText = prefill + replyText;
    replyText = onSave(replyText, "ai_output", speaker);
    if (reply.reasoning) reply.reasoning = onSave(reply.reasoning, "reasoning", speaker);
    const charMsg = {
      id: typeof b.replyMessageId === "string" && b.replyMessageId ? b.replyMessageId : uid(), name: speaker.name, charId: speaker.id, role: "char",
      text: replyText, at: Date.now(), swipes: [replyText], swipe: 0,
      extra: { ...generationPreset(), model: reply.model, usage: genUsage(reply), genMs: reply.genTimeMs ?? 0, params: reply.requestParams ?? undefined, swipeMeta: [swipeMetaEntry(reply)], ...toolX(reply), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), ...(reply.reasoningTimeMs ? { reasoningMs: reply.reasoningTimeMs } : {}) },
    };
    chat.msgs.push(charMsg);
    applyStashVars(req, meta);
    // the auto-extraction pass (armed in pass A) lands here; it never
    // fails the send — a bad extraction just extracts nothing
    let memoriesAdded = 0;
    const memReply = host.llm.results.memory;
    if (memReply && memReply.model !== "error") {
      const incoming = parseMemoriesReply(memReply.text);
      if (incoming.length) {
        const { list, added } = mergeMemories(loadMemories(fsx, id), incoming);
        if (added.length) { saveMemories(fsx, id, list); memoriesAdded = added.length; }
      }
    }
    // the interval counter advances only when extraction ran this turn
    const memoryRan = memReply !== undefined;
    saveChat(fsx, id, touch({ ...meta, tainted: true, ...(memoryRan ? { memoryExtractedAt: chat.msgs.length } : {}) }), chat.msgs);
    return ok({
      user: userMsg, reply: charMsg,
      ...(memoriesAdded ? { memoriesAdded } : {}),
      // history the context could not hold this turn (auto-compaction's cue)
      ...(req.stash && req.stash.trimmed ? { trimmed: req.stash.trimmed } : {}),
      // the rest of this group turn: members the client runs next, in order
      ...(plan && plan.length > 1 ? { queue: plan.slice(1) } : {}),
    });
  }
}
// group: force a specific member to speak now
export function nextSpeakerRoute(c) {
  const { req, host, fsx, id, op, ok, err, body, touch, chat, meta, members, group, modelOf, onSave, markGenerating, genUsage, generationPreset, swipeMetaEntry, toolX } = c;
  if (op === "next" && req.method === "POST") {
    if (!group) return err(400, "not a group chat");
    const b = body();
    const existingReply = b.replyMessageId && chat.msgs.findLast((m) => m.id === b.replyMessageId);
    if (existingReply) return ok({ reply: existingReply });
    const speaker = members.find((m) => m.id === b.charId) || null;
    if (!speaker) return err(400, "charId must be a member of this group");
    const reply = host.llm.results.reply;
    if (!reply) {
      const a = assemble(fsx, meta, chat.msgs, speaker, null);
      host.llm.request("reply", {
        sessionId: id,
        messages: a.messages,
        systemPrompt: a.systemPrompt,
        ...(modelOf() ? { model: modelOf() } : {}),
        ...(a.presetParams && Object.keys(a.presetParams).length ? { presetParams: a.presetParams } : {}),
        ...(a.reasoning ? { reasoning: a.reasoning } : {}),
        ...(a.reasoningTags ? { reasoningTags: a.reasoningTags } : {}),
        ...(a.thinkingBudget ? { thinkingBudget: a.thinkingBudget } : {}),
        ...(a.promptFormat ? { promptFormat: a.promptFormat } : {}),
        ...(a.assistantPrefill ? { assistantPrefill: a.assistantPrefill } : {}),
        ...(a.cache ? { cache: a.cache } : {}),
        wantsTools: true,
        stream: { chatId: id, name: speaker.name, speakerId: speaker.id },
      });
      markGenerating();
      return pendingOut(meta, { presetName: a.presetName, ...(a.trimmed ? { trimmed: a.trimmed } : {}) });
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    let replyText = String(reply.text || "").trim();
    const prefill = reply.assistantPrefill;
    if (prefill && !replyText.startsWith(prefill)) replyText = prefill + replyText;
    replyText = onSave(replyText, "ai_output", speaker);
    if (reply.reasoning) reply.reasoning = onSave(reply.reasoning, "reasoning", speaker);
    const charMsg = {
      id: typeof b.replyMessageId === "string" && b.replyMessageId ? b.replyMessageId : uid(), name: speaker.name, charId: speaker.id, role: "char",
      text: replyText, at: Date.now(), swipes: [replyText], swipe: 0,
      extra: { ...generationPreset(), model: reply.model, usage: genUsage(reply), genMs: reply.genTimeMs ?? 0, params: reply.requestParams ?? undefined, swipeMeta: [swipeMetaEntry(reply)], ...toolX(reply), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), ...(reply.reasoningTimeMs ? { reasoningMs: reply.reasoningTimeMs } : {}) },
    };
    chat.msgs.push(charMsg);
    applyStashVars(req, meta);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ reply: charMsg, ...(req.stash && req.stash.trimmed ? { trimmed: req.stash.trimmed } : {}) });
  }
}
// swipe: navigate existing swipes on the last char message; generate new
// when pushing past the end (greeting cycles without a model call)
export function swipeRoute(c) {
  const { req, host, fsx, id, op, ok, err, readJson, body, touch, chat, meta, members, group, modelOf, onSave, markGenerating, genUsage, generationPreset, swipeMetaEntry, pushSwipeMeta, stripEchoedName, toolX } = c;
  if (op === "swipe" && req.method === "POST") {
    const dir = body().dir === -1 ? -1 : 1;
    const idx = (() => {
      for (let i = chat.msgs.length - 1; i >= 0; i--) if (chat.msgs[i].role === "char" && !chat.msgs[i].picture) return i;
      return -1;
    })();
    if (idx < 0) return err(400, "no character message to swipe");
    const msg = chat.msgs[idx];
    const swipes = msg.swipes && msg.swipes.length ? msg.swipes : [msg.text];
    const cur = msg.swipe || 0;
    const next = cur + dir;
    // navigate existing swipes (greeting rotation wraps on pristine chats)
    const pristineGreeting = !meta.tainted && chat.msgs.length === 1 && msg.greeting === true;
    if (next >= 0 && next < swipes.length) {
      const text = expandMacros(String(swipes[next]), transcriptMacros(chat.msgs, { userName: chatUserName(fsx, meta), charName: msg.name, personaText: "", chatId: id, vars: meta.chatVars || (meta.chatVars = {}), globals: globalVars(fsx), summary: String(meta.summary || "") }));
      chat.msgs[idx] = { ...msg, text, swipe: next, swipes, translation: undefined, extra: restoreSwipeThinking(syncSwipeThinking(msg, false).extra, next) };
      saveChat(fsx, id, touch(meta), chat.msgs);
      return ok({ message: chat.msgs[idx], swipe: next, count: swipes.length });
    }
    if (pristineGreeting && (next < 0 || next >= swipes.length)) {
      const wrapped = ((next % swipes.length) + swipes.length) % swipes.length;
      const text = expandMacros(String(swipes[wrapped]), transcriptMacros(chat.msgs, { userName: chatUserName(fsx, meta), charName: msg.name, personaText: "", chatId: id, vars: meta.chatVars || (meta.chatVars = {}), globals: globalVars(fsx), summary: String(meta.summary || "") }));
      chat.msgs[idx] = { ...msg, text, swipe: wrapped, swipes, translation: undefined };
      saveChat(fsx, id, touch(meta), chat.msgs);
      return ok({ message: chat.msgs[idx], swipe: wrapped, count: swipes.length });
    }
    if (dir !== 1) return err(400, "no earlier swipe");
    // generate a fresh swipe (two-phase) from history WITHOUT this message
    const reply = host.llm.results.reply;
    const guard = body();
    if (reply && ((guard.expectedSwipes != null && (msg.swipes || [msg.text]).length !== guard.expectedSwipes) ||
        (guard.expectedText != null && msg.text !== guard.expectedText))) return err(409, "target message changed");
    const before = chat.msgs.slice(0, idx);
    const speaker = members.find((m) => m.id === msg.charId) || members[0] || null;
    if (!speaker) return err(400, "speaker character missing");
    if (!reply) {
      const a = assemble(fsx, meta, before, speaker, null, { gen: "swipe", model: modelOf() });
      host.llm.request("reply", {
        sessionId: id,
        messages: a.messages,
        systemPrompt: a.systemPrompt,
        ...(modelOf() ? { model: modelOf() } : {}),
        ...(a.presetParams && Object.keys(a.presetParams).length ? { presetParams: a.presetParams } : {}),
        ...(a.reasoning ? { reasoning: a.reasoning } : {}),
        ...(a.reasoningTags ? { reasoningTags: a.reasoningTags } : {}),
        ...(a.thinkingBudget ? { thinkingBudget: a.thinkingBudget } : {}),
        ...(a.promptFormat ? { promptFormat: a.promptFormat } : {}),
        ...(a.assistantPrefill ? { assistantPrefill: a.assistantPrefill } : {}),
        ...(a.cache ? { cache: a.cache } : {}),
        wantsTools: true,
        stream: { chatId: id, name: msg.name, speakerId: msg.charId },
      });
      markGenerating();
      return pendingOut(meta, { presetName: a.presetName });
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    let fresh = stripEchoedName(String(reply.text || "").trim(), readJson("presets/" + (meta.presetId || "default") + ".json", null), !!group, msg.name);
    const swipPrefill = reply.assistantPrefill;
    if (swipPrefill && !fresh.startsWith(swipPrefill)) fresh = swipPrefill + fresh;
    fresh = onSave(fresh, "ai_output", speaker);
    if (reply.reasoning) reply.reasoning = onSave(reply.reasoning, "reasoning", speaker);
    const previousMeta = syncSwipeThinking(msg, false).extra.swipeMeta;
    swipes.push(fresh);
    chat.msgs[idx] = { ...msg, text: fresh, swipe: swipes.length - 1, swipes, translation: undefined, extra: pushSwipeMeta({ swipeMeta: previousMeta, ...generationPreset(), model: reply.model, usage: genUsage(reply), genMs: reply.genTimeMs ?? 0, params: reply.requestParams ?? undefined, ...toolX(reply), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), ...(reply.reasoningTimeMs ? { reasoningMs: reply.reasoningTimeMs } : {}) }, swipes.length, swipeMetaEntry(reply)) };
    applyStashVars(req, meta);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ message: chat.msgs[idx], swipe: swipes.length - 1, count: swipes.length });
  }
}
// Interrupted saves are idempotent and cannot replace a newer generation.
export function cancelledRoute(c) {
  const { req, fsx, id, op, ok, err, readJson, body, touch, chat, meta, members, group, onSave, pushSwipeMeta, stripEchoedName } = c;
  if (op === "cancelled" && req.method === "POST") {
    const b = body();
    if (b.replyMessageId && chat.msgs.findLast((m) => m.id === b.replyMessageId)) return ok({ ok: true });
    const target = b.targetMessageId ? chat.msgs.findLast((m) => m.id === b.targetMessageId) : null;
    const speaker = members.find((m) => m.id === (target ? target.charId : b.charId)) || members[0] || null;
    const preset = readJson("presets/" + (meta.presetId || "default") + ".json", null);
    const text = b.operation === "continue"
      ? String(b.text ?? "")
      : onSave(stripEchoedName(String(b.text ?? ""), preset, !!group, speaker ? speaker.name : undefined), "ai_output", speaker);
    const parts = Array.isArray(b.parts) ? b.parts : [];
    const keep = !!text.trim() || parts.length > 0;
    const genMs = Math.max(0, Number(b.genMs) || 0);
    const model = typeof b.model === "string" ? b.model : "";
    const presetName = typeof b.presetName === "string" ? b.presetName : undefined;
    if (b.targetMessageId) {
      if (!target) return err(409, "target message changed");
      const swipes = target.swipes && target.swipes.length ? target.swipes.slice() : [target.text];
      if ((b.expectedSwipes != null && swipes.length !== b.expectedSwipes) ||
          (b.expectedText != null && target.text !== b.expectedText)) return err(409, "a generation already committed");
      if (!keep) return ok({ ok: true });
      const continuing = b.operation === "continue";
      if (continuing) swipes[target.swipe || 0] = text;
      else swipes.push(text);
      const swipe = continuing ? target.swipe || 0 : swipes.length - 1;
      const extra = { ...syncSwipeThinking(target, false).extra, presetName, model, genMs, usage: undefined, params: undefined, replay: undefined, reasoning: undefined, reasoningMs: undefined, tools: undefined, parts: parts.length ? parts : undefined };
      if (continuing) {
        const swipeMeta = extra.swipeMeta.slice();
        swipeMeta[swipe] = { presetName, genMs, ...(model ? { model } : {}) };
        extra.swipeMeta = swipeMeta;
      }
      chat.msgs[chat.msgs.indexOf(target)] = syncSwipeThinking({ ...target, text, swipes, swipe, translation: undefined,
        extra: continuing ? extra : pushSwipeMeta(extra, swipes.length, { genMs, ...(model ? { model } : {}) }) });
    } else {
      const userText = typeof b.userText === "string" ? onSave(b.userText.trim(), "user_input", members[0] || null).trim() : "";
      if (!keep && !userText) return err(400, "nothing to keep");
      if (keep && !speaker) return err(400, "chat has no participating characters");
      if (userText && !(b.userMessageId && chat.msgs.findLast((m) => m.id === b.userMessageId))) {
        chat.msgs.push({
          id: b.userMessageId || uid(), name: chatUserName(fsx, meta), charId: null, role: "user",
          ...(chatPersona(fsx, meta).personaId ? { personaId: chatPersona(fsx, meta).personaId } : {}),
          text: userText, at: Date.now(), swipes: [userText], swipe: 0,
          ...(Array.isArray(b.attachments) && b.attachments.length ? { attachments: b.attachments } : {}),
        });
      }
      if (keep) chat.msgs.push({
        id: b.replyMessageId || uid(), name: speaker.name, charId: speaker.id, role: "char",
        text, at: Date.now(), swipes: [text], swipe: 0,
        extra: { presetName, ...(parts.length ? { parts } : {}), genMs, ...(model ? { model } : {}) },
      });
    }
    applyStashVars(req, meta);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ ok: true });
  }
}
// continue: extend the last char message
export function continueRoute(c) {
  const { req, host, fsx, id, op, ok, err, readJson, body, touch, chat, meta, members, modelOf, onSave, markGenerating, generationPreset, swipeMetaEntry, toolX } = c;
  if (op === "continue" && req.method === "POST") {
    const idx = (() => {
      for (let i = chat.msgs.length - 1; i >= 0; i--) if (chat.msgs[i].role === "char" && !chat.msgs[i].picture) return i;
      return -1;
    })();
    if (idx < 0) return err(400, "no character message to continue");
    const msg = chat.msgs[idx];
    const speaker = members.find((m) => m.id === msg.charId) || members[0] || null;
    if (!speaker) return err(400, "speaker character missing");
    const reply = host.llm.results.reply;
    const guard = body();
    if (reply && ((guard.expectedSwipes != null && (msg.swipes || [msg.text]).length !== guard.expectedSwipes) ||
        (guard.expectedText != null && msg.text !== guard.expectedText))) return err(409, "target message changed");
    if (!reply) {
      const a = assemble(fsx, meta, chat.msgs, speaker, null, { gen: "continue", model: modelOf() });
      // continue nudge: preset utility prompt (blank = plain continue, no
      // nudge appended — no hidden default text)
      const preset = readJson("presets/" + (meta.presetId || "default") + ".json", null);
      const utilMacros = (t) => String(t)
        .replace(/\{\{user\}\}/g, chatUserName(fsx, meta))
        .replace(/\{\{char\}\}/g, (members[0] && members[0].name) || "");
      const nudge = preset && preset.utilityPrompts ? String(preset.utilityPrompts.continueNudge || "").trim() : "";
      // continuing an existing reply — a prefill turn would land mid-message, drop it
      const contMsgs = a.assistantPrefill ? a.messages.slice(0, -1) : a.messages;
      // Continue prefill (on by default): the partial reply already rides as
      // the trailing assistant turn, so NO nudge — the model picks up
      // mid-sentence exactly where it stopped. Off appends the nudge turn.
      const contPrefill = !(preset && preset.studio && preset.studio.continuePrefill === false);
      host.llm.request("reply", {
        sessionId: id,
        messages: nudge && !contPrefill ? [...contMsgs, { role: "user", content: utilMacros(nudge) }] : contMsgs,
        systemPrompt: a.systemPrompt,
        ...(modelOf() ? { model: modelOf() } : {}),
        ...(a.presetParams && Object.keys(a.presetParams).length ? { presetParams: a.presetParams } : {}),
        ...(a.reasoning ? { reasoning: a.reasoning } : {}),
        ...(a.reasoningTags ? { reasoningTags: a.reasoningTags } : {}),
        ...(a.thinkingBudget ? { thinkingBudget: a.thinkingBudget } : {}),
        ...(a.promptFormat ? { promptFormat: a.promptFormat } : {}),
        ...(a.assistantPrefill ? { assistantPrefill: a.assistantPrefill } : {}),
        ...(a.cache ? { cache: a.cache } : {}),
        wantsTools: true,
        stream: { chatId: id, name: msg.name, speakerId: msg.charId },
      });
      markGenerating();
      return pendingOut(meta, { presetName: a.presetName });
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    const extra = onSave(String(reply.text || "").trim(), "ai_output", speaker);
    if (reply.reasoning) reply.reasoning = onSave(reply.reasoning, "reasoning", speaker);
    const merged = msg.text + (/\s$/.test(msg.text) ? "" : " ") + extra;
    const swipes = msg.swipes && msg.swipes.length ? msg.swipes.slice() : [msg.text];
    swipes[msg.swipe || 0] = merged;
    const contExtra = { ...msg.extra, presetName: undefined, ...generationPreset(), model: reply.model, continued: true, params: reply.requestParams ?? undefined, ...toolX(reply), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), ...(reply.reasoningTimeMs ? { reasoningMs: reply.reasoningTimeMs } : {}) };
    contExtra.reasoning = [msg.extra?.reasoning, reply.reasoning].filter(Boolean).join("\n") || undefined;
    const thinkingMs = (msg.extra?.reasoningMs || 0) + (reply.reasoningTimeMs || 0);
    contExtra.reasoningMs = thinkingMs || undefined;
    if (msg.extra?.parts?.length || reply.parts?.length) {
      const segments = (text, reasoning, parts) => parts?.length ? parts : [
        ...(reasoning ? [{ type: "thinking", text: reasoning }] : []),
        ...(text ? [{ type: "text", text }] : []),
      ];
      contExtra.parts = [...segments(msg.text, msg.extra?.reasoning, msg.extra?.parts), ...segments(extra, reply.reasoning, reply.parts)];
      contExtra.tools = [...(msg.extra?.tools || []), ...(reply.toolTrace || [])];
    }
    if (reply.replay) {
      const first = reply.replay.messages.find((m) => m.role === "assistant");
      const prior = msg.extra?.replay?.text === msg.text ? msg.extra.replay.messages
        : first ? [{ ...first, content: [{ type: "text", text: msg.text }] }] : [];
      contExtra.replay = { text: merged, messages: [...prior, ...reply.replay.messages] };
    }
    if (Array.isArray(msg.extra?.swipeMeta) && msg.extra.swipeMeta.length === swipes.length) {
      contExtra.swipeMeta = msg.extra.swipeMeta.slice();
      contExtra.swipeMeta[msg.swipe || 0] = swipeMetaEntry(reply);
    }
    chat.msgs[idx] = syncSwipeThinking({ ...msg, text: merged, swipes, translation: undefined, extra: contExtra });
    applyStashVars(req, meta);
    saveChat(fsx, id, touch({ ...meta, tainted: true }), chat.msgs);
    return ok({ message: chat.msgs[idx] });
  }
}
// image prompt: the chat's model reads the recent scene and writes what an
// image model should draw. Nothing is written to the chat.
export function imagePromptRoute(c) {
  const { req, host, fsx, op, ok, err, body, chat, meta, members, modelOf } = c;
  if (op === "image-prompt" && req.method === "POST") {
    const b = body();
    const mode = IMAGE_PROMPT_MODES[b.mode] ? b.mode : "scene";
    const reply = host.llm.results.imgprompt;
    if (!reply) {
      const lastChar = chat.msgs.findLast((m) => m.role === "char" && !m.picture);
      const who = members.find((m) => lastChar && m.id === lastChar.charId) || members[0] || null;
      const { persona, userName } = chatPersona(fsx, meta);
      const charName = who ? who.name : "the character";
      const about = (name, text) => (String(text || "").trim() ? "About " + name + ":\n" + String(text).trim().slice(0, 3000) : "");
      const transcript = memoryTranscript(chat.msgs, 12);
      const subject = typeof b.subject === "string" ? b.subject.trim().slice(0, 500) : "";
      const content = [
        IMAGE_PROMPT_MODES[mode].split("{{char}}").join(charName).split("{{user}}").join(userName),
        IMAGE_PROMPT_RULES,
        subject ? "The user asked for: " + subject : "",
        who && mode !== "user" && mode !== "background" ? about(charName, who.card && who.card.description) : "",
        mode === "user" || mode === "scene" ? about(userName, persona && persona.description) : "",
        transcript ? "Recent chat:\n" + transcript : "",
      ].filter(Boolean).join("\n\n");
      host.llm.request("imgprompt", { messages: [{ role: "user", content }], ...(modelOf() ? { model: modelOf() } : {}) });
      return pendingOut(meta);
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    const prompt = String(reply.text || "")
      .replace(/^\s*(image\s+)?prompt\s*:\s*/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
    if (!prompt) return err(502, "the model returned an empty description");
    return ok({ prompt, mode });
  }
}
// impersonate: draft the user's next message — NEVER written
export function impersonateRoute(c) {
  const { req, host, fsx, id, op, ok, err, readJson, chat, meta, members, modelOf, onSave } = c;
  if (op === "impersonate" && req.method === "POST") {
    const reply = host.llm.results.reply;
    if (!reply) {
      const a = assemble(fsx, meta, chat.msgs, members[0] || null, null, { gen: "impersonate", model: modelOf() });
      const un = chatUserName(fsx, meta);
      // impersonation prompt: preset utility prompt, macros expanded
      // (blank = impersonate from history alone — no hidden default text)
      const preset = readJson("presets/" + (meta.presetId || "default") + ".json", null);
      const imp = preset && preset.utilityPrompts
        ? String(preset.utilityPrompts.impersonation || "").trim()
          .replace(/\{\{user\}\}/g, un)
          .replace(/\{\{char\}\}/g, (members[0] && members[0].name) || "")
        : "";
      // impersonation writes the USER's turn — an assistant prefill turn has
      // no business here, drop it
      const impMsgs = a.assistantPrefill ? a.messages.slice(0, -1) : a.messages;
      host.llm.request("reply", {
        sessionId: id,
        messages: imp ? [...impMsgs, { role: "user", content: imp }] : impMsgs,
        systemPrompt: a.systemPrompt,
        ...(modelOf() ? { model: modelOf() } : {}),
        ...(a.presetParams && Object.keys(a.presetParams).length ? { presetParams: a.presetParams } : {}),
        ...(a.reasoning ? { reasoning: a.reasoning } : {}),
        ...(a.reasoningTags ? { reasoningTags: a.reasoningTags } : {}),
        ...(a.thinkingBudget ? { thinkingBudget: a.thinkingBudget } : {}),
        ...(a.promptFormat ? { promptFormat: a.promptFormat } : {}),
        ...(a.assistantPrefill ? { assistantPrefill: a.assistantPrefill } : {}),
        ...(a.cache ? { cache: a.cache } : {}),
      });
      return pendingOut(meta);
    }
    if (reply.model === "error") return err(503, llmFailReason(reply));
    let text = String(reply.text || "").trim();
    const un = chatUserName(fsx, meta) + ":";
    text = text.replace(new RegExp("^" + esc(un)), "");
    return ok({ text: onSave(text.trim(), "user_input", members[0] || null).trim() });
  }
}
