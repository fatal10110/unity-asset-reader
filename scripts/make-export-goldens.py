#!/usr/bin/env python3
"""Generate the export goldens by running AssetStudio's own exporters (#233).

AssetStudio (Razviar/assetstudio at REVISION) is the golden oracle for export
output (plan section 5, R12). This script builds that revision, unmodified,
from a local clone outside the repository, and runs on every fixture object
of the five exported classes:

  Texture2D  AssetStudio.CLI  Exporter.ExportTexture2D(item, dir, ImageFormat.Png);
             the PNG it writes is decoded back to RGBA in the harness
  Mesh       AssetStudio.CLI  Exporter.ExportMesh(item, dir), the .obj file
  AudioClip  AssetStudio.Utility  new AudioClipConverter(clip).ConvertToWav()
  TextAsset  AssetStudio.CLI  Exporter.ExportTextAsset(item, dir), the file it writes
  Shader     AssetStudio.CLI  Exporter.ExportShader(item, dir), the .shader file
             ShaderConverter.Convert() writes; not run for a shader with
             Direct3D programs (see below)

UnityPy stays the oracle for what goes in. The objects come from the committed
UnityPy goldens (goldens.json, modern-goldens.json), each with the input
metadata recorded there (name, object size, texture format, size and image
data hash, audio data hash, TextAsset script hash); UnityPy 1.25.3 hashes each object's bytes in the
fixtures it reads. AssetStudio's AssetsManager loads the same bundle, and an
object's export is recorded only when AssetStudio reports the same input.

An object gets no golden, but an `exportError` saying why, when AssetStudio
cannot load or export it, names its TextureFormat differently from UnityPy
(its enum has an extra R16_Alt at 66), leaves pixels of the decode buffer
unwritten (checked by exporting over a buffer filled with 0x00, then 0xFF), or
exports different bytes in two runs. A Shader with Direct3D programs (D3D9,
D3D11, D3D11_9x) gets one without being exported: ShaderConverter turns them
into text with Windows' D3DCompiler or the GUI's native HLSLDecompiler, so the
text depends on the host, and unity-asset-reader-shader refuses them anyway.

Everything executable - the extracted AssetStudio tree, the C# harness, the
NuGet packages and AssetStudio's bundled FMOD library - lives in --project,
outside the repository (R2). The only committed output is
fixtures/assetstudio-export-goldens.json. Needs a Windows .NET 8 SDK:
AssetStudio's texture decoder package and FMOD library are Windows builds.
From WSL, pass the Windows dotnet.exe; paths are translated with wslpath.

Usage:
  .venv-oracle/bin/python scripts/make-export-goldens.py --source <assetstudio clone> \\
      --project <external dir> [--dotnet <dotnet>]
"""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import warnings

import UnityPy
from UnityPy import config
from UnityPy.enums import TextureFormat

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "bundles"
OUTPUT = ROOT / "fixtures" / "assetstudio-export-goldens.json"
REVISION = "c37af7dfcdafee93e33b5da9f0285c97998d6ae3"
# git rev-parse c37af7d^{tree}: the extracted source is exactly this tree.
TREE = "ea35788a6a2d755c8c48ad299ce8e4fcc290c6fa"
TEXTURE2D, MESH, SHADER, TEXTASSET, AUDIOCLIP = 28, 43, 48, 49, 83
CLASSES = {TEXTURE2D: "Texture2D", MESH: "Mesh", SHADER: "Shader", TEXTASSET: "TextAsset",
           AUDIOCLIP: "AudioClip"}
