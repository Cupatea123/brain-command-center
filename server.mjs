// Command Center server. Local only (127.0.0.1). No dependencies beyond Node itself.
// Serves the dashboard, reads the brain (an Obsidian vault + Task Scheduler + the hook activity log)
// and drives one permanent headless Claude "director" session through the installed `claude` CLI.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CC = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(CC, 'data');
const DAYS = path.join(DATA, 'days');
const PUBLIC = path.join(CC, 'public');
const LOCAL = path.join(CC, 'local');
fs.mkdirSync(DAYS, { recursive: true });

// Everything personal lives in local/ (gitignored): config.json, routines.json, areas.json,
// director.md (extra standing facts) and settings.json (extra permission rules). Without it the
// Command Center runs on the demo vault in examples/.
const localFile = (name, fallback) => (fs.existsSync(path.join(LOCAL, name)) ? path.join(LOCAL, name) : fallback);
const CONFIG = {
  port: 4317,
  host: '127.0.0.1',
  owner: 'Me',              // your name, as the director and the page use it
  ownerKey: '',             // the task `owner:` value that means you (default: owner, lowercased)
  title: '',                // header, default "<OWNER> OS"
  subtitle: 'PERSONAL · COMMAND CENTRE',
  place: 'HOME',
  vault: path.join(CC, 'examples', 'demo-vault'),
  obsidianVault: '',        // the vault's name in Obsidian, for obsidian:// links (default: the folder name)
  directorCwd: '',          // where the director runs (default: the vault, so its CLAUDE.md applies)
  activityDir: '',          // <date>.jsonl hook logs of prompts and file writes, if your vault keeps them
  skillsDirs: [path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills')],
  skillsHub: '',            // the note the skills link to on the map (default: the centre node)
  lint: null,               // { cmd: ["node", "...", "lint"], ok: "regex the output matches when clean" }
  vaultGit: { commit: false, push: false, message: 'Command Center director edit' },
  auditLog: '',
  briefUrl: '', briefRoutine: '', // a link shown under the brief once that routine has fired today
  refreshMinutes: 30,
  model: 'sonnet',          // prompts and day end
  refreshModel: 'sonnet',   // full refreshes (first of the day) and the daily compact
  changesModel: 'haiku',    // changes-only refreshes (most of them)
  compactAboveTokens: 120000, // first refresh of the day compacts the session when its context is larger
  ...readJson(localFile('config.json', ''), {}),
};
{ const i = process.argv.indexOf('--port'); if (i > 0 && process.argv[i + 1]) CONFIG.port = Number(process.argv[i + 1]); }
CONFIG.vault = path.resolve(CC, CONFIG.vault);
CONFIG.directorCwd = CONFIG.directorCwd || CONFIG.vault;
CONFIG.obsidianVault = CONFIG.obsidianVault || path.basename(CONFIG.vault);
CONFIG.title = CONFIG.title || `${CONFIG.owner} OS`.toUpperCase();
const STARTED = new Date().toISOString();

const P = {
  token: path.join(DATA, 'token'),
  state: path.join(DATA, 'state.json'),
  snapshot: path.join(DATA, 'snapshot.json'),
  dinput: path.join(DATA, 'director-input.json'),
  lastInput: path.join(DATA, 'last-director-input.json'),
  diff: path.join(DATA, 'director-diff.json'),
  routines: path.join(DATA, 'routines.json'),
  director: path.join(DATA, 'director.json'),
  log: path.join(DATA, 'server.log'),
  directorPrompt: path.join(DATA, 'director-prompt.md'),
  settings: path.join(DATA, 'director-settings.json'),
  routinesPs1: path.join(CC, 'brain', 'routines.ps1'),
  routinesCfg: localFile('routines.json', path.join(CC, 'brain', 'routines.json')),
  areasCfg: localFile('areas.json', path.join(CC, 'brain', 'areas.json')),
  snapshotPy: path.join(CC, 'brain', 'snapshot.py'),
  directorMd: path.join(CC, 'director', 'director.md'),
  localDirectorMd: path.join(LOCAL, 'director.md'),
  baseSettings: path.join(CC, 'director', 'settings.json'),
  localSettings: path.join(LOCAL, 'settings.json'),
  refreshSchema: path.join(CC, 'director', 'schemas', 'refresh.schema.json'),
  dayendSchema: path.join(CC, 'director', 'schemas', 'dayend.schema.json'),
};
const WATCHED = ['server.mjs', 'brain/snapshot.py', 'director/director.md', 'director/settings.json', 'local/config.json', 'local/director.md', 'local/settings.json'];
const codeStamp = () => Math.max(...WATCHED.map((f) => { try { return fs.statSync(path.join(CC, f)).mtimeMs; } catch { return 0; } }));
const CODE_AT_START = codeStamp();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
function log(...parts) {
  const line = `${new Date().toISOString()}  ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(P.log, line + '\n'); } catch {}
}
function localDate(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function resolveExe(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (process.platform === 'win32' ? lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) : lines[0]) || name;
}
const EXE = { pwsh: CONFIG.pwsh || resolveExe('pwsh'), python: CONFIG.python || resolveExe(process.platform === 'win32' ? 'python' : 'python3'), claude: CONFIG.claude || resolveExe('claude'), git: CONFIG.git || resolveExe('git') };

// ------------------------------------------------------------------ the director's prompt and permissions
// Both are rendered into data/ at start: the shared prompt with the owner and paths filled in, plus
// local/director.md; the shared permissions with Edit and Write fenced to the vault, plus local/settings.json.
const slashPath = (p) => '//' + path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase());
function renderDirector() {
  const fill = (s) => s.replaceAll('{{OWNER}}', CONFIG.owner).replaceAll('{{VAULT}}', CONFIG.vault).replaceAll('{{DATA}}', DATA);
  let md = fill(fs.readFileSync(P.directorMd, 'utf8'));
  if (fs.existsSync(P.localDirectorMd)) md += '\n\n' + fill(fs.readFileSync(P.localDirectorMd, 'utf8'));
  fs.writeFileSync(P.directorPrompt, md);
  const base = readJson(P.baseSettings, { permissions: { allow: [], deny: [] } });
  const extra = readJson(P.localSettings, {});
  const vaultGlob = slashPath(CONFIG.vault) + '/**';
  const sub = (rules) => (rules || []).map((r) => r.replaceAll('{{VAULT}}', vaultGlob).replaceAll('{{DATA}}', slashPath(DATA) + '/**'));
  const settings = {
    ...base, ...extra,
    permissions: {
      allow: [...new Set([...sub(base.permissions?.allow), ...sub(extra.permissions?.allow)])],
      deny: [...new Set([...sub(base.permissions?.deny), ...sub(extra.permissions?.deny)])],
    },
  };
  writeJson(P.settings, settings);
}
renderDirector();

// ------------------------------------------------------------------ token and state
let TOKEN = '';
try { TOKEN = fs.readFileSync(P.token, 'utf8').trim(); } catch {}
if (!/^[0-9a-f]{48}$/.test(TOKEN)) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(P.token, TOKEN); }

const state = { sessionId: crypto.randomUUID(), sessionStarted: false, lastDirectorHash: '', lastDirectorAt: '', lastBriefDate: '', lastSnapshotAt: '', ...readJson(P.state, {}) };
const saveState = () => writeJson(P.state, state);
saveState();

// ------------------------------------------------------------------ server-sent events
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch {} }
}
const status = { core: 'idle', phase: '', queue: 0, label: '' };
function setStatus(patch) { Object.assign(status, patch); broadcast('status', status); }

// ------------------------------------------------------------------ job queue (one director call at a time)
let chain = Promise.resolve();
const queued = new Set();
function enqueue(key, label, fn) {
  if (key && queued.has(key)) return false;
  if (key) queued.add(key);
  status.queue++;
  setStatus({});
  chain = chain.then(async () => {
    setStatus({ core: 'busy', label });
    try { await fn(); } catch (e) { log('job failed', label, e.stack || e); broadcast('error', { label, message: String(e.message || e) }); }
  }).finally(() => {
    if (key) queued.delete(key);
    status.queue--;
    setStatus({ core: status.queue > 0 ? 'busy' : 'idle', phase: '', label: status.queue > 0 ? status.label : '' });
  });
  return true;
}

// ------------------------------------------------------------------ processes
function run(cmd, args, { cwd = CC, input = null, onLine = null, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env } });
    let out = '', err = '', buf = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); if (onLine && buf.trim()) onLine(buf.trim()); resolve({ code, out, err }); });
    if (input !== null) { child.stdin.write(input); }
    child.stdin.end();
  });
}
const git = (args, opts = {}) => run(EXE.git, ['-C', CONFIG.vault, ...args], { timeoutMs: 120000, ...opts });

// ------------------------------------------------------------------ the brain
async function readBrain(prevPath = null) {
  setStatus({ phase: 'reading brain' });
  const t0 = Date.now();
  const rcfg = readJson(P.routinesCfg, {});
  if (process.platform === 'win32' && (rcfg.windows || []).length) {
    await run(EXE.pwsh, ['-NoProfile', '-NonInteractive', '-File', P.routinesPs1, '-Config', P.routinesCfg, '-OutFile', P.routines], { timeoutMs: 120000 });
  }
  const args = [P.snapshotPy, '--vault', CONFIG.vault, '--out', P.snapshot, '--routines', P.routines, '--routines-cfg', P.routinesCfg, '--areas-cfg', P.areasCfg, '--owner', CONFIG.owner];
  if (CONFIG.ownerKey) args.push('--owner-key', CONFIG.ownerKey);
  for (const d of CONFIG.skillsDirs || []) args.push('--skills', d);
  if (CONFIG.skillsHub) args.push('--skills-hub', CONFIG.skillsHub);
  if (CONFIG.activityDir) args.push('--activity', CONFIG.activityDir);
  if (prevPath && fs.existsSync(prevPath)) args.push('--prev', prevPath);
  const r = await run(EXE.python, args, { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error('snapshot failed: ' + (r.err || r.out).slice(-800));
  const snap = readJson(P.snapshot, null);
  state.lastSnapshotAt = new Date().toISOString();
  saveState();
  const start = path.join(DAYS, `${snap.today}.start.json`);
  if (!fs.existsSync(start)) fs.copyFileSync(P.dinput, start);
  log(`brain read in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, r.out.trim());
  broadcast('snapshot', { at: state.lastSnapshotAt, hash: snap.hash });
  return snap;
}

