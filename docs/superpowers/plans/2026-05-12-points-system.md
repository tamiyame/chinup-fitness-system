# Points System · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a wallet-style points system that gates both 1-on-1 booking and group class registration in chinup-fitness-system (Phase 2; builds on Phase 1's `feature/one-on-one-booking`).

**Architecture:** Single `point_transactions` table is the source of truth — every grant, deduct, refund is one signed row. Balance is computed as `SUM(amount)` per `(member_id, pool)`. Two pools (`one_on_one`, `group`) are independent. All mutations run inside `tx() BEGIN IMMEDIATE` with a post-insert balance check that rolls back if `< 0`. UI changes are minimal: a navbar pill on every page (via shared `app.js`) plus admin grant/history modals.

**Tech Stack:** Same as chinup — Node 24 (ESM), Express, `node:sqlite` (WAL), Vanilla JS + Tailwind CDN. Zero new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-12-points-system-design.md`

**Branch:** `feature/points-system` (already created from `feature/one-on-one-booking`).

**Deviations from spec:** None at plan-writing time. If any arise during implementation, note them inline in the task.

---

## File Structure

### Files to create

| Path | Responsibility |
|---|---|
| `src/services/pointService.js` | `recordTransaction`, `getBalance`, `getBalances`, `adminGrant`, `listTransactionsForAdmin` |

### Files to modify

| Path | Changes |
|---|---|
| `src/db/schema.js` | Append `point_transactions` table + indexes + `member_point_balance` view |
| `src/services/bookingService.js` | `createBooking` deducts; `cancelBooking` refunds |
| `src/services/registration.js` | `register` deducts (confirmed AND waitlisted); `cancelRegistration` refunds |
| `src/services/courseService.js` | `processDeadlines` refunds all participants when a session is cancelled |
| `src/server.js` | 3 new endpoints (`/api/my/points/balance`, `/api/admin/users/:id/points/grant`, `/api/admin/users/:id/points/transactions`); augment `/api/admin/users` response |
| `src/db/seed-demo.js` | Seed initial points for demo members |
| `tests/booking-flow.test.js` | Cases 6, 7, 8 + seed adjustments for existing cases |
| `tests/booking-api.test.js` | New HTTP integration cases |
| `tests/flow.test.js` | Pre-seed points so existing group tests still pass |
| `tests/api.test.js` | Pre-seed points so existing API tests still pass |
| `public/app.js` | Navbar balance pill rendering + refresh helper |
| `public/coaches.js` | 0-balance hard-block on confirm step |
| `public/courses.js` | Same 0-balance hard-block on group register confirm |
| `public/admin.html` | Add `[加點][歷史]` buttons to user-management section + two `<dialog>` elements |
| `public/admin.js` | Grant modal + history modal logic; augment user table with balance columns |
| `README.md` | "點數系統" section |

---

## Task 1 — Schema additions

**Files:**
- Modify: `src/db/schema.js`
- Test: server boot must apply new table + view without error

- [ ] **Step 1: Append the new table, indexes, and view to `SCHEMA`**

In `src/db/schema.js`, AFTER the existing `bookings` table block (added in Phase 1), append:

```sql
CREATE TABLE IF NOT EXISTS point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pool TEXT NOT NULL CHECK (pool IN ('one_on_one', 'group')),
  amount INTEGER NOT NULL,
  note TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN (
    'admin_grant',
    'booking_deduct',
    'booking_refund',
    'registration_deduct',
    'registration_refund',
    'session_refund'
  )),
  related_booking_id INTEGER REFERENCES bookings(id),
  related_session_id INTEGER REFERENCES course_sessions(id),
  related_registration_id INTEGER REFERENCES registrations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount != 0)
);

CREATE INDEX IF NOT EXISTS idx_point_tx_member_pool ON point_transactions(member_id, pool);
CREATE INDEX IF NOT EXISTS idx_point_tx_created ON point_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_point_tx_booking ON point_transactions(related_booking_id);
CREATE INDEX IF NOT EXISTS idx_point_tx_registration ON point_transactions(related_registration_id);

CREATE VIEW IF NOT EXISTS member_point_balance AS
SELECT
  u.id AS member_id,
  u.name,
  u.email,
  COALESCE(SUM(CASE WHEN pt.pool = 'one_on_one' THEN pt.amount ELSE 0 END), 0) AS one_on_one_balance,
  COALESCE(SUM(CASE WHEN pt.pool = 'group' THEN pt.amount ELSE 0 END), 0) AS group_balance
FROM users u
LEFT JOIN point_transactions pt ON pt.member_id = u.id
WHERE u.role = 'user'
GROUP BY u.id;
```

- [ ] **Step 2: Verify on a fresh DB**

```bash
rm -f data/test.db && DB_PATH=data/test.db node -e "import('./src/db/connection.js').then(({db}) => { const tables=db.prepare(\"SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name\").all(); console.log(tables); })"
```

Expected output includes `point_transactions` (table) and `member_point_balance` (view).

Clean up: `rm -f data/test.db`

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.js
git commit -m "feat(schema): add point_transactions table + member_point_balance view"
```

---

## Task 2 — `pointService.js` (core + adminGrant + admin queries)

**Files:**
- Create: `src/services/pointService.js`
- Modify: `tests/booking-flow.test.js`

- [ ] **Step 1: Add Case 6 tests to `tests/booking-flow.test.js`**

Add this import to the TOP of the file (alongside existing imports):

```javascript
import {
  recordTransaction, getBalance, getBalances,
  adminGrant, listTransactionsForAdmin,
} from '../src/services/pointService.js';
```

Append the test cases at the bottom of the file:

```javascript
// --- Case 6: pointService ---

console.log('[case 6] pointService');

reset();
const uPt1 = makeUser('coach-test-pt1@chinup.local', 'PT 測試員');
// makeUser sets role='coach'; for points testing we need a 'user' role member.
db.prepare("UPDATE users SET role='user' WHERE id = ?").run(uPt1);

const adminId = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;

const g1 = adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 10, note: 'PT 10 堂裝', adminId });
expect('adminGrant returns balance=10', () => assert.equal(g1.balance, 10));
expect('getBalance reflects insert', () => assert.equal(getBalance(uPt1, 'one_on_one'), 10));

adminGrant({ memberId: uPt1, pool: 'group', amount: 5, note: 'group 5 堂', adminId });
expect('getBalances returns both pools', () => {
  const b = getBalances(uPt1);
  assert.equal(b.one_on_one, 10);
  assert.equal(b.group, 5);
});

// Negative grant down to 0 — ok
const g2 = adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: -10, note: 'reverse', adminId });
expect('balance can hit exactly 0', () => assert.equal(g2.balance, 0));

// Negative grant pulling below 0 — throws, rolled back
expect('overdraft throws insufficient_points', () => {
  assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: -1, note: 'overdraft', adminId }),
    /insufficient_points/);
});
expect('overdraft row not persisted', () => {
  const rows = db.prepare("SELECT COUNT(*) AS c FROM point_transactions WHERE member_id = ? AND note = 'overdraft'").get(uPt1);
  assert.equal(rows.c, 0);
});
expect('balance still 0 after rollback', () => assert.equal(getBalance(uPt1, 'one_on_one'), 0));

// amount=0 rejected
expect('amount=0 rejected', () => assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 0, note: 'zero', adminId }), /invalid_amount/));

// empty note rejected
expect('empty note rejected', () => assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 1, note: '', adminId }), /missing_note/));
expect('whitespace note rejected', () => assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 1, note: '   ', adminId }), /missing_note/));

// invalid pool rejected
expect('invalid pool rejected', () => assert.throws(() => recordTransaction({ memberId: uPt1, pool: 'bad', amount: 1, note: 'x', actorId: adminId, source: 'admin_grant' }), /invalid_pool/));

// listTransactionsForAdmin
adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 3, note: 'top up', adminId });
adminGrant({ memberId: uPt1, pool: 'group', amount: 2, note: 'group top', adminId });
const allTx = listTransactionsForAdmin(uPt1);
expect('listTransactionsForAdmin returns all rows DESC', () => {
  assert(allTx.length >= 5);
  // Most recent first
  assert(allTx[0].created_at >= allTx[allTx.length - 1].created_at);
});
expect('listTransactionsForAdmin joins actor_name', () => assert(allTx[0].actor_name));
const onePool = listTransactionsForAdmin(uPt1, { pool: 'group' });
expect('pool filter applied', () => assert(onePool.every(r => r.pool === 'group')));
const limited = listTransactionsForAdmin(uPt1, { limit: 2 });
expect('limit applied', () => assert.equal(limited.length, 2));
```

