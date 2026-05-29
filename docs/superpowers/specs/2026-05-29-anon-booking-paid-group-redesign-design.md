# 匿名預約 + 付費團體課 + 電話查詢 重設計

**Date**: 2026-05-29
**Author**: brainstorm with user
**Supersedes**: `2026-05-23-anon-booking-redesign-design.md`（及其 plan）— 該版未落地，本版取代之
**Scope**: 全站改成「客人匿名預約（姓名+電話）/ 教練+admin 才登入」；團體課改為「選具體場次 → 計費 → 匯款 → admin 核對」；點數機制移除，改用單堂價格

---

## 1. 動機

系統對一般客人太重：要先註冊、登入才能預約。改成客人直接從首頁進入預約、只在最後填姓名+電話即完成（同時建帳號），用電話當後續識別。團體課加入「選場次 + 匯款」的真實付費流程，取代抽象點數。admin 登入時 navbar 不該再出現「教練後台」（既有 bug）。

---

## 2. 設計決策（brainstorm 已逐項與 user 確認）

| 決策 | 結果 |
|-----|------|
| 客人識別 | **電話號碼當 key** — find-or-create。**不做電話→姓名 prefill**（避免公開 API 外洩姓名） |
| 姓名 | **以首次建立為準、不被覆蓋**。回頭客再預約只用電話對應帳號，忽略這次輸入的姓名 |
| 查詢身份 | **電話 + 姓名兩者都對**（姓名比對 trim + 大小寫不敏感）。姓名為軟性第二因子 |
| 信任模型 | 知道某支電話+姓名的人可查/取消該電話的預約。小型熟客健身房可接受 |
| 登入 | **只剩 admin / coach**（email+密碼）。`role='user'` 一律不能登入。註冊功能移除 |
| 點數 | **移除程式邏輯 + `member_point_balance` view**；**`point_transactions` 表保留**（存查、不再寫入/讀取） |
| 「剩 X 堂」 | 由**已付款且未上的場次數**算出（不靠點數池） |
| 1v1 | 選教練→選時段→填姓名+電話，**無付款、現場收費** |
| 團體課 | 選具體場次（全週期或單選）→ 計總額 → 匯款頁 → 送出建 **pending 訂單** → admin 核對匯款 → confirmed |
| 名額計算 | **即時查詢**（pending+confirmed 且訂單未過期），不靠 `confirmed_count` 計數器 |
| 佔名額 | 一送出即佔（含 pending），避免超賣 |
| pending 逾時 | pending 訂單 **6 小時** 未付自動釋出（lazy 計算 + sweep job） |
| 候補 | **保留**。候補不付款；遞補（FIFO）後客人自己查詢再付款 |
| 遞補逾時 | 遞補產生的 pending 給 **24 小時** 付款期限，逾時再遞補下一位 |
| 取消 | 客人可自行取消未來預約：未付 pending 訂單只能整筆放棄；已付 confirmed 單堂、候補單堂可個別取消 |
| LINE 通知 | **選配**。成功頁顯示 6 位綁定碼（沿用 `lineBindingService`+webhook）；未綁走 console（等於沒通知、自己查） |

---

## 3. Backend 設計

### 3.1 Schema 變更

部署前**先備份 DB**。`connection.js` 啟動時 idempotent 套用。

**(a) `users` — email 改 nullable（整表 rebuild）**
SQLite 不能直接 `DROP NOT NULL`。偵測 `users.email` 是否仍 NOT NULL（`PRAGMA table_info`），若是則走 rebuild recipe：
```
PRAGMA foreign_keys = OFF;
BEGIN;
  DROP VIEW IF EXISTS member_point_balance;   -- 本次本來就要刪
  CREATE TABLE users_new (... email TEXT UNIQUE ...);   -- 去掉 NOT NULL，其餘不變
  INSERT INTO users_new SELECT ... FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  -- recreate users 上的所有 index（idx_users_line_user_id 等）
COMMIT;
PRAGMA foreign_keys = ON;
```
`schema.js` 的 fresh-create 同步把 `email TEXT UNIQUE NOT NULL` → `email TEXT UNIQUE`。
`BEGIN` 必須在 `try` 內，確保 FK pragma 不會卡在 OFF。

