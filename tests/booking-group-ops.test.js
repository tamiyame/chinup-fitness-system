// 循環教練課整批操作：pending 集中一卡、整批收款/取消/退款、已核對合併一列（含部分退款）。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
process.env.GMAIL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createRecurringBookings, listPendingPaymentBookings, confirmBookingPaymentGroup,
        cancelBookingAdminGroup, refundBookingGroupAdmin, refundBookingAdmin, listConfirmedPayments } = await import('../src/services/bookingService.js');
const { addRule, computeAvailableSlots } = await import('../src/services/availabilityService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-group-ops test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM coach_availability_rules; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bg-%' OR phone LIKE '0983%'");

const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練批','bg-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練批', 1)").run(cuid).lastInsertRowid);
const operator = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('批管理','bg-a@x.com','coach',1)").run().lastInsertRowid);
for (let dow = 0; dow <= 6; dow++) addRule({ coachId, dayOfWeek: dow, startTime: '09:00', endTime: '18:00' });
const pad = n => String(n).padStart(2,'0');
const day = (d) => { const x = new Date(Date.now() + d*86400000); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`; };

// 三堂循環（未收款）
const r1 = createRecurringBookings({
  coachId, startAt: `${day(7)}T10:00:00`, name: '批量客', phone: '0983111222',
  frequency: 'weekly', count: 3, actorId: operator,
});

expect('pending：三堂集中成一個 group 項目', () => {
  const list = listPendingPaymentBookings();
  const g = list.find(x => x.group && x.group_id === r1.groupId);
  assert.ok(g);
  assert.equal(g.sessions.length, 3);
  assert.equal(g.total_amount, 4500);
  // 個別堂數不再以單卡出現
  assert.ok(!list.some(x => !x.group && r1.created.some(c => c.id === x.id)));
});

expect('整批收款：全部 paid、會員 LINE 摘要一則', () => {
  db.exec("DELETE FROM notifications");
  const r = confirmBookingPaymentGroup({ groupId: r1.groupId, actorId: operator });
  assert.equal(r.confirmed, 3);
  const rows = db.prepare('SELECT paid_at, paid_by FROM bookings WHERE recurring_group_id=?').all(r1.groupId);
  assert.ok(rows.every(x => x.paid_at && x.paid_by === operator));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_payment_received'").get().c, 1);
  assert.throws(() => confirmBookingPaymentGroup({ groupId: r1.groupId, actorId: operator }), /already_paid/);
});

expect('已核對清單：合併一列（×3 堂、金額加總）', () => {
  const g = listConfirmedPayments().find(x => x.type === 'booking_group' && x.id === r1.groupId);
  assert.ok(g);
  assert.equal(g.count, 3);
  assert.equal(g.amount, 4500);
  assert.ok(!g.refunded_at && !g.partial_refund);
});

expect('單堂先退款 → 已核對清單標部分退款', () => {
  refundBookingAdmin({ bookingId: r1.created[0].id, actorId: operator });
  const g = listConfirmedPayments().find(x => x.type === 'booking_group' && x.id === r1.groupId);
  assert.equal(g.refunded_count, 1);
  assert.equal(g.partial_refund, true);
});

expect('整批退款：其餘全退、時段釋出、會員摘要一則', () => {
  db.exec("DELETE FROM notifications");
  const r = refundBookingGroupAdmin({ groupId: r1.groupId, actorId: operator });
  assert.equal(r.refunded, 2);
  const g = listConfirmedPayments().find(x => x.type === 'booking_group' && x.id === r1.groupId);
  assert.ok(g.refunded_at); // 全退款
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_refunded'").get().c, 1);
  // 時段釋出：首堂時段重新可約
  const slots = computeAvailableSlots({ coachId, fromDate: day(7), toDate: day(7) });
  assert.ok(slots.some(s => s.start === `${day(7)}T10:00:00`));
  assert.throws(() => refundBookingGroupAdmin({ groupId: r1.groupId, actorId: operator }), /already_refunded/);
});

// 第二批：整批取消（未收款）
const r2 = createRecurringBookings({
  coachId, startAt: `${day(8)}T14:00:00`, name: '批量客二', phone: '0983333444',
  frequency: 'weekly', count: 2, actorId: operator,
});
expect('整批取消：全部 cancelled、釋出時段、通知會員＋教練各一則', () => {
  db.exec("DELETE FROM notifications");
  const r = cancelBookingAdminGroup({ groupId: r2.groupId, actorId: operator, reason: '排程調整' });
  assert.equal(r.cancelled.length, 2);
  const rows = db.prepare('SELECT status, cancel_reason FROM bookings WHERE recurring_group_id=?').all(r2.groupId);
  assert.ok(rows.every(x => x.status === 'cancelled' && x.cancel_reason === '排程調整'));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_cancelled_by_shop'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_cancelled_by_shop_coach' AND user_id=?").get(cuid).c, 1);
  assert.throws(() => cancelBookingAdminGroup({ groupId: r2.groupId, actorId: operator }), /no_pending_bookings/);
});

db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM coach_availability_rules; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bg-%' OR phone LIKE '0983%'");
console.log('[booking-group-ops test] done');
