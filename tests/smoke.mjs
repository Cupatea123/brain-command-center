// API smoke test for a running Command Center (node tests/smoke.mjs [prompt ...]).
// Checks the token and host guards, then sends each prompt to the director and prints the reply,
// the tools it used and any refused tools.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = fs.readFileSync(path.join(CC, 'data', 'token'), 'utf8').trim();
const PORT = Number(process.env.CC_PORT || 4317);
const BASE = `http://127.0.0.1:${PORT}`;

function req(p, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

function check(name, ok, extra = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) process.exitCode = 1; }

const page = await req('/');
check('page serves with token injected', page.status === 200 && page.body.includes(TOKEN));
check('api refuses a missing token', (await req('/api/state')).status === 401);
check('api refuses a foreign Host header', (await req('/api/state', { headers: { Host: `evil.example:${PORT}`, 'x-cc-token': TOKEN } })).status === 403);
const state = await req('/api/state', { headers: { 'x-cc-token': TOKEN } });
const st = JSON.parse(state.body);
check('state has a snapshot', !!st.snapshot, `files=${st.snapshot?.stats?.files} needs=${st.snapshot?.needs?.length}`);
console.log(`INFO  director output: ${st.director?.at || 'none yet'}`);
check('note endpoint refuses paths outside the vault', (await req('/api/note?rel=' + encodeURIComponent('..\\..\\secret.md'), { headers: { 'x-cc-token': TOKEN } })).status === 404);

const prompts = process.argv.slice(2);
for (const text of prompts) {
  const done = new Promise((resolve) => {
    const es = http.get(`${BASE}/api/events?token=${TOKEN}`, (res) => {
      let buf = '', id = null, tools = [];
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
          const data = (chunk.match(/^data: (.*)$/m) || [])[1];
          if (ev !== 'chat' || !data) continue;
          const j = JSON.parse(data);
          if (id && j.id !== id) continue;
          if (j.tool) tools.push(j.tool);
          if (j.done) { es.destroy(); resolve({ ...j, tools }); }
        }
      });
      setTimeout(async () => {
        const r = await req('/api/prompt', { method: 'POST', body: JSON.stringify({ text }), headers: { 'x-cc-token': TOKEN } });
        id = JSON.parse(r.body).id;
      }, 300);
    });
  });
  const t0 = Date.now();
  const res = await done;
  console.log(`\n=== PROMPT: ${text}\n--- ${Math.round((Date.now() - t0) / 1000)}s, $${(res.cost_usd || 0).toFixed(3)}, tools: ${[...new Set(res.tools)].join(', ') || 'none'}, refused: ${(res.denials || []).join(', ') || 'none'}\n${res.text}`);
}
