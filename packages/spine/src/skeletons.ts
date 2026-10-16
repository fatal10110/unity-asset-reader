import { ClassID, CorruptError, ResourceNotFoundError, UnsupportedError } from "unity-asset-reader";
import type {
  Asset,
  Env,
  MonoScript,
  ObjectReader,
  PPtr,
  PPtrResolution,
  TypeTreeObject,
  TypeTreeValue,
} from "unity-asset-reader";

/** One atlas of a {@link SpineSkeleton}: a `SpineAtlasAsset` of spine-unity. */
export interface SpineAtlas {
  /**
   * The atlas text, `atlasFile`: the `.atlas.txt` file Spine exported, which
   * names the pages and the regions on them.
   */
  atlas: Asset<"TextAsset">;
  /**
   * The atlas page textures: the `_MainTex` of each of the atlas asset's
   * `materials`, in that order. spine-unity matches them to the pages the
   * atlas text names by texture name, so the order need not be the text's.
   */
  pages: Asset<"Texture2D">[];
}

/** A skeleton as spine-unity stores it: a `SkeletonDataAsset` and what it points at. */
export interface SpineSkeleton {
  /** The `SkeletonDataAsset`'s `m_Name` (`"hero_SkeletonData"`). */
  name: string;
  /**
   * The skeleton data, `skeletonJSON`: Spine's JSON export (`.json`) or its
   * binary export (`.skel.bytes`), as stored.
   */
  skeleton: Asset<"TextAsset">;
  /**
   * The atlases, `atlasAssets`, in that order. A null entry, which
   * spine-unity skips, is left out.
   */
  atlases: SpineAtlas[];
}

/**
 * Every Spine skeleton of an env, as spine-unity (3.8 to 4.2) stores it: a
 * `SkeletonDataAsset` MonoBehaviour whose `skeletonJSON` is the skeleton
 * data and whose `atlasAssets` are `SpineAtlasAsset`s, each with an
 * `atlasFile` (the atlas text) and `materials`, whose `_MainTex` textures are
 * the atlas pages.
 *
 * The objects are recognized by those field names in their type trees, not
 * by their script's name, so a project's renamed or forked copies of the
 * spine-unity classes are found as long as they keep the fields. A file built
 * without type trees (`DisableWriteTypeTree`, or a player build with type
 * trees stripped) has no field names to go by: reading a script's fields
 * without them takes its assembly, which this library does not do (plan §7).
 *
 * The pointers are followed with `env.resolve`, so a skeleton's atlases,
 * materials and textures may be in other bundles, as long as they are loaded
 * too.
 *
 * @param env the env to search
 * @returns the skeletons, in `env.assets()` order
 * @throws {UnsupportedError} for a MonoBehaviour whose script is spine-unity's
 *   `SkeletonDataAsset` in a file without type trees; for an `atlasAssets`
 *   entry that has no `atlasFile` and `materials` fields (another atlas type,
 *   such as `SpineSpriteAtlasAsset`); and for an atlas whose
 *   `textureLoadingMode` is not `Normal` (spine-unity 4.1+ on-demand loading,
 *   where the materials hold placeholder textures rather than the pages)
 * @throws {ResourceNotFoundError} when a pointer leads into a file that is
 *   not loaded, naming that file
 * @throws {CorruptError} when `skeletonJSON`, an atlas' `atlasFile`, one of
 *   its `materials` or a material's `_MainTex` is a null or dangling pointer,
 *   or points at an object of another class
 * @throws what `env.assets()`, `env.resolve` and reading the objects throw
 */
