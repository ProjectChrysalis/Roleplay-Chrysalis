import { state } from "../state.js";
import { pageOf, readPage } from "../paging.js";
import { rememberDefaultPreset } from "../presets.js";

export function entitiesRoute(c) {
  const { req, fsx, head, id, ok, err, readJson, writeJson, body } = c;
  for (const kind of ["personas", "presets", "regex", "groups", "lorebooks"]) {
    if (head !== kind) continue;
    if (req.method === "GET" && !id) {
      let names = [];
      try { names = fsx.list(kind).filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch {}
      const read = (f, text) => {
        try {
          const item = JSON.parse(text);
          return item ? { item: { ...item, id: f.slice(0, -5) }, bytes: text.length } : null;
        } catch { return null; }
      };
      const r = readPage(fsx, names, pageOf(req.query, Number(req.query?.budget) || 0) || { offset: 0, end: Infinity, budget: Infinity }, (f) => kind + "/" + f, read);
      return ok(req.query?.offset != null ? { items: r.items, next: r.next, total: r.total } : { items: r.items });
    }
    if (!id) return err(400, kind + " id required");
    if (req.method === "GET") {
      const v = readJson(kind + "/" + id + ".json", null);
      return v ? ok({ ...v, id }) : err(404, "not found");
    }
    if (req.method === "PUT") {
      const b = body();
      writeJson(kind + "/" + id + ".json", { ...b, id });
      if (kind === "presets" && b.studio && b.studio.isDefault === true) { rememberDefaultPreset(fsx, id, null); state.defaultPresetFound = id; }
      return ok({ ok: true, id });
    }
    // PATCH merges into what's on disk — no client read-modify-write, no lost
    // updates when two clients touch different fields of the same entity
    if (req.method === "PATCH") {
      const cur = readJson(kind + "/" + id + ".json", null);
      if (!cur) return err(404, "not found");
      writeJson(kind + "/" + id + ".json", { ...cur, ...body(), id: cur.id ?? id });
      return ok({ ok: true, id });
    }
    if (req.method === "DELETE") { try { fsx.remove(kind + "/" + id + ".json"); return ok({ ok: true }); } catch { return ok({ ok: false }); } }
  }
}
