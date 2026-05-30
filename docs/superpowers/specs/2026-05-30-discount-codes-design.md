# 折扣碼（Discount Codes）設計

> 接續 anon-paid-group 改版（PR #14 已合併 `5116693`）。本功能在 `feature/discount-codes` 分支獨立開發，獨立 PR。

## 1. 動機

讓持有折扣碼的客人在報名時享有特定折扣：
- **團體課**：結帳（填寫報名資料）頁輸入折扣碼 → 即時看到折後總額 → 匯款金額為折後價。
- **1v1**：預約 modal 輸入折扣碼 → 顯示「折後現場應付」（1v1 為現場收費，需有單堂價當基準）。
- **Admin 後台**：可建立／編輯／啟停折扣碼，並設定全站 1v1 單堂價。

## 2. 設計決策（brainstorm 已逐項確認）

1. **適用範圍**：團體課 **與** 1v1 皆適用。
2. **1v1 價格基準**：全站統一單堂價，存於可由 admin 編輯的設定，**預設 1500**。
3. **折扣型態**：每碼可選 `percent`（減免百分比，例 `10` ＝ 減 10% ＝ 打 9 折）或 `fixed`（定額減免，單位 NT$）。
4. **使用限制**（皆為**選填**，全留空＝不限、輸入即可用）：有效期間（起／訖）、總使用次數上限、每人（電話）使用次數上限、最低消費金額門檻；外加 admin **啟用／停用**開關。
5. **流程**：方案 A — 公開 validate endpoint 提供即時預覽（不寫入）；**權威套用在下單／預約的 `tx()` 內**重驗 + 記錄 redemption（防併發超用）。
6. percent 語意＝**減免百分比**。
7. 訂單／預約被取消／逾時／未開課時，**釋放**其使用次數（刪對應 redemption），與既有「取消即釋放名額」一致。
8. 候補遞補產生的新訂單為**原價、不**自動沿用折扣碼。
9. 折扣碼**硬刪僅限從未使用過**者；用過的一律改「停用」以保留紀錄。

## 3. 資料模型

### 3.1 新表

```sql
CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                       -- 正規化：trim + 轉大寫
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL,                 -- percent: 1..100；fixed: >=1 (NT$)
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,                                 -- 選填，local 'YYYY-MM-DD'（含當日）
  valid_until TEXT,                                -- 選填，local 'YYYY-MM-DD'（含當日）
  max_uses INTEGER,                                -- 選填，總使用次數上限
  per_phone_limit INTEGER,                         -- 選填，每電話使用次數上限
  min_amount INTEGER,                              -- 選填，最低訂單金額（比 subtotal）
  note TEXT,                                        -- admin 備註
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discount_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES discount_codes(id),
  phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('group_order','booking')),
  ref_id INTEGER NOT NULL,                          -- group_orders.id 或 bookings.id
  amount INTEGER NOT NULL,                          -- 實際折抵金額
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_code ON discount_redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_code_phone ON discount_redemptions(code_id, phone);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seed：one_on_one_price = '1500'（INSERT OR IGNORE）
```

> **用量即時計算，不存 used_count**（避免 drift，沿用本專案「名額以 query 計算、不維護 confirmed_count」原則）：
> - 總使用次數 ＝ `SELECT COUNT(*) FROM discount_redemptions WHERE code_id=?`
> - 某電話使用次數 ＝ `... WHERE code_id=? AND phone=?`
> - 取消/逾時/未開課 → **刪除該 ref 的 redemption 列**（釋放）。

### 3.2 既有表加欄（`addColumnIfMissing`）

`group_orders` 與 `bookings` 各加：
```sql
  discount_code   TEXT,        -- 套用的碼（正規化大寫），未用則 NULL
  discount_amount INTEGER,     -- 折抵金額，未用則 NULL
  original_amount INTEGER      -- 折扣前金額（團＝場次加總；1v1＝單堂價）
```
- `group_orders.total_amount`：改存**折後**金額（無折扣時 ＝ original_amount）。
- 1v1 `bookings`：原本無金額欄，新增上述三欄。
- **建立時 `original_amount` 一律寫入**（＝折扣前 subtotal：團＝付款場次加總、1v1＝當下單堂價）；無折扣碼時 `discount_code`/`discount_amount` 為 NULL，且折後金額 ＝ original_amount。

### 3.3 時間慣例

`valid_from`/`valid_until` 以 local wall-clock 比較（`nowLocal()`）：未到 `valid_from` → `code_not_started`；超過 `valid_until` 當日 23:59:59 → `code_expired`（比較時 `valid_until` 視為「該日含整天」，即 `nowLocal()` 的日期 > valid_until 才算過期）。`created_at` 沿用既有 `datetime('now')`（UTC）慣例。

## 4. Service：`src/services/discountService.js`

