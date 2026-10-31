// Offline simulation of waves.js: fake agents talking through an in-memory mailbox, under the
// workflow concurrency cap. Run after editing waves.js: node waves_sim.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const SRC = readFileSync(fileURLToPath(new URL('./waves.js', import.meta.url)), 'utf8')
  .replace('export const meta =', 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = (ms = 2) => new Promise(r => setTimeout(r, ms))

function world(cap, scen) {
  const boxes = {}
  const state = {}
  const labels = []
  const types = [] // [label, agentType] per call, and the calls refused for a missing type
  const refused = []
  const rev = {} // per-lane review memory that survives a reviewer restart (the review files)
  let active = 0
  let peak = 0
  const q = []
  const lane = slug => (boxes[slug] ||= { impl: [], review: [], wake: {} })
  const post = (slug, b, kind, data) => {
    lane(slug)[b].push({ kind, data })
    const w = lane(slug).wake[b]
    if (w) { lane(slug).wake[b] = null; w() }
  }
  const recv = async (slug, b) => {
    while (!lane(slug)[b].length) await new Promise(r => { lane(slug).wake[b] = r })
    return lane(slug)[b].shift()
  }
  const set = (slug, kv) => Object.assign((state[slug] ||= {}), kv)

  async function fakeImpl(slug, prompt) {
    const sc = scen[slug] || {}
    if (scen.$stop) return { status: 'stopped', summary: 'saw STOP before pushing' }
    if (sc.implDies && !sc.implDied) { sc.implDied = true; return null }
    if (sc.implExitsAfterPush && !sc.implExited) {
      sc.implExited = true
      post(slug, 'review', 'ready', { reason: 'initial', pr: 100, head: 'h1' })
      return { status: 'idle_exit', summary: 'exited right after the push' }
    }
    if (sc.implNoChange) { post(slug, 'review', 'no_change', { summary: 'already fixed' }); return { status: 'no_change', summary: 'x' } }
    const resume = /RESUME:/.test(prompt)
    sc.prompts = (sc.prompts || []).concat(prompt)
    if (sc.checkpoints) {
      // Checkpoint once before the first push, once right after it, then serve the rounds.
      sc.n = (sc.n || 0) + 1
      if (sc.n === 1) return { status: 'checkpoint', summary: 'long context before the push' }
      if (sc.n === 2) { post(slug, 'review', 'ready', { reason: 'initial', pr: 100, head: 'h1' }); return { status: 'checkpoint', pr_number: 100, summary: 'pushed' } }
    }
    // An agent that checkpoints even after its prompt says none are left.
    if (sc.ckptAlways) return { status: 'checkpoint', summary: 'checkpoint regardless' }
    // Checkpoint whenever the prompt still allows it (the first agent pushes first).
    if (sc.ckptWhenAllowed && /\nCHECKPOINTS \(/.test(prompt)) {
      if (!resume) post(slug, 'review', 'ready', { reason: 'initial', pr: 100, head: 'h1' })
      return { status: 'checkpoint', summary: 'checkpoint while allowed' }
    }
    // A fresh agent pushes its first head; a resumed one finishes the saved stage and pushes again;
    // an agent taking over after a checkpoint past the push only serves rounds.
    if (!resume) post(slug, 'review', 'ready', { reason: 'initial', pr: sc.pr || 100, head: 'h1' })
    else if (!sc.checkpoints && !sc.ckptWhenAllowed) post(slug, 'review', 'ready', { reason: 'review-fix', head: 'hr' })
    let head = 1
    for (;;) {
      const m = await recv(slug, 'impl')
      head++
      if (m.kind === 'review') post(slug, 'review', 'ready', { reason: 'review-fix', head: 'h' + head })
      if (m.kind === 'ci') post(slug, 'review', 'ready', { reason: 'ci-fix', head: 'h' + head })
      if (m.kind === 'conflict') post(slug, 'review', 'ready', { reason: 'conflict', head: 'h' + head, semantic: false })
      if (m.kind === 'final') return { status: m.data.reason, summary: 'done ' + slug }
    }
  }

  async function fakeReviewer(slug, prompt) {
    const sc = scen[slug] || {}
    const r = (rev[slug] ||= { round: 0, merges: 0, starts: 0 })
    r.starts++
    const maxRounds = Number((prompt.match(/N >= (\d+): send final/) || [])[1])
    r.prompts = (r.prompts || []).concat(prompt)
    const merge = () => {
      const seq = sc.merges || ['merged']
      return seq[Math.min(++r.merges, seq.length) - 1]
    }
    for (;;) {
      if (sc.reviewerDiesAfter && r.round === sc.reviewerDiesAfter && r.starts === 1) return null
      const m = await recv(slug, 'review')
      if (m.kind !== 'ready') continue
      if (m.data.reason !== 'conflict') {
        r.round++
        set(slug, { round: r.round })
        if (r.round <= (sc.reviewRounds || 0)) {
          if (r.round >= maxRounds) { post(slug, 'impl', 'final', { reason: 'unresolved' }); set(slug, { status: 'unresolved' }); return { status: 'unresolved', rounds: r.round, summary: '' } }
          post(slug, 'impl', 'review', { round: r.round }); set(slug, { stage: 'fix' })
          continue
        }
      }
      const out = merge()
      if (out === 'merged') { post(slug, 'impl', 'final', { reason: 'merged' }); set(slug, { status: 'merged' }); return { status: 'merged', pr_number: sc.pr || 100, rounds: r.round, merge_sha: 'sha-' + slug, summary: '' } }
      if (out === 'ci_failed') post(slug, 'impl', 'ci', { file: 'c1' })
      if (out === 'conflict') post(slug, 'impl', 'conflict', { notes: 'x' })
    }
  }

  async function body(prompt, opts) {
    const label = opts.label || ''
    labels.push(label)
    const [kind, rest] = label.split(':')
    const slug = (rest || '').split('#')[0]
    if (kind === 'status') return { lines: scen.$status || [] }
    if (kind === 'brief' && scen.$stopBrief) return 'STOP'
    if (kind === 'impl') return fakeImpl(slug, prompt)
    if (kind === 'review') return fakeReviewer(slug, prompt)
    if (kind === 'watch') {
      if (scen.$stop) return { messages: [], timeout: false, stop: true }
      if (/ drain /.test(prompt)) lane(slug).review = lane(slug).review.filter(m => m.kind !== 'no_change' && m.kind !== 'blocked')
      for (let i = 0; i < 20 && !lane(slug).review.length; i++) await tick()
      const msgs = lane(slug).review.map((m, i) => ({ seq: i + 1, kind: m.kind, data: JSON.stringify(m.data) }))
      return { messages: msgs, timeout: msgs.length === 0 }
    }
    if (kind === 'final') {
      const m = prompt.match(/--kind final --data '(.*?)'/)
      post(slug, 'impl', 'final', JSON.parse(m[1]))
      return 'ok'
    }
    if (kind === 'barrier') return { passed: !scen.$stop, stop: !!scen.$stop, lines: Object.entries(state).map(([k, v]) => `${k}|${v.status || 'active'}|${v.stage || ''}|${v.pr || ''}|${v.round || ''}`) }
    if (kind === 'take') {
      const evs = scen.$take.shift()
      return evs ? { events: evs, stop: false } : { events: [], stop: true }
    }
    if (kind === 'merge') return { status: 'merged', answered: !/lane "nope"/.test(prompt), notes: '' }
    if (kind === 'deliver') return 'ok'
    return 'answer for ' + label
  }
  const models = []
  async function agent(prompt, opts = {}) {
    models.push([opts.label || '', opts.model || null, opts.effort || null])
    if (opts.agentType && scen.$missingTypes && opts.agentType.startsWith('wave-')) {
      refused.push(opts.agentType)
      throw new Error(`agent({agentType}): agent type '${opts.agentType}' not found. Available agents: claude`)
    }
    types.push([opts.label || '', opts.agentType || null])
    if (active >= cap) await new Promise(r => q.push(r))
    else active++
    peak = Math.max(peak, active)
    try { await tick(1); return await body(prompt, opts) } finally {
      const nx = q.shift()
      if (nx) nx(); else active--
    }
  }
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  return { agent, parallel, labels, types, refused, state, rev, models, peak: () => peak, preload: (slug, b, kind) => post(slug, b, kind, {}) }
}

async function run(args, scen, cap = 2) {
  const w = world(cap, scen)
  for (const [slug, kind] of scen.$preload || []) w.preload(slug, 'review', kind)
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', SRC)
  const res = await Promise.race([
    fn(args, w.agent, w.parallel, () => {}, () => {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock or hang: ' + w.labels.slice(-6).join(' > '))), 5000)),
  ])
  return { res, w }
}

const lane = (slug, track, extra) => Object.assign({ slug, track, issues: [1], milestone: 'M14 - x' }, extra)
const plan = {
  tracks: ['A'],
  waves: [
    { name: '1', lanes: [lane('a', 'A'), lane('b', 'A', { deps: ['a'] }), lane('n', 'A')] },
    { name: '2', lanes: [lane('c', 'A', { deps: ['a'] }), lane('d', 'A', { deps: ['n'] })] },
  ],
}
const by = res => Object.fromEntries(res.map(r => [r.slug, r]))
const count = (w, prefix) => w.labels.filter(l => l === prefix || l.startsWith(prefix + '#')).length

// 1. One implementation agent and ONE review agent per PR for every review, CI and conflict round,
//    on a 2-slot cap; deps gate later lanes.
{
  const { res, w } = await run({ run: 'sim', track: 'A', plan }, {
    a: { reviewRounds: 2, merges: ['ci_failed', 'conflict', 'merged'] },
    n: { implNoChange: true },
  })
  const r = by(res)
  assert.equal(r.a.status, 'merged')
  assert.equal(r.a.rounds, 4) // R1, R2 with findings, R3 clean, R4 after the CI fix; the conflict skips review
  assert.equal(count(w, 'impl:a'), 1, 'one implementation agent for the whole PR')
  assert.equal(count(w, 'review:a'), 1, 'one review agent for the whole PR')
  assert.equal(r.b.status, 'merged')
  assert.equal(r.n.status, 'no_change')
  assert.equal(count(w, 'review:n'), 0, 'no review agent without a PR')
  assert.equal(r.c.status, 'merged')
  assert.equal(r.d.status, 'merged', 'no_change satisfies a dep')
  assert.ok(w.peak() <= 2)
}

// 2. Unresolved after maxRounds; the dependents are skipped.
{
  const { res } = await run({ run: 'sim', track: 'A', plan, maxRounds: 2 }, { a: { reviewRounds: 9 } })
  const r = by(res)
  assert.equal(r.a.status, 'unresolved')
  assert.equal(r.b.status, 'skipped')
  assert.equal(r.c.status, 'skipped')
  assert.equal(r.d.status, 'merged')
}

// 3. Resume: finished lanes start nothing; a lane saved past impl starts both agents at once.
{
  const { res, w } = await run({ run: 'sim', track: 'A', plan }, {
    $status: ['a|merged||100|2', 'b|active|fix|101|1', 'n|no_change|||'], b: { pr: 101 },
  })
  const r = by(res)
  assert.equal(r.a.resumed, true)
  assert.equal(count(w, 'impl:a'), 0)
  assert.equal(r.b.status, 'merged')
  assert.ok(!w.labels.includes('watch:b'), 'a resumed review lane skips the first-push watch')
  assert.equal(count(w, 'review:b'), 1)
}

// 4. A dying implementation agent (before the first push) and a dying review agent are each replaced once.
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A')] }] }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: one }, { a: { implDies: true, reviewRounds: 2, reviewerDiesAfter: 1 } })
  assert.equal(res[0].status, 'merged')
  assert.equal(count(w, 'impl:a'), 2)
  assert.equal(count(w, 'review:a'), 2)
}

// 4b. An implementation agent that exits right after its first push is replaced, and the
//     review loop still runs (its exit happens before the loop starts waiting).
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A')] }] }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: one }, { a: { implExitsAfterPush: true, reviewRounds: 1 } })
  assert.equal(res[0].status, 'merged')
  assert.equal(count(w, 'impl:a'), 2)
  assert.equal(count(w, 'review:a'), 1)
}

// 4c. Retry: a stale no_change message from the earlier run is drained, and an unresolved lane
//     gets a fresh round budget on top of the rounds it used.
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('n', 'A'), lane('u', 'A')] }] }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: one, retry: ['n', 'u'] }, {
    $status: ['n|no_change|impl||', 'u|unresolved|fix|100|8'], $preload: [['n', 'no_change']], u: { reviewRounds: 1 },
  })
  const r = by(res)
  assert.equal(r.n.status, 'merged')
  assert.equal(r.u.status, 'merged')
  assert.ok(w.rev.u.prompts[0].includes('N >= 16'), 'retry budget = used rounds + maxRounds')
  assert.ok(w.rev.u.prompts[0].includes('is authoritative'), 'the resumed reviewer reads the current state')
}

