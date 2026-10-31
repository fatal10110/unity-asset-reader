# Agent tooling

Use the smallest tool that answers the question and bound its output. Every tool call of an agent
re-sends its whole context, so cost tracks the number of calls more than their size: batch the
lookups a step needs into one call.

## Search and read

- Filenames: `rg --files <dir> -g '<glob>'`. Exact text: `rg -n -m 5 '<pattern>' <path> | head -60`.
  After one exact miss, change tools instead of retrying variants.
- Known range: the Read tool with offset and limit, at most about 80 lines at a time.
- Golden and fixture JSON: `jq` on the keys you need (`jq 'keys' fixtures/goldens.json`,
  `jq '.["<bundle>"].objects | length' ...`), never the whole file.
- Upstream questions: the `upstream-lookup` agent for one fact, `upstream-researcher` for one
  batched investigation, instead of `Explore` or `general-purpose`.

## look.py: several lookups in one call

```bash
python3 scripts/agent-tools/look.py [--root <worktree>] <spec>...
```

| Spec | Prints |
| --- | --- |
| `FILE:A-B` | lines A..B, numbered |
| `ts:PATH:Name,Class.member` | TypeScript declarations by name in a file or directory, with their JSDoc (function, class, interface, type, enum, const; `Class.member` for a method, property, accessor or `constructor`). Skips tests, `dist`, `node_modules`. |
| `tstest:PATH:Name` | the same, including `*.test.ts` |
| `cs:FILE:Method` | one C# method or constructor by brace matching, with its `///` comments and attributes |
| `py:FILE:name` | one Python `def` or `class` by indentation, with its decorators |
| `rg:PATH:PATTERN` / `rgl:PATH:PATTERN` / `rgg:GLOB:PATH:PATTERN` | bounded `rg -n` / files with counts / `rg -n` limited to a glob |

Output is capped per spec (`--max`, default 150 lines; `--rg-max`, 40) and in total (`--total`,
600). `ts:` uses the repository's `typescript` dev dependency (`scripts/agent-tools/tsdecl.mjs`),
so the checkout that holds the script needs `npm ci`.

```bash
python3 scripts/agent-tools/look.py ts:packages/core/src:UnsupportedError.constructor \
  cs:$REF/assetstudio/AssetStudio/Classes/Mesh.cs:GetTriangles \
  py:$REF/UnityPy/UnityPy/helpers/MeshHelper.py:get_triangles packages/mesh/src/obj.ts:1-40
```

## Upstream references and the oracle environment

AssetStudio and UnityPy are cloned outside the repository and only read (R2: no C# in the repo,
never compiled to WASM). `implement-issue` clones them into `${TMPDIR:-/tmp}/uar-ref`; a `waves`
run shares one set under `<primary checkout>/.claude/worktrees/.ref/` (gitignored):

| Path | What |
| --- | --- |
| `.ref/assetstudio` | `Razviar/assetstudio` at the export-oracle revision `c37af7d` |
| `.ref/UnityPy` | `K0lb3/UnityPy` |
| `.ref/venv-oracle` | Python venv with `UnityPy==1.25.3` for `scripts/make-goldens.py` and friends |
| `.ref/decoder-wasm` | a decoder WASM build (`texture2ddecoder.js`, `.wasm`), copied into lane worktrees so the texture decode tests run locally |

Golden regeneration, the AssetStudio .NET harness and the Unity fixture builds are documented in
[fixtures/BUILDING.md](../../fixtures/BUILDING.md) (§2 build, §4 goldens, §17 the harness). CI
cannot run any of them: whoever changes a golden runs its oracle locally and names the command in
the PR.

## Lane tools (`scripts/agent-tools/`)

Built for the [`waves`](../../.claude/skills/waves/SKILL.md) skill; usable on their own.

- `wave_mail.py` — file mailbox, lane state, helper and merge queues, barrier and STOP/DRAIN for
  a waves run, plus:
  - `worktree --run R --lane S --branch B [--review] [--remove]`: creates or reuses
    `.claude/worktrees/wf-<slug>` on its branch from `origin/main` (or the detached
    `review-<slug>` at `origin/<branch>`), seeds the decoder WASM, and prints head, dirty files
    and how far it is behind `main`.
  - `pr-state --pr N`: `{state, merged, merge_sha, draft, head, mergeable_state, behind_by}`.
  - `ci-wait --run R --head SHA --wait 570`: waits until every check run on the head finished;
    success needs the `changes`, `reader` and `decoder` checks (a job its path filter skipped
    counts).
  - `status --run R`: one `slug|status|stage|pr|round` line per lane. `validate <plan.json>`
    checks a waves plan.
- `heavy [--lock cpu|oracle|unity] <command>` — one holder per lock on this machine, so parallel
  lanes take turns: `cpu` (default) for `npm run verify` and builds, `oracle` for the golden
  scripts and the AssetStudio harness, `unity` for editor batch builds. Refuses to run (exit 3,
  `### STOP`) inside a lane worktree of a stopping run.
- `look.py`, `tsdecl.mjs` — above.

After changing any of them:

```bash
python3 -m unittest discover -s scripts/agent-tools -p 'test_*.py'
node .claude/skills/waves/waves_sim.mjs
```
