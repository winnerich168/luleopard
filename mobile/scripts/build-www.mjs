/**
 * 把單檔的 luleopard.html 準備成 Capacitor 的 www/。
 *   node scripts/build-www.mjs
 *
 * 做兩件事：
 *   1. 複製 ../luleopard.html → www/index.html
 *   2. 注入 capacitor.js（原生環境才會有這支，瀏覽器開不受影響）
 *
 * 不做打包、不做壓縮 —— 這個專案刻意維持「單一 HTML 檔」的可讀性。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, '..', 'luleopard.html');
const outDir = join(root, 'www');
const out = join(outDir, 'index.html');

if (!existsSync(src)) {
  console.error('✗ 找不到 ' + src + '\n  請確認 mobile/ 與 luleopard.html 在同一層。');
  process.exit(1);
}

let html = readFileSync(src, 'utf8');

// Capacitor 的 runtime。原生環境由 native 端注入這支檔案；
// 在瀏覽器直接開時會 404，但因為程式碼都用 window.Capacitor 有無來判斷，不會壞。
const tag = '<script src="capacitor.js"></script>';
if (!html.includes(tag)) {
  html = html.replace('</head>', '  ' + tag + '\n</head>');
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`✓ www/index.html 已更新（${kb} KB）`);
console.log('  接著執行：npx cap sync');
