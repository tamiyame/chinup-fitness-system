# One-on-One Booking Module · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-on-one coaching booking module to `chinup-fitness-system` (Phase 1 of broader plan; Phase 2/3 deferred).

**Architecture:** Extend existing chinup codebase in place. Four new SQLite tables (`coaches`, `coach_availability_rules`, `coach_availability_exceptions`, `bookings`). New `coach` role. Rule-based availability with slot computation on the fly. Multi-page SSR frontend matching the existing pattern.

**Tech Stack:** Same as chinup — Node 24 (ESM), Express, `node:sqlite` (WAL), node-cron, Vanilla JS + Tailwind CDN. Zero new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-11-one-on-one-booking-design.md`

**Deviations from spec (noted for traceability):**
- Avatar upload uses **base64 in JSON** rather than multipart, to maintain zero new deps. Server enforces 2 MB via Express `json` limit on the avatar route and validates MIME from the base64 magic bytes. Otherwise behaviour matches spec.
- Test files follow chinup's existing custom `expect(label, fn)` script-style harness (not `node:test`), to keep `npm run test:flow` and `npm run test:api` discoverability consistent.

---

## File Structure

### Files to create

| Path | Responsibility |
|---|---|
| `src/services/coachService.js` | Coach profile CRUD, active list, role-toggle helpers |
| `src/services/availabilityService.js` | Rules + exceptions CRUD; `computeAvailableSlots()` |
| `src/services/bookingService.js` | `createBooking`, `cancelBooking`, listings |
| `public/coaches.html` | Member: coach list + detail + slot picker (one page, JS-switched views) |
| `public/coaches.js` | Logic for `coaches.html` |
| `public/coach.html` | Coach: dashboard + profile + availability + my-bookings (tabbed) |
| `public/coach.js` | Logic for `coach.html` |
| `public/my-bookings.html` | Member: 1-on-1 bookings list + cancel |
| `public/my-bookings.js` | Logic for `my-bookings.html` |
| `tests/booking-flow.test.js` | Service-level tests (no HTTP) |
| `tests/booking-api.test.js` | HTTP integration tests |

### Files to modify

| Path | Changes |
|---|---|
| `src/db/schema.js` | Append 4 new tables + partial unique index |
| `src/server.js` | Add `requireCoach` middleware; allow `'coach'` in role-PATCH; mount new routes; serve `/avatars/` static |
| `src/services/auth.js` | `registerWithPassword` accepts `as_coach` flag |
| `src/db/seed-demo.js` | Seed one coach + rules + one exception + one booking |
| `public/index.html` | Add 「預約一對一」 entry; link to `/coaches.html` |
| `public/admin.html` + `public/admin.js` | Add coach management section |
| `public/my.html` | Add link to `/my-bookings.html` (or fold in) |
| `README.md` | Add "一對一預約模組" section |

---

## Task 1 — Schema additions

**Files:**
- Modify: `src/db/schema.js`
- Test: server boot must apply new tables without error

- [ ] **Step 1: Append the four new tables to the SCHEMA template literal**

In `src/db/schema.js`, add the following AFTER the existing `notifications` table block, BEFORE the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  specialty TEXT,
  bio TEXT,
  avatar_path TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_availability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);

CREATE TABLE IF NOT EXISTS coach_availability_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('leave', 'extra')),
  start_time TEXT,
  end_time TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (type = 'leave' OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id),
  member_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_coach_start_confirmed
  ON bookings(coach_id, start_at) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_coach_status ON bookings(coach_id, status);
CREATE INDEX IF NOT EXISTS idx_availability_rules_coach ON coach_availability_rules(coach_id);
CREATE INDEX IF NOT EXISTS idx_availability_exceptions_coach_date ON coach_availability_exceptions(coach_id, exception_date);
```

- [ ] **Step 2: Verify schema applies on a fresh DB**

```bash
rm -f data/test.db && DB_PATH=data/test.db node -e "import('./src/db/connection.js').then(({db}) => { const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all(); console.log(tables); })"
```

Expected output includes: `auth_sessions`, `bookings`, `coach_availability_exceptions`, `coach_availability_rules`, `coaches`, `course_categories`, `course_sessions`, `course_templates`, `notifications`, `registrations`, `users`.

