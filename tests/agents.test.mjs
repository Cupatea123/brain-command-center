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
// raw(): an office without the sprint room, budget and replacement routes; full(): with them.
const raw = () => ({ state: fx('state.json'), employees: fx('employees.json'), sessions: fx('ceo_sessions.json'), sessionDetail: fx('ceo_session.json'), candidates: fx('candidates_pending.json'), projects: fx('projects.json') });
const full = () => ({ ...raw(), sprintRooms: fx('sprint_rooms.json'), budget: fx('budget.json'), replacements: fx('hr_replacements.json') });
// Three moments of a real run (an employee working in a sprint room, a review meeting, all idle),
// rebuilt from what the office sent with made-up names: tests/fixtures/office-run/<moment>.
const RUN = path.join(path.dirname(FIXTURES), 'office-run');
const moment = (m) => { const r = (n) => JSON.parse(fs.readFileSync(path.join(RUN, m, n), 'utf8')); return { state: r('state.json'), employees: r('employees.json'), projects: r('projects.json'), sprintRooms: r('sprint_rooms.json'), budget: r('budget.json'), sessions: r('ceo_sessions.json'), candidates: r('candidates_pending.json') }; };
const rows = (v) => Object.fromEntries(v.employees.map((e) => [e.id, e]));

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
  assert.deepEqual(v.waiting.map((w) => w.kind), ['hire', 'budget', 'replacement', 'sign-off', 'answer']);
  const [hire, budget, replace, sign, ask] = v.waiting;
  // without the budget and replacement routes their sessions still show, named for what they are
  assert.equal(budget.title, 'Budget pause: answer needed');
  assert.equal(budget.url, 'http://127.0.0.1:8000/#ceo-session=budget-caps');
  assert.equal(replace.title, 'Replacement: answer needed');
  assert.equal(hire.title, 'Choose a hire: 3 candidates');
  assert.match(hire.detail, /Data Analyst \(Analyst\), Copywriter \(Writer\)/);
  assert.equal(hire.url, 'http://127.0.0.1:8000/#candidates=9f3a1c2b');
  assert.equal(sign.title, 'Sign off: Weekly newsletter draft');
  assert.match(sign.detail, /Reply to confirm/);
  assert.equal(sign.url, 'http://127.0.0.1:8000/#ceo-session=c0ffee123456%2Fiter_001');
  assert.equal(ask.title, 'Answer needed: Landing page');
  assert.equal(new Set(v.waiting.map((w) => w.key)).size, 5);
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

test('a real run, working: the employee at work in a sprint room shows as working, with its task, project and room', () => {
  const v = buildView(moment('1-working'), { url: 'http://127.0.0.1:8000' });
  const by = rows(v);
  assert.deepEqual(v.counts, { total: 6, working: 2, in_meeting: 0, idle: 4 });
  assert.equal(by['00006'].status, 'working');
  assert.match(by['00006'].task, /^Page 1, for Wren/);
  assert.equal(by['00006'].project, 'Three short pages for the team handbook, kept in the room folder.');
  assert.equal(by['00006'].room, 'handbook-sprint', 'the open sprint room it works in is named');
  assert.equal(by['00006'].roomKind, 'sprint');
  assert.equal(by['00004'].status, 'working');
  assert.match(by['00004'].task, /dispatch each part/);
  assert.equal(by['00004'].room, '', 'the EA is not on the room\'s team');
  assert.equal(by['00009'].status, 'idle');
  assert.equal(by['00009'].room, 'handbook-sprint', 'a team member who is not working still sits in the room');
  assert.equal(by['00002'].room, '');
  assert.deepEqual(v.employees.slice(0, 2).map((e) => e.id), ['00004', '00006']);
});

test('a real run, the review meeting: everyone in it reads as in the meeting, the chair included', () => {
  const v = buildView(moment('2-meeting'));
  const by = rows(v);
  assert.deepEqual(v.counts, { total: 6, working: 0, in_meeting: 4, idle: 2 });
  // the chair booked the room and is not among its participants; the office has it idle
  assert.equal(by['00002'].status, 'in_meeting');
  assert.equal(by['00002'].chair, true);
  for (const id of ['00002', '00004', '00006', '00009']) {
    assert.equal(by[id].room, 'Town Hall', id);
    assert.equal(by[id].roomKind, 'meeting', id);
  }
  assert.equal(by['00006'].chair, false);
  assert.equal(by['00003'].status, 'idle');
  assert.equal(by['00003'].room, '');
});

