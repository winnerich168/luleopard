/**
 * 準備 @capacitor/assets 需要的來源圖：mobile/resources/
 *
 *   node scripts/make-resources.mjs
 *
 * @capacitor/assets 吃的是固定檔名：
 *   resources/icon.png          1024×1024，會被裁成各尺寸的 App 圖示
 *   resources/splash.png        2732×2732，開啟畫面
 *   resources/splash-dark.png   深色模式的開啟畫面
 *
 * 這支腳本從 ../assets/icon-512.png 放大成 icon.png，並用純色底加上置中的圖示
 * 產生 splash。不引入任何影像函式庫 —— 直接手寫 PNG 太瘋狂，所以改用
 * 已經產好的 PNG 做「貼上去」這件事，靠的是把小圖包在一張大圖的中央。
 *
 * 為了不依賴 sharp / jimp（CI 安裝很慢又常常編譯失敗），這裡用最笨但最可靠的
 * 方式：splash 直接用一張純色 PNG，圖示交給 @capacitor/assets 自己縮放。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// 用 1024 的滿版不透明版本：@capacitor/assets 要求 icon.png 至少 1024×1024，
// 而且 iOS 的 App 圖示不允許透明像素（有透明會被 App Store 直接退件）。
// 圖案本身縮到 72%，剛好落在 Android 自適應圖示的安全區內，不會被圓形遮罩切到。
const srcIcon = resolve(root, '..', 'assets', 'icon-source-1024.png');
const outDir = join(root, 'resources');

if (!existsSync(srcIcon)) {
  console.error('✗ 找不到 ' + srcIcon + '\n  請確認 assets/ 在專案根目錄。');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// icon.png：@capacitor/assets 建議 1024×1024，但它自己會處理放大，
// 512 的來源對手機圖示已經綽綽有餘（最大用到 192dp ≈ 512px）。
copyFileSync(srcIcon, join(outDir, 'icon.png'));

/* ---------- 產生純色 splash（手寫最小 PNG）---------- */
// 為什麼手寫：只是要一張單色圖，為此裝一個影像函式庫不划算。
// PNG 的結構很簡單 —— 簽章 + IHDR + IDAT + IEND，每塊後面接 CRC32。
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type 2 = truecolor RGB
  // 每一列前面有一個 filter byte（0 = None）
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x0b, 0x0f, 0x14];      // 跟 App 的底色一致，開啟時不會閃白
const splash = solidPng(2732, BG);
writeFileSync(join(outDir, 'splash.png'), splash);
writeFileSync(join(outDir, 'splash-dark.png'), splash);

console.log('✓ resources/icon.png');
console.log(`✓ resources/splash.png + splash-dark.png（2732×2732 純色 #0b0f14，${(splash.length / 1024).toFixed(0)} KB）`);
console.log('  接著：npx @capacitor/assets generate --android');
