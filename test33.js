/* test33 — 車隊（跟車）：兩台手機同一組代碼，互相看得到；頭車軌跡約 1 分鐘、1 公里內；8 小時到期倒數 10 秒

   後端直接跑 backend/worker.js（D1 用 node:sqlite 模擬），兩個瀏覽器各自一個裝置代號。
*/
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'backend/schema.sql'), 'utf8');
const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a),
  async all() { return { results: db.prepare(sql).all(...args) }; },
  async first() { return db.prepare(sql).get(...args) ?? null; },
  async run() { db.prepare(sql).run(...args); return { success: true }; } });
const env = { DB: { prepare: sql => stmt(sql) } };
const API = 'https://convoy.test';
const rad = d => d * Math.PI / 180;
const hav = (a, b, c, d) => Math.hypot((c - a) * 111320, (d - b) * 111320 * Math.cos(rad(a)));

(async () => {
  const worker = (await import('./backend/worker.js')).default;
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const LCSS = fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8');
  async function phone(hash) {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' });
    const page = await ctx.newPage();
    page.errs = []; page.on('pageerror', e => page.errs.push('PAGEERROR: ' + e.message));
    await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
    await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: LCSS }));
    await page.route(API + '/**', async r => {
      const q = r.request(), body = q.postData();
      const res = await worker.fetch(new Request(q.url(), { method: q.method(), headers: { 'content-type': 'application/json' }, body: body || undefined }), env);
      r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    });
    await page.route('**/tile.openstreetmap.org/**', r => r.abort());
    await page.addInitScript(() => {
      Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => (window.__said = window.__said || []).push(u.text), cancel: () => {}, getVoices: () => [], onvoiceschanged: null }, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; }; navigator.vibrate = () => true;
      // 頁面時間從 3 分鐘前開始，開完一段路剛好回到現在（後端不收未來太久的軌跡點）
      const real = Date.now.bind(Date); window.__t = real() - 180e3; Date.now = () => window.__t;
    });
    await page.goto('file://' + path.join(__dirname, 'luleopard.html') + (hash || ''));
    await page.waitForTimeout(800); await page.click('#btnStart');
    await page.evaluate(api => { LP.CFG.hazUrl = api; LP.CFG.hazAuto = false; LP.CFG.mapRotate = false; LP.MAPROT.on = false; }, API);
    return page;
  }
  const P0 = [24.95, 121.40];                         // 起點，往北開
  // ── 頭車：建立車隊 ──
  const A = await phone();
  await A.evaluate(([la, lo]) => LP.onPos(la, lo, 0, 25, 5, false), P0);
  await A.click('#cvBtn'); await A.click('#cvNew');
  const code = await A.inputValue('#cvCode');
  ok(/^[A-Z0-9]{6}$/.test(code), '建立新車隊沒產生 6 碼代碼：' + code);
  ok(await A.isVisible('#cvLabels button.sel[data-l="A"]'), '建立車隊時預設不是 A（頭車）');
  await A.click('#cvGo'); await A.waitForTimeout(300);
  const ja = await A.evaluate(() => ({ code: LP.CONVOY.code, label: LP.CONVOY.label, left: LP.CONVOY.until - Date.now(), btn: document.getElementById('cvBtnTx').textContent }));
  ok(ja.code === code && ja.label === 'A', '頭車沒加入：' + JSON.stringify(ja));
  ok(Math.abs(ja.left - 8 * 3600e3) < 5e3, '解除時間不是 8 小時：' + ja.left);
  ok(/A 車/.test(ja.btn), '地圖按鈕沒顯示車號：' + ja.btn);
  ok(await A.isHidden('#cvSheet'), '加入後面板沒關');

  // 頭車往北開 150 秒、每秒 25 公尺（3.75 公里）
  await A.evaluate(async ([la, lo]) => {
    for (let i = 1; i <= 150; i++) { window.__t += 1000; LP.onPos(la + i * 25 / 111320, lo, 0, 25, 5, false); }
    await LP.convoySend(true);
  }, P0);

  // ── 第二台：從邀請連結進來 ──
  const B = await phone('#convoy=' + code);
  await B.waitForSelector('#cvSheet:not(.hidden)', { timeout: 3000 }).catch(() => fails.push('邀請連結沒自動打開車隊面板'));
  ok(await B.inputValue('#cvCode') === code, '邀請連結沒帶入代碼');
  // 測試環境的伺服器網址是開頁後才設的，重新抓一次已用車號
  await B.evaluate(c => LP.openConvoy(c), code); await B.waitForTimeout(300);
  ok(await B.isDisabled('#cvLabels button[data-l="A"]'), 'A 已經有人用，卻還能選');
  ok(await B.isVisible('#cvLabels button.sel[data-l="B"]'), 'A 被用走後沒自動改選 B');
  // 跟在頭車後面約 2 公里
  await B.evaluate(([la, lo]) => LP.onPos(la + 70 * 25 / 111320, lo, 0, 25, 5, false), P0);
  await B.click('#cvGo'); await B.waitForTimeout(300);
  const jb = await B.evaluate(async () => { await LP.convoySend(true); LP.drawConvoy();
    const a = LP.CONVOY.members.find(m => m.label === 'A');
    return { label: LP.CONVOY.label, n: LP.CONVOY.members.length, a, marks: Object.keys(LP.cvMarks),
      trails: document.querySelectorAll('path.cvtrail').length, pin: !!document.querySelector('.cvpin.lead') }; });
  ok(jb.label === 'B' && jb.n === 2, '第二台沒加入或看不到全隊：' + JSON.stringify({ l: jb.label, n: jb.n }));
  ok(jb.marks.join() === 'A' && jb.pin, 'B 的地圖上沒有頭車標記：' + jb.marks);
  ok(jb.trails >= 3, 'B 的地圖上沒畫頭車軌跡：' + jb.trails);
  const tr = (jb.a && jb.a.trail) || [];
  let len = 0; for (let i = 1; i < tr.length; i++) len += hav(tr[i - 1][0], tr[i - 1][1], tr[i][0], tr[i][1]);
  const span = tr.length ? (tr[tr.length - 1][2] - tr[0][2]) / 1000 : 0;
  console.log('頭車軌跡', tr.length, '點', Math.round(len), 'm', span, 's');
  ok(tr.length >= 10 && len <= 1000 && span <= 60, '頭車軌跡超過 1 分鐘 / 1 公里：' + JSON.stringify({ n: tr.length, len, span }));
  ok(len >= 800, '頭車軌跡太短（應接近 1 公里）：' + len);

  // 頭車看得到 B
  const sa = await A.evaluate(async () => { window.__t += 6000; await LP.convoySend(true);
    return { n: LP.CONVOY.members.length, marks: Object.keys(LP.cvMarks), trails: document.querySelectorAll('path.cvtrail').length }; });
  ok(sa.n === 2 && sa.marks.join() === 'B', '頭車地圖上看不到 B：' + JSON.stringify(sa));
  ok(sa.trails >= 3, '頭車自己的地圖沒有軌跡：' + sa.trails);
  await B.click('#cvBtn'); await B.waitForTimeout(100);
  const list = await B.textContent('#cvList');
  ok(/頭車/.test(list) && /km/.test(list), '車隊清單沒列出頭車距離：' + list);
  await B.click('#cvX');

  // ── 8 小時到期：倒數 10 秒 ──
  const e1 = await B.evaluate(() => { window.__t = LP.CONVOY.until - 9500; window.__said = []; LP.convoyTick();
    return { vis: !document.getElementById('cvPrompt').classList.contains('hidden'), n: document.getElementById('cvPromptN').textContent, said: window.__said.join() }; });
  ok(e1.vis && e1.n === '10', '到期前 10 秒沒跳倒數：' + JSON.stringify(e1));
  ok(/解除/.test(e1.said), '倒數沒有語音提醒：' + e1.said);
  await B.click('#cvKeep');
  const e2 = await B.evaluate(() => ({ left: LP.CONVOY.until - Date.now(), vis: !document.getElementById('cvPrompt').classList.contains('hidden') }));
  ok(!e2.vis && Math.abs(e2.left - 8 * 3600e3) < 5e3, '按「繼續」沒延長 8 小時：' + JSON.stringify(e2));
  // 不理它：倒數完自動解除
  const e3 = await B.evaluate(async () => {
    window.__t = LP.CONVOY.until - 4000; LP.convoyTick();
    const n = document.getElementById('cvPromptN').textContent;
    for (let i = 0; i < 5; i++) { window.__t += 1000; LP.convoyTick(); }
    await new Promise(r => setTimeout(r, 300));
    return { n, code: LP.CONVOY.code, vis: !document.getElementById('cvPrompt').classList.contains('hidden'),
      marks: Object.keys(LP.cvMarks).length, btn: document.getElementById('cvBtnTx').textContent };
  });
  ok(e3.n === '4', '倒數秒數不對：' + e3.n);
  ok(e3.code === '' && !e3.vis && e3.marks === 0 && e3.btn === '車隊', '倒數完沒自動解除：' + JSON.stringify(e3));
  const left = db.prepare('SELECT label FROM convoy').all().map(r => r.label).join();
  ok(left === 'A', '解除後後端還留著 B：' + left);

  // 重開 App 發現早就過了 8 小時：直接解除
  const e4 = await A.evaluate(async () => { LP.CONVOY.until = Date.now() - 1000; LP.convoyTick(); return LP.CONVOY.code; });
  ok(e4 === '', '過期的車隊沒解除');

  fails.push(...A.errs, ...B.errs);
  await browser.close();
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test33 車隊跟車');
  process.exit(fails.length ? 1 : 0);
})();