Clean up: `rm -f data/test.db`

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.js
git commit -m "feat(schema): add coaches, availability rules/exceptions, bookings tables"
```

---

## Task 2 — `coach` role in auth + middleware

**Files:**
- Modify: `src/server.js` (around line 45–57 for middleware; line 342 for role PATCH)

- [ ] **Step 1: Add `requireCoach` middleware in `src/server.js`**

Insert AFTER the existing `requireAdmin` function (around line 50):

```javascript
function requireCoach(req, res, next) {
  requireUser(req, res, () => {
    if (!['coach', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'coach_only' });
    }
    next();
  });
}
```

- [ ] **Step 2: Allow `'coach'` in role PATCH**

In `src/server.js`, find the line:

```javascript
if (!['user', 'admin', 'owner'].includes(role)) {
```

Change to:

```javascript
if (!['user', 'coach', 'admin', 'owner'].includes(role)) {
```

- [ ] **Step 3: Smoke test by booting the server**

```bash
PORT=3001 node src/server.js &
sleep 1
curl -s http://localhost:3001/api/health
kill %1
```

Expected: `{"ok":true,"ts":"..."}`

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(auth): add coach role and requireCoach middleware"
```

---

## Task 3 — `coachService.js` (profile CRUD)

**Files:**
- Create: `src/services/coachService.js`
- Test: extend `tests/booking-flow.test.js`

- [ ] **Step 1: Create `tests/booking-flow.test.js` with scaffolding + first failing test**

```javascript
// 核心流程驗證 — 一對一預約模組
import { db } from '../src/db/connection.js';
import {
  createCoach, listActiveCoaches, getCoach, updateCoach, setCoachActive,
} from '../src/services/coachService.js';
import assert from 'node:assert/strict';

function reset() {
  db.exec(`
    DELETE FROM bookings;
    DELETE FROM coach_availability_exceptions;
    DELETE FROM coach_availability_rules;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'coach-test-%';
  `);
}

function makeUser(email, name = 'Test') {
  const info = db.prepare(
    "INSERT INTO users (name, email, role, notification_preference) VALUES (?, ?, 'coach', 'email')"
  ).run(name, email);
  return info.lastInsertRowid;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[booking-flow test] start');
reset();

// --- Case 1: coachService basics ---
console.log('[case 1] coach CRUD');
const u1 = makeUser('coach-test-1@chinup.local', '王教練');
const c1 = createCoach({
  userId: u1,
  displayName: '王教練',
  specialty: '增肌減脂',
  bio: '10 年經驗',
});
expect('createCoach returns id', () => assert(c1.id));
expect('new coach is_active=0 (pending)', () => {
  const row = getCoach(c1.id);
  assert.equal(row.is_active, 0);
});
expect('listActiveCoaches excludes pending', () => {
  assert.equal(listActiveCoaches().length, 0);
});

setCoachActive(c1.id, true);
expect('after activation, appears in list', () => {
  const list = listActiveCoaches();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c1.id);
});

updateCoach(c1.id, { specialty: '增肌減脂 · 體態雕塑', bio: 'updated' });
expect('updateCoach applies fields', () => {
  const row = getCoach(c1.id);
  assert.equal(row.specialty, '增肌減脂 · 體態雕塑');
  assert.equal(row.bio, 'updated');
});

expect('duplicate user_id rejected', () => {
  assert.throws(() => createCoach({ userId: u1, displayName: 'dup' }), /UNIQUE|coach_exists/);
});
```

- [ ] **Step 2: Run test, expect failure (no service yet)**

```bash
node tests/booking-flow.test.js
```

Expected: error like `Cannot find module '../src/services/coachService.js'`.

- [ ] **Step 3: Create `src/services/coachService.js`**

```javascript
import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertCoach = db.prepare(`
  INSERT INTO coaches (user_id, display_name, specialty, bio, avatar_path, is_active, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getCoachStmt = db.prepare('SELECT * FROM coaches WHERE id = ?');
const getCoachByUserId = db.prepare('SELECT * FROM coaches WHERE user_id = ?');
const listAllStmt = db.prepare('SELECT * FROM coaches ORDER BY sort_order ASC, id ASC');
const listActiveStmt = db.prepare(
  'SELECT * FROM coaches WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
);
const setActiveStmt = db.prepare(
  "UPDATE coaches SET is_active = ?, updated_at = datetime('now') WHERE id = ?"
);

export function createCoach({ userId, displayName, specialty = null, bio = null, avatarPath = null, sortOrder = 0 }) {
  if (!userId) throw new ApiError(400, 'missing_user_id');
  if (!displayName || !displayName.trim()) throw new ApiError(400, 'missing_display_name');
  try {
    const info = insertCoach.run(userId, displayName.trim(), specialty, bio, avatarPath, 0, sortOrder);
    return { id: info.lastInsertRowid };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'coach_exists');
    throw e;
  }
}

export function getCoach(id) {
  return getCoachStmt.get(id) || null;
}

export function getCoachByUser(userId) {
  return getCoachByUserId.get(userId) || null;
}

export function listAllCoaches() {
  return listAllStmt.all();
}

export function listActiveCoaches() {
  return listActiveStmt.all();
}

export function setCoachActive(id, active) {
  const info = setActiveStmt.run(active ? 1 : 0, id);
  if (info.changes === 0) throw new ApiError(404, 'coach_not_found');
  return { ok: true };
}

const UPDATABLE = ['display_name', 'specialty', 'bio', 'avatar_path', 'sort_order'];
export function updateCoach(id, fields) {
  const current = getCoachStmt.get(id);
  if (!current) throw new ApiError(404, 'coach_not_found');
  const snake = {
    display_name: fields.displayName ?? fields.display_name,
    specialty: fields.specialty,
    bio: fields.bio,
    avatar_path: fields.avatarPath ?? fields.avatar_path,
    sort_order: fields.sortOrder ?? fields.sort_order,
  };
  const cols = [], vals = [];
  for (const k of UPDATABLE) {
    if (snake[k] !== undefined) {
      cols.push(`${k} = ?`);
      vals.push(snake[k]);
    }
  }
  if (cols.length === 0) return { ok: true, unchanged: true };
  cols.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE coaches SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true };
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ for Case 1.

- [ ] **Step 5: Commit**

```bash
git add src/services/coachService.js tests/booking-flow.test.js
git commit -m "feat(service): add coachService with profile CRUD"
```

---

## Task 4 — `availabilityService.js` (rules + exceptions CRUD)

**Files:**
- Create: `src/services/availabilityService.js`
- Test: append to `tests/booking-flow.test.js`

- [ ] **Step 1: Append test cases to `tests/booking-flow.test.js`** — add the `import` at the **top of the file** (next to existing imports; ES modules require imports at top), then append the test body at the bottom.

Top-of-file import to add:

```javascript
import {
  addRule, listRules, deleteRule,
  addException, listExceptions, deleteException,
} from '../src/services/availabilityService.js';
```

Append at the bottom of the file:

```javascript
// --- Case 2: availability rules CRUD ---

console.log('[case 2] availability rules + exceptions');

const r1 = addRule({ coachId: c1.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2026-05-01' });
const r2 = addRule({ coachId: c1.id, dayOfWeek: 1, startTime: '14:00', endTime: '17:00', effectiveFrom: '2026-05-01' });
expect('coach can have two rules on same day', () => {
  const rules = listRules(c1.id);
  assert.equal(rules.length, 2);
});

expect('addRule rejects start >= end', () => {
  assert.throws(() => addRule({ coachId: c1.id, dayOfWeek: 2, startTime: '10:00', endTime: '09:00' }), /invalid_time|CHECK/);
});

deleteRule({ coachId: c1.id, ruleId: r1.id });
expect('after delete, only one rule remains', () => assert.equal(listRules(c1.id).length, 1));

expect('cannot delete another coach rule', () => {
  // Create a second coach, try to delete c1's rule using its id
  const u2 = makeUser('coach-test-2@chinup.local', '李教練');
  const c2 = createCoach({ userId: u2, displayName: '李教練' });
  assert.throws(() => deleteRule({ coachId: c2.id, ruleId: r2.id }), /forbidden|not_found/);
});

const ex1 = addException({ coachId: c1.id, exceptionDate: '2026-05-13', type: 'leave', note: '個人事務' });
const ex2 = addException({ coachId: c1.id, exceptionDate: '2026-05-18', type: 'extra', startTime: '10:00', endTime: '13:00' });
expect('two exceptions stored', () => assert.equal(listExceptions(c1.id).length, 2));

expect('extra exception requires times', () => {
  assert.throws(() => addException({ coachId: c1.id, exceptionDate: '2026-05-20', type: 'extra' }), /missing_time|CHECK/);
});

deleteException({ coachId: c1.id, exceptionId: ex1.id });
expect('after delete, one exception remains', () => assert.equal(listExceptions(c1.id).length, 1));
```

- [ ] **Step 2: Run test, expect failure**

```bash
node tests/booking-flow.test.js
```

Expected: error `Cannot find module '../src/services/availabilityService.js'`.

- [ ] **Step 3: Create `src/services/availabilityService.js` with the CRUD half**

```javascript
import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertRuleStmt = db.prepare(`
  INSERT INTO coach_availability_rules (coach_id, day_of_week, start_time, end_time, effective_from, effective_to)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listRulesStmt = db.prepare(`
  SELECT * FROM coach_availability_rules
  WHERE coach_id = ?
  ORDER BY day_of_week ASC, start_time ASC
`);
const getRuleStmt = db.prepare('SELECT * FROM coach_availability_rules WHERE id = ?');
const deleteRuleStmt = db.prepare('DELETE FROM coach_availability_rules WHERE id = ? AND coach_id = ?');

const insertExceptionStmt = db.prepare(`
  INSERT INTO coach_availability_exceptions (coach_id, exception_date, type, start_time, end_time, note)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listExceptionsStmt = db.prepare(`
  SELECT * FROM coach_availability_exceptions
  WHERE coach_id = ?
  ORDER BY exception_date ASC
`);
const deleteExceptionStmt = db.prepare('DELETE FROM coach_availability_exceptions WHERE id = ? AND coach_id = ?');

const HHMM = /^\d{2}:\d{2}$/;
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

function validateTimes(startTime, endTime) {
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) throw new ApiError(400, 'invalid_time_format');
  if (startTime >= endTime) throw new ApiError(400, 'invalid_time');
}

export function addRule({ coachId, dayOfWeek, startTime, endTime, effectiveFrom = null, effectiveTo = null }) {
  if (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6) throw new ApiError(400, 'invalid_day_of_week');
  validateTimes(startTime, endTime);
  const from = effectiveFrom || todayLocal();
  if (!YYYYMMDD.test(from)) throw new ApiError(400, 'invalid_effective_from');
  if (effectiveTo && !YYYYMMDD.test(effectiveTo)) throw new ApiError(400, 'invalid_effective_to');
  const info = insertRuleStmt.run(coachId, dayOfWeek, startTime, endTime, from, effectiveTo);
  return { id: info.lastInsertRowid };
}

export function listRules(coachId) {
  return listRulesStmt.all(coachId);
}

export function deleteRule({ coachId, ruleId }) {
  const rule = getRuleStmt.get(ruleId);
  if (!rule) throw new ApiError(404, 'rule_not_found');
  if (rule.coach_id !== coachId) throw new ApiError(403, 'forbidden');
  deleteRuleStmt.run(ruleId, coachId);
  return { ok: true };
}

export function addException({ coachId, exceptionDate, type, startTime = null, endTime = null, note = null }) {
  if (!YYYYMMDD.test(exceptionDate)) throw new ApiError(400, 'invalid_exception_date');
  if (!['leave', 'extra'].includes(type)) throw new ApiError(400, 'invalid_type');
  if (type === 'extra') {
    if (!startTime || !endTime) throw new ApiError(400, 'missing_time');
    validateTimes(startTime, endTime);
  } else {
    startTime = null;
    endTime = null;
  }
  const info = insertExceptionStmt.run(coachId, exceptionDate, type, startTime, endTime, note);
  return { id: info.lastInsertRowid };
}

export function listExceptions(coachId) {
  return listExceptionsStmt.all(coachId);
}

export function deleteException({ coachId, exceptionId }) {
  const info = deleteExceptionStmt.run(exceptionId, coachId);
  if (info.changes === 0) throw new ApiError(404, 'exception_not_found');
  return { ok: true };
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ for Case 1 + Case 2.

- [ ] **Step 5: Commit**

```bash
git add src/services/availabilityService.js tests/booking-flow.test.js
git commit -m "feat(service): add availability rules/exceptions CRUD"
```

---

## Task 5 — `computeAvailableSlots()` (the core algorithm)

**Files:**
- Modify: `src/services/availabilityService.js` (add the compute function)
- Test: append to `tests/booking-flow.test.js`

- [ ] **Step 1: Append exhaustive test cases** — again, add new imports to the **top of `tests/booking-flow.test.js`** alongside existing imports, then append the test body at the bottom.

Top-of-file imports to add:

```javascript
import { computeAvailableSlots } from '../src/services/availabilityService.js';
import { createBooking } from '../src/services/bookingService.js';
```

Append at the bottom of the file:

```javascript
// --- Case 3: slot computation ---

console.log('[case 3] computeAvailableSlots');

reset();
const uA = makeUser('coach-test-A@chinup.local', '陳教練');
const cA = createCoach({ userId: uA, displayName: '陳教練' });
setCoachActive(cA.id, true);

// Far future rules so "past slot" and "buffer" filters don't trip
addRule({ coachId: cA.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2099-01-01' });
addRule({ coachId: cA.id, dayOfWeek: 3, startTime: '14:00', endTime: '16:00', effectiveFrom: '2099-01-01' });

// 2099-05-04 is a Monday; 2099-05-06 is a Wednesday (verify with `new Date('2099-05-04').getDay()` === 1)
const slots = computeAvailableSlots({ coachId: cA.id, fromDate: '2099-05-04', toDate: '2099-05-06' });
expect('Monday expands to 3 60-min slots (09,10,11)', () => {
  const mon = slots.filter(s => s.startsWith('2099-05-04'));
  assert.deepEqual(mon, ['2099-05-04T09:00:00', '2099-05-04T10:00:00', '2099-05-04T11:00:00']);
});
expect('Wednesday expands to 2 slots (14,15)', () => {
  const wed = slots.filter(s => s.startsWith('2099-05-06'));
  assert.deepEqual(wed, ['2099-05-06T14:00:00', '2099-05-06T15:00:00']);
});
expect('Tuesday yields nothing', () => {
  assert.equal(slots.filter(s => s.startsWith('2099-05-05')).length, 0);
});

// leave exception wipes the day
addException({ coachId: cA.id, exceptionDate: '2099-05-04', type: 'leave' });
const slots2 = computeAvailableSlots({ coachId: cA.id, fromDate: '2099-05-04', toDate: '2099-05-04' });
expect('leave exception removes all slots that day', () => assert.equal(slots2.length, 0));

// extra exception adds a window
addException({ coachId: cA.id, exceptionDate: '2099-05-07', type: 'extra', startTime: '10:00', endTime: '12:00' });
const slots3 = computeAvailableSlots({ coachId: cA.id, fromDate: '2099-05-07', toDate: '2099-05-07' });
expect('extra exception adds 2 slots', () => {
  assert.deepEqual(slots3, ['2099-05-07T10:00:00', '2099-05-07T11:00:00']);
});

// effective_from honored
reset();
const uB = makeUser('coach-test-B@chinup.local', 'B 教練');
const cB = createCoach({ userId: uB, displayName: 'B' });
setCoachActive(cB.id, true);
addRule({ coachId: cB.id, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', effectiveFrom: '2099-05-10' });
const slotsBefore = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-04', toDate: '2099-05-04' });
const slotsAfter  = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-11', toDate: '2099-05-11' });
expect('rule before effective_from yields nothing', () => assert.equal(slotsBefore.length, 0));
expect('rule on/after effective_from yields slots', () => assert.equal(slotsAfter.length, 1));

// effective_to honored
addRule({ coachId: cB.id, dayOfWeek: 2, startTime: '09:00', endTime: '10:00', effectiveFrom: '2099-05-01', effectiveTo: '2099-05-05' });
const tueIn = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-05', toDate: '2099-05-05' });
const tueOut = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-12', toDate: '2099-05-12' });
expect('Tuesday within effective_to yields slot', () => assert.equal(tueIn.length, 1));
expect('Tuesday after effective_to yields nothing', () => assert.equal(tueOut.length, 0));

// past slots filtered
addRule({ coachId: cB.id, dayOfWeek: new Date().getDay(), startTime: '00:00', endTime: '23:00', effectiveFrom: '2000-01-01' });
const today = (() => { const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; })();
const todaySlots = computeAvailableSlots({ coachId: cB.id, fromDate: today, toDate: today });
expect('today: no slots before now()', () => {
  const now = new Date();
  const nowStr = `${today}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00`;
  for (const s of todaySlots) assert(s > nowStr, `slot ${s} should be after ${nowStr}`);
});
expect('today: no slot within 2-hour buffer', () => {
  const now = Date.now();
  const buffer = now + 2 * 60 * 60 * 1000;
  for (const s of todaySlots) {
    const slotMs = new Date(s.replace(' ', 'T')).getTime();
    assert(slotMs >= buffer, `slot ${s} within 2h buffer`);
  }
});

// confirmed booking excludes the slot
reset();
const uC = makeUser('coach-test-C@chinup.local', 'C');
const cC = createCoach({ userId: uC, displayName: 'C' });
setCoachActive(cC.id, true);
addRule({ coachId: cC.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2099-01-01' });
const memberId = db.prepare("SELECT id FROM users WHERE role='user' ORDER BY id LIMIT 1").get().id;
createBooking({ coachId: cC.id, memberId, startAt: '2099-05-04T10:00:00' });
const slotsC = computeAvailableSlots({ coachId: cC.id, fromDate: '2099-05-04', toDate: '2099-05-04' });
expect('booked slot removed from availability', () => {
  assert.deepEqual(slotsC, ['2099-05-04T09:00:00', '2099-05-04T11:00:00']);
});
```

- [ ] **Step 2: Run test, expect failure (no compute function, no bookingService yet)**

```bash
node tests/booking-flow.test.js
```

Expected: error about `computeAvailableSlots` undefined or `bookingService` missing.

- [ ] **Step 3: Append `computeAvailableSlots` to `src/services/availabilityService.js`**

Append AFTER the existing exports:

```javascript
// --- Configuration (Phase 1 constants) ---
export const SLOT_DURATION_MINUTES = 60;
export const BUFFER_HOURS = 2;
export const BOOKING_WINDOW_DAYS = 30;

const listConfirmedBookings = db.prepare(`
  SELECT start_at FROM bookings
  WHERE coach_id = ? AND status = 'confirmed'
    AND start_at >= ? AND start_at <= ?
`);

const listRulesForDate = db.prepare(`
  SELECT * FROM coach_availability_rules
  WHERE coach_id = ?
    AND day_of_week = ?
    AND effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?)
`);

const listExceptionsForDate = db.prepare(`
  SELECT * FROM coach_availability_exceptions
  WHERE coach_id = ? AND exception_date = ?
`);

/**
 * Compute available 60-min slots for a coach within [fromDate, toDate] inclusive.
 * Returns local wall-clock strings 'YYYY-MM-DDTHH:MM:SS' sorted ascending.
 *
 * Filters applied (in order):
 *  - Coach must be active (caller's responsibility to check)
 *  - Apply day's rules where day_of_week matches AND date within effective range
 *  - If a 'leave' exception exists for the date, drop ALL slots
 *  - Add windows from 'extra' exceptions for the date
 *  - Split windows into 60-min slots aligned to window start
 *  - Drop slots in the past
 *  - Drop slots within BUFFER_HOURS of now()
 *  - Drop slots beyond BOOKING_WINDOW_DAYS from now()
 *  - Drop slots already taken by a confirmed booking
 */
export function computeAvailableSlots({ coachId, fromDate, toDate }) {
  if (!YYYYMMDD.test(fromDate) || !YYYYMMDD.test(toDate)) {
    throw new ApiError(400, 'invalid_date_range');
  }

  const now = new Date();
  const bufferMs = now.getTime() + BUFFER_HOURS * 3600_000;
  const windowEndMs = now.getTime() + BOOKING_WINDOW_DAYS * 86400_000;

  // Gather raw windows per date
  const dates = enumerateDates(fromDate, toDate);
  const rawSlots = [];
  for (const date of dates) {
    const exceptions = listExceptionsForDate.all(coachId, date);
    const hasLeave = exceptions.some(e => e.type === 'leave');
    const windows = [];
    if (!hasLeave) {
      const dow = new Date(date + 'T00:00:00').getDay();
      const rules = listRulesForDate.all(coachId, dow, date, date);
      for (const r of rules) windows.push({ start: r.start_time, end: r.end_time });
      for (const e of exceptions) {
        if (e.type === 'extra') windows.push({ start: e.start_time, end: e.end_time });
      }
    }
    for (const w of windows) {
      const slotStartsHH = splitWindowIntoSlots(w.start, w.end, SLOT_DURATION_MINUTES);
      for (const hh of slotStartsHH) rawSlots.push(`${date}T${hh}:00`);
    }
  }
  rawSlots.sort();

  // Apply now/buffer/window filters
  const nowStr = localWallClock(now);
  const afterFilter = rawSlots.filter(s => {
    if (s <= nowStr) return false;
    const slotMs = new Date(s).getTime();
    if (slotMs < bufferMs) return false;
    if (slotMs > windowEndMs) return false;
    return true;
  });
  if (afterFilter.length === 0) return [];

  // Drop already-booked
  const minSlot = afterFilter[0];
  const maxSlot = afterFilter[afterFilter.length - 1];
  const booked = new Set(
    listConfirmedBookings.all(coachId, minSlot, maxSlot).map(b => b.start_at)
  );
  return afterFilter.filter(s => !booked.has(s));
}

// --- helpers ---

function enumerateDates(fromDate, toDate) {
  const out = [];
  let cur = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86400_000);
  }
  return out;
}

function splitWindowIntoSlots(startHHMM, endHHMM, durationMin) {
  const [sH, sM] = startHHMM.split(':').map(Number);
  const [eH, eM] = endHHMM.split(':').map(Number);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;
  const out = [];
  for (let m = startMin; m + durationMin <= endMin; m += durationMin) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    out.push(`${hh}:${mm}`);
  }
  return out;
}

function localWallClock(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

- [ ] **Step 4: Create skeleton `src/services/bookingService.js`** (so the Case 3 booked-slot test can run; full impl in Task 6)

```javascript
import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertBooking = db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, note)
  VALUES (?, ?, ?, ?, ?)
`);

export function createBooking({ coachId, memberId, startAt, note = null }) {
  const endAt = addMinutes(startAt, 60);
  try {
    const info = insertBooking.run(coachId, memberId, startAt, endAt, note);
    return { id: info.lastInsertRowid, startAt, endAt };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
    throw e;
  }
}

function addMinutes(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
```

- [ ] **Step 5: Run test, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ through Case 3.

- [ ] **Step 6: Commit**

```bash
git add src/services/availabilityService.js src/services/bookingService.js tests/booking-flow.test.js
git commit -m "feat(service): add slot computation + booking insert skeleton"
```

---

## Task 6 — `bookingService.js` (full create + cancel)

**Files:**
- Modify: `src/services/bookingService.js`
- Test: append to `tests/booking-flow.test.js`

- [ ] **Step 1: Append Case 4 tests** — add the new imports to the **top of `tests/booking-flow.test.js`** alongside existing imports (note: `createBooking` is already imported from Task 5; just add `cancelBooking`, `listMemberBookings`, `listCoachBookings`):

```javascript
import {
  createBooking, cancelBooking, listMemberBookings, listCoachBookings,
} from '../src/services/bookingService.js';
```

(Replace the earlier `import { createBooking } from '../src/services/bookingService.js';` line with this consolidated one.)

Append at the bottom of the file:

```javascript
// --- Case 4: booking lifecycle ---

console.log('[case 4] booking lifecycle');

reset();
const uD = makeUser('coach-test-D@chinup.local', 'D');
const cD = createCoach({ userId: uD, displayName: 'D' });
setCoachActive(cD.id, true);
const [m1, m2] = db.prepare("SELECT id FROM users WHERE role='user' ORDER BY id LIMIT 2").all().map(r => r.id);

const b1 = createBooking({ coachId: cD.id, memberId: m1, startAt: '2099-06-01T10:00:00', note: '想練腿' });
expect('booking created with end_at = +60min', () => assert.equal(b1.endAt, '2099-06-01T11:00:00'));

expect('double-booking same slot rejected', () => {
  assert.throws(() => createBooking({ coachId: cD.id, memberId: m2, startAt: '2099-06-01T10:00:00' }), /slot_taken/);
});

const memberList = listMemberBookings(m1);
expect('listMemberBookings returns the booking', () => {
  assert.equal(memberList.length, 1);
  assert.equal(memberList[0].id, b1.id);
  assert.equal(memberList[0].coach_display_name, 'D');
});

const coachList = listCoachBookings(cD.id);
expect('listCoachBookings returns the booking', () => {
  assert.equal(coachList.length, 1);
  assert.equal(coachList[0].member_name, db.prepare('SELECT name FROM users WHERE id = ?').get(m1).name);
});

cancelBooking({ bookingId: b1.id, actorUserId: m1, isCoach: false });
const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b1.id);
expect('cancelled: status=cancelled, cancelled_by=member, cancelled_at set', () => {
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by, m1);
  assert(row.cancelled_at);
});

expect('cannot cancel an already-cancelled booking', () => {
  assert.throws(() => cancelBooking({ bookingId: b1.id, actorUserId: m1, isCoach: false }), /already_cancelled/);
});

const b2 = createBooking({ coachId: cD.id, memberId: m2, startAt: '2099-06-01T10:00:00' });
expect('slot frees up after cancellation', () => assert(b2.id));

const b3 = createBooking({ coachId: cD.id, memberId: m1, startAt: '2099-06-02T10:00:00' });
expect('member cancelling another member booking fails', () => {
  assert.throws(() => cancelBooking({ bookingId: b3.id, actorUserId: m2, isCoach: false }), /forbidden/);
});

cancelBooking({ bookingId: b3.id, actorUserId: uD, isCoach: true, reason: '臨時生病' });
const b3Row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b3.id);
expect('coach emergency cancel records reason + cancelled_by=coach_user_id', () => {
  assert.equal(b3Row.status, 'cancelled');
  assert.equal(b3Row.cancel_reason, '臨時生病');
  assert.equal(b3Row.cancelled_by, uD);
});

expect('coach cancel requires reason', () => {
  const b4 = createBooking({ coachId: cD.id, memberId: m1, startAt: '2099-06-03T10:00:00' });
  assert.throws(() => cancelBooking({ bookingId: b4.id, actorUserId: uD, isCoach: true }), /missing_reason/);
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
node tests/booking-flow.test.js
```

Expected: `cancelBooking` / `listMemberBookings` / `listCoachBookings` not exported.

- [ ] **Step 3: Flesh out `src/services/bookingService.js`**

Replace the file contents with:

```javascript
import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, note)
  VALUES (?, ?, ?, ?, ?)
`);

const getBookingStmt = db.prepare('SELECT * FROM bookings WHERE id = ?');

const cancelBookingStmt = db.prepare(`
  UPDATE bookings
  SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
  WHERE id = ? AND status = 'confirmed'
`);

const listMemberStmt = db.prepare(`
  SELECT b.*, c.display_name AS coach_display_name, c.id AS coach_id
  FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.member_id = ?
  ORDER BY b.start_at DESC
`);

const listCoachStmt = db.prepare(`
  SELECT b.*, u.name AS member_name, u.email AS member_email
  FROM bookings b
  JOIN users u ON u.id = b.member_id
  WHERE b.coach_id = ?
  ORDER BY b.start_at DESC
`);

const getCoachStmt = db.prepare('SELECT * FROM coaches WHERE id = ?');

export function createBooking({ coachId, memberId, startAt, note = null }) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  const endAt = addMinutes(startAt, 60);
  try {
    const info = insertBookingStmt.run(coachId, memberId, startAt, endAt, note);
    return { id: info.lastInsertRowid, startAt, endAt };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
    throw e;
  }
}

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
    return { ok: true };
  });
}

export function listMemberBookings(memberId) {
  return listMemberStmt.all(memberId);
}

export function listCoachBookings(coachId) {
  return listCoachStmt.all(coachId);
}

function addMinutes(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
node tests/booking-flow.test.js
```

Expected: all ✓ through Case 4.

- [ ] **Step 5: Commit**

```bash
git add src/services/bookingService.js tests/booking-flow.test.js
git commit -m "feat(service): complete bookingService with cancel + listings"
```

---

## Task 7 — Signup with `as_coach` flag

**Files:**
- Modify: `src/services/auth.js`

- [ ] **Step 1: Extend `registerWithPassword` to accept `as_coach`**

In `src/services/auth.js`, replace the existing `registerWithPassword` function with:

```javascript
import { createCoach } from './coachService.js';

export function registerWithPassword({ email, password, name, phone, notification_preference, as_coach = false }) {
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, 'invalid_email');
  if (!password || password.length < 8) throw new ApiError(400, 'password_too_short');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');

  const existing = getUserByEmail.get(email);
  if (existing) throw new ApiError(409, 'email_exists');

  const role = as_coach ? 'coach' : 'user';

  const info = db
    .prepare(
      'INSERT INTO users (name, email, phone, password_hash, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      name.trim(),
      email.toLowerCase(),
      phone || null,
      hashPassword(password),
      role,
      notification_preference || 'email'
    );

  const userId = info.lastInsertRowid;

  if (as_coach) {
    createCoach({ userId, displayName: name.trim() });  // is_active=0; admin must activate
  }

  const user = getUserById.get(userId);
  const session = createSession(user.id);
  return { token: session.token, user: safeUser(user), expiresAt: session.expiresAt, pending_coach: as_coach };
}
```

- [ ] **Step 2: Smoke test via curl**

```bash
PORT=3001 node src/server.js &
sleep 1
curl -s -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"coach-smoke@chinup.local","password":"testpass1234","name":"Smoke 教練","as_coach":true}'
kill %1
```

Expected JSON contains `"role":"coach"` and `"pending_coach":true`. Then check DB:

```bash
sqlite3 data/app.db "SELECT u.role, c.is_active FROM users u LEFT JOIN coaches c ON c.user_id = u.id WHERE u.email = 'coach-smoke@chinup.local'"
```

Expected: `coach|0`. Clean up:

```bash
sqlite3 data/app.db "DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email = 'coach-smoke@chinup.local'); DELETE FROM users WHERE email = 'coach-smoke@chinup.local'"
```

- [ ] **Step 3: Commit**

```bash
git add src/services/auth.js
git commit -m "feat(auth): support as_coach flag on registration (pending until admin activates)"
```

---

## Task 8 — Admin endpoints for coach management

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add admin endpoints**

In `src/server.js`, AFTER the existing `/api/admin/users/:id/role` block (~line 363), insert:

```javascript
// --- One-on-one: admin coach management ---
import {
  createCoach as svcCreateCoach,
  getCoach as svcGetCoach,
  getCoachByUser as svcGetCoachByUser,
  listAllCoaches as svcListAllCoaches,
  setCoachActive as svcSetCoachActive,
  updateCoach as svcUpdateCoach,
} from './services/coachService.js';
```

(Add this import to the top of `src/server.js` alongside the other service imports rather than inline — moving it manually keeps `git blame` clean.)

Then add the routes near the admin section:

```javascript
app.get('/api/admin/coaches', requireAdmin, asyncHandler((req, res) => {
  // Augment with user contact info
  const rows = db.prepare(`
    SELECT c.*, u.name AS user_name, u.email AS user_email
    FROM coaches c JOIN users u ON u.id = c.user_id
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();
  res.json(rows);
}));

app.post('/api/admin/coaches', requireAdmin, asyncHandler((req, res) => {
  // Convert existing user → coach
  const { user_id, display_name, specialty, bio, sort_order } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'missing_user_id' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  if (svcGetCoachByUser(user.id)) return res.status(409).json({ error: 'coach_exists' });

  tx(() => {
    db.prepare("UPDATE users SET role = 'coach' WHERE id = ?").run(user.id);
    svcCreateCoach({
      userId: user.id,
      displayName: display_name || user.name,
      specialty,
      bio,
      sortOrder: sort_order || 0,
    });
  });
  const created = svcGetCoachByUser(user.id);
  res.status(201).json(created);
}));

app.patch('/api/admin/coaches/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const { display_name, specialty, bio, sort_order, is_active } = req.body || {};
  const existing = svcGetCoach(id);
  if (!existing) return res.status(404).json({ error: 'coach_not_found' });
  svcUpdateCoach(id, { displayName: display_name, specialty, bio, sortOrder: sort_order });
  if (typeof is_active === 'boolean' || is_active === 0 || is_active === 1) {
    svcSetCoachActive(id, !!is_active);
  }
  res.json(svcGetCoach(id));
}));

