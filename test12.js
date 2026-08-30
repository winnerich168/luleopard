/* 縣市覆蓋透明化
   實地回報：「縣道也有的固定照相點都沒有顯示」。
   真相是內建資料只涵蓋宜蘭+新竹，但畫面只寫「315 點」，看不出涵蓋範圍。
   這支測試確保 App 會誠實列出哪些縣市有資料、哪些完全沒有。
*/
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [],
               set onvoiceschanged(v) {}, get onvoiceschanged() { return null } }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  });
  await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
  await page.waitForTimeout(900);
  await page.click('#btnStart');
  await page.waitForTimeout(200);

  const R = {};

  R.內建覆蓋 = await page.evaluate(() => LP.coverage());

  R.縣市判斷 = await page.evaluate(() => ({
    '宜蘭縣南澳鄉 台9線139k': LP.countyOf('宜蘭縣南澳鄉 台9線139k+667m谷風隧道北上'),
    '台南市（台不是臺）': LP.countyOf('台南市安南區公學路'),
    '臺中市': LP.countyOf('臺中市西屯區台灣大道'),
    '國道無縣市': LP.countyOf('國道三號北向423.2公里'),
    '高雄鳳山': LP.countyOf('高雄市鳳山區建國路三段'),
    '沒有縣市字樣': LP.countyOf('某某路口'),
  }));

  // 匯入一批台南的點之後，覆蓋清單要立刻反映
  R.匯入後 = await page.evaluate(() => {
    const csv = ['Latitude,Longitude,limit,direct,Address',
                 '23.0010,120.2010,50,南北雙向,臺南市東區林森路一段',
                 '23.0020,120.2020,40,東西雙向,臺南市中西區民生路二段',
                 '22.9990,120.1990,60,南下,臺南市南區健康路一段'].join('\n');
    LP.addPack('測試·臺南', LP.textToCams(csv));
    const cov = LP.coverage();
    return { 臺南點數: cov.by['臺南市'] || 0, 缺的數量: cov.缺.length,
             臺南還在缺嗎: cov.缺.includes('臺南市'),
             // 匯入單一縣市不該讓內建的國道與宜蘭/新竹點位消失
             國道還在: cov.國道, 宜蘭還在: cov.by['宜蘭縣'] || 0 };
  });

  await page.click('#tabs button[data-v="data"]');
  await page.waitForTimeout(300);
  R.畫面 = await page.evaluate(() => {
    const box = document.getElementById('covList');
    const packs = document.getElementById('packList');
    return { 內建那一列: /內建資料/.test(packs.innerHTML),
             有關閉鈕: !!packs.querySelector('[data-seedtoggle]'),
             有內容: box.innerHTML.length > 50,
             列出的縣市: [...box.querySelectorAll('.covok')].map(e => e.textContent.trim()),
             有缺漏警示: !!box.querySelector('.covmiss'),
             缺漏文字: (box.querySelector('.covmiss') || {}).textContent || '' };
  });

  R.errors = errs;
  console.log(JSON.stringify(R, null, 2));

  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('內建只涵蓋宜蘭與新竹縣', ['宜蘭縣', '新竹縣'].every(c => R.內建覆蓋.by[c] > 0));
  ok('六都全部都在「完全沒有點位」清單裡',
     ['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市'].every(c => R.內建覆蓋.缺.includes(c)));
  ok('國道另外計數且數量正確', R.內建覆蓋.國道 > 150);
  ok('「台南市」也認得（台/臺互通）', R.縣市判斷['台南市（台不是臺）'] === '臺南市');
  ok('國道點位不會被誤判成某縣市', R.縣市判斷['國道無縣市'] === null);
  ok('沒有縣市字樣就回傳 null', R.縣市判斷['沒有縣市字樣'] === null);
  ok('匯入臺南後立刻算進覆蓋', R.匯入後.臺南點數 === 3);
  ok('匯入後臺南不再列為缺漏', R.匯入後.臺南還在缺嗎 === false);
  ok('匯入單一縣市後國道點位仍在（不會被靜默停用）', R.匯入後.國道還在 > 150);
  ok('匯入單一縣市後宜蘭點位仍在', R.匯入後.宜蘭還在 > 50);
  ok('資料頁有列出有資料的縣市', R.畫面.列出的縣市.length >= 3);
  ok('來源清單有「內建資料」一列', R.畫面.內建那一列);
  ok('內建資料可以自己關掉', R.畫面.有關閉鈕);
  ok('資料頁有紅色缺漏警示', R.畫面.有缺漏警示);
  ok('缺漏警示明講「完全沒有點位」', /完全沒有點位/.test(R.畫面.缺漏文字));
  ok('沒有 JS 錯誤', errs.length === 0);

  console.log(fails.length ? '✗ 失敗：\n  ' + fails.join('\n  ') : '✓ test12（縣市覆蓋）全部通過');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
