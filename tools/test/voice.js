// Сквозная проверка голосового управления в браузере: встроенное распознавание (Vosk/WASM) слышит
// команду с «микрофона» (звуковой файл), поезд её исполняет, машинист отвечает встроенным голосом.
// Запуск: node tools/test/voice.js <baseUrl> <команда.wav> <номер поезда> <ожидаемый тип приказа>
let chromium; try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/tmp/pw/node_modules/playwright').chromium; }
(async () => {
  const base = process.argv[2], wav = process.argv[3], num = +process.argv[4], want = process.argv[5];
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav, '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  await page.goto(base + '?engine=vosk&micMode=open&voice=clips&autostart=1&hour=8&incidents=0&seed=7&speed=1');
  const t0 = Date.now();
  let state = '';
  for (let i = 0; i < 180; i++) { state = await page.evaluate(() => M.mic.state + (M.mic.error ? ':' + M.mic.error : '')); if (state !== 'loading' && state !== 'off') break; await page.waitForTimeout(500); }
  console.log('mic state', state, 'after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  let got = null;
  for (let i = 0; i < 60 && !got; i++) {
    await page.waitForTimeout(500);
    got = await page.evaluate(n => { const tr = M.game.sim.trains[n - 1]; return tr.order ? tr.order.type : (tr.halted ? 'stop' : null); }, num);
  }
  const log = await page.evaluate(() => document.getElementById('log').innerText.split('\n').slice(-5));
  const clip = await page.evaluate(async () => { M.radio.unlock(); try { const b = await M.radio.clip('d0', 'c.12'), c = await M.radio.clip('st', 's.item'); return { ctx: M.radio.ctx.state, hasClips: M.radio.hasClips, call: +b.duration.toFixed(2), item: +c.duration.toFixed(2), voices: Object.keys(M.radio.index.voices) }; } catch (e) { return 'ERR ' + e.message; } });
  console.log('order on train', num, '=>', got, got === want ? 'OK' : 'MISMATCH (want ' + want + ')');
  console.log('log tail:', JSON.stringify(log));
  console.log('heard:', await page.evaluate(() => document.getElementById('heard').textContent));
  console.log('radio clips:', JSON.stringify(clip));
  console.log(errors.length ? errors.slice(0, 8).join('\n') : 'no page errors');
  await page.screenshot({ path: '/tmp/shots/voice.png' });
  await browser.close();
  process.exit(got === want ? 0 : 2);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
