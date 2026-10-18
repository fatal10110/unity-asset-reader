import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkPackage, importSpecifiers, PACKAGES } from "../check-browser.mjs";

const tmp = mkdtempSync(join(tmpdir(), "check-browser-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway package whose src/index.ts is `source`. */
function pkg(name, source) {
  const root = join(tmp, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), source);
  return root;
}

const rules = { browser: true, noReader: true };

test("clean package passes", async () => {
  assert.deepEqual(await checkPackage(pkg("clean", "export const a = 1;\n"), rules), []);
});

for (const spec of ["fs", "node:fs", "path", "crypto"]) {
  test(`import of "${spec}" fails`, async () => {
    const problems = await checkPackage(pkg(`b-${spec.replace(":", "-")}`, `import "${spec}";\nexport {};\n`), rules);
    assert.match(problems.join("\n"), new RegExp(`resolve "${spec}"`));
  });
}

for (const [name, code] of [
  ["Buffer", "export const a = Buffer.from([1]);"],
  ["process.", "export const a = process.env.X;"],
  ["__dirname", "export const a = __dirname;"],
]) {
  test(`reference to ${name} fails`, async () => {
    const problems = await checkPackage(pkg(`g-${name.replace(".", "")}`, `${code}\n`), rules);
    assert.match(problems.join("\n"), /node-only global/);
  });
}

const DIM = '[["Rect", 4], ["Buffer", 5], ["SubpassData", 6]]';

test("the SPIR-V Dim enum's [\"Buffer\", 5] entry passes in the shader package only (#242)", async () => {
  const src = `export const dim = ${DIM};\n`;
  assert.deepEqual(await checkPackage(pkg("buffer-enum", src), PACKAGES.shader), []);
  const elsewhere = await checkPackage(pkg("buffer-enum-core", src), rules);
  assert.match(elsewhere.join("\n"), /node-only global/);
});

test("the shader package's Dim exemption must match exactly once", async () => {
  for (const [name, src] of [
    ["none", "export const dim = 1;\n"],
    ["twice", `export const a = ${DIM};\nexport const b = ${DIM};\n`],
  ]) {
    const problems = await checkPackage(pkg(`buffer-enum-${name}`, src), PACKAGES.shader);
    assert.match(problems.join("\n"), /times, expected exactly 1/, name);
  }
});

for (const [i, code] of [
  'globalThis[["Buffer", 5][0]]',
  "Reflect.get(globalThis, ['Buffer', 0][0])",
  '(() => { const [n] = ["Buffer", 0]; return globalThis[n]; })()',
].entries()) {
  test(`a "Buffer" tuple used as a name fails, in the shader package too: ${code}`, async () => {
    const src = `export const dim = ${DIM};\nexport const b = ${code};\n`;
    for (const [where, r] of [["core", rules], ["shader", PACKAGES.shader]]) {
      const problems = await checkPackage(pkg(`buffer-tuple-${i}-${where}`, src), r);
      assert.match(problems.join("\n"), /node-only global/, `${where}: ${code}`);
    }
  });
}

for (const [i, code] of [
  '"Buffer" in globalThis',
  'Reflect.get(globalThis, "Buffer")',
  'Object.getOwnPropertyDescriptor(globalThis, "Buffer")',
  '(() => { const n = "Buffer"; return (globalThis as Record<string, unknown>)[n]; })()',
  '(globalThis as Record<string, unknown>)["Buffer"]',
  "(self as unknown as Record<string, unknown>)['Buffer']",
  "(globalThis as Record<string, unknown>)[`Buffer`]",
  '(globalThis as Record<string, unknown> | undefined)?.["Buffer"]',
].entries()) {
  test(`a "Buffer" string used as a name still fails: ${code}`, async () => {
    const problems = await checkPackage(pkg(`buffer-string-${i}`, `export const b = ${code};\n`), rules);
    assert.match(problems.join("\n"), /node-only global/, code);
  });
}

test("ArrayBuffer and property names are not node globals", async () => {
  const src = "export const a = new ArrayBuffer(1);\nexport const b = ({} as Record<string, number>).process;\n";
  assert.deepEqual(await checkPackage(pkg("false-pos", src), rules), []);
});

for (const spec of [
  "unity-asset-reader",
  "unity-asset-reader-texture",
  "texture2ddecoder-wasm",
  "unity-asset-reader/x",
]) {
  test(`core importing "${spec}" fails (R14)`, async () => {
    const problems = await checkPackage(pkg(`r-${spec.replace("/", "_")}`, `import "${spec}";\nexport {};\n`), rules);
    assert.match(problems.join("\n"), /R14/);
  });
}

test("texture may import the core, and it stays external", async () => {
  const root = pkg("texture-ok", 'import { x } from "unity-asset-reader";\nexport const y = x;\n');
  assert.deepEqual(await checkPackage(root, PACKAGES.texture), []);
});

test("decoder package is dependency-checked without a browser bundle", async () => {
  const root = pkg("decoder", 'import "fs";\nimport "unity-asset-reader";\nexport {};\n');
  const problems = await checkPackage(root, PACKAGES.decoder);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R14/);
});

