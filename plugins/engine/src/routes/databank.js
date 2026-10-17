import { chunkText, listDatabank, searchDatabank } from "../databank.js";
import { uid } from "../util.js";
import { utf8Bytes } from "../zip.js";

export function databankRoute(c) {
  const { req, fsx, head, id, ok, err, readJson, writeJson, body } = c;
    if (head === "databank") {
      if (req.method === "GET" && !id) {
        return ok({ files: listDatabank(fsx).map((f) => ({
          id: f.id, name: f.name, scope: f.scope || "global", scopeTargetId: f.scopeTargetId || null,
          status: "ready", size: f.size || 0, chunks: (f.chunks || []).length,
          enabled: f.enabled !== false, addedAt: f.addedAt || 0,
        })) });
      }
      if (req.method === "POST" && !id) {
        const b = body();
        const name = String(b.name || "").trim().slice(0, 120);
        const content = typeof b.content === "string" ? b.content : "";
        if (!name) return err(400, "name required");
        if (!content.trim()) return err(400, "content is empty");
        const size = utf8Bytes(content).length;
        if (size > 2 * 1024 * 1024) return err(413, "file too large (2 MB text limit)");
        const fid = uid("db");
        const chunks = chunkText(content);
        const file = {
          id: fid, name, scope: ["global", "character", "chat"].includes(b.scope) ? b.scope : "global",
          scopeTargetId: null, enabled: true, addedAt: Date.now(),
          size, chunks,
        };
        writeJson("databank/" + fid + ".json", file);
        return ok({ file: { id: fid, name, scope: file.scope, scopeTargetId: null, status: "ready", size: file.size, chunks: chunks.length, enabled: true, addedAt: file.addedAt } });
      }
      if (req.method === "GET" && id === "search") {
        const q = String((req.query && req.query.q) || (body().q) || "");
        if (!q.trim()) return err(400, "q required");
        return ok({ results: searchDatabank(fsx, q, 8) });
      }
      if (req.method === "PATCH" && id) {
        const b = body();
        const f = readJson("databank/" + id + ".json", null);
        if (!f) return err(404, "no such file");
        if (typeof b.enabled === "boolean") f.enabled = b.enabled;
        if (typeof b.name === "string" && b.name.trim()) f.name = b.name.trim().slice(0, 120);
        writeJson("databank/" + id + ".json", f);
        return ok({ ok: true });
      }
      if (req.method === "DELETE" && id) {
        try { fsx.remove("databank/" + id + ".json"); } catch { return err(404, "no such file"); }
        return ok({ ok: true });
      }
    }
}
