# Points System · Phase 2 Design

- **Date**: 2026-05-12
- **Status**: Draft (awaiting user review)
- **Scope**: Phase 2 of broader plan; depends on Phase 1 (one-on-one booking)
- **Base codebase**: extend `chinup-fitness-system`, branched from `feature/one-on-one-booking`

## 1 · Goal

Add a points/wallet system to chinup-fitness-system that gates both 1-on-1 booking and group class registration. Admin manually grants points; bookings deduct; cancellations refund. No online payment.

Phase 1's one-on-one booking module deducts/refunds against this wallet. Phase 1's group class flow (existing pre-Phase-1) is retrofitted with the same logic.

## 2 · Phase 2 Scope

### In scope

1. New `point_transactions` table — single source of truth, balance computed via `SUM`
2. Two pools: `one_on_one` and `group`; independent balances per member
3. 1-on-1 integration — `createBooking` deducts 1 point, `cancelBooking` refunds 1 point
4. Group class integration (retrofit) — `register` deducts on confirmed OR waitlisted; `cancelRegistration` refunds; `processDeadlines` refunds all participants when a session is auto-cancelled
5. Admin API + UI — grant points (positive or negative integer), required note, view per-member transaction log
6. Member balance UI — pill in shared navbar `[PT N · 團 M]` on all pages
7. Insufficient-points hard-block — frontend disables confirm button at 0; backend rejects with 409 `insufficient_points`
8. Concurrency — all point mutations inside `tx() BEGIN IMMEDIATE` with post-insert `SUM < 0` rollback check
9. Migration — wipe `data/app.db` and re-seed on Phase 2 deploy (one-time, dev-stage decision)

### Out of scope (Phase 3 or permanent YAGNI)

- ❌ Package definitions table / FIFO consumption — `note` field stores the package name as free text
- ❌ Point expiry — permanent
- ❌ Member-visible transaction log — admin-only audit
- ❌ Online payment / billing
- ❌ Group class mobile UI redesign, LINE/Push notifications, unified "my schedule" (Phase 3)
- ❌ Backfill of Phase 1 test bookings (decision: clean wipe)
- ❌ Member-side "我的點數" page (decision: balance pill is sufficient)

### Inherited from Phase 1 brainstorm

