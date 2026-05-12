# Phase 3C · LINE Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `notifications.js` stub with a real LINE Messaging API integration. Members opt in via "add LINE friend + send 6-digit binding code" flow. 7 existing course notifications + 4 new 1-on-1 booking notifications all push to LINE. Failed sends auto-retry via cron with 5/15/45 min backoff, then mark `failed_permanent`.

**Architecture:** Pure backend + one new frontend page. All callers stay on the same `notify({ userId, sessionId, type, vars })` interface (pass `sessionId: null` for booking events) — `notifications.js` decides channel internally. New thin wrappers for LINE API (`lineClient.js`) and binding state machine (`lineBindingService.js`). Schema gains 6 nullable columns + 2 indexes via idempotent `addColumnIfMissing` helper. Webhook validates HMAC signature, route handlers consume parsed body.

**Tech Stack:** Node 24 ESM + Express + `node:sqlite` + `node:crypto` (HMAC) + `node-cron`. **Zero new npm deps** — we hit LINE API with native `fetch`, no `@line/bot-sdk`. Frontend: Vanilla JS + Tailwind CDN.

**Spec reference:** `docs/superpowers/specs/2026-05-12-line-notifications-design.md`

**Branch:** `feature/line-notifications` (already checked out, base commit `2568359` is the spec commit)

**Review pattern:** Tasks 1–7 are non-trivial (real external integration + schema + new endpoints + new frontend) and get full per-task spec + quality review. Task 8 (cleanup) is mechanical, accept implementer report directly. Task 9 (smoke) is implementer + manual user gate. Task 10 is the holistic review.

---

## File Structure

**Created (6):**
| Path | Responsibility |
|---|---|
| `src/services/lineClient.js` | `sendMessage(lineUserId, text)` + `verifySignature(rawBody, sig)`; mock-aware via `LINE_MOCK` env |
| `src/services/lineBindingService.js` | `generateBindCode(userId)` + `consumeCode(code, lineUserId)` + `unbindByLineUserId(lineUserId)` |
| `public/line.html` | Binding UI page (unbound + bound states) |
| `public/line.js` | Page logic: load state, render code/QR, regenerate, unbind |
| `tests/notifications-flow.test.js` | Service-level flow tests for templates / binding / retry |
| `tests/line-webhook-api.test.js` | HTTP integration tests for webhook + 3 `/api/my/line/*` endpoints |

**Modified (11):**
| Path | What changes |
|---|---|
| `src/db/schema.js` | Add 3 user cols + 3 notification cols + 2 indexes to SCHEMA (canonical structure) |
| `src/db/connection.js` | Add `addColumnIfMissing` helper; call it 6× after `db.exec(SCHEMA)`; exec the 2 indexes |
| `src/services/notifications.js` | **Rewrite**: 11 templates (7 existing + 4 new), new `notify()` dispatch, `deliverLine`/`deliverConsole`, `processFailedNotifications` cron worker, `fmtDateForLine` helper |
| `src/services/bookingService.js` | Add 2 notify() in `createBooking` + 2 in `cancelBooking` (gap fill from Phase 1) |
| `src/scheduler.js` | Add `cron.schedule('*/5 * * * *', ...)` for `processFailedNotifications` |
| `src/server.js` | Modify `express.json` middleware (`verify` callback to capture `req.rawBody`); add 4 routes; import new services |
| `public/index.html`, `public/admin.html`, `public/coach.html`, `public/coaches.html`, `public/my-schedule.html` | Add `🔔 LINE 通知` nav-link in both desktop block + mobile dropdown |
| `package.json` | Update `start` script to `node --env-file-if-exists=.env src/server.js` |
| `.gitignore` | Add `public/line-qr.png` (`.env` already present) |
| `README.md` | New section `## Phase 3C: LINE 通知設定` with the operator setup steps |
| `tests/booking-flow.test.js` | Set `process.env.LINE_MOCK = '1'` at top + 1 assertion that booking_created notification row exists |

**Out of scope to touch:** Any other file in `src/` or `public/` or `tests/`.

---

## Pre-flight check

- [ ] **Step 0a: Confirm branch**

Run: `git branch --show-current`
Expected: `feature/line-notifications`

- [ ] **Step 0b: Confirm spec is committed**

Run: `git log --oneline -2`
Expected: HEAD includes `2568359 docs: add Phase 3C design spec for LINE notification integration`

- [ ] **Step 0c: Confirm server + seeded DB**

```bash
curl -s -o /dev/null -w "server: %{http_code}\n" http://localhost:3000/api/health
sqlite3 data/app.db "SELECT COUNT(*) FROM users;"
```

Expected: 200; users count ≥ 13 (admin + user1..user12 + coach1).

If DB looks empty (after prior flow tests wiped it):
```bash
rm -f data/app.db data/app.db-shm data/app.db-wal
node src/db/migrate.js
node src/db/seed-demo.js
SERVER_PID=$(lsof -ti :3000 2>/dev/null); [ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
```

---

## Task 1: Schema migration + `addColumnIfMissing` helper

**Files:**
- Modify: `src/db/schema.js`
- Modify: `src/db/connection.js`

No automated tests. Verify by booting server + PRAGMA check.

- [ ] **Step 1.1: Update `src/db/schema.js`**

Find the `CREATE TABLE IF NOT EXISTS users (...)` block and modify to add the 3 new Phase 3C columns + an inline comment marking `notification_preference` as deprecated. Final block:

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
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
```

Find the `CREATE TABLE IF NOT EXISTS notifications (...)` block and modify to add the 3 new Phase 3C columns. Final block:

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES course_sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Append two new index statements at the end of SCHEMA (after all existing indexes):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id
  ON users(line_user_id) WHERE line_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_retry
  ON notifications(status, next_retry_at) WHERE status = 'failed';
```

- [ ] **Step 1.2: Add `addColumnIfMissing` helper to `src/db/connection.js`**

After `db.exec(SCHEMA)` (wherever schema is currently auto-applied) but BEFORE any subsequent code (look for the schema import/exec block at the top of the file). Add the helper + 6 migration calls. Locate the existing `db.exec(SCHEMA)` line and replace it with:

```javascript
db.exec(SCHEMA);

// Phase 3C: idempotent column additions for existing DBs.
// Fresh DBs already have these columns from the CREATE TABLE above,
// so the PRAGMA check finds them and skips the ALTER.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('users', 'line_user_id', 'TEXT');
addColumnIfMissing('users', 'line_bind_code', 'TEXT');
addColumnIfMissing('users', 'line_bind_expires_at', 'TEXT');
addColumnIfMissing('notifications', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('notifications', 'next_retry_at', 'TEXT');
addColumnIfMissing('notifications', 'last_error', 'TEXT');
```

The two new indexes in SCHEMA already use `IF NOT EXISTS` and run inside `db.exec(SCHEMA)`. **But** on an existing DB without the columns, the indexes can't be created until the columns exist. So move the index DDL out of SCHEMA into a separate exec after the column migrations:

Actually keep them in SCHEMA. On an existing DB that hasn't run yet, the columns are added by `addColumnIfMissing` AFTER the SCHEMA exec — so the first boot pass would fail when trying to create the index. Defensively: keep SCHEMA without the new indexes, and exec the two new index statements separately AFTER the migrations.

Revise: in `src/db/schema.js`, do NOT add the two new indexes to the SCHEMA string. Instead, export them separately:

```javascript
export const PHASE_3C_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id
  ON users(line_user_id) WHERE line_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_retry
  ON notifications(status, next_retry_at) WHERE status = 'failed';
`;
```

Then in `connection.js`, after the 6 `addColumnIfMissing` calls:

```javascript
import { SCHEMA, PHASE_3C_INDEXES } from './schema.js';
// ... existing code that runs db.exec(SCHEMA) ...
// ... addColumnIfMissing calls ...

db.exec(PHASE_3C_INDEXES);
```

(Adjust the existing import line at top of `connection.js` to include `PHASE_3C_INDEXES`.)

- [ ] **Step 1.3: Restart server**

```bash
SERVER_PID=$(lsof -ti :3000 2>/dev/null)
[ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
```

Expected: 200, no errors in `/tmp/chinup-server.log`.

- [ ] **Step 1.4: Verify schema changes**

```bash
sqlite3 data/app.db "PRAGMA table_info(users);" | grep -E "line_user_id|line_bind_code|line_bind_expires_at"
sqlite3 data/app.db "PRAGMA table_info(notifications);" | grep -E "retry_count|next_retry_at|last_error"
sqlite3 data/app.db "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_users_line_user_id' OR name LIKE 'idx_notifications_retry';"
```

Expected:
- 3 user columns listed
- 3 notification columns listed
- 2 indexes listed

- [ ] **Step 1.5: Confirm regression — existing tests still pass**

```bash
node tests/my-schedule-routing.test.js 2>&1 | tail -2
node tests/my-schedule-api.test.js 2>&1 | tail -2
```

Expected: both pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/db/schema.js src/db/connection.js
git commit -m "feat(schema): add Phase 3C columns + indexes for LINE notifications

users: line_user_id (UNIQUE partial), line_bind_code, line_bind_expires_at
notifications: retry_count, next_retry_at, last_error (for retry worker)

New idempotent helper addColumnIfMissing runs after db.exec(SCHEMA) so
existing DBs gain the columns on next boot. Indexes exec separately
(after migrations) so existing DBs don't try to index nonexistent
columns. Fresh DBs already have everything from CREATE TABLE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `lineClient.js` — LINE API wrapper

**Files:**
- Create: `src/services/lineClient.js`
- Test: `tests/lineClient.test.js` (new, small focused unit-style test for signature verification)

- [ ] **Step 2.1: Write the failing test**

Create `tests/lineClient.test.js`:

```javascript
// Unit-style: HMAC signature verification + MOCK behavior of lineClient
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sendMessage, verifySignature } from '../src/services/lineClient.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

