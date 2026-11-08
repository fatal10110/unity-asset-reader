#!/usr/bin/env python3
"""Generate the export goldens by running AssetStudio's own exporters (#233).

AssetStudio (Razviar/assetstudio at REVISION) is the golden oracle for export
output (plan section 5, R12). This script builds that revision, unmodified,
from a local clone outside the repository, and runs on every fixture object
of the eight exported classes:

  Texture2D  AssetStudio.CLI  Exporter.ExportTexture2D(item, dir, ImageFormat.Png);
             the PNG it writes is decoded back to RGBA in the harness
  Sprite     AssetStudio.CLI  Exporter.ExportSprite(item, dir, ImageFormat.Png),
             Sprite.GetImage(); the PNG decoded back to RGBA the same way
  Mesh       AssetStudio.CLI  Exporter.ExportMesh(item, dir), the .obj file; for a
             skinned Mesh also its decoded m_Skin (`skin`, weights as float32
             bits), the cross-check of UnityPy's skin goldens (#285)
  AudioClip  AssetStudio.Utility  new AudioClipConverter(clip).ConvertToWav()
  TextAsset  AssetStudio.CLI  Exporter.ExportTextAsset(item, dir), the file it writes
  Shader     AssetStudio.CLI  Exporter.ExportShader(item, dir), the .shader file
             ShaderConverter.Convert() writes; not run for a shader with
             Direct3D programs (see below). Vulkan stages in the newer SMOL-V
             encoding: see "Vulkan programs" below
  Font       AssetStudio.CLI  Exporter.ExportFont(item, dir), the .ttf or .otf file
  VideoClip  AssetStudio.CLI  Exporter.ExportVideoClip(item, dir), the file it writes
             from the bundle's .resource node, named by m_OriginalPath's extension

UnityPy stays the oracle for what goes in. The objects come from the committed
UnityPy goldens (goldens.json, modern-goldens.json), each with the input
metadata recorded there (name, object size, texture format, size and image
data hash, audio, font and video data hash, TextAsset script hash); UnityPy 1.25.3 hashes each object's bytes in the
fixtures it reads. AssetStudio's AssetsManager loads the same bundle, and an
object's export is recorded only when AssetStudio reports the same input.

An object gets no golden, but an `exportError` saying why, when AssetStudio
cannot load or export it, names its TextureFormat differently from UnityPy
(its enum has an extra R16_Alt at 66), leaves pixels of the decode buffer
unwritten (checked by exporting a Texture2D or Sprite over a buffer filled
with 0x00, then 0xFF), or exports different bytes in two runs. A Shader with Direct3D programs (D3D9,
D3D11, D3D11_9x) gets one without being exported: ShaderConverter turns them
into text with Windows' D3DCompiler or the GUI's native HLSLDecompiler, so the
text depends on the host, and unity-asset-reader-shader refuses them anyway.
A Mesh with a submesh baseVertex gets one too: ExportMesh writes its indices
without the offset, which unity-asset-reader applies (#257); the entry keeps
that OBJ's size and hash as `objWithoutBaseVertex`.

Vulkan programs (plan section 5, revision 2026-11-07c, #260): each stage is a
SMOL-V stream, which AssetStudio decodes with its C# port of smol-v's
2016-08-31 code. Unity 2020.3 and later write encoding version 1 (the high
byte of the header's version word), which that port predates: AssetStudio
writes "// disassembly error Unable to decode SMOL-V shader" for every such
program. The oracle for those is a hybrid. Their SPIR-V comes from
aras-p/smol-v at SMOLV_REVISION, smolv::Decode, built here with g++ from a
clone outside the repository (--smolv) with a small generated main. Their text
is AssetStudio's own CSspv disassembler (SpirV.Module.ReadFrom, Disassembler)
on those words, framed as SpirVShaderConverter.Convert and
ShaderSubProgram.Export frame it (the "// hash:" line, one stage after the
other, "// disassembly error <message>" when a stage fails). Stages of
encoding version 0 keep AssetStudio's decoder; smol-v with
kDecodeFlagUse20160831AsZeroVersion must decode every one of them to
AssetStudio's words, or the run fails. The steps:

  1. a "dump" harness run writes each Vulkan stage's SMOL-V bytes, and for
     version 0 the words AssetStudio's SmolvDecoder gives, to <project>/stages;
  2. smol-v decodes them: version 0 with the 2016-08-31 flag (the check),
     later versions with no flags;
  3. the export runs call ExportShader unmodified, then replace the text of
     each program with a stage of version 1, AssetStudio's error line, by the
     hybrid text.

Each Shader golden lists its stages under shader.spirv, by the sha256 of the
stage's SMOL-V bytes: the encoding version and the size and sha256 of the
SPIR-V, or the error that stops the stage.

Shaders with variants in m_PlayerSubPrograms (plan section 5, revision
2026-11-08a, #259): Unity 2021.3.10, 2022.1.13, 2022.2 and later list them
there, which c37af7d's ShaderConverter does not read, and its Shader reader
skips every 6000+ Shader. Their oracle is a composite, run by the same
harness instead of ExportShader:

  1. UnityPy 1.25.4 (--modern-python, which also reads format 23) reads the
     Shader's type tree (this script's --player-programs mode);
  2. the harness fills AssetStudio's own SerializedShader with it, by field
     name; each distinct (m_BlobIndex, m_GpuProgramType) of a stage's
     m_PlayerSubPrograms, its groups in order, where it first appears,
     becomes one SerializedSubProgram of hardware tier 0 after the stage's
     m_SubPrograms;
  3. each blob entry those name is read by c37af7d's ShaderSubProgram(reader,
     false); the others are the variants' parameters (m_ParameterBlobIndices),
     which do not read as programs and which the text leaves out;
  4. ShaderConverter's own ConvertSerializedShader writes the text after its
     header; Vulkan programs then go through the hybrid as above.

ConvertSerializedSubPrograms writes "hw_tierNN" only for a blob index and type
with several variants; each has one here, so the text has none. These goldens
carry "oracle": the composite.

Two kinds of Sprite get their golden and a `verdict`, where
unity-asset-reader-texture's decodeSprite differs from GetImage() by design:
one cut from a texture with an ETC1 split alpha texture (GetImage() never reads
the alpha texture, decodeSprite merges it, #152), and one whose own
m_SpriteAtlas is a variant atlas (AssetStudio's AssetsManager moves it to the
master atlas, decodeSprite cuts the variant, #153).

Everything executable - the extracted AssetStudio tree, the C# harness, the
NuGet packages, AssetStudio's bundled FMOD library, the smol-v source and its
build - lives in --project, outside the repository (R2). The only committed
output is fixtures/assetstudio-export-goldens.json. Needs a Windows .NET 8 SDK:
AssetStudio's texture decoder package and FMOD library are Windows builds.
From WSL, pass the Windows dotnet.exe; paths are translated with wslpath.

Usage:
  .venv-oracle/bin/python scripts/make-export-goldens.py --source <assetstudio clone> \\
      --smolv <aras-p/smol-v clone> --modern-python <UnityPy 1.25.4 python> \\
      --project <external dir> [--dotnet <dotnet>]
"""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import re
import shutil
import struct
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
# aras-p/smol-v (MIT / Unlicense), the SPIR-V oracle for SMOL-V encoding version 1.
SMOLV_REVISION = "6303e979b59153ee7007fd14e06d3fed8687b64c"
# git rev-parse 6303e97^{tree}: the source is exactly this tree.
SMOLV_TREE = "3486b96991f9c886b8fca6817043f571aa48c648"
TEXTURE2D, MESH, SHADER, TEXTASSET, AUDIOCLIP, FONT, SPRITE, VIDEOCLIP = (
    28, 43, 48, 49, 83, 128, 213, 329)
