# 鹿豹 · 測速點位合併報告

產生時間：2026-10-15T19:13:24+08:00（耗時 2256.0s）

## 總覽

| 項目 | 數量 |
|---|---|
| **合併後總點數** | **2043** |
| 跨來源重複合併 | 287 |
| 區間測速 | 57 |
| 有速限資訊 | 1966 (96%) |
| 有方向資訊 | 1970 (96%) |
| 成功來源 | 7 / 13 |

## 各來源

| 來源 | 分類 | 點數 | 編碼 | 取得方式 |
|---|---|---|---|---|
| 國道公路固定式測速照相地點 | 國道 | — | — | **失敗** |
| 測速執法設置點（警政署） | 省道/縣道 | 1897 | utf-8-sig | https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD |
| 臺北市固定測速照相地點表 | 六都 | 143 | cp950 | https://data.taipei/api/dataset/745b8808-061f-4f5b-9a62-da1590c049a9/r |
| 新北市固定式測速照相地點 | 六都 | 173 | utf-8-sig | https://data.ntpc.gov.tw/api/datasets/99f3ff6e-0352-4399-a726-775ab765 |
| 桃園市測速照相設備地點 | 六都 | — | — | **失敗** |
| 臺中市科技執法取締地點 | 六都 | 77 | utf-8-sig | https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download |
| 臺南市智慧管理科技執法設備設置地點 | 六都 | — | utf-8-sig | **失敗** |
| 臺南市科技執法設備（座標為 geocoding 推算） | 六都 | 5 | utf-8-sig | 檔案 tainan_geocoded.csv |
| 高雄市111年固定式違規照相及科技執法設置地點 | 六都 | — | — | **失敗** |
| 高雄市109年固定式違規闖紅燈及測速照相設備設置地點 | 六都 | — | — | **失敗** |
| 澎湖縣固定式測速照相地點 | 離島 | 33 | utf-8-sig | https://opendata.penghu.gov.tw/dataset/99f233c2-df0b-4291-b899-81ac368 |
| 嘉義市固定式測速照相設置地點 | 縣市 | 11 | utf-8-sig | https://data.chiayi.gov.tw/opendata/api/getResource?oid=26242d8c-9340- |
| 新竹市科學儀器及科技執法取締地點 | 縣市 | — | utf-8-sig | **失敗** |

### ⚠️ 剔除：座標不在國道上的國道照相（9 支）

名稱寫了國道 N 號，座標卻離國道 N 超過 300 公尺，是原始資料的錯誤。
留著的話 App 會在錯的地方唸「前方有測速照相」。

| 名稱 | 座標 | 離國道 |
|---|---|---|
| 國道一號 國道一號南向51.195公里 | 25.01288, 121.16468 | 3 km 以上 |
| 國道三號 國道三號北向284.07公里 | 23.33292, 120.30184 | 3 km 以上 |
| 國道一號 國道一號北向172.8公里 | 24.12422, 120.40102 | 3 km 以上 |
| 國道一號 國道一號南向35.56公里 | 25.03426, 121.24545 | 3118 m |
| 國道三號 國道三號南向218.9公里 | 23.59276, 120.39066 | 3 km 以上 |
| 國道一號 國道一號北向66.6公里 | 24.55137, 121.10067 | 3 km 以上 |
| 國道一號 國道一號南向26.8公里 | 25.04396, 121.30055 | 387 m |
| 國道一號 國道一號南向279公里 | 25.04238, 121.53301 | 3511 m |
| 國道一號 國道一號南向68公里 | 24.55043, 121.10031 | 3 km 以上 |


### 失敗的來源

- **國道公路固定式測速照相地點**：https://www.tgos.tw/tgos/VirtualDir/Product/c2dd3a68-cafc-48fc-8a4a-7215ddc24cd3/1150720-國 → HTTPError: HTTP Error 403: Forbidden

- **桃園市測速照相設備地點**：https://opendata.tycg.gov.tw/api/dataset/ecd45ee5-4489-436b-bd08-7d4e4111c4a4/resource/36e → TimeoutError: The read operation timed out

- **臺南市智慧管理科技執法設備設置地點**：https://soa.tainan.gov.tw/Api/Service/Get/1c7e82f0-d6b2-4b20-aeff-5c768100f82c → URLError: <urlopen error [Errno 110] Connection timed out> | https://data.tainan.gov.tw/File/ResourceCsvDownload/1c7e82f0-d6b2-4b20-aeff-5c768100f82c → ValueError: 找不到經緯度欄位（欄位為：Seq, 編號, 轄區分局, 行政區, 設置位置, 拍攝
行向, 速限）

- **高雄市111年固定式違規照相及科技執法設置地點**：https://openapi.kcg.gov.tw/Api/Service/Get/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b → URLError: <urlopen error [Errno 110] Connection timed out> | https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b → URLError: <urlopen error [Errno 110] Connection timed out>

- **高雄市109年固定式違規闖紅燈及測速照相設備設置地點**：https://openapi.kcg.gov.tw/Api/Service/Get/5dbf35bc-8bc2-4fbf-9204-d82daaa3e23c → URLError: <urlopen error [Errno 110] Connection timed out> | https://data.kcg.gov.tw/File/DirectDownload/5dbf35bc-8bc2-4fbf-9204-d82daaa3e23c → URLError: <urlopen error [Errno 110] Connection timed out>

- **新竹市科學儀器及科技執法取締地點**：https://tra.hccp.gov.tw/pages/camera → ValueError: 抓回來的是 HTML 網頁而不是資料檔，且頁面裡沒有可解析的表格 —— 來源網址可能已失效或改版，請到來源頁面重新取得下載網址


## 縣市覆蓋

| 縣市 | 點數 |
|---|---|
| 臺中市 | 250 |
| 新北市 | 189 |
| 臺北市 | 165 |
| 桃園市 | 162 |
| （無法判斷） | 160 |
| 臺南市 | 142 |
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