- [ ] **Step 2: Run test, expect failure**

```bash
node tests/booking-flow.test.js
```

Expected: `Cannot find module '../src/services/pointService.js'`.

- [ ] **Step 3: Create `src/services/pointService.js`**

```javascript
import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertTxStmt = db.prepare(`
  INSERT INTO point_transactions
    (member_id, pool, amount, note, actor_id, source,
     related_booking_id, related_session_id, related_registration_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getBalanceStmt = db.prepare(
  'SELECT COALESCE(SUM(amount), 0) AS balance FROM point_transactions WHERE member_id = ? AND pool = ?'
);

const POOLS = ['one_on_one', 'group'];
const SOURCES = ['admin_grant', 'booking_deduct', 'booking_refund',
                 'registration_deduct', 'registration_refund', 'session_refund'];

export function recordTransaction({
  memberId, pool, amount, note, actorId, source,
  relatedBookingId = null, relatedSessionId = null, relatedRegistrationId = null,
}) {
  if (!memberId) throw new ApiError(400, 'missing_member_id');
  if (!POOLS.includes(pool)) throw new ApiError(400, 'invalid_pool');
  if (!Number.isInteger(amount) || amount === 0) throw new ApiError(400, 'invalid_amount');
  if (!note || !note.trim()) throw new ApiError(400, 'missing_note');
  if (!actorId) throw new ApiError(400, 'missing_actor_id');
  if (!SOURCES.includes(source)) throw new ApiError(400, 'invalid_source');

  return tx(() => {
    insertTxStmt.run(memberId, pool, amount, note.trim(), actorId, source,
                     relatedBookingId, relatedSessionId, relatedRegistrationId);
    const balance = getBalanceStmt.get(memberId, pool).balance;
    if (balance < 0) throw new ApiError(409, 'insufficient_points', { balance });
    return { balance };
  });
}

export function getBalance(memberId, pool) {
  return getBalanceStmt.get(memberId, pool).balance;
}

export function getBalances(memberId) {
  return {
    one_on_one: getBalance(memberId, 'one_on_one'),
    group: getBalance(memberId, 'group'),
  };
}

export function adminGrant({ memberId, pool, amount, note, adminId }) {
  return recordTransaction({
    memberId, pool, amount, note, actorId: adminId, source: 'admin_grant',
  });
}

const listTxStmt = db.prepare(`
  SELECT pt.*, actor.name AS actor_name
  FROM point_transactions pt
  JOIN users actor ON actor.id = pt.actor_id
  WHERE pt.member_id = ?
  ORDER BY pt.created_at DESC, pt.id DESC
  LIMIT ?
`);

const listTxByPoolStmt = db.prepare(`
  SELECT pt.*, actor.name AS actor_name
  FROM point_transactions pt
  JOIN users actor ON actor.id = pt.actor_id
  WHERE pt.member_id = ? AND pt.pool = ?
  ORDER BY pt.created_at DESC, pt.id DESC
  LIMIT ?
`);

export function listTransactionsForAdmin(memberId, { pool = null, limit = 100 } = {}) {
  if (pool) {
    if (!POOLS.includes(pool)) throw new ApiError(400, 'invalid_pool');
    return listTxByPoolStmt.all(memberId, pool, limit);
  }
  return listTxStmt.all(memberId, limit);
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ for Case 1, 2, 3, 4, 5 (existing) + Case 6 (new). Note: Cases 3 and 4 will FAIL because they call `createBooking` which doesn't yet require points — but `createBooking` hasn't been modified to require points yet, so they still pass. Good.

- [ ] **Step 5: Commit**

```bash
git add src/services/pointService.js tests/booking-flow.test.js
git commit -m "feat(service): add pointService (recordTransaction + balance + admin queries)"
```

---

## Task 3 — Integrate points into `bookingService.js`

**Files:**
- Modify: `src/services/bookingService.js`
- Modify: `tests/booking-flow.test.js` (Case 7 + adjust existing Cases 3/4)

- [ ] **Step 1: Add Case 7 test cases**

Append to `tests/booking-flow.test.js`:

```javascript
// --- Case 7: booking + points integration ---

console.log('[case 7] booking + points');

reset();
const uPt2 = makeUser('coach-test-pt2@chinup.local', 'PT2');
const cPt2 = createCoach({ userId: uPt2, displayName: 'PT2 Coach' });
setCoachActive(cPt2.id, true);
const member = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('point-mem', 'pm@chinup.local', 'user', 'email')").run().lastInsertRowid;
const ownerForTx = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
addRule({ coachId: cPt2.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2099-01-01' });

// 0 balance → createBooking throws
expect('createBooking with 0 balance throws insufficient_points', () =>
  assert.throws(() => createBooking({ coachId: cPt2.id, memberId: member, startAt: '2099-06-01T10:00:00' }), /insufficient_points/));

// Booking row NOT persisted
expect('no booking row left over from failed createBooking', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE coach_id = ?").get(cPt2.id).c;
  assert.equal(c, 0);
});

adminGrant({ memberId: member, pool: 'one_on_one', amount: 2, note: 'test seed', adminId: ownerForTx });

const bk1 = createBooking({ coachId: cPt2.id, memberId: member, startAt: '2099-06-01T10:00:00' });
expect('successful createBooking debits 1 point', () => assert.equal(getBalance(member, 'one_on_one'), 1));
expect('booking deduct row has source booking_deduct', () => {
  const row = db.prepare("SELECT * FROM point_transactions WHERE related_booking_id = ?").get(bk1.id);
  assert.equal(row.source, 'booking_deduct');
  assert.equal(row.amount, -1);
});

cancelBooking({ bookingId: bk1.id, actorUserId: member, isCoach: false });
expect('cancelBooking refunds 1 point', () => assert.equal(getBalance(member, 'one_on_one'), 2));
expect('refund row has source booking_refund', () => {
  const row = db.prepare("SELECT * FROM point_transactions WHERE related_booking_id = ? AND source = 'booking_refund'").get(bk1.id);
  assert.equal(row.amount, 1);
  assert.equal(row.actor_id, member);
});

// Coach emergency cancel: actor_id = coach.user_id, refund still goes to the member
const bk2 = createBooking({ coachId: cPt2.id, memberId: member, startAt: '2099-06-08T10:00:00' });
cancelBooking({ bookingId: bk2.id, actorUserId: uPt2, isCoach: true, reason: '臨時生病' });
const refund2 = db.prepare("SELECT * FROM point_transactions WHERE related_booking_id = ? AND source = 'booking_refund'").get(bk2.id);
expect('coach-cancel refund actor_id = coach.user_id', () => assert.equal(refund2.actor_id, uPt2));
expect('coach-cancel refund note contains reason', () => assert(refund2.note.includes('臨時生病')));
expect('coach-cancel refund still goes to member', () => assert.equal(refund2.member_id, member));
```

- [ ] **Step 2: Run, expect failures**

```bash
node tests/booking-flow.test.js
```

Expected: Case 7's "0 balance → throws" fails (createBooking doesn't check yet). Also, the previously-passing Cases 3, 4 will START FAILING in their booking-creation steps because we're about to make `createBooking` require points. **Don't fix them yet** — Task 4 handles that explicitly.

- [ ] **Step 3: Modify `src/services/bookingService.js`**

Add the import at the top:

```javascript
import { recordTransaction } from './pointService.js';
```

Replace the `createBooking` function with:

```javascript
export function createBooking({ coachId, memberId, startAt, note = null }) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  const endAt = addMinutes(startAt, 60);
  return tx(() => {
    let bookingId;
    try {
      const info = insertBookingStmt.run(coachId, memberId, startAt, endAt, note);
      bookingId = info.lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
      throw e;
    }
    recordTransaction({
      memberId, pool: 'one_on_one', amount: -1,
      note: `預約 #${bookingId}`,
      actorId: memberId,
      source: 'booking_deduct',
      relatedBookingId: bookingId,
    });
    return { id: bookingId, startAt, endAt };
  });
}
```

Replace the `cancelBooking` function with:

```javascript
export function cancelBooking({ bookingId, actorUserId, isCoach = false, reason = null }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');

    if (isCoach) {
      const coach = getCoachStmt.get(b.coach_id);
      if (!coach || coach.user_id !== actorUserId) throw new ApiError(403, 'forbidden');
      if (!reason || !reason.trim()) throw new ApiError(400, 'missing_reason');
    } else {
      if (b.member_id !== actorUserId) throw new ApiError(403, 'forbidden');
    }

    cancelBookingStmt.run(nowLocal(), actorUserId, reason, bookingId);

    const refundNote = isCoach
      ? `取消 #${bookingId}（教練：${reason}）`
      : `取消 #${bookingId}`;
    recordTransaction({
      memberId: b.member_id, pool: 'one_on_one', amount: 1,
      note: refundNote,
      actorId: actorUserId,
      source: 'booking_refund',
      relatedBookingId: bookingId,
    });

    return { ok: true };
  });
}
```

- [ ] **Step 4: Patch existing Cases 3 and 4 to seed points before `createBooking`**

In `tests/booking-flow.test.js`, find Case 3 and Case 4 (they were added in Phase 1). Inside each Case, after the `createCoach` + `setCoachActive` calls but BEFORE the first `createBooking` call, add a `adminGrant` to give the test member enough points. Specifically:

In Case 3's "confirmed booking excludes the slot" sub-section:

```javascript
// Phase 2 addition: seed points so createBooking doesn't fail
adminGrant({ memberId, pool: 'one_on_one', amount: 5, note: 'test seed', adminId: db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id });
```

(Insert just before the `createBooking({ coachId: cC.id, memberId, ... })` line.)

In Case 4: similarly seed `m1` and `m2` with points before the first `createBooking`:

```javascript
const adminIdC4 = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
adminGrant({ memberId: m1, pool: 'one_on_one', amount: 10, note: 'test seed', adminId: adminIdC4 });
adminGrant({ memberId: m2, pool: 'one_on_one', amount: 10, note: 'test seed', adminId: adminIdC4 });
```

- [ ] **Step 5: Run all tests, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ for Cases 1–7.

- [ ] **Step 6: Commit**

```bash
git add src/services/bookingService.js tests/booking-flow.test.js
git commit -m "feat(booking): deduct point on createBooking; refund on cancelBooking"
```

---

## Task 4 — Integrate points into `registration.js` (group class)

**Files:**
- Modify: `src/services/registration.js`
- Modify: `tests/booking-flow.test.js` (Case 8 part 1)

- [ ] **Step 1: Add Case 8a tests** — first, add the new imports to the **top of `tests/booking-flow.test.js`** alongside the existing imports (ES modules require imports at top):

```javascript
import { createTemplate } from '../src/services/courseService.js';
import { register, cancelRegistration } from '../src/services/registration.js';
import { offsetLocal } from '../src/db/connection.js';
```

Then append the test body at the bottom:

```javascript
// --- Case 8a: group registration + points ---

