# 匿名預約 + 識別簡化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 chinup 從「會員必須登入才能預約」轉成「客人輸入姓名+電話即預約」，admin/coach 才需登入。修掉 admin navbar 看到「教練後台」的 bug。

**Architecture:** 新增 `/api/public/*` 一組匿名端點（與現有 auth 端點並存）；以電話號碼為 user 識別 key；點數系統表保留但程式不再寫入；前端公開化首頁與預約頁，預約成功頁提供 LINE 綁定碼讓客人 opt-in。兩個 PR 分階段：Phase A backend additive、Phase B frontend cutover。

**Tech Stack:** Node 24 (ESM), Express 4, `node:sqlite`, node-native test runner (`node:assert/strict`), Tailwind CDN frontend。

**Spec reference:** `docs/superpowers/specs/2026-05-23-anon-booking-redesign-design.md`

---

## File Structure

### Phase A (Backend, PR #1)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/schema.js` | modify | Fresh-create `users.email` 從 NOT NULL 拿掉；加 `idx_users_phone` partial unique |
| `src/db/connection.js` | modify | 加 idempotent migration：rebuild users table 把 NOT NULL 拿掉、再 CREATE phone unique index |
| `src/services/userService.js` | **create** | `findOrCreateUserByPhone({phone, name})`、phone 格式驗證 |
| `src/services/bookingService.js` | modify | 把 createBooking / cancelBooking 拆成 core + auth wrapper + anon wrapper |
| `src/services/registration.js` | modify | 把 register / cancelRegistration 同樣拆 |
| `src/services/auth.js` | modify | `login()` 擋 `user` role |
| `src/server.js` | modify | 移除 `/api/auth/register` handler；新增 `/api/public/users/lookup`、`/api/public/bookings` (POST + DELETE)、`/api/public/registrations` (POST + DELETE)、`/api/public/my` (GET) |
| `tests/public-api.test.js` | **create** | Integration tests for new endpoints |

### Phase B (Frontend, PR #2)

| File | Action | Responsibility |
|------|--------|---------------|
| `public/app.js` | modify | `bootAuth({requireRole})` 擴充；修 admin showCoach bug |
| `public/index.html` | modify | 公開化、加一對一 CTA hero、團體課列表保留 |
| `public/courses.js` | modify | 改用 `/api/public/*`，預約走 modal |
| `public/coaches.html` | modify | 公開化、加 booking modal + 成功 view |
| `public/coaches.js` | modify | 改用 `/api/public/*`，「最近教練」section 隱藏（無 login） |
| `public/my-schedule.html` | modify | 改成「輸電話查詢」模式 |
| `public/my-schedule.js` | modify | 改用 `/api/public/my?phone=...` |
| `public/login.html` | modify | 文案改「管理員 / 教練專用」、移除 register 連結 |
| `public/admin.html`、`public/coach.html` | modify | 改用 `bootAuth({requireRole:[...]})` |
| `public/register.html` | **delete** | 不再需要 |
| `public/line.html` | **delete** | 改由預約成功頁提供綁定碼 |

---

## Phase A — Backend (PR #1)

**Branch:** `feature/anon-booking-backend`

### Task A0: Setup feature branch

