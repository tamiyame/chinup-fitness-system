# 我的課表（公開查詢）客戶自助綁定 LINE — 設計文件

> 日期：2026-06-19
> 範圍：後端（新增 1 個公開端點 + getPublicSchedule 多回 1 欄）＋ 前端（my-schedule.html / my-schedule.js）。

## 問題
客戶用「電話＋姓名」查詢「我的課表」後，目前沒有自助綁定 LINE 的入口——只有「預約成功頁」會順手給綁定碼。業主希望查詢結果頁也能讓客戶依自己的手機號碼綁定。

## 背景（已查證）
- 整套 LINE 綁定狀態機已可用於客戶：`generateBindCode(userId)` 產 6 碼（存 `users.line_bind_code`/`line_bind_expires_at`，TTL 15 分）；客戶在官方 LINE 傳碼 → 已驗簽的 `POST /api/line/webhook` 呼叫 `consumeCode` 完成綁定。客戶 users 列由 `findOrCreateUserByPhone`（role='user'）建立，預約成功頁已 render `result.lineBindCode`/`lineOfficialUrl`。缺的只是「不必下單、直接從我的課表頁產碼」。
- 我的課表是匿名頁（無 token、無登入概念），身份＝phone+name：`POST /api/public/my` → `getPublicSchedule` → `getUserByPhoneAndName`（**嚴格驗名**，不符回 403）。`state.creds={phone,name}` 已保存，可重用。
- navbar 右側有 `#auth-bar` 容器（員工登入時由 app.js `renderAuthBar` 注入員工綁定按鈕；匿名客戶為空）。

## 已拍板決策（業主 + mock 確認）
1. **按鈕位置：navbar 的 `#auth-bar`**（比照員工綁定按鈕；查到客戶後才注入）。
2. **未綁定** → 顯示「綁定 LINE」按鈕；**已綁定** → 顯示「✓ 已綁定 LINE」小標記；**不適用**（非客戶）→ 不顯示。
3. 點按鈕 → **彈出視窗**（比照員工綁定）：大字 6 碼＋「15 分鐘內有效」＋「點我加入官方 LINE」＋3 步驟＋「我綁好了，重新整理」。

## 架構

### 後端
1. **新公開端點 `POST /api/public/line/bind-code` {phone, name}**（限流）。新增 service `requestPublicBindCode({phone, name})`（放 `src/services/lineBindingService.js`，import `getUserByPhoneAndName`、`getLineOfficialUrl`）：
   - `getUserByPhoneAndName({phone, name})`（已含 validatePhone＋驗名）；null → `throw ApiError(403, 'not_found_or_mismatch')`（中性、不洩電話是否存在）。
   - **角色守門**：`user.role !== 'user'` → 同樣 `throw ApiError(403, 'not_found_or_mismatch')`（員工電話+姓名也產不出碼、且不洩員工存在；沿用 staff-IDOR 緩解精神）。
   - 已綁定：`user.line_user_id` 非空 → `throw ApiError(409, 'already_bound')`（防禦；前端正常已隱藏按鈕）。
   - 通過 → `generateBindCode(user.id)`，回 `{ code, expires_at, line_official_url: getLineOfficialUrl() }`（**只回這三項，不回 user 列**）。
   - 路由：`server.js` 公開區（~837-907），`app.post('/api/public/line/bind-code', lineBindLimiter, asyncHandler((req,res)=>{ const {phone,name}=req.body||{}; res.json(requestPublicBindCode({phone,name})); }))`。
   - 新增 `const lineBindLimiter = createRateLimiter({ name: 'public-line-bind', windowMs: 60_000, max: 10 });`（擋枚舉/洗碼）。
2. **`getPublicSchedule` 多回 `line_bound`（三態）**（groupOrderService.js:516-519 的回傳物件）：新增 `line_bound: user.role === 'user' ? !!user.line_user_id : null`。只回布林/null，不回 `line_user_id` 原值，不回 role。

