# StudyMate 校園共讀

校園讀書夥伴媒合網站，可在手機和桌面上使用。支援暨大、台大、成大、彰師大和高大。

## 本機啟動

需要 Node.js 24 以上。在儲存庫目錄執行 `npm ci` 和 `npm start`，再開啟 [StudyMate](http://localhost:8000/)。伺服器會建立本機 SQLite 資料庫 `data/studymate.sqlite`。

## 使用流程

- 登入後可先切換校園，再查看共讀邀約。桌面會並排顯示邀約和地圖，手機可用「看地圖」切換。點選區域圖釘可篩選邀約，滑鼠滾輪或「＋」「−」可縮放底圖。從「校園精選」可直接開啟附近咖啡廳的地圖或讀書空間。各校的精選地點與資料來源收錄在 `campus-places.mjs`。
- 啟用 Google 登入後，點選「使用 Google 帳號登入」，再從 Google 選擇一般 Gmail 或支援學校的帳號。既有使用者可用舊 StudyMate 帳號進行一次安全連結，保留原有資料。部署尚未設定 Google 登入時，仍提供信箱與密碼登入。
- 使用「即時找夥伴」查看其他人發起、正在招募且可加入的邀約。沒有符合場次時，可選擇「現在發起一團」或「看可預約時段」。可從結果旁的標籤逐一移除篩選條件，線上共讀不限校園區域。
- 查看邀約並送出加入申請。主揪可在「我的預約」確認申請，參加者可以取消或於開始後標記為完成。
- 從搜尋結果發起邀約時會帶入校園、科目和共讀方式。實體場次會帶入已選的校園區域，仍可手動修改。草稿會在同一分頁重新開啟表單時恢復。已發布且仍開放的邀約可在「我的預約」編輯標題、地點與說明。
- 使用「專注計時」啟動番茄鐘並累積專注紀錄，或透過「讀書空間」查看校園地點。

媒合度依照時段重疊 35%、區域距離 25%、科目關聯 20% 和共讀習慣 20% 計算。區域距離以同一校園的公共標記估算，網站不要求 GPS 權限。每校的地圖中心、區域標記與驗證網域集中在 `campuses.mjs`。

密碼以獨立 salt 加上 scrypt 儲存。帳號、邀約、預約、已完成的專注紀錄、檢舉與封鎖儲存在伺服器，並依照帳號權限讀取。配對卡片只顯示主揪暱稱、科系和選擇的概略校園區域。

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

登入頁、導覽和瀏覽器分頁使用同一個黃色書本標誌 `assets/icon.svg`。
「校園精選」的咖啡廳插畫 `assets/campus-cafe.webp` 由內建 ImageGen 生成，以復古紙感描繪窗邊的咖啡、筆記本與校園拱廊。
