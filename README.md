# CHINUP Performance · 健身房預約管理系統

小型健身房的一站式預約系統：**一對一教練課**（免註冊預約、循環排課、付款核對、Google 日曆雙向同步）＋**團體課程**（循環排課、匯款訂單、候補遞補）＋ LINE / Email 通知 ＋ 完整管理後台。

## 系統總覽

| 入口 | 對象 | 說明 |
|---|---|---|
| `/coaches.html` | 顧客（免登入） | 一對一教練課預約：選教練 → 選時段 → 姓名＋電話送出 |
| `/group.html`（首頁入口） | 顧客（免登入） | 團體課程報名：勾場次 → 產生匯款訂單 |
| `/my-schedule` | 顧客（免登入） | 姓名＋電話查課表、取消預約/報名、團課請假 |
| `/coach.html` | 教練 | 班表管理（每週基底＋請假/加開）、預約清單、LINE 綁定 |
| `/admin.html` | 管理者 | 分頁籤後台：總覽／課程／報名作業／會員／教練／折扣碼／通知 |

**身分模型**：顧客不需帳號（以「電話」為身分、姓名驗證）。員工角色只有 `user`／`coach` 兩種，**管理者＝帶 `is_admin` 標籤的教練**；員工以 Email＋密碼或 Google 帳號登入。

## 功能特色

### 一對一教練課

- **班表引擎**：教練自助設定每週基底班表（可多時段）＋特殊日期（整天/部分時段請假、加開），60 分鐘 slot、2 小時預約緩衝、**預約日期無上限**。
- **全店容量上限**：以整點切桶，每小時全店（跨教練）最多 N 人（後台可調，預設 3）；1對1 佔 1 名額、1對2 佔 2 名額，非整點預約同時佔兩個桶。
- **1對1／1對2 方案**：單堂價各自於後台設定，預約時切換。
- **付款狀態流**：預約成立＝「待確認」→ 出現在後台「待核對匯款」→ 管理者按「已收款」→ 顧客收 LINE/Email 通知、狀態轉「已確認」、紀錄移入「已核對匯款」（含核對時間與經手人）。已核對卡片**長按**可「取消預約並退款」。
- **循環預約（員工限定）**：教練/管理者在預約彈窗勾「開啟循環預約」——每日/每週/每月/自訂間隔 × 最多 52 次，**預覽逐場狀態後跳過衝突建立**；可勾「款項已收」直接全批標已核對；同一批在待核對/已核對清單**集中一張卡**，支援整批收款/取消/退款。
- **防撞期**：送出時重新驗證時段合法性（班表/請假/容量/同教練重疊/日曆封鎖），DB 唯一索引＋交易內容量檢查兜底併發。

### 團體課程

- **排課範本**：每週／每月／每兩月／每季／每半年循環，指定授課教練，自動展開場次；單一場次可手動開放/關閉。
- **匯款訂單**：免登入勾選多場次 → 產生訂單（顯示匯款資訊與付款期限，**期限後台可調，預設 72 小時**，逾期自動取消釋出名額）；純候補不產生訂單。
- **候補遞補**：名額釋出（取消/請假/退款/逾期）自動遞補最早候補者 → 產生 24 小時付款單回到「待核對匯款」；**同會員連續遞補自動併單**（一張卡、一次匯款、一則通知）。
- **成班判定**：報名截止（預設開課前 24h）自動判斷成班／未達最低人數取消並通知（每小時 cron＋後台手動觸發）。
- **團課請假**：已付款會員可於開課前請假，釋出名額遞補、不退款。

### Google 整合（皆為選配，未設定時自動停用）

- **Google 日曆雙向同步**（Service Account，零 npm 依賴）：
  - 預約成立自動建立日曆事件（冪等 ID，取消自動刪除，5 分鐘 reconcile cron 兜底）
  - 系統事件標記「有空」(transparent) → 你在日曆**手動建立的「忙碌」活動會封鎖可預約時段**（freebusy），手動活動改「有空」即不擋
- **Gmail 確認信**（OAuth refresh token，後台一鍵授權）：預約確認信（Email 選填）、款項確認信、循環預約摘要信；失敗走通知重試佇列。

### 通知

- **LINE Messaging API**：預約/取消/款項/遞補/成班等近 30 種模板；顧客以 6 位數綁定碼綁定官方帳號；員工後台自助綁定。失敗自動退避重試（5/15/45 分鐘，3 次後標永久失敗）。
- **Email**（Gmail API）：與 LINE 共用通知重試機制。
- 未綁定/未設定 → console 紀錄 fallback，通知一律落 `notifications` 表可後台檢視。

