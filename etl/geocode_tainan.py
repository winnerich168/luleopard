#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鹿豹 · 臺南地址轉座標
================================================================
臺南市的測速開放資料**沒有經緯度欄位**，只有像
「民族路二段與西門路口」這種文字位置，所以整份資料在合併時會被丟掉。
這支腳本把它補回來。

兩種策略，依序嘗試：

  ① 路口交會點（準確度最高）
     「A路與B路口」→ 用 Overpass 找臺南市內同時屬於 A 與 B 的節點，
     那就是真正的路口。這比一般地址查詢準得多，因為測速點本來就設在路口。

  ② Nominatim 全文查詢（退而求其次）
     整串地址丟給 OSM 的地理編碼服務。適合「XX路123號」這種門牌式描述。

所有查詢都有本機快取，重跑不會重複打 API。

    python3 geocode_tainan.py --in downloads/tainan.json
    python3 geocode_tainan.py --in downloads/tainan.json --offline   # 只用快取
    python3 geocode_tainan.py --dry-run                              # 只看會怎麼解析，不連網

輸出（預設 dist/）：
    tainan_geocoded.csv    可直接被 build_speedcams.py 吃的格式
    tainan_geocode.md      成功／失敗清單與使用的策略

⚠️ 使用他人的免費服務請節制：Nominatim 政策要求每秒最多 1 次且要帶可識別的
   User-Agent；Overpass 是志工營運。這支腳本預設每次查詢間隔 1.1 秒。
"""

import argparse, csv, json, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

UA = "luleopard-geocoder/0.7 (Taiwan speed camera alert; contact: your-email@example.com)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]

BBOX = (21.5, 118.0, 26.5, 122.5)          # 台灣範圍檢核
TAINAN_BBOX = (22.85, 119.95, 23.55, 120.70)

SLEEP = 1.1                                 # 每次外部查詢的間隔（秒）


# ────────────────────────────────────────────────────────────
# 地址解析
# ────────────────────────────────────────────────────────────
ROAD_TOKEN = r"[一-鿿0-9]{1,12}(?:路|街|大道|橋|線)(?:[一二三四五六七八九十]段)?"

def parse_location(text):
    """
    把設置位置拆成可查詢的形式。
    回傳 {'kind':'intersection','roads':[A,B]} 或 {'kind':'address','q':...} 或 None
    """
    if not text:
        return None
    t = re.sub(r"\s+", "", str(text))
    t = t.replace("（", "(").replace("）", ")")
    t = re.sub(r"\((?:南|北|東|西)?(?:向|往).*?\)", "", t)      # 去掉 (南向) 這種方向註記

    # ① 路口：A與B口 / A與B路口 / A、B口 / A和B交叉口
    m = re.search(r"(" + ROAD_TOKEN + r")\s*(?:與|和|、|及|\\/|交|接)\s*(" + ROAD_TOKEN + r")\s*(?:交叉)?(?:路)?口", t)
    if m:
        return {"kind": "intersection", "roads": [m.group(1), m.group(2)], "raw": t}

    # 「A路與B路」沒有「口」字，但兩個路名並列，實務上還是路口
    m = re.search(r"(" + ROAD_TOKEN + r")\s*(?:與|和|、|及)\s*(" + ROAD_TOKEN + r")", t)
    if m:
        return {"kind": "intersection", "roads": [m.group(1), m.group(2)], "raw": t}

    # ② 門牌：XX路二段123號
    m = re.search(r"(" + ROAD_TOKEN + r"\s*\d+號)", t)
    if m:
        return {"kind": "address", "q": m.group(1), "raw": t}

    # ③ 只有路名，最多只能定位到路，準確度差，仍然試
    m = re.search(r"(" + ROAD_TOKEN + r")", t)
    if m:
        return {"kind": "road", "q": m.group(1), "raw": t}

    return None


# ────────────────────────────────────────────────────────────
# 快取
# ────────────────────────────────────────────────────────────
class Cache:
    def __init__(self, path):
        self.path = path
        self.d = {}
        if os.path.exists(path):
            try:
                self.d = json.load(open(path, encoding="utf-8"))
            except Exception:                            # noqa: BLE001
                self.d = {}
        self.dirty = False

    def get(self, k):
        return self.d.get(k)

    def put(self, k, v):
        self.d[k] = v
        self.dirty = True

    def save(self):
        if not self.dirty:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        json.dump(self.d, open(self.path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


# ────────────────────────────────────────────────────────────
# 查詢
# ────────────────────────────────────────────────────────────
def http_json(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data,
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def q_intersection(roads, district):
    """找同時屬於兩條路的節點 = 路口"""
    a, b = roads
    area = f'area["name"="臺南市"]["admin_level"~"4|5|6"]->.tn;'
    q = f"""
