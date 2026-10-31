---
name: waves
description: >
  Plan and run a multi-PR wave of unity-asset-reader issues on the Workflow tool: group open
  issues into lanes (one PR each) and waves, then fan out. Each PR gets a Sonnet lane brief, an
  implementation side (implement-issue, then fix-pr-comments for every review round, CI failure
  and merge conflict, handing over to a fresh agent at context checkpoints), and one long-lived
  review agent (review-implementation in full on the first push, then delta re-reviews) that
  requests the merge. A merger workflow runs the cheap-model CI/merge agent; a helper workflow
  runs the cheap helper agents (upstream-lookup, upstream-researcher, ts-scout, runner) that
  workflow agents cannot spawn themselves. Use when the user says "run the waves", "fan out
  wave 1", "ship these issues in waves", "implement -> review -> merge loop", or asks to execute
  a grouping/waves plan. Merging is authorized by the user's invocation of this skill. Do not use
  for a single issue (use implement-issue) or for reviewing one PR (use review-implementation).
---

# waves

Runs a waves plan through `waves.js` (next to this file), launched as several Workflows over one
plan. Ported from the acis_golang `acis-waves` skill; the scheduling is the same, the prompts are
this repository's (TypeScript checks, oracles, the three project skills, `gh`).

- **track** (one Workflow per track): works the track's lanes wave by wave. Per lane (one PR):
  0. **Lane brief.** A Sonnet `wave-brief` agent gathers the issue, the plan and rule sections,
     the AssetStudio/UnityPy sources with their version gates, the TS anchors, the fixtures and
     goldens involved and the commands into `lanes/<slug>/brief.md`, which goes into the
     implementation agent's prompt, so the expensive agent starts coding instead of exploring
     (`brief: false` turns it off).
  1. **Implementation agent** (session model, or the lane's `implModel`). It follows
     `implement-issue` and opens the PR; the implementation side then follows `fix-pr-comments`
     for every review round, and fixes every CI failure and merge conflict. It hands over at
     checkpoints (right after the first push, and whenever its context has grown long): it
     returns `checkpoint` and a fresh agent continues from the worklog, because cost is turns ×
     context.
  2. **Review agent.** It starts at the first push and stays alive until the PR is merged or
     given up. Round 1 is a full `review-implementation`. Every later round is a delta
     re-review: it checks that its own earlier items are fixed and reviews the diff since the
     head it last reviewed. When the PR is clean, it asks the merger to merge and routes the
     result back.

  The two agents talk directly through the lane mailbox, so the script relays nothing between
  rounds. Before the first push, a Haiku watcher holds the second slot instead of an idle review
  agent. The script replaces either agent if it dies; a replacement rebuilds its context once,
  from the worklog or the review files. At the end of each wave, every track meets at a file
  barrier, then the next wave starts.
- **merger** (one Workflow): runs one Haiku CI/merge agent per merge request, one at a time
  across all tracks. The agent checks that the head is still the one the reviewer approved,
  updates the branch, waits for CI (`changes`, `reader`, `decoder`) and reruns known flakes, and
  squash-merges. It never edits code or runs tests. A real CI failure or a conflict goes back to
  the review agent, which sends it to the implementation agent.
- **helper** (one Workflow): serves helper requests from every lane. Workflow agents cannot spawn
  subagents, so an agent runs `wave_mail.py ask` and this broker starts the helper:
  `upstream-lookup` (Haiku), `upstream-researcher` (Sonnet; at most `researcherPerLane` per
  lane), `ts-scout` (`wave-scout`, Haiku) and `runner` (Haiku: runs verify, scoped tests or
  oracle scripts and returns a compressed result). The helper agent types are read-only, so a
  Haiku deliver agent writes each answer back.

Per PR that is one implementation agent and one review agent (session model), one Haiku merge
agent per merge attempt, Haiku watcher, barrier and deliver agents, and any helpers.

All coordination goes through `scripts/agent-tools/wave_mail.py` under
`<primary checkout>/.claude/worktrees/.waves/<run>/` (gitignored): the mailboxes (`box/impl`,
`box/review`), lane state, the helper and merge request queues and their answers, reviews, CI
notes and the barrier markers. It survives container restarts. Lane worktrees are
`.claude/worktrees/wf-<slug>` (branch) and `review-<slug>` (detached).

## Slim agent types

Every workflow agent runs as a role-specific type from `.claude/agents/wave-*.md`. Each type lists
only the tools its role uses (Bash, Read/Edit/Write), so no agent loads the session's MCP tools,
the skill listing or the deferred-tool list. GitHub goes through `gh`, which the skills already
use. Implementation and review agents read their skill files with Read instead of the Skill tool;
the prompt adds WAVE OVERRIDES where a skill would stop to ask the user. A role that needs a new
tool needs it added to its agent file. A session loads `.claude/agents` at start: types added
after it started fall back to the default subagent (the script logs it).

## Lane tools (token savers, built into every prompt)

A long-lived agent's every tool call re-sends its whole context, so cost tracks the number of
calls, not their size. The prompts point every agent at:

- `look.py <spec>...` — ranges, TypeScript declarations by name (`ts:`), one AssetStudio C#
  method (`cs:`), one UnityPy def (`py:`), bounded rg; many lookups in one call.
- `wave_mail.py worktree --lane S --branch B [--review] [--remove]` — creates, moves or removes
  lane worktrees with absolute paths, and copies the shared decoder WASM build into them.
- `wave_mail.py pr-state --pr N` and `ci-wait --head SHA` — compact PR state (with `behind_by`,
  so the branch is updated only when behind) and an in-process CI wait for the merge agent.
- `heavy [--lock cpu|oracle|unity] <cmd>` — one holder per lock on this machine: the full verify,
  oracle runs and Unity builds take turns across lanes.
- STOP reaches agents through commands they run anyway: every `wave_mail.py` output of a stopping
  run carries `"stop": true`, `look.py` prints `### STOP`, and `heavy` prints it and refuses to
  run from a lane or review worktree of a stopping run.

## Check policy (built into every prompt)

- The full `npm run verify` takes about a minute here, so unlike acis_golang every push runs it
  locally, through `heavy` (the skills' `npm ci && npm run verify`). Scoped `npm test -w <pkg>`
  while iterating. CI reruns it on Node 20/22 and the floors on every push.
- **The texture decode tests need the decoder WASM**, which needs Docker. With a shared build in
  `<ref>/decoder-wasm/` (preflight), every worktree gets a copy and the tests run locally; without
  it they skip and CI's `decoder` job is their only gate.
- **Every push is reviewed**, CI fixes and conflict resolutions included: a conflict the
  implementation agent marks not semantic still gets a resolution review
  (`git show --remerge-diff` of the merge), only a cheaper one.
- **CI cannot run the oracles or Unity.** A lane that changes fixtures, goldens or oracle scripts
  regenerates the goldens with the oracle commands of `fixtures/BUILDING.md` (R12) and names them
  on an "Oracle runs (local only; CI cannot run them)" line of the PR body. The reviewer reruns
  them in the review worktree; a golden that does not reproduce is a blocker.
- The merge agent never runs tests.

## Concurrency budget (read before choosing tracks)

The Workflow tool caps concurrent agents per workflow at `min(16, CPUs - 2)`. This machine has 4
CPUs, so the cap is **2**. A lane needs 2 slots: the implementation agent plus the review agent,
or plus the watcher before the first push. Merges and helpers run in their own Workflows with
their own caps, so they never take a lane's slot. So:

- One track workflow runs `lanesPerTrack = floor(slots / 2)` lanes at a time: **1 here**.
- Parallel PRs come from **several track workflows** launched at once.
- On 4 CPU / 7 GB: **2 tracks + merger + helper** (4 Workflows). Verify runs, oracle runs and
  Unity builds are serialized by `heavy` anyway. On a bigger box, pass `slots` (the cap) and more
  tracks.

## Step 1: build the plan

Start from a grouping analysis of the live open issues (`gh issue list --state open`, then the
bodies). Load only the issues the user put in scope. Rules:

- **Lane** = one PR = normally one issue (rules doc: one issue per PR). Put two issues in one
  lane only when they would otherwise conflict or redo the same work (the same fixture build, the
  same golden regeneration), and only with the user's approval of the plan; the lane's note says
  why, and the PR states it under Deviations.
- **Wave** = lanes that can start together. A dependency on another lane goes to an earlier wave,
  or to the same wave on the **same track** (it then waits for that lane to merge).
- **Track**: lanes that share a hot file (`hot` group, e.g. `core-exports` for
  `packages/core/src/index.ts`) in the same wave go on one track. The plan validator refuses a hot
  group split across tracks. Golden JSON conflicts are not a hot group: they are resolved by
  rerunning the oracle on the merged branch. Balance the tracks by expected size; Unity-fixture
  lanes are the slow ones.
- Leave out issues that need an owner or oracle decision, are trigger-gated backlog, already have
  an open PR, belong to another session's work, or are epics. Put them in `exclusions` where
  agents must not touch them, and list them for the user.
- Machine-specific paths (the Unity editors, the Windows `dotnet.exe`, the harness directory) go
  in `env`; every agent's prompt carries them. `fixtures/BUILDING.md` and the
  `unity-editors-on-this-machine` memory have them.
- A lane may be audit-only (close done issues, file follow-ups): say so in `note`; the
  implementation agent returns `no_change` with no PR.

Plan file (`.claude/worktrees/.waves/<run>/plan.json`). Shape, also in `plan.example.json`:

```json
{
  "tracks": ["A", "B"],
  "exclusions": "docs PR #181; oracle decisions #259, #260",
  "env": "- Machine: Unity 2019.4.41f2 at /mnt/c/...",
  "waves": [
    {"name": "1", "lanes": [
      {"slug": "261-float-core", "track": "A", "issues": [261],
       "note": "one PR: move formatSingle into core", "hot": ["core-exports"], "deps": []}
    ]}
  ]
}
```

`slug` names the worktrees `wf-<slug>` and `review-<slug>` and must be unique across the run;
start it with the issue number. The branch is `feature/<slug>`, or the lane's `branch`
(`<type>/<issue>-<slug>`, rules doc). Optional per lane: `implModel` / `reviewModel` (a model
alias such as `sonnet`) and `implEffort` / `reviewEffort` (low|medium|high|xhigh|max). Default:
every implementation and review agent on the session model.

Validate the plan:

```bash
python3 <tool> validate <plan.json>
```

Show the user the plan (waves, tracks, lanes, exclusions) before launching unless they already
approved a grouping in this conversation.

## Step 2: preflight

- `<tool>` is the absolute path of `scripts/agent-tools/wave_mail.py` in the checkout this skill
  was loaded from. Until this skill is on `main`, that checkout is the worktree that has it, not
  the primary checkout.
- Upstream references, shared by every lane, in `<ref>` = `<primary checkout>-ref` (a sibling
  directory, outside the repository: R2):
  ```bash
  REF=<primary checkout>-ref; mkdir -p "$REF"
  [ -d "$REF/assetstudio" ] || git clone -q https://github.com/Razviar/assetstudio "$REF/assetstudio"
  git -C "$REF/assetstudio" checkout -q --detach c37af7dfcdafee93e33b5da9f0285c97998d6ae3
  [ -d "$REF/UnityPy" ] || git clone -q --depth 1 https://github.com/K0lb3/UnityPy "$REF/UnityPy"
  [ -x "$REF/venv-oracle/bin/python" ] || { python3 -m venv "$REF/venv-oracle" && "$REF/venv-oracle/bin/pip" -q install UnityPy==1.25.3; }
  ```
- Decoder WASM (optional, lets the texture decode tests run locally): copy a build of the current
  decoder sources into `$REF/decoder-wasm/` (`texture2ddecoder.js`, `texture2ddecoder.wasm`), from
  a worktree that has one or with `npm run build:wasm -w texture2ddecoder-wasm` (Docker). Rebuild
  it whenever `packages/decoder` C++ or bindings change on `main`.
- The primary checkout has `node_modules` (`npm ci`): `look.py`'s `ts:` lookups use its
  `typescript`.
- No leftover `wf-<slug>` worktree or `feature/<slug>` branch from another run uses a planned slug.
  If one does, either rename the lane or keep it on purpose: a fresh lane reuses and inspects an
  existing worktree.
- No open PR already covers a lane (`gh pr list --state open --search '<issue> in:body'`).
- Pick `run`: a short id such as `w1101`. Reusing a run id resumes it (Step 4).
- Cost check: each PR uses one implementation agent and one review agent on the session model,
  plus Haiku merge, watcher and deliver agents. Say so if the user has not seen it.

## Step 3: launch

Launch one Workflow per track, one merger and one helper broker, all in the same turn, with the
same `run`, `root`, `plan` and `tool`. `root` is the absolute path of the primary checkout
(`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`). Pass `scriptPath` as the absolute path of `waves.js`. If the tool
refuses a path outside the session directory, Read the file once and pass its text as `script`;
then reuse the persisted path that result returns.

```text
Workflow({scriptPath: "<skill dir>/waves.js", args: {run, epoch, root, role: "merger", plan, tool}})
Workflow({scriptPath: "<skill dir>/waves.js", args: {run, epoch, root, role: "helper", plan, tool}})
Workflow({scriptPath: "<skill dir>/waves.js", args: {run, epoch, root, role: "track", track: "A", plan, tool}})
Workflow({scriptPath: "<skill dir>/waves.js", args: {run, epoch, root, role: "track", track: "B", plan, tool}})
```

`plan` is the parsed plan object (a JSON value, not a string). `epoch` names this launch: `"1"` for
the first, and a new value for every relaunch of the whole run. The wave-barrier and
track-finished markers are kept per epoch, so a relaunch never sees markers from an earlier launch.
Optional args:

| Arg | Default | Meaning |
| --- | --- | --- |
| `root` | required | the primary checkout; lane worktrees live under its `.claude/worktrees/` |
| `repo` | `fatal10110/unity-asset-reader` | the GitHub repository |
| `ref` | `<root>-ref` | the upstream clones, the oracle venv and the shared decoder WASM, outside the repository |
| `wavesRoot` | `<root>/.claude/worktrees/.waves` | where run state lives |
| `slots` | 2 | the per-workflow agent cap; sets `lanesPerTrack` = floor(slots/2) |
| `lanesPerTrack` | from `slots` | lanes running at once in one track |
| `maxRounds` | 8 | review rounds per PR before the lane ends `unresolved` |
| `waitCalls` | 6 | recv calls (~9.5 min each) per first-push watcher agent |
| `takeCalls` | 6 | take polls (~9.5 min each) per broker poller agent before it returns |
| `maxIdleMin` | 240 | minutes without a mailbox message before a lane ends `stalled` |
| `restarts` | 2 | replacements per lane for the review agent, and separately for the implementation side, when an agent dies or exits early (checkpoints do not count) |
| `researcherPerLane` | 1 | upstream-researcher requests per lane (impl and review combined) |
| `agentTypes` | `{coord: 'wave-coord', deliver: 'wave-deliver', merge: 'wave-merge', impl: 'wave-impl', review: 'wave-review', runner: 'wave-runner', scout: 'wave-scout', brief: 'wave-brief'}` | agent type per role; `null` for a role falls back to the default workflow subagent |
| `models` | `{merge, coord, deliver, scout, runner: "haiku", brief: "sonnet"}` | model overrides per role (`impl`, `review` included, for every lane; a lane's `implModel`/`reviewModel` wins); `lookup`/`researcher` override the agent types' own models |
| `retry` | [] | slugs to run again even though saved state says they finished; a retried lane gets a fresh `maxRounds` budget |
| `brief` | true | a `wave-brief` agent writes `lanes/<slug>/brief.md` before a fresh lane's implementation agent starts |
| `maxCheckpoints` | 6 | hand-overs per lane; once spent, the next agent's prompt says none are left |

Every role's workers inherit the session model unless listed in `models`.

## Step 4: monitor, intervene, resume

- Progress: `python3 <tool> status --run <run>` prints one line per lane:
  `slug|status|stage|pr|round`. Stages are `impl`, `review`, `fix`, `merge`, `ci-fix` and
  `conflict`. Each workflow's result lists every lane's status, PR, rounds, history and follow-ups.
- Each lane directory has the implementation agent's `worklog.md`, `brief.md`,
  `reviews/r<N>.md`, `ci/c<N>.md` and its mailboxes `box/impl` and `box/review`.
- Terminal lane statuses:
  - `merged`, `no_change`, `blocked`
  - `unresolved`: still had findings after `maxRounds`; the PR stays open.
  - `stalled`: idle for `maxIdleMin`.
  - `merge_blocked`: the permission system denied the merge. Merge it by hand, then run
    `<tool> state --run R --lane S --set status=merged` so later deps pass.
  - `failed`, `skipped` (a dep did not merge), `stopped`.
- Drain (finish what is under way, start nothing new): `<tool> stop --run <run> --drain` writes
  `DRAIN`. Lanes that already have a worktree go on through review and merge; the first lane that
  would start gets `"stop": true` from `wave_mail.py worktree`, returns `stopped`, and its track
  then starts no further lane. Brokers end when the tracks finish.
- Stop everything: `<tool> stop --run <run>` writes `STOP`. Every waiting agent returns, the
  implementation and review agents update their worklog/notes and return `stopped`, the merger and
  helper end, and the tracks stop at their next wait. A merge agent already waiting on CI finishes
  its merge first.
- **Resume** (after a restart, a stop or a usage limit): delete `<run dir>/STOP` if present, then
  launch the same four Workflows again with the same args and a **new `epoch`**. Never use
  `resumeFromRunId`: the concurrent lanes break its cache. Each track reads the saved lane state,
  skips finished lanes, and starts replacement agents with a RESUME note for active ones (the
  implementation agent rebuilds from `worklog.md` and the PR; past stage `impl` a review agent
  rebuilds from `reviews/r*.md` and the PR threads). Put slugs in `retry` to run finished lanes
  again.
- A merger or helper workflow that died can be relaunched alone with the same `epoch`. Its first
  poll re-serves the requests the dead instance took but never answered. Requests older than 4 h,
  or from lanes that already ended, are answered "dropped" instead (a merge request gets `retry`).
  Relaunch a broker only after it has died: two live brokers of one kind would serve the same
  re-queued request twice.
- A track that crashed never reaches the barrier, so the other tracks wait. Relaunch only that
  track with the **same** `epoch` (it resumes and meets the waiting tracks), or stop the run.

## Step 5: wrap up

When all workflows have returned:

- Report per lane: status, PR, merge SHA, rounds, follow-ups filed. Report every lane that did not
  merge, with the reason and what is left (open PR, worktree kept).
- Check that each "Closes" issue is closed, and that no `wf-<slug>` worktree remains for a merged
  lane.
- Merged lanes add CHANGELOG entries under Unreleased; publishing them is a separate release PR
  (RELEASING.md). Say which packages now have unreleased changes.
- Update the `wave-orchestration-pattern` memory with the run id, the plan, the outcome and the
  next backlog.

## Editing waves.js

The script is plain JavaScript run by the Workflow tool. It has no filesystem access and no
`Date.now()`/`Math.random()`. After any change, run the offline simulation and the tool tests:

```bash
node .claude/skills/waves/waves_sim.mjs
python3 -m unittest discover -s scripts/agent-tools -p 'test_*.py'
```

The simulation runs the script with fake agents that talk through an in-memory mailbox, under
the 2-slot cap. It checks: one implementation and one review agent per PR across every review,
CI and conflict round; `maxRounds` ending a lane `unresolved` and skipping its dependents; resume
from saved state; replacements for dead agents; serial merges and an answer for a dead merge
agent; the per-lane researcher limit; the example plan on both tracks; the slim agent types and
their fallback; STOP and DRAIN; the brief, checkpoints, per-lane model and effort.
