/* test24 — 只報「正在走的這條路」上的照相；警示距離依車速

   實地回報（嚴重）：
   1. 在國道上一路報「速限 50」—— 旁邊、底下平面道路的照相都被算進來
   2. 播報距離要依車速：時速 × 5 公尺（車速的千分之五公里）

   現在：
   · 三級距離 = 時速 × 5 / 時速 × 2.5 / 時速 × 1.2 公尺
   · 軌跡走廊：用最近的經緯度變化推出行進路線（含彎度），只報路線上的照相
   · 車速對不上：持續時速 100，旁邊速限 50 的平面道路照相不報；平面道路慢開，頭上國道照相不報
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.clock.install({ time: new Date('2026-10-01T08:00:00') });
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

  const R = {};
  R.距離 = await page.evaluate(() => { LP.gpsResetQuality();
    return [50, 100, 110].map(k => [1, 2, 3].map(t => Math.round(LP.tierDist(t, k / 3.6)))); });

  /* 共用：沿一條路線開，回報每句語音說出時離終點幾公尺。
     path(s) 回傳走了 s 公尺時的 [北向公尺, 東向公尺, 航向]。cams 用同樣的座標系。 */
  const run = async (name, kmh, total, pathFn, cams) => {
    await page.evaluate(([cams]) => {
      const lat0 = 24.8, lon0 = 121.0, M = 1 / 111320, ML = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
      LP.CFG.useSeed = false; LP.clearPacks();
      LP.addPack('t', cams.map(c => [lat0 + c.n * M, lon0 + c.e * ML, c.lim, c.dir || '雙向', c.name]));
      LP.resetTrip(); window.__said.length = 0;
    }, [cams]);
    const v = kmh / 3.6, log = [];
    for (let s = 0; s <= total; s += v) {
      const [n, e, hd] = pathFn(s);
      const before = await page.evaluate(([n, e, hd, v]) => {
        const lat0 = 24.8, lon0 = 121.0, M = 1 / 111320, ML = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
        const b = window.__said.length;
        LP.onPos(lat0 + n * M, lon0 + e * ML, hd, v, 5, false);
        return b;
      }, [n, e, hd, v]);
      await page.clock.runFor(1000);
      const said = await page.evaluate(b => window.__said.slice(b), before);
      said.forEach(t => log.push({ s: Math.round(s), t }));
    }
    return log;
  };
  const north = s => [s, 0, 0];

  /* 1. 國道時速 100 往北：路線上有國道照相（速限 100）；旁邊 60 公尺、正下方各有平面道路照相（速限 50） */
  R.國道 = await run('國道', 100, 3200, north, [
    { n: 2500, e: 0, lim: 100, dir: '南往北', name: '國道一號北向80公里' },
    { n: 1500, e: 60, lim: 50, name: '新竹縣竹北市 中華路與鳳岡路口' },
    // 正下方的平面道路（跟國道位置重疊，只能靠車速分辨）
    { n: 2000, e: 0, lim: 50, name: '新竹縣竹北市 中華路1483巷口' },
    { n: 1200, e: -400, lim: 60, name: '新竹縣湖口鄉 八德路（平行道路 400 公尺外）' },
  ]);
  /* 2. 平面道路時速 50 往北：路線上速限 50 的照相要報；頭上國道照相（速限 100）不報 */
  R.平面 = await run('平面', 50, 1500, north, [
    { n: 1000, e: 0, lim: 50, name: '新竹縣竹北市 中華路與鳳岡路口' },
    { n: 600, e: 5, lim: 100, dir: '南往北', name: '國道一號北向82公里' },
  ]);
  /* 3. 彎道：半徑 800 公尺往右彎，照相在彎道上前方 */
  const R0 = 800;
  const arc = s => { const a = s / R0; return [R0 * Math.sin(a), R0 * (1 - Math.cos(a)), (a * 180 / Math.PI + 360) % 360]; };
  const [cn, ce] = arc(1600);
  R.彎道 = await run('彎道', 100, 1900, arc, [{ n: cn, e: ce, lim: 100, name: '國道三號南向100公里' }]);
  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('時速 50：250 / 125 / 60 公尺', JSON.stringify(R.距離[0]) === '[250,125,60]');
  ok('時速 100：500 / 250 / 120 公尺', JSON.stringify(R.距離[1]) === '[500,250,120]');
  ok('時速 110：550 / 275 / 132 公尺', JSON.stringify(R.距離[2]) === '[550,275,132]');
  ok('國道上不報速限 50 的平面道路照相', !R.國道.some(x => /速限50/.test(x.t)));
  ok('國道上不報平行道路的照相', !R.國道.some(x => /速限60/.test(x.t)));
  const first = R.國道.find(x => /速限100/.test(x.t));
  ok('國道照相照常報，第一聲在約 500 公尺前', first && Math.abs((2500 - first.s) - 500) <= 40);
  ok('國道照相三聲都有', R.國道.filter(x => /速限100/.test(x.t)).length === 3);
  ok('平面道路：路線上速限 50 的照相要報', R.平面.some(x => /速限50/.test(x.t)));
  const f2 = R.平面.find(x => /速限50/.test(x.t));
  ok('平面道路：第一聲在約 250 公尺前', f2 && Math.abs((1000 - f2.s) - 250) <= 30);
  ok('平面道路慢開：頭上國道照相不報', !R.平面.some(x => /速限100/.test(x.t)));
  ok('彎道上前方的照相照常報', R.彎道.filter(x => /速限100/.test(x.t)).length >= 2);
  ok('沒有亂報「已通過」（沒提醒過的照相）', !R.國道.some(x => /已通過/.test(x.t) && R.國道.findIndex(y => /速限/.test(y.t)) < 0));
  ok('沒有頁面錯誤', errs.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test24 全部通過');
})();
