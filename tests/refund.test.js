// 取消並退款：教練課（取消+退款紀錄+通知）、團課（整單取消+釋名額+候補遞補成新待付單+通知）、
// 已核對清單保留退款紀錄。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const { refundBookingAdmin, listConfirmedPayments } = await import('../src/services/bookingService.js');
const { createGroupOrder, confirmGroupOrder, refundGroupOrder, listPendingOrders } = await import('../src/services/groupOrderService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[refund test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM registrations; DELETE FROM group_orders; DELETE FROM course_sessions; DELETE FROM course_templates; DELETE FROM coaches; DELETE FROM users WHERE phone LIKE '0989%' OR email LIKE 'rf-%'");

const pad = n => String(n).padStart(2,'0');
const day = (d) => { const x = new Date(Date.now() + d*86400000); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`; };
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('店長','rf-a@x.com','coach',1)").run().lastInsertRowid);

// ── 教練課退款 ──
const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練戊','rf-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練戊', 1)").run(cuid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,role,phone) VALUES ('退小費','user','0989000111')").run().lastInsertRowid);
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, original_amount, discount_amount, paid_at, paid_by) VALUES (?, ?, ?, ?, 1500, 100, ?, ?)"
).run(coachId, mid, `${day(5)}T10:00:00`, `${day(5)}T11:00:00`, nowLocal(), admin).lastInsertRowid);

const bUnpaid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at) VALUES (?, ?, ?, ?)"
).run(coachId, mid, `${day(6)}T10:00:00`, `${day(6)}T11:00:00`).lastInsertRowid);
expect('教練課未收款 → 409 not_paid', () => {
  assert.throws(() => refundBookingAdmin({ bookingId: bUnpaid, actorId: admin }), /not_paid/);
});

expect('教練課退款：取消＋refunded 紀錄', () => {
  const r = refundBookingAdmin({ bookingId: bid, actorId: admin });
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);
  const b = db.prepare('SELECT status, refunded_at, refunded_by, cancel_reason FROM bookings WHERE id=?').get(bid);
  assert.equal(b.status, 'cancelled');
  assert.ok(b.refunded_at);
  assert.equal(b.refunded_by, admin);
});
expect('教練課退款通知（含折後金額 1400）', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_refunded' AND user_id=?").get(mid);
  assert.ok(n);
  assert.ok(n.body.includes('NT$1400'));
});
expect('重複退款 → 409 already_refunded', () => {
  assert.throws(() => refundBookingAdmin({ bookingId: bid, actorId: admin }), /already_refunded/);
});

// ── 團課退款（上限 1 → 退款後候補遞補）──
const tplId = Number(db.prepare(`
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence, cycle_start_date, cycle_end_date, status, price_per_session)
  VALUES ('退款測試班', 1, 1, 6, '15:00', 'weekly', ?, ?, 'published', 500)
`).run(day(1), day(60)).lastInsertRowid);
const sid = Number(db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline)
  VALUES (?, ?, ?, ?, ?)
`).run(tplId, day(7), `${day(7)}T15:00:00`, `${day(7)}T16:00:00`, `${day(7)}T14:00:00`).lastInsertRowid);

const oPay = createGroupOrder({ name: '退大戶', phone: '0989000222', paySessionIds: [sid], waitlistSessionIds: [] });
confirmGroupOrder({ orderId: oPay.orderId, actorId: admin });
createGroupOrder({ name: '候小補', phone: '0989000333', paySessionIds: [], waitlistSessionIds: [sid] }); // 滿員後候補

expect('團課未收款訂單 → 409 not_paid', () => {
  const oP2 = db.prepare("INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, status, expires_at) VALUES (?, 'x', '0989000444', 100, 'pending', ?)").run(mid, day(2)+'T00:00:00').lastInsertRowid;
  assert.throws(() => refundGroupOrder({ orderId: Number(oP2), actorId: admin }), /not_paid/);
});

expect('團課退款：整單取消＋refunded＋候補遞補成新待付單', () => {
  const r = refundGroupOrder({ orderId: oPay.orderId, actorId: admin });
  assert.equal(r.ok, true);
  const o = db.prepare('SELECT status, refunded_at, refunded_by FROM group_orders WHERE id=?').get(oPay.orderId);
  assert.equal(o.status, 'cancelled');
  assert.ok(o.refunded_at);
  assert.equal(o.refunded_by, admin);
  // 原報名列取消
  const reg = db.prepare("SELECT status FROM registrations WHERE order_id=?").get(oPay.orderId);
  assert.equal(reg.status, 'cancelled');
  // 候補被遞補成 pending + 新訂單，出現在待核對清單
  const promoted = db.prepare("SELECT * FROM registrations WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0989000333')").get(sid);
  assert.equal(promoted.status, 'pending');
  assert.ok(promoted.order_id);
  assert.ok(listPendingOrders().some(x => x.id === promoted.order_id));
});
expect('團課退款通知（group_order_refunded 含金額）', () => {
  const uid2 = db.prepare("SELECT id FROM users WHERE phone='0989000222'").get().id;
  const n = db.prepare("SELECT * FROM notifications WHERE type='group_order_refunded' AND user_id=?").get(uid2);
  assert.ok(n);
  assert.ok(n.body.includes('NT$500'));
});
expect('團課重複退款 → 409 already_refunded', () => {
  assert.throws(() => refundGroupOrder({ orderId: oPay.orderId, actorId: admin }), /already_refunded/);
});

// ── 已核對清單保留退款紀錄 ──
expect('listConfirmedPayments：退款後仍保留、帶 refunded_at', () => {
  const list = listConfirmedPayments();
  const b = list.find(x => x.type === 'booking' && x.id === bid);
  const g = list.find(x => x.type === 'group_order' && x.id === oPay.orderId);
  assert.ok(b && b.refunded_at);
  assert.ok(g && g.refunded_at);
  assert.equal(g.detail, '1 場次'); // amount_due 計數不受取消影響
});

db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM registrations; DELETE FROM group_orders; DELETE FROM course_sessions WHERE template_id=" + tplId + "; DELETE FROM course_templates WHERE id=" + tplId + "; DELETE FROM coaches; DELETE FROM users WHERE phone LIKE '0989%' OR email LIKE 'rf-%'");
console.log('[refund test] done');
