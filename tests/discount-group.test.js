import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate, processDeadlines } from '../src/services/courseService.js';
import { createGroupOrder, cancelGroupOrder, cancelRegistrationPublic, confirmGroupOrder } from '../src/services/groupOrderService.js';

function reset() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0993%');
    DELETE FROM discount_redemptions WHERE phone LIKE '0993%';
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0993%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0993%';
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'TESTDG%');
    DELETE FROM course_templates WHERE name LIKE 'TESTDG%';
    DELETE FROM users WHERE phone LIKE '0993%';
    DELETE FROM discount_codes WHERE code LIKE 'TESTDG%';
  `);
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

function dstr(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

console.log('[discount-group] start');
reset();

// Seed a price=500 template (mirrors group-order-service.test.js approach)
const tpl = createTemplate({
  name: 'TESTDG班', min_capacity: 1, max_capacity: 5,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '10:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(60),
  registration_deadline_hours: 1, price_per_session: 500,
});
const sessions = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId);
const s1 = sessions[0].id, s2 = sessions[1].id;

// Seed a percent-10 discount code
db.prepare(`INSERT INTO discount_codes (code, discount_type, discount_value, active)
  VALUES ('TESTDG10', 'percent', 10, 1)`).run();

// ── Test 1: createGroupOrder with discount code (2 pay sessions) ──
let discountOrderId;
expect('createGroupOrder with discountCode: returns folded total', () => {
  const o = createGroupOrder({
    name: '折甲', phone: '0993000001',
    paySessionIds: [s1, s2], waitlistSessionIds: [],
    discountCode: 'TESTDG10',
  });
  discountOrderId = o.orderId;
  assert(o.orderId, 'orderId should exist');
  assert.equal(o.total, 900, 'total (finalTotal) should be 900');
  assert.equal(o.originalAmount, 1000, 'originalAmount should be 1000');
  assert.equal(o.discountAmount, 100, 'discountAmount should be 100');
  assert.equal(o.discountCode, 'TESTDG10', 'discountCode should be set');
});

expect('DB group_orders row has correct discount fields', () => {
  const row = db.prepare('SELECT * FROM group_orders WHERE id=?').get(discountOrderId);
  assert.equal(row.original_amount, 1000);
  assert.equal(row.discount_amount, 100);
  assert.equal(row.total_amount, 900);
  assert.equal(row.discount_code, 'TESTDG10');
});

expect('discount_redemptions row exists for the order', () => {
  const row = db.prepare(`
    SELECT dr.* FROM discount_redemptions dr
    JOIN discount_codes dc ON dc.id = dr.code_id
    WHERE dr.kind='group_order' AND dr.ref_id=? AND dc.code='TESTDG10'
  `).get(discountOrderId);
  assert(row, 'redemption row should exist');
  assert.equal(row.amount, 100);
  assert.equal(row.phone, '0993000001');
});

// ── Test 2: cancelGroupOrder releases the redemption ──
expect('cancelGroupOrder releases the redemption (usage goes back to 0)', () => {
  const res = cancelGroupOrder({ orderId: discountOrderId, phone: '0993000001', name: '折甲' });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT * FROM discount_redemptions WHERE kind=? AND ref_id=?')
    .get('group_order', discountOrderId);
  assert.equal(row, undefined, 'redemption row should be deleted after cancel');
  // usage count for code should be 0
  const codeRow = db.prepare("SELECT id FROM discount_codes WHERE code='TESTDG10'").get();
  const count = db.prepare('SELECT COUNT(*) AS c FROM discount_redemptions WHERE code_id=?').get(codeRow.id).c;
  assert.equal(count, 0, 'usage count should be 0 after release');
});

// ── Test 3: invalid code → whole call throws, no order written (tx rollback) ──
expect('invalid discountCode → throws, tx rollback, no order written', () => {
  const before = db.prepare("SELECT COUNT(*) AS c FROM group_orders WHERE customer_phone='0993000002'").get().c;
  try {
    createGroupOrder({
      name: '折乙', phone: '0993000002',
      paySessionIds: [s1, s2], waitlistSessionIds: [],
      discountCode: 'TESTDG_NOPE',
    });
    assert.fail('should have thrown');
  } catch (e) {
    assert(e.status === 404 || e.status === 409 || e.status === 400, `expected ApiError, got status=${e.status}`);
  }
  const after = db.prepare("SELECT COUNT(*) AS c FROM group_orders WHERE customer_phone='0993000002'").get().c;
  assert.equal(after, before, 'no order should be written on invalid code (tx rollback)');
  const userAfter = db.prepare("SELECT COUNT(*) AS c FROM users WHERE phone='0993000002'").get().c;
  assert.equal(userAfter, 0, 'no user should be written (tx rolled back)');
});

// ── Test 4: no discountCode → original_amount=1000, total_amount=1000, discount_* NULL ──
let noDiscountOrderId;
expect('createGroupOrder without discountCode: original_amount=total_amount=1000, discount_* NULL', () => {
  const o = createGroupOrder({
    name: '折丙', phone: '0993000003',
    paySessionIds: [s1, s2], waitlistSessionIds: [],
  });
  noDiscountOrderId = o.orderId;
  assert.equal(o.total, 1000, 'total should be 1000');
  assert.equal(o.originalAmount, 1000, 'originalAmount should be 1000');
  assert.equal(o.discountAmount, null, 'discountAmount should be null');
  assert.equal(o.discountCode, null, 'discountCode should be null');
});

expect('DB group_orders row: no discount, original_amount=total_amount=1000', () => {
  const row = db.prepare('SELECT * FROM group_orders WHERE id=?').get(noDiscountOrderId);
  assert.equal(row.original_amount, 1000);
  assert.equal(row.total_amount, 1000);
  assert.equal(row.discount_amount, null);
  assert.equal(row.discount_code, null);
});

// ── Helpers for confirm-flow cases ──
function adminId() {
  // 角色重構（PR #40）後管理者 = role='coach' + is_admin=1；找不到才補一個（冪等：重跑時 SELECT 會命中前次 INSERT 的列）
  return db.prepare("SELECT id FROM users WHERE is_admin=1 LIMIT 1").get()?.id
    || db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('A','dg-owner@x.com','x','coach',1) RETURNING id").get().id;
}
function redemptionRow(orderId) {
  return db.prepare('SELECT * FROM discount_redemptions WHERE kind=? AND ref_id=?').get('group_order', orderId);
}

// ── Test 5 (a): single-session confirmed order → cancelRegistrationPublic releases redemption ──
expect('(a) single-session confirmed reg cancel → redemption released', () => {
  const o = createGroupOrder({
    name: '折戊', phone: '0993000005',
    paySessionIds: [s1], waitlistSessionIds: [],
    discountCode: 'TESTDG10',
  });
  confirmGroupOrder({ orderId: o.orderId, actorId: adminId() });
  assert(redemptionRow(o.orderId), 'redemption should exist while confirmed');

  const reg = db.prepare("SELECT id FROM registrations WHERE order_id=?").get(o.orderId);
  const res = cancelRegistrationPublic({ registrationId: reg.id, phone: '0993000005', name: '折戊' });
  assert.equal(res.ok, true);
  assert.equal(redemptionRow(o.orderId), undefined, 'redemption should be released (order now inactive)');
});

// ── Test 5 (b): multi-session order, cancel ONE reg → redemption STILL present ──
expect('(b) multi-session order, cancel one reg → redemption still present', () => {
  const o = createGroupOrder({
    name: '折己', phone: '0993000006',
    paySessionIds: [s1, s2], waitlistSessionIds: [],
    discountCode: 'TESTDG10',
  });
  confirmGroupOrder({ orderId: o.orderId, actorId: adminId() });
  assert(redemptionRow(o.orderId), 'redemption should exist while confirmed');

  // cancel only the s1 reg; s2 reg remains active
  const regs = db.prepare("SELECT id, session_id FROM registrations WHERE order_id=? ORDER BY id ASC").all(o.orderId);
  assert.equal(regs.length, 2, 'should have 2 regs');
  const res = cancelRegistrationPublic({ registrationId: regs[0].id, phone: '0993000006', name: '折己' });
  assert.equal(res.ok, true);
  assert(redemptionRow(o.orderId), 'redemption should REMAIN (order still has another active reg)');

  // cancel the second too → now released
  cancelRegistrationPublic({ registrationId: regs[1].id, phone: '0993000006', name: '折己' });
  assert.equal(redemptionRow(o.orderId), undefined, 'redemption released once order fully inactive');
});

// ── Test 5 (c): under-capacity deadline cancel → reg rejected, redemption released ──
expect('(c) under-capacity deadline cancel → session cancelled, reg rejected, redemption released', () => {
  // Separate template with high min_capacity so 1 confirmed < min triggers the cancel branch.
  const tplHi = createTemplate({
    name: 'TESTDG高底班', min_capacity: 5, max_capacity: 10,
    day_of_week: ((new Date()).getDay() + 3) % 7, start_time: '14:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(60),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const sHi = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tplHi.templateId)[0].id;

  const o = createGroupOrder({
    name: '折庚', phone: '0993000007',
    paySessionIds: [sHi], waitlistSessionIds: [],
    discountCode: 'TESTDG10',
  });
  confirmGroupOrder({ orderId: o.orderId, actorId: adminId() });
  assert(redemptionRow(o.orderId), 'redemption should exist while confirmed');

  // Force the deadline into the past so processDeadlines picks it up.
  db.prepare("UPDATE course_sessions SET registration_deadline='2000-01-01T00:00:00' WHERE id=?").run(sHi);
  processDeadlines();

  const sess = db.prepare('SELECT status FROM course_sessions WHERE id=?').get(sHi);
  assert.equal(sess.status, 'cancelled', 'session should be cancelled (under capacity)');
  const reg = db.prepare("SELECT status FROM registrations WHERE order_id=?").get(o.orderId);
  assert.equal(reg.status, 'rejected', 'reg should be rejected');
  assert.equal(redemptionRow(o.orderId), undefined, 'redemption should be released after under-capacity cancel');
});

// ── Cleanup ──
reset();
console.log('[discount-group] done');
