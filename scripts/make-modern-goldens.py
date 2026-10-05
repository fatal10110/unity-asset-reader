#!/usr/bin/env python3
"""Candidate format-23 goldens (#108, #153, #155, #160), UnityPy 1.25.4.

Use a separate oracle environment from the format-21/22 goldens. These files
are independently readable but not yet supported by our SerializedFile reader.
No decoded output from the library under test is used here.
"""
import importlib.util
import json
import pathlib
import sys

import UnityPy

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("oracle", ROOT / "scripts/make-goldens.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


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
        "_status": "Candidate format-23 fixtures; reader support is not implemented.",
        "fixtures": {},
    }
    for name in paths:
        path = oracle.FIXTURES / name
        result["fixtures"][name] = oracle.read_fixture(path)
        result["fixtures"][name]["evidence"] = evidence(name, path)
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
