// Проверка аварийных сценариев: столкновение и сход возможны только при грубой ошибке диспетчера.
globalThis.M = {};
for (const f of ['util', 'line', '../data/geo', 'track', 'sim', 'incidents', 'phrases', 'commands']) require('../../game/js/' + f + '.js');
const G = M.buildGraph(M.GEO, M.LINE);
const mk = () => new M.Sim(G, { startTime: 8 * 3600, incidents: 0, assistant: false, autoSwitch: true, seed: 5 });
const run = (sim, sec, until) => { const ev = []; for (let i = 0; i < sec * 4; i++) { sim.step(0.25); for (const m of sim.outbox) if (m.type === 'crash') ev.push(m); sim.outbox.length = 0; if (until && until(ev)) break; } return ev; };
const follower = (sim, lead) => sim.trains.find(t => t !== lead && t.mode === 'service' && t.phase === 'move' && t.v === 0 && t.blockReason === 'occupied' && t.route[t.resEnd + 1] && (t.route[t.resEnd + 1].e.occ.includes(lead) || t.route[t.resEnd + 1].e.res === lead));
const gap = (sim, a, b) => { const p = sim.trainXY(a), q = sim.pointBack(b, b.L); return Math.hypot(p.x - q.x, p.y - q.y); };
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (info ? ' — ' + info : '')); if (!ok) fail++; };

// 0. Обычная работа: остановка поезда на перегоне не приводит к столкновению — следующий встаёт у сигнала.
{
  const sim = mk(); run(sim, 120);
  const lead = sim.trains.find(t => t.mode === 'service' && t.phase === 'move' && t.v > 12 && t.route[t.hi].e.kind === 'main');
  M.cmd.run(sim, 'маршрут ' + lead.num + ' стоп', null);
  const ev = run(sim, 900);
  const f = follower(sim, lead);
  check('остановленный поезд защищён АЛС-АРС', ev.length === 0 && !!f, f ? 'маршрут ' + f.num + ' стоит за маршрутом ' + lead.num + ', расстояние ' + gap(sim, f, lead).toFixed(0) + ' м' : 'следующий поезд не найден');

  // 1. «Проследуйте запрещающий сигнал» без превышения скорости: сближение без удара.
  M.cmd.run(sim, 'маршрут ' + f.num + ' проследуйте запрещающий сигнал', null);
  const ev1 = run(sim, 600);
  check('проезд запрещающего на 20 км/ч — остановка перед хвостом', ev1.length === 0 && f.v === 0, 'расстояние до хвоста ' + gap(sim, f, lead).toFixed(1) + ' м, аварий ' + ev1.length);
}
// 2. Проезд запрещающего сигнала с приказом повысить скорость — столкновение.
{
  const sim = mk(); run(sim, 120);
  const lead = sim.trains.find(t => t.mode === 'service' && t.phase === 'move' && t.v > 12 && t.route[t.hi].e.kind === 'main');
  M.cmd.run(sim, 'маршрут ' + lead.num + ' стоп', null);
  run(sim, 900);
  const f = follower(sim, lead);
  M.cmd.run(sim, 'маршрут ' + f.num + ' проследуйте запрещающий сигнал', null);
  M.cmd.run(sim, 'маршрут ' + f.num + ' скорость не более шестидесяти', null);
  const ev = run(sim, 600, e => e.length > 0);
  check('проезд запрещающего + скорость 60 — столкновение', ev.length === 1 && ev[0].kind === 'collision', ev[0] ? ev[0].text + ' Скорость удара ' + ev[0].speed.toFixed(0) + ' км/ч' : 'аварии нет');
  const ev2 = run(sim, 3600);
  check('после аварии составы эвакуированы, движение восстановлено', ev2.length === 0 && sim.trains.filter(t => t.mode === 'crashed').length === 0, 'в ремонте: ' + sim.trains.filter(t => t.status === 'repair' && t.fault === 'crash').map(t => t.num).join(', '));
}
// 3. Аварийный перевод стрелки под составом — сход.
{
  const sim = mk(); let hit = null;
  const exitNode = s => (s.d > 0 ? s.e.b : s.e.a);
  for (let i = 0; i < 4 * 1800 && !hit; i++) {
    sim.step(0.25); sim.outbox.length = 0;
    for (const tr of sim.trains) { if (tr.mode !== 'service' || tr.v < 3) continue; for (let k = tr.ti; k < tr.hi; k++) { const n = exitNode(tr.route[k]); if (n.sw && !n.sw.depot && !n.sw.moving) hit = { tr, sw: n.sw }; } }
  }
  const normal = sim.throwSwitch(hit.sw, false);
  check('обычный перевод занятой стрелки запрещён', !normal.ok && normal.locked, normal.why);
  sim.throwSwitch(hit.sw, true);
  const ev = run(sim, 30, e => e.length > 0);
  check('аварийный перевод под составом — сход', ev.length === 1 && ev[0].kind === 'derail', ev[0] ? ev[0].text : 'аварии нет');
}
console.log(fail ? 'FAILED: ' + fail : 'все аварийные сценарии отработали как задумано');
process.exit(fail ? 1 : 0);
