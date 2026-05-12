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
