/* Общие утилиты: математика, ломаные, проекция, форматирование. */
(function (root) {
  'use strict';
  const M = root.M = root.M || {};

  M.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  M.lerp = (a, b, t) => a + (b - a) * t;
  M.smooth = t => { t = M.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  M.pad2 = n => (n < 10 ? '0' : '') + n;

  M.mulberry = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  M.fmtClock = function (t, withSec) {
    t = ((t % 86400) + 86400) % 86400;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    return M.pad2(h) + ':' + M.pad2(m) + (withSec ? ':' + M.pad2(s) : '');
  };
  M.fmtDur = function (s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' с';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + ' мин' + (r && m < 10 ? ' ' + r + ' с' : '');
    return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
  };
  M.fmtInt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');

  // Равнопромежуточная проекция вокруг центра города: метры, ось Y вниз (как на экране).
  const LAT0 = 59.92, LON0 = 30.35;
  const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111400;
  M.proj = ll => [(ll[0] - LON0) * KX, -(ll[1] - LAT0) * KY];

  class Poly {
    constructor(pts) {
      this.p = pts;
      const cum = new Float64Array(pts.length);
      for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      this.cum = cum;
      this.len = cum[pts.length - 1];
    }
    _seg(d) {
      const c = this.cum; let lo = 0, hi = c.length - 1;
      if (d <= 0) return 0;
      if (d >= this.len) return hi - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
      return lo;
    }
    /** Точка и касательная на расстоянии d от начала. За концами — прямое продолжение. */
    at(d) {
      const i = this._seg(d), p = this.p, a = p[i], b = p[i + 1];
      const sl = this.cum[i + 1] - this.cum[i] || 1e-9;
      const tx = (b[0] - a[0]) / sl, ty = (b[1] - a[1]) / sl, u = d - this.cum[i];
      return { x: a[0] + tx * u, y: a[1] + ty * u, tx, ty };
    }
    slice(d0, d1) {
      const out = [], a = this.at(d0), b = this.at(d1);
      out.push([a.x, a.y]);
      for (let i = this._seg(d0) + 1; i < this.p.length && this.cum[i] < d1 - 1e-6; i++) {
        if (this.cum[i] > d0 + 1e-6) out.push(this.p[i]);
      }
      out.push([b.x, b.y]);
      return out;
    }
    project(x, y) {
      let best = Infinity, bd = 0;
      const p = this.p, c = this.cum;
      for (let i = 0; i < p.length - 1; i++) {
        const ax = p[i][0], ay = p[i][1], dx = p[i + 1][0] - ax, dy = p[i + 1][1] - ay;
        const l2 = dx * dx + dy * dy || 1e-9;
        const u = M.clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
        const qx = ax + dx * u, qy = ay + dy * u, dd = (x - qx) * (x - qx) + (y - qy) * (y - qy);
        if (dd < best) { best = dd; bd = c[i] + Math.sqrt(l2) * u; }
      }
      return { d: bd, dist: Math.sqrt(best) };
    }
    resample(step) {
      const n = Math.max(1, Math.round(this.len / step)), out = [];
      for (let i = 0; i <= n; i++) { const q = this.at(this.len * i / n); out.push([q.x, q.y]); }
      return out;
    }
  }
  M.Poly = Poly;

  /** Кубическая кривая Эрмита между двумя точками с направлениями движения t0, t1. */
  M.hermite = function (p0, t0, p1, t1, n) {
    const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), k = d * 1.0, out = [];
    n = n || Math.max(6, Math.round(d / 6));
    for (let i = 0; i <= n; i++) {
      const u = i / n, u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      out.push([
        h00 * p0[0] + h10 * k * t0[0] + h01 * p1[0] + h11 * k * t1[0],
        h00 * p0[1] + h10 * k * t0[1] + h01 * p1[1] + h11 * k * t1[1]
      ]);
    }
    return out;
  };

  /** Сглаживание ломаной усреднением (концы сохраняются). */
  M.smoothPts = function (pts, iters) {
    for (let k = 0; k < iters; k++) {
      const o = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        o.push([(pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4]);
      }
      o.push(pts[pts.length - 1]);
      pts = o;
    }
    return pts;
  };

  M.choice = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];
})(typeof window !== 'undefined' ? window : globalThis);
