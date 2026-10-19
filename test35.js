/* test35 — 播報警示時讓電台（其他 App）暫停，唸完才還回去
   用假的 Capacitor（原生 App 環境）：TextToSpeech 唸一句 300ms，AudioFocus 記下每次呼叫。
   要確認：唸之前先要焦點、連續幾句中間不放、整串唸完才放、啟動時先放掉 TTS 外掛的工作階段、網頁版不呼叫。 */
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');

(async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  async function open(native) {
    const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
    page.errs = []; page.on('pageerror', e => page.errs.push('PAGEERROR: ' + e.message));
    await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
    await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route(/tile\.openstreetmap\.org|wmts\.nlsc\.gov\.tw/, r => r.abort());
    await page.addInitScript(native => {
      window.__log = [];
      const t0 = Date.now(), log = m => window.__log.push([Date.now() - t0, m]);
      Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => { log('web:' + u.text); setTimeout(() => u.onend && u.onend(), 50); }, cancel: () => {}, getVoices: () => [], onvoiceschanged: null, speaking: false, pending: false, paused: false }, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      if (!native) return;
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
        TextToSpeech: { speak: o => { log('speak:' + o.text); return new Promise(r => setTimeout(r, 300)); }, stop: () => Promise.resolve() },
        AudioFocus: { request: o => { log('request:' + o.mode); return Promise.resolve({ granted: true, mode: o.mode }); },
                      release: () => { log('release'); return Promise.resolve(); } },
      } };
    }, native);
    await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
    await page.waitForTimeout(800);
    await page.click('#btnStart');
    return page;
  }
  const log = p => p.evaluate(() => window.__log.map(x => x[1]));

  // ── App 版 ──
  const A = await open(true);
  await A.waitForTimeout(2300);
  let L = await log(A);
  ok(L.includes('release'), '啟動時沒有先放掉語音外掛的工作階段：' + L);
  await A.evaluate(() => { window.__log.length = 0; });
  // 連續三句
  await A.evaluate(() => { LP.Audio_.say('前方測速照相'); LP.Audio_.say('速限一百'); LP.Audio_.say('注意掉落物'); });
  await A.waitForTimeout(700);
  L = await log(A);
  ok(L[0] === 'request:mute', '唸之前沒先要焦點：' + L);
  ok(!L.includes('release'), '三句還沒唸完就放掉焦點：' + L);
  await A.waitForTimeout(2200);
  L = await log(A);
  const sp = L.filter(x => x.startsWith('speak:'));
  ok(sp.length === 3, '三句沒都唸到：' + L);
  ok(L.filter(x => x === 'request:mute').length === 1, '連續幾句中間又重要焦點：' + L);
  ok(L[L.length - 1] === 'release' && L.filter(x => x === 'release').length === 1, '唸完沒放焦點（或放了不只一次）：' + L);
  // 放掉之後再來一句：要重新要
  await A.evaluate(() => { window.__log.length = 0; LP.Audio_.say('區間測速結束'); });
  await A.waitForTimeout(1500);
  L = await log(A);
  ok(L.join() === 'request:mute,speak:區間測速結束,release', '第二輪順序不對：' + L);
  // 插隊（第 3 級警告會切掉前一句）：不能卡住焦點
  await A.evaluate(() => { window.__log.length = 0; LP.Audio_.say('前方五百公尺測速'); setTimeout(() => LP.Audio_.say('就在這裡', true), 100); });
  await A.waitForTimeout(2000);
  L = await log(A);
  ok(L.includes('speak:就在這裡') && L[L.length - 1] === 'release', '插隊後焦點沒放：' + L);

  // ── 網頁版：沒有原生外掛，照常用瀏覽器語音，不出錯 ──
  const W = await open(false);
  await W.evaluate(() => { window.__log.length = 0; LP.Audio_.say('前方測速照相'); });
  await W.waitForTimeout(600);
  L = await log(W);
  ok(L.join() === 'web:前方測速照相', '網頁版語音不對：' + L);

  fails.push(...A.errs, ...W.errs);
  await browser.close();
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test35 播報時電台暫停');
  process.exit(fails.length ? 1 : 0);
})();
