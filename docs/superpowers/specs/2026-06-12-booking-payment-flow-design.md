# 教練課付款狀態流 + 預約視窗無上限 + 教練列表排序 設計規格

日期：2026-06-12
狀態：已與業主確認設計決策，待實作

## 1. 目標

三項變更（同一分支 `feat/booking-payment-flow`）：
1. 可預約日期**無上限**（移除 30 天視窗，與 Google Calendar 一致）。
2. 教練後台「預約」列表排序改為**建立時間新→舊**（新預約排最上面）。
3. 教練課（1對1/1對2）導入**付款狀態流**：預約成立後為「待確認」，出現在後台「待核對匯款」；admin 核對後移入新的「已核對匯款」區塊，顧客端狀態轉「已確認」。

### 已確認的設計決策

| 決策點 | 結論 |
|---|---|
| 待確認預約逐期處理 | **不逐期自動取消**（現場繳費邏輯：預約一直佔時段直到上課或取消） |
| 核對後通知顧客 | **LINE＋Email 都發**（email 限預約時有填寫者） |
| 「已核對匯款」區塊內容 | **教練課＋團課訂單都放**（合併按核對時間排序） |
| 上線時既有預約 | **未來場次進待核對**、過去場次視為已核對（backfill paid_at=created_at） |

### 範圍外（明確不做）
- 待確認預約的自動逐期/過期釋出
- Google 日曆事件依付款狀態改標題/顏色（事件照舊於預約成立時建立）
- 團課訂單流程改動（僅在「已核對」區塊多一個唯讀呈現）

## 2. Item 1：預約視窗無上限

- `src/services/availabilityService.js`：`computeAvailableSlots` 的 `bookingWindowDays` 預設改為 `null`；`null` 時跳過 `windowEndMs` 上限過濾。移除 `BOOKING_WINDOW_DAYS` 常數（grep 全 repo 確認無其他 import）。參數保留供測試指定。
- 其餘界限不變：2 小時緩衝、`s <= nowStr` 過去過濾、rules 的 effective_from/to、請假/加開、freebusy（前端逐週載入，每週一次查詢，無效能疑慮）。
- 前端不用動（週導覽本就無上限，之前是 server 端把遠期濾掉）。
- 測試：`tests/booking-flow.test.js` 內原以 `bookingWindowDays: 365*100` 規避上限的呼叫可簡化但不必動；新增斷言「兩年後的日期仍有 slot」。

## 3. Item 2：教練後台預約列表排序

- `src/services/bookingService.js` 的 `listCoachStmt`：`ORDER BY b.start_at DESC` → `ORDER BY b.created_at DESC, b.id DESC`（同秒建立以 id 決勝，新→舊穩定排序）。
- `created_at` 為 SQLite `datetime('now')`（UTC 字串），單調遞增、排序正確，不需轉換。
- 教練端卡片同時加付款狀態 badge（見 Item 3）。

## 4. Item 3：教練課付款狀態流

### 4.1 資料模型（additive，`addColumnIfMissing`）

| 變更 | 用途 |
|---|---|
| `bookings.paid_at TEXT` | NULL = 待確認；非 NULL = 已核對（鏡像 `group_orders.paid_at`） |
| `bookings.paid_by INTEGER REFERENCES users(id)` | 核對經手人（鏡像 `group_orders.paid_by`） |

**一次性 backfill**（偵測訊號＝`paid_at` 欄位不存在，與 `course_sessions.coach_id` 遷移同模式）：加欄位後執行
`UPDATE bookings SET paid_at = created_at WHERE status='confirmed' AND start_at < <nowLocal>` —— 過去場次視為已核對；未來場次留 NULL 進待核對清單（業主決策）。重跑為 no-op。

**語意不變式**：`status` 仍只有 `confirmed`/`cancelled`（不動 CHECK）。待確認的預約照常佔時段、佔容量、建日曆事件；取消流程（顧客匿名/教練緊急）不變，取消待確認預約同樣釋放折扣。

### 4.2 顧客端（my-schedule）

- `getPublicSchedule` 的 bookings 查詢加 `b.paid_at`，回傳項目加 `paid: !!b.paid_at`。
- `public/my-schedule.js` `statusInfo()`：booking 的 `confirmed` 分支改為 `paid ? '已確認'(badge-confirmed) : '待確認'(badge-waitlisted)`；`cancelled` 不變。
- `can_cancel` 規則不變（待確認也可自行取消）。

