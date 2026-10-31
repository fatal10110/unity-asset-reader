export const meta = {
  name: 'waves',
  description: 'unity-asset-reader wave runner: per PR one long-lived implementation agent and one long-lived review agent that loop through the mailbox until the PR is clean and merged; merger and helper roles run the cheap-model merge and helper agents',
  whenToUse: 'Run by the waves skill: one Workflow per track (role track), one merger and one helper broker over the same plan',
  phases: [
    { title: 'Implement', detail: 'long-lived implementation agent per PR; fixes every review, CI and conflict round' },
    { title: 'Review', detail: 'long-lived review agent per PR; delta re-reviews; requests the merge' },
    { title: 'Merge', detail: 'merger: CI watch, branch update, squash merge', model: 'haiku' },
    { title: 'Coordinate', detail: 'first-push watch, final delivery, wave barrier, status', model: 'haiku' },
    { title: 'Helpers', detail: 'helper broker: upstream-lookup, upstream-researcher, ts-scout, runner' },
  ],
}

// ---------------------------------------------------------------------------
// Arguments (see SKILL.md): {run, role: 'track'|'merger'|'helper', track, plan, tool, ...}
// ---------------------------------------------------------------------------
const A = args || {}
const ROOT = A.root || '/home/zorg/workspace/texture2ddecoder-wasm'
const GH_REPO = A.repo || 'fatal10110/unity-asset-reader'
const WT = ROOT + '/.claude/worktrees'
const REF = A.ref || WT + '/.ref'
const RUN = A.run
const ROLE = A.role === 'broker' ? 'helper' : (A.role || 'track')
const PLAN = A.plan || {}
const TRACKS = PLAN.tracks || []
const TRACK = A.track
const TOOL = A.tool || ROOT + '/scripts/agent-tools/wave_mail.py'
const RUNDIR = (A.wavesRoot || WT + '/.waves') + '/' + RUN
// impl/review: null = the session model; a lane's implModel/reviewModel overrides it for that lane.
const M = Object.assign({ merge: 'haiku', coord: 'haiku', deliver: 'haiku', scout: 'haiku', runner: 'haiku', brief: 'sonnet', impl: null, review: null, lookup: null, researcher: null }, A.models || {})
// Slim agent types (.claude/agents/wave-*.md): each role gets only the tools it uses, so no agent
// pays for the session's remote-control MCP tools, skill listing or deferred-tool list.
// agentTypes: {role: null} falls back to the default workflow subagent for that role.
const AT = Object.assign({ coord: 'wave-coord', deliver: 'wave-deliver', merge: 'wave-merge', impl: 'wave-impl', review: 'wave-review', runner: 'wave-runner', scout: 'wave-scout', brief: 'wave-brief' }, A.agentTypes || {})
// A session loads .claude/agents at start, so a type added later is missing until a restart:
// such a call reruns on the default subagent and the role stops asking for the type.
async function agentAs(role, prompt, opts) {
  if (AT[role]) {
    try {
      return await agent(prompt, Object.assign({}, opts, { agentType: AT[role] }))
    } catch (e) {
      if (!/agent type .* not found/i.test(String(e))) throw e
      log(`agent type ${AT[role]} is not in this session's registry; ${role} agents use the default subagent`)
      AT[role] = null
    }
  }
  return agent(prompt, opts)
}
const SKILLS = TOOL.replace(/\/scripts\/agent-tools\/wave_mail\.py$/, '') + '/.claude/skills'
const skillRef = name => `the project skill \`${name}\` (Read ${SKILLS}/${name}/SKILL.md with the Read tool and follow it, with the WAVE OVERRIDES below)`
const SLOTS = A.slots || 2
const LANES = A.lanesPerTrack || Math.max(1, Math.floor(SLOTS / 2))
const MAX_ROUNDS = A.maxRounds || 8
const REVIEW_CI_FIXES = A.reviewCiFixes !== false
const WAIT_CALLS = A.waitCalls || 6
const TAKE_CALLS = A.takeCalls || 6
const MAX_IDLE_MIN = A.maxIdleMin || 240
const RESTARTS = A.restarts === undefined ? 2 : A.restarts
// A lane brief (a cheap scout gathers the lane's issue, upstream sources, TS anchors and commands)
// before the implementation agent starts, so the expensive agent does not explore with dozens of lookups.
const BRIEF = A.brief !== false
// An implementation agent returns "checkpoint" to hand over to a fresh agent with an empty context;
// checkpoints are not failures and do not use the restart budget.
const MAX_CHECKPOINTS = A.maxCheckpoints === undefined ? 6 : A.maxCheckpoints
const EPOCH = String(A.epoch || '1')
const RESEARCHER_LIMIT = A.researcherPerLane === undefined ? 1 : A.researcherPerLane
const RETRY = A.retry || []
const SATISFIED = ['merged', 'no_change']
const DONE_BEFORE = ['merged', 'no_change', 'blocked', 'unresolved', 'stalled', 'merge_blocked', 'failed', 'skipped']
// Set once any lane of this track has seen STOP: lanes not started yet then return without starting.
let STOPPING = false
const FINAL = ['merged', 'unresolved', 'stalled', 'merge_blocked', 'failed', 'stopped', 'no_change', 'blocked']

if (!RUN) throw new Error('args.run is required')
if (!['track', 'merger', 'helper'].includes(ROLE)) throw new Error('args.role must be track, merger or helper')
if (ROLE === 'track' && !TRACKS.includes(TRACK)) throw new Error(`args.track ${TRACK} is not in plan.tracks ${TRACKS.join(',')}`)
for (const L of (PLAN.waves || []).flatMap(w => w.lanes || [])) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(L.slug || '')) throw new Error(`bad lane slug ${JSON.stringify(L.slug)}: run wave_mail.py validate on the plan`)
}
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(RUN) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(EPOCH)) throw new Error('args.run and args.epoch must be simple names')
if (LANES * 2 > SLOTS) log(`warning: ${LANES} lanes need ${LANES * 2} agent slots but slots=${SLOTS}; lanes will stall on the concurrency cap`)

