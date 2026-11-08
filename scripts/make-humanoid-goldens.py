#!/usr/bin/env python3
"""Record Unity's humanoid muscle-to-bone conversion as goldens (#318).

For the humanoid muscle-to-bone conversion only, the oracle is the Unity editor
(plan section 5, revision 2026-11-08e). In each fixture editor this script
opens a scratch project outside the repository, loads the COMMITTED typed
bundles with `AssetBundle.LoadFromFile`, instantiates their `humanoid` prefab
and, for each humanoid fixture clip, feeds the clip's muscle values at its
keys and at the midpoints between them to
`new HumanPoseHandler(avatar, root).SetHumanPose(...)`. It records the inputs
(95 muscles, body position and rotation) and every transform's resulting
local rotation and position in `fixtures/humanoid-unity-goldens.json`.

The clips' values are the authored curves of fixtures/BUILDING.md (section 27
`pose`, section 24 `muscle`), evaluated by Unity's `AnimationCurve.Evaluate`;
nothing passes through an Animator, so neither clip compression nor root
motion baking is part of the golden. Nothing here runs this library (R12).

The editor code is C#, which the repository must not hold as a file (R2): it
lives in ORACLE_CS below and is written into each scratch project.

  python3 scripts/make-humanoid-goldens.py \\
      --work <scratch dir on the Windows host> \\
      --settings '<project with ProjectSettings/ and Packages/, {version} in it>' \\
      --unity 2019.4.41f2=<Unity.exe> --unity 2020.3.30f1=<Unity.exe> ...

`--probe` runs only the section 24 `muscle` clip and prints the result instead
of writing the golden (the batchmode check the issue asks for first).
"""

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUNDLES = ROOT / "fixtures" / "bundles"
GOLDEN = ROOT / "fixtures" / "humanoid-unity-goldens.json"
EDITORS = ("2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1")
# Clip name -> the committed typed bundle holding it, the humanoid prefab and its Avatar.
CLIPS = {
    "pose": "editor/{version}/humanoid/lz4/humanoid",
    "muscle": "editor/{version}/scene/lz4/scene",
}
# How a reimplementation is compared with these values (plan section 5). The bound
# itself is the owner's decision on #319, so the golden carries no number of its own.
COMPARISON = ("Within the tolerance the owner sets on #319, not by float32 bits; a "
              "quaternion matches its negation (q and -q are the same rotation). The "
              "recorded values themselves are Unity's float32 results, exact.")

