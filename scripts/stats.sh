#!/usr/bin/env bash
# 鹿豹使用統計（後台用，App 畫面上不顯示）
#   scripts/stats.sh          → 現在在線、最近 14 天
#   scripts/stats.sh 30       → 最近 30 天
# 直接查正式的 D1，用的是本機 wrangler 登入，不需要 ADMIN_TOKEN、也不開公開 API。
set -euo pipefail
cd "$(dirname "$0")/../backend"
DAYS="${1:-14}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "用法：$0 [天數]"; exit 1; }

SQL="SELECT 'now' AS k, COUNT(*) AS a, NULL AS b, NULL AS c FROM online
       WHERE last > strftime('%s','now') * 1000 - 120000;
     SELECT d.day AS k,
            (SELECT COUNT(*) FROM daily_dev x WHERE x.day = d.day) AS a,
            d.peak AS b,
            strftime('%H:%M', d.peak_at / 1000 + 8 * 3600, 'unixepoch') AS c
       FROM daily d
      WHERE d.day >= date('now', '+8 hours', '-$((DAYS - 1)) days')
      ORDER BY d.day DESC;"

npx --yes wrangler d1 execute luleopard --remote --json --command "$SQL" 2>/dev/null | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const out = JSON.parse(s), rows = out.flatMap(r => r.results || []);
  const now = rows.find(r => r.k === "now");
  console.log("現在在線（2 分鐘內有心跳）：" + (now ? now.a : 0) + " 台\n");
  const days = rows.filter(r => r.k !== "now");
  if (!days.length) { console.log("還沒有每日資料"); return; }
  console.log("日期          使用裝置  同時在線高峰");
  for (const r of days) console.log(r.k + "    " + String(r.a).padStart(6) + "    " + String(r.b).padStart(4) + "（" + r.c + "）");
});'