const MB = `python3 ${TOOL}`
const AGENT_TOOLS = TOOL.replace(/\/wave_mail\.py$/, '')
const LOOK = `python3 ${AGENT_TOOLS}/look.py`
const HEAVY = `${AGENT_TOOLS}/heavy`
const LANE_DIR = slug => `${RUNDIR}/lanes/${slug}`
const ALL_LANES = (PLAN.waves || []).flatMap(w => w.lanes || [])
const LANE_BY = Object.fromEntries(ALL_LANES.map(l => [l.slug, l]))
// The repository's branch convention (docs/unity-asset-reader-rules.md, Git and PRs).
const BRANCH = L => L.branch || `feature/${L.slug}`
const LWT = L => `${WT}/wf-${L.slug}`
const sq = obj => JSON.stringify(obj).replace(/'/g, '\\u0027')

// ---------------------------------------------------------------------------
// Shared prompt blocks
// ---------------------------------------------------------------------------
const TESTRULE = `CHECKS (HIGHEST PRIORITY; where a skill says \`npm ci && npm run verify\`, run it this way):
- While iterating, run only what the change touches: \`cd <worktree> && npm test -w <package> 2>&1 | tail -40\`, or one file with \`npx tsx --test <file> 2>&1 | tail -40\`. No lock needed.
- Before every push, the full gate, through the cpu lock (about a minute; waiting for the lock is normal): \`cd <worktree> && npm ci --no-audit --no-fund >/dev/null && ${HEAVY} npm run verify 2>&1 | tail -40\`. A push with a failing verify is a mistake.
- The decoder WASM: \`${MB} worktree\` copies a shared build into packages/decoder/wasm/ when one exists ("decoder_wasm": true), so the texture decode tests run locally too; without it they skip, and CI's decoder job is the only gate for them. A lane that changes packages/decoder C++ or bindings rebuilds it itself: \`${HEAVY} npm run build:wasm -w texture2ddecoder-wasm\` (Docker), then \`npm test -w texture2ddecoder-wasm\`.
- LOCAL ONLY, CI CANNOT RUN THEM: the oracles and Unity. A lane whose diff adds or changes a fixture bundle, a golden or cross-check file under fixtures/ (goldens.json, modern-goldens.json, assetstudio-export-goldens.json, assetstudio-fixture-cross-checks.json, ...) or an oracle script (scripts/make-*.py, scripts/prepare-*.py, scripts/cross-check-*.py) regenerates every changed golden with the oracle command fixtures/BUILDING.md gives for it, never by hand and never from this library's output (R12). Oracle runs go through \`${HEAVY} --lock oracle\`, Unity editor builds through \`${HEAVY} --lock unity\`. Python for the oracle scripts: ${REF}/venv-oracle/bin/python (UnityPy 1.25.3; a script that needs another version names it). Bundles never rebuild byte-identically (BUILDING.md §4), so a new bundle is built once, committed, and documented in its BUILDING.md section.
- The PR body carries a line "Oracle runs (local only; CI cannot run them): <each command> -> <result, files it changed>", or "Oracle runs: none (no fixture, golden or oracle-script change)", and "Full CI: on push".
`
const HELPERS = (slug, role) => `
Cheap helper agents: you cannot spawn subagents, so a broker workflow runs them for you on cheaper models. One Bash call (timeout 600000):
  ${MB} ask --run ${RUN} --from ${slug}/${role} --type <type> --worktree <your worktree or ''> --question - <<'EOF_ASK'
  <self-contained question: what you need, the leads you already have (paths, symbols), the answer shape you want>
  EOF_ASK
Types:
- upstream-lookup: one exact fact from the upstream references (an AssetStudio C# or UnityPy symbol, constant, version gate, field order, caller list).
- upstream-researcher: one batched multi-file upstream behavior investigation (a reader's full field walk with every version gate, an exporter's output format, an oracle script's path). At most ${RESEARCHER_LIMIT} per lane: put the whole feature in one question.
- ts-scout: locate TypeScript code in a given worktree (read-only).
- runner: run the commands you list, in the given worktree, through heavy, and return a compressed result (pass/fail, failing tests, first error lines with file:line). Use it for long runs whose raw output you do not need.
The call prints {"answer": ...}, or {"pending": true, "id": ...} (keep waiting with \`${MB} answer-wait --run ${RUN} --id <id> --wait 570\`, or work on and check later with --wait 0), or {"error": ...} (broker down: do it inline), or {"stop": true} (the run is stopping: wrap up as your stop rule says). Add --nowait to fire a request and keep working. Answer inline when rg or a targeted read settles it in a few calls. Verify a helper's evidence paths before relying on them.
`
const ENV = `
Environment rules (all agents):
- Repository: ${ROOT} is the primary checkout of GitHub ${GH_REPO} (default branch main): an npm-workspaces monorepo, TypeScript, \`tsx --test\`. Never write in the primary checkout; edits happen only in lane worktrees under ${WT}/, based on origin/main. Your inherited cwd may be an unrelated worktree: ignore it and use absolute paths.
- Rules: ${ROOT}/CLAUDE.md (non-negotiables), docs/unity-asset-reader-rules.md (hard rules R1-R14 that reviews cite), docs/unity-asset-reader-plan.md (wins over everything; locked decisions D1-D9, §5 test strategy and oracles). Read the rules doc once per agent; read only the plan sections the lane touches.
- Working directory: start every shell call with \`cd <worktree> &&\` (the worktree ROOT, never a subdirectory) and write every path root-relative (packages/..., fixtures/..., scripts/...), or use \`git -C <worktree>\` / \`--root <worktree>\`. Agent tools are always called by the absolute paths in this prompt.
- Never guess a path. When you do not know a file's location, find it in the same call: \`rg --files <dir> -g '<Name>*'\` (or ${LOOK} rgl:...). "No such file" means look it up, not try a variant.
- Path map (relative to the worktree root): package sources packages/<core|texture|node|mesh|audio|spine|shader>/src/ (core's class readers in packages/core/src/classes/, its exports in packages/core/src/index.ts), tests packages/<pkg>/tests/*.test.ts, the decoder packages/decoder/ (do not touch unless the issue says so, R13), fixtures and goldens fixtures/ (how each bundle was built: fixtures/BUILDING.md, one section per fixture set), oracle and guard scripts scripts/ (their tests scripts/tests/), release notes CHANGELOG.md (one section per package), RELEASING.md.
- Upstream references (read only, cloned outside the repo; never copy C# into the repo or compile it, R2): AssetStudio at ${REF}/assetstudio (checked out at the pinned oracle revision c37af7d), UnityPy at ${REF}/UnityPy. Use them instead of cloning again. Never open or search for @arkntools/unity-js (R1).
- GitHub: the gh CLI, always with \`-R ${GH_REPO}\` (or repos/${GH_REPO}/... for gh api), Bash timeout 300000, up to two retries on HTTP 401 or a network error. Issues: \`gh issue view <n> -R ${GH_REPO} --json number,title,body,labels,state,comments\`. Read each issue once per agent and keep what you need in your notes or worklog.
- Cost model: every tool call re-sends your WHOLE context (often 100k+ tokens), so the number of calls matters far more than their size. Put every lookup you need right now into ONE call, and never spend a call on something another call can carry.
- Batched lookups: ${LOOK} <spec>... (run from the worktree, or pass --root <worktree>) does several in one call with capped output:
  FILE:A-B (a range) | ts:PATH:Name,Class.member (TypeScript declarations with JSDoc, PATH a file or directory) | tstest:PATH:Name (the same, test files included) | cs:FILE:Method (one AssetStudio C# method) | py:FILE:name (one UnityPy def or class) | rg:PATH:PATTERN | rgl:PATH:PATTERN (files + counts) | rgg:GLOB:PATH:PATTERN.
  Example: ${LOOK} ts:packages/core/src:Mesh,MeshData.indices cs:${REF}/assetstudio/AssetStudio/Classes/Mesh.cs:GetTriangles py:${REF}/UnityPy/UnityPy/helpers/MeshHelper.py:get_triangles packages/mesh/src/obj.ts:1-60
- Output caps (every output stays in your context and is re-read on every later turn): rg always bounded by path and glob, with \`-m 5\` and \`| head -60\`; git diff of named files or \`--stat\` first; test output through \`| tail -40\`; a known range with the Read tool (offset + limit) or ${LOOK}, at most 80 lines; never print a golden JSON, a fixture, a generated file or a whole test file (use \`jq\` to select the keys you need).
- Batching: before you look anything up, list every lookup the next step needs and fetch them all in ONE call. Two single-lookup calls in a row is a mistake; so is a lookup the lane brief already answers.
- Editing: the Edit tool needs a Read of that file first (a look/sed view does not count): Read the range, then Edit. For several mechanical edits at once a python heredoc in one call is fine.
- Waiting: never use sleep loops; wait only through the ${MB} commands named in your instructions, each in one Bash call with timeout 600000.
- CHANGELOG.md: add the lane's entry in the package's section under its "### <next version> - Unreleased" heading (open one if missing, RELEASING.md). Never change a package "version" field: only a release PR does (RELEASING.md). Another lane's CHANGELOG entry next to yours is a mechanical conflict: keep both.
- Follow-up issues: dedupe with \`gh issue list -R ${GH_REPO} --state all --search '<terms>'\` and amend a matching issue instead of duplicating; a new one follows the issue shape, labels and epic attachment in fix-pr-comments §4.
- Where an issue offers several options, choose the one the plan or AssetStudio settles, else the conservative one, and record it under the PR's "Deviations" (or a "Decisions" line).
- PRs: title "<issue title> (#<n>)", the body template of implement-issue §6, one "Closes #n" line per fully resolved issue, "Part of #n" for a partial one. The rules allow one issue per PR: a lane with several issues exists only because the user approved it in the plan; say so under Deviations ("one PR for #a and #b: approved wave plan, <reason>").
- Commit messages end with a blank line then: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- PR bodies end with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)
- Never put model names or IDs in commits, PR text or code.
- Put new tests in new or small test files to avoid conflicts between lanes.
${PLAN.exclusions ? '- Never touch (other sessions / owner decisions): ' + PLAN.exclusions + '\n' : ''}${PLAN.env ? PLAN.env + '\n' : ''}- Other lanes run concurrently or later; stay within your lane and do not implement what other lanes own: ${ALL_LANES.map(l => l.slug + '=' + l.issues.join('/')).join('; ')}.
`
const issuesText = L => L.issues.map(i => '#' + i).join(', ')

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['merged', 'no_change', 'blocked', 'unresolved', 'stalled', 'merge_blocked', 'failed', 'stopped', 'idle_exit', 'checkpoint'] },
    pr_number: { type: 'integer' },
    closes: { type: 'array', items: { type: 'integer' } },
    summary: { type: 'string' },
    followups_filed: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary'],
}
const REVIEWER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['merged', 'unresolved', 'stalled', 'merge_blocked', 'failed', 'stopped', 'idle_exit', 'no_change', 'blocked'] },
    pr_number: { type: 'integer' },
    rounds: { type: 'integer' },
    merge_sha: { type: 'string' },
    summary: { type: 'string', description: 'one line per round: verdict and item count; merge attempts and outcomes' },
  },
  required: ['status', 'summary'],
}
const WAIT_SCHEMA = {
  type: 'object',
  properties: {
    messages: { type: 'array', items: { type: 'object', properties: { seq: { type: 'integer' }, kind: { type: 'string' }, data: { type: 'string', description: 'the message data object, as a JSON string' } }, required: ['seq', 'kind', 'data'] } },
    timeout: { type: 'boolean' },
    stop: { type: 'boolean' },
  },
  required: ['messages', 'timeout'],
}
const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['merged', 'conflict', 'ci_failed', 'head_moved', 'merge_blocked', 'retry'] },
    answered: { type: 'boolean', description: 'true once the answer file was written' },
    merge_sha: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['status', 'answered', 'notes'],
}
const LINES_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'boolean' }, stop: { type: 'boolean' }, lines: { type: 'array', items: { type: 'string' } } },
  required: ['lines'],
}
const TAKE_SCHEMA = {
  type: 'object',
  properties: {
    events: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, from: { type: 'string' } }, required: ['id', 'type', 'from'] } },
    timeout: { type: 'boolean' },
    stop: { type: 'boolean' },
  },
  required: ['events', 'stop'],
}

