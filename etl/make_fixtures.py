#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""造出模擬各來源真實怪癖的假檔案，用來測試 build_speedcams.py。
每一份都刻意重現一個實際踩到的坑。"""
import json, os, zipfile, io

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
os.makedirs(OUT, exist_ok=True)

# ① 國道：ZIP + 「座標緯度/座標經度」+ 取締項目寫「區間超速」+ __MACOSX 雜項
freeway = "\n".join([
    "設備編號,型式,縣市,行政區,設置區域描述,設置地點,取締項目,座標緯度,座標經度,拍攝方向,速限,管轄單位,備註",
    "N1-001,固定式,桃園市,蘆竹區,國道1號南下,國道1號南下 47.5K,超速,25.048611,121.290833,南下,100,國道公路警察局第一大隊,",
    "N1-002,固定式,臺中市,后里區,國道1號北上,國道1號北上 168.2K,超速,24.309722,120.712500,北上,100,國道公路警察局第三大隊,",
    "N3-014,固定式,新北市,土城區,國道3號南下,國道3號南下 42.1K,超速,24.972222,121.435000,南下,100,國道公路警察局第二大隊,",
    "N5-003,區間測速,宜蘭縣,頭城鎮,雪山隧道,國道5號南下 15K-28K,區間超速,24.916667,121.716667,南下,90,國道公路警察局第九大隊,雪隧",
    "BAD,固定式,測試,測試,壞,壞,超速,not-a-number,also-bad,南下,100,測試,",
    "OUT,固定式,境外,境外,境外,境外,超速,40.700000,-73.900000,南下,100,測試,",
])
with zipfile.ZipFile(os.path.join(OUT, "freeway.zip"), "w") as z:
    z.writestr("1150720-國道公路固定式測速照相地點.csv", freeway.encode("utf-8"))
    z.writestr("__MACOSX/._junk", b"junk")
    z.writestr("readme.txt", "這不是資料檔".encode("utf-8"))

# ② 警政署縣道：UTF-8 + 雙表頭（第2列是中文說明）
npa = "\n".join([
    "CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit",
    "設置縣市,設置市區鄉鎮,設置地址,管轄警局,管轄分局,經度,緯度,拍攝方向,速限",
    "宜蘭縣,宜蘭市,台9線78k中山路五段南下,宜蘭縣政府警察局,宜蘭分局,121.75933,24.778543,南北雙向,60",
    "宜蘭縣,頭城鎮,台9線68k+600m至56k+600m,宜蘭縣政府警察局,礁溪分局,121.79389,24.849024,南北雙向(區間測速),40",
    "新竹縣,竹北市,中華路與興隆路口,新竹縣政府警察局,竹北分局,120.99740,24.825920,南北雙向,50",
    "彰化縣,員林市,中山路二段,彰化縣政府警察局,員林分局,120.57200,23.959000,東西雙向,50",
])
open(os.path.join(OUT, "npa_counties.csv"), "w", encoding="utf-8").write(npa)

# ③ 臺北市：Big5 編碼
taipei = "\n".join([
    "編號,地點,緯度,經度,分類,速限,方向",
    "1,市民大道四段西向,25.045000,121.545000,固定式,50,西向",
    "2,基隆路一段北向,25.032000,121.565000,固定式,50,北上方向",
    "3,自強隧道區間測速,25.093000,121.548000,區間測速,50,南北雙向",
])
open(os.path.join(OUT, "taipei.csv"), "w", encoding="cp950").write(taipei)

# ④ 新北市：JSON 陣列，欄名小寫，區間測速寫在 direct 欄
ntpc = [
    {"cityname": "新北市", "regionname": "板橋區", "address": "縣民大道二段",
     "deptnm": "新北市政府警察局", "branchnm": "板橋分局",
     "longitude": "121.462000", "latitude": "25.013000", "direct": "東西雙向", "limit": "50"},
    {"cityname": "新北市", "regionname": "新店區", "address": "台9線北宜路二段",
     "deptnm": "新北市政府警察局", "branchnm": "新店分局",
     "longitude": "121.542000", "latitude": "24.958000", "direct": "區間測速", "limit": "40",
     "violation types": None},
    # 與國道 N3-014 只差 12 公尺，測跨來源去重
    {"cityname": "新北市", "regionname": "土城區", "address": "國道3號南下 42.1K 附近",
     "longitude": "121.435100", "latitude": "24.972300", "direct": "南下", "limit": ""},
]
open(os.path.join(OUT, "newtaipei.json"), "w", encoding="utf-8").write(
    json.dumps(ntpc, ensure_ascii=False))

# ⑤ 桃園市：Big5 + 座標緯度在前
tycg = "\n".join([
    "設備編號,型式,縣市,行政區,設置區域描述,設置地點_路口或路段,取締項目,座標緯度,座標經度,拍攝方向,速限,管轄單位,備註",
    "TY-01,固定式,桃園市,中壢區,中華路,中華路一段與環中東路口,超速,24.968000,121.223000,南北雙向,50,桃園市政府警察局,",
    "TY-02,區間測速,桃園市,大溪區,台7線,台7線 4K-9K,區間超速,24.855000,121.290000,南北雙向,50,桃園市政府警察局,",
])
open(os.path.join(OUT, "taoyuan.csv"), "w", encoding="cp950").write(tycg)

# ⑥ 高雄111年：「座標緯N度」「座標經E度」這種怪欄名，包在 {"data":[...]} 裡
kh = {"data": [
    {"Seq": 1, "編號": "KH-01", "型式": "固定式", "測照地點": "中正一路與自由路口",
     "測照方向": "東西雙向", "速限": "50", "行政區": "苓雅區", "測照型式": "測速",
     "座標緯N度": "22.628000", "座標經E度": "120.320000"},
    {"Seq": 2, "編號": "KH-02", "型式": "區間測速", "測照地點": "台17線 15K-20K",
     "測照方向": "南北雙向", "速限": "60", "行政區": "梓官區", "測照型式": "區間測速",
     "座標緯N度": "22.760000", "座標經E度": "120.264000"},
]}
open(os.path.join(OUT, "kaohsiung_111.json"), "w", encoding="utf-8").write(
    json.dumps(kh, ensure_ascii=False))

# ⑦ 高雄109年：與 111 年同一支桿子（相距約 8m），測去重時 priority 較低者被合併
kh109 = "\n".join([
    "Seq,設置縣市,設置市區鄉鎮,設置地址,管轄警局,管轄分局,經度,緯度,拍攝方向,速限",
    "1,高雄市,苓雅區,中正一路與自由路口,高雄市政府警察局,苓雅分局,120.320080,22.628000,東西雙向,50",
    "2,高雄市,鳳山區,建國路三段,高雄市政府警察局,鳳山分局,120.356000,22.627000,南北雙向,40",
])
open(os.path.join(OUT, "kaohsiung_109.csv"), "w", encoding="utf-8").write(kh109)

# ⑧ 臺南市：真實的坑 —— 完全沒有經緯度欄位，應被整份丟棄並在報告列出原因
tainan = {"responseData": [
    {"Seq": 1, "編號": "TN-01", "轄區分局": "第一分局", "行政區": "中西區",
     "設置位置": "民族路二段與西門路口", "拍攝行向": "東西雙向", "速限": "40"},
]}
open(os.path.join(OUT, "tainan.json"), "w", encoding="utf-8").write(
    json.dumps(tainan, ensure_ascii=False))

# ⑨ 臺中：GeoJSON 格式
tc = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [120.684000, 24.147000]},
     "properties": {"編號": "TC-01", "科技執法種類": "區間測速",
                    "設置地點": "台74線 8K-12K", "取締項目": "區間超速"}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [120.660000, 24.163000]},
     "properties": {"編號": "TC-02", "科技執法種類": "路口違規",
                    "設置地點": "台灣大道二段與惠中路口", "取締項目": "闖紅燈"}},
]}
open(os.path.join(OUT, "taichung_tech.geojson"), "w", encoding="utf-8").write(
    json.dumps(tc, ensure_ascii=False))

print("fixtures written to", OUT)
for f in sorted(os.listdir(OUT)):
    print("  ", f, os.path.getsize(os.path.join(OUT, f)), "bytes")
