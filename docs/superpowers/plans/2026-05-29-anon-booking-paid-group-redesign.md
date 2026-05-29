# 匿名預約 + 付費團體課 + 電話查詢 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客人用「姓名+電話」匿名預約 1v1（現場收費）與團體課（選場次→匯款→admin 核對）；只有 admin/coach 登入；移除點數機制改用單堂價格。

**Architecture:** 三階段、單一 feature branch `feature/anon-paid-group-redesign`、每階段 draft-PR + 手動 smoke gate 後合併。Phase A 後端（schema migration + 公開 service/endpoints + 點數拆除 + sweep/遞補）、Phase B admin（待核對匯款 + 價格欄位 + 點數 UI 移除 + 教練帳號建立）、Phase C 前端 cutover。

**Tech Stack:** Node 24 ESM、Express 4、`node:sqlite`（DatabaseSync、WAL、手動 `tx()`）、hand-rolled `node:assert/strict` 測試、LINE Messaging API。

**Spec:** `docs/superpowers/specs/2026-05-29-anon-booking-paid-group-redesign-design.md`

---

## File Structure

**新增**
- `src/services/userService.js` — `findOrCreateUserByPhone` / `getUserByPhoneAndName` / `validatePhone`
- `src/services/groupOrderService.js` — 團體課訂單：容量計算、建單、核對、取消、遞補、逾時 sweep、公開課表/課程列表
- `tests/user-service.test.js`、`tests/group-order-service.test.js`、`tests/public-api.test.js`、`tests/migration.test.js`

**修改**
- `src/db/schema.js` — email nullable、`registrations` 加 `pending`/`order_id`/`amount_due`、`course_templates.price_per_session`、新 `group_orders` 表、`idx_users_phone`
- `src/db/connection.js` — migration block（兩個整表 rebuild + 新表 + 新欄位 + 新 index）
- `src/services/bookingService.js` — 移除點數；加 `createBookingAnon`/`cancelBookingAnon`
- `src/services/registration.js` — 移除點數（保留 `ApiError`）
- `src/services/courseService.js` — 移除 `session_refund` 點數；加 `price_per_session`
- `src/services/auth.js` — `login()` 擋 `role='user'`
- `src/services/notifications.js` — 加 `payment_received`、`group_promoted` 兩個 template
- `src/scheduler.js` — 加 expire-orders cron
- `src/server.js` — 加 7 支 `/api/public/*`、admin group-order endpoints、expire-orders job；移除 register/member/points 路由；`/api/admin/users` 去除 balance
- `src/db/seed.js` — `price_per_session`（若 seed template）
- 前端：`public/app.js`、`index.html`、`coaches.html`/`coaches.js`、`my-schedule.html`/`my-schedule.js`、`admin.html`/`admin.js`、`login.html`；刪 `register.html`、`line.html`

**移除點數但保留資料**：刪 `src/services/pointService.js`、`member_point_balance` view、點數 endpoints/UI；**`point_transactions` 表保留**（不寫不讀）。

---

## 注意事項（所有 worker 必讀）

- DB 是 `node:sqlite` `DatabaseSync`，**同步** API。寫入一律包在 `tx(fn)`（`src/db/connection.js`，`BEGIN IMMEDIATE`，可巢狀）。
- 時間字串用 wall-clock local 格式 `YYYY-MM-DDTHH:MM:SS`，用 `nowLocal()` / `offsetLocal(ms)`（`connection.js`），**不要**用 `new Date().toISOString()` 存 DB。
- 服務層錯誤丟 `ApiError`（`src/services/registration.js` 匯出），`server.js` 的 `handleError` 會轉成 `{ error: code }` + status。
- Service-level 測試直接 `import { db } from '../src/db/connection.js'`，用 `reset()` 清表後操作；跑法 `node tests/xxx.test.js`，失敗時 `process.exitCode=1`。
- API 測試需要先啟動 server（另一個 process）：`NODE_ENV` 不設 / 設 `BASE`。本機跑：terminal A `npm start`，terminal B `node tests/public-api.test.js`。
- 每個 task 結束 commit。commit message 結尾不需簽名（這是本地 feature branch）。

---

# Phase A — 後端

## Task A1: Schema 與 Migration

**Files:**
- Modify: `src/db/schema.js`
- Modify: `src/db/connection.js`
- Test: `tests/migration.test.js`

- [ ] **Step 1: 改 `schema.js` 的 fresh-create**

`src/db/schema.js`：
1. `users` 表把 `email TEXT UNIQUE NOT NULL` 改成 `email TEXT UNIQUE`。
2. 在 `users` 表 DDL 之後、`auth_sessions` 之前，加電話唯一索引：
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
```
3. `course_templates` 表加一欄（放在 `status` 之後、`created_at` 之前）：
```sql
  price_per_session INTEGER NOT NULL DEFAULT 0,
```
4. 在 `course_sessions` DDL 之前，新增 `group_orders` 表（讓 registrations 的 FK 目標先定義，可讀性）：
```sql
CREATE TABLE IF NOT EXISTS group_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_orders_status ON group_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_group_orders_member ON group_orders(member_id);
```
5. `registrations` 表：`status` CHECK 改成含 `pending`，並加兩欄：
```sql
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','waitlisted','cancelled','rejected')),
  position INTEGER,
  order_id INTEGER REFERENCES group_orders(id),
  amount_due INTEGER,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, user_id)
);
```
6. **刪除 `member_point_balance` view 定義**（現 schema.js lines 185-195）。`point_transactions` 表與其索引**保留**（資料存查、不再寫入）。否則 `db.exec(SCHEMA)` 會每次開機重建這個已棄用的 view、又被 migration 立刻 drop，徒增 churn。

- [ ] **Step 2: 寫 migration block 到 `connection.js`**

在 `db.exec(PHASE_3C_INDEXES);`（line 45）**之後**、`nowLocal`/`tx` 定義之前，插入：

```js
// ── 2026-05 anon-booking redesign migration ──────────────────────────
// (a) group_orders 表（SCHEMA 已含 CREATE IF NOT EXISTS，這裡確保舊 DB 也有；
//     必須在 registrations rebuild 之前存在，因 registrations FK 指向它)
// (b) registrations: 加 pending 狀態 + order_id/amount_due → 整表 rebuild
// (c) users: email DROP NOT NULL → 整表 rebuild（同時 DROP 已棄用的 view）
// (d) course_templates.price_per_session
// 偵測訊號各自獨立，重跑為 no-op (idempotent)。

// (b) registrations rebuild — 以 order_id 欄位是否存在當偵測訊號
const regCols = db.prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);
if (!regCols.includes('order_id')) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE registrations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','waitlisted','cancelled','rejected')),
        position INTEGER,
        order_id INTEGER REFERENCES group_orders(id),
        amount_due INTEGER,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, user_id)
      )`);
    db.exec(`
      INSERT INTO registrations_new (id, session_id, user_id, status, position, registered_at)
      SELECT id, session_id, user_id, status, position, registered_at FROM registrations`);
    db.exec('DROP TABLE registrations');
    db.exec('ALTER TABLE registrations_new RENAME TO registrations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_reg_session_status ON registrations(session_id, status)');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[migrate] registrations rebuilt (pending status + order_id/amount_due)');
}

// (c) users email nullable — 以 email 欄 notnull 旗標當偵測訊號
const emailCol = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
if (emailCol && emailCol.notnull === 1) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec('DROP VIEW IF EXISTS member_point_balance');
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT,
        password_hash TEXT,
        google_id TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        notification_preference TEXT NOT NULL DEFAULT 'email',
        line_user_id TEXT,
        line_bind_code TEXT,
        line_bind_expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    db.exec(`
      INSERT INTO users_new (id, name, email, phone, password_hash, google_id, role,
        notification_preference, line_user_id, line_bind_code, line_bind_expires_at, created_at)
      SELECT id, name, email, phone, password_hash, google_id, role,
        notification_preference, line_user_id, line_bind_code, line_bind_expires_at, created_at
      FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id ON users(line_user_id) WHERE line_user_id IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[migrate] users rebuilt (email nullable, view dropped)');
}

// 確保 view 在已是 nullable 的 DB 也被移除（rebuild 分支沒跑到時）
db.exec('DROP VIEW IF EXISTS member_point_balance');

// (d) price_per_session
addColumnIfMissing('course_templates', 'price_per_session', 'INTEGER NOT NULL DEFAULT 0');
```

> 注意：`group_orders` 與 `idx_users_phone` 對「已經是 nullable 的 fresh DB」由 `SCHEMA` 建立；對「舊 prod DB」由上面 users rebuild 分支建立。若某 DB 既非 fresh、email 又已 nullable（理論上不會發生），`idx_users_phone` 仍由 `SCHEMA` 的 `CREATE INDEX IF NOT EXISTS` 補上。

- [ ] **Step 3: 寫 migration 測試（先確認會失敗）**

`tests/migration.test.js`：建一個帶「舊 schema」的暫存 DB，import connection.js 觸發 migration，驗證升級結果與資料保留。

```js
// 驗證舊 DB（email NOT NULL、registrations 無 pending/order_id）升級後正確
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbPath = join(tmpdir(), `migration-test-${process.pid}.db`);
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

// 1) 建立「舊 schema」DB（email NOT NULL、registrations 舊 CHECK、無 group_orders）
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL, phone TEXT, password_hash TEXT, google_id TEXT,
    role TEXT NOT NULL DEFAULT 'user', notification_preference TEXT NOT NULL DEFAULT 'email',
    line_user_id TEXT, line_bind_code TEXT, line_bind_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE course_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
  CREATE TABLE course_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, min_capacity INTEGER NOT NULL, max_capacity INTEGER NOT NULL, day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 60, recurrence TEXT NOT NULL, cycle_start_date TEXT NOT NULL, cycle_end_date TEXT NOT NULL, registration_deadline_hours INTEGER NOT NULL DEFAULT 24, status TEXT NOT NULL DEFAULT 'published', created_at TEXT);
  CREATE TABLE course_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL REFERENCES course_templates(id) ON DELETE CASCADE, session_date TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, registration_deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', confirmed_count INTEGER NOT NULL DEFAULT 0, waitlist_count INTEGER NOT NULL DEFAULT 0, UNIQUE(template_id, session_date));
  CREATE TABLE registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('confirmed','waitlisted','cancelled','rejected')), position INTEGER, registered_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(session_id, user_id));
  INSERT INTO users (name, email, phone, role) VALUES ('Old User', 'old@x.com', '0912345678', 'user');
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence, cycle_start_date, cycle_end_date) VALUES ('Old Class', 1, 5, 1, '19:00', 'weekly', '2026-01-01', '2026-12-31');
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline) VALUES (1, '2026-06-01', '2026-06-01T19:00:00', '2026-06-01T20:00:00', '2026-05-31T19:00:00');
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline) VALUES (1, '2026-06-08', '2026-06-08T19:00:00', '2026-06-08T20:00:00', '2026-06-07T19:00:00');
  INSERT INTO registrations (session_id, user_id, status) VALUES (1, 1, 'confirmed');