// ------------------------------------------------------------------ day files
function dayFile(date) { return path.join(DAYS, `${date}.json`); }
function readDay(date) { return readJson(dayFile(date), { date, prompts: [], refreshes: [], dayend: null }); }
function updateDay(date, fn) { const d = readDay(date); fn(d); writeJson(dayFile(date), d); return d; }

// ------------------------------------------------------------------ the director
function directorArgs(extra, model = CONFIG.model) {
  const a = ['-p', '--permission-mode', 'dontAsk', '--settings', P.settings, '--append-system-prompt-file', P.directorPrompt];
  if (model) a.push('--model', model);
  if (state.sessionStarted) a.push('--resume', state.sessionId);
  else a.push('--session-id', state.sessionId, '-n', 'Command Center Director');
  return a.concat(extra);
}

async function callDirector(extra, prompt, onLine, model = CONFIG.model) {
  let r = await run(EXE.claude, directorArgs(extra, model), { cwd: CONFIG.directorCwd, input: prompt, onLine });
  if (r.code !== 0 && state.sessionStarted && /no conversation found|session.*not found/i.test(r.err + r.out)) {
    log('director session missing, starting a new one');
    state.sessionId = crypto.randomUUID(); state.sessionStarted = false; state.sessionCost = 0; saveState();
    r = await run(EXE.claude, directorArgs(extra, model), { cwd: CONFIG.directorCwd, input: prompt, onLine });
  }
  if (r.code === 0 && !state.sessionStarted) { state.sessionStarted = true; saveState(); }
  return r;
}

