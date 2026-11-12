// Временная (приближённая) геометрия для отладки: сплайн через станции, пути в 10 м друг от друга.
// Заменяется реальными данными OSM скриптом tools/geo/tojs.js.
const fs = require('fs');
const path = require('path');
globalThis.M = {};
require('../../game/js/util.js');
require('../../game/js/line.js');
const st = M.LINE.stations.map(s => [s.lon, s.lat]);
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map(i => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}
const c = [];
for (let i = 0; i < st.length - 1; i++) {
  const p0 = st[Math.max(0, i - 1)], p1 = st[i], p2 = st[i + 1], p3 = st[Math.min(st.length - 1, i + 2)];
  for (let j = 0; j < 30; j++) c.push(cr(p0, p1, p2, p3, j / 30));
}
c.push(st[st.length - 1]);
const KX = 111320 * Math.cos(59.92 * Math.PI / 180), KY = 111400;
function offset(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = (b[0] - a[0]) * KX, ty = -(b[1] - a[1]) * KY; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    // право по ходу (экранные координаты, Y вниз): (-ty, tx)
    return [+(p[0] + (-ty * d) / KX).toFixed(6), +(p[1] - (tx * d) / KY).toFixed(6)];
  });
}
const geo = { approx: true, stations: st, tracks: { A: offset(c, 5), B: offset(c, -5) }, water: [], city: { boundary: [], districts: [] } };
fs.mkdirSync(path.join(__dirname, '../../game/data'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../../game/data/geo.js'),
  '(function(r){(r.M=r.M||{}).GEO=' + JSON.stringify(geo) + ';})(typeof window!=="undefined"?window:globalThis);\n');
console.log('geo.js written (approx), centerline points', c.length);
