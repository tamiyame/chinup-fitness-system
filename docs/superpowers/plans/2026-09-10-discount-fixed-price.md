# 折扣碼「固定金額（每堂）」型態 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增折扣碼型態 `fixed_price`（每堂固定 X 元），五個套用點都算成 X × 堂數，既有 `percent`／`fixed` 一字不改，舊 DB 無痛升級，後台與公開頁能建立／顯示。

**Architecture:** 所有折扣算法只在 `discountService.computeDiscount()` 一個點，加第四個參數 `qty`（堂數，預設 1）並由 `validateDiscount`／`applyDiscountTx`／`quoteDiscount` 原樣傳入；五個呼叫端各補 `qty`。DB 的 CHECK 約束加值，既有 DB 以整表 rebuild 遷移（比照 registrations 先例）。前端只改型態下拉、標籤文字與套用成功訊息。

**Tech Stack:** Node ESM + node:sqlite、Express、vanilla JS 前端、plain-node assert 測試（`expect(label, fn)` 慣例）。

**Spec:** `docs/superpowers/specs/2026-09-10-discount-fixed-price-design.md`

## Global Constraints

- 型態常數 `'fixed_price'`；`discount_value` = 每堂固定價，整數 ≥ 1（`percent` 另限 ≤ 100）；後台顯示「固定金額（每堂）」。
- `computeDiscount(type, value, subtotal, qty = 1)`：`fixed_price` → `discountAmount = subtotal − value × n`（`n` = 合法正整數 qty，否則 1），下限 0（**不會變貴**）；`percent`／`fixed` 忽略 `qty`、結果與現在完全相同。
- `validateDiscount({ code, phone, subtotal, qty = 1 })`、`applyDiscountTx({ code, phone, subtotal, kind, refId, qty = 1 })`、`quoteDiscount({ code, amount, qty = 1 })` 只多一個可選參數，其餘（效期、用量、`min_amount` 以 `subtotal` 判定、`remainingUses`）不動。
- 五個套用點的 qty：公開驗證 one_on_one=1／group=找得到範本的場次數；團課下單=`paySessionIds.length`；單堂取消重算=`remaining.c`；一對一預約=1；方案=總堂數 `total`。
- `schema.js` CHECK：`IN ('percent','fixed','fixed_price')`；`connection.js` 舊 DB 偵測 `sqlite_master.sql` 不含 `'fixed_price'` 才 rebuild，FK 關閉、id 原樣複製、`discount_codes_new` 改名、重跑 no-op。
- 文案：列表徽章 `percent`「減 N%」／`fixed`「減 $N」／`fixed_price`「每堂 $N」（徽章色 confirmed／waitlisted／pending）；下拉「N% 折扣」／「折抵 $N」／「每堂 $N」；折扣值提示「（%，1–100）」／「（$，扣除金額）」／「（$，每堂固定價）」、placeholder `10`／`100`／`1200`；錯誤 `invalid_value` →「折扣值無效（百分比需 1–100，定額／固定金額需大於 0）」；公開團課頁 `fixed_price` 成功訊息「折扣套用成功：每堂 NT$X，應付 NT$Y」、標籤「CODE（每堂 NT$X）」；一對一彈窗「折扣套用成功：每堂 $X，折後現場應付 $Y」。
- 單元測試一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴，**絕不對 `data/app.db` 跑**；API 測試需 running server（實作者自起 port），跑完 `npm run seed`。
- 全程繁體中文註解與文案；commit 訊息繁體中文，結尾附兩行 trailer：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 與 `Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE`。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/services/discountService.js`（改） | `computeDiscount` 加 `qty`；三個包裝函式傳遞 `qty`；`validateCodeFields` 允許新型態 |
| `src/db/schema.js`（改） | 全新 DB 的 CHECK 含 `fixed_price` |
| `src/db/connection.js`（改） | 舊 DB 整表 rebuild 遷移 |
| `src/server.js`（改） | 公開驗證端點 group 分支算 qty |
| `src/services/groupOrderService.js`（改） | 下單與單堂取消重算補 qty |
| `src/services/bookingService.js`（改） | 一對一預約 qty 1 |
| `src/services/packageService.js`（改） | 方案 qty = 總堂數 |
| `public/admin.html`／`public/admin.js`（改） | 型態下拉、提示切換、徽章、下拉標籤、錯誤文案 |
| `public/coach.js`（改） | 下拉標籤 |
| `public/group.js`／`public/coaches.js`（改） | 套用成功文案 |
| `tests/discount-service.test.js`（改） | 算法與 CRUD 案例 |
| `tests/discount-migration.test.js`（改） | 舊 CHECK DB 升級 |
| `tests/discount-group.test.js`、`tests/package-discount.test.js`、`tests/discount-booking.test.js`（改） | 套用點案例 |
| `tests/discount-api.test.js`、`tests/discount-admin-api.test.js`（改） | 端點案例 |

---

### Task 1: 算法核心與型態驗證（`discountService.js`＋`schema.js`）

**Files:**
- Modify: `src/services/discountService.js:12-16`（`computeDiscount`）、`:21`（`validateDiscount` 簽名）、`:36`（呼叫 computeDiscount）、`:51-55`（`applyDiscountTx`）、`:76-87`（`quoteDiscount`）、`:94-97`（`validateCodeFields`）
- Modify: `src/db/schema.js:274`
- Test: `tests/discount-service.test.js`（檔尾 `reset();` 之前追加 D6 段）

**Interfaces:**
- Consumes: 既有 `getCodeStmt`、`ApiError`。
- Produces（Task 3／4 依賴）：`computeDiscount(type, value, subtotal, qty = 1)`；`validateDiscount({ code, phone, subtotal, qty = 1 })`；`applyDiscountTx({ code, phone, subtotal, kind, refId, qty = 1 })`；`quoteDiscount({ code, amount, qty = 1 })`；型態 `'fixed_price'` 可建立／更新。

- [ ] **Step 1: 追加失敗測試**

`tests/discount-service.test.js`：第 3 行 import 改成

```js
import { normalizeCode, computeDiscount, validateDiscount, quoteDiscount } from '../src/services/discountService.js';
```

檔尾最後一個 `reset();` **之前**插入：

```js
// ── D6: fixed_price（每堂固定價；qty = 堂數）──
console.log('[discount-service] D6 start');
expect('computeDiscount fixed_price 單堂：1500 → 1200', ()=>assert.deepEqual(computeDiscount('fixed_price',1200,1500),{discountAmount:300,finalTotal:1200}));
expect('computeDiscount fixed_price 兩堂：3000 → 2400', ()=>assert.deepEqual(computeDiscount('fixed_price',1200,3000,2),{discountAmount:600,finalTotal:2400}));
expect('computeDiscount fixed_price 不會變貴：X ≥ 原價 → 折 0', ()=>assert.deepEqual(computeDiscount('fixed_price',2000,1500),{discountAmount:0,finalTotal:1500}));
expect('computeDiscount fixed_price qty 非法（0/undefined/小數/負/字串）一律當 1', ()=>{
  for (const q of [0, undefined, 1.5, -2, '3']) assert.deepEqual(computeDiscount('fixed_price',1200,3000,q),{discountAmount:1800,finalTotal:1200}, `qty=${q}`);
});
expect('percent/fixed 不受 qty 影響', ()=>{
  assert.deepEqual(computeDiscount('percent',10,1050,5),{discountAmount:105,finalTotal:945});
  assert.deepEqual(computeDiscount('fixed',800,500,5),{discountAmount:500,finalTotal:0});
});
mk({code:'TESTD_FP', discount_type:'fixed_price', discount_value:1200, active:1});
expect('validateDiscount fixed_price 帶 qty=3：4500 → 3600', ()=>{ const v=validateDiscount({code:'testd_fp',phone:'0994000040',subtotal:4500,qty:3}); assert.equal(v.type,'fixed_price'); assert.equal(v.value,1200); assert.equal(v.discountAmount,900); assert.equal(v.finalTotal,3600); });
expect('validateDiscount fixed_price 不帶 qty → 當 1', ()=>{ const v=validateDiscount({code:'testd_fp',phone:'0994000040',subtotal:1500}); assert.equal(v.finalTotal,1200); });
expect('quoteDiscount fixed_price qty=10：15000 → 12000', ()=>assert.equal(quoteDiscount({code:'TESTD_FP',amount:15000,qty:10}).finalTotal,12000));
expect('applyDiscountTx fixed_price qty=2 記 redemption amount 600', ()=>{
  tx(()=>applyDiscountTx({code:'TESTD_FP',phone:'0994000041',subtotal:3000,kind:'group_order',refId:999041,qty:2}));
  const r=db.prepare("SELECT amount FROM discount_redemptions WHERE kind='group_order' AND ref_id=999041").get();
  assert.equal(r.amount,600);
  releaseRedemption({kind:'group_order',refId:999041});
});
expect('createDiscountCode fixed_price OK', ()=>{ const c=createDiscountCode({code:'testd_fp2',discount_type:'fixed_price',discount_value:990}); assert.equal(c.discount_type,'fixed_price'); assert.equal(c.discount_value,990); });
expect('createDiscountCode fixed_price 值 0 → invalid_value', ()=>{ try{createDiscountCode({code:'TESTD_FP0',discount_type:'fixed_price',discount_value:0});assert.fail('should throw');}catch(e){assert.equal(e.code,'invalid_value');} });
expect('createDiscountCode 型態 bogus → invalid_type', ()=>{ try{createDiscountCode({code:'TESTD_BOGUS',discount_type:'bogus',discount_value:10});assert.fail('should throw');}catch(e){assert.equal(e.code,'invalid_type');} });
expect('updateDiscountCode 改型態為 fixed_price', ()=>{ const c=createDiscountCode({code:'testd_fp3',discount_type:'percent',discount_value:10}); const u=updateDiscountCode(c.id,{discount_type:'fixed_price',discount_value:1000}); assert.equal(u.discount_type,'fixed_price'); assert.equal(u.discount_value,1000); });
console.log('[discount-service] D6 done');
```

（`mk`／`tx`／`applyDiscountTx`／`releaseRedemption`／`createDiscountCode`／`updateDiscountCode` 檔內既有 import。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/discount-service.test.js 2>&1 | grep -E "✗|D6"`
Expected: D6 段多項 ✗（`fixed_price` 被當 `fixed` 算、`mk` 撞 CHECK、`invalid_type`）。