// `total_cost_usd` from a resumed session is the session's running total; keep the per-call delta
// and the context size (tokens the last call read) so the dashboard can show both.
function account(res) {
  if (!res) return 0;
  const total = Number(res.total_cost_usd) || 0;
  const delta = Math.max(0, total - (state.sessionCost || 0));
  state.sessionCost = total;
  const u = res.usage || {};
  const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (ctx) state.contextTokens = ctx;
  saveState();
  return Math.round(delta * 1000) / 1000;
}

// A failed call's own message, with the fix when it is the CLI's sign-in.
function failure(res, r) {
  const msg = (res && typeof res.result === 'string' && res.result) || (r.err || r.out || 'no output').slice(-600);
  return /authenticat|not logged in|\/login|oauth/i.test(msg) ? `${msg}. Sign the claude CLI in once: run \`claude auth login\` in a terminal.` : msg;
}

function parseResult(out) {
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const j = JSON.parse(lines[i]); if (j && j.type === 'result') return j; } catch {}
  }
  try { return JSON.parse(out); } catch { return null; }
}

async function lintAfterEdits() {
  if (!CONFIG.lint?.cmd?.length) return { ok: true, text: '', skipped: true };
  const [cmd, ...args] = CONFIG.lint.cmd;
  const r = await run(cmd === 'node' ? process.execPath : cmd, args, { cwd: CONFIG.vault, timeoutMs: 120000 });
  const text = (r.out + r.err).trim();
  const ok = r.code === 0 && (!CONFIG.lint.ok || new RegExp(CONFIG.lint.ok).test(text));
  return { ok, text: text.slice(-2000) };
}