- Two separate point pools (1-on-1 and group don't share)
- Cancellation policy: anytime cancel, always refund
- No online payment — admin manually grants
- `notification_preference` and notification log: unchanged from Phase 1

## 3 · Decisions Summary

| Topic | Decision |
|---|---|
| Storage model | One table `point_transactions`; balance = `SUM(amount)` |
| Number of tables added | 1 (+ 1 view for admin convenience) |
| Pool count and shape | 2: `one_on_one` and `group`; independent |
| Point expiry | None (permanent) |
| Group deduction timing | Deduct on register (confirmed OR waitlisted); refund on cancel/auto-cancel |
| Balance UI placement | Pill in shared navbar (all pages via `app.js`) |
| Member view of transaction log | None (admin-only) |
| Insufficient-points handling | Hard block: disable confirm button at 0, reject API with 409 |
| Admin amount input | Signed integer (positive or negative); 0 rejected |
| Concurrency model | `BEGIN IMMEDIATE` + post-insert balance check + rollback |
| Migration of existing data | Wipe DB on deploy (one-time, dev-stage) |
| Branch | `feature/points-system`, based on `feature/one-on-one-booking` |

## 4 · Data Model

### `point_transactions`

```sql
CREATE TABLE IF NOT EXISTS point_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pool            TEXT NOT NULL CHECK (pool IN ('one_on_one', 'group')),
  amount          INTEGER NOT NULL,
  note            TEXT NOT NULL,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  source          TEXT NOT NULL CHECK (source IN (
                    'admin_grant',
                    'booking_deduct',
                    'booking_refund',
                    'registration_deduct',
                    'registration_refund',
                    'session_refund'
                  )),
  related_booking_id      INTEGER REFERENCES bookings(id),
  related_session_id      INTEGER REFERENCES course_sessions(id),
  related_registration_id INTEGER REFERENCES registrations(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount != 0)
);

CREATE INDEX IF NOT EXISTS idx_point_tx_member_pool ON point_transactions(member_id, pool);
CREATE INDEX IF NOT EXISTS idx_point_tx_created ON point_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_point_tx_booking ON point_transactions(related_booking_id);
CREATE INDEX IF NOT EXISTS idx_point_tx_registration ON point_transactions(related_registration_id);
```

### `member_point_balance` view

```sql
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

### Column rationale

- **`amount` signed**: `+N` adds, `-N` deducts. Direct `SUM`.
- **`note` required**: free-text audit trail. Admin writes "PT 10 堂裝"; auto-deductions write `預約 #42`.
- **`actor_id`**: who performed the action. Admin for grants; member's own user_id for self-cancel; member's own user_id for `session_refund` (avoids needing a system user).
- **`source` enum**: classifies for filters / UI grouping. `session_refund` distinguished from `registration_refund` so audit can tell auto-cancel from voluntary cancel.
- **`related_*_id`** nullable FKs: reverse-lookup convenience. Don't rely on cascade — business never hard-deletes referenced rows.

### Constraints (application-layer)

- Every `INSERT` into `point_transactions` runs inside a `tx()`. After insert, `SUM(amount) WHERE member_id=? AND pool=?` is computed. If `< 0`, throw `ApiError(409, 'insufficient_points')` → tx rolls back. This is the **only** enforcement of "cannot overdraft".
- `BEGIN IMMEDIATE` (chinup's existing `tx()` helper) serializes concurrent writers in SQLite WAL mode. Two simultaneous attempts to drain the last point cannot both succeed.

## 5 · Service Layer

### New `src/services/pointService.js`

Exports:

```javascript
recordTransaction({ memberId, pool, amount, note, actorId, source,
                    relatedBookingId, relatedSessionId, relatedRegistrationId })
  → { balance } | throws ApiError

getBalance(memberId, pool) → number
getBalances(memberId) → { one_on_one, group }
listTransactionsForAdmin(memberId, { pool?, limit? }) → row[]
adminGrant({ memberId, pool, amount, note, adminId }) → { balance }
```

`recordTransaction` is the universal write path. `adminGrant` is a typed wrapper.

`recordTransaction` does:
1. Validate `pool`, `amount != 0`, `note` non-empty
2. `tx(() => { INSERT; balance = getBalance(...); if (balance < 0) throw; return { balance } })`

### `src/services/bookingService.js` modifications

`createBooking`:
- After insert succeeds, call `recordTransaction({ memberId, pool: 'one_on_one', amount: -1, note: '預約 #' + bookingId, actorId: memberId, source: 'booking_deduct', relatedBookingId: bookingId })`.
- Whole flow already inside `tx()`; insufficient → both rolled back together.

`cancelBooking`:
- After status update, call `recordTransaction({ memberId: b.member_id, pool: 'one_on_one', amount: +1, note: '取消 #' + bookingId, actorId: actorUserId, source: 'booking_refund', relatedBookingId: bookingId })`.
- Note string distinguishes coach-emergency cancel: `'取消 #42（教練：原因）'`.

### `src/services/registration.js` modifications

`register`:
- After insert/reactivate succeeds, call `recordTransaction({ memberId: userId, pool: 'group', amount: -1, note: '報名 #' + registrationId, actorId: userId, source: 'registration_deduct', relatedRegistrationId: registrationId, relatedSessionId: sessionId })`.
- Both confirmed AND waitlisted register paths deduct.

`cancelRegistration`:
- After status update, call `recordTransaction({ memberId: userId, pool: 'group', amount: +1, ..., source: 'registration_refund' })`.
- Waitlist promotion path does NOT add a transaction — the promoted member already paid when registering.

### `src/services/courseService.js` modifications

`processDeadlines`:
- When marking a session `cancelled`, iterate all participants (confirmed + waitlisted) BEFORE flipping their registration status. For each: `recordTransaction({ memberId, pool: 'group', amount: +1, note: '場次未成班 #' + sessionId, actorId: memberId, source: 'session_refund', relatedSessionId: sessionId, relatedRegistrationId: regId })`.

## 6 · HTTP Routes

| Method | Path | Audience | Purpose |
|---|---|---|---|
| GET | `/api/my/points/balance` | member | `{ one_on_one, group }` for navbar pill |
| POST | `/api/admin/users/:id/points/grant` | admin/owner | `{ pool, amount, note }` → 201 `{ id, balance }` |
| GET | `/api/admin/users/:id/points/transactions?pool=&limit=` | admin/owner | recent transactions, default 100 |
| GET | `/api/admin/users` (modified) | admin/owner | Response augmented with `one_on_one_balance`, `group_balance` (via view) |

Existing endpoints whose **behaviour** changes (no schema change to their responses):

- `POST /api/bookings` — may now return 409 `insufficient_points`
- `DELETE /api/bookings/:id` — silently refunds on success
- `POST /api/sessions/:id/register` — may now return 409 `insufficient_points`
- `DELETE /api/registrations/:id` — silently refunds on success

## 7 · UI Changes

### Shared navbar pill (`public/app.js`)

Existing `auth_bar` render extended:

```
[ PT 5 · 團 12 ]   王小明   登出
```

- Only shown for `role === 'user'`
- Fetched via `GET /api/my/points/balance` on init; cached in `app.js` module state
- Helper `refreshBalance()` exported; called by `coaches.js`, `my-bookings.js`, `courses.js` after successful book/cancel
- 0 points → red text + tooltip "目前餘額 0 點，請聯絡管理員儲值"
- Applies automatically to: `index.html`, `coaches.html`, `coach.html`, `admin.html`, `login.html`, `my.html`, `my-bookings.html`

### Booking pages

`public/coaches.js` (1-on-1) and `public/courses.js` (group): on entering the confirm step, check `getBalance(pool)`. If `<= 0`:
- Disable confirm button
- Set button text to "點數不足，無法預約"
- Show hint line "目前餘額 0 點，請聯絡管理員儲值"

API still calls; if a race or stale state results in 409, toast the same message.

### Admin user-management section

`public/admin.html` user list table grows two columns:

| Name | Email | Role | PT | 團 | 動作 |

Per row: existing role-change controls + new `[加點] [歷史]` buttons.

**Grant modal**:
```
─ 加點：王小明 ────────────
Pool:    ○ 一對一  ○ 團體課
金額:    [       ]（必填，非 0，可負）
備註:    [_________________]（必填）
                  [取消] [送出]
```

On submit, POST `/api/admin/users/:id/points/grant`. On 409 `insufficient_points` (negative grant that would overdraft), toast the error.

**History modal**:
```
─ 王小明的點數紀錄 ────────
[全部 / 一對一 / 團體]

2026-05-12 14:00  -1  booking_deduct       預約 #42      王小明
2026-05-10 09:30  +10 admin_grant          PT 10 堂裝     admin
...
```

Backed by GET `/api/admin/users/:id/points/transactions`. Filter pill switches the `?pool=` query param. Last 100 rows.

Use `<dialog>` HTML element for modals (no new CSS framework needed).

## 8 · Concurrency & Edge Cases

- **Double-spend race**: two simultaneous bookings drain the last point. `BEGIN IMMEDIATE` serializes; second sees the post-first balance; balance check rolls back. Verified in tests.
- **Cancel + register simultaneously**: cancel is a refund (`+1`), can never trigger overdraft. Safe.
- **Negative grant overdraft**: admin tries to grant `-100` when balance is `5`. The `INSERT` inserts; post-insert `SUM = -95`; throws `insufficient_points`; tx rollback; row removed. Admin sees 409 + the would-be-balance in error detail.
- **`session_refund` actor**: we pick `actor_id = member_id` (not a synthetic system user) to avoid adding to the `users` table. `source = 'session_refund'` distinguishes auto-refund from a member-initiated cancel in audit.
- **Waitlist → confirmed promotion**: no transaction. The promoted member's deduction already happened at registration time.

## 9 · Migration & Deployment

### Schema migration

Append the new `CREATE TABLE` + `CREATE INDEX` + `CREATE VIEW` to `src/db/schema.js`. Auto-applied by `connection.js` on boot. Idempotent.

### Seed-demo update

`src/db/seed-demo.js` calls `adminGrant` for each of the 12 seeded members:
- `+5` to `one_on_one` pool
- `+10` to `group` pool

Note `'seed'`, actor `admin` user.

### Deploy step (Railway, one-time)

After this PR merges and Railway redeploys, run this in the Railway shell **once**:

```
rm -f data/app.db && node src/db/migrate.js && node src/db/seed-demo.js
```

This is the agreed migration approach for this dev-stage moment. Subsequent schema changes will require real migrations, not wipes.

## 10 · Testing

Following chinup's existing two-file convention. Append cases to `tests/booking-flow.test.js` and `tests/booking-api.test.js` (no new files).

### `booking-flow.test.js` additions

**Case 6: `pointService`**
- `adminGrant` writes a transaction; `getBalance` reflects it
- `recordTransaction` with negative amount that pulls to 0: ok; that pulls to -1: throws `insufficient_points`, post-rollback `SELECT COUNT(*)` shows no row
- `amount = 0` → `invalid_amount`
- empty `note` → `missing_note`
- invalid `pool` → `invalid_pool`
- `getBalances(memberId)` returns both pools
- `listTransactionsForAdmin` ordering / limit / pool filter

**Case 7: bookingService + points**
- `createBooking` decrements `one_on_one` by 1
- 0 balance → `createBooking` throws `insufficient_points`, no booking row created
- `cancelBooking` increments by 1
- coach emergency-cancel: `actor_id` = coach.user_id, note contains the reason

**Case 8: registration + points**
- `register` to confirmed: deducts group by 1
- `register` to waitlisted (session full): also deducts by 1
- `cancelRegistration`: refunds by 1
- `processDeadlines` cancelling a session: every participant (confirmed AND waitlisted) gets a `session_refund` transaction

### `booking-api.test.js` additions

- `GET /api/my/points/balance` returns both pools
- `POST /api/admin/users/:id/points/grant`: 401 / 403 (member) / 400 (invalid body) / 201 (success) / 409 (overdraft)
- `GET /api/admin/users/:id/points/transactions` returns rows with `actor_name` joined
- `POST /api/bookings` with 0 balance → 409 `insufficient_points`
- `POST /api/sessions/:id/register` with 0 balance → 409 `insufficient_points`
- `GET /api/admin/users` response includes `one_on_one_balance` and `group_balance` fields

### Existing test maintenance

Phase 1 tests will break because `register` and `createBooking` now require non-zero balance. Fix by adding a seeding step at the top of each affected test file (or `reset()` helper):

```javascript
const ownerId = db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get().id;
for (const uid of userIds(12)) {
  adminGrant({ memberId: uid, pool: 'one_on_one', amount: 20, note: 'test seed', adminId: ownerId });
  adminGrant({ memberId: uid, pool: 'group', amount: 20, note: 'test seed', adminId: ownerId });
}
```

This is documented in the test-maintenance section of the plan.

## 11 · Definition of Done

- Schema applies on a fresh DB
- `tests/booking-flow.test.js` all pass (existing + Cases 6, 7, 8)
- `tests/booking-api.test.js` all pass (existing + new HTTP cases)
- `tests/flow.test.js` and `tests/api.test.js` pass after their test-seed updates
- `npm start` boots cleanly; `GET /api/my/points/balance` returns 200 for a logged-in user
- Manual smoke tests pass:
  - Admin grants points → member navbar pill updates after refresh
  - Member at 0 points cannot click 預約 button; tooltip explains
  - Booking → balance -1; cancel → balance +1
  - Group register → balance -1; cancel → +1; admin cancels session (or it auto-cancels) → all participants refunded
  - Admin views a member's transaction log; sees all sources distinguished
- Mobile viewport (390px) check: navbar pill renders without overflow; admin modals render

## 12 · Risks & Concerns

- **Existing test breakage**: real and intentional. Addressed via seed updates in the plan. If a test author forgets, they'll see `insufficient_points` from `register`/`createBooking` — clear signal.
- **Negative-balance race**: theoretically possible if two concurrent transactions both pass their individual `SUM` check then commit. `BEGIN IMMEDIATE` makes writes serialised in SQLite WAL mode, so this race cannot occur in our setup. The plan includes a focused test that runs sequential drain-then-overdraft attempts to confirm the rollback path. A true concurrent stress test is hard to write deterministically in this single-threaded test harness; the SQLite-level guarantee is what we rely on.
- **`actor_id = member_id` for `session_refund`**: looks like a self-refund in audit if someone reads `actor` without reading `source`. Mitigated by always rendering `source` alongside actor in admin UI.
- **Wipe-DB migration**: this is the LAST time we do this. After this deploy, all changes must be backward-compatible or use real migration scripts.
- **Stale balance UI**: navbar pill is fetched on page load and cached. Multi-tab usage shows stale values. Acceptable for v1; future improvement is server-sent events or polling.
