# Agent rules for unity-asset-reader

npm-workspaces monorepo (GitHub `fatal10110/unity-asset-reader`): a shared parser core, feature
packages on top, and the texture decoder as a standalone package. Every package has its own
version and is published when that version changes on `main` (plan D7/D8,
[RELEASING.md](RELEASING.md)).

Rules here are always in force. Scoped guides (bottom table) are loaded only when the task needs
them.

## 1. Packages

| Package | Path | State | What |
|---|---|---|---|
| `unity-asset-reader` | `packages/core/` | in development | **Shared core.** Browser-first Unity AssetBundle parser, isomorphic and sync. TS hand-ported from AssetStudio (MIT). No WASM, no workspace deps. |
| `unity-asset-reader-texture` | `packages/texture/` | in development | Texture2D / Sprite → RGBA. Depends on core (peer) and `texture2ddecoder-wasm`. |
| `unity-asset-reader-node` | `packages/node/` | in development | Node adapter: `loadPath()`, dir scan, sidecars. Depends on core (peer). |
| `unity-asset-reader-mesh` | `packages/mesh/` | in development | Mesh export: `meshToObj()` (Wavefront OBJ, as AssetStudio writes it), `meshToGltf()` (glTF 2.0 `.glb`). Depends on core (peer). |
| `unity-asset-reader-audio` | `packages/audio/` | in development | AudioClip (FSB5) → WAV, pure TS. Depends on core (peer). |
| `unity-asset-reader-spine` | `packages/spine/` | in development | Spine export: groups skeleton data, atlases and page textures. Isomorphic. Depends on core (peer). |
| `unity-asset-reader-shader` | `packages/shader/` | in development | Shader inspection text as AssetStudio writes it: GL/Metal source, SPIR-V disassembly. Pure TS. Depends on core (peer). |
| `texture2ddecoder-wasm` | `packages/decoder/` | published, stable | WASM bindings (emscripten, C++ submodule `texture2ddecoder/`) decoding BC/ETC/PVRTC/ASTC/ATC/Crunch textures to **BGRA**. Node + browser. |

Dependencies point one way: feature packages → core. Core and `texture2ddecoder-wasm` import
nothing from the repo. Do not change `packages/decoder/` unless the task says so; it must keep its
npm name, public API and tarball file set, and keep building and passing.

## 2. Precedence

1. User instructions.
2. [The plan](docs/unity-asset-reader-plan.md). It wins over the rules, issues and this file: if
   one contradicts it, stop and say so instead of picking a side.
3. Hard rules R1–R14 ([rules doc](docs/unity-asset-reader-rules.md)), then its design, style and
   test rules.
4. Upstream behavior: AssetStudio (`Razviar/assetstudio`, MIT) is the source of truth for what a
   reader does on the bytes; UnityPy is the parsing oracle, AssetStudio `c37af7d` the export
   oracle (plan §5).
5. Issue text, then existing code. Both are leads, not truth.

## 3. Non-negotiables

The full list with reasons is in the rules doc; these cannot be undone after the fact:

1. **Never copy, import, or test against `@arkntools/unity-js`.** It is AGPL-3.0 and would
   relicense this package and every app shipping it.
2. **No C# in the repo, no C# compiled to WASM.** AssetStudio C# is read-only reference, cloned
   *outside* the repo and hand-ported to TS. WASM is built from C/C++ only.
   `git ls-files '*.cs' '*.csproj' '*.sln'` must print nothing.
3. **Ported files keep attribution:** first line
   `// Ported from AssetStudio/<path>.cs (MIT, © Perfare / RazTools / Razviar)`.
4. **Reader core is isomorphic and sync:** no `node:*`/`fs`/`Buffer`/`process`/DOM in
   `packages/core` or `packages/texture`, input is `Uint8Array`, no `async` in the parse path.
   Node-only code goes in `packages/node`.
5. **No third-party game data committed.** Fixtures come from our own Unity projects; goldens
   come from the oracle scripts (UnityPy `scripts/make-goldens.py` / `make-modern-goldens.py` for
   parsing, AssetStudio `c37af7d` via `scripts/make-export-goldens.py`, run outside the repo, for
   export output), never from this library's own output.
6. **No new runtime dependency** beyond plan §1 without asking.
7. **Scope = the issue.** Smallest code that meets its Tasks and Acceptance. No speculative
   abstractions. Extra ideas become follow-up issues.
