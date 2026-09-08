// LINE 通知開關：目錄完整性、預設值、讀寫驗證、isLineNotifyEnabled；
// 後段（Task 2 追加）驗 notify() 走向與重試器。fresh DB、LINE_MOCK=1。
process.env.LINE_MOCK = '1';
import assert from 'node:assert/strict';
import { db, offsetLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { LINE_NOTIFY_GROUPS, isLineNotifyEnabled, getLineNotifyState, setLineNotifyState } from '../src/services/lineNotifyPolicy.js';
import { notify, processFailedNotifications } from '../src/services/notifications.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function throwsApi(fn, status, code) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert(err, 'expected throw');
  assert.equal(err.status, status);
  assert.equal(err.code, code);
}
const clearSettings = () => db.exec("DELETE FROM app_settings WHERE key LIKE 'line_notify_%'");
const allItems = () => LINE_NOTIFY_GROUPS.flatMap((g) => g.items);

// 31 種現役推播模板（2026-09-08 盤點；legacy 4 種＋已停用會員 course_confirmed 不在內）
const ACTIVE_TYPES = [
  'booking_created', 'booking_confirmed', 'booking_recurring_created', 'booking_recurring_created_coach',
  'booking_payment_received', 'booking_rescheduled', 'booking_rescheduled_coach',
  'booking_cancelled_by_coach', 'booking_cancelled_by_shop', 'booking_refunded',
  'booking_cancelled_by_member', 'booking_cancelled_by_shop_coach',
  'payment_received', 'course_registered_coach', 'course_registered_coach_batch',
  'course_registered_admin', 'course_registered_admin_batch',
  'group_promoted', 'course_waitlisted_coach', 'course_promoted_coach',
  'course_member_cancelled_coach', 'course_member_leave_coach',
  'course_confirmed_coach', 'course_cancelled_coach', 'course_cancelled',
  'group_order_refunded', 'package_low_sessions', 'group_last_session',
  'gcal_move_rejected', 'gcal_delete_cancelled', 'period_rollover_admin',
];

console.log('[line-notify-policy test] start');
clearSettings();

// ── 目錄 ──
expect('3 組 16 項、項目 key 唯一', () => {
  assert.equal(LINE_NOTIFY_GROUPS.length, 3);
  assert.deepEqual(LINE_NOTIFY_GROUPS.map((g) => g.key), ['one_on_one', 'group', 'system']);
  const items = allItems();
  assert.equal(items.length, 16);
  assert.equal(new Set(items.map((i) => i.key)).size, 16);
});
expect('每個 type 只屬一個項目、31 個現役 type 全涵蓋、無多餘', () => {
  const all = allItems().flatMap((i) => i.types);
  assert.equal(new Set(all).size, all.length);
  for (const t of ACTIVE_TYPES) assert(all.includes(t), `missing ${t}`);
  assert.equal(all.length, ACTIVE_TYPES.length);
});

// ── 預設 ──
expect('預設：總開關 OFF、項目全 ON、state 不帶 types', () => {
  const s = getLineNotifyState();
  assert.equal(s.master, false);
  assert.equal(s.groups.length, 3);
  for (const g of s.groups) for (const i of g.items) {
    assert.equal(i.enabled, true);
    assert.equal(i.types, undefined);
    assert.equal(typeof i.label, 'string');
    assert.equal(typeof i.recipients, 'string');
  }
});
expect('預設 isLineNotifyEnabled 全 false（含 legacy type）', () => {
  assert.equal(isLineNotifyEnabled('booking_created'), false);
  assert.equal(isLineNotifyEnabled('registered_confirmed'), false);
});

// ── 讀寫 ──
expect('setLineNotifyState({ master: true }) → 現役與 legacy 皆 true', () => {
  const s = setLineNotifyState({ master: true });
  assert.equal(s.master, true);
  assert.equal(isLineNotifyEnabled('booking_created'), true);
  assert.equal(isLineNotifyEnabled('registered_confirmed'), true);
});
expect('關單一項目只影響該項目的 type', () => {
  const s = setLineNotifyState({ items: { booking_new: false } });
  const item = s.groups.flatMap((g) => g.items).find((i) => i.key === 'booking_new');
  assert.equal(item.enabled, false);
  assert.equal(isLineNotifyEnabled('booking_created'), false);
  assert.equal(isLineNotifyEnabled('booking_confirmed'), true);
  assert.equal(isLineNotifyEnabled('registered_confirmed'), true);
});
expect('總開關 OFF 蓋過項目 ON（項目值仍存 1）', () => {
  setLineNotifyState({ master: false, items: { booking_new: true } });
  assert.equal(isLineNotifyEnabled('booking_created'), false);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'line_notify_booking_new'").get().value, '1');
});

