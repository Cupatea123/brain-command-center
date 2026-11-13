"""Fixture tests for brain/usage.py: python -m unittest discover -s tests

Each test builds a small Claude home (transcripts, skills, plugins, .claude.json) in a temp folder.
"""
import datetime as dt
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "brain"))
import snapshot  # noqa: E402
import usage  # noqa: E402

NOW = dt.datetime(2026, 10, 20, 18, 0)
WORK = "C:\\Work\\Acme"
HOME_CWD = "D:\\Personal"


def ts(day: str, hms: str) -> str:
    """A local time as the UTC stamp transcripts carry."""
    return dt.datetime.fromisoformat(f"{day} {hms}").astimezone().astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def use(i, o, cw, cr):
    return {"input_tokens": i, "output_tokens": o, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr}


def prompt(at, text, cwd=HOME_CWD):
    return {"type": "user", "timestamp": at, "cwd": cwd, "message": {"role": "user", "content": text}}


def result(at, tool_use_id, cwd=HOME_CWD, **kw):
    return {"type": "user", "timestamp": at, "cwd": cwd, "toolUseResult": {"ok": True},
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": "TEXT-MARKER result"}]}, **kw}


def reply(at, mid, usage_, blocks=None, cwd=HOME_CWD, **attrs):
    return {"type": "assistant", "timestamp": at, "cwd": cwd,
            "message": {"id": mid, "model": "claude-test", "usage": usage_, "content": blocks or [{"type": "text", "text": "TEXT-MARKER reply"}]}, **attrs}


def tool(tid, name, **inp):
    return [{"type": "tool_use", "id": tid, "name": name, "input": inp}]


def write(path: Path, records) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records), encoding="utf-8")


