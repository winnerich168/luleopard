#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""geocode_tainan.py 的離線測試：把網路層換掉，驗證解析、快取、輸出與失敗處理。"""
import csv, json, os, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import geocode_tainan as G

ok = fail = 0
def t(name, cond, extra=None):
    global ok, fail
    if cond: ok += 1; print("  ✓", name)
    else:
        fail += 1
        print("  ✗", name, "" if extra is None else json.dumps(extra, ensure_ascii=False))

print("\n── 地址解析 ──")
CASES = [
    ("民族路二段與西門路口", "intersection", ["民族路二段", "西門路"]),
    ("安平路與金華路四段口", "intersection", ["安平路", "金華路四段"]),
    ("民權路、復興路交叉口", "intersection", ["民權路", "復興路"]),
    ("中華東路三段與東寧路口", "intersection", ["中華東路三段", "東寧路"]),
    ("中正南路123號", "address", None),
    ("中山路三段(南向)", "road", None),
    ("小東路 (西向)", "road", None),
    ("完全看不懂", None, None),
]
for text, kind, roads in CASES:
    p = G.parse_location(text)
    got = p["kind"] if p else None
    okk = got == kind and (roads is None or p.get("roads") == roads)
    t(f"{text} → {kind or '無法解析'}", okk, {"got": p})

print("\n── 方向註記要被去掉，不能污染路名 ──")
p = G.parse_location("中山路三段(南向)")
t("(南向) 已移除", p and p["q"] == "中山路三段", p)

print("\n── 全流程（網路層以假資料取代）──")
tmp = tempfile.mkdtemp()
try:
    recs = [
        {"行政區": "中西區", "設置位置": "民族路二段與西門路口", "拍攝行向": "東西雙向", "速限": "40"},
        {"行政區": "永康區", "設置位置": "中正南路123號", "拍攝行向": "南北雙向", "速限": "50"},
        {"行政區": "白河區", "設置位置": "查不到的地方路與不存在路口", "拍攝行向": "", "速限": "50"},
        {"行政區": "新營區", "設置位置": "無法辨識", "拍攝行向": "", "速限": "40"},
    ]
    src = os.path.join(tmp, "tainan.json")
    json.dump({"responseData": recs}, open(src, "w", encoding="utf-8"), ensure_ascii=False)

    calls = {"inter": 0, "nomi": 0}
    def fake_inter(roads, district):
        calls["inter"] += 1
        if roads[0] == "民族路二段":
            return {"lat": 22.9931, "lon": 120.1985, "method": "intersection"}
        return None                                   # 查不到 → 會退到 Nominatim
    def fake_nomi(text, district):
        calls["nomi"] += 1
        if "中正南路" in text:
            return {"lat": 23.0250, "lon": 120.2560, "method": "nominatim"}
        return None
    G.q_intersection, G.q_nominatim, G.SLEEP = fake_inter, fake_nomi, 0

    out = os.path.join(tmp, "dist")
    cache = os.path.join(tmp, "cache", "g.json")
    rc = G.main.__wrapped__ if hasattr(G.main, "__wrapped__") else G.main
    sys.argv = ["x", "--in", src, "--out", out, "--cache", cache]
    code = rc()
    t("正常結束", code == 0)

    rows = list(csv.DictReader(open(os.path.join(out, "tainan_geocoded.csv"), encoding="utf-8")))
    t("成功 2 筆", len(rows) == 2, [r["Address"] for r in rows])
    r0 = rows[0]
    t("路口策略座標正確", abs(float(r0["Latitude"]) - 22.9931) < 1e-6, r0)
    t("欄位是 build_speedcams 吃得下的格式",
      set(["CityName", "RegionName", "Address", "Longitude", "Latitude", "direct", "limit"])
      <= set(r0.keys()), list(r0.keys()))
    t("保留方向與速限", r0["direct"] == "東西雙向" and r0["limit"] == "40", r0)
    t("有標記使用的策略", r0["geocode_method"] == "intersection", r0)
    t("路口查不到會退回 Nominatim", calls["nomi"] >= 2, calls)

    md = open(os.path.join(out, "tainan_geocode.md"), encoding="utf-8").read()
    t("報告寫出成功率", "成功定位" in md and "50%" in md, md[:200])
    t("報告列出失敗清單", "失敗清單" in md and "無法辨識" in md)
    t("報告有標明座標是推算的", "不是官方公布值" in md)

    # ── 快取：第二次跑不應該再打 API ──
    before = dict(calls)
    code2 = rc()
    t("第二次執行完全走快取", calls == before, {"before": before, "after": calls})
    rows2 = list(csv.DictReader(open(os.path.join(out, "tainan_geocoded.csv"), encoding="utf-8")))
    t("快取後結果一致", len(rows2) == 2)

    # ── offline 模式 ──
    shutil.rmtree(os.path.dirname(cache))
    sys.argv = ["x", "--in", src, "--out", out, "--cache", cache, "--offline"]
    rc()
    rows3 = list(csv.DictReader(open(os.path.join(out, "tainan_geocoded.csv"), encoding="utf-8")))
    t("offline 且無快取 → 0 筆，但不會爆炸", len(rows3) == 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n" + "=" * 46)
print(f"通過 {ok}　失敗 {fail}")
print("=" * 46)
sys.exit(1 if fail else 0)
