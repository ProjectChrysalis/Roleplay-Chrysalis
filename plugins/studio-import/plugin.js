/**
 * Studio Import — clean-room data import against public file formats.
 * Parsed files use /import/batch. Archives use /import/zip with bounded
 * entry batches supplied by the engine's file-backed upload service.
 */

// ---------- PNG card extraction (own parser) ----------
function b64ToBytes(b64) {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (table.indexOf(clean[i]) << 18) | (table.indexOf(clean[i + 1]) << 12) | ((table.indexOf(clean[i + 2]) & 63) << 6) | ((table.indexOf(clean[i + 3]) & 63) & 63);
    out.push((n >> 16) & 255);
    if (clean[i + 2] && clean[i + 2] !== "=") out.push((n >> 8) & 255);
    if (clean[i + 3] && clean[i + 3] !== "=") out.push(n & 255);
  }
  return out;
}
function latin1(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
function extractCardFromPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  let off = 8;
  let v2 = null;
  while (off + 12 <= bytes.length) {
    const len = bytes[off] * 0x1000000 + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
    if (off + 12 + len > bytes.length) break;
    const type = latin1(bytes.slice(off + 4, off + 8));
    if (type === "tEXt" || type === "iTXt") {
      const data = bytes.slice(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1(data.slice(0, nul));
        if (keyword === "ccv3" || keyword === "chara") {
          try {
            let start = nul + 1;
            if (type === "iTXt") {
              if (data[start] !== 0 || data[start + 1] !== 0) throw new Error("compressed text is unsupported");
              const languageEnd = data.indexOf(0, start + 2);
              const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
              if (translatedEnd < 0) throw new Error("invalid text chunk");
              start = translatedEnd + 1;
            }
            const payload = latin1(data.slice(start));
            const text = type === "iTXt" && keyword === "ccv3" && payload.trimStart().startsWith("{")
              ? new TextDecoder().decode(new Uint8Array(data.slice(start)))
              : new TextDecoder().decode(new Uint8Array(b64ToBytes(payload)));
            const card = JSON.parse(text);
            if (keyword === "ccv3") return card;
            if (!v2) v2 = card;
          } catch { /* next chunk */ }
        }
      }
    }
    off += 12 + len;
    if (type === "IEND") break;
  }
  return v2;
}

// ---------- normalizers ----------
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
// Backup zips carry chat titles only as slug filenames ("crossroads-at-dusk-fork-cXXXXXXXXXXXX"):
// recover a readable title by dropping the trailing engine id and un-slugging.
const unslugTitle = (s) => {
  const pretty = String(s)
    .replace(/-[a-z][a-z0-9]{9,}$/i, "")
    .replace(/-/g, " ")
    .replace(/(^|\s)\S/g, (m) => m.toUpperCase())
    .trim();
  return pretty || String(s);
};
const firstOf = (v) => (Array.isArray(v) ? String(v[0] || "") : v === undefined ? "" : String(v));

/** Collection folders a backup can carry, ours and the foreign layouts'.
 *  Matching one anchors the entry: everything above it is wrapper folders
 *  (data/, default-user/, the install directory someone zipped) and is cut. */
const COLLECTION_DIRS = new Set([
  "characters", "chats", "group chats", "groups", "worlds", "presets", "personas",
  "regex", "lorebooks", "themes", "backgrounds", "extensions", "databank", "memories",
  "assets", "user settings", "openai settings", "textgen settings", "koboldai settings",
  "novelai settings", "instruct", "context", "quickreplies", "user avatars",
]);
/** Files that mean something at a backup's root (and nowhere else). */
const ROOT_FILES = new Set(["card.json", "settings.json", "personas.json", "library.json", "meta.json"]);

/** A zip entry's path as our tree sees it, wrapper folders removed. Unknown
 *  paths ride through untouched — a name we don't recognize is skipped later
 *  anyway, and mangling it would only make the summary harder to read. */
function normalizeEntryName(raw) {
  const segs = String(raw).split("/").filter((s) => s && s !== ".");
  for (let i = 0; i < segs.length - 1; i++) {
    if (COLLECTION_DIRS.has(segs[i].toLowerCase())) return [segs[i].toLowerCase() === "user settings" ? "User Settings" : segs[i].toLowerCase(), ...segs.slice(i + 1)].join("/");
  }
  const base = segs[segs.length - 1] || String(raw);
  return ROOT_FILES.has(base.toLowerCase()) ? base : String(raw);
}

/** Base64 of a binary zip entry, or null for a text/oversized one. The kernel
 *  tags these `__b64__`; an older spelling (`__b64`) is still accepted so a
 *  mismatch here can never again silently drop every PNG card in a backup. */
const entryBase64 = (e) =>
  e && typeof e === "object" && (e.__b64__ === true || e.__b64 === true) && typeof e.base64 === "string" ? e.base64 : null;

/** PNG tEXt chunk reader for embedded cards ("chara" base64 JSON, v2, or
 *  "ccv3" JSON) — mirrors what the browser-side importer does with .png
 *  cards, so backup zips with PNG characters import fully plugin-side. */
function cardFromPngBase64(b64) {
  try { return extractCardFromPng(new Uint8Array(b64ToBytes(b64))); } catch { return null; }
}


const CARD_KNOWN_FIELDS = new Set([
  "name", "description", "personality", "scenario", "first_mes", "mes_example",
  "alternate_greetings", "creator_notes", "creatorcomment", "tags", "system_prompt",
  "post_history_instructions", "character_book", "avatar", "extensions",
]);

function normalizeCard(raw, avatarDataUrl) {
  if (!raw) return null;
  const d = raw && typeof raw.data === "object" && raw.data ? raw.data : raw;
  if (!d || typeof d.name !== "string" || !d.name) return null;
  // v3-only and unknown data fields ride the card verbatim
  const passthrough = {};
  for (const [k, v] of Object.entries(d)) {
    if (!CARD_KNOWN_FIELDS.has(k) && v !== undefined && v !== null) passthrough[k] = v;
  }
  const isV3 = raw.spec === "chara_card_v3" || d.spec === "chara_card_v3";
  return {
    spec: isV3 ? "chara_card_v3" : "chara_card_v2", name: d.name,
    ...(isV3 ? { spec_version: "3.0" } : {}),
    ...passthrough,
    description: firstOf(d.description), personality: firstOf(d.personality),
    scenario: firstOf(d.scenario), first_mes: firstOf(d.first_mes), mes_example: firstOf(d.mes_example),
    ...(Array.isArray(d.alternate_greetings) && d.alternate_greetings.length ? { alternate_greetings: d.alternate_greetings.map(String) } : {}),
    ...(typeof d.creator_notes === "string" && d.creator_notes ? { creator_notes: d.creator_notes } : {}),
    ...(typeof d.creatorcomment === "string" && d.creatorcomment ? { creator_notes: d.creatorcomment } : {}),
    ...(Array.isArray(d.tags) && d.tags.length ? { tags: d.tags.map(String) } : {}),
    ...(typeof d.system_prompt === "string" && d.system_prompt ? { system_prompt: d.system_prompt } : {}),
    ...(typeof d.post_history_instructions === "string" && d.post_history_instructions ? { post_history_instructions: d.post_history_instructions } : {}),
    ...(d.extensions && typeof d.extensions === "object" ? { extensions: d.extensions } : {}),
    ...(avatarDataUrl && typeof avatarDataUrl === "string" && avatarDataUrl.startsWith("data:") ? { avatar: avatarDataUrl } : {}),
  };
}

/** Card-spec v3 assets: {type, name, uri, ext}. `icon`+`main` is the default
 *  avatar, `emotion` entries are expression sprites. URIs: __asset:/embeded://
 *  point into the package (assetDict), ccdefault: is the source PNG, data:
 *  carries the bytes inline. Returns {avatar, expressions} with what could be
 *  resolved within size caps; unresolvable assets are skipped, never faked. */
function resolveCardAssets(card, assetDict, sourceAvatar) {
  const out = { avatar: null, expressions: [] };
  const assets = Array.isArray(card && card.assets) ? card.assets : [];
  const MAX_AVATAR = 90 * 1024 * 1024;
  const MAX_EMOTION = 90 * 1024 * 1024;
  for (const a of assets) {
    if (!a || typeof a !== "object" || typeof a.uri !== "string") continue;
    let url = null;
    if (a.uri.startsWith("__asset:") || a.uri.startsWith("embeded://")) {
      const b64 = assetDict[a.uri.replace(/^(?:__asset:|embeded:\/\/)/, "")];
      if (b64 && b64.startsWith("/v1/apps/")) url = b64;
      else if (b64) url = "data:image/" + (a.ext === "webp" ? "webp" : a.ext === "jpeg" || a.ext === "jpg" ? "jpeg" : "png") + ";base64," + b64;
    } else if (a.uri === "ccdefault:") {
      url = typeof sourceAvatar === "string" ? sourceAvatar : null;
    } else if (a.uri.startsWith("data:")) {
      url = a.uri;
    }
    if (!url) continue;
    if (a.type === "icon" && a.name === "main") {
      if (url.length < MAX_AVATAR) out.avatar = url;
    } else if (a.type === "emotion" && typeof a.name === "string" && a.name && url.length < MAX_EMOTION) {
      out.expressions.push({ name: a.name, url });
    }
  }
  return out;
}

