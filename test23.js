/* test23 — App 內「檢查更新」

   使用者回饋：每次更新都要自己上 GitHub 找 APK、下載、安裝，太麻煩。
   現在：
     · App（APK）：開啟時問 GitHub Releases，有新版就在上方出現提示，點一下開始下載
     · 網頁版：比對網站上的建置序號，有新版點一下就清快取重新載入
   全部用 page.route 模擬，不真的連 GitHub。
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HTML = fs.readFileSync(path.join(__dirname, 'luleopard.html'), 'utf8');
const LEAFLET = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
const APP_VER = HTML.match(/const APP_VER='([^']*)'/)[1];

async function openApp(browser, { native, releaseTag, siteBuild }) {
  const page = await (await browser.newContext({ locale: 'zh-TW' })).newPage();
  const errs = [], hits = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  const SITE = 'https://winnerich168.github.io/luleopard/';
  await page.route('**/*', r => {
    const u = r.request().url();
    if (/leaflet.*\.js/.test(u)) return r.fulfill({ contentType: 'text/javascript', body: LEAFLET });
    if (/leaflet.*\.css/.test(u)) return r.fulfill({ contentType: 'text/css', body: '' });
    if (u.startsWith('https://api.github.com/repos/winnerich168/luleopard/releases/latest')) {
      hits.push('api');
      return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ tag_name: releaseTag, assets: [
          { name: 'app-release.aab', browser_download_url: 'https://github.com/x/app-release.aab' },
          { name: 'app-release.apk', browser_download_url: 'https://github.com/winnerich168/luleopard/releases/download/' + releaseTag + '/app-release.apk' }] }) });
    }
    if (u.includes('app-release.apk')) { hits.push('apk:' + u); return r.fulfill({ status: 200, body: 'APK' }); }
    if (u.startsWith(SITE)) {
      const q = new URL(u).searchParams.has('fresh');
      if (q) hits.push('fresh');
      else hits.push('page');
      // ?fresh 的請求回「網站上的最新版」；一般載入回目前版本
      const body = q && siteBuild ? HTML.replace(/const APP_BUILD='[^']*'/, `const APP_BUILD='${siteBuild}'`)
                                    .replace(/const APP_VER='[^']*'/, `const APP_VER='v9.9.9'`) : HTML;
      return r.fulfill({ contentType: 'text/html', body });
    }
    if (u.startsWith('file:')) return r.continue();
    return r.abort();
  });
  await page.addInitScript(native => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: () => {}, cancel: () => {}, getVoices: () => [], onvoiceschanged: null }, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    navigator.vibrate = () => true;
    if (native) window.Capacitor = { isNativePlatform: () => true, getPlatform: () => (native === 'ios' ? 'ios' : 'android'), Plugins: {} };
  }, native);
  await page.goto(native ? 'file://' + path.join(__dirname, 'luleopard.html') : 'https://winnerich168.github.io/luleopard/');
  await page.waitForTimeout(800);
  await page.click('#btnStart');                   // 起始畫面蓋在上面，按下開始後才看得到提示
  await page.waitForTimeout(5700);                 // 開啟 5 秒後自動檢查
  const bar = await page.evaluate(() => ({
    visible: !document.getElementById('updBar').classList.contains('hidden'),
    text: document.getElementById('updTx').textContent }));
  return { page, errs, hits, bar };
}

