// Ported from AssetStudio.Utility/YAML/AnimationClipExtensions.cs (MIT, © Perfare / RazTools / Razviar)
import type {
  Animation,
  AnimationClip,
  Animator,
  AnimatorController,
  Avatar,
  Env,
  GameObject,
  ObjectReader,
  PPtr,
  Transform,
} from "unity-asset-reader";
import { crc32 } from "./crc.js";

/** Class ids of the objects the lookups read. */
export const CLASS = {
  GameObject: 1,
  Transform: 4,
  Material: 21,
  MeshRenderer: 23,
  Mesh: 43,
  AnimationClip: 74,
  Avatar: 90,
  AnimatorController: 91,
  Animator: 95,
  Animation: 111,
  SkinnedMeshRenderer: 137,
} as const;

/**
 * The loaded objects a clip's curves are named from, each read once: upstream
 * reads every object when it loads the files, and keeps it.
 */
export class Scene {
  private readonly data = new Map<ObjectReader, unknown>();
  private sorted: ObjectReader[] | undefined;

  constructor(readonly env: Env) {}

  /** An object's data, read on first use. */
  read<T>(obj: ObjectReader): T {
    if (!this.data.has(obj)) this.data.set(obj, obj.read());
    return this.data.get(obj) as T;
  }

  /**
   * The object a pointer reaches when it is of class `classId` (upstream
   * `PPtr<T>.TryGet`), or `undefined`.
   */
  tryGet(pptr: PPtr, from: ObjectReader, classId: number): ObjectReader | undefined {
    const found = this.env.resolve(pptr, from);
    return found.status === "found" && found.object.type === classId ? found.object : undefined;
  }

  /**
   * A GameObject's last component of class `classId`: upstream's
   * `AssetsManager` sets `m_Transform`, `m_SkinnedMeshRenderer` and
   * `m_MeshRenderer` going through `m_Component` in order, each later one
   * replacing the one before.
   *
   * ponytail: upstream's `Transform` includes `RectTransform` (224), which has
   * no reader in core; only class 4 counts, so a UI hierarchy's paths stay
   * unresolved. Upgrade: a RectTransform reader in core (#315).
   */
  component(go: ObjectReader, classId: number): ObjectReader | undefined {
    let last: ObjectReader | undefined;
    for (const { component } of this.read<GameObject>(go).m_Component) {
      last = this.tryGet(component, go, classId) ?? last;
    }
    return last;
  }

  /**
   * Every loaded object ordered by class id, file order kept within a class
   * (upstream's stable `OrderBy(x => x.type)` in `FindTOS`).
   */
  byType(): ObjectReader[] {
    this.sorted ??= [...this.env.objects].sort((a, b) => a.type - b.type);
    return this.sorted;
  }
}

/**
 * Whether the Animator's controller lists the clip (upstream
 * `IsAnimatorContainsClip`): only an `AnimatorController` counts, not an
 * `AnimatorOverrideController`, as upstream.
 */
function animatorContainsClip(scene: Scene, animator: ObjectReader, clip: ObjectReader): boolean {
  const controller = scene.tryGet(
    scene.read<Animator>(animator).m_Controller,
    animator,
    CLASS.AnimatorController,
  );
  if (!controller) return false;
  return scene
    .read<AnimatorController>(controller)
    .m_AnimationClips.some((ptr) => scene.tryGet(ptr, controller, CLASS.AnimationClip) === clip);
}

/**
 * Whether the legacy `Animation` component lists the clip in `m_Animations`
 * (upstream `IsAnimationContainsClip`); its default clip `m_Animation` does
 * not count, as upstream.
 */
function animationContainsClip(scene: Scene, animation: ObjectReader, clip: ObjectReader): boolean {
  return scene
    .read<Animation>(animation)
    .m_Animations.some((ptr) => scene.tryGet(ptr, animation, CLASS.AnimationClip) === clip);
}

/**
 * Copy into `dest` the paths of `src` the clip's bindings use (upstream
 * `AddTOS`). True, which ends the search, once `dest` holds as many paths as
 * the clip has bindings, `{0: ""}` included, as upstream counts.
 */
function addTOS(clip: AnimationClip, src: Map<number, string>, dest: Map<number, string>): boolean {
  const bindings = clip.m_ClipBindingConstant.genericBindings;
  for (const binding of bindings) {
    const path = src.get(binding.path);
    if (path === undefined) continue;
    dest.set(binding.path, path);
    if (dest.size === bindings.length) return true;
  }
  return false;
}

/** An Avatar's path table (`m_TOS`). */
function avatarTOS(scene: Scene, avatar: ObjectReader): Map<number, string> {
  return new Map(scene.read<Avatar>(avatar).m_TOS);
}

/**
 * A GameObject's children, in `m_Children` order: each child Transform that
 * loads, with its GameObject. Shared by {@link buildTOS} and the glTF scene
 * export, so both walk the same hierarchy.
 *
 * @throws {Error} when the GameObject has no Transform, where upstream throws
 *   `NullReferenceException`
 */
