# PR1：方案（套餐／堂數）系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「客人擁有 N 堂、預約時可扣抵、取消時回補」的方案系統（後端＋會員管理 UI），供 PR2 的週曆登錄使用。

**Architecture:** 新 `customer_packages` 表記每位客人的方案（類型/總堂/剩餘/金額/到期/作廢）；`bookings` 加 `package_id` 連結。新 `packageService` 提供 CRUD＋原子扣抵/回補；`bookingService` 各取消路徑在「confirmed→cancelled」轉移時回補方案。HTTP 端點掛 `requireCoach`；會員管理長按彈窗加「方案」區塊。

**Tech Stack:** Node ESM、Express 4、`node:sqlite`（`db`/`tx`/`nowLocal` 來自 `src/db/connection.js`）；測試為純 node 腳本。

## Global Constraints

- 例外一律 `throw new ApiError(status, code)`（`code` 為英數字串，前端對照中文）；`ApiError` 從 `./registration.js` 匯入。
- 寫入交易用 `tx(fn)`（支援巢狀；內層不另開交易）。時間字串用 `nowLocal()`（`'YYYY-MM-DDTHH:MM:SS'`）。
- 既有 DB 加欄一律走 `src/db/connection.js` 的 `addColumnIfMissing(table, col, def)`；新表加進 `src/db/schema.js` 的 `SCHEMA` 字串（`CREATE TABLE IF NOT EXISTS`）。可空且 default NULL 的欄位才能用 `ALTER ... ADD COLUMN ... REFERENCES`（既有 `refunded_by` 即此用法）。
- 所有方案端點掛 `requireCoach`（管理者 role 亦為 coach，故通過）。方案屬「客人」不綁特定教練。
- 測試為純 node 腳本：`expect(label, fn)` 內部 try/catch 後 `process.exitCode=1`，**不會 throw**；每次跑完要掃輸出有無 `✗`。unit 測試掛進 `package.json` 的 `test`；api 測試掛進 `test:api`（需先起 server，環境 `LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1`）。
- `npm test` 會清掉 `data/app.db` demo 資料 → 預覽前需重新 seed（非本計畫步驟，PR 收尾處理）。
- 全程繁體中文 UI 文案。

---

## File Structure

- `src/db/schema.js` — 加 `customer_packages` 建表 DDL（置於 `bookings` 之前）；`bookings` 建表加 `package_id`。
- `src/db/connection.js` — 加 `addColumnIfMissing('bookings','package_id',...)`。
- `src/services/packageService.js`（新）— 方案 CRUD＋`deductOne`/`refundOne`。
- `src/services/bookingService.js` — import `refundOne`；各取消路徑回補方案。
- `src/server.js` — 5 個方案端點。
- `public/admin.js` — 會員編輯彈窗加「方案」區塊。
- `tests/package-service.test.js`（新，unit）、`tests/package-api.test.js`（新，api）。
- `package.json` — 兩支測試掛進 scripts。

---

## Task 1：Schema＋migration（customer_packages 表＋bookings.package_id）

**Files:**
- Modify: `src/db/schema.js`（`bookings` 區塊前插入新表；`bookings` CREATE 內加欄）
- Modify: `src/db/connection.js`（加 `addColumnIfMissing`）

**Interfaces:**
- Produces: 資料表 `customer_packages(id, member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, note, created_by, created_at, archived_at)`；`bookings.package_id INTEGER REFERENCES customer_packages(id)`。

- [ ] **Step 1：在 `src/db/schema.js` 的 `CREATE TABLE IF NOT EXISTS bookings (` 那一行之前，插入新表 DDL**

在 `src/db/schema.js` 找到（約第 170 行）：
```js
CREATE TABLE IF NOT EXISTS bookings (
```
在它「之前」插入：
```js
CREATE TABLE IF NOT EXISTS customer_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK (session_type IN ('1on1','1on2')),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  remaining_sessions INTEGER NOT NULL CHECK (remaining_sessions >= 0),
  amount INTEGER,
  expires_at TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_packages_member ON customer_packages(member_id);

```

- [ ] **Step 2：在 `src/db/schema.js` 的 `bookings` 建表中加 `package_id` 欄**

把 `bookings` 表內的：
```js
  recurring_group_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
```
改為：
```js
  recurring_group_id INTEGER,
  package_id INTEGER REFERENCES customer_packages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
```

- [ ] **Step 3：在 `src/db/connection.js` 末段（其他 `addColumnIfMissing('bookings', ...)` 附近、`recurring_group_id` 那行之後）加既有 DB 的加欄遷移**

找到：
```js
addColumnIfMissing('bookings', 'recurring_group_id', 'INTEGER');
```
在其後加：
```js
// ── 2026-06-24 方案（套餐）系統 ──
// customer_packages 表由 SCHEMA 的 CREATE TABLE IF NOT EXISTS 建立（含既有 DB）。
// bookings.package_id：扣抵來源方案（NULL=非方案預約）。取消預約時回補該方案 1 堂。
addColumnIfMissing('bookings', 'package_id', 'INTEGER REFERENCES customer_packages(id)');
```

- [ ] **Step 4：開機驗證 schema 套用成功（無語法錯）**

Run:
```bash
node --input-type=module -e "import {db} from './src/db/connection.js'; const cols=db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name); console.log('package_id?', cols.includes('package_id')); console.log('table?', !!db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='customer_packages'\").get());"
```

Expected: 輸出 `package_id? true` 與 `table? true`，無例外。

- [ ] **Step 5：Commit**