// 5. Merger: merges run one at a time; an unanswered request gets a retry answer.
{
  const { res, w } = await run({ run: 'sim', role: 'merger', plan }, {
    $take: [[{ id: 'm1', type: 'merge', from: 'a/review' }, { id: 'm2', type: 'merge', from: 'nope/review' }]],
  })
  assert.equal(res.handled.length, 2)
  assert.deepEqual(w.labels.filter(l => l.startsWith('deliver:')), ['deliver:m2'])
}

// 6. Helper broker: the upstream-researcher limit is enforced and every request gets an answer.
{
  const { res, w } = await run({ run: 'sim', role: 'helper', plan: { tracks: ['A', 'B'], waves: [] } }, {
    $take: [[{ id: 'x1', type: 'upstream-lookup', from: 'a/impl' }, { id: 'x2', type: 'upstream-researcher', from: 'a/impl' }],
      [{ id: 'x3', type: 'upstream-researcher', from: 'a/review' }, { id: 'x4', type: 'runner', from: 'b/impl' }]],
  })
  assert.equal(res.served.length, 3)
  assert.equal(w.labels.filter(l => l.startsWith('deliver:')).length, 4)
}

// 7. The example plan runs on both tracks.
{
  const ex = JSON.parse(readFileSync(fileURLToPath(new URL('./plan.example.json', import.meta.url)), 'utf8'))
  for (const track of ex.tracks) {
    const { res } = await run({ run: 'sim', track, plan: ex }, {})
    assert.ok(res.length > 0 && res.every(r => r.status === 'merged'), track + ': ' + JSON.stringify(res.map(r => r.status)))
  }
}

