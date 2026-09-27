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