console.log('[case 8a] group register/cancel + points');

reset();

const adminIdC8 = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
const memG1 = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('grp-mem-1', 'gm1@chinup.local', 'user', 'email')").run().lastInsertRowid;
const memG2 = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('grp-mem-2', 'gm2@chinup.local', 'user', 'email')").run().lastInsertRowid;

const tpl = createTemplate({
  name: 'C8 測試課',
  min_capacity: 2,
  max_capacity: 2,
  day_of_week: new Date().getDay(),
  start_time: '14:00',
  duration_minutes: 60,
  recurrence: 'monthly',
  cycle_start_date: '2099-01-01',
  cycle_end_date: '2099-12-31',
  registration_deadline_hours: 24,
});
const sessions = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at LIMIT 1').all(tpl.templateId);
const sessionId = sessions[0].id;
const futureStart = offsetLocal(72 * 60 * 60 * 1000);
const futureEnd = offsetLocal(73 * 60 * 60 * 1000);
const futureDl = offsetLocal(48 * 60 * 60 * 1000);
db.prepare("UPDATE course_sessions SET start_at = ?, end_at = ?, registration_deadline = ? WHERE id = ?")
  .run(futureStart, futureEnd, futureDl, sessionId);

// 0 balance → register throws insufficient_points
expect('register with 0 balance throws', () =>
  assert.throws(() => register({ sessionId, userId: memG1 }), /insufficient_points/));

adminGrant({ memberId: memG1, pool: 'group', amount: 3, note: 'seed', adminId: adminIdC8 });
adminGrant({ memberId: memG2, pool: 'group', amount: 3, note: 'seed', adminId: adminIdC8 });

const reg1 = register({ sessionId, userId: memG1 });
expect('register deducts 1 group point', () => assert.equal(getBalance(memG1, 'group'), 2));
expect('deduct row source=registration_deduct', () => {
  const row = db.prepare("SELECT * FROM point_transactions WHERE related_registration_id = ?").get(reg1.registrationId);
  assert.equal(row.source, 'registration_deduct');
  assert.equal(row.amount, -1);
});

// Fill the session, second register goes to waitlist; still deducts
const reg2 = register({ sessionId, userId: memG2 });
expect('second register fills the session (confirmed=2/2)', () => assert.equal(reg2.status, 'confirmed'));

const memG3 = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('grp-mem-3', 'gm3@chinup.local', 'user', 'email')").run().lastInsertRowid;
adminGrant({ memberId: memG3, pool: 'group', amount: 3, note: 'seed', adminId: adminIdC8 });

const reg3 = register({ sessionId, userId: memG3 });
expect('third register goes to waitlist', () => assert.equal(reg3.status, 'waitlisted'));
expect('waitlisted also deducts 1 point', () => assert.equal(getBalance(memG3, 'group'), 2));

// Cancel by waitlist member → refund
cancelRegistration({ registrationId: reg3.registrationId, userId: memG3 });
expect('cancel refunds the waitlist deduction', () => assert.equal(getBalance(memG3, 'group'), 3));
expect('refund row source=registration_refund', () => {
  const row = db.prepare("SELECT * FROM point_transactions WHERE related_registration_id = ? AND source = 'registration_refund'").get(reg3.registrationId);
  assert.equal(row.amount, 1);
});

