import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import {
  readTypeTree,
  type Asset,
  type AudioClipData,
  type Env,
  type MeshData,
  type ObjectReader,
  type Shader,
  type TextAsset,
} from "unity-asset-reader";
import {
  Fsb5Codec,
  fsb5ToOgg,
  fsb5ToWav,
  readFsb5,
  type VorbisSetupHeader,
} from "unity-asset-reader-audio";
import { meshToGltf, meshToObj } from "unity-asset-reader-mesh";
import { shaderToText } from "unity-asset-reader-shader";
import {
  decodeImage,
  encodePng,
  packedSprites,
  type PackedSprite,
  type RgbaImage,
} from "unity-asset-reader-texture";

import type { Io } from "./main.js";
import { describeError, jsonReplacer, UsageError } from "./util.js";

/** The mesh file format `extract` writes: Wavefront OBJ or binary glTF. */
export type MeshFormat = "obj" | "glb";

/** Vorbis setup headers by CRC-32, as `fsb5ToOgg` takes them. */
export type VorbisHeaders = ReadonlyMap<number, VorbisSetupHeader>;

/** What `extract` was asked for. */
export interface ExtractOptions {
  /** The directory to write into. */
  output: string;
  /** The classes to write; {@link DEFAULT_TYPES} when undefined. */
  types: ReadonlySet<string> | undefined;
  /** The file format of meshes. */
  mesh: MeshFormat;
  /** Setup headers for Vorbis AudioClips; without them those are skipped. */
  vorbisHeaders: VorbisHeaders | undefined;
}

/** The classes `extract` writes without `--type`: the ones with an exporter of their own. */
export const DEFAULT_TYPES: ReadonlySet<string> = new Set([
  "Texture2D",
  "Sprite",
  "TextAsset",
  "AudioClip",
  "Mesh",
  "Shader",
]);

/**
 * Read a Vorbis setup header table: a JSON object from each CRC-32 (decimal)
 * to `{ headerBytes: <base64>, seekBit: <number> }`, the shape of Fmod5Sharp's
 * `vorbis_headers_converted.json` (unity-asset-reader-audio README).
 *
 * @param path the JSON file
 * @returns the headers by CRC-32
 * @throws {UsageError} when the file cannot be read or does not have that shape
 */
export function readVorbisHeaders(path: string): VorbisHeaders {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`--vorbis-headers ${path}: ${describeError(error)}`);
  }
  const bad = (what: string): UsageError =>
    new UsageError(
      `--vorbis-headers ${path}: ${what}; expected an object from each CRC-32 to ` +
        "{ headerBytes: <base64>, seekBit: <number> }",
    );
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw bad("not an object");
  const headers = new Map<number, VorbisSetupHeader>();
  for (const [key, entry] of Object.entries(json)) {
    const crc = Number(key);
    if (!/^\d+$/.test(key) || crc > 0xffffffff) throw bad(`key "${key}" is not a CRC-32`);
    const { headerBytes, seekBit } = (entry ?? {}) as { headerBytes?: unknown; seekBit?: unknown };
    if (typeof headerBytes !== "string" || !Number.isInteger(seekBit)) {
      throw bad(`entry ${key} has no string headerBytes and integer seekBit`);
    }
    headers.set(crc, {
      headerBytes: new Uint8Array(Buffer.from(headerBytes, "base64")),
      seekBit: seekBit as number,
    });
  }
  return headers;
}

/** One exported file, or why the asset was skipped. */
type Exported = { ext: string; bytes: Uint8Array } | { skip: string };

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * `extract`: write each selected asset as a file under `<output>/<class>/`,
 * in `env.assets()` order. An asset that fails is reported and the rest are
 * still written; a Vorbis AudioClip without setup headers is reported as
 * skipped. Prints each file written (relative to `output`) to `io.out`, the
 * failures, skips and a summary to `io.err`.
 *
 * @param env what `loadPath` loaded
 * @param options the output directory, the classes and the formats
 * @param io where to report
 * @returns 1 when an asset failed, else 0
 */
