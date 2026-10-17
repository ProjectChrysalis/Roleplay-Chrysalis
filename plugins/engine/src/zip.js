const CRC_TABLE = (() => {
  const t = Array.from({ length: 256 });
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** UTF-8 bytes of a string, as a Uint8Array.
 *
 *  This used to write latin1 and turn every character above U+00FF into "?".
 *  A backup is prose: curly quotes, em dashes, ellipses, emoji, and any name
 *  that isn't plain ASCII all came out as "?" — and the U+0080..U+00FF range
 *  (é, ñ, ü) came out as bare high bytes, which is not valid UTF-8, so the
 *  file the importer read back wasn't even parseable JSON. Exports were
 *  lossy for anyone whose characters don't write in ASCII. */
export function utf8Bytes(s) {
  const str = String(s);
  // one pass to size the buffer, one to fill it — no per-byte array growth
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0x10000) n += 3;
    else { n += 4; i++; }
  }
  const out = new Uint8Array(n);
  let j = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i);
    if (c < 0x80) out[j++] = c;
    else if (c < 0x800) {
      out[j++] = 0xc0 | (c >> 6);
      out[j++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[j++] = 0xe0 | (c >> 12);
      out[j++] = 0x80 | ((c >> 6) & 63);
      out[j++] = 0x80 | (c & 63);
    } else {
      out[j++] = 0xf0 | (c >> 18);
      out[j++] = 0x80 | ((c >> 12) & 63);
      out[j++] = 0x80 | ((c >> 6) & 63);
      out[j++] = 0x80 | (c & 63);
      i++; // the low surrogate was consumed by codePointAt
    }
  }
  return out;
}
function bytesToB64(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // built in chunks: one += per group of 3 bytes reallocates the whole string
  // on every step, which is what made a large backup crawl
  const parts = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    chunk += chars[b0 >> 2] + chars[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    chunk += b1 === undefined ? "=" : chars[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    chunk += b2 === undefined ? "=" : chars[b2 & 63];
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ""; }
  }
  if (chunk) parts.push(chunk);
  return parts.join("");
}
export function buildZip(files) {
  // files: [{name, text}] — STORE method, timestamps zeroed.
  // Byte buffers are typed arrays, not arrays of numbers: a whole backup used
  // to exist as one JS array with an element per byte, which costs an order
  // of magnitude more than the bytes themselves and blew the sandbox's heap
  // long before a real library finished exporting.
  const u16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >> 8) & 255; };
  const u32 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >> 8) & 255; a[o + 2] = (v >> 16) & 255; a[o + 3] = (v >>> 24) & 255; };
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameB = utf8Bytes(f.name);
    const dataB = utf8Bytes(f.text);
    const crc = crc32(dataB);
    const local = new Uint8Array(30 + nameB.length + dataB.length);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    // bit 11 = the name and comment are UTF-8, per the zip appendix; without
    // it an unpacker is entitled to read the name as its own code page
    u16(local, 6, 0x0800);
    u32(local, 14, crc);
    u32(local, 18, dataB.length);
    u32(local, 22, dataB.length);
    u16(local, 26, nameB.length);
    local.set(nameB, 30);
    local.set(dataB, 30 + nameB.length);
    const central = new Uint8Array(46 + nameB.length);
    u32(central, 0, 0x02014b50);
    u16(central, 4, 20);
    u16(central, 6, 20);
    u16(central, 8, 0x0800);
    u32(central, 16, crc);
    u32(central, 20, dataB.length);
    u32(central, 24, dataB.length);
    u16(central, 28, nameB.length);
    u32(central, 42, offset);
    central.set(nameB, 46);
    parts.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 8, files.length);
  u16(eocd, 10, files.length);
  u32(eocd, 12, cdSize);
  u32(eocd, 16, offset);
  const all = new Uint8Array(offset + cdSize + eocd.length);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  for (const c of centrals) { all.set(c, at); at += c.length; }
  all.set(eocd, at);
  return bytesToB64(all);
}