function keyList(k) {
  if (Array.isArray(k)) return k.filter((x) => typeof x === "string");
  if (typeof k === "string") return k.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Card-embedded books (the card-spec shape: flat entries with keys/
 *  secondary_keys/insertion_order + an extensions bag) rebuilt as world-info
 *  entries so the shared normalizer handles both. */
function embeddedBookToWorld(raw) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.entries) ? raw.entries : raw.entries && typeof raw.entries === "object" ? Object.values(raw.entries) : null;
  if (!list || !list.length) return null;
  const entries = {};
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const id = typeof entry.id === "number" ? entry.id : index;
    const x = entry.extensions && typeof entry.extensions === "object" ? entry.extensions : {};
    entries[id] = {
      uid: id,
      key: entry.keys, keysecondary: entry.secondary_keys,
      comment: entry.comment || entry.name || "",
      content: entry.content,
      constant: entry.constant === true, selective: entry.selective === true,
      order: typeof entry.insertion_order === "number" ? entry.insertion_order : 100,
      position: typeof x.position === "number" ? x.position : entry.position === "before_char" ? 0 : 1,
      disable: entry.enabled === false,
      excludeRecursion: x.exclude_recursion === true, preventRecursion: x.prevent_recursion === true,
      delayUntilRecursion: x.delay_until_recursion === true,
      probability: x.probability, useProbability: x.useProbability,
      depth: x.depth, selectiveLogic: x.selectiveLogic,
      group: x.group, groupOverride: x.group_override === true, groupWeight: x.group_weight,
      scanDepth: x.scan_depth, caseSensitive: x.case_sensitive,
      matchWholeWords: x.match_whole_words, useGroupScoring: x.use_group_scoring,
      automationId: x.automation_id, role: x.role,
      vectorized: x.vectorized === true,
      sticky: x.sticky, cooldown: x.cooldown, delay: x.delay,
      matchPersonaDescription: x.match_persona_description === true,
      matchCharacterDescription: x.match_character_description === true,
      matchCharacterPersonality: x.match_character_personality === true,
      matchScenario: x.match_scenario === true,
      ignoreBudget: x.ignore_budget === true,
    };
  });
  return { entries };
}

// world_info_position: 0 before-char, 1 after-char, 2 AN-top, 3 AN-bottom,
// 4 at-depth, 5 EM-top, 6 EM-bottom, 7 outlet. The studio engine models
// before/after/at_depth — everything else lands after the char block.
// entry role: 0 system, 1 user, 2 assistant.
function normalizeBook(raw, fallbackName) {
  if (!raw || !raw.entries || typeof raw.entries !== "object") return null;
  const name = typeof raw.name === "string" && raw.name ? raw.name : (fallbackName || "imported-book");
  const LOGIC = ["AND_ANY", "NOT_ALL", "NOT_ANY", "AND_ALL"];
  const ROLE = ["system", "user", "assistant"];
  const entries = [];
  for (const e of Object.values(raw.entries)) {
    if (!e || typeof e !== "object") continue;
    const content = typeof e.content === "string" ? e.content : "";
    if (!content.trim()) continue;
    const stPos = typeof e.position === "number" ? e.position : 0;
    const pos = stPos === 0 ? "before_char" : stPos === 4 ? "at_depth" : "after_char";
    // the comment doubles as the entry title/memo — without it every imported
    // entry renders with a blank name
    const comment = typeof e.comment === "string" ? e.comment.trim() : "";
    const num = (v) => (typeof v === "number" ? v : undefined);
    entries.push({
      uid: typeof e.uid === "number" ? e.uid : undefined,
      title: comment || "Entry " + (entries.length + 1),
      memo: comment,
      keys: keyList(e.key), secondaryKeys: keyList(e.keysecondary),
      ...(typeof e.selectiveLogic === "number" && LOGIC[e.selectiveLogic] ? { selectiveLogic: LOGIC[e.selectiveLogic] } : {}),
      content, enabled: e.disable !== true,
      status: e.vectorized === true ? "vectorized" : e.constant === true ? "constant" : "normal",
      constant: e.constant === true,
      order: typeof e.order === "number" ? e.order : 100,
      position: pos,
      ...(pos === "at_depth" ? { depth: num(e.depth) ?? 4, role: ROLE[e.role] || "system" } : {}),
      // probability applies only when useProbability is on
      ...(e.useProbability !== false && typeof e.probability === "number" && e.probability < 100 ? { probability: e.probability } : {}),
      ...(e.group ? { group: String(e.group) } : {}),
      ...(num(e.groupWeight) != null ? { groupWeight: e.groupWeight } : {}),
      ...(e.groupOverride === true ? { groupOverride: true } : {}),
      ...(e.matchWholeWords === false ? { matchWholeWords: false } : {}),
      ...(e.excludeRecursion === true ? { nonRecursable: true } : {}),
      ...(e.ignoreBudget === true ? { ignoreBudget: true } : {}),
      ...(e.preventRecursion === true ? { preventFurtherRecursion: true } : {}),
      ...(e.delayUntilRecursion ? { delayUntilRecursion: num(e.delayUntilRecursion) ?? true } : {}),
      ...(num(e.sticky) != null ? { sticky: e.sticky } : {}),
      ...(num(e.cooldown) != null ? { cooldown: e.cooldown } : {}),
      ...(num(e.delay) != null ? { delay: e.delay } : {}),
      ...(e.automationId ? { automationId: String(e.automationId) } : {}),
      ...(e.matchCharacterDescription || e.matchCharacterPersonality || e.matchScenario || e.matchPersonaDescription ? {
        matchSources: {
          description: e.matchCharacterDescription === true,
          personality: e.matchCharacterPersonality === true,
          scenario: e.matchScenario === true,
          persona: e.matchPersonaDescription === true,
        },
      } : {}),
    });
  }
  return entries.length ? { name, entries } : null;
}

// The full standard sampler sweep a chat-completion preset can carry. Numeric
// keys copy as-is; the engine forwards them to the provider body (strict
// endpoints ignore or reject unknown ones, textgen endpoints honor them).
// Keep in sync with the engine plugin's forwarded-key list.
const SAMPLER_NUM_KEYS = [
  "top_p", "top_k", "min_p", "top_a", "typical_p", "eta_cutoff", "epsilon_cutoff",
  "repetition_penalty", "rep_pen", "repetition_penalty_range", "encoder_rep_pen",
  "no_repeat_ngram_size", "presence_penalty", "frequency_penalty", "penalty_alpha",
  "guidance_scale", "negative_prompt_scale", "smoothing_factor", "smoothing_curve",
  "dry_multiplier", "dry_base", "dry_allowed_length", "dry_last_n",
  "xtc_probability", "xtc_threshold",
  "dynatemp_min", "dynatemp_max", "dynatemp_exponent",
  "mirostat_mode", "mirostat_tau", "mirostat_eta",
  "seed", "temperature_last",
];
const SAMPLER_STR_KEYS = ["negative_prompt"];
const SAMPLER_BOOL_KEYS = ["temperature_last", "skip_special_tokens", "ban_eos_token", "add_bos_token"];

/** An instruct template's sequences as the text completion format. "wrap"
 *  puts a newline between a sequence and the message, and ends a message
 *  that has no suffix with one. The story string wrapper, when present, is
 *  what surrounds the system block at the top. */
function instructFormat(t) {
  if (!t || typeof t.input_sequence !== "string" || typeof t.output_sequence !== "string") return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const nl = t.wrap === true ? "\n" : "";
  const prefix = (seq) => (seq ? seq + nl : "");
  const suffix = (seq) => str(seq) || nl;
  return {
    systemPrefix: prefix(str(t.story_string_prefix) || (t.system_same_as_user ? str(t.input_sequence) : str(t.system_sequence))),
    systemSuffix: suffix(str(t.story_string_suffix) || (t.system_same_as_user ? str(t.input_suffix) : str(t.system_suffix))),
    userPrefix: prefix(t.input_sequence),
    userSuffix: suffix(t.input_suffix),
    assistantPrefix: prefix(t.output_sequence),
    assistantSuffix: suffix(t.output_suffix),
    systemAsUser: t.system_same_as_user === true,
  };
}

/** A preset this app wrote comes back whole: its editor sections carry the
 *  generation types, groups and conditions the portable format has no room
 *  for. Which preset is the default, and which are stock, stays the target's
 *  call. Anything else is another tool's file and goes through the converter. */
function restorePreset(raw, fallbackName) {
  if (!raw || typeof raw !== "object" || !raw.studio || typeof raw.studio !== "object" || !Array.isArray(raw.studio.sections)) {
    return normalizePreset(raw, fallbackName);
  }
  const { id: _id, ...rest } = raw;
  const { isDefault: _isDefault, readOnly: _readOnly, ...studio } = raw.studio;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : fallbackName || "imported";
  return { ...rest, name, studio };
}