### 4.3 教練端（coach.html 預約列表）

- `listCoachStmt` 是 `SELECT b.*` 已含 `paid_at`；`public/coach.js` `renderBookings` 卡片加 badge：`已取消` / `待確認` / `已確認`（樣式沿用 my-schedule 的 badge class）。

### 4.4 Admin API（皆 requireAdmin）

| 端點 | 行為 |
|---|---|
| `GET /api/admin/bookings/pending` | `status='confirmed' AND paid_at IS NULL`，JOIN coaches/users，回 id、member_name、phone、coach_display_name、start_at、session_type、final_amount（original−discount，NULL 容忍）、discount_code、created_at；`ORDER BY created_at DESC` |
| `POST /api/admin/bookings/:id/confirm-payment` | 守門：404 not_found／409 already_cancelled／409 already_paid。寫 `paid_at=nowLocal(), paid_by=req.user.id`（tx 內）。commit 後 fire-and-forget：LINE `booking_payment_received` 通知會員＋有 `customer_email` 則寄「款項確認」信 |
| `GET /api/admin/payments/confirmed` | 合併「教練課 paid_at NOT NULL」與「團課訂單 status='paid'」，各帶 type（`booking`/`group_order`）、姓名、電話、金額、課程時間（教練課）/付款場次數（團課）、paid_at、經手人姓名（LEFT JOIN users ON paid_by，NULL 容忍→'—'）；合併後 `ORDER BY paid_at DESC LIMIT 50` |

### 4.5 Admin UI（報名作業 panel，`#pending-orders` 區）

- **待核對匯款**：現有團課訂單清單之外，併入教練課待確認預約（同一清單、`type` 標籤「教練課」/「團課」、按 created_at 新→舊）。教練課列顯示：姓名、電話、教練、課程時間、方案（1對1/1對2）、應收金額（含折扣註記）＋「**已收款**」按鈕 → `confirm-payment`，成功 toast 並重載兩個清單。空清單文案維持「目前沒有待核對的匯款」。
- **已核對匯款**（新區塊，置於待核對之下、系統操作之上）：唯讀清單呈現 `GET /api/admin/payments/confirmed`（type 標籤、姓名、金額、課程時間/場次數、核對時間、經手人）。與待核對共用「重新整理」動作（一鍵雙載）。

### 4.6 通知

- 新 LINE template `booking_payment_received`（寄會員）：
  `subject: '款項已確認 - {{coach_display_name}}'`
  `body: '✅ 已收到您的款項，{{coach_display_name}} 教練 {{start_at}} 的課程預約確認成立，期待見到您！'`
- Email：`emailService` 新增 `sendPaymentConfirmedEmail(bookingId)`（無 `customer_email` 直接 return；主旨「款項確認｜MM/DD HH:MM 教練名 教練」；內容：稱呼、教練、時間、方案、實收金額、「預約已確認成立」；沿用 notifications email channel 與重試）。
- 預約成立的既有確認信加一行「款項核對完成後會再寄送確認通知」（對齊新的兩階段狀態）；LINE 的 `booking_confirmed` 文案不動。

### 4.7 不變項（迴歸保護重點）

時段佔用/容量計算、UNIQUE 索引、Google 日曆事件生命週期、取消與折扣釋放、團課訂單確認流程（`confirmGroupOrder`）邏輯本體。

## 5. 測試計畫

- 單元：backfill 遷移（過去→paid、未來→NULL、重跑 no-op）；confirm-payment 守門（404/已取消/重複核對）；pending 清單查詢條件；`getPublicSchedule` 的 `paid` 欄位。
- API：admin pending 列表含新預約；confirm-payment 成功後 pending 消失、confirmed 列表出現、`paid_by` 正確；非 admin 401/403；LINE/Email 通知列（GMAIL_MOCK）。
- 視窗：兩年後日期有 slot；`bookingWindowDays` 參數仍可限縮。
- 排序：listCoachBookings 以 created_at DESC。
- 既有測試影響評估：`booking-anon`、`booking-validate-api`、`my-schedule-service`（回應多欄位，additive）；`flow`/`group-order` 不受影響。

## 6. 部署

- 遷移 additive＋一次性 backfill（以欄位存在為冪等訊號），照慣例部署前備份 prod DB。
- 上線後：prod 既有「未來場次」預約會出現在待核對清單（業主決策，人工核掉一輪即歸位）。