// Commit only the files the director edited; pull before push because Obsidian Git may commit too.
async function commitEdits(files) {
  const g = CONFIG.vaultGit || {};
  if (!g.commit || !files.length || !fs.existsSync(path.join(CONFIG.vault, '.git'))) return '';
  if (fs.existsSync(path.join(CONFIG.vault, '.git', 'index.lock'))) await new Promise((r) => setTimeout(r, 5000));
  const rel = [...new Set(files)].map((f) => path.relative(CONFIG.vault, path.resolve(CONFIG.vault, f))).filter((f) => f && !f.startsWith('..'));
  if (!rel.length) return '';
  await git(['add', '--', ...rel]);
  const c = await git(['commit', '-m', g.message || 'Command Center director edit', '--', ...rel]);
  if (c.code !== 0) return 'commit: ' + ((c.out + c.err).trim().split(/\r?\n/).pop() || `exit ${c.code}`);
  if (!g.push) return 'committed';
  const pull = await git(['pull', '--no-rebase', '-q']);
  if (pull.code !== 0) return 'committed; pull failed, not pushed';
  const push = await git(['push', '-q']);
  return push.code === 0 ? 'committed and pushed' : 'committed; push failed';
}

async function compactIfLarge() {
  if (!state.sessionStarted || !(state.contextTokens > CONFIG.compactAboveTokens)) return;
  setStatus({ phase: `compacting the director session (${Math.round(state.contextTokens / 1000)}k tokens)` });
  const t0 = Date.now();
  const r = await callDirector(['--output-format', 'json'], '/compact', null, CONFIG.refreshModel);
  const res = parseResult(r.out);
  const cost = account(res);
  const before = state.contextTokens;
  state.contextTokens = 0; saveState(); // the next call reports the new size
  log(`director session compacted from ${Math.round(before / 1000)}k tokens in ${Math.round((Date.now() - t0) / 1000)}s, $${cost.toFixed(3)}`);
}