```
normalizeCode(raw) -> 'TRIM+UPPERCASE'
getActiveCodeByCode(code) -> row | null

validateDiscount({ code, phone, subtotal }) -> { codeId, type, value, discountAmount, finalTotal }
  // 純驗證、不寫入。丟 ApiError：
  //   invalid_code / code_inactive / code_expired / code_not_started
  //   code_exhausted / per_phone_exhausted / below_min_amount
computeDiscount(type, value, subtotal) -> { discountAmount, finalTotal }
  // percent: discountAmount = floor(subtotal * value / 100)
  // fixed:   discountAmount = min(value, subtotal)
  // finalTotal = max(0, subtotal - discountAmount)

applyDiscountTx({ code, phone, subtotal, kind, refId }) -> { discountCode, discountAmount, finalTotal } | null
  // 在 caller 的 tx() 內呼叫：重新 validate（含 max_uses / per_phone 即時 COUNT）→
  // INSERT discount_redemptions(code_id, phone, kind, ref_id, amount) → 回折抵結果。
  // code 為空字串/undefined → 回 null（不套用）。

releaseRedemption({ kind, refId })   // DELETE FROM discount_redemptions WHERE kind=? AND ref_id=?

// admin
listDiscountCodes() -> [{...code, used_count, ...}]   // used_count 即時 COUNT
createDiscountCode({...})   // 驗 code 唯一、type/value 合法、limits 非負
updateDiscountCode(id, {...})   // 編輯 value/limits/active；code 不可改
deleteDiscountCode(id)   // 僅當該碼無 redemption 才硬刪，否則丟 has_redemptions（請改停用）

getSetting(key) / setSetting(key, value)   // app_settings
getOneOnOnePrice() -> int   // parseInt(getSetting('one_on_one_price') || '1500')
```

**權威套用點**：
- `groupOrderService.createGroupOrder`：算出 pay subtotal 後、寫 order 前（同一 tx），若帶 `discountCode` → `applyDiscountTx({kind:'group_order', refId: orderId, subtotal})`；`group_orders` 寫入 original/discount/total(折後)。min_amount 比 subtotal。
- `bookingService.createBookingAnon`：subtotal ＝ `getOneOnOnePrice()`；若帶 `discountCode` → `applyDiscountTx({kind:'booking', refId: bookingId, subtotal})`；booking 寫入三欄。
- **釋放**：`cancelGroupOrder` / `expirePendingOrders` / `cancelBookingAnon` / `courseService.processDeadlines`（未開課 reject）→ 對受影響 order/booking 呼叫 `releaseRedemption`。
- 候補遞補（`promoteWaitlist`）建立的新 order 不帶折扣碼。

## 5. 公開 Endpoints（無需 auth）

- `POST /api/public/discounts/validate` — body `{ code, phone, kind, sessionIds? }`
  - `kind='group'`：subtotal ＝ 由 `sessionIds` 的 `price_per_session` 即時加總（server 端算，不信任前端金額）。**`sessionIds` 僅含付款場次；候補場次不計入 subtotal。**
  - `kind='one_on_one'`：subtotal ＝ `getOneOnOnePrice()`。
  - 回 `{ valid:true, discount_type, discount_value, discount_amount, original:subtotal, final_total }` 或對應 4xx 錯誤碼。
- `POST /api/public/group-orders` — body 增加選填 `discountCode`。回應增加 `original_amount` / `discount_amount` / `discount_code`（`total` 為折後）。
- `POST /api/public/bookings` — body 增加選填 `discountCode`。回應增加 `original_amount` / `discount_amount` / `final_amount` / `discount_code`。
- `GET /api/public/one-on-one-price` —（或併入既有 coaches 載入）回 `{ price }` 供 1v1 modal 顯示單堂價。

## 6. Admin Endpoints（`requireAdmin`）

- `GET /api/admin/discount-codes` → 清單（含即時 used_count、per-code 限制摘要）
- `POST /api/admin/discount-codes` → 建立
- `PATCH /api/admin/discount-codes/:id` → 編輯（value/limits/active）
- `DELETE /api/admin/discount-codes/:id` → 硬刪（僅未使用過；否則 409 `has_redemptions`）
- `GET /api/admin/settings` / `PATCH /api/admin/settings` → 讀寫 `one_on_one_price`（白名單 key，值需為正整數）

## 7. 前端

### 7.1 團體課結帳（`public/group.js` / `group.html`）
- 報名資料表單加「折扣碼」輸入 + 「套用」按鈕。套用 → `POST /api/public/discounts/validate {kind:'group', code, phone, sessionIds}`：
  - 成功：顯示 `折扣 −$X`、折後總額（更新 price summary），記住已套用的碼。
  - 失敗：依錯誤碼顯示友善訊息（如「折扣碼無效／已過期／已用完／未達最低金額 $N」）。
- 送出 `POST /api/public/group-orders` 帶 `discountCode`。成功頁顯示 原價／折扣／**折後（＝匯款金額）**。
- 折扣碼留空 → 一切照舊（原價）。