```bash
git add src/db/schema.js src/db/connection.js
git commit -m "feat(package): customer_packages 表 + bookings.package_id"
```

---

## Task 2：packageService（CRUD＋扣抵/回補）＋unit 測試

**Files:**
- Create: `src/services/packageService.js`
- Create: `tests/package-service.test.js`
- Modify: `package.json`（`test` 腳本末尾加新檔）

**Interfaces:**
- Consumes: `db`/`tx`/`nowLocal`（`../db/connection.js`）、`ApiError`（`./registration.js`）。
- Produces:
  - `createPackage({ memberId, sessionType, totalSessions, amount?, expiresAt?, note?, createdBy? }) → packageRow`（含 `is_valid`）
  - `getPackage(id) → packageRow|null`（含 `is_valid` 布林）
  - `listPackagesForMember(memberId, { includeArchived=false }) → packageRow[]`（含 `is_valid`）
  - `listValidPackagesForMember(memberId, sessionType=null) → packageRow[]`（有效；排序 最早到期→最早建立）
  - `adjustRemaining({ packageId, remaining, note? }) → packageRow`
  - `archivePackage(packageId) → packageRow` / `restorePackage(packageId) → packageRow`
  - `deductOne(packageId) → boolean`（原子；剩餘不足/作廢→false）
  - `refundOne(packageId) → boolean`（+1，不超過 total）

- [ ] **Step 1：寫失敗測試 `tests/package-service.test.js`**

```js
// 方案 service：建立/有效判定/排序/扣抵/回補/校正/作廢。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const {
  createPackage, getPackage, listPackagesForMember, listValidPackagesForMember,
  adjustRemaining, archivePackage, restorePackage, deductOne, refundOne,
} = await import('../src/services/packageService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[package-service test] start');
db.exec("DELETE FROM point_transactions WHERE related_booking_id IS NOT NULL; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM users WHERE email LIKE 'pk-%'");

const pad = n => String(n).padStart(2,'0');
const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','pk-m@x.com','user','0961000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('管理者','pk-a@x.com','coach',1)").run().lastInsertRowid);

// 結構：欄位/表存在
expect('schema：customer_packages 表與 bookings.package_id 存在', () => {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_packages'").get());
  assert.ok(db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name).includes('package_id'));
});

expect('createPackage：remaining=total、is_valid、回欄位', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 10, amount: 15000, createdBy: admin });
  assert.equal(p.total_sessions, 10);
  assert.equal(p.remaining_sessions, 10);
  assert.equal(p.session_type, '1on1');
  assert.equal(p.amount, 15000);
  assert.equal(p.is_valid, true);
});

expect('createPackage：類型錯/堂數錯/金額錯/日期錯 → 400', () => {
  assert.throws(() => createPackage({ memberId: mid, sessionType: 'x', totalSessions: 5 }), /invalid_session_type/);
  assert.throws(() => createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 0 }), /invalid_total/);
  assert.throws(() => createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, amount: -1 }), /invalid_amount/);
  assert.throws(() => createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, expiresAt: '2026/01/01' }), /invalid_expires_at/);
});

expect('createPackage：客人不存在 → 404', () => {
  assert.throws(() => createPackage({ memberId: 999999, sessionType: '1on1', totalSessions: 5 }), /member_not_found/);
});

expect('有效判定：過期 / 用罄 / 作廢 三種失效', () => {
  const expired = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 3, expiresAt: '2000-01-01' });
  assert.equal(getPackage(expired.id).is_valid, false);
  const used = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 1 });
  assert.equal(deductOne(used.id), true);
  assert.equal(getPackage(used.id).is_valid, false); // remaining=0
  const arch = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 3 });
  archivePackage(arch.id);
  assert.equal(getPackage(arch.id).is_valid, false);
});

expect('listValidPackagesForMember：類型篩選 + 排序（最早到期先）', () => {
  db.exec("DELETE FROM customer_packages WHERE member_id="+mid);
  const noExp = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });           // 永久
  const farExp = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, expiresAt: '2099-12-31' });
  const soonExp = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, expiresAt: '2099-01-01' });
  const other = createPackage({ memberId: mid, sessionType: '1on2', totalSessions: 5 });
  const v1on1 = listValidPackagesForMember(mid, '1on1');
  assert.equal(v1on1.length, 3);
  assert.equal(v1on1[0].id, soonExp.id);   // 最早到期在前
  assert.equal(v1on1[2].id, noExp.id);     // 永久(NULL)排最後
  assert.ok(!v1on1.some(p => p.id === other.id)); // 類型篩掉 1on2
  assert.equal(listValidPackagesForMember(mid, '1on2').length, 1);
  assert.equal(listValidPackagesForMember(mid).length, 4); // 不給類型 → 全有效
});

expect('deductOne：扣到 0 後再扣 → false（原子）', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 2 });
  assert.equal(deductOne(p.id), true);
  assert.equal(deductOne(p.id), true);
  assert.equal(deductOne(p.id), false);
  assert.equal(getPackage(p.id).remaining_sessions, 0);
});

expect('refundOne：+1 不超過 total', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 2 });
  deductOne(p.id); deductOne(p.id);
  assert.equal(refundOne(p.id), true);
  assert.equal(getPackage(p.id).remaining_sessions, 1);
  refundOne(p.id);
  assert.equal(getPackage(p.id).remaining_sessions, 2); // 已滿
  refundOne(p.id);
  assert.equal(getPackage(p.id).remaining_sessions, 2); // 仍封頂
});

expect('adjustRemaining：夾在 0..total，越界 → 400', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  assert.equal(adjustRemaining({ packageId: p.id, remaining: 3 }).remaining_sessions, 3);
  assert.throws(() => adjustRemaining({ packageId: p.id, remaining: 6 }), /invalid_remaining/);
  assert.throws(() => adjustRemaining({ packageId: p.id, remaining: -1 }), /invalid_remaining/);
});

expect('archive/restore：切換 archived_at 與 is_valid', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  archivePackage(p.id);
  assert.ok(getPackage(p.id).archived_at);
  assert.equal(getPackage(p.id).is_valid, false);
  restorePackage(p.id);
  assert.equal(getPackage(p.id).archived_at, null);
  assert.equal(getPackage(p.id).is_valid, true);
});

expect('listPackagesForMember：預設排除作廢、includeArchived 含作廢', () => {
  db.exec("DELETE FROM customer_packages WHERE member_id="+mid);
  const a = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  const b = createPackage({ memberId: mid, sessionType: '1on2', totalSessions: 5 });
  archivePackage(b.id);
  assert.equal(listPackagesForMember(mid).length, 1);
  assert.equal(listPackagesForMember(mid, { includeArchived: true }).length, 2);
});

db.exec("DELETE FROM point_transactions WHERE related_booking_id IS NOT NULL; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM users WHERE email LIKE 'pk-%'");
console.log('[package-service test] done');
```