(async () => {
  const browser = await chromium.launch();
  const R = {};

  R.版號比較 = await (async () => {
    const { page } = await openApp(browser, { native: true, releaseTag: APP_VER });
    const r = await page.evaluate(() => [LP.verNewer('v1.9.10', 'v1.9.2'), LP.verNewer('v1.10.0', 'v1.9.9'),
      LP.verNewer('v1.9.2', 'v1.9.2'), LP.verNewer('v1.9.1', 'v1.9.2'), LP.verNewer('v2.0', 'v1.9.9')]);
    await page.context().close(); return r;
  })();

  /* 1. APK：GitHub 上有新版 */
  {
    const { page, errs, hits, bar } = await openApp(browser, { native: true, releaseTag: 'v9.9.9' });
    R.APK有新版 = { bar, 問了GitHub: hits.includes('api') };
    await page.click('#updTx');
    await page.waitForTimeout(800);
    R.APK有新版.下載 = hits.filter(h => h.startsWith('apk:'));
    R.APK有新版.errors = errs;
    await page.context().close();
  }
  /* 2. APK：已經是最新版 */
  {
    const { page, bar } = await openApp(browser, { native: true, releaseTag: APP_VER });
    R.APK已最新 = { bar };
    await page.evaluate(() => document.getElementById('btnUpdCheck').click());   // 設定頁沒開，直接觸發
    await page.waitForTimeout(500);
    R.APK已最新.手動檢查 = await page.evaluate(() => document.getElementById('updStat').textContent);
    await page.context().close();
  }
  /* 3. 網頁版：網站上有更新的建置 */
  {
    const { page, errs, hits, bar } = await openApp(browser, { native: false, siteBuild: '29991231.2359' });
    R.網頁有新版 = { bar, 用fresh問網站: hits.includes('fresh'), 沒問GitHub: !hits.includes('api') };
    const before = hits.filter(h => h === 'page').length;
    await page.click('#updTx');
    await page.waitForTimeout(1500);
    R.網頁有新版.重新載入 = hits.filter(h => h === 'page').length > before;
    R.網頁有新版.errors = errs;
    await page.context().close();
  }
  /* 4. 網頁版：已是最新；按 ✕ 可以關掉提示 */
  {
    const { page, bar } = await openApp(browser, { native: false, siteBuild: null });
    R.網頁已最新 = { bar };
    await page.context().close();
  }
  {
    const { page } = await openApp(browser, { native: true, releaseTag: 'v9.9.9' });
    await page.click('#updClose');
    R.按叉關掉 = await page.evaluate(() => document.getElementById('updBar').classList.contains('hidden'));
    await page.context().close();
  }

  /* 5. iPhone 版（原生、非 Android）：不要叫它下載 APK */
  {
    const { page, hits, bar } = await openApp(browser, { native: 'ios', releaseTag: 'v9.9.9' });
    await page.evaluate(() => document.getElementById('btnUpdCheck').click());
    await page.waitForTimeout(300);
    R.iPhone = { bar, 問了GitHub: hits.includes('api'),
      說明: await page.evaluate(() => document.getElementById('updStat').textContent) };
    await page.context().close();
  }

  console.log(JSON.stringify(R, null, 2));
  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  ok('版號比較（1.9.10 > 1.9.2 等）', JSON.stringify(R.版號比較) === JSON.stringify([true, true, false, false, true]));
  ok('APK：有新版時上方出現提示', R.APK有新版.bar.visible && /v9\.9\.9/.test(R.APK有新版.bar.text) && /下載/.test(R.APK有新版.bar.text));
  ok('APK：點提示就開始下載 APK（不是 AAB）', R.APK有新版.下載.length === 1 && /v9\.9\.9\/app-release\.apk$/.test(R.APK有新版.下載[0]));
  ok('APK：已是最新版時不提示', !R.APK已最新.bar.visible);
  ok('APK：手動檢查說明已是最新', /已經是最新版/.test(R.APK已最新.手動檢查));
  ok('網頁：有新版時提示', R.網頁有新版.bar.visible && /立即更新/.test(R.網頁有新版.bar.text));
  ok('網頁：用 ?fresh 繞過快取問網站，不問 GitHub', R.網頁有新版.用fresh問網站 && R.網頁有新版.沒問GitHub);
  ok('網頁：點一下就重新載入', R.網頁有新版.重新載入);
  ok('網頁：已是最新版時不提示', !R.網頁已最新.bar.visible);
  ok('按 ✕ 可以關掉提示', R.按叉關掉);
  ok('iPhone 版不提示下載 APK、也不問 GitHub', !R.iPhone.bar.visible && !R.iPhone.問了GitHub && /Xcode/.test(R.iPhone.說明));
  ok('沒有頁面錯誤', R.APK有新版.errors.length === 0 && R.網頁有新版.errors.length === 0);

  await browser.close();
  if (fails.length) { console.log('✗ 失敗：\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('✓ test23 全部通過');
})();
