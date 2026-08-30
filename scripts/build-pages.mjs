/**
 * 把單檔的 luleopard.html 準備成可以直接發佈到 GitHub Pages 的 docs/。
 *
 *   node scripts/build-pages.mjs
 *
 * 做四件事：
 *   1. luleopard.html → docs/index.html，並在 <head> 補上 manifest / 圖示 / theme-color
 *   2. 產生 docs/manifest.webmanifest（真的檔案，比執行期動態注入可靠）
 *   3. 產生 docs/sw.js —— Service Worker，讓 App 離線也能開（隧道、山區沒訊號時很重要）
 *   4. 複製圖示、寫入 .nojekyll
 *
 * 刻意不做的事：不打包、不壓縮、不動 docs/data/（那是 ETL 產出的，另一條流程管）。
 * 「單一 HTML 檔」是這個專案的核心特性，不要為了幾 KB 破壞它。
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = join(root, 'luleopard.html');
const outDir = join(root, 'docs');
const assetDir = join(root, 'assets');

if (!existsSync(src)) {
  console.error('✗ 找不到 ' + src);
  process.exit(1);
}

let html = readFileSync(src, 'utf8');

/* ---------- 0. 蓋上建置序號 ---------- */
// 公測期間版號跳得快，語意化版號分不出「今天早上那版」和「剛剛推的那版」。
// 用台灣時間的 YYYYMMDD.HHmm 當序號，使用者回報問題時報這串就知道是哪次建置。
const tw = new Date(Date.now() + 8 * 3600e3);          // UTC+8
const p2 = n => String(n).padStart(2, '0');
const BUILD = `${tw.getUTCFullYear()}${p2(tw.getUTCMonth() + 1)}${p2(tw.getUTCDate())}`
            + `.${p2(tw.getUTCHours())}${p2(tw.getUTCMinutes())}`;
const before = html;
html = html.replace(/const APP_BUILD='[^']*';/, `const APP_BUILD='${BUILD}';`);
if (html === before) {
  console.error('✗ 找不到 APP_BUILD 這一行 —— 建置序號沒有蓋上去');
  process.exit(1);
}

/* ---------- 1. <head> 補件 ---------- */
// 用專屬的標記字串判斷有沒有注入過，不要用 'manifest.webmanifest' 這種
// 「內容裡也可能出現」的字 —— 原始檔的註解提到它一次，整段就會被跳過，
// 而且症狀是「圖示莫名其妙不見」，很難查。這個坑我已經踩過一次了。
const HEAD_MARK = '<!-- luleopard:pages-head -->';
const HEAD = `
  ${HEAD_MARK}
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="favicon.png" sizes="64x64">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="鹿豹">
  <meta name="description" content="台灣道路測速照相預報 · 區間測速 · 掉落物與路況回報。免安裝，加到主畫面即可使用。">
`;
if (!html.includes(HEAD_MARK)) {
  if (!html.includes('</head>')) { console.error('✗ 原始檔找不到 </head>'); process.exit(1); }
  html = html.replace('</head>', HEAD + '</head>');
}

/* ---------- 2. Service Worker 註冊 ---------- */
// 只在 https / localhost 註冊。用 file:// 直接開、或包成 App 時都不會跑到這裡。
const SW_MARK = '<!-- luleopard:pages-sw -->';
const SW = `
${SW_MARK}
<script>
// Service Worker：讓 App 離線可開。隧道與山區沒訊號時，這是唯一還能運作的部分。
// 註冊失敗完全不影響功能，所以整段包在 try 裡且不提示使用者。
// localhost / 127.0.0.1 也算安全來源，本機測試才驗得到離線行為。
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
</script>
`;
if (!html.includes(SW_MARK)) {
  if (!html.includes('</body>')) { console.error('✗ 原始檔找不到 </body>'); process.exit(1); }
  html = html.replace('</body>', SW + '</body>');
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html, 'utf8');

/* ---------- 3. manifest ---------- */
const manifest = {
  name: '鹿豹 · 台灣道路測速預報',
  short_name: '鹿豹',
  description: '測速照相與區間測速預報，結合掉落物與路況回報。',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0b0f14',
  theme_color: '#0b0f14',
  lang: 'zh-TW',
  categories: ['navigation', 'travel'],
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};
writeFileSync(join(outDir, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2), 'utf8');

