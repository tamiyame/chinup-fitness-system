# 團課報名頁灰色歷史場次 ＋ 後台範本彈窗補報名/取消（含部分退款）設計

日期：2026-07-12
狀態：已與業主逐節確認定案

## 背景與目標

1. **功能 A**：公開團課報名頁（group.html）目前用 SQL 過濾掉不可報名的場次（`status='open' AND is_open=1 AND start_at > now`，`groupOrderService.js getPublicGroupCourses`）。業主希望完整週期可見：不可報名的場次仍列出，但灰色、不可點選。
2. **功能 B**：後台課程範本 drawer（admin.js `openDrawer`）的場次名單目前純唯讀。業主要能**補報名**客人與**取消**客人單筆報名，並連動「待核對匯款／已核對匯款」區塊的訂單紀錄。

## 已定案的需求決策

| 決策點 | 定案 |
|---|---|
| 灰色列範圍 | 過去場次全列（含流課標「未開課」）＋已截止未開始的未來場次（成班/流課判定後）；**暫停中（is_open=0、未來、open）維持隱藏** |
| 補報名付款狀態 | 兩種可選：「已收款」勾選 → 直接建已核對訂單；未勾 → 建待核對訂單走既有 72h 流程 |
| 滿額補報 | 未來場次滿額 → 進候補（不收款）；過去場次滿額 → 拒絕 |
| 已收款訂單取消單場 | **記錄部分退款**：寫入退款明細表，預設金額＝該場 `amount_due`，確認框可修改 |
| 通知 | **只通知教練**（名單異動/取消）；客人一律不通知 |
| 整體做法 | 方案甲：訂單完全對稱＋`group_order_refunds` 退款明細表 |

## 功能 A：公開頁灰色場次

### API（`getPublicGroupCourses`，`src/services/groupOrderService.js`）

- 場次查詢改為取完整週期，唯一隱藏條件：未來、`status='open'`、`is_open=0`（暫停中）。
  SQL 述詞：`WHERE template_id = ? AND NOT (start_at > ? AND status = 'open' AND is_open = 0) ORDER BY start_at ASC`（`?` = `nowLocal()`）。
- 每場附伺服器計算欄位：
  - `selectable`＝`status='open' AND is_open=1 AND start_at > now AND (registration_deadline IS NULL OR registration_deadline > now)`。
    比現行多納入截止時間判定，補掉 `processDeadlines` 整點批次前最多 59 分鐘的空窗（截止已過但 status 尚未翻面）。
  - `state`：`selectable` | `ended`（已開始/已結束）| `not_held`（status='cancelled'，流課）| `deadline_passed`（未開始但已截止：status='confirmed'，或 open 但 deadline 已過）。
    判定順序：cancelled → not_held；start_at ≤ now → ended；其餘不可選 → deadline_passed。
- `occupied` / `waitlist_count` / `is_full` 照現行計算，灰色列也帶（供顯示紀錄）。
- **範本顯示門檻**：改以「至少 1 個 `selectable` 場次」過濾（取代現行 `sessions.length > 0`）。整週期已結束的課程不出現在報名頁。

### 前端（public/group.js、public/style.css）

- `renderSessionRow` 加第三分支（`state !== 'selectable'`）：
  - 無 checkbox、整列灰階降透明、點擊不觸發 toggle（`toggleSession` 與列 click handler 跳過停用列）。
  - 右側灰色徽章：`ended`→已結束、`not_held`→未開課、`deadline_passed`→已截止。
  - `ended` / `deadline_passed` 保留「已佔 X / 上限 Y」文字（不畫容量條）；`not_held` 只顯徽章。
  - 樣式走既有 token（hairline、灰狀態點、既有 badge 家族），不引入新色，遵循 DESIGN.md。
- 排序時間升冪，過去在最上（與後台 drawer 一致）。
- 卡片「N 場」徽章＝列出的總場次數（含灰色），與眼前列表對得上；「全選整週期（N 個開放場次）」與全選邏輯維持只計 `selectable` 且未滿的場次。

### 防呆

送單側不變：`validateSelectable` 續擋 `session_cancelled` / `session_completed` / `session_closed` / `registration_closed` 與滿額重驗，灰色列即使被改 DOM 也無法成單。

## 功能 B：後台補報名/取消

### 入口 UI（public/admin.js 範本 drawer、public/admin.html）

- 每場次 summary 列加「補報名」按鈕（比照既有 `session-toggle` badge 按鈕樣式）。`status='cancelled'`（未開課）場次不提供；open／已成班／過去場次皆可。
- 點開展開場次下方小面板：
  - 客人即時搜尋（重用 `GET /api/coach/customers/search`；管理者 role=coach 可通過 requireCoach）＋「新增客人」就地建立（姓名必填、電話選填，重用既有教練新增客人端點/規則）。
  - 「已收款」勾選框。
  - 滿額提示：未來場次滿 → 顯示「已滿，將列為候補」且「已收款」勾選停用（候補不收款）；過去場次滿 → 前端擋並顯示已滿。
- roster 名單列（`pending`/`confirmed`/`waitlisted`）加「取消」小按鈕＋確認框；`cancelled`/`rejected` 列不顯示按鈕。已收款情境的確認框含退款金額輸入（預填 `amount_due`）。
- 操作成功後原地刷新該場次 roster 與人數統計。

### 端點 1：補報名 `POST /api/admin/sessions/:id/registrations`（requireAdmin）

Body：`{ userId }` 或 `{ name, phone? }`，加 `paid: boolean`。單一交易：

