/**
 * gzip (RFC 1952) and zlib (RFC 1950) wrappers, plus the two wrapper formats
 * Unity can emit that this library deliberately does not decode.
 *
 * gzip and zlib go through the platform's `DecompressionStream`, which every
 * target has (browsers, workers, Deno, Node >= 18): no dependency, and native
 * speed. It is async, so these two are the only promises among the codecs, and
 * nothing in the sync parse path calls them (D4, revision 2026-11-26a): `open()`
 * unwraps a gzip-wrapped input before its sync `load()`.
 *
 * The stream checks the trailer itself - CRC32 and ISIZE for gzip, Adler-32 for
 * zlib - and rejects a truncated stream, a damaged one and bytes after its end,
 * so a rejection is all there is to turn into a {@link CorruptError} (R9).
 */

import { CorruptError, UnsupportedError } from "../errors.js";

// The package compiles with `lib: ["ES2020"]` and no DOM types (R4), so the
// WHATWG `DecompressionStream` is declared here by the members used.
declare const DecompressionStream: new (format: "gzip" | "deflate") => {
  readonly readable: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  };
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
};

const SKIPPED_HINT = "no sync browser-safe decoder is bundled; decompress the file " +
  "before loading it, or open an issue with a sample";

/**
 * Decompress a gzip stream with the platform's `DecompressionStream("gzip")`.
 *
 * Async, unlike every other codec here: `load()` refuses a gzip-wrapped file,
 * and `open()` calls this to unwrap one first.
 *
 * @param data a complete gzip stream (magic `1f 8b`). Unity writes one member;
 *   whether several concatenated members are joined is the platform's call
 *   (Node joins them).
 * @returns the decompressed bytes
 * @throws {CorruptError} (as a rejection) for bad magic, truncated input, a
 *   damaged deflate stream, a CRC32 or length trailer that disagrees with the
 *   output, or bytes after the end of the stream; never partial output
 */
export function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return inflate(data, "gzip", "gzip");
}

/**
 * Decompress a zlib stream with the platform's `DecompressionStream("deflate")`.
 *
 * @param data one complete zlib stream (RFC 1950 header, not raw deflate)
 * @returns the decompressed bytes
 * @throws {CorruptError} (as a rejection) for truncated input, a damaged
 *   stream, an Adler-32 trailer that disagrees with the output, or bytes after
 *   the end of the stream; never partial output
 */
export function unzlib(data: Uint8Array): Promise<Uint8Array> {
  return inflate(data, "deflate", "zlib");
}

/**
 * Brotli-compressed payload (Unity WebGL `.unityweb` builds). Not implemented:
 * the decision on record is to skip it and add a decoder only once this fires
 * on a real file.
 *
 * Takes the data it will not decode so a caller can dispatch to it like any
 * other codec.
 *
 * @throws {UnsupportedError} always, naming brotli
 */
export function brotliDecompress(_data: Uint8Array): never {
  throw new UnsupportedError("compression type", "brotli", SKIPPED_HINT);
}

/**
 * LZHAM-compressed bundle block (`CompressionType` 4). Not implemented, on the
 * same terms as {@link brotliDecompress}: Unity stopped emitting it and no
 * fixture exists, so a decoder waits until this throw is seen in the wild.
 *
 * @throws {UnsupportedError} always, naming LZHAM
 */
export function lzhamDecompress(_data: Uint8Array): never {
  throw new UnsupportedError("compression type", "LZHAM", SKIPPED_HINT);
}

/**
 * Run `data` through a `DecompressionStream`, reporting whatever it rejects as a
 * {@link CorruptError}.
 *
 * The input is written while the output is read: the stream applies
 * backpressure, so writing everything first would stall on a large input.
 */
async function inflate(
  data: Uint8Array,
  format: "gzip" | "deflate",
  label: string,
): Promise<Uint8Array> {
  // Outside the `try`: a platform without the stream is not corrupt input.
  const stream = new DecompressionStream(format);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const writer = stream.writable.getWriter();
    const written = writer.write(data).then(() => writer.close());
    // A corrupt stream rejects the write side as well as the read side; the
    // read side reports it first, so this one must not go unhandled meanwhile.
    written.catch(() => {});
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        size += value.length;
      }
    }
    await written;
  } catch (cause) {
    throw new CorruptError(
      `${label} stream of ${data.length} bytes failed to inflate: ${reason(cause)}`,
    );
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** What went wrong: Node's zlib errors carry only a `code` (`Z_DATA_ERROR`). */
function reason(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  if (cause.message) return cause.message;
  return typeof code === "string" ? code : cause.name;
}
