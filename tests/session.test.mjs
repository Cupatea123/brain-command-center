// Tests for session.mjs with the Claude Code CLI replaced by a stand-in: node --test tests/session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { callWithSession, refreshFailure } from '../session.mjs';

const SIGNED_OUT = { code: 1, out: '', err: 'Invalid API key. Please run /login' };
const OK = { code: 0, out: '{"result":"fine"}', err: '' };

// A stand-in CLI. It sees the flag server.mjs would pass for the state at that moment and answers
// from a table: in use (the id already has a transcript), missing (resume finds nothing) or a reply.
function fakeCli(state, { transcripts = new Set(), reply = () => OK } = {}) {
  const calls = [];
  const runOnce = async () => {
    const flag = state.sessionStarted ? '--resume' : '--session-id';
    calls.push(`${flag} ${state.sessionId}`);
    if (flag === '--session-id' && transcripts.has(state.sessionId)) return { code: 1, out: '', err: `Error: Session ID ${state.sessionId} is already in use.` };
    if (flag === '--resume' && !transcripts.has(state.sessionId)) return { code: 1, out: '', err: `No conversation found with session ID: ${state.sessionId}` };
    transcripts.add(state.sessionId);
    return reply(calls.length);
  };
  return { runOnce, calls };
}

test('a session id the CLI calls in use is resumed, and the real error comes through', async () => {
  // The first call ever was made signed out: the CLI wrote a transcript, then failed.
  const state = { sessionId: 'id-1', sessionStarted: false, sessionCost: 0 };
  const cli = fakeCli(state, { transcripts: new Set(['id-1']), reply: () => SIGNED_OUT });
  let saves = 0;
  const r = await callWithSession(cli.runOnce, state, { save: () => saves++ });
  assert.deepEqual(cli.calls, ['--session-id id-1', '--resume id-1']);
  assert.equal(r.err, SIGNED_OUT.err);                      // not "already in use"
  assert.equal(state.sessionStarted, true);
  assert.equal(state.sessionId, 'id-1');
  assert.equal(saves, 1);
});

test('once signed in, the next call resumes the same session and answers', async () => {
  const state = { sessionId: 'id-1', sessionStarted: false, sessionCost: 0 };
  const cli = fakeCli(state, { transcripts: new Set(['id-1']) });
  const r = await callWithSession(cli.runOnce, state);
  assert.equal(r.code, 0);
  assert.deepEqual(cli.calls, ['--session-id id-1', '--resume id-1']);
  const again = await callWithSession(cli.runOnce, state);
  assert.equal(again.code, 0);
  assert.deepEqual(cli.calls.slice(2), ['--resume id-1']);    // one call, no more --session-id
});

test('a first call that works starts the session', async () => {
  const state = { sessionId: 'id-1', sessionStarted: false, sessionCost: 0 };
  const cli = fakeCli(state);
  assert.equal((await callWithSession(cli.runOnce, state)).code, 0);
  assert.deepEqual(cli.calls, ['--session-id id-1']);
  assert.equal(state.sessionStarted, true);
});

test('a first call that fails for another reason is not retried and does not start the session', async () => {
  const state = { sessionId: 'id-1', sessionStarted: false, sessionCost: 0 };
  const cli = fakeCli(state, { reply: () => SIGNED_OUT });
  const r = await callWithSession(cli.runOnce, state);
  assert.equal(r.err, SIGNED_OUT.err);
  assert.deepEqual(cli.calls, ['--session-id id-1']);
  assert.equal(state.sessionStarted, false);
});

test('a resumed session the CLI no longer has is replaced by a new one', async () => {
  const state = { sessionId: 'gone', sessionStarted: true, sessionCost: 3.5 };
  const cli = fakeCli(state);
  const r = await callWithSession(cli.runOnce, state, { newId: () => 'id-2' });
  assert.equal(r.code, 0);
  assert.deepEqual(cli.calls, ['--resume gone', '--session-id id-2']);
  assert.deepEqual(state, { sessionId: 'id-2', sessionStarted: true, sessionCost: 0 });
});

test('only a refresh failure is shown, without its wrapper', () => {
  assert.equal(refreshFailure('refresh', 'director refresh returned no structured output: Not logged in'), 'Not logged in');
  assert.equal(refreshFailure('refresh (forced)', 'spawn claude ENOENT'), 'spawn claude ENOENT');
  assert.equal(refreshFailure('done for today', 'anything'), null);
  assert.equal(refreshFailure('prompt', 'anything'), null);
});