// ── 驗證 ──
expect('未知項目 key → 400 invalid_line_notify_item，且整包不寫入', () => {
  throwsApi(() => setLineNotifyState({ master: true, items: { nope: true } }), 400, 'invalid_line_notify_item');
  assert.equal(getLineNotifyState().master, false);
});
expect('master 非 boolean → 400 invalid_line_notify_master', () => {
  throwsApi(() => setLineNotifyState({ master: 'yes' }), 400, 'invalid_line_notify_master');
});
expect('項目值非 boolean → 400 invalid_line_notify_value', () => {
  throwsApi(() => setLineNotifyState({ items: { booking_new: 1 } }), 400, 'invalid_line_notify_value');
});
expect('items 非物件 → 400 invalid_line_notify_item', () => {
  throwsApi(() => setLineNotifyState({ items: ['booking_new'] }), 400, 'invalid_line_notify_item');
});
expect('空物件 → 不動、回傳目前狀態', () => {
  const s = setLineNotifyState({});
  assert.equal(s.master, false);
});

// ── notify() 走向（會員有綁 LINE；LINE_MOCK=1 推播必成功）──
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lnp-%');
  DELETE FROM users WHERE email LIKE 'lnp-%';
`);
const member = Number(db.prepare(
  "INSERT INTO users (name, email, password_hash, role, line_user_id) VALUES ('LNP Member', 'lnp-member@x.com', ?, 'user', ?)"
).run(hashPassword('x'), 'Ulnp' + Date.now()).lastInsertRowid);
const tick = () => new Promise((r) => setImmediate(r));
const lastRow = (type) => db.prepare(
  'SELECT channel, status, last_error FROM notifications WHERE user_id = ? AND type = ? ORDER BY id DESC LIMIT 1'
).get(member, type);
const ROLL_VARS = { period_label: '9–10 月', summary: 'LNP 課 9 場' };

setLineNotifyState({ master: false });
notify({ userId: member, sessionId: null, type: 'period_rollover_admin', vars: ROLL_VARS });
await tick();
expect('總開關 OFF：有綁 LINE 仍寫 console 列（只記錄）', () => {
  const r = lastRow('period_rollover_admin');
  assert.equal(r.channel, 'console');
  assert.equal(r.status, 'sent');
});

setLineNotifyState({ master: true, items: { period_rollover: false } });
notify({ userId: member, sessionId: null, type: 'period_rollover_admin', vars: ROLL_VARS });
await tick();
expect('總開關 ON、項目 OFF：console 列', () => assert.equal(lastRow('period_rollover_admin').channel, 'console'));

setLineNotifyState({ items: { period_rollover: true } });
notify({ userId: member, sessionId: null, type: 'period_rollover_admin', vars: ROLL_VARS });
await tick();
expect('ON／ON：line 列 sent（mock）', () => {
  const r = lastRow('period_rollover_admin');
  assert.equal(r.channel, 'line');
  assert.equal(r.status, 'sent');
});

// ── 重試器：關閉期間到期的 LINE 失敗列 → failed_permanent／line_notify_off，不補送 ──
const insertFailed = () => Number(db.prepare(`
  INSERT INTO notifications (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, NULL, 'booking_created', 'line', 'LNP', 'LNP body', 'failed', 0, ?, 'HTTP 429')
`).run(member, offsetLocal(-60 * 1000)).lastInsertRowid);
const rowOf = (id) => db.prepare('SELECT status, last_error FROM notifications WHERE id = ?').get(id);

setLineNotifyState({ master: false });
const f1 = insertFailed();
await processFailedNotifications();
expect('總開關 OFF：到期失敗列 → failed_permanent / line_notify_off', () => {
  assert.equal(rowOf(f1).status, 'failed_permanent');
  assert.equal(rowOf(f1).last_error, 'line_notify_off');
});

setLineNotifyState({ master: true, items: { booking_new: false } });
const f2 = insertFailed();
await processFailedNotifications();
expect('項目 OFF：同樣 failed_permanent / line_notify_off', () => {
  assert.equal(rowOf(f2).status, 'failed_permanent');
  assert.equal(rowOf(f2).last_error, 'line_notify_off');
});

setLineNotifyState({ items: { booking_new: true } });
const f3 = insertFailed();
await processFailedNotifications();
expect('ON／ON：重試成功 sent', () => assert.equal(rowOf(f3).status, 'sent'));

console.log('[line-notify-policy test] done');
