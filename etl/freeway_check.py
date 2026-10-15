# -*- coding: utf-8 -*-
"""
鹿豹 · 國道照相座標檢查
================================================================
實地回報（2026-10，新店→南崁）：警政署資料裡有幾支國道照相的座標根本不在那條國道上，
例如「國道一號南向35.56公里」的座標在國2 機場系統旁、「南向26.8公里」在南崁交流道旁的巷子、
「南向279公里」在台北市忠孝東路。App 會在錯的地方唸「前方有測速照相」。

照相名稱寫了「國道N號」，就拿分方向路網（docs/data/roadgraph.min.json）量它離國道 N 的
中心線有多遠；超過 MAX_OFF_M 就當作座標錯誤，不放進輸出，並列在報告裡。
匝道上的照相（名稱有「匝道」「交流道」「系統」）離主線本來就有一段距離，不檢查。
路網檔不存在時整個略過（不要因為少了路網就把國道照相全刪掉）。

只用 Python 標準函式庫。
"""
import json, math, os, re

MAX_OFF_M = 300
CN = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
RAMP_RE = re.compile(r'匝道|交流道|系統|轉接道|服務區')


def freeway_no(name):
    m = re.search(r'國道([一二三四五六七八九十]{1,3}|\d{1,2})號', name or '')
    if not m:
        return None
    s = m.group(1)
    if s.isdigit():
        return int(s)
    if len(s) == 1:
        return CN[s]
    if s[0] == '十':
        return 10 + CN[s[1]]
    if len(s) == 2:
        return CN[s[0]] * 10
    return CN[s[0]] * 10 + CN[s[2]]


def load_lines(path):
    """國道 N → [[(lat,lon),...], ...]（只取主線，不含匝道）"""
    g = json.load(open(path, encoding='utf-8'))
    keys, lines = g['keys'], {}
    for c in g['chains']:
        if c[0] != 0:
            continue
        k = keys[c[2]] if c[2] is not None and c[2] < len(keys) else ''
        f, pts, la, lo = c[5], [], 0, 0
        for i in range(0, len(f), 2):
            la += f[i]; lo += f[i + 1]
            pts.append((la / 1e5, lo / 1e5))
        for r in re.sub(r'\+高架$', '', k).split('/'):
            m = re.fullmatch(r'國(\d+)', r)
            if m:
                lines.setdefault(int(m.group(1)), []).append(pts)
    return lines


def off_road_m(lat, lon, lines):
    """點到這些線的最短距離（公尺）；3 公里內都沒有線就回傳 inf"""
    cl = math.cos(math.radians(lat))
    best = float('inf')
    for pts in lines:
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            if abs(a[0] - lat) > 0.03 or abs(a[1] - lon) > 0.03:
                continue
            ax, ay = (a[1] - lon) * cl * 111320, (a[0] - lat) * 111320
            bx, by = (b[1] - lon) * cl * 111320, (b[0] - lat) * 111320
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            t = 0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
            best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def check(points, roadgraph_path):
    """回傳 (保留的點, 剔除的點[{name,lat,lon,off_m}])；points 是 build_speedcams 的 dict 格式"""
    if not os.path.exists(roadgraph_path):
        return points, []
    lines = load_lines(roadgraph_path)
    kept, dropped = [], []
    for p in points:
        n = freeway_no(p.get('name'))
        if n is None or n not in lines or RAMP_RE.search(p.get('name') or ''):
            kept.append(p); continue
        off = off_road_m(p['lat'], p['lon'], lines[n])
        if off > MAX_OFF_M:
            dropped.append({'name': p['name'], 'lat': p['lat'], 'lon': p['lon'],
                            'off_m': None if off == float('inf') else round(off),
                            'source': p.get('source', '')})
        else:
            kept.append(p)
    return kept, dropped
