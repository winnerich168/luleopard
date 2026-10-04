/* test27 — 氣壓計分辨高架與平面

   使用者的原則：氣壓只看「上去之前」到現在的變化，基準點很重要；
   天氣不好、讀值不穩時就不用氣壓，只靠行駛軌跡。

   同一組位置（GPS 落在平面市民大道上，旁邊就是市民高架），只改氣壓讀值：
     1. 沒有氣壓計            → 分不出哪一層，不報高架的出口
     2. 跟基準差不多          → 確定在平面，不報高架的出口
     3. 比基準高 10 公尺      → 確定在高架上（GPS 飄到平面那邊），報高架的出口
     4. 比基準高但讀值亂跳    → 不採信氣壓，不報
     5. 比基準高但沒有基準點  → 不採信氣壓，不報
     6. 基準點超過 5 分鐘      → 不採信氣壓，不報

/* 原 test26 說明：

   實地回報：報交流道時，下方鄰近的快速道路也有出口，所以會誤報；照相也會報到別條路的。
   另外：出口改成 2 公里前播報，畫面與地圖顯示接下來兩個出口、公里數隨接近遞減。

   用 docs/data/roadgraph.min.json 的真實路網幾何模擬開車（每步 1 秒、時速 100）：
     1. 國1 南下從基隆開到林口：依序報出這條路的出口，報的時候約 2 公里，
        五楊高架的出口（編號「高架…」）一個都不能出現
     2. 國1 平面與五楊高架重疊處各放一支照相：開在平面只報平面那支
     3. 開在市民大道平面道路（頭上是市民高架）：一個出口都不能報
     4. 開在五楊高架、汐五高架上（底下就是國1）：報出來的出口一定要是自己這條高架的，
        不能出現底下國1的出口
   路徑都加上 ±8 公尺的左右飄移，模擬 GPS 誤差。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/roadgraph.min.json'), 'utf8'));

/* ── 在 node 這邊解出鏈的幾何，產生模擬路徑 ── */
const R_E = 6371000, rad = d => d * Math.PI / 180;
const hav = (a, b, c, d) => { const p = rad(a), q = rad(c), dp = rad(c - a), dl = rad(d - b);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2; return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(h))); };
const brg = (a, b, c, d) => { const p = rad(a), q = rad(c), dl = rad(d - b);
  return (Math.atan2(Math.sin(dl) * Math.cos(q), Math.cos(p) * Math.sin(q) - Math.sin(p) * Math.cos(q) * Math.cos(dl)) * 180 / Math.PI + 360) % 360; };
function chainPts(ci) {
  const f = G.chains[ci][5], pts = []; let la = 0, lo = 0;
  for (let k = 0; k < f.length; k += 2) { la += f[k]; lo += f[k + 1]; pts.push([la / 1e5, lo / 1e5]); }
  return pts;
}
/** 沿著鏈從 a 公尺走到 b 公尺，每 step 公尺一個點 [lat, lon, heading] */
function path_(ci, a, b, step) {
  const pts = chainPts(ci), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(...pts[i - 1], ...pts[i]));
  const out = [];
  for (let s = a; s <= Math.min(b, cum[cum.length - 1]); s += step) {
    let i = 0; while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    const h = brg(...pts[i], ...pts[i + 1]);
    // GPS 左右飄移 ±8 公尺（固定的偽隨機，每次跑結果一樣）
    const j = Math.sin(s * 12.9898) * 8, pr = rad(h + 90);
    const la = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t + j * Math.cos(pr) / 111320;
    const lo = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t + j * Math.sin(pr) / (111320 * Math.cos(rad(pts[i][0])));
    out.push([la, lo, h, s]);
  }
  return out;
}
const findChain = pred => G.chains.findIndex((c, i) => pred(c, G.keys[c[2]], c[3].map(n => G.names[n]), i));
const start = ci => chainPts(ci)[0];

