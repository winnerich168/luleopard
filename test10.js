/* v1.1：GitHub Pages 產出的 docs/ 真的能用嗎
   用本機 http server 起 docs/，模擬 Pages 的行為，檢查：
     - index.html 開得起來、沒有 JS 錯誤
     - manifest 與圖示都拿得到（404 會讓「加到主畫面」變成空白圖示）
     - 只有一份 manifest（動態注入不該重複）
     - Service Worker 語法正確且能註冊
     - 離線狀態下仍能開起來（斷網後重新載入）
     - App 核心功能仍正常（測速警示會出聲）
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.json': 'application/json', '.webmanifest': 'application/manifest+json',
               '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve(dir) {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream',
                         'access-control-allow-origin': '*' });
    res.end(fs.readFileSync(f));
  });
}

(async () => {
  const dir = path.join(__dirname, 'docs');
  const srv = serve(dir);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/';

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' });
  const page = await ctx.newPage();

  const errs = [], missing = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|tile|openstreetmap/i.test(m.text())) errs.push(m.text()); });
  page.on('response', r => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });

  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: u => window.__spoken.push(u.text), cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
  });

  const R = {};

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  /* 1. 基本載入 */
  R.載入 = await page.evaluate(() => ({
    標題: document.title,
    有LP介面: typeof window.LP === 'object',
    內建點數: window.LP ? window.LP.CAMS().length : 0,
    manifest份數: document.querySelectorAll('link[rel="manifest"]').length,
    有appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    有iOS全螢幕: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
  }));

  /* 2. manifest 內容 */
  R.manifest = await page.evaluate(async b => {
    const r = await fetch(b + 'manifest.webmanifest');
    const j = await r.json();
    const icons = await Promise.all(j.icons.map(async i =>
      ({ src: i.src, ok: (await fetch(b + i.src)).ok })));
    return { name: j.name, display: j.display, start_url: j.start_url,
             有maskable: j.icons.some(i => i.purpose === 'maskable'), icons };
  }, base);

  /* 3. Service Worker 註冊（http 不會註冊，這裡直接驗語法能否解析執行）*/
  R.sw = await page.evaluate(async b => {
    const src = await (await fetch(b + 'sw.js')).text();
    let 語法正確 = true, 錯誤 = null;
    try { new Function(src); } catch (e) { 語法正確 = false; 錯誤 = e.message; }
    return { 位元組: src.length, 語法正確, 錯誤,
             有快取核心檔: /'\.\/index\.html'/.test(src),
             資料走網路優先: /data\//.test(src),
             跨網域不攔截: /url\.origin !== location\.origin/.test(src) };
  }, base);

  /* 4. App 核心功能仍正常：模擬開向一個測速點 */
  R.警示 = await page.evaluate(async () => {
    LP.CFG.voice = true; LP.CFG.onlyOver = false; LP.CFG.dirFilter = false;
    const cams = LP.CAMS();
    const c = cams.find(x => x.lat && x.lon);
    window.__spoken.length = 0;
    // 從正北方 1.2 km 外往南開過去
    // 每步間隔要大於語音節流間隔（1100 ms），否則後面的級距會被吞掉 ——
    // 間隔太短會看到「只播了第一級」，那是測試的問題不是 App 的問題
    for (const d of [1200, 900, 700, 500, 280, 150, 60]) {
      LP.onPos(c.lat + d / 111320, c.lon, 180, 90 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 1200));
    }
    // 這裡刻意關掉方向過濾，所以雙向兩支桿子都會報（國道每個里程通常南北各一支，
    // 相距約 100 公尺）。開著方向過濾時只會報同向的那一支。
    const near = cams.filter(x => LP.dist(c.lat, c.lon, x.lat, x.lon) < 300).length;
    return { 目標: c.name || c.addr || '(無名)', 附近300m內桿數: near, 語音: window.__spoken.slice() };
  });

  /* 4b. 開啟方向過濾後，對向那支不該再報 */
  R.方向過濾 = await page.evaluate(async () => {
    LP.CFG.dirFilter = true;
    LP.resetTrip();
    const cams = LP.CAMS();
    const c = cams.find(x => x.lat && x.lon);
    window.__spoken.length = 0;
    for (const d of [1200, 700, 280, 60]) {
      LP.onPos(c.lat + d / 111320, c.lon, 180, 90 / 3.6, 8, true);
      await new Promise(r => setTimeout(r, 1200));
    }
    return { 語音: window.__spoken.slice() };
  });

  /* 5. 離線：斷網之後還開不開得起來（這是 Service Worker 真正的價值）
        127.0.0.1 被瀏覽器視為安全來源，所以本機就驗得到，不用真的部署上去 */
  R.離線 = await (async () => {
    // 等 SW 進入 activated，否則第一次載入時它還來不及快取
    const 註冊成功 = await page.evaluate(() =>
      navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false));
    await page.reload({ waitUntil: 'load' });     // 第二次載入才會走 SW
    await page.waitForTimeout(600);

    await ctx.setOffline(true);
    const p2 = await ctx.newPage();
    let 開得起來 = false, 有內建點位 = 0, 訊息 = '';
    try {
      await p2.goto(base, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await p2.waitForTimeout(800);
      有內建點位 = await p2.evaluate(() => (window.LP ? window.LP.CAMS().length : 0));
      開得起來 = true;
    } catch (e) { 訊息 = e.message.split('\n')[0]; }
    await p2.close();
    await ctx.setOffline(false);
    return { 註冊成功, 開得起來, 有內建點位, 訊息 };
  })();

  R.找不到的檔案 = [...new Set(missing)];
  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('index.html 載入且 LP 介面存在', R.載入.有LP介面);
  ok('內建點位仍有 300 點以上', R.載入.內建點數 >= 300);
  ok('只有一份 manifest（不重複注入）', R.載入.manifest份數 === 1);
  ok('有 apple-touch-icon', R.載入.有appleIcon);
  ok('有 iOS 全螢幕 meta', R.載入.有iOS全螢幕);
  ok('manifest 是 standalone', R.manifest.display === 'standalone');
  ok('manifest 所有圖示都拿得到', R.manifest.icons.every(i => i.ok));
  ok('有 maskable 圖示（Android 自適應）', R.manifest.有maskable);
  ok('sw.js 語法正確', R.sw.語法正確);
  ok('sw.js 有快取 App 本體', R.sw.有快取核心檔);
  ok('sw.js 不攔截跨網域（圖磚／後端）', R.sw.跨網域不攔截);
  ok('測速警示仍會出聲', R.警示.語音.length >= 2);
  // 南下經過時，只該聽到南向那支；北向那支（相距約 100 m）不該出聲
  ok('方向過濾有效：不會報到對向的桿子',
     R.方向過濾.語音.length > 0 && !R.方向過濾.語音.some(t => /北向/.test(t)));
  ok('Service Worker 註冊成功', R.離線.註冊成功);
  ok('斷網後仍開得起來（離線可用）', R.離線.開得起來);
  ok('離線時內建點位還在', R.離線.有內建點位 >= 300);
  ok('沒有 404', R.找不到的檔案.length === 0);
  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test10（Pages 產出）全部通過');
  await browser.close();
  srv.close();
  process.exit(fails.length ? 1 : 0);
})();
