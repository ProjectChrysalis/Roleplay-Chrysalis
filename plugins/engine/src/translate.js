export const LANG_CODES = {
  english: "en", spanish: "es", french: "fr", german: "de", portuguese: "pt",
  italian: "it", polish: "pl", russian: "ru", japanese: "ja", korean: "ko",
  "chinese (simplified)": "zh-CN", "chinese (traditional)": "zh-TW",
  ukrainian: "uk", turkish: "tr", arabic: "ar", hebrew: "he", dutch: "nl",
  czech: "cs", greek: "el", swedish: "sv", indonesian: "id", vietnamese: "vi",
};
// per-request caps for code-based providers (URL/body limits); longer texts
// are chunked and stitched so nothing is silently truncated
export const TRANSLATE_CHUNKS = { google: 4000, lingva: 1500, deepl: 4000 };

export function chunkForTranslate(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const win = rest.slice(0, limit);
    let cut = Math.max(win.lastIndexOf("\n\n"), win.lastIndexOf("\n"), win.lastIndexOf(". "), win.lastIndexOf(" "));
    if (cut < Math.floor(limit / 2)) cut = limit; // no boundary worth keeping — hard cut
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}