// ---------------------------------------------------------------------------
// Prompts: the two long-lived agents of a lane
// ---------------------------------------------------------------------------
// The skills are written for a person at the terminal; in a wave run nobody answers questions.
const IMPL_OVERRIDES = `WAVE OVERRIDES for the skills (they win over the skill text):
- No user is watching: never stop to ask or to show something first. Where a skill says to ask, decide by the plan, the rules and AssetStudio, record the decision under Deviations, and go on; where the decision is genuinely the owner's (the issue says "decision needed", or the plan and the issue conflict), comment the question on the issue and return blocked as the MAILBOX section says.
- implement-issue §1: dependencies are settled by the wave plan; an open dependency the plan did not foresee is a blocker. §3: do not branch with git checkout; use the worktree command below. §5: verify as CHECKS says. A spike issue's decision comment is posted without showing it first.
- fix-pr-comments: no triage table for the user; reply on each thread directly. An "ask" item: reply on the thread with the question, leave it open, and name it in your ready message's data as "open":["<thread url>"]. Push without amending or force-pushing.`
const REVIEW_OVERRIDES = `WAVE OVERRIDES for review-implementation (they win over the skill text):
- Review in the review worktree below, not with gh pr checkout; verify as CHECKS says (full verify, plus the oracle reruns for a lane that changes goldens: rerun each "Oracle runs" command in the review worktree and \`git -C <review worktree> status --porcelain fixtures/\`; a golden that does not reproduce is a blocker, and so is a changed golden with no oracle command).
- Do not show the user anything first: post the review directly (event COMMENT, verdict on the first line of the body), then write the round file below.
- A lane with several issues was approved in the wave plan: one PR for them is not a finding; check every issue's Tasks and Acceptance.
- Action required = every blocker and major, and every minor you did not mark "(optional)". Mark a minor optional when the PR is fine without it.`

function implPrompt(L, resume, brief, canCheckpoint) {
  const D = LANE_DIR(L.slug)
  const checkpointRules = canCheckpoint
    ? `CHECKPOINTS (your cost is turns x context, so hand over instead of growing):
- Right after you send the first ready (reason initial): bring ${D}/worklog.md fully up to date (state, PR number, decisions and why, files changed, the exact test commands, open questions) and return status checkpoint. A fresh agent handles the review, CI and conflict rounds from the worklog.
- Any other time your conversation has grown long (about 60 tool calls since you started, or a context warning) and you are at a clean point (edits saved, worklog listing the exact remaining steps), or you are about to wait on recv after a long round: update the worklog and return status checkpoint. Never checkpoint in the middle of an edit, with uncommitted work the worklog does not describe, or with a message read but not handled.`
    : `CHECKPOINTS: none are left for this lane. Never return status checkpoint; keep working until the final message or another return the protocol names.`
  return `${TESTRULE}
You are the long-lived implementation agent for lane "${L.slug}" (wave ${L.wave}, track ${TRACK}) of ${GH_REPO}: issues ${issuesText(L)}.
${L.note || ''}
You own this PR's code: you implement it and fix every review round, CI failure and merge conflict, handing over to a fresh implementation agent at the CHECKPOINTS below so no agent carries a huge context. One long-lived review agent reviews every push and routes merge results back through the lane mailbox. You never merge.
${brief ? `\nLANE BRIEF (a scout prepared it from origin/main; it is also in ${D}/brief.md). Rely on it instead of repeating its searches; verify only what you change or what looks wrong:\n${brief}\n` : resume ? `\nThe lane brief is in ${D}/brief.md: Read it once if the lane is still at stage impl; review, CI and conflict rounds rarely need it.\n` : ''}

PHASE 1 — implement. Load and follow ${skillRef('implement-issue')}: ${brief
    ? 'the LANE BRIEF above already holds the issues, the upstream sources and the TS anchors, so start from it: read live only what it lacks or marks open (issue comments newer than the brief included), and research only the upstream code it does not cover'
    : 'read each issue live with its comments, verify each gap still exists on origin/main, and study the upstream reference as the skill prescribes'} (through the helpers below where they fit), implement the smallest complete change for this lane with a test per Acceptance bullet, run CHECKS, then open ONE PR, ready for review (not draft), with the skill's body template, "Closes #n" per fully resolved issue and the "Oracle runs" line.
- Worktree: ${MB} worktree --run ${RUN} --lane ${L.slug} --branch ${BRANCH(L)} (one call: creates or reuses ${LWT(L)} on branch ${BRANCH(L)} from origin/main, records it in the lane state, seeds the decoder WASM, and prints head, dirty files and how far it is behind main). Push with git -C ${LWT(L)} push -u origin ${BRANCH(L)}.
${(L.deps || []).length ? `- This lane builds on lane(s) ${L.deps.join(', ')}, already merged to origin/main: read their merged PRs and reuse what they added.` : ''}
- An issue already fixed on main or stale: no code for it; comment with evidence (main SHA, file:line, merging PR), close it, leave it out of "Closes".
- Keep ${D}/worklog.md current: decisions and why, upstream evidence paths, what each round changed, open questions. A replacement agent resumes from it if you stop.
- STOP: once the run is stopping, every ${MB} call prints "stop": true, ${LOOK} prints "### STOP", and heavy prints "### STOP" and refuses to run. When you see any of them: update the worklog (where you are, what is left), push nothing, and return status stopped. Never spend a call of its own checking for it.

MAILBOX (each command in its own Bash call, timeout 600000):
- To the review agent: ${MB} send --run ${RUN} --lane ${L.slug} --box review --kind <kind> --data '<json object>' [--set key=value ...]
  * ready {"reason":"initial|review-fix|ci-fix|conflict","pr":<n>,"head":"<pushed sha>","semantic":<bool>} after every push that should move on; add --set stage=review --set pr=<n> --set head=<sha>.
  * no_change {"summary":"..."} with --set status=no_change, or blocked {"reason":"..."} with --set status=blocked (after commenting the blocker on the issue): only before a PR exists; then return at once.
- Wait for the review agent: ${MB} recv --run ${RUN} --lane ${L.slug} --box impl --wait 570 ; run it again while it prints "timeout": true. Before working on a review, ci or conflict message, run git -C ${LWT(L)} pull --no-rebase origin ${BRANCH(L)} : the merge agent may have pushed a branch-update merge commit, and your push must stay a fast-forward (not for final: a merged branch is already deleted). Messages:
  * review {"round":N,"file":"..."}: read the file (and the PR's unresolved threads), then follow ${skillRef('fix-pr-comments')}: verify each item against the code, the rules and upstream, fix every confirmed in-scope finding with tests, reply on every thread with evidence (fixed-in SHA, or a rebuttal citing the rule, plan decision or upstream file:line), resolve fixed threads, file follow-ups for valid out-of-scope items, run CHECKS, push (never force-push), send ready reason review-fix. You already know the code: re-read only what the findings point at.
  * ci {"file":"...","head":"..."}: CI failed for a real reason; read the file, fix, run CHECKS, push, send ready reason ci-fix.
  * conflict {"notes":"..."}: the branch cannot be updated automatically. git fetch origin; merge origin/main into your branch (never rebase, never force-push); resolve; npm ci and the full verify; for a golden conflict regenerate the golden with its oracle command instead of hand-merging the JSON (R12); push; send ready reason conflict with "semantic": true when the resolution changed the PR's logic or a golden, else false (a CHANGELOG-only conflict is not semantic).
  * final {"reason":"merged|unresolved|stalled|merge_blocked|failed|stopped"}: if merged, run ${MB} worktree --run ${RUN} --lane ${L.slug} --remove (worktree and local branch); otherwise keep both. Update the worklog and return your result with status = the final reason.
  * A message identical to one you already handled (same kind and round/file): ignore it.
  * recv printing "stop": true: the run is stopping; update the worklog and return status stopped.
- If recv times out for ${MAX_IDLE_MIN} consecutive minutes (since the last message you received), update the worklog and return status idle_exit.
${checkpointRules}
- Skills: Read each SKILL.md once per agent and keep what you need in your notes; never re-read or \`cat\` it again.
${IMPL_OVERRIDES}
${HELPERS(L.slug, 'impl')}
${ENV}
${resume ? '\nRESUME: ' + resume : ''}
Return: status, pr_number, closes, summary (what changed, key files, decisions), followups_filed.`
}

