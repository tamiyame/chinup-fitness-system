// 付款核對 service：守門、清單、通知列、款項確認信。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
process.env.GMAIL_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const { confirmBookingPayment, listPendingPaymentBookings, listConfirmedPayments } = await import('../src/services/bookingService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-payment test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM group_orders; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bp-%'");

const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練丙','bp-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練丙', 1)").run(cuid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('王小付','bp-m@x.com','user','0995777888')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('管理者','bp-a@x.com','coach',1)").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 5*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, discount_amount, discount_code, customer_email) VALUES (?, ?, ?, ?, '1on1', 1500, 100, 'TEST', 'pay@example.com')"
).run(coachId, mid, `${date}T10:00:00`, `${date}T11:00:00`).lastInsertRowid);

expect('pending 清單含該預約（final_amount=1400）', () => {
  const list = listPendingPaymentBookings();
  const row = list.find(x => x.id === bid);
  assert.ok(row);
  assert.equal(row.final_amount, 1400);
  assert.equal(row.member_name, '王小付');
  assert.equal(row.coach_display_name, '教練丙');
});

expect('confirm：寫 paid_at/paid_by', () => {
  const r = confirmBookingPayment({ bookingId: bid, actorId: admin });
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT paid_at, paid_by FROM bookings WHERE id=?').get(bid);
  assert.ok(row.paid_at);
  assert.equal(row.paid_by, admin);
});

expect('confirm 後不在 pending 清單', () => {
  assert.ok(!listPendingPaymentBookings().some(x => x.id === bid));
});

expect('重複 confirm → 409 already_paid', () => {
  assert.throws(() => confirmBookingPayment({ bookingId: bid, actorId: admin }), /already_paid/);
});
expect('不存在 → 404', () => {
  assert.throws(() => confirmBookingPayment({ bookingId: 999999, actorId: admin }), /booking_not_found/);
});
expect('已取消 → 409 booking_cancelled', () => {
  const b2 = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'cancelled')").run(coachId, mid, `${date}T14:00:00`, `${date}T15:00:00`).lastInsertRowid);
  assert.throws(() => confirmBookingPayment({ bookingId: b2, actorId: admin }), /booking_cancelled/);
});

expect('LINE 通知列：booking_payment_received（寄會員）', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_payment_received' AND user_id=?").get(mid);
  assert.ok(n);
  assert.ok(n.body.includes('教練丙'));
});

// email 是 fire-and-forget async → 等一拍再查
await new Promise(r => setTimeout(r, 50));
expect('款項確認信：notifications email/console 列（recipient 正確）', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_payment_email' AND user_id=?").get(mid);
  assert.ok(n);
  assert.equal(n.recipient, 'pay@example.com');
});

expect('listConfirmedPayments：教練課＋團課合併、按 paid_at DESC', () => {
  db.prepare("INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, status, expires_at, paid_at, paid_by) VALUES (?, '團客', '0995111222', 900, 'paid', ?, ?, ?)")
    .run(mid, nowLocal(), '2099-01-01T00:00:00', admin);
  const list = listConfirmedPayments();
  assert.equal(list[0].type, 'group_order');           // paid_at 2099 在最前
  assert.ok(list.some(x => x.type === 'booking' && x.id === bid));
  const b = list.find(x => x.type === 'booking' && x.id === bid);
  assert.equal(b.paid_by_name, '管理者');
  assert.equal(b.amount, 1400);
});

db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM group_orders; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bp-%'");
console.log('[booking-payment test] done');