- [ ] **Step 3: 改 `schema.js`**

第 274 行改成：

```js
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed','fixed_price')),
```

- [ ] **Step 4: 改 `discountService.js`**

(a) `computeDiscount` 整個函式換成：

```js
/** 折扣計算的唯一入口。qty＝堂數（fixed_price 用；非正整數一律當 1）；percent／fixed 忽略 qty。 */
export function computeDiscount(type, value, subtotal, qty = 1) {
  const n = Number.isInteger(qty) && qty > 0 ? qty : 1;
  let discountAmount;
  if (type === 'percent') discountAmount = Math.floor((subtotal * value) / 100);
  else if (type === 'fixed_price') discountAmount = subtotal - value * n;   // 每堂固定 X → 折掉「原價 − X×堂數」；不會變貴
  else discountAmount = Math.min(value, subtotal);
  if (discountAmount < 0) discountAmount = 0;
  return { discountAmount, finalTotal: Math.max(0, subtotal - discountAmount) };
}
```

(b) `validateDiscount` 簽名改 `export function validateDiscount({ code, phone, subtotal, qty = 1 }) {`，內部 `computeDiscount(c.discount_type, c.discount_value, subtotal)` 改 `computeDiscount(c.discount_type, c.discount_value, subtotal, qty)`。

