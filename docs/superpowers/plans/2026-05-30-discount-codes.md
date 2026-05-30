# 折扣碼（Discount Codes）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 持折扣碼的客人在團體課結帳 / 1v1 預約時享百分比或定額折扣；admin 後台可管理折扣碼與全站 1v1 單堂價。

**Architecture:** 新 `discountService`（純驗證 validate 供前端即時預覽；權威套用在下單/預約的 `tx()` 內 + 記 `discount_redemptions`，用量即時 COUNT、取消即刪列釋放）。`group_orders`/`bookings` 加 discount 欄存折後金額。1v1 單堂價存 `app_settings`。前端團體結帳 + 1v1 modal 加折扣碼 UI；admin 加折扣碼管理區。

**Tech Stack:** Node 24 ESM、Express 4、`node:sqlite`（DatabaseSync、同步、寫入包 `tx()`、時間 `nowLocal()`/`offsetLocal()`）、手寫 `node:assert/strict` 測試、零新增 npm 依賴。

**Spec:** `docs/superpowers/specs/2026-05-30-discount-codes-design.md`

**Branch:** `feature/discount-codes`（已建，基於合併後的 main）。

---

## 注意事項（所有 worker 必讀）

- **計畫中的「行號」會過時**：一律用 grep / 讀檔以「內容」定位插入點，勿照行號硬改。
- DB 寫入包 `tx(fn)`（`src/db/connection.js`，`BEGIN IMMEDIATE`，可巢狀）。時間字串用 `nowLocal()`（`'YYYY-MM-DDTHH:MM:SS'` local）。服務層錯誤丟 `ApiError`（`src/services/registration.js`）。不要加 npm 依賴。
- service 測試：`node tests/xxx.test.js`（失敗 `process.exitCode=1`，輸出 ✓/✗）。`reset()` 用 `DELETE` 清自己造的資料（用獨特前綴，如折扣碼 `TESTD%`、電話 `0994%`），跑完不留殘留。
- API 測試需先啟 server（另一 process，spare port，跑完 kill）。
- **重要：service 測試會操作真實 `data/app.db`；跑完 `npm test` 會洗掉 demo 資料**（見 `[[chinup-test-db-shared]]`）。本計畫測試請自清。
- 每個 task 結束 commit（本地，**不 push**；push + PR 在最後人工 gate）。

---

# Phase D — 後端

## Task D1: Schema + Migration

**Files:**
- Modify: `src/db/schema.js`
- Modify: `src/db/connection.js`
- Test: `tests/discount-migration.test.js`

- [ ] **Step 1: 在 `schema.js` 的 `SCHEMA` 字串中新增 3 個表 + seed**

在 `bookings` 表 DDL 之後（用內容定位 `CREATE TABLE IF NOT EXISTS bookings`），加入：

```sql
CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  max_uses INTEGER,
  per_phone_limit INTEGER,
  min_amount INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discount_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES discount_codes(id),
  phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('group_order','booking')),
  ref_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_code ON discount_redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_code_phone ON discount_redemptions(code_id, phone);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('one_on_one_price', '1500');
```

> `db.exec(SCHEMA)` 每次開機跑，`CREATE ... IF NOT EXISTS` 與 `INSERT OR IGNORE` 對既有 DB 也安全（idempotent），故新表/種子不需另寫 migration。

- [ ] **Step 2: `connection.js` 加既有表的欄位 migration**

在既有 `addColumnIfMissing('course_templates', 'price_per_session', ...)` 那行**之後**（用內容定位），加入：

```js
// ── 2026-05-30 discount codes migration ──
addColumnIfMissing('group_orders', 'discount_code', 'TEXT');
addColumnIfMissing('group_orders', 'discount_amount', 'INTEGER');
addColumnIfMissing('group_orders', 'original_amount', 'INTEGER');
addColumnIfMissing('bookings', 'discount_code', 'TEXT');
addColumnIfMissing('bookings', 'discount_amount', 'INTEGER');
addColumnIfMissing('bookings', 'original_amount', 'INTEGER');
```

同時在 `schema.js` 的 `group_orders` 與 `bookings` fresh-create DDL 內補上同樣三欄（`discount_code TEXT, discount_amount INTEGER, original_amount INTEGER`），讓全新 DB 也有。

- [ ] **Step 3: 寫 migration 測試**

`tests/discount-migration.test.js`：建「舊 schema」暫存 DB（group_orders/bookings 無 discount 欄、無 discount_codes 表），設 `DB_PATH` 後 import `connection.js` 觸發 migration，驗證：

```js
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbPath = join(tmpdir(), `discount-mig-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, phone TEXT, password_hash TEXT, google_id TEXT, role TEXT NOT NULL DEFAULT 'user', notification_preference TEXT NOT NULL DEFAULT 'email', line_user_id TEXT, line_bind_code TEXT, line_bind_expires_at TEXT, created_at TEXT);
  CREATE TABLE coaches (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, display_name TEXT, bio TEXT, specialty TEXT, avatar_path TEXT, is_active INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, coach_id INTEGER NOT NULL, member_id INTEGER NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', cancelled_at TEXT, cancelled_by INTEGER, cancel_reason TEXT, note TEXT, created_at TEXT, CHECK (start_at < end_at));
  CREATE TABLE group_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, total_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, paid_at TEXT, paid_by INTEGER, cancelled_at TEXT, created_at TEXT);
  INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, expires_at) VALUES (1,'X','0900000000',500,'2030-01-01T00:00:00');
