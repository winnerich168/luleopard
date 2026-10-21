/* test38 — 車頭向前時，自己的車放在畫面下方約三分之一（前方多看一點路）；北朝上時維持置中 */
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');

(async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const LCSS = fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8');
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = []; page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: LCSS }));
  await page.route(/tile\.openstreetmap\.org|wmts\.nlsc\.gov\.tw/, r => r.abort());
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800); await page.click('#btnStart'); await page.waitForTimeout(300);

  // 沿著航向開 10 秒，每秒 20 公尺；回傳自己的車在畫面上的位置（相對地圖可見範圍）
  const drive = (h, rot) => page.evaluate(async ([h, rot]) => {
    LP.CFG.mapRotate = rot; LP.MAPROT.on = rot;
    const r = h * Math.PI / 180;
    let la = 24.15, lo = 120.675;
    for (let i = 0; i < 10; i++) {
      la += 20 * Math.cos(r) / 111320; lo += 20 * Math.sin(r) / (111320 * Math.cos(la * Math.PI / 180));
      LP.onPos(la, lo, h, 20, 5, false);
      await new Promise(z => setTimeout(z, 120));
    }
    await new Promise(z => setTimeout(z, 1200));          // 等平移與旋轉動畫跑完
    const v = document.getElementById('mapRot').getBoundingClientRect();
    const m = document.querySelector('.mecone').getBoundingClientRect();
    return { fx: (m.left + m.width / 2 - v.left) / v.width, fy: (m.top + m.height / 2 - v.top) / v.height, deg: LP.MAPROT.deg };
  }, [h, rot]);

  for (const h of [0, 90, 225]) {
    const p = await drive(h, true);
    console.log('車頭向前 航向' + h, JSON.stringify(p));
    ok(Math.abs(p.fx - 0.5) < 0.04, '航向 ' + h + '：車沒有左右置中 ' + JSON.stringify(p));
    ok(Math.abs(p.fy - 2 / 3) < 0.05, '航向 ' + h + '：車不在畫面下方三分之一 ' + JSON.stringify(p));
  }
  const n = await drive(90, false);
  console.log('北朝上', JSON.stringify(n));
  ok(Math.abs(n.fx - 0.5) < 0.04 && Math.abs(n.fy - 0.5) < 0.04, '北朝上時車要置中 ' + JSON.stringify(n));

  fails.push(...errs);
  await browser.close();
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test38 車頭向前時車在畫面下方三分之一');
  process.exit(fails.length ? 1 : 0);
})();
