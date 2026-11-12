// A stand-in for a OneManCompany office: serves the fixtures in tests/fixtures/office on the routes
// the AGENTS panel reads, asks for the same token header, and speaks just enough WebSocket to push
// events. Used by tests/agents.test.mjs, and runnable by hand to see the panel without an office:
//
//   node tests/fake-office.mjs [--port 8765] [--token-file <path>]
//
// With --token-file the file is created with a random test token if it does not exist, and every
// request must then carry it. Point agents.url and agents.tokenFile in local/config.json at it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures', 'office');
const ROUTES = { '/api/state': 'state.json', '/api/employees': 'employees.json', '/api/projects': 'projects.json', '/api/ceo/sessions': 'ceo_sessions.json', '/api/candidates/pending': 'candidates_pending.json' };

export function startFakeOffice({ port = 0, token = '', dir = FIXTURES } = {}) {
  const overrides = {};
  const sockets = new Set();
  const seen = [];   // every request: { path, token } so a test can check what was sent
  const read = (name) => (name in overrides ? overrides[name] : JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  const allowed = (req) => !token || req.headers['x-omc-token'] === token;

  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    seen.push({ path: p, token: req.headers['x-omc-token'] || '', query: new URL(req.url, 'http://x').search });
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (p.startsWith('/api/') && !allowed(req)) return json(401, { detail: 'Missing or invalid local token' });
    if (ROUTES[p]) return json(200, read(ROUTES[p]));
    if (p.startsWith('/api/ceo/sessions/')) return json(200, read('ceo_session.json')[p.slice('/api/ceo/sessions/'.length)] || { history: [], pending_count: 0 });
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Fake office</title><p>Fixture office for the AGENTS panel.</p>'); }
    return json(404, { detail: 'Not Found' });
  });

  server.on('upgrade', (req, socket) => {
    seen.push({ path: req.url, token: req.headers['x-omc-token'] || '', query: '' });
    if (new URL(req.url, 'http://x').pathname !== '/ws' || !allowed(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('data', (d) => { if ((d[0] & 0x0f) === 8) socket.end(); });   // a close frame
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    socket.write(frame({ type: 'connected', payload: { message: 'Bootstrap from REST API' } }));
  });

  function frame(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    return Buffer.concat([head, data]);
  }

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    sockets,
    set(name, value) { overrides[name] = value; },                           // replace one fixture
    send(obj) { for (const s of sockets) s.write(frame(obj)); },             // push an event to every listener
    close() { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const tokenFile = arg('--token-file', '');
  let token = '';
  if (tokenFile) {
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('base64url') + '\n');
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  }
  const office = await startFakeOffice({ port: Number(arg('--port', 8765)), token });
  console.log(`Fake office on ${office.url}${token ? ' (token required, read from the token file)' : ''}. Employees folder for agents.employeesDir: ${path.join(FIXTURES, 'employees')}`);
}