function implResume(L, why) {
  const D = LANE_DIR(L.slug)
  return `${why} First run ${MB} state --run ${RUN} --lane ${L.slug} --set status=active ; the state it prints (stage, pr, round) is authoritative. Rebuild your context from ${D}/worklog.md, the PR if there is one (gh pr view <n> -R ${GH_REPO} --json number,headRefOid,state,body and its unresolved review threads; for the code, \`git -C ${LWT(L)} diff --stat origin/main...HEAD\`, then only the hunks a review item or the worklog points at; never the whole PR diff, which carries goldens), ${D}/reviews/ and ${D}/ci/. Reuse worktree ${LWT(L)} (recreate it from origin/${BRANCH(L)} with the worktree command if missing). Then by stage:
- impl: finish the implementation and continue with the protocol.
- review or merge: the review agent is working; go straight to recv.
- fix: the newest review in ${D}/reviews/ may be partly addressed; compare what is pushed with what was asked, finish it, push, send ready reason review-fix.
- ci-fix or conflict: the triggering message may already be consumed; read the newest file in ${D}/ci/ or merge origin/main as the protocol says, fix, push, send ready with the matching reason.`
}

function briefPrompt(L) {
  const D = LANE_DIR(L.slug)
  return `You prepare the LANE BRIEF for lane "${L.slug}" of ${GH_REPO} (issues ${issuesText(L)}). An expensive implementation agent starts right after you with your brief in its prompt; every fact you hand it saves it a lookup. Gather facts; do not design the change, do not write code, do not run tests.
Lane note: ${L.note || '(none)'}
Steps (batch: several lookups per Bash call):
1. ${MB} worktree --run ${RUN} --lane ${L.slug} --branch ${BRANCH(L)}   (creates ${LWT(L)} on origin/main; all repo paths below are relative to it).
2. Issues: gh issue view <n> -R ${GH_REPO} --json number,title,body,labels,state,comments for each lane issue; for every issue its body names under "Depends on" or as a blocker, gh issue view <b> -R ${GH_REPO} --json state,title. Note decisions made in comments.
3. Rules and plan: which hard rules (docs/unity-asset-reader-rules.md R1-R14) the lane is most at risk of breaking and why (R12 for any golden, R4/R5 for core or texture code, R13 for the decoder, R14 for a new import across packages); the plan sections it touches (\`rg -n '^#' docs/unity-asset-reader-plan.md\`, then the lines of those sections).
4. Upstream: for each file the issue's "## Port" section names, its path under ${REF}/assetstudio (rg --files -g '<Name>.cs'), line count, the methods that matter with line ranges and every version gate in them (\`rg -n 'version\\[|version >=|version <' <file>\`); the UnityPy counterpart under ${REF}/UnityPy and where it differs. For an oracle-script issue: the script, its arguments and the BUILDING.md section that documents it.
5. TS anchors (worktree-relative, with line numbers): the package and files to change, the closest existing sibling to copy (a reader class in packages/core/src/classes/, a writer in a feature package), the exports to add (packages/<pkg>/src/index.ts) and the README/API table that must name them (scripts/tests/docs.test.mjs checks it), the tests to extend or copy, the fixtures/BUILDING.md section and the golden keys involved (\`jq 'keys' fixtures/<file>.json | head\`), and the CHANGELOG.md section and its Unreleased heading.
6. Blockers: an open dependency issue, an oracle or owner decision the issue says is still needed, a fixture the lane needs that does not exist and cannot be built with the editors in the environment rules: list it first, under BLOCKER, with evidence.
7. Commands: the scoped test commands, the full verify (CHECKS), the oracle commands with their exact arguments from BUILDING.md, and the Unity build steps if the lane needs a new fixture.
Write the brief as markdown, at most 250 lines: sections BLOCKER (only if any), Issues (Tasks, Acceptance, decisions already made in comments), Rules and plan, Upstream, TS anchors, Fixtures and goldens, Tests and commands, Open questions. Paths with line numbers; short excerpts (at most 15 lines) only where the exact text matters. Save it with one Bash call: cat > ${D}/brief.md <<'EOF_BRIEF' ... EOF_BRIEF (mkdir -p ${D} first). Your final message is the brief itself, verbatim.
STOP: once the run is stopping (or draining), ${MB} calls print "stop": true and ${LOOK} prints "### STOP". When you see either, do nothing more and make your final message exactly STOP.
${ENV}`
}