export function spineSkeletons(env: Env): SpineSkeleton[] {
  let assets: Map<ObjectReader, Asset> | undefined;
  const assetOf = (reader: ObjectReader): Asset => {
    assets ??= new Map([...env.assets()].map((asset) => [asset.reader, asset]));
    // Every object a pointer resolves to is one of the env's.
    return assets.get(reader)!;
  };

  const skeletons: SpineSkeleton[] = [];
  for (const asset of env.assets("MonoBehaviour")) {
    const fields = fieldTypes(asset.reader);
    if (!fields) {
      if (isSkeletonScript(env, asset)) {
        throw new UnsupportedError(
          "MonoBehaviour without type tree",
          `${asset.name} (path id ${asset.pathId})`,
          `${asset.file}: a spine-unity SkeletonDataAsset in a file built without type trees; ` +
            "its fields cannot be read without its assembly",
        );
      }
      continue;
    }
    if (!isPPtr(fields.get("skeletonJSON")) || fields.get("atlasAssets") !== "vector") continue;

    const what = `SkeletonDataAsset ${asset.name} (path id ${asset.pathId}, ${asset.file})`;
    const data = scriptFields(asset);
    const follow = (pointer: unknown, classId: number, field: string) =>
      assetOf(target(env, asset.reader, pointer, classId, `${what}: ${field}`));
    const atlases: SpineAtlas[] = [];
    list(data.atlasAssets, `${what}: atlasAssets`).forEach((pointer, i) => {
      // spine-unity skips a null entry (SkeletonDataAsset.GetAtlasArray).
      if (pptr(pointer, `${what}: atlasAssets[${i}]`).m_PathID === 0n) return;
      const atlasAsset = follow(pointer, ClassID.MonoBehaviour, `atlasAssets[${i}]`);
      atlases.push(readAtlas(env, atlasAsset as Asset<"MonoBehaviour">, assetOf));
    });
    skeletons.push({
      name: asset.name,
      skeleton: follow(data.skeletonJSON, ClassID.TextAsset, "skeletonJSON") as Asset<"TextAsset">,
      atlases,
    });
  }
  return skeletons;
}

/** A `SpineAtlasAsset`: its `atlasFile` and the `_MainTex` of each of its `materials`. */
function readAtlas(
  env: Env,
  asset: Asset<"MonoBehaviour">,
  assetOf: (reader: ObjectReader) => Asset,
): SpineAtlas {
  const what = `SpineAtlasAsset ${asset.name} (path id ${asset.pathId}, ${asset.file})`;
  const fields = fieldTypes(asset.reader);
  if (!fields) {
    throw new UnsupportedError(
      "MonoBehaviour without type tree",
      `${asset.name} (path id ${asset.pathId})`,
      `${asset.file}: a SkeletonDataAsset's atlas asset in a file built without type trees`,
    );
  }
  if (!isPPtr(fields.get("atlasFile")) || fields.get("materials") !== "vector") {
    throw new UnsupportedError(
      "Spine atlas asset",
      `${asset.name} (path id ${asset.pathId})`,
      `${asset.file}: it has no atlasFile and materials fields, so it is not a SpineAtlasAsset`,
    );
  }
  const data = scriptFields(asset);
  // 4.1+ with SPINE_OPTIONAL_ON_DEMAND_LOADING: AtlasAssetBase.LoadingMode, Normal = 0.
  // OnDemand builds put placeholder textures in the materials, not the pages.
  const loading = data.textureLoadingMode;
  if (loading !== undefined && loading !== 0) {
    throw new UnsupportedError(
      "Spine texture loading mode",
      loading === 1 ? "OnDemand" : String(loading),
      `${what}: its materials hold placeholder textures; the pages are loaded at run time`,
    );
  }
  const from = asset.reader;
  const atlasFile = target(env, from, data.atlasFile, ClassID.TextAsset, `${what}: atlasFile`);
  const pages = list(data.materials, `${what}: materials`).map((pointer, i) => {
    const field = `${what}: materials[${i}]`;
    const material = assetOf(
      target(env, from, pointer, ClassID.Material, field),
    ) as Asset<"Material">;
    // spine-unity takes `material.mainTexture`, the `_MainTex` slot of its shaders.
    const slot = material.data.savedProperties.texEnvs.find(([name]) => name === "_MainTex");
    const where = `${field} ${material.name} (path id ${material.pathId})`;
    if (!slot) throw new CorruptError(`${where} has no _MainTex slot`);
    const texture = slot[1].texture;
    const page = target(env, material.reader, texture, ClassID.Texture2D, `${where}: _MainTex`);
    return assetOf(page) as Asset<"Texture2D">;
  });
  return { atlas: assetOf(atlasFile) as Asset<"TextAsset">, pages };
}