/* ---------- 4. 圖示與 .nojekyll ---------- */
// .nojekyll：不放這個檔，GitHub Pages 會用 Jekyll 處理，底線開頭的檔案會被吃掉。
writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');
let copied = 0;
if (existsSync(assetDir)) {
  for (const f of readdirSync(assetDir)) {
    if (/\.(png|svg|ico|webp)$/i.test(f)) { copyFileSync(join(assetDir, f), join(outDir, f)); copied++; }
  }
}

/* ---------- 5. Service Worker 本體 ---------- */
// 版本號用 index.html 的雜湊。內容一變版本就變，舊快取自動清掉 ——
// 不然使用者會卡在舊版而且完全不知道為什麼。
const ver = createHash('sha256').update(html).digest('hex').slice(0, 12);
const sw = `/* 鹿豹 Service Worker — 由 scripts/build-pages.mjs 產生，不要手改 */
const VER = '${ver}';
const CACHE = 'luleopard-' + VER;

// App 本體：一定要快取，離線就靠這些
const CORE = ['./', './index.html', './manifest.webmanifest',
              './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon.png'];

self.addEventListener('install', e => {
  // addAll 只要有一個檔案失敗就整批失敗，所以逐一放進去、失敗的略過
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(CORE.map(u => c.add(u).catch(() => {})))
  ).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 地圖圖磚、TDX、自己的後端一律不碰 —— 快取路況資料是危險的，
  // 使用者會看到早就不存在的事故。同源以外的東西直接放行。
  if (url.origin !== location.origin) return;

  // 測速點資料（data/）：網路優先，成功就順便更新快取；離線時退回上一次成功的版本。
  // 這樣既拿得到最新資料，沒訊號時也不會整個空掉。
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App 本體：快取優先（開起來最快），背景再更新
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if (r && r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
`;
writeFileSync(join(outDir, 'sw.js'), sw, 'utf8');

/* ---------- 6. 自我驗證 ----------
   驗證寫在這裡而不是 CI 的 shell 腳本裡，因為這支腳本本機每次都會跑，
   壞掉當下就會被發現。之前把檢查寫在 workflow 的 shell 裡，用 [ -s ]
   （非空）去檢查 .nojekyll —— 但那是個標記檔，本來就是 0 bytes，
   於是「防止發佈壞東西」的那道檢查自己把每次發佈都擋掉了。 */
const problems = [];
const need = (rel, minBytes) => {
  const f = join(outDir, rel);
  if (!existsSync(f)) { problems.push(`缺少 ${rel}`); return; }
  const n = statSync(f).size;
  if (n < minBytes) problems.push(`${rel} 只有 ${n} bytes（至少要 ${minBytes}）`);
};
need('index.html', 100000);       // 內建 315 點的種子資料就佔掉大半，太小代表複製出錯
need('manifest.webmanifest', 100);
need('sw.js', 300);
need('icon-192.png', 1000);
need('apple-touch-icon.png', 1000);
// .nojekyll 是標記檔，0 bytes 是正確的 —— 只檢查存在
if (!existsSync(join(outDir, '.nojekyll'))) problems.push('缺少 .nojekyll');
/* docs/ 是持久目錄而且有進版控，只檢查「檔案存在」會被上一次的產出遮住：
   assets/ 整個不見了，這次一個圖示都沒複製到，檢查卻因為舊檔還在而通過。
   所以也要檢查「這一次真的複製了東西」。 */
if (copied === 0) problems.push('這次一個圖示都沒複製到（assets/ 是不是不見了？）');
// index.html 必須真的帶著建置序號與 App 本體
const outHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
if (!outHtml.includes(`const APP_BUILD='${BUILD}'`)) problems.push('index.html 沒有帶上建置序號');
if (!outHtml.includes('manifest.webmanifest')) problems.push('index.html 沒有 manifest 連結');
if (!/const SEED=/.test(outHtml)) problems.push('index.html 找不到內建點位資料');

if (problems.length) {
  console.error('✗ 產出不完整，不應該發佈：');
  for (const p of problems) console.error('   · ' + p);
  process.exit(1);
}

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`✓ docs/index.html（${kb} KB）· 建置序號 ${BUILD}`);
console.log(`✓ 產出檢查通過（${6} 項）`);
console.log(`✓ docs/manifest.webmanifest`);
console.log(`✓ docs/sw.js（版本 ${ver}）`);
console.log(`✓ 圖示 ${copied} 個、.nojekyll`);
if (!existsSync(join(outDir, 'data'))) {
  console.log('ℹ docs/data/ 還不存在 —— 跑 etl/build_speedcams.py --out docs/data 產生，');
  console.log('  或直接推上 GitHub 讓 Actions 自動產生。App 沒有它也能用（有內建 315 點）。');
}
