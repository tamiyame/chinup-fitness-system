# 報價單系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CHINUP 後台報價單管理（自動單號/歷史/複製/成交追蹤）＋一套 A4 版面三用的公開頁 `/q/:token`（客戶線上看、列印、另存 PDF）。

**Architecture:** 兩張新表（quotes/quote_items，金額存檔凍結）＋`quoteService.js` 全業務邏輯＋server.js 六個 admin 端點與一個公開 token 端點；後台 admin.html 第 9 個頁籤只做管理，A4 版面只存在於 `public/quote.html` 一份。公司抬頭資訊走既有 `app_settings`。

**Tech Stack:** Node ≥24（ESM）、express、**node:sqlite**（`DatabaseSync`，不是 better-sqlite3）、零新依賴、原生前端（無框架）。

**Spec:** `docs/superpowers/specs/2026-08-14-quotation-system-design.md`

## Global Constraints

- 分支：`quotation-system`（已存在，spec 已在其上）。所有 commit 打在此分支。
- 零新 npm 依賴。DB 一律經 `src/db/connection.js` 的 `db`/`tx`/`nowLocal`。
- 新表加進 `src/db/schema.js` 的 SCHEMA 字串（`CREATE TABLE IF NOT EXISTS`，開機自動套用；全新表不需要 connection.js 的 addColumnIfMissing）。
- 金額規則（伺服器重算、不信前端）：`amount = Math.round(qty × unit_price)`；`subtotal = Σ amount`；`tax = Math.round(subtotal × 0.05)`；`total = subtotal + tax`。全部 INTEGER（台幣元）；qty 為 REAL 允許小數。
- 單號 `CU<西元年>-<4位流水>`（例 `CU2026-0001`），年度重計；年份取 `nowLocal().slice(0, 4)`（建立當下）。
- token：`crypto.randomBytes(16).toString('hex')`（32 hex 字元）。
- 公開端點**不得**回傳 `deal_status`、資料庫 `id`、`token` 欄位。
- 錯誤用 `ApiError(status, code, detail)`（`src/services/registration.js`），server 端點掛 `requireAdmin` + `asyncHandler`。
- 測試是純腳本（非測試框架）：`expect(label, fn)` 小工具、`console.log('[x test] start/done')`、失敗設 `process.exitCode = 1`。service 測試加進 package.json `test` 鏈尾、API 測試加進 `test:api` 鏈尾。
- `npm test` 會弄髒 `data/app.db`（demo DB 共用）——測資一律用 `QT測試`/`QT-API測試` 前綴並在測試開頭清理；全部跑完後 `npm run seed` 還原 demo 資料。
- UI 中文文案、後台沿用既有語彙：`a-sec-head`／`a-row`／`a-row-actions`／`badge badge-*`／`empty-state`／`limitSlice`+`moreButtonHtml`+`bindLoadMore`（PAGE=20）／`form-label`+`form-input`／`btn btn-primary|btn-ghost|btn-dark|btn-danger btn-sm`。
- commit 訊息中文、結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## File Structure

- Modify `src/db/schema.js` — SCHEMA 字串加 quotes/quote_items 兩表＋5 筆 company app_settings 種子
- Create `src/services/quoteService.js` — 驗證/單號/CRUD/作廢/成交/公開過濾，全部業務邏輯
- Modify `src/server.js` — import quoteService、6 個 admin 端點、1 個公開端點、`/q/:token` 頁面路由、settingsPayload/PATCH 加 company 5 keys
- Create `public/quote.html` — 公開 A4 報價單頁（一套版面三用；內嵌 script，比照 line-bind.html）
- Modify `public/admin.html` — 頁籤按鈕＋`#apanel-quotes` panel＋「報價單公司資訊」設定 card
- Modify `public/admin.js` — quotes 列表/搜尋/drawer 建編/列動作＋設定讀寫
- Create `tests/quote-service.test.js`（`test` 鏈）、Create `tests/quote-api.test.js`（`test:api` 鏈）
- Modify `package.json` — 兩條測試鏈各加一筆

---

### Task 1: Schema＋quoteService 建立面（驗證、單號、建立、查詢）

**Files:**
- Modify: `src/db/schema.js`（SCHEMA 字串尾端、`group_order_refunds` 表之後；company 種子加在既有 `INSERT OR IGNORE INTO app_settings` 群組尾）
- Create: `src/services/quoteService.js`
- Test: `tests/quote-service.test.js`
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/quote-service.test.js`）

**Interfaces:**
- Consumes: `db`, `tx`, `nowLocal`（`src/db/connection.js`）；`ApiError`（`src/services/registration.js`）
- Produces（後續 task 依賴的精確簽名）:
  - `validateQuoteInput(body) → { customer_title, customer_tax_id, contact_name, contact_phone, quote_date, valid_until, payment_terms, delivery_terms, notes, items:[{name,spec,qty,unit,unit_price,amount}], subtotal, tax, total }`（丟 `ApiError(400, code)`）
  - `nextQuoteNoFor(year: string) → string`（如 `'CU2031-0001'`；需在 tx 內呼叫）
  - `createQuote(body) → quote row ＋ { items: [...] }`
  - `listQuotes() → quote rows（不含 items）, created_at DESC`
  - `getQuoteAdmin(id) → quote ＋ items`（404 `not_found`）

- [ ] **Step 1: 寫 failing test（tests/quote-service.test.js 前半）**

```js
// 報價單 service：驗證/金額/單號/建立/查詢（後半：編輯/作廢/成交/公開過濾在同檔尾端）。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { validateQuoteInput, nextQuoteNoFor, createQuote, listQuotes, getQuoteAdmin } =
  await import('../src/services/quoteService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[quote-service test] start');

// ── 清理本測試資料（customer_title 前綴鎖範圍；quote_items 由 FK CASCADE 帶走）──
db.exec("DELETE FROM quotes WHERE customer_title LIKE 'QT測試%'");
db.exec("DELETE FROM quotes WHERE quote_no LIKE 'CU2031-%'");   // 跨年重計測試用年份

const base = () => ({
  customer_title: 'QT測試股份有限公司',
  customer_tax_id: '12345678',
  contact_name: '王小明',
  contact_phone: '0912345678',
  quote_date: '2026-08-14',
  valid_until: '2026-09-13',
  payment_terms: '簽約後 7 日內電匯 50%，課程結束付清尾款',
  delivery_terms: '雙方確認後 14 日內開課',
  notes: '含教材與場地',
  items: [
    { name: '企業體能課程', spec: '10 堂・每堂 60 分', qty: 10, unit: '堂', unit_price: 2000 },
    { name: '健康講座', qty: 1.5, unit: '小時', unit_price: 3000 },
  ],
});

// ── validateQuoteInput ──
expect('缺客戶抬頭 → missing_customer_title', () => {
  assert.throws(() => validateQuoteInput({ ...base(), customer_title: ' ' }), /missing_customer_title/);
});
expect('空品項 → missing_items', () => {
  assert.throws(() => validateQuoteInput({ ...base(), items: [] }), /missing_items/);
});
expect('品名空白 → missing_item_name', () => {
  const b = base(); b.items[0].name = '';
  assert.throws(() => validateQuoteInput(b), /missing_item_name/);
});
expect('qty=0 → invalid_item_qty', () => {
  const b = base(); b.items[0].qty = 0;
  assert.throws(() => validateQuoteInput(b), /invalid_item_qty/);
});
expect('unit_price=-1 → invalid_item_price', () => {
  const b = base(); b.items[0].unit_price = -1;
  assert.throws(() => validateQuoteInput(b), /invalid_item_price/);
});
expect('unit_price=1.5（非整數）→ invalid_item_price', () => {
  const b = base(); b.items[0].unit_price = 1.5;
  assert.throws(() => validateQuoteInput(b), /invalid_item_price/);
});
expect('日期格式錯 → invalid_quote_date', () => {
  assert.throws(() => validateQuoteInput({ ...base(), quote_date: '2026/08/14' }), /invalid_quote_date/);
});
expect('有效期限早於報價日 → valid_until_before_quote_date', () => {
  assert.throws(() => validateQuoteInput({ ...base(), valid_until: '2026-08-13' }), /valid_until_before_quote_date/);
});
expect('金額計算：10×2000＋1.5×3000 → subtotal 24500 / tax 1225 / total 25725', () => {
  const v = validateQuoteInput(base());
  assert.equal(v.items[0].amount, 20000);
  assert.equal(v.items[1].amount, 4500);
  assert.equal(v.subtotal, 24500);
  assert.equal(v.tax, 1225);
  assert.equal(v.total, 25725);
});
expect('小計四捨五入：1.5×999 → 1499', () => {
  const v = validateQuoteInput({ ...base(), items: [{ name: 'x', qty: 1.5, unit_price: 999 }] });
  assert.equal(v.items[0].amount, 1499);
});
expect('0 元贈送列允許', () => {
  const v = validateQuoteInput({ ...base(), items: [{ name: '贈送體驗課', qty: 1, unit_price: 0 }] });
  assert.equal(v.subtotal, 0); assert.equal(v.total, 0);
});
expect('選填欄位空字串 → null', () => {
  const v = validateQuoteInput({ ...base(), customer_tax_id: ' ', notes: '' });
  assert.equal(v.customer_tax_id, null);
  assert.equal(v.notes, null);
});