app.delete('/api/admin/coaches/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const coach = svcGetCoach(id);
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });

  // Demote user back to 'user'; keep coaches row (and historical bookings) but deactivate.
  tx(() => {
    svcSetCoachActive(id, false);
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(coach.user_id);
  });
  res.json({ ok: true, demoted_user_id: coach.user_id });
}));
```

- [ ] **Step 2: Manual smoke test via curl**

```bash
PORT=3001 node src/server.js &
sleep 1
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@chinup.local","password":"admin1234"}' | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).token))")
echo "TOKEN=$TOKEN"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/admin/coaches
kill %1
```

Expected: `200` with `[]` (empty list).

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(api): admin endpoints for coach management"
```

---

## Task 9 — Coach self-service endpoints

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add coach endpoints**

In `src/server.js`, after the admin coach routes, add:

```javascript
// --- One-on-one: coach self-service ---
import {
  addRule as svcAddRule,
  listRules as svcListRules,
  deleteRule as svcDeleteRule,
  addException as svcAddException,
  listExceptions as svcListExceptions,
  deleteException as svcDeleteException,
  computeAvailableSlots as svcComputeSlots,
} from './services/availabilityService.js';
import {
  listCoachBookings as svcListCoachBookings,
  cancelBooking as svcCancelBooking,
} from './services/bookingService.js';
```

