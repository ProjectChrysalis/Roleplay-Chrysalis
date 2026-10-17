import { slug } from "./entries.js";

/** A foreign color ("#rgb", "#rrggbb", "rgb(…)", "rgba(…)") as "#rrggbb",
 *  alpha dropped; null when it is none of those. */
function hexColor(value) {
  const v = String(value ?? "").trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (hex) return "#" + (hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1]).toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(v);
  if (!rgb) return null;
  return "#" + rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
}

/** Colors a theme file leaves out come from the default dark palette. */
const BASE_THEME = { mainText: "#e4e4e4", italics: "#8f8f8f", quotes: "#54d17d", shadow: "#000000", chatBg: "#0b0b0b", uiBg: "#101010", borders: "#212121", userTint: "#171717", charTint: "#101010", accent: "#54d17d" };

/** A theme file of the public UI-theme shape as a theme preset (colors
 *  only; layout and custom CSS have no place in a preset). */
export function themeFromForeign(t) {
  if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name.trim()) return null;
  const pick = (...keys) => { for (const k of keys) { const c = hexColor(t[k]); if (c) return c; } return null; };
  const colors = {
    mainText: pick("main_text_color"), italics: pick("italics_text_color"), quotes: pick("quote_text_color"),
    shadow: pick("shadow_color"), chatBg: pick("chat_tint_color", "blur_tint_color"), uiBg: pick("blur_tint_color"),
    borders: pick("border_color"), userTint: pick("user_mes_blur_tint_color"), charTint: pick("bot_mes_blur_tint_color"),
    accent: pick("quote_text_color", "underline_text_color"),
  };
  if (!Object.values(colors).some(Boolean)) return null;
  for (const k of Object.keys(colors)) colors[k] = colors[k] || BASE_THEME[k];
  return { id: "theme_" + slug(t.name) + "-" + Math.random().toString(36).slice(2, 7), name: t.name.trim(), builtin: false, colors };
}

/** A quick reply set file as a set of buttons. Automation flags are left
 *  off: a reply that fired on every message elsewhere would send text here,
 *  and hidden replies only exist to be called by other scripts. */
export function quickReplySetFromForeign(raw, enabled) {
  if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim() || !Array.isArray(raw.qrList)) return null;
  const replies = raw.qrList
    .filter((qr) => qr && typeof qr.message === "string" && qr.message.trim() && qr.isHidden !== true)
    .map((qr) => ({
      id: "qr_" + Math.random().toString(36).slice(2, 10),
      label: String(qr.label || qr.title || qr.message).slice(0, 80),
      message: qr.message,
      color: typeof raw.color === "string" ? raw.color : "",
      mode: raw.disableSend === true ? "insert" : "send",
      autoExecute: { onStartup: false, onUser: false, onAi: false, onChatChange: false },
    }));
  if (!replies.length) return null;
  return { id: "qrs_" + Math.random().toString(36).slice(2, 10), name: raw.name.trim(), scope: "global", replies, enabled };
}
