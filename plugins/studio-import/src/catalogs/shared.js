export function previewLorebook(book) {
  if (!book || typeof book !== "object") return null;
  const rows = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
  return { name: catalogText(book.name, 500), entries: rows.slice(0, 100).filter(entry => entry && typeof entry === "object").map(entry => ({
    name: catalogText(entry.name || entry.comment || entry.title, 500),
    keys: (Array.isArray(entry.keys) ? entry.keys : Array.isArray(entry.key) ? entry.key : []).filter(key => typeof key === "string").slice(0, 40).map(key => key.slice(0, 200)),
    content: catalogText(entry.content || entry.text, 8000), enabled: entry.enabled !== false && entry.disable !== true,
  })) };
}

export function catalogText(value, limit) { return typeof value === "string" ? value.slice(0, limit) : ""; }