`);
old.close();
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');

function expect(l, fn){ try{fn();console.log('  ✓ '+l);}catch(e){console.log('  ✗ '+l);console.error(e);process.exitCode=1;} }
const goCols = db.prepare('PRAGMA table_info(group_orders)').all().map(c=>c.name);
expect('group_orders has discount_code', ()=>assert(goCols.includes('discount_code')));
expect('group_orders has original_amount', ()=>assert(goCols.includes('original_amount')));
const bkCols = db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);
expect('bookings has discount_amount', ()=>assert(bkCols.includes('discount_amount')));
expect('discount_codes table exists', ()=>assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discount_codes'").get()));
expect('discount_redemptions exists', ()=>assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discount_redemptions'").get()));
expect('app_settings seeded 1500', ()=>assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='one_on_one_price'").get().value,'1500'));
expect('old order preserved', ()=>assert.equal(db.prepare('SELECT total_amount FROM group_orders WHERE id=1').get().total_amount,500));
console.log('[discount-migration] done');
```

- [ ] **Step 4: 跑測試**　Run: `node tests/discount-migration.test.js` → 全 ✓。
- [ ] **Step 5: 確認既有測試未壞**　Run: `npm test` → 216 ✓（schema 加表/加欄為向後相容）。
- [ ] **Step 6: Commit**
```bash
git add src/db/schema.js src/db/connection.js tests/discount-migration.test.js
git commit -m "feat(db): discount_codes + discount_redemptions + app_settings; order/booking discount columns"
```

---

## Task D2: `discountService` — validate + compute

**Files:**
- Create: `src/services/discountService.js`
- Test: `tests/discount-service.test.js`

- [ ] **Step 1: 寫測試（先失敗）**

`tests/discount-service.test.js`：
```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { normalizeCode, computeDiscount, validateDiscount } from '../src/services/discountService.js';
import { ApiError } from '../src/services/registration.js';

function reset(){ db.exec("DELETE FROM discount_redemptions WHERE phone LIKE '0994%'; DELETE FROM discount_codes WHERE code LIKE 'TESTD%';"); }
function expect(l,fn){ try{fn();console.log('  ✓ '+l);}catch(e){console.log('  ✗ '+l);console.error(e);process.exitCode=1;} }
function mk(fields){ const cols=Object.keys(fields); const qs=cols.map(()=>'?').join(','); db.prepare(`INSERT INTO discount_codes (${cols.join(',')}) VALUES (${qs})`).run(...cols.map(c=>fields[c])); return db.prepare('SELECT id FROM discount_codes WHERE code=?').get(fields.code).id; }

console.log('[discount-service] start'); reset();

expect('normalizeCode trims+uppercases', ()=>assert.equal(normalizeCode('  abc12 '),'ABC12'));
expect('computeDiscount percent floors', ()=>assert.deepEqual(computeDiscount('percent',10,1050),{discountAmount:105,finalTotal:945}));
expect('computeDiscount fixed caps at subtotal', ()=>assert.deepEqual(computeDiscount('fixed',800,500),{discountAmount:500,finalTotal:0}));

mk({code:'TESTD10', discount_type:'percent', discount_value:10, active:1});
expect('validate percent ok', ()=>{ const v=validateDiscount({code:'testd10',phone:'0994000001',subtotal:1000}); assert.equal(v.discountAmount,100); assert.equal(v.finalTotal,900); });
expect('invalid code → 404', ()=>{ try{validateDiscount({code:'NOPE',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.status,404);assert.equal(e.code,'invalid_code');} });

mk({code:'TESTD_OFF', discount_type:'fixed', discount_value:100, active:0});
expect('inactive → 409 code_inactive', ()=>{ try{validateDiscount({code:'TESTD_OFF',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'code_inactive');} });

mk({code:'TESTD_EXP', discount_type:'fixed', discount_value:100, active:1, valid_until:'2000-01-01'});
expect('expired → code_expired', ()=>{ try{validateDiscount({code:'TESTD_EXP',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'code_expired');} });

mk({code:'TESTD_FUT', discount_type:'fixed', discount_value:100, active:1, valid_from:'2999-01-01'});
expect('not started → code_not_started', ()=>{ try{validateDiscount({code:'TESTD_FUT',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'code_not_started');} });

mk({code:'TESTD_MIN', discount_type:'fixed', discount_value:100, active:1, min_amount:2000});
expect('below min → below_min_amount', ()=>{ try{validateDiscount({code:'TESTD_MIN',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'below_min_amount');} });

console.log('[discount-service] D2 done');
```
Run: `node tests/discount-service.test.js` → FAIL（module not found）。

- [ ] **Step 2: 實作 `discountService.js`（validate + compute 部分）**