function compactSummary(snap) {
  return {
    counts: { todo_open: snap.stats.todo_open, tasks_open: snap.stats.tasks_open, needs: snap.needs.length, projects_live: snap.stats.projects_live, sessions: snap.stats.sessions },
    day_shape: snap.day_shape,
    needs: snap.needs.map((n) => `${n.tag}: ${n.title}${n.age_days ? ` (${n.age_days}d)` : ''}`),
    claude_next: snap.claude_next.map((t) => `${t.id} ${t.title}`),
    in_progress: snap.in_progress.map((t) => `${t.id} ${t.title} (${t.owner}, since ${t.since})`),
    routines_today: snap.routines_today,
  };
}

async function directorRefresh(force) {
  const snap = await readBrain(P.lastInput);
  const today = snap.today;
  if (CONFIG.director === false) { log('refresh: director disabled in config.json, brain read only'); return; }
  const firstToday = state.lastBriefDate !== today;
  const fresh = state.lastDirectorAt && (Date.now() - Date.parse(state.lastDirectorAt)) < CONFIG.refreshMinutes * 60000;
  if (!force && !firstToday && snap.hash === state.lastDirectorHash && fresh) {
    log('refresh: brain unchanged and director refreshed', Math.round((Date.now() - Date.parse(state.lastDirectorAt)) / 60000), 'min ago, director skipped');
    updateDay(today, (d) => d.refreshes.push({ at: new Date().toISOString(), skipped: true }));
    broadcast('director-skip', { reason: 'brain unchanged', last: state.lastDirectorAt });
    return;
  }
  if (firstToday) await compactIfLarge();
  const diff = readJson(P.diff, null);
  const full = firstToday || !state.sessionStarted || !diff || diff.diff === null || !fs.existsSync(P.lastInput);
  setStatus({ phase: full ? 'director reading the whole brain' : 'director reviewing what changed' });
  const schema = fs.readFileSync(P.refreshSchema, 'utf8').replace(/\s+/g, ' ');
  const now = new Date();
  const head = `${now.toISOString()} (local ${now.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })})`;
  const prompt = full
    ? [`REFRESH FULL ${head}`, `Read ${P.dinput} (hash ${snap.hash}). ${firstToday ? 'First refresh of the day: write the brief fresh.' : ''}`, 'Return the structured output.'].join('\n')
    : [`REFRESH CHANGES ${head}`, `Changes since your last refresh (${diff.since}):`, JSON.stringify(diff.diff), 'Current state:', JSON.stringify(compactSummary(snap)), 'Return the structured output.'].join('\n');
  try { fs.writeFileSync(path.join(DATA, 'last-refresh-prompt.txt'), prompt); } catch {}
  const model = full ? CONFIG.refreshModel : CONFIG.changesModel;
  const t0 = Date.now();
  const r = await callDirector(['--output-format', 'json', '--json-schema', schema], prompt, null, model);
  const res = parseResult(r.out);
  if (!res || !res.structured_output) throw new Error('director refresh returned no structured output: ' + failure(res, r));
  const record = { at: new Date().toISOString(), hash: snap.hash, firstToday, mode: full ? 'full' : 'changes', prompt_chars: prompt.length, model, output: res.structured_output, cost_usd: account(res), duration_s: Math.round((Date.now() - t0) / 1000), denials: res.permission_denials || [] };
  writeJson(P.director, record);
  fs.copyFileSync(P.dinput, P.lastInput);
  Object.assign(state, { lastDirectorHash: snap.hash, lastDirectorAt: record.at, lastBriefDate: today });
  saveState();
  updateDay(today, (d) => d.refreshes.push({ at: record.at, skipped: false, mode: record.mode, cost_usd: record.cost_usd, duration_s: record.duration_s }));
  log(`director refresh (${record.mode}, ${prompt.length} chars, ${model}) done in ${record.duration_s}s, $${(record.cost_usd || 0).toFixed(3)}, context ${Math.round((state.contextTokens || 0) / 1000)}k`);
  broadcast('director', record);
}

