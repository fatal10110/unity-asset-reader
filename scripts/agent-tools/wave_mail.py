#!/usr/bin/env python3
"""File mailbox for `waves` workflow runs (.claude/skills/waves).

Workflow agents cannot spawn subagents or talk to each other, and the workflow
script cannot touch the filesystem. Every hand-off of a waves run therefore
goes through this CLI: lane mailboxes (orchestrator <-> long-lived implementation
agent), the helper-request queue served by the broker workflow, lane state for
resume, the cross-track merge lock and the wave barrier.

All output is one JSON object on stdout. Waits poll every POLL seconds and are
capped so one call fits in a 10-minute Bash tool timeout.

State root: $WAVES_ROOT/<run> (default <primary checkout>/.claude/worktrees/.waves/<run>).
Lane worktrees are siblings of the state root (<primary checkout>/.claude/worktrees/).
"""

import argparse
import contextlib
import subprocess
import re
import shutil
import fcntl
import json
import os
import sys
import time
import uuid
from pathlib import Path


def primary_checkout():
    """The main checkout of this repository, also when this file runs from a linked worktree."""
    here = Path(__file__).resolve().parent
    r = subprocess.run(["git", "-C", str(here), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return Path(r.stdout.strip()).parent
    return here.parents[1]


REPO = Path(os.environ.get("WAVES_REPO") or primary_checkout())
DEFAULT_ROOT = str(REPO / ".claude" / "worktrees" / ".waves")
GH_REPO = os.environ.get("WAVES_GH_REPO", "fatal10110/unity-asset-reader")
# The CI check runs a merge needs on the head (.github/workflows/ci.yml). A job its path filter
# skips still reports, as "skipped", which counts as passed.
REQUIRED_CHECKS = ("changes", "reader", "decoder")
_STOP_RUN = None  # set by main(): every JSON output of a stopping run carries "stop": true
POLL = float(os.environ.get("WAVES_POLL", "3"))
MAX_WAIT = 570
BROKER_STALE_SEC = 60 * 60
TAKEN_MAX_SEC = 4 * 60 * 60
TERMINAL_STATUSES = {"merged", "no_change", "blocked", "unresolved", "stalled", "merge_blocked", "failed", "skipped", "stopped"}
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
BRANCH_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,15}/[a-z0-9][a-z0-9.-]{0,63}")


def now():
    return time.time()


def out(obj):
    if _STOP_RUN and isinstance(obj, dict) and "stop" not in obj and stop_requested(_STOP_RUN):
        obj = dict(obj, stop=True)
    json.dump(obj, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def check(value, pattern, what):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise SystemExit(f"bad {what}: {value!r}")
    return value


def run_dir(run):
    check(run, NAME_RE, "run id")
    d = Path(os.environ.get("WAVES_ROOT", DEFAULT_ROOT)) / run
    d.mkdir(parents=True, exist_ok=True)
    return d


def lane_dir(run, lane):
    check(lane, SLUG_RE, "lane slug")
    d = run_dir(run) / "lanes" / lane
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


@contextlib.contextmanager
def flock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def parse_value(v):
    try:
        return json.loads(v)
    except json.JSONDecodeError:
        return v


def parse_sets(pairs):
    res = {}
    for p in pairs or []:
        if "=" not in p:
            raise SystemExit(f"--set wants key=value, got {p!r}")
        k, v = p.split("=", 1)
        res[k] = parse_value(v)
    return res


def parse_data(raw):
    if raw is None:
        return {}
    if raw == "-":
        raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"--data is not JSON: {e}")
    if not isinstance(data, dict):
        raise SystemExit("--data must be a JSON object")
    return data


def update_state(run, lane, changes):
    ld = lane_dir(run, lane)
    with flock(ld / ".state.lock"):
        st = read_json(ld / "state.json", {"lane": lane})
        st.update(changes)
        st["updated"] = round(now())
        write_atomic(ld / "state.json", json.dumps(st, indent=1, sort_keys=True))
    return st


def wait_secs(v):
    return max(0.0, min(float(v), MAX_WAIT))


def stop_requested(run):
    return (run_dir(run) / "STOP").exists()


def stop_banner(paths):
    """'### STOP ...' when a path lies in a lane worktree of a run that is stopping, else ''.

    Lets tools an agent runs anyway (heavy, look.py) carry the stop signal, so
    no agent spends a turn of its own checking for it.
    """
    root = Path(os.environ.get("WAVES_ROOT", DEFAULT_ROOT))
    stopping = [d for d in root.glob("*/STOP")]
    if not stopping:
        return ""
    want = [os.path.realpath(p) for p in paths if p]
    for stop in stopping:
        for st in stop.parent.glob("lanes/*/state.json"):
            wt = read_json(st, {}).get("worktree")
            if not wt:
                continue
            for cand in (wt, str(Path(wt).parent / ("review-" + st.parent.name))):
                c = os.path.realpath(cand)
                if any(w == c or w.startswith(c + os.sep) for w in want):
                    return f"### STOP: run {stop.parent.name} is stopping. Update your worklog, push nothing more, and return status stopped."
    return ""


# ---- lane mailboxes -------------------------------------------------------

def box_dir(run, lane, box):
    check(box, NAME_RE, "box name")
    d = lane_dir(run, lane) / "box" / box
    d.mkdir(parents=True, exist_ok=True)
    return d


def cmd_send(a):
    bd = box_dir(a.run, a.lane, a.box)
    data = parse_data(a.data)
    with flock(bd / ".seq.lock"):
        seq = read_json(bd / ".seq", 0) + 1
        msg = {"seq": seq, "kind": a.kind, "data": data, "ts": round(now())}
        write_atomic(bd / f"{seq:06d}.json", json.dumps(msg, ensure_ascii=False))
        write_atomic(bd / ".seq", str(seq))
    sets = parse_sets(a.set)
    if sets:
        update_state(a.run, a.lane, sets)
    out({"seq": seq})


def pending_messages(bd, after):
    msgs = []
    for p in sorted(bd.glob("[0-9]*.json")):
        m = read_json(p, None)
        if m and m["seq"] > after:
            msgs.append(m)
    return msgs


def cmd_recv(a):
    bd = box_dir(a.run, a.lane, a.box)
    cursor_file = bd / ".cursor"
    deadline = now() + wait_secs(a.wait)
    while True:
        after = a.after if a.after is not None else read_json(cursor_file, 0)
        msgs = pending_messages(bd, after)
        if msgs:
            if a.after is None and not a.peek:
                write_atomic(cursor_file, str(msgs[-1]["seq"]))
            out({"messages": msgs, "timeout": False})
            return
        if stop_requested(a.run):
            out({"messages": [], "timeout": False, "stop": True})
            return
        if now() >= deadline:
            out({"messages": [], "timeout": True})
            return
        time.sleep(POLL)


def cmd_drain(a):
    """Discard unconsumed messages: all of them, or only the given kinds (leaving the rest queued)."""
    bd = box_dir(a.run, a.lane, a.box)
    kinds = {k for k in (a.kinds or "").split(",") if k}
    after = read_json(bd / ".cursor", 0)
    n = 0
    for m in pending_messages(bd, after):
        if not kinds or m["kind"] in kinds:
            p = bd / f"{m['seq']:06d}.json"
            os.replace(p, p.with_suffix(".drained"))
            n += 1
    out({"drained": n})


# ---- lane state -----------------------------------------------------------

def cmd_state(a):
    sets = parse_sets(a.set)
    if sets:
        out(update_state(a.run, a.lane, sets))
    else:
        out(read_json(lane_dir(a.run, a.lane) / "state.json", {"lane": a.lane}))


def all_states(run):
    res = {}
    for sd in sorted((run_dir(run) / "lanes").glob("*/state.json")):
        st = read_json(sd, None)
        if st:
            res[sd.parent.name] = st
    return res


def status_line(slug, st):
    return "|".join(
        str(x if x is not None else "")
        for x in (slug, st.get("status", "active"), st.get("stage", ""), st.get("pr", ""), st.get("round", ""))
    )


def cmd_status(a):
    states = all_states(a.run)
    out({"lines": [status_line(k, v) for k, v in states.items()]})


# ---- helper requests (broker) ---------------------------------------------

def req_dir(run, sub):
    d = run_dir(run) / "requests" / sub
    d.mkdir(parents=True, exist_ok=True)
    return d


HELPER_TYPES = ("upstream-lookup", "upstream-researcher", "ts-scout", "runner")
BROKER_TYPES = {"helper": HELPER_TYPES, "merge": ("merge",)}


def broker_of(req_type):
    return "merge" if req_type == "merge" else "helper"


def broker_alive(run, broker):
    p = run_dir(run) / f"broker-{broker}.alive"
    try:
        return now() - p.stat().st_mtime < BROKER_STALE_SEC
    except FileNotFoundError:
        return False


def answer_path(run, rid):
    check(rid, ID_RE, "request id")
    return run_dir(run) / "answers" / f"{rid}.md"


def taken_recently(run, rid):
    p = req_dir(run, "taken") / f"{rid}.json"
    try:
        return now() - p.stat().st_mtime < TAKEN_MAX_SEC
    except FileNotFoundError:
        return False


def wait_answer(run, rid, secs, broker):
    deadline = now() + wait_secs(secs)
    p = answer_path(run, rid)
    while True:
        if p.exists():
            return {"id": rid, "answer": p.read_text(encoding="utf-8")}
        if stop_requested(run):
            return {"id": rid, "stop": True}
        if not broker_alive(run, broker) and not taken_recently(run, rid):
            return {"id": rid, "error": f"{broker} broker not running"}
        if now() >= deadline:
            return {"id": rid, "pending": True}
        time.sleep(POLL)


def cmd_ask(a):
    if a.type not in HELPER_TYPES + ("merge",):
        raise SystemExit("type must be one of " + ", ".join(HELPER_TYPES + ("merge",)))
    question = a.question if a.question != "-" else sys.stdin.read()
    if not question.strip():
        raise SystemExit("empty question")
    lane, _, role = a.sender.partition("/")
    check(lane, SLUG_RE, "--from lane")
    check(role, NAME_RE, "--from role")
    broker = broker_of(a.type)
    if not broker_alive(a.run, broker):
        out({"error": f"{broker} broker not running"})
        return
    rid = f"{lane}-{role}-{uuid.uuid4().hex[:8]}"
    req = {"id": rid, "type": a.type, "from": a.sender, "question": question,
           "worktree": a.worktree or "", "ts": round(now())}
    write_atomic(req_dir(a.run, "new") / f"{rid}.json", json.dumps(req, ensure_ascii=False))
    if a.nowait:
        out({"id": rid, "pending": True})
        return
    out(wait_answer(a.run, rid, a.wait, broker))


def cmd_answer_wait(a):
    check(a.id, ID_RE, "request id")
    req = read_json(req_dir(a.run, "taken") / f"{a.id}.json", None) or read_json(req_dir(a.run, "new") / f"{a.id}.json", {})
    out(wait_answer(a.run, a.id, a.wait, broker_of(req.get("type"))))


def cmd_answer(a):
    text = sys.stdin.read() if a.text in (None, "-") else a.text
    write_atomic(answer_path(a.run, a.id), text)
    out({"id": a.id, "written": True})


def track_dir(run, epoch):
    d = run_dir(run) / "tracks" / check(epoch, NAME_RE, "epoch")
    d.mkdir(parents=True, exist_ok=True)
    return d


def tracks_finished(run, epoch, tracks):
    return all((track_dir(run, epoch) / f"{check(t, NAME_RE, 'track')}.finished").exists() for t in tracks)


def dropped_answer(req_type):
    if req_type == "merge":
        return json.dumps({"status": "retry", "merge_sha": "", "file": "", "head": "",
                           "notes": "orphaned merge request dropped after a broker restart; ask again"})
    return "ERROR: this request was dropped after a broker restart. Ask again, or research inline."


def requeue_orphans(run, types):
    """Put back requests an earlier broker instance took but never answered (it crashed or was relaunched)."""
    n = 0
    for p in sorted(req_dir(run, "taken").glob("*.json")):
        ev = read_json(p, None)
        if not ev or ev.get("type") not in types or answer_path(run, ev["id"]).exists():
            continue
        lane = ev.get("from", "").partition("/")[0]
        st = read_json(run_dir(run) / "lanes" / lane / "state.json", {}) if SLUG_RE.fullmatch(lane) else {}
        if now() - ev.get("ts", 0) > TAKEN_MAX_SEC or st.get("status") in TERMINAL_STATUSES:
            # Too old to re-run, or its lane had ended. Close it with an answer so a requester
            # that is still (or again) waiting on this id asks afresh instead of waiting forever.
            write_atomic(answer_path(run, ev["id"]), dropped_answer(ev["type"]))
            continue
        try:
            os.replace(p, req_dir(run, "new") / p.name)
            n += 1
        except FileNotFoundError:
            pass
    return n


def cmd_take(a):
    tracks = [t for t in (a.tracks or "").split(",") if t]
    types = BROKER_TYPES[a.broker]
    requeued = requeue_orphans(a.run, types) if a.requeue else 0
    alive = run_dir(a.run) / f"broker-{a.broker}.alive"
    deadline = now() + wait_secs(a.wait)
    while True:
        alive.touch()
        events = []
        for p in sorted(req_dir(a.run, "new").glob("*.json")):
            ev = read_json(p, None)
            if not ev or ev.get("type") not in types:
                continue
            try:
                os.replace(p, req_dir(a.run, "taken") / p.name)
            except FileNotFoundError:
                continue  # another broker of this kind took it first
            events.append({"id": ev["id"], "type": ev["type"], "from": ev["from"],
                           "worktree": ev.get("worktree", ""), "question": ev["question"]})
        if events:
            out({"events": events, "timeout": False, "stop": False, "requeued": requeued})
            return
        if stop_requested(a.run) or (tracks and tracks_finished(a.run, a.epoch, tracks)):
            out({"events": [], "timeout": False, "stop": True})
            return
        if now() >= deadline:
            out({"events": [], "timeout": True, "stop": False})
            return
        time.sleep(POLL)


def cmd_request(a):
    check(a.id, ID_RE, "request id")
    p = req_dir(a.run, "taken") / f"{a.id}.json"
    if not p.exists():
        p = req_dir(a.run, "new") / f"{a.id}.json"
    out(read_json(p, {"error": "no such request"}))


# ---- merge lock -----------------------------------------------------------

def cmd_lock(a):
    check(a.name, NAME_RE, "lock name")
    ld = run_dir(a.run) / "locks"
    ld.mkdir(parents=True, exist_ok=True)
    owner_file = ld / f"{a.name}.json"
    with flock(ld / f".{a.name}.lock"):
        cur = read_json(owner_file, None)
    if a.action == "release":
        with flock(ld / f".{a.name}.lock"):
            cur = read_json(owner_file, None)
            if cur and (cur["owner"] == a.owner or a.force):
                owner_file.unlink()
                out({"released": True})
            else:
                out({"released": False, "holder": cur})
        return
    deadline = now() + wait_secs(a.wait)
    while True:
        with flock(ld / f".{a.name}.lock"):
            cur = read_json(owner_file, None)
            stale = cur and now() - cur["ts"] >= a.stale_min * 60
            if not cur or stale or cur["owner"] == a.owner:
                write_atomic(owner_file, json.dumps({"owner": a.owner, "ts": now()}))
                out({"acquired": True, "stole_from": cur["owner"] if stale and cur["owner"] != a.owner else None})
                return
        if now() >= deadline:
            out({"acquired": False, "holder": cur})
            return
        time.sleep(POLL)


# ---- waves ----------------------------------------------------------------

def cmd_barrier(a):
    tracks = [check(t, NAME_RE, "track") for t in a.tracks.split(",") if t]
    check(a.track, NAME_RE, "track")
    check(a.wave, NAME_RE, "wave")
    td = track_dir(a.run, a.epoch)
    (td / f"{a.track}.wave-{a.wave}.done").touch()
    deadline = now() + wait_secs(a.wait)
    while True:
        if all((td / f"{t}.wave-{a.wave}.done").exists() for t in tracks):
            states = all_states(a.run)
            out({"passed": True, "lines": [status_line(k, v) for k, v in states.items()]})
            return
        if stop_requested(a.run):
            out({"passed": False, "stop": True})
            return
        if now() >= deadline:
            missing = [t for t in tracks if not (td / f"{t}.wave-{a.wave}.done").exists()]
            out({"passed": False, "waiting_for": missing})
            return
        time.sleep(POLL)


def cmd_finish_track(a):
    (track_dir(a.run, a.epoch) / f"{check(a.track, NAME_RE, 'track')}.finished").touch()
    out({"finished": a.track})


def cmd_pause(a):
    if a.run and a.broker:
        (run_dir(a.run) / f"broker-{a.broker}.alive").touch()
    time.sleep(wait_secs(a.secs))
    if a.run and a.broker:
        (run_dir(a.run) / f"broker-{a.broker}.alive").touch()
    out({"paused": wait_secs(a.secs)})


# ---- worktrees ------------------------------------------------------------

def git(*args, check_rc=True):
    r = subprocess.run(["git", *map(str, args)], capture_output=True, text=True, timeout=600)
    if check_rc and r.returncode != 0:
        raise SystemExit(f"git {' '.join(map(str, args))}: {(r.stderr or r.stdout).strip()[-400:]}")
    return r


def seed_wasm(path):
    """Copy the shared decoder WASM build (<worktrees>/.ref/decoder-wasm) into a worktree that has none.

    The build needs Docker and takes minutes; without it the texture decode tests skip locally.
    Returns whether the worktree has the WASM afterwards.
    """
    dst = path / "packages" / "decoder" / "wasm"
    if (dst / "texture2ddecoder.wasm").exists():
        return True
    src = Path(os.environ.get("WAVES_ROOT", DEFAULT_ROOT)).resolve().parent / ".ref" / "decoder-wasm"
    if not (src / "texture2ddecoder.wasm").exists() or not dst.parent.is_dir():
        return False
    dst.mkdir(exist_ok=True)
    for f in src.iterdir():
        if f.suffix in (".js", ".wasm"):
            shutil.copy2(f, dst / f.name)
    return True


def cmd_worktree(a):
    """Create or reuse a lane's worktree with absolute paths, and record it in the lane state.

    Default: the implementation worktree wf-<slug> on --branch (default wf/<slug>; reused if
    it exists, else from the local branch, else from origin/<branch>, else new from origin/main).
    --review: the detached review worktree review-<slug>, moved to the current origin/<branch>.
    --remove: remove the worktree (and, for the implementation one, the local branch).
    Without --branch, a lane that already has one in its state keeps it.
    """
    slug = check(a.lane, SLUG_RE, "lane slug")
    go = REPO
    wt_root = Path(os.environ.get("WAVES_ROOT", DEFAULT_ROOT)).resolve().parent
    branch = a.branch or read_json(lane_dir(a.run, slug) / "state.json", {}).get("branch") or f"wf/{slug}"
    check(branch, BRANCH_RE, "branch")
    path = wt_root / (f"review-{slug}" if a.review else f"wf-{slug}")
    if a.remove:
        if path.exists():
            git("-C", go, "worktree", "remove", "--force", path)
        if not a.review:
            git("-C", go, "branch", "-D", branch, check_rc=False)
        git("-C", go, "worktree", "prune", check_rc=False)
        out({"removed": str(path)})
        return
    git("-C", go, "fetch", "-q", "origin", "main")
    remote = git("-C", go, "fetch", "-q", "origin", f"{branch}:refs/remotes/origin/{branch}", check_rc=False).returncode == 0
    created = False
    if a.review:
        if not remote:
            raise SystemExit(f"origin/{branch} does not exist yet")
        if (path / ".git").exists():
            git("-C", path, "checkout", "-q", "--detach", f"origin/{branch}")
        else:
            git("-C", go, "worktree", "add", "-q", "--detach", path, f"origin/{branch}")
            created = True
    elif not (path / ".git").exists():
        if (run_dir(a.run) / "DRAIN").exists():
            # Draining: lanes already under way finish; a lane that has no worktree yet never starts.
            out({"stop": True, "drain": True, "error": f"run {a.run} is draining: lane {slug} must not start"})
            return
        local = git("-C", go, "rev-parse", "-q", "--verify", f"refs/heads/{branch}", check_rc=False).returncode == 0
        if local:
            git("-C", go, "worktree", "add", "-q", path, branch)
        elif remote:
            git("-C", go, "worktree", "add", "-q", "--track", "-b", branch, path, f"origin/{branch}")
        else:
            git("-C", go, "worktree", "add", "-q", "--no-track", "-b", branch, path, "origin/main")
        created = True
    head = git("-C", path, "rev-parse", "HEAD").stdout.strip()
    dirty = len([l for l in git("-C", path, "status", "--porcelain").stdout.splitlines() if l])
    counts = git("-C", path, "rev-list", "--left-right", "--count", "origin/main...HEAD").stdout.split()
    res = {"worktree": str(path), "branch": None if a.review else branch, "head": head, "created": created,
           "dirty_files": dirty, "behind_main": int(counts[0]), "ahead_of_main": int(counts[1]),
           "decoder_wasm": seed_wasm(path)}
    if not a.review:
        st = read_json(lane_dir(a.run, slug) / "state.json", {})
        changes = {"worktree": str(path), "branch": branch}
        if not st.get("stage"):
            changes["stage"] = "impl"
        update_state(a.run, slug, changes)
    out(res)


# ---- GitHub PR state and CI (merge agent) ---------------------------------

def gh_api(path):
    gh = os.environ.get("WAVES_GH", "gh")
    r = subprocess.run([gh, "api", path], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-300:])
    return json.loads(r.stdout)


