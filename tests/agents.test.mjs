// The AGENTS panel's reader (agents.mjs) against the fixtures and the stand-in office.
// node --test tests/agents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView, usageTotals, readToken, watchOffice } from '../agents.mjs';
import { startFakeOffice, FIXTURES } from './fake-office.mjs';

const fx = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const EMPLOYEES_DIR = path.join(FIXTURES, 'employees');
const TOKEN = 'test-token-' + 'x'.repeat(24);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agents-'));
const tokenFile = path.join(tmp, 'local_token');
fs.writeFileSync(tokenFile, TOKEN + '\n');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}
const raw = () => ({ state: fx('state.json'), employees: fx('employees.json'), sessions: fx('ceo_sessions.json'), sessionDetail: fx('ceo_session.json'), candidates: fx('candidates_pending.json'), projects: fx('projects.json') });

test('every employee gets a status, a task, a room and tokens', () => {
  const v = buildView(raw(), { url: 'http://127.0.0.1:8000', tokensFor: (id) => usageTotals(EMPLOYEES_DIR, id) });
  const by = Object.fromEntries(v.employees.map((e) => [e.id, e]));
  assert.equal(v.employees.length, 6);
  assert.deepEqual(v.counts, { total: 6, working: 2, in_meeting: 1, idle: 1 });
  assert.equal(by['00004'].status, 'working');
  assert.match(by['00004'].task, /app shortlist/);
  // idle on disk but the office is running a task for them: working, with the task and its project
  assert.equal(by['00006'].status, 'working');
  assert.match(by['00006'].task, /Compare three note-taking apps/);
  assert.equal(by['00006'].project, 'Team notes: pick an app');
  assert.equal(by['00003'].status, 'in_meeting');
  assert.equal(by['00003'].room, 'War Room');
  assert.equal(by['00002'].room, '');
  assert.equal(by['00002'].task, '', 'a finished task is not a current task');
  assert.equal(by['00005'].status, 'offline');
  assert.equal(by['00007'].status, 'setup');
  assert.equal(by['00007'].task, '', 'a queued task is not shown as being worked on');
  assert.deepEqual(v.employees.map((e) => e.status), ['working', 'working', 'in_meeting', 'idle', 'setup', 'offline']);
  assert.equal(by['00004'].tokens.tokens, 1400);
  assert.equal(by['00004'].tokens.cache_read, 12000);
  assert.equal(by['00004'].tokens.turns, 14);
  assert.equal(by['00006'].tokens.tokens, 1000);
  assert.equal(by['00002'].tokens, null, 'no usage file, no number');
});

test('an idle employee shows no task, even when the office left an old summary on it', () => {
  const v = buildView({ state: {}, employees: [
    { id: '00004', name: 'Jo EA', status: 'idle', current_task_summary: 'A task that was cancelled earlier' },
    { id: '00006', name: 'Finch', status: 'working', current_task_summary: 'Drafting the shortlist' },
  ] });
  const by = Object.fromEntries(v.employees.map((e) => [e.id, e]));
  assert.equal(by['00004'].task, '');
  assert.equal(by['00006'].task, 'Drafting the shortlist');
});

test('what waits on the owner: hire choices and pending answers, each with a link into the office', () => {
  const v = buildView(raw(), { url: 'http://127.0.0.1:8000' });
  assert.deepEqual(v.waiting.map((w) => w.kind), ['hire', 'sign-off', 'answer']);
  const [hire, sign, ask] = v.waiting;
  assert.equal(hire.title, 'Choose a hire: 3 candidates');
  assert.match(hire.detail, /Data Analyst \(Analyst\), Copywriter \(Writer\)/);
  assert.equal(hire.url, 'http://127.0.0.1:8000/#candidates=9f3a1c2b');
  assert.equal(sign.title, 'Sign off: Weekly newsletter draft');
  assert.match(sign.detail, /Reply to confirm/);
  assert.equal(sign.url, 'http://127.0.0.1:8000/#ceo-session=c0ffee123456%2Fiter_001');
  assert.equal(ask.title, 'Answer needed: Landing page');
  assert.equal(new Set(v.waiting.map((w) => w.key)).size, 3);
  // nothing pending, nothing listed
  const quiet = buildView({ ...raw(), sessions: { sessions: [] }, candidates: { batches: {} } });
  assert.deepEqual(quiet.waiting, []);
});

test('an office that answers with less still gives a view', () => {
  const v = buildView({ state: {}, employees: [{ employee_number: '00009', name: 'Solo' }] });
  assert.equal(v.employees[0].status, 'idle');
  assert.deepEqual(v.waiting, []);
  assert.deepEqual(buildView({}).employees, []);
});

test('tokens are summed from the usage log; no folder, no file or an odd id gives none', () => {
  assert.deepEqual(usageTotals(EMPLOYEES_DIR, '00004'), { tokens: 1400, cache_read: 12000, turns: 14, runs: 2, last: '2030-01-15T09:10:00+00:00' });
  assert.equal(usageTotals(EMPLOYEES_DIR, '00002'), null);
  assert.equal(usageTotals('', '00004'), null);
  assert.equal(usageTotals(EMPLOYEES_DIR, '../00004'), null);
  assert.equal(readToken(''), '');
  assert.equal(readToken(path.join(tmp, 'missing')), '');
  assert.equal(readToken(tokenFile), TOKEN);
});

test('no office configured: says so and never calls out', () => {
  const w = watchOffice({}, { fetchImpl: () => { throw new Error('must not fetch'); }, WS: null });
  assert.equal(w.view().state, 'unconfigured');
  assert.match(w.view().reason, /agents\.url/);
  assert.equal(watchOffice({ url: 'ftp://nope' }, { WS: null }).view().state, 'unconfigured');
  w.stop();
});

