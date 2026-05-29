# 匿名預約 + 識別簡化重設計

> ⚠️ **SUPERSEDED（未落地）** — 本設計未實作，已由 `2026-05-29-anon-booking-paid-group-redesign-design.md` 取代。保留僅供歷史參考。

**Date**: 2026-05-23
**Author**: brainstorm with user
**Scope**: 全站從「會員必須登入」轉成「客人匿名預約 / 教練+admin 才登入」
**Files touched**:
- `src/db/schema.js`、`src/db/connection.js`（schema migration）
- `src/services/userService.js`（新增 find-or-create-by-phone helper）
- `src/services/bookingService.js`、`src/services/registration.js`（新增匿名分支或拆 service 共用）
- `src/services/auth.js`（block user-role login）
- `src/server.js`（新增 `/api/public/*` endpoints、`requireRole` middleware 變體）
- `public/index.html`、`public/coaches.html`（含內嵌的 view-list / view-detail / view-confirm 三個 view）、`public/my-schedule.html`（公開化）
- `public/app.js`（navbar 邏輯：admin 不再看到「教練後台」；`bootAuth` 接收 `requireRole`）
- `public/login.html`（文案改「管理員/教練專用」）
- `public/register.html`、相關 entry 連結（移除）

---

## 1. 動機

User 反映系統對一般客人太重：要先註冊、登入才能預約一堂課，門檻過高、流失率高。希望客人可以**直接從首頁進入預約頁、最後一刻才輸入姓名+電話即完成註冊**，並用同一個電話號碼當作後續識別。

副要求：admin 登入時 navbar 不該再出現「教練後台」連結（目前是 bug，admin 看到了兩個入口）。

---

## 2. 設計決策（brainstorm 已逐項與 user 確認）

| 決策 | 結果 |
|-----|------|
| 客人識別 | 電話號碼當 key — 找到就複用、找不到就新建 |
| 點數系統 | **完全拿掉**，到現場再收費。schema 表留著但程式不寫入 |
| 「我的預約」 | 公開頁，輸電話查詢，查到後可直接取消 |
| 舊 user-role 帳號（uid=8、9） | 以後也走新流程（電話查），login 頁只留給 admin/coach |
| 預約成功後 LINE 通知 | 預約成功頁顯示一組 6 位綁定碼；客人可選擇加 chinup 官方帳號 + 貼碼來綁 |

信任模型：**電話即身份**。任何知道電話的人都能查/取消那支電話的預約。可接受，因為這是小型熟客健身房的場景。

---

## 3. Backend 設計

### 3.1 Schema migration（idempotent）

在 `connection.js` 的 `addColumnIfMissing` 區塊後新增：

```js
// Phase 4 anon-booking: relax email, add phone index
// SQLite 沒辦法直接 ALTER COLUMN DROP NOT NULL — 用一個輕量 workaround：
// 直接保留 NOT NULL 在 schema.js 的 fresh-create 版本，但生產 DB 早就建好了，
// 改用 partial-unique-index 戰術不需要動 NOT NULL（NULL 允許多筆）。
// 真正的修改是：CREATE 新匿名 user 時插入 NULL email — 但既有 NOT NULL 會擋。
// 因此走 schema_version-style rebuild：
//   1) 偵測 users.email 是否還有 NOT NULL 約束（用 PRAGMA table_info）
//   2) 若是 → 走 SQLite 推薦的 "table rebuild" 步驟：
//      BEGIN; CREATE TABLE users_new (...email TEXT...); INSERT INTO users_new SELECT...;
//      DROP TABLE users; ALTER TABLE users_new RENAME TO users; recreate indexes; COMMIT;
//   3) 否則 skip
// 細節在 connection.js 用 try/catch 包好；本地 + Railway 先 backup DB 再跑
```

並加上：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
  ON users(phone) WHERE phone IS NOT NULL;
