import { handleRoute } from "../import.js";
import { catalogText, previewLorebook } from "./shared.js";

const WYVERN_BASE = "https://app.wyvern.chat/api";
const WYVERN_ID = /^[a-zA-Z0-9_-]{6,100}$/;

function wyvernCard(c) {
  const greetings = c.enable_advanced_greetings && Array.isArray(c.greetings)
    ? c.greetings.filter(g => g?.id !== "default" && typeof g?.content === "string" && g.content.trim()).map(g => g.content)
    : Array.isArray(c.alternate_greetings) ? c.alternate_greetings.filter(g => typeof g === "string") : [];
  const books = Array.isArray(c.lorebooks) ? c.lorebooks : [];
  const entries = books.flatMap(book => {
    const rows = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
    return rows.map((entry, i) => ({ ...entry, id: i, keys: Array.isArray(entry.keys) ? entry.keys : [], content: entry.content || "", enabled: entry.enabled !== false, insertion_order: entry.insertion_order ?? 100, position: entry.position === "after_char" ? "after_char" : "before_char" }));
  });
  return { spec: "chara_card_v2", spec_version: "2.0", data: {
    name: String(c.chat_name || c.name || "").trim(), description: [c.description, c.shared_info].filter(v => typeof v === "string" && v).join("\n\n"),
    personality: c.personality || "", scenario: c.scenario || "", first_mes: c.first_mes || "", mes_example: c.mes_example || "",
    creator_notes: c.creator_notes || "", system_prompt: c.pre_history_instructions || "", post_history_instructions: c.post_history_instructions || "",
    creator: c.creator?.displayName || c.creator?.username || "", tags: Array.isArray(c.tags) ? c.tags : [], alternate_greetings: greetings,
    extensions: { wyvern: { id: c.id, url: "https://app.wyvern.chat/characters/" + c.id },
      ...(c.character_note ? { depth_prompt: { prompt: c.character_note, depth: 4, role: "system" } } : {}),
      ...(Array.isArray(c.regex_scripts) ? { regex_scripts: c.regex_scripts } : {}),
    },
    ...(entries.length ? { character_book: { ...books[0], name: books.map(b => b.name).filter(Boolean).join(", "), entries: entries.map((entry, i) => ({ ...entry, id: i })) } } : {}),
  } };
}

