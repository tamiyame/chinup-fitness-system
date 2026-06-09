# 角色 / 權限模型重構：移除 owner、管理者改為教練的權限標籤 — 設計

**Goal:** 把角色收斂為 **會員(user) / 教練(coach)** 兩種；**管理者**改為「教練身上的權限標籤」(`is_admin`)。只有「有管理者標籤的教練」能管理會員/教練資料與角色。另把「改為教練時自動重新啟用教練檔案」一併處理。

**日期:** 2026-06-09 · **分支:** `feat/roles-permissions-redesign`

---

## 模型（已與你確認）

- 角色 `users.role` ∈ **`user`(會員) / `coach`(教練)**。移除 `admin`、`owner`。
- 新增 `users.is_admin INTEGER NOT NULL DEFAULT 0` = 管理者標籤。
- **不變式**：`is_admin=1` 只允許在 `role='coach'`。設為會員時自動清除標籤。
- 「管理者」 = `role='coach' AND is_admin=1`。
- 權限：
  - 教練（無標籤）：能用教練後台，但**不能**改別人的角色/標籤。
  - 教練（有標籤）= 管理者：可 CRUD 會員/教練資料、變更角色與管理者標籤、封存/還原等所有後台管理。

## A. 資料與遷移（src/db/schema.js + connection.js，冪等、開機自動）

1. `schema.js` users 表加 `is_admin INTEGER NOT NULL DEFAULT 0`。
2. `connection.js`：
   - `addColumnIfMissing('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0')`
   - **一次性資料遷移**（偵測訊號：存在 `role IN ('admin','owner')` 的列）：
     - 這些列 → `is_admin=1`、`role='coach'`。
     - 對其中**沒有** coaches 檔案者 → 建立 **未啟用**(`is_active=0`) 教練檔案（`display_name=users.name`）→ 不會出現在 coaches.html。
   - 既有 `role='coach'` → `is_admin` 維持 0（預設）。
   - 重跑為 no-op（遷移後已無 admin/owner 列）。

## B. 後端中介（src/server.js）

- `requireAdmin` → `requireUser` + `req.user.is_admin === 1`（標籤即代表是有權教練）。
- `requireCoach` → `requireUser` + `req.user.role === 'coach'`。
- `requireOwner` → **移除**（已無使用點；#39 後改角色端點已用 requireAdmin）。
- `requireUser` 不變。

## C. 登入與導向

- 登入閘門（auth.js loginWithPassword / google）：維持「`role==='user'` → `user_login_disabled`」即可——因為所有 staff（含管理者）都是 `role='coach'`，純會員仍被擋。
- Google callback 導向（server.js ~283）：`is_admin ? '/admin.html' : '/coach.html'`。
- 前台登入後導向（login.js / 登入 API 回傳）：同上以 `is_admin` 判斷（實作時確認 login.js 實際路由點）。
- **Admin bootstrap**（auth.js ensureAdminAccount）：偵測改 `WHERE is_admin=1`；建立預設/env 管理者改成 `role='coach', is_admin=1` 並建立未啟用 coaches 檔案。
- `seed.js`：admin@chinup.local 直接建為 `role='coach', is_admin=1` + 未啟用 coaches 檔案（讓既有測試與登入沿用）。

## D. 後端：角色/標籤變更端點（取代現有 /role）

`PATCH /api/admin/users/:id/role`（requireAdmin），body `{ role, is_admin }`：
- `role` 必須 ∈ `{user, coach}`，否則 400 `invalid_role`。
- 正規化不變式：`role==='user'` → 強制 `is_admin=0`。
- **守門**：
  - `targetId === req.user.id` → 400 `cannot_change_self`（不能改自己的角色/標籤，避免自我降權鎖死）。
  - 變更後若全系統管理者數 = 0 → 400 `last_admin`（至少留 1 位管理者）。管理者數 = `COUNT(role='coach' AND is_admin=1)`。
- **教練檔案連動**：
  - 新 `role='coach'`：已有 coaches 檔案 → **重新啟用**(`is_active=1`)；無 → 建立**未啟用**(`is_active=0`，待設可預約時段)。
  - 由 coach 改成 `user`：**停用**教練檔案(`is_active=0`，保留資料/歷史)。
- 寫入 `role` 與 `is_admin`；回 `{ ok, id, role, is_admin }`。

> 其餘端點：`PATCH /api/admin/users/:id`（編輯詳細）不變；其 `email_required` 守門條件 `role!=='user'` 等義於 `role==='coach'`，無需改。封存/還原沿用（已 requireAdmin）。

## E. 通知

- `notifications.js` `getAdminUserIds`：`SELECT id FROM users WHERE is_admin = 1`（原 `role IN ('admin','owner')`）。

## F. 前端（public/app.js）

- `bootAuth({requireAdmin})`：admin-only 頁守門用 `!user.is_admin`（原 `!['admin','owner'].includes(role)`）。
- `renderAuthBar`：
  - `showAdmin = !!user.is_admin`（控制 `.admin-only` nav）。
  - `showCoach = user.role === 'coach'`（管理者也是教練 → 也會看到「教練後台」連結，符合模型）。
  - 身份徽章：`is_admin` → 管理者；否則 `role==='coach'` → 教練；否則 會員。

## G. 前端：會員管理（public/admin.js）

- 角色徽章顯示：管理者(is_admin) / 教練 / 會員。
- 編輯彈窗：
  - 「角色」下拉 = **會員 / 教練**（移除管理者選項）。
  - 新增「**管理者**」checkbox（權限標籤）：僅當角色=教練時可勾；選會員時自動取消勾選且禁用。
  - 自己那列：角色與管理者標籤唯讀（`cannot_change_self`）。
  - 儲存：先 details PATCH，再（若角色或標籤有變）PATCH `/role` 帶 `{role, is_admin}`。
  - 錯誤訊息：`cannot_change_self`（不能變更自己的角色/權限）、`last_admin`（需至少保留一位管理者）、`invalid_role`。
- 移除原 owner 唯讀分支。

## H. 測試

- `seed.js` 改新模型後，回歸既有套件（admin 登入＝coach+is_admin，仍可登入、requireAdmin 仍過）。
- 更新/新增 api 測試：
  - 登入：會員擋、教練(含管理者)放行。
  - 角色/標籤變更：會員↔教練、加/移除管理者標籤；`is_admin` 只在 coach 有效（設 user 自動清）；`cannot_change_self`、`last_admin`。
  - 設教練 → 自動建/重新啟用教練檔案；改回會員 → 停用。
- 審查既有測試中對 `role='admin'/'owner'` 的假設並更新。

## 不做（YAGNI）

- 不做多階管理者層級、不做標籤以外的細粒度權限。
- 地址欄、其他既有功能不動。

## 風險與緩解

- **影響面廣（auth）**：以遷移冪等 + 大量 api 測試 + 對抗式審查（授權/登入/遷移/前端）把關。
- **自我鎖死**：`cannot_change_self` + `last_admin` 雙守門。
- **既有教練誤被當管理者**：遷移只把 admin/owner 設標籤；既有 coach 標籤=0。
