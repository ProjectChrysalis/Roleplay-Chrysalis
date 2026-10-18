import { keepStoredSpriteImages, portableMedia, storeMedia } from "../media.js";
import { pageOf, readPage } from "../paging.js";

/** The card fields the library holds. An embedded lorebook can be most of a
 *  card's size and the library never reads it, so it is only noted. */
const LIST_FIELDS = {
  name: "name", description: "description", personality: "personality", scenario: "scenario",
  first_mes: "first_mes", mes_example: "mes_example", alternate_greetings: "alternate_greetings",
  group_only_greetings: "group_only_greetings", creator_notes: "creator_notes", tags: "tags",
  system_prompt: "system_prompt", post_history_instructions: "post_history_instructions",
  avatar: "avatar", creator: "creator", character_version: "character_version", spec: "spec",
  studio: "studio", extensions: "extensions", hasBook: "character_book?",
};

/** A library card holds only LIST_FIELDS and names the stored card in
 *  `__stored`; an embedded lorebook shows as OMITTED_BOOK. Saved back, the
 *  stored card fills in what the library left out, and a copy saved under a
 *  new id starts from the card it names. */
const OMITTED_BOOK = { __omitted: true };
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function charactersRoute(c) {
  const { req, fsx, head, id, op, ok, err, readJson, writeJson, body } = c;
  if (head === "characters") {
    if (req.method === "GET" && !id && typeof fsx.query === "function") {
      // the engine's index answers from the cards without reading every one
      const { rows } = fsx.query({ files: "characters/*/card.json", fields: LIST_FIELDS }, {});
      const cards = rows.filter((r) => !r.error && !r.keys[0].startsWith("_") && r.data.name).sort((a, b) => (a.keys[0] < b.keys[0] ? -1 : a.keys[0] > b.keys[0] ? 1 : 0));
      const page = pageOf(req.query, Number(req.query?.budget) || 0) || { offset: 0, end: Infinity, budget: Infinity };
      const items = [];
      let at = page.offset, bytes = 0;
      const end = Math.min(cards.length, page.end);
      while (at < end && (at === page.offset || bytes < page.budget)) {
        const row = cards[at++];
        const cid = row.keys[0];
        const { hasBook, ...fields } = row.data;
        let item = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
        // inline images still move to media files: that card is read whole
        if (JSON.stringify(item).includes('"data:')) {
          const card = readJson("characters/" + cid + "/card.json", null);
          if (!card) continue;
          try {
            const migrated = storeMedia(card, fsx);
            if (JSON.stringify(migrated) !== JSON.stringify(card)) writeJson("characters/" + cid + "/card.json", migrated);
            item = Object.fromEntries(Object.keys(fields).filter((k) => migrated[k] != null).map((k) => [k, migrated[k]]));
          } catch { /* original card remains readable until migration can finish */ }
        }
        const out = { ...item, ...(hasBook ? { character_book: OMITTED_BOOK } : {}), __stored: cid, id: cid, name: item.name, avatar: item.avatar || null, tags: item.tags || [], version: item.spec || "chara_card_v2" };
        bytes += JSON.stringify(out).length;
        items.push(out);
      }
      const next = at < end ? at : null;
      return ok(req.query?.offset != null ? { characters: items, next, total: cards.length } : { characters: items });
    }
    if (req.method === "GET" && !id) {
      let ids = [];
      try { ids = fsx.list("characters"); } catch {}
      ids = ids.filter((cid) => !cid.startsWith("_")); // _-prefixed = AI-only template
      const pathOf = (cid) => "characters/" + cid + "/card.json";
      const read = (cid, text) => {
        let c;
        try { c = JSON.parse(text); } catch { return null; }
        if (!c || typeof c !== "object") return null;
        let stored = c;
        // inline images move to media files; only a card holding one can need it
        if (text.includes('"data:')) {
          try {
            const migrated = storeMedia(c, fsx);
            if (JSON.stringify(migrated) !== JSON.stringify(c)) writeJson("characters/" + cid + "/card.json", migrated);
            stored = migrated;
          } catch { /* original card remains readable until migration can finish */ }
        }
        return { item: { ...stored, id: cid, name: c.name, avatar: stored.avatar || null, tags: c.tags || [], version: c.spec || "chara_card_v2" }, bytes: text.length };
      };
      const r = readPage(fsx, ids, pageOf(req.query, Number(req.query?.budget) || 0) || { offset: 0, end: Infinity, budget: Infinity }, pathOf, read);
      return ok(req.query?.offset != null ? { characters: r.items, next: r.next, total: r.total } : { characters: r.items });
    }
    if (!id) return err(400, "character id required");
    if (req.method === "GET") {
      const card = readJson("characters/" + id + "/card.json", null);
      return card ? ok({ ...(op === "portable" ? portableMedia(card, fsx) : card), id }) : err(404, "not found");
    }
    if (req.method === "PUT") {
      const b = body();
      if (!b.name) return err(400, "name required");
      // Canonical card fields + verbatim studio metadata bag (favorites, colors,
      // sprites, variants, stats…) — the card is storage, assembly reads the card fields.
      let prev = readJson("characters/" + id + "/card.json", null);
      const from = typeof b.__stored === "string" && CARD_ID.test(b.__stored) ? b.__stored : null;
      delete b.__stored;
      if (b.character_book && typeof b.character_book === "object" && b.character_book.__omitted === true) delete b.character_book;
      if (!prev && from && from !== id) prev = readJson("characters/" + from + "/card.json", null);
      prev = prev || {};
      const card = {
        ...prev,
        ...b,
        spec: "chara_card_v2", name: String(b.name),
        description: b.description || "", personality: b.personality || "",
        scenario: b.scenario || "", first_mes: b.first_mes || "", mes_example: b.mes_example || "",
        ...(typeof b.system_prompt === "string" && b.system_prompt ? { system_prompt: b.system_prompt } : {}),
        ...(typeof b.post_history_instructions === "string" && b.post_history_instructions ? { post_history_instructions: b.post_history_instructions } : {}),
        ...(Array.isArray(b.alternate_greetings) ? { alternate_greetings: b.alternate_greetings.map(String) } : {}),
        ...(typeof b.creator_notes === "string" && b.creator_notes ? { creator_notes: b.creator_notes } : {}),
        ...(Array.isArray(b.tags) ? { tags: b.tags.map(String) } : {}),
        ...(typeof b.avatar === "string" && b.avatar.startsWith("data:") ? { avatar: b.avatar } : {}),
      };
      delete card.id;
      keepStoredSpriteImages(prev, card);
      writeJson("characters/" + id + "/card.json", card);
      return ok({ ok: true, id });
    }
    if (req.method === "DELETE") {
      try {
        fsx.remove("characters/" + id);
        // a deleted character takes its solo chats with it (the studio UI
        // always showed it that way; orphan chats can no longer generate)
        try {
          for (const f of fsx.list("chats")) {
            if (!f.endsWith(".meta.json")) continue;
            const meta = readJson("chats/" + f, null);
            if (meta && meta.characterId === id && !meta.groupId) {
              try { fsx.remove("chats/" + meta.id + ".jsonl"); } catch {}
              try { fsx.remove("chats/" + meta.id + ".meta.json"); } catch {}
            }
          }
        } catch {}
        return ok({ ok: true });
      } catch { return ok({ ok: false }); }
    }
  }
}