```

`schema.js` 的 fresh-create 部份同步把 `email TEXT NOT NULL UNIQUE` 改成 `email TEXT UNIQUE`，避免新環境（如本地測試 DB）出現不一致。

`member_point_balance`、`point_transactions` 表**保留**，不 drop、不寫入。

### 3.2 新 service：`userService.js`

```js
// 抽離「find-or-create user by phone」邏輯，供 public booking/registration 共用
export function findOrCreateUserByPhone({ phone, name }) {
  // 1) 查現有 user with this phone
  // 2) 若有：name 不一致就 UPDATE name；return user.id
  // 3) 若無：INSERT (name, phone, email=NULL, password_hash=NULL, role='user')；return new id
  // 整段包在 tx() 裡，避免兩個並發請求同 phone 雙插
}
```

phone 驗證：`/^\d{8,15}$/`（純數字 8–15 碼）— 拒絕含 `+`、`-`、空白；前端送出前 normalize。

### 3.3 新 public endpoints（不需 auth）

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| POST | `/api/public/users/lookup` | `{ phone }` | `{ exists, name? }` — 給前端 prefill |
| POST | `/api/public/bookings` | `{ coachId, startAt, name, phone, note? }` | `{ bookingId, startAt, endAt, lineBindCode?, lineBindExpiresAt? }` |
| POST | `/api/public/registrations` | `{ sessionId, name, phone }` | `{ registrationId, status, position?, lineBindCode?, lineBindExpiresAt? }` |
| GET | `/api/public/my` | `?phone=...` | `{ user: {name, phone}, bookings: [...], registrations: [...] }` |
| DELETE | `/api/public/bookings/:id` | `?phone=...` | `{ ok }` |
| DELETE | `/api/public/registrations/:id` | `?phone=...` | `{ ok }` |

實作要點：

- 每個 endpoint 第一步都先驗 `phone` 格式
- 寫入類 endpoint 內部走 `findOrCreateUserByPhone` → 呼叫既有 `createBooking({coachId, memberId, startAt, note})` / `register({sessionId, userId})`，但**繞過點數扣除**
- DELETE 端點先 `getUserByPhone(phone)`，再驗 `booking.member_id === user.id` 才允許；用既有 `cancelBooking` / `cancelRegistration`，繞過 refund
- 「綁定碼」邏輯：寫入成功後 `if (!user.line_user_id) { const code = generateBindCode(user.id); return {..., lineBindCode: code, lineBindExpiresAt: ...}; }`。`generateBindCode` 會覆寫使用者既有未消費的 `line_bind_code`（既有實作就是如此）— 對匿名流程沒影響（同一支電話下次預約照樣產一組新碼，舊碼自動失效）

### 3.4 點數繞過策略

最乾淨：把 `bookingService.createBooking` / `bookingService.cancelBooking` 拆成兩段：

```js
function createBookingCore({ coachId, memberId, startAt, note }) {
  // 寫 bookings、發 notify — 不碰 points
}

export function createBooking(args) {
  return tx(() => {
    const result = createBookingCore(args);
    recordTransaction({ memberId: args.memberId, pool: 'one_on_one', amount: -1, ... });
    return result;
  });
}

