// Прогон модели без интерфейса: сутки работы с помощником графика, проверка отсутствия аварий и заторов.
globalThis.M = {};
for (const f of ['util', 'line', '../data/geo', 'track', 'sim', 'incidents']) { try { require('../../game/js/' + f + '.js'); } catch (e) { if (f !== 'incidents') throw e; } }
const G = M.buildGraph(M.GEO, M.LINE);
const args = process.argv.slice(2);
const start = parseFloat(args[0] || '5') * 3600, hours = parseFloat(args[1] || '24'), inc = parseInt(args[2] || '0', 10);
const auto = args[3] !== 'manual';
const sim = new M.Sim(G, { startTime: start, incidents: inc, assistant: true, autoSwitch: auto, regulate: true });
const dt = 0.25, steps = Math.round(hours * 3600 / dt);
let radio = 0, crashes = [], maxStuck = 0, stuckInfo = '', lastLog = -1, attention = 0, passred = 0, thrown = 0;
const reasons = {};
process.on('exit', () => { console.log('attention by reason:', JSON.stringify(reasons)); if (!auto) console.log('switches thrown by the scripted player:', thrown); });
const stuck = new Map();
const T0 = Date.now();
for (let i = 0; i < steps; i++) {
  sim.step(dt);
  for (const m of sim.outbox) {
    if (m.type === 'radio') radio++; if (m.type === 'crash') crashes.push(M.fmtClock(m.t, true) + ' ' + m.text);
    if (m.type === 'attention') {
      attention++; reasons[m.reason] = (reasons[m.reason] || 0) + 1;
      if (m.reason === 'signal') { sim.order(sim.trains[m.num - 1], 'passred'); passred++; }
      if (m.reason === 'depotfull') { const r = sim.order(sim.trains[m.num - 1], 'siding'); if (!r.ok || r.clips[0] === 'd.no_siding') sim.order(sim.trains[m.num - 1], 'cancel'); }
    }
  }
  sim.outbox.length = 0;
  // «игрок»: неисправные составы — в депо
  if (i % 240 === 0) for (const tr of sim.trains) if (tr.mode === 'service' && tr.fault === 'traction' && !tr.order) sim.order(tr, 'depot');
  // «игрок» в ручном режиме: переводит стрелку, которую запросил стоящий поезд
  if (!auto && i % 20 === 0) for (const tr of sim.trains) if (tr.mode === 'service' && tr.needSw && tr.v === 0 && tr.blockReason === 'switch') { if (sim.throwSwitch(tr.needSw, false).ok) thrown++; }
  if (i % 40 === 0) {
    for (const tr of sim.trains) {
      if (tr.mode === 'service' && tr.v < 0.01 && !tr.hold) {
        const s = (stuck.get(tr.id) || 0) + 10; stuck.set(tr.id, s);
        if (s > maxStuck) { maxStuck = s; stuckInfo = 'm' + tr.num + ' ' + tr.phase + ' ' + sim.where(tr) + ' ' + (tr.blockReason || '') + ' @' + M.fmtClock(sim.t); }
      } else stuck.set(tr.id, 0);
    }
  }
  const h = Math.floor((sim.t - start) / 3600);
  if (h !== lastLog) {
    lastLog = h;
    const st = sim.stats, hw = sim.stn.map(s => Math.round(s.hw.A)).join(',');
    console.log(M.fmtClock(sim.t), 'onLine', String(sim.inService()).padStart(2), 'rec', String(sim.recommended()).padStart(2), 'wait', String(Math.round(st.waiting)).padStart(6), 'onBoard', String(Math.round(st.onBoard)).padStart(6),
      'deliv', String(Math.round(st.delivered)).padStart(7), 'avgW', String(Math.round(st.avgWait)).padStart(4) + 's', 'left', Math.round(st.leftBehind), 'hwA', hw);
  }
}
console.log('--- done in', ((Date.now() - T0) / 1000).toFixed(1), 's; radio msgs', radio, 'attention', attention, 'crashes', crashes.length, 'max standstill', maxStuck, 's', stuckInfo);
for (const c of crashes.slice(0, 5)) console.log('CRASH', c);
const km = sim.trains.map(t => Math.round(t.km));
console.log('km per train min/max', Math.min(...km), Math.max(...km), 'incidents', sim.incidents.length, 'turnedAway', Math.round(sim.stats.turnedAway), 'cycle', Math.round(sim.cycleMeas), 'est', Math.round(sim.cycleEst), 'passred', passred);
const modes = {}; for (const t of sim.trains) modes[t.mode + '/' + t.status] = (modes[t.mode + '/' + t.status] || 0) + 1; console.log('fleet', JSON.stringify(modes));
if (args[4] === 'dump') for (const tr of sim.trains) if (tr.mode === 'service') console.log(tr.num, tr.phase, sim.where(tr), sim.stateText(tr), sim.taskText(tr), 'v', tr.v.toFixed(1), tr.blockReason, tr.plan.map(p => p.stop).join('>'));
if (args[5]) {
  const tr = sim.trains[+args[5] - 1];
  console.log(JSON.stringify({ num: tr.num, mode: tr.mode, phase: tr.phase, noRoute: tr.noRoute, retryT: tr.retryT, stopIdx: tr.stopIdx, stopPos: tr.stopPos, pos: tr.pos, hi: tr.hi, ti: tr.ti, resEnd: tr.resEnd,
    sight: tr.sight, divertStop: tr.divertStop, halted: tr.halted, hold: tr.hold, fault: tr.fault, noPower: tr.noPower, order: tr.order, plan: tr.plan, proc: tr.proc, waitT: tr.waitT, auth: sim.authDist(tr),
    route: tr.route.map((s, i) => i + ':' + s.e.kind + s.e.id + (s.d > 0 ? '+' : '-') + Math.round(s.e.len) + (s.e.res ? 'r' + s.e.res.num : '') + (s.e.blocked ? 'B' : '') + (s.e.sigFault ? 'F' : '')).join(' '), cum: tr.cum.map(Math.round) }));
  console.log('broken switches', sim.G.sw.filter(s => s.broken).map(s => s.id + '/z' + s.zone + '/' + s.pos).join(' '), 'active inc', sim.incidents.filter(i => !i.done).map(i => i.type + ':' + (i.st != null ? i.st : '')).join(' '));
}