- [ ] **Step 1: Create feature branch from main**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/anon-booking-backend
```

- [ ] **Step 2: Verify clean state**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

### Task A1: Schema — Phone unique index + email nullable on fresh

**Files:**
- Modify: `src/db/schema.js`

- [ ] **Step 1: Edit users table in SCHEMA**

Change line `email TEXT UNIQUE NOT NULL` to `email TEXT UNIQUE` (drop NOT NULL).

- [ ] **Step 2: Add phone unique index after Phase 3C indexes**

Append to `PHASE_3C_INDEXES` (or create new `PHASE_4_INDEXES`):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
  ON users(phone) WHERE phone IS NOT NULL;
```

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.js
git commit -m "schema: drop NOT NULL on users.email, add phone unique index"
```

---

### Task A2: Migration — Rebuild users on legacy DBs to drop NOT NULL

SQLite 不能直接 ALTER COLUMN DROP NOT NULL。對既有生產 DB 要走 table-rebuild。

**Files:**
- Modify: `src/db/connection.js`

- [ ] **Step 1: Add migration function**

After existing `addColumnIfMissing` calls, before `db.exec(PHASE_3C_INDEXES);`, insert:

```js
// Phase 4: drop NOT NULL on users.email if it's still NOT NULL.
// SQLite can't ALTER COLUMN — use the official "table rebuild" recipe.
function migrateUsersEmailNullable() {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const emailCol = cols.find((c) => c.name === 'email');
  if (!emailCol || emailCol.notnull === 0) return;  // already nullable
  console.log('[migration] rebuilding users table to drop NOT NULL on email');
  db.exec('BEGIN');
  try {
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
      );
      INSERT INTO users_new (id, name, email, phone, password_hash, google_id, role,
                             notification_preference, line_user_id, line_bind_code,
                             line_bind_expires_at, created_at)
        SELECT id, name, email, phone, password_hash, google_id, role,
               notification_preference, line_user_id, line_bind_code,
               line_bind_expires_at, created_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
        ON users(google_id) WHERE google_id IS NOT NULL;
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
migrateUsersEmailNullable();
```

- [ ] **Step 2: Boot the server locally to trigger migration**

Run: `npm start`
Expected: log line `[migration] rebuilding users table...` on first boot (if local DB still has NOT NULL); subsequent boots are silent. Server listens on port 3000.

Stop the server with Ctrl+C.

- [ ] **Step 3: Verify migration was idempotent**

Run: `npm start` again
Expected: no migration log this time; server starts cleanly.

Stop the server.

- [ ] **Step 4: Verify column nullable**

```bash
node -e "
import('./src/db/connection.js').then(({db}) => {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const email = cols.find(c => c.name === 'email');
  console.log('email notnull =', email.notnull);
  process.exit(0);
});
" 2>&1 | tail -1
```

Expected: `email notnull = 0`

- [ ] **Step 5: Commit**

```bash
git add src/db/connection.js
git commit -m "migration: rebuild users table to allow NULL email"
```

---

### Task A3: New service — `findOrCreateUserByPhone`

**Files:**
- Create: `src/services/userService.js`
- Test: `tests/user-service.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/user-service.test.js`:

```js
process.env.LINE_MOCK = '1';
import { db } from '../src/db/connection.js';
import { findOrCreateUserByPhone, validatePhone } from '../src/services/userService.js';
import assert from 'node:assert/strict';

function reset() {
  db.exec("DELETE FROM users WHERE email IS NULL OR email LIKE 'test-%@local'");
}

console.log('[user-service test] start');
reset();

// validatePhone
assert.equal(validatePhone('0912345678'), true);
assert.equal(validatePhone('+886912345678'), false);
assert.equal(validatePhone('091234567'), true);   // 9 digits OK
assert.equal(validatePhone('123'), false);         // too short
assert.equal(validatePhone(''), false);
assert.equal(validatePhone('abc1234567'), false);
console.log('  ✓ validatePhone format checks');

// findOrCreateUserByPhone: new
const { userId: id1, created: c1 } = findOrCreateUserByPhone({ phone: '0911111111', name: 'Test Alice' });
assert.ok(id1 > 0);
assert.equal(c1, true);
const row1 = db.prepare('SELECT * FROM users WHERE id = ?').get(id1);
assert.equal(row1.name, 'Test Alice');
assert.equal(row1.phone, '0911111111');
assert.equal(row1.email, null);
assert.equal(row1.role, 'user');
console.log('  ✓ creates new user with NULL email');

// findOrCreateUserByPhone: existing, same name
const { userId: id2, created: c2 } = findOrCreateUserByPhone({ phone: '0911111111', name: 'Test Alice' });
assert.equal(id2, id1);
assert.equal(c2, false);
console.log('  ✓ finds existing user by phone');

// findOrCreateUserByPhone: existing, different name → update
const { userId: id3 } = findOrCreateUserByPhone({ phone: '0911111111', name: 'Test Alice 2' });
assert.equal(id3, id1);
const row3 = db.prepare('SELECT name FROM users WHERE id = ?').get(id1);
assert.equal(row3.name, 'Test Alice 2');
console.log('  ✓ updates name on existing phone');

// invalid phone throws
assert.throws(() => findOrCreateUserByPhone({ phone: '123', name: 'X' }), /invalid_phone/);
console.log('  ✓ throws on invalid phone');

reset();
console.log('[user-service test] done');
```

- [ ] **Step 2: Run test, expect failure**

Run: `node tests/user-service.test.js`
Expected: `Error: Cannot find module '...src/services/userService.js'` or import error.

- [ ] **Step 3: Implement userService.js**

Create `src/services/userService.js`:

```js
import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const PHONE_RE = /^\d{8,15}$/;
export function validatePhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

const getByPhone = db.prepare('SELECT id, name, phone, line_user_id FROM users WHERE phone = ?');
const insertUser = db.prepare(
  'INSERT INTO users (name, phone, role, notification_preference) VALUES (?, ?, ?, ?)'
);
const updateName = db.prepare('UPDATE users SET name = ? WHERE id = ?');

/**
 * Find user by phone or create a new one. Idempotent under concurrent calls
 * via tx() + BEGIN IMMEDIATE.
 *
 * @returns {{ userId: number, created: boolean }}
 */
export function findOrCreateUserByPhone({ phone, name }) {
  if (!validatePhone(phone)) throw new ApiError(400, 'invalid_phone');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  const trimmedName = name.trim();
  return tx(() => {
    const existing = getByPhone.get(phone);
    if (existing) {
      if (existing.name !== trimmedName) {
        updateName.run(trimmedName, existing.id);
      }
      return { userId: existing.id, created: false };
    }
    const info = insertUser.run(trimmedName, phone, 'user', 'email');
    return { userId: info.lastInsertRowid, created: true };
  });
}

export function getUserByPhone(phone) {
  if (!validatePhone(phone)) return null;
  return getByPhone.get(phone);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `node tests/user-service.test.js`
Expected: all `✓` lines, no failures.

- [ ] **Step 5: Commit**

```bash
git add src/services/userService.js tests/user-service.test.js
git commit -m "feat(user-service): add findOrCreateUserByPhone with phone validation"
```

---

### Task A4: Refactor `bookingService` — split create/cancel into core + auth + anon

**Files:**
- Modify: `src/services/bookingService.js`

- [ ] **Step 1: Refactor `createBooking`**

Replace `createBooking` function (line 59) and add `createBookingAnon`:

```js
function createBookingCore({ coachId, memberId, startAt, note }) {
  // Pre-conditions checked by caller (coach existence, active flag).
  const coach = getCoachStmt.get(coachId);
  const endAt = addMinutes(startAt, 60);
  let bookingId;
  try {
    const info = insertBookingStmt.run(coachId, memberId, startAt, endAt, note);
    bookingId = info.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
    throw e;
  }
  // notify coach + member
  const memberRow = getUserNameStmt.get(memberId);
  if (memberRow) {
    const startFmt = fmtDateForLine(startAt);
    notify({
      userId: coach.user_id,
      sessionId: null,
      type: 'booking_created',
      vars: { member_name: memberRow.name, start_at: startFmt },
    });
    notify({
      userId: memberId,
      sessionId: null,
      type: 'booking_confirmed',
      vars: { coach_display_name: coach.display_name, start_at: startFmt },
    });
  }
  return { id: bookingId, startAt, endAt };
}

function preCheck(coachId, memberId, startAt) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
}

export function createBooking({ coachId, memberId, startAt, note = null }) {
  preCheck(coachId, memberId, startAt);
  return tx(() => {
    const result = createBookingCore({ coachId, memberId, startAt, note });
    recordTransaction({
      memberId, pool: 'one_on_one', amount: -1,
      note: `預約 #${result.id}`,
      actorId: memberId,
      source: 'booking_deduct',
      relatedBookingId: result.id,
    });
    return result;
  });
}

export function createBookingAnon({ coachId, memberId, startAt, note = null }) {
  preCheck(coachId, memberId, startAt);
  return tx(() => createBookingCore({ coachId, memberId, startAt, note }));
}
```

- [ ] **Step 2: Refactor `cancelBooking`**

Replace `cancelBooking` (line 102) similarly:

```js
function cancelBookingCore({ bookingId, actorUserId, isCoach, reason }) {
  const b = getBookingStmt.get(bookingId);
  if (!b) throw new ApiError(404, 'booking_not_found');
  if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
  const coach = getCoachStmt.get(b.coach_id);
  if (isCoach) {
    if (!coach || coach.user_id !== actorUserId) throw new ApiError(403, 'forbidden');
    if (!reason || !reason.trim()) throw new ApiError(400, 'missing_reason');
  } else {
    if (b.member_id !== actorUserId) throw new ApiError(403, 'forbidden');
  }
  cancelBookingStmt.run(nowLocal(), actorUserId, reason, bookingId);
  const memberRow = getUserNameStmt.get(b.member_id);
  if (coach && memberRow) {
    const startFmt = fmtDateForLine(b.start_at);
    const isCoachCancel = actorUserId === coach.user_id;
    if (isCoachCancel) {
      notify({
        userId: b.member_id, sessionId: null,
        type: 'booking_cancelled_by_coach',
        vars: { coach_display_name: coach.display_name, start_at: startFmt },
      });
    } else {
      notify({
        userId: coach.user_id, sessionId: null,
        type: 'booking_cancelled_by_member',
        vars: { member_name: memberRow.name, start_at: startFmt },
      });
    }
  }
  return { booking: b, coach };
}

export function cancelBooking({ bookingId, actorUserId, isCoach = false, reason = null }) {
  return tx(() => {
    const { booking } = cancelBookingCore({ bookingId, actorUserId, isCoach, reason });
    const refundNote = isCoach
      ? `取消 #${bookingId}（教練：${reason}）`
      : `取消 #${bookingId}`;
    recordTransaction({
      memberId: booking.member_id, pool: 'one_on_one', amount: 1,
      note: refundNote, actorId: actorUserId,
      source: 'booking_refund', relatedBookingId: bookingId,
    });
    return { ok: true };
  });
}

export function cancelBookingAnon({ bookingId, actorUserId }) {
  return tx(() => {
    cancelBookingCore({ bookingId, actorUserId, isCoach: false, reason: null });
    return { ok: true };
  });
}
```

- [ ] **Step 3: Run existing booking tests, expect pass**

Run: `node tests/booking-flow.test.js`
Expected: all tests pass (backward compatibility — old `createBooking` still deducts points).

Run: `npm run test:api`
Expected: all API tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/bookingService.js
git commit -m "refactor(booking): split createBooking/cancelBooking into core + auth + anon"
```

---

### Task A5: Refactor `registration.js` — split register/cancel into core + auth + anon

**Files:**
- Modify: `src/services/registration.js`