async function expectAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[lineClient test] start');

// --- verifySignature ---
const SECRET = 'test-secret-1234';
const RAW = Buffer.from('{"events":[]}');
const validSig = createHmac('sha256', SECRET).update(RAW).digest('base64');

process.env.LINE_CHANNEL_SECRET = SECRET;
delete process.env.LINE_MOCK;

expect('valid signature → true', () => assert.equal(verifySignature(RAW, validSig), true));
expect('wrong signature → false', () => assert.equal(verifySignature(RAW, 'invalid-base64'), false));
expect('null signature → false', () => assert.equal(verifySignature(RAW, null), false));
expect('empty body + valid sig → true', () => {
  const emptyBody = Buffer.from('');
  const sig = createHmac('sha256', SECRET).update(emptyBody).digest('base64');
  assert.equal(verifySignature(emptyBody, sig), true);
});

process.env.LINE_MOCK = '1';
expect('LINE_MOCK=1 bypasses signature check', () => assert.equal(verifySignature(RAW, 'whatever'), true));
delete process.env.LINE_MOCK;

// Missing secret env → false (even with valid-looking sig)
const origSecret = process.env.LINE_CHANNEL_SECRET;
delete process.env.LINE_CHANNEL_SECRET;
expect('missing LINE_CHANNEL_SECRET → false', () => assert.equal(verifySignature(RAW, validSig), false));
process.env.LINE_CHANNEL_SECRET = origSecret;

// --- sendMessage MOCK behavior ---
process.env.LINE_MOCK = '1';
await expectAsync('LINE_MOCK=1 → { ok: true }', async () => {
  const r = await sendMessage('Ufake', 'hello');
  assert.deepEqual(r, { ok: true });
});

process.env.LINE_MOCK = 'fail';
await expectAsync('LINE_MOCK=fail → { ok: false, error: mock_fail }', async () => {
  const r = await sendMessage('Ufake', 'hello');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mock_fail');
});

delete process.env.LINE_MOCK;
const origToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
await expectAsync('missing access token → { ok: false, error: line_not_configured }', async () => {
  const r = await sendMessage('Ufake', 'hello');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'line_not_configured');
});
if (origToken) process.env.LINE_CHANNEL_ACCESS_TOKEN = origToken;

console.log('[lineClient test] done');
```

- [ ] **Step 2.2: Run test, verify it fails**

```bash
node tests/lineClient.test.js
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...src/services/lineClient.js'`.

- [ ] **Step 2.3: Implement `src/services/lineClient.js`**

Create:

```javascript
// LINE Messaging API thin wrapper. Zero npm deps — uses native fetch + node:crypto.
// All public functions are mock-aware via process.env.LINE_MOCK so tests can run
// the full notify path without hitting line.me.
import { createHmac, timingSafeEqual } from 'node:crypto';

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

/**
 * Send a push message to a single LINE user.
 * Returns { ok: true } on 2xx, { ok: false, error } otherwise.
 * Never throws — caller decides retry behavior from the return value.
 */
export async function sendMessage(lineUserId, text) {
  if (process.env.LINE_MOCK === '1') return { ok: true };
  if (process.env.LINE_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, error: 'line_not_configured' };
  }
  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: 'text', text }],
      }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}

/**
 * Reply to a webhook event using its one-shot replyToken.
 * Reply API doesn't consume the 1000/month push quota.
 */
export async function reply(replyToken, text) {
  if (process.env.LINE_MOCK === '1') return { ok: true };
  if (process.env.LINE_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, error: 'line_not_configured' };
  }
  try {
    const res = await fetch(REPLY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text }],
      }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}

/**
 * Verify the X-Line-Signature header against the raw request body.
 * LINE_MOCK=1 bypasses (tests).
 */
export function verifySignature(rawBody, signatureHeader) {
  if (process.env.LINE_MOCK === '1') return true;
  if (!signatureHeader || !process.env.LINE_CHANNEL_SECRET) return false;
  let expected;
  try {
    expected = createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest('base64');
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
```

- [ ] **Step 2.4: Run test, verify it passes**

```bash
node tests/lineClient.test.js
```

Expected: all ✓, exit 0.

- [ ] **Step 2.5: Commit**

