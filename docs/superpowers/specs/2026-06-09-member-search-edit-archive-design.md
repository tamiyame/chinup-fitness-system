# 會員管理：即時搜尋 + 長按編輯 / 軟刪除(封存)還原  — 設計

**Goal:** 在後台「會員管理」卡片加上 (1) 即時搜尋欄（依姓名或電話即時過濾），(2) 會員列長按 → 彈窗可編輯（姓名/手機/email/生日/地址）與軟刪除（封存）/還原。

**日期:** 2026-06-09 · **分支:** `feat/member-search-edit-archive`

---

## 權限（已確認）

- **編輯 / 封存 / 還原**：**管理者 + 擁有者**（皆 `requireAdmin`）。
- 封存仍有守門：**不可封存自己**、**不可封存最後一位擁有者**。

## 軟刪除（封存）語意（已確認）

- 封存 = `users.archived_at` 設時間戳；還原 = 清回 NULL。資料完全保留。
- **封存只影響後台會員列表**（預設隱藏；「顯示已封存」可顯示）。**不影響會員前台查詢**——會員自己用電話查 my-schedule 照常看得到自己的預約。
- **自動還原**：被封存會員的電話之後再來預約時，`findOrCreateUserByPhone` 會自動清掉 `archived_at`、沿用舊帳號（歷史接回）；如此被封存者再次活躍即會回到後台列表。

---

## A. 資料（additive migration，安全；prod 開機自動套用）

`users` 新增三欄：
- `birthday TEXT`（YYYY-MM-DD 或空）
- `address TEXT`
- `archived_at TEXT`（封存時間戳；NULL=正常）

實作：`src/db/schema.js` 的 `CREATE TABLE users` 補三欄；`src/db/connection.js` 加
```js
addColumnIfMissing('users', 'birthday', 'TEXT');
addColumnIfMissing('users', 'address', 'TEXT');
addColumnIfMissing('users', 'archived_at', 'TEXT');
```

## B. 後端（src/server.js + userService.js）

1. `GET /api/admin/users`（requireAdmin）：SELECT 多回 `birthday, address, archived_at`，**含已封存**（前端控制顯示）。
2. `PATCH /api/admin/users/:id`（requireAdmin，新端點）：body `{ name, phone, email, birthday, address }`。
   - `name` 必填非空；`phone` 可空或 8–15 碼；`email` 空字串→NULL。
   - **email 唯一衝突**（與其他 user 重複）→ `409 email_taken`。
   - 不在此改 role（角色仍走既有 owner-only 端點）。
   - 可編輯任何列（含員工）；回更新後資料列。
3. `POST /api/admin/users/:id/archive`（requireAdmin）：設 `archived_at`。守門（沿用改角色那套）：
   - 不可封存自己 → `400 cannot_archive_self`
   - 不可封存最後一位擁有者 → `400 last_owner`
4. `POST /api/admin/users/:id/restore`（requireAdmin）：清 `archived_at`。
5. `findOrCreateUserByPhone`（userService）：比對到既有 `role==='user'` 且 `archived_at` 非空 → 清掉（自動還原）後回傳。
6. `getUserByPhoneAndName`（userService，前台 my-schedule 查詢）：**不變**（封存不影響前台查詢）。

## C. 前端（public/admin.js + admin.html）

1. **搜尋欄（藍框）**：在「會員管理」標題與 note 之間放 `<input id="user-search">`。`oninput` 即時過濾**已載入**的列（姓名 OR 電話 子字串、不分大小寫）。零延遲、不打 API。
2. **顯示已封存切換**：checkbox `顯示已封存`，預設關。關＝隱藏 `archived_at` 非空的列；開＝顯示，且該列淡灰 + 「已封存」標籤 + 「還原」鈕（僅擁有者）。
3. **長按彈窗（紅框）**：每列 `<tr>` 綁長按（touch `touchstart`＋mouse `mousedown`，按住約 500ms 觸發；移動/放開即取消）→ 開編輯彈窗：
   - 欄位：姓名 / 手機 / email / 生日（`<input type="date">`）/ 地址。
   - 「儲存」→ `PATCH`；成功 toast + reload。
   - 「封存此會員」（僅擁有者）→ confirm → `POST archive` → reload。
   - email 衝突等錯誤以 toast 呈現。
   - 編輯欄位對管理者開放；封存/還原鈕僅擁有者顯示。

## D. 測試（tests/，api 級）

涵蓋：編輯成功 / email 衝突 409 / 封存(admin 可) / 封存守門(self、last-owner) / 還原 / 封存後同電話預約自動還原 / 封存不影響前台查詢（my-schedule 仍查得到）。

## 不做（YAGNI）

- 不做生日提醒、地址驗證、批次操作、匯出。
- 不改既有改角色端點與流程。
