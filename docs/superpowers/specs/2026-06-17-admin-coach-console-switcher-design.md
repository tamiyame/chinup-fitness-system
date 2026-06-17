# 管理者於教練後台代選教練檢視／編輯 — 設計文件

> 日期：2026-06-17
> 範圍：單一子系統（教練後台 + 其支援 API），一份 spec 可獨立實作。

## 目標

讓**管理者（`is_admin=1` 的教練）**在「教練後台」頁面透過標題旁的下拉選單選擇任一已啟用教練，下方三個分頁（我的預約／可預約時段／個人資料）即帶出該教練的資料，並可直接修改。一般教練看不到下拉，行為完全不變（只能管理自己）。

## 已拍板決策

1. **可修改範圍 = 三項全包**：預約（緊急取消未來課程）、班表（每週規則＋請假/加開例外）、個人資料（顯示名稱／專長／簡介／頭像）。
2. **下拉只列已啟用教練**（`is_active=1`）；但若管理者本身的教練檔案未啟用，仍須把「自己」這個選項補進清單，以支援「預設顯示自己」。
3. **代教練取消預約 = 比照教練本人取消**（coach-flavored）：會員收到「教練取消了您的課程」通知、需填原因；不走管理者雙向通知流程。
4. **預設顯示自己**：管理者一進來預設選中自己的教練檔案（若有）。管理者若沒有教練檔案則顯示「請先選擇教練」空狀態、不再導回首頁。
5. **下拉位置**：在 `<h1>教練後台</h1>` 標題的**右側、同一行**（依業主截圖紅框）。

## 既有架構重點（實作前必讀）

- **教練 = 兩列關聯**：`users` 列（`id`、`role`、`is_admin`）一對一對應 `coaches` 列（`coaches.id` 即各處用的 coachId、`user_id`、`display_name`、`specialty`、`bio`、`avatar_path`、`is_active`、`sort_order`）。`bookings`／`coach_availability_rules`／`coach_availability_exceptions` 全部 FK 到 `coaches.id`，**不是** `users.id`。
- **管理者 = `is_admin=1` 的教練**（已無 owner 角色）。`requireCoach` 只檢查 `role==='coach'`，所以管理者也通得過所有 `/api/coach/me/*`，今天只是被綁在自己的教練檔案上。
- **教練後台目前的 11 支端點**全部以 `loadCoachForUser(req,res)`（= `svcGetCoachByUser(req.user.id)`，無教練檔案回 404 `coach_record_not_found`）解析 coachId，**沒有任何 coachId 參數**。service 層（`svcListRules`/`svcAddRule`/`svcDeleteRule`/`svcListExceptions`/`svcAddException`/`svcDeleteException`/`svcListCoachBookings`/`svcComputeSlots`/`svcUpdateCoach`/`svcGetCoach`/`svcSaveAvatar`）本來就吃明確的 coachId。
- **預約取消**走 `DELETE /api/bookings/:id`（`requireUser`）：由 `booking.coach_id` 取得教練，`actorIsCoach = coach && coach.user_id === req.user.id`，再呼叫 `svcCancelBooking({bookingId, actorUserId, isCoach, reason})`；`cancelBooking` 內 coach 路徑會再驗 `coach.user_id === actorUserId`（否則 403）、且要求非空 reason。
- **既有可重用**：`GET /api/admin/coaches`（requireAdmin）回完整教練清單（含未啟用）；管理者已能用 `PATCH /api/admin/coaches/:id` 改任一教練 profile/is_active/sort_order、用 `POST /api/admin/bookings/:id/cancel` 取消任一預約。

## 架構

### 後端：單一 resolver，零 service 改動

新增 `resolveCoach(req, res)`（取代 11 支 `/api/coach/me/*` 內的 `loadCoachForUser(req,res)`）：

```js
function resolveCoach(req, res) {
  const wanted = req.query.coachId ?? req.body?.coachId;
  if (wanted != null && wanted !== '' && req.user.is_admin) {
    const c = svcGetCoach(Number(wanted));
    if (!c) { res.status(404).json({ error: 'coach_not_found' }); return null; }
    return c;
  }
  return loadCoachForUser(req, res); // 既有：self 查詢，無檔案回 404 coach_record_not_found
}
```

替換點（11 支）：`GET /api/coach/me`、`PATCH /api/coach/me/profile`、`GET/POST /api/coach/me/rules`、`DELETE /api/coach/me/rules/:id`、`GET/POST /api/coach/me/exceptions`、`DELETE /api/coach/me/exceptions/:id`、`GET /api/coach/me/bookings`、`GET /api/coach/me/availability-preview`、`POST /api/coach/me/avatar`。

- coachId 來源：GET/DELETE 走 query（`?coachId=`）、POST/PATCH 走 body（`coachId`）。
- **安全**：覆寫只認 `req.user.is_admin`；一般教練即使硬塞 coachId 也只會落回 self。service 層仍以 `coach_id` 設防（如 `deleteRule` 比對 `rule.coach_id`、`deleteException` `WHERE id=? AND coach_id=?`），縱深防護不變。
- `resolveCoach` 回傳 `null` 時表示已送出回應（404），handler 須 `if (!coach) return;`（沿用 `loadCoachForUser` 既有慣例）。

### 後端：代取消預約（coach-flavored）

`DELETE /api/bookings/:id` 增加管理者代理路徑：

