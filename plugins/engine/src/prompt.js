import { chatPersonaId } from "./chat-files.js";
import { searchDatabank } from "./databank.js";
import { expandMacros, macroCard } from "./macros.js";
import { loadMemories, recallMemories } from "./memories.js";
import { defaultPresetId } from "./presets.js";
import { loadRegexScripts, runRegexScripts } from "./regex.js";
import { globalVars, transcriptMacros } from "./variables.js";
import { activateWorldInfo, presetMaxCtx, wiBudgetChars } from "./world-info.js";

// injection depth: a finite number rounds down to a non-negative depth, and
// 0 is a real depth ("after the newest turn"), not a missing value
const injDepth = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};
const MARKER_ORDER_FALLBACK = ["main", "worldInfoBefore", "charDescription", "charPersonality", "scenario", "personaDescription", "worldInfoAfter", "dialogueExamples", "chatHistory", "postHistory"];

function orderedPrompts(preset) {
  const prompts = Array.isArray(preset && preset.prompts) ? preset.prompts : [];
  const byId = new Map();
  for (const p of prompts) if (p && p.identifier) byId.set(p.identifier, p);
  let order = null;
  if (preset && Array.isArray(preset.prompt_order)) {
    // Only a NON-EMPTY order is authoritative — legacy/corrupt files carry
    // empty entries and must fall through to the prompts list. Files from
    // other UIs pack several layouts into one file; the chat-completion
    // arrangement lives under character id 100001, so prefer it over any
    // other list (100000 is a different layout, not the author's active one).
    const po = preset.prompt_order.find((o) => o && o.character_id === 100001 && Array.isArray(o.order) && o.order.length)
      || preset.prompt_order.find((o) => o && o.character_id === 100000 && Array.isArray(o.order) && o.order.length)
      || preset.prompt_order.find((o) => o && Array.isArray(o.order) && o.order.length);
    if (po) order = po.order;
  }
  if (order) {
    return order.map((o) => ({ p: byId.get(o.identifier), enabled: o.enabled !== false })).filter((x) => x.p);
  }
  if (prompts.length) return prompts.map((p) => ({ p, enabled: p ? p.enabled !== false : false }));
  return MARKER_ORDER_FALLBACK.map((id) => ({ p: { identifier: id, marker: true, role: "system" }, enabled: true }));
}

/** The chat's persona as it is NOW (see chatPersonaId). Its current name is {{user}} for every new turn, so renaming or
 *  editing a persona reaches every chat that uses it; past user messages keep
 *  the name they were sent under. meta.userName only covers a chat whose
 *  persona file is gone. */
export function chatPersona(fsx, meta) {
  const pid = chatPersonaId(fsx, meta);
  let persona = null;
  if (pid) { try { persona = JSON.parse(fsx.read("personas/" + pid + ".json")); } catch {} }
  // NEVER call chatUserName from here: it is this function's own accessor, so
  // the fallback has to be the stored name, not another lookup. Reading the
  // persona through it recursed until the sandbox stack gave out, and every
  // chat that could not resolve a persona — no pick, no default in
  // settings.json, or a persona file a restore didn't bring along — failed
  // every generation, peek and title with "maximum call stack size exceeded".
  const userName = (persona && persona.name) || (typeof meta.userName === "string" && meta.userName) || "User";
  return { persona, personaId: persona ? pid : null, userName };
}
export const chatUserName = (fsx, meta) => chatPersona(fsx, meta).userName;

/** Field variants: a character can carry an alternate description /
 *  personality / scenario, and the chip row in the character editor picks
 *  which one the card sends. The choice lives on the card itself
 *  (studio.variantSelection = {desc, personality, scenario}), so every chat
 *  reads the same variant, and assembly resolves cards through it — prompt
 *  peek shows exactly what a send would send. */
const VARIANT_FIELDS = [
  ["desc", "description", "descVariants"],
  ["personality", "personality", "personalityVariants"],
  ["scenario", "scenario", "scenarioVariants"],
];
export function resolveCardVariants(card, sel) {
  if (!card || !sel || typeof sel !== "object") return card;
  let out = null;
  for (const [key, base, list] of VARIANT_FIELDS) {
    const id = sel[key];
    if (!id) continue;
    const bag = card.studio && Array.isArray(card.studio[list]) ? card.studio[list] : [];
    const v = bag.find((x) => x && x.id === id);
    if (!v || typeof v.content !== "string") continue;
    if (!out) out = { ...card };
    out[base] = v.content;
  }
  return out || card;
}

