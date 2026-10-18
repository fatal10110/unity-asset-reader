// What the ported C# relies on from .NET, as it behaves under .NET 8 on the
// en-US culture AssetStudio exports on: little-endian reads that fail with
// .NET's own message, UTF-8 decoding, and the messages of the exceptions
// AssetStudio writes into the shader text.

/**
 * WHATWG `TextDecoder`, declared here because the package compiles with
 * `lib: ["ES2020"]` and no DOM or node types (R4). It is a global in browsers,
 * workers and Node.js.
 */
declare const TextDecoder: {
  new (
    label?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  ): { decode(input?: Uint8Array): string };
};

let utf8: { decode(input?: Uint8Array): string } | undefined;

/**
 * `Encoding.UTF8.GetString`: invalid sequences become U+FFFD, and a leading
 * byte order mark stays in the text (`TextDecoder` drops it by default).
 */
export function decodeUtf8(bytes: Uint8Array): string {
  if (!utf8) utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
  return utf8.decode(bytes);
}

/**
 * An exception of AssetStudio's SPIR-V path (SMOL-V decoding and CSspv's
 * disassembly), which it catches and writes into the shader text as
 * `// disassembly error <message>`. Every failure of `smolv.ts` and
 * `spirv.ts` is one, with the message upstream's code or .NET 8 gives, so
 * the text matches to the byte.
 */
export class DisassemblyError extends Error {
  /** @param message the exception's `Message`, as .NET gives it */
  constructor(message: string) {
    super(message);
    this.name = "DisassemblyError";
  }
}

/** .NET's `EndOfStreamException` message. */
export const END_OF_STREAM = "Unable to read beyond the end of the stream.";

/**
 * A `BinaryReader` over a `MemoryStream`: little-endian, the position free to
 * move past the end, and a read past the end failing as .NET's does.
 */
export class StreamReader {
  /** The read position, in bytes from the start. */
  position = 0;
  private readonly view: DataView;

  /** @param bytes the stream's bytes, read in place */
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** The stream's length. */
  get length(): number {
    return this.bytes.length;
  }

  private take(count: number): number {
    const at = this.position;
    if (at < 0 || at + count > this.bytes.length) throw new DisassemblyError(END_OF_STREAM);
    this.position = at + count;
    return at;
  }

  /** `ReadByte`. */
  readUInt8(): number {
    return this.bytes[this.take(1)]!;
  }

  /** `ReadInt32`. */
  readInt32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  /** `ReadUInt32`. */
  readUInt32(): number {
    return this.view.getUint32(this.take(4), true);
  }
}
