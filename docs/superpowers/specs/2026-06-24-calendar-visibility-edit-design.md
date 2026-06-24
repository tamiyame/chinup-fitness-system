# 登錄預約行事曆：角色可見範圍 + 預約編輯 — 設計文件

> 日期：2026-06-24
> 範圍：單一 PR（PR3，建立在已合併的 PR2 週曆登錄之上）。後端擴充週彙整 + 2 個編輯端點；前端週曆全覽 + 編輯彈窗。
> 業主已於 brainstorming 拍板（見「已拍板決策」）。

## 問題
PR2 的「登錄預約」週曆目前是**單一教練**檢視（管理者用下拉代選），且已登錄的預約**只能看、不能改**。業主要：
1. 一般教練只看自己的預約；管理者能看**所有教練**的預約。
2. 點已登錄的預約可**編輯**（取消／改時段／改客人或方案）。

## 背景（已查證，含 file:line）
- 週彙整：`src/services/coachCalendarService.js` `getCoachWeek({coachId,start})` → `{weekStart, bookings, groupSessions, availableSlots}`，單一教練。端點 `GET /api/coach/week`（`requireCoach`+`resolveCoach`）。
- 前端：`public/coach.js` `renderRegister()` 畫週曆；`setupCoachPicker()`/`onCoachChange()` 管理者下拉（option 為各 active coach，預設選自己）；`coachQuery()`/`withCoach()`；登錄彈窗 `openRegisterModal`。
- 取消預約既有路由：`DELETE /api/bookings/:id`（`requireUser`，server.js:1005）。內部判定 `ownerIsCoach`（booking.coach.user_id===req.user.id）或 `adminOnBehalf`（`is_admin` + query/body `coachId`===booking.coach_id）→ `svcCancelBooking({isCoach, adminOnBehalf, reason})`，再 `syncBookingCancel(id)`。**取消會回補方案**（PR1：`refundPackageForBooking` 掛在 `cancelBooking` 轉移當下）。
- gcal：事件用**決定性 id** `eventIdForBooking(id)`；`syncBookingCancel(id)` 以決定性 id 刪事件、清 `gcal_event_id`、**不碰 booking 狀態**；`syncBookingCreate(id)` 以當前 `start_at/end_at` 重建。→ 改時段/改客人可用「cancel→create」鏈刷新事件（GCAL_MOCK 下為 no-op）。
- 方案原語（PR1）：`getPackage(id)`（含 `is_valid`/`member_id`/`session_type`/`amount`/`total_sessions`/`remaining_sessions`）、`deductOne(id)`、`refundOne(id)`。`bookingService.js` 已 import `pkgGetPackage`/`pkgDeductOne`/`refundPackageOne`。
- bookings 欄：`coach_id, member_id, start_at, end_at, status, session_type, package_id, paid_at, paid_by, original_amount, discount_code, discount_amount, gcal_event_id, recurring_group_id`。UNIQUE 部分索引 `bookings_coach_start_confirmed(coach_id,start_at) WHERE status='confirmed'`。

## 已拍板決策（業主，brainstorming 2026-06-24）
1. **管理者全覽**：下拉加「全部教練」並**預設選此**；週曆顯示所有教練預約（每筆標 `客人名・教練名`，同格多教練則堆疊）。一般教練只看自己（不變）。
2. **全部教練模式**：純檢視 + 可點任何預約編輯；**空格不可登錄**（點空格提示先選教練）。
3. **選定某教練**：該教練空格可登錄、底色顯示該教練班表；其他教練預約仍以**淡色脈絡**顯示（仍可點擊編輯）。
4. **編輯操作**：取消（方案登錄自動回補堂）、改時段（改期，同教練）、改客人或方案。
5. **範圍**：所有一對一預約皆可編輯/取消（含公開頁、舊循環、方案登錄）。非方案預約取消不回補；改客人/方案會轉成方案登錄（設 `paid_at`、清折扣欄）。
6. **權限**：一般教練只能編輯/取消自己的預約；管理者可編輯/取消任一教練的預約（後端雙重把關）。

> 實作修正（業主原話「下拉加全部教練」）：因頂部下拉為所有分頁共用、加 all 會破壞單一教練分頁，故「全部教練」選擇器改放在**登錄分頁自己的工具列**（不動共用下拉），達成相同意圖（管理者於登錄週曆預設全覽）。見「架構/前端」。

## 架構

### 後端