CLASSES = {TEXTURE2D: "Texture2D", MESH: "Mesh", SHADER: "Shader", TEXTASSET: "TextAsset",
           AUDIOCLIP: "AudioClip", FONT: "Font", SPRITE: "Sprite", VIDEOCLIP: "VideoClip"}
# What a Sprite whose texture has an alpha texture (ETC1 split alpha) records
# next to its golden: unity-asset-reader differs from GetImage() there on purpose.
ALPHA_VERDICT = ("GetImage() cuts the texture alone and never reads its alpha texture "
                 "(SpriteHelper.cs:15-34); unity-asset-reader-texture's decodeSprite merges "
                 "the alpha texture first (#152), so its alpha channel differs; the golden "
                 "is compared with a cut of the base texture")
# What a Sprite whose own m_SpriteAtlas is a variant atlas records next to its golden.
VARIANT_VERDICT = ("AssetStudio's AssetsManager moves a sprite whose m_SpriteAtlas is a variant "
                   "atlas to the master atlas that packs it (AssetsManager.cs:1060-1085), so "
                   "GetImage() cuts the master's full-size texture; unity-asset-reader-texture's "
                   "decodeSprite follows the sprite's own pointer and cuts the variant, resized "
                   "as CutImage resizes it (#153); the golden is compared with a cut of the "
                   "master atlas entry")
# The output each class's entry holds.
OUTPUTS = ["png", "obj", "wav", "bytes", "shader", "font", "video"]
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
# What a Shader with variants in m_PlayerSubPrograms records as its oracle (#259).
COMPOSITE = ("composite (plan section 5, revision 2026-11-08a): UnityPy 1.25.4's type tree "
             "in AssetStudio's SerializedShader, each distinct (m_BlobIndex, m_GpuProgramType) "
             "of m_PlayerSubPrograms as one SerializedSubProgram of tier 0, its blob entries "
             "read by ShaderSubProgram(reader, false), text by "
             "ShaderConverter.ConvertSerializedShader")
METHODS = {
    "Texture2D": "AssetStudio.CLI.Exporter.ExportTexture2D(item, dir, ImageFormat.Png)",
    "Sprite": "AssetStudio.CLI.Exporter.ExportSprite(item, dir, ImageFormat.Png), Sprite.GetImage()",
    "Mesh": "AssetStudio.CLI.Exporter.ExportMesh(item, dir)",
    "AudioClip": "AssetStudio.AudioClipConverter.ConvertToWav()",
    "TextAsset": "AssetStudio.CLI.Exporter.ExportTextAsset(item, dir)",
    "Shader": "AssetStudio.CLI.Exporter.ExportShader(item, dir), ShaderConverter.Convert(); "
              "Vulkan stages of SMOL-V encoding version 1: aras-p/smol-v "
              f"{SMOLV_REVISION[:7]} smolv::Decode, disassembled by AssetStudio's "
              "SpirV.Module.ReadFrom + Disassembler, framed as SpirVShaderConverter.Convert; "
              "variants in m_PlayerSubPrograms: " + COMPOSITE,
    "Font": "AssetStudio.CLI.Exporter.ExportFont(item, dir)",
    "VideoClip": "AssetStudio.CLI.Exporter.ExportVideoClip(item, dir)",
}