**(b) `registrations` — status 加 `pending`、加 `order_id` / `amount_due`（整表 rebuild）**
CHECK 約束不能 ALTER，且要加欄位，一次 rebuild：
```
status TEXT NOT NULL CHECK(status IN ('pending','confirmed','waitlisted','cancelled','rejected'))
order_id   INTEGER REFERENCES group_orders(id)     -- 候補時為 NULL
amount_due INTEGER                                 -- 此筆金額快照；候補時為 NULL
```
偵測欄位是否已存在以決定是否 rebuild（idempotent）。

**(c) `course_templates` — 加單堂價（addColumn）**
```sql
ALTER TABLE course_templates ADD COLUMN price_per_session INTEGER NOT NULL DEFAULT 0;
```

**(d) `group_orders` — 新表**
```sql
CREATE TABLE IF NOT EXISTS group_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  customer_name TEXT NOT NULL,         -- 下單當下快照
  customer_phone TEXT NOT NULL,        -- 下單當下快照
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
  expires_at TEXT NOT NULL,            -- created_at + 6h（遞補單為 +24h）
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_orders_status ON group_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_group_orders_member ON group_orders(member_id);
```

**(e) 電話唯一索引（partial）**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
```
放在 `schema.js` 的 `SCHEMA`（無 migration 相依）。

**(f) `member_point_balance` view — DROP 且不重建。`point_transactions` 表保留不動。**

### 3.2 新 service：`userService.js`
```js
// find-or-create user by phone，供 1v1 / group 公開寫入共用。整段包在 tx() 裡。
export function findOrCreateUserByPhone({ phone, name }) {
  // 1) 查現有 user with this phone
  // 2) 有 → 直接 return（姓名不覆蓋，符合「首次為準」）
  // 3) 無 → INSERT (name, phone, email=NULL, password_hash=NULL, role='user') → return new id
}
export function getUserByPhoneAndName({ phone, name }) {
  // 查詢用：phone 完全相符 AND lower(trim(name)) 相符。找不到 return null
}
```
phone 驗證：`/^\d{8,15}$/`（純數字 8–15 碼）。前端送出前 normalize（去 `+`、`-`、空白）。

### 3.3 團體課 service（`registration.js` 擴充 / 新 `groupOrderService.js`）

**名額即時計算**（單一 helper）。所有團體報名都帶 `order_id`（pending 時為待付訂單、confirmed 時為已付訂單；waitlisted 為 NULL 不在此計）：
```
occupied(sessionId) = COUNT(registrations r
  JOIN group_orders o ON o.id = r.order_id
  WHERE r.session_id = ? AND r.status IN ('pending','confirmed')
    AND NOT (o.status='pending' AND o.expires_at < now))   -- 過期 pending 不算佔位