function normalizePreset(raw, fallbackName) {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof raw.name === "string" && raw.name.trim() ? raw.name
    : typeof raw.presetName === "string" && raw.presetName.trim() ? raw.presetName
    : typeof fallbackName === "string" && fallbackName.trim() ? fallbackName
    : "imported";
  const num = (k) => (typeof raw[k] === "number" ? raw[k] : undefined);
  const preset = {
    name: label,
    temperature: num("temperature") ?? num("temp") ?? undefined,
    // token/context ceilings come under several names depending on the source UI
    openai_max_tokens: num("openai_max_tokens") ?? num("max_tokens") ?? num("max_length") ?? num("n_predict") ?? undefined,
    openai_max_context: num("openai_max_context") ?? num("max_context") ?? num("truncation_length") ?? undefined,
  };
  for (const k of SAMPLER_NUM_KEYS) if (num(k) != null) preset[k] = raw[k];
  for (const k of SAMPLER_STR_KEYS) if (typeof raw[k] === "string" && raw[k].trim()) preset[k] = raw[k];
  for (const k of SAMPLER_BOOL_KEYS) if (raw[k] === true || raw[k] === false) preset[k] = raw[k];

  // behavior + utility prompts map onto the studio bag; blank strings are
  // "off" in our schema, so empty sources just don't set them
  const studio = {};
  // numeric enum: -1 never prepend, 0 default (groups), 1 completion name
  // field, 2 always prefix content
  const namesBehavior = { [-1]: "none", 0: "default", 1: "completion", 2: "content" }[raw.names_behavior];
  if (namesBehavior) studio.namesBehavior = namesBehavior;
  if (raw.squash_system_messages === true || raw.squash_system_messages === false) studio.squashSystemMessages = raw.squash_system_messages;
  if (raw.continue_prefill === true || raw.continue_prefill === false) studio.continuePrefill = raw.continue_prefill;
  const instruct = instructFormat(raw.instruct && typeof raw.instruct === "object" ? raw.instruct : raw);
  if (instruct) studio.promptFormat = { use: "custom", custom: instruct };
  if (typeof raw.custom_prompt_post_processing === "string" && raw.custom_prompt_post_processing) {
    const POST = { claude: "merge", merge: "merge", merge_tools: "merge", semi: "semi", semi_tools: "semi", strict: "strict", strict_tools: "strict", single: "single" };
    const mode = POST[raw.custom_prompt_post_processing];
    if (mode) studio.promptPostProcessing = { enabled: true, mode };
  }
  const samplers = {};
  if (typeof raw.assistant_prefill === "string" && raw.assistant_prefill.trim()) samplers.assistantPrefill = raw.assistant_prefill;
  // NEVER trim a stop string: leading whitespace is the point of the most
  // common one ("\nUser:" halts the model as it starts the user's turn).
  const stops = [
    ...(Array.isArray(raw.stop) ? raw.stop.filter((x) => typeof x === "string" && x) : []),
    ...(typeof raw.custom_stop_strings === "string" && raw.custom_stop_strings.trim() ? raw.custom_stop_strings.split("\n") : []),
  ].filter((x) => x.trim());
  if (stops.length) samplers.stopStrings = [...new Set(stops)];
  if (typeof raw.reasoning_effort === "string" && ["low", "medium", "high"].includes(raw.reasoning_effort)) preset.reasoning = raw.reasoning_effort;
  const utilityPrompts = {};
  const utilMap = [
    ["impersonation_prompt", "impersonation"],
    ["continue_nudge_prompt", "continueNudge"],
    ["new_chat_prompt", "newChat"],
    ["group_nudge_prompt", "groupNudge"],
    ["send_if_empty", "emptySend"],
  ];
  for (const [src, dst] of utilMap) {
    if (typeof raw[src] === "string" && raw[src].trim()) utilityPrompts[dst] = raw[src];
  }
  if (Object.keys(samplers).length) studio.samplers = samplers;
  if (Object.keys(studio).length) preset.studio = studio;
  if (Object.keys(utilityPrompts).length) preset.utilityPrompts = utilityPrompts;
  if (Array.isArray(raw.prompts) && raw.prompts.length) {
    // in-chat injection: numeric 0/1 in outside files, "absolute" in our own
    // exports — both spell the same thing here
    const absolute = (p) => p.injection_position === 1 || p.injection_position === "absolute";
    preset.prompts = raw.prompts
      .filter((p) => p && (p.identifier || p.name))
      .map((p) => ({
        identifier: p.identifier || slug(p.name || "prompt"),
        name: p.name || p.identifier,
        role: p.role === "user" || p.role === "assistant" ? p.role : "system",
        marker: p.marker === true,
        // markers carry editable text too (main/jailbreak and hand-built
        // marker entries) — keep whatever content is there
        ...(typeof p.content === "string" && p.content.trim() ? { content: p.content } : {}),
        ...(absolute(p) && typeof p.injection_depth === "number" ? { injection_position: "absolute", injection_depth: p.injection_depth } : {}),
        ...(Array.isArray(p.injection_trigger) && p.injection_trigger.length ? { injection_trigger: p.injection_trigger } : {}),
      }));
    preset.prompt_order = Array.isArray(raw.prompt_order)
      ? raw.prompt_order
      : preset.prompts.map((p) => ({ identifier: p.identifier, enabled: true }));
    // prompt_order arrives as [{character_id, order:[{identifier, enabled}]}]
    if (Array.isArray(raw.prompt_order) && raw.prompt_order.length && raw.prompt_order[0] && Array.isArray(raw.prompt_order[0].order)) {
      preset.prompt_order = raw.prompt_order;
    }
    if (Array.isArray(preset.prompt_order) && preset.prompt_order.length && !Array.isArray(preset.prompt_order[0].order)) {
      preset.prompt_order = [{ character_id: 100000, order: preset.prompt_order }];
    }
  } else {
    // text-completion story_string → single-block layout
    const content = typeof raw.story_string === "string" && raw.story_string.trim() ? raw.story_string : undefined;
    preset.prompts = [
      ...(content ? [{ identifier: "story", name: "Story", role: "system", content }] : []),
      { identifier: "worldInfoBefore", name: "World Info (before)", role: "system", marker: true },
      { identifier: "charDescription", name: "Char Description", role: "system", marker: true },
      { identifier: "charPersonality", name: "Char Personality", role: "system", marker: true },
      { identifier: "scenario", name: "Scenario", role: "system", marker: true },
      { identifier: "personaDescription", name: "Persona", role: "system", marker: true },
      { identifier: "worldInfoAfter", name: "World Info (after)", role: "system", marker: true },
      { identifier: "dialogueExamples", name: "Chat Examples", role: "system", marker: true },
      { identifier: "chatHistory", name: "Chat History", role: "system", marker: true },
    ];
    preset.prompt_order = [{ character_id: 100000, order: preset.prompts.map((p) => ({ identifier: p.identifier, enabled: true })) }];
  }
  return preset;
}

// numeric placement of the portable regex format: 1 user input, 2 AI
// output, 3 slash command, 5 world info, 6 reasoning (0, the retired
// display-only slot, has no meaning any more)
const PLACEMENT = { 1: "user_input", 2: "ai_output", 3: "slash", 5: "wi", 6: "reasoning" };
function normalizeRegex(raw) {
  if (!raw || typeof raw.findRegex !== "string") return null;
  let find = raw.findRegex;
  let flags;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(find);
  if (m) { find = m[1]; flags = m[2] || undefined; }
  const placement = Array.isArray(raw.placement)
    ? Array.from(new Set(raw.placement.map((n) => PLACEMENT[n]).filter(Boolean)))
    : ["ai_output"];
  return {
    scriptName: typeof raw.scriptName === "string" ? raw.scriptName : "imported",
    findRegex: find, replaceString: typeof raw.replaceString === "string" ? raw.replaceString : "",
    placement,
    // WHEN it applies: neither flag = the saved text is rewritten
    markdownOnly: raw.markdownOnly === true,
    promptOnly: raw.promptOnly === true,
    runOnEdit: raw.runOnEdit === true,
    trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.map(String) : [],
    ...(flags ? { flags } : {}),
    minDepth: typeof raw.minDepth === "number" && raw.minDepth >= -1 ? raw.minDepth : null,
    maxDepth: typeof raw.maxDepth === "number" && raw.maxDepth >= 0 ? raw.maxDepth : null,
    disabled: raw.disabled === true,
    ...(raw.substituteRegex === 1 ? { macroMode: "raw" } : raw.substituteRegex === 2 ? { macroMode: "escaped" } : {}),
  };
}

function normalizeChatLines(raw) {
  // raw: {character?: string, file?: string, lines: [public chat-line objects]}
  if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return null;
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const msgs = [];
  for (const l of raw.lines) {
    if (!l || typeof l.mes !== "string") continue;
    const isUser = l.is_user === true;
    // our own backups tuck the fields the public line shape has no room for
    // into extra.chry — a hidden turn, a bookmark, a generated picture, a
    // translation, and the model/usage/reasoning stamp on the reply
    const x = l.extra && typeof l.extra === "object" && l.extra.chry && typeof l.extra.chry === "object" ? l.extra.chry : {};
    msgs.push({
      id: uid("e"), name: typeof l.name === "string" ? l.name : (isUser ? "User" : "Character"),
      charId: (l.extra && typeof l.extra.chry_char_id === "string" && l.extra.chry_char_id) || null,
      role: isUser ? "user" : l.is_system === true ? "system" : "char",
      text: l.mes, at: l.send_date && !isNaN(Date.parse(l.send_date)) ? Date.parse(l.send_date) : Date.now(),
      swipes: Array.isArray(l.swipes) && l.swipes.length ? l.swipes.map(String) : [l.mes],
      swipe: typeof l.swipe_id === "number" && l.swipe_id >= 0 ? l.swipe_id : 0,
      ...(x.hidden === true ? { hidden: true } : {}),
      ...(x.bookmark ? { bookmark: x.bookmark } : {}),
      ...(x.picture ? { picture: x.picture } : {}),
      ...(typeof x.translation === "string" && x.translation ? { translation: x.translation } : {}),
      ...(x.extra && typeof x.extra === "object" ? { extra: x.extra } : {}),
    });
  }
  if (!msgs.length) return null;
  const title = (raw.character ? raw.character + " — " : "") + unslugTitle(raw.file || "imported chat");
  return { title, msgs };
}

