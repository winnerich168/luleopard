/* test37 — 天氣：所在縣市特報唸一次（重開不重唸）、附近雨勢大唸（30 分鐘內不重複、變大再唸）、
   低溫特報不唸、關掉天氣提醒就不唸、面板資訊、一鍵回報積水／濃霧／大雨 */
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const API = 'https://wx.test';

(async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' });
  let WXRES = null, wxCalls = 0;
  async function open() {
    const page = await ctx.newPage();
    page.errs = []; page.on('pageerror', e => page.errs.push('PAGEERROR: ' + e.message));
    await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
    await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route(/tile\.openstreetmap|wmts\.nlsc/, r => r.abort());
    await page.route(API + '/**', r => {
      const u = r.request().url();
      if (/\/weather/.test(u)) { wxCalls++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify(WXRES) }); }
      if (/\/report/.test(u)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, hazard: { id: 'srv1' } }) });
      r.fulfill({ contentType: 'application/json', body: '{"ok":true,"hazards":[]}' });
    });
    await page.addInitScript(() => {
      Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => { (window.__said = window.__said || []).push(u.text); setTimeout(() => u.onend && u.onend(), 5); }, cancel: () => {}, getVoices: () => [], onvoiceschanged: null }, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; }; navigator.vibrate = () => true;
    });
    await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
    await page.waitForTimeout(800); await page.click('#btnStart');
    await page.evaluate(api => { LP.CFG.hazUrl = api; LP.CFG.hazAuto = false; window.__said = []; }, API);
    return page;
  }
  const now = Date.now();
  const res = (alerts, rain) => ({ ok: true, county: '臺中市', town: '北區', alerts, rain, obs: now, t: now, stale: false });
  const rainA = { phenomena: '大雨', significance: '特報', county: '臺中市', end: now + 3 * 3600e3 };
  const coldA = { phenomena: '低溫', significance: '特報', county: '臺中市', end: now + 3 * 3600e3 };
  const said = p => p.evaluate(() => (window.__said || []).slice());
  const fix = (p, force) => p.evaluate(async f => { LP.onPos(24.15, 120.675, 0, 10, 5, false); if (f) await LP.pullWeather(LP.GPS.last, true); await new Promise(r => setTimeout(r, 300)); }, force);

  // 1. 有大雨特報＋低溫特報、沒下雨
  WXRES = res([rainA, coldA], []);
  let A = await open();
  await fix(A); await A.waitForTimeout(500);
  let S = await said(A);
  ok(wxCalls >= 1, '定位後沒去問天氣');
  ok(S.some(t => /臺中市發布大雨特報/.test(t)), '大雨特報沒唸：' + S);
  ok(!S.some(t => /低溫/.test(t)), '低溫特報不該唸：' + S);
  ok(await A.textContent('#wxBtnTx') === '大雨', '天氣按鈕要只顯示短字「大雨」：' + await A.textContent('#wxBtnTx'));
  ok(await A.evaluate(() => document.getElementById('wxBtn').classList.contains('alert')), '天氣按鈕沒變警示色');
  // 同一則再抓一次不重唸
  await A.evaluate(() => { window.__said = []; }); await fix(A, true);
  ok(!(await said(A)).some(t => /特報/.test(t)), '同一則特報唸了兩次');
  // 10 分鐘內不重抓
  const c0 = wxCalls; await fix(A); ok(wxCalls === c0, '10 分鐘內又去抓天氣');
  // 開了 5 公里以上：不等 10 分鐘就重抓；新位置沒有特報，按鈕要恢復成「天氣」
  WXRES = res([], []);
  const c1 = wxCalls;
  await A.evaluate(async () => { LP.onPos(24.15 + 6000 / 111320, 120.675, 0, 10, 5, false); await new Promise(r => setTimeout(r, 400)); });
  ok(wxCalls === c1 + 1, '開了 6 公里沒重抓天氣');
  ok(await A.textContent('#wxBtnTx') === '天氣' && !(await A.evaluate(() => document.getElementById('wxBtn').classList.contains('alert'))),
    '離開特報的縣市，按鈕還掛著特報：' + await A.textContent('#wxBtnTx'));
  // 「陸上強風特報」只顯示「強風」；已經結束的特報不顯示
  WXRES = res([{ phenomena: '陸上強風', significance: '特報', county: '新竹縣', end: now + 3600e3 }], []);
  await fix(A, true);
  ok(await A.textContent('#wxBtnTx') === '強風', '陸上強風沒縮成「強風」：' + await A.textContent('#wxBtnTx'));
  WXRES = res([{ phenomena: '陸上強風', significance: '特報', county: '新竹縣', end: now - 60e3 }], []);
  await fix(A, true);
  ok(await A.textContent('#wxBtnTx') === '天氣', '已經結束的特報還掛在按鈕上');
  WXRES = res([rainA, coldA], []);
  // 重開 App：不重唸
  await A.close(); A = await open(); await fix(A); await A.waitForTimeout(400);
  ok(!(await said(A)).some(t => /特報/.test(t)), '重開 App 又唸同一則特報');

  // 2. 附近雨勢：20mm 唸「雨勢很大」；再抓一次不重複；變成 45mm（更大）再唸「豪大雨」
  WXRES = res([], [{ name: '臺中', town: '北區', p10: 3, p1h: 22, dist: 800 }]);
  await A.evaluate(() => { window.__said = []; }); await fix(A, true);
  S = await said(A);
  ok(S.some(t => /附近雨勢很大，一小時雨量22毫米/.test(t)), '雨勢大沒唸：' + S);
  await A.evaluate(() => { window.__said = []; }); await fix(A, true);
  ok(!(await said(A)).length, '30 分鐘內雨勢同級又唸：' + await said(A));
  WXRES = res([], [{ name: '臺中', town: '北區', p10: 11, p1h: 45, dist: 800 }]);
  await fix(A, true);
  ok((await said(A)).some(t => /附近豪大雨，一小時雨量45毫米/.test(t)), '雨勢變大沒再唸：' + await said(A));
  // 3 公里外的站不算
  WXRES = res([], [{ name: '遠方', town: 'x', p10: 20, p1h: 80, dist: 5000 }]);
  await A.evaluate(() => { window.__said = []; LP.WX.rainLv = 0; LP.WX.rainAt = 0; }); await fix(A, true);
  ok(!(await said(A)).length, '5 公里外的雨量站也唸了');

  // 3. 面板資訊
  WXRES = res([rainA], [{ name: '臺中', town: '北區', p10: 6.5, p1h: 42, dist: 1200 }]);
  await fix(A, true);
  await A.click('#wxBtn'); await A.waitForTimeout(300);
  const info = await A.textContent('#wxInfo');
  ok(/臺中市 北區/.test(info) && /大雨特報/.test(info) && /42/.test(info) && /1\.2 km/.test(info) && /中央氣象署/.test(info), '天氣面板內容不對：' + info);
  // 4. 一鍵回報：點一下就回報、面板關掉
  for (const type of ['積水', '濃霧', '大雨']) {
    if (await A.isHidden('#wxSheet')) await A.click('#wxBtn');
    await A.click(`[data-wx="${type}"]`); await A.waitForTimeout(200);
    const r = await A.evaluate(t => ({ has: LP.HAZARDS().some(h => h.type === t && h.mine), hidden: document.getElementById('wxSheet').classList.contains('hidden'), toast: document.getElementById('toast').textContent }), type);
    ok(r.has && r.hidden && new RegExp('已通報 ' + type).test(r.toast), type + ' 一鍵回報不對：' + JSON.stringify(r));
    ok(await A.isVisible('#undoBtn') && /已上傳/.test(r.toast), type + '：上傳後復原按鈕被蓋掉了：' + r.toast);
  }
  // 復原：已上傳的要連伺服器一起撤回
  let retracted = 0;
  await A.route(API + '/hazards/*/retract', r => { retracted++; r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
  await A.click('#undoBtn'); await A.waitForTimeout(400);
  ok(retracted === 1, '按復原沒有撤回伺服器上的回報');
  ok(!(await A.evaluate(() => LP.HAZARDS().some(h => h.type === '大雨' && h.mine))), '按復原後本機還留著');
  // 上傳途中就按復原：上傳完成後自動撤回
  await A.route(API + '/report', async r => { await new Promise(z => setTimeout(z, 600)); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, hazard: { id: 'srv2' } }) }); });
  await A.click('#wxBtn'); await A.click('[data-wx="積水"]'); await A.waitForTimeout(100);
  await A.click('#undoBtn'); await A.waitForTimeout(1200);
  ok(retracted === 2, '上傳途中按復原，上傳完成後沒撤回：' + retracted);
  ok((await A.evaluate(() => [...document.querySelectorAll('#fabMenu')].length)) === 1, '');

  // 5. 關掉天氣提醒：不唸
  const B = await open();
  WXRES = res([{ ...rainA, phenomena: '濃霧', end: now + 7200e3 }], [{ name: '臺中', p10: 12, p1h: 50, dist: 500 }]);
  await B.evaluate(() => { LP.CFG.wxNotice = false; window.__said = []; });
  await fix(B, true);
  ok(!(await said(B)).length, '關掉天氣提醒還是唸了：' + await said(B));

  fails.push(...A.errs, ...B.errs);
  await browser.close();
  console.log(fails.filter(Boolean).length ? '✗ ' + fails.filter(Boolean).join('\n✗ ') : '✓ test37 天氣');
  process.exit(fails.filter(Boolean).length ? 1 : 0);
})();
