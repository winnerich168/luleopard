#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鹿豹 · 路網幾何擷取
================================================================
從 OpenStreetMap 抓台灣國道、快速道路與主要省道的中心線，接成連續路線、
簡化後輸出成 App 可以直接用的精簡 JSON。

有了路網幾何，App 就能做到：
  · 「前方測速點」沿著路彎過去，而不是用航向錐形猜（彎道不再漏列或多列）
  · 里程推算用「沿路距離」而不是直線距離，山區路段誤差大幅下降
  · 區間測速的起訖可以投影到實際路線上

    python3 build_roadnet.py                    # 線上抓（Overpass）
    python3 build_roadnet.py --offline          # 用 downloads/overpass_*.json
    python3 build_roadnet.py --roads 國道1號,台61線

輸出（預設 dist/）：
    roadnet.min.json    [{id,ref,name,cls,pts:[[lat,lon],...]}, ...]
    roadnet.report.md   每條路的長度、點數、被切成幾段

只用 Python 標準函式庫。
"""

import argparse, json, math, os, re, sys, time, urllib.request, urllib.error
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))

# Overpass 公共實例。這是志工營運的免費服務，請不要高頻濫用。
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

UA = "luleopard-roadnet/0.7 (Taiwan road hazard alert app; contact: your-email@example.com)"

# 要抓哪些道路。cls 決定 App 用哪一組警示距離。
ROAD_CLASSES = {
    "motorway": "國道",        # 國道1~10
    "trunk": "快速道路",        # 台61西濱、台62、台64、台65、台66、台68、台72、台74、台76、台78、台82、台84、台86、台88
    "primary": "省道",          # 台1、台3、台9 等
}


def overpass_query(cls):
    """抓某一類道路的 way 幾何。out geom 直接把座標帶回來，不用再查 node。"""
    return f"""
