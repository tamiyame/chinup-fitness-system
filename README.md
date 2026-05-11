# Chin-Up Fitness · 團體課程報名系統

精簡的團體健身課程報名系統，涵蓋管理者排課、會員報名、滿員候補、截止成班判定、多通道通知。

## 功能特色

- **排課範本**：管理者設定每週 / 每月 / 每兩個月 / 每季 / 每半年的循環課程，指定星期幾、時間、時長、週期起訖日，系統自動展開所有實際場次。
- **人數管理**：每場次可設人數下限與上限。未達下限 → 課程取消；已達上限 → 後續報名進入候補。
- **候補遞補**：正取取消時，候補第一位自動遞補為正取並發通知。
- **截止判定**：報名截止時間到（預設開課前 24h），系統自動判斷成班 / 取消。
- **通知**：報名成功、進入候補、遞補成功、課程成立、課程取消、上課前提醒，依會員偏好寄 Email / SMS（本專案以 DB log + console 模擬）。
- **帳號系統**：Email + 密碼登入（scrypt 雜湊）、token session、角色分級（admin / user）。
- **管理後台**：儀表板統計、範本 CRUD、場次名單、手動觸發截止與提醒、通知紀錄檢視。

## 一對一預約模組（Phase 1）

教練自助管理班表 + 會員瀏覽教練線上預約。

### 新角色：coach

- 介於 `admin` 和 `user` 之間
- 自助登入後可改 profile、設可預約時段、看自己的預約、緊急取消
- 不能管其他教練或會員（限 admin 以上）

### 功能流程

1. 註冊時勾選「我是教練」→ 帳號為 coach，待 admin 啟用
2. Admin 在 `/admin.html` → 「教練管理」啟用、或把現有 user 升為教練
3. 教練在 `/coach.html` 設可預約時段（每週基底 + 例外覆寫）
4. 會員在 `/coaches.html` 瀏覽教練 → 點開詳細 → 選 60 分鐘時段 → 預約
5. 會員 / 教練在 `/my-bookings.html` / `/coach.html` 看到預約並可取消

### 設定預設值（Phase 1 寫死於程式碼）

| 設定 | 值 |
|---|---|
| Slot 長度 | 60 分鐘 |
| Buffer | 預約時不能選 < 2 小時後的時段 |
| Window | 預約只能往後 30 天 |
| 點數 | Phase 1 不接，Phase 2 再加 |
| 取消 | 隨時可取消，policy 是無條件退點（Phase 1 純取消，無退點動作） |

### 設計 / 計畫文件

- `docs/superpowers/specs/2026-05-11-one-on-one-booking-design.md`
- `docs/superpowers/plans/2026-05-11-one-on-one-booking.md`

## 點數系統（Phase 2）

點數作為預約的「貨幣」，admin 手動加點、會員預約扣點、取消退點。

### 兩個池子（獨立）

- **一對一池子**：扣減於一對一預約 / 退於一對一取消
- **團體池子**：扣減於團體報名（含候補）/ 退於團體取消、不成班自動退

### 模型

單一 `point_transactions` 表，每筆加減點是一個有號 row。當前餘額 = `SUM(amount) WHERE member_id = ? AND pool = ?`。所有寫入用 `tx() BEGIN IMMEDIATE`，post-insert 餘額 < 0 → rollback。

### Admin 操作

`/admin.html` 會員管理 section：
- 看每人 PT/團體 餘額
- 「加點」按鈕：pool 選一對一 / 團體、金額（可負）、必填備註
- 「歷史」按鈕：看該會員最近 100 筆交易（含 source、actor、note）

### 會員體驗

- Navbar 右上角膠囊：`[PT N · 團 M]`，0 點時紅字
- 預約 / 報名頁：餘額 0 → 確認鈕 disabled，提示「請聯絡管理員儲值」
- 取消預約 / 報名 → 自動退點，無條件、無時限

### 設計 / 計畫文件

- `docs/superpowers/specs/2026-05-12-points-system-design.md`
- `docs/superpowers/plans/2026-05-12-points-system.md`

### Phase 2 部署 SOP（**一次性、僅限本次 dev 階段**）

```bash
# 在 Railway shell 跑
rm -f data/app.db && node src/db/migrate.js && node src/db/seed-demo.js
```

下次 schema 變動必須走真正的 migration，**不能再清 DB**。

## 技術棧

