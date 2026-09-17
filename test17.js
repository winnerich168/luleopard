/* test17 — 方向欄位解析（往北卻報南下的測速照相）

   實地回報：國道往北開，一路把「南下」的測速照相報出來。

   查了 GitHub Pages 上實際在跑的 2103 個點，方向欄位共有 173 種寫法。
   舊版用子字串比對，把最常見的幾種解析成了**完全相反**的方向：

       北向南 = 由北往南 = 南下   舊版看到「北向」判成北上   ✗ 201 點
       南向北 = 由南往北 = 北上   舊版看到「南向」判成南下   ✗ 178 點
       西向東 / 東向西                                     ✗ 263 點

   合計 646 個點方向全反 —— 等於對向車道的照相一路報給你聽，
   而你真正會經過的那些反而不報。這一支測試就是釘住這件事。

   同時也釘住另一個方向：「往南崁方向」「往南桃園交流道」裡的南
   是地名的一部分，不是行進方向，絕對不能拿來過濾（寧可多報）。
*/
const { chromium } = require('playwright');
const path = require('path');

/* ── 期望值。左邊是政府開放資料裡真實出現過的寫法 ──
   null = 不限方向（解析不出來時的安全值：寧可多報，不要漏報） */
const NORTH = 0, EAST = 90, SOUTH = 180, WEST = 270;
const NE = 45, SE = 135, SW = 225, NW = 315;

