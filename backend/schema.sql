-- 鹿豹路況回報後端 · D1 資料表
--   npx wrangler d1 execute luleopard --remote --file=schema.sql
--
-- 為什麼從 KV 換到 D1：
--   KV 免費方案一天只有 1000 次 list、1000 次寫入。以前一次查詢要 list 約 81 個網格，
--   一個人開一小時車就用完一整天的額度；回報、確認、車流探針也都算寫入。
--   D1 免費方案一天 500 萬列讀取、10 萬列寫入，一次查詢只要一個 SQL。

-- 使用者回報。lat/lon/expires 拉成欄位給查詢用，其餘整筆放在 data（JSON）
CREATE TABLE IF NOT EXISTS hazards (
  id      TEXT PRIMARY KEY,
  lat     REAL NOT NULL,
  lon     REAL NOT NULL,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hazards_lat ON hazards(lat, lon);
CREATE INDEX IF NOT EXISTS idx_hazards_expires ON hazards(expires);

-- 小型鍵值：官方事件清單、TDX 憑證、回報冷卻
CREATE TABLE IF NOT EXISTS meta (
  k   TEXT PRIMARY KEY,
  v   TEXT NOT NULL,
  exp INTEGER             -- 毫秒時間戳；NULL = 不過期
);

-- 使用統計（只有後台看，App 畫面不顯示）
--   App 開著時每 60 秒 POST /ping，只帶匿名裝置代號；這裡存的是代號的雜湊
--   查詢：scripts/stats.sh
CREATE TABLE IF NOT EXISTS online (
  dev  TEXT PRIMARY KEY,
  last INTEGER NOT NULL      -- 最後一次心跳（毫秒）
);
CREATE INDEX IF NOT EXISTS idx_online_last ON online(last);

-- 每天出現過的裝置（算每日使用人數），保留 90 天
CREATE TABLE IF NOT EXISTS daily_dev (
  day TEXT NOT NULL,         -- 台灣時間 YYYY-MM-DD
  dev TEXT NOT NULL,
  PRIMARY KEY (day, dev)
);

-- 每天同時在線的高峰
CREATE TABLE IF NOT EXISTS daily (
  day     TEXT PRIMARY KEY,
  peak    INTEGER NOT NULL,
  peak_at INTEGER NOT NULL
);
