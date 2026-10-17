/** Files as text, null for one that cannot be read: one call to the host on
 *  engines that read many at once, one per file on older ones. */
export function readFiles(fsx, rels) {
  if (typeof fsx.readMany === "function") return fsx.readMany(rels);
  return rels.map((rel) => { try { return fsx.read(rel); } catch { return null; } });
}

// A route call runs on a fixed clock and heap. A library of thousands of
// cards and books read in one call ran out of both, so the collections load
// in pages: `?offset=N` reads files from the Nth (in name order) until about
// PAGE_BYTES of JSON were read, and answers `next` (null after the last) and
// `total`. `&end=M` stops before the Mth file, so a client can read several
// ranges of one collection side by side.
export const PAGE_BYTES = 2 * 1024 * 1024;
export function pageOf(query, budget) {
  if (!query || query.offset == null) return null;
  const end = query.end == null ? Infinity : Math.max(0, Math.floor(Number(query.end) || 0));
  return { offset: Math.max(0, Math.floor(Number(query.offset) || 0)), end, budget: budget || PAGE_BYTES };
}
/** `read(name, text)` → {item, bytes} or null, given the text of
 *  `pathOf(name)`. At least one file per page; files are read a few dozen
 *  at a time. */
export function readPage(fsx, names, page, pathOf, read) {
  const items = [];
  const end = Math.min(names.length, page.end);
  let bytes = 0;
  let at = page.offset;
  while (at < end && (at === page.offset || bytes < page.budget)) {
    const chunk = names.slice(at, Math.min(end, at + 32));
    const texts = readFiles(fsx, chunk.map(pathOf));
    for (let i = 0; i < chunk.length && (at === page.offset || bytes < page.budget); i++) {
      const got = texts[i] == null ? null : read(chunk[i], texts[i]);
      at++;
      if (got) { items.push(got.item); bytes += got.bytes; }
    }
  }
  return { items, next: at < end ? at : null, total: names.length };
}
/** What a chat list shows without its transcript, kept in the chat's meta
 *  by every save so the list never reads thousands of transcripts. */
export function chatListing(msgs) {
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return { messageCount: msgs.length, preview: last ? String(last.text || "").slice(0, 160) : "", hasUser: msgs.some((m) => m && m.role === "user") };
}
