/* test20 — 手機一開機就說「沒有 GPS」

   實地回報：用手機開，一開機就顯示定位不堪用，還叫人「請改用手機測試」。
   定位品質偵測是為了抓「筆電沒有 GPS 晶片」設計的，套在剛開機、停著的手機上全部誤判：
     · 剛開機先給幾筆 Wi-Fi／基地台的粗略位置（誤差上千公尺），10～30 秒後才鎖定衛星
     · 停著不動時瀏覽器很久才回報一次、座標一樣、不給車速 —— 這些都是正常的
   這支用 iPhone 的 User-Agent 開頁面，確認：
     1. 開機暖機期只顯示「正在搜尋 GPS 衛星」，不是紅色警告
     2. 鎖定衛星後、停著不動：不顯示任何警告
     3. 在室內一直收不到衛星、停著：黃色提醒「GPS 訊號弱」，不會叫人改用手機
     4. 手機開起來了但定位很差：照樣要警告（不能為了不誤判就全部放過）
     5. 設定頁「📡 定位」卡片看得出定位來源，重新搜尋 GPS 可用
*/
const { chromium } = require('playwright');
const path = require('path');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 },
    hasTouch: true, isMobile: true, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [], onvoiceschanged: null }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    // 不讓真的定位介入，全部由測試餵資料
    Object.defineProperty(navigator, 'geolocation', { value: {
      watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: () => {} }, configurable: true });
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const state = () => page.evaluate(() => ({
    品質: LP.GPSQ.level, 說明: LP.GPSQ.reason,
    警告列: document.getElementById('gpsWarn').classList.contains('hidden') ? '(不顯示)'
      : document.getElementById('gpsWarn').className + ' | ' + document.getElementById('gpsWarnTitle').textContent
        + ' | ' + document.getElementById('gpsWarnBody').textContent,
    狀態列: document.getElementById('lGps').textContent }));
  // 餵一段定位：每筆 [秒, 精度, 位移公尺, 車速 m/s 或 null]
  const feed = (rows, reset) => page.evaluate(([rows, reset]) => {
    if (reset) { LP.gpsResetQuality(); LP.GPS.last = null; }
    let lat = 25.0330;
    for (const [sec, acc, move, spd] of rows) {
      window.__clock += sec * 1000;
      lat += move / 111320;
      LP.onPos(lat, 121.5654, spd != null && spd > 1 ? 0 : null, spd, acc, false);
    }
  }, [rows, reset]);

  const R = {};
  R.是手機 = await page.evaluate(() => LP.IS_MOBILE);

  /* 1. 剛開機：前幾筆是 Wi-Fi 粗略位置 */
  await feed([[1, 1800, 0, null], [2, 1200, 30, null], [2, 900, 20, null], [3, 400, 10, null]], true);
  R.暖機 = await state();

  /* 2. 鎖定衛星後、停在家門口：誤差 8 公尺，瀏覽器每 10 秒才回報、座標幾乎不動、沒有車速 */
  await feed(Array.from({ length: 10 }, () => [10, 8, 0.5, null]));
  R.停著鎖定衛星 = await state();
  await page.evaluate(() => document.querySelector('[data-v="set"], [data-view="v-set"]')?.click());
  R.卡片_衛星 = await page.evaluate(() => { LP.paintGpsCard(); return {
    來源: document.getElementById('gpsCardState').textContent,
    誤差: document.getElementById('gpsCardAcc').textContent,
    車速: document.getElementById('gpsCardSpd').textContent }; });

  /* 3. 在室內一直收不到衛星，停著 */
  await feed(Array.from({ length: 8 }, () => [12, 65, 0, null]), true);
  await page.evaluate(() => { window.__clock += 40000; });
  await feed([[12, 70, 0, null], [12, 65, 0, null]]);
  R.室內停著 = await state();
  R.卡片_室內 = await page.evaluate(() => { LP.paintGpsCard(); return document.getElementById('gpsCardState').textContent; });

  /* 4. 開上路了，定位卻很差（誤差 300、20 秒一次）→ 要警告 */
  await feed(Array.from({ length: 8 }, () => [20, 300, 550, null]), true);
  R.開車定位差 = await state();

  /* 5. 正常開車：誤差 6、每秒一次、有車速 */
  await feed(Array.from({ length: 12 }, () => [1, 6, 28, 28]), true);
  await page.evaluate(() => { window.__clock += 31000; });
  await feed(Array.from({ length: 4 }, () => [1, 6, 28, 28]));
  R.正常開車 = await state();

  /* 6. 重新搜尋 GPS */
  R.重新搜尋 = await page.evaluate(() => {
    let cleared = 0, started = 0;
    navigator.geolocation.clearWatch = () => { cleared++; };
    navigator.geolocation.watchPosition = () => { started++; return 2; };
    document.getElementById('btnGpsRestart').click();
    return { cleared, started, 已清除品質: LP.GPSQ.samples === 0 };
  });
  R.說明預設展開 = await page.evaluate(() => ({
    iPhone: document.getElementById('gpsHelpIos').open, Android: document.getElementById('gpsHelpAndroid').open }));
  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  const 不叫人改用手機 = s => !/改用手機|筆電/.test(s.警告列);
  ok('iPhone 被認成手機', R.是手機 === true);
  ok('開機暖機期顯示「正在搜尋 GPS 衛星」', R.暖機.品質 === 'searching' && /搜尋 GPS 衛星/.test(R.暖機.警告列));
  ok('暖機期不是紅色警告', !/\bbad\b/.test(R.暖機.警告列));
  ok('鎖定衛星後停著：判為 good、不顯示警告', R.停著鎖定衛星.品質 === 'good' && R.停著鎖定衛星.警告列 === '(不顯示)');
  ok('停著的狀態列顯示 GPS 已定位', R.停著鎖定衛星.狀態列 === 'GPS 已定位');
  ok('設定卡片顯示 GPS 衛星', /GPS 衛星/.test(R.卡片_衛星.來源) && R.卡片_衛星.誤差 === '±8 公尺');
  ok('停著沒車速時說明是正常的', /停著時正常/.test(R.卡片_衛星.車速));
  ok('室內停著：黃色提醒，不是紅色', R.室內停著.品質 === 'poor' && /\bwarn\b/.test(R.室內停著.警告列));
  ok('室內提醒說得出原因與去哪裡看', /室內/.test(R.室內停著.警告列) && /設定/.test(R.室內停著.警告列));
  ok('設定卡片看得出衛星訊號弱', /衛星訊號弱/.test(R.卡片_室內));
  ok('開車時定位差仍要紅色警告', R.開車定位差.品質 === 'unusable' && /\bbad\b/.test(R.開車定位差.警告列));
  ok('手機上所有警告都不叫人改用手機', [R.暖機, R.室內停著, R.開車定位差].every(不叫人改用手機));
  ok('正常開車判為 good', R.正常開車.品質 === 'good' && R.正常開車.警告列 === '(不顯示)');
  ok('重新搜尋會重啟定位並清掉舊的品質紀錄', R.重新搜尋.cleared === 1 && R.重新搜尋.started === 1 && R.重新搜尋.已清除品質);
  ok('iPhone 預設展開 iPhone 的設定說明', R.說明預設展開.iPhone && !R.說明預設展開.Android);
  ok('沒有頁面錯誤', errs.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test20 全部通過');
})();
