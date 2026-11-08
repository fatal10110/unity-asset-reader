// Ported from AssetStudio.Utility/YAML/CustomCurveResolver.cs (MIT, © Perfare / RazTools / Razviar)
import type {
  GameObject,
  Material,
  MeshData,
  ObjectReader,
  Renderer,
  SkinnedMeshRenderer,
  Transform,
} from "unity-asset-reader";
import { crc32 } from "./crc.js";
import { CLASS, findRoots, type Scene } from "./tos.js";

/** Upstream `BindingCustomType`: what a binding's `customType` animates. */
export const BindingCustomType = {
  None: 0,
  Transform: 4,
  AnimatorMuscle: 8,
  BlendShape: 20,
  Renderer: 21,
  RendererMaterial: 22,
  SpriteRenderer: 23,
  MonoBehaviour: 24,
  Light: 25,
  RendererShadows: 26,
  ParticleSystem: 27,
  RectTransform: 28,
  LineRenderer: 29,
  TrailRenderer: 30,
  PositionConstraint: 31,
  RotationConstraint: 32,
  ScaleConstraint: 33,
  AimConstraint: 34,
  ParentConstraint: 35,
  LookAtConstraint: 36,
  Camera: 37,
} as const;

/** A path AssetStudio could not name: `path_<hash>`. */
export const UNKNOWN_PATH = /^path_[0-9]{1,10}$/;

/** Names a custom binding's attribute. */
export type AttributeNamer = (type: number, attribute: number, path: string) => string;

const LIGHT = [
  "m_Color.r",
  "m_Color.g",
  "m_Color.b",
  "m_Color.a",
  "m_CookieSize",
  "m_DrawHalo",
  "m_Intensity",
  "m_Range",
  "m_Shadows.m_Strength",
  "m_Shadows.m_Bias",
  "m_Shadows.m_NormalBias",
  "m_Shadows.m_NearPlane",
  "m_SpotAngle",
  "m_ColorTemperature",
];
const RECT_TRANSFORM = [
  "m_LocalPosition.z",
  "m_AnchoredPosition.x",
  "m_AnchoredPosition.y",
  "m_AnchorMin.x",
  "m_AnchorMin.y",
  "m_AnchorMax.x",
  "m_AnchorMax.y",
  "m_SizeDelta.x",
  "m_SizeDelta.y",
  "m_Pivot.x",
  "m_Pivot.y",
];
// The constraints' properties by `attribute & 0xF`; "[]" marks a source or
// offset array entry, indexed by `attribute >> 8`.
const SOURCES = ["m_Sources.Array.data[].sourceTransform", "m_Sources.Array.data[].weight"];
const POSITION_CONSTRAINT = [
  "m_RestTranslation.x",
  "m_RestTranslation.y",
  "m_RestTranslation.z",
  "m_Weight",
  "m_TranslationOffset.x",
  "m_TranslationOffset.y",
  "m_TranslationOffset.z",
  "m_AffectTranslationX",
  "m_AffectTranslationY",
  "m_AffectTranslationZ",
  "m_Active",
  ...SOURCES,
];
const ROTATION_CONSTRAINT = [
  "m_RestRotation.x",
  "m_RestRotation.y",
  "m_RestRotation.z",
  "m_Weight",
  "m_RotationOffset.x",
  "m_RotationOffset.y",
  "m_RotationOffset.z",
  "m_AffectRotationX",
  "m_AffectRotationY",
  "m_AffectRotationZ",
  "m_Active",
  ...SOURCES,
];
const SCALE_CONSTRAINT = [
  "m_ScaleAtRest.x",
  "m_ScaleAtRest.y",
  "m_ScaleAtRest.z",
  "m_Weight",
  "m_ScalingOffset.x",
  "m_ScalingOffset.y",
  "m_ScalingOffset.z",
  "m_AffectScalingX",
  "m_AffectScalingY",
  "m_AffectScalingZ",
  "m_Active",
  ...SOURCES,
];
const AIM_CONSTRAINT = [
  "m_Weight",
  "m_AffectRotationX",
  "m_AffectRotationY",
  "m_AffectRotationZ",
  "m_Active",
  "m_WorldUpObject",
  ...SOURCES,
];
const PARENT_CONSTRAINT = [
  "m_Weight",
  "m_AffectTranslationX",
  "m_AffectTranslationY",
  "m_AffectTranslationZ",
  "m_AffectRotationX",
  "m_AffectRotationY",
  "m_AffectRotationZ",
  "m_Active",
  "m_TranslationOffsets.Array.data[].x",
  "m_TranslationOffsets.Array.data[].y",
  "m_TranslationOffsets.Array.data[].z",
  "m_RotationOffsets.Array.data[].x",
  "m_RotationOffsets.Array.data[].y",
  "m_RotationOffsets.Array.data[].z",
  ...SOURCES,
];
const LOOK_AT_CONSTRAINT = ["m_Weight", "m_Active", "m_WorldUpObject", ...SOURCES, "m_Roll"];

