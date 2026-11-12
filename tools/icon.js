// Рисует значок игры (зелёный круг с цифрой 3) в PNG 256×256. Запуск: node tools/icon.js out.png
let chromium; try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/tmp/pw/node_modules/playwright').chromium; }
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 256, height: 256 } });
  await p.setContent('<body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#1fae5a"/><circle cx="16" cy="16" r="15" fill="none" stroke="#0b6b36" stroke-width="1"/><text x="16" y="22.5" font-size="19" font-family="Arial, Helvetica, sans-serif" font-weight="700" text-anchor="middle" fill="#fff">3</text></svg></body>');
  await p.screenshot({ path: process.argv[2], omitBackground: true });
  await b.close();
})();