(c) `applyDiscountTx` 簽名改 `export function applyDiscountTx({ code, phone, subtotal, kind, refId, qty = 1 }) {`，內部 `validateDiscount({ code: norm, phone, subtotal })` 改 `validateDiscount({ code: norm, phone, subtotal, qty })`。

(d) `quoteDiscount` 簽名改 `export function quoteDiscount({ code, amount, qty = 1 }) {`，內部 `computeDiscount(c.discount_type, c.discount_value, amount)` 改 `computeDiscount(c.discount_type, c.discount_value, amount, qty)`。

(e) `validateCodeFields` 第一行改 `if (!['percent', 'fixed', 'fixed_price'].includes(discount_type)) throw new ApiError(400, 'invalid_type');`（值的規則那行不動：≥1、percent ≤100）。

- [ ] **Step 5: 跑測試確認通過**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/discount-service.test.js 2>&1 | grep -cE "✗"`
Expected: `0`；並 `grep -c "✓"` 比改前多 14。

- [ ] **Step 6: Commit**

```bash
git add src/services/discountService.js src/db/schema.js tests/discount-service.test.js
git commit -m "feat: 折扣碼新型態 fixed_price（每堂固定價，computeDiscount 加 qty）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 2: 舊 DB 整表 rebuild 遷移（`connection.js`）

**Files:**
- Modify: `src/db/connection.js`（第 142-147 行「2026-05-30 discount codes migration」區塊之後）
- Test: `tests/discount-migration.test.js`

**Interfaces:**
- Consumes: 既有 `db`、`addColumnIfMissing` 區塊位置。
- Produces: 開機後任何 DB 的 `discount_codes` CHECK 都含 `fixed_price`（Task 4 API 測試對 `data/app.db` 依賴此）。

- [ ] **Step 1: 追加失敗測試**

`tests/discount-migration.test.js` 的 `old.exec(\`…\`)` SQL 區塊，在 `INSERT INTO group_orders …;` 那行之後追加（仍在同一個模板字串內）：

```sql
  CREATE TABLE discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
    discount_value INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    valid_from TEXT, valid_until TEXT, max_uses INTEGER, per_phone_limit INTEGER, min_amount INTEGER, note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE discount_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id INTEGER NOT NULL REFERENCES discount_codes(id),
    phone TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('group_order','booking')),
    ref_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO discount_codes (id, code, discount_type, discount_value, note) VALUES (7, 'OLDFIX', 'fixed', 100, 'legacy');
  INSERT INTO discount_redemptions (code_id, phone, kind, ref_id, amount) VALUES (7, '0900000000', 'group_order', 1, 100);
```

檔尾 `console.log('[discount-migration] done');` **之前**追加：

```js
// ── fixed_price：舊 CHECK 的 discount_codes 整表 rebuild ──
expect('discount_codes CHECK 含 fixed_price', ()=>{ const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discount_codes'").get().sql; assert(sql.includes("'fixed_price'"), sql); });
expect('discount_codes_new 沒殘留', ()=>assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='discount_codes_new'").get(), undefined));
expect('舊碼 id/型態/值/備註原樣', ()=>{ const r=db.prepare('SELECT * FROM discount_codes WHERE id=7').get(); assert.equal(r.code,'OLDFIX'); assert.equal(r.discount_type,'fixed'); assert.equal(r.discount_value,100); assert.equal(r.note,'legacy'); });
expect('redemption 仍指向 id 7、FK 檢查乾淨', ()=>{ const r=db.prepare('SELECT code_id FROM discount_redemptions WHERE ref_id=1').get(); assert.equal(r.code_id,7); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
expect('升級後可寫入 fixed_price', ()=>{ db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value) VALUES ('NEWFP','fixed_price',1200)").run(); assert.equal(db.prepare("SELECT discount_type FROM discount_codes WHERE code='NEWFP'").get().discount_type,'fixed_price'); });
expect('UNIQUE(code) 在 rebuild 後仍在', ()=>assert.throws(()=>db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value) VALUES ('OLDFIX','percent',5)").run(), /UNIQUE/));
expect('rebuild 後新 id 接續（不與 7 撞）', ()=>{ const id=Number(db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value) VALUES ('NEWFP2','fixed_price',900)").run().lastInsertRowid); assert(id>7, String(id)); });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/discount-migration.test.js 2>&1 | grep -E "✗|done"`（此測試自帶 tmp DB，不用 DB_PATH 前綴）
Expected: 「CHECK 含 fixed_price」✗、「升級後可寫入 fixed_price」✗（CHECK 擋）。

