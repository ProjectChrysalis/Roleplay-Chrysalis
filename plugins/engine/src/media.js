// A sprite the caller did not send back keeps the image already on disk. The
// image only ever travels with the card, so any client that lists characters
// without the picture bytes (or fails to load one) would otherwise erase the
// whole pack the moment the card is saved from that view. Names and order
// come from the caller; a picture is only ever replaced by another picture.
export function keepStoredSpriteImages(prev, card) {
  const before = prev && prev.studio && Array.isArray(prev.studio.expressions) ? prev.studio.expressions : null;
  const after = card && card.studio && Array.isArray(card.studio.expressions) ? card.studio.expressions : null;
  if (!before || !after) return;
  const stored = new Map();
  for (const e of before) if (e && typeof e.name === "string" && e.url) stored.set(e.name, e.url);
  if (!stored.size) return;
  card.studio = {
    ...card.studio,
    expressions: after.map((e) => (e && typeof e.name === "string" && !e.url && stored.has(e.name) ? { ...e, url: stored.get(e.name) } : e)),
  };
}

export function storeMedia(value, fsx) {
  if (!fsx.media) return value;
  if (typeof value === "string") return /^data:image\/(png|jpeg|webp|gif);base64,/.test(value) ? fsx.media(value) : value;
  if (Array.isArray(value)) return value.map((item) => storeMedia(item, fsx));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = storeMedia(item, fsx);
  if (out.studio && out.studio.avatar === out.avatar) delete out.studio.avatar;
  return out;
}

export function portableMedia(value, fsx) {
  if (typeof value === "string") {
    const match = /^\/v1\/apps\/[^/]+\/__media\/([a-f0-9]{64}\.(png|jpeg|webp|gif))$/.exec(value);
    return match ? "data:image/" + match[2] + ";base64," + fsx.readBase64("__media/" + match[1]) : value;
  }
  if (Array.isArray(value)) return value.map((item) => portableMedia(item, fsx));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = portableMedia(item, fsx);
  return out;
}
