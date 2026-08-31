#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鹿豹 · 國道交流道擷取
================================================================
從 OpenStreetMap 抓台灣國道與快速道路的交流道（出口），輸出成 App 可以直接用的
精簡 JSON，讓 App 在到達前 3 公里播報下一個交流道名稱。

資料來源是 OSM 的 highway=motorway_junction 節點 —— 那正是「出口」這個概念在
OSM 的表示法，帶有 name（交流道名）與 ref（出口編號）。

    python3 build_interchanges.py                # 線上抓（Overpass）
    python3 build_interchanges.py --offline      # 用 downloads/overpass_junction.json

輸出（預設 dist/）：
    interchanges.min.json   {"generated":..., "items":[[lat,lon,name,ref,road], ...]}
    interchanges.report.md  每條國道各有幾個交流道、缺名稱的有幾個

只用 Python 標準函式庫。
"""

import argparse, json, math, os, re, sys, time
import urllib.request, urllib.error
from collections import defaultdict
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
TPE = timezone(timedelta(hours=8))

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "luleopard-interchanges/1.0 (Taiwan driving alert app)"

# 台灣範圍（含離島），用來濾掉明顯錯誤的座標
BBOX = (21.5, 118.0, 26.5, 122.5)


def overpass_query():
    """
    抓台灣所有 motorway_junction 節點，連同它所在的道路一起帶回來。

    單純抓節點的話拿不到「這個交流道屬於哪條國道」—— 節點自己沒有路名。
    所以同時抓出它相鄰的 motorway/trunk way，之後用節點 id 反查。
    """
    return """
