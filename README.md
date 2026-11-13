# Command Center

A local dashboard over your Obsidian second brain, with Claude as its director. One permanent headless Claude session reworks the dashboard each time you open it, answers what you type in the command bar, and summarises the day when you press **Done for today**.

Everything runs on your machine: a Node server on `127.0.0.1`, a Python reader for the vault, and the `claude` CLI you already have. No cloud service, no database, no npm install.

## What you see
- **Today:** clock, the next hard date, a heatmap of session notes per week, the next 14 days.
- **The map:** every note, skill, routine and run as a graph, in six views (rings, circle, areas, links, timeline, 3D orbit). Click a node to read the note or open it in Obsidian.
- **Where I'm at** and **Daily brief:** written by the director.
- **Projects**, **Sessions**, **Resolved**, **TODO**.
- **Needs you:** what is waiting on you, computed in code: your tasks, tasks that need a go, blocked or stalled tasks, proposed decisions, TODO lines without a task, new inbox notes, failed or missed routines, close deadlines. The director adds up to three things the code cannot see.
- **Routines:** Windows scheduled tasks and Claude Code scheduled tasks, with today's status.
- **Agents:** if you run a [OneManCompany](https://github.com/1mancompany/OneManCompany) agent office, every employee with status, current task, room and tokens spent, live. What the office is waiting on you for shows up under **Needs you** with a link into the office.
- **Usage:** every skill, connector and sub-agent type used in the last 30 days, with calls, last used, tokens and time, and a scorecard that marks each installed skill and connector as never used, under-used, normal or heavy.
- **Command bar:** ask the director anything; it reads the vault and can edit notes. After an edit the server runs your vault lint and commits the touched files.

## Requirements
- Windows 10 or 11 (the routines reader uses Task Scheduler; the rest runs anywhere Node and Python do).
- Node 18+, Python 3.10+, PowerShell 7 (`pwsh`), Git.
- The Claude Code CLI, signed in: run `claude auth login` once.
- An Obsidian vault in the layout below.

## Quick start (demo vault)
```powershell
git clone https://github.com/<you>/<this repo> Command-Center
cd Command-Center
node server.mjs
```
Open http://127.0.0.1:4317. With no `local/` folder it reads `examples/demo-vault`, so you can see every panel before pointing it at your own brain.

## Point it at your brain
1. Copy `local.example` to `local` (it is gitignored, so your paths never reach git).
2. Edit `local/config.json`:
   - `owner` (your name) and `ownerKey` (the value of `owner:` on tasks that are yours);
   - `vault` (the vault folder) and `obsidianVault` (its name in Obsidian);
   - `lint` (optional): a command that checks the vault, and a regex its output matches when clean;
   - `vaultGit`: commit and push the notes the director edits;
   - `activityDir` (optional): a folder of `<date>.jsonl` hook logs (`{"ts", "event": "prompt"|"tool", "text", "tool", "target"}`) for the day-end summary and for Claude scheduled-task runs.
3. Edit `local/routines.json` (your scheduled tasks and the apps on the map), `local/areas.json` (colour groups), `local/director.md` (standing facts the director should always know) and `local/settings.json` (extra permission rules, for example `Read` denies on private folders).
4. `pwsh -File Install-Shortcut.ps1` puts a **Command Center** shortcut on the desktop. It starts the server hidden if needed, restarts it when code or `local/` changed, and opens an Edge app window.

## The vault layout it reads
Frontmatter is the source of truth. Everything is optional except `type`.

| Note | Where | Frontmatter it uses |
|---|---|---|
| Project | `1-Projects/<Name>/<Name>.md` | `type: project`, `status` (idea, active, blocked, waiting, paused, done), `priority` (p1–p3), `next`, `due` |
| Area | `2-Areas/<Name>/<Name>.md` | `type: area`, `status`, `cadence`, `next` |
| Run log | `<Name> Run Log.md` in the owner folder | `type: runlog`; lines `- YYYY-MM-DD HH:MM — outcome` |
| Task | anywhere, named `T-### - Title.md` | `type: task`, `status` (backlog, ready, in-progress, blocked, review, done, dropped), `owner` (you or `claude`), `priority`, `approval` (none, required), `project: "[[Owner]]"`, `blocked_on`, `blocked_by`, `due` |
| Decision | `D-### - Title.md` in the owner folder | `type: decision`, `status` (proposed, accepted, superseded) |
| Session | `Sessions/YYYY-MM-DD HHmm - Title.md` | `type: session`, `project` or `projects`, `outcome`; summary from `summary` or the first bullet under `## Did` |
| Inbox | `0-Inbox/` | `type: inbox`, `status: new` |
| TODO | `TODO.md` at the root | lines `- [ ] YYYY-MM-DD — request — owner: [[Owner]] → [[T-### - task]]` under `## Open` |
| HQ | `HQ.md` at the root | a line `Updated: YYYY-MM-DD`; flagged when older than 14 days |

`examples/demo-vault` shows every one of these.

## How a refresh works
1. The page shows the last state at once.
2. The server reads the brain in a couple of seconds, with no Claude call: `brain/routines.ps1` (Task Scheduler, read-only) and `brain/snapshot.py` (the vault, run logs and hook log) write `data/snapshot.json` for the page and `data/director-input.json` for the director.
3. **The change check.** A hash over the facts the director acts on (tasks, TODO, projects, sessions, needs, the next 14 days) decides whether the director runs. Unchanged and refreshed under 30 minutes ago: skipped. **Refresh** forces a run.
4. **The director's turn.** The first refresh of the day compacts the session if it is over 120,000 tokens, then does a full read (Sonnet). Later refreshes send only what changed (Haiku). It returns judgement only: where you're at, focus, extra needs, resolved items, the brief.
5. **Done for today** sends the start-of-day-to-now diff, today's vault commits, ticked TODO lines, finished tasks, today's Claude prompts and file writes, and the day's Command Center prompts.

Rough costs on the Claude plan the CLI is signed into: an unchanged open costs nothing; a changes-only refresh a few cents; the full morning refresh and the day end about $0.30 each.

## Usage and scorecard
`brain/usage.py` reads the session transcripts Claude Code already keeps (`~/.claude/projects/**/*.jsonl`, the `subagents/` folders included). No Claude call, no outside service. It keeps names, counts, tokens and times only, never message text.

**What is counted**

| | Calls | Tokens | Time |
|---|---|---|---|
| Skill | each `Skill` tool call, plus each typed slash command that ran a skill | the responses Claude Code attributes to the skill (`attributionSkill`), its sub-agents' included | how long the skill was driving the session: the gaps between its records, each capped at 10 minutes so a wait on a permission prompt does not count |
| Connector (MCP server) | each `mcp__<server>__<tool>` call | the responses that read the connector's results (`attributionMcpServer`) | from each tool call to its result |
| Sub-agent type | each sub-agent run (one transcript under `subagents/`) | everything the sub-agent spent in its own context | the gaps between its records, capped the same way |

- **Tokens** are new tokens: input, output and cache writes. Cache reads (the conversation so far, re-read on every response) grow with the length of the session, not with the skill, so they are shown apart when you hover a number.
- **Counted once.** Claude Code writes one API response as several records that share `message.id`, each repeating the usage. Rows are keyed by that id, and a forked session's copy of its parent's records is skipped. `tests/test_usage.py` proves both.
- The skill and connector tables overlap (a skill that calls a connector counts in both), so do not add them up.

**The scorecard bands**

| Band | Rule |
|---|---|
| never used | no call on record: none in the kept history and none in `skillUsage` in `~/.claude.json` |
| under-used | on record, but no call in the last 30 days |
| heavy | called in the last 30 days and in the top fifth by tokens per call, skills and connectors ranked apart; needs at least five in use, otherwise nothing is heavy |
| normal | called in the last 30 days, not heavy |

"Installed" means: your skill folders (`skillsDirs`), the skills Claude syncs into `skills/synced`, the skills of enabled plugins, the servers under `mcpServers` in `~/.claude.json`, the servers enabled plugins bring, and the connectors you name in `usage.connectorNames`. Anything that was called also gets a row, whatever its source. Skills of plugin packs that are not enabled in `settings.json` sit in a collapsed **Installed, switched off** list until one is called.

To change the bands, edit `band_items()` in `brain/usage.py`; `usage.windowDays` and `usage.heavyShare` change the window and the heavy share without code.

**What is left out**
- Sessions run under a folder in `usage.excludeRoots`, or in the list a second file holds (`usage.excludeRootsFile` plus `usage.excludeRootsKey`). A project folder that matches is never opened; a session that moved into one is dropped whole. If that second file cannot be read, usage is skipped for that refresh.
- The director's own sessions (named `Command Center Director`, or starting with one of its `REFRESH`, `DAYEND` or `PROMPT` messages).
- Servers matching `usage.hideConnectors` (default `ccd_*`, the desktop app's own plumbing).

**What it keeps** (`data/`, gitignored)
- `usage-cache.json`: one entry per transcript, reused while the file's size and modified time are unchanged. A refresh with nothing new re-reads no transcript.
- `usage-daily.json`: totals per day, kept after Claude Code deletes old transcripts (`cleanupPeriodDays`, 30 by default). Each number only ever goes up, so if you change what is left out, delete this file to rebuild it from the transcripts still on disk.

From `~/.claude.json` only `skillUsage` and the names under `mcpServers` are read; from `settings.json` only `enabledPlugins`. The director never gets any of this: `usage` and `scorecard` are left out of `director-input.json`, and it may not read `data/usage-*`.

### Rank with Jev (optional, on demand)
The scorecard has a **Rank with Jev** button. It asks [TypeSafe's Jev model](https://docs.typesafe.ai) to score each skill in use on value for cost, and shows the result as a **Jev rank** column with the day it was ranked.

- **It only runs when you click it and confirm.** Never on a refresh, never on a timer, and the director cannot reach it. The confirm step names the skills and says where they go.
- **Each click is one paid call** on your TypeSafe key: one request to `api.typesafe.ai` for all skills (it is split only if it would not fit one request). Jev bills input tokens; a run over a dozen skills is a few thousand tokens. The result records the token use Jev reports.
- **The key** is read from the `TYPESAFE_API_KEY` environment variable when the call is made, and goes into the request's `Authorization` header only. It is never sent to the page, written to the log or saved in a file. Without the variable the button is disabled and says why; set it and restart the Command Center.
- **What is sent**, for each skill used in the usage window: its name, its description (the `description:` line of its `SKILL.md`, with folder paths replaced by `[path]`), calls, tokens per call, minutes per call, its share of the tokens and the day it was last used, plus the medians for comparison. **Not sent:** transcript text, prompts, file paths, project names, session ids, connectors, sub-agents.
- **What Jev is asked:** one Score question per skill, "How much value does this skill give for what it costs?", on five levels written as situations (`LEVELS` in `jev.mjs`, where all the wording lives). The ranking itself is made in code: best score first, a tie goes to the skill that costs less per call.
- **What it is worth:** Jev judges from the descriptions and the usage numbers. It has not seen the work the skills produced, so read the rank as a second opinion on cost against stated purpose, not as a measure of quality. The panel says so next to the result.
- The result is kept in `data/usage-jev-rank.json` (gitignored) until the next run replaces it. `usage.jevModel` picks the model (default `jev-latest`).

## Agents (optional)
`agents.mjs` watches one [OneManCompany](https://github.com/1mancompany/OneManCompany) office (or a fork of it) and shows who is working on what. It only reads: the Command Center never sends the office a task, an answer or a hire.

Set it up in `local/config.json`:
```json
"agents": {
  "url": "http://127.0.0.1:8000",
  "tokenFile": "C:\\path\\to\\office\\.onemancompany\\local_token",
  "employeesDir": "C:\\path\\to\\office\\.onemancompany\\company\\human_resource\\employees"
}
```
- `url`: where the office answers. Without it the panel says **NOT RUNNING · no agent office is set** and nothing is called.
- `tokenFile`: only if your office asks for a token on its API (a fork that adds one keeps it in a file). The server reads the file each time it calls the office and sends the token in the `X-OMC-Token` header to `url`, nowhere else. It is never sent to the page, never logged, never copied into `data/`.
- `employeesDir`: the folder that holds one folder per employee. If an employee folder has a `claude_usage.jsonl` (one line per `claude` CLI run, with its `usage` block), the **TOKENS** column is the sum of new tokens (input, output, cache writes), with cache reads in the hover. Without `employeesDir` the column reads **n/a**.

What it reads from the office: `GET /api/state` (rooms, running tasks), `/api/employees`, `/api/projects`, `/api/ceo/sessions` (and the session itself when it has a message waiting), `/api/candidates/pending`, and the `/ws` event stream. An event re-reads the office within a second; a full re-read also runs every `agents.pollSeconds` (20). On Node older than 22 there is no built-in WebSocket client, so it polls only.

- **Needs you** gets one line per hire shortlist waiting for a choice and per project conversation waiting for your answer (a sign-off when the last message asks you to confirm). The link opens the office with the item named after the `#`. The office has no page addresses of its own, so today the shortlist reopens by itself and a pending conversation is the one marked in its project list.
- **The office going away** is normal: it restarts itself after a hire. For `agents.graceSeconds` (60) the panel keeps the last rows, dimmed, and says **RECONNECTING**; after that it says **NOT RUNNING**. The rest of the page does not depend on it.
- `"agents": false` removes the panel.

To see the panel without an office: `node tests/fake-office.mjs --port 8765` serves the made-up company in `tests/fixtures/office`; point `agents.url` at `http://127.0.0.1:8765` and `agents.employeesDir` at `tests/fixtures/office/employees`.

## The director
- The installed `claude` CLI, headless: `claude -p --resume <session> --permission-mode dontAsk --settings data/director-settings.json --append-system-prompt-file data/director-prompt.md`, run from the vault so its `CLAUDE.md` applies.
- Both files are rendered at start from `director/` plus `local/`. `dontAsk` refuses anything not allowed.
- **Allowed:** reading the vault and its own data, Edit and Write inside the vault.
- **Denied:** the shell, web, agents, scheduling, messaging, `.env`/credential files, `.obsidian` and `.git`, plus your `local/settings.json` rules. MCP tools are not allowed, so they are refused.
- Session hooks are off for the director (they slowed every call); the server does their work: lint, commit, and an optional audit log line per edit.
- The **⋯** menu starts a new director session.

If your vault keeps a log of Claude Code sessions, add `^REFRESH (FULL|CHANGES) ` to whatever skips headless pipeline sessions, so the director's session is not filed as yours.

## Files
| Path | What |
|---|---|
| `server.mjs` | HTTP server, events stream, job queue (one director call at a time), token check |
| `brain/snapshot.py` | Reads the vault into the snapshot; no third-party packages |
| `brain/usage.py` | Reads the Claude Code transcripts into the `usage` and `scorecard` keys of the snapshot |
| `jev.mjs` | The on-demand Rank with Jev request: what is sent, the question wording, the ranking |
| `agents.mjs` | The AGENTS panel: reads an agent office's API and event stream, sums tokens per employee |
| `session.mjs` | The director's Claude Code session: resumes or replaces it when the CLI refuses its id, and which failure the page shows |
| `brain/routines.ps1` | Task Scheduler state for the routines panel |
| `brain/routines.json`, `brain/areas.json` | Defaults for the demo vault; `local/` overrides them |
| `director/` | The director's prompt, base permissions and output schemas |
| `public/` | The page: `index.html`, `app.css`, `app.js`, `map/brainmap.js`; `vendor/3d-force-graph.min.js` is 3d-force-graph 1.80.1 |
| `local.example/` | A starting `local/` |
| `examples/demo-vault/` | A small vault in the expected layout |
| `data/` | Runtime state (gitignored): token, snapshots, director output, `days/<date>.json`, `usage-cache.json`, `usage-daily.json`, `usage-jev-rank.json`, `server.log` |
| `tests/` | `python -m unittest discover -s tests`; `node --test tests/jev.test.mjs tests/agents.test.mjs tests/session.test.mjs` (the Jev call is mocked, the office is `tests/fake-office.mjs` on a loopback port and the CLI is a stand-in, so nothing leaves the machine); `node tests/smoke.mjs ["a prompt"]` against a running server |

## Settings (`local/config.json`)
`port` (or `node server.mjs --port 4318` for a second copy), `refreshMinutes`, `model` (prompts and day end), `refreshModel` (full refreshes and the compact), `changesModel` (changes-only refreshes), `compactAboveTokens`, `skillsHub` (the note your skills hang off on the map), `briefUrl` plus `briefRoutine` (a link under the brief once that routine fired today), `title`, `subtitle`, `place`, and `"director": false` to read the brain without calling Claude.

`usage` (an object, or `false` to turn the panel off): `claudeHome` and `claudeJson` (default `~/.claude` and `~/.claude.json`), `excludeRoots`, `excludeRootsFile` and `excludeRootsKey`, `connectorNames` (`{"<server name or id>": "label"}`; claude.ai connectors appear under an id, so name them here, and list the ones you want scored even if never called), `hideConnectors`, `windowDays`, `heavyShare`, `jevModel`.

`agents` (an object, or `false` to turn the panel off): `url`, `tokenFile`, `employeesDir`, `pollSeconds`, `graceSeconds`; see Agents above.

`/api/health` reports whether the code or `local/` changed since the server started; `Start-CommandCenter.ps1` then restarts it, so reopening the shortcut picks up changes.

## Security
- The server binds to 127.0.0.1 and rejects other Host headers.
- Every API call needs the token in `data/token`, which the server puts into the page it serves.
- The note endpoint serves only `.md` files inside the vault.
- The agent office's token (`agents.tokenFile`) is read by the server and sent only to `agents.url`, in a header. The page gets employee names, statuses, task lines and token counts, not the token and not the two paths.
- Nothing is published or hosted. `data/` and `local/` never leave the machine. The one exception is the Rank with Jev button, which sends what its confirm step lists to `api.typesafe.ai`, once per click.
