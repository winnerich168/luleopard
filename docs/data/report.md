# 鹿豹 · 測速點位合併報告

產生時間：2026-08-31T08:14:30+08:00（耗時 964.7s）

## 總覽

| 項目 | 數量 |
|---|---|
| **合併後總點數** | **2100** |
| 跨來源重複合併 | 369 |
| 區間測速 | 63 |
| 有速限資訊 | 2018 (96%) |
| 有方向資訊 | 2027 (97%) |
| 成功來源 | 7 / 13 |

## 各來源

| 來源 | 分類 | 點數 | 編碼 | 取得方式 |
|---|---|---|---|---|
| 國道公路固定式測速照相地點 | 國道 | — | — | **失敗** |
| 測速執法設置點（警政署） | 省道/縣道 | 1897 | utf-8-sig | https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD |
| 臺北市固定測速照相地點表 | 六都 | 143 | cp950 | https://data.taipei/api/dataset/745b8808-061f-4f5b-9a62-da1590c049a9/r |
| 新北市固定式測速照相地點 | 六都 | 190 | utf-8-sig | https://data.ntpc.gov.tw/api/datasets/99f3ff6e-0352-4399-a726-775ab765 |
| 桃園市測速照相設備地點 | 六都 | 118 | cp950 | https://opendata.tycg.gov.tw/api/dataset/ecd45ee5-4489-436b-bd08-7d4e4 |
| 臺中市科技執法取締地點 | 六都 | 77 | utf-8-sig | https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download |
| 臺南市智慧管理科技執法設備設置地點 | 六都 | — | utf-8-sig | **失敗** |
| 臺南市科技執法設備（座標為 geocoding 推算） | 六都 | — | — | **失敗** |
| 高雄市111年固定式違規照相及科技執法設置地點 | 六都 | — | — | **失敗** |
| 高雄市109年固定式違規闖紅燈及測速照相設備設置地點 | 六都 | — | — | **失敗** |
| 澎湖縣固定式測速照相地點 | 離島 | 33 | utf-8-sig | https://opendata.penghu.gov.tw/dataset/99f233c2-df0b-4291-b899-81ac368 |
| 嘉義市固定式測速照相設置地點 | 縣市 | 11 | utf-8-sig | https://data.chiayi.gov.tw/opendata/api/getResource?oid=26242d8c-9340- |
| 新竹市科學儀器及科技執法取締地點 | 縣市 | — | utf-8-sig | **失敗** |

### 失敗的來源

- **國道公路固定式測速照相地點**：https://www.tgos.tw/tgos/VirtualDir/Product/c2dd3a68-cafc-48fc-8a4a-7215ddc24cd3/1150720-國 → UnicodeEncodeError: 'ascii' codec can't encode characters in position 74-86: ordinal not in range(128)

- **臺南市智慧管理科技執法設備設置地點**：https://soa.tainan.gov.tw/Api/Service/Get/1c7e82f0-d6b2-4b20-aeff-5c768100f82c → URLError: <urlopen error timed out> | https://data.tainan.gov.tw/File/ResourceCsvDownload/1c7e82f0-d6b2-4b20-aeff-5c768100f82c → ValueError: 找不到經緯度欄位（欄位為：Seq, 編號, 轄區分局, 行政區, 設置位置, 拍攝
行向, 速限）

- **臺南市科技執法設備（座標為 geocoding 推算）**：這個來源沒有登記任何網址

- **高雄市111年固定式違規照相及科技執法設置地點**：https://openapi.kcg.gov.tw/Api/Service/Get/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b → URLError: <urlopen error timed out> | https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b → URLError: <urlopen error timed out>

- **高雄市109年固定式違規闖紅燈及測速照相設備設置地點**：https://openapi.kcg.gov.tw/Api/Service/Get/5dbf35bc-8bc2-4fbf-9204-d82daaa3e23c → URLError: <urlopen error timed out> | https://data.kcg.gov.tw/File/DirectDownload/5dbf35bc-8bc2-4fbf-9204-d82daaa3e23c → URLError: <urlopen error timed out>

- **新竹市科學儀器及科技執法取締地點**：https://tra.hccp.gov.tw/pages/camera → ValueError: 找不到經緯度欄位（欄位為：<!DOCTYPE html>）


## 縣市覆蓋

| 縣市 | 點數 |
|---|---|
| 臺中市 | 250 |
| 桃園市 | 213 |
| 新北市 | 191 |
| （無法判斷） | 169 |
| 臺北市 | 165 |
| 臺南市 | 137 |
| 高雄市 | 126 |
| 雲林縣 | 97 |
| 屏東縣 | 96 |
| 彰化縣 | 95 |
| 基隆市 | 80 |
| 宜蘭縣 | 76 |
| 新竹市 | 70 |
| 苗栗縣 | 66 |
| 新竹縣 | 62 |
| 澎湖縣 | 39 |
| 花蓮縣 | 37 |
| 金門縣 | 37 |
| 南投縣 | 29 |
| 嘉義縣 | 26 |
| 嘉義市 | 22 |
| 臺東縣 | 17 |

> ⚠️ **完全沒有資料的縣市（1 個）**：連江縣
>
> 這些縣市不是腳本漏抓，是政府端根本沒有以開放資料形式發布可用的座標檔。
> 只能靠使用者回報補齊，或人工從各警局公告整理。

---

資料來源：內政部警政署、內政部警政署國道公路警察局、嘉義市政府警察局交通隊、新北市政府警察局、新竹市警察局、桃園市政府警察局、澎湖縣政府警察局、臺中市政府警察局、臺北市政府警察局交通警察大隊、臺南市政府警察局、高雄市政府警察局

依「政府資料開放授權條款第1版」使用。
