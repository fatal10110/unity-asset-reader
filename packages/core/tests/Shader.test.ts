// Shader (#237): the hardcoded reader against readTypeTree() on the shader
// fixtures (fixtures/BUILDING.md section 18: our own shaders, built by
// 2019.4.41f2, 2020.3.30f1, 6000.3.26f1 and 6000.6.4f1 for DX11, GLES3 and
// Vulkan, and by 2020.3 and 6000.3 for Metal too), and against UnityPy's
// reading of a synthetic object for every Shader layout of Unity's type trees
// from 2019.1, the oldest the reader supports (fixtures/shader-layouts.json,
// R12).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import { toShaderFields } from "../src/classes/fields.js";
import {
  readShader,
  type SerializedPass,
  type SerializedSubProgram,
  type Shader,
} from "../src/classes/Shader.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";

/** The fixture editors and their targets: Metal (`ios`) where the editor has the iOS module. */
const EDITORS: Record<string, string[]> = {
  "2019.4.41f2": ["windows", "android"],
  "2020.3.30f1": ["windows", "android", "ios"],
  "6000.3.26f1": ["windows", "android", "ios"],
  "6000.6.4f1": ["windows", "android"],
};
/** The shader bundles built with type trees. */
const TYPED = Object.entries(EDITORS).flatMap(([v, targets]) =>
  targets.map((t) => `editor/${v}/shader/lz4/${t}`),
);
const twin = (name: string): string => name.replace("/lz4/", "/lz4-notypetree/");

/** Upstream's `ShaderCompilerPlatform`. */
const D3D11 = 4;
const GLES3_PLUS = 9;
const VULKAN = 18;
const METAL = 14;
/** The platforms each target was built for. */
const PLATFORMS: Record<string, number[]> = {
  windows: [D3D11],
  android: [GLES3_PLUS, VULKAN],
  ios: [METAL],
};
/** Upstream's `ShaderGpuProgramType`. */
const GPU = { GLES31AEP: 2, GLES3: 4, DX11VertexSM50: 16, DX11GeometrySM50: 20, SPIRV: 25 };
const METAL_VS = 23;
const METAL_FS = 24;

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);
const shadersOf = (env: Env): ObjectReader[] =>
  env.objects.filter((o) => o.type === ClassID.Shader);

/**
 * The value as one JSON text, keys in their order: int64 as a decimal string,
 * bytes as `hex:<hex>`. The same form `scripts/make-shader-layouts.py` hashes.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return String(v);
    if (v instanceof Uint8Array) return `hex:${Buffer.from(v).toString("hex")}`;
    return v;
  });
}

/** Read with `readShader`, which must consume the object to its last byte. */
function readAll(reader: ObjectReader): Shader {
  const shader = readShader(reader);
  assert.equal(reader.position, reader.byteSize, `${reader.pathId}: byteSize not consumed`);
  return shader;
}

// --- the fixtures ----------------------------------------------------------------

for (const name of TYPED) {
  test(`${name}: readShader equals readTypeTree(), keys in order, and is read()`, () => {
    const shaders = shadersOf(loadName(name));
    assert.equal(shaders.length, 2);
    for (const reader of shaders) {
      const shader = readAll(reader);
      const tree = reader.readTypeTree();
      assert.deepStrictEqual(shader, tree);
      // deepStrictEqual ignores key order; the JSON text does not.
      assert.equal(canonical(shader), canonical(tree));
      // obj.read() goes through the registry to this reader.
      assert.deepStrictEqual(reader.read(), shader);
    }
  });

  test(`${twin(name)}: readShader without a type tree reads what the typed build holds`, () => {
    const typed = new Map(shadersOf(loadName(name)).map((r) => [r.pathId, r]));
    const bare = shadersOf(loadName(twin(name)));
    assert.equal(bare.length, typed.size);
    for (const reader of bare) {
      assert.equal(reader.serializedType?.nodes ?? null, null, "the file has a type tree");
      const other = typed.get(reader.pathId);
      assert.ok(other, `${reader.pathId} is not in the typed build`);
      assert.equal(canonical(readAll(reader)), canonical(other.readTypeTree()));
      assert.deepStrictEqual(reader.read(), readShader(other));
    }
  });
}