- [ ] **Step 3: 加遷移**

`src/db/connection.js` 第 147 行 `addColumnIfMissing('bookings', 'discount_amount', 'INTEGER');` 之後插入：

```js
// ── 2026-09-10 折扣碼型態加 fixed_price：CHECK 改不了 → 整表 rebuild（比照 registrations）。
// 偵測訊號：建表 SQL 不含 'fixed_price'。id 原樣複製，discount_redemptions 的 FK 不受影響；重跑 no-op。
{
  const dcSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discount_codes'").get()?.sql || '';
  if (dcSql && !dcSql.includes("'fixed_price'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`
        CREATE TABLE discount_codes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed','fixed_price')),
          discount_value INTEGER NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          valid_from TEXT,
          valid_until TEXT,
          max_uses INTEGER,
          per_phone_limit INTEGER,
          min_amount INTEGER,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
      db.exec(`
        INSERT INTO discount_codes_new (id, code, discount_type, discount_value, active, valid_from, valid_until, max_uses, per_phone_limit, min_amount, note, created_at)
        SELECT id, code, discount_type, discount_value, active, valid_from, valid_until, max_uses, per_phone_limit, min_amount, note, created_at FROM discount_codes`);
      db.exec('DROP TABLE discount_codes');
      db.exec('ALTER TABLE discount_codes_new RENAME TO discount_codes');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    console.log('[migrate] discount_codes rebuilt (fixed_price type)');
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/discount-migration.test.js 2>&1 | grep -cE "✗"` → `0`；再跑 `DB_PATH="$(mktemp -d)/t.db" node tests/migration.test.js 2>&1 | grep -cE "✗"` → `0`（全新 DB 走 schema.js、rebuild 分支不觸發）。

- [ ] **Step 5: Commit**

```bash
git add src/db/connection.js tests/discount-migration.test.js
git commit -m "feat: 既有 DB 的 discount_codes 整表 rebuild 以納入 fixed_price

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 3: 五個套用點補 `qty`

**Files:**
- Modify: `src/server.js:1010-1030`（`POST /api/public/discounts/validate`）
- Modify: `src/services/groupOrderService.js:116`（下單）、`:568`（`adminCancelRegistration` 內 requote）
- Modify: `src/services/bookingService.js:141`
- Modify: `src/services/packageService.js:47`
- Test: `tests/discount-group.test.js`、`tests/package-discount.test.js`、`tests/discount-booking.test.js`

**Interfaces:**
- Consumes: Task 1 的 `applyDiscountTx({…, qty})`、`quoteDiscount({…, qty})`、`validateDiscount({…, qty})`。
- Produces: 五個套用點對 `fixed_price` 算成 X × 堂數；`percent`／`fixed` 不變。

- [ ] **Step 1: 追加失敗測試**

(a) `tests/discount-group.test.js`：第 4 行 import 加 `adminCancelRegistration`：

```js
import { createGroupOrder, cancelGroupOrder, cancelRegistrationPublic, confirmGroupOrder, adminCancelRegistration } from '../src/services/groupOrderService.js';
```

檔尾 `// ── Cleanup ──` **之前**追加：

```js
// ── fixed_price：X × 付款場次數；管理者取消一場（pending）後以剩餘場次重算 ──
db.prepare(`INSERT INTO discount_codes (code, discount_type, discount_value, active) VALUES ('TESTDG_FP', 'fixed_price', 300, 1)`).run();
let fpOrderId;
expect('fixed_price 兩場：original 1000、折 400、total 600（300×2）', () => {
  const o = createGroupOrder({ name: '固甲', phone: '0993000050', paySessionIds: [s1, s2], waitlistSessionIds: [], discountCode: 'TESTDG_FP' });
  fpOrderId = o.orderId;
  assert.equal(o.originalAmount, 1000); assert.equal(o.discountAmount, 400); assert.equal(o.total, 600);
  const row = db.prepare('SELECT original_amount, discount_amount, total_amount FROM group_orders WHERE id=?').get(fpOrderId);
  assert.deepEqual(row, { original_amount: 1000, discount_amount: 400, total_amount: 600 });
});
expect('管理者取消其中一場（pending）→ 重算 original 500、折 200、total 300（300×1）', () => {
  const reg = db.prepare("SELECT id FROM registrations WHERE order_id=? AND session_id=? AND status='pending'").get(fpOrderId, s2);
  adminCancelRegistration({ registrationId: reg.id, actorId: 1 });
  const row = db.prepare('SELECT original_amount, discount_amount, total_amount FROM group_orders WHERE id=?').get(fpOrderId);
  assert.deepEqual(row, { original_amount: 500, discount_amount: 200, total_amount: 300 });
});
expect('fixed_price X ≥ 單價 → 折 0、金額不變', () => {
  db.prepare(`INSERT INTO discount_codes (code, discount_type, discount_value, active) VALUES ('TESTDG_FPHI', 'fixed_price', 800, 1)`).run();
  const o = createGroupOrder({ name: '固乙', phone: '0993000051', paySessionIds: [s1], waitlistSessionIds: [], discountCode: 'TESTDG_FPHI' });
  assert.equal(o.originalAmount, 500); assert.equal(o.discountAmount, 0); assert.equal(o.total, 500);
});
```