ORACLE_CS = r"""
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEngine;

// The humanoid oracle (#318), written into a scratch project by
// scripts/make-humanoid-goldens.py. For each clip: load the committed bundle,
// instantiate its "humanoid" prefab, and at every key and midpoint feed the
// clip's authored values to HumanPoseHandler.SetHumanPose, then record every
// transform's local rotation and position.
public static class HumanoidOracle
{
    // fixtures/BUILDING.md section 27: muscle i at key k (times 0, 0.5, 1); never 0.
    static float V(int i, int k) { return (i % 2 == 0 ? 1f : -1f) * ((i * 5 + k * 3) % 13 + 1) / 16f; }

    static AnimationCurve Keys(params float[] tv)
    {
        var keys = new Keyframe[tv.Length / 2];
        for (int i = 0; i < keys.Length; i++) keys[i] = new Keyframe(tv[2 * i], tv[2 * i + 1]);
        return new AnimationCurve(keys);
    }

    // The authored curves: 95 muscles, RootT.xyz, RootQ.xyzw; null = not in the clip.
    static AnimationCurve[] Curves(string clip)
    {
        var c = new AnimationCurve[HumanTrait.MuscleCount + 7];
        int n = HumanTrait.MuscleCount;
        if (clip == "pose")
        {
            for (int i = 0; i < n; i++) c[i] = Keys(0f, V(i, 0), 0.5f, V(i, 1), 1f, V(i, 2));
            c[n] = Keys(0f, 0.125f, 0.5f, -0.0625f, 1f, 0.25f);
            c[n + 1] = Keys(0f, 1f, 0.5f, 1.0625f, 1f, 0.9375f);
            c[n + 2] = Keys(0f, -0.125f, 0.5f, 0.25f, 1f, 0.0625f);
            var q = new[] { Quaternion.Euler(0f, 30f, 0f), Quaternion.Euler(15f, -20f, 10f), Quaternion.Euler(-10f, 45f, 5f) };
            for (int j = 0; j < 4; j++) c[n + 3 + j] = Keys(0f, q[0][j], 0.5f, q[1][j], 1f, q[2][j]);
        }
        else if (clip == "muscle")
        {
            // fixtures/BUILDING.md section 24.
            c[Array.IndexOf(HumanTrait.MuscleName, "Spine Front-Back")] = Keys(0f, 0f, 0.5f, 0.5f, 1f, -0.25f);
            c[Array.IndexOf(HumanTrait.MuscleName, "Left Arm Down-Up")] = Keys(0f, 0.25f, 1f, 0.75f);
            c[Array.IndexOf(HumanTrait.MuscleName, "Right Forearm Stretch")] = Keys(0f, 1f, 1f, 0.5f);
            c[n + 1] = Keys(0f, 1f, 1f, 1.05f);
        }
        else throw new Exception("unknown clip " + clip);
        return c;
    }

    static string F(float f) { return ((double)f).ToString("G17", CultureInfo.InvariantCulture); }

    static string Arr(IEnumerable<float> v) { return "[" + string.Join(",", v.Select(F).ToArray()) + "]"; }

    static string Arg(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        if (HumanTrait.MuscleCount != 95) throw new Exception("muscle count " + HumanTrait.MuscleCount);
        var sb = new StringBuilder();
        sb.Append("{\"unity\":\"" + Application.unityVersion + "\",\"muscleNames\":[");
        sb.Append(string.Join(",", HumanTrait.MuscleName.Select(m => "\"" + m + "\"").ToArray()));
        sb.Append("],\"clips\":{");
        bool first = true;
        foreach (var clip in new[] { "pose", "muscle" })
        {
            var path = Arg(args, "-uarBundle-" + clip);
            if (path == null) continue;
            if (!first) sb.Append(",");
            first = false;
            sb.Append("\"" + clip + "\":" + Sample(clip, path));
        }
        sb.Append("}}");
        File.WriteAllText(Arg(args, "-uarOut"), sb.ToString());
        Debug.Log("ORACLE-OK humanoid " + Application.unityVersion);
    }

    static string Sample(string clip, string path)
    {
        var bundle = AssetBundle.LoadFromFile(path);
        if (bundle == null) throw new Exception("cannot load " + path);
        var prefab = bundle.LoadAsset<GameObject>("humanoid");
        var avatar = bundle.LoadAsset<Avatar>("human");
        if (prefab == null || avatar == null || !avatar.isValid || !avatar.isHuman)
            throw new Exception("no humanoid prefab or human Avatar in " + path);
        var go = UnityEngine.Object.Instantiate(prefab);
        go.name = prefab.name;
        var bones = go.GetComponentsInChildren<Transform>(true);
        var handler = new HumanPoseHandler(avatar, go.transform);
        var curves = Curves(clip);
        int n = HumanTrait.MuscleCount;

        // Keys, then the midpoint between each pair of neighbouring keys.
        var keys = curves.Where(c => c != null).SelectMany(c => c.keys.Select(k => k.time)).Distinct().OrderBy(t => t).ToList();
        var times = new List<float>(keys);
        for (int i = 0; i + 1 < keys.Count; i++) times.Add((keys[i] + keys[i + 1]) / 2f);
        times.Sort();

        var sb = new StringBuilder();
        sb.Append("{\"bones\":[" + string.Join(",", bones.Select(b => "\"" + b.name + "\"").ToArray()) + "]");
        sb.Append(",\"driven\":[" + string.Join(",", Enumerable.Range(0, n).Where(i => curves[i] != null).Select(i => i.ToString()).ToArray()) + "]");
        sb.Append(",\"keys\":" + Arr(keys) + ",\"samples\":[");
        for (int s = 0; s < times.Count; s++)
        {
            float t = times[s];
            Func<int, float, float> at = (i, d) => curves[i] != null ? curves[i].Evaluate(t) : d;
            var pose = new HumanPose
            {
                muscles = Enumerable.Range(0, n).Select(i => at(i, 0f)).ToArray(),
                bodyPosition = new Vector3(at(n, 0f), at(n + 1, 0f), at(n + 2, 0f)),
                // The component curves interpolate apart from unit length; Unity normalizes.
                bodyRotation = new Quaternion(at(n + 3, 0f), at(n + 4, 0f), at(n + 5, 0f), at(n + 6, 1f)).normalized,
            };
            handler.SetHumanPose(ref pose);
            if (s > 0) sb.Append(",");
            sb.Append("{\"time\":" + F(t) + ",\"key\":" + (keys.Contains(t) ? "true" : "false"));
            sb.Append(",\"muscles\":" + Arr(pose.muscles));
            var p = pose.bodyPosition;
            var q = pose.bodyRotation;
            sb.Append(",\"bodyPosition\":" + Arr(new[] { p.x, p.y, p.z }));
            sb.Append(",\"bodyRotation\":" + Arr(new[] { q.x, q.y, q.z, q.w }));
            sb.Append(",\"localPosition\":[" + string.Join(",", bones.Select(b => Arr(new[] { b.localPosition.x, b.localPosition.y, b.localPosition.z })).ToArray()) + "]");
            sb.Append(",\"localRotation\":[" + string.Join(",", bones.Select(b => Arr(new[] { b.localRotation.x, b.localRotation.y, b.localRotation.z, b.localRotation.w })).ToArray()) + "]}");
        }
        sb.Append("]}");
        UnityEngine.Object.DestroyImmediate(go);
        bundle.Unload(true);
        return sb.ToString();
    }
}
"""