- [ ] **Step 1: Refactor `register`**

After existing `register` function, add anon variant. Restructure as:

```js
function registerCore({ sessionId, userId }) {
  const session = getSession.get(sessionId);
  if (!session) throw new ApiError(404, 'session_not_found');
  if (session.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
  if (session.status === 'completed') throw new ApiError(409, 'session_completed');
  if (nowLocal() > session.registration_deadline) throw new ApiError(409, 'registration_closed');

  const existing = getAnyReg.get(sessionId, userId);
  if (existing && ['confirmed', 'waitlisted'].includes(existing.status)) {
    throw new ApiError(409, 'already_registered');
  }
  const tpl = getTemplate.get(session.template_id);
  const confirmed = getConfirmedCount.get(sessionId).c;
  let status, position;
  if (confirmed < tpl.max_capacity) { status = 'confirmed'; position = null; }
  else { status = 'waitlisted'; position = session.waitlist_count + 1; }

  let registrationId;
  if (existing) {
    reactivateReg.run(status, position, existing.id);
    registrationId = existing.id;
  } else {
    const info = insertReg.run(sessionId, userId, status, position);
    registrationId = info.lastInsertRowid;
  }
  recalcAndSave(sessionId);

  const vars = { course_name: tpl.name, start_at: session.start_at, position };
  notify({
    userId, sessionId,
    type: status === 'confirmed' ? 'registered_confirmed' : 'registered_waitlisted',
    vars,
  });
  return { registrationId, status, position };
}

export function register({ sessionId, userId }) {
  return tx(() => {
    const result = registerCore({ sessionId, userId });
    recordTransaction({
      memberId: userId, pool: 'group', amount: -1,
      note: `報名 #${result.registrationId}`,
      actorId: userId, source: 'registration_deduct',
      relatedRegistrationId: result.registrationId, relatedSessionId: sessionId,
    });
    return result;
  });
}

export function registerAnon({ sessionId, userId }) {
  return tx(() => registerCore({ sessionId, userId }));
}
```

- [ ] **Step 2: Refactor `cancelRegistration`**

```js
function cancelRegistrationCore({ registrationId, userId }) {
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registrationId);
  if (!reg) throw new ApiError(404, 'registration_not_found');
  if (reg.user_id !== userId) throw new ApiError(403, 'forbidden');
  if (reg.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
  const session = getSession.get(reg.session_id);
  const tpl = getTemplate.get(session.template_id);
  const wasConfirmed = reg.status === 'confirmed';
  updateRegStatus.run('cancelled', null, reg.id);

  notify({
    userId, sessionId: session.id,
    type: 'registration_cancelled',
    vars: { course_name: tpl.name, start_at: session.start_at },
  });

  if (wasConfirmed && session.status !== 'cancelled') {
    const queue = getWaitlistQueue.all(session.id);
    if (queue.length > 0) {
      const next = queue[0];
      updateRegStatus.run('confirmed', null, next.id);
      notify({
        userId: next.user_id, sessionId: session.id,
        type: 'promoted',
        vars: { course_name: tpl.name, start_at: session.start_at },
      });
    }
  }
  recalcAndSave(session.id);
  renumberWaitlist(session.id);
  return { reg, session };
}

export function cancelRegistration({ registrationId, userId }) {
  return tx(() => {
    const { reg, session } = cancelRegistrationCore({ registrationId, userId });
    recordTransaction({
      memberId: userId, pool: 'group', amount: 1,
      note: `取消 #${reg.id}`,
      actorId: userId, source: 'registration_refund',
      relatedRegistrationId: reg.id, relatedSessionId: session.id,
    });
    return { ok: true };
  });
}

export function cancelRegistrationAnon({ registrationId, userId }) {
  return tx(() => {
    cancelRegistrationCore({ registrationId, userId });
    return { ok: true };
  });
}
```

- [ ] **Step 3: Run flow tests, expect pass**

Run: `node tests/flow.test.js`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/services/registration.js
git commit -m "refactor(registration): split register/cancel into core + auth + anon"
```

---

### Task A6: Block user-role login in auth.js

**Files:**
- Modify: `src/services/auth.js`

- [ ] **Step 1: Edit `login()`**

In `src/services/auth.js` line 49, after password verification, before `createSession`:

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

- [ ] **Step 2: Same lock in Google OAuth path**

In `loginAsGoogleUser` (line 120):

```js
export function loginAsGoogleUser(user) {
  if (user.role === 'user') throw new ApiError(403, 'user_login_disabled');
  const session = createSession(user.id);
  return { token: session.token, user: safeUser(user), expiresAt: session.expiresAt };
}
```

- [ ] **Step 3: Write test**

Append to `tests/api.test.js` (or create `tests/auth-lock.test.js`):

```js
// Verify user-role accounts cannot login after Phase 4 lock
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

const r1 = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ email: 'user1@chinup.local', password: 'pass1234' })
});
assert.equal(r1.status, 403);
console.log('  ✓ user-role login blocked');

const r2 = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ email: 'admin@chinup.local', password: 'admin1234' })
});
assert.equal(r2.status, 200);
console.log('  ✓ admin login still works');
```

- [ ] **Step 4: Reseed DB and start server**

```bash
npm run seed && npm start &
sleep 2
```

- [ ] **Step 5: Run test**

Run: `node tests/auth-lock.test.js`
Expected: both `✓` lines.

```bash
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add src/services/auth.js tests/auth-lock.test.js
git commit -m "feat(auth): block user-role login (admin/coach only)"
```

---

### Task A7: Remove `/api/auth/register` endpoint and `registerWithPassword`

**Files:**
- Modify: `src/server.js`、`src/services/auth.js`

- [ ] **Step 1: Remove route**

In `src/server.js` line 161, delete the entire `app.post('/api/auth/register', ...)` block.

- [ ] **Step 2: Remove import**

If `registerWithPassword` is imported in server.js, remove it from the imports.

- [ ] **Step 3: Remove function**

In `src/services/auth.js`, delete the `registerWithPassword` function (line 59).

- [ ] **Step 4: Run existing tests**

Run: `npm run test:api`
Expected: all pass. If any test calls `/api/auth/register` for setup, replace with direct seed.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/services/auth.js
git commit -m "feat(auth): remove /api/auth/register endpoint and registerWithPassword"
```

---

### Task A8: New endpoint — `POST /api/public/users/lookup`

**Files:**
- Modify: `src/server.js`
- Create/append: `tests/public-api.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/public-api.test.js`:

```js
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: {'Content-Type':'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: res.status, data };
}

console.log('[public-api test] start');

// lookup unknown phone
{
  const r = await req('POST', '/api/public/users/lookup', { phone: '0999000111' });
  assert.equal(r.status, 200);
  assert.equal(r.data.exists, false);
  console.log('  ✓ lookup unknown phone → exists:false');
}

// lookup known phone (seed user1 phone = '090000001' per seed.js — verify and adjust)
{
  const r = await req('POST', '/api/public/users/lookup', { phone: '0900000001' });
  assert.equal(r.status, 200);
  assert.equal(r.data.exists, true);
  assert.equal(r.data.name, '會員1');
  console.log('  ✓ lookup known phone → exists:true with name');
}

// invalid phone
{
  const r = await req('POST', '/api/public/users/lookup', { phone: '123' });
  assert.equal(r.status, 400);
  console.log('  ✓ invalid phone → 400');
}