const CASES = [
  /* ① 這 8 種是誤報的元凶：A向B 的 B 才是行進方向 */
  ['北向南', [SOUTH], '由北往南＝南下'],
  ['南向北', [NORTH], '由南往北＝北上'],
  ['西向東', [EAST], null],
  ['東向西', [WEST], null],
  ['北往南', [SOUTH], null],
  ['南往北', [NORTH], null],
  ['西往東', [EAST], null],
  ['東往西', [WEST], null],
  ['南向北(超速闖紅燈)', [NORTH], '後面接執法項目也要照樣解析'],
  ['東向西(區間測速)', [WEST], null],
  ['北往南向', [SOUTH], '結尾多一個向字'],

  /* ② 斜向 */
  ['西南向東北', [NE], null],
  ['東北向西南', [SW], null],
  ['西北向東南', [SE], null],
  ['東南向西北', [NW], null],

  /* ③ 單一方向 */
  ['南向', [SOUTH], null],
  ['北向', [NORTH], null],
  ['東向', [EAST], null],
  ['西向', [WEST], null],
  ['北向(區間測速)', [NORTH], null],
  ['往南', [SOUTH], null],
  ['往北', [NORTH], null],
  ['往東', [EAST], null],
  ['往西', [WEST], null],
  ['往北方向', [NORTH], null],
  ['往南方向', [SOUTH], null],
  ['北上', [NORTH], null],
  ['南下', [SOUTH], null],
  ['北上車道', [NORTH], null],
  ['南下車道', [SOUTH], null],
  ['北上方向', [NORTH], null],
  ['南下方向', [SOUTH], null],
  ['往北上方向', [NORTH], null],
  ['往南下方向', [SOUTH], null],
  ['介壽路往北', [NORTH], '路名在前面'],
  ['往北(大溪方向)', [NORTH], '括號裡是地名，不影響'],
  ['往北(埔心)方向', [NORTH], null],

  /* ④ 雙向 */
  ['南北雙向', [NORTH, SOUTH], null],
  ['南北向', [NORTH, SOUTH], null],
  ['南北', [NORTH, SOUTH], null],
  ['北南雙向', [NORTH, SOUTH], null],
  ['南北相向', [NORTH, SOUTH], null],
  ['東西雙向', [EAST, WEST], null],
  ['東西向', [EAST, WEST], null],
  ['往東西向', [EAST, WEST], null],
  ['南北雙向(區間測速)', [NORTH, SOUTH], null],
  ['南北雙向（區間測速）', [NORTH, SOUTH], '全形括號'],
  ['南北雙向兼南下闖紅燈', [NORTH, SOUTH], '不能被後面的「南下」蓋掉'],
  ['台15線南北雙向', [NORTH, SOUTH], null],
  ['台15線(南北雙向)', [NORTH, SOUTH], null],
  ['南向60北向70', [NORTH, SOUTH], '一欄塞兩個方向各自的速限'],
  ['南向70北向60', [NORTH, SOUTH], null],
  ['南向北(區間測速) 北向南(區間測速)', [NORTH, SOUTH], '一欄寫了兩組 A向B'],
  ['東往西(雙向)', [EAST, WEST], '寫了雙向就兩邊都算'],

  /* ⑤ 解析不出來 → 不限方向（寧可多報不要漏報） */
  ['雙向', null, '沒說是哪個軸'],
  ['雙向(區間測速)', null, null],
  ['多向', null, null],
  ['區間測速', null, null],
  ['', null, null],
  [null, null, '欄位空的'],
  ['往大溪方向', null, '大溪是地名'],
  ['往桃園方向', null, null],
  ['往中壢方向', null, null],
  ['往下山', null, null],
  ['下山方向', null, null],
  ['往市區', null, null],
  ['往台北市', null, '台北的北不是方向'],
  ['往臺北市區', null, null],
  ['往南崁方向', null, '南崁是地名，不是南下'],
  ['往南桃園交流道方向', null, '南桃園是地名'],
  ['往西勢湖路方向', null, '西勢湖是地名'],
  ['往環南路方向', null, '路名裡的南'],
  ['往榮民南路方向', null, null],
  ['往大興西路方向', null, null],
  ['中山北路上往平鎮', null, '中山北路的北不是行進方向'],
  ['高鐵南路八段上雙向', null, null],
  ['烈嶼往大金(區間測速)', null, '金門，地名對地名'],
  ['往國道二號方向', null, null],
  ['西濱路上往新豐方向', null, null],
];

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        speak: u => window.__spoken.push(u.text), cancel: () => {}, getVoices: () => [],
        set onvoiceschanged(v) {}, get onvoiceschanged() { return null }
      }, configurable: true
    });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(900);

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };

  /* ── 1. 逐條比對解析結果 ── */
  const got = await page.evaluate(cs => cs.map(c => LP.dirHeadings(c[0])), CASES.map(c => [c[0]]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const NAME = { 0: '北', 45: '東北', 90: '東', 135: '東南', 180: '南', 225: '西南', 270: '西', 315: '西北' };
  const fmt = h => h == null ? '不限方向' : h.map(x => NAME[x] ?? x).join('+');

  const bad = [];
  CASES.forEach((c, i) => {
    if (!same(got[i], c[1])) bad.push(`  「${c[0]}」期望 ${fmt(c[1])}，實得 ${fmt(got[i])}`);
  });
  if (bad.length) console.log('方向解析不符：\n' + bad.join('\n'));
  ok(`方向字串解析（${CASES.length} 種真實寫法）`, bad.length === 0);

  /* ── 2. 端對端：北上時不該報「北向南」的照相 ──
     這才是使用者真正回報的症狀。解析對了但比對錯了一樣沒用。 */
  const CAM_LAT = 23.4000, CAM_LON = 120.4000;

  const drive = (dirText, heading) => page.evaluate(async o => {
    LP.clearPacks();
    LP.CFG.useSeed = false;            // 只留下這一個測試點，避免鄰近的內建點干擾
    LP.addPack('方向測試', [[o.lat, o.lon, 100, o.dirText, '方向測試點']]);
    LP.CFG.voice = true; LP.CFG.dirFilter = true; LP.CFG.onlyOver = false;
    LP.CFG.passNotice = false; LP.CFG.icNotice = false;
    LP.resetTrip(); LP.GPS.last = null; LP.gpsResetQuality();
    window.__spoken.length = 0;
    // 北上 = 由南往北，緯度遞增；南下反之
    const sign = o.heading === 0 ? 1 : -1;
    for (let d = 900; d >= -200; d -= 28) {
      window.__clock += 1000;
      LP.onPos(o.lat - sign * d / 111320, o.lon, o.heading, 100 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 8));
    }
    return {
      語音: window.__spoken.filter(t => /方向測試點|測速/.test(t)),
      畫面: document.getElementById('alertDist').textContent
    };
  }, { dirText, heading, lat: CAM_LAT, lon: CAM_LON });

  const R = {};
  R['北上遇北向南'] = await drive('北向南', 0);     // 對向照相 → 應該完全安靜
  R['南下遇北向南'] = await drive('北向南', 180);   // 同向照相 → 應該要報
  R['北上遇南向北'] = await drive('南向北', 0);
  R['南下遇南向北'] = await drive('南向北', 180);
  R['北上遇南北雙向'] = await drive('南北雙向', 0);
  R['北上遇往大溪方向'] = await drive('往大溪方向', 0);  // 解析不出來 → 照報

  ok('北上不會報「北向南」（對向）的照相', R['北上遇北向南'].語音.length === 0 && !R['北上遇北向南'].畫面);
  ok('南下會報「北向南」（同向）的照相', R['南下遇北向南'].語音.length > 0);
  ok('北上會報「南向北」（同向）的照相', R['北上遇南向北'].語音.length > 0);
  ok('南下不會報「南向北」（對向）的照相', R['南下遇南向北'].語音.length === 0);
  ok('雙向照相兩邊都會報', R['北上遇南北雙向'].語音.length > 0);
  ok('方向看不懂時照樣報（寧可多報不要漏報）', R['北上遇往大溪方向'].語音.length > 0);

  /* ── 3. 關掉方向過濾就全部都要報 ── */
  const noFilter = await page.evaluate(async o => {
    LP.clearPacks(); LP.CFG.useSeed = false;
    LP.addPack('方向測試', [[o.lat, o.lon, 100, '北向南', '方向測試點']]);
    LP.CFG.voice = true; LP.CFG.dirFilter = false; LP.CFG.onlyOver = false;
    LP.CFG.passNotice = false; LP.CFG.icNotice = false;
    LP.resetTrip(); LP.GPS.last = null; LP.gpsResetQuality();
    window.__spoken.length = 0;
    for (let d = 900; d >= -200; d -= 28) {
      window.__clock += 1000;
      LP.onPos(o.lat - d / 111320, o.lon, 0, 100 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 8));
    }
    return window.__spoken.filter(t => /方向測試點|測速/.test(t)).length;
  }, { lat: CAM_LAT, lon: CAM_LON });
  ok('關閉方向過濾後對向照相也會報', noFilter > 0);

  /* ── 4. 沒有航向（例如筆電定位）時不該過濾掉任何東西 ── */
  const noHeading = await page.evaluate(() => (LP.CFG.dirFilter = true, {
    空航向: LP.dirMatch({ hd: [180] }, null),
    NaN航向: LP.dirMatch({ hd: [180] }, NaN),
    沒有方向資料: LP.dirMatch({ hd: null }, 0),
  }));
  ok('航向不明時不過濾', noHeading.空航向 && noHeading.NaN航向 && noHeading.沒有方向資料);

  /* ── 5. 容差：小角度偏離（彎道、換道）不該被濾掉 ── */
  const tol = await page.evaluate(() => (LP.CFG.dirFilter = true, {
    正北: LP.dirMatch({ hd: [0] }, 0),
    偏30度: LP.dirMatch({ hd: [0] }, 30),
    偏60度: LP.dirMatch({ hd: [0] }, 60),
    偏90度: LP.dirMatch({ hd: [0] }, 90),
    對向: LP.dirMatch({ hd: [0] }, 180),
    跨越0度: LP.dirMatch({ hd: [0] }, 340),
  }));
  ok('沿路小角度偏離仍會報', tol.正北 && tol.偏30度 && tol.偏60度);
  ok('垂直與對向不報', !tol.偏90度 && !tol.對向);
  ok('航向跨越 0 度的計算正確', tol.跨越0度);

  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(JSON.stringify({ 端對端: R, 關閉過濾: noFilter, 容差: tol, errors: errs }, null, 2));
  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test17（方向欄位解析與過濾）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
