# Phase 3A · Unified /my-schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two separate "我的" pages (`my.html` for group registrations, `my-bookings.html` for one-on-one bookings) into a single timeline + tab-filtered `/my-schedule` page backed by a new unified `GET /api/my/schedule` endpoint.

**Architecture:** Add new service module (`myScheduleService.js`) that joins bookings + registrations into a uniform shape with `kind: 'booking'|'registration'`, `is_past`, and `can_cancel` precomputed. Expose via new endpoint. Replace two static HTML pages with one. Old URLs 301-redirect to `/my-schedule`. No schema change. Old `/api/my/bookings` + `/api/my/registrations` endpoints are kept (tests still depend on them; zero-cost retention).

**Tech Stack:** Node 24 ESM + Express + `node:sqlite` + Vanilla JS + Tailwind CDN. Tests use chinup's `expect(label, fn)` harness — `*-flow.test.js` for direct service calls, `*-api.test.js` for HTTP integration against `localhost:3000`.

**Spec reference:** `docs/superpowers/specs/2026-05-12-my-schedule-design.md`

**Branch:** `feature/my-schedule` (already checked out)

**Review pattern:** Per user preference for mechanical work (small, self-evident diffs), tasks 4 and 5 are simple enough to accept implementer reports directly without per-task spec/quality review subagents. Tasks 1, 2, 3 are non-trivial and get full review. Always run a final holistic review after task 5.

---

## File Structure

**New files (4):**
| Path | Responsibility |
|---|---|
| `src/services/myScheduleService.js` | `listMySchedule({ userId })` — joins bookings + registrations into unified items |
| `public/my-schedule.html` | Page skeleton (navbar + hero + tab bar + lists + empty states) |
| `public/my-schedule.js` | Fetch → render → tab switch → past-toggle → cancel handler |
| `tests/my-schedule-service.test.js` | Service-level flow tests (direct call) |
| `tests/my-schedule-api.test.js` | HTTP integration tests for `GET /api/my/schedule` |
| `tests/my-schedule-routing.test.js` | HTTP tests for 301 redirects + `/my-schedule` 200 |

**Modified files (5):**
| Path | What changes |
|---|---|
| `src/server.js` | Insert 3 routes before `express.static` (line 58); insert 1 endpoint near other `/api/my/*` handlers |
| `public/index.html` | Navbar: replace `/my.html` + `/my-bookings.html` links with single `/my-schedule` link |
| `public/admin.html` | Navbar: replace `/my.html` link with `/my-schedule` |
| `public/coaches.js` | Line 159 redirect target: `/my-bookings.html` → `/my-schedule` |
| `public/courses.js` | Two comments referencing `my.html` |

**Deleted files (3):**
| Path | Reason |
|---|---|
| `public/my.html` | Replaced by `/my-schedule` |
| `public/my-bookings.html` | Replaced by `/my-schedule` |
| `public/my-bookings.js` | Module for deleted page |

---

## Pre-flight check

- [ ] **Step 0a: Confirm branch**

Run: `git branch --show-current`
Expected: `feature/my-schedule`

- [ ] **Step 0b: Confirm clean working tree**

Run: `git status --porcelain`
Expected: empty output (no uncommitted changes from prior work). If `package-lock.json` shows modified, that's pre-existing and OK.

---

## Task 1: Backend service module `listMySchedule`

**Files:**
- Create: `src/services/myScheduleService.js`
- Test: `tests/my-schedule-service.test.js`

This task is **direct-service-call flow-style tests**. No HTTP server needed.

- [ ] **Step 1.1: Write the failing test**

Create `tests/my-schedule-service.test.js`:

```javascript
// Phase 3A · myScheduleService 流程驗證
import assert from 'node:assert/strict';
import { db, nowLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach } from '../src/services/coachService.js';
import { createBooking, cancelBooking } from '../src/services/bookingService.js';
import { createTemplate } from '../src/services/courseService.js';
import { register, cancelRegistration } from '../src/services/registration.js';
import { adminGrant } from '../src/services/pointService.js';
import { listMySchedule } from '../src/services/myScheduleService.js';

function reset() {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM point_transactions;
    DELETE FROM bookings;
    DELETE FROM registrations;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM coach_availability_exceptions;
    DELETE FROM coach_availability_rules;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'my-sched-test-%';
  `);
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

function createMember(name, email) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')"
  ).run(name, email, hashPassword('pass1234'));
  return info.lastInsertRowid;
}

function createAdmin() {
  let existing = db.prepare("SELECT id FROM users WHERE role = 'owner'").get();
  if (existing) return existing.id;
  existing = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  if (existing) return existing.id;
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')"
  ).run('Admin', 'my-sched-test-admin@chinup.local', hashPassword('pass1234'));
  return info.lastInsertRowid;
}

function createCoachFor(name, email) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'coach')"
  ).run(name, email, hashPassword('pass1234'));
  return createCoach({ userId: info.lastInsertRowid, displayName: name });
}