// 8. Slim agent types: each role runs as its wave-* type; a type missing from the session's
//    registry is refused once per role, then that role runs on the default subagent.
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A')] }] }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: one }, { a: { reviewRounds: 1 } })
  assert.equal(res[0].status, 'merged')
  const t = Object.fromEntries(w.types.map(([l, ty]) => [l.split(':')[0], ty]))
  assert.equal(t.impl, 'wave-impl')
  assert.equal(t.review, 'wave-review')
  assert.equal(t.watch, 'wave-coord')
  const m = await run({ run: 'sim', role: 'merger', plan }, { $take: [[{ id: 'm1', type: 'merge', from: 'a/review' }]] })
  assert.deepEqual(m.w.types.map(([l, ty]) => ty), ['wave-coord', 'wave-merge', 'wave-coord'])

  const miss = await run({ run: 'sim', role: 'helper', plan: { tracks: ['A'], waves: [] } }, {
    $missingTypes: true,
    $take: [[{ id: 'x1', type: 'runner', from: 'a/impl' }], [{ id: 'x2', type: 'runner', from: 'a/impl' }]],
  })
  assert.equal(miss.res.served.length, 2)
  assert.deepEqual([...new Set(miss.w.refused)].sort(), ['wave-coord', 'wave-deliver', 'wave-runner'])
  assert.equal(miss.w.refused.filter(x => x === 'wave-coord').length, 1, 'a missing type is asked for once per role')
  assert.ok(miss.w.types.every(([, ty]) => ty === null), 'every call reran on the default subagent')
}

