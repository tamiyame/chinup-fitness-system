# 教練課循環預約（管理者/教練限定）設計規格

日期：2026-06-12
狀態：已與業主確認設計決策，待實作

## 1. 目標

一對一預約頁的預約彈窗，當**登入中的教練/管理者**操作時，顯示「開啟循環預約」核取框：一次建立週期性的多堂預約（每日/每週/每月/自訂間隔天數 × 共 N 次），先預覽每場可建立狀態、跳過衝突場次，可勾「款項已收」直接標記已核對。

### 已確認的設計決策

| 決策點 | 結論 |
|---|---|
| 撞期處理 | **預覽後跳過衝突場次**：先回傳逐場狀態（✓/✗＋原因），確認後只建立可用場次 |
| 付款狀態 | 建立時可勾「**款項已收（包堂/預付）**」→ 全部直接標已核對（經手人=操作者）；沒勾則逐堂進待核對 |
| 權限 | 後端 `requireCoach`（管理者也是教練，涵蓋）；前端僅對登入教練/管理者顯示 UI（純顯示層，後端強制） |
| 通知 | **摘要一則**（不逐堂轟炸）：會員 LINE 一則＋教練一則（操作者本人略過）＋管理者廣播一則；email 有填寄一封摘要信 |
| 折扣碼 | **照常可用、逐堂套用**（業主指示不隱藏）：與單堂同規則——百分比每堂折、定額每堂折定額；折扣碼次數/每人限制逐堂消耗，用罄後其餘堂數原價（結果如實回報各堂金額） |
| 上限 | 次數 2–52；自訂間隔 1–90 天 |
| 每月重複 | 以首堂「日」為準（如每月 10 號）；當月無此日（如 31 號遇 2 月）→ 該場標記跳過 |
| 單堂後續調整 | 各場為**獨立預約**，沿用既有取消流程（待核對取消鈕／已核對長按退款／教練緊急取消／顧客自助取消）；「改時段」＝取消該堂後重建 |

## 2. 資料模型

- `bookings.recurring_group_id INTEGER`（additive，`addColumnIfMissing`）：同一串循環的所有預約存「首堂 booking id」。本版不做整串操作 UI，僅落資料供未來「取消整串」等功能。
- 無其他 schema 變更（paid_at/paid_by 沿用付款狀態流）。

## 3. 後端

### 3.1 佔用判定共用

每一場 occurrence 的可建立檢查＝**與單筆公開預約完全相同的管線**：該日 `computeAvailableSlots`（班表/請假/緩衝[僅首堂可能觸發]/容量/同教練重疊/freebusy）→ `startAt` 在清單且 `remain ≥ units`。freebusy 以日期範圍**30 天分段**查詢合併（沿用 `getExternalBusySafe` 的 60s 快取，預覽與建立間可重用）。

### 3.2 occurrence 計算（`bookingService` 內部 helper）

```
occurrences(startAt, frequency, intervalDays, count):
  daily   → +1 天
  weekly  → +7 天
  monthly → 下個月同「日」；當月無此日 → 該次標記 skipped_no_date（不順延）
  custom  → +intervalDays 天
  回傳 count 個（含首堂），各 'YYYY-MM-DDTHH:MM:00'（時間沿用首堂）
```

### 3.3 API（皆 `requireCoach`）

| 端點 | 行為 |
|---|---|
| `POST /api/bookings/recurring/preview` | body `{ coachId, startAt, sessionType, frequency, intervalDays?, count }`。驗證參數（frequency ∈ daily/weekly/monthly/custom；custom 需 intervalDays 1–90；count 2–52；startAt 格式；coach 存在且啟用）。回 `{ occurrences: [{ startAt, ok, reason? }] }`，reason ∈ `no_date`（當月無此日）/`unavailable`（班表外/請假/已被預訂/容量滿/日曆封鎖，不細分） |
| `POST /api/bookings/recurring` | body 同上＋`{ name, phone, email?, markPaid }`。單一 tx 內逐場重驗（fresh）：可建立者走 `createBookingCore`（**silent 模式**，見 3.4）＋寫 `recurring_group_id`＝首筆 id；`markPaid` → 各筆 `paid_at=now, paid_by=操作者`。衝突者跳過。`discountCode` 有給則對每一筆建立的預約各自 `applyDiscountTx`（與單堂語意一致；額度用罄的堂數原價）。回 `{ created: [{id, startAt, finalAmount}], skipped: [{startAt, reason}], totalAmount, lineBindCode?, lineOfficialUrl }`（totalAmount＝各堂折後金額加總）。`created` 為空 → 409 `all_conflicted`（不建任何東西、不發通知） |

