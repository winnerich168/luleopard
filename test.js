const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:414,height:896}, locale:'zh-TW' });
  const page = await ctx.newPage();
  const errs = [], logs = [];
  page.on('console', m => { if (m.type()==='error') errs.push(m.text()); else logs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: '+e.message));

  await page.goto('file://'+path.join(__dirname,'luleopard.html'));
  await page.waitForTimeout(1200);

  const R = {};

  // ---- 1. 基本載入 ----
  R.booted = await page.evaluate(()=> typeof window.LP === 'object');
  R.camCount = await page.evaluate(()=> LP.CAMS().length);
  R.secCount = await page.evaluate(()=> LP.CAMS().filter(c=>c.sec).length);
  R.radarFallback = await page.evaluate(()=> !document.getElementById('radarWrap').classList.contains('hidden'));

  // ---- 2. 幾何 ----
  R.geo = await page.evaluate(()=>{
    const d = LP.dist(24.7,121.7,24.71,121.7);           // 約 1112 m
    const b1 = LP.bearing(24.70,121.70,24.71,121.70);    // 正北 0
    const b2 = LP.bearing(24.70,121.70,24.70,121.71);    // 正東 90
    return {d:Math.round(d), b1:Math.round(b1), b2:Math.round(b2)};
  });

  // ---- 3. 方向字串解析 ----
  R.dirs = await page.evaluate(()=> ({
    '南北雙向': LP.dirHeadings('南北雙向'),
    '東西雙向': LP.dirHeadings('東西雙向'),
    '北上方向': LP.dirHeadings('北上方向'),
    '南下方向': LP.dirHeadings('南下方向'),
    '北往南':   LP.dirHeadings('北往南'),
    '南往北':   LP.dirHeadings('南往北'),
    '東往西':   LP.dirHeadings('東往西'),
    '西往東':   LP.dirHeadings('西往東'),
    '空字串':   LP.dirHeadings(''),
  }));

  // ---- 4. 警示分級距離（時速換算） ----
  R.tiers = await page.evaluate(()=>{
    const v90 = 90/3.6;   // 25 m/s
    return { t1_static: LP.tierDist(1,0), t1_at90: Math.round(LP.tierDist(1,v90)),
             t2_at90: Math.round(LP.tierDist(2,v90)), t3_at90: Math.round(LP.tierDist(3,v90)) };
  });

  // ---- 5. 模擬接近：從測速點正南方 1500m 一路往北開 ----
  R.approach = await page.evaluate(()=>{
    // 挑一個「南北雙向」的點
    const cam = LP.CAMS().find(c=>c.dir.indexOf('南北雙向')>=0 && !c.sec);
    const spoken = [];
    const orig = window.speechSynthesis;
    // 攔截語音
    window.speechSynthesis = { speak:u=>spoken.push(u.text), cancel:()=>{}, getVoices:()=>[] };
    const log = [];
    for (let d=1500; d>=0; d-=50) {
      // 從正南方 d 公尺處，航向正北(0)
      const lat = cam.lat - d/111320;
      LP.onPos(lat, cam.lon, 0, 90/3.6, 8, true);
      const box = document.getElementById('alertBox').className;
      log.push({d, tier: box, label: document.getElementById('alertLabel').textContent,
                shown: document.getElementById('alertDist').textContent});
    }
    window.speechSynthesis = orig;
    return {cam:{name:cam.name,lim:cam.lim,dir:cam.dir}, spoken,
            firstT1: log.find(x=>x.tier==='t1'), firstT2: log.find(x=>x.tier==='t2'),
            firstT3: log.find(x=>x.tier==='t3'), last: log[log.length-1]};
  });

  // ---- 6. 方向過濾：同一個點，朝反方向(東)行駛應不觸發 ----
  R.wrongWay = await page.evaluate(()=>{
    const cam = LP.CAMS().find(c=>c.dir==='北上方向');
    if(!cam) return 'no 北上方向 sample';
    LP.state.clear();
    // 位於南方 300m，但航向 90(往東) → 方向不符，應無警示
    LP.onPos(cam.lat - 300/111320, cam.lon, 90, 25, 8, true);
    const a = document.getElementById('alertBox').className;
    const label = document.getElementById('alertLabel').textContent;
    // 同位置改成航向 0 (北上) → 應觸發
    LP.state.clear();
    LP.onPos(cam.lat - 300/111320, cam.lon, 0, 25, 8, true);
    const b = document.getElementById('alertBox').className;
    return {cam:cam.dir, eastbound:{cls:a,label}, northbound:{cls:b,label:document.getElementById('alertLabel').textContent}};
  });

  // ---- 7. 背後的點不該報 ----
  R.behind = await page.evaluate(()=>{
    const cam = LP.CAMS().find(c=>c.dir.indexOf('南北雙向')>=0);
    LP.state.clear();
    // 已經開過了：位於測速點北方 200m，仍朝北 → 點在正後方
    LP.onPos(cam.lat + 200/111320, cam.lon, 0, 25, 8, true);
    return {cls:document.getElementById('alertBox').className,
            label:document.getElementById('alertLabel').textContent};
  });

  // ---- 8. CSV 匯入（政府開放資料原始格式，含中文說明列） ----
  R.csvImport = await page.evaluate(()=>{
    const csv = ['CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit',
      '設置縣市,設置市區鄉鎮,設置地址,管轄警局,管轄分局,經度,緯度,拍攝方向,速限',
      '測試縣,測試鄉,測試路一段,測試警局,測試分局,121.5,25.03,南北雙向,50',
      '測試縣,測試鄉,測試路二段,測試警局,測試分局,121.51,25.04,東西雙向,60',
      '壞資料,x,y,z,w,not-a-number,also-bad,南北雙向,50',
      '境外,x,y,z,w,-73.9,40.7,南北雙向,50'].join('\n');
    LP.ingest(csv,'unit-test');
    return {count: LP.CAMS().length, names: LP.CAMS().map(c=>c.name)};
  });

  // ---- 9. Big5 / GeoJSON 路徑 ----
  R.geojsonImport = await page.evaluate(()=>{
    const gj = {type:'FeatureCollection',features:[
      {type:'Feature',geometry:{type:'Point',coordinates:[121.55,25.05]},properties:{name:'GJ測試',速限:40,方向:'東西雙向'}}]};
    LP.ingest(JSON.stringify(gj),'gj');
    return {count: LP.CAMS().length, first: LP.CAMS()[0]};
  });

  // ---- 10. 還原＋UI 互動 ----
  await page.evaluate(()=>{ document.getElementById('btnClearImported').click(); });
  R.afterClear = await page.evaluate(()=> LP.CAMS().length);

  await page.click('#btnSkip');
  for (const t of ['traffic','report','data','set']) {
    await page.click(`#tabs button[data-v="${t}"]`);
    await page.waitForTimeout(120);
  }
  R.tabsOk = await page.evaluate(()=> document.getElementById('v-set').classList.contains('active'));

  // 手動播報
  await page.click('#tabs button[data-v="traffic"]');
  await page.fill('#bcInput','國道5號南下雪隧事故車多');
  await page.click('#btnAddBroadcast');
  R.broadcast = await page.textContent('#trafficCount');

  // 回報
  await page.evaluate(()=>{ LP.onPos(24.75,121.75,0,10,8,true); });
  await page.click('#tabs button[data-v="report"]');
  await page.fill('#repNote','單元測試點');
  await page.click('#btnReport');
  R.reportCount = await page.textContent('#repCount');
  R.dbAfterReport = await page.evaluate(()=> LP.CAMS().length);

  await page.screenshot({path:'shot-map.png'});
  await page.click('#tabs button[data-v="set"]');
  await page.screenshot({path:'shot-set.png'});

  R.consoleErrors = errs;
  console.log(JSON.stringify(R,null,2));
  await browser.close();
})();