async function directorPrompt(id, text) {
  const today = localDate();
  updateDay(today, (d) => d.prompts.push({ id, at: new Date().toISOString(), text, reply: '', tools: [], denials: [] }));
  setStatus({ phase: 'director answering' });
  let reply = '';
  const tools = [];
  const editedFiles = [];
  let edited = false;
  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
      broadcast('chat', { id, delta: ev.event.delta.text });
    } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_use') {
          const hint = c.input?.file_path || c.input?.pattern || c.input?.query || '';
          tools.push(c.name);
          if (/^(Edit|Write|MultiEdit)$/.test(c.name)) { edited = true; editedFiles.push({ tool: c.name, path: String(c.input?.file_path || '') }); }
          broadcast('chat', { id, tool: c.name, hint: String(hint).slice(0, 160) });
        } else if (c.type === 'text') {
          reply = c.text; // the last full text block; deltas already streamed
        }
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string') reply = ev.result;
      const cost = account(ev);
      broadcast('chat', { id, done: true, text: reply, denials: (ev.permission_denials || []).map((x) => x.tool_name), cost_usd: cost });
      updateDay(today, (d) => { const p = d.prompts.find((x) => x.id === id); if (p) Object.assign(p, { reply, tools, denials: (ev.permission_denials || []).map((x) => x.tool_name), cost_usd: cost }); });
    }
  };
  const r = await callDirector(['--output-format', 'stream-json', '--verbose', '--include-partial-messages'], `PROMPT\n${text}`, onLine);
  if (r.code !== 0 && !reply) {
    broadcast('chat', { id, done: true, text: 'The director did not answer: ' + failure(parseResult(r.out), r), error: true });
  }
  if (edited) {
    // The director runs with session hooks off; keep the audit trail the hooks would give.
    if (CONFIG.auditLog) {
      const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
      try { fs.appendFileSync(CONFIG.auditLog, editedFiles.map((e) => `${stamp}  [${e.tool}]  ${e.path}  (Command Center director)`).join('\n') + '\n'); } catch (e) { log('audit log write failed', e.message); }
    }
    const lint = await lintAfterEdits();
    if (!lint.skipped) broadcast('chat', { id, note: lint.ok ? 'Vault lint: clean.' : 'Vault lint found problems; asking the director to fix them.' });
    if (!lint.ok) enqueue(null, 'fix lint', () => directorPrompt(crypto.randomUUID(), `The vault lint reported failures after your edits. Fix them:\n${lint.text}`));
    else {
      const g = await commitEdits(editedFiles.map((e) => e.path));
      if (g) { broadcast('chat', { id, note: `Vault: ${g}.` }); log('vault git after director edits:', g); }
    }
  }
}

async function vaultCommitsToday() {
  if (!fs.existsSync(path.join(CONFIG.vault, '.git'))) return [];
  const r = await git(['log', '--since=midnight', '--format=%H%x09%ad%x09%s', '--date=format:%H:%M']);
  return (r.out || '').trim().split(/\r?\n/).filter(Boolean).map((l) => { const [h, t, s] = l.split('\t'); return { time: t, subject: s, sha: h.slice(0, 7) }; })
    .filter((c) => !/^vault backup:/.test(c.subject)).slice(0, 60);
}