- [ ] **Step 2：跑測試確認失敗（模組不存在）**

Run: `node tests/package-service.test.js`
Expected: 失敗（`Cannot find module '../src/services/packageService.js'` 或 import 錯）。

- [ ] **Step 3：建立 `src/services/packageService.js`**

```js
import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';

const SESSION_TYPES = ['1on1', '1on2'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() { return nowLocal().slice(0, 10); }

// is_valid：未作廢 + 有剩 + 未過期（? = 今天）
const VALID_EXPR = `(cp.archived_at IS NULL AND cp.remaining_sessions > 0 AND (cp.expires_at IS NULL OR cp.expires_at >= ?))`;

export function getPackage(id) {
  const row = db.prepare(`SELECT cp.*, ${VALID_EXPR} AS is_valid FROM customer_packages cp WHERE cp.id = ?`)
    .get(todayLocal(), id);
  if (!row) return null;
  row.is_valid = !!row.is_valid;
  return row;
}

export function createPackage({ memberId, sessionType, totalSessions, amount = null, expiresAt = null, note = null, createdBy = null }) {
  if (!memberId) throw new ApiError(400, 'missing_member');
  if (!SESSION_TYPES.includes(sessionType)) throw new ApiError(400, 'invalid_session_type');
  const total = Number(totalSessions);
  if (!Number.isInteger(total) || total <= 0) throw new ApiError(400, 'invalid_total');
  let amt = null;
  if (amount != null && amount !== '') {
    amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 0) throw new ApiError(400, 'invalid_amount');
  }
  let exp = null;
  if (expiresAt != null && expiresAt !== '') {
    if (!DATE_RE.test(expiresAt)) throw new ApiError(400, 'invalid_expires_at');
    // regex 擋不掉不存在的日期（如 2026-13-45 / 2026-02-30）→ 用 Date round-trip 驗真實日期。
    const d = new Date(`${expiresAt}T00:00:00`);
    if (Number.isNaN(d.getTime())
      || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== expiresAt) {
      throw new ApiError(400, 'invalid_expires_at');
    }
    exp = expiresAt;
  }
  const member = db.prepare('SELECT id FROM users WHERE id = ?').get(memberId);
  if (!member) throw new ApiError(404, 'member_not_found');
  // created_at 用 nowLocal()（本地 wall-clock，與全站一致；不用 DEFAULT 的 UTC datetime('now')）。
  const info = db.prepare(
    `INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(memberId, sessionType, total, total, amt, exp, (note && note.trim()) || null, createdBy, nowLocal());
  return getPackage(Number(info.lastInsertRowid));
}

export function listPackagesForMember(memberId, { includeArchived = false } = {}) {
  const rows = db.prepare(
    `SELECT cp.*, ${VALID_EXPR} AS is_valid
       FROM customer_packages cp
      WHERE cp.member_id = ? ${includeArchived ? '' : 'AND cp.archived_at IS NULL'}
      ORDER BY (cp.archived_at IS NOT NULL) ASC,
               (cp.remaining_sessions > 0) DESC,
               (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(todayLocal(), memberId);
  for (const r of rows) r.is_valid = !!r.is_valid;
  return rows;
}

export function listValidPackagesForMember(memberId, sessionType = null) {
  const today = todayLocal();
  const params = sessionType ? [memberId, today, sessionType] : [memberId, today];
  return db.prepare(
    `SELECT cp.* FROM customer_packages cp
      WHERE cp.member_id = ?
        AND cp.archived_at IS NULL
        AND cp.remaining_sessions > 0
        AND (cp.expires_at IS NULL OR cp.expires_at >= ?)
        ${sessionType ? 'AND cp.session_type = ?' : ''}
      ORDER BY (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(...params);
}

export function adjustRemaining({ packageId, remaining, note = null }) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    const r = Number(remaining);
    if (!Number.isInteger(r) || r < 0 || r > p.total_sessions) throw new ApiError(400, 'invalid_remaining');
    const newNote = note && note.trim() ? note.trim() : null;
    db.prepare('UPDATE customer_packages SET remaining_sessions = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(r, newNote, packageId);
    return getPackage(packageId);
  });
}

