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
                      // when the office's /api/budget has no figure for that employee
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
//          projects: GET /api/projects, sprintRooms: GET /api/sprint-rooms, budget: GET /api/budget,
//          replacements: GET /api/hr/replacements }
// Everything after employees is optional: an office without a route simply has nothing there.
export function buildView(raw, { url = '', tokensFor = () => null } = {}) {
  const st = raw.state || {};
  const tasks = (st.active_tasks || []).filter((t) => t && !DONE.test(t.status || ''));
  const projectName = Object.fromEntries((raw.projects?.projects || []).map((p) => [String(p.project_id), p.task || p.name || '']));
  const nameOf = (pid) => clip(projectName[String(pid).split('/')[0]] || String(pid).split('/')[0], 70);
  const idOf = (e) => String(e.id ?? e.employee_number ?? '');
  const said = Object.fromEntries((raw.employees || []).map((e) => [idOf(e), String(e.status || '')]));
  const label = (id) => { const e = (raw.employees || []).find((x) => idOf(x) === String(id)); return clip(e ? e.nickname || e.name || id : id, 40); };

  // A meeting room stays booked for a while after its meeting can end, and the one who called the
  // meeting (booked_by) is not among its participants. So a booked room holds a meeting only while
  // somebody in it, chair included, is in a meeting; then the chair counts as in it too.
  const seated = (r) => [...new Set([r.booked_by, ...(r.participants || [])].map((x) => String(x ?? '')).filter(Boolean))];
  const meetings = (st.meeting_rooms || []).filter((r) => r && r.is_booked && seated(r).some((id) => said[id] === 'in_meeting'));
  // Sprint rooms: the team of an open room sits in it while the room is open.
  const sprints = (Array.isArray(raw.sprintRooms) ? raw.sprintRooms : raw.sprintRooms?.rooms || [])
    .filter((r) => r && (r.status || 'open') === 'open');

  // Tokens: the office's own budget figure when it has one for the employee (what its caps count:
  // input, output, cache writes and cache reads, in the cap's window); else the usage log's count.
  const budgetRow = (id) => (raw.budget?.employees?.[id]?.status || []).find((s) => s && s.metric === 'tokens');
  const tokensOf = (id) => {
    const b = budgetRow(id);
    if (b) return { source: 'budget', tokens: b.observed || 0, window: b.window || '', limit: b.limit || 0, percent: b.percent ?? 0, state: b.state || '' };
    const u = tokensFor(id);
    return u ? { source: 'usage', ...u } : null;
  };

  const employees = (raw.employees || []).map((e) => {
    const id = idOf(e);
    const running = tasks.find((t) => String(t.current_owner) === id && t.status === 'processing');
    let status = e.needs_setup ? 'setup' : e.api_online === false ? 'offline' : String(e.status || 'idle');
    if (status === 'idle' && running) status = 'working';
    const meeting = meetings.find((r) => seated(r).includes(id));
    if (status === 'idle' && meeting) status = 'in_meeting';
    const sprint = sprints.find((r) => (r.team || []).map(String).includes(id));
    const room = meeting || sprint;
    return {
      id, name: clip(e.name || e.nickname || id, 60), nickname: e.nickname && e.nickname !== e.name ? clip(e.nickname, 30) : '',
      role: clip(e.role || e.department || '', 30), status,
      // The office can leave an old summary on an employee whose task was cancelled: idle means no task.
      task: status === 'idle' ? '' : clip(e.current_task_summary || running?.task || '', 160),
      project: running ? nameOf(running.project_id) : '',
      room: room ? clip(room.name || room.id, 40) : '',
      roomKind: meeting ? 'meeting' : sprint ? 'sprint' : '',
      chair: !!meeting && String(meeting.booked_by) === id,
      model: clip(e.llm_model || '', 30),
      tokens: tokensOf(id),
    };
  }).sort((a, b) => (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2) || a.id.localeCompare(b.id));
  const tokenSource = employees.some((e) => e.tokens?.source === 'budget') ? 'budget' : employees.some((e) => e.tokens) ? 'usage' : '';
  const windows = [...new Set(employees.filter((e) => e.tokens?.source === 'budget').map((e) => e.tokens.window))];

  // What only the owner can settle. The office has no page addresses for most of these, so each
  // link opens the office with the item named after the #: the office opens that item by itself.
  const waiting = [];
  const budgetSession = String(raw.budget?.session || 'budget-caps');
  const replaceSession = String(raw.replacements?.session || 'hr-replacements');
  const sessionLink = (pid) => (url ? `${url}/#ceo-session=${encodeURIComponent(pid)}` : '');
  // A budget cap reached: the scope stays paused until the owner keeps it paused or raises the cap.
  for (const i of raw.budget?.incidents || []) {
    if (!i || i.status !== 'open') continue;
    const scope = i.scope_type === 'employee' ? label(i.scope_id) : i.scope_type === 'project' ? nameOf(i.scope_id) : 'the whole office';
    const when = i.window === 'day' ? ' today' : '';
    waiting.push({
      key: 'budget:' + i.id, kind: 'budget', title: `Budget pause: ${scope}`,
      detail: `${Number(i.observed || 0).toLocaleString('en-US')} of ${Number(i.limit || 0).toLocaleString('en-US')} ${i.metric || 'tokens'}${when}. Nothing runs for it until you keep it paused or raise the cap.`,
      url: sessionLink(budgetSession),
    });
  }
  // HR fired someone and drafted the role card of the replacement: nobody is hired until the owner answers.
  for (const r of raw.replacements?.requests || []) {
    if (!r || r.status !== 'open') continue;
    const who = clip(r.fired?.nickname || r.fired?.name || r.fired?.id || 'an employee', 40);
    const parked = (r.parked || []).length;
    waiting.push({
      key: 'replace:' + r.id, kind: 'replacement', title: `Approve a replacement for ${who}`,
      detail: clip([r.fired?.reason, parked ? `${parked} task${parked === 1 ? '' : 's'} parked until the new hire starts.` : ''].filter(Boolean).join(' '), 200),
      url: url ? `${url}/replacement.html#${encodeURIComponent(r.id)}` : '',
    });
  }
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
    const pid = String(s.project_id);
    // The budget and replacement sessions are not projects. Their items are listed above when the
    // office answers those routes; an office that does not still gets them named for what they are.
    if ((pid === budgetSession && raw.budget) || (pid === replaceSession && raw.replacements)) continue;
    const history = raw.sessionDetail?.[s.project_id]?.history || [];
    const last = history.length ? history[history.length - 1] : null;
    const signoff = last ? SIGNOFF.test(last.text || '') : false;
    const kind = pid === budgetSession ? 'budget' : pid === replaceSession ? 'replacement' : signoff ? 'sign-off' : 'answer';
    waiting.push({
      key: 'session:' + s.project_id, kind,
      title: kind === 'budget' ? 'Budget pause: answer needed' : kind === 'replacement' ? 'Replacement: answer needed'
        : `${signoff ? 'Sign off' : 'Answer needed'}: ${nameOf(s.project_id)}`,
      detail: last ? clip(last.text, 200) : `${s.pending_count} message${s.pending_count === 1 ? '' : 's'} waiting for your answer`,
      url: sessionLink(pid),
    });
  }

  const count = (s) => employees.filter((e) => e.status === s).length;
  return {
    employees, waiting, tokenSource, tokenWindow: windows.length === 1 ? windows[0] : '',
    counts: { total: employees.length, working: count('working'), in_meeting: count('in_meeting'), idle: count('idle') },
  };
}