1. 場次存在且 `status !== 'cancelled'`；客人解析（既有 `findOrCreateUserByPhone`（role 守門）/`createCustomerNoPhone`/依 userId 取用）。
2. 重複檢查：該客人於此場已有 `pending`/`confirmed`/`waitlisted` → 409 `already_registered`；有 `cancelled`/`rejected` 舊列 → 走既有 `reactivateReg` 復原（`UNIQUE(session_id, user_id)`）。
3. 金額＝範本 `price_per_session`；**不支援折扣碼**。
4. 分流：
   - `paid=true`：建 `group_orders`（`status='paid'`、`paid_at=now`、`paid_by=操作者`、`total_amount=original_amount=price`）＋報名 `confirmed`。每次獨立成單（已付款單不事後長大）。
   - `paid=false`：找該客人未逾期 pending 訂單 → 併入（`total_amount`/`original_amount` 累加、`expires_at = max(原值, now+72h)`，比照遞補併單）；否則建新 pending 單（72h）＋報名 `pending`。
   - 未來場次滿額：報名 `waitlisted`、不建訂單（與公開流程一致；之後由既有遞補機制開單）。`paid=true` 且滿額 → 400（UI 已擋，後端防呆）。
   - 過去場次（`start_at <= now`）滿額 → 409。
5. 通知：`notifyCourseCoach` 一則名單異動（優先重用既有 course 系列模板，不合用則於 `TEMPLATES` 加新 type）。客人不通知。
6. 回傳更新後 roster。

### 端點 2：取消報名 `POST /api/admin/registrations/:id/cancel`（requireAdmin）

Body 可帶 `refundAmount`。單一交易，依報名/訂單狀態分流：

- **waitlisted**：標 `cancelled`，無金流。
- **pending（掛 pending 訂單）**：標 `cancelled` → 重算訂單：新 `original_amount`＝剩餘 pending 場次 `amount_due` 加總；折扣以同一代碼對新小計**重新報價**（quote，不動用量計數）得新 `total_amount`；折扣碼已失效或不再滿足條件則折扣歸零、應付＝新原價。**剩餘 pending 場次為 0 → 整單取消**（`status='cancelled'`、`cancelled_at`、釋放折扣用量；掛單候補列維持候補）。
- **confirmed＋訂單 paid**：標 `cancelled` → 寫入 `group_order_refunds`（order_id、registration_id、`amount = refundAmount ?? amount_due`、`refunded_at=now`、`refunded_by=操作者`）。訂單維持 `paid`；金額欄位不改。`refundAmount` 驗證：0 ≤ 整數 ≤ `amount_due`。
- **confirmed＋`order_id IS NULL`（舊資料）**：只標 `cancelled`。
- **cancelled / rejected**：409。
- 名額釋出後呼叫既有 `promoteWaitlist`。
- 通知：只發教練（重用既有取消通知模板）。

### `promoteWaitlist` 過去場次守門（附帶修復）

`promoteWaitlist(sessionId)` 開頭加守門：場次 `start_at <= now` 直接 return。同時修掉現存潛在 bug——整單退款／逾期釋出時會把候補遞補進已上完的場次並開 24h 付款單。此守門保護所有呼叫路徑（本功能取消、整單退款、逾期清理、公開取消）。

### 資料模型（migration，只增不改）

新表 `group_order_refunds`：

```sql
CREATE TABLE IF NOT EXISTS group_order_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES group_orders(id),
  registration_id INTEGER REFERENCES registrations(id),
  amount INTEGER NOT NULL,
  refunded_at TEXT NOT NULL,
  refunded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

走 `src/db/schema.js` 既有 boot-migration 模式；additive，prod（Railway volume）安全，無需備份以外的特別處理。

### 待核對／已核對區塊連動

- **待核對卡片**：現有查詢只抓 `pending`/`waitlisted` 報名 → 取消後該場自動從明細消失；金額欄顯示重算後 `total_amount`（交易內已寫回）。
- **已核對卡片**：`listConfirmedPayments` LEFT JOIN 退款明細加總，卡片金額顯示「NT$總額 · 已退 NT$Y」（無退款則不顯示已退段）。既有整單長按退款（`refunded_at`）行為不變，與部分退款並存；整單退款後卡片照現行顯示已退款徽章。

## 錯誤處理

- 新端點皆 `requireAdmin`；錯誤沿用 `ApiError` 慣例（400 參數不合法、404 場次/報名不存在、409 重複報名/已滿/狀態不可取消）。
- 所有寫入走單一 `tx()`；通知在交易外送出（沿用既有 pattern），失敗進重試佇列不影響資料。
- 時間比較沿用 `nowLocal()` 字典序慣例。

## 測試

- **unit**（納入 `npm test`，比照 `tests/group-order-service.test.js` 風格）：
  - A：完整週期查詢（過去/已截止列出含 state、暫停隱藏、範本門檻改 selectable、selectable 含 deadline 空窗）。
  - B 補報名：paid 獨立成單、pending 新單/併單（金額、期限 max）、滿額候補、過去滿額 409、重複 409、cancelled 列復原、無電話客人。
  - B 取消：pending 重算金額＋折扣重新報價、末場整單取消＋折扣釋放、paid 寫退款明細（預設/自訂金額、上限驗證）、waitlisted/舊資料取消、409 情境。
  - `promoteWaitlist` 過去場次守門（含整單退款路徑不遞補過去場次）。
- **API**（`npm run test:api`）：新端點非管理者 403；補報名→roster 反映；取消→待核對金額變化。
- 測試後重新 seed（`data/app.db` 會被清）。

## 交付

兩張 feature branch＋draft PR，各自手動 smoke 後 squash 合併（合併前先 push）：

1. **PR-A**：公開頁灰色場次（功能 A，小）。
2. **PR-B**：後台補報名/取消＋`group_order_refunds`＋區塊連動＋`promoteWaitlist` 守門（功能 B，大）。

兩者互不依賴，可獨立驗收上線。