```bash
git add src/services/lineClient.js tests/lineClient.test.js
git commit -m "feat(service): add lineClient (Push / Reply / HMAC verify)

Native fetch + node:crypto, no @line/bot-sdk dep. All three functions
mock-aware via LINE_MOCK env so tests and dev environments can run the
full path without hitting line.me.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `lineBindingService.js` — binding state machine

**Files:**
- Create: `src/services/lineBindingService.js`
- Test: `tests/lineBindingService.test.js` (flow-style)

- [ ] **Step 3.1: Write the failing test**

Create `tests/lineBindingService.test.js`:

```javascript
// Phase 3C · lineBindingService flow verification
import assert from 'node:assert/strict';
import { db, nowLocal, offsetLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { generateBindCode, consumeCode, unbindByLineUserId } from '../src/services/lineBindingService.js';

function reset() {
  db.exec(`DELETE FROM users WHERE email LIKE 'line-bind-test-%';`);
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

console.log('[line-binding test] start');
reset();

const userA = createMember('A', 'line-bind-test-a@chinup.local');
const userB = createMember('B', 'line-bind-test-b@chinup.local');

// --- generateBindCode ---
const gen = generateBindCode(userA);
expect('code is 6-digit string', () => assert(/^\d{6}$/.test(gen.code)));
expect('expires_at is future', () => assert(gen.expires_at > nowLocal()));
const aRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userA);
expect('code written to user', () => assert.equal(aRow.line_bind_code, gen.code));
expect('expires_at written to user', () => assert.equal(aRow.line_bind_expires_at, gen.expires_at));

// --- consumeCode: invalid code ---
const r1 = consumeCode('000000', 'Uinvalid');
expect('unknown code → invalid_code', () => assert.equal(r1.outcome, 'invalid_code'));

// --- consumeCode: expired ---
db.prepare("UPDATE users SET line_bind_expires_at = ? WHERE id = ?")
  .run('2020-01-01T00:00:00', userA);
const r2 = consumeCode(gen.code, 'Uexpired');
expect('expired code → invalid_code', () => assert.equal(r2.outcome, 'invalid_code'));

// Restore A with a fresh code
const gen2 = generateBindCode(userA);

// --- consumeCode: bound (happy path) ---
const r3 = consumeCode(gen2.code, 'Ulinea-real');
expect('happy → outcome=bound', () => assert.equal(r3.outcome, 'bound'));
const aAfter = db.prepare('SELECT * FROM users WHERE id = ?').get(userA);
expect('line_user_id written', () => assert.equal(aAfter.line_user_id, 'Ulinea-real'));
expect('bind_code cleared', () => assert.equal(aAfter.line_bind_code, null));
expect('bind_expires_at cleared', () => assert.equal(aAfter.line_bind_expires_at, null));

// --- consumeCode: chinup_already_bound ---
const gen3 = generateBindCode(userA);  // A is already bound; try to bind again
const r4 = consumeCode(gen3.code, 'Uanother');
expect('already-bound chinup → chinup_already_bound', () => assert.equal(r4.outcome, 'chinup_already_bound'));

// --- consumeCode: this_line_already_bound ---
const gen4 = generateBindCode(userB);
const r5 = consumeCode(gen4.code, 'Ulinea-real');  // same LINE that bound A
expect('LINE-ID taken → this_line_already_bound', () => assert.equal(r5.outcome, 'this_line_already_bound'));

// --- unbindByLineUserId ---
unbindByLineUserId('Ulinea-real');
const aAfterUnbind = db.prepare('SELECT * FROM users WHERE id = ?').get(userA);
expect('unbind clears line_user_id', () => assert.equal(aAfterUnbind.line_user_id, null));

// --- unbindByLineUserId on unknown id is no-op ---
unbindByLineUserId('Unone');
expect('unbind unknown is no-op', () => assert(true));

console.log('[line-binding test] done');
```

- [ ] **Step 3.2: Run test, verify it fails**

```bash
node tests/lineBindingService.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3.3: Implement `src/services/lineBindingService.js`**

Create:

```javascript
// LINE binding state machine.
// Code lifecycle: generated by user (15 min expiry) → consumed by webhook
// when user texts the bot. State stored on users table.
import { db, tx, nowLocal, offsetLocal } from '../db/connection.js';

const BIND_TTL_MINUTES = 15;
const CODE_GEN_RETRY = 10;

const getByCode = db.prepare(`
  SELECT id, line_user_id, line_bind_expires_at
  FROM users WHERE line_bind_code = ?
`);
const getByLineId = db.prepare('SELECT id FROM users WHERE line_user_id = ?');
const updateBindCode = db.prepare(`
  UPDATE users SET line_bind_code = ?, line_bind_expires_at = ? WHERE id = ?
`);
const completeBind = db.prepare(`
  UPDATE users
  SET line_user_id = ?, line_bind_code = NULL, line_bind_expires_at = NULL
  WHERE id = ?
`);
const clearLineByLineId = db.prepare(`
  UPDATE users SET line_user_id = NULL WHERE line_user_id = ?
`);
const clearLineByUserId = db.prepare(`
  UPDATE users
  SET line_user_id = NULL, line_bind_code = NULL, line_bind_expires_at = NULL
  WHERE id = ?
`);

function randomSixDigit() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Generate a new 6-digit binding code for the given user.
 * Stores code + expiry on users row. Returns { code, expires_at }.
 */
export function generateBindCode(userId) {
  return tx(() => {
    let code;
    for (let attempt = 0; attempt < CODE_GEN_RETRY; attempt++) {
      code = randomSixDigit();
      const dup = getByCode.get(code);
      if (!dup) break;
    }
    const expiresAt = offsetLocal(BIND_TTL_MINUTES * 60 * 1000);
    updateBindCode.run(code, expiresAt, userId);
    return { code, expires_at: expiresAt };
  });
}

/**
 * Webhook handler calls this when user texts a 6-digit code to the bot.
 * Returns one of:
 *   { outcome: 'bound', userId }
 *   { outcome: 'invalid_code' }
 *   { outcome: 'chinup_already_bound' }
 *   { outcome: 'this_line_already_bound' }
 */
export function consumeCode(code, lineUserId) {
  return tx(() => {
    const user = getByCode.get(code);
    if (!user) return { outcome: 'invalid_code' };
    if (!user.line_bind_expires_at || user.line_bind_expires_at < nowLocal()) {
      return { outcome: 'invalid_code' };
    }
    if (user.line_user_id) return { outcome: 'chinup_already_bound' };

    const occupier = getByLineId.get(lineUserId);
    if (occupier) return { outcome: 'this_line_already_bound' };

    completeBind.run(lineUserId, user.id);
    return { outcome: 'bound', userId: user.id };
  });
}

/**
 * Clear line_user_id for the chinup user bound to this LINE userId.
 * Called from webhook on `unfollow` event (user blocked / removed bot)
 * and from DELETE /api/my/line.
 */
export function unbindByLineUserId(lineUserId) {
  clearLineByLineId.run(lineUserId);
}

/**
 * Clear everything for the given chinup user.
 * Called from DELETE /api/my/line.
 */
export function unbindByUserId(userId) {
  clearLineByUserId.run(userId);
}
```

- [ ] **Step 3.4: Run test, verify it passes**

```bash
node tests/lineBindingService.test.js
```

Expected: all ✓.

- [ ] **Step 3.5: Commit**

```bash
git add src/services/lineBindingService.js tests/lineBindingService.test.js
git commit -m "feat(service): add lineBindingService (4-outcome state machine)

generateBindCode: random 6-digit + 15-min expiry, written to users row.
consumeCode: returns bound | invalid_code | chinup_already_bound |
this_line_already_bound, all inside a single transaction.
unbindByLineUserId / unbindByUserId: clear binding state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `notifications.js` rewrite + retry cron

**Files:**
- Modify: `src/services/notifications.js` (full rewrite)
- Modify: `src/scheduler.js` (one new cron line)
- Test: `tests/notifications-flow.test.js`

- [ ] **Step 4.1: Write the failing test**

Create `tests/notifications-flow.test.js`:

```javascript
// Phase 3C · notifications.js flow verification (mock LINE)
// IMPORTANT: must set LINE_MOCK BEFORE importing services so they see it
//            on their first env read. (notify calls read env at call-time
//            so this is belt-and-suspenders; works either way.)
process.env.LINE_MOCK = '1';

import assert from 'node:assert/strict';
import { db, nowLocal, offsetLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import {
  notify,
  processFailedNotifications,
  fmtDateForLine,
} from '../src/services/notifications.js';

function reset() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (
      SELECT id FROM users WHERE email LIKE 'notif-test-%'
    );
    DELETE FROM users WHERE email LIKE 'notif-test-%';
  `);
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
async function expectAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

function makeMember(name, email, lineUserId = null) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role, line_user_id) VALUES (?, ?, ?, 'user', ?)"
  ).run(name, email, hashPassword('pass1234'), lineUserId);
  return info.lastInsertRowid;
}

console.log('[notifications-flow test] start');
reset();

// --- [1] fmtDateForLine ---
expect('fmtDateForLine renders human-friendly text', () => {
  const out = fmtDateForLine('2026-05-20T14:30:00');
  // Expect something like "5/20（週三）14:30"
  assert(out.includes('5/20'));
  assert(out.includes('14:30'));
});

// --- [2] notify with LINE-bound user → status=sent, channel=line ---
const bound = makeMember('Bound', 'notif-test-bound@chinup.local', 'Ufake-bound');
notify({
  userId: bound,
  sessionId: null,
  type: 'registered_confirmed',
  vars: { course_name: 'TRX', start_at: 'X' },
});
// Allow the async deliverLine to settle. Mock returns sync-ish but uses
// await — give one tick.
await new Promise((r) => setImmediate(r));
const row1 = db.prepare(
  'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
).get(bound);
expect('LINE-bound user gets channel=line', () => assert.equal(row1.channel, 'line'));
expect('LINE-bound user gets status=sent', () => assert.equal(row1.status, 'sent'));

// --- [3] notify with unbound user → channel=console ---
const unbound = makeMember('Unbound', 'notif-test-unbound@chinup.local');
notify({
  userId: unbound,
  sessionId: null,
  type: 'registered_confirmed',
  vars: { course_name: 'TRX', start_at: 'X' },
});
const row2 = db.prepare(
  'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
).get(unbound);
expect('Unbound user → channel=console, status=sent', () =>
  assert.equal(row2.channel, 'console') || assert.equal(row2.status, 'sent'));

// --- [4] LINE_MOCK=fail → status=failed, retry_count=0, next_retry_at=+5min ---
process.env.LINE_MOCK = 'fail';
notify({
  userId: bound,
  sessionId: null,
  type: 'registered_confirmed',
  vars: { course_name: 'TRX', start_at: 'X' },
});
await new Promise((r) => setImmediate(r));
const row3 = db.prepare(
  'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
).get(bound);
expect('failure → status=failed', () => assert.equal(row3.status, 'failed'));
expect('failure → retry_count=0', () => assert.equal(row3.retry_count, 0));
expect('failure → next_retry_at set', () => assert(row3.next_retry_at > nowLocal()));
expect('failure → last_error set', () => assert(row3.last_error));
process.env.LINE_MOCK = '1';

// --- [5] processFailedNotifications: due-failed row gets retried ---
// Set the failed row's next_retry_at to past so the cron picks it up
db.prepare('UPDATE notifications SET next_retry_at = ? WHERE id = ?')
  .run('2020-01-01T00:00:00', row3.id);
await processFailedNotifications();
const row3After = db.prepare('SELECT * FROM notifications WHERE id = ?').get(row3.id);
expect('retry: failed → sent under LINE_MOCK=1', () => assert.equal(row3After.status, 'sent'));
expect('retry: next_retry_at cleared', () => assert.equal(row3After.next_retry_at, null));

// --- [6] retry exhaustion → failed_permanent ---
// Manufacture a row already at retry_count=3
const exhaustedId = db.prepare(`
  INSERT INTO notifications (user_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, 'registered_confirmed', 'line', 'subj', 'body', 'failed', 3, ?, 'prev-error')
`).run(bound, '2020-01-01T00:00:00').lastInsertRowid;
process.env.LINE_MOCK = 'fail';
await processFailedNotifications();
const exhausted = db.prepare('SELECT * FROM notifications WHERE id = ?').get(exhaustedId);
expect('retry > MAX → failed_permanent', () => assert.equal(exhausted.status, 'failed_permanent'));
expect('failed_permanent: next_retry_at NULL', () => assert.equal(exhausted.next_retry_at, null));
process.env.LINE_MOCK = '1';

// --- [7] user unbound between failure and retry → failed_permanent ---
const wasBoundId = db.prepare(`
  INSERT INTO notifications (user_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, 'registered_confirmed', 'line', 'subj', 'body', 'failed', 0, ?, 'prev')
`).run(unbound, '2020-01-01T00:00:00').lastInsertRowid;  // unbound user
await processFailedNotifications();
const wasBound = db.prepare('SELECT * FROM notifications WHERE id = ?').get(wasBoundId);
expect('unbound user retry → failed_permanent', () => assert.equal(wasBound.status, 'failed_permanent'));

// --- [8] backoff schedule on retry: retry_count 1 → +5min, 2 → +15min, 3 → +45min ---
// Set up a fresh failed row at retry_count=0, force fail again, check retry_count=1 + ~5min
const backoffId = db.prepare(`
  INSERT INTO notifications (user_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, 'registered_confirmed', 'line', 'subj', 'body', 'failed', 0, ?, 'prev')
`).run(bound, '2020-01-01T00:00:00').lastInsertRowid;
process.env.LINE_MOCK = 'fail';
const beforeRetry1 = nowLocal();
await processFailedNotifications();
const after1 = db.prepare('SELECT * FROM notifications WHERE id = ?').get(backoffId);
expect('first retry bumps retry_count to 1', () => assert.equal(after1.retry_count, 1));
expect('first retry next_retry_at > now', () => assert(after1.next_retry_at > beforeRetry1));
process.env.LINE_MOCK = '1';

// --- [9] all four booking templates render correctly under LINE_MOCK=1 ---
[
  ['booking_created',            { member_name: '王小明', start_at: '5/20（週三）14:00' }],
  ['booking_confirmed',          { coach_display_name: '李教練', start_at: '5/20（週三）14:00' }],
  ['booking_cancelled_by_member',{ member_name: '王小明', start_at: '5/20（週三）14:00' }],
  ['booking_cancelled_by_coach', { coach_display_name: '李教練', start_at: '5/20（週三）14:00' }],
].forEach(([type, vars]) => {
  notify({ userId: bound, sessionId: null, type, vars });
});
await new Promise((r) => setImmediate(r));
const four = db.prepare(
  "SELECT type FROM notifications WHERE user_id = ? AND type LIKE 'booking_%' ORDER BY id"
).all(bound).map((r) => r.type);
expect('4 booking templates inserted', () => assert.equal(four.length, 4));
expect('types match', () => assert.deepEqual(four, [
  'booking_created', 'booking_confirmed',
  'booking_cancelled_by_member', 'booking_cancelled_by_coach',
]));

// --- [10] unknown type throws ---
expect('unknown type throws', () => {
  assert.throws(() => notify({ userId: bound, type: 'nonexistent', vars: {} }), /unknown/);
});

console.log('[notifications-flow test] done');
```

- [ ] **Step 4.2: Run test, verify it fails**

```bash
node tests/notifications-flow.test.js
```

Expected: many ✗ — the new `processFailedNotifications` export and rewrite haven't happened yet.

- [ ] **Step 4.3: Rewrite `src/services/notifications.js`**

Replace the entire file with:

```javascript
// Phase 3C notifications dispatcher.
// Single entry point notify({ userId, type, vars }) — internally picks
// a delivery channel based on the user's binding state:
//   user.line_user_id present → LINE Push (via lineClient.sendMessage)
//   otherwise                  → console.log fallback (dev / unbound user)
//
// Failed LINE pushes are stored with status='failed' + a backoff schedule
// and retried by processFailedNotifications() (called from scheduler cron).
import { db, nowLocal, offsetLocal } from '../db/connection.js';
import { sendMessage } from './lineClient.js';

// ─────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────

const TEMPLATES = {
  // === existing 7 (group class) ===
  registered_confirmed: {
    subject: '報名成功 - {{course_name}}',
    body: '您已成功報名 {{course_name}}（{{start_at}}），期待與您相見！',
  },
  registered_waitlisted: {
    subject: '已進候補 - {{course_name}}',
    body: '您報名的 {{course_name}} 目前已額滿，您為候補第 {{position}} 位。如有正取取消將自動遞補並另行通知。',
  },
  promoted: {
    subject: '恭喜遞補成功 - {{course_name}}',
    body: '您候補的 {{course_name}}（{{start_at}}）有人取消，您已遞補為正取。',
  },
  course_confirmed: {
    subject: '課程成立 - {{course_name}}',
    body: '{{course_name}}（{{start_at}}）已達開課人數，課程確認開課。',
  },
  course_cancelled: {
    subject: '課程取消 - {{course_name}}',
    body: '很抱歉，{{course_name}}（{{start_at}}）因未達開課人數，本次取消。',
  },
  reminder: {
    subject: '上課提醒 - {{course_name}}',
    body: '提醒您，{{course_name}} 將於 {{start_at}} 開始，請準時抵達。',
  },
  registration_cancelled: {
    subject: '報名已取消 - {{course_name}}',
    body: '您已成功取消 {{course_name}}（{{start_at}}）的報名。',
  },

  // === new 4 (Phase 3C, 1-on-1 booking) ===
  booking_created: {  // 寄給教練
    subject: '新一對一預約 - {{member_name}}',
    body: '🏋️ {{member_name}} 預約了 {{start_at}} 的一對一課程。',
  },
  booking_confirmed: {  // 寄給會員
    subject: '一對一預約成功 - {{coach_display_name}}',
    body: '✅ 已成功預約 {{coach_display_name}} 教練的 {{start_at}} 課程。',
  },
  booking_cancelled_by_member: {  // 寄給教練
    subject: '會員取消預約 - {{member_name}}',
    body: '⚠️ {{member_name}} 取消了 {{start_at}} 的一對一預約。',
  },
  booking_cancelled_by_coach: {  // 寄給會員
    subject: '教練取消預約 - {{coach_display_name}}',
    body: '⚠️ {{coach_display_name}} 教練取消了你 {{start_at}} 的預約，點數已退回。',
  },
};

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * Format a local-wall-clock datetime ('2026-05-20T14:30:00') for LINE:
 * "5/20（週三）14:30"
 */
export function fmtDateForLine(localStr) {
  // localStr is "YYYY-MM-DDTHH:MM:SS" — parse manually (don't rely on Date
  // timezone behavior since the stored value is wall-clock).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localStr || '');
  if (!m) return localStr || '';
  const [, , month, day, hh, mm] = m;
  // Compute day-of-week via UTC midnight (matches schedule.js convention)
  const dt = new Date(`${m[1]}-${month}-${day}T00:00:00Z`);
  const dow = DOW_SHORT[dt.getUTCDay()];
  return `${Number(month)}/${Number(day)}（週${dow}）${hh}:${mm}`;
}

// ─────────────────────────────────────────────────────────────────────
// Prepared statements
// ─────────────────────────────────────────────────────────────────────

const getUserById = db.prepare('SELECT id, line_user_id FROM users WHERE id = ?');

const insertNotif = db.prepare(`
  INSERT INTO notifications
    (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectDueFailed = db.prepare(`
  SELECT id, user_id, session_id, type, body, retry_count
  FROM notifications
  WHERE status = 'failed' AND next_retry_at <= ?
  ORDER BY next_retry_at ASC
  LIMIT 100
`);

const updateSent = db.prepare(`
  UPDATE notifications
  SET status = 'sent', next_retry_at = NULL, last_error = NULL
  WHERE id = ?
`);

const updateFailedAgain = db.prepare(`
  UPDATE notifications
  SET retry_count = ?, next_retry_at = ?, last_error = ?
  WHERE id = ?
`);

const updateFailedPermanent = db.prepare(`
  UPDATE notifications
  SET status = 'failed_permanent', next_retry_at = NULL, last_error = ?
  WHERE id = ?
`);

// ─────────────────────────────────────────────────────────────────────
// Retry policy
// ─────────────────────────────────────────────────────────────────────

const BACKOFF_MINUTES = [5, 15, 45];  // for retry_count 1, 2, 3
const MAX_RETRIES = 3;

function nextBackoffAt(newRetryCount) {
  const minutes = BACKOFF_MINUTES[newRetryCount - 1];
  return offsetLocal(minutes * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * notify — single entry point used by all callers.
 * Fire-and-forget: returns undefined synchronously, async delivery
 * happens in background. Errors are swallowed (recorded in DB).
 */
export function notify({ userId, sessionId, type, vars = {} }) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`unknown notification type: ${type}`);

  const subject = render(tpl.subject, vars);
  const body = render(tpl.body, vars);

  const user = getUserById.get(userId);
  if (!user) return;  // deleted user → silent skip

  if (user.line_user_id) {
    // async — don't block caller. Caller (e.g. registration.js) is already
    // in a tx; we don't await so the tx isn't held open during the HTTP call.
    deliverLine({ userId, sessionId, type, subject, body, lineUserId: user.line_user_id })
      .catch((e) => console.error('[notify deliverLine threw]', e));
  } else {
    deliverConsole({ userId, sessionId, type, subject, body });
  }
}

async function deliverLine({ userId, sessionId, type, subject, body, lineUserId }) {
  const result = await sendMessage(lineUserId, body);
  if (result.ok) {
    insertNotif.run(userId, sessionId, type, 'line', subject, body, 'sent', 0, null, null);
  } else {
    insertNotif.run(
      userId, sessionId, type, 'line', subject, body,
      'failed', 0, offsetLocal(BACKOFF_MINUTES[0] * 60 * 1000), result.error
    );
  }
}

function deliverConsole({ userId, sessionId, type, subject, body }) {
  insertNotif.run(userId, sessionId, type, 'console', subject, body, 'sent', 0, null, null);
  console.log(`[notify→console] user=${userId} type=${type} ${subject}`);
}

/**
 * Cron worker. Picks failed rows whose next_retry_at is past, attempts
 * delivery via LINE, then updates status.
 */
export async function processFailedNotifications() {
  const due = selectDueFailed.all(nowLocal());

  for (const row of due) {
    const user = getUserById.get(row.user_id);
    if (!user?.line_user_id) {
      // user removed binding (or was deleted) → no point retrying
      updateFailedPermanent.run('user_not_bound', row.id);
      continue;
    }

    const result = await sendMessage(user.line_user_id, row.body);

    if (result.ok) {
      updateSent.run(row.id);
    } else {
      const newRetryCount = row.retry_count + 1;
      if (newRetryCount > MAX_RETRIES) {
        updateFailedPermanent.run(result.error, row.id);
      } else {
        updateFailedAgain.run(newRetryCount, nextBackoffAt(newRetryCount), result.error, row.id);
      }
    }
  }
}
```

- [ ] **Step 4.4: Add cron schedule to `src/scheduler.js`**

Find the existing cron schedule block in `src/scheduler.js`. Add this import at the top of the imports section:

```javascript
import { processFailedNotifications } from './services/notifications.js';
```

Add a new cron schedule inside the `startScheduler()` function (or wherever existing `cron.schedule(...)` calls live):

```javascript
cron.schedule('*/5 * * * *', async () => {
  try {
    await processFailedNotifications();
  } catch (e) {
    console.error('[cron] processFailedNotifications failed:', e);
  }
});
```

- [ ] **Step 4.5: Restart server + run test**

```bash
SERVER_PID=$(lsof -ti :3000 2>/dev/null)
[ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
node tests/notifications-flow.test.js
```

Expected: all ✓.

- [ ] **Step 4.6: Confirm regression**

```bash
node tests/my-schedule-api.test.js 2>&1 | tail -2
node tests/lineClient.test.js 2>&1 | tail -2
node tests/lineBindingService.test.js 2>&1 | tail -2
```

Expected: all pass.

- [ ] **Step 4.7: Commit**

```bash
git add src/services/notifications.js src/scheduler.js tests/notifications-flow.test.js
git commit -m "feat(notify): real LINE dispatch + retry cron (Phase 3C)

Rewrite notifications.js: single notify() entry, dispatches to LINE
(if user.line_user_id present) or console (fallback). Failed LINE
pushes are persisted with status=failed + exponential backoff
schedule (5/15/45 min, then failed_permanent).

processFailedNotifications cron worker picks due-failed rows every
5 minutes via scheduler.js, retries via lineClient, updates status.

Adds 4 booking templates and fmtDateForLine() helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `bookingService` notify hooks (gap fill from Phase 1)

**Files:**
- Modify: `src/services/bookingService.js`
- Modify: `tests/booking-flow.test.js`

- [ ] **Step 5.1: Add LINE_MOCK to booking-flow test setup**

At the very top of `tests/booking-flow.test.js`, BEFORE any imports:

```javascript
process.env.LINE_MOCK = '1';
```

This must be the first executable line so all subsequent imports see it.

- [ ] **Step 5.2: Add `notify` import + 2 notify calls in `createBooking`**

In `src/services/bookingService.js`, add at top with other imports:

```javascript
import { notify, fmtDateForLine } from './notifications.js';
```

Find the `createBooking` function. After the booking row is inserted and point is deducted (i.e. inside the tx, just before `return { bookingId: result.lastInsertRowid }` or equivalent), add:

```javascript
// Phase 3C: notify coach + member
const coachRow = db.prepare(
  'SELECT c.user_id, c.display_name FROM coaches c WHERE c.id = ?'
).get(coachId);
const memberRow = db.prepare('SELECT name FROM users WHERE id = ?').get(memberId);

if (coachRow && memberRow) {
  const startFmt = fmtDateForLine(startAt);
  notify({
    userId: coachRow.user_id,
    sessionId: null,
    type: 'booking_created',
    vars: { member_name: memberRow.name, start_at: startFmt },
  });
  notify({
    userId: memberId,
    sessionId: null,
    type: 'booking_confirmed',
    vars: { coach_display_name: coachRow.display_name, start_at: startFmt },
  });
}
```

- [ ] **Step 5.3: Add 2 notify calls in `cancelBooking`**

In the same file, find `cancelBooking`. After point refund and booking status update, before the return, add:

```javascript
// Phase 3C: notify the OTHER party (the one who didn't cancel)
const coachRow2 = db.prepare(
  'SELECT c.user_id, c.display_name FROM coaches c WHERE c.id = ?'
).get(booking.coach_id);
const memberRow2 = db.prepare('SELECT name FROM users WHERE id = ?').get(booking.member_id);

if (coachRow2 && memberRow2) {
  const startFmt2 = fmtDateForLine(booking.start_at);
  const isCoachCancel = actorUserId === coachRow2.user_id;
  if (isCoachCancel) {
    notify({
      userId: booking.member_id,
      sessionId: null,
      type: 'booking_cancelled_by_coach',
      vars: { coach_display_name: coachRow2.display_name, start_at: startFmt2 },
    });
  } else {
    notify({
      userId: coachRow2.user_id,
      sessionId: null,
      type: 'booking_cancelled_by_member',
      vars: { member_name: memberRow2.name, start_at: startFmt2 },
    });
  }
}
```

(`actorUserId` is the parameter name in the existing `cancelBooking({ bookingId, actorUserId, isCoach, reason })` signature — verified at `src/services/bookingService.js:62`.)

- [ ] **Step 5.4: Add a booking-flow assertion**

In `tests/booking-flow.test.js`, find the existing test block that creates a booking. After the booking is created, add:

```javascript
expect('booking_created notification row exists', () => {
  const r = db.prepare(
    "SELECT * FROM notifications WHERE type='booking_created' ORDER BY id DESC LIMIT 1"
  ).get();
  assert(r, 'expected a booking_created notification row');
  assert.equal(r.channel, 'console');  // test users are not LINE-bound
});
```

(If the file already creates and cancels bookings, optionally add similar assertions for the 3 other booking types — but one assertion is enough to confirm wiring works.)

- [ ] **Step 5.5: Run tests**

```bash
node tests/booking-flow.test.js 2>&1 | tail -5
node tests/notifications-flow.test.js 2>&1 | tail -2
node tests/my-schedule-api.test.js 2>&1 | tail -2
```

Expected: all pass.

- [ ] **Step 5.6: Commit**

```bash
git add src/services/bookingService.js tests/booking-flow.test.js
git commit -m "feat(booking): wire up notifications for 1-on-1 bookings (Phase 3C)

Phase 1 left this gap — createBooking and cancelBooking emitted no
notifications. Adds 4 notify() call sites covering both parties for
both operations. test booking-flow now asserts at least one booking
notification row is created.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: HTTP endpoints — webhook + 3 `/api/my/line/*`

**Files:**
- Modify: `src/server.js`
- Test: `tests/line-webhook-api.test.js`

- [ ] **Step 6.1: Write the failing HTTP test**

Create `tests/line-webhook-api.test.js`:

```javascript
// Phase 3C · HTTP integration tests for LINE webhook + binding endpoints.
// Runs against the live server on :3000. Server must have LINE_MOCK=1
// in env to make this test deterministic.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token, raw = false, headers: extraHeaders } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, location: res.headers.get('location') };
}

async function loginAs(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
  return r.data;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
async function expectAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[line-webhook-api test] start');

// Use user1 as our test subject. Clear any prior binding state.
db.prepare(`
  UPDATE users SET line_user_id = NULL, line_bind_code = NULL, line_bind_expires_at = NULL
  WHERE email = 'user1@chinup.local'
`).run();
db.prepare(`
  UPDATE users SET line_user_id = NULL WHERE line_user_id LIKE 'Utest-%'
`).run();

const user1 = await loginAs('user1@chinup.local', 'pass1234');

// --- GET /api/my/line/binding (unbound) ---
const b1 = await req('GET', '/api/my/line/binding', { token: user1.token });
expect('GET binding (unbound) → 200', () => assert.equal(b1.status, 200));
expect('bound=false', () => assert.equal(b1.data.bound, false));
expect('code is 6-digit', () => assert(/^\d{6}$/.test(b1.data.code)));
expect('expires_at present', () => assert(b1.data.expires_at));
const firstCode = b1.data.code;

// --- POST /api/my/line/regenerate ---
const reg = await req('POST', '/api/my/line/regenerate', { token: user1.token });
expect('regenerate → 200', () => assert.equal(reg.status, 200));
expect('new code differs', () => assert.notEqual(reg.data.code, firstCode));
const newCode = reg.data.code;

// --- POST /api/line/webhook with no signature (LINE_MOCK=1 server bypasses, so set MOCK off via signature path)
// We test signature rejection by sending a non-MOCK request — but server is set to LINE_MOCK=1
// for these tests. Instead, we test the happy path under MOCK.

// --- POST /api/line/webhook with valid event (binding) ---
const wb = await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'message',
      message: { type: 'text', text: newCode },
      source: { type: 'user', userId: 'Utest-user1' },
      replyToken: 'reply-token-fake',
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig-bypassed' },
});
expect('webhook → 200', () => assert.equal(wb.status, 200));

// Verify DB updated
const u1 = db.prepare(
  "SELECT line_user_id, line_bind_code FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('line_user_id set after webhook', () => assert.equal(u1.line_user_id, 'Utest-user1'));
expect('line_bind_code cleared', () => assert.equal(u1.line_bind_code, null));

// --- GET /api/my/line/binding (now bound) ---
const b2 = await req('GET', '/api/my/line/binding', { token: user1.token });
expect('bound=true after binding', () => assert.equal(b2.data.bound, true));
expect('no code returned when bound', () => assert.equal(b2.data.code, undefined));

// --- DELETE /api/my/line ---
const del = await req('DELETE', '/api/my/line', { token: user1.token });
expect('delete → 200', () => assert.equal(del.status, 200));
const u1After = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('line_user_id cleared after delete', () => assert.equal(u1After.line_user_id, null));

// --- webhook: invalid code → no error, no binding ---
const u1Pre = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
const wbBad = await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'message',
      message: { type: 'text', text: '000000' },
      source: { type: 'user', userId: 'Utest-bad' },
      replyToken: 'rtok-bad',
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig' },
});
expect('webhook invalid code → 200', () => assert.equal(wbBad.status, 200));
const u1NoChange = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('invalid code did not bind', () => assert.equal(u1NoChange.line_user_id, u1Pre.line_user_id));

// --- webhook: unfollow event → unbind ---
// First, bind user1 again to test unbind
const b3 = await req('GET', '/api/my/line/binding', { token: user1.token });
const codeForUnfollow = b3.data.code;
await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'message',
      message: { type: 'text', text: codeForUnfollow },
      source: { type: 'user', userId: 'Utest-followtest' },
      replyToken: 'rtok-1',
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig' },
});
const beforeUnfollow = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('rebound for unfollow test', () => assert.equal(beforeUnfollow.line_user_id, 'Utest-followtest'));

await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'unfollow',
      source: { type: 'user', userId: 'Utest-followtest' },
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig' },
});
const afterUnfollow = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('unfollow cleared line_user_id', () => assert.equal(afterUnfollow.line_user_id, null));

console.log('[line-webhook-api test] done');
```

- [ ] **Step 6.2: Run test, verify it fails**

```bash
node tests/line-webhook-api.test.js
```

Expected: 404s or similar on the new endpoints.

- [ ] **Step 6.3: Modify `express.json` middleware in `src/server.js`**

Find this line (around line 57):

```javascript
app.use(express.json({ limit: '3mb' }));
```

Replace with:

```javascript
app.use(express.json({
  limit: '3mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
```

(`req.rawBody` is the original `Buffer` — needed for LINE webhook HMAC verification.)

- [ ] **Step 6.4: Add new imports to `src/server.js`**

After the existing service imports (around line 50), add:

```javascript
import { verifySignature, reply as lineReply } from './services/lineClient.js';
import {
  generateBindCode,
  consumeCode,
  unbindByLineUserId,
  unbindByUserId,
} from './services/lineBindingService.js';
```

- [ ] **Step 6.5: Add the 4 endpoints in `src/server.js`**

Pick a section near the other `/api/my/*` routes (e.g. after `/api/my/bookings` or `/api/my/schedule`). Add:

```javascript
// ─── Phase 3C · LINE notification endpoints ───

app.get('/api/my/line/binding', requireUser, asyncHandler((req, res) => {
  const user = db.prepare(
    'SELECT line_user_id, line_bind_code, line_bind_expires_at FROM users WHERE id = ?'
  ).get(req.user.id);

  const officialAccountId = process.env.LINE_OFFICIAL_ACCOUNT_ID || null;

  if (user.line_user_id) {
    return res.json({ bound: true, official_account_id: officialAccountId });
  }

  // Unbound: return existing valid code or auto-generate
  const codeValid = user.line_bind_code &&
                    user.line_bind_expires_at &&
                    user.line_bind_expires_at > nowLocal();
  if (codeValid) {
    return res.json({
      bound: false,
      code: user.line_bind_code,
      expires_at: user.line_bind_expires_at,
      official_account_id: officialAccountId,
    });
  }
  const fresh = generateBindCode(req.user.id);
  res.json({
    bound: false,
    code: fresh.code,
    expires_at: fresh.expires_at,
    official_account_id: officialAccountId,
  });
}));

app.post('/api/my/line/regenerate', requireUser, asyncHandler((req, res) => {
  const fresh = generateBindCode(req.user.id);
  res.json({ code: fresh.code, expires_at: fresh.expires_at });
}));

app.delete('/api/my/line', requireUser, asyncHandler((req, res) => {
  unbindByUserId(req.user.id);
  res.json({ ok: true });
}));

app.post('/api/line/webhook', (req, res) => {
  // Verify HMAC signature (LINE_MOCK=1 bypasses inside verifySignature)
  if (!verifySignature(req.rawBody, req.header('X-Line-Signature'))) {
    return res.status(401).end();
  }

  const events = Array.isArray(req.body?.events) ? req.body.events : [];

  for (const event of events) {
    try {
      if (event.type === 'message' && event.message?.type === 'text') {
        handleLineTextMessage(event);
      } else if (event.type === 'follow') {
        // user added the bot as friend — point them to the website
        lineReply(event.replyToken, '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。')
          .catch((e) => console.error('[line follow reply]', e));
      } else if (event.type === 'unfollow') {
        unbindByLineUserId(event.source?.userId);
      }
    } catch (e) {
      console.error('[line-webhook event handler]', e);
    }
  }

  // Always 200 so LINE doesn't retry
  res.status(200).end();
});

function handleLineTextMessage(event) {
  const text = (event.message?.text || '').trim();
  const lineUserId = event.source?.userId;
  const replyToken = event.replyToken;
  if (!lineUserId || !replyToken) return;

  if (!/^\d{6}$/.test(text)) {
    lineReply(replyToken, '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。')
      .catch((e) => console.error('[line nonmatch reply]', e));
    return;
  }

  const result = consumeCode(text, lineUserId);
  let msg;
  switch (result.outcome) {
    case 'bound':
      msg = '✅ 綁定成功！日後課程通知會送到這裡。';
      break;
    case 'invalid_code':
      msg = '❌ 代碼無效或已過期，請回網站重新產生。';
      break;
    case 'this_line_already_bound':
      msg = '此 LINE 帳號已綁定其他 chinup 帳號，請先解除。';
      break;
    case 'chinup_already_bound':
      msg = '此 chinup 帳號已綁定其他 LINE，請先解除。';
      break;
    default:
      msg = '處理中發生問題，請稍後再試。';
  }
  lineReply(replyToken, msg).catch((e) => console.error('[line bind reply]', e));
}
```

Also ensure `nowLocal` is imported at the top of `server.js` (likely already in the existing import block from connection.js — verify and add if missing).

- [ ] **Step 6.6: Restart server with LINE_MOCK=1 + run test**

```bash
SERVER_PID=$(lsof -ti :3000 2>/dev/null)
[ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && LINE_MOCK=1 nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health

node tests/line-webhook-api.test.js
```

Expected: server 200, all test ✓.

- [ ] **Step 6.7: Confirm no regression**

```bash
node tests/my-schedule-api.test.js 2>&1 | tail -2
node tests/booking-api.test.js 2>&1 | tail -2
```

Expected: both pass.

- [ ] **Step 6.8: Commit**

```bash
git add src/server.js tests/line-webhook-api.test.js
git commit -m "feat(api): add LINE webhook + 3 /api/my/line/* endpoints

express.json now captures req.rawBody via verify callback so the
webhook can HMAC-verify the LINE signature.

GET /api/my/line/binding — returns binding state + auto-generates
  a 6-digit code if unbound and no valid code exists
POST /api/my/line/regenerate — force-new code
DELETE /api/my/line — unbind
POST /api/line/webhook — verifies signature, routes message events
  to handleLineTextMessage, handles follow/unfollow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend `/line.html` + `/line.js`

**Files:**
- Create: `public/line.html`
- Create: `public/line.js`

No automated tests; manual smoke is the gate.

- [ ] **Step 7.1: Create `public/line.html`**

Write the file with this exact content:

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LINE 通知 · CHINUP Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/style.css">
<style>
  body { visibility: hidden; }
  .code-display {
    font-family: 'Inter', monospace;
    font-size: 32px;
    font-weight: 800;
    letter-spacing: 0.2em;
    background: #f1f5f9;
    color: #0f172a;
    padding: 16px 20px;
    border-radius: 12px;
    text-align: center;
    display: inline-block;
    margin: 10px 0;
  }
  .step-num {
    background: var(--brand-600);
    color: white;
    width: 28px; height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
    margin-right: 8px;
  }
  .step { padding: 18px 0; border-bottom: 1px solid #e2e8f0; }
  .step:last-child { border-bottom: 0; }
  .qr-img { width: 200px; height: 200px; background: #f1f5f9; }
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
        <a href="/my-schedule" class="nav-link">我的課表</a>
        <a href="/line.html" class="nav-link active">🔔 LINE 通知</a>
        <a href="/admin.html" class="nav-link">管理後台</a>
        <a href="/coach.html" class="nav-link coach-only hidden">教練後台</a>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <div id="auth-bar" class="flex items-center gap-3"></div>
      <button id="nav-toggle" class="md:hidden nav-toggle-btn" aria-label="選單" aria-expanded="false">☰</button>
    </div>
  </div>
  <div id="nav-mobile" class="hidden md:hidden">
    <div class="max-w-6xl mx-auto px-6 py-2 flex flex-col">
      <a href="/" class="nav-link-mobile">課程</a>
      <a href="/coaches.html" class="nav-link-mobile">一對一預約</a>
      <a href="/my-schedule" class="nav-link-mobile">我的課表</a>
      <a href="/line.html" class="nav-link-mobile active">🔔 LINE 通知</a>
      <a href="/admin.html" class="nav-link-mobile">管理後台</a>
      <a href="/coach.html" class="nav-link-mobile coach-only hidden">教練後台</a>
    </div>
  </div>
</nav>

<main class="max-w-3xl mx-auto px-6">
  <section class="hero">
    <span class="hero-eyebrow">🔔 Notifications</span>
    <h1>LINE 通知</h1>
    <p>綁定後，課程相關通知將直接送到你的 LINE。</p>
  </section>

  <section class="pb-16">
    <!-- Loading -->
    <div id="loading" class="empty-state">載入中…</div>

    <!-- Unbound state -->
    <div id="state-unbound" class="card" style="display:none;">
      <div class="step">
        <h3 class="card-title"><span class="step-num">1</span>用 LINE 加 CHINUP 官方帳號好友</h3>
        <div class="mt-3 flex flex-col md:flex-row gap-4 items-center md:items-start">
          <img id="qr-img" src="/line-qr.png" alt="LINE QR" class="qr-img" onerror="this.style.display='none'; document.getElementById('qr-fallback').style.display='block';">
          <div>
            <p class="subtle" id="qr-fallback" style="display:none;">QR 圖片尚未設定，請聯絡管理員。</p>
            <p class="subtle">或點擊：</p>
            <a id="friend-link" href="#" target="_blank" class="text-sky-600 break-all"></a>
          </div>
        </div>
      </div>

      <div class="step">
        <h3 class="card-title"><span class="step-num">2</span>在 LINE 對話中傳送這個 6 位數綁定碼</h3>
        <div class="mt-3 text-center">
          <div class="code-display" id="code-display">------</div>
          <p class="subtle mt-2">有效時間：<span id="expires-at">--</span></p>
          <div class="flex gap-2 justify-center mt-3">
            <button id="copy-btn" class="btn btn-ghost btn-sm">複製代碼</button>
            <button id="regen-btn" class="btn btn-ghost btn-sm">重新產生</button>
          </div>
        </div>
      </div>

      <div class="step">
        <h3 class="card-title"><span class="step-num">3</span>Bot 回覆綁定成功後，重新整理本頁</h3>
        <p class="subtle mt-2">本頁不會自動更新狀態。</p>
      </div>
    </div>

    <!-- Bound state -->
    <div id="state-bound" class="card" style="display:none;">
      <div class="text-center py-6">
        <div class="text-3xl mb-3">✓</div>
        <h2 class="card-title text-xl">已綁定 LINE</h2>
        <p class="subtle mt-2">日後課程通知將自動推送到你的 LINE。</p>
        <button id="unbind-btn" class="btn btn-danger mt-6">解除綁定</button>
      </div>
    </div>
  </section>
</main>

<div id="toast" class="toast"></div>

<script type="module" src="/app.js"></script>
<script type="module" src="/line.js"></script>
</body>
</html>
```

- [ ] **Step 7.2: Create `public/line.js`**

Write the file with this exact content:

```javascript
import { api, toast, bootAuth } from './app.js';

const user = await bootAuth();
if (!user) throw new Error('__redirected_by_auth__');

function fmtExpiresAt(localStr) {
  // "2026-05-12T14:35:00" → "14:35"
  const m = /T(\d{2}:\d{2})/.exec(localStr || '');
  return m ? m[1] : '--';
}

async function loadState() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('state-unbound').style.display = 'none';
  document.getElementById('state-bound').style.display = 'none';
  try {
    const data = await api('/api/my/line/binding');
    document.getElementById('loading').style.display = 'none';

    if (data.bound) {
      document.getElementById('state-bound').style.display = 'block';
    } else {
      document.getElementById('state-unbound').style.display = 'block';
      document.getElementById('code-display').textContent = data.code;
      document.getElementById('expires-at').textContent = fmtExpiresAt(data.expires_at);
      if (data.official_account_id) {
        const url = `https://line.me/R/ti/p/${encodeURIComponent(data.official_account_id)}`;
        const a = document.getElementById('friend-link');
        a.href = url;
        a.textContent = url;
      } else {
        document.getElementById('friend-link').textContent = '(尚未設定 LINE_OFFICIAL_ACCOUNT_ID，請聯絡管理員)';
      }
    }
  } catch (e) {
    document.getElementById('loading').textContent = `載入失敗：${e.message}`;
  }
}

document.getElementById('copy-btn').addEventListener('click', async () => {
  const code = document.getElementById('code-display').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('已複製代碼', 'success');
  } catch {
    toast('複製失敗，請手動選取', 'error');
  }
});

document.getElementById('regen-btn').addEventListener('click', async () => {
  try {
    const data = await api('/api/my/line/regenerate', { method: 'POST' });
    document.getElementById('code-display').textContent = data.code;
    document.getElementById('expires-at').textContent = fmtExpiresAt(data.expires_at);
    toast('已產生新代碼', 'success');
  } catch (e) {
    toast(`產生失敗：${e.message}`, 'error');
  }
});

document.getElementById('unbind-btn').addEventListener('click', async () => {
  if (!confirm('確定解除 LINE 綁定？解除後將不再收到通知。')) return;
  try {
    await api('/api/my/line', { method: 'DELETE' });
    toast('已解除綁定', 'success');
    await loadState();
  } catch (e) {
    toast(`解除失敗：${e.message}`, 'error');
  }
});

await loadState();
document.body.style.visibility = 'visible';
```

- [ ] **Step 7.3: Smoke check**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/line.html
```

Expected: 200.

- [ ] **Step 7.4: Commit**

```bash
git add public/line.html public/line.js
git commit -m "feat(ui): add /line.html binding page (Phase 3C)

Two states: unbound (QR + 6-digit code + regen/copy buttons) and bound
(unbind button). Polls binding state on load only — user manually
reloads after bot confirms. Falls back gracefully when LINE QR PNG
or LINE_OFFICIAL_ACCOUNT_ID env are missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Cleanup — navbar, package.json, gitignore, README

**Files:**
- Modify: `public/index.html`, `public/admin.html`, `public/coach.html`, `public/coaches.html`, `public/my-schedule.html`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`

Mechanical task; can be accepted without per-subtask review.

- [ ] **Step 8.1: Add navbar entry to 5 existing pages**

In each of the 5 HTML files below, add the `🔔 LINE 通知` link to BOTH the desktop nav (inside `<div class="hidden md:flex items-center gap-6">`) and the mobile dropdown (inside `<div id="nav-mobile"><div ...>`). Position it BETWEEN `我的課表` and `管理後台`.

Desktop snippet to insert (after `<a href="/my-schedule" class="nav-link...">我的課表</a>` and before `<a href="/admin.html" class="nav-link">管理後台</a>`):

```html
<a href="/line.html" class="nav-link">🔔 LINE 通知</a>
```

Mobile snippet to insert (after `<a href="/my-schedule" class="nav-link-mobile...">我的課表</a>` and before `<a href="/admin.html" class="nav-link-mobile">管理後台</a>`):

```html
<a href="/line.html" class="nav-link-mobile">🔔 LINE 通知</a>
```

Files to edit:
- `public/index.html`
- `public/admin.html`
- `public/coach.html`
- `public/coaches.html`
- `public/my-schedule.html`

(Don't touch `public/line.html` — it was created in Task 7 with the link already as `active`.)

- [ ] **Step 8.2: Update `package.json` start script**

In `package.json`, change:

```json
"start": "node src/server.js",
```

to:

```json
"start": "node --env-file-if-exists=.env src/server.js",
```

`--env-file-if-exists` requires Node 22+. Chinup uses Node 24 (per memory `env_setup`).

- [ ] **Step 8.3: Update `.gitignore`**

`.env` is already in `.gitignore`. Add one more line (anywhere in the file):

```
public/line-qr.png
```

- [ ] **Step 8.4: Append README section**

At the end of `README.md`, append:

````markdown

## Phase 3C: LINE 通知設定

通知系統使用 LINE Messaging API 推播。Operator 一次性設定步驟：

### 1. 在 LINE Developers 建立 Channel

1. 登入 https://developers.line.biz/
2. Create Provider（任意名稱，例：CHINUP Gym）
3. 在該 Provider 下 Create a new channel → 選 **Messaging API**
4. 填寫 channel 資訊（icon、display name 都會顯示給綁定的會員看）

### 2. 取得三個值

從 LINE Developers Console 該 channel 頁面取得：

| 值 | 環境變數 |
|---|---|
| **Channel access token (long-lived)** ← 在 Messaging API 分頁底部 Issue | `LINE_CHANNEL_ACCESS_TOKEN` |
| **Channel secret** ← 在 Basic settings 分頁 | `LINE_CHANNEL_SECRET` |
| **Bot basic ID** (e.g. `@chinup`) ← Messaging API 分頁 | `LINE_OFFICIAL_ACCOUNT_ID` |

### 3. 設定 webhook URL

在 LINE Console 的 Messaging API 分頁：

1. Webhook URL: `https://<your-domain>/api/line/webhook`
2. 開啟 **Use webhook**
3. **關閉** Auto-reply messages（避免 bot 自動覆蓋我們的 reply）
4. **關閉** Greeting messages

### 4. 下載 QR PNG

在 LINE Console 同一分頁可下載 friend-add QR code。存成：

```
public/line-qr.png
```

（已加入 `.gitignore`，不會 commit。會員開啟 `/line.html` 時會看到此圖。）

### 5. 設環境變數

**本地 dev** — 建立 `.env`（已 gitignore）：

```bash
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LINE_OFFICIAL_ACCOUNT_ID=@yourbotid
```

`npm start` 會自動載入（Node 22+ `--env-file-if-exists`）。

**Railway** — 在 dashboard 的 Variables 區設這三個。

### 6. Smoke test

1. `npm start`
2. 登入會員（如 `user1@chinup.local`）
3. 開 `/line.html`，照畫面三步驟綁定
4. 在 `data/app.db` 用 sqlite3 看 `notifications` table，預期 `channel='line'` row 出現

### Dev 環境跳過真實 LINE

設 `LINE_MOCK=1` → `sendMessage` 直接 return success、`verifySignature` 直接 true。可以跑完整 `/line.html` 流程而不需要真實 LINE Channel。

設 `LINE_MOCK=fail` → 永遠 return failure，方便測試 retry / 失敗 UI。

### 失敗 retry 機制

LINE Push 失敗的訊息會以 `status='failed'` 寫入 `notifications` table，retry 排程：

| Attempt | 等待 | 累計時間 |
|---|---|---|
| 初次 (status=failed inserted) | — | 0 |
| 第 1 次 retry | 5 分鐘後 | 5 分 |
| 第 2 次 retry | 15 分鐘後 | 20 分 |
| 第 3 次 retry | 45 分鐘後 | 65 分 |
| 第 4 次（仍失敗）→ `failed_permanent` | 不再試 | — |

由 `scheduler.js` 內 `*/5 * * * *` cron 觸發 `processFailedNotifications()`。

查看 failed 訊息：

```sql
SELECT id, type, user_id, retry_count, next_retry_at, last_error
FROM notifications
WHERE status IN ('failed', 'failed_permanent')
ORDER BY id DESC LIMIT 50;
```
````

- [ ] **Step 8.5: Verify**

```bash
# Navbar diff sanity
grep -c "🔔 LINE 通知" public/index.html public/admin.html public/coach.html public/coaches.html public/my-schedule.html public/line.html
# Expected: each file shows 2 occurrences (desktop + mobile), except line.html which shows 2 (its own)
```

```bash
# Server restart with --env-file-if-exists
SERVER_PID=$(lsof -ti :3000 2>/dev/null)
[ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && LINE_MOCK=1 nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
```

Expected: 200, no boot error in log.

- [ ] **Step 8.6: Commit**

```bash
git add public/index.html public/admin.html public/coach.html public/coaches.html public/my-schedule.html package.json .gitignore README.md
git commit -m "chore: navbar + start script + README LINE setup (Phase 3C)

- Add '🔔 LINE 通知' nav-link in 5 existing pages (desktop + mobile)
- package.json start script: --env-file-if-exists=.env (Node 22+)
- .gitignore: public/line-qr.png (operator-uploaded asset)
- README: full Phase 3C operator setup section incl. retry mechanics

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Manual smoke test + final regression

**Files:**
- None (verification only)

Task purpose: prove the integration runs end-to-end (under `LINE_MOCK=1`) and all existing tests stay green.

- [ ] **Step 9.1: Fresh DB + fresh server**

```bash
rm -f data/app.db data/app.db-shm data/app.db-wal
node src/db/migrate.js
node src/db/seed-demo.js

SERVER_PID=$(lsof -ti :3000 2>/dev/null)
[ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && LINE_MOCK=1 nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
```

Expected: 200, log has no error.

- [ ] **Step 9.2: Schema sanity**

```bash
sqlite3 data/app.db "PRAGMA table_info(users);" | grep -cE "line_"
sqlite3 data/app.db "PRAGMA table_info(notifications);" | grep -cE "retry_count|next_retry_at|last_error"
```

Expected: 3 each.

- [ ] **Step 9.3: Run all Phase 3C automated tests**

```bash
node tests/lineClient.test.js
node tests/lineBindingService.test.js
node tests/notifications-flow.test.js
node tests/line-webhook-api.test.js
```

Expected: all ✓.

- [ ] **Step 9.4: Run existing regression suite**

```bash
node tests/my-schedule-routing.test.js
node tests/my-schedule-api.test.js
node tests/my-schedule-service.test.js
node tests/booking-flow.test.js
node tests/booking-api.test.js
```

Expected: all ✓ (booking-flow may need a re-seed after if it wiped state — that's fine).

- [ ] **Step 9.5: HTTP smoke for new endpoints**

```bash
# Login as user1 to get token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user1@chinup.local","password":"pass1234"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# GET binding (unbound)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/my/line/binding | python3 -m json.tool

# Regenerate
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/my/line/regenerate | python3 -m json.tool

# Webhook (will accept since LINE_MOCK=1 bypasses signature)
curl -s -X POST http://localhost:3000/api/line/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Line-Signature: anything' \
  -d '{"events":[]}' -w "\n%{http_code}\n"
```

Expected outputs:
- binding: `{"bound": false, "code": "...", "expires_at": "...", "official_account_id": null}`
- regenerate: `{"code": "...", "expires_at": "..."}`
- webhook: empty body, 200

- [ ] **Step 9.6: If any test or smoke fails, fix and commit**

Address any failure with a tightly scoped commit:

```bash
git add <files>
git commit -m "fix(...): <what>

<why>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If everything passes, no commit needed — Task 9 is verification only.

- [ ] **Step 9.7: Hand off to user-driven smoke**

Per `workflow_preferences` memory:

1. Push branch + open draft PR via GitHub API (curl + osxkeychain PAT)
2. User runs manual smoke on real device (real LINE channel optional — `LINE_MOCK=1` covers most of the flow)
3. User flips draft → ready
4. Merge

This step is done by the controller (not the implementer subagent).

---

## Task 10: Final holistic review

Dispatch a single Opus reviewer over the entire diff `main..feature/line-notifications`. Focus areas:

- **Cross-task integration:** Does the schema migration in Task 1 produce the columns Task 2/3/4/6 read? Do all paths from `notify()` reach `lineClient` correctly? Do the 4 booking notify calls land at the right user IDs (coach.user_id vs member_id)?
- **Auth & security:** Webhook route is INTENTIONALLY unauthenticated (LINE platform can't carry chinup tokens) — but HMAC verifies legitimacy. The 3 `/api/my/line/*` routes use `requireUser`. Confirm.
- **Tx safety:** `notify()` is called from inside `registration.js` tx() and `bookingService.js` tx(). `deliverLine` is async and fired off without await. The INSERT statement on success/failure runs OUTSIDE the calling tx — is that desirable? (Yes: we don't want LINE API latency holding a DB lock. Failed-INSERTs after the tx commits is OK.)
- **Retry cron correctness:** Backoff 5/15/45 then permanent. `processFailedNotifications` is idempotent under concurrent runs? (Single cron, single process — yes.)
- **FK safety:** New columns are nullable, no FK additions. notifications.next_retry_at index is partial. No new ON DELETE cascade behavior.
- **A11y / UX:** `/line.html` is keyboard-accessible. Mobile viewport at 390px renders cleanly.
- **No drift from spec:** All 4 outcomes in `consumeCode` are reachable. fmtDateForLine renders zh-TW. 11 templates exist. retry policy [5,15,45] matches spec.
- **Backwards compat:** existing notifications rows (channel='email'/'sms') untouched. Schema additions are pure column adds, no DROP.

Reviewer report fixes anything Critical/Important. Then user-driven smoke is the final merge gate.

---

## What is intentionally NOT covered

Per spec §3:

- Web Push (Phase 3D candidate)
- Real SMTP / SMS provider
- DROP COLUMN on `users.notification_preference`
- Notification mute toggle (unbind is the equivalent)
- LINE Login OAuth
- LINE Flex Message
- Auto-detect binding completion via SSE/poll
- Auto-unbind on user-blocked-bot (yet — retry path handles it as failed_permanent)
- Admin UI for failed notifications
- CHECK constraint on `notifications.status`
- Frontend automated test framework
- Fixing the 8 pre-existing `tests/api.test.js` failures

## Reference

- Spec: `docs/superpowers/specs/2026-05-12-line-notifications-design.md`
- Phase 3A plan (for pattern): `docs/superpowers/plans/2026-05-12-my-schedule.md`
- Phase 3B plan (for pattern): `docs/superpowers/plans/2026-05-12-group-mobile-ui.md`
- LINE Messaging API: https://developers.line.biz/en/reference/messaging-api/
- Memory: `chinup_project.md`, `workflow_preferences.md`, `env_setup.md`
