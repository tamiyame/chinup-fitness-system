# 折扣碼新型態「固定金額（每堂）」 — 設計規格

- 日期：2026-09-10
- 狀態：業主已核可設計

## 背景

折扣碼目前兩種型態：`percent`（百分比折扣）、`fixed`（定額折扣＝扣除固定金額）。業主要第三種：**課堂金額直接變成另一個固定金額**，不是扣除。業主拍板單位＝**每一堂固定 X 元**（一對一一堂 → X；團課一次報 N 堂 → X×N；方案 N 堂 → X×N），不是整筆訂單固定。

所有折扣算法走 `src/services/discountService.js` 的 `computeDiscount()` 一個點；套用處：公開頁驗證折扣碼、團課下單、一對一預約、方案開立、團課單堂取消後重算。教練後台「登錄預約」只走方案不走折扣碼（方案開立時才套）。

## 目標

- 新型態 `fixed_price`，後台可建立／編輯，五個套用點都正確算成 X × 堂數。
- 既有 `percent`／`fixed` 行為與數字**一字不改**。
- 既有 prod DB 無痛升級（CHECK 約束整表 rebuild，id 不變、redemptions FK 不受影響）。

## 變更點

### 1. 型態與算法（`src/services/discountService.js`）

- 型態常數：`'fixed_price'`（後台顯示「固定金額（每堂）」）；`discount_value` 沿用同一欄位＝每堂固定價，整數 ≥ 1（與其他型態同一驗證；`percent` 另限 ≤ 100）。
- `computeDiscount(type, value, subtotal, qty = 1)`：

  ```js
  export function computeDiscount(type, value, subtotal, qty = 1) {
    const n = Number.isInteger(qty) && qty > 0 ? qty : 1;   // 非法 qty 一律當 1
    let discountAmount;
    if (type === 'percent') discountAmount = Math.floor((subtotal * value) / 100);
    else if (type === 'fixed_price') discountAmount = subtotal - value * n;
    else discountAmount = Math.min(value, subtotal);
    if (discountAmount < 0) discountAmount = 0;
    return { discountAmount, finalTotal: Math.max(0, subtotal - discountAmount) };
  }
  ```

  - **不會變貴**：`X × 堂數 ≥ 原價` → `discountAmount = 0`、金額維持原價（仍算一次使用，與 percent 算出 0 的既有行為一致）。
  - `percent`／`fixed` 忽略 `qty`。
- `validateDiscount({ code, phone, subtotal, qty = 1 })`、`applyDiscountTx({ code, phone, subtotal, kind, refId, qty = 1 })`、`quoteDiscount({ code, amount, qty = 1 })`：多一個可選參數原樣傳給 `computeDiscount`，其餘（效期、用量、min_amount 以 `subtotal` 判定、remainingUses）不動。
- `validateCodeFields`：允許 `'fixed_price'`；值的規則同上。
- `listActiveDiscountCodes`／`listDiscountCodes` 不改（本來就回 `discount_type`）。

### 2. 五個套用點各補 `qty`

| 檔案 | 位置 | qty |
|---|---|---|
| `src/server.js` `POST /api/public/discounts/validate` | `kind==='one_on_one'` | `1` |
| 同上 | `group` 分支 | **找得到範本的場次數**（與加總同一迴圈：`if (tpl) { sum += price; qty++; }`），找不到的 id 不計 |
| `src/services/groupOrderService.js` `createGroupOrder` | `applyDiscountTx({ …, subtotal: total, qty: paySessionIds.length })` | 付款場次數 |
| 同上 單堂取消 requote | `quoteDiscount({ code: order.discount_code, amount: remaining.subtotal, qty: remaining.c })` | 剩餘 pending 場次數 |
| `src/services/bookingService.js` `createBookingAnon` | `applyDiscountTx({ …, qty: 1 })` | 1（公開循環模式是逐筆 POST，各自 1） |
| `src/services/packageService.js` `createPackage` | `quoteDiscount({ code: discountCode, amount: amt, qty: total })` | 方案總堂數 |

### 3. 資料庫

- `src/db/schema.js`：`discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed','fixed_price'))`（全新 DB 直接帶新 CHECK）。
- `src/db/connection.js`：既有 DB 的 CHECK 改不了 → 整表 rebuild，比照 registrations 先例。偵測訊號：`SELECT sql FROM sqlite_master WHERE type='table' AND name='discount_codes'` 的字串**不含** `'fixed_price'` 才跑：

  ```js
  const dcSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discount_codes'").get()?.sql || '';
  if (dcSql && !dcSql.includes("'fixed_price'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE discount_codes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed','fixed_price')),
        discount_value INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        valid_from TEXT, valid_until TEXT, max_uses INTEGER, per_phone_limit INTEGER, min_amount INTEGER, note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`INSERT INTO discount_codes_new (id, code, discount_type, discount_value, active, valid_from, valid_until, max_uses, per_phone_limit, min_amount, note, created_at)
               SELECT id, code, discount_type, discount_value, active, valid_from, valid_until, max_uses, per_phone_limit, min_amount, note, created_at FROM discount_codes`);
      db.exec('DROP TABLE discount_codes');
      db.exec('ALTER TABLE discount_codes_new RENAME TO discount_codes');
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
    console.log('[migrate] discount_codes rebuilt (fixed_price type)');
  }
  ```

  放在既有 discount 遷移區塊之後、任何 service `db.prepare` 之前（connection.js 遷移段落內）。`discount_redemptions.code_id` 的 FK 指向 `discount_codes(id)`，id 原樣複製、FK 關閉期間 rebuild，不受影響。重跑 no-op。