# The output each class's entry holds.
OUTPUTS = ["png", "obj", "wav", "bytes", "shader"]
# AssetStudio ships FMOD with its GUI; the harness loads the x64 build from the
# extracted tree. FMOD's own license, never committed.
FMOD = "AssetStudio.GUI/Libraries/x64/fmod.dll"
FMOD_SHA256 = "cad8c684b8f45573ffda50bfdb92208cade53d2a7ec9eb2bb2b7d2d575f9aaba"
NUGET_SOURCE = "https://api.nuget.org/v3/index.json"
# Every package the harness restores, by the SHA-512 of its .nupkg archive.
PACKAGE_SHA512 = {
    "Kyaru.Texture2DDecoder/0.17.0": "oD1wY4XiooFmaAborMTrxleAsshRqqpmxr+pRYFqEy9vwGzt1rP4NXnTkxugjW62D+NzUOyiVB1FWXjpFfV7mw==",
    "Kyaru.Texture2DDecoder.Windows/0.1.0": "aBzBXEKsDVavVL56ndzD2WzbMdJOz8CT2MpLIuu6ZqW/zdRATt1paMI7PbGszbJ1njPfOcpNdpnL+zMxRl7Y0w==",
    "MessagePack/2.6.100-alpha": "hJa2kpbr6oFALeDvNsNHz0ECQM3lBp1eGAoUgtZdiC4DsgsiPyZN7stNGdTCp1thkHsEZUR53/2lz3ifwpRjpQ==",
    "MessagePack.Annotations/2.6.100-alpha": "rc2k+Ee6QJ5qvV3giD+BrAbaTMsExpEK9af/b/vTrYodsLQumKk8LMNksNDO692i4BlXeaSYxi/j6Y6zshL2yA==",
    "Microsoft.NET.StringTools/17.4.0": "wgMpr5DH01KB5xryHxP/N8nz+pPyBPgqB+JFXtfzakzIIV0hl+YpBDcN2rYbgv1r/XM6GY20dXTH7G1hyiuspQ==",
    "Microsoft.NETCore.Platforms/5.0.0": "hJP+EWSMfswgtlMEkNMP1jdElhNFwFAaehCxEEZmHaCbeD3c64syCK5SpyqKlMr9zo3BvWBzwyCB4w0OdAfxdA==",
    "Mono.Cecil/0.11.5": "oD8nPNv52nOxGak4FRml4SwvyWqonDnaiPwdav5tMm6Vniq3cD9maCFdsXCYm528rUA268X7dHDuWWTAc54Mqg==",
    "Newtonsoft.Json/13.0.3": "mbJSvHfRxfX3tR/U6n1WU+mWHXswYc+SB/hkOpx8yZZe68hNZGfymJu0cjsaJEkVzCMqePiU6LdIyogqfIn7kg==",
    "SharpGen.Runtime/2.1.2-beta": "yJbJMKS78s3dCC6AuajLvt07lH1cc5q57Ylp3BJ7XGkegRJDXHMABrjQyQzVwp85YNDeCS5vAtv3tNK+TZY5Eg==",
    "SharpGen.Runtime.COM/2.1.2-beta": "eLyFyFZTrRQwWC5is4O1hViFU68OO0tYgtkwl7hRzn6E9Uc78+FcOj0hykd59RylEva2PwEa/2e3QM587L6aYw==",
    "SixLabors.Fonts/1.0.0-beta18": "uBiPe21m3CCu0eNaDQyx3LJ0H9nP5O8PK2f3dSw1RGOfzdx+3sA316XkrByjecgkHxqYJ9/aR7g4A0p3KlSUIQ==",
    "SixLabors.ImageSharp/2.1.3": "B4VO+wsXBdKEe0NpKa4sojWS+qYDE3W407jqFHCxQFFQPpiivXau/8zTrjUINpiIy5nEaiML/KPcmraJX0zOWQ==",
    "SixLabors.ImageSharp.Drawing/1.0.0-beta15": "nr49GVBxF47lGY+CE3ZopAtflIHlRa8HDyM53pcrp1hDA+13xLAHpHDiaTScZ5bWZ/l2ycGIGvhSt96iY5KNAg==",
    "System.CommandLine/2.0.0-beta4.22272.1": "l5p+Zrop4XvFvsQukm7RU2LiOuQD5JjJVeCd/8TTuqFHd6BvleJdWR/JdXoOqhjeueRmKhyhZj+jAPUJpKA4PA==",
    "System.Configuration.ConfigurationManager/8.0.1": "0u0YuVgqd5msc/yJM5nzxsVG34V7FXNTY3EFmdIbCN0kkjX/aZvs5SFuqgE4e6YchsZzwyCBUT1QLWi+MdNkfA==",
    "System.Diagnostics.EventLog/8.0.1": "LGNrQOycharaFuZOPPxAfnj/3zhiyGwVTIYaUM9Ufee8HPyYX60yr9MtxGWoDE4eAxbJODTXAKl0W2jKhWw22g==",
    "System.Memory/4.5.5": "6MjlNsl7lKw0Q8lAsw2tQ89ul9x6jD2Yk3EEj+dOFoYGOE9eAUO9wNhvd4O/n97oQXlkyzqKXXUnE+kLElFy3A==",
    "System.Runtime.CompilerServices.Unsafe/6.0.0": "1AVzAb5OxJNvJLnOADtexNmWgattm2XVOT3TjQTN7Dd4SqoSwai1CsN2fth42uQldJSQdz/sAec0+TzxBFgisw==",
    "System.Security.Cryptography.ProtectedData/8.0.0": "hvcXZ/IR+KXxY9lC9S2izw5/fGYoODJR2r9kQSvs5v/HUAnBRuYYZPJrHzaT0CeDRJzIm8BHJb1ZrwHQ59j3uQ==",
    "System.Text.Encoding.CodePages/5.0.0": "TzLIAbPciz0ofBcxDo6uy7fT0OMR454cQoQ5/qcnaGD+vDhCKmGryT08u82Xv1EYNbMWVT6THgT2MzqAYp3HRg==",
    "Vortice.D3DCompiler/3.4.3-beta": "bLA0vqV2qGTXniJperOrVMFENoYfm4UzrOI6zjxkylb0SWxyrbg0DiKdB+fT0cUonKAASLRcXpM9YXFaA4OZEA==",
    "Vortice.DirectX/3.4.3-beta": "f4FpyMpCq3hGhmBqnVecoeOp9n7Q5D3HejoaJyoGvt1BiKJ2tlYT1dv3Hu+IZZ7sl0i8AQsLL65pMAdQ3O7MIQ==",
    "Vortice.Mathematics/1.7.6": "R2yq/lCV2jveczsY//gB+eCxvYLmv/9wdZQzrWUJQgX6BMZVrobctSbYR2rRyKC9H7+KHfPhGMoqsLUTLiuDKA==",
    "ZstdSharp.Port/0.7.2": "P6bMQYwgczSwP+sNkIMeoi5/zpE9/zD+fLT9l7bovVs3H/HVkxErMTcxNL9axFTfa5sAIQ+i8xru3w3bVlqQUg==",
}
METHODS = {
    "Texture2D": "AssetStudio.CLI.Exporter.ExportTexture2D(item, dir, ImageFormat.Png)",
    "Mesh": "AssetStudio.CLI.Exporter.ExportMesh(item, dir)",
    "AudioClip": "AssetStudio.AudioClipConverter.ConvertToWav()",
    "TextAsset": "AssetStudio.CLI.Exporter.ExportTextAsset(item, dir)",
    "Shader": "AssetStudio.CLI.Exporter.ExportShader(item, dir), ShaderConverter.Convert()",
}

