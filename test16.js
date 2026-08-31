/* 地圖三件事
   1. 車頭向前：地圖跟著行進方向轉
   2. 錐形游標：尖端就是行進方向，比圓點好辨別
   3. 點地圖看樁號：彈出南下/北上公里數，秒數可設定

   地圖需要 Leaflet，App 是從 CDN 載入的；測試環境連不到 CDN，
   所以把那個請求攔截成本機的 node_modules 版本。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const LEAFLET_CSS = fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8');

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**/tile.openstreetmap.org/**', r => r.abort());   // 圖磚不需要

  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(1200);
  await page.click('#btnStart');
  await page.waitForTimeout(400);

  const R = {};
  R.地圖可用 = await page.evaluate(() => typeof L !== 'undefined');

  /* 1. 錐形游標 */
  R.錐形 = await page.evaluate(async () => {
    LP.CFG.mapRotate = false; LP.MAPROT.on = false;
    LP.onPos(24.5, 120.8, 90, 100 / 3.6, 8, true);      // 往東
    await new Promise(r => setTimeout(r, 120));
    const e = document.querySelector('.mecone svg');
    const east = e ? e.style.transform : null;
    LP.onPos(24.5, 120.81, 180, 100 / 3.6, 8, true);    // 往南
    await new Promise(r => setTimeout(r, 120));
    const south = document.querySelector('.mecone svg').style.transform;
    return { 有錐形: !!e, 有三角形路徑: !!document.querySelector('.mecone path'),
             往東時: east, 往南時: south };
  });

  /* 2. 車頭向前 */
  R.車頭向前 = await page.evaluate(async () => {
    LP.CFG.mapRotate = true; LP.MAPROT.on = true;
    LP.onPos(24.5, 120.8, 45, 100 / 3.6, 8, true);
    await new Promise(r => setTimeout(r, 120));
    const t45 = document.getElementById('map').style.transform;
    const cone45 = document.querySelector('.mecone svg').style.transform;
    LP.onPos(24.51, 120.81, 200, 100 / 3.6, 8, true);
    await new Promise(r => setTimeout(r, 120));
    const t200 = document.getElementById('map').style.transform;
    const 有rot類別 = document.getElementById('mapRot').classList.contains('rot');
    // 關掉之後要復原
    LP.CFG.mapRotate = false; LP.MAPROT.on = false; LP.setMapRotation(null);
    return { 航向45時: t45, 航向200時: t200, 錐形抵銷: cone45,
             有旋轉類別: 有rot類別, 關閉後: document.getElementById('map').style.transform };
  });

  /* 3. 航向不可信時不亂轉 */
  R.航向不可信 = await page.evaluate(async () => {
    LP.CFG.mapRotate = true; LP.MAPROT.on = true;
    LP.setMapRotation(45);
    const 轉了 = document.getElementById('map').style.transform;
    // 位置幾乎不動（遠小於定位誤差），航向才真的推不出來
    LP.GPS.last = null;
    LP.onPos(24.5, 120.8, null, null, 900, false);
    await new Promise(r => setTimeout(r, 30));
    LP.onPos(24.500002, 120.800002, null, null, 900, false);
    await new Promise(r => setTimeout(r, 120));
    return { 先轉了: !!轉了, 之後: document.getElementById('map').style.transform };
  });

  /* 4. 螢幕座標換算：旋轉前後點同一個螢幕位置，應得到不同經緯度，
        且旋轉 0 度時要跟 Leaflet 內建換算一致 */
  R.座標換算 = await page.evaluate(() => {
    const M = LP.MAP();
    LP.MAPROT.deg = 0;
    const mine = LP.screenToLatLng(200, 400);
    const r = M.getContainer().getBoundingClientRect();
    const native = M.containerPointToLatLng([200 - r.left, 400 - r.top]);
    // 用像素比較而不是經緯度：容器高度 rect 是 720.8、offsetHeight 是 721，
    // 次像素捨入在低倍率下換算成經緯度會放大成幾公尺，看起來像錯其實沒錯。
    const pa = M.latLngToContainerPoint(mine), pb = M.latLngToContainerPoint(native);
    const 差幾像素 = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    // 旋轉 90 度後，同一個螢幕點應該對到明顯不同的位置
    LP.MAPROT.deg = -90;
    const rot = LP.screenToLatLng(200, 400);
    const pr = M.latLngToContainerPoint(rot);
    const 旋轉後差幾像素 = Math.hypot(pr.x - pa.x, pr.y - pa.y);
    LP.MAPROT.deg = 0;
    return { 差幾像素: +差幾像素.toFixed(2), 旋轉後差幾像素: Math.round(旋轉後差幾像素) };
  });

  /* 5. 點地圖看樁號 */
  R.樁號彈框 = await page.evaluate(async () => {
    LP.CFG.kmPopSec = 10;
    const a = LP.KM.anchors.find(x => x.road === '國1' && x.dir === '南下');
    const r = LP.showKmPop(a.lat, a.lon);
    const box = document.getElementById('kmPop');
    return { 有顯示: box.classList.contains('show'),
             路名: document.getElementById('kmPopRoad').textContent,
             內容: document.getElementById('kmPopBody').textContent.replace(/\s+/g, ' ').trim(),
             備註: document.getElementById('kmPopNote').textContent,
             錨點真實樁號: a.km, 算出: r ? r.items.map(x => x.dir + x.km) : null };
  });

  /* 6. 沒有樁號資料的地方要講清楚，不能給假數字 */
  R.海上 = await page.evaluate(() => {
    const r = LP.showKmPop(23.0, 119.0);
    return { 回傳: r, 路名: document.getElementById('kmPopRoad').textContent,
             內容: document.getElementById('kmPopBody').textContent.slice(0, 20) };
  });

  /* 7. 秒數設定 */
  R.自動關閉 = await page.evaluate(async () => {
    LP.CFG.kmPopSec = 3;                                  // 下限就是 3 秒
    const a = LP.KM.anchors.find(x => x.road === '國1');
    LP.showKmPop(a.lat, a.lon);
    const 剛顯示 = document.getElementById('kmPop').classList.contains('show');
    await new Promise(r => setTimeout(r, 3400));
    const 到期後 = document.getElementById('kmPop').classList.contains('show');
    LP.CFG.kmPopSec = 10;
    return { 剛顯示, 到期後 };
  });

  /* 8. 設為關閉時，點地圖不彈 */
  R.可關閉 = await page.evaluate(async () => {
    LP.CFG.kmPopSec = 0;
    LP.hideKmPop();
    const box = LP.MAP().getContainer().getBoundingClientRect();
    LP.MAP().getContainer().dispatchEvent(new MouseEvent('click',
      { clientX: box.left + 100, clientY: box.top + 300, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const 關閉時 = document.getElementById('kmPop').classList.contains('show');
    LP.CFG.kmPopSec = 10;
    LP.MAP().getContainer().dispatchEvent(new MouseEvent('click',
      { clientX: box.left + 100, clientY: box.top + 300, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return { 設為關閉時有彈: 關閉時,
             開啟後有反應: document.getElementById('kmPop').classList.contains('show')
                        || document.getElementById('kmPopRoad').textContent.length > 0 };
  });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('Leaflet 有載入（測試前提）', R.地圖可用);
  ok('游標是錐形不是圓點', R.錐形.有錐形 && R.錐形.有三角形路徑);
  ok('北方朝上時錐形跟著航向轉', /rotate\(90deg\)/.test(R.錐形.往東時 || ''));
  ok('航向改變時錐形跟著改', R.錐形.往南時 !== R.錐形.往東時);
  ok('車頭向前會旋轉地圖', /rotate\(-45deg\)/.test(R.車頭向前.航向45時 || ''));
  ok('換方向時地圖跟著轉', /rotate\(-200deg\)/.test(R.車頭向前.航向200時 || ''));
  ok('車頭向前時錐形抵銷成朝上', /rotate\(0deg\)/.test(R.車頭向前.錐形抵銷 || ''));
  ok('有加上旋轉用的類別', R.車頭向前.有旋轉類別);
  ok('關閉車頭向前會復原', !R.車頭向前.關閉後);
  ok('航向不可信時不亂轉', !R.航向不可信.之後);
  ok('不旋轉時座標換算與 Leaflet 相符（誤差 < 1 像素）', R.座標換算.差幾像素 < 1);
  ok('旋轉後座標換算有跟著補正', R.座標換算.旋轉後差幾像素 > 50);
  ok('點錨點算出的樁號與真實值相符',
     R.樁號彈框.算出 && R.樁號彈框.算出.some(x => x.includes(String(R.樁號彈框.錨點真實樁號))));
  ok('彈框同時顯示南下與北上', /南下/.test(R.樁號彈框.內容) && /北上/.test(R.樁號彈框.內容));
  ok('彈框有標示精度', R.樁號彈框.備註.length > 0);
  ok('正好點在錨點上時不該標成概估', !/概估/.test(R.樁號彈框.備註));
  ok('沒有樁號資料時明講而不是給假數字',
     R.海上.回傳 === null && /沒有樁號資料/.test(R.海上.路名));
  ok('依設定秒數自動關閉', R.自動關閉.剛顯示 && !R.自動關閉.到期後);
  ok('設為關閉時點地圖不彈', R.可關閉.設為關閉時有彈 === false);
  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test16（車頭向前 · 錐形游標 · 點圖看樁號）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
