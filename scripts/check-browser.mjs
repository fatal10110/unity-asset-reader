// Browser-safety and dependency-direction guard (R4, R14).
//
//   node scripts/check-browser.mjs [core|texture|audio|spine|shader|decoder ...]
//
// With no arguments every guarded package is checked. Exits 1 and prints every
// problem found, so a red run says what to fix.
import { build } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages of this repo (core, feature packages, and the decoder, which keeps its
 * own name `texture2ddecoder-wasm`), as import specifiers.
 */
const READER = /^(unity-asset-reader(-[\w-]+)?|texture2ddecoder-wasm)(\/|$)/;
/** A subpath of one of them: a deep import, never allowed (R14). */
const READER_DEEP = /^(unity-asset-reader(-[\w-]+)?|texture2ddecoder-wasm)\//;

/**
 * The one string the guard must not read as Node's global: the `["Buffer", 5]`
 * entry of the SPIR-V `Dim` enum in packages/shader/src/grammar.ts (#242), a
 * name and its value, matched with its neighbours so no other `"Buffer"`
 * tuple passes. It is exempt in the shader package only, and must occur there
 * exactly once: anything else that says "Buffer" (`"Buffer" in globalThis`,
 * `globalThis[["Buffer", 5][0]]`) is still a reference.
 */
const SPIRV_DIM = {
  pattern: /\["Rect", 4\],\s*\["Buffer", 5\],\s*\["SubpassData", 6\]/g,
  count: 1,
  replacement: '["Rect", 4], ["SubpassData", 6]',
};

/**
 * What each package is held to. `browser`: bundle for browsers. `noReader`: R14.
 * `allow`: text removed from the bundle before the node-global scan, which the
 * package's sources must hold exactly `count` times.
 */
export const PACKAGES = {
  core: { browser: true, noReader: true },
  texture: { browser: true, noReader: false },
  mesh: { browser: true, noReader: false },
  audio: { browser: true, noReader: false },
  spine: { browser: true, noReader: false },
  shader: { browser: true, noReader: false, allow: SPIRV_DIM },
  decoder: { browser: false, noReader: true },
};

// Preceded by `.` or a word char means a property or a longer name (`ArrayBuffer`).
const NODE_GLOBALS = [/(?<![.\w])Buffer\b/, /(?<![.\w])process\b/, /globalThis\.process\b/, /__dirname/];

// Anchored at the start of a line, so import-shaped text inside a comment, a JSDoc
// `@example` or a string literal is not mistaken for an import (core has several
// error messages ending in `from "corrupt"`). A `/* ... */` opened at the start of a
// line is skipped up to its `*/`, whatever its body lines start with. Known limits
// of a line scanner, none reachable in this project's style (#76): an import-shaped
// line inside a template literal, an `import("y")` quoted mid-line in a string, a
// trailing `//` comment on a code line (`x; // import a from "y"`) and a block
// comment opened mid-line are false positives; code after a closing `*/` on the
// same line, a multi-line `import(` and a `}` / `from` split across lines are false
// negatives. Trailing `//` is not stripped: it also occurs inside specifiers (URLs).
const STATEMENT = [
  /^\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"']+)["']/, // import x from "y", export * from "y"
  /^\s*\}\s*from\s*["']([^"']+)["']/, //                         closing line of a multi-line import
  /^\s*import\s*["']([^"']+)["']/, //                            side-effect import
];
/** Dynamic `import("y")` / `require("y")`, which can sit anywhere on a code line. */
const DYNAMIC = /(?<![.\w$])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
/** A line that is a comment: `//`, `/*`, or a JSDoc continuation `*`. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/** A line that opens a block comment and does not close it on the same line. */
const BLOCK_OPEN = /^\s*\/\*(?![^]*\*\/)/;

/**
 * Module specifiers a source file imports: static `import` / `export ... from`
 * statements, side-effect imports, and dynamic `import()` / `require()`.
 * Shared with `scripts/tests/rollup-reader.test.mjs`.
 *
 * @param {string} text source code
 * @returns {string[]} specifiers in order of appearance, duplicates kept
 */
export function importSpecifiers(text) {
  const specs = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (inBlock) {
      inBlock = !line.includes("*/");
      continue;
    }
    if (COMMENT_LINE.test(line)) {
      inBlock = BLOCK_OPEN.test(line);
      continue;
    }
    for (const re of STATEMENT) {
      const spec = line.match(re)?.[1];
      if (spec) specs.push(spec);
    }
    for (const [, spec] of line.matchAll(DYNAMIC)) specs.push(spec);
  }
  return specs;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mjs|js)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/**
 * Check one package directory.
 *
 * @param {string} root package directory (contains `src/`)
 * @param {{ browser: boolean, noReader: boolean,
 *   allow?: { pattern: RegExp, count: number, replacement: string } }} rules what to enforce
 * @returns {Promise<string[]>} one message per problem; empty when clean
 */
export async function checkPackage(root, { browser, noReader, allow }) {
  const problems = [];

  const files = sourceFiles(join(root, "src"));
  for (const file of files) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (READER_DEEP.test(spec)) problems.push(`${file}: deep import "${spec}" (R14: public entry points only)`);
      else if (noReader && READER.test(spec)) problems.push(`${file}: imports "${spec}" (R14: core/decoder import no workspace package)`);
    }
  }

  if (browser) {
    try {
      const { outputFiles } = await build({
        // Every source file, not just index.ts: files not yet wired to the entry count too (R4).
        entryPoints: files.filter((f) => !f.endsWith(".d.ts")),
        outdir: join(root, ".check-browser"),
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        logLevel: "silent",
        external: [
          "unity-asset-reader",
          "texture2ddecoder-wasm",
          "texture2ddecoder-wasm/*",
        ],
      });
      let texts = outputFiles.map((f) => f.text);
      if (allow) {
        // Counted in the sources: each source file is an entry point, so a
        // module shows up in the output of every file that imports it.
        const sources = files.map((f) => readFileSync(f, "utf8")).join("\n");
        const found = sources.match(allow.pattern)?.length ?? 0;
        if (found !== allow.count) {
          problems.push(
            `${root}: src has ${allow.pattern} ${found} times, expected exactly ${allow.count} ` +
              "(R4: the exemption covers that text only)",
          );
        }
        texts = texts.map((text) => text.replace(allow.pattern, allow.replacement));
      }
      const out = texts.join("\n");
      for (const re of NODE_GLOBALS) {
        const hit = out.match(re);
        if (hit) problems.push(`${root}: bundle references ${hit[0]} (R4: node-only global)`);
      }
    } catch (e) {
      // esbuild reports `Could not resolve "fs"` for node builtins on platform=browser.
      for (const err of e.errors ?? [e]) {
        const at = err.location ? `${err.location.file}:${err.location.line}: ` : "";
        problems.push(`${at}${err.text ?? err.message}`);
      }
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(PACKAGES);
  const repo = resolve(fileURLToPath(import.meta.url), "../..");
  let failed = false;
  for (const name of names) {
    const rules = PACKAGES[name];
    if (!rules) throw new Error(`unknown package "${name}", expected one of ${Object.keys(PACKAGES)}`);
    const problems = await checkPackage(join(repo, "packages", name), rules);
    for (const p of problems) console.error(`✗ ${name}: ${p}`);
    if (problems.length) failed = true;
    else console.log(`✓ ${name}`);
  }
  process.exit(failed ? 1 : 0);
}
