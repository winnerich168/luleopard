/* test28 — 通報的時效：唸出「幾分鐘前通報」，經過後一鍵回報還在／已經沒有了

   實地回報：官方通報前方塞車、掉落物，開到的時候可能已經不塞了、東西已經處理掉了。
     1. 官方事件唸「官方 12 分鐘前通報」（用官方標的發生時間，不是後端提供的時間）
     2. 超過這類事件的半衰期（掉落物 45 分鐘）→ 加一句「可能已經排除」
     3. 用路人回報：「3 人回報，最近一次 5 分鐘前」
     4. 經過之後畫面跳出「還在／已經沒有了」，按了送到後端；15 秒沒按自己消失
     5. 沒開到旁邊（轉彎走掉）不跳
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [], votes = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/tile.openstreetmap.org/**', r => r.abort());
  await page.route('https://haz.test/**', r => {
    const u = r.request().url();
    const m = u.match(/\/hazards\/([^/]+)\/(confirm|clear|probe)$/);
    if (m && m[2] !== 'probe') votes.push(m[1] + ' ' + m[2]);
    return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(m ? { ok: true, official: true, hazard: { id: m[1], clears: 1, confirms: 0, reports: 1 } } : { ok: true, hazards: [] }) });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => (window.__said = window.__said || []).push(u.text), cancel: () => {}, getVoices: () => [], onvoiceschanged: null },
      configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    const real = Date.now.bind(Date); window.__t = real(); Date.now = () => window.__t;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const M = 1 / 111320, lat0 = 24.5, lon0 = 120.8;
  // 往北開過事件點；turnAt 有值時在那個距離右轉離開
  const drive = (haz, opt = {}) => page.evaluate(async ({ haz, opt, M, lat0, lon0 }) => {
    LP.CFG.useSeed = false; LP.CFG.hazUrl = 'https://haz.test'; LP.CFG.hazAuto = false; LP.CFG.probeSend = false; LP.clearPacks();
    LP.resetTrip(); LP.hazState.clear(); LP.HPASS.watch.clear(); window.__said = [];
    document.getElementById('passX').click();          // 上一趟沒按的卡片先收掉
    const now = window.__t;
    LP.setHazards([LP.makeHazard({ ...haz, lat: lat0, lon: lon0, brg: 0,
      since: haz.sinceMin != null ? now - haz.sinceMin * 60e3 : null,
      t: haz.tMin != null ? now - haz.tMin * 60e3 : now, lastReport: haz.tMin != null ? now - haz.tMin * 60e3 : now,
      expires: now + 3600e3, mine: false })]);
    const v = 25, seen = { card: false, cardTx: '' };
    for (let d = -2500; d < 600; d += v) {
      window.__t += 1000;
      let la = lat0 + d * M, lo = lon0, hd = 0;
      if (opt.turnAt != null && d > opt.turnAt) { la = lat0 + opt.turnAt * M; lo = lon0 + (d - opt.turnAt) * M; hd = 90; }
      LP.onPos(la, lo, hd, v, 5, false);
      const c = document.getElementById('passCard');
      if (c.classList.contains('show') && !seen.card) {
        seen.card = true; seen.cardTx = document.getElementById('passTx').textContent + ' / ' + document.getElementById('passSub').textContent;
        if (opt.press) document.getElementById(opt.press).click();
      }
      await new Promise(r => setTimeout(r, 0));
    }
    await new Promise(r => setTimeout(r, 50));
    return { said: window.__said.filter(t => /前方|注意|就在/.test(t)), hud: document.getElementById('hazTx').textContent, ...seen,
             stillShown: document.getElementById('passCard').classList.contains('show') };
  }, { haz, opt, M, lat0, lon0 });

  const R = {};
  R.官方12分 = await drive({ id: 'o-abc1', type: '掉落物', src: 'official', official: 'open', sinceMin: 12, score: 1.5 }, { press: 'passGone' });
  R.官方50分 = await drive({ id: 'o-abc2', type: '掉落物', src: 'official', official: 'open', sinceMin: 50, score: 1.5 });
  R.三人回報 = await drive({ id: 'u-1', type: '掉落物', reports: 3, confirms: 2, tMin: 5, score: 2 }, { press: 'passStill' });
  R.轉彎走掉 = await drive({ id: 'u-2', type: '掉落物', reports: 1, tMin: 3, score: 2 }, { turnAt: -900 });
  // 15 秒沒按：自己消失
  R.自動消失 = await page.evaluate(async () => {
    LP.showPassCard(LP.makeHazard({ id: 'x', type: '塞車', lat: 0, lon: 0, src: 'official', since: Date.now() - 60e3 }));
    const a = document.getElementById('passCard').classList.contains('show');
    await new Promise(r => setTimeout(r, 15200));
    return { 出現: a, 之後: document.getElementById('passCard').classList.contains('show') };
  });
  await browser.close();
  console.log(JSON.stringify({ R, votes }, null, 1));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  // （模擬開車時時間也在走，所以是 12～14 分鐘）
  ok('官方事件唸出「官方12分鐘前通報」', R.官方12分.said.some(t => /官方1[234]分鐘前通報/.test(t)));
  ok('12 分鐘的不加「可能已經排除」', !R.官方12分.said.some(t => /可能已經排除/.test(t)));
  ok('畫面列也顯示時間', /官方1[234]分鐘前/.test(R.官方12分.hud));
  ok('經過後跳出還在嗎卡片', R.官方12分.card && /掉落物/.test(R.官方12分.cardTx) && /官方1[234]分鐘前通報/.test(R.官方12分.cardTx));
  ok('按「已經沒有了」送出清除', votes.includes('o-abc1 clear'));
  ok('按完卡片收起', !R.官方12分.stillShown);
  ok('超過半衰期加「可能已經排除」', R.官方50分.said.some(t => /官方5[012]分鐘前通報.*可能已經排除/.test(t)));
  ok('多人回報唸出最近一次時間', R.三人回報.said.some(t => /3人回報，最近一次[567]分鐘前/.test(t)));
  ok('按「還在」送出確認', votes.includes('u-1 confirm'));
  ok('轉彎沒經過就不跳卡片', !R.轉彎走掉.card);
  ok('15 秒沒按自己消失', R.自動消失.出現 && !R.自動消失.之後);
  ok('沒有 JS 錯誤', errs.length === 0);
  console.log(fails.length ? '\n✗ 失敗：\n  ' + fails.join('\n  ') : '\n✓ 全部通過');
  process.exit(fails.length ? 1 : 0);
})();
