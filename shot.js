const { chromium } = require('playwright');
const path=require('path');
(async()=>{
  const b=await chromium.launch();
  const p=await (await b.newContext({viewport:{width:414,height:820},locale:'zh-TW',deviceScaleFactor:2})).newPage();
  await p.addInitScript(()=>{ Object.defineProperty(window,'speechSynthesis',{value:{speak:()=>{},cancel:()=>{},getVoices:()=>[],set onvoiceschanged(v){},get onvoiceschanged(){return null}},configurable:true});
    window.SpeechSynthesisUtterance=function(t){this.text=t;}; });
  await p.goto('file://'+path.join(__dirname,'luleopard.html'));
  await p.waitForTimeout(700);
  await p.click('#btnStart'); await p.waitForTimeout(300);
  await p.evaluate(()=>{ const c=LP.CAMS().find(x=>x.dir.indexOf('南北雙向')>=0&&x.lim>0);
    LP.state.clear(); LP.onPos(c.lat-260/111320,c.lon,0,95/3.6,7,true); });
  await p.waitForTimeout(400);
  await p.screenshot({path:'preview-hud.png'});
  await b.close();
})();