function futureLocal(daysAhead, hh = 10, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hh)}:${pad(mm)}:00`;
}

console.log('[my-schedule-service test] start');
reset();

const adminId = createAdmin();
const memberA = createMember('Member A', 'my-sched-test-a@chinup.local');
const memberB = createMember('Member B', 'my-sched-test-b@chinup.local');
const coach = createCoachFor('Test Coach', 'my-sched-test-coach@chinup.local');

// Seed: Member A has 1 future booking + 1 past booking (manually inserted past)
adminGrant({ memberId: memberA, pool: 'one_on_one', amount: 10, note: 'seed', adminId });
adminGrant({ memberId: memberA, pool: 'group', amount: 10, note: 'seed', adminId });

const futureBookingStart = futureLocal(7, 10, 0);
createBooking({ coachId: coach.id, memberId: memberA, startAt: futureBookingStart, note: 'future booking' });

// Inject a past booking directly via SQL (bookingService doesn't allow past)
const pastBookingStart = '2024-01-01T10:00:00';
const pastBookingEnd   = '2024-01-01T11:00:00';
db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, note) VALUES (?, ?, ?, ?, 'confirmed', 'past booking')"
).run(coach.id, memberA, pastBookingStart, pastBookingEnd);

// Empty user
console.log('[1] empty user');
const emptyItems = listMySchedule({ userId: memberB });
expect('returns array', () => assert(Array.isArray(emptyItems)));
expect('empty for new user', () => assert.equal(emptyItems.length, 0));

// Booking shape + flags
console.log('[2] booking shape');
const aItems = listMySchedule({ userId: memberA });
expect('2 items total', () => assert.equal(aItems.length, 2));
expect('sorted DESC by start_at', () => assert(aItems[0].start_at > aItems[1].start_at));

const future = aItems.find(x => x.note === 'future booking');
const past   = aItems.find(x => x.note === 'past booking');
expect('future kind=booking', () => assert.equal(future.kind, 'booking'));
expect('future is_past=false', () => assert.equal(future.is_past, false));
expect('future can_cancel=true', () => assert.equal(future.can_cancel, true));
expect('future coach_display_name', () => assert.equal(future.coach_display_name, 'Test Coach'));
expect('future session_id=null', () => assert.equal(future.session_id, null));
expect('future course_name=null', () => assert.equal(future.course_name, null));
expect('past is_past=true', () => assert.equal(past.is_past, true));
expect('past can_cancel=false', () => assert.equal(past.can_cancel, false));

// Cancelled booking can_cancel=false
console.log('[3] cancelled booking');
cancelBooking({ bookingId: future.id, actorId: memberA, reason: 'test' });
const afterCancel = listMySchedule({ userId: memberA }).find(x => x.id === future.id);
expect('cancelled kind=booking', () => assert.equal(afterCancel.kind, 'booking'));
expect('cancelled status=cancelled', () => assert.equal(afterCancel.status, 'cancelled'));
expect('cancelled can_cancel=false', () => assert.equal(afterCancel.can_cancel, false));

// Registration shape
console.log('[4] registration shape');
const tpl = createTemplate({
  name: 'Test Class',
  min_capacity: 1, max_capacity: 5,
  day_of_week: ((new Date()).getDay() + 3) % 7,
  start_time: '19:00', duration_minutes: 60,
  recurrence: 'weekly',
  cycle_start_date: futureLocal(1).slice(0, 10),
  cycle_end_date:   futureLocal(60).slice(0, 10),
  registration_deadline_hours: 24,
});
const session = db.prepare(
  'SELECT id, start_at FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC LIMIT 1'
).get(tpl.templateId);
register({ sessionId: session.id, userId: memberA });

const afterReg = listMySchedule({ userId: memberA });
const reg = afterReg.find(x => x.kind === 'registration');
expect('registration present', () => assert(reg));
expect('reg course_name', () => assert.equal(reg.course_name, 'Test Class'));
expect('reg session_status=open', () => assert.equal(reg.session_status, 'open'));
expect('reg duration_minutes=60', () => assert.equal(reg.duration_minutes, 60));
expect('reg can_cancel=true', () => assert.equal(reg.can_cancel, true));
expect('reg coach_id=null', () => assert.equal(reg.coach_id, null));
expect('reg note=null', () => assert.equal(reg.note, null));

// Cross-user isolation
console.log('[5] cross-user isolation');
const bItems = listMySchedule({ userId: memberB });
expect('member B sees nothing of A', () => assert.equal(bItems.length, 0));

console.log('[my-schedule-service test] done');
```

- [ ] **Step 1.2: Run test, verify it fails**

Run: `node tests/my-schedule-service.test.js`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...src/services/myScheduleService.js'`

- [ ] **Step 1.3: Implement the service**

Create `src/services/myScheduleService.js`:

```javascript
import { db, nowLocal } from '../db/connection.js';

const BOOKINGS_SQL = `
  SELECT b.id, b.start_at, b.end_at, b.status, b.note, b.cancel_reason,
         b.coach_id, c.display_name AS coach_display_name
  FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.member_id = ?
  ORDER BY b.start_at DESC
`;

const REGISTRATIONS_SQL = `
  SELECT r.id, r.status, r.position,
         s.id AS session_id, s.start_at, s.end_at, s.status AS session_status,
         t.name AS course_name, t.duration_minutes
  FROM registrations r
  JOIN course_sessions s ON s.id = r.session_id
  JOIN course_templates t ON t.id = s.template_id
  WHERE r.user_id = ?
  ORDER BY s.start_at DESC
`;

function mapBooking(b, now) {
  return {
    kind: 'booking',
    id: b.id,
    start_at: b.start_at,
    end_at: b.end_at,
    status: b.status,
    is_past: b.start_at < now,
    can_cancel: b.status === 'confirmed' && b.start_at > now,
    coach_id: b.coach_id,
    coach_display_name: b.coach_display_name,
    note: b.note,
    cancel_reason: b.cancel_reason,
    session_id: null,
    course_name: null,
    session_status: null,
    duration_minutes: null,
    position: null,
  };
}

function mapRegistration(r, now) {
  return {
    kind: 'registration',
    id: r.id,
    start_at: r.start_at,
    end_at: r.end_at,
    status: r.status,
    is_past: r.start_at < now,
    can_cancel: ['confirmed', 'waitlisted'].includes(r.status) && r.session_status === 'open',
    coach_id: null,
    coach_display_name: null,
    note: null,
    cancel_reason: null,
    session_id: r.session_id,
    course_name: r.course_name,
    session_status: r.session_status,
    duration_minutes: r.duration_minutes,
    position: r.position,
  };
}

export function listMySchedule({ userId }) {
  const now = nowLocal();
  const bookings = db.prepare(BOOKINGS_SQL).all(userId);
  const registrations = db.prepare(REGISTRATIONS_SQL).all(userId);

  const items = [
    ...bookings.map(b => mapBooking(b, now)),
    ...registrations.map(r => mapRegistration(r, now)),
  ];
  items.sort((a, b) => b.start_at.localeCompare(a.start_at));
  return items;
}
```

- [ ] **Step 1.4: Run test, verify it passes**

Run: `node tests/my-schedule-service.test.js`
Expected: all `✓` lines, `[my-schedule-service test] done`, exit code 0.

- [ ] **Step 1.5: Commit**