export function archivePackage(packageId) {
  const p = db.prepare('SELECT id FROM customer_packages WHERE id = ?').get(packageId);
  if (!p) throw new ApiError(404, 'package_not_found');
  db.prepare('UPDATE customer_packages SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(nowLocal(), packageId);
  return getPackage(packageId);
}

export function restorePackage(packageId) {
  const p = db.prepare('SELECT id FROM customer_packages WHERE id = ?').get(packageId);
  if (!p) throw new ApiError(404, 'package_not_found');
  db.prepare('UPDATE customer_packages SET archived_at = NULL WHERE id = ?').run(packageId);
  return getPackage(packageId);
}

// 扣 1 堂：條件式 UPDATE 防併發超扣。回 true=成功；剩餘不足/作廢→false。
export function deductOne(packageId) {
  const info = db.prepare(
    `UPDATE customer_packages SET remaining_sessions = remaining_sessions - 1
      WHERE id = ? AND remaining_sessions > 0 AND archived_at IS NULL`
  ).run(packageId);
  return info.changes === 1;
}

// 回補 1 堂（取消預約）：即使已過期/作廢仍回補（堂數屬客人）。
// WHERE remaining < total → changes===1 代表「真的回補了一堂」（已滿時 changes=0、回 false），
// 契約精準，讓「不重複回補」測試不被封頂掩蓋。
export function refundOne(packageId) {
  const info = db.prepare(
    `UPDATE customer_packages SET remaining_sessions = remaining_sessions + 1
      WHERE id = ? AND remaining_sessions < total_sessions`
  ).run(packageId);
  return info.changes === 1;
}
```

- [ ] **Step 4：跑測試確認通過**

Run: `node tests/package-service.test.js`
Expected: 全部 `✓`，輸出無 `✗`，`[package-service test] done`。

- [ ] **Step 5：把 unit 測試掛進 `package.json` 的 `test` 腳本**

在 `package.json` 的 `"test"` 字串最末（`&& node tests/notification-dedup.test.js` 之後）加：
```
 && node tests/package-service.test.js
```

- [ ] **Step 6：Commit**

```bash
git add src/services/packageService.js tests/package-service.test.js package.json
git commit -m "feat(package): packageService CRUD + 原子扣抵/回補 + unit 測試"
```

---

## Task 3：取消預約時回補方案（bookingService 整合）

**Files:**
- Modify: `src/services/bookingService.js`
- Modify: `tests/package-service.test.js`（加 cancel→回補 整合斷言）

**Interfaces:**
- Consumes: `refundOne`（`./packageService.js`）。
- Produces: 任何「confirmed→cancelled」轉移後，若該 booking 有 `package_id` → 回補方案 1 堂（恰一次）。

- [ ] **Step 1：在 `src/services/bookingService.js` 頂部 import 區加入**

在 `import { applyDiscountTx, ... } from './discountService.js';` 之後加：
```js
import { refundOne as refundPackageOne } from './packageService.js';
```

- [ ] **Step 2：在 `bookingService.js` 加私有 helper（放在 `cancelBookingStmt` 宣告之後、`createBookingCore` 之前任一處）**

```js
// 取消「confirmed→cancelled」的預約若來自方案 → 回補 1 堂（呼叫端須保證恰在轉移當下呼叫一次）。
function refundPackageForBooking(b) {
  if (b && b.package_id) {
    try { refundPackageOne(b.package_id); } catch { /* 回補失敗不阻斷取消 */ }
  }
}
```

- [ ] **Step 3：於各取消路徑「轉移當下」呼叫回補**

`cancelBooking`：在 `cancelBookingStmt.run(nowLocal(), actorUserId, reason, bookingId);` 之後、`releaseRedemption(...)` 之前加 `refundPackageForBooking(b);`（此處 `b.status` 必為 confirmed，已過 already_cancelled 守門）。

`cancelBookingAnon`：在 `cancelBookingStmt.run(nowLocal(), user.id, null, bookingId);` 之後加 `refundPackageForBooking(b);`。

`cancelBookingAdmin`：在 `cancelBookingStmt.run(nowLocal(), actorId, reason, bookingId);` 之後加 `refundPackageForBooking(b);`。

`refundBookingAdmin`：把
```js
    const wasConfirmed = b.status === 'confirmed';
    if (wasConfirmed) {
      cancelBookingStmt.run(nowLocal(), actorId, '取消並退款', bookingId);
      releaseRedemption({ kind: 'booking', refId: bookingId });
    }
```
改為（僅在 wasConfirmed 時回補，避免已取消者重複回補）：
```js
    const wasConfirmed = b.status === 'confirmed';
    if (wasConfirmed) {
      cancelBookingStmt.run(nowLocal(), actorId, '取消並退款', bookingId);
      refundPackageForBooking(b);
      releaseRedemption({ kind: 'booking', refId: bookingId });
    }
```

`cancelBookingAdminGroup`：迴圈內 `cancelBookingStmt.run(nowLocal(), actorId, reason, b.id);` 之後加 `refundPackageForBooking(b);`（`rows` 已篩 `status='confirmed'`）。

`refundBookingGroupAdmin`：把迴圈內
```js
      if (b.status === 'confirmed') {
        cancelBookingStmt.run(now, actorId, '取消並退款', b.id);
        releaseRedemption({ kind: 'booking', refId: b.id });
        cancelled.push(b.id);
      }
```
改為：
```js
      if (b.status === 'confirmed') {
        cancelBookingStmt.run(now, actorId, '取消並退款', b.id);
        refundPackageForBooking(b);
        releaseRedemption({ kind: 'booking', refId: b.id });
        cancelled.push(b.id);
      }
```

- [ ] **Step 4：在 `tests/package-service.test.js` 結尾（最後一個 `expect(...)` 與最末 `db.exec(...)` 清理之間）加整合斷言**

```js
// 整合：方案預約被取消 → 回補 1 堂（轉移恰一次）
const { cancelBooking, refundBookingAdmin } = await import('../src/services/bookingService.js');
process.env.LINE_MOCK = '1';
expect('cancelBooking：有 package_id 的預約取消 → 回補 1 堂', () => {
  db.exec("DELETE FROM customer_packages WHERE member_id="+mid);
  const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('回補教練','pk-c@x.com','coach')").run().lastInsertRowid);
  const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '回補教練', 1)").run(cuid).lastInsertRowid);
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  deductOne(p.id);
  assert.equal(getPackage(p.id).remaining_sessions, 4);
  const d = new Date(Date.now() + 6*86400000);
  const ds = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const bid = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, package_id, paid_at) VALUES (?,?,?,?, '1on1', ?, ?)")
    .run(coachId, mid, `${ds}T09:00:00`, `${ds}T10:00:00`, p.id, '2026-06-24T00:00:00').lastInsertRowid);
  cancelBooking({ bookingId: bid, actorUserId: cuid, isCoach: true, reason: '測試' });
  assert.equal(getPackage(p.id).remaining_sessions, 5); // 回補
});
expect('已取消的方案預約再走退款 → 不重複回補（扣兩次起跳，避開封頂遮蔽）', () => {
  db.exec("DELETE FROM customer_packages WHERE member_id="+mid);
  const coachId = db.prepare("SELECT id FROM coaches WHERE display_name LIKE '回補%' LIMIT 1").get().id;
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  deductOne(p.id); deductOne(p.id);                        // 起始剩 3（低於封頂，雙重回補才看得出來）
  assert.equal(getPackage(p.id).remaining_sessions, 3);
  const d = new Date(Date.now() + 7*86400000);
  const ds = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const bid = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, package_id, paid_at, paid_by) VALUES (?,?,?,?, '1on1', ?, ?, ?)")
    .run(coachId, mid, `${ds}T09:00:00`, `${ds}T10:00:00`, p.id, '2026-06-24T00:00:00', admin).lastInsertRowid);
  cancelBooking({ bookingId: bid, actorUserId: admin, isCoach: true, adminOnBehalf: true, reason: 'x' }); // 回補 3→4
  assert.equal(getPackage(p.id).remaining_sessions, 4);
  refundBookingAdmin({ bookingId: bid, actorId: admin }); // 已 cancelled → wasConfirmed=false → 不再回補
  assert.equal(getPackage(p.id).remaining_sessions, 4);    // 仍是 4；若重複回補會變 5 → 測試失敗
});
db.exec("DELETE FROM point_transactions WHERE related_booking_id IS NOT NULL; DELETE FROM bookings; DELETE FROM coaches WHERE display_name LIKE '回補%'");
```

> 註：清理那行已存在於檔尾；若位置衝突，確保最終仍只清理一次測試資料。

- [ ] **Step 5：跑測試確認通過**

Run: `node tests/package-service.test.js`
Expected: 全部 `✓`，無 `✗`。

- [ ] **Step 6：Commit**

```bash
git add src/services/bookingService.js tests/package-service.test.js
git commit -m "feat(package): 取消預約回補方案（轉移恰一次，避免重複）"
```

---

## Task 4：方案 HTTP 端點＋api 測試

**Files:**
- Modify: `src/server.js`（import＋5 路由）
- Create: `tests/package-api.test.js`
- Modify: `package.json`（`test:api` 加新檔）

**Interfaces:**
- Consumes: `requireCoach`、`asyncHandler`、`packageService` 匯出。
- Produces:
  - `POST /api/coach/packages {memberId, sessionType, totalSessions, amount?, expiresAt?, note?}` → 201 packageRow
  - `GET /api/coach/packages?memberId=&includeArchived=` → 200 packageRow[]
  - `PATCH /api/coach/packages/:id {remaining?, note?}` → 200 packageRow
  - `POST /api/coach/packages/:id/archive` / `.../restore` → 200 packageRow

- [ ] **Step 1：在 `src/server.js` import 區加 packageService**

在 `import { syncBookingCreate, syncBookingCancel } from './services/gcalSync.js';` 之後加：
```js
import {
  createPackage as svcCreatePackage,
  listPackagesForMember as svcListPackages,
  adjustRemaining as svcAdjustRemaining,
  archivePackage as svcArchivePackage,
  restorePackage as svcRestorePackage,
} from './services/packageService.js';
```

- [ ] **Step 2：在 `src/server.js` 教練自助路由區之後加 5 個方案路由**

插入位置：`app.post('/api/coach/me/avatar', ...)` 路由區塊結束的 `}));` 之後、`// --- Public (no auth): anon booking / group orders / phone lookup ---`（約第 807 行）之前。**錨定在 avatar 路由結尾**（unique），不要錨在 `// --- Public`（檔案前段另有 `// --- Public ---` 會誤中）。

