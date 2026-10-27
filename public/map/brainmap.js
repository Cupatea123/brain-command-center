/* Brain map for the Command Center: six views of one brain.
   Rings, Circle, Areas, Links and Timeline are drawn on one 2D canvas (nodes tween between layouts);
   3D Orbit uses the vendored 3d-force-graph library. No other dependencies. */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const KIND_ORDER = { hq: 0, project: 1, area: 1, todo: 2, start: 2, decisions: 3, runlog: 3, resource: 4, ops: 4, spec: 5, plan: 5, session: 6 };
  const STATUS_COLOR = { FIRED: '#4CC38A', FAILED: '#E5484D', MISSED: '#E5484D', MISSING: '#E5484D', NEXT: '#F2B53A', DUE: '#F2B53A', IDLE: '#8E8C84', DISABLED: '#4A4F57' };
  const RING_LABEL = { skills: '#FF7A1A', memory: '#A98BF5', routines: '#F2B53A', applications: '#7FB2FF' };
  const ACCENT = '#FF7A1A';
  const MONO = '"Cascadia Mono", Consolas, ui-monospace, monospace';

  function BrainMap(canvas, orbitEl, tipEl) {
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1;
    let nodes = [], links = [], byId = new Map(), areaInfo = [], areaColor = {}, snap = null;
    let view = 'rings', motion = true, names = false, areaFilter = null, query = '', hover = null, selected = null;
    const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 };
    let rot = 0, sectors = [], timelineInfo = null, sim = null, fg = null, onSelect = () => {};
    let ringRadii = { skills: 105, memory: 338, routines: 392, applications: 460 };
    let neighbours = new Set();

    // ---------------------------------------------------------------- data
    function setData(s) {
      snap = s;
      areaInfo = s.areas || [];
      areaColor = Object.fromEntries(areaInfo.map((a) => [a.key, a.color]));
      const routineStatus = Object.fromEntries((s.routines || []).map((r) => ['routine:' + r.label, r.status]));
      const old = byId;
      byId = new Map();
      nodes = (s.graph?.nodes || []).map((n) => {
        const prev = old.get(n.id);
        const node = Object.assign({}, n, {
          x: prev ? prev.x : (Math.random() - 0.5) * 20, y: prev ? prev.y : (Math.random() - 0.5) * 20,
          tx: 0, ty: 0, a: prev ? prev.a : 0, ta: 1, vx: 0, vy: 0,
        });
        if (node.type === 'routine') node.status = routineStatus[node.id] || node.status;
        byId.set(node.id, node);
        return node;
      });
      links = (s.graph?.links || []).map((l) => ({ s: byId.get(l.source), t: byId.get(l.target), kind: l.kind })).filter((l) => l.s && l.t);
      if (selected && !byId.has(selected.id)) selected = null;
      computeNeighbours();
      layout(old.size === 0);
      if (view === 'orbit') renderOrbit(true);
    }

    function areaIndex(key) { const i = areaInfo.findIndex((a) => a.key === key); return i < 0 ? areaInfo.length : i; }
    function sortKey(n) { return (n.hq ? 'a' : 'b') + String(KIND_ORDER[n.kind] ?? 7) + (n.date ? (9e12 - Date.parse(n.date)) : 9e13).toString().padStart(14, '0') + n.label; }

    // ---------------------------------------------------------------- layouts
    function layout(first) {
      sectors = []; timelineInfo = null;
      if (view === 'rings') layoutRings();
      else if (view === 'circle') layoutCircle();
      else if (view === 'areas') layoutAreas();
      else if (view === 'links') layoutLinks();
      else if (view === 'timeline') layoutTimeline();
      else if (view === 'orbit') { nodes.forEach((n) => { n.tx = n.x; n.ty = n.y; }); }
      if (first) nodes.forEach((n) => { n.x = n.tx * 0.05; n.y = n.ty * 0.05; });
      fitTargets(first);
    }

    function place(n, x, y, a = 1) { n.tx = x; n.ty = y; n.ta = a; }
    function polar(r, ang) { return [Math.cos(ang) * r, Math.sin(ang) * r]; }

    function layoutRings() {
      const R = { skills: 100, memIn: 158, runs: 0, routines: 0, apps: 0 };
      const center = byId.get('START'); if (center) place(center, 0, 0);
      const skills = nodes.filter((n) => n.type === 'skill');
      skills.forEach((n, i) => place(n, ...polar(R.skills, -Math.PI / 2 + (i + 0.5) * TAU / Math.max(1, skills.length))));
      const files = nodes.filter((n) => n.type === 'file');
      const groups = areaInfo.map((a) => ({ key: a.key, label: a.label, color: a.color, items: files.filter((n) => n.area === a.key).sort((p, q) => sortKey(p) < sortKey(q) ? -1 : 1) })).filter((g) => g.items.length);
      const total = groups.reduce((s, g) => s + g.items.length, 0) || 1;
      const gap = 0.05;
      let ang = -Math.PI / 2 + 0.35;
      for (const g of groups) {
        const span = (TAU - gap * groups.length) * (g.items.length / total);
        const a0 = ang, a1 = ang + span;
        // dense arcs filled from the inner edge outward (tangential spacing TS, radial step RS)
        const count = g.items.length, TS = 10.5, RS = 13;
        let k = 0, r = R.memIn;
        while (k < count) {
          const cap = Math.max(1, Math.floor(((a1 - a0) * r) / TS));
          const n = Math.min(cap, count - k);
          for (let j = 0; j < n; j++, k++) {
            const t = n === 1 ? 0.5 : (cap === n ? j / (n - 1) : (j + 0.5) / cap + (1 - n / cap) / 2);
            place(g.items[k], ...polar(r, a0 + (a1 - a0) * (0.04 + 0.92 * t)));
          }
          r += RS;
        }
        sectors.push({ key: g.key, label: g.label, color: g.color, count, a0, a1, rIn: R.memIn, rOut: r - RS });
        ang = a1 + gap;
      }
      const memMax = Math.max(R.memIn + 40, ...sectors.map((s) => s.rOut));
      R.runs = memMax + 46; R.routines = memMax + 66; R.apps = memMax + 128;
      ringRadii = { skills: R.skills, memory: memMax + 16, routines: R.routines, applications: R.apps };
      // routines sit on their ring near their area's sector; runs trail just inside
      const routines = nodes.filter((n) => n.type === 'routine').sort((p, q) => areaIndex(p.area) - areaIndex(q.area));
      const perArea = {};
      routines.forEach((n) => { (perArea[n.area] = perArea[n.area] || []).push(n); });
      for (const [key, list] of Object.entries(perArea)) {
        const sec = sectors.find((s) => s.key === key);
        const mid = sec ? (sec.a0 + sec.a1) / 2 : -Math.PI / 2;
        const width = Math.min(sec ? (sec.a1 - sec.a0) : 0.6, 0.12 * list.length);
        list.forEach((n, i) => { n._ang = mid - width / 2 + width * (list.length === 1 ? 0.5 : i / (list.length - 1)); place(n, ...polar(R.routines, n._ang)); });
      }
      const runsBy = {};
      nodes.filter((n) => n.type === 'run').forEach((n) => { (runsBy[n.routine] = runsBy[n.routine] || []).push(n); });
      for (const [rid, list] of Object.entries(runsBy)) {
        const r = byId.get(rid); const base = r && r._ang !== undefined ? r._ang : 0;
        list.sort((p, q) => (p.date < q.date ? -1 : 1)).forEach((n, i) => place(n, ...polar(R.runs - (i % 2) * 7, base - 0.11 + i * 0.016)));
      }
      const apps = nodes.filter((n) => n.type === 'app');
      apps.forEach((n, i) => place(n, ...polar(R.apps, -Math.PI / 2 + (i + 0.5) * TAU / Math.max(1, apps.length))));
    }

    function layoutCircle() {
      const center = byId.get('START'); if (center) place(center, 0, 0);
      const list = nodes.filter((n) => n.type !== 'center' && n.type !== 'run')
        .sort((p, q) => (areaIndex(p.area) - areaIndex(q.area)) || ((p.type > q.type) ? 1 : (p.type < q.type) ? -1 : 0) || (sortKey(p) < sortKey(q) ? -1 : 1));
      const R = 430;
      list.forEach((n, i) => place(n, ...polar(R, -Math.PI / 2 + (i / list.length) * TAU)));
      nodes.filter((n) => n.type === 'run').forEach((n) => { const r = byId.get(n.routine); place(n, r ? r.tx * 0.93 : 0, r ? r.ty * 0.93 : 0, 0); });
      // area arcs for labels
      let i0 = 0;
      for (const a of areaInfo) {
        const c = list.filter((n) => n.area === a.key).length;
        if (!c) continue;
        sectors.push({ key: a.key, label: a.label, color: a.color, count: c, a0: -Math.PI / 2 + (i0 / list.length) * TAU, a1: -Math.PI / 2 + ((i0 + c) / list.length) * TAU, rIn: R, rOut: R });
        i0 += c;
      }
    }

    function layoutAreas() {
      const center = byId.get('START'); if (center) place(center, 0, 0);
      const keys = areaInfo.map((a) => a.key);
      const R = 300;
      const hubs = {};
      keys.forEach((k, i) => { hubs[k] = polar(R, -Math.PI / 2 + i * TAU / keys.length); });
      const counters = {};
      nodes.filter((n) => n.type !== 'center' && n.type !== 'app' && n.type !== 'run')
        .sort((p, q) => (sortKey(p) < sortKey(q) ? -1 : 1))
        .forEach((n) => {
          const h = hubs[n.area] || [0, 0];
          const i = (counters[n.area] = (counters[n.area] || 0) + 1);
          const r = 7.2 * Math.sqrt(i) + 14, th = i * 2.39996;
          place(n, h[0] + Math.cos(th) * r, h[1] + Math.sin(th) * r);
        });
      nodes.filter((n) => n.type === 'run').forEach((n) => { const r = byId.get(n.routine); place(n, r ? r.tx : 0, r ? r.ty : 0, 0); });
      const apps = nodes.filter((n) => n.type === 'app');
      apps.forEach((n, i) => place(n, ...polar(70, i * TAU / Math.max(1, apps.length))));
      for (const a of areaInfo) {
        const c = nodes.filter((n) => n.area === a.key && n.type === 'file').length;
        if (c) sectors.push({ key: a.key, label: a.label, color: a.color, count: c, hub: hubs[a.key] });
      }
    }

    function layoutLinks() {
      const live = nodes.filter((n) => n.type !== 'run');
      live.forEach((n) => { if (!isFinite(n.x)) { n.x = 0; n.y = 0; } n.vx = 0; n.vy = 0; n.tx = n.x + (Math.random() - 0.5) * 30; n.ty = n.y + (Math.random() - 0.5) * 30; n.ta = 1; });
      nodes.filter((n) => n.type === 'run').forEach((n) => { n.ta = 0; });
      sim = { live, alpha: 1, links: links.filter((l) => l.s.type !== 'run' && l.t.type !== 'run') };
      for (let i = 0; i < 160; i++) simStep(true);
      live.forEach((n) => { n.tx = n.sx_; n.ty = n.sy_; });
    }

    function simStep(precompute) {
      if (!sim) return;
      const L = sim.live, n = L.length;
      const px = precompute ? 'sx_' : 'x', py = precompute ? 'sy_' : 'y';
      if (precompute && L[0] && L[0].sx_ === undefined) L.forEach((a) => { a.sx_ = a.tx; a.sy_ = a.ty; });
      const alpha = sim.alpha;
      for (let i = 0; i < n; i++) {
        const a = L[i];
        for (let j = i + 1; j < n; j++) {
          const b = L[j];
          let dx = a[px] - b[px], dy = a[py] - b[py];
          let d2 = dx * dx + dy * dy;
          if (d2 > 90000) continue;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = (520 * alpha) / d2;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      for (const l of sim.links) {
        const dx = l.t[px] - l.s[px], dy = l.t[py] - l.s[py];
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = l.kind === 'owner' ? 26 : 46;
        const f = ((d - rest) / d) * 0.035 * alpha;
        l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f; l.t.vy -= dy * f;
      }
      for (const a of L) {
        if (a.type === 'center') { a.vx = 0; a.vy = 0; a[px] = 0; a[py] = 0; continue; }
        a.vx -= a[px] * 0.006 * alpha; a.vy -= a[py] * 0.006 * alpha;
        a.vx *= 0.58; a.vy *= 0.58;
        a[px] += a.vx; a[py] += a.vy;
      }
      sim.alpha = Math.max(0.02, sim.alpha * 0.985);
    }

    function layoutTimeline() {
      const today = new Date((snap?.today || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
      const start = new Date(today); start.setDate(start.getDate() - 56);
      const end = new Date(today); end.setDate(end.getDate() + 14);
      const X0 = -300, X1 = 480;
      const days = Math.round((end - start) / 864e5);
      const x = (d) => { const t = Math.round((new Date(d + 'T00:00:00') - start) / 864e5); return X0 + (Math.max(0, Math.min(days, t)) / days) * (X1 - X0); };
      const routines = nodes.filter((n) => n.type === 'routine').sort((p, q) => (p.host > q.host ? 1 : p.host < q.host ? -1 : 0) || (p.label > q.label ? 1 : -1));
      const rowY = {};
      routines.forEach((n, i) => { rowY[n.id] = -330 + i * 17; place(n, X0 - 22, rowY[n.id]); });
      nodes.filter((n) => n.type === 'run').forEach((n) => place(n, x(n.date), rowY[n.routine] ?? -330, 1));
      const filesTop = -330 + routines.length * 17 + 46;
      const stacks = {};
      nodes.filter((n) => n.type === 'file').sort((p, q) => (areaIndex(p.area) - areaIndex(q.area))).forEach((n) => {
        const d = (n.date && /^\d{4}-\d{2}-\d{2}$/.test(n.date)) ? n.date : (n.mtime || '').slice(0, 10);
        const xx = x(d || snap.today);
        const k = Math.round(xx);
        const i = (stacks[k] = (stacks[k] || 0) + 1);
        place(n, xx, filesTop + (i - 1) * 8.5);
      });
      nodes.filter((n) => n.type === 'center' || n.type === 'skill' || n.type === 'app').forEach((n) => place(n, n.x, n.y, 0));
      const ticks = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === 1) ticks.push({ x: x(d.toISOString().slice(0, 10)), label: 'Mon ' + String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') });
      }
      const dl = (snap.deadlines || [])[0];
      const chase = (snap.next14 || []).find((e) => e.tag === 'routine' && e.date > snap.today);
      const mark = dl && new Date(dl.date + 'T00:00:00') <= end ? { d: dl.date, label: 'due ' + dl.date.slice(8, 10) + '.' + dl.date.slice(5, 7) } : chase ? { d: chase.date, label: chase.label + ' ' + chase.date.slice(8, 10) + '.' + chase.date.slice(5, 7) } : null;
      const maxStack = Math.max(1, ...Object.values(stacks));
      timelineInfo = { X0, X1, todayX: x(snap.today), mark: mark ? { x: x(mark.d), label: mark.label } : null, ticks, routinesTop: -330, routinesBottom: -330 + routines.length * 17, filesTop, filesBottom: filesTop + maxStack * 8.5, routines };
    }

    // ---------------------------------------------------------------- camera
    function visibleBounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) { if (n.ta < 0.5) continue; x0 = Math.min(x0, n.tx); y0 = Math.min(y0, n.ty); x1 = Math.max(x1, n.tx); y1 = Math.max(y1, n.ty); }
      if (view === 'timeline' && timelineInfo) { x0 = Math.min(x0, timelineInfo.X0 - 150); y0 = Math.min(y0, timelineInfo.routinesTop - 40); }
      if (!isFinite(x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
      return { x0, y0, x1, y1 };
    }
    function fitTargets(instant) {
      if (!W) return;
      const b = visibleBounds();
      const pad = view === 'timeline' ? 30 : 60;
      cam.tk = Math.min(W / (b.x1 - b.x0 + pad * 2), H / (b.y1 - b.y0 + pad * 2));
      if (view === 'timeline') cam.tk = Math.min(cam.tk, 1.2);
      cam.tx = (b.x0 + b.x1) / 2;
      cam.ty = view === 'timeline' ? b.y0 - pad + H / 2 / cam.tk : (b.y0 + b.y1) / 2;
      if (view === 'timeline' && (b.y1 - b.y0 + pad * 2) * cam.tk < H) cam.ty = (b.y0 + b.y1) / 2;
      if (instant) { cam.x = cam.tx; cam.y = cam.ty; cam.k = cam.tk; }
    }

    // ---------------------------------------------------------------- drawing
    function stageSize() {
      const r = (canvas.hidden ? orbitEl : canvas).getBoundingClientRect();
      return [r.width, r.height];
    }
    function resize() {
      const [w, h] = stageSize();
      if (!w || !h) return;
      dpr = window.devicePixelRatio || 1;
      W = w; H = h;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      if (fg) fg.width(W).height(H);
    }
    function rotating() { return motion && (view === 'rings' || view === 'circle'); }
    function toScreen(n) {
      let x = n.x, y = n.y;
      if (view === 'rings' || view === 'circle') { const c = Math.cos(rot), s = Math.sin(rot); const xx = x * c - y * s; y = x * s + y * c; x = xx; }
      n.sx = W / 2 + (x - cam.x) * cam.k; n.sy = H / 2 + (y - cam.y) * cam.k;
    }
    function worldPoint(x, y) {
      let px = x, py = y;
      if (view === 'rings' || view === 'circle') { const c = Math.cos(rot), s = Math.sin(rot); const xx = px * c - py * s; py = px * s + py * c; px = xx; }
      return [W / 2 + (px - cam.x) * cam.k, H / 2 + (py - cam.y) * cam.k];
    }
    function isDim(n) {
      if (n.type === 'center') return false;
      if (areaFilter && n.area !== areaFilter) return true;
      if (query && !n._match) return true;
      if (selected && neighbours.size && !neighbours.has(n.id)) return 'soft';
      return false;
    }
    function computeNeighbours() {
      neighbours = new Set();
      if (!selected) return;
      neighbours.add(selected.id);
      for (const l of links) { if (l.s === selected) neighbours.add(l.t.id); if (l.t === selected) neighbours.add(l.s.id); }
    }

    function hexPath(x, y, r) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.closePath(); }

    function drawGuides() {
      const k = cam.k;
      ctx.save();
      if (view === 'rings') {
        const rings = [[ringRadii.skills, 'SKILLS', RING_LABEL.skills], [ringRadii.memory, 'MEMORY', RING_LABEL.memory], [ringRadii.routines, 'ROUTINES', RING_LABEL.routines], [ringRadii.applications, 'APPLICATIONS', RING_LABEL.applications]];
        const [cx, cy] = worldPoint(0, 0);
        for (const [r, label, color] of rings) {
          ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, TAU); ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.stroke();
          ctx.font = `600 ${Math.max(9, 10.5 * Math.sqrt(k))}px ${MONO}`; ctx.fillStyle = color; ctx.textAlign = 'center';
          ctx.fillText(label, cx, cy - r * k - 6);
        }
        for (const s of sectors) {
          const mid = (s.a0 + s.a1) / 2;
          const [hx, hy] = worldPoint(Math.cos(mid) * (s.rIn - 22), Math.sin(mid) * (s.rIn - 22));
          drawHub(hx, hy, s);
        }
      } else if (view === 'circle') {
        for (const s of sectors) {
          const mid = (s.a0 + s.a1) / 2;
          const [lx, ly] = worldPoint(Math.cos(mid) * (s.rIn + 34), Math.sin(mid) * (s.rIn + 34));
          ctx.font = `600 ${Math.max(9, 10 * Math.sqrt(k))}px ${MONO}`; ctx.fillStyle = s.color; ctx.textAlign = 'center';
          ctx.fillText(s.label.toUpperCase() + ' ' + s.count, lx, ly);
        }
      } else if (view === 'areas') {
        for (const s of sectors) { const [hx, hy] = worldPoint(s.hub[0], s.hub[1]); drawHub(hx, hy, s); }
      } else if (view === 'timeline' && timelineInfo) {
        const t = timelineInfo;
        const top = worldPoint(0, t.routinesTop - 26)[1], bottom = worldPoint(0, t.filesBottom + 10)[1];
        ctx.font = `${Math.max(9, 10 * Math.sqrt(k))}px ${MONO}`; ctx.textAlign = 'left';
        for (const tk of t.ticks) {
          const [x] = worldPoint(tk.x, 0);
          ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(x, top + 8); ctx.lineTo(x, bottom); ctx.stroke();
          ctx.fillStyle = '#5B616B'; ctx.fillText(tk.label, x + 3, top + 4);
        }
        const [tx] = worldPoint(t.todayX, 0);
        ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(tx, top - 6); ctx.lineTo(tx, bottom); ctx.stroke();
        ctx.fillStyle = ACCENT; ctx.fillText('today', tx + 4, top - 10);
        if (t.mark) {
          const [mx] = worldPoint(t.mark.x, 0);
          ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,122,26,0.7)'; ctx.beginPath(); ctx.moveTo(mx, top - 6); ctx.lineTo(mx, bottom); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillText(t.mark.label, mx + 4, top + 16);
        }
        ctx.font = `600 ${Math.max(9, 10.5 * Math.sqrt(k))}px ${MONO}`;
        const [lx, ly] = worldPoint(t.X0 - 150, t.routinesTop - 22);
        ctx.fillStyle = RING_LABEL.routines; ctx.fillText('ROUTINES · runs by day', lx, ly);
        const [fx, fy] = worldPoint(t.X0 - 150, t.filesTop - 18);
        ctx.fillStyle = RING_LABEL.memory; ctx.fillText('FILES · by last change', fx, fy);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'; const sepY = worldPoint(0, t.filesTop - 32)[1];
        ctx.beginPath(); ctx.moveTo(worldPoint(t.X0 - 150, 0)[0], sepY); ctx.lineTo(worldPoint(t.X1 + 10, 0)[0], sepY); ctx.stroke();
      }
      ctx.restore();
    }

    function drawHub(x, y, s) {
      const k = Math.sqrt(cam.k);
      const dim = areaFilter && areaFilter !== s.key;
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.beginPath(); ctx.arc(x, y, 9 * k, 0, TAU); ctx.fillStyle = s.color; ctx.fill();
      ctx.strokeStyle = 'rgba(10,11,13,0.9)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = `700 ${9 * k}px ${MONO}`; ctx.fillStyle = '#0A0B0D'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(s.label[0].toUpperCase(), x, y + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.font = `600 ${10 * k}px ${MONO}`; ctx.fillStyle = '#E6E4DD'; ctx.fillText(s.label.toUpperCase(), x + 13 * k, y + 1);
      ctx.font = `${9 * k}px ${MONO}`; ctx.fillStyle = '#7C828C'; ctx.fillText(String(s.count), x + 13 * k, y + 12 * k);
      ctx.globalAlpha = 1;
    }

    function drawLinks() {
      if (view === 'timeline') return;
      const base = view === 'links' ? 0.10 : view === 'circle' ? 0.05 : 0.035;
      const [cx, cy] = worldPoint(0, 0);
      ctx.lineWidth = 1;
      for (const l of links) {
        if (l.s.a < 0.3 || l.t.a < 0.3) continue;
        const hot = selected && (l.s === selected || l.t === selected) || hover && (l.s === hover || l.t === hover);
        if (!hot && (areaFilter && (l.s.area !== areaFilter && l.t.area !== areaFilter))) continue;
        ctx.strokeStyle = hot ? 'rgba(255,122,26,0.75)' : `rgba(220,220,230,${base})`;
        ctx.lineWidth = hot ? 1.3 : 1;
        ctx.beginPath(); ctx.moveTo(l.s.sx, l.s.sy);
        if (view === 'circle') ctx.quadraticCurveTo(cx, cy, l.t.sx, l.t.sy); else ctx.lineTo(l.t.sx, l.t.sy);
        ctx.stroke();
      }
    }

    function nodeColor(n) {
      if (n.type === 'routine') return STATUS_COLOR[n.status] || '#B4B3A8';
      if (n.type === 'run') return !n.fails ? (areaColor[n.area] || '#8E8C84') : n.fails >= n.count ? '#E5484D' : '#F2B53A';
      if (n.type === 'center') return ACCENT;
      if (n.type === 'app') return '#C9CCD1';
      return areaColor[n.area] || '#8E8C84';
    }

    function drawNodes() {
      const ks = Math.max(0.55, Math.min(2.2, Math.sqrt(cam.k)));
      const order = ['run', 'file', 'skill', 'routine', 'app', 'center'];
      for (const type of order) {
        for (const n of nodes) {
          if (n.type !== type || n.a < 0.02) continue;
          const dim = isDim(n);
          ctx.globalAlpha = n.a * (dim === true ? 0.12 : dim === 'soft' ? 0.35 : 1);
          const c = nodeColor(n);
          const x = n.sx, y = n.sy;
          if (type === 'file') {
            const r = Math.max(2, (n.size || 3) * 0.72 * ks);
            ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = c; ctx.fill();
            if (n.hq) { ctx.beginPath(); ctx.arc(x, y, r + 2.5 * ks, 0, TAU); ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke(); }
          } else if (type === 'skill') {
            const r = 4.2 * ks;
            ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fillStyle = c; ctx.fill();
          } else if (type === 'routine') {
            const r = 5.4 * ks;
            ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.stroke();
            ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, TAU); ctx.fillStyle = c; ctx.fill();
          } else if (type === 'run') {
            const r = Math.max(1.2, (1.1 + Math.log2((n.count || 1) + 1) * 0.55) * ks);
            ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = c; ctx.fill();
          } else if (type === 'app') {
            const r = 9.5 * ks;
            hexPath(x, y, r); ctx.fillStyle = '#0F1114'; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.stroke();
            ctx.font = `600 ${8 * ks}px ${MONO}`; ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(n.label[0], x, y + 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          } else if (type === 'center') {
            const r = 15 * ks;
            ctx.save(); ctx.shadowColor = ACCENT; ctx.shadowBlur = 18;
            hexPath(x, y, r); ctx.fillStyle = '#120C07'; ctx.fill(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
            if (view !== 'timeline') {
              ctx.font = `600 ${9.5 * ks}px ${MONO}`; const w = ctx.measureText('START').width + 12;
              ctx.fillStyle = 'rgba(10,11,13,0.9)'; ctx.fillRect(x - w / 2, y + r + 6, w, 15 * ks);
              ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.strokeRect(x - w / 2, y + r + 6, w, 15 * ks);
              ctx.fillStyle = '#E6E4DD'; ctx.textAlign = 'center'; ctx.fillText('START', x, y + r + 6 + 11 * ks); ctx.textAlign = 'left';
            }
          }
          if (n === hover || n === selected || (query && n._match)) {
            ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(x, y, (type === 'file' ? (n.size || 3) * 0.62 * ks : 7 * ks) + 4, 0, TAU);
            ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.4; ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function drawLabels() {
      const ks = Math.max(0.7, Math.min(1.6, Math.sqrt(cam.k)));
      ctx.font = `${9.5 * ks}px ${MONO}`;
      ctx.textBaseline = 'middle';
      for (const n of nodes) {
        if (n.a < 0.5) continue;
        let show = false;
        if (view === 'timeline') show = n.type === 'routine';
        else if (n === selected || n === hover) show = true;
        else if (names) show = n.type === 'routine' || n.type === 'app' || n.type === 'skill' || (n.type === 'file' && (n.hq || cam.k > 1.5));
        if (!show || isDim(n) === true) continue;
        const label = n.type === 'file' ? n.label : n.label;
        if (view === 'timeline' && n.type === 'routine') {
          ctx.textAlign = 'right'; ctx.fillStyle = '#B9BDC4'; ctx.fillText(label, n.sx - 10 * ks, n.sy); ctx.textAlign = 'left';
          ctx.font = `${8 * ks}px ${MONO}`; ctx.fillStyle = '#5B616B'; ctx.fillText(n.host || '', n.sx - 10 * ks - ctx.measureText(label).width * 1.25 - 40, n.sy); ctx.font = `${9.5 * ks}px ${MONO}`;
          continue;
        }
        ctx.fillStyle = n === selected ? ACCENT : '#C9CCD1';
        ctx.fillText(label, n.sx + 8 * ks, n.sy);
      }
      ctx.textBaseline = 'alphabetic';
    }

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(50, now - last); last = now;
      if (view !== 'orbit') {
        if (rotating()) rot += dt * 0.000018;
        const ease = 1 - Math.pow(0.86, dt / 16);
        cam.x += (cam.tx - cam.x) * ease; cam.y += (cam.ty - cam.y) * ease; cam.k += (cam.tk - cam.k) * ease;
        if (view === 'links' && sim) {
          if (motion || sim.alpha > 0.03) { sim.alpha = Math.max(sim.alpha, motion ? 0.03 : 0); simStep(false); }
          for (const n of nodes) { if (n.type === 'run') { n.a += (0 - n.a) * ease; } else { n.a += (1 - n.a) * ease; } }
          // ease from the precomputed target the first moments after a switch
          for (const n of sim.live) { if (n._settle === undefined) n._settle = 1; if (n._settle > 0) { n.x += (n.tx - n.x) * ease * n._settle; n.y += (n.ty - n.y) * ease * n._settle; n._settle -= dt / 900; } }
        } else {
          for (const n of nodes) { n.x += (n.tx - n.x) * ease; n.y += (n.ty - n.y) * ease; n.a += (n.ta - n.a) * ease; }
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        for (const n of nodes) toScreen(n);
        drawGuides(); drawLinks(); drawNodes(); drawLabels();
      }
      requestAnimationFrame(frame);
    }

    // ---------------------------------------------------------------- 3D orbit
    function renderOrbit(reload) {
      if (typeof window.ForceGraph3D !== 'function') { orbitEl.textContent = '3D library did not load.'; return; }
      const data = () => {
        const ns = nodes.filter((n) => n.type !== 'run').map((n) => ({ id: n.id, label: n.label, type: n.type, area: n.area, size: n.size || 3, status: n.status }));
        const ids = new Set(ns.map((n) => n.id));
        const ls = links.filter((l) => ids.has(l.s.id) && ids.has(l.t.id)).map((l) => ({ source: l.s.id, target: l.t.id }));
        return { nodes: ns, links: ls };
      };
      const [ow, oh] = stageSize();
      if (ow && oh) { W = ow; H = oh; }
      if (!fg) {
        fg = window.ForceGraph3D()(orbitEl)
          .backgroundColor('rgba(0,0,0,0)')
          .width(W).height(H)
          .showNavInfo(false)
          .nodeLabel((n) => `${n.label}`)
          .nodeColor((n) => n.type === 'center' ? ACCENT : n.type === 'routine' ? (STATUS_COLOR[n.status] || '#B4B3A8') : n.type === 'app' ? '#C9CCD1' : (areaColor[n.area] || '#8E8C84'))
          .nodeVal((n) => n.type === 'center' ? 40 : n.type === 'app' ? 8 : n.type === 'routine' ? 5 : Math.max(1, (n.size || 3) * 0.8))
          .nodeOpacity(0.95)
          .linkColor(() => 'rgba(210,215,225,0.35)')
          .linkOpacity(0.18)
          .linkWidth(0)
          .onNodeClick((n) => { const node = byId.get(n.id); if (node) select(node, true); })
          .graphData(data());
        try { const c = fg.controls(); c.autoRotate = motion; c.autoRotateSpeed = 0.7; } catch (e) {}
        setTimeout(() => { try { fg.zoomToFit(600, 40); } catch (e) {} }, 1500);
      } else {
        fg.width(W).height(H);
        if (reload) fg.graphData(data());
      }
    }

    // ---------------------------------------------------------------- interaction
    function pick(mx, my) {
      let best = null, bd = 14 * 14;
      for (const n of nodes) {
        if (n.a < 0.4 || isDim(n) === true) continue;
        const dx = n.sx - mx, dy = n.sy - my, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    }
    function select(n, fromOrbit) {
      selected = n; computeNeighbours();
      onSelect(n ? publicNode(n) : null);
      if (n && fromOrbit && fg) { /* camera handled by 3d lib */ }
    }
    function publicNode(n) {
      const nb = links.filter((l) => l.s === n || l.t === n).map((l) => (l.s === n ? l.t : l.s)).filter((x) => x.type !== 'run');
      const uniq = [...new Map(nb.map((x) => [x.id, { id: x.id, label: x.label, type: x.type, area: x.area }])).values()];
      return Object.assign({}, n, { neighbours: uniq });
    }
    let drag = null;
    canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty, moved: false }; canvas.classList.add('dragging'); });
    window.addEventListener('mouseup', (e) => {
      if (!drag) return;
      canvas.classList.remove('dragging');
      if (!drag.moved) {
        const r = canvas.getBoundingClientRect();
        const n = pick(e.clientX - r.left, e.clientY - r.top);
        select(n);
      }
      drag = null;
    });
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        cam.tx = drag.cx - dx / cam.k; cam.ty = drag.cy - dy / cam.k; cam.x = cam.tx; cam.y = cam.ty;
        tipEl.hidden = true; return;
      }
      const n = pick(mx, my);
      hover = n;
      if (n) {
        tipEl.hidden = false;
        const sub = n.type === 'file' ? [n.kind, n.status, n.date].filter(Boolean).join(' · ') : n.type === 'routine' ? [n.host, n.status].join(' · ') : n.type === 'run' ? (n.fails ? `${n.fails} of ${n.count} runs logged a failure` : 'all runs ok') : n.type;
        tipEl.innerHTML = '';
        const t = document.createElement('div'); t.textContent = n.label; tipEl.appendChild(t);
        const s = document.createElement('div'); s.className = 's'; s.textContent = sub + (n.area && areaInfo.find((a) => a.key === n.area) ? ' · ' + areaInfo.find((a) => a.key === n.area).label : ''); tipEl.appendChild(s);
        tipEl.style.left = Math.min(W - 240, mx + 14) + 'px'; tipEl.style.top = Math.min(H - 50, my + 12) + 'px';
      } else tipEl.hidden = true;
      canvas.style.cursor = n ? 'pointer' : '';
    });
    canvas.addEventListener('mouseleave', () => { hover = null; tipEl.hidden = true; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - W / 2, my = e.clientY - r.top - H / 2;
      const f = Math.exp(-e.deltaY * 0.0015);
      const nk = Math.max(0.2, Math.min(8, cam.tk * f));
      cam.tx += mx / cam.tk - mx / nk; cam.ty += my / cam.tk - my / nk; cam.tk = nk;
    }, { passive: false });
    new ResizeObserver(() => { resize(); fitTargets(true); }).observe(canvas.parentElement);

    // ---------------------------------------------------------------- public api
    resize();
    requestAnimationFrame(frame);
    return {
      setData,
      setView(v) {
        view = v;
        const orbit = v === 'orbit';
        canvas.hidden = orbit; orbitEl.hidden = !orbit; tipEl.hidden = true;
        if (orbit) { renderOrbit(false); return; }
        sim = v === 'links' ? sim : null;
        nodes.forEach((n) => { n._settle = undefined; n.sx_ = undefined; n.sy_ = undefined; });
        layout(false);
      },
      setArea(key) { areaFilter = key || null; },
      setSearch(q) {
        query = (q || '').trim().toLowerCase();
        for (const n of nodes) n._match = !!query && ((n.label || '').toLowerCase().includes(query) || (n.summary || '').toLowerCase().includes(query));
        return nodes.filter((n) => n._match).map(publicNode);
      },
      setNames(b) { names = !!b; },
      setMotion(b) { motion = !!b; if (fg) { try { fg.controls().autoRotate = motion; } catch (e) {} } },
      fit() { if (view === 'orbit' && fg) { fg.zoomToFit(600, 40); return; } fitTargets(false); },
      focus(id) {
        const n = byId.get(id); if (!n) return;
        select(n);
        if (view === 'orbit') return;
        let x = n.tx, y = n.ty;
        if (view === 'rings' || view === 'circle') { const c = Math.cos(rot), s = Math.sin(rot); const xx = x * c - y * s; y = x * s + y * c; x = xx; }
        cam.tx = x; cam.ty = y; cam.tk = Math.max(cam.tk, 1.6);
      },
      clearSelection() { select(null); },
      onSelect(cb) { onSelect = cb; },
      resize() { resize(); fitTargets(true); },
    };
  }
  window.BrainMap = BrainMap;
})();
