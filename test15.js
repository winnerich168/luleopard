/* 實地測試回報的兩件事
   1. 通過固定測速照相後，畫面距離不但沒消失還繼續往上加（看起來像有正負號）
      → 改成明確記錄「這一趟已通過」，之後一律不再選它
   2. 通過時要語音提示「已通過」
   （原本的第 3 項「交流道預報」改由 test26 測試）
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => window.__spoken.push(u.text), cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    // 虛擬時鐘：測試在幾毫秒內把車移動幾百公尺，真實時鐘下 App 會（正確地）
    // 判定成定位跳點而忽略。要讓模擬的時間跟移動距離相符才測得準。
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(900);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const R = {};

  /* 開過一個測速點，記錄全程畫面距離與語音。sec = 定位間隔秒數 */
  const drive = (sec, dirFilter, passNotice) => page.evaluate(async o => {
    LP.CFG.voice = true; LP.CFG.dirFilter = o.dirFilter; LP.CFG.onlyOver = false;
    LP.CFG.passNotice = o.passNotice; LP.CFG.icNotice = false;
    LP.resetTrip(); LP.GPS.last = null; LP.gpsResetQuality();
    window.__spoken.length = 0;
    const c = LP.CAMS().find(x => /國道三號南向423/.test(x.name || ''));
    const step = (100 / 3.6) * o.sec;
    const log = [];
    for (let d = 800; d >= -900; d -= step) {
      window.__clock += o.sec * 1000;
      LP.onPos(c.lat + d / 111320, c.lon, 180, 100 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 12));
      log.push({ 真實: Math.round(d), 畫面: document.getElementById('alertDist').textContent });
    }
    // 通過後仍顯示距離的那些格（-30 m 之後還在顯示 = 錯的）
    const 過後顯示 = log.filter(x => x.真實 < -30 && x.畫面).map(x => x.畫面);
    return { 過後顯示, 語音: window.__spoken.slice(), 已標記通過: LP.passedCams.size };
  }, { sec, dirFilter, passNotice });

  R['1秒更新'] = await drive(1, true, true);
  R['3秒更新'] = await drive(3, true, true);
  R['5秒更新'] = await drive(5, true, true);
  R['關閉通過提示'] = await drive(1, true, false);

  /* 通過之後就算又靠近（例如折返、定位跳點）也不該重新選它 */
  R.不會復活 = await page.evaluate(async () => {
    LP.CFG.voice = true; LP.CFG.dirFilter = true; LP.CFG.passNotice = true; LP.CFG.icNotice = false;
    LP.resetTrip(); LP.GPS.last = null;
    const c = LP.CAMS().find(x => /國道三號南向423/.test(x.name || ''));
    for (let d = 800; d >= -600; d -= 28) {
      window.__clock += 1000;
      LP.onPos(c.lat + d / 111320, c.lon, 180, 100 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 8));
    }
    const 通過後 = LP.passedCams.size;
    window.__spoken.length = 0;
    // 定位跳回它前方（模擬跳點）
    LP.GPS.last = null;
    for (let d = 400; d >= 100; d -= 28) {
      window.__clock += 1000;
      LP.onPos(c.lat + d / 111320, c.lon, 180, 100 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 8));
    }
    return { 通過後: 通過後, 跳回前方後又出聲: window.__spoken.length,
             畫面: document.getElementById('alertDist').textContent };
  });

  /* 交流道（出口）預報改由 test26 測試：只報正在走的那條路、2 公里前、地圖顯示兩個出口 */

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };

  for (const k of ['1秒更新', '3秒更新', '5秒更新', '關閉通過提示']) {
    ok(`${k}：通過後畫面不再顯示距離`, R[k].過後顯示.length === 0);
    ok(`${k}：有標記為已通過`, R[k].已標記通過 >= 1);
  }
  ok('通過時會語音提示', R['1秒更新'].語音.some(t => /已通過/.test(t)));
  ok('提示文字說得出是什麼通過了', R['1秒更新'].語音.some(t => /測速照相已通過/.test(t)));
  ok('關閉設定就不提示通過', !R['關閉通過提示'].語音.some(t => /已通過/.test(t)));
  ok('關閉提示後仍正確排除（不是靠提示才排除）', R['關閉通過提示'].過後顯示.length === 0);
  ok('通過後定位跳回前方也不會復活', R.不會復活.跳回前方後又出聲 === 0 && !R.不會復活.畫面);

  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test15（通過提示與交流道預報）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
