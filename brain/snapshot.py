"""Brain snapshot for the Command Center. Reads only.

Builds one JSON document from an Obsidian vault laid out PARA style (projects, areas, tasks,
decisions, sessions and run logs, all typed by frontmatter), the Windows-task pull written by
routines.ps1, the routine logs and the Claude Code activity log. The page renders it directly and
the director reads a compact copy of it.

  python snapshot.py --vault <dir> --out <snapshot.json> [--routines <routines.json>]
                     [--routines-cfg <cfg>] [--areas-cfg <cfg>] [--skills <dir> ...]
                     [--owner <name>] [--owner-key <key>] [--activity <dir>] [--prev <file>]

No third-party packages: the frontmatter reader below handles the subset vaults use.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent

TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})")
FAIL_RE = re.compile(r"\b(FAIL(ED|URE)?|ERROR|Exception|Traceback|degraded)\b", re.IGNORECASE)
RUNLOG_LINE_RE = re.compile(r"^- (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))? — (.*)$")
TODO_RE = re.compile(r"^- \[( |x)\] (\d{4}-\d{2}-\d{2}) — (.+?)(?: — owner: (.+?))?(?: — done (\d{4}-\d{2}-\d{2}))?\s*$")
HARD_RE = re.compile(r"Hard date (\d{4}-\d{2}-\d{2})")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
LINK_RE = re.compile(r"!?\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|[^\]]*)?\]\]")
LINK_NAME_RE = re.compile(r"\[\[([^\]\|#]+)")
SESSION_NAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?: \d{4})? - (.+)$")
SKIP_DIRS = {".git", ".obsidian", ".trash", "node_modules", "templates", "activity", "import"}

OPEN_TASK = {"ready", "in-progress", "blocked", "review"}
DONE_TASK = {"done", "dropped"}
PRIO = {"p1": 1, "p2": 2, "p3": 3}


# ---------------------------------------------------------------- helpers

def load_json(path: Path | None, default):
    if not path or not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return default


def parse_date(s) -> dt.date | None:
    if not s:
        return None
    m = DATE_RE.search(str(s))
    if not m:
        return None
    try:
        return dt.date.fromisoformat(m.group(0))
    except ValueError:
        return None


def first_link(s) -> str:
    m = LINK_NAME_RE.search(str(s or ""))
    return m.group(1).strip() if m else ""


def strip_md(s) -> str:
    s = re.sub(r"\[\[([^\]\|]+)\|([^\]]+)\]\]", r"\2", str(s or ""))
    s = re.sub(r"\[\[([^\]]+)\]\]", r"\1", s)
    s = s.replace("**", "").replace("`", "")
    return s.strip()


def _split_flow(inner: str) -> list[str]:
    parts, cur, depth, q = [], "", 0, ""
    for ch in inner:
        if q:
            cur += ch
            if ch == q:
                q = ""
        elif ch in "\"'":
            q = ch
            cur += ch
        elif ch in "[":
            depth += 1
            cur += ch
        elif ch == "]":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


def _scalar(v: str):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    if v.startswith("[") and v.endswith("]") and not v.startswith("[["):
        inner = v[1:-1].strip()
        return [_scalar(p) for p in _split_flow(inner) if p.strip()] if inner else []
    if v in ("true", "false"):
        return v == "true"
    return v


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """The YAML subset vault notes use: `key: value`, quoted strings, flow lists and block lists."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    fields: dict = {}
    key = None
    for line in text[3:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")) and line.strip().startswith("- ") and key:
            if not isinstance(fields.get(key), list):
                fields[key] = []
            fields[key].append(_scalar(line.strip()[2:]))
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            key = m.group(1)
            fields[key] = _scalar(m.group(2)) if m.group(2).strip() else ""
    body = text[end + 4:]
    return fields, body.lstrip("\n")


def as_list(v) -> list:
    if isinstance(v, list):
        return v
    return [v] if v else []


class Areas:
    def __init__(self, cfg: dict):
        self.areas = cfg["areas"]

    def of(self, owner: str) -> str:
        owner = owner or ""
        for a in self.areas:
            for pat in a["match"]:
                if pat == "*" or (pat.endswith("*") and owner.startswith(pat[:-1])) or owner == pat:
                    return a["key"]
        return self.areas[-1]["key"]


def owner_of(n: dict) -> str:
    """The project or area a note belongs to: its folder, else its `project`/`projects` link."""
    parts = n["rel"].parts
    if parts[0] in ("1-Projects", "2-Areas", "4-Archive") and len(parts) > 2:
        return parts[1]
    f = n["fields"]
    for k in ("project", "projects"):
        for v in as_list(f.get(k)):
            name = first_link(v) or strip_md(v)
            if name:
                return name
    return ""


# ---------------------------------------------------------------- vault notes

def iter_notes(vault: Path):
    stack = [vault]
    while stack:
        d = stack.pop()
        try:
            entries = list(d.iterdir())
        except OSError:
            continue
        for p in entries:
            if p.is_dir():
                if p.name not in SKIP_DIRS and not p.name.startswith("."):
                    stack.append(p)
            elif p.suffix.lower() == ".md":
                yield p


def read_notes(vault: Path) -> list[dict]:
    notes = []
    for p in iter_notes(vault):
        rel = p.relative_to(vault)
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        fields, body = parse_frontmatter(text)
        st = p.stat()
        notes.append({
            "path": p, "rel": rel, "stem": p.stem, "fields": fields, "body": body,
            "links": [m.group(1).strip() for m in LINK_RE.finditer(body)], "mtime": st.st_mtime, "size": st.st_size,
        })
    return notes


def is_hq(n: dict) -> bool:
    return n["rel"].parts[0] in ("1-Projects", "2-Areas") and n["stem"] == n["path"].parent.name


def section(body: str, name: str) -> list[str]:
    out, on = [], False
    for line in body.splitlines():
        if line.startswith("## "):
            on = line[3:].strip().lower() == name.lower()
            continue
        if on:
            out.append(line)
    return out


def note_summary(n: dict) -> str:
    f = n["fields"]
    if f.get("summary"):
        return strip_md(f["summary"])[:400]
    for name in ("Did", "Result", "Decision", "Goal", "Status now", "Request"):
        for line in section(n["body"], name):
            s = line.strip().lstrip(">").strip()
            if s.startswith("- "):
                s = s[2:]
            if s and not s.startswith(("(", "|", "!")):
                return strip_md(re.sub(r"^\d{4}-\d{2}-\d{2}\s*[—-]\s*", "", s))[:400]
    return ""


def parse_todo(text: str) -> tuple[list[dict], list[dict]]:
    open_items, done_items = [], []
    cur = None
    for line in text.splitlines():
        m = TODO_RE.match(line)
        if m:
            owner_part = m.group(4) or ""
            task = ""
            if "→" in owner_part:
                owner_part, task_part = owner_part.split("→", 1)
                task = first_link(task_part)
            item = {"date": m.group(2), "request": strip_md(m.group(3)), "owner": strip_md(owner_part),
                    "owner_link": first_link(owner_part), "task": task, "brief": "", "done": m.group(5) or ""}
            (done_items if m.group(1) == "x" else open_items).append(item)
            cur = item
        elif cur and line.strip().startswith("- Brief:"):
            cur["brief"] = strip_md(line.strip()[8:])[:400]
    return open_items, done_items


def parse_runlog(body: str) -> list[dict]:
    runs = []
    for line in body.splitlines():
        m = RUNLOG_LINE_RE.match(line)
        if m:
            runs.append({"date": m.group(1), "time": m.group(2) or "", "text": strip_md(m.group(3))[:220],
                         "ok": not FAIL_RE.search(m.group(3))})
    runs.sort(key=lambda r: (r["date"], r["time"]))
    return runs


# ---------------------------------------------------------------- routines

def log_runs(paths: list[str], gap_seconds: int, since: dt.date) -> list[dict]:
    """Group timestamped log lines into runs: a gap over gap_seconds starts a new run."""
    stamps: list[tuple[dt.datetime, bool]] = []
    for ps in paths:
        p = Path(ps)
        if not p.exists():
            continue
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines[-20000:]:
            m = TS_RE.match(line)
            if not m:
                continue
            try:
                t = dt.datetime.fromisoformat(f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}")
            except ValueError:
                continue
            if t.date() >= since:
                stamps.append((t, bool(FAIL_RE.search(line))))
    stamps.sort()
    runs: list[dict] = []
    for t, failed in stamps:
        if runs and (t - runs[-1]["_last"]).total_seconds() <= gap_seconds:
            runs[-1]["_last"] = t
            runs[-1]["ok"] = runs[-1]["ok"] and not failed
        else:
            runs.append({"start": t, "_last": t, "ok": not failed})
    return [{"at": r["start"].isoformat(timespec="minutes"), "date": r["start"].date().isoformat(), "ok": r["ok"]} for r in runs]


def _cron_field(field: str, value: int) -> bool:
    if field == "*":
        return True
    for part in field.split(","):
        if "-" in part:
            a, _, b = part.partition("-")
            if a.isdigit() and b.isdigit() and int(a) <= value <= int(b):
                return True
        elif part.isdigit() and int(part) == value:
            return True
    return False


def cron_on(cron: str, day: dt.datetime) -> dt.datetime | None:
    """Supports `m h dom mon dow` with numbers, lists, ranges and `*`. Returns that day's fire time or None."""
    try:
        m, h, dom, mon, dow = cron.split()
    except ValueError:
        return None
    cron_dow = (day.weekday() + 1) % 7  # cron: 0 = Sunday
    if not (_cron_field(dom, day.day) and _cron_field(mon, day.month) and (_cron_field(dow, cron_dow) or (cron_dow == 0 and _cron_field(dow, 7)))):
        return None
    if not (m.isdigit() and h.isdigit()):
        return None
    return day.replace(hour=int(h), minute=int(m), second=0, microsecond=0)


SCHED_OK = (0, 267009, 267011, None)  # success, running, never run


def build_routines(cfg: dict, win: dict, runlogs: dict[str, list[dict]], now: dt.datetime, sched: dict | None = None) -> list[dict]:
    today = now.date()
    since = today - dt.timedelta(days=60)
    gap = int(cfg.get("gap_seconds", 150))
    win_by_task = {t["task"]: t for t in (win.get("tasks") or [])}
    out = []
    for w in cfg.get("windows", []):
        info = win_by_task.get(w["task"], {})
        runs = log_runs([w["log"]] + list(w.get("extra_logs", [])), gap, since) if w.get("log") else []
        last_dt = dt.datetime.fromisoformat(info["lastRun"]) if info.get("lastRun") else None
        next_dt = dt.datetime.fromisoformat(info["nextRun"]) if info.get("nextRun") else None
        result = info.get("lastResult")
        if not runs and last_dt:  # no log of its own: the scheduler's last run stands in
            runs = [{"at": last_dt.isoformat(timespec="minutes"), "date": last_dt.date().isoformat(), "ok": result in SCHED_OK}]
        today_runs = [r for r in runs if r["date"] == today.isoformat()]
        state = info.get("state") or "unknown"
        if state == "Disabled":
            st = "DISABLED"
        elif state == "missing":
            st = "MISSING"
        elif last_dt and last_dt.date() >= today - dt.timedelta(days=1) and result not in SCHED_OK:
            st = "FAILED"
        elif today_runs or (last_dt and last_dt.date() == today):
            st = "FIRED"
        elif next_dt and next_dt.date() == today:
            st = "NEXT"
        else:
            st = "IDLE"
        rep = info.get("repeatMinutes")
        out.append({
            "label": w["label"], "task": w["task"], "host": w.get("host", "PC"), "owner": w.get("owner", ""),
            "schedule": w.get("schedule") or (f"every {rep} min" if rep else "daily"), "state": state, "status": st,
            "last": info.get("lastRun", ""), "last_result": result, "next": info.get("nextRun", ""),
            "time": (last_dt if st == "FIRED" and last_dt else next_dt or last_dt).strftime("%H:%M") if (last_dt or next_dt) else "",
            "scheduled_today": bool(today_runs) or bool(next_dt and next_dt.date() == today) or bool(last_dt and last_dt.date() == today),
            "today_runs": len(today_runs), "runs": runs[-400:],
        })
    for c in cfg.get("claude", []):
        runs = [{"at": r["date"] + "T" + (r["time"] or "00:00"), "date": r["date"], "ok": r["ok"], "text": r["text"]} for r in runlogs.get(c.get("runlog", ""), [])]
        logged = {r["date"] for r in runs}  # the Run Log judges outcomes; the hook log only adds starts it has not filed yet
        runs = sorted(runs + [r for r in (sched or {}).get(c["task"], []) if r["date"] not in logged], key=lambda r: r["at"])
        fire = cron_on(c["cron"], now)
        fired_today = any(r["date"] == today.isoformat() for r in runs)
        if fired_today:
            st = "FIRED"
        elif fire and fire > now:
            st = "NEXT"
        elif fire and c.get("runlog") and now - fire > dt.timedelta(hours=2):
            st = "MISSED"
        elif fire:
            st = "DUE"
        else:
            st = "IDLE"
        out.append({
            "label": c["label"], "task": c["task"], "host": "CLAUDE", "owner": c.get("owner", ""),
            "schedule": c["cron"], "state": "Ready", "status": st, "last": runs[-1]["at"] if runs else "",
            "last_result": None, "next": "", "time": fire.strftime("%H:%M") if fire else "",
            "scheduled_today": bool(fire), "today_runs": sum(1 for r in runs if r["date"] == today.isoformat()), "runs": runs[-200:],
        })
    return out


# ---------------------------------------------------------------- tasks, needs and the day

def task_view(n: dict) -> dict:
    f = n["fields"]
    m = re.match(r"^(T-\d+)", n["stem"])
    return {
        "id": m.group(1) if m else n["stem"], "name": n["stem"], "title": re.sub(r"^T-\d+ - ", "", n["stem"]),
        "status": f.get("status", ""), "owner": str(f.get("owner", "")), "priority": f.get("priority", ""),
        "approval": f.get("approval", ""), "project": first_link(f.get("project")) or strip_md(f.get("project", "")),
        "blocked_on": strip_md(f.get("blocked_on", "")), "blocked_by": [first_link(b) or strip_md(b) for b in as_list(f.get("blocked_by"))],
        "due": str(f.get("due", "") or ""), "created": str(f.get("created", "")), "updated": str(f.get("updated", "")),
        "rel": str(n["rel"]).replace("\\", "/"),
    }


def claude_next(tasks: list[dict]) -> list[dict]:
    by_id = {t["id"]: t for t in tasks}
    ready = []
    for t in tasks:
        if t["owner"] != "claude" or t["status"] != "ready" or t["approval"] not in ("", "none"):
            continue
        if any((by_id.get(b[:5]) or {}).get("status") not in (None, "done") for b in t["blocked_by"]):
            continue
        ready.append(t)
    ready.sort(key=lambda t: (PRIO.get(t["priority"], 9), t["created"], t["name"]))
    return ready


def build_needs(tasks, decisions, todo_open, inbox, routines, deadlines, hq_age, owner_key, today) -> list[dict]:
    needs = []

    def age(s):
        d = parse_date(s)
        return (today - d).days if d else None

    for t in sorted(tasks, key=lambda t: (PRIO.get(t["priority"], 9), t["name"])):
        if t["status"] not in OPEN_TASK:
            continue
        if t["owner"].lower() == owner_key:
            needs.append({"key": f"task|{t['id']}", "title": t["title"], "detail": t["blocked_on"] or f"{t['id']} · yours to do · {t['project']}",
                          "tag": "task", "age_days": age(t["created"]), "owner": t["project"], "prio": PRIO.get(t["priority"], 9)})
        elif t["approval"] == "required":
            needs.append({"key": f"go|{t['id']}", "title": t["title"], "detail": f"{t['id']} · needs your go · {t['project']}",
                          "tag": "decision", "age_days": age(t["created"]), "owner": t["project"], "prio": 0})
        elif t["status"] == "blocked":
            needs.append({"key": f"blocked|{t['id']}", "title": t["title"], "detail": f"{t['id']} · blocked: {t['blocked_on'] or 'no reason given'}",
                          "tag": "task", "age_days": age(t["updated"]), "owner": t["project"], "prio": PRIO.get(t["priority"], 9)})
        elif t["status"] == "in-progress" and (parse_date(t["updated"]) or today) < today - dt.timedelta(days=1):
            needs.append({"key": f"stale|{t['id']}", "title": f"Resume or close {t['id']}", "detail": f"{t['title']} · in progress since {t['updated']}",
                          "tag": "system", "age_days": age(t["updated"]), "owner": t["project"], "prio": 5})
    for d in decisions:
        needs.append({"key": f"decision|{d['name']}", "title": d["name"], "detail": d["summary"] or "proposed, not accepted",
                      "tag": "decision", "age_days": age(d["created"]), "owner": d["owner"], "prio": 0})
    for t in todo_open:
        if not t["task"]:
            needs.append({"key": f"todo|{t['date']}|{t['request'][:40]}", "title": t["request"][:90], "detail": "TODO line without a task yet",
                          "tag": "todo", "age_days": age(t["date"]), "owner": t["owner_link"], "prio": 4})
    for n in inbox:
        needs.append({"key": f"inbox|{n['name']}", "title": f"Triage: {n['name']}", "detail": "new in 0-Inbox", "tag": "todo",
                      "age_days": age(n["created"]), "owner": "", "prio": 6})
    for r in routines:
        last = r["runs"][-1] if r["runs"] else None
        if r["status"] in ("FAILED", "MISSED"):
            needs.append({"key": f"routine|{r['label']}", "title": f"{r['label']}: {r['status'].lower()}", "detail": f"{r['task']} ({r['schedule']}).",
                          "tag": "routine", "age_days": None, "owner": r["owner"], "prio": 3})
        elif last and last["date"] == today.isoformat() and not last["ok"]:
            needs.append({"key": f"routine|{r['label']}", "title": f"{r['label']}: last run failed", "detail": f"{r['task']}, last run {last['at'][11:16]} logged a failure.",
                          "tag": "routine", "age_days": None, "owner": r["owner"], "prio": 3})
    for dl in deadlines:
        if dl["days"] <= 3:
            needs.append({"key": f"deadline|{dl['date']}|{dl['label'][:40]}", "title": dl["label"][:90], "detail": f"due {dl['date']} (in {dl['days']} d)",
                          "tag": "deadline", "age_days": None, "owner": dl["owner"], "prio": 0})
    if hq_age is not None and hq_age > 14:
        needs.append({"key": "hq-stale", "title": "HQ is stale", "detail": f"HQ.md last regenerated {hq_age} days ago.", "tag": "system", "age_days": hq_age, "owner": "", "prio": 7})
    needs.sort(key=lambda n: (n["prio"], -(n["age_days"] or 0)))
    for n in needs:
        n.pop("prio", None)
    return needs


def day_shape(needs: list[dict]) -> str:
    """Heavy, normal or open, from how much is waiting on the owner (there is no calendar here)."""
    pressing = [n for n in needs if n["tag"] in ("decision", "deadline", "routine") or (n["tag"] == "task" and (n["age_days"] or 0) <= 14)]
    if len(pressing) >= 8 or any(n["tag"] == "deadline" for n in needs):
        return "heavy"
    if len(pressing) <= 2:
        return "open"
    return "normal"


PIPELINE_PROMPT = ("<scheduled-task", "REFRESH ", "PROMPT\n", "DAYEND ", "/compact")
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
SCHED_PROMPT_RE = re.compile(r'^<scheduled-task name="([^"]+)"')


def read_activity(activity_dir: Path | None, since: dt.date):
    """Events from the hook logs (<UTC date>.jsonl, one JSON object per line) with a local timestamp."""
    if not activity_dir or not activity_dir.exists():
        return
    for p in sorted(activity_dir.glob("*.jsonl")):
        if p.stem < since.isoformat():
            continue
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                ev = json.loads(line)
                ev["_local"] = dt.datetime.fromisoformat(ev["ts"].replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
            yield ev


def scheduled_runs(activity_dir: Path | None, since: dt.date) -> dict[str, list[dict]]:
    """When each Claude scheduled task actually started, from its first prompt in the hook logs."""
    out: dict[str, list[dict]] = {}
    for ev in read_activity(activity_dir, since):
        if ev.get("event") == "prompt":
            m = SCHED_PROMPT_RE.match(str(ev.get("text", "")))
            if m:
                t = ev["_local"]
                out.setdefault(m.group(1), []).append({"at": t.isoformat(timespec="minutes"), "date": t.date().isoformat(), "ok": True, "text": "started"})
    return out


def activity_today(activity_dir: Path | None, today: dt.date, vault: Path) -> dict:
    """Prompts and file writes recorded by the vault's hooks today (local dates), if the vault has them."""
    out = {"prompts": [], "writes": [], "sessions": 0}
    sessions = set()
    for ev in read_activity(activity_dir, today - dt.timedelta(days=1)):  # files are named by UTC date
        local = ev["_local"]
        if local.date() == today:
            kind = ev.get("event")
            if kind == "prompt":
                text = str(ev.get("text", ""))
                if text.startswith(PIPELINE_PROMPT):
                    continue
                sessions.add(ev.get("session_id"))
                out["prompts"].append({"time": local.strftime("%H:%M"), "text": re.sub(r"\s+", " ", text)[:200], "project": ev.get("project", "")})
            elif kind == "tool" and ev.get("tool") in WRITE_TOOLS:
                fp = str(ev.get("target") or ev.get("file_path") or "")
                if fp:
                    try:
                        fp = str(Path(fp).resolve().relative_to(vault.resolve())).replace("\\", "/")
                    except (ValueError, OSError):
                        pass
                    out["writes"].append(fp)
    out["writes"] = sorted(set(out["writes"]))[:80]
    out["sessions"] = len(sessions)
    return out


def change_key(view: dict) -> str:
    """Hash of only what the director acts on, so cosmetic vault edits do not cost a director turn."""
    material = {
        "todo": sorted(t["request"] for t in view["todo"]),
        "tasks": sorted(f"{t['id']}|{t['status']}|{t['owner']}|{t['approval']}" for t in view["tasks"]),
        "projects": sorted(f"{p['name']}|{p['status']}|{p['next']}" for p in view["projects"]),
        "sessions": sorted(s["slug"] for s in view["sessions"]),
        "needs": sorted(n["key"] for n in view["needs"]),
        "next14": sorted(f"{e['date']}|{e['time']}|{e['label']}" for e in view["next14"]),
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:16]


def diff_views(prev: dict, cur: dict) -> dict:
    """What changed since the director last looked, section by section (added / removed / changed)."""
    def keyed(items, key):
        out = {}
        for x in items or []:
            try:
                k = key(x)
            except (KeyError, TypeError):  # an older file without this field
                k = x.get("key") or f"{x.get('tag', '')}|{x.get('title', '')}" if isinstance(x, dict) else str(x)
            out[k] = x
        return out

    specs = {
        "todo": (lambda v: v.get("todo", []), lambda x: x["request"], None),
        "tasks": (lambda v: v.get("tasks", []), lambda x: x["id"], ("status", "owner", "approval", "blocked_on")),
        "projects": (lambda v: v.get("projects", []), lambda x: x["name"], ("status", "next", "open")),
        "sessions": (lambda v: v.get("sessions", []), lambda x: x["slug"], None),
        "needs": (lambda v: v.get("needs", []), lambda x: x["key"], None),
        "routines": (lambda v: v.get("routines", []), lambda x: x["label"], ("status", "failed_runs_7d")),
        "next14": (lambda v: v.get("next14", []), lambda x: f"{x['date']} {x['time']} {x['label']}", None),
    }
    out: dict = {}
    for name, (get, key, fields) in specs.items():
        a, b = keyed(get(prev), key), keyed(get(cur), key)
        sec: dict = {}
        added = [b[k] for k in b if k not in a]
        removed = [k for k in a if k not in b]
        changed = []
        if fields:
            for k in b:
                if k in a:
                    diffs = {f: [a[k].get(f), b[k].get(f)] for f in fields if a[k].get(f) != b[k].get(f)}
                    if diffs:
                        changed.append({"key": k, "changes": diffs})
        if name == "sessions":  # the view keeps the latest 15, so older ones falling off is not news
            removed = []
        if name == "routines":  # only alerts and recoveries matter, not FIRED/NEXT churn
            changed = [c for c in changed if any(s in ("FAILED", "MISSED") for s in c["changes"].get("status", [])) or "failed_runs_7d" in c["changes"]]
            added = []
        if added:
            sec["added"] = added
        if removed:
            sec["removed"] = removed
        if changed:
            sec["changed"] = changed
        if sec:
            out[name] = sec
    return out


# ---------------------------------------------------------------- graph

def build_graph(notes: list[dict], areas: Areas, routines: list[dict], apps: list[dict], skills: list[str]) -> dict:
    nodes: dict[str, dict] = {}
    links: list[dict] = []
    stems = {n["stem"] for n in notes}

    def add(node: dict):
        nodes.setdefault(node["id"], node)

    center = "START" if "START" in stems else "HQ" if "HQ" in stems else "BRAIN"
    add({"id": center, "label": center, "type": "center", "area": areas.areas[-1]["key"], "ring": "center", "size": 14})
    for n in notes:
        f = n["fields"]
        kind = f.get("type", "note")
        owner = owner_of(n)
        hq = is_hq(n)
        size = 9 if hq else 6 if kind in ("project", "area", "hq", "todo", "protocol") else 4 if kind in ("resource", "ops", "decision", "runlog", "task") else 3
        date = str(f.get("date") or f.get("updated") or f.get("created") or "")
        add({
            "id": n["stem"], "label": n["stem"], "type": "file", "kind": kind, "area": areas.of(n["stem"] if hq else owner), "owner": owner,
            "ring": "memory", "size": size, "status": f.get("status", ""), "date": date[:10],
            "mtime": dt.datetime.fromtimestamp(n["mtime"]).isoformat(timespec="minutes"),
            "summary": note_summary(n)[:300], "rel": str(n["rel"]).replace("\\", "/"), "hq": hq,
        })
    for n in notes:
        for target in set(n["links"]):
            if target in stems and target != n["stem"]:
                links.append({"source": n["stem"], "target": target, "kind": "wikilink"})
        owner = owner_of(n)
        if n["fields"].get("type") in ("session", "task", "runlog") and owner in stems and owner != n["stem"]:
            links.append({"source": n["stem"], "target": owner, "kind": "owner"})
    for key in ("HQ", "TODO", "START", "Waiting-On"):
        if key in stems and key != center:
            links.append({"source": center, "target": key, "kind": "core"})

    hub = next((s for s in ("AI OS", "Claude Code Setup") if s in stems), center)
    for s in skills:
        add({"id": f"skill:{s}", "label": s, "type": "skill", "area": areas.of(hub), "ring": "skills", "size": 5})
        links.append({"source": f"skill:{s}", "target": hub, "kind": "skill"})

    for r in routines:
        rid = f"routine:{r['label']}"
        add({"id": rid, "label": r["label"], "type": "routine", "area": areas.of(r["owner"]), "ring": "routines",
             "size": 6, "status": r["status"], "host": r["host"], "owner": r["owner"]})
        if r["owner"] in stems:
            links.append({"source": rid, "target": r["owner"], "kind": "routine"})
        by_day = Counter(x["date"] for x in r["runs"])
        for d in sorted(by_day)[-14:]:
            fails = sum(1 for x in r["runs"] if x["date"] == d and not x["ok"])
            run_id = f"run:{r['label']}:{d}"
            add({"id": run_id, "label": f"{r['label']} · {d} · {by_day[d]} run(s)" + (f", {fails} with a failure" if fails else ""),
                 "type": "run", "area": areas.of(r["owner"]), "ring": "runs", "size": 2, "date": d,
                 "ok": fails == 0, "fails": fails, "count": by_day[d], "routine": rid})
            links.append({"source": run_id, "target": rid, "kind": "run"})

    for a in apps:
        add({"id": f"app:{a['key']}", "label": a["label"], "type": "app", "area": areas.areas[-1]["key"], "ring": "applications", "size": 7, "icon": a.get("icon", "")})
    patterns = {a["key"]: re.compile(a["match"], re.IGNORECASE) for a in apps if a.get("match")}
    for n in notes:
        if not is_hq(n):
            continue
        for key, rx in patterns.items():
            if rx.search(n["body"]):
                links.append({"source": n["stem"], "target": f"app:{key}", "kind": "app"})

    return {"nodes": list(nodes.values()), "links": links}


# ---------------------------------------------------------------- snapshot

def build(vault: Path, win: dict, now: dt.datetime | None = None, routines_cfg: dict | None = None,
          areas_cfg: dict | None = None, skills_dirs: list[Path] | None = None, owner: str = "", owner_key: str = "",
          activity_dir: Path | None = None) -> dict:
    now = now or dt.datetime.now()
    today = now.date()
    routines_cfg = routines_cfg if routines_cfg is not None else load_json(HERE / "routines.json", {})
    areas_cfg = areas_cfg or load_json(HERE / "areas.json", None) or {"areas": [{"key": "brain", "label": "Brain", "color": "#8E8C84", "match": ["*"]}]}
    owner_key = (owner_key or owner or "me").lower()
    areas = Areas(areas_cfg)
    notes = read_notes(vault)

    todo_path = vault / "TODO.md"
    todo_text = todo_path.read_text(encoding="utf-8") if todo_path.exists() else ""
    todo_open, todo_done = parse_todo(todo_text)

    hq_path = vault / "HQ.md"
    hq_date, hq_age = "", None
    if hq_path.exists():
        hq_text = hq_path.read_text(encoding="utf-8")
        m = re.search(r"^Updated:\s*(\d{4}-\d{2}-\d{2})", hq_text, re.MULTILINE)
        d = parse_date(m.group(1)) if m else parse_date(parse_frontmatter(hq_text)[0].get("updated"))
        if d:
            hq_date, hq_age = d.isoformat(), (today - d).days

    runlogs = {n["stem"]: parse_runlog(n["body"]) for n in notes if n["fields"].get("type") == "runlog"}
    tasks = [task_view(n) for n in notes if n["fields"].get("type") == "task"]
    tasks.sort(key=lambda t: t["id"])
    open_by_owner = Counter(t["project"] for t in tasks if t["status"] not in DONE_TASK)

    # Projects and areas from their HQ notes (the note named like its folder).
    projects = []
    for n in notes:
        f = n["fields"]
        if not is_hq(n):
            continue
        rl = runlogs.get(f"{n['stem']} Run Log") or []
        projects.append({
            "name": n["stem"], "type": f.get("type", ""), "status": f.get("status", ""), "priority": f.get("priority", ""),
            "updated": str(f.get("updated", "")), "cadence": f.get("cadence", ""), "area": areas.of(n["stem"]),
            "blocker": strip_md(f.get("blocked_on", "")), "next": strip_md(f.get("next", "")), "open": open_by_owner.get(n["stem"], 0),
            "last_run": rl[-1]["date"] if rl else "", "due": str(f.get("due", "") or ""), "rel": str(n["rel"]).replace("\\", "/"),
        })
    order = {"blocked": 0, "active": 1, "waiting": 2, "idea": 3, "paused": 4, "done": 5, "archived": 6}
    projects.sort(key=lambda p: (p["type"] != "project", order.get(p["status"], 9), PRIO.get(p["priority"], 9), p["name"]))

    decisions = [{"name": n["stem"], "owner": owner_of(n), "created": str(n["fields"].get("created", "")), "summary": note_summary(n)[:240]}
                 for n in notes if n["fields"].get("type") == "decision" and n["fields"].get("status") == "proposed"]
    inbox = [{"name": n["stem"], "created": str(n["fields"].get("created", ""))} for n in notes
             if n["fields"].get("type") == "inbox" and n["fields"].get("status", "new") == "new"]

    sessions = []
    for n in notes:
        f = n["fields"]
        if f.get("type") not in ("session", "review"):
            continue
        m = SESSION_NAME_RE.match(n["stem"])
        date = str(f.get("date") or (m.group(1) if m else "") or f.get("created", ""))[:10]
        projs = [first_link(p) or strip_md(p) for p in as_list(f.get("projects") or f.get("project"))]
        sessions.append({"slug": n["stem"], "date": date, "projects": [p for p in projs if p] or [f.get("kind") or f.get("type")],
                         "title": m.group(2) if m else n["stem"], "outcome": f.get("outcome", ""),
                         "summary": note_summary(n) or (m.group(2) if m else n["stem"]), "area": areas.of(owner_of(n)),
                         "rel": str(n["rel"]).replace("\\", "/")})
    sessions.sort(key=lambda s: (s["date"], s["slug"]), reverse=True)

    # Heatmap: session notes per ISO week of the current year.
    weeks = Counter()
    for s in sessions:
        d = parse_date(s["date"])
        if d and d.isocalendar()[0] == today.year:
            weeks[d.isocalendar()[1]] += 1
    heatmap = {"year": today.year, "current_week": today.isocalendar()[1], "weeks": {str(k): v for k, v in sorted(weeks.items())}}

    # Deadlines: a `due` date on an open task or owner, or "Hard date YYYY-MM-DD" in an open TODO line.
    deadlines = []
    for t in tasks:
        d = parse_date(t["due"])
        if d and d >= today and t["status"] not in DONE_TASK:
            deadlines.append({"date": d.isoformat(), "days": (d - today).days, "label": f"{t['id']} {t['title']}", "owner": t["project"], "kind": "due"})
    for p in projects:
        d = parse_date(p["due"])
        if d and d >= today and p["status"] not in ("done", "archived"):
            deadlines.append({"date": d.isoformat(), "days": (d - today).days, "label": f"{p['name']} due", "owner": p["name"], "kind": "due"})
    for item in todo_open:
        for hm in HARD_RE.finditer(item["request"] + " " + item["brief"]):
            d = parse_date(hm.group(1))
            if d and d >= today:
                deadlines.append({"date": d.isoformat(), "days": (d - today).days, "label": item["request"][:80], "owner": item["owner_link"], "kind": "hard"})
    deadlines.sort(key=lambda x: x["date"])

    routines = build_routines(routines_cfg, win, runlogs, now, scheduled_runs(activity_dir, today - dt.timedelta(days=60)))

    # The next 14 days: deadlines plus the Claude routines that fire a few times a fortnight (weekly
    # and the like; daily ones would drown the list and already show in ROUTINES).
    horizon = today + dt.timedelta(days=14)
    next14 = [{"date": dl["date"], "time": "", "label": dl["label"], "tag": "deadline", "detail": dl["owner"]}
              for dl in deadlines if parse_date(dl["date"]) <= horizon]
    for c in routines_cfg.get("claude", []):
        fires = [cron_on(c["cron"], now + dt.timedelta(days=i)) for i in range(15)]
        fires = [f for f in fires if f and f >= now]
        if 0 < len(fires) <= 4:
            next14 += [{"date": f.date().isoformat(), "time": f.strftime("%H:%M"), "label": c["label"], "tag": "routine", "detail": c.get("owner", "")} for f in fires]
    next14.sort(key=lambda x: (x["date"], x["time"] or "99"))

    needs = build_needs(tasks, decisions, todo_open, inbox, routines, deadlines, hq_age, owner_key, today)
    sched_today = [r for r in routines if r["scheduled_today"] and r["status"] not in ("DISABLED", "MISSING")]
    fired_today = [r for r in sched_today if r["status"] == "FIRED"]
    queue = claude_next(tasks)

    skills = sorted({p.parent.name for d in (skills_dirs or []) if d.exists() for p in d.glob("*/SKILL.md") if not p.parent.name.startswith("_")})
    graph = build_graph(notes, areas, routines, routines_cfg.get("apps", []), skills)
    area_counts = Counter(n["area"] for n in graph["nodes"] if n["type"] == "file")
    area_list = [{"key": a["key"], "label": a["label"], "color": a["color"], "count": area_counts.get(a["key"], 0)} for a in areas_cfg["areas"]]

    total_runs = sum(len(r["runs"]) for r in routines)
    vault_mtime = max((n["mtime"] for n in notes), default=0)

    snap = {
        "generated": now.isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "owner": owner,
        "vault": str(vault),
        "brain_changed": dt.datetime.fromtimestamp(vault_mtime).isoformat(timespec="minutes") if vault_mtime else "",
        "stats": {"files": sum(1 for n in graph["nodes"] if n["type"] == "file"), "links": len(graph["links"]), "runs": total_runs,
                  "todo_open": len(todo_open), "sessions": len(sessions), "tasks_open": sum(1 for t in tasks if t["status"] not in DONE_TASK),
                  "projects_live": sum(1 for p in projects if p["status"] in ("active", "blocked", "waiting"))},
        "hq": {"updated": hq_date, "age_days": hq_age},
        "projects": projects,
        "todo": todo_open,
        "todo_done_today": [t for t in todo_done if t["done"] == today.isoformat()],
        "tasks": [t for t in tasks if t["status"] not in DONE_TASK],
        "tasks_done_recent": [{"id": t["id"], "title": t["title"], "project": t["project"], "updated": t["updated"]} for t in tasks
                              if t["status"] == "done" and (parse_date(t["updated"]) or dt.date.min) >= today - dt.timedelta(days=7)],
        "claude_next": [{"id": t["id"], "title": t["title"], "project": t["project"], "priority": t["priority"]} for t in queue[:8]],
        "in_progress": [{"id": t["id"], "title": t["title"], "owner": t["owner"], "since": t["updated"]} for t in tasks if t["status"] == "in-progress"],
        "decisions_proposed": decisions,
        "needs": needs,
        "day_shape": day_shape(needs),
        "sessions": sessions[:40],
        "heatmap": heatmap,
        "deadlines": deadlines,
        "next14": next14,
        "routines": routines,
        "routines_today": {"scheduled": len(sched_today), "fired": len(fired_today)},
        "activity_today": activity_today(activity_dir, today, vault),
        "areas": area_list,
        "graph": graph,
    }
    snap["hash"] = change_key(snap)
    return snap


def director_view(snap: dict) -> dict:
    """The compact copy the director reads: no graph, routines without run lists, fewer sessions."""
    today = dt.date.fromisoformat(snap["today"])
    week_ago = (today - dt.timedelta(days=7)).isoformat()
    routines = []
    for r in snap["routines"]:
        recent = [x for x in r["runs"] if x["date"] >= week_ago]
        routines.append({k: r[k] for k in ("label", "task", "host", "owner", "schedule", "status", "time", "last", "last_result", "next", "today_runs")}
                        | {"runs_7d": len(recent), "failed_runs_7d": sum(1 for x in recent if not x["ok"]),
                           "last_failure": next((x["at"] for x in reversed(recent) if not x["ok"]), "")})
    view = {k: v for k, v in snap.items() if k not in ("graph", "routines", "sessions", "areas", "activity_today", "tasks")}
    view["routines"] = routines
    view["sessions"] = [{k: s[k] for k in ("slug", "date", "projects", "outcome", "summary")} for s in snap["sessions"][:15]]
    view["tasks"] = [{k: t[k] for k in ("id", "title", "status", "owner", "priority", "approval", "project", "blocked_on", "due")} for t in snap["tasks"]]
    view["areas"] = [{"key": a["key"], "label": a["label"], "count": a["count"]} for a in snap["areas"]]
    return view


def write_atomic(path: Path, obj) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--routines", help="the Windows-task state written by routines.ps1")
    ap.add_argument("--routines-cfg", default=str(HERE / "routines.json"))
    ap.add_argument("--areas-cfg", default=str(HERE / "areas.json"))
    ap.add_argument("--skills", action="append", default=[], help="a folder of <skill>/SKILL.md; repeatable")
    ap.add_argument("--owner", default="")
    ap.add_argument("--owner-key", default="", help="the task `owner:` value that means you (default: owner, lowercased)")
    ap.add_argument("--activity", help="folder of <date>.jsonl hook logs (prompts and file writes)")
    ap.add_argument("--prev", help="the director-input.json the director last saw; writes director-diff.json")
    a = ap.parse_args(argv)
    snap = build(Path(a.vault), load_json(Path(a.routines) if a.routines else None, {}),
                 routines_cfg=load_json(Path(a.routines_cfg), {}), areas_cfg=load_json(Path(a.areas_cfg), None),
                 skills_dirs=[Path(s) for s in a.skills], owner=a.owner, owner_key=a.owner_key,
                 activity_dir=Path(a.activity) if a.activity else None)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(out, snap)
    dv = director_view(snap)
    write_atomic(out.with_name("director-input.json"), dv)
    if a.prev:
        prev = load_json(Path(a.prev), None)
        diff = diff_views(prev, dv) if prev else None
        write_atomic(out.with_name("director-diff.json"), {"since": (prev or {}).get("generated", ""), "diff": diff})
    s = snap["stats"]
    print(f"snapshot: {s['files']} files, {s['links']} links, {s['runs']} runs, {s['todo_open']} open TODO, {s['tasks_open']} open tasks, "
          f"{s['projects_live']} live owners, {len(snap['needs'])} needs, routines {snap['routines_today']['fired']}/{snap['routines_today']['scheduled']} today, hash {snap['hash']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