// Cancel a confirmed registration; waitlist (now empty since we cancelled reg3) — no auto-refund of others
// Add reg4 to waitlist, then cancel reg1 — reg4 should be promoted, no point movement on promotion
const memG4 = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('grp-mem-4', 'gm4@chinup.local', 'user', 'email')").run().lastInsertRowid;
adminGrant({ memberId: memG4, pool: 'group', amount: 3, note: 'seed', adminId: adminIdC8 });
const reg4 = register({ sessionId, userId: memG4 });
expect('reg4 waitlisted (after reg1+reg2 confirmed and reg3 cancelled)', () => assert.equal(reg4.status, 'waitlisted'));
const beforeBalanceG4 = getBalance(memG4, 'group');

cancelRegistration({ registrationId: reg1.registrationId, userId: memG1 });
expect('reg1 cancel refunds memG1', () => assert.equal(getBalance(memG1, 'group'), 3));
expect('reg4 promotion does NOT touch points', () => assert.equal(getBalance(memG4, 'group'), beforeBalanceG4));
const reg4After = db.prepare('SELECT status FROM registrations WHERE id = ?').get(reg4.registrationId);
expect('reg4 promoted to confirmed', () => assert.equal(reg4After.status, 'confirmed'));
```

- [ ] **Step 2: Run, expect failures**

```bash
node tests/booking-flow.test.js
```

Expected: Case 8a "register with 0 balance throws" fails (no deduction yet). Other Case 8a points-related asserts also fail.

- [ ] **Step 3: Modify `src/services/registration.js`**

Add import at top alongside existing imports:

```javascript
import { recordTransaction } from './pointService.js';
```

In the `register` function, AFTER the existing `recalcAndSave(sessionId)` line and BEFORE the existing `notify({ ... })` call, add:

```javascript
    recordTransaction({
      memberId: userId,
      pool: 'group',
      amount: -1,
      note: `報名 #${registrationId}`,
      actorId: userId,
      source: 'registration_deduct',
      relatedRegistrationId: registrationId,
      relatedSessionId: sessionId,
    });
```

In the `cancelRegistration` function, AFTER `updateRegStatus.run('cancelled', null, reg.id)` and BEFORE the existing `notify({ ... })` call, add:

```javascript
    recordTransaction({
      memberId: userId,
      pool: 'group',
      amount: 1,
      note: `取消 #${reg.id}`,
      actorId: userId,
      source: 'registration_refund',
      relatedRegistrationId: reg.id,
      relatedSessionId: session.id,
    });
```

**Critical**: do NOT add a point transaction in the waitlist-promotion code path (the block that runs `updateRegStatus.run('confirmed', null, next.id)` and `notify({ ..., type: 'promoted' })`). The promoted member was already deducted at original registration time.

- [ ] **Step 4: Run, expect pass through Case 8a**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ for Cases 1–8a.

- [ ] **Step 5: Commit**

```bash
git add src/services/registration.js tests/booking-flow.test.js
git commit -m "feat(registration): deduct point on register; refund on cancel"
```

---

## Task 5 — `processDeadlines` refunds when session is cancelled

**Files:**
- Modify: `src/services/courseService.js`
- Modify: `tests/booking-flow.test.js` (Case 8b)

- [ ] **Step 1: Add Case 8b test** — add the import to the **top of the file**:

```javascript
import { processDeadlines } from '../src/services/courseService.js';
```

Append the test body at the bottom:

```javascript
// --- Case 8b: session auto-cancel refunds all participants ---

console.log('[case 8b] session auto-cancel + refunds');

reset();
const memS1 = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('sess-mem-1', 'sm1@chinup.local', 'user', 'email')").run().lastInsertRowid;
const memS2 = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('sess-mem-2', 'sm2@chinup.local', 'user', 'email')").run().lastInsertRowid;
const adminIdS = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
adminGrant({ memberId: memS1, pool: 'group', amount: 5, note: 'seed', adminId: adminIdS });
adminGrant({ memberId: memS2, pool: 'group', amount: 5, note: 'seed', adminId: adminIdS });

// Template needs min_capacity 3 to force "not reached" cancellation
const tplB = createTemplate({
  name: 'C8b 測試課（低參與）',
  min_capacity: 3,
  max_capacity: 10,
  day_of_week: new Date().getDay(),
  start_time: '15:00',
  duration_minutes: 60,
  recurrence: 'monthly',
  cycle_start_date: '2099-01-01',
  cycle_end_date: '2099-12-31',
  registration_deadline_hours: 24,
});
const sessB = db.prepare('SELECT id FROM course_sessions WHERE template_id = ? ORDER BY start_at LIMIT 1').get(tplB.templateId).id;

// Set deadline already passed (so processDeadlines acts on it immediately)
const pastDl = offsetLocal(-60 * 60 * 1000);  // 1h ago
const stillFutureStart = offsetLocal(20 * 60 * 60 * 1000);  // still in future, but past deadline
db.prepare("UPDATE course_sessions SET start_at = ?, registration_deadline = ? WHERE id = ?")
  .run(stillFutureStart, pastDl, sessB);

// Register two members (below min_capacity=3)
const r1 = register({ sessionId: sessB, userId: memS1 });
const r2 = register({ sessionId: sessB, userId: memS2 });
expect('memS1 balance after register = 4', () => assert.equal(getBalance(memS1, 'group'), 4));
expect('memS2 balance after register = 4', () => assert.equal(getBalance(memS2, 'group'), 4));

processDeadlines();

const sessAfter = db.prepare('SELECT status FROM course_sessions WHERE id = ?').get(sessB);
expect('session cancelled by processDeadlines', () => assert.equal(sessAfter.status, 'cancelled'));

expect('memS1 refunded (balance back to 5)', () => assert.equal(getBalance(memS1, 'group'), 5));
expect('memS2 refunded (balance back to 5)', () => assert.equal(getBalance(memS2, 'group'), 5));

expect('refund rows source=session_refund', () => {
  const rows = db.prepare("SELECT * FROM point_transactions WHERE related_session_id = ? AND source = 'session_refund'").all(sessB);
  assert.equal(rows.length, 2);
});

// processDeadlines is idempotent — running twice doesn't double-refund
processDeadlines();
expect('memS1 balance not double-refunded', () => assert.equal(getBalance(memS1, 'group'), 5));
```

- [ ] **Step 2: Run, expect failure**

```bash
node tests/booking-flow.test.js
```

Expected: Case 8b refund asserts fail (no refund logic yet in `processDeadlines`).

- [ ] **Step 3: Read `src/services/courseService.js` to find the cancellation branch**

```bash
grep -n "status.*cancelled\|processDeadlines" /Users/ryansheu/projects/chinup-fitness-system/src/services/courseService.js
```

Look for the function `processDeadlines` and within it the path that marks a session `status = 'cancelled'` because confirmed count is below `min_capacity`.

- [ ] **Step 4: Inside that cancellation branch, BEFORE flipping registration statuses to cancelled, refund each participant**

Add the import at the top of `src/services/courseService.js` alongside other service imports:

```javascript
import { recordTransaction } from './pointService.js';
```

Inside `processDeadlines`, in the branch that cancels a session (typically detected by `confirmed_count < min_capacity` after deadline passed), iterate participants and refund them. The exact insertion point depends on existing structure; here is the canonical pattern:

```javascript
// Before flipping statuses, refund each active participant
const activeRegs = db.prepare(`
  SELECT id, user_id FROM registrations
  WHERE session_id = ? AND status IN ('confirmed', 'waitlisted')
`).all(sessionRow.id);

