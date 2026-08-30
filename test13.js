/* 一鍵加入測速點（地圖頁快捷鍵）
   測速點跟掉落物／事故不同：它不會過期，要長期留在點位資料庫裡。
   所以走 REPORTS 而不是 HAZARDS，按完要立刻納入前方警示。
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
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(900);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const R = {};

  /* 1. 三顆快捷鍵都在、尺寸與顏色分得開（開車時不看螢幕也要摸得出來） */
  R.按鈕 = await page.evaluate(() => {
    const g = id => { const e = document.getElementById(id); const r = e.getBoundingClientRect();
                      return { 有: !!e, 寬: Math.round(r.width), 高: Math.round(r.height),
                               文字: e.textContent.trim(),
                               底色: getComputedStyle(e).backgroundImage.match(/rgb\([^)]+\)/)?.[0] || '' }; };
    return { 掉落物: g('fabQuick'), 事故: g('fabCrash'), 測速: g('fabCam'), 其他: g('fabMore') };
  });

  /* 2. 沒有 GPS 時要明講，不能靜默失敗 */
  R.無GPS = await page.evaluate(() => {
    const before = LP.REPORTS().length;
    LP.GPS.last = null;
    LP.quickCam();
    return { 新增了嗎: LP.REPORTS().length - before,
             提示: document.getElementById('toast').textContent };
  });

  /* 3. 正常按下：加入點位、立刻進資料庫、備註帶樁號與方向 */
  R.加入 = await page.evaluate(() => {
    LP.setReports([]);
    const camsBefore = LP.CAMS().length;
    // 沿國道 1 號南下開一段，讓樁號推算有依據
    for (let i = 0; i < 6; i++) LP.onPos(25.05 - i * 0.002, 121.29, 180, 100 / 3.6, 8, true);
    LP.quickCam();
    const reps = LP.REPORTS();
    const r = reps[0];
    const inDb = LP.CAMS().filter(c => c.src === 'user').length;
    return { 回報數: reps.length, 種類: r.kind, 備註: r.note,
             進了資料庫: inDb, 資料庫增加: LP.CAMS().length - camsBefore,
             有復原鈕: !!document.getElementById('camUndoBtn'),
             提示文字: document.getElementById('toast').textContent.trim() };
  });

  /* 4. 位置要往回退（看到才按得下去），不是標在按下去的當下 */
  R.往回退 = await page.evaluate(() => {
    LP.setReports([]);
    for (let i = 0; i < 6; i++) LP.onPos(24.5 - i * 0.002, 121.0, 180, 100 / 3.6, 8, true);
    const me = LP.GPS.last;
    LP.quickCam();
    const r = LP.REPORTS()[0];
    return { 退了幾公尺: Math.round(LP.dist(me.lat, me.lon, r.lat, r.lon)),
             // 南下（heading 180）→ 點應該在我北邊（緯度較大）
             在我後方: r.lat > me.lat };
  });

  /* 5. 復原鈕真的會移除 */
  R.復原 = await page.evaluate(async () => {
    LP.setReports([]);
    for (let i = 0; i < 6; i++) LP.onPos(24.4 - i * 0.002, 121.0, 180, 80 / 3.6, 8, true);
    LP.quickCam();
    const 加入後 = LP.REPORTS().length;
    document.getElementById('camUndoBtn').click();
    await new Promise(r => setTimeout(r, 50));
    return { 加入後, 復原後: LP.REPORTS().length, 資料庫剩: LP.CAMS().filter(c => c.src === 'user').length };
  });

  /* 6. 加進去之後，開過去真的會警示 */
  R.會警示 = await page.evaluate(async () => {
    LP.setReports([]);
    LP.CFG.voice = true; LP.CFG.dirFilter = false; LP.CFG.onlyOver = false;
    // 在一個空曠處放點，避免撞到內建點位
    const LAT = 23.55, LON = 120.05;
    LP.setReports([{ id: 'rx', lat: LAT, lon: LON, kind: '測速點', lim: 50, note: '測試', t: Date.now() }]);
    LP.resetTrip(); LP.GPS.last = null;
    window.__spoken.length = 0;
    for (const d of [900, 500, 250, 60]) {
      LP.onPos(LAT + d / 111320, LON, 180, 70 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 1200));
    }
    return { 語音: window.__spoken.slice() };
  });

  /* 7. 定位不堪用時要擋下來，不要標一個爛點進資料庫 */
  R.定位差時擋下 = await page.evaluate(() => {
    LP.setReports([]);
    LP.gpsResetQuality(); LP.GPS.last = null;
    for (let i = 0; i < 6; i++) LP.onPos(24.2 + i * 0.00001, 121.0, null, null, 900, false);
    LP.quickCam();
    return { 新增數: LP.REPORTS().length, 品質: LP.GPSQ.level,
             提示: document.getElementById('toast').textContent };
  });

  /* 8. 公測標示：起始畫面、HUD、設定頁三處都要有，且版本字串一致 */
  R.公測標示 = await page.evaluate(() => {
    const t = id => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
    const row = document.getElementById('statusRow').getBoundingClientRect();
    return { 常數版本: LP.APP_VER, 常數階段: LP.APP_STAGE, 常數序號: LP.APP_BUILD,
             HUD徽章: t('hudBadge'), HUD提示: document.getElementById('hudBadge').title,
             設定頁: t('setVer'), 起始畫面: t('gateVer'),
             HUD短序號: t('hudBuild'), HUD序號提示: document.getElementById('hudBuild').title,
             HUD徽章寬度: Math.round(document.getElementById('hudBadge').getBoundingClientRect().width),
             狀態列高度: Math.round(row.height) };
  });

  /* 9. 出處標示：授權條件要求，不能只寫在 repo 裡 */
  R.出處標示 = await page.evaluate(() => {
    const about = document.getElementById('aboutBox').textContent;
    return {
      有政府資料授權: /政府資料開放授權條款第1版/.test(about),
      有警政署: /警政署/.test(about),
      有OSM: /OpenStreetMap contributors/.test(about),
      有ODbL: /ODbL/.test(about),
      有程式庫授權: /Leaflet/.test(about) && /fflate/.test(about),
      有著作權: /winnerich168/.test(about) && /保留所有權利/.test(about),
      有隱私聲明: /不記錄行車軌跡/.test(about),
      有免責: /以現場標誌與實際路況為準/.test(about),
      授權連結: [...document.querySelectorAll('#aboutBox a')].map(a => a.href)
        .filter(h => /data\.gov\.tw\/license|opendatacommons/.test(h)).length,
    };
  });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('測速快捷鍵存在', R.按鈕.測速.有);
  ok('測速鍵有「測速」字樣', /測速/.test(R.按鈕.測速.文字));
  ok('三顆大鍵尺寸都不同（不看螢幕也摸得出來）',
     new Set([R.按鈕.掉落物.高, R.按鈕.事故.高, R.按鈕.測速.高]).size === 3);
  ok('測速鍵比事故小、比「其他」大',
     R.按鈕.測速.高 < R.按鈕.事故.高 && R.按鈕.測速.高 > R.按鈕.其他.高);
  ok('沒有 GPS 時不新增且有提示', R.無GPS.新增了嗎 === 0 && /GPS/.test(R.無GPS.提示));
  ok('按下後新增一筆測速點', R.加入.回報數 === 1 && R.加入.種類 === '測速點');
  ok('立刻進入點位資料庫', R.加入.進了資料庫 === 1 && R.加入.資料庫增加 === 1);
  ok('備註自動帶入方向', R.加入.備註.length > 0);
  ok('有 6 秒復原鈕', R.加入.有復原鈕);
  ok('位置往回退 20~120 公尺', R.往回退.退了幾公尺 >= 20 && R.往回退.退了幾公尺 <= 120);
  ok('退到我的後方（南下時在北邊）', R.往回退.在我後方);
  ok('復原會移除該點', R.復原.復原後 === 0 && R.復原.資料庫剩 === 0);
  ok('加入後開過去會警示', R.會警示.語音.length >= 2);
  ok('警示唸出速限 50', R.會警示.語音.some(t => /速限50/.test(t)));
  ok('定位不堪用時擋下不新增', R.定位差時擋下.新增數 === 0);
  ok('定位不堪用時說明原因', /定位品質不足|停車/.test(R.定位差時擋下.提示));
  ok('HUD 有公測徽章', /公測/.test(R.公測標示.HUD徽章 || ''));
  ok('HUD 徽章夠小不擋畫面（<60px）', R.公測標示.HUD徽章寬度 > 0 && R.公測標示.HUD徽章寬度 < 60);
  ok('HUD 徽章 tooltip 帶完整序號', /公測版 建置 \d{8}\.\d{4}/.test(R.公測標示.HUD提示));
  ok('建置序號格式為 YYYYMMDD.HHmm', /^\d{8}\.\d{4}$/.test(R.公測標示.常數序號));
  ok('起始畫面顯示完整序號', R.公測標示.起始畫面 === R.公測標示.常數序號);
  ok('狀態列顯示短序號（月日.時分）',
     R.公測標示.HUD短序號 === R.公測標示.常數序號.slice(4));
  ok('狀態列序號長按看得到完整序號', /建置序號 \d{8}\.\d{4}/.test(R.公測標示.HUD序號提示));
  ok('狀態列仍是一行（沒被序號擠爆）', R.公測標示.狀態列高度 < 30);
  ok('設定頁帶完整序號',
     R.公測標示.設定頁 === R.公測標示.常數階段 + ' · 建置 ' + R.公測標示.常數序號);
  const A = R.出處標示;
  ok('關於頁標示政府資料開放授權條款第1版', A.有政府資料授權);
  ok('關於頁標示提供機關（警政署）', A.有警政署);
  ok('關於頁有 OpenStreetMap contributors 完整標示', A.有OSM);
  ok('關於頁標示 ODbL', A.有ODbL);
  ok('關於頁列出第三方程式庫授權', A.有程式庫授權);
  ok('關於頁有著作權聲明', A.有著作權);
  ok('關於頁有隱私聲明', A.有隱私聲明);
  ok('關於頁有免責聲明', A.有免責);
  ok('關於頁有可點擊的授權條款連結', A.授權連結 >= 2);
  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test13（一鍵加入測速點）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