HARNESS = r'''using System;
using System.Buffers;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using AssetStudio;
using AssetStudio.CLI;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

// Generated by scripts/make-export-goldens.py (unity-asset-reader #233). Calls
// AssetStudio's exporters unmodified; nothing here changes what they write.
public sealed class StderrLogger : ILogger {
    public readonly List<string> Errors = new List<string>();
    public void Log(LoggerEvent e, string message) {
        if (e < LoggerEvent.Warning) return;
        Console.Error.WriteLine("[" + e + "] " + message);
        // "Error while reading ... <path>\n<exception>": keep the exception's first line.
        var lines = message.Split('\n');
        if (e == LoggerEvent.Error) lock (Errors) Errors.Add(lines[lines.Length > 1 ? 1 : 0].Trim());
    }
}

public static class Program {
    static string Sha(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    static string Single(string dir) {
        var files = Directory.Exists(dir) ? Directory.GetFiles(dir) : new string[0];
        if (files.Length != 1) throw new Exception("expected one exported file in " + dir + ", found " + files.Length);
        return files[0];
    }

    public static int Main(string[] args) {
        // The GUI exports on an en-US thread; the CLI inherits the host's culture,
        // which would change the OBJ's number format. Pin the GUI's.
        var culture = new CultureInfo("en-US");
        CultureInfo.DefaultThreadCurrentCulture = culture;
        CultureInfo.DefaultThreadCurrentUICulture = culture;
        Thread.CurrentThread.CurrentCulture = culture;
        Thread.CurrentThread.CurrentUICulture = culture;
        var logger = new StderrLogger();
        Logger.Default = logger;
        Logger.Flags = LoggerEvent.Warning | LoggerEvent.Error;
        var exporter = typeof(AssetItem).Assembly.GetType("AssetStudio.CLI.Exporter", true);
        MethodInfo Method(string name) => exporter.GetMethod(name, BindingFlags.Public | BindingFlags.Static)
            ?? throw new Exception("AssetStudio.CLI.Exporter." + name + " not found");
        var exportTexture2D = Method("ExportTexture2D");
        var exportMesh = Method("ExportMesh");
        var exportTextAsset = Method("ExportTextAsset");
        var exportShader = Method("ExportShader");
        var game = GameManager.GetGame(GameType.Normal);
        var results = new List<Dictionary<string, object>>();
        foreach (var job in JsonDocument.Parse(File.ReadAllText(args[0])).RootElement.EnumerateArray()) {
            var manager = new AssetsManager { Game = game };
            logger.Errors.Clear();
            var editor = job.GetProperty("editor").GetString();
            // The CLI's --unity_version: the editor that built the fixture, so a
            // version-stripped ("0.0.0") file reads as that version, the same
            // version every other file already records.
            if (!string.IsNullOrEmpty(editor)) manager.SpecifyUnityVersion = editor;
            manager.LoadFiles(job.GetProperty("input").GetString());
            foreach (var want in job.GetProperty("objects").EnumerateArray()) {
                var fileName = want.GetProperty("file").GetString();
                var pathId = long.Parse(want.GetProperty("pathId").GetString(), CultureInfo.InvariantCulture);
                var outDir = want.GetProperty("output").GetString();
                var result = new Dictionary<string, object> { ["index"] = want.GetProperty("index").GetInt32() };
                results.Add(result);
                var file = manager.assetsFileList.FirstOrDefault(f => f.fileName == fileName);
                if (file == null || !file.ObjectsDic.TryGetValue(pathId, out var obj)) {
                    var why = logger.Errors.Count > 0 ? ": " + logger.Errors[0] : "";
                    result["exportError"] = "AssetStudio did not load the object" + why;
                    continue;
                }
                var input = new Dictionary<string, object> {
                    ["classId"] = (int)obj.type, ["byteSize"] = obj.byteSize, ["objectSha256"] = Sha(obj.GetRawData()),
                };
                result["input"] = input;
                try {
                    var item = new AssetItem(obj);
                    switch (obj) {
                        case Texture2D texture: {
                            input["name"] = texture.m_Name;
                            input["format"] = (int)texture.m_TextureFormat;
                            input["formatName"] = texture.m_TextureFormat.ToString();
                            input["width"] = texture.m_Width;
                            input["height"] = texture.m_Height;
                            var image = texture.image_data.GetData() ?? new byte[0];
                            input["imageSize"] = image.Length;
                            input["imageSha256"] = Sha(image);
                            // Texture2DExtensions.ConvertToImage decodes into a buffer rented
                            // from ArrayPool<byte>.Shared, which may hold old bytes. Export twice,
                            // the buffer first filled with 0x00, then 0xFF: pixels the decoder
                            // leaves unwritten show up as a difference, and get no golden.
                            var exports = new List<(byte[] png, byte[] rgba, int width, int height)>();
                            foreach (var fill in new byte[] { 0x00, 0xFF }) {
                                var buffer = ArrayPool<byte>.Shared.Rent(texture.m_Width * texture.m_Height * 4);
                                Array.Fill(buffer, fill);
                                ArrayPool<byte>.Shared.Return(buffer);
                                var dir = Path.Combine(outDir, fill.ToString("X2"));
                                if (!(bool)exportTexture2D.Invoke(null, new object[] { item, dir, ImageFormat.Png })) break;
                                var png = File.ReadAllBytes(Single(dir));
                                using var decoded = Image.Load<Rgba32>(png);
                                var rgba = new byte[decoded.Width * decoded.Height * 4];
                                decoded.CopyPixelDataTo(rgba);
                                exports.Add((png, rgba, decoded.Width, decoded.Height));
                            }
                            if (exports.Count < 2) {
                                result["exportError"] = "ExportTexture2D returned false";
                                break;
                            }
                            if (!exports[0].rgba.AsSpan().SequenceEqual(exports[1].rgba)) {
                                result["exportError"] = "undefined pixels: the decoder leaves pixels unwritten, so the PNG holds whatever the pooled buffer held";
                                break;
                            }
                            var (pngBytes, pixels, w, h) = exports[0];
                            result["png"] = new Dictionary<string, object> {
                                ["width"] = w, ["height"] = h, ["rgbaSha256"] = Sha(pixels),
                                ["pngSize"] = pngBytes.Length, ["pngSha256"] = Sha(pngBytes),
                            };
                            break;
                        }
                        case Mesh mesh: {
                            input["name"] = mesh.m_Name;
                            if (!(bool)exportMesh.Invoke(null, new object[] { item, outDir })) {
                                result["exportError"] = "ExportMesh returned false";
                                break;
                            }
                            var text = File.ReadAllBytes(Single(outDir));
                            result["obj"] = new Dictionary<string, object> { ["size"] = text.Length, ["sha256"] = Sha(text) };
                            break;
                        }
                        case AudioClip clip: {
                            input["name"] = clip.m_Name;
                            var data = clip.m_AudioData.GetData() ?? new byte[0];
                            input["dataSize"] = data.Length;
                            input["dataSha256"] = Sha(data);
                            var wav = new AudioClipConverter(clip).ConvertToWav();
                            if (wav == null) {
                                result["exportError"] = "ConvertToWav returned null";
                                break;
                            }
                            result["wav"] = new Dictionary<string, object> { ["size"] = wav.Length, ["sha256"] = Sha(wav) };
                            break;
                        }
                        case TextAsset textAsset: {
                            input["name"] = textAsset.m_Name;
                            input["scriptSize"] = textAsset.m_Script.Length;
                            input["scriptSha256"] = Sha(textAsset.m_Script);
                            if (!(bool)exportTextAsset.Invoke(null, new object[] { item, outDir })) {
                                result["exportError"] = "ExportTextAsset returned false";
                                break;
                            }
                            var bytes = File.ReadAllBytes(Single(outDir));
                            result["bytes"] = new Dictionary<string, object> { ["size"] = bytes.Length, ["sha256"] = Sha(bytes) };
                            break;
                        }
                        case Shader shader: {
                            input["name"] = shader.m_Name;
                            // ShaderConverter turns Direct3D programs into text with Windows'
                            // D3DCompiler or the GUI's native HLSLDecompiler: host-dependent, no golden.
                            var d3d = (shader.platforms ?? new ShaderCompilerPlatform[0])
                                .Where(p => p == ShaderCompilerPlatform.D3D9 || p == ShaderCompilerPlatform.D3D11
                                    || p == ShaderCompilerPlatform.D3D11_9x)
                                .Select(p => p.ToString()).FirstOrDefault();
                            if (d3d != null) {
                                result["exportError"] = "not exported: its " + d3d + " programs need Windows' D3DCompiler or HLSLDecompiler, whose text depends on the host";
                                break;
                            }
                            if (!(bool)exportShader.Invoke(null, new object[] { item, outDir })) {
                                result["exportError"] = "ExportShader returned false";
                                break;
                            }
                            var text = File.ReadAllBytes(Single(outDir));
                            result["shader"] = new Dictionary<string, object> { ["size"] = text.Length, ["sha256"] = Sha(text) };
                            break;
                        }
                        default:
                            result["exportError"] = "AssetStudio read class " + obj.type + " as " + obj.GetType().Name;
                            break;
                    }
                } catch (Exception error) {
                    var inner = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
                    result["exportError"] = inner.GetType().Name + ": " + inner.Message;
                }
            }
            manager.Clear();
        }
        File.WriteAllText(args[1], JsonSerializer.Serialize(results));
        return 0;
    }
}
'''