**(1) 週彙整全覽模式（coachCalendarService.js）**
- `getCoachWeek` 擴充：新增可選 `all`（布林）。
  - `all=true`：bookings = **所有教練** confirmed（join coaches 取 `coach_id`/`coach_name`、join users 取 `member_name`）；groupSessions = 所有教練（含 `coach_name`）；availableSlots = 若給 `coachId` 則該教練的、否則 `[]`。
  - `all=false`（預設）：現狀單一教練（bookings 也補回 `coach_name`，欄位形狀一致）。
- 端點 `GET /api/coach/week?start=&all=1&coachId=`：`all=1` **僅管理者**有效（`req.user.is_admin`；非管理者忽略 all、落回自己）。`coachId` 仍經 `resolveCoach`（管理者代選底色/登錄目標）。

**(2) 改時段 `rescheduleBooking`（bookingService.js）**
- `rescheduleBooking({ bookingId, newStartAt, actorUserId, isAdmin })`：
  - 載入 booking；`cancelled` → 409 `already_cancelled`。
  - 權限：`!isAdmin` 且 booking 的 coach.user_id !== actorUserId → 403 `forbidden`。
  - 驗 `newStartAt`（`START_AT_RE`，整點）；`newEndAt = +60`。
  - 衝突：同教練、`newStartAt`、`status='confirmed'`、id≠本筆 → 409 `slot_taken`（前置查 + UNIQUE 兜底）。
  - `UPDATE bookings SET start_at=?, end_at=? WHERE id=?`（不動 member/package/paid）。
  - 通知會員「改期」（新 template `booking_rescheduled`，vars: coach_display_name, start_at）。
  - 端點 `PATCH /api/coach/bookings/:id/reschedule {startAt}`（`requireCoach`）；route 後置 gcal：`syncBookingCancel(id).then(()=>syncBookingCreate(id))`（刪舊事件→以新時間重建）。

**(3) 改客人/方案 `reassignBooking`（bookingService.js）**
- `reassignBooking({ bookingId, newMemberId, newPackageId, actorUserId, isAdmin })`，tx 內：
  - 載入 booking；`cancelled` → 409。權限同上。
  - 若 `booking.package_id` → `refundPackageOne(舊)`（+1）。
  - 新方案：`pkgGetPackage(newPackageId)`；`!p` → 404 `package_not_found`；`p.member_id!==newMemberId` → 400 `package_member_mismatch`；`!p.is_valid` → 409 `package_invalid`。
  - `pkgDeductOne(newPackageId)`；false → 409 `package_depleted`（並因 tx rollback 還原舊回補）。
  - `UPDATE bookings SET member_id=?, package_id=?, session_type=?(新方案), original_amount=?(round(amount/total)或null), discount_code=NULL, discount_amount=NULL, paid_at=?(now), paid_by=?(actor) WHERE id=?`。
  - 通知新會員（`booking_confirmed`，vars coach_display_name/start_at）。
  - 端點 `PATCH /api/coach/bookings/:id/reassign {memberId, packageId}`（`requireCoach`）；route 後置 gcal cancel→create 刷新事件。

**(4) 取消（沿用既有）**
- 編輯彈窗的「取消」呼叫既有 `DELETE /api/bookings/:id`。管理者取消他教練的預約 → 帶 `?coachId=<booking.coach_id>`（觸發 adminOnBehalf）；本人取消自己 → 帶 `coachQuery()`（空）。**不新增取消端點**。

### 前端（public/coach.js / coach.html / style.css）

**週曆全覽（登錄分頁自有選擇器，不動共用下拉）**
> 重要：頂部 `#coach-picker` 為**所有分頁共用**（我的預約/班表/個人資料都需單一教練）。**不可**把「全部教練」加進它（會讓那些分頁壞掉）。改在**登錄分頁工具列**放一個獨立選擇器，只影響登錄週曆。
- 登錄分頁工具列加 `#reg-coach-picker`（**僅管理者顯示**）：第一個 option `全部教練`（value `all`，**預設選此**）+ 各 active coach。狀態變數 `regViewCoachId`（`'all'` 預設 / coachId 字串）。一般教練不顯示此選擇器（永遠自己）。
- 切到登錄分頁時**隱藏共用 `#coach-picker`**（避免兩個下拉混淆）；切離時還原顯示（`switchTab` 內依 `name==='register'` 切換）。
- `renderRegister`：
  - 管理者：一律 `GET /api/coach/week?all=1&start=...`；`regViewCoachId !== 'all'` 時再帶 `&coachId=<regViewCoachId>`（取該教練 availableSlots 底色 + 標記其空格可登錄）。一般教練：現狀 `GET /api/coach/week?start=...`（自己）。
  - 渲染：bookings/groupSessions 改以 **`Map<slotKey, 陣列>`**（全覽同格多教練 → 堆疊）；每筆標 `客人名`，全覽時加 `· 教練名`。`availableSlots` 底色：全覽（無 coachId）無、選定教練時有。
  - 空格可點登錄：一般教練，或管理者 `regViewCoachId !== 'all'`（target=該 coachId）。全覽（`all`）點空格 → toast「請先選擇要登錄的教練」。
  - **預約格可點 → `openBookingEditModal(booking)`**（任何模式、任何來源）。選定教練時，非該教練的預約格淡色（`reg-booked-other`）但仍可點編輯。
  - 登錄送出/編輯後重繪 `renderRegister()`（沿用）。登錄目標教練：管理者用 `regViewCoachId`（非 all 時）取代 `coachQuery()`/`withCoach()` 的來源（登錄 body 帶 `coachId: regViewCoachId`）。