async function directorDayend() {
  const startPath = path.join(DAYS, localDate() + '.start.json');
  const snap = await readBrain(startPath); // director-diff.json now holds start-of-day -> now
  const today = snap.today;
  setStatus({ phase: 'director summarising the day' });
  const schema = fs.readFileSync(P.dayendSchema, 'utf8').replace(/\s+/g, ' ');
  const diff = readJson(P.diff, { diff: null });
  const day = readDay(today);
  const localHM = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  const prompts = (day.prompts || []).map((p) => ({ at: localHM(p.at), asked: p.text.slice(0, 300), answered: (p.reply || '').slice(0, 300), tools: [...new Set(p.tools || [])] }));
  const act = snap.activity_today || { prompts: [], writes: [] };
  const prompt = [
    `DAYEND ${new Date().toISOString()}`,
    'Changes from the start-of-day view to now:', JSON.stringify(diff.diff),
    `Vault commits today (Obsidian auto-backups excluded): ${JSON.stringify(await vaultCommitsToday())}`,
    `TODO lines ticked today: ${JSON.stringify(snap.todo_done_today || [])}`,
    `Tasks marked done in the last 7 days: ${JSON.stringify(snap.tasks_done_recent || [])}`,
    `${CONFIG.owner}'s prompts in Claude sessions today (${act.prompts.length}): ${JSON.stringify(act.prompts.slice(0, 60))}`,
    `Files written by Claude sessions today: ${JSON.stringify(act.writes)}`,
    "Today's Command Center prompts:", JSON.stringify(prompts),
    `Today's sessions in the vault: ${JSON.stringify((snap.sessions || []).filter((s) => s.date === today).map((s) => ({ slug: s.slug, projects: s.projects, summary: s.summary })))}`,
    `Return the structured output for what ${CONFIG.owner} completed today.`,
  ].join('\n');
  const t0 = Date.now();
  const r = await callDirector(['--output-format', 'json', '--json-schema', schema], prompt);
  const res = parseResult(r.out);
  if (!res || !res.structured_output) throw new Error('director day-end returned no structured output: ' + failure(res, r));
  const record = { at: new Date().toISOString(), output: res.structured_output, cost_usd: account(res), duration_s: Math.round((Date.now() - t0) / 1000) };
  updateDay(today, (d) => { d.dayend = record; });
  log(`director day-end done in ${record.duration_s}s`);
  broadcast('dayend', { date: today, ...record });
}

// ------------------------------------------------------------------ http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 200000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
function safeVaultPath(rel) {
  const full = path.resolve(CONFIG.vault, rel || '');
  const root = path.resolve(CONFIG.vault) + path.sep;
  return full.startsWith(root) && full.toLowerCase().endsWith('.md') ? full : null;
}

