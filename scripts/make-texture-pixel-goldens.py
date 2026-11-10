#!/usr/bin/env python3
"""Record the Unity editor's pixels of every mip level of the mips fixtures (#331).

For the pixels of mip levels past the first, the oracle is the Unity editor
(plan section 5, revision 2026-11-10a): AssetStudio c37af7d and UnityPy decode
level 0 only. In each fixture editor this script opens a scratch project
outside the repository, loads the COMMITTED `mips` bundles with
`AssetBundle.LoadFromFile` (batchmode, `-buildTarget` the bundle's own
platform, so the Android bundle loads in a Windows editor) and records
`Texture2D.GetPixels32(mip)` of every level of every Texture2D in
`fixtures/texture-pixel-unity-goldens.json`. The editor decodes compressed
levels on the CPU, without a GPU (`-nographics`). Nothing here runs this
library (R12).

The editor code is C#, which the repository must not hold as a file (R2): it
lives in ORACLE_CS below and is written into each scratch project.

  python3 scripts/make-texture-pixel-goldens.py \\
      --work <scratch dir on the Windows host> \\
      --settings '<project with ProjectSettings/ and Packages/, {version} in it>' \\
      --unity 2019.4.41f2=<Unity.exe> --unity 2020.3.30f1=<Unity.exe> ...
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
GOLDEN = ROOT / "fixtures" / "texture-pixel-unity-goldens.json"
EDITORS = ("2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1")
# Bundle name -> the committed bundle (fixtures/BUILDING.md section 29) and the
# -buildTarget the editor loads it under.
SETS = {
    "windows": ("editor/{version}/mips/windows", "Win64"),
    "android": ("editor/{version}/mips/android", "Android"),
}
# How a decoder is compared with these pixels (plan section 5, the owner's rule on #331).
COMPARISON = ("Uncompressed formats exactly. A compressed format's levels within the largest "
              "channel difference that format has at level 0, the first level, against these "
              "pixels; no other tolerance.")

ORACLE_CS = r"""
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEngine;

// The texture pixel oracle (#331), written into a scratch project by
// scripts/make-texture-pixel-goldens.py. Load the committed bundle and record
// GetPixels32 of every mip level of every Texture2D in it.
public static class TexturePixelOracle
{
    static string Arg(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    static string Level(Color32[] c)
    {
        var b = new byte[c.Length * 4];
        for (int i = 0; i < c.Length; i++)
        {
            b[4 * i] = c[i].r;
            b[4 * i + 1] = c[i].g;
            b[4 * i + 2] = c[i].b;
            b[4 * i + 3] = c[i].a;
        }
        return "\"" + Convert.ToBase64String(b) + "\"";
    }

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        var path = Arg(args, "-uarBundle");
        var bundle = AssetBundle.LoadFromFile(path);
        if (bundle == null) throw new Exception("cannot load " + path);
        var sb = new StringBuilder();
        sb.Append("{\"unity\":\"" + Application.unityVersion + "\",\"textures\":{");
        bool first = true;
        foreach (var t in bundle.LoadAllAssets<Texture2D>().OrderBy(t => t.name, StringComparer.Ordinal))
        {
            if (!t.isReadable) throw new Exception(t.name + " is not readable");
            if (!first) sb.Append(",");
            first = false;
            sb.Append("\"" + t.name + "\":{\"format\":" + (int)t.format + ",\"width\":" + t.width
                + ",\"height\":" + t.height + ",\"mipCount\":" + t.mipmapCount + ",\"levels\":[");
            for (int m = 0; m < t.mipmapCount; m++)
                sb.Append((m > 0 ? "," : "") + Level(t.GetPixels32(m)));
            sb.Append("]}");
        }
        sb.Append("}}");
        bundle.Unload(true);
        File.WriteAllText(Arg(args, "-uarOut"), sb.ToString());
        Debug.Log("ORACLE-OK texture pixels " + Application.unityVersion);
    }
}
"""


def win(path):
    """The Windows form of a WSL path, for Unity's command line."""
    return subprocess.run(["wslpath", "-w", str(path)], check=True, capture_output=True,
                          text=True).stdout.strip()


def run_editor(version, exe, work, settings, name):
    """Run the oracle in one editor on one bundle; return its textures and the bundle's record."""
    rel, target = SETS[name]
    rel = rel.format(version=version)
    project = work / f"uar-331-oracle-{version}"
    template = pathlib.Path(settings.format(version=version))
    for sub in ("ProjectSettings", "Packages"):
        if not (project / sub).exists():
            shutil.copytree(template / sub, project / sub)
    editor_dir = project / "Assets" / "Editor"
    editor_dir.mkdir(parents=True, exist_ok=True)
    (editor_dir / "TexturePixelOracle.cs").write_text(ORACLE_CS.lstrip(), newline="\n")
    src = BUNDLES / rel
    # A copy on the Windows side: the editor reads it from a local disk.
    local = project / "bundles" / name
    local.parent.mkdir(exist_ok=True)
    shutil.copyfile(src, local)
    out = project / f"oracle-{name}.json"
    out.unlink(missing_ok=True)
    args = [exe, "-batchmode", "-nographics", "-quit", "-buildTarget", target,
            "-projectPath", win(project), "-executeMethod", "TexturePixelOracle.Run",
            "-logFile", win(project / f"oracle-{name}.log"), "-uarBundle", win(local),
            "-uarOut", win(out)]
    code = subprocess.run(args).returncode
    if code != 0 or not out.exists():
        raise SystemExit(f"{version} {name}: Unity exited {code}; see {project}")
    data = json.loads(out.read_text(encoding="utf-8-sig"))
    if data["unity"] != version:
        raise SystemExit(f"{exe} is Unity {data['unity']}, not {version}")
    record = {"bundle": rel, "sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
              "buildTarget": target}
    return {**record, "textures": data["textures"]}


def dump(value, indent=0):
    """JSON with every list of scalars on one line, so the file stays readable."""
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
    a = ap.parse_args()
    exes = dict(u.split("=", 1) for u in a.unity)
    if sorted(exes) != sorted(EDITORS):
        raise SystemExit(f"--unity wants exactly {', '.join(EDITORS)}")
    editors = {}
    for version in EDITORS:
        editors[version] = {name: run_editor(version, exes[version], a.work, a.settings, name)
                            for name in SETS}
        print(f"{version}: " + ", ".join(f"{n} {len(d['textures'])} textures"
                                         for n, d in editors[version].items()), flush=True)
    golden = {
        "_oracle": "Unity editor, Texture2D.GetPixels32(mip) in batchmode (plan section 5)",
        "_generator": "scripts/make-texture-pixel-goldens.py",
        "_pixels": ("each level as GetPixels32 returns it: RGBA8, rows bottom first (Unity's "
                    "stored order), base64. For a DXT, BC or ETC level smaller than a 4x4 block "
                    "the editor returns the whole block; the level is its first rows and "
                    "columns"),
        "_comparison": COMPARISON,
        "editors": editors,
    }
    GOLDEN.write_text(dump(golden) + "\n")
    print(f"wrote {GOLDEN.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
