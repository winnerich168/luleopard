/* test19 — 開啟就自動載入官方網站上的資料

   以前交流道與「全台合併資料源」都要使用者自己到設定頁貼網址、按載入；
   沒弄的人只有內建的 315 個點，交流道也從來不會播報。
   而且整份 CFG 存在裝置裡，光改預設值對舊使用者沒有作用，必須補一次搬遷。

   這支把頁面當成放在 GitHub Pages 上開啟（用 page.route 模擬，不真的連網），
   資料檔從本機 docs/data/ 供應。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SITE = 'https://winnerich168.github.io/luleopard/';
const HTML = fs.readFileSync(path.join(__dirname, 'luleopard.html'), 'utf8');
const IC_JSON = fs.readFileSync(path.join(__dirname, 'docs/data/interchanges.min.json'), 'utf8');
const CAM_JSON = fs.readFileSync(path.join(__dirname, 'docs/data/speedcams.min.json'), 'utf8');

async function open(browser, { legacyCfg, fileUrl } = {}) {
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [], hits = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (/leaflet.*\.js/.test(u)) return r.fulfill({ contentType: 'text/javascript', body: LEAFLET });
    if (/leaflet.*\.css/.test(u)) return r.fulfill({ contentType: 'text/css', body: '' });
    if (u.startsWith(SITE + 'data/')) {
      hits.push(u.slice(SITE.length));
      if (u.endsWith('interchanges.min.json')) return r.fulfill({ contentType: 'application/json', body: IC_JSON });
      if (u.endsWith('speedcams.min.json')) return r.fulfill({ contentType: 'application/json', body: CAM_JSON });
      return r.fulfill({ status: 404, body: '' });
    }
    if (u === SITE || u === SITE + 'index.html') return r.fulfill({ contentType: 'text/html', body: HTML });
    if (u.startsWith('file:')) return r.continue();
    return r.abort();
  });
  await page.addInitScript(cfg => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => (window.__said = window.__said || []).push(u.text), cancel: () => {},
               getVoices: () => [], onvoiceschanged: null }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    if (cfg && !localStorage.getItem('__seeded')) {
      localStorage.setItem('lp.cfg', JSON.stringify(cfg)); localStorage.setItem('__seeded', '1');
    }
  }, legacyCfg || null);
  await page.goto(fileUrl ? 'file://' + path.join(__dirname, 'luleopard.html') : SITE);
  await page.waitForTimeout(3500);
  return { page, errs, hits };
}

(async () => {
  const browser = await chromium.launch();
  const R = {};

  /* 1. 新使用者：直接開就自動載入 */
  {
    const { page, errs, hits } = await open(browser);
    R.新使用者 = await page.evaluate(() => ({
      點數: LP.CAMS().length, 交流道: LP.IC.items.length, 已載入: LP.IC.loaded,
      feedUrl: LP.CFG.feedUrl, feedAuto: LP.CFG.feedAuto, icUrl: LP.CFG.icUrl, hazUrl: LP.CFG.hazUrl,
      交流道狀態: document.getElementById('icStat').textContent }));
    R.新使用者.請求 = hits; R.新使用者.errors = errs;

    /* 交流道 3 公里前播報：往北開向一個交流道 */
    R.交流道播報 = await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 1000));
      const it = LP.IC.items.find(x => x[2] && x[0] > 24 && x[0] < 25);
      LP.CFG.useSeed = false; LP.clearPacks();        // 避開測速警示的節流
      LP.resetTrip(); window.__said = [];
      const M = 1 / 111320, v = 100 / 3.6;
      let at = null;
      for (let d = 4200; d > 1500; d -= v) {
        LP.onPos(it[0] - d * M, it[1], 0, v, 5, false);
        if (at == null && window.__said.some(t => t.includes(it[2]))) at = Math.round(d);
        await new Promise(r => setTimeout(r, 5));
      }
      return { 名稱: it[2], 語音: window.__said.filter(t => t.includes('交流道')), 播報時距離: at };
    });
    await page.context().close();
  }

  /* 2. 舊使用者：裝置裡存著「網址空白、自動更新關閉」的舊設定 */
  {
    const { page, errs } = await open(browser, { legacyCfg: { feedUrl: '', feedAuto: false, icUrl: '', voice: true,
      tdxId: 'old-id', tdxSecret: 'old-secret', tdxPath: 'https://x' } });
    R.舊使用者 = await page.evaluate(() => ({
      點數: LP.CAMS().length, 交流道: LP.IC.items.length,
      feedUrl: LP.CFG.feedUrl, feedAuto: LP.CFG.feedAuto, icUrl: LP.CFG.icUrl, hazUrl: LP.CFG.hazUrl,
      舊金鑰已清除: !('tdxId' in LP.CFG) && !/old-secret/.test(localStorage.getItem('lp.cfg')),
      沒有金鑰輸入欄: !document.getElementById('tdxId') && !document.getElementById('tdxSecret') }));
    R.舊使用者.errors = errs;
    await page.context().close();
  }

  /* 3. 已經搬遷過、又自己清掉交流道的人：尊重他的選擇，不再自動抓 */
  {
    const { page, hits } = await open(browser, { legacyCfg: { autoData1: 1, icUrl: '', feedUrl: '', feedAuto: false } });
    R.自己關掉 = await page.evaluate(() => ({ 交流道: LP.IC.items.length, 點數: LP.CAMS().length }));
    R.自己關掉.請求 = hits;
    await page.context().close();
  }

  /* 4. file:// 開檔（本機開發、其他測試）不自動連網 */
  {
    const { page, hits } = await open(browser, { fileUrl: true });
    R.本機開檔 = { 請求: hits, hazUrl: await page.evaluate(() => LP.CFG.hazUrl) };
    await page.context().close();
  }

  /* 5. 後端附上的官方事件（TDX）：拉回來之後開過去要播報，而且說得出是官方通報 */
  {
    const { page, errs } = await open(browser);
    const M = 1 / 111320, lat = 22.621562, lon = 120.532435;   // 國道三號南向 410.1K（實際資料）
    await page.route('https://luleopard-hazards.winnerich.workers.dev/**', r => r.fulfill({
      contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ok: true, hazards: [{
        id: 'o-abc123', type: '事故', lat, lon, road: '國道三號', roadClass: '國道', dir: '南向', km: 410.1,
        brg: 180, brgTol: 110, note: '國道三號 南向 410K+100 交通事故-事故', lane: '',
        t: Date.now(), lastReport: Date.now(), expires: Date.now() + 20 * 60e3,
        confirms: 0, clears: 0, reports: 1, score: 1.5, official: 'open', src: 'official', dist: 3000 }],
        officialT: Date.now() - 4 * 60e3 }) }));
    R.官方事件 = await page.evaluate(async ([lat, lon, M]) => {
      LP.CFG.useSeed = false; LP.clearPacks(); LP.resetTrip();
      const n = await LP.pullHazards({ lat: lat + 4000 * M, lon }, true);
      const h = LP.HAZARDS().find(x => x.id === 'o-abc123' || x.serverId === 'o-abc123');
      window.__said = [];
      const v = 100 / 3.6;
      // 往南開（航向 200°：國道在彎，跟名目方向 180° 差 20°，仍要報）
      for (let d = 3500; d > 50; d -= v) {
        LP.onPos(lat + d * M, lon, 200, v, 5, false);
        await new Promise(r => setTimeout(r, 30));
      }
      const saidSouth = window.__said.slice();
      // 反方向（往北，航向 0°）開過同一點：對向車道，不該報
      LP.hazState.clear(); window.__said = [];
      for (let d = 3500; d > 50; d -= v) {
        LP.onPos(lat - d * M, lon, 0, v, 5, false);
        await new Promise(r => setTimeout(r, 30));
      }
      LP.paintOfficial();
      const 設定頁 = { 狀態: document.getElementById('offStat').textContent, 筆數: document.getElementById('offCount').textContent };
      document.querySelector('[data-tf="官方"]').click();
      const 路況頁 = [...document.querySelectorAll('#trafficList .item .t')].map(e => e.textContent);
      return { 設定頁, 路況頁, 拉回筆數: n, 有官方標記: !!h && h.official === 'open' && h.src === 'official' && h.brgTol === 110,
               南下語音: saidSouth.filter(t => /事故/.test(t)), 北上語音: window.__said.filter(t => /事故/.test(t)) };
    }, [lat, lon, M]);
    R.官方事件.errors = errs;
    await page.context().close();
  }

  console.log(JSON.stringify(R, null, 2));
  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('新使用者自動載入全台點位', R.新使用者.點數 > 1500);
  ok('新使用者自動載入交流道', R.新使用者.已載入 && R.新使用者.交流道 > 400);
  ok('預設開啟自動更新', R.新使用者.feedAuto === true && /speedcams\.min\.json$/.test(R.新使用者.feedUrl));
  ok('交流道有播報', R.交流道播報.語音.length >= 1);
  ok('交流道在 3 公里左右播報', R.交流道播報.播報時距離 != null && Math.abs(R.交流道播報.播報時距離 - 3000) <= 150);
  ok('舊使用者也自動補上資料源', R.舊使用者.點數 > 1500 && R.舊使用者.交流道 > 400 && R.舊使用者.feedAuto === true);
  ok('自己清掉的不再自動抓', R.自己關掉.交流道 === 0 && R.自己關掉.請求.length === 0);
  ok('file:// 不自動連網', R.本機開檔.請求.length === 0);
  // 共享回報後端：網站上預設連線；file:// 絕不預設，否則跑測試會把假回報灌進正式資料庫
  const API = 'https://luleopard-hazards.winnerich.workers.dev';
  ok('預設連上共享回報後端', R.新使用者.hazUrl === API);
  ok('舊使用者也補上後端', R.舊使用者.hazUrl === API);
  ok('file:// 不預設後端', R.本機開檔.hazUrl === '');
  ok('舊版存在手機裡的 TDX 金鑰會被清掉', R.舊使用者.舊金鑰已清除);
  ok('設定頁沒有 TDX 金鑰輸入欄', R.舊使用者.沒有金鑰輸入欄);
  ok('設定頁顯示官方路況已連線與更新時間', /✅/.test(R.官方事件.設定頁.狀態) && /4 分鐘前/.test(R.官方事件.設定頁.狀態));
  ok('設定頁顯示附近官方事件筆數', /^1 筆/.test(R.官方事件.設定頁.筆數));
  ok('路況頁列得出官方事件', R.官方事件.路況頁.some(t => /事故/.test(t) && /國道三號/.test(t)));
  ok('官方事件拉得回來且保留官方標記', R.官方事件.拉回筆數 === 1 && R.官方事件.有官方標記);
  ok('官方事件從遠到近播報', R.官方事件.南下語音.length >= 2 && /事故就在前方/.test(R.官方事件.南下語音.at(-1)));
  ok('播報說得出是官方通報', R.官方事件.南下語音.some(t => /官方通報/.test(t)));
  ok('對向車道的官方事件不報', R.官方事件.北上語音.length === 0);
  ok('沒有頁面錯誤', R.新使用者.errors.length === 0 && R.舊使用者.errors.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test19 全部通過');
})();
