# 鹿豹 ETL · 資料前處理

三支腳本，都**只用 Python 標準函式庫**，不需要 `pip install`：

| 腳本 | 做什麼 |
|---|---|
| `build_speedcams.py` | 把各機關的測速照相開放資料抓下來、正規化、去重，輸出 App 用的檔案 |
| `build_roadnet.py` | 從 OpenStreetMap 抓國道與快速道路中心線，讓 App 能沿著路算距離 |
| `geocode_tainan.py` | 把臺南「民族路二段與西門路口」這種文字地址轉成座標 |

---


## ⚠️ CI 正式建置一定要加 `--no-fallback`

`downloads/` 這個資料夾同時放兩種東西：使用者手動下載的檔案，以及測試用的小樣本檔
（每個只有幾筆）。腳本原本會**優先讀本機檔**，所以在 CI 跑的時候，會安靜地拿測試樣本
當成正式資料建出來 —— 而且看起來完全成功。

現在的行為：

| 模式 | 順序 |
|---|---|
| 預設（可連網） | **先網路**，全部失敗才退回本機檔，而且會在報告裡標紅 |
| `--no-fallback` | **只用網路**，抓不到就是失敗。**CI 請用這個** |
| `--offline` | 只用本機檔（開發用） |

`.github/workflows/update-speedcams.yml` 已經加上 `--no-fallback`。


## 用法

```bash
# 線上抓取所有來源
python3 build_speedcams.py

# 只用 downloads/ 內手動下載好的檔案（完全不連網）
python3 build_speedcams.py --offline

# 只跑特定來源
python3 build_speedcams.py --only freeway,taipei

# 輸出到別的地方（GitHub Actions 用這個）
python3 build_speedcams.py --out ../docs/data --fail-under 300
```

### 輸出（預設 `dist/`）

| 檔案 | 用途 |
|---|---|
| `speedcams.min.json` | `[[lat,lon,速限,方向,名稱],...]`。**App 的「從資料源更新」直接吃這個**，體積最小 |
| `speedcams.geojson` | 標準 GeoJSON，含來源標註、區間測速旗標、跨來源合併紀錄。給 QGIS / 其他工具用 |
| `report.md` | 人看的報告：各來源筆數、編碼、失敗原因、縣市覆蓋、缺哪些縣市 |
| `report.json` | 同一份報告的機器可讀版 |

---

## 抓不到的時候（很常見）

政府網站會擋、會改 resource id、會換編碼。腳本設計成**抓不到就降級，不會整個爆掉**：

1. 每個來源可以列多個候選網址，由上而下試。
2. `downloads/` 內若有 `<來源id>.csv` / `.zip` / `.json`，**優先用本機檔案**，跳過網路。
3. 某個來源失敗只影響那一個來源，其他照常合併，失敗原因寫進報告。

所以最穩的做法是：**會抓的自動抓，抓不到的手動下載一次丟進 `downloads/`**。

已知需要手動下載的：

- **國道**（`freeway.zip` 或 `freeway.csv`）—— `tgos.tw` 對非瀏覽器 UA 會回 403。用瀏覽器開 https://data.gov.tw/dataset/13940 下載，ZIP 直接存成 `downloads/freeway.zip`，或解壓後存成 `downloads/freeway.csv`。
  這份的欄位有幾個特別的地方：**縣市／行政區／設置區域描述／備註四欄全空**，路名用**中文數字**（`國道一號南向2公里`），拍攝方向是 `北往南`／`南往北`／`東往西`／`西往東`／`南北向`。實測 177 筆全部有座標與速限。
- **臺中固定式測速**（216 筆，資料品質最好的一份）—— 下載連結是前端 JS 動態組出來的，抓不到。用瀏覽器開 https://opendata.taichung.gov.tw/search/2fbd9693-4e70-40a1-8e39-2f1c6189c41a 按下載，存成 `downloads/taichung_fixed.csv`，並在 `sources.json` 加一筆 `taichung_fixed`。

---

## 新增一個來源

編輯 `sources.json`，加一筆：

```json
{
  "id": "keelung",
  "name": "基隆市固定式測速照相地點",
  "group": "縣市",
  "agency": "基隆市警察局",
  "page": "https://data.gov.tw/dataset/XXXXX",
  "urls": ["https://.../download"],
  "kind": "auto",
  "encoding": "auto",
  "county": "基隆市",
  "priority": 3,
  "verified": false
}
```

**不需要寫欄位對照。** 腳本會自己認：