const EMPTY = { employees: [], waiting: [], tokenSource: '', tokenWindow: '', counts: { total: 0, working: 0, in_meeting: 0, idle: 0 } };

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
      const [sessions, candidates, projects, sprintRooms, budget, replacements] = await Promise.all([
        soft('/api/ceo/sessions'), soft('/api/candidates/pending'), soft('/api/projects'),
        soft('/api/sprint-rooms'), soft('/api/budget'), soft('/api/hr/replacements'),
      ]);
      const pending = (sessions?.sessions || []).filter((s) => s.pending_count > 0).slice(0, 8);
      const details = await Promise.all(pending.map((s) => soft('/api/ceo/sessions/' + String(s.project_id).split('/').map(encodeURIComponent).join('/'))));
      const sessionDetail = Object.fromEntries(pending.map((s, i) => [s.project_id, details[i]]));
      lastOk = Date.now(); lostAt = 0; restarting = false;
      const built = buildView({ state, employees, sessions, sessionDetail, candidates, projects, sprintRooms, budget, replacements }, { url: base, tokensFor: (id) => usageTotals(cfg.employeesDir, id) });
      // The office's budget gives numbers even without the employees folder.
      set({ ...fixed, live: view.live, seen: new Date(lastOk).toISOString(), state: 'up', reason: '', ...built, tokensAvailable: fixed.tokensAvailable || built.tokenSource === 'budget' });
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