export function chatMembers(fsx, meta) {
  // returns [{id, name, card}] the bots participating in this chat, each card
  // resolved through the character's own variant selection
  if (meta.groupId) {
    let g = null;
    try { g = JSON.parse(fsx.read("groups/" + meta.groupId + ".json")); } catch {}
    if (!g) return [];
    const out = [];
    for (const mid of g.memberIds || []) {
      try {
        const card = JSON.parse(fsx.read("characters/" + mid + "/card.json"));
        const rcard = resolveCardVariants(card, card && card.studio && card.studio.variantSelection);
        out.push({ id: mid, name: rcard.name, card: rcard });
      } catch { /* member deleted */ }
    }
    return out;
  }
  if (meta.characterId) {
    try {
      const card = JSON.parse(fsx.read("characters/" + meta.characterId + "/card.json"));
      const rcard = resolveCardVariants(card, card && card.studio && card.studio.variantSelection);
      return [{ id: meta.characterId, name: rcard.name, card: rcard }];
    } catch {}
  }
  return [];
}

/**
 * Assemble the generation request body for a WOULD-BE message list.
 * msgs = messages BEFORE the reply being generated (already includes any
 * pending user message the caller staged). speaker = the member replying.
 */
export function assemble(fsx, meta, msgs, speaker, pendingUserText, opts) {
  const members = chatMembers(fsx, meta);
  const speakerCard = (speaker && speaker.card) || (members[0] && members[0].card) || null;
  const isGroup = !!meta.groupId && members.length > 0;
  const { persona, userName } = chatPersona(fsx, meta);
  const charName = speakerCard ? speakerCard.name : "";
  // generation type this assembly runs for — sections can restrict their
  // trigger list to it (send/swipe/continue/impersonate; a swipe on the last
  // message also satisfies "regenerate")
  const GEN_TYPES = {
    send: ["normal"], swipe: ["swipe", "regenerate"], continue: ["continue"],
    impersonate: ["impersonate"], preview: ["normal"], summarize: ["quiet"],
  };
  const genTypes = GEN_TYPES[(opts && opts.gen) || "send"] || GEN_TYPES.send;

  let preset = null;
  const presetId = meta.presetId || "default";
  try { preset = JSON.parse(fsx.read("presets/" + presetId + ".json")); } catch {}
  if (!preset) {
    // dead binding — the pinned preset was deleted (e.g. an import that
    // didn't survive): assemble with the user's DEFAULT preset instead of
    // silently degrading to the bare fallback layout
    try { preset = JSON.parse(fsx.read("presets/" + defaultPresetId(fsx) + ".json")); } catch {}
  }
  // studio bag: the full app preset rides the engine preset file
  const S = preset && preset.studio && typeof preset.studio.samplers === "object" ? preset.studio.samplers : null;
  // world info scans chat text (+ pending user text); lorebooks BOUND to the
  // active persona are always in scope alongside the chat's own books
  const scanMsgs = pendingUserText ? msgs.concat([{ text: pendingUserText }]) : msgs;
  const wiScanBase = scanMsgs.filter((m) => m.role !== "system" && m.hidden !== true);
  // the author's note can feed world-info keys too (its scan flag)
  const anScan = meta.authorNoteObject && meta.authorNoteObject.includeInWIScan === true ? [String(meta.authorNoteObject.text || "")] : [];
  const wi = activateWorldInfo(fsx, meta, anScan.length && anScan[0] ? wiScanBase.concat([{ text: anScan[0] }]) : wiScanBase, persona?.lorebookIds || [], wiBudgetChars(preset),
    // dry runs (peek) read timed effects but never consume them; the speaker
    // card fields + persona text feed entries with matchSources
    {
      dryRun: !!(opts && opts.dryRun), config: preset && preset.studio && preset.studio.worldInfo,
      scanVec: opts && opts.scanVec ? opts.scanVec : null,
      sources: {
        description: speakerCard ? speakerCard.description : null,
        personality: speakerCard ? speakerCard.personality : null,
        scenario: speakerCard ? speakerCard.scenario : null,
        persona: persona ? persona.description : null,
      },
    });

  const mc = transcriptMacros(msgs, {
    userName,
    charName,
    personaText: persona ? String(persona.description || "") : "",
    chatId: meta.id,
    card: macroCard(speakerCard),
    vars: meta.chatVars || (meta.chatVars = {}),
    // a peek must not change what the next real turn reads
    globals: opts && opts.dryRun ? { ...globalVars(fsx) } : globalVars(fsx),
    model: String((opts && opts.model) || meta.model || (() => { try { return JSON.parse(fsx.read("settings.json")).model; } catch { return ""; } })() || ""),
    genType: genTypes[0],
    maxContext: preset && preset.openai_max_context != null ? preset.openai_max_context : null,
    maxResponse: preset && preset.openai_max_tokens != null ? preset.openai_max_tokens : null,
    input: pendingUserText ? String(pendingUserText) : "",
    summary: String(meta.summary || ""),
  });

  // marker → text (pre-macro). `main` carries no engine default — the preset's
  // own main-prompt entry is the editable home for that text; the character
  // card's system_prompt (when present) wins over it.
  // generationMode "append": every member's card joins the prompt (labeled),
  // not just the speaker's — muted members stay out unless they're speaking.
  let groupCfg = null;
  if (meta.groupId) { try { groupCfg = JSON.parse(fsx.read("groups/" + meta.groupId + ".json")); } catch {} }
  if (isGroup) {
    const mutedIds = (groupCfg && groupCfg.mutedIds) || [];
    mc.group = members.map((m) => m.name).join(", ");
    mc.groupNotMuted = members.filter((m) => !mutedIds.includes(m.id)).map((m) => m.name).join(", ");
  }
  const rosterMembers = isGroup && groupCfg && groupCfg.generationMode === "append"
    ? members.filter((m) => !((groupCfg.mutedIds || []).includes(m.id)) || (speaker && m.id === speaker.id))
    : [];
  const joined = (pick) => rosterMembers.map((m) => (m.card && pick(m.card) ? "[" + m.card.name + "]\n" + pick(m.card) : null)).filter(Boolean).join("\n\n");
  const markers = {
    main: speakerCard && speakerCard.system_prompt && speakerCard.system_prompt.trim()
      ? speakerCard.system_prompt
      : "",
    nsfw: "",
    enhanceDefinitions: "",
    charDescription: rosterMembers.length ? joined((c) => c.description) : (speakerCard && speakerCard.description ? speakerCard.description : ""),
    charPersonality: rosterMembers.length ? joined((c) => c.personality) : (speakerCard && speakerCard.personality ? speakerCard.personality : ""),
    scenario: speakerCard && speakerCard.scenario ? speakerCard.scenario : "",
    personaDescription: persona && persona.description ? persona.description : "",
    worldInfoBefore: wi.before.length ? wi.before.join("\n") : "",
    worldInfoAfter: wi.after.length ? wi.after.join("\n") : "",
    // <START> separators become the example-chat marker line — a readable
    // block boundary instead of a literal tag the model might echo back
    dialogueExamples: (rosterMembers.length ? joined((c) => c.mes_example) : (speakerCard && speakerCard.mes_example ? speakerCard.mes_example : ""))
      .replace(/<START>/gi, "[Example Chat]"),
    chatHistory: "", // history rides the message array
    postHistory: speakerCard && speakerCard.post_history_instructions ? speakerCard.post_history_instructions : "",
  };

  // group instructions (who exists, who replies)
  if (isGroup) {
    const roster = members.map((m) => m.name).join(", ");
    markers.scenario = (markers.scenario ? markers.scenario + "\n\n" : "") +
      "This is a group scene. Participants: " + roster + ". The next reply comes from " + charName + " — write only " + charName + "'s actions and dialogue.";
  }

  // regex scripts — shared machinery (scope/placement/depth gates, studio
  // replace semantics); imported patterns are length-capped there so a bad
  // regex costs a hiccup, not a hang
  const scripts = loadRegexScripts(fsx, meta, members);
  // only prompt-stage scripts run here: stored rewrites are already baked
  // into the saved text, and preset sections are never regexed
  const rx = (text, placement, depth) => runRegexScripts(scripts, meta, members, text, [placement], depth, mc, "prompt");
  const rxWI = (text) => runRegexScripts(scripts, meta, members, text, ["wi"], null, mc, "prompt");

  const sub = (t) => expandMacros(t, mc);
  const subWI = (t) => expandMacros(rxWI(t), mc);

  // prompt entries → ordered {role, content} parts. The engine builds marker
  // CONTENT (card fields, world info, …) but the preset entry decides the ROLE
  // it is spoken with — every marker except chatHistory (whose turns are
  // inherently user/assistant) carries a switchable system/user/assistant role.
  const normRole = (r) => (r === "user" || r === "assistant" ? r : "system");
  // section groups + conditions ride the studio bag (the full editor preset
  // is stored verbatim); groupId/condition join in by section identifier
  const studioPreset = preset && preset.studio && typeof preset.studio === "object" ? preset.studio : null;
  const bagSections = new Map(
    Array.isArray(studioPreset && studioPreset.sections) ? studioPreset.sections.map((x) => [x && x.id, x]) : [],
  );
  const sectionGroups = new Map(
    Array.isArray(studioPreset && studioPreset.groups) ? studioPreset.groups.filter((g) => g && g.id).map((g) => [g.id, g]) : [],
  );
  // a condition gates its section on a chat variable: "var" (set + non-empty),
  // "var==value", "var!=value" — anything unparseable is ignored (always on)
  const condPasses = (cond) => {
    const c = String(cond || "").trim().replace(/\s*([=!])=\s*/g, "$1=");
    if (!c) return true;
    const vars = meta.chatVars || {};
    let m = /^([\w.-]+)!=(.+)$/.exec(c);
    if (m) return String(vars[m[1]] ?? "") !== m[2].trim();
    m = /^([\w.-]+)==(.+)$/.exec(c);
    if (m) return String(vars[m[1]] ?? "") === m[2].trim();
    if (/^[\w.-]+$/.test(c)) return String(vars[c] ?? "").trim() !== "";
    return true;
  };
  // wrap format per group: xml tags or a markdown heading; "none" groups
  // still merge consecutive members into one block
  const groupWrap = (g) => {
    const name = String(g && g.name || "group").trim();
    const tag = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
    if (g && g.wrapFormat === "xml") return { open: "<" + tag + ">", close: "</" + tag + ">" };
    if (g && g.wrapFormat === "markdown") return { open: "## " + name, close: "" };
    return { open: "", close: "" };
  };
  const before = []; // parts above the chat-history position
  const after = [];  // parts below it (post-history instructions)
  let sawHistory = false;
  const depthInj = [];
  // rows collect first so CONSECUTIVE same-group sections can merge into one
  // wrapped block; at-depth (absolute) sections never group
  const rows = [];
  for (const { p, enabled } of orderedPrompts(preset)) {
    if (!enabled) continue;
    if (p.marker && p.identifier === "chatHistory") { sawHistory = true; continue; }
    const bagSec = bagSections.get(p.identifier) || null;
    if (!condPasses(bagSec ? bagSec.condition : null)) continue;
    // a section can gate itself to generation types (imported trigger lists;
    // absent/empty = always) — the engine maps its ops onto those types
    const trig = bagSec && Array.isArray(bagSec.injectionTriggers) && bagSec.injectionTriggers.length ? bagSec.injectionTriggers : null;
    if (trig && genTypes && !genTypes.some((g) => trig.includes(g))) continue;
    let raw;
    if (p.marker && p.identifier === "main") {
      // main prompt: the character card's system_prompt wins; the preset's own
      // entry text (where the editable default lives) is the fallback. A main
      // entry marked "forbid overrides" keeps the preset's text instead — the
      // card doesn't get to speak over it.
      raw = String(markers.main || "").trim() && !(bagSec && bagSec.forbidOverrides) ? String(markers.main) : String(p.content || "");
    } else if (p.marker) {
      // other markers: engine-built text, overridable by preset content.
      // world-info markers run the WI-aware regex pass (wi + prompt scripts).
      raw = String(p.content || "").trim() ? String(p.content) : (markers[p.identifier] != null ? String(markers[p.identifier]) : "");
    } else {
      raw = String(p.content || "");
    }
    const isWIMarker = p.marker && (p.identifier === "worldInfoBefore" || p.identifier === "worldInfoAfter");
    const t = isWIMarker ? subWI(raw) : sub(raw);
    if (!t.trim()) continue;
    if (p.injection_position === "absolute" && typeof p.injection_depth === "number") {
      depthInj.push({ depth: Math.max(0, Math.floor(p.injection_depth)), role: normRole(p.role), content: t });
    } else {
      rows.push({ role: normRole(p.role), content: t, groupId: bagSec ? (bagSec.groupId || null) : null, afterHistory: sawHistory });
    }
  }
  // merge consecutive rows of the same group into one wrapped block
  for (let i = 0; i < rows.length; ) {
    const g = rows[i].groupId;
    if (!g) { (rows[i].afterHistory ? after : before).push({ role: rows[i].role, content: rows[i].content }); i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].groupId === g && rows[j].afterHistory === rows[i].afterHistory) j++;
    const def = sectionGroups.get(g);
    const wrap = groupWrap(def);
    const inner = rows.slice(i, j).map((r) => r.content).join("\n");
    const content = [wrap.open, inner, wrap.close].filter(Boolean).join("\n");
    (rows[i].afterHistory ? after : before).push({ role: rows[i].role, content });
    i = j;
  }

  // data bank: top chunks relevant to the recent text join the system block
  // (term-scored retrieval over enabled files — basic RAG)
  const dbScan = (pendingUserText ? pendingUserText + "\n" : "") + msgs.slice(-4).map((m) => m.text || "").join("\n");
  const extras = [];
  // long-term memories: pinned always + density-recalled against the recent
  // window (Memory & Summary settings); a block the model can rely on across
  // cutoffs and summaries
  const memCfg = (() => { try { return (JSON.parse(fsx.read("settings.json")).ui || {}).memory || {}; } catch { return {}; } })();
  if (memCfg.enabled !== false) {
    const mems = recallMemories(loadMemories(fsx, meta.id), dbScan, 1500, 8);
    if (mems.length) {
      extras.push({ role: "system", content: "[Long-term memories — durable facts from this chat]\n" + mems.map((e) => "- " + e.text).join("\n") });
    }
  }
  const dbHits = searchDatabank(fsx, dbScan, 3);
  if (dbHits.length) {
    extras.push({ role: "system", content: "[Data bank — retrieved reference material]\n" + dbHits.map((h) => h.text).join("\n---") });
  }

  // running chat summary, injected per the Memory & Summary settings
  // (after the system block, or in-chat at a depth — never when off)
  if (String(meta.summary || "").trim()) {
    const uiCfg = (() => { try { return JSON.parse(fsx.read("settings.json")).ui || {}; } catch { return {}; } })();
    const sum = uiCfg.summary || {};
    if (sum.position !== "off") {
      const txt = sub(String(sum.template || "[Summary: {{summary}}]"));
      if (txt.trim()) {
        if (sum.position === "in-chat") {
          depthInj.push({ depth: injDepth(sum.depth, 2), role: sum.role === "user" || sum.role === "assistant" ? sum.role : "system", content: txt });
        } else {
          extras.push({ role: "system", content: txt });
        }
      }
    }
  }

  // author's note: the object form carries position/depth/role
  // (before-system / after-system / in-chat @ depth); the legacy string form
  // keeps its historical behavior (in-chat depth 4, user role)
  const an = meta.authorNoteObject && typeof meta.authorNoteObject === "object"
    ? meta.authorNoteObject
    : (meta.authorNote && String(meta.authorNote).trim() ? { text: String(meta.authorNote), position: "in-chat", depth: 4, role: "user" } : null);
  // insertion frequency: every N messages (1 = every generation)
  const anFreq = Math.max(1, Math.floor(Number(an && an.frequency)) || 1);
  if (an && String(an.text || "").trim() && (msgs.length % anFreq === 0 || an.position !== "in-chat")) {
    const anContent = "[Author's note]\n" + String(an.text);
    const anRole = an.role === "user" || an.role === "assistant" ? an.role : "system";
    if (an.position === "before-system") before.unshift({ role: anRole, content: anContent });
    else if (an.position === "in-chat") depthInj.push({ depth: injDepth(an.depth, 4), role: anRole, content: anContent });
    else extras.push({ role: anRole, content: anContent });
  }
  for (const w of wi.depth) depthInj.push({ depth: w.depth, role: w.role, content: subWI(w.content) });

  // history → model messages. Names follow the preset's names-behavior:
  // none never, default only where turns must be told apart (groups),
  // content always prefixes "Name: ", completion rides the message `name`
  // field (the OpenAI wire format carries it; endpoints without it ignore).
  // hide-from-AI (ghost) messages are dropped from the prompt entirely —
  const namesBehavior = (() => {
    const v = preset && preset.studio && preset.studio.namesBehavior;
    return ["none", "default", "content", "completion"].includes(v) ? v : "default";
  })();
  const prefixNames = namesBehavior === "content" || namesBehavior === "completion" || (namesBehavior === "default" && isGroup);
  // messages ABOVE the memory cutoff leave the prompt — the running summary
  // covers them (freeing context is the cutoff's whole point; the cutoff
  // message itself stays). Unknown cutoff ids drop nothing.
  let histMsgs = msgs;
  if (meta.memoryCutoffMessageId) {
    const cut = msgs.findLastIndex((m) => m.id === meta.memoryCutoffMessageId);
    if (cut > 0) histMsgs = msgs.slice(cut);
  }
  const visibleHist = histMsgs.filter((m) => (m.role === "user" || m.role === "char") && m.hidden !== true);
  const history = visibleHist
    .map((m, i) => {
      const depth = visibleHist.length - 1 - i;
      // a reply's {{char}} is whoever wrote it; a user turn keeps the speaker's
      const body = expandMacros(rx(m.text, m.role === "user" ? "user_input" : "ai_output", depth), m.role === "char" && m.name ? { ...mc, charName: m.name } : mc);
      return {
        role: m.role === "user" ? "user" : "assistant",
        ...(prefixNames && m.name && namesBehavior === "completion" ? { name: m.name } : {}),
        content: prefixNames && m.name ? m.name + ": " + body : body,
        ...(m.role === "char" && S?.reasoning?.history !== "individual" ? {
          ...(m.extra?.replay && m.extra.replay.text.trim() === m.text.trim() && body === m.text
            ? { replay: { ...m.extra.replay, text: prefixNames && m.name ? m.name + ": " + body : body } } : {}),
          reasoning: Array.isArray(m.extra?.parts)
            ? m.extra.parts.filter((p) => p.type === "thinking").map((p) => p.text).join("\n")
            : m.extra?.reasoning,
          reasoningModel: m.extra?.model,
        } : {}),
      };
    });

  // compact chat history: the visible chat collapses into ONE message of the
  // chosen role, turns labeled by per-role prefixes so speakers stay
  // distinguishable. For endpoints that bill per message or trip over long
  // role alternations. \n escapes in the fields are real newlines.
  const chCfg = preset && preset.studio && typeof preset.studio.compactHistory === "object" ? preset.studio.compactHistory : null;
  const compactOn = !!(chCfg && chCfg.enabled === true && history.length > 0);
  if (compactOn && history.length > 0) {
    const sep = chCfg.separator === "space" ? " " : chCfg.separator === "newline" ? "\n" : "\n\n";
    const unesc = (s) => String(s == null ? "" : s).replace(/\\n/g, "\n");
    const body = history.map((h, i) => {
      const isUser = h.role === "user";
      const ctx = { ...mc, charName: (visibleHist[i] && visibleHist[i].name) || charName };
      const pre = expandMacros(unesc(isUser ? chCfg.userPrefix : chCfg.charPrefix), ctx);
      const suf = expandMacros(unesc(isUser ? chCfg.userSuffix : chCfg.charSuffix), ctx);
      const thinking = h.reasoning ? (preset.reasoningTags?.open || "<think>") + "\n" + h.reasoning + "\n" + (preset.reasoningTags?.close || "</think>") + "\n\n" : "";
      return pre + thinking + h.content + suf;
    }).join(sep);
    const role = chCfg.role === "user" || chCfg.role === "system" ? chCfg.role : "assistant";
    history.length = 0;
    history.push({ role, content: body });
  }

  // context trimming (chars/4 estimate against openai_max_context)
  const budget = presetMaxCtx(preset) * 4;
  const fixedLen = before.concat(extras, after).reduce((a, m) => a + m.content.length, 0);
  const histLen = (m) => m.content.length + (m.replay ? JSON.stringify(m.replay.messages).length : (m.reasoning?.length || 0));
  // the oldest turns leave until the rest fits (one always stays); what fell
  // out is reported: automatic compaction fires on it
  let total = fixedLen + history.reduce((a, m) => a + histLen(m), 0);
  let trimmed = 0;
  while (total > budget && history.length - trimmed > 1) total -= histLen(history[trimmed++]);
  if (trimmed) history.splice(0, trimmed);

  // utility prompts (preset-level, blank = off):
  //  - new-chat marker rides at the very top of a freshly started chat
  //  - group nudge rides at depth 0, naming this turn's speaker
  const util = (preset && preset.utilityPrompts) || {};
  const lead = [...before, ...extras];
  const newChatTxt = String(util.newChat || "").trim();
  // "freshly started" = no generated replies yet (the greeting may exist, and
  // the first user turn is already staged) — a history-length check can never
  // see this, every send has at least greeting + user
  if (newChatTxt && msgs.filter((x) => x.role === "char").length <= 1) lead.push({ role: "system", content: sub(newChatTxt) });
  const groupNudgeTxt = String(util.groupNudge || "").trim();
  if (isGroup && groupNudgeTxt) {
    depthInj.push({ depth: 0, role: "system", content: sub(groupNudgeTxt).replace(/\{\{name\}\}/g, charName) });
  }

  // Depth injections (author's note, world info at a depth, the group nudge,
  // absolute-position sections) live INSIDE the chat history: depth N means
  // "N turns from the newest", depth 0 means "after the last turn". They must
  // not count past the history into the post-history block — an instruction
  // meant to be the last thing the model reads stays last.
  // Within one depth the roles stack system-closest-to-the-reply, so the
  // strongest instruction is the one the model reads most recently.
  const ROLE_RANK = { assistant: 0, user: 1, system: 2 };
  const byDepth = new Map();
  for (const d of depthInj) {
    if (!byDepth.has(d.depth)) byDepth.set(d.depth, []);
    byDepth.get(d.depth).push({ role: d.role, content: d.content });
  }
  for (const dep of Array.from(byDepth.keys()).sort((a, b) => b - a)) {
    const group = byDepth.get(dep);
    // stable sort by role rank: same-role entries keep collection order
    group.forEach((g, i) => { g._i = i; });
    group.sort((a, b) => (ROLE_RANK[a.role] - ROLE_RANK[b.role]) || (a._i - b._i));
    const idx = Math.max(0, history.length - dep);
    history.splice(idx, 0, ...group.map((g) => ({ role: g.role, content: g.content })));
  }

  // history lands at its marker position (end of the prompt when unplaced)
  const messages = sawHistory ? [...lead, ...history, ...after] : [...lead, ...after, ...history];

  // Assistant prefill (the "start reply with" seed): when the LAST entry of the
  // prompt chain is an assistant-role preset section, it is not an injection —
  // it becomes the seed of the reply (sent as a trailing assistant turn, the
  // model continues from it, the committed message starts with it). The
  // samplers' assistantPrefill field does the same when no section claims it.
  let assistantPrefill = "";
  const lastPart = messages[messages.length - 1];
  if (lastPart && lastPart.role === "assistant" && after.length > 0 && after[after.length - 1] === lastPart) {
    assistantPrefill = lastPart.content;
    messages.pop();
  } else if (S && typeof S.assistantPrefill === "string" && S.assistantPrefill.trim()) {
    assistantPrefill = S.assistantPrefill;
  }

  // Compact system messages: consecutive SYSTEM entries (the system prompt,
  // depth-injected notes, world info) merge into one denser block. Chat
  // turns stay separate — merging user/assistant pairs is post-processing's
  // job, not this switch's.
  if (preset && preset.studio && preset.studio.squashSystemMessages) {
    const squashed = [];
    for (const m of messages) {
      const last = squashed[squashed.length - 1];
      if (m.role === "system" && last && last.role === "system") last.content = last.content + "\n" + m.content;
      else squashed.push({ ...m });
    }
    messages.length = 0;
    messages.push(...squashed);
  }

  // Prompt post-processing: a STRUCTURAL transform of the assembled list for
  // endpoints that mishandle repeated roles — merge collapses consecutive
  // same-role entries, semi also forces mid-prompt system entries to user,
  // strict adds a leading user turn after the system block, single folds
  // everything into one user message. No model, no rewrite — structure only.
  const pp = preset && preset.studio && preset.studio.promptPostProcessing;
  if (pp && pp.enabled === true && pp.mode && pp.mode !== "none") {
    let list = messages.slice();
    if (pp.mode === "single") {
      list = [{ role: "user", content: list.map((m) => m.reasoning ? "<think>\n" + m.reasoning + "\n</think>\n\n" + m.content : m.content).filter(Boolean).join("\n\n") }];
    } else {
      const mergePass = (src) => {
        const merged = [];
        for (const m of src) {
          const last = merged[merged.length - 1];
          if (last && last.role === m.role && m.content && !last.replay && !m.replay && !last.reasoning && !m.reasoning) last.content = last.content + "\n\n" + m.content;
          else merged.push({ ...m });
        }
        return merged;
      };
      list = mergePass(list);
      if (pp.mode === "semi" || pp.mode === "strict") {
        for (let i = 1; i < list.length; i++) {
          if (list[i].role === "system") list[i] = { ...list[i], role: "user" };
        }
      }
      if (pp.mode === "strict") {
        if (list.length && list[0].role === "system" && (list.length === 1 || list[1].role !== "user")) {
          list.splice(1, 0, { role: "user", content: "Let's get started." });
        } else if (list.length && list[0].role !== "system" && list[0].role !== "user") {
          list.unshift({ role: "user", content: "Let's get started." });
        }
        list = mergePass(list);
      }
    }
    messages.length = 0;
    messages.push(...list);
  }
  // the prefill rides as the FINAL turn — after squash, so it stays separate
  if (assistantPrefill) messages.push({ role: "assistant", content: assistantPrefill });

  // sampler (kernel GenerateRequest.presetParams). The classic numerics ride
  // the top-level preset keys; everything else lives in the studio bag
  // and maps to standard OpenAI body keys (seed/stop/logit_bias) or the
  // llama.cpp/kobold textgen keys (enabled-only — an "off"
  // sampler must not add unknown params to a strict endpoint).
  const params = {};
  for (const [k, alias] of [["top_p", "top_p"], ["top_k", "top_k"], ["min_p", "min_p"], ["repetition_penalty", "rep_pen"], ["frequency_penalty", "frequency_penalty"], ["presence_penalty", "presence_penalty"]]) {
    const v = preset ? preset[k] : undefined;
    const v2 = preset ? preset[alias] : undefined;
    if (typeof v === "number") params[k] = v;
    else if (typeof v2 === "number") params[k] = v2;
  }
  // imported presets carry the wider textgen sampler set; each key rides the
  // body only when the preset sets it (keep in sync with the importer's sweep)
  const extraNum = [
    "top_a", "typical_p", "eta_cutoff", "epsilon_cutoff", "repetition_penalty_range",
    "no_repeat_ngram_size", "penalty_alpha", "guidance_scale", "negative_prompt_scale",
    "smoothing_factor", "smoothing_curve", "dry_multiplier", "dry_base", "dry_allowed_length",
    "dry_last_n", "xtc_probability", "xtc_threshold", "dynatemp_min", "dynatemp_max",
    "dynatemp_exponent", "mirostat_mode", "mirostat_tau", "mirostat_eta", "temperature_last",
  ];
  if (preset) {
    for (const k of extraNum) if (typeof preset[k] === "number") params[k] = preset[k];
    for (const k of ["temperature_last", "skip_special_tokens", "ban_eos_token", "add_bos_token"]) if (typeof preset[k] === "boolean") params[k] = preset[k];
    if (typeof preset.negative_prompt === "string" && preset.negative_prompt.trim()) params.negative_prompt = preset.negative_prompt;
    if (typeof preset.seed === "number" && preset.seed >= 0) params.seed = preset.seed;
  }
  if (S) {
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    if (num(S.seed) != null && S.seed >= 0) params.seed = S.seed;
    if (Array.isArray(S.stopStrings) && S.stopStrings.filter((x) => typeof x === "string" && x).length) {
      // macros expand in stop strings ("\n{{user}}:" → "\nDaisy:")
      params.stop = S.stopStrings.filter(Boolean).map((x) => sub(x));
    }
    if (Array.isArray(S.logitBias) && S.logitBias.length) {
      const lb = {};
      for (const e of S.logitBias) {
        const id = parseInt(e && e.token, 10);
        const b = num(e && e.bias);
        if (Number.isFinite(id) && b != null) lb[String(id)] = b;
      }
      if (Object.keys(lb).length) params.logit_bias = lb;
    }
  }
  // compact history's stop string: halts the model the moment it starts the
  // user's next turn (the default is the user prefix), so a compacted
  // assistant-role history stays the model's own output
  if (compactOn && chCfg && String(chCfg.stopString || "").trim()) {
    const stopTxt = sub(String(chCfg.stopString).replace(/\\n/g, "\n"));
    if (stopTxt && !(params.stop || []).includes(stopTxt)) params.stop = [...(params.stop || []), stopTxt];
  }
  // verbosity rides the raw request body through the sampling passthrough:
  // OpenAI-compatible endpoints forward it (models with the control act on
  // it, e.g. gpt-5-style verbosity), every other adapter ignores unknown
  // keys. Auto sends nothing at all.
  const verb = preset && preset.studio && typeof preset.studio.verbosity === "string"
    && ["low", "medium", "high"].includes(preset.studio.verbosity) ? preset.studio.verbosity : null;
  if (verb) params.verbosity = verb;
  // Anthropic prompt caching: the kernel caches by default; the preset can
  // opt out, or pin the history breakpoint a fixed number of role runs back
  // (plus one two runs deeper) so an unchanging prefix stays cached while
  // the tail churns, and can ask for the endpoint's 1h window. Other
  // transports ignore the depth. Builds before the pinned flag stored the
  // pin toggle as `enabled` with caching always on, so a legacy block reads
  // its `enabled` as the pin and never as an opt-out.
  const cacheBag = S && S.cache && typeof S.cache === "object" ? S.cache : null;
  let cacheCfg = null;
  if (cacheBag) {
    const legacy = cacheBag.pinned === undefined;
    const enabled = legacy ? true : cacheBag.enabled !== false;
    const pinned = legacy ? cacheBag.enabled === true : cacheBag.pinned === true;
    const ttl = cacheBag.ttl === "long" ? "long" : "short";
    if (!enabled) cacheCfg = { retention: "none" };
    else if (pinned && Number.isInteger(cacheBag.depth) && cacheBag.depth >= 0) cacheCfg = { depth: cacheBag.depth, retention: ttl };
    else if (ttl === "long") cacheCfg = { retention: "long" };
  }
  const presetParams = {
    ...(preset && typeof preset.temperature === "number" ? { temperature: preset.temperature } : {}),
    ...(preset && typeof preset.openai_max_tokens === "number" && preset.openai_max_tokens > 0 ? { max_tokens: preset.openai_max_tokens } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };

  return {
    // role-carrying messages only — system-role entries ride the array in
    // order and the transport hoists them into the provider system prompt
    messages,
    presetParams,
    ...(assistantPrefill ? { assistantPrefill } : {}),
    ...(cacheCfg ? { cache: cacheCfg } : {}),
    ...(preset && typeof preset.reasoning === "string" && preset.reasoning !== "off" ? { reasoning: preset.reasoning } : {}),
    ...(preset && preset.reasoningTags && preset.reasoningTags.open && preset.reasoningTags.close ? { reasoningTags: preset.reasoningTags } : {}),
    ...(preset && typeof preset.thinkingBudget === "number" && preset.thinkingBudget > 0 ? { thinkingBudget: preset.thinkingBudget } : {}),
    ...promptFormatOf(preset),
    presetName: preset && preset.name ? preset.name : "default",
    trimmed,
  };
}

/** The preset's text completion format, when it overrides the connection:
 *  a format id, "auto", or the custom markers. Chat completion connections
 *  ignore it. */
function promptFormatOf(preset) {
  const pf = preset && preset.studio && preset.studio.promptFormat;
  if (!pf || typeof pf.use !== "string" || pf.use === "connection") return {};
  if (pf.use !== "custom") return { promptFormat: pf.use };
  return pf.custom && typeof pf.custom === "object" ? { promptFormat: pf.custom } : {};
}
