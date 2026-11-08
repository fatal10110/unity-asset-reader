// Reads Ogg pages for the tests, field by field from RFC 3533 section 6, and
// checks each page's CRC with a bitwise CRC of its own. Nothing here calls the
// code under test.

import assert from "node:assert/strict";

/** One Ogg page, its lacing values and the packets that start and end on it. */
export interface Page {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  lacing: number[];
  /** The bytes before the first packet that starts on this page (a continued packet's tail). */
  continuedBytes: Uint8Array;
  /** Packets that start and end on this page. */
  packets: Uint8Array[];
}

/** CRC-32, polynomial 0x04C11DB7, MSB first, initial value 0, no final XOR, bit by bit. */
function bitwiseCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let k = 0; k < 8; k++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

/** Split an Ogg stream into pages, asserting each page's magic, version and CRC. */
export function readPages(stream: Uint8Array): Page[] {
  const pages: Page[] = [];
  let at = 0;
  while (at < stream.length) {
    const view = new DataView(stream.buffer, stream.byteOffset + at);
    assert.equal(String.fromCharCode(...stream.subarray(at, at + 4)), "OggS", `page at ${at}`);
    assert.equal(stream[at + 4], 0, `version at ${at}`);
    const count = stream[at + 26]!;
    const lacing = [...stream.subarray(at + 27, at + 27 + count)];
    const bodySize = lacing.reduce((n, v) => n + v, 0);
    const size = 27 + count + bodySize;
    const bytes = stream.slice(at, at + size);
    const crc = view.getUint32(22, true);
    bytes.fill(0, 22, 26);
    assert.equal(crc, bitwiseCrc(bytes), `CRC of the page at ${at}`);

    const body = stream.subarray(at + 27 + count, at + size);
    const flags = stream[at + 5]!;
    const packets: Uint8Array[] = [];
    let continuedBytes = new Uint8Array(0);
    let start = 0;
    let offset = 0;
    let first = (flags & 1) === 1;
    for (const value of lacing) {
      offset += value;
      if (value < 255) {
        if (first) continuedBytes = body.subarray(start, offset);
        else packets.push(body.subarray(start, offset));
        first = false;
        start = offset;
      }
    }
    pages.push({
      flags,
      granule: view.getBigInt64(6, true),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      lacing,
      continuedBytes,
      packets,
    });
    at += size;
  }
  return pages;
}