export function children(
  scene: Scene,
  go: ObjectReader,
): { go: ObjectReader; transform: ObjectReader }[] {
  const transform = scene.component(go, CLASS.Transform);
  if (!transform) throw new Error(`GameObject ${go.pathId} has no Transform`);
  const found: { go: ObjectReader; transform: ObjectReader }[] = [];
  for (const childPtr of scene.read<Transform>(transform).m_Children) {
    const childTransform = scene.tryGet(childPtr, transform, CLASS.Transform);
    if (!childTransform) continue;
    const child = scene.tryGet(
      scene.read<Transform>(childTransform).m_GameObject,
      childTransform,
      CLASS.GameObject,
    );
    if (child) found.push({ go: child, transform: childTransform });
  }
  return found;
}

/**
 * The paths of a GameObject's hierarchy by their CRC-32 (upstream
 * `BuildTOS(GameObject)`): each child, by `m_Children`, as the names from the
 * GameObject down joined with `/`, the GameObject itself `""` at 0.
 *
 * @throws {Error} when a GameObject on the way has no Transform, where
 *   upstream throws `NullReferenceException`
 */
export function buildTOS(scene: Scene, go: ObjectReader): Map<number, string> {
  const tos = new Map<number, string>([[0, ""]]);
  const walk = (parent: ObjectReader, parentPath: string) => {
    for (const { go: child } of children(scene, parent)) {
      const name = scene.read<GameObject>(child).m_Name;
      const path = parentPath !== "" ? `${parentPath}/${name}` : name;
      tos.set(crc32(path), path);
      walk(child, path);
    }
  };
  walk(go, "");
  return tos;
}

/**
 * An Animator's paths (upstream `BuildTOS(Animator)`): its GameObject's
 * hierarchy, or only `{0: ""}` when the hierarchy was optimized away
 * (`m_HasTransformHierarchy` false). Upstream's branch for Unity before 4.3
 * is below the 2019 floor.
 *
 * @throws {Error} when the Animator has a hierarchy but its GameObject is not
 *   loaded, where upstream throws `NullReferenceException`
 */
function animatorTOS(scene: Scene, animator: ObjectReader): Map<number, string> {
  const data = scene.read<Animator>(animator);
  if (!data.m_HasTransformHierarchy) return new Map([[0, ""]]);
  const go = scene.tryGet(data.m_GameObject, animator, CLASS.GameObject);
  if (!go) throw new Error(`Animator ${animator.pathId}: its GameObject is not loaded`);
  return buildTOS(scene, go);
}

/**
 * The path of each binding's hash, as upstream's `FindTOS` collects it from
 * every loaded object ordered by class id:
 *
 * - every `Avatar` (90), whatever it animates: its `m_TOS`;
 * - every `Animator` (95) whose `AnimatorController` lists the clip: its
 *   Avatar's `m_TOS`, then its hierarchy (`BuildTOS`);
 * - every legacy `Animation` (111) that lists the clip: its GameObject's
 *   hierarchy (upstream `AddAnimationTOS`), when the GameObject is loaded.
 *
 * Each adds only the hashes the bindings use; the search stops once there is
 * a path per binding.
 *
 * @throws {Error} when a GameObject whose hierarchy is walked has no
 *   Transform (see {@link buildTOS})
 */
export function findTOS(
  scene: Scene,
  clipObj: ObjectReader,
  clip: AnimationClip,
): Map<number, string> {
  const tos = new Map<number, string>([[0, ""]]);
  for (const obj of scene.byType()) {
    if (obj.type === CLASS.Avatar) {
      if (addTOS(clip, avatarTOS(scene, obj), tos)) return tos;
    } else if (obj.type === CLASS.Animator && animatorContainsClip(scene, obj, clipObj)) {
      const avatar = scene.tryGet(scene.read<Animator>(obj).m_Avatar, obj, CLASS.Avatar);
      if (avatar && addTOS(clip, avatarTOS(scene, avatar), tos)) return tos;
      if (addTOS(clip, animatorTOS(scene, obj), tos)) return tos;
    } else if (obj.type === CLASS.Animation && animationContainsClip(scene, obj, clipObj)) {
      const go = scene.tryGet(scene.read<Animation>(obj).m_GameObject, obj, CLASS.GameObject);
      if (go && addTOS(clip, buildTOS(scene, go), tos)) return tos;
    }
  }
  return tos;
}

/**
 * The GameObjects that play the clip (upstream `FindRoots`), in file order:
 * each loaded `Animator`'s whose controller lists it, and each legacy
 * `Animation`'s that lists it.
 */
export function findRoots(scene: Scene, clipObj: ObjectReader): ObjectReader[] {
  const roots: ObjectReader[] = [];
  for (const obj of scene.env.objects) {
    let gameObject: PPtr;
    if (obj.type === CLASS.Animator && animatorContainsClip(scene, obj, clipObj)) {
      gameObject = scene.read<Animator>(obj).m_GameObject;
    } else if (obj.type === CLASS.Animation && animationContainsClip(scene, obj, clipObj)) {
      gameObject = scene.read<Animation>(obj).m_GameObject;
    } else continue;
    const go = scene.tryGet(gameObject, obj, CLASS.GameObject);
    if (go) roots.push(go);
  }
  return roots;
}
