/* Микрофон диспетчера. Два движка распознавания: встроенный офлайн (Vosk, WebAssembly) и системный (Web Speech API). */
(function (root) {
  'use strict';
  const M = root.M;

  M.mic = {
    engine: 'vosk', mode: 'ptt', state: 'off', error: '', talking: false, muted: false,
    onFinal: null, onPartial: null, onState: null,
    stream: null, actx: null, model: null, rec: null, parts: [], web: null, webWanted: false, tailT: 0,

    set(state, error) { this.state = state; this.error = error || ''; if (this.onState) this.onState(state, this.error); },
    statusText() {
      const e = this.engine === 'vosk' ? 'встроенное распознавание' : 'системное распознавание';
      switch (this.state) {
        case 'off': return this.engine === 'off' ? 'Распознавание речи выключено — команды текстом и кнопками.' : 'Микрофон включится после начала смены.';
        case 'loading': return 'Загрузка модели распознавания речи…';
        case 'ready': return 'Микрофон готов (' + e + '). ' + (this.mode === 'ptt' ? 'Удерживайте пробел и говорите.' : 'Слушаю постоянно.');
        case 'error': return 'Микрофон недоступен: ' + this.error;
      }
      return '';
    },

    async configure(engine, mode) {
      const changed = engine !== this.engine;
      this.engine = engine; this.mode = mode;
      if (changed || engine === 'off') this.shutdown();
      if (engine === 'off') { this.set('off'); return; }
      if (this.state === 'ready') { this.applyMode(); this.set('ready'); }
    },
    shutdown() {
      this.talking = false;
      if (this.web) { this.webWanted = false; try { this.web.abort(); } catch (e) { /* уже остановлено */ } this.web = null; }
      if (this.rec) { try { this.rec.remove(); } catch (e) { /* нет распознавателя */ } this.rec = null; }
      if (this.proc) { try { this.proc.disconnect(); this.src.disconnect(); } catch (e) { /* не подключено */ } this.proc = null; }
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      if (this.actx) { try { this.actx.close(); } catch (e) { /* закрыт */ } this.actx = null; }
      if (this.state !== 'off') this.set('off');
    },

    /** Включить микрофон (нужен жест пользователя). */
    async enable() {
      if (this.engine === 'off' || this.state === 'ready' || this.state === 'loading') return;
      this.set('loading');
      try {
        if (this.engine === 'web') await this.enableWeb(); else await this.enableVosk();
        this.set('ready'); this.applyMode();
      } catch (e) {
        const msg = e && e.name === 'NotAllowedError' ? 'нет разрешения на доступ к микрофону' : e && e.name === 'NotFoundError' ? 'микрофон не найден' : (e && e.message) || String(e);
        this.shutdown(); this.set('error', msg);
      }
    },
    loadScript(src) {
      return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('не найден файл ' + src)); document.head.appendChild(s); });
    },
    async enableVosk() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('браузер не даёт доступа к микрофону');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
      if (!root.Vosk) await this.loadScript('vendor/vosk.js');
      if (!this.model) this.model = await root.Vosk.createModel('vosk/model-ru.tar.gz');
      const AC = root.AudioContext || root.webkitAudioContext;
      try { this.actx = new AC({ sampleRate: 16000 }); } catch (e) { this.actx = new AC(); }
      const sr = this.actx.sampleRate;
      this.rec = new this.model.KaldiRecognizer(sr, JSON.stringify(M.cmd.grammar()));
      this.rec.on('result', m => this.voskResult((m.result && m.result.text) || ''));
      this.rec.on('partialresult', m => { if (this.listening() && this.onPartial) this.onPartial(this.clean(this.parts.concat([(m.result && m.result.partial) || '']).join(' '))); });
      this.src = this.actx.createMediaStreamSource(this.stream);
      this.proc = this.actx.createScriptProcessor(4096, 1, 1);
      const mute = this.actx.createGain(); mute.gain.value = 0;
      this.proc.onaudioprocess = ev => {
        if (!this.rec || !this.listening()) return;
        try { this.rec.acceptWaveformFloat(new Float32Array(ev.inputBuffer.getChannelData(0)), sr); } catch (e) { /* распознаватель занят */ }
      };
      this.src.connect(this.proc); this.proc.connect(mute); mute.connect(this.actx.destination);
    },
    listening() {
      if (this.muted) return false;
      const now = Date.now();
      return this.mode === 'open' || this.talking || now < this.tailT;
    },
    clean(t) { return String(t || '').replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim(); },
    voskResult(text) {
      text = this.clean(text);
      if (this.mode === 'ptt') { if (text) this.parts.push(text); if (this.flushWanted) this.flush(); return; }
      if (!text) return;
      // постоянное прослушивание: пауза внутри команды не должна её разрывать
      this.parts.push(text);
      clearTimeout(this.openT);
      const joined = this.parts.join(' ');
      const p = M.cmd.parse(joined);
      if (p.intent && (p.num != null || p.all)) { this.parts = []; this.final(joined); } else this.openT = setTimeout(() => { const j = this.parts.join(' '); this.parts = []; if (M.cmd.parse(j).intent) this.final(j); }, 2500);
    },
    flush() {
      this.flushWanted = false;
      const t = this.parts.join(' '); this.parts = [];
      this.final(t);
    },
    final(t) { t = this.clean(t); if (this.onPartial) this.onPartial(''); if (this.onFinal) this.onFinal(t); },

    async enableWeb() {
      const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
      if (!SR) throw new Error('в этом браузере нет системного распознавания речи (нужен Edge или Chrome и интернет)');
      const r = new SR();
      r.lang = 'ru-RU'; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
      r.onresult = ev => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i], txt = res[0].transcript;
          if (res.isFinal) { if (this.mode === 'ptt') this.parts.push(txt); else if (!this.muted) this.final(txt); } else interim += txt;
        }
        if (this.onPartial) this.onPartial(this.clean(this.parts.join(' ') + ' ' + interim));
      };
      r.onerror = ev => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { this.webWanted = false; this.set('error', 'нет разрешения на доступ к микрофону'); } else if (ev.error === 'network') { this.webWanted = false; this.set('error', 'системному распознаванию нужен интернет'); } };
      r.onend = () => {
        this.webOn = false;
        if (this.mode === 'ptt') { if (this.flushWanted) this.flush(); } else if (this.webWanted) setTimeout(() => this.webStart(), 250);
      };
      this.web = r;
    },
    webStart() { if (!this.web || this.webOn) return; try { this.web.start(); this.webOn = true; } catch (e) { /* уже запущено */ } },
    applyMode() {
      this.parts = [];
      if (this.engine === 'web' && this.web) { this.webWanted = this.mode === 'open'; if (this.webWanted) this.webStart(); else { try { this.web.stop(); } catch (e) { /* не запущено */ } } }
    },

    /** Нажатие и отпускание тангенты (режим рации). */
    down() {
      if (this.state !== 'ready' || this.mode !== 'ptt' || this.talking) return;
      this.talking = true; this.parts = []; this.flushWanted = false;
      if (this.engine === 'web') this.webStart();
      if (this.onState) this.onState('ready');
    },
    up() {
      if (!this.talking) return;
      this.talking = false;
      if (this.onState) this.onState('ready');
      if (this.engine === 'web') { this.flushWanted = true; try { this.web.stop(); } catch (e) { this.flush(); } setTimeout(() => { if (this.flushWanted) this.flush(); }, 1500); return; }
      // ещё немного звука после отпускания, затем запрос окончательного результата
      this.tailT = Date.now() + 350;
      setTimeout(() => { this.flushWanted = true; try { this.rec.retrieveFinalResult(); } catch (e) { this.flush(); } setTimeout(() => { if (this.flushWanted) this.flush(); }, 1200); }, 380);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