// chub's CDN/API rejects default http-client user-agents with a fake
// "not available in your country" page — present as a browser
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const DATACAT_BASE = "https://datacat.run";
const DATACAT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function datacatRoute(req, host) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
  if (req.path === "/marketplace/detail" && !DATACAT_ID.test(String(b.id || ""))) {
    return { status: 400, json: { error: "bad listing id" } };
  }
  const headers = { "user-agent": BROWSER_UA, accept: "application/json", origin: DATACAT_BASE, referer: DATACAT_BASE + "/" };
  const results = host.net.results;
  // Anonymous sessions are request-scoped and never sent to the app frame.
  if (!Object.keys(results).length) {
    host.net.request("identify", {
      url: DATACAT_BASE + "/api/liberator/identify", method: "POST",
      body: { deviceToken: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const n = Math.floor(Math.random() * 16); return (c === "x" ? n : (n & 3) | 8).toString(16); }) }, headers, json: true, maxBytes: 128 * 1024,
    });
    return { __llmPending: true };
  }
  if (results.identify && !results.datacat) {
    const token = results.identify.ok && results.identify.json?.sessionToken;
    if (typeof token !== "string" || !token) return { status: 502, json: { error: "Datacat session unavailable" } };
    headers["X-Session-Token"] = token;
    const page = Math.max(1, Math.min(1000, Math.floor(Number(b.page) || 1)));
    const first = Math.max(1, Math.min(50, Math.floor(Number(b.first) || 24)));
    let path;
    if (req.path === "/marketplace/tags") path = "/api/tags/faceted?mode=recent&minTotalTokens=0";
    else if (req.path === "/marketplace/detail") path = "/api/characters/" + encodeURIComponent(b.id);
    else {
      const qs = new URLSearchParams({ limit: String(first), offset: String((page - 1) * first), summary: "1", minTotalTokens: String(Math.max(0, Math.min(1000000, Math.floor(Number(b.minTokens) || 0)))) });
      const search = String(b.search || "").trim().slice(0, 120);
      if (search) qs.set("search", search);
      if (b.sort === "score") qs.set("sortBy", "score");
      const ids = (Array.isArray(b.tagIds) ? b.tagIds : []).filter((id) => Number.isInteger(id) && id > 0).slice(0, 12);
      // The catalog's rating tags filter before pagination, preserving totals.
      if (b.nsfw === false && !ids.includes(1)) ids.push(1);
      else if (b.nsfwOnly === true && !ids.includes(2)) ids.push(2);
      if (ids.length) qs.set("tagIds", ids.join(","));
      path = "/api/characters/recent-public?" + qs.toString();
    }
    host.net.request("datacat", { url: DATACAT_BASE + path, headers, json: true, maxBytes: (req.path === "/marketplace/tags" ? 12 : 5) * 1024 * 1024 });
    return { __llmPending: true, stash: { page, first } };
  }
  const r = results.datacat;
  const data = r?.ok && r.json?.success === true ? r.json : null;
  if (!data) return { status: 502, json: { error: "Datacat request failed (" + (r?.status || r?.error || "invalid response") + ")" } };
  if (req.path === "/marketplace/tags") {
    if (!Array.isArray(data.tags)) return { status: 502, json: { error: "Invalid Datacat tags" } };
    return { status: 200, json: { tags: data.tags.filter((t) => Number.isInteger(t.id) && typeof t.name === "string").sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 2000).map((t) => ({ id: t.id, tag: t.name, n: Number(t.count) || 0 })) } };
  }
  const clip = (v, limit) => typeof v === "string" ? v.slice(0, limit) : "";
  if (req.path === "/marketplace/detail") {
    const c = data.character;
    if (!c || typeof c !== "object") return { status: 502, json: { error: "Invalid Datacat character" } };
    const d = c.chara_card_v2_json?.data || {};
    const book = d.character_book;
    return { status: 200, json: {
      source: "datacat", id: b.id,
      greeting: clip(d.first_mes || c.first_message, 16000),
      alternateGreetings: (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : Array.isArray(c.alternate_greetings) ? c.alternate_greetings : []).filter((g) => typeof g === "string").slice(0, 40).map((g) => g.slice(0, 16000)),
      personality: clip(d.description || c.personality, 24000), scenario: clip(d.scenario || c.scenario, 8000),
      exampleDialogs: clip(d.mes_example, 16000), creatorNotes: clip(d.creator_notes || c.description, 8000),
      systemPrompt: clip(d.system_prompt, 8000), postHistoryInstructions: clip(d.post_history_instructions, 8000),
      lorebookEntries: book ? (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries || {}).length) : 0,
    } };
  }
  if (!Array.isArray(data.characters) || !Number.isFinite(data.totalCount)) return { status: 502, json: { error: "Invalid Datacat search results" } };
  const safeAvatar = (v) => typeof v === "string" && /^https:\/\//i.test(v) ? v : null;
  const metric = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const listings = data.characters.filter((c) => DATACAT_ID.test(String(c.characterId || c.character_id || ""))).map((c) => ({
    id: c.characterId || c.character_id, name: clip(c.name, 500), creator: clip(c.creatorName || c.creator_name, 200),
    tagline: "", description: clip(c.description, 12000),
    topics: (Array.isArray(c.tags) ? c.tags : Array.isArray(c.custom_tags) ? c.custom_tags : []).map((t) => typeof t === "string" ? t : t.name).filter((t) => typeof t === "string"),
    downloads: null, favorites: metric(c.stats?.favoritesCount?.favoritesCount),
    tokens: metric(c.token_counts?.total_tokens), rating: null, ratingCount: null,
    chats: metric(c.stats?.chat), messages: metric(c.stats?.message),
    nsfw: c.isNsfw === true || c.is_nsfw === true,
    avatar: safeAvatar(c.avatar) || (typeof c.avatar === "string" && /^[\w.-]+$/.test(c.avatar) ? "https://ella.janitorai.com/bot-avatars/" + c.avatar : null),
    maxRes: safeAvatar(c.avatarVariantUrls?.hero || c.avatar_variant_urls?.hero), createdAt: c.createdAt || c.created_at || null,
  }));
  return { status: 200, json: { source: "datacat", count: data.totalCount, page: req.stash.page, first: req.stash.first, results: listings } };
}

function storeMedia(value, fsx) {
  if (!fsx.media) return value;
  if (typeof value === "string") return /^data:image\/(png|jpeg|webp|gif);base64,/.test(value) ? fsx.media(value) : value;
  if (Array.isArray(value)) return value.map((item) => storeMedia(item, fsx));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = storeMedia(item, fsx);
  if (out.studio && out.studio.avatar === out.avatar) delete out.studio.avatar;
  return out;
}

