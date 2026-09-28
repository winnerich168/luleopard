/**
 * 把 `npx cap add ios` 產生的預設專案，補成「背景定位與背景語音真的會動」的版本。
 *
 *   node scripts/patch-ios.mjs
 *
 * 跟 patch-android.mjs 同一個理由：CI 每次都重新產生 ios/，手動改的會被蓋掉；
 * 而漏掉任何一項的症狀都是「開著螢幕測都正常，一鎖屏就沒聲音」—— 最難發現。
 *
 * 冪等：跑幾次結果都一樣。缺任何必要設定就 exit 1，讓 CI 直接失敗而不是出貨。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const plistPath = join(root, 'ios/App/App/Info.plist');

if (!existsSync(plistPath)) {
  console.error('✗ 找不到 ' + plistPath + '。請先執行： npx cap add ios');
  process.exit(1);
}

let p = readFileSync(plistPath, 'utf8');
let changed = 0;
const note = m => { console.log('  + ' + m); changed++; };

/** 設定（或覆寫）一個字串鍵 */
function setString(key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(p)) {
    const next = p.replace(re, `$1${value}$2`);
    if (next !== p) { p = next; note(key); }
  } else {
    p = p.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>\n`);
    note(key);
  }
}
function setBool(key, value) {
  const re = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`);
  if (re.test(p)) p = p.replace(re, `<key>${key}</key>\n\t<${value}/>`);
  else { p = p.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<${value}/>\n</dict>\n</plist>\n`); note(key); }
}

/* ── 定位用途說明 ──
   Apple 審查會看這幾句。要具體說「為什麼背景也要」，只寫「需要定位」過審率很低。 */
setString('NSLocationWhenInUseUsageDescription',
  '鹿豹需要你的位置，才能在接近測速照相、前方事故或掉落物時語音提醒你。');
setString('NSLocationAlwaysAndWhenInUseUsageDescription',
  '鹿豹需要在背景取得位置，才能在你關閉螢幕或使用其他 App（例如導航）時，仍持續語音提醒前方的測速照相與路況。');
setString('NSLocationAlwaysUsageDescription',
  '鹿豹需要在背景取得位置，才能在你關閉螢幕或使用其他 App（例如導航）時，仍持續語音提醒前方的測速照相與路況。');

/* ── 背景模式 ──
   location：背景持續收定位
   audio：   背景發出語音。沒有它，背景定位會動但一句話都唸不出來 —— 等於白做。 */
const MODES = ['location', 'audio'];
const bgRe = /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/;
if (bgRe.test(p)) {
  const cur = p.match(bgRe)[1];
  const add = MODES.filter(m => !cur.includes(`<string>${m}</string>`));
  if (add.length) {
    p = p.replace(bgRe, (all, inner) =>
      `<key>UIBackgroundModes</key>\n\t<array>${inner}${add.map(m => `\t<string>${m}</string>\n\t`).join('')}</array>`);
    note('UIBackgroundModes += ' + add.join(', '));
  }
} else {
  p = p.replace(/<\/dict>\s*<\/plist>\s*$/,
    `\t<key>UIBackgroundModes</key>\n\t<array>\n${MODES.map(m => `\t\t<string>${m}</string>`).join('\n')}\n\t</array>\n</dict>\n</plist>\n`);
  note('UIBackgroundModes = ' + MODES.join(', '));
}

/* ── 出口管制聲明 ──
   只用 HTTPS（系統內建加密），不需要出口文件。不設的話每次上傳 TestFlight
   都要到網頁上手動回答一次，否則那一版卡在「缺少出口合規資訊」不能測。 */
setBool('ITSAppUsesNonExemptEncryption', 'false');

/* ── 顯示名稱 ── */
setString('CFBundleDisplayName', '鹿豹');

/* ── 版本號 ──
   CFBundleShortVersionString 跟網頁版同一個版號；CFBundleVersion 用 GitHub 建置次數。
   TestFlight 要求同一個版號下，每次上傳的 CFBundleVersion 都要比上次大。 */
const rootPkg = JSON.parse(readFileSync(resolve(root, '..', 'package.json'), 'utf8'));
setString('CFBundleShortVersionString', rootPkg.version || '1.0.0');
const run = parseInt(process.env.GITHUB_RUN_NUMBER || '', 10);
if (run > 0) setString('CFBundleVersion', String(run));

writeFileSync(plistPath, p, 'utf8');

/* ── 驗證 ── */
const must = ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription',
              'ITSAppUsesNonExemptEncryption'];
const miss = must.filter(k => !p.includes(`<key>${k}</key>`));
const bg = (p.match(bgRe) || [, ''])[1];
MODES.forEach(m => { if (!bg.includes(`<string>${m}</string>`)) miss.push('UIBackgroundModes/' + m); });
if (miss.length) { console.error('✗ Info.plist 缺少：' + miss.join(', ')); process.exit(1); }

console.log(changed ? `✓ Info.plist 已補齊（${changed} 項）` : '✓ Info.plist 已經是最新');