console.log('[public-api test] done');
```

- [ ] **Step 2: Run test (server not yet has endpoint)**

Make sure server is running with reseeded DB:

```bash
npm run seed && npm start &
sleep 2
```

Run: `node tests/public-api.test.js`
Expected: first assertion fails with 404 (route doesn't exist).

- [ ] **Step 3: Add endpoint in server.js**

After existing `/api/auth/me` block (around line 174), before `// --- Google OAuth ---`:

```js
// --- Public (no auth) endpoints for anon booking flow ---
import { findOrCreateUserByPhone, getUserByPhone, validatePhone } from './services/userService.js';

app.post('/api/public/users/lookup', asyncHandler((req, res) => {
  const { phone } = req.body || {};
  if (!validatePhone(phone)) return res.status(400).json({ error: 'invalid_phone' });
  const user = getUserByPhone(phone);
  res.json({ exists: !!user, name: user?.name || null });
}));
```

Note: the `import` should be moved to the top of the file with other imports. The route can stay inline.

- [ ] **Step 4: Restart server, re-run test**

```bash
kill %1
npm start &
sleep 2
node tests/public-api.test.js
```

Expected: 3× `✓`.

- [ ] **Step 5: Stop server, commit**

```bash
kill %1
git add src/server.js tests/public-api.test.js
git commit -m "feat(public-api): add POST /api/public/users/lookup"
```

---

### Task A9: New endpoint — `POST /api/public/bookings`

**Files:**
- Modify: `src/server.js`
- Append: `tests/public-api.test.js`

- [ ] **Step 1: Add test cases at end of `tests/public-api.test.js`**

```js
// Need an active coach — fetch /api/coaches (public)
const coachesRes = await fetch(BASE + '/api/coaches');
const coaches = await coachesRes.json();
const coach = coaches[0];
assert.ok(coach, 'need at least one active coach in seed');

// startAt: tomorrow 14:00 local
const tomorrow = new Date(Date.now() + 86400000);
const startAt = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T14:00:00`;