def pr_state(pr):
    p = gh_api(f"repos/{GH_REPO}/pulls/{int(pr)}")
    res = {"pr": int(pr), "state": p.get("state"), "merged": bool(p.get("merged")), "merge_sha": p.get("merge_commit_sha") if p.get("merged") else "",
           "draft": bool(p.get("draft")), "head": p["head"]["sha"], "branch": p["head"]["ref"], "mergeable_state": p.get("mergeable_state")}
    if not res["merged"]:
        cmp = gh_api(f"repos/{GH_REPO}/compare/{p['base']['ref']}...{p['head']['sha']}")
        res["behind_by"] = cmp.get("behind_by")
    return res


def cmd_pr_state(a):
    try:
        out(pr_state(a.pr))
    except (RuntimeError, KeyError, ValueError) as e:
        out({"error": str(e)})


def check_summary(head):
    runs = gh_api(f"repos/{GH_REPO}/commits/{head}/check-runs?per_page=100").get("check_runs", [])
    latest = {}
    for r in runs:  # a rerun adds a newer run of the same name; keep the newest
        n = r.get("name", "")
        if n not in latest or (r.get("id") or 0) > (latest[n].get("id") or 0):
            latest[n] = r
    pending, failed, passed = [], [], []
    for n, r in sorted(latest.items()):
        if r.get("status") != "completed":
            pending.append(n)
        elif r.get("conclusion") in ("success", "neutral", "skipped"):
            passed.append(n)
        else:
            url = r.get("details_url") or ""
            m = re.search(r"/actions/runs/(\d+)/job/(\d+)", url)
            failed.append({"name": n, "conclusion": r.get("conclusion"), "run_id": m.group(1) if m else "", "job_id": m.group(2) if m else ""})
    missing = [c for c in REQUIRED_CHECKS if not any(n == c or n.startswith(c + " ") for n in latest)]
    return pending, failed, passed, missing