/**
 * The type of each of a MonoBehaviour's top-level fields, by name, from its
 * type tree, without reading its data; `undefined` without a type tree.
 */
function fieldTypes(reader: ObjectReader): Map<string, string> | undefined {
  const nodes = reader.serializedType?.nodes;
  if (!nodes || nodes.length === 0) return undefined;
  return new Map(nodes.filter((node) => node.level === 1).map((node) => [node.name, node.type]));
}

/** A field type of a pointer: `PPtr<TextAsset>`, or `PPtr<$TextAsset>` in a script's type tree. */
function isPPtr(type: string | undefined): boolean {
  return type?.startsWith("PPtr<") ?? false;
}

/** The script's own fields of a MonoBehaviour that has a type tree. */
function scriptFields(asset: Asset<"MonoBehaviour">): TypeTreeObject {
  // `fields` is there whenever the file has a type tree, which fieldTypes checked.
  return asset.data.fields!;
}

/**
 * Whether a MonoBehaviour without a type tree is spine-unity's
 * `SkeletonDataAsset`, by its script's class name. `false` when its script
 * cannot be found, since then nothing says what it is.
 */
function isSkeletonScript(env: Env, asset: Asset<"MonoBehaviour">): boolean {
  const script = env.resolve(asset.data.script, asset.reader);
  if (script.status !== "found" || script.object.type !== ClassID.MonoScript) return false;
  return script.object.read<MonoScript>().m_ClassName === "SkeletonDataAsset";
}

/** A type tree array, which a `vector` field is. */
function list(value: TypeTreeValue | undefined, what: string): TypeTreeValue[] {
  if (!Array.isArray(value)) throw new CorruptError(`${what} is not an array`);
  return value;
}

/** A value that is a pointer, `{ m_FileID, m_PathID }`, as a type tree reads one. */
function pptr(value: unknown, what: string): PPtr {
  const object = value as Partial<PPtr> | undefined;
  if (typeof object?.m_FileID !== "number" || typeof object.m_PathID !== "bigint") {
    throw new CorruptError(`${what} is not a pointer`);
  }
  return { m_FileID: object.m_FileID, m_PathID: object.m_PathID };
}

/** The object a pointer field points at, which must be of class `classId`. */
function target(
  env: Env,
  from: ObjectReader,
  value: unknown,
  classId: number,
  what: string,
): ObjectReader {
  const pointer = pptr(value, what);
  const object = found(env.resolve(pointer, from), pointer, what);
  if (object.type !== classId) {
    throw new CorruptError(
      `${what} (path id ${object.pathId}) is class ${object.type}, not ${classId}`,
    );
  }
  return object;
}

/** The object of a resolution, or the error saying why there is none. */
function found(resolution: PPtrResolution, pointer: PPtr, what: string): ObjectReader {
  switch (resolution.status) {
    case "found":
      return resolution.object;
    case "fileNotLoaded": {
      const error = new ResourceNotFoundError(resolution.fileName, resolution.fileName);
      error.message =
        `${what} (path id ${pointer.m_PathID}) is in ${resolution.fileName}, which is not ` +
        "loaded: pass it to load() too";
      throw error;
    }
    case "null":
      throw new CorruptError(`${what} is a null pointer`);
    case "fileIdOutOfRange":
      throw new CorruptError(`${what} has file id ${pointer.m_FileID}, past the file's externals`);
    case "objectNotFound":
      throw new CorruptError(
        `${what} (path id ${pointer.m_PathID}) is not in ${resolution.fileName}`,
      );
  }
}