// anon booking with new phone
{
  const r = await req('POST', '/api/public/bookings', {
    coachId: coach.id, startAt,
    name: 'Test Anon', phone: '0988111222',
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.bookingId);
  assert.equal(r.data.startAt, startAt);
  assert.ok(r.data.lineBindCode);  // new user, not bound, should get code
  console.log('  ✓ anon booking creates user + booking + bind code');
}

// repeat with same phone, different name → reuse + update name
{
  const startAt2 = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T15:00:00`;
  const r = await req('POST', '/api/public/bookings', {
    coachId: coach.id, startAt: startAt2,
    name: 'Test Anon Renamed', phone: '0988111222',
  });
  assert.equal(r.status, 200);
  // name in DB should be updated — verify via lookup
  const look = await req('POST', '/api/public/users/lookup', { phone: '0988111222' });
  assert.equal(look.data.name, 'Test Anon Renamed');
  console.log('  ✓ same phone reuses user, updates name');
}

// slot collision
{
  const r = await req('POST', '/api/public/bookings', {
    coachId: coach.id, startAt,
    name: 'Other Person', phone: '0988999000',
  });
  assert.equal(r.status, 409);
  console.log('  ✓ slot collision → 409');
}

// missing fields
{
  const r = await req('POST', '/api/public/bookings', { coachId: coach.id });
  assert.equal(r.status, 400);
  console.log('  ✓ missing fields → 400');
}
```

- [ ] **Step 2: Add endpoint in server.js**

In the public endpoints section, after lookup:

```js
import { generateBindCode } from './services/lineBindingService.js';
import { createBookingAnon } from './services/bookingService.js';

app.post('/api/public/bookings', asyncHandler((req, res) => {
  const { coachId, startAt, name, phone, note } = req.body || {};
  if (!coachId || !startAt) return res.status(400).json({ error: 'missing_fields' });
  if (!validatePhone(phone)) return res.status(400).json({ error: 'invalid_phone' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'missing_name' });

  const { userId } = findOrCreateUserByPhone({ phone, name });
  const booking = createBookingAnon({ coachId, memberId: userId, startAt, note: note || null });

  const user = getUserByPhone(phone);
  let lineBindCode = null, lineBindExpiresAt = null;
  if (!user.line_user_id) {
    const bc = generateBindCode(userId);
    lineBindCode = bc.code;
    lineBindExpiresAt = bc.expires_at;
  }

  res.json({
    bookingId: booking.id,
    startAt: booking.startAt,
    endAt: booking.endAt,
    lineBindCode,
    lineBindExpiresAt,
  });
}));
```

- [ ] **Step 3: Reseed, restart, run test**

```bash
npm run seed && npm start &
sleep 2
node tests/public-api.test.js
kill %1
```

Expected: all `✓`.

- [ ] **Step 4: Commit**

```bash
git add src/server.js tests/public-api.test.js
git commit -m "feat(public-api): add POST /api/public/bookings"
```

---

### Task A10: New endpoint — `POST /api/public/registrations`

**Files:**
- Modify: `src/server.js`
- Append: `tests/public-api.test.js`

- [ ] **Step 1: Add test cases**

Append to `tests/public-api.test.js`:

```js
// Need an open session — find one via /api/sessions
const sessRes = await fetch(BASE + '/api/sessions');
const sessions = await sessRes.json();
const openSess = sessions.find((s) => s.status === 'open' && s.confirmed_count < s.max_capacity);
assert.ok(openSess, 'need at least one open session');

// anon registration
{
  const r = await req('POST', '/api/public/registrations', {
    sessionId: openSess.id,
    name: 'Anon Reg', phone: '0977555666',
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.registrationId);
  assert.ok(['confirmed','waitlisted'].includes(r.data.status));
  assert.ok(r.data.lineBindCode);  // new user
  console.log('  ✓ anon registration succeeds');
}

// double-register same phone same session
{
  const r = await req('POST', '/api/public/registrations', {
    sessionId: openSess.id,
    name: 'Anon Reg', phone: '0977555666',
  });
  assert.equal(r.status, 409);
  console.log('  ✓ duplicate registration → 409');
}
```

- [ ] **Step 2: Add endpoint**

```js
import { registerAnon } from './services/registration.js';

app.post('/api/public/registrations', asyncHandler((req, res) => {
  const { sessionId, name, phone } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'missing_fields' });
  if (!validatePhone(phone)) return res.status(400).json({ error: 'invalid_phone' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'missing_name' });

  const { userId } = findOrCreateUserByPhone({ phone, name });
  const result = registerAnon({ sessionId, userId });

  const user = getUserByPhone(phone);
  let lineBindCode = null, lineBindExpiresAt = null;
  if (!user.line_user_id) {
    const bc = generateBindCode(userId);
    lineBindCode = bc.code;
    lineBindExpiresAt = bc.expires_at;
  }

  res.json({
    registrationId: result.registrationId,
    status: result.status,
    position: result.position,
    lineBindCode,
    lineBindExpiresAt,
  });
}));
```

- [ ] **Step 3: Reseed, restart, test**

```bash
npm run seed && npm start &
sleep 2
node tests/public-api.test.js
kill %1
```

Expected: all `✓`.

- [ ] **Step 4: Commit**

```bash
git add src/server.js tests/public-api.test.js
git commit -m "feat(public-api): add POST /api/public/registrations"
```

---

### Task A11: New endpoint — `GET /api/public/my`

**Files:**
- Modify: `src/server.js`
- Append: `tests/public-api.test.js`

- [ ] **Step 1: Add test**

Append:

```js
// fetch my bookings + registrations by phone (use the phone from earlier anon booking)
{
  const r = await fetch(BASE + '/api/public/my?phone=0988111222');
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.user.phone, '0988111222');
  assert.ok(Array.isArray(data.bookings));
  assert.ok(Array.isArray(data.registrations));
  assert.ok(data.bookings.length >= 1);
  console.log('  ✓ my-by-phone returns bookings');
}

// unknown phone
{
  const r = await fetch(BASE + '/api/public/my?phone=0000000000');
  assert.equal(r.status, 404);
  console.log('  ✓ unknown phone → 404');
}

// invalid phone
{
  const r = await fetch(BASE + '/api/public/my?phone=abc');
  assert.equal(r.status, 400);
  console.log('  ✓ invalid phone → 400');
}
```

- [ ] **Step 2: Add endpoint**

```js
import { listMemberBookings } from './services/bookingService.js';

const listMemberRegs = db.prepare(`
  SELECT r.id, r.session_id, r.status, r.position, r.registered_at,
         s.start_at, s.template_id, t.name AS course_name
  FROM registrations r
  JOIN course_sessions s ON s.id = r.session_id
  JOIN course_templates t ON t.id = s.template_id
  WHERE r.user_id = ? AND r.status != 'cancelled'
  ORDER BY s.start_at DESC
`);

app.get('/api/public/my', asyncHandler((req, res) => {
  const phone = req.query.phone;
  if (!validatePhone(phone)) return res.status(400).json({ error: 'invalid_phone' });
  const user = getUserByPhone(phone);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const bookings = listMemberBookings(user.id).filter((b) => b.status !== 'cancelled');
  const registrations = listMemberRegs.all(user.id);
  res.json({
    user: { name: user.name, phone: user.phone },
    bookings,
    registrations,
  });
}));
```

Note: `db` import already exists in server.js or accessible via existing imports — check and adjust.

- [ ] **Step 3: Reseed, restart, test**

```bash
npm run seed && npm start &
sleep 2
node tests/public-api.test.js
kill %1
```

Expected: all `✓`.

- [ ] **Step 4: Commit**

```bash
git add src/server.js tests/public-api.test.js
git commit -m "feat(public-api): add GET /api/public/my"
```

---

### Task A12: New endpoints — `DELETE /api/public/bookings/:id`、`DELETE /api/public/registrations/:id`

**Files:**
- Modify: `src/server.js`
- Append: `tests/public-api.test.js`

- [ ] **Step 1: Add tests**

```js
// Pick a booking ID owned by phone 0988111222 from earlier
const myAgain = await (await fetch(BASE + '/api/public/my?phone=0988111222')).json();
const bookingId = myAgain.bookings[0].id;

// wrong phone → 403
{
  const r = await fetch(BASE + `/api/public/bookings/${bookingId}?phone=0999999999`, { method:'DELETE' });
  assert.equal(r.status, 403);
  console.log('  ✓ wrong phone cancel → 403');
}

// correct phone → 200
{
  const r = await fetch(BASE + `/api/public/bookings/${bookingId}?phone=0988111222`, { method:'DELETE' });
  assert.equal(r.status, 200);
  console.log('  ✓ correct phone cancel → 200');
}

// double cancel → 409
{
  const r = await fetch(BASE + `/api/public/bookings/${bookingId}?phone=0988111222`, { method:'DELETE' });
  assert.equal(r.status, 409);
  console.log('  ✓ double cancel → 409');
}

// Same pattern for registrations
const regId = myAgain.registrations[0]?.id;
if (regId) {
  // skip — registrations test in next task block if needed
}
```

- [ ] **Step 2: Add endpoints**

```js
import { cancelBookingAnon } from './services/bookingService.js';
import { cancelRegistrationAnon } from './services/registration.js';

app.delete('/api/public/bookings/:id', asyncHandler((req, res) => {
  const bookingId = Number(req.params.id);
  const phone = req.query.phone;
  if (!validatePhone(phone)) return res.status(400).json({ error: 'invalid_phone' });
  const user = getUserByPhone(phone);
  if (!user) return res.status(404).json({ error: 'not_found' });
  // Pre-check ownership without holding tx
  const b = db.prepare('SELECT member_id FROM bookings WHERE id = ?').get(bookingId);
  if (!b) return res.status(404).json({ error: 'booking_not_found' });
  if (b.member_id !== user.id) return res.status(403).json({ error: 'forbidden' });
  cancelBookingAnon({ bookingId, actorUserId: user.id });
  res.json({ ok: true });
}));

app.delete('/api/public/registrations/:id', asyncHandler((req, res) => {
  const registrationId = Number(req.params.id);
  const phone = req.query.phone;
  if (!validatePhone(phone)) return res.status(400).json({ error: 'invalid_phone' });
  const user = getUserByPhone(phone);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('SELECT user_id FROM registrations WHERE id = ?').get(registrationId);
  if (!r) return res.status(404).json({ error: 'registration_not_found' });
  if (r.user_id !== user.id) return res.status(403).json({ error: 'forbidden' });
  cancelRegistrationAnon({ registrationId, userId: user.id });
  res.json({ ok: true });
}));
```

- [ ] **Step 3: Reseed, restart, test**

```bash
npm run seed && npm start &
sleep 2
node tests/public-api.test.js
kill %1
```

Expected: all `✓`.

- [ ] **Step 4: Commit**

```bash
git add src/server.js tests/public-api.test.js
git commit -m "feat(public-api): add DELETE /api/public/bookings/:id and /registrations/:id"
```

---

### Task A13: Update package.json test scripts to include public-api test

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `test:api` script**

```json
"test:api": "node tests/api.test.js && node tests/booking-api.test.js && node tests/backup-api.test.js && node tests/rate-limit.test.js && node tests/public-api.test.js && node tests/auth-lock.test.js"
```

- [ ] **Step 2: Reseed, run full test:api**

```bash
npm run seed && npm start &
sleep 2
npm run test:api
kill %1
```

Expected: all green.

- [ ] **Step 3: Run flow tests**

```bash
npm run test:flow
```

Expected: all green.

- [ ] **Step 4: Run user-service test**

```bash
node tests/user-service.test.js
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "test: include public-api + auth-lock + user-service in test scripts"
```

---

### Task A14: Open draft PR for Phase A, smoke in production

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/anon-booking-backend
```

- [ ] **Step 2: Open draft PR**

```bash
PAT=$(echo "url=https://github.com" | git credential fill 2>/dev/null | grep "^password=" | cut -d= -f2)
curl -s -X POST -H "Authorization: token $PAT" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls -d '{
  "title": "Phase 4A: anon-booking backend",
  "body": "Backend half of anon-booking redesign. See docs/superpowers/specs/2026-05-23-anon-booking-redesign-design.md.\n\n- schema: email nullable, phone unique index\n- userService.findOrCreateUserByPhone\n- bookingService / registration split into core+auth+anon\n- /api/public/* endpoints (lookup, bookings, registrations, my)\n- user-role login blocked\n- /api/auth/register removed\n\nDoes not change UI; admin/coach flows untouched.",
  "head": "feature/anon-booking-backend",
  "base": "main",
  "draft": true
}' | python3 -c "import sys, json; d=json.load(sys.stdin); print('PR #'+str(d.get('number')), d.get('html_url'))"
```

- [ ] **Step 3: Manual ready + merge after smoke**

Wait for user confirmation to mark ready + merge. After merge:

```bash
git checkout main && git pull --ff-only
```

- [ ] **Step 4: Production smoke (Railway auto-deploys main)**

Wait for Railway deploy (~2 min). Then via curl against production:

```bash
# anon booking lookup with new phone
curl -s -X POST https://chinup-fitness-system-production-0834.up.railway.app/api/public/users/lookup \
  -H "Content-Type: application/json" -d '{"phone":"0900000001"}'
# expected: {"exists":false,"name":null} or whatever real production phone state is
```

Manual checklist per spec §6 Phase A.

---

## Phase B — Frontend (PR #2)

**Branch:** `feature/anon-booking-frontend`
**Prerequisite:** Phase A merged and deployed.

### Task B0: Setup branch

- [ ] **Step 1**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/anon-booking-frontend
```

---

### Task B1: Extend `bootAuth` to accept `requireRole`

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Update `bootAuth` signature**

Replace the function (around line 106):

```js
export async function bootAuth({ requireAdmin = false, requireRole = null } = {}) {
  const token = getToken();
  if (!token) { redirectToLogin(); return null; }

  let user;
  try {
    user = await api('/api/auth/me');
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    return null;
  }

  if (requireAdmin && !['admin', 'owner'].includes(user.role)) {
    location.href = '/'; return null;
  }
  if (requireRole) {
    const allowed = Array.isArray(requireRole) ? requireRole : [requireRole];
    if (!allowed.includes(user.role)) { location.href = '/'; return null; }
  }

  await renderAuthBar(user);
  document.body.style.visibility = 'visible';
  return user;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat(app): bootAuth accepts requireRole alongside requireAdmin"
```

---

### Task B2: Fix admin sees "教練後台" nav bug

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Edit `renderAuthBar`**

Line ~136, change:

```js
const showCoach = ['coach', 'admin', 'owner'].includes(user.role);
```

to:

```js
const showCoach = user.role === 'coach';
```

- [ ] **Step 2: Manual smoke in browser**

Reseed DB, restart server, login as admin → verify navbar shows only "管理後台", not "教練後台".

Login as a coach (need to seed one — verify navbar shows only "教練後台", not "管理後台").

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "fix(nav): admin should not see 教練後台 link"
```

---

### Task B3: Convert `/` (index.html) to anonymous + add one-on-one CTA

**Files:**
- Modify: `public/index.html`、`public/courses.js`

- [ ] **Step 1: Add anon-friendly navbar in `index.html`**

Replace the existing navbar (lines ~17-50) with:

```html
<nav class="navbar sticky top-0 z-20">
  <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <div class="flex items-center gap-8">
      <a href="/" class="brand-mark">CHINUP</a>
      <div class="hidden md:flex items-center gap-6">
        <a href="/coaches.html" class="nav-link">一對一</a>
        <a href="/" class="nav-link active">團體課</a>
        <a href="/my-schedule.html" class="nav-link">我的預約</a>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <div id="auth-bar"></div>
      <a href="/login.html" class="nav-link text-sm" id="staff-login-link">管理員 / 教練登入</a>
      <button id="mobile-menu-btn" class="md:hidden">☰</button>
    </div>
  </div>
  <div id="mobile-menu" class="md:hidden hidden bg-white border-t">
    <a href="/coaches.html" class="nav-link-mobile">一對一</a>
    <a href="/" class="nav-link-mobile">團體課</a>
    <a href="/my-schedule.html" class="nav-link-mobile">我的預約</a>
    <a href="/login.html" class="nav-link-mobile">管理員 / 教練登入</a>
  </div>
</nav>
```

- [ ] **Step 2: Add one-on-one hero card above sessions list**

In the main content area before `<div id="sessions">`:

```html
<section class="max-w-6xl mx-auto px-6 mt-6">
  <a href="/coaches.html" class="block card p-6 bg-gradient-to-r from-amber-100 to-amber-50 hover:shadow-md transition">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900">一對一私人教練</h2>
        <p class="text-sm text-slate-600 mt-1">客製化訓練、彈性時段</p>
      </div>
      <div class="text-3xl">→</div>
    </div>
  </a>
</section>
```

- [ ] **Step 3: Remove `bootAuth()` call in `public/courses.js`**

Find the `bootAuth` call at the top of `courses.js` and remove it. Replace `api('/api/my/registrations')` calls with: skip (anonymous users don't have personalized "registered" state — show all as available).

Adjust the registration button click handler from old auth-flow:

```js
// before: directly POST /api/registrations
// after: open modal with name+phone form, then POST /api/public/registrations
list.addEventListener('click', (e) => {
  const btn = e.target.closest('.register-btn');
  if (!btn) return;
  const sessionId = Number(btn.dataset.sessionId);
  openRegistrationModal(sessionId);
});
```

- [ ] **Step 4: Add modal + success view inside `index.html`**

```html
<div id="reg-modal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-lg max-w-md w-full p-6">
    <h3 class="text-lg font-bold mb-4">報名課程</h3>
    <div id="reg-session-info" class="text-sm text-slate-600 mb-4"></div>
    <form id="reg-form" class="space-y-3">
      <label class="block">
        <span class="text-sm">電話 *</span>
        <input id="reg-phone" type="tel" required pattern="\d{8,15}"
               class="form-input w-full mt-1" placeholder="0912345678">
      </label>
      <label class="block">
        <span class="text-sm">姓名 *</span>
        <input id="reg-name" type="text" required class="form-input w-full mt-1">
      </label>
      <div class="flex gap-2 justify-end pt-2">
        <button type="button" id="reg-cancel" class="btn btn-secondary">取消</button>
        <button type="submit" class="btn btn-primary">送出報名</button>
      </div>
    </form>
  </div>
</div>

<div id="reg-success" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-lg max-w-md w-full p-6">
    <h3 class="text-lg font-bold mb-2">✅ 報名成功</h3>
    <div id="reg-success-info" class="text-sm text-slate-700 mb-4"></div>
    <div id="reg-success-bind" class="bg-amber-50 border border-amber-200 rounded p-4 mb-4 hidden">
      <p class="text-sm font-semibold mb-2">想收 LINE 通知？</p>
      <p class="text-xs text-slate-600 mb-2">1. 加 chinup 官方 LINE 好友<br>2. 傳這組 6 位數碼給機器人（15 分內有效）：</p>
      <p class="text-2xl font-mono text-center tracking-widest text-amber-700" id="reg-bind-code"></p>
    </div>
    <div class="flex gap-2 justify-end">
      <a href="/my-schedule.html" class="btn btn-secondary">查我的預約</a>
      <button id="reg-success-close" class="btn btn-primary">關閉</button>
    </div>
  </div>
</div>
```

- [ ] **Step 5: Implement modal logic in `courses.js`**

Append:

```js
function openRegistrationModal(sessionId) {
  const sess = window.__lastSessions?.find((s) => s.id === sessionId);
  if (!sess) return;
  document.getElementById('reg-session-info').textContent =
    `${sess.template_name || ''} · ${sess.start_at}`;
  document.getElementById('reg-modal').classList.remove('hidden');
  document.getElementById('reg-form').dataset.sessionId = sessionId;

  // Prefill via lookup on phone blur
  document.getElementById('reg-phone').addEventListener('blur', async (e) => {
    const phone = e.target.value.trim();
    if (!/^\d{8,15}$/.test(phone)) return;
    try {
      const r = await fetch('/api/public/users/lookup', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ phone }),
      });
      const d = await r.json();
      if (d.exists && d.name) document.getElementById('reg-name').value = d.name;
    } catch {}
  }, { once: true });
}

