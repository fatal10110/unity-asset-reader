// CRC-32 as ISO 3309 / ITU-T V.42 define it (reflected polynomial 0xEDB88320, initial value and
// final xor 0xFFFFFFFF): the checksum of PNG chunks, gzip and zip, and the hash Unity keys
// animation paths by. Written from the specification, not ported.

let table: Uint32Array | undefined;

function makeTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

/**
 * The CRC-32 (ISO 3309, reflected polynomial `0xEDB88320`, as PNG, gzip and zip use it) of
 * `bytes[start..end)`. The lookup table is built on the first call. Sync, with no dependency.
 *
 * @param bytes the bytes to checksum
 * @param start the first byte, default 0
 * @param end one past the last byte (exclusive), default `bytes.length`
 * @returns the CRC-32, unsigned (0 to 2^32 - 1)
 */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  const t = (table ??= makeTable());
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = t[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
