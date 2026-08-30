/* 掉落物回報與警示：樁號推算、EXIF、兩種道路類別的警示距離、一鍵通報 */
const { chromium } = require('playwright');
const path = require('path');

/* 造一張帶 GPS EXIF 的最小 JPEG（只要 SOI + APP1，足以測解析器） */
function jpegWithGPS(latDeg, latMin, latSec, ns, lonDeg, lonMin, lonSec, ew) {
  const entries = [];                     // GPS IFD entries
  const rats = [];                        // rational payload
  const push = (tag, type, cnt, valOrOff) => entries.push({ tag, type, cnt, valOrOff });

  // 先算 payload 位置（TIFF 起點為 0）
  // 佈局: [TIFF header 8][IFD0: 2+12+4][GPS IFD: 2+n*12+4][rationals]
  const ifd0Off = 8, ifd0Size = 2 + 12 + 4;
  const gpsOff = ifd0Off + ifd0Size;
  const nGps = 4;
  const gpsSize = 2 + nGps * 12 + 4;
  let payload = gpsOff + gpsSize;

  const latOff = payload; payload += 24;   // 3 rationals
  const lonOff = payload; payload += 24;

  push(1, 2, 2, null);                     // GPSLatitudeRef  (ASCII, inline)
  push(2, 5, 3, latOff);
  push(3, 2, 2, null);                     // GPSLongitudeRef
  push(4, 5, 3, lonOff);

  const buf = Buffer.alloc(payload + 8);
  let o = 0;
  buf.writeUInt16BE(0x4D4D, o); o += 2;    // 'MM' big-endian
  buf.writeUInt16BE(42, o); o += 2;
  buf.writeUInt32BE(ifd0Off, o); o += 4;
  // IFD0: 一個 entry 指向 GPS IFD
  buf.writeUInt16BE(1, ifd0Off);
  buf.writeUInt16BE(0x8825, ifd0Off + 2);
  buf.writeUInt16BE(4, ifd0Off + 4);
  buf.writeUInt32BE(1, ifd0Off + 6);
  buf.writeUInt32BE(gpsOff, ifd0Off + 10);
  buf.writeUInt32BE(0, ifd0Off + 14);
  // GPS IFD
  buf.writeUInt16BE(nGps, gpsOff);
  entries.forEach((e, i) => {
    const p = gpsOff + 2 + i * 12;
    buf.writeUInt16BE(e.tag, p);
    buf.writeUInt16BE(e.type, p + 2);
    buf.writeUInt32BE(e.cnt, p + 4);
    if (e.type === 2) {                     // ASCII inline: 'N\0' / 'E\0'
      const ch = e.tag === 1 ? ns : ew;
      buf.write(ch, p + 8, 'ascii'); buf.writeUInt8(0, p + 9);
    } else buf.writeUInt32BE(e.valOrOff, p + 8);
  });
  buf.writeUInt32BE(0, gpsOff + 2 + nGps * 12);
  const wr = (off, vals) => vals.forEach((v, i) => {
    buf.writeUInt32BE(Math.round(v * 1000), off + i * 8);
    buf.writeUInt32BE(1000, off + i * 8 + 4);
  });
  wr(latOff, [latDeg, latMin, latSec]);
  wr(lonOff, [lonDeg, lonMin, lonSec]);

  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), buf]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xFFE1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, exif, Buffer.from([0xFF, 0xD9])]);
}