| 語意 | 認得的欄位名 |
|---|---|
| 緯度 | `lat` `latitude` `緯度` `座標緯度` `座標緯N度` `y` |
| 經度 | `lon` `lng` `longitude` `經度` `座標經度` `座標經E度` `x` |
| 速限 | `速限` `limit` |
| 方向 | `拍攝方向` `拍攝行向` `測照方向` `direct` `方向` `行向` |
| 地點 | `設置地點` `測照地點` `設置位置` `address` `地址` `地點` `路段` `名稱` |
| 類型 | `取締項目` `科技執法種類` `測照型式` `型式` |

`priority` 數字小的優先 —— 去重時保留 priority 較小的那筆，缺的欄位再從被合併掉的那筆補上。

---

## 它幫你處理掉的坑

這些全都是實際踩到的：

- **ZIP** — 自動解壓，遞迴掃描裡面所有 CSV/JSON，跳過 `__MACOSX`
- **Big5 / UTF-8 混用** — 依序試 `utf-8-sig → utf-8 → big5hkscs → cp950 → big5`，解出來亂碼太多就換下一個
- **雙表頭** — 警政署那份第 2 列是中文說明（`設置縣市,設置市區鄉鎮,...`），自動偵測並丟掉
- **經緯度寫反** — 桃園、臺中是緯度在前；若座標落在台灣範圍外但對調後就落在範圍內，自動對調並在報告記數
- **奇怪欄名** — 高雄 111 年用「座標緯N度」「座標經E度」
- **JSON 包裝五花八門** — `{data:[...]}`、`{responseData:[...]}`、GeoJSON、裸陣列，甚至未知包裝鍵（會自動找出最像資料的那個陣列）
- **六都常省略縣市欄** — 用 `sources.json` 的 `county` 補上，縣市覆蓋統計才會準
- **區間測速各家寫法不同** — 新北寫在 `direct` 欄、桃園/高雄寫在「型式」、臺中是獨立資料集、國道寫在「取締項目」。只要任一欄出現「區間」就標記
- **跨來源同一支桿子** — 25 公尺內視為同一點合併（可在 `sources.json` 調 `dedupe_meters`）。方向不同則視為不同設備，因為雙向常各架一支
- **壞資料列 / 界外座標** — 丟掉並在報告記數
- **經緯度黏在一起** — 實際遇過國道那份第 154 筆的經度寫成 `121.6219225.03584`（經度後面接了緯度）。這種只有一個小數點以上的字串會被單獨標記在報告的「⚠️ 座標格式異常」區塊，不會靜靜地取第一個數字就算了

---

## 自動更新

`.github/workflows/update-speedcams.yml` 每週一台灣時間 06:00 跑一次，輸出到 `docs/data/`，發布到 GitHub Pages。

GitHub Pages 的回應帶 `Access-Control-Allow-Origin: *`，所以 **App 可以直接 fetch，沒有 CORS 問題** —— 這正是繞過政府網站不開 CORS 的辦法。

App 端：「資料」頁 →「我的資料源」填入
`https://<你的帳號>.github.io/<專案>/data/speedcams.min.json`
→ 按「從資料源更新」。開啟「開啟時自動更新」後每天最多自動抓一次，抓失敗會保留上次成功的資料，不影響離線使用。

### `--fail-under` 守門員

CI 用 `--fail-under 300`：合併後點數低於 300 就讓 job 失敗、不 commit。避免某天政府網站改版導致抓到空檔，把好資料覆蓋掉。**第一次跑請先看實際點數，再把門檻設在正常值的七成左右。**

---

## 誠實的覆蓋率說明（2026-08 全面重查過）

**沒有任何單一來源涵蓋全台。** 這是這個專案資料面最核心的事實。跑完看 `report.md` 最後的「縣市覆蓋」。

### 已經有解的

