/* v0.7：省電邏輯 + 路網貼路計算 */
const { chromium } = require('playwright');
const path = require('path');

/* 一條 S 形彎道，模擬國3山區：直線距離會嚴重低估沿路距離 */
function curveRoad() {
  const pts = [];
  for (let i = 0; i < 300; i++) {
    const t = i / 299;
    pts.push([+(24.80 - 0.05 * t).toFixed(6), +(121.30 + 0.012 * Math.sin(t * Math.PI * 3)).toFixed(6)]);
  }
  return pts;
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });

  await page.addInitScript(() => {
    window.__spoken = [];
    window.__watchers = [];          // 每次 addWatcher 的參數
    window.__removed = [];
    let cb = null, next = 1;
    window.__emit = (loc, err) => cb && cb(loc, err);
    window.Capacitor = {
      isNativePlatform: () => true, getPlatform: () => 'android',
      Plugins: {
        BackgroundGeolocation: {
          addWatcher: async (o, c) => { window.__watchers.push(o); cb = c; return 'w' + (next++); },
          removeWatcher: async ({ id }) => { window.__removed.push(id); cb = null; },
        },
        TextToSpeech: { speak: async o => window.__spoken.push(o.text), stop: async () => {} },
      },
    };
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    let released = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: async () => ({ release: async () => { released++; window.__released = released; } }) },
      configurable: true });
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });

  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(400);

  const R = {};

  // ══════════ 省電 ══════════
  R.powerInit = await page.evaluate(() => ({
    watchers: window.__watchers.length,
    firstFilter: window.__watchers[0] && window.__watchers[0].distanceFilter,
    saving: LP.POWER.saving,
  }));

  // 行駛中不應該進省電
  R.drivingStaysOn = await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      window.__clock += 60e3;                                   // 每分鐘一次
      LP.onPos(24.5 - i * 0.01, 121.2, 180, 90 / 3.6, 8, true);  // 一直在動
    }
    return { saving: LP.POWER.saving, watchers: window.__watchers.length };
  });

  // 停下來超過設定分鐘數 → 進省電
  R.enterSaving = await page.evaluate(async () => {
    LP.CFG.powerAfterMin = 5;
    LP.powerReset();
    const lat = 24.3, lon = 121.2;
    LP.onPos(lat, lon, 180, 0, 8, true);                        // 停住
    window.__clock += 6 * 60e3;                                 // 過 6 分鐘
    LP.onPos(lat + 0.00002, lon, 180, 0, 8, true);              // 幾乎沒動
    await new Promise(r => setTimeout(r, 250));
    const w = window.__watchers[window.__watchers.length - 1];
    return { saving: LP.POWER.saving, removed: window.__removed.length,
             newFilter: w && w.distanceFilter, title: w && w.backgroundTitle,
             reAskedPermission: w && w.requestPermissions,
             wakeReleased: window.__released || 0,
             tag: !document.getElementById('powerTag').classList.contains('hidden'),
             label: document.getElementById('lGps').textContent };
  });

  // 重新開動 → 立刻恢復
  R.exitSaving = await page.evaluate(async () => {
    LP.onPos(24.3, 121.2, 180, 90 / 3.6, 8, true);
    await new Promise(r => setTimeout(r, 250));
    const w = window.__watchers[window.__watchers.length - 1];
    return { saving: LP.POWER.saving, newFilter: w && w.distanceFilter,
             title: w && w.backgroundTitle,
             tag: !document.getElementById('powerTag').classList.contains('hidden'),
             label: document.getElementById('lGps').textContent };
  });

  // 關掉省電設定就不該再進去
  R.powerDisabled = await page.evaluate(() => {
    LP.CFG.powerSave = false; LP.powerReset();
    LP.onPos(24.2, 121.2, 180, 0, 8, true);
    window.__clock += 20 * 60e3;
    LP.onPos(24.2, 121.2, 180, 0, 8, true);
    const r = LP.POWER.saving;
    LP.CFG.powerSave = true;
    return { saving: r };
  });

  // ══════════ 路網 ══════════
  R.roadLoad = await page.evaluate(pts => {
    const n = LP.loadRoadNet([{ id: 'N3#1', ref: '國道3號', cls: '國道', pts }]);
    return { segments: n, loaded: LP.ROADNET.loaded, points: LP.ROADNET.roads[0].pts.length,
             lenKm: +(LP.ROADNET.roads[0].lenM / 1000).toFixed(2) };
  }, curveRoad());

  R.snap = await page.evaluate(pts => {
    const mid = pts[150];
    const off = LP.snapToRoad(mid[0] + 0.0003, mid[1]);          // 偏離約 33 公尺
    const far = LP.snapToRoad(24.0, 120.0);                      // 離很遠
    return { onRoad: off && { ref: off.ref, offsetM: Math.round(off.offsetM),
                              alongM: Math.round(off.alongM) },
             farAway: far };
  }, curveRoad());

  // 沿路距離 vs 直線距離：彎道上差很多
  R.alongVsStraight = await page.evaluate(pts => {
    const a = pts[20], b = pts[280];
    const straight = LP.dist(a[0], a[1], b[0], b[1]);
    const along = LP.alongDistance(a[0], a[1], b[0], b[1]);
    return { 直線m: Math.round(straight), 沿路m: Math.round(along),
             低估比例: +((1 - straight / along) * 100).toFixed(1) };
  }, curveRoad());

  // 前方清單：彎道另一側的點，錐形會漏，貼路抓得到
  R.corridor = await page.evaluate(pts => {
    LP.clearPacks();
    const ahead = pts[210];                 // 前方彎道後面
    const behind = pts[60];                 // 後方
    const offRoad = [pts[200][0], pts[200][1] + 0.02];   // 旁邊 2 公里外的別條路
    LP.addPack('彎道測試', [
      [ahead[0], ahead[1], 60, '南北雙向', '彎道後的測速點'],
      [behind[0], behind[1], 60, '南北雙向', '後方的測速點'],
      [offRoad[0], offRoad[1], 60, '南北雙向', '旁邊不同路的測速點'],
    ]);
    const me = pts[150];
    const heading = LP.bearing(pts[149][0], pts[149][1], pts[151][0], pts[151][1]);
    LP.onPos(me[0], me[1], heading, 90 / 3.6, 6, true);

    const withNet = LP.upcomingCams(LP.GPS.last, 20)
      .map(x => ({ name: x.cam.name, km: +(x.d / 1000).toFixed(2), onRoad: !!x.onRoad }));

    // 關掉路網再算一次，比較差別
    const saved = LP.ROADNET.roads;
    LP.ROADNET.loaded = false;
    const noNet = LP.upcomingCams(LP.GPS.last, 20)
      .map(x => ({ name: x.cam.name, km: +(x.d / 1000).toFixed(2) }));
    LP.ROADNET.loaded = true; LP.ROADNET.roads = saved;
    return { 有路網: withNet, 沒路網: noNet };
  }, curveRoad());

  // 樁號推算改用沿路距離
  R.kmAlongRoad = await page.evaluate(pts => {
    const a = pts[20], b = pts[280];
    LP.kmLock(50.0, '國3', { lat: a[0], lon: a[1], heading: 180 }, '南下');
    const heading = LP.bearing(pts[279][0], pts[279][1], pts[281] ? pts[281][0] : pts[299][0],
                               pts[281] ? pts[281][1] : pts[299][1]);
    const est = LP.kmEstimate({ lat: b[0], lon: b[1], heading, speed: 25 });
    // 拿掉路網再算，看差多少
    LP.ROADNET.loaded = false;
    const est2 = LP.kmEstimate({ lat: b[0], lon: b[1], heading, speed: 25 });
    LP.ROADNET.loaded = true;
    return { 沿路: { km: +est.km.toFixed(2), acc: est.acc },
             直線: { km: +est2.km.toFixed(2), acc: est2.acc } };
  }, curveRoad());

  // 沒載路網時一切照舊
  R.noRoadNetFallback = await page.evaluate(() => {
    LP.ROADNET.roads = []; LP.ROADNET.loaded = false;
    LP.clearPacks();
    LP.addPack('無路網', [[24.40, 121.00, 60, '南北雙向', '正前方']]);
    LP.onPos(24.42, 121.00, 180, 90 / 3.6, 6, true);
    const up = LP.upcomingCams(LP.GPS.last, 20);
    return { count: up.length, onRoad: up[0] && !!up[0].onRoad,
             snapNull: LP.snapToRoad(24.42, 121.00) === null,
             alongNull: LP.alongDistance(24.4, 121, 24.3, 121) === null };
  });

  // ══════════ UI ══════════
  await page.click('#tabs button[data-v="data"]');
  await page.waitForTimeout(200);
  R.ui = {
    roadStat: await page.textContent('#roadStat'),
    hasRoadCard: (await page.textContent('#v-data')).includes('路網幾何'),
  };
  await page.click('#tabs button[data-v="set"]');
  await page.waitForTimeout(150);
  R.ui.hasPowerSetting = (await page.textContent('#v-set')).includes('靜止自動省電');
  await page.screenshot({ path: 'shot-power.png' });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
})();
