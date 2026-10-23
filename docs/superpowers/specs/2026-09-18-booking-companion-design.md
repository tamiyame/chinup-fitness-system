# 一對二教練課「同行客人」 — 設計規格

- 日期：2026-09-18
- 狀態：業主已核可設計方向（三個取捨已拍板）

## 背景

一對一／一對二教練課現在只記一位客人（`bookings.member_id`），公開預約頁只收一組姓名電話；教練後台「登錄預約」的一對二是從某位客人的 1對2 方案產生；我的課表按 `member_id` 查。一對二實際是兩個客人上課，第二位查不到自己的課。

## 業主拍板

1. **入口**：公開預約頁、教練後台登錄預約、後台編輯預約三條路都能填／改同行客人。
2. **權限**：第二位在我的課表看得到這堂課，**也可以取消**（取消的是同一筆預約，主客人的課一併取消）。
3. **通知**：第二位與主客人同步收會員端通知（預約成功／取消／改期）；跟錢有關的（款項確認、退款、續購提醒）只給主客人。
4. 選填、不強制、可留白。

## 資料模型

- `bookings` 加欄 `member2_id INTEGER REFERENCES users(id)`（可空）。`schema.js` CREATE TABLE 加欄；`connection.js` `addColumnIfMissing('bookings', 'member2_id', 'INTEGER REFERENCES users(id)')`。
- 語意：`member_id`＝主客人（付款者、方案持有人）；`member2_id`＝同行客人。只允許 `session_type = '1on2'` 有值。
- 同行客人一律是 `users` 列（role `user`）：公開頁以姓名＋電話 `findOrCreateUserByPhone`（沿用員工電話守門 → 409 `phone_unavailable`、封存自動還原）；教練登錄／後台編輯以既有會員 id 或當場「新增客人」。
- 守則（service 層，所有入口共用）：
  - 非 1對2 帶同行 → 400 `companion_not_allowed`。
  - 同行 = 主客人（同 user id 或同電話）→ 400 `companion_same_person`。
  - 同行 id 不存在或非 `user` → 404 `companion_not_found`。
  - 公開頁姓名／電話只填其一、或電話格式不合 → 400 `invalid_companion`。

## 變更點

### 1. Service（`src/services/bookingService.js`）

- `createBookingAnon({ …, companion = null })`：`companion = { name, phone } | null`；1對2 且有值 → 解析成 user、寫 `member2_id`；回傳多 `companionName`。
- `createBookingCore` 多 `member2Id = null` 參數，INSERT 寫入。
- `createCoachRegister({ …, companionId = null })`：方案須 `1on2` 才允許；每筆建立的 booking 都寫 `member2_id`；循環摘要通知同行也收一則 `booking_recurring_created`。`previewCoachRegister` 不動。
- 新增 `setBookingCompanion({ bookingId, companionId, actorUserId, isAdmin })`：教練本人或管理者；booking 須 confirmed 且 1對2；`companionId = null` 清除。新同行收 `booking_confirmed`；被移除者收 `booking_cancelled_by_shop`（`reason_suffix`「（同行名單變更）」）。
- `reassignBooking`：新方案為 1對1 → 清 `member2_id`；新主客人 = 原同行 → 清 `member2_id`；否則保留。
- `rescheduleBooking`：同行也收 `booking_rescheduled`。
- `cancelBooking`（教練／管理者代取消）、`cancelBookingAdmin`、`refundBookingAdmin`：同行收與主客人同款的取消通知（`booking_cancelled_by_coach`／`booking_cancelled_by_shop`）；退款通知只給主客人。
- `cancelBookingAnon`：擁有權放寬為 `user.id === member_id || user.id === member2_id`；取消後通知教練（`booking_cancelled_by_member`，`member_name`＝取消者）與**另一位客人**（新模板 `booking_cancelled_by_companion`）。
- `cancelBookingFromGcal`：回傳多 `companionName`（gcalPull 管理者通知用，可選）。
- 員工端通知的 `member_name` 一律用 `partyLabel(b)`：無同行＝主客人名，有同行＝`主客人＋同行`（全形＋）——`booking_created`（教練＋管理者）、`booking_cancelled_by_shop_coach`、`booking_rescheduled_coach`、`booking_recurring_created_coach`。

