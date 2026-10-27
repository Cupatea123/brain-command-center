/* Command Center front end: panels, live events, command bar, day end. */
(function () {
  'use strict';
  const TOKEN = window.CC_TOKEN;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TAG_COLOR = { decision: '#A98BF5', task: '#FF7A1A', todo: '#4CC38A', routine: '#6EA8FE', deadline: '#F2B53A', system: '#8E8C84' };

  let S = { snapshot: null, director: null, day: null, session: null, sync: null, status: {}, config: {} };
  let map = null;
  const chats = new Map();

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'x-cc-token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }
  function toast(msg, ms = 4200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }
  function ddmm(iso) { return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : ''; }
  function hhmm(iso) { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? '–' : d.toTimeString().slice(0, 5); }
  function ago(iso) { if (!iso) return '–'; const m = Math.round((Date.now() - new Date(iso.replace(' ', 'T'))) / 60000); return isNaN(m) ? '–' : m < 1 ? 'now' : m < 60 ? m + ' MIN' : Math.round(m / 60) + ' H'; }
  function areaColor(key) { return (S.snapshot?.areas || []).find((a) => a.key === key)?.color || '#5B616B'; }
  function dayName(iso) { const d = new Date(iso + 'T00:00:00'); return DAYS[d.getDay()] + ' ' + ddmm(iso); }
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil(((t - y0) / 864e5 + 1) / 7); }

  // ---------------------------------------------------------------- clock
  function tick() {
    const d = new Date();
    $('clock-hm').textContent = d.toTimeString().slice(0, 5);
    $('clock-s').textContent = ':' + String(d.getSeconds()).padStart(2, '0');
    const s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    $('s-hand').setAttribute('transform', `rotate(${s * 6} 50 50)`);
    $('m-hand').setAttribute('transform', `rotate(${m * 6} 50 50)`);
    $('h-hand').setAttribute('transform', `rotate(${h * 30} 50 50)`);
    const off = -d.getTimezoneOffset() / 60;
    const tzName = (d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() || '').replace(/^[CEMP][SD]T$/, (z) => z[0] + 'T');
    $('tz').textContent = `${tzName} · UTC${off >= 0 ? '+' : '−'}${Math.abs(off)}`;
    $('today-week').textContent = `Wk${isoWeek(d)} · ${DAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()}`;
  }

  // ---------------------------------------------------------------- status strip
  function renderStatus() {
    const st = S.status || {};
    const busy = st.core === 'busy';
    $('core-state').textContent = busy ? (st.label || 'BUSY').toUpperCase() : 'IDLE';
    $('sig-core').classList.toggle('busy', busy);
    $('phase').textContent = busy && st.phase ? '› ' + st.phase + (st.queue > 1 ? ` (+${st.queue - 1} queued)` : '') : '';
    $('btn-refresh').disabled = busy && /refresh/.test(st.label || '');
    $('btn-dayend').disabled = busy && /done for today/.test(st.label || '');
    const snapAt = S.session?.lastSnapshotAt;
    $('runner-age').textContent = ago(snapAt);
    $('sig-runner').classList.toggle('stale', snapAt && Date.now() - new Date(snapAt) > 3600e3);
    $('sync-age').textContent = S.sync?.at ? ago(S.sync.at) : '–';
    $('sig-sync').classList.toggle('stale', !S.sync?.at || Date.now() - new Date(S.sync.at.replace(' ', 'T')) > 26 * 3600e3);
    $('data-at').textContent = S.snapshot ? `${S.snapshot.stats.tasks_open} open` : '–';
    $('brain-at').textContent = S.snapshot?.brain_changed ? hhmm(S.snapshot.brain_changed) : '–';
    const ctxK = S.session?.contextTokens ? Math.round(S.session.contextTokens / 1000) + 'k tokens' : '–';
    $('menu-session').textContent = `Director session ${S.session?.id ? S.session.id.slice(0, 8) : '–'}${S.session?.started ? '' : ' (not started)'} · model ${S.session?.model || '–'} · context ${ctxK} · spent $${(S.session?.cost || 0).toFixed(2)}`;
    $('console-session').textContent = S.session?.id ? S.session.id.slice(0, 8) : '';
  }

  // ---------------------------------------------------------------- left column
  function renderToday() {
    const s = S.snapshot; if (!s) return;
    $('today-date').textContent = dayName(s.today);
    const dl = (s.deadlines || [])[0];
    if (dl) { $('deadline').textContent = `${dayName(dl.date)} · in ${dl.days} d`; $('deadline-label').textContent = dl.label; }
    else { $('deadline').textContent = 'none'; $('deadline-label').textContent = ''; }
    const heat = $('heat'); heat.innerHTML = '';
    const weeks = s.heatmap?.weeks || {}; const cur = s.heatmap?.current_week || 0;
    const max = Math.max(1, ...Object.values(weeks));
    let total = 0;
    for (let q = 0; q < 4; q++) {
      heat.appendChild(el('span', 'q', 'Q' + (q + 1)));
      for (let i = 1; i <= 13; i++) {
        const w = q * 13 + i; const v = weeks[String(w)] || 0; total += v;
        const lvl = v === 0 ? '' : v >= max * 0.75 ? 'l4' : v >= max * 0.4 ? 'l3' : v >= max * 0.15 ? 'l2' : 'l1';
        const c = el('span', `c ${lvl} ${w === cur ? 'now' : ''} ${w > cur ? 'future' : ''}`);
        c.title = `Week ${w}: ${v} session note(s)`;
        heat.appendChild(c);
      }
    }
    $('heat-total').textContent = `${total} this year`;
    const list = $('next14'); list.innerHTML = '';
    const items = s.next14 || [];
    if (!items.length) list.appendChild(el('li', 'empty', 'Nothing dated in the next two weeks.'));
    for (const e of items.slice(0, 24)) {
      const li = el('li', e.date === s.today ? 'today' : '');
      const d = el('div', 'd', dayName(e.date)); if (e.time) d.appendChild(el('span', 't', e.time));
      const x = el('div', 'x', e.label); x.appendChild(el('span', 'tag', e.tag));
      li.append(d, x); list.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- center panels
  function renderDirector() {
    const d = S.director?.output;
    $('director-at').textContent = S.director?.at ? `director · ${hhmm(S.director.at)}` : 'director · not run yet';
    $('where').textContent = d?.where_im_at || 'The director writes this on the first refresh. It runs when you open the Command Center.';
    const f = $('focus'); f.innerHTML = '';
    for (const it of d?.focus || []) { const li = el('li'); li.append(el('span', 't', it.title), document.createTextNode(' '), el('span', 'w', it.why)); f.appendChild(li); }
    const b = d?.brief || d?.daily_brief;
    const shape = S.snapshot?.day_shape || b?.day_shape;
    $('brief-shape').textContent = shape ? shape.toUpperCase() + ' DAY' : '';
    $('brief-headline').textContent = b?.headline || 'Today’s brief appears after the first refresh of the day.';
    const acts = $('brief-acts'); acts.innerHTML = '';
    for (const a of b?.acts || []) { const div = el('div', 'act'); div.append(el('div', 'r', a.range), el('div', 'x', a.text)); acts.appendChild(div); }
    const notes = $('brief-notes'); notes.innerHTML = '';
    for (const n of b?.notes || []) notes.appendChild(el('li', '', n));
    const link = $('brief-link'); link.innerHTML = '';
    const cfg = S.config || {};
    const mb = cfg.briefUrl && (S.snapshot?.routines || []).find((r) => r.label === cfg.briefRoutine);
    if (mb && mb.status === 'FIRED') { const a = el('a', '', `Open today’s ${mb.label} ↗`); a.href = cfg.briefUrl; a.target = '_blank'; a.rel = 'noopener'; link.appendChild(a); }
    const res = $('resolved'); res.innerHTML = '';
    const rs = d?.resolved || [];
    if (!rs.length) res.appendChild(el('li', 'empty', 'Nothing closed since the last refresh.'));
    for (const r of rs) { const li = el('li'); li.style.setProperty('--area', '#4CC38A'); const body = el('div'); body.append(el('div', 'ft', r.title), el('div', 'fs', r.detail)); li.append(el('span', 'bul'), body); res.appendChild(li); }
    renderNeeds();
    renderProjects();
  }

  function renderProjects() {
    const s = S.snapshot; if (!s) return;
    const lines = Object.fromEntries((S.director?.output?.project_lines || []).map((p) => [p.name, p.line]));
    const wrap = $('projects'); wrap.innerHTML = '';
    const live = s.projects.filter((p) => !['archived', 'done'].includes(p.status));
    $('projects-count').textContent = `${live.filter((p) => p.type === 'project').length} projects · ${live.filter((p) => p.type === 'area').length} areas`;
    for (const p of live) {
      const t = el('div', 'tile'); t.style.setProperty('--area', areaColor(p.area));
      const tn = el('div', 'tn'); tn.append(el('span', '', p.name), el('span', `st ${p.status}`, p.type === 'area' ? 'area' : p.status));
      t.append(tn, el('div', 'tx', lines[p.name] || p.next || p.blocker || p.cadence || ''));
      t.title = p.blocker && !/^none/i.test(p.blocker) ? 'Blocker: ' + p.blocker : '';
      t.addEventListener('click', () => { map.focus(p.name); });
      wrap.appendChild(t);
    }
    const feed = $('sessions'); feed.innerHTML = '';
    for (const x of s.sessions.slice(0, 14)) {
      const li = el('li', 'click'); li.style.setProperty('--area', areaColor(x.area));
      const body = el('div'); body.append(el('div', 'fd', `${dayName(x.date)} · ${(x.projects || []).join(', ')}`), el('div', 'fs', x.summary));
      li.append(el('span', 'bul'), body); li.addEventListener('click', () => map.focus(x.slug)); feed.appendChild(li);
    }
    const todo = $('todo'); todo.innerHTML = '';
    $('todo-count').textContent = s.todo.length;
    for (const t of s.todo) {
      const li = el('li', t.owner_link ? 'click' : ''); li.style.setProperty('--area', areaColor((s.projects.find((p) => p.name === t.owner_link) || {}).area));
      const body = el('div'); body.append(el('div', 'fs', t.request), el('div', 'fd', `${dayName(t.date)} · ${t.owner_link || t.owner || 'new'}`));
      li.append(el('span', 'bul'), body); if (t.owner_link) li.addEventListener('click', () => map.focus(t.owner_link)); todo.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- right column
  // Needs are computed in code (snapshot.needs). The director adds up to three items the code cannot see.
  function mergedNeeds() {
    const d = S.director?.output || {}; const s = S.snapshot || {};
    const out = [...(s.needs || [])];
    // drop extras that restate a code item (same tag and most of the same words)
    const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    const dup = (x) => out.some((n) => {
      const a = words(x.title + ' ' + x.detail), b = words(n.title + ' ' + n.detail);
      let shared = 0; a.forEach((w) => { if (b.has(w)) shared++; });
      return shared >= Math.min(3, a.size) || (x.tag === n.tag && shared >= 2);
    });
    for (const x of d.extra_needs || []) if (!dup(x)) out.push({ ...x, age_days: null });
    return out;
  }

  function renderNeeds() {
    const items = mergedNeeds().slice(0, 12);
    $('needs-n').textContent = items.length;
    const list = $('needs'); list.innerHTML = '';
    if (!items.length) list.appendChild(el('li', 'empty', 'Nothing needs you right now.'));
    for (const n of items) {
      const li = el('li');
      const title = el('div', 'nt', n.title); title.appendChild(el('span', 'tg', n.tag));
      const body = el('div'); body.append(title, el('div', 'nd', n.detail));
      li.append(el('span', 'fl', '⚑'), body, el('span', 'age', n.age_days ? n.age_days + 'd' : ''));
      if (n.owner) { li.style.cursor = 'pointer'; li.addEventListener('click', () => map.focus(n.owner)); }
      list.appendChild(li);
    }
    const counts = {}; items.forEach((n) => { counts[n.tag] = (counts[n.tag] || 0) + 1; });
    const bar = $('segbar'); bar.innerHTML = ''; const leg = $('seglegend'); leg.innerHTML = '';
    for (const [tag, c] of Object.entries(counts)) {
      const i = el('i'); i.style.flex = c; i.style.background = TAG_COLOR[tag] || '#8E8C84'; bar.appendChild(i);
      leg.appendChild(el('span', '', `${c} ${tag.toUpperCase()}`));
    }
  }

  function renderRoutines() {
    const s = S.snapshot; if (!s) return;
    $('routines-fired').textContent = `${s.routines_today.fired}/${s.routines_today.scheduled} fired today`;
    const tb = $('routines'); tb.innerHTML = '';
    const now = new Date().toTimeString().slice(0, 5);
    const rows = s.routines.filter((r) => r.status !== 'DISABLED').map((r) => ({ ...r, sort: r.time || '99:99' })).sort((a, b) => (a.sort < b.sort ? -1 : 1));
    let markerDone = false, sepDone = false;
    for (const r of rows) {
      if (!markerDone && r.sort > now) {
        const tr = el('tr', 'now'); const td = el('td'); td.colSpan = 3; td.appendChild(el('span', '', now)); tr.appendChild(td); tb.appendChild(tr); markerDone = true;
        if (!sepDone) { const sp = el('tr', 'sep'); const t2 = el('td', '', 'NEXT'); t2.colSpan = 3; sp.appendChild(t2); tb.appendChild(sp); sepDone = true; }
      }
      const tr = el('tr');
      const rn = el('td', 'rn', r.label); rn.appendChild(el('span', 'host', r.host));
      rn.appendChild(el('span', 'sch', r.schedule + (r.today_runs > 1 ? ` · ${r.today_runs} runs today` : '')));
      tr.append(el('td', 'tm', r.time || '–'), rn, el('td', `ss ${r.status}`, r.status));
      tr.title = r.task + (r.last ? ' · last ' + r.last : '');
      tb.appendChild(tr);
    }
    if (!markerDone) { const tr = el('tr', 'now'); const td = el('td'); td.colSpan = 3; td.appendChild(el('span', '', now)); tr.appendChild(td); tb.appendChild(tr); }
  }

  // ---------------------------------------------------------------- map wiring
  function renderMapChrome() {
    const s = S.snapshot; if (!s) return;
    $('map-stats').textContent = `${s.stats.files} files · ${s.stats.links} links · ${s.stats.runs} runs`;
    const chips = $('area-chips'); const active = chips.dataset.active || '';
    chips.innerHTML = '';
    const all = el('button', active ? '' : 'on'); all.append(el('i'), document.createTextNode('all areas')); all.firstChild.style.border = '1px solid #5B616B';
    all.addEventListener('click', () => { chips.dataset.active = ''; map.setArea(null); renderMapChrome(); });
    chips.appendChild(all);
    for (const a of s.areas) {
      if (!a.count) continue;
      const b = el('button', active === a.key ? 'on' : ''); b.style.color = active === a.key ? a.color : '';
      const dot = el('i'); dot.style.background = a.color;
      b.append(dot, document.createTextNode(a.label.toLowerCase() + ' '), el('span', 'n', a.count));
      b.addEventListener('click', () => { const on = chips.dataset.active === a.key; chips.dataset.active = on ? '' : a.key; map.setArea(on ? null : a.key); renderMapChrome(); });
      chips.appendChild(b);
    }
  }

  async function openDrawer(n) {
    const d = $('drawer'), body = $('drawer-body');
    if (!n) { d.hidden = true; return; }
    d.hidden = false; body.innerHTML = '';
    body.appendChild(el('h3', '', n.label));
    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'pill acc', n.type === 'file' ? (n.kind || 'note') : n.type));
    const area = (S.snapshot.areas || []).find((a) => a.key === n.area);
    if (area) { const p = el('span', 'pill', area.label); p.style.color = area.color; meta.appendChild(p); }
    if (n.status) meta.appendChild(el('span', `pill ${/active|FIRED/.test(n.status) ? 'ok' : /blocked|FAILED|MISSED/.test(n.status) ? 'bad' : /waiting|NEXT/.test(n.status) ? 'warn' : ''}`, n.status));
    if (n.date) meta.appendChild(el('span', 'pill', n.date));
    if (n.host) meta.appendChild(el('span', 'pill', n.host));
    body.appendChild(meta);
    if (n.summary) body.appendChild(el('p', 'summary', n.summary));
    if (n.type === 'routine') {
      const r = (S.snapshot.routines || []).find((x) => 'routine:' + x.label === n.id);
      if (r) body.appendChild(el('p', 'summary', `${r.task} · ${r.schedule} · last ${r.last || '–'}${r.next ? ' · next ' + r.next : ''} · ${r.runs.length} runs logged`));
    }
    if (n.neighbours?.length) {
      body.appendChild(el('div', 'lbl', `LINKED (${n.neighbours.length})`));
      const ls = el('div', 'links');
      for (const x of n.neighbours.slice(0, 60)) { const b = el('button', '', x.label); b.style.borderLeft = `2px solid ${areaColor(x.area)}`; b.addEventListener('click', () => map.focus(x.id)); ls.appendChild(b); }
      body.appendChild(ls);
    }
    if (n.rel) {
      const a = el('a', 'open', 'Open in Obsidian ↗');
      a.href = `obsidian://open?vault=${encodeURIComponent(S.config?.obsidianVault || '')}&file=${encodeURIComponent(n.rel.replace(/\.md$/, ''))}`;
      body.appendChild(a);
      body.appendChild(el('div', 'lbl', 'NOTE'));
      const pre = el('pre', '', 'Loading…'); body.appendChild(pre);
      try { const r = await api('/api/note?rel=' + encodeURIComponent(n.rel)); pre.textContent = r.text.slice(0, 6000); } catch { pre.textContent = 'Could not read the note.'; }
    }
  }

  // ---------------------------------------------------------------- console / prompts
  function consoleOpen(open) { $('console').hidden = !open; if (open) { const log = $('console-log'); log.scrollTop = log.scrollHeight; } }
  function addMsg(cls, text) { const m = el('div', 'msg ' + cls, text); $('console-log').appendChild(m); $('console-log').scrollTop = 1e9; return m; }
  function renderDayLog() {
    const log = $('console-log'); log.innerHTML = '';
    for (const p of S.day?.prompts || []) {
      addMsg('me', p.text);
      const m = addMsg('ai', p.reply || '(no reply recorded)');
      if (p.tools?.length || p.denials?.length) m.appendChild(el('span', 'meta', [p.tools?.length ? 'tools: ' + [...new Set(p.tools)].join(', ') : '', p.denials?.length ? 'refused: ' + p.denials.join(', ') : ''].filter(Boolean).join(' · ')));
    }
    if (!S.day?.prompts?.length) addMsg('ai', 'Ask the director anything about your projects: what is blocked, what changed, what to do next, draft a task or a note. It reads the brain and answers here.');
  }
  async function sendPrompt(text) {
    consoleOpen(true);
    addMsg('me', text);
    const m = addMsg('ai thinking', '');
    try {
      const r = await api('/api/prompt', { method: 'POST', body: JSON.stringify({ text }) });
      chats.set(r.id, { el: m, text: '' });
    } catch (e) { m.classList.remove('thinking'); m.textContent = 'Could not reach the server: ' + e.message; }
  }
  function onChat(ev) {
    let c = chats.get(ev.id);
    if (!c) { c = { el: addMsg('ai thinking', ''), text: '' }; chats.set(ev.id, c); consoleOpen(true); }
    if (ev.delta) { c.text += ev.delta; c.el.textContent = c.text; }
    if (ev.tool) { const t = el('span', 'tool', `⚙ ${ev.tool}${ev.hint ? ' · ' + ev.hint : ''}`); c.el.appendChild(t); }
    if (ev.note) { c.el.appendChild(el('span', 'meta', ev.note)); }
    if (ev.done) {
      c.el.classList.remove('thinking');
      c.el.textContent = ev.text || c.text || '(empty reply)';
      const bits = [];
      if (ev.denials?.length) bits.push('refused: ' + ev.denials.join(', '));
      if (typeof ev.cost_usd === 'number') bits.push('$' + ev.cost_usd.toFixed(3));
      if (bits.length) c.el.appendChild(el('span', 'meta', bits.join(' · ')));
    }
    $('console-log').scrollTop = 1e9;
  }

  // ---------------------------------------------------------------- day end
  function showDayend(rec, date) {
    const body = $('modal-body'); body.innerHTML = '';
    body.appendChild(el('h2', '', rec?.output?.headline || 'Day summary'));
    body.appendChild(el('div', 'sub', `${dayName(date)} · ${rec?.at ? 'summarised ' + hhmm(rec.at) : ''}`));
    const sec = (title, items, fmt) => {
      body.appendChild(el('h4', '', title));
      if (!items?.length) { body.appendChild(el('div', 'empty', 'None.')); return; }
      const ol = el('ol'); items.forEach((it) => ol.appendChild(fmt(it))); body.appendChild(ol);
    };
    const o = rec?.output || {};
    sec('COMPLETED', o.completed, (it) => { const li = el('li', '', it.title); li.appendChild(el('span', 'ev', it.evidence + (it.owner ? ' · ' + it.owner : ''))); return li; });
    sec('IN PROGRESS', o.in_progress, (it) => { const li = el('li', '', it.title); li.appendChild(el('span', 'ev', it.state + (it.owner ? ' · ' + it.owner : ''))); return li; });
    sec('CARRIED OVER', o.carried_over, (it) => { const li = el('li', '', it.title); li.appendChild(el('span', 'ev', it.why)); return li; });
    if (o.notes?.length) sec('NOTES', o.notes, (n) => el('li', '', n));
    $('modal').hidden = false;
  }
  async function showDays() {
    const body = $('modal-body'); body.innerHTML = '';
    body.appendChild(el('h2', '', 'Past days'));
    body.appendChild(el('div', 'sub', 'Day-end summaries and prompts kept by the Command Center'));
    const days = await api('/api/days');
    if (!days.length) body.appendChild(el('div', 'empty', 'No days recorded yet.'));
    const ol = el('ol');
    for (const d of days) {
      const li = el('li'); const a = el('a', '', `${dayName(d.date)} · ${d.prompts} prompt(s)${d.dayend ? ' · day-end summary' : ''}`); a.href = '#'; a.style.color = 'var(--text)';
      a.addEventListener('click', async (e) => { e.preventDefault(); const day = await api('/api/day?date=' + d.date); if (day.dayend) showDayend(day.dayend, d.date); else toast('No day-end summary for ' + d.date); });
      li.appendChild(a); ol.appendChild(li);
    }
    body.appendChild(ol);
    $('modal').hidden = false;
  }

  // ---------------------------------------------------------------- data flow
  async function loadState() {
    const st = await api('/api/state');
    S = { ...S, ...st };
    renderAll(true);
  }
  function renderAll(withMap) {
    renderStatus(); renderToday(); renderDirector(); renderRoutines(); renderMapChrome(); renderDayLog();
    if (withMap && S.snapshot) map.setData(S.snapshot);
  }
  async function reloadSnapshot() {
    S.snapshot = await api('/api/snapshot');
    const st = await api('/api/state'); S.session = st.session; S.sync = st.sync;
    renderStatus(); renderToday(); renderRoutines(); renderProjects(); renderNeeds(); renderMapChrome();
    map.setData(S.snapshot);
  }
  function connect() {
    const es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
    es.addEventListener('status', (e) => { S.status = JSON.parse(e.data); renderStatus(); });
    es.addEventListener('snapshot', () => { reloadSnapshot().catch((err) => toast(err.message)); });
    es.addEventListener('director', (e) => { S.director = JSON.parse(e.data); renderDirector(); toast(`Director reworked the dashboard (${S.director.duration_s}s).`); api('/api/state').then((st) => { S.session = st.session; renderStatus(); }); });
    es.addEventListener('director-skip', (e) => { const d = JSON.parse(e.data); toast(`Brain unchanged since ${hhmm(d.last)}; director skipped. Refresh forces a run.`); });
    es.addEventListener('chat', (e) => onChat(JSON.parse(e.data)));
    es.addEventListener('dayend', (e) => { const d = JSON.parse(e.data); showDayend(d, d.date); });
    es.addEventListener('session', () => { toast('New director session started.'); api('/api/state').then((st) => { S.session = st.session; renderStatus(); }); });
    es.addEventListener('error', (e) => { if (e.data) { const d = JSON.parse(e.data); toast(`${d.label} failed: ${d.message}`, 9000); } });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    map = window.BrainMap($('map-canvas'), $('orbit'), $('map-tip'));
    map.onSelect(openDrawer);
    $('drawer-x').addEventListener('click', () => { map.clearSelection(); $('drawer').hidden = true; });
    document.querySelectorAll('#view-tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#view-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      map.setView(b.dataset.view);
    }));
    $('t-names').addEventListener('click', (e) => { e.currentTarget.classList.toggle('on'); map.setNames(e.currentTarget.classList.contains('on')); });
    $('t-motion').addEventListener('click', (e) => { e.currentTarget.classList.toggle('on'); map.setMotion(e.currentTarget.classList.contains('on')); });
    $('t-fit').addEventListener('click', () => map.fit());
    $('t-full').addEventListener('click', () => { const p = $('map-panel'); if (document.fullscreenElement) document.exitFullscreen(); else p.requestFullscreen?.().catch(() => toast('Full screen is not available here.')); });
    document.addEventListener('fullscreenchange', () => setTimeout(() => map.resize(), 60));
    $('map-search').addEventListener('input', (e) => map.setSearch(e.target.value));
    $('map-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const m = map.setSearch(e.target.value); if (m[0]) map.focus(m[0].id); } });
    $('btn-refresh').addEventListener('click', () => api('/api/refresh', { method: 'POST', body: JSON.stringify({ force: true }) }).then((r) => toast(r.queued ? 'Refresh queued: reading the brain, then the director.' : 'A refresh is already running.')).catch((e) => toast(e.message)));
    $('btn-dayend').addEventListener('click', () => api('/api/dayend', { method: 'POST', body: '{}' }).then((r) => toast(r.queued ? 'Summarising your day. It opens here when the director is done.' : 'Already summarising.')).catch((e) => toast(e.message)));
    $('btn-days').addEventListener('click', () => showDays().catch((e) => toast(e.message)));
    $('btn-menu').addEventListener('click', () => { $('menu').hidden = !$('menu').hidden; });
    $('menu-reset').addEventListener('click', () => { $('menu').hidden = true; api('/api/director/reset', { method: 'POST', body: '{}' }).catch((e) => toast(e.message)); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && e.target.id !== 'btn-menu') $('menu').hidden = true; });
    $('modal-x').addEventListener('click', () => { $('modal').hidden = true; });
    $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').hidden = true; });
    $('btn-console').addEventListener('click', () => consoleOpen($('console').hidden));
    $('console-x').addEventListener('click', () => consoleOpen(false));
    $('cmd-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('cmd-input').value.trim(); if (!v) return; $('cmd-input').value = ''; sendPrompt(v); });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('cmd-input').focus(); }
      if (e.key === 'Escape') { $('modal').hidden = true; consoleOpen(false); }
    });
    tick(); setInterval(tick, 1000);
    setInterval(renderStatus, 30000);
    setInterval(renderRoutines, 60000);
    loadState().then(() => {
      connect();
      return api('/api/refresh', { method: 'POST', body: JSON.stringify({ force: false }) });
    }).catch((e) => toast('Could not load: ' + e.message, 10000));
  }
  boot();
})();