def session_one():
    """Day 2026-10-19: a Skill call, then two attributed responses, one of them split over two records."""
    d = "2026-10-19"
    split = use(10, 20, 300, 7000)
    return [
        prompt(ts(d, "12:00:00"), "TEXT-MARKER run the brain"),
        reply(ts(d, "12:00:05"), "msg_1", use(100, 50, 1000, 5000)),
        reply(ts(d, "12:00:05"), "msg_1", use(100, 50, 1000, 5000), tool("tu_1", "Skill", skill="brain", args="TEXT-MARKER")),
        result(ts(d, "12:00:06"), "tu_1"),
        {"type": "user", "timestamp": ts(d, "12:00:06"), "cwd": HOME_CWD, "isMeta": True, "message": {"role": "user", "content": "TEXT-MARKER skill body"}},
        reply(ts(d, "12:00:10"), "msg_2", split, attributionSkill="brain"),
        reply(ts(d, "12:00:10"), "msg_2", split, tool("tu_2", "mcp__tv__quote", symbol="TEXT-MARKER"), attributionSkill="brain"),
        result(ts(d, "12:00:12"), "tu_2"),
        reply(ts(d, "12:00:15"), "msg_3", use(5, 40, 100, 7300), attributionSkill="brain", attributionMcpServer="tv"),
    ]


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "claude"
        self.proj = self.home / "projects" / "D--Personal"
        self.data = self.tmp / "data"
        one = session_one()
        write(self.proj / "one.jsonl", one)
        # A forked session copies its parent's records, then carries on the next day.
        write(self.proj / "fork.jsonl", one + [
            prompt(ts("2026-10-20", "09:00:00"), "again"),
            reply(ts("2026-10-20", "09:00:02"), "msg_4", use(1, 1, 1, 1), tool("tu_4", "Skill", skill="brain")),
            result(ts("2026-10-20", "09:00:03"), "tu_4"),
            reply(ts("2026-10-20", "09:00:05"), "msg_5", use(1, 2, 3, 4), attributionSkill="brain"),
        ])
        # A typed slash command: attributed responses with no Skill call.
        write(self.proj / "two.jsonl", [
            prompt(ts("2026-10-18", "08:00:00"), "<command-name>/loop</command-name>"),
            reply(ts("2026-10-18", "08:00:03"), "msg_6", use(1, 1, 1, 0), attributionSkill="loop"),
            reply(ts("2026-10-18", "08:00:06"), "msg_7", use(1, 1, 1, 0), attributionSkill="loop"),
        ])
        # Outside the 30-day window.
        write(self.proj / "old.jsonl", [
            prompt(ts("2026-09-01", "08:00:00"), "old"),
            reply(ts("2026-09-01", "08:00:03"), "msg_8", use(1, 1, 1, 0), tool("tu_8", "Skill", skill="ancient")),
        ])
        # A sub-agent of session one.
        agent = self.proj / "one" / "subagents" / "agent-a1.jsonl"
        write(agent, [
            prompt(ts("2026-10-19", "12:01:00"), "TEXT-MARKER brief"),
            reply(ts("2026-10-19", "12:01:04"), "msg_a1", use(1000, 200, 0, 0), attributionAgent="general-purpose"),
            reply(ts("2026-10-19", "12:01:04"), "msg_a1", use(1000, 200, 0, 0), attributionAgent="general-purpose"),
        ])
        agent.with_name("agent-a1.meta.json").write_text(json.dumps({"agentType": "Explore", "description": "TEXT-MARKER"}), encoding="utf-8")
        # Excluded: a work project folder (never opened), a session that ran in a work folder, the director.
        (self.home / "projects" / "C--Work-Acme").mkdir(parents=True)
        (self.home / "projects" / "C--Work-Acme" / "w.jsonl").write_text("not json: this file must never be opened\n", encoding="utf-8")
        write(self.proj / "moved.jsonl", [prompt(ts("2026-10-19", "10:00:00"), "x", cwd=WORK + "\\sub"),
                                          reply(ts("2026-10-19", "10:00:02"), "msg_w", use(9, 9, 9, 9), cwd=WORK + "\\sub", attributionSkill="work-skill")])
        write(self.proj / "dir.jsonl", [{"type": "custom-title", "customTitle": "Command Center Director", "sessionId": "d"},
                                        prompt(ts("2026-10-19", "07:00:00"), "anything"),
                                        reply(ts("2026-10-19", "07:00:02"), "msg_d", use(9, 9, 9, 9), attributionSkill="director-skill")])
        write(self.proj / "dir2.jsonl", [prompt(ts("2026-10-19", "07:30:00"), "REFRESH FULL 2026-10-19T12:30:00Z"),
                                         reply(ts("2026-10-19", "07:30:02"), "msg_d2", use(9, 9, 9, 9), attributionSkill="director-skill")])
        # What is installed.
        for name in ("brain", "unused"):
            (self.home / "skills" / name).mkdir(parents=True)
            (self.home / "skills" / name / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: >\n  Files notes and tasks\n  in the vault.\nuser-invocable: true\n---\n# body TEXT-MARKER\n", encoding="utf-8")
        plug = self.home / "plugins" / "cache" / "m" / "sp" / "1.0"
        (plug / "skills" / "plan").mkdir(parents=True)
        (plug / "skills" / "plan" / "SKILL.md").write_text("x", encoding="utf-8")
        (self.home / "plugins" / "installed_plugins.json").write_text(json.dumps({"plugins": {"sp@m": [{"installPath": str(plug)}]}}), encoding="utf-8")
        off = self.home / "plugins" / "synced" / "bucket" / "sales" / "skills" / "pitch"
        off.mkdir(parents=True)
        (off / "SKILL.md").write_text("x", encoding="utf-8")
        (self.home / "settings.json").write_text(json.dumps({"enabledPlugins": {"sp@m": True, "sales@synced": False}, "env": {"K": "SECRET-VALUE"}}), encoding="utf-8")
        self.claude_json = self.tmp / ".claude.json"
        self.claude_json.write_text(json.dumps({
            "skillUsage": {"old-skill": {"usageCount": 4, "lastUsedAt": 1750000000000}, "brain": {"usageCount": 9, "lastUsedAt": 1750000000000}},
            "mcpServers": {"tv": {"env": {"KEY": "SECRET-VALUE"}}, "idle": {"url": "https://SECRET-VALUE"}},
            "oauthAccount": {"emailAddress": "SECRET-EMAIL"},
        }), encoding="utf-8")
        self.cfg = {"claudeHome": str(self.home), "claudeJson": str(self.claude_json), "dataDir": str(self.data),
                    "excludeRoots": [WORK], "connectorNames": {"abc-123": "Mail"}}

    def build(self):
        return usage.build_usage(self.cfg, now=NOW, skills_dirs=[self.home / "skills"])

    def by(self, rows):
        return {r["key"]: r for r in rows}


class Tokens(Fixture):
    def test_a_response_split_over_records_is_counted_once(self):
        u, _ = self.build()
        brain = self.by(u["skills"])["brain"]
        # msg_2 (330 new tokens, written as two records) + msg_3 (145) + msg_5 in the fork (6)
        self.assertEqual(brain["tokens"], 330 + 145 + 6)
        self.assertEqual(brain["cache_read"], 7000 + 7300 + 4)
        naive = sum(r["message"]["usage"]["input_tokens"] + r["message"]["usage"]["output_tokens"] + r["message"]["usage"]["cache_creation_input_tokens"]
                    for r in session_one() if r.get("attributionSkill") == "brain")
        self.assertEqual(naive, 330 * 2 + 145)  # what summing every record would give

    def test_a_forked_session_does_not_count_its_parent_twice(self):
        u, _ = self.build()
        self.assertEqual(self.by(u["skills"])["brain"]["calls"], 2)       # tu_1 once, tu_4 once
        self.assertEqual(self.by(u["connectors"])["tv"]["calls"], 1)

    def test_agent_tokens_come_from_its_own_transcript(self):
        u, _ = self.build()
        explore = self.by(u["agents"])["Explore"]                         # the type in meta.json wins
        self.assertEqual((explore["calls"], explore["tokens"]), (1, 1200))
        self.assertEqual(explore["ms"], 4000)


class Calls(Fixture):
    def test_skill_connector_and_times(self):
        u, _ = self.build()
        brain, tv = self.by(u["skills"])["brain"], self.by(u["connectors"])["tv"]
        self.assertEqual(tv["ms"], 2000)                                  # tool_use 12:00:10 -> its result 12:00:12
        self.assertEqual(tv["tokens"], 145)                               # the response that read the result
        self.assertEqual(brain["ms"], 4000 + 2000 + 3000 + 2000)          # while the skill was driving, both days
        self.assertEqual(brain["last"], "2026-10-20T09:00")

    def test_a_sub_agent_inherits_the_skill_without_adding_a_call(self):
        write(self.proj / "one" / "subagents" / "agent-a2.jsonl", [
            prompt(ts("2026-10-19", "12:02:00"), "brief"),
            reply(ts("2026-10-19", "12:02:03"), "msg_a2", use(10, 10, 10, 0), attributionSkill="brain", attributionAgent="general-purpose")])
        u, _ = self.build()
        brain = self.by(u["skills"])["brain"]
        self.assertEqual((brain["calls"], brain["tokens"]), (2, 481 + 30))  # its work counts for the skill, its start does not
        self.assertEqual(self.by(u["agents"])["general-purpose"]["calls"], 1)

    def test_a_typed_slash_command_is_one_call(self):
        u, _ = self.build()
        self.assertEqual(self.by(u["skills"])["loop"]["calls"], 1)

    def test_window(self):
        u, s = self.build()
        self.assertNotIn("ancient", self.by(u["skills"]))
        self.assertEqual(u["since"], "2026-09-21")
        self.assertEqual(u["history_from"], "2026-09-01")
        self.assertEqual(self.by(s["skills"])["ancient"]["band"], "under-used")


class Excluded(Fixture):
    def test_work_and_director_sessions_are_left_out(self):
        u, s = self.build()
        names = set(self.by(u["skills"])) | set(self.by(s["skills"]))
        self.assertFalse(names & {"work-skill", "director-skill"})
        self.assertEqual(u["excluded"], {"work": 2, "director": 2})
        self.assertEqual(u["files"], 5)                                   # one, fork, two, old, the sub-agent


class Stored(Fixture):
    def test_cache_reuses_unchanged_files(self):
        self.assertEqual(self.build()[0]["parsed"], 8)                    # every file under D--Personal
        self.assertEqual(self.build()[0]["parsed"], 0)
        with open(self.proj / "two.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(reply(ts("2026-10-18", "08:00:09"), "msg_9", use(1, 1, 1, 0), attributionSkill="loop")) + "\n")
        u, _ = self.build()
        self.assertEqual(u["parsed"], 1)
        self.assertEqual(self.by(u["skills"])["loop"]["tokens"], 9)

    def test_daily_totals_outlive_the_transcripts(self):
        before = self.by(self.build()[0]["skills"])["brain"]
        for name in ("one.jsonl", "fork.jsonl"):
            (self.proj / name).unlink()
        shutil.rmtree(self.proj / "one")
        after, _ = self.build()
        self.assertEqual(self.by(after["skills"])["brain"], before)
        self.assertEqual(self.by(after["agents"])["Explore"]["tokens"], 1200)
        self.assertTrue((self.data / "usage-daily.json").exists())

    def test_no_message_text_or_settings_are_kept(self):
        u, s = self.build()
        kept = json.dumps([u, s]) + "".join(p.read_text(encoding="utf-8") for p in self.data.glob("*.json"))
        for marker in ("TEXT-MARKER", "SECRET-VALUE", "SECRET-EMAIL", "REFRESH FULL"):
            self.assertNotIn(marker, kept)


class Scorecard(Fixture):
    def test_bands_and_sources(self):
        _, s = self.build()
        skills, conns = self.by(s["skills"]), self.by(s["connectors"])
        self.assertEqual(skills["unused"]["band"], "never used")          # installed, no call on record
        self.assertEqual(skills["sp:plan"]["band"], "never used")
        self.assertEqual(skills["sp:plan"]["source"], "plugin sp")
        self.assertEqual(skills["old-skill"]["band"], "under-used")       # on record in .claude.json, none in 30 days
        self.assertEqual(skills["old-skill"]["calls_all"], 4)
        self.assertEqual(skills["brain"]["band"], "normal")
        self.assertEqual(skills["brain"]["calls_all"], 9)                 # the larger of history and .claude.json
        self.assertEqual(skills["brain"]["tokens_per_call"], round(481 / 2))
        self.assertEqual(skills["loop"]["source"], "built-in")
        self.assertEqual(conns["tv"]["band"], "normal")
        self.assertEqual(conns["idle"]["band"], "never used")
        self.assertEqual(conns["abc-123"]["name"], "Mail")
        self.assertEqual(s["off"], [{"pack": "sales", "skills": ["sales:pitch"]}])
        self.assertEqual(s["counts"]["skills"]["never used"], 2)

    def test_skills_in_use_carry_their_description(self):
        _, s = self.build()
        skills = self.by(s["skills"])
        self.assertEqual(skills["brain"]["description"], "Files notes and tasks in the vault.")
        self.assertEqual(skills["loop"]["description"], "")              # built in: no SKILL.md to read
        self.assertNotIn("description", skills["unused"])                # only the skills in use
        self.assertEqual(usage.skill_description(self.home / "skills" / "missing" / "SKILL.md"), "")

    def test_heavy_is_the_top_fifth_by_tokens_per_call(self):
        items = [{"key": str(i), "calls_30d": 1, "calls_all": 1, "tokens_per_call": i * 100} for i in range(1, 11)]
        usage.band_items(items, 0.2)
        self.assertEqual([i["key"] for i in items if i["band"] == "heavy"], ["9", "10"])
        few = [{"key": str(i), "calls_30d": 1, "calls_all": 1, "tokens_per_call": i} for i in range(4)]
        usage.band_items(few, 0.2)
        self.assertTrue(all(i["band"] == "normal" for i in few))          # under five in use: nothing to rank

    def test_hidden_connectors(self):
        write(self.proj / "three.jsonl", [prompt(ts("2026-10-19", "15:00:00"), "x"),
                                          reply(ts("2026-10-19", "15:00:02"), "msg_h", use(1, 1, 1, 0), tool("tu_h", "mcp__ccd_turn__update_plan"))])
        u, s = self.build()
        self.assertNotIn("ccd_turn", self.by(u["connectors"]))
        self.assertNotIn("ccd_turn", self.by(s["connectors"]))

    def test_one_connector_under_two_spellings(self):
        d = "2026-10-19"
        write(self.proj / "four.jsonl", [prompt(ts(d, "16:00:00"), "x"),
                                         reply(ts(d, "16:00:02"), "msg_c1", use(1, 1, 1, 0), tool("tu_c1", "mcp__claude-in-chrome__navigate")),
                                         reply(ts(d, "16:00:04"), "msg_c2", use(1, 1, 1, 0), tool("tu_c2", "mcp__Claude_in_Chrome__navigate")),
                                         reply(ts(d, "16:00:06"), "msg_c3", use(2, 2, 2, 0), tool("tu_c3", "mcp__Claude_in_Chrome__find"),
                                               attributionMcpServer="Claude in Chrome")])
        u, s = self.build()
        rows = [r for r in u["connectors"] if usage.server_key(r["key"]) == "claude_in_chrome"]
        items = [i for i in s["connectors"] if usage.server_key(i["key"]) == "claude_in_chrome"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(items), 1)
        self.assertEqual(rows[0]["calls"], 3)
        self.assertEqual(rows[0]["key"], "Claude_in_Chrome")              # not installed: the spelling used most
        self.assertEqual(items[0]["calls_30d"], 3)
        self.assertEqual(items[0]["band"], "normal")
        # Configured under the other spelling: that spelling names it, and it is still one connector.
        self.cfg["connectorNames"] = {"claude-in-chrome": "Chrome"}
        u, s = self.build()
        items = [i for i in s["connectors"] if usage.server_key(i["key"]) == "claude_in_chrome"]
        self.assertEqual([(i["key"], i["name"], i["calls_30d"]) for i in items], [("claude-in-chrome", "Chrome", 3)])
        self.assertEqual(self.by(u["connectors"])["claude-in-chrome"]["calls"], 3)
        self.assertEqual(usage.server_key("Some-Server"), usage.server_key("some_server"))
        self.assertNotEqual(usage.server_key("tv"), usage.server_key("tv2"))


class InSnapshot(Fixture):
    def test_snapshot_has_usage_and_the_director_does_not(self):
        demo = ROOT / "examples" / "demo-vault"
        snap = snapshot.build(demo, {}, now=NOW, owner_key="me", skills_dirs=[self.home / "skills"], usage_cfg=self.cfg)
        self.assertEqual(snap["usage"]["skills"][0]["key"], "brain")
        self.assertIn("counts", snap["scorecard"])
        view = snapshot.director_view(snap)
        self.assertNotIn("usage", view)
        self.assertNotIn("scorecard", view)
        self.assertEqual(snap["hash"], snapshot.build(demo, {}, now=NOW, owner_key="me")["hash"])  # usage never wakes the director

    def test_without_a_usage_config_the_keys_are_empty(self):
        snap = snapshot.build(ROOT / "examples" / "demo-vault", {}, now=NOW, owner_key="me")
        self.assertIsNone(snap["usage"])
        self.assertIsNone(snap["scorecard"])


if __name__ == "__main__":
    unittest.main()
