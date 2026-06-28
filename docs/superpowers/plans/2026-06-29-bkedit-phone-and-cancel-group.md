# 編輯彈窗顯示電話 + 取消全部預約（循環群組）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 編輯預約彈窗顯示客人電話；新增「取消全部預約」取消該筆所屬循環群組的全部預約。

**Architecture:** week 查詢 BK_COLS 補 `member_phone`/`recurring_group_id`；新 service `cancelCoachGroup`（依 recurring_group_id 取消同教練全部 confirmed、含過去、回補堂數、彙整通知）；新 route `POST /api/coach/bookings/:id/cancel-group`；前端 coach.js 顯示電話 + 條件式按鈕。

**Tech Stack:** Node.js ESM + Express + node:sqlite；vanilla JS；自製 `expect()` 測試 harness。

詳細設計與完整程式碼見 `docs/superpowers/specs/2026-06-29-bkedit-phone-and-cancel-group-design.md`。

## Global Constraints
- 回應繁體中文；技術識別字原樣。
- 取消範圍＝這筆的 `recurring_group_id` 群組、**同教練名下**、`status='confirmed'`、**含過去**；無群組則退化只取消這筆。
- 每筆取消都 `refundPackageForBooking`（回補堂數，含過去）；整批彙整一則通知（`booking_cancelled_by_shop` + 代理時 `booking_cancelled_by_shop_coach`）。
- 授權：非管理者只能取消自己名下（`!isAdmin && coach.user_id !== actorUserId → 403 forbidden`）；管理者可代理但範圍仍鎖該筆教練。
- 「取消全部預約」鈕只在 `recurring_group_id` 存在時顯示。
- 不改 schema、不改單筆取消、不跨教練、不碰團課。

---

### Task 1：後端 week 查詢帶 member_phone + recurring_group_id

**Files:** Modify `src/services/coachCalendarService.js`（BK_COLS）；Test `tests/coach-week-all.test.js`（擴充）。

**Interfaces:** Produces `getCoachWeek().bookings[i]` 多帶 `member_phone`、`recurring_group_id`（非循環為 null）。

- [ ] **Step 1：在 `tests/coach-week-all.test.js` 既有測試後、清理前加失敗測試**
  - 既有 m 客人有 phone（`0980000001`）。插一筆 `recurring_group_id` 非空的本週 booking。斷言 `getCoachWeek({coachId:c1,start}).bookings` 對該筆有 `member_phone='0980000001'` 且 `recurring_group_id` 正確；對既有非循環筆 `recurring_group_id` 為 null。
- [ ] **Step 2：跑 `node tests/coach-week-all.test.js` 確認失敗**（欄位 undefined）。
- [ ] **Step 3：改 `BK_COLS`**（見 spec「功能一/功能二 後端」）：在 `c.display_name AS coach_name,` 後加
  `b.member_id, u.phone AS member_phone, b.recurring_group_id,` 並維持既有 pkg_* 欄位於其後。
- [ ] **Step 4：跑 `node tests/coach-week-all.test.js` 確認全綠**（既有案不受影響）。
- [ ] **Step 5：Commit**
  `git add src/services/coachCalendarService.js tests/coach-week-all.test.js && git commit -m "feat: 登錄週曆預約帶出 member_phone/recurring_group_id 供編輯彈窗"`

---

### Task 2：後端 cancelCoachGroup service + route

**Files:** Modify `src/services/bookingService.js`（新 `cancelCoachGroup`）、`src/server.js`（新 route + import）；Test `tests/booking-edit.test.js`（unit 擴充）、`tests/booking-edit-api.test.js`（api 擴充）。

**Interfaces:**
- Consumes 既有 `getBookingStmt`/`getCoachStmt`/`getUserNameStmt`/`cancelBookingStmt`/`refundPackageForBooking`/`releaseRedemption`/`notify`/`fmtDateForLine`/`tx`/`nowLocal`/`ApiError`。
- Produces `cancelCoachGroup({ bookingId, actorUserId, isAdmin, reason })` → `{ ok:true, cancelled:number[] }`；route `POST /api/coach/bookings/:id/cancel-group`。