CSPROJ = '''<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\assetstudio\\AssetStudio.CLI\\AssetStudio.CLI.csproj" />
  </ItemGroup>
</Project>
'''

NUGET_CONFIG = f'''<configuration>
  <packageSources><clear /><add key="nuget.org" value="{NUGET_SOURCE}" /></packageSources>
  <config><add key="globalPackagesFolder" value="packages" /></config>
</configuration>
'''


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def external(path: pathlib.Path) -> pathlib.Path:
    path = path.resolve()
    if path == ROOT or ROOT in path.parents:
        raise SystemExit("AssetStudio source and harness must stay outside the repository (R2)")
    return path


def editor_of(key: str) -> str | None:
    parts = key.split("/")
    return parts[1] if len(parts) > 2 and parts[0] == "editor" else None


def expected_jobs() -> dict[str, list[dict]]:
    """Fixture key -> the objects to export, with UnityPy's input metadata."""
    jobs: dict[str, list[dict]] = {}
    for golden in ("goldens.json", "modern-goldens.json"):
        fixtures = json.loads((ROOT / "fixtures" / golden).read_text())["fixtures"]
        for key, fixture in fixtures.items():
            for file, table in fixture.get("objects", {}).items():
                serialized = fixture["serialized"][file]
                for row in table:
                    class_id, path_id = row["classId"], row["pathId"]
                    if class_id not in CLASSES:
                        continue
                    expected = {"classId": class_id, "byteSize": row["byteSize"],
                                "name": serialized["names"][path_id]}
                    texture = serialized.get("textures", {}).get(path_id)
                    if class_id == TEXTURE2D and texture:
                        expected.update({k: texture[k] for k in
                                         ["format", "width", "height", "imageSize", "imageSha256"]})
                        expected["formatName"] = TextureFormat(texture["format"]).name
                    raw = serialized.get("rawData", {}).get(path_id)
                    if class_id == AUDIOCLIP and raw:
                        expected.update({"dataSize": raw["size"], "dataSha256": raw["sha256"]})
                    dump = serialized.get("typetrees", {}).get(path_id)
                    if class_id == TEXTASSET and dump:
                        # make-goldens.py keeps m_Script as UnityPy decodes it (UTF-8,
                        # surrogateescape), so this gives back the bytes UnityPy read.
                        script = dump["value"]["m_Script"].encode("utf-8", "surrogateescape")
                        expected.update({"scriptSize": len(script), "scriptSha256": sha256(script)})
                    jobs.setdefault(key, []).append(
                        {"file": file, "pathId": path_id, "golden": golden, "expected": expected})
    return jobs


