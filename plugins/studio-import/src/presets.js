import { slug } from "./entries.js";

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
export function restorePreset(raw, fallbackName) {
  if (!raw || typeof raw !== "object" || !raw.studio || typeof raw.studio !== "object" || !Array.isArray(raw.studio.sections)) {
    return normalizePreset(raw, fallbackName);
  }
  const { id: _id, ...rest } = raw;
  const { isDefault: _isDefault, readOnly: _readOnly, ...studio } = raw.studio;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : fallbackName || "imported";
  return { ...rest, name, studio };
}

export function normalizePreset(raw, fallbackName) {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof raw.name === "string" && raw.name.trim() ? raw.name
    : typeof raw.presetName === "string" && raw.presetName.trim() ? raw.presetName
    : typeof fallbackName === "string" && fallbackName.trim() ? fallbackName
    : "imported";
  const num = (k) => (typeof raw[k] === "number" ? raw[k] : undefined);
  const preset = {
    name: label,
    ...(raw.extensions && typeof raw.extensions === "object" ? { extensions: raw.extensions } : {}),
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
