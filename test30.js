/* test30 — 北部實際路線：新店 → 國3 南下 → 鶯歌系統 → 國2 西向 → 機場系統 → 國1 北上 → 南崁

   實地回報：這一段有部分測速照相播報時機不對、位置有誤差。
   用真實路網＋真實照相資料（docs/data/speedcams.min.json、camroads.min.json）
   每秒一步、時速 100、GPS 左右飄移 ±8 公尺，記下每一句照相語音當下
   「沿路還有多遠才到那支照相」，跟它自己唸出來的距離比對。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/roadgraph.min.json'), 'utf8'));
const CAMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/speedcams.min.json'), 'utf8'));
const TAGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/camroads.min.json'), 'utf8')).cams;

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
/** 鏈上離 (lat,lon) 最近的頂點 index */
const nearestIdx = (pts, la, lo) => pts.reduce((b, p, i) => hav(p[0], p[1], la, lo) < hav(pts[b][0], pts[b][1], la, lo) ? i : b, 0);
/** 沿著鏈從 A 點走到 B 點（取最近頂點），每 step 公尺一個點 */
function leg(ci, A, B, step) {
  const all = chainPts(ci), i0 = nearestIdx(all, ...A), i1 = nearestIdx(all, ...B);
  const pts = all.slice(i0, i1 + 1), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(...pts[i - 1], ...pts[i]));
  const out = [];
  for (let s = 0; s <= cum[cum.length - 1]; s += step) {
    let i = 0; while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, brg(...pts[i], ...pts[i + 1])]);
  }
  return out;
}
const chainOf = (key, from) => G.chains.findIndex((c, i) => G.keys[c[2]] === key && c[0] === 0 && c[1] === 1 &&
  hav(...chainPts(i)[0], ...from) < 3000);

const XINDIAN = [24.9655, 121.5433], YINGGE = [24.9422, 121.3245], AIRPORT_SYS = [25.0120, 121.2790], NANKAN = [25.0560, 121.2960];
function build(legs) {
  const route = legs.flatMap(([ci, A, B]) => leg(ci, A, B, 28));
  const S = [0];
  for (let i = 1; i < route.length; i++) S.push(S[i - 1] + hav(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]));
  // GPS 左右飄移 ±8 公尺（固定的偽隨機，每次跑結果一樣）
  const drift = route.map(([la, lo, h], i) => { const j = Math.sin(S[i] * 12.9898) * 8, pr = rad(h + 90);
    return [la + j * Math.cos(pr) / 111320, lo + j * Math.sin(pr) / (111320 * Math.cos(rad(la))), h]; });
  return { route, S, drift };
}
// 去程：國3 南下（基隆出發的鏈）→ 國2 西向（鶯歌系統出發）→ 國1 北上（高雄出發）
const GO = build([[chainOf('國3', [25.1397, 121.7147]), XINDIAN, YINGGE],
                  [chainOf('國2', YINGGE), YINGGE, AIRPORT_SYS],
                  [chainOf('國1', [22.5774, 120.3168]), AIRPORT_SYS, NANKAN]]);
// 回程：國1 南下 → 國2 東向 → 國3 北上
const BACK = build([[chainOf('國1', [25.1231, 121.7358]), NANKAN, AIRPORT_SYS],
                    [chainOf('國2', [25.0659, 121.2177]), AIRPORT_SYS, YINGGE],
                    [chainOf('國3', [22.4414, 120.4976]), YINGGE, XINDIAN]]);

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route(/tile\.openstreetmap\.org|wmts\.nlsc\.gov\.tw/, r => r.abort());
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

  const drive = trip => page.evaluate(async ({ pts, cams, tags }) => {
    LP.CFG.useSeed = false; LP.CFG.dirFilter = true; LP.CFG.icNotice = false;
    LP.clearPacks(); LP.addPack('t', cams); LP.loadCamRoads({ cams: tags });
    LP.resetTrip(); window.__said = [];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const [la, lo, hd] = pts[i];
      window.__t += 1000;
      const n = window.__said.length;
      LP.onPos(la, lo, hd, 28, 5, false);
      await new Promise(r => setTimeout(r, 90));        // 第 3 級插隊語音延遲 80ms
      for (const t of window.__said.slice(n)) if (/測速|區間/.test(t))
        out.push({ i, t, sub: document.getElementById('alertSub').textContent });
    }
    return out;
  }, { pts: trip.drift, cams: CAMS, tags: TAGS });
  const logs = { 去程: await drive(GO), 回程: await drive(BACK) };
  await browser.close();

  const fails = [];
  const check = (label, { route, S }, log, want, wrongDir) => {
    // 每支照相在路線上的位置：路線上最近的點
    const camOnRoute = CAMS.map(c => { let bi = 0, bd = 1e9;
      route.forEach((p, i) => { const d = hav(p[0], p[1], c[0], c[1]); if (d < bd) { bd = d; bi = i; } });
      return { c, i: bi, off: bd }; }).filter(x => x.off < 3000);
    const rows = [];
    for (const x of log) {
      if (/已通過/.test(x.t)) continue;
      const m = x.t.match(/(\d+(?:\.\d+)?)(公里|公尺)/), said = m ? +m[1] * (m[2] === '公里' ? 1000 : 1) : null;
      const cam = camOnRoute.find(o => x.sub.includes(o.c[4])) || null;
      const real = cam ? Math.round(S[cam.i] - S[x.i]) : null;
      rows.push({ at: Math.round(S[x.i]), said: x.t, cam: cam ? cam.c[4] : x.sub, offRoute: cam ? Math.round(cam.off) : null, realAhead: real });
      if (!cam || cam.off > 60) fails.push(label + ' 報了不在這條路線上的照相：' + x.t + ' · ' + x.sub);
      else if (said != null && Math.abs(said - real) > Math.max(150, real * 0.2)) fails.push(`${label} 唸的距離跟實際差太多：唸 ${said}m、實際 ${real}m · ${cam.c[4]}`);
    }
    console.log('\n' + label, Math.round(S[S.length - 1] / 1000), '公里');
    console.table(rows);
    for (const w of want) if (!rows.some(r => r.cam.includes(w))) fails.push(label + ' 沒有報：' + w);
    if (rows.some(r => wrongDir.test(r.cam))) fails.push(label + ' 報了對向的照相');
  };
  check('去程 新店→南崁', GO, logs.去程, ['國道三號南向39.3公里'], /北向|東向/);
  check('回程 南崁→新店', BACK, logs.回程, ['國道二號東向11.8公里', '國道二號東向18.5公里', '國道三號北向38.3公里'], /南向|西向/);
  if (errs.length) fails.push(...errs);
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test30 北部路線照相播報');
  process.exit(fails.length ? 1 : 0);
})();
