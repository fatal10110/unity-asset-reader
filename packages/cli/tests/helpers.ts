import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

/** The built bin, as npm installs it. */
export const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

/** A committed fixture path (fixtures/bundles/...), absolute. */
export function fixture(path: string): string {
  return fileURLToPath(new URL(`../../../fixtures/bundles/${path}`, import.meta.url));
}

/** fixtures/BUILDING.md's 2020.3.30f1 builds. */
export const EDITOR = "editor/2020.3.30f1";

/** What a run of the bin gave. */
export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the built bin with `args`, in a process of its own. */
export function cli(...args: string[]): Run {
  // --no-warnings: Node's warning about the decoder's untyped package.json is not ours to test.
  const result = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A fresh temporary directory, removed after the test file. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uar-cli-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every file below `dir`, as `<class>/<file>` paths, to their bytes. */
export function written(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path.slice(dir.length + 1).split("\\").join("/"), new Uint8Array(readFileSync(path)));
  }
  return files;
}

/** An asset name as `extract` puts it in a file name. */
export function fileName(name: string): string {
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "");
}

// As in the texture package's tests: without the WASM (built with Docker) the image tests
// skip, and REQUIRE_WASM=1 (the CI job that builds it) turns a missing WASM into a failure.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
export const noWasm = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (noWasm && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${noWasm}; the image tests must not skip here`);
}