// 9. STOP mid-wave: the lane that sees it stops, the track starts no further lane, and the
//    next wave never starts.
{
  const four = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A'), lane('b', 'A'), lane('n', 'A')] }, { name: '2', lanes: [lane('c', 'A')] }] }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: four }, { $stop: true })
  const r = by(res)
  assert.ok(Object.values(r).every(x => x.status === 'stopped'), JSON.stringify(res.map(x => x.status)))
  assert.equal(w.labels.filter(l => l.startsWith('impl:')).length, 1, 'only the lane already running starts an implementation agent')
  assert.ok(!r.c, 'wave 2 never starts')
}

// 10. Lane brief runs once before a fresh implementation agent (not on resume); checkpoints hand
//     the lane to fresh agents without using the restart budget; per-lane models apply.
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A', { implModel: 'sonnet', implEffort: 'high' })] }] }
  const sa = { checkpoints: true, reviewRounds: 1 }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: one, restarts: 0, models: { review: 'opus' } }, { a: sa })
  assert.equal(res[0].status, 'merged', JSON.stringify(res[0]))
  assert.ok(sa.prompts[1].includes('LANE BRIEF') && sa.prompts[1].includes('already holds the issues'), 'a successor before the push gets the brief inline, and PHASE 1 starts from it')
  assert.ok(!sa.prompts[2].includes('LANE BRIEF') && sa.prompts[2].includes('The lane brief is in'), 'an agent after the push gets a pointer, not the brief')
  assert.equal(count(w, 'watch:a'), 1, 'a checkpoint before the push does not wait out the watcher')
  assert.equal(count(w, 'brief:a'), 1, 'one brief per fresh lane')
  assert.ok(w.labels.indexOf('brief:a') < w.labels.indexOf('impl:a'), 'the brief runs before the implementation agent')
  assert.equal(count(w, 'impl:a'), 3, 'two checkpoints -> three implementation agents')
  assert.ok(res[0].history.filter(h => /checkpoint/.test(h)).length === 2)
  const mo = Object.fromEntries(w.models.map(([l, m]) => [l.split('#')[0], m]))
  assert.equal(mo['impl:a'], 'sonnet')
  assert.equal(w.models.find(([l]) => l === 'impl:a')[2], 'high', 'the lane effort reaches the implementation agent')
  assert.equal(mo['review:a'], 'opus')
  assert.equal(mo['brief:a'], 'sonnet')
  const s2 = {}
  const r2 = await run({ run: 'sim', track: 'A', plan: one }, { $status: ['a|active|fix|100|1'], a: s2 })
  assert.equal(count(r2.w, 'brief:a'), 0, 'a resumed lane gets no new brief')
  assert.ok(s2.prompts[0].includes('The lane brief is in') && !s2.prompts[0].includes('LANE BRIEF'), 'a run restart points at the saved brief')
  const r3 = await run({ run: 'sim', track: 'A', plan: one, brief: false }, {})
  assert.equal(count(r3.w, 'brief:a'), 0, 'brief: false turns it off')
}