(b) `tests/package-discount.test.js`：檔尾 `clean();` **之前**追加：

```js
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDFP','fixed_price',1200,1)").run();
expect('quoteDiscount fixed_price qty=10：15000 → 12000', () => { assert.equal(quoteDiscount({code:'PDFP',amount:15000,qty:10}).finalTotal, 12000); });
expect('createPackage fixed_price 碼 → amount = 1200×10', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000,discountCode:'PDFP'});
  assert.equal(p.amount,12000); assert.equal(p.discount_code,'PDFP');
});
expect('createPackage fixed_price X ≥ 單價 → 金額不變', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:5,amount:5000,discountCode:'PDFP'});
  assert.equal(p.amount,5000);
});
```

(c) `tests/discount-booking.test.js`：`// ── Test 1: createBookingAnon with discountCode ──` **之前**（seed 區之後）追加：

```js
// Seed: fixed_price 1200 code（一對一單堂 → 1200）
db.prepare(`INSERT INTO discount_codes (code, discount_type, discount_value, active)
  VALUES ('TESTDBK_FP', 'fixed_price', 1200, 1)`).run();
expect('createBookingAnon fixed_price：original=單堂價、final=1200', () => {
  const r = createBookingAnon({ coachId: coach.id, startAt: futureLocal(5, 9), name: '固丙', phone: '0992000090', discountCode: 'TESTDBK_FP' });
  assert.equal(r.originalAmount, price);
  assert.equal(r.discountAmount, price - 1200);
  assert.equal(r.finalAmount, 1200);
  const row = db.prepare('SELECT original_amount, discount_amount, discount_code FROM bookings WHERE id=?').get(r.id);
  assert.deepEqual(row, { original_amount: price, discount_amount: price - 1200, discount_code: 'TESTDBK_FP' });
});
```

（教練 `coach` 與 `price` 為該檔 seed 區既有變數；`futureLocal(5, 9)` 避開後面測試用的時段。若該教練無班表導致 `createBookingAnon` 擋時段，請沿用該檔 Test 1 建立預約前的班表／時段準備方式，把這段移到 Test 1 之後、用同一組班表。）

- [ ] **Step 2: 跑測試確認失敗**

Run（三檔各自）：
`DB_PATH="$(mktemp -d)/t.db" node tests/discount-group.test.js 2>&1 | grep -E "✗"`
`DB_PATH="$(mktemp -d)/t.db" node tests/package-discount.test.js 2>&1 | grep -E "✗"`
`DB_PATH="$(mktemp -d)/t.db" node tests/discount-booking.test.js 2>&1 | grep -E "✗"`
Expected：fixed_price 相關案例 ✗（未傳 qty 時團課／方案算成 X×1）；booking 那案可能已 ✓（qty 預設 1）——記錄即可。

- [ ] **Step 3: 改五個套用點**

(a) `src/server.js` 驗證端點，把

```js
  let subtotal;
  if (kind === 'one_on_one') {
```

改成

```js
  let subtotal;
  let qty = 1;   // 堂數：fixed_price 用（一對一 1、團課＝找得到範本的付款場次數）
  if (kind === 'one_on_one') {
```

group 分支的 `reduce` 整段換成

```js
    // group：由 sessionIds 即時加總付款場次單價（server 權威）；找不到範本的 id 不計入金額也不計入堂數
    const ids = (sessionIds || []).map(Number);
    subtotal = 0; qty = 0;
    for (const sid of ids) {
      const s = db.prepare('SELECT template_id FROM course_sessions WHERE id=?').get(sid);
      const tpl = s ? db.prepare('SELECT price_per_session FROM course_templates WHERE id=?').get(s.template_id) : null;
      if (tpl) { subtotal += tpl.price_per_session; qty++; }
    }
```

`const v = validateDiscount({ code, phone, subtotal });` 改 `const v = validateDiscount({ code, phone, subtotal, qty });`。

(b) `src/services/groupOrderService.js` 下單：`applyDiscountTx({ code: discountCode, phone, subtotal: total, kind: 'group_order', refId: orderId })` 改成 `applyDiscountTx({ code: discountCode, phone, subtotal: total, kind: 'group_order', refId: orderId, qty: paySessionIds.length })`。

(c) 同檔 `adminCancelRegistration` 內：`quoteDiscount({ code: order.discount_code, amount: remaining.subtotal })` 改成 `quoteDiscount({ code: order.discount_code, amount: remaining.subtotal, qty: remaining.c })`。

