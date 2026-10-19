/* test34 — 電台按鈕：子分頁 警廣／中廣／其他；警廣在最前、分台依位置排、中廣導到官方 App */
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');

(async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, locale: 'zh-TW',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/leaflet*.js', r => r.fulfill({ contentType: 'text/javascript', body: LEAFLET }));
  await page.route('**/leaflet*.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route(/tile\.openstreetmap\.org|wmts\.nlsc\.gov\.tw/, r => r.abort());
  const open = async () => {
    await page.goto('file://' + path.join(__dirname, 'luleopard.html'));
    await page.waitForTimeout(800); await page.click('#btnStart');
  };
  await open();
  ok(await page.isVisible('#rdBtn'), '地圖上沒有電台按鈕');
  await page.click('#rdBtn');
  const tabs = await page.$$eval('#rdTabs button', b => b.map(x => x.textContent));
  ok(/警示會停止/.test(await page.textContent('#rdWebWarn')) && await page.isVisible('#rdWebWarn'), '網頁版沒顯示「警示會停止」提醒');
  ok(tabs.join() === '警廣,中廣,其他', '子分頁順序不對：' + tabs);
  ok(await page.textContent('#rdTabs button.on') === '警廣', '預設不是警廣分頁');
  let items = await page.$$eval('#rdList a', a => a.map(x => ({ t: x.querySelector('b').textContent, h: x.href, b: (x.querySelector('em') || {}).textContent || '', tg: x.target })));
  ok(items[0].t === '全國治安交通網' && /name=PBS$/.test(items[0].h), '警廣第一個不是全國網：' + JSON.stringify(items[0]));
  ok(items.length === 9 && items.every(x => /^https:\/\/www\.pbs\.gov\.tw\/live\/index\.html\?name=[A-Z]{3}$/.test(x.h)), '警廣連結不對');
  ok(items.every(x => x.tg === '_blank'), '電台連結要另開');
  ok(!items.some(x => x.b), '沒定位時不該標最近');

  // 在高雄：高雄分臺排第一並標「最近」
  await page.click('#rdX');
  await page.evaluate(() => LP.onPos(22.62, 120.31, 0, 0, 10, false));
  await page.click('#rdBtn');
  items = await page.$$eval('#rdList a', a => a.map(x => ({ t: x.querySelector('b').textContent, b: (x.querySelector('em') || {}).textContent || '' })));
  ok(items[1].t === '警廣 高雄分臺' && items[1].b === '最近', '在高雄時最近的不是高雄分臺：' + JSON.stringify(items.slice(0, 3)));
  ok(items.filter(x => x.b).length === 1, '「最近」只能標一個');

  // 中廣：Android 只給 Google Play
  await page.click('#rdTabs button[data-t="bcc"]');
  const bcc = await page.$$eval('#rdList a', a => a.map(x => x.href));
  ok(bcc.length === 1 && /play\.google\.com.*bcc_player/.test(bcc[0]), '中廣在 Android 應導到 Google Play：' + bcc);
  ok(/中廣新聞網/.test(await page.textContent('#rdList')), '中廣分頁沒列出頻道');
  await page.screenshot({ path: path.join(__dirname, 'shot-radio-bcc.png') });

  await page.click('#rdTabs button[data-t="more"]');
  const more = await page.$$eval('#rdList a b', b => b.map(x => x.textContent));
  ok(more.length === 5 && /教育/.test(more[0]), '其他分頁不對：' + more);

  // 記住上次的分頁
  await open();
  await page.click('#rdBtn');
  ok(await page.textContent('#rdTabs button.on') === '其他', '重開後沒記住分頁');
  await page.click('#rdTabs button[data-t="pbs"]');
  await page.screenshot({ path: path.join(__dirname, 'shot-radio.png') });
  // 點了電台面板自己關掉（攔下另開的頁面）
  ctx.on('page', p => p.close().catch(() => {}));
  await page.click('#rdList a >> nth=0'); await page.waitForTimeout(500);
  ok(await page.isHidden('#rdSheet'), '點了電台後面板沒關');

  fails.push(...errs);
  await browser.close();
  console.log(fails.length ? '✗ ' + fails.join('\n✗ ') : '✓ test34 電台');
  process.exit(fails.length ? 1 : 0);
})();