// 11. Once the checkpoint budget is spent, the next agent is told none are left, so it finishes
//     the lane instead of burning the restart budget.
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A')] }] }
  const sa = { ckptWhenAllowed: true, reviewRounds: 1 }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: one, restarts: 0, maxCheckpoints: 1 }, { a: sa })
  assert.equal(res[0].status, 'merged', JSON.stringify(res[0]))
  assert.equal(count(w, 'impl:a'), 2, 'one checkpoint -> two implementation agents')
  assert.ok(sa.prompts[1].includes('CHECKPOINTS: none are left'))
  const s0 = { ckptWhenAllowed: true }
  const r0 = await run({ run: 'sim', track: 'A', plan: one, restarts: 0, maxCheckpoints: 0 }, { a: s0 })
  assert.equal(r0.res[0].status, 'merged', JSON.stringify(r0.res[0]))
  assert.equal(count(r0.w, 'impl:a'), 1, 'maxCheckpoints: 0 never hands over')
  const ra = await run({ run: 'sim', track: 'A', plan: one, restarts: 0, maxCheckpoints: 1 }, { a: { ckptAlways: true } })
  assert.equal(ra.res[0].status, 'failed', 'a checkpoint past the budget counts as an early exit')
  assert.equal(count(ra.w, 'impl:a'), 2)
}

// 12. A brief agent that sees STOP (or DRAIN) ends the lane before any implementation agent, and
//     the track starts no further lane.
{
  const two = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A'), lane('b', 'A')] }] }
  const { res, w } = await run({ run: 'sim', track: 'A', plan: two }, { $stopBrief: true })
  assert.ok(res.every(x => x.status === 'stopped'), JSON.stringify(res.map(x => x.status)))
  assert.equal(w.labels.filter(l => l.startsWith('impl:')).length, 0)
  assert.equal(count(w, 'brief:b'), 0, 'the next lane never starts')
}

// 13. An implementation agent that exits (or dies) right after its first push, on the last allowed
//     exit, still leaves the lane to the review side, even when its exit beats the watcher.
{
  const one = { tracks: ['A'], waves: [{ name: '1', lanes: [lane('a', 'A')] }] }
  const p1 = await run({ run: 'sim', track: 'A', plan: one, restarts: 0 }, { a: { implExitsAfterPush: true } })
  assert.equal(p1.res[0].status, 'merged', JSON.stringify(p1.res[0]))
  assert.equal(count(p1.w, 'review:a'), 1)
  const p2 = await run({ run: 'sim', track: 'A', plan: one, restarts: 1 }, { a: { implDies: true, implExitsAfterPush: true } })
  assert.equal(p2.res[0].status, 'merged', JSON.stringify(p2.res[0]))
}

console.log('waves_sim: all scenarios passed')