```js
// --- 方案（套餐）：教練/管理者管理客人方案 ---
app.post('/api/coach/packages', requireCoach, asyncHandler((req, res) => {
  const { memberId, sessionType, totalSessions, amount, expiresAt, note } = req.body || {};
  res.status(201).json(svcCreatePackage({
    memberId: Number(memberId), sessionType, totalSessions, amount, expiresAt, note, createdBy: req.user.id,
  }));
}));

app.get('/api/coach/packages', requireCoach, asyncHandler((req, res) => {
  const memberId = Number(req.query.memberId);
  if (!memberId) return res.status(400).json({ error: 'missing_member' });
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  res.json(svcListPackages(memberId, { includeArchived }));
}));

app.patch('/api/coach/packages/:id', requireCoach, asyncHandler((req, res) => {
  const { remaining, note } = req.body || {};
  if (remaining == null) return res.status(400).json({ error: 'missing_remaining' });
  res.json(svcAdjustRemaining({ packageId: Number(req.params.id), remaining, note: note ?? null }));
}));

app.post('/api/coach/packages/:id/archive', requireCoach, asyncHandler((req, res) => {
  res.json(svcArchivePackage(Number(req.params.id)));
}));

app.post('/api/coach/packages/:id/restore', requireCoach, asyncHandler((req, res) => {
  res.json(svcRestorePackage(Number(req.params.id)));
}));
```

