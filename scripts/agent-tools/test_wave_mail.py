import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("wave_mail.py")


class WaveMailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = dict(os.environ, WAVES_ROOT=self.tmp.name, WAVES_POLL="0.05")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, stdin=None, check=True):
        r = subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, text=True,
                           capture_output=True, env=self.env)
        if check and r.returncode:
            self.fail(f"{args}: {r.stderr}")
        return json.loads(r.stdout) if r.stdout.strip() else None

    def test_box_cursor_consumes_in_order(self):
        self.run_cli("send", "--run", "r", "--lane", "a", "--box", "orch", "--kind", "ready",
                     "--data", '{"pr": 7}', "--set", "stage=review", "--set", "pr=7")
        self.run_cli("send", "--run", "r", "--lane", "a", "--box", "orch", "--kind", "blocked")
        got = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "orch")
        self.assertEqual([m["kind"] for m in got["messages"]], ["ready", "blocked"])
        self.assertEqual(got["messages"][0]["data"], {"pr": 7})
        again = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "orch", "--wait", "0.2")
        self.assertTrue(again["timeout"])
        st = self.run_cli("state", "--run", "r", "--lane", "a")
        self.assertEqual((st["stage"], st["pr"]), ("review", 7))

    def test_recv_wakes_on_send(self):
        def later():
            time.sleep(0.3)
            self.run_cli("send", "--run", "r", "--lane", "a", "--box", "impl", "--kind", "review")
        t = threading.Thread(target=later)
        t.start()
        got = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "impl", "--wait", "5")
        t.join()
        self.assertEqual(got["messages"][0]["kind"], "review")

    def test_ask_needs_live_broker_then_round_trips(self):
        r = self.run_cli("ask", "--run", "r", "--from", "a/impl", "--type", "upstream-lookup", "--question", "q")
        self.assertIn("helper broker not running", r["error"])
        take = self.run_cli("take", "--run", "r", "--wait", "0")
        self.assertTrue(take["timeout"])
        ask = self.run_cli("ask", "--run", "r", "--from", "a/impl", "--type", "upstream-lookup",
                           "--question", "-", "--nowait", stdin="where is X?")
        take = self.run_cli("take", "--run", "r", "--wait", "1")
        self.assertEqual(take["events"][0]["question"], "where is X?")
        self.run_cli("answer", "--run", "r", "--id", ask["id"], stdin="X.cs:12")
        got = self.run_cli("answer-wait", "--run", "r", "--id", ask["id"], "--wait", "1")
        self.assertEqual(got["answer"], "X.cs:12")

    def test_brokers_take_only_their_types(self):
        self.run_cli("take", "--run", "r", "--broker", "helper", "--wait", "0")
        r = self.run_cli("ask", "--run", "r", "--from", "a/review", "--type", "merge", "--question", "{}", "--nowait")
        self.assertIn("merge broker not running", r["error"])
        self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        m = self.run_cli("ask", "--run", "r", "--from", "a/review", "--type", "merge", "--question", '{"pr": 5}', "--nowait")
        h = self.run_cli("ask", "--run", "r", "--from", "a/impl", "--type", "runner", "--question", "npm test", "--nowait")
        got = self.run_cli("take", "--run", "r", "--broker", "helper", "--wait", "0")
        self.assertEqual([e["id"] for e in got["events"]], [h["id"]])
        got = self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        self.assertEqual([e["id"] for e in got["events"]], [m["id"]])
        self.assertEqual(self.run_cli("answer-wait", "--run", "r", "--id", m["id"], "--wait", "0")["pending"], True)

    def test_peek_does_not_consume(self):
        self.run_cli("send", "--run", "r", "--lane", "a", "--box", "review", "--kind", "ready")
        p = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "review", "--peek")
        self.assertEqual(p["messages"][0]["kind"], "ready")
        c = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "review")
        self.assertEqual(c["messages"][0]["kind"], "ready")
        self.assertTrue(self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "review", "--wait", "0")["timeout"])

    def test_taken_request_counts_as_live_broker(self):
        self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        m = self.run_cli("ask", "--run", "r", "--from", "a/review", "--type", "merge", "--question", "{}", "--nowait")
        self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        alive = Path(self.tmp.name) / "r" / "broker-merge.alive"
        os.utime(alive, (time.time() - 3 * 3600, time.time() - 3 * 3600))
        self.assertTrue(self.run_cli("answer-wait", "--run", "r", "--id", m["id"], "--wait", "0")["pending"])
        r = self.run_cli("ask", "--run", "r", "--from", "b/review", "--type", "merge", "--question", "{}", "--nowait")
        self.assertIn("merge broker not running", r["error"])
        self.run_cli("pause", "--secs", "0", "--run", "r", "--broker", "merge")
        r = self.run_cli("ask", "--run", "r", "--from", "b/review", "--type", "merge", "--question", "{}", "--nowait")
        self.assertTrue(r["pending"])

    def test_relaunched_broker_requeues_unanswered_requests(self):
        self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        m1 = self.run_cli("ask", "--run", "r", "--from", "a/review", "--type", "merge", "--question", "{}", "--nowait")
        m2 = self.run_cli("ask", "--run", "r", "--from", "b/review", "--type", "merge", "--question", "{}", "--nowait")
        self.assertEqual(len(self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")["events"]), 2)
        self.run_cli("answer", "--run", "r", "--id", m1["id"], "--text", "{}")
        # the merger crashed before answering m2; its replacement re-serves only m2
        got = self.run_cli("take", "--run", "r", "--broker", "merge", "--requeue", "--wait", "0")
        self.assertEqual(([e["id"] for e in got["events"]], got["requeued"]), ([m2["id"]], 1))

    def test_requeue_skips_ended_lanes_and_old_requests(self):
        self.run_cli("take", "--run", "r", "--broker", "helper", "--wait", "0")
        old = self.run_cli("ask", "--run", "r", "--from", "a/impl", "--type", "runner", "--question", "x", "--nowait")
        ended = self.run_cli("ask", "--run", "r", "--from", "b/impl", "--type", "runner", "--question", "x", "--nowait")
        live = self.run_cli("ask", "--run", "r", "--from", "c/impl", "--type", "runner", "--question", "x", "--nowait")
        self.run_cli("take", "--run", "r", "--broker", "helper", "--wait", "0")
        p = Path(self.tmp.name) / "r" / "requests" / "taken" / f"{old['id']}.json"
        req = json.loads(p.read_text()); req["ts"] -= 5 * 3600; p.write_text(json.dumps(req))
        self.run_cli("state", "--run", "r", "--lane", "b", "--set", "status=failed")
        got = self.run_cli("take", "--run", "r", "--broker", "helper", "--requeue", "--wait", "0")
        self.assertEqual([e["id"] for e in got["events"]], [live["id"]])
        for rid in (old["id"], ended["id"]):
            self.assertIn("dropped", self.run_cli("answer-wait", "--run", "r", "--id", rid, "--wait", "0")["answer"])

    def test_dropped_merge_orphan_answers_retry(self):
        self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        m = self.run_cli("ask", "--run", "r", "--from", "a/review", "--type", "merge", "--question", "{}", "--nowait")
        self.run_cli("take", "--run", "r", "--broker", "merge", "--wait", "0")
        p = Path(self.tmp.name) / "r" / "requests" / "taken" / f"{m['id']}.json"
        req = json.loads(p.read_text()); req["ts"] -= 5 * 3600; p.write_text(json.dumps(req))
        self.run_cli("take", "--run", "r", "--broker", "merge", "--requeue", "--wait", "0")
        ans = json.loads(self.run_cli("answer-wait", "--run", "r", "--id", m["id"], "--wait", "0")["answer"])
        self.assertEqual(ans["status"], "retry")

    def test_answer_wait_reports_stop(self):
        self.run_cli("take", "--run", "r", "--wait", "0")
        h = self.run_cli("ask", "--run", "r", "--from", "a/impl", "--type", "runner", "--question", "x", "--nowait")
        self.run_cli("stop", "--run", "r")
        self.assertTrue(self.run_cli("answer-wait", "--run", "r", "--id", h["id"], "--wait", "1")["stop"])

    def test_drain_skips_stale_messages(self):
        self.run_cli("send", "--run", "r", "--lane", "a", "--box", "review", "--kind", "no_change")
        self.run_cli("send", "--run", "r", "--lane", "a", "--box", "review", "--kind", "ready")
        self.assertEqual(self.run_cli("drain", "--run", "r", "--lane", "a", "--box", "review", "--kinds", "no_change,blocked")["drained"], 1)
        got = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "review", "--peek")
        self.assertEqual([m["kind"] for m in got["messages"]], ["ready"])
        self.assertEqual(self.run_cli("drain", "--run", "r", "--lane", "a", "--box", "review")["drained"], 1)
        self.assertTrue(self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "review", "--peek", "--wait", "0")["timeout"])
        self.run_cli("send", "--run", "r", "--lane", "a", "--box", "review", "--kind", "ready")
        got = self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "review", "--peek")
        self.assertEqual([m["kind"] for m in got["messages"]], ["ready"])

    def test_markers_are_per_epoch(self):
        for t in ("A", "B"):
            self.run_cli("finish-track", "--run", "r", "--track", t, "--epoch", "1")
            self.run_cli("barrier", "--run", "r", "--wave", "0", "--track", t, "--tracks", "A,B", "--epoch", "1", "--wait", "0")
        self.assertTrue(self.run_cli("take", "--run", "r", "--tracks", "A,B", "--epoch", "1", "--wait", "0")["stop"])
        self.assertFalse(self.run_cli("take", "--run", "r", "--tracks", "A,B", "--epoch", "2", "--wait", "0")["stop"])
        r = self.run_cli("barrier", "--run", "r", "--wave", "0", "--track", "A", "--tracks", "A,B", "--epoch", "2", "--wait", "0")
        self.assertEqual(r["waiting_for"], ["B"])

    def test_names_reaching_paths_are_validated(self):
        for args in (["answer", "--run", "r", "--id", "../x", "--text", "y"],
                     ["lock", "acquire", "--run", "r", "--name", "../m", "--owner", "a", "--wait", "0"],
                     ["barrier", "--run", "r", "--wave", "../0", "--track", "A", "--tracks", "A", "--wait", "0"],
                     ["state", "--run", "r", "--lane", "A b"],
                     ["ask", "--run", "r", "--from", "a;b/impl", "--type", "runner", "--question", "x"]):
            r = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=self.env)
            self.assertNotEqual(r.returncode, 0, args)

    def test_take_stops_when_all_tracks_finished(self):
        self.run_cli("finish-track", "--run", "r", "--track", "A")
        r = self.run_cli("take", "--run", "r", "--tracks", "A,B", "--wait", "0")
        self.assertFalse(r["stop"])
        self.run_cli("finish-track", "--run", "r", "--track", "B")
        r = self.run_cli("take", "--run", "r", "--tracks", "A,B", "--wait", "1")
        self.assertTrue(r["stop"])

    def test_lock_is_exclusive_and_reentrant(self):
        self.assertTrue(self.run_cli("lock", "acquire", "--run", "r", "--owner", "a")["acquired"])
        self.assertTrue(self.run_cli("lock", "acquire", "--run", "r", "--owner", "a")["acquired"])
        self.assertFalse(self.run_cli("lock", "acquire", "--run", "r", "--owner", "b", "--wait", "0.2")["acquired"])
        self.assertFalse(self.run_cli("lock", "release", "--run", "r", "--owner", "b")["released"])
        self.assertTrue(self.run_cli("lock", "release", "--run", "r", "--owner", "a")["released"])
        self.assertTrue(self.run_cli("lock", "acquire", "--run", "r", "--owner", "b", "--wait", "0")["acquired"])

    def test_stale_lock_is_stolen(self):
        self.run_cli("lock", "acquire", "--run", "r", "--owner", "a")
        r = self.run_cli("lock", "acquire", "--run", "r", "--owner", "b", "--stale-min", "0", "--wait", "0")
        self.assertEqual((r["acquired"], r["stole_from"]), (True, "a"))

    def test_barrier_passes_when_every_track_arrives(self):
        self.run_cli("state", "--run", "r", "--lane", "x", "--set", "status=merged", "--set", "pr=5")
        r = self.run_cli("barrier", "--run", "r", "--wave", "1", "--track", "A", "--tracks", "A,B", "--wait", "0")
        self.assertEqual(r["waiting_for"], ["B"])
        r = self.run_cli("barrier", "--run", "r", "--wave", "1", "--track", "B", "--tracks", "A,B", "--wait", "0")
        self.assertTrue(r["passed"])
        self.assertEqual(r["lines"], ["x|merged||5|"])

    def test_stop_releases_waiters(self):
        self.run_cli("stop", "--run", "r")
        self.assertTrue(self.run_cli("recv", "--run", "r", "--lane", "a", "--box", "impl", "--wait", "5")["stop"])

    def test_validate_plan(self):
        plan = {"tracks": ["A", "B"], "waves": [
            {"lanes": [{"slug": "a", "track": "A", "issues": [1], "hot": ["h"]},
                       {"slug": "b", "track": "B", "issues": [2], "deps": ["a"], "hot": ["h"]}]},
            {"lanes": [{"slug": "c", "track": "B", "issues": [3], "deps": ["a", "zz"]}]}]}
        p = Path(self.tmp.name) / "plan.json"
        p.write_text(json.dumps(plan))
        r = self.run_cli("validate", str(p), check=False)
        self.assertFalse(r["ok"])
        self.assertEqual(sorted(r["errors"]), sorted([
            "b: same-wave dep a is on another track (A)",
            "wave 0: hot group h spans tracks A and B",
            "c: unknown dep zz"]))
        plan["waves"][0]["lanes"][0]["implModel"] = ""
        p.write_text(json.dumps(plan))
        r = self.run_cli("validate", str(p), check=False)
        self.assertIn("a: implModel must be a model name or alias", r["errors"])
        plan["waves"][0]["lanes"][0]["implModel"] = "sonnet"
        plan["waves"][0]["lanes"][0]["implEffort"] = "huge"
        p.write_text(json.dumps(plan))
        r = self.run_cli("validate", str(p), check=False)
        self.assertIn("a: implEffort must be low, medium, high, xhigh or max", r["errors"])
        plan["waves"][0]["lanes"][0]["implEffort"] = "high"
        plan["waves"][0]["lanes"][0]["slug"] = "Bad Slug"
        p.write_text(json.dumps(plan))
        r = self.run_cli("validate", str(p), check=False)
        self.assertTrue(any("bad slug" in e for e in r["errors"]))

    def test_bad_ids_are_refused(self):
        r = subprocess.run([sys.executable, str(SCRIPT), "state", "--run", "../x", "--lane", "a"],
                           capture_output=True, text=True, env=self.env)
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
