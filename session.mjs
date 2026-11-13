// The director's one Claude Code session: how a call recovers when the CLI refuses its session id,
// and which failure the page shows. server.mjs owns the state; these functions only decide.
import crypto from 'node:crypto';

const IN_USE = /session id \S+ is already in use/i;
const MISSING = /no conversation found|session.*not found/i;

// runOnce() makes one CLI call with arguments built from the state as it is at that moment
// (--session-id while the session has not started, --resume once it has) and resolves to
// { code, out, err }. state carries sessionId, sessionStarted and sessionCost; save() persists it.
export async function callWithSession(runOnce, state, { save = () => {}, log = () => {}, newId = () => crypto.randomUUID() } = {}) {
  let r = await runOnce();
  // A first call that fails after the CLI has opened the session (a signed-out CLI, for one) still
  // leaves a transcript under the id, and the CLI then refuses --session-id for it on every later
  // call, which hides the real error. The session exists, so resume it.
  if (r.code !== 0 && !state.sessionStarted && IN_USE.test(r.err + r.out)) {
    log('director session id already has a transcript, resuming it');
    state.sessionStarted = true; save();
    r = await runOnce();
  }
  if (r.code !== 0 && state.sessionStarted && MISSING.test(r.err + r.out)) {
    log('director session missing, starting a new one');
    state.sessionId = newId(); state.sessionStarted = false; state.sessionCost = 0; save();
    r = await runOnce();
  }
  if (r.code === 0 && !state.sessionStarted) { state.sessionStarted = true; save(); }
  return r;
}

// What the page shows under WHERE I'M AT after a failed job: the reason for a refresh, without the
// wrapper, or null when the job was not a refresh (the last refresh failure stays as it was).
export function refreshFailure(label, message) {
  if (!/^refresh/.test(label)) return null;
  return String(message).replace(/^director refresh returned no structured output: /, '');
}
