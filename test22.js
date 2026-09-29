/* test22 — 區間測速：途中的平均時速、起點與終點的位置、超速提醒的時機

   實際模擬時發現兩件事：
   1. 進入起點 150 公尺範圍就開始算 —— 提早 100 多公尺起算，終點也跟著提早結束，
      平均時速跟官方（起點到終點的時間）對不起來
   2. 一進區間、才開 20 公尺就說「區間平均時速 73，已超過速限」—— 那只是當下車速
   現在：開過起點那一刻才起算（已開過的距離與時間補回去）；開滿 500 公尺才判斷平均超速。

   用 page.clock 控制時間，平均時速才算得準。
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.clock.install({ time: new Date('2026-09-29T08:00:00') });
  await page.addInitScript(() => {
    window.__said = [];
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => window.__said.push(u.text), cancel: () => {}, getVoices: () => [], onvoiceschanged: null },
      configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.clock.runFor(1500);
  await page.click('#btnStart');
  await page.clock.runFor(1000);

  /* 4 公里區間、速限 60。前 2 公里時速 80，後 2 公里時速 50 → 全程平均約 61.5… 其實是 4/(2/80+2/50)=61.5 */
  const drive = async (plan, stepSec) => {
    await page.evaluate(() => {
      LP.CFG.useSeed = false; LP.clearPacks();
      LP.addPack('t', [[24.7, 121.0, 60, '北往南(區間測速)', '測試路 10K至14K']]);
      LP.resetTrip(); window.__said.length = 0;
    });
    const M = 1 / 111320, rows = [];
    for (let m = -400; m <= 4400;) {
      const kmh = plan(m), v = kmh / 3.6;
      const before = await page.evaluate(() => window.__said.length);
      await page.evaluate(([la, v]) => LP.onPos(la, 121.0, 180, v, 5, false), [24.7 - m * M, v]);
      await page.clock.runFor(stepSec * 1000);
      const r = await page.evaluate(b => ({ said: window.__said.slice(b), sec: LP.SECTION() && { dist: LP.SECTION().distM, avg: LP.SECTION().avg },
        row: document.getElementById('secRowTx').textContent }), before);
      r.said.forEach(t => rows.push({ m: Math.round(m), t }));
      if (Math.round(m) % 1000 < v * stepSec) rows.push({ m: Math.round(m), row: r.row, avg: r.sec && Math.round(r.sec.avg) });
      m += v * stepSec;
    }
    return rows;
  };

  const R = {};
  R.先快後慢 = await drive(m => (m < 2000 ? 80 : 50), 1);
  R.全程超速 = await drive(() => 75, 1);
  R.定位5秒一次 = await drive(() => 55, 5);
  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  const at = (rows, re) => rows.find(x => x.t && re.test(x.t));
  const enter = at(R.先快後慢, /進入區間測速/), end = at(R.先快後慢, /區間測速結束/);
  ok('開到起點附近才起算（誤差 30 公尺內）', enter && Math.abs(enter.m) <= 30);
  ok('終點落在全長 4 公里附近（誤差 60 公尺內）', end && Math.abs(end.m - 4000) <= 60);
  ok('途中畫面顯示剩餘距離與可跑速度', R.先快後慢.some(x => x.row && /剩 .*可跑 \d+/.test(x.row)));
  const early = at(R.先快後慢, /區間平均時速\d+，已超過/);
  ok('開滿 500 公尺才判斷平均超速', !early || early.m >= 500);
  ok('先快後慢：途中有提醒平均超速', !!early);
  const avgEnd = +(end && end.t.match(/平均時速(\d+)/)[1]);
  ok('先快後慢：最終平均約 61（官方算法 4 公里 ÷ 總時間）', Math.abs(avgEnd - 61.5) <= 2);
  ok('全程時速 75：結束時報超速', /超過速限60/.test((at(R.全程超速, /區間測速結束/) || {}).t || ''));
  const e5 = at(R.定位5秒一次, /進入區間測速/), x5 = at(R.定位5秒一次, /區間測速結束/);
  ok('定位 5 秒一次：起算位置仍在起點附近（補回已開過的距離）', e5 && Math.abs(e5.m) <= 80);
  ok('定位 5 秒一次：最終平均約 55', x5 && Math.abs(+x5.t.match(/平均時速(\d+)/)[1] - 55) <= 2);
  ok('沒有頁面錯誤', errs.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test22 全部通過');
})();