8. **Git:** never push to `main`, never force-push a branch under review, never merge a PR
   yourself. The one exception is a `waves` run: the user's invocation of that skill authorizes
   its merge agent to merge PRs that passed its review loop.

## 4. Commands

From the repo root: `npm ci && npm run verify` (build every package, test, `check:browser`,
no-C# guard; about a minute). One package: `npm run build -w unity-asset-reader`,
`npm test -w unity-asset-reader-texture`, one file: `npx tsx --test <file>`. Decoder WASM
(`build:wasm` needs Docker; only when C++ or bindings changed):
`npm run build:wasm -w texture2ddecoder-wasm && npm test -w texture2ddecoder-wasm`. Without a
built WASM the texture decode tests skip locally; CI's `decoder` job runs them.

Tests: `tsx --test`, no frameworks. Style: TS strict, 2 spaces, double quotes, semicolons, JSDoc
on exports.

## 5. Tools

| Question | Tool |
| --- | --- |
| filename or path pattern | `rg --files <dir> -g '<glob>'` |
| known exact text | `rg -n` in a constrained path |
| several lookups at once (ranges, TS declarations, one AssetStudio method, one UnityPy def) | `python3 scripts/agent-tools/look.py <spec>...` |
| one upstream fact (field order, version gate, constant) | `upstream-lookup` agent |
| one multi-file upstream investigation | `upstream-researcher` agent |
| golden JSON | `jq` on the keys you need, never the whole file |
| issues and PRs | `gh` (the only authority for issue state) |

Exact commands, output caps and the lane tools (`wave_mail.py`, `heavy`):
[tooling.md](docs/agents/tooling.md).

## 6. Workflows

Use the project skills in `.claude/skills/` rather than improvising:

- `implement-issue <N>`: issue → branch → code + tests → verified PR
- `review-implementation <PR>`: strict review against issue, rules and upstream; posts inline
  comments
- `fix-pr-comments <PR>`: triage and fix review comments, open follow-up issues
- `waves`: several issues at once, as waves of parallel PRs; each PR goes through
  implement → review → fix → re-review → merge

Every change that reaches `main` goes through a review before merge, including small ones and
merge-conflict resolutions.

## 7. Agents and models

- **Delegation ladder**, stop at the first rung that works: answer inline when `rg`, `look.py` or
  a targeted read settles it in a few calls; `upstream-lookup` for one exact upstream fact;
  `upstream-researcher` for one batched multi-file investigation (at most one per ordinary issue).
  Use these, not `Explore` or `general-purpose`, for questions about AssetStudio or UnityPy.
- Delegated reports are short (conclusions, evidence paths, failures). Verify a helper's evidence
  paths before relying on them.
- Model roles: [model-policy.md](docs/agents/model-policy.md).

## 8. Scoped guides

Load only the one the task needs.

| Guide | Load when |
| --- | --- |
| [Plan](docs/unity-asset-reader-plan.md) | architecture, locked decisions D1–D9, layout, milestones, test strategy and oracles (§5) |
| [Rules](docs/unity-asset-reader-rules.md) | before any implementation or review: hard rules R1–R14, design, style, tests, git/PR format |
| [CONTRIBUTING.md](CONTRIBUTING.md) | dev setup, branch and commit conventions, root package standards |
| [RELEASING.md](RELEASING.md) | anything that changes a `version` or a `CHANGELOG.md` heading |
| [fixtures/BUILDING.md](fixtures/BUILDING.md) | building a fixture bundle with Unity, regenerating goldens, the AssetStudio harness |
| [tooling.md](docs/agents/tooling.md) | exact `look.py`, `wave_mail.py`, `heavy` commands; upstream clones; oracle environment |
| [model-policy.md](docs/agents/model-policy.md) | choosing or changing agent models and effort |
| Decoder [README](packages/decoder/README.md), [QUICK_START](packages/decoder/QUICK_START.md), [BUNDLER_GUIDE](packages/decoder/BUNDLER_GUIDE.md) | the decoder package's API and usage |
| GitHub issues | what to build: `gh issue view <N>`. Epics: M0 #6 · M1 #10 · M2 #21 · M3 #28 · M4 #36 · M5 #42 · M6+ #46 |
