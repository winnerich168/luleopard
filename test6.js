/* v0.5：原生橋接（背景定位 + 原生 TTS）與「N 人回報」統計 */
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');

/* ── 極簡的假後端：實作 /report、/hazards、/confirm、/clear ── */
function fakeServer() {
  const store = new Map();
  let seq = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      const send = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const now = Date.now();

      if (u.pathname === '/report') {
        // 150m 內同類 → 併成確認
        for (const h of store.values()) {
          const d = Math.hypot((h.lat - j.lat) * 111320, (h.lon - j.lon) * 101000);
          if (h.type === j.type && d < 150) {
            h.confirms++; h.reports = 1 + h.confirms; h.lastReport = now;
            return send({ ok: true, merged: true, hazard: h });
          }
        }
        const id = 's' + (++seq);
        const h = { id, type: j.type, lat: j.lat, lon: j.lon, road: j.road || '', roadClass: j.roadClass || '一般道路',
                    dir: j.dir || '', km: j.km ?? null, lane: j.lane || '', brg: j.brg ?? null, note: j.note || '',
                    t: now, lastReport: now, expires: now + 2 * 3600e3, confirms: 0, clears: 0, reports: 1 };
        store.set(id, h);
        return send({ ok: true, merged: false, hazard: h });
      }
      if (u.pathname === '/hazards') {
        return send({ ok: true, now, count: store.size, hazards: [...store.values()] });
      }
      const m = u.pathname.match(/^\/hazards\/(\w+)\/(confirm|clear)$/);
      if (m) {
        const h = store.get(m[1]);
        if (!h) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
        if (m[2] === 'confirm') { h.confirms++; h.reports = 1 + h.confirms; h.lastReport = now; }
        else { h.clears++; if (h.clears >= 2) { store.delete(h.id); return send({ ok: true, removed: true }); } }
        return send({ ok: true, hazard: h });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return srv;
}

(async () => {
  const srv = fakeServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });

  /* ── 假的 Capacitor：模擬打包成 App 的環境 ── */
  await page.addInitScript(() => {
    window.__nativeSpoken = [];
    window.__watcherOpts = null;
    window.__watcherRemoved = [];
    let cb = null, nextId = 1;
    window.__emit = (loc, err) => cb && cb(loc, err);
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        BackgroundGeolocation: {
          addWatcher: async (opts, callback) => { window.__watcherOpts = opts; cb = callback; return 'w' + (nextId++); },
          removeWatcher: async ({ id }) => { window.__watcherRemoved.push(id); cb = null; },
        },
        TextToSpeech: {
          speak: async o => { window.__nativeSpoken.push(o); },
          stop: async () => {},
        },
      },
    };
    // 網頁版的 API 全部弄壞，確保真的走原生分支
    Object.defineProperty(navigator, 'geolocation', {
      value: { watchPosition: () => { throw new Error('不該呼叫網頁定位'); } }, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => { throw new Error('不該呼叫瀏覽器 TTS'); }, cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    const realNow = Date.now.bind(Date); window.__clock = 0;
    Date.now = () => realNow() + window.__clock;
  });

  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);

  const R = {};

  // ── 1. 偵測到原生環境 ──
  R.detect = await page.evaluate(() => ({
    isNative: LP.Native.isNative, platform: LP.Native.platform(),
    hasBgGeo: LP.Native.hasBgGeo, hasTTS: LP.Native.hasTTS,
  }));

  // ── 2. 啟動時走背景定位，不碰網頁 geolocation ──
  await page.click('#btnStart');
  await page.waitForTimeout(300);
  R.startedNative = await page.evaluate(() => ({
    usedNative: LP.GPS.native,
    watcherId: LP.GPS.watch,
    opts: window.__watcherOpts,
    statusText: document.getElementById('lGps').textContent,
  }));

  // ── 3. 背景回呼進得來，位置有更新 ──
  R.locationFlow = await page.evaluate(() => {
    window.__emit({ latitude: 24.9, longitude: 121.3, bearing: 180, speed: 100 / 3.6, accuracy: 7 });
    return { spd: document.getElementById('spd').textContent,
             lat: LP.GPS.last && +LP.GPS.last.lat.toFixed(3) };
  });

  // ── 4. 語音走原生 TTS（背景才唸得出來） ──
  R.nativeTTS = await page.evaluate(() => {
    LP.setHazards([]); LP.hazState.clear();
    window.__nativeSpoken.length = 0;
    LP.addHazard({ type: '掉落物', lat: 24.88, lon: 121.3, roadClass: '國道',
                   road: '國1', km: 47.5, lane: '外側車道', brg: 180 });
    for (let d = 3000; d >= 0; d -= 100) {
      window.__clock += 3600;
      LP.onPos(24.88 + d / 111320, 121.3, 180, 100 / 3.6, 8, true);
    }
    return { calls: window.__nativeSpoken.length,
             first: window.__nativeSpoken[0],
             allZhTW: window.__nativeSpoken.every(o => o.lang === 'zh-TW'),
             allPlayback: window.__nativeSpoken.every(o => o.category === 'playback') };
  });

  // ── 5. 背景定位失敗 → 給出可行動的提示 ──
  R.permDenied = await page.evaluate(() => {
    window.__emit(null, { code: 'NOT_AUTHORIZED', message: 'Location permission denied' });
    return { dot: document.getElementById('dGps').className,
             label: document.getElementById('lGps').textContent,
             toast: document.getElementById('toast').textContent };
  });

  // ── 6. 「N 人回報」：上傳後被別人確認，人數會長 ──
  R.reportCount = await page.evaluate(async u => {
    LP.setHazards([]);
    LP.CFG.hazUrl = u;
    LP.onPos(24.5, 121.2, 180, 100 / 3.6, 8, true);
    LP.quickReport('掉落物');
    await new Promise(r => setTimeout(r, 300));
    const mine = LP.HAZARDS()[0];
    const afterUpload = { reports: mine.reports, serverId: mine.serverId, synced: mine.synced };
    // 別人在同一個地方回報 → 後端併成確認
    await fetch(u + '/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: mine.lat, lon: mine.lon, type: '掉落物', device: 'other1' }) });
    await fetch(u + '/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: mine.lat, lon: mine.lon, type: '掉落物', device: 'other2' }) });
    await LP.pullHazards({ lat: 24.5, lon: 121.2 }, true);
    const h = LP.HAZARDS().find(x => x.serverId === afterUpload.serverId);
    return { afterUpload, afterOthers: h && h.reports, stillMine: h && h.mine,
             listHtml: document.getElementById('hazList').textContent.replace(/\s+/g, ' ').slice(0, 90) };
  }, base);

  // ── 7. 語音在 2 人以上會唸出人數 ──
  R.countInSpeech = await page.evaluate(() => {
    LP.hazState.clear();
    const h = LP.HAZARDS()[0];
    h.reports = 4;
    window.__nativeSpoken.length = 0;
    for (let d = 3000; d >= 0; d -= 100) {
      window.__clock += 3600;
      LP.onPos(h.lat + d / 111320, h.lon, 180, 100 / 3.6, 8, true);
    }
    return { spoken: window.__nativeSpoken.map(o => o.text),
             hudText: document.getElementById('hazTx').textContent };
  });

  // ── 8. 「我也看到了」會打到後端並更新人數 ──
  R.confirmVote = await page.evaluate(async () => {
    // 造一筆別人的回報
    LP.setHazards([]);
    await LP.pullHazards({ lat: 24.5, lon: 121.2 }, true);
    const h = LP.HAZARDS().find(x => !x.mine);
    const before = h.reports;
    await LP.voteHazard(h, 'confirm');
    const after = LP.HAZARDS().find(x => x.serverId === h.serverId);
    return { before, after: after.reports, iConfirmed: after.iConfirmed,
             buttonGone: !document.querySelector(`[data-hazok="${after.id}"]`) };
  });

  // ── 9. 兩票「已清掉了」→ 從清單消失 ──
  R.clearVote = await page.evaluate(async () => {
    const h = LP.HAZARDS().find(x => !x.mine);
    await LP.voteHazard(h, 'clear');
    const mid = LP.HAZARDS().length;
    await LP.voteHazard(LP.HAZARDS().find(x => x.serverId === h.serverId) || h, 'clear');
    return { afterFirst: mid, afterSecond: LP.HAZARDS().length };
  });

  // ── 10. UI ──
  await page.click('#tabs button[data-v="report"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'shot-reports.png' });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
  srv.close();
})();
