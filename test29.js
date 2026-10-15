/* 施工／路況播報：一般道路上不用國道的警示距離、走走停停不重唸、不報別條路的官方事件 */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
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

  const R = await page.evaluate(() => {
    const H = { lat: 24.8, lon: 121.4 };
    const official = (roadClass) => ({ id: 'o-test', type: '施工', lat: H.lat, lon: H.lon, road: roadClass === '國道' ? '國道3號' : '台3線',
      roadClass, brg: 180, brgTol: 110, t: Date.now(), lastReport: Date.now(), expires: Date.now() + 3600e3,
      since: Date.now() - 3 * 864e5, score: 1.5, official: 'open', src: 'official', reports: 1 });
    const pos = (d, kmh, hd) => ({ lat: H.lat + d / 111320, lon: H.lon, heading: hd == null ? 180 : hd, speed: kmh / 3.6, acc: 8 });
    // 假裝路網確定我在一般道路／國道上
    const setMe = cls => { LP.ROADNET.roads = [{ cls, ref: cls === '國道' ? '國3' : '', link: false, names: [] }];
                          LP.MYROAD.ri = 0; LP.MYROAD.conf = true; };
    const drive = (from, step, kmh, wobble) => {
      const out = [];
      for (let d = from, i = 0; d >= 0; d -= step, i++) {
        window.__clock += 4000;
        // 走走停停：每隔幾筆停紅燈（車速 0）、轉彎時航向偏掉
        const v = wobble && i % 3 === 0 ? 0 : kmh;
        const hd = wobble && i % 4 === 1 ? 300 : 180;
        // 第 3 級是插隊語音（延遲 80ms 才送出），所以用「已經唸到第幾級」來數，不數 __spoken
        const tierOf = st => typeof st === 'number' ? st : st ? st.tier : 0, t0 = tierOf(LP.hazState.get('o-test'));
        LP.evaluateHazards(pos(d, v, hd));
        const t1 = tierOf(LP.hazState.get('o-test'));
        if (t1 > t0) out.push({ d, tier: t1 });
      }
      return out;
    };
    const r = {};

    // A. 確定在一般道路：國道的官方施工完全不報
    LP.hazState.clear(); window.__spoken.length = 0; setMe('一般道路');
    LP.setHazards([official('國道')]);
    r.generalRoad_freewayWork = drive(2000, 50, 50, true);

    // B. 確定在一般道路：一般道路的官方施工，500 公尺才開始唸，走走停停每一級只唸一次
    LP.hazState.clear(); window.__spoken.length = 0; setMe('一般道路');
    LP.setHazards([official('一般道路')]);
    r.generalRoad_localWork = drive(2000, 50, 50, true);

    // C. 確定在國道：國道施工照舊從 1.5 公里以上開始
    LP.hazState.clear(); window.__spoken.length = 0; setMe('國道');
    LP.setHazards([official('國道')]);
    r.freeway_freewayWork = drive(4000, 100, 100, false);

    LP.MYROAD.conf = false; LP.MYROAD.ri = -1; LP.ROADNET.roads = []; LP.setHazards([]); LP.hazState.clear();
    return r;
  });

  const fail = [];
  if (R.generalRoad_freewayWork.length) fail.push('一般道路上唸了國道施工');
  const B = R.generalRoad_localWork;
  if (B.length !== 3) fail.push('一般道路施工應該剛好唸 3 次，實際 ' + B.length);
  if (B[0] && B[0].d > 700) fail.push('一般道路施工太早唸：' + B[0].d + 'm');
  const C = R.freeway_freewayWork;
  if (!C[0] || C[0].d < 1500) fail.push('國道施工應該 1.5 公里以上開始唸');
  if (C.length !== 3) fail.push('國道施工應該唸 3 次，實際 ' + C.length);
  if (errs.length) fail.push(...errs);

  console.log(JSON.stringify(R, null, 2));
  await browser.close();
  if (fail.length) { console.error('✗ ' + fail.join('\n✗ ')); process.exit(1); }
  console.log('✓ test29 施工播報');
})();