- [ ] **Step 1：在 `tests/booking-edit.test.js` 末尾（clean 前）加失敗 unit 測試**
  - import `cancelCoachGroup`（與既有 `rescheduleBooking, reassignBooking` 同一 import 行補上）。
  - 建一個 `recurring_group_id`（任意整數，如 `7001`）的群組：1 筆過去（裸 INSERT `start_at` 過去日）+ 1 筆未來（mkBk 之外另插，帶 group + package + paid_at），都 coach、member m1、掛同方案 pOld。先 deductOne 模擬已扣。
  - 斷言：`cancelCoachGroup({bookingId:群組任一筆, actorUserId:cu, isAdmin:false})` → 兩筆都 cancelled、回 `cancelled` 含兩 id、方案堂數各回補（共 +2）。
  - 斷言：非該教練的一般教練（cu2）對此群組 → throws `/forbidden/`。
  - 斷言：群組混入 coach2 的一筆同 group_id booking → 不被取消（範圍鎖 coach_id）。
  - 斷言：無 group 的單筆 → 只取消該筆（回 `cancelled` 長度 1）。
- [ ] **Step 2：跑 `node tests/booking-edit.test.js` 確認失敗。**
- [ ] **Step 3：在 `src/services/bookingService.js` 加 `cancelCoachGroup`**（完整程式碼見 spec「功能二 後端 bookingService」）。放在 `cancelBookingAdminGroup` 附近。
- [ ] **Step 4：跑 `node tests/booking-edit.test.js` 確認全綠。**
- [ ] **Step 5：在 `src/server.js` 接線**：import 區 `cancelCoachGroup as svcCancelCoachGroup`（與既有 booking service import 同處）；在 reassign route 之後加 route（完整見 spec「功能二 route」）。
- [ ] **Step 6：在 `tests/booking-edit-api.test.js` 加 api 測試**（先讀檔頭沿用既有 admin token / coach session token 慣例）：建群組（裸 INSERT，帶 recurring_group_id + package + paid_at）→ `POST /api/coach/bookings/:id/cancel-group`（admin token）→ 200 + `cancelled` 含全部 + DB 變 cancelled；另用非該教練的一般教練 session token → 403 forbidden。
- [ ] **Step 7：跑 `node tests/booking-edit.test.js`（需 server 起的話 api 部分另跑）；service 部分 `npm test` 綠。**
- [ ] **Step 8：Commit**
  `git add src/services/bookingService.js src/server.js tests/booking-edit.test.js tests/booking-edit-api.test.js && git commit -m "feat: 取消全部預約端點 cancelCoachGroup（依循環群組、同教練、含過去、回補、彙整通知）"`

---

### Task 3：前端 coach.js 顯示電話 + 取消全部按鈕

**Files:** Modify `public/coach.js`（`renderBkeditBody` + 新 `doBkCancelGroup`）。

**Interfaces:** Consumes Task 1 的 `member_phone`/`recurring_group_id`、Task 2 的端點；既有 `escapeHtml`/`api`/`toast`/`bkeditClose`/`renderRegister`/`bkeditBooking`。

- [ ] **Step 1：`renderBkeditBody` 客人行加電話**（見 spec）：
  `<div><b>客人：</b>${escapeHtml(b.member_name)}${b.member_phone ? \`　${escapeHtml(b.member_phone)}\` : ''}</div>`
- [ ] **Step 2：按鈕區「取消預約」後加條件式「取消全部預約」鈕** + 綁定（見 spec）。
- [ ] **Step 3：新增 `doBkCancelGroup`**（見 spec，含 confirm/toast/錯誤對照）。
- [ ] **Step 4：`npm test` 確認後端無回歸（前端無自動化測試）。**
- [ ] **Step 5：Commit**
  `git add public/coach.js && git commit -m "feat: 編輯彈窗顯示客人電話 + 取消全部預約按鈕(循環群組)"`

---

## Self-Review
- **Spec coverage**：功能一(週欄+前端電話)=Task1+Task3；功能二(service+route+前端鈕+tests)=Task2+Task3。齊。
- **Placeholder scan**：步驟皆具體；測試斷言明列；完整程式碼於 spec。
- **Type consistency**：`cancelCoachGroup({bookingId,actorUserId,isAdmin,reason})→{ok,cancelled}` 在 service/route/測試一致；`member_phone`/`recurring_group_id` 欄名在 BK_COLS/前端/測試一致。