document.getElementById('reg-cancel').addEventListener('click', () => {
  document.getElementById('reg-modal').classList.add('hidden');
});

document.getElementById('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sessionId = Number(e.target.dataset.sessionId);
  const name = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  try {
    const r = await fetch('/api/public/registrations', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId, name, phone }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.error || '報名失敗', 'error'); return; }
    document.getElementById('reg-modal').classList.add('hidden');
    document.getElementById('reg-success-info').textContent =
      d.status === 'confirmed' ? '已成功報名！' : `候補第 ${d.position} 位，正取取消會自動遞補`;
    if (d.lineBindCode) {
      document.getElementById('reg-bind-code').textContent = d.lineBindCode;
      document.getElementById('reg-success-bind').classList.remove('hidden');
    } else {
      document.getElementById('reg-success-bind').classList.add('hidden');
    }
    document.getElementById('reg-success').classList.remove('hidden');
    // remember phone for next time
    localStorage.setItem('chinup_phone', phone);
  } catch (err) {
    toast('網路錯誤，請重試', 'error');
  }
});

document.getElementById('reg-success-close').addEventListener('click', () => {
  document.getElementById('reg-success').classList.add('hidden');
  loadSessions();  // reload to show updated state
});
```

(`window.__lastSessions` should be set inside `loadSessions()` after fetching.)

- [ ] **Step 6: Hide staff-login when admin/coach is logged in**

In `app.js` `renderAuthBar`, after the existing nav toggles:

```js
const staffLink = document.getElementById('staff-login-link');
if (staffLink) staffLink.style.display = 'none';  // already logged in, hide
```

- [ ] **Step 7: Manual smoke**

Reseed DB, restart server. Open `http://localhost:3000/` in browser without a token in localStorage:
- ✓ no redirect to login
- ✓ see 一對一 hero card + 團體課 list
- ✓ click "立即報名" → modal opens
- ✓ enter phone+name → submit → success screen with bind code

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/courses.js public/app.js
git commit -m "feat(index): anonymous group-course flow + 1-on-1 CTA + booking modal"
```

---

### Task B4: Convert `/coaches.html` to anonymous + booking modal

**Files:**
- Modify: `public/coaches.html`、`public/coaches.js`

- [ ] **Step 1: Remove `bootAuth()` from coaches.js**

Top of file: replace with optional user fetch (so "最近教練" section can still show if logged-in, but no redirect):

```js
async function maybeGetUser() {
  const token = localStorage.getItem('chinup_token');
  if (!token) return null;
  try { return await api('/api/auth/me'); } catch { return null; }
}
const user = await maybeGetUser();
// only show "你最近的教練" if user is role='user' (and has bookings) — anon users skip
const showRecent = user?.role === 'user';
```

- [ ] **Step 2: Update navbar in coaches.html**

Match the anon navbar template from B3 Step 1.

- [ ] **Step 3: Adapt view-confirm to take name+phone instead of relying on logged-in user**

In `view-confirm` HTML (find the existing block), add fields:

```html
<div id="confirm-anon-form" class="space-y-3 mb-4">
  <label class="block">
    <span class="text-sm">電話 *</span>
    <input id="confirm-phone" type="tel" required pattern="\d{8,15}"
           class="form-input w-full mt-1" placeholder="0912345678">
  </label>
  <label class="block">
    <span class="text-sm">姓名 *</span>
    <input id="confirm-name" type="text" required class="form-input w-full mt-1">
  </label>
