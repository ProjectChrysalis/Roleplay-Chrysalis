import { importEmbeddedBook, normalizeBook } from "./books.js";
import { embeddedBookToWorld, normalizeCard, resolveCardAssets } from "./cards.js";
import { BROWSER_UA, datacatRoute } from "./catalogs/datacat.js";
import { previewLorebook } from "./catalogs/shared.js";
import { tavernRoute } from "./catalogs/tavern.js";
import { wyvernRoute } from "./catalogs/wyvern.js";
import { chatTime, normalizeChatLines } from "./chats.js";
import { cardFromPngBase64, entryBase64, normalizeEntryName, slug, unslugTitle } from "./entries.js";
import { quickReplySetFromForeign, themeFromForeign } from "./library.js";
import { storeMedia } from "./media.js";
import { b64ToBytes, cardText, extractCardFromPng } from "./png.js";
import { normalizePreset, restorePreset } from "./presets.js";
import { normalizeRegex, regexSignature } from "./regex.js";

/** Group settings a foreign group file spells numerically. */
const GROUP_ACTIVATION = { 0: "natural", 1: "list", 2: "manual", 3: "natural" };
const GROUP_GENERATION = { 0: "swap", 1: "append", 2: "append" };

/** The host as guest objects whose functions call the host's without a
 *  receiver. On engines that hand the plugin host objects directly, each
 *  method call (host.fs.read(...)) serialized its object again: about a
 *  millisecond a call, which a route reading thousands of files paid in full. */
