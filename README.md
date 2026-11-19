# StudyMate 校園共讀

以國立暨南國際大學為示範校園的讀書夥伴媒合網站，可在手機和桌面上使用。

## 本機啟動

需要 Node.js 24 以上。在儲存庫目錄執行 `npm ci` 和 `npm start`，再開啟 [StudyMate](http://localhost:8000/)。伺服器會建立本機 SQLite 資料庫 `data/studymate.sqlite`。

## 使用流程

- 登入後首先開啟校園地圖。點選圖書館、學院或宿舍周邊的圖釘，可篩選該公共區域的邀約；地圖以 OpenStreetMap 為底圖。
- 啟用校園登入後，學生使用學校的 Google 帳號登入。既有學生可用舊 StudyMate 帳號進行一次連結，保留原有資料。如果部署尚未設定校園登入，會提供原有的信箱與密碼登入。
- 使用「即時找夥伴」查看正在招募的邀約，或選擇「可預約」瀏覽未來的邀約。也可以依科目、科系、區域、共讀方式與習慣篩選。
- 查看邀約並送出加入申請。主揪可在「我的預約」確認申請，參加者可以取消或於開始後標記為完成。
- 使用「發起邀約」建立實體或線上共讀，可選擇現在開始、預約時間、一對一或小團體。
- 使用「專注計時」啟動番茄鐘並累積專注紀錄，或透過「讀書空間」查看校園地點。

媒合度依照時段重疊 35%、區域距離 25%、科目關聯 20% 和共讀習慣 20% 計算。區域距離使用示範區域偏移量估算，網站不要求 GPS 權限。

密碼以獨立 salt 加上 scrypt 儲存。帳號、邀約、預約、已完成的專注紀錄、檢舉與封鎖儲存在伺服器，並依照帳號權限讀取。配對卡片只顯示主揪暱稱、科系和選擇的概略校園區域。

## Railway 部署

1. 從 [GitHub 部署頁](https://railway.com/new/github) 選擇 `hfrouty/couach` 的 `main` 分支。`Dockerfile` 提供 Node.js 24 的執行環境。
2. 在服務上新增 Volume，掛載到 `/app/data`。SQLite 檔案寫入該 Volume，請保持單一服務副本。應用程式會等到持久掛載可用後才接受註冊。
3. 在服務的 Settings 設定健康檢查路徑 `/health`、產生公開網域，再部署變更。伺服器會自動使用 Railway 的 `PORT`。
4. 使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 產生一次性啟用碼，保存在 Railway 服務變數 `ADMIN_SETUP_TOKEN` 後重新部署。啟用碼請留在自己的終端機與 Railway 變數中。
5. 打開公開網域的 `/admin`，輸入啟用碼並自訂管理員電子郵件與至少 12 個字元的密碼。第一個管理員建立後，後續的建立請求會被拒絕。之後可移除 `ADMIN_SETUP_TOKEN`，並使用同一頁面登入、查看帳號和處理檢舉。

本機也能測試管理員設定。在啟動前設定 `ADMIN_SETUP_TOKEN` 環境變數，使用至少 32 個字元的隨機碼，然後開啟 [本機管理後台](http://localhost:8000/admin)。

### 啟用校園登入

目前支援國立暨南國際大學學生的 Google 校園帳號 `s學號@mail1.ncnu.edu.tw`。此驗證確認校園 Google 帳號身分。學籍狀態須由學校另外確認。[暨大計算機與網路中心](https://cc.ncnu.edu.tw/p/412-1001-1059.php?Lang=zh-tw)

1. 在 Google Cloud 建立「網頁應用程式」OAuth 用戶端，完成 Google 所需的同意畫面和網域設定。[Google OpenID Connect 文件](https://developers.google.com/identity/openid-connect/openid-connect)
2. 將 `https://couach-production.up.railway.app/api/auth/campus/callback` 加到授權的重新導向 URI。若改用自訂網域，請把 URI 和 Railway 的 `STUDYMATE_PUBLIC_ORIGIN` 一起改成該正式網域。
3. 把用戶端 ID 與密鑰各自存到 Railway 的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 服務變數，重新部署後再以實際校園帳號驗證登入。兩個變數都設定時，學生註冊與共讀功能會要求校園登入，既有帳號仍可登入進行連結。

StudyMate 只要求 `openid` 和 `email` 權限。正式使用 Google 登入前，請依 Google 的應用程式發布規定設定可驗證的網域；學校也可能依 Workspace 政策限制第三方登入。[Google OAuth 政策](https://developers.google.com/identity/protocols/oauth2/policies)

首頁圖片位於 `assets/library-study.webp`，使用 ImageGen 生成。生成方向為台灣大學圖書館的午後場景，窗外有綠意與遠山，右側深色木桌上擺放翻開的書、書堆、鉛筆與陶瓷咖啡杯。