def unitypy_object_hashes(key: str) -> dict[tuple[str, str], str] | None:
    """UnityPy 1.25.3's sha256 of every object's bytes, or None if it cannot read the fixture."""
    config.FALLBACK_UNITY_VERSION = editor_of(key)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            env = UnityPy.load(str(FIXTURES / key))
            return {(obj.assets_file.name, str(obj.path_id)): sha256(bytes(obj.get_raw_data()))
                    for obj in env.objects}
    except Exception:  # noqa: BLE001 - format 23 (modern-goldens.json) needs UnityPy 1.25.4
        return None
    finally:
        config.FALLBACK_UNITY_VERSION = None


class Host:
    """Runs the .NET tools, translating paths for a Windows dotnet.exe called from WSL."""

    def __init__(self, dotnet: str):
        self.dotnet = dotnet
        self.wsl = sys.platform != "win32" and dotnet.lower().endswith(".exe")

    def path(self, path: pathlib.Path) -> str:
        if not self.wsl:
            return str(path)
        return subprocess.run(["wslpath", "-w", str(path)], check=True, capture_output=True,
                              text=True).stdout.strip()

    def run(self, *args):
        subprocess.run([*args], check=True)


def extract_source(source: pathlib.Path, target: pathlib.Path) -> None:
    """Write REVISION's tree, as git stores it, to target: no working-tree edits get in."""
    tree = subprocess.run(["git", "-C", str(source), "rev-parse", REVISION + "^{tree}"],
                          check=True, capture_output=True, text=True).stdout.strip()
    if tree != TREE:
        raise SystemExit(f"{source}: {REVISION} has tree {tree}, expected {TREE}")
    archive = subprocess.run(["git", "-C", str(source), "archive", "--format=tar", REVISION],
                             check=True, capture_output=True).stdout
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data")