### 前端（public/my-schedule.html / my-schedule.js）
- **my-schedule.html**：(a) 在 `<style>` 加 `.ms-line-btn`/`.ms-line-bound`/`#line-bind-overlay` 等樣式（沿用 mock，套我的課表風格＋LINE 綠 #06c755）；(b) 在 `</body>` 前加隱藏的綁定彈窗骨架 `#line-bind-overlay`（標題＋`#line-bind-body` 容器＋關閉），body 內容由 JS 填。`#auth-bar` 已存在（不改 markup）。
- **my-schedule.js**：
  - import 補 `getToken`（自 app.js；判斷是否員工登入）。
  - `doLookup` 成功：`state.lineBound = data.line_bound`；呼叫 `renderLineNav()`。
  - `renderLineNav()`：若 `getToken()` 為真（員工已登入，auth-bar 由 app.js 擁有）→ 不動；否則依 `state.lineBound`：`false`→注入「綁定 LINE」按鈕到 `#auth-bar`；`true`→注入「✓ 已綁定 LINE」標記；`null`→清空 `#auth-bar`。
  - `showForm()`（重新查詢/換電話）：清空 `#auth-bar`、`state.lineBound=null`。
  - 按鈕 click → `openLineBindModal()`：開 `#line-bind-overlay`，先顯示「產生中…」，`POST /api/public/line/bind-code` 帶 `state.creds`：
    - 成功 → 填 `#line-bind-body`：6 碼大字、「綁定碼 15 分鐘內有效」、3 步驟、`line_official_url` 有值→「點我加入官方 LINE」連結（target=_blank rel=noopener）否則「尚未設定官方 LINE 連結」提示、「我綁好了，重新整理」鈕。
    - `already_bound`(409) → 改顯示「此帳號已綁定 LINE」並關閉/刷新；其他錯誤 → toast。
  - 「我綁好了，重新整理」→ 關彈窗 + `doLookup(state.creds.phone, state.creds.name)`（重查→`line_bound` 更新→navbar 變「✓ 已綁定」）。
  - 彈窗點背景/關閉鈕關閉。

## 安全
- 新端點：限流 + 驗名 reader + role 守門（非 user 一律當查無，中性）+ 已綁定 409 + 只回三欄。**不**新增匿名「查綁定狀態」或「解除綁定」端點（用電話替陌生人解綁有風險；綁定狀態只透過已驗名的查詢回應 `line_bound` 呈現）。
- 不修改共用 `getUserByPhoneAndName`／`findOrCreateUserByPhone` 行為（role 守門只加在新 service，避免影響既有呼叫者）。
- navbar 按鈕僅在匿名（無 token）時注入，避免蓋掉員工 auth-bar。

## 不動
- 預約成功頁既有綁定碼呈現（保留）；員工 `/api/my/line*`（不碰）；webhook/consumeCode（不碰，直接重用）。

## 測試
新增 `tests/public-line-bind-api.test.js`（需啟動 server，`LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1`；比照既有 api 測試的 `req()`/`expect()` harness）：
1. 客戶 phone+name → 200，回 `{code 為 6 位數, expires_at, line_official_url}`；DB 該 user `line_bind_code` 已寫入。
2. 錯名 → 403 `not_found_or_mismatch`。
3. 員工(role≠user) phone+name → 403 `not_found_or_mismatch`（role 守門）。
4. 已綁定客戶(`line_user_id` 已設) → 409 `already_bound`。
5. `POST /api/public/my`：未綁定客戶回 `line_bound:false`；已綁定客戶回 `line_bound:true`。
登錄進 `package.json` 的 `test:api`。回歸：既有 `my-schedule-service`/`my-schedule-routing`/`public-api` 測試（`line_bound` 為附加欄位，不破壞）。

## 收尾
實作完成前移除暫存預覽檔 `public/_mock_my_schedule_line.html`（不進版控）。

## 不做（YAGNI）
- 不做匿名查綁定狀態 / 解綁端點。
- 不改員工綁定流程或預約成功頁。
- 不在其他頁（首頁/coaches/group）加此按鈕（只有我的課表有客戶身份）。