function ownHost(v, depth = 0) {
  if (typeof v === "function") return (...args) => v(...args);
  if (v === null || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => ownHost(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = ownHost(v[k], depth + 1);
  return o;
}

/** One answer per lookup key per call. A group chat asks for the same few
 *  names on every message, and each ask is a host call and a file read. Only
 *  this import writes its tables, one call at a time. */
function memoLookups(fsx) {
  if (!fsx?.lookup) return fsx;
  const seen = new Map();
  const lookup = fsx.lookup;
  return {
    ...fsx,
    lookup: (collection, key, value) => {
      const k = collection + "\n" + String(key).toLowerCase();
      if (value !== undefined) { const out = lookup(collection, key, value); seen.set(k, out); return out; }
      if (!seen.has(k)) seen.set(k, lookup(collection, key));
      return seen.get(k);
    },
  };
}

export function handleRoute(req, host) {
  host = ownHost(host);
  if (req.method !== "POST") return null;
  if (["/marketplace/search", "/marketplace/detail", "/marketplace/import"].includes(req.path) && req.body?.source === "tavern") return tavernRoute(req, host);
  if (["/marketplace/search", "/marketplace/detail", "/marketplace/import"].includes(req.path) && req.body?.source === "wyvern") return wyvernRoute(req, host);
  if (req.path.startsWith("/marketplace/") && req.body?.source === "datacat" && ["/marketplace/search", "/marketplace/detail", "/marketplace/tags", "/marketplace/import"].includes(req.path)) return datacatRoute(req, host);
  if (req.path !== "/import/embedded-lorebook" && req.path !== "/import/batch" && req.path !== "/import/zip" && req.path !== "/import/url" && req.path !== "/import/finish" && req.path !== "/marketplace/search" && req.path !== "/marketplace/detail") return null;
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
        lorebook: previewLorebook(book),
        lorebookEntries: bookEntries,
      },
    };
  }

  const fsx = memoLookups(host.fs);
  // Walking a record for inline images cost more than writing it, and by now
  // they are rare: archive art goes through host.zip.image on the way in.
  const writeJson = (rel, v) => {
    const text = JSON.stringify(v, null, 2);
    const walk = text.includes('"data:image/') || (v?.studio?.avatar !== undefined && v.studio.avatar === v.avatar);
    fsx.write(rel, (walk ? JSON.stringify(storeMedia(v, fsx), null, 2) : text) + "\n");
  };
  const readJson = (rel, fb) => { try { return JSON.parse(fsx.read(rel)); } catch { return fb; } };
  const summary = { characters: [], groups: [], lorebooks: [], presets: [], regex: [], personas: [], themes: [], quickReplies: [], chats: [], databank: [], errors: [] };
  let characterNames = null;
  let written = null;
  const localLookups = {};
  const used = new Set();
  // A card's name by id, null when there is none. Chats and group members ask
  // for the same few cards over and over, and a card carrying a large
  // lorebook is slow to read.
  const cardNames = new Map();
  const cardName = (id) => {
    if (!cardNames.has(id)) cardNames.set(id, readJson("characters/" + id + "/card.json", null)?.name ?? null);
    return cardNames.get(id);
  };
  // Id collision guard: dedupes within THIS import batch AND against what
  // already exists on disk — re-importing the same card must never silently
  // overwrite the earlier one (its gallery/edits would be lost).
  // One listing per folder per call: a library holding fifty scripts of one
  // name made every new copy read fifty files to find a free id.
  const listed = new Map();
  const listedIn = (dir) => {
    if (!listed.has(dir)) { let names = []; try { names = fsx.list(dir); } catch {} listed.set(dir, new Set(names)); }
    return listed.get(dir);
  };
  const uid = (base, dir) => {
    let id = base, n = 2;
    const hit = (x) => used.has(x) || (dir && (() => { const names = listedIn(dir); return names.has(x) || names.has(x + ".json") || names.has(x + ".meta.json"); })());
    while (hit(id)) id = base + "-" + n++;
    used.add(id);
    return id;
  };

  // Presets and cards carry the same script packs, and every import of one
  // used to add another copy. A script that does what one on disk already
  // does, everywhere or in the same place, is not written again.
  let regexKnown = null;
  const regexKey = (scope, target, script) => scope + "|" + (target || "") + "|" + regexSignature(script);
  // An archive import indexes the library's scripts once; reading them all
  // again in every batch grew with each card that brought scripts.
  const regexIndex = /^[a-f0-9-]{36}$/.test(String(req.body?.importId || "")) && fsx.lookup ? req.body.importId + "_regex" : null;
  const regexDuplicate = (scope, target, script) => {
    if (regexIndex) {
      if (!fsx.lookup(regexIndex, "indexed")) {
        let files = [];
        try { files = fsx.list("regex").filter((f) => f.endsWith(".json")); } catch {}
        for (const f of files) {
          const one = readJson("regex/" + f, null);
          if (one) fsx.lookup(regexIndex, regexKey(one.scope || "global", one.scopeTargetId, one), 1);
        }
        fsx.lookup(regexIndex, "indexed", 1);
      }
      const key = regexKey(scope, target, script);
      if (fsx.lookup(regexIndex, regexKey("global", null, script)) || fsx.lookup(regexIndex, key)) return true;
      fsx.lookup(regexIndex, key, 1);
      return false;
    }
    if (!regexKnown) {
      regexKnown = new Set();
      let files = [];
      try { files = fsx.list("regex").filter((f) => f.endsWith(".json")); } catch {}
      for (const f of files) {
        const one = readJson("regex/" + f, null);
        if (one) regexKnown.add(regexKey(one.scope || "global", one.scopeTargetId, one));
      }
    }
    if (regexKnown.has(regexKey("global", null, script))) return true;
    const key = regexKey(scope, target, script);
    if (regexKnown.has(key)) return true;
    regexKnown.add(key);
    return false;
  };
  // A preset is known by its name: importing one named like a preset that
  // was here before the import replaces it in place, the way a newer copy of
  // it arrives. The app's own default preset is never replaced.
  let presetIds = null;
  const presetNamed = (name) => {
    if (!presetIds) {
      presetIds = new Map();
      let files = [];
      try { files = fsx.list("presets").filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch {}
      for (const f of files) {
        const id = f.slice(0, -5);
        const one = id === "default" ? null : readJson("presets/" + f, null);
        if (one && typeof one.name === "string" && !presetIds.has(lower(one.name))) presetIds.set(lower(one.name), id);
      }
    }
    return presetIds.get(lower(name)) || null;
  };

  if (req.path === "/import/embedded-lorebook") {
    const id = String(req.body?.characterId || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { status: 400, json: { error: "Invalid character ID" } };
    const card = readJson("characters/" + id + "/card.json", null);
    if (!card) return { status: 404, json: { error: "Character not found" } };
    if (req.body?.import !== false && !card.studio?.embeddedLorebookId) {
      if (!card.character_book || !embeddedBookToWorld(card.character_book)) return { status: 400, json: { error: "No embedded lorebook entries" } };
      importEmbeddedBook(card, card.character_book, writeJson, uid, summary);
    }
    card.studio = { ...card.studio, embeddedLorebookPending: false };
    writeJson("characters/" + id + "/card.json", card);
    return { status: 200, json: { lorebookId: card.studio.embeddedLorebookId || null } };
  }

  // Page link → character detail JSON + the embedded-card PNG from the CDN
  // (both two-phase host.net fetches, no credentials, manifest allowlist
  // enforced host-side). The PNG card wins (full fidelity incl. v3); the
  // detail JSON is the fallback and fills any missing fields.
  if (req.path === "/import/url") {

    const url = String((req.body && req.body.url) || "");
    if (!url.startsWith("https://")) return { status: 400, json: { error: "https URL required" } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    const UA = BROWSER_UA;
    const page = /^https:\/\/(?:www\.)?(?:chub\.ai|characterhub\.(?:ai|org))\/characters\/([^/\s?#]+)\/([^/\s?#]+)\/?(?:[?#].*)?$/.exec(url)
      || /^https:\/\/api\.chub\.ai\/api\/characters\/([^/\s?#]+)\/([^/\s?#]+)\/?(?:[?#].*)?$/.exec(url);
    if (!page) {
      const tavern = /^https:\/\/character-tavern\.com\/character\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?(?:[?#].*)?$/.exec(url);
      if (tavern) return tavernRoute({ ...req, path: "/marketplace/import", body: { ...req.body, source: "tavern", id: tavern[1] } }, host);
      const wyvern = /^https:\/\/(?:app\.)?wyvern\.chat\/(?:characters|character)\/([a-zA-Z0-9_-]{6,100})\/?(?:[?#].*)?$/.exec(url);
      if (wyvern) return wyvernRoute({ ...req, path: "/marketplace/import", body: { ...req.body, source: "wyvern", id: wyvern[1] } }, host);
      const catalog = /^https:\/\/(?:www\.)?pygmalion\.chat\/[^?#]*?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[/?#]|$)/i.exec(url);
      const realm = /^https:\/\/realm\.risuai\.net\/character\/([a-f0-9-]+)\/?(?:[?#].*)?$/i.exec(url);
      const image = /^https:\/\/(?:www\.)?aicharactercards\.com\/(?:[^/?#]+\/)*([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(url);
      const spec = catalog ? { url: "https://server.pygmalion.chat/api/export/character/" + catalog[1] + "/v2", json: true }
        : realm ? { url: "https://realm.risuai.net/api/v1/download/png-v3/" + realm[1] + "?non_commercial=true", binary: true }
        : image ? { url: "https://aicharactercards.com/wp-json/pngapi/v1/image/" + encodeURIComponent(image[1]) + "/" + encodeURIComponent(image[2]), binary: true } : null;
      if (spec) {
        if (!host.net.results.card) {
          host.net.request("card", { ...spec, maxBytes: 16 * 1024 * 1024, headers: { "user-agent": UA } });
          return { __llmPending: true };
        }
        const result = host.net.results.card;
        if (!result.ok) return { status: 502, json: { error: "card download failed: " + (result.status || result.error || "unknown error") } };
        const raw = spec.binary ? cardFromPngBase64(result.base64 || "") : result.json?.character;
        const n = normalizeCard(raw);
        if (!n) return { status: 502, json: { error: "the source did not return a recognizable card" } };
        const avatar = spec.binary && result.base64 ? "data:image/png;base64," + result.base64 : raw?.data?.avatar;
        if (typeof avatar === "string" && /^(?:data:image\/|https:\/\/)/.test(avatar)) n.avatar = avatar;
        writeCardWithBook(n, raw, null, spec.binary && result.base64 ? "data:image/png;base64," + result.base64 : n.avatar);
        return { status: 200, json: { ...summary, name: n.name } };
      }
      if (/^https:\/\/[^/]*chub\.ai|^https:\/\/[^/]*characterhub\.(?:ai|org)/.test(url)) {
        return { status: 400, json: { error: "Use https://chub.ai/characters/<user>/<name>" } };
      }
      return { status: 400, json: { error: "Unsupported card URL. Use a supported source or import a PNG or JSON file." } };
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
    written = id;
    if (req.body?.importId && fsx.lookup) { fsx.lookup(req.body.importId + "_characters", String(card.name).toLowerCase(), id); fsx.lookup(req.body.importId + "_characters", slug(card.name), id); }
    if (!characterNames) characterNames = new Map();
    characterNames.set(String(card.name).toLowerCase(), id);
    characterNames.set(slug(card.name), id);
    // a card can name the world book it uses; the book may arrive later
    const world = card.extensions && typeof card.extensions.world === "string" ? card.extensions.world.trim() : "";
    if (world) addBookLink("worldLinks", world, id);
    // regex scripts a card carries run for that character only
    const embedded = card.extensions && Array.isArray(card.extensions.regex_scripts) ? card.extensions.regex_scripts : [];
    // scripts on in the source, which the source's settings may allow
    const enabled = [];
    embedded.forEach((raw, i) => {
      const n = normalizeRegex(raw);
      if (!n) return;
      if (regexDuplicate("character", id, n)) return;
      const rid = uid(slug(n.scriptName), "regex");
      writeJson("regex/" + rid + ".json", { ...n, id: rid, disabled: n.disabled || req.body?.enableEmbeddedRegex !== true, scope: "character", scopeTargetId: id, order: i });
      summary.regex.push(rid);
      if (!n.disabled) enabled.push(rid);
    });
    if (enabled.length && req.path === "/import/zip") carried("cardRegex").set(id, enabled);
  }
  /** A name map that outlives the batch on an archive import (what it links
   *  to may arrive in a later one). Hoisted with writeCard. */
  function carried(collection) {
    const id = String(req.body?.importId || "");
    if (/^[a-f0-9-]{36}$/.test(id) && fsx.lookup) return { get: (key) => fsx.lookup(id + "_" + collection, key), set: (key, value) => fsx.lookup(id + "_" + collection, key, value) };
    return (localLookups[collection] ??= new Map());
  }
  /** World book name → the cards that name it. */
  const worldLinks = () => carried("worldLinks");
  /** Book name → cards waiting for it, as a linked book or as their own
   *  embedded one ("embeddedLinks"). */
  function addBookLink(collection, bookName, cardId) {
    const key = String(bookName).trim().toLowerCase();
    const ids = [...(carried(collection).get(key) || []), cardId];
    while (JSON.stringify(ids).length > 4000) ids.shift();
    carried(collection).set(key, ids);
  }
  /** Cards may embed a lorebook — write it as a book file and link it via
   *  the card's studio bag so the app scopes it to that character. charx
   *  packages also carry assets: the icon/main avatar and emotion sprites
   *  resolve from the package bytes (assetDict) or inline data: URIs. */
  function writeCardWithBook(card, raw, assetDict, sourceAvatar, keepBookInCard = false) {
    if (!card) return null;
    const src = raw && raw.data && typeof raw.data === "object" && raw.data.character_book ? raw.data : raw;
    const book = src && src.character_book && typeof src.character_book === "object" ? src.character_book : null;
    if (keepBookInCard) {
      // a library's active books are its world files, which arrive on their
      // own; the copy inside the card stays there, importable later
      if (book) card.character_book = book;
      card.studio = { ...card.studio, embeddedLorebookId: null, embeddedLorebookPending: false };
    } else if (book && embeddedBookToWorld(book) && req.body?.deferEmbeddedLore === true) {
      card.character_book = book;
      card.studio = { ...card.studio, embeddedLorebookId: null, embeddedLorebookPending: true };
    } else if (book) importEmbeddedBook(card, book, writeJson, uid, summary);
    if (Array.isArray(card.assets)) {
      const resolved = resolveCardAssets(card, assetDict || {}, sourceAvatar || null);
      if (resolved.avatar) card.avatar = resolved.avatar;
      if (resolved.expressions.length) {
        card.studio = { ...card.studio, expressions: resolved.expressions };
      }
    }
    writeCard(card);
    return written;
  }
  // Ids are re-minted on the way in, so anything that pointed at an id in the
  // backup has to be re-pointed by NAME. These record what each name became.
  const importId = /^[a-f0-9-]{36}$/.test(String(req.body?.importId || "")) ? req.body.importId : null;
  const lookup = (collection) => importId && fsx.lookup ? { get: (key) => fsx.lookup(importId + "_" + collection, key), set: (key, value) => fsx.lookup(importId + "_" + collection, key, value) } : new Map();
  const bookIdByName = lookup("books");
  const presetIdByName = lookup("presets");
  const personaIdByName = lookup("personas");
  const groupIdByName = lookup("groups");
  const personaIdByFile = lookup("personaFiles");
  const qrVisible = lookup("quickReplies");
  /** What the run asked for: collections left out of `include` are not
   *  imported from settings.json either. */
  const wants = (collection) => !Array.isArray(req.body?.include) || req.body.include.includes(collection);

  // A name this import has not written may be a card already in the library
  // (chats imported in a later run than their cards): the library's names are
  // read once per import, on the first miss.
  let importNames = null;
  const charIdByName = () => {
    if (importId && fsx.lookup) {
      if (importNames) return importNames;
      const own = lookup("characters");
      const library = lookup("library");
      const indexLibrary = () => {
        if (library.get("__indexed")) return;
        let ids = [];
        try { ids = fsx.list("characters"); } catch {}
        for (const cid of ids) {
          const card = readJson("characters/" + cid + "/card.json", null);
          if (!card || !card.name) continue;
          if (!library.get(lower(card.name))) library.set(lower(card.name), cid);
          if (!library.get(slug(card.name))) library.set(slug(card.name), cid);
        }
        library.set("__indexed", 1);
      };
      importNames = {
        get: (key) => { const hit = own.get(key); if (hit || String(key).startsWith("file:")) return hit; indexLibrary(); return library.get(key); },
        set: (key, value) => own.set(key, value),
      };
      return importNames;
    }
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
    const waiting = (collection) => carried(collection).get(lower(n.name || fallback)) || (fallback ? carried(collection).get(lower(fallback)) : null) || [];
    const linked = waiting("worldLinks");
    if (!extra.linkedCharacterIds && linked.length) extra.linkedCharacterIds = linked;
    writeJson("lorebooks/" + id + ".json", { ...n, ...extra, id });
    // a chat reads a card's books from the card, so the link lives there
    for (const [cid, field] of [...linked.map((c) => [c, "linked"]), ...waiting("embeddedLinks").map((c) => [c, "embedded"])]) {
      const card = readJson("characters/" + cid + "/card.json", null);
      if (!card) continue;
      const studio = { ...card.studio };
      if (field === "embedded") studio.embeddedLorebookId = id;
      else if (!(studio.linkedLorebookIds || []).includes(id)) studio.linkedLorebookIds = [...(studio.linkedLorebookIds || []), id];
      writeJson("characters/" + cid + "/card.json", { ...card, studio });
    }
    bookIdByName.set(lower(n.name || fallback), id);
    summary.lorebooks.push(id);
  };
  const writePreset = (n) => {
    if (!n) return;
    // a second preset of the same name in one import is its own preset
    const existing = presetIdByName.get(lower(n.name)) ? null : presetNamed(n.name);
    const id = existing || uid(slug(n.name || "preset"), "presets");
    const kept = existing ? readJson("presets/" + id + ".json", {}) : {};
    writeJson("presets/" + id + ".json", { ...n, ...(kept.folderId ? { folderId: kept.folderId } : {}), id });
    presetIds.set(lower(n.name), id);
    presetIdByName.set(lower(n.name), id);
    summary.presets.push(id);
    const embedded = Array.isArray(n.extensions?.regex_scripts) ? n.extensions.regex_scripts : [];
    embedded.forEach((raw, order) => {
      const script = normalizeRegex(raw);
      if (!script || regexDuplicate("preset", id, script)) return;
      const rid = uid(slug(script.scriptName), "regex");
      writeJson("regex/" + rid + ".json", { ...script, id: rid, disabled: script.disabled || req.body?.enableEmbeddedRegex !== true, scope: "preset", scopeTargetId: id, order });
      summary.regex.push(rid);
    });
  };
  const writeRegex = (n) => {
    if (!n) return;
    const { _studioScope: saved, ...script } = n;
    const scope = saved && ["global", "character", "preset", "chat"].includes(saved.scope) ? saved.scope : "global";
    const target = scope === "character" ? charIdByName().get(lower(saved.targetName))
      : scope === "preset" ? presetIdByName.get(lower(saved.targetName)) : null;
    // a chat's script waits for its chat's new id, so it has no target to match yet
    if (scope !== "chat" && regexDuplicate(scope, target, script)) return;
    const id = uid(slug(n.scriptName), "regex");
    writeJson("regex/" + id + ".json", { ...script, id, scope, scopeTargetId: target || null, order: saved?.order ?? 0,
      ...(scope === "chat" && saved?.chatId ? { _restoreChatId: saved.chatId, _restoreImportId: importId } : {}) });
    summary.regex.push(id);
  };
  /** A persona from a backup. `full` is the complete record when the zip
   *  carried one — the flat {name: description} map foreign tools write is
   *  all most backups have, and rebuilding from it alone is what dropped the
   *  avatar, title, pronouns, bound cards, linked books and default flag. */
  /** Returns the persona's id. */
  const writePersona = (name, description, full) => {
    if (!name) return null;
    // the same persona imported again (name and description match one here)
    // stays one persona; chats that name it link to the one already here
    for (let n = 1, base = slug(name); n < 50; n++) {
      const here = readJson("personas/" + (n === 1 ? base : base + "-" + n) + ".json", null);
      if (!here) break;
      const hereId = n === 1 ? base : base + "-" + n;
      if (here.name === name && (here.description || "") === (description || "")) { personaIdByName.set(lower(name), hereId); return hereId; }
    }
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
      if (Array.isArray(full._boundIds) && full._boundIds.length) {
        rest.boundCharacterIds = full._boundIds;
        rest.binding = "character";
      }
    }
    writeJson("personas/" + id + ".json", { ...rest, id, name, description: description || "" });
    personaIdByName.set(lower(name), id);
    summary.personas.push(id);
    return id;
  };
  /** `saved` is the chat's own meta when the backup carried one: everything
   *  ABOUT the conversation (its preset, persona, model, author's note,
   *  summary, memory cutoff, folder, tags, card variant, branch parentage).
   *  Without it every restored chat landed on the default preset and no
   *  persona, which is exactly what a move to a second device looked like. */
  const AN_POSITION = { 0: "after-system", 1: "in-chat", 2: "before-system" };
  const AN_ROLE = { 0: "system", 1: "user", 2: "assistant" };
  let currentUserName = null;
  /** `streamed` is a transcript already appended to chats/<id>.jsonl a slice
   *  at a time: {id, count, first, last, hasUser}. */
  const writeChat = (n, characterId, groupId, saved, streamed = null) => {
    const id = streamed ? streamed.id : uid(slug(n.title), "chats");
    const first = streamed ? streamed.first : n.msgs[0];
    const last = streamed ? streamed.last : n.msgs[n.msgs.length - 1];
    // unlocked, like a chat made in the app: it follows the current preset
    // and persona, and starts under the current persona's name
    if (currentUserName === null) {
      const personaId = readJson("settings.json", {}).personaId || null;
      const persona = personaId ? readJson("personas/" + personaId + ".json", null) : null;
      currentUserName = (persona && persona.name) || "User";
    }
    const meta = {
      id, title: n.title, characterId: characterId || null, groupId: groupId || null,
      presetId: null, personaId: null, model: null, userName: currentUserName,
      authorNote: null, lorebookIds: [], createdAt: Date.now(), updatedAt: Date.now(), tainted: true,
    };
    if (saved && typeof saved === "object") {
      // ids are re-minted on import; carry the rest of the meta straight over
      const SKIP = new Set(["id", "characterId", "groupId", "presetId", "personaId", "lorebookIds", "chatLorebookIds"]);
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
        const p = saved.personaLocked === true ? readJson("personas/" + wantPersona + ".json", null) : null;
        if (p && p.name) meta.userName = p.name;
      }
      if (Array.isArray(saved._lorebookNames)) {
        meta.lorebookIds = saved._lorebookNames.map((nm) => bookIdByName.get(lower(nm))).filter(Boolean);
      }
      meta.chatLorebookIds = Array.isArray(saved._chatLorebookNames)
        ? saved._chatLorebookNames.map((nm) => bookIdByName.get(lower(nm))).filter(Boolean) : [];
      // branch parentage points at chat ids from the other machine; the
      // restored chats are new files, so a stale parent would render a
      // branch tree that leads nowhere
      delete meta.parentChatId;
      delete meta.parentMessageId;
      meta.id = id;
      meta.characterId = characterId || null;
      meta.groupId = groupId || null;
    } else if (n.header && typeof n.header === "object") {
      // a foreign transcript's first line: who the user was, a persona
      // locked to the chat, the author's note and the chat's own book
      const cm = n.header.chat_metadata && typeof n.header.chat_metadata === "object" ? n.header.chat_metadata : {};
      const locked = typeof cm.persona === "string" && cm.persona ? personaIdByFile.get(lower(cm.persona)) : null;
      if (locked) { meta.personaId = locked; meta.personaLocked = true; }
      const named = locked ? readJson("personas/" + locked + ".json", null)?.name : typeof n.header.user_name === "string" && n.header.user_name ? n.header.user_name : null;
      if (named) meta.userName = named;
      if (typeof cm.note_prompt === "string" && cm.note_prompt.trim()) {
        meta.authorNote = cm.note_prompt;
        meta.authorNoteObject = {
          text: cm.note_prompt, position: AN_POSITION[cm.note_position] || "in-chat",
          depth: Number.isInteger(cm.note_depth) && cm.note_depth >= 0 ? cm.note_depth : 4,
          role: AN_ROLE[cm.note_role] || "system",
          frequency: Number.isInteger(cm.note_interval) && cm.note_interval >= 0 ? cm.note_interval : 1,
          includeInWIScan: false,
        };
      }
      const book = typeof cm.world_info === "string" && cm.world_info ? bookIdByName.get(lower(cm.world_info)) : null;
      if (book) meta.chatLorebookIds = [book];
      const started = chatTime(n.header.create_date) ?? first?.at;
      if (typeof started === "number") meta.createdAt = started;
      const latest = last?.at;
      if (typeof latest === "number") meta.updatedAt = latest;
    }
    if (!streamed) fsx.write("chats/" + id + ".jsonl", n.msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    // what the chat list shows, so it never has to read the transcript
    meta.listing = {
      messageCount: streamed ? streamed.count : n.msgs.length,
      preview: last ? String(last.text || "").slice(0, 160) : "",
      hasUser: streamed ? streamed.hasUser : n.msgs.some((m) => m && m.role === "user"),
    };
    writeJson("chats/" + id + ".meta.json", meta);
    if (Array.isArray(n.memories) && n.memories.length) {
      writeJson("chats/" + id + ".memories.json", n.memories);
    }
    summary.chats.push(id);
    if (saved?.id && fsx.list(".").includes("regex")) {
      for (const file of fsx.list("regex").filter((f) => f.endsWith(".json"))) {
        const script = readJson("regex/" + file, null);
        if (script?.scope !== "chat" || script._restoreChatId !== saved.id || script._restoreImportId !== importId) continue;
        delete script._restoreChatId;
        delete script._restoreImportId;
        writeJson("regex/" + file, { ...script, scopeTargetId: id });
      }
    }
    return id;
  };

  /** Themes and quick reply sets join the collections already there. A name
   *  that exists is left alone, so running an import twice adds nothing. */
  const mergeLibrary = (adds) => {
    if (!adds.themes.length && !adds.qrSets.length) return;
    const lib = readJson("library.json", {});
    for (const key of ["themes", "qrSets"]) {
      const current = Array.isArray(lib[key]) ? lib[key] : [];
      const fresh = adds[key].filter((item, i, all) => !current.some((c) => lower(c?.name) === lower(item.name)) && all.findIndex((x) => lower(x.name) === lower(item.name)) === i);
      lib[key] = [...current, ...fresh];
      summary[key === "themes" ? "themes" : "quickReplies"].push(...fresh.map((item) => item.id));
    }
    writeJson("library.json", lib);
  };

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
    try { mergeLibrary({ themes: (b.themes || []).map(themeFromForeign).filter(Boolean), qrSets: (b.quickReplies || []).map((set) => quickReplySetFromForeign(set, true)).filter(Boolean) }); }
    catch { summary.errors.push("themes failed"); }
    for (const c of b.chats || []) {
      try {
        const n = normalizeChatLines(c);
        if (!n) continue;
        // the caller's character id when it names one: matching the name
        // reads every card in the library, too slow for a large one
        const own = typeof c.characterId === "string" && /^[a-zA-Z0-9_-]+$/.test(c.characterId) && readJson("characters/" + c.characterId + "/card.json", null) ? c.characterId : null;
        writeChat(n, own || (c.character && charIdByName().get(lower(c.character))) || null);
      } catch { summary.errors.push("chat failed"); }
    }
    return { status: 200, json: summary };
  }

  if (req.path === "/import/finish") {
    const id = String(req.body?.importId || "");
    if (!/^[a-f0-9-]{36}$/.test(id)) return { status: 400, json: { error: "invalid import id" } };
    for (const collection of ["characters", "library", "books", "presets", "personas", "groups", "personaFiles", "quickReplies", "worldLinks", "embeddedLinks", "cardRegex", "regex"]) fsx.remove("__lookup/" + id + "_" + collection);
    return { status: 200, json: { ok: true } };
  }

  if (req.path === "/import/zip") {
    const rawEntries = host.zip.entries();
    const libraryAdds = { themes: [], qrSets: [] };
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
    // A transcript is read a line at a time further down; any other large
    // text (a lorebook, settings) has to be parsed whole, so its slices are
    // joined back together here.
    for (const name of Object.keys(entries)) {
      if (entries[name]?.__large__ !== true || name.endsWith(".jsonl") || !host.zip.read) continue;
      try {
        const parts = [];
        for (let next = 0; next !== null;) {
          const slice = host.zip.read(originalNames[name], next, 64 * 1024 * 1024);
          parts.push(slice.text);
          next = slice.next;
        }
        entries[name] = parts.join("");
      } catch (error) {
        summary.errors.push(name + ": " + String(error?.message || error));
        delete entries[name];
      }
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
    // Order matters: a chat resolves its character, group, preset, persona
    // and books by NAME, and a persona resolves its books and bound cards the
    // same way. One pass in whatever order the zip's central directory
    // happened to list things left half of those unresolved.
    const PHASES = ["characters/", "worlds/", "lorebooks/", "presets/", "openai settings/", "textgen settings/", "instruct/", "extensions/regex/", "regex/", "user settings/regex/", "settings.json", "personas/", "user avatars/", "groups/", "chats/", "group chats/", "databank/"];
    const phaseOf = (n) => {
      const l = n.toLowerCase();
      for (let i = 0; i < PHASES.length; i++) if (l.startsWith(PHASES[i])) return i;
      return PHASES.length;
    };
    // a folder's own files before its subfolders: cards before sprite sets
    const depth = (n) => n.split("/").length;
    const orderedNames = Object.keys(entries).sort((a, b) => phaseOf(a) - phaseOf(b) || depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
    // A card's sprites collect here and the card is written once: a card
    // carrying a large lorebook, rewritten for every picture of a big sprite
    // set, ran a batch past the plugin's time limit.
    const spriteCards = new Map();
    const writeSprites = () => {
      for (const target of spriteCards.values()) {
        if (!target) continue;
        try {
          target.card.studio = { ...target.card.studio, expressions: [...target.expressions.values()] };
          writeJson("characters/" + target.id + "/card.json", target.card);
        } catch (error) { summary.errors.push("sprites failed: " + target.id + ": " + String(error.message || error)); }
      }
      spriteCards.clear();
    };
    const SPRITE = /^characters\/([^/]+)\/([^/]+)\.(?:png|webp|gif|jpe?g)$/i;
    for (const name of orderedNames) {
      // later entries may rewrite the same cards (a book linking to one)
      if (spriteCards.size && !SPRITE.test(name)) writeSprites();
      if (entries[name]?.error) { summary.errors.push(name + ": " + entries[name].error); continue; }
      // A foreign tool keeps its personas, global regex scripts and the quick
      // reply sets on show in its settings file. It runs in order: personas
      // link books and cards, chats link personas. The avatar file is how a
      // persona's picture finds it later in the import.
      if (name === "settings.json" && isText(entries[name])) {
        let st = null;
        try { st = JSON.parse(entries[name]); } catch { summary.errors.push("settings failed: settings.json"); }
        const pu = st && typeof st.power_user === "object" && st.power_user ? st.power_user : st;
        if (pu && !hasFullPersonas && wants("personas/")) {
          try {
            const descs = typeof pu.persona_descriptions === "object" && pu.persona_descriptions ? pu.persona_descriptions : {};
            const namesMap = typeof pu.personas === "object" && pu.personas ? pu.personas : null;
            for (const [avatarKey, pname] of Object.entries(namesMap ?? {})) {
              const d = descs[avatarKey] && typeof descs[avatarKey] === "object" ? descs[avatarKey] : {};
              // connections name cards by file
              const bound = (Array.isArray(d.connections) ? d.connections : [])
                .filter((c) => c && c.type === "character" && typeof c.id === "string")
                .map((c) => charIdByName().get("file:" + lower(c.id.replace(/\.png$/i, ""))))
                .filter(Boolean);
              const pid = writePersona(String(pname || avatarKey), String(d.description || ""), {
                ...(bound.length ? { _boundIds: bound } : {}),
                ...(typeof d.title === "string" && d.title ? { title: d.title } : {}),
                ...(pu.default_persona === avatarKey ? { isDefault: true } : {}),
                ...(typeof d.lorebook === "string" && d.lorebook ? { _lorebookNames: [d.lorebook] } : {}),
              });
              if (pid) personaIdByFile.set(lower(avatarKey), pid);
            }
          } catch { summary.errors.push("personas failed: settings.json"); }
        }
        const ext = st && typeof st.extension_settings === "object" ? st.extension_settings : null;
        if (ext) {
          try {
            if (wants("regex/") && Array.isArray(ext.regex)) for (const one of ext.regex) writeRegex(normalizeRegex(one));
            // a card's own scripts run there only for cards the user allowed
            for (const file of Array.isArray(ext.character_allowed_regex) ? ext.character_allowed_regex : []) {
              const cid = typeof file === "string" ? charIdByName().get("file:" + lower(file.replace(/\.png$/i, ""))) : null;
              for (const rid of (cid && carried("cardRegex").get(cid)) || []) {
                const script = readJson("regex/" + rid + ".json", null);
                if (script) writeJson("regex/" + rid + ".json", { ...script, disabled: false });
              }
            }
            const shown = ext.quickReplyV2?.config?.setList;
            if (Array.isArray(shown)) {
              qrVisible.set("__listed", true);
              for (const item of shown) if (item && typeof item.set === "string" && item.isVisible !== false) qrVisible.set(lower(item.set), true);
            }
          } catch { summary.errors.push("settings failed: settings.json"); }
        }
        continue;
      }
      // characters/<card name>/<expression>.png is that card's sprite set
      const sprite = SPRITE.exec(name);
      if (sprite) {
        try {
          const folder = lower(sprite[1]);
          if (!spriteCards.has(folder)) {
            const id = charIdByName().get(folder) || charIdByName().get("file:" + folder);
            const card = id ? readJson("characters/" + id + "/card.json", null) : null;
            spriteCards.set(folder, card ? { id, card, expressions: new Map((card.studio?.expressions || []).filter(Boolean).map((e) => [e.name, e])) } : null);
          }
          const target = spriteCards.get(folder);
          const url = !target ? null : entries[name]?.__image__ && host.zip.image ? host.zip.image(originalNames[name]).url
            : entryBase64(entries[name]) ? "data:image/" + (/\.webp$/i.test(name) ? "webp" : /\.gif$/i.test(name) ? "gif" : /\.jpe?g$/i.test(name) ? "jpeg" : "png") + ";base64," + entryBase64(entries[name]) : null;
          if (url) { target.expressions.delete(sprite[2]); target.expressions.set(sprite[2], { name: sprite[2], url }); }
        } catch (error) { summary.errors.push("sprite failed: " + name + ": " + String(error.message || error)); }
        continue;
      }
      // A card PNG lives in characters/, or loose at the root when someone
      // zipped a pile of cards. Anywhere else (persona and user avatars,
      // backgrounds, sprites) a .png is just a picture — reading it as a
      // failed card would bury the real errors in noise.
      if (name.endsWith(".png") && (name.startsWith("characters/") || !name.includes("/"))) {
        // chat folders and group member lists name a card by its file
        const fileKey = "file:" + lower(name.split("/").pop().replace(/\.png$/i, ""));
        const remember = (id) => { if (id) charIdByName().set(fileKey, id); };
        if (entries[name]?.__image__ && host.zip.image) {
          try {
            const image = host.zip.image(originalNames[name]);
            let rawCard = null;
            for (const key of ["ccv3", "chara"]) {
              const payload = image.metadata[key];
              if (!payload) continue;
              try { rawCard = JSON.parse(cardText(payload, image.text?.[key])); break; } catch { /* try the next metadata field */ }
            }
            const card = rawCard && normalizeCard(rawCard);
            if (card) { card.avatar = image.url; remember(writeCardWithBook(card, rawCard, null, image.url, true)); }
            else if (name.startsWith("characters/")) summary.errors.push("png card without embedded data: " + name);
          } catch (error) { summary.errors.push("png card failed: " + name + ": " + String(error.message || error)); }
          continue;
        }
        const b64 = entryBase64(entries[name]);
        if (b64) {
          const rawCard = cardFromPngBase64(b64);
          const n = rawCard && normalizeCard(rawCard);
          // ccdefault: assets point at the card PNG itself
          if (n) { n.avatar = "data:image/png;base64," + b64; remember(writeCardWithBook(n, rawCard, null, n.avatar, true)); }
          else if (name.startsWith("characters/")) summary.errors.push("png card without embedded data: " + name);
        } else if (name.startsWith("characters/")) {
          summary.errors.push("png card too large to read from the zip — import it directly from the Import button: " + name);
        }
        continue;
      }
      if (name.startsWith("characters/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const parsed = JSON.parse(entries[name]);
          // our backups carry the portrait inline, and name chat folders and
          // group members by this file
          const art = typeof parsed.avatar === "string" ? parsed.avatar : typeof parsed.data?.avatar === "string" ? parsed.data.avatar : undefined;
          const n = normalizeCard(parsed, art);
          // book links are ids from the other install; they come back by name
          // when the books arrive
          const books = parsed._lorebookNames && typeof parsed._lorebookNames === "object" ? parsed._lorebookNames : null;
          if (n) { delete n._lorebookNames; n.studio = { ...n.studio, linkedLorebookIds: [] }; }
          const id = n ? writeCardWithBook(n, parsed, null, art, true) : null;
          if (id) charIdByName().set("file:" + lower(name.split("/").pop().replace(/\.json$/i, "")), id);
          if (id && books) {
            for (const book of Array.isArray(books.linked) ? books.linked : []) if (typeof book === "string") addBookLink("worldLinks", book, id);
            if (typeof books.embedded === "string" && books.embedded) addBookLink("embeddedLinks", books.embedded, id);
          }
        } catch (error) { summary.errors.push("card failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if ((name.startsWith("worlds/") || name.startsWith("lorebooks/")) && name.endsWith(".json") && isText(entries[name])) {
        try {
          const fallback = name.split("/").pop().replace(/\.json$/i, "");
          const raw = JSON.parse(entries[name]);
          writeBook(normalizeBook(raw, fallback), fallback, raw && raw._studio);
        } catch (error) { summary.errors.push("world failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      // A foreign tool files chat-completion and text-completion presets under
      // their own folders, one file per preset, named by the file.
      if (/^(?:openai|textgen) settings\//i.test(name) && name.endsWith(".json") && isText(entries[name])) {
        try {
          const n = restorePreset(JSON.parse(entries[name]), name.split("/").pop().replace(/\.json$/i, ""));
          if (n) writePreset(n);
        } catch (error) { summary.errors.push("preset failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if ((name.startsWith("regex/") || name.startsWith("User Settings/regex/")) && name.endsWith(".json") && isText(entries[name])) {
        try {
          const raw = JSON.parse(entries[name]);
          for (const one of Array.isArray(raw) ? raw : [raw]) writeRegex(normalizeRegex(one));
        } catch (error) { summary.errors.push("regex failed: " + name + ": " + String(error?.message || error)); }
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
        } catch (error) { summary.errors.push("databank failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if (name.startsWith("groups/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const g = JSON.parse(entries[name]);
          // characters were re-created under name-derived ids — remap each
          // member by original id first, then by the card file a foreign
          // group lists, then by the exported _memberNames
          const sourceMembers = g.memberIds || g.members || [];
          const resolvedMembers = sourceMembers.map((mid, i) => {
            if (cardName(mid)) return mid;
            const file = (g._memberFiles || [])[i] || String(mid).replace(/\.png$/i, "");
            const byFile = charIdByName().get("file:" + lower(file));
            if (byFile) return byFile;
            const nm = (g._memberNames || [])[i] || String(mid).replace(/\.png$/i, "");
            return nm ? charIdByName().get(lower(nm)) || charIdByName().get(slug(nm)) || null : null;
          });
          const memberIds = resolvedMembers.filter(Boolean);
          const muted = (g.mutedIds || g.disabled_members || []).map((mid) => { const index = sourceMembers.indexOf(mid); return index >= 0 ? resolvedMembers[index] : null; }).filter(Boolean);
          // a foreign group file carries its chat list and per-chat state;
          // the chats arrive as files of their own
          const { members: _m, disabled_members: _d, chats: groupChats, chat_id: _c, chat_metadata: _cm, past_metadata: _pm, activation_strategy: activation, generation_mode: generation, allow_self_responses: selfResponses, auto_mode_delay: delay, generation_mode_join_prefix: _jp, generation_mode_join_suffix: _js, ...rest } = g;
          for (const key of Object.keys(rest)) if (key.startsWith("_")) delete rest[key];
          // the id lands in the write path: slug it like every other collection
          // so a crafted backup cannot climb out of groups/
          const gid = uid(slug(g.name || g.id || "group"), "groups");
          writeJson("groups/" + gid + ".json", {
            ...rest, id: gid, name: g.name || gid, memberIds, mode: g.mode || GROUP_ACTIVATION[activation] || "natural", mutedIds: muted,
            ...(!g.generationMode && GROUP_GENERATION[generation] ? { generationMode: GROUP_GENERATION[generation] } : {}),
            ...(g.allowSelfResponses === undefined && typeof selfResponses === "boolean" ? { allowSelfResponses: selfResponses } : {}),
            ...(g.autoDelaySec === undefined && typeof delay === "number" && delay > 0 ? { autoDelaySec: delay } : {}),
          });
          for (const key of [g.name, g.id, g.chat_id, gid, ...(Array.isArray(groupChats) ? groupChats : [])]) if (key) { groupIdByName.set(lower(key), gid); groupIdByName.set(slug(key), gid); }
          summary.groups.push(gid);
        } catch (error) { summary.errors.push("group failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if (name.startsWith("extensions/regex/") && name.endsWith(".json") && isText(entries[name])) {
        try { writeRegex(normalizeRegex(JSON.parse(entries[name]))); } catch (error) { summary.errors.push("regex failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if (name === "personas.json" && isText(entries[name])) {
        // single-file personas map: { "persona name": { ... } }
        try {
          const map = JSON.parse(entries[name]);
          for (const [pname, p] of Object.entries(map || {})) {
            writePersona(pname, typeof p === "string" ? p : String((p && p.description) || (p && p.position !== undefined && p.text) || ""));
          }
        } catch (error) { summary.errors.push("personas failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if (name.startsWith("personas/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const p = JSON.parse(entries[name]);
          // the whole record, not just the two fields the flat map carries
          writePersona(String(p.name || name.split("/").pop().replace(/\.json$/, "")), String(p.description || ""), p);
        } catch (error) { summary.errors.push("persona failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if (name.startsWith("presets/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const n = restorePreset(JSON.parse(entries[name]), name.split("/").pop().replace(/\.json$/i, ""));
          if (n) writePreset(n);
        } catch (error) { summary.errors.push("preset failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      // a persona's picture, filed under the name its settings entry gave it
      if (name.startsWith("user avatars/") && /\.(png|webp|gif|jpe?g)$/i.test(name)) {
        try {
          const pid = personaIdByFile.get(lower(name.slice("user avatars/".length)));
          const persona = pid ? readJson("personas/" + pid + ".json", null) : null;
          const b64 = entryBase64(entries[name]);
          const url = entries[name]?.__image__ && host.zip.image ? host.zip.image(originalNames[name]).url
            : b64 ? "data:image/" + (/\.webp$/i.test(name) ? "webp" : /\.gif$/i.test(name) ? "gif" : /\.jpe?g$/i.test(name) ? "jpeg" : "png") + ";base64," + b64 : null;
          if (persona && url) writeJson("personas/" + pid + ".json", { ...persona, avatar: url });
        } catch (error) { summary.errors.push("persona avatar failed: " + name + ": " + String(error.message || error)); }
        continue;
      }
      if (name.startsWith("themes/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const theme = themeFromForeign(JSON.parse(entries[name]));
          if (theme) libraryAdds.themes.push(theme);
        } catch (error) { summary.errors.push("theme failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      if (name.startsWith("quickreplies/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const raw = JSON.parse(entries[name]);
          const set = quickReplySetFromForeign(raw, !qrVisible.get("__listed") || qrVisible.get(lower(raw?.name)) === true);
          if (set) libraryAdds.qrSets.push(set);
        } catch (error) { summary.errors.push("quick replies failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      // an instruct template becomes a preset of its own, its turn markers
      // the prompt format (a context template's story string leans on
      // variables this app does not have, so those stay behind)
      if (name.startsWith("instruct/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const n = normalizePreset(JSON.parse(entries[name]), name.split("/").pop().replace(/\.json$/i, ""));
          if (n) writePreset(n);
        } catch (error) { summary.errors.push("template failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
      // a transcript too big to hand over whole arrives as a handle, read a
      // slice at a time and written as it goes
      const sliced = entries[name]?.__large__ === true && !!host.zip.read;
      if ((name.startsWith("chats/") || name.startsWith("group chats/")) && name.endsWith(".jsonl") && (isText(entries[name]) || sliced)) {
        try {
          const parts = name.split("/");
          const character = (parts[1] || "").replace(/\.jsonl$/i, "");
          const file = (parts[2] || parts[1] || "chat").replace(/\.jsonl$/i, "");
          const parseLines = (text) => text.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          let slice = sliced ? host.zip.read(originalNames[name], 0) : null;
          const lines = parseLines(sliced ? slice.text : entries[name]);
          let n = normalizeChatLines({ character, file, lines });
          while (sliced && !n && slice.next !== null) {
            slice = host.zip.read(originalNames[name], slice.next);
            for (const line of parseLines(slice.text)) lines.push(line);
            n = normalizeChatLines({ character, file, lines });
          }
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
            // a foreign chat folder is named for the card FILE, and the
            // transcript's first line may name the character outright
            const header = lines[0] && typeof lines[0].mes !== "string" ? lines[0] : null;
            const headerName = header && typeof header.character_name === "string" && header.character_name !== "unused" ? header.character_name : "";
            const characterId = name.startsWith("group chats/") ? null
              : charIdByName().get("file:" + lower(character)) || charIdByName().get(lower(character)) || (headerName && charIdByName().get(lower(headerName))) || null;
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
                        const ownerGroup = groupId ? readJson("groups/" + groupId + ".json", null) : null;
            const ownerName = (characterId && cardName(characterId)) || ownerGroup?.name;
            // the slug filename is a lossy echo of the title (no case, no
            // punctuation); the sidecar has the real one, so only fall back
            // to un-slugging when there is no sidecar to read
            // our backups name transcripts by slug; elsewhere the file name is
            // the chat's own name, and a bare number is when it started
            if (saved && typeof saved.title === "string" && saved.title.trim()) n.title = saved.title;
            else if (/^\d{10,}$/.test(file)) n.title = (ownerName ? ownerName + " " : "") + new Date(Number(file)).toISOString().slice(0, 16).replace("T", " ");
            else if (!/^[a-z0-9-]+$/.test(file)) n.title = file;
            else if (ownerName) n.title = ownerName + ": " + unslugTitle(file);
            // group message attribution: engine ids changed on restore —
            // remap each msg.charId by id, then by the speaker name
            const attribute = (msgs, from) => {
              if (!groupId) return;
              const byName = charIdByName();
              // messages map one to one onto the lines that carry text
              const said = from.filter((l) => l && typeof l.mes === "string");
              msgs.forEach((m, i) => {
                if (m.charId && cardName(m.charId)) return;
                const file = said[i] && typeof said[i].original_avatar === "string" ? said[i].original_avatar.replace(/\.png$/i, "") : "";
                m.charId = (file && byName.get("file:" + lower(file))) || (m.name && byName.get(String(m.name).toLowerCase())) || null;
              });
            };
            attribute(n.msgs, lines);
            if (!sliced) writeChat(n, characterId, groupId, saved);
            else {
              const id = uid(slug(n.title), "chats");
              const transcript = "chats/" + id + ".jsonl";
              const streamed = { id, count: 0, first: n.msgs[0], last: null, hasUser: false };
              const put = (msgs) => {
                fsx.append(transcript, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
                streamed.count += msgs.length;
                streamed.last = msgs[msgs.length - 1];
                if (!streamed.hasUser) streamed.hasUser = msgs.some((m) => m.role === "user");
              };
              put(n.msgs);
              while (slice.next !== null) {
                slice = host.zip.read(originalNames[name], slice.next);
                const more = parseLines(slice.text);
                const part = more.length ? normalizeChatLines({ character, file, lines: more, startAt: streamed.last.at }) : null;
                if (!part) continue;
                attribute(part.msgs, more);
                put(part.msgs);
              }
              writeChat(n, characterId, groupId, saved, streamed);
            }
          }
        } catch (error) { summary.errors.push("chat failed: " + name + ": " + String(error?.message || error)); }
        continue;
      }
    }
    writeSprites();

    mergeLibrary(libraryAdds);

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
    // variables every chat shares: the backup's values win, the rest stay
    if (isText(entries["variables.json"])) {
      try {
        const vars = JSON.parse(entries["variables.json"]);
        if (vars && typeof vars === "object" && !Array.isArray(vars) && Object.keys(vars).length) {
          writeJson("variables.json", { ...readJson("variables.json", {}), ...vars });
          summary.variables = Object.keys(vars).length;
        }
      } catch { summary.errors.push("variables failed"); }
    }
    return { status: 200, json: summary };
  }

  return null;
}