(async () => {
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

  // ── 1. 樁號名稱解析 ──
  R.parseKm = await page.evaluate(() => ({
    '國道1號南下 47.5K': LP.parseKmName('桃園市 蘆竹區 國道1號南下 47.5K'),
    '國道5號 15K-28K': LP.parseKmName('宜蘭縣 頭城鎮 國道5號南下 15K-28K'),
    '台61線60.1公里處': LP.parseKmName('新竹縣 新豐鄉 台61線60.1公里處'),
    '台9線117k+772m': LP.parseKmName('宜蘭縣 蘇澳鎮 台9線117k+772m新澳隧道北上'),
    '一般路口(應為null)': LP.parseKmName('新竹縣 竹北市 中華路與興隆路口'),
  }));

  // ── 2. 從國道資料建立錨點並推估里程 ──
  R.kmEstimate = await page.evaluate(() => {
    LP.clearPacks();
    // 兩個國道1號南下的樁號錨點
    LP.addPack('國道測試', [
      [25.048611, 121.290833, 100, '南下', '桃園市 蘆竹區 國道1號南下 47.5K'],
      [24.309722, 120.712500, 100, '北上', '臺中市 后里區 國道1號北上 168.2K'],
    ]);
    const n = LP.buildKmAnchors();
    // 站在 47.5K 錨點南方 1 公里處、朝南（南下 → 里程增加）
    const pos = { lat: 25.048611 - 1000 / 111320, lon: 121.290833, heading: 180, speed: 100 / 3.6 };
    const e1 = LP.kmEstimate(pos);
    // 同一點朝北（北上 → 里程遞減）
    const e2 = LP.kmEstimate({ ...pos, heading: 0 });
    return { anchors: n, southbound: e1, northbound: e2 };
  });

  // ── 3. 使用者校正後改用 GPS 推進 ──
  R.kmLock = await page.evaluate(() => {
    const p0 = { lat: 25.0, lon: 121.3, heading: 180, speed: 27.8 };
    LP.kmLock(50.0, '國1', p0, '南下');
    const after2km = { lat: 25.0 - 2000 / 111320, lon: 121.3, heading: 180, speed: 27.8 };
    const e = LP.kmEstimate(after2km);
    const back = { lat: 25.0 + 500 / 111320, lon: 121.3, heading: 0, speed: 27.8 };
    const e2 = LP.kmEstimate(back);
    return { drove2kmSouth: { km: +e.km.toFixed(2), conf: e.conf },
             drove500mNorth: { km: +e2.km.toFixed(2), conf: e2.conf } };
  });

  // ── 4. 樁號快選清單：往後 0.5 + 往前約一分鐘 ──
  R.kmChoices = await page.evaluate(() => {
    const pos = { lat: 25.0, lon: 121.3, heading: 180, speed: 100 / 3.6 };
    LP.kmLock(50.0, '國1', pos, '南下');
    const est = LP.kmEstimate(pos);
    const list = LP.kmChoices(est, pos);
    const slow = LP.kmChoices(est, { ...pos, speed: 30 / 3.6 });
    // 選 51.0K → 應落在正前方 1 公里
    const ll = LP.kmToLatLon(51.0, est, pos);
    return { count: list.length, first: list[0], last: list[list.length - 1],
             slowCount: slow.length, slowLast: slow[slow.length - 1],
             offsetM: Math.round(LP.dist(pos.lat, pos.lon, ll[0], ll[1])),
             isSouth: ll[0] < pos.lat };
  });

  // ── 5. 警示距離：高速 vs 一般道路 ──
  R.tiers = await page.evaluate(() => {
    const at = kmh => {
      const v = kmh / 3.6;
      const f = LP.hazTiers({ roadClass: '國道' }, v).map(Math.round);
      const g = LP.hazTiers({ roadClass: '一般道路' }, v).map(Math.round);
      return { 國道: f, 一般道路: g, 國道秒數: +(f[0] / v).toFixed(0) };
    };
    return { '時速100': at(100), '時速110': at(110), '時速20(塞車)': at(20), '時速50': at(50) };
  });

  // ── 6. 高速掉落物：從 3 公里外開始三級遞減 ──
  R.freewayAlert = await page.evaluate(() => {
    LP.setHazards([]); LP.hazState.clear();
    const H = { lat: 24.9, lon: 121.3 };
    LP.addHazard({ type: '掉落物', lat: H.lat, lon: H.lon, roadClass: '國道',
                   road: '國1', km: 47.5, lane: '外側車道', brg: 180 });
    window.__spoken.length = 0;
    const log = [];
    for (let d = 4000; d >= 0; d -= 100) {
      window.__clock += 3600;                                    // 100m @ 100km/h
      LP.onPos(H.lat + d / 111320, H.lon, 180, 100 / 3.6, 8, true);
      const cls = document.getElementById('hazRow').className;
      if (cls) log.push({ d, cls });
    }
    return { firstAlertAt: log[0] && log[0].d, t3At: (log.find(x => /t3/.test(x.cls)) || {}).d,
             spoken: window.__spoken.slice() };
  });

  // ── 7. 一般道路：500 公尺才開始 ──
  R.localAlert = await page.evaluate(() => {
    LP.setHazards([]); LP.hazState.clear();
    const H = { lat: 24.8, lon: 121.4 };
    LP.addHazard({ type: '路面坑洞', lat: H.lat, lon: H.lon, roadClass: '一般道路', brg: 180 });
    window.__spoken.length = 0;
    let first = null;
    for (let d = 1200; d >= 0; d -= 50) {
      window.__clock += 4000;
      LP.onPos(H.lat + d / 111320, H.lon, 180, 45 / 3.6, 8, true);
      if (!first && document.getElementById('hazRow').className) first = d;
    }
    return { firstAlertAt: first, spoken: window.__spoken.slice() };
  });

  // ── 8. 對向車道不誤報 ──
  R.oppositeLane = await page.evaluate(() => {
    LP.setHazards([]); LP.hazState.clear();
    const H = { lat: 24.7, lon: 121.5 };
    LP.addHazard({ type: '掉落物', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 }); // 南下側
    window.__spoken.length = 0;
    // 我在北上（heading 0），從南方接近
    LP.onPos(H.lat - 800 / 111320, H.lon, 0, 100 / 3.6, 8, true);
    const north = document.getElementById('hazRow').className;
    LP.hazState.clear();
    // 換成南下，從北方接近 → 應該要報
    LP.onPos(H.lat + 800 / 111320, H.lon, 180, 100 / 3.6, 8, true);
    return { 北上經過南下側: north || '(無警示)', 南下同側: document.getElementById('hazRow').className };
  });

  // ── 9. 已經開過去的不再報 ──
  R.behind = await page.evaluate(() => {
    LP.setHazards([]); LP.hazState.clear();
    const H = { lat: 24.6, lon: 121.6 };
    LP.addHazard({ type: '掉落物', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 });
    LP.onPos(H.lat - 300 / 111320, H.lon, 180, 100 / 3.6, 8, true);   // 已通過
    return document.getElementById('hazRow').className || '(無警示)';
  });

  // ── 10. 一鍵通報：位置往回退、可復原 ──
  R.quick = await page.evaluate(() => {
    LP.setHazards([]);
    const pos = { lat: 24.5, lon: 121.2 };
    LP.onPos(pos.lat, pos.lon, 180, 100 / 3.6, 8, true);
    LP.quickReport('掉落物');
    const h = LP.HAZARDS()[0];
    const backM = Math.round(LP.dist(pos.lat, pos.lon, h.lat, h.lon));
    const hasUndo = !!document.getElementById('undoBtn');
    const isBehind = h.lat > pos.lat;                    // 朝南開 → 事件應在北邊(後方)
    document.getElementById('undoBtn').click();

    // 畫面上的兩顆快捷鈕：事故與掉落物
    LP.setHazards([]);
    LP.onPos(pos.lat, pos.lon, 180, 100 / 3.6, 8, true);
    document.getElementById('fabCrash').click();
    const crash = LP.HAZARDS()[0] && LP.HAZARDS()[0].type;
    document.getElementById('undoBtn').click();
    LP.onPos(pos.lat, pos.lon, 180, 100 / 3.6, 8, true);
    document.getElementById('fabQuick').click();
    const drop = LP.HAZARDS()[0] && LP.HAZARDS()[0].type;
    document.getElementById('undoBtn').click();
    const sz = id => Math.round(document.getElementById(id).getBoundingClientRect().width);

    return { type: h.type, roadClass: h.roadClass, backM, isBehind, hasUndo,
             afterUndo: LP.HAZARDS().length,
             快捷鈕: { 事故: crash, 掉落物: drop,
                      尺寸: { 事故: sz('fabCrash'), 掉落物: sz('fabQuick'), 其他: sz('fabMore') } } };
  });

  // ── 11. 過期事件不再警示 ──
  R.expiry = await page.evaluate(() => {
    LP.setHazards([]); LP.hazState.clear();
    const H = { lat: 24.4, lon: 121.1 };
    const h = LP.makeHazard({ type: '掉落物', lat: H.lat, lon: H.lon, roadClass: '國道', brg: 180 });
    h.expires = Date.now() - 1000;
    LP.setHazards([h]);
    LP.onPos(H.lat + 500 / 111320, H.lon, 180, 100 / 3.6, 8, true);
    return document.getElementById('hazRow').className || '(無警示)';
  });

  // ── 12. EXIF 解析 ──
  const jpg = jpegWithGPS(24, 55, 30, 'N', 121, 17, 27, 'E');       // 24.925, 121.29083
  const jpgSW = jpegWithGPS(24, 55, 30, 'S', 121, 17, 27, 'W');
  R.exif = await page.evaluate(([b64, b64sw]) => {
    const toBuf = b => { const s = atob(b), u = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
    const out = {};
    try { const g = LP.exifGPS(toBuf(b64)); out.ok = { lat: +g.lat.toFixed(5), lon: +g.lon.toFixed(5) }; }
    catch (e) { out.ok = 'ERR ' + e.message; }
    try { const g = LP.exifGPS(toBuf(b64sw)); out.southWest = { lat: +g.lat.toFixed(3), lon: +g.lon.toFixed(3) }; }
    catch (e) { out.southWest = 'ERR ' + e.message; }
    try { LP.exifGPS(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer); out.notJpeg = '應該要拋錯'; }
    catch (e) { out.notJpeg = e.message; }
    try { LP.exifGPS(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9, 0, 0, 0, 0, 0, 0, 0, 0]).buffer); out.noExif = '應該要拋錯'; }
    catch (e) { out.noExif = e.message; }
    return out;
  }, [jpg.toString('base64'), jpgSW.toString('base64')]);

  // ── 12b.「其他類型」選單：6 秒沒選就自動收起 ──
  R.fabMenu = await page.evaluate(async () => {
    const open = () => LP.fabMenuOpen();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.getElementById('fabMore').click();
    out.opened = open();
    out.hasCountdownBar = !!document.querySelector('#fabMenuBar i.run');
    out.itemCount = document.querySelectorAll('#fabMenu [data-fq]').length;
    await sleep(3000);
    out.stillOpenAt3s = open();
    await sleep(3600);
    out.autoClosedAt6_6s = !open();

    // 再開一次，中途碰一下 → 倒數重新計時，不該在原本的 6 秒關掉
    document.getElementById('fabMore').click();
    await sleep(4000);
    document.getElementById('fabMenu').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(3000);
    out.touchResetsTimer = open();          // 原本 4+3=7s 早該關了，碰過所以還開著
    await sleep(3600);
    out.closesAfterReset = !open();

    // 點畫面其他地方要收起來
    document.getElementById('fabMore').click();
    const wasOpen = open();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    out.outsideTapCloses = wasOpen && !open();

    // e.target 是 document（不是 Element）時不能爆炸
    document.getElementById('fabMore').click();
    try { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          out.documentTargetSafe = true; }
    catch (err) { out.documentTargetSafe = 'THREW: ' + err.message; }
    LP.closeFabMenu();

    // 選了項目要通報並關閉
    LP.setHazards([]);
    LP.onPos(24.5, 121.2, 180, 100 / 3.6, 8, true);
    document.getElementById('fabMore').click();
    document.querySelector('[data-fq="施工"]').click();
    out.pickedType = LP.HAZARDS()[0] && LP.HAZARDS()[0].type;
    out.closedAfterPick = !open();
    const u = document.getElementById('undoBtn'); if (u) u.click();
    return out;
  });

  // ── 13. UI ──
  await page.click('#tabs button[data-v="report"]');
  await page.waitForTimeout(250);
  R.ui = {
    kmNow: await page.textContent('#kmNow'),
    kmRoad: await page.textContent('#kmRoad'),
    kmChips: await page.$$eval('#kmChips button', b => b.length),
    hazTarget: (await page.textContent('#hazTarget')).replace(/\s+/g, ' ').trim().slice(0, 120),
  };
  await page.click('#tabs button[data-v="map"]');
  await page.waitForTimeout(200);
  R.ui.fabVisible = await page.isVisible('#fabQuick');
  R.ui.roadSpeak = await page.evaluate(()=>[LP.roadSpeak('國1'),LP.roadSpeak('台61'),LP.roadSpeak('')]);
  await page.screenshot({ path: 'shot-haz.png' });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
})();
