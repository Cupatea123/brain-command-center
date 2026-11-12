// Tests for jev.mjs with the HTTP call mocked: node --test tests/jev.test.mjs
// Nothing here reaches the network. A real fetch would fail the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, buildRequests, rankWithJev, scrub, JEV_URL, LEVELS } from '../jev.mjs';

globalThis.fetch = () => { throw new Error('a test tried to use the real network'); };

const KEY = 'test-key-not-real';
const NOW = new Date('2026-10-20T18:00:00Z');
const row = (key, calls, tokens, ms, last = '2026-10-19T12:00') => ({ key, name: key, calls, tokens, ms, last, cache_read: 999999 });
const SNAPSHOT = {
  usage: {
    window_days: 30,
    skills: [row('notes', 10, 500000, 3000000), row('pack:research', 2, 800000, 2400000), row('tidy', 4, 40000, 240000), row('carried-over', 0, 9000, 1000)],
    connectors: [row('mail', 5, 100, 100)],
    agents: [row('Explore', 3, 100, 100)],
  },
  scorecard: {
    skills: [
      { key: 'notes', description: 'Files notes into the vault at E:\\Example\\Vault and commits them.', session_id: 'never-sent' },
      { key: 'pack:research', description: 'Researches a topic across many sources.' },
      { key: 'tidy' },
    ],
  },
  projects: [{ name: 'Secret Project' }],
  vault: 'E:\\Example\\Vault',
};

// A stand-in for api.typesafe.ai that scores by a table and records what it was sent.
function fakeJev(scoreOf, { fail = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const status = fail.shift();
    if (status) return { ok: false, status, json: async () => ({ detail: `refused, key ${KEY}` }) };
    const body = calls.at(-1).body;
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const s = scoreOf(q.instructions.skill.name);
      if (s === undefined) continue;
      answers[id] = { type: 'score', score: s, confidence: 0.6, legend: {}, probabilities: { 0: 0.1, [Math.round(s)]: 0.9 } };
    }
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.14.0', answers, usage: { input_tokens: 1200, output_tokens: 30 } }) };
  };
  return { fetchImpl, calls };
}

test('only the skills in use are candidates, with only the fields that are sent', () => {
  const c = candidates(SNAPSHOT);
  assert.deepEqual(c.map((s) => s.name), ['notes', 'pack:research', 'tidy']);
  assert.deepEqual(Object.keys(c[0]), ['name', 'description', 'calls', 'tokens_per_call', 'minutes_per_call', 'share_of_tokens_pct', 'last_used']);
  assert.deepEqual(c[0], { name: 'notes', description: 'Files notes into the vault at [path] and commits them.', calls: 10, tokens_per_call: 50000, minutes_per_call: 5, share_of_tokens_pct: 37, last_used: '2026-10-19' });
  assert.equal(c[2].description, '');
});

test('paths are taken out of descriptions', () => {
  assert.equal(scrub('Reads D:\\Vault\\notes and /home/me/.config/tool then stops.'), 'Reads [path] and [path] then stops.');
  assert.equal(scrub('Use for /brain, and/or a 1/2 split.'), 'Use for /brain, and/or a 1/2 split.');
});

test('one Score question per skill, in one request when it fits', () => {
  const reqs = buildRequests(candidates(SNAPSHOT));
  assert.equal(reqs.length, 1);
  const { body, ids } = reqs[0];
  assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
  assert.equal(Object.keys(body.questions).length, 3);
  assert.deepEqual(Object.values(ids), ['notes', 'pack:research', 'tidy']);
  for (const q of Object.values(body.questions)) {
    assert.equal(q.type, 'score');
    assert.deepEqual(q.criteria, LEVELS);
    assert.equal(q.instructions.skill.name.length > 0, true);
  }
  assert.equal(body.state.skills_in_use, 3);
  assert.equal(body.questions.skill_2.instructions.skill.description, 'No description is available for this skill.');
  assert.equal(buildRequests(candidates(SNAPSHOT), { budget: 400 }).length, 3);   // split only when a request would be too large
});

test('a run sends the key to api.typesafe.ai only, and nothing but names, descriptions and usage numbers', async () => {
  const jev = fakeJev((name) => ({ notes: 3.2, 'pack:research': 1.1, tidy: 2.4 }[name]));
  const result = await rankWithJev({ snapshot: SNAPSHOT, apiKey: KEY, fetchImpl: jev.fetchImpl, now: NOW });
  assert.equal(jev.calls.length, 1);
  assert.equal(jev.calls[0].url, JEV_URL);
  assert.equal(jev.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const sent = jev.calls[0].init.body;
  for (const never of [KEY, 'Example', 'Vault', 'Secret Project', 'never-sent', 'carried-over', 'cache_read', '999999', 'mail', 'Explore']) assert.equal(sent.includes(never), false, `sent "${never}"`);
  assert.deepEqual(result.ranks.map((r) => [r.key, r.rank, r.score]), [['notes', 1, 3.2], ['tidy', 2, 2.4], ['pack:research', 3, 1.1]]);
  assert.deepEqual(result.usage, { input_tokens: 1200, output_tokens: 30 });
  assert.equal(result.at, NOW.toISOString());
  assert.equal(result.model, 'jev-1.14.0');
  assert.equal(result.sent.skills, 3);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('a tie is broken in code by tokens per call', async () => {
  const jev = fakeJev(() => 2);
  const result = await rankWithJev({ snapshot: SNAPSHOT, apiKey: KEY, fetchImpl: jev.fetchImpl });
  assert.deepEqual(result.ranks.map((r) => [r.key, r.tokens_per_call]), [['tidy', 10000], ['notes', 50000], ['pack:research', 400000]]);
});

test('a skill Jev did not score is listed as unranked, not given a rank', async () => {
  const jev = fakeJev((name) => (name === 'tidy' ? undefined : 2));
  const result = await rankWithJev({ snapshot: SNAPSHOT, apiKey: KEY, fetchImpl: jev.fetchImpl });
  assert.deepEqual(result.unranked, ['tidy']);
  assert.equal(result.ranks.length, 2);
});

test('a refused call is an error, and the error does not carry the key', async () => {
  const jev = fakeJev(() => 2, { fail: [401] });
  await assert.rejects(rankWithJev({ snapshot: SNAPSHOT, apiKey: KEY, fetchImpl: jev.fetchImpl }), (e) => /Jev answered 401/.test(e.message) && !e.message.includes(KEY));
});

test('a rate limit is retried, then answered', async () => {
  const jev = fakeJev(() => 2, { fail: [429] });
  const waits = [];
  const result = await rankWithJev({ snapshot: SNAPSHOT, apiKey: KEY, fetchImpl: jev.fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(jev.calls.length, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(result.ranks.length, 3);
});

test('no key or nothing in use: no call is made', async () => {
  const jev = fakeJev(() => 2);
  await assert.rejects(rankWithJev({ snapshot: SNAPSHOT, apiKey: '', fetchImpl: jev.fetchImpl }), /TYPESAFE_API_KEY is not set/);
  await assert.rejects(rankWithJev({ snapshot: { usage: { skills: [] } }, apiKey: KEY, fetchImpl: jev.fetchImpl }), /nothing to rank/);
  assert.equal(jev.calls.length, 0);
});
