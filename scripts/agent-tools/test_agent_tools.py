"""Tests for the lane tools: wave_mail worktree/pr-state/ci-wait/stop signalling, look.py
and heavy. GitHub is replaced by a fake gh script.

  python3 -m unittest discover -s scripts/agent-tools -p 'test_*.py'
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MB = HERE / "wave_mail.py"
LOOK = HERE / "look.py"
HEAVY = HERE / "heavy"

FAKE_GH = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    data = json.load(open(os.environ["FAKE_GH_DATA"]))
    key = " ".join(sys.argv[1:])
    for k, v in data.items():
        if key.startswith(k):
            print(json.dumps(v)); sys.exit(0)
    sys.stderr.write("fake gh: no answer for " + key); sys.exit(1)
''')


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.waves = self.tmp / "wt" / ".waves"
        self.waves.mkdir(parents=True)
        gh = self.tmp / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.gh_data = self.tmp / "gh.json"
        self.env = dict(os.environ, WAVES_ROOT=str(self.waves), WAVES_GH=str(gh), FAKE_GH_DATA=str(self.gh_data),
                        WAVES_POLL="0.05", WAVES_CI_POLL="0.05")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def gh(self, data):
        self.gh_data.write_text(json.dumps(data))

    def run_py(self, script, *args, check=True):
        r = subprocess.run([sys.executable, str(script), *map(str, args)], capture_output=True, text=True, env=self.env)
        if check and r.returncode:
            self.fail(f"{script.name} {args}: rc={r.returncode} {r.stderr}")
        return r

    def mb(self, *args, check=True):
        r = self.run_py(MB, *args, check=check)
        return json.loads(r.stdout) if r.stdout.strip() else None


class WaveMailTools(Base):
    def test_set_takes_several_pairs(self):
        st = self.mb("state", "--run", "r", "--lane", "a", "--set", "round=4", "stage=merge")
        self.assertEqual((st["round"], st["stage"]), (4, "merge"))

    def test_every_output_of_a_stopping_run_says_stop(self):
        self.mb("state", "--run", "r", "--lane", "a", "--set", "stage=impl")
        self.assertNotIn("stop", self.mb("state", "--run", "r", "--lane", "a"))
        self.mb("stop", "--run", "r")
        self.assertTrue(self.mb("state", "--run", "r", "--lane", "a")["stop"])

    def test_stop_banner_names_lane_worktrees_only(self):
        wt = self.tmp / "wt" / "wf-a"
        (wt / "x").mkdir(parents=True)
        self.mb("state", "--run", "r", "--lane", "a", "--set", f"worktree={wt}")
        self.assertEqual(self.run_py(MB, "stopcheck", wt / "x").returncode, 0)
        self.mb("stop", "--run", "r")
        r = self.run_py(MB, "stopcheck", wt / "x", check=False)
        self.assertEqual(r.returncode, 3)
        self.assertIn("### STOP", r.stdout)
        self.assertEqual(self.run_py(MB, "stopcheck", self.tmp, check=False).returncode, 0)
        review = self.tmp / "wt" / "review-a"
        review.mkdir()
        self.assertEqual(self.run_py(MB, "stopcheck", review, check=False).returncode, 3)

    def test_worktree_creates_reuses_and_removes(self):
        origin = self.tmp / "origin.git"
        go = self.tmp / "go"
        git = lambda *a, cwd=None: subprocess.run(["git", *map(str, a)], cwd=cwd, check=True, capture_output=True)
        git("init", "-q", "--bare", "-b", "main", origin)
        git("clone", "-q", origin, go)
        git("-C", go, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
        git("-C", go, "push", "-q", "origin", "main")
        self.env["WAVES_REPO"] = str(go)
        r = self.mb("worktree", "--run", "r", "--lane", "a")
        self.assertTrue(r["created"])
        self.assertEqual(r["worktree"], str(self.tmp / "wt" / "wf-a"))
        st = self.mb("state", "--run", "r", "--lane", "a")
        self.assertEqual((st["stage"], st["branch"]), ("impl", "feature/a"))
        r = self.mb("worktree", "--run", "r", "--lane", "b", "--branch", "feature/12-b")
        self.assertEqual(self.mb("state", "--run", "r", "--lane", "b")["branch"], "feature/12-b")
        self.assertEqual(subprocess.run(["git", "-C", r["worktree"], "branch", "--show-current"], capture_output=True,
                                        text=True).stdout.strip(), "feature/12-b")
        self.mb("state", "--run", "r", "--lane", "a", "--set", "stage=review")
        r = self.mb("worktree", "--run", "r", "--lane", "a")
        self.assertFalse(r["created"])
        self.assertEqual(self.mb("state", "--run", "r", "--lane", "a")["stage"], "review", "reuse keeps the stage")
        wt = Path(r["worktree"])
        (wt / "golden.json").write_text("{}")
        (wt / "packages" / "decoder").mkdir(parents=True)
        (wt / "packages" / "decoder" / "package.json").write_text("{}")
        git("-C", wt, "add", "golden.json", "packages")
        git("-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work")
        git("-C", wt, "push", "-q", "origin", "feature/a")
        rv = self.mb("worktree", "--run", "r", "--lane", "a", "--review")
        self.assertEqual(rv["head"], self.mb("worktree", "--run", "r", "--lane", "a")["head"])
        self.assertEqual(rv["ahead_of_main"], 1)
        self.assertFalse(rv["decoder_wasm"], "no shared WASM build, no WASM")
        self.env["WAVES_REF"] = str(self.tmp / "ref")
        shared = self.tmp / "ref" / "decoder-wasm"
        shared.mkdir(parents=True)
        (shared / "texture2ddecoder.wasm").write_bytes(b"\0asm")
        # an oracle rerun that did not reproduce leaves a changed golden and a new file
        (Path(rv["worktree"]) / "golden.json").write_text('{"rerun": 1}')
        (Path(rv["worktree"]) / "new.json").write_text("{}")
        rv = self.mb("worktree", "--run", "r", "--lane", "a", "--review")
        self.assertTrue(rv["decoder_wasm"])
        self.assertEqual(rv["dirty_files"], 0, "a review round starts clean")
        self.assertEqual((Path(rv["worktree"]) / "packages/decoder/wasm/texture2ddecoder.wasm").read_bytes(), b"\0asm")
        self.mb("worktree", "--run", "r", "--lane", "a", "--remove")
        self.assertFalse(wt.exists())

    def test_drain_refuses_only_new_lanes(self):
        origin = self.tmp / "origin.git"
        go = self.tmp / "go"
        git = lambda *a: subprocess.run(["git", *map(str, a)], check=True, capture_output=True)
        git("init", "-q", "--bare", "-b", "main", origin)
        git("clone", "-q", origin, go)
        git("-C", go, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
        git("-C", go, "push", "-q", "origin", "main")
        self.env["WAVES_REPO"] = str(go)
        self.assertTrue(self.mb("worktree", "--run", "r", "--lane", "a")["created"])
        self.mb("stop", "--run", "r", "--drain")
        self.assertFalse(self.mb("worktree", "--run", "r", "--lane", "a")["created"], "a lane under way keeps working")
        r = self.mb("worktree", "--run", "r", "--lane", "b")
        self.assertTrue(r["stop"] and r["drain"])
        self.assertFalse((self.tmp / "wt" / "wf-b").exists())
        self.assertNotIn("stop", self.mb("state", "--run", "r", "--lane", "a"), "draining is not a stop for running lanes")

    def test_pr_state_is_compact(self):
        self.gh({"api repos/fatal10110/unity-asset-reader/pulls/7": {"state": "open", "merged": False, "draft": False,
                 "head": {"sha": "h1", "ref": "wf/a"}, "base": {"ref": "main"}, "mergeable_state": "behind"},
                 "api repos/fatal10110/unity-asset-reader/compare/main...h1": {"behind_by": 3}})
        self.assertEqual(self.mb("pr-state", "--pr", "7"), {"pr": 7, "state": "open", "merged": False, "merge_sha": "", "draft": False,
                         "head": "h1", "branch": "wf/a", "mergeable_state": "behind", "behind_by": 3})

    def runs(self, *rows):
        return {"api repos/fatal10110/unity-asset-reader/commits/h1/check-runs": {"check_runs": [
            {"id": i, "name": n, "status": s, "conclusion": c, "details_url": f"https://x/actions/runs/9/job/{i}"}
            for i, (n, s, c) in enumerate(rows, 1)]}}

    def test_ci_wait_success_needs_the_required_checks(self):
        self.gh(self.runs(("CodeQL", "completed", "success")))
        r = self.mb("ci-wait", "--run", "r", "--head", "h1", "--wait", "0.2")
        self.assertEqual((r["state"], r["missing"]), ("pending", ["changes", "reader", "decoder"]))
        self.gh(self.runs(("changes", "completed", "success"), ("reader (node 22)", "completed", "success"),
                          ("decoder", "completed", "skipped")))
        self.assertEqual(self.mb("ci-wait", "--run", "r", "--head", "h1", "--wait", "1")["state"], "success")

    def test_ci_wait_reports_failures_once_all_finished(self):
        self.gh(self.runs(("changes", "completed", "success"), ("decoder", "completed", "success"),
                          ("reader (node 20)", "completed", "failure"), ("reader (node 22)", "in_progress", None)))
        self.assertEqual(self.mb("ci-wait", "--run", "r", "--head", "h1", "--wait", "0.2")["state"], "pending")
        self.gh(self.runs(("changes", "completed", "success"), ("decoder", "completed", "success"),
                          ("reader (node 20)", "completed", "failure"), ("reader (node 22)", "completed", "success")))
        r = self.mb("ci-wait", "--run", "r", "--head", "h1", "--wait", "1")
        self.assertEqual(r["state"], "failure")
        self.assertEqual(r["failed"], [{"name": "reader (node 20)", "conclusion": "failure", "run_id": "9", "job_id": "3"}])


class LookTool(Base):
    def test_batches_ranges_ts_cs_py_and_rg(self):
        src = self.tmp / "src"
        src.mkdir()
        (src / "a.ts").write_text("// file header\n\n/** A thing. */\nexport class T {\n  n = 1;\n  /** Returns n. */\n  get(): number {\n    return this.n;\n  }\n}\n\nexport function free(): void {}\n")
        # C# lives outside the repo (R2); the test writes it only to a temporary directory.
        (src / "A.cs").write_text("class A {\n  /// <summary>Says hi.</summary>\n  public int Hi(int x) {\n    if (x > 0) { return 1; }\n    return 0;\n  }\n  void Other() {}\n}\n")
        (src / "a.py").write_text("class C:\n    @property\n    def hi(self):\n        if self:\n\n            return 1\n        return 0\n\n    def other(self):\n        pass\n")
        out = self.run_py(LOOK, "--root", src, "a.ts:4-5", "ts:.:T.get,free", "cs:A.cs:Hi", "py:a.py:hi", "rg:.:free", "rgl:.:return").stdout
        self.assertIn("4\texport class T {", out)
        self.assertIn("6\t  /** Returns n. */", out)
        self.assertIn("12\texport function free(): void {}", out)
        self.assertNotIn("1\t// file header", out)
        self.assertIn("2\t  /// <summary>Says hi.</summary>", out)
        self.assertIn("6\t  }", out)
        self.assertNotIn("void Other", out)
        self.assertIn("2\t    @property", out)
        self.assertIn("7\t        return 0", out)
        self.assertNotIn("def other", out)
        self.assertRegex(out, r"a\.ts:12:export function free")
        self.assertRegex(out, r"A\.cs:2")
        self.assertNotIn("### STOP", out)

    def test_caps_long_output(self):
        f = self.tmp / "big.txt"
        f.write_text("\n".join(f"line {i}" for i in range(1, 400)))
        out = self.run_py(LOOK, f"{f}:1-399", "--max", "20").stdout
        self.assertIn("20\tline 20", out)
        self.assertNotIn("21\tline 21", out)
        self.assertIn("more lines cut", out)


class HeavyTool(Base):
    def test_runs_the_command_and_keeps_its_exit_code(self):
        r = self.run_py(HEAVY, sys.executable, "-c", "print('ran'); raise SystemExit(4)", check=False)
        self.assertEqual((r.returncode, r.stdout.strip()), (4, "ran"))
        self.assertTrue((self.waves / ".locks" / "cpu.lock").exists())

    def test_lock_is_exclusive(self):
        hold = subprocess.Popen([sys.executable, str(HEAVY), "--lock", "unity", sys.executable, "-c", "import time; time.sleep(1)"],
                                env=self.env, stdout=subprocess.DEVNULL)
        time.sleep(0.3)
        r = self.run_py(HEAVY, "--lock", "unity", sys.executable, "-c", "print('second')")
        hold.wait()
        self.assertIn("waiting for the unity lock", r.stdout)
        self.assertIn("second", r.stdout)

    def test_refuses_in_a_stopping_lane(self):
        wt = self.tmp / "wt" / "wf-a"
        wt.mkdir(parents=True)
        self.mb("state", "--run", "r", "--lane", "a", "--set", f"worktree={wt}")
        self.mb("stop", "--run", "r")
        r = subprocess.run([sys.executable, str(HEAVY), "true"], cwd=wt, capture_output=True, text=True, env=self.env)
        self.assertEqual(r.returncode, 3)
        self.assertIn("### STOP", r.stdout)


if __name__ == "__main__":
    unittest.main()
