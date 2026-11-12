/* Разбор голосовых и текстовых команд диспетчера и их исполнение. */
(function (root) {
  'use strict';
  const M = root.M;

  const CARD = {
    'ноль': 0, 'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9,
    'десять': 10, 'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13, 'четырнадцать': 14, 'пятнадцать': 15, 'шестнадцать': 16,
    'семнадцать': 17, 'восемнадцать': 18, 'девятнадцать': 19, 'двадцать': 20, 'тридцать': 30, 'сорок': 40, 'пятьдесят': 50,
    'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80,
    'двадцати': 20, 'тридцати': 30, 'сорока': 40, 'пятидесяти': 50, 'шестидесяти': 60, 'семидесяти': 70
  };
  const ORD = {
    'первый': 1, 'второй': 2, 'третий': 3, 'четвертый': 4, 'пятый': 5, 'шестой': 6, 'седьмой': 7, 'восьмой': 8, 'девятый': 9, 'десятый': 10,
    'одиннадцатый': 11, 'двенадцатый': 12, 'тринадцатый': 13, 'четырнадцатый': 14, 'пятнадцатый': 15, 'шестнадцатый': 16,
    'семнадцатый': 17, 'восемнадцатый': 18, 'девятнадцатый': 19, 'двадцатый': 20, 'тридцатый': 30
  };
  const NUM = Object.assign({}, CARD, ORD);
  for (const w in ORD) {                       // дательный падеж: «двенадцатому»
    const d = w.replace(/(ый|ой)$/, 'ому').replace(/ий$/, 'ьему');
    NUM[d] = ORD[w];
  }
  const ST = [[/бегов/, 0], [/зенит|крестовск/, 1], [/приморск/, 2], [/василеостров/, 3], [/гостин/, 4], [/маяковск/, 5],
    [/невск|александр/, 6], [/елизаров/, 7], [/ломоносов/, 8], [/пролетарск/, 9], [/обухов/, 10], [/рыбацк/, 11]];
  const INTENTS = [
    ['passred', /запрещающ|красн\S* (сигнал|светофор)|проезд\S* (сигнал|светофор)/],
    ['skip', /без останов|не останавлива/],
    ['limitOff', /(отмен|снят|снима)\S*\s+ограничен|ограничен\S*\s+(скорости\s+)?(отмен|снят)|без ограничен/],
    ['limit', /скорост|ограничен/],
    ['depot', /депо/],
    ['siding', /тупик|отсто/],
    ['enter', /на лини|выезжа|выходи/],
    ['turn', /оборот|оборач|оберн/],
    ['discharge', /высад|высаж/],
    ['hold', /задерж|ожидайте|ждите|до команды|стоянк/],
    ['report', /долож|обстановк|где вы|где наход|местоположен|местонахожден|как слыш/],
    ['stop', /(^| )стоп( |$)|остановит|остановк|тормо[зж]|(^| )стой(те)?( |$)/],
    ['dest', /до станци|до конечн|следу\S+ до /],
    ['depart', /отправля|отправлен|поехали/],
    ['cancel', /отмен|отставить|по график/],
    ['go', /продолжа|следуйте|разрешаю|движени/]
  ];
  const TRIG = /^(маршрут|поезд|номер|состав|машинист|борт)/;

  M.cmd = {
    normalize(text) { return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); },

    parse(text) {
      const s = this.normalize(text), raw = s ? s.split(' ') : [], toks = [];
      for (let i = 0; i < raw.length; i++) {
        const w = raw[i];
        let v = /^\d+$/.test(w) ? parseInt(w, 10) : (w in NUM ? NUM[w] : null);
        if (v != null) {
          const nx = raw[i + 1], nv = nx != null && nx in NUM ? NUM[nx] : null;
          if (v >= 20 && v % 10 === 0 && nv != null && nv > 0 && nv < 10) { v += nv; i++; }
          toks.push({ n: v });
        } else toks.push({ w });
      }
      const out = { text: s, num: null, intent: null, arg: null, all: /(^| )(всем|все поезда)( |$)/.test(s), station: null };
      let speed = null, numIdx = -1;
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].n == null) continue;
        const pw = i > 0 ? toks[i - 1].w || '' : '', pw2 = i > 1 ? toks[i - 2].w || '' : '';
        if (/^(скорост|ограничен|более|выше|до$)/.test(pw) || /^(скорост|более)/.test(pw2) && pw === 'не') { if (speed == null) speed = toks[i].n; continue; }
        if (out.num == null && (TRIG.test(pw) || i <= 1)) { out.num = toks[i].n; numIdx = i; continue; }
        if (speed == null) speed = toks[i].n;
      }
      for (const [re, idx] of ST) if (re.test(s)) { out.station = idx; break; }
      for (const [name, re] of INTENTS) if (re.test(s)) { out.intent = name; break; }
      if (out.intent === 'go' && out.station != null && / (до|на) /.test(' ' + s + ' ')) out.intent = 'dest';
      if (out.intent === 'limit') {
        if (speed == null && out.num != null && !toks.some(t => t.w && TRIG.test(t.w))) { speed = out.num; out.num = null; }
        if (speed == null) out.intent = null; else out.arg = speed;
      } else if (['dest', 'turn', 'siding', 'skip', 'hold'].indexOf(out.intent) >= 0) out.arg = out.station;
      if (out.intent === 'dest' && out.arg == null) out.arg = /конечн/.test(s) ? 'term' : null;
      void numIdx;
      return out;
    },

    /** Выполнить команду. sel — выбранный в интерфейсе поезд (используется, если номер не назван). */
    run(sim, text, sel) {
      const p = this.parse(text);
      sim.emit('disp', { text: String(text).trim() });
      if (!p.text) return p;
      if (p.all) {
        const it = p.intent === 'stop' || p.intent === 'go' || p.intent === 'depart' || p.intent === 'limit' || p.intent === 'limitOff' || p.intent === 'cancel' ? p.intent : null;
        if (!it) { sim.emit('sys', { text: 'Циркулярный приказ не распознан. Доступно: «Всем поездам стоп», «Всем продолжать движение».' }); return p; }
        let n = 0;
        for (const tr of sim.trains) if (tr.mode === 'service') { sim.order(tr, it, p.arg); n++; }
        sim.emit('sys', { text: 'Циркулярный приказ принят всеми машинистами (' + n + ').' });
        return p;
      }
      const tr = p.num != null ? sim.trains.find(t => t.num === p.num) : sel;
      if (!tr) {
        sim.emit('sys', { text: p.num != null ? 'Маршрута ' + p.num + ' на линии нет.' : 'Не назван номер маршрута. Скажите, например: «Маршрут пять, отправляйтесь».' });
        return p;
      }
      p.train = tr;
      if (!p.intent) { sim.radio(tr, ['d.no_understand']); return p; }
      let arg = p.arg;
      if (p.intent === 'dest') {
        if (arg === 'term') arg = tr.dirA ? sim.NS - 1 : 0;
        if (arg == null) { sim.radio(tr, ['d.no_understand']); return p; }
      }
      const r = sim.order(tr, p.intent, arg);
      p.result = r;
      if (r.clips && r.clips.length) sim.radio(tr, r.clips, r.extra);
      return p;
    },

    /** Набор фраз для распознавателя с ограниченным словарём.
     *  Слова, которых нет в словаре модели, распознаватель пропускает, поэтому для названий станций
     *  перечислены и близкие по звучанию формы (например, «ломоносовский» вместо «ломоносовская»). */
    grammar() {
      const S = [['беговая', 'беговой'], ['зенит', 'зенита'], ['приморская', 'приморской'], ['василеостровская', 'василеостровский', 'василеостровского'],
        ['гостиный двор', 'гостиного двора'], ['маяковская', 'маяковского'], ['площадь александра невского', 'площади александра невского'],
        ['елизаровская', 'елизарова', 'елизаров'], ['ломоносовская', 'ломоносовский', 'ломоносова'], ['пролетарская', 'пролетарской'],
        ['обухово', 'обухова'], ['рыбацкое', 'рыбацкого']];
      const plain = ['отправляйтесь', 'отправление', 'стоп', 'остановитесь', 'экстренное торможение', 'продолжайте движение', 'следуйте в депо',
        'следуйте в тупик', 'выходите на линию', 'оборот', 'высадите пассажиров', 'высадка пассажиров', 'задержитесь', 'ожидайте', 'стойте до команды',
        'доложите обстановку', 'доложите местоположение', 'где вы находитесь', 'проследуйте запрещающий сигнал', 'разрешаю проследовать запрещающий сигнал',
        'отмена ограничения скорости', 'ограничение скорости снято', 'отмена', 'следуйте по графику', 'следуйте без остановки',
        'следуйте до конечной', 'разрешаю движение'];
      const withSt = ['следуйте до станции {s}', 'оборот по станции {s}', 'следуйте в тупик станции {s}', 'станцию {s} проследуйте без остановки',
        'задержитесь на станции {s}', 'без остановки на станции {s}', 'следуйте до {s}'];
      const speeds = ['двадцать', 'тридцать', 'сорок', 'сорока', 'пятьдесят', 'шестьдесят', 'семьдесят'];
      const out = [], N = M.LINE.fleet, ordK = Object.keys(ORD);
      const ord = n => { if (n <= 20 || n === 30) return ordK.find(k => ORD[k] === n); return (n < 30 ? 'двадцать ' : 'тридцать ') + ordK.find(k => ORD[k] === n % 10); };
      const tails = plain.slice();
      for (const t of withSt) for (const forms of S) for (const f of forms) tails.push(t.replace('{s}', f));
      for (const v of speeds) { tails.push('скорость не более ' + v); tails.push('ограничение скорости ' + v); }
      for (let n = 1; n <= N; n++) {
        const heads = ['маршрут ' + M.numWords(n), ord(n), 'поезд ' + M.numWords(n), ord(n) + ' маршрут'];
        for (let j = n % 3; j < tails.length; j += 3) out.push(heads[(j + n) % heads.length] + ' ' + tails[j]);
        out.push(heads[0], heads[1]);
      }
      for (const t of tails) out.push(t);
      out.push('всем поездам стоп', 'внимание всем поездам стоп', 'всем поездам продолжать движение', 'всем продолжайте движение', 'диспетчер', 'машинист', 'номер', 'состав', 'километров в час',
        'четвёртый маршрут', 'двадцать четвёртый', 'одна две ноль', Object.keys(CARD).join(' '), Object.keys(ORD).join(' '), '[unk]');
      return out;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