HARNESS = r'''using System;
using System.Buffers;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using AssetStudio;
using Smolv;
using AssetStudio.CLI;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

// Generated by scripts/make-export-goldens.py (unity-asset-reader #233). Calls
// AssetStudio's exporters unmodified; nothing here changes what they write,
// except the text of Vulkan programs in SMOL-V encoding version 1, which the
// hybrid oracle replaces (#260; see the script).
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

    // --- Vulkan programs: the hybrid oracle for SMOL-V encoding version 1 (#260) ---

    // Each SPIR-V program's text, as AssetStudio wrote it, replaced by the
    // hybrid's where they differ; null, with a harnessError, when it is not there.
    static string ReplaceSpirv(string written, IEnumerable<ShaderSubProgram> programs, string stagesDir,
                               Dictionary<string, object> result) {
        // Replace() changes every copy, so a program whose text another
        // program already had is done.
        var replaced = new HashSet<string>();
        foreach (var program in programs) {
            var upstream = ProgramText(program, SpirVShaderConverter.Convert);
            var hybrid = ProgramText(program, code => HybridConvert(code, stagesDir));
            if (upstream == hybrid || !replaced.Add(upstream)) continue;
            if (!written.Contains(upstream)) {
                result["harnessError"] = "AssetStudio's text of SPIR-V program " + upstream.Split('\n')[0] + " is not in the .shader file";
                return null;
            }
            written = written.Replace(upstream, hybrid);
        }
        return written;
    }

    // --- Shaders with variants in m_PlayerSubPrograms: the composite oracle (#259) ---
    // c37af7d's Shader reader skips every 6000+ Shader, and its ShaderConverter
    // reads only m_SubPrograms. The composite (plan section 5, revision
    // 2026-11-08a): UnityPy 1.25.4's type tree fills AssetStudio's own
    // SerializedShader; each distinct (m_BlobIndex, m_GpuProgramType) of a
    // stage's m_PlayerSubPrograms becomes one SerializedSubProgram of tier 0
    // after its m_SubPrograms; ShaderSubProgram(reader, false) reads each blob
    // entry those name; ShaderConverter's own ConvertSerializedShader writes the text.

    static readonly MethodInfo convertSerialized = typeof(ShaderConverter).GetMethod(
        "ConvertSerializedShader", BindingFlags.NonPublic | BindingFlags.Static, null,
        new[] { typeof(SerializedShader), typeof(ShaderCompilerPlatform[]), typeof(ShaderProgram[]) }, null)
        ?? throw new Exception("ShaderConverter.ConvertSerializedShader(SerializedShader, ...) not found");
    static readonly string convertHeader = (string)(typeof(ShaderConverter).GetField(
        "header", BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new Exception("ShaderConverter.header not found")).GetValue(null);
    static readonly string[] stageFields =
        { "progVertex", "progFragment", "progGeometry", "progHull", "progDomain", "progRayTracing" };

    static bool IsList(Type t) => t.IsGenericType && t.GetGenericTypeDefinition() == typeof(List<>);

    static object Collection(Type t, List<JsonElement> items) {
        var element = t.IsArray ? t.GetElementType() : t.GetGenericArguments()[0];
        if (t.IsArray) {
            var array = Array.CreateInstance(element, items.Count);
            for (var i = 0; i < items.Count; i++) array.SetValue(Fill(element, items[i]), i);
            return array;
        }
        var list = (IList)Activator.CreateInstance(t);
        foreach (var item in items) list.Add(Fill(element, item));
        return list;
    }

    // A type tree value, as the script encodes it (a float as "f:<its bits>",
    // bytes as base64, a map as [key, value] pairs), as a value of type t: a
    // class's public fields by their names, a fixed array the type tree writes
    // as numbered fields (m_DefValue[0], rtBlend0) from those.
    static object Fill(Type t, JsonElement e) {
        if (t == typeof(string)) return e.GetString();
        if (t == typeof(float)) {
            var text = e.GetString();
            if (!text.StartsWith("f:")) throw new Exception("not a float: " + text);
            return BitConverter.Int32BitsToSingle(unchecked((int)uint.Parse(text.Substring(2), CultureInfo.InvariantCulture)));
        }
        if (t == typeof(bool)) return e.ValueKind == JsonValueKind.Number ? e.GetInt64() != 0 : e.GetBoolean();
        if (t.IsEnum) return Enum.ToObject(t, e.GetInt64());
        if (t.IsPrimitive) return Convert.ChangeType(e.GetInt64(), t, CultureInfo.InvariantCulture);
        if (t == typeof(byte[]) && e.ValueKind == JsonValueKind.String) return Convert.FromBase64String(e.GetString());
        if (t.IsArray || IsList(t)) return Collection(t, e.EnumerateArray().ToList());
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(KeyValuePair<,>)) {
            var pair = e.EnumerateArray().ToList();
            var types = t.GetGenericArguments();
            return Activator.CreateInstance(t, Fill(types[0], pair[0]), Fill(types[1], pair[1]));
        }
        var o = RuntimeHelpers.GetUninitializedObject(t);
        foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance)) {
            if (e.TryGetProperty(f.Name, out var v)) {
                f.SetValue(o, Fill(f.FieldType, v));
                continue;
            }
            if (!f.FieldType.IsArray && !IsList(f.FieldType)) continue;
            var items = new List<JsonElement>();
            for (var i = 0; ; i++) {
                if (e.TryGetProperty(f.Name + "[" + i + "]", out var x) || e.TryGetProperty(f.Name + i, out x)) items.Add(x);
                else break;
            }
            f.SetValue(o, Collection(f.FieldType, items));
        }
        return o;
    }

    static uint[] Uints(JsonElement e) => e.EnumerateArray().Select(x => x.GetUInt32()).ToArray();

    // The composite's input: the parsed form with the player variants as
    // m_SubPrograms, the platforms, and each platform's programs.
    static (SerializedShader form, ShaderCompilerPlatform[] platforms, ShaderProgram[] programs) Composite(JsonElement c) {
        var form = (SerializedShader)Fill(typeof(SerializedShader), c.GetProperty("form"));
        var referenced = new HashSet<uint>();
        foreach (var subShader in form.m_SubShaders) {
            foreach (var pass in subShader.m_Passes) {
                foreach (var field in stageFields) {
                    var program = (SerializedProgram)typeof(SerializedPass).GetField(field).GetValue(pass);
                    if (program == null) continue;
                    program.m_SubPrograms ??= new List<SerializedSubProgram>();
                    var seen = new HashSet<(uint, ShaderGpuProgramType)>();
                    foreach (var group in program.m_PlayerSubPrograms ?? new List<List<SerializedPlayerSubProgram>>()) {
                        foreach (var player in group) {
                            if (!seen.Add((player.m_BlobIndex, player.m_GpuProgramType))) continue;
                            var variant = (SerializedSubProgram)RuntimeHelpers.GetUninitializedObject(typeof(SerializedSubProgram));
                            variant.m_BlobIndex = player.m_BlobIndex;
                            variant.m_GpuProgramType = player.m_GpuProgramType;
                            variant.m_ShaderHardwareTier = 0;
                            program.m_SubPrograms.Add(variant);
                            referenced.Add(player.m_BlobIndex);
                        }
                    }
                }
            }
        }
        var platforms = c.GetProperty("platforms").EnumerateArray().Select(p => (ShaderCompilerPlatform)p.GetInt32()).ToArray();
        var version = c.GetProperty("version").EnumerateArray().Select(v => v.GetInt32()).ToArray();
        var blob = Convert.FromBase64String(c.GetProperty("compressedBlob").GetString());
        var offsets = c.GetProperty("offsets");
        var compressedLengths = c.GetProperty("compressedLengths");
        var decompressedLengths = c.GetProperty("decompressedLengths");
        var programs = new ShaderProgram[platforms.Length];
        for (var i = 0; i < platforms.Length; i++) {
            var offset = Uints(offsets[i]);
            var compressed = Uints(compressedLengths[i]);
            var size = Uints(decompressedLengths[i]);
            for (var j = 0; j < offset.Length; j++) {
                var decompressed = new byte[size[j]];
                if (LZ4.Instance.Decompress(blob.AsSpan().Slice((int)offset[j], (int)compressed[j]), decompressed) != decompressed.Length) throw new IOException("Lz4 decompression error");
                using var reader = new EndianBinaryReader(new MemoryStream(decompressed), EndianType.LittleEndian);
                if (j == 0) {
                    // ShaderProgram's constructor, without its game check (GameType.Normal).
                    var entries = new ShaderSubProgramEntry[reader.ReadInt32()];
                    for (var k = 0; k < entries.Length; k++) entries[k] = new ShaderSubProgramEntry(reader, version);
                    programs[i] = (ShaderProgram)RuntimeHelpers.GetUninitializedObject(typeof(ShaderProgram));
                    programs[i].entries = entries;
                    programs[i].m_SubPrograms = new ShaderSubProgram[entries.Length];
                }
                var table = programs[i].entries;
                for (var k = 0; k < table.Length; k++) {
                    if (table[k].Segment != j || !referenced.Contains((uint)k)) continue;
                    reader.BaseStream.Position = table[k].Offset;
                    try {
                        programs[i].m_SubPrograms[k] = new ShaderSubProgram(reader, false);
                    } catch (Exception) {
                        // The same index on a platform that does not run the variant's
                        // type may be a parameter entry: ConvertSerializedSubPrograms
                        // never reads it there, and a null fails if it does.
                    }
                }
            }
        }
        return (form, platforms, programs);
    }

    static IEnumerable<ShaderSubProgram> CompositeSpirv(ShaderProgram[] programs) =>
        programs.Where(p => p != null).SelectMany(p => p.m_SubPrograms)
            .Where(p => p != null && p.m_ProgramType == ShaderGpuProgramType.SPIRV);

    // One composite job: the dump run's stages, or the text.
    static void RunComposite(JsonElement c, bool dump, string stagesDir, Dictionary<string, object> result) {
        var given = c.GetProperty("input");
        result["input"] = new Dictionary<string, object> {
            ["classId"] = given.GetProperty("classId").GetInt32(),
            ["byteSize"] = given.GetProperty("byteSize").GetInt64(),
            ["objectSha256"] = given.GetProperty("objectSha256").GetString(),
            ["name"] = given.GetProperty("name").GetString(),
        };
        result["oracle"] = "composite";
        var (form, platforms, programs) = Composite(c);
        if (dump) {
            try {
                result["stages"] = DumpStages(CompositeSpirv(programs), stagesDir);
            } catch (Exception error) {
                result["dumpError"] = error.GetType().Name + ": " + error.Message;
            }
            return;
        }
        var d3d = platforms.Where(p => p == ShaderCompilerPlatform.D3D9 || p == ShaderCompilerPlatform.D3D11
                || p == ShaderCompilerPlatform.D3D11_9x).Select(p => p.ToString()).FirstOrDefault();
        if (d3d != null) {
            result["exportError"] = "not exported: its " + d3d + " programs need Windows' D3DCompiler or HLSLDecompiler, whose text depends on the host";
            return;
        }
        string written;
        try {
            written = convertHeader + (string)convertSerialized.Invoke(null, new object[] { form, platforms, programs });
        } catch (TargetInvocationException error) {
            var inner = error.InnerException;
            result["exportError"] = "ShaderConverter.ConvertSerializedShader throws " + inner.GetType().Name + ": " + inner.Message.Split('\n')[0];
            return;
        }
        written = ReplaceSpirv(written, CompositeSpirv(programs), stagesDir, result);
        if (written == null) return;
        var text = new UTF8Encoding(false, true).GetBytes(written);
        result["shader"] = new Dictionary<string, object> { ["size"] = text.Length, ["sha256"] = Sha(text) };
    }

    static readonly MethodInfo exportSnippet = typeof(SpirVShaderConverter).GetMethod(
        "ExportSnippet", BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new Exception("SpirVShaderConverter.ExportSnippet not found");

    // ShaderConverter.ConvertSerializedShader's blob walk: every SPIR-V program.
    static List<ShaderSubProgram> SpirvPrograms(Shader shader) {
        var found = new List<ShaderSubProgram>();
        if (shader.compressedBlob == null) return found;
        for (var i = 0; i < shader.platforms.Length; i++) {
            ShaderProgram program = null;
            for (var j = 0; j < shader.offsets[i].Length; j++) {
                var decompressed = new byte[shader.decompressedLengths[i][j]];
                var packed = shader.compressedBlob.AsSpan().Slice((int)shader.offsets[i][j], (int)shader.compressedLengths[i][j]);
                if (LZ4.Instance.Decompress(packed, decompressed) != decompressed.Length) throw new IOException("Lz4 decompression error");
                using var blob = new EndianBinaryReader(new MemoryStream(decompressed), EndianType.LittleEndian);
                if (j == 0) program = new ShaderProgram(blob, shader);
                program.Read(blob, j);
            }
            if (program == null) continue;
            found.AddRange(program.m_SubPrograms.Where(p => p != null && p.m_ProgramType == ShaderGpuProgramType.SPIRV));
        }
        return found;
    }

    // SpirVShaderConverter.Convert's stage table: (offset, size) of each stage.
    static List<(int offset, int size)> Stages(byte[] code) {
        var stages = new List<(int, int)>();
        using var reader = new BinaryReader(new MemoryStream(code));
        reader.ReadInt32(); // requirements
        int minOffset = code.Length;
        for (int i = 0; i < 5; i++) {
            if (reader.BaseStream.Position >= minOffset) break;
            int offset = reader.ReadInt32();
            int size = reader.ReadInt32();
            if (size > 0) {
                if (offset < minOffset) minOffset = offset;
                stages.Add((offset, size));
            }
        }
        return stages;
    }

    // A stage's file name in the stages directory: the sha256 of its SMOL-V bytes.
    static string StageName(byte[] code, int offset, int size) =>
        Sha(code.AsSpan(offset, Math.Min(size, code.Length - offset)).ToArray());

    // AssetStudio's SpirVShaderConverter.ExportSnippet, its exceptions unwrapped.
    static string UpstreamSnippet(Stream stream, int offset, int size) {
        try {
            return (string)exportSnippet.Invoke(null, new object[] { stream, offset, size });
        } catch (TargetInvocationException e) {
            ExceptionDispatchInfo.Capture(e.InnerException).Throw();
            throw;
        }
    }

    // ExportSnippet with the hybrid's words for a stage of encoding version 1 or later.
    static string HybridSnippet(MemoryStream stream, byte[] code, int offset, int size, string stagesDir) {
        stream.Position = offset;
        int decodedSize = SmolvDecoder.GetDecodedBufferSize(stream);
        if (decodedSize == 0 || code[offset + 7] == 0) return UpstreamSnippet(stream, offset, size);
        if (decodedSize < 0) throw new OverflowException();
        var path = Path.Combine(stagesDir, StageName(code, offset, size) + ".spv");
        if (File.Exists(path + ".fail")) throw new Exception("Unable to decode SMOL-V shader");
        var module = SpirV.Module.ReadFrom(new MemoryStream(File.ReadAllBytes(path)));
        return new SpirV.Disassembler().Disassemble(module, SpirV.DisassemblyOptions.Default).Replace("\r\n", "\n");
    }

    // SpirVShaderConverter.Convert with HybridSnippet for each stage.
    static string HybridConvert(byte[] code, string stagesDir) {
        var sb = new StringBuilder();
        using var stream = new MemoryStream(code);
        using var reader = new BinaryReader(stream);
        reader.ReadInt32(); // requirements
        int minOffset = code.Length;
        for (int i = 0; i < 5; i++) {
            if (reader.BaseStream.Position >= minOffset) break;
            int offset = reader.ReadInt32();
            int size = reader.ReadInt32();
            if (size > 0) {
                if (offset < minOffset) minOffset = offset;
                var position = stream.Position;
                sb.Append(HybridSnippet(stream, code, offset, size, stagesDir));
                stream.Position = position;
            }
        }
        return sb.ToString();
    }

    // ShaderSubProgram.Export's SPIRV case, with the given converter.
    static string ProgramText(ShaderSubProgram program, Func<byte[], string> convert) {
        var sb = new StringBuilder();
        try {
            sb.Append($"// hash: {program.ComputeHash64(program.m_ProgramCode):x8}\n");
            sb.Append(convert(program.m_ProgramCode));
        } catch (Exception e) {
            sb.Append($"// disassembly error {e.Message}\n");
        }
        return sb.ToString();
    }

    // The dump run: each stage's SMOL-V bytes and, for encoding version 0, the
    // words AssetStudio's SmolvDecoder gives (ExportSnippet's decode).
    static List<Dictionary<string, object>> DumpStages(IEnumerable<ShaderSubProgram> programs, string stagesDir) {
        var stages = new List<Dictionary<string, object>>();
        foreach (var program in programs) {
            var code = program.m_ProgramCode;
            List<(int offset, int size)> table;
            try {
                table = Stages(code);
            } catch (EndOfStreamException) {
                // Convert fails on this program before any stage: no stages.
                continue;
            }
            foreach (var (offset, size) in table) {
                var stage = new Dictionary<string, object>();
                stages.Add(stage);
                try {
                    using var stream = new MemoryStream(code);
                    stream.Position = offset;
                    int decodedSize = SmolvDecoder.GetDecodedBufferSize(stream);
                    if (decodedSize == 0) throw new Exception("Invalid SMOL-V shader header");
                    var name = StageName(code, offset, size);
                    stage["sha256"] = name;
                    File.WriteAllBytes(Path.Combine(stagesDir, name + ".smolv"), code.AsSpan(offset, Math.Min(size, code.Length - offset)).ToArray());
                    stage["encoding"] = (int)code[offset + 7];
                    if (code[offset + 7] != 0) {
                        if (decodedSize < 0) throw new OverflowException();
                        continue;
                    }
                    using var decoded = new MemoryStream(new byte[decodedSize]);
                    if (!SmolvDecoder.Decode(stream, size, decoded)) throw new Exception("Unable to decode SMOL-V shader");
                    File.WriteAllBytes(Path.Combine(stagesDir, name + ".c37.spv"), decoded.ToArray());
                } catch (Exception e) {
                    stage["error"] = e.Message;
                }
            }
        }
        return stages;
    }

    // Texture2DExtensions.ConvertToImage decodes into a buffer rented from
    // ArrayPool<byte>.Shared, which may hold old bytes. Export twice, the buffer
    // first filled with 0x00, then 0xFF: pixels the decoder leaves unwritten show
    // up as a difference, and get no golden. width x height: the Texture2D decoded.
    static void ExportPngTwice(Dictionary<string, object> result, string method, int width, int height,
            string outDir, Func<string, bool> export) {
        var exports = new List<(byte[] png, byte[] rgba, int width, int height)>();
        foreach (var fill in new byte[] { 0x00, 0xFF }) {
            var buffer = ArrayPool<byte>.Shared.Rent(width * height * 4);
            Array.Fill(buffer, fill);
            ArrayPool<byte>.Shared.Return(buffer);
            var dir = Path.Combine(outDir, fill.ToString("X2"));
            if (!export(dir)) break;
            var png = File.ReadAllBytes(Single(dir));
            using var decoded = Image.Load<Rgba32>(png);
            var rgba = new byte[decoded.Width * decoded.Height * 4];
            decoded.CopyPixelDataTo(rgba);
            exports.Add((png, rgba, decoded.Width, decoded.Height));
        }
        if (exports.Count < 2) {
            result["exportError"] = method + " returned false";
            return;
        }
        if (!exports[0].rgba.AsSpan().SequenceEqual(exports[1].rgba)) {
            result["exportError"] = "undefined pixels: the decoder leaves pixels unwritten, so the PNG holds whatever the pooled buffer held";
            return;
        }
        var (pngBytes, pixels, w, h) = exports[0];
        result["png"] = new Dictionary<string, object> {
            ["width"] = w, ["height"] = h, ["rgbaSha256"] = Sha(pixels),
            ["pngSize"] = pngBytes.Length, ["pngSha256"] = Sha(pngBytes),
        };
    }

    // An exporter that writes one file as is: its size, hash and extension.
    static void ExportFile(Dictionary<string, object> result, string method, string output, string outDir,
            Func<bool> export) {
        if (!export()) {
            result["exportError"] = method + " returned false";
            return;
        }
        var path = Single(outDir);
        var bytes = File.ReadAllBytes(path);
        result[output] = new Dictionary<string, object> {
            ["size"] = bytes.Length, ["sha256"] = Sha(bytes), ["extension"] = Path.GetExtension(path),
        };
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
        var exportSprite = Method("ExportSprite");
        var exportFont = Method("ExportFont");
        var exportVideoClip = Method("ExportVideoClip");
        var game = GameManager.GetGame(GameType.Normal);
        // "dump": only the Vulkan stages of each Shader; "export": every export.
        var dump = args[2] == "dump";
        var stagesDir = args[3];
        // The composite's jobs (#259), by index: UnityPy 1.25.4's type trees.
        var composite = new Dictionary<int, JsonElement>();
        foreach (var c in JsonDocument.Parse(File.ReadAllText(args[4])).RootElement.EnumerateObject()) {
            composite[int.Parse(c.Name, CultureInfo.InvariantCulture)] = c.Value;
        }
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
                if (composite.TryGetValue(want.GetProperty("index").GetInt32(), out var player)) {
                    RunComposite(player, dump, stagesDir, result);
                    continue;
                }
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
                if (dump) {
                    if (obj is Shader dumped) {
                        try {
                            result["stages"] = DumpStages(SpirvPrograms(dumped), stagesDir);
                        } catch (Exception error) {
                            result["dumpError"] = error.GetType().Name + ": " + error.Message;
                        }
                    }
                    continue;
                }
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
                            ExportPngTwice(result, "ExportTexture2D", texture.m_Width, texture.m_Height, outDir,
                                dir => (bool)exportTexture2D.Invoke(null, new object[] { item, dir, ImageFormat.Png }));
                            break;
                        }
                        case Sprite sprite: {
                            input["name"] = sprite.m_Name;
                            // GetImage's lookup (SpriteHelper.cs): the atlas entry when the
                            // atlas loads, else m_RD. Its texture sizes the pooled buffer.
                            PPtr<Texture2D> texturePtr = null, alphaPtr = null;
                            if (sprite.m_SpriteAtlas != null && sprite.m_SpriteAtlas.TryGet(out var atlas)) {
                                if (atlas.m_RenderDataMap.TryGetValue(sprite.m_RenderDataKey, out var entry)) {
                                    texturePtr = entry.texture;
                                    alphaPtr = entry.alphaTexture;
                                }
                            } else {
                                texturePtr = sprite.m_RD.texture;
                                alphaPtr = sprite.m_RD.alphaTexture;
                            }
                            Texture2D source = null, alpha = null;
                            texturePtr?.TryGet(out source);
                            alphaPtr?.TryGet(out alpha);
                            if (alpha != null) result["alphaTexture"] = alpha.m_Name;
                            // AssetsManager has already moved a sprite whose atlas is a variant
                            // to its master atlas (AssetsManager.cs:1060-1085): read the
                            // sprite again for the atlas it names itself.
                            var own = new Sprite(sprite.reader).m_SpriteAtlas;
                            if (own != null && own.TryGet(out var ownAtlas) && ownAtlas.m_IsVariant)
                                result["variantAtlas"] = ownAtlas.m_Name;
                            ExportPngTwice(result, "ExportSprite", source?.m_Width ?? 0, source?.m_Height ?? 0, outDir,
                                dir => (bool)exportSprite.Invoke(null, new object[] { item, dir, ImageFormat.Png }));
                            break;
                        }
                        case Mesh mesh: {
                            input["name"] = mesh.m_Name;
                            // The skin the Mesh reader decoded (ProcessData: the vertex data's
                            // weight and index channels, or DecompressCompressedMesh), as float32
                            // bits: the executed cross-check of UnityPy's skin goldens (#285).
                            if (mesh.m_Skin != null && mesh.m_Skin.Count > 0) {
                                result["skin"] = new Dictionary<string, object> {
                                    ["boneWeights"] = mesh.m_Skin.Select(bw => bw.weight.Select(wt => "f32:" + ((uint)BitConverter.SingleToInt32Bits(wt)).ToString("x8")).ToList()).ToList(),
                                    ["boneIndices"] = mesh.m_Skin.Select(bw => bw.boneIndex.ToList()).ToList(),
                                };
                            }
                            if (!(bool)exportMesh.Invoke(null, new object[] { item, outDir })) {
                                result["exportError"] = "ExportMesh returned false";
                                break;
                            }
                            var text = File.ReadAllBytes(Single(outDir));
                            var objFile = new Dictionary<string, object> { ["size"] = text.Length, ["sha256"] = Sha(text) };
                            // ExportMesh writes the indices without their submesh's baseVertex,
                            // so its faces use the wrong vertices; unity-asset-reader adds it
                            // (#257). No golden; the OBJ is kept to check it differs by that alone.
                            var offset = mesh.m_SubMeshes.FirstOrDefault(sub => sub.baseVertex != 0);
                            if (offset != null) {
                                result["exportError"] = "not exported: ExportMesh leaves out the submesh's baseVertex " + offset.baseVertex + ", which unity-asset-reader adds to the indices (#257)";
                                result["objWithoutBaseVertex"] = objFile;
                                break;
                            }
                            result["obj"] = objFile;
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
                            // The hybrid oracle (#260): each SPIR-V program's text, as
                            // AssetStudio wrote it, replaced by the hybrid's where they differ.
                            var utf8 = new UTF8Encoding(false, true);
                            var written = utf8.GetString(text);
                            if (!utf8.GetBytes(written).AsSpan().SequenceEqual(text)) {
                                result["harnessError"] = "the .shader file does not round-trip through UTF-8";
                                break;
                            }
                            written = ReplaceSpirv(written, SpirvPrograms(shader), stagesDir, result);
                            if (written == null) break;
                            text = utf8.GetBytes(written);
                            result["shader"] = new Dictionary<string, object> { ["size"] = text.Length, ["sha256"] = Sha(text) };
                            break;
                        }
                        case Font font: {
                            input["name"] = font.m_Name;
                            // null when m_FontData is empty: ExportFont then returns false.
                            var data = font.m_FontData ?? new byte[0];
                            input["dataSize"] = data.Length;
                            input["dataSha256"] = Sha(data);
                            ExportFile(result, "ExportFont", "font", outDir,
                                () => (bool)exportFont.Invoke(null, new object[] { item, outDir }));
                            break;
                        }
                        case VideoClip video: {
                            input["name"] = video.m_Name;
                            // Inline, or from the m_ExternalResources source (a .resource node
                            // of the same bundle), as ExportVideoClip reads it.
                            var data = video.m_VideoData.GetData() ?? new byte[0];
                            input["dataSize"] = data.Length;
                            input["dataSha256"] = Sha(data);
                            ExportFile(result, "ExportVideoClip", "video", outDir,
                                () => (bool)exportVideoClip.Invoke(null, new object[] { item, outDir }));
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

# smol-v's decoder over files: built with smolv.cpp, outside the repository.
SMOLV_MAIN = r'''// Generated by scripts/make-export-goldens.py (unity-asset-reader #260).
// smolv-decode <0831|none> <in> <out> [<in> <out> ...]: decode each SMOL-V
// file with smolv::Decode, kDecodeFlagUse20160831AsZeroVersion or no flags;
// write the SPIR-V to <out>, or an empty <out>.fail when Decode returns false.
#include "smolv.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static bool readAll(const char* path, std::vector<unsigned char>& data) {
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    unsigned char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) data.insert(data.end(), buf, buf + n);
    std::fclose(f);
    return true;
}