</div>
```

Prefill from `localStorage.getItem('chinup_phone')` on render.

- [ ] **Step 4: Adapt confirm submit handler**

Replace `POST /api/bookings` call with `POST /api/public/bookings`:

```js
async function submitBooking() {
  const phone = document.getElementById('confirm-phone').value.trim();
  const name = document.getElementById('confirm-name').value.trim();
  if (!/^\d{8,15}$/.test(phone) || !name) {
    toast('請填正確電話 + 姓名', 'error'); return;
  }
  const r = await fetch('/api/public/bookings', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      coachId: currentCoachId,
      startAt: currentStartAt,
      name, phone,
    }),
  });
  const d = await r.json();
  if (!r.ok) { toast(d.error || '預約失敗', 'error'); return; }
  localStorage.setItem('chinup_phone', phone);
  showBookingSuccess(d);
}
```

- [ ] **Step 5: Add success view template**

Add a new view (`view-success`) in coaches.html similar to the reg-success in B3:

```html
<div id="view-success" class="hidden">
  <h2 class="text-xl font-bold mb-2">✅ 預約成功</h2>
  <div id="success-info" class="text-sm text-slate-700 mb-4"></div>
  <div id="success-bind" class="bg-amber-50 border border-amber-200 rounded p-4 mb-4 hidden">
    <p class="text-sm font-semibold mb-2">想收 LINE 通知？</p>
    <p class="text-xs text-slate-600 mb-2">1. 加 chinup 官方 LINE 好友<br>2. 傳這組 6 位數碼給機器人（15 分內有效）：</p>
    <p class="text-2xl font-mono text-center tracking-widest text-amber-700" id="success-bind-code"></p>
  </div>
  <div class="flex gap-2">
    <a href="/my-schedule.html" class="btn btn-secondary">查我的預約</a>
    <a href="/coaches.html" class="btn btn-primary">回教練列表</a>
  </div>
</div>
```

Implement `showBookingSuccess(d)`:

```js
function showBookingSuccess(d) {
  document.getElementById('view-confirm').classList.add('hidden');
  document.getElementById('success-info').textContent =
    `教練：${currentCoach.display_name}　時間：${fmtDate(d.startAt)}`;
  if (d.lineBindCode) {
    document.getElementById('success-bind-code').textContent = d.lineBindCode;
    document.getElementById('success-bind').classList.remove('hidden');
  } else {
    document.getElementById('success-bind').classList.add('hidden');
  }
  document.getElementById('view-success').classList.remove('hidden');
}
```

- [ ] **Step 6: Manual smoke**

Restart server, open `/coaches.html` without login:
- ✓ no redirect
- ✓ coach list renders
- ✓ click coach → detail page
- ✓ click time slot → confirm view shows name/phone form
- ✓ submit → success view with bind code

- [ ] **Step 7: Commit**

```bash
git add public/coaches.html public/coaches.js
git commit -m "feat(coaches): anonymous 1-on-1 booking flow with name+phone form"
```

---

### Task B5: Convert `/my-schedule.html` to phone-lookup mode

**Files:**
- Modify: `public/my-schedule.html`、`public/my-schedule.js`

- [ ] **Step 1: Replace top of my-schedule.html body**

Replace the page header (everything above the bookings list) with:

```html
<main class="max-w-3xl mx-auto px-6 mt-6">
  <h1 class="text-2xl font-bold mb-4">我的預約</h1>
  <form id="phone-form" class="flex gap-2 mb-6">
    <input id="phone-input" type="tel" required pattern="\d{8,15}"
           placeholder="輸入電話查詢" class="form-input flex-1">
    <button type="submit" class="btn btn-primary">查詢</button>
  </form>
  <div id="results"></div>
</main>
```

Match navbar to anon template from B3 Step 1.

- [ ] **Step 2: Replace my-schedule.js**

```js
import { api, toast, fmtDate, escapeHtml } from './app.js';

const remembered = localStorage.getItem('chinup_phone');
if (remembered) {
  document.getElementById('phone-input').value = remembered;
  loadByPhone(remembered);
}

document.getElementById('phone-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const phone = document.getElementById('phone-input').value.trim();
  if (!/^\d{8,15}$/.test(phone)) { toast('電話格式錯誤', 'error'); return; }
  localStorage.setItem('chinup_phone', phone);
  loadByPhone(phone);
});