test('a running office: rows arrive, the token goes in a header only and never into the view', async () => {
  const office = await startFakeOffice({ token: TOKEN });
  const lines = [];
  const w = watchOffice({ url: office.url + '/', tokenFile, employeesDir: EMPLOYEES_DIR }, { log: (l) => lines.push(l) });
  try {
    assert.ok(await until(() => w.view().state === 'up' && w.view().live), 'office reached and event stream open');
    const v = w.view();
    assert.equal(v.employees.length, 6);
    assert.equal(v.waiting.length, 3);
    assert.equal(v.tokensAvailable, true);
    assert.equal(v.url, office.url);
    assert.ok(office.seen.length >= 6 && office.seen.every((r) => r.token === TOKEN), 'every request carried the token header');
    assert.ok(office.seen.every((r) => !r.query.includes(TOKEN) && !r.path.includes(TOKEN)), 'the token is never in an address');
    assert.ok(office.seen.some((r) => r.path === '/ws'), 'the event stream was opened');
    assert.ok(office.seen.some((r) => r.path === '/api/ceo/sessions/c0ffee123456/iter_001'), 'the pending session was read');
    const sent = JSON.stringify(v) + lines.join('\n');
    assert.ok(!sent.includes(TOKEN), 'the token is not in the view or the log');
    assert.ok(!sent.includes(tokenFile) && !sent.includes(EMPLOYEES_DIR), 'local paths are not in the view or the log');
  } finally { w.stop(); await office.close(); }
});

test('a wrong or missing token is reported as refused, not as not running', async () => {
  const office = await startFakeOffice({ token: TOKEN });
  const bad = path.join(tmp, 'wrong_token');
  fs.writeFileSync(bad, 'not-the-token');
  const w1 = watchOffice({ url: office.url, tokenFile: bad }, { WS: null });
  const w2 = watchOffice({ url: office.url }, { WS: null });
  try {
    assert.ok(await until(() => /refused the token/.test(w1.view().reason)));
    assert.equal(w1.view().state, 'down');
    assert.deepEqual(w1.view().employees, []);
    assert.ok(await until(() => /asks for a token/.test(w2.view().reason)));
  } finally { w1.stop(); w2.stop(); await office.close(); }
});

test('an event re-reads the office at once; chatter does not', async () => {
  const office = await startFakeOffice();
  const changes = [];
  const w = watchOffice({ url: office.url, pollSeconds: 3600 }, { onChange: (v) => changes.push(v) });
  try {
    assert.ok(await until(() => w.view().state === 'up' && w.view().live));
    const before = office.seen.length;
    office.send({ type: 'agent_log', agent: 'EA', payload: {} });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(office.seen.length, before, 'a log line does not cause a read');
    const emps = fx('employees.json');
    emps.find((e) => e.id === '00002').status = 'working';
    emps.find((e) => e.id === '00002').current_task_summary = 'Screening candidates';
    office.set('employees.json', emps);
    office.send({ type: 'agent_task_update', agent: 'HR', payload: {} });
    assert.ok(await until(() => w.view().employees.find((e) => e.id === '00002')?.task === 'Screening candidates', 3000), 'the change showed up without waiting for the poll');
    assert.ok(changes.length >= 2);
  } finally { w.stop(); await office.close(); }
});

test('the office restarting keeps the rows and comes back; staying away turns into not running', async () => {
  let office = await startFakeOffice();
  const port = office.port;
  const w = watchOffice({ url: office.url, graceSeconds: 60 }, {});
  try {
    assert.ok(await until(() => w.view().state === 'up' && w.view().live));
    office.send({ type: 'backend_restart_scheduled', agent: '', payload: {} });
    await office.close();
    await w.refresh();
    assert.ok(await until(() => w.view().state === 'reconnecting'));
    assert.equal(w.view().employees.length, 6, 'the last rows stay while it restarts');
    assert.match(w.view().reason, /restarting/);
    assert.equal(w.view().live, false);
    office = await startFakeOffice({ port });
    await w.refresh();
    assert.ok(await until(() => w.view().state === 'up' && w.view().live), 'back up, event stream reopened');
  } finally { w.stop(); await office.close(); }

  // the grace runs from the moment it went quiet, however long ago the last read was
  const late = await startFakeOffice();
  const w3 = watchOffice({ url: late.url, graceSeconds: 30, pollSeconds: 3600 }, { WS: null });
  const realNow = Date.now;
  try {
    assert.ok(await until(() => w3.view().state === 'up'));
    await late.close();
    Date.now = () => realNow() + 45000;
    await w3.refresh();
    assert.equal(w3.view().state, 'reconnecting', 'a read 45 s old does not use up a 30 s grace');
    Date.now = () => realNow() + 80000;
    await w3.refresh();
    assert.equal(w3.view().state, 'down');
  } finally { Date.now = realNow; w3.stop(); }

  const gone = await startFakeOffice();
  const w2 = watchOffice({ url: gone.url, graceSeconds: 0 }, { WS: null });
  try {
    assert.ok(await until(() => w2.view().state === 'up'));
    await gone.close();
    await w2.refresh();
    assert.ok(await until(() => w2.view().state === 'down'));
    assert.equal(w2.view().reason, 'The office is not running.');
    assert.deepEqual(w2.view().employees, []);
    assert.ok(w2.view().seen, 'when it was last seen is kept');
  } finally { w2.stop(); }
});
