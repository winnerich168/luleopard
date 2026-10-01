#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鹿豹 · 替每支測速照相標上「在哪條路、哪一層」
================================================================
實地回報：高架與底下平面道路、國道與五楊／汐五高架重疊的地方，
App 會把另一層的照相報出來（例如在國道上一路報「速限 50」）。

政府資料只有經緯度，沒有「這支裝在高架上還是平面」。這支程式拿 OpenStreetMap
的道路資料比對：每支照相 45 公尺內有哪些道路、各在第幾層（layer／bridge），
再用照相名稱（國道一號、五楊高架、台64、中華路…）判斷它是哪一條。

    python3 tag_cam_roads.py                 # 線上抓（Overpass，會快取到 downloads/camroads/）
    python3 tag_cam_roads.py --offline       # 只用快取

輸入：../docs/data/speedcams.min.json   [[lat, lon, 速限, 方向, 名稱], ...]
輸出（預設 dist/）：
    camroads.min.json    {"lat,lon": [層, 道路, 類別, 判斷依據, 是否重疊區], ...}
    camroads.report.md   統計：多少支在高架、多少支在重疊區、多少支對不到道路

只用 Python 標準函式庫。
"""

import argparse, json, math, os, re, sys, time, urllib.request, urllib.parse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "luleopard-camroads/0.1 (Taiwan speed camera alert app; https://github.com/winnerich168/luleopard)"

NEAR_M = 45          # 照相離道路中心線多遠以內算「在這條路上」
BATCH = 40           # 每次查詢幾支照相（太大 Overpass 容易逾時）

HW = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$"

# ── 幾何 ──────────────────────────────────────────────────────
def to_xy(lat0, lon0, lat, lon):
    cl = math.cos(math.radians(lat0))
    return ((lon - lon0) * cl * 111320.0, (lat - lat0) * 111320.0)

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)

def way_dist(lat, lon, geom):
    pts = [to_xy(lat, lon, g["lat"], g["lon"]) for g in geom]
    if len(pts) == 1:
        return math.hypot(*pts[0])
    return min(seg_dist(0, 0, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))

# ── 層 ────────────────────────────────────────────────────────
def level_of(tags):
    """OSM 的 layer；沒寫 layer 但標了 bridge 視為 1、tunnel 視為 -1"""
    lay = tags.get("layer")
    if lay is not None:
        try:
            return int(float(lay.split(";")[0]))
        except ValueError:
            pass
    if tags.get("bridge") not in (None, "no"):
        return 1
    if tags.get("tunnel") not in (None, "no"):
        return -1
    return 0

# ── 名稱比對 ──────────────────────────────────────────────────
CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
def cn_num(s):
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if s.startswith("十"):
        return 10 + CN.get(s[1:], 0)
    if s.endswith("十"):
        return CN.get(s[0], 0) * 10
    if "十" in s:
        a, b = s.split("十")
        return CN.get(a, 0) * 10 + CN.get(b, 0)
    return CN.get(s, 0)

def cam_refs(name):
    """照相名稱裡提到的路線編號，正規化成 {'國1', '台64', '縣191'} 這種形式"""
    out = set()
    for m in re.finditer(r"國道\s*([一二三四五六七八九十\d]+)\s*號?", name):
        out.add("國" + str(cn_num(m.group(1))))
    for m in re.finditer(r"國\s*(\d+)", name):
        out.add("國" + m.group(1))
    for m in re.finditer(r"[台臺]\s*(\d+)\s*([甲乙丙丁戊己庚]?)\s*線?", name):
        out.add("台" + m.group(1) + m.group(2))
    for m in re.finditer(r"(?:縣道|縣)?\s*(\d{3})\s*([甲乙丙丁]?)\s*(?:線|縣道)", name):
        out.add("縣" + m.group(1) + m.group(2))
    return out

def way_refs(tags):
    out = set()
    for r in re.split(r"[;,]", tags.get("ref", "") or ""):
        r = r.strip().replace("臺", "台")
        m = re.match(r"^國道?\s*(\d+)\s*號?", r)
        if m:
            out.add("國" + m.group(1)); continue
        m = re.match(r"^台\s*(\d+)\s*([甲乙丙丁戊己庚]?)", r)
        if m:
            out.add("台" + m.group(1) + m.group(2)); continue
        m = re.match(r"^(?:縣道?\s*)?(\d{3})\s*([甲乙丙丁]?)", r)
        if m:
            out.add("縣" + m.group(1) + m.group(2))
    return out

FAST_CAM = re.compile(r"國道|快速|高架|聯絡道|台6[1-8]|台7[2-8]|台8[2-8]")
ELEV_CAM = re.compile(r"高架|五楊|汐五")

def score(cam_name, cand):
    t = cand["tags"]
    s = 0.0
    refs_c, refs_w = cam_refs(cam_name), way_refs(t)
    if refs_c & refs_w:
        s += 4
    nm = (t.get("name") or "").strip()
    if nm and len(nm) >= 2 and nm in cam_name:
        s += 3
    hw = t.get("highway", "")
    fast_way = hw.startswith(("motorway", "trunk"))
    fast_cam = bool(FAST_CAM.search(cam_name))
    if fast_cam and fast_way:
        s += 1.5
    if fast_cam != fast_way and (refs_c or fast_cam):
        s -= 1.5
    if ELEV_CAM.search(cam_name):
        s += 2 if cand["lvl"] >= 1 else -2
    elif "高架" in nm:
        # 照相名稱沒寫高架、這條路的名稱卻是某某高架 → 照相是底下那層的。
        # 例：「國道一號北向63.7公里」在五楊高架正下方，兩層在 OSM 都是國1，只有名稱分得出來
        s -= 2.5
    # 越近越好，但距離只當作小幅加權（照相座標本身常偏離路中心 10～30 公尺）
    s -= cand["d"] / 30.0
    return s

def tag_one(cam, ways):
    lat, lon, lim, d, name = cam[:5]
    cands = []
    for w in ways:
        g = w.get("geometry")
        if not g:
            continue
        dd = way_dist(lat, lon, g)
        if dd <= NEAR_M:
            cands.append({"d": dd, "tags": w.get("tags", {}), "lvl": level_of(w.get("tags", {}))})
    if not cands:
        return None
    levels = {c["lvl"] for c in cands}
    overlap = len(levels) > 1
    for c in cands:
        c["s"] = score(name, c)
    cands.sort(key=lambda c: -c["s"])
    best = cands[0]
    t = best["tags"]
    road = ("/".join(sorted(way_refs(t))) or t.get("name") or t.get("highway", ""))
    # 判斷依據：有名稱或路線編號對上 = name；只是最近的 = nearest
    refs_hit = bool(cam_refs(name) & way_refs(t)) or ((t.get("name") or "") and t.get("name") in name)
    elev_named = any("高架" in (c["tags"].get("name") or "") for c in cands if c is not best)
    why = "name" if refs_hit or ELEV_CAM.search(name) else "nearest"
    if overlap and not ELEV_CAM.search(name) and elev_named and best["lvl"] < max(levels):
        why = "name"      # 上面那層是有名字的高架、照相名稱沒提到高架 → 確定是底下那層
    # 重疊區只靠「最近」判斷不可靠：同一點上下兩層距離都差不多 → 標成不確定，App 不拿它排除
    if overlap and why == "nearest":
        # 兩層的候選分數差很多（例如名稱寫明是平面街道）才算確定
        other = next((c for c in cands[1:] if c["lvl"] != best["lvl"]), None)
        if other and best["s"] - other["s"] < 1.0:
            why = "unsure"
    cls = t.get("highway", "")
    return [best["lvl"], road, cls, why, 1 if overlap else 0]

# ── Overpass ─────────────────────────────────────────────────
def overpass(q, tries=6):
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for i in range(tries):
        url = ENDPOINTS[i % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            return json.loads(body)
        except Exception as e:  # 504／429／連線中斷都重試
            last = e
            wait = min(60, 5 * (2 ** i))
            print(f"    ! {url.split('/')[2]} 失敗（{e}），{wait} 秒後重試", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"Overpass 重試 {tries} 次仍失敗：{last}")

def fetch_batch(cams, cache_fn, offline, depth=0):
    """抓一批照相附近的道路。一直逾時就拆成兩半分開抓（小查詢比較容易成功），各自快取。"""
    if os.path.exists(cache_fn):
        with open(cache_fn, encoding="utf-8") as f:
            return json.load(f)
    if offline:
        raise RuntimeError("離線模式但沒有快取：" + cache_fn)
    parts = "".join(f'way[highway~"{HW}"](around:{NEAR_M + 15},{c[0]:.6f},{c[1]:.6f});' for c in cams)
    q = f"[out:json][timeout:150];({parts});out tags geom;"
    try:
        j = overpass(q, tries=4 if len(cams) > 5 else 8)
    except RuntimeError:
        if len(cams) <= 1 or depth >= 4:
            raise
        half = len(cams) // 2
        print(f"    ↳ 拆成 {half} + {len(cams) - half} 支重抓", file=sys.stderr)
        base = cache_fn[:-5]
        j1 = fetch_batch(cams[:half], base + "_a.json", offline, depth + 1)
        j2 = fetch_batch(cams[half:], base + "_b.json", offline, depth + 1)
        j = {"elements": j1.get("elements", []) + j2.get("elements", [])}
    with open(cache_fn, "w", encoding="utf-8") as f:
        json.dump(j, f, ensure_ascii=False)
    time.sleep(2)          # 對志工營運的服務客氣一點
    return j

# ── 主程式 ────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(ROOT, "docs/data/speedcams.min.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--cache", default=os.path.join(HERE, "downloads/camroads"))
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()

    with open(a.input, encoding="utf-8") as f:
        cams = json.load(f)
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)

    # 依位置排序再分批：同一批的照相彼此靠近，查詢範圍小、比較不會逾時
    order = sorted(range(len(cams)), key=lambda i: (round(cams[i][0], 1), cams[i][1]))
    result, stats = {}, Counter()
    nb = math.ceil(len(order) / BATCH)
    for b in range(nb):
        idx = order[b * BATCH:(b + 1) * BATCH]
        batch = [cams[i] for i in idx]
        key = f"{batch[0][0]:.4f}_{batch[0][1]:.4f}_{len(batch)}"
        print(f"  批次 {b + 1}/{nb}（{len(batch)} 支）", file=sys.stderr)
        j = fetch_batch(batch, os.path.join(a.cache, f"b_{key}.json"), a.offline)
        ways = [e for e in j.get("elements", []) if e.get("type") == "way"]
        for c in batch:
            t = tag_one(c, ways)
            k = f"{c[0]:.5f},{c[1]:.5f}"
            if t is None:
                stats["對不到道路"] += 1
                continue
            result[k] = t
            stats["有對到道路"] += 1
            if t[0] >= 1: stats["在高架／橋上（層≥1）"] += 1
            if t[0] < 0: stats["在地下道／隧道（層<0）"] += 1
            if t[4]: stats["在上下重疊區"] += 1
            if t[4] and t[3] == "name": stats["重疊區：名稱確認"] += 1
            if t[4] and t[3] == "unsure": stats["重疊區：無法確定（App 不排除）"] += 1
            if FAST_CAM.search(c[4]): stats["國道／快速道路類照相"] += 1

    with open(os.path.join(a.out, "camroads.min.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "near_m": NEAR_M,
                   "fields": ["層", "道路", "類別", "判斷依據", "重疊區"], "cams": result},
                  f, ensure_ascii=False, separators=(",", ":"))

    lines = ["# 測速照相道路與層數標記", "",
             f"產生時間：{time.strftime('%Y-%m-%d %H:%M')}　照相總數：{len(cams)}", "",
             "| 項目 | 支數 |", "|---|---|"]
    for k in ["有對到道路", "對不到道路", "在高架／橋上（層≥1）", "在地下道／隧道（層<0）",
              "在上下重疊區", "重疊區：名稱確認", "重疊區：無法確定（App 不排除）", "國道／快速道路類照相"]:
        lines.append(f"| {k} | {stats[k]} |")
    lines += ["", "## 在上下重疊區的照相", "", "| 照相 | 判定層 | 道路 | 依據 |", "|---|---|---|---|"]
    for c in cams:
        t = result.get(f"{c[0]:.5f},{c[1]:.5f}")
        if t and t[4]:
            lines.append(f"| {c[4]} | {t[0]} | {t[1]} | {t[3]} |")
    with open(os.path.join(a.out, "camroads.report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines[:16]))

if __name__ == "__main__":
    main()