(d) `src/services/bookingService.js`：`applyDiscountTx({ code: discountCode, phone, subtotal, kind: 'booking', refId: r.id })` 改成 `applyDiscountTx({ code: discountCode, phone, subtotal, kind: 'booking', refId: r.id, qty: 1 })`。

(e) `src/services/packageService.js`：`quoteDiscount({ code: discountCode, amount: amt })` 改成 `quoteDiscount({ code: discountCode, amount: amt, qty: total })`（`total` 為同函式上方 `Number(totalSessions)`）。

- [ ] **Step 4: 跑測試確認通過＋完整鏈**

三檔各 `grep -cE "✗"` → `0`。再跑完整鏈：
`DB_PATH="$(mktemp -d)/t.db" npm test > /tmp/dfp-chain.log 2>&1; echo exit=$?; grep -c "✗" /tmp/dfp-chain.log`
Expected: `exit=0`、`0`。

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/services/groupOrderService.js src/services/bookingService.js src/services/packageService.js tests/discount-group.test.js tests/package-discount.test.js tests/discount-booking.test.js
git commit -m "feat: 五個折扣套用點帶入堂數 qty（團課/方案/一對一/單堂取消重算/公開驗證）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 4: API 測試（公開驗證端點＋後台 CRUD）

**Files:**
- Test: `tests/discount-api.test.js`（`[3]` group 段之後追加）、`tests/discount-admin-api.test.js`（`[2]` create 段之後追加）

**Interfaces:**
- Consumes: Task 1–3 已完成的行為；running server（`data/app.db`，開機時 Task 2 的 rebuild 已把 prod-like DB 升級）。
- Produces: 無新介面；端點契約有測試釘住。

- [ ] **Step 1: 追加測試**

(a) `tests/discount-api.test.js`：seed 區（`TESTAPI_EXP` 那筆之後）加

```js
db.prepare(`INSERT OR IGNORE INTO discount_codes (code, discount_type, discount_value, active)
  VALUES ('TESTAPI_FP', 'fixed_price', 300, 1)`).run();
db.prepare(`INSERT OR IGNORE INTO discount_codes (code, discount_type, discount_value, active)
  VALUES ('TESTAPI_FPHI', 'fixed_price', 9000, 1)`).run();
```

`// ── [4] Validate error paths ──` **之前**追加：

```js
// ── [3b] fixed_price：group 兩場 → 300×2；one_on_one → 300；X ≥ 單價 → 折 0 ──
console.log('[3b] validate fixed_price');
const vFpGroup = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI_FP', phone: '0995001004', kind: 'group', sessionIds: [sid1, sid2] },
});
expect('fixed_price group 200', () => assert.equal(vFpGroup.status, 200));
expect('fixed_price group discount_type', () => assert.equal(vFpGroup.data?.discount_type, 'fixed_price'));
expect('fixed_price group discount_value=300', () => assert.equal(vFpGroup.data?.discount_value, 300));
expect('fixed_price group original=1000、discount_amount=400、final_total=600', () => {
  assert.equal(vFpGroup.data?.original, 1000); assert.equal(vFpGroup.data?.discount_amount, 400); assert.equal(vFpGroup.data?.final_total, 600);
});
const vFp1v1 = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI_FP', phone: '0995001004', kind: 'one_on_one' },
});
expect('fixed_price one_on_one final_total=300', () => { assert.equal(vFp1v1.status, 200); assert.equal(vFp1v1.data?.final_total, 300); assert.equal(vFp1v1.data?.discount_amount, 1500 - 300); });
const vFpHi = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI_FPHI', phone: '0995001004', kind: 'one_on_one' },
});
expect('fixed_price X ≥ 單價 → discount_amount 0、final_total=原價', () => { assert.equal(vFpHi.status, 200); assert.equal(vFpHi.data?.discount_amount, 0); assert.equal(vFpHi.data?.final_total, 1500); });
```

（`cleanup()` 以 `code LIKE 'TESTAPI%'` 刪碼，新碼自動涵蓋。）

(b) `tests/discount-admin-api.test.js`：`[2]` create 段末（`expect('id returned', …)` 之後）追加：