test('a booked room whose meeting is over keeps nobody in a meeting', () => {
  const v3 = buildView(moment('3-idle'));
  assert.deepEqual(v3.counts, { total: 6, working: 0, in_meeting: 0, idle: 6 });
  assert.equal(rows(v3)['00002'].room, '');
  assert.equal(rows(v3)['00006'].room, 'handbook-sprint', 'the sprint room is still open');
  // the same moment with the room still marked booked, as the office can leave it
  const stale = moment('3-idle');
  Object.assign(stale.state.meeting_rooms[0], { is_booked: true, booked_by: '00002', participants: ['00004', '00006', '00009'] });
  const v = buildView(stale);
  const by = rows(v);
  assert.equal(v.counts.in_meeting, 0);
  for (const id of ['00002', '00004', '00009']) assert.equal(by[id].status, 'idle', id);
  for (const id of ['00002', '00004']) assert.equal(by[id].room, '', id);
  assert.equal(by['00006'].room, 'handbook-sprint', 'back in its sprint room, not in the old meeting');
  // a closed sprint room seats nobody
  const closed = moment('3-idle');
  closed.sprintRooms[0].status = 'closed';
  assert.equal(rows(buildView(closed))['00006'].room, '');
});

test('TOKENS: the office\'s budget figures when it answers its budget, the usage log only without one, never a mix', () => {
  const v = buildView(moment('1-working'), { tokensFor: () => ({ tokens: 5, cache_read: 0, turns: 1, runs: 1, last: '' }) });
  const by = rows(v);
  assert.equal(v.tokenSource, 'budget');
  assert.equal(v.tokenWindow, 'day');
  assert.deepEqual(by['00004'].tokens, { source: 'budget', tokens: 1910000, window: 'day', limit: 15000000, percent: 12, state: 'ok' });
  assert.equal(by['00009'].tokens.tokens, 0, 'a budget figure of 0 is a figure');
  assert.equal(by['00009'].tokens.source, 'budget');
  // only some employees in the budget: the others have no number, not the usage log's other count
  const part = raw();
  part.budget = { employees: { '00004': fx('budget.json').employees['00004'], '00003': { caps: {}, status: [] } } };
  const pv = buildView(part, { tokensFor: (id) => usageTotals(EMPLOYEES_DIR, id) });
  const p = rows(pv);
  assert.equal(pv.tokenSource, 'budget');
  assert.equal(p['00004'].tokens.source, 'budget');
  assert.equal(p['00004'].tokens.tokens, 1250000);
  assert.equal(p['00006'].tokens, null, 'has a usage log, but the table counts the budget\'s way');
  assert.equal(p['00003'].tokens, null, 'in the budget without a token figure: no number');
  assert.ok(pv.employees.every((e) => !e.tokens || e.tokens.source === 'budget'), 'one count in the whole table');
  // no budget at all: the usage log, as before
  const u = buildView(raw(), { tokensFor: (id) => usageTotals(EMPLOYEES_DIR, id) });
  assert.equal(u.tokenSource, 'usage');
  assert.equal(u.tokenWindow, '');
});