**編輯彈窗（新 `#bkedit-overlay`）**
- 顯示明細：客人、教練、時段、類型（1對1/1對2）、付款狀態、來源（方案登錄/折扣碼/一般）。
- 三按鈕分區：
  1. **取消預約**：confirm（方案登錄提示「將回補 1 堂」）→ `DELETE /api/bookings/:id`（管理者帶該預約 coach_id）→ toast → 關窗 + 重繪。
  2. **改時段**：日期 input + 整點 select → `PATCH .../reschedule` → toast → 重繪。
  3. **改客人/方案**：展開客人搜尋（沿用登錄彈窗的搜尋）→ 選客人 → 列其有效方案（`GET /api/coach/packages?memberId=`，篩 is_valid）→ 選方案 → `PATCH .../reassign` → toast → 重繪。
- 權限呈現：一般教練若點到（理論上看不到）他人預約 → 後端擋；前端對非自己預約（一般教練）不顯示編輯鈕（保險）。

## 安全/守門
- `all=1` 僅管理者；非管理者忽略（落回自己）→ 不外洩他教練資料給一般教練。
- reschedule/reassign：`requireCoach` + service 內 `!isAdmin` 時驗 booking 屬本人教練（縱深；route 傳 `isAdmin=req.user.is_admin`、`actorUserId=req.user.id`）。
- 取消沿用既有 `DELETE` 的 ownerIsCoach/adminOnBehalf 守門。
- reassign 的方案守門：屬新客人 + 有效（沿用 PR1/PR2 規則）。
- 客人搜尋仍只回 id/name/phone（沿用）。

## 不動
- PR1 方案系統、PR2 登錄/循環/expandRecurrence、公開預約頁、團課流程（僅唯讀疊加）。
- 既有取消/退款/付款流程（取消沿用 DELETE 路由）。

## 測試
- `tests/booking-edit.test.js`（unit）：
  - reschedule 成功（移時段、member/package 不變）/衝突→409/一般教練改他人→403/已取消→409。
  - reassign：方案↔方案（退舊+1、扣新−1、type 隨新方案、單價）/非方案→方案（設 paid_at、清折扣）/方案不屬新客人→400/無效方案→409/堂數不足→409+rollback（舊方案不被扣光）/一般教練改他人→403。
  - getCoachWeek `all`：回所有教練 bookings 含 coach_name；`all=false` 仍單一教練且帶 coach_name。
- `tests/booking-edit-api.test.js`（api）：reschedule/reassign 端點正常+守門；`GET /api/coach/week?all=1` 管理者回多教練、非管理者（塞 role=user 或一般教練 token）落回自己/擋；取消他教練（admin 帶 coachId）成功。
- 回歸：既有 `coach-register*`、`booking-*`、`recurring-*` 測試不破壞（reschedule/reassign 為新增；getCoachWeek 加欄不破壞既有單一教練回傳）。

## 收尾
- 瀏覽器 smoke：管理者全覽（多教練疊加）、選教練登錄、點預約編輯（取消/改時段/改客人方案）；一般教練只見自己 + 可編輯自己。實作收尾若建 mock 一併移除。

## 不做（YAGNI）
- 不做跨教練「改授課教練」（改時段限同教練；要換教練＝取消重登）。
- 不做拖曳改期（用日期+整點選）。
- 不做編輯團課場次（僅唯讀疊加）。
- 不在全覽模式做空格直接登錄（須先選教練）。
