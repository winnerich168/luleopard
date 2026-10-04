# -*- coding: utf-8 -*-
"""
道路身分的正規化，build_roadgraph.py 與 tag_cam_roads.py 共用。

App 判斷「這支照相／這個出口是不是在我正在走的這條路上」靠的就是比對兩邊的 road_key，
所以兩支腳本一定要用同一套規則，不然同一條路會被當成兩條。

    road_refs({'highway':'motorway','ref':'1'})          → {'國1'}
    road_refs({'highway':'trunk','ref':'64'})            → {'台64'}
    road_refs({'highway':'primary','ref':'152;19'})      → {'縣152', '台19'}
    road_refs({'highway':'secondary','ref':'縣道110'})   → {'縣110'}
    road_key(tags) → '國1' / '國1+高架' / '台64' / '名:建國北路'
"""

import re

# OSM 上國道常只寫 ref=1，要看 highway 類別才知道是國道
_MOTORWAY = ("motorway", "motorway_link")


def _prov(num, suf):
    """省道與縣道編號不重疊（台1～台89、縣100 起），用號碼決定，不看 OSM 寫台還是縣、
    也不看 highway 類別 —— 同一條縣道常有一段標 primary、一段標 secondary，
    依類別判斷會被拆成兩條路。"""
    return ("台" if int(num) < 100 else "縣") + num + suf


def road_refs(tags):
    hw = tags.get("highway", "")
    out = set()
    for r in re.split(r"[;,]", tags.get("ref", "") or ""):
        r = r.strip().replace("臺", "台")
        if not r:
            continue
        m = re.match(r"^(?:國道?|N)\s*(\d+)\s*號?", r)
        if m:
            out.add("國" + m.group(1)); continue
        m = re.match(r"^(?:台|縣道?|市道?)\s*(\d+)\s*([甲乙丙丁戊己庚]?)", r)
        if m:
            out.add(_prov(m.group(1), m.group(2))); continue
        m = re.match(r"^(\d+)\s*([甲乙丙丁戊己庚]?)$", r)
        if m:
            out.add(("國" + m.group(1) + m.group(2)) if hw in _MOTORWAY else _prov(m.group(1), m.group(2)))
    return out


def is_elevated(tags):
    """五楊、汐五、市民大道、新生高架…：名稱有「高架」的路段。
    國1 與五楊高架在 OSM 上都是 ref=1、上下重疊，只有名稱分得出來。
    「安朔高架橋」這種只是一座橋，不是另一層道路，不算（不然台9線會被切成兩條路）；
    汐五高架有一段叫「中山高汐止五股高架橋」，例外處理。"""
    n = tags.get("name") or ""
    if "高架" not in n:
        return False
    return not n.endswith("高架橋") or "汐止五股" in n


def road_key(tags):
    refs = road_refs(tags)
    if refs:
        return "/".join(sorted(refs)) + ("+高架" if is_elevated(tags) else "")
    nm = (tags.get("name") or "").strip()
    return ("名:" + nm) if nm else ""