- 讀 `coachId`（query 或 body）。當 `req.user.is_admin && Number(coachId) === booking.coach_id` → 視為「該教練本人取消」：`actorIsCoach = true`，並把這個「管理者代理」訊號傳進 service。
- `svcCancelBooking` 增加一個旗標（如 `adminOnBehalf:true`），**只在該旗標為真時跳過** `coach.user_id === actorUserId` 這道擁有權檢查；其餘行為完全不變（仍要求非空 reason、仍以 coach 路徑通知會員「教練取消」、仍 `releaseRedemption`）。
- 非管理者：`adminOnBehalf` 永遠為 false，原擁有權檢查與 403 行為一字不變。

### 前端：coach.js / coach.html

**coach.html**：把現有 `<h1 class="page-title">教練後台</h1>`（約 206 行）與新 `<select id="coach-picker">` 包進同一列容器：

```html
<div class="flex items-center gap-4 flex-wrap">
  <h1 class="page-title">教練後台</h1>
  <select id="coach-picker" class="form-input hidden" style="width:auto;"></select>
</div>
```

（kicker `COACH · 教練後台` 仍在上方；分頁列維持不變。）

**coach.js**：
- 模組狀態新增 `let isAdmin = false; let selectedCoachId = null;`，新增 helper `coachQuery()`（管理者且有 selectedCoachId 時回 `?coachId=<id>`，否則回 `''`）。
- `init()` 改為**先抓 `/api/auth/me`**（拿 `is_admin`、`role`），再決定：
  - 若 `is_admin`：`isAdmin=true`，填入並顯示 `#coach-picker`（`GET /api/admin/coaches` → 過濾 `is_active=1`；若自己的教練檔案不在其中，仍把自己補進清單）。預設 `selectedCoachId = 自己的 coach.id`（`GET /api/coach/me`；若 404 → `me=null`、`selectedCoachId=null`、顯示「請先選擇教練」空狀態、**不**導回 `/`）。設定 `#coach-picker.value`。
  - 非管理者：完全照舊——`me = await api('/api/coach/me')`，404 → `location.href='/'`。
- 所有資料呼叫帶上 `coachQuery()`：
  - GET：`renderBookings` → `/api/coach/me/bookings${coachQuery()}`；`renderAvailability` → rules/exceptions 兩個 GET 各加；`renderProfile` 用快取 `me`（切換時已重抓）。
  - 寫入：POST rules/exceptions 與 PATCH profile 的 body 加 `coachId: selectedCoachId`（管理者時）；DELETE rule/exception 的 URL 加 `coachQuery()`；POST avatar body 加 `coachId`。
  - 取消：`DELETE /api/bookings/${id}${coachQuery()}`（body 仍含 reason）。
- 下拉 `change`：設 `selectedCoachId`、重抓 `me = GET /api/coach/me${coachQuery()}`（更新標題列與 `#pending-banner` 的啟用狀態）、切回「我的預約」分頁、重渲染當前分頁。
- 管理者選到自己時一律也帶 `coachId=自己`（統一路徑；resolver 對 self 同樣成立）。

## 資料流（管理者切換到教練 X）

1. 下拉 change → `selectedCoachId = X`。
2. `GET /api/coach/me?coachId=X` → resolver 認 is_admin → `svcGetCoach(X)` → 回 X 的 coach record → 更新標題/橫幅。
3. 切到「可預約時段」→ `GET /api/coach/me/rules?coachId=X` + `/exceptions?coachId=X`。
4. 新增規則 → `POST /api/coach/me/rules {coachId:X, day_of_week, start_time, end_time}`。
5. 取消 X 的某筆未來預約 → `DELETE /api/bookings/:id?coachId=X {reason}` → coach-flavored 取消、會員收「教練取消」。

## 邊界情況

- **管理者無教練檔案**：`GET /api/coach/me` 404 → 空狀態「請先選擇教練」，不導回首頁；選了教練後一切正常。
- **管理者自己的教練檔案未啟用**：仍預設選自己（`GET /api/coach/me` 不檢查 is_active），且自己被補進下拉，避免選項對不上。
- **非管理者硬送 coachId**：resolver 忽略 → 落回 self；service 層再設防。
- **壞 coachId / 不存在**：resolver 回 404 `coach_not_found`。
- **代取消他人預約但 coachId 與 booking.coach_id 不符**：不視為代理 → 落回原邏輯（非擁有者 → 403），避免越權取消別的教練的課。

## 測試

API 測試（沿用 `tests/*.test.js`，需啟動 server，比照現有 coach/booking 測試的登入取 token 模式；管理者帳號 `admin@chinup.local`）：

1. 管理者帶 `coachId` 能讀另一教練的 rules / exceptions / bookings / profile / availability-preview。
2. 管理者帶 `coachId` 能新增/刪除另一教練的 rule 與 exception、PATCH profile、POST avatar，且寫入落在**該教練**的 `coaches.id`。
3. **非管理者**帶他人 `coachId` → 只拿到/只能改自己的資料（覆寫被忽略）。
4. 壞 `coachId` → 404 `coach_not_found`。
5. 代取消：管理者帶相符 `coachId` 取消他人未來預約 → 成功、coach-flavored（會員收到通知、需 reason）；非管理者非擁有者取消 → 403；reason 空 → 400。
6. 回歸：教練本人（無 coachId）所有 `/api/coach/me/*` 行為不變。

## 不做（YAGNI）

- 不加稽核日誌、不在會員通知裡標「由管理者代為操作」。
- 不支援把未啟用教練排進下拉（業主選只列已啟用；自己例外）。
- 不新增獨立 `/api/admin/coaches/:id/rules` 系列端點（沿用 `/api/coach/me/*` + resolver，避免重複）。
