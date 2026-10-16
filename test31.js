/* 車頭向前時用手指拖曳地圖：手指往哪滑，地圖就往哪跑 */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/tile.openstreetmap.org/**', r => r.abort());
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(300);

  const out = {}; let ok = true;
  for (const heading of [0, 90, 270, 45, 200]) {
    const r = await page.evaluate(async h => {
      LP.CFG.mapRotate = true; LP.MAPROT.on = true; LP.MAPROT.deg = 0;
      LP.setMapRotation(h);
      await new Promise(r => setTimeout(r, 500));
      const c = LP.MAP().getContainer(), b = c.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      // 手指往上滑 120px 後，原本在中心下方 120px 的點應該跑到中心
      const target = LP.screenToLatLng(cx, cy + 120);
      return { cx, cy, target: [target.lat, target.lng] };
    }, heading);
    const sx = 207, sy = 600;   // 選在畫面中央偏下、避開上方面板
    await page.mouse.move(sx, sy); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(sx, sy - 10 * i);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const px = await page.evaluate(({ cx, cy, target }) => {
      const M = LP.MAP(), now = LP.screenToLatLng(cx, cy);
      const a = M.latLngToContainerPoint(now), b = M.latLngToContainerPoint(target);
      return Math.hypot(a.x - b.x, a.y - b.y);
    }, r);
    out['航向' + heading] = Math.round(px) + 'px';
    if (px > 15) ok = false;
  }
  console.log(JSON.stringify(out), errs);
  console.log(ok && !errs.length ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(ok && !errs.length ? 0 : 1);
})();