// ── 單號 ──
expect('nextQuoteNoFor：無該年單 → 0001（跨年重計）', () => {
  assert.equal(nextQuoteNoFor('2031'), 'CU2031-0001');
});

// ── createQuote ──
const q1 = createQuote(base());
expect('createQuote：單號格式 CU\\d{4}-\\d{4}、token 32 hex、items 落庫', () => {
  assert.match(q1.quote_no, /^CU\d{4}-\d{4}$/);
  assert.match(q1.token, /^[0-9a-f]{32}$/);
  assert.equal(q1.items.length, 2);
  assert.equal(q1.items[0].position, 0);
  assert.equal(q1.items[1].position, 1);
  assert.equal(q1.subtotal, 24500); assert.equal(q1.tax, 1225); assert.equal(q1.total, 25725);
  assert.equal(q1.deal_status, null); assert.equal(q1.voided_at, null);
});
const q2 = createQuote(base());
expect('連續建立：流水遞增、token 不重複', () => {
  assert.equal(Number(q2.quote_no.slice(-4)), Number(q1.quote_no.slice(-4)) + 1);
  assert.notEqual(q2.token, q1.token);
});
expect('前端假數字被伺服器重算覆蓋', () => {
  const b = base(); b.subtotal = 1; b.tax = 1; b.total = 1; b.items[0].amount = 1;
  const q = createQuote(b);
  assert.equal(q.subtotal, 24500); assert.equal(q.total, 25725);
});

// ── 查詢 ──
expect('listQuotes：含新單、新在前、不含 items 欄位', () => {
  const rows = listQuotes();
  const mine = rows.filter((r) => r.customer_title.startsWith('QT測試'));
  assert.ok(mine.length >= 3);
  assert.equal(rows[0].items, undefined);
});
expect('getQuoteAdmin：回 items；查無 → not_found', () => {
  const g = getQuoteAdmin(q1.id);
  assert.equal(g.items.length, 2);
  assert.equal(g.items[0].name, '企業體能課程');
  assert.throws(() => getQuoteAdmin(99999999), /not_found/);
});

console.log('[quote-service test] done');
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `cd ~/projects/chinup-fitness-system && node tests/quote-service.test.js`
Expected: FAIL — `Cannot find module .../src/services/quoteService.js`（import 即炸）

- [ ] **Step 3: schema.js 加兩張表＋company 種子**

在 SCHEMA 字串內、`group_order_refunds` 的 `CREATE INDEX ... idx_group_order_refunds_order` 之後（字串結尾反引號之前）加：

```sql
-- 報價單（對企業客戶）：金額為存檔快照（編輯時重算）；單號 CU<年>-<4位流水>年度重計；
-- token 為公開分享連結 /q/:token 的亂數識別。deal_status 為內部成交標記，公開端點不回傳。
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_no TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  customer_title TEXT NOT NULL,
  customer_tax_id TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  quote_date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  payment_terms TEXT,
  delivery_terms TEXT,
  notes TEXT,
  subtotal INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  deal_status TEXT CHECK (deal_status IN ('won','lost')),
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at DESC);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  spec TEXT,
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quote_id);
```

在既有 `INSERT OR IGNORE INTO app_settings` 群組尾（`payroll_group_pct` 那行之後）加：

```sql
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('company_name', 'CHINUP Performance');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('company_tax_id', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('company_phone', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('company_email', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('company_address', '');
```

- [ ] **Step 4: 建 src/services/quoteService.js（建立面）**

```js
import { randomBytes } from 'node:crypto';
import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting } from './discountService.js';

const TAX_RATE = 0.05;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nstr = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };

/** 白名單驗證＋正規化＋金額重算（不信前端送來的 subtotal/tax/total/amount）。丟 ApiError(400, code)。 */
export function validateQuoteInput(b) {
  const customer_title = String(b?.customer_title ?? '').trim();
  if (!customer_title) throw new ApiError(400, 'missing_customer_title');
  const quote_date = String(b?.quote_date ?? '').trim();
  if (!DATE_RE.test(quote_date)) throw new ApiError(400, 'invalid_quote_date');
  const valid_until = String(b?.valid_until ?? '').trim();
  if (!DATE_RE.test(valid_until)) throw new ApiError(400, 'invalid_valid_until');
  if (valid_until < quote_date) throw new ApiError(400, 'valid_until_before_quote_date');
  const rawItems = Array.isArray(b?.items) ? b.items : [];
  if (!rawItems.length) throw new ApiError(400, 'missing_items');
  const items = rawItems.map((it, i) => {
    const name = String(it?.name ?? '').trim();
    if (!name) throw new ApiError(400, 'missing_item_name', { index: i });
    const qty = Number(it?.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'invalid_item_qty', { index: i });
    const unit_price = Number(it?.unit_price);
    if (!Number.isInteger(unit_price) || unit_price < 0) throw new ApiError(400, 'invalid_item_price', { index: i });
    return { name, spec: nstr(it?.spec), qty, unit: nstr(it?.unit), unit_price, amount: Math.round(qty * unit_price) };
  });
  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return {
    customer_title, customer_tax_id: nstr(b?.customer_tax_id),
    contact_name: nstr(b?.contact_name), contact_phone: nstr(b?.contact_phone),
    quote_date, valid_until,
    payment_terms: nstr(b?.payment_terms), delivery_terms: nstr(b?.delivery_terms), notes: nstr(b?.notes),
    items, subtotal, tax, total: subtotal + tax,
  };
}

/** 單號 CU<年>-<4位流水>，年度重計。零填流水使字串排序＝數值排序。
 *  呼叫端需在 tx() 內（node:sqlite 同步、tx 序列化寫入即防撞號）。 */
export function nextQuoteNoFor(year) {
  const last = db.prepare('SELECT quote_no FROM quotes WHERE quote_no LIKE ? ORDER BY quote_no DESC LIMIT 1')
    .get(`CU${year}-%`);
  const n = last ? Number(last.quote_no.slice(-4)) + 1 : 1;
  return `CU${year}-${String(n).padStart(4, '0')}`;
}

const insertQuoteStmt = db.prepare(`INSERT INTO quotes
  (quote_no, token, customer_title, customer_tax_id, contact_name, contact_phone,
   quote_date, valid_until, payment_terms, delivery_terms, notes, subtotal, tax, total)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insertItemStmt = db.prepare(`INSERT INTO quote_items
  (quote_id, position, name, spec, qty, unit, unit_price, amount) VALUES (?,?,?,?,?,?,?,?)`);
const getQuoteStmt = db.prepare('SELECT * FROM quotes WHERE id = ?');
const getItemsStmt = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY position ASC, id ASC');

function withItems(q) { return q ? { ...q, items: getItemsStmt.all(q.id) } : null; }

export function createQuote(body) {
  const v = validateQuoteInput(body);
  return tx(() => {
    const quote_no = nextQuoteNoFor(nowLocal().slice(0, 4));
    const token = randomBytes(16).toString('hex');
    const info = insertQuoteStmt.run(quote_no, token, v.customer_title, v.customer_tax_id,
      v.contact_name, v.contact_phone, v.quote_date, v.valid_until,
      v.payment_terms, v.delivery_terms, v.notes, v.subtotal, v.tax, v.total);
    const id = Number(info.lastInsertRowid);
    v.items.forEach((it, i) => insertItemStmt.run(id, i, it.name, it.spec, it.qty, it.unit, it.unit_price, it.amount));
    return withItems(getQuoteStmt.get(id));
  });
}

export function listQuotes() {
  return db.prepare('SELECT * FROM quotes ORDER BY created_at DESC, id DESC').all();
}

