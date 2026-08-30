const {chromium}=require('playwright');const path=require('path');
(async()=>{
  const b=await chromium.launch();
  const p=await (await b.newContext({viewport:{width:414,height:1200},locale:'zh-TW',deviceScaleFactor:2})).newPage();
  await p.addInitScript(()=>{Object.defineProperty(window,'speechSynthesis',{value:{speak:()=>{},cancel:()=>{},getVoices:()=>[],set onvoiceschanged(v){},get onvoiceschanged(){return null}},configurable:true});
    window.SpeechSynthesisUtterance=function(t){this.text=t;};});
  await p.goto('file://'+path.join(__dirname,'luleopard.html'));
  await p.waitForTimeout(700); await p.click('#btnStart'); await p.waitForTimeout(200);
  await p.evaluate(()=>{
    LP.clearPacks();
    LP.addPack('國道',[[25.048611,121.290833,100,'南下','桃園市 蘆竹區 國道1號南下 47.5K']]);
    LP.buildKmAnchors();
    const pos={lat:25.03,lon:121.2908,heading:180,speed:100/3.6};
    LP.kmLock(49.6,'國1',pos,'南下');
    LP.onPos(pos.lat,pos.lon,180,100/3.6,6,true);
    LP.addHazard({type:'掉落物',lat:25.03-1800/111320,lon:121.2908,roadClass:'國道',road:'國1',km:51.4,lane:'外側車道',brg:180,note:'輪胎皮'});
    LP.onPos(pos.lat,pos.lon,180,100/3.6,6,true);
  });
  await p.click('#tabs button[data-v="report"]'); await p.waitForTimeout(300);
  await p.screenshot({path:'preview-report.png'});
  await b.close();
})();