export function handleRoute(req, host) {
  if (req.method !== "POST") return null;
  if (req.path.startsWith("/marketplace/") && req.body?.source === "datacat" && ["/marketplace/search", "/marketplace/detail", "/marketplace/tags"].includes(req.path)) return datacatRoute(req, host);
  if (req.path !== "/import/batch" && req.path !== "/import/zip" && req.path !== "/import/url" && req.path !== "/import/finish" && req.path !== "/marketplace/search" && req.path !== "/marketplace/detail") return null;
  // ---------- Marketplace search (chub.ai today; source id keeps the
  // client shape ready for more storefronts) ----------
  // gateway.chub.ai/search is the catalog the chub frontend itself queries —
  // no auth for public listings, but it insists on a browser user-agent.
  // Two-phase host.net fetch like /import/url; no fs writes here.
  if (req.path === "/marketplace/search") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const source = String(b.source || "chub");
    if (source !== "chub") return { status: 400, json: { error: "unknown marketplace source: " + source } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    // Orderings the catalog actually accepts — an unknown key is a 400, not a
    // fallback, so every option here is verified. Download order is also the
    // catalog's own default, and a search term filters BEFORE the ordering
    // applies, so there is no separate "relevance" mode to offer.
    const SORTS = { downloads: "download_count", rating: "rating", newest: "created_at", updated: "last_activity_at", tokens: "n_tokens", name: "name", random: "random" };
    // "trending" is NOT an ordering: it swaps the whole searchable pool for a
    // ~1.4k-card hot list. Sent as a sort key it silently shrinks every other
    // filter (a tag inside it returns a handful of cards, or none), so it is
    // its own switch and it replaces the ordering while on.
    const sort = b.trending === true ? "trending" : (SORTS[String(b.sort)] ?? "download_count");
    const search = String(b.search || "").slice(0, 120).trim();
    // creator filter ("by <username>" — chub's own author browse param)
    const username = /^[A-Za-z0-9_.-]{1,80}$/.test(String(b.creator || "")) ? String(b.creator) : "";
    const topicList = (v) => (Array.isArray(v) ? v : [])
      .filter((t) => typeof t === "string" && t.trim() && t.length <= 60)
      .slice(0, 12)
      .map((t) => t.replace(/[,&\s]+/g, " ").trim())
      .filter(Boolean);
    const tags = topicList(b.tags);
    const excludeTags = topicList(b.excludeTags);
    const page = Math.max(1, Math.min(1000, Math.floor(Number(b.page) || 1)));
    const first = Math.max(1, Math.min(50, Math.floor(Number(b.first) || 24)));
    const qs = new URLSearchParams({ namespace: "characters", first: String(first), page: String(page) });
    if (sort) qs.set("sort", sort);
    if (search) qs.set("search", search);
    if (username) qs.set("username", username);
    // Maturity: the catalog hides adult listings unless asked, so an absent
    // flag is NOT "no opinion" — it silently cuts the pool by ~95%. Always
    // state all three.
    qs.set("nsfw", b.nsfw === false ? "false" : "true");
    qs.set("nsfl", b.nsfl === true ? "true" : "false");
    qs.set("nsfw_only", b.nsfwOnly === true ? "true" : "false");
    qs.set("include_forks", b.includeForks === false ? "false" : "true");
    // topics=a,b is AND; inclusive_or flips the whole set to OR. (tags_mode
    // is not a parameter the catalog reads — it silently stayed AND.)
    if (tags.length) {
      qs.set("topics", tags.join(","));
      if (String(b.tagsMode) === "any") qs.set("inclusive_or", "true");
    }
    if (excludeTags.length) qs.set("excludetopics", excludeTags.join(","));
    // numeric narrowing — only sent when the client actually set one
    const num = (v, lo, hi) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };
    const minTokens = num(b.minTokens, 1, 1000000);
    const maxTokens = num(b.maxTokens, 1, 1000000);
    const maxDaysAgo = num(b.maxDaysAgo, 1, 36500);
    const minAiRating = num(b.minAiRating, 1, 5);
    const minTags = num(b.minTags, 1, 50);
    if (minTokens !== null) qs.set("min_tokens", String(minTokens));
    if (maxTokens !== null) qs.set("max_tokens", String(maxTokens));
    if (maxDaysAgo !== null) qs.set("max_days_ago", String(maxDaysAgo));
    if (minAiRating !== null) qs.set("min_ai_rating", String(minAiRating));
    if (minTags !== null) qs.set("min_tags", String(minTags));
    // "must have" flags: only the enabled ones are sent (false narrows nothing)
    const REQUIRES = {
      requireExamples: "require_example_dialogues",
      requireLore: "require_lore",
      requireLoreEmbedded: "require_lore_embedded",
      requireLoreLinked: "require_lore_linked",
      requireGreetings: "require_alternate_greetings",
      requireCustomPrompt: "require_custom_prompt",
      requireImages: "require_images",
      requireExpressions: "require_expressions",
    };
    for (const key of Object.keys(REQUIRES)) if (b[key] === true) qs.set(REQUIRES[key], "true");
    if (!Object.keys(host.net.results).length) {
      host.net.request("search", {
        url: "https://gateway.chub.ai/search?" + qs.toString(),
        json: true, maxBytes: 4 * 1024 * 1024,
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      return { __llmPending: true };
    }
    const r = host.net.results.search;
    const data = r && r.ok && r.json && typeof r.json.data === "object" ? r.json.data : null;
    if (!data) {
      return { status: 502, json: { error: "chub search failed (" + ((r && (r.status || r.error)) || "no response") + ")" } };
    }
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const results = nodes.map((n) => {
      const fullPath = String(n.fullPath || "");
      const topics = Array.isArray(n.topics) ? n.topics.map(String).slice(0, 30) : [];
      return {
        // "user/slug" — the stable id used for the download URL and dedupe
        id: fullPath,
        name: String(n.name || fullPath.split("/")[1] || "Untitled"),
        creator: fullPath.split("/")[0] || "",
        tagline: typeof n.tagline === "string" ? n.tagline.slice(0, 500) : "",
        description: typeof n.description === "string" ? n.description.slice(0, 12000) : "",
        topics,
        // chub naming quirk: starCount IS the download count; n_favorites is
        // the real "likes". nTokens is their token estimate for the card.
        downloads: Number(n.starCount) || 0,
        favorites: Number(n.n_favorites) || 0,
        tokens: Number(n.nTokens) || 0,
        rating: Number(n.rating) || 0,
        ratingCount: Number(n.ratingCount) || 0,
        chats: Number(n.nChats) || 0,
        messages: Number(n.nMessages) || 0,
        // the adult flag on the listing only covers the ARTWORK — an adult
        // card with a tame avatar carries it in its topics instead
        nsfw: n.nsfw_image === true || topics.some((t) => t.toLowerCase() === "nsfw"),
        avatar: typeof n.avatar_url === "string" ? n.avatar_url : null,
        // full-resolution card image; the client downscales it into the
        // imported character's avatar (the listing avatar is a 200px thumb)
        maxRes: typeof n.max_res_url === "string" ? n.max_res_url : null,
        createdAt: typeof n.createdAt === "string" ? n.createdAt : null,
      };
    }).filter((x) => x.id && x.name);
    return {
      status: 200,
      json: { source, count: Number(data.count) || results.length, page: Number(data.page) || page, first, results },
    };
  }

  // ---------- Marketplace detail (full card definition, chub) ----------
  // The listing gives name/tagline/stats; this fetches the actual card fields
  // (greeting, personality, scenario, examples, alternate greetings) so the
  // preview dialog shows exactly what a download brings in.
  if (req.path === "/marketplace/detail") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const source = String(b.source || "chub");
    if (source !== "chub") return { status: 400, json: { error: "unknown marketplace source: " + source } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    const id = String(b.id || "");
    const parts = /^([A-Za-z0-9_.-]{1,80})\/([A-Za-z0-9_.-]{1,120})$/.exec(id);
    if (!parts) return { status: 400, json: { error: "bad listing id" } };
    if (!Object.keys(host.net.results).length) {
      host.net.request("detail", {
        url: "https://api.chub.ai/api/characters/" + encodeURIComponent(parts[1]) + "/" + encodeURIComponent(parts[2]) + "?full=true",
        json: true, maxBytes: 5 * 1024 * 1024,
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      return { __llmPending: true };
    }
    const r = host.net.results.detail;
    const node = r && r.ok && r.json && r.json.node ? r.json.node : null;
    if (!node) {
      return { status: 502, json: { error: "chub detail failed (" + ((r && (r.status || r.error)) || "no response") + ")" } };
    }
    const d = node.definition && typeof node.definition === "object" ? node.definition : {};
    const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    const book = d.embedded_lorebook && typeof d.embedded_lorebook === "object" ? d.embedded_lorebook : null;
    const bookEntries = book ? (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries || {}).length) : 0;
    return {
      status: 200,
      json: {
        source, id,
        greeting: clip(d.first_message, 16000),
        alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map((g) => String(g).slice(0, 16000)).slice(0, 40) : [],
        personality: clip(d.personality, 24000),
        scenario: clip(d.scenario, 8000),
        exampleDialogs: clip(d.example_dialogs, 16000),
        creatorNotes: clip(d.description, 8000),
        systemPrompt: clip(d.system_prompt, 8000),
        postHistoryInstructions: clip(d.post_history_instructions, 8000),
        lorebookEntries: bookEntries,
      },
    };
  }

  const fsx = host.fs;
  const writeJson = (rel, v) => fsx.write(rel, JSON.stringify(storeMedia(v, fsx), null, 2) + "\n");
  const readJson = (rel, fb) => { try { return JSON.parse(fsx.read(rel)); } catch { return fb; } };
  const summary = { characters: [], groups: [], lorebooks: [], presets: [], regex: [], personas: [], themes: [], chats: [], databank: [], errors: [] };
  let characterNames = null;
  const used = new Set();
  // Id collision guard: dedupes within THIS import batch AND against what
  // already exists on disk — re-importing the same card must never silently
  // overwrite the earlier one (its gallery/edits would be lost).
  const taken = (rel) => { try { fsx.read(rel); return true; } catch { return false; } };
  const uid = (base, dir) => {
    let id = base, n = 2;
    const hit = (x) => used.has(x) || (dir && (taken(dir + "/" + x + "/card.json") || taken(dir + "/" + x + ".json") || taken(dir + "/" + x + ".meta.json")));
    while (hit(id)) id = base + "-" + n++;
    used.add(id);
    return id;
  };

  // ---------- URL import (chub / CharacterHub card links) ----------
  // Page link → character detail JSON + the embedded-card PNG from the CDN
  // (both two-phase host.net fetches, no credentials, manifest allowlist
  // enforced host-side). The PNG card wins (full fidelity incl. v3); the
  // detail JSON is the fallback and fills any missing fields.
  if (req.path === "/import/url") {

    const url = String((req.body && req.body.url) || "");
    if (!url.startsWith("https://")) return { status: 400, json: { error: "https URL required" } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    const UA = BROWSER_UA;
    const page = /^https:\/\/(?:www\.)?(?:chub\.ai|characterhub\.(?:ai|org))\/characters\/([^/\s?#]+)\/([^/\s?#]+)/.exec(url)
      || /^https:\/\/api\.chub\.ai\/api\/characters\/([^/\s?#]+)\/([^/\s?#]+)/.exec(url);
    if (!page) {
      if (/^https:\/\/[^/]*chub\.ai|^https:\/\/[^/]*characterhub\.(?:ai|org)/.test(url)) {
        return { status: 400, json: { error: "not a character link — use https://chub.ai/characters/<user>/<name>" } };
      }
      return { status: 400, json: { error: "not a chub / CharacterHub character link" } };
    }
    const [, user, nameSlug] = page;
    // optional client-downscaled avatar (data URI). Wins over the 200px
    // chub thumbnail the importer would otherwise keep.
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const avatarOverride = typeof b.avatar === "string" && b.avatar.startsWith("data:image/") && b.avatar.length < 900 * 1024 ? b.avatar : null;
    const requests = {
      png: { url: "https://avatars.charhub.io/avatars/" + encodeURIComponent(user) + "/" + encodeURIComponent(nameSlug) + "/chara_card_v2.png", binary: true, maxBytes: 16 * 1024 * 1024 },
      detail: { url: "https://api.chub.ai/api/characters/" + encodeURIComponent(user) + "/" + encodeURIComponent(nameSlug) + "?full=true", json: true, maxBytes: 5 * 1024 * 1024 },
      webp: { url: "https://avatars.charhub.io/avatars/" + encodeURIComponent(user) + "/" + encodeURIComponent(nameSlug) + "/avatar.webp", binary: true, maxBytes: 8 * 1024 * 1024 },
    };
    if (!Object.keys(host.net.results).length) {
      for (const k of Object.keys(requests)) {
        const spec = requests[k];
        host.net.request(k, { ...spec, headers: { "user-agent": UA, accept: spec.binary ? "image/*" : "application/json" } });
      }
      return { __llmPending: true };
    }
    // pass B: PNG card first, detail JSON second, webp only as avatar filler
    const png = host.net.results.png;
    const detail = host.net.results.detail;
    const webp = host.net.results.webp;
    // avatars come from the small webp variant — the card PNG is multi-MB and
    // only exists to carry the embedded card JSON
    const avatarOf = (r, mime) => (r && r.ok && r.base64 && r.base64.length < 700000 ? "data:" + mime + ";base64," + r.base64 : null);
    let card = null;
    let avatar = avatarOverride;
    if (png && png.ok && png.base64) {
      card = cardFromPngBase64(png.base64);
      // the PNG only exists to carry the embedded card JSON — the avatar comes
    // from the small webp variant whenever it arrived
      avatar = avatar || avatarOf(webp, "image/webp");
    }
    if (!card && detail && detail.ok && detail.json && detail.json.node) {
      const n = detail.json.node;
      const d = n.definition || {};
      card = {
        spec: "chara_card_v2", spec_version: "2.0",
        name: d.name || n.name || nameSlug,
        description: d.personality || "",
        personality: d.tavern_personality || "",
        scenario: d.scenario || "",
        first_mes: d.first_message || "",
        mes_example: d.example_dialogs || "",
        creator_notes: d.description || "",
        system_prompt: d.system_prompt || "",
        post_history_instructions: d.post_history_instructions || "",
        alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(String) : [],
        tags: Array.isArray(n.topics) ? n.topics.map(String) : [],
        creator: user,
        ...(d.embedded_lorebook && typeof d.embedded_lorebook === "object" ? { character_book: d.embedded_lorebook } : {}),
        ...(d.extensions && typeof d.extensions === "object" ? { extensions: d.extensions } : {}),
      };
      avatar = avatar || avatarOf(webp, "image/webp") || (typeof n.avatar_url === "string" ? n.avatar_url : null);
    }
    if (!card) {
      const why = [];
      if (png && !png.ok) why.push("card image " + (png.status || png.error || "failed"));
      if (detail && !detail.ok) why.push("detail " + (detail.status || detail.error || "failed"));
      return { status: 502, json: { error: "no character card found at that URL" + (why.length ? " (" + why.join("; ") + ")" : "") } };
    }
    const n = normalizeCard(card, avatar || undefined);
        if (!n) return { status: 502, json: { error: "the card at that URL was not recognizable" } };
    writeCardWithBook(n, card, null, avatar || undefined);
    return { status: 200, json: { ...summary, name: n.name } };
  }

  // Hoisted so the /import/url handler above can call it before this line.
  function writeCard(card) {
    const id = uid(slug(card.name), "characters");
    const importedAt = Date.now();
    card.studio = { ...card.studio, createdAt: card.studio?.createdAt || importedAt, importedAt };
    writeJson("characters/" + id + "/card.json", card);
    summary.characters.push(id);
    if (req.body?.importId && fsx.lookup) { fsx.lookup(req.body.importId + "_characters", String(card.name).toLowerCase(), id); fsx.lookup(req.body.importId + "_characters", slug(card.name), id); }
    if (characterNames) characterNames.set(String(card.name).toLowerCase(), id);
    // regex scripts a card carries run for that character only
    const embedded = card.extensions && Array.isArray(card.extensions.regex_scripts) ? card.extensions.regex_scripts : [];
    embedded.forEach((raw, i) => {
      const n = normalizeRegex(raw);
      if (!n) return;
      const rid = uid(slug(n.scriptName), "regex");
      writeJson("regex/" + rid + ".json", { ...n, id: rid, scope: "character", scopeTargetId: id, order: i });
      summary.regex.push(rid);
    });
  }
  /** Cards may embed a lorebook — write it as a book file and link it via
   *  the card's studio bag so the app scopes it to that character. charx
   *  packages also carry assets: the icon/main avatar and emotion sprites
   *  resolve from the package bytes (assetDict) or inline data: URIs. */
  function writeCardWithBook(card, raw, assetDict, sourceAvatar) {
    if (!card) return;
    const src = raw && raw.data && typeof raw.data === "object" && raw.data.character_book ? raw.data : raw;
    const book = src && src.character_book && typeof src.character_book === "object" ? src.character_book : null;
    const world = book ? embeddedBookToWorld(book) : null;
    if (world) {
      const n = normalizeBook(world, (typeof book.name === "string" && book.name) || card.name + " lore");
      if (n) {
        n.isEmbedded = true;
        // card-spec book-level knobs — full settings shape so the client's
        // replace-on-read doesn't lose the other defaults
        const st = { scanDepth: 4, contextPercent: 25, budgetCap: 0, minActivations: 0, maxRecursion: 2, insertionStrategy: "character_first", caseSensitive: false, wholeWords: true, groupScoring: false, recursiveScan: true, includeNames: true, overflowAlert: true };
        if (typeof book.scan_depth === "number" && book.scan_depth >= 0) st.scanDepth = Math.floor(book.scan_depth);
        if (book.recursive_scanning === false) st.recursiveScan = false;
        n.settings = st;
        const id = uid(slug(n.name), "lorebooks");
        writeJson("lorebooks/" + id + ".json", { ...n, id });
        summary.lorebooks.push(id);
        card.studio = { ...card.studio, embeddedLorebookId: id };
      }
    }
    if (Array.isArray(card.assets)) {
      const resolved = resolveCardAssets(card, assetDict || {}, sourceAvatar || null);
      if (resolved.avatar) card.avatar = resolved.avatar;
      if (resolved.expressions.length) {
        card.studio = { ...card.studio, expressions: resolved.expressions };
      }
    }
    writeCard(card);
  }
  // Ids are re-minted on the way in, so anything that pointed at an id in the
  // backup has to be re-pointed by NAME. These record what each name became.
  const importId = /^[a-f0-9-]{36}$/.test(String(req.body?.importId || "")) ? req.body.importId : null;
  const lookup = (collection) => importId && fsx.lookup ? { get: (key) => fsx.lookup(importId + "_" + collection, key), set: (key, value) => fsx.lookup(importId + "_" + collection, key, value) } : new Map();
  const bookIdByName = lookup("books");
  const presetIdByName = lookup("presets");
  const personaIdByName = lookup("personas");
  const groupIdByName = lookup("groups");

  const charIdByName = () => {
    if (importId && fsx.lookup) return lookup("characters");
    if (characterNames) return characterNames;
    const m = new Map();
    characterNames = m;
    try {
      for (const cid of fsx.list("characters")) {
        const card = readJson("characters/" + cid + "/card.json", null);
        if (card && card.name) { m.set(String(card.name).toLowerCase(), cid); m.set(slug(card.name), cid); }
      }
    } catch {}
    return m;
  };
  const lower = (v) => String(v ?? "").toLowerCase();
  const writeBook = (n, fallback, studio) => {
    if (!n) return;
    const id = uid(slug(n.name || fallback || "book"), "lorebooks");
    // book-level knobs an export carries alongside the public entry list:
    // without them a restored book comes back switched off, with stock scan
    // settings and no link to the cards it belonged to
    const extra = studio && typeof studio === "object"
      ? {
          ...(studio.settings ? { settings: studio.settings } : {}),
          ...(studio.globalActive === true ? { globalActive: true } : {}),
          ...(studio.folderId ? { folderId: studio.folderId } : {}),
          ...(studio.vectorized === true ? { vectorized: true } : {}),
          ...(Array.isArray(studio._linkedNames) && studio._linkedNames.length
            ? { linkedCharacterIds: studio._linkedNames.map((nm) => charIdByName().get(lower(nm))).filter(Boolean) }
            : {}),
        }
      : {};
    writeJson("lorebooks/" + id + ".json", { ...n, ...extra, id });
    bookIdByName.set(lower(n.name || fallback), id);
    summary.lorebooks.push(id);
  };
  const writePreset = (n) => {
    if (!n) return;
    const id = uid(slug(n.name || "preset"), "presets");
    writeJson("presets/" + id + ".json", { ...n, id });
    presetIdByName.set(lower(n.name), id);
    summary.presets.push(id);
  };
  const writeRegex = (n) => {
    if (!n) return;
    const id = uid(slug(n.scriptName), "regex");
    writeJson("regex/" + id + ".json", { ...n, id });
    summary.regex.push(id);
  };
  /** A persona from a backup. `full` is the complete record when the zip
   *  carried one — the flat {name: description} map foreign tools write is
   *  all most backups have, and rebuilding from it alone is what dropped the
   *  avatar, title, pronouns, bound cards, linked books and default flag. */
  const writePersona = (name, description, full) => {
    if (!name) return;
    const id = uid(slug(name), "personas");
    const rest = {};
    if (full && typeof full === "object") {
      for (const [k, v] of Object.entries(full)) {
        if (k === "id" || k === "name" || k === "description" || k.startsWith("_")) continue;
        if (k === "lorebookIds" || k === "boundCharacterIds") continue;
        rest[k] = v;
      }
      if (Array.isArray(full._lorebookNames) && full._lorebookNames.length) {
        rest.lorebookIds = full._lorebookNames.map((nm) => bookIdByName.get(lower(nm))).filter(Boolean);
      }
      if (Array.isArray(full._boundNames) && full._boundNames.length) {
        const byName = charIdByName();
        rest.boundCharacterIds = full._boundNames.map((nm) => byName.get(lower(nm))).filter(Boolean);
      }
    }
    writeJson("personas/" + id + ".json", { ...rest, id, name, description: description || "" });
    personaIdByName.set(lower(name), id);
    summary.personas.push(id);
  };
  /** `saved` is the chat's own meta when the backup carried one: everything
   *  ABOUT the conversation (its preset, persona, model, author's note,
   *  summary, memory cutoff, folder, tags, card variant, branch parentage).
   *  Without it every restored chat landed on the default preset and no
   *  persona, which is exactly what a move to a second device looked like. */
  const writeChat = (n, characterId, groupId, saved) => {
    const id = uid(slug(n.title), "chats");
    // pinned to the persona in use at import, like a chat made in the app
    const personaId = readJson("settings.json", {}).personaId || null;
    const persona = personaId ? readJson("personas/" + personaId + ".json", null) : null;
    const meta = {
      id, title: n.title, characterId: characterId || null, groupId: groupId || null,
      presetId: "default", personaId: persona ? personaId : null, model: null, userName: (persona && persona.name) || "User",
      authorNote: null, lorebookIds: [], createdAt: Date.now(), updatedAt: Date.now(), tainted: true,
    };
    if (saved && typeof saved === "object") {
      // ids are re-minted on import; carry the rest of the meta straight over
      const SKIP = new Set(["id", "characterId", "groupId", "presetId", "personaId", "lorebookIds"]);
      for (const [k, v] of Object.entries(saved)) {
        if (SKIP.has(k) || k.startsWith("_")) continue;
        meta[k] = v;
      }
      if (typeof saved.title === "string" && saved.title.trim()) meta.title = saved.title;
      const wantPreset = presetIdByName.get(lower(saved._presetName));
      if (wantPreset) meta.presetId = wantPreset;
      const wantPersona = personaIdByName.get(lower(saved._personaName));
      if (wantPersona) {
        meta.personaId = wantPersona;
        const p = readJson("personas/" + wantPersona + ".json", null);
        if (p && p.name) meta.userName = p.name;
      }
      if (Array.isArray(saved._lorebookNames)) {
        meta.lorebookIds = saved._lorebookNames.map((nm) => bookIdByName.get(lower(nm))).filter(Boolean);
      }
      // branch parentage points at chat ids from the other machine; the
      // restored chats are new files, so a stale parent would render a
      // branch tree that leads nowhere
      delete meta.parentChatId;
      delete meta.parentMessageId;
      meta.id = id;
      meta.characterId = characterId || null;
      meta.groupId = groupId || null;
    }
    fsx.write("chats/" + id + ".jsonl", n.msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    writeJson("chats/" + id + ".meta.json", meta);
    if (Array.isArray(n.memories) && n.memories.length) {
      writeJson("chats/" + id + ".memories.json", n.memories);
    }
    summary.chats.push(id);
    return id;
  };

  // ---------- browser-driven batch (can include PNG-extracted cards) ----------
  if (req.path === "/import/batch") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    for (const c of b.cards || []) {
      try {
        let raw = null;
        let avatar = null;
        if (typeof c === "string") {
          raw = extractCardFromPng(b64ToBytes(c.replace(/^data:[^,]*,/, "")));
        } else if (c && typeof c === "object") {
          // three shapes: {card, avatar} from the UI, {pngBase64, avatar}, or a bare card
          raw = c.pngBase64 ? extractCardFromPng(b64ToBytes(String(c.pngBase64).replace(/^data:[^,]*,/, ""))) : (c.card ?? c);
          avatar = typeof c.avatar === "string" ? c.avatar : null;
        }
        const n = normalizeCard(raw, avatar);
        if (!n) { summary.errors.push("card skipped: no name or unparseable"); continue; }
        writeCardWithBook(n, raw, null, avatar || undefined);
      } catch (err) { summary.errors.push("card failed: " + String((err && err.message) || err).slice(0, 100)); }
    }
    for (const w of b.worldInfo || []) {
      // world files carry no name — the UI passes the file name as `name`
      try { writeBook(normalizeBook(w, "imported-book"), "imported-book"); } catch { summary.errors.push("world info failed"); }
    }
    for (const p of b.presets || []) {
      try { writePreset(restorePreset(p)); } catch { summary.errors.push("preset failed"); }
    }
    for (const r of b.regex || []) {
      try { writeRegex(normalizeRegex(r)); } catch { summary.errors.push("regex failed"); }
    }
    for (const per of b.personas || []) {
      try { if (per && per.name) writePersona(per.name, per.description); } catch { summary.errors.push("persona failed"); }
    }
    for (const t of b.themes || []) {
      try {
        if (!t || typeof t.name !== "string") continue;
        const id = uid(slug(t.name), "themes");
        writeJson("themes/" + id + ".json", {
          id, name: t.name,
          colors: {
            text: typeof t.main_text_color === "string" ? t.main_text_color : undefined,
            background: typeof t.chat_tint_color === "string" ? t.chat_tint_color : undefined,
            panel: typeof t.main_color === "string" ? t.main_color : undefined,
            accent: typeof t.theme_color === "string" ? t.theme_color : undefined,
          },
        });
        summary.themes.push(id);
      } catch { summary.errors.push("theme failed"); }
    }
    for (const c of b.chats || []) {
      try {
        const n = normalizeChatLines(c);
        if (!n) continue;
        // link to a character by name when one matches
        let characterId = null;
        try {
          for (const cid of fsx.list("characters")) {
            const card = readJson("characters/" + cid + "/card.json", null);
            if (card && c.character && card.name.toLowerCase() === String(c.character).toLowerCase()) { characterId = cid; break; }
          }
        } catch {}
        writeChat(n, characterId);
      } catch { summary.errors.push("chat failed"); }
    }
    return { status: 200, json: summary };
  }

  if (req.path === "/import/finish") {
    const id = String(req.body?.importId || "");
    if (!/^[a-f0-9-]{36}$/.test(id)) return { status: 400, json: { error: "invalid import id" } };
    for (const collection of ["characters", "books", "presets", "personas", "groups"]) fsx.remove("__lookup/" + id + "_" + collection);
    return { status: 200, json: { ok: true } };
  }

  // ---------- bounded archive entries ----------
  if (req.path === "/import/zip") {
    const rawEntries = host.zip.entries();
    const entries = {};
    const names = Object.keys(rawEntries);
    const originalNames = {};
    const isText = (v) => typeof v === "string";

    // Foreign backup layouts normalize to our tree first. The old rule matched
    // one exact nesting (data/<x>/default-user/…) and nothing else, so the
    // three ways people actually make these zips — the tool's own backup, the
    // data folder, the whole install directory — all arrived as unrecognized
    // paths and imported nothing. Anchor on the collection folder instead of
    // the wrapper: whatever sits above "characters/" or "worlds/" is somebody's
    // folder name and none of our business.
    for (const raw of names) {
      if (raw.endsWith(".charx")) continue; // handled as files, not zips
      const name = normalizeEntryName(raw);
      if (entries[name] === undefined) { entries[name] = rawEntries[raw]; originalNames[name] = raw; }
    }

    // charx package: card.json at the root + assets/ entries the card
    // references by __asset:/embeded:// URIs
    if (isText(entries["card.json"])) {
      try {
        const assetDict = {};
        for (const name of Object.keys(entries)) {
          const b64 = entryBase64(entries[name]);
          if (b64) assetDict[name] = b64;
          else if (entries[name]?.__image__ && host.zip.image) assetDict[name] = host.zip.image(originalNames[name]).url;
        }
        const parsed = JSON.parse(entries["card.json"]);
        const card = normalizeCard(parsed);
        if (card) { writeCardWithBook(card, parsed, assetDict); return { status: 200, json: { ...summary, name: card.name } }; }
      } catch {}
      return { status: 400, json: { error: "charx package has no readable card.json" } };
    }

    // Preset and persona MAPS first: a chat's meta names the preset and
    // persona it rides, so they have to exist before any chat is written.
    const presetsText = entries["User Settings/openai_settings.json"];
    if (isText(presetsText)) {
      try {
        const all = JSON.parse(presetsText);
        // the map key IS the preset's name — pass it through so restored
        // presets keep their names instead of all landing on "imported"
        for (const [presetName, preset] of Object.entries(all ?? {})) writePreset(restorePreset(preset, presetName));
      } catch { summary.errors.push("presets failed"); }
    }
    for (const rname of Object.keys(entries)) {
      if (!rname.startsWith("User Settings/regex/") || !rname.endsWith(".json") || !isText(entries[rname])) continue;
      try { writeRegex(normalizeRegex(JSON.parse(entries[rname]))); } catch { summary.errors.push("regex failed: " + rname); }
    }
    // The flat {name: description} map is the lowest common denominator; skip
    // it when the zip also carries full persona records, or every persona
    // would be imported twice — once whole, once as a bare name.
    const hasFullPersonas = (Number(req.body?.collections?.["personas/"]) > 0) || Object.keys(entries).some((n) => n.startsWith("personas/") && n.endsWith(".json"));
    for (const flat of ["User Settings/personas.json", "personas.json"]) {
      if (hasFullPersonas || !isText(entries[flat])) continue;
      try {
        const map = JSON.parse(entries[flat]);
        for (const [pname, v] of Object.entries(map ?? {})) {
          writePersona(pname, typeof v === "string" ? v : String((v && v.description) || ""));
        }
      } catch { summary.errors.push("personas failed: " + flat); }
    }
    // A foreign tool keeps its personas inside its settings file instead: a
    // map of avatar file → name, plus a parallel map of descriptions.
    if (!hasFullPersonas && isText(entries["settings.json"])) {
      try {
        const st = JSON.parse(entries["settings.json"]);
        const descs = st && typeof st.persona_descriptions === "object" && st.persona_descriptions ? st.persona_descriptions : {};
        const namesMap = st && typeof st.personas === "object" && st.personas ? st.personas : null;
        for (const [avatarKey, pname] of Object.entries(namesMap ?? {})) {
          const d = descs[avatarKey];
          writePersona(String(pname || avatarKey), String((d && d.description) || ""));
        }
      } catch { summary.errors.push("personas failed: settings.json"); }
    }

    // Order matters: a chat resolves its character, group, preset, persona
    // and books by NAME, and a persona resolves its books and bound cards the
    // same way. One pass in whatever order the zip's central directory
    // happened to list things left half of those unresolved.
    const PHASES = ["characters/", "worlds/", "lorebooks/", "presets/", "openai settings/", "textgen settings/", "extensions/regex/", "regex/", "personas/", "groups/", "chats/", "databank/"];
    const phaseOf = (n) => {
      const l = n.toLowerCase();
      for (let i = 0; i < PHASES.length; i++) if (l.startsWith(PHASES[i])) return i;
      return PHASES.length;
    };
    const orderedNames = Object.keys(entries).sort((a, b) => phaseOf(a) - phaseOf(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const name of orderedNames) {
      if (entries[name]?.error) { summary.errors.push(name + ": " + entries[name].error); continue; }
      // A card PNG lives in characters/, or loose at the root when someone
      // zipped a pile of cards. Anywhere else (persona and user avatars,
      // backgrounds, sprites) a .png is just a picture — reading it as a
      // failed card would bury the real errors in noise.
      if (name.endsWith(".png") && (name.startsWith("characters/") || !name.includes("/"))) {
        if (entries[name]?.__image__ && host.zip.image) {
          try {
            const image = host.zip.image(originalNames[name]);
            let rawCard = null;
            for (const key of ["ccv3", "chara"]) {
              const payload = image.metadata[key];
              if (!payload) continue;
              try { rawCard = JSON.parse(payload.trimStart().startsWith("{") ? payload : new TextDecoder().decode(new Uint8Array(b64ToBytes(payload)))); break; } catch { /* try the next metadata field */ }
            }
            const card = rawCard && normalizeCard(rawCard);
            if (card) { card.avatar = image.url; writeCardWithBook(card, rawCard, null, image.url); }
            else if (name.startsWith("characters/")) summary.errors.push("png card without embedded data: " + name);
          } catch (error) { summary.errors.push("png card failed: " + name + ": " + String(error.message || error)); }
          continue;
        }
        const b64 = entryBase64(entries[name]);
        if (b64) {
          const rawCard = cardFromPngBase64(b64);
          const n = rawCard && normalizeCard(rawCard);
          // ccdefault: assets point at the card PNG itself
          if (n) writeCardWithBook(n, rawCard, null, "data:image/png;base64," + b64);
          else if (name.startsWith("characters/")) summary.errors.push("png card without embedded data: " + name);
        } else if (name.startsWith("characters/")) {
          summary.errors.push("png card too large to read from the zip — import it directly from the Import button: " + name);
        }
        continue;
      }
      if (name.startsWith("characters/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const parsed = JSON.parse(entries[name]);
          const n = normalizeCard(parsed);
          if (n) writeCardWithBook(n, parsed, null, typeof parsed.avatar === "string" ? parsed.avatar : undefined);
        } catch { summary.errors.push("card failed: " + name); }
        continue;
      }
      if ((name.startsWith("worlds/") || name.startsWith("lorebooks/")) && name.endsWith(".json") && isText(entries[name])) {
        try {
          const fallback = name.split("/").pop().replace(/\.json$/i, "");
          const raw = JSON.parse(entries[name]);
          writeBook(normalizeBook(raw, fallback), fallback, raw && raw._studio);
        } catch { summary.errors.push("world failed: " + name); }
        continue;
      }
      // A foreign tool files chat-completion and text-completion presets under
      // their own folders, one file per preset, named by the file.
      if (/^(?:openai|textgen) settings\//i.test(name) && name.endsWith(".json") && isText(entries[name])) {
        try {
          const n = restorePreset(JSON.parse(entries[name]), name.split("/").pop().replace(/\.json$/i, ""));
          if (n) writePreset(n);
        } catch { summary.errors.push("preset failed: " + name); }
        continue;
      }
      if (name.startsWith("regex/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const raw = JSON.parse(entries[name]);
          for (const one of Array.isArray(raw) ? raw : [raw]) writeRegex(normalizeRegex(one));
        } catch { summary.errors.push("regex failed: " + name); }
        continue;
      }
      if (name.startsWith("databank/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const d = JSON.parse(entries[name]);
          if (d && typeof d === "object" && Array.isArray(d.chunks)) {
            const did = uid(slug(d.name || "doc"), "databank");
            writeJson("databank/" + did + ".json", { ...d, id: did });
            summary.databank.push(did);
          }
        } catch { summary.errors.push("databank failed: " + name); }
        continue;
      }
      if (name.startsWith("groups/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const g = JSON.parse(entries[name]);
          // characters were re-created under name-derived ids — remap each
          // member by original id first, then by the exported _memberNames
          const resolvedMembers = (g.memberIds || g.members || []).map((mid, i) => {
            if (taken("characters/" + mid + "/card.json")) return mid;
            const nm = (g._memberNames || [])[i] || String(mid).replace(/\.png$/i, "");
            return nm ? charIdByName().get(lower(nm)) || charIdByName().get(slug(nm)) || null : null;
          });
          const memberIds = resolvedMembers.filter(Boolean);
          // the id lands in the write path: slug it like every other collection
          // so a crafted backup cannot climb out of groups/
          const gid = uid(slug(g.name || g.id || "group"), "groups");
          writeJson("groups/" + gid + ".json", { ...g, id: gid, name: g.name || gid, memberIds, mode: g.mode || "natural", mutedIds: (g.mutedIds || []).map((mid) => { const index = (g.memberIds || g.members || []).indexOf(mid); return index >= 0 ? resolvedMembers[index] : null; }).filter(Boolean) });
          for (const key of [g.name, g.id, g.chat_id, gid]) if (key) { groupIdByName.set(lower(key), gid); groupIdByName.set(slug(key), gid); }
          summary.groups.push(gid);
        } catch { summary.errors.push("group failed: " + name); }
        continue;
      }
      if (name.startsWith("extensions/regex/") && name.endsWith(".json") && isText(entries[name])) {
        try { writeRegex(normalizeRegex(JSON.parse(entries[name]))); } catch { summary.errors.push("regex failed: " + name); }
        continue;
      }
      if (name === "personas.json" && isText(entries[name])) {
        // single-file personas map: { "persona name": { ... } }
        try {
          const map = JSON.parse(entries[name]);
          for (const [pname, p] of Object.entries(map || {})) {
            writePersona(pname, typeof p === "string" ? p : String((p && p.description) || (p && p.position !== undefined && p.text) || ""));
          }
        } catch { summary.errors.push("personas failed: " + name); }
        continue;
      }
      if (name.startsWith("personas/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const p = JSON.parse(entries[name]);
          // the whole record, not just the two fields the flat map carries
          writePersona(String(p.name || name.split("/").pop().replace(/\.json$/, "")), String(p.description || ""), p);
        } catch { summary.errors.push("persona failed: " + name); }
        continue;
      }
      if (name.startsWith("presets/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const n = restorePreset(JSON.parse(entries[name]), name.split("/").pop().replace(/\.json$/i, ""));
          if (n) writePreset(n);
        } catch { summary.errors.push("preset failed: " + name); }
        continue;
      }
      if ((name.startsWith("chats/") || name.startsWith("group chats/")) && name.endsWith(".jsonl") && isText(entries[name])) {
        try {
          const parts = name.split("/");
          const character = (parts[1] || "").replace(/\.jsonl$/i, "");
          const file = (parts[2] || parts[1] || "chat").replace(/\.jsonl$/i, "");
          const lines = entries[name].split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const n = normalizeChatLines({ character, file, lines });
          // sidecars our own backups write next to the transcript: everything
          // ABOUT the chat, and its facts vault
          const sidecar = name.replace(/\.jsonl$/i, ".meta.json");
          const saved = isText(entries[sidecar]) ? (() => { try { return JSON.parse(entries[sidecar]); } catch { return null; } })() : null;
          const vault = name.replace(/\.jsonl$/i, ".memories.json");
          if (n && isText(entries[vault])) {
            try {
              const mem = JSON.parse(entries[vault]);
              if (Array.isArray(mem) && mem.length) n.memories = mem;
            } catch { /* a bad vault is not worth failing the chat over */ }
          }
          if (n) {
            const characterId = charIdByName().get(lower(character)) || null;
            // folder didn't match a card → it's a group chat (folder is the
            // group name slug, or the group id slug from older exports)
            let groupId = groupIdByName.get(lower(character)) || groupIdByName.get(slug(character)) || null;
            if (!characterId && !groupId) {
              try {
                for (const gf of fsx.list("groups").filter((x) => x.endsWith(".json"))) {
                  const gr = readJson("groups/" + gf, null);
                  if (gr && (slug(gr.name) === character.toLowerCase() || slug(gr.id) === character.toLowerCase())) { groupId = gr.id; break; }
                }
              } catch {}
            }
            // title prefix from the resolved owner, not the zip folder slug
            const ownerCard = characterId ? readJson("characters/" + characterId + "/card.json", null) : null;
            const ownerGroup = groupId ? readJson("groups/" + groupId + ".json", null) : null;
            const ownerName = ownerCard?.name || ownerGroup?.name;
            // the slug filename is a lossy echo of the title (no case, no
            // punctuation); the sidecar has the real one, so only fall back
            // to un-slugging when there is no sidecar to read
            if (saved && typeof saved.title === "string" && saved.title.trim()) n.title = saved.title;
            else if (ownerName) n.title = ownerName + ": " + unslugTitle(file);
            // group message attribution: engine ids changed on restore —
            // remap each msg.charId by id, then by the speaker name
            if (groupId) {
              const byName = charIdByName();
              for (const m of n.msgs) {
                if (m.charId && taken("characters/" + m.charId + "/card.json")) continue;
                m.charId = (m.name && byName.get(String(m.name).toLowerCase())) || null;
              }
            }
            writeChat(n, characterId, groupId, saved);
          }
        } catch { summary.errors.push("chat failed: " + name); }
        continue;
      }
    }

    // App settings and the local collections (quick replies, themes,
    // backgrounds, tags, folders, connection profiles) are part of a backup
    // too: without them a restore comes up on stock everything.
    if (isText(entries["settings.json"])) {
      try {
        const st = JSON.parse(entries["settings.json"]);
        const saved = st && typeof st.settings === "object" && st.settings ? st.settings : null;
        // `ui` is the whole app settings object. The model is deliberately
        // NOT restored: the connection it names belongs to the other machine.
        if (saved && saved.ui && typeof saved.ui === "object") {
          writeJson("settings.json", { ...readJson("settings.json", {}), ui: saved.ui });
          summary.settings = true;
        }
      } catch { summary.errors.push("settings failed"); }
    }
    if (isText(entries["library.json"])) {
      try {
        const lib = JSON.parse(entries["library.json"]);
        if (lib && typeof lib === "object" && Object.keys(lib).length) {
          writeJson("library.json", { ...readJson("library.json", {}), ...lib });
          summary.library = true;
        }
      } catch { summary.errors.push("library failed"); }
    }
    return { status: 200, json: summary };
  }

  return null;
}

export const TOOLS = [];