(Move imports to the top with the others.)

Helper to load coach record for `req.user`:

```javascript
function loadCoachForUser(req, res) {
  const coach = svcGetCoachByUser(req.user.id);
  if (!coach) {
    res.status(404).json({ error: 'coach_record_not_found' });
    return null;
  }
  return coach;
}
```

Routes:

```javascript
app.get('/api/coach/me', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(coach);
}));

app.patch('/api/coach/me/profile', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { display_name, specialty, bio } = req.body || {};
  svcUpdateCoach(coach.id, { displayName: display_name, specialty, bio });
  res.json(svcGetCoach(coach.id));
}));

app.get('/api/coach/me/rules', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(svcListRules(coach.id));
}));

app.post('/api/coach/me/rules', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { day_of_week, start_time, end_time, effective_from, effective_to } = req.body || {};
  const result = svcAddRule({
    coachId: coach.id,
    dayOfWeek: Number(day_of_week),
    startTime: start_time,
    endTime: end_time,
    effectiveFrom: effective_from,
    effectiveTo: effective_to,
  });
  res.status(201).json(result);
}));

app.delete('/api/coach/me/rules/:id', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  svcDeleteRule({ coachId: coach.id, ruleId: Number(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/coach/me/exceptions', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(svcListExceptions(coach.id));
}));

app.post('/api/coach/me/exceptions', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { exception_date, type, start_time, end_time, note } = req.body || {};
  const result = svcAddException({
    coachId: coach.id,
    exceptionDate: exception_date,
    type,
    startTime: start_time,
    endTime: end_time,
    note,
  });
  res.status(201).json(result);
}));

app.delete('/api/coach/me/exceptions/:id', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  svcDeleteException({ coachId: coach.id, exceptionId: Number(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/coach/me/bookings', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(svcListCoachBookings(coach.id));
}));

app.get('/api/coach/me/availability-preview', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to }));
}));
```

- [ ] **Step 2: Boot server and smoke test**

```bash
PORT=3001 node src/server.js &
sleep 1
# Try to access coach endpoint without auth → 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/coach/me
kill %1
```

Expected: `401`.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(api): coach self-service endpoints for rules/exceptions/bookings"
```

---

## Task 10 — Member endpoints (browse + book + cancel)

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add public coach browse + booking endpoints**

In `src/server.js`, after the coach self-service section, insert:

```javascript
// --- One-on-one: public + member endpoints ---
import {
  createBooking as svcCreateBooking,
  listMemberBookings as svcListMemberBookings,
} from './services/bookingService.js';
import { listActiveCoaches as svcListActive } from './services/coachService.js';

app.get('/api/coaches', asyncHandler((req, res) => {
  res.json(svcListActive());
}));

app.get('/api/coaches/:id', asyncHandler((req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach || !coach.is_active) return res.status(404).json({ error: 'coach_not_found' });
  res.json(coach);
}));

app.get('/api/coaches/:id/availability', asyncHandler((req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach || !coach.is_active) return res.status(404).json({ error: 'coach_not_found' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to }));
}));

app.post('/api/bookings', requireUser, asyncHandler((req, res) => {
  const { coach_id, start_at, note } = req.body || {};
  if (!coach_id || !start_at) return res.status(400).json({ error: 'missing_fields' });
  const result = svcCreateBooking({
    coachId: Number(coach_id),
    memberId: req.user.id,
    startAt: start_at,
    note: note || null,
  });
  res.status(201).json(result);
}));

app.delete('/api/bookings/:id', requireUser, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'booking_not_found' });

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(booking.coach_id);
  const actorIsCoach = coach && coach.user_id === req.user.id;
  const { reason } = req.body || {};

  svcCancelBooking({
    bookingId: id,
    actorUserId: req.user.id,
    isCoach: actorIsCoach,
    reason: actorIsCoach ? (reason || null) : null,
  });
  res.json({ ok: true });
}));

app.get('/api/my/bookings', requireUser, asyncHandler((req, res) => {
  res.json(svcListMemberBookings(req.user.id));
}));
```

- [ ] **Step 2: Smoke test the public endpoints**

```bash
PORT=3001 node src/server.js &
sleep 1
curl -s http://localhost:3001/api/coaches    # should be []
kill %1
```

Expected: `[]`.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(api): public coach browse + member booking/cancel endpoints"
```

---

## Task 11 — Avatar upload (base64 JSON) + static serve

**Files:**
- Modify: `src/server.js`
- Modify: `src/services/coachService.js` (add helper)
- Modify: `.gitignore` (ensure `data/avatars/` is ignored if not already)

- [ ] **Step 1: Add `.gitignore` entry**

If `data/` is already ignored you're done. Otherwise append:

```
data/avatars/
```

- [ ] **Step 2: Add the upload helper to `src/services/coachService.js`**

Append:

```javascript
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __serviceDir = dirname(fileURLToPath(import.meta.url));
const AVATAR_DIR = resolve(__serviceDir, '../../data/avatars');
mkdirSync(AVATAR_DIR, { recursive: true });

const MAX_BYTES = 2 * 1024 * 1024;
const MAGIC = {
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
};

function detectKind(buf) {
  if (buf.length >= 4 && buf[0] === MAGIC.png[0] && buf[1] === MAGIC.png[1]) return 'png';
  if (buf.length >= 3 && buf[0] === MAGIC.jpg[0] && buf[1] === MAGIC.jpg[1] && buf[2] === MAGIC.jpg[2]) return 'jpg';
  return null;
}

export function saveAvatar({ coachId, base64 }) {
  if (typeof base64 !== 'string') throw new ApiError(400, 'invalid_avatar');
  const m = base64.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  const payload = m ? m[2] : base64;
  let buf;
  try { buf = Buffer.from(payload, 'base64'); }
  catch { throw new ApiError(400, 'invalid_base64'); }
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new ApiError(413, 'avatar_too_large');
  const kind = detectKind(buf);
  if (!kind) throw new ApiError(400, 'invalid_image_type');

  const filename = `${coachId}-${randomBytes(8).toString('hex')}.${kind}`;
  const fullPath = resolve(AVATAR_DIR, filename);
  writeFileSync(fullPath, buf);

  // Delete old avatar
  const current = getCoachStmt.get(coachId);
  if (current && current.avatar_path) {
    const old = resolve(AVATAR_DIR, current.avatar_path);
    try { if (existsSync(old)) unlinkSync(old); } catch (e) { console.warn('[avatar] failed to delete old', e.message); }
  }

  updateCoach(coachId, { avatarPath: filename });
  return { avatar_path: filename };
}
```

