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
| `brain/routines.ps1` | Task Scheduler state for the routines panel |
| `brain/routines.json`, `brain/areas.json` | Defaults for the demo vault; `local/` overrides them |
| `director/` | The director's prompt, base permissions and output schemas |
| `public/` | The page: `index.html`, `app.css`, `app.js`, `map/brainmap.js`; `vendor/3d-force-graph.min.js` is 3d-force-graph 1.80.1 |
| `local.example/` | A starting `local/` |
| `examples/demo-vault/` | A small vault in the expected layout |
| `data/` | Runtime state (gitignored): token, snapshots, director output, `days/<date>.json`, `server.log` |
| `tests/` | `python -m unittest discover -s tests`; `node tests/smoke.mjs ["a prompt"]` against a running server |

## Settings (`local/config.json`)
`port` (or `node server.mjs --port 4318` for a second copy), `refreshMinutes`, `model` (prompts and day end), `refreshModel` (full refreshes and the compact), `changesModel` (changes-only refreshes), `compactAboveTokens`, `skillsHub` (the note your skills hang off on the map), `briefUrl` plus `briefRoutine` (a link under the brief once that routine fired today), `title`, `subtitle`, `place`, and `"director": false` to read the brain without calling Claude.

`/api/health` reports whether the code or `local/` changed since the server started; `Start-CommandCenter.ps1` then restarts it, so reopening the shortcut picks up changes.

## Security
- The server binds to 127.0.0.1 and rejects other Host headers.
- Every API call needs the token in `data/token`, which the server puts into the page it serves.
- The note endpoint serves only `.md` files inside the vault.
- Nothing is published or hosted. `data/` and `local/` never leave the machine.
