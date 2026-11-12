/* Модель движения: поезда, маршруты, замыкание участков (АЛС-АРС), стрелки, пассажиры, приказы. */
(function (root) {
  'use strict';
  const M = root.M;
  const KMH = 1 / 3.6;
  const CAR_LEN = 19.6, NCARS = 6, TRAIN_L = CAR_LEN * NCARS, CAR_CAP = 250, TRAIN_CAP = CAR_CAP * NCARS;
  const ACC = 1.0, BRK = 0.72, EBRK = 1.3, DOOR_T = 3, REV_T = 45, SW_T = 3;
  M.TRAIN = { CAR_LEN, NCARS, TRAIN_L, CAR_CAP, TRAIN_CAP };

  const exitNode = s => (s.d > 0 ? s.e.b : s.e.a);
  const segFrom = (e, n) => ({ e, d: e.a === n ? 1 : -1 });
  const trapz = (h, a, b, c, d) => (h <= a || h >= d ? 0 : h < b ? (h - a) / (b - a) : h <= c ? 1 : (d - h) / (d - c));

  class Sim {
    constructor(G, opts) {
      this.G = G; this.LINE = M.LINE; this.NS = G.NS;
      this.opts = Object.assign({ startTime: 7 * 3600, incidents: 2, autoSwitch: true, regulate: true, assistant: false, seed: 20240607 }, opts);
      this.t = this.opts.startTime; this.t0 = this.t;
      this.rand = M.mulberry(this.opts.seed);
      this.trains = []; this.outbox = []; this.incidents = []; this.incSeq = 1;
      this.stats = { delivered: 0, boarded: 0, leftBehind: 0, turnedAway: 0, crashes: 0, evacuated: 0, waiting: 0, onBoard: 0, avgWait: 0, boardRate: 0, reprimands: 0 };
      this.wait = []; this.stn = [];
      for (let i = 0; i < this.NS; i++) {
        this.wait.push(new Float32Array(this.NS));
        this.stn.push({ closed: false, lastDep: { A: -1e9, B: -1e9 }, hw: { A: 0, B: 0 }, crowdT: -1e9, item: null });
      }
      for (const z of G.zones) z.auto = !!this.opts.autoSwitch;
      for (const e of G.edges) { e.occ = []; e.res = null; e.blocked = 0; e.sigFault = false; e.tsr = 0; }
      for (const n of G.nodes) n.res = null;
      for (const sw of G.sw) { sw.pos = 'plus'; sw.target = 'plus'; sw.moving = 0; sw.broken = false; }
      this.paxAcc = 0; this.statAcc = 0; this.asstAcc = 0; this.unsafeT = -1e9; this.lastRelease = {}; this.rr = {};
      let run = 0;
      for (const e of G.main.A) if (e.sLo >= G.sv.A[0] && e.sHi <= G.sv.A[this.NS - 1]) run += e.len / e.vmax;
      this.cycleEst = 2 * (run + (this.NS - 1) * 52) + 420; this.cycleMeas = 0;
      this.buildOD();
      this.initFleet();
      this.arrivals(150, true);
    }

    emit(type, data) { this.outbox.push(Object.assign({ type, t: this.t }, data)); }
    radio(tr, clips, extra) { this.emit('radio', { from: 'train', num: tr.num, voice: tr.voice, clips, extra: extra || '' }); }
    stRadio(st, clips, extra) { this.emit('radio', { from: 'station', st, clips, extra: extra || '' }); }

    // ---------------------------------------------------------------- парк и расстановка
    mkTrain(num) {
      return {
        id: num, num, L: TRAIN_L, v: 0, route: [], cum: [], pos: 0, hi: 0, ti: 0, resEnd: 0,
        mode: 'parked', phase: 'idle', plan: [], proc: null, stopIdx: -1, stopPos: 0,
        dirA: true, at: 0, atStop: false, curStop: null, termLo: 0, termHi: this.NS - 1, order: null,
        hold: false, holdAt: null, halted: false, limit: 0, skip: new Set(), discharge: false, noBoard: false,
        sight: false, sightCap: 20 * KMH, divertStop: false, noRoute: false, retryT: 0,
        load: new Float32Array(this.NS), loadTot: 0, car: new Float32Array(NCARS),
        fault: null, faultT: 0, status: 'ok', statusT: 0, km: 0, nextTO: 350 + this.rand() * 500,
        waitT: 0, reported: false, blockReason: null, needSw: null, blockingT: -1e9, noPower: false,
        dw: null, timer: 0, revThen: null, voice: num % 3, parkedAt: null, pendingInc: null, dwExtra: 0, grade: 0, crashT: 0
      };
    }

    initFleet() {
      const G = this.G, N = this.LINE.fleet, NS = this.NS;
      for (let n = 1; n <= N; n++) this.trains.push(this.mkTrain(n));
      const want = Math.min(N - 3, Math.round(M.curveAt(M.TRAINS_CURVE, this.t / 3600)));
      const cand = [];
      const okA = e => e.safeStop && (e.kind === 'main' || e.kind === 'platform') && e.sLo > G.sv.A[0] - 80 && e.sHi < G.sv.A[NS - 1] + 80;
      const okB = e => e.safeStop && (e.kind === 'main' || e.kind === 'platform') && e.sLo > G.sv.B[0] - 80 && e.sHi < G.sv.B[NS - 1] + 80;
      G.main.A.forEach((e, j) => { if (okA(e)) cand.push({ k: 'A', j }); });
      for (let j = G.main.B.length - 1; j >= 0; j--) if (okB(G.main.B[j])) cand.push({ k: 'B', j });
      let ti = 0;
      for (let i = 0; i < want; i++) {
        const c = cand[Math.floor((i + 0.5) * cand.length / want)], tr = this.trains[ti++], arr = G.main[c.k], segs = [];
        if (c.k === 'A') { for (let j = Math.max(0, c.j - 3); j <= c.j; j++) segs.push({ e: arr[j], d: 1 }); } else { for (let j = Math.min(arr.length - 1, c.j + 3); j >= c.j; j--) segs.push({ e: arr[j], d: -1 }); }
        let tot = 0; for (const s of segs) tot += s.e.len;
        this.setRoute(tr, segs, tot - 15);
        const head = c.k === 'A' ? arr[c.j].sHi - 15 : arr[c.j].sLo + 15, sv = G.sv[c.k];
        tr.dirA = c.k === 'A';
        if (tr.dirA) { let a = 0; for (let s = 0; s < NS; s++) if (sv[s] <= head - TRAIN_L / 2 + 5) a = s; tr.at = a; } else { let a = NS - 1; for (let s = NS - 1; s >= 0; s--) if (sv[s] >= head + TRAIN_L / 2 - 5) a = s; tr.at = a; }
        tr.mode = 'service'; tr.phase = 'move';
        this.genNext(tr); this.startStep(tr);
      }
      // остальные — в депо и тупиках
      const places = [];
      const rest = N - want, sid = G.sidings.map(s => s.id);
      const nSid = rest > G.depot.length ? rest - G.depot.length : Math.min(2, sid.length, Math.max(0, rest - 6));
      for (let i = 0; i < nSid && i < sid.length; i++) places.push(sid[i]);
      for (const d of G.depot) places.push(d);
      let pi = 0, depCount = 0;
      for (; ti < N && pi < places.length; ti++, pi++) {
        const tr = this.trains[ti];
        this.placeParked(tr, places[pi]);
        if (places[pi][0] === 'D') {
          depCount++;
          if (depCount === 2 || depCount === 5) { tr.status = 'maint'; tr.statusT = (40 + this.rand() * 80) * 60; }
          if (depCount === 3) { tr.status = 'repair'; tr.fault = 'traction'; tr.statusT = (90 + this.rand() * 120) * 60; }
        }
      }
    }

    placeParked(tr, stopId) {
      const stop = this.G.stops[stopId], e = stop.e;
      const d = e.b.edges.length === 1 ? 1 : (e.a.edges.length === 1 ? -1 : 1);
      this.setRoute(tr, [{ e, d }], (d > 0 ? stop.c : e.len - stop.c) + tr.L / 2);
      tr.mode = 'parked'; tr.phase = 'idle'; tr.parkedAt = stopId; tr.v = 0; tr.plan = []; tr.proc = null; tr.order = null;
      tr.at = stop.st; tr.atStop = false; tr.stopIdx = -1;
    }

    setRoute(tr, segs, pos) {
      tr.route = segs; tr.cum = []; let c = 0;
      for (const s of segs) { tr.cum.push(c); c += s.e.len; }
      tr.pos = pos; tr.hi = this.idxAt(tr, pos); tr.ti = this.idxAt(tr, pos - tr.L);
      for (let i = tr.ti; i <= tr.hi; i++) {
        const e = segs[i].e; if (e.occ.indexOf(tr) < 0) e.occ.push(tr); e.res = tr;
        if (i > tr.ti) exitNode(segs[i - 1]).res = tr;
      }
      tr.resEnd = tr.hi;
    }
    idxAt(tr, d) { let i = 0; while (i < tr.route.length - 1 && tr.cum[i + 1] <= d) i++; return i; }
    recum(tr, from) { for (let i = Math.max(1, from); i < tr.route.length; i++) tr.cum[i] = tr.cum[i - 1] + tr.route[i - 1].e.len; tr.cum.length = tr.route.length; }

    // ---------------------------------------------------------------- топология
    nextSegs(seg) {
      const n = exitNode(seg), sw = n.sw;
      if (sw) {
        const lined = sw.pos === 'plus' ? sw.plus : sw.minus;
        if (seg.e === sw.stem) return (sw.broken ? [lined] : [sw.plus, sw.minus]).map(f => segFrom(f, n));
        if (sw.broken && lined !== seg.e) return [];
        return [segFrom(sw.stem, n)];
      }
      const out = [];
      for (const f of n.edges) if (f !== seg.e) out.push(segFrom(f, n));
      return out;
    }
    railNext(seg) {
      const n = exitNode(seg), sw = n.sw;
      if (sw) {
        const lined = sw.pos === 'plus' ? sw.plus : sw.minus;
        if (seg.e === sw.stem) return segFrom(lined, n);
        const r = segFrom(sw.stem, n); r.mismatch = lined !== seg.e; return r;
      }
      const f = n.edges.find(x => x !== seg.e);
      return f ? segFrom(f, n) : null;
    }
    needPos(sw, prevE, nextE) { return prevE === sw.stem ? (nextE === sw.plus ? 'plus' : 'minus') : (prevE === sw.plus ? 'plus' : 'minus'); }

    /** Кратчайший путь от направленного ребра до целевого ребра (без смены направления). */
    findPath(from, target) {
      if (from.e === target) return [];
      const key = s => s.e.id * 2 + (s.d > 0 ? 1 : 0);
      const dist = new Map(), prev = new Map(), open = [{ s: from, c: 0 }];
      dist.set(key(from), 0);
      let best = null;
      while (open.length) {
        let bi = 0; for (let i = 1; i < open.length; i++) if (open[i].c < open[bi].c) bi = i;
        const cur = open.splice(bi, 1)[0];
        if (cur.c > (dist.get(key(cur.s)) || 0) + 1e-6) continue;
        if (cur.s.e === target) { best = cur; break; }
        if (cur.c > 45000) break;
        for (const nx of this.nextSegs(cur.s)) {
          const e = nx.e, wrong = e.nd && e.nd !== nx.d;
          const c = cur.c + e.len * (wrong ? 30 : 1) + (e.kind === 'conn' ? 40 : 0);
          const k = key(nx);
          if (!dist.has(k) || c < dist.get(k) - 1e-6) { dist.set(k, c); prev.set(k, cur.s); open.push({ s: nx, c }); }
        }
      }
      if (!best) return null;
      const path = []; let s = best.s;
      while (s !== from) { path.push(s); s = prev.get(key(s)); }
      return path.reverse();
    }

    // ---------------------------------------------------------------- план движения
    turnProc(st, dk) { const p = this.G.turn[st] && this.G.turn[st][dk]; return p ? JSON.parse(JSON.stringify(p)) : null; }
    skips(tr, n) {
      if (this.stn[n].closed) return true;
      if (tr.skip.has(n)) return true;
      if (tr.noBoard && tr.load[n] < 0.5) return true;
      return false;
    }
    genNext(tr) {
      const NS = this.NS, ord = tr.order;
      if (tr.proc && tr.proc.length) {
        // приказ «в депо / в тупик», полученный на платформе прибытия, заменяет остаток оборота
        if (ord && tr.atStop) {
          if (ord.type === 'depot' && tr.curStop === 'P:' + (NS - 1) + ':A') tr.proc = [{ depot: true, park: true }];
          else if (ord.type === 'siding' && this.G.sidingById[ord.id].access[0].stop === tr.curStop) tr.proc = [Object.assign({}, this.G.sidingById[ord.id].access[1])];
        }
        tr.plan.push(tr.proc.shift()); return;
      }
      tr.proc = null;
      const dk = tr.dirA ? 'A' : 'B', dir = tr.dirA ? 1 : -1, term = tr.dirA ? tr.termHi : tr.termLo;
      let n = tr.atStop ? tr.at : tr.at + dir;
      for (let guard = 0; guard < 16; guard++, n += dir) {
        n = M.clamp(n, 0, NS - 1);
        const here = n === tr.at && tr.atStop, end = n === (dir > 0 ? NS - 1 : 0);
        let proc = null;
        if (ord && ord.type === 'depot' && tr.dirA && end) proc = [{ stop: 'P:' + n + ':A', st: n, alight: 'all' }, { depot: true, park: true }];
        else if (ord && ord.type === 'siding' && ord.dk === dk && ord.st === n) proc = JSON.parse(JSON.stringify(this.G.sidingById[ord.id].access));
        else if ((dir > 0 ? n >= term : n <= term) || end) proc = this.turnProc(n, dk);
        if (proc && here && proc[0].stop !== tr.curStop) proc = null;
        // тупик занят отстаивающимся составом — оборот здесь невозможен, следуем дальше
        if (proc && !end && !(ord && ord.type === 'siding') && proc.some(s => s.stop && s.stop[0] === 'S' && this.G.stops[s.stop].e.occ.some(u => u !== tr && u.mode !== 'service'))) proc = null;
        if (proc) { tr.proc = proc; const f = tr.proc.shift(); f.first = true; tr.plan.push(f); return; }
        if (here || end) continue;
        if (this.skips(tr, n)) { tr.skip.delete(n); continue; }
        tr.plan.push({ stop: 'P:' + n + ':' + dk, st: n, alight: 'norm', board: true });
        return;
      }
      // запасной вариант — конечная
      const e = dir > 0 ? NS - 1 : 0;
      tr.proc = this.turnProc(e, dk); tr.plan.push(tr.proc.shift());
    }

    freeStop(id, tr) {
      const e = this.G.stops[id].e;
      if (e.occ.some(u => u !== tr) || (e.res && e.res !== tr)) return false;
      for (const u of this.trains) if (u !== tr && u.mode === 'service' && u.plan.some(p => p.stop === id)) return false;
      return true;
    }
    resolveStep(tr) {
      let step = tr.plan[0];
      if (step.choose) {
        const alts = step.choose, st = tr.at, k = (this.rr[st] = (this.rr[st] || 0) + 1);
        let pick = null;
        for (let i = 0; i < alts.length; i++) { const a = alts[(i + k) % alts.length]; if (this.freeStop(a[0].stop, tr)) { pick = a; break; } }
        if (!pick) pick = alts[k % alts.length];
        const steps = pick.map(s => Object.assign({}, s));
        steps[0].alts = alts;
        tr.plan.splice(0, 1, ...steps);
        step = tr.plan[0];
      }
      if (step.depot && !step.stop) {
        const free = this.G.depot.filter(id => this.freeStop(id, tr));
        if (!free.length) return null;
        step.stop = free[0];
      }
      return step;
    }
    startStep(tr) {
      if (!tr.plan.length) this.genNext(tr);
      const step = this.resolveStep(tr);
      tr.phase = 'move'; tr.waitT = 0; tr.reported = false;
      if (!step) { tr.noRoute = true; tr.retryT = 20; tr.stopIdx = -1; if (!tr.depotFullSaid) { tr.depotFullSaid = true; this.radio(tr, ['d.depot_full']); } return; }
      tr.depotFullSaid = false;
      if (step.stop !== tr.curStop) tr.atStop = false;
      if (!this.planRoute(tr, step.stop)) { tr.noRoute = true; tr.retryT = 8; tr.stopIdx = -1; return; }
      tr.noRoute = false;
    }
    planRoute(tr, stopId) {
      const stop = this.G.stops[stopId], base = Math.max(tr.hi, tr.resEnd);
      let idx = -1;
      for (let i = tr.hi; i <= base; i++) if (tr.route[i].e === stop.e) { idx = i; break; }
      if (idx < 0) {
        const path = this.findPath(tr.route[base], stop.e);
        if (!path) return false;
        tr.route.length = base + 1;
        for (const s of path) tr.route.push(s);
        this.recum(tr, base);
        idx = tr.route.length - 1;
      } else { tr.route.length = base + 1; tr.cum.length = base + 1; }
      const seg = tr.route[idx], c = seg.d > 0 ? stop.c : seg.e.len - stop.c;
      const sp = tr.cum[idx] + c + tr.L / 2;
      if (sp < tr.pos - 1.5) return false;
      tr.stopIdx = idx; tr.stopPos = Math.max(sp, tr.pos);
      return true;
    }

    reverse(tr) {
      for (let i = tr.hi + 1; i <= tr.resEnd && i < tr.route.length; i++) this.release(tr, i);
      const occ = tr.route.slice(tr.ti, tr.hi + 1);
      const r = tr.cum[tr.hi] + tr.route[tr.hi].e.len - tr.pos;
      tr.route = occ.reverse().map(s => ({ e: s.e, d: -s.d }));
      tr.cum = [0]; this.recum(tr, 0);
      tr.pos = r + tr.L; tr.ti = 0; tr.hi = this.idxAt(tr, tr.pos); tr.resEnd = tr.hi; tr.v = 0; tr.stopIdx = -1;
      if (tr.hi < tr.route.length - 1) tr.hi = tr.route.length - 1;
    }
    release(tr, i) {
      const s = tr.route[i], e = s.e;
      if (e.res === tr && e.occ.indexOf(tr) < 0) e.res = null;
      if (i > 0) { const n = exitNode(tr.route[i - 1]); if (n.res === tr && i - 1 >= tr.hi) n.res = null; }
    }

    // ---------------------------------------------------------------- замыкание маршрутов
    isAuto(sw) { return sw.depot || (sw.zone != null && this.G.zones[sw.zone].auto); }
    margin(tr, i) {
      const s = tr.route[i], n = exitNode(s);
      if (n.edges.length === 1) return 6;
      if (n.sw && s.e !== n.sw.stem) return 32;
      return 10;
    }
    extendAuth(tr) {
      const rt = tr.route;
      tr.blockReason = null; tr.needSw = null;
      for (let guard = 0; guard < 8; guard++) {
        const lim = tr.stopIdx >= 0 ? tr.stopIdx : rt.length - 1;
        if (tr.resEnd >= lim || tr.resEnd + 1 >= rt.length) return;
        const maEnd = tr.cum[tr.resEnd] + rt[tr.resEnd].e.len;
        if (maEnd - tr.pos > 440) return;
        const chunk = [];
        for (let j = tr.resEnd + 1; j < rt.length; j++) { chunk.push(j); if (rt[j].e.safeStop || j >= lim) break; }
        const toThrow = [];
        for (const j of chunk) {
          const e = rt[j].e, n = exitNode(rt[j - 1]);
          let who = null;
          if (e.res && e.res !== tr) who = e.res; else { for (const u of e.occ) if (u !== tr) { who = u; break; } }
          if (!who && n.res && n.res !== tr) who = n.res;
          if (!who && e.conf) for (const c of e.conf) { if (c.res && c.res !== tr) who = c.res; else for (const u of c.occ) if (u !== tr) who = u; }
          if (who) { tr.blockReason = 'occupied'; who.blockingT = this.t; return; }
          if (e.blocked) { tr.blockReason = 'power'; return; }
          if (e.sigFault) { tr.blockReason = 'signal'; return; }
          if (n.sw) {
            const sw = n.sw, need = this.needPos(sw, rt[j - 1].e, e);
            if (sw.moving ? sw.target !== need : sw.pos !== need) {
              if (sw.broken) { tr.blockReason = 'swbroken'; tr.needSw = sw; return; }
              if (sw.moving || !this.isAuto(sw)) { tr.blockReason = 'switch'; tr.needSw = sw; return; }
              toThrow.push([sw, need]);
            }
          }
        }
        for (const [sw, need] of toThrow) { sw.target = need; sw.moving = SW_T; }
        for (const j of chunk) { rt[j].e.res = tr; exitNode(rt[j - 1]).res = tr; }
        tr.resEnd = chunk[chunk.length - 1];
      }
    }
    authDist(tr) {
      const rt = tr.route;
      let end = tr.cum[tr.resEnd] + rt[tr.resEnd].e.len - this.margin(tr, tr.resEnd);
      for (let i = tr.hi + 1; i <= tr.resEnd; i++) {
        const n = exitNode(rt[i - 1]), sw = n.sw;
        if ((sw && (sw.moving || sw.pos !== this.needPos(sw, rt[i - 1].e, rt[i].e))) || rt[i].e.blocked) {
          end = Math.min(end, tr.cum[i] - this.margin(tr, i - 1)); break;
        }
      }
      return end - tr.pos;
    }
    intervalOn(u, e) {
      let lo = Infinity, hi = -Infinity; const tail = u.pos - u.L;
      for (let i = u.ti; i <= u.hi; i++) {
        const s = u.route[i]; if (s.e !== e) continue;
        const a = Math.max(u.cum[i], tail) - u.cum[i], b = Math.min(u.cum[i] + e.len, u.pos) - u.cum[i];
        lo = Math.min(lo, s.d > 0 ? a : e.len - b); hi = Math.max(hi, s.d > 0 ? b : e.len - a);
      }
      return lo <= hi ? [lo, hi] : null;
    }
    sightDist(tr) {
      let best = Infinity;
      for (let i = tr.hi; i < tr.route.length; i++) {
        const s = tr.route[i], e = s.e, d0 = tr.cum[i] - tr.pos;
        if (d0 > 60) break;
        for (const u of e.occ) {
          if (u === tr) continue;
          const iv = this.intervalOn(u, e); if (!iv) continue;
          const near = s.d > 0 ? iv[0] : e.len - iv[1], far = s.d > 0 ? iv[1] : e.len - iv[0];
          if (d0 + far < 0) continue;
          best = Math.min(best, Math.max(0, d0 + near));
        }
        if (i === tr.route.length - 1 && exitNode(s).edges.length === 1) best = Math.min(best, d0 + e.len - 2);
      }
      return best > 45 ? Infinity : best;
    }

    // ---------------------------------------------------------------- движение
    gradeAt(tr) {
      const s = tr.route[tr.hi], e = s.e;
      if (!e.gr) return 0;
      const off = tr.pos - tr.cum[tr.hi], x = s.d > 0 ? off : e.len - off;
      return e.gr[M.clamp(Math.floor(x / e.len * e.gr.length), 0, e.gr.length - 1)] * s.d;
    }
    drive(tr, dt) {
      if (tr.noRoute) {
        tr.retryT -= dt;
        if (tr.retryT <= 0 && tr.v === 0) {
          this.startStep(tr);
          const step = tr.plan[0];
          if (tr.noRoute && step && step.stop) {
            // путь есть только в обратном направлении — машинист переходит в другую кабину
            const back = tr.route[tr.ti];
            if (this.findPath({ e: back.e, d: -back.d }, this.G.stops[step.stop].e)) { tr.phase = 'rev'; tr.timer = REV_T; tr.revThen = 'start'; return; }
            if (!tr.reported) { tr.reported = true; this.radio(tr, ['d.diverted']); this.emit('attention', { num: tr.num, reason: 'noroute' }); }
          }
        }
      }
      if (!tr.noRoute && !tr.divertStop) {
        this.extendAuth(tr);
        if (tr.sight && tr.resEnd > tr.hi && this.authDist(tr) > 25) { tr.sight = false; }
      }
      const rt = tr.route, headE = rt[tr.hi].e;
      const dT = tr.stopIdx >= 0 && !tr.noRoute ? tr.stopPos - tr.pos : Infinity;
      let d = tr.sight ? Math.min(dT, this.sightDist(tr) - 6) : Math.min(dT, this.authDist(tr));
      let emergency = false;
      tr.noPower = headE.blocked > 0;
      if (tr.halted) { d = 0; emergency = true; }
      if (tr.noPower || tr.fault === 'dead' || tr.noRoute || tr.divertStop) d = Math.min(d, 0);
      if (!tr.sight && d < -8 && tr.v > 1) emergency = true;

      let vlim = Infinity;
      for (let i = tr.ti; i <= tr.hi; i++) { const e = rt[i].e; vlim = Math.min(vlim, e.tsr ? Math.min(e.tsr, e.vmax) : e.vmax); }
      if (tr.limit) vlim = Math.min(vlim, tr.limit);
      if (tr.fault === 'traction') vlim = Math.min(vlim, 35 * KMH);
      if (tr.sight) vlim = Math.min(vlim, tr.sightCap);
      let la = tr.cum[tr.hi] + headE.len - tr.pos;
      for (let i = tr.hi + 1; i < rt.length && la < 420; i++) {
        const e = rt[i].e, ve = e.tsr ? Math.min(e.tsr, e.vmax) : e.vmax;
        if (ve < vlim) vlim = Math.min(vlim, Math.sqrt(ve * ve + 2 * 0.6 * la));
        la += e.len;
      }
      const g = this.gradeAt(tr); tr.grade = g;
      const bEff = Math.max(0.45, BRK - Math.max(0, -g) * 9.81);
      const vNext = Math.min(vlim, d > 0.3 ? Math.sqrt(2 * bEff * (d - 0.3)) : 0);
      const grav = g * 9.81 + 0.015;
      let aDes = M.clamp((vNext - tr.v) / Math.max(dt, 0.05), -(emergency ? EBRK : 1.0), ACC);
      const tmax = (tr.noPower || tr.fault === 'dead') ? 0 : (tr.v < 9 ? ACC : ACC * 9 / tr.v) / (1 + 0.25 * tr.loadTot / TRAIN_CAP);
      const eff = M.clamp(aDes + grav, -(emergency ? EBRK : 1.1), tmax);
      let aNet = eff - grav;
      if (tr.v <= 0 && vNext <= 0.02) aNet = 0;
      let v2 = Math.max(0, tr.v + aNet * dt), ds = (tr.v + v2) / 2 * dt;
      if (d === dT && dT < 0.7 && v2 < 0.6) { ds = Math.max(0, dT); v2 = 0; }
      tr.v = v2;
      if (ds > 0) this.advance(tr, ds);
      if (tr.mode !== 'service') return;

      if (tr.v === 0) {
        if (tr.divertStop) { tr.divertStop = false; tr.plan[0] && (tr.plan[0].alts = null); this.startStep(tr); return; }
        if (tr.stopIdx >= 0 && !tr.noRoute && Math.abs(tr.stopPos - tr.pos) < 0.8) { this.arrive(tr); return; }
        if (!tr.halted) {
          tr.waitT += dt;
          const step = tr.plan[0];
          if (step && step.alts && tr.blockReason && tr.waitT > 8 && tr.resEnd === tr.hi && Math.floor(tr.waitT / 5) !== Math.floor((tr.waitT - dt) / 5)) {
            const cur = step.stop, other = step.alts.find(a => a[0].stop !== cur && this.freeStop(a[0].stop, tr));
            if (other) { const ns = other.map(s => Object.assign({}, s)); ns[0].alts = step.alts; tr.plan.splice(0, 1, ...ns); this.startStep(tr); return; }
          }
          if (!tr.reported && tr.blockReason) {
            const r = tr.blockReason;
            const say = r === 'switch' && tr.waitT > 25 ? 'd.wait_route' : (r === 'signal' || r === 'swbroken') && tr.waitT > 25 ? 'd.wait_signal'
              : r === 'power' && tr.waitT > 8 ? 'd.no_power' : r === 'occupied' && tr.waitT > 420 ? 'd.wait_long' : null;
            if (say) { tr.reported = true; this.radio(tr, [say]); this.emit('attention', { num: tr.num, reason: r }); }
          }
        }
      } else if (tr.v > 1) { tr.waitT = 0; tr.reported = false; }
    }

    advance(tr, ds) {
      tr.pos += ds; tr.km += ds / 1000;
      const rt = tr.route;
      while (tr.pos > tr.cum[tr.hi] + rt[tr.hi].e.len) {
        const cur = rt[tr.hi], n = exitNode(cur), sw = n.sw;
        let nxt = rt[tr.hi + 1], actual = null;
        if (n.edges.length === 1) {              // упор
          tr.pos = tr.cum[tr.hi] + cur.e.len;
          if (tr.v > 1.5) this.crash([tr], 'buffer'); tr.v = 0; break;
        }
        if (sw) {
          if (sw.moving) { this.crash([tr], 'derail'); return; }
          if (cur.e === sw.stem) actual = sw.pos === 'plus' ? sw.plus : sw.minus;
          else {
            actual = sw.stem;
            const lined = sw.pos === 'plus' ? sw.plus : sw.minus;
            if (lined !== cur.e) {                 // взрез стрелки
              sw.pos = sw.target = cur.e === sw.plus ? 'plus' : 'minus'; sw.broken = true;
              if (M.incidents) M.incidents.runthrough(this, sw, tr);
            }
          }
        } else actual = n.edges.find(x => x !== cur.e);
        if (!nxt || nxt.e !== actual) {            // поехал не по маршруту
          for (let i = tr.hi + 1; i <= tr.resEnd && i < rt.length; i++) this.release(tr, i);
          rt.length = tr.hi + 1; rt.push(segFrom(actual, n)); this.recum(tr, tr.hi);
          tr.resEnd = Math.min(tr.resEnd, tr.hi); tr.stopIdx = -1; tr.divertStop = true; this.unsafeT = this.t + 600;
        }
        tr.hi++;
        const e = rt[tr.hi].e;
        if (e.occ.indexOf(tr) < 0) e.occ.push(tr);
        if (tr.hi > tr.resEnd) { tr.resEnd = tr.hi; if (!e.res) e.res = tr; if (!n.res) n.res = tr; this.unsafeT = this.t + 600; }
      }
      const tail = tr.pos - tr.L;
      while (tr.ti < tr.hi && tail > tr.cum[tr.ti] + rt[tr.ti].e.len) {
        const s = rt[tr.ti], e = s.e, k = e.occ.indexOf(tr);
        if (k >= 0) e.occ.splice(k, 1);
        if (e.res === tr) e.res = null;
        const n = exitNode(s); if (n.res === tr) n.res = null;
        tr.ti++;
      }
      if (tr.ti > 14) {
        const k = tr.ti - 2, base = tr.cum[k];
        rt.splice(0, k); tr.cum.splice(0, k);
        for (let i = 0; i < tr.cum.length; i++) tr.cum[i] -= base;
        tr.pos -= base; tr.stopPos -= base; tr.hi -= k; tr.ti -= k; tr.resEnd -= k; if (tr.stopIdx >= 0) tr.stopIdx -= k;
      }
    }

    // ---------------------------------------------------------------- остановки
    arrive(tr) {
      const step = tr.plan[0];
      tr.curStop = step.stop; tr.waitT = 0; tr.blockReason = null;
      if (step.st != null) tr.at = step.st;
      if (step.setDir) { tr.dirA = step.setDir === 'A'; tr.noBoard = false; }
      tr.atStop = step.stop[0] === 'P';
      if (step.alight || step.board) this.startDwell(tr, step); else this.finishStop(tr);
    }
    startDwell(tr, step) {
      const st = step.st, NS = this.NS;
      const all = step.alight === 'all' || tr.discharge;
      if (tr.discharge) { tr.discharge = false; tr.noBoard = true; }
      const out = new Float32Array(NS); let tot = 0;
      for (let d = 0; d < NS; d++) {
        if (tr.load[d] <= 0) continue;
        if (all || (tr.dirA ? d <= st : d >= st)) { out[d] = tr.load[d]; tot += out[d]; }
      }
      tr.dw = { t: 0, out, outLeft: tot, min: step.min || (step.reverse ? 50 : all ? 26 : 22), max: 55, closing: 0, extra: 0, full: 0 };
      if (tr.pendingInc) { tr.dw.extra = tr.pendingInc.extra; this.radio(tr, [tr.pendingInc.clip]); if (tr.pendingInc.inc) tr.pendingInc.inc.until = this.t + tr.pendingInc.extra + 20; tr.pendingInc = null; }
      if (tr.holdAt === st || tr.holdAt === -1) { tr.hold = true; tr.holdAt = null; }
      tr.phase = 'dwell';
    }
    boardRange(tr, st) {
      const ord = tr.order;
      if (tr.dirA) {
        let hi = tr.termHi;
        if (ord && ord.type === 'depot') hi = this.NS - 1; else if (ord && ord.type === 'siding' && ord.dk === 'A' && ord.st > st) hi = ord.st;
        if (hi <= st) hi = this.NS - 1;
        return [st + 1, hi];
      }
      let lo = tr.termLo;
      if (ord && ord.type === 'siding' && ord.dk === 'B' && ord.st < st) lo = ord.st;
      if (lo >= st) lo = 0;
      return [lo, st - 1];
    }
    dwell(tr, dt) {
      const dw = tr.dw, step = tr.plan[0], st = step.st, S = this.stn[st];
      dw.t += dt;
      if (dw.t < DOOR_T) return;
      if (dw.closing > 0) { dw.closing -= dt; if (dw.closing <= 0) this.finishStop(tr); return; }
      if (dw.outLeft > 0.01) {
        const n = Math.min(dw.outLeft, 60 * dt), f = n / dw.outLeft;
        let cs = 0; for (let i = 0; i < NCARS; i++) cs += tr.car[i];
        for (let d = 0; d < this.NS; d++) {
          if (dw.out[d] <= 0) continue;
          const x = dw.out[d] * f; dw.out[d] -= x; tr.load[d] = Math.max(0, tr.load[d] - x);
          if (d === st) this.stats.delivered += x; else this.wait[st][d] += x;
        }
        if (cs > 0) for (let i = 0; i < NCARS; i++) tr.car[i] = Math.max(0, tr.car[i] - n * tr.car[i] / cs);
        dw.outLeft -= n;
      }
      let more = 0;
      if (step.board && !tr.noBoard && !S.closed && dw.outLeft < 30) {
        const [lo, hi] = this.boardRange(tr, st);
        let W = 0; for (let d = lo; d <= hi; d++) W += this.wait[st][d];
        const free = TRAIN_CAP - tr.loadTot, n = Math.max(0, Math.min(W, free, 45 * dt));
        if (n > 0.001) {
          const f = n / W;
          for (let d = lo; d <= hi; d++) { const x = this.wait[st][d] * f; this.wait[st][d] -= x; tr.load[d] += x; }
          this.stats.boarded += n; this.boardAcc = (this.boardAcc || 0) + n;
          let ws = 0; const w = [];
          for (let i = 0; i < NCARS; i++) { w[i] = Math.max(0.01, CAR_CAP - tr.car[i]) * (i === 0 || i === NCARS - 1 ? 0.85 : 1.08); ws += w[i]; }
          for (let i = 0; i < NCARS; i++) tr.car[i] += n * w[i] / ws;
        }
        more = W - n;
        dw.full = free - n < 1 && more > 3 ? more : 0;
      }
      let tot = 0; for (let d = 0; d < this.NS; d++) tot += tr.load[d];
      tr.loadTot = tot;
      const tmin = dw.min + dw.extra;
      if (!(dw.t >= tmin && dw.outLeft <= 0.01 && (more < 1 || dw.t >= dw.max + dw.extra || dw.full))) return;
      if (tr.hold || tr.halted) return;
      if (step.term && this.opts.regulate && !tr.order) {
        const due = S.lastDep[step.setDir] + this.headwayTarget(tr);
        if (this.t < due && this.t - tr.blockingT > 4 && dw.t < 720) { tr.regHold = (tr.regHold || 0) + dt; return; }
      }
      if (dw.full) {
        this.stats.leftBehind += dw.full;
        if (this.t - (this.fullSaidT || -1e9) > 600) { this.fullSaidT = this.t; this.radio(tr, ['d.full']); }
      }
      dw.closing = DOOR_T;
    }
    headwayTarget(tr) {
      let n = 0; for (const u of this.trains) if (u.mode === 'service' && !u.order) n++;
      const span = (tr.termHi - tr.termLo) / (this.NS - 1);
      return M.clamp((this.cycleMeas || this.cycleEst) * 1.04 * span / Math.max(1, n), 95, 540);
    }
    finishStop(tr) {
      const step = tr.plan[0];
      tr.dw = null;
      if (step.park) { this.park(tr, step.stop); return; }
      if (step.reverse) {
        if (step.board || step.alight) { this.reverse(tr); this.afterStep(tr); return; }
        tr.phase = 'rev'; tr.timer = REV_T; tr.revThen = 'after'; return;
      }
      this.afterStep(tr);
    }
    afterStep(tr) {
      const step = tr.plan.shift();
      if (step && step.st != null && step.stop[0] === 'P' && step.board) {
        const S = this.stn[step.st], k = step.stop.slice(-1);
        if (S.lastDep[k] > -1e8) S.hw[k] = this.t - S.lastDep[k];
        S.lastDep[k] = this.t;
        if (step.term && tr.termLo === 0 && tr.termHi === this.NS - 1) {
          // фактическое время оборота (без выдержки интервала) — для регулирования
          tr.lapT = tr.lapT || {};
          if (tr.lapT[step.st] != null) {
            const lap = this.t - tr.lapT[step.st] - (tr.regHold || 0);
            if (lap > 1800 && lap < 9000) this.cycleMeas = this.cycleMeas ? this.cycleMeas * 0.85 + lap * 0.15 : lap;
          }
          tr.regHold = 0; tr.lapT[step.st] = this.t;
        }
      }
      this.startStep(tr);
    }
    park(tr, stopId) {
      const dep = stopId[0] === 'D';
      tr.mode = 'parked'; tr.phase = 'idle'; tr.parkedAt = stopId; tr.v = 0; tr.plan = []; tr.proc = null; tr.order = null;
      tr.noBoard = false; tr.discharge = false; tr.hold = false; tr.halted = false; tr.limit = 0; tr.sight = false; tr.skip.clear(); tr.stopIdx = -1;
      tr.termLo = 0; tr.termHi = this.NS - 1;
      for (let i = tr.hi + 1; i <= tr.resEnd && i < tr.route.length; i++) this.release(tr, i);
      tr.resEnd = tr.hi;
      this.radio(tr, [dep ? 'd.in_depot' : 'd.in_siding']);
      if (dep) this.depotService(tr);
    }
    depotService(tr) {
      if (tr.fault) { tr.status = 'repair'; tr.statusT = (100 + this.rand() * 140) * 60; } else if (tr.km >= tr.nextTO) { tr.status = 'maint'; tr.statusT = (50 + this.rand() * 60) * 60; }
    }
    enterService(tr) {
      const id = tr.parkedAt, G = this.G, last = this.NS - 1;
      let steps;
      if (id[0] === 'D' || G.stops[id].st === last) steps = [{ stop: 'P:' + last + ':B', st: last, board: true, term: true, setDir: 'B' }];
      else {
        const sd = G.sidingById[id];
        steps = sd ? JSON.parse(JSON.stringify(sd.exit)) : [{ stop: 'P:' + G.stops[id].st + ':A', st: G.stops[id].st, board: true, term: true, setDir: 'A' }];
      }
      tr.mode = 'service'; tr.parkedAt = null; tr.plan = steps; tr.proc = null; tr.phase = 'rev'; tr.timer = 20; tr.revThen = 'start';
      tr.atStop = false; tr.curStop = null;
    }

    // ---------------------------------------------------------------- аварии
    overlap(a, b, e) { const x = this.intervalOn(a, e), y = this.intervalOn(b, e); return x && y && x[0] < y[1] - 0.2 && y[0] < x[1] - 0.2; }
    coversMid(u, e) { const iv = this.intervalOn(u, e); return iv && iv[0] < e.len / 2 + 3 && iv[1] > e.len / 2 - 3; }
    detect() {
      const unsafe = this.t < this.unsafeT;
      for (const tr of this.trains) {
        if (tr.mode === 'gone') continue;
        for (let i = tr.ti; i <= tr.hi; i++) {
          const e = tr.route[i].e;
          if (e.occ.length > 1) for (const u of e.occ) if (u.id > tr.id && !(u.mode === 'crashed' && tr.mode === 'crashed') && this.overlap(tr, u, e)) this.crash([tr, u], 'collision');
          if (e.conf) for (const c of e.conf) for (const u of c.occ) if (u.id > tr.id && !(u.mode === 'crashed' && tr.mode === 'crashed') && this.coversMid(tr, e) && this.coversMid(u, c)) this.crash([tr, u], 'collision');
          if (unsafe && i < tr.hi) {
            const n = exitNode(tr.route[i]);
            if (n.sw) for (const x of n.edges) {
              if (x === e || x === tr.route[i + 1].e) continue;
              for (const u of x.occ) {
                if (u === tr || (u.mode === 'crashed' && tr.mode === 'crashed')) continue;
                const iv = this.intervalOn(u, x); if (!iv) continue;
                if ((x.a === n ? iv[0] : x.len - iv[1]) < 9) this.crash([tr, u], 'collision');
              }
            }
          }
        }
      }
    }
    crash(list, kind) {
      const fresh = list.filter(t => t.mode !== 'crashed');
      if (!fresh.length) return;
      const speed = Math.max(...list.map(t => t.v));
      for (const tr of list) {
        if (tr.mode === 'crashed') continue;
        if (tr.mode === 'parked') tr.parkedAt = null;
        tr.mode = 'crashed'; tr.phase = 'idle'; tr.v = 0; tr.crashT = this.t; tr.fault = 'crash'; tr.plan = []; tr.proc = null; tr.dw = null;
        for (let i = tr.hi + 1; i <= tr.resEnd && i < tr.route.length; i++) this.release(tr, i);
        tr.resEnd = tr.hi;
      }
      this.stats.crashes++;
      const p = this.trainXY(list[0]);
      const title = kind === 'collision' ? 'Столкновение поездов' : kind === 'derail' ? 'Сход подвижного состава на стрелке' : 'Наезд на тупиковый упор';
      const wh = this.where(list[0]);
      const text = title + ': ' + list.map(t => 'маршрут ' + t.num).join(' и ') + ' (' + wh + ').';
      const inc = { id: this.incSeq++, type: 'crash', title, text, t0: this.t, until: this.t + 50 * 60, x: p.x, y: p.y, trains: list.slice(), done: false };
      this.incidents.push(inc);
      this.emit('crash', { kind, nums: list.map(t => t.num), text, x: p.x, y: p.y, speed: speed * 3.6 });
    }
    removeWreck(tr) {
      for (let i = tr.ti; i <= tr.hi; i++) {
        const e = tr.route[i].e, k = e.occ.indexOf(tr);
        if (k >= 0) e.occ.splice(k, 1);
        if (e.res === tr) e.res = null;
        const n = exitNode(tr.route[i]); if (n.res === tr) n.res = null;
        if (i > 0) { const m = exitNode(tr.route[i - 1]); if (m.res === tr) m.res = null; }
      }
      this.stats.evacuated += tr.loadTot;
      tr.load.fill(0); tr.car.fill(0); tr.loadTot = 0;
      const free = this.G.depot.filter(id => this.freeStop(id, tr));
      if (free.length) { this.placeParked(tr, free[free.length - 1]); tr.status = 'repair'; tr.statusT = 8 * 3600; tr.fault = 'crash'; } else { tr.mode = 'gone'; tr.route = []; }
    }
    throwSwitch(sw, force) {
      if (sw.broken) return { ok: false, why: 'Стрелка неисправна' };
      if (sw.moving) return { ok: false, why: 'Стрелка переводится' };
      if (sw.depot) return { ok: false, why: 'Стрелками депо управляет дежурный по депо' };
      const n = sw.node;
      let spans = null;
      for (const tr of this.trains) { if (tr.mode === 'gone') continue; for (let i = tr.ti; i < tr.hi; i++) if (exitNode(tr.route[i]) === n) spans = tr; }
      const locked = n.res != null || spans;
      if (locked && !force) return { ok: false, locked: true, why: spans ? 'Стрелка занята подвижным составом' : 'Стрелка замкнута в маршруте поезда ' + n.res.num };
      sw.target = sw.pos === 'plus' ? 'minus' : 'plus'; sw.moving = SW_T;
      if (locked) { this.unsafeT = this.t + 900; if (spans) this.crash([spans], 'derail'); }
      return { ok: true, forced: !!locked };
    }

    // ---------------------------------------------------------------- пассажиры
    buildOD() {
      const NS = this.NS, S = this.LINE.stations, mk = f => {
        const m = []; let tot = 0;
        for (let i = 0; i < NS; i++) { m.push(new Float32Array(NS)); for (let j = 0; j < NS; j++) { if (i === j) continue; m[i][j] = f(S[i], S[j]) * (Math.abs(i - j) === 1 ? 0.55 : 1); tot += m[i][j]; } }
        for (let i = 0; i < NS; i++) for (let j = 0; j < NS; j++) m[i][j] /= tot;
        return m;
      };
      this.OD = { am: mk((a, b) => a.res * b.job), pm: mk((a, b) => a.job * b.res), base: mk((a, b) => (a.res + a.job) * (b.res + b.job)) };
    }
    arrivals(dt, force) {
      this.paxAcc += dt;
      if (this.paxAcc < 2 && !force) return;
      const step = this.paxAcc; this.paxAcc = 0;
      const hour = (this.t % 86400) / 3600, H = M.curveAt(M.DEMAND_CURVE, hour);
      if (H <= 0) return;
      const am = trapz(hour, 6, 7.5, 9.3, 10.8) * 0.7, pm = trapz(hour, 15.5, 17, 19.3, 20.8) * 0.65, base = 1 - am - pm;
      const n = H / 3600 * step * 1.25 * (0.85 + 0.3 * this.rand()), OD = this.OD;
      for (let i = 0; i < this.NS; i++) {
        const w = this.wait[i]; let cur = 0;
        for (let j = 0; j < this.NS; j++) cur += w[j];
        for (let j = 0; j < this.NS; j++) {
          const x = n * (am * OD.am[i][j] + pm * OD.pm[i][j] + base * OD.base[i][j]);
          if (this.stn[i].closed || cur > 3600) this.stats.turnedAway += x; else w[j] += x;
        }
      }
    }
    waitDir(st) { let a = 0, b = 0; const w = this.wait[st]; for (let j = 0; j < this.NS; j++) { if (j > st) a += w[j]; else b += w[j]; } return [a, b]; }

    // ---------------------------------------------------------------- приказы
    nextStation(tr) { const s = tr.plan[0]; if (s && s.st != null && tr.phase === 'move') return s.st; return M.clamp(tr.at + (tr.dirA ? 1 : -1), 0, this.NS - 1); }
    replan(tr) {
      if (tr.mode !== 'service' || tr.phase !== 'move') return;
      if (tr.noRoute && tr.plan[0] && tr.plan[0].depot && !tr.plan[0].stop) { tr.plan = []; tr.proc = null; tr.noRoute = false; tr.depotFullSaid = false; this.startStep(tr); return; }
      if (tr.plan.length !== 1) return;
      const cur = tr.plan[0];
      if (!cur.stop || cur.stop[0] !== 'P' || tr.noRoute || (tr.proc && !cur.first)) return;
      const oldProc = tr.proc, oldLen = tr.route.length;
      tr.plan = []; tr.proc = null;
      this.genNext(tr); this.startStep(tr);
      if (tr.noRoute) { tr.plan = [cur]; tr.proc = oldProc; tr.noRoute = !this.planRoute(tr, cur.stop); void oldLen; }
    }
    pickSiding(tr, st) {
      const dk = tr.dirA ? 'A' : 'B', taken = id => this.trains.some(u => u !== tr && u.order && u.order.id === id);
      let c = this.G.sidings.filter(s => (st == null || s.st === st) && this.freeStop(s.id, tr) && !taken(s.id));
      if (!c.length) return null;
      const score = s => {
        const ahead = s.dk === dk && (tr.dirA ? s.st > tr.at || (s.st === tr.at && tr.atStop) : s.st < tr.at || (s.st === tr.at && tr.atStop));
        return ahead ? Math.abs(s.st - tr.at) : 100 + Math.abs(s.st - (tr.dirA ? this.NS - 1 : 0));
      };
      c.sort((a, b) => score(a) - score(b));
      return c[0];
    }
    order(tr, type, arg) {
      const R = (...clips) => ({ ok: true, clips }), parked = tr.mode === 'parked', NS = this.NS;
      if (tr.mode === 'crashed' || tr.mode === 'gone') return { ok: false, clips: [] };
      switch (type) {
        case 'depart':
          if (parked) return this.order(tr, 'enter');
          tr.hold = false; tr.holdAt = null; tr.halted = false; return R('d.ack_depart');
        case 'go':
          if (parked) return this.order(tr, 'enter');
          tr.halted = false; tr.hold = false; tr.holdAt = null; return R('d.ack_go');
        case 'stop': if (parked) return R('d.cant'); tr.halted = true; return R('d.ack_stop');
        case 'hold':
          if (parked) return R('d.cant');
          if (tr.phase === 'dwell' && (arg == null || arg === tr.at)) { tr.hold = true; return R('ds.hold.' + tr.at); }
          { const n = arg != null ? arg : this.nextStation(tr); tr.holdAt = n; return R('ds.hold.' + n); }
        case 'skip': {
          if (parked) return R('d.cant');
          const n = arg != null ? arg : this.nextStation(tr); tr.skip.add(n); this.replan(tr); return R('ds.skip.' + n);
        }
        case 'limit': {
          const v = [20, 30, 40, 50, 60, 70].reduce((a, b) => Math.abs(b - arg) < Math.abs(a - arg) ? b : a, 40);
          tr.limit = v * KMH; if (tr.sight) { tr.sightCap = v * KMH; this.unsafeT = this.t + 900; } return R('d.limit_' + v);
        }
        case 'limitOff': tr.limit = 0; return R('d.ack_limit_off');
        case 'passred':
          if (parked || !(tr.phase === 'move' && tr.v < 0.5 && tr.blockReason)) return R('d.no_red');
          tr.sight = true; tr.sightCap = 20 * KMH; tr.halted = false; this.unsafeT = this.t + 900; return R('d.ack_passred');
        case 'depot':
          if (parked && tr.parkedAt[0] === 'D') return R('d.pos_depot');
          tr.order = { type: 'depot' };
          if (parked) this.enterService(tr); else this.replan(tr);
          return R('d.ack_depot');
        case 'siding': {
          const sd = this.pickSiding(tr, arg);
          if (!sd) return R('d.no_siding');
          if (parked && tr.parkedAt === sd.id) return R('ds.sid.' + sd.st);
          tr.order = { type: 'siding', id: sd.id, st: sd.st, dk: sd.dk };
          if (parked) this.enterService(tr); else this.replan(tr);
          return R('ds.siding.' + sd.st);
        }
        case 'enter':
          if (!parked) return R('d.already_line');
          if (tr.status !== 'ok') return R('d.not_ready');
          tr.order = null; this.enterService(tr); return R('d.ack_enter');
        case 'dest': case 'turn': {
          if (parked) return R('d.cant');
          let st = arg;
          const dir = tr.dirA ? 1 : -1, dk = tr.dirA ? 'A' : 'B', odk = tr.dirA ? 'B' : 'A';
          if (st == null) { for (let n = tr.at + (tr.atStop ? 0 : dir); n >= 0 && n < NS; n += dir) if (this.G.turn[n][dk]) { st = n; break; } }
          if (st == null) return R('d.cant');
          const ahead = tr.dirA ? (st > tr.at || (st === tr.at && tr.atStop)) : (st < tr.at || (st === tr.at && tr.atStop));
          const k = ahead ? dk : odk;
          if (!this.G.turn[st][k]) return R('ds.noturn.' + st);
          if (k === 'A') tr.termHi = st; else tr.termLo = st;
          if (tr.termLo >= tr.termHi) { if (k === 'A') tr.termLo = 0; else tr.termHi = NS - 1; }
          if (tr.order && tr.order.type !== 'hold') tr.order = null;
          this.replan(tr);
          return R((type === 'turn' ? 'ds.turn.' : 'ds.dest.') + st);
        }
        case 'discharge':
          if (parked) return R('d.cant');
          tr.discharge = true;
          if (tr.phase === 'dwell' && tr.dw) { tr.discharge = false; tr.noBoard = true; let tot = 0; for (let d = 0; d < NS; d++) { tr.dw.out[d] = tr.load[d]; tot += tr.load[d]; } tr.dw.outLeft = tot; }
          return R('d.ack_discharge');
        case 'cancel':
          tr.order = null; tr.termLo = 0; tr.termHi = NS - 1; tr.skip.clear(); tr.hold = false; tr.holdAt = null; tr.limit = 0;
          tr.discharge = false; tr.noBoard = false; tr.halted = false;
          this.replan(tr); return R('d.ack_cancel');
        case 'report': {
          const extra = 'Пассажиров в составе: ' + Math.round(tr.loadTot) + '. Скорость ' + Math.round(tr.v * 3.6) + ' км/ч.';
          let c;
          if (parked) c = tr.parkedAt[0] === 'D' ? ['d.pos_depot'] : ['ds.sid.' + this.G.stops[tr.parkedAt].st];
          else if (tr.phase === 'dwell') c = ['ds.at.' + tr.at];
          else if (tr.fault === 'dead') c = ['d.fault_dead'];
          else c = (tr.v < 0.3 ? ['d.pos_stop'] : []).concat(['ds.to.' + this.nextStation(tr)]);
          return { ok: true, clips: c, extra };
        }
      }
      return { ok: false, clips: ['d.no_understand'] };
    }

    // ---------------------------------------------------------------- описание для интерфейса
    trainXY(tr) { const s = tr.route[tr.hi]; if (!s) return { x: 0, y: 0 }; const off = tr.pos - tr.cum[tr.hi]; return s.e.poly.at(s.d > 0 ? off : s.e.len - off); }
    /** Точка и направление на расстоянии back от головы поезда вдоль его пути. */
    pointBack(tr, back) {
      const d = tr.pos - back; let i = tr.hi;
      while (i > 0 && tr.cum[i] > d) i--;
      const s = tr.route[i], off = M.clamp(d - tr.cum[i], 0, s.e.len), q = s.e.poly.at(s.d > 0 ? off : s.e.len - off);
      return { x: q.x, y: q.y, tx: q.tx * s.d, ty: q.ty * s.d };
    }
    where(tr) {
      const S = this.LINE.stations, s = tr.route[tr.hi];
      if (!s) return '—';
      const e = s.e;
      if (tr.mode === 'parked' && tr.parkedAt) return this.G.stops[tr.parkedAt].name;
      if (e.kind === 'platform') return 'ст. ' + S[e.st].short;
      if (e.kind === 'depot' || e.kind === 'throat') return 'депо';
      if (e.kind === 'lead') return 'соединительный путь депо';
      if (e.zone != null && e.kind !== 'main') return 'стрелочная зона ст. ' + S[e.zone].short;
      const dir = tr.dirA ? 1 : -1, a = M.clamp(tr.at, 0, this.NS - 1), b = M.clamp(tr.at + dir, 0, this.NS - 1);
      return 'перегон ' + S[a].short + ' — ' + S[b].short;
    }
    stateText(tr) {
      if (tr.mode === 'crashed') return 'авария';
      if (tr.mode === 'gone') return 'эвакуирован';
      if (tr.mode === 'parked') return tr.status === 'maint' ? 'техобслуживание, ещё ' + M.fmtDur(tr.statusT) : tr.status === 'repair' ? 'ремонт, ещё ' + M.fmtDur(tr.statusT) : (tr.fault ? 'неисправен' : 'в отстое, готов');
      if (tr.fault === 'dead') return 'неисправен, стоит';
      if (tr.phase === 'dwell') return tr.hold ? 'стоит до команды' : (tr.dw && tr.dw.closing > 0 ? 'отправляется' : 'посадка-высадка');
      if (tr.phase === 'rev') return 'смена кабины';
      if (tr.halted) return 'остановлен приказом';
      if (tr.noPower) return 'нет напряжения';
      if (tr.sight) return 'следует при запрещающем';
      if (tr.v < 0.1 && tr.waitT > 3) return tr.blockReason === 'switch' ? 'ждёт маршрут (стрелка)' : tr.blockReason === 'signal' ? 'у неисправного светофора' : 'у запрещающего сигнала';
      return 'в движении';
    }
    taskText(tr) {
      const S = this.LINE.stations;
      if (tr.mode !== 'service') return '';
      const o = tr.order;
      if (o && o.type === 'depot') return 'в депо';
      if (o && o.type === 'siding') return 'в тупик ст. ' + S[o.st].short;
      return (tr.dirA ? 'до ' + S[tr.termHi].short : 'до ' + S[tr.termLo].short) + (tr.noBoard ? ', без пассажиров' : '');
    }
    aspect(sig) {
      const owner = sig.e.res; let seg = { e: sig.e, d: sig.d };
      for (let g = 0; g < 12; g++) {
        const n = exitNode(seg), nx = this.railNext(seg);
        if (!nx || nx.mismatch || (n.sw && n.sw.moving)) return 'red';
        const e = nx.e;
        if (e.blocked || e.sigFault || e.occ.length) return 'red';
        if (e.res && e.res !== owner) return 'red';
        if (e.conf) for (const c of e.conf) if (c.occ.length || (c.res && c.res !== owner)) return 'red';
        if (e.safeStop) return e.res && e.res === owner ? 'green' : 'free';
        seg = nx;
      }
      return 'free';
    }
    inService() { let n = 0; for (const u of this.trains) if (u.mode === 'service') n++; return n; }
    recommended() { return Math.round(M.curveAt(M.TRAINS_CURVE, (this.t % 86400) / 3600)); }

    // ---------------------------------------------------------------- помощник графика
    assistant() {
      const rec = Math.round(M.curveAt(M.TRAINS_CURVE, ((this.t + 420) % 86400) / 3600));
      let n = 0; for (const u of this.trains) if (u.mode === 'service' && !u.order) n++;
      if (n < rec) {
        const c = this.trains.filter(u => u.mode === 'parked' && u.status === 'ok' && !u.fault);
        if (!c.length) return;
        c.sort((a, b) => (a.parkedAt[0] === 'D' ? 1 : 0) - (b.parkedAt[0] === 'D' ? 1 : 0));
        for (const tr of c) {
          const loc = tr.parkedAt[0] === 'D' ? 'D' : 'S' + this.G.stops[tr.parkedAt].st;
          if (this.t - (this.lastRelease[loc] || -1e9) < 110) continue;
          this.lastRelease[loc] = this.t;
          const r = this.order(tr, 'enter');
          this.emit('auto', { text: 'Помощник: маршрут ' + tr.num + ' — выход на линию (' + this.G.stops[this.G.stops[tr.curStop] ? tr.curStop : 'P:0:A'].name + ')' }); void r;
          return;
        }
      } else if (n > rec) {
        if (this.t - (this.lastWithdraw || -1e9) < 150) return;
        const freeDepot = this.G.depot.filter(id => this.freeStop(id, null)).length;
        const bound = this.trains.filter(u => u.order && u.order.type === 'depot').length;
        let best = null;
        for (const u of this.trains) if (u.mode === 'service' && !u.order && u.dirA && !u.fault && (u.phase === 'move' || u.phase === 'dwell') && (!u.proc || (u.plan[0] && u.plan[0].first)) && (!best || u.at > best.at)) best = u;
        if (!best) return;
        this.lastWithdraw = this.t;
        if (freeDepot - bound > 0) { this.order(best, 'depot'); this.emit('auto', { text: 'Помощник: маршрут ' + best.num + ' — в депо' }); } else {
          const u = this.trains.find(x => x.mode === 'service' && !x.order && !x.fault && this.pickSiding(x, null));
          if (u) { const r = this.order(u, 'siding'); if (r.ok) this.emit('auto', { text: 'Помощник: маршрут ' + u.num + ' — в тупик' }); }
        }
      }
    }

    // ---------------------------------------------------------------- шаг модели
    tickTrain(tr, dt) {
      if (tr.mode === 'parked') {
        if (tr.status !== 'ok') { tr.statusT -= dt; if (tr.statusT <= 0) { tr.status = 'ok'; if (tr.fault) tr.fault = null; tr.km = 0; tr.nextTO = 350 + this.rand() * 500; } }
        return;
      }
      if (tr.mode !== 'service') return;
      if (tr.fault === 'dead') { tr.faultT -= dt; if (tr.faultT <= 0) { tr.fault = 'traction'; this.radio(tr, ['d.fault_traction']); } }
      if (tr.phase === 'move') this.drive(tr, dt);
      else if (tr.phase === 'dwell') this.dwell(tr, dt);
      else if (tr.phase === 'rev') {
        tr.timer -= dt;
        if (tr.timer <= 0) { this.reverse(tr); if (tr.revThen === 'start') this.startStep(tr); else this.afterStep(tr); }
      }
    }
    step(dt) {
      this.t += dt;
      this.arrivals(dt);
      for (const sw of this.G.sw) if (sw.moving > 0) { sw.moving -= dt; if (sw.moving <= 0) { sw.moving = 0; sw.pos = sw.target; } }
      for (const tr of this.trains) this.tickTrain(tr, dt);
      this.detect();
      if (M.incidents) M.incidents.step(this, dt);
      this.statAcc += dt;
      if (this.statAcc >= 10) {
        const T = this.statAcc; this.statAcc = 0;
        let w = 0, ob = 0;
        for (let i = 0; i < this.NS; i++) for (let j = 0; j < this.NS; j++) w += this.wait[i][j];
        for (const tr of this.trains) ob += tr.loadTot;
        const rate = (this.boardAcc || 0) / T; this.boardAcc = 0;
        this.stats.boardRate = this.statN ? this.stats.boardRate + (rate - this.stats.boardRate) * Math.min(1, T / 420) : rate;
        this.statN = (this.statN || 0) + 1;
        this.stats.waiting = w; this.stats.onBoard = ob;
        this.stats.avgWait = this.stats.boardRate > 0.05 && this.t - this.t0 > 240 ? Math.min(3600, w / this.stats.boardRate) : 0;
        for (const tr of this.trains) if (tr.mode === 'crashed' && this.t - tr.crashT > 50 * 60) this.removeWreck(tr);
        for (const tr of this.trains) if (tr.mode === 'gone' && this.G.depot.some(id => this.freeStop(id, tr))) { tr.mode = 'crashed'; tr.route = [{ e: this.G.stops[this.G.depot[0]].e, d: 1 }]; tr.cum = [0]; tr.ti = tr.hi = 0; this.removeWreck(tr); }
      }
      if (this.opts.assistant) { this.asstAcc += dt; if (this.asstAcc >= 30) { this.asstAcc = 0; this.assistant(); } }
    }
  }

  M.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