[out:json][timeout:90];
{area}
way["name"="{a}"](area.tn)->.wa;
way["name"="{b}"](area.tn)->.wb;
node(w.wa)->.na;
node(w.wb)->.nb;
node.na.nb;
out center 5;
""".strip()
    last = None
    for ep in OVERPASS:
        try:
            data = http_json(ep, q.encode("utf-8"))
            for el in data.get("elements", []):
                lat, lon = el.get("lat"), el.get("lon")
                if lat is None:
                    c = el.get("center") or {}
                    lat, lon = c.get("lat"), c.get("lon")
                if lat is None:
                    continue
                if TAINAN_BBOX[0] <= lat <= TAINAN_BBOX[2] and TAINAN_BBOX[1] <= lon <= TAINAN_BBOX[3]:
                    return {"lat": lat, "lon": lon, "method": "intersection"}
            return None
        except Exception as e:                            # noqa: BLE001
            last = e
            time.sleep(3)
    if last:
        raise last
    return None


def q_nominatim(text, district):
    params = {"q": f"臺南市{district or ''}{text}", "format": "json", "limit": "3",
              "countrycodes": "tw", "accept-language": "zh-TW"}
    data = http_json(NOMINATIM + "?" + urllib.parse.urlencode(params))
    for r in data:
        lat, lon = float(r["lat"]), float(r["lon"])
        if TAINAN_BBOX[0] <= lat <= TAINAN_BBOX[2] and TAINAN_BBOX[1] <= lon <= TAINAN_BBOX[3]:
            return {"lat": lat, "lon": lon, "method": "nominatim",
                    "matched": r.get("display_name", "")[:80]}
    return None


# ────────────────────────────────────────────────────────────
def load_records(path):
    """接受臺南資料的 JSON 或 CSV。回傳 list[dict]。"""
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-8", "cp950"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        txt = raw.decode("utf-8", errors="replace")

    t = txt.lstrip()
    if t[:1] in "[{":
        obj = json.loads(t)
        if isinstance(obj, dict):
            for k in ("responseData", "data", "result", "records", "Data"):
                if isinstance(obj.get(k), list):
                    return obj[k]
            for v in obj.values():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    return v
            return [obj]
        return obj
    rows = list(csv.DictReader(txt.splitlines()))
    return rows


FIELD = {
    "loc": ["設置位置", "設置地點", "地點", "位置", "address", "Address"],
    "dist": ["行政區", "區", "鄉鎮", "轄區分局"],
    "dir": ["拍攝行向", "拍攝方向", "方向", "行向"],
    "lim": ["速限", "limit"],
    "id": ["編號", "Seq", "id"],
}


def pick(rec, key):
    for k in FIELD[key]:
        if k in rec and rec[k] not in (None, ""):
            return str(rec[k]).strip()
    return ""


def main():
    ap = argparse.ArgumentParser(description="把臺南測速資料的文字地址轉成座標")
    ap.add_argument("--in", dest="inp", default=os.path.join(HERE, "downloads", "tainan.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--cache", default=os.path.join(HERE, "cache", "geocode_tainan.json"))
    ap.add_argument("--offline", action="store_true", help="只用快取，不連網")
    ap.add_argument("--dry-run", action="store_true", help="只顯示地址會被怎麼解析，完全不連網")
    ap.add_argument("--limit", type=int, default=0, help="只處理前 N 筆（測試用）")
    a = ap.parse_args()

    if not os.path.exists(a.inp):
        print(f"✗ 找不到輸入檔 {a.inp}\n  請先從 https://data.gov.tw/dataset/139129 下載，"
              f"存成 downloads/tainan.json")
        return 1

    recs = load_records(a.inp)
    if a.limit:
        recs = recs[:a.limit]
    cache = Cache(a.cache)
    print(f"讀入 {len(recs)} 筆\n")

    out, fails, used = [], [], {"cache": 0, "intersection": 0, "nominatim": 0}
    for i, rec in enumerate(recs, 1):
        loc = pick(rec, "loc")
        district = pick(rec, "dist")
        parsed = parse_location(loc)

        if a.dry_run:
            kind = parsed["kind"] if parsed else "無法解析"
            detail = "＋".join(parsed["roads"]) if parsed and parsed["kind"] == "intersection" \
                else (parsed.get("q", "") if parsed else "")
            print(f"  {i:3d}. {loc[:34]:<34} → {kind:<12} {detail}")
            continue

        if not parsed:
            fails.append({"loc": loc, "why": "地址格式無法解析"})
            continue

        ck = json.dumps([district, parsed], ensure_ascii=False, sort_keys=True)
        hit = cache.get(ck)
        if hit is not None:
            if hit:
                used["cache"] += 1
                out.append((rec, loc, district, hit))
            else:
                fails.append({"loc": loc, "why": "先前查詢無結果（快取）"})
            continue

        if a.offline:
            fails.append({"loc": loc, "why": "offline 且快取沒有"})
            continue

        res = None
        try:
            if parsed["kind"] == "intersection":
                res = q_intersection(parsed["roads"], district)
                time.sleep(SLEEP)
            if not res:
                res = q_nominatim(parsed.get("q") or parsed["raw"], district)
                time.sleep(SLEEP)
        except Exception as e:                            # noqa: BLE001
            fails.append({"loc": loc, "why": f"查詢失敗 {type(e).__name__}: {e}"})
            cache.save()
            continue

        cache.put(ck, res or {})
        if res:
            used[res["method"]] = used.get(res["method"], 0) + 1
            out.append((rec, loc, district, res))
            print(f"  ✓ {i:3d}/{len(recs)} {loc[:30]:<30} {res['method']:<13} "
                  f"{res['lat']:.5f},{res['lon']:.5f}")
        else:
            fails.append({"loc": loc, "why": "查不到對應位置"})
            print(f"  ✗ {i:3d}/{len(recs)} {loc[:30]:<30} 查不到")
        if i % 20 == 0:
            cache.save()

    cache.save()
    if a.dry_run:
        print("\n（dry-run 模式，沒有連網也沒有輸出檔案）")
        return 0

    os.makedirs(a.out, exist_ok=True)
    csv_path = os.path.join(a.out, "tainan_geocoded.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["CityName", "RegionName", "Address", "Longitude", "Latitude",
                    "direct", "limit", "geocode_method"])
        for rec, loc, district, res in out:
            w.writerow(["臺南市", district, loc, f"{res['lon']:.6f}", f"{res['lat']:.6f}",
                        pick(rec, "dir"), pick(rec, "lim"), res["method"]])

    total = len(out) + len(fails)
    rate = 100 * len(out) / max(1, total)
    L = ["# 臺南測速點 geocoding 報告", "",
         f"產生時間：{time.strftime('%Y-%m-%d %H:%M:%S')}", "",
         "| 項目 | 數量 |", "|---|---|",
         f"| 輸入 | {total} |",
         f"| **成功定位** | **{len(out)}（{rate:.0f}%）** |",
         f"| 失敗 | {len(fails)} |", "",
         "## 使用的策略", "", "| 策略 | 筆數 |", "|---|---|",
         f"| 路口交會點（最準） | {used.get('intersection',0)} |",
         f"| Nominatim 全文查詢 | {used.get('nominatim',0)} |",
         f"| 快取命中 | {used.get('cache',0)} |", ""]
    if fails:
        L += ["## 失敗清單（需人工補）", "", "| 位置 | 原因 |", "|---|---|"]
        for x in fails[:200]:
            L.append(f"| {x['loc'][:50]} | {x['why'][:60]} |")
    L += ["", "---", "",
          "⚠️ **這些座標是推算的，不是官方公布值。** 路口交會點策略通常誤差在十幾公尺內，",
          "但 Nominatim 全文查詢可能落在路段中間而非實際設置點。",
          "建議在 App 內把這份來源的 priority 設低，官方有座標時以官方為準。", "",
          "資料來源：臺南市政府警察局（政府資料開放授權條款第1版）；",
          "座標來自 OpenStreetMap contributors（ODbL）。"]
    with open(os.path.join(a.out, "tainan_geocode.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")

    print("\n" + "=" * 58)
    print(f"成功 {len(out)} / {total}（{rate:.0f}%）　失敗 {len(fails)}")
    print(f"輸出：{csv_path}")
    print("=" * 58)
    return 0


if __name__ == "__main__":
    sys.exit(main())
