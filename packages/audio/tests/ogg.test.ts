import assert from "node:assert/strict";
import { test } from "node:test";

import { oggCrc, writeOggStream, type OggPacket } from "../src/ogg.js";
import { readPages } from "./pages.js";

// Ogg's CRC (RFC 3533 section 6): polynomial 0x04C11DB7, MSB first, initial
// value 0, no final XOR. The expected value was computed by a bitwise Python
// implementation, which gives the catalogue check of CRC-32/MPEG-2 (0x0376E6E7)
// when started at 0xFFFFFFFF instead.
test("the Ogg CRC of \"123456789\" is 0x89A1897F", () => {
  assert.equal(oggCrc(new TextEncoder().encode("123456789")), 0x89a1897f);
  assert.equal(oggCrc(new Uint8Array(0)), 0);
});

/** A packet of `size` bytes, each its index's low byte. */
function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => i & 0xff);
}

test("a packet of 255 * k bytes ends with a 0 lacing value; an empty packet is one", () => {
  const packets: OggPacket[] = [
    { data: bytes(255), granule: 1 },
    { data: bytes(510), granule: 2 },
    { data: bytes(0), granule: 3 },
    { data: bytes(254), granule: 4 },
    { data: bytes(256), granule: 5 },
  ];
  const [page, ...rest] = readPages(writeOggStream(7, packets));
  assert.equal(rest.length, 0);
  assert.deepEqual(page!.lacing, [255, 0, 255, 255, 0, 0, 254, 255, 1]);
  assert.deepEqual(page!.packets.map((p) => p.length), [255, 510, 0, 254, 256]);
  assert.deepEqual(page!.packets[1], bytes(510));
  assert.equal(page!.flags, 2 | 4); // the only page: first and last
  assert.equal(page!.granule, 5n);
  assert.equal(page!.serial, 7);
  assert.equal(page!.sequence, 0);
});

test("a page holds at most 255 segments", () => {
  const packets = Array.from({ length: 300 }, (_, i) => ({ data: bytes(1), granule: i }));
  const pages = readPages(writeOggStream(1, packets));
  assert.deepEqual(pages.map((p) => p.lacing.length), [255, 45]);
  assert.deepEqual(pages.map((p) => p.flags), [2, 4]);
  assert.deepEqual(pages.map((p) => p.granule), [254n, 299n]);
  assert.deepEqual(pages.map((p) => p.sequence), [0, 1]);
});

test("a packet split across pages: granule -1 where none ends, then the continued flag", () => {
  const pages = readPages(writeOggStream(1, [{ data: bytes(5000), granule: 9 }]));
  // A page closes once its body reaches 4096 bytes: 17 segments of 255.
  assert.deepEqual(pages.map((p) => p.lacing.length), [17, 3]);
  assert.deepEqual(pages[1]!.lacing, [255, 255, 155]);
  assert.deepEqual(pages.map((p) => p.flags), [2, 1 | 4]);
  assert.deepEqual(pages.map((p) => p.granule), [-1n, 9n]);
  assert.deepEqual(pages[1]!.continuedBytes, bytes(5000).subarray(17 * 255));
});

test("flush ends a page after its packet", () => {
  const packets: OggPacket[] = [
    { data: bytes(30), granule: 0, flush: true },
    { data: bytes(20), granule: 0 },
    { data: bytes(10), granule: 0, flush: true },
    { data: bytes(5), granule: 100 },
  ];
  const pages = readPages(writeOggStream(1, packets));
  assert.deepEqual(pages.map((p) => p.lacing), [[30], [20, 10], [5]]);
  assert.deepEqual(pages.map((p) => p.flags), [2, 0, 4]);
  assert.deepEqual(pages.map((p) => p.granule), [0n, 0n, 100n]);
});