[out:json][timeout:180];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
(
  way["highway"="{cls}"](area.tw);
  way["highway"="{cls}_link"](area.tw);
);
out geom;
""".strip()


def fetch(cls, cache_dir, offline, downloads):
    fn_cache = os.path.join(cache_dir, f"overpass_{cls}.json")
    fn_dl = os.path.join(downloads, f"overpass_{cls}.json")
    for fn in (fn_dl, fn_cache):
        if os.path.exists(fn):
            print(f"   使用本機檔案 {os.path.basename(fn)}")
            return json.load(open(fn, encoding="utf-8"))
    if offline:
        raise FileNotFoundError(
            f"offline 模式但找不到 {fn_dl}。請先線上跑一次，或手動把 Overpass 結果存成該檔名。")

    q = overpass_query(cls)
    last = None
    for ep in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    ep, data=q.encode("utf-8"),
                    headers={"User-Agent": UA, "Content-Type": "text/plain; charset=utf-8"})
                with urllib.request.urlopen(req, timeout=200) as r:
                    data = json.loads(r.read().decode("utf-8"))
                os.makedirs(cache_dir, exist_ok=True)
                json.dump(data, open(fn_cache, "w", encoding="utf-8"), ensure_ascii=False)
                return data
            except Exception as e:                      # noqa: BLE001
                last = e
                # Overpass 忙碌時會回 429/504，等一下再試
                time.sleep(5 * (attempt + 1))
        print(f"   {ep} 失敗（{type(last).__name__}），換下一個")
    raise last


# ────────────────────────────────────────────────────────────
# 幾何工具
# ────────────────────────────────────────────────────────────
def hav(a, b, c, d):
    R = 6371000.0
    p, q = math.radians(a), math.radians(c)
    dp, dl = math.radians(c - a), math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p) * math.cos(q) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def line_len(pts):
    return sum(hav(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
               for i in range(len(pts) - 1))


def rdp(pts, eps):
    """Douglas–Peucker 簡化。eps 用公尺，用等距投影近似即可。"""
    if len(pts) < 3:
        return pts[:]
    lat0 = math.radians(pts[0][0])
    kx = 111320 * math.cos(lat0)
    ky = 110540

    def perp(p, a, b):
        px, py = (p[1] - a[1]) * kx, (p[0] - a[0]) * ky
        bx, by = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
        L2 = bx * bx + by * by
        if L2 == 0:
            return math.hypot(px, py)
        t = max(0.0, min(1.0, (px * bx + py * by) / L2))
        return math.hypot(px - t * bx, py - t * by)

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, idx = 0.0, i
        for k in range(i + 1, j):
            d = perp(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > eps:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


def norm_ref(tags):
    """把 ref/name 正規化成「國道1號」「台61線」這種台灣慣用寫法。"""
    ref = (tags.get("ref") or "").strip()
    name = (tags.get("name") or tags.get("name:zh") or "").strip()
    for cand in (ref, name):
        if not cand:
            continue
        m = re.search(r"國道\s*(\d+)", cand)
        if m:
            return f"國道{m.group(1)}號"
        m = re.match(r"^\s*N(\d+)\s*$", cand)
        if m:
            return f"國道{m.group(1)}號"
        m = re.search(r"台\s*(\d+)\s*([甲乙丙丁]?)\s*線", cand)
        if m:
            return f"台{m.group(1)}{m.group(2)}線"
        m = re.match(r"^\s*(?:TW-)?台?(\d+)([甲乙丙丁]?)\s*$", cand)
        if m and cand != name:
            return f"台{m.group(1)}{m.group(2)}線"
    return ref or name or ""


def chain(ways):
    """把同一條路的多個 way 依端點接成連續線；接不起來的各自成段。"""
    segs = [list(w) for w in ways if len(w) >= 2]
    if not segs:
        return []
    KEY = lambda p: (round(p[0], 6), round(p[1], 6))
    out = []
    used = [False] * len(segs)
    # 建端點索引
    ends = defaultdict(list)
    for i, s in enumerate(segs):
        ends[KEY(s[0])].append((i, "head"))
        ends[KEY(s[-1])].append((i, "tail"))

    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        cur = segs[i][:]
        # 往後接
        grew = True
        while grew:
            grew = False
            for j, side in ends.get(KEY(cur[-1]), []):
                if used[j]:
                    continue
                nxt = segs[j][:]
                if side == "tail":
                    nxt.reverse()
                cur.extend(nxt[1:])
                used[j] = True
                grew = True
                break
        # 往前接
        grew = True
        while grew:
            grew = False
            for j, side in ends.get(KEY(cur[0]), []):
                if used[j]:
                    continue
                prv = segs[j][:]
                if side == "head":
                    prv.reverse()
                cur = prv[:-1] + cur
                used[j] = True
                grew = True
                break
        out.append(cur)
    return out


# ────────────────────────────────────────────────────────────
def build(data, cls_name, want, eps, min_len, stats):
    by_ref = defaultdict(list)
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        tags = el.get("tags") or {}
        ref = norm_ref(tags)
        if not ref:
            stats["no_ref"] += 1
            continue
        if want and ref not in want:
            continue
        by_ref[ref].append([[g["lat"], g["lon"]] for g in geom])

    roads = []
    for ref, ways in sorted(by_ref.items()):
        parts = chain(ways)
        idx = 0
        for p in parts:
            L = line_len(p)
            if L < min_len:
                stats["too_short"] += 1
                continue
            simp = rdp(p, eps)
            idx += 1
            roads.append({
                "id": f"{ref}#{idx}",
                "ref": ref,
                "cls": cls_name,
                "lenM": round(L),
                "pts": [[round(a, 5), round(b, 5)] for a, b in simp],
            })
    return roads


def main():
    ap = argparse.ArgumentParser(description="從 OpenStreetMap 建立台灣路網幾何")
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--cache", default=os.path.join(HERE, "cache"))
    ap.add_argument("--downloads", default=os.path.join(HERE, "downloads"))
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--roads", help="只留這些路，逗號分隔，例如 國道1號,台61線")
    ap.add_argument("--classes", default="motorway,trunk",
                    help="要抓的 OSM highway 類別，預設國道+快速道路。加 primary 會大很多")
    ap.add_argument("--simplify", type=float, default=8.0, help="簡化容差（公尺）")
    ap.add_argument("--min-length", type=float, default=800.0, help="短於這個長度的碎段丟掉（公尺）")
    a = ap.parse_args()

    want = {x.strip() for x in a.roads.split(",")} if a.roads else None
    started = time.time()
    all_roads, per_class = [], []

    for cls in [c.strip() for c in a.classes.split(",") if c.strip()]:
        cls_name = ROAD_CLASSES.get(cls, cls)
        print(f"→ {cls} ({cls_name})", flush=True)
        stats = {"no_ref": 0, "too_short": 0}
        try:
            data = fetch(cls, a.cache, a.offline, a.downloads)
        except Exception as e:                          # noqa: BLE001
            print(f"   ✗ 失敗：{type(e).__name__}: {e}")
            per_class.append({"cls": cls, "name": cls_name, "roads": 0,
                              "error": f"{type(e).__name__}: {e}"})
            continue
        roads = build(data, cls_name, want, a.simplify, a.min_length, stats)
        all_roads += roads
        refs = sorted({r["ref"] for r in roads})
        km = sum(r["lenM"] for r in roads) / 1000
        print(f"   ✓ {len(refs)} 條路、{len(roads)} 段、共 {km:,.0f} 公里"
              f"（無編號略過 {stats['no_ref']}、碎段略過 {stats['too_short']}）")
        per_class.append({"cls": cls, "name": cls_name, "roads": len(roads),
                          "refs": refs, "km": round(km),
                          "no_ref": stats["no_ref"], "too_short": stats["too_short"]})

    os.makedirs(a.out, exist_ok=True)
    mini = [{"id": r["id"], "ref": r["ref"], "cls": r["cls"], "pts": r["pts"]} for r in all_roads]
    p_min = os.path.join(a.out, "roadnet.min.json")
    with open(p_min, "w", encoding="utf-8") as f:
        json.dump(mini, f, ensure_ascii=False, separators=(",", ":"))

    total_pts = sum(len(r["pts"]) for r in all_roads)
    size_kb = os.path.getsize(p_min) / 1024

    L = ["# 鹿豹 · 路網幾何報告", "",
         f"產生時間：{time.strftime('%Y-%m-%d %H:%M:%S')}（耗時 {time.time()-started:.1f}s）", "",
         "| 項目 | 數量 |", "|---|---|",
         f"| 路線段數 | {len(all_roads)} |",
         f"| 座標點數 | {total_pts:,} |",
         f"| 總長度 | {sum(r['lenM'] for r in all_roads)/1000:,.0f} 公里 |",
         f"| 檔案大小 | {size_kb:,.0f} KB |",
         f"| 簡化容差 | {a.simplify} 公尺 |", "",
         "## 各類別", "", "| 類別 | 段數 | 長度 | 道路 |", "|---|---|---|---|"]
    for c in per_class:
        if c.get("error"):
            L.append(f"| {c['name']} | — | — | **失敗**：{c['error'][:80]} |")
        else:
            L.append(f"| {c['name']} | {c['roads']} | {c['km']:,} km | {'、'.join(c['refs'][:40])} |")
    L += ["", "---", "",
          "資料來源：OpenStreetMap contributors，授權 ODbL。",
          "使用этой資料的產品必須標示來源並遵守 ODbL 的相同方式分享條款。"]
    with open(os.path.join(a.out, "roadnet.report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L).replace("этой", "此") + "\n")

    print("\n" + "=" * 58)
    print(f"路網 {len(all_roads)} 段、{total_pts:,} 點、{size_kb:,.0f} KB")
    print(f"輸出：{os.path.abspath(a.out)}")
    print("=" * 58)
    return 0 if all_roads else 1


if __name__ == "__main__":
    sys.exit(main())