`);
old.close();

// 2) 設定 DB_PATH 後 import connection（觸發 migration）
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[migration test] start');

const emailCol = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
expect('users.email is now nullable', () => assert.equal(emailCol.notnull, 0));

const regCols = db.prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);
expect('registrations has order_id', () => assert(regCols.includes('order_id')));
expect('registrations has amount_due', () => assert(regCols.includes('amount_due')));

expect('group_orders table exists', () =>
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='group_orders'").get()));

expect('idx_users_phone exists', () =>
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_phone'").get()));

const tplCols = db.prepare('PRAGMA table_info(course_templates)').all().map((c) => c.name);
expect('course_templates has price_per_session', () => assert(tplCols.includes('price_per_session')));

expect('member_point_balance view dropped', () =>
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='member_point_balance'").get()));

// 資料保留
expect('user row preserved', () => assert.equal(db.prepare('SELECT name FROM users WHERE id=1').get().name, 'Old User'));
expect('registration row preserved', () => assert.equal(db.prepare('SELECT status FROM registrations WHERE id=1').get().status, 'confirmed'));

// pending status 現在可插入
expect('pending registration allowed', () => {
  db.prepare("INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, expires_at) VALUES (1,'Old User','0912345678',500,'2026-06-01T00:00:00')").run();
  const oid = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO registrations (session_id, user_id, status, order_id, amount_due) VALUES (2,1,'pending',?,500)").run(oid);
});

console.log('[migration test] done');
```

Run: `node tests/migration.test.js`
Expected (before Step 1/2 implemented): FAIL（缺欄位/表）。

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/migration.test.js`
Expected: 全部 ✓，`[migration test] done`，exit 0。

- [ ] **Step 5: 確認 fresh DB 也正常開**

Run: `DB_PATH=/tmp/fresh-test.db node -e "import('./src/db/connection.js').then(()=>{console.log('fresh ok')})"`
Expected: `fresh ok`，無 error。清理：`rm -f /tmp/fresh-test.db*`

- [ ] **Step 6: Commit**
```bash
git add src/db/schema.js src/db/connection.js tests/migration.test.js
git commit -m "feat(db): migrate to nullable email, group_orders, registration pending status, template price"
```

---

## Task A2: `userService` — 電話識別

**Files:**
- Create: `src/services/userService.js`
- Test: `tests/user-service.test.js`

- [ ] **Step 1: 寫測試（先失敗）**

`tests/user-service.test.js`：
```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { findOrCreateUserByPhone, getUserByPhoneAndName, validatePhone } from '../src/services/userService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec("DELETE FROM users WHERE phone LIKE '0999%'");
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[user-service test] start');
reset();

// validatePhone
expect('accepts 8-15 digits', () => assert.equal(validatePhone('0999000111'), true));
expect('rejects with dashes', () => assert.equal(validatePhone('0999-000-111'), false));
expect('rejects too short', () => assert.equal(validatePhone('099'), false));

// create
const u1 = findOrCreateUserByPhone({ phone: '0999000111', name: '小明' });
expect('creates user', () => assert(u1.id));
expect('role=user', () => assert.equal(u1.role, 'user'));
expect('email null', () => assert.equal(u1.email, null));

// reuse + name NOT overwritten
const u2 = findOrCreateUserByPhone({ phone: '0999000111', name: '改名了' });
expect('reuses same id', () => assert.equal(u2.id, u1.id));
expect('name unchanged (first-write-wins)', () => assert.equal(u2.name, '小明'));

// invalid phone
expect('invalid phone throws 400', () => {
  try { findOrCreateUserByPhone({ phone: 'abc', name: 'x' }); assert.fail('no throw'); }
  catch (e) { assert(e instanceof ApiError); assert.equal(e.status, 400); }
});

// getUserByPhoneAndName: trim + case-insensitive
expect('lookup matches trimmed/case', () => {
  const got = getUserByPhoneAndName({ phone: '0999000111', name: '  小明 ' });
  assert(got && got.id === u1.id);
});
expect('lookup wrong name → null', () =>
  assert.equal(getUserByPhoneAndName({ phone: '0999000111', name: '別人' }), null));
expect('lookup unknown phone → null', () =>
  assert.equal(getUserByPhoneAndName({ phone: '0999999999', name: 'x' }), null));

console.log('[user-service test] done');
```

Run: `node tests/user-service.test.js` → FAIL（module not found）。

- [ ] **Step 2: 實作 `userService.js`**
```js
import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const PHONE_RE = /^\d{8,15}$/;
export function validatePhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

const getByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const insertUser = db.prepare(
  "INSERT INTO users (name, phone, email, password_hash, role, notification_preference) VALUES (?, ?, NULL, NULL, 'user', 'email')"
);
const getById = db.prepare('SELECT * FROM users WHERE id = ?');

/**
 * 用電話找帳號；找到就回（姓名不覆蓋，首次為準），找不到就建。
 * 包在 tx 內以避免同電話並發雙插（idx_users_phone 也會擋）。
 */
export function findOrCreateUserByPhone({ phone, name }) {
  if (!validatePhone(phone)) throw new ApiError(400, 'invalid_phone');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  return tx(() => {
    const existing = getByPhone.get(phone);
    if (existing) return existing;
    try {
      const info = insertUser.run(name.trim(), phone);
      return getById.get(info.lastInsertRowid);
    } catch (e) {
      // 並發下另一請求先插了同電話 → 重查
      if (String(e.message).includes('UNIQUE')) return getByPhone.get(phone);
      throw e;
    }
  });
}

/** 查詢用：電話完全相符 + 姓名 trim/大小寫不敏感相符。找不到回 null。 */
export function getUserByPhoneAndName({ phone, name }) {
  if (!validatePhone(phone) || !name || !name.trim()) return null;
  const u = getByPhone.get(phone);
  if (!u || !u.name) return null;
  return u.name.trim().toLowerCase() === name.trim().toLowerCase() ? u : null;
}
```

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/user-service.test.js`
Expected: 全部 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/userService.js tests/user-service.test.js
git commit -m "feat(user): findOrCreateUserByPhone + phone+name lookup"
```

---

## Task A3: 移除 bookingService 點數 + 加匿名 1v1

**Files:**
- Modify: `src/services/bookingService.js`
- Test: `tests/booking-anon.test.js`

- [ ] **Step 1: 寫測試（先失敗）**

`tests/booking-anon.test.js`：
```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createBookingAnon, cancelBookingAnon } from '../src/services/bookingService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'anon-bk-%' OR phone LIKE '0998%');
    DELETE FROM bookings;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'anon-bk-%' OR phone LIKE '0998%';
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function futureLocal(days, hh=10) {
  const d = new Date(); d.setDate(d.getDate()+days);
  const p=(n)=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`;
}

console.log('[booking-anon test] start');
reset();

const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach U','anon-bk-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'Coach U' });
setCoachActive(coach.id, true);

const startAt = futureLocal(5);

// 匿名建立預約 → 同時建 user
const r = createBookingAnon({ coachId: coach.id, startAt, name: '阿華', phone: '0998000111' });
expect('booking created', () => assert(r.id));
expect('user auto-created', () => {
  const u = db.prepare("SELECT * FROM users WHERE phone='0998000111'").get();
  assert(u && u.name === '阿華' && u.role === 'user');
});
expect('NO point_transactions for this booking', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM point_transactions WHERE related_booking_id = ?").get(r.id).c;
  assert.equal(c, 0);
});

// 重複時段 → 409 slot_taken
expect('double-book 409', () => {
  try { createBookingAnon({ coachId: coach.id, startAt, name: '別人', phone: '0998000222' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'slot_taken'); }
});

// 取消：電話+姓名要對
expect('cancel wrong name → 403', () => {
  try { cancelBookingAnon({ bookingId: r.id, phone: '0998000111', name: '錯名' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});
expect('cancel correct → ok', () => {
  const res = cancelBookingAnon({ bookingId: r.id, phone: '0998000111', name: '阿華' });
  assert.equal(res.ok, true);
});
expect('slot bookable again', () => {
  const r2 = createBookingAnon({ coachId: coach.id, startAt, name: '阿華', phone: '0998000111' });
  assert(r2.id);
});

console.log('[booking-anon test] done');
```

Run: `node tests/booking-anon.test.js` → FAIL。

- [ ] **Step 2: 重構 `bookingService.js`**

把 `createBooking` 的核心抽成 `createBookingCore`（不碰點數），原 `createBooking` 移除 `recordTransaction`，新增 anon 版本。

- 移除 `import { recordTransaction } from './pointService.js';`
- 加 `import { findOrCreateUserByPhone, getUserByPhoneAndName } from './userService.js';`（放在檔案 import 區）
- 把 `createBooking` 改寫為：
```js
// 核心建單：寫 bookings + 通知教練/會員。不碰點數。
function createBookingCore({ coach, memberId, startAt, note }) {
  const endAt = addMinutes(startAt, 60);
  let bookingId;
  try {
    const info = insertBookingStmt.run(coach.id, memberId, startAt, endAt, note);
    bookingId = info.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
    throw e;
  }
  const memberRow = getUserNameStmt.get(memberId);
  if (memberRow) {
    const startFmt = fmtDateForLine(startAt);
    notify({ userId: coach.user_id, sessionId: null, type: 'booking_created',
      vars: { member_name: memberRow.name, start_at: startFmt } });
    notify({ userId: memberId, sessionId: null, type: 'booking_confirmed',
      vars: { coach_display_name: coach.display_name, start_at: startFmt } });
  }
  return { id: bookingId, startAt, endAt };
}

export function createBooking({ coachId, memberId, startAt, note = null }) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => createBookingCore({ coach, memberId, startAt, note }));
}

export function createBookingAnon({ coachId, startAt, name, phone, note = null }) {
  if (!coachId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });
    return createBookingCore({ coach, memberId: user.id, startAt, note });
  });
}
```
- `cancelBooking`：移除 `recordTransaction` 整段（line 122-128），其餘（通知、狀態）保留。
- 新增 anon 取消：
```js
export function cancelBookingAnon({ bookingId, phone, name }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    const user = getUserByPhoneAndName({ phone, name });
    if (!user || user.id !== b.member_id) throw new ApiError(403, 'forbidden');
    cancelBookingStmt.run(nowLocal(), user.id, null, bookingId);
    const coach = getCoachStmt.get(b.coach_id);
    const memberRow = getUserNameStmt.get(b.member_id);
    if (coach && memberRow) {
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_member',
        vars: { member_name: memberRow.name, start_at: fmtDateForLine(b.start_at) } });
    }
    return { ok: true };
  });
}
```

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/booking-anon.test.js`
Expected: 全部 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/bookingService.js tests/booking-anon.test.js
git commit -m "feat(booking): anon 1v1 booking (no points), drop point deduct/refund"
```

---

## Task A4: `groupOrderService` — 容量 + 建單

**Files:**
- Create: `src/services/groupOrderService.js`
- Test: `tests/group-order-service.test.js`

- [ ] **Step 1: 寫測試（建單 + 容量 + all-or-nothing + 候補）**

`tests/group-order-service.test.js`（本 task 先寫建單相關，後續 task 追加）：
```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { createGroupOrder, sessionOccupied, BANK_INFO } from '../src/services/groupOrderService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec(`
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM users WHERE phone LIKE '0997%';
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function dstr(days) { const d=new Date(); d.setDate(d.getDate()+days); const p=(n)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }

console.log('[group-order-service test] start');
reset();

// 建一個 cap=2、price=500 的 template（產生數個 future sessions）
const tpl = createTemplate({
  name: 'TRX班', min_capacity: 1, max_capacity: 2,
  day_of_week: ((new Date()).getDay()+2)%7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(60),
  registration_deadline_hours: 1, price_per_session: 500,
});
const sessions = db.prepare("SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC").all(tpl.templateId);
const s1 = sessions[0].id, s2 = sessions[1].id;

// 建單：選 2 場（都有空）
const o1 = createGroupOrder({ name: '甲', phone: '0997000001', paySessionIds: [s1, s2], waitlistSessionIds: [] });
expect('order created', () => assert(o1.orderId));
expect('total = 2*500', () => assert.equal(o1.total, 1000));
expect('bankInfo present', () => assert(o1.bankInfo && o1.bankInfo === BANK_INFO));
expect('expiresAt present', () => assert(typeof o1.expiresAt === 'string'));
expect('2 pending registrations', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE order_id=? AND status='pending'").get(o1.orderId).c;
  assert.equal(c, 2);
});
expect('s1 occupied = 1', () => assert.equal(sessionOccupied(s1), 1));

