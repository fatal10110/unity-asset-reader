// The #335 calls, compiled under the package's strict flags by
// raw-input.test.ts, never run. A Texture2D built by hand must compile
// without a cast, and `obj.read()` must keep inferring its type (plan
// section 3). Each `@ts-expect-error` fails the compile if the line after it
// stops being an error.

import type { ObjectReader, Texture2DData } from "unity-asset-reader";
import { decodeTexture2D } from "../../src/index.js";
import type { DecodeTexture2DOptions, RgbaImage } from "../../src/index.js";

/** The issue's repro, and the other inputs that must compile. */
export async function accepted(obj: ObjectReader, read: Texture2DData): Promise<RgbaImage[]> {
  const unity: DecodeTexture2DOptions = { crunch: "unity" };
  return [
    await decodeTexture2D({
      m_Width: 4,
      m_Height: 4,
      m_TextureFormat: 4,
      imageData: new Uint8Array(64),
    }),
    await decodeTexture2D(
      { m_Width: 4, m_Height: 4, m_TextureFormat: 28, imageData: new Uint8Array(0), platform: 5 },
      { crunch: "original" },
    ),
    await decodeTexture2D(obj.read()),
    await decodeTexture2D(read, unity),
    await decodeTexture2D(read, {}),
  ];
}

/** What must not compile. */
export async function refused(): Promise<void> {
  // @ts-expect-error imageData is required
  await decodeTexture2D({ m_Width: 4, m_Height: 4, m_TextureFormat: 4 });
  // @ts-expect-error m_TextureFormat is required
  await decodeTexture2D({ m_Width: 4, m_Height: 4, imageData: new Uint8Array(64) });
  // @ts-expect-error m_Width is a number
  await decodeTexture2D({ m_Width: "4", m_Height: 4, m_TextureFormat: 4, imageData: new Uint8Array() });
  const input = { m_Width: 4, m_Height: 4, m_TextureFormat: 28, imageData: new Uint8Array(0) };
  // @ts-expect-error crunch is "unity" or "original"
  await decodeTexture2D(input, { crunch: "legacy" });
}