- [ ] **Step 3: Bump global JSON body limit + add static serve + add upload route**

The existing `app.use(express.json())` has Express's default ~100 kb limit, which would reject a 2 MB base64 payload **before** any route-specific middleware runs. Change the existing line in `src/server.js`:

```javascript
app.use(express.json());
```

to:

```javascript
app.use(express.json({ limit: '3mb' }));  // base64-encoded 2 MB avatar fits
```

Near the top of `src/server.js`, after `app.use(express.static(...))`, add:

```javascript
import { saveAvatar as svcSaveAvatar } from './services/coachService.js';
app.use('/avatars', express.static(resolve(__dirname, '../data/avatars'), { maxAge: '7d' }));
```

Then the route:

```javascript
app.post('/api/coach/me/avatar', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { avatar_base64 } = req.body || {};
  const result = svcSaveAvatar({ coachId: coach.id, base64: avatar_base64 });
  res.json(result);
}));
```

- [ ] **Step 4: Smoke test upload**

```bash
mkdir -p data/avatars
# Create a 1x1 png as base64
PNG_B64=$(node -e "console.log(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000158a4ffae0000000049454e44ae426082','hex').toString('base64'))")
PORT=3001 node src/server.js &
sleep 1
# Login as a known coach (assume one already exists from earlier tasks' smoke tests; otherwise skip this step)
kill %1
```

(Full E2E happens in Task 16 — Task 11's manual test is just confirming the route exists & doesn't crash. The detailed `saveAvatar` logic is unit-tested below.)

- [ ] **Step 5: Add a unit test for `saveAvatar`**

Add the new imports to the **top of `tests/booking-flow.test.js`** alongside existing imports (consolidate with the existing `coachService.js` import line):

```javascript
import {
  createCoach, listActiveCoaches, getCoach, updateCoach, setCoachActive, saveAvatar,
} from '../src/services/coachService.js';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __testDir = dirname(fileURLToPath(import.meta.url));
const AVATAR_DIR = resolve(__testDir, '../data/avatars');
```

Append at the bottom of the file:

```javascript
// --- Case 5: avatar save ---

console.log('[case 5] avatar save');

reset();
const uE = makeUser('coach-test-E@chinup.local', 'E');
const cE = createCoach({ userId: uE, displayName: 'E' });

// 1x1 PNG
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000158a4ffae0000000049454e44ae426082', 'hex');
const result = saveAvatar({ coachId: cE.id, base64: png.toString('base64') });
expect('avatar_path returned', () => assert(result.avatar_path.endsWith('.png')));
expect('avatar file exists on disk', () => assert(existsSync(resolve(AVATAR_DIR, result.avatar_path))));

const tooBig = Buffer.alloc(3 * 1024 * 1024).toString('base64');
expect('avatar rejected if too large', () => assert.throws(() => saveAvatar({ coachId: cE.id, base64: tooBig }), /too_large/));

expect('avatar rejected if not png/jpg', () => assert.throws(() => saveAvatar({ coachId: cE.id, base64: Buffer.from('not an image').toString('base64') }), /invalid_image_type/));
```

Run it: `node tests/booking-flow.test.js` — expect all ✓ through Case 5.

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/services/coachService.js tests/booking-flow.test.js .gitignore
git commit -m "feat(api): avatar upload via base64 JSON + static serve from data/avatars"
```

---

## Task 12 — Member-facing pages (`coaches.html`, `coaches.js`, `my-bookings.html`, `my-bookings.js`)

**Files:**
- Create: `public/coaches.html`, `public/coaches.js`, `public/my-bookings.html`, `public/my-bookings.js`
- Modify: `public/index.html` (add 「預約一對一」 button)

This task is UI work, not test-driven. The "test" is a manual smoke check at the end.

- [ ] **Step 1: Create `public/coaches.html`**

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>一對一預約 · CHINUP Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/style.css">
<style>body { visibility: hidden; }</style>
</head>
<body>
<nav class="navbar sticky top-0 z-20">
  <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <a href="/" class="brand-mark"><span class="brand-dot"><img src="/logo.png" alt="logo"></span> CHINUP Performance</a>
    <div id="auth-bar" class="flex items-center gap-3"></div>
  </div>
</nav>

<main class="max-w-6xl mx-auto px-6 py-8">
  <div id="view-list">
    <h1 class="page-title">選擇教練</h1>
    <div id="coach-list" class="grid sm:grid-cols-2 md:grid-cols-3 gap-4"></div>
  </div>

  <div id="view-detail" class="hidden">
    <button id="back-to-list" class="text-sm text-sky-600 mb-3">← 回到教練列表</button>
    <div id="coach-detail"></div>
    <h2 class="section-title mt-6">可預約時段</h2>
    <div id="slot-controls" class="flex items-center gap-3 mb-3"></div>
    <div id="slot-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"></div>
  </div>

  <div id="view-confirm" class="hidden">
    <button id="back-to-detail" class="text-sm text-sky-600 mb-3">← 選別的時段</button>
    <h1 class="page-title">確認預約</h1>
    <div id="confirm-summary" class="card mb-4"></div>
    <label class="block mb-3">
      <span class="text-sm text-slate-600">備註（選填）</span>
      <textarea id="note" class="mt-1 w-full border rounded p-2 text-sm" rows="3" placeholder="例如：想加強核心訓練"></textarea>
    </label>
    <button id="confirm-btn" class="btn-primary w-full">確認預約</button>
  </div>
</main>

<div id="toast" class="toast"></div>
<script type="module" src="/coaches.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/coaches.js`**

```javascript
import { api, fmtDate, dow, toast } from './app.js';

const $ = (id) => document.getElementById(id);
const views = { list: $('view-list'), detail: $('view-detail'), confirm: $('view-confirm') };
function show(name) {
  for (const v of Object.values(views)) v.classList.add('hidden');
  views[name].classList.remove('hidden');
}

let currentCoach = null;
let currentSlot = null;
let weekOffset = 0;

async function loadCoachList() {
  const coaches = await api('/api/coaches');
  const wrap = $('coach-list');
  wrap.innerHTML = '';
  if (coaches.length === 0) {
    wrap.innerHTML = '<p class="text-slate-500">目前沒有可預約的教練</p>';
    return;
  }
  for (const c of coaches) {
    const card = document.createElement('button');
    card.className = 'card flex items-center gap-3 text-left hover:shadow-md transition';
    card.innerHTML = `
      <div class="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center overflow-hidden flex-shrink-0">
        ${c.avatar_path ? `<img src="/avatars/${c.avatar_path}" class="w-full h-full object-cover" alt="">` : '<span class="text-slate-400">👤</span>'}
      </div>
      <div class="min-w-0">
        <div class="font-semibold">${escapeHtml(c.display_name)}</div>
        <div class="text-sm text-slate-500 truncate">${escapeHtml(c.specialty || '')}</div>
      </div>
    `;
    card.addEventListener('click', () => openCoach(c.id));
    wrap.appendChild(card);
  }
}

async function openCoach(id) {
  weekOffset = 0;
  currentCoach = await api(`/api/coaches/${id}`);
  const det = $('coach-detail');
  det.innerHTML = `
    <div class="flex items-center gap-4 mb-3">
      <div class="w-16 h-16 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
        ${currentCoach.avatar_path ? `<img src="/avatars/${currentCoach.avatar_path}" class="w-full h-full object-cover">` : ''}
      </div>
      <div>
        <h1 class="text-xl font-bold">${escapeHtml(currentCoach.display_name)}</h1>
        <div class="text-sm text-slate-500">${escapeHtml(currentCoach.specialty || '')}</div>
      </div>
    </div>
    ${currentCoach.bio ? `<p class="text-sm text-slate-700 whitespace-pre-line">${escapeHtml(currentCoach.bio)}</p>` : ''}
  `;
  show('detail');
  renderSlotControls();
  await loadSlots();
}

function renderSlotControls() {
  const ctrls = $('slot-controls');
  ctrls.innerHTML = `
    <button class="btn-secondary" ${weekOffset <= 0 ? 'disabled' : ''} id="prev-week">← 上週</button>
    <span id="week-label" class="font-medium"></span>
    <button class="btn-secondary" id="next-week">下週 →</button>
  `;
  $('prev-week').addEventListener('click', () => { if (weekOffset > 0) { weekOffset--; loadSlots(); } });
  $('next-week').addEventListener('click', () => { weekOffset++; loadSlots(); });
}

function weekRange(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const f = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: f(start), to: f(end) };
}

async function loadSlots() {
  const { from, to } = weekRange(weekOffset);
  $('week-label').textContent = `${from} ~ ${to}`;
  const slots = await api(`/api/coaches/${currentCoach.id}/availability?from=${from}&to=${to}`);
  const grid = $('slot-grid');
  grid.innerHTML = '';
  if (slots.length === 0) {
    grid.innerHTML = '<p class="col-span-full text-slate-500 text-sm">本週沒有可預約時段</p>';
    return;
  }
  for (const s of slots) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary text-sm';
    const d = new Date(s);
    btn.textContent = `${d.getMonth() + 1}/${d.getDate()}（${dow(d.getDay())[1]}）${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    btn.addEventListener('click', () => openConfirm(s));
    grid.appendChild(btn);
  }
}

function openConfirm(slotStr) {
  currentSlot = slotStr;
  const d = new Date(slotStr);
  $('confirm-summary').innerHTML = `
    <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${escapeHtml(currentCoach.display_name)}</strong></div>
    <div><span class="text-slate-500">時間</span><br><strong>${fmtDate(slotStr)}（60 分鐘）</strong></div>
  `;
  $('note').value = '';
  show('confirm');
}

$('back-to-list').addEventListener('click', () => show('list'));
$('back-to-detail').addEventListener('click', () => show('detail'));

$('confirm-btn').addEventListener('click', async () => {
  try {
    const note = $('note').value.trim();
    const result = await api('/api/bookings', {
      method: 'POST',
      body: { coach_id: currentCoach.id, start_at: currentSlot, note: note || null },
    });
    toast('預約成功！', 'success');
    setTimeout(() => location.href = '/my-bookings.html', 700);
  } catch (e) {
    toast(e.data?.error === 'slot_taken' ? '此時段剛被預約走了' : `預約失敗：${e.message}`, 'error');
  }
});

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