// The SYNC light: when the vault last reached git (a commit), and whether it is ahead of its remote.
let syncCache = { at: 0, value: { line: '', at: '' } };
function lastSync() {
  if (Date.now() - syncCache.at < 60000) return syncCache.value;
  let value = { line: '', at: '' };
  try {
    const r = spawnSync(EXE.git, ['-C', CONFIG.vault, 'log', '-1', '--format=%ci%x09%s'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const [at, subject] = (r.stdout || '').trim().split('\t');
    if (at) value = { line: subject || '', at: at.slice(0, 19) };
  } catch {}
  syncCache = { at: Date.now(), value };
  return value;
}

const PAGE = () => ({ owner: CONFIG.owner, title: CONFIG.title, subtitle: CONFIG.subtitle, place: CONFIG.place, obsidianVault: CONFIG.obsidianVault, briefUrl: CONFIG.briefUrl, briefRoutine: CONFIG.briefRoutine, refreshMinutes: CONFIG.refreshMinutes });

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${CONFIG.port}` && host !== `localhost:${CONFIG.port}`) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;

    if (p.startsWith('/api/')) {
      const tok = req.headers['x-cc-token'] || url.searchParams.get('token');
      if (tok !== TOKEN) return send(res, 401, { error: 'bad token' });

      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (p === '/api/state' && req.method === 'GET') {
        const today = localDate();
        return send(res, 200, { snapshot: readJson(P.snapshot, null), director: readJson(P.director, null), day: readDay(today), status,
          session: { id: state.sessionId, started: state.sessionStarted, lastDirectorAt: state.lastDirectorAt, lastSnapshotAt: state.lastSnapshotAt, cost: state.sessionCost || 0, contextTokens: state.contextTokens || 0, model: CONFIG.model || 'default' },
          sync: lastSync(), config: PAGE() });
      }
      if (p === '/api/snapshot' && req.method === 'GET') return send(res, 200, readJson(P.snapshot, null));
      if (p === '/api/health' && req.method === 'GET') {
        return send(res, 200, { started: STARTED, stale: codeStamp() > CODE_AT_START, busy: status.core === 'busy' || status.queue > 0 });
      }
      if (p === '/api/shutdown' && req.method === 'POST') {
        if (status.core === 'busy' || status.queue > 0) return send(res, 409, { error: 'busy; try again when the director is idle' });
        send(res, 200, { stopping: true });
        log('shutdown requested');
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (p === '/api/refresh' && req.method === 'POST') {
        const b = await body(req);
        const ok = enqueue('refresh', b.force ? 'refresh (forced)' : 'refresh', () => directorRefresh(!!b.force));
        return send(res, 202, { queued: ok });
      }
      if (p === '/api/prompt' && req.method === 'POST') {
        const b = await body(req);
        const text = String(b.text || '').trim().slice(0, 8000);
        if (!text) return send(res, 400, { error: 'empty prompt' });
        const id = crypto.randomUUID();
        enqueue(null, 'prompt', () => directorPrompt(id, text));
        return send(res, 202, { id });
      }
      if (p === '/api/dayend' && req.method === 'POST') {
        const ok = enqueue('dayend', 'done for today', () => directorDayend());
        return send(res, 202, { queued: ok });
      }
      if (p === '/api/days' && req.method === 'GET') {
        const files = (await fsp.readdir(DAYS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
        return send(res, 200, files.map((f) => { const d = readJson(path.join(DAYS, f), {}); return { date: f.slice(0, 10), prompts: (d.prompts || []).length, dayend: !!d.dayend }; }));
      }
      if (p === '/api/day' && req.method === 'GET') {
        const date = url.searchParams.get('date') || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'bad date' });
        return send(res, 200, readDay(date));
      }
      if (p === '/api/note' && req.method === 'GET') {
        const full = safeVaultPath(url.searchParams.get('rel'));
        if (!full || !fs.existsSync(full)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { text: fs.readFileSync(full, 'utf8').slice(0, 20000) });
      }
      if (p === '/api/director/reset' && req.method === 'POST') {
        enqueue('reset', 'new director session', async () => {
          state.sessionId = crypto.randomUUID(); state.sessionStarted = false; state.lastDirectorHash = ''; state.lastBriefDate = ''; state.sessionCost = 0; state.contextTokens = 0; saveState();
          log('director session reset to', state.sessionId);
          broadcast('session', { id: state.sessionId });
        });
        return send(res, 202, { queued: true });
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }

    // static files
    let rel = p === '/' ? '/index.html' : decodeURIComponent(p);
    const full = path.resolve(PUBLIC, '.' + rel);
    if (!full.startsWith(path.resolve(PUBLIC) + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    let data = fs.readFileSync(full);
    if (full.endsWith('index.html')) {
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      data = data.toString('utf8').replace('__CC_TOKEN__', TOKEN).replaceAll('__CC_TITLE__', esc(CONFIG.title)).replaceAll('__CC_OWNER__', esc(CONFIG.owner.toUpperCase()))
        .replaceAll('__CC_SUBTITLE__', esc(CONFIG.subtitle)).replaceAll('__CC_PLACE__', esc(CONFIG.place.toUpperCase()));
    }
    return send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    log('request error', e.stack || e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', (e) => { log('server error', e.code || e); process.exit(1); });
server.listen(CONFIG.port, CONFIG.host, () => {
  log(`Command Center on http://${CONFIG.host}:${CONFIG.port}  (vault=${CONFIG.vault}, claude=${EXE.claude}, python=${EXE.python}, session ${state.sessionId}${state.sessionStarted ? '' : ' (new)'})`);
});
