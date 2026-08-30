/**
 * 把 `npx cap add android` 產生的預設專案，補成「背景定位真的會動」的版本。
 *
 *   node scripts/patch-android.mjs
 *
 * 為什麼要有這支：`cap add android` 產生的是通用 scaffold，背景定位所需的權限與
 * 前景服務宣告都沒有。手動改的話，CI 每次重新產生專案就會被蓋掉，而且「忘記改」
 * 的症狀是「白天測都正常，關螢幕才沒聲音」—— 最難發現的那種。所以寫成腳本。
 *
 * 這支是冪等的：跑幾次結果都一樣，已經加過的不會重複加。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const android = join(root, 'android');

if (!existsSync(android)) {
  console.error('✗ 找不到 mobile/android/。請先執行： npx cap add android');
  process.exit(1);
}

let changed = 0;
const note = m => { console.log('  + ' + m); changed++; };

/* ═══════════ 1. AndroidManifest.xml ═══════════ */
const mfPath = join(android, 'app/src/main/AndroidManifest.xml');
let mf = readFileSync(mfPath, 'utf8');

const PERMS = [
  ['ACCESS_COARSE_LOCATION',      '粗略定位（系統要求與精確定位一起宣告）'],
  ['ACCESS_FINE_LOCATION',        '精確定位：測速點警示的距離計算靠這個'],
  ['ACCESS_BACKGROUND_LOCATION',  '背景定位：關螢幕、切到導航 App 時仍要警示'],
  ['FOREGROUND_SERVICE',          '前景服務'],
  ['FOREGROUND_SERVICE_LOCATION', 'Android 14 起，前景服務要再宣告用途'],
  ['POST_NOTIFICATIONS',          'Android 13 起，前景服務的常駐通知要這個權限'],
  ['WAKE_LOCK',                   '警示期間不讓 CPU 睡著'],
];
let addPerm = '';
for (const [p, why] of PERMS) {
  if (!mf.includes('android.permission.' + p)) {
    addPerm += `    <!-- ${why} -->\n    <uses-permission android:name="android.permission.${p}" />\n`;
  }
}
if (addPerm) { mf = mf.replace('</manifest>', addPerm + '</manifest>'); note('定位／前景服務／通知權限'); }

// 背景定位外掛的前景服務。沒有這段，App 一退到背景就被系統殺掉。
const SERVICE_CLASS = 'com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService';
if (!mf.includes(SERVICE_CLASS)) {
  mf = mf.replace('</application>',
`        <!-- 背景定位的前景服務。foregroundServiceType 一定要是 location，
             Android 14 以上少了它會直接崩潰而不是安靜失效。 -->
        <service
            android:name="${SERVICE_CLASS}"
            android:foregroundServiceType="location"
            android:enabled="true"
            android:exported="false" />
    </application>`);
  note('背景定位前景服務宣告');
}
writeFileSync(mfPath, mf, 'utf8');

/* ═══════════ 2. strings.xml：App 名稱 ═══════════ */
const strPath = join(android, 'app/src/main/res/values/strings.xml');
if (existsSync(strPath)) {
  let s = readFileSync(strPath, 'utf8');
  const before = s;
  s = s.replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1鹿豹$2')
       .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, '$1鹿豹$2');
  if (s !== before) { writeFileSync(strPath, s, 'utf8'); note('App 顯示名稱 → 鹿豹'); }
}

/* ═══════════ 3. 背景定位的常駐通知文案 ═══════════ */
// 使用者下拉通知欄會看到這行字。預設是英文的 "Location service running"，
// 看起來像系統在偷偷追蹤你 —— 講清楚在做什麼，才不會被使用者手動關掉。
const bgStrings = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="capacitor_background_geolocation_notification_title">鹿豹 · 行車警示中</string>
    <string name="capacitor_background_geolocation_notification_text">持續偵測前方測速照相與路況回報</string>
</resources>
`;
const bgPath = join(android, 'app/src/main/res/values/strings_luleopard.xml');
if (!existsSync(bgPath)) {
  mkdirSync(dirname(bgPath), { recursive: true });
  writeFileSync(bgPath, bgStrings, 'utf8');
  note('背景定位常駐通知的中文文案');
}

/* ═══════════ 4. 檢查 ═══════════ */
const missing = PERMS.map(p => p[0]).filter(p => !mf.includes('android.permission.' + p));
if (missing.length) { console.error('✗ 仍缺少權限：' + missing.join(', ')); process.exit(1); }
if (!mf.includes(SERVICE_CLASS)) { console.error('✗ 前景服務沒補進去'); process.exit(1); }

console.log(changed ? `✓ Android 專案已補完（${changed} 項）` : '✓ Android 專案已是最新，沒有需要補的');
console.log('  提醒：ACCESS_BACKGROUND_LOCATION 不能跟前景定位一起要 ——');
console.log('  系統只會問「使用時允許」，使用者必須自己到設定改成「一律允許」。');
