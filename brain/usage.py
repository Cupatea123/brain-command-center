"""Claude Code usage for the Command Center: which skills, connectors and sub-agents get used.

Reads the session transcripts Claude Code keeps (<claude home>/projects/**/*.jsonl, the `subagents/`
folders included) and turns them into per-day totals of calls, tokens and time for every skill,
connector (MCP server) and sub-agent type. A scorecard then marks each installed skill and
connector as never used, under-used, normal or heavy.

Only names, counts, tokens and times are kept. Message text is never stored or printed: a prompt
is looked at once, in memory, to tell the Command Center director's own sessions apart.

Files written to the data folder:
  usage-cache.json  one entry per transcript, keyed by path, reused while size and mtime match
  usage-daily.json  the per-day totals; kept after Claude Code deletes old transcripts

No third-party packages.
"""
from __future__ import annotations

import datetime as dt
import fnmatch
import json
import math
import re
import time
from pathlib import Path

CACHE_VERSION = 1
GAP_CAP_MS = 10 * 60 * 1000  # a longer pause between two records is waiting (a permission prompt), not work
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
DIRECTOR_PROMPTS = ("REFRESH FULL ", "REFRESH CHANGES ", "DAYEND ", "PROMPT\n")  # what server.mjs sends the director
KINDS = {"s": "skills", "m": "connectors", "a": "agents"}
BANDS = ("heavy", "normal", "under-used", "never used")

DEFAULTS = {
    "claudeHome": str(Path.home() / ".claude"),
    "claudeJson": str(Path.home() / ".claude.json"),
    "dataDir": "",
    "excludeRoots": [],                        # transcripts of sessions run under these folders are skipped
    "excludeTitles": ["Command Center Director"],
    "connectorNames": {},                      # {"<server key>": "label"}; also lists connectors to score
    "hideConnectors": ["ccd_*"],               # the desktop app's own plumbing
    "windowDays": 30,
    "heavyShare": 0.2,
    "syncedSkillsPrefix": "anthropic-skills",  # how Claude Code names the skills in skills/synced
}


# ---------------------------------------------------------------- small helpers

