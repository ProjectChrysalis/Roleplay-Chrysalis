// library: the studio's local collections (themes, quick replies, tags,
// folders, backgrounds, data bank) — ONE json file so agents can read and
// edit the whole app in one glance next to settings.json.
export function libraryRoute(c) {
  const { req, head, id, ok, err, readJson, writeJson, body } = c;
  if (head === "library" && !id) {
    if (req.method === "GET") return ok(readJson("library.json", {}));
    if (req.method === "PUT") {
      const b = body();
      if (!b || typeof b !== "object") return err(400, "library object required");
      writeJson("library.json", b);
      return ok(b);
    }
  }
}
export function settingsRoute(c) {
  const { req, head, id, ok, readJson, writeJson, body } = c;
  if (head === "settings" && !id) {
    if (req.method === "GET") return ok(readJson("settings.json", { model: null, personaId: null }));
    if (req.method === "PUT") {
      const b = body();
      const cur = readJson("settings.json", { model: null, personaId: null });
      if ("model" in b) cur.model = b.model;
      if ("personaId" in b) cur.personaId = b.personaId;
      // `ui` carries the ENTIRE studio UI settings object — agents edit it
      // on disk (data/settings.json) and every open client picks it up live
      // via the data-watcher look_changed → hydrate.
      if ("ui" in b && b.ui && typeof b.ui === "object") cur.ui = b.ui;
      writeJson("settings.json", cur);
      return ok(cur);
    }
  }
}