export function createBookingAnon(args) {
  return tx(() => createBookingCore(args));  // 不扣點
}
```

同樣的拆分用在 `cancelBooking` / `cancelBookingAnon`、`register` / `registerAnon`。

公開端點呼叫 `*Anon` 版本；既有 auth 端點維持原行為（admin/coach 後台用到時點數仍會動）。

### 3.5 Auth 收口

- `services/auth.js` `login()` 函式：成功驗 password 後，若 `user.role === 'user'` 直接 `throw new ApiError(403, 'user_login_disabled')`。讓既有 uid=8/9 也不能再登入
- `POST /api/auth/register` endpoint 整支刪除 + handler 函式刪除 + `public/register.html` 檔案刪除 + 各頁 navbar/login 頁的 register 連結移除
- `public/app.js` 的 `bootAuth({ requireAdmin })` 擴充為 `bootAuth({ requireRole })`：
  - `requireRole: 'admin'` → 等價現在 `requireAdmin: true`
  - `requireRole: ['admin','coach','owner']` → 三者都可
  - 不傳 → 維持「只要 token 有效就放行」
- admin/coach 後台頁面改傳 `requireRole: ['admin','coach','owner']` 或 `'admin'`

### 3.6 Notifications

不動。`notify({userId})` 內部本來就會根據 `users.line_user_id` 決定 channel — 匿名建立的 user 一開始無 line_user_id → 走 console；綁定後 → 走 LINE。

---

## 4. Frontend 設計

### 4.1 頁面公開化

| 頁面 | 現況 | 改後 |
|-----|------|-----|
| `/` (index.html) | `bootAuth()` 跳 login | 公開首頁，兩個大 CTA：「一對一」、「團體課」 |
| `/coaches.html` | bootAuth | 公開，列教練 |
| 一對一時段選擇 | bootAuth | 公開，選時段觸發 modal |
| 團體課列表 | bootAuth | 公開，列課表 |
| `/my-schedule.html` | bootAuth | 公開，輸電話查詢 |
| `/admin.html` | requireAdmin | 不變 |
| `/coach.html` | requireRole='coach' | 不變 |
| `/line.html` | bootAuth | **拿掉**（匿名使用者改在預約成功頁取得綁定碼） |
| `/register.html` | 公開 | **刪除** |

### 4.2 預約 modal（一對一 + 團體課 共用）

```
┌─────────────────────────────┐
│  預約資訊                    │
│  教練：Ryan / 5/24 14:00     │
│                              │
│  電話 *  [           ]       │  ← onBlur → /api/public/users/lookup
│  姓名 *  [           ]       │  ← 若 lookup exists 自動 prefill
│                              │
│  [取消]            [送出預約] │
└─────────────────────────────┘
```

送出後 → 預約成功頁。

### 4.3 預約成功頁（共用 component）

```
✅ 預約成功
教練：Ryan
時間：2026/5/24（週六）14:00–15:00

—— 想收 LINE 通知？ ——
1. 加 chinup 官方 LINE 好友 [QR / @id]
2. 傳這組 6 位數碼給機器人：

       1 2 3 4 5 6

（15 分鐘內有效）

[查我的預約]  [回首頁]
```

若 user 已綁過 LINE，整段「想收 LINE 通知」隱藏。

### 4.4 「我的預約」(my-schedule.html)

```
┌────────────────────────────┐
│  查我的預約                  │
│  電話 [           ] [查詢]  │
└────────────────────────────┘

