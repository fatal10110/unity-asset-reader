// Ported from AssetStudio/7zip/Common/CRC.cs (MIT, © Perfare / RazTools / Razviar)

/** The CRC-32 table of the reflected polynomial `0xEDB88320`. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i;
    for (let j = 0; j < 8; j++) r = r & 1 ? (r >>> 1) ^ 0xedb88320 : r >>> 1;
    table[i] = r;
  }
  return table;
})();

/**
 * A string's UTF-8 bytes, as .NET's `Encoding.UTF8.GetBytes` gives them: a
 * lone surrogate becomes U+FFFD.
 */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return out;
}

/**
 * The CRC-32 of a string's UTF-8 bytes (upstream `CRC.CalculateDigestUTF8`),
 * the hash Unity keys transform paths, property names and blend shape names
 * by. Upstream's `CalculateDigestAscii` agrees with it on the ASCII names it
 * is given.
 *
 * @param text the string
 * @returns the CRC-32, unsigned
 */
export function crc32(text: string): number {
  let value = 0xffffffff;
  for (const b of utf8(text)) value = TABLE[(value ^ b) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
