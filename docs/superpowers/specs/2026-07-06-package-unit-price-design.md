# 方案單價模式＋消耗統計 — 設計規格

- 日期：2026-07-06
- 狀態：業主核可方向（P1＋P2 一起、修正單價回寫全部已登錄堂採建議值，smoke 時可再調整）

## 背景

教練開方案輸入「總金額」易打錯 → 單價錯 → 現行只能作廢重開（會連動取消預約）。業主應用情境：各客各單價、教練按「實際上課堂數 × 該客單價」抽成；管理者要看消耗；客人要看剩餘/請假/上課統計。

## P1a 單價輸入模式（兩處開方案表單，純前端換算）

- **登錄彈窗**（coach.js `regmNewPkgFormHtml`）與**後台會員編輯彈窗**（admin.js 方案區塊）的金額欄改為「**每堂單價（可空）**」。
- 表單下方即時換算列：`N 堂 × NT$單價 ＝ 總額 NT$X`（任一欄變動即更新；單價空白顯示「未填單價 → 無單價方案」）。選了折扣碼時加註「套用折扣碼後以折後總額入帳」。
- 送後端 `POST /api/coach/packages` 的 `amount` ＝ `單價 × 堂數`（單價空 → null，維持無單價路徑）。**後端/DB 零改動**；折扣碼照舊由後端套在總額上。
- 驗證：單價需為 ≥0 整數（前端擋，後端 invalid_amount 兜底）。

## P1b 修正單價（解「打錯很難改」）

- **新端點** `PATCH /api/coach/packages/:id/unit-price`（**requireAdmin**，比照 archive 收緊；body `{ unitPrice }` 整數 ≥0）。
- **service `updateUnitPrice({ packageId, unitPrice })`**（packageService，tx 內）：
  1. 方案不存在 → 404 `package_not_found`；unitPrice 非 ≥0 整數 → 400 `invalid_unit_price`。
  2. `customer_packages.amount = unitPrice × total_sessions`；`discount_code = NULL`（金額已改為明確指定，清除折扣註記避免誤導）。
  3. **回寫全部已登錄堂**（業主採建議值）：`UPDATE bookings SET original_amount = unitPrice WHERE package_id = ? AND status = 'confirmed'`（含已上完；方案登錄堂 `discount_amount` 本為 NULL，實收即單價）。
  4. 回 `{ ok, amount, unitPrice, rewrittenBookings }`。
- **已知取捨**（規格明載）：修正後重開舊期別薪資頁，數字會依新單價重算——這正是修正目的；已發放紀錄以留存 CSV 為準。
- **前端**（admin.js 方案列）：「調整」旁加「**改單價**」按鈕（非作廢方案才顯示）→ `prompt` 輸入新單價（預填目前單價 `round(amount/total)`，無金額顯示空）→ PATCH → toast「已修正單價並回寫 N 堂」→ 重載清單。

## P2a 管理端：方案消耗分解

- `listPackagesForMember`（packageService）加聚合欄位：`completed_sessions`（該方案 confirmed 且 start_at < now）、`upcoming_sessions`（confirmed 且 ≥ now）——與我的課表口徑一致；額外欄位為附加，不影響既有消費者。
- 會員編輯彈窗方案列顯示改為：
  第一行 `一對一 已上完 C・已約 U・未登錄 R／共 T 堂 ＋狀態badge`；
  第二行 `到期…・單價 NT$u（總額 NT$amount）`（無金額顯「無單價」）。

## P2b 客人端：我的課表統計列

- `/api/public/my` 回應加 `stats`（groupOrderService 我的課表組裝函式內，由既有查詢結果直接統計，零額外查詢）：
  - `one_done`：個別課已上（confirmed 且過去）
  - `group_done`：團課已上（confirmed、過去、非請假、場次未取消）
  - `leave_count`：請假次數（on_leave=1，全期間）
  - `one_upcoming`／`group_upcoming`：沿用既有 `one_on_one_remaining`／`group_remaining` 值
- my-schedule.js 於方案卡區塊上方渲染一條統計列（沿用現有 Nike 小標風格）：
  `已上課 X（個別 A・團課 B）・請假 C 次・即將到來 W 堂`（W = one+group upcoming）。查詢者無任何紀錄時整列隱藏。

## 範圍外（YAGNI，已向業主說明）

- 獨立「方案管理」大頁籤（操作入口已覆蓋）；出席打卡/no-show 口徑（現行「時間到＝上完」與薪資/提醒一致）；管理端「快用完名單」（提醒已自動化，之後有需要再加）。

## 測試

1. **service**（`tests/package-unit-price.test.js`，npm test 鏈）：updateUnitPrice 改 amount/清 discount_code/回寫堂數（過去＋未來都改、cancelled 不改）/404/400；listPackagesForMember 的 completed/upcoming 欄位正確（含 0 堂、archived）；listMySchedule 的 stats 各值（含請假、pending 不計 group_done、取消場次不計）。
2. **API**（`tests/package-unit-price-api.test.js`，test:api 鏈、獨立假 IP）：unit-price 端點 401／缺參數 400／成功 200 形狀；薪資頁整合抽查（修正單價後 `GET /api/admin/payroll` 該堂實收變新單價）。
3. **前端**：Playwright——兩表單換算列即時更新、送出後方案單價正確；改單價流程；會員列消耗分解；我的課表統計列數字。
