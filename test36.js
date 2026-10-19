/* test36 — 底圖：預設國土測繪中心，載不到自動改 OSM；設定可切換；換底圖不影響定位、車頭向前與照相點 */
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const LCSS = fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8');
  async function open({ nlsc = 'ok', ctx, offline = false } = {}) {
    ctx = ctx || await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' });
    const page = await ctx.newPage();
    page.errs = []; page.on('pageerror', e => page.errs.push('PAGEERROR: ' + e.message));
    page.hits = { nlsc: 0, osm: 0 };
    await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
    await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: LCSS }));
    await page.route('https://tile.openstreetmap.org/**', r => { page.hits.osm++; r.fulfill({ contentType: 'image/png', body: PNG }); });
    await page.route('https://wmts.nlsc.gov.tw/**', r => { page.hits.nlsc++;
      if (page.nlsc === 'ok') r.fulfill({ contentType: 'image/png', body: PNG }); else r.abort(); });
    page.nlsc = nlsc;
    await page.addInitScript(() => { window.__toasts = []; document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('toast'); new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true }); }); });
    if (offline) await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
    await page.waitForTimeout(800); await page.click('#btnStart'); await page.waitForTimeout(1200);
    return page;
  }
  const state = p => p.evaluate(() => ({ key: LP.BASE.key, fell: LP.BASE.fellBack, cfg: LP.CFG.mapStyle,
    attr: document.querySelector('.leaflet-control-attribution').textContent,
    imgs: [...document.querySelectorAll('.leaflet-tile-pane img')].map(i => new URL(i.src).host),
    toast: window.__toasts.join(' / '), sel: document.getElementById('mapStyle').value }));

  // 1. 預設：國土測繪中心
  let A = await open();
  let s = await state(A);
  ok(s.key === 'nlsc' && s.cfg === 'nlsc' && s.sel === 'nlsc', '預設底圖不是國土測繪中心：' + JSON.stringify(s));
  ok(A.hits.nlsc > 0 && A.hits.osm === 0, '預設時圖磚來源不對：' + JSON.stringify(A.hits));
  ok(s.imgs.length && s.imgs.every(h => h === 'wmts.nlsc.gov.tw'), '畫面上的圖磚不是國土測繪中心：' + s.imgs);
  ok(/內政部國土測繪中心/.test(s.attr) && !/OpenStreetMap/.test(s.attr), '地圖右下角出處不對：' + s.attr);
  ok(/國土測繪中心/.test(await A.textContent('#aboutBox')), '關於頁沒列國土測繪中心出處');
  // 偶爾掉幾張不會切換
  await A.evaluate(() => { for (let i = 0; i < LP.BASE_FAIL - 2; i++) LP.BASE.layer.fire('tileerror'); LP.BASE.layer.fire('tileload'); for (let i = 0; i < LP.BASE_FAIL - 2; i++) LP.BASE.layer.fire('tileerror'); });
  ok((await state(A)).key === 'nlsc', '偶爾掉幾張就切走了');

  // 2. 換底圖不影響定位、車頭向前、照相點
  const pos = await A.evaluate(async () => {
    LP.CFG.mapRotate = true; LP.MAPROT.on = true;
    LP.onPos(25.0418, 121.5440, 90, 15, 5, false);
    await new Promise(r => setTimeout(r, 300));
    const before = { deg: LP.MAPROT.deg, ll: LP.MAP().getCenter(), cams: LP.camLayerCount() };
    LP.setBaseMap('osm');
    LP.onPos(25.0418, 121.5450, 90, 15, 5, false);
    await new Promise(r => setTimeout(r, 600));
    const me = document.querySelector('.mecone');
    const pane = document.querySelector('.leaflet-tile-pane'), mk = document.querySelector('.leaflet-marker-pane');
    return { before, deg: LP.MAPROT.deg, gps: LP.GPS.last && [LP.GPS.last.lat, LP.GPS.last.lon], me: !!me,
      cams: LP.camLayerCount(), layers: document.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length,
      z: [getComputedStyle(pane).zIndex, getComputedStyle(mk).zIndex] };
  });
  ok(pos.before.deg === -90 && pos.deg === -90, '換底圖後車頭向前跑掉：' + JSON.stringify(pos));
  ok(pos.gps && Math.abs(pos.gps[1] - 121.545) < 1e-9 && pos.me, '換底圖後定位標記不見或沒更新：' + JSON.stringify(pos));
  ok(pos.cams === pos.before.cams, '換底圖後照相點數量變了：' + JSON.stringify(pos));
  ok(pos.layers === 1, '換底圖後舊圖層沒移掉：' + pos.layers);
  ok(+pos.z[0] < +pos.z[1], '底圖蓋到標記上面了：' + pos.z);
  s = await state(A);
  ok(/OpenStreetMap/.test(s.attr) && !/國土測繪中心/.test(s.attr), '切到 OSM 後出處沒換：' + s.attr);

  // 3. 設定切換並記住
  await A.evaluate(() => LP.setBaseMap('nlsc'));
  await A.evaluate(() => document.querySelector('[data-v="set"]') && document.querySelector('[data-v="set"]').click());
  await A.selectOption('#mapStyle', 'osm'); await A.waitForTimeout(500);
  s = await state(A);
  ok(s.key === 'osm' && s.cfg === 'osm', '設定選 OSM 沒切換：' + JSON.stringify(s));
  const ctx = A.context(); await A.close();
  A = await open({ ctx });
  s = await state(A);
  ok(s.key === 'osm' && s.sel === 'osm' && A.hits.nlsc === 0, '重開後沒記住 OSM：' + JSON.stringify({ ...s, hits: A.hits }));
  await A.evaluate(() => { document.getElementById('mapStyle').value = 'nlsc'; document.getElementById('mapStyle').dispatchEvent(new Event('change')); });
  ok((await state(A)).key === 'nlsc', '設定切回國土測繪中心沒反應');

  // 4. 國土測繪中心整個掛掉 → 自動改 OSM，但不改設定
  const B = await open({ nlsc: 'fail' });
  await B.waitForTimeout(1500);
  s = await state(B);
  ok(s.key === 'osm' && s.fell && s.cfg === 'nlsc', '國土測繪中心載不到時沒自動改 OSM（或改了設定）：' + JSON.stringify(s));
  ok(/已改用 OpenStreetMap/.test(s.toast), '自動改 OSM 時沒提示：' + s.toast);
  ok(B.hits.osm > 0, '改 OSM 後沒去抓 OSM 圖磚');
  const gB = await B.evaluate(() => { LP.onPos(24.75, 121.75, 0, 0, 5, false); return !!document.querySelector('.mecone'); });
  ok(gB, '備援底圖下定位標記沒出現');

  // 5. 沒網路：兩邊都載不到，不要亂切
  const C = await open({ nlsc: 'fail', offline: true });
  await C.waitForTimeout(1500);
  s = await state(C);
  ok(s.key === 'nlsc' && C.hits.osm === 0, '沒網路時不該切到 OSM：' + JSON.stringify({ key: s.key, hits: C.hits }));

  for (const p of [A, B, C]) fails.push(...p.errs);
  await browser.close();
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test36 底圖');
  process.exit(fails.length ? 1 : 0);
})();
