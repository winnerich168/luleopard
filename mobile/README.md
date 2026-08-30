# 鹿豹 · 打包成 App（含背景定位）

網頁版最大的缺口是**關螢幕就停止警示**。對測速照相只是不方便；對掉落物是致命的 —— 你正在高速公路上，手機多半在充電座上熄屏。

包成原生 App 之後拿到的東西：

| 能力 | 網頁版 | 原生版 |
|---|---|---|
| **關螢幕、切 App 仍持續警示** | ❌ | ✅ 這是包 App 最主要的理由 |
| 背景語音播報 | ❌ | ✅ 原生 TTS |
| iOS 震動 | ❌ | ✅ |
| CORS 限制 | 有 | 無（可直接抓政府資料） |
| 離線圖資 | 難 | 可行 |

前端**完全不用改寫**。`luleopard.html` 裡已經有橋接層：偵測到 `window.Capacitor` 就自動改用背景定位與原生語音，在一般瀏覽器裡整段不啟用。

---

## 建置步驟

```bash
cd mobile
npm install

# Android
npm run add:android
npm run android          # 開啟 Android Studio

# iOS（需要 macOS + Xcode）
npm run add:ios
npm run ios
```

改了 `luleopard.html` 之後：

```bash
npm run sync             # 重新複製 www/ 並同步到原生專案
```

---

## ⚠️ 必要的原生設定（不做這步背景定位不會動）

`npx cap add` 產生的專案是預設值，**下面這些必須手動加**。

### Android — `android/app/src/main/AndroidManifest.xml`

在 `<manifest>` 底下、`<application>` 之外加入：

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

在 `<application>` 內加入前景服務宣告：

```xml
<service
    android:name="com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService"
    android:foregroundServiceType="location"
    android:enabled="true"
    android:exported="false" />
```

**Android 10 以上的權限流程有個坑**：`ACCESS_BACKGROUND_LOCATION` 不能和前景定位權限一起要。系統會先問「使用時允許」，使用者必須再自己到設定裡改成「一律允許」。App 內已經在權限被拒時提示這件事，但你可能想做一個更清楚的引導頁。

### iOS — `ios/App/App/Info.plist`

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>鹿豹需要你的位置，才能在接近測速照相或前方掉落物時提醒你。</string>

<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>鹿豹需要在背景取得位置，才能在你關閉螢幕或使用其他 App 時，仍持續提醒前方的測速照相與掉落物。</string>

<key>UIBackgroundModes</key>
<array>
    <string>location</string>
    <string>audio</string>
</array>
```

`audio` 這一項容易漏掉 —— **沒有它，背景定位會動但語音發不出聲音**，等於白做。

App 內的原生 TTS 呼叫已經指定 `category: 'playback'`，配合上面的 `audio` 背景模式才能在鎖屏時出聲。

---

## 送審會被問到的事

Apple 對「背景定位」審得比較嚴，兩邊都要準備：

- **用途說明要具體**：不要只寫「需要定位」。上面的字串已經寫明「在你關閉螢幕時仍持續提醒前方測速與掉落物」，這種寫法過審率高很多。
- **要能示範**：審查員會實際測。建議在 App 內留一個「模擬行車」功能（設定頁已經有），讓他們不用真的開車就能看到警示運作。
- **測速照相 App 的政策**：Apple 與 Google 都允許「行車安全提醒」類的 App，但**不要**在描述或介面裡出現「幫你避開罰單」「躲避警察」這類字眼，容易被歸類成協助違法。定位成**行車安全與速限提醒**，並保留現在的免責聲明。
- **Android 的背景定位**需要在 Play Console 填寫「背景位置存取權」聲明表，說明為什麼前景權限不夠用。理由就是上面那句：關螢幕仍需持續警示。

---

## 耗電

背景定位很吃電，這點要誠實面對：

- `distanceFilter: 8`（移動 8 公尺才回報）已經是省電與精度的平衡點，高速公路上約每 0.3 秒一次，足夠用
- 建議在 App 內做「到達目的地/長時間靜止就自動停止背景定位」，目前**還沒做**
- 實務上使用者多半會插著充電線，但仍應在首次啟用時說明耗電

---

## 版本相容

`package.json` 鎖的是 Capacitor 6。若你要升到 7，`@capacitor-community/background-geolocation` 也要跟著升到支援 7 的版本，否則 `cap sync` 會報錯。

Android 需要 `compileSdk 34` 以上（Capacitor 6 預設就是）。iOS 需要 13.0 以上。

---

## 沒有實機驗證的部分

我在容器裡沒有 Android SDK 與 Xcode，所以**這個 scaffold 的原生建置我沒有實跑過**。已驗證的是：

- `scripts/build-www.mjs` 可正確產生 `www/index.html` 並注入 `capacitor.js`
- 橋接層在「模擬的 Capacitor 環境」下會正確切換到背景定位與原生 TTS，位置回呼、錯誤處理、權限被拒的提示都會走對分支（見專案根目錄 `test6.js`）
- 橋接層在一般瀏覽器下完全不啟用，不影響網頁版

`npm install` 之後第一次 `cap add android` 若有版本衝突，先跑 `npx cap doctor` 看它怎麼說。
