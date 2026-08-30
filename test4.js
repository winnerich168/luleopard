/* 端到端：build_speedcams.py 的輸出 → HTTP → App 的「從資料源更新」 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'etl', 'dist');

(async () => {
  // 起一個本機 server 模擬 GitHub Pages（含 CORS header）
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const file = path.join(DIST, path.basename(url));
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url === '/broken.json') { res.writeHead(500); return res.end('boom'); }
    if (url === '/empty.json')  { res.writeHead(200, {'content-type':'application/json'}); return res.end('[]'); }
    if (!fs.existsSync(file))   { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, {'content-type':'application/json; charset=utf-8'});
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch();
  const page = await (await browser.newContext({viewport:{width:414,height:896},locale:'zh-TW'})).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type()==='error' && !/ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(() => {
    Object.defineProperty(window,'speechSynthesis',{value:{speak:()=>{},cancel:()=>{},getVoices:()=>[],
      set onvoiceschanged(v){},get onvoiceschanged(){return null}},configurable:true});
    window.SpeechSynthesisUtterance = function(t){ this.text = t; };
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);

  const R = {};
  const expected = JSON.parse(fs.readFileSync(path.join(DIST,'speedcams.min.json'),'utf8'));
  R.scriptOutputRows = expected.length;
  R.startCams = await page.evaluate(() => LP.CAMS().length);

  // ---- 1. 成功更新 ----
  R.feedOk = await page.evaluate(async u => {
    LP.CFG.feedUrl = u;
    const ok = await LP.feedUpdate(false);
    return {ok, cams: LP.CAMS().length, packs: LP.PACKS().map(p => p.name),
            stat: document.getElementById('feedStat').textContent,
            feedCount: LP.CFG.feedCount};
  }, base + '/speedcams.min.json');

  // ---- 2. 資料忠實度：名稱/速限/方向/區間旗標都對得起來 ----
  R.fidelity = await page.evaluate(exp => {
    const cams = LP.CAMS();
    const miss = [];
    for (const e of exp) {
      const hit = cams.find(c => Math.abs(c.lat-e[0])<1e-6 && Math.abs(c.lon-e[1])<1e-6);
      if (!hit) { miss.push(['遺失', e[4]]); continue; }
      if (hit.lim !== e[2]) miss.push(['速限不符', e[4], hit.lim, e[2]]);
      if (hit.name !== e[4]) miss.push(['名稱不符', e[4], hit.name]);
      if (hit.sec !== /區間/.test(e[3])) miss.push(['區間旗標不符', e[4]]);
    }
    return {checked: exp.length, problems: miss};
  }, expected);

  // ---- 3. GeoJSON 也吃得下（同一份資料的另一種格式） ----
  R.geojsonFeed = await page.evaluate(async u => {
    LP.clearPacks();
    LP.CFG.feedUrl = u;
    const ok = await LP.feedUpdate(false);
    return {ok, cams: LP.CAMS().length};
  }, base + '/speedcams.geojson');

  // ---- 4. 更新失敗時不能砸掉既有資料 ----
  R.failKeepsData = await page.evaluate(async u => {
    const before = LP.CAMS().length;
    LP.CFG.feedUrl = u;
    const ok = await LP.feedUpdate(true);
    return {ok, before, after: LP.CAMS().length,
            stat: document.getElementById('feedStat').textContent};
  }, base + '/broken.json');

  // ---- 5. 空資料源也不能砸掉既有資料 ----
  R.emptyKeepsData = await page.evaluate(async u => {
    const before = LP.CAMS().length;
    LP.CFG.feedUrl = u;
    const ok = await LP.feedUpdate(true);
    return {ok, before, after: LP.CAMS().length};
  }, base + '/empty.json');

  // ---- 6. 重複更新不會讓點數翻倍 ----
  R.idempotent = await page.evaluate(async u => {
    LP.CFG.feedUrl = u;
    await LP.feedUpdate(true); const a = LP.CAMS().length;
    await LP.feedUpdate(true); const b = LP.CAMS().length;
    return {first: a, second: b, packs: LP.PACKS().length};
  }, base + '/speedcams.min.json');

  // ---- 7. 資料源的點位真的會觸發警示 ----
  R.alerts = await page.evaluate(() => {
    const cam = LP.CAMS().find(c => c.lim > 0 && /雙向|南下|北上/.test(c.dir));
    const spoken = []; const orig = window.speechSynthesis.speak;
    window.speechSynthesis.speak = u => spoken.push(u.text);
    let clock = 0; const realNow = Date.now.bind(Date); Date.now = () => realNow() + clock;
    LP.state.clear();
    const north = /南下|北往南/.test(cam.dir);
    for (let d = 1400; d >= 0; d -= 50) {
      clock += 1800;
      const lat = north ? cam.lat + d/111320 : cam.lat - d/111320;
      LP.onPos(lat, cam.lon, north ? 180 : 0, 90/3.6, 8, true);
    }
    Date.now = realNow; window.speechSynthesis.speak = orig;
    return {cam: cam.name, lim: cam.lim, dir: cam.dir, spoken};
  });

  // ---- 8. UI ----
  await page.click('#btnSkip');
  await page.click('#tabs button[data-v="data"]');
  await page.waitForTimeout(200);
  R.ui = {
    dbStat: await page.textContent('#dbStat'),
    feedStat: await page.textContent('#feedStat'),
    packList: await page.textContent('#packList'),
  };
  await page.screenshot({path: 'shot-feed.png'});

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
  server.close();
})();
