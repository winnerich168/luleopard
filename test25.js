/* test25 — 地圖只顯示行進方向的照相

   實地回報：希望推估行車方向後，地圖上只顯示那個方向的測速照相。
   另外以前照相超過 1500 支時「每隔一支跳過」，等於一半的照相根本沒畫在地圖上。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/tile.openstreetmap.org/**', r => r.abort());
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [], onvoiceschanged: null }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(1000);
  await page.click('#btnStart');
  await page.waitForTimeout(300);

  const R = await page.evaluate(async () => {
    const M = 1 / 111320, lat0 = 24.8, lon0 = 121.0;
    LP.CFG.useSeed = false; LP.CFG.dirFilter = true; LP.clearPacks();
    LP.addPack('t', [
      [lat0 + 2000 * M, lon0, 100, '北上', '國道一號北向80公里'],
      [lat0 + 2000 * M, lon0 + 0.0003, 100, '南下', '國道一號南向80公里'],
      [lat0 + 1500 * M, lon0 + 0.002, 50, '雙向', '某某路'],
    ]);
    LP.resetTrip();
    const n = () => LP.camLayerCount();
    const step = async (k, hd, v) => { LP.onPos(lat0 + k * M, lon0, hd, v, 5, false); await new Promise(r => setTimeout(r, 30)); };
    const out = {};
    await step(0, null, 0); out.停著 = n();
    for (let k = 0; k < 200; k += 28) await step(k, 0, 28);   out.往北 = n();
    for (let k = 200; k > 0; k -= 28) await step(k, 180, 28);  out.往南 = n();
    await step(0, 180, 0); out.停下 = n();
    // 大量照相：不能再每隔一支跳過，附近的要全部畫出來
    const many = [];
    for (let i = 0; i < 1800; i++) many.push([lat0 + (i % 60) * 0.004 - 0.12, lon0 + Math.floor(i / 60) * 0.004 - 0.06, 50, '雙向', '點' + i]);
    LP.clearPacks(); LP.addPack('many', many); LP.CAMVIEW.lat = lat0; LP.CAMVIEW.lon = lon0; LP.CAMVIEW.hd = null; LP.drawCamLayer();
    out.大量_總數 = LP.CAMS().length; out.大量_畫出 = n();
    out.大量_附近應有 = LP.CAMS().filter(c => Math.abs(c.lat - lat0) < 0.3 && Math.abs(c.lon - lon0) < 0.3).length;
    return out;
  });
  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('停著：三支都顯示', R.停著 === 3);
  ok('往北開：只顯示北向與雙向（2 支）', R.往北 === 2);
  ok('掉頭往南：換成南向與雙向（2 支）', R.往南 === 2);
  ok('停下來：恢復全部顯示', R.停下 === 3);
  ok('照相很多時，附近的全部畫出來（不再每隔一支跳過）', R.大量_畫出 === R.大量_附近應有 && R.大量_畫出 > 1500);
  ok('沒有頁面錯誤', errs.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test25 全部通過');
})();