def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj) -> None:
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def to_ms(ts) -> int | None:
    try:
        return int(dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def local(ms: int) -> dt.datetime:
    return dt.datetime.fromtimestamp(ms / 1000)


def norm_path(p) -> str:
    return str(p or "").replace("/", "\\").rstrip("\\").lower()


def under(path, roots) -> bool:
    p = norm_path(path)
    return bool(p) and any(p == r or p.startswith(r + "\\") for r in roots)


def munge(path) -> str:
    """The folder name Claude Code gives a project: every character that is not a letter or digit becomes `-`."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path).rstrip("\\/"))


def norm_server(name) -> str:
    """`Claude Browser` in an attribution field and `Claude_Browser` in a tool name are the same server."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(name or ""))


def server_key(name) -> str:
    """What two spellings of one server have in common: `claude-in-chrome` in a config and
    `Claude_in_Chrome` in a tool name differ only in case and in `-` against `_`."""
    return norm_server(name).lower().replace("-", "_")


def add_totals(target: dict, vals: dict) -> None:
    for k, v in vals.items():
        target[k] = max(target.get(k, 0), v) if k == "last" else target.get(k, 0) + v


def short(skill: str) -> str:
    return skill.rsplit(":", 1)[-1]


def subdirs(folder: Path) -> list[Path]:
    try:
        return sorted(p for p in folder.iterdir() if p.is_dir())
    except OSError:
        return []


def prompt_head(content) -> str:
    if isinstance(content, str):
        return content[:40]
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                return str(b.get("text", ""))[:40]
    return ""


# ---------------------------------------------------------------- one transcript

def parse_transcript(path: Path, exclude_roots=(), exclude_titles=(), is_agent: bool = False) -> dict:
    """One transcript as rows (one per API response) and calls (one per skill or connector call).

    A response is written as several records that share `message.id`, each repeating the usage, so
    rows are keyed by that id and every usage field keeps its largest value: counted once.
      row:  [message id, ms, input, output, cache write, cache read, skill, connector, skill ms]
      call: [id, ms, kind (s skill, m connector), name, ms]
    """
    rows: dict[str, list] = {}
    calls: list[list] = []
    pending: dict[str, list] = {}
    titles: set[str] = set()
    agent_types: dict[str, int] = {}
    first_prompt = None
    prev = first = None
    cur_skill, cur_mid, turn_skills = "", None, set()
    active = 0
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return {"excluded": "unreadable"}
    with fh:
        for line in fh:
            if '"assistant"' not in line and '"user"' not in line and "custom-title" not in line and "agent-name" not in line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not isinstance(r, dict):
                continue
            kind = r.get("type")
            if kind in ("custom-title", "agent-name"):
                titles.add(str(r.get("customTitle") or r.get("agentName") or ""))
                continue
            if kind not in ("assistant", "user"):
                continue
            if exclude_roots and under(r.get("cwd"), exclude_roots):
                return {"excluded": "work"}
            ts = to_ms(r.get("timestamp"))
            if ts is None:
                continue
            msg = r.get("message") if isinstance(r.get("message"), dict) else {}
            content = msg.get("content")
            blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
            first = ts if first is None else first
            gap = min(GAP_CAP_MS, max(0, ts - prev)) if prev is not None else 0
            if kind == "user":
                results = [b.get("tool_use_id") for b in blocks if b.get("type") == "tool_result"]
                if results or "toolUseResult" in r:
                    for tid in results:
                        call = pending.pop(tid, None)
                        if call:
                            call[4] = max(0, ts - call[1])
                    if cur_skill and cur_mid in rows:
                        rows[cur_mid][8] += gap
                    active += gap
                elif not (r.get("isMeta") or r.get("sourceToolUseID") or r.get("isCompactSummary")):
                    if first_prompt is None:
                        first_prompt = prompt_head(content)  # compared below, never stored
                    cur_skill, cur_mid, turn_skills = "", None, set()  # a prompt starts a new turn; the wait before it is idle
            elif not (r.get("isApiErrorMessage") or msg.get("model") == "<synthetic>"):
                mid = str(msg.get("id") or r.get("uuid") or "")
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                skill = str(r.get("attributionSkill") or "")
                server = norm_server(r.get("attributionMcpServer"))
                if r.get("attributionAgent"):
                    a = str(r["attributionAgent"])
                    agent_types[a] = agent_types.get(a, 0) + 1
                row = rows.get(mid)
                if row is None:
                    row = rows[mid] = [mid, ts, 0, 0, 0, 0, skill, server, 0]
                for i, key in enumerate(USAGE_KEYS, 2):
                    try:
                        row[i] = max(row[i], int(usage.get(key) or 0))
                    except (TypeError, ValueError):
                        pass
                row[6] = row[6] or skill
                row[7] = row[7] or server
                if skill:
                    row[8] += gap
                active += gap
                cur_skill, cur_mid = skill, mid
                # Attributed with no Skill call this turn: a typed slash command. Not in a sub-agent,
                # which inherits the skill its session was running.
                if skill and not is_agent and short(skill) not in turn_skills:
                    turn_skills.add(short(skill))
                    calls.append([f"turn:{mid}", ts, "s", skill, 0])
                for b in blocks:
                    if b.get("type") != "tool_use":
                        continue
                    name, bid = str(b.get("name") or ""), str(b.get("id") or "")
                    if name == "Skill":
                        sk = str((b.get("input") or {}).get("skill") or "").lstrip("/")
                        if sk:
                            turn_skills.add(short(sk))
                            calls.append([bid, ts, "s", sk, 0])
                    elif name.startswith("mcp__"):
                        parts = name.split("__", 2)
                        if len(parts) == 3 and parts[1]:
                            call = [bid, ts, "m", norm_server(parts[1]), 0]
                            calls.append(call)
                            pending[bid] = call
            prev = ts
    if titles & set(exclude_titles) or (first_prompt or "").startswith(DIRECTOR_PROMPTS):
        return {"excluded": "director"}
    entry = {"excluded": "", "first": first or 0, "rows": list(rows.values()), "calls": calls}
    if is_agent and first:
        meta = load_json(Path(str(path)[:-len(".jsonl")] + ".meta.json"), {})
        kind = str(meta.get("agentType") or "") or (max(agent_types, key=agent_types.get) if agent_types else "unknown")
        entry["agent"] = {"id": path.stem, "type": kind, "ts": first or 0, "ms": active}
    return entry


# ---------------------------------------------------------------- all transcripts, cached per file

def scan(cfg: dict, stats: dict) -> dict[str, dict]:
    root = Path(cfg["claudeHome"]) / "projects"
    cache_path = Path(cfg["dataDir"]) / "usage-cache.json"
    roots = [norm_path(r) for r in cfg["excludeRoots"] if r]
    sig = json.dumps([CACHE_VERSION, sorted(roots), sorted(cfg["excludeTitles"])])
    cache = load_json(cache_path, {})
    old = cache.get("files", {}) if cache.get("sig") == sig else {}
    work_dirs = [munge(r).lower() for r in cfg["excludeRoots"] if r]
    files: dict[str, dict] = {}
    if root.exists():
        for p in root.rglob("*.jsonl"):
            rel = p.relative_to(root).as_posix()
            project = rel.split("/", 1)[0].lower()
            if any(project == w or project.startswith(w + "-") for w in work_dirs):
                stats["excluded_work"] += 1  # never opened
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            entry = old.get(rel)
            if not entry or entry.get("size") != st.st_size or entry.get("mtime") != st.st_mtime_ns:
                entry = parse_transcript(p, roots, cfg["excludeTitles"], "/subagents/" in rel)
                entry["size"], entry["mtime"] = st.st_size, st.st_mtime_ns
                stats["parsed"] += 1
            files[rel] = entry
    for rel, e in files.items():  # a sub-agent belongs to its session: <project>/<session>/subagents/...
        if not e.get("excluded") and "/subagents/" in rel and files.get(rel.split("/subagents/")[0] + ".jsonl", {}).get("excluded"):
            e["excluded"] = files[rel.split("/subagents/")[0] + ".jsonl"]["excluded"]
    for e in files.values():
        if e.get("excluded") in ("work", "director"):
            stats["excluded_" + e["excluded"]] += 1
    stats["files"] = sum(1 for e in files.values() if not e.get("excluded"))
    if stats["parsed"] or set(files) != set(old):
        write_json(cache_path, {"sig": sig, "files": files})
    return files


def aggregate(files: dict[str, dict]) -> dict:
    """Per local day: {kind: {name: {calls, in, out, cw, cr, ms, last}}}. A forked session copies its
    parent's records, so a message id or call id already counted in an earlier file is skipped."""
    days: dict = {}
    seen_rows, seen_calls = set(), set()

    def cell(ms: int, kind: str, name: str) -> dict:
        day = days.setdefault(local(ms).date().isoformat(), {"skills": {}, "connectors": {}, "agents": {}})
        return day[kind].setdefault(name, {"calls": 0, "in": 0, "out": 0, "cw": 0, "cr": 0, "ms": 0, "last": 0})

    for rel, e in sorted(files.items(), key=lambda kv: (kv[1].get("first") or 0, kv[0])):
        if e.get("excluded"):
            continue
        agent = e.get("agent")
        for mid, ts, tin, tout, cw, cr, skill, server, skill_ms in e.get("rows", []):
            if mid in seen_rows:
                continue
            seen_rows.add(mid)
            for kind, name in (("skills", skill), ("connectors", server), ("agents", agent["type"] if agent else "")):
                if name:
                    c = cell(ts, kind, name)
                    c["in"] += tin
                    c["out"] += tout
                    c["cw"] += cw
                    c["cr"] += cr
            if skill:
                cell(ts, "skills", skill)["ms"] += skill_ms
        for cid, ts, kind, name, ms in e.get("calls", []):
            if cid in seen_calls:
                continue
            seen_calls.add(cid)
            c = cell(ts, KINDS[kind], name)
            c["calls"] += 1
            c["ms"] += ms
            c["last"] = max(c["last"], ts)
        if agent and agent["id"] not in seen_calls:
            seen_calls.add(agent["id"])
            c = cell(agent["ts"], "agents", agent["type"])
            c["calls"] += 1
            c["ms"] += agent["ms"]
            c["last"] = max(c["last"], agent["ts"])
    return days


def merge_daily(path: Path, computed: dict) -> dict:
    """Keep the largest value ever seen for each day, name and measure. Transcripts only grow until
    Claude Code deletes them, so the largest value is the day's real total and it outlives the file."""
    stored = load_json(path, {}).get("days", {})
    changed = False
    for day, kinds in computed.items():
        for kind, names in kinds.items():
            for name, vals in names.items():
                cur = stored.setdefault(day, {}).setdefault(kind, {}).setdefault(name, {})
                for k, v in vals.items():
                    if v > cur.get(k, -1):
                        cur[k] = v
                        changed = True
    if changed:
        write_json(path, {"version": 1, "days": stored})
    return stored


def totals(days: dict, since: str = "") -> dict:
    out: dict = {"skills": {}, "connectors": {}, "agents": {}}
    for day, kinds in days.items():
        if day < since:
            continue
        for kind, names in kinds.items():
            for name, vals in names.items():
                t = out[kind].setdefault(name, {"calls": 0, "in": 0, "out": 0, "cw": 0, "cr": 0, "ms": 0, "last": 0})
                for k, v in vals.items():
                    t[k] = max(t[k], v) if k == "last" else t[k] + v
    return out


# ---------------------------------------------------------------- what is installed

def skill_description(path) -> str:
    """The `description:` of a SKILL.md, from its frontmatter: one line, a quoted string or a folded block."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = fh.read(8000)
    except (OSError, TypeError):
        return ""
    if not head.startswith("---"):
        return ""
    lines = head[3:].split("\n---", 1)[0].splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("description:"):
            continue
        parts = [line[len("description:"):].strip()]
        if parts[0] in ("", ">", "|", ">-", "|-", ">+", "|+"):
            parts = []
        for more in lines[i + 1:]:
            if more.strip() and not more.startswith((" ", "\t")):
                break
            parts.append(more.strip())
        text = re.sub(r"\s+", " ", " ".join(parts)).strip()
        if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
            text = text[1:-1]
        return text[:400]
    return ""


def inventory(cfg: dict, skills_dirs) -> dict:
    """Skills and connectors on this machine. `off` holds skills of packs that are switched off;
    `where` is each skill's SKILL.md and `descriptions` what a manifest already says about it."""
    home = Path(cfg["claudeHome"])
    on: dict[str, str] = {}
    off: dict[str, list[str]] = {}
    where: dict[str, Path] = {}
    descriptions: dict[str, str] = {}
    connectors: dict[str, str] = {}
    enabled = load_json(home / "settings.json", {}).get("enabledPlugins") or {}

    for d in skills_dirs or []:
        for p in sorted(Path(d).glob("*/SKILL.md")):
            if not p.parent.name.startswith("_"):
                on.setdefault(p.parent.name, "personal")
                where.setdefault(p.parent.name, p)
    prefix = cfg["syncedSkillsPrefix"]
    for pack in subdirs(home / "skills" / "synced"):
        listed = {s.get("name"): s for s in load_json(pack / "manifest.json", {}).get("skills", []) if isinstance(s, dict)}
        for name in listed or [p.parent.name for p in pack.glob("*/SKILL.md")]:
            if name:
                full = f"{prefix}:{name}" if prefix else name
                on.setdefault(full, "synced")
                where.setdefault(full, pack / name / "SKILL.md")
                if listed.get(name, {}).get("description"):
                    descriptions.setdefault(full, re.sub(r"\s+", " ", str(listed[name]["description"])).strip()[:400])

    def pack_skills(folder: Path, pack: str) -> list[str]:
        found = {(pack if p.parent == folder else f"{pack}:{p.parent.name}"): p for p in folder.rglob("SKILL.md")}
        for name, path in found.items():
            where.setdefault(name, path)
        return sorted(found)

    plugins = load_json(home / "plugins" / "installed_plugins.json", {}).get("plugins") or {}
    for key, installs in plugins.items():
        inst = installs[0] if isinstance(installs, list) and installs else installs
        if not isinstance(inst, dict) or not inst.get("installPath"):
            continue
        name, folder = key.split("@")[0], Path(inst["installPath"])
        skills = pack_skills(folder, name)
        if enabled.get(key, True):
            for s in skills:
                on.setdefault(s, f"plugin {name}")
            mcp = load_json(folder / ".mcp.json", {})
            for server in (mcp.get("mcpServers") if isinstance(mcp.get("mcpServers"), dict) else mcp):
                connectors.setdefault(norm_server(f"plugin_{name}_{server}"), f"plugin {name}")
        elif skills:
            off[name] = skills
    for bucket in subdirs(home / "plugins" / "synced"):
        for folder in subdirs(bucket):
            skills = pack_skills(folder, folder.name)
            if enabled.get(f"{folder.name}@synced") is True:
                for s in skills:
                    on.setdefault(s, f"pack {folder.name}")
            elif skills:
                off[folder.name] = skills

    for server in claude_json(cfg)["mcpServers"]:
        connectors.setdefault(norm_server(server), "configured")
    for server in cfg["connectorNames"]:
        connectors.setdefault(norm_server(server), "connector")
    return {"skills": on, "off": off, "connectors": connectors, "where": where, "descriptions": descriptions}


def claude_json(cfg: dict) -> dict:
    """Only `skillUsage` (all-time counts) and the names under `mcpServers` leave this file."""
    raw = load_json(Path(cfg["claudeJson"]), {}) if cfg.get("claudeJson") else {}
    usage = raw.get("skillUsage") if isinstance(raw.get("skillUsage"), dict) else {}
    servers = raw.get("mcpServers") if isinstance(raw.get("mcpServers"), dict) else {}
    return {
        "skillUsage": {str(k): {"calls": int(v.get("usageCount") or 0), "last": int(v.get("lastUsedAt") or 0)}
                       for k, v in usage.items() if isinstance(v, dict)},
        "mcpServers": sorted(str(k) for k in servers),
    }


# ---------------------------------------------------------------- the two snapshot keys

def tokens(t: dict) -> int:
    """New tokens: input, output and cache writes. Cache reads (the conversation so far, re-read on
    every response) are reported apart, because they grow with the session and not with the skill."""
    return t["in"] + t["out"] + t["cw"]


def iso(ms: int) -> str:
    return local(ms).isoformat(timespec="minutes") if ms else ""


def band_items(items: list[dict], heavy_share: float) -> None:
    used = sorted((i for i in items if i["calls_30d"] > 0), key=lambda i: i["tokens_per_call"], reverse=True)
    heavy = {i["key"] for i in used[:math.ceil(len(used) * heavy_share)]} if len(used) >= 5 else set()
    for i in items:
        i["band"] = "never used" if i["calls_all"] == 0 else "under-used" if i["calls_30d"] == 0 else "heavy" if i["key"] in heavy else "normal"


def build_usage(cfg: dict, now: dt.datetime | None = None, skills_dirs=()) -> tuple[dict, dict]:
    t0 = time.perf_counter()
    cfg = {**DEFAULTS, **{k: v for k, v in (cfg or {}).items() if v is not None}}
    now = now or dt.datetime.now()
    window = int(cfg["windowDays"])
    since = (now.date() - dt.timedelta(days=window - 1)).isoformat()
    data = Path(cfg["dataDir"])
    data.mkdir(parents=True, exist_ok=True)
    stats = {"parsed": 0, "files": 0, "excluded_work": 0, "excluded_director": 0}

    days = merge_daily(data / "usage-daily.json", aggregate(scan(cfg, stats)))
    win, ever = totals(days, since), totals(days)
    inv = inventory(cfg, skills_dirs)
    recorded = claude_json(cfg)["skillUsage"]

    # One connector under all its spellings (see server_key). It keeps the spelling it is installed
    # or configured under, else the one used most.
    spelling: dict[str, str] = {}
    for n in inv["connectors"]:
        spelling.setdefault(server_key(n), n)
    for n, _ in sorted(ever["connectors"].items(), key=lambda kv: (-kv[1]["calls"], kv[0])):
        spelling.setdefault(server_key(n), n)
    canon = lambda n: spelling.get(server_key(n), n)  # noqa: E731
    for table in (win["connectors"], ever["connectors"]):
        for n in [n for n in table if canon(n) != n]:
            add_totals(table.setdefault(canon(n), {}), table.pop(n))
    inv["connectors"] = {canon(k): v for k, v in reversed(list(inv["connectors"].items()))}  # the first source wins
    labels = {canon(norm_server(k)): str(v) for k, v in cfg["connectorNames"].items()}
    hidden = [p.lower() for p in cfg["hideConnectors"]]
    shown = lambda key: not any(fnmatch.fnmatch(key.lower(), p) for p in hidden)  # noqa: E731

    # A bare name in a Skill call ("brainstorming") is the namespaced skill when exactly one has it.
    known = set(inv["skills"]) | set(recorded) | {n for n in ever["skills"] if ":" in n}
    by_short: dict[str, list[str]] = {}
    for n in known:
        if ":" in n:
            by_short.setdefault(short(n), []).append(n)
    for table in (win["skills"], ever["skills"]):
        for n in [n for n in table if ":" not in n and n not in inv["skills"] and len(by_short.get(n, [])) == 1]:
            add_totals(table.setdefault(by_short[n][0], {}), table.pop(n))

    def rows(table: dict, label=lambda k: k, keep=lambda k: True) -> list[dict]:
        out = [{"key": k, "name": label(k), "calls": t["calls"], "last": iso(t["last"]), "tokens": tokens(t), "cache_read": t["cr"], "ms": t["ms"]}
               for k, t in table.items() if keep(k) and (t["calls"] or tokens(t))]
        return sorted(out, key=lambda r: (-r["calls"], -r["tokens"], r["name"].lower()))

    usage = {
        "window_days": window, "since": since, "history_from": min(days) if days else "",
        "skills": rows(win["skills"]),
        "connectors": rows(win["connectors"], lambda k: labels.get(k, k), shown),
        "agents": rows(win["agents"]),
        "files": stats["files"], "parsed": stats["parsed"],
        "excluded": {"work": stats["excluded_work"], "director": stats["excluded_director"]},
    }

    def item(key: str, name: str, source: str, kind: str, all_calls: int = 0, all_last: int = 0) -> dict:
        w, e = win[kind].get(key), ever[kind].get(key)
        calls30 = w["calls"] if w else 0
        out = {"key": key, "name": name, "source": source, "calls_30d": calls30,
               "calls_all": max(e["calls"] if e else 0, all_calls), "last": iso(max(e["last"] if e else 0, all_last)),
               "tokens_per_call": round(tokens(w) / calls30) if calls30 else 0}
        if kind == "skills" and calls30:  # what the skill says it is for, for the skills in use
            out["description"] = inv["descriptions"].get(key) or skill_description(inv["where"].get(key))
        return out

    off_pack = {s: f"pack {pack}" for pack, names in inv["off"].items() for s in names}  # used although its pack is off
    skills = [item(k, k, inv["skills"].get(k) or off_pack.get(k, "built-in"), "skills", recorded.get(k, {}).get("calls", 0), recorded.get(k, {}).get("last", 0))
              for k in sorted(set(inv["skills"]) | set(recorded) | {n for n, t in ever["skills"].items() if t["calls"]}, key=str.lower)]
    connectors = [item(k, labels.get(k, k), inv["connectors"].get(k, "seen in sessions"), "connectors")
                  for k in set(inv["connectors"]) | {n for n, t in ever["connectors"].items() if t["calls"]} if shown(k)]
    connectors.sort(key=lambda i: i["name"].lower())
    share = float(cfg["heavyShare"])
    band_items(skills, share)
    band_items(connectors, share)
    on_names = {s["key"] for s in skills}
    off = [{"pack": pack, "skills": [s for s in names if s not in on_names]} for pack, names in sorted(inv["off"].items())]
    off = [p for p in off if p["skills"]]
    scorecard = {
        "window_days": window,
        "skills": skills, "connectors": connectors,
        "counts": {kind: {b: sum(1 for i in items if i["band"] == b) for b in BANDS} for kind, items in (("skills", skills), ("connectors", connectors))},
        "off": off, "off_count": sum(len(p["skills"]) for p in off),
    }
    usage["took_ms"] = round((time.perf_counter() - t0) * 1000)
    return usage, scorecard
