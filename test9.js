/* v1.1：過期事件的自動下架 —— 撤銷、被動車流探針、置信度降級 */
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');

/* 假後端：記錄收到的探針與撤銷 */
function fakeServer() {
  const store = new Map();
  const log = { probes: [], retracts: [] };
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
      const send = o => { res.writeHead(o.__status || 200, { 'content-type': 'application/json' });
                          delete o.__status; res.end(JSON.stringify(o)); };
      const now = Date.now();

      if (u.pathname === '/report') {
        const id = 's' + (++seq);
        const h = { id, type: j.type, lat: j.lat, lon: j.lon, brg: j.brg ?? null,
                    note: j.note || '', roadClass: j.roadClass || '一般道路',
                    t: now, lastReport: now, expires: now + 2 * 3600e3,
                    confirms: 0, clears: 0, reports: 1, score: 2,
                    probes: { clear: 0, still: 0 }, by: (j.device || '').slice(0, 12) };
        store.set(id, h);
        return send({ ok: true, merged: false, hazard: h });
      }
      if (u.pathname === '/hazards') return send({ ok: true, hazards: [...store.values()] });

      let m = u.pathname.match(/^\/hazards\/(\w+)\/probe$/);
      if (m) {
        const h = store.get(m[1]);
        if (!h) return send({ __status: 404, error: 'not found' });
        log.probes.push({ id: m[1], slowed: !!j.slowed, body: j });
        if (j.slowed) h.probes.still++; else h.probes.clear++;
        h.score = 2 * Math.pow(0.72, h.probes.clear) * Math.pow(1.18, h.probes.still);
        if (h.score < 0.4) { store.delete(h.id); return send({ ok: true, removed: true, reason: '車流顯示已排除' }); }
        return send({ ok: true, score: h.score, probes: h.probes });
      }
      m = u.pathname.match(/^\/hazards\/(\w+)\/retract$/);
      if (m) {
        const h = store.get(m[1]);
        if (!h) return send({ __status: 404, error: 'not found' });
        log.retracts.push({ id: m[1], device: j.device });
        if (h.by !== (j.device || '').slice(0, 12))
          return send({ __status: 403, error: '這不是你回報的事件' });
        store.delete(h.id);
        return send({ ok: true, retracted: true });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  srv.__log = log; srv.__store = store;
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
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const R = {};

  // ── 1. 使用者情境：10:00 回報事故，10:35 已排除 ──
  R.userScenario = await page.evaluate(() => {
    const now = Date.now();
    const mk = min => ({ type: '事故', t: now - min * 60e3, lastReport: now - min * 60e3,
                         confirms: 0, probes: { clear: 0, still: 0 } });
    // 一定要把同一個 now 傳進 hazScore。
    // 不傳的話 hazScore 會自己取 Date.now()，比建立事件時晚幾毫秒，
    // 25 分鐘（正好是事故的半衰期）算出來就會是 0.9999… 而不是 1.0，
    // 剛好卡在出聲門檻下面 —— 測試會時好時壞，而且看起來像程式壞了。
    const at = min => {
      const s = LP.hazScore(mk(min), now);
      return { 分鐘: min, 分數: +s.toFixed(2), 狀態: LP.scoreLabel(s),
               會出聲: s >= LP.SCORE_SPEAK, 會顯示: s >= LP.SCORE_SHOW };
    };
    // 有 3 台車經過沒減速的版本
    const probed = min => {
      const h = mk(min); h.probes.clear = 3;
      const s = LP.hazScore(h, now);
      return { 分鐘: min, 分數: +s.toFixed(2), 狀態: LP.scoreLabel(s), 會顯示: s >= LP.SCORE_SHOW };
    };
    return { '10:00 剛回報': at(0), '10:25': at(25), '10:35': at(35), '11:00': at(60),
             '10:35 且3台車沒減速': probed(35), '10:10 且3台車沒減速': probed(10) };
  });

  // ── 2. 低置信度事件不出聲，只顯示 ──
  R.degrade = await page.evaluate(() => {
    const out = {};
    const run = h => {
      LP.setHazards([h]); LP.hazState.clear();
      window.__spoken.length = 0;
      let cls = '';
      for (let d = 3000; d >= 0; d -= 100) {
        window.__clock += 3600;
        LP.onPos(h.lat + d / 111320, h.lon, 180, 100 / 3.6, 8, true);
        if (document.getElementById('hazRow').className) cls = document.getElementById('hazRow').className;
      }
      return { 語音數: window.__spoken.length, 畫面: cls,
               文字: document.getElementById('hazTx').textContent };
    };
    const base = { type: '事故', lat: 24.6, lon: 121.3, roadClass: '國道', brg: 180,
                   expires: Date.now() + 3600e3, confirms: 0, probes: { clear: 0, still: 0 } };
    out['剛回報'] = run(LP.makeHazard({ ...base }));
    const old = LP.makeHazard({ ...base });
    old.t = old.lastReport = Date.now() - 35 * 60e3;
    out['35分鐘前'] = run(old);
    const dead = LP.makeHazard({ ...base });
    dead.t = dead.lastReport = Date.now() - 90 * 60e3;
    out['90分鐘前'] = run(dead);
    return out;
  });

  // ── 3. 被動探針：沒減速 ──
  R.probeNoSlowdown = await page.evaluate(async u => {
    LP.CFG.hazUrl = u; LP.CFG.probeSend = true;
    LP.setHazards([]); LP.PROBE.cruise.length = 0; LP.PROBE.watch.clear();
    const H = { lat: 24.30, lon: 121.10 };
    // 先建立巡航速度樣本：時速 100 開一段
    for (let i = 0; i < 20; i++) { window.__clock += 2000; LP.onPos(24.34 - i * 0.0005, H.lon, 180, 100 / 3.6, 8, true); }
    LP.addHazard({ type: '掉落物', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 });
    await new Promise(r => setTimeout(r, 250));
    const h = LP.HAZARDS()[0];
    // 全程維持時速 100 通過（沒減速）
    for (let d = 600; d >= -700; d -= 50) {
      window.__clock += 1800;
      LP.onPos(H.lat + d / 111320, H.lon, 180, 100 / 3.6, 8, true);
    }
    await new Promise(r => setTimeout(r, 350));
    return { 事件id: h.serverId, 剩餘事件數: LP.HAZARDS().length };
  }, base);
  R.probeNoSlowdownLog = srv.__log.probes.map(p => ({ slowed: p.slowed }));

  // ── 4. 被動探針：有減速 ──
  srv.__log.probes.length = 0;
  R.probeSlowdown = await page.evaluate(async u => {
    LP.setHazards([]); LP.PROBE.cruise.length = 0; LP.PROBE.watch.clear();
    const H = { lat: 24.20, lon: 121.10 };
    for (let i = 0; i < 20; i++) { window.__clock += 2000; LP.onPos(24.24 - i * 0.0005, H.lon, 180, 100 / 3.6, 8, true); }
    LP.addHazard({ type: '事故', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 });
    await new Promise(r => setTimeout(r, 250));
    // 接近時降到時速 30（明顯減速）
    for (let d = 600; d >= -700; d -= 50) {
      window.__clock += 3000;
      const v = Math.abs(d) < 300 ? 30 : 100;
      LP.onPos(H.lat + d / 111320, H.lon, 180, v / 3.6, 8, true);
    }
    await new Promise(r => setTimeout(r, 350));
    return { 剩餘事件數: LP.HAZARDS().length };
  }, base);
  R.probeSlowdownLog = srv.__log.probes.map(p => ({ slowed: p.slowed }));

  // ── 5. 塞車中不誤判（基準本來就慢）──
  srv.__log.probes.length = 0;
  R.probeInJam = await page.evaluate(async u => {
    LP.setHazards([]); LP.PROBE.cruise.length = 0; LP.PROBE.watch.clear();
    const H = { lat: 24.10, lon: 121.10 };
    // 全程都只有時速 15（本來就在塞車）
    for (let i = 0; i < 20; i++) { window.__clock += 8000; LP.onPos(24.14 - i * 0.0003, H.lon, 180, 15 / 3.6, 8, true); }
    LP.addHazard({ type: '事故', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 });
    await new Promise(r => setTimeout(r, 250));
    for (let d = 600; d >= -700; d -= 50) {
      window.__clock += 12000;
      LP.onPos(H.lat + d / 111320, H.lon, 180, 15 / 3.6, 8, true);
    }
    await new Promise(r => setTimeout(r, 300));
    return { 剩餘事件數: LP.HAZARDS().length };
  }, base);
  R.probeInJamLog = { 送出探針數: srv.__log.probes.length };

  // ── 6. 關閉探針就不送 ──
  srv.__log.probes.length = 0;
  R.probeDisabled = await page.evaluate(async () => {
    LP.CFG.probeSend = false;
    LP.setHazards([]); LP.PROBE.cruise.length = 0; LP.PROBE.watch.clear();
    const H = { lat: 24.05, lon: 121.10 };
    for (let i = 0; i < 20; i++) { window.__clock += 2000; LP.onPos(24.09 - i * 0.0005, H.lon, 180, 100 / 3.6, 8, true); }
    LP.addHazard({ type: '掉落物', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 });
    await new Promise(r => setTimeout(r, 200));
    for (let d = 600; d >= -700; d -= 50) { window.__clock += 1800; LP.onPos(H.lat + d / 111320, H.lon, 180, 100 / 3.6, 8, true); }
    await new Promise(r => setTimeout(r, 250));
    LP.CFG.probeSend = true;
    return { 剩餘事件數: LP.HAZARDS().length };
  });
  R.probeDisabledLog = { 送出探針數: srv.__log.probes.length };

  // ── 7. 撤銷自己的回報 ──
  srv.__log.retracts.length = 0;
  R.retract = await page.evaluate(async u => {
    LP.setHazards([]);
    LP.CFG.hazUrl = u;
    LP.onPos(23.9, 120.9, 180, 80 / 3.6, 8, true);
    LP.addHazard({ type: '施工', lat: 23.9, lon: 120.9, roadClass: '國道', brg: 180 });
    await new Promise(r => setTimeout(r, 250));
    const h = LP.HAZARDS()[0];
    const hadServerId = !!h.serverId;
    LP.renderHazards();
    const btn = document.querySelector('[data-hazretract]');
    const hasBtn = !!btn;
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 300));
    return { 上傳過: hadServerId, 有撤銷鈕: hasBtn, 撤銷後剩餘: LP.HAZARDS().length };
  }, base);
  R.retractLog = srv.__log.retracts.length;
  R.retractServerCount = srv.__store.size;

  // ── 8. 別人的回報不該有撤銷鈕（只能投票）──
  R.othersNoRetract = await page.evaluate(() => {
    LP.setHazards([LP.makeHazard({ type: '事故', lat: 23.8, lon: 120.9, mine: false,
                                   serverId: 'other1', brg: 180 })]);
    LP.renderHazards();
    return { 有撤銷鈕: !!document.querySelector('[data-hazretract]'),
             有已清掉鈕: !!document.querySelector('[data-hazclear]') };
  });

  await page.click('#tabs button[data-v="report"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'shot-decay.png' });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  // ── 硬性檢查 ──
  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };
  const S = R.userScenario;
  ok('10:00 剛回報要出聲', S['10:00 剛回報'].會出聲 === true);
  ok('10:25 還要出聲', S['10:25'].會出聲 === true);
  ok('10:35 降級成不出聲但仍顯示', S['10:35'].會出聲 === false && S['10:35'].會顯示 === true);
  ok('11:00 完全下架', S['11:00'].會顯示 === false);
  ok('35 分 + 3 台車沒減速 → 下架', S['10:35 且3台車沒減速'].會顯示 === false);
  ok('10 分 + 3 台車沒減速 → 只降級不下架', S['10:10 且3台車沒減速'].會顯示 === true);
  ok('剛回報會播報', R.degrade['剛回報'].語音數 > 0);
  ok('35 分鐘前不播報但畫面還在', R.degrade['35分鐘前'].語音數 === 0 && /show/.test(R.degrade['35分鐘前'].畫面));
  ok('90 分鐘前畫面消失', R.degrade['90分鐘前'].畫面 === '');
  ok('沒減速要送 slowed=false 探針',
     R.probeNoSlowdownLog.length === 1 && R.probeNoSlowdownLog[0].slowed === false);
  ok('有減速要送 slowed=true 探針',
     R.probeSlowdownLog.length === 1 && R.probeSlowdownLog[0].slowed === true);
  ok('本來就塞車不送探針（避免誤判）', R.probeInJamLog.送出探針數 === 0);
  ok('關閉探針就完全不送', R.probeDisabledLog.送出探針數 === 0);
  ok('自己的回報有撤銷鈕', R.retract.有撤銷鈕 === true);
  ok('撤銷後本機立刻移除', R.retract.撤銷後剩餘 === 0);
  ok('撤銷有送到後端', R.retractLog === 1);
  ok('別人的回報沒有撤銷鈕', R.othersNoRetract.有撤銷鈕 === false);
  ok('別人的回報可以投「已清掉」', R.othersNoRetract.有已清掉鈕 === true);
  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test9 全部通過');
  await browser.close();
  srv.close();
  process.exit(fails.length ? 1 : 0);
})();
