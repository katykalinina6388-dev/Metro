/* Нештатные ситуации. Частота задаётся настройкой (0 — выключены … 3 — часто). */
(function (root) {
  'use strict';
  const M = root.M;
  const KMH = 1 / 3.6;
  const RATES = [0, 0.3, 0.9, 2.4];            // событий в час
  const TYPES = [['doors', 15], ['sick', 13], ['traction', 12], ['dead', 7], ['person', 8], ['switch', 9], ['signal', 10], ['item', 8], ['tsr', 10], ['power', 6]];

  function pickTrain(sim, pred) {
    const c = sim.trains.filter(t => t.mode === 'service' && !t.fault && !t.pendingInc && (!pred || pred(t)));
    return c.length ? M.choice(sim.rand, c) : null;
  }
  function add(sim, o) {
    const inc = Object.assign({ id: sim.incSeq++, t0: sim.t, until: Infinity, done: false, x: 0, y: 0 }, o);
    sim.incidents.push(inc);
    sim.emit('incident', { id: inc.id, title: inc.title, text: inc.text, level: inc.level || 'warn' });
    return inc;
  }
  const S = i => M.LINE.stations[i];
  const tk = k => (k === 'A' ? 'I' : 'II');

  M.incidents = {
    RATES,
    step(sim, dt) {
      const rate = RATES[sim.opts.incidents] || 0;
      if (rate > 0 && sim.inService() > 2 && sim.rand() < rate / 3600 * dt) {
        const active = sim.incidents.filter(i => !i.done && i.type !== 'crowd').length;
        if (active < (sim.opts.incidents >= 3 ? 4 : 2)) this.spawn(sim);
      }
      sim.incAcc = (sim.incAcc || 0) + dt;
      if (sim.incAcc < 1) return;
      const T = sim.incAcc; sim.incAcc = 0;
      for (const inc of sim.incidents) if (!inc.done) this.update(sim, inc, T);
      // переполнение платформ
      sim.crowdAcc = (sim.crowdAcc || 0) + T;
      if (sim.crowdAcc > 20) {
        sim.crowdAcc = 0;
        for (let i = 0; i < sim.NS; i++) {
          const w = sim.waitDir(i), tot = w[0] + w[1], st = sim.stn[i];
          if (tot > 2400 && sim.t - st.crowdT > 1800) {
            st.crowdT = sim.t;
            const g = sim.G.st[i];
            add(sim, { type: 'crowd', st: i, title: 'Переполнение платформы', text: 'Ст. ' + S(i).short + ': на платформе ' + Math.round(tot) + ' человек.', until: sim.t + 600, x: g.x, y: g.y });
            sim.stRadio(i, ['s.crowd']);
          }
        }
      }
      if (sim.incidents.length > 60) sim.incidents = sim.incidents.filter(i => !i.done || sim.t - i.t0 < 3600);
    },

    spawn(sim, force) {
      let type = force;
      if (!type) {
        let tot = 0; for (const t of TYPES) tot += t[1];
        let r = sim.rand() * tot;
        for (const t of TYPES) { r -= t[1]; if (r <= 0) { type = t[0]; break; } }
      }
      const G = sim.G, NS = sim.NS, rnd = (a, b) => a + sim.rand() * (b - a);
      if (type === 'doors' || type === 'sick') {
        const tr = pickTrain(sim, t => t.phase === 'move' && t.loadTot > 5); if (!tr) return null;
        const extra = type === 'doors' ? rnd(60, 140) : rnd(110, 220);
        const inc = add(sim, { type, tr, title: type === 'doors' ? 'Неисправность дверей' : 'Плохо пассажиру', text: 'Маршрут ' + tr.num + ': ' + (type === 'doors' ? 'не закрываются двери' : 'пассажиру плохо в вагоне') + ', увеличенная стоянка на ближайшей станции.', until: sim.t + 1200 });
        tr.pendingInc = { extra, clip: type === 'doors' ? 'd.doors' : 'd.sick', inc };
        return inc;
      }
      if (type === 'traction' || type === 'dead') {
        const tr = pickTrain(sim, t => t.phase === 'move' && t.v > 5); if (!tr) return null;
        if (type === 'dead') { tr.fault = 'dead'; tr.faultT = rnd(240, 520); sim.radio(tr, ['d.fault_dead']); } else { tr.fault = 'traction'; sim.radio(tr, ['d.fault_traction']); }
        return add(sim, { type: 'fault', tr, level: 'bad', title: 'Неисправность состава', text: 'Маршрут ' + tr.num + ': ' + (type === 'dead' ? 'состав стоит, машинист устраняет неисправность.' : 'скорость ограничена, состав нужно снять с линии.') });
      }
      if (type === 'person') {
        const st = Math.floor(sim.rand() * NS), k = sim.rand() < 0.5 ? 'A' : 'B';
        if (sim.stn[st].closed) return null;
        const pe = G.stops['P:' + st + ':' + k].e, arr = G.main[k], j = arr.indexOf(pe), ap = arr[j + (k === 'A' ? -1 : 1)];
        const edges = [pe]; if (ap && (ap.kind === 'main' || ap.kind === 'rev')) edges.push(ap);
        for (const e of edges) e.blocked++;
        sim.stRadio(st, ['s.person']);
        return add(sim, { type: 'person', st, k, edges, level: 'bad', title: 'Человек на пути', text: 'Ст. ' + S(st).short + ', ' + tk(k) + ' путь: напряжение снято, движение по пути закрыто.', until: sim.t + rnd(240, 460), x: G.st[st].x, y: G.st[st].y });
      }
      if (type === 'switch') {
        const c = G.sw.filter(s => !s.depot && !s.broken && !s.moving && !s.node.res);
        if (!c.length) return null;
        const sw = M.choice(sim.rand, c); sw.broken = true;
        sim.stRadio(sw.zone, ['s.switch_fault']);
        return add(sim, { type: 'switch', st: sw.zone, sw, title: 'Неисправность стрелки', text: 'Ст. ' + S(sw.zone).short + ': стрелка № ' + sw.name + ' не переводится.', until: sim.t + rnd(600, 1400), x: sw.node.x, y: sw.node.y });
      }
      if (type === 'signal') {
        const st = Math.floor(sim.rand() * NS), k = sim.rand() < 0.5 ? 'A' : 'B';
        const pe = G.stops['P:' + st + ':' + k].e, arr = G.main[k], j = arr.indexOf(pe), e = arr[j + (k === 'A' ? 1 : -1)];
        if (!e || e.sigFault || (e.kind !== 'main' && e.kind !== 'rev')) return null;
        e.sigFault = true;
        sim.stRadio(st, ['s.signal_fault']);
        return add(sim, { type: 'signal', st, k, edge: e, title: 'Неисправность светофора', text: 'Ст. ' + S(st).short + ', ' + tk(k) + ' путь: выходной светофор не открывается. Поезда пропускать приказом «проследуйте запрещающий сигнал».', until: sim.t + rnd(480, 1100), x: G.st[st].x, y: G.st[st].y });
      }
      if (type === 'item') {
        const st = 1 + Math.floor(sim.rand() * (NS - 2));
        if (sim.stn[st].closed || sim.stn[st].item) return null;
        sim.stRadio(st, ['s.item']);
        const inc = add(sim, { type: 'item', st, level: 'bad', phase: 0, title: 'Бесхозный предмет', text: 'Ст. ' + S(st).short + ': бесхозный предмет на платформе. Закройте станцию для пассажиров.', deadline: sim.t + 180, x: G.st[st].x, y: G.st[st].y });
        sim.stn[st].item = inc;
        return inc;
      }
      if (type === 'tsr' || type === 'power') {
        const st = Math.floor(sim.rand() * (NS - 1)), k = sim.rand() < 0.5 ? 'A' : 'B', sv = G.sv[k];
        const edges = G.main[k].filter(e => e.kind === 'main' && e.sLo >= sv[st] + 78 && e.sHi <= sv[st + 1] - 78);
        if (!edges.length) return null;
        const mid = edges[edges.length >> 1], q = mid.poly.at(mid.len / 2);
        const name = S(st).short + ' — ' + S(st + 1).short + ', ' + tk(k) + ' путь';
        if (type === 'tsr') {
          const part = edges.slice(Math.floor(edges.length / 3), Math.ceil(edges.length * 2 / 3) + 1);
          for (const e of part) e.tsr = 40 * KMH;
          sim.stRadio(k === 'A' ? st : st + 1, ['s.tsr']);
          return add(sim, { type: 'tsr', st, k, edges: part, title: 'Ограничение скорости', text: 'Перегон ' + name + ': дефект пути, скорость не более 40 км/ч.', until: sim.t + rnd(1200, 2400), x: q.x, y: q.y });
        }
        for (const e of edges) e.blocked++;
        sim.stRadio(k === 'A' ? st : st + 1, ['s.power']);
        return add(sim, { type: 'power', st, k, edges, level: 'bad', title: 'Снятие напряжения', text: 'Перегон ' + name + ': снято напряжение с контактного рельса.', until: sim.t + rnd(180, 360), x: q.x, y: q.y });
      }
      return null;
    },

    /** Взрез стрелки поездом, проследовавшим запрещающий сигнал: стрелка повреждена до ремонта. */
    runthrough(sim, sw, tr) {
      sim.stRadio(sw.zone, ['s.runthrough']);
      add(sim, { type: 'switch', st: sw.zone, sw, level: 'bad', title: 'Взрез стрелки', text: 'Ст. ' + S(sw.zone).short + ': стрелка № ' + sw.name + ' взрезана маршрутом ' + tr.num + ', идёт ремонт.', until: sim.t + 1200 + sim.rand() * 600, x: sw.node.x, y: sw.node.y });
      sim.stats.reprimands++;
    },

    update(sim, inc, T) {
      const end = () => { inc.done = true; sim.emit('incidentEnd', { id: inc.id, title: inc.title }); };
      switch (inc.type) {
        case 'fault': {
          const tr = inc.tr;
          const p = sim.trainXY(tr); inc.x = p.x; inc.y = p.y;
          if (tr.mode !== 'service' || !tr.fault) end();
          break;
        }
        case 'item': {
          const st = sim.stn[inc.st];
          if (inc.phase === 0) {
            if (st.closed) { inc.phase = 1; inc.until = sim.t + 540 + sim.rand() * 600; inc.text = 'Ст. ' + S(inc.st).short + ': станция закрыта, предмет проверяют.'; } else if (sim.t > inc.deadline) {
              st.closed = true; inc.phase = 1; inc.until = sim.t + 700 + sim.rand() * 500; sim.stats.reprimands++;
              sim.emit('toast', { level: 'bad', text: 'Ст. ' + S(inc.st).short + ' закрыта дежурным без приказа диспетчера — замечание.' });
            }
          } else if (inc.phase === 1 && sim.t > inc.until) {
            inc.phase = 2; inc.deadline = sim.t + 240; sim.stRadio(inc.st, ['s.item_clear']);
            inc.text = 'Ст. ' + S(inc.st).short + ': угрозы нет, станцию можно открывать.';
          } else if (inc.phase === 2 && (!st.closed || sim.t > inc.deadline)) { st.closed = false; st.item = null; end(); }
          break;
        }
        default:
          if (sim.t < inc.until) break;
          if (inc.type === 'person') { for (const e of inc.edges) e.blocked--; sim.stRadio(inc.st, ['s.person_clear']); }
          if (inc.type === 'power') { for (const e of inc.edges) e.blocked--; sim.stRadio(inc.k === 'A' ? inc.st : inc.st + 1, ['s.power_back']); }
          if (inc.type === 'tsr') { for (const e of inc.edges) e.tsr = 0; sim.stRadio(inc.k === 'A' ? inc.st : inc.st + 1, ['s.tsr_off']); }
          if (inc.type === 'switch') { inc.sw.broken = false; sim.stRadio(inc.st, ['s.switch_ok']); }
          if (inc.type === 'signal') { inc.edge.sigFault = false; sim.stRadio(inc.st, ['s.signal_ok']); }
          end();
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
