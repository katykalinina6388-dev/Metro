// Снимки экрана игры в headless-браузере. Запуск: node tools/test/shots.js <baseUrl> <outDir> [сценарий…]
let chromium; try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/tmp/pw/node_modules/playwright').chromium; }
const fs = require('fs');
(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8765/', out = process.argv[3] || '/tmp/shots';
  const only = process.argv.slice(4);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: out + '/' + name + '.png' }); };
  const want = n => !only.length || only.includes(n);
  await page.goto(base + '?engine=off&voice=off&seed=7');
  await page.waitForTimeout(600);
  if (want('menu')) await shot('01-menu');
  await page.goto(base + '?engine=off&voice=off&seed=7&autostart=1&hour=8&min=20&speed=12&incidents=0');
  await page.waitForTimeout(6000);
  if (want('overview')) await shot('02-overview');
  const fly = (expr, k) => page.evaluate(([e, kk]) => { const g = M.game, p = eval(e); g.render.follow = false; g.render.flyTo(p.x, p.y, kk, true); }, [expr, k]);
  if (want('center')) { await fly('M.game.G.st[4]', 0.16); await shot('03-center'); }
  if (want('station')) { await fly('M.game.G.st[4]', 2.2); await page.waitForTimeout(1500); await shot('04-gostiny'); }
  if (want('begovaya')) { await fly('({x: M.game.G.st[0].x - 40, y: M.game.G.st[0].y - 150})', 1.3); await shot('05-begovaya'); }
  if (want('train')) {
    await page.evaluate(() => { const g = M.game, tr = g.sim.trains.filter(t => t.mode === 'service').sort((a, b) => b.loadTot - a.loadTot)[0]; g.ui.select({ type: 'train', tr }); const p = g.sim.pointBack(tr, 58); g.paused = true; g.render.flyTo(p.x, p.y, 9, true); });
    await shot('06-train');
    await page.evaluate(() => { M.game.paused = false; });
  }
  if (want('depot')) { await page.evaluate(() => { const b = M.game.G.depotBox, g = M.game; g.render.flyTo((b[0][0] + b[2][0]) / 2 - 120, (b[0][1] + b[2][1]) / 2, 1.9, true); }); await shot('07-depot'); }
  if (want('rybatskoe')) { await fly('({x: M.game.G.st[11].x + 120, y: M.game.G.st[11].y + 60})', 1.6); await shot('08-rybatskoe'); }
  if (want('stationPanel')) { await page.evaluate(() => { M.game.ui.select({ type: 'station', st: 8 }); const s = M.game.G.st[8]; M.game.render.flyTo(s.x + 150, s.y + 150, 1.5, true); }); await shot('09-lomonosovskaya'); }
  if (want('pan')) { await page.evaluate(() => { M.game.ui.select({ type: 'station', st: 6 }); const s = M.game.G.st[6]; M.game.render.flyTo(s.x + s.tx * 260, s.y + s.ty * 260, 1.25, true); }); await shot('11-pl-nevskogo'); }
  if (want('cmd')) {
    await page.evaluate(() => { const g = M.game; g.ui.command('Маршрут пять, доложите обстановку'); g.ui.command('маршрут 7, следуйте в депо'); g.ui.command('маршрут 3 оборот по станции Ломоносовская'); g.ui.showTab('trains'); g.render.fit(true); });
    await page.waitForTimeout(1500); await shot('10-commands');
  }
  const info = await page.evaluate(() => ({ t: M.fmtClock(M.game.sim.t, true), line: M.game.sim.inService(), delivered: Math.round(M.game.sim.stats.delivered), log: document.getElementById('log').innerText.split('\n').slice(-6) }));
  console.log(JSON.stringify(info));
  console.log(errors.length ? errors.slice(0, 12).join('\n') : 'no page errors');
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
