export const uid = (p) => (p || "e") + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
