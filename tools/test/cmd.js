// Проверка разбора команд и исполнения приказов.
globalThis.M = {};
for (const f of ['util', 'line', '../data/geo', 'track', 'sim', 'incidents', 'phrases', 'commands']) require('../../game/js/' + f + '.js');
const G = M.buildGraph(M.GEO, M.LINE);
const sim = new M.Sim(G, { startTime: 8 * 3600, incidents: 0, assistant: false });
const cases = [
  ['Маршрут двенадцать, отправляйтесь', 12, 'depart', null],
  ['маршрут 7 следуйте в депо', 7, 'depot', null],
  ['Двадцать первый, следуйте до станции Ломоносовская', 21, 'dest', 8],
  ['пятому маршруту оборот по станции площадь александра невского', 5, 'turn', 6],
  ['маршрут три скорость не более сорока', 3, 'limit', 40],
  ['маршрут тридцать ограничение скорости шестьдесят', 30, 'limit', 60],
  ['маршрут девять отмена ограничения скорости', 9, 'limitOff', null],
  ['поезд четыре проследуйте запрещающий сигнал', 4, 'passred', null],
  ['маршрут восемь станцию гостиный двор проследуйте без остановки', 8, 'skip', 4],
  ['маршрут два высадите пассажиров', 2, 'discharge', null],
  ['маршрут шестнадцать следуйте в тупик станции маяковская', 16, 'siding', 5],
  ['маршрут один доложите обстановку', 1, 'report', null],
  ['маршрут одиннадцать стоп', 11, 'stop', null],
  ['маршрут одиннадцать продолжайте движение', 11, 'go', null],
  ['маршрут двадцать пять выходите на линию', 25, 'enter', null],
  ['маршрут шесть задержитесь на станции Обухово', 6, 'hold', 10],
  ['маршрут десять следуйте до Рыбацкого', 10, 'dest', 11],
  ['всем поездам стоп', null, 'stop', null],
  ['маршрут 14, экстренное торможение!', 14, 'stop', null]
];
let bad = 0;
for (const [t, num, intent, arg] of cases) {
  const p = M.cmd.parse(t);
  const ok = p.num === num && p.intent === intent && (arg == null || p.arg === arg);
  if (!ok) { bad++; console.log('FAIL', t, '=>', p.num, p.intent, p.arg); }
}
console.log('parse cases', cases.length, 'failed', bad);
const g = M.cmd.grammar();
const words = new Set(); for (const s of g) for (const w of s.split(' ')) words.add(w);
console.log('grammar phrases', g.length, 'unique words', words.size);
require('fs').writeFileSync('/tmp/dl/grammar.json', JSON.stringify(g));
require('fs').writeFileSync('/tmp/dl/clips.json', JSON.stringify(M.allClips()));
console.log('clips', M.allClips().length);
// исполнение
for (let i = 0; i < 400; i++) sim.step(0.25);
const log = [];
const say = t => { M.cmd.run(sim, t, null); for (const m of sim.outbox) if (m.type === 'radio') log.push(t + ' -> ' + m.clips.map(M.phrase).join(' ') + (m.extra ? ' [' + m.extra + ']' : '')); else if (m.type === 'sys') log.push(t + ' -> SYS ' + m.text); sim.outbox.length = 0; };
['маршрут один доложите обстановку', 'маршрут один следуйте в депо', 'маршрут два оборот по станции ломоносовская', 'маршрут три следуйте в тупик', 'маршрут тридцать выходите на линию',
  'маршрут четыре скорость не более сорока', 'маршрут пять проследуйте запрещающий сигнал', 'маршрут шесть стоп', 'маршрут шесть продолжайте движение', 'маршрут семь оборот по станции елизаровская', 'абракадабра', 'маршрут восемь абракадабра',
  'маршрут девять станцию гостиный двор проследуйте без остановки', 'маршрут десять высадите пассажиров'].forEach(say);
console.log(log.join('\n'));
let crashes = 0;
for (let i = 0; i < 4 * 3600 * 4; i++) { sim.step(0.25); for (const m of sim.outbox) { if (m.type === 'crash') { crashes++; console.log('CRASH', m.text); } } sim.outbox.length = 0; }
console.log('after 4h: crashes', crashes, 'parked', sim.trains.filter(t => t.mode === 'parked').map(t => t.num + '@' + t.parkedAt).join(' '));
for (const n of [1, 2, 3, 7, 9, 10, 30]) { const tr = sim.trains[n - 1]; console.log(n, tr.mode, tr.phase, sim.where(tr), sim.stateText(tr), sim.taskText(tr), 'terms', tr.termLo, tr.termHi); }
