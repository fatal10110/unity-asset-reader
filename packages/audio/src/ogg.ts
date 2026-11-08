// Ogg page writer, written from RFC 3533 (The Ogg Encapsulation Format, version 0).

/** One packet of a logical Ogg stream. */
export interface OggPacket {
  data: Uint8Array;
  /** The granule position once this packet is decoded (for Vorbis, PCM frames). */
  granule: number;
  /** End the page after this packet, even when it has room for more. */
  flush?: boolean;
}

/** A page is closed once its body holds this many bytes (libogg's nominal page size). */
const PAGE_BODY_TARGET = 4096;

/** Page header bytes before the lacing values. */
const HEADER_SIZE = 27;

/** The CRC lookup table: polynomial 0x04C11DB7, MSB first (RFC 3533 section 6). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/**
 * The Ogg page checksum: CRC-32 with polynomial 0x04C11DB7, not reflected,
 * initial value 0 and no final XOR (RFC 3533 section 6, "CRC_checksum").
 */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** One lacing segment: a packet's bytes from `start`, `size` of them (255 unless it ends it). */
interface Segment {
  packet: number;
  start: number;
  size: number;
}

/**
 * Write packets as one logical Ogg stream: pages with the beginning-of-stream
 * flag on the first and the end-of-stream flag on the last.
 *
 * Each packet is laced as 255-byte segments and one shorter segment (0 bytes
 * when its size is a multiple of 255, an empty packet included). A page ends
 * after 255 segments, once its body reaches 4096 bytes, after a packet marked
 * `flush`, and after the last packet; a packet split across pages sets the
 * next page's continued flag. A page's granule position is that of the last
 * packet ending on it, or -1 when none does.
 *
 * @param serial the stream's serial number
 * @param packets the packets in stream order, at least one
 * @returns the pages, concatenated
 */
export function writeOggStream(serial: number, packets: OggPacket[]): Uint8Array {
  const segments: Segment[] = [];
  packets.forEach(({ data }, packet) => {
    for (let start = 0; ; start += 255) {
      const size = Math.min(255, data.length - start);
      segments.push({ packet, start, size });
      if (size < 255) break;
    }
  });

  const pages: Uint8Array[] = [];
  let first = 0;
  let body = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    body += segment.size;
    const endsPacket = segment.size < 255;
    const last = i === segments.length - 1;
    const full = i - first + 1 === 255 || body >= PAGE_BODY_TARGET;
    if (last || full || (endsPacket && packets[segment.packet]!.flush)) {
      pages.push(page(serial, pages.length, packets, segments.slice(first, i + 1), body, last));
      first = i + 1;
      body = 0;
    }
  }
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One page of `segments`, its CRC filled in. */
function page(
  serial: number,
  sequence: number,
  packets: OggPacket[],
  segments: Segment[],
  bodySize: number,
  last: boolean,
): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + segments.length + bodySize);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS", then stream_structure_version 0
  const continued = segments[0]!.start > 0;
  out[5] = (continued ? 1 : 0) | (sequence === 0 ? 2 : 0) | (last ? 4 : 0);
  let granule = -1;
  for (const s of segments) if (s.size < 255) granule = packets[s.packet]!.granule;
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  out[26] = segments.length;
  let at = HEADER_SIZE + segments.length;
  segments.forEach((s, i) => {
    out[HEADER_SIZE + i] = s.size;
    out.set(packets[s.packet]!.data.subarray(s.start, s.start + s.size), at);
    at += s.size;
  });
  view.setUint32(22, oggCrc(out), true);
  return out;
}