function wyvernAvatar(c) {
  const avatar = c.avatar_url || c.avatar;
  if (typeof avatar !== "string") return null;
  if (/^https:\/\/(?:imagedelivery\.net|api\.wyvern\.chat)\//i.test(avatar)) return avatar;
  return /^[a-zA-Z0-9_-]+$/.test(avatar) ? "https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/" + avatar + "/public" : null;
}

export function wyvernRoute(req, host) {
  if (!host.net) return { status: 503, json: { error: "Network permission not granted" } };
  const b = req.body || {};
  const searching = req.path === "/marketplace/search";
  if (!searching && !WYVERN_ID.test(String(b.id || ""))) return { status: 400, json: { error: "Invalid character id" } };
  const page = Math.max(1, Math.min(10000, Math.floor(Number(b.page) || 1)));
  const first = Math.max(1, Math.min(48, Math.floor(Number(b.first) || 24)));
  if (!host.net.results.catalog && !req.stash?.character) {
    const params = new URLSearchParams({ page: String(page), limit: String(first) });
    const query = String(b.search || "").trim().slice(0, 120);
    if (query) params.set("query", query);
    params.set("sort", b.sort === "newest" ? "dateCreated" : b.sort === "rating" ? "total_likes" : b.sort === "chats" ? "total_messages" : "total_views");
    params.set("order", "DESC");
    if (b.nsfw) params.set("show_nsfw", "true");
    if (!b.nsfw) params.set("rating", "none");
    else if (b.nsfwOnly) params.set("rating", "explicit");
    if (Array.isArray(b.tags) && b.tags.length) params.set("tags", b.tags.slice(0, 6).map(t => String(t).slice(0, 80)).join(","));
    host.net.request("catalog", { url: searching ? WYVERN_BASE + "/characters/public?" + params : WYVERN_BASE + "/characters/" + encodeURIComponent(b.id), json: true, maxBytes: 8 * 1024 * 1024, headers: { "Accept": "application/json" } });
    return { __llmPending: true };
  }
  const response = host.net.results.catalog;
  if (!req.stash?.character && !response.ok) return { status: 502, json: { error: "Wyvern request failed: " + (response.status || response.error || "no response") } };
  const data = req.stash?.character || response.json;
  if (searching) {
    if (!Array.isArray(data?.characters) || typeof data.total !== "number" || !Number.isFinite(data.total) || data.total < 0) return { status: 502, json: { error: "Invalid Wyvern search results" } };
    const metric = v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    return { status: 200, json: { source: "wyvern", count: data.total, page, first, results: data.characters.filter(c => WYVERN_ID.test(String(c.id || ""))).map(c => {
      const stats = c.statistics_record || c.entity_statistics || {};
      return { id: c.id, name: catalogText(c.name || c.chat_name, 500), creator: catalogText(c.creator?.displayName || c.creator?.username, 200),
        tagline: catalogText(c.tagline, 1000), description: catalogText(c.creator_notes || c.description, 12000), topics: Array.isArray(c.tags) ? c.tags.filter(t => typeof t === "string") : [],
        downloads: null, favorites: metric(stats.likes ?? stats.total_likes ?? c.likes), tokens: metric(c.token_count), rating: null, ratingCount: null,
        chats: metric(stats.chats ?? stats.total_chats), messages: metric(stats.messages ?? stats.total_messages), nsfw: c.rating === "explicit" || c.rating === "mature", avatar: wyvernAvatar(c), maxRes: wyvernAvatar(c), createdAt: c.created_at || null };
    }) } };
  }
  const c = data?.character || data;
  if (!c || typeof c !== "object" || !c.id) return { status: 502, json: { error: "Invalid Wyvern character" } };
  const card = wyvernCard(c), d = card.data;
  const blocked = Array.isArray(c.secretFields) && c.secretFields.length ? "Some definition fields are private." : c.visibility && c.visibility !== "public" ? "This character is not public." : !d.name || (!d.description && !d.personality && !d.first_mes && !d.scenario) ? "The public definition is unavailable." : null;
  if (req.path === "/marketplace/import") {
    if (blocked) return { status: 403, json: { error: blocked } };
    let avatar = typeof b.avatar === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.avatar) && b.avatar.length < 1024 * 1024 ? b.avatar : null;
    const imageUrl = wyvernAvatar(c);
    if (!avatar && imageUrl && !host.net.results.avatar) {
      host.net.request("avatar", { url: imageUrl, binary: true, maxBytes: 8 * 1024 * 1024 });
      return { __llmPending: true, stash: { character: c } };
    }
    const image = host.net.results.avatar, mime = image?.contentType?.split(";")[0];
    if (!avatar && image?.ok && image.base64 && /^image\/(png|jpeg|webp|gif)$/.test(mime)) avatar = "data:" + mime + ";base64," + image.base64;
    const imported = handleRoute({ ...req, path: "/import/batch", body: { cards: [{ card, avatar }], enableEmbeddedRegex: b.enableEmbeddedRegex === true, deferEmbeddedLore: b.deferEmbeddedLore === true } }, host);
    if (!imported.json?.characters?.length) return { status: 500, json: { error: imported.json?.errors?.[0] || "Card import failed" } };
    return { ...imported, json: { ...imported.json, name: d.name, ...(avatar ? {} : { warning: "Card imported without its image." }) } };
  }
  return { status: 200, json: { source: "wyvern", id: b.id, importable: !blocked, importReason: blocked, avatar: wyvernAvatar(c),
    greeting: catalogText(d.first_mes, 16000), alternateGreetings: d.alternate_greetings.slice(0, 40).map(g => g.slice(0, 16000)),
    personality: catalogText(d.description, 24000), traits: catalogText(d.personality, 24000), scenario: catalogText(d.scenario, 8000), exampleDialogs: catalogText(d.mes_example, 16000),
    creatorNotes: catalogText(d.creator_notes, 8000), systemPrompt: catalogText(d.system_prompt, 8000), postHistoryInstructions: catalogText(d.post_history_instructions, 8000), lorebook: previewLorebook(d.character_book), lorebookEntries: d.character_book?.entries.length || 0 } };
}