full(sessionId) ⟺ occupied >= template.max_capacity
```
候補（waitlisted）不計入 occupied。

**`createGroupOrder({ name, phone, paySessionIds[], waitlistSessionIds[] })`**（一個 tx）：
1. 驗 phone 格式；`findOrCreateUserByPhone`。
2. 對每個 `paySessionIds` 驗 `!full`（重新計算）→ 任一已滿 → `throw 409 { fullSessionIds }`，整批不寫。
3. 算 `total = Σ price_per_session`，建 `group_orders(status='pending', total, expires=+6h)`。
4. 每個 pay session 建 `registrations(status='pending', order_id, amount_due=price)`；UNIQUE(session_id,user_id) 衝突 → 該客已報過 → 回明確錯誤。
5. 每個 `waitlistSessionIds` 建 `registrations(status='waitlisted', order_id=NULL, amount_due=NULL)`。
6. 產 LINE 綁定碼（若 `!user.line_user_id`）。
7. 回 `{ orderId, total, bankInfo, expiresAt, waitlisted:[...], lineBindCode? }`。

`bankInfo`（收款銀行/帳號/戶名）為健身房固定資訊，存為設定常數（`config` 或環境變數），非每訂單變動。

**`confirmGroupOrder({ orderId, actorId })`**（admin）：order→`paid`、其 registrations→`confirmed`、`notify(customer, '匯款已收到，報名確認')`。

**`cancelGroupOrder({ orderId, phone, name })` / `cancelRegistration`**：驗 owner（phone+name）→ 釋出 → 觸發 `promoteWaitlist(sessionId)`。

**`promoteWaitlist(sessionId)`**：若 `occupied < max_capacity`，取最早 `waitlisted`（`registered_at` FIFO）→ 翻 `pending` → 為它建單堂 `group_orders(expires=+24h)` → `notify(customer, '您已遞補上 ⋯ 請於 24h 內匯款')`。

**`expirePendingOrders()`**（sweep）：`status='pending' AND expires_at < now` 的 order → `cancelled`、regs → `cancelled` → 對每個受影響 session `promoteWaitlist`。server 啟動掛 `setInterval`（每 ~10 分）+ 手動 `POST /api/admin/jobs/expire-orders`。

### 3.4 1v1 service（`bookingService.js` 擴充）
新增 `createBookingAnon({ coachId, startAt, name, phone, note })`：`findOrCreateUserByPhone` → 既有 `createBooking` 的核心建單 + 通知教練邏輯，**移除扣點**。`cancelBookingAnon({ bookingId, phone, name })`：驗 owner → 取消（無退點）。既有點數扣除/退費程式整段刪除。

### 3.5 Auth 收口
- `auth.js` `login()`：驗 password 後若 `user.role === 'user'` → `throw ApiError(403,'user_login_disabled')`。
- 刪 `POST /api/auth/register` route + handler + `registerLimiter` + `register.html` + 各頁註冊連結。
- `app.js` `bootAuth({ requireAdmin })` 維持；公開頁不再呼叫。

### 3.6 點數拆除清單
刪：`pointService.js`、`GET /api/my/points/balance`、`POST /api/admin/users/:id/points/grant`、`GET /api/admin/users/:id/points/transactions`、booking/registration 內所有 `recordTransaction`/扣點/退點。
`GET /api/admin/users`：移除 `member_point_balance` join 與 `one_on_one_balance`/`group_balance` 欄位，**保留 `line_user_id`**（PR #12）。
保留 `point_transactions` 表（不寫不讀）；DROP `member_point_balance` view。

### 3.7 通知觸發點
| 事件 | 對象 | 內容 |
|-----|-----|-----|
| 1v1 預約成功 | 教練（既有） | 維持現狀 |
| 團體課匯款核對通過 | 客人 | 「匯款已收到，報名確認」 |
| 候補遞補 | 客人 | 「您已遞補上 ⋯ 請於 24h 內完成匯款」 |
未綁 LINE → 走 console（無實際送達，客人自查）。

---

## 4. 公開 endpoints（無需 auth）

| Method | Path | Body / Query | 用途 |
|--------|------|--------------|------|
| GET | `/api/public/group-courses` | — | 課程卡（template 分組）：名稱、單堂價、各場次日期/已佔/上限/滿否 |
| POST | `/api/public/bookings` | `{coachId,startAt,name,phone,note?}` | 1v1 下單（find-or-create、無付款）→ 回 `{bookingId,startAt,endAt,lineBindCode?}` |
| POST | `/api/public/group-orders` | `{name,phone,paySessionIds[],waitlistSessionIds[]}` | 團體課送出 → §3.3；滿則 `409 {fullSessionIds}` |
| POST | `/api/public/my` | `{phone,name}` | 我的課表：未來/過去 booking + registration + order 狀態 + 剩 X 堂 |
| DELETE | `/api/public/bookings/:id` | `{phone,name}` | 取消 1v1 |
| DELETE | `/api/public/registrations/:id` | `{phone,name}` | 取消單筆 confirmed/waitlisted 團體報名 → 觸發遞補 |
| DELETE | `/api/public/group-orders/:id` | `{phone,name}` | 放棄整筆未付 pending 訂單 → 觸發遞補 |

既有公開讀取沿用：`GET /api/sessions`、`GET /api/coaches`、`/api/coaches/:id`、`/api/coaches/:id/availability`。

---

## 5. 前端設計

### 5.1 入口（首頁，公開）
兩張大卡：`團體課程` / `1對1個別指導`。

### 5.2 1v1 動線
卡 → `coaches.html`（公開列表）→ 選教練 → 看有空時段 → 選時段 → 填姓名+電話 → 成功頁（教練/時間 + LINE 綁定碼，無金額）。

### 5.3 團體課動線
卡 → 課程列表（`/api/public/group-courses`，課程卡=template）→ 展開看各場次（日期/時間/`已佔 N / 上限 M`，滿者標「額滿·可候補」）→ 全選整週期或單選 → 即時帶出總額 → 填姓名+電話+顯示匯款帳號 → 送出 → 成功頁（訂單號、總額、銀行帳號、`請於 X 前完成匯款`、候補者顯示「已加入候補」、LINE 綁定碼）。

### 5.4 我的課表（`/my-schedule`，公開）
輸電話+姓名查 → 列未來/過去場次，狀態 `待付款`/`已確認`/`候補中`/`已遞補待付款`；顯示 `1對1剩 X 堂 · 團體剩 Y 堂`（已付款未上場次數）；依取消規則顯示按鈕。電話+姓名存 localStorage 自動帶。

### 5.5 Navbar
公開頁：`[logo] [團體課] [1對1] [我的課表] [登入]`，登入鍵→`login.html`（文案「管理員 / 教練專用」）。
登入後修 bug：`app.js:136` → `const showCoach = user.role === 'coach';`，admin 連結僅 `['admin','owner']` 可見。結果：admin 只見「管理後台」、coach 只見「教練後台」。

### 5.6 頁面增刪
| 頁面 | 改動 |
|-----|------|
| `/` | 公開首頁，兩入口卡 |
| `coaches.html` | 公開（已是），接 1v1 modal |
| 團體課列表頁 | 公開化 + 選課/計費 UI |
| `/my-schedule` | 公開，電話+姓名查 |
| `register.html` | **刪除** |
| `/line.html` | **刪除**，加 301 → `/my-schedule`（綁定碼改在成功頁） |
| `admin.html` / `coach.html` | 不變（除 navbar 修正） |

---

## 6. Admin 後台

- **新增「待核對匯款」**：列 pending `group_orders`（姓名/電話/場次/總額/送出·到期時間），「已收款」→ `POST /api/admin/group-orders/:id/confirm`；「取消訂單」→ cancel + 遞補。
- **課程模板 UI 加 `price_per_session`** 欄位（建立/編輯）。
- **場次報名檢視**：顯示 pending/confirmed/waitlisted 計數。
- **點數 UI 移除**（admin.html / admin.js）。

---

## 7. Cutover / Migration

### 7.1 Migration 順序（部署前備份 DB）
1. rebuild `users`（email nullable；同時 DROP `member_point_balance` view）
2. rebuild `registrations`（status 加 `pending`、加 `order_id`/`amount_due`）
3. `course_templates.price_per_session` addColumn
4. create `group_orders` 表 + index
5. create `idx_users_phone`

兩個 rebuild 走 `PRAGMA foreign_keys=OFF` + 重建相依物件 + recreate index 的 recipe，`BEGIN` 在 try 內。`point_transactions` 表保留。

### 7.2 分階段（單一 feature branch、draft PR、每階段 manual-smoke gate 後合）
- **A 後端**：schema migration + `userService` + 1v1/group 公開寫入/查詢/取消 endpoints + sweep/遞補 + 點數拆除 + auth 擋 user role。
- **B Admin**：待核對匯款 UI + 模板價格欄位 + 點數 UI 移除。
- **C 前端 cutover**：入口卡 + 團體選課/計費/匯款頁 + 我的課表 + navbar 修正 + 刪 register/line 頁。

### 7.3 舊資料
- 舊 user 帳號（uid 8,9）留作紀錄、不能登入、資料不動。
- `point_transactions` 既有交易史保留可查（DB 直查 / 未來工具）。

### 7.4 Rollback
git revert 可救。migration 除兩個 rebuild + view DROP 外皆 additive；rebuild 為 idempotent、不破壞既有資料；部署前備份可完整還原。

---

## 8. 手動 smoke checklist（每階段 merge 前 gate）

**A 後端（API）**
- [ ] `POST /api/public/bookings` 新電話 → 建 user、回 bookingId + lineBindCode
- [ ] 同電話不同姓名再下單 → 沿用原帳號、姓名不變
- [ ] `POST /api/public/group-orders` pay 全有空 → pending order + regs、回 total/bankInfo/expiresAt
- [ ] pay 桶含已滿場次 → `409 {fullSessionIds}`，整批未寫
- [ ] waitlist 桶 → waitlisted reg（不佔名額、無金額）
- [ ] `POST /api/public/my` 電話+姓名正確 → 列出；姓名錯 → 查無
- [ ] `DELETE …/group-orders/:id` 正確 owner → 放棄 + 釋名額；錯 → 403
- [ ] 取消造成釋出 → 最早候補遞補成 pending + 24h order
- [ ] `expire-orders` 把逾時 pending → cancelled + 遞補
- [ ] `POST /api/auth/login` user role → 403；admin → 200
- [ ] 過期 pending 不佔名額（lazy 計算驗證）

**B Admin**
- [ ] 待核對匯款列出 pending orders；「已收款」→ paid + regs confirmed + 通知
- [ ] 模板可設定單堂價、團體課總額正確反映
- [ ] admin 頁無點數 UI；`/api/admin/users` 無 balance 欄位、仍有 line_user_id

**C 前端（E2E）**
- [ ] 未登入連 `/` → 兩入口卡、不跳 login
- [ ] 1v1：選教練→時段→姓名+電話→成功頁顯示綁定碼
- [ ] 團體：展開課程→單選/全選→總額正確→匯款頁→成功頁訂單號+帳號+期限
- [ ] 成功頁綁定碼貼官方 LINE → 綁定成功 → 之後匯款核對/遞補收到 LINE 通知
- [ ] 兩瀏覽器並發選同一最後名額 → 一個成功一個 409
- [ ] `/my-schedule` 輸電話+姓名 → 列預約/報名/剩堂數、可取消
- [ ] admin 登入 navbar 只有「管理後台」；coach 只有「教練後台」
- [ ] 既有 admin/coach 後台功能 regression（建課、改設定、教練班表）

---

## 9. 風險與 mitigation

| 風險 | 影響 | mitigation |
|-----|-----|----------|
| 電話+姓名被冒用查/取消 | 中 | 信任模型已接受；姓名軟性第二因子；未來可加 OTP 不破壞 API 形狀 |
| 同電話 race 雙插 user | 低 | `findOrCreateUserByPhone` 用 `tx()` + `BEGIN IMMEDIATE` |
| 並發選同一最後名額 | 中 | 名額在 tx 內重算 + `409`；pending 即佔名額 |
| pending 佔位不付款 | 中 | 6h 自動釋出（lazy + sweep）；遞補 24h |
| 遞補者沒綁 LINE 收不到通知 | 中 | 已接受「自己查」；my-schedule 顯示「已遞補待付款」 |
| schema rebuild 失敗 | 中 | try/catch + 本地驗證 + 部署前備份 |
| 既有 `/line.html` 被 bookmark | 低 | 301 → `/my-schedule` |

---

## 10. 不在這次範圍（YAGNI）

- SMS / OTP 驗證、電話 prefill
- 線上金流（仍是人工匯款 + admin 核對）
- 點數系統反向遷移 / 退費自動化
- 客人登入雙模式
- 候補上限、退款自動化
- 預約後 email 確認信