### 7.2 1v1 預約（`public/coaches.js` / `coaches.html`）
- 預約 modal 顯示「單堂 $price」（取自 1v1 價）。加「折扣碼」選填 + 「套用」→ `validate {kind:'one_on_one', code, phone}` → 顯示「折後現場應付 $Y」。
- 送出 `POST /api/public/bookings` 帶 `discountCode`。成功頁顯示 原價／折扣／**折後現場應付**（提示為現場收費）。

### 7.3 共用
- 電話用 modal/表單裡已輸入的電話（per_phone 限制需要電話；validate 與下單帶同一電話）。
- 折扣金額一律 server 端權威計算，前端只顯示。

## 8. Admin 後台（`public/admin.js` / `admin.html`）

新增「折扣碼管理」區（沿用既有 card/badge/`api()`/`toast`/`escapeHtml` 樣式）：
- **清單**：碼、型態+值（顯示「減 10%」或「減 $100」）、限制摘要（有效期 / 用量 used/max / 每人上限 / 最低額）、啟用狀態 badge、`啟用/停用` 切換、`編輯`、`刪除`（未使用過才可）。
- **建立/編輯表單**：code（建立時必填，編輯時唯讀）、型態 select（百分比/定額）、值、選填 valid_from/valid_until/max_uses/per_phone_limit/min_amount、note。
- **1v1 單堂價**設定欄（讀寫 `one_on_one_price`）。

## 9. 遷移

- `schema.js`：加 3 個 `CREATE TABLE IF NOT EXISTS` + 索引 + `app_settings` seed（`INSERT OR IGNORE one_on_one_price=1500`）；`group_orders`/`bookings` fresh-create 也含新欄。
- `connection.js` migration block：`addColumnIfMissing('group_orders', ...)`、`addColumnIfMissing('bookings', ...)`（discount_code/discount_amount/original_amount）；3 表與 seed 由 `db.exec(SCHEMA)` 的 IF NOT EXISTS 補上。idempotent、可重跑。
- 無破壞性 rebuild。

## 10. 測試

**Service（`tests/discount-service.test.js`）**：normalizeCode；computeDiscount percent/fixed（含 floor、不為負）；validate 各錯誤碼（invalid/inactive/expired/not_started/below_min）；max_uses + per_phone 即時 COUNT（含同 tx 內遞增後再驗）；releaseRedemption 後用量回退；group apply（subtotal=場次加總、min_amount）；1v1 apply（subtotal=1500）。
**Group/Booking 整合**：`createGroupOrder`/`createBookingAnon` 帶碼 → 訂單/預約存折後 + redemption；取消/逾時 → redemption 釋放；遞補新單不帶碼。
**API（`tests/discount-api.test.js`）**：validate endpoint（group/1v1、各錯誤）；帶碼下單；admin CRUD（建立/編輯/啟停/刪除限制）；settings 讀寫；`requireAdmin` 403。

## 11. 手動 smoke checklist（merge 前 gate）

- [ ] admin 建立 percent 碼（如減 10%）→ 團體課結帳套用 → 折後總額正確、匯款金額＝折後
- [ ] admin 建立 fixed 碼（減 $200）→ 1v1 預約套用 → 折後現場應付正確
- [ ] 過期 / 未啟用 / 未達最低金額 / 無效碼 → 對應錯誤訊息
- [ ] max_uses 用完 → `code_exhausted`；per_phone 用完 → `per_phone_exhausted`
- [ ] 套用後取消訂單 → 該碼使用次數回退（可再用）
- [ ] 候補遞補的新訂單為原價、無折扣
- [ ] admin 改 1v1 單堂價 → 1v1 modal 顯示新價
- [ ] 用過的碼無法硬刪（提示改停用）；停用後結帳不能再用
- [ ] 無折扣碼時，團體/1v1 流程與金額完全照舊（regression）

## 12. 風險與 mitigation

| 風險 | mitigation |
|-----|-----------|
| 併發搶用最後一次 max_uses | 套用在 `tx()` 內重新 COUNT + INSERT redemption（與名額重算同模式） |
| 前端竄改金額 | subtotal 一律 server 端由 sessionIds / 1v1 價重算 |
| 取消後使用次數未釋放 | 在所有取消/逾時/未開課路徑呼叫 `releaseRedemption` |
| 折扣使團體總額為 0 | 允許（折後可為 0，仍走 pending→admin 核對流程） |
| created_at UTC vs 操作時間 local | 沿用既有慣例；折扣有效期比較用 local（valid_from/until），功能正確 |

## 13. 不在這次範圍（YAGNI）

- 折扣碼套用於候補遞補後的訂單（明確排除）。
- 每碼限定特定課程/教練、首購限定、組合折扣、自動套用最佳碼。
- 折扣碼批次匯入/匯出、使用報表分析（admin 清單顯示即時用量已足夠）。
- 將既有 `BANK_INFO` 從 env 遷入 `app_settings`（保留 env；`app_settings` 本次只用於 1v1 價）。
