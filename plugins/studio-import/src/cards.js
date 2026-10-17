import { firstOf } from "./entries.js";

const CARD_KNOWN_FIELDS = new Set([
  "name", "description", "personality", "scenario", "first_mes", "mes_example",
  "alternate_greetings", "creator_notes", "creatorcomment", "tags", "system_prompt",
  "post_history_instructions", "character_book", "avatar", "extensions",
]);

export function normalizeCard(raw, avatarDataUrl) {
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
    ...(d.character_book && typeof d.character_book === "object" ? { character_book: d.character_book } : {}),
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
export function resolveCardAssets(card, assetDict, sourceAvatar) {
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

export function keyList(k) {
  if (Array.isArray(k)) return k.filter((x) => typeof x === "string");
  if (typeof k === "string") return k.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Card-embedded books (the card-spec shape: flat entries with keys/
 *  secondary_keys/insertion_order + an extensions bag) rebuilt as world-info
 *  entries so the shared normalizer handles both. */
export function embeddedBookToWorld(raw) {
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