test('a budget pause waiting on the owner is in NEEDS with a link to the budget session', () => {
  const v = buildView(full(), { url: 'http://127.0.0.1:8000' });
  const b = v.waiting.filter((w) => w.kind === 'budget');
  assert.equal(b.length, 1, 'only the open request; the one already raised is not listed');
  assert.equal(b[0].key, 'budget:b0d9e1f2a3c4');
  assert.equal(b[0].title, 'Budget pause: Finch');
  assert.match(b[0].detail, /^1,520,000 of 1,500,000 tokens today\. Nothing runs for it/);
  assert.equal(b[0].url, 'http://127.0.0.1:8000/#ceo-session=budget-caps');
  assert.ok(!v.waiting.some((w) => w.key === 'session:budget-caps'), 'the budget session is not listed a second time');
  // a paused project and the whole office are named too
  const one = (i) => buildView({ employees: [], projects: fx('projects.json'), budget: { incidents: [{ id: 'x', status: 'open', metric: 'tokens', limit: 10, observed: 12, ...i }] } }).waiting[0].title;
  assert.equal(one({ scope_type: 'project', scope_id: 'a1b2c3d4e5f6', window: 'total' }), 'Budget pause: Team notes: pick an app');
  assert.equal(one({ scope_type: 'company', scope_id: 'company', window: 'day' }), 'Budget pause: the whole office');
});

test('a replacement waiting on the owner is in NEEDS with a link to its review page', () => {
  const v = buildView(full(), { url: 'http://127.0.0.1:8000' });
  const r = v.waiting.filter((w) => w.kind === 'replacement');
  assert.equal(r.length, 1, 'only the open request; the hired one is not listed');
  assert.equal(r[0].title, 'Approve a replacement for Quill');
  assert.match(r[0].detail, /below the bar.*2 tasks parked until the new hire starts\./);
  assert.equal(r[0].url, 'http://127.0.0.1:8000/replacement.html#4c5d6e7f8a9b');
  assert.ok(!v.waiting.some((w) => w.key === 'session:hr-replacements'), 'the replacement session is not listed a second time');
  assert.deepEqual(v.waiting.map((w) => w.kind), ['budget', 'replacement', 'hire', 'sign-off', 'answer']);
  // no office address: no link
  assert.equal(buildView(full()).waiting.find((w) => w.kind === 'replacement').url, '');
});