/** Every pass of a shader, and every variant of every stage of it. */
function passesOf(shader: Shader): SerializedPass[] {
  return shader.m_ParsedForm!.m_SubShaders.flatMap((sub) => sub.m_Passes);
}
function subProgramsOf(pass: SerializedPass): SerializedSubProgram[] {
  return [pass.progVertex, pass.progFragment, pass.progGeometry, pass.progHull, pass.progDomain]
    .flatMap((program) => program.m_SubPrograms);
}

test("the fixtures hold DX11, GLES3, Vulkan and Metal shaders with every kind of field filled", () => {
  const byEditor = new Map<string, Shader[]>();
  for (const name of TYPED) {
    const shaders = shadersOf(loadName(name)).map(readShader);
    const editor = name.split("/")[1]!;
    byEditor.set(editor, [...(byEditor.get(editor) ?? []), ...shaders]);
    const want = PLATFORMS[name.split("/").pop()!]!;
    for (const shader of shaders) assert.deepEqual(shader.platforms, want, name);
    const names = shaders.map((s) => s.m_ParsedForm!.m_Name).sort();
    assert.deepEqual(names, ["UAR/ShaderFixture", "UAR/ShaderFixtureSecond"]);
  }

  // 2019.4 lists every variant in m_SubPrograms, with its parameters.
  const old = byEditor.get("2019.4.41f2")!;
  const passes = old.flatMap(passesOf);
  const subs = passes.flatMap(subProgramsOf);
  const types = new Set(subs.map((s) => s.m_GpuProgramType));
  for (const type of Object.values(GPU)) assert.ok(types.has(type), `no program of type ${type}`);
  // A normal pass, a UsePass and a GrabPass.
  assert.deepEqual([...new Set(passes.map((p) => p.m_Type))].sort(), [0, 1, 2]);
  assert.ok(passes.some((p) => p.progGeometry.m_SubPrograms.length > 0), "no geometry stage");
  const buffers = subs.flatMap((s) => s.m_ConstantBuffers ?? []);
  assert.ok(buffers.some((b) => b.m_StructParams!.length > 0), "no struct parameter");
  for (const list of ["m_BufferParams", "m_UAVParams", "m_Samplers", "m_TextureParams"] as const) {
    assert.ok(subs.some((s) => s[list]!.length > 0), `no ${list}`);
  }
  assert.ok(old.some((s) => s.m_Dependencies!.length > 0), "no dependency");

  // 2020.3: the positive side of the #52 gate and the 2020.3.2 program
  // parameters, in a real format-22 file, and Metal programs.
  const mid = byEditor.get("2020.3.30f1")!;
  for (const pass of mid.flatMap(passesOf)) {
    // Every pass has the four fields; a GrabPass or UsePass has no hash in them.
    assert.ok(pass.m_EditorDataHash && pass.m_Platforms, "2020.3: no m_EditorDataHash");
    assert.equal(pass.m_EditorDataHash.length, pass.m_Platforms.length);
    if (pass.m_Type === 0) assert.ok(pass.m_EditorDataHash.length > 0, "2020.3: an empty hash list");
    assert.ok(pass.m_LocalKeywordMask && pass.m_GlobalKeywordMask, "2020.3: no keyword masks");
    assert.ok(pass.progVertex.m_CommonParameters, "2020.3: no m_CommonParameters");
  }
  const midSubs = mid.flatMap(passesOf).flatMap(subProgramsOf);
  assert.ok(midSubs.every((s) => s.m_Parameters), "2020.3: a sub-program without m_Parameters");
  const midTypes = new Set(midSubs.map((s) => s.m_GpuProgramType));
  for (const type of [METAL_VS, METAL_FS]) assert.ok(midTypes.has(type), `2020.3: no ${type}`);

  // 6000.3 and 6000.6 list a player's variants in m_PlayerSubPrograms, not
  // m_SubPrograms, and have none of the four pass fields of #52.
  for (const editor of ["6000.3.26f1", "6000.6.4f1"]) {
    const modern = byEditor.get(editor)!;
    const players = modern
      .flatMap(passesOf)
      .flatMap((p) => p.progVertex.m_PlayerSubPrograms!.flat());
    const modernTypes = new Set(players.map((p) => p.m_GpuProgramType));
    for (const type of [GPU.GLES3, GPU.SPIRV]) assert.ok(modernTypes.has(type), `${editor}: ${type}`);
    assert.ok([...modernTypes].some((t) => t >= 15 && t <= 22), `${editor}: no DX11 program`);
    if (editor === "6000.3.26f1") assert.ok(modernTypes.has(METAL_VS), `${editor}: no Metal`);
    for (const shader of modern) {
      assert.equal(passesOf(shader)[0]!.m_EditorDataHash, undefined);
      assert.ok(shader.m_ParsedForm!.m_KeywordNames!.length > 0);
      assert.equal(Object.keys(shader.m_AssetGUID!).length, 4);
      assert.equal(typeof shader.m_AssetLocalIdentifierInFile, "bigint");
    }
  }
});