```js
import { db, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';

export function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

const getCodeStmt = db.prepare('SELECT * FROM discount_codes WHERE code = ?');
const countUsesStmt = db.prepare('SELECT COUNT(*) AS c FROM discount_redemptions WHERE code_id = ?');
const countPhoneUsesStmt = db.prepare('SELECT COUNT(*) AS c FROM discount_redemptions WHERE code_id = ? AND phone = ?');

export function computeDiscount(type, value, subtotal) {
  let discountAmount = type === 'percent' ? Math.floor((subtotal * value) / 100) : Math.min(value, subtotal);
  if (discountAmount < 0) discountAmount = 0;
  return { discountAmount, finalTotal: Math.max(0, subtotal - discountAmount) };
}

function todayLocal() { return nowLocal().slice(0, 10); } // 'YYYY-MM-DD'

/** 純驗證不寫入。丟 ApiError 各錯誤碼。回 { codeId, code, type, value, discountAmount, finalTotal, subtotal }。 */
export function validateDiscount({ code, phone, subtotal }) {
  const norm = normalizeCode(code);
  if (!norm) throw new ApiError(400, 'invalid_code');
  const c = getCodeStmt.get(norm);
  if (!c) throw new ApiError(404, 'invalid_code');
  if (!c.active) throw new ApiError(409, 'code_inactive');
  const today = todayLocal();
  if (c.valid_from && today < c.valid_from) throw new ApiError(409, 'code_not_started');
  if (c.valid_until && today > c.valid_until) throw new ApiError(409, 'code_expired');
  if (c.min_amount != null && subtotal < c.min_amount) throw new ApiError(409, 'below_min_amount', { min_amount: c.min_amount });
  if (c.max_uses != null && countUsesStmt.get(c.id).c >= c.max_uses) throw new ApiError(409, 'code_exhausted');
  if (c.per_phone_limit != null && phone && countPhoneUsesStmt.get(c.id, phone).c >= c.per_phone_limit) {
    throw new ApiError(409, 'per_phone_exhausted');
  }
  const { discountAmount, finalTotal } = computeDiscount(c.discount_type, c.discount_value, subtotal);
  return { codeId: c.id, code: c.code, type: c.discount_type, value: c.discount_value, discountAmount, finalTotal, subtotal };
}
```
（`applyDiscountTx`/`release`/admin/settings 於 D3/D4 追加。）

- [ ] **Step 3: 跑測試**　Run: `node tests/discount-service.test.js` → D2 全 ✓。
- [ ] **Step 4: Commit**
```bash
git add src/services/discountService.js tests/discount-service.test.js
git commit -m "feat(discount): validate + compute (percent/fixed, validity, min, usage caps)"
```

---

## Task D3: `discountService` — apply (tx) + release + usage caps

**Files:**
- Modify: `src/services/discountService.js`
- Modify: `tests/discount-service.test.js`（追加）

- [ ] **Step 1: 追加測試**

在 D2 測試結尾 `console.log('[discount-service] D2 done')` 前（或之後另起）追加：
```js
import { applyDiscountTx, releaseRedemption } from '../src/services/discountService.js';
import { tx } from '../src/db/connection.js';

console.log('[discount-service] D3 start');
const idMax = mk({code:'TESTD_MAX', discount_type:'fixed', discount_value:100, active:1, max_uses:1});
expect('apply records redemption + returns folded', ()=>{
  const r = tx(()=>applyDiscountTx({code:'TESTD_MAX',phone:'0994000010',subtotal:500,kind:'group_order',refId:999001}));
  assert.equal(r.discountAmount,100); assert.equal(r.finalTotal,400); assert.equal(r.discountCode,'TESTD_MAX');
});
expect('max_uses exhausted on 2nd', ()=>{ try{tx(()=>applyDiscountTx({code:'TESTD_MAX',phone:'0994000011',subtotal:500,kind:'group_order',refId:999002}));assert.fail();}catch(e){assert.equal(e.code,'code_exhausted');} });
expect('release frees the use', ()=>{ releaseRedemption({kind:'group_order',refId:999001}); const r=tx(()=>applyDiscountTx({code:'TESTD_MAX',phone:'0994000012',subtotal:500,kind:'group_order',refId:999003})); assert(r.discountAmount===100); releaseRedemption({kind:'group_order',refId:999003}); });

const idPer = mk({code:'TESTD_PER', discount_type:'percent', discount_value:50, active:1, per_phone_limit:1});
expect('per_phone exhausted on same phone 2nd use', ()=>{
  tx(()=>applyDiscountTx({code:'TESTD_PER',phone:'0994000020',subtotal:1000,kind:'booking',refId:999010}));
  try{tx(()=>applyDiscountTx({code:'TESTD_PER',phone:'0994000020',subtotal:1000,kind:'booking',refId:999011}));assert.fail();}catch(e){assert.equal(e.code,'per_phone_exhausted');}
});
expect('different phone still ok', ()=>{ const r=tx(()=>applyDiscountTx({code:'TESTD_PER',phone:'0994000021',subtotal:1000,kind:'booking',refId:999012})); assert.equal(r.discountAmount,500); });
expect('empty code → applyDiscountTx returns null', ()=>{ assert.equal(tx(()=>applyDiscountTx({code:'',phone:'0994000099',subtotal:500,kind:'group_order',refId:999099})),null); });
console.log('[discount-service] D3 done');
```
Run → FAIL（functions missing）。

- [ ] **Step 2: 追加實作**