for (const reg of activeRegs) {
  recordTransaction({
    memberId: reg.user_id,
    pool: 'group',
    amount: 1,
    note: `場次未成班 #${sessionRow.id}`,
    actorId: reg.user_id,
    source: 'session_refund',
    relatedRegistrationId: reg.id,
    relatedSessionId: sessionRow.id,
  });
}
// Existing code: flip status to 'cancelled', send notifications, etc.
```

**Idempotency**: `processDeadlines` is meant to be safe to run multiple times. The above code reads `status IN ('confirmed', 'waitlisted')`. After the first run flips those to `cancelled`, a second run finds zero active regs → no double refund. Good.

- [ ] **Step 5: Run tests, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ through Case 8b.

- [ ] **Step 6: Commit**

```bash
git add src/services/courseService.js tests/booking-flow.test.js
git commit -m "feat(course): refund all participants when session auto-cancels"
```

---

## Task 6 — Patch existing `flow.test.js` and `api.test.js` (group class regression)

**Files:**
- Modify: `tests/flow.test.js`
- Modify: `tests/api.test.js`

This task is purely test maintenance. The existing tests register members for group sessions; those calls now require points. Add a seed step.

- [ ] **Step 1: Patch `tests/flow.test.js`**

Read the file, find the section near the top where it does `const [u1, u2, u3, u4, u5, u6, u7] = userIds(7);`. AFTER that line, add:

```javascript
import { adminGrant } from '../src/services/pointService.js';
const adminIdFlow = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
for (const uid of [u1, u2, u3, u4, u5, u6, u7]) {
  adminGrant({ memberId: uid, pool: 'group', amount: 20, note: 'flow.test.js seed', adminId: adminIdFlow });
}
```

**Note**: the import must move to the top with other imports — JS hoists imports but readability is better at top. After fixing, the seed loop stays where it is.

- [ ] **Step 2: Run `tests/flow.test.js`, expect pass**

```bash
node tests/flow.test.js
```

Expected: all existing ✓.

- [ ] **Step 3: Patch `tests/api.test.js`**

Read the file, find the section where it logs in 7 members (`memberAuths.push(await loginAs(...))`). After that loop, add an HTTP step to grant points (you'll need the new `POST /api/admin/users/:id/points/grant` endpoint, but it doesn't exist YET — so use direct DB access for this test seed, or wait until Task 7 implements the endpoint and patch then).

For now, use direct DB access at module top level:

```javascript
import { db } from '../src/db/connection.js';
import { adminGrant } from '../src/services/pointService.js';
```

After loading members:

```javascript
const adminIdAPI = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
for (const m of members) {
  adminGrant({ memberId: m.id, pool: 'group', amount: 30, note: 'api.test.js seed', adminId: adminIdAPI });
}
```

- [ ] **Step 4: Run `tests/api.test.js` against a running server**

```bash
PORT=3001 node src/server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 1
BASE=http://localhost:3001 node tests/api.test.js
kill $SERVER_PID 2>/dev/null
```

Expected: all existing ✓ (no regression).

- [ ] **Step 5: Commit**

```bash
git add tests/flow.test.js tests/api.test.js
git commit -m "test: seed points for existing flow/api tests to avoid insufficient_points"
```

---

## Task 7 — HTTP routes (member balance + admin grant + admin transactions + augment users)

**Files:**
- Modify: `src/server.js`
- Modify: `tests/booking-api.test.js` (new HTTP cases)

- [ ] **Step 1: Append HTTP test cases to `tests/booking-api.test.js`**

```javascript
// --- Phase 2: points HTTP ---

console.log('[phase 2 api] points');

// Need a coach + active for the booking-insufficient test. Reuse existing or create fresh.
const ptCoachSignup = await req('POST', '/api/auth/register', {
  body: { email: `pt-coach-${Date.now()}@chinup.local`, password: 'testpass1234', name: 'PT Coach API', as_coach: true },
});
const ptCoachToken = ptCoachSignup.data.token;
const ptCoachId = ptCoachSignup.data.user.id;
// Owner-activate
const ptCoachMe = await req('GET', '/api/coach/me', { token: ptCoachToken });
await req('PATCH', `/api/admin/coaches/${ptCoachMe.data.id}`, {
  token: ownerAuth.token,
  body: { is_active: true },
});

// 1. GET /api/my/points/balance returns both pools (0/0 for fresh user, but our member1 was seeded earlier)
const bal = await req('GET', '/api/my/points/balance', { token: member1.token });
expect('GET /api/my/points/balance 200', () => assert.equal(bal.status, 200));
expect('returns both pools', () => {
  assert(typeof bal.data.one_on_one === 'number');
  assert(typeof bal.data.group === 'number');
});

// 2. POST /api/admin/users/:id/points/grant
const grantRes = await req('POST', `/api/admin/users/${member1.id}/points/grant`, {
  token: ownerAuth.token,
  body: { pool: 'one_on_one', amount: 5, note: 'API test grant' },
});
expect('grant 201', () => assert.equal(grantRes.status, 201));
expect('grant returns new balance', () => assert(typeof grantRes.data.balance === 'number'));

// 3. Member cannot grant
const memberGrant = await req('POST', `/api/admin/users/${member1.id}/points/grant`, {
  token: member1.token,
  body: { pool: 'one_on_one', amount: 1, note: 'no' },
});
expect('member grant 403', () => assert.equal(memberGrant.status, 403));

// 4. amount=0 rejected
const zeroGrant = await req('POST', `/api/admin/users/${member1.id}/points/grant`, {
  token: ownerAuth.token,
  body: { pool: 'one_on_one', amount: 0, note: 'zero' },
});
expect('amount=0 → 400', () => assert.equal(zeroGrant.status, 400));

// 5. Overdraft rejected
const overdraft = await req('POST', `/api/admin/users/${member1.id}/points/grant`, {
  token: ownerAuth.token,
  body: { pool: 'one_on_one', amount: -1000000, note: 'huge negative' },
});
expect('overdraft → 409', () => assert.equal(overdraft.status, 409));

// 6. GET /api/admin/users/:id/points/transactions
const txList = await req('GET', `/api/admin/users/${member1.id}/points/transactions?pool=one_on_one&limit=5`, {
  token: ownerAuth.token,
});
expect('tx list 200', () => assert.equal(txList.status, 200));
expect('tx rows have actor_name', () => txList.data.length > 0 && assert(txList.data[0].actor_name));
expect('pool filter applied', () => txList.data.every(r => r.pool === 'one_on_one'));

// 7. GET /api/admin/users includes balance fields
const usersRes = await req('GET', '/api/admin/users', { token: ownerAuth.token });
expect('users 200', () => assert.equal(usersRes.status, 200));
const me = usersRes.data.find(u => u.id === member1.id);
expect('user row has one_on_one_balance', () => assert(typeof me.one_on_one_balance === 'number'));
expect('user row has group_balance', () => assert(typeof me.group_balance === 'number'));

