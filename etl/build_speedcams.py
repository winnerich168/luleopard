#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鹿豹 · 全台測速點位合併腳本
================================================================
把散落在各機關的測速照相開放資料抓下來、正規化、去重，輸出成單一檔案給 App 用。

    python3 build_speedcams.py                 # 線上抓取
    python3 build_speedcams.py --offline       # 只用 downloads/ 內已下載的檔案
    python3 build_speedcams.py --only freeway,taipei
    python3 build_speedcams.py --out ../docs

輸出（預設 dist/）：
    speedcams.min.json   精簡格式 [[lat,lon,速限,方向,名稱],...] ← App 直接吃這個
    speedcams.geojson    標準 GeoJSON，含完整屬性與來源標註
    report.md            人看的報告：各來源筆數、去重、縣市覆蓋、失敗原因
    report.json          機器讀的同一份報告

只用 Python 標準函式庫，不需要 pip install。
"""

import argparse, csv, html, io, json, os, re, sys, time, zipfile
from html.parser import HTMLParser
import urllib.request, urllib.error, urllib.parse
from collections import defaultdict, OrderedDict
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
TPE = timezone(timedelta(hours=8))

# 政府網站對 python-urllib 的 UA 常直接回 403，帶一般瀏覽器 UA
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


# ──────────────────────────────────────────────────────────────
# 1. 取得原始位元組
# ──────────────────────────────────────────────────────────────
def safe_url(u):
    """
    把網址裡的非 ASCII 字元做百分比編碼。

    urllib 不會自己處理 —— 網址含中文就直接丟 UnicodeEncodeError。
    國道那份的檔名正是「1150720-國道公路固定式測速照相地點.zip」，
    所以整個國道資料源一直抓不到，錯誤訊息還是看不懂的
    「'ascii' codec can't encode characters」。
    """
    try:
        sp = urllib.parse.urlsplit(u)
        return urllib.parse.urlunsplit((
            sp.scheme, sp.netloc,
            urllib.parse.quote(sp.path, safe="/%~"),
            urllib.parse.quote(sp.query, safe="=&?/:%+,~"),
            urllib.parse.quote(sp.fragment, safe="/%~"),
        ))
    except Exception:                                   # noqa: BLE001
        return u


def http_get(url, timeout=60, retries=3):
    url = safe_url(url)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:                      # noqa: BLE001
            last = e
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise last


def local_candidates(src, downloads):
    """
    在 downloads/ 找對應這個來源的檔案。

    只接受檔名主體「完全等於 id」或「id 後面接 . 」（例如 taipei.csv、taipei.2026.csv）。
    刻意不做寬鬆的子字串比對 —— 否則 tainan 會把 tainan_geocoded.csv 也吃進去，
    兩個來源讀到同一個檔案，看起來像成功其實是錯的。
    """
    if not os.path.isdir(downloads):
        return []
    out = []
    sid = src["id"]
    for fn in sorted(os.listdir(downloads)):
        base, ext = os.path.splitext(fn)
        if ext.lower() not in (".csv", ".json", ".geojson", ".zip", ".txt", ".html", ".htm"):
            continue
        if base == sid or base.startswith(sid + "."):
            out.append(os.path.join(downloads, fn))
    return out


# ──────────────────────────────────────────────────────────────
# 2. 解碼
# ──────────────────────────────────────────────────────────────
def decode(raw, hint="auto"):
    order = ["utf-8-sig", "utf-8", "big5hkscs", "cp950", "big5"]
    if hint and hint != "auto":
        h = {"big5": "cp950", "utf-8": "utf-8-sig"}.get(hint.lower(), hint)
        order = [h] + [o for o in order if o != h]
    for enc in order:
        try:
            txt = raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        # 解出來若滿是替代字元，視為失敗
        if txt.count("�") > max(3, len(txt) * 0.002):
            continue
        return txt, enc
    return raw.decode("utf-8", errors="replace"), "utf-8(replace)"


# ──────────────────────────────────────────────────────────────
# 3. 欄位對照
# ──────────────────────────────────────────────────────────────
def _pat(*names):
    return [re.compile(n, re.I) for n in names]

COLS = {
    "lat":   _pat(r"^lat", r"latitude", r"座標緯", r"緯度", r"^y$"),
    "lon":   _pat(r"^lon", r"^lng", r"longitude", r"座標經", r"經度", r"^x$"),
    "limit": _pat(r"速限", r"limit"),
    "dir":   _pat(r"拍攝方向", r"拍攝行向", r"測照方向", r"^direct", r"方向", r"行向"),
    "addr":  _pat(r"設置地點", r"測照地點", r"設置位置", r"^address", r"地址",
                  r"設置地址", r"地點", r"路段", r"^name$", r"名稱", r"location"),
    "addr2": _pat(r"設置區域描述", r"設置地點_範圍", r"^備註$", r"remark"),
    "city":  _pat(r"cityname", r"設置縣市", r"^縣市$", r"^city"),
    "town":  _pat(r"^行政區$", r"regionname", r"設置市區鄉鎮", r"鄉鎮", r"^dist", r"轄區分局"),
    "kind":  _pat(r"取締項目", r"科技執法種類", r"測照型式", r"^型式$", r"violation"),
}


def match_cols(headers):
    """回傳 {語意名: 欄位索引}。同一語意取第一個命中的欄位。"""
    idx = {}
    for key, pats in COLS.items():
        for i, h in enumerate(headers):
            h = (h or "").strip()
            if not h:
                continue
            if any(p.search(h) for p in pats):
                idx.setdefault(key, i)
                break
    return idx


# ──────────────────────────────────────────────────────────────
# 4. 解析各種格式 → list[dict]（表格列）
# ──────────────────────────────────────────────────────────────
def rows_from_csv(text):
    text = text.lstrip("﻿")
    sample = text[:4096]
    delim = ","
    for cand in [",", "\t", ";", "|"]:
        if sample.count(cand) > sample.count(delim):
            delim = cand
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    rows = [r for r in rows if any((c or "").strip() for c in r)]
    if not rows:
        return [], []
    return rows[0], rows[1:]


def rows_from_json(obj):
    """接受 GeoJSON / list[dict] / {result:{records:[...]}} 等常見包裝。"""
    if isinstance(obj, dict):
        if obj.get("type") == "FeatureCollection":
            recs = []
            for f in obj.get("features") or []:
                p = dict(f.get("properties") or {})
                g = f.get("geometry") or {}
                if g.get("type") == "Point" and isinstance(g.get("coordinates"), list):
                    p.setdefault("longitude", g["coordinates"][0])
                    p.setdefault("latitude", g["coordinates"][1])
                recs.append(p)
            return recs
        # 已知包裝鍵優先
        for key in ("data", "result", "records", "results", "Data", "responseData",
                    "features", "items", "rows"):
            if key in obj:
                inner = obj[key]
                if isinstance(inner, dict):
                    return rows_from_json(inner)
                if isinstance(inner, list):
                    return [r for r in inner if isinstance(r, dict)]
        # 未知包裝：找出最像資料的那個值（dict 陣列，取最長的）
        best = None
        for v in obj.values():
            if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
                if best is None or len(v) > len(best):
                    best = v
            elif isinstance(v, dict):
                inner = rows_from_json(v)
                if len(inner) > 1 and (best is None or len(inner) > len(best)):
                    best = inner
        if best:
            return best
        return [obj]
    if isinstance(obj, list):
        return [r for r in obj if isinstance(r, dict)]
    return []


class _TableGrab(HTMLParser):
    """把 HTML 裡所有 <table> 抓成二維陣列。只用標準函式庫，不需要 BeautifulSoup。"""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self._t, self._r, self._c, self._depth = [], None, None, None, 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            if self._depth == 1:
                self._t = []
        elif self._t is not None and tag == "tr":
            self._r = []
        elif self._t is not None and tag in ("td", "th"):
            self._c = []

    def handle_data(self, d):
        if self._c is not None:
            self._c.append(d)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._c is not None:
            txt = re.sub(r"\s+", " ", "".join(self._c)).strip()
            if self._r is not None:
                self._r.append(txt)
            self._c = None
        elif tag == "tr" and self._r is not None:
            if any(self._r):
                self._t.append(self._r)
            self._r = None
        elif tag == "table":
            if self._depth == 1 and self._t:
                self.tables.append(self._t)
                self._t = None
            self._depth = max(0, self._depth - 1)


def tables_from_html(text):
    """回傳頁面上所有表格；<br> 先換成空白免得欄位黏在一起。"""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", " ", text)
    p = _TableGrab()
    try:
        p.feed(text)
    except Exception:                                   # noqa: BLE001
        pass
    return p.tables


def html_to_rows(text):
    """
    從 HTML 頁面挑出「看起來像測速點清單」的表格 —— 也就是同時有經度與緯度欄位的。
    新竹市警察局那頁把科技執法／固定式／移動式拆成三張表，所以要全部合併。
    """
    best_header, rows = None, []
    for tb in tables_from_html(text):
        if len(tb) < 2:
            continue
        hdr = tb[0]
        idx = match_cols(hdr)
        if "lat" not in idx or "lon" not in idx:
            continue
        if best_header is None:
            best_header = hdr
            rows.extend(tb[1:])
        elif hdr == best_header:
            rows.extend(tb[1:])
        else:
            # 欄位不同的表格：各自正規化後再合併會比較麻煩，
            # 這裡改成把它的資料列對齊到第一張表的欄位順序
            m2 = match_cols(hdr)
            order = [m2.get(k, -1) for k in best_header and match_cols(best_header)]
            for r in tb[1:]:
                rows.append([r[i] if 0 <= i < len(r) else "" for i in order])
    return (best_header or []), rows


def dicts_to_table(recs):
    keys = []
    for r in recs:
        for k in r.keys():
            if k not in keys:
                keys.append(k)
    return keys, [[("" if r.get(k) is None else str(r.get(k))) for k in keys] for r in recs]


# ──────────────────────────────────────────────────────────────
# 5. 表格 → 正規化點位
# ──────────────────────────────────────────────────────────────
NUM = re.compile(r"-?\d+(?:\.\d+)?")
# 兩個小數點以上 = 很可能是兩個數字黏在一起（實際遇過：經度欄位寫成 "121.6219225.03584"）
MALFORMED = re.compile(r"^-?\d+\.\d+\.\d")

def num(v, stats=None, field=None):
    if v is None:
        return None
    t = str(v).replace(",", "").strip()
    if stats is not None and MALFORMED.match(t):
        # 只取第一個合法數字，但要記下來 —— 這種錯誤靜靜吞掉最危險
        stats["malformed_coords"] = stats.get("malformed_coords", 0) + 1
        stats.setdefault("malformed_samples", []).append(f"{field}={t}")
    m = NUM.search(t)
    return float(m.group()) if m else None


def normalize(headers, rows, src, bbox, stats):
    idx = match_cols(headers)
    if "lat" not in idx or "lon" not in idx:
        stats["no_coords"] += len(rows)
        stats["reason"] = "找不到經緯度欄位（欄位為：%s）" % ", ".join(
            (h or "").strip() for h in headers if (h or "").strip())[:300]
        return []

    (lo_lat, hi_lat), (lo_lon, hi_lon) = bbox["lat"], bbox["lon"]
    out = []
    for row in rows:
        def cell(key):
            i = idx.get(key, -1)
            return (row[i].strip() if 0 <= i < len(row) and row[i] is not None else "")

        lat = num(cell("lat"), stats, "lat")
        lon = num(cell("lon"), stats, "lon")
        if lat is None or lon is None:
            stats["bad_coords"] += 1
            continue
        # 有些資料把經緯度寫反，能救就救
        if not (lo_lat <= lat <= hi_lat) and (lo_lat <= lon <= hi_lat) and (lo_lon <= lat <= hi_lon):
            lat, lon = lon, lat
            stats["swapped"] += 1
        if not (lo_lat <= lat <= hi_lat and lo_lon <= lon <= hi_lon):
            stats["out_of_bbox"] += 1
            continue

        lim = num(cell("limit"))
        lim = int(lim) if lim and 0 < lim <= 130 else 0
        direction = cell("dir")
        kind = cell("kind")
        addr = cell("addr") or cell("addr2")
        name = " ".join(x for x in [cell("city"), cell("town"), addr] if x)
        name = re.sub(r"\s+", " ", name).strip() or "測速點"
        # 來源若在註冊表宣告了 county，且名稱裡看不出縣市，就補上（六都的資料常省略縣市欄）
        default_county = src.get("county")
        if default_county and not COUNTY_RE.search(name):
            name = default_county + " " + name

        section = bool(re.search(r"區間", direction + kind + name))
        if section and "區間" not in direction:
            direction = (direction + "(區間測速)") if direction else "區間測速"

        out.append({
            "lat": round(lat, 6), "lon": round(lon, 6),
            "limit": lim, "direction": direction, "name": name,
            "kind": kind, "section": section,
            "source": src["id"], "source_name": src["name"],
            "agency": src.get("agency", ""), "priority": src.get("priority", 99),
        })
    stats["parsed"] = len(out)
    return out


# ──────────────────────────────────────────────────────────────
# 6. 取得一個來源的所有點位（含 ZIP 遞迴）
# ──────────────────────────────────────────────────────────────
def payload_to_points(raw, src, bbox, stats, depth=0):
    """raw bytes → 點位。自動判斷 ZIP / JSON / CSV。"""
    if depth > 2:
        return []
    if raw[:2] == b"PK":                                    # ZIP
        pts = []
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for info in z.infolist():
                n = info.filename
                if info.is_dir() or n.startswith("__MACOSX") or os.path.basename(n).startswith("."):
                    continue
                if not re.search(r"\.(csv|json|geojson|txt|html?)$", n, re.I):
                    continue
                stats["zip_members"].append(n)
                pts += payload_to_points(z.read(info), src, bbox, stats, depth + 1)
        return pts

    text, enc = decode(raw, src.get("encoding", "auto"))
    stats["encoding"] = enc
    stripped = text.lstrip()
    if stripped[:1] in "{[":
        try:
            recs = rows_from_json(json.loads(stripped))
            headers, rows = dicts_to_table(recs)
            return normalize(headers, rows, src, bbox, stats)
        except json.JSONDecodeError:
            pass                                            # 掉回 CSV 處理

    # HTML 頁面（例如新竹市警察局那張表）
    looks_html = re.search(r"(?i)<html|<!doctype", stripped[:2000])
    if looks_html and re.search(r"(?is)<table[\s>]", stripped[:200000]):
        headers, rows = html_to_rows(text)
        if headers and rows:
            stats["from_html"] = len(rows)
            return normalize(headers, rows, src, bbox, stats)
    if looks_html:
        # 掉到 CSV 分支的話，表頭會變成「<!DOCTYPE html>」，錯誤訊息完全看不懂。
        # 網頁改版（改成 JS 動態載入、或網址變成錯誤頁）就是長這樣，直接講清楚。
        raise ValueError("抓回來的是 HTML 網頁而不是資料檔，且頁面裡沒有可解析的表格 —— "
                         "來源網址可能已失效或改版，請到來源頁面重新取得下載網址")

    headers, rows = rows_from_csv(text)
    if not headers:
        return []
    # 雙表頭：第 2 列若一格也解不出數字座標，且看起來像欄位說明，就丟掉
    if rows:
        idx = match_cols(headers)
        li, oi = idx.get("lat", -1), idx.get("lon", -1)
        first = rows[0]
        def blank(i):
            return not (0 <= i < len(first)) or num(first[i]) is None
        if li >= 0 and oi >= 0 and blank(li) and blank(oi):
            stats["dropped_header_row"] = first[:4]
            rows = rows[1:]
    return normalize(headers, rows, src, bbox, stats)


def load_source(src, bbox, offline, downloads, cache_dir, no_fallback=False):
    stats = {"parsed": 0, "bad_coords": 0, "out_of_bbox": 0, "no_coords": 0,
             "swapped": 0, "zip_members": [], "encoding": None, "origin": None,
             "reason": None, "dropped_header_row": None, "from_html": 0,
             "malformed_coords": 0, "malformed_samples": []}

    # 順序很重要。downloads/ 裡放的可能是使用者手動下載的檔，也可能是很小的測試
    # 樣本檔 —— 如果本機檔優先，CI 就會安靜地拿測試樣本當成正式資料建出來，
    # 而且看起來完全成功。所以：能連網時一律以網路為準，本機檔只當備援，
    # 而且用到備援一定要在報告裡標出來。
    files = [("file", p) for p in local_candidates(src, downloads)]
    urls = [("url", u) for u in src.get("urls", [])]
    if offline:
        attempts = files
    elif no_fallback:
        # no-fallback 的用意是「網路失敗時不要偷偷拿本機舊檔頂替」，
        # 不是「不准用本機來源」。像 tainan_geocoded 這種本來就沒有網址、
        # 只由 geocode_tainan.py 在本機產生的來源，仍然要讀得到。
        attempts = urls if urls else files
    else:
        attempts = urls + files
    stats["fallback_available"] = bool(files) and not offline and not no_fallback

    if not attempts:
        stats["reason"] = ("offline 模式但 downloads/ 內沒有對應檔案（檔名需為 %s.csv / %s.zip …）"
                           % (src["id"], src["id"])) if offline else "這個來源沒有登記任何網址"
        return [], stats

    errors = []
    for how, loc in attempts:
        try:
            raw = (open(loc, "rb").read() if how == "file"
                   else http_get(loc, timeout=src.get("timeout", 60)))
            if not raw:
                raise ValueError("空回應")
            pts = payload_to_points(raw, src, bbox, stats)
            if not pts:
                raise ValueError(stats.get("reason") or "解析不到有效點位")
            stats["origin"] = ("檔案 " + os.path.basename(loc)) if how == "file" else loc
            # 連得上網卻還是退回本機檔 = 所有網址都失敗了。資料可能是舊的，
            # 甚至可能是測試樣本，一定要講出來，不能讓它看起來像正常成功。
            stats["used_fallback"] = (how == "file" and not offline)
            if how == "url" and cache_dir:
                os.makedirs(cache_dir, exist_ok=True)
                ext = ".zip" if raw[:2] == b"PK" else (".json" if raw.lstrip()[:1] in b"{[" else ".csv")
                with open(os.path.join(cache_dir, src["id"] + ext), "wb") as f:
                    f.write(raw)
            return pts, stats
        except Exception as e:                              # noqa: BLE001
            errors.append("%s → %s: %s" % (loc[:90], type(e).__name__, e))
    stats["reason"] = " | ".join(errors)[:600]
    return [], stats


# ──────────────────────────────────────────────────────────────
# 7. 空間去重
# ──────────────────────────────────────────────────────────────
def dedupe(points, meters):
    """同一顆測速桿常被兩個機關公布在略有差異的座標上，用網格做鄰近合併。
    保留 priority 較小者；資訊較完整者（有速限/方向）優先。"""
    deg = meters / 111_320.0
    grid = defaultdict(list)
    kept, merged = [], 0

    def score(p):
        return (p["priority"], 0 if p["limit"] else 1, 0 if p["direction"] else 1, -len(p["name"]))

    for p in sorted(points, key=score):
        gx, gy = int(p["lat"] / deg), int(p["lon"] / deg)
        dup = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in grid[(gx + dx, gy + dy)]:
                    # 同一點但方向不同視為不同設備（雙向各一支）
                    if q["direction"] and p["direction"] and q["direction"] != p["direction"]:
                        continue
                    if abs(q["lat"] - p["lat"]) <= deg and abs(q["lon"] - p["lon"]) <= deg:
                        dup = q
                        break
                if dup:
                    break
            if dup:
                break
        if dup:
            merged += 1
            dup.setdefault("also_in", [])
            if p["source"] not in dup["also_in"] and p["source"] != dup["source"]:
                dup["also_in"].append(p["source"])
            if not dup["limit"] and p["limit"]:
                dup["limit"] = p["limit"]
            if not dup["direction"] and p["direction"]:
                dup["direction"] = p["direction"]
            dup["section"] = dup["section"] or p["section"]
            continue
        grid[(gx, gy)].append(p)
        kept.append(p)
    return kept, merged


# ──────────────────────────────────────────────────────────────
# 8. 輸出
# ──────────────────────────────────────────────────────────────
COUNTY_RE = re.compile(r"(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|"
                       r"基隆市|新竹市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|"
                       r"屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)")
CANON = {"台北市": "臺北市", "台中市": "臺中市", "台南市": "臺南市", "台東縣": "臺東縣"}


def county_of(p):
    m = COUNTY_RE.search(p["name"])
    if not m:
        return None
    return CANON.get(m.group(1), m.group(1))


def write_outputs(points, per_source, cfg, outdir, merged, started):
    os.makedirs(outdir, exist_ok=True)
    points.sort(key=lambda p: (p["lat"], p["lon"]))

    # 精簡格式：App 的匯入層直接吃 [[lat,lon,速限,方向,名稱],...]
    mini = [[p["lat"], p["lon"], p["limit"], p["direction"], p["name"]] for p in points]
    with open(os.path.join(outdir, "speedcams.min.json"), "w", encoding="utf-8") as f:
        json.dump(mini, f, ensure_ascii=False, separators=(",", ":"))

    gj = {"type": "FeatureCollection",
          "name": "taiwan-speed-cameras",
          "generated": datetime.now(TPE).isoformat(timespec="seconds"),
          "license": "政府資料開放授權條款-第1版",
          "attribution": sorted({s["agency"] for s in cfg["sources"] if s.get("agency")}),
          "features": [{
              "type": "Feature",
              "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
              "properties": {k: v for k, v in p.items() if k not in ("lat", "lon", "priority")},
          } for p in points]}
    with open(os.path.join(outdir, "speedcams.geojson"), "w", encoding="utf-8") as f:
        json.dump(gj, f, ensure_ascii=False)

    by_county = defaultdict(int)
    for p in points:
        by_county[county_of(p) or "（無法判斷）"] += 1
    missing = [c for c in cfg["all_counties"] if not by_county.get(c)]

    report = {
        "generated": datetime.now(TPE).isoformat(timespec="seconds"),
        "elapsed_sec": round(time.time() - started, 1),
        "total_points": len(points),
        "merged_duplicates": merged,
        "sections": sum(1 for p in points if p["section"]),
        "with_speed_limit": sum(1 for p in points if p["limit"]),
        "with_direction": sum(1 for p in points if p["direction"]),
        "sources": per_source,
        "by_county": OrderedDict(sorted(by_county.items(), key=lambda kv: -kv[1])),
        "missing_counties": missing,
    }
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    ok = [s for s in per_source if s["points"] > 0]
    bad = [s for s in per_source if s["points"] == 0]
    L = ["# 鹿豹 · 測速點位合併報告", "",
         "產生時間：%s（耗時 %.1fs）" % (report["generated"], report["elapsed_sec"]), "",
         "## 總覽", "",
         "| 項目 | 數量 |", "|---|---|",
         "| **合併後總點數** | **%d** |" % len(points),
         "| 跨來源重複合併 | %d |" % merged,
         "| 區間測速 | %d |" % report["sections"],
         "| 有速限資訊 | %d (%.0f%%) |" % (report["with_speed_limit"],
                                        100 * report["with_speed_limit"] / max(1, len(points))),
         "| 有方向資訊 | %d (%.0f%%) |" % (report["with_direction"],
                                        100 * report["with_direction"] / max(1, len(points))),
         "| 成功來源 | %d / %d |" % (len(ok), len(per_source)), "",
         "## 各來源", "",
         "| 來源 | 分類 | 點數 | 編碼 | 取得方式 |", "|---|---|---|---|---|"]
    for s in per_source:
        L.append("| %s | %s | %s | %s | %s |" % (
            s["name"], s["group"], s["points"] or "—",
            s.get("encoding") or "—", (s.get("origin") or "**失敗**")[:70]))
    fb = [s for s in per_source if s.get("used_fallback")]
    if fb:
        L += ["", "### ⚠️ 用了本機備援檔（不是即時抓取）", "",
              "以下來源的所有網址都失敗了，改用 `downloads/` 內既有的檔案。",
              "**這些資料可能已經過期，也可能只是測試樣本。**", ""]
        for s in fb:
            L.append("- **%s**：%s（%d 點）" % (s["name"], s.get("origin"), s["points"]))
        L.append("")
    mal = [s for s in per_source if s.get("malformed_coords")]
    if mal:
        L += ["", "### ⚠️ 座標格式異常（原始資料的錯誤，已取第一個合法數字）", ""]
        for s in mal:
            L.append("- **%s**：%d 筆　例：`%s`" %
                     (s["name"], s["malformed_coords"], "`、`".join(s["malformed_samples"])))
        L.append("")
    if bad:
        L += ["", "### 失敗的來源", ""]
        for s in bad:
            L += ["- **%s**：%s" % (s["name"], s.get("reason") or "不明"), ""]
    L += ["", "## 縣市覆蓋", "", "| 縣市 | 點數 |", "|---|---|"]
    for c, n in report["by_county"].items():
        L.append("| %s | %d |" % (c, n))
    if missing:
        L += ["", "> ⚠️ **完全沒有資料的縣市（%d 個）**：%s" % (len(missing), "、".join(missing)),
              ">", "> 這些縣市不是腳本漏抓，是政府端根本沒有以開放資料形式發布可用的座標檔。",
              "> 只能靠使用者回報補齊，或人工從各警局公告整理。"]
    L += ["", "---", "",
          "資料來源：" + "、".join(sorted({s["agency"] for s in cfg["sources"] if s.get("agency")})),
          "", "依「政府資料開放授權條款第1版」使用。"]
    with open(os.path.join(outdir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    return report


# ──────────────────────────────────────────────────────────────
# 9. main
# ──────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="合併全台測速照相開放資料")
    ap.add_argument("--config", default=os.path.join(HERE, "sources.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--downloads", default=os.path.join(HERE, "downloads"),
                    help="手動下載的檔案放這裡，檔名取來源 id（例如 freeway.zip）")
    ap.add_argument("--cache", default=os.path.join(HERE, "cache"))
    ap.add_argument("--offline", action="store_true", help="完全不連網，只用 downloads/")
    ap.add_argument("--no-fallback", action="store_true",
                    help="網路抓不到時不要退回 downloads/ 的既有檔案。"
                         "CI 正式建置請開這個 —— 否則某個來源掛掉時會安靜地"
                         "拿測試樣本檔頂替，看起來像成功。")
    ap.add_argument("--only", help="只跑這些來源 id，逗號分隔")
    ap.add_argument("--fail-under", type=int, default=0,
                    help="合併後點數低於此值就以非 0 結束（給 CI 當守門員）")
    a = ap.parse_args()

    started = time.time()
    cfg = json.load(open(a.config, encoding="utf-8"))
    srcs = cfg["sources"]
    if a.only:
        want = {x.strip() for x in a.only.split(",")}
        srcs = [s for s in srcs if s["id"] in want]

    all_pts, per_source = [], []
    for s in srcs:
        print("→ %-18s %s" % (s["id"], s["name"]), flush=True)
        pts, st = load_source(s, cfg["bbox"], a.offline, a.downloads, a.cache, a.no_fallback)
        all_pts += pts
        per_source.append({
            "id": s["id"], "name": s["name"], "group": s["group"],
            "points": len(pts), "encoding": st["encoding"], "origin": st["origin"],
            "reason": st["reason"], "bad_coords": st["bad_coords"],
            "out_of_bbox": st["out_of_bbox"], "no_coords": st["no_coords"],
            "swapped": st["swapped"], "zip_members": st["zip_members"],
            "dropped_header_row": st["dropped_header_row"], "from_html": st["from_html"],
            "malformed_coords": st.get("malformed_coords", 0),
            "malformed_samples": st.get("malformed_samples", [])[:5],
            "page": s.get("page"),
        })
        if pts:
            extra = []
            if st["out_of_bbox"]:
                extra.append("界外 %d" % st["out_of_bbox"])
            if st["bad_coords"]:
                extra.append("壞座標 %d" % st["bad_coords"])
            if st["swapped"]:
                extra.append("經緯互換 %d" % st["swapped"])
            if st.get("malformed_coords"):
                extra.append("⚠ 座標格式異常 %d" % st["malformed_coords"])
            if st.get("used_fallback"):
                extra.append("⚠ 網路來源全部失敗，用了本機備援檔（資料可能過期）")
            print("   ✓ %d 點 [%s]%s" % (len(pts), st["encoding"],
                                        ("  " + "、".join(extra)) if extra else ""))
        else:
            print("   ✗ 失敗：%s" % (st["reason"] or "不明")[:160])

    kept, merged = dedupe(all_pts, cfg.get("dedupe_meters", 25))
    rep = write_outputs(kept, per_source, cfg, a.out, merged, started)

    print("\n" + "=" * 58)
    print("合併後 %d 點（去重 %d）｜區間測速 %d｜有速限 %d"
          % (rep["total_points"], merged, rep["sections"], rep["with_speed_limit"]))
    if rep["missing_counties"]:
        print("⚠️  完全沒資料的縣市（%d）：%s"
              % (len(rep["missing_counties"]), "、".join(rep["missing_counties"])))
    print("輸出：%s" % os.path.abspath(a.out))
    print("=" * 58)

    if rep["total_points"] < a.fail_under:
        print("::error::點數 %d 低於門檻 %d，不更新" % (rep["total_points"], a.fail_under))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