test("asset.data of a Shader: parsedForm under the friendly names", () => {
  const env = loadName("editor/6000.6.4f1/shader/lz4/windows");
  const assets = [...env.assets("Shader")];
  assert.equal(assets.length, 2);
  for (const asset of assets) {
    const low = asset.reader.read() as Shader;
    assert.deepStrictEqual(asset.data, toShaderFields(low));
    const form = asset.data.parsedForm!;
    assert.equal(form.name, low.m_ParsedForm!.m_Name);
    const pass = form.subShaders[0]!.passes[0]!;
    const state = low.m_ParsedForm!.m_SubShaders[0]!.m_Passes[0]!.m_State;
    assert.equal(pass.state.name, state.m_Name);
    assert.equal(pass.state.lod, state.m_LOD);
    assert.deepStrictEqual(pass.state.zTest, state.zTest);
    assert.equal(asset.data.assetLocalIdentifierInFile, low.m_AssetLocalIdentifierInFile);
    assert.equal("m_ParsedForm" in asset.data, false);
  }
});

// --- every other layout: UnityPy's synthetic objects (make-shader-layouts.py) ---------

interface Layout {
  version: string;
  fields: string[];
  bytes: string;
  sha256: string;
}

const LAYOUTS = (
  JSON.parse(
    readFileSync(new URL("../../../fixtures/shader-layouts.json", import.meta.url), "utf8"),
  ) as { layouts: Layout[] }
).layouts;

/** The 2019.4 fixture's SerializedFile and its first Shader: a frame for synthetic objects. */
const frame = (() => {
  const env = loadName("editor/2019.4.41f2/shader/lz4/windows");
  const file = env.files.find((f) => !f.path.endsWith(".resS") && f.path.startsWith("CAB-"))!;
  const sf = readSerializedFile(file.data);
  const info = sf.objects.find((o) => o.classId === ClassID.Shader)!;
  return { sf, info, bytes: file.data.subarray(info.byteStart, info.byteStart + info.byteSize) };
})();
const frame6000 = (() => {
  const env = loadName("editor/6000.6.4f1/shader/lz4/windows");
  const reader = shadersOf(env).sort((a, b) => b.byteSize - a.byteSize)[0]!;
  const file = env.files.find((f) => f.path.startsWith("CAB-") && !f.path.endsWith(".resS"))!;
  const info = readSerializedFile(file.data).objects.find((o) => o.pathId === reader.pathId)!;
  return file.data.subarray(info.byteStart, info.byteStart + info.byteSize);
})();

/** `"2020.3.30f1"` as a {@link UnityVersion}. */
function parse(text: string): UnityVersion {
  const [, a, b, c, , d] = /^(\d+)\.(\d+)\.(\d+)([a-z])(\d+)$/.exec(text)!;
  return [Number(a), Number(b), Number(c), Number(d)];
}

/** A reader over `bytes` as a Shader of a file of that version, format and platform. */
function synthetic(
  bytes: Uint8Array,
  text: string,
  format: number,
  platform: BuildTarget = BuildTarget.StandaloneWindows64,
): ObjectReader {
  const version: UnityVersion = text === "0.0.0" ? [0, 0, 0, 0] : parse(text);
  const file: SerializedFile = {
    ...frame.sf,
    header: { ...frame.sf.header, version: format },
    unityVersion: text,
    version,
    targetPlatform: platform,
  };
  return new ObjectReader(bytes, file, { ...frame.info, byteStart: 0, byteSize: bytes.length });
}

for (const layout of LAYOUTS) {
  test(`${layout.version}: readShader equals UnityPy's read of its TPK layout`, () => {
    const bytes = new Uint8Array(Buffer.from(layout.bytes, "base64"));
    const shader = readAll(synthetic(bytes, layout.version, 22));
    assert.deepEqual(Object.keys(shader), layout.fields);
    const text = canonical(shader);
    assert.equal(createHash("sha256").update(text).digest("hex"), layout.sha256, text);
  });
}

