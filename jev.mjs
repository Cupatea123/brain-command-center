// "Rank with Jev": one on-demand request that asks TypeSafe's Jev model how much value each skill
// in use gives for what it costs. Nothing here runs by itself: server.mjs calls rankWithJev() only
// from POST /api/jev/rank, after the page's confirm step.
//
// What leaves the machine, per skill used in the usage window: its name, its description, calls,
// tokens per call, minutes per call, its share of the tokens and the day it was last used. Never
// transcript text, prompts, file paths, project names or session ids.
//
// Request shape: https://docs.typesafe.ai/api/system-one.md (POST /v1/systemone, Bearer key,
// { model, state, questions }). There is no cap on questions per request, only on its size
// (64k tokens per request), so one request is the normal case.

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_HOST = 'api.typesafe.ai';
export const SENT_FIELDS = ['name', 'description', 'calls', 'tokens per call', 'minutes per call', 'share of tokens', 'last used'];
export const BASIS = 'Jev judged from the descriptions and the usage numbers. It has not seen the work the skills produced.';

// All the wording Jev sees is here. Score levels are situations, each readable on its own.
const ABOUT = (days) => `Usage of Claude Code skills on one person's computer over the last ${days} days. A skill is a packaged set of instructions the assistant loads to do one kind of task. Tokens are the new tokens spent while the skill was running (input, output and cache writes). Minutes are how long it ran.`;
const QUESTION = 'How much value does this skill give for what it costs?';
export const LEVELS = [
  'The skill uses far more tokens per call than the other skills in use, and its description names a narrow or occasional task that would not be missed.',
  'The skill uses more tokens per call than most of the other skills in use, for a task its description presents as routine.',
  'The skill does a useful task at a cost per call close to what the other skills in use take.',
  'The skill does a task its description presents as substantial or needed often, at a cost per call near or below the other skills in use.',
  'The skill does a substantial task that is needed often, and it uses clearly fewer tokens per call than the other skills in use.',
];

const REQUEST_TOKEN_BUDGET = 48000;   // under the 64k per-request context, with room for the estimate being rough
const MAX_SKILLS = 200;
const estimateTokens = (value) => Math.ceil(JSON.stringify(value).length / 3);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

// A description may name a folder; the folder stays here.
export function scrub(text) {
  return String(text || '')
    .replace(/[A-Za-z]:[\\/][^\s"'`,;)]*/g, '[path]')
    .replace(/(?<![\w.:/])~?\/(?:[\w.-]+\/)+[\w.-]*/g, '[path]')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

// The skills used in the window, with exactly the fields that are sent.
export function candidates(snapshot) {
  const rows = (snapshot?.usage?.skills || []).filter((r) => r.calls > 0).slice(0, MAX_SKILLS);
  const describe = Object.fromEntries((snapshot?.scorecard?.skills || []).map((s) => [s.key, s.description || '']));
  const total = rows.reduce((n, r) => n + (r.tokens || 0), 0);
  return rows.map((r) => ({
    name: r.key,
    description: scrub(describe[r.key]),
    calls: r.calls,
    tokens_per_call: Math.round((r.tokens || 0) / r.calls),
    minutes_per_call: Math.round(((r.ms || 0) / r.calls / 60000) * 10) / 10,
    share_of_tokens_pct: total ? Math.round((100 * (r.tokens || 0)) / total) : 0,
    last_used: String(r.last || '').slice(0, 10),
  }));
}

// One Score question per skill, each carrying its own skill; what they share goes in the state once.
export function buildRequests(skills, { model = 'jev-latest', windowDays = 30, budget = REQUEST_TOKEN_BUDGET } = {}) {
  const mid = median(skills.map((s) => s.tokens_per_call));
  const state = {
    about: ABOUT(windowDays), window_days: windowDays, skills_in_use: skills.length,
    median_tokens_per_call: Math.round(mid), median_minutes_per_call: Math.round(median(skills.map((s) => s.minutes_per_call)) * 10) / 10,
  };
  const question = (s) => ({
    type: 'score',
    instructions: {
      question: QUESTION,
      skill: {
        name: s.name,
        description: s.description || 'No description is available for this skill.',
        calls: s.calls,
        tokens_per_call: s.tokens_per_call,
        tokens_per_call_compared: mid ? `${(s.tokens_per_call / mid).toFixed(1)} times the median of the skills in use` : 'no median to compare with',
        minutes_per_call: s.minutes_per_call,
        share_of_tokens: `${s.share_of_tokens_pct}% of the tokens all skills in use spent`,
        last_used: s.last_used,
      },
    },
    criteria: LEVELS,
  });
  const requests = [];
  let cur = null;
  skills.forEach((s, i) => {
    const q = question(s);
    const size = estimateTokens(q);
    if (!cur || cur.size + size > budget) { cur = { body: { model, state, questions: {} }, ids: {}, size: estimateTokens(state) }; requests.push(cur); }
    cur.body.questions[`skill_${i}`] = q;   // question ids are not sent to the model
    cur.ids[`skill_${i}`] = s.name;
    cur.size += size;
  });
  return requests.map(({ body, ids }) => ({ body, ids }));
}

async function post(url, apiKey, body, fetchImpl, sleep) {
  const waits = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      throw new Error(`could not reach ${JEV_HOST}: ${e.name === 'TimeoutError' ? 'no answer within 60 s' : e.message}`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 529) && attempt < waits.length) { await sleep(waits[attempt]); continue; }
    let detail = '';
    try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j); } catch {}
    const hint = res.status === 401 ? ' (the key in TYPESAFE_API_KEY was refused)' : '';
    throw new Error(`Jev answered ${res.status}${hint}${detail ? ': ' + detail.slice(0, 300) : ''}`);
  }
}

