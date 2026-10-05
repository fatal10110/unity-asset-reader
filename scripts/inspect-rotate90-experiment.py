#!/usr/bin/env python3
"""Inspect bounded editor probes independently; never generate or alter flags.
Usage: <UnityPy-1.25.4-python> scripts/inspect-rotate90-experiment.py <2019-project> <6000-project>
Writes fixtures/rotate90-experiment.json. Inputs and generated C# stay external.
Negative probes are not acceptance fixtures and their bundles are not committed.
"""
import collections
import hashlib
import json
import pathlib
import sys

import UnityPy

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


def main():
    if UnityPy.__version__ != "1.25.4":
        raise SystemExit("Use UnityPy==1.25.4 to read modern format 23")
    projects = [pathlib.Path(arg).resolve() for arg in sys.argv[1:]]
    if len(projects) != 2:
        raise SystemExit(__doc__)
    for project in projects:
        if project == ROOT or ROOT in project.parents:
            raise SystemExit("Unity projects must be outside the repository (R2)")
    probes = [inspect(projects[0], "2019.4.41f2", mode) for mode in ["legacy", "v1"]]
    probes += [inspect(projects[1], "6000.6.4f1", mode) for mode in ["v1", "v2"]]
    candidates = sum(len(probe["rotate90Candidates"]) for probe in probes)
    report = {"oracle": "UnityPy " + UnityPy.__version__,
              "status": "candidate-needs-UV-and-pixel-verification" if candidates else "negative-experiment",
              "scope": "24 bounded probe cases, 288 genuinely packed entries; no overridden flags. V1/V2 request different atlas maxima, but V2 output exceeds the 64/128 requests. Legacy keeps its built-in size/padding policy and repeats some mesh/order settings.",
              "sourceDimensions": DIMENSIONS,
              "sourceRecipe": "BUILDING section 12 Pixels: R=(x*5+3)&255, G=(y*5+5)&255, B=((id+1)*16+7)&255; opaque or asymmetric triangle/Ell alpha. Tight cases use Full for id%3=0, Triangle for 1, Ell for 2. Rect cases use Full. Names encode case and id. Import max 1024, point-filtered RGBA32, no mipmaps. V1/V2 request atlas maxima and padding 2 with rotation enabled; legacy uses TightRotateEnabledSpritePackerPolicy without overriding its size or padding.",
              "probes": probes}
    (ROOT / "fixtures/rotate90-experiment.json").write_text(json.dumps(report, indent=2) + "\n")
    for probe in probes:
        print(probe["editorVersion"], probe["packer"], probe["rotations"])
    print("Native Rotate90 candidates:", candidates)


if __name__ == "__main__":
    main()