const unknown = (type: number, attribute: number) =>
  new Error(`Unknown attribute ${attribute} for custom binding type ${type}`);

/** The name among `names` whose CRC-32 is `attribute`. */
function byCrc(names: string[], type: number, attribute: number): string {
  const name = names.find((n) => crc32(n) === attribute);
  if (name === undefined) throw unknown(type, attribute);
  return name;
}

/** A constraint's property by `attribute & 0xF`. */
function constraint(names: string[], type: number, attribute: number): string {
  const name = names[attribute & 0xf];
  if (name === undefined) throw unknown(type, attribute);
  return name.replace("[]", `[${attribute >>> 8}]`);
}

/**
 * The Transform at `path` below `transform`, by GameObject names (upstream
 * `FindChild`): the first child of each name; `transform` itself for `""`.
 */
function findChild(scene: Scene, transform: ObjectReader, path: string): ObjectReader | undefined {
  let current = transform;
  if (path.length === 0) return current;
  for (const childName of path.split("/")) {
    let next: ObjectReader | undefined;
    for (const childPtr of scene.read<Transform>(current).m_Children) {
      const child = scene.tryGet(childPtr, current, CLASS.Transform);
      if (!child) continue;
      const go = scene.tryGet(scene.read<Transform>(child).m_GameObject, child, CLASS.GameObject);
      if (go && scene.read<GameObject>(go).m_Name === childName) {
        next = child;
        break;
      }
    }
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/**
 * A material property whose CRC-32's low 28 bits are `crc28` (upstream
 * `FindPropertyNameByCRC28`): a texture's `_HDR`, `_ST` or `_TexelSize`, then
 * a float, then a color.
 */
function materialProperty(material: Material, crc28: number): string | undefined {
  const matches = (name: string) => (crc32(name) & 0xfffffff) === crc28;
  const sheet = material.m_SavedProperties;
  for (const [key] of sheet.m_TexEnvs) {
    for (const name of [`${key}_HDR`, `${key}_ST`, `${key}_TexelSize`]) {
      if (matches(name)) return name;
    }
  }
  for (const [key] of sheet.m_Floats) if (matches(key)) return key;
  for (const [key] of sheet.m_Colors) if (matches(key)) return key;
  return undefined;
}

/**
 * The attribute names of a clip's custom bindings (upstream
 * `CustomCurveResolver.ToAttributeName`). Blend shape and material curves are
 * named from the GameObjects that play the clip ({@link findRoots}): the
 * renderer at the curve's path below each, its mesh's blend shape channels or
 * its materials' properties; without one, the attribute stays a number.
 *
 * Upstream's gate for meshes before Unity 4.3 (blend shapes by name) is below
 * the 2019 floor.
 *
 * @param scene the loaded objects
 * @param clip the clip
 * @returns the namer; it throws an `Error` for an attribute upstream does not
 *   know, where upstream throws `ArgumentException`
 */
export function customCurveResolver(scene: Scene, clip: ObjectReader): AttributeNamer {
  let roots: ObjectReader[] | undefined;
  /** Each root's GameObject at `path` with a component found by `pick`, as upstream loops. */
  const fromRoots = <T>(path: string, pick: (go: ObjectReader) => T | undefined): T | undefined => {
    roots ??= findRoots(scene, clip);
    for (const root of roots) {
      const rootTransform = scene.component(root, CLASS.Transform);
      if (!rootTransform) throw new Error(`GameObject ${root.pathId} has no Transform`);
      const child = findChild(scene, rootTransform, path);
      if (!child) continue;
      const go = scene.tryGet(scene.read<Transform>(child).m_GameObject, child, CLASS.GameObject);
      const found = go && pick(go);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return (type, attribute, path) => {
    const T = BindingCustomType;
    switch (type) {
      case T.BlendShape: {
        const prefix = "blendShape.";
        if (UNKNOWN_PATH.test(path)) return prefix + attribute;
        const name = fromRoots(path, (go) => {
          const skin = scene.component(go, CLASS.SkinnedMeshRenderer);
          if (!skin) return undefined;
          const meshPtr = scene.read<SkinnedMeshRenderer>(skin).m_Mesh;
          const mesh = scene.tryGet(meshPtr, skin, CLASS.Mesh);
          if (!mesh) return undefined;
          return scene
            .read<MeshData>(mesh)
            .m_Shapes.channels.find((c) => c.nameHash >>> 0 === attribute)?.name;
        });
        return prefix + (name ?? attribute);
      }
      case T.Renderer:
        return `m_Materials.Array.data[${attribute}]`;
      case T.RendererMaterial: {
        const prefix = "material.";
        if (UNKNOWN_PATH.test(path)) return prefix + attribute;
        const property = fromRoots(path, (go) => {
          const renderer =
            scene.component(go, CLASS.SkinnedMeshRenderer) ??
            scene.component(go, CLASS.MeshRenderer);
          if (!renderer) return undefined;
          for (const ptr of scene.read<Renderer>(renderer).m_Materials) {
            const material = scene.tryGet(ptr, renderer, CLASS.Material);
            const name =
              material && materialProperty(scene.read<Material>(material), attribute & 0xfffffff);
            if (name !== undefined) return name;
          }
          return undefined;
        });
        if (property === undefined) return prefix + attribute;
        if ((attribute & 0x80000000) !== 0) return prefix + property;
        const rgba = (attribute & 0x40000000) !== 0;
        const sub = (rgba ? "rgba" : "xyzw")[(attribute >>> 28) & 3];
        return `${prefix}${property}.${sub}`;
      }
      case T.SpriteRenderer:
        if (attribute === 0) return "m_Sprite";
        throw unknown(type, attribute);
      case T.MonoBehaviour:
        return byCrc(["m_Enabled"], type, attribute);
      case T.Light:
        return byCrc(LIGHT, type, attribute);
      case T.RendererShadows:
        return byCrc(["m_ReceiveShadows", "m_SortingOrder"], type, attribute);
      case T.ParticleSystem:
        return "ParticleSystem_" + attribute;
      case T.RectTransform:
        return byCrc(RECT_TRANSFORM, type, attribute);
      case T.LineRenderer:
      case T.TrailRenderer: {
        const width = "m_Parameters.widthMultiplier";
        if (attribute === crc32(width)) return width;
        return (type === T.LineRenderer ? "LineRenderer_" : "TrailRenderer_") + attribute;
      }
      case T.PositionConstraint:
        return constraint(POSITION_CONSTRAINT, type, attribute);
      case T.RotationConstraint:
        return constraint(ROTATION_CONSTRAINT, type, attribute);
      case T.ScaleConstraint:
        return constraint(SCALE_CONSTRAINT, type, attribute);
      case T.AimConstraint:
        return constraint(AIM_CONSTRAINT, type, attribute);
      case T.ParentConstraint:
        return constraint(PARENT_CONSTRAINT, type, attribute);
      case T.LookAtConstraint:
        return constraint(LOOK_AT_CONSTRAINT, type, attribute);
      case T.Camera:
        return byCrc(["field of view", "m_FocalLength"], type, attribute);
      default:
        throw new Error(`Unknown custom binding type ${type}`);
    }
  };
}