### 2. 通知模板（`src/services/notifications.js`、`src/services/lineNotifyPolicy.js`）

```js
booking_cancelled_by_companion: {  // 寄給另一位客人（同行取消了共用的一對二預約）
  subject: '同行取消預約 - {{coach_display_name}}',
  body: '⚠️ 您與 {{other_name}} 同行的 {{coach_display_name}} 教練課（{{start_at}}）已由 {{other_name}} 取消，此堂課不會進行。',
},
```

- `lineNotifyPolicy.js` 的 `booking_cancel_member` 項目 `types` 加 `booking_cancelled_by_companion`；`tests/line-notify-policy.test.js` 的 `ACTIVE_TYPES` 同步加（否則「無多餘」斷言會倒）。
- 後台通知紀錄 `typeLabel` 加 `booking_cancelled_by_companion: '同行取消'`（admin.js）。

### 3. 我的課表（`src/services/groupOrderService.js` `getPublicSchedule`、`public/my-schedule.js`）

- bookings 查詢改 `WHERE (b.member_id = ? OR b.member2_id = ?) AND b.status != 'cancelled'`，LEFT JOIN 兩位客人姓名；每筆多回：
  - `is_companion`：查詢者是同行（`member2_id = 查詢者`）。
  - `companion_name`：**對方**的名字（主客人看到同行名；同行看到主客人名）；無同行為 `null`。
  - `paid`／`can_cancel` 兩種身分同規則（同一筆預約）。
- 卡片：有同行時在時間列後加 `<span class="sn-mate">同行：陳小華</span>`；查詢者是同行則顯示 `與 王小明 同行`。狀態文字不變（已確認／待確認／已完課）。請假鈕（取消）兩種身分都出現。
- `DELETE /api/public/bookings/:id` 走放寬後的 `cancelBookingAnon`。

### 4. API（`src/server.js`）

- `POST /api/public/bookings`：body 多 `companionName`、`companionPhone`（皆選填）。route 層：兩者只填其一 → 400 `invalid_companion`；`companionPhone` 有值須過 `isValidPhone` 否則 400 `invalid_companion`；`sessionType !== '1on2'` 而有同行 → 400 `companion_not_allowed`；成功回應多 `companionName`。
- `POST /api/coach/register`：body 多 `companionId`（選填，數字）。
- 新增 `PATCH /api/coach/bookings/:id/companion`（requireCoach）body `{ companionId: number | null }` → `setBookingCompanion`；完成後 `syncBookingUpdate`（gcal 標題含同行）。
- `GET /api/coach/bookings/week`（`coachCalendarService`）與教練預約列表、後台待核對／已核對卡片（`listPendingPaymentBookings`／已核對清單）：SELECT 多 `companion_name`（`LEFT JOIN users u2 ON u2.id = b.member2_id`）與 `member2_id`。

### 5. 前端

