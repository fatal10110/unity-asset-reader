#!/usr/bin/env python3
"""Candidate format-23 goldens (#108, #153, #155, #160, #229, #230), UnityPy 1.25.4.

Use a separate oracle environment from the format-21/22 goldens. These files
have metadata/generic dump coverage; their texture and atlas features remain candidates.
The sprites a 6000.6 atlas holds itself get UnityPy's crop (`packedSprites`);
the variant's half-scale ones also AssetStudio's executed CutImage
(`assetstudio-modern-cross-checks.json`, `cross-check-fixture-oracles.py --modern`).
No decoded output from the library under test is used here.
"""
import importlib.util
import json
import pathlib
import sys
import types

import UnityPy
from UnityPy.enums import SpritePackingMode

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("oracle", ROOT / "scripts/make-goldens.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
CROSS_CHECKS_FILE = "assetstudio-modern-cross-checks.json"
CROSS_CHECKS = json.loads((ROOT / "fixtures" / CROSS_CHECKS_FILE).read_text())

PACKED_SPRITE_NOTE = (
    "UnityPy 1.25.4 exports Sprite objects only, and a 6000.6 atlas' packed sprites have none. "
    "This is UnityPy's own get_image_from_sprite (crop and undone packing flip, packing mode "
    "forced to Rectangle, as make-goldens.py's rgbaSha256), given a stand-in sprite that names "
    "only the atlas and this entry's render-data key; no tight mesh is applied (#229)."
)
PACKED_VARIANT_NOTE = (
    "UnityPy crops the variant atlas but ignores downscaleMultiplier. Its retained pixel hash "
    "is unsuitable for variant-resize acceptance. Verdict: AssetStudio; use "
    "assetStudioCrossCheck dimensions and rgbaSha256. Full bicubic reference pixels: "
    "assetstudio-modern-cross-checks.json; rectangle path only, no tight-mask claim (#230)."
)


def cross_check(name, data, raw):
    """AssetStudio's CutImage of a variant entry, matched on its input metadata.

    The summary as make-goldens.py's `cross_check_summary`; the complete
    pixels stay in the report.
    """
    texture = data.texture.deref_parse_as_object()
    metadata = {
        "textureWidth": texture.m_Width, "textureHeight": texture.m_Height,
        "imageSha256": oracle.sha256(bytes(texture.get_image_data())),
        "textureRect": {key: getattr(data.textureRect, key) for key in ["x", "y", "width", "height"]},
        "textureRectOffset": {key: getattr(data.textureRectOffset, key) for key in ["x", "y"]},
        "settingsRaw": raw, "downscaleMultiplier": data.downscaleMultiplier,
    }
    assert CROSS_CHECKS["verdict"] == "AssetStudio"
    for references in CROSS_CHECKS["variants"].values():
        reference = references.get(name)
        if reference and all(reference[key] == value for key, value in metadata.items()):
            rgba = bytes.fromhex(reference["rgbaHex"])
            assert len(rgba) == reference["width"] * reference["height"] * 4
            assert oracle.sha256(rgba) == reference["rgbaSha256"]
            return {**{key: value for key, value in reference.items() if key != "rgbaHex"},
                    "verdict": CROSS_CHECKS["verdict"], "reference": CROSS_CHECKS_FILE}
    raise SystemExit(f"{name}: no AssetStudio cross-check matches its inputs; rerun "
                     "cross-check-fixture-oracles.py --modern (fixtures/BUILDING.md section 15)")


def packed_sprite_goldens(path):
    """UnityPy's image of every sprite a 6000.6 atlas holds itself (#229).

    They have no Sprite objects, so `get_image_from_sprite` gets a stand-in:
    the atlas, the entry's key and the file, the only fields it reads with
    the packing mode forced to Rectangle. By atlas path id, in
    `m_RenderDataMap` order; rows as stored, bottom row first.
    """
    out = {}
    for obj in UnityPy.load(str(path)).objects:
        if obj.type.name != "SpriteAtlas":
            continue
        atlas = obj.read()
        entries = []
        for index, (key, data) in enumerate(atlas.m_RenderDataMap):
            pointer = types.SimpleNamespace(deref_parse_as_object=lambda atlas=atlas: atlas)
            stand_in = types.SimpleNamespace(
                m_SpriteAtlas=pointer,
                m_AtlasTags=None,
                m_RenderDataKey=key,
                assets_file=obj.assets_file,
            )
            rgba, width, height, raw = oracle.sprite_image(
                stand_in, packingMode=SpritePackingMode.kSPMRectangle)
            entry = {
                "name": data.spriteInstanceData.spriteName,
                "index": index,
                "settingsRaw": raw,
                "downscaleMultiplier": data.downscaleMultiplier,
                "width": width,
                "height": height,
                "rgbaSha256": oracle.sha256(rgba),
                "oracleNote": PACKED_SPRITE_NOTE,
            }
            if data.downscaleMultiplier != 1:
                entry["variantOracleNote"] = PACKED_VARIANT_NOTE
                entry["assetStudioCrossCheck"] = cross_check(entry["name"], data, raw)
            entries.append(entry)
        out.setdefault(obj.assets_file.name, {})[str(obj.path_id)] = entries
    return out


# An AnimationClip's legacy curve arrays.
CURVE_ARRAYS = ("m_RotationCurves", "m_CompressedRotationCurves", "m_EulerCurves",
                "m_PositionCurves", "m_ScaleCurves", "m_FloatCurves", "m_PPtrCurves")


def evidence(name, path):
    """Check the fixture's intended content directly with UnityPy, not our reader."""
    env = UnityPy.load(str(path))
    textures, atlases, shaders, meshes, clips = [], [], [], [], []
    animation, scene, components = {}, {}, []
    for obj in env.objects:
        assert obj.assets_file.header.version == 23
        if obj.type.name in ("AnimationClip", "Animator", "AnimatorController",
                             "AnimatorOverrideController", "Avatar"):
            animation[obj.type.name] = animation.get(obj.type.name, 0) + 1
        if obj.type.name in ("GameObject", "Transform", "MeshFilter", "MeshRenderer",
                             "SkinnedMeshRenderer", "Mesh"):
            scene[obj.type.name] = scene.get(obj.type.name, 0) + 1
        if obj.type.name == "Animation":
            components.append(obj.read_typetree())
        if obj.type.name == "AnimationClip" and ("/animation/" in name or "/humanoid/" in name):
            tree = obj.read_typetree()
            parts = tree["m_MuscleClip"]["m_Clip"]["data"]
            clips.append({"name": tree["m_Name"], "legacy": tree["m_Legacy"],
                          "streamed": parts["m_StreamedClip"]["curveCount"],
                          "discrete": parts["m_StreamedClip"]["discreteCurveCount"],
                          "dense": parts["m_DenseClip"]["m_CurveCount"],
                          "constant": len(parts["m_ConstantClip"]["data"]),
                          "curves": sum(len(tree[k]) for k in CURVE_ARRAYS),
                          "events": len(tree["m_Events"])})
        if obj.type.name == "Mesh":
            tree = obj.read_typetree()
            shapes = tree["m_Shapes"]
            meshes.append({"name": tree["m_Name"],
                           "blendShapes": [channel["name"] for channel in shapes["channels"]],
                           "frames": [channel["frameCount"] for channel in shapes["channels"]],
                           "indexFormat": tree["m_IndexFormat"]})
        if obj.type.name == "Shader":
            tree = obj.read_typetree()
            shaders.append({"name": tree["m_ParsedForm"]["m_Name"], "platforms": tree["platforms"]})
        if obj.type.name == "Texture2D" and "/more-plain/" in name:
            texture = obj.read()
            raw = bytes(texture.get_image_data())
            assert (texture.m_Width, texture.m_Height) == (8, 5)
            assert raw == bytes((k * 37 + 11) & 255 for k in range(len(raw)))
            textures.append(texture.m_Name)
        if obj.type.name == "Texture2D" and "/signed-eac/" in name:
            texture = obj.read()
            assert (texture.m_Width, texture.m_Height) == (32, 16)
            textures.append(texture.m_Name)
        if obj.type.name == "SpriteAtlas":
            tree = obj.read_typetree()
            assert "m_PackedSprites" not in tree
            assert "m_PackedSpriteNamesToIndex" not in tree
            entries = []
            for _, data in tree["m_RenderDataMap"]:
                instance = data["*spriteInstanceData"]
                entries.append({"name": instance["spriteName"],
                                "rotation": (data["settingsRaw"] >> 2) & 15,
                                "downscaleMultiplier": data["downscaleMultiplier"]})
            if tree["m_IsVariant"]:
                assert len(entries) == 2
                assert all(entry["downscaleMultiplier"] == 0.5 for entry in entries)
            atlases.append({"name": tree["m_Name"], "isVariant": tree["m_IsVariant"],
                            "sprites": entries})
    if "/shader/" in name:
        assert sorted(s["name"] for s in shaders) == ["UAR/ShaderFixture", "UAR/ShaderFixtureSecond"]
        want = [4] if name.endswith("/windows") else [9, 18]
        assert all(s["platforms"] == want for s in shaders)
        return {"shaders": sorted(shaders, key=lambda s: s["name"])}
    if "/mesh/" in name:
        # The skinned meshes (#285): two blend shapes, 32-bit indices; the
        # skin itself is checked by make-goldens.py's skin_golden.
        assert [mesh["name"] for mesh in meshes] == [name.split("/")[-1][len("mesh-"):]]
        assert all(m["blendShapes"] == ["smile", "blink"] and m["frames"] == [2, 3]
                   and m["indexFormat"] == 1 for m in meshes)
        return {"meshes": meshes}
    if "/shader-variants/" in name:
        assert sorted(s["name"] for s in shaders) == ["UAR/ShaderVariants", "UAR/ShaderVariantsSecond"]
        assert all(s["platforms"] == [9, 18] for s in shaders)
        return {"shaders": sorted(shaders, key=lambda s: s["name"])}
    if "/animator/" in name:
        # The animator fixtures (#303): two Animators, a humanoid and a generic
        # Avatar, one controller and one override controller.
        # And the eight clips of the controller (one linear localPosition.y curve each).
        assert animation == {"AnimationClip": 8, "Animator": 2, "AnimatorController": 1,
                             "AnimatorOverrideController": 1, "Avatar": 2}, animation
        return {"animation": dict(sorted(animation.items()))}
    if "/scene/" in name:
        # The scene fixtures (#305): the "scene" prefab (ten GameObjects, an
        # Animator on its generic Avatar, a SkinnedMeshRenderer, a MeshFilter
        # and a MeshRenderer) and the "humanoid" one (22 GameObjects, an
        # Animator on its humanoid Avatar), one controller, three clips, one Mesh.
        assert scene == {"GameObject": 32, "Transform": 32, "MeshFilter": 1, "MeshRenderer": 1,
                         "SkinnedMeshRenderer": 1, "Mesh": 1}, scene
        assert animation == {"AnimationClip": 3, "Animator": 2, "AnimatorController": 1,
                             "Avatar": 2}, animation
        assert [mesh["name"] for mesh in meshes] == ["skinned"]
        return {"animation": dict(sorted(animation.items())), "scene": dict(sorted(scene.items()))}
    if "/humanoid/" in name:
        # The humanoid oracle's input (#318): the "humanoid" prefab (22
        # GameObjects, an Animator on its humanoid Avatar) and the "pose" clip,
        # 95 muscles, RootT and RootQ, three keys each.
        assert scene == {"GameObject": 22, "Transform": 22}, scene
        assert animation == {"AnimationClip": 1, "Animator": 1, "Avatar": 1}, animation
        assert [(c["name"], c["legacy"], c["streamed"] + c["dense"]) for c in clips] == [
            ("pose", False, 102)], clips
        return {"animation": dict(sorted(animation.items())), "scene": dict(sorted(scene.items())),
                "clips": clips}
    if "/legacy-animation/" in name:
        # The legacy-animation fixtures (#314): the "legacy" prefab (four
        # GameObjects, a SkinnedMeshRenderer), whose root's legacy Animation
        # lists the Mecanim clip "walk", and "unlisted", a clip nothing lists;
        # no Avatar, no Animator.
        assert scene == {"GameObject": 4, "Transform": 4, "SkinnedMeshRenderer": 1,
                         "Mesh": 1}, scene
        assert animation == {"AnimationClip": 2}, animation
        assert [mesh["name"] for mesh in meshes] == ["face"]
        assert len(components) == 1, components
        component = components[0]
        clips = {obj.path_id: obj.read_typetree()["m_Name"] for obj in env.objects
                 if obj.type.name == "AnimationClip"}
        listed = [clips[ptr["m_PathID"]] for ptr in component["m_Animations"]]
        assert listed == ["walk"], listed
        assert clips[component["m_Animation"]["m_PathID"]] == "walk"
        fields = {k: component[k] for k in ("m_WrapMode", "m_PlayAutomatically",
                                             "m_AnimatePhysics", "m_UpdateMode", "m_CullingType")}
        assert fields == {"m_WrapMode": 4, "m_PlayAutomatically": False, "m_AnimatePhysics": True,
                          "m_UpdateMode": 1, "m_CullingType": 1}, fields
        return {"animation": dict(sorted(animation.items())), "scene": dict(sorted(scene.items())),
                "listed": listed}
    if "/animation/" in name:
        # The animation fixtures (#302): one legacy clip, whose curves stay in
        # the curve arrays, and five Mecanim clips, whose curves land in the
        # streamed, dense and constant parts of m_MuscleClip (the sprite swap
        # is 6000.x's one discrete curve), the curve arrays emptied.
        assert animation == {"AnimationClip": 6}, animation
        clips.sort(key=lambda c: c["name"])
        want = {  # name: (legacy, streamed, discrete, dense, constant, curves, events)
            "constant": (False, 0, 0, 0, 4, 0, 0),
            "dense": (False, 0, 0, 3, 0, 0, 0),
            "dense60": (False, 0, 0, 4, 0, 0, 0),
            "legacy": (True, 0, 0, 0, 0, 7, 2),
            "mecanim": (False, 18, 1, 0, 0, 0, 2),
            "mixed": (False, 3, 0, 3, 1, 0, 0),
        }
        got = {c["name"]: (c["legacy"], c["streamed"], c["discrete"], c["dense"], c["constant"],
                           c["curves"], c["events"]) for c in clips}
        assert got == want, got
        return {"animation": dict(sorted(animation.items())), "clips": clips}
    if "/signed-eac/" in name:
        # The signed EAC textures (#288); their bytes are checked against the
        # etc2comp payloads by packages/texture/tests/signed-eac.test.ts.
        assert sorted(textures) == ["42_EAC_R_SIGNED", "44_EAC_RG_SIGNED"]
        return {"textures": sorted(textures)}
    if "/more-plain/" in name:
        assert set(textures) == {"R8", "RG16", "RG32", "RGB48", "RGBA64", "R8_SIGNED",
                                 "RG16_SIGNED", "RGB24_SIGNED", "RGBA32_SIGNED", "R16_SIGNED",
                                 "RG32_SIGNED", "RGB48_SIGNED", "RGBA64_SIGNED"}
    else:
        assert len(atlases) == 2
        if "/variant/" in name:
            assert any(atlas["isVariant"] for atlas in atlases)
    return {"plainFormats": sorted(textures), "atlases": atlases}


def main():
    if UnityPy.__version__ != "1.25.4":
        raise SystemExit("candidate goldens require UnityPy==1.25.4 (format 23 support)")
    paths = [f"editor/6000.6.4f1/{folder}/{bundle}" for folder, bundle in [
        ("more-plain", "textures"), ("sprite", "sprites"), ("variant", "sprites"),
        ("sprite-v2", "sprites"), ("sprite-v2-rect", "sprites"),
        # The shader bundles built with type trees (#237), Shader dumped too.
        ("shader/lz4", "windows"), ("shader/lz4", "android"),
        # The skinned meshes (#285), typed only; their skins as make-goldens.py.
        ("mesh/lz4", "mesh-skinned"), ("mesh/lz4", "mesh-skinned-compressed"),
        # The shader with several variants and no Int property (#283), Shader dumped too.
        ("shader-variants/lz4", "android"),
        # Signed EAC textures made by an editor script from etc2comp blocks (#288).
        ("signed-eac", "android"),
        # Animator, AnimatorController, AnimatorOverrideController and Avatar (#303).
        ("animator/lz4", "animator"), ("animator/lz4-notypetree", "animator"),
        # AnimationClip (#302): legacy, streamed, dense and constant clips.
        ("animation/lz4", "animation"), ("animation/lz4-notypetree", "animation"),
        # GameObject, Transform, MeshFilter, MeshRenderer, SkinnedMeshRenderer (#305).
        ("scene/lz4", "scene"), ("scene/lz4-notypetree", "scene"),
        # The humanoid oracle's input (#318): a clip driving every muscle, typed only.
        ("humanoid/lz4", "humanoid"),
        # The legacy Animation component (#314) and the clip it lists.
        ("legacy-animation/lz4", "legacy-animation"),
        ("legacy-animation/lz4-notypetree", "legacy-animation"),
    ]]
    result = {
        "_oracle": "UnityPy " + UnityPy.__version__,
        "_generator": "scripts/make-modern-goldens.py",
        "_status": ("Format-23 metadata and generic dumps supported; 6000.6 packed sprites have "
                    "UnityPy crops through a stand-in sprite (#229); the signed plain formats "
                    "remain candidates; the skinned meshes have UnityPy MeshHelper's skin (#285)."),
        "fixtures": {},
    }
    for name in paths:
        path = oracle.FIXTURES / name
        # A Shader's dump only where the reader's check needs it, so
        # goldens.json is unchanged.
        if "/shader/" in name or "/shader-variants/" in name:
            oracle.DUMPED_CLASSES[48] = "Shader"
        result["fixtures"][name] = oracle.read_fixture(path)
        oracle.DUMPED_CLASSES.pop(48, None)
        result["fixtures"][name]["evidence"] = evidence(name, path)
        for file, atlases in packed_sprite_goldens(path).items():
            result["fixtures"][name]["serialized"][file]["packedSprites"] = atlases
        if "/more-plain/" in name:
            cross_check = json.loads((ROOT / "fixtures/assetstudio-rgb48.json").read_text())
            for serialized in result["fixtures"][name]["serialized"].values():
                for texture in serialized["textures"].values():
                    if texture["format"] != 73:
                        continue
                    assert cross_check["inputSha256"] == texture["imageSha256"]
                    assert cross_check["verdict"] == "AssetStudio"
                    assert cross_check["sourceBlob"] == "91c659434c07d92ea1d6fbc634d222fc37222b4f"
                    assert cross_check["rgbaSha256"] != texture["rgbaSha256"]
                    texture["oracleNote"] = (
                        "RGB48: UnityPy 1.25.4's RGB;16 export disagrees with AssetStudio's "
                        "little-endian unsigned channels, scaled as (component * 255 + 32895) >> 16. "
                        "The retained UnityPy rgbaSha256 is unsuitable for decoder acceptance. "
                        "Verdict: AssetStudio; use assetStudioCrossCheck.rgbaSha256. "
                        "Unmodified pinned converter methods were executed in an external .NET 8 "
                        "harness; see fixtures/BUILDING.md section 13 and #108."
                    )
                    texture["assetStudioCrossCheck"] = cross_check
        print(name)
    (ROOT / "fixtures/modern-goldens.json").write_text(oracle.to_json(result) + "\n")


if __name__ == "__main__":
    main()
