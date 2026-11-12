/* Отрисовка: карта (вид сверху) с плавным масштабом и лента-схема линии. */
(function (root) {
  'use strict';
  const M = root.M, TR = M.TRAIN;
  const C = {
    bg: '#06080b', land: '#0b1016', water: '#0c2034', city: '#27364a', district: '#172130', dlabel: '#34465e',
    line: '#1fae5a', lineRes: '#7dffb9', aux: '#74869b', bed: '#161d26', plat: '#222c39', platLine: '#4b5c72', pax: '#ecdfae',
    text: '#d5deea', dim: '#7f8fa3', car: '#121a24', carLine: '#c9d6e4', sel: '#55d0ff', red: '#ff4d57', yellow: '#f4c430', green: '#3ddc84'
  };
  const FONT = '"Segoe UI", Roboto, Arial, sans-serif';

  class Render {
    constructor(game) {
      this.g = game; this.G = game.G;
      this.cv = document.getElementById('map'); this.ctx = this.cv.getContext('2d');
      this.sc = document.getElementById('strip'); this.sx = this.sc.getContext('2d');
      this.cam = { x: 0, y: 0, k: 0.05 }; this.fly = null; this.follow = false; this.dpr = 1; this.w = 100; this.h = 100; this.kFit = 0.04;
      this.view = [0, 0, 0, 0]; this.labels = [];
      this.build(); this.resize(); this.fit(true); this.bind();
    }

    build() {
      const G = this.G, GEO = M.GEO || {};
      const mk = (pts, close) => { const p = new Path2D(); for (let i = 0; i < pts.length; i++) { if (i) p.lineTo(pts[i][0], pts[i][1]); else p.moveTo(pts[i][0], pts[i][1]); } if (close) p.closePath(); return p; };
      for (const e of G.edges) {
        e.path = mk(e.poly.p);
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const q of e.poly.p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
        e.bb = [x0 - 8, y0 - 8, x1 + 8, y1 + 8];
        e.isMain = !!e.track && (e.kind === 'main' || e.kind === 'platform' || e.kind === 'rev');
      }
      this.trunk = new Path2D();
      for (const e of G.main.A) if (e.isMain) this.trunk.addPath(e.path);
      const rings = (path, list) => { for (const r of list) { for (let i = 0; i < r.length; i++) { const q = M.proj(r[i]); if (i) path.lineTo(q[0], q[1]); else path.moveTo(q[0], q[1]); } path.closePath(); } };
      this.water = new Path2D();
      for (const w of GEO.water || []) rings(this.water, w.rings || [w]);
      this.city = new Path2D(); this.hasCity = false;
      if (GEO.city && GEO.city.boundary && GEO.city.boundary.length) { rings(this.city, GEO.city.boundary); this.hasCity = true; }
      this.districts = [];
      for (const d of (GEO.city && GEO.city.districts) || []) {
        const p = new Path2D(); rings(p, d.rings);
        let big = d.rings[0] || []; for (const r of d.rings) if (r.length > big.length) big = r;
        let cx = 0, cy = 0; for (const q of big) { const z = M.proj(q); cx += z[0]; cy += z[1]; }
        this.districts.push({ name: d.name, path: p, x: cx / (big.length || 1), y: cy / (big.length || 1) });
      }
      for (const s of G.st) for (const pl of s.plats) pl.path = mk(pl.near.concat(pl.far.slice().reverse()), true);
      // места в вагоне: сначала сидячие вдоль бортов, затем стоячие по всей площади
      const rnd = M.mulberry(4711), seats = [], stand = [];
      for (let i = 0; i < 20; i++) { const x = -8.4 + i * (16.8 / 19); seats.push([x, -1.02], [x, 1.02]); }
      for (let r = 0; r < 5; r++) for (let c = 0; c < 42; c++) stand.push([-8.7 + c * (17.4 / 41) + (rnd() - 0.5) * 0.14, -0.58 + r * 0.29 + (rnd() - 0.5) * 0.08]);
      const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
      this.slots = shuffle(seats).concat(shuffle(stand));
      this.pp = G.st.map(() => { const a = new Float32Array(3800); for (let i = 0; i < a.length; i += 2) { a[i] = 0.02 + rnd() * 0.96; a[i + 1] = 0.07 + Math.pow(rnd(), 1.5) * 0.86; } return a; });
      this.lin0 = G.sv.A[0] - 580; this.lin1 = (G.depotLin || G.sv.A[G.NS - 1] + 900) + 150;
    }

    resize() {
      const dpr = this.dpr = Math.min(2, root.devicePixelRatio || 1);
      for (const [cv, key] of [[this.cv, ''], [this.sc, 's']]) {
        const r = cv.getBoundingClientRect(), w = Math.max(50, Math.round(r.width)), h = Math.max(20, Math.round(r.height));
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        if (key) { this.sw = w; this.sh = h; } else { this.w = w; this.h = h; }
      }
    }
    fit(instant) {
      const G = this.G; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
      for (const s of G.st) add(s.x, s.y);
      for (const q of G.depotBox || []) add(q[0], q[1]);
      const k = Math.min((this.w - 120) / (x1 - x0), (this.h - 90) / (y1 - y0));
      this.kFit = k; this.follow = false;
      this.flyTo((x0 + x1) / 2, (y0 + y1) / 2, k, instant);
    }
    flyTo(x, y, k, instant) { if (instant) { this.cam = { x, y, k: k || this.cam.k }; this.fly = null; } else this.fly = { x, y, k: k || this.cam.k }; }
    w2s(x, y) { return [(x - this.cam.x) * this.cam.k + this.w / 2, (y - this.cam.y) * this.cam.k + this.h / 2]; }
    s2w(sx, sy) { return [(sx - this.w / 2) / this.cam.k + this.cam.x, (sy - this.h / 2) / this.cam.k + this.cam.y]; }
    zoomAt(sx, sy, f) {
      const [wx, wy] = this.s2w(sx, sy), k = M.clamp(this.cam.k * f, this.kFit * 0.6, 16);
      this.cam.k = k; this.cam.x = wx - (sx - this.w / 2) / k; this.cam.y = wy - (sy - this.h / 2) / k; this.fly = null;
    }

    bind() {
      const cv = this.cv; let drag = null;
      cv.addEventListener('wheel', ev => { ev.preventDefault(); const r = cv.getBoundingClientRect(); this.zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0016)); }, { passive: false });
      cv.addEventListener('mousedown', ev => { drag = { x: ev.clientX, y: ev.clientY, moved: 0 }; cv.classList.add('drag'); });
      root.addEventListener('mousemove', ev => {
        if (!drag) return;
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = ev.clientX; drag.y = ev.clientY;
        if (drag.moved > 4) { this.cam.x -= dx / this.cam.k; this.cam.y -= dy / this.cam.k; this.fly = null; this.follow = false; }
      });
      root.addEventListener('mouseup', ev => {
        if (!drag) return;
        const d = drag; drag = null; cv.classList.remove('drag');
        if (d.moved <= 4 && ev.target === cv) { const r = cv.getBoundingClientRect(); this.click(ev.clientX - r.left, ev.clientY - r.top, ev.shiftKey); }
      });
      this.sc.addEventListener('mousedown', ev => {
        const r = this.sc.getBoundingClientRect(), lin = this.lin0 + (ev.clientX - r.left - 14) / (this.sw - 28) * (this.lin1 - this.lin0);
        const p = this.linPoint(lin); this.follow = false; this.flyTo(p.x, p.y, Math.max(this.cam.k, 0.75));
      });
      root.addEventListener('resize', () => this.resize());
    }
    linPoint(lin) {
      const G = this.G, arr = G.main.A;
      for (const e of arr) if (lin >= e.lin && lin <= e.lin + e.len) return e.poly.at(lin - e.lin);
      if (lin < arr[0].lin) return arr[0].poly.at(0);
      const b = G.depotBox; return b ? { x: (b[0][0] + b[2][0]) / 2, y: (b[0][1] + b[2][1]) / 2 } : arr[arr.length - 1].poly.at(1e9);
    }
    click(sx, sy, shift) {
      const [wx, wy] = this.s2w(sx, sy), k = this.cam.k, sim = this.g.sim, G = this.G;
      if (!sim) return;
      if (k >= 0.4) {
        let best = null, bd = 14 / k;
        for (const sw of G.sw) { const d = Math.hypot(sw.node.x - wx, sw.node.y - wy); if (d < bd) { bd = d; best = sw; } }
        if (best) { this.g.ui.clickSwitch(best, shift); return; }
      }
      let bt = null, bd = Math.max(16 / k, 4);
      for (const tr of sim.trains) {
        if (tr.mode === 'gone' || !tr.route.length) continue;
        for (let i = 0; i <= TR.NCARS; i++) { const p = sim.pointBack(tr, Math.min(tr.L, i * TR.CAR_LEN)), d = Math.hypot(p.x - wx, p.y - wy); if (d < bd) { bd = d; bt = tr; } }
      }
      if (bt) { this.g.ui.select({ type: 'train', tr: bt }); return; }
      let bs = null; bd = Math.max(30 / k, 75);
      for (const s of G.st) { const d = Math.hypot(s.x - wx, s.y - wy); if (d < bd) { bd = d; bs = s; } }
      if (bs) { this.g.ui.select({ type: 'station', st: bs.i }); return; }
    }

    trainCol(tr) {
      if (tr.mode === 'crashed') return { fill: '#6b1016', line: C.red, tag: '#7a141b' };
      if (tr.fault || tr.status === 'repair') return { fill: '#4c1216', line: C.red, tag: '#5a151a' };
      if (tr.status === 'maint') return { fill: '#4a3b08', line: C.yellow, tag: '#4a3b08' };
      return { fill: C.car, line: C.carLine, tag: '#1a2430' };
    }

    // ------------------------------------------------------------------ кадр
    draw() {
      const ctx = this.ctx, G = this.G, sim = this.g.sim, dpr = this.dpr, W = this.w, H = this.h, cam = this.cam;
      if (this.follow && this.g.sel && this.g.sel.type === 'train' && sim) { const p = sim.trainXY(this.g.sel.tr); this.fly = { x: p.x, y: p.y, k: (this.fly && this.fly.k) || cam.k }; }
      if (this.fly) {
        const f = this.fly, a = 0.2;
        cam.x += (f.x - cam.x) * a; cam.y += (f.y - cam.y) * a; cam.k *= Math.pow(f.k / cam.k, a);
        if (!this.follow && Math.abs(f.x - cam.x) * cam.k < 0.5 && Math.abs(f.y - cam.y) * cam.k < 0.5 && Math.abs(f.k / cam.k - 1) < 0.004) { cam.x = f.x; cam.y = f.y; cam.k = f.k; this.fly = null; }
      }
      const k = cam.k, px = 1 / k, now = performance.now() / 1000;
      const world = () => ctx.setTransform(k * dpr, 0, 0, k * dpr, (W / 2 - cam.x * k) * dpr, (H / 2 - cam.y * k) * dpr);
      const screen = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.view = [cam.x - W / 2 / k, cam.y - H / 2 / k, cam.x + W / 2 / k, cam.y + H / 2 / k];
      const v = this.view, vis = bb => !(bb[2] < v[0] || bb[0] > v[2] || bb[3] < v[1] || bb[1] > v[3]);
      const inView = (x, y, m) => x > v[0] - m && x < v[2] + m && y > v[1] - m && y < v[3] + m;
      screen(); ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
      this.labels.length = 0;

      // --- фон: город, районы, вода
      world(); ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      if (this.hasCity) { ctx.fillStyle = C.land; ctx.fill(this.city, 'evenodd'); }
      ctx.fillStyle = C.water; ctx.fill(this.water, 'evenodd');
      if (k < 0.5) {
        ctx.strokeStyle = C.district; ctx.lineWidth = 1 * px; ctx.setLineDash([6 * px, 5 * px]);
        for (const d of this.districts) ctx.stroke(d.path);
        ctx.setLineDash([]);
      }
      if (this.hasCity) { ctx.strokeStyle = C.city; ctx.lineWidth = 1.3 * px; ctx.stroke(this.city); }
      if (k < 0.16) {
        screen(); ctx.fillStyle = C.dlabel; ctx.font = '600 10px ' + FONT; ctx.textAlign = 'center';
        for (const d of this.districts) if (inView(d.x, d.y, 0)) { const s = this.w2s(d.x, d.y); ctx.fillText(d.name.replace(/ район$/, '').toUpperCase(), s[0], s[1]); }
        world();
      }

      // --- депо
      if (G.depotBox) {
        const b = G.depotBox; ctx.beginPath(); ctx.moveTo(b[0][0], b[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(b[i][0], b[i][1]); ctx.closePath();
        ctx.fillStyle = 'rgba(40,52,68,0.35)'; ctx.fill(); ctx.strokeStyle = '#33445a'; ctx.lineWidth = Math.max(1 * px, 0.4); ctx.stroke();
      }

      // --- пути
      const groups = { aux: [], main: [], res: [], tsr: [], blocked: [] };
      for (const e of G.edges) {
        if (!vis(e.bb)) continue;
        (e.blocked ? groups.blocked : e.tsr ? groups.tsr : e.res && k >= 0.12 ? groups.res : e.isMain ? groups.main : groups.aux).push(e);
      }
      ctx.lineCap = 'round';
      if (k < 0.12) {
        ctx.strokeStyle = '#3d4b5c'; ctx.lineWidth = 1.2 * px; for (const e of groups.aux) ctx.stroke(e.path);
        ctx.strokeStyle = C.line; ctx.lineWidth = 3.4 * px; ctx.stroke(this.trunk);
        ctx.lineWidth = 3.4 * px; ctx.setLineDash([5 * px, 4 * px]);
        ctx.strokeStyle = C.yellow; for (const e of groups.tsr) ctx.stroke(e.path);
        ctx.strokeStyle = C.red; for (const e of groups.blocked) ctx.stroke(e.path);
        ctx.setLineDash([]);
      } else {
        if (k >= 0.55) { ctx.strokeStyle = C.bed; ctx.lineWidth = 3.5; for (const key in groups) for (const e of groups[key]) ctx.stroke(e.path); }
        const lw = Math.max(1.5 * px, 0.32);
        ctx.lineWidth = lw;
        ctx.strokeStyle = C.aux; for (const e of groups.aux) ctx.stroke(e.path);
        ctx.strokeStyle = C.line; for (const e of groups.main) ctx.stroke(e.path);
        ctx.strokeStyle = C.lineRes; for (const e of groups.res) ctx.stroke(e.path);
        ctx.lineWidth = lw * 1.4; ctx.setLineDash([7 * px, 5 * px]);
        ctx.strokeStyle = C.yellow; for (const e of groups.tsr) ctx.stroke(e.path);
        ctx.strokeStyle = C.red; for (const e of groups.blocked) ctx.stroke(e.path);
        ctx.setLineDash([]);
        if (k >= 0.2) {
          ctx.strokeStyle = '#4a586a'; ctx.lineWidth = Math.max(1.2 * px, 0.3); ctx.setLineDash([5, 4]);
          for (const d of G.decor) { ctx.beginPath(); d.pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); const q = d.pts[d.pts.length - 1]; this.labels.push({ x: q[0], y: q[1], t: d.label, c: '#5c6d82', f: '10px ', dx: 6, dy: 3 }); }
          ctx.setLineDash([]);
        }
      }

      // --- станции
      const LS = M.LINE.stations;
      for (const s of G.st) {
        if (!inView(s.x, s.y, 400)) continue;
        const info = LS[s.i], S = sim ? sim.stn[s.i] : null, closed = S && S.closed;
        const nx = -s.ty, ny = s.tx, side = s.i % 2 ? 1 : -1;
        const w = sim ? sim.waitDir(s.i) : [0, 0];
        if (k < 0.12) {
          screen(); const p = this.w2s(s.x, s.y);
          if (info.xfer) { ctx.beginPath(); ctx.arc(p[0], p[1], 8.5, 0, 7); ctx.fillStyle = info.xfer[0].color; ctx.fill(); }
          ctx.beginPath(); ctx.arc(p[0], p[1], 5.5, 0, 7); ctx.fillStyle = closed ? '#5a1a1e' : '#eef4fa'; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 2.5; ctx.stroke();
          world();
        } else {
          ctx.lineWidth = Math.max(1 * px, 0.25);
          for (const pl of s.plats) { ctx.fillStyle = closed ? '#2b1d22' : C.plat; ctx.fill(pl.path); ctx.strokeStyle = C.platLine; ctx.stroke(pl.path); }
          if (k >= 0.45) this.stationDetail(ctx, s, info, px);
          if (k >= 0.9) {
            ctx.fillStyle = C.pax;
            const r = Math.max(0.24, 0.62 * px), pp = this.pp[s.i];
            for (let pi = 0; pi < 2; pi++) {
              const pl = s.plats[pi], n = Math.min(1900, Math.round(w[pi])), L = pl.near.length - 1;
              ctx.beginPath();
              for (let j = 0; j < n; j++) {
                const u = pp[(j * 2 + pi * 1900) % 3800] * L, vv = pp[(j * 2 + 1 + pi * 1900) % 3800], i0 = Math.min(L - 1, Math.floor(u)), f = u - i0;
                const ax = pl.near[i0][0] + (pl.near[i0 + 1][0] - pl.near[i0][0]) * f, ay = pl.near[i0][1] + (pl.near[i0 + 1][1] - pl.near[i0][1]) * f;
                const bx = pl.far[i0][0] + (pl.far[i0 + 1][0] - pl.far[i0][0]) * f, by = pl.far[i0][1] + (pl.far[i0 + 1][1] - pl.far[i0][1]) * f;
                ctx.rect(ax + (bx - ax) * vv - r, ay + (by - ay) * vv - r, 2 * r, 2 * r);
              }
              ctx.fill();
            }
          }
        }
        const off = (k < 0.12 ? 12 : (s.sep / 2 + (s.side ? 9 : 2)) * k + 12);
        const tot = Math.round(w[0] + w[1]);
        const sub = closed ? 'закрыта' : (k < 0.9 ? (tot ? tot + ' чел.' : '') : 'I: ' + Math.round(w[0]) + ' · II: ' + Math.round(w[1]));
        this.labels.push({ x: s.x, y: s.y, t: k < 0.03 ? info.short : (k > 0.3 ? info.name : info.short), sub, c: closed ? '#ff9aa0' : C.text, f: '600 ' + (k < 0.12 ? 12 : 13) + 'px ', ox: nx * side * off, oy: ny * side * off, al: nx * side, xf: k >= 0.12 ? info.xfer : null, big: true });
      }

      // --- стрелки и светофоры
      if (sim && k >= 0.4) {
        const want = new Set();
        for (const tr of sim.trains) if (tr.needSw && tr.v < 0.1 && tr.mode === 'service') want.add(tr.needSw);
        for (const sw of G.sw) {
          const n = sw.node; if (!inView(n.x, n.y, 30)) continue;
          const lined = sw.pos === 'plus' ? sw.plus : sw.minus, L = Math.min(17, lined.len * 0.6);
          ctx.beginPath();
          for (let d = 0; d <= L + 0.01; d += L / 4) { const q = lined.poly.at(lined.a === n ? d : lined.len - d); if (d) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
          ctx.strokeStyle = sw.moving ? '#ffffff' : sw.pos === 'plus' ? '#d9ffe9' : '#ffd24d'; ctx.lineWidth = Math.max(2.6 * px, 0.6); ctx.stroke();
          screen(); const p = this.w2s(n.x, n.y), r = sw.depot ? 2.6 : 4.2;
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7);
          ctx.fillStyle = sw.broken ? C.red : sw.moving ? (Math.floor(now * 6) % 2 ? '#fff' : '#555') : sw.depot ? '#5d6e84' : '#e8eef6'; ctx.fill();
          if (n.res && !sw.depot) { ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 2; ctx.stroke(); }
          if (want.has(sw)) { ctx.beginPath(); ctx.arc(p[0], p[1], 9 + 4 * Math.abs(Math.sin(now * 4)), 0, 7); ctx.strokeStyle = C.sel; ctx.lineWidth = 2.2; ctx.stroke(); }
          if (k >= 1.1 && !sw.depot) { ctx.fillStyle = '#93a5ba'; ctx.font = '10px ' + FONT; ctx.textAlign = 'left'; ctx.fillText('№' + sw.name, p[0] + 7, p[1] - 6); }
          world();
        }
        if (k >= 0.7) {
          screen();
          for (const sg of G.signals) {
            if (!inView(sg.x, sg.y, 10)) continue;
            const a = sim.aspect(sg), p = this.w2s(sg.x, sg.y);
            ctx.beginPath(); ctx.arc(p[0], p[1], 2.8, 0, 7); ctx.fillStyle = a === 'red' ? C.red : a === 'green' ? C.green : '#2c6a47'; ctx.fill();
          }
          world();
        }
      }

      // --- поезда
      if (sim) {
        const sel = this.g.sel && this.g.sel.type === 'train' ? this.g.sel.tr : null;
        if (sel && sel.mode === 'service' && k >= 0.12) {
          ctx.strokeStyle = 'rgba(85,208,255,0.55)'; ctx.lineWidth = Math.max(2.2 * px, 0.5); ctx.setLineDash([6 * px, 6 * px]);
          for (let i = sel.hi; i < sel.route.length; i++) ctx.stroke(sel.route[i].e.path);
          ctx.setLineDash([]);
        }
        let inDepot = 0;
        for (const tr of sim.trains) {
          if (tr.mode === 'gone' || !tr.route.length) continue;
          const dep = tr.mode === 'parked' && tr.parkedAt && tr.parkedAt[0] === 'D';
          if (dep) inDepot++;
          const h = sim.pointBack(tr, 0);
          if (!inView(h.x, h.y, 160)) continue;
          const col = this.trainCol(tr), isSel = tr === sel;
          if (k < 0.12) {
            if (dep) continue;
            screen();
            const m = sim.pointBack(tr, tr.L / 2), p = this.w2s(m.x, m.y), ang = Math.atan2(m.ty, m.tx);
            ctx.translate(p[0] * dpr, p[1] * dpr); ctx.rotate(ang);
            ctx.fillStyle = col.fill; ctx.strokeStyle = isSel ? C.sel : col.line; ctx.lineWidth = isSel ? 2.4 : 1.5;
            ctx.beginPath(); ctx.moveTo(-8, -1); ctx.lineTo(4, -1); ctx.lineTo(9, 4); ctx.lineTo(4, 9); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
            screen();
            this.labels.push({ x: m.x, y: m.y, t: String(tr.num), c: isSel ? C.sel : col.line, f: '600 10px ', ox: -m.ty * 15, oy: m.tx * 15, al: 0, tagFill: null });
          } else if (k < 0.5) {
            ctx.beginPath();
            for (let d = 0; d <= tr.L + 0.1; d += tr.L / 6) { const q = sim.pointBack(tr, d); if (d) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
            ctx.lineCap = 'butt';
            ctx.strokeStyle = isSel ? C.sel : col.line; ctx.lineWidth = Math.max(5.5 * px, 3.2); ctx.stroke();
            ctx.strokeStyle = col.fill; ctx.lineWidth = Math.max(3.2 * px, 2.2); ctx.stroke();
            ctx.lineCap = 'round';
            if (!dep || k > 0.3) this.labels.push({ x: h.x, y: h.y, t: tr.num + (tr.mode === 'service' && k >= 0.2 ? ' · ' + Math.round(tr.loadTot) : ''), c: isSel ? C.sel : col.line, f: '600 11px ', ox: -h.ty * 14, oy: h.tx * 14, al: 0, tagFill: col.tag });
          } else {
            const cw = Math.max(2.7, 3.4 * px), dots = k >= 1.0, r = Math.max(0.2, 0.55 * px), stride = k >= 2.2 ? 1 : k >= 1.4 ? 2 : 3;
            for (let i = 0; i < TR.NCARS; i++) {
              const q = sim.pointBack(tr, (i + 0.5) * TR.CAR_LEN), cs = q.tx, sn = q.ty;
              ctx.setTransform(cs * k * dpr, sn * k * dpr, -sn * k * dpr, cs * k * dpr, ((q.x - cam.x) * k + W / 2) * dpr, ((q.y - cam.y) * k + H / 2) * dpr);
              ctx.beginPath(); ctx.roundRect(-9.5, -cw / 2, 19, cw, 0.55);
              ctx.fillStyle = col.fill; ctx.fill();
              ctx.strokeStyle = isSel ? C.sel : col.line; ctx.lineWidth = Math.max(0.16, (isSel ? 1.8 : 1.1) * px); ctx.stroke();
              if (i === 0) { ctx.fillStyle = '#fff6c9'; ctx.fillRect(9.0, -cw / 2 + 0.25, 0.5, 0.5); ctx.fillRect(9.0, cw / 2 - 0.75, 0.5, 0.5); }
              if (i === TR.NCARS - 1) { ctx.fillStyle = C.red; ctx.fillRect(-9.5, -cw / 2 + 0.25, 0.5, 0.5); ctx.fillRect(-9.5, cw / 2 - 0.75, 0.5, 0.5); }
              if (dots) {
                const n = Math.min(TR.CAR_CAP, Math.round(tr.car[i])), sl = this.slots, o = (tr.num * 7 + i * 13) % 40;
                ctx.fillStyle = C.pax; ctx.beginPath();
                for (let j = 0; j < n; j += stride) { const s2 = sl[j < 40 ? (j + o) % 40 : j]; ctx.rect(s2[0] - r, s2[1] - r, 2 * r, 2 * r); }
                ctx.fill();
              }
              if (tr.mode === 'crashed') { ctx.strokeStyle = C.red; ctx.lineWidth = 0.3; ctx.beginPath(); ctx.moveTo(-9, -1.2); ctx.lineTo(9, 1.2); ctx.moveTo(-9, 1.2); ctx.lineTo(9, -1.2); ctx.stroke(); }
            }
            world();
            const st = tr.mode === 'service' && tr.v < 0.1 && tr.phase === 'move' && tr.waitT > 3;
            this.labels.push({ x: h.x, y: h.y, t: '№ ' + tr.num + (tr.mode === 'service' ? ' · ' + Math.round(tr.loadTot) + ' чел.' : ''), c: isSel ? C.sel : col.line, f: '600 11px ', ox: -h.ty * (cw * k / 2 + 13), oy: h.tx * (cw * k / 2 + 13), al: 0, tagFill: col.tag, dot: st ? C.red : null });
          }
        }
        if (G.depotLabel && inView(G.depotLabel[0], G.depotLabel[1], 300)) this.labels.push({ x: G.depotLabel[0], y: G.depotLabel[1], t: 'Депо ' + M.LINE.depotName, sub: 'составов: ' + inDepot, c: '#9fb0c4', f: '600 12px ', ox: 0, oy: -6, al: 0, big: true });

        // --- отметки нештатных ситуаций
        screen();
        for (const inc of sim.incidents) {
          if (inc.done || (!inc.x && !inc.y) || !inView(inc.x, inc.y, 50)) continue;
          const p = this.w2s(inc.x, inc.y), col = inc.level === 'bad' || inc.type === 'crash' ? C.red : C.yellow, ph = (now * 1.3 + inc.id * 0.37) % 1;
          ctx.strokeStyle = col; ctx.globalAlpha = 1 - ph; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p[0], p[1], 12 + ph * 22, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
          ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(p[0], p[1] - 34); ctx.lineTo(p[0] + 9, p[1] - 18); ctx.lineTo(p[0] - 9, p[1] - 18); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#10151c'; ctx.font = '700 11px ' + FONT; ctx.textAlign = 'center'; ctx.fillText('!', p[0], p[1] - 20.5);
        }
      }

      // --- подписи
      screen(); ctx.textBaseline = 'middle';
      for (const L of this.labels) {
        const p = this.w2s(L.x, L.y); let x = p[0] + (L.ox || 0) + (L.dx || 0), y = p[1] + (L.oy || 0) + (L.dy || 0);
        ctx.font = L.f + FONT;
        const tw = ctx.measureText(L.t).width, al = L.al || 0;
        let tx = al > 0.35 ? x : al < -0.35 ? x - tw : x - tw / 2;
        if (L.dx) tx = x;
        if (L.tagFill !== undefined) {
          const pad = 4, hh = 15;
          if (L.tagFill) { ctx.fillStyle = L.tagFill; ctx.strokeStyle = L.c; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(tx - pad, y - hh / 2, tw + pad * 2 + (L.dot ? 10 : 0), hh, 4); ctx.fill(); ctx.stroke(); }
          ctx.fillStyle = L.tagFill ? '#eef4fa' : L.c; ctx.textAlign = 'left'; ctx.fillText(L.t, tx, y + 0.5);
          if (L.dot) { ctx.fillStyle = L.dot; ctx.beginPath(); ctx.arc(tx + tw + 7, y, 3.2, 0, 7); ctx.fill(); }
          continue;
        }
        ctx.textAlign = 'left';
        if (L.big) { ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(6,8,11,0.9)'; ctx.strokeText(L.t, tx, y); }
        ctx.fillStyle = L.c; ctx.fillText(L.t, tx, y);
        if (L.xf) { let bx = tx + tw + 9; for (const xf of L.xf) { ctx.beginPath(); ctx.arc(bx, y, 7, 0, 7); ctx.fillStyle = xf.color; ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = '700 9px ' + FONT; ctx.textAlign = 'center'; ctx.fillText(String(xf.line), bx, y + 0.5); bx += 17; } ctx.textAlign = 'left'; }
        if (L.sub) { ctx.font = '11px ' + FONT; const sw2 = ctx.measureText(L.sub).width, sx2 = al > 0.35 ? x : al < -0.35 ? x - sw2 : x - sw2 / 2; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,8,11,0.9)'; ctx.strokeText(L.sub, sx2, y + 14); ctx.fillStyle = L.c === C.text ? '#c9b97a' : L.c; ctx.fillText(L.sub, sx2, y + 14); }
      }
      // масштабная линейка
      const cand = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]; let bar = cand[0];
      for (const c of cand) if (c * k <= 140) bar = c;
      ctx.strokeStyle = '#6b7c90'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(W - 24 - bar * k, H - 18); ctx.lineTo(W - 24 - bar * k, H - 13); ctx.lineTo(W - 24, H - 13); ctx.lineTo(W - 24, H - 18); ctx.stroke();
      ctx.fillStyle = '#8496aa'; ctx.font = '11px ' + FONT; ctx.textAlign = 'right'; ctx.fillText(bar >= 1000 ? bar / 1000 + ' км' : bar + ' м', W - 24, H - 26);
      this.drawStrip();
    }

    stationDetail(ctx, s, info, px) {
      const line = (pts, col, w, dash) => { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.lineCap = 'butt'; ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'round'; };
      const mix = (pl, t) => pl.near.map((q, i) => [q[0] + (pl.far[i][0] - q[0]) * t, q[1] + (pl.far[i][1] - q[1]) * t]);
      for (const pl of s.plats) {
        if (info.kind === 'closed') line(pl.near, '#8296ad', Math.max(0.9, 2 * px), [3.4, 1.5]);            // стена с дверными проёмами
        else if (info.kind === 'psd') line(pl.near, '#59c8df', Math.max(0.35, 1.4 * px), [3.4, 1.5]);        // стеклянные платформенные двери
        else if (info.kind === 'column') line(mix(pl, 0.5), '#75869b', Math.max(0.8, 1.6 * px), [0.8, 4.2]); // ряд колонн
        else if (info.kind === 'surface') line(pl.far, '#5a6b80', Math.max(0.4, 1.2 * px), [2, 2]);           // навес наземной станции
      }
      if (info.kind === 'vault') { const a = s.plats[0].far; line(a, '#33404f', Math.max(0.25, 1 * px), [6, 6]); }
    }

    // ------------------------------------------------------------------ лента-схема линии
    drawStrip() {
      const c = this.sx, W = this.sw, H = this.sh, G = this.G, sim = this.g.sim, dpr = this.dpr, LS = M.LINE.stations;
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#0a0e14'; c.fillRect(0, 0, W, H);
      const X = lin => 14 + (lin - this.lin0) / (this.lin1 - this.lin0) * (W - 28), yA = 31, yB = 43, sv = G.sv.A, NS = G.NS;
      const a0 = G.main.A[0].lin, aEnd = G.main.A[G.main.A.length - 1], b0 = G.main.B[0].lin, bEnd = G.main.B[G.main.B.length - 1];
      c.lineWidth = 2; c.strokeStyle = '#1b6b40';
      c.beginPath(); c.moveTo(X(a0), yA); c.lineTo(X(aEnd.lin + aEnd.len), yA); c.moveTo(X(b0), yB); c.lineTo(X(bEnd.lin + bEnd.len * (bEnd.linK || 1)), yB); c.stroke();
      c.strokeStyle = '#44546a'; c.lineWidth = 1.5;
      for (const sw of G.sw) { if (sw.depot || !sw.minus || sw.minus.kind !== 'conn') continue; const x = X(sw.minus.lin); c.beginPath(); c.moveTo(x - 4, yA); c.lineTo(x + 4, yB); c.stroke(); }
      const dx0 = X(G.depotLin || this.lin1) - 26;
      c.fillStyle = 'rgba(40,52,68,0.6)'; c.strokeStyle = '#3a4b60'; c.beginPath(); c.roundRect(dx0, 20, 52, 34, 4); c.fill(); c.stroke();
      let dep = 0; const vcam = this.linOfXY(this.cam.x, this.cam.y);
      c.font = '11px ' + FONT; c.textBaseline = 'middle';
      for (let i = 0; i < NS; i++) {
        const x = X(sv[i]), S = sim && sim.stn[i], w = sim ? sim.waitDir(i) : [0, 0], up = i % 2 === 0;
        c.fillStyle = S && S.closed ? '#5a1a1e' : '#dfe8f2'; c.beginPath(); c.roundRect(x - 3.5, yA - 5, 7, yB - yA + 10, 3); c.fill();
        if (LS[i].xfer) { c.fillStyle = LS[i].xfer[0].color; c.beginPath(); c.arc(x, (yA + yB) / 2, 2.6, 0, 7); c.fill(); }
        c.fillStyle = this.g.sel && this.g.sel.type === 'station' && this.g.sel.st === i ? C.sel : '#b9c7d8'; c.textAlign = 'center';
        const nm = LS[i].short, tot = Math.round(w[0] + w[1]);
        c.fillText(nm, M.clamp(x, 44, W - 60), up ? 10 : H - 9);
        if (tot > 0) { c.fillStyle = tot > 1800 ? C.red : tot > 900 ? C.yellow : '#8f9a6c'; c.font = '10px ' + FONT; c.fillText(String(tot), x, up ? H - 20 : 21.5); c.font = '11px ' + FONT; }
      }
      if (sim) {
        const sel = this.g.sel && this.g.sel.type === 'train' ? this.g.sel.tr : null;
        for (const tr of sim.trains) {
          if (tr.mode === 'gone' || !tr.route.length) continue;
          if (tr.mode === 'parked' && tr.parkedAt && tr.parkedAt[0] === 'D') { dep++; continue; }
          const s = tr.route[tr.hi], e = s.e, off = tr.pos - tr.cum[tr.hi], x = X(e.lin + (e.linK || 0) * (s.d > 0 ? off : e.len - off));
          const y = e.track === 'A' ? yA : e.track === 'B' ? yB : (yA + yB) / 2, col = this.trainCol(tr), d = s.d > 0 ? 1 : -1;
          c.fillStyle = tr === sel ? C.sel : col.line === C.carLine ? '#e6eef7' : col.line;
          if (tr.mode === 'parked') { c.fillRect(x - 3, y - 3, 6, 6); continue; }
          c.beginPath(); c.moveTo(x + 6 * d, y); c.lineTo(x - 4 * d, y - 4.5); c.lineTo(x - 4 * d, y + 4.5); c.closePath(); c.fill();
          if (tr.v < 0.1 && tr.phase === 'move' && tr.waitT > 5) { c.fillStyle = C.red; c.fillRect(x - 1, y - 7.5, 2, 2); }
        }
        c.fillStyle = '#b9c7d8'; c.textAlign = 'center'; c.fillText('депо', dx0 + 26, 31); c.fillStyle = '#e6eef7'; c.font = '600 12px ' + FONT; c.fillText(String(dep), dx0 + 26, 45);
      }
      if (this.cam.k > this.kFit * 1.6 && vcam != null) { const x = X(vcam); c.strokeStyle = C.sel; c.lineWidth = 1.5; c.strokeRect(x - 9, 22, 18, 30); }
    }
    linOfXY(x, y) {
      let best = null, bd = 1e9;
      for (const e of this.G.main.A) { const p = e.poly.project(x, y); if (p.dist < bd) { bd = p.dist; best = e.lin + p.d; } }
      return bd < 3000 ? best : null;
    }
  }
  M.Render = Render;
})(typeof window !== 'undefined' ? window : globalThis);