```bash
git add src/services/myScheduleService.js tests/my-schedule-service.test.js
git commit -m "feat(service): add myScheduleService.listMySchedule (Phase 3A)

Joins bookings + registrations into a unified item array with kind,
is_past, and can_cancel precomputed for the upcoming /my-schedule UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: API endpoint `GET /api/my/schedule`

**Files:**
- Modify: `src/server.js` (add endpoint near other `/api/my/*` handlers, near line 658 where `/api/my/bookings` is defined)
- Test: `tests/my-schedule-api.test.js`

This task uses **HTTP integration tests** against a running server. Tests assume seed-demo data exists (run `node src/db/migrate.js && node src/db/seed-demo.js` then `npm start` if not already running).

- [ ] **Step 2.1: Write the failing test**

Create `tests/my-schedule-api.test.js`:

```javascript
// HTTP API 整合測試 — Phase 3A unified /my-schedule
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
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

console.log('[my-schedule-api test] start');

// 1. 401 when unauthenticated
const noAuth = await req('GET', '/api/my/schedule');
expect('401 without token', () => assert.equal(noAuth.status, 401));
expect('error=unauthenticated', () => assert.equal(noAuth.data.error, 'unauthenticated'));

// 2. Existing seed user — user1@chinup.local should have at least 1 booking from seed-demo
const user1 = await loginAs('user1@chinup.local', 'pass1234');
const resp1 = await req('GET', '/api/my/schedule', { token: user1.token });
expect('200 OK', () => assert.equal(resp1.status, 200));
expect('items is array', () => assert(Array.isArray(resp1.data.items)));
expect('user1 has >= 1 item', () => assert(resp1.data.items.length >= 1));

const item = resp1.data.items[0];
expect('item has kind', () => assert(['booking', 'registration'].includes(item.kind)));
expect('item has start_at', () => assert(typeof item.start_at === 'string' && item.start_at.length >= 19));
expect('item has is_past boolean', () => assert.equal(typeof item.is_past, 'boolean'));
expect('item has can_cancel boolean', () => assert.equal(typeof item.can_cancel, 'boolean'));

// 3. Sorted DESC by start_at
if (resp1.data.items.length >= 2) {
  const a = resp1.data.items[0].start_at;
  const b = resp1.data.items[1].start_at;
  expect('sorted DESC', () => assert(a >= b));
}

// 4. user2 — has group registrations from seed-demo, no 1-on-1 booking
const user2 = await loginAs('user2@chinup.local', 'pass1234');
const resp2 = await req('GET', '/api/my/schedule', { token: user2.token });
expect('user2 200', () => assert.equal(resp2.status, 200));
const hasReg = resp2.data.items.some(x => x.kind === 'registration');
expect('user2 has at least 1 registration', () => assert(hasReg));

// 5. User isolation — user2 should not see user1's booking
const user1BookingsForU2 = resp2.data.items.filter(x =>
  x.kind === 'booking' && x.coach_display_name === '王教練'
);
// (user1 booked 王教練 in seed-demo; user2 should not see it)
expect('user2 cannot see user1 booking', () => assert.equal(user1BookingsForU2.length, 0));

// 6. Booking item shape — registration-only fields null
const bookingItem = resp1.data.items.find(x => x.kind === 'booking');
if (bookingItem) {
  expect('booking session_id=null', () => assert.equal(bookingItem.session_id, null));
  expect('booking course_name=null', () => assert.equal(bookingItem.course_name, null));
  expect('booking coach_display_name truthy', () => assert(bookingItem.coach_display_name));
}

// 7. Registration item shape — booking-only fields null
const regItem = resp2.data.items.find(x => x.kind === 'registration');
if (regItem) {
  expect('reg coach_id=null', () => assert.equal(regItem.coach_id, null));
  expect('reg note=null', () => assert.equal(regItem.note, null));
  expect('reg course_name truthy', () => assert(regItem.course_name));
}

console.log('[my-schedule-api test] done');
```

- [ ] **Step 2.2: Run test, verify it fails**

If the server isn't already running, start it: `npm start` (in a separate terminal).

Run: `node tests/my-schedule-api.test.js`
Expected: `401 without token` passes, then 404 or test failures on `200 OK` because endpoint is not yet defined. Some `✗` lines appear, exit code 1.

- [ ] **Step 2.3: Add the endpoint to server.js**

In `src/server.js`, add to the imports block (with other service imports, near the existing `getBalances as svcGetBalances` etc.):

```javascript
import { listMySchedule as svcListMySchedule } from './services/myScheduleService.js';
```

Then add the endpoint near the existing `/api/my/bookings` route (around line 658). Insert immediately AFTER the `/api/my/bookings` handler:

```javascript
app.get('/api/my/schedule', requireUser, asyncHandler((req, res) => {
  const items = svcListMySchedule({ userId: req.user.id });
  res.json({ items });
}));
```

- [ ] **Step 2.4: Restart the server**

Stop the running `npm start` process (Ctrl+C in its terminal) and re-run `npm start` so the new route is loaded.

- [ ] **Step 2.5: Run test, verify it passes**

Run: `node tests/my-schedule-api.test.js`
Expected: all `✓` lines, `[my-schedule-api test] done`, exit code 0.

- [ ] **Step 2.6: Commit**

```bash
git add src/server.js tests/my-schedule-api.test.js
git commit -m "feat(api): add GET /api/my/schedule unified endpoint (Phase 3A)

Returns booking + registration items in a unified shape sorted by
start_at DESC. Auth required; 401 on missing token.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend `/my-schedule` page

**Files:**
- Create: `public/my-schedule.html`
- Create: `public/my-schedule.js`

No automated tests; manual smoke is the gate. Per spec §3, no frontend test framework in scope.

- [ ] **Step 3.1: Create `public/my-schedule.html`**

Write the file with this exact content:

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>我的課表 · CHINUP Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/style.css">
<style>
  body { visibility: hidden; }
  .tab-bar {
    display: flex;
    gap: 0;
    background: #f1f5f9;
    border-radius: 10px;
    padding: 4px;
    margin-bottom: 16px;
  }
  .tab-btn {
    flex: 1;
    text-align: center;
    padding: 8px 0;
    font-size: 14px;
    border-radius: 7px;
    color: #64748b;
    cursor: pointer;
    transition: background .15s, color .15s;
  }
  .tab-btn.active {
    background: #fff;
    color: #0f172a;
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0,0,0,.06);
  }
  .pill-kind {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    margin-right: 6px;
  }
  .pill-1on1 { background: #dbeafe; color: #1e40af; }
  .pill-group { background: #fce7f3; color: #9d174d; }
  .past-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    margin-top: 16px;
    border-top: 1px solid #e2e8f0;
    color: #64748b;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }
  .past-list .card { opacity: 0.72; }
  .section-label {
    font-size: 12px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: .04em;
    margin: 4px 0 10px;
  }
</style>
</head>
<body>
<nav class="navbar sticky top-0 z-20">
  <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <div class="flex items-center gap-8">
      <a href="/" class="brand-mark">
        <span class="brand-dot"><img src="/logo.png" alt="logo"></span> CHINUP Performance
      </a>
      <div class="hidden md:flex items-center gap-6">
        <a href="/" class="nav-link">課程</a>
        <a href="/coaches.html" class="nav-link">一對一預約</a>
        <a href="/my-schedule" class="nav-link active">我的課表</a>
        <a href="/admin.html" class="nav-link">管理後台</a>
        <a href="/coach.html" id="coach-link" class="nav-link hidden">教練後台</a>
      </div>
    </div>
    <div id="auth-bar" class="flex items-center gap-3"></div>
  </div>
</nav>

<main class="max-w-3xl mx-auto px-6">
  <section class="hero">
    <span class="hero-eyebrow">📋 Personal</span>
    <h1>我的課表</h1>
    <p>一對一預約 + 團課報名，依時間排序。</p>
  </section>

  <section class="pb-16">
    <div class="tab-bar" id="tab-bar">
      <div class="tab-btn active" data-filter="all">全部</div>
      <div class="tab-btn" data-filter="booking">一對一</div>
      <div class="tab-btn" data-filter="registration">團課</div>
    </div>

    <div id="upcoming-section">
      <div class="section-label">📅 即將到來</div>
      <div id="upcoming-list" class="grid gap-3"></div>
      <div id="upcoming-empty" class="empty-state" style="display:none;">
        <span class="empty-state-icon" id="upcoming-empty-icon">📭</span>
        <p id="upcoming-empty-msg">尚無預約</p>
        <div id="upcoming-empty-ctas" class="flex gap-2 justify-center mt-3 flex-wrap">
          <a href="/" class="btn btn-secondary">瀏覽課程</a>
          <a href="/coaches.html" class="btn btn-primary">預約一對一</a>
        </div>
      </div>
    </div>

    <div id="past-toggle-wrap" style="display:none;">
      <div class="past-toggle" id="past-toggle">
        <span id="past-caret">▶</span>
        <span>過去記錄（<span id="past-count">0</span>）</span>
      </div>
      <div id="past-list" class="past-list grid gap-3" style="display:none;"></div>
    </div>
  </section>
</main>

<div id="toast" class="toast"></div>

<script type="module" src="/app.js"></script>
<script type="module" src="/my-schedule.js"></script>
<script type="module">
  import { getUser } from '/app.js';
  const u = getUser();
  if (u && ['coach','admin','owner'].includes(u.role)) {
    document.getElementById('coach-link')?.classList.remove('hidden');
  }
</script>
</body>
</html>
```

- [ ] **Step 3.2: Create `public/my-schedule.js`**

Write the file with this exact content:

```javascript
import { api, fmtDate, toast, bootAuth } from './app.js';

const user = await bootAuth();
if (!user) throw new Error('__redirected_by_auth__');

const state = {
  items: [],
  filter: 'all',
  pastOpen: false,
};

const LABEL_BOOKING_STATUS = { confirmed: '已預約', cancelled: '已取消' };
const LABEL_REG_STATUS = { confirmed: '正取', waitlisted: '候補', cancelled: '已取消', rejected: '未開課' };

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function dateBlock(start_at) {
  const dt = new Date(start_at);
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `
    <div class="text-center px-3 py-2 rounded-lg" style="background:var(--brand-50);min-width:64px;">
      <div class="text-2xl font-bold" style="color:var(--brand-700);line-height:1;">${d}</div>
      <div class="text-xs mt-1" style="color:var(--brand-700)">${dt.getFullYear()}/${m}</div>
    </div>
  `;
}

function statusBadge(item) {
  if (item.kind === 'booking') {
    const label = LABEL_BOOKING_STATUS[item.status] || item.status;
    return `<span class="badge badge-${item.status}">${label}</span>`;
  }
  const label = LABEL_REG_STATUS[item.status] || item.status;
  return `<span class="badge badge-${item.status}">${label}</span>`;
}

function cardHtml(item) {
  const kindPill = item.kind === 'booking'
    ? '<span class="pill-kind pill-1on1">🏋️ 一對一</span>'
    : '<span class="pill-kind pill-group">👥 團課</span>';
  const title = item.kind === 'booking' ? item.coach_display_name : item.course_name;
  const duration = item.kind === 'booking' ? 60 : (item.duration_minutes || 60);
  const positionTag = (item.kind === 'registration' && item.position)
    ? `<span class="subtle ml-2">候補 #${item.position}</span>` : '';
  const noteLine = (item.kind === 'booking' && item.note)
    ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(item.note)}</div>` : '';
  const cancelReasonLine = (item.kind === 'booking' && item.cancel_reason)
    ? `<div class="text-sm text-red-500 mt-1">原因：${escapeHtml(item.cancel_reason)}</div>` : '';
  const cancelBtn = item.can_cancel
    ? `<button data-id="${item.id}" data-kind="${item.kind}" class="cancel-btn btn btn-danger btn-sm">取消</button>`
    : '';

  return `
    <article class="card">
      <div class="flex items-center gap-4">
        ${dateBlock(item.start_at)}
        <div class="flex-1">
          <div class="mb-1">${kindPill}</div>
          <h3 class="card-title">${escapeHtml(title || '')}</h3>
          <div class="meta">
            <span class="meta-item"><span class="meta-icon">🕐</span> ${fmtDate(item.start_at)}（${duration} 分鐘）</span>
          </div>
          <div class="flex items-center gap-2 mt-2 flex-wrap">
            ${statusBadge(item)}
            ${positionTag}
          </div>
          ${noteLine}
          ${cancelReasonLine}
        </div>
        ${cancelBtn}
      </div>
    </article>
  `;
}

function filterItems(items, filter) {
  if (filter === 'all') return items;
  return items.filter(i => i.kind === filter);
}

function render() {
  const filtered = filterItems(state.items, state.filter);
  const upcoming = filtered.filter(i => !i.is_past);
  const past     = filtered.filter(i =>  i.is_past);

  const upWrap = document.getElementById('upcoming-list');
  const upEmpty = document.getElementById('upcoming-empty');
  const upEmptyIcon = document.getElementById('upcoming-empty-icon');
  const upEmptyMsg = document.getElementById('upcoming-empty-msg');
  const upEmptyCtas = document.getElementById('upcoming-empty-ctas');

  if (upcoming.length === 0) {
    upWrap.innerHTML = '';
    upEmpty.style.display = 'block';
    const totallyEmpty = state.items.length === 0;
    const hasOnlyPast  = state.filter === 'all' && !totallyEmpty && past.length > 0;
    if (totallyEmpty) {
      upEmptyIcon.style.display = 'inline-block';
      upEmptyMsg.textContent = '還沒有任何預約';
      upEmptyCtas.style.display = 'flex';
    } else if (hasOnlyPast) {
      upEmptyIcon.style.display = 'none';
      upEmptyMsg.textContent = '本週沒有預約';
      upEmptyCtas.style.display = 'none';
    } else if (state.filter === 'booking') {
      upEmptyIcon.style.display = 'none';
      upEmptyMsg.textContent = '「一對一」沒有未來預約';
      upEmptyCtas.style.display = 'flex';
    } else {
      upEmptyIcon.style.display = 'none';
      upEmptyMsg.textContent = '「團課」沒有未來預約';
      upEmptyCtas.style.display = 'flex';
    }
  } else {
    upEmpty.style.display = 'none';
    upWrap.innerHTML = upcoming.map(cardHtml).join('');
  }

  const pastWrap = document.getElementById('past-toggle-wrap');
  const pastList = document.getElementById('past-list');
  const pastCount = document.getElementById('past-count');
  const pastCaret = document.getElementById('past-caret');

  if (past.length === 0) {
    pastWrap.style.display = 'none';
  } else {
    pastWrap.style.display = 'block';
    pastCount.textContent = past.length;
    pastCaret.textContent = state.pastOpen ? '▼' : '▶';
    if (state.pastOpen) {
      pastList.style.display = 'grid';
      pastList.innerHTML = past.map(cardHtml).join('');
    } else {
      pastList.style.display = 'none';
      pastList.innerHTML = '';
    }
  }

  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCancel(Number(btn.dataset.id), btn.dataset.kind));
  });
}

async function handleCancel(id, kind) {
  if (!confirm('確定要取消嗎？')) return;
  const url = kind === 'booking' ? `/api/bookings/${id}` : `/api/registrations/${id}`;
  try {
    await api(url, { method: 'DELETE' });
    toast('已取消', 'success');
    await load();
  } catch (e) {
    toast(`取消失敗：${e.message}`, 'error');
  }
}

function bindTabs() {
  document.querySelectorAll('#tab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      render();
    });
  });
}

function bindPastToggle() {
  document.getElementById('past-toggle').addEventListener('click', () => {
    state.pastOpen = !state.pastOpen;
    render();
  });
}

async function load() {
  try {
    const { items } = await api('/api/my/schedule');
    state.items = items;
    render();
  } catch (e) {
    toast(`載入失敗：${e.message}`, 'error');
  }
}

bindTabs();
bindPastToggle();
await load();
document.body.style.visibility = 'visible';
```

- [ ] **Step 3.3: Manual sanity check**

Visit `http://localhost:3000/my-schedule.html` (the static path; explicit `/my-schedule` route doesn't exist yet — that's Task 4) after logging in. Confirm:
- Page loads, hero + tab bar + at least one card render for `user1@chinup.local` (has seeded booking)
- Switch tabs filters correctly
- If past records exist, click toggle expands them

This is implementer self-verification only — do not block on it. If broken, fix here before committing. Final UI smoke is the user-driven gate per workflow_preferences.

- [ ] **Step 3.4: Commit**

```bash
git add public/my-schedule.html public/my-schedule.js
git commit -m "feat(ui): add unified /my-schedule page (Phase 3A)

Timeline + tab-filtered (全部/一對一/團課) view of all member bookings
and registrations. Past records collapsible. Reuses existing card +
badge + button design language.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Routing — redirects + `/my-schedule` canonical URL

**Files:**
- Modify: `src/server.js` (insert 3 `app.get(...)` lines before `app.use(express.static(...))` at line 58)
- Test: `tests/my-schedule-routing.test.js`

Order matters: explicit routes must be registered BEFORE `express.static` so the static middleware doesn't serve `public/my.html` instead of running our redirect.

- [ ] **Step 4.1: Write the failing test**

Create `tests/my-schedule-routing.test.js`:

```javascript
// HTTP 路由測試 — Phase 3A redirects + /my-schedule canonical
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function reqRaw(method, path) {
  const res = await fetch(BASE + path, { method, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') };
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[my-schedule-routing test] start');

// /my.html → 301 /my-schedule
const r1 = await reqRaw('GET', '/my.html');
expect('/my.html status 301', () => assert.equal(r1.status, 301));
expect('/my.html location=/my-schedule', () => assert.equal(r1.location, '/my-schedule'));

// /my-bookings.html → 301 /my-schedule
const r2 = await reqRaw('GET', '/my-bookings.html');
expect('/my-bookings.html status 301', () => assert.equal(r2.status, 301));
expect('/my-bookings.html location=/my-schedule', () => assert.equal(r2.location, '/my-schedule'));

// /my-schedule → 200 + HTML
const r3 = await reqRaw('GET', '/my-schedule');
expect('/my-schedule status 200', () => assert.equal(r3.status, 200));
expect('/my-schedule is HTML', () => assert(r3.contentType && r3.contentType.startsWith('text/html')));

console.log('[my-schedule-routing test] done');
```

- [ ] **Step 4.2: Run test, verify it fails**

Run: `node tests/my-schedule-routing.test.js`
Expected: `/my.html` test fails — currently returns 200 (static-served), not 301. `/my-schedule` may 404 since no explicit route exists yet.

- [ ] **Step 4.3: Add routes in `src/server.js`**

Locate this block (around lines 55-58):

```javascript
app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use(express.static(resolve(__dirname, '../public')));
app.use('/avatars', express.static(resolve(__dirname, '../data/avatars'), { maxAge: '7d' }));
```

Insert three new `app.get(...)` lines BEFORE the `express.static` call. The result should be:

```javascript
app.use(cors());
app.use(express.json({ limit: '3mb' }));

// Phase 3A · /my-schedule unification: redirect legacy URLs + serve canonical path
app.get('/my.html', (req, res) => res.redirect(301, '/my-schedule'));
app.get('/my-bookings.html', (req, res) => res.redirect(301, '/my-schedule'));
app.get('/my-schedule', (req, res) =>
  res.sendFile(resolve(__dirname, '../public/my-schedule.html'))
);

app.use(express.static(resolve(__dirname, '../public')));
app.use('/avatars', express.static(resolve(__dirname, '../data/avatars'), { maxAge: '7d' }));
```

- [ ] **Step 4.4: Restart the server**

Stop the running `npm start` process and re-run `npm start`.

- [ ] **Step 4.5: Run test, verify it passes**

Run: `node tests/my-schedule-routing.test.js`
Expected: all `✓`, exit code 0.

- [ ] **Step 4.6: Verify existing routing tests still pass**

Run: `node tests/booking-api.test.js`
Expected: still passes (no regression from inserted routes).

- [ ] **Step 4.7: Commit**

```bash
git add src/server.js tests/my-schedule-routing.test.js
git commit -m "feat(routing): 301 redirect legacy my.html + my-bookings.html (Phase 3A)

/my.html and /my-bookings.html now 301-redirect to /my-schedule.
/my-schedule serves public/my-schedule.html. Routes registered before
express.static so they win against any lingering static files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Cleanup — delete old pages + update internal references

**Files:**
- Delete: `public/my.html`
- Delete: `public/my-bookings.html`
- Delete: `public/my-bookings.js`
- Modify: `public/index.html` (navbar lines 26-27)
- Modify: `public/admin.html` (navbar line 24)
- Modify: `public/coaches.js` (line 159 redirect target)
- Modify: `public/courses.js` (two comments on lines 22 and 199)

No new tests. The previously-written tests must remain green.

- [ ] **Step 5.1: Delete old pages**

```bash
rm public/my.html public/my-bookings.html public/my-bookings.js
```

- [ ] **Step 5.2: Update `public/index.html` navbar**

Find the existing block (around lines 23-30):

```html
<div class="hidden md:flex items-center gap-6">
  <a href="/" class="nav-link active">課程</a>
  <a href="/coaches.html" class="nav-link">一對一預約</a>
  <a href="/my-bookings.html" class="nav-link">我的一對一</a>
  <a href="/my.html" class="nav-link">我的報名</a>
  <a href="/admin.html" class="nav-link">管理後台</a>
  <a href="/coach.html" id="coach-link" class="nav-link hidden">教練後台</a>
</div>
```

Replace with:

```html
<div class="hidden md:flex items-center gap-6">
  <a href="/" class="nav-link active">課程</a>
  <a href="/coaches.html" class="nav-link">一對一預約</a>
  <a href="/my-schedule" class="nav-link">我的課表</a>
  <a href="/admin.html" class="nav-link">管理後台</a>
  <a href="/coach.html" id="coach-link" class="nav-link hidden">教練後台</a>
</div>
```

- [ ] **Step 5.3: Update `public/admin.html` navbar**

Locate line 24:

```html
<a href="/my.html" class="nav-link">我的報名</a>
```

Replace with:

```html
<a href="/my-schedule" class="nav-link">我的課表</a>
```

- [ ] **Step 5.4: Update `public/coaches.js` post-booking redirect**

Locate line 159 (or whichever line currently contains the booking-success redirect):

```javascript
setTimeout(() => location.href = '/my-bookings.html', 700);
```

Replace with:

```javascript
setTimeout(() => location.href = '/my-schedule', 700);
```

- [ ] **Step 5.5: Update `public/courses.js` comments**

There are two comments referencing `my.html`. Locate and update both:

Line ~22:
```javascript
// Cancelled/rejected regs remain in history (visible in my.html) but must not
```
Replace `my.html` with `my-schedule`:
```javascript
// Cancelled/rejected regs remain in history (visible in my-schedule) but must not
```

Line ~199:
```javascript
// Refresh when navigating back from bfcache (e.g. user cancels on my.html
```
Replace `my.html` with `my-schedule`:
```javascript
// Refresh when navigating back from bfcache (e.g. user cancels on my-schedule
```

- [ ] **Step 5.6: Verify all tests still pass**

Restart the server (`npm start`) if it was stopped.

Run each in sequence:

```bash
node tests/my-schedule-service.test.js
node tests/my-schedule-api.test.js
node tests/my-schedule-routing.test.js
node tests/booking-api.test.js
node tests/booking-flow.test.js
node tests/flow.test.js
```

Expected: all pass except the 8 pre-existing failures in `tests/api.test.js` (unrelated, documented in `chinup_project.md` memory — `cycle_start_date: '2026-05-01'` expired). Do not run `tests/api.test.js` as part of this task.

- [ ] **Step 5.7: Grep for any remaining stale references**

Run: `grep -rn "my\.html\|my-bookings" public/ src/ tests/`
Expected: only references inside `tests/my-schedule-routing.test.js` (the redirect tests assert on these old paths, which is correct). No other matches.

If anything else matches, update it now.

- [ ] **Step 5.8: Commit**

```bash
git add -A
git commit -m "chore: remove legacy my.html / my-bookings.html and update refs (Phase 3A)

- Delete public/my.html, public/my-bookings.html, public/my-bookings.js
- Update navbar in index.html and admin.html to single 我的課表 link
- Update coaches.js post-booking redirect target to /my-schedule
- Update courses.js comments referencing old path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Final holistic review

Dispatch a single review subagent over the entire diff `main..feature/my-schedule`. Look for:

- **Integration**: Does the new endpoint correctly handle a user whose registrations reference a session whose template was later deleted (FK constraint)? Trace through.
- **Auth**: Any path that bypasses `requireUser`? Any path that leaks data across users?
- **Race conditions**: Cancel button → DELETE → refresh — does the cancel + re-fetch race cause a stale render?
- **SQL injection**: All user input goes through prepared statements (`db.prepare(...).all(userId)`)? ✅ — confirm.
- **Tailwind / CSS**: The new page renders at 390px mobile viewport without horizontal scroll? Tab bar wraps reasonably on narrow screens?
- **Backward compat**: Does `/api/my/bookings` and `/api/my/registrations` still work (i.e., not accidentally broken)?
- **Tests**: Are there any obvious untested paths that would catch a future regression cheaply?

The reviewer should produce a brief report. Fix any critical issues found, then mark Phase 3A implementation complete.

After this, hand off to the user-driven manual mobile smoke test (390px iPhone viewport) which is the merge gate per `workflow_preferences` memory.

---

## What is intentionally NOT covered

Per spec §3, these are out of scope and any agent attempting them is over-extending the task:

- Removing `/api/my/bookings` or `/api/my/registrations` endpoints
- Adding pagination to past records
- Mobile-specific visual rework beyond what naturally fits in `/my-schedule.html` (that's Phase 3B)
- LINE / Web Push notification integration (Phase 3C)
- Fixing the 8 pre-existing `tests/api.test.js` failures (separate housekeeping commit)
- Schema or migration changes
- Frontend testing framework introduction

## Reference

- Spec: `docs/superpowers/specs/2026-05-12-my-schedule-design.md`
- Phase 1 plan (for pattern): `docs/superpowers/plans/2026-05-11-one-on-one-booking.md`
- Phase 2 plan (for pattern): `docs/superpowers/plans/2026-05-12-points-system.md`
- Memory: `chinup_project.md`, `workflow_preferences.md`
