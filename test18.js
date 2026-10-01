/* test18 — 語音播報：不互相切掉、從遠到近、所有路況來源都要唸

   實地回報：「不會播報」。查出三件事：
   1. 每一句都先 cancel() 再 speak()：測速警示唸到一半，事故／已通過一出來就被切掉；
      Chrome／Android 在 cancel() 後立刻 speak() 還會把新的那句一起吃掉。
      → 改成語音佇列，只有第 3 級「就在這裡」才插隊。
   2. 要從遠到近一路唸。（原本另加 1 公里遠距預告，之後改成完全依車速：時速 × 5 公尺）
      之後 600 → 330 → 就在前方，一路倒數。
   3. 「回報」頁新增的事故／施工／坑洞，和 TDX 抓回來有座標的事件，只列清單不出聲。

   這支用「會花時間唸」的假語音引擎（一個字 0.2 秒，cancel 會切斷正在唸的那句），
   並用 page.clock 控制時間，才測得出「被切掉」。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/tile.openstreetmap.org/**', r => r.abort());
  await page.clock.install({ time: new Date('2026-09-27T08:00:00') });

  await page.addInitScript(() => {
    const log = window.__speech = []; let cur = null, q = [];
    function next() {
      if (cur || !q.length) return;
      cur = q.shift(); cur._st = Date.now();
      cur._tm = setTimeout(() => {
        log.push({ t: cur._st, txt: cur.text, done: true });
        const u = cur; cur = null; u.onend && u.onend({}); next();
      }, cur.text.length * 200);
    }
    const ss = {
      speak(u) { if (!u.text.trim()) return; q.push(u); next(); },
      cancel() {
        if (cur) { clearTimeout(cur._tm); log.push({ t: cur._st, txt: cur.text, done: false }); cur = null; }
        q.forEach(u => log.push({ t: Date.now(), txt: u.text, done: false })); q = [];
      },
      resume() {}, pause() {}, get paused() { return false },
      get speaking() { return !!cur }, get pending() { return q.length > 0 },
      getVoices: () => [], onvoiceschanged: null };
    Object.defineProperty(window, 'speechSynthesis', { value: ss, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
  });

  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.clock.runFor(1500);
  await page.click('#btnStart');
  await page.clock.runFor(4000);

  const M = 1 / 111320;                    // 1 公尺的緯度差
  await page.evaluate(M => {
    window.__speech.length = 0; LP.resetTrip();
    const lat0 = 24.0, lon0 = 121.0;
    LP.CFG.useSeed = false; LP.clearPacks();
    LP.addPack('t', [[lat0 + 3000 * M, lon0, 100, '北上', '測試測速']]);
    // 一鍵回報的事故（HAZARDS）
    LP.setHazards([LP.makeHazard({ type: '事故', lat: lat0 + 3400 * M, lon: lon0, road: '國1',
      roadClass: '國道', km: 50.2, brg: 0, mine: false })]);
    // 回報頁新增的施工（REPORTS）
    LP.setReports([{ id: 'r1', lat: lat0 + 4500 * M, lon: lon0, kind: '施工', lim: 0, note: '', t: Date.now() }]);
    // 官方即時事件（後端代抓的 TDX，拉回來後在 HAZARDS 裡標 src:'official'）
    LP.setHazards(LP.HAZARDS().concat([LP.makeHazard({ id: 'o-test1', type: '事故', lat: lat0 + 7500 * M, lon: lon0,
      road: '國道一號', roadClass: '國道', dir: '北向', km: 30.5, brg: 0, brgTol: 110,
      official: 'open', src: 'official', mine: false })]));
  }, M);

  const v = 27.8;                          // 時速 100，每秒一筆定位
  for (let i = 0; i < 330; i++) {
    await page.evaluate(([i, v, M]) => LP.onPos(24.0 + i * v * M, 121.0, 0, v, 5, false), [i, v, M]);
    await page.clock.runFor(1000);
  }
  await page.clock.runFor(15000);
  const log = await page.evaluate(() => window.__speech);
  const done = log.filter(l => l.done).map(l => l.txt);
  const cut = log.filter(l => !l.done).map(l => l.txt);

  const R = { 唸完: done, 被切斷: cut, errors: errs };
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };
  const camIdx = re => done.findIndex(t => re.test(t));

  // 從遠到近：時速 × 5 → × 2.5 → 就在前方（時速 100：500 → 250 → 120 公尺），順序不能亂
  //（以前另有 1 公里遠距預告；改成完全依車速後拿掉了）
  const i1 = camIdx(/^前方\d+公尺，測速照相/);
  const i2 = camIdx(/^注意，\d+公尺測速照相/);
  const i3 = camIdx(/^測速照相，速限100$/);
  ok('三段都有唸完', i1 >= 0 && i2 >= 0 && i3 >= 0);
  ok('從遠到近依序播報', i1 < i2 && i2 < i3);
  ok('第一聲約在 500 公尺（時速 100 × 5）', i1 >= 0 && Math.abs(+done[i1].match(/前方(\d+)公尺/)[1] - 500) <= 40);
  ok('測速警示沒有被其他語音切斷', !cut.some(t => /測速照相，速限|公尺，測速照相|公尺測速照相/.test(t)));

  // 各種路況來源都要唸
  ok('一鍵回報的事故有播報', done.some(t => /事故，國道1號/.test(t)));
  ok('回報頁的施工有播報', done.some(t => /施工/.test(t)));
  ok('回報頁的施工從遠到近', done.some(t => /^前方\d+公尺，注意施工/.test(t)) && done.some(t => /^施工就在前方/.test(t)));
  ok('官方事件有播報', done.some(t => /官方通報/.test(t)) && done.filter(t => /事故就在前方/.test(t)).length >= 2);
  ok('第一聲只唸一次', done.filter(t => /^前方\d+公尺，測速照相/.test(t)).length === 1);
  ok('沒有頁面錯誤', errs.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test18 全部通過');
})();
