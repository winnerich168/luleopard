#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鹿豹 · 分方向路網與出口
================================================================
實地回報：交流道會誤報 —— 國道底下或旁邊的快速道路也有出口，App 用「前方 ±35°」
去猜，就把另一條路的出口報出來。照相也一樣，會報到隔壁那條路的。

唯一可靠的做法是 App 知道「我現在在哪一條路、往哪個方向」。這支程式產生 App 需要的
資料：

  1. 車道鏈（chains）：國道、快速道路、省道、縣道與匝道，把 OSM 的一段段 way
     依行車方向接成連續的線。國道南下、北上是兩條不同的鏈 —— 所以 App 一貼上鏈，
     方向就確定了，對向車道的出口不可能被算進來。
  2. 出口（exits）：每個出口掛在它所在的那條鏈、那個方向、第幾公尺。
     來源有兩種：OSM 的交流道節點（motorway_junction），以及國道／快速道路／高架道路上
     匝道分岔出去的位置（高架道路的出口多半沒有交流道節點）。

    python3 build_roadgraph.py               # 線上抓（Overpass），快取在 downloads/roadgraph/
    python3 build_roadgraph.py --offline     # 只用快取

輸出（預設 dist/）：
    roadgraph.min.json   App 用的路網＋出口
    roadgraph.report.md  統計

只用 Python 標準函式庫。
"""

import argparse, json, math, os, sys, time, urllib.request, urllib.parse
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from roadkey import road_key, road_refs, is_elevated          # noqa: E402
from build_interchanges import clean_name                    # noqa: E402

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "luleopard-roadgraph/1.0 (Taiwan driving alert app; https://github.com/winnerich168/luleopard)"

Q_ROADS = """
[out:json][timeout:300];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"](area.tw);
out tags geom;
""".strip()
# 國道、快速道路、高架道路旁邊 40 公尺內的一般道路（平面道路、側車道）。
# 它們本身不報出口，但一定要在路網裡：市民大道平面那層不是省道也不是縣道，
# 少了它，開在平面道路上時 App 只看得到頭上的高架，會以為自己在高架上而報出高架的出口。
# 全台一次查太重（公共 Overpass 會逾時），切成 0.5° 小格分批抓，每格各自快取。
def q_near(s, w, n, e):
    bb = f"({s},{w},{n},{e})"
    return f"""
[out:json][timeout:300];
(way["highway"~"^(motorway|trunk)$"]{bb};
 way["highway"~"^(primary|secondary)$"]["name"~"高架道"]{bb};)->.fe;
(way(around.fe:40)["highway"~"^(tertiary|unclassified|residential|living_street)(_link)?$"];
 way(around.fe:40)["highway"="service"][!"service"];);