test("the synthetic layouts cover every gate, the missing fixture editors among them", () => {
  const versions = LAYOUTS.map((l) => l.version);
  for (const want of ["2020.3.30f1", "6000.3.25f1", "2020.2.0f1", "2022.2.0f1", "2023.1.0f1"]) {
    assert.ok(versions.includes(want), want);
  }
  const at = (version: string) =>
    readShader(synthetic(
      new Uint8Array(Buffer.from(LAYOUTS.find((l) => l.version === version)!.bytes, "base64")),
      version,
      22,
    ));
  // The Unity 6000 fix (#52): 2020.2 to 2022.x have m_EditorDataHash and
  // m_Platforms in every pass, 2023.1 and 6000 do not.
  const hashes = (version: string) => passesOf(at(version))[0]!.m_EditorDataHash;
  assert.equal(hashes("2020.1.0f1"), undefined);
  assert.equal(hashes("2020.3.30f1")!.length, 1);
  assert.equal(hashes("2022.2.0f1")!.length, 1);
  assert.equal(hashes("2023.1.0f1"), undefined);
  assert.equal(hashes("6000.3.25f1"), undefined);
  assert.equal(passesOf(at("2020.3.30f1"))[0]!.m_LocalKeywordMask!.length, 2);
});

// --- refusals and corruption -------------------------------------------------------

const refused = (kind: string, found: string) => (err: unknown) =>
  err instanceof UnsupportedError && err.kind === kind && err.found === found;

test("Unity before 2019.1 is refused, whatever the bytes (plan revision 2026-10-16)", () => {
  for (const text of ["2018.4.36f1", "2017.4.40f1", "5.6.7f1", "5.4.6f3", "4.7.2f1", "3.4.0f1"]) {
    const format = text.startsWith("201") ? 17 : text.startsWith("5.") ? 15 : 9;
    assert.throws(() => readShader(synthetic(frame.bytes, text, format)),
      (err: unknown) => refused("Unity version", text)(err) &&
        (err as Error).message.includes("before Unity 2019.1"), text);
  }
  // 2019.1.0 itself is read (the oldest layout in shader-layouts.json).
  const oldest = LAYOUTS[0]!;
  assert.equal(oldest.version, "2019.1.0f1");
  readAll(synthetic(new Uint8Array(Buffer.from(oldest.bytes, "base64")), "2019.1.0f1", 19));
});

test("editor files are refused", () => {
  assert.throws(
    () => readShader(synthetic(frame.bytes, "2019.4.41f2", 21, BuildTarget.NoTarget)),
    refused("build target", "NoTarget"),
  );
});

test("a version past the newest gate is read with 6000.6's layout", () => {
  assert.deepStrictEqual(
    readAll(synthetic(frame6000, "6000.7.1f1", 23)),
    readShader(synthetic(frame6000, "6000.6.4f1", 23)),
  );
});

test("version-stripped: read as 2019.4 in format 21 only", () => {
  const known = readShader(synthetic(frame.bytes, "2019.4.41f2", 21));
  assert.deepStrictEqual(readAll(synthetic(frame.bytes, "0.0.0", 21)), known);
  // Format 22 is 2020.1 to 6000.5, whose layouts differ inside the object.
  assert.throws(() => readShader(synthetic(frame.bytes, "0.0.0", 22)),
    refused("Unity version", "0.0.0"));
  // Another layout's bytes in format 21: not 2019's layout, not "corrupt".
  assert.throws(() => readShader(synthetic(frame6000, "0.0.0", 21)), (err: unknown) =>
    refused("Unity version", "0.0.0")(err) &&
    (err as Error).message.includes("does not fit 2019's Shader layout"));
});

test("a cut or overlong object throws CorruptError with the version known", () => {
  // The last 3 bytes may be only padding; every shorter cut loses data.
  for (let cut = 0; cut <= frame.bytes.length - 4; cut += 7) {
    const reader = synthetic(frame.bytes.subarray(0, cut), "2019.4.41f2", 21);
    assert.throws(() => readShader(reader), CorruptError, `cut at ${cut}`);
  }
  const longer = Uint8Array.from([...frame.bytes, 0, 0, 0, 0]);
  assert.throws(() => readShader(synthetic(longer, "2019.4.41f2", 21)), (err: unknown) =>
    err instanceof CorruptError && /ends at \d+ of its \d+ bytes/.test(err.message));
  // The same object read with the wrong layout does not end where it should.
  assert.throws(() => readShader(synthetic(frame.bytes, "2020.3.30f1", 22)), CorruptError);
});