def cmd_ci_wait(a):
    """Wait (up to --wait seconds) until every check run on the head has finished; one compact answer."""
    deadline = now() + wait_secs(a.wait)
    poll = float(os.environ.get("WAVES_CI_POLL", "30"))
    errors = 0
    while True:
        if a.broker:
            (run_dir(a.run) / f"broker-{a.broker}.alive").touch()
        try:
            pending, failed, passed, missing = check_summary(a.head)
            errors = 0
            if failed and not pending:
                out({"state": "failure", "head": a.head, "failed": failed, "passed": len(passed)})
                return
            if not pending and not missing:
                out({"state": "success", "head": a.head, "passed": len(passed)})
                return
        except (RuntimeError, ValueError) as e:
            errors += 1
            if errors >= 3:
                out({"state": "error", "head": a.head, "error": str(e)})
                return
            pending, failed, missing = ["?"], [], []
        if stop_requested(a.run):
            out({"state": "pending", "head": a.head, "stop": True})
            return
        if now() >= deadline:
            out({"state": "pending", "head": a.head, "pending": pending, "missing": missing, "failed_so_far": failed})
            return
        time.sleep(poll)


def cmd_stopcheck(a):
    banner = stop_banner(a.paths or [os.getcwd()])
    if banner:
        print(banner)
        sys.exit(3)