function reviewerPrompt(L, resume, roundLimit) {
  const D = LANE_DIR(L.slug)
  const RW = `${WT}/review-${L.slug}`
  return `${TESTRULE}
You are the long-lived review agent for lane "${L.slug}" (issues ${issuesText(L)}) of ${GH_REPO}. You stay alive for the PR's whole life: you review the first push in full, then wait for the implementation agent's fixes and re-review ONLY what changed, request the merge when the PR is clean, and route CI failures and conflicts back to the implementation agent. You keep your context between rounds: never re-read a file, issue, thread or upstream source you already read unless the new delta touches it.
${L.note || ''}
Review worktree: ${RW}, detached. At the start of every round run ${MB} worktree --run ${RUN} --lane ${L.slug} --review in a Bash call of its own (creates it the first time, then moves it to the current origin/${BRANCH(L)}, and prints the head). Remove it when you return: the same command with --remove.
Cost rules: Read the review skill's SKILL.md ONCE (round 1) with the Read tool and keep its checklist in your notes; never re-read or \`cat\` it again, and never chain it to another command. Review from the diff: \`git -C ${RW} diff --stat <base>..<head>\`, then the hunks of the files you review (not the golden JSON: check goldens by rerunning their oracle), then surrounding code in ranges of at most 80 lines; upstream through ${LOOK} cs:FILE:Method / py:FILE:name. Do not print whole files.

MAILBOX (each command in its own Bash call, timeout 600000):
- Wait for the implementation agent: ${MB} recv --run ${RUN} --lane ${L.slug} --box review --wait 570 ; run it again while it prints "timeout": true. You get ready {"reason","pr","head","semantic"}, or rarely no_change/blocked (then return that status).
- To the implementation agent: ${MB} send --run ${RUN} --lane ${L.slug} --box impl --kind <review|ci|conflict|final> --data '<json object>' [--set key=value ...]
- Merge requests go to the merge agent (cheap model) through the merger broker:
  ${MB} ask --run ${RUN} --from ${L.slug}/review --type merge --question '{"pr":<n>,"head":"<sha>"}' --wait 570
  The merge takes a while (CI): while it prints "pending": true, run ${MB} answer-wait --run ${RUN} --id <id> --wait 570 again, always with the same id (a pending request is still being served; never ask again while one is pending). The answer is a JSON object {"status":"merged|conflict|ci_failed|head_moved|merge_blocked|retry","merge_sha","file","head","notes"}. "stop": true: return status stopped. An "error" (the merge broker is not running): ${MB} pause --secs 300, then ask again; after 6 such errors, send final {"reason":"failed"} --set status=failed and return status failed.

LOOP:
1. Round 1 (the first ready): load ${skillRef('review-implementation')} and follow it end to end: the acceptance table for every issue the PR closes or is part of, the full verify and the oracle reruns in the review worktree (CHECKS), the hard rules R1-R14 one by one, and the upstream comparison of every ported gate; post one GitHub review with inline comments; decide the verdict. Only the items the WAVE OVERRIDES call action required count.
2. Every round N: write ${D}/reviews/r<N>.md (verdict, the reviewed head, the numbered action list '[severity] path:line — what to do' or "none", and for N > 1 the status of each earlier item), then ${MB} state --run ${RUN} --lane ${L.slug} --set round=<N> .
   - Action required and N < ${roundLimit}: send review {"round":N,"file":"${D}/reviews/r<N>.md"} --set stage=fix, then wait.
   - Action required and N >= ${roundLimit}: send final {"reason":"unresolved"} --set status=unresolved and return status unresolved.
   - Clean: go to step 4.
3. On ready (round N+1), by reason:
   - review-fix${REVIEW_CI_FIXES ? ', ci-fix' : ''}, or conflict with "semantic": true: a DELTA re-review. Diff your last reviewed head to the new head in the review worktree; verify each earlier item is fixed; rerun the full verify (and the oracle reruns if the delta touches fixtures or oracle scripts); review the delta in full and other code only where the delta reaches. Read the author's thread replies; do not re-raise a finding rebutted with concrete rule, plan or upstream evidence unless you can show the rebuttal wrong with better evidence, and do not add nits you could have raised earlier unless they are real defects. Post the re-review on GitHub, then step 2.
   - ${REVIEW_CI_FIXES ? '' : 'ci-fix, or '}conflict with "semantic": false: no review; go to step 4.
4. Merge: ${MB} state --run ${RUN} --lane ${L.slug} --set stage=merge , then ask for the merge with head = the head of the latest ready you accepted (the head you reviewed, or for a ready you took to merge without review, the head it names), and act on the answer:
   - merged: send final {"reason":"merged","merge_sha":"<sha>"} --set status=merged; return status merged.
   - ci_failed: send ci {"file":"<file>","head":"<head>"} --set stage=ci-fix; wait (step 3).
   - conflict: send conflict {"notes":"<notes>"} --set stage=conflict; wait (step 3).
   - head_moved: the branch changed without a ready (an unexpected push). Fetch it and do a delta re-review of the new head as the next round (step 3 rules, then step 2).
   - merge_blocked: send final {"reason":"merge_blocked"} --set status=merge_blocked; return status merge_blocked.
   - retry: ask again; after 6 merge requests in total, send final {"reason":"failed"} --set status=failed and return status failed.
- If recv times out for ${MAX_IDLE_MIN} consecutive minutes (since the last message you received): send final {"reason":"stalled"} --set status=stalled; return status stalled.
- recv or answer-wait printing "stop": true: return status stopped (no final message).
${REVIEW_OVERRIDES}
${HELPERS(L.slug, 'review')}
${ENV}
${resume ? '\nRESUME: ' + resume : ''}
Return: status, pr_number, rounds, merge_sha, summary.`
}

function reviewerResume(L, why) {
  const D = LANE_DIR(L.slug)
  return `${why} You have no memory of earlier rounds: rebuild it once. First run ${MB} state --run ${RUN} --lane ${L.slug} ; the state it prints (stage, pr, round) is authoritative. Read every review in ${D}/reviews/ and the PR (gh pr view <n> -R ${GH_REPO} --json number,headRefOid,state,reviews,comments, and its review threads). Your next round number is the highest r<N>.md number + 1, and the last reviewed head is the one in the newest review file. Then by stage:
- review (or impl with a PR open): a ready message may already be consumed. If the PR head differs from your last reviewed head (or there is no review yet), review it now (round 1 in full if there is none, otherwise a delta re-review); else wait.
- fix, ci-fix or conflict: wait for the implementation agent's ready.
- merge: check the PR first. MERGED: send final {"reason":"merged","merge_sha":"<sha>"} --set status=merged and return status merged. Otherwise look for an earlier merge request of this lane still pending (ls ${RUNDIR}/requests/taken/ | rg '^${L.slug}-review-' , newest first, with no matching ${RUNDIR}/answers/<id>.md): if one exists, keep waiting on it with answer-wait; else ask for the merge again.`
}

// ---------------------------------------------------------------------------
// Prompts: small coordination agents
// ---------------------------------------------------------------------------
function watchPrompt(L, drain) {
  return `You are a mailbox watcher. Run only ${drain ? 'these commands, each' : 'this command'} in one Bash call with timeout 600000, copied exactly; do nothing else:
${drain ? `1. ${MB} drain --run ${RUN} --lane ${L.slug} --box review --kinds no_change,blocked   (discards answers left from an earlier run)
2. ` : ''}${MB} recv --run ${RUN} --lane ${L.slug} --box review --peek --wait 570
While its output has "timeout": true and no "stop", run it again: at most ${WAIT_CALLS} recv runs in total.
Return the last output: messages (seq, kind, and data re-encoded as a JSON string), timeout, stop.`
}

function deliverFinalPrompt(L, data) {
  return `Run only this command in one Bash call with timeout 600000, copied exactly, and do nothing else; then return messages [], timeout true:
${MB} send --run ${RUN} --lane ${L.slug} --box impl --kind final --data '${sq(data)}' --set status=${data.reason}`
}

function statusPrompt() {
  return `Run exactly this Bash command (timeout 600000) and return its "lines" array verbatim: ${MB} status --run ${RUN}`
}

function barrierPrompt(wi, finish) {
  return `You are a wave barrier. Run only these commands, each in its own Bash call with timeout 600000, copied exactly:
1. ${MB} barrier --run ${RUN} --epoch ${EPOCH} --wave ${wi} --track ${TRACK} --tracks ${TRACKS.join(',')} --wait 570
   While it prints "passed": false without "stop", run it again: at most 30 runs.
${finish ? `2. If it passed: ${MB} finish-track --run ${RUN} --epoch ${EPOCH} --track ${TRACK}\n` : ''}Return passed, stop and lines from the last barrier output (lines verbatim; empty if absent).`
}

// One take agent polls up to TAKE_CALLS times (~9.5 min each) before it returns, so an idle
// broker pays one agent's context per ~TAKE_CALLS × 9.5 min instead of one per poll.
function takePrompt(broker, first) {
  const cmd = `${MB} take --run ${RUN} --broker ${broker} --epoch ${EPOCH} --tracks ${TRACKS.join(',')} --wait 570`
  return `You are a request poller. Run only this Bash command (timeout 600000), copied exactly:
${cmd}${first ? '\nOn the FIRST run only, append " --requeue" to it.' : ''}
While it prints "events": [] with "timeout": true and no "stop": true, run it again: at most ${TAKE_CALLS} runs in total. Do nothing else between runs.
Return the events (id, type, from only), timeout and stop fields of the last run.`
}

