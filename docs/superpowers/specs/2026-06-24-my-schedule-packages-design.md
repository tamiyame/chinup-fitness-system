# 我的課表帶出客人方案（總堂/已登錄/剩餘）— 設計文件

> 日期：2026-06-24
> 範圍：單一 PR（建立在 PR1 方案系統之上）。後端 `getPublicSchedule` 多回 `packages`；前端 my-schedule 加「我的方案」區塊。
> 業主已於 brainstorming 拍板（見「已拍板決策」）。

## 問題
後台幫客人建立方案後（如管理者幫 user 陳筱蘋開一對一 10 堂），客人在公開「我的課表」（電話＋姓名查詢）目前只看得到預約場次（含 PAST），看不到方案的「總堂／已登錄／剩餘」。需在客人端帶出方案摘要。

## 背景（已查證，含 file:line）
- `getPublicSchedule({phone, name})`（`src/services/groupOrderService.js:470`）：以 `getUserByPhoneAndName`（嚴格驗名、role 守門）解析 user，回 `{ user:{name,phone}, items, one_on_one_remaining, group_remaining, line_bound }`。端點 `POST /api/public/my`（server.js:972，公開、無 token）。
- 既有 `one_on_one_remaining` ＝「已付款 confirmed 且未上(start_at>now)」的 booking 數，**與方案無關**（那是場次層的「剩幾堂未上」）。本功能要的是**方案層**的總/已登錄/剩餘。
- PR1 方案：`customer_packages`（member_id, session_type 1on1/1on2, total_sessions, remaining_sessions, amount, expires_at, archived_at, discount_code…）。`packageService.listValidPackagesForMember(memberId, sessionType=null)`（`src/services/packageService.js`）→ 回「未作廢＋remaining>0＋未過期」的方案列（`cp.*`），依「最早到期→最早建立」排序。
- 取消 package-backed 預約會 `refundOne`（remaining+1，PR1）→ 故 `remaining_sessions` 為目前值；已登錄(扣抵)堂數 ＝ `total_sessions − remaining_sessions`。
- 前端：`public/my-schedule.js` `state`（含 items/one_on_one_remaining/…）、`doLookup`（POST /api/public/my → 寫 state → render）、`render()`（約 358，顯示摘要列「1對1 剩 N 堂…」+ 篩選 items + PAST 收合）。`public/my-schedule.html` 結果區容器。

## 已拍板決策（業主，brainstorming 2026-06-24）
1. **只顯示有效方案**（未作廢＋未過期＋remaining>0）；用罄/過期的不顯示。
2. **不顯示金額**；每方案只顯示 類型／總堂數／已登錄／剩餘（＋到期日若有）。
3. 「已登錄」＝ `total_sessions − remaining_sessions`（含未來與已過去的已扣抵堂；取消會回補，故為目前有效登錄數）。1對1／1對2 各自一列。

## 架構

### 後端（groupOrderService.getPublicSchedule）
- import `listValidPackagesForMember`（自 `./packageService.js`）。
- 在 return 物件加：
```js
packages: listValidPackagesForMember(user.id).map((p) => ({
  session_type: p.session_type,
  total_sessions: p.total_sessions,
  used_sessions: p.total_sessions - p.remaining_sessions,
  remaining_sessions: p.remaining_sessions,
  expires_at: p.expires_at,
})),
```
- **只投影安全欄位**（不回 amount／discount_code／created_by／id／member_id）。`POST /api/public/my` 自然帶出（route 直接回 service 結果）。

### 前端（my-schedule.js / my-schedule.html）
- `state` 加 `packages: []`；`doLookup` 成功設 `state.packages = data.packages ?? []`；`showForm`/重查重置時清空。
- `render()`：在結果區頂端（摘要列附近、items 之前）渲染「我的方案」區塊：
  - 無方案（`packages.length===0`）→ 不顯示該區塊。
  - 有方案 → 標題「我的方案」+ 每方案一列：`{類型}　總 {total} 堂・已登錄 {used}・剩 {remaining}{到期 {expires_at} 若有}`。類型：`1on1→一對一`、`1on2→一對二`。
  - 純前端、escapeHtml 既有字串（皆為受控數字/列舉，仍照慣例處理）。

## 安全/守門
- 沿用 `getPublicSchedule` 的 `getUserByPhoneAndName`（驗名＋role 守門）；packages 僅該 user 的。
- 只回堂數/類型/到期（不洩金額/折扣碼/內部 id）。
- 不新增端點、不改查詢身份模型。

## 不動
- 既有 items/one_on_one_remaining/group_remaining/line_bound 與其顯示；預約/團課流程；方案後台 CRUD。

## 測試
- unit（`tests/my-schedule-service.test.js` 既有或新增案例）：建立 user＋有效方案（扣抵幾堂）→ `getPublicSchedule` 回 `packages`，`used_sessions`＝total−remaining、欄位只含安全集（無 amount）；用罄/過期/作廢方案不出現；無方案回 `[]`。
- api（`tests/my-schedule-routing.test.js` 或既有 public：`POST /api/public/my` 回 packages）。
- 前端：瀏覽器 smoke（查詢含方案的客人 → 方案區塊正確顯示總/已登錄/剩餘）。
- 回歸：既有 my-schedule items/remaining 顯示不破壞。

## 收尾
- 瀏覽器 smoke 後若建暫存 mock 一併移除。

## 不做（YAGNI）
- 不顯示金額/折扣碼。
- 不顯示用罄/過期方案。
- 不在此頁做方案購買/編輯（純唯讀摘要）。
- 不改 one_on_one_remaining 既有語意（場次層 vs 方案層並存）。
