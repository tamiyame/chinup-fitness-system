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
node tests/flow.test.js     # 核心流程單元測試（12 項）
node tests/api.test.js      # HTTP API 整合測試（17 項，需 server 先啟動）
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

## License

MIT
