/* test26 — 只報「正在走的這條路、這個方向」的出口與照相

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
  // 國1 南下：從基隆出發的那條
  const n1 = findChain((c, k) => k === '國1' && c[1] === 1 && Math.abs(start(G.chains.indexOf(c))[0] - 25.123) < 0.01);
  // 五楊高架南下：從五股出發
  const wy = findChain((c, k) => k === '國1+高架' && c[1] === 1 && Math.abs(start(G.chains.indexOf(c))[0] - 25.0747) < 0.003);
  // 汐五高架南下（汐止 → 五股）
  const xw = findChain((c, k, nm) => k === '國1+高架' && c[1] === 1 && nm.includes('汐止五股高架道路') && Math.abs(start(G.chains.indexOf(c))[1] - 121.63) < 0.01);
  // 市民大道平面（不是高架）
  const sm = findChain((c, k, nm) => !k.includes('高架') && c[0] !== 4 && nm.some(n => n === '市民大道' || /^市民大道[一二三四五六七八]段$/.test(n)) && chainPts(G.chains.indexOf(c)).length > 8);
  console.log('chains', { n1, wy, xw, sm });

  // 照相：五楊上一支、正下方國1上一支
  const wyPts = path_(wy, 6000, 6000, 1)[0];
  const n1Pts = chainPts(n1);
  let bestD = 1e9, camN1 = null;
  for (const p of path_(n1, 0, 60000, 10)) { const d = hav(p[0], p[1], wyPts[0], wyPts[1]); if (d < bestD) { bestD = d; camN1 = p; } }
  console.log('兩支照相相距', Math.round(bestD), '公尺；國1 照相在沿路', camN1[3], '公尺');

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
    // 模擬時鐘：每一步 = 1 秒
    const real = Date.now.bind(Date); window.__t = real(); Date.now = () => window.__t;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800);
  await page.click('#btnStart');
  await page.waitForTimeout(200);
  await page.evaluate(g => { LP.loadRoadNet(g); }, G);

  const drive = async (pts, cams) => page.evaluate(async ({ pts, cams }) => {
    LP.CFG.useSeed = false; LP.CFG.dirFilter = true; LP.CFG.icNotice = true; LP.CFG.icDist = 2000;
    LP.clearPacks();
    if (cams) { LP.addPack('t', cams.rows); LP.loadCamRoads({ cams: cams.tags }); }
    LP.resetTrip(); window.__said = [];
    const log = [], alerts = new Set(), rows = [], conf = [];
    for (const [la, lo, hd, s] of pts) {
      window.__t += 1000;
      const n = window.__said.length;
      LP.onPos(la, lo, hd, 28, 5, false);
      for (const t of window.__said.slice(n)) log.push({ s: Math.round(s), t });
      const sub = document.getElementById('alertSub').textContent;
      if (/國道一號/.test(sub)) alerts.add(sub);
      const row = document.getElementById('icRow');
      if (row.classList.contains('show')) rows.push({ s: Math.round(s), tx: document.getElementById('icTx').textContent });
      conf.push(LP.MYROAD.conf ? 1 : 0);
      await new Promise(r => setTimeout(r, 0));
    }
    const marks = document.querySelectorAll('.exitPin').length;
    return { log, alerts: [...alerts], rows, confRatio: conf.reduce((a, b) => a + b, 0) / conf.length, marks };
  }, { pts, cams });

  const R = {};
  // 1+2. 國1 南下 基隆 → 林口，重疊處兩支照相
  const camLat = (p) => +p[0].toFixed(6), camLon = (p) => +p[1].toFixed(6);
  const cams = {
    rows: [[camLat(camN1), camLon(camN1), 100, '', '國道一號南向（平面）'],
           [camLat(wyPts), camLon(wyPts), 100, '', '國道一號五楊南向（高架）']],
    tags: {
      [camN1[0].toFixed(5) + ',' + camN1[1].toFixed(5)]: [0, '國1', 'motorway', 'name', 1, '國1', '中山高速公路'],
      [wyPts[0].toFixed(5) + ',' + wyPts[1].toFixed(5)]: [1, '國1', 'motorway', 'name', 1, '國1+高架', '五股楊梅高架道路'],
    } };
  R.國1 = await drive(path_(n1, 0, camN1[3] + 600, 28), cams);
  // 3. 市民大道平面
  R.市民平面 = sm >= 0 ? await drive(path_(sm, 0, 8000, 20), null) : null;
  // 4. 開在五楊、汐五高架上
  R.五楊 = await drive(path_(wy, 0, 20000, 28), null);
  R.汐五 = xw >= 0 ? await drive(path_(xw, 0, 19000, 28), null) : null;
  // 5. 沒有路網：完全靜默
  await page.evaluate(() => { LP.ROADNET.v2 = false; LP.ROADNET.exits = new Map(); });
  R.沒路網 = await drive(path_(n1, 0, 12000, 28), null);
  await browser.close();

  const exitSaid = l => l.filter(x => /^前方.*(出口|交流道|系統|服務區)/.test(x.t) && !/測速/.test(x.t));
  const g = exitSaid(R.國1.log);
  console.log('\n國1 南下報的出口：'); g.forEach(x => console.log('  ', x.s, x.t));
  console.log('\n顯示列（抽樣）：'); R.國1.rows.filter((_, i) => i % 60 === 0).slice(0, 12).forEach(x => console.log('  ', x.s, x.tx));
  console.log('\n照相語音：', R.國1.log.filter(x => /測速/.test(x.t)).map(x => x.s + ' ' + x.t));
  console.log('信心比例 國1', R.國1.confRatio.toFixed(2), '市民平面', R.市民平面 && R.市民平面.confRatio.toFixed(2), '五楊', R.五楊.confRatio.toFixed(2));
  console.log('市民平面語音', R.市民平面 && R.市民平面.log, '顯示', R.市民平面 && R.市民平面.rows.slice(0, 3));
  console.log('五楊語音', R.五楊.log.map(x => x.s + ' ' + x.t));
  console.log('汐五語音', R.汐五 && R.汐五.log.map(x => x.s + ' ' + x.t), '信心', R.汐五 && R.汐五.confRatio.toFixed(2));
  console.log('錯誤', errs);

  // 出口播報時的距離：用路網裡的出口沿路位置換算
  const exN1 = G.exits.filter(e => e[0] === n1);
  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('國1 南下至少報 8 個出口', g.length >= 8);
  ok('沒有報到五楊高架的出口', !g.some(x => /出口高架/.test(x.t)));
  for (const want of ['汐止交流道', '內湖交流道', '圓山交流道', '台北交流道', '三重交流道', '五股交流道'])
    ok('報了 ' + want, g.some(x => x.t.includes(want)));
  // 每個報出來的出口，距離應該接近 2 公里（第一個例外：開始時就在 2 公里內）
  for (const x of g.slice(1)) {
    const m = x.t.match(/前方([\d.]+)(公里|公尺)/); const d = m ? (+m[1]) * (m[2] === '公里' ? 1000 : 1) : 0;
    ok('2 公里前報（' + x.t + '）', d >= 1700 && d <= 2050);
  }
  ok('畫面顯示兩個出口', R.國1.rows.some(r => (r.tx.match(/km|m/g) || []).length >= 2));
  ok('地圖上有出口標記', R.國1.marks >= 1);
  const camSaid = R.國1.log.filter(x => /測速/.test(x.t));
  ok('平面照相有報', camSaid.length >= 1);
  ok('畫面上出現過平面照相', R.國1.alerts.some(n => /平面/.test(n)));
  ok('畫面上從沒出現高架照相', !R.國1.alerts.some(n => /五楊/.test(n)));
  ok('市民大道平面：沒有報任何出口', !R.市民平面 || exitSaid(R.市民平面.log).length === 0);
  ok('市民大道平面：沒有顯示出口', !R.市民平面 || R.市民平面.rows.length === 0);
  // 高架上報的出口，一定要是那條高架鏈上的出口
  // （同一條路分岔處，例如汐五接五楊，兩條鏈是同一個道路身分，前方出口算同一條路的）
  const ownNames = ci => new Set(G.exits.filter(e => G.chains[e[0]][2] === G.chains[ci][2]).flatMap(e => [e[3], e[5]]).filter(Boolean));
  const notOwn = (r, ci) => exitSaid(r.log).filter(x => !/有出口$/.test(x.t) && ![...ownNames(ci)].some(n => x.t.includes(n)));
  ok('五楊上沒有報到別條路的出口 ' + JSON.stringify(notOwn(R.五楊, wy)), notOwn(R.五楊, wy).length === 0);
  ok('汐五上沒有報到別條路的出口 ' + JSON.stringify(R.汐五 && notOwn(R.汐五, xw)), !R.汐五 || notOwn(R.汐五, xw).length === 0);
  ok('國1 上沒有報到別條路的出口 ' + JSON.stringify(notOwn(R.國1, n1)), notOwn(R.國1, n1).length === 0);
  const named = g.filter(x => !/有出口$/.test(x.t));
  ok('同一個出口只報一次', new Set(named.map(x => x.t.replace(/前方[^，]*，/, ''))).size === named.length);
  ok('沒有路網時完全不報出口', exitSaid(R.沒路網.log).length === 0 && R.沒路網.rows.length === 0);
  ok('沒有 JS 錯誤', errs.length === 0);
  console.log(fails.length ? '\n✗ 失敗：\n  ' + fails.join('\n  ') : '\n✓ 全部通過');
  process.exit(fails.length ? 1 : 0);
})();