```js
// ── [2b] fixed_price 建立／更新／驗證 ──
console.log('[2b] fixed_price create/update/validate');
const fpRes = await req('POST', '/api/admin/discount-codes', {
  token: adminToken, body: { code: 'testadm_fp', discount_type: 'fixed_price', discount_value: 1200 },
});
expect('create fixed_price → 201', () => assert.equal(fpRes.status, 201));
expect('discount_type=fixed_price', () => assert.equal(fpRes.data?.discount_type, 'fixed_price'));
expect('discount_value=1200', () => assert.equal(fpRes.data?.discount_value, 1200));
const fpId = fpRes.data?.id;
const fpPatch = await req('PATCH', `/api/admin/discount-codes/${fpId}`, {
  token: adminToken, body: { discount_type: 'percent', discount_value: 20 },
});
expect('PATCH fixed_price → percent 20 → 200', () => { assert.equal(fpPatch.status, 200); assert.equal(fpPatch.data?.discount_type, 'percent'); assert.equal(fpPatch.data?.discount_value, 20); });
const fpBack = await req('PATCH', `/api/admin/discount-codes/${fpId}`, {
  token: adminToken, body: { discount_type: 'fixed_price', discount_value: 990 },
});
expect('PATCH 改回 fixed_price 990 → 200', () => { assert.equal(fpBack.status, 200); assert.equal(fpBack.data?.discount_type, 'fixed_price'); assert.equal(fpBack.data?.discount_value, 990); });
const fpZero = await req('POST', '/api/admin/discount-codes', {
  token: adminToken, body: { code: 'testadm_fp0', discount_type: 'fixed_price', discount_value: 0 },
});
expect('create fixed_price 0 → 400 invalid_value', () => { assert.equal(fpZero.status, 400); assert.equal(fpZero.data?.error, 'invalid_value'); });
const fpBogus = await req('POST', '/api/admin/discount-codes', {
  token: adminToken, body: { code: 'testadm_bogus', discount_type: 'bogus', discount_value: 10 },
});
expect('create 型態 bogus → 400 invalid_type', () => { assert.equal(fpBogus.status, 400); assert.equal(fpBogus.data?.error, 'invalid_type'); });
const listFp = await req('GET', '/api/coach/discount-codes', { token: adminToken });
expect('GET /api/coach/discount-codes 含 fixed_price 型態', () => { assert.equal(listFp.status, 200); const c = listFp.data.find((x) => x.code === 'TESTADM_FP'); assert.ok(c); assert.equal(c.discount_type, 'fixed_price'); });
```

（`cleanup()` 以 `code LIKE 'TESTADM%'` 刪碼。）

- [ ] **Step 2: 起測試伺服器跑兩檔**

`LINE_MOCK=1 PORT=3456 node --env-file-if-exists=.env src/server.js > /tmp/dfp-api-server.log 2>&1 &`（server 與 test 都用預設 `data/app.db`，不要設 DB_PATH），確認 log 出現 `[migrate] discount_codes rebuilt (fixed_price type)` 或 DB 本就已升級。
Run: `BASE=http://localhost:3456 node tests/discount-api.test.js 2>&1 | grep -E "✗|done"`；`BASE=http://localhost:3456 node tests/discount-admin-api.test.js 2>&1 | grep -E "✗|done"`
Expected: 兩檔 0 ✗、各印 `done`。跑完 `kill` 伺服器、`npm run seed`。

- [ ] **Step 3: Commit**

```bash
git add tests/discount-api.test.js tests/discount-admin-api.test.js
git commit -m "test: fixed_price 公開驗證與後台 CRUD API 案例

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 5: 前端（後台表單／列表、教練下拉、公開頁文案）

**Files:**
- Modify: `public/admin.html:772-781`
- Modify: `public/admin.js:1302`（`discountOptionsHtml` label）、`:2151`／`:2165`（列表徽章）、`:2229`（openEdit 設型態後）、`:2319`（錯誤文案）、`resetDiscountCodeForm`（`:2266`）
- Modify: `public/coach.js:524`
- Modify: `public/group.js:302-310`
- Modify: `public/coaches.js:623`（`modalAppliedDiscount` 賦值）、`:495`（`refreshModalPrice` 訊息）

**Interfaces:**
- Consumes: 端點回傳的 `discount_type`／`discount_value`（既有欄位）。
- Produces: 無（畫面）。

本任務無自動化測試；驗證＝`node --input-type=module --check` 四個 JS 檔＋localhost 目視（controller 做瀏覽器 pass）。

- [ ] **Step 1: `admin.html`**

`#dc-type` 加第三個 option：

```html
            <select id="dc-type" required class="form-select">
              <option value="percent">百分比折扣</option>
              <option value="fixed">定額折扣</option>
              <option value="fixed_price">固定金額（每堂）</option>
            </select>
```

折扣值標籤的提示 span 加 id：

```html
            <label class="form-label">折扣值 <span class="text-red-500">*</span><span id="dc-value-hint" class="subtle text-xs ml-1">（%，1–100）</span></label>
```

- [ ] **Step 2: `admin.js`**

(a) 在 `discountOptionsHtml` 之前加共用 helper，並把兩處 label 改用它：

```js
// 折扣型態文案（列表徽章／下拉共用）
const DC_TYPE_BADGE = { percent: 'confirmed', fixed: 'waitlisted', fixed_price: 'pending' };
function discountTypeText(c) {
  if (c.discount_type === 'percent') return `減 ${c.discount_value}%`;
  if (c.discount_type === 'fixed_price') return `每堂 $${c.discount_value}`;
  return `減 $${c.discount_value}`;
}
function discountOptionText(c) {
  if (c.discount_type === 'percent') return `${c.discount_value}% 折扣`;
  if (c.discount_type === 'fixed_price') return `每堂 $${c.discount_value}`;
  return `折抵 $${c.discount_value}`;
}
```

`discountOptionsHtml` 內 `const label = (c) => …` 那行刪除，`${label(c)}` 改 `${discountOptionText(c)}`。

列表：`const typeLabel = c.discount_type === 'percent' ? … : …;` 改 `const typeLabel = discountTypeText(c);`；徽章 `badge-${c.discount_type === 'percent' ? 'confirmed' : 'waitlisted'}` 改 `badge-${DC_TYPE_BADGE[c.discount_type] || 'completed'}`。