### 4. 後台（`public/admin.html`、`public/admin.js`）

- `#dc-type` 多一個 `<option value="fixed_price">固定金額（每堂）</option>`。
- 折扣值標籤旁的提示 span 加 `id="dc-value-hint"`，依型態切換：`percent` →「（%，1–100）」、`fixed` →「（$，扣除金額）」、`fixed_price` →「（$，每堂固定價）」；`#dc-value` placeholder 同步 `10`／`100`／`1200`。`#dc-type` `change` 事件與 `openEdit` 設值後都呼叫同一個 `syncDcValueHint()`。
- 新增 helper `discountTypeText(c)`：`percent` →「減 N%」、`fixed` →「減 $N」、`fixed_price` →「每堂 $N」；列表徽章用它，徽章色：`percent` `badge-confirmed`、`fixed` `badge-waitlisted`、`fixed_price` `badge-pending`。
- 下拉標籤（`discountOptionsHtml`）：`percent` →「N% 折扣」、`fixed` →「折抵 $N」、`fixed_price` →「每堂 $N」。`public/coach.js` 的同名函式同樣改（兩檔各自持有，維持現狀不抽共用）。
- 表單錯誤文案 `invalid_value` →「折扣值無效（百分比需 1–100，定額／固定金額需大於 0）」。

### 5. 公開頁（`public/group.js`、`public/coaches.js`）

- `group.js` 套用成功：`appliedDiscount.code` 標籤 `percent` →「CODE（減N%）」、`fixed_price` →「CODE（每堂 NT$X）」、其餘「CODE」；訊息 `fixed_price` →「折扣套用成功：每堂 NT$X，應付 NT$Y」，其餘不變。
- `coaches.js`：`modalAppliedDiscount` 多存 `type`／`value`（來自回應的 `discount_type`／`discount_value`）；`refreshModalPrice` 單筆模式訊息 `fixed_price` →「折扣套用成功：每堂 $X，折後現場應付 $Y」，其餘不變；循環模式預估邏輯不動（逐堂 discount_amount 已正確）。
- 成功頁、我的課表、教練後台「已折 $N」維持顯示折扣額，不改。

### 6. API 契約

- `POST /api/public/discounts/validate` 回應不加欄位（`discount_type` 已回傳）。
- `POST/PATCH /api/admin/discount-codes` 接受 `discount_type: 'fixed_price'`；其餘錯誤碼不變。

## 邊角（明訂）

- `fixed_price` 的 `min_amount` 仍以原價 `subtotal` 判定（與其他型態一致）。
- 團課同單各場單價不同：一律 X × N，不逐場比較。
- `qty` 非正整數（undefined／0／負／小數）一律當 1；`percent`／`fixed` 不受 `qty` 影響。
- 已 redemption 的舊碼型態改成 `fixed_price`（PATCH）：既有訂單金額不回溯重算（與改 value 的既有行為一致）。
- 全新 DB（測試）由 schema.js 直接帶新 CHECK，rebuild 分支不跑。

## 測試

- `tests/discount-service.test.js` 追加：`computeDiscount('fixed_price', 1200, 1500)` → `{300, 1200}`；`('fixed_price', 1200, 3000, 2)` → `{600, 2400}`；`('fixed_price', 2000, 1500)` → `{0, 1500}`；`('fixed_price', 1200, 3000, 0)` 與 `(…, undefined)` → 同 qty 1；`computeDiscount('percent', 10, 1050, 5)` 仍 `{105, 945}`；建 `fixed_price` 碼後 `validateDiscount({…, subtotal: 4500, qty: 3})` → `discountAmount 900`、`finalTotal 3600`；`createDiscountCode({ discount_type: 'fixed_price', discount_value: 0 })` → `invalid_value`；`discount_type: 'bogus'` → `invalid_type`。
- `tests/discount-group.test.js` 追加：兩場付款場次（單價可不同）套 `fixed_price` X → `original_amount` = 加總、`total_amount` = 2X；再取消其中一場（pending）→ 重算 `total_amount` = X。
- `tests/package-discount.test.js` 追加：10 堂、金額 15000、`fixed_price` 1200 → `amount` 12000。
- `tests/discount-migration.test.js` 追加：舊 schema 多建 `discount_codes`（舊 CHECK 只含 percent/fixed）＋一筆 `fixed` 碼＋一筆 `discount_redemptions` 指向它；升級後 `sqlite_master.sql` 含 `'fixed_price'`、舊碼 id/值不變、redemption 仍指向同 id（`PRAGMA foreign_key_check` 無結果）、可 INSERT `fixed_price` 列；`discount_codes_new` 不存在。
- `tests/discount-admin-api.test.js` 追加：POST `fixed_price` 1200 → 201 且 `discount_type === 'fixed_price'`；PATCH 改回 `percent` 20 → 200；POST `fixed_price` 0 → 400 `invalid_value`。
- `tests/discount-api.test.js` 追加：group 兩場 + `fixed_price` 碼 → `discount_type 'fixed_price'`、`final_total` = 2X；one_on_one → `final_total` = X（X 小於單堂價）；X 大於單堂價 → `discount_amount 0`。
- 完整 unit 鏈 `DB_PATH="$(mktemp -d)/t.db" npm test` 全綠；API 鏈跑完 `npm run seed`。

## 範圍外（YAGNI）

- 整筆訂單固定價（業主選每堂）。
- 允許折扣碼加價。
- 舊訂單回溯重算。
- 後台折扣碼列表依型態篩選。