out tags geom;
""".strip()

def fetch_near(bb, cache, offline, depth=0):
    """抓一格；道路密集的格子（台北、台中）容易逾時，失敗就切成四小格分開抓"""
    fn = os.path.join(cache, "near", "t_%s_%s_%s.json" % (bb[0], bb[1], round(bb[2] - bb[0], 4)))
    old = os.path.join(cache, "near", "t_%s_%s.json" % bb[:2])
    if depth == 0 and os.path.exists(old):
        fn = old
    try:
        return fetch(q_near(*bb), fn, offline, tries=8 if depth >= 2 else 3).get("elements", [])
    except RuntimeError:
        if depth >= 2:
            raise
        s, w, n, e = bb
        ms, mw = round((s + n) / 2, 4), round((w + e) / 2, 4)
        print(f"    ↳ {bb} 切成四小格", file=sys.stderr)
        out = []
        for sub in [(s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)]:
            out += fetch_near(sub, cache, offline, depth + 1)
        return out


NEAR_TILES = [(round(la, 1), round(lo, 1), round(la + 0.5, 1), round(lo + 0.5, 1))
              for la in [21.8 + 0.5 * i for i in range(8)]
              for lo in [119.9 + 0.5 * j for j in range(5)]]

Q_JUNCTION = """
[out:json][timeout:300];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
node["highway"="motorway_junction"](area.tw);
out body;
""".strip()

CLS = {"motorway": 0, "trunk": 1, "primary": 2, "secondary": 3,
       "tertiary": 5, "unclassified": 5, "residential": 5, "living_street": 5, "service": 5}
LINK = 4
MINOR = 5
SIMPLIFY_M = 4.0


# ── Overpass ─────────────────────────────────────────────────
def fetch(q, fn, offline, tries=8):
    if os.path.exists(fn):
        print(f"   使用快取 {os.path.relpath(fn, HERE)}")
        with open(fn, encoding="utf-8") as f:
            return json.load(f)
    if offline:
        raise SystemExit(f"離線模式但沒有快取：{fn}")
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for i in range(tries):
        ep = ENDPOINTS[i % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=400) as r:
                body = r.read()
            j = json.loads(body)           # Overpass 忙碌時回 HTML 錯誤頁，這裡會丟例外
            os.makedirs(os.path.dirname(fn), exist_ok=True)
            with open(fn, "wb") as f:
                f.write(body)
            return j
        except Exception as e:             # noqa: BLE001
            last = e
            wait = min(60, 5 * (2 ** i))
            print(f"    ! {ep.split('/')[2]} 失敗（{type(e).__name__}），{wait} 秒後重試", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"Overpass 重試仍失敗：{last}")


# ── 幾何 ─────────────────────────────────────────────────────
def hav(a, b, c, d):
    R = 6371000.0
    p, q = math.radians(a), math.radians(c)
    dp, dl = math.radians(c - a), math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p) * math.cos(q) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def bearing(a, b, c, d):
    p, q = math.radians(a), math.radians(c)
    dl = math.radians(d - b)
    y = math.sin(dl) * math.cos(q)
    x = math.cos(p) * math.sin(q) - math.sin(p) * math.cos(q) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def ang(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def rdp_keep(pts, eps, keep):
    """Douglas–Peucker 簡化；keep 裡的索引（出口所在點）一定保留"""
    n = len(pts)
    if n < 3:
        return list(range(n))
    kx = 111320 * math.cos(math.radians(pts[0][0])); ky = 110540
    flag = [False] * n
    flag[0] = flag[-1] = True
    for k in keep:
        flag[k] = True
    anchors = [i for i in range(n) if flag[i]]

    def perp(p, a, b):
        px, py = (p[1] - a[1]) * kx, (p[0] - a[0]) * ky
        bx, by = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
        L2 = bx * bx + by * by
        if L2 == 0:
            return math.hypot(px, py)
        t = max(0.0, min(1.0, (px * bx + py * by) / L2))
        return math.hypot(px - t * bx, py - t * by)

    stack = list(zip(anchors, anchors[1:]))
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
            flag[idx] = True
            stack.append((i, idx)); stack.append((idx, j))
    return [i for i in range(n) if flag[i]]


VK = lambda p: (round(p[0], 7), round(p[1], 7))


# ── 路段 → 車道鏈 ─────────────────────────────────────────────
def oneway_of(t):
    ow = (t.get("oneway") or "").lower()
    if ow in ("yes", "1", "true"):
        return 1
    if ow == "-1":
        return -1
    if ow in ("no", "reversible", "alternating"):
        return 0
    if t.get("junction") in ("roundabout", "circular"):
        return 1
    if t.get("highway") in ("motorway", "motorway_link"):
        return 1          # OSM 慣例：motorway 沒寫 oneway 也是單向
    return 0


def load_ways(data):
    ways = []
    for e in data.get("elements", []):
        if e.get("type") != "way" or len(e.get("geometry") or []) < 2:
            continue
        t = e.get("tags") or {}
        hw = t.get("highway", "")
        base = hw[:-5] if hw.endswith("_link") else hw
        if base not in CLS:
            continue
        pts = [(g["lat"], g["lon"]) for g in e["geometry"]]
        ow = oneway_of(t)
        if ow == -1:
            pts.reverse(); ow = 1
        link = hw.endswith("_link") and CLS[base] != MINOR
        ways.append({"id": e["id"], "t": t, "pts": pts, "ow": ow, "link": link,
                     "cls": LINK if link else CLS[base],
                     "key": road_key(t)})
    return ways


def chain_group(ws):
    """
    同一條路、同一種單雙向的 way 接成鏈。
    單向的只能「這段的尾 → 下一段的頭」照行車方向接，不會把南下接到北上去；
    雙向的頭尾都可以接（必要時反轉）。分岔處挑轉向最小的那條接下去。
    """
    heads, tails = defaultdict(list), defaultdict(list)
    for i, w in enumerate(ws):
        heads[VK(w["pts"][0])].append(i)
        tails[VK(w["pts"][-1])].append(i)
    used = [False] * len(ws)
    out = []

    def end_brg(pts, at_end):
        a, b = (pts[-2], pts[-1]) if at_end else (pts[0], pts[1])
        return bearing(a[0], a[1], b[0], b[1])

    def extend(cur, members, forward):
        while True:
            p = cur[-1] if forward else cur[0]
            here = end_brg(cur, forward)
            cands = []
            for j in (heads[VK(p)] if forward else tails[VK(p)]):
                if not used[j]:
                    q = ws[j]["pts"]
                    cands.append((ang(here, end_brg(q, not forward)), j, False))
            if ws[members[0]]["ow"] == 0:      # 雙向路：反方向登記的也可以接（反轉）
                for j in (tails[VK(p)] if forward else heads[VK(p)]):
                    if not used[j]:
                        q = ws[j]["pts"][::-1]
                        cands.append((ang(here, end_brg(q, not forward)), j, True))
            cands = [c for c in cands if c[0] < 100]
            if not cands:
                return cur
            _, j, rev = min(cands)
            used[j] = True; members.append(j)
            q = ws[j]["pts"][::-1] if rev else ws[j]["pts"]
            cur = cur + q[1:] if forward else q[:-1] + cur

    # 從「沒有前一段」的 way 開始接，鏈才會從頭開始；剩下的（環狀）最後處理
    order = sorted(range(len(ws)), key=lambda i: len(tails[VK(ws[i]["pts"][0])]) > 0)
    for i in order:
        if used[i]:
            continue
        used[i] = True
        members = [i]
        cur = list(ws[i]["pts"])
        cur = extend(cur, members, True)
        cur = extend(cur, members, False)
        out.append((cur, members))
    return out


def build_chains(ways):
    groups = defaultdict(list)
    for w in ways:
        # 匝道沒有固定的路名，全部匝道放同一組，只靠連通與方向接
        g = ("~link", w["ow"]) if w["link"] else (w["key"] or f"~way{w['id']}", w["ow"], w["cls"])
        groups[g].append(w)
    chains = []
    for g, ws in groups.items():
        for pts, members in chain_group(ws):
            mw = [ws[m] for m in members]
            names = []
            for w in mw:
                n = (w["t"].get("name") or "").strip()
                if n and n not in names:
                    names.append(n)
            refs = set()
            for w in mw:
                refs |= road_refs(w["t"])
            chains.append({"pts": pts, "ow": mw[0]["ow"], "cls": min(w["cls"] for w in mw),
                           "key": "" if mw[0]["link"] else mw[0]["key"],
                           "elev": any(is_elevated(w["t"]) for w in mw),
                           "names": names, "ways": mw})
    return chains


# ── 出口 ────────────────────────────────────────────────────
def find_exits(chains, ways, junctions):
    """
    出口 = 這條鏈上，有匝道（或交流道節點）往前分岔出去的那一點。
    只做國道、快速道路（trunk）與高架道路 —— 平面道路每個路口都是「出口」，報了沒意義。
    """
    vidx = defaultdict(list)          # 座標 → [(鏈, 點序)]
    for ci, c in enumerate(chains):
        if c["cls"] == LINK:
            continue
        if not (c["cls"] in (0, 1) or c["elev"]):
            continue
        for i, p in enumerate(c["pts"]):
            vidx[VK(p)].append((ci, i))

    link_from = defaultdict(list)     # 匝道起點座標 → 匝道
    for w in ways:
        if w["link"] or w["cls"] in (2, 3):
            link_from[VK(w["pts"][0])].append(w)
            if w["ow"] == 0:
                link_from[VK(w["pts"][-1])].append({**w, "pts": w["pts"][::-1]})

    jc_at = {}
    for n in junctions:
        t = n.get("tags") or {}
        if n.get("lat") is None:
            continue
        jc_at[VK((n["lat"], n["lon"]))] = t

    raw = defaultdict(list)           # 鏈 → [(點序, 方向, 名稱, 出口編號, 有交流道節點)]
    for vk, lst in vidx.items():
        jt = jc_at.get(vk)
        outs = link_from.get(vk, [])
        for ci, i in lst:
            c = chains[ci]
            pts = c["pts"]
            if c["ow"] and (i == 0 or i >= len(pts) - 1):
                continue              # 單向鏈的起點／終點是主線分岔處：出口算在上游那條鏈
            fwd = bearing(*pts[i], *pts[i + 1]) if i < len(pts) - 1 else None
            bwd = bearing(*pts[i], *pts[i - 1]) if i > 0 else None
            dirs = {}
            for w in outs:
                if w["key"] and w["key"] == c["key"] and not w["link"]:
                    continue          # 同一條路自己的下一段
                q = w["pts"]
                b = bearing(*q[0], *q[1])
                nm = destination_name(w["t"])
                if fwd is not None and ang(b, fwd) < 60:
                    dirs.setdefault(1, nm)
                elif c["ow"] == 0 and bwd is not None and ang(b, bwd) < 60:
                    dirs.setdefault(-1, nm)
            if jt and not dirs:
                # 有交流道節點但找不到分岔的匝道（例如資料只到節點）：單向鏈仍算往前的出口
                if c["ow"]:
                    dirs[1] = ""
            for d, nm in dirs.items():
                name = exit_name(jt) if jt else ""
                ref = (jt.get("ref") or "").strip()[:8] if jt else ""
                raw[ci].append((i, d, name, ref, nm))
    return raw


def exit_name(t):
    n = clean_name(t.get("name") or t.get("name:zh") or "")
    # 高架道路的出口在 OSM 叫「南京西路出口」，clean_name 會補成「南京西路出口交流道」
    for suf in ("出口交流道", "匝道交流道"):
        if n.endswith(suf):
            n = n[:-3]
    return n


def destination_name(t):
    dst = t.get("destination") or t.get("exit_to") or ""
    parts = [p.strip() for p in dst.split(";") if p.strip()][:2]
    if parts:
        return "往" + "、".join(parts)
    nm = (t.get("name") or "").strip()
    return nm if nm and not nm.endswith(("高架道路", "高速公路", "快速道路", "快速公路")) else ""


# ── 主程式 ───────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--cache", default=os.path.join(HERE, "downloads/roadgraph"))
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--fail-under", type=int, default=0, help="出口數低於這個值就失敗，不覆蓋既有資料")
    a = ap.parse_args()

    print("→ 抓道路")
    try:
        roads = fetch(Q_ROADS, os.path.join(a.cache, "overpass_roads.json"), a.offline)
    except RuntimeError as e:
        raise SystemExit(str(e))
    print("→ 抓國道／高架周邊的一般道路")
    seen_ids = {e["id"] for e in roads.get("elements", []) if e.get("type") == "way"}
    extra = []
    for k, bb in enumerate(NEAR_TILES):
        for e in fetch_near(bb, a.cache, a.offline):
            if e.get("type") == "way" and e["id"] not in seen_ids:
                seen_ids.add(e["id"]); extra.append(e)
    print(f"   周邊一般道路 {len(extra):,} 段")
    roads = {"elements": roads.get("elements", []) + extra}
    print("→ 抓交流道節點")
    jcs = fetch(Q_JUNCTION, os.path.join(a.cache, "overpass_junction.json"), a.offline)
    junctions = [e for e in jcs.get("elements", []) if e.get("type") == "node"]

    ways = load_ways(roads)
    chains = build_chains(ways)
    raw = find_exits(chains, ways, junctions)

    # 簡化幾何（出口所在點保留），計算沿路里程
    keys, key_ix = [], {}
    names, name_ix = [], {}
    def kix(k):
        if k not in key_ix:
            key_ix[k] = len(keys); keys.append(k)
        return key_ix[k]
    def nix(n):
        if n not in name_ix:
            name_ix[n] = len(names); names.append(n)
        return name_ix[n]

    out_chains, exits = [], []
    head_at = defaultdict(list)       # 起點座標 → 鏈（之後算「這條鏈接下去是哪幾條」）
    vert_at = defaultdict(set)        # 任一點 → 鏈（匝道尾端接到主線中間）
    simp_all = []
    for ci, c in enumerate(chains):
        keep = sorted({i for i, *_ in raw.get(ci, [])})
        idx = rdp_keep(c["pts"], SIMPLIFY_M, keep)
        sp = [c["pts"][i] for i in idx]
        simp_all.append(sp)
        cum = [0.0]
        for k in range(1, len(sp)):
            cum.append(cum[-1] + hav(*sp[k - 1], *sp[k]))
        pos = {i: cum[k] for k, i in enumerate(idx)}
        seen = []
        for i, d, name, ref, dst in sorted(raw.get(ci, []), key=lambda r: r[0]):
            along = pos[i]
            # 同一個出口常有好幾個分岔點（兩條匝道、交流道節點在前幾公尺）：
            # 150 公尺內的併成一個，優先留有交流道名稱的
            dup = next((e for e in seen if e[1] == d and abs(e[0] - along) < 150), None)
            if dup:
                if not dup[2] and name:
                    dup[2], dup[3] = name, ref
                if not dup[4] and dst:
                    dup[4] = dst
                continue
            seen.append([along, d, name, ref, dst, c["pts"][i]])
        for along, d, name, ref, dst, p in seen:
            exits.append([ci, round(along), d, name, ref, dst, round(p[0], 6), round(p[1], 6)])
        head_at[VK(sp[0])].append(ci)
        if c["ow"] == 0:
            head_at[VK(sp[-1])].append(ci)
        for p in sp:
            vert_at[VK(p)].add(ci)

    for ci, c in enumerate(chains):
        sp = simp_all[ci]
        ends = [sp[-1]] + ([sp[0]] if c["ow"] == 0 else [])
        to = set()
        for e in ends:
            to |= set(head_at.get(VK(e), [])) | vert_at.get(VK(e), set())
        to.discard(ci)
        # 座標壓成整數（1e5 ≈ 1 公尺），差分編碼
        flat, pl, pn = [], 0, 0
        for la, lo in sp:
            L, N = round(la * 1e5), round(lo * 1e5)
            flat += [L - pl, N - pn]; pl, pn = L, N
        out_chains.append([c["cls"], c["ow"], kix(c["key"]), [nix(n) for n in c["names"]],
                           sorted(to), flat])

    os.makedirs(a.out, exist_ok=True)
    fn = os.path.join(a.out, "roadgraph.min.json")
    doc = {"v": 2, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "attribution": "© OpenStreetMap contributors, ODbL 1.0",
           "fields": {"chain": ["類別(0國道1快速2省道3縣道4匝道5一般道路)", "單向", "道路", "名稱", "接續", "座標(1e5差分)"],
                      "exit": ["鏈", "沿路公尺", "方向", "交流道", "出口編號", "往", "lat", "lon"]},
           "keys": keys, "names": names, "chains": out_chains, "exits": exits}
    with open(fn, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))

    kb = os.path.getsize(fn) / 1024
    by_cls = defaultdict(int)
    for c in chains:
        by_cls[c["cls"]] += 1
    named = sum(1 for e in exits if e[3])
    L = ["# 分方向路網與出口", "", f"產生時間：{time.strftime('%Y-%m-%d %H:%M')}", "",
         "| 項目 | 數量 |", "|---|---|",
         f"| OSM 路段 | {len(ways):,} |", f"| 車道鏈 | {len(chains):,} |",
         *(f"| 　{['國道','快速道路','省道','縣道','匝道','一般道路（國道／高架旁）'][k]} | {v:,} |" for k, v in sorted(by_cls.items())),
         f"| 座標點（簡化後） | {sum(len(s) for s in simp_all):,} |",
         f"| 出口 | {len(exits):,} |", f"| 　有交流道名稱 | {named:,} |",
         f"| 檔案大小 | {kb:,.0f} KB |", "",
         "資料來源 © OpenStreetMap contributors，依 ODbL 1.0 授權。", ""]
    with open(os.path.join(a.out, "roadgraph.report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print("\n".join(L))
    if a.fail_under and len(exits) < a.fail_under:
        print(f"✗ 出口只有 {len(exits)} 個，低於門檻 {a.fail_under}")
        sys.exit(1)


if __name__ == "__main__":
    main()