(b) 提示切換 helper（放在 `resetDiscountCodeForm` 之前）：

```js
// 折扣值欄位提示與 placeholder 依型態切換
const DC_VALUE_HINT = { percent: ['（%，1–100）', '10'], fixed: ['（$，扣除金額）', '100'], fixed_price: ['（$，每堂固定價）', '1200'] };
function syncDcValueHint() {
  const type = document.getElementById('dc-type')?.value;
  const [hint, ph] = DC_VALUE_HINT[type] || DC_VALUE_HINT.percent;
  const hintEl = document.getElementById('dc-value-hint');
  const valEl = document.getElementById('dc-value');
  if (hintEl) hintEl.textContent = hint;
  if (valEl) valEl.placeholder = ph;
}
document.getElementById('dc-type')?.addEventListener('change', syncDcValueHint);
```

`openEdit` 的 `document.getElementById('dc-type').value = codeData.discount_type;` 之後加一行 `syncDcValueHint();`；`resetDiscountCodeForm` 的 `document.getElementById('discount-code-form').reset();` 之後加一行 `syncDcValueHint();`。

(c) 錯誤文案 `invalid_value: '折扣值無效（百分比需 1–100，定額需大於 0）'` 改 `invalid_value: '折扣值無效（百分比需 1–100，定額／固定金額需大於 0）'`。

- [ ] **Step 3: `coach.js`**

`discountOptionsHtml` 內的 `const label = (c) => c.discount_type === 'percent' ? \`${c.discount_value}% 折扣\` : \`折抵 $${c.discount_value}\`;` 改成

```js
  const label = (c) => c.discount_type === 'percent' ? `${c.discount_value}% 折扣`
    : c.discount_type === 'fixed_price' ? `每堂 $${c.discount_value}`
    : `折抵 $${c.discount_value}`;
```

- [ ] **Step 4: `group.js`**

`appliedDiscount = { code: result.discount_type === 'percent' ? … : code.toUpperCase(), … }` 的 `code` 改成三段：

```js
          code: result.discount_type === 'percent'
            ? `${code.toUpperCase()}（減${result.discount_value}%）`
            : result.discount_type === 'fixed_price'
              ? `${code.toUpperCase()}（每堂 NT$${Number(result.discount_value).toLocaleString()}）`
              : code.toUpperCase(),
```

成功訊息那行改成：

```js
        msgEl.textContent = result.discount_type === 'fixed_price'
          ? `折扣套用成功：每堂 NT$${Number(result.discount_value).toLocaleString()}，應付 NT$${result.final_total.toLocaleString()}`
          : `折扣套用成功：折 NT$${result.discount_amount.toLocaleString()}，應付 NT$${result.final_total.toLocaleString()}`;
```

- [ ] **Step 5: `coaches.js`**

`modalAppliedDiscount = { code: code.toUpperCase(), discountAmount: result.discount_amount, finalTotal: result.final_total, remainingUses: result.remaining_uses ?? null };` 改成

```js
    modalAppliedDiscount = { code: code.toUpperCase(), type: result.discount_type, value: result.discount_value, discountAmount: result.discount_amount, finalTotal: result.final_total, remainingUses: result.remaining_uses ?? null };
```

`refreshModalPrice` 內 `msgEl.textContent = \`折扣套用成功：折後現場應付 $${…}\`;` 改成

```js
    msgEl.textContent = modalAppliedDiscount.type === 'fixed_price'
      ? `折扣套用成功：每堂 $${Number(modalAppliedDiscount.value).toLocaleString()}，折後現場應付 $${modalAppliedDiscount.finalTotal.toLocaleString()}`
      : `折扣套用成功：折後現場應付 $${modalAppliedDiscount.finalTotal.toLocaleString()}`;
```

（`refreshModalPrice` 若有循環模式分支寫別的訊息，不動。）

- [ ] **Step 6: 語法檢查＋localhost 目視**

Run: `for f in admin coach group coaches; do node --input-type=module --check < public/$f.js && echo "$f ok"; done`
起 `LINE_MOCK=1 PORT=3457 node --env-file-if-exists=.env src/server.js` → 後台折扣碼表單型態下拉有第三項、切換時提示與 placeholder 跟著變、建立一筆 `fixed_price` 後列表徽章「每堂 $1200」；公開團課頁選兩場套該碼顯示「每堂 NT$1,200，應付 NT$…」。用 curl 至少確認 `GET /admin.html` 含 `dc-value-hint` 與 `fixed_price`；瀏覽器 pass 由 controller 做。跑完 kill 伺服器。

- [ ] **Step 7: Commit**

```bash
git add public/admin.html public/admin.js public/coach.js public/group.js public/coaches.js
git commit -m "feat: 後台／公開頁支援固定金額（每堂）折扣碼型態的建立與顯示

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

## 完成後（controller 自己做）

1. `DB_PATH="$(mktemp -d)/t.db" npm test` 全綠；起測試伺服器跑 `npm run test:api` 全綠後 `npm run seed`。
2. 業主 localhost smoke（後台建 fixed_price 碼、公開團課頁套用、一對一彈窗套用）。
3. Draft PR → 終審 → 合併；合併部署時 prod 開機 log 應出現 `[migrate] discount_codes rebuilt (fixed_price type)`。
