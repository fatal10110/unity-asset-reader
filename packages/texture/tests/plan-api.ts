// Not run: typechecked by tests/plan-api.test.ts, against the built dist/*.d.ts
// of both packages, so plan section 3's public API keeps compiling as written.
import { ClassID, load } from "unity-asset-reader";
import {
  decodeCubemap,
  decodeTexture2D,
  decodeTexture2DArray,
  decodeTexture3D,
  initTexture,
  type RgbaImage,
} from "unity-asset-reader-texture";

declare const u8: Uint8Array;
declare const u8b: Uint8Array;
declare function show(data: Uint8Array, width: number, height: number): void;

await initTexture({ wasmPath: "/wasm" });

const env = load([{ name: "a.bundle", data: u8 }, { name: "a.resS", data: u8b }]);
for (const obj of env.objects) {
  if (obj.type === ClassID.Texture2D) {
    const { data, width, height } = await decodeTexture2D(obj.read());
    show(data, width, height);
  }
  // #331: faces and slices, one RgbaImage each.
  let layers: RgbaImage[] = [];
  if (obj.type === ClassID.Cubemap) layers = await decodeCubemap(obj.read(), { mip: 1 });
  if (obj.type === ClassID.Texture2DArray) layers = await decodeTexture2DArray(obj.read());
  if (obj.type === ClassID.Texture3D) layers = await decodeTexture3D(obj.read(), {});
  for (const { data, width, height } of layers) show(data, width, height);
}