// 8. POST /api/bookings with 0 balance → 409 insufficient_points
// Create a brand-new member (no points). We can't easily POST /api/auth/register without
// reading their token. Cleanest: drain member2's points to 0 then try.
// Drain via repeated bookings is messy; instead use direct admin grant to deplete.
const currentBal = (await req('GET', '/api/my/points/balance', { token: member2.token })).data;
if (currentBal.one_on_one > 0) {
  await req('POST', `/api/admin/users/${member2.id}/points/grant`, {
    token: ownerAuth.token,
    body: { pool: 'one_on_one', amount: -currentBal.one_on_one, note: 'drain for test' },
  });
}
const slots = await req('GET', `/api/coaches/${ptCoachMe.data.id}/availability?from=2099-01-01&to=2099-01-01`, { token: member2.token });
// availability may be empty if no rules set; create one
await req('POST', '/api/coach/me/rules', {
  token: ptCoachToken,
  body: { day_of_week: 1, start_time: '09:00', end_time: '12:00', effective_from: '2099-01-01' },
});
const slots2 = await req('GET', `/api/coaches/${ptCoachMe.data.id}/availability?from=2099-01-04&to=2099-01-04`, { token: member2.token });
expect('availability has slots', () => slots2.data.length > 0);
const insufficientBook = await req('POST', '/api/bookings', {
  token: member2.token,
  body: { coach_id: ptCoachMe.data.id, start_at: slots2.data[0] },
});
expect('booking with 0 balance → 409', () => assert.equal(insufficientBook.status, 409));
expect('error=insufficient_points', () => assert.equal(insufficientBook.data.error, 'insufficient_points'));
```

- [ ] **Step 2: Run, expect failures**

```bash
PORT=3001 node src/server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 1
BASE=http://localhost:3001 node tests/booking-api.test.js
kill $SERVER_PID 2>/dev/null
```

Expected: all new asserts in the Phase 2 block fail (endpoints don't exist).

- [ ] **Step 3: Modify `src/server.js`**

Add imports at the top alongside other service imports:

```javascript
import {
  getBalances as svcGetBalances,
  adminGrant as svcAdminGrant,
  listTransactionsForAdmin as svcListTx,
} from './services/pointService.js';
```

Locate the existing `app.get('/api/admin/users', ...)` route and REPLACE its handler with:

```javascript
app.get('/api/admin/users', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.notification_preference,
           (u.google_id IS NOT NULL) AS has_google, u.created_at,
           COALESCE(b.one_on_one_balance, 0) AS one_on_one_balance,
           COALESCE(b.group_balance, 0) AS group_balance
    FROM users u
    LEFT JOIN member_point_balance b ON b.member_id = u.id
    ORDER BY u.id ASC
  `).all();
  res.json(rows);
}));
```

Add the new routes near the end of the admin section (after the `/api/admin/users/:id/role` route):

```javascript
app.get('/api/my/points/balance', requireUser, asyncHandler((req, res) => {
  res.json(svcGetBalances(req.user.id));
}));

app.post('/api/admin/users/:id/points/grant', requireAdmin, asyncHandler((req, res) => {
  const memberId = Number(req.params.id);
  const { pool, amount, note } = req.body || {};
  if (typeof amount !== 'number') return res.status(400).json({ error: 'invalid_amount' });
  const result = svcAdminGrant({
    memberId,
    pool,
    amount: Math.trunc(amount),
    note,
    adminId: req.user.id,
  });
  res.status(201).json(result);
}));

app.get('/api/admin/users/:id/points/transactions', requireAdmin, asyncHandler((req, res) => {
  const memberId = Number(req.params.id);
  const { pool, limit } = req.query;
  const rows = svcListTx(memberId, {
    pool: pool || null,
    limit: limit ? Math.min(Number(limit), 500) : 100,
  });
  res.json(rows);
}));
```

- [ ] **Step 4: Run tests against a running server**

```bash
PORT=3001 node src/server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 1
BASE=http://localhost:3001 node tests/booking-api.test.js
kill $SERVER_PID 2>/dev/null
```

Expected: all ✓.

- [ ] **Step 5: Commit**

```bash
git add src/server.js tests/booking-api.test.js
git commit -m "feat(api): points balance, admin grant, transactions list; augment users response"
```

---

## Task 8 — Navbar balance pill (`public/app.js`)

**Files:**
- Modify: `public/app.js`

UI task — no unit tests. Smoke test in browser at the end.

- [ ] **Step 1: Extend `renderAuthBar` in `public/app.js`**

Find the existing `renderAuthBar(user)` function (around line 94). Replace it with:

```javascript
async function renderAuthBar(user) {
  // Hide admin nav link for non-admin users
  document.querySelectorAll('a[href="/admin.html"]').forEach((el) => {
    el.style.display = ['admin', 'owner'].includes(user.role) ? '' : 'none';
  });

  const el = document.getElementById('auth-bar');
  if (!el) return;
  const badgeMap = {
    owner: '<span class="badge badge-waitlisted" style="font-size:10px;">擁有者</span>',
    admin: '<span class="badge badge-confirmed" style="font-size:10px;">管理者</span>',
    user:  '<span class="badge badge-open" style="font-size:10px;">會員</span>',
  };
  const badge = badgeMap[user.role] || badgeMap.user;

  // Fetch points balance for members only
  let pillHtml = '';
  if (user.role === 'user') {
    try {
      const bal = await api('/api/my/points/balance');
      const low = bal.one_on_one <= 0 || bal.group <= 0;
      pillHtml = `
        <span class="badge ${low ? 'badge-cancelled' : 'badge-confirmed'}"
              title="${low ? '某池餘額為 0，請聯絡管理員儲值' : '剩餘點數'}"
              style="font-size:10px; margin-right:8px;">
          PT ${bal.one_on_one} · 團 ${bal.group}
        </span>`;
    } catch {
      pillHtml = '';
    }
  }

  el.innerHTML = `
    <div class="flex items-center gap-2">
      ${pillHtml}
      ${badge}
      <span class="text-sm font-medium">${user.name}</span>
      <span class="subtle hidden md:inline">${user.email}</span>
    </div>
    <button id="logout-btn" class="btn btn-ghost btn-sm">登出</button>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearAuth();
    location.href = '/login.html';
  });
}
```

Also add a `refreshAuthBar` export that other pages can call after a booking/cancel:

At the bottom of `public/app.js`, add:

```javascript
export async function refreshAuthBar() {
  const user = getUser();
  if (!user) return;
  await renderAuthBar(user);
}
```

- [ ] **Step 2: Update `bootAuth` to `await` the now-async `renderAuthBar`**

In the same file, find `bootAuth`. It currently calls `renderAuthBar(user)` synchronously. Make it await:

```javascript
  await renderAuthBar(user);
```

Test the page loads with `bootAuth` returning a user properly.

- [ ] **Step 3: Smoke test in browser**

```bash
PORT=3001 node src/server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 1
echo "Login as user1 / pass1234, then check that the navbar shows '[PT 5 · 團 10]' (or whatever they have)."
echo "Open: http://localhost:3001/login.html"
echo "Confirm 200 on critical pages:"
for path in /index.html /coaches.html /my-bookings.html /my.html; do
  echo -n "$path: "
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001$path"
done
kill $SERVER_PID 2>/dev/null
```

A manual browser check at the URL is required for full validation; the curl-based smoke just confirms the pages still respond.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): navbar balance pill for members + refreshAuthBar helper"
```

---

## Task 9 — Booking pages 0-balance hard-block UI

**Files:**
- Modify: `public/coaches.js`
- Modify: `public/courses.js` (group class registration confirm)

- [ ] **Step 1: Modify `public/coaches.js`**

Add an import at the top alongside existing imports:

```javascript
import { api, fmtDate, dow, toast, refreshAuthBar } from './app.js';
```

In `openConfirm(slotStr)`, BEFORE the line that shows the confirm view, check balance:

```javascript
async function openConfirm(slotStr) {
  currentSlot = slotStr;
  const d = new Date(slotStr);
  $('confirm-summary').innerHTML = `
    <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${escapeHtml(currentCoach.display_name)}</strong></div>
    <div><span class="text-slate-500">時間</span><br><strong>${fmtDate(slotStr)}（60 分鐘）</strong></div>
  `;
  $('note').value = '';

  // Phase 2: check balance, disable confirm button if 0
  try {
    const bal = await api('/api/my/points/balance');
    const btn = $('confirm-btn');
    if (bal.one_on_one <= 0) {
      btn.disabled = true;
      btn.textContent = '點數不足，無法預約';
      btn.classList.add('opacity-50');
      let hint = document.getElementById('balance-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'balance-hint';
        hint.className = 'text-sm text-red-500 mt-2';
        btn.parentNode.insertBefore(hint, btn.nextSibling);
      }
      hint.textContent = '目前一對一餘額 0 點，請聯絡管理員儲值。';
    } else {
      btn.disabled = false;
      btn.textContent = '確認預約';
      btn.classList.remove('opacity-50');
      const hint = document.getElementById('balance-hint');
      if (hint) hint.remove();
    }
  } catch {} // silent — if balance fetch fails, still let them try; backend will block

  show('confirm');
}
```

