/* v0.6：旅程記錄 + 區間測速即時平均車速 */
const { chromium } = require('playwright');
const path = require('path');

/* 沿正南方向以固定時速行駛，每步 stepM 公尺，時鐘同步前進 */
const driveScript = `
window.__drive = (startLat, lon, kmh, totalM, stepM) => {
  const v = kmh / 3.6;
  let lat = startLat;
  for (let done = 0; done < totalM; done += stepM) {
    window.__clock += (stepM / v) * 1000;
    lat -= stepM / 111320;
    LP.onPos(lat, lon, 180, v, 6, true);
  }
  return lat;
};`;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });
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
  await page.addScriptTag({ content: driveScript });
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const R = {};

  // ── 1. 區間起訖解析 ──
  R.parseSection = await page.evaluate(() => ({
    '台9線68k+600m至56k+600m': LP.parseSection('宜蘭縣頭城鎮 台9線68k+600m至56k+600m'),
    '台3線82.2公里至84.3公里': LP.parseSection('新竹縣峨眉鄉 台3線82.2公里至84.3公里'),
    '台9線129k+404m至136k+883m': LP.parseSection('宜蘭縣南澳鄉 台9線129k+404m至136k+883m(觀音隧道)'),
    '110k+960m至108k+224m': LP.parseSection('南澳鄉台9線110k+960m至蘇澳鎮台9線108k+224m(東澳隧道)'),
    '國道5號 15K-28K': LP.parseSection('宜蘭縣 國道5號南下 15K-28K'),
    '沒寫範圍(應為null)': LP.parseSection('新竹縣新豐鄉 台15線鳳鼻隧道'),
    '一般測速點(應為null)': LP.parseSection('新竹縣竹北市 中華路與興隆路口'),
  }));

  // ── 2. 全程守法通過 2.1 公里區間（速限 60，跑 55）──
  R.sectionLegal = await page.evaluate(() => {
    LP.clearPacks(); LP.resetTrip();
    LP.addPack('區間測試', [[24.70, 121.00, 60, '南北雙向(區間測速)', '測試縣 台3線82.2公里至84.3公里']]);
    window.__spoken.length = 0;
    // 從區間點北方 400m 開始，一路往南跑完 2.1 公里 + 餘裕
    window.__drive(24.70 + 400 / 111320, 121.00, 55, 3000, 50);
    const t = LP.TRIP();
    return { sections: t.sections.length, rec: t.sections[0],
             spoken: window.__spoken.filter(x => /區間/.test(x)) };
  });

  // ── 3. 超速通過同一個區間（速限 60，跑 90）──
  R.sectionOver = await page.evaluate(() => {
    LP.resetTrip();
    window.__clock += 30 * 60e3;                 // 跳過 20 分鐘的重複進入保護
    window.__spoken.length = 0;
    window.__drive(24.70 + 400 / 111320, 121.00, 90, 3000, 50);
    const t = LP.TRIP();
    return { rec: t.sections[0], spoken: window.__spoken.filter(x => /區間|平均/.test(x)) };
  });

  // ── 4. 區間進行中：平均、剩餘、剩下可跑多快 ──
  R.sectionLive = await page.evaluate(() => {
    LP.resetTrip();
    window.__clock += 30 * 60e3;
    // 前半段用 90 衝，停在區間中途看即時數字
    window.__drive(24.70 + 400 / 111320, 121.00, 90, 400 + 1000, 50);
    const s = LP.SECTION();
    if (!s) return 'SECTION 沒有啟動';
    return { avg: Math.round(s.avg), limit: s.limit,
             走了: Math.round(s.distM), 全長: s.lengthM, 剩餘: Math.round(s.remainM),
             剩下可跑: Math.round(s.maxRemain),
             hudShown: document.getElementById('secRow').className,
             hudText: document.getElementById('secRowTx').textContent,
             hudAvg: document.getElementById('secRowAvg').textContent.trim() };
  });

  // ── 5. 放慢真的救得回來 ──
  R.sectionRecover = await page.evaluate(() => {
    const before = Math.round(LP.SECTION().avg);
    // 剩下 1.1 公里用 30 慢慢開
    window.__drive(LP.GPS.last.lat, 121.00, 30, 1100, 50);
    const t = LP.TRIP();
    return { 中途平均: before, 最終平均: t.sections[0] && t.sections[0].avg,
             最終判定: t.sections[0] && (t.sections[0].over ? '超速' : '未超速') };
  });

  // ── 6. 旅程統計 ──
  R.tripStats = await page.evaluate(() => {
    LP.resetTrip();
    window.__clock += 30 * 60e3;
    window.__drive(24.60, 121.00, 80, 5000, 100);
    const t = LP.TRIP();
    return { 里程m: Math.round(t.distM), 最高時速: Math.round(t.maxSpd),
             行駛平均: Math.round(t.distM / (t.movingMs / 1000) * 3.6) };
  });

  // ── 7. 通過測速點會記錄當時車速與是否超速 ──
  R.passed = await page.evaluate(() => {
    LP.clearPacks(); LP.resetTrip();
    window.__clock += 30 * 60e3;
    LP.addPack('通過測試', [
      [24.50, 121.00, 60, '南北雙向', '測試縣 甲路段'],      // 跑 90 → 超速
      [24.48, 121.00, 100, '南北雙向', '測試縣 乙路段'],     // 跑 90 → 沒超速
    ]);
    window.__drive(24.51, 121.00, 90, 4000, 40);
    return LP.TRIP().passed.map(p => ({ name: p.name, spd: p.spd, lim: p.lim, over: p.over }));
  });

  // ── 8. 前方清單：只列同向、在前方的，含區間 ──
  R.upcoming = await page.evaluate(() => {
    LP.clearPacks(); LP.resetTrip();
    LP.addPack('前方測試', [
      [24.40, 121.00, 60, '南北雙向', 'A 正前方 2km'],
      [24.30, 121.00, 70, '南北雙向(區間測速)', 'B 區間 台3線82.2公里至84.3公里'],
      [24.45, 121.00, 50, '南北雙向', 'C 後方'],
      [24.35, 121.00, 50, '北上方向', 'D 對向'],
      [24.38, 121.20, 50, '南北雙向', 'E 側邊很遠'],
    ]);
    LP.onPos(24.42, 121.00, 180, 90 / 3.6, 6, true);
    const up = LP.upcomingCams(LP.GPS.last, 20);
    return up.map(x => ({ name: x.cam.name, km: +(x.d / 1000).toFixed(1), sec: x.cam.sec }));
  });

  // ── 9. 沒有起訖里程的區間也要能用（只是沒有剩餘距離）──
  R.noLength = await page.evaluate(() => {
    LP.clearPacks(); LP.resetTrip();
    window.__clock += 30 * 60e3;
    LP.addPack('無長度', [[24.20, 121.00, 60, '南北雙向(區間測速)', '新竹縣新豐鄉 台15線鳳鼻隧道']]);
    window.__drive(24.20 + 300 / 111320, 121.00, 70, 1500, 50);
    const s = LP.SECTION();
    return s ? { avg: Math.round(s.avg), lengthM: s.lengthM, remainM: s.remainM,
                 hint: document.getElementById('secHint') && true } : '沒啟動';
  });

  // ── 10. UI ──
  await page.evaluate(() => { if (LP.SECTION()) document.getElementById('btnSecAbort').click(); });
  await page.click('#tabs button[data-v="trip"]');
  await page.waitForTimeout(300);
  R.ui = {
    tabs: await page.$$eval('#tabs button', b => b.map(x => x.textContent.trim())),
    stats: (await page.textContent('#tripStats')).replace(/\s+/g, ' ').trim().slice(0, 100),
    upCount: await page.textContent('#upCount'),
  };
  // 重新跑一段區間，截圖進行中的畫面
  await page.evaluate(() => {
    LP.clearPacks(); LP.resetTrip();
    window.__clock += 30 * 60e3;
    LP.addPack('區間', [[24.10, 121.00, 60, '南北雙向(區間測速)', '宜蘭縣 台3線82.2公里至84.3公里']]);
    window.__drive(24.10 + 300 / 111320, 121.00, 85, 300 + 900, 50);
    LP.renderTrip();
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'shot-trip.png' });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
})();