(async () => {
  // 平面市民大道：找一條跟市民高架東行同方向、並行最長的
  const el6 = findChain((c, k) => k === '名:市民大道高架道路' && c[1] === 1 && Math.abs(start(G.chains.indexOf(c))[1] - 121.50375) < 0.001);
  const elPts = chainPts(el6);
  let sm = -1, smLen = 0;
  G.chains.forEach((c, i) => {
    const nm = c[3].map(n => G.names[n]);
    if (c[0] === 4 || !nm.some(n => /^市民大道/.test(n)) || /高架/.test(G.keys[c[2]])) return;
    const p = chainPts(i); if (p.length < 4) return;
    const b1 = brg(...p[0], ...p[p.length - 1]), b2 = brg(...elPts[0], ...elPts[elPts.length - 1]);
    if (Math.abs(((b1 - b2 + 540) % 360) - 180) > 40) return;
    let L = 0; for (let k = 1; k < p.length; k++) L += hav(...p[k - 1], ...p[k]);
    if (L > smLen) { smLen = L; sm = i; }
  });
  console.log('市民高架東行', el6, '平面市民大道', sm, Math.round(smLen), '公尺');
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/tile.openstreetmap.org/**', r => r.abort());
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
  await page.evaluate(g => { LP.loadRoadNet(g); }, G);

  // 時速 50、每秒一筆；氣壓每 0.25 秒一筆
  const pts = path_(sm, 0, smLen, 14);
  const drive = (opt) => page.evaluate(async ({ pts, opt }) => {
    LP.CFG.useSeed = false; LP.CFG.icNotice = true; LP.CFG.icDist = 2000; LP.clearPacks();
    LP.resetTrip(); window.__said = [];
    const B = LP.BARO;
    B.avail = opt.avail; B.samples.length = 0; B.spikeUntil = 0;
    B.base = opt.base; B.baseT = window.__t - (opt.baseAgeMs || 0);
    let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    const layers = new Set(); let confN = 0;
    for (const [la, lo, hd] of pts) {
      for (let k = 0; k < 4; k++) { window.__t += 250; if (opt.avail) LP.baroPush(opt.h + rnd() * 2 * opt.noise, window.__t); }
      LP.onPos(la, lo, hd, 14, 5, false);
      const M = LP.MYROAD;
      if (M.conf) { confN++; layers.add(LP.isElevRoad(LP.ROADNET.roads[M.ri]) ? '高架' : '平面'); }
      await new Promise(r => setTimeout(r, 0));
    }
    return { said: window.__said.filter(t => /^前方/.test(t)), layers: [...layers], confN, state: B.state,
             baroStat: document.getElementById('baroStat').textContent };
  }, { pts, opt });

  const R = {};
  R.沒有氣壓計 = await drive({ avail: false });
  R.上了高架 = await drive({ avail: true, base: 0, h: 10, noise: 0.3 });
  R.在平面 = await drive({ avail: true, base: 0, h: 0.5, noise: 0.3 });
  R.讀值亂跳 = await drive({ avail: true, base: 0, h: 10, noise: 3 });
  R.沒有基準點 = await drive({ avail: true, base: null, h: 10, noise: 0.3 });
  R.基準太舊 = await drive({ avail: true, base: 0, h: 10, noise: 0.3, baseAgeMs: 6 * 60e3 + 0 });
  await browser.close();
  console.log(JSON.stringify(R, null, 1));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('沒有氣壓計：不報出口', R.沒有氣壓計.said.length === 0);
  ok('氣壓比基準高：判成高架並報高架的出口', R.上了高架.said.length >= 1 && R.上了高架.layers.includes('高架') && !R.上了高架.layers.includes('平面'));
  ok('在平面：不報出口、判成平面', R.在平面.said.length === 0 && !R.在平面.layers.includes('高架'));
  ok('讀值亂跳：不採信，不報', R.讀值亂跳.said.length === 0 && /不穩|跳動/.test(R.讀值亂跳.state));
  ok('沒有基準點：不採信，不報', R.沒有基準點.said.length === 0);
  ok('基準太舊：不採信，不報', R.基準太舊.said.length === 0);
  ok('設定頁顯示氣壓狀態', /比基準 \+/.test(R.上了高架.baroStat));
  ok('沒有 JS 錯誤', errs.length === 0);
  console.log(fails.length ? '\n✗ 失敗：\n  ' + fails.join('\n  ') : '\n✓ 全部通過');
  process.exit(fails.length ? 1 : 0);
})();
