// The AGENTS panel: who in an agent office is working on what, and what is waiting on the owner.
// Reads a OneManCompany office (https://github.com/1mancompany/OneManCompany, or a fork of it)
// over its local HTTP API, and listens to its /ws event stream so a change shows up at once.
//
// The office's access token is read from the file named in config (agents.tokenFile) each time a
// request goes out. It travels in a request header only: it is never part of the view the page
// gets, never logged, never written to any file the Command Center keeps.
import fs from 'node:fs';
import path from 'node:path';

export const AGENTS_DEFAULTS = {
  url: '',            // the office's address, e.g. http://127.0.0.1:8000 ('' = no office to watch)
  tokenFile: '',      // the file that holds the office's local token (<office>/.onemancompany/local_token)
  employeesDir: '',   // the office's employees folder; each employee's claude_usage.jsonl gives the TOKENS column
  pollSeconds: 20,    // a full re-read this often, on top of the event stream
  graceSeconds: 60,   // how long a silent office counts as "restarting" before it counts as not running
};
const TOKEN_HEADER = 'X-OMC-Token';
// Events that say nothing about who is doing what; everything else triggers a re-read.
const QUIET = new Set(['connected', 'agent_log', 'agent_thinking', 'acp_update', 'meeting_chat', 'activity']);
const DONE = /^(complete|accepted|finished|failed|cancelled|rejected)$/;
const SIGNOFF = /\b(complete|completed|confirm|sign[- ]?off|accept|approve)\b/i;
const ORDER = { working: 0, in_meeting: 1, idle: 2, setup: 3, offline: 4 };

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function readToken(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}

// Tokens an employee has spent, summed from the claude CLI's own per-run numbers. `tokens` is new
// tokens (input, output, cache writes), the same measure the USAGE panel shows; cache reads are kept
// apart. null when the employee has no such file (not a Claude Code employee, or never ran).
const usageCache = new Map();
export function usageTotals(dir, id) {
  if (!dir || !/^[\w-]+$/.test(String(id))) return null;
  const file = path.join(dir, String(id), 'claude_usage.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = usageCache.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = { tokens: 0, cache_read: 0, turns: 0, runs: 0, last: '' };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j.usage || {};
    value.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    value.cache_read += u.cache_read_input_tokens || 0;
    value.turns += j.num_turns || 0;
    value.runs++;
    if (j.ts && j.ts > value.last) value.last = j.ts;
  }
  usageCache.set(file, { key, value });
  return value;
}