### 3.4 通知與副作用

- `createBookingCore` 加 `silent = false` 參數：silent 時跳過逐堂 notify/notifyAdmins（其餘行為不變，含 assertBookableTx/UNIQUE 兜底）。
- commit 後（fire-and-forget）：
  - 會員 LINE：新 template `booking_recurring_created`——「✅ 已為您安排 {{count}} 堂 {{coach_display_name}} 教練課（{{freq_text}}），第一堂 {{first_at}}。可至「我的課表」查看全部場次。」（`freq_text` 如「每週」「每 3 天」）
  - 教練 LINE（教練 user ≠ 操作者才發）：`booking_recurring_created_coach`——「🏋️ {{member_name}} 的 {{count}} 堂循環課程已排定（{{freq_text}}），第一堂 {{first_at}}。」
  - 管理者廣播：沿用 `booking_recurring_created_coach` 文案、`notifyAdmins`（excludeUserId=操作者）
  - Email（有填）：一封摘要信（教練、方案、全部場次日期清單、總額、款項狀態「已收款」或「待核對」、取消方式）——`emailService.sendRecurringConfirmation(groupId)`，notifications type `booking_recurring_email`、沿用 email channel 重試
  - Google 日曆：逐場 `syncBookingCreate`（每堂一個事件，事件 ID 沿用決定性規則；reconcile 兜底）
- LINE 綁定碼：同單筆匿名流程（會員未綁定時回傳一次）。

## 4. 前端（coaches.html / coaches.js）

- `coaches.js` 以 `getUser()`（app.js 既有）判斷登入者 `role==='coach' || is_admin` → 顯示彈窗資訊卡內（紅框處）的「**開啟循環預約**」核取框；未登入/一般會員完全不可見。
- 勾選後展開（折扣碼區照常顯示；套用後顯示「每堂折後估價 ×N 堂」並註明逐堂套用、依剩餘次數為準）：
  - **重複頻率**：select（每日／每週／每月／自訂間隔）＋自訂時顯示「每 N 天」數字框（1–90）
  - **次數**：「共 N 次」數字框（2–52，預設 4）
  - **款項已收（包堂/預付，直接標記已核對）**核取框
  - **預覽場次**按鈕 → 呼 preview → 列出逐場 `✓ 7/06（一）15:00`／`✗ 7/13（一）15:00 不可預約` 清單與「可建立 X／衝突 Y」摘要
- 主按鈕變「確認建立 X 堂」→ 呼 recurring endpoint → 成功視圖顯示建立/跳過清單、總額、（未綁定時）LINE 綁定碼。參數變更（頻率/次數/型態）後需重新預覽才能送出。
- 1對2 的 remain 守門沿用：preview 內建（每場 remain≥units）。

## 5. 測試計畫

- 單元：occurrence 計算（daily/weekly/monthly 含 31 號跳過/custom）；preview 狀態（班表外、撞既有預約、容量滿、教練請假）；create 跳過衝突只建可用；markPaid 全標已核對（paid_by=操作者）；silent → 無逐堂通知、摘要各一則；recurring_group_id＝首筆 id；all_conflicted 409；count/intervalDays 邊界驗證。
- API：匿名/一般會員 → 401/403；教練 token 全流程（preview→create→pending 清單筆數/已核對筆數對應 markPaid）；email 摘要信通知列。
- 既有迴歸：單筆預約管線、付款流、退款流不受 `createBookingCore` 簽名變更影響（預設值不變）。

## 6. 風險與備註

- `markPaid` 一批 N 筆會佔「已核對匯款」清單（LIMIT 50）多列——對帳本語意正確，先接受；之後若吵再做分組顯示。
- 未勾已收款 → N 張待核對卡（業主已知情選擇此模型）。
- 長週期（52 次≈一年）首堂外的場次不受 2 小時緩衝限制（僅首堂可能因緩衝被擋，屬正確行為）。
- 折扣逐堂套用：定額折扣碼會每堂都折（N 堂＝N 倍折抵）、次數有限的碼用罄後其餘堂數原價——建立結果會逐堂列出實際金額，對帳以結果為準。
