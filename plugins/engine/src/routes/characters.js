import { keepStoredSpriteImages, portableMedia, storeMedia } from "../media.js";
import { pageOf, readPage } from "../paging.js";

export function charactersRoute(c) {
  const { req, fsx, head, id, op, ok, err, readJson, writeJson, body } = c;
  if (head === "characters") {
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
      const prev = readJson("characters/" + id + "/card.json", {});
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
