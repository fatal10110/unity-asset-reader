import { readAssetBundle } from "./classes/AssetBundle.js";
import type { PPtr } from "./classes/PPtr.js";
import type { Env } from "./env.js";
import { CorruptError, ResourceNotFoundError } from "./errors.js";
import { ClassID } from "./serialized/ClassID.js";
import type { ObjectReader } from "./serialized/ObjectReader.js";

/**
 * Follow a pointer that must lead somewhere: {@link Env.resolve}, with every
 * status but `found` turned into an error that names the field. For feature
 * packages that need the object a field points at, and cannot go on without it.
 *
 * @param env the env that loaded `from`
 * @param pptr the pointer, as a typetree holds it
 * @param from the object whose data the pointer was read from
 * @param what the field, for the error messages, such as
 *   `sprite "hero" (path id 5)'s texture`
 * @param classId when given, the class the object must be of
 * @returns the object the pointer names
 * @throws {ResourceNotFoundError} when the pointer is into a SerializedFile
 *   that is not loaded; its `path` and `fileName` are that file's name. When
 *   an `AssetBundle` object in `from`'s file declares dependencies
 *   (`m_Dependencies`, Unity 5.0+), the message ends with them, as
 *   `(this bundle declares dependencies: a, b)`: bundle names, not file names,
 *   to narrow down which file to load
 * @throws {CorruptError} when the pointer is null, its file id is past the
 *   file's externals, its object is not in its file, or the object is not of
 *   class `classId`
 * @throws {Error} / {UnsupportedError} as {@link Env.resolve} does
 */
export function resolveOrThrow(
  env: Env,
  pptr: PPtr,
  from: ObjectReader,
  what: string,
  classId?: number,
): ObjectReader {
  const resolution = env.resolve(pptr, from);
  switch (resolution.status) {
    case "found": {
      const object = resolution.object;
      if (classId !== undefined && object.type !== classId) {
        throw new CorruptError(
          `${what} (path id ${object.pathId}) is class ${object.type}, not ${classId}`,
        );
      }
      return object;
    }
    case "fileNotLoaded": {
      const { fileName } = resolution;
      const error = new ResourceNotFoundError(fileName, fileName);
      const dependencies = declaredDependencies(env, from);
      error.message =
        `${what} (path id ${pptr.m_PathID}) is in ${fileName}, which is not loaded: ` +
        "pass it to load() too" +
        (dependencies.length > 0
          ? ` (this bundle declares dependencies: ${dependencies.join(", ")})`
          : "");
      throw error;
    }
    case "null":
      throw new CorruptError(`${what} is a null pointer`);
    case "fileIdOutOfRange":
      throw new CorruptError(`${what} has file id ${pptr.m_FileID}, past the file's externals`);
    case "objectNotFound":
      throw new CorruptError(`${what} (path id ${pptr.m_PathID}) is not in ${resolution.fileName}`);
  }
}

/**
 * The bundle names the `AssetBundle` objects of `from`'s SerializedFile declare
 * (`m_Dependencies`, Unity 5.0+), each once, for the `fileNotLoaded` message.
 * Empty when the file holds no `AssetBundle`, the field is absent or empty, or
 * an `AssetBundle` cannot be read: the hint must never replace the error it is
 * added to. `env.objects` is already parsed, since `env.resolve` just ran.
 */
function declaredDependencies(env: Env, from: ObjectReader): string[] {
  const names = new Set<string>();
  for (const object of env.objects) {
    if (object.type !== ClassID.AssetBundle || object.fileName !== from.fileName) continue;
    // The reader may be one the caller is reading too: leave it where it was.
    const at = object.position;
    try {
      for (const name of readAssetBundle(object).m_Dependencies ?? []) names.add(name);
    } catch {
      // No hint from an AssetBundle this library cannot read.
    } finally {
      object.position = at;
    }
  }
  return [...names];
}