- [ ] **Step 3：寫 api 測試 `tests/package-api.test.js`**

```js
// API：方案端點（需 running server + seed admin）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[package-api] start');
const clean = () => db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pkapi-%'); DELETE FROM users WHERE email LIKE 'pkapi-%'");
clean();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入取得 token', () => assert.ok(token));

const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('PK客','pkapi-m@x.com','0962000001','user')").run().lastInsertRowid);

let pkgId;
const c1 = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, sessionType: '1on1', totalSessions: 10, amount: 15000, expiresAt: '2099-12-31', note: '十堂包' } });
expect('建立方案 → 201 + remaining=total + is_valid', () => {
  assert.equal(c1.status, 201);
  assert.equal(c1.data.remaining_sessions, 10);
  assert.equal(c1.data.total_sessions, 10);
  assert.equal(c1.data.is_valid, true);
  pkgId = c1.data.id;
});

const c2 = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, sessionType: 'x', totalSessions: 5 } });
expect('類型錯 → 400 invalid_session_type', () => { assert.equal(c2.status, 400); assert.equal(c2.data.error, 'invalid_session_type'); });

const g = await req('GET', `/api/coach/packages?memberId=${mid}`, { token });
expect('GET 清單含該方案', () => { assert.equal(g.status, 200); assert.ok(g.data.some(p => p.id === pkgId)); });

const gNo = await req('GET', '/api/coach/packages', { token });
expect('GET 無 memberId → 400 missing_member', () => { assert.equal(gNo.status, 400); assert.equal(gNo.data.error, 'missing_member'); });

const pa = await req('PATCH', `/api/coach/packages/${pkgId}`, { token, body: { remaining: 7 } });
expect('調整剩餘 → 200 remaining=7', () => { assert.equal(pa.status, 200); assert.equal(pa.data.remaining_sessions, 7); });

const paBad = await req('PATCH', `/api/coach/packages/${pkgId}`, { token, body: { remaining: 99 } });
expect('調整超過 total → 400 invalid_remaining', () => { assert.equal(paBad.status, 400); assert.equal(paBad.data.error, 'invalid_remaining'); });

const ar = await req('POST', `/api/coach/packages/${pkgId}/archive`, { token });
expect('作廢 → 200 archived_at 有值 + is_valid=false', () => { assert.equal(ar.status, 200); assert.ok(ar.data.archived_at); assert.equal(ar.data.is_valid, false); });

const re = await req('POST', `/api/coach/packages/${pkgId}/restore`, { token });
expect('還原 → 200 archived_at=null + is_valid=true', () => { assert.equal(re.status, 200); assert.equal(re.data.archived_at, null); assert.equal(re.data.is_valid, true); });

const noAuth = await req('POST', '/api/coach/packages', { body: { memberId: mid, sessionType: '1on1', totalSessions: 5 } });
expect('未登入 → 401', () => assert.equal(noAuth.status, 401));

// requireCoach 守門：role=user 會員無法登入 → 直接塞一個有效 session token（年份 2099 遠大於 UTC now）。
// 測試端與 server 共用同一個 data/app.db，session 立即可見。
const memberToken = 'pkapi-token-' + mid;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00')").run(memberToken, mid);
const roleGate = await req('POST', '/api/coach/packages', { token: memberToken, body: { memberId: mid, sessionType: '1on1', totalSessions: 5 } });
expect('role=user 用方案端點 → 403 coach_only', () => { assert.equal(roleGate.status, 403); assert.equal(roleGate.data.error, 'coach_only'); });
db.prepare("DELETE FROM auth_sessions WHERE token=?").run(memberToken);

clean();
console.log('[package-api] done');
```

- [ ] **Step 4：把 api 測試掛進 `package.json` 的 `test:api` 腳本**

在 `"test:api"` 字串最末（`&& node tests/public-line-bind-api.test.js` 之後）加：
```
 && node tests/package-api.test.js
```

- [ ] **Step 5：起 server 跑 api 測試確認通過**

Run:
```bash
(LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 PORT=3000 node src/server.js & SRV=$!; sleep 1.5; node tests/package-api.test.js; kill $SRV)
```
Expected: 全部 `✓`，無 `✗`，`[package-api] done`。（若 `admin 登入取得 token` 失敗，先 `npm run seed && node src/db/seed-demo.js` 再重跑。）

- [ ] **Step 6：Commit**

```bash
git add src/server.js tests/package-api.test.js package.json
git commit -m "feat(package): 方案 HTTP 端點 + api 測試"
```

---

## Task 5：會員管理「方案」區塊（admin.js）

