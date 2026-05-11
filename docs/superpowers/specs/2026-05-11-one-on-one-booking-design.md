# One-on-One Booking Module · Phase 1 Design

- **Date**: 2026-05-11
- **Status**: Draft（awaiting user review）
- **Scope**: Phase 1 of broader plan; Phase 2/3 deferred
- **Base codebase**: extend `chinup-fitness-system` in place

## 1 · Goal

Add a one-on-one coaching booking module to chinup-fitness-system. Members browse coaches, view a coach profile and available time, and book a 60-minute session. Coaches self-manage their availability and profile. Mobile-friendly (responsive web).

The existing group class booking system is unchanged in Phase 1.

## 2 · Phase 1 Scope

### In scope

1. New `coach` role in the role hierarchy
2. Coach profile (display name, specialty, bio, avatar)
3. Coach availability (weekly base + per-date exceptions)
4. Member booking flow (browse → coach detail → pick slot → confirm)
5. Coach self-service backend (profile, availability, view own bookings, emergency cancel)
6. Admin: create coach accounts, toggle user ↔ coach, ordering
7. Mobile-first responsive UI for the new module
8. Reuse existing notification log mechanism (DB write, no real send)

### Out of scope (Phase 2/3)

- Points / package management (Phase 2)
- Online payment (deferred indefinitely)
- Group class changes — mobile UI redesign, LINE/Push, points integration (Phase 3)
- Member "我的課表" unified schedule page (Phase 3)
- LINE / Push notification integration (Phase 3)
- Real notification delivery (Phase 3)

### Reused from existing chinup

- Auth: email/password (scrypt) + Google OAuth + session token
- Design system: 既有 design tokens, LiHei Pro 字型, 天空藍品牌色
- Notification log mechanism (`notifications` table → console log)
- Stack: Node 24 (ESM), Express, `node:sqlite` (WAL), node-cron
- Deploy: Dockerfile + Railway

## 3 · Decisions Summary

| Topic | Decision |
|---|---|
| Architecture approach | Extend chinup-fitness-system (not new project) |
| 1-on-1 flow | Member picks coach first, then time |
| Multi-coach model | Multiple coaches, member sees specific coach |
| Availability model | Weekly base rules + per-date exceptions (leave / extra) |
| Who manages availability | Coaches self-manage (login required) |
| Coach permissions | View own bookings, edit profile, set availability, emergency cancel |
| Service offering | Fixed 60 min, single service type |
| Points / payment in Phase 1 | None |
| Cancellation policy (when points arrive) | Anytime cancel, always refund (no deduction) |
| Cancellation in Phase 1 | Status change only (no points to refund yet) |
| Frontend | Responsive web, multi-page SSR (consistent with existing) |
| Data model approach | Rule-based, slots computed on-the-fly |
| Avatar storage | Local disk under `data/avatars/` (Railway persistent disk), 2 MB, jpg/png |
| Coach onboarding | Self-signup as coach during registration; admin must activate (`is_active=1`) |
| User ↔ Coach role conversion | Admin can toggle either direction (button) |

## 4 · User Roles

```
owner > admin > coach > user
```

- `owner` / `admin` / `user`: existing, unchanged
- `coach`: **new** — between admin and user
  - **Can**: view own bookings, edit own profile, set own availability, emergency-cancel own bookings
  - **Cannot**: view other coaches' data or members, modify schedule templates, access admin/owner functions

`users.role` accepts `'coach'` in addition to existing values. No schema change required for users table — application-layer authorization only.

## 5 · Data Model

Four new tables. All use the same conventions as existing chinup tables (INTEGER PK, TEXT for ISO datetimes, foreign keys to existing tables).

### `coaches`

