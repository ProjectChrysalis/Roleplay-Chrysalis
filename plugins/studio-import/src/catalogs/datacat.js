import { handleRoute } from "../import.js";
import { previewLorebook } from "./shared.js";

// chub's CDN/API rejects default http-client user-agents with a fake
// "not available in your country" page — present as a browser
export const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const DATACAT_BASE = "https://datacat.run";
const DATACAT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function datacatBlocked(c) {
  if (c.downloads_disabled || c.downloadsDisabled || c.deleted_by_creator_policy || c.deletedByCreatorPolicy || c.deleted_at) return "The creator has disabled imports.";
  const policy = c.creator_chat_download_policy || c.creatorChatDownloadPolicy || c.download_access_policy || c.downloadAccessPolicy;
  if ((typeof policy === "string" && /deny|block|disable|private|redirect/i.test(policy)) || policy?.allowed === false) return "The creator has restricted imports.";
  if (c.is_public === false || c.isPublic === false || /dormant|deleted|redirect/.test(c.creator_lifecycle_status || c.creatorLifecycleStatus || "")) return "This card is not available for import.";
  return null;
}

function datacatCard(c) {
  const variant = (Array.isArray(c.content_variants) ? c.content_variants : []).find(v => v?.isPrimary && !v.isRecoveryPlaceholder)?.content || {};
  const raw = c.chara_card_v2_json || variant.chara_card_v2_json || {};
  const native = raw.data && typeof raw.data === "object" ? raw.data : {};
  const saucepan = String(c.primary_content_source_kind || "").includes("saucepan");
  const strip = text => typeof text === "string" ? text.replace(/^\s*##[A-Z _]*(?:START|END)##[ \t]*\r?\n?/, "").replace(/\r?\n?[ \t]*##[A-Z _]*(?:START|END)##\s*$/, "") : "";
  const tags = Array.isArray(native.tags) ? native.tags : Array.isArray(c.tags) ? c.tags : Array.isArray(c.custom_tags) ? c.custom_tags : [];
  const data = {
    ...native,
    name: native.name || c.chat_name || c.chatName || c.name || "",
    description: strip(native.description || (saucepan ? variant.description || c.description : c.personality || variant.personality) || ""),
    personality: typeof native.personality === "string" ? native.personality : "",
    scenario: native.scenario || variant.scenario || c.scenario || "",
    first_mes: native.first_mes || variant.first_message || c.first_message || "",
    alternate_greetings: native.alternate_greetings || variant.alternate_greetings || c.alternate_greetings || [],
    creator_notes: native.creator_notes || (saucepan ? c.companion_snapshot?.full_description : c.description) || "",
    creator: c.creator_name || c.creatorName || native.creator || "",
    tags: tags.map(t => typeof t === "string" ? t : t?.name || t?.slug).filter(t => typeof t === "string"),
    extensions: { ...native.extensions, datacat: { ...native.extensions?.datacat, id: c.character_id || c.characterId, sourceKind: c.primary_content_source_kind || null, creatorId: c.creator_id || c.creatorId || null, url: DATACAT_BASE + "/characters/" + (c.character_id || c.characterId) } },
  };
  for (const field of ["name", "scenario", "first_mes", "creator_notes", "creator"]) if (typeof data[field] !== "string") data[field] = "";
  return { ...raw, spec: raw.spec || "chara_card_v2", spec_version: raw.spec_version || "2.0", data };
}

function datacatAvatar(c) {
  const candidates = [c.chara_card_v2_json?.data?.avatar, c.avatar_variant_urls?.hero, c.avatarVariantUrls?.hero, c.avatar];
  for (const value of candidates) {
    if (typeof value !== "string" || value === "none") continue;
    if (/^https:\/\//.test(value)) return value;
    if (/^[\w.-]+$/.test(value)) return "https://ella.janitorai.com/bot-avatars/" + value;
  }
  return null;
}

function datacatStore(host, op, value) {
  try { return host.store?.[op]("datacat.session", value); } catch { return null; }
}

export function datacatRoute(req, host) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
  if (["/marketplace/detail", "/marketplace/import"].includes(req.path) && !DATACAT_ID.test(String(b.id || ""))) {
    return { status: 400, json: { error: "bad listing id" } };
  }
  if (req.path === "/marketplace/search" && b.creator && !DATACAT_ID.test(String(b.creator))) return { status: 400, json: { error: "bad creator id" } };
  const headers = { "user-agent": BROWSER_UA, accept: "application/json", origin: DATACAT_BASE, referer: DATACAT_BASE + "/" };
  const results = host.net.results;
  const cached = datacatStore(host, "get");
  const savedToken = cached?.expiresAt > Date.now() && typeof cached.token === "string" ? cached.token : null;
  // Session tokens stay in the backend store, outside card data and responses.
  if (!Object.keys(results).length && !savedToken) {
    host.net.request("identify", {
      url: DATACAT_BASE + "/api/liberator/identify", method: "POST",
      body: { deviceToken: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const n = Math.floor(Math.random() * 16); return (c === "x" ? n : (n & 3) | 8).toString(16); }) }, headers, json: true, maxBytes: 128 * 1024,
    });
    return { __llmPending: true };
  }
  if (!results.datacat && !req.stash?.character && (results.identify || savedToken)) {
    const token = savedToken || (results.identify.ok && results.identify.json?.sessionToken);
    if (typeof token !== "string" || !token) return { status: 502, json: { error: "Datacat session unavailable" } };
    if (!savedToken) datacatStore(host, "put", { token, expiresAt: Date.now() + 30 * 60 * 1000 });
    headers["X-Session-Token"] = token;
    const page = Math.max(1, Math.min(1000, Math.floor(Number(b.page) || 1)));
    const first = Math.max(1, Math.min(50, Math.floor(Number(b.first) || 24)));
    let path;
    if (req.path === "/marketplace/tags") path = "/api/tags/faceted?mode=recent&minTotalTokens=0";
    else if (["/marketplace/detail", "/marketplace/import"].includes(req.path)) path = "/api/characters/" + encodeURIComponent(b.id);
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
      path = b.creator ? "/api/creators/" + b.creator + "/characters?limit=" + first + "&offset=" + ((page - 1) * first) + "&sortBy=chat_count" : "/api/characters/recent-public?" + qs.toString();
    }
    host.net.request("datacat", { url: DATACAT_BASE + path, headers, json: true, maxBytes: (req.path === "/marketplace/tags" ? 12 : 5) * 1024 * 1024 });
    return { __llmPending: true, stash: { page, first, avatarPass: !results.identify } };
  }
  const r = results.datacat;
  if ([401, 403].includes(r?.status)) datacatStore(host, "delete");
  const data = req.path === "/marketplace/import" && req.stash?.character ? { success: true, character: req.stash.character } : r?.ok && r.json?.success === true ? r.json : null;
  if (!data) return { status: 502, json: { error: "Datacat request failed (" + (r?.status || r?.error || "invalid response") + ")" } };
  if (req.path === "/marketplace/tags") {
    if (!Array.isArray(data.tags)) return { status: 502, json: { error: "Invalid Datacat tags" } };
    const selected = (Array.isArray(b.selected) ? b.selected : []).filter(t => typeof t === "string").slice(0, 12).map(t => t.toLowerCase());
    const tags = data.tags.filter(t => Number.isInteger(t.id) && typeof t.name === "string" && Number.isFinite(Number(t.count)) && Number(t.count) >= 0).sort((a, b) => Number(b.count) - Number(a.count));
    const pinned = tags.filter(t => selected.includes(t.name.toLowerCase()));
    const search = String(b.search || "").trim().toLowerCase().slice(0, 80);
    const matches = tags.filter(t => !selected.includes(t.name.toLowerCase()) && (!search || t.name.toLowerCase().includes(search)));
    return { status: 200, json: { tags: [...pinned, ...matches].slice(0, 2000).map(t => ({ id: t.id, tag: t.name, n: Number(t.count) })) } };
  }
  const clip = (v, limit) => typeof v === "string" ? v.slice(0, limit) : "";
  if (["/marketplace/detail", "/marketplace/import"].includes(req.path)) {
    const c = data.character;
    if (!c || typeof c !== "object") return { status: 502, json: { error: "Invalid Datacat character" } };
    const card = datacatCard({ ...c, character_id: c.character_id || c.characterId || b.id });
    const d = card.data;
    const missing = !d.name.trim() || (!d.description.trim() && !d.personality.trim() && !d.first_mes.trim() && !d.scenario.trim()) || c.is_recovery_placeholder;
    const blocked = datacatBlocked(c) || (missing ? "The full public definition is unavailable." : null);
    if (req.path === "/marketplace/import") {
      if (blocked) return { status: 403, json: { error: blocked } };
      let avatar = typeof b.avatar === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.avatar) && b.avatar.length < 1024 * 1024 ? b.avatar : null;
      const imageUrl = datacatAvatar(c);
      const imageHost = imageUrl?.match(/^https:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase();
      const permitted = ["media.datacat.run", "ella.janitorai.com"].includes(imageHost);
      if (!avatar && imageUrl && permitted && req.stash?.avatarPass && !results.avatar) {
        host.net.request("avatar", { url: imageUrl, binary: true, maxBytes: 8 * 1024 * 1024 });
        return { __llmPending: true, stash: { ...req.stash, character: c } };
      }
      const image = results.avatar;
      const mime = image?.contentType?.split(";")[0];
      if (!avatar && image?.ok && image.base64 && /^image\/(png|jpeg|webp|gif)$/.test(mime)) avatar = "data:" + mime + ";base64," + image.base64;
      const imported = handleRoute({ ...req, path: "/import/batch", body: { cards: [{ card, avatar }], enableEmbeddedRegex: b.enableEmbeddedRegex === true, deferEmbeddedLore: b.deferEmbeddedLore === true } }, host);
      if (!imported.json?.characters?.length) return { status: 500, json: { error: imported.json?.errors?.[0] || "Card import failed" } };
      return { ...imported, json: { ...imported.json, name: d.name, ...(avatar ? {} : { warning: "Card imported without its image." }) } };
    }
    const book = d.character_book;
    return { status: 200, json: {
      source: "datacat", id: b.id, importable: !blocked, importReason: blocked, avatar: datacatAvatar(c),
      greeting: clip(d.first_mes || c.first_message, 16000),
      alternateGreetings: (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : Array.isArray(c.alternate_greetings) ? c.alternate_greetings : []).filter((g) => typeof g === "string").slice(0, 40).map((g) => g.slice(0, 16000)),
      personality: clip(d.description || c.personality, 24000), traits: clip(d.personality, 24000), scenario: clip(d.scenario || c.scenario, 8000),
      exampleDialogs: clip(d.mes_example, 16000), creatorNotes: clip(d.creator_notes || c.description, 8000),
      systemPrompt: clip(d.system_prompt, 8000), postHistoryInstructions: clip(d.post_history_instructions, 8000),
      lorebook: previewLorebook(book),
      lorebookEntries: book ? (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries || {}).length) : 0,
    } };
  }
  const rows = b.creator ? data.list : data.characters;
  const total = b.creator ? data.total : data.totalCount;
  if (!Array.isArray(rows) || !Number.isFinite(total)) return { status: 502, json: { error: "Invalid Datacat search results" } };
  const safeAvatar = (v) => typeof v === "string" && /^https:\/\//i.test(v) ? v : null;
  const metric = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const listings = rows.filter((c) => DATACAT_ID.test(String(c.characterId || c.character_id || ""))).map((c) => ({
    id: c.characterId || c.character_id, name: clip(c.name, 500), creator: clip(c.creatorName || c.creator_name, 200), creatorId: c.creatorId || c.creator_id || null,
    tagline: "", description: clip(c.description, 12000),
    topics: (Array.isArray(c.tags) ? c.tags : Array.isArray(c.custom_tags) ? c.custom_tags : []).map((t) => typeof t === "string" ? t : t.name).filter((t) => typeof t === "string"),
    downloads: null, favorites: metric(c.stats?.favoritesCount?.favoritesCount),
    tokens: metric(c.token_counts?.total_tokens ?? c.tokenCounts?.totalTokens ?? c.totalTokens ?? c.projectedTotalTokens), rating: null, ratingCount: null,
    chats: metric(c.stats?.chat ?? c.chatCount), messages: metric(c.stats?.message ?? c.messageCount),
    nsfw: c.isNsfw === true || c.is_nsfw === true,
    avatar: safeAvatar(c.avatar) || (typeof c.avatar === "string" && /^[\w.-]+$/.test(c.avatar) ? "https://ella.janitorai.com/bot-avatars/" + c.avatar : null),
    maxRes: safeAvatar(c.avatarVariantUrls?.hero || c.avatar_variant_urls?.hero), createdAt: c.createdAt || c.created_at || null,
  }));
  return { status: 200, json: { source: "datacat", count: total, page: req.stash.page, first: req.stash.first, results: listings } };
}