export async function extract(env: Env, options: ExtractOptions, io: Io): Promise<number> {
  const types = options.types ?? DEFAULT_TYPES;
  const out = new OutputDir(options.output);
  const tally = { written: 0, skipped: 0, failed: 0 };
  // The atlases sprites cut from, decoded once per run. Only sprites fill it, so a
  // run does not hold every Texture2D it wrote in memory.
  const atlases = new Map<ObjectReader, RgbaImage>();

  const one = async (
    dir: string,
    label: string,
    reader: ObjectReader,
    name: () => string,
    exporter: () => Exported | Promise<Exported>,
  ): Promise<void> => {
    let what = `${label} (${reader.fileName}, path id ${reader.pathId})`;
    try {
      const base = name();
      what = `${label} "${base}" (${reader.fileName}, path id ${reader.pathId})`;
      const result = await exporter();
      if ("skip" in result) {
        io.err(`skipped: ${what}: ${result.skip}\n`);
        tally.skipped++;
        return;
      }
      io.out(`${out.write(dir, base, reader.pathId, result.ext, result.bytes)}\n`);
      tally.written++;
    } catch (error) {
      io.err(`failed: ${what}: ${describeError(error)}\n`);
      tally.failed++;
    }
  };

  for (const asset of env.assets()) {
    // Unity 6000.6 atlases hold their sprites themselves, with no Sprite objects.
    if (asset.type === "SpriteAtlas" && types.has("Sprite")) {
      let sprites: PackedSprite[] = [];
      try {
        sprites = packedSprites(asset);
      } catch (error) {
        const at = `${asset.reader.fileName}, path id ${asset.pathId}`;
        io.err(`failed: SpriteAtlas sprites (${at}): ${describeError(error)}\n`);
        tally.failed++;
      }
      for (const sprite of sprites) {
        await one("Sprite", "packed Sprite", asset.reader, () => sprite.name, () => image(sprite, atlases));
      }
    }
    if (!types.has(asset.typeName)) continue;
    await one(
      asset.typeName,
      asset.typeName,
      asset.reader,
      () => asset.name,
      () => exportAsset(asset, options, atlases),
    );
  }

  io.err(
    `extract: ${tally.written} written, ${tally.skipped} skipped, ${tally.failed} failed` +
      ` (${options.output})\n`,
  );
  return tally.failed > 0 ? 1 : 0;
}

/**
 * A Texture2D or Sprite as a PNG. `atlases` caches the textures sprites are
 * cut from; a Texture2D is decoded without it.
 */
async function image(
  asset: Asset<"Texture2D" | "Sprite"> | PackedSprite,
  atlases: Map<ObjectReader, RgbaImage>,
): Promise<Exported> {
  const options = asset.type === "Texture2D" ? {} : { decodedTextures: atlases };
  const { rgba, width, height } = await decodeImage(asset, options);
  // A dynamic font's texture, before Unity renders glyphs into it.
  if (width === 0 || height === 0) return { skip: `${width} x ${height} image, no pixels` };
  return { ext: "png", bytes: encodePng({ data: rgba, width, height }) };
}

/** One asset's file, by its class. */
async function exportAsset(
  asset: Asset,
  options: ExtractOptions,
  atlases: Map<ObjectReader, RgbaImage>,
): Promise<Exported> {
  const reader = asset.reader;
  switch (asset.type) {
    case "Texture2D":
    case "Sprite":
      return image(asset, atlases);
    case "TextAsset": {
      // The bytes as they are; .txt when they are UTF-8 text, .bytes otherwise.
      const bytes = reader.read<TextAsset>().m_Script;
      return { ext: isUtf8(bytes) ? "txt" : "bytes", bytes };
    }
    case "AudioClip": {
      const bytes = reader.read<AudioClipData>().audioData;
      if (readFsb5(bytes).codec !== Fsb5Codec.VORBIS) {
        return { ext: "wav", bytes: fsb5ToWav(bytes) };
      }
      if (!options.vorbisHeaders) {
        return { skip: "Vorbis audio; pass --vorbis-headers <file> to write it as .ogg" };
      }
      return { ext: "ogg", bytes: fsb5ToOgg(bytes, options.vorbisHeaders) };
    }
    case "Mesh": {
      const mesh = reader.read<MeshData>();
      return options.mesh === "glb"
        ? { ext: "glb", bytes: meshToGltf(mesh) }
        : { ext: "obj", bytes: utf8.encode(meshToObj(mesh)) };
    }
    case "Shader":
      return { ext: "txt", bytes: utf8.encode(shaderToText(reader.read<Shader>())) };
    default: {
      const text = JSON.stringify(readTypeTree(reader), jsonReplacer, 2);
      return { ext: "json", bytes: utf8.encode(`${text}\n`) };
    }
  }
}

/** Whether bytes are valid UTF-8. */
function isUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Characters no file name may hold on Windows, macOS or Linux. */
const UNSAFE = /[\u0000-\u001f<>:"/\\|?*]/g;

/** The output directory: a folder per class, and file names that never repeat in one run. */
class OutputDir {
  private readonly used = new Set<string>();

  constructor(private readonly root: string) {}

  /**
   * Write one file as `<class>/<name>.<ext>`. A name taken earlier in this
   * run (ignoring case, for case-insensitive file systems) gets the path id,
   * `<name>_<pathId>.<ext>`, and then a counter; an empty name is the path id.
   *
   * @returns the path written, relative to the root, with `/`
   */
  write(dir: string, name: string, pathId: bigint, ext: string, bytes: Uint8Array): string {
    const safe = name.replace(UNSAFE, "_").replace(/[. ]+$/, "");
    const base = safe === "" ? String(pathId) : safe;
    const candidates = function* (): Generator<string> {
      yield base;
      yield `${base}_${pathId}`;
      for (let n = 2; ; n++) yield `${base}_${pathId}_${n}`;
    };
    let file = "";
    for (const candidate of candidates()) {
      file = `${dir}/${candidate}.${ext}`;
      if (!this.used.has(file.toLowerCase())) break;
    }
    this.used.add(file.toLowerCase());
    mkdirSync(join(this.root, dir), { recursive: true });
    writeFileSync(join(this.root, file), bytes);
    return file;
  }
}
