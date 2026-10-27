"""Unit tests for brain/snapshot.py against the demo vault: python -m unittest discover -s tests"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "brain"))
import snapshot  # noqa: E402

DEMO = ROOT / "examples" / "demo-vault"
NOW = dt.datetime(2026, 10, 20, 10, 0)  # a Tuesday


def build(**kw):
    return snapshot.build(DEMO, {}, now=NOW, routines_cfg=snapshot.load_json(ROOT / "brain" / "routines.json", {}),
                          areas_cfg=snapshot.load_json(ROOT / "brain" / "areas.json", None), owner="Me", owner_key="me", **kw)


class Frontmatter(unittest.TestCase):
    def test_scalars_lists_and_links(self):
        f, body = snapshot.parse_frontmatter('---\ntype: task\nproject: "[[Shop]]"\ntags: [a, "b c"]\nblocked_by:\n  - "[[T-001 - x]]"\nempty:\n---\n# Body\n')
        self.assertEqual(f["type"], "task")
        self.assertEqual(f["project"], "[[Shop]]")
        self.assertEqual(f["tags"], ["a", "b c"])
        self.assertEqual(f["blocked_by"], ["[[T-001 - x]]"])
        self.assertEqual(f["empty"], "")
        self.assertTrue(body.startswith("# Body"))

    def test_no_frontmatter(self):
        self.assertEqual(snapshot.parse_frontmatter("plain")[0], {})


class Todo(unittest.TestCase):
    def test_open_done_owner_and_task(self):
        open_items, done = snapshot.parse_todo((DEMO / "TODO.md").read_text(encoding="utf-8"))
        self.assertEqual(len(open_items), 2)
        self.assertEqual(open_items[0]["owner_link"], "Side Hustle Shop")
        self.assertEqual(open_items[0]["task"], "T-001 - Open the Etsy shop")
        self.assertIn("payout", open_items[0]["brief"])
        self.assertEqual(open_items[1]["task"], "")
        self.assertEqual(done[0]["done"], "2026-10-12")


class Cron(unittest.TestCase):
    def test_ranges_lists_and_sunday(self):
        mon = dt.datetime(2026, 10, 19, 6, 0)
        self.assertEqual(snapshot.cron_on("0 8 * * 1-5", mon).hour, 8)
        self.assertIsNone(snapshot.cron_on("0 8 * * 1-5", dt.datetime(2026, 10, 18, 6, 0)))
        self.assertIsNotNone(snapshot.cron_on("30 9 * * 0", dt.datetime(2026, 10, 18)))
        self.assertIsNotNone(snapshot.cron_on("30 9 * * 7", dt.datetime(2026, 10, 18)))
        self.assertIsNotNone(snapshot.cron_on("0 7 * * 2,4", dt.datetime(2026, 10, 20)))


class Snapshot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = build()

    def test_projects_and_areas(self):
        names = {p["name"]: p for p in self.s["projects"]}
        self.assertEqual(set(names), {"Side Hustle Shop", "Learn Spanish", "Home Lab", "Health"})
        self.assertEqual(names["Side Hustle Shop"]["open"], 3)
        self.assertEqual(names["Health"]["type"], "area")
        self.assertEqual(names["Health"]["last_run"], "2026-10-19")
        self.assertEqual(self.s["projects"][0]["name"], "Side Hustle Shop")  # active p1 first

    def test_needs_are_computed_in_code(self):
        keys = {n["key"] for n in self.s["needs"]}
        self.assertIn("task|T-001", keys)               # owner: me
        self.assertIn("go|T-003", keys)                 # approval: required
        self.assertIn("blocked|T-006", keys)            # blocked
        self.assertIn("decision|D-001 - Sell on Etsy first", keys)
        self.assertIn("inbox|Podcast idea", keys)
        self.assertTrue(any(k.startswith("todo|2026-10-20") for k in keys))  # TODO line without a task
        self.assertNotIn("task|T-002", keys)            # Claude's work is not a need
        self.assertEqual(self.s["needs"][0]["tag"], "decision")

    def test_claude_next_and_in_progress(self):
        self.assertEqual([t["id"] for t in self.s["claude_next"]], ["T-002"])
        self.assertEqual([t["id"] for t in self.s["in_progress"]], ["T-004"])

    def test_stale_in_progress(self):
        later = snapshot.build(DEMO, {}, now=dt.datetime(2026, 10, 25, 10, 0), owner_key="me")
        self.assertIn("stale|T-004", {n["key"] for n in later["needs"]})

    def test_routine_from_run_log(self):
        r = next(x for x in self.s["routines"] if x["label"] == "health-checkin")
        self.assertEqual(r["status"], "IDLE")  # Tuesday: the Monday routine is not scheduled
        self.assertEqual(len(r["runs"]), 3)
        self.assertFalse(r["runs"][1]["ok"])
        monday = snapshot.build(DEMO, {}, now=dt.datetime(2026, 10, 26, 12, 0), owner_key="me")
        self.assertIn("routine|health-checkin", {n["key"] for n in monday["needs"]})  # no 10-26 line: missed

    def test_routine_from_hook_log(self):
        with tempfile.TemporaryDirectory() as d:
            ts = dt.datetime(2026, 10, 26, 8, 3).astimezone().astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            Path(d, ts[:10] + ".jsonl").write_text(json.dumps({"ts": ts, "event": "prompt", "session_id": "x", "text": '<scheduled-task name="health-checkin" file="x">'}) + "\n", encoding="utf-8")
            monday = snapshot.build(DEMO, {}, now=dt.datetime(2026, 10, 26, 12, 0), owner_key="me", activity_dir=Path(d))
        r = next(x for x in monday["routines"] if x["label"] == "health-checkin")
        self.assertEqual(r["status"], "FIRED")

    def test_windows_task_without_log(self):
        cfg = {"windows": [{"task": "Backup", "label": "backup", "owner": "Home Lab"}]}
        win = {"tasks": [{"task": "Backup", "state": "Ready", "lastRun": "2026-10-20T02:00:00", "lastResult": 1, "nextRun": "2026-10-21T02:00:00"}]}
        r = snapshot.build_routines(cfg, win, {}, NOW)[0]
        self.assertEqual(r["status"], "FAILED")
        self.assertEqual(len(r["runs"]), 1)

    def test_deadlines_and_next14(self):
        self.assertEqual(self.s["deadlines"][0]["date"], "2026-11-30")
        self.assertTrue(all(e["tag"] == "routine" for e in self.s["next14"]))
        self.assertEqual(len(self.s["next14"]), 2)  # weekly routine, two Mondays in the window

    def test_sessions_and_heatmap(self):
        self.assertEqual(self.s["sessions"][0]["slug"], "2026-10-18 2010 - T-004 - Flashcard deck first half")
        self.assertEqual(self.s["sessions"][0]["projects"], ["Learn Spanish"])
        self.assertIn("150 of 300", self.s["sessions"][0]["summary"])
        self.assertEqual(sum(self.s["heatmap"]["weeks"].values()), 3)

    def test_graph(self):
        ids = {n["id"] for n in self.s["graph"]["nodes"]}
        self.assertIn("HQ", ids)
        self.assertIn("routine:health-checkin", ids)
        self.assertIn("app:etsy", ids)
        links = {(l["source"], l["target"]) for l in self.s["graph"]["links"]}
        self.assertIn(("Side Hustle Shop", "app:etsy"), links)
        self.assertIn(("T-002 - Draft ten product listings", "Side Hustle Shop"), links)
        area = {n["id"]: n["area"] for n in self.s["graph"]["nodes"]}
        self.assertEqual(area["T-002 - Draft ten product listings"], "business")

    def test_hash_ignores_cosmetic_changes(self):
        again = build()
        self.assertEqual(self.s["hash"], again["hash"])


class Diff(unittest.TestCase):
    def test_added_removed_changed(self):
        a = snapshot.director_view(build())
        b = json.loads(json.dumps(a))
        b["tasks"][0]["status"] = "done"
        b["needs"] = b["needs"][1:]
        d = snapshot.diff_views(a, b)
        self.assertEqual(d["tasks"]["changed"][0]["changes"]["status"], ["ready", "done"])
        self.assertEqual(len(d["needs"]["removed"]), 1)
        self.assertEqual(snapshot.diff_views(a, a), {})


if __name__ == "__main__":
    unittest.main()