- **公開預約彈窗**（`public/coaches.html`／`coaches.js`）：選 1對2 時顯示區塊「同行客人（選填）」：姓名、電話兩欄＋小字「留白也可以；填了兩位都能在我的課表查到這堂課」；切回 1對1 隱藏並清空。送出前驗證：只填其一 → 欄位錯誤「請一併填寫同行客人的姓名與電話」；電話格式同主客人規則。成功頁若有同行顯示「同行：陳小華」。
- **教練登錄預約**（`public/coach.js` regm）：選定方案為 1對2 時出現「同行客人（選填）」搜尋框（沿用 `regm-search` 的搜尋／挑選／「新增客人」小表單），選定後顯示可移除的名牌；`doRegmSubmit` 帶 `companionId`。方案切回 1對1 隱藏並清空。
- **編輯預約彈窗**（`public/coach.js` bke）：1對2 預約顯示「同行：X　電話」與按鈕「設定同行」／「移除同行」；設定走同一套搜尋框 → `PATCH …/companion`。1對1 不顯示。
- **教練週曆**（`coach.js` reg-bk 名牌）與**後台待核對／已核對卡片**（`admin.js`）：有同行時名字顯示 `王小明＋陳小華`。
- **gcal**（`gcalSync.js`）：summary `1對2教練課 教練×王小明＋陳小華`；description 多一行 `同行：陳小華（電話）`。
- **email 確認信**（`emailService.js`）：有同行時多一行「同行：陳小華」。

### 6. 邊角（明訂）

- 同行取消 → 整筆預約取消、回補主客人方案（若有）、釋放折扣，與主客人取消完全相同；`cancelled_by` 記同行 user id。
- 主客人取消 → 同行收 `booking_cancelled_by_companion`。
- 同行沒有付款資訊：`getPublicSchedule` 對同行仍回 `paid`（同一筆狀態），卡片不另顯示金額（本來就不顯示教練課金額）。
- 續購提醒／方案剩餘、薪資、容量（1對2 佔 2 人）、折扣、付款流程全部不變。
- LINE 綁定碼：公開預約成功頁只給主客人；同行之後可在我的課表自行綁定。
- 舊資料 `member2_id` 全 NULL，行為不變。

## 測試

- `tests/booking-anon.test.js`：1對2 帶同行 → `member2_id` 寫入、兩人皆存在、教練 `booking_created` 的 `member_name` 為「A＋B」、同行收 `booking_confirmed`；同行電話＝主客人 → 400 `companion_same_person`；1對1 帶同行 → 400 `companion_not_allowed`；同行電話是員工 → 409 `phone_unavailable`；同行取消 → 已取消、教練收 `booking_cancelled_by_member`（member_name＝同行）、主客人收 `booking_cancelled_by_companion`；無關者取消 → 403。
- `tests/my-schedule-service.test.js` 或新檔 `tests/booking-companion-schedule.test.js`：主客人與同行各自 `getPublicSchedule` 都列出該筆；`is_companion`／`companion_name` 正確；取消後兩邊都不列。
- `tests/coach-register.test.js`：1對2 方案帶 `companionId` → 所有建立的 booking `member2_id` 相同、循環摘要通知同行一則；1對1 方案帶同行 → 400；同行＝主客人 → 400；不存在 → 404。
- `tests/booking-edit.test.js`：`setBookingCompanion` 設定／清除／權限 403／1對1 400；`reassignBooking` 轉 1對1 方案清同行、新主客人＝原同行清同行、否則保留；`rescheduleBooking` 同行收 `booking_rescheduled`。
- `tests/migration.test.js`：舊 schema 升級後 `bookings` 有 `member2_id`。
- `tests/line-notify-policy.test.js`：`ACTIVE_TYPES` 加新模板、目錄涵蓋。
- API：`tests/booking-anon-api.test.js`（或併入既有 `booking-validate-api`）：POST 帶同行 201 且回 `companionName`；只填其一 400；`POST /api/public/my` 用同行電話查到該筆且 `is_companion` true；`DELETE /api/public/bookings/:id` 同行可取消；`PATCH /api/coach/bookings/:id/companion` 200／403／400。
- 完整 unit 鏈 `DB_PATH="$(mktemp -d)/t.db" npm test` 全綠；API 鏈相關檔逐檔跑後 `npm run seed`。

## 範圍外（YAGNI）

- 三人以上（同行只有一位）。
- 同行分攤付款／各自付款。
- 同行的 email 確認信（無 email 欄）。
- 從我的課表「加入同行」（只在三個入口填）。
