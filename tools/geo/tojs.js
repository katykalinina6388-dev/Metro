// Сборка game/data/geo.js из результатов tools/geo/out/*.json (данные OpenStreetMap).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'out');
const rd = f => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
const r5 = ring => ring.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
const st = rd('stations.json'), tr = rd('tracks.json'), water = rd('water.json'), city = rd('city.json');
if (!st || !tr) { console.error('нет stations.json / tracks.json'); process.exit(1); }
const geo = {
  source: '© участники OpenStreetMap (ODbL)',
  stations: st.map(s => [s.lon, s.lat]),
  tracks: { A: tr.A, B: tr.B },
  water: water ? water.polygons.map(p => ({ rings: p.rings.map(r5) })) : [],
  city: city ? { boundary: city.boundary.map(r5), districts: city.districts.map(d => ({ name: d.name, rings: d.rings.map(r5) })) } : { boundary: [], districts: [] }
};
const out = path.join(__dirname, '../../game/data/geo.js');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '/* Картографические данные: © участники OpenStreetMap, лицензия ODbL. Сформировано tools/geo/tojs.js */\n(function(r){(r.M=r.M||{}).GEO=' + JSON.stringify(geo) + ';})(typeof window!=="undefined"?window:globalThis);\n');
const n = a => a.reduce((s, x) => s + x.rings.reduce((q, r) => q + r.length, 0), 0);
console.log('geo.js', (fs.statSync(out).size / 1024).toFixed(0) + ' KB', 'trackA', tr.A.length, 'trackB', tr.B.length, 'water pts', n(geo.water), 'districts', geo.city.districts.length, st.map(s => s.name).join(', '));