test('the stand-in office serves a moment of the run: the budget gives the numbers without the employees folder', async () => {
  const office = await startFakeOffice({ dir: path.join(RUN, '2-meeting') });
  const w = watchOffice({ url: office.url }, { WS: null });
  try {
    assert.ok(await until(() => w.view().state === 'up'));
    const v = w.view();
    assert.equal(v.counts.in_meeting, 4);
    assert.equal(v.tokensAvailable, true);
    assert.equal(v.tokenSource, 'budget');
    assert.deepEqual(v.waiting, []);
    assert.ok(office.seen.some((r) => r.path === '/api/hr/replacements'), 'asked for replacements even though this office has none');
  } finally { w.stop(); await office.close(); }
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
    assert.deepEqual(v.waiting.map((w) => w.kind), ['budget', 'replacement', 'hire', 'sign-off', 'answer']);
    assert.equal(v.tokensAvailable, true);
    assert.equal(v.tokenSource, 'budget');
    assert.equal(v.employees.find((e) => e.id === '00006')?.room, 'app-pick', 'the sprint room was read');
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

// What a real run showed. One failed read of the budget switched the whole TOKENS column to
// the usage log for one poll; one failed read of /api/state left the header on "polling" for good.
test('one failed budget read keeps the last budget figures and says how old they are', async () => {
  const office = await startFakeOffice();
  const lines = [];
  const w = watchOffice({ url: office.url, employeesDir: EMPLOYEES_DIR, pollSeconds: 3600 }, { log: (l) => lines.push(l) });
  const tok = () => w.view().employees.map((e) => [e.id, e.tokens?.source ?? null, e.tokens?.tokens ?? null]);
  try {
    assert.ok(await until(() => w.view().state === 'up'));
    const before = tok();
    const read = w.view().seen;
    assert.equal(w.view().tokenSource, 'budget');
    assert.equal(w.view().budgetAsOf, '', 'fresh figures carry no time of their own');
    office.fail('budget.json', { status: 500 });
    await new Promise((r) => setTimeout(r, 20));
    await w.refresh();
    assert.equal(w.view().state, 'up');
    assert.equal(w.view().tokenSource, 'budget', 'still the budget, not the usage log');
    assert.deepEqual(tok(), before, 'every row keeps its figure');
    assert.equal(w.view().budgetAsOf, read, 'the figures say when they were read');
    assert.ok(w.view().seen > read, 'the rest of the view is newer');
    assert.ok(lines.some((l) => /budget did not answer/.test(l)));
    office.fail('budget.json', { status: 404 });   // a missing answer is the same
    await w.refresh();
    assert.deepEqual(tok(), before);
    assert.equal(w.view().budgetAsOf, read);
    await w.refresh();
    assert.equal(w.view().budgetAsOf, '', 'answered again: fresh figures');
    // a failed read of /api/state: the rows and their figures stay, the view says why
    office.fail('state.json', { status: 500 });
    await w.refresh();
    assert.equal(w.view().state, 'reconnecting');
    assert.match(w.view().reason, /HTTP 500 on \/api\/state/);
    assert.deepEqual(tok(), before);
    await w.refresh();
    assert.equal(w.view().state, 'up');
    assert.deepEqual(tok(), before);
  } finally { w.stop(); await office.close(); }

  // an office that has never answered its budget: the usage log, as without a budget route
  const never = await startFakeOffice();
  never.fail('budget.json', { status: 500 });
  const w2 = watchOffice({ url: never.url, employeesDir: EMPLOYEES_DIR, pollSeconds: 3600 }, { WS: null });
  try {
    assert.ok(await until(() => w2.view().state === 'up'));
    assert.equal(w2.view().tokenSource, 'usage');
    assert.equal(w2.view().budgetAsOf, '');
    assert.equal(rows(w2.view())['00006'].tokens.tokens, 1000);
  } finally { w2.stop(); await never.close(); }
});

test('live comes back: after a failed read with the stream still open, and after the office drops the stream', async () => {
  const office = await startFakeOffice();
  const w = watchOffice({ url: office.url, pollSeconds: 3600 }, {});
  const upgrades = () => office.seen.filter((r) => r.path === '/ws').length;
  try {
    assert.ok(await until(() => w.view().state === 'up' && w.view().live));
    office.fail('state.json', { status: 500 });
    await w.refresh();
    assert.equal(w.view().live, false, 'not live while the reads fail');
    await w.refresh();
    assert.equal(w.view().state, 'up');
    assert.equal(w.view().live, true, 'the stream never closed: live again with the next good read');
    assert.equal(upgrades(), 1, 'the same stream');

    office.drop();
    assert.ok(await until(() => upgrades() === 2), 'a new stream was opened');
    assert.ok(await until(() => w.view().state === 'up' && w.view().live), 'live again once the new stream delivers');
    const reads = office.seen.filter((r) => r.path === '/api/employees').length;
    office.send({ type: 'agent_done', agent: 'EA', payload: {} });
    assert.ok(await until(() => office.seen.filter((r) => r.path === '/api/employees').length > reads, 1500), 'events on the new stream re-read the office');
  } finally { w.stop(); await office.close(); }
});

test('a status change sent as an event shows within a second, even while events keep coming', async () => {
  const office = await startFakeOffice();
  const w = watchOffice({ url: office.url, pollSeconds: 3600 }, {});
  const reads = () => office.seen.filter((r) => r.path === '/api/employees').length;
  let iv = null;
  try {
    assert.ok(await until(() => w.view().state === 'up' && w.view().live));
    const n0 = reads();
    // a busy office: an event every 150 ms for three seconds
    iv = setInterval(() => office.send({ type: 'tree_update', agent: '', payload: {} }), 150);
    const emps = fx('employees.json');
    emps.find((e) => e.id === '00002').status = 'working';
    emps.find((e) => e.id === '00002').current_task_summary = 'Screening candidates';
    office.set('employees.json', emps);
    const t0 = Date.now();
    office.send({ type: 'dispatch_status_change', agent: '', payload: { employee_id: '00002', status: 'dispatched' } });
    assert.ok(await until(() => w.view().employees.find((e) => e.id === '00002')?.status === 'working', 1000), 'shown within a second');
    const lag = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 3000 - lag));
    clearInterval(iv); iv = null;
    const n = reads() - n0;
    assert.ok(n >= 3 && n <= 7, `under two reads a second while events keep coming (${n} in 3 s)`);
  } finally { if (iv) clearInterval(iv); w.stop(); await office.close(); }
});
