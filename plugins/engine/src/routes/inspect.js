import { loadChat } from "../chat-files.js";
import { groupTurnPlan } from "../groups.js";
import { assemble, chatMembers, chatUserName, resolveCardVariants } from "../prompt.js";
import { cacheWiVectorBatch, embedCap, semanticEmbedWork } from "../vectors.js";
import { activateWorldInfo, presetMaxCtx, wiBudgetChars } from "../world-info.js";

export function promptPreviewRoute(c) {
  const { req, host, fsx, head, id, ok, err, readJson, body } = c;
  if (head === "prompt" && id === "preview" && req.method === "POST") {
    const b = body();
    const chat = loadChat(fsx, b.chatId);
    if (!chat) return err(404, "chat not found");
    const members = chatMembers(fsx, chat.meta);
    let msgs = chat.msgs;
    // message-scoped: simulate the prompt AS OF the peeked message, not the
    // chat's current tail. a user message includes itself (a generation would
    // answer it); an assistant message excludes itself (its prompt ended at
    // the previous turn)
    if (b.messageId) {
      const idx = chat.msgs.findLastIndex((m) => m.id === b.messageId);
      if (idx < 0) return err(404, "message not found");
      msgs = chat.msgs.slice(0, chat.msgs[idx].role === "user" ? idx + 1 : idx);
    }
    if (b.userText && String(b.userText).trim()) {
      msgs = msgs.concat([{ id: "peek", name: chatUserName(fsx, chat.meta), charId: null, role: "user", text: String(b.userText), swipes: [String(b.userText)], swipe: 0 }]);
    }
    // semantic prep mirrors the send path (dry run): one extra pass when
    // vectors are in play, so the peek shows the true request
    if (host.llm.embed && embedCap(fsx)) {
      const scanEmbedText = (b.userText && String(b.userText).trim() ? String(b.userText) + "\n" : "") + msgs.slice(-4).map((m) => m.text || "").join("\n");
      const personaIdsP = (() => {
        const pid = chat.meta.personaId || (() => { try { return JSON.parse(fsx.read("settings.json")).personaId; } catch { return null; } })();
        const per = pid ? readJson("personas/" + pid + ".json", null) : null;
        return per && Array.isArray(per.lorebookIds) ? per.lorebookIds : [];
      })();
      const work = semanticEmbedWork(fsx, chat.meta, personaIdsP, scanEmbedText);
      const haveScan = host.llm.embedResults && host.llm.embedResults.scan !== undefined;
      if (work && !haveScan) {
        host.llm.embed("scan", { texts: [scanEmbedText, ...work.needed.map((e) => e.text)] });
        return { __llmPending: true, stash: { wiEmbed: work.needed } };
      }
      if (work && haveScan) {
        const res = host.llm.embedResults.scan;
        if (Array.isArray(res)) {
          if (Array.isArray(req.stash && req.stash.wiEmbed) && req.stash.wiEmbed.length) cacheWiVectorBatch(fsx, req.stash.wiEmbed, res.slice(1));
        }
      }
    }
    const scanVecPeek = host.llm.embedResults && Array.isArray(host.llm.embedResults.scan) && host.llm.embedResults.scan[0] ? host.llm.embedResults.scan[0] : null;
    // the speaker a real generation from this point would use: the peeked
    // reply's own author, else the group's next in rotation
    const peekGroup = chat.meta.groupId ? readJson("groups/" + chat.meta.groupId + ".json", null) : null;
    const peeked = b.messageId ? chat.msgs.findLast((m) => m.id === b.messageId) : null;
    const lastReply = msgs.findLast((m) => m.role === "char" && !m.picture);
    const peekSpeaker = (peeked && peeked.role === "char" && members.find((m) => m.id === peeked.charId))
      || (peekGroup ? groupTurnPlan(peekGroup, members, lastReply ? lastReply.charId : null, b.userText || "", null)[0] : null)
      || members[0] || null;
    const a = assemble(fsx, chat.meta, msgs, peekSpeaker, null, { dryRun: true, scanVec: scanVecPeek, gen: "preview" });
    // tool defs ride the peek exactly as a send would (the wantsTools sibling
    // set) when the caller asks for them — host.siblingTools is absent on
    // engine builds without that contract
    const toolDefs = host && Array.isArray(host.siblingTools) ? host.siblingTools : null;
    return { __llmPreview: "reply", ...ok({
      sessionId: b.chatId,
      systemPrompt: a.systemPrompt, messages: a.messages, presetParams: a.presetParams, presetName: a.presetName,
      // the rest of the exact request envelope a generation would send
      // (chat profile model, else the global engine model — same resolution
      // a send uses)
      model: chat.meta.model != null ? chat.meta.model : (() => { try { return JSON.parse(fsx.read("settings.json")).model; } catch { return null; } })(),
      ...(a.reasoning ? { reasoning: a.reasoning } : {}),
      ...(a.reasoningTags ? { reasoningTags: a.reasoningTags } : {}),
      ...(a.thinkingBudget ? { thinkingBudget: a.thinkingBudget } : {}),
      ...(a.promptFormat ? { promptFormat: a.promptFormat } : {}),
      ...(a.assistantPrefill ? { assistantPrefill: a.assistantPrefill } : {}),
      ...(a.cache ? { cache: a.cache } : {}),
      ...(toolDefs && toolDefs.length ? { tools: toolDefs } : {}),
    }) };
  }
}
// Same activation path a generation runs, with real budget numbers — the
// app's "active entries" viewer shows this instead of a mock.
export function worldInfoStatusRoute(c) {
  const { req, fsx, head, ok, err, readJson, body } = c;
  if (head === "wi-status" && req.method === "POST") {
    const b = body();
    const chat = loadChat(fsx, String(b.chatId || ""));
    if (!chat) return err(404, "chat not found");
    const personaId = chat.meta.personaId || (() => { try { return JSON.parse(fsx.read("settings.json")).personaId; } catch { return null; } })();
    const persona = personaId ? readJson("personas/" + personaId + ".json", null) : null;
    const preset = readJson("presets/" + (chat.meta.presetId || "default") + ".json", null);
    const wi = activateWorldInfo(
      fsx, chat.meta,
      chat.msgs.filter((m) => m.role !== "system" && m.hidden !== true),
      persona?.lorebookIds || [], wiBudgetChars(preset),
      {
        dryRun: true, config: preset && preset.studio && preset.studio.worldInfo,
        sources: (() => {
          const base = chat.meta.characterId ? readJson("characters/" + chat.meta.characterId + "/card.json", null) : null;
          const card = resolveCardVariants(base, base && base.studio && base.studio.variantSelection);
          return {
            description: card ? card.description : null,
            personality: card ? card.personality : null,
            scenario: card ? card.scenario : null,
            persona: persona ? persona.description : null,
          };
        })(),
      },
    );
    return ok({
      fired: wi.trace, skipped: wi.skipped,
      usedChars: wi.used, budgetChars: wi.budgetChars,
      contextTokens: presetMaxCtx(preset),
    });
  }
}