```sql
CREATE TABLE coaches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id),
  display_name    TEXT NOT NULL,       -- "王教練" — shown to members; may differ from users.name
  specialty       TEXT,                -- "增肌減脂 · 體態雕塑"
  bio             TEXT,                -- longer description
  avatar_path     TEXT,                -- relative path under data/avatars/
  is_active       INTEGER NOT NULL DEFAULT 0,  -- 0 = pending/disabled, 1 = visible to members
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### `coach_availability_rules`

Weekly recurring base schedule. One coach may have multiple rules per weekday (e.g. 9–12 + 14–17 on Mondays).

```sql
CREATE TABLE coach_availability_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id        INTEGER NOT NULL REFERENCES coaches(id),
  day_of_week     INTEGER NOT NULL,    -- 0=Sun, 1=Mon, ..., 6=Sat
  start_time      TEXT NOT NULL,       -- 'HH:MM' (local time, Asia/Taipei)
  end_time        TEXT NOT NULL,
  effective_from  TEXT NOT NULL,       -- 'YYYY-MM-DD', defaults to today
  effective_to    TEXT,                -- NULL = open-ended
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_time < end_time),
  CHECK (day_of_week BETWEEN 0 AND 6)
);
```

### `coach_availability_exceptions`

Per-date overrides to the base rules.

```sql
CREATE TABLE coach_availability_exceptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id        INTEGER NOT NULL REFERENCES coaches(id),
  exception_date  TEXT NOT NULL,       -- 'YYYY-MM-DD'
  type            TEXT NOT NULL,       -- 'leave' | 'extra'
  start_time      TEXT,                -- only used when type='extra'
  end_time        TEXT,
  note            TEXT,                -- "國定假日" / "個人事務"
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (type IN ('leave', 'extra')),
  CHECK (type = 'leave' OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time))
);
```

- `type = 'leave'`: removes the entire day's slots regardless of base rules
- `type = 'extra'`: adds an extra window in addition to base rules

### `bookings`

```sql
CREATE TABLE bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id        INTEGER NOT NULL REFERENCES coaches(id),
  member_id       INTEGER NOT NULL REFERENCES users(id),
  start_at        TEXT NOT NULL,       -- ISO datetime UTC
  end_at          TEXT NOT NULL,       -- start_at + 60min
  status          TEXT NOT NULL DEFAULT 'confirmed',  -- 'confirmed' | 'cancelled'
  cancelled_at    TEXT,
  cancelled_by    INTEGER REFERENCES users(id),
  cancel_reason   TEXT,
  note            TEXT,                -- optional member note at booking time
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('confirmed', 'cancelled'))
);

-- Prevent double-booking of the same time slot for the same coach
CREATE UNIQUE INDEX bookings_coach_start_confirmed
  ON bookings(coach_id, start_at)
  WHERE status = 'confirmed';
```

## 6 · Slot Computation

For `GET /api/coaches/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`:

1. For each date in range:
   - Look up base rules where `day_of_week` matches and `effective_from <= date <= effective_to` (or `effective_to IS NULL`)
   - If a `leave` exception exists for this date → skip entirely
   - Add windows from `extra` exceptions for this date
2. For each resulting window, split into 60-minute slots aligned to the window start (e.g. 09:00–12:00 → 09:00, 10:00, 11:00)
3. Filter out:
   - Slots already taken by a confirmed booking (same `coach_id`, same `start_at`)
   - Slots in the past
   - Slots less than 2 hours from `now()` — "buffer window" to prevent last-second bookings
   - Slots beyond the booking window (default: 30 days from `now()`, configurable)
4. Return the filtered slots as ISO datetimes

Configuration (kept in code constants for Phase 1, can move to a config table later):

```
SLOT_DURATION_MINUTES   = 60
BUFFER_HOURS            = 2
BOOKING_WINDOW_DAYS     = 30
```

## 7 · Key Flows

### 7.1 · Member booking

1. **Home page** → 「預約一對一」 button (alongside existing 團體課表)
2. **Coach list** (`/coaches`) — only `is_active = 1` coaches, ordered by `sort_order` then `id`. Each row: avatar, display_name, specialty.
3. **Coach detail** (`/coaches/:id`) — avatar, name, bio, specialty + slot grid for the next week. Member can navigate weeks. Selecting a slot opens confirmation.
4. **Confirm** — shows summary (coach, time), optional note field, "確認預約" button. On submit:
   - POST `/api/bookings` → insert booking with `status='confirmed'`
   - Write notification log (member + coach)
   - Redirect to `/bookings/:id` (detail page)
5. **My bookings** (`/bookings/mine`) — list of upcoming/past 1-on-1 bookings.

### 7.2 · Coach availability management

1. **Coach dashboard** (`/coach/dashboard`) — today's bookings, this week summary.
2. **Coach availability** (`/coach/availability`):
   - **Weekly base** section: list of rules per day-of-week with add/edit/delete
   - **Exceptions** section: list of dated exceptions, separated by `leave` vs `extra`, with add/delete
   - **Preview** section: next 4 weeks expanded, showing actual available windows after rules + exceptions are applied (read-only; helps coach verify their setup is correct)

### 7.3 · Cancellation

- **Member self-cancel**: from `/bookings/:id`, button "取消預約" → DELETE `/api/bookings/:id`
  - Sets `status='cancelled'`, `cancelled_at=now()`, `cancelled_by=<member_id>`
  - Writes notification log (member confirmation + coach notice)
- **Coach emergency cancel**: from `/coach/bookings`, button "取消並通知會員"
  - Requires `cancel_reason` (text input, required)
  - Sets `status='cancelled'`, `cancelled_at=now()`, `cancelled_by=<coach_user_id>`, `cancel_reason=<reason>`
  - Writes notification log (member notice with reason)
- No time limit on either side in Phase 1.
- **Points refund**: documented as policy ("anytime cancel = always refund") but not implemented in Phase 1 because there is no points system. Phase 2 will add a `refundPoints()` step inside the cancellation transaction.

## 8 · Page & Route Inventory

### Pages (server-rendered HTML)

| Path | Audience | Purpose |
|---|---|---|
| `/coaches` | member | Coach list |
| `/coaches/:id` | member | Coach detail + slot picker |
| `/bookings/mine` | member | My 1-on-1 bookings |
| `/bookings/:id` | member | Single booking detail + cancel |
| `/coach/dashboard` | coach | Landing |
| `/coach/profile` | coach | Edit own profile |
| `/coach/availability` | coach | Manage rules + exceptions |
| `/coach/bookings` | coach | My bookings + emergency cancel |
| `/admin/coaches` | admin/owner | Coach CRUD + activation + role toggle |
| `/admin/bookings/one-on-one` | admin/owner | All 1-on-1 bookings (read-only observation) |

### API endpoints (JSON, called by frontend JS)

```
GET    /api/coaches                              # public — list active coaches
GET    /api/coaches/:id                          # public — single coach profile
GET    /api/coaches/:id/availability             # public — ?from=…&to=…