function helperPrompt(ev) {
  const file = `${RUNDIR}/requests/taken/${ev.id}.json`
  const body = {
    'upstream-lookup': `Answer the question as your agent instructions describe. The references are ${REF}/assetstudio (AssetStudio C#, at the oracle revision c37af7d) and ${REF}/UnityPy.`,
    'upstream-researcher': `Investigate the question as your agent instructions describe; batch everything it asks into one report. The references are ${REF}/assetstudio (AssetStudio C#, at the oracle revision c37af7d) and ${REF}/UnityPy.`,
    'ts-scout': 'Locate the TypeScript code the question asks about, in the worktree it names (read-only). Report file:line locations with one line each on what is there; no file dumps.',
    'runner': `Run the commands the question lists, in the worktree it names: \`cd <worktree> && ...\`; npm run verify, npm test and builds always through ${HEAVY}, oracle scripts through ${HEAVY} --lock oracle. Do not edit, commit or push anything. Report per command: pass/fail, the failing test names, and the first error lines with file:line (at most 60 lines in total).`,
  }[ev.type]
  return `Helper request ${ev.id} from ${ev.from}. Read the request file ${file} with the Read tool; its "question" field is your task and its "worktree" field is the requester's worktree. ${body}
Your final message is delivered verbatim to the requester: lead with the answer, cite file:line evidence, say what is confirmed versus inferred.`
}

function deliverPrompt(id, text) {
  const path = `${RUNDIR}/answers/${id}.md`
  return `Deliver a helper answer. Use the Write tool to create ${path}.tmp with exactly the text between the markers (not the markers), then run (Bash) mv ${path}.tmp ${path} . Do nothing else.
<<<ANSWER
${text}
ANSWER>>>`
}

function mergePrompt(ev, L) {
  const file = `${RUNDIR}/requests/taken/${ev.id}.json`
  const slug = L.slug
  const branch = BRANCH(L)
  const D = LANE_DIR(slug)
  return `You are the CI and merge agent for lane "${slug}" (branch ${branch}, issues ${issuesText(L)}) in ${GH_REPO}. Read the request file ${file} with the Read tool: its "question" field is a JSON object {"pr": <number>, "head": "<sha the reviewer approved>"}. The PR passed review with no action required, and the user explicitly authorized merging PRs that passed this review loop by starting the wave run. Be mechanical: you never edit code, never resolve conflicts and never run tests locally (CI runs the full suite; the implementation and review agents already ran the oracle checks CI cannot run).
Every Bash call to ${MB} uses timeout 600000; every gh call uses timeout 300000 and up to two retries on HTTP 401 or a network error. You answer exactly once, at the end, with:
  ${MB} answer --run ${RUN} --id ${ev.id} --text '<json object>'
where the object is {"status":"merged|conflict|ci_failed|head_moved|merge_blocked|retry","merge_sha":"","file":"","head":"","notes":""} (no single quotes inside).
PR state and CI come from two compact commands (use them instead of polling gh pr view):
  ${MB} pr-state --pr <n>   -> {state, merged, merge_sha, draft, head, mergeable_state, behind_by}
  ${MB} ci-wait --run ${RUN} --broker merge --head <sha> --wait 570   -> waits in-process; {state: success|failure|pending|error, failed: [{name, conclusion, run_id, job_id}], pending, missing}
1. Head check: ${MB} pr-state --pr <n>. If the PR is already MERGED (an earlier merge agent merged it, then stopped before answering), do step 5's checks and answer merged with its merge SHA. If the PR head is the requested head, continue. Otherwise git -C ${ROOT} fetch origin ${branch} main and list the extra commits: git -C ${ROOT} log --format='%H %P %s' <requested head>..origin/${branch} . Continue only if the requested head is an ancestor (git -C ${ROOT} merge-base --is-ancestor <requested head> origin/${branch}) and every listed commit is a merge commit (two parent hashes) whose subject starts with "Merge branch 'main'": a branch update an earlier merge attempt made. Anything else is a push the reviewer has not seen: answer head_moved with head = the PR head.
2. Update: only when pr-state shows behind_by > 0: gh api -X PUT repos/${GH_REPO}/pulls/<n>/update-branch -f expected_head_sha=<head>, then pr-state again until the head changes (at most 5 tries, ${MB} pause --secs 20 between them) for the new head. A 422 whose message names a merge conflict: answer conflict with that message in notes. behind_by 0: continue.
3. CI: ${MB} ci-wait --run ${RUN} --broker merge --head <head> --wait 570 ; while it prints state pending, run it again (at most 10 runs, about 90 minutes; longer: answer retry). It returns success only when every check run on the head finished green and the changes, reader and decoder checks are present (a job its path filter skipped counts). state error: run it once more, then fall back to gh pr checks <n> -R ${GH_REPO}.
   On a failure: list the failing jobs and read their logs (gh run view <run-id> -R ${GH_REPO} --log-failed | tail -n 200). It is a flake only if the failing test has an open flaky-test issue (gh issue list -R ${GH_REPO} --state open --search 'flaky <TestName>') or it fails the same way on the latest main CI run (gh run list -R ${GH_REPO} --branch main --workflow CI --limit 1); then rerun the failed jobs once (gh run rerun <run-id> -R ${GH_REPO} --failed), comment the test name on that issue (or file one labelled area:infra), and go back to waiting. Otherwise write ${D}/ci/c<next number>.md (create the directory if needed) with the head sha, each failing check, the failing test names and about 40 log lines per failure, and answer ci_failed with file = that path and head = the sha.
   Checks that never start or fail for GitHub Actions infrastructure reasons (cancelled, queued > 30 min, runner errors) twice in a row: answer retry with notes "ci outage".
4. Merge: never edit the PR title or body (its Closes/Part of lines are the implementation agent's decision). If the PR is a draft, mark it ready (gh pr ready <n> -R ${GH_REPO}). gh pr merge <n> -R ${GH_REPO} --squash --match-head-commit <the head verified green>. "Head branch was modified" or "not up to date": back to step 2 (at most 3 times). If the permission system denies the merge, do not try another route: answer merge_blocked.
5. After the merge: the merge SHA from pr-state; git -C ${ROOT} push origin --delete ${branch}; confirm every "Closes" issue is closed (gh issue view <i> -R ${GH_REPO} --json state; close any that did not auto-close, commenting the merge SHA); ${MB} state --run ${RUN} --lane ${slug} --set status=merged --set merge_sha=<sha> ; answer merged with merge_sha.
Return: status, answered (true once the answer command printed "written": true), merge_sha, notes.`
}

// ---------------------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------------------
function sem(n) {
  let active = 0
  const q = []
  return async fn => {
    if (active < n) active++
    else await new Promise(r => q.push(r))
    try { return await fn() } finally {
      const nx = q.shift()
      if (nx) nx(); else active--
    }
  }
}
const hotLocks = {}
for (const L of ALL_LANES) for (const h of (L.hot || [])) if (!hotLocks[h]) hotLocks[h] = sem(1)
function withHot(groups, fn) {
  const gs = [...groups].sort()
  const step = i => i >= gs.length ? fn() : hotLocks[gs[i]](() => step(i + 1))
  return step(0)
}
function parseLines(lines) {
  const st = {}
  for (const ln of (lines || [])) {
    const [slug, status, stage, pr, round] = String(ln).split('|')
    if (slug) st[slug] = { status: status || 'active', stage: stage || '', pr: pr ? Number(pr) : undefined, round: round ? Number(round) : 0 }
  }
  return st
}
function parseData(s) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s || '{}') } catch (e) { return {} }
}