**Files:**
- Modify: `public/admin.js`（`openUserEditModal` 內掛載「方案」區塊 + 新 render/handler 函式）

**Interfaces:**
- Consumes: 既有 `api(path,{method,body})`（throw 帶 `.data.error`/`.message`）、`toast`、`escapeHtml`、`api('/api/coach/packages?memberId=...')`。
- Produces: 會員編輯彈窗顯示該客人方案清單＋新增/調整/作廢/還原（純前端；無 JS 單元測試，靠瀏覽器 smoke 驗證）。

- [ ] **Step 1：在 `openUserEditModal` 的 `body.innerHTML = ...` 模板尾端，於最後一個 `${archived ? ... : ''}` 之後，加方案掛載點**

把模板結尾：
```js
    ${archived ? '<p class="subtle" style="font-size:12px;margin-top:10px;">此會員已封存（僅後台列表隱藏；本人前台仍可查詢，下次同電話預約會自動還原）。</p>' : ''}`;
```
改為：
```js
    ${archived ? '<p class="subtle" style="font-size:12px;margin-top:10px;">此會員已封存（僅後台列表隱藏；本人前台仍可查詢，下次同電話預約會自動還原）。</p>' : ''}
    <div id="ue-packages" style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:12px;"></div>`;
```

- [ ] **Step 2：在 `openUserEditModal` 內 `ov.style.display = 'grid';` 之後，呼叫方案區塊渲染**

> 注意：`ov.style.display = 'grid';` 在 admin.js 出現兩次（另一處在說明彈窗），Edit 必須帶前後文消歧。用 Step 1 加的 `#ue-packages` 行當錨點。把：
```js
    <div id="ue-packages" style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:12px;"></div>`;
  ov.style.display = 'grid';
```
改為：
```js
    <div id="ue-packages" style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:12px;"></div>`;
  ov.style.display = 'grid';
  renderMemberPackages(id, body.querySelector('#ue-packages'));
```

- [ ] **Step 3：在 `openUserEditModal` 函式「之後」新增 `renderMemberPackages`**

```js
const PKG_TYPE_LABEL = { '1on1': '一對一', '1on2': '一對二' };