// Sends the requests and turns the answers into a ranking. A failed call throws; it is never read as a rank.
export async function rankWithJev({ snapshot, apiKey, model = 'jev-latest', fetchImpl = globalThis.fetch, url = JEV_URL, now = new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const skills = candidates(snapshot);
  if (!skills.length) throw new Error('no skill was used in the usage window, so there is nothing to rank');
  const windowDays = snapshot?.usage?.window_days || 30;
  const requests = buildRequests(skills, { model, windowDays });
  const scores = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let answeredBy = model;
  try {
    for (const req of requests) {
      const res = await post(url, apiKey, req.body, fetchImpl, sleep);
      answeredBy = res.model || answeredBy;
      usage.input_tokens += res.usage?.input_tokens || 0;
      usage.output_tokens += res.usage?.output_tokens || 0;
      for (const [id, name] of Object.entries(req.ids)) {
        const a = res.answers?.[id];
        if (a?.type !== 'score' || typeof a.score !== 'number') continue;
        const probs = a.probabilities || {};
        const top = Object.keys(probs).sort((x, y) => probs[y] - probs[x])[0];
        scores[name] = { score: Math.round(a.score * 100) / 100, confidence: typeof a.confidence === 'number' ? Math.round(a.confidence * 100) / 100 : null, level: top === undefined ? null : Number(top) };
      }
    }
  } catch (e) {
    throw new Error(String(e.message || e).split(apiKey).join('[key]'));
  }
  const ranked = skills.filter((s) => scores[s.name]);
  if (!ranked.length) throw new Error('Jev returned no usable score');
  // The decision is in code: best score first, a tie goes to the skill that costs less per call.
  ranked.sort((a, b) => scores[b.name].score - scores[a.name].score || a.tokens_per_call - b.tokens_per_call || a.name.localeCompare(b.name));
  return {
    at: now.toISOString(), model: answeredBy, window_days: windowDays, requests: requests.length, usage,
    basis: BASIS, levels: LEVELS, sent: { host: JEV_HOST, skills: skills.length, fields: SENT_FIELDS },
    ranks: ranked.map((s, i) => ({ key: s.name, rank: i + 1, ...scores[s.name], calls: s.calls, tokens_per_call: s.tokens_per_call, minutes_per_call: s.minutes_per_call, share_of_tokens_pct: s.share_of_tokens_pct, last_used: s.last_used })),
    unranked: skills.filter((s) => !scores[s.name]).map((s) => s.name),
  };
}