### 折扣碼

百分比／定額兩種，支援啟用區間、總量上限、每人上限、最低消費；適用團課訂單與教練課（含循環預約**逐堂套用**，額度用罄自動回原價，前端顯示「X 堂折扣＋Y 堂原價」混合估價）。

### 管理後台（分頁籤）

- **總覽**：營運統計
- **課程**：範本 CRUD、場次名單（依報名時間新→舊）、單場開關
- **報名作業**：待核對匯款（團課訂單＋教練課合併清單、課程名稱分組）、已核對匯款（長按退款）、系統操作（手動截止/提醒，附「?」說明）
- **會員**：即時搜尋（姓名/電話）、長按編輯（含角色/管理者標籤變更）、軟刪除封存（同電話再預約自動還原）
- **教練**：啟用/停用、資料編輯、降為一般用戶
- **折扣碼**：CRUD＋使用統計；**營運設定**：單堂價、匯款帳號、官方 LINE 連結、團課付款期限、Google 日曆 ID、每小時容量、Gmail 授權
- **通知**：發送紀錄

## 技術棧

| 層 | 技術 |
|---|---|
| 後端 | Node.js ≥ 24（ESM）· Express 4 · `node:sqlite`（內建）· node-cron |
| 資料庫 | SQLite（WAL、`BEGIN IMMEDIATE` 交易、開機冪等遷移） |
| 外部 API | LINE Messaging API、Google Calendar v3、Gmail v1 —— **全部零 npm 依賴**（native fetch ＋ `node:crypto` RS256/HMAC） |
| 密碼/Session | `crypto.scrypt` ＋ 32-byte token |
| 前端 | Vanilla JS（ES module）· 自建 CSS design system · Tailwind CDN 輔助 |

唯二的 npm 依賴：`express`、`node-cron`。

## 快速開始

```bash
npm install
npm run seed                # 建立 schema + 初始管理者
node src/db/seed-demo.js    # （選用）示範課程/教練/預約資料
npm start                   # http://localhost:3000
```

### 測試帳號（本地預設）

| 角色 | 帳號 | 密碼 |
|---|---|---|
| 管理者 | `admin@chinup.local` | `admin1234` |

顧客端免帳號：任何姓名＋電話即可預約/報名，`/my-schedule` 以同組姓名電話查詢。

### 測試

```bash
# 單元測試（離線；會清掉本地 data/app.db 的 demo 資料，跑完請重新 seed）
npm test

# API 整合測試（需先以 mock 環境啟動 server）
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id PORT=3100 node src/server.js &
BASE=http://localhost:3100 npm run test:api
```

## 環境變數

| 變數 | 必要性 | 說明 |
|---|---|---|
| `PORT` | 選 | 預設 3000（Railway 自動注入） |
| `DB_PATH` | 部署必須 | SQLite 路徑；Railway 掛 Volume 後設 `/app/data/app.db` |
| `TZ` | 部署必須 | `Asia/Taipei`（Dockerfile 已內建，平台再設一次保險） |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | 建議 | 開機建立初始管理者；未設則建預設帳號並印警告 |
| `PUBLIC_URL` | 建議 | 對外網址（OAuth redirect、信件連結用） |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE 功能 | LINE Messaging API 憑證 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 功能 | OAuth 用戶端（員工 Google 登入＋Gmail 授權共用） |
| `GCAL_SERVICE_ACCOUNT_JSON` | 日曆同步 | Service Account JSON 金鑰（原始 JSON 或 base64） |
| `GMAIL_REFRESH_TOKEN` | 寄信 | 後台「Gmail 寄信授權」取得後貼入 |
| `GMAIL_FROM` | 選 | 寄件顯示名稱，如 `CHINUP Performance <you@gmail.com>` |
| `LINE_MOCK` / `GCAL_MOCK` / `GMAIL_MOCK` | 測試 | `1`=模擬成功、`fail`=模擬失敗（離線測試用） |

## Google 整合設定（一次性）

1. GCP 專案啟用 **Calendar API** 與 **Gmail API**。
2. **日曆同步**：建 Service Account → 下載 JSON 金鑰 → 設 `GCAL_SERVICE_ACCOUNT_JSON`；店家 Google 日曆「設定與共用」把 SA email 加為「**進行變更**」；後台營運設定填入日曆 ID（留空＝關閉同步）。啟用後 5 分鐘內既有未來預約自動補建事件。
3. **Gmail 寄信**：OAuth 用戶端加 redirect URI `{PUBLIC_URL}/api/admin/gmail-auth/callback`；同意畫面**發布為正式版**（測試模式 refresh token 7 天過期）；後台按「Gmail 寄信授權」→ 將顯示的 refresh token 貼到 `GMAIL_REFRESH_TOKEN`。

