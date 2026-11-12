/* Запуск игры и главный цикл. */
(function (root) {
  'use strict';
  const M = root.M;
  const DEF = { speed: 12, hour: 7, min: 0, incidents: 2, autoSwitch: 1, assistant: 0, regulate: 1, engine: 'vosk', micMode: 'ptt', voice: 'clips', vol: 80 };
  const KEY = 'metro3.settings.v1';
  function load() {
    try { return Object.assign({}, DEF, JSON.parse(root.localStorage.getItem(KEY) || '{}')); } catch (e) { return Object.assign({}, DEF); }
  }
  const q = new URLSearchParams(root.location.search);
  const game = M.game = { G: null, sim: null, render: null, ui: null, speed: 12, paused: true, started: false, sel: null, settings: load() };
  game.saveSettings = function () { try { root.localStorage.setItem(KEY, JSON.stringify(game.settings)); } catch (e) { /* хранилище недоступно */ } };
  for (const k of ['speed', 'hour', 'min', 'incidents', 'autoSwitch', 'assistant', 'regulate']) if (q.has(k)) game.settings[k] = +q.get(k);
  for (const k of ['engine', 'micMode', 'voice']) if (q.has(k)) game.settings[k] = q.get(k);
  game.speed = game.settings.speed;

  game.newSim = function () {
    const s = game.settings;
    game.sim = new M.Sim(game.G, {
      startTime: s.hour * 3600 + s.min * 60, incidents: s.incidents, autoSwitch: !!s.autoSwitch, assistant: !!s.assistant, regulate: !!s.regulate,
      seed: q.has('seed') ? +q.get('seed') : (Date.now() & 0x7fffffff)
    });
    game.sel = null;
  };
  game.start = function () {
    game.newSim();
    game.started = true; game.speed = game.settings.speed;
    document.getElementById('menu').classList.remove('on');
    document.getElementById('log').innerHTML = '';
    game.ui.objKey = ''; game.ui.setPaused(false);
    const s = game.sim;
    game.ui.log('sys', '', 'Смена начата в ' + M.fmtClock(s.t) + '. На линии ' + s.inService() + ' поездов, по графику — ' + s.recommended() + '. ' +
      (game.settings.autoSwitch ? 'Стрелки на автоматике.' : 'Стрелки на ручном управлении.'));
    if (s.inService() === 0) game.ui.log('sys', '', 'Все составы в депо и тупиках. Выпускайте поезда приказом «Маршрут …, выходите на линию» или включите помощника графика.');
    M.mic.configure(game.settings.engine, game.settings.micMode).then(() => { if (game.settings.engine !== 'off') M.mic.enable(); });
  };

  game.G = M.buildGraph(M.GEO, M.LINE);
  game.newSim();
  game.ui = new M.UI(game);
  game.render = new M.Render(game);
  M.radio.init().then(() => game.ui.micUI());
  M.mic.engine = game.settings.engine; M.mic.mode = game.settings.micMode;

  let last = performance.now();
  setInterval(function () {
    const now = performance.now(); let real = (now - last) / 1000; last = now;
    if (!game.started || game.paused || !game.sim) return;
    real = Math.min(real, 1.5);
    const simT = real * game.speed, n = Math.max(1, Math.ceil(simT / 0.25)), dt = simT / n;
    for (let i = 0; i < n; i++) game.sim.step(dt);
    game.ui.drain();
  }, 33);
  function frame() {
    game.render.draw();
    game.ui.tick();
    root.requestAnimationFrame(frame);
  }
  root.requestAnimationFrame(frame);

  // сигнал запускающей программе, что окно игры открыто
  try { const es = new root.EventSource('api/alive'); es.onerror = function () { /* сервер остановлен — игра продолжает работать */ }; } catch (e) { /* открыто без сервера */ }

  if (q.has('autostart')) game.start();
})(typeof window !== 'undefined' ? window : globalThis);