await loadCoachList();
document.body.style.visibility = 'visible';
```

- [ ] **Step 3: Create `public/my-bookings.html`**

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>我的一對一預約 · CHINUP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/style.css">
<style>body { visibility: hidden; }</style>
</head>
<body>
<nav class="navbar sticky top-0 z-20">
  <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <a href="/" class="brand-mark"><span class="brand-dot"><img src="/logo.png" alt="logo"></span> CHINUP Performance</a>
    <div id="auth-bar" class="flex items-center gap-3"></div>
  </div>
</nav>
<main class="max-w-3xl mx-auto px-6 py-8">
  <h1 class="page-title">我的一對一預約</h1>
  <div id="list" class="space-y-3"></div>
</main>
<div id="toast" class="toast"></div>
<script type="module" src="/my-bookings.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create `public/my-bookings.js`**

```javascript
import { api, fmtDate, toast } from './app.js';

async function load() {
  const list = await api('/api/my/bookings');
  const wrap = document.getElementById('list');
  wrap.innerHTML = '';
  if (list.length === 0) {
    wrap.innerHTML = '<p class="text-slate-500">還沒有預約。<a class="text-sky-600" href="/coaches.html">立刻預約 →</a></p>';
    return;
  }
  for (const b of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const cancelled = b.status === 'cancelled';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold">${b.coach_display_name}</div>
          <div class="text-sm text-slate-600">${fmtDate(b.start_at)}（60 分鐘）</div>
          ${b.note ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(b.note)}</div>` : ''}
          ${cancelled ? `<div class="text-sm text-red-500 mt-1">已取消${b.cancel_reason ? `（原因：${escapeHtml(b.cancel_reason)}）` : ''}</div>` : ''}
        </div>
        ${!cancelled && new Date(b.start_at) > new Date() ? `<button data-id="${b.id}" class="btn-secondary text-sm cancel-btn">取消</button>` : ''}
      </div>
    `;
    wrap.appendChild(card);
  }
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定要取消預約？')) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}`, { method: 'DELETE' });
        toast('已取消');
        load();
      } catch (e) {
        toast(`取消失敗：${e.message}`, 'error');
      }
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

await load();
document.body.style.visibility = 'visible';
```

- [ ] **Step 5: Add 「預約一對一」 entry to `public/index.html`**

Find the navbar links section (search for `<a href="/" class="nav-link active">課程</a>`) and add:

```html
<a href="/coaches.html" class="nav-link">一對一預約</a>
<a href="/my-bookings.html" class="nav-link">我的一對一</a>
```

Also add a prominent CTA somewhere on the homepage (insert before the existing course list area):

```html
<a href="/coaches.html" class="block sm:hidden mb-4 btn-primary w-full text-center">🏋️ 預約一對一</a>
```

- [ ] **Step 6: Manual smoke test**

```bash
npm start &
sleep 2
# Open browser to http://localhost:3000 — confirm new links exist
# Login as user1@chinup.local / pass1234
# Click 一對一預約 — should show 「目前沒有可預約的教練」（no coaches seeded yet — Task 15 fixes this）
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add public/coaches.html public/coaches.js public/my-bookings.html public/my-bookings.js public/index.html
git commit -m "feat(ui): member-facing one-on-one booking pages"
```

---

## Task 13 — Coach-facing pages (`coach.html`, `coach.js`)

**Files:**
- Create: `public/coach.html`, `public/coach.js`

A single-page tabbed interface keeps the coach UI compact.

- [ ] **Step 1: Create `public/coach.html`**

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>教練後台 · CHINUP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/style.css">
<style>body { visibility: hidden; }</style>
</head>
<body>
<nav class="navbar sticky top-0 z-20">
  <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <a href="/" class="brand-mark"><span class="brand-dot"><img src="/logo.png" alt="logo"></span> CHINUP Performance</a>
    <div id="auth-bar" class="flex items-center gap-3"></div>
  </div>
</nav>

<main class="max-w-4xl mx-auto px-6 py-8">
  <div id="pending-banner" class="hidden mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900">
    您的教練資料尚未啟用，請聯絡管理員啟用後才會顯示給會員。
  </div>

  <h1 class="page-title">教練後台</h1>

  <div class="flex gap-2 border-b mb-4 overflow-x-auto">
    <button data-tab="bookings" class="tab tab-active">我的預約</button>
    <button data-tab="availability" class="tab">可預約時段</button>
    <button data-tab="profile" class="tab">個人資料</button>
  </div>

  <section id="tab-bookings" class="tab-panel"></section>
  <section id="tab-availability" class="tab-panel hidden"></section>
  <section id="tab-profile" class="tab-panel hidden"></section>
</main>

<div id="toast" class="toast"></div>
<script type="module" src="/coach.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/coach.js`**

```javascript
import { api, fmtDate, dow, toast, getUser } from './app.js';

const $ = (id) => document.getElementById(id);
const DOW_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
let me = null;

async function init() {
  try {
    me = await api('/api/coach/me');
  } catch (e) {
    if (e.status === 404) { location.href = '/'; return; }
    throw e;
  }
  if (!me.is_active) $('pending-banner').classList.remove('hidden');

  // Tab switching
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  await renderBookings();
  document.body.style.visibility = 'visible';
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('tab-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'bookings') renderBookings();
  if (name === 'availability') renderAvailability();
  if (name === 'profile') renderProfile();
}

async function renderBookings() {
  const list = await api('/api/coach/me/bookings');
  const wrap = $('tab-bookings');
  if (list.length === 0) { wrap.innerHTML = '<p class="text-slate-500">沒有預約</p>'; return; }
  wrap.innerHTML = '';
  for (const b of list) {
    const card = document.createElement('div');
    card.className = 'card mb-3';
    const cancelled = b.status === 'cancelled';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold">${escapeHtml(b.member_name)}</div>
          <div class="text-sm text-slate-600">${fmtDate(b.start_at)}</div>
          ${b.note ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(b.note)}</div>` : ''}
          ${cancelled ? `<div class="text-sm text-red-500 mt-1">已取消${b.cancel_reason ? `（${escapeHtml(b.cancel_reason)}）` : ''}</div>` : ''}
        </div>
        ${!cancelled && new Date(b.start_at) > new Date() ? `<button data-id="${b.id}" class="btn-secondary text-sm cancel-btn">緊急取消</button>` : ''}
      </div>
    `;
    wrap.appendChild(card);
  }
  wrap.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const reason = prompt('取消原因（會通知會員）：');
      if (!reason) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}`, { method: 'DELETE', body: { reason } });
        toast('已取消');
        renderBookings();
      } catch (e) {
        toast(`取消失敗：${e.message}`, 'error');
      }
    });
  });
}

async function renderAvailability() {
  const [rules, exceptions] = await Promise.all([
    api('/api/coach/me/rules'),
    api('/api/coach/me/exceptions'),
  ]);

  $('tab-availability').innerHTML = `
    <h2 class="section-title">每週基底班表</h2>
    <div id="rule-list" class="space-y-2 mb-4"></div>
    <details class="card mb-6">
      <summary class="font-semibold cursor-pointer">+ 新增規則</summary>
      <form id="rule-form" class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select name="day_of_week" class="border rounded p-2 text-sm">
          ${DOW_LABELS.map((l, i) => `<option value="${i}">${l}</option>`).join('')}
        </select>
        <input type="time" name="start_time" required class="border rounded p-2 text-sm">
        <input type="time" name="end_time" required class="border rounded p-2 text-sm">
        <button class="btn-primary text-sm">加入</button>
      </form>
    </details>

    <h2 class="section-title">特殊日期（請假 / 加開）</h2>
    <div id="exception-list" class="space-y-2 mb-4"></div>
    <details class="card">
      <summary class="font-semibold cursor-pointer">+ 標記例外</summary>
      <form id="exception-form" class="mt-3 space-y-2">
        <div class="flex gap-2">
          <input type="date" name="exception_date" required class="border rounded p-2 text-sm flex-1">
          <select name="type" class="border rounded p-2 text-sm">
            <option value="leave">請假（整天）</option>
            <option value="extra">加開（指定時段）</option>
          </select>
        </div>
        <div class="flex gap-2 hidden" id="extra-times">
          <input type="time" name="start_time" class="border rounded p-2 text-sm flex-1">
          <input type="time" name="end_time" class="border rounded p-2 text-sm flex-1">
        </div>
        <input type="text" name="note" placeholder="備註（選填）" class="border rounded p-2 text-sm w-full">
        <button class="btn-primary text-sm w-full">加入</button>
      </form>
    </details>
  `;

  const ruleList = $('rule-list');
  if (rules.length === 0) ruleList.innerHTML = '<p class="text-slate-500 text-sm">還沒設定班表</p>';
  for (const r of rules) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between p-2 border rounded';
    row.innerHTML = `<span>${DOW_LABELS[r.day_of_week]} ${r.start_time}–${r.end_time}</span>
      <button data-id="${r.id}" class="text-red-500 text-sm rule-del">刪除</button>`;
    ruleList.appendChild(row);
  }
  ruleList.querySelectorAll('.rule-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/rules/${b.dataset.id}`, { method: 'DELETE' });
    renderAvailability();
  }));

  $('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/coach/me/rules', {
        method: 'POST',
        body: {
          day_of_week: Number(fd.get('day_of_week')),
          start_time: fd.get('start_time'),
          end_time: fd.get('end_time'),
        }
      });
      toast('已加入');
      renderAvailability();
    } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
  });

  const exList = $('exception-list');
  if (exceptions.length === 0) exList.innerHTML = '<p class="text-slate-500 text-sm">沒有特殊日期</p>';
  for (const ex of exceptions) {
    const row = document.createElement('div');
    const tag = ex.type === 'leave' ? '🟡 請假整天' : `🟢 加開 ${ex.start_time}–${ex.end_time}`;
    row.className = 'flex items-center justify-between p-2 border rounded';
    row.innerHTML = `<span>${ex.exception_date} · ${tag}${ex.note ? ` · ${escapeHtml(ex.note)}` : ''}</span>
      <button data-id="${ex.id}" class="text-red-500 text-sm ex-del">刪除</button>`;
    exList.appendChild(row);
  }
  exList.querySelectorAll('.ex-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/exceptions/${b.dataset.id}`, { method: 'DELETE' });
    renderAvailability();
  }));

  $('exception-form').querySelector('[name=type]').addEventListener('change', (e) => {
    $('extra-times').classList.toggle('hidden', e.target.value !== 'extra');
  });
  $('exception-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/coach/me/exceptions', {
        method: 'POST',
        body: {
          exception_date: fd.get('exception_date'),
          type: fd.get('type'),
          start_time: fd.get('start_time') || null,
          end_time: fd.get('end_time') || null,
          note: fd.get('note') || null,
        }
      });
      toast('已加入');
      renderAvailability();
    } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
  });
}

