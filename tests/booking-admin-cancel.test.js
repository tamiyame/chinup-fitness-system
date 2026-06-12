// admin 後台取消教練課預約：守門、折扣釋放、通知（會員＋教練；操作者本人不重複通知）。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { cancelBookingAdmin, listPendingPaymentBookings } = await import('../src/services/bookingService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-admin-cancel test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bac-%'");

const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練丁','bac-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練丁', 1)").run(cuid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,role,phone) VALUES ('林小取','user','0993555666')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('店長','bac-a@x.com','coach',1)").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 5*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at) VALUES (?, ?, ?, ?)"
).run(coachId, mid, `${date}T10:00:00`, `${date}T11:00:00`).lastInsertRowid);

expect('取消前在待核對清單', () => assert.ok(listPendingPaymentBookings().some(x => x.id === bid)));

expect('cancel：status 變 cancelled、cancelled_by/reason 記錄', () => {
  const r = cancelBookingAdmin({ bookingId: bid, actorId: admin, reason: '教練臨時請假' });
  assert.equal(r.ok, true);
  const b = db.prepare('SELECT status, cancelled_by, cancel_reason FROM bookings WHERE id=?').get(bid);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancelled_by, admin);
  assert.equal(b.cancel_reason, '教練臨時請假');
});

expect('取消後不在待核對清單', () => assert.ok(!listPendingPaymentBookings().some(x => x.id === bid)));

expect('通知會員：booking_cancelled_by_shop 含原因', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_cancelled_by_shop' AND user_id=?").get(mid);
  assert.ok(n);
  assert.ok(n.body.includes('教練丁'));
  assert.ok(n.body.includes('（原因：教練臨時請假）'));
});
expect('通知教練：booking_cancelled_by_shop_coach', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_cancelled_by_shop_coach' AND user_id=?").get(cuid);
  assert.ok(n);
  assert.ok(n.body.includes('林小取'));
});

expect('重複取消 → 409 already_cancelled', () => {
  assert.throws(() => cancelBookingAdmin({ bookingId: bid, actorId: admin }), /already_cancelled/);
});
expect('不存在 → 404', () => {
  assert.throws(() => cancelBookingAdmin({ bookingId: 999999, actorId: admin }), /booking_not_found/);
});

// 無原因 → 通知不含「（原因：」；操作者本人就是該教練 → 不另發教練通知
const bid2 = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at) VALUES (?, ?, ?, ?)"
).run(coachId, mid, `${date}T14:00:00`, `${date}T15:00:00`).lastInsertRowid);
expect('無原因取消＋操作者=教練本人 → 會員通知無原因、教練不重複收通知', () => {
  db.exec("DELETE FROM notifications");
  cancelBookingAdmin({ bookingId: bid2, actorId: cuid });
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_cancelled_by_shop' AND user_id=?").get(mid);
  assert.ok(n && !n.body.includes('（原因：'));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type='booking_cancelled_by_shop_coach'").get().c, 0);
});

db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bac-%' OR phone='0993555666'");
console.log('[booking-admin-cancel test] done');