Inside the existing confirm-btn click handler, after a successful booking, call `refreshAuthBar()` to update the navbar pill. Find the line `toast('預約成功！', 'success');` and immediately after it add:

```javascript
    await refreshAuthBar();
```

Also handle `insufficient_points` 409 specifically. Find the catch block in the click handler:

```javascript
  } catch (e) {
    if (e.data?.error === 'slot_taken') {
      toast('此時段剛被預約走了', 'error');
    } else if (e.data?.error === 'insufficient_points') {
      toast('點數不足，請聯絡管理員', 'error');
    } else {
      toast(`預約失敗：${e.message}`, 'error');
    }
  }
```

- [ ] **Step 2: Modify `public/courses.js` similarly**

`public/courses.js` handles group class registration. Read the existing file structure to understand its register-button flow. Wherever it calls `POST /api/sessions/:id/register`, before the call check balance:

```javascript
const bal = await api('/api/my/points/balance');
if (bal.group <= 0) {
  toast('團體課餘額 0 點，請聯絡管理員儲值', 'error');
  return;  // do not fire register
}
```

After a successful register/cancel call:

```javascript
import { refreshAuthBar } from './app.js';
// ... after success ...
await refreshAuthBar();
```

And handle 409 `insufficient_points` in the catch path.

The exact insertion points depend on `courses.js` existing structure (190 lines); look for the click handler that calls `/api/sessions/:id/register` and the equivalent cancel handler.

- [ ] **Step 3: Smoke test**

```bash
PORT=3001 node src/server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 1
echo "Manual: login as user1 → /coaches.html → pick a slot → confirm shows balance check"
echo "Drain user1's points via admin grant -N → confirm button disables"
echo "API endpoints reachable:"
for path in /api/coaches /api/my/points/balance; do
  echo -n "$path: "
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001$path"
done
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add public/coaches.js public/courses.js
git commit -m "feat(ui): hard-block confirm button when point balance is 0"
```

---

## Task 10 — Admin user table: balance columns + grant/history modals

**Files:**
- Modify: `public/admin.html`
- Modify: `public/admin.js`

- [ ] **Step 1: Modify `public/admin.html` — add modal `<dialog>` elements + extend user-management section**

Read the existing `<section>` containing `<div id="users-table"></div>`. Just AFTER that section's closing tag, add the two `<dialog>` elements:

```html
<dialog id="grant-modal" style="border:none; border-radius:8px; padding:0; max-width:400px; width:90%;">
  <div style="padding:20px;">
    <h3 style="font-weight:600; margin-bottom:12px;">加點：<span id="grant-target-name"></span></h3>
    <form id="grant-form" method="dialog">
      <div style="margin-bottom:10px;">
        <label style="display:block; font-size:13px; margin-bottom:4px;">Pool</label>
        <select name="pool" required style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px;">
          <option value="one_on_one">一對一</option>
          <option value="group">團體課</option>
        </select>
      </div>
      <div style="margin-bottom:10px;">
        <label style="display:block; font-size:13px; margin-bottom:4px;">金額（可負）</label>
        <input name="amount" type="number" step="1" required style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px;">
      </div>
      <div style="margin-bottom:14px;">
        <label style="display:block; font-size:13px; margin-bottom:4px;">備註（必填）</label>
        <input name="note" type="text" required maxlength="200" style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px;" placeholder="例：PT 10 堂裝">
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button type="button" id="grant-cancel" class="btn btn-ghost btn-sm">取消</button>
        <button type="submit" class="btn btn-primary btn-sm">送出</button>
      </div>
    </form>
  </div>
</dialog>

<dialog id="history-modal" style="border:none; border-radius:8px; padding:0; max-width:700px; width:95%; max-height:80vh; overflow:auto;">
  <div style="padding:20px;">
    <h3 style="font-weight:600; margin-bottom:8px;">點數紀錄：<span id="history-target-name"></span></h3>
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;">Pool 篩選：</label>
      <select id="history-pool-filter" style="padding:4px; border:1px solid #ccc; border-radius:4px;">
        <option value="">全部</option>
        <option value="one_on_one">一對一</option>
        <option value="group">團體課</option>
      </select>
    </div>
    <div id="history-list" style="font-family:monospace; font-size:12px; max-height:50vh; overflow:auto;"></div>
    <div style="display:flex; justify-content:flex-end; margin-top:14px;">
      <button id="history-close" class="btn btn-ghost btn-sm">關閉</button>
    </div>
  </div>
</dialog>
```

- [ ] **Step 2: Modify `public/admin.js` — augment user table + wire up modals**

Find the existing `loadUsers()` function. Modify the table header and row rendering to include balance + actions columns.

Replace the `el.innerHTML = ...` block inside `loadUsers()` with this updated version:

```javascript
    el.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th style="width:60px;">ID</th>
          <th>姓名</th>
          <th>Email</th>
          <th>登入方式</th>
          <th>角色</th>
          <th style="width:80px;">PT 點</th>
          <th style="width:80px;">團體 點</th>
          <th style="width:140px;">點數動作</th>
          <th>加入時間</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => renderUserRow(r, canEdit)).join('')}
        </tbody>
      </table>`;
```

Then find the `renderUserRow` function and update it to include the balance + action columns. Add these `<td>` cells to the row template (between role and created_at):

```javascript
        <td>${r.one_on_one_balance ?? 0}</td>
        <td>${r.group_balance ?? 0}</td>
        <td>
          <button class="btn btn-ghost btn-sm grant-btn" data-id="${r.id}" data-name="${r.name}">加點</button>
          <button class="btn btn-ghost btn-sm history-btn" data-id="${r.id}" data-name="${r.name}">歷史</button>
        </td>
```

In `loadUsers()` AFTER the role-select wiring, add wiring for the new buttons:

```javascript
    el.querySelectorAll('button.grant-btn').forEach(btn => {
      btn.addEventListener('click', () => openGrantModal(Number(btn.dataset.id), btn.dataset.name));
    });
    el.querySelectorAll('button.history-btn').forEach(btn => {
      btn.addEventListener('click', () => openHistoryModal(Number(btn.dataset.id), btn.dataset.name));
    });
```

At the bottom of `public/admin.js`, add the modal logic:

```javascript
function openGrantModal(userId, userName) {
  const dlg = document.getElementById('grant-modal');
  document.getElementById('grant-target-name').textContent = userName;
  const form = document.getElementById('grant-form');
  form.reset();
  dlg.dataset.userId = String(userId);
  dlg.showModal();
}

document.getElementById('grant-cancel').addEventListener('click', () => {
  document.getElementById('grant-modal').close();
});

document.getElementById('grant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dlg = document.getElementById('grant-modal');
  const userId = Number(dlg.dataset.userId);
  const fd = new FormData(e.target);
  try {
    await api(`/api/admin/users/${userId}/points/grant`, {
      method: 'POST',
      body: {
        pool: fd.get('pool'),
        amount: Number(fd.get('amount')),
        note: fd.get('note'),
      },
    });
    toast('加點成功', 'success');
    dlg.close();
    loadUsers();
  } catch (err) {
    const map = {
      insufficient_points: '結果餘額會 < 0，無法執行',
      invalid_amount: '金額不可為 0 或非整數',
      missing_note: '備註必填',
      invalid_pool: '池子設定錯誤',
    };
    toast(map[err.data?.error] || `加點失敗：${err.message}`, 'error');
  }
});