async function renderProfile() {
  $('tab-profile').innerHTML = `
    <form id="profile-form" class="space-y-3 max-w-lg">
      <label class="block">
        <span class="text-sm text-slate-600">顯示名稱</span>
        <input name="display_name" value="${escapeAttr(me.display_name)}" class="mt-1 w-full border rounded p-2 text-sm" required>
      </label>
      <label class="block">
        <span class="text-sm text-slate-600">專長</span>
        <input name="specialty" value="${escapeAttr(me.specialty || '')}" class="mt-1 w-full border rounded p-2 text-sm" placeholder="例：增肌減脂 · 體態雕塑">
      </label>
      <label class="block">
        <span class="text-sm text-slate-600">介紹</span>
        <textarea name="bio" rows="4" class="mt-1 w-full border rounded p-2 text-sm">${escapeHtml(me.bio || '')}</textarea>
      </label>
      <div>
        <span class="text-sm text-slate-600">頭像</span>
        <div class="flex items-center gap-3 mt-1">
          <div class="w-16 h-16 rounded-full bg-slate-200 overflow-hidden">
            ${me.avatar_path ? `<img src="/avatars/${me.avatar_path}" class="w-full h-full object-cover">` : ''}
          </div>
          <input type="file" id="avatar-input" accept="image/png,image/jpeg" class="text-sm">
        </div>
      </div>
      <button class="btn-primary">儲存</button>
    </form>
  `;

  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/coach/me/profile', {
        method: 'PATCH',
        body: {
          display_name: fd.get('display_name'),
          specialty: fd.get('specialty') || null,
          bio: fd.get('bio') || null,
        },
      });
      const file = $('avatar-input').files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) { toast('頭像超過 2MB', 'error'); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          await api('/api/coach/me/avatar', { method: 'POST', body: { avatar_base64: reader.result } });
          toast('已儲存');
          me = await api('/api/coach/me');
          renderProfile();
        };
        reader.readAsDataURL(file);
      } else {
        toast('已儲存');
        me = await api('/api/coach/me');
      }
    } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
  });
}

function escapeHtml(s) { if (s==null) return ''; return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

await init();
```

- [ ] **Step 3: Add `.tab` / `.tab-active` / `.tab-panel` / `.section-title` styles**

Append to `public/style.css`:

```css
.tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #64748b; }
.tab.tab-active { color: #0ea5e9; border-bottom-color: #0ea5e9; font-weight: 600; }
.section-title { font-size: 1.125rem; font-weight: 600; margin: 16px 0 8px; }
```

(Check the existing `style.css` first — if there's already `.card`, `.btn-primary`, `.btn-secondary`, `.page-title` etc. used by other pages, those should already exist. If any are missing, copy the visual treatment from `index.html` or `my.html`.)

- [ ] **Step 4: Add link to `coach.html` in the navbar of all pages where coach might land**

Edit `public/index.html` navbar — add:

```html
<a href="/coach.html" id="coach-link" class="nav-link hidden">教練後台</a>
```

And in `public/app.js`, in the existing init that sets up `auth-bar`, also reveal `#coach-link` when `user.role === 'coach'` or higher.

If `app.js` doesn't expose its init, just always-show the link client-side via inline script:

```html
<script type="module">
import { getUser } from '/app.js';
const u = getUser();
if (u && ['coach','admin','owner'].includes(u.role)) document.getElementById('coach-link')?.classList.remove('hidden');
</script>
```

- [ ] **Step 5: Commit**

```bash
git add public/coach.html public/coach.js public/index.html public/style.css
git commit -m "feat(ui): coach self-service dashboard (bookings/availability/profile)"
```

---

## Task 14 — Admin: add coach management to `admin.html`

**Files:**
- Modify: `public/admin.html`, `public/admin.js`

- [ ] **Step 1: Add a 「教練管理」 section to `public/admin.html`**

Find the section structure used by existing admin features (templates, categories, users). Add a parallel section:

```html
<section id="coach-mgmt" class="admin-section">
  <h2 class="section-title">教練管理</h2>
  <div id="coach-mgmt-list"></div>
  <details class="mt-3">
    <summary class="text-sm cursor-pointer">+ 由現有 user 升級為教練</summary>
    <form id="promote-coach-form" class="mt-2 flex gap-2 items-center">
      <select name="user_id" id="user-to-promote" class="border rounded p-2 text-sm flex-1"></select>
      <button class="btn-primary text-sm">升為教練</button>
    </form>
  </details>
</section>
```

- [ ] **Step 2: Add logic to `public/admin.js`**

Append:

```javascript
async function loadCoachMgmt() {
  const coaches = await api('/api/admin/coaches');
  const users = await api('/api/admin/users');
  const userMap = new Map(users.map(u => [u.id, u]));
  const wrap = document.getElementById('coach-mgmt-list');
  wrap.innerHTML = '';
  if (coaches.length === 0) wrap.innerHTML = '<p class="text-slate-500 text-sm">尚無教練</p>';
  for (const c of coaches) {
    const row = document.createElement('div');
    row.className = 'card flex items-center justify-between gap-3 mb-2';
    row.innerHTML = `
      <div>
        <div class="font-semibold">${c.display_name} <span class="text-xs ${c.is_active ? 'text-green-600' : 'text-amber-600'}">${c.is_active ? '啟用中' : '待啟用'}</span></div>
        <div class="text-xs text-slate-500">${c.user_email} · ${c.specialty || ''}</div>
      </div>
      <div class="flex gap-2">
        <button data-id="${c.id}" data-active="${c.is_active}" class="btn-secondary text-sm toggle-active">${c.is_active ? '停用' : '啟用'}</button>
        <button data-id="${c.id}" class="text-red-500 text-sm demote-btn">降為一般用戶</button>
      </div>
    `;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll('.toggle-active').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/admin/coaches/${b.dataset.id}`, { method: 'PATCH', body: { is_active: b.dataset.active === '0' || b.dataset.active === 'false' ? 1 : 0 } });
    loadCoachMgmt();
  }));
  wrap.querySelectorAll('.demote-btn').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定降為一般用戶？歷史預約會保留，但未來不會出現在會員端')) return;
    await api(`/api/admin/coaches/${b.dataset.id}`, { method: 'DELETE' });
    loadCoachMgmt();
  }));

  const sel = document.getElementById('user-to-promote');
  sel.innerHTML = users
    .filter(u => u.role === 'user')
    .map(u => `<option value="${u.id}">${u.name}（${u.email}）</option>`)
    .join('');
}

document.getElementById('promote-coach-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = Number(new FormData(e.target).get('user_id'));
  try {
    await api('/api/admin/coaches', { method: 'POST', body: { user_id: userId } });
    toast('已升為教練（待設定資料後啟用）');
    loadCoachMgmt();
  } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
});

// Hook into the existing init flow — call loadCoachMgmt() alongside the other admin loaders.
loadCoachMgmt();
```

(The exact integration point depends on existing `admin.js` structure. The `loadCoachMgmt()` call should be placed alongside `loadTemplates()`, `loadUsers()`, etc.)

- [ ] **Step 3: Smoke test**

```bash
npm start &
sleep 2
# In browser: login as admin@chinup.local, go to /admin.html, scroll to "教練管理"
# Verify empty list + dropdown of existing users
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat(ui): admin coach management section"
```

---

## Task 15 — Seed demo data

**Files:**
- Modify: `src/db/seed-demo.js`

- [ ] **Step 1: Append coach + booking demo data**

After the existing seed logic in `src/db/seed-demo.js`, add:

```javascript
import { createCoach, setCoachActive, getCoachByUser } from '../services/coachService.js';
import { addRule, addException } from '../services/availabilityService.js';
import { createBooking } from '../services/bookingService.js';
import { hashPassword } from '../services/auth.js';

// --- Coach: create demo coach user ---
const coachEmail = 'coach1@chinup.local';
let coachUser = db.prepare('SELECT * FROM users WHERE email = ?').get(coachEmail);
if (!coachUser) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role, notification_preference) VALUES (?, ?, ?, 'coach', 'email')"
  ).run('王教練', coachEmail, hashPassword('coachpass1234'));
  coachUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  console.log(`[seed] created coach user ${coachEmail} / coachpass1234`);
}

let coach = getCoachByUser(coachUser.id);
if (!coach) {
  const c = createCoach({
    userId: coachUser.id,
    displayName: '王教練',
    specialty: '增肌減脂 · 體態雕塑',
    bio: '10 年訓練資歷，國立體大畢業，CSCS 認證。\n專長：肌力訓練、運動表現、體態雕塑。',
    sortOrder: 10,
  });
  setCoachActive(c.id, true);
  coach = getCoachByUser(coachUser.id);
}

