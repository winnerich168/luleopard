const { chromium } = require('playwright');
const { zipSync, strToU8 } = require('fflate');
const path = require('path'), fs = require('fs');

// 依「國道公路固定式測速照相地點」公告的實際欄位結構造樣本
const FREEWAY_CSV = [
 '設備編號,型式,縣市,行政區,設置區域描述,設置地點,取締項目,座標緯度,座標經度,拍攝方向,速限,管轄單位,備註',
 'N1-001,固定式,桃園市,蘆竹區,國道1號南下,國道1號南下 47.5K,超速,25.048611,121.290833,南下,100,國道公路警察局第一大隊,',
 'N1-002,固定式,臺中市,后里區,國道1號北上,國道1號北上 168.2K,超速,24.309722,120.712500,北上,100,國道公路警察局第三大隊,',
 'N3-014,固定式,新北市,土城區,國道3號南下,國道3號南下 42.1K,超速,24.972222,121.435000,南下,100,國道公路警察局第二大隊,',
 'N5-003,區間測速,宜蘭縣,頭城鎮,雪山隧道,國道5號南下 15K-28K,區間超速,24.916667,121.716667,南下,90,國道公路警察局第九大隊,雪隧區間',
 'BAD-1,固定式,測試,測試,壞資料,壞資料,超速,not-a-number,also-bad,南下,100,測試,',
 'OUT-1,固定式,境外,境外,境外,境外,超速,40.700000,-73.900000,南下,100,測試,'
].join('\n');

(async () => {
  const zipBuf = Buffer.from(zipSync({
    '1150720-國道公路固定式測速照相地點.csv': strToU8(FREEWAY_CSV),
    '__MACOSX/._junk': strToU8('junk'),
    'readme.txt': strToU8('這不是資料檔')
  }));
  fs.writeFileSync('/tmp/freeway.zip', zipBuf);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({viewport:{width:414,height:896},locale:'zh-TW'})).newPage();
  const errs=[];
  page.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  page.on('console',m=>{ if(m.type()==='error' && !/ERR_TUNNEL/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(()=>{
    Object.defineProperty(window,'speechSynthesis',{value:{speak:()=>{},cancel:()=>{},getVoices:()=>[],
      set onvoiceschanged(v){},get onvoiceschanged(){return null}},configurable:true});
    window.SpeechSynthesisUtterance=function(t){this.text=t;};
  });
  await page.goto('file://'+path.join(__dirname,'luleopard.html'));
  await page.waitForTimeout(800);

  const R={};
  R.fflateInlined = await page.evaluate(()=> typeof fflate!=='undefined' && typeof fflate.unzipSync==='function');
  R.startCams = await page.evaluate(()=> LP.CAMS().length);
  R.startPacks = await page.evaluate(()=> LP.PACKS().length);

  // ---- 1. ZIP 匯入（國道） ----
  const zipB64 = zipBuf.toString('base64');
  R.zipImport = await page.evaluate(async b64=>{
    const bin=atob(b64), u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    await LP.ingestZip(u.buffer,'國道公路固定式測速照相地點.zip');
    const fw = LP.CAMS().filter(c=>/國道/.test(c.name));
    return {total:LP.CAMS().length, packs:LP.PACKS().map(p=>({name:p.name,n:p.rows.length})),
            freeway:fw.map(c=>({name:c.name,lim:c.lim,dir:c.dir,sec:c.sec,lat:c.lat,lon:c.lon}))};
  }, zipB64);

  // ---- 2. 累加：再匯入一份縣市 CSV，兩個來源應共存 ----
  R.accumulate = await page.evaluate(()=>{
    const csv=['CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit',
      '設置縣市,設置市區鄉鎮,設置地址,管轄警局,管轄分局,經度,緯度,拍攝方向,速限',
      '苗栗縣,竹南鎮,台1線98K,苗栗縣警察局,竹南分局,120.87,24.68,南北雙向,60',
      '苗栗縣,頭份市,台13線25K,苗栗縣警察局,頭份分局,120.90,24.69,東西雙向,50'].join('\n');
    LP.ingest(csv,'苗栗縣測試');
    return {total:LP.CAMS().length, packs:LP.PACKS().map(p=>p.name)};
  });

  // ---- 3. 跨來源去重：重複匯入同一份國道資料（不同來源名稱） ----
  R.dedupe = await page.evaluate(async b64=>{
    const bin=atob(b64), u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    const before=LP.CAMS().length;
    await LP.ingestZip(u.buffer,'國道-重複匯入.zip');
    return {before, after:LP.CAMS().length, packs:LP.PACKS().length};
  }, zipB64);

  // ---- 4. 同名來源取代（更新資料，不重複堆積） ----
  R.replaceSameName = await page.evaluate(()=>{
    const before=LP.PACKS().length;
    LP.ingest(['lat,lon,limit,direct,name','24.68,120.87,60,南北雙向,更新版'].join('\n'),'苗栗縣測試');
    return {before, after:LP.PACKS().length,
            miaoli:LP.PACKS().filter(p=>p.name==='苗栗縣測試').map(p=>p.rows.length)};
  });

  // ---- 5. 移除單一來源 ----
  R.removeOne = await page.evaluate(()=>{
    const id=LP.PACKS().find(p=>/國道公路固定式/.test(p.name)).id;
    document.querySelector(`[data-rmpack="${id}"]`).click();
    return {packs:LP.PACKS().map(p=>p.name), cams:LP.CAMS().length,
            freewayLeft:LP.CAMS().filter(c=>/國道1號|國道3號/.test(c.name)).length};
  });

  // ---- 6. 全部清除 → 回到內建示範 ----
  await page.evaluate(()=>document.getElementById('btnClearImported').click());
  R.afterClear = await page.evaluate(()=> ({cams:LP.CAMS().length, packs:LP.PACKS().length}));

  // ---- 7. 國道點位的行車警示（雪隧區間測速，南下 90） ----
  R.freewayAlert = await page.evaluate(async b64=>{
    const bin=atob(b64), u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    await LP.ingestZip(u.buffer,'國道.zip');
    const cam=LP.CAMS().find(c=>c.sec);
    const spoken=[]; const orig=window.speechSynthesis.speak;
    window.speechSynthesis.speak=uu=>spoken.push(uu.text);
    let clock=0; const realNow=Date.now.bind(Date); Date.now=()=>realNow()+clock;
    LP.state.clear();
    // 從測速點北方往南開（南下），時速 110 → 超速
    for(let d=1400; d>=0; d-=50){ clock+=1600;
      LP.onPos(cam.lat + d/111320, cam.lon, 180, 110/3.6, 8, true); }
    Date.now=realNow; window.speechSynthesis.speak=orig;
    return {cam:cam.name, lim:cam.lim, dir:cam.dir, spoken};
  }, zipB64);

  // ---- 8. UI 檢查 ----
  await page.click('#btnSkip');
  await page.click('#tabs button[data-v="data"]');
  await page.waitForTimeout(200);
  R.ui = {
    dbStat: await page.textContent('#dbStat'),
    packListHasFreeway: (await page.textContent('#packList')).includes('國道'),
    srcHasFreewayGroup: (await page.textContent('#srcList')).includes('國道公路固定式測速照相地點')
  };
  await page.screenshot({path:'shot-data.png', fullPage:false});

  R.errors=errs;
  console.log(JSON.stringify(R,null,2));
  await browser.close();
})();