// ---------------------------------------------------------------------------
// Track role: one lane = one long-lived implementation agent + one long-lived review agent
// ---------------------------------------------------------------------------
async function lifecycle(L, prev, retried) {
  const slug = L.slug
  const history = []
  const resuming = prev && !DONE_BEFORE.includes(prev.status) && prev.stage ? prev : null
  // A retried lane gets a fresh round budget on top of the rounds it already used.
  const roundLimit = (retried && prev && prev.round ? prev.round : 0) + MAX_ROUNDS
  const runs = { impl: 0, review: 0 }
  const fails = { impl: 0, review: 0 } // early exits that are not checkpoints
  let checkpoints = 0
  let brief = null
  // Set once the PR exists; agents started after it get a pointer to the brief, not the brief.
  let pushed = !!(resuming && resuming.stage !== 'impl')
  const live = { impl: null, review: null }
  const done = { impl: null, review: null }
  const seen = { impl: 0, review: 0 } // the run number whose exit the loop below has handled

  const start = (role, resume) => {
    const n = ++runs[role]
    done[role] = null
    const model = role === 'impl' ? (L.implModel || M.impl) : (L.reviewModel || M.review)
    const opts = role === 'impl'
      ? { label: `impl:${slug}${n > 1 ? '#' + n : ''}`, phase: 'Implement', schema: IMPL_SCHEMA }
      : { label: `review:${slug}${n > 1 ? '#' + n : ''}`, phase: 'Review', schema: REVIEWER_SCHEMA }
    if (model) opts.model = model
    const effort = role === 'impl' ? L.implEffort : L.reviewEffort
    if (effort) opts.effort = effort
    const prompt = role === 'impl' ? implPrompt(L, resume, pushed ? null : brief, checkpoints < MAX_CHECKPOINTS) : reviewerPrompt(L, resume, roundLimit)
    live[role] = agentAs(role, prompt, opts).then(r => {
      if (r && r.pr_number) pushed = true
      done[role] = r || { status: 'died', summary: `${role} agent died` }
      return { role, n, r: done[role] }
    })
  }
  const why = (role, r) => `The previous ${role === 'impl' ? 'implementation' : 'review'} agent of this lane exited early (${r.status}: ${(r.summary || '').slice(0, 300)}).`
  const sendFinal = async data => {
    await agentAs('coord', deliverFinalPrompt(L, data), { label: `final:${slug}`, phase: 'Coordinate', model: M.coord, effort: 'low' })
  }

  if (BRIEF && !resuming) {
    const b = await agentAs('brief', briefPrompt(L), { label: `brief:${slug}`, phase: 'Implement', model: M.brief })
    if (typeof b === 'string' && b.trim() === 'STOP') { STOPPING = true; return { slug, status: 'stopped', history } }
    if (typeof b === 'string' && b.trim()) brief = b.trim().slice(0, 24000)
    else if (b && typeof b === 'object' && b.brief) brief = String(b.brief).slice(0, 24000)
  }
  start('impl', resuming ? implResume(L, 'A previous implementation agent for this lane stopped (run restart).') : null)
  // A checkpoint hands the lane to a fresh implementation agent; anything else counts as an early exit.
  const checkpointed = r => r.status === 'checkpoint' && checkpoints < MAX_CHECKPOINTS && ++checkpoints
  const ckptWhy = 'The previous implementation agent of this lane checkpointed to keep its context small; you continue its work with an empty context.'

  // Until the first push only the implementation agent runs; a cheap watcher holds the second slot.
  let reviewing = pushed
  let idleMin = 0
  let watchFails = 0
  let firstWatch = true
  // An implementation agent's exit (a checkpoint above all) posts no mailbox message, so the watcher
  // races it instead of being waited out; a watcher still in flight is reused on the next pass.
  let watching = null
  const settle = async res => { if (watching) await watching; return res }
  while (!reviewing) {
    if (!watching) watching = agentAs('coord', watchPrompt(L, firstWatch), { label: `watch:${slug}`, phase: 'Coordinate', model: M.coord, effort: 'low', schema: WAIT_SCHEMA }).then(w => ({ w }))
    const ev = await Promise.race([watching, live.impl.then(() => null)])
    const w = ev && ev.w
    if (ev) watching = null
    if (w) firstWatch = false
    if (w && w.stop) { STOPPING = true; await live.impl; return { slug, status: 'stopped', history, impl: done.impl } }
    const msgs = w ? (w.messages || []).map(m => ({ kind: m.kind, data: parseData(m.data) })) : []
    const term = msgs.find(m => m.kind === 'no_change' || m.kind === 'blocked')
    if (term) {
      await live.impl
      log(`${slug}: ${term.kind} — ${(term.data.summary || term.data.reason || '').slice(0, 160)}`)
      return { slug, status: term.kind, history, impl: done.impl }
    }
    if (msgs.some(m => m.kind === 'ready')) { reviewing = pushed = true; break }
    if (done.impl) {
      seen.impl = runs.impl
      if (done.impl.status === 'stopped') STOPPING = true
      if (['no_change', 'blocked', 'stopped'].includes(done.impl.status)) return settle({ slug, status: done.impl.status, history, impl: done.impl })
      if (checkpointed(done.impl)) {
        history.push(`impl#${runs.impl} checkpoint`)
        start('impl', implResume(L, ckptWhy))
        idleMin = 0
        continue
      }
      if (++fails.impl > RESTARTS) {
        // The last exit may follow a first push whose ready the watcher has not reported yet: then
        // the review side still finishes the lane, as it does for an exit after the push.
        const late = watching ? (await watching).w : null
        watching = null
        if (!(late && (late.messages || []).some(m => m.kind === 'ready'))) return { slug, status: 'failed', notes: 'implementation agent exited too often', history, impl: done.impl }
        history.push(`impl gave up after the first push: ${done.impl.status}`)
        reviewing = pushed = true
        break
      }
      history.push(`impl#${runs.impl} exited before the first push: ${done.impl.status}`)
      log(`${slug}: implementation agent exited (${done.impl.status}); starting a replacement`)
      start('impl', implResume(L, why('impl', done.impl)))
      idleMin = 0
      continue
    }
    if (!w) {
      if (++watchFails > 3) {
        await sendFinal({ reason: 'failed' })
        await live.impl
        return { slug, status: 'failed', notes: 'mailbox watcher failed repeatedly', history, impl: done.impl }
      }
      continue
    }
    watchFails = 0
    idleMin += WAIT_CALLS * 9.5
    if (idleMin > MAX_IDLE_MIN) {
      await sendFinal({ reason: 'stalled' })
      await live.impl
      return { slug, status: 'stalled', history, impl: done.impl }
    }
  }

  log(`${slug}: first push ready; review agent starting`)
  start('review', resuming && resuming.stage !== 'impl' ? reviewerResume(L, 'A previous review agent for this lane stopped (run restart).') : null)

  for (let guard = 0; guard < 50; guard++) {
    // Handle an exit the loop has not seen yet before waiting on anything: an agent can finish
    // while the other one is still being started, or both in the same tick.
    const exitOf = role => (done[role] && seen[role] < runs[role]) ? { role, n: runs[role], r: done[role] } : null
    let ev = exitOf('review') || exitOf('impl')
    if (!ev) {
      const pending = ['impl', 'review'].filter(role => !done[role]).map(role => live[role])
      if (!pending.length) break
      ev = await Promise.race(pending)
    }
    const { role, r } = ev
    seen[role] = ev.n
    if (role === 'review') {
      if (FINAL.includes(r.status)) {
        history.push(`review: ${r.status} — ${(r.summary || '').slice(0, 300)}`)
        if (!done.impl) {
          if (r.status !== 'stopped') await sendFinal({ reason: r.status, merge_sha: r.merge_sha || '' })
          await live.impl
        }
        log(`${slug}: ${r.status}${r.pr_number ? ' (PR #' + r.pr_number + ')' : ''}${r.merge_sha ? ' ' + r.merge_sha : ''}`)
        return { slug, status: r.status, pr: r.pr_number, rounds: r.rounds, merge_sha: r.merge_sha, history, impl: done.impl, review: r }
      }
      const implGone = done.impl && seen.impl === runs.impl && (FINAL.includes(done.impl.status) || fails.impl > RESTARTS)
      if (++fails.review > RESTARTS || implGone) {
        if (!done.impl) {
          await sendFinal({ reason: 'failed' })
          await live.impl
        }
        return { slug, status: 'failed', notes: 'review agent exited too often', history, impl: done.impl, review: r }
      }
      history.push(`review#${runs.review} exited: ${r.status}`)
      log(`${slug}: review agent exited (${r.status}); starting a replacement`)
      start('review', reviewerResume(L, why('review', r)))
      continue
    }
    // The implementation agent returned.
    if (FINAL.includes(r.status)) continue // it got its final message; the review agent returns next
    if (checkpointed(r)) {
      history.push(`impl#${runs.impl} checkpoint`)
      start('impl', implResume(L, ckptWhy))
      continue
    }
    if (++fails.impl > RESTARTS) {
      history.push(`impl gave up: ${r.status}`)
      if (!done.review) continue // the review agent ends the lane (stalled at worst)
      return { slug, status: 'failed', notes: 'implementation agent exited too often', history, impl: r, review: done.review }
    }
    history.push(`impl#${runs.impl} exited: ${r.status}`)
    log(`${slug}: implementation agent exited (${r.status}); starting a replacement`)
    start('impl', implResume(L, why('impl', r)))
  }
  return { slug, status: (done.review && done.review.status) || 'failed', history, impl: done.impl, review: done.review }
}

