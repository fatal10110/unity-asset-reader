#!/usr/bin/env python3
"""Candidate format-23 goldens (#108, #153, #155, #160, #229), UnityPy 1.25.4.

Use a separate oracle environment from the format-21/22 goldens. These files
have metadata/generic dump coverage; their texture and atlas features remain candidates.
The sprites a 6000.6 atlas holds itself get UnityPy's crop (`packedSprites`).
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

PACKED_SPRITE_NOTE = (
    "UnityPy 1.25.4 exports Sprite objects only, and a 6000.6 atlas' packed sprites have none. "
    "This is UnityPy's own get_image_from_sprite (crop and undone packing flip, packing mode "
    "forced to Rectangle, as make-goldens.py's rgbaSha256), given a stand-in sprite that names "
    "only the atlas and this entry's render-data key; no tight mesh is applied (#229)."
)
PACKED_VARIANT_NOTE = (
    "UnityPy crops the variant atlas but ignores downscaleMultiplier. Its retained pixel hash "
    "is unsuitable for variant-resize acceptance; no AssetStudio cross-check exists for this "
    "6000.6 variant yet (#230)."
)


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
            entries.append(entry)
        out.setdefault(obj.assets_file.name, {})[str(obj.path_id)] = entries
    return out


def evidence(name, path):
    """Check the fixture's intended content directly with UnityPy, not our reader."""
    env = UnityPy.load(str(path))
    textures, atlases = [], []
    for obj in env.objects:
        assert obj.assets_file.header.version == 23
        if obj.type.name == "Texture2D" and "/more-plain/" in name:
            texture = obj.read()
            raw = bytes(texture.get_image_data())
            assert (texture.m_Width, texture.m_Height) == (8, 5)
            assert raw == bytes((k * 37 + 11) & 255 for k in range(len(raw)))
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
    ]]
    result = {
        "_oracle": "UnityPy " + UnityPy.__version__,
        "_generator": "scripts/make-modern-goldens.py",
        "_status": ("Format-23 metadata and generic dumps supported; 6000.6 packed sprites have "
                    "UnityPy crops through a stand-in sprite (#229); the signed plain formats "
                    "remain candidates."),
        "fixtures": {},
    }
    for name in paths:
        path = oracle.FIXTURES / name
        result["fixtures"][name] = oracle.read_fixture(path)
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
