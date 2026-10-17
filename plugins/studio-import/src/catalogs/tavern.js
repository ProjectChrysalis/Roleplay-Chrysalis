import { handleRoute } from "../import.js";
import { cardText } from "../png.js";
import { catalogText, previewLorebook } from "./shared.js";

const TAVERN_BASE = "https://character-tavern.com";
const TAVERN_PATH = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/;
function tavernImage(id) { return "https://ct-cards.storage.character-tavern.com/" + id + ".png"; }

function catalogPageData(text) {
  const messages = String(text || "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const values = messages[0]?.nodes?.findLast(node => node.type === "data")?.data;
  const chunks = new Map(messages.filter(message => message.type === "chunk").map(message => [message.id, message.data]));
  function decode(values, startDepth) {
    if (!Array.isArray(values) || values.length > 100000) throw new Error("Invalid catalog page data");
    const seen = new Map();
    function read(index, depth) {
      if (index === -1) return undefined;
      if (!Number.isInteger(index) || index < 0 || index >= values.length || depth > 100) throw new Error("Invalid catalog data reference");
      if (seen.has(index)) return seen.get(index);
      const value = values[index];
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value) && typeof value[0] === "string") {
        if (value[0] === "Date") return value[1];
        if (value[0] === "Promise") {
          const chunk = chunks.get(read(value[1], depth + 1));
          return chunk ? decode(chunk, depth + 1) : undefined;
        }
        throw new Error("Unsupported catalog data value");
      }
      const out = Array.isArray(value) ? [] : Object.create(null);
      seen.set(index, out);
      if (Array.isArray(value)) for (const ref of value) out.push(read(ref, depth + 1));
      else for (const [key, ref] of Object.entries(value)) out[key] = read(ref, depth + 1);
      return out;
    }
    return read(0, startDepth);
  }
  return decode(values, 0);
}

export function tavernRoute(req, host) {
  if (!host.net) return { status: 503, json: { error: "Network permission not granted" } };
  const b = req.body || {}, searching = req.path === "/marketplace/search";
  if (!searching && !TAVERN_PATH.test(String(b.id || ""))) return { status: 400, json: { error: "Invalid character path" } };
  const page = Math.max(1, Math.min(10000, Math.floor(Number(b.page) || 1)));
  if (!host.net.results.catalog && !req.stash?.character) {
    const params = new URLSearchParams({ "x-sveltekit-invalidated": "001", page: String(page), sort: b.sort === "updated" ? "recently_updated" : b.sort === "rating" ? "most_liked" : b.sort === "downloads" ? "popular" : "newest" });
    if (b.search) params.set("query", String(b.search).trim().slice(0, 120));
    if (Array.isArray(b.tags) && b.tags.length) params.set("tags", b.tags.slice(0, 12).map(String).join(","));
    host.net.request("catalog", { url: TAVERN_BASE + (searching ? "/search/cards" : "/character/" + b.id) + "/__data.json?" + params, json: false, maxBytes: 8 * 1024 * 1024, headers: { Accept: "application/json" } });
    return { __llmPending: true };
  }
  const response = host.net.results.catalog;
  if (!req.stash?.character && !response?.ok) return { status: 502, json: { error: "Character Tavern request failed: " + (response?.status || response?.error || "no response") } };
  let data;
  try { data = req.stash?.character || catalogPageData(response.text); }
  catch (e) { return { status: 502, json: { error: String(e.message || e) } }; }
  if (searching) {
    const result = data.searchResults;
    if (!Array.isArray(result?.hits) || !Number.isFinite(result.totalHits) || result.totalHits < 0 || !Number.isInteger(result.hitsPerPage) || result.hitsPerPage < 1) return { status: 502, json: { error: "Invalid Character Tavern search results" } };
    return { status: 200, json: { source: "tavern", count: result.totalHits, page, first: result.hitsPerPage, results: result.hits.filter(c => TAVERN_PATH.test(c.path)).map(c => ({
      id: c.path, name: catalogText(c.name, 500), creator: catalogText(c.author, 200), tagline: catalogText(c.tagline, 1000), description: "", topics: [],
      downloads: null, favorites: null, tokens: typeof c.permanentTokens === "number" ? c.permanentTokens : null, rating: null, ratingCount: null, chats: null, messages: null,
      nsfw: Array.isArray(c.contentWarnings) && c.contentWarnings.length > 0, avatar: tavernImage(c.path), maxRes: tavernImage(c.path), createdAt: null,
    })) } };
  }
  const c = data.character;
  if (!c || typeof c !== "object") return { status: 502, json: { error: "Invalid Character Tavern character" } };
  const blocked = c.visibility && c.visibility !== "public" ? "This character is not public." : !c.definition_character_description && !c.definition_first_message ? "The public definition is unavailable." : null;
  if (req.path === "/marketplace/import") {
    if (blocked) return { status: 403, json: { error: blocked } };
    if (!host.net.results.png) {
      host.net.request("png", { url: tavernImage(b.id), binary: true, maxBytes: 16 * 1024 * 1024 });
      return { __llmPending: true, stash: { character: data } };
    }
    const image = host.net.results.png;
    let card = null, artwork = null;
    if (image.ok && image.base64) {
      if (!host.fs?.image) return { status: 409, json: { error: "Update Chrysalis to import compressed card images." } };
      try {
        const decoded = host.fs.image("data:image/png;base64," + image.base64);
        artwork = decoded.url;
        for (const key of ["ccv3", "chara"]) {
          const payload = decoded.metadata[key];
          if (!payload) continue;
          try { card = JSON.parse(cardText(payload, decoded.text?.[key])); break; } catch { /* next metadata field */ }
        }
      } catch (e) { return { status: 502, json: { error: String(e.message || e) } }; }
    }
    if (!card) return { status: 502, json: { error: "The downloadable card is unavailable." } };
    const imported = handleRoute({ ...req, path: "/import/batch", body: { cards: [{ card, avatar: artwork }], enableEmbeddedRegex: b.enableEmbeddedRegex === true, deferEmbeddedLore: b.deferEmbeddedLore === true } }, host);
    if (!imported.json?.characters?.length) return { status: 500, json: { error: imported.json?.errors?.[0] || "Card import failed" } };
    return { ...imported, json: { ...imported.json, name: c.name } };
  }
  return { status: 200, json: { source: "tavern", id: b.id, importable: !blocked, importReason: blocked, avatar: tavernImage(b.id),
    greeting: catalogText(c.definition_first_message, 16000), alternateGreetings: (Array.isArray(data.alternativeGreetings) ? data.alternativeGreetings : []).map(g => catalogText(typeof g === "string" ? g : g.message || g.content || g.firstMessage, 16000)),
    personality: catalogText(c.definition_character_description, 24000), traits: catalogText(c.definition_personality, 24000), scenario: catalogText(c.definition_scenario, 8000), exampleDialogs: catalogText(c.definition_example_messages, 16000),
    creatorNotes: catalogText(c.description, 8000), systemPrompt: catalogText(c.definition_system_prompt, 8000), postHistoryInstructions: catalogText(c.definition_post_history_prompt, 8000), lorebook: previewLorebook(data.lorebook), lorebookEntries: data.lorebook ? (Array.isArray(data.lorebook.entries) ? data.lorebook.entries.length : Object.keys(data.lorebook.entries || {}).length) : 0,
  } };
}