async function trackMain() {
  phase('Coordinate')
  const st0 = await agentAs('coord', statusPrompt(), { label: 'status', phase: 'Coordinate', model: M.coord, effort: 'low', schema: LINES_SCHEMA })
  let STATE = parseLines(st0 && st0.lines)
  const laneSem = sem(LANES)
  const results = []
  const waves = PLAN.waves || []
  log(`track ${TRACK}: ${waves.length} waves, ${LANES} lane(s) at a time, ${Object.keys(STATE).length} lanes with saved state`)
  for (let wi = 0; wi < waves.length; wi++) {
    const mine = (waves[wi].lanes || []).filter(L => L.track === TRACK).map(L => Object.assign({ wave: waves[wi].name || String(wi + 1) }, L))
    const settled = {}
    for (const L of mine) { let res; settled[L.slug] = { p: new Promise(r => { res = r }), res: s => res(s) } }
    const runOne = async L => {
      const prev = STATE[L.slug]
      if (prev && DONE_BEFORE.includes(prev.status) && !RETRY.includes(L.slug)) return { slug: L.slug, status: prev.status, pr: prev.pr, resumed: true }
      const same = (L.deps || []).filter(d => settled[d])
      const sameSt = await Promise.all(same.map(d => settled[d].p))
      const bad = (L.deps || []).filter(d => {
        const s = settled[d] ? sameSt[same.indexOf(d)] : (STATE[d] && STATE[d].status)
        return !SATISFIED.includes(s)
      })
      if (bad.length) {
        log(`${L.slug}: skipped, deps not merged: ${bad.join(', ')}`)
        return { slug: L.slug, status: 'skipped', notes: 'deps not merged: ' + bad.join(', ') }
      }
      const retryPrev = prev && RETRY.includes(L.slug) ? Object.assign({}, prev, { status: 'active' }) : prev
      const notStarted = { slug: L.slug, status: 'stopped', notes: 'run stopping: lane not started' }
      if (STOPPING) return notStarted
      return withHot(L.hot || [], () => laneSem(() => STOPPING ? notStarted : lifecycle(L, retryPrev, RETRY.includes(L.slug))))
    }
    const rs = await parallel(mine.map(L => async () => {
      let r
      try { r = await runOne(L) } catch (e) { r = { slug: L.slug, status: 'failed', notes: String(e) } }
      if (r.status === 'stopped') STOPPING = true
      settled[L.slug].res(r.status)
      STATE[L.slug] = Object.assign({}, STATE[L.slug], { status: r.status, pr: r.pr })
      return r
    }))
    results.push(...rs.filter(Boolean))
    log(`track ${TRACK}: wave ${wi + 1} done (${rs.filter(r => r && r.status === 'merged').length}/${mine.length} merged); waiting for the other tracks`)
    let b = null
    for (let tries = 0; tries < 20; tries++) {
      b = await agentAs('coord', barrierPrompt(wi, wi === waves.length - 1), { label: `barrier:w${wi + 1}`, phase: 'Coordinate', model: M.coord, effort: 'low', schema: LINES_SCHEMA })
      if (b && (b.passed || b.stop)) break
    }
    if (!b || b.stop || !b.passed) { log(`track ${TRACK}: stopping after wave ${wi + 1} (${b && b.stop ? 'STOP' : 'barrier did not pass'})`); break }
    STATE = Object.assign(STATE, parseLines(b.lines))
  }
  return results.map(r => ({ slug: r.slug, status: r.status, pr: r.pr, rounds: r.rounds, resumed: r.resumed, merge_sha: r.merge_sha, notes: r.notes, history: r.history,
    summary: r.impl ? r.impl.summary : undefined, closes: r.impl ? r.impl.closes : undefined, followups: r.impl ? r.impl.followups_filed : undefined,
    review: r.review ? r.review.summary : undefined }))
}

// ---------------------------------------------------------------------------
// Merger role: one merge agent at a time, for every track
// ---------------------------------------------------------------------------
async function mergerMain() {
  phase('Merge')
  const handled = []
  let requeued = false
  log(`merger: serving merge requests for tracks ${TRACKS.join(',')}`)
  for (let i = 0; i < 900; i++) {
    const t = await agentAs('coord', takePrompt('merge', !requeued), { label: 'take', phase: 'Merge', model: M.coord, effort: 'low', schema: TAKE_SCHEMA })
    if (!t) continue
    requeued = true // only a take that actually ran has re-served the orphans
    if (t.stop) break
    for (const ev of (t.events || [])) {
      const slug = String(ev.from).split('/')[0]
      const L = LANE_BY[slug] || { slug, issues: [] }
      const m = await agentAs('merge', mergePrompt(ev, L), { label: `merge:${slug}`, phase: 'Merge', model: M.merge, schema: MERGE_SCHEMA })
      if (!m || !m.answered) {
        await agentAs('deliver', deliverPrompt(ev.id, JSON.stringify({ status: 'retry', notes: 'merge agent ' + (m ? 'did not answer' : 'failed') })), { label: `deliver:${ev.id}`, phase: 'Merge', model: M.deliver, effort: 'low' })
      }
      handled.push(`${slug}: ${m ? m.status : 'failed'}`)
      log(`merger: ${slug} ${m ? m.status : 'failed'}${m && m.merge_sha ? ' ' + m.merge_sha : ''}`)
    }
  }
  return { handled }
}

// ---------------------------------------------------------------------------
// Helper role: serve helper requests from every track
// ---------------------------------------------------------------------------
async function helperMain() {
  phase('Helpers')
  const pending = []
  const perLane = {}
  const served = []
  let requeued = false
  const deliver = (id, text) => agentAs('deliver', deliverPrompt(id, text), { label: `deliver:${id}`, phase: 'Helpers', model: M.deliver, effort: 'low' })
  const helperOpts = ev => {
    const base = { label: `${ev.type}:${ev.from}`, phase: 'Helpers' }
    if (ev.type === 'upstream-lookup') return Object.assign(base, { agentType: 'upstream-lookup' }, M.lookup ? { model: M.lookup } : {})
    if (ev.type === 'upstream-researcher') return Object.assign(base, { agentType: 'upstream-researcher' }, M.researcher ? { model: M.researcher } : {})
    if (ev.type === 'ts-scout') return Object.assign(base, { model: M.scout })
    return Object.assign(base, { model: M.runner, effort: 'low' })
  }
  const helperRun = ev => ev.type === 'ts-scout' || ev.type === 'runner'
    ? agentAs(ev.type === 'ts-scout' ? 'scout' : 'runner', helperPrompt(ev), helperOpts(ev))
    : agent(helperPrompt(ev), helperOpts(ev))
  log(`helper broker: serving helper requests for tracks ${TRACKS.join(',')}`)
  for (let i = 0; i < 900; i++) {
    const t = await agentAs('coord', takePrompt('helper', !requeued), { label: 'take', phase: 'Helpers', model: M.coord, effort: 'low', schema: TAKE_SCHEMA })
    if (!t) continue
    requeued = true // only a take that actually ran has re-served the orphans
    if (t.stop) break
    for (const ev of (t.events || [])) {
      const lane = String(ev.from).split('/')[0]
      if (ev.type === 'upstream-researcher') {
        perLane[lane] = (perLane[lane] || 0) + 1
        if (perLane[lane] > RESEARCHER_LIMIT) {
          pending.push(deliver(ev.id, `DENIED: the upstream-researcher limit (${RESEARCHER_LIMIT} per lane) is used up for ${lane}. Ask upstream-lookup for single facts or research inline.`))
          continue
        }
      }
      served.push(`${ev.type} ${ev.from}`)
      pending.push(helperRun(ev).then(ans =>
        deliver(ev.id, ans ? String(ans) : `ERROR: the ${ev.type} helper failed. Research inline.`)))
    }
  }
  await Promise.all(pending)
  log(`helper broker: served ${served.length} requests`)
  return { served }
}

if (ROLE === 'merger') return await mergerMain()
if (ROLE === 'helper') return await helperMain()
return await trackMain()
