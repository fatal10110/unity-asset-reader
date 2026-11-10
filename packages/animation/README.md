# unity-asset-reader-animation

Read Unity animations as plain data, and export animated characters to glTF. It is an add-on for
[`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):

- `clipCurves()` decodes a Unity `AnimationClip` into the curves
  [AssetStudio](https://github.com/Razviar/assetstudio)'s `.anim` export holds, as plain data.
- `sceneToGltf()` writes a GameObject's scene (its hierarchy, skinned meshes, blend shapes and
  those curves) as a binary glTF 2.0 file.

Synchronous, no dependencies, and it runs anywhere `unity-asset-reader` does: browsers, Workers,
Node.js.

## Terms used here

- **Curve**: how one animated value changes over time, such as a bone's position or a blend
  shape's weight.
- **Keyframe** (key): one point of a curve, with a time, a value and two slopes (tangents). Unity
  draws a cubic (Hermite) curve between two keys, shaped by the out slope of the first and the in
  slope of the second.
- **Path**: where the animated object sits below the GameObject that plays the clip, as Transform
  names joined by `/` (`""` for that GameObject itself).
- **Mecanim clip**: a clip for an `Animator`. It stores its curves packed in `m_MuscleClip`. A
  **legacy** clip, listed by the older `Animation` component, keeps plain curve arrays.
- **Humanoid clip and muscles**: a clip made for Unity's humanoid rig. It does not store bone
  rotations. It stores "muscle" values instead, one number per way a body part can turn (such as
  `Spine Front-Back`), scaled to that rig's joint limits, so the clip plays on any humanoid
  character. The rig's `Avatar` holds the bones and limits that turn muscles into rotations.
- **glTF 2.0**: an open 3D file format. A `.glb` file is its binary, single-file form.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-animation
```

`unity-asset-reader` is a peer dependency (`^1.3.0`, the first core to read `AnimationClip`,
`Avatar`, `Animator` and the scene objects), so your app has exactly one copy of the parser.

## Usage

```js
import { load } from "unity-asset-reader";
import { clipCurves } from "unity-asset-reader-animation";

const env = load(bytes);
for (const asset of env.assets("AnimationClip")) {
  const { rotation, position, float, events } = clipCurves(env, asset.reader);
  for (const curve of position) {
    console.log(curve.path, curve.keyframes.map((k) => [k.time, k.value]));
  }
}
```

Load the bundle that holds the clip's `Avatar`, `Animator` or `Animation` with the clip, so the
curve paths get their names (see [What it returns](#what-it-returns)).

## Common tasks

### Export a character with its animations to glTF

Pass the scene's root (a GameObject, or its Animator) and the clips to play on it.

```js
import { sceneToGltf } from "unity-asset-reader-animation";

const animator = [...env.assets("Animator")][0].reader;
const clips = [...env.assets("AnimationClip")].map((asset) => asset.reader);
const glb = sceneToGltf(env, animator, { clips });
```

The result is the `.glb` file's bytes. In Node.js, write it to a file:

```js
import { writeFileSync } from "node:fs";

writeFileSync("scene.glb", glb);
```

See [glTF scene export](#gltf-scene-export) for what the file holds.

### Read a clip's events

`events` is the clip's `m_Events`: the functions Unity calls at given times.

```js
const { events } = clipCurves(env, asset.reader);
for (const event of events) {
  console.log(event.time, event.functionName, event.data);
}
```

### Read humanoid muscle curves

A humanoid clip's curves come out as `float` curves on path `""`, named after their muscle
(`RootT.y`, `Spine Front-Back`, `LeftHand.Index.Spread`). `muscleName(attribute)` gives the same
name for a muscle binding's attribute number. To get bone rotations instead, export the scene with
`sceneToGltf()` (see [Humanoid clips](#humanoid-clips)).

## API reference

| Export | What |
|---|---|
| `clipCurves(env, clip)` | The curves and events of an `AnimationClip`, as a `ClipCurves`. `clip` is the clip's object reader (`asset.reader`), one of `env.objects`. |
| `sceneToGltf(env, root, { clips })` | The scene of `root` (a GameObject, or an Animator for its GameObject) as a `.glb` (`Uint8Array`), animated by `clips`. See [glTF scene export](#gltf-scene-export). |
| `SceneToGltfOptions` | The options of `sceneToGltf()`: `SceneToGltfOptions.clips`, AnimationClip readers, each read with `clipCurves()`. |
| `muscleName(attribute)` | Names a humanoid muscle binding as AssetStudio does (`RootT.y`, `Spine Front-Back`); `clipCurves()` uses it for every muscle curve. |
| `ClipCurves` | What `clipCurves()` returns: the `Curves` lists and `events`. |
| `Curves` | The lists `rotation`, `euler`, `position`, `scale`, `float` and `pptr`. |
| `TransformCurve` | A curve with `path` and `keyframes`. |
| `FloatCurve` | A curve with `path`, `attribute`, `classId` and `keyframes`. |
| `PPtrCurve` | An object reference curve with `path`, `attribute`, `classId` and `keyframes`. |
| `CurveKey` | A keyframe: `time`, `value`, `inSlope` and `outSlope`. |
| `PPtrKey` | A key of a `PPtrCurve`: `time` and `value` (a `PPtr`). |

Full JSDoc is in the bundled `index.d.ts`.

### Errors

`clipCurves()` throws:

- a `TypeError` for an object of another class;
- an `Error` where AssetStudio's conversion fails (a curve without a binding, an object reference
  index outside the clip's table);
- what reading the objects throws.

`sceneToGltf()` throws:

- `UnsupportedError` for:
  - an optimized hierarchy: the Animator's `m_HasTransformHierarchy` false, or a skinned renderer
    with bind poses but no `m_Bones` (AssetStudio rebuilds those from the Avatar and
    `m_BoneNameHashes`);
  - a skin glTF cannot hold (bones not one per bind pose, or outside the hierarchy);
  - a mesh without positions or triangles;
- `CorruptError` for indices past the data.

## What it returns

The lists of AssetStudio's `.anim` (`AnimationClipExtensions.Convert`), in its order:

- `rotation` (quaternions), `euler`, `position` and `scale` (vectors): per curve the Transform's
  `path` below the animated GameObject (`""` for the GameObject itself) and its `keyframes`.
- `float`: per curve `path`, `attribute` and `classId` (the animated component's class), and its
  `keyframes`.
  - Humanoid curves are named muscle attributes (`RootT.y`, `Spine Front-Back`,
    `LeftHand.Index.Spread`) on path `""` and class 95 (`Animator`), as the clip stores them.
    `sceneToGltf()` turns them into bone rotations.
  - Blend shape weights are `blendShape.<name>`.
- `pptr`: object reference curves (a sprite swap), per key a time and a `PPtr`.
- `events`: the clip's `m_Events`.

Each keyframe holds `time`, `value`, `inSlope` and `outSlope`, every number a float32 value
computed as AssetStudio computes it.

### Mecanim clips

A Mecanim clip stores its curves in `m_MuscleClip` in three forms: streamed keys, dense samples
(one value per frame) and constants. They are bound to paths and properties by CRC-32 hashes.
They are decoded as AssetStudio's `AnimationClipConverter` does:

- Streamed keys keep their out slopes. Their in slopes are computed from the key before (a
  stepped segment gives `Infinity`). Float curves get no slopes, as in AssetStudio.
- Dense samples become a key per frame, without slopes.
- Constants become a key at time 0 and one at the clip's last frame, without slopes.
- A path hash is named from:
  - the loaded `Avatar`s' path tables;
  - the hierarchy of each `Animator` that plays the clip;
  - the hierarchy of each legacy `Animation` component that lists it.

  A UI hierarchy's `RectTransform`s count as `Transform`s, as in AssetStudio. Load the bundle that
  holds them with the clip; a hash nothing names stays `path_<hash>`.
- Blend shape and material property hashes are named from the renderer at the curve's path, and
  stay numbers without it.
- Engine properties AssetStudio does not name are `typetree_<hash>`, script fields
  `script_<hash>`.

A legacy clip's curve arrays are merged after the decoded curves, as AssetStudio merges them.

## glTF scene export

`sceneToGltf()` converts what AssetStudio's FBX export (`ModelConverter`) converts, into a
validator-clean glTF 2.0 `.glb`.

Unity's space is left-handed and glTF's is right-handed. The conversion is the one AssetStudio and
`meshToGltf` (unity-asset-reader-mesh) apply:

- positions, translations and blend shape deltas get x negated;
- rotations get y and z negated;
- bind poses are mirrored on both sides;
- triangles reverse winding.

What the file holds:

- **Nodes**: the root's ancestors and its hierarchy, each GameObject's local position, rotation
  and scale. Inactive GameObjects are written too.
- **Meshes**: each SkinnedMeshRenderer's mesh, and each MeshRenderer's MeshFilter mesh, from the
  root down (the ancestors' renderers are left out, as AssetStudio does), with `POSITION`, `NORMAL`
  and `TEXCOORD_0`. No materials, tangents, colours or other UV channels.
- **Skins**: joints from the renderer's `m_Bones`, in order, inverse bind matrices from the mesh's
  bind poses, `JOINTS_0` and `WEIGHTS_0` from its bone weights. A renderer without bones writes
  its mesh unskinned when the mesh has no bind poses, and throws when it has some.
- **Blend shapes**: a morph target per channel, from its last (full weight) frame; glTF has no
  in-between frames. Weights are Unity's over that full weight, so 1 is the full shape.
- **Animations**: `translation`, `rotation`, `scale` and blend shape `weights` channels.
  - Each is a `CUBICSPLINE` sampler built from Unity's Hermite keys: samples at the union of the
    components' key times, tangents Unity's slopes (exact at the keys, and between them the same
    cubic Unity evaluates).
  - A stepped key (an infinite slope) holds its value and jumps one float32 step before the next
    key, or the channel is `STEP` when every key is stepped.
  - Weighted tangents fall back to plain Hermite.
  - Euler curves are converted as `Quaternion.Euler` does. Between keys glTF's spline only
    approximates them. AssetStudio converts euler angles with the native FBX SDK, so that
    conversion has no oracle.
- **Humanoid clips**: when the root's Animator has a humanoid Avatar, a clip's muscle curves and
  `RootQ` become `rotation` channels on the human bones (see [Humanoid clips](#humanoid-clips)).
  They replace any Transform curve on those bones. Without a humanoid Avatar the muscle curves are
  skipped.

Skipped, since glTF has no channel for them:

- `m_IsActive` and every other float or object reference curve;
- curves whose path names no node;
- of a humanoid clip: the body position (`RootT`, see [Humanoid clips](#humanoid-clips)), the
  motion curves (`MotionT`, `MotionQ`), the IK goals (`LeftFootT`, ...) and the translation
  DoFs.

## Humanoid clips

In short:

- **What is converted**: the muscle curves of a humanoid clip, and its body rotation (`RootQ`),
  become rotations of the human bones in the glTF file.
- **How accurate**: on the three fixture rigs, in Unity 2019.4, 2020.3, 6000.3 and 6000.6, every
  bone's rotation is within 8e-7 rad of Unity's, fingers included, the Hips' within 7.1e-5 rad
  (the accepted tolerance is 1e-3 rad).
- **What is not converted**: the body position (`RootT`), the motion curves, the IK goals and the
  translation DoFs (see [glTF scene export](#gltf-scene-export)).

The rest of this section explains how the conversion works and which fixture rigs check it.

### Where the conversion comes from

AssetStudio has no muscle-to-bone conversion and no permissively licensed one exists. So this one
is derived from the Avatar's own data (`m_Avatar.m_Human`) and Unity's public documentation:

- [Muscle definitions](https://docs.unity3d.com/Manual/MuscleDefinitions.html)
- [HumanPose](https://docs.unity3d.com/ScriptReference/HumanPose.html)
- [HumanTrait](https://docs.unity3d.com/ScriptReference/HumanTrait.html)
- [HumanLimit](https://docs.unity3d.com/ScriptReference/HumanLimit.html)
- [HumanDescription](https://docs.unity3d.com/ScriptReference/HumanDescription.html)

It is checked against the bone poses the Unity editor makes from the same muscles (recorded in
the repository's `fixtures/humanoid-unity-goldens.json` and `fixtures/humanoid2-unity-goldens.json`).

### The steps

1. Each muscle is an angle on one axis of one bone (`HumanTrait.MuscleFromBone`): 0 is the
   limit's centre, a positive value scales the axis' `m_Limit.m_Max`, a negative one its `m_Min`.
2. A bone's rotation in its human parent's space is `m_PreQ * swingTwist(m_Sgn * angles) *
   conj(m_PostQ)`: the X angle twists the bone about its own axis, then Y and Z swing it about an
   axis of the YZ plane, each entering as the tangent of its half angle.
3. Twist split: an upper arm, forearm, upper leg and lower leg keep the Avatar's share
   (`m_ArmTwist`, `m_ForeArmTwist`, `m_UpperLegTwist`, `m_LegTwist`) of their twist and pass the
   rest to the child bone.
4. The fingers turn the same way, without twist: a proximal bone by its `Spread` (Y) and
   `1 Stretched` (Z) muscles, the intermediate and distal ones by `2 Stretched` and `3 Stretched`
   (Z). The hands' `m_HandBoneIndex` names the bones.
5. An avatar without an UpperChest turns the Chest by the UpperChest muscles too, each over half
   the Chest's own limit on that side: such an Avatar holds no limits for the UpperChest.
6. The Hips turn so that the body has the clip's `RootQ`: the body frame's up runs from the middle
   of the upper legs to the middle of the upper arms, its right from the left upper leg and arm to
   the right ones (by it the T-pose body frame `m_RootX` is the identity).
7. The clip is sampled at its `m_SampleRate` and at every key, and written as `LINEAR` rotation
   channels (the conversion is not linear, so the curves' tangents do not carry over), each
   sample in the hemisphere of the one before, then mirrored as every rotation is.

### The body position

The body position (`RootT`, the body's centre of mass) is not converted: the Hips keep their
skeleton position. No centre of mass definition met the tolerance of 1e-4 × the human scale. The
closest (the bones' joints, each half its length along the bone, weighted by `m_HumanBoneMass`)
was off by 4.7e-3 × the human scale (about 5 mm on the first fixture rig).

### The fixture rigs

Three rigs, each built from code in our own Unity projects (`fixtures/BUILDING.md` sections 28
and 31), cover the conversion's branches:

- the first: a T-pose with unrotated bones, twist shares of 0.5 and Unity's default limits;
- the second: a bind pose with rotated bones under a rotated, Blender-style `Armature`, a
  non-human bone between the Spine and the Chest, an UpperChest, eyes, jaw and fingers, a
  different twist share per pair (0.3, 0.7, 0.2, 0.6) and custom limits with off-centre centres;
- the third: the first without an UpperChest, but with asymmetric Chest limits, posed by the
  UpperChest muscles alone.

## Not included

- YAML (`.anim` text) output.
- A humanoid clip's body position and root motion (see
  [Humanoid clips](#humanoid-clips)).
- `m_CompressedRotationCurves`, which AssetStudio leaves compressed too.

## How it is tested

- `clipCurves()` is tested against the curves of AssetStudio's own `.anim` export, from clips
  built by Unity 2019.4, 2020.3 and 6000.3.
- Humanoid clips are checked against the bone poses the Unity editor makes from the same muscles:
  see [Humanoid clips](#humanoid-clips) for the editor versions and tolerances.
- Euler curves in glTF have no oracle: AssetStudio converts them with the native FBX SDK.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), the same as `unity-asset-reader`,
or any browser `unity-asset-reader` runs in.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  `clipCurves()` is hand-ported from its `AnimationClipConverter.cs`, `AnimationClipExtensions.cs`,
  `CustomCurveResolver.cs` and `MuscleHelper.cs` (`AssetStudio.Utility/YAML/`), `StreamedClip.ReadData`
  and its CRC-32, and it is tested against the curves of AssetStudio's own `.anim` export, from
  clips built by Unity 2019.4, 2020.3 and 6000.3.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): names the fixture objects the tests
  convert.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).

## License

MIT. `clipCurves()` ports parts of AssetStudio (MIT); see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/animation/NOTICE).