async function openHistoryModal(userId, userName) {
  const dlg = document.getElementById('history-modal');
  document.getElementById('history-target-name').textContent = userName;
  dlg.dataset.userId = String(userId);
  await loadHistory(userId, '');
  dlg.showModal();
}

document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-modal').close();
});

document.getElementById('history-pool-filter').addEventListener('change', async (e) => {
  const userId = Number(document.getElementById('history-modal').dataset.userId);
  await loadHistory(userId, e.target.value);
});

async function loadHistory(userId, pool) {
  const list = document.getElementById('history-list');
  list.innerHTML = '載入中...';
  const qs = pool ? `?pool=${pool}&limit=100` : '?limit=100';
  try {
    const rows = await api(`/api/admin/users/${userId}/points/transactions${qs}`);
    if (!rows.length) { list.innerHTML = '<div class="subtle">無紀錄</div>'; return; }
    list.innerHTML = rows.map(r => {
      const sign = r.amount > 0 ? `+${r.amount}` : String(r.amount);
      const color = r.amount > 0 ? 'color:#15803d' : 'color:#b91c1c';
      return `<div style="padding:4px 0; border-bottom:1px solid #f0f0f0;">
        <span style="color:#666;">${r.created_at}</span>
        &nbsp;<span style="${color}; font-weight:600;">${sign}</span>
        &nbsp;<span style="color:#666;">[${r.pool}]</span>
        &nbsp;<span style="color:#888;">${r.source}</span>
        &nbsp;${escapeHtml(r.note)}
        &nbsp;<span style="color:#888;">by ${escapeHtml(r.actor_name)}</span>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:red;">載入失敗：${err.message}</div>`;
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
```

If `escapeHtml` already exists elsewhere in `admin.js`, do NOT redefine it.

- [ ] **Step 3: Smoke test**

```bash
PORT=3001 node src/server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 1
echo "admin.html:" ; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/admin.html
echo "admin.js:" ; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/admin.js
echo "Manual: login as admin / admin1234 → /admin.html → 會員管理 section now has PT/團 columns + 加點/歷史 buttons → click 加點 on user1 → fill form → submit → toast → list refreshes"
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat(ui): admin user table balance columns + grant/history modals"
```

---

## Task 11 — Seed-demo + Migration note

**Files:**
- Modify: `src/db/seed-demo.js`

- [ ] **Step 1: Append point grants to demo members**

Read the existing `src/db/seed-demo.js`. After the existing seed of users user1..user12, append:

```javascript
// Phase 2: seed initial points for demo members
import { adminGrant } from '../services/pointService.js';
const ownerForSeed = db.prepare("SELECT id FROM users WHERE role IN ('owner', 'admin') ORDER BY role='owner' DESC LIMIT 1").get();
if (ownerForSeed) {
  const demoMembers = db.prepare("SELECT id FROM users WHERE role = 'user' AND email LIKE 'user%@chinup.local' ORDER BY id").all();
  for (const m of demoMembers) {
    // Skip if already seeded (idempotent)
    const exists = db.prepare("SELECT 1 FROM point_transactions WHERE member_id = ? AND note = 'seed-demo points'").get(m.id);
    if (!exists) {
      adminGrant({ memberId: m.id, pool: 'one_on_one', amount: 5, note: 'seed-demo points', adminId: ownerForSeed.id });
      adminGrant({ memberId: m.id, pool: 'group', amount: 10, note: 'seed-demo points', adminId: ownerForSeed.id });
    }
  }
  console.log(`[seed] granted points to ${demoMembers.length} demo members`);
}
```

Make sure the `import` is at the TOP of the file (move it if necessary) alongside other imports.

- [ ] **Step 2: Re-seed and verify**

```bash
rm -f data/app.db
node src/db/migrate.js
node src/db/seed-demo.js
sqlite3 data/app.db "SELECT u.email, b.one_on_one_balance, b.group_balance FROM users u JOIN member_point_balance b ON b.member_id = u.id WHERE u.email LIKE 'user%@chinup.local' ORDER BY u.id LIMIT 3"
```

Expected: 3 rows showing `user1...|5|10`, `user2...|5|10`, `user3...|5|10`.

- [ ] **Step 3: Commit**

```bash
git add src/db/seed-demo.js
git commit -m "chore(seed): grant initial points to demo members"
```

---

## Task 12 — README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert "點數系統 (Phase 2)" section**

Read existing `README.md` to find the "一對一預約模組 (Phase 1)" section added in Phase 1. Insert AFTER that section, BEFORE the next H2 (likely 「技術棧」 or 「快速開始」):

```markdown
## 點數系統（Phase 2）

點數作為預約的「貨幣」，admin 手動加點、會員預約扣點、取消退點。

### 兩個池子（獨立）

- **一對一池子**：扣減於一對一預約 / 退於一對一取消
- **團體池子**：扣減於團體報名（含候補）/ 退於團體取消、不成班自動退

### 模型

單一 `point_transactions` 表，每筆加減點是一個有號 row。當前餘額 = `SUM(amount) WHERE member_id = ? AND pool = ?`。所有寫入用 `tx() BEGIN IMMEDIATE`，post-insert 餘額 < 0 → rollback。

### Admin 操作

`/admin.html` 會員管理 section：
- 看每人 PT/團體 餘額
- 「加點」按鈕：pool 選一對一 / 團體、金額（可負）、必填備註
- 「歷史」按鈕：看該會員最近 100 筆交易（含 source、actor、note）

### 會員體驗

- Navbar 右上角膠囊：`[PT N · 團 M]`，0 點時紅字
- 預約 / 報名頁：餘額 0 → 確認鈕 disabled，提示「請聯絡管理員儲值」
- 取消預約 / 報名 → 自動退點，無條件、無時限

### 設計 / 計畫文件

- `docs/superpowers/specs/2026-05-12-points-system-design.md`
- `docs/superpowers/plans/2026-05-12-points-system.md`

### Phase 2 部署 SOP（**一次性、僅限本次 dev 階段**）

```bash
# 在 Railway shell 跑
rm -f data/app.db && node src/db/migrate.js && node src/db/seed-demo.js
```

下次 schema 變動必須走真正的 migration，**不能再清 DB**。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add points system section to README"
```

---

## Spec Coverage Check

| Spec section | Covered by task |
|---|---|
| §1 Goal | Task 12 (README) |
| §2 Scope (in) — `point_transactions` table | Task 1 |
| §2 Scope (in) — two pools | Task 1, 2 |
| §2 Scope (in) — 1-on-1 deduction/refund | Task 3 |
| §2 Scope (in) — group deduction/refund | Task 4 |
| §2 Scope (in) — session auto-refund | Task 5 |
| §2 Scope (in) — admin grant API + UI | Task 7, 10 |
| §2 Scope (in) — balance pill | Task 8 |
| §2 Scope (in) — hard-block 0 balance | Task 9 |
| §2 Scope (in) — concurrency model | Task 2 (within recordTransaction `tx()`) |
| §2 Scope (in) — wipe-DB migration | Task 11, 12 (documented in README) |
| §4 Data Model | Task 1 |
| §5 Service Layer | Task 2, 3, 4, 5 |
| §6 HTTP Routes | Task 7 |
| §7 UI Changes | Task 8, 9, 10 |
| §8 Concurrency & Edge Cases | Implementation in Task 2; testing in Task 2 Case 6 |
| §9 Migration & Deployment | Task 11 (seed) + Task 12 (README SOP) |
| §10 Testing | Task 2 (Case 6), Task 3 (Case 7), Task 4 (Case 8a), Task 5 (Case 8b), Task 6 (existing test patch), Task 7 (HTTP cases) |
| §11 Definition of Done | Tasks 1–12 collectively |
| §12 Risks | Acknowledged across tasks |
