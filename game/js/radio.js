/* Голоса машинистов и дежурных: готовые звуковые фрагменты с «эфирной» обработкой либо системный синтезатор речи. */
(function (root) {
  'use strict';
  const M = root.M;
  const VOICES = ['d0', 'd1', 'd2'];

  M.radio = {
    mode: 'clips', vol: 0.8, ctx: null, index: null, bins: {}, cache: new Map(), queue: [], busy: false, hasClips: false, onBusy: null,

    async init() {
      try {
        const r = await fetch('voices/index.json');
        if (r.ok) { this.index = await r.json(); this.hasClips = true; }
      } catch (e) { this.index = null; }
      if (root.speechSynthesis) { try { root.speechSynthesis.getVoices(); } catch (e) { /* нет синтезатора */ } }
    },
    unlock() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    ruVoices() { try { return (root.speechSynthesis ? root.speechSynthesis.getVoices() : []).filter(v => /^ru/i.test(v.lang)); } catch (e) { return []; } },
    status() {
      if (this.mode === 'off') return 'Голоса выключены — ответы только текстом.';
      if (this.mode === 'clips') return this.hasClips ? 'Встроенные голоса загружены.' : 'Встроенные голоса не найдены — будет использован системный синтезатор.';
      return this.ruVoices().length ? 'Системный русский голос: ' + this.ruVoices()[0].name : 'В системе нет русского голоса — ответы только текстом.';
    },

    say(msg) {
      if (this.mode === 'off') return;
      this.queue.push(msg);
      if (this.queue.length > 5) this.queue.splice(0, this.queue.length - 5);
      this.pump();
    },
    setBusy(b) { this.busy = b; if (this.onBusy) this.onBusy(b); },
    async pump() {
      if (this.busy) return;
      const msg = this.queue.shift();
      if (!msg) return;
      this.setBusy(true);
      try {
        const ids = (msg.from === 'train' ? ['c.' + msg.num] : ['sc.' + msg.st]).concat(msg.clips);
        const voice = msg.from === 'train' ? VOICES[msg.voice % VOICES.length] : 'st';
        let done = false;
        if (this.mode === 'clips' && this.hasClips && this.ctx) done = await this.playClips(voice, ids, msg);
        if (!done) await this.speak(ids.map(M.phrase).join(' '), msg);
      } catch (e) { /* звук не обязателен */ }
      this.setBusy(false);
      if (this.queue.length) setTimeout(() => this.pump(), 180);
    },

    async bin(voice) {
      if (this.bins[voice]) return this.bins[voice];
      const r = await fetch('voices/' + voice + '.bin');
      if (!r.ok) throw new Error('no pack');
      return (this.bins[voice] = await r.arrayBuffer());
    },
    async clip(voice, id) {
      const key = voice + '/' + id;
      if (this.cache.has(key)) return this.cache.get(key);
      const v = this.index.voices[voice], loc = v && v.clips[id];
      if (!loc) return null;
      const buf = await this.bin(voice);
      const audio = await this.ctx.decodeAudioData(buf.slice(loc[0], loc[0] + loc[1]));
      this.cache.set(key, audio);
      if (this.cache.size > 260) this.cache.delete(this.cache.keys().next().value);
      return audio;
    },
    async playClips(voice, ids, msg) {
      const bufs = [];
      for (const id of ids) { const b = await this.clip(voice, id); if (!b) return false; bufs.push(b); }
      const ctx = this.ctx;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { return false; } }
      // тракт радиостанции: полосовой фильтр, лёгкое ограничение, шум эфира
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2900;
      const ws = ctx.createWaveShaper(), curve = new Float32Array(257);
      for (let i = 0; i < 257; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
      ws.curve = curve;
      const out = ctx.createGain(); out.gain.value = this.vol * 1.1;
      hp.connect(lp); lp.connect(ws); ws.connect(out); out.connect(ctx.destination);
      const rate = msg.from === 'train' ? 0.96 + ((msg.num * 37) % 9) / 100 : 1.0;
      let t = ctx.currentTime + 0.12;
      const t0 = t;
      for (let i = 0; i < bufs.length; i++) {
        const src = ctx.createBufferSource(); src.buffer = bufs[i]; src.playbackRate.value = rate; src.connect(hp); src.start(t);
        t += bufs[i].duration / rate + (i === 0 ? 0.22 : 0.12);
      }
      const nlen = Math.ceil((t - t0 + 0.3) * ctx.sampleRate), nb = ctx.createBuffer(1, nlen, ctx.sampleRate), nd = nb.getChannelData(0);
      for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
      const ns = ctx.createBufferSource(); ns.buffer = nb;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1700; nf.Q.value = 0.6;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t0 - 0.1); ng.gain.linearRampToValueAtTime(0.03 * this.vol, t0 - 0.06);
      ng.gain.setValueAtTime(0.03 * this.vol, t); ng.gain.linearRampToValueAtTime(0.14 * this.vol, t + 0.02); ng.gain.linearRampToValueAtTime(0.0001, t + 0.14);
      ns.connect(nf); nf.connect(ng); ng.connect(ctx.destination); ns.start(t0 - 0.1);
      await new Promise(res => setTimeout(res, (t - ctx.currentTime + 0.22) * 1000));
      return true;
    },
    speak(text, msg) {
      return new Promise(res => {
        const ss = root.speechSynthesis, vs = this.ruVoices();
        if (!ss || !vs.length || !root.SpeechSynthesisUtterance) return res();
        const u = new root.SpeechSynthesisUtterance(text);
        u.lang = 'ru-RU'; u.voice = vs[(msg.from === 'train' ? msg.voice : 1) % vs.length]; u.volume = this.vol;
        u.rate = 1.12; u.pitch = msg.from === 'train' ? 0.85 + (msg.num % 5) * 0.06 : 1.15;
        let fin = false; const end = () => { if (!fin) { fin = true; res(); } };
        u.onend = end; u.onerror = end; setTimeout(end, 12000);
        try { ss.speak(u); } catch (e) { end(); }
      });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