export function getQuoteAdmin(id) {
  const q = withItems(getQuoteStmt.get(id));
  if (!q) throw new ApiError(404, 'not_found');
  return q;
}
```

（`getSetting` 這一步先 import 好，Task 2 的 `getQuoteByToken` 會用到；ESLint 沒掛在這個 repo，未使用 import 不會擋。）

- [ ] **Step 5: 跑測試確認 pass**

Run: `node tests/quote-service.test.js`
Expected: 全部 `✓`、exit code 0（`echo $?` 為 0）

- [ ] **Step 6: package.json test 鏈尾加測試**

`"test"` script 字串結尾（`&& node tests/admin-group-reg.test.js` 之後）加 `&& node tests/quote-service.test.js`。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.js src/services/quoteService.js tests/quote-service.test.js package.json
git commit -m "報價單 schema＋service 建立面（驗證/單號/金額凍結/查詢）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: quoteService 管理面（編輯、作廢、成交標記、公開過濾）

**Files:**
- Modify: `src/services/quoteService.js`（檔尾續加）
- Test: `tests/quote-service.test.js`（`console.log('[quote-service test] done')` 之前續加）

**Interfaces:**
- Consumes: Task 1 的 `validateQuoteInput`/`insertItemStmt`/`getQuoteStmt`/`getItemsStmt`/`withItems`、`getSetting`
- Produces:
  - `updateQuote(id, body) → quote＋items`（404 `not_found`；已作廢 409 `quote_voided`；quote_no/token 不變、items 整組替換、金額重算）
  - `voidQuote(id) → quote＋items`（已作廢再打 409 `already_void`）
  - `setDealStatus(id, status) → quote＋items`（status ∈ `'won'|'lost'|null`，否則 400 `invalid_deal_status`；已作廢 409 `quote_voided`）
  - `getQuoteByToken(token) → 公開物件`：`{ quote_no, customer_title, customer_tax_id, contact_name, contact_phone, quote_date, valid_until, payment_terms, delivery_terms, notes, subtotal, tax, total, voided:boolean, expired:boolean, items:[{name,spec,qty,unit,unit_price,amount}], company:{name,tax_id,phone,email,address} }`（404 `not_found`；**無** id/token/deal_status；`expired` 以伺服器 `nowLocal()` 判定且作廢單恆 false）

- [ ] **Step 1: 續寫 failing tests（插在 done 行之前）**

```js
// ── updateQuote ──
const beforeEdit = getQuoteAdmin(q1.id);
const edited = (() => {
  const b = base();
  b.items = [{ name: '改版課程', spec: '20 堂', qty: 20, unit: '堂', unit_price: 1800 }];
  return updateQuote(q1.id, b);
})();
expect('updateQuote：金額重算、items 整組替換、單號/token 不變', () => {
  assert.equal(edited.subtotal, 36000);
  assert.equal(edited.tax, 1800);
  assert.equal(edited.total, 37800);
  assert.equal(edited.items.length, 1);
  assert.equal(edited.items[0].name, '改版課程');
  assert.equal(edited.quote_no, beforeEdit.quote_no);
  assert.equal(edited.token, beforeEdit.token);
});
expect('updateQuote 查無 → not_found', () => {
  assert.throws(() => updateQuote(99999999, base()), /not_found/);
});

// ── voidQuote ──
const voided = voidQuote(q2.id);
expect('voidQuote：寫 voided_at', () => { assert.ok(voided.voided_at); });
expect('已作廢再作廢 → already_void', () => { assert.throws(() => voidQuote(q2.id), /already_void/); });
expect('已作廢不可編輯 → quote_voided', () => { assert.throws(() => updateQuote(q2.id, base()), /quote_voided/); });
expect('已作廢不可標成交 → quote_voided', () => { assert.throws(() => setDealStatus(q2.id, 'won'), /quote_voided/); });

// ── setDealStatus ──
expect('setDealStatus：won / lost / null 三態', () => {
  assert.equal(setDealStatus(q1.id, 'won').deal_status, 'won');
  assert.equal(setDealStatus(q1.id, 'lost').deal_status, 'lost');
  assert.equal(setDealStatus(q1.id, null).deal_status, null);
});
expect('setDealStatus 非法值 → invalid_deal_status', () => {
  assert.throws(() => setDealStatus(q1.id, 'maybe'), /invalid_deal_status/);
});

// ── getQuoteByToken（公開過濾）──
expect('getQuoteByToken：查得、含 items 與 company、不洩漏內部欄位', () => {
  const pub = getQuoteByToken(edited.token);
  assert.equal(pub.quote_no, edited.quote_no);
  assert.equal(pub.items.length, 1);
  assert.ok(pub.company && typeof pub.company.name === 'string');
  assert.ok(!('id' in pub));
  assert.ok(!('token' in pub));
  assert.ok(!('deal_status' in pub));
  assert.ok(!('id' in pub.items[0]));
  assert.equal(pub.voided, false);
  assert.equal(pub.expired, false);   // valid_until 2026-09-13 於本測試撰寫時未過；若真實日期已超過請改 base() 的日期為未來年份
});
expect('假 token → not_found', () => {
  assert.throws(() => getQuoteByToken('deadbeef'.repeat(4)), /not_found/);
});
expect('過期單：expired=true；作廢單：voided=true 且 expired=false', () => {
  const past = createQuote({ ...base(), quote_date: '2020-01-01', valid_until: '2020-01-02' });
  assert.equal(getQuoteByToken(past.token).expired, true);
  voidQuote(past.id);
  const pub = getQuoteByToken(past.token);
  assert.equal(pub.voided, true);
  assert.equal(pub.expired, false);
});
expect('company 取 app_settings 即時值', () => {
  const orig = getSetting('company_name');
  setSetting('company_name', 'QT測試公司抬頭');
  assert.equal(getQuoteByToken(edited.token).company.name, 'QT測試公司抬頭');
  setSetting('company_name', orig ?? '');
});
```

並把檔頭 import 行改為（多引入四個函式與 settings 工具）：

```js
const { validateQuoteInput, nextQuoteNoFor, createQuote, listQuotes, getQuoteAdmin,
  updateQuote, voidQuote, setDealStatus, getQuoteByToken } = await import('../src/services/quoteService.js');
const { getSetting, setSetting } = await import('../src/services/discountService.js');
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `node tests/quote-service.test.js`
Expected: FAIL — `updateQuote is not a function`（import 解構為 undefined 後呼叫即炸）

- [ ] **Step 3: quoteService.js 檔尾續加四個函式**

```js
export function updateQuote(id, body) {
  const q = getQuoteStmt.get(id);
  if (!q) throw new ApiError(404, 'not_found');
  if (q.voided_at) throw new ApiError(409, 'quote_voided');
  const v = validateQuoteInput(body);
  return tx(() => {
    db.prepare(`UPDATE quotes SET customer_title=?, customer_tax_id=?, contact_name=?, contact_phone=?,
      quote_date=?, valid_until=?, payment_terms=?, delivery_terms=?, notes=?,
      subtotal=?, tax=?, total=?, updated_at=? WHERE id=?`)
      .run(v.customer_title, v.customer_tax_id, v.contact_name, v.contact_phone,
        v.quote_date, v.valid_until, v.payment_terms, v.delivery_terms, v.notes,
        v.subtotal, v.tax, v.total, nowLocal(), id);
    db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(id);
    v.items.forEach((it, i) => insertItemStmt.run(id, i, it.name, it.spec, it.qty, it.unit, it.unit_price, it.amount));
    return withItems(getQuoteStmt.get(id));
  });
}

export function voidQuote(id) {
  const q = getQuoteStmt.get(id);
  if (!q) throw new ApiError(404, 'not_found');
  if (q.voided_at) throw new ApiError(409, 'already_void');
  db.prepare('UPDATE quotes SET voided_at = ?, updated_at = ? WHERE id = ?').run(nowLocal(), nowLocal(), id);
  return withItems(getQuoteStmt.get(id));
}

export function setDealStatus(id, status) {
  if (status !== null && status !== 'won' && status !== 'lost') throw new ApiError(400, 'invalid_deal_status');
  const q = getQuoteStmt.get(id);
  if (!q) throw new ApiError(404, 'not_found');
  if (q.voided_at) throw new ApiError(409, 'quote_voided');
  db.prepare('UPDATE quotes SET deal_status = ?, updated_at = ? WHERE id = ?').run(status, nowLocal(), id);
  return withItems(getQuoteStmt.get(id));
}

/** 公開端：白名單欄位（不洩漏 id/token/deal_status），附 app_settings 即時公司資訊與
 *  伺服器時間判定的過期旗標。作廢單 expired 恆 false（作廢優先）。 */
export function getQuoteByToken(token) {
  const q = db.prepare('SELECT * FROM quotes WHERE token = ?').get(String(token || ''));
  if (!q) throw new ApiError(404, 'not_found');
  const items = getItemsStmt.all(q.id).map(({ name, spec, qty, unit, unit_price, amount }) =>
    ({ name, spec, qty, unit, unit_price, amount }));
  const today = nowLocal().slice(0, 10);
  return {
    quote_no: q.quote_no,
    customer_title: q.customer_title, customer_tax_id: q.customer_tax_id,
    contact_name: q.contact_name, contact_phone: q.contact_phone,
    quote_date: q.quote_date, valid_until: q.valid_until,
    payment_terms: q.payment_terms, delivery_terms: q.delivery_terms, notes: q.notes,
    subtotal: q.subtotal, tax: q.tax, total: q.total,
    voided: !!q.voided_at, expired: !q.voided_at && q.valid_until < today,
    items,
    company: {
      name: getSetting('company_name') || '',
      tax_id: getSetting('company_tax_id') || '',
      phone: getSetting('company_phone') || '',
      email: getSetting('company_email') || '',
      address: getSetting('company_address') || '',
    },
  };
}
```

- [ ] **Step 4: 跑測試確認 pass**

Run: `node tests/quote-service.test.js`
Expected: 全部 `✓`、exit code 0

- [ ] **Step 5: Commit**