POST   /api/bookings                             # member — create booking
DELETE /api/bookings/:id                         # member or coach — cancel

GET    /api/coach/me/rules                       # coach — list own rules
POST   /api/coach/me/rules                       # coach — create rule
DELETE /api/coach/me/rules/:id                   # coach — delete rule

GET    /api/coach/me/exceptions                  # coach — list own exceptions
POST   /api/coach/me/exceptions                  # coach — create exception
DELETE /api/coach/me/exceptions/:id              # coach — delete exception

PATCH  /api/coach/me/profile                     # coach — update profile fields
POST   /api/coach/me/avatar                      # coach — upload avatar (multipart)

POST   /api/admin/coaches                        # admin — activate coach / set fields
PATCH  /api/admin/coaches/:id                    # admin — update is_active, sort_order, etc.
POST   /api/admin/users/:id/role                 # admin — set role (toggle user ↔ coach)
```

### Avatar storage

- Stored on disk at `data/avatars/<coach_id>-<random>.jpg|png`
- Database stores relative path in `coaches.avatar_path`
- Served via `/avatars/:filename` Express static handler scoped to `data/avatars/`
- Upload constraints: 2 MB max, jpg/png only, server-side validation of MIME and magic bytes
- Old avatar deleted when replaced

## 9 · Signup / Onboarding

- Existing signup endpoint `POST /api/auth/register` adds a new optional field `as_coach: boolean`
- The signup page (`public/login.html` or wherever the existing signup form lives) adds a toggle 「我是教練」(I am a coach)
- If toggled:
  - Creates `users` row with `role='coach'`
  - Creates `coaches` row with `is_active=0` (pending)
  - Coach can log in immediately but is **invisible to members** until admin sets `is_active=1`
  - Coach dashboard shows banner: 「您的教練資料尚未啟用，請聯絡管理員」
- Admin sees pending coaches in `/admin/coaches` and can activate (set `is_active=1`)
- Admin can also toggle existing `user` ↔ `coach` via `/admin/coaches` (button on user list and coach list)
  - `user → coach`: creates `coaches` row with `is_active=0` (admin sets fields then activates)
  - `coach → user`: sets `coaches.is_active=0` and changes `users.role` to `user`. Coaches row kept for historical bookings. Future bookings prevented automatically since coach is inactive.

## 10 · Notifications (Phase 1)

Phase 1 reuses the existing notification log mechanism — write a row to the `notifications` table, log to console. Real delivery (LINE / Push) is Phase 3.

Triggers:

| Event | Recipients |
|---|---|
| Member books a 1-on-1 | Member (confirmation), Coach (new booking) |
| Member cancels own booking | Member (cancel confirmation), Coach (notice) |
| Coach emergency-cancels booking | Member (notice with reason) |

Reminder notifications (e.g. 24h before) are out of Phase 1 scope.

## 11 · Testing

Following chinup's existing two-file convention (`tests/flow.test.js` for service-level, `tests/api.test.js` for HTTP integration), add two new files dedicated to the booking module:

### `tests/booking-flow.test.js` (service-level, no HTTP)

**Availability computation:**
- Rule expansion across multi-day range
- `leave` exception removes the entire day
- `extra` exception adds slots
- Effective dates (`effective_from`, `effective_to`) honoured
- Past slots filtered
- Sub-2h buffer enforced
- Beyond 30-day window filtered
- Already-confirmed booking excluded
- Time zone: rule `start_time='09:00'` produces a UTC slot at the Asia/Taipei wall-clock 09:00

**Booking lifecycle:**
- Successful booking insert
- Double-book attempt fails (unique constraint)
- Cancel by member: status, cancelled_by, cancelled_at all set
- Cancel by coach: cancel_reason required and stored
- Cannot cancel an already-cancelled booking
- Cancelling a booking frees the slot to be re-booked

**Coach-data isolation:**
- Coach service rejects operations on another coach's rules/exceptions/bookings
- Deactivating a coach (`is_active=0`) keeps existing bookings but hides future slots

### `tests/booking-api.test.js` (HTTP integration)

- Public endpoints (`/api/coaches`, availability) require no auth
- Coach endpoints require `coach` role
- Admin endpoints require `admin` or `owner`
- Coach cannot modify another coach's resources via API
- Member cannot cancel another member's booking via API
- End-to-end: signup as coach → admin activates → coach sets rules → member books → coach sees in `/coach/bookings` → member cancels → both see cancelled

Existing tests (`flow.test.js`, `api.test.js`) must still pass — no regressions in group class flow.

## 12 · Schema changes

chinup uses a single `src/db/schema.js` as source of truth — `CREATE TABLE IF NOT EXISTS` statements, auto-applied by `connection.js` on startup, idempotent. There is no separate migrations directory.

Append the new tables to `SCHEMA` in `src/db/schema.js`:

- `coaches`
- `coach_availability_rules`
- `coach_availability_exceptions`
- `bookings`
- The partial unique index on `bookings(coach_id, start_at) WHERE status='confirmed'`

`users.role` requires no DDL change — application-layer authorization in `src/services/auth.js` is updated to recognise `'coach'`.

For existing demo data, update `src/db/seed-demo.js` to additionally insert one active coach, sample rules + one leave exception, and one demo booking.

### New service files

Following the existing `src/services/` convention:

```
src/services/coachService.js          -- coach profile CRUD, list/get
src/services/availabilityService.js   -- rule/exception CRUD + slot computation
src/services/bookingService.js        -- booking create/cancel + concurrency handling
```

### New public pages

Following the existing `public/*.html` convention (multi-page, server-served):

```
public/coaches.html              -- member: coach list + detail (could be one page with client-side routing or two)
public/coach-dashboard.html      -- coach landing + own bookings
public/coach-availability.html   -- coach rules + exceptions UI
public/coach-profile.html        -- coach edit own profile
public/my-bookings.html          -- member: own 1-on-1 bookings (or augment existing my.html)
public/admin-coaches.html        -- admin: coach CRUD (or augment existing admin.html)
```

Decide during implementation whether to add to existing aggregator pages (`admin.html`, `my.html`) or create separate files — preserve the existing pattern.

## 13 · Risks & Concerns

- **Concurrency on slot picking**: two members hitting the confirm button on the same slot at the same time. The unique partial index on `bookings(coach_id, start_at) WHERE status='confirmed'` prevents the duplicate insert at the DB layer; the second request gets a constraint error and the API returns a "此時段剛被預約走了" message.
- **Time zone**: all times shown to users are Asia/Taipei. Datetimes stored as UTC in `start_at` / `end_at`. `coach_availability_rules.start_time` / `end_time` are local (HH:MM). Slot computation must apply Taipei TZ when expanding rules into datetimes.
- **Coach rule retroactivity**: if a coach deletes a rule, existing future bookings under it should NOT be invalidated. `effective_to` is a soft tombstone — historical and already-booked slots remain bookings, but future slots stop appearing. Tests must cover this.
- **Member abuse of free cancellation**: with no time limit and (eventually) full refund, a member could repeatedly book-and-cancel. Out of scope for Phase 1 (no points = no real cost). Phase 2 should reconsider — admin observation page `/admin/bookings/one-on-one` is the first line of detection.
- **Avatar disk persistence on Railway**: `data/` directory is on Railway's persistent volume (per existing chinup setup) — confirm before deploy that the volume is mounted at the right path and survives redeploy.

## 14 · Definition of Done

- Schema applies cleanly on fresh DB (auto-applied by `connection.js`)
- `node tests/booking-flow.test.js` and `node tests/booking-api.test.js` both pass
- `node tests/flow.test.js` and `node tests/api.test.js` still pass (no regression)
- `src/db/seed-demo.js` updated to include: one active coach, sample rules + one leave exception, one demo booking
- Manual smoke test on mobile viewport (iPhone-size Chrome devtools): coach self-signup → admin activates → coach sets availability → member books → both sides see booking → either side cancels
- Deployable to Railway with no new runtime dependencies
- README updated with "一對一預約模組" section and screenshots
