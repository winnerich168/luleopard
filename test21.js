/* test21 — 轉角後的測速照相：還沒到就播「已通過」

   實地回報：測速照相在前方轉角後，還沒開到就播報「已通過」，
   之後真的開到它面前反而不提醒（被永久排除了）。

   原因：以前只要「提醒過、而且它在車頭 85° 以外」就算通過。
   往北開、轉角後右轉往東，照相在轉角後 250 公尺：
     轉角前 100 公尺時，照相直線方位 ≈ 68°；轉角前 20 公尺 ≈ 85° —— 被當成已經在後方。
   加了 1 公里遠距預告之後，照相在 1 公里外就算「提醒過」，這個誤判更容易發生。

   現在必須「真的開到它旁邊過（最近距離夠近）、而且正在遠離」才算通過。

   每一步真的等 120 毫秒：「就在前方」是插隊語音，會在 80 毫秒後才送出；
   時鐘撥太快的話，它在排隊時就被當成過期丟掉 —— 那是測試的假象，不是 App 的行為。
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    window.__said = [];
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => window.__said.push(u.text), cancel: () => {}, getVoices: () => [], onvoiceschanged: null },
      configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  /* 路線：從轉角南方 1500 公尺往北開到轉角，右轉往東開 800 公尺。
     照相在轉角東邊 250 公尺（雙向，不限方向）。時速 50，每秒一筆定位。 */
  const drive = (camEastM, cornerSouthM) => page.evaluate(async ([camEastM, cornerSouthM]) => {
    const M = 1 / 111320, lat0 = 24.8, lon0 = 121.0;
    const mLon = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
    LP.CFG.useSeed = false; LP.clearPacks();
    LP.addPack('t', [[lat0, lon0 + camEastM * mLon, 50, '雙向', '轉角後測速']]);
    LP.CFG.voice = true; LP.CFG.passNotice = true; LP.CFG.onlyOver = false;
    LP.resetTrip(); window.__said.length = 0;
    const v = 50 / 3.6, log = [];
    const step = async (la, lo, hd, where) => {
      window.__clock += 1000;
      const before = window.__said.length;
      LP.onPos(la, lo, hd, v, 5, false);
      await new Promise(r => setTimeout(r, 120));        // 插隊語音 80 毫秒後才送出，等完再收
      window.__said.slice(before).forEach(t => log.push({ where, t }));
    };
    for (let d = cornerSouthM; d > 0; d -= v) await step(lat0 - d * M, lon0, 0, '轉角前 ' + Math.round(d) + ' 公尺');
    for (let e = 0; e <= 800; e += v) await step(lat0, lon0 + e * mLon, 90, '轉角後往東 ' + Math.round(e) + ' 公尺');
    return log;
  }, [camEastM, cornerSouthM]);

  const R = {};
  R.轉角 = await drive(250, 1500);
  /* 對照：直路上開過去，一樣要播「已通過」（不能為了修轉角而把正常的通過提示弄壞） */
  R.直路 = await page.evaluate(async () => {
    const M = 1 / 111320, lat0 = 24.9, lon0 = 121.0;
    LP.clearPacks(); LP.addPack('t', [[lat0, lon0, 50, '北上', '直路測速']]);
    LP.resetTrip(); window.__said.length = 0;
    const v = 50 / 3.6;
    for (let d = 1500; d >= -300; d -= v) {
      window.__clock += 1000; LP.onPos(lat0 - d * M, lon0, 0, v, 5, false);
      await new Promise(r => setTimeout(r, 120));
    }
    return window.__said.slice();
  });
  /* 對照：定位 20 秒才更新一次（一步 280 公尺），直接跨過照相，也要判成通過 */
  R.跨過去 = await page.evaluate(async () => {
    const M = 1 / 111320, lat0 = 24.95, lon0 = 121.0;
    LP.clearPacks(); LP.addPack('t', [[lat0, lon0, 50, '北上', '跨過測速']]);
    LP.resetTrip(); window.__said.length = 0;
    const v = 50 / 3.6;
    for (let d = 1500; d >= -900; d -= v * 20) {
      window.__clock += 20000; LP.onPos(lat0 - d * M, lon0, 0, v, 5, false);
      await new Promise(r => setTimeout(r, 120));
    }
    return { 語音: window.__said.slice(), 已排除: LP.passedCams.size };
  });
  /* 定位誤差補償：誤差越大，前三段越早提醒；「就在前方」不補償 */
  R.誤差補償 = await page.evaluate(() => {
    const v = 100 / 3.6, at = acc => { LP.gpsResetQuality(); for (let i = 0; i < 4; i++) LP.GPSQ.accs.push(acc);
      return [1, 2, 3].map(t => Math.round(LP.tierDist(t, v))).concat(Math.round(LP.preDist(v))); };
    return { 準確: at(5), 誤差100: at(100), 誤差800: at(800) };
  });
  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  const passIdx = R.轉角.findIndex(x => /已通過/.test(x.t));
  ok('轉角前不會播「已通過」', !R.轉角.some(x => /已通過/.test(x.t) && /轉角前/.test(x.where)));
  ok('轉過彎後照常提醒到「就在前方」', R.轉角.some(x => /轉角後/.test(x.where) && /^測速照相，速限50/.test(x.t)));
  ok('真的開過去之後才播「已通過」', passIdx >= 0 && /轉角後往東 (2[5-9]\d|[3-9]\d\d)/.test(R.轉角[passIdx].where));
  ok('轉角前後提醒不重唸（同一級只唸一次）', new Set(R.轉角.map(x => x.t)).size === R.轉角.length);
  ok('直路：開過去仍會播「已通過」', R.直路.some(t => /已通過/.test(t)));
  ok('定位很慢一步跨過去：仍判為通過', R.跨過去.已排除 === 1 && R.跨過去.語音.some(t => /已通過/.test(t)));
  const [a5, a100, a800] = [R.誤差補償.準確, R.誤差補償.誤差100, R.誤差補償.誤差800];
  ok('誤差 100 公尺：前兩段各提早 100 公尺', a100[0] - a5[0] === 100 && a100[1] - a5[1] === 100);
  ok('「就在前方」不因誤差提早', a100[2] === a5[2]);
  ok('補償最多 150 公尺', a800[0] - a5[0] === 150);
  ok('沒有頁面錯誤', errs.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test21 全部通過');
})();
