/* 鹿豹 Service Worker — 由 scripts/build-pages.mjs 產生，不要手改 */
const VER = 'e35c0ed1b7f4';
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