static bool writeAll(const std::string& path, const std::vector<unsigned char>& data) {
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    bool ok = data.empty() || std::fwrite(data.data(), 1, data.size(), f) == data.size();
    return std::fclose(f) == 0 && ok;
}

int main(int argc, char** argv) {
    if (argc < 4 || argc % 2 != 0) return 2;
    uint32_t flags;
    if (std::strcmp(argv[1], "0831") == 0) flags = smolv::kDecodeFlagUse20160831AsZeroVersion;
    else if (std::strcmp(argv[1], "none") == 0) flags = smolv::kDecodeFlagNone;
    else return 2;
    for (int i = 2; i < argc; i += 2) {
        std::vector<unsigned char> in;
        if (!readAll(argv[i], in)) { std::fprintf(stderr, "cannot read %s\n", argv[i]); return 1; }
        size_t size = smolv::GetDecodedBufferSize(in.data(), in.size());
        std::vector<unsigned char> out(size);
        bool ok = size != 0 && smolv::Decode(in.data(), in.size(), out.data(), out.size(), flags);
        if (!writeAll(ok ? std::string(argv[i + 1]) : std::string(argv[i + 1]) + ".fail",
                      ok ? out : std::vector<unsigned char>())) {
            std::fprintf(stderr, "cannot write %s\n", argv[i + 1]);
            return 1;
        }
    }
    return 0;
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
                    if class_id in (AUDIOCLIP, FONT, VIDEOCLIP) and raw:
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


def build_smolv(source: pathlib.Path, project: pathlib.Path) -> pathlib.Path:
    """Build smol-v SMOLV_REVISION's decoder, from its tree as git stores it, with g++."""
    gxx = shutil.which("g++")
    if not gxx:
        raise SystemExit("g++ required to build smol-v's decoder")
    tree = subprocess.run(["git", "-C", str(source), "rev-parse", SMOLV_REVISION + "^{tree}"],
                          check=True, capture_output=True, text=True).stdout.strip()
    if tree != SMOLV_TREE:
        raise SystemExit(f"{source}: {SMOLV_REVISION} has tree {tree}, expected {SMOLV_TREE}")
    target = project / "smolv"
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for name in ["smolv.cpp", "smolv.h"]:
        data = subprocess.run(["git", "-C", str(source), "show", f"{SMOLV_REVISION}:source/{name}"],
                              check=True, capture_output=True).stdout
        (target / name).write_bytes(data)
    (target / "main.cpp").write_text(SMOLV_MAIN)
    exe = target / "smolv-decode"
    subprocess.run([gxx, "-O2", "-std=c++11", "-o", str(exe), str(target / "smolv.cpp"),
                    str(target / "main.cpp")], check=True)
    return exe


def decode_stages(exe: pathlib.Path, stages: pathlib.Path, dumped: dict[int, dict]) -> dict[str, dict]:
    """smol-v on every dumped stage: the check on version 0, the words of later versions.

    Returns each stage's golden by the sha256 of its SMOL-V bytes."""
    found: dict[str, dict] = {}
    for result in dumped.values():
        for stage in result.get("stages", []):
            if "sha256" in stage:
                found.setdefault(stage["sha256"], stage)
    v0 = [n for n, s in found.items() if s["encoding"] == 0]
    later = [n for n, s in found.items() if s["encoding"] != 0 and "error" not in s]
    for flags, names, suffix in [("0831", v0, ".0831.spv"), ("none", later, ".spv")]:
        # Batches keep the command line short.
        for i in range(0, len(names), 200):
            pairs = [str(stages / f"{n}{p}") for n in names[i:i + 200]
                     for p in (".smolv", suffix)]
            subprocess.run([str(exe), flags, *pairs], check=True)

    def read(path: pathlib.Path) -> bytes | None:
        return path.read_bytes() if path.exists() else None

    goldens: dict[str, dict] = {}
    for name, stage in found.items():
        golden = {"encoding": stage["encoding"]}
        if stage["encoding"] == 0:
            ours, theirs = read(stages / f"{name}.c37.spv"), read(stages / f"{name}.0831.spv")
            if ours != theirs:
                raise SystemExit(f"stage {name}: smol-v {SMOLV_REVISION[:7]} with "
                                 "kDecodeFlagUse20160831AsZeroVersion does not reproduce "
                                 f"AssetStudio's SmolvDecoder ({stage.get('error', 'words differ')})")
            words = ours
        elif "error" in stage:
            words = None
        else:
            words = read(stages / f"{name}.spv")
            if words is None:
                stage["error"] = "Unable to decode SMOL-V shader"
        if words is not None:
            golden["size"], golden["sha256"] = len(words), sha256(words)
        else:
            golden["error"] = stage["error"]
        goldens[name] = golden
    return goldens


def encode_tree(value):
    """A type tree value for the harness's Fill: floats by their float32 bits, bytes base64."""
    if isinstance(value, float):
        return "f:%d" % struct.unpack("<I", struct.pack("<f", value))[0]
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(value).decode()
    if isinstance(value, dict):
        return {k: encode_tree(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode_tree(v) for v in value]
    return value


def player_programs(requests_file: pathlib.Path, output: pathlib.Path) -> None:
    """--player-programs mode, under UnityPy 1.25.4: the composite's input (#259).

    For each requested Shader whose type tree lists variants in
    m_PlayerSubPrograms: its input metadata, its parsed form and its blob."""
    if UnityPy.__version__ != "1.25.4":
        raise SystemExit("--player-programs requires UnityPy==1.25.4, the modern-goldens.json oracle")
    requests = json.loads(requests_file.read_text())
    found = {}
    for key in sorted({r["fixture"] for r in requests}):
        config.FALLBACK_UNITY_VERSION = editor_of(key)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            env = UnityPy.load(str(FIXTURES / key))
        objects = {(obj.assets_file.name, str(obj.path_id)): obj for obj in env.objects}
        for request in (r for r in requests if r["fixture"] == key):
            obj = objects[(request["file"], request["pathId"])]
            tree = obj.read_typetree()
            stages = [pass_.get(field) or {} for sub in tree["m_ParsedForm"]["m_SubShaders"]
                      for pass_ in sub["m_Passes"]
                      for field in ("progVertex", "progFragment", "progGeometry", "progHull",
                                    "progDomain", "progRayTracing")]
            if not any(group for stage in stages for group in stage.get("m_PlayerSubPrograms", [])):
                continue
            found[str(request["index"])] = {
                "input": {"classId": SHADER, "byteSize": obj.byte_size, "name": tree["m_Name"],
                          "objectSha256": sha256(bytes(obj.get_raw_data()))},
                "version": [int(n) for n in re.findall(r"\d+", editor_of(key))[:4]],
                "form": encode_tree(tree["m_ParsedForm"]),
                "platforms": tree["platforms"],
                "offsets": tree["offsets"],
                "compressedLengths": tree["compressedLengths"],
                "decompressedLengths": tree["decompressedLengths"],
                "compressedBlob": base64.b64encode(bytes(tree["compressedBlob"])).decode(),
            }
    output.write_text(json.dumps(found))


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
    if sys.argv[1:2] == ["--player-programs"]:
        player_programs(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
        return
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, type=pathlib.Path,
                        help="a git clone of Razviar/assetstudio holding " + REVISION)
    parser.add_argument("--smolv", required=True, type=pathlib.Path,
                        help="a git clone of aras-p/smol-v holding " + SMOLV_REVISION)
    parser.add_argument("--modern-python", required=True, type=pathlib.Path,
                        help="a Python with UnityPy 1.25.4 (the modern-goldens.json oracle), "
                             "which reads the type trees of the composite's Shaders")
    parser.add_argument("--project", required=True, type=pathlib.Path,
                        help="an external directory for the build and the run")
    parser.add_argument("--dotnet", default=shutil.which("dotnet") or shutil.which("dotnet.exe"))
    args = parser.parse_args()
    if UnityPy.__version__ != "1.25.3":
        raise SystemExit("requires UnityPy==1.25.3, the goldens.json oracle")
    if not args.dotnet:
        raise SystemExit(".NET 8 SDK (Windows) required; supply --dotnet")
    source, project = external(args.source), external(args.project)
    smolv = external(args.smolv)
    host = Host(args.dotnet)

    jobs = expected_jobs()
    project.mkdir(parents=True, exist_ok=True)
    extract_source(source, project / "assetstudio")
    exe = build(host, project)
    smolv_exe = build_smolv(smolv, project)

    for name in ["inputs", "runs", "stages"]:
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

    stages = project / "stages"
    stages.mkdir()

    # The composite's input (#259): every Shader job, read by UnityPy 1.25.4.
    requests = [{"index": i, "fixture": job["fixture"], "file": job["file"],
                 "pathId": job["pathId"]} for i, job in enumerate(flat)
                if job["expected"]["classId"] == SHADER]
    (project / "runs").mkdir(parents=True, exist_ok=True)
    (project / "runs" / "player-requests.json").write_text(json.dumps(requests))
    composite = project / "runs" / "player-programs.json"
    subprocess.run([str(args.modern_python), "-I", str(pathlib.Path(__file__).resolve()),
                    "--player-programs", str(project / "runs" / "player-requests.json"),
                    str(composite)], check=True)

    def run(name: str, mode: str = "export") -> dict[int, dict]:
        """One harness process over every job, exporting into runs/<name>/<index>/."""
        manifest = [{"input": host.path(bundle), "editor": editor_of(key), "objects": [
            {"index": i, "file": flat[i]["file"], "pathId": flat[i]["pathId"],
             "output": host.path(project / "runs" / name / str(i))} for i in indices]}
            for key, bundle, indices in bundles]
        jobs_file = project / "runs" / f"{name}.json"
        results_file = project / "runs" / f"{name}-results.json"
        jobs_file.parent.mkdir(parents=True, exist_ok=True)
        jobs_file.write_text(json.dumps(manifest, indent=1))
        host.run(str(exe), host.path(jobs_file), host.path(results_file), mode,
                 host.path(stages), host.path(composite))
        return {r.pop("index"): r for r in json.loads(results_file.read_text())}

    # The Vulkan stages first: smol-v decodes them between the two harness runs.
    dumped = run("dump", "dump")
    stage_goldens = decode_stages(smolv_exe, stages, dumped)

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
        if "harnessError" in result:
            raise SystemExit(f"{where}: {result['harnessError']}")
        if "shader" in result:
            # AssetStudio cannot walk the blob of a 6000+ Shader either; one it
            # exports has to be walked here too.
            if "dumpError" in dumped[index]:
                raise SystemExit(f"{where}: the dump run failed: {dumped[index]['dumpError']}")
            spirv = {s["sha256"]: stage_goldens[s["sha256"]]
                     for s in dumped[index].get("stages", []) if "sha256" in s}
            if spirv:
                result["shader"]["spirv"] = spirv
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
        if result.get("oracle") == "composite":
            entry["oracle"] = COMPOSITE
        for output in [*OUTPUTS, "exportError", "objWithoutBaseVertex", "alphaTexture",
                       "variantAtlas", "skin"]:
            if output in result:
                entry[output] = result[output]
        verdicts = [text for field, text in [("alphaTexture", ALPHA_VERDICT),
                                             ("variantAtlas", VARIANT_VERDICT)] if field in entry]
        if verdicts and "png" in entry:
            entry["verdict"] = "; ".join(verdicts)
        if ("exportError" in entry) == any(k in entry for k in OUTPUTS):
            raise SystemExit(f"{where}: want an export or an exportError, got {sorted(result)}")
        fixtures.setdefault(key, {}).setdefault(job["file"], {})[job["pathId"]] = entry
        status = result.get("exportError") or next(k for k in OUTPUTS if k in result)
        print(f"  {where:<90} {entry['class']:<10} {status}")

    golden = {
        "_oracle": f"AssetStudio {REVISION[:7]} (Razviar/assetstudio), executed; Vulkan "
                   f"stages of SMOL-V encoding version 1: aras-p/smol-v {SMOLV_REVISION[:7]} "
                   "words, AssetStudio's disassembler for the text",
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
                     "Shaders with variants in m_PlayerSubPrograms: the composite instead "
                     "(their entries' \"oracle\"); "
                     "exporters called on the en-US culture of the GUI's export thread. PNG "
                     "decoded with the ImageSharp AssetStudio pins; rgbaSha256 is its RGBA8 "
                     "pixels in the PNG's row order, top row first.",
        "smolv": {"revision": SMOLV_REVISION, "tree": SMOLV_TREE,
                  "source": f"https://github.com/aras-p/smol-v/tree/{SMOLV_REVISION}",
                  "build": "g++ -O2 -std=c++11 source/smolv.cpp and the script's SMOLV_MAIN"},
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
