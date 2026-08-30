# 鹿豹 · 上線手冊

從零到一個能發給朋友的網址。**全程免費**，不需要信用卡。

---

## 先決定：網頁版還是 App？

| | 網頁版（GitHub Pages） | Android App |
|---|---|---|
| 費用 | **免費** | 免費（發 APK）／US$25 一次（上 Play） |
| 安裝 | 開網址 → 加到主畫面 | 下載 APK → 允許不明來源 |
| 更新 | push 上去所有人立刻拿到 | 使用者要重新下載 |
| **關螢幕仍警示** | ❌ | ✅ |
| 執行速度 | 一樣（同一個 WebView 引擎） | 一樣 |
| iOS | ✅ 可用 | 需 US$99/年，不建議 |

**建議先做網頁版**。手機架著、螢幕亮著開車的情況下兩者體感沒有差別，而網頁版零成本、隨時能改、不用等審核。等真的有人抱怨「關螢幕就沒聲音」，再回頭做 App。

---

# 第一部分：網頁版（約 10 分鐘）

## 1. 建立 GitHub repo

1. 到 [github.com/new](https://github.com/new)
2. Repository name 填 `luleopard`（或任何名字）
3. 選 **Public**（Private 的 Pages 需要付費方案）
4. 按 Create repository

## 2. 上傳檔案

最簡單的方式是網頁拖曳：在新 repo 頁面按 **uploading an existing file**，把解壓後的所有檔案拖進去，按 Commit。

或用指令：

```bash
cd luleopard                       # 解壓後的資料夾
git init
git add .
git commit -m "鹿豹 v1.1"
git branch -M main
git remote add origin https://github.com/你的帳號/luleopard.git
git push -u origin main
```

## 3. 開啟 GitHub Pages

1. repo 頁面 → **Settings** → 左邊選 **Pages**
2. **Source** 選 **GitHub Actions**（不是 Deploy from a branch）
3. 存檔

## 4. 讓它跑第一次

1. repo 頁面 → **Actions** 分頁
2. 第一次進來會問要不要啟用 workflow，按 **I understand my workflows, go ahead and enable them**
3. 左邊選「**發佈網頁版到 GitHub Pages**」→ 右邊 **Run workflow** → 綠色按鈕
4. 等約 1 分鐘，跑完點進去看 Summary，網址會印在那裡

網址長這樣：`https://你的帳號.github.io/luleopard/`

## 5. 手機上安裝

**Android（Chrome）**：開啟網址 → 右上角 ⋮ → 「安裝應用程式」或「加到主畫面」

**iPhone（Safari）**：開啟網址 → 下方分享鈕 → 「加入主畫面」

加完之後圖示會出現在桌面，點開是全螢幕的，看不出來是網頁。

> ⚠️ iPhone **一定要用 Safari** 加到主畫面。用 Chrome 加的不會有全螢幕。

## 6. 補齊測速點資料

內建 315 點（國道全線 + 宜蘭 + 新竹）**開國道立刻就有用**。要補六都與其他縣市：

1. Actions → 「**更新測速點位資料**」→ Run workflow
2. 它會抓各縣市開放資料、合併去重、產生 `docs/data/speedcams.min.json`，然後自動重新發佈
3. 跑完之後，在 App 的「**資料 → 我的資料源**」填入：
   ```
   https://你的帳號.github.io/luleopard/data/speedcams.min.json
   ```
4. 按「從資料源更新」，再打開「開啟時自動更新」

之後每週一早上 6 點會自動更新，使用者什麼都不用做。

> 政府網站偶爾改版會讓某個來源失敗，這是正常的。`--fail-under 300` 會擋住「抓到空檔把好資料蓋掉」的情況。看 Actions 的 Summary 會列出每個來源成功與否。

## 7.（選用）開啟共享回報

沒有這步，回報只留在自己手機裡，對別人沒有預警作用。

```bash
cd backend
npm i -D wrangler
npx wrangler kv namespace create HAZARDS
npx wrangler kv namespace create HAZARDS --preview
# 把印出來的兩個 id 貼進 wrangler.toml
npx wrangler deploy
```

拿到網址後填進 App 的「回報 → 共享回報」。Cloudflare 免費方案每天可撐約 500 筆回報。

再加上 TDX 金鑰，過期事件就會自動跟官方對帳：

```bash
npx wrangler secret put TDX_ID
npx wrangler secret put TDX_SECRET
```

細節見 [`backend/README.md`](backend/README.md)。

---

# 第二部分：Android APK

## 用 GitHub Actions 建（不用裝任何東西）

1. Actions → 「**建置 Android APK**」→ Run workflow
2. 等約 5~8 分鐘
3. 跑完點進去，最下面 **Artifacts** 有 `luleopard-android`，下載解壓就是 APK

要發正式版讓人下載：

```bash
git tag v1.1
git push --tags
```

推 tag 會自動建置並發到 **Releases**，附上安裝說明。

## 使用者安裝時要做的事

1. 下載 APK → 手機會擋「來自不明來源」→ 允許這一次
2. 第一次開啟後，**務必到「設定 → 應用程式 → 鹿豹 → 權限 → 位置」改成「一律允許」**

第 2 步不能省。Android 不允許 App 直接要求背景定位權限，系統只會問「使用時允許」—— 停在那裡的話**關螢幕就不會警示**，等於白裝。App 內在權限不足時會提示，但還是講在前面比較好。

## 想覆蓋更新就要簽章

沒有簽章的 debug APK 每次重建簽章都不同，使用者無法直接覆蓋安裝（要先解除安裝，設定會全部不見）。要正式發佈：

```bash
keytool -genkey -v -keystore luleopard.keystore \
  -alias luleopard -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 luleopard.keystore    # 複製這串
```

到 repo → Settings → Secrets and variables → Actions，加四個 secret：

| Secret 名稱 | 內容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 上面那串 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密碼 |
| `ANDROID_KEY_ALIAS` | `luleopard` |
| `ANDROID_KEY_PASSWORD` | key 密碼 |

> 🔑 **keystore 檔案要自己備份好**。弄丟就永遠無法更新已經發出去的 App —— 只能換一個新的套件名稱重來，使用者要全部重裝。

## 本機建置（要有 Android Studio）

```bash
cd mobile
npm install
npm run add:android      # 產生原生專案 + 圖示 + 補上背景定位設定
npm run android          # 開啟 Android Studio
```

改過 `luleopard.html` 之後：

```bash
npm run sync
```

`npm run sync` 會自動跑 `patch-android.mjs` 補上背景定位權限。**不要手動改 AndroidManifest** —— 重新產生專案時會被蓋掉，而症狀是「白天測都正常、關螢幕才沒聲音」，非常難查。

---

# 第三部分：iOS

需要 macOS + Xcode。**免費的方式每 7 天要重簽一次**，一般使用者不可能接受，所以實務上只有兩條路：

- **使用者用網頁版**（推薦）—— 加到主畫面後體驗跟 App 幾乎一樣，只是不能關螢幕
- 付 **US$99/年** 的 Apple Developer，上架 App Store

```bash
cd mobile
npm install
npm run add:ios
npm run ios
```

`ios/App/App/Info.plist` 必須手動加上定位用途說明與 `UIBackgroundModes`（含 **`audio`** —— 少了它背景定位會動但語音發不出聲音）。完整內容見 [`mobile/README.md`](mobile/README.md)。

---

# 常見問題

**開啟後說「定位權限被拒」**
定位需要 HTTPS。GitHub Pages 本身就是 HTTPS，沒問題；但如果你把檔案直接用 `file://` 開或架在 http 網站上，瀏覽器會拒絕。

**加到主畫面後圖示是空白的**
清一次瀏覽器快取再重新加。Service Worker 的版本號綁在 `index.html` 的雜湊上，內容一變就會自動換新，通常不會卡住。

**Actions 顯示紅色 ✗**
點進去看是哪一步。最常見是「更新測速點位資料」某個縣市的網站掛了 —— 那是政府網站的問題，重跑一次通常就好，而且舊資料不會被蓋掉。

**沒訊號的地方還能用嗎**
可以。App 本體與內建點位都在 Service Worker 快取裡，**斷網也開得起來**（已驗證）。只有地圖圖磚需要網路，所以隧道內會空白 —— 那時候可以切到不需網路的雷達視圖。

**要花錢嗎**
網頁版完全不用。Cloudflare Worker 免費方案夠用。只有上 Google Play（US$25 一次）與 App Store（US$99/年）要錢。

---

## 上線前最後檢查

- [ ] 手機實際開一趟，確認會出聲（`設定 → 模擬行車` 可以先在家裡驗）
- [ ] 確認 `docs/data/` 有產生，且 App 的資料源網址填對了
- [ ] 如果要商業化或上架，先確認 **OpenStreetMap 的 ODbL 授權**（相同方式分享）—— 這跟政府開放資料是**兩套不同的義務**
- [ ] 描述與介面不要出現「避開罰單」「躲避警察」這類字眼，定位成**行車安全與速限提醒**
- [ ] 免責聲明留著：請以現場標誌與實際路況為準，行進中請勿操作手機
