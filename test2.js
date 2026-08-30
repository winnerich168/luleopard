const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({viewport:{width:414,height:896},locale:'zh-TW'})).newPage();
  const errs=[]; page.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  page.on('console',m=>{ if(m.type()==='error' && !/ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });

  // 在載入前就攔截語音 API
  await page.addInitScript(()=>{
    window.__spoken=[]; window.__vibes=[];
    const fake={ speak:u=>window.__spoken.push(u.text), cancel:()=>{}, getVoices:()=>[],
                 set onvoiceschanged(v){}, get onvoiceschanged(){return null} };
    Object.defineProperty(window,'speechSynthesis',{value:fake,configurable:true});
    window.SpeechSynthesisUtterance = function(t){ this.text=t; };
    navigator.vibrate = p => { window.__vibes.push(p); return true; };
    // 虛擬時鐘：讓同步測試迴圈也能反映真實經過時間
    const realNow = Date.now.bind(Date);
    window.__clock = 0;                       // 額外快轉的毫秒
    Date.now = () => realNow() + window.__clock;
  });

  await page.goto('file://'+path.join(__dirname,'luleopard.html'));
  await page.waitForTimeout(900);

  const R={};
  R.booted = await page.evaluate(()=> typeof window.LP==='object');
  R.camCount = await page.evaluate(()=> LP.CAMS().length);
  R.secCount = await page.evaluate(()=> LP.CAMS().filter(c=>c.sec).length);
  R.radarFallbackActive = await page.evaluate(()=> !document.getElementById('radarWrap').classList.contains('hidden'));

  await page.click('#btnStart');   // 解鎖語音
  await page.waitForTimeout(300);

  // 一路開向一個「南北雙向 / 有速限」的點，收集語音
  R.drive = await page.evaluate(()=>{
    const cam = LP.CAMS().find(c=>c.dir.indexOf('南北雙向')>=0 && c.lim>0 && !c.sec);
    window.__spoken.length=0; window.__vibes.length=0;
    LP.state.clear();
    for(let d=1400; d>=0; d-=25){
      window.__clock += 900;                                        // 25m @ 100km/h ≈ 0.9s
      LP.onPos(cam.lat - d/111320, cam.lon, 0, 100/3.6, 8, true);  // 時速100，速限多半60 → 超速
    }
    return {cam:cam.name, lim:cam.lim, spoken:window.__spoken.slice(), vibes:window.__vibes.length};
  });

  // 區間測速應唸「區間測速」
  R.section = await page.evaluate(()=>{
    const cam = LP.CAMS().find(c=>c.sec);
    if(!cam) return 'none';
    window.__spoken.length=0; LP.state.clear();
    for(let d=800; d>=0; d-=50){ window.__clock += 2500; LP.onPos(cam.lat - d/111320, cam.lon, 0, 70/3.6, 8, true); }
    return {name:cam.name, spoken:window.__spoken.slice()};
  });

  // 「超速才警告」開啟時，未超速的 T1/T2 應安靜
  R.onlyOver = await page.evaluate(()=>{
    LP.CFG.onlyOver = true;
    const cam = LP.CAMS().find(c=>c.dir.indexOf('南北雙向')>=0 && c.lim>=60 && !c.sec);
    window.__spoken.length=0; LP.state.clear();
    for(let d=1000; d>=200; d-=50){ window.__clock += 4500; LP.onPos(cam.lat-d/111320, cam.lon, 0, 40/3.6, 8, true); } // 時速40，未超速
    const quiet = window.__spoken.slice();
    LP.CFG.onlyOver = false;
    return {quietCount:quiet.length, quiet};
  });

  // 大範圍粗篩檢查：T1 設 1500 時，2.3km 外的點應被納入計算範圍
  R.coarse = await page.evaluate(()=>{
    LP.CFG.t1=1500; LP.state.clear();
    const cam = LP.CAMS().find(c=>c.dir.indexOf('南北雙向')>=0);
    LP.onPos(cam.lat - 2300/111320, cam.lon, 0, 30, 8, true);
    const shown = document.getElementById('alertDist').textContent;
    LP.CFG.t1=600;
    return {shown, label:document.getElementById('alertLabel').textContent};
  });

  // ── 內建的真實國道資料 ──
  R.freewayData = await page.evaluate(() => {
    const cams = LP.CAMS();
    const fw = cams.filter(c => /國道/.test(c.name));
    const roads = {};
    fw.forEach(c => { const p = LP.parseKmName(c.name); if (p) roads[p.road] = (roads[p.road] || 0) + 1; });
    const limits = {};
    fw.forEach(c => { limits[c.lim] = (limits[c.lim] || 0) + 1; });
    return { 總點數: cams.length, 國道點數: fw.length, 里程錨點: LP.buildKmAnchors(),
             國道分布: roads, 速限分布: limits,
             全部座標在台灣範圍: fw.every(c => c.lat > 21.5 && c.lat < 26.5 && c.lon > 118 && c.lon < 122.5),
             全部有速限: fw.every(c => c.lim > 0),
             全部有方向: fw.every(c => !!c.hd) };
  });

  // ── 中文數字路名的樁號解析（國道版特有）──
  R.cnRoadNames = await page.evaluate(() => ({
    '國道一號南向2公里': LP.parseKmName('國道一號南向2公里'),
    '國道十號東向21.4公里': LP.parseKmName('國道十號東向21.4公里'),
    '國道三號甲線西向1.7公里': LP.parseKmName('國道三號甲線西向1.7公里'),
    '臺2己線北向1.1公里': LP.parseKmName('臺2己線北向1.1公里'),
    '無里程數字_應為null': LP.parseKmName('國道五號北向接國3南向南港系統公里'),
    cnNum: ['一', '十', '十五', '二十五'].map(LP.cnNum),
  }));

  // ── 國道雙向各一支桿子：方向過濾要能分辨 ──
  R.dualCarriageway = await page.evaluate(() => {
    const south = LP.CAMS().find(c => /國道一號南向/.test(c.name) && c.lim === 110);
    const near = LP.CAMS().filter(c => LP.dist(south.lat, south.lon, c.lat, c.lon) < 200);
    const north = near.find(c => /北向/.test(c.name));
    const run = (startLat, heading, step) => {
      window.__spoken.length = 0; LP.state.clear();
      let lat = startLat;
      for (let d = 1400; d >= 0; d -= 50) {
        window.__clock += 1440;
        LP.onPos(lat, south.lon, heading, 125 / 3.6, 8, true);
        lat += step;
      }
      return window.__spoken.slice();
    };
    const southbound = run(south.lat + 1400 / 111320, 180, -50 / 111320);
    const northbound = north ? run(north.lat - 1400 / 111320, 0, 50 / 111320) : [];
    return {
      同位置桿數: near.length, 相距公尺: north ? Math.round(LP.dist(south.lat, south.lon, north.lat, north.lon)) : null,
      南向: south && { name: south.name, hd: south.hd },
      北向: north && { name: north.name, hd: north.hd },
      南向點_北上不匹配: LP.dirMatch(south, 0) === false,
      南向點_南下匹配: LP.dirMatch(south, 180) === true,
      北向點_北上匹配: north ? LP.dirMatch(north, 0) === true : null,
      南下時警示數: southbound.length, 南下第一句: southbound[0],
      北上時警示數: northbound.length, 北上第一句: northbound[0],
    };
  });

  R.errors = errs;
  console.log(JSON.stringify(R,null,2));
  await browser.close();
})();
