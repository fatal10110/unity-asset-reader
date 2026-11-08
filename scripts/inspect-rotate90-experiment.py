#!/usr/bin/env python3
"""Inspect bounded editor probes independently; never generate or alter flags.
Usage: <UnityPy-1.25.4-python> scripts/inspect-rotate90-experiment.py <2019-project> <6000-project>
       <UnityPy-1.25.4-python> scripts/inspect-rotate90-experiment.py --scriptable-packer <6000.3-project> <6000.6-project>
Writes fixtures/rotate90-experiment.json. Inputs and generated C# stay external.
The second form (BUILDING section 16, custom ScriptablePacker) only replaces the
report's scriptablePackerProbes and keeps every other key as it is.
Negative probes are not acceptance fixtures and their bundles are not committed.
"""
import collections
import hashlib
import json
import pathlib
import re
import sys

import UnityPy
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIMENSIONS = [[13, 47], [47, 13], [19, 37], [37, 19], [23, 41], [41, 23],
              [33, 49], [49, 33], [35, 43], [43, 35], [7, 53], [53, 7]]
CASES = [
    {"name": "c0-64-rect-forward", "atlasSize": 64, "tight": False, "reverse": False},
    {"name": "c1-64-tight-forward", "atlasSize": 64, "tight": True, "reverse": False},
    {"name": "c2-128-tight-forward", "atlasSize": 128, "tight": True, "reverse": False},
    {"name": "c3-128-tight-reverse", "atlasSize": 128, "tight": True, "reverse": True},
    {"name": "c4-256-tight-forward", "atlasSize": 256, "tight": True, "reverse": False},
    {"name": "c5-256-rect-reverse", "atlasSize": 256, "tight": False, "reverse": True},
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(project, version, mode):
    bundle = project / f"Build/rotate-matrix-{mode}/sprites"
    source = project / "Assets/Editor/BuildRotationMatrix.cs"
    env = UnityPy.load(str(bundle))
    names = {}
    textures = {}
    versions = set()
    for obj in env.objects:
        versions.add(obj.assets_file.unity_version)
        if obj.type.name == "Sprite":
            tree = obj.read_typetree()
            names[json.dumps(tree["m_RenderDataKey"], sort_keys=True)] = tree["m_Name"]
        elif obj.type.name == "Texture2D":
            tree = obj.read_typetree()
            textures[obj.path_id] = [tree["m_Width"], tree["m_Height"]]
    assert versions == {version}, versions
    cases = {case["name"]: {**case, "entries": []} for case in CASES}
    for obj in env.objects:
        if mode == "legacy" and obj.type.name == "Sprite":
            tree = obj.read_typetree()
            data = [(tree["m_Name"], tree["m_RD"])]
        elif mode != "legacy" and obj.type.name == "SpriteAtlas":
            tree = obj.read_typetree()
            data = []
            for key, entry in tree["m_RenderDataMap"]:
                name = (entry["*spriteInstanceData"]["spriteName"] if "*spriteInstanceData" in entry
                        else names[json.dumps(key, sort_keys=True)])
                data.append((name, entry))
        else:
            continue
        for name, entry in data:
            case_name = name.rsplit("-s", 1)[0]
            if case_name not in cases:
                continue
            raw = entry["settingsRaw"]
            cases[case_name]["entries"].append({"sprite": name, "settingsRaw": raw,
                                               "packed": bool(raw & 1), "rotation": (raw >> 2) & 15,
                                               "atlasDimensions": textures[entry["texture"]["m_PathID"]]})
    result_cases = []
    rotations = collections.Counter()
    candidate_names = []
    for case in cases.values():
        case["requestedAtlasSize"] = case.pop("atlasSize")
        if mode == "legacy":
            case["caseLabelSize"] = case["requestedAtlasSize"]
            case["requestedAtlasSize"] = None
            case["sizeControl"] = "built-in policy unchanged; case-name size is only a label"
        case["entries"].sort(key=lambda entry: entry["sprite"])
        assert len(case["entries"]) == 12, case["name"]
        assert all(entry["packed"] for entry in case["entries"]), case["name"]
        case["observedDimensionsExceedRequested"] = (
            any(max(entry["atlasDimensions"]) > case["requestedAtlasSize"] for entry in case["entries"])
            if case["requestedAtlasSize"] is not None else None
        )
        counts = collections.Counter(entry["rotation"] for entry in case["entries"])
        rotations.update(counts)
        case["rotations"] = dict(sorted(counts.items()))
        candidate_names.extend(entry["sprite"] for entry in case["entries"] if entry["rotation"] == 4)
        result_cases.append(case)
    return {"editorVersion": version, "packer": mode,
            "legacyPolicy": "TightRotateEnabledSpritePackerPolicy" if mode == "legacy" else None,
            "requestedPadding": 2 if mode != "legacy" else None,
            "legacyTightMeaning": "imported sprite mesh mode; policy is unchanged" if mode == "legacy" else None,
            "bundle": f"Build/rotate-matrix-{mode}/sprites", "bundleSha256": digest(bundle.read_bytes()),
            "builderSha256": digest(source.read_bytes().replace(b"\r\n", b"\n")),
            "serializedFormat": sorted({obj.assets_file.header.version for obj in env.objects}),
            "nativePackedEntries": 72, "rotations": dict(sorted(rotations.items())),
            "rotate90Candidates": candidate_names, "cases": result_cases}


# The transform Rotate90Packer (BUILDING section 16) returns for a source size:
# 4 for every taller-than-wide image, listed values as the control for wide ones.
def requested_transform(width, height):
    if height > width:
        return 4
    return {47: 1, 43: 1, 37: 2, 53: 2, 41: 3}.get(width, 0)


def packer_sources(project):
    text = (ROOT / "fixtures/BUILDING.md").read_text()
    blocks = re.findall(r"```csharp\n(.*?)\n```", text, re.S)
    hashes = {}
    for name, marker in [("BuildPackerProbe.cs", "public static class BuildPackerProbe"),
                         ("Rotate90Packer.cs", "public class Rotate90Packer")]:
        documented = [block for block in blocks if marker in block]
        source = (project / "Assets/Editor" / name).read_bytes().replace(b"\r\n", b"\n")
        if len(documented) != 1 or source.decode().strip() != documented[0].strip():
            raise SystemExit(f"{project}/Assets/Editor/{name} differs from BUILDING section 16")
        hashes[name] = digest(source)
    return hashes


def inspect_scriptable(project, version):
    bundle = project / "Build/packer/sprites"
    env = UnityPy.load(str(bundle))
    rects = {}
    keys = {}
    images = {}
    versions = set()
    for obj in env.objects:
        versions.add(obj.assets_file.unity_version)
        if obj.type.name == "Sprite":
            tree = obj.read_typetree()
            rects[tree["m_Name"]] = tree["m_Rect"]
            keys[json.dumps(tree["m_RenderDataKey"], sort_keys=True)] = tree["m_Name"]
        elif obj.type.name == "Texture2D":
            images[obj.path_id] = obj.read().image.transpose(Image.FLIP_TOP_BOTTOM).convert("RGBA")
    assert versions == {version}, versions
    atlases = [obj.read_typetree() for obj in env.objects if obj.type.name == "SpriteAtlas"]
    assert len(atlases) == 1, len(atlases)
    entries = []
    for key, entry in atlases[0]["m_RenderDataMap"]:
        # 6000.6 keeps the sprite's name and rect in the atlas, not in Sprite objects.
        if "*spriteInstanceData" in entry:
            name = entry["*spriteInstanceData"]["spriteName"]
            source = entry["*spriteInstanceData"]["rect"]
        else:
            name = keys[json.dumps(key, sort_keys=True)]
            source = rects[name]
        width, height = round(source["width"]), round(source["height"])
        rect = entry["textureRect"]
        x0, y0, w, h = (round(rect[k]) for k in ("x", "y", "width", "height"))
        image = images[entry["texture"]["m_PathID"]]
        blue = (int(name[1:]) + 1) * 16 + 7
        opaque = own = 0
        # Section 12's pixels name their source position: 205 inverts 5 mod 256.
        for v in range(h):
            for u in range(w):
                r, g, b, a = image.getpixel((x0 + u, y0 + v))
                if a == 255:
                    opaque += 1
                    own += (((r - 3) * 205) & 255, ((g - 5) * 205) & 255, b) == (u, v, blue)
        raw = entry["settingsRaw"]
        entries.append({"sprite": name, "sourceSize": [width, height],
                        "requestedTransform": requested_transform(width, height),
                        "settingsRaw": raw, "packed": bool(raw & 1), "rotation": (raw >> 2) & 15,
                        "textureRect": [x0, y0, w, h], "atlasDimensions": list(image.size),
                        "opaquePixels": opaque, "opaquePixelsAtOwnPosition": own})
    entries.sort(key=lambda entry: entry["sprite"])
    assert len(entries) == 12 and all(entry["packed"] for entry in entries), entries
    return {"editorVersion": version, "packer": "scriptable-v2 Rotate90Packer",
            "bundle": "Build/packer/sprites", "bundleSha256": digest(bundle.read_bytes()),
            "builderSha256": packer_sources(project),
            "serializedFormat": sorted({obj.assets_file.header.version for obj in env.objects}),
            "requestedTransforms": dict(sorted(collections.Counter(
                str(entry["requestedTransform"]) for entry in entries).items())),
            "rotations": dict(sorted(collections.Counter(
                str(entry["rotation"]) for entry in entries).items())),
            "rotate90Candidates": [entry["sprite"] for entry in entries if entry["rotation"] == 4],
            "everyOpaquePixelUnturned": all(entry["opaquePixels"] == entry["opaquePixelsAtOwnPosition"]
                                            for entry in entries),
            "entries": entries}


def check_external(projects):
    for project in projects:
        if project == ROOT or ROOT in project.parents:
            raise SystemExit("Unity projects must be outside the repository (R2)")


def main():
    if UnityPy.__version__ != "1.25.4":
        raise SystemExit("Use UnityPy==1.25.4 to read modern format 23")
    path = ROOT / "fixtures/rotate90-experiment.json"
    if sys.argv[1:2] == ["--scriptable-packer"]:
        projects = [pathlib.Path(arg).resolve() for arg in sys.argv[2:]]
        if len(projects) != 2:
            raise SystemExit(__doc__)
        check_external(projects)
        report = json.loads(path.read_text())
        report["scriptablePackerProbes"] = [inspect_scriptable(projects[0], "6000.3.26f1"),
                                            inspect_scriptable(projects[1], "6000.6.4f1")]
        path.write_text(json.dumps(report, indent=2) + "\n")
        for probe in report["scriptablePackerProbes"]:
            print(probe["editorVersion"], "requested", probe["requestedTransforms"],
                  "written", probe["rotations"], "unturned", probe["everyOpaquePixelUnturned"])
        return
    projects = [pathlib.Path(arg).resolve() for arg in sys.argv[1:]]
    if len(projects) != 2:
        raise SystemExit(__doc__)
    check_external(projects)
    probes = [inspect(projects[0], "2019.4.41f2", mode) for mode in ["legacy", "v1"]]
    probes += [inspect(projects[1], "6000.6.4f1", mode) for mode in ["v1", "v2"]]
    candidates = sum(len(probe["rotate90Candidates"]) for probe in probes)
    report = {"oracle": "UnityPy " + UnityPy.__version__,
              "status": "candidate-needs-UV-and-pixel-verification" if candidates else "negative-experiment",
              "scope": "24 bounded probe cases, 288 genuinely packed entries; no overridden flags. V1/V2 request different atlas maxima, but V2 output exceeds the 64/128 requests. Legacy keeps its built-in size/padding policy and repeats some mesh/order settings.",
              "sourceDimensions": DIMENSIONS,
              "sourceRecipe": "BUILDING section 12 Pixels: R=(x*5+3)&255, G=(y*5+5)&255, B=((id+1)*16+7)&255; opaque or asymmetric triangle/Ell alpha. Tight cases use Full for id%3=0, Triangle for 1, Ell for 2. Rect cases use Full. Names encode case and id. Import max 1024, point-filtered RGBA32, no mipmaps. V1/V2 request atlas maxima and padding 2 with rotation enabled; legacy uses TightRotateEnabledSpritePackerPolicy without overriding its size or padding.",
              "probes": probes}
    if path.exists() and "scriptablePackerProbes" in json.loads(path.read_text()):
        report["scriptablePackerProbes"] = json.loads(path.read_text())["scriptablePackerProbes"]
    path.write_text(json.dumps(report, indent=2) + "\n")
    for probe in probes:
        print(probe["editorVersion"], probe["packer"], probe["rotations"])
    print("Native Rotate90 candidates:", candidates)


if __name__ == "__main__":
    main()
