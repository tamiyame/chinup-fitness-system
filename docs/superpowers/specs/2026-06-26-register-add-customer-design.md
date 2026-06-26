# 登錄預約「查無客人 → 直接新增客人」— 設計文件

> 日期：2026-06-26
> 範圍：單一 PR。後端加 1 支 `POST /api/coach/customers`（重用既有 `findOrCreateUserByPhone`）+ api 測試；前端改 `coach.js` 登錄彈窗搜尋區。
> 業主已拍板：只收 姓名+電話；只做登錄預約彈窗。

## 問題
教練後台「登錄預約」彈窗從搜尋客人開始；搜尋**查無客人時是死路**（只顯「查無客人」文字），無法當場建立新客人，必須先跳去別處建檔再回來。

## 已拍板決策（業主，2026-06-26）
1. 新增客人表單只收 **姓名 + 電話**（其餘資料日後於會員管理補）。
2. 只做在**登錄預約**彈窗；「編輯預約 → 改客人」的搜尋維持原樣（不在本次範圍）。

## 背景（已查證，含 file:line）
- 登錄彈窗 `renderRegmBody()`（`public/coach.js` 約 862–891）：搜尋框 `#regm-search`（debounce 250ms）→ `GET /api/coach/customers/search?q=` → 結果 `#regm-results`（`.regm-result` 列）或 `'<div class="regm-sub" ...>查無客人</div>`（**死路**）。選取 → `regmCustomer = {id,name,phone}`、清結果、`search.value=name` → `loadRegmPackages()` → `renderRegmPicked()`（選方案／無方案則就地建方案）。
- 模組狀態：`let regmCustomer = null;`（約 845）；`loadRegmPackages()`（約 893）。
- 後端：`findOrCreateUserByPhone({ phone, name })`（`src/services/userService.js:22`）— 驗 `validatePhone`（`/^\d{8,15}$/`，400 `invalid_phone`）、驗 name（400 `missing_name`）、tx 內 find-or-create role='user'；**電話屬非 user（教練/管理者）→ 409 `phone_unavailable`**；封存者自動還原。`ApiError` 由 asyncHandler 轉 HTTP。
- 既有 route：`GET /api/coach/customers/search`（`src/server.js:875`，`requireCoach`）。**新 route 緊接其後加。**
- `searchCustomers`（coachCalendarService）：role='user' 且未封存，name/phone LIKE。
- api 測試模式：見 `tests/coach-register-api.test.js` / `tests/member-admin-api.test.js`（BASE + req() helper + 自建/seed 帳號 token + db 直插清理）。

## 架構

### 後端（`src/server.js`，customers/search route 之後）
```js
app.post('/api/coach/customers', requireCoach, asyncHandler((req, res) => {
  const { name, phone } = req.body || {};
  const u = svcFindOrCreateUserByPhone({ name, phone });
  res.json({ id: u.id, name: u.name, phone: u.phone });
}));
```
- import `findOrCreateUserByPhone as svcFindOrCreateUserByPhone`（若尚未 import）。
- 行為＝find-or-create：電話已存在客人 → 回該客人（封存自動還原），不重複建；電話屬員工 → 409；缺名/壞電話 → 400。**只回 id/name/phone**（不洩其他欄位/綁定碼）。

### 前端（`public/coach.js` `renderRegmBody`）
搜尋查無結果時，把原「查無客人」文字換成就地「新增客人」表單（注入 `#regm-results` 或其下方）：
- 姓名 input `#regm-newc-name`（預填：搜尋字含非數字→填姓名；純數字→姓名留空）
- 電話 input `#regm-newc-phone`（預填：搜尋字為純數字→填電話）
- 「新增客人」按鈕 `#regm-newc-create`
- 按下 → `POST /api/coach/customers {name, phone}`：
  - 成功：`regmCustomer = 回傳 {id,name,phone}`；`$('regm-results').innerHTML=''`；`$('regm-search').value = regmCustomer.name`；`loadRegmPackages()`（接入既有方案步驟）。
  - 失敗：toast 對應訊息（`missing_name`→請填姓名、`invalid_phone`→電話格式須 8–15 碼數字、`phone_unavailable`→此電話為員工帳號不可用、其他→`e.message`）。
- 全欄 `escapeHtml`；沿用既有 `.regm-*` 樣式 + 一個輕量新增區塊。

## 安全/權限
- `requireCoach`（與 customers/search 同級）。管理者代教練登錄不影響建客人（客人是 role=user 全域帳號）。
- 員工電話守門沿用 `findOrCreateUserByPhone`（409 `phone_unavailable`），避免把預約掛到員工帳號（同 [[chinup_staff_phone_idor_fix]]）。
- 不收 email/生日等；不回傳敏感欄位。

## 不動
- 編輯預約「改客人」搜尋（`#bke-search`）；方案建立/選擇、登錄 preview/送出、循環、其他彈窗。

## 測試
- api：`tests/coach-add-customer-api.test.js`（掛 test:api）：建立成功回 {id,name,phone} 且 DB role=user；缺名→400 missing_name；壞電話→400 invalid_phone；員工電話→409 phone_unavailable；既有客人電話→回同一 id（不新增）；非 admin coach token 也可（requireCoach）。
- 前端：`node --check public/coach.js`；瀏覽器 smoke（查無客人→填姓名電話→新增→自動帶入並顯示方案步驟→建方案→登錄成功）。

## 不做（YAGNI）
- 不在新增客人時收 email/生日/地址（會員管理補）。
- 不改編輯預約改客人流程。
- 不做「找到相似客人提示去重」（find-or-create 已避免同電話重複建）。
