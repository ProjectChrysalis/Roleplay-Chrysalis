const B64 = (() => {
  const map = new Uint8Array(128);
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < 64; i++) map[table.charCodeAt(i)] = i;
  return map;
})();
export function b64ToBytes(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0, i = 0;
  for (; i + 3 < clean.length; i += 4) {
    const n = (B64[clean.charCodeAt(i)] << 18) | (B64[clean.charCodeAt(i + 1)] << 12) | (B64[clean.charCodeAt(i + 2)] << 6) | B64[clean.charCodeAt(i + 3)];
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  const rest = clean.length - i;
  if (rest >= 2) {
    const n = (B64[clean.charCodeAt(i)] << 18) | (B64[clean.charCodeAt(i + 1)] << 12) | (rest === 3 ? B64[clean.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = n >> 16;
    if (rest === 3) out[o++] = (n >> 8) & 255;
  }
  return out.subarray(0, o);
}
function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray ? bytes.subarray(i, i + 8192) : bytes.slice(i, i + 8192));
  return s;
}
/** UTF-8 bytes as text. The native escape/decode pair is several times
 *  faster than a decoder written in the sandbox; malformed bytes fall back
 *  to the replacing decoder. */
function utf8(bytes) {
  try { return decodeURIComponent(escape(latin1(bytes))); } catch { return new TextDecoder().decode(bytes); }
}
/** A card's PNG text field: JSON as is, or base64 JSON. `decoded` is the
 *  engine's own decode of it, when the engine sends one. */
export function cardText(payload, decoded) {
  if (typeof decoded === "string") return decoded;
  return payload.trimStart().startsWith("{") ? payload : utf8(b64ToBytes(payload));
}
export function extractCardFromPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  let off = 8;
  let v2 = null;
  while (off + 12 <= bytes.length) {
    const len = bytes[off] * 0x1000000 + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
    if (off + 12 + len > bytes.length) break;
    const type = latin1(bytes.slice(off + 4, off + 8));
    if (type === "tEXt" || type === "iTXt") {
      const data = bytes.slice(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1(data.slice(0, nul));
        if (keyword === "ccv3" || keyword === "chara") {
          try {
            let start = nul + 1;
            if (type === "iTXt") {
              if (data[start] !== 0 || data[start + 1] !== 0) throw new Error("compressed text is unsupported");
              const languageEnd = data.indexOf(0, start + 2);
              const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
              if (translatedEnd < 0) throw new Error("invalid text chunk");
              start = translatedEnd + 1;
            }
            const payload = latin1(data.slice(start));
            const text = type === "iTXt" && keyword === "ccv3" && payload.trimStart().startsWith("{")
              ? utf8(data.slice(start))
              : utf8(b64ToBytes(payload));
            const card = JSON.parse(text);
            if (keyword === "ccv3") return card;
            if (!v2) v2 = card;
          } catch { /* next chunk */ }
        }
      }
    }
    off += 12 + len;
    if (type === "IEND") break;
  }
  return v2;
}