def win(path):
    """The Windows form of a WSL path, for Unity's command line."""
    return subprocess.run(["wslpath", "-w", str(path)], check=True, capture_output=True,
                          text=True).stdout.strip()


def run_editor(version, exe, work, settings, clips):
    """Run the oracle in one editor; return its JSON and the bundles it read."""
    project = work / f"uar-318-oracle-{version}"
    template = pathlib.Path(settings.format(version=version))
    for sub in ("ProjectSettings", "Packages"):
        if not (project / sub).exists():
            shutil.copytree(template / sub, project / sub)
    editor_dir = project / "Assets" / "Editor"
    editor_dir.mkdir(parents=True, exist_ok=True)
    (editor_dir / "HumanoidOracle.cs").write_text(ORACLE_CS.lstrip(), newline="\n")
    out = project / "oracle.json"
    out.unlink(missing_ok=True)
    args = [exe, "-batchmode", "-nographics", "-quit", "-projectPath", win(project),
            "-executeMethod", "HumanoidOracle.Run", "-logFile", win(project / "oracle.log"),
            "-uarOut", win(out)]
    used = {}
    for clip in clips:
        rel = CLIPS[clip].format(version=version)
        src = BUNDLES / rel
        # A copy on the Windows side: the editor reads it from a local disk.
        local = project / "bundles" / clip
        local.parent.mkdir(exist_ok=True)
        shutil.copyfile(src, local)
        args += ["-uarBundle-" + clip, win(local)]
        used[clip] = {"bundle": rel, "sha256": hashlib.sha256(src.read_bytes()).hexdigest()}
    code = subprocess.run(args).returncode
    if code != 0 or not out.exists():
        raise SystemExit(f"{version}: Unity exited {code}; see {project / 'oracle.log'}")
    data = json.loads(out.read_text(encoding="utf-8-sig"))
    if data["unity"] != version:
        raise SystemExit(f"{exe} is Unity {data['unity']}, not {version}")
    return data, used


def dump(value, indent=0):
    """JSON with every list of numbers on one line, so the file stays readable."""
    pad = "  " * indent
    if isinstance(value, dict):
        items = [f'{pad}  {json.dumps(k)}: {dump(v, indent + 1)}' for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}" if items else "{}"
    if isinstance(value, list) and value and all(not isinstance(v, (dict, list)) for v in value):
        return "[" + ", ".join(json.dumps(v) for v in value) + "]"
    if isinstance(value, list):
        items = [pad + "  " + dump(v, indent + 1) for v in value]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]" if items else "[]"
    return json.dumps(value)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--work", required=True, type=pathlib.Path,
                    help="scratch directory on the Windows host for the oracle projects")
    ap.add_argument("--settings", required=True,
                    help="a project whose ProjectSettings/ and Packages/ are copied; {version}")
    ap.add_argument("--unity", action="append", default=[], metavar="VERSION=EXE",
                    help="one per fixture editor")
    ap.add_argument("--probe", action="store_true",
                    help="only the section 24 muscle clip; print, do not write the golden")
    a = ap.parse_args()
    exes = dict(u.split("=", 1) for u in a.unity)
    if sorted(exes) != sorted(EDITORS):
        raise SystemExit(f"--unity wants exactly {', '.join(EDITORS)}")
    clips = ["muscle"] if a.probe else list(CLIPS)
    editors = {}
    for version in EDITORS:
        data, used = run_editor(version, exes[version], a.work, a.settings, clips)
        if data["muscleNames"] != editors.get(EDITORS[0], data).get("muscleNames"):
            raise SystemExit(f"{version}: HumanTrait.MuscleName differs from {EDITORS[0]}")
        for clip, info in used.items():
            data["clips"][clip] = {**info, **data["clips"][clip]}
        editors[version] = data
        print(f"{version}: " + ", ".join(f"{c} {len(d['samples'])} samples"
                                         for c, d in data["clips"].items()), flush=True)
    if a.probe:
        print(json.dumps(editors["2019.4.41f2"]["clips"]["muscle"]["samples"][2])[:2000])
        return
    golden = {
        "_oracle": "Unity editor, HumanPoseHandler.SetHumanPose in batchmode (plan section 5)",
        "_generator": "scripts/make-humanoid-goldens.py",
        "_units": ("muscles and bodyPosition as HumanPose takes them: bodyPosition is in the "
                   "Avatar's normalized units (divided by the human scale); local positions in "
                   "metres, rotations as quaternions x, y, z, w, all in each transform's parent "
                   "space; bones in GetComponentsInChildren order, root first"),
        "_comparison": COMPARISON,
        "muscleNames": editors[EDITORS[0]]["muscleNames"],
        "editors": {v: {"clips": d["clips"]} for v, d in editors.items()},
    }
    GOLDEN.write_text(dump(golden) + "\n")
    print(f"wrote {GOLDEN.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