async function renderMemberPackages(memberId, mountEl) {
  if (!mountEl) return;
  mountEl.innerHTML = '<p class="subtle" style="font-size:12px;">載入方案中…</p>';
  let pkgs = [];
  try { pkgs = await api(`/api/coach/packages?memberId=${memberId}&includeArchived=1`); }
  catch { mountEl.innerHTML = '<p class="subtle" style="font-size:12px;color:#dc2626;">方案載入失敗</p>'; return; }

  const rowHtml = pkgs.map(p => {
    const arch = !!p.archived_at;
    const badge = arch ? '<span class="badge badge-cancelled" style="font-size:10px;">已作廢</span>'
      : p.is_valid ? '<span class="badge" style="font-size:10px;background:#dcfce7;color:#166534;">有效</span>'
      : '<span class="badge" style="font-size:10px;background:#fef9c3;color:#854d0e;">已失效</span>';
    const exp = p.expires_at ? `到期 ${p.expires_at}` : '永久';
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:13px;">
        <strong>${PKG_TYPE_LABEL[p.session_type] || p.session_type}</strong> ${p.remaining_sessions}/${p.total_sessions} 堂 ${badge}
        <div class="subtle" style="font-size:11px;">${exp}${p.amount != null ? ` · NT$${p.amount}` : ''}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" data-act="adjust" data-id="${p.id}" data-total="${p.total_sessions}" data-remaining="${p.remaining_sessions}">調整</button>
        ${arch
          ? `<button class="btn btn-ghost btn-sm" data-act="restore" data-id="${p.id}">還原</button>`
          : `<button class="btn btn-danger btn-sm" data-act="archive" data-id="${p.id}">作廢</button>`}
      </div>
    </div>`;
  }).join('') || '<p class="subtle" style="font-size:12px;">尚無方案</p>';

  mountEl.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:6px;">方案（套餐）</div>
    <div id="pkg-list">${rowHtml}</div>
    <details style="margin-top:8px;">
      <summary style="font-size:13px;cursor:pointer;color:#0284c7;">＋ 新增方案</summary>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">
        <select id="pkg-type" class="form-select" style="margin:0;"><option value="1on1">一對一</option><option value="1on2">一對二</option></select>
        <input id="pkg-total" class="form-input" type="number" min="1" placeholder="堂數" style="margin:0;" />
        <input id="pkg-amount" class="form-input" type="number" min="0" placeholder="金額（可空）" style="margin:0;" />
        <input id="pkg-expiry" class="form-input" type="date" style="margin:0;" />
      </div>
      <input id="pkg-note" class="form-input" placeholder="備註（可空）" style="margin:6px 0 0;" />
      <button id="pkg-create" class="btn btn-primary btn-sm" style="margin-top:8px;">建立方案</button>
    </details>`;

  // 建立
  mountEl.querySelector('#pkg-create')?.addEventListener('click', async () => {
    const total = Number(mountEl.querySelector('#pkg-total').value);
    if (!Number.isInteger(total) || total <= 0) { toast('請填正確堂數', 'error'); return; }
    const amountRaw = mountEl.querySelector('#pkg-amount').value;
    const expiry = mountEl.querySelector('#pkg-expiry').value;
    try {
      await api('/api/coach/packages', { method: 'POST', body: {
        memberId, sessionType: mountEl.querySelector('#pkg-type').value, totalSessions: total,
        amount: amountRaw === '' ? null : Number(amountRaw),
        expiresAt: expiry || null, note: mountEl.querySelector('#pkg-note').value || null,
      }});
      toast('方案已建立', 'success');
      renderMemberPackages(memberId, mountEl);
    } catch (e) {
      const msgs = { invalid_total: '堂數不正確', invalid_amount: '金額不正確', invalid_expires_at: '到期日格式錯', invalid_session_type: '類型不正確' };
      toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
    }
  });

  // 調整 / 作廢 / 還原
  mountEl.querySelector('#pkg-list')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;
    try {
      if (act === 'adjust') {
        const total = Number(btn.dataset.total);
        const cur = Number(btn.dataset.remaining);
        const input = prompt(`調整剩餘堂數（0–${total}）`, String(cur));
        if (input == null) return;
        const r = Number(input);
        if (!Number.isInteger(r) || r < 0 || r > total) { toast('堂數需為 0–' + total, 'error'); return; }
        await api(`/api/coach/packages/${id}`, { method: 'PATCH', body: { remaining: r } });
        toast('已調整剩餘堂數', 'success');
      } else if (act === 'archive') {
        if (!confirm('確定作廢此方案？作廢後不可再扣抵（剩餘堂數保留紀錄）。')) return;
        await api(`/api/coach/packages/${id}/archive`, { method: 'POST' });
        toast('已作廢', 'success');
      } else if (act === 'restore') {
        await api(`/api/coach/packages/${id}/restore`, { method: 'POST' });
        toast('已還原', 'success');
      }
      renderMemberPackages(memberId, mountEl);
    } catch (e) {
      const msgs = { invalid_remaining: '剩餘堂數超出範圍', package_not_found: '找不到方案' };
      toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
    }
  });
}
```

- [ ] **Step 4：瀏覽器 smoke（手動）**

起 server（mock）後以 admin 身份登入後台 → 會員管理 → 長按一位會員 → 確認「方案」區塊出現：新增一個一對一 10 堂方案 → 列表出現「一對一 10/10 堂 有效」；點「調整」改 7 → 顯示 7/10；「作廢」→ 顯示「已作廢」；「還原」→ 回「有效」。Console 無錯誤。

> 此步驟在 PR 收尾統一以瀏覽器工具執行；本任務先確保程式碼正確即可進入審查。

- [ ] **Step 5：Commit**

```bash
git add public/admin.js
git commit -m "feat(package): 會員管理彈窗 方案區塊（新增/調整/作廢/還原）"
```

---

## 與 spec 的刻意差異（審查後確認）

1. **`createBookingCore` 不在 PR1 改**。spec 原文把 `package_id`/`paid_at`/`paid_by`/每堂 `original_amount` 的「蓋章」寫成「`createBookingCore` 加 `packageId` 參數」並列在 PR1。本計畫**延到 PR2 的登錄 register service**做（沿用既有 discount 的「建立後 `UPDATE bookings SET ...`」樣式，與 `createBookingAnon`/`createRecurringBookings` 一致），因為 PR1 沒有任何呼叫端會建立方案預約——在 PR1 加會是死碼。PR1 只負責：方案表/CRUD、`deductOne`/`refundOne` 原語、**取消時回補**、會員管理 UI。PR2 計畫會明確包含登錄時的 `package_id`/`paid_at`/`original_amount` 蓋章 + `deductOne`。
2. **`adjustRemaining({ packageId, remaining, note })`**：spec 寫 `actorId, reason`，本計畫依 spec 自己的「簡化：直接更新 remaining，附 note」改用 `note`、不存 actorId（無稽核軌）。端點/UI 一致用 `note`；PR2 不依賴 actorId。

## Self-Review（plan 作者自檢，已執行；含對抗式審查回饋）

**Spec 覆蓋**：方案表/欄位（Task1）、CRUD＋扣抵/回補（Task2）、取消回補 6 條路徑（Task3）、端點（Task4）、會員管理 UI（Task5）。PR1 範圍覆蓋完整，**唯一刻意延後**為上述 #1 的登錄蓋章（→PR2）。「彈窗內開方案」屬 PR2 登錄彈窗，PR1 先把端點＋會員管理入口做好（登錄彈窗重用同端點）。

**Placeholder 掃描**：無 TBD/TODO；每個改碼步驟皆附完整程式碼與確切（消歧後的）插入位置。

**型別一致性**：`createPackage/getPackage/listPackagesForMember/listValidPackagesForMember/adjustRemaining/archive/restore/deductOne/refundOne` 簽章在 Task2 定義，Task3（`refundOne`）、Task4（端點）、Task5（前端呼叫與回傳欄位 `is_valid`/`remaining_sessions`/`total_sessions`/`session_type`/`amount`/`expires_at`/`archived_at`）一致。`refundPackageForBooking` 僅 bookingService 內部用。

**回補恰一次（防雙重回補）**：`refundOne` 用 `WHERE remaining_sessions < total_sessions`（精準契約）；各取消路徑只在「confirmed→cancelled」轉移當下回補（`cancelBooking*` 已過 already_cancelled 守門、`refundBookingAdmin` 限 `wasConfirmed`、group 路徑限 `status='confirmed'`）。Task3 第二測試以「扣兩次起跳、斷言維持 4」確保封頂不遮蔽雙重回補 bug。

**測試健全性**：env mock 於呼叫時讀取（late set 可行）；`DELETE FROM bookings` 前先清 `point_transactions`（FK ON）；api 測試補 `requireCoach` 403（role=user 塞 2099 session）；整合測試 coach 以 `display_name LIKE '回補%'` 取得（不依賴既有資料）。