// The office's answers -> what the page shows. Pure: no network, no clock.
//   raw: { state: GET /api/state, employees: GET /api/employees, sessions: GET /api/ceo/sessions,
//          sessionDetail: { <project id>: GET /api/ceo/sessions/<project id> }, candidates: GET /api/candidates/pending,
//          projects: GET /api/projects }
export function buildView(raw, { url = '', tokensFor = () => null } = {}) {
  const st = raw.state || {};
  const rooms = (st.meeting_rooms || []).filter((r) => r && r.is_booked);
  const tasks = (st.active_tasks || []).filter((t) => t && !DONE.test(t.status || ''));
  const projectName = Object.fromEntries((raw.projects?.projects || []).map((p) => [String(p.project_id), p.task || p.name || '']));
  const nameOf = (pid) => clip(projectName[String(pid).split('/')[0]] || String(pid).split('/')[0], 70);

  const employees = (raw.employees || []).map((e) => {
    const id = String(e.id ?? e.employee_number ?? '');
    const running = tasks.find((t) => String(t.current_owner) === id && t.status === 'processing');
    let status = e.needs_setup ? 'setup' : e.api_online === false ? 'offline' : String(e.status || 'idle');
    if (status === 'idle' && running) status = 'working';
    const room = rooms.find((r) => (r.participants || []).map(String).includes(id) || String(r.booked_by) === id);
    return {
      id, name: clip(e.name || e.nickname || id, 60), nickname: e.nickname && e.nickname !== e.name ? clip(e.nickname, 30) : '',
      role: clip(e.role || e.department || '', 30), status,
      // The office can leave an old summary on an employee whose task was cancelled: idle means no task.
      task: status === 'idle' ? '' : clip(e.current_task_summary || running?.task || '', 160),
      project: running ? nameOf(running.project_id) : '',
      room: room ? clip(room.name || room.id, 40) : '',
      model: clip(e.llm_model || '', 30),
      tokens: tokensFor(id),
    };
  }).sort((a, b) => (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2) || a.id.localeCompare(b.id));

  // What only the owner can settle. The office has no page addresses of its own yet, so each link
  // opens the office with the item named after the #: the hire shortlist reopens by itself there.
  const waiting = [];
  for (const [batch, b] of Object.entries(raw.candidates?.batches || {})) {
    const c = b?.candidates || [];
    if (!c.length) continue;
    waiting.push({
      key: 'hire:' + batch, kind: 'hire', title: `Choose a hire: ${c.length} candidate${c.length === 1 ? '' : 's'}`,
      detail: clip(c.map((x) => [x.name || x.nickname || x.id, x.role].filter(Boolean).join(' (') + (x.role ? ')' : '')).join(', '), 200),
      url: url ? `${url}/#candidates=${encodeURIComponent(batch)}` : '',
    });
  }
  for (const s of raw.sessions?.sessions || []) {
    if (!(s.pending_count > 0)) continue;
    const history = raw.sessionDetail?.[s.project_id]?.history || [];
    const last = history.length ? history[history.length - 1] : null;
    const signoff = last ? SIGNOFF.test(last.text || '') : false;
    waiting.push({
      key: 'session:' + s.project_id, kind: signoff ? 'sign-off' : 'answer',
      title: `${signoff ? 'Sign off' : 'Answer needed'}: ${nameOf(s.project_id)}`,
      detail: last ? clip(last.text, 200) : `${s.pending_count} message${s.pending_count === 1 ? '' : 's'} waiting for your answer`,
      url: url ? `${url}/#ceo-session=${encodeURIComponent(s.project_id)}` : '',
    });
  }

  const count = (s) => employees.filter((e) => e.status === s).length;
  return { employees, waiting, counts: { total: employees.length, working: count('working'), in_meeting: count('in_meeting'), idle: count('idle') } };
}

const EMPTY = { employees: [], waiting: [], counts: { total: 0, working: 0, in_meeting: 0, idle: 0 } };