[out:json][timeout:180];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
node["highway"="motorway_junction"](area.tw)->.jc;
way["highway"~"^(motorway|trunk)$"](area.tw)->.rd;
(
  .jc;
  way.rd(bn.jc);
);
out body;
""".strip()


def fetch(cache_dir, offline, downloads):
    fn_cache = os.path.join(cache_dir, "overpass_junction.json")
    fn_dl = os.path.join(downloads, "overpass_junction.json")
    for fn in (fn_dl, fn_cache):
        if os.path.exists(fn):
            print(f"   使用本機檔案 {os.path.basename(fn)}")
            return json.load(open(fn, encoding="utf-8"))
    if offline:
        raise FileNotFoundError(
            f"offline 模式但找不到 {fn_dl}。請先線上跑一次，"
            "或手動把 Overpass 查詢結果存成該檔名。")

    q = overpass_query()
    last = None
    for ep in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    ep, data=q.encode("utf-8"),
                    headers={"User-Agent": UA,
                             "Content-Type": "text/plain; charset=utf-8"})
                with urllib.request.urlopen(req, timeout=200) as r:
                    data = json.loads(r.read().decode("utf-8"))
                os.makedirs(cache_dir, exist_ok=True)
                json.dump(data, open(fn_cache, "w", encoding="utf-8"), ensure_ascii=False)
                return data
            except Exception as e:                      # noqa: BLE001
                last = e
                time.sleep(5 * (attempt + 1))          # Overpass 忙碌時回 429/504
        print(f"   {ep} 失敗（{type(last).__name__}），換下一個")
    raise last


CN = {"1": "一", "2": "二", "3": "三", "4": "四", "5": "五",
      "6": "六", "7": "七", "8": "八", "9": "九", "10": "十"}


def norm_road(tags):
    """把 OSM 的 ref 正規化成台灣人講的路名：'TW:1' / 'N1' → 國道1號；'T61' → 台61線。"""
    ref = (tags.get("ref") or "").strip()
    name = (tags.get("name") or "").strip()
    m = re.search(r"(?:國道|N|TW:)\s*(\d+)", ref) or re.search(r"國道(\d+)", name)
    if m:
        return "國道" + m.group(1) + "號"
    m = re.search(r"[台臺T]\s*(\d+)", ref) or re.search(r"[台臺](\d+)線", name)
    if m:
        return "台" + m.group(1) + "線"
    return ref or name or ""


def clean_name(raw):
    """
    交流道名稱正規化。OSM 上的寫法很雜：
      '台北交流道' / '台北' / 'Taipei IC' / '25 台北' / '台北系統交流道'
    統一成「XX交流道」或「XX系統」，語音唸起來才自然。
    """
    n = (raw or "").strip()
    if not n:
        return ""
    n = re.sub(r"^\s*\d+[A-Za-z]?\s*[-–]?\s*", "", n)      # 去掉開頭的出口編號
    n = re.sub(r"\s*\(.*?\)\s*", "", n)                     # 去掉括號註記
    n = re.sub(r"\s*(Interchange|IC|JCT|Junction|System)\s*$", "", n, flags=re.I)
    n = n.strip(" ·-–—")
    if not n:
        return ""
    if n.endswith("系統交流道"):
        n = n[:-3]                                          # 系統交流道 → 系統
    if not re.search(r"(交流道|系統|服務區|收費站)$", n):
        n += "交流道"
    return n


def in_bbox(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def build(data, stats):
    els = data.get("elements", [])
    nodes = {e["id"]: e for e in els if e.get("type") == "node"}
    ways = [e for e in els if e.get("type") == "way"]

    # 節點 id → 它所在的道路名稱（一個交流道可能接到好幾條 way，取第一個有名字的）
    node_road = {}
    for w in ways:
        road = norm_road(w.get("tags") or {})
        if not road:
            continue
        for nid in w.get("nodes") or []:
            node_road.setdefault(nid, road)

    items = []
    seen = set()
    for nid, n in nodes.items():
        t = n.get("tags") or {}
        if t.get("highway") != "motorway_junction":
            continue
        lat, lon = n.get("lat"), n.get("lon")
        if lat is None or lon is None:
            stats["no_coords"] += 1
            continue
        if not in_bbox(lat, lon):
            stats["out_of_bbox"] += 1
            continue
        name = clean_name(t.get("name") or t.get("name:zh") or "")
        if not name:
            stats["no_name"] += 1
            continue
        ref = (t.get("ref") or "").strip()[:8]
        road = node_road.get(nid, "")
        # 同一個交流道常有多個節點（上下行各一、匝道各一），
        # 用「路名+名稱」去重，並保留第一個；否則語音會連報好幾次同一個交流道。
        key = (road, name)
        if key in seen:
            stats["dedup"] += 1
            continue
        seen.add(key)
        items.append([round(lat, 6), round(lon, 6), name, ref, road])

    items.sort(key=lambda x: (x[4], -x[0]))
    return items


def report(items, stats, out_dir):
    by_road = defaultdict(int)
    for it in items:
        by_road[it[4] or "（無法判斷路名）"] += 1
    L = ["# 交流道擷取報告", "",
         f"產生時間：{datetime.now(TPE).strftime('%Y-%m-%d %H:%M')} (UTC+8)", "",
         f"**共 {len(items)} 個交流道**", "",
         "| 道路 | 交流道數 |", "|---|---|"]
    for r, n in sorted(by_road.items(), key=lambda kv: -kv[1]):
        L.append(f"| {r} | {n} |")
    L += ["", "## 過濾掉的", "",
          f"- 沒有名稱：{stats['no_name']}（OSM 上有些交流道節點只有出口編號沒有名字）",
          f"- 重複節點合併：{stats['dedup']}（同一個交流道上下行各有節點）",
          f"- 座標超出台灣範圍：{stats['out_of_bbox']}",
          f"- 沒有座標：{stats['no_coords']}", "",
          "## 授權", "",
          "資料來源 © OpenStreetMap contributors，依 ODbL 1.0 授權。",
          "本檔案為 OSM 的衍生資料庫，同樣以 ODbL 授權釋出。", ""]
    md = "\n".join(L)
    open(os.path.join(out_dir, "interchanges.report.md"), "w", encoding="utf-8").write(md)
    return md


def main():
    ap = argparse.ArgumentParser(description="抓台灣國道交流道")
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--cache", default=os.path.join(HERE, "cache"))
    ap.add_argument("--downloads", default=os.path.join(HERE, "downloads"))
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--fail-under", type=int, default=0,
                    help="交流道數低於這個值就失敗，避免抓到空檔覆蓋好資料")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    stats = defaultdict(int)

    print("→ 從 OpenStreetMap 抓交流道節點")
    data = fetch(a.cache, a.offline, a.downloads)
    items = build(data, stats)

    out = {"generated": datetime.now(TPE).isoformat(timespec="seconds"),
           "count": len(items),
           "attribution": "© OpenStreetMap contributors, ODbL 1.0",
           "items": items}
    fn = os.path.join(a.out, "interchanges.min.json")
    json.dump(out, open(fn, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    md = report(items, stats, a.out)
    print()
    print("=" * 54)
    print(f"共 {len(items)} 個交流道｜沒名字略過 {stats['no_name']}｜重複合併 {stats['dedup']}")
    print(f"輸出：{a.out}")
    print("=" * 54)

    if a.fail_under and len(items) < a.fail_under:
        print(f"✗ 只有 {len(items)} 個，低於門檻 {a.fail_under} —— 不覆蓋既有資料")
        sys.exit(1)


if __name__ == "__main__":
    main()
