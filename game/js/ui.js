/* Интерфейс: верхняя панель, списки, карточки поезда и станции, журнал радиообмена, меню. */
(function (root) {
  'use strict';
  const M = root.M;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KIND = {
    psd: 'мелкого заложения, боковые платформы, платформенные двери', closed: 'закрытого типа («горизонтальный лифт»)',
    column: 'колонная глубокого заложения', vault: 'односводчатая глубокого заложения', surface: 'наземная крытая, боковые платформы'
  };

  class UI {
    constructor(game) {
      this.g = game; this.objKey = ''; this.acc = 0; this.lastT = 0; this.modalCb = null;
      this.bind();
      this.syncSettings();
    }

    // ------------------------------------------------------------------ события
    bind() {
      const g = this.g;
      $('bPause').onclick = () => this.setPaused(!g.paused);
      $('bX1').onclick = () => this.set('speed', 1);
      $('bX12').onclick = () => this.set('speed', 12);
      $('bAsst').onclick = () => this.set('assistant', g.settings.assistant ? 0 : 1);
      $('bHelp').onclick = $('bHelp2').onclick = () => $('help').classList.add('on');
      $('bHelpClose').onclick = () => $('help').classList.remove('on');
      $('bMenu').onclick = () => this.openMenu();
      $('bStart').onclick = () => { M.radio.unlock(); g.start(); };
      $('bResume').onclick = () => { $('menu').classList.remove('on'); this.setPaused(false); };
      $('bFit').onclick = () => g.render.fit();
      $('bZoomIn').onclick = () => g.render.zoomAt(g.render.w / 2, g.render.h / 2, 1.6);
      $('bZoomOut').onclick = () => g.render.zoomAt(g.render.w / 2, g.render.h / 2, 1 / 1.6);
      $('bFollow').onclick = () => this.toggleFollow();
      $('bDepot').onclick = () => { const b = g.G.depotBox; if (b) { g.render.follow = false; g.render.flyTo((b[0][0] + b[2][0]) / 2 - 90, (b[0][1] + b[2][1]) / 2, 1.5); } };
      document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => this.showTab(b.dataset.tab); });
      document.querySelectorAll('.seg').forEach(seg => seg.querySelectorAll('button').forEach(b => {
        b.onclick = () => { const v = b.dataset.v; this.set(seg.dataset.set, /^\d+$/.test(v) ? +v : v); };
      }));
      document.querySelectorAll('.presets button').forEach(b => { b.onclick = () => { const t = +b.dataset.t; $('setHour').value = Math.floor(t); $('setMin').value = Math.round((t % 1) * 60); this.readTime(); }; });
      $('setHour').onchange = $('setMin').onchange = () => this.readTime();
      $('setVol').oninput = () => this.set('vol', +$('setVol').value);
      const cmd = $('cmd'), send = () => { const t = cmd.value.trim(); if (t) { this.command(t); cmd.value = ''; } };
      $('bSend').onclick = send;
      const mic = $('bMic');
      mic.addEventListener('mousedown', ev => { ev.preventDefault(); this.micDown(); });
      root.addEventListener('mouseup', () => M.mic.up());
      document.addEventListener('keydown', ev => {
        const tag = ev.target.tagName, inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        if (ev.code === 'Space' && !inInput) { ev.preventDefault(); if (!ev.repeat) this.micDown(); return; }
        if (ev.key === 'Enter') { if (ev.target === cmd) send(); else if (g.started && !document.querySelector('.overlay.on')) { cmd.focus(); ev.preventDefault(); } return; }
        if (ev.key === 'Escape') {
          if ($('help').classList.contains('on')) $('help').classList.remove('on');
          else if ($('modal').classList.contains('on')) this.closeModal();
          else if (inInput) ev.target.blur();
          else if ($('menu').classList.contains('on')) { if (g.started) $('bResume').click(); } else this.openMenu();
          return;
        }
        if (inInput || !g.started) return;
        if (ev.code === 'KeyP') this.setPaused(!g.paused);
        if (ev.code === 'KeyF') this.toggleFollow();
      });
      document.addEventListener('keyup', ev => { if (ev.code === 'Space') M.mic.up(); });
      $('tab-trains').addEventListener('mousedown', ev => {
        const tr = ev.target.closest('tr[data-n]'); if (!tr) return;
        const t = g.sim.trains[+tr.dataset.n - 1]; this.select({ type: 'train', tr: t }, true); this.focusTrain(t, ev.detail > 1);
      });
      $('tab-inc').addEventListener('mousedown', ev => {
        const d = ev.target.closest('.inc'); if (!d) return;
        const inc = g.sim.incidents.find(i => i.id === +d.dataset.id); if (inc) this.focusIncident(inc);
      });
      $('tab-obj').addEventListener('click', ev => this.objClick(ev));
      $('tab-obj').addEventListener('change', ev => { if (ev.target.id === 'zoneMode') this.zoneMode(+ev.target.dataset.st, ev.target.value === 'auto'); });
      M.mic.onPartial = t => { $('heard').textContent = t ? '… ' + t : ''; };
      M.mic.onFinal = t => { if (t) { $('heard').textContent = 'Распознано: «' + t + '»'; this.command(t); } else $('heard').textContent = 'Не расслышал — повторите.'; };
      M.mic.onState = () => this.micUI();
      M.radio.onBusy = b => { M.mic.muted = b && M.mic.mode === 'open'; };
    }
    micDown() {
      if (!this.g.started) return;
      M.radio.unlock();
      if (M.mic.engine === 'off') { this.toast('Распознавание речи выключено в меню. Команды можно вводить текстом.', 'warn'); return; }
      if (M.mic.state === 'off' || M.mic.state === 'error') { M.mic.enable(); return; }
      M.mic.down();
    }
    micUI() {
      const b = $('bMic'), m = M.mic;
      b.className = m.state === 'loading' ? 'loading' : m.state === 'ready' ? (m.talking || m.mode === 'open' ? 'live' : 'ready') : '';
      $('micLabel').textContent = m.state === 'loading' ? 'Загрузка…' : m.state === 'error' ? 'Нет микрофона' : m.state === 'ready' ? (m.mode === 'open' ? 'Слушаю' : m.talking ? 'В эфире' : 'Эфир (пробел)') : m.engine === 'off' ? 'Микрофон выкл.' : 'Включить микрофон';
      b.title = m.statusText();
      $('micStatus').textContent = m.statusText() + ' ' + M.radio.status();
      if (m.state === 'error' && this.lastMicErr !== m.error) { this.lastMicErr = m.error; this.toast('Микрофон недоступен: ' + m.error + '. Команды можно вводить текстом.', 'bad'); }
    }

    // ------------------------------------------------------------------ настройки
    set(key, v) {
      const g = this.g, s = g.settings;
      s[key] = v; g.saveSettings();
      const sim = g.sim;
      if (key === 'speed') g.speed = v;
      if (sim) {
        if (key === 'incidents') sim.opts.incidents = v;
        if (key === 'assistant') sim.opts.assistant = !!v;
        if (key === 'regulate') sim.opts.regulate = !!v;
        if (key === 'autoSwitch') { for (const z of sim.G.zones) z.auto = !!v; this.objKey = ''; }
      }
      if (key === 'engine' || key === 'micMode') { M.mic.configure(s.engine, s.micMode).then(() => { if (g.started && s.engine !== 'off') M.mic.enable(); this.micUI(); }); }
      if (key === 'voice') M.radio.mode = v;
      if (key === 'vol') M.radio.vol = v / 100;
      this.syncSettings();
    }
    readTime() { const s = this.g.settings; s.hour = M.clamp(parseInt($('setHour').value, 10) || 0, 0, 23); s.min = M.clamp(parseInt($('setMin').value, 10) || 0, 0, 59); this.g.saveSettings(); this.syncSettings(); }
    syncSettings() {
      const s = this.g.settings;
      document.querySelectorAll('.seg').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(s[seg.dataset.set]) === b.dataset.v)));
      $('setHour').value = M.pad2(s.hour); $('setMin').value = M.pad2(s.min); $('setVol').value = s.vol;
      $('bX1').classList.toggle('on', s.speed === 1); $('bX12').classList.toggle('on', s.speed === 12);
      $('bAsst').textContent = 'Помощник графика: ' + (s.assistant ? 'вкл' : 'выкл'); $('bAsst').classList.toggle('on', !!s.assistant);
      M.radio.mode = s.voice; M.radio.vol = s.vol / 100;
      this.micUI();
    }
    openMenu() {
      const g = this.g;
      if (g.started) { this.setPaused(true); $('bResume').classList.remove('hidden'); $('bStart').textContent = 'Начать заново'; $('bStart').classList.remove('primary'); $('bResume').classList.add('primary'); }
      $('menu').classList.add('on');
    }
    setPaused(p) { this.g.paused = p; $('bPause').classList.toggle('on', p); $('bPause').textContent = p ? '▶' : '❚❚'; }
    showTab(name) {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
      this.acc = 1;
    }
    toggleFollow() { const r = this.g.render; r.follow = !r.follow && !!(this.g.sel && this.g.sel.type === 'train'); if (r.follow && r.cam.k < 0.6) r.fly = { x: r.cam.x, y: r.cam.y, k: 1.2 }; }

    // ------------------------------------------------------------------ выбор и команды
    select(sel, keepTab) { this.g.sel = sel; this.objKey = ''; if (!keepTab) this.showTab('obj'); this.acc = 1; }
    selTrain() { const s = this.g.sel; return s && s.type === 'train' ? s.tr : null; }
    focusTrain(tr, zoom) { const p = this.g.sim.trainXY(tr), r = this.g.render; r.follow = false; r.flyTo(p.x, p.y, zoom ? Math.max(r.cam.k, 1.6) : Math.max(r.cam.k, 0.3)); }
    focusIncident(inc) {
      const r = this.g.render; r.follow = false;
      if (inc.x || inc.y) r.flyTo(inc.x, inc.y, Math.max(r.cam.k, 0.9));
      if (inc.tr) this.select({ type: 'train', tr: inc.tr }, true); else if (inc.st != null) this.select({ type: 'station', st: inc.st }, true);
    }
    command(text) { if (!this.g.sim || !this.g.started) return; M.cmd.run(this.g.sim, text, this.selTrain()); this.drain(); }
    clickSwitch(sw, shift) {
      const sim = this.g.sim, name = 'Стрелка № ' + sw.name + ' ст. ' + M.LINE.stations[sw.zone].short;
      const r = sim.throwSwitch(sw, false);
      if (r.ok) { this.log('sys', '', name + ' переводится ' + (sw.target === 'plus' ? 'по прямому пути' : 'на отклонение') + '.'); return; }
      if (r.locked && shift) {
        this.modal('Аварийный перевод стрелки', name + ': ' + r.why.toLowerCase() + '. Перевод стрелки перед поездом или под ним приведёт к проезду запрещающего сигнала, взрезу или сходу. Перевести?', [
          { label: 'Перевести', cls: 'danger', fn: () => { const q = sim.throwSwitch(sw, true); if (q.ok) this.log('bad', '', name + ': аварийный перевод.'); } }, { label: 'Отмена' }]);
        return;
      }
      this.toast(name + ': ' + r.why + (r.locked ? '. Shift + щелчок — аварийный перевод.' : '.'), 'warn');
    }
    zoneMode(st, auto) { this.g.sim.G.zones[st].auto = auto; this.log('sys', '', 'Ст. ' + M.LINE.stations[st].short + ': стрелки — ' + (auto ? 'автоматика' : 'ручное управление') + '.'); this.objKey = ''; }

    // ------------------------------------------------------------------ сообщения модели
    drain() {
      const sim = this.g.sim; if (!sim || !sim.outbox.length) return;
      const box = sim.outbox.splice(0), S = M.LINE.stations;
      for (const m of box) {
        if (m.type === 'radio') {
          const text = m.clips.map(M.phrase).join(' ') + (m.extra ? ' ' + m.extra : '');
          if (m.from === 'train') this.log('trn', 'Маршрут ' + m.num, text, m.t); else this.log('stn', 'Ст. ' + S[m.st].short, text, m.t);
          M.radio.say(m);
        } else if (m.type === 'disp') this.log('disp', 'Диспетчер', m.text, m.t);
        else if (m.type === 'sys' || m.type === 'auto') this.log('sys', '', m.text, m.t);
        else if (m.type === 'toast') this.toast(m.text, m.level);
        else if (m.type === 'incident') {
          const inc = sim.incidents.find(i => i.id === m.id);
          this.log(m.level === 'bad' ? 'bad' : 'sys', 'ЧП', m.title + '. ' + m.text, m.t);
          this.toast('<b>' + esc(m.title) + '</b>' + esc(m.text), m.level === 'bad' ? 'bad' : 'warn', inc, true);
        } else if (m.type === 'incidentEnd') this.log('sys', '', 'Устранено: ' + m.title.toLowerCase() + '.', m.t);
        else if (m.type === 'attention') { const tr = sim.trains[m.num - 1]; this.toast('Маршрут ' + m.num + ' ждёт указаний (' + sim.stateText(tr) + ').', 'warn', { tr }); }
        else if (m.type === 'crash') {
          this.log('bad', 'АВАРИЯ', m.text, m.t); this.setPaused(true);
          this.modal(m.kind === 'collision' ? 'Столкновение поездов' : m.kind === 'derail' ? 'Сход подвижного состава' : 'Наезд на тупиковый упор',
            m.text + ' Движение на участке закрыто до окончания восстановительных работ (около 50 минут). Смена продолжается.',
            [{ label: 'Показать место', cls: 'primary', fn: () => { this.g.render.follow = false; this.g.render.flyTo(m.x, m.y, 2.2); this.setPaused(false); } }, { label: 'Продолжить', fn: () => this.setPaused(false) }]);
        }
      }
      this.acc = 1;
    }
    log(cls, who, text, t) {
      const el = $('log'), d = document.createElement('div');
      d.className = cls;
      d.innerHTML = '<span class="tm">' + M.fmtClock(t != null ? t : (this.g.sim ? this.g.sim.t : 0), true) + '</span>' + (who ? '<b>' + esc(who) + ':</b> ' : '') + esc(text);
      const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
      el.appendChild(d);
      while (el.children.length > 250) el.removeChild(el.firstChild);
      if (stick) el.scrollTop = el.scrollHeight;
    }
    toast(html, level, focus, raw) {
      const d = document.createElement('div');
      d.className = 'toast ' + (level || '');
      if (raw) d.innerHTML = html; else d.textContent = html;
      d.onclick = () => { if (focus) { if (focus.tr && !focus.id) { this.select({ type: 'train', tr: focus.tr }); this.focusTrain(focus.tr, true); } else this.focusIncident(focus); } d.remove(); };
      const box = $('toasts'); box.appendChild(d);
      while (box.children.length > 4) box.removeChild(box.firstChild);
      setTimeout(() => d.remove(), 9000);
    }
    modal(title, text, btns) {
      $('modalTitle').textContent = title; $('modalText').textContent = text;
      const box = $('modalBtns'); box.innerHTML = '';
      for (const b of btns) { const el = document.createElement('button'); el.textContent = b.label; if (b.cls) el.className = b.cls; el.onclick = () => { $('modal').classList.remove('on'); if (b.fn) b.fn(); }; box.appendChild(el); }
      $('modal').classList.add('on');
    }
    closeModal() { $('modal').classList.remove('on'); }

    // ------------------------------------------------------------------ периодическое обновление
    tick() {
      const now = performance.now();
      this.acc += (now - this.lastT) / 1000; this.lastT = now;
      if (this.acc < 0.4) return;
      this.acc = 0;
      const g = this.g, sim = g.sim; if (!sim) return;
      $('clock').textContent = M.fmtClock(sim.t, true);
      const per = M.periodName(sim.t); $('period').textContent = per; $('period').classList.toggle('peak', /пик/.test(per));
      const st = sim.stats, n = sim.inService(), rec = sim.recommended();
      $('sLine').textContent = n; $('sRec').textContent = 'по графику ' + rec; $('sLine').style.color = Math.abs(n - rec) > 3 ? '#f4c430' : '';
      $('sWait').textContent = M.fmtInt(st.waiting); $('sBoard').textContent = M.fmtInt(st.onBoard); $('sDel').textContent = M.fmtInt(st.delivered);
      $('sAvg').textContent = st.avgWait > 0 ? M.fmtDur(st.avgWait) : '—';
      $('bFollow').classList.toggle('on', g.render.follow);
      const k = g.render.cam.k;
      $('hint').textContent = k < 0.12 ? 'Колесо мыши — приблизить. Щелчок по ленте сверху — перейти к месту на линии.' : k < 0.9 ? 'Приблизьте ещё, чтобы увидеть вагоны и пассажиров.' : '';
      const act = sim.incidents.filter(i => !i.done).length; $('incCount').textContent = act || '';
      if ($('tab-trains').classList.contains('on')) this.renderTrains();
      if ($('tab-obj').classList.contains('on')) this.renderObj();
      if ($('tab-inc').classList.contains('on')) this.renderInc();
    }
    renderTrains() {
      const sim = this.g.sim, sel = this.selTrain();
      let h = '<table class="tl"><tr><th>№</th><th>Состояние</th><th>Где</th><th>Пасс.</th><th>Задание</th></tr>';
      for (const tr of sim.trains) {
        const cls = tr.mode === 'crashed' || tr.fault || tr.status === 'repair' ? 'fault' : tr.status === 'maint' ? 'maint' : tr.mode === 'parked' ? 'park' : (tr.v < 0.1 && tr.phase === 'move' && tr.waitT > 5 ? 'wait' : '');
        h += '<tr data-n="' + tr.num + '"' + (tr === sel ? ' class="sel"' : '') + '><td><span class="num ' + cls + '">' + tr.num + '</span></td><td>' + esc(sim.stateText(tr)) + '</td><td>' + esc(sim.where(tr)) + '</td><td>' + (tr.mode === 'service' ? Math.round(tr.loadTot) : '') + '</td><td class="dimtxt">' + esc(sim.taskText(tr)) + '</td></tr>';
      }
      $('tab-trains').innerHTML = h + '</table>';
    }
    renderInc() {
      const sim = this.g.sim, list = sim.incidents.slice().reverse().slice(0, 30);
      let h = list.length ? '' : '<p class="dimtxt">Нештатных ситуаций нет.</p>';
      for (const i of list) h += '<div class="inc ' + (i.level === 'bad' || i.type === 'crash' ? 'bad ' : '') + (i.done ? 'done' : '') + '" data-id="' + i.id + '"><b>' + esc(i.title) + '</b>' + esc(i.text) + '<br><small>' + M.fmtClock(i.t0) + (i.done ? ' · устранено' : ' · щёлкните, чтобы показать на карте') + '</small></div>';
      $('tab-inc').innerHTML = h;
    }

    // ------------------------------------------------------------------ карточка объекта
    renderObj() {
      const sel = this.g.sel, el = $('tab-obj'), sim = this.g.sim, S = M.LINE.stations;
      const setT = (id, t) => { const e = $(id); if (e && e.textContent !== t) e.textContent = t; };
      if (!sel) { if (this.objKey !== 'none') { this.objKey = 'none'; el.innerHTML = '<p class="dimtxt">Щёлкните по поезду, станции или стрелке на карте. Поезд можно выбрать и в списке «Поезда».</p>'; } return; }
      if (sel.type === 'train') {
        const tr = sel.tr, key = 'train:' + tr.num + ':' + tr.mode;
        if (key !== this.objKey) { this.objKey = key; el.innerHTML = this.trainHTML(tr); }
        setT('oState', sim.stateText(tr)); setT('oWhere', sim.where(tr)); setT('oTask', sim.taskText(tr) || '—');
        setT('oPax', Math.round(tr.loadTot) + ' из ' + M.TRAIN.TRAIN_CAP + ' · по вагонам: ' + Array.from(tr.car).map(Math.round).join(' / '));
        setT('oSpeed', Math.round(tr.v * 3.6) + ' км/ч' + (tr.limit ? ' (ограничение ' + Math.round(tr.limit * 3.6) + ')' : ''));
        setT('oGrade', Math.abs(tr.grade) < 0.0015 ? 'площадка' : (tr.grade > 0 ? 'подъём ' : 'спуск ') + Math.abs(tr.grade * 1000).toFixed(0) + ' ‰');
        setT('oKm', tr.km.toFixed(0) + ' км' + (tr.km >= tr.nextTO ? ' — пора на техобслуживание' : ''));
      } else {
        const st = sel.st, key = 'st:' + st + ':' + (sim.stn[st].closed ? 1 : 0) + ':' + (sim.G.zones[st].auto ? 1 : 0);
        if (key !== this.objKey) { this.objKey = key; el.innerHTML = this.stationHTML(st); }
        const w = sim.waitDir(st), X = sim.stn[st];
        setT('sWA', String(Math.round(w[0]))); setT('sWB', String(Math.round(w[1])));
        setT('sHw', (X.hw.A ? M.fmtDur(X.hw.A) : '—') + ' / ' + (X.hw.B ? M.fmtDur(X.hw.B) : '—'));
        for (const sw of sim.G.zones[st].sw) {
          setT('swp' + sw.id, sw.broken ? 'неисправна' : sw.moving ? 'переводится…' : sw.pos === 'plus' ? 'по прямому пути' : 'на отклонение');
          const p = $('swl' + sw.id); if (p) { p.textContent = sw.node.res ? 'замкнута, м. ' + sw.node.res.num : 'свободна'; p.className = 'pill ' + (sw.node.res ? 'y' : 'g'); }
        }
      }
    }
    trainHTML(tr) {
      const S = M.LINE.stations, G = this.g.G, parked = tr.mode === 'parked';
      const opt = (list, f) => list.map(i => '<option value="' + esc(S[i].name) + '">' + esc(S[i].short) + '</option>').join('') + (f || '');
      const turnSt = []; for (let i = 0; i < S.length; i++) if (G.turn[i].A || G.turn[i].B) turnSt.push(i);
      const sidSt = Array.from(new Set(G.sidings.map(s => s.st)));
      const all = S.map((s, i) => i);
      const cls = tr.mode === 'crashed' || tr.fault || tr.status === 'repair' ? 'fault' : tr.status === 'maint' ? 'maint' : '';
      let h = '<div class="objhead"><span class="num ' + cls + '" style="font-size:16px;padding:2px 8px">' + tr.num + '</span><h2>Маршрут ' + tr.num + '</h2><span class="spacer"></span><button data-act="show">Показать</button><button data-act="follow">Следить</button></div>';
      h += '<div class="kv"><span>Состояние</span><b id="oState"></b><span>Местоположение</span><div id="oWhere"></div><span>Задание</span><div id="oTask"></div><span>Пассажиры</span><div id="oPax"></div><span>Скорость</span><div id="oSpeed"></div><span>Профиль пути</span><div id="oGrade"></div><span>Пробег</span><div id="oKm"></div></div>';
      if (tr.mode === 'crashed' || tr.mode === 'gone') return h + '<p class="dimtxt">Состав повреждён, идут восстановительные работы.</p>';
      h += '<h4>Приказы машинисту</h4><div class="btns">';
      if (parked) h += '<button class="primary" data-cmd="выходите на линию">Выходите на линию</button><button data-cmd="следуйте в депо">В депо</button>';
      else {
        h += '<button data-cmd="отправляйтесь">Отправляйтесь</button><button data-cmd="стоп">Стоп</button><button data-cmd="продолжайте движение">Продолжайте движение</button><button data-cmd="задержитесь">Задержитесь на станции</button>';
        h += '<button data-cmd="высадите пассажиров">Высадите пассажиров</button><button data-cmd="следуйте в депо">В депо</button>';
      }
      h += '<button data-cmd="доложите обстановку">Доложите обстановку</button></div>';
      h += '<div class="btns" style="margin-top:6px"><button data-cmd="следуйте в тупик" data-sel="selSid" data-pre=" станции ">В тупик</button><select id="selSid"><option value="">ближайший свободный</option>' + opt(sidSt) + '</select></div>';
      if (!parked) {
        h += '<div class="btns" style="margin-top:6px"><button data-cmd="следуйте до станции" data-sel="selDest" data-pre=" ">До станции (оборот)</button><select id="selDest">' + opt(turnSt) + '</select></div>';
        h += '<div class="btns" style="margin-top:6px"><button data-cmd="проследуйте без остановки станцию" data-sel="selSkip" data-pre=" ">Без остановки</button><select id="selSkip">' + opt(all) + '</select></div>';
        h += '<div class="btns" style="margin-top:6px"><button data-cmd="скорость не более" data-sel="selV" data-pre=" ">Ограничить скорость</button><select id="selV"><option>20</option><option>30</option><option selected>40</option><option>50</option><option>60</option><option>70</option></select><button data-cmd="отмена ограничения скорости">Снять</button></div>';
        h += '<div class="btns" style="margin-top:10px"><button class="danger" data-cmd="проследуйте запрещающий сигнал" title="Поезд пойдёт без защиты АЛС-АРС со скоростью до 20 км/ч">Проследуйте запрещающий сигнал</button><button data-cmd="отмена">Отмена приказов</button></div>';
      }
      return h + '<p class="note" style="margin-top:10px">Те же приказы можно отдать голосом: «Маршрут ' + M.numWords(tr.num) + ', …».</p>';
    }
    stationHTML(st) {
      const S = M.LINE.stations, info = S[st], sim = this.g.sim, G = sim.G, z = G.zones[st], X = sim.stn[st];
      const f = M.LINE.features.filter(x => x.st === st), nb = d => S[M.clamp(st + d, 0, S.length - 1)].short;
      const desc = f.map(x => x.t === 'termLo' ? 'Перекрёстный съезд и два оборотных тупика за станцией.' : x.t === 'termHi' ? 'Перекрёстный съезд, оборотные тупики и соединительный путь в депо «Невское».'
        : x.t === 'scissors' ? 'Перекрёстный съезд со стороны ст. ' + nb(x.side) + '.' : 'Оборотный тупик (3 путь) со стороны ст. ' + nb(x.side) + (x.ssv ? '; ' + x.ssv + '.' : '.')).join(' ') || 'Путевого развития нет — оборот невозможен.';
      let h = '<div class="objhead"><span class="m3">3</span><h2>' + esc(info.name) + '</h2><span class="spacer"></span><button data-act="showSt">Показать</button></div>';
      h += '<div class="kv"><span>Тип станции</span><div>' + KIND[info.kind] + (info.depth ? ', глубина ' + info.depth + ' м' : '') + '</div>';
      if (info.xfer) h += '<span>Пересадка</span><div>' + info.xfer.map(x => '<span class="xf" style="background:' + x.color + '">' + x.line + '</span>' + esc(x.name)).join(' ') + '</div>';
      h += '<span>Ждут на I пути</span><div><b id="sWA"></b> — к «Рыбацкому»</div><span>Ждут на II пути</span><div><b id="sWB"></b> — к «Беговой»</div><span>Интервал I / II</span><div id="sHw"></div>';
      h += '<span>Состояние</span><div>' + (X.closed ? '<span class="pill r">закрыта, поезда следуют без остановки</span>' : '<span class="pill g">открыта</span>') + '</div></div>';
      h += '<div class="btns" style="margin-top:8px"><button data-act="closeSt" class="' + (X.closed ? 'primary' : 'danger') + '">' + (X.closed ? 'Открыть станцию' : 'Закрыть станцию') + '</button></div>';
      h += '<h4>Путевое развитие</h4><p class="note">' + esc(desc) + '</p>';
      if (z.sw.length) {
        h += '<div class="swrow"><span class="grow">Управление стрелками</span><select id="zoneMode" data-st="' + st + '"><option value="auto"' + (z.auto ? ' selected' : '') + '>автоматика</option><option value="man"' + (z.auto ? '' : ' selected') + '>ручное</option></select></div>';
        for (const sw of z.sw) h += '<div class="swrow"><span>Стрелка № ' + sw.name + '</span><span class="grow dimtxt" id="swp' + sw.id + '"></span><span class="pill" id="swl' + sw.id + '"></span><button data-sw="' + sw.id + '">Перевести</button></div>';
        h += '<p class="note">' + (z.auto ? 'Автоматика сама готовит маршруты прибывающим поездам.' : 'Ручной режим: поезд остановится у светофора и запросит маршрут. Нужная стрелка мигает на карте голубым.') + ' Стрелку можно перевести и щелчком по ней на карте.</p>';
      }
      return h;
    }
    objClick(ev) {
      const b = ev.target.closest('button'); if (!b) return;
      const g = this.g, sim = g.sim, sel = g.sel; if (!sel) return;
      if (b.dataset.sw) { const sw = sim.G.sw[+b.dataset.sw]; this.clickSwitch(sw, ev.shiftKey); return; }
      if (sel.type === 'train') {
        const tr = sel.tr;
        if (b.dataset.act === 'show') return this.focusTrain(tr, true);
        if (b.dataset.act === 'follow') { this.focusTrain(tr, true); g.render.follow = true; return; }
        if (b.dataset.cmd) {
          let t = b.dataset.cmd;
          if (b.dataset.sel) { const v = $(b.dataset.sel).value; if (v) t += b.dataset.pre + v; }
          this.command('Маршрут ' + tr.num + ', ' + t);
        }
      } else {
        const st = sel.st;
        if (b.dataset.act === 'showSt') { const s = sim.G.st[st]; g.render.follow = false; g.render.flyTo(s.x, s.y, Math.max(g.render.cam.k, 1.4)); }
        if (b.dataset.act === 'closeSt') {
          const X = sim.stn[st]; X.closed = !X.closed;
          this.log('disp', 'Диспетчер', 'Станция ' + M.LINE.stations[st].name + (X.closed ? ' закрыта для пассажиров, поезда следуют без остановки.' : ' открыта.'));
          this.objKey = '';
        }
      }
    }
  }
  M.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