在 `discountService.js` 追加：
```js
const insertRedemption = db.prepare(
  'INSERT INTO discount_redemptions (code_id, phone, kind, ref_id, amount) VALUES (?, ?, ?, ?, ?)'
);
const deleteRedemption = db.prepare('DELETE FROM discount_redemptions WHERE kind = ? AND ref_id = ?');

/** 在 caller 的 tx() 內呼叫：重新 validate（含用量上限即時 COUNT）→ 記 redemption。
 *  code 為空 → 回 null（不套用）。回 { discountCode, discountAmount, finalTotal, originalAmount }。 */
export function applyDiscountTx({ code, phone, subtotal, kind, refId }) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const v = validateDiscount({ code: norm, phone, subtotal });
  insertRedemption.run(v.codeId, phone, kind, refId, v.discountAmount);
  return { discountCode: v.code, discountAmount: v.discountAmount, finalTotal: v.finalTotal, originalAmount: subtotal };
}

export function releaseRedemption({ kind, refId }) {
  deleteRedemption.run(kind, refId);
}
```

- [ ] **Step 3: 跑測試**　Run: `node tests/discount-service.test.js` → D2+D3 全 ✓。
- [ ] **Step 4: Commit**
```bash
git add src/services/discountService.js tests/discount-service.test.js
git commit -m "feat(discount): applyDiscountTx (atomic usage caps) + releaseRedemption"
```

---

## Task D4: `discountService` — admin CRUD + settings

**Files:**
- Modify: `src/services/discountService.js`
- Modify: `tests/discount-service.test.js`（追加）

- [ ] **Step 1: 追加測試**
```js
import { listDiscountCodes, createDiscountCode, updateDiscountCode, deleteDiscountCode, getSetting, setSetting, getOneOnOnePrice } from '../src/services/discountService.js';

console.log('[discount-service] D4 start');
expect('create + list shows used_count 0', ()=>{ const c=createDiscountCode({code:'testd_new',discount_type:'percent',discount_value:15}); assert.equal(c.code,'TESTD_NEW'); const row=listDiscountCodes().find(x=>x.code==='TESTD_NEW'); assert.equal(row.used_count,0); });
expect('duplicate code → 409 code_exists', ()=>{ try{createDiscountCode({code:'TESTD_NEW',discount_type:'fixed',discount_value:50});assert.fail();}catch(e){assert.equal(e.code,'code_exists');} });
expect('percent value >100 → invalid_value', ()=>{ try{createDiscountCode({code:'TESTD_BAD',discount_type:'percent',discount_value:150});assert.fail();}catch(e){assert.equal(e.code,'invalid_value');} });
expect('update active toggle', ()=>{ const c=createDiscountCode({code:'testd_upd',discount_type:'fixed',discount_value:50}); const u=updateDiscountCode(c.id,{active:0}); assert.equal(u.active,0); });
expect('delete unused ok', ()=>{ const c=createDiscountCode({code:'testd_del',discount_type:'fixed',discount_value:50}); assert.deepEqual(deleteDiscountCode(c.id),{ok:true}); });
expect('delete used → has_redemptions', ()=>{ const c=createDiscountCode({code:'testd_used',discount_type:'fixed',discount_value:50}); tx(()=>applyDiscountTx({code:'TESTD_USED',phone:'0994000030',subtotal:500,kind:'group_order',refId:999030})); try{deleteDiscountCode(c.id);assert.fail();}catch(e){assert.equal(e.code,'has_redemptions');} releaseRedemption({kind:'group_order',refId:999030}); });
expect('settings default 1500', ()=>assert.equal(getOneOnOnePrice(),1500));
expect('settings set/get', ()=>{ setSetting('one_on_one_price','1800'); assert.equal(getOneOnOnePrice(),1800); setSetting('one_on_one_price','1500'); });
console.log('[discount-service] D4 done');
```
Run → FAIL。

- [ ] **Step 2: 追加實作**
```js
export function listDiscountCodes() {
  return db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC, id DESC').all()
    .map((c) => ({ ...c, used_count: countUsesStmt.get(c.id).c }));
}

function validateCodeFields({ discount_type, discount_value, max_uses, per_phone_limit, min_amount }) {
  if (!['percent', 'fixed'].includes(discount_type)) throw new ApiError(400, 'invalid_type');
  const val = Number(discount_value);
  if (!Number.isInteger(val) || val < 1 || (discount_type === 'percent' && val > 100)) throw new ApiError(400, 'invalid_value');
  for (const v of [max_uses, per_phone_limit, min_amount]) {
    if (v != null && v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0)) throw new ApiError(400, 'invalid_limit');
  }
  return val;
}
const nz = (v) => (v == null || v === '' ? null : Number(v));   // nullable int
const nstr = (v) => (v == null || v === '' ? null : String(v)); // nullable string

export function createDiscountCode(f) {
  const code = normalizeCode(f.code);
  if (!code) throw new ApiError(400, 'missing_code');
  const val = validateCodeFields(f);
  if (getCodeStmt.get(code)) throw new ApiError(409, 'code_exists');
  const info = db.prepare(`INSERT INTO discount_codes
    (code, discount_type, discount_value, active, valid_from, valid_until, max_uses, per_phone_limit, min_amount, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      code, f.discount_type, val, f.active === 0 || f.active === false ? 0 : 1,
      nstr(f.valid_from), nstr(f.valid_until), nz(f.max_uses), nz(f.per_phone_limit), nz(f.min_amount), nstr(f.note));
  return db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(info.lastInsertRowid);
}