def cmd_stop(a):
    if a.drain:
        (run_dir(a.run) / "DRAIN").touch()
        out({"drain": True})
        return
    (run_dir(a.run) / "STOP").touch()
    out({"stop": True})


def validate(plan):
    errs = []
    tracks = plan.get("tracks") or []
    if not tracks:
        errs.append("plan.tracks is empty")
    for t in tracks:
        if not isinstance(t, str) or not NAME_RE.fullmatch(t):
            errs.append(f"bad track name {t!r}")
    waves = plan.get("waves") or []
    where = {}
    for wi, w in enumerate(waves):
        for l in w.get("lanes", []):
            s = l.get("slug")
            if not isinstance(s, str) or not SLUG_RE.fullmatch(s):
                errs.append(f"wave {wi}: bad slug {s!r} (lowercase letters, digits, '-')")
                continue
            if s in where:
                errs.append(f"duplicate slug {s}")
            where[s] = (wi, l.get("track"))
            if l.get("track") not in tracks:
                errs.append(f"{s}: track {l.get('track')!r} not in plan.tracks")
            if not l.get("issues"):
                errs.append(f"{s}: no issues")
            if "branch" in l and not (isinstance(l["branch"], str) and BRANCH_RE.fullmatch(l["branch"])):
                errs.append(f"{s}: bad branch {l['branch']!r} (<type>/<issue>-<slug>, e.g. feature/261-float-core)")
            for k in ("implModel", "reviewModel"):
                if k in l and not (isinstance(l[k], str) and l[k].strip()):
                    errs.append(f"{s}: {k} must be a model name or alias")
            for k in ("implEffort", "reviewEffort"):
                if k in l and l[k] not in ("low", "medium", "high", "xhigh", "max"):
                    errs.append(f"{s}: {k} must be low, medium, high, xhigh or max")
    for wi, w in enumerate(waves):
        hot_owner = {}
        for l in w.get("lanes", []):
            s = l.get("slug")
            for d in l.get("deps", []):
                if d not in where:
                    errs.append(f"{s}: unknown dep {d}")
                    continue
                dw, dt = where[d]
                if dw > wi:
                    errs.append(f"{s}: dep {d} is in a later wave")
                elif dw == wi and dt != l.get("track"):
                    errs.append(f"{s}: same-wave dep {d} is on another track ({dt})")
            for h in l.get("hot", []):
                if hot_owner.setdefault(h, l.get("track")) != l.get("track"):
                    errs.append(f"wave {wi}: hot group {h} spans tracks {hot_owner[h]} and {l.get('track')}")
    return errs