def build(host: Host, project: pathlib.Path) -> pathlib.Path:
    harness = project / "harness"
    harness.mkdir(parents=True, exist_ok=True)
    (project / "NuGet.config").write_text(NUGET_CONFIG)
    (harness / "Harness.csproj").write_text(CSPROJ)
    (harness / "Program.cs").write_text(HARNESS)
    csproj = host.path(harness / "Harness.csproj")
    # AssetStudio also targets net10.0; build its net8.0 side only.
    tfm = "-p:TargetFrameworks=net8.0-windows"
    host.run(host.dotnet, "restore", csproj, tfm,
             "--configfile", host.path(project / "NuGet.config"))
    assets = json.loads((harness / "obj" / "project.assets.json").read_text())
    # Hash the downloaded archives themselves, as section 15's harness does.
    resolved = {}
    for identity, library in assets["libraries"].items():
        if library["type"] != "package":
            continue
        name, version = identity.lower().split("/")
        archive = project / "packages" / name / version / f"{name}.{version}.nupkg"
        digest = hashlib.sha512(archive.read_bytes()).digest()
        resolved[identity] = base64.b64encode(digest).decode()
    if resolved != PACKAGE_SHA512:
        changed = sorted(set(resolved.items()) ^ set(PACKAGE_SHA512.items()))
        raise SystemExit("restored NuGet packages differ from the pinned set: " + repr(changed))
    out = harness / "bin"
    host.run(host.dotnet, "build", csproj, tfm, "--no-restore", "-nologo", "-o", host.path(out))
    fmod = (project / "assetstudio" / FMOD).read_bytes()
    if sha256(fmod) != FMOD_SHA256:
        raise SystemExit(f"{FMOD}: sha256 {sha256(fmod)}, expected {FMOD_SHA256}")
    # Where the GUI ships it (AssetStudio.GUI.csproj): FMOD.Factory preloads
    # <exe dir>/x64/fmod.dll through AssetStudio.PInvoke.DllLoader.
    (out / "x64").mkdir(exist_ok=True)
    (out / "x64" / "fmod.dll").write_bytes(fmod)
    return out / "Harness.exe"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, type=pathlib.Path,
                        help="a git clone of Razviar/assetstudio holding " + REVISION)
    parser.add_argument("--project", required=True, type=pathlib.Path,
                        help="an external directory for the build and the run")
    parser.add_argument("--dotnet", default=shutil.which("dotnet") or shutil.which("dotnet.exe"))
    args = parser.parse_args()
    if UnityPy.__version__ != "1.25.3":
        raise SystemExit("requires UnityPy==1.25.3, the goldens.json oracle")
    if not args.dotnet:
        raise SystemExit(".NET 8 SDK (Windows) required; supply --dotnet")
    source, project = external(args.source), external(args.project)
    host = Host(args.dotnet)

    jobs = expected_jobs()
    project.mkdir(parents=True, exist_ok=True)
    extract_source(source, project / "assetstudio")
    exe = build(host, project)

    for name in ["inputs", "runs"]:
        if (project / name).exists():
            shutil.rmtree(project / name)
    bundles, flat = [], []
    for n, (key, objects) in enumerate(sorted(jobs.items())):
        # One bundle per folder: AssetStudio scans the folder of what it loads.
        bundle = project / "inputs" / str(n) / pathlib.Path(key).name
        bundle.parent.mkdir(parents=True)
        bundle.write_bytes((FIXTURES / key).read_bytes())
        bundles.append((key, bundle, [len(flat) + i for i in range(len(objects))]))
        flat.extend({**job, "fixture": key} for job in objects)

    def run(name: str) -> dict[int, dict]:
        """One harness process over every job, exporting into runs/<name>/<index>/."""
        manifest = [{"input": host.path(bundle), "editor": editor_of(key), "objects": [
            {"index": i, "file": flat[i]["file"], "pathId": flat[i]["pathId"],
             "output": host.path(project / "runs" / name / str(i))} for i in indices]}
            for key, bundle, indices in bundles]
        jobs_file = project / "runs" / f"{name}.json"
        results_file = project / "runs" / f"{name}-results.json"
        jobs_file.parent.mkdir(parents=True, exist_ok=True)
        jobs_file.write_text(json.dumps(manifest, indent=1))
        host.run(str(exe), host.path(jobs_file), host.path(results_file))
        return {r.pop("index"): r for r in json.loads(results_file.read_text())}

    # Two runs: an export that differs between them is no golden.
    results, again = run("a"), run("b")
    for index, result in results.items():
        if result != again.get(index):
            for output in OUTPUTS:
                result.pop(output, None)
            result["exportError"] = "nondeterministic: AssetStudio's output differs between two runs"

    hashes: dict[str, dict | None] = {}
    fixtures: dict = {}
    for index, job in enumerate(flat):
        key, result = job["fixture"], results.get(index)
        where = f"{key} {job['file']} {job['pathId']}"
        if result is None:
            raise SystemExit(f"{where}: the harness returned no result")
        entry = {"class": CLASSES[job["expected"]["classId"]], "input": job["expected"],
                 "inputOracle": job["golden"]}
        actual = result.get("input")
        if actual is not None:
            # Record nothing AssetStudio exported from an input other than UnityPy's.
            want = job["expected"].get("formatName", actual.get("formatName"))
            if actual.get("formatName") != want:
                # AssetStudio's TextureFormat enum has an extra R16_Alt at 66, so every
                # later value names the next format: it decodes Unity's RG32 (72) as
                # ASTC_HDR_12x12. Its export is of another format; no golden.
                result = {"exportError": (
                    f"input mismatch: AssetStudio reads TextureFormat {actual['format']} as "
                    f"{actual['formatName']}, UnityPy as {job['expected']['formatName']} "
                    "(AssetStudio's enum inserts R16_Alt at 66), so its export decodes "
                    "another format")}
            for field, value in job["expected"].items():
                if field != "formatName" and actual.get(field) != value:
                    raise SystemExit(f"{where}: AssetStudio reads {field} = "
                                     f"{actual.get(field)!r}, {job['golden']} says {value!r}")
            if key not in hashes:
                hashes[key] = unitypy_object_hashes(key)
            if hashes[key] is None:
                entry["inputOracle"] += ("; object bytes not checked (UnityPy 1.25.3 cannot read "
                                         "the fixture)")
            elif hashes[key].get((job["file"], job["pathId"])) != actual["objectSha256"]:
                raise SystemExit(f"{where}: object bytes differ from UnityPy's")
            else:
                entry["inputOracle"] += "; object bytes: UnityPy 1.25.3"
            entry["input"] = actual
        for output in [*OUTPUTS, "exportError"]:
            if output in result:
                entry[output] = result[output]
        if ("exportError" in entry) == any(k in entry for k in OUTPUTS):
            raise SystemExit(f"{where}: want an export or an exportError, got {sorted(result)}")
        fixtures.setdefault(key, {}).setdefault(job["file"], {})[job["pathId"]] = entry
        status = result.get("exportError") or next(k for k in OUTPUTS if k in result)
        print(f"  {where:<90} {entry['class']:<10} {status}")

    golden = {
        "_oracle": f"AssetStudio {REVISION[:7]} (Razviar/assetstudio), executed",
        "_generator": "scripts/make-export-goldens.py",
        "revision": REVISION,
        "tree": TREE,
        "source": f"https://github.com/Razviar/assetstudio/tree/{REVISION}",
        "inputOracle": "UnityPy: goldens.json (1.25.3) and modern-goldens.json (1.25.4) name each "
                       "object and its input metadata; UnityPy 1.25.3 hashes each object's bytes "
                       "where it reads the fixture",
        "methods": METHODS,
        "execution": "AssetStudio's projects built unmodified from the revision's tree for "
                     "net8.0-windows; objects loaded with its AssetsManager (one bundle per "
                     "folder; SpecifyUnityVersion, the CLI's --unity_version, = the editor in the "
                     "fixture's path, which a version-stripped file needs); "
                     "exporters called on the en-US culture of the GUI's export thread. PNG "
                     "decoded with the ImageSharp AssetStudio pins; rgbaSha256 is its RGBA8 "
                     "pixels in the PNG's row order, top row first.",
        "culture": "en-US",
        "fmod": {"path": FMOD, "sha256": FMOD_SHA256},
        "nugetSource": NUGET_SOURCE,
        "packageSha512": PACKAGE_SHA512,
        "fixtures": fixtures,
    }
    OUTPUT.write_text(json.dumps(golden, indent=2) + "\n")
    print(f"\n{len(flat)} objects -> {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
