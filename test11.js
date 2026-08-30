/* 重現「筆電在車上測，不播報、車速 lag」
   筆電沒有 GPS 晶片，瀏覽器用 Wi-Fi / IP 定位，特徵是：
     - coords.speed   = null（沒有硬體測速）
     - coords.heading = null（沒有硬體航向）
     - coords.accuracy = 幾百到幾千公尺
     - 更新間隔 10~30 秒，位置一次跳好幾百公尺，有時整個凍住不動
   這支測試把這些特徵餵進 onPos，看警示引擎會怎樣。
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => window.__spoken.push(u.text), cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const R = {};

  /* 共用：挑一個測速點，從正北方沿經線開過去 */
  const drive = async (opts) => page.evaluate(async o => {
    LP.CFG.voice = true; LP.CFG.onlyOver = false;
    LP.CFG.dirFilter = o.dirFilter;
    LP.CFG.powerSave = o.powerSave;
    LP.resetTrip(); LP.PROBE.cruise.length = 0; LP.PROBE.watch.clear();
    LP.gpsResetQuality(); LP.GPS.last = null;
    window.__spoken.length = 0;

    const c = LP.CAMS().find(x => x.lat && x.lon && x.dir && /南/.test(x.dir));
    const 速度 = o.kmh / 3.6;                       // m/s（真實車速）
    const 每次間隔 = o.intervalSec;                  // 秒
    const 每步距離 = 速度 * 每次間隔;                 // 公尺

    const 軌跡 = [];
    // 從 3 公里外開到 1 公里後
    for (let d = 3000; d >= -1000; d -= 每步距離) {
      window.__clock += 每次間隔 * 1000;
      // Wi-Fi 定位的雜訊：位置會亂飄
      const 雜訊 = o.noiseM ? (Math.sin(d / 137) * o.noiseM) : 0;
      const lat = c.lat + (d + 雜訊) / 111320;
      LP.onPos(lat, c.lon,
               o.hasHeading ? 180 : null,
               o.hasSpeed ? 速度 : null,
               o.accuracy, false);      // false = 走真實定位路徑，品質偵測才會啟動
      軌跡.push({ 剩餘公尺: Math.round(d), 畫面車速: document.getElementById('spd').textContent });
      await new Promise(r => setTimeout(r, 5));
    }
    return {
      目標: c.name, 速限: c.lim,
      每步距離: Math.round(每步距離),
      語音: window.__spoken.slice(),
      畫面車速取樣: 軌跡.filter((_, i) => i % 3 === 0).slice(0, 6),
      省電中: LP.POWER.saving,
      定位品質: LP.GPSQ.level, 品質說明: LP.GPSQ.reason,
      警告列: document.getElementById('gpsWarn').classList.contains('hidden') ? '(不顯示)'
              : document.getElementById('gpsWarnTitle').textContent
    };
  }, opts);

  /* ── 1. 真手機：有硬體速度與航向、1 秒一次、精度 8 公尺 ── */
  R['A_真手機_基準'] = await drive({
    kmh: 100, intervalSec: 1, accuracy: 8,
    hasSpeed: true, hasHeading: true, noiseM: 0, dirFilter: true, powerSave: true });

  /* ── 2. 筆電：無速度、無航向、精度 800 公尺、20 秒一次 ── */
  R['B_筆電_實際情況'] = await drive({
    kmh: 100, intervalSec: 20, accuracy: 800,
    hasSpeed: false, hasHeading: false, noiseM: 150, dirFilter: true, powerSave: true });

  /* ── 3. 拆解：只把「更新間隔」變回 1 秒，其他維持筆電條件 ── */
  R['C_筆電但1秒更新'] = await drive({
    kmh: 100, intervalSec: 1, accuracy: 800,
    hasSpeed: false, hasHeading: false, noiseM: 150, dirFilter: true, powerSave: true });

  /* ── 4. 拆解：20 秒間隔但有速度與航向 ── */
  R['D_20秒但有速度航向'] = await drive({
    kmh: 100, intervalSec: 20, accuracy: 8,
    hasSpeed: true, hasHeading: true, noiseM: 0, dirFilter: true, powerSave: true });

  /* ── 5. 拆解：關掉方向過濾，看是不是方向把它濾掉 ── */
  R['E_筆電且關方向過濾'] = await drive({
    kmh: 100, intervalSec: 20, accuracy: 800,
    hasSpeed: false, hasHeading: false, noiseM: 150, dirFilter: false, powerSave: true });

  /* ── 6. 位置整個凍住（Wi-Fi 快取沒更新）會怎樣 ── */
  R['F_位置凍住'] = await page.evaluate(async () => {
    LP.CFG.powerSave = true; LP.resetTrip(); window.__spoken.length = 0;
    LP.gpsResetQuality(); LP.GPS.last = null;
    const c = LP.CAMS().find(x => x.lat && x.lon);
    const 觀察 = [];
    for (let i = 0; i < 40; i++) {
      window.__clock += 20000;                       // 每 20 秒一次
      LP.onPos(c.lat + 0.02, c.lon, null, null, 800, false);  // 完全同一個座標
      if (i % 10 === 0) 觀察.push({ 分鐘: Math.round(i * 20 / 60),
                                   畫面車速: document.getElementById('spd').textContent,
                                   省電中: LP.POWER.saving });
    }
    return { 觀察, 語音數: window.__spoken.length,
             定位品質: LP.GPSQ.level, 品質說明: LP.GPSQ.reason,
             警告列: document.getElementById('gpsWarnTitle').textContent };
  });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  const 有速度數字 = a => a.some(x => /你目前\d+/.test(x));
  const 車速字串 = r => r.畫面車速取樣.map(x => x.畫面車速);

  // A：真手機不該有任何退化
  ok('A 真手機三級警示都在', R.A_真手機_基準.語音.length >= 3);
  ok('A 真手機車速顯示正確', 車速字串(R.A_真手機_基準).every(v => v === '100'));
  ok('A 真手機定位品質判為 good', R.A_真手機_基準.定位品質 === 'good');
  ok('A 真手機不顯示警告列', R.A_真手機_基準.警告列 === '(不顯示)');

  // B：筆電條件下必須「明講不堪用」，且不可顯示假車速
  ok('B 筆電判為 unusable', R.B_筆電_實際情況.定位品質 === 'unusable');
  ok('B 筆電顯示警告列', /不足以做行車警示/.test(R.B_筆電_實際情況.警告列));
  ok('B 說明有講到誤差與更新頻率',
     /誤差/.test(R.B_筆電_實際情況.品質說明) && /更新/.test(R.B_筆電_實際情況.品質說明));
  ok('B 車速一律顯示 --（不顯示假數字）', 車速字串(R.B_筆電_實際情況).every(v => v === '--'));
  ok('B 仍盡力發出警示', R.B_筆電_實際情況.語音.length >= 2);
  ok('B 不唸不可信的車速', !有速度數字(R.B_筆電_實際情況.語音));

  // C：一秒更新但精度差 —— 這是以前噴出 14004 km/h 假警示的情境
  ok('C 不再出現離譜車速', 車速字串(R.C_筆電但1秒更新).every(v => v === '--' || Number(v) <= 220));
  ok('C 不唸不可信的車速', !有速度數字(R.C_筆電但1秒更新.語音));
  ok('C 沒有其他速限的誤報', R.C_筆電但1秒更新.語音.every(t => /速限110/.test(t)));

  // D：更新間隔補償 —— 20 秒一次時，預告要提前，不能等到眼前才響
  ok('D 至少兩次警示（含提前預告）', R.D_20秒但有速度航向.語音.length >= 2);
  ok('D 第一次預告在 500 公尺以外', (() => {
    const m = R.D_20秒但有速度航向.語音[0].match(/前方(\d+)公尺/);
    return m && Number(m[1]) >= 500;
  })());

  // F：定位凍住不可以被當成「停車」而靜悄悄進入省電
  ok('F 定位凍住不進入省電', R.F_位置凍住.觀察.every(o => o.省電中 === false));
  ok('F 明講位置已停止更新', /位置已停止更新/.test(R.F_位置凍住.品質說明));
  ok('F 凍住時不顯示假車速', R.F_位置凍住.觀察.every(o => o.畫面車速 === '--'));

  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test11（定位品質降級）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