async function loadByPhone(phone) {
  const results = document.getElementById('results');
  results.innerHTML = '<p class="text-slate-500">查詢中...</p>';
  const r = await fetch(`/api/public/my?phone=${encodeURIComponent(phone)}`);
  if (r.status === 404) {
    results.innerHTML = '<p class="text-slate-500">查無此電話的預約紀錄</p>';
    return;
  }
  if (!r.ok) { toast('查詢失敗', 'error'); return; }
  const data = await r.json();
  renderResults(data, phone);
}

function renderResults(data, phone) {
  const blocks = [];
  if (data.bookings.length) {
    blocks.push('<h2 class="font-bold mt-4 mb-2">一對一預約</h2>');
    for (const b of data.bookings) {
      blocks.push(`
        <div class="card p-3 mb-2 flex justify-between items-center">
          <div>
            <div class="font-medium">${escapeHtml(b.coach_display_name)}</div>
            <div class="text-sm text-slate-500">${escapeHtml(b.start_at)}</div>
          </div>
          <button data-cancel-booking="${b.id}" class="btn btn-secondary text-sm">取消</button>
        </div>`);
    }
  }
  if (data.registrations.length) {
    blocks.push('<h2 class="font-bold mt-6 mb-2">團體課報名</h2>');
    for (const r of data.registrations) {
      blocks.push(`
        <div class="card p-3 mb-2 flex justify-between items-center">
          <div>
            <div class="font-medium">${escapeHtml(r.course_name)}</div>
            <div class="text-sm text-slate-500">${escapeHtml(r.start_at)} · ${r.status === 'waitlisted' ? `候補#${r.position}` : '正取'}</div>
          </div>
          <button data-cancel-reg="${r.id}" class="btn btn-secondary text-sm">取消</button>
        </div>`);
    }
  }
  if (!blocks.length) blocks.push('<p class="text-slate-500">目前沒有預約</p>');
  document.getElementById('results').innerHTML = blocks.join('');

  document.querySelectorAll('[data-cancel-booking]').forEach((btn) => {
    btn.addEventListener('click', () => cancelBooking(Number(btn.dataset.cancelBooking), phone));
  });
  document.querySelectorAll('[data-cancel-reg]').forEach((btn) => {
    btn.addEventListener('click', () => cancelReg(Number(btn.dataset.cancelReg), phone));
  });
}

async function cancelBooking(id, phone) {
  if (!confirm('確定取消這個預約？')) return;
  const r = await fetch(`/api/public/bookings/${id}?phone=${encodeURIComponent(phone)}`, { method:'DELETE' });
  const d = await r.json();
  if (r.ok) { toast('已取消', 'success'); loadByPhone(phone); }
  else toast(d.error || '取消失敗', 'error');
}

async function cancelReg(id, phone) {
  if (!confirm('確定取消這個報名？')) return;
  const r = await fetch(`/api/public/registrations/${id}?phone=${encodeURIComponent(phone)}`, { method:'DELETE' });
  const d = await r.json();
  if (r.ok) { toast('已取消', 'success'); loadByPhone(phone); }
  else toast(d.error || '取消失敗', 'error');
}

document.body.style.visibility = 'visible';
```

- [ ] **Step 3: Manual smoke**

Open `/my-schedule.html`:
- ✓ no redirect
- ✓ enter the phone used in B3/B4 smoke → see bookings + registrations
- ✓ click 取消 → confirm dialog → success → list refreshes

- [ ] **Step 4: Commit**

```bash
git add public/my-schedule.html public/my-schedule.js
git commit -m "feat(my-schedule): phone-lookup mode for anonymous customers"
```

---

### Task B6: Update other pages' navbar (login, admin, coach)

**Files:**
- Modify: `public/login.html`、`public/admin.html`、`public/coach.html`

- [ ] **Step 1: login.html copy + remove register link**

In `public/login.html`:
- Change `<h1>` to `<h1>管理員 / 教練登入</h1>`
- Remove any `<a href="/register.html">註冊</a>` link
- Add a small note: `<p class="text-sm text-slate-500 mt-4">一般客人不需登入，直接到 <a href="/" class="text-amber-600">首頁</a>預約即可</p>`

- [ ] **Step 2: admin.html and coach.html — change bootAuth call**

In `admin.html` (whichever script invokes bootAuth, likely inline at bottom):

Replace `bootAuth({ requireAdmin: true })` with `bootAuth({ requireRole: ['admin','owner'] })`.

In `coach.html`:

Replace existing bootAuth call with `bootAuth({ requireRole: ['coach'] })`. (admin/owner can't access coach.html under new model — they have admin.html.)

- [ ] **Step 3: Manual smoke**

- Open `/login.html` → see updated copy, no register link
- Login as admin → redirected to `/admin.html` works
- Open `/coach.html` as admin → should redirect to `/` (per new bootAuth)
- Login as a seeded coach (need to promote a user in admin to coach first if not seeded) → `/coach.html` works

- [ ] **Step 4: Commit**

```bash
git add public/login.html public/admin.html public/coach.html
git commit -m "feat(auth-pages): scope login to admin/coach, tighten coach.html"
```

---

### Task B7: Delete register.html and line.html (with redirect)

**Files:**
- Delete: `public/register.html`、`public/line.html`
- Modify: `src/server.js` (add redirect)

- [ ] **Step 1: Delete files**

```bash
git rm public/register.html public/line.html
```

- [ ] **Step 2: Add redirect from /line.html → /my-schedule.html**

In `src/server.js`, before `app.use(express.static(...))`:

```js
app.get('/line.html', (req, res) => res.redirect(301, '/my-schedule.html'));
app.get('/register.html', (req, res) => res.redirect(301, '/'));
```

- [ ] **Step 3: Search for stragglers — any remaining links to register.html or line.html**

```bash
grep -rn "register.html\|line.html" public/ src/ | grep -v node_modules
```

Remove or replace any remaining references (most should be in navbar — those are already removed in earlier tasks).

- [ ] **Step 4: Restart server, manual smoke**

```bash
# kill any running server, then:
npm start &
sleep 2
curl -sI http://localhost:3000/line.html | head -2
# expected: HTTP/1.1 301 Moved Permanently / Location: /my-schedule.html
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove register.html and line.html (with 301 redirects)"
```

---

### Task B8: Full Phase B smoke checklist

- [ ] **Step 1: Reseed and run all tests**

```bash
npm run seed
npm start &
sleep 2
npm run test:api && npm run test:flow
kill %1
```

Expected: all green.

- [ ] **Step 2: Walk through spec §6 PR #2 smoke checklist**

Manually verify each item in `docs/superpowers/specs/2026-05-23-anon-booking-redesign-design.md` section 6 ("PR #2 smoke"). Document any issues — fix in a new commit on this branch.

---

### Task B9: Open PR for Phase B, smoke in production

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/anon-booking-frontend
```

- [ ] **Step 2: Open draft PR**

Same gh API pattern as Task A14. Title: `Phase 4B: anon-booking frontend cutover`. Body links to design spec.

- [ ] **Step 3: Manual production smoke after merge**

Run §6 PR #2 checklist against production URL.

---

## Done Criteria

- All Phase A tasks merged to main, production confirmed working for admin/coach
- All Phase B tasks merged to main, manual smoke per spec §6 passes in production
- A real test booking by an anonymous customer with name+phone goes through end-to-end, including LINE binding code flow