// Add rules if empty
if (db.prepare('SELECT COUNT(*) AS c FROM coach_availability_rules WHERE coach_id = ?').get(coach.id).c === 0) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`;
  for (const dow of [1, 3, 5]) {
    addRule({ coachId: coach.id, dayOfWeek: dow, startTime: '09:00', endTime: '12:00', effectiveFrom: from });
    addRule({ coachId: coach.id, dayOfWeek: dow, startTime: '14:00', endTime: '17:00', effectiveFrom: from });
  }
  // Add one leave exception for a future Tuesday
  const futureTue = new Date(today.getTime() + 14 * 86400_000);
  while (futureTue.getDay() !== 2) futureTue.setDate(futureTue.getDate() + 1);
  const tueStr = `${futureTue.getFullYear()}-${pad(futureTue.getMonth() + 1)}-${pad(futureTue.getDate())}`;
  // Tuesday isn't in the base rules anyway, so use a Monday to make the leave visible
  const futureMon = new Date(today.getTime() + 7 * 86400_000);
  while (futureMon.getDay() !== 1) futureMon.setDate(futureMon.getDate() + 1);
  const monStr = `${futureMon.getFullYear()}-${pad(futureMon.getMonth() + 1)}-${pad(futureMon.getDate())}`;
  addException({ coachId: coach.id, exceptionDate: monStr, type: 'leave', note: '個人事務' });

  // One demo booking 2 weeks out on a Wednesday at 10:00
  const futureWed = new Date(today.getTime() + 14 * 86400_000);
  while (futureWed.getDay() !== 3) futureWed.setDate(futureWed.getDate() + 1);
  const wedStr = `${futureWed.getFullYear()}-${pad(futureWed.getMonth() + 1)}-${pad(futureWed.getDate())}T10:00:00`;
  const memberId = db.prepare("SELECT id FROM users WHERE email = 'user1@chinup.local'").get()?.id;
  if (memberId) {
    try { createBooking({ coachId: coach.id, memberId, startAt: wedStr, note: '想練腿' }); } catch {}
  }
  console.log(`[seed] coach #${coach.id} rules + exception + demo booking ready`);
}
```

- [ ] **Step 2: Re-seed and verify**

```bash
rm -f data/app.db
npm run migrate
node src/db/seed-demo.js
sqlite3 data/app.db "SELECT * FROM coaches; SELECT COUNT(*) FROM coach_availability_rules; SELECT * FROM bookings"
```

Expected: 1 coach (王教練, is_active=1), 6 rules, 1 booking.

- [ ] **Step 3: Commit**

```bash
git add src/db/seed-demo.js
git commit -m "chore(seed): add demo coach + rules + booking"
```

---

## Task 16 — API integration tests

**Files:**
- Create: `tests/booking-api.test.js`

- [ ] **Step 1: Create the API test file**

```javascript
// HTTP API 整合測試 — 一對一預約
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function loginAs(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[booking-api test] start');

const ownerAuth = await loginAs('admin@chinup.local', 'admin1234');
const member1 = await loginAs('user1@chinup.local', 'pass1234');
const member2 = await loginAs('user2@chinup.local', 'pass1234');

// --- 1. Self-signup as coach ---
console.log('[1] self-signup as coach');
const signupEmail = `test-coach-${Date.now()}@chinup.local`;
const signup = await req('POST', '/api/auth/register', {
  body: { email: signupEmail, password: 'testpass1234', name: 'Test 教練', as_coach: true },
});
expect('201 created', () => assert.equal(signup.status, 201));
expect('user.role = coach', () => assert.equal(signup.data.user.role, 'coach'));
expect('pending_coach = true', () => assert.equal(signup.data.pending_coach, true));
const coachToken = signup.data.token;

// --- 2. Coach is invisible to members until activated ---
console.log('[2] pending coach hidden from public');
const publicList1 = await req('GET', '/api/coaches');
expect('200 ok', () => assert.equal(publicList1.status, 200));
const pendingCoachInList = (publicList1.data || []).find(c => c.display_name === 'Test 教練');
expect('pending coach not in public list', () => assert.equal(pendingCoachInList, undefined));

// --- 3. Coach without active record can hit /api/coach/me ---
const meRes = await req('GET', '/api/coach/me', { token: coachToken });
expect('coach can fetch self', () => assert.equal(meRes.status, 200));
expect('is_active=0 before activation', () => assert.equal(meRes.data.is_active, 0));
const coachId = meRes.data.id;

// --- 4. Admin activates ---
console.log('[4] admin activates');
const activate = await req('PATCH', `/api/admin/coaches/${coachId}`, {
  token: ownerAuth.token,
  body: { is_active: true, specialty: '測試專長' },
});
expect('200 ok', () => assert.equal(activate.status, 200));
expect('is_active=1 after PATCH', () => assert.equal(activate.data.is_active, 1));

// --- 5. Coach now appears publicly ---
const publicList2 = await req('GET', '/api/coaches');
expect('active coach in public list', () => assert(publicList2.data.find(c => c.id === coachId)));

// --- 6. Coach sets availability ---
console.log('[6] coach sets rules');
const today = new Date();
const dow = (today.getDay() + 2) % 7;  // pick a day not today to avoid past-slot edge case
const ruleResp = await req('POST', '/api/coach/me/rules', {
  token: coachToken,
  body: { day_of_week: dow, start_time: '09:00', end_time: '12:00', effective_from: '2000-01-01' },
});
expect('rule 201', () => assert.equal(ruleResp.status, 201));

// --- 7. Member fetches availability ---
console.log('[7] member fetches availability');
const pad = (n) => String(n).padStart(2, '0');
const target = new Date(today);
while (target.getDay() !== dow) target.setDate(target.getDate() + 1);
const dateStr = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
const slotsRes = await req('GET', `/api/coaches/${coachId}/availability?from=${dateStr}&to=${dateStr}`, { token: member1.token });
expect('200 ok', () => assert.equal(slotsRes.status, 200));
expect('has 3 slots', () => assert.equal(slotsRes.data.length, 3));

// --- 8. Member books a slot ---
const slotToBook = slotsRes.data[0];
const book = await req('POST', '/api/bookings', { token: member1.token, body: { coach_id: coachId, start_at: slotToBook } });
expect('book 201', () => assert.equal(book.status, 201));
const bookingId = book.data.id;

// --- 9. Booked slot disappears from availability ---
const slotsRes2 = await req('GET', `/api/coaches/${coachId}/availability?from=${dateStr}&to=${dateStr}`, { token: member1.token });
expect('one fewer slot after booking', () => assert.equal(slotsRes2.data.length, 2));

// --- 10. Double-book rejected ---
const double = await req('POST', '/api/bookings', { token: member2.token, body: { coach_id: coachId, start_at: slotToBook } });
expect('double-book 409', () => assert.equal(double.status, 409));
expect('error=slot_taken', () => assert.equal(double.data.error, 'slot_taken'));

// --- 11. Member cancels their booking ---
const cancel = await req('DELETE', `/api/bookings/${bookingId}`, { token: member1.token });
expect('cancel 200', () => assert.equal(cancel.status, 200));

// --- 12. Cancelled slot is bookable again ---
const slotsRes3 = await req('GET', `/api/coaches/${coachId}/availability?from=${dateStr}&to=${dateStr}`, { token: member1.token });
expect('slot back after cancel', () => assert.equal(slotsRes3.data.length, 3));

// --- 13. Member cannot cancel another member's booking ---
const book2 = await req('POST', '/api/bookings', { token: member1.token, body: { coach_id: coachId, start_at: slotToBook } });
const forbidden = await req('DELETE', `/api/bookings/${book2.data.id}`, { token: member2.token });
expect('cross-member cancel 403', () => assert.equal(forbidden.status, 403));

// --- 14. Coach emergency cancel requires reason ---
const cancelNoReason = await req('DELETE', `/api/bookings/${book2.data.id}`, { token: coachToken });
expect('coach cancel without reason 400', () => assert.equal(cancelNoReason.status, 400));

const cancelWithReason = await req('DELETE', `/api/bookings/${book2.data.id}`, { token: coachToken, body: { reason: '臨時生病' } });
expect('coach cancel with reason 200', () => assert.equal(cancelWithReason.status, 200));

// --- 15. Coach role required for /api/coach/me ---
const memberCallsCoach = await req('GET', '/api/coach/me', { token: member1.token });
expect('member -> /api/coach/me = 403', () => assert.equal(memberCallsCoach.status, 403));

// --- 16. Non-admin cannot manage coaches ---
const memberAdmin = await req('GET', '/api/admin/coaches', { token: member1.token });
expect('member -> /api/admin/coaches = 403', () => assert.equal(memberAdmin.status, 403));

console.log('[booking-api test] done');
```

- [ ] **Step 2: Run against a running server**

```bash
# In one terminal:
npm start
# In another:
node tests/booking-api.test.js
```

Expected: all ✓.

If any test fails: read the failing case, look at the corresponding service/route, fix the bug, re-run.

- [ ] **Step 3: Update `package.json` test scripts**

In `package.json` `scripts`:

```json
"test:flow": "node tests/flow.test.js && node tests/booking-flow.test.js",
"test:api": "node tests/api.test.js && node tests/booking-api.test.js"
```

- [ ] **Step 4: Verify the existing chinup tests still pass**

```bash
node tests/flow.test.js
# In another terminal (server running): node tests/api.test.js
```

Expected: all ✓ — no regression in group class flow.

- [ ] **Step 5: Commit**

```bash
git add tests/booking-api.test.js package.json
git commit -m "test(api): end-to-end one-on-one booking integration tests"
```

---

## Task 17 — README + manual mobile smoke test

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run a manual mobile-viewport smoke test**

```bash
npm start
```

In Chrome devtools (Cmd-Opt-I), toggle device toolbar (Cmd-Shift-M), pick iPhone 14 Pro. Walk through:

1. Sign up a new account at `/login.html` with the 「我是教練」 toggle on → confirm pending banner appears on `/coach.html`
2. Login as `admin@chinup.local` / `admin1234` → `/admin.html` → activate the new coach
3. Login as the new coach → set 2 weekly rules + 1 leave exception → confirm preview
4. Login as `user1@chinup.local` / `pass1234` → `/coaches.html` → pick the new coach → book a slot
5. Both sides (`/my-bookings.html` for member, `/coach.html` bookings tab for coach) should see the booking
6. Member cancels → confirm booking disappears, slot reopens

All steps must render correctly at 390 px viewport width (no horizontal scroll, buttons tappable).

- [ ] **Step 2: Add 「一對一預約模組」 section to `README.md`**

Insert after the existing 「功能特色」 section:

```markdown
## 一對一預約模組（Phase 1）

教練自助管理班表 + 會員瀏覽教練線上預約。

### 新角色：coach

- 介於 `admin` 和 `user` 之間
- 自助登入後可改 profile、設可預約時段、看自己的預約、緊急取消
- 不能管其他教練或會員（限 admin 以上）

### 功能流程

1. 註冊時勾選「我是教練」→ 帳號為 coach，待 admin 啟用
2. Admin 在 `/admin.html` → 「教練管理」啟用、或把現有 user 升為教練
3. 教練在 `/coach.html` 設可預約時段（每週基底 + 例外覆寫）
4. 會員在 `/coaches.html` 瀏覽教練 → 點開詳細 → 選 60 分鐘時段 → 預約
5. 會員 / 教練在 `/my-bookings.html` / `/coach.html` 看到預約並可取消

### 設定預設值（Phase 1 寫死於程式碼）

| 設定 | 值 |
|---|---|
| Slot 長度 | 60 分鐘 |
| Buffer | 預約時不能選 < 2 小時後的時段 |
| Window | 預約只能往後 30 天 |
| 點數 | Phase 1 不接，Phase 2 再加 |
| 取消 | 隨時可取消，policy 是無條件退點（Phase 1 純取消，無退點動作） |

### 設計 / 計畫文件

- `docs/superpowers/specs/2026-05-11-one-on-one-booking-design.md`
- `docs/superpowers/plans/2026-05-11-one-on-one-booking.md`
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add one-on-one booking module section to README"
```

---

## Spec Coverage Check

| Spec section | Covered by task |
|---|---|
| §1 Goal | Task 17 (README) |
| §2 Scope (in) — coach role | Task 2, 7 |
| §2 Scope (in) — coach profile | Task 3, 9, 11, 13 |
| §2 Scope (in) — availability | Task 4, 5, 9, 13 |
| §2 Scope (in) — booking flow | Task 6, 10, 12 |
| §2 Scope (in) — coach self-service | Task 9, 13 |
| §2 Scope (in) — admin coach mgmt | Task 8, 14 |
| §2 Scope (in) — responsive UI | Task 12, 13 |
| §2 Scope (in) — notification log reuse | (See note below) |
| §3 Decisions Summary | All tasks |
| §4 User Roles | Task 2 |
| §5 Data Model (4 tables) | Task 1 |
| §6 Slot Computation | Task 5 |
| §7.1 Member booking | Task 10, 12 |
| §7.2 Coach availability mgmt | Task 9, 13 |
| §7.3 Cancellation | Task 6, 10, 12, 13 |
| §8 Page & route inventory | Task 8–14 |
| §9 Signup / onboarding | Task 7, 8 |
| §10 Notifications | (See note below) |
| §11 Testing | Task 3–6 (flow), Task 16 (api) |
| §12 Schema | Task 1 |
| §13 Risks | Mitigated across tasks (concurrency: Task 1 unique index; time zone: alignment to local convention) |
| §14 Definition of Done | Task 16, 17 (manual smoke test) |

**Note on §10 Notifications:** Spec calls for writing entries to the `notifications` table on book / cancel events. The existing `src/services/notifications.js` has a `notify({ userId, sessionId, type, vars })` signature centered on `course_sessions`. For Phase 1, **skip the notify call inside `bookingService.js`** to avoid an FK constraint failure (notifications.session_id references course_sessions). Track this as a follow-up: extend the `notifications` table with a nullable `booking_id` column + a generic notify path. This deviation is acceptable for Phase 1 because the existing notification system is itself a log-only stub. Document this in the README "限制" section if added.