// 第二位填滿 s1（cap=2 → 還有 1 位）
const o2 = createGroupOrder({ name: '乙', phone: '0997000002', paySessionIds: [s1], waitlistSessionIds: [] });
expect('s1 occupied = 2 (full)', () => assert.equal(sessionOccupied(s1), 2));

// 第三位選 s1（已滿）走 pay → 整批 409 fullSessionIds
expect('pay full session → 409 with fullSessionIds', () => {
  try { createGroupOrder({ name: '丙', phone: '0997000003', paySessionIds: [s1], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.deepEqual(e.detail.fullSessionIds, [s1]); }
});

// 第三位改 waitlist s1 → waitlisted reg、不佔名額、無金額
const o3 = createGroupOrder({ name: '丙', phone: '0997000003', paySessionIds: [], waitlistSessionIds: [s1] });
expect('waitlist order has no payment', () => assert.equal(o3.total, 0));
expect('waitlisted reg created', () => {
  const r = db.prepare("SELECT * FROM registrations WHERE session_id=? AND status='waitlisted'").get(s1);
  assert(r && r.order_id === null && r.amount_due === null);
});
expect('waitlist does NOT change occupied', () => assert.equal(sessionOccupied(s1), 2));

// 重複報名同場 → 409 already_registered
expect('duplicate → 409', () => {
  try { createGroupOrder({ name: '甲', phone: '0997000001', paySessionIds: [s2], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); }
});

// all-or-nothing：pay 桶含「未滿 + 已滿」→ 整批 409，未滿場次與訂單/使用者都不被寫入（tx rollback）
expect('partial-full pay batch → 409 and writes nothing', () => {
  const before = sessionOccupied(s2);
  try {
    createGroupOrder({ name: '戊', phone: '0997000009', paySessionIds: [s2, s1], waitlistSessionIds: [] });
    assert.fail('no throw');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.deepEqual(e.detail.fullSessionIds, [s1]);
  }
  assert.equal(sessionOccupied(s2), before, 's2 occupancy unchanged');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders WHERE customer_phone='0997000009'").get().c, 0, 'no order written');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE phone='0997000009'").get().c, 0, 'no user written (tx rolled back)');
});

console.log('[group-order-service part1] done');
```

Run: `node tests/group-order-service.test.js` → FAIL。

- [ ] **Step 2: 實作 `groupOrderService.js`（容量 helper + createGroupOrder）**
```js
import { db, tx, nowLocal, offsetLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { findOrCreateUserByPhone } from './userService.js';
import { notify } from './notifications.js';

// 收款資訊（健身房固定，可改用環境變數）
export const BANK_INFO = process.env.BANK_INFO || '玉山銀行 (808) 1234-567-890123 戶名：CHINUP';
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;       // 一般 pending 6h
const PROMOTED_TTL_MS = 24 * 60 * 60 * 1000;     // 遞補後 24h

const getSession = db.prepare('SELECT * FROM course_sessions WHERE id = ?');
const getTemplate = db.prepare('SELECT * FROM course_templates WHERE id = ?');
const getAnyReg = db.prepare('SELECT * FROM registrations WHERE session_id = ? AND user_id = ?');

// 已佔名額：confirmed 一律算（含舊 member-flow 遷移過來、order_id 為 NULL 的列）；
// pending 只在其訂單未過期時算。waitlisted 不算。
const occupiedStmt = db.prepare(`
  SELECT COUNT(*) AS c
  FROM registrations r
  LEFT JOIN group_orders o ON o.id = r.order_id
  WHERE r.session_id = ?
    AND ( r.status = 'confirmed'
          OR (r.status = 'pending' AND o.id IS NOT NULL AND o.expires_at >= ?) )
`);
export function sessionOccupied(sessionId) {
  return occupiedStmt.get(sessionId, nowLocal()).c;
}
export function sessionIsFull(sessionId) {
  const s = getSession.get(sessionId);
  if (!s) throw new ApiError(404, 'session_not_found');
  const tpl = getTemplate.get(s.template_id);
  if (!tpl) throw new ApiError(404, 'template_not_found');
  return sessionOccupied(sessionId) >= tpl.max_capacity;
}

const insertOrder = db.prepare(`
  INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, status, expires_at)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);
const insertReg = db.prepare(
  'INSERT INTO registrations (session_id, user_id, status, order_id, amount_due) VALUES (?, ?, ?, ?, ?)'
);
const reactivateReg = db.prepare(
  "UPDATE registrations SET status=?, order_id=?, amount_due=?, position=NULL, registered_at=datetime('now') WHERE id=?"
);

function validateSelectable(sessionId) {
  const s = getSession.get(sessionId);
  if (!s) throw new ApiError(404, 'session_not_found');
  if (s.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
  if (s.status === 'completed') throw new ApiError(409, 'session_completed');
  if (nowLocal() > s.registration_deadline) throw new ApiError(409, 'registration_closed');
  return s;
}

/**
 * 團體課送出。
 * paySessionIds: 客人預期有空、要付款報名的場次。
 * waitlistSessionIds: 客人已知額滿、選擇候補的場次（不付款）。
 * 回 { orderId, total, bankInfo, expiresAt, waitlisted:[sessionId...] }
 * pay 桶任一場已滿 → throw 409 { fullSessionIds }（整批不寫）。
 */
export function createGroupOrder({ name, phone, paySessionIds = [], waitlistSessionIds = [] }) {
  if (paySessionIds.length === 0 && waitlistSessionIds.length === 0) {
    throw new ApiError(400, 'no_sessions_selected');
  }
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });

    // 驗 pay 桶都還有空（重算）
    const full = [];
    for (const sid of paySessionIds) {
      validateSelectable(sid);
      if (sessionIsFull(sid)) full.push(sid);
    }
    if (full.length > 0) throw new ApiError(409, 'sessions_full', { fullSessionIds: full });

    // 算金額（單堂價可能各 template 不同 → 逐場加）
    let total = 0;
    const payRows = [];
    for (const sid of paySessionIds) {
      const s = getSession.get(sid);
      const tpl = getTemplate.get(s.template_id);
      if (!tpl) throw new ApiError(404, 'template_not_found');
      const dup = getAnyReg.get(sid, user.id);
      if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) {
        throw new ApiError(409, 'already_registered', { sessionId: sid });
      }
      payRows.push({ sid, price: tpl.price_per_session, dup });
      total += tpl.price_per_session;
    }

    const orderId = insertOrder.run(
      user.id, name.trim(), phone, total, offsetLocal(PENDING_TTL_MS)
    ).lastInsertRowid;
    const order = db.prepare('SELECT expires_at FROM group_orders WHERE id = ?').get(orderId);

    for (const { sid, price, dup } of payRows) {
      if (dup) reactivateReg.run('pending', orderId, price, dup.id);
      else insertReg.run(sid, user.id, 'pending', orderId, price);
    }

    // 候補桶（不付款）
    const waitlisted = [];
    for (const sid of waitlistSessionIds) {
      validateSelectable(sid);
      const dup = getAnyReg.get(sid, user.id);
      if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) continue;
      if (dup) reactivateReg.run('waitlisted', null, null, dup.id);
      else insertReg.run(sid, user.id, 'waitlisted', null, null);
      waitlisted.push(sid);
    }

    return { orderId, total, bankInfo: BANK_INFO, expiresAt: order.expires_at, waitlisted, memberId: user.id };
  });
}
```

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/group-order-service.test.js`
Expected: `[group-order-service part1] done`，全 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/groupOrderService.js tests/group-order-service.test.js
git commit -m "feat(group): group_orders create + live capacity + waitlist bucket"
```

---

## Task A5: `groupOrderService` — 核對 / 取消 / 遞補

**Files:**
- Modify: `src/services/groupOrderService.js`
- Modify: `tests/group-order-service.test.js`（追加）

- [ ] **Step 1: 追加測試**

在 `tests/group-order-service.test.js` 結尾（`console.log('[group-order-service part1] done')` 之後）追加：
```js
import { confirmGroupOrder, cancelGroupOrder, cancelRegistrationPublic, promoteWaitlist } from '../src/services/groupOrderService.js';

console.log('[group-order-service part2] start');

// 接續 part1 狀態：s1 cap=2，o1(甲:s1,s2 pending)、o2(乙:s1 pending)、o3(丙:s1 waitlisted)
// 核對 o2 付款 → confirmed
expect('confirm order → paid + regs confirmed', () => {
  const adminId = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get()?.id
    || db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('A','goa@x.com','x','owner') RETURNING id").get().id;
  const res = confirmGroupOrder({ orderId: o2.orderId, actorId: adminId });
  assert.equal(res.ok, true);
  const o = db.prepare('SELECT status FROM group_orders WHERE id=?').get(o2.orderId);
  assert.equal(o.status, 'paid');
  const r = db.prepare("SELECT status FROM registrations WHERE order_id=?").get(o2.orderId);
  assert.equal(r.status, 'confirmed');
});

// 乙取消（confirmed）→ 釋名額 → 丙(候補) 遞補成 pending + 新 24h order
expect('cancel confirmed reg → promote waitlist', () => {
  const reg = db.prepare("SELECT id FROM registrations WHERE order_id=?").get(o2.orderId);
  const res = cancelRegistrationPublic({ registrationId: reg.id, phone: '0997000002', name: '乙' });
  assert.equal(res.ok, true);
  // 丙 應被遞補
  const bing = db.prepare("SELECT * FROM registrations WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0997000003')").get(s1);
  assert.equal(bing.status, 'pending');
  assert(bing.order_id);  // 新訂單
  const ord = db.prepare('SELECT * FROM group_orders WHERE id=?').get(bing.order_id);
  assert.equal(ord.status, 'pending');
});

// 放棄整筆未付 order（甲的 o1）→ regs cancelled、釋名額
expect('cancel pending order whole → ok', () => {
  const res = cancelGroupOrder({ orderId: o1.orderId, phone: '0997000001', name: '甲' });
  assert.equal(res.ok, true);
  const o = db.prepare('SELECT status FROM group_orders WHERE id=?').get(o1.orderId);
  assert.equal(o.status, 'cancelled');
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE order_id=? AND status='cancelled'").get(o1.orderId).c;
  assert.equal(cnt, 2);
});

// 取消他人 order → 403
expect('cancel order wrong owner → 403', () => {
  try { cancelGroupOrder({ orderId: o3 && o3.orderId, phone: '0000', name: 'x' }); assert.fail('no throw'); }
  catch (e) { assert([403,404,400].includes(e.status)); }
});

console.log('[group-order-service part2] done');
```

Run: `node tests/group-order-service.test.js` → part2 FAIL（functions missing）。

- [ ] **Step 2: 實作核對/取消/遞補**

在 `groupOrderService.js` 追加：
```js
const getOrder = db.prepare('SELECT * FROM group_orders WHERE id = ?');
const getReg = db.prepare('SELECT * FROM registrations WHERE id = ?');
const getUserByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');

function ownerMatches(user, phone, name) {
  return user && user.phone === phone && user.name &&
    user.name.trim().toLowerCase() === (name || '').trim().toLowerCase();
}

/** admin 核對匯款：order → paid，其 pending registrations → confirmed，通知客人。 */
export function confirmGroupOrder({ orderId, actorId }) {
  return tx(() => {
    const order = getOrder.get(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');
    if (order.status === 'paid') return { ok: true };
    if (order.status === 'cancelled') throw new ApiError(409, 'order_cancelled');
    db.prepare("UPDATE group_orders SET status='paid', paid_at=?, paid_by=? WHERE id=?")
      .run(nowLocal(), actorId, orderId);
    db.prepare("UPDATE registrations SET status='confirmed' WHERE order_id=? AND status='pending'").run(orderId);
    // 通知客人
    const first = db.prepare('SELECT session_id FROM registrations WHERE order_id=? LIMIT 1').get(orderId);
    if (first) {
      const s = getSession.get(first.session_id);
      const tpl = getTemplate.get(s.template_id);
      notify({ userId: order.member_id, sessionId: first.session_id, type: 'payment_received',
        vars: { course_name: tpl.name, start_at: s.start_at } });
    }
    return { ok: true };
  });
}

/** 取消整筆未付 order（只有 pending 可整筆放棄）。釋名額後遞補。 */
export function cancelGroupOrder({ orderId, phone, name }) {
  return tx(() => {
    const order = getOrder.get(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');
    const user = getUserByPhone.get(phone);
    if (!ownerMatches(user, phone, name) || user.id !== order.member_id) throw new ApiError(403, 'forbidden');
    if (order.status === 'paid') throw new ApiError(409, 'order_already_paid');
    if (order.status === 'cancelled') return { ok: true };
    const regs = db.prepare("SELECT session_id FROM registrations WHERE order_id=? AND status='pending'").all(orderId);
    db.prepare("UPDATE registrations SET status='cancelled' WHERE order_id=? AND status='pending'").run(orderId);
    db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=? WHERE id=?").run(nowLocal(), orderId);
    for (const r of regs) promoteWaitlist(r.session_id);
    return { ok: true };
  });
}

/** 取消單筆 confirmed / waitlisted registration。釋名額後遞補。 */
export function cancelRegistrationPublic({ registrationId, phone, name }) {
  return tx(() => {
    const reg = getReg.get(registrationId);
    if (!reg) throw new ApiError(404, 'registration_not_found');
    const user = getUserByPhone.get(phone);
    if (!ownerMatches(user, phone, name) || user.id !== reg.user_id) throw new ApiError(403, 'forbidden');
    if (reg.status === 'cancelled') return { ok: true };
    if (reg.status === 'pending') throw new ApiError(409, 'use_cancel_order'); // pending 要走整筆放棄
    const wasOccupying = reg.status === 'confirmed';
    db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(registrationId);
    if (wasOccupying) promoteWaitlist(reg.session_id);
    return { ok: true };
  });
}

const getWaitQueue = db.prepare(
  "SELECT * FROM registrations WHERE session_id=? AND status='waitlisted' ORDER BY registered_at ASC, id ASC"
);

/** 若該場有空位，取最早候補 → pending + 建 24h 單堂 order，通知客人。 */
export function promoteWaitlist(sessionId) {
  return tx(() => {
    const s = getSession.get(sessionId);
    if (!s || s.status === 'cancelled') return;
    const tpl = getTemplate.get(s.template_id);
    if (sessionOccupied(sessionId) >= tpl.max_capacity) return;
    const next = getWaitQueue.get(sessionId);
    if (!next) return;
    const orderId = insertOrder.run(
      next.user_id,
      db.prepare('SELECT name FROM users WHERE id=?').get(next.user_id).name,
      db.prepare('SELECT phone FROM users WHERE id=?').get(next.user_id).phone || '',
      tpl.price_per_session,
      offsetLocal(PROMOTED_TTL_MS)
    ).lastInsertRowid;
    db.prepare("UPDATE registrations SET status='pending', order_id=?, amount_due=? WHERE id=?")
      .run(orderId, tpl.price_per_session, next.id);
    notify({ userId: next.user_id, sessionId, type: 'group_promoted',
      vars: { course_name: tpl.name, start_at: s.start_at } });
  });
}
```
> `getWaitQueue.get(...)` 取一筆（`.get` 回第一列）。

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/group-order-service.test.js`
Expected: part1 + part2 全 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/groupOrderService.js tests/group-order-service.test.js
git commit -m "feat(group): confirm/cancel order + FIFO waitlist promotion"
```

---

## Task A6: `groupOrderService` — 逾時 sweep + 公開查詢

**Files:**
- Modify: `src/services/groupOrderService.js`
- Modify: `tests/group-order-service.test.js`（追加）

- [ ] **Step 1: 追加測試**
```js
import { expirePendingOrders, getPublicGroupCourses, getPublicSchedule } from '../src/services/groupOrderService.js';

console.log('[group-order-service part3] start');

// 造一筆「已過期」pending order：直接改 expires_at 到過去
expect('expire sweep cancels stale pending + promotes', () => {
  // 用丁建一個 pending（選 s2，s2 cap=2 目前 0 佔；先讓某人候補 s2）
  const oDi = createGroupOrder({ name: '丁', phone: '0997000004', paySessionIds: [s2], waitlistSessionIds: [] });
  // 戊候補 s2 之前要先把 s2 佔滿；s2 cap=2，丁佔 1，再加一個正取佔滿
  createGroupOrder({ name: '己', phone: '0997000005', paySessionIds: [s2], waitlistSessionIds: [] }); // s2 now full(2)
  const oGeng = createGroupOrder({ name: '庚', phone: '0997000006', paySessionIds: [], waitlistSessionIds: [s2] }); // waitlist
  // 把丁的 order 過期
  db.prepare("UPDATE group_orders SET expires_at='2000-01-01T00:00:00' WHERE id=?").run(oDi.orderId);
  const res = expirePendingOrders();
  assert(res.expired >= 1);
  const o = db.prepare('SELECT status FROM group_orders WHERE id=?').get(oDi.orderId);
  assert.equal(o.status, 'cancelled');
  // 庚 應遞補上 s2
  const geng = db.prepare("SELECT status FROM registrations WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0997000006')").get(s2);
  assert.equal(geng.status, 'pending');
});

// 公開課程列表
expect('getPublicGroupCourses returns templates with sessions+price+occupied', () => {
  const courses = getPublicGroupCourses();
  const c = courses.find(x => x.id === tpl.templateId);
  assert(c && c.price_per_session === 500 && Array.isArray(c.sessions));
  const sess = c.sessions.find(x => x.id === s1);
  assert(typeof sess.occupied === 'number' && sess.max_capacity === 2 && typeof sess.is_full === 'boolean');
});

// 公開查課表（電話+姓名）+ 剩堂數
expect('getPublicSchedule by phone+name', () => {
  const sched = getPublicSchedule({ phone: '0997000006', name: '庚' });
  assert(sched && Array.isArray(sched.items));
  assert(typeof sched.group_remaining === 'number');
  assert(typeof sched.one_on_one_remaining === 'number');
});
expect('getPublicSchedule wrong name → 403', () => {
  try { getPublicSchedule({ phone: '0997000006', name: '錯' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});

console.log('[group-order-service part3] done');
```

Run: `node tests/group-order-service.test.js` → part3 FAIL。

- [ ] **Step 2: 實作 sweep + 公開查詢**

在 `groupOrderService.js` 追加。先加 import：`import { getUserByPhoneAndName } from './userService.js';`（與既有 import 併行）。
```js
/** 把所有逾時未付 pending order → cancelled，釋名額後對受影響場次遞補。 */
export function expirePendingOrders() {
  const now = nowLocal();
  const stale = db.prepare("SELECT id FROM group_orders WHERE status='pending' AND expires_at < ?").all(now);
  let expired = 0;
  for (const { id } of stale) {
    tx(() => {
      const regs = db.prepare("SELECT session_id FROM registrations WHERE order_id=? AND status='pending'").all(id);
      db.prepare("UPDATE registrations SET status='cancelled' WHERE order_id=? AND status='pending'").run(id);
      db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=? WHERE id=?").run(now, id);
      for (const r of regs) promoteWaitlist(r.session_id);
    });
    expired++;
  }
  return { expired };
}

/** 公開：所有有未來場次的 published template，含每場 occupied / is_full。 */
export function getPublicGroupCourses() {
  const now = nowLocal();
  const templates = db.prepare(`
    SELECT id, name, description, min_capacity, max_capacity, duration_minutes,
           price_per_session, recurrence, cycle_start_date, cycle_end_date
    FROM course_templates
    WHERE status = 'published'
    ORDER BY created_at DESC
  `).all();
  return templates.map((t) => {
    const sessions = db.prepare(`
      SELECT id, session_date, start_at, end_at, status, registration_deadline
      FROM course_sessions
      WHERE template_id = ? AND status = 'open' AND start_at > ?
      ORDER BY start_at ASC
    `).all(t.id, now).map((s) => {
      const occupied = sessionOccupied(s.id);
      return {
        ...s, occupied, max_capacity: t.max_capacity,
        is_full: occupied >= t.max_capacity,
        price_per_session: t.price_per_session,
      };
    });
    return { ...t, sessions };
  }).filter((t) => t.sessions.length > 0);
}

/** 公開：用電話+姓名查課表（1v1 bookings + group registrations）+ 剩堂數。 */
export function getPublicSchedule({ phone, name }) {
  const user = getUserByPhoneAndName({ phone, name });
  if (!user) throw new ApiError(403, 'not_found_or_mismatch');
  const now = nowLocal();

  const bookings = db.prepare(`
    SELECT b.id, b.start_at, b.end_at, b.status, c.display_name AS coach_display_name
    FROM bookings b JOIN coaches c ON c.id = b.coach_id
    WHERE b.member_id = ? ORDER BY b.start_at DESC
  `).all(user.id).map((b) => ({
    kind: 'booking', id: b.id, start_at: b.start_at, end_at: b.end_at,
    status: b.status, coach_display_name: b.coach_display_name,
    is_past: b.start_at < now,
    can_cancel: b.status === 'confirmed' && b.start_at > now,
  }));

  const regs = db.prepare(`
    SELECT r.id, r.status, r.amount_due, r.order_id,
           s.id AS session_id, s.start_at, s.end_at, s.status AS session_status,
           t.name AS course_name, o.status AS order_status, o.expires_at AS order_expires_at,
           o.total_amount, o.id AS oid
    FROM registrations r
    JOIN course_sessions s ON s.id = r.session_id
    JOIN course_templates t ON t.id = s.template_id
    LEFT JOIN group_orders o ON o.id = r.order_id
    WHERE r.user_id = ? AND r.status != 'cancelled'
    ORDER BY s.start_at DESC
  `).all(user.id).map((r) => ({
    kind: 'registration', id: r.id, status: r.status,
    start_at: r.start_at, end_at: r.end_at, session_id: r.session_id,
    course_name: r.course_name, session_status: r.session_status,
    order_id: r.order_id, order_status: r.order_status, order_expires_at: r.order_expires_at,
    amount_due: r.amount_due, is_past: r.start_at < now,
    can_cancel: ['confirmed', 'waitlisted'].includes(r.status) && r.session_status === 'open' && r.start_at > now,
  }));

  // 剩堂數 = 已付款(confirmed) 且未上(start_at>now)
  const one_on_one_remaining = bookings.filter((b) => b.status === 'confirmed' && !b.is_past).length;
  const group_remaining = regs.filter((r) => r.status === 'confirmed' && !r.is_past).length;

  const items = [...bookings, ...regs].sort((a, b) => b.start_at.localeCompare(a.start_at));
  return {
    user: { name: user.name, phone: user.phone },
    items, one_on_one_remaining, group_remaining,
  };
}
```

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/group-order-service.test.js`
Expected: part1+2+3 全 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/groupOrderService.js tests/group-order-service.test.js
git commit -m "feat(group): expire-orders sweep + public courses/schedule queries"
```

---

## Task A7: courseService 加價格 + 移除點數退費

**Files:**
- Modify: `src/services/courseService.js`
- Test: `tests/course-price.test.js`

- [ ] **Step 1: 寫測試**

`tests/course-price.test.js`：
```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate, editTemplate, getTemplate } from '../src/services/courseService.js';

function reset() { db.exec("DELETE FROM course_sessions; DELETE FROM course_templates WHERE name LIKE 'PriceTest%';"); }
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

console.log('[course-price test] start');
reset();
const r = createTemplate({ name:'PriceTest A', min_capacity:1, max_capacity:5, day_of_week:1, start_time:'19:00', recurrence:'weekly', cycle_start_date:dstr(1), cycle_end_date:dstr(30), price_per_session: 800 });
expect('price stored on create', () => assert.equal(getTemplate(r.templateId).price_per_session, 800));
editTemplate(r.templateId, { name:'PriceTest A', min_capacity:1, max_capacity:5, day_of_week:1, start_time:'19:00', recurrence:'weekly', cycle_start_date:dstr(1), cycle_end_date:dstr(30), price_per_session: 950 });
expect('price updated on edit', () => assert.equal(getTemplate(r.templateId).price_per_session, 950));
expect('default price 0 when omitted', () => {
  const r2 = createTemplate({ name:'PriceTest B', min_capacity:1, max_capacity:5, day_of_week:2, start_time:'19:00', recurrence:'weekly', cycle_start_date:dstr(1), cycle_end_date:dstr(30) });
  assert.equal(getTemplate(r2.templateId).price_per_session, 0);
});
console.log('[course-price test] done');
```

Run: `node tests/course-price.test.js` → FAIL（price 沒存）。

- [ ] **Step 2: 改 courseService.js**

1. 移除 `import { recordTransaction } from './pointService.js';`
2. `insertTemplate` SQL 加 `price_per_session`：
```js
const insertTemplate = db.prepare(`
  INSERT INTO course_templates
    (name, description, min_capacity, max_capacity, day_of_week, start_time,
     duration_minutes, recurrence, cycle_start_date, cycle_end_date,
     registration_deadline_hours, status, price_per_session)
  VALUES (@name, @description, @min_capacity, @max_capacity, @day_of_week, @start_time,
          @duration_minutes, @recurrence, @cycle_start_date, @cycle_end_date,
          @registration_deadline_hours, @status, @price_per_session)
`);
```
3. `updateTemplate` SQL 加 `price_per_session=@price_per_session`（在 `status=@status` 後）。
4. `normalize()` 回傳物件加：`price_per_session: Number(t.price_per_session ?? 0),`
5. `processDeadlines()`：刪除「未成班退費」整段（line 177-189 的 `recordTransaction` 迴圈與註解），保留把 registrations 設 `rejected` + 通知的邏輯。改後該分支：
```js
} else {
  db.prepare("UPDATE course_sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
  const regs = db.prepare("SELECT user_id, id FROM registrations WHERE session_id = ? AND status IN ('confirmed','waitlisted','pending')").all(s.id);
  const upd = db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?");
  for (const r of regs) {
    upd.run(r.id);
    notify({ userId: r.user_id, sessionId: s.id, type: 'course_cancelled', vars: { course_name: s.course_name, start_at: s.start_at } });
  }
  results.push({ sessionId: s.id, action: 'cancelled', count: regs.length });
}
```

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/course-price.test.js`
Expected: 全 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/courseService.js tests/course-price.test.js
git commit -m "feat(course): price_per_session field; drop point refund on session cancel"
```

---

## Task A8: auth 擋 user 登入 + 通知 template

**Files:**
- Modify: `src/services/auth.js`
- Modify: `src/services/notifications.js`
- Test: `tests/auth-lock.test.js`

- [ ] **Step 1: 寫測試**

`tests/auth-lock.test.js`：
```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { login, hashPassword } from '../src/services/auth.js';
import { ApiError } from '../src/services/registration.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
db.exec("DELETE FROM users WHERE email IN ('lock-user@x.com','lock-admin@x.com')");
db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('U','lock-user@x.com',?, 'user')").run(hashPassword('pass1234'));
db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('A','lock-admin@x.com',?, 'admin')").run(hashPassword('pass1234'));

console.log('[auth-lock test] start');
expect('user role blocked → 403 user_login_disabled', () => {
  try { login({ email:'lock-user@x.com', password:'pass1234' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); assert.equal(e.code, 'user_login_disabled'); }
});
expect('admin still logs in', () => {
  const r = login({ email:'lock-admin@x.com', password:'pass1234' });
  assert(r.token);
});
console.log('[auth-lock test] done');
```

Run: `node tests/auth-lock.test.js` → FAIL（user 還能登入）。

- [ ] **Step 2: 改 `auth.js` `login()`**
```js
export function login({ email, password }) {
  const user = getUserByEmail.get(email);
  if (!user) throw new ApiError(401, 'invalid_credentials');
  if (!verifyPassword(password, user.password_hash)) throw new ApiError(401, 'invalid_credentials');
  if (user.role === 'user') throw new ApiError(403, 'user_login_disabled');
  const session = createSession(user.id);
  return { token: session.token, user: safeUser(user), expiresAt: session.expiresAt };
}
```

- [ ] **Step 3: 加通知 template**

`src/services/notifications.js` `TEMPLATES` 物件內加兩個：
```js
  payment_received: {
    subject: '匯款已收到 - {{course_name}}',
    body: '✅ 已收到您的匯款，{{course_name}}（{{start_at}}）報名確認，期待見到您！',
  },
  group_promoted: {
    subject: '候補遞補成功 - {{course_name}}',
    body: '🎉 您候補的 {{course_name}}（{{start_at}}）有名額了！請於 24 小時內完成匯款以保留名額，並至「我的課表」查看。',
  },
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/auth-lock.test.js`
Expected: 全 ✓。

- [ ] **Step 5: Commit**
```bash
git add src/services/auth.js src/services/notifications.js tests/auth-lock.test.js
git commit -m "feat(auth): block role=user login; add payment/promotion notification templates"
```

---

## Task A9: server.js — 新增公開 endpoints

**Files:**
- Modify: `src/server.js`
- Test: `tests/public-api.test.js`

- [ ] **Step 1: 寫 API 測試（需先啟 server）**

`tests/public-api.test.js`（用 helper req；用 seed 出來的舊電話當回頭客；新電話 `0996...` 當新客）：
```js
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text?JSON.parse(text):null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[public-api test] start');

// group-courses 公開可讀（無 token）
const courses = await req('GET', '/api/public/group-courses');
expect('group-courses 200 + array', () => { assert.equal(courses.status, 200); assert(Array.isArray(courses.data)); });

// 1v1 anon booking：需要一個 active coach + 一個可預約時段（此處假設環境已有；否則 skip 細節驗 user 自動建立）
// 用 lookup-free 流程驗證：送一個未來時段（先用 admin 在後台建好 coach/rule，CI 可改用 group flow）
// 這裡聚焦驗證 my 查詢 + 取消的 403 路徑：
const my = await req('POST', '/api/public/my', { body: { phone: '0900000000', name: 'Admin' } });
// 0900000000 是 admin（role!=user 但仍是 users 列）；姓名對 → 200；驗結構
expect('my 200 with items/remaining', () => {
  assert.equal(my.status, 200);
  assert(Array.isArray(my.data.items));
  assert(typeof my.data.group_remaining === 'number');
});
const myBad = await req('POST', '/api/public/my', { body: { phone: '0900000000', name: '亂打' } });
expect('my wrong name → 403', () => assert.equal(myBad.status, 403));

// 新電話、無資料 → 403（查無）
const myNew = await req('POST', '/api/public/my', { body: { phone: '0996000000', name: '新客' } });
expect('my unknown phone → 403', () => assert.equal(myNew.status, 403));

// invalid phone on booking
const badBook = await req('POST', '/api/public/bookings', { body: { coachId: 1, startAt: '2030-01-01T10:00:00', name:'x', phone:'abc' } });
expect('booking invalid phone → 400', () => assert.equal(badBook.status, 400));

console.log('[public-api test] done');
```

Run（terminal A `npm start`；terminal B）：`node tests/public-api.test.js` → FAIL（endpoints 404）。

- [ ] **Step 2: 在 server.js 加 import 與 endpoints**

import 區（line 52 附近）加：
```js
import { createBookingAnon as svcCreateBookingAnon, cancelBookingAnon as svcCancelBookingAnon } from './services/bookingService.js';
import {
  createGroupOrder as svcCreateGroupOrder,
  confirmGroupOrder as svcConfirmGroupOrder,
  cancelGroupOrder as svcCancelGroupOrder,
  cancelRegistrationPublic as svcCancelRegPublic,
  expirePendingOrders as svcExpireOrders,
  getPublicGroupCourses as svcPublicCourses,
  getPublicSchedule as svcPublicSchedule,
} from './services/groupOrderService.js';
```
> `svcCreateBookingAnon`/`svcCancelBookingAnon` 也可併入既有 bookingService import 區（line 28-34）。

在 `// --- One-on-one: public + member endpoints ---`（line 650）之前，新增公開區塊：
```js
// --- Public (no auth): anon booking / group orders / phone lookup ---
app.get('/api/public/group-courses', asyncHandler((req, res) => {
  res.json(svcPublicCourses());
}));

app.post('/api/public/bookings', asyncHandler((req, res) => {
  const { coachId, startAt, name, phone, note } = req.body || {};
  const r = svcCreateBookingAnon({ coachId: Number(coachId), startAt, name, phone, note: note || null });
  res.status(201).json(r);
}));

app.post('/api/public/group-orders', asyncHandler((req, res) => {
  const { name, phone, paySessionIds, waitlistSessionIds } = req.body || {};
  const r = svcCreateGroupOrder({
    name, phone,
    paySessionIds: (paySessionIds || []).map(Number),
    waitlistSessionIds: (waitlistSessionIds || []).map(Number),
  });
  res.status(201).json(r);
}));

app.post('/api/public/my', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcPublicSchedule({ phone, name }));
}));

app.delete('/api/public/bookings/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcCancelBookingAnon({ bookingId: Number(req.params.id), phone, name }));
}));

app.delete('/api/public/registrations/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcCancelRegPublic({ registrationId: Number(req.params.id), phone, name }));
}));

app.delete('/api/public/group-orders/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcCancelGroupOrder({ orderId: Number(req.params.id), phone, name }));
}));
```

- [ ] **Step 3: 跑測試確認通過**

Run（重啟 server 後）：`node tests/public-api.test.js`
Expected: 全 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/server.js tests/public-api.test.js
git commit -m "feat(api): public anon booking / group-order / phone-lookup endpoints"
```

---

## Task A10: server.js — 拆除舊路由 + 修 admin/users

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: 移除點數路由與 import**

刪除：
- import：`getBalances/adminGrant/listTransactionsForAdmin`（line 47-51）整段。
- route：`GET /api/my/points/balance`（463-465）、`POST /api/admin/users/:id/points/grant`（467-479）、`GET /api/admin/users/:id/points/transactions`（481-489）。

- [ ] **Step 2: 修 `GET /api/admin/users`**

把 query 改成不 join view、移除 balance 欄、保留 line_user_id：
```js
app.get('/api/admin/users', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.notification_preference,
           (u.google_id IS NOT NULL) AS has_google, u.line_user_id, u.created_at
    FROM users u
    ORDER BY u.id ASC
  `).all();
  res.json(rows);
}));
```

- [ ] **Step 3: 移除公開註冊與失效的會員路由**

- 刪 route `POST /api/auth/register`（161-164）+ import `registerWithPassword`（line 41）+ `registerLimiter` 定義（line 76）。
- 刪失效的會員專用 route（會員已不能登入）：`GET /api/my/registrations`（273-275）、`POST /api/sessions/:id/register`（277-280）、`DELETE /api/registrations/:id`（282-285）、`GET /api/my/bookings`（700-702）、`GET /api/my/schedule`（704-707）。
  - 連帶移除未再使用的 import：`register, cancelRegistration`（保留 `ApiError`）、`listUserRegistrations`、`svcListMySchedule`、`svcListMemberBookings`。
  - `POST /api/bookings`、`DELETE /api/bookings/:id`（會員版）改為僅供 coach 取消用途仍需保留？→ 會員不能登入，故 `POST /api/bookings`(requireUser) 失效，刪除（1v1 改走 `/api/public/bookings`）。`DELETE /api/bookings/:id` 保留給 coach 緊急取消（requireUser，coach 也有 token）。
  - `GET /api/my/recent-coach`（291-296）失效，刪除。
  - LINE 會員 endpoints `/api/my/line/*`（715-753）失效（會員無 token）→ 綁定碼改在成功頁由公開流程回傳；但 webhook 仍需。**保留 webhook**，刪 `/api/my/line/binding`、`/api/my/line/regenerate`、`DELETE /api/my/line`。
    - ⚠️ 綁定碼產生：公開預約成功要回 lineBindCode，故需要在 `createBookingAnon`/`createGroupOrder` 回傳時產碼。**本 task 不動 service**；改在 Task A11 補（見下）。為避免遺漏，這裡先標註。

> 移除 route 後，確認 server 仍可啟動（無 dangling import）。

- [ ] **Step 4: 驗證 server 啟動 + 既有 admin/coach 測試**

Run: `npm start`（應正常 listen）。Ctrl-C 後：
Run: `node tests/api.test.js`（admin/coach/categories 等不涉及點數的部分應過；涉及點數/註冊的失敗留待 A12 清理）。
Expected: server 正常啟動，無 import error。

- [ ] **Step 5: Commit**
```bash
git add src/server.js
git commit -m "refactor(api): remove points + public-register + dead member routes; trim admin/users"
```

---

## Task A11: 公開成功頁的 LINE 綁定碼

**Files:**
- Modify: `src/services/bookingService.js`
- Modify: `src/services/groupOrderService.js`
- Modify: `tests/booking-anon.test.js`、`tests/group-order-service.test.js`（追加斷言）

- [ ] **Step 1: 追加斷言**

`tests/booking-anon.test.js`：在第一次 `createBookingAnon` 後加：
```js
expect('returns lineBindCode for unbound user', () => assert(/^\d{6}$/.test(r.lineBindCode)));
```
`tests/group-order-service.test.js` part1：在 `o1` 後加：
```js
expect('order returns lineBindCode for unbound user', () => assert(/^\d{6}$/.test(o1.lineBindCode)));
```

Run 兩個測試 → 新斷言 FAIL。

- [ ] **Step 2: 產碼並回傳**

兩個 service 都 `import { generateBindCode } from './lineBindingService.js';`。
- `bookingService.createBookingCore` return 前，若 user 未綁定則產碼。改 `createBookingAnon`：
```js
export function createBookingAnon({ coachId, startAt, name, phone, note = null }) {
  if (!coachId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });
    const r = createBookingCore({ coach, memberId: user.id, startAt, note });
    if (!user.line_user_id) r.lineBindCode = generateBindCode(user.id).code;
    return r;
  });
}
```
- `groupOrderService.createGroupOrder` return 前：
```js
    const result = { orderId, total, bankInfo: BANK_INFO, expiresAt: order.expires_at, waitlisted, memberId: user.id };
    if (!user.line_user_id) result.lineBindCode = generateBindCode(user.id).code;
    return result;
```
> `generateBindCode` 內部自己開 `tx()`，巢狀在外層 tx 內安全（`_txDepth>0` 直接執行）。

- [ ] **Step 3: 跑測試確認通過**

Run: `node tests/booking-anon.test.js && node tests/group-order-service.test.js`
Expected: 全 ✓。

- [ ] **Step 4: Commit**
```bash
git add src/services/bookingService.js src/services/groupOrderService.js tests/booking-anon.test.js tests/group-order-service.test.js
git commit -m "feat(line): return 6-digit bind code on anon booking/order success"
```

---

## Task A12: scheduler + expire-orders job

**Files:**
- Modify: `src/scheduler.js`
- Modify: `src/server.js`

- [ ] **Step 1: scheduler 加每 10 分 sweep**

`src/scheduler.js`：import `import { expirePendingOrders } from './services/groupOrderService.js';`，在 `startScheduler()` 內加：
```js
  // 每 10 分鐘釋出逾時未付的 pending 訂單並遞補候補
  cron.schedule('*/10 * * * *', () => {
    try {
      const r = expirePendingOrders();
      if (r.expired) console.log('[scheduler] expired pending orders:', r.expired);
    } catch (e) {
      console.error('[scheduler] expire-orders error:', e);
    }
  });
```

- [ ] **Step 2: server.js 加手動觸發 endpoint**

在 `POST /api/admin/jobs/send-reminders`（829）之後加：
```js
app.post('/api/admin/jobs/expire-orders', requireAdmin, asyncHandler((req, res) => {
  res.json(svcExpireOrders());
}));
```
（`svcExpireOrders` 已於 A9 import）

- [ ] **Step 3: 驗證**

Run: `npm start`，另開 terminal：以 admin token `POST /api/admin/jobs/expire-orders`，預期 `{ "expired": <number> }`，server log 無錯。

- [ ] **Step 4: Commit**
```bash
git add src/scheduler.js src/server.js
git commit -m "feat(jobs): expire-orders cron (10min) + manual admin trigger"
```

---

## Task A13: 測試清理 + 移除 pointService

**Files:**
- Delete: `src/services/pointService.js`
- Modify: `package.json`
- Modify/Delete: 受影響的舊測試

- [ ] **Step 1: 盤點壞掉的測試**

Run（逐一）：`node tests/api.test.js`、`node tests/booking-api.test.js`、`node tests/my-schedule-api.test.js`、`node tests/my-schedule-service.test.js`、`node tests/flow.test.js`、`node tests/booking-flow.test.js`、`node tests/notifications-flow.test.js`
記錄哪些因「點數 / 公開註冊 / 會員登入 / 移除路由」而失敗。

- [ ] **Step 2: 處理策略**

- 凡 `import ... from '../src/services/pointService.js'` 或呼叫 `adminGrant`/`recordTransaction`/`getBalances` 的測試：移除該 import 與相關斷言（點數已不存在）。
- `my-schedule-service.test.js`：`listMySchedule` 仍存在（service 未刪），但其 `adminGrant` seed 改成直接 SQL 或移除（不影響 booking/registration 驗證）。若 `register()` 仍被測且已移點數，確認其行為。
- `booking-api.test.js`：移除 Phase 2 points 整段（136-234）、把 coach self-signup（`/api/auth/register`）改為「以 owner token + `POST /api/admin/coaches`（A-creates-coach 於 Phase B；此處先用直接 DB seed 或既有 seed 的 coach）」。最務實：將需要 coach 的 1v1 測試移到新的 service-level 測試（已由 `tests/booking-anon.test.js` 覆蓋），把 booking-api.test.js 縮減為「公開 booking endpoints」或直接刪除其過時段落。
- 刪除完全過時、已被新測試取代的檔案（例如純會員登入流程）。每刪一個在 commit message 說明原因。

> 原則：**不為了讓舊測試過而保留死碼**。新功能由 A2–A12 的新測試覆蓋。舊測試只保留仍有效的（admin/coach/categories/availability/line-webhook/backup）。

- [ ] **Step 3: 刪 pointService + 確認無 import**

Run: `grep -rn "pointService" src/ tests/`
預期：無結果（A3/A7/A10 已移除所有 import）。
然後刪檔：`rm src/services/pointService.js`

- [ ] **Step 4: 更新 package.json test 腳本**

把 `test:api` / `test:flow` 改成只列「仍有效 + 新增」的測試，並加一個彙總 script，例如：
```json
    "test": "node tests/migration.test.js && node tests/user-service.test.js && node tests/group-order-service.test.js && node tests/booking-anon.test.js && node tests/course-price.test.js && node tests/auth-lock.test.js && node tests/lineBindingService.test.js && node tests/backup.test.js",
    "test:api": "node tests/public-api.test.js && node tests/api.test.js && node tests/line-webhook-api.test.js && node tests/backup-api.test.js && node tests/rate-limit.test.js"
```
（依 Step 2 實際保留的檔案調整。）

- [ ] **Step 5: 跑全部 service-level 測試**

Run: `npm test`
Expected: 全綠。

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "test: prune obsolete points/member-login tests; remove pointService; refresh test scripts"
```

---

## Phase A Gate（手動 smoke，merge draft-PR 前）

開 draft PR。本機 `npm start` 後依 spec §8「A 後端」清單逐項手測（用 curl / REST client）。全過才合併。

```bash
git push -u origin feature/anon-paid-group-redesign
# 開 draft PR（gh 不可用 → 用 GitHub API curl，PAT 在 osxkeychain）
```

---

# Phase B — Admin 後台

> 前端 admin 用既有 `public/admin.html` + `public/admin.js`（fetch + token）。先讀這兩個檔了解既有 render 模式再動手。

## Task B1: admin group-order endpoints

**Files:**
- Modify: `src/server.js`
- Modify: `src/services/groupOrderService.js`（加 list 查詢）
- Test: `tests/admin-group-orders.test.js`

- [ ] **Step 1: 加 service 查詢**

`groupOrderService.js` 加：
```js
/** admin：待核對（pending 且未過期）訂單清單，含場次摘要。 */
export function listPendingOrders() {
  const now = nowLocal();
  const orders = db.prepare(`
    SELECT id, member_id, customer_name, customer_phone, total_amount, expires_at, created_at
    FROM group_orders WHERE status='pending' AND expires_at >= ?
    ORDER BY created_at ASC
  `).all(now);
  return orders.map((o) => ({
    ...o,
    sessions: db.prepare(`
      SELECT s.start_at, t.name AS course_name
      FROM registrations r JOIN course_sessions s ON s.id=r.session_id
      JOIN course_templates t ON t.id=s.template_id
      WHERE r.order_id=? AND r.status='pending' ORDER BY s.start_at ASC
    `).all(o.id),
  }));
}
```

- [ ] **Step 2: 寫 API 測試**

`tests/admin-group-orders.test.js`：用 owner 登入 → 建 template(price) → 公開建 group-order → `GET /api/admin/group-orders` 看到該筆 → `POST /api/admin/group-orders/:id/confirm` → 再查清單已不含。斷言 403 for non-admin。（參照 booking-api.test.js 的 req/loginAs 風格；coach/template 用 owner 經 admin endpoints 建。）

Run → FAIL。

- [ ] **Step 3: 加 endpoints**

server.js import 加 `listPendingOrders as svcListPendingOrders`。在 admin 區（`/api/admin/notifications` 之後）加：
```js
app.get('/api/admin/group-orders', requireAdmin, asyncHandler((req, res) => {
  res.json(svcListPendingOrders());
}));
app.post('/api/admin/group-orders/:id/confirm', requireAdmin, asyncHandler((req, res) => {
  res.json(svcConfirmGroupOrder({ orderId: Number(req.params.id), actorId: req.user.id }));
}));
app.post('/api/admin/group-orders/:id/cancel', requireAdmin, asyncHandler((req, res) => {
  const o = db.prepare('SELECT customer_phone, customer_name FROM group_orders WHERE id=?').get(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'order_not_found' });
  res.json(svcCancelGroupOrder({ orderId: Number(req.params.id), phone: o.customer_phone, name: o.customer_name }));
}));
```
> admin cancel 走 `cancelGroupOrder` 但用訂單自身的 phone/name 通過 owner 檢查。

- [ ] **Step 4: 測試通過 + Commit**

Run: 啟 server、`node tests/admin-group-orders.test.js` → 全 ✓。
```bash
git add src/server.js src/services/groupOrderService.js tests/admin-group-orders.test.js
git commit -m "feat(admin): pending group-order list + confirm/cancel endpoints"
```

---

## Task B2: admin create-coach 帳號

**Files:**
- Modify: `src/server.js`
- Modify: `src/services/auth.js`（複用 `registerWithPassword` 或新增 `createCoachAccount`）

- [ ] **Step 1: service**

公開註冊已移除，但 coach 仍需帳號。`auth.js` 保留 `registerWithPassword`（A10 只刪了 server 的公開 route，未刪 service；確認仍 export）。新增薄包裝：
```js
export function createCoachAccount({ email, password, name }) {
  return registerWithPassword({ email, password, name, as_coach: true });
}
```

- [ ] **Step 2: endpoint（admin only）**

server.js import `createCoachAccount`。在 `POST /api/admin/coaches`（502）之前加：
```js
app.post('/api/admin/coaches/account', requireAdmin, asyncHandler((req, res) => {
  const { email, password, name } = req.body || {};
  const r = createCoachAccount({ email, password, name });
  res.status(201).json({ user_id: r.user.id, coach_pending: true });
}));
```
> 建立後該 coach 需 admin 在現有 coach 管理 UI 啟用（既有 `PATCH /api/admin/coaches/:id` is_active）。

- [ ] **Step 3: 驗證 + Commit**

Run: 啟 server，admin token `POST /api/admin/coaches/account` 建一個 → `GET /api/admin/coaches` 看到 pending coach。
```bash
git add src/server.js src/services/auth.js
git commit -m "feat(admin): create coach account (replaces public coach self-signup)"
```

---

## Task B3: admin.html / admin.js — 待核對匯款 UI

**Files:**
- Modify: `public/admin.html`、`public/admin.js`

- [ ] **Step 1: 讀現有 admin.js 結構**，找到分頁/區塊 render 模式與 `api()` fetch helper。

- [ ] **Step 2: 加「待核對匯款」區塊**

- `admin.html` 加一個 section/tab `#pending-orders`。
- `admin.js` 加 `loadPendingOrders()`：`GET /api/admin/group-orders` → render 每筆（姓名/電話/場次清單/總額/到期時間）+「已收款」「取消訂單」按鈕。
- 按鈕 → `POST /api/admin/group-orders/:id/confirm`（或 `/cancel`）→ 成功後 reload 清單 + toast。

- [ ] **Step 3: 手動驗證**：admin 登入 → 看到測試訂單 → 按已收款 → 客人 my 查詢顯示已確認。

- [ ] **Step 4: Commit**
```bash
git add public/admin.html public/admin.js
git commit -m "feat(admin-ui): pending bank-transfer reconciliation panel"
```

---

## Task B4: admin.js — 模板價格欄位 + 移除點數 UI

**Files:**
- Modify: `public/admin.html`、`public/admin.js`

- [ ] **Step 1: 模板表單加 `price_per_session`**

在建立/編輯課程模板表單加一個數字輸入 `單堂價格`，送出時帶 `price_per_session`，編輯時 prefill 既有值。

- [ ] **Step 2: 移除點數相關 UI**

刪除 admin.js / admin.html 中所有呼叫 `/api/my/points/*`、`/api/admin/users/:id/points/*` 的程式與按鈕、以及顯示 `one_on_one_balance` / `group_balance` 的欄位（`/api/admin/users` 已不回傳）。

- [ ] **Step 3: 手動驗證**：建課可設定價格；團體課總額正確；admin 頁無點數殘留、users 列表正常顯示（含 line_user_id）。

- [ ] **Step 4: Commit**
```bash
git add public/admin.html public/admin.js
git commit -m "feat(admin-ui): template price field; remove points UI"
```

---

## Phase B Gate

依 spec §8「B Admin」清單手測。draft PR push + 手動 gate 後合併（或與 Phase A 合併到同一 PR，視 review 規模）。

---

# Phase C — 前端 cutover

> 前端非單元測試，採 spec §8「C 前端」手動 E2E gate。每個 task 完成後 `npm start` 本機操作驗證。動工前先讀對應檔案的既有結構。

## Task C1: navbar 修正 + 公開化骨架

**Files:**
- Modify: `public/app.js`、各頁 `<nav>`（`index.html`/`coaches.html`/`my-schedule.html`/`admin.html`/`coach.html`）

- [ ] **Step 1: 修 showCoach bug**

`public/app.js:136`：
```js
const showCoach = user.role === 'coach';
```
（admin/owner 不再看到「教練後台」；admin 連結 `.admin-only`/對應 element 維持只給 admin/owner——確認 line 132 的 admin gate 已是 `['admin','owner']`，保持。）

- [ ] **Step 2: 公開頁 navbar**

把 `index.html`/`coaches.html`/`my-schedule.html` 的 `<nav>` 連結改為公開版：`課程`(/) `一對一`(/coaches.html) `我的課表`(/my-schedule) `登入`(/login.html)。移除 `🔔 LINE 通知`(/line.html) 與「管理後台」連結（admin/coach 由登入後動態顯示，或維持隱藏 class 由 app.js 控制）。公開頁**不呼叫 `bootAuth()` 的強制導向**——改為「有 token 才顯示後台連結 + 身份列」的軟性初始化（讓未登入者正常看到頁面）。

- [ ] **Step 3: login.html 文案**：改為「管理員 / 教練專用登入」，移除「註冊」連結。

- [ ] **Step 4: 手動驗證**：admin 登入只見「管理後台」、coach 只見「教練後台」；未登入可正常瀏覽首頁不被導去 login。

- [ ] **Step 5: Commit**
```bash
git add public/app.js public/index.html public/coaches.html public/my-schedule.html public/admin.html public/coach.html public/login.html
git commit -m "fix(nav): coach link only for coach role; public navbar; admin/coach login copy"
```

---

## Task C2: 首頁入口卡

**Files:**
- Modify: `public/index.html`（+ 可能 `public/courses.js`）

- [ ] **Step 1**: 首頁 `<main>` 改為兩張大卡：`團體課程`（→ 團體課列表流程）、`1對1個別指導`（→ `/coaches.html`）。不需登入。

- [ ] **Step 2: 手動驗證**：未登入連 `/` 看到兩卡、可點入。

- [ ] **Step 3: Commit**
```bash
git add public/index.html public/courses.js
git commit -m "feat(home): two entry cards (group / 1-on-1), no login"
```

---

## Task C3: 1v1 匿名預約流程

**Files:**
- Modify: `public/coaches.js`、`public/coaches.html`

- [ ] **Step 1: 讀 coaches.js** 既有「選教練→看時段」流程（已公開讀 `/api/coaches`、`/api/coaches/:id/availability`）。

- [ ] **Step 2: 選時段 → 預約 modal**

選時段後彈 modal：欄位「姓名*」「電話*」（電話 `inputmode=numeric`，送出前 normalize 去非數字）。送出 → `POST /api/public/bookings { coachId, startAt, name, phone }`。

- [ ] **Step 3: 成功頁/區塊**

成功後顯示教練/時間；若 response 有 `lineBindCode` → 顯示「想收 LINE 通知？加官方帳號並貼這組碼：`{code}`（15 分鐘內有效）」。提供「查我的預約」「回首頁」。

- [ ] **Step 4: 手動驗證**：用新電話預約 → 成功頁顯示綁定碼；availability 少一格。

- [ ] **Step 5: Commit**
```bash
git add public/coaches.js public/coaches.html
git commit -m "feat(1on1): anon booking modal (name+phone) + success with LINE bind code"
```

---

## Task C4: 團體課選課 + 匯款流程

**Files:**
- Create/Modify: 團體課列表頁（沿用 `index.html` 區塊或新 `public/group.html` + `public/group.js`；依既有結構決定）

- [ ] **Step 1: 課程列表**

`GET /api/public/group-courses` → 渲染課程卡（template）；展開顯示各場次 `日期 / 時間 / 已佔N/上限M`，滿者標「額滿·可候補」並提供候補勾選。

- [ ] **Step 2: 選課 + 計費**

支援「全選整週期」與單選；即時計算總額 = Σ(被選付款場次的 `price_per_session`)。候補場次不計入總額。

- [ ] **Step 3: 匯款頁 + 送出**

填「姓名*」「電話*」、顯示總額與 `bankInfo`（送出後由 response 帶回顯示完整帳號）→ `POST /api/public/group-orders { name, phone, paySessionIds, waitlistSessionIds }`。
- 成功 → 顯示訂單號、總額、銀行帳號、「請於 {expiresAt} 前完成匯款」、候補清單、`lineBindCode`（若有）。
- `409 sessions_full` → 提示「下列場次已額滿：…，請改候補或取消勾選後再送」（用 `detail.fullSessionIds`）。

- [ ] **Step 4: 手動驗證**：選 2 場 → 總額正確 → 送出 → 成功頁帳號+期限；額滿場次走候補；並發搶最後一位一個 409。

- [ ] **Step 5: Commit**
```bash
git add public/group.html public/group.js public/index.html
git commit -m "feat(group): course select + pricing + bank-transfer submit + success page"
```

---

## Task C5: 我的課表（公開、電話+姓名查）

**Files:**
- Modify: `public/my-schedule.html`、`public/my-schedule.js`

- [ ] **Step 1: 查詢表單**

頁面改為公開：欄位「電話」「姓名」+「查詢」。送出 → `POST /api/public/my { phone, name }`。電話+姓名存 localStorage，下次自動帶入。403 → 顯示「查無資料，請確認電話與姓名」。

- [ ] **Step 2: 渲染**

列出 `items`（依 `kind`/`status` 標籤：`待付款`/`已確認`/`候補中`/`已遞補待付款`(status=pending 且有 order)）；頂部顯示 `1對1剩 {one_on_one_remaining} 堂 · 團體剩 {group_remaining} 堂`。
- 取消按鈕（依 `can_cancel`）：
  - booking → `DELETE /api/public/bookings/:id { phone, name }`
  - registration confirmed/waitlisted → `DELETE /api/public/registrations/:id { phone, name }`
  - 未付 pending（有 order）→「放棄此訂單」→ `DELETE /api/public/group-orders/:order_id { phone, name }`
- 取消後 reload。

- [ ] **Step 3: 手動驗證**：用有資料的電話+姓名查 → 列表/剩堂數正確、可取消；錯姓名 403。

- [ ] **Step 4: Commit**
```bash
git add public/my-schedule.html public/my-schedule.js
git commit -m "feat(my-schedule): public phone+name lookup, statuses, remaining counts, cancel"
```

---

## Task C6: 刪除 register / line 頁

**Files:**
- Delete: `public/register.html`、`public/line.html`、`public/line.js`、`public/line-qr.png`（若不再用）
- Modify: `src/server.js`

- [ ] **Step 1**: 刪檔；全域 grep 確認無連結指向它們（`grep -rn "register.html\|line.html" public/`）。

- [ ] **Step 2**: `src/server.js` 加 `/line.html` 301：
```js
app.get('/line.html', (req, res) => res.redirect(301, '/my-schedule'));
```
（放在 static 之前，仿 line 83-87 的 my-schedule 處理。）確認 `POST /api/auth/register` 已於 A10 移除。

- [ ] **Step 3: 手動驗證**：連 `/line.html` → 301 到 `/my-schedule`；站內無死連結。

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "chore(frontend): remove register.html + line.html (301 → my-schedule)"
```

---

## Phase C Gate（E2E 手動 smoke）

依 spec §8「C 前端」整份清單在瀏覽器跑完（含 LINE 綁定碼貼 bot、並發搶名額、admin/coach navbar、既有後台 regression）。全過 → PR ready → 合併。

---

## 全案完成後

- [ ] 三階段全合併到 `main`；確認 Railway 部署前**備份生產 DB**（migration 含兩個整表 rebuild）。
- [ ] 部署後在生產跑一次 spec §8 的關鍵 smoke（公開預約、admin 核對、my 查詢）。
- [ ] 更新 `MEMORY.md` 的 chinup project 進度註記（Phase「anon-paid-group」已上線）。

---

## 風險備忘（執行時注意）

- **Migration 破壞性**：users / registrations 整表 rebuild。本機先用 `tests/migration.test.js` 驗，生產部署前 `POST /api/admin/backups/run` 或複製 `data/app.db`。
- **`tx()` 巢狀**：所有 service 寫入已用 `tx()`；巢狀安全，但 `notify()` 對已綁 LINE 者會在 caller tx 內排程 async push（見 notifications.js 註解），應於 tx 尾端呼叫。
- **名額權威來源**：一律用 `sessionOccupied()`，勿讀 `course_sessions.confirmed_count`（已不維護、會 drift）。
- **電話 normalize**：前端送出前去掉非數字；後端 `validatePhone` 仍會擋 `/^\d{8,15}$/`。
