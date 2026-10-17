import { PAGE_BYTES } from "../paging.js";
import { handleRoute } from "./index.js";

// Every route call rebuilds the sandbox and recompiles the plugin, so a boot
// that fetches ten collections and then one transcript per chat pays that
// cost ~25 times over and takes seconds. One route, one dispatch: the
// sub-calls run in this same context and return the exact shapes the
// individual routes do, so there is no second definition to keep in sync.
export function bootstrapRoute(c) {
  const { req, host, head, id, ok } = c;
  if (head === "bootstrap" && !id && req.method === "GET") {
    // ?paged=1: each collection comes as its first page and `more` says where
    // the rest starts and how many files there are; the client reads those
    // pages from the routes below
    const paged = req.query && req.query.paged === "1";
    const more = {};
    const sub = (p, key) => {
      const r = handleRoute({ method: "GET", path: p, body: null, query: paged && key ? { offset: "0", budget: String(PAGE_BYTES / 4) } : {} }, host).json;
      if (paged && key && r && r.next != null) more[key] = { next: r.next, total: r.total };
      return r;
    };
    const metas = sub("/chats", "chats").chats ?? [];
    const wanted = req.query && req.query.chat ? String(req.query.chat) : "";
    let activeChat = null;
    if (wanted) {
      const full = sub("/chats/" + wanted);
      if (full && full.meta) activeChat = { meta: full.meta, messages: full.messages ?? [] };
    }
    return ok({
      characters: sub("/characters", "characters").characters ?? [],
      groups: sub("/groups", "groups").items ?? [],
      personas: sub("/personas", "personas").items ?? [],
      presets: sub("/presets", "presets").items ?? [],
      lorebooks: sub("/lorebooks", "lorebooks").items ?? [],
      regex: sub("/regex", "regex").items ?? [],
      settings: sub("/settings"),
      library: sub("/library"),
      databank: sub("/databank"),
      // Metas only. Inlining every transcript made this payload grow with
      // every message ever written. Each meta carries preview, messageCount
      // and hasUser, so lists and the sweep need no transcript; the client
      // pulls one chat at a time from /chats/:id.
      chats: metas,
      // …except the chat the client is about to show, which rides along so
      // opening the app still paints a full transcript at once.
      activeChat,
      ...(paged ? { more } : {}),
    });
  }
}