```bash
git add src/services/quoteService.js tests/quote-service.test.js
git commit -m "報價單 service 管理面：編輯重算/作廢守門/成交標記/公開欄位過濾

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: server.js API 端點＋company settings

**Files:**
- Modify: `src/server.js` — ① import 區（`shiftService` import 之後、`const __dirname` 之前）；② admin 報價端點＋公開端點（放「--- Admin: Settings ---」`settingsPayload` 區塊之前）；③ `settingsPayload()` 加 5 keys；④ PATCH `/api/admin/settings` 加 company 寫入分支（`checkin_radius_m` 迴圈之後、`tx(() => ...)` 之前）
- Test: `tests/quote-api.test.js`
- Modify: `package.json`（`test:api` 鏈尾加 `&& node tests/quote-api.test.js`）

**Interfaces:**
- Consumes: Task 1/2 全部 service 函式；既有 `requireAdmin`/`asyncHandler`/`getSetting`
- Produces（Task 4/5/6 前端依賴的 API 合約）:
  - `GET /api/admin/quotes` → `[quote row]`（含 token/deal_status/voided_at，無 items）
  - `POST /api/admin/quotes` → 201 ＋ quote＋items
  - `GET /api/admin/quotes/:id` → quote＋items
  - `PUT /api/admin/quotes/:id` → quote＋items
  - `POST /api/admin/quotes/:id/void` → quote＋items
  - `POST /api/admin/quotes/:id/deal`（body `{ deal_status: 'won'|'lost'|null }`）→ quote＋items
  - `GET /api/public/quotes/:token` → 公開物件（Task 2 形狀）
  - `GET/PATCH /api/admin/settings` 多 5 個 key：`company_name/company_tax_id/company_phone/company_email/company_address`（自由文字、trim、允許空字串）
  - **`/q/:token` 頁面路由留給 Task 4**（quote.html 尚不存在，先掛會 sendFile ENOENT）

- [ ] **Step 1: server.js 三處修改**

import 區加：

```js
import { createQuote, listQuotes, getQuoteAdmin, updateQuote, voidQuote,
  setDealStatus, getQuoteByToken } from './services/quoteService.js';
```

「--- Admin: Settings ---」註解行之前加：

```js
// --- Admin: Quotes（報價單）---
app.get('/api/admin/quotes', requireAdmin, asyncHandler((req, res) => {
  res.json(listQuotes());
}));
app.post('/api/admin/quotes', requireAdmin, asyncHandler((req, res) => {
  res.status(201).json(createQuote(req.body || {}));
}));
app.get('/api/admin/quotes/:id', requireAdmin, asyncHandler((req, res) => {
  res.json(getQuoteAdmin(Number(req.params.id)));
}));
app.put('/api/admin/quotes/:id', requireAdmin, asyncHandler((req, res) => {
  res.json(updateQuote(Number(req.params.id), req.body || {}));
}));
app.post('/api/admin/quotes/:id/void', requireAdmin, asyncHandler((req, res) => {
  res.json(voidQuote(Number(req.params.id)));
}));
app.post('/api/admin/quotes/:id/deal', requireAdmin, asyncHandler((req, res) => {
  res.json(setDealStatus(Number(req.params.id), req.body?.deal_status ?? null));
}));

// --- Public: 報價單（只認 32-hex 亂數 token，不可列舉）---
app.get('/api/public/quotes/:token', asyncHandler((req, res) => {
  res.json(getQuoteByToken(req.params.token));
}));
```

`settingsPayload()` 的物件尾端加：

```js
    company_name: getSetting('company_name') || '',
    company_tax_id: getSetting('company_tax_id') || '',
    company_phone: getSetting('company_phone') || '',
    company_email: getSetting('company_email') || '',
    company_address: getSetting('company_address') || '',
```

PATCH `/api/admin/settings` 內、`checkin_radius_m` 的 for 迴圈之後、`tx(() => ...)` 之前加：

```js
  // 報價單公司資訊：自由文字、允許空字串（未設定時公開頁該欄不顯示）
  for (const key of ['company_name', 'company_tax_id', 'company_phone', 'company_email', 'company_address']) {
    if (b[key] !== undefined) writes.push([key, String(b[key]).trim()]);
  }
```

- [ ] **Step 2: 寫 tests/quote-api.test.js**

```js
// 報價單 API：admin CRUD/void/deal、公開 token 端點、company settings、權限守門。
// 慣例：對跑著的 dev server（BASE）打 fetch；X-Forwarded-For 假 IP 避開共用限流。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[quote-api test] start');

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入成功', () => assert.ok(token));

const body = {
  customer_title: 'QT-API測試有限公司', customer_tax_id: '87654321',
  quote_date: '2026-08-14', valid_until: '2026-09-13',
  payment_terms: '月結 30 天',
  items: [{ name: '企業包班', spec: '8 週', qty: 8, unit: '週', unit_price: 5000 }],
};

// ── 權限守門 ──
{
  const r = await req('GET', '/api/admin/quotes');
  expect('未登入 GET /api/admin/quotes → 401', () => assert.equal(r.status, 401));
  const r2 = await req('POST', '/api/admin/quotes', { body, token: 'bogus-token' });
  expect('假 token POST → 401', () => assert.equal(r2.status, 401));
}

// ── CRUD ──
const c = await req('POST', '/api/admin/quotes', { body, token });
expect('POST 建立 → 201、單號/token/金額', () => {
  assert.equal(c.status, 201);
  assert.match(c.data.quote_no, /^CU\d{4}-\d{4}$/);
  assert.match(c.data.token, /^[0-9a-f]{32}$/);
  assert.equal(c.data.subtotal, 40000);
  assert.equal(c.data.tax, 2000);
  assert.equal(c.data.total, 42000);
});
const qid = c.data.id, qtoken = c.data.token;

const bad = await req('POST', '/api/admin/quotes', { body: { ...body, customer_title: '' }, token });
expect('缺抬頭 → 400 missing_customer_title', () => {
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'missing_customer_title');
});

const list = await req('GET', '/api/admin/quotes', { token });
expect('GET 列表含新單', () => {
  assert.equal(list.status, 200);
  assert.ok(list.data.some((q) => q.id === qid));
});

const one = await req('GET', `/api/admin/quotes/${qid}`, { token });
expect('GET 單筆含 items', () => {
  assert.equal(one.status, 200);
  assert.equal(one.data.items.length, 1);
});

const put = await req('PUT', `/api/admin/quotes/${qid}`, {
  body: { ...body, items: [{ name: '企業包班', qty: 10, unit: '週', unit_price: 5000 }] }, token });
expect('PUT 更新 → 金額重算', () => {
  assert.equal(put.status, 200);
  assert.equal(put.data.subtotal, 50000);
  assert.equal(put.data.total, 52500);
});

const deal = await req('POST', `/api/admin/quotes/${qid}/deal`, { body: { deal_status: 'won' }, token });
expect('POST deal won → 寫入', () => { assert.equal(deal.status, 200); assert.equal(deal.data.deal_status, 'won'); });
const dealBad = await req('POST', `/api/admin/quotes/${qid}/deal`, { body: { deal_status: 'maybe' }, token });
expect('deal 非法值 → 400', () => assert.equal(dealBad.status, 400));

// ── 公開端點 ──
const pub = await req('GET', `/api/public/quotes/${qtoken}`);
expect('公開端點：200、含 company、不洩漏內部欄位', () => {
  assert.equal(pub.status, 200);
  assert.equal(pub.data.quote_no, c.data.quote_no);
  assert.ok('name' in pub.data.company);
  assert.ok(!('deal_status' in pub.data));
  assert.ok(!('id' in pub.data));
  assert.ok(!('token' in pub.data));
});
const pub404 = await req('GET', '/api/public/quotes/deadbeefdeadbeefdeadbeefdeadbeef');
expect('假 token → 404', () => assert.equal(pub404.status, 404));

// ── 作廢 ──
const v = await req('POST', `/api/admin/quotes/${qid}/void`, { token });
expect('作廢 → voided_at', () => { assert.equal(v.status, 200); assert.ok(v.data.voided_at); });
const putVoided = await req('PUT', `/api/admin/quotes/${qid}`, { body, token });
expect('作廢後 PUT → 409', () => assert.equal(putVoided.status, 409));

// ── company settings ──
const s0 = await req('GET', '/api/admin/settings', { token });
expect('settings 含 company 五鍵', () => {
  assert.equal(s0.status, 200);
  for (const k of ['company_name', 'company_tax_id', 'company_phone', 'company_email', 'company_address']) {
    assert.equal(typeof s0.data[k], 'string');
  }
});
const origTax = s0.data.company_tax_id;
const sp = await req('PATCH', '/api/admin/settings', { body: { company_tax_id: '12345678' }, token });
expect('PATCH company_tax_id 寫入', () => { assert.equal(sp.status, 200); assert.equal(sp.data.company_tax_id, '12345678'); });
await req('PATCH', '/api/admin/settings', { body: { company_tax_id: origTax }, token });  // 還原