| 層 | 技術 |
|---|---|
| 後端 | Node.js 24 (ESM) · Express · `node:sqlite` (內建) · node-cron |
| 資料庫 | SQLite（WAL mode、手動 transaction） |
| 密碼 | Node 內建 `crypto.scrypt` + 32-byte session token |
| 前端 | Vanilla JS (ES module) · 自建 CSS design system · Tailwind CDN（輔助 layout）|
| 字型 | Inter + Noto Sans TC |

## 快速開始

```bash
# 安裝依賴
npm install

# 初始化資料庫（schema + 示範資料）
npm run migrate
node src/db/seed-demo.js    # 或 npm run seed 只建立帳號

# 啟動 server
npm start                   # http://localhost:3000
```

### 測試帳號

| 角色 | 帳號 | 密碼 |
|---|---|---|
| 管理者 | `admin@chinup.local` | `admin1234` |
| 會員 | `user{1..12}@chinup.local` | `pass1234` |

### 測試

```bash
node tests/flow.test.js          # 團體課核心流程單元測試
node tests/booking-flow.test.js  # 一對一 + 點數系統單元測試
node tests/api.test.js           # 既有 HTTP API 整合測試（需 server 先啟動）
node tests/booking-api.test.js   # 一對一 + 點數 HTTP 整合測試（同上）
```

## 架構

```
src/
  server.js                 # Express app + auth middleware + 路由
  scheduler.js              # node-cron: 每小時截止、每日 09:00 提醒
  db/
    connection.js           # SQLite + tx() helper + nowLocal()
    migrate.js              # schema 建立
    seed.js / seed-demo.js  # 基本/示範資料
  services/
    auth.js                 # scrypt 雜湊 + session 管理
    courseService.js        # 範本 CRUD、場次展開、截止判定、提醒
    registration.js         # 報名、取消、候補遞補（transaction-safe）
    schedule.js             # 純函式：依 recurrence 展開場次
    notifications.js        # 通知模板 + 扇出（email/sms）
public/
  login.html / index.html / my.html / admin.html
  app.js                    # auth helpers + bootAuth + API client
  courses.js / admin.js
  style.css                 # 設計系統 (design tokens + components)
tests/
  flow.test.js api.test.js
```

### 資料模型

- **users** — id, name, email (unique), phone, password_hash, role, notification_preference
- **auth_sessions** — token (PK), user_id, expires_at
- **course_templates** — 課程範本（人數、星期、時間、週期）
- **course_sessions** — 展開後的實際場次（含 status、人數快取）
- **registrations** — 報名紀錄（status: confirmed / waitlisted / cancelled / rejected）
- **notifications** — 通知 log

### 核心流程

- **報名**：transaction 內鎖 session，confirmed_count < max → 正取；否則進候補。
- **取消**：正取取消 → 候補第一位自動轉正取並發通知；候補序號重新整理。
- **截止（每小時）**：deadline 到 → 若 confirmed ≥ min → 成班通知；否則 cancel session，所有報名者標 rejected + 通知。
- **提醒（每日 09:00）**：24 小時內的 confirmed 場次 → 寄提醒給正取名單（避免重複）。

## API

### Auth
- `POST /api/auth/login` `{ email, password }` → `{ token, user }`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### 會員
- `GET /api/sessions` — 瀏覽可報名場次
- `POST /api/sessions/:id/register` — 報名
- `DELETE /api/registrations/:id` — 取消
- `GET /api/my/registrations` — 我的報名

### 管理者
- `GET|POST /api/admin/templates` — 範本 CRUD
- `PATCH /api/admin/templates/:id`
- `GET /api/admin/templates/:id` — 含所有場次
- `GET /api/admin/sessions/:id/registrations` — 名單
- `GET /api/admin/notifications` — 通知紀錄
- `POST /api/admin/jobs/process-deadlines` — 手動截止判定
- `POST /api/admin/jobs/send-reminders` — 手動寄提醒

## 部署到 Railway

本專案已備好 `railway.json` 與自動 schema / admin 初始化。步驟：

1. 到 [Railway](https://railway.com) 新建專案 → Deploy from GitHub repo → 選本 repo
2. **環境變數**（Settings → Variables）：
   ```
   ADMIN_EMAIL=你的email
   ADMIN_PASSWORD=強密碼
   DB_PATH=/app/data/app.db
   ```
3. **Volume**（Settings → Volumes）：掛到 `/app/data`（儲存 SQLite，避免每次重啟遺失）
4. **Domain**（Settings → Networking → Generate Domain）：拿到 `https://xxx.up.railway.app`

系統啟動時會自動建立 schema 並依環境變數建立管理員；未設定 env 則建立預設 `admin@chinup.local / admin1234` 並印警告。

## License

MIT
