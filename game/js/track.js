/* Построение графа путей: главные пути по реальной геометрии, съезды, тупики, депо. */
(function (root) {
  'use strict';
  const M = root.M;
  const KMH = 1 / 3.6;
  const PLAT_HALF = 78;   // половина длины станционного пути
  const BLOCK = 260;      // наибольшая длина блок-участка на перегоне
  const X1 = 100, X2 = 185;          // границы съездов от оси станции
  const TAIL = 170;                  // длина оборотного тупика
  const SID = 165;                   // длина пути отстоя

  M.buildGraph = function (GEO, LINE) {
    const NS = LINE.stations.length;
    const G = {
      NS, nodes: [], edges: [], sw: [], stops: {}, turn: [], sidings: [], sidingById: {}, depot: [],
      st: [], zones: [], signals: [], main: { A: [], B: [] }, depotBox: null, decor: []
    };
    for (let i = 0; i < NS; i++) { G.turn.push({}); G.zones.push({ auto: true, sw: [] }); }
    const feats = LINE.features;
    const fHi = feats.find(f => f.t === 'termHi'), LEAD = 450, NDEP = (fHi && fHi.depot) || 24;

    // ---------- 1. Геометрия главных путей ----------
    const stXY = LINE.stations.map((s, i) => M.proj(GEO.stations && GEO.stations[i] ? GEO.stations[i] : [s.lon, s.lat]));
    function trimmed(pts) {
      const P = new M.Poly(pts);
      const s0 = P.project(stXY[0][0], stXY[0][1]).d, s1 = P.project(stXY[NS - 1][0], stXY[NS - 1][1]).d;
      const a = Math.max(0, s0 - 80), b = Math.min(P.len, s1 + 80);
      return { q: P.slice(a, b), lo: s0 - a, hi: b - s1 };
    }
    const rA = trimmed(GEO.tracks.A.map(M.proj)), rB = trimmed(GEO.tracks.B.map(M.proj));
    function endDir(q, low) {
      const P = new M.Poly(q), L = Math.min(140, P.len);
      const a = low ? P.at(L) : P.at(P.len - L), b = low ? P.at(0) : P.at(P.len);
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return [(b.x - a.x) / l, (b.y - a.y) / l];
    }
    function avgDir(d1, d2) { const x = d1[0] + d2[0], y = d1[1] + d2[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; }
    const dLo = avgDir(endDir(rA.q, true), endDir(rB.q, true)), dHi = avgDir(endDir(rA.q, false), endDir(rB.q, false));
    const needLo = X2 + 2 * TAIL + 5, needHiA = X2 + TAIL + 85 + LEAD + 5, needHiB = X2 + TAIL + 5;
    function extended(r, extLo, extHi) {
      const q = r.q, lo = [], hi = [], h = q[0], t = q[q.length - 1];
      for (let d = extLo; d > 0; d -= 10) lo.push([h[0] + dLo[0] * d, h[1] + dLo[1] * d]);
      for (let d = 10; d <= extHi; d += 10) hi.push([t[0] + dHi[0] * d, t[1] + dHi[1] * d]);
      const all = lo.concat(q, hi);
      return M.smoothPts(new M.Poly(all).resample(8), 22);
    }
    const T = {
      A: new M.Poly(extended(rA, needLo - rA.lo + 20, needHiA - rA.hi + 20)),
      B: new M.Poly(extended(rB, needLo - rB.lo + 20, needHiB - rB.hi + 20))
    };
    const sv = { A: [], B: [] };
    function locate() {
      for (const k of ['A', 'B']) sv[k] = stXY.map(p => T[k].project(p[0], p[1]).d);
    }
    locate();

    // Раздвижка путей там, где нужна островная платформа или путь между главными.
    function widen(st, o1, o2, minSep) {
      let need = 0;
      for (let o = o1; o <= o2; o += 10) {
        const a = T.A.at(sv.A[st] + o), b = T.B.at(sv.B[st] + o);
        need = Math.max(need, (minSep - Math.hypot(a.x - b.x, a.y - b.y)) / 2);
      }
      if (need <= 0.05) return;
      const ramp = Math.max(130, need * 24);
      for (const k of ['A', 'B']) {
        const P = T[k], s0 = sv[k][st], sg = k === 'A' ? 1 : -1, np = [];
        for (let i = 0; i < P.p.length; i++) {
          const o = P.cum[i] - s0, p = P.p[i];
          if (o < o1 - ramp || o > o2 + ramp) { np.push(p); continue; }
          const w = o < o1 ? M.smooth((o - (o1 - ramp)) / ramp) : o > o2 ? M.smooth((o2 + ramp - o) / ramp) : 1;
          const q = P.at(P.cum[i]);
          np.push([p[0] - q.ty * sg * need * w, p[1] + q.tx * sg * need * w]);
        }
        T[k] = new M.Poly(np);
      }
      locate();
    }
    LINE.stations.forEach((s, i) => { if (s.plat === 'island') widen(i, -70, 70, 13.5); });
    for (const f of feats) {
      if (f.t === 'siding') widen(f.st, f.side > 0 ? X1 - 10 : -(X2 + SID + 70), f.side > 0 ? X2 + SID + 70 : -(X1 - 10), f.n > 1 ? 17 : 11.5);
      if (f.t === 'termLo') widen(f.st, -needLo, -X1, 5.2);
      if (f.t === 'termHi') widen(f.st, X1, needHiB, 5.2);
    }

    // ---------- 2. Узлы, рёбра, стрелки ----------
    let nid = 0, eid = 0;
    function mkNode(x, y) { const n = { id: nid++, x, y, edges: [], sw: null, res: null }; G.nodes.push(n); return n; }
    const VMAX = { main: LINE.lineSpeed, platform: 60, rev: LINE.lineSpeed, conn: 40, siding: 35, tail: 40, lead: 40, throat: 20, depot: 15 };
    function mkEdge(a, b, pts, attrs) {
      const P = new M.Poly(pts);
      const e = Object.assign({
        id: eid++, a, b, poly: P, len: P.len, kind: 'main', track: null, nd: 0, st: null, zone: null, conf: null,
        occ: [], res: null, blocked: 0, sigFault: false, tsr: 0, vmax: 0, safeStop: false, gr: null, name: '', lin: 0
      }, attrs);
      e.vmax = (VMAX[e.kind] || 40) * KMH;
      // на однопутном соединительном пути в депо останавливаться нельзя — иначе встречные поезда запрут друг друга
      e.safeStop = e.len >= 138 && e.kind !== 'conn' && e.kind !== 'throat' && e.kind !== 'lead';
      a.edges.push(e); b.edges.push(e); G.edges.push(e);
      return e;
    }
    function mkSwitch(node, stem, plus, minus, attrs) {
      const sw = Object.assign({ id: G.sw.length, node, stem, plus, minus, pos: 'plus', target: 'plus', moving: 0, broken: false, zone: null, depot: false, name: '' }, attrs);
      node.sw = sw; G.sw.push(sw);
      if (sw.zone != null && !sw.depot) G.zones[sw.zone].sw.push(sw);
      return sw;
    }
    const cuts = { A: [], B: [] }, ranges = { A: [], B: [] }, pendStops = [];
    function cutAt(k, s, pend) {
      for (const c of cuts[k]) if (Math.abs(c.s - s) < 1) { if (pend) c.pend = pend; return c.node; }
      const q = T[k].at(s), n = mkNode(q.x, q.y);
      cuts[k].push({ s, node: n, pend: pend || null });
      return n;
    }
    function swCut(k, st, off, dir) { const pend = { dir, minus: null, zone: st }; const n = cutAt(k, sv[k][st] + off, pend); n.pend = pend; return n; }
    function tanAt(k, st, off, dir) { const q = T[k].at(sv[k][st] + off); return [q.tx * dir, q.ty * dir]; }
    function link(n0, t0, n1, t1, attrs) { return mkEdge(n0, n1, M.hermite([n0.x, n0.y], t0, [n1.x, n1.y], t1), attrs); }
    function addStop(id, e, c, extra) { G.stops[id] = Object.assign({ id, e, c, st: null, kind: id[0], name: '' }, extra); }

    function scissors(st, o1, o2) {
      const a1 = swCut('A', st, o1, 1), b2 = swCut('B', st, o2, -1), b1 = swCut('B', st, o1, 1), a2 = swCut('A', st, o2, -1);
      const lin = sv.A[st] + (o1 + o2) / 2;
      const e1 = link(a1, tanAt('A', st, o1, 1), b2, tanAt('B', st, o2, 1), { kind: 'conn', zone: st, lin });
      const e2 = link(b1, tanAt('B', st, o1, 1), a2, tanAt('A', st, o2, 1), { kind: 'conn', zone: st, lin });
      e1.conf = [e2]; e2.conf = [e1];
      a1.pend.minus = e1; b2.pend.minus = e1; b1.pend.minus = e2; a2.pend.minus = e2;
    }
    function midPts(st, o1, o2, lat) {
      const out = [], n = Math.max(2, Math.round(Math.abs(o2 - o1) / 8));
      for (let i = 0; i <= n; i++) {
        const o = o1 + (o2 - o1) * i / n, a = T.A.at(sv.A[st] + o), b = T.B.at(sv.B[st] + o);
        const nx = b.x - a.x, ny = b.y - a.y, l = Math.hypot(nx, ny) || 1;
        out.push([(a.x + b.x) / 2 + nx / l * lat, (a.y + b.y) / 2 + ny / l * lat]);
      }
      return out;
    }
    function dirOf(pts) { const a = pts[0], b = pts[1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
    const P = (st, k) => 'P:' + st + ':' + k;
    const stName = st => LINE.stations[st].short;

    function centerSiding(st, side, n, ssv) {
      const arrK = side > 0 ? 'A' : 'B', depK = side > 0 ? 'B' : 'A', lin = sv.A[st] + side * (X2 + 60);
      const aS = swCut('A', st, side * X1, side), bS = swCut('B', st, side * X1, side);
      const ids = [];
      const neckPts = midPts(st, side * 175, side * 190, 0), tN = dirOf(neckPts);
      const N = mkNode(neckPts[0][0], neckPts[0][1]);
      const cA = link(aS, tanAt('A', st, side * X1, side), N, tN, { kind: 'conn', zone: st, lin });
      const cB = link(bS, tanAt('B', st, side * X1, side), N, tN, { kind: 'conn', zone: st, lin });
      aS.pend.minus = cA; bS.pend.minus = cB;
      const cArr = side > 0 ? cA : cB, cDep = side > 0 ? cB : cA;
      if (n === 1) {
        const pts = midPts(st, side * 175, side * (175 + SID), 0);
        const E = mkNode(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        const e = mkEdge(N, E, pts, { kind: 'siding', zone: st, lin, name: '3 путь' });
        mkSwitch(N, e, cArr, cDep, { zone: st });
        addStop('S:' + st + ':3', e, SID / 2, { st, name: 'тупик ст. ' + stName(st) + ' (3 путь)' });
        ids.push('S:' + st + ':3');
        if (ssv) {
          // служебная соединительная ветвь — только обозначение на схеме
          const sgn = st % 2 ? 1 : -1, far = midPts(st, side * (175 + SID + 230), side * (175 + SID + 240), sgn * 85);
          const last = pts[pts.length - 1], t0 = dirOf(pts.slice(-2)), t1 = dirOf([last, far[0]]);
          G.decor.push({ pts: M.hermite(last, t0, far[0], t1), label: ssv });
        }
      } else {
        const N2 = mkNode(neckPts[neckPts.length - 1][0], neckPts[neckPts.length - 1][1]);
        const lead = mkEdge(N, N2, neckPts, { kind: 'conn', zone: st, lin });
        mkSwitch(N, lead, cArr, cDep, { zone: st });
        const es = [];
        for (let j = 0; j < 2; j++) {
          const lat = j ? 2.9 : -2.9;
          const body = midPts(st, side * 235, side * (235 + SID), lat);
          const fan = M.hermite([N2.x, N2.y], tN, body[0], dirOf(body));
          const pts = fan.concat(body.slice(1));
          const E = mkNode(pts[pts.length - 1][0], pts[pts.length - 1][1]);
          const e = mkEdge(N2, E, pts, { kind: 'siding', zone: st, lin, name: (3 + j) + ' путь' });
          es.push(e);
          addStop('S:' + st + ':' + (3 + j), e, e.len - SID / 2, { st, name: 'тупик ст. ' + stName(st) + ' (' + (3 + j) + ' путь)' });
          ids.push('S:' + st + ':' + (3 + j));
        }
        mkSwitch(N2, lead, es[0], es[1], { zone: st });
        if (ssv) {
          const p3 = es[0].poly.p, last = p3[p3.length - 1], far = midPts(st, side * (235 + SID + 230), side * (235 + SID + 240), -85);
          G.decor.push({ pts: M.hermite(last, dirOf(p3.slice(-2)), far[0], dirOf([last, far[0]])), label: ssv });
        }
      }
      const alts = ids.map(id => [{ stop: id, reverse: true }]);
      G.turn[st][arrK] = [
        { stop: P(st, arrK), st, alight: 'all' },
        alts.length > 1 ? { choose: alts } : alts[0][0],
        { stop: P(st, depK), st, board: true, term: true, setDir: depK }
      ];
      for (const id of ids) {
        G.sidings.push({
          id, st, dk: arrK, name: G.stops[id].name,
          access: [{ stop: P(st, arrK), st, alight: 'all' }, { stop: id, park: true }],
          exit: [{ stop: P(st, depK), st, board: true, term: true, setDir: depK }]
        });
      }
    }

    // Пошёрстный съезд: со II пути (меньший пикет) на I путь (больший пикет) — оба перевода пошёрстные
    // для правильного направления движения, воспользоваться им можно только после смены направления.
    function trailing(st, o1, o2) {
      const b1 = swCut('B', st, o1, 1), a2 = swCut('A', st, o2, -1);
      const e = link(b1, tanAt('B', st, o1, 1), a2, tanAt('A', st, o2, 1), { kind: 'conn', zone: st, lin: sv.A[st] + (o1 + o2) / 2 });
      b1.pend.minus = e; a2.pend.minus = e;
    }
    function midScissors(st, side, single) {
      const o1 = side > 0 ? X1 : -X2, o2 = side > 0 ? X2 : -X1;
      if (single) trailing(st, o1, o2); else scissors(st, o1, o2);
      if (side < 0) {
        // оборот прибывших со стороны Рыбацкого: за съезд по II пути, смена кабины, по съезду на I путь
        const s0 = sv.B[st] + o1 - 10 - SID;
        cutAt('B', s0); cutAt('B', s0 + SID);
        ranges.B.push({ s0, s1: s0 + SID, kind: 'rev', st });
        pendStops.push({ id: 'R:' + st + ':B', k: 'B', s: s0 + SID / 2, st, name: 'за съездом ст. ' + stName(st) });
        if (!single) G.turn[st].A = [{ stop: P(st, 'B'), st, alight: 'all', board: true, reverse: true, term: true, setDir: 'B' }];
        G.turn[st].B = [{ stop: P(st, 'B'), st, alight: 'all' }, { stop: 'R:' + st + ':B', reverse: true }, { stop: P(st, 'A'), st, board: true, term: true, setDir: 'A' }];
      } else {
        const s0 = sv.A[st] + o2 + 10;
        cutAt('A', s0); cutAt('A', s0 + SID);
        ranges.A.push({ s0, s1: s0 + SID, kind: 'rev', st });
        pendStops.push({ id: 'R:' + st + ':A', k: 'A', s: s0 + SID / 2, st, name: 'за съездом ст. ' + stName(st) });
        if (!single) G.turn[st].B = [{ stop: P(st, 'A'), st, alight: 'all', board: true, reverse: true, term: true, setDir: 'A' }];
        G.turn[st].A = [{ stop: P(st, 'A'), st, alight: 'all' }, { stop: 'R:' + st + ':A', reverse: true }, { stop: P(st, 'B'), st, board: true, term: true, setDir: 'B' }];
      }
    }

    let sRoot = 0;
    for (const f of feats) {
      const st = f.st;
      if (f.t === 'scissors' || f.t === 'xover') midScissors(st, f.side, f.t === 'xover');
      else if (f.t === 'siding') centerSiding(st, f.side, f.n || 1, f.ssv);
      else if (f.t === 'termLo') {
        scissors(st, -X2, -X1);
        for (const k of ['A', 'B']) {
          const s = sv[k][st];
          cutAt(k, s - X2 - TAIL); cutAt(k, s - X2 - 2 * TAIL);
          ranges[k].push({ s0: s - X2 - 2 * TAIL, s1: s - X2, kind: 'tail', st });
          const pn = k === 'A' ? 3 : 4;
          pendStops.push({ id: 'S:' + st + ':' + k + 'n', k, s: s - X2 - TAIL / 2, st, name: 'оборотный тупик ст. ' + stName(st) + ' (' + pn + ' путь)' });
          pendStops.push({ id: 'S:' + st + ':' + k + 'f', k, s: s - X2 - TAIL * 1.5, st, name: 'тупик ст. ' + stName(st) + ' (' + pn + ' путь, дальний)' });
          G.sidings.push({
            id: 'S:' + st + ':' + k + 'f', st, dk: 'B', name: 'тупик ст. ' + stName(st) + ' (' + pn + ' путь)',
            access: [{ stop: P(st, 'B'), st, alight: 'all' }, { stop: 'S:' + st + ':' + k + 'f', park: true }],
            exit: [{ stop: P(st, 'A'), st, board: true, term: true, setDir: 'A' }]
          });
        }
        G.turn[st].B = [
          { stop: P(st, 'B'), st, alight: 'all' },
          { choose: [[{ stop: 'S:' + st + ':Bn', reverse: true }], [{ stop: 'S:' + st + ':An', reverse: true }]] },
          { stop: P(st, 'A'), st, board: true, term: true, setDir: 'A' }
        ];
      } else if (f.t === 'termHi') {
        scissors(st, X1, X2);
        for (const k of ['A', 'B']) {
          const s = sv[k][st];
          cutAt(k, s + X2 + TAIL);
          ranges[k].push({ s0: s + X2, s1: s + X2 + TAIL, kind: 'tail', st });
          pendStops.push({ id: 'S:' + st + ':' + k, k, s: s + X2 + TAIL / 2, st, name: 'оборотный тупик ст. ' + stName(st) + ' (' + (k === 'A' ? 3 : 4) + ' путь)' });
        }
        const sJ = sv.A[st] + X2 + TAIL + 85;
        sRoot = sJ + LEAD;
        const j = swCut('A', st, X2 + TAIL + 85, -1);
        j.pend.depot = true;
        cutAt('A', sRoot);
        ranges.A.push({ s0: sv.A[st] + X2 + TAIL, s1: sRoot, kind: 'lead', st });
        const bEnd = cutAt('B', sv.B[st] + X2 + TAIL);
        const e = link(bEnd, tanAt('B', st, X2 + TAIL, 1), j, tanAt('A', st, X2 + TAIL + 85, 1), { kind: 'conn', zone: st, lin: sJ });
        j.pend.minus = e;
        G.turn[st].A = [
          { stop: P(st, 'A'), st, alight: 'all' },
          { choose: [[{ stop: 'S:' + st + ':A', reverse: true }], [{ stop: 'S:' + st + ':B', reverse: true }]] },
          { stop: P(st, 'B'), st, board: true, term: true, setDir: 'B' }
        ];
      }
    }

    for (const sd of G.sidings) G.sidingById[sd.id] = sd;

    // Станционные пути и концы линий
    for (const k of ['A', 'B']) {
      for (let i = 0; i < NS; i++) {
        cutAt(k, sv[k][i] - PLAT_HALF); cutAt(k, sv[k][i] + PLAT_HALF);
        ranges[k].push({ s0: sv[k][i] - PLAT_HALF, s1: sv[k][i] + PLAT_HALF, kind: 'platform', st: i });
        pendStops.push({ id: P(i, k), k, s: sv[k][i], st: i, name: 'ст. ' + stName(i) });
      }
    }

    // Главные пути: рёбра между соседними разрезами, длинные перегоны делятся на блок-участки
    function gradeAt(k, s) {
      const a = sv[k];
      if (s <= a[0] || s >= a[NS - 1]) return 0;
      let i = 0; while (i < NS - 2 && s > a[i + 1]) i++;
      const D = a[i + 1] - a[i], u = (s - a[i]) / D;
      const z0 = -LINE.stations[i].depth, z1 = -LINE.stations[i + 1].depth;
      const deep = LINE.stations[i].depth > 40 && LINE.stations[i + 1].depth > 40;
      const dip = deep ? LINE.dip : (LINE.stations[i].depth > 15 && LINE.stations[i + 1].depth > 15 ? 4 : 0);
      const g = ((z1 - z0) * 6 * u * (1 - u) - dip * Math.PI * Math.sin(2 * Math.PI * u)) / D;
      return M.clamp(g, -0.05, 0.05);
    }
    for (const k of ['A', 'B']) {
      const arr = cuts[k].sort((x, y) => x.s - y.s), full = [];
      for (let i = 0; i < arr.length; i++) {
        full.push(arr[i]);
        if (i + 1 < arr.length) {
          const L = arr[i + 1].s - arr[i].s;
          if (L > 300) {
            const n = Math.ceil(L / BLOCK);
            for (let j = 1; j < n; j++) { const s = arr[i].s + L * j / n, q = T[k].at(s); full.push({ s, node: mkNode(q.x, q.y), pend: null }); }
          }
        }
      }
      for (let i = 0; i + 1 < full.length; i++) {
        const s0 = full[i].s, s1 = full[i + 1].s, mid = (s0 + s1) / 2;
        const r = ranges[k].find(x => mid > x.s0 && mid < x.s1);
        const kind = r ? r.kind : 'main';
        const e = mkEdge(full[i].node, full[i + 1].node, T[k].slice(s0, s1), {
          kind, track: k, sLo: s0, sHi: s1, st: r && kind === 'platform' ? r.st : null, zone: r ? r.st : null,
          nd: kind === 'tail' || kind === 'lead' ? 0 : (k === 'A' ? 1 : -1)
        });
        if (kind === 'main' || kind === 'platform' || kind === 'rev') {
          const n = Math.max(1, Math.ceil(e.len / 20)), gr = new Float32Array(n);
          for (let j = 0; j < n; j++) gr[j] = gradeAt(k, s0 + (j + 0.5) * e.len / n);
          e.gr = gr;
        }
        G.main[k].push(e);
        full[i].hiEdge = e; full[i + 1].loEdge = e;
      }
      for (const c of full) {
        if (!c.pend) continue;
        const stem = c.pend.dir > 0 ? c.loEdge : c.hiEdge, plus = c.pend.dir > 0 ? c.hiEdge : c.loEdge;
        mkSwitch(c.node, stem, plus, c.pend.minus, { zone: c.pend.zone, depot: !!c.pend.depot });
      }
      G['len' + k] = T[k].len;
    }
    for (const ps of pendStops) {
      const e = G.main[ps.k].find(x => ps.s >= x.sLo && ps.s <= x.sHi);
      addStop(ps.id, e, ps.s - e.sLo, { st: ps.st, name: ps.name, track: ps.k });
    }

    // Приведённая «линейная» координата (для ленты-схемы): пикетаж пути A
    function linB(s) {
      const a = sv.B, b = sv.A;
      if (s <= a[0]) return b[0] + (s - a[0]);
      if (s >= a[NS - 1]) return b[NS - 1] + (s - a[NS - 1]);
      let i = 0; while (i < NS - 2 && s > a[i + 1]) i++;
      return b[i] + (s - a[i]) * (b[i + 1] - b[i]) / (a[i + 1] - a[i]);
    }
    for (const e of G.main.A) { e.lin = e.sLo; e.linK = 1; }
    for (const e of G.main.B) { e.lin = linB(e.sLo); e.linK = (linB(e.sHi) - e.lin) / e.len; }

    // ---------- 3. Депо ----------
    if (fHi) {
      const rootCut = cuts.A[cuts.A.length - 1], rootNode = rootCut.node, o = T.A.at(sRoot);
      const u = [o.tx, o.ty], nrm = [-o.ty, o.tx];
      const depth = Math.ceil(Math.log2(NDEP)), STEP = 52, xT = depth * STEP + 30, DL = 172;
      const L = (x, y) => [o.x + u[0] * x + nrm[0] * y, o.y + u[1] * x + nrm[1] * y];
      const tracks = [];
      for (let j = 0; j < NDEP; j++) tracks.push({ j, off: (j - (NDEP - 1) / 2) * 5.2 });
      const leaf = function (node, t) {
        const p0 = L(xT, t.off), p1 = L(xT + DL, t.off);
        const pts = M.hermite([node.x, node.y], u, p0, u).concat([p1]);
        const E = mkNode(p1[0], p1[1]);
        const e = mkEdge(node, E, pts, { kind: 'depot', zone: fHi.st, lin: sRoot + xT, name: 'путь ' + (t.j + 1) });
        addStop('D:' + (t.j + 1), e, e.len - DL / 2, { st: fHi.st, name: 'депо, путь ' + (t.j + 1) });
        G.depot.push('D:' + (t.j + 1));
        return e;
      };
      const tree = function (node, x0, list, inEdge, level) {
        const half = list.length >> 1, parts = [list.slice(0, half), list.slice(half)], es = [];
        for (const part of parts) {
          if (part.length === 1) { es.push(leaf(node, part[0])); continue; }
          const mean = part.reduce((a, t) => a + t.off, 0) / part.length;
          const c = L(x0 + STEP, mean * (level + 1) / (depth + 0.6));
          const child = mkNode(c[0], c[1]);
          const e = link(node, u, child, u, { kind: 'throat', zone: fHi.st, lin: sRoot + x0 });
          es.push(e);
          tree(child, x0 + STEP, part, e, level + 1);
        }
        mkSwitch(node, inEdge, es[0], es[1], { zone: fHi.st, depot: true });
      };
      tree(rootNode, 0, tracks, rootCut.loEdge, 0);
      const w = NDEP * 5.2 / 2 + 6;
      G.depotBox = [L(xT - 12, -w), L(xT + DL + 8, -w), L(xT + DL + 8, w), L(xT - 12, w)];
      G.depotLabel = L(xT + DL / 2, -w - 14);
      G.depotLin = sRoot + xT + DL / 2;
    }

    // ---------- 4. Станции (для отрисовки) ----------
    LINE.stations.forEach((s, i) => {
      const side = s.plat === 'side', HALF = 62, plats = [];
      const mk = function (k) {
        const near = [], far = [];
        for (let o = -HALF; o <= HALF + 0.01; o += 4) {
          const a = T.A.at(sv.A[i] + o), b = T.B.at(sv.B[i] + o);
          let wx = b.x - a.x, wy = b.y - a.y; const l = Math.hypot(wx, wy) || 1; wx /= l; wy /= l;
          const p = k === 'A' ? a : b, sg = k === 'A' ? 1 : -1;
          if (side) {
            near.push([p.x - wx * sg * 1.75, p.y - wy * sg * 1.75]);
            far.push([p.x - wx * sg * 8.5, p.y - wy * sg * 8.5]);
          } else {
            near.push([p.x + wx * sg * 1.75, p.y + wy * sg * 1.75]);
            far.push([(a.x + b.x) / 2, (a.y + b.y) / 2]);
          }
        }
        return { k, near, far };
      };
      plats.push(mk('A'), mk('B'));
      const a = T.A.at(sv.A[i]), b = T.B.at(sv.B[i]);
      G.st.push({
        i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, tx: a.tx, ty: a.ty, plats, side,
        sep: Math.hypot(a.x - b.x, a.y - b.y), lin: sv.A[i]
      });
    });

    // ---------- 5. Светофоры (у выходов со станций и перед стрелочными зонами) ----------
    for (const e of G.edges) {
      if (!e.safeStop || e.kind === 'depot') continue;
      for (const d of [1, -1]) {
        const n = d > 0 ? e.b : e.a;
        if (n.edges.length < 2) continue;
        const plainNext = !n.sw && n.edges.find(x => x !== e);
        const need = n.sw || (plainNext && !plainNext.safeStop) || (e.kind === 'platform' && d === e.nd);
        if (!need) continue;
        if (e.nd && d !== e.nd && !n.sw && !(plainNext && !plainNext.safeStop)) continue;
        const q = e.poly.at(d > 0 ? e.len - 4 : 4), sx = q.tx * d, sy = q.ty * d;
        G.signals.push({ x: q.x - sy * 2.7, y: q.y + sx * 2.7, e, d });
      }
    }
    for (const z of G.zones) {
      z.sw.sort((p, q) => p.node.x - q.node.x);
      z.sw.forEach((sw, j) => { sw.name = String(j + 1); });
    }
    let dn = 1;
    for (const sw of G.sw) if (sw.depot) sw.name = 'Д' + (dn++);
    G.sv = sv;
    G.lineLen = sv.A[NS - 1] - sv.A[0];
    G.linMin = Math.min(...G.edges.map(e => e.lin || 1e9).filter(x => x > 0)) - 0;
    return G;
  };

  /** Точка на ребре: смещение от узла a. */
  M.edgePoint = (e, off) => e.poly.at(off);
})(typeof window !== 'undefined' ? window : globalThis);
