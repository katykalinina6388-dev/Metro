// Проверка построения графа путей.
globalThis.M = {};
for (const f of ['util', 'line', '../data/geo', 'track']) require('../../game/js/' + f + '.js');
const G = M.buildGraph(M.GEO, M.LINE);
const kinds = {};
for (const e of G.edges) { kinds[e.kind] = kinds[e.kind] || { n: 0, len: 0, min: 1e9, max: 0 }; const k = kinds[e.kind]; k.n++; k.len += e.len; k.min = Math.min(k.min, e.len); k.max = Math.max(k.max, e.len); }
console.log('nodes', G.nodes.length, 'edges', G.edges.length, 'switches', G.sw.length, 'stops', Object.keys(G.stops).length, 'signals', G.signals.length);
for (const k in kinds) console.log(' ', k.padEnd(9), 'n=' + kinds[k].n, 'total=' + kinds[k].len.toFixed(0), 'min=' + kinds[k].min.toFixed(0), 'max=' + kinds[k].max.toFixed(0));
console.log('station sep (m):', G.st.map(s => s.sep.toFixed(1)).join(' '));
console.log('span lengths A (m):', G.sv.A.slice(1).map((s, i) => (s - G.sv.A[i]).toFixed(0)).join(' '), 'total', G.lineLen.toFixed(0));
let bad = 0;
for (const sw of G.sw) if (!sw.stem || !sw.plus || !sw.minus) { bad++; console.log('BAD switch', sw.id, sw.zone); }
for (const id in G.stops) { const s = G.stops[id]; if (!s.e) { bad++; console.log('BAD stop', id); } else if (s.c < 60 || s.e.len - s.c < 62) { bad++; console.log('SHORT stop', id, s.c.toFixed(0), s.e.len.toFixed(0)); } }
for (const n of G.nodes) if (n.edges.length === 0 || n.edges.length > 3 || (n.edges.length === 3 && !n.sw)) { bad++; console.log('BAD node', n.id, n.edges.length); }
console.log('zones:', G.zones.map((z, i) => i + ':' + z.sw.length).join(' '), 'depot tracks', G.depot.length, 'sidings', G.sidings.map(s => s.id).join(','));
console.log('turn:', G.turn.map((t, i) => i + ':' + Object.keys(t).join('')).join(' '));
let maxg = 0; for (const e of G.edges) if (e.gr) for (const g of e.gr) maxg = Math.max(maxg, Math.abs(g));
console.log('max grade', (maxg * 1000).toFixed(1), 'promille; bad =', bad);
