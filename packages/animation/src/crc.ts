// Ported from AssetStudio/7zip/Common/CRC.cs (MIT, © Perfare / RazTools / Razviar)

import { crc32 as crc32Bytes } from "unity-asset-reader";

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
  return crc32Bytes(UTF8.encode(text));
}