[查詢結果 — 列表]
○ 一對一 / Ryan / 5/24 14:00  [取消]
○ 團體課 / TRX / 5/26 19:00   [取消]
○ ...
```

電話存 localStorage，下次自動帶入。

### 4.5 Navbar

公開頁 navbar：

```
[CHINUP logo]  [一對一]  [團體課]  [我的預約]    [登入]
```

「登入」按鈕點下去到 `/login.html`，文案「管理員 / 教練專用」。

登入後（admin 或 coach）顯示既有的 admin/coach navbar，但修掉以下 bug：

- `app.js` line 136：`const showCoach = ['coach', 'admin', 'owner'].includes(user.role);` → 改成 `const showCoach = user.role === 'coach';`
- 結果：admin 只看到「管理後台」，coach 只看到「教練後台」，雙方互不重疊

---

## 5. Cutover 計畫

兩個 PR，分階段。

### PR #1：Backend + schema（純加 + 安全 deprecation）

* schema migration（email nullable + phone unique index）
* `userService.findOrCreateUserByPhone`
* 拆 `createBooking` / `cancelBooking` / `register` / `cancelRegistration` 為 `*Anon` 版本
* 新 `/api/public/*` endpoints
* `login()` 擋 user role
* `bootAuth({requireRole})` 擴充（前端僅換 API、不改使用者體驗）
* 部署到 Railway；舊 admin/coach 流程完全不受影響、可獨立驗證

### PR #2：Frontend cutover

* 各公開頁拿掉 bootAuth、加上預約 modal、新 my-schedule、新成功頁
* navbar 改造、admin 看到「教練後台」bug 修掉
* 刪除 `/register.html`、`/line.html`、`POST /api/auth/register`
* manual smoke checklist（見 §6）跑完才 ready → merge

### Rollback

兩個 PR 都是 git revert 可救。schema migration 是 idempotent additive 不會破壞既有資料（NULL email、新 phone index 都不影響既有資料完整性）。

---

## 6. 手動 smoke checklist（merge 前 manual gate）

PR #1 smoke（API only）：
- [ ] `POST /api/public/users/lookup` 新電話回 `exists:false`、舊電話（uid=9 phone `0965072699`）回 `exists:true, name:'Nina'`
- [ ] `POST /api/public/bookings` 新電話 → 自動建 user、發通知（console）、回 lineBindCode
- [ ] `POST /api/public/bookings` 用 uid=9 電話 → 找到 reuse user，name 若不同會被更新；該 user 已綁 LINE 時 lineBindCode=null、未綁時回新碼
- [ ] `DELETE /api/public/bookings/:id?phone=正確` → 200
- [ ] `DELETE /api/public/bookings/:id?phone=錯` → 403
- [ ] `POST /api/auth/login` 用 user role 帳號 → 403 user_login_disabled
- [ ] `POST /api/auth/login` 用 admin → 仍然 200
- [ ] 既有 `POST /api/bookings`（auth）→ 仍照舊扣點

PR #2 smoke（E2E in browser）：
- [ ] 未登入連 `/` → 不跳 login，看到兩個 CTA
- [ ] 連 `/coaches.html` → 公開列表
- [ ] 預約一對一新時段 → modal → 填新電話+名字 → 成功頁顯示綁定碼
- [ ] 預約成功頁的綁定碼貼到 chinup LINE bot → 收到綁定成功訊息
- [ ] 綁定後再預約一次 → 收到 LINE 通知（教練端也收到）
- [ ] 同電話兩個瀏覽器並發預約同時段 → 一個 409 slot_taken
- [ ] `/my-schedule.html` 輸電話 → 列出該電話的預約、可取消
- [ ] admin 登入 → navbar 只有「管理後台」、無「教練後台」
- [ ] coach 登入 → navbar 只有「教練後台」、無「管理後台」
- [ ] 既有 admin/coach 後台所有功能（建課、改設定、發點數）regression 檢查

---

## 7. 風險與 mitigation

| 風險 | 影響 | mitigation |
|-----|-----|----------|
| 電話被冒用查/取消他人預約 | 中 | 信任模型已接受。未來想加 OTP 不破壞此 API 形狀 |
| 同電話 race condition 兩請求同插 user | 低 | `findOrCreateUserByPhone` 用 `tx()` + `BEGIN IMMEDIATE` |
| 既有 user-role 名字被覆蓋 | 低 | 接受 last-write-wins |
| Nina 餘額 1500/600 點作廢 | 低 | UI 隱藏、DB 保留；admin 仍可手動處理 |
| schema rebuild migration 失敗 | 中 | migration 用 try/catch；本地驗證；Railway 部署前 backup DB 一次 |
| 移除 `/line.html` 但某 user 已 bookmark | 低 | 加一個 301 → `/my-schedule.html` |

---

## 8. 不在這次範圍（YAGNI）

* SMS / OTP 驗證
* 點數系統的反向遷移（退費等）
* 「客人也能登入」雙模式
* /admin.html 加「客戶管理」面板（既有 admin/users 已能查）
* 預約後寄 email 確認信
