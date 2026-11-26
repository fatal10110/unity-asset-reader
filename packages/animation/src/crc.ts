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
 * WHATWG `TextEncoder`, declared here because the package compiles with
 * `lib: ["ES2020"]` and no DOM or node types (R4).
 */
declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

/**
 * UTF-8 as .NET's `Encoding.UTF8.GetBytes` gives it: `TextEncoder` too turns
 * a lone surrogate into U+FFFD.
 */
const UTF8 = new TextEncoder();

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
  for (const b of UTF8.encode(text)) value = TABLE[(value ^ b) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