def cmd_validate(a):
    plan = json.loads(Path(a.plan).read_text(encoding="utf-8"))
    errs = validate(plan)
    out({"ok": not errs, "errors": errs})
    if errs:
        sys.exit(1)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, run=True):
        sp = sub.add_parser(name)
        if run:
            sp.add_argument("--run", required=True)
        sp.set_defaults(fn=fn)
        return sp

    s = add("send", cmd_send)
    s.add_argument("--lane", required=True)
    s.add_argument("--box", required=True)
    s.add_argument("--kind", required=True)
    s.add_argument("--data", help="JSON object, or - for stdin")
    s.add_argument("--set", action="extend", nargs="+", help="also update lane state: key=value [key=value ...]")

    s = add("recv", cmd_recv)
    s.add_argument("--lane", required=True)
    s.add_argument("--box", required=True)
    s.add_argument("--after", type=int, help="explicit seq; omit to consume from the box cursor")
    s.add_argument("--peek", action="store_true", help="read from the cursor without advancing it")
    s.add_argument("--wait", type=float, default=0)

    s = add("drain", cmd_drain)
    s.add_argument("--lane", required=True)
    s.add_argument("--box", required=True)
    s.add_argument("--kinds", help="comma-separated kinds to discard; default all")

    s = add("state", cmd_state)
    s.add_argument("--lane", required=True)
    s.add_argument("--set", action="extend", nargs="+", help="key=value [key=value ...]")

    add("status", cmd_status)

    s = add("ask", cmd_ask)
    s.add_argument("--from", dest="sender", required=True, help="<lane>/<role>")
    s.add_argument("--type", required=True)
    s.add_argument("--question", required=True, help="text, or - for stdin")
    s.add_argument("--worktree")
    s.add_argument("--wait", type=float, default=MAX_WAIT)
    s.add_argument("--nowait", action="store_true")

    s = add("answer-wait", cmd_answer_wait)
    s.add_argument("--id", required=True)
    s.add_argument("--wait", type=float, default=MAX_WAIT)

    s = add("answer", cmd_answer)
    s.add_argument("--id", required=True)
    s.add_argument("--text", help="answer text; omit or - for stdin")

    s = add("take", cmd_take)
    s.add_argument("--broker", choices=sorted(BROKER_TYPES), default="helper")
    s.add_argument("--epoch", default="1")
    s.add_argument("--requeue", action="store_true", help="first call of a broker instance: re-serve unanswered requests an earlier instance took")
    s.add_argument("--tracks", default="")
    s.add_argument("--wait", type=float, default=MAX_WAIT)

    s = add("request", cmd_request)
    s.add_argument("--id", required=True)

    s = add("lock", cmd_lock)
    s.add_argument("action", choices=["acquire", "release"])
    s.add_argument("--name", default="merge")
    s.add_argument("--owner", required=True)
    s.add_argument("--wait", type=float, default=MAX_WAIT)
    s.add_argument("--stale-min", type=float, default=180)
    s.add_argument("--force", action="store_true")

    s = add("barrier", cmd_barrier)
    s.add_argument("--epoch", default="1")
    s.add_argument("--wave", required=True)
    s.add_argument("--track", required=True)
    s.add_argument("--tracks", required=True)
    s.add_argument("--wait", type=float, default=MAX_WAIT)

    s = add("finish-track", cmd_finish_track)
    s.add_argument("--epoch", default="1")
    s.add_argument("--track", required=True)

    s = add("stop", cmd_stop)
    s.add_argument("--drain", action="store_true", help="let lanes under way finish; a lane without a worktree refuses to start")

    s = add("worktree", cmd_worktree)
    s.add_argument("--lane", required=True)
    s.add_argument("--branch", help="the lane's branch (default: the one in its state, else wf/<slug>)")
    s.add_argument("--review", action="store_true", help="the detached review worktree, moved to origin/<branch>")
    s.add_argument("--remove", action="store_true")

    s = add("pr-state", cmd_pr_state, run=False)
    s.add_argument("--pr", required=True, type=int)

    s = add("ci-wait", cmd_ci_wait)
    s.add_argument("--head", required=True)
    s.add_argument("--wait", type=float, default=MAX_WAIT)
    s.add_argument("--broker", choices=sorted(BROKER_TYPES), help="refresh that broker's alive marker while waiting")

    s = add("stopcheck", cmd_stopcheck, run=False)
    s.add_argument("paths", nargs="*")

    s = add("pause", cmd_pause, run=False)
    s.add_argument("--secs", type=float, required=True)
    s.add_argument("--run", help="with --broker: refresh that broker's alive marker while pausing")
    s.add_argument("--broker", choices=sorted(BROKER_TYPES))

    s = add("validate", cmd_validate, run=False)
    s.add_argument("plan")

    a = p.parse_args(argv)
    global _STOP_RUN
    _STOP_RUN = getattr(a, "run", None)
    a.fn(a)


if __name__ == "__main__":
    main()