## LINE 設定（一次性）

1. [LINE Developers](https://developers.line.biz/) 建 Messaging API channel，取得 access token 與 channel secret 設入環境變數。
2. Webhook URL 設 `https://<domain>/api/line/webhook`、開啟 Use webhook、關閉自動回覆與加好友歡迎訊息。
3. 後台營運設定填「官方 LINE 加入連結」；顧客預約成功頁會拿到 6 位數綁定碼，加好友後貼上即完成綁定。

## 排程（node-cron，`src/scheduler.js`）

| 排程 | 頻率 | 工作 |
|---|---|---|
| 截止判定 | 每小時 | 成班/未達人數取消＋通知 |
| 上課提醒 | 每日 09:00 | 24 小時內場次提醒 |
| 訂單逾期 | 每 10 分鐘 | 逾期未付訂單取消、釋名額遞補 |
| 通知重試 | 每 5 分鐘 | LINE/Email 失敗退避重試 |
| 日曆 reconcile | 每 5 分鐘 | 補建/補刪 Google 日曆事件 |
| 備份 | 每週日 03:00 | `VACUUM INTO` 快照至 `data/backups/` |

## 架構

```
src/
  server.js                # Express app、auth middleware、全部路由
  scheduler.js             # node-cron 排程
  db/
    connection.js          # SQLite + 開機冪等遷移 + tx()/nowLocal()
    schema.js  seed.js  seed-demo.js
  services/
    auth.js                # scrypt + session + Google 登入 + 初始管理者
    availabilityService.js # 班表/請假/加開、slot 計算、容量桶、預約守門
    bookingService.js      # 一對一預約/取消/付款核對/退款/循環預約/整批操作
    courseService.js       # 團課範本/場次展開/截止判定/提醒
    groupOrderService.js   # 團課訂單/候補遞補/逾期/退款/公開課表
    registration.js        # 登入會員報名（legacy 路徑）+ ApiError
    discountService.js     # 折扣碼 + app_settings 存取
    notifications.js       # 通知模板/分流/重試
    lineClient.js  lineBindingService.js
    googleAuth.js  gcalClient.js  gcalSync.js   # Google 日曆（零依賴）
    gmailClient.js  emailService.js              # Gmail 寄信（零依賴）
    userService.js  coachService.js  backupService.js
public/
  index.html  group.js          # 團課報名
  coaches.html  coaches.js      # 一對一預約（含循環預約）
  my-schedule.html  my-schedule.js
  coach.html  coach.js          # 教練後台
  admin.html  admin.js          # 管理後台
  login.html  app.js  style.css
tests/                          # 30+ 測試檔（npm test / npm run test:api）
docs/superpowers/specs|plans/   # 各功能設計與實作計畫文件
```

### 資料模型（核心表）

- **users** — 顧客（電話身分）與員工（email 登入）；`role` user/coach、`is_admin` 標籤、LINE 綁定欄位、封存
- **coaches** — 教練檔案（user 1:1）、啟用狀態
- **coach_availability_rules / _exceptions** — 每週基底班表／請假與加開
- **bookings** — 一對一預約：時段、方案、折扣、`paid_at/paid_by`（付款核對）、`refunded_at/by`、`gcal_event_id`、`recurring_group_id`（循環批次）
- **course_templates / course_sessions** — 團課範本與展開場次
- **group_orders / registrations** — 匯款訂單與報名列（pending/confirmed/waitlisted/cancelled、請假標記）
- **discount_codes / discount_redemptions** — 折扣碼與兌換紀錄
- **notifications** — 全通道通知 log（channel: line/email/console、重試欄位）
- **app_settings** — 營運設定 KV（單堂價、匯款資訊、LINE 連結、日曆 ID、容量、訂單期限）

## 部署（Railway）

1. Deploy from GitHub repo（push `main` 即自動部署）。
2. Volume 掛載 `/app/data`，環境變數至少設：`DB_PATH=/app/data/app.db`、`TZ=Asia/Taipei`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`。
3. 其餘整合（LINE／Google）依上方各節逐步啟用——全部都是選配，未設定不影響核心預約功能。
4. Schema 遷移於開機自動執行（冪等）；每週自動備份，破壞性變更前請先手動備份 Volume 中的 DB。

## License

MIT
