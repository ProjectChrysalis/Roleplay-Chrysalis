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