| 縣市 | 來源 | 座標 | 備註 |
|---|---|---|---|
| 9 個縣 | [警政署 7320](https://data.gov.tw/dataset/7320) | ✅ | 金門、宜蘭、新竹縣、苗栗、彰化、南投、雲林、嘉義縣、屏東 |
| 國道 | [警政署 13940](https://data.gov.tw/dataset/13940) | ✅ | 只有 ZIP，tgos.tw 對非瀏覽器 UA 回 403 |
| 六都 | 各市平臺 | ✅（臺南除外） | 臺北 Big5、桃園 Big5、高雄停更在 2022 |
| **澎湖縣** | [CKAN](https://opendata.penghu.gov.tw/dataset/pb140320-2022-07-14-1657785496) | ✅ | 33 筆，2026-08 更新，**資料品質最好的之一** |
| **嘉義市** | [data.gov.tw 52544](https://data.gov.tw/dataset/52544) | ✅ | 11 筆 |
| **新竹市** | [警局官網 HTML 表格](https://tra.hccp.gov.tw/pages/camera) | ✅ | 約 120 點，只有 HTML，本腳本已支援解析 |
| 臺南市 | 官方資料集無座標 | ⚠️ | 用 `geocode_tainan.py` 推算補上 |

### 還沒有解的

| 縣市 | 狀況 | 怎麼補 |
|---|---|---|
| **臺東縣** | [data.gov.tw 177486](https://data.gov.tw/dataset/177486) 只有 PDF，**但 PDF 內含經緯度** | 解析 PDF，成本低 |
| **基隆市** | 只有 PDF/DOC，約 72 處，**只有路口名沒座標** | geocoding（路口名，可解） |
| **花蓮縣** | 固定式只有「台9線284.9K」里程樁描述，**沒座標**。區間測速資料集已上架但查不到 dataset id | 里程樁反算，較麻煩 |
| **連江縣（馬祖）** | **全台唯一完全沒有機器可讀來源**。縣府 open data 平臺無警政資料，警局網站 robots 擋 | 已知僅 4~12 點（南竿+北竿），**人工維護完全可行** |

### 離島結論

- **金門 ✅** 已在警政署那份裡，有座標，持續更新
- **澎湖 ✅** 自己的 CKAN，品質很好
- **馬祖 ❌** 目前無解，但點數極少，手動就能維護
- **綠島／蘭嶼／小琉球** 分屬臺東、屏東，尚未逐筆確認是否列入

### 各縣市警察局互相轉載 —— 被低估的政府端全國入口

道交條例 §7-2 要求各警察局公告設置地點，而**各縣市警局會把其他縣市的公告全部轉載到自己網站**。已確認至少三個「全縣市集散地」：

- 南投縣警察局竹山分局 `https://www.ncpd.gov.tw/df_ufiles/zhushan/`
- 宜蘭縣警察局 `https://www.ilcpb.gov.tw/files/`（有臺東、屏東、嘉義市的含經緯度版本）
- 新北市警察局交通警察大隊 `traffic.police.ntpc.gov.tw`

這是目前唯一能一站拿到全 22 縣市的政府端來源，代價是全是 PDF/DOC 且欄位不一致。

### 兩件最值得先做的事

1. **用瀏覽器 DevTools 看一次 [警政署測速執法點查詢系統](https://ps.npa.gov.tw/TrafficSearch/) 的 Network 分頁。** 如果它前端打的是某支 JSON API，那會是**唯一的全國單一來源**，上面所有補洞工作都可以砍掉。這是 5 分鐘的事，但需要真的瀏覽器（該站 robots.txt 逾時，自動化工具一律被拒）。
2. **跑一次 Overpass 查 OSM 的 `highway=speed_camera` 台灣覆蓋率。** OSM 有 `type=enforcement` + `enforcement=average_speed` 可以直接對應區間測速，授權（ODbL）也乾淨。查詢語法見下方。若覆蓋率夠，可以當底圖再用政府資料校正。

```
# 全台總數
[out:json][timeout:180];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
node["highway"="speed_camera"](area.tw);
out count;

# 離島（用 bbox 避開行政區關係不完整的風險）
# 澎湖 (23.15,119.35,23.85,119.80)　金門 (24.30,118.10,24.60,118.55)　馬祖 (25.90,119.85,26.40,120.60)

# 區間測速
[out:json][timeout:180];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
rel["type"="enforcement"]["enforcement"="average_speed"](area.tw);
out tags;
```

### 商業資料庫（查過，不建議當主來源）

- **SCDB.info** 有台灣清單（53 頁），€9.95 買 12 個月更新，格式含 CSV/GPX/OV2/Garmin。但**授權不允許再散布**（要另談 B2B），離島覆蓋未證實。適合當交叉驗證，不適合當 App 主來源。
- **POIbase** 主打歐洲，網站完全沒提台灣。
- **神盾** 不公開資料來源，無 API 無下載。推測是政府公告 + 使用者回報混合。
- GitHub 上**沒有**現成把台灣各縣市合併好的開放專案。

### HTML 表格來源

有些縣市（新竹市）只在官網放 HTML 表格，沒有開放資料集也沒有下載檔。腳本已內建 HTML 表格解析（純標準函式庫）：自動找出**同時有經度與緯度欄位**的表格，忽略其他表格，多張表會合併，`<br>` 會轉成空白避免欄位黏在一起。在 `sources.json` 把 `kind` 設成 `html` 即可。

---

## 測試

```bash
python3 make_fixtures.py          # 造出重現各來源怪癖的假檔案
python3 build_speedcams.py --offline
```

`make_fixtures.py` 造的每一份檔案都刻意重現一個實際踩到的坑（Big5、雙表頭、ZIP、怪欄名、無座標、經緯反轉、跨來源重複），跑完應該看到 20 點、去重 2、區間測速 7，且臺南那份被正確判定為「找不到經緯度欄位」。

---

## 授權

所有來源皆為「政府資料開放授權條款第1版」，可商用，**需標示來源**。
`speedcams.geojson` 的 `attribution` 欄位已列出所有機關，請在你的 App 內顯示。


---

# build_roadnet.py · 路網幾何

```bash
python3 build_roadnet.py                      # 抓國道 + 快速道路
python3 build_roadnet.py --classes motorway,trunk,primary   # 加省道（檔案大很多）
python3 build_roadnet.py --roads 國道1號,國道3號,台61線
python3 build_roadnet.py --offline            # 用 downloads/overpass_*.json
```

## 為什麼需要

沒有路網時，App 判斷「前方測速點」只能用航向 ±35° 的錐形。**彎道會失效** —— 實測在一段 S 形山路上，錐形判斷找到 0 個前方測速點，貼路計算正確找到 2.02 公里外那一個。

里程推算也一樣：同一段路直線距離 4 835 公尺、沿路距離 7 908 公尺，**直線低估了 39%**。樁號推算會整整差 3 公里。

## 它做了什麼

- 從 Overpass 抓 `highway=motorway/trunk`（含 `_link` 匝道）
- `ref`/`name` 正規化：`N1` → `國道1號`、`台61` → `台61線`
- **把散落的 way 接成連續路線** —— OSM 上一條國道是幾百個 way，端點相接才能算沿路距離。接不起來的各自成段。
- Douglas–Peucker 簡化：容差 8 公尺可把點數降到約 1/5，長度誤差 < 0.3%
- 丟掉沒有編號、以及短於 800 公尺的碎段

## 輸出

`roadnet.min.json` = `[{id, ref, cls, pts:[[lat,lon],…]}, …]`

App 的「資料 → 路網幾何」貼上網址或匯入檔案即可。**沒載入不影響其他功能**，所有計算自動退回原本的直線／錐形做法。

## 授權注意

OpenStreetMap 資料是 **ODbL**，和政府開放資料的授權不同。若你的 App 使用這份路網，必須標示 "© OpenStreetMap contributors"，且衍生的資料庫要以相同方式分享。這是與測速點資料不同的義務，**上架前請確認**。

Overpass 是志工營運的免費服務，腳本會自動重試與換備援節點，但請不要高頻濫用。路網很少變動，附的 GitHub Actions 設定成每月才重建一次。

---

# geocode_tainan.py · 臺南地址轉座標

臺南市的測速開放資料**沒有經緯度欄位**，只有「民族路二段與西門路口」這種文字，所以整份在合併時會被丟掉。這支把它補回來。

```bash
python3 geocode_tainan.py --in downloads/tainan.json --dry-run   # 先看地址會被怎麼解析
python3 geocode_tainan.py --in downloads/tainan.json             # 實際查詢
python3 geocode_tainan.py --offline                              # 只用快取
```

## 兩種策略

1. **路口交會點**（準確度最高）——「A路與B路口」用 Overpass 找臺南市內同時屬於 A 與 B 的節點。測速點本來就設在路口，所以這比一般地址查詢準得多。
2. **Nominatim 全文查詢**（退而求其次）—— 適合「XX路123號」這種門牌式描述。

解析支援的格式：`A與B路口`、`A、B交叉口`、`A和B口`、`XX路二段123號`、`中山路三段(南向)`（方向註記會被剝掉，不會污染路名）。

所有查詢都有本機快取，重跑不會重複打 API。預設每次查詢間隔 1.1 秒（Nominatim 政策要求每秒最多 1 次）。

## ⚠️ 這些座標是推算的

**不是官方公布值。** 路口策略通常誤差在十幾公尺內，但 Nominatim 全文查詢可能落在路段中間而非實際設置點。

所以在 `sources.json` 裡 `tainan_geocoded` 的 `priority` 設成 **8**（很低）—— 去重時只要官方有座標就以官方為準，這份只用來補空缺。輸出的 CSV 有 `geocode_method` 欄位可以追溯每一筆是用哪種策略來的。

## 用法串接

```bash
python3 geocode_tainan.py --in downloads/tainan.json
cp dist/tainan_geocoded.csv downloads/          # 讓 build_speedcams 讀得到
python3 build_speedcams.py --offline
```

## 測試

```bash
python3 test_geocode.py     # 22 項，網路層以假資料取代，不需連網
```