test("unreachable source file importing fs fails (R4)", async () => {
  const root = pkg("orphan", "export const a = 1;\n");
  writeFileSync(join(root, "src/orphan.ts"), 'import "fs";\nexport {};\n');
  assert.match((await checkPackage(root, rules)).join("\n"), /resolve "fs"/);
});

test("typeof process, globalThis.process and process[] fail", async () => {
  for (const [i, code] of ["typeof process", "globalThis.process", 'process["env"]'].entries()) {
    const problems = await checkPackage(pkg(`p${i}`, `export const t = ${code};\n`), rules);
    assert.match(problems.join("\n"), /node-only global/, code);
  }
});

test("deep import of a reader package fails even where imports are allowed", async () => {
  const root = pkg("deep", 'import { x } from "unity-asset-reader/src/x";\nexport const y = x;\n');
  assert.match((await checkPackage(root, PACKAGES.texture)).join("\n"), /deep import/);
});

// #76: import-shaped text that is not an import must not trip R14 on clean core source.
for (const [name, source] of [
  [
    "a JSDoc @example",
    '/**\n * Load a bundle.\n *\n * @example\n * import { load } from "unity-asset-reader";\n' +
      ' * const env = load(bytes);\n * const m = await import("unity-asset-reader-texture");\n */\n' +
      "export const a = 1;\n",
  ],
  [
    "a commented-out import",
    '// import { load } from "unity-asset-reader";\n/* import "unity-asset-reader-texture"; */\n' +
      '// const t = require("unity-asset-reader");\nexport const a = 1;\n',
  ],
  [
    "a block comment without leading *",
    '/*\nimport { load } from "unity-asset-reader";\n*/\nexport const a = 1;\n',
  ],
  [
    "a string literal",
    'export const a = \'import { load } from "unity-asset-reader";\';\n' +
      "export function f(): never {\n" +
      '  throw new Error(\'expected a bundle from "unity-asset-reader"\');\n}\n',
  ],
]) {
  test(`import-shaped line inside ${name} passes (#76)`, async () => {
    assert.deepEqual(await checkPackage(pkg(`q-${name.replace(/\W/g, "")}`, source), rules), []);
  });
}

for (const [name, source] of [
  ["import ... from", 'import { load } from "unity-asset-reader";\nexport const a = load;\n'],
  ["export ... from", 'export { load } from "unity-asset-reader";\n'],
  ["export * from", 'export * from "unity-asset-reader-texture";\n'],
  ["multi-line import", 'import {\n  load,\n} from "unity-asset-reader";\nexport const a = load;\n'],
  ["side-effect import", 'import "unity-asset-reader";\nexport {};\n'],
  ["dynamic import()", 'export const m = () => import("unity-asset-reader");\n'],
  [
    "require()",
    'declare const require: (s: string) => unknown;\nexport const m = require("unity-asset-reader");\n',
  ],
]) {
  test(`real ${name} of a reader package still fails R14 (#76)`, async () => {
    const problems = await checkPackage(pkg(`i-${name.replace(/\W/g, "")}`, source), rules);
    assert.match(problems.join("\n"), /imports "unity-asset-reader(-texture)?" \(R14/);
  });
}

test("importSpecifiers reads statements and skips comments and strings (#76)", () => {
  const src = [
    'import a from "a";',
    'import "b";',
    "import {",
    "  c,",
    '} from "c";',
    'export * from "d";',
    'const e = await import("e"), f = require("f");',
    '// import g from "g";',
    ' * import h from "h";',
    "const i = 'import i from \"i\"';",
    'throw new Error(`bad input from "j"`);',
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["a", "b", "c", "d", "e", "f"]);
});

test("importSpecifiers skips a block comment whose body lines have no leading * (#76)", () => {
  const src = [
    "/*",
    'import { load } from "unity-asset-reader";',
    'const m = require("unity-asset-reader-texture");',
    "*/",
    'import a from "a";',
    '/** one-line */ ',
    'import b from "b";',
    "  /* opened",
    'export * from "x";',
    "     closed */",
    'export * from "c";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["a", "b", "c"]);
});