export function updateDiscountCode(id, f) {
  const c = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
  if (!c) throw new ApiError(404, 'not_found');
  const merged = { discount_type: f.discount_type ?? c.discount_type, discount_value: f.discount_value ?? c.discount_value,
    max_uses: f.max_uses, per_phone_limit: f.per_phone_limit, min_amount: f.min_amount };
  const val = validateCodeFields(merged);
  db.prepare(`UPDATE discount_codes SET discount_type=?, discount_value=?, active=?, valid_from=?, valid_until=?,
    max_uses=?, per_phone_limit=?, min_amount=?, note=? WHERE id=?`).run(
    merged.discount_type, val, f.active === 0 || f.active === false ? 0 : 1,
    nstr(f.valid_from), nstr(f.valid_until), nz(f.max_uses), nz(f.per_phone_limit), nz(f.min_amount), nstr(f.note), id);
  return db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
}

export function deleteDiscountCode(id) {
  const c = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
  if (!c) throw new ApiError(404, 'not_found');
  if (countUsesStmt.get(id).c > 0) throw new ApiError(409, 'has_redemptions');
  db.prepare('DELETE FROM discount_codes WHERE id = ?').run(id);
  return { ok: true };
}

const getSettingStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
export function getSetting(key) { const r = getSettingStmt.get(key); return r ? r.value : null; }
export function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
export function getOneOnOnePrice() { return parseInt(getSetting('one_on_one_price') || '1500', 10); }
```
> 注意：`updateDiscountCode` 的 PATCH 採「整體覆蓋」語意（前端送完整欄位）。`active` 以 truthy 處理。

- [ ] **Step 3: 跑測試**　Run: `node tests/discount-service.test.js` → D2+D3+D4 全 ✓。
- [ ] **Step 4: Commit**
```bash
git add src/services/discountService.js tests/discount-service.test.js
git commit -m "feat(discount): admin CRUD + app_settings (one_on_one_price)"
```

---

## Task D5: 團體課整合（createGroupOrder + 取消釋放 + schedule 折後總額）

**Files:**
- Modify: `src/services/groupOrderService.js`
- Test: `tests/discount-group.test.js`

- [ ] **Step 1: 寫測試**

`tests/discount-group.test.js`（仿 `tests/group-order-service.test.js` 的 reset/建 template 模式；用獨特前綴）：建一個 price=500 的 template，建一個 percent10 折扣碼 → `createGroupOrder({..., discountCode:'...'})` 選 2 場 → 斷言：
```js
// 預期：order.original_amount=1000, order.discount_amount=100, order.total_amount=900, order.discount_code 設定
// redemption 存在；cancelGroupOrder 後 redemption 被刪（用量回 0）
// 帶無效碼 → 整批 throw（tx rollback，無 order）
// 不帶碼 → original_amount=1000, total_amount=1000, discount_* NULL
```
（完整 reset/seed 參照 `tests/group-order-service.test.js`；斷言用 `db.prepare('SELECT * FROM group_orders WHERE id=?')`。）
Run → FAIL。

- [ ] **Step 2: 改 `createGroupOrder`**

- import：在檔案頂 import 區加 `import { applyDiscountTx, releaseRedemption } from './discountService.js';`
- 簽名加 `discountCode = null`：`export function createGroupOrder({ name, phone, paySessionIds = [], waitlistSessionIds = [], discountCode = null }) {`
- 在 `insertOrder.run(...)` 取得 `orderId` 之後、回傳前，加入折扣套用 + 寫回（用內容定位 `const orderId = insertOrder.run(`）：
```js
    // 折扣：原價 = total（付款場次加總）。套用在同一 tx 內（防併發超用）。
    let originalAmount = total, discountAmount = null, discountCode_ = null, finalTotal = total;
    const applied = applyDiscountTx({ code: discountCode, phone, subtotal: total, kind: 'group_order', refId: orderId });
    if (applied) { discountAmount = applied.discountAmount; discountCode_ = applied.discountCode; finalTotal = applied.finalTotal; }
    db.prepare('UPDATE group_orders SET original_amount=?, discount_amount=?, discount_code=?, total_amount=? WHERE id=?')
      .run(originalAmount, discountAmount, discountCode_, finalTotal, orderId);
```
- 回傳 result 改為帶折扣資訊（用內容定位現有 `const result = { orderId, total, ...`）：
```js
    const result = { orderId, total: finalTotal, originalAmount, discountAmount, discountCode: discountCode_,
      bankInfo: BANK_INFO, expiresAt: order.expires_at, waitlisted, memberId: user.id };
```
> 若 `applyDiscountTx` throw（無效/過期/用完碼），整個 `tx()` rollback、order 不寫入 — 與既有 sessions_full 行為一致。

- 在 `cancelGroupOrder` 將 order 設 cancelled 後加 `releaseRedemption({ kind: 'group_order', refId: orderId });`（用內容定位 `UPDATE group_orders SET status='cancelled', cancelled_at=?`）。
- 在 `expirePendingOrders` 對每筆過期 order 設 cancelled 後同樣加 `releaseRedemption({ kind: 'group_order', refId: id });`（用內容定位該 sweep 迴圈）。
- **釋放只在「訂單層級」取消時做**（cancelGroupOrder / expirePendingOrders）。spec §4 曾列 `processDeadlines`，但那是「單一場次未開課 → reject 該場 registration」，訂單本身未取消（可能還含其他有效場次），故**不**在 processDeadlines 釋放 redemption（避免一場未開就退掉整筆訂單的折扣使用）。此為對 spec 的實作面釐清。

- [ ] **Step 3: schedule 顯示折後總額**

在 `getPublicSchedule` 的 registration 查詢中，`group_orders` 已 LEFT JOIN（別名 `o`）。在 select 增列 `o.total_amount AS order_total, o.discount_amount AS order_discount`，並在 map 出來的 registration item 加 `order_total: r.order_total, order_discount: r.order_discount`（用內容定位 `LEFT JOIN group_orders o`）。

- [ ] **Step 4: 跑測試**　Run: `node tests/discount-group.test.js` → 全 ✓；並 `node tests/group-order-service.test.js` 確認原有未壞。
- [ ] **Step 5: Commit**
```bash
git add src/services/groupOrderService.js tests/discount-group.test.js
git commit -m "feat(discount): apply to group orders; release on cancel/expire; schedule folded total"
```

---

## Task D6: 1v1 整合（createBookingAnon + 取消釋放）

**Files:**
- Modify: `src/services/bookingService.js`
- Test: `tests/discount-booking.test.js`

- [ ] **Step 1: 寫測試**

`tests/discount-booking.test.js`（仿 `tests/booking-anon.test.js`）：建 active coach + fixed200 碼 → `createBookingAnon({..., discountCode})` → 斷言 booking 的 `original_amount=getOneOnOnePrice()`、`discount_amount=200`、`discount_code` 設定，回傳含 `finalAmount`；`cancelBookingAnon` 後 redemption 釋放；不帶碼 → original_amount=price、discount_* NULL。
Run → FAIL。

- [ ] **Step 2: 改 `bookingService.js`**

- import：加 `import { applyDiscountTx, releaseRedemption, getOneOnOnePrice } from './discountService.js';`
- `createBookingAnon` 簽名加 `discountCode = null`。在 `createBookingCore` 回傳 `r`（含 `r.id`）之後、回傳前加：
```js
    const subtotal = getOneOnOnePrice();
    let originalAmount = subtotal, discountAmount = null, discountCode_ = null, finalAmount = subtotal;
    const applied = applyDiscountTx({ code: discountCode, phone, subtotal, kind: 'booking', refId: r.id });
    if (applied) { discountAmount = applied.discountAmount; discountCode_ = applied.discountCode; finalAmount = applied.finalTotal; }
    db.prepare('UPDATE bookings SET original_amount=?, discount_amount=?, discount_code=? WHERE id=?')
      .run(originalAmount, discountAmount, discountCode_, r.id);
    r.originalAmount = originalAmount; r.discountAmount = discountAmount; r.discountCode = discountCode_; r.finalAmount = finalAmount;
```
- 在 `cancelBookingAnon` 成功取消後加 `releaseRedemption({ kind: 'booking', refId: bookingId });`（用內容定位 `cancelBookingStmt.run(`）。

- [ ] **Step 3: 跑測試**　Run: `node tests/discount-booking.test.js` → 全 ✓；`node tests/booking-anon.test.js` 未壞。
- [ ] **Step 4: Commit**
```bash
git add src/services/bookingService.js tests/discount-booking.test.js
git commit -m "feat(discount): apply to 1v1 bookings (flat price); release on cancel"
```

---

## Task D7: 公開 endpoints（validate + 帶碼下單 + 1v1 價）

**Files:**
- Modify: `src/server.js`
- Test: `tests/discount-api.test.js`

- [ ] **Step 1: 寫 API 測試**（需啟 server，spare port）

`tests/discount-api.test.js`：用 helper req；admin 登入建一個 percent10 碼（透過 D8 的 admin endpoint，或先在測試裡直接 SQL 建）；驗：
```
POST /api/public/discounts/validate {kind:'group', code, phone, sessionIds:[..]} → 200 {final_total, discount_amount}
POST /api/public/discounts/validate {kind:'one_on_one', code, phone} → 200（subtotal=1v1價）
無效碼 → 404 invalid_code；過期 → 409
GET /api/public/one-on-one-price → 200 {price:1500}
POST /api/public/group-orders {..., discountCode} → 201, total=折後
```
Run（啟 server 後）→ FAIL（endpoints 404）。

- [ ] **Step 2: 加 endpoints 到 `server.js`**

- import 區加：`import { validateDiscount, getOneOnOnePrice } from './services/discountService.js';`（用內容定位既有 service import 群）。
- 在公開區塊（用內容定位 `// --- Public (no auth)` 或既有 `/api/public/*` 群）加：
```js
app.get('/api/public/one-on-one-price', asyncHandler((req, res) => {
  res.json({ price: getOneOnOnePrice() });
}));

app.post('/api/public/discounts/validate', asyncHandler((req, res) => {
  const { code, phone, kind, sessionIds } = req.body || {};
  let subtotal;
  if (kind === 'one_on_one') {
    subtotal = getOneOnOnePrice();
  } else {
    // group：由 sessionIds 即時加總付款場次單價（server 權威）
    const ids = (sessionIds || []).map(Number);
    subtotal = ids.reduce((sum, sid) => {
      const s = db.prepare('SELECT template_id FROM course_sessions WHERE id=?').get(sid);
      const tpl = s ? db.prepare('SELECT price_per_session FROM course_templates WHERE id=?').get(s.template_id) : null;
      return sum + (tpl ? tpl.price_per_session : 0);
    }, 0);
  }
  const v = validateDiscount({ code, phone, subtotal });
  res.json({ valid: true, discount_type: v.type, discount_value: v.value, discount_amount: v.discountAmount, original: v.subtotal, final_total: v.finalTotal });
}));
```
- 既有 `POST /api/public/group-orders` handler：把 `discountCode` 從 body 傳入 `svcCreateGroupOrder`（用內容定位該 handler，加 `discountCode: (req.body||{}).discountCode || null`）。
- 既有 `POST /api/public/bookings` handler：同樣傳 `discountCode`。

- [ ] **Step 3: 跑測試**（重啟 server 後）　Run: `node tests/discount-api.test.js` → 全 ✓。
- [ ] **Step 4: Commit**
```bash
git add src/server.js tests/discount-api.test.js
git commit -m "feat(api): public discount validate + one-on-one-price; thread discountCode into orders/bookings"
```

---

## Task D8: Admin endpoints（折扣碼 CRUD + settings）

**Files:**
- Modify: `src/server.js`
- Test: `tests/discount-admin-api.test.js`

- [ ] **Step 1: 寫 API 測試**：admin 登入 → `POST /api/admin/discount-codes` 建立 → `GET` 列出（含 used_count）→ `PATCH` 改 active → `DELETE` 未使用可刪；non-admin → 401/403；`PATCH /api/admin/settings {one_on_one_price:1800}` → `GET /api/public/one-on-one-price` 回 1800（記得測完設回 1500）。Run → FAIL。

- [ ] **Step 2: 加 endpoints**

import 加：`import { listDiscountCodes, createDiscountCode, updateDiscountCode, deleteDiscountCode, getSetting, setSetting } from './services/discountService.js';`（合併進既有 discountService import）。在 admin 區塊（用內容定位既有 `/api/admin/*` 群）加：
```js
app.get('/api/admin/discount-codes', requireAdmin, asyncHandler((req, res) => res.json(listDiscountCodes())));
app.post('/api/admin/discount-codes', requireAdmin, asyncHandler((req, res) => res.status(201).json(createDiscountCode(req.body || {}))));
app.patch('/api/admin/discount-codes/:id', requireAdmin, asyncHandler((req, res) => res.json(updateDiscountCode(Number(req.params.id), req.body || {}))));
app.delete('/api/admin/discount-codes/:id', requireAdmin, asyncHandler((req, res) => res.json(deleteDiscountCode(Number(req.params.id)))));

app.get('/api/admin/settings', requireAdmin, asyncHandler((req, res) => {
  res.json({ one_on_one_price: Number(getSetting('one_on_one_price') || '1500') });
}));
app.patch('/api/admin/settings', requireAdmin, asyncHandler((req, res) => {
  const p = Number((req.body || {}).one_on_one_price);
  if (!Number.isInteger(p) || p < 0) return res.status(400).json({ error: 'invalid_price' });
  setSetting('one_on_one_price', String(p));
  res.json({ one_on_one_price: p });
}));
```

- [ ] **Step 3: 跑測試**（重啟 server）　Run: `node tests/discount-admin-api.test.js` → 全 ✓。
- [ ] **Step 4: 更新 `package.json` test scripts**：把新 service 測試（`discount-migration`, `discount-service`, `discount-group`, `discount-booking`）加進 `test`；新 API 測試（`discount-api`, `discount-admin-api`）加進 `test:api`。
- [ ] **Step 5: Commit**
```bash
git add src/server.js tests/discount-admin-api.test.js package.json
git commit -m "feat(api): admin discount-codes CRUD + settings endpoints"
```

---

## Phase D Gate
本機跑 `npm test`（全綠）+ 啟 server 跑 `npm run test:api`（全綠）。

---

# Phase E — Admin 前端

> 動工前先讀 `public/admin.js` + `public/admin.html`：既有 section 結構、`api()`/`toast`/`escapeHtml`、卡片/表單/badge class、新近加的「教練管理」+「建立教練帳號」區的 render/handler 模式。

## Task E1: 折扣碼管理區 + 1v1 單堂價設定

**Files:**
- Modify: `public/admin.html`、`public/admin.js`

- [ ] **Step 1: `admin.html` 加 section `#discount-codes`**（沿用既有 `.card`/section 排版），含：
  - 「1v1 單堂價」設定列：數字 input `#one-on-one-price` + 「儲存」按鈕。
  - 「建立折扣碼」表單：`code`、型態 select（百分比/定額）、值、選填 valid_from/valid_until(date)、max_uses、per_phone_limit、min_amount、note。
  - `#discount-codes-list` 容器。

- [ ] **Step 2: `admin.js` 加 functions**
  - `loadOneOnOnePrice()`：`GET /api/admin/settings` → 填 `#one-on-one-price`；「儲存」→ `PATCH /api/admin/settings {one_on_one_price}` → toast。
  - `loadDiscountCodes()`：`GET /api/admin/discount-codes` → render 每碼為 card：`escapeHtml(code)`、型態值顯示（`percent`→`減 N%`、`fixed`→`減 $N`）、限制摘要（有效期 / `used_count`/`max_uses` / 每人上限 / 最低額）、active badge、`啟用/停用`（→ `PATCH .../:id {active}`，連同其餘欄位整體送回）、`編輯`（帶入表單）、`刪除`（→ `DELETE .../:id`；失敗 `has_redemptions` 顯示「已被使用，請改停用」）。
  - 建立表單 submit → `POST /api/admin/discount-codes`（數字欄空字串轉不送/ null）；成功 toast + `loadDiscountCodes()`；錯誤碼（code_exists/invalid_value/...）顯示友善訊息。
  - 在 init 區呼叫 `loadDiscountCodes()` + `loadOneOnOnePrice()`。
  - **所有 server 字串 render 前 `escapeHtml`。**

- [ ] **Step 3: 手動驗證**：admin 建 percent 碼 → 列表顯示「減 N%」+ used 0；改 1v1 價 → 儲存成功；停用切換生效；刪除未使用 OK、刪用過的被擋。

- [ ] **Step 4: Commit**
```bash
git add public/admin.html public/admin.js
git commit -m "feat(admin-ui): discount-code management + 1v1 price setting"
```

---

# Phase F — 顧客前端

> 動工前讀對應檔。金額一律以 server 回傳為準，前端只顯示。電話用表單/modal 已輸入者。

## Task F1: 團體結帳折扣碼 UI

**Files:**
- Modify: `public/group.js`、`public/group.html`

- [ ] **Step 1: `group.html` 報名資料表單加**折扣碼 input `#discount-code` + 「套用」按鈕 `#apply-discount` + 折扣顯示列 `#discount-line`（預設 hidden）。
- [ ] **Step 2: `group.js`**：
  - 「套用」handler：取 `#discount-code`、`#f-phone`（normalize）、付款場次 ids → `POST /api/public/discounts/validate {kind:'group', code, phone, sessionIds:payIds}`。成功 → 記住已套用 code、顯示 `折扣 −$discount_amount`、更新 price summary 顯示折後 `final_total`；失敗 → 依錯誤碼顯示訊息（`below_min_amount` 帶 `min_amount`）。
  - 表單 submit：`POST /api/public/group-orders` body 加 `discountCode`（已套用者）。
  - `showSuccess`：若 `result.discountAmount` → 顯示 原價 `originalAmount` / 折扣 `−discountAmount` / **應匯 `total`**；否則照舊。
- [ ] **Step 3: 手動驗證**：套 percent 碼 → 折後總額正確、成功頁應匯＝折後；改場次後需重新套用（或自動失效提示）。
- [ ] **Step 4: Commit**
```bash
git add public/group.js public/group.html
git commit -m "feat(group-ui): discount code apply + folded total on checkout/success"
```

## Task F2: 1v1 modal 折扣碼 UI

**Files:**
- Modify: `public/coaches.js`、`public/coaches.html`

- [ ] **Step 1**：頁面載入時 `GET /api/public/one-on-one-price` 取單堂價（存模組變數）。預約 modal 顯示「單堂 $price」。
- [ ] **Step 2**：modal 加折扣碼 input + 「套用」→ `POST /api/public/discounts/validate {kind:'one_on_one', code, phone:modalPhone}` → 顯示「折後現場應付 $final_total」；失敗顯示訊息。送出 `POST /api/public/bookings` 帶 `discountCode`。成功頁顯示 原價/折扣/**折後現場應付**（標示現場收費）。
- [ ] **Step 3: 手動驗證**：modal 顯示單堂價 1500；套 fixed200 → 顯示折後 1300；成功頁正確。
- [ ] **Step 4: Commit**
```bash
git add public/coaches.js public/coaches.html
git commit -m "feat(1on1-ui): show single-session price + discount code in booking modal"
```

## Task F3: 我的課表顯示折後應付

**Files:**
- Modify: `public/my-schedule.js`

- [ ] **Step 1**：pending（待付款/已遞補待付款）的團體 registration item，若有 `order_total`，顯示「應付 $order_total」（有 `order_discount` 則附「已折 $order_discount」），取代/補充原本逐場 `amount_due` 顯示，讓客人關掉成功頁後仍看到正確匯款金額。
- [ ] **Step 2: 手動驗證**：折扣下單後到 my-schedule 查 → 顯示折後應付。
- [ ] **Step 3: Commit**
```bash
git add public/my-schedule.js
git commit -m "feat(my-schedule): show discounted order payable for pending group orders"
```

---

## Phase F Gate（E2E 手動 smoke）
依 spec §11 手動 smoke checklist 全跑：team/1v1 套碼、各錯誤、max_uses/per_phone、取消釋放、遞補原價、改 1v1 價、用過碼不可刪、無碼 regression。全過 → push + 開 draft PR（base main）→ 人工 gate → merge。

---

## 全案完成後
- [ ] push `feature/discount-codes` + 開 draft PR；holistic review；smoke gate；merge。
- [ ] 部署前備份生產 DB（本次遷移為加表/加欄、無 rebuild，風險低）。
- [ ] 更新 MEMORY.md 折扣碼進度。

## 風險備忘（執行時注意）
- 折扣套用務必在下單/預約 `tx()` 內（防併發超用）；validate endpoint 僅預覽。
- subtotal 一律 server 端重算（group 由 sessionIds 取單價、1v1 取設定價），勿信前端金額。
- 取消/逾時所有路徑都要 `releaseRedemption`，否則用量不回退。
- service 測試操作真實 `data/app.db`，自清 + 跑完別忘了 demo 資料需 re-seed（見 [[chinup-test-db-shared]]）。
