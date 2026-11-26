# StudyMate 校園共讀

校園讀書夥伴媒合網站，可在手機和桌面上使用。支援暨大、台大、成大、彰師大和高大。

## 本機啟動

需要 Node.js 24 以上。在儲存庫目錄執行 `npm ci` 和 `npm start`，再開啟 [StudyMate](http://localhost:8000/)。伺服器會建立本機 SQLite 資料庫 `data/studymate.sqlite`。

## 使用流程

- 登入後可先切換校園。桌面會並排顯示找夥伴介面和地圖，手機可用「看地圖」切換。點選區域圖釘可篩選邀約，滑鼠滾輪或「＋」「−」可縮放底圖。從「校園精選」可直接開啟附近咖啡廳的地圖或讀書空間。各校的精選地點與資料來源收錄在 `campus-places.mjs`。
- 啟用 Google 登入後，點選「使用 Google 帳號登入」，再從 Google 選擇一般 Gmail 或支援學校的帳號。既有使用者可用舊 StudyMate 帳號進行一次安全連結，保留原有資料。部署尚未設定 Google 登入時，仍提供信箱與密碼登入。
- 從左側主選單開啟「配對」，選擇你所在的校園區域，再按「開始配對」。系統優先配對同校距離最近、同時在等候的學生。雙方各自接受後會進入會合地圖，查看共同集合點。配對結果維持匿名。
- 開啟「查看集合點路線」可從自己選擇的區域預覽步行路線。任一方選定咖啡廳後，雙方會看到同一個目的地，並可預覽從集合點出發的路線。兩段都可開啟 Google 地圖的步行導航。重新整理後仍可查看配對結果和共同目的地，直到選擇「返回配對」。
- 可以在開始配對前選擇配對成功後分享位置，也可以在配對地圖手動開啟分享。兩人都開啟後，地圖會連起雙方最新的位置，上方顯示估算直線距離。約 60 公尺內會出現「你們目前在做什麼？」提示。分享僅限該次配對，有效 10 分鐘，期間可隨時關閉。近似座標只暫存在伺服器記憶體。
- 使用「瀏覽邀約」查看正在揪團或可預約的場次。可從結果旁的標籤逐一移除篩選條件，線上共讀不限校園區域。
- 查看邀約並送出加入申請。主揪可在「我的預約」確認申請，參加者可以取消或於開始後標記為完成。
- 從搜尋結果發起邀約時會帶入校園、科目和共讀方式。實體場次會帶入已選的校園區域，仍可手動修改。草稿會在同一分頁重新開啟表單時恢復。已發布且仍開放的邀約可在「我的預約」編輯標題、地點與說明。
- 使用「專注計時」啟動番茄鐘並累積專注紀錄，或透過「讀書空間」查看校園地點。

瀏覽邀約時，媒合度依照時段重疊 35%、區域距離 25%、科目關聯 20% 和共讀習慣 20% 計算。配對用同一校園的公共標記估算距離。按「定位我現在的位置」並允許瀏覽器使用定位後，藍點會隨移動更新，並可在地圖上停止定位。每校的地圖中心、區域標記與驗證網域集中在 `campuses.mjs`。

底圖使用國土測繪中心的臺灣通用電子地圖 WMTS。頁內步行預覽由 FOSSGIS 提供，使用各校公開區域和咖啡廳座標計算。「全臺咖啡廳」顯示本島及離島收錄的 5,826 筆地點，含 2026-11-26 的 OpenStreetMap 快照和既有核對地點。移動或放大地圖時會載入該範圍的標記及清單，縮小時會以合併標記顯示數量。店家涵蓋範圍以資料來源收錄為限。 [臺灣通用電子地圖 WMTS](https://maps.nlsc.gov.tw/S09SOA/pro/Wmts_ajax_main.jsp) · [FOSSGIS 步行路線](https://routing.openstreetmap.de/about.html) · [Geofabrik 臺灣圖資](https://download.geofabrik.de/asia/taiwan.html) · [OpenStreetMap ODbL 授權](https://www.openstreetmap.org/copyright)

密碼以獨立 salt 加上 scrypt 儲存。帳號、配對、邀約、預約、已完成的專注紀錄、檢舉與封鎖儲存在伺服器，並依照帳號權限讀取。邀約卡片顯示主揪暱稱、科系和選擇的概略校園區域。

## Railway 部署

1. 從 [GitHub 部署頁](https://railway.com/new/github) 選擇 `hfrouty/couach` 的 `main` 分支。`Dockerfile` 提供 Node.js 24 的執行環境。
2. 在服務上新增 Volume，掛載到 `/app/data`。SQLite 檔案寫入該 Volume，請保持單一服務副本。應用程式會等到持久掛載可用後才接受註冊。
3. 在服務的 Settings 設定健康檢查路徑 `/health`、產生公開網域，再部署變更。伺服器會自動使用 Railway 的 `PORT`。
4. 使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 產生一次性啟用碼，保存在 Railway 服務變數 `ADMIN_SETUP_TOKEN` 後重新部署。啟用碼請留在自己的終端機與 Railway 變數中。
5. 打開公開網域的 `/admin`，輸入啟用碼並自訂管理員電子郵件與至少 12 個字元的密碼。第一個管理員建立後，後續的建立請求會被拒絕。之後可移除 `ADMIN_SETUP_TOKEN`，並使用同一頁面登入、查看帳號和處理檢舉。

本機也能測試管理員設定。在啟動前設定 `ADMIN_SETUP_TOKEN` 環境變數，使用至少 32 個字元的隨機碼，然後開啟 [本機管理後台](http://localhost:8000/admin)。

### 啟用 Google 登入

使用一般 Gmail 可以登入後選擇校園。使用學校的 Google 帳號會預設前往已驗證帳號所屬的校園。Google 驗證確認帳號歸屬，實際學籍須由學校確認。

| 學校 | 地圖預設區域 | Google 校園帳號網域 |
| --- | --- | --- |
| 暨大 | 埔里校園 | [`mail1.ncnu.edu.tw`](https://cc.ncnu.edu.tw/p/412-1001-1059.php?Lang=zh-tw)，學生帳號 |
| 台大 | 校總區 | [`g.ntu.edu.tw`](https://www.cc.ntu.edu.tw/chinese/services/serv_i06.asp) |
| 成大 | 光復與成功校區 | [`gs.ncku.edu.tw`](https://cc.ncku.edu.tw/p/412-1213-29107.php?Lang=zh-tw) |
| 彰師大 | 進德校區 | [`gm.ncue.edu.tw`](https://www.ncue.edu.tw/p/404-1000-28748.php?Lang=zh-tw) |
| 高大 | 楠梓校園 | [`mail.nuk.edu.tw`](https://lic.nuk.edu.tw/p/406-1012-1423%2Cr21.php?Lang=zh-tw) |

1. 在 Google Cloud 建立「網頁應用程式」OAuth 用戶端，完成 Google 所需的同意畫面和網域設定。[Google OpenID Connect 文件](https://developers.google.com/identity/openid-connect/openid-connect)
2. 將 `https://couach-production.up.railway.app/api/auth/campus/callback` 加到授權的重新導向 URI。若改用自訂網域，請把 URI 和 Railway 的 `STUDYMATE_PUBLIC_ORIGIN` 一起改成該正式網域。
3. 把用戶端 ID 與密鑰各自存到 Railway 的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 服務變數，重新部署後再以 Gmail 和校園帳號驗證登入。兩個變數都設定時，學生註冊與共讀功能會要求 Google 登入，既有帳號仍可登入進行連結。

StudyMate 只要求 `openid` 和 `email` 權限。正式使用 Google 登入前，請依 Google 的應用程式發布規定設定可驗證的網域；學校也可能依 Workspace 政策限制第三方登入。[Google OAuth 政策](https://developers.google.com/identity/protocols/oauth2/policies)

## Android APK 與 Google Play App Bundle

Android 8.0 以上可安裝。App 連接 [StudyMate 正式站](https://couach-production.up.railway.app/)，可使用電子郵件註冊或登入。定位需在使用時允許，步行導航會開啟裝置上的地圖應用程式或瀏覽器。

在 Windows 使用 JDK 21、Android API 36 的 `android.jar` 和 Android SDK Build Tools 36。將簽署金鑰密碼設為目前 PowerShell 程序的 `STUDYMATE_KEYSTORE_PASSWORD` 環境變數，然後在儲存庫執行下列指令。請保存簽署金鑰，後續版本需要使用同一把金鑰才可覆蓋安裝。

```powershell
.\android\build-apk.ps1 -JdkHome $jdk -PlatformJar $platformJar -BuildTools $buildTools `
  -OutputApk $outputApk -KeyStore $keyStore -KeyAlias $keyAlias
```

上傳 Google Play 時使用 Android App Bundle。額外準備 Google Maven 的 AAPT2 及 bundletool，然後執行下列指令。[Android App Bundle 指南](https://developer.android.com/build/building-cmdline#build_bundle)

```powershell
.\android\build-apk.ps1 -JdkHome $jdk -PlatformJar $platformJar -BuildTools $buildTools `
  -OutputAab $outputAab -Aapt2Path $mavenAapt2 -BundleTool $bundletool `
  -KeyStore $keyStore -KeyAlias $keyAlias
```

Google Play 可使用 [StudyMate 隱私權政策](https://couach-production.up.railway.app/privacy) 和 [刪除帳號頁](https://couach-production.up.railway.app/delete-account)。使用者可以從「我的帳號」進入刪除流程。第一次發布、編輯邀約、提出加入申請、儲存個人資料或開始配對前，需閱讀並同意[共讀守則](https://couach-production.up.railway.app/community-rules)。

登入頁、導覽和瀏覽器分頁使用同一個黃色書本標誌 `assets/icon.svg`。
「校園精選」的咖啡廳插畫 `assets/campus-cafe.webp` 由內建 ImageGen 生成，以復古紙感描繪窗邊的咖啡、筆記本與校園拱廊。
精選區的小書本角色 `assets/campus-mascot.webp` 由內建 ImageGen 生成，以暖黃書封、奶油白紙頁、深青書籤與粗墨線繪製成透明貼紙。