console.log('[quote-api test] done');
```

- [ ] **Step 3: 起 server、跑測試（先紅）**

```bash
cd ~/projects/chinup-fitness-system
node --env-file-if-exists=.env src/server.js &   # 若 dev server 已在跑則跳過
sleep 1
node tests/quote-api.test.js
```

第一次跑（server.js 未改前）預期 `POST /api/admin/quotes → 404` 類 FAIL；改完 server.js 後**重啟 server** 再跑，預期全 `✓`。若 admin 登入失敗，先 `npm run seed` 再重啟 server。測試結束 `kill %1`（若是本步驟起的）。

- [ ] **Step 4: package.json test:api 鏈尾加 `&& node tests/quote-api.test.js`**

- [ ] **Step 5: Commit**

```bash
git add src/server.js tests/quote-api.test.js package.json
git commit -m "報價單 API：admin 六端點＋公開 token 端點＋company settings 五鍵

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 公開頁 public/quote.html（A4 版面一套三用）＋ /q/:token 路由

**Files:**
- Create: `public/quote.html`
- Modify: `src/server.js` — `/line-bind` 路由（`app.get('/line-bind', ...)`）之後、`app.use(express.static(...))` 之前加頁面路由
- Test: `tests/quote-api.test.js`（檔尾 done 行之前補一條頁面路由測試）

**Interfaces:**
- Consumes: `GET /api/public/quotes/:token`（Task 3 合約）、`/logo.png`（public 既有）
- Produces: `/q/<token>` 頁面——客戶檢視、`window.print()` 列印/另存 PDF 共用同一版面

- [ ] **Step 1: server.js 加頁面路由**

```js
app.get('/q/:token', (req, res) =>
  res.sendFile(resolve(__dirname, '../public/quote.html'))
);
```

