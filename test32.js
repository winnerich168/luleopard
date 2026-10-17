/* test32 — 安坑交流道下來：直行中央路不能報橫向環河路的區間；真的轉進環河路要照報

   實地回報（截圖 74396）：國3 新店（安坑）交流道下匝道後直行中央路，
   畫面顯示「區間測速 53m · 環河路（中央路至白馬寺）」，還唸了「進入區間測速」。
   原因：區間起點就在匝道出口的路口；照相名稱括號裡寫「中央路至白馬寺」被當成中央路上的照相；
   匝道上的方向容許 62° 太寬（航向 34°～54° 對上東西向 90°）。
   用真實路網（匝道→中央路／匝道→環河路）＋真實照相資料，每 3 公尺一步。
*/
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/roadgraph.min.json'), 'utf8'));
const CAMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/speedcams.min.json'), 'utf8'));
const TAGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs/data/camroads.min.json'), 'utf8')).cams;
const rad = d => d * Math.PI / 180;
const brg = (a, b, c, d) => { const p = rad(a), q = rad(c), dl = rad(d - b);
  return (Math.atan2(Math.sin(dl) * Math.cos(q), Math.cos(p) * Math.sin(q) - Math.sin(p) * Math.cos(q) * Math.cos(dl)) * 180 / Math.PI + 360) % 360; };
const hav = (a, b, c, d) => Math.hypot((c - a) * 111320, (d - b) * 111320 * Math.cos(rad(a)));
const pts = ci => { const f = G.chains[ci][5], o = []; let la = 0, lo = 0; for (let k = 0; k < f.length; k += 2) { la += f[k]; lo += f[k + 1]; o.push([la / 1e5, lo / 1e5]); } return o; };
// 用起點座標找鏈，路網重建後 index 會變
const chainAt = (la, lo, key) => G.chains.findIndex((c, i) => (!key || G.keys[c[2]] === key) && hav(...pts(i)[0], la, lo) < 3);
const RAMP = chainAt(24.96784, 121.52655), JOIN = chainAt(24.97198, 121.52903), ZHONGYANG = chainAt(24.97213, 121.52914, '名:中央路'),
      HUANHE = chainAt(24.99181, 121.53319, '名:環河路');
function build(chs) {
  const line = chs.flatMap((c, k) => k ? pts(c).slice(1) : pts(c)), r = [];
  for (let i = 0; i < line.length - 1; i++) { const [a, b] = [line[i], line[i + 1]], n = Math.max(1, Math.round(hav(...a, ...b) / 3)), h = brg(...a, ...b);
    for (let k = 0; k < n; k++) r.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, h]); }
  return r;
}
(async () => {
  const fails = [];
  if ([RAMP, JOIN, ZHONGYANG, HUANHE].some(x => x < 0)) { console.log('✗ 路網裡找不到安坑交流道附近的路段', [RAMP, JOIN, ZHONGYANG, HUANHE]); process.exit(1); }
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = []; page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route(/^https?:/, r => r.abort());
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => (window.__said = window.__said || []).push(u.text), cancel: () => {}, getVoices: () => [], onvoiceschanged: null }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; }; navigator.vibrate = () => true;
    const real = Date.now.bind(Date); window.__t = real(); Date.now = () => window.__t;
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(800); await page.click('#btnStart');
  await page.evaluate(({ g, cams, tags }) => { LP.loadRoadNet(g); LP.CFG.useSeed = false; LP.CFG.icNotice = false; LP.CFG.dirFilter = true;
    LP.clearPacks(); LP.addPack('t', cams); LP.loadCamRoads({ cams: tags }); }, { g: G, cams: CAMS, tags: TAGS });
  const drive = (route, slow) => page.evaluate(async ({ route, slow }) => {
    LP.resetTrip(); window.__said = []; window.__t += 3600e3; let secShown = false;
    for (let i = 0; i < route.length; i++) { const [la, lo, h] = route[i];
      const v = Math.max(slow, 40 - i * 0.4) / 3.6; window.__t += 3 / v * 1000;
      LP.onPos(la, lo, h, v, 5, false); await new Promise(r => setTimeout(r, 30));
      if (document.getElementById('secRow').className) secShown = true; }
    return { said: window.__said.filter(t => /區間/.test(t)), secShown };
  }, { route, slow });
  const straight = await drive(build([RAMP, JOIN, ZHONGYANG]), 8);
  const turn = await drive(build([RAMP, HUANHE]), 30);
  await browser.close();
  console.log('直行中央路：', straight); console.log('轉進環河路：', turn);
  if (straight.said.length) fails.push('直行中央路卻唸了區間：' + straight.said.join(' / '));
  if (straight.secShown) fails.push('直行中央路卻顯示區間進度列');
  if (!turn.said.some(t => /進入區間測速/.test(t))) fails.push('轉進環河路沒有唸「進入區間測速」');
  if (!turn.said.some(t => /區間測速結束/.test(t))) fails.push('轉進環河路跑完沒有唸結果');
  fails.push(...errs);
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test32 安坑交流道 區間測速');
  process.exit(fails.length ? 1 : 0);
})();
