import type { UnityVersion } from "../serialized/SerializedFile.js";

/**
 * Whether `version` is `major.minor.patch` or later, for the version gates of
 * the class readers. Internal: not exported from the package.
 *
 * Compares release numbers only, as upstream's gates do: the build type and
 * build number (`f1`, `b3`) are ignored, so every pre-release of a version
 * counts as that version.
 */
export function atLeast(
  [major, minor, patch]: UnityVersion,
  wantMajor: number,
  wantMinor: number,
  wantPatch = 0,
): boolean {
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}

/**
 * Whether `version` is `major.minor.patch` or a later patch of that same
 * `major.minor`: a field Unity backported to one release line in a patch.
 * Internal, as {@link atLeast}.
 */
export function patchFrom(
  version: UnityVersion,
  major: number,
  minor: number,
  patch: number,
): boolean {
  return version[0] === major && version[1] === minor && version[2] >= patch;
}