- [ ] **Step 2: 建 public/quote.html（完整檔案）**

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>報價單 - CHINUP Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  /* 正式文件白紙風：不引 facade.css（sky 場地）；sheet 內必設 color 墨色。 */
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --ink:#0f172a; --ink-mute:#64748b; --line:#e2e8f0; --sky:#0284c7; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:"Noto Sans TC","Helvetica Neue",sans-serif; background:#eef2f6; color:var(--ink); font-size:14px; line-height:1.6; }
  .mono { font-variant-numeric:tabular-nums; }

  .toolbar { max-width:794px; margin:16px auto 12px; padding:0 8px; display:flex; justify-content:flex-end; }
  .btn-print { font-family:"Archivo","Noto Sans TC",sans-serif; font-weight:800; font-size:13px; letter-spacing:.08em;
    background:var(--sky); color:#fff; border:0; border-radius:0; padding:10px 18px; cursor:pointer; }
  .btn-print:hover { filter:brightness(1.08); }

  .paper { background:#fff; color:var(--ink); max-width:794px; margin:0 auto 48px; padding:44px 48px 40px;
    box-shadow:0 2px 18px rgba(15,23,42,.10); }

  /* 狀態橫幅屬於內容：失效/作廢時列印也照印（防過期單被拿去簽）。 */
  .status-banner { padding:10px 14px; font-weight:700; margin-bottom:20px; border-left:4px solid; }
  .status-banner.expired { background:#fff7ed; border-color:#ea580c; color:#9a3412; }
  .status-banner.voided { background:#fef2f2; border-color:#dc2626; color:#991b1b; }

  .q-head { display:flex; justify-content:space-between; gap:24px; padding-bottom:18px; border-bottom:2px solid var(--ink); }
  .q-co { display:flex; gap:14px; align-items:flex-start; min-width:0; }
  .q-logo { width:56px; height:56px; object-fit:contain; }
  .q-co-name { font-family:"Archivo","Noto Sans TC",sans-serif; font-weight:900; font-size:20px; letter-spacing:.02em; }
  .q-co-meta { font-size:12px; color:var(--ink-mute); margin-top:4px; white-space:pre-line; }
  .q-doc { text-align:right; flex-shrink:0; }
  .q-doc-title { font-family:"Archivo","Noto Sans TC",sans-serif; font-weight:900; font-size:26px; letter-spacing:.18em; }
  .q-doc-en { font-family:"Archivo",sans-serif; font-weight:700; font-size:11px; letter-spacing:.32em; color:var(--sky); margin-top:2px; }
  .q-doc-meta { margin-top:10px; font-size:12.5px; margin-left:auto; }
  .q-doc-meta td { padding:1px 0 1px 16px; text-align:right; }
  .q-doc-meta td:first-child { color:var(--ink-mute); }
  .q-doc-meta td:last-child { font-weight:700; font-variant-numeric:tabular-nums; }

  .q-customer { display:flex; gap:28px; flex-wrap:wrap; padding:14px 0; border-bottom:1px solid var(--line); font-size:13.5px; }
  .q-customer .lbl { display:block; font-family:"Archivo","Noto Sans TC",sans-serif; font-size:10.5px; font-weight:800; letter-spacing:.14em; color:var(--ink-mute); }
  .q-customer .val { font-weight:700; }

  .items-wrap { margin-top:18px; }
  table.items { width:100%; border-collapse:collapse; font-size:13.5px; }
  .items th { font-family:"Archivo","Noto Sans TC",sans-serif; font-size:11px; letter-spacing:.12em;
    color:var(--ink-mute); text-align:left; padding:8px; border-bottom:1.5px solid var(--ink); white-space:nowrap; }
  .items th.num, .items td.num { text-align:right; }
  .items td { padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  .items td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .items .i-name { font-weight:700; }
  .items .i-spec { font-size:12px; color:var(--ink-mute); margin-top:2px; }

  .totals { display:flex; justify-content:flex-end; margin-top:12px; }
  .totals table { font-size:13.5px; border-collapse:collapse; min-width:260px; }
  .totals td { padding:5px 0 5px 24px; text-align:right; font-variant-numeric:tabular-nums; }
  .totals td:first-child { color:var(--ink-mute); text-align:left; padding-left:0; }
  .totals tr.grand td { border-top:2px solid var(--ink); padding-top:9px;
    font-family:"Archivo","Noto Sans TC",sans-serif; font-weight:900; font-size:17px; }
  .totals tr.grand td:first-child { font-size:13px; letter-spacing:.06em; }

  .terms { margin-top:26px; font-size:13px; }
  .terms dl { display:grid; grid-template-columns:88px 1fr; row-gap:7px; }
  .terms dt { color:var(--ink-mute); font-weight:700; }
  .terms dd { white-space:pre-line; }

  .sign { display:flex; gap:28px; margin-top:44px; }
  .sign-box { flex:1; }
  .sign-label { font-family:"Archivo","Noto Sans TC",sans-serif; font-size:11px; font-weight:800; letter-spacing:.16em; color:var(--ink-mute); margin-bottom:6px; }
  .sign-area { height:110px; border:1px solid var(--line); }
  .sign-date { font-size:12px; color:var(--ink-mute); margin-top:8px; }

  .not-found { max-width:480px; margin:80px auto; text-align:center; color:var(--ink-mute); padding:0 20px; }
  .not-found h1 { font-family:"Archivo","Noto Sans TC",sans-serif; font-size:20px; color:var(--ink); margin-bottom:8px; }

  @media (max-width:640px) {
    .paper { padding:24px 16px; margin-bottom:24px; }
    .q-head { flex-direction:column; }
    .q-doc { text-align:left; }
    .q-doc-meta { margin-left:0; }
    .q-doc-meta td { padding-left:0; padding-right:16px; text-align:left; }
    .items-wrap { overflow-x:auto; }
    table.items { min-width:560px; }
    .sign { flex-direction:column; }
  }
  @media print {
    body { background:#fff; }
    .toolbar { display:none; }
    .paper { box-shadow:none; max-width:none; margin:0; padding:0; }
  }
  @page { size:A4; margin:14mm 12mm; }
</style>
</head>
<body>
<div class="toolbar"><button class="btn-print" onclick="window.print()">列印／另存 PDF</button></div>

<main class="paper" id="paper" hidden>
  <div id="banner"></div>
  <header class="q-head">
    <div class="q-co">
      <img src="/logo.png" alt="" class="q-logo" onerror="this.remove()">
      <div>
        <div class="q-co-name" id="co-name"></div>
        <div class="q-co-meta" id="co-meta"></div>
      </div>
    </div>
    <div class="q-doc">
      <div class="q-doc-title">報價單</div>
      <div class="q-doc-en">QUOTATION</div>
      <table class="q-doc-meta">
        <tr><td>單號</td><td id="q-no"></td></tr>
        <tr><td>報價日期</td><td id="q-date"></td></tr>
        <tr><td>有效期限</td><td id="q-valid"></td></tr>
      </table>
    </div>
  </header>

  <section class="q-customer">
    <div><span class="lbl">客戶抬頭 TO</span><span class="val" id="cust-title"></span></div>
    <div id="cust-taxid-w"><span class="lbl">統一編號</span><span class="val" id="cust-taxid"></span></div>
    <div id="cust-contact-w"><span class="lbl">聯絡窗口</span><span class="val" id="cust-contact"></span></div>
  </section>

  <div class="items-wrap">
    <table class="items">
      <thead><tr>
        <th class="num" style="width:34px;">#</th><th>品名及規格</th>
        <th class="num" style="width:64px;">數量</th><th style="width:56px;">單位</th>
        <th class="num" style="width:112px;">單價（未稅）</th><th class="num" style="width:112px;">小計</th>
      </tr></thead>
      <tbody id="items-body"></tbody>
    </table>
  </div>

  <div class="totals">
    <table>
      <tr><td>合計（未稅）</td><td id="t-subtotal"></td></tr>
      <tr><td>營業稅 5%</td><td id="t-tax"></td></tr>
      <tr class="grand"><td>含稅總計</td><td id="t-total"></td></tr>
    </table>
  </div>

  <section class="terms" id="terms-sec"><dl id="terms-dl"></dl></section>

  <footer class="sign">
    <div class="sign-box"><div class="sign-label">報價方簽章 QUOTED BY</div><div class="sign-area"></div><div class="sign-date">日期：</div></div>
    <div class="sign-box"><div class="sign-label">客戶確認簽章 CONFIRMED BY</div><div class="sign-area"></div><div class="sign-date">日期：</div></div>
  </footer>
</main>

<div class="not-found" id="notfound" hidden>
  <h1>找不到報價單</h1>
  <p>連結可能有誤或已被移除，請與 CHINUP Performance 聯繫。</p>
</div>

<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const money = (n) => 'NT$ ' + Number(n).toLocaleString('en-US');
const token = location.pathname.split('/').pop();

(async () => {
  let q;
  try {
    const res = await fetch(`/api/public/quotes/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error();
    q = await res.json();
  } catch { document.getElementById('notfound').hidden = false; return; }

  const co = q.company || {};
  document.title = `報價單 ${q.quote_no}${co.name ? ' - ' + co.name : ''}`;

  const banner = document.getElementById('banner');
  if (q.voided) banner.innerHTML = '<div class="status-banner voided">此報價單已作廢，僅供留存參考。</div>';
  else if (q.expired) banner.innerHTML = `<div class="status-banner expired">此報價單已於 ${esc(q.valid_until)} 失效，如需重新報價請與我們聯繫。</div>`;

  document.getElementById('co-name').textContent = co.name || 'CHINUP Performance';
  document.getElementById('co-meta').textContent = [
    co.tax_id ? `統一編號 ${co.tax_id}` : '',
    [co.phone, co.email].filter(Boolean).join('　'),
    co.address || '',
  ].filter(Boolean).join('\n');
  document.getElementById('q-no').textContent = q.quote_no;
  document.getElementById('q-date').textContent = q.quote_date;
  document.getElementById('q-valid').textContent = q.valid_until;

  document.getElementById('cust-title').textContent = q.customer_title;
  const setOrHide = (wrapId, valId, v) => {
    if (v) document.getElementById(valId).textContent = v;
    else document.getElementById(wrapId).hidden = true;
  };
  setOrHide('cust-taxid-w', 'cust-taxid', q.customer_tax_id);
  setOrHide('cust-contact-w', 'cust-contact', [q.contact_name, q.contact_phone].filter(Boolean).join('　'));

  document.getElementById('items-body').innerHTML = q.items.map((it, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td><div class="i-name">${esc(it.name)}</div>${it.spec ? `<div class="i-spec">${esc(it.spec)}</div>` : ''}</td>
      <td class="num">${esc(String(Number(it.qty)))}</td>
      <td>${esc(it.unit || '')}</td>
      <td class="num">${money(it.unit_price)}</td>
      <td class="num">${money(it.amount)}</td>
    </tr>`).join('');

  document.getElementById('t-subtotal').textContent = money(q.subtotal);
  document.getElementById('t-tax').textContent = money(q.tax);
  document.getElementById('t-total').textContent = money(q.total);

  const terms = [['付款條件', q.payment_terms], ['交貨期', q.delivery_terms], ['備註', q.notes]].filter(([, v]) => v);
  if (terms.length) document.getElementById('terms-dl').innerHTML = terms.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  else document.getElementById('terms-sec').hidden = true;

  document.getElementById('paper').hidden = false;
})();
</script>
</body>
</html>
```

- [ ] **Step 3: quote-api.test.js 補頁面路由測試（done 行之前）**

```js
// ── /q/:token 頁面路由（sendFile quote.html；token 對錯都出同一頁，由前端 fetch 判 404）──
{
  const res = await fetch(`${BASE}/q/${qtoken}`, { headers: { 'X-Forwarded-For': '10.99.7.1' } });
  const html = await res.text();
  expect('GET /q/:token → 200 且為報價單頁', () => {
    assert.equal(res.status, 200);
    assert.ok(html.includes('QUOTATION'));
  });
}
```

- [ ] **Step 4: 重啟 server、跑 API 測試確認 pass**

```bash
kill %1 2>/dev/null; node --env-file-if-exists=.env src/server.js &
sleep 1
node tests/quote-api.test.js
```
Expected: 全部 `✓`（含新頁面路由測項）

- [ ] **Step 5: 人工版面驗證（AI 瀏覽器或業主手動）**

1. 用 Task 3 測試建的單（或 curl 再建一張）取得 token，開 `http://localhost:3000/q/<token>`。
2. 檢查：抬頭（logo＋公司名）、右上 QUOTATION＋單號三行、客戶區、明細（品名粗/規格小字、金額靠右 tabular）、合計→稅→含稅總計粗大、條款、雙簽章框。
3. Cmd+P 列印預覽：工具列消失、白底、單頁 A4 合理分佈。
4. 手機寬度（DevTools 375px）：明細表橫向捲動、簽章框直排。
5. 作廢/過期單各開一張看橫幅（作廢紅、過期橙），列印預覽確認橫幅照印。
6. **未實地點開＝未驗證**（白字回歸教訓）——此步不可跳過。

- [ ] **Step 6: Commit**

```bash
git add public/quote.html src/server.js tests/quote-api.test.js
git commit -m "公開報價頁 /q/:token：A4 版面一套三用（檢視/列印/PDF）＋狀態橫幅

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 後台「報價單」頁籤（列表/搜尋/drawer 建編/列動作）

**Files:**
- Modify: `public/admin.html` — ① `#admin-tabs` 內 `data-atab="payroll"` 按鈕之後加頁籤按鈕；② `#apanel-payroll` 的 `</div>`（該 panel 結尾）之後加 panel
- Modify: `public/admin.js` — quotes 區塊（放檔尾頁籤切換代碼之前）；開機載入區（`loadPayroll();` 那行之後）加 `loadQuotes();`

**Interfaces:**
- Consumes: Task 3 的 API 合約；既有 `api/toast/escapeHtml`（app.js）、`limitSlice/moreButtonHtml/bindLoadMore`、`ICO`、`#drawer`（`display:'block'` 開、`#close-drawer` 既有 ✕ listener 關）
- Produces: 無（終端 UI）

- [ ] **Step 1: admin.html 加頁籤按鈕＋panel**

`data-atab="payroll"` 按鈕行之後：

```html
    <button data-atab="quotes" class="tab" style="white-space:nowrap;">報價單</button>
```

`#apanel-payroll` panel 結束的 `</div>` 之後（與其他 panel 同層）：

```html
  <div id="apanel-quotes" class="tab-panel hidden">
    <section class="mb-8">
      <div class="a-sec-head">
        <h2 class="section-title">報價單</h2>
        <input id="quote-search" type="search" class="form-input" style="max-width:220px;" placeholder="搜尋單號／客戶">
        <div style="flex:1;"></div>
        <button id="quote-new" class="btn btn-primary btn-sm">＋ 新增報價單</button>
      </div>
      <div id="quotes-list"></div>
    </section>
  </div>
```

- [ ] **Step 2: admin.js 加 quotes 區塊**

```js
// ===== 報價單 =====
let quotesCache = [];
const QUOTE_DEAL_LABEL = { won: '已成交', lost: '未成交' };

function localTodayStr() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function quoteStatus(q) {
  if (q.voided_at) return { label: '已作廢', badge: 'cancelled' };
  if (q.valid_until < localTodayStr()) return { label: '已過期', badge: 'completed' };
  return { label: '有效', badge: 'confirmed' };
}

async function loadQuotes() {
  try { quotesCache = await api('/api/admin/quotes'); renderQuotes(); }
  catch (e) { toast(`載入報價單失敗：${e.message}`, 'error'); }
}

function renderQuotes() {
  const container = document.getElementById('quotes-list');
  const kw = (document.getElementById('quote-search')?.value || '').trim().toLowerCase();
  const rows = kw
    ? quotesCache.filter((q) => q.quote_no.toLowerCase().includes(kw) || q.customer_title.toLowerCase().includes(kw))
    : quotesCache;
  if (!rows.length) {
    container.innerHTML = `
      <div class="empty-state">
        ${ICO.cash.replace('nk-ico', 'nk-empty-ico')}
        <p>${kw ? '沒有符合的報價單' : '尚無報價單'}</p>
        <p class="subtle text-sm">${kw ? '換個關鍵字試試' : '點「＋ 新增報價單」開第一張'}</p>
      </div>`;
    return;
  }
  const { visible, rest } = limitSlice('quotes', rows);
  container.innerHTML = visible.map((q) => {
    const st = quoteStatus(q);
    return `
    <article class="a-row">
      <div class="a-row-main">
        <div class="a-row-title">
          <h3 class="card-title" style="font-family:'Archivo','Noto Sans TC',sans-serif;">${escapeHtml(q.quote_no)}</h3>
          <span class="badge badge-${st.badge}">${st.label}</span>
          ${q.deal_status ? `<span class="badge badge-${q.deal_status === 'won' ? 'confirmed' : 'cancelled'}">${QUOTE_DEAL_LABEL[q.deal_status]}</span>` : ''}
        </div>
        <div class="a-row-sub">
          <div class="meta">
            <span class="meta-item">${escapeHtml(q.customer_title)}</span>
            <span class="meta-item">${ICO.cash} NT$ ${Number(q.total).toLocaleString()}</span>
            <span class="meta-item">${ICO.calendar} ${q.quote_date}</span>
            <span class="meta-item">效期至 ${q.valid_until}</span>
          </div>
        </div>
      </div>
      <div class="a-row-actions">
        <button class="btn btn-dark btn-sm" data-qact="preview" data-qid="${q.id}">預覽</button>
        <button class="btn btn-ghost btn-sm" data-qact="copylink" data-qid="${q.id}">複製連結</button>
        ${q.voided_at ? '' : `
        <button class="btn btn-ghost btn-sm" data-qact="edit" data-qid="${q.id}">編輯</button>
        <button class="btn btn-ghost btn-sm" data-qact="deal-won" data-qid="${q.id}">${q.deal_status === 'won' ? '取消成交標記' : '標記成交'}</button>
        <button class="btn btn-ghost btn-sm" data-qact="deal-lost" data-qid="${q.id}">${q.deal_status === 'lost' ? '取消未成交標記' : '標記未成交'}</button>`}
        <button class="btn btn-ghost btn-sm" data-qact="duplicate" data-qid="${q.id}">複製新單</button>
        ${q.voided_at ? '' : `<button class="btn btn-danger btn-sm" data-qact="void" data-qid="${q.id}">作廢</button>`}
      </div>
    </article>`;
  }).join('') + moreButtonHtml('quotes', rest);
  bindLoadMore(container, () => renderQuotes());
  container.querySelectorAll('[data-qact]').forEach((b) =>
    b.addEventListener('click', () => onQuoteAction(b.dataset.qact, Number(b.dataset.qid))));
}

async function onQuoteAction(act, id) {
  const q = quotesCache.find((x) => x.id === id);
  if (!q) return;
  if (act === 'preview') { window.open(`/q/${q.token}`, '_blank'); return; }
  if (act === 'copylink') {
    const url = `${location.origin}/q/${q.token}`;
    try { await navigator.clipboard.writeText(url); toast('連結已複製', 'success'); }
    catch { prompt('複製連結', url); }
    return;
  }
  if (act === 'edit' || act === 'duplicate') {
    try {
      const full = await api(`/api/admin/quotes/${id}`);
      openQuoteDrawer(act === 'edit' ? 'edit' : 'create', full);
    } catch (e) { toast(`載入失敗：${e.message}`, 'error'); }
    return;
  }
  if (act === 'void') {
    if (!confirm(`作廢 ${q.quote_no}？作廢後不可編輯，公開頁會顯示「已作廢」。`)) return;
    try { await api(`/api/admin/quotes/${id}/void`, { method: 'POST' }); toast('已作廢', 'success'); loadQuotes(); }
    catch (e) { toast(`作廢失敗：${e.message}`, 'error'); }
    return;
  }
  if (act === 'deal-won' || act === 'deal-lost') {
    const target = act === 'deal-won' ? 'won' : 'lost';
    const next = q.deal_status === target ? null : target;   // 再點一次＝清除標記
    try { await api(`/api/admin/quotes/${id}/deal`, { method: 'POST', body: { deal_status: next } }); loadQuotes(); }
    catch (e) { toast(`標記失敗：${e.message}`, 'error'); }
  }
}

// 建單/編輯 drawer：mode 'create'（可帶入來源單＝複製新單，日期重設）| 'edit'（帶原單含日期）
function openQuoteDrawer(mode, quote) {
  const isEdit = mode === 'edit';
  const q = quote || null;
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const d30 = new Date(now.getTime() + 30 * 86400000);
  const plus30Str = `${d30.getFullYear()}-${p(d30.getMonth() + 1)}-${p(d30.getDate())}`;
  const qd = isEdit ? q.quote_date : todayStr;
  const vu = isEdit ? q.valid_until : plus30Str;

  document.getElementById('drawer-title').textContent = isEdit ? `編輯 ${q.quote_no}` : '新增報價單';
  document.getElementById('drawer-content').innerHTML = `
    <div class="mb-3"><label class="form-label">客戶抬頭 *</label>
      <input id="qd-title" class="form-input" style="width:100%;" value="${q ? escapeHtml(q.customer_title) : ''}"></div>
    <div class="flex gap-3 flex-wrap mb-3">
      <div><label class="form-label">客戶統編</label><input id="qd-taxid" class="form-input" value="${q ? escapeHtml(q.customer_tax_id || '') : ''}"></div>
      <div><label class="form-label">聯絡人</label><input id="qd-contact" class="form-input" value="${q ? escapeHtml(q.contact_name || '') : ''}"></div>
      <div><label class="form-label">電話</label><input id="qd-phone" class="form-input" value="${q ? escapeHtml(q.contact_phone || '') : ''}"></div>
    </div>
    <div class="mb-2"><label class="form-label">品項 *（品名／規格／數量／單位／未稅單價）</label>
      <div id="qd-items"></div>
      <button type="button" id="qd-add-item" class="btn btn-ghost btn-sm">＋ 加一列</button></div>
    <div class="flex gap-3 flex-wrap mb-3">
      <div><label class="form-label">報價日期</label><input id="qd-date" type="date" class="form-input" value="${qd}"></div>
      <div><label class="form-label">有效期限</label><input id="qd-valid" type="date" class="form-input" value="${vu}"></div>
    </div>
    <div class="mb-3"><label class="form-label">付款條件</label>
      <input id="qd-payment" class="form-input" style="width:100%;" placeholder="例：簽約後 7 日內電匯 50%，課程結束付清尾款" value="${q ? escapeHtml(q.payment_terms || '') : ''}"></div>
    <div class="mb-3"><label class="form-label">交貨期</label>
      <input id="qd-delivery" class="form-input" style="width:100%;" placeholder="例：雙方確認後 14 日內開課" value="${q ? escapeHtml(q.delivery_terms || '') : ''}"></div>
    <div class="mb-3"><label class="form-label">備註</label>
      <textarea id="qd-notes" class="form-input" style="width:100%;" rows="2">${q ? escapeHtml(q.notes || '') : ''}</textarea></div>
    <div class="flex items-center gap-4 flex-wrap mb-3" id="qd-totals" style="font-variant-numeric:tabular-nums;"></div>
    <button id="qd-save" class="btn btn-primary">${isEdit ? '儲存變更' : '建立報價單'}</button>`;

  const itemsBox = document.getElementById('qd-items');
  function recalc() {
    let subtotal = 0;
    itemsBox.querySelectorAll('.qd-item-row').forEach((row) => {
      const qty = Number(row.querySelector('.qd-i-qty').value);
      const price = Number(row.querySelector('.qd-i-price').value);
      const ok = Number.isFinite(qty) && qty > 0 && Number.isInteger(price) && price >= 0;
      const amount = ok ? Math.round(qty * price) : 0;
      row.querySelector('.qd-i-amount').textContent = ok ? `NT$ ${amount.toLocaleString()}` : '—';
      subtotal += amount;
    });
    const tax = Math.round(subtotal * 0.05);
    document.getElementById('qd-totals').innerHTML =
      `<span class="subtle">合計（未稅）NT$ ${subtotal.toLocaleString()}</span>
       <span class="subtle">營業稅 5% NT$ ${tax.toLocaleString()}</span>
       <span style="font-family:'Archivo','Noto Sans TC',sans-serif;font-weight:800;">含稅總計 NT$ ${(subtotal + tax).toLocaleString()}</span>`;
  }
  function addRow(it) {
    const row = document.createElement('div');
    row.className = 'qd-item-row flex gap-2 flex-wrap mb-2';
    row.innerHTML = `
      <input class="form-input qd-i-name" placeholder="品名 *" style="flex:2;min-width:130px;" value="${it ? escapeHtml(it.name) : ''}">
      <input class="form-input qd-i-spec" placeholder="規格" style="flex:2;min-width:110px;" value="${it ? escapeHtml(it.spec || '') : ''}">
      <input class="form-input qd-i-qty" type="number" min="0" step="0.5" placeholder="數量" style="width:80px;" value="${it ? it.qty : 1}">
      <input class="form-input qd-i-unit" placeholder="單位" style="width:70px;" value="${it ? escapeHtml(it.unit || '') : ''}">
      <input class="form-input qd-i-price" type="number" min="0" step="1" placeholder="單價(未稅)" style="width:110px;" value="${it != null && it.unit_price != null ? it.unit_price : ''}">
      <span class="qd-i-amount subtle" style="align-self:center;min-width:90px;text-align:right;"></span>
      <button type="button" class="btn btn-ghost btn-sm qd-i-del">✕</button>`;
    row.querySelector('.qd-i-del').addEventListener('click', () => { row.remove(); recalc(); });
    row.querySelectorAll('input').forEach((el) => el.addEventListener('input', recalc));
    itemsBox.appendChild(row);
  }
  (q?.items?.length ? q.items : [null]).forEach(addRow);
  recalc();
  document.getElementById('qd-add-item').addEventListener('click', () => addRow(null));

  document.getElementById('qd-save').addEventListener('click', async () => {
    const body = {
      customer_title: document.getElementById('qd-title').value.trim(),
      customer_tax_id: document.getElementById('qd-taxid').value.trim(),
      contact_name: document.getElementById('qd-contact').value.trim(),
      contact_phone: document.getElementById('qd-phone').value.trim(),
      quote_date: document.getElementById('qd-date').value,
      valid_until: document.getElementById('qd-valid').value,
      payment_terms: document.getElementById('qd-payment').value.trim(),
      delivery_terms: document.getElementById('qd-delivery').value.trim(),
      notes: document.getElementById('qd-notes').value.trim(),
      items: [...itemsBox.querySelectorAll('.qd-item-row')].map((row) => ({
        name: row.querySelector('.qd-i-name').value.trim(),
        spec: row.querySelector('.qd-i-spec').value.trim(),
        qty: Number(row.querySelector('.qd-i-qty').value),
        unit: row.querySelector('.qd-i-unit').value.trim(),
        unit_price: Number(row.querySelector('.qd-i-price').value),
      })),
    };
    try {
      if (isEdit) await api(`/api/admin/quotes/${q.id}`, { method: 'PUT', body });
      else await api('/api/admin/quotes', { method: 'POST', body });
      toast(isEdit ? '報價單已更新' : '報價單已建立', 'success');
      document.getElementById('drawer').style.display = 'none';
      loadQuotes();
    } catch (e) { toast(`儲存失敗：${e.message}`, 'error'); }
  });

  document.getElementById('drawer').style.display = 'block';
}

document.getElementById('quote-new').addEventListener('click', () => openQuoteDrawer('create'));
document.getElementById('quote-search').addEventListener('input', () => { _shownMap.delete('quotes'); renderQuotes(); });
```

開機載入區：`loadPayroll();` 那行之後加一行 `loadQuotes();`。

- [ ] **Step 3: 手動 smoke（起 server、admin 登入後台）**

1. 後台出現第 9 個頁籤「報價單」，非管理者教練登入看不到內容（頁籤切過去 API 403 → toast）。
2. 建單：填客戶＋兩列品項（其中一列 qty 1.5）→ 底部即時金額正確 → 建立成功、列表出現、單號 `CU2026-XXXX`。
3. 編輯：改品項 → 金額重算；單號/連結不變。
4. 預覽開 `/q/<token>`；複製連結貼出正確網址。
5. 複製新單：帶入全部欄位、日期重設為今天/＋30、儲存後產生新單號新連結。
6. 標記成交 → badge 出現；再點一次 → 清除。標記未成交同理。
7. 作廢：confirm → 列表變「已作廢」、編輯/成交/作廢鈕消失；公開頁出現紅色作廢橫幅。
8. 搜尋單號/客戶即時過濾；建 21+ 張時「載入更多」出現（可略過此條，機制為既有共用碼）。
9. 手機寬度（375px）列表卡與 drawer 可用。

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "後台報價單頁籤：列表/搜尋/建編 drawer/預覽/複製連結/複製新單/成交/作廢

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 設定 card＋全量驗證＋draft PR

**Files:**
- Modify: `public/admin.html` — 「收款與 LINE 設定」card（`id="save-bank-line"` 按鈕所在 card 的 `</div>`）之後加公司資訊 card
- Modify: `public/admin.js` — ① `loadOneOnOnePrice()` 函式內（`expiryInput` 填值之後）加 company 五欄填值；② save listener（放 `save-bank-line` 相關代碼附近）

**Interfaces:**
- Consumes: Task 3 的 settings API 合約（company 五鍵）
- Produces: 無（終端 UI）

- [ ] **Step 1: admin.html 加設定 card**

```html
    <!-- 報價單公司資訊（公開報價頁 /q/:token 抬頭顯示；未填的欄位不顯示）-->
    <div class="card mb-4">
      <h3 class="card-title mb-3">報價單公司資訊</h3>
      <label class="form-label" for="company-name">公司名稱（報價單抬頭）</label>
      <input id="company-name" type="text" class="form-input mb-3" style="width:100%;" placeholder="CHINUP Performance">
      <label class="form-label" for="company-tax-id">統一編號</label>
      <input id="company-tax-id" type="text" class="form-input mb-3" style="width:100%;" placeholder="12345678">
      <label class="form-label" for="company-phone">電話</label>
      <input id="company-phone" type="text" class="form-input mb-3" style="width:100%;" placeholder="05-1234567">
      <label class="form-label" for="company-email">Email</label>
      <input id="company-email" type="text" class="form-input mb-3" style="width:100%;" placeholder="hello@chinup.tw">
      <label class="form-label" for="company-address">地址</label>
      <input id="company-address" type="text" class="form-input mb-3" style="width:100%;" placeholder="嘉義市○○路○○號">
      <button id="save-company-info" class="btn btn-primary btn-sm">儲存</button>
    </div>
```

- [ ] **Step 2: admin.js 填值＋儲存**

`loadOneOnOnePrice()` 內 `expiryInput` 填值之後加：

```js
    for (const k of ['company_name', 'company_tax_id', 'company_phone', 'company_email', 'company_address']) {
      const el = document.getElementById(k.replaceAll('_', '-'));
      if (el) el.value = r[k] ?? '';
    }
```

save listener（與其他 settings listener 同區）：

```js
document.getElementById('save-company-info')?.addEventListener('click', async () => {
  const body = {};
  for (const k of ['company_name', 'company_tax_id', 'company_phone', 'company_email', 'company_address']) {
    body[k] = (document.getElementById(k.replaceAll('_', '-'))?.value || '').trim();
  }
  try { await api('/api/admin/settings', { method: 'PATCH', body }); toast('公司資訊已儲存', 'success'); }
  catch (e) { toast(`儲存失敗：${e.message}`, 'error'); }
});
```

- [ ] **Step 3: 手動 smoke**

課程頁籤設定區出現「報價單公司資訊」card → 填統編/電話/地址 → 儲存 → 重整保留 → 開任一張 `/q/<token>` 抬頭即時反映。

- [ ] **Step 4: 全量測試＋re-seed**

```bash
npm test                     # 全 service 鏈（含新 quote-service）
node --env-file-if-exists=.env src/server.js &  # test:api 需要跑著的 server
sleep 1
npm run test:api             # 全 API 鏈（含新 quote-api）
kill %1
npm run seed                 # npm test 會洗 demo DB——測完必 re-seed
```
Expected: 兩條鏈全部 `✓`、exit 0。任何 fail 都先修完才可續行。

- [ ] **Step 5: Commit＋push＋draft PR**

```bash
git add public/admin.html public/admin.js
git commit -m "後台設定：報價單公司資訊五欄（名稱/統編/電話/Email/地址）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin quotation-system
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | grep '^password=' | cut -d= -f2)
curl -s -X POST -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -d '{"title":"報價單系統：後台開單管理＋公開 A4 報價頁（列印/PDF/分享連結）","head":"quotation-system","base":"main","draft":true,"body":"Spec: docs/superpowers/specs/2026-08-14-quotation-system-design.md\nPlan: docs/superpowers/plans/2026-08-14-quotation-system.md\n\n- quotes/quote_items 兩張新表（金額存檔凍結、單號 CU<年>-<4位流水>年度重計）\n- admin 六端點＋公開 token 端點＋/q/:token A4 頁（一套版面三用：檢視/列印/存 PDF）\n- 後台第 9 頁籤：列表/搜尋/建編 drawer/預覽/複製連結/複製新單/成交標記/作廢\n- 設定新增報價單公司資訊五欄（app_settings）\n- 測試：quote-service（npm test 鏈）＋ quote-api（test:api 鏈）\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

（依 workflow 慣例：draft PR 開好後停在 manual-smoke gate，等業主實測；**修 review 意見後記得先 push 再 merge**——squash 取 origin HEAD。）

---

## 上線後一次性人工步驟（merge 後提醒業主）

1. 後台 → 課程頁籤設定區「報價單公司資訊」→ 填公司名稱、統一編號、電話、Email、地址。
2. 開一張測試報價單 → 預覽 → 列印預覽確認版面 → 作廢該測試單。
