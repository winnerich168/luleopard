/* 螢幕常亮（Wake Lock）
   使用者要的是「開啟這個網頁就不要休眠」，不是「按了開始導航才不休眠」。

   原本的實作有三個問題：
     1. visibilitychange 監聽器寫在 requestWake() 裡，每呼叫一次就多掛一個
     2. 監聽器只在第一次請求成功時才掛上，第一次失敗就永遠不再試
     3. 只有「開始導航警示」會啟動，「先不開 GPS」完全沒有
   而且瀏覽器主動收回鎖時，畫面上完全看不出來。
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await page.addInitScript(() => {
    // 假的 Wake Lock API，記錄被請求／釋放幾次
    window.__wakeReq = 0; window.__wakeRel = 0;
    const mk = () => {
      const t = new EventTarget();
      t.release = async () => { window.__wakeRel++; t.dispatchEvent(new Event('release')); };
      return t;
    };
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: async () => {
        window.__wakeReq++;
        if (document.visibilityState !== 'visible') { const e = new Error('hidden'); e.name = 'NotAllowedError'; throw e; }
        return mk();
      } }, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  });

  const hide = () => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const show = () => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(900);

  const R = {};

  /* 1. 開啟網頁當下就要生效，而且只請求一次 */
  R.開啟網頁 = await page.evaluate(() => ({
    已取得: LP.WAKE.on, 請求次數: window.__wakeReq,
    狀態列: document.getElementById('lWake').textContent,
  }));

  /* 2. 按「先不開 GPS，只看地圖」也要常亮（原本完全沒有） */
  await page.click('#btnSkip');
  await page.waitForTimeout(250);
  R.只看地圖 = await page.evaluate(() => ({
    已取得: LP.WAKE.on, 狀態列: document.getElementById('lWake').textContent }));

  /* 3. 切到背景再回來 4 次 —— 每次只該多一個請求，不能累積 */
  const before = await page.evaluate(() => window.__wakeReq);
  for (let i = 0; i < 4; i++) { await hide(); await page.waitForTimeout(50); await show(); await page.waitForTimeout(50); }
  R.切換背景4次 = await page.evaluate(b => ({
    新增請求數: window.__wakeReq - b, 已取得: LP.WAKE.on }), before);

  /* 4. 系統主動收回時，畫面不可以還顯示「常亮中」 */
  R.系統收回 = await page.evaluate(async () => {
    await LP.WAKE.lock.release();
    await new Promise(r => setTimeout(r, 50));
    return { 還以為有嗎: LP.WAKE.on, 狀態列: document.getElementById('lWake').textContent,
             原因: LP.WAKE.reason };
  });

  /* 5. 設定關閉／開啟 */
  R.設定開關 = await page.evaluate(async () => {
    await LP.wakeAcquire();
    const 開啟後 = LP.WAKE.on;
    LP.CFG.wake = false; await LP.wakeRelease();
    const 關閉後 = LP.WAKE.on, 關閉文字 = document.getElementById('lWake').textContent;
    LP.CFG.wake = true; await LP.wakeAcquire();
    return { 開啟後, 關閉後, 關閉文字, 重新開啟後: LP.WAKE.on };
  });

  /* 6. 重複呼叫不會重複請求（冪等） */
  R.重複呼叫 = await page.evaluate(async () => {
    const b = window.__wakeReq;
    await LP.wakeAcquire(); await LP.wakeAcquire(); await LP.wakeAcquire();
    return { 多請求了幾次: window.__wakeReq - b, 仍持有: LP.WAKE.on };
  });

  /* 7. 停車進入省電模式時放掉，重新開動要拿回來 */
  R.省電 = await page.evaluate(async () => {
    LP.CFG.powerSave = true;
    await LP.powerEnter();
    await new Promise(r => setTimeout(r, 60));
    const 省電中 = LP.WAKE.on;
    await LP.powerExit();
    await new Promise(r => setTimeout(r, 60));
    return { 省電中放掉了: 省電中 === false, 恢復後拿回來: LP.WAKE.on };
  });

  /* 8. 不支援的瀏覽器要明講，不能靜默失敗 */
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    // 完全沒有 wakeLock（例如 iOS 16.4 以前的 Safari）
    try { delete navigator.wakeLock; } catch (e) {}
    Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
  });
  await p2.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await p2.waitForTimeout(800);
  R.不支援時 = await p2.evaluate(() => ({
    支援: LP.WAKE.supported, 已取得: LP.WAKE.on,
    狀態列: document.getElementById('lWake').textContent,
    設定說明: document.getElementById('wakeHint').textContent,
  }));
  await p2.close();

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('開啟網頁當下就常亮', R.開啟網頁.已取得 === true);
  ok('開啟時只請求一次', R.開啟網頁.請求次數 === 1);
  ok('狀態列顯示「螢幕常亮」', R.開啟網頁.狀態列 === '螢幕常亮');
  ok('只看地圖也常亮', R.只看地圖.已取得 === true);
  ok('切背景 4 次只多 4 個請求（監聽器沒累積）', R.切換背景4次.新增請求數 === 4);
  ok('回到前景會自動拿回來', R.切換背景4次.已取得 === true);
  ok('系統收回時狀態要跟著變', R.系統收回.還以為有嗎 === false);
  ok('系統收回時狀態列改成「未常亮」', R.系統收回.狀態列 === '未常亮');
  ok('系統收回時說得出原因', /收回/.test(R.系統收回.原因));
  ok('設定關閉會真的放掉', R.設定開關.關閉後 === false);
  ok('關閉後狀態列顯示「常亮已關」', R.設定開關.關閉文字 === '常亮已關');
  ok('重新開啟會拿回來', R.設定開關.重新開啟後 === true);
  ok('重複呼叫不重複請求', R.重複呼叫.多請求了幾次 === 0 && R.重複呼叫.仍持有);
  ok('省電模式會放掉螢幕鎖', R.省電.省電中放掉了);
  ok('離開省電模式會拿回來', R.省電.恢復後拿回來 === true);
  ok('不支援時判定為不支援', R.不支援時.支援 === false);
  ok('不支援時不會假裝成功', R.不支援時.已取得 === false);
  ok('不支援時給出可行動的替代方案（自動鎖定設永不）',
     /自動鎖定/.test(R.不支援時.設定說明) && /永不/.test(R.不支援時.設定說明));
  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test14（螢幕常亮）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