// Keeps one view of the office current and calls onChange(view) when it changes.
//   state 'unconfigured': no agents.url         'up': answering
//   state 'reconnecting': it answered less than graceSeconds ago (it restarts itself after every
//                         hire); the last rows stay on the page
//   state 'down': not running, or it refused the token
export function watchOffice(config, { onChange = () => {}, log = () => {}, fetchImpl = globalThis.fetch, WS = globalThis.WebSocket } = {}) {
  const cfg = { ...AGENTS_DEFAULTS, ...(config || {}) };
  let base = String(cfg.url || '').trim().replace(/\/+$/, '');
  let problem = '';
  if (base) { try { if (!/^https?:$/.test(new URL(base).protocol)) throw 0; } catch { problem = 'agents.url in local/config.json is not an http address.'; base = ''; } }
  const fixed = { url: base, tokensAvailable: !!cfg.employeesDir, live: false, seen: '' };
  let view = base ? { ...fixed, ...EMPTY, state: 'down', reason: 'Checking the office…' }
    : { ...fixed, ...EMPTY, state: 'unconfigured', reason: problem || 'No agent office is set. Add agents.url to local/config.json to watch one.' };
  let lastOk = 0, lostAt = 0, restarting = false, busy = false, again = false, stopped = false;
  let timer = null, debounce = null, ws = null;

  const same = (a, b) => JSON.stringify({ ...a, seen: '' }) === JSON.stringify({ ...b, seen: '' });
  function set(next) {
    const changed = !same(view, next);
    if (changed && next.state !== view.state) log(`agents: office ${next.state}${next.state === 'up' ? ` (${next.counts.total} employees, ${next.waiting.length} waiting on the owner)` : next.reason ? ': ' + next.reason : ''}`);
    view = next;
    if (changed) onChange(view);
  }

  async function get(p, token) {
    const r = await fetchImpl(base + p, { headers: token ? { [TOKEN_HEADER]: token } : {}, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) { const e = new Error('unauthorized'); e.unauthorized = true; throw e; }
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.json();
  }

  async function refresh() {
    if (!base || stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const token = readToken(cfg.tokenFile);
      const [state, employees] = await Promise.all([get('/api/state', token), get('/api/employees', token)]);
      const soft = (p) => get(p, token).catch(() => null);
      const [sessions, candidates, projects] = await Promise.all([soft('/api/ceo/sessions'), soft('/api/candidates/pending'), soft('/api/projects')]);
      const pending = (sessions?.sessions || []).filter((s) => s.pending_count > 0).slice(0, 8);
      const details = await Promise.all(pending.map((s) => soft('/api/ceo/sessions/' + String(s.project_id).split('/').map(encodeURIComponent).join('/'))));
      const sessionDetail = Object.fromEntries(pending.map((s, i) => [s.project_id, details[i]]));
      lastOk = Date.now(); lostAt = 0; restarting = false;
      const built = buildView({ state, employees, sessions, sessionDetail, candidates, projects }, { url: base, tokensFor: (id) => usageTotals(cfg.employeesDir, id) });
      set({ ...fixed, live: view.live, seen: new Date(lastOk).toISOString(), state: 'up', reason: '', ...built });
      openSocket(token);
    } catch (e) {
      const seen = lastOk ? new Date(lastOk).toISOString() : '';
      if (e.unauthorized) {
        set({ ...fixed, seen, ...EMPTY, state: 'down', reason: cfg.tokenFile ? 'The office refused the token in agents.tokenFile.' : 'The office asks for a token. Set agents.tokenFile in local/config.json.' });
      } else if (lastOk && Date.now() - (lostAt = lostAt || Date.now()) < cfg.graceSeconds * 1000) {   // the grace runs from the first miss
        set({ ...view, live: false, seen, state: 'reconnecting', reason: restarting ? 'The office is restarting.' : 'The office stopped answering. Trying again.' });
      } else {
        set({ ...fixed, seen, ...EMPTY, state: 'down', reason: 'The office is not running.' });
      }
    } finally {
      busy = false;
      if (again) { again = false; soon(); }
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    const ms = view.state === 'up' ? cfg.pollSeconds * 1000 : view.state === 'reconnecting' ? 3000 : 15000;
    timer = setTimeout(refresh, ms);
    timer.unref?.();
  }
  function soon() {
    clearTimeout(debounce);
    if (stopped) return;
    debounce = setTimeout(refresh, 300);
    debounce.unref?.();
  }

  function openSocket(token) {
    if (ws || !WS || stopped) return;
    let sock;
    try { sock = new WS(base.replace(/^http/, 'ws') + '/ws', { headers: token ? { [TOKEN_HEADER]: token } : {} }); } catch { return; }
    ws = sock;
    sock.addEventListener('open', () => { if (ws === sock && view.state === 'up') set({ ...view, live: true }); });
    sock.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || QUIET.has(m.type)) return;
      if (m.type === 'backend_restart_scheduled') restarting = true;
      soon();
    });
    const gone = () => { if (ws !== sock) return; ws = null; if (view.live) set({ ...view, live: false }); soon(); };
    sock.addEventListener('close', gone);
    sock.addEventListener('error', gone);
  }

  if (base) refresh();
  return {
    view: () => view,
    refresh,
    stop() { stopped = true; clearTimeout(timer); clearTimeout(debounce); const s = ws; ws = null; try { s?.close(); } catch {} },
  };
}
