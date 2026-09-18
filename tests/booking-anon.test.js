import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createBookingAnon, cancelBookingAnon } from '../src/services/bookingService.js';
import { getOneOnOnePrice, getOneOnTwoPrice } from '../src/services/discountService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'anon-bk-%' OR phone LIKE '0998%');
    DELETE FROM bookings;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'anon-bk-%' OR phone LIKE '0998%';
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function futureLocal(days, hh=10) {
  const d = new Date(); d.setDate(d.getDate()+days);
  const p=(n)=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`;
}

console.log('[booking-anon test] start');
reset();

const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach U','anon-bk-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'Coach U' });
setCoachActive(coach.id, true);

const startAt = futureLocal(5);

// 匿名建立預約 → 同時建 user
const r = createBookingAnon({ coachId: coach.id, startAt, name: '阿華', phone: '0998000111' });
expect('booking created', () => assert(r.id));
expect('user auto-created', () => {
  const u = db.prepare("SELECT * FROM users WHERE phone='0998000111'").get();
  assert(u && u.name === '阿華' && u.role === 'user');
});
expect('NO point_transactions for this booking', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM point_transactions WHERE related_booking_id = ?").get(r.id).c;
  assert.equal(c, 0);
});
expect('returns lineBindCode for unbound user', () => assert(/^\d{6}$/.test(r.lineBindCode)));

// 重複時段 → 409 slot_taken
expect('double-book 409', () => {
  try { createBookingAnon({ coachId: coach.id, startAt, name: '別人', phone: '0998000222' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'slot_taken'); }
});

// 取消：電話+姓名要對
expect('cancel wrong name → 403', () => {
  try { cancelBookingAnon({ bookingId: r.id, phone: '0998000111', name: '錯名' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});
expect('cancel correct → ok', () => {
  const res = cancelBookingAnon({ bookingId: r.id, phone: '0998000111', name: '阿華' });
  assert.equal(res.ok, true);
});
expect('slot bookable again', () => {
  const r2 = createBookingAnon({ coachId: coach.id, startAt, name: '阿華', phone: '0998000111' });
  assert(r2.id);
});

// ── 1對2 課程型態 ──────────────────────────────────────────────────────────
const r1on2 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(6), name: '阿明', phone: '0998000333', sessionType: '1on2' });
expect('1on2 booking created', () => assert(r1on2.id));
expect('1on2 session_type + original_amount stored', () => {
  const row = db.prepare('SELECT session_type, original_amount FROM bookings WHERE id=?').get(r1on2.id);
  assert.equal(row.session_type, '1on2');
  assert.equal(row.original_amount, getOneOnTwoPrice());
});
expect('1on2 result reflects type + amount', () => {
  assert.equal(r1on2.sessionType, '1on2');
  assert.equal(r1on2.originalAmount, getOneOnTwoPrice());
  assert.equal(r1on2.finalAmount, getOneOnTwoPrice());
});

// 不傳 sessionType → 預設 1on1 + 1對1 價
const rDefault = createBookingAnon({ coachId: coach.id, startAt: futureLocal(7), name: '阿美', phone: '0998000444' });
expect('default session_type is 1on1 with 1對1 price', () => {
  const row = db.prepare('SELECT session_type, original_amount FROM bookings WHERE id=?').get(rDefault.id);
  assert.equal(row.session_type, '1on1');
  assert.equal(row.original_amount, getOneOnOnePrice());
});

// 非法 sessionType → 400 invalid_session_type（在建 user/booking 之前就擋下）
expect('invalid sessionType → 400', () => {
  try {
    createBookingAnon({ coachId: coach.id, startAt: futureLocal(8), name: '亂入', phone: '0998000555', sessionType: 'group' });
    assert.fail('no throw');
  } catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'invalid_session_type'); }
});
expect('invalid sessionType creates no user', () => {
  const u = db.prepare("SELECT id FROM users WHERE phone='0998000555'").get();
  assert.equal(u, undefined);
});

// ── gcal 整合：email 存儲 + 容量守門（tx 內 assertBookableTx）──
const rE = createBookingAnon({ coachId: coach.id, startAt: futureLocal(6, 9), name: '小信', phone: '0998000222', email: 'mail@example.com' });
expect('email 寫入 bookings.customer_email', () => {
  assert.equal(db.prepare('SELECT customer_email FROM bookings WHERE id=?').get(rE.id).customer_email, 'mail@example.com');
});
expect('email 格式錯 → 400 invalid_email', () => {
  assert.throws(() => createBookingAnon({ coachId: coach.id, startAt: futureLocal(6, 12), name: '壞信', phone: '0998000333', email: 'not-an-email' }), /invalid_email/);
});
expect('startAt 格式錯 → 400 invalid_start_at', () => {
  assert.throws(() => createBookingAnon({ coachId: coach.id, startAt: 'garbage', name: 'x', phone: '0998000444' }), /invalid_start_at/);
});
// 容量：同一小時三組（不同教練）滿 3 → 第四組 slot_full
const cu2 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach V','anon-bk-coach2@x.com','x','coach')").run();
const coach2 = createCoach({ userId: cu2.lastInsertRowid, displayName: 'Coach V' });
setCoachActive(coach2.id, true);
const cu3 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach W','anon-bk-coach3@x.com','x','coach')").run();
const coach3 = createCoach({ userId: cu3.lastInsertRowid, displayName: 'Coach W' });
setCoachActive(coach3.id, true);
const capSlot = futureLocal(8, 14);
createBookingAnon({ coachId: coach.id,  startAt: capSlot, name: '甲', phone: '0998000555' });
createBookingAnon({ coachId: coach2.id, startAt: capSlot, name: '乙', phone: '0998000666' });
createBookingAnon({ coachId: coach3.id, startAt: capSlot, name: '丙', phone: '0998000777' });
const cu4 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach X','anon-bk-coach4@x.com','x','coach')").run();
const coach4 = createCoach({ userId: cu4.lastInsertRowid, displayName: 'Coach X' });
setCoachActive(coach4.id, true);
expect('全店同小時第 4 組 → 409 slot_full', () => {
  assert.throws(() => createBookingAnon({ coachId: coach4.id, startAt: capSlot, name: '丁', phone: '0998000888' }), /slot_full/);
});

// ── 1對2 同行客人 ────────────────────────────────────────────────────────
const staffPhoneUser = db.prepare("INSERT INTO users (name,email,password_hash,role,phone) VALUES ('員工丙','anon-bk-staff@x.com',?,'coach','0998000778')").run(hashPassword('x'));
const rc = createBookingAnon({ coachId: coach.id, startAt: futureLocal(8), name: '主客甲', phone: '0998000501', sessionType: '1on2',
  companion: { name: '同行乙', phone: '0998000502' } });
expect('1on2 帶同行：member2_id 寫入、同行帳號建立、回傳 companionName', () => {
  const row = db.prepare('SELECT member_id, member2_id, session_type FROM bookings WHERE id=?').get(rc.id);
  const u2 = db.prepare("SELECT id, name, role FROM users WHERE phone='0998000502'").get();
  assert.ok(u2 && u2.role === 'user' && u2.name === '同行乙');
  assert.equal(row.member2_id, u2.id);
  assert.notEqual(row.member_id, row.member2_id);
  assert.equal(rc.companionName, '同行乙');
});
expect('教練 booking_created 的 member_name 為「主客甲＋同行乙」、同行也收 booking_confirmed', () => {
  const coachNotif = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_created' ORDER BY id DESC LIMIT 1").get(cu.lastInsertRowid);
  assert.ok(coachNotif && coachNotif.body.includes('主客甲＋同行乙'), coachNotif && coachNotif.body);
  const u2 = db.prepare("SELECT id FROM users WHERE phone='0998000502'").get();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_confirmed'").get(u2.id).c, 1);
});
expect('同行電話＝主客人 → 400 companion_same_person', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '主客甲', phone: '0998000501' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'companion_same_person'); }
});
expect('1on1 帶同行 → 400 companion_not_allowed', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on1', companion: { name: '同行乙', phone: '0998000502' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'companion_not_allowed'); }
});
expect('同行只填姓名沒電話 → 400 invalid_companion', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '同行乙', phone: '' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'invalid_companion'); }
});
expect('同行電話是員工帳號 → 409 phone_unavailable', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '員工丙', phone: '0998000778' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('無關第三者取消 → 403', () => {
  try { cancelBookingAnon({ bookingId: rc.id, phone: '0998000333', name: '阿明' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});
expect('同行取消 → 整筆取消、教練收「同行乙 取消」、主客人收 booking_cancelled_by_companion', () => {
  const res = cancelBookingAnon({ bookingId: rc.id, phone: '0998000502', name: '同行乙' });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT status, cancelled_by FROM bookings WHERE id=?').get(rc.id);
  const u2 = db.prepare("SELECT id FROM users WHERE phone='0998000502'").get();
  const u1 = db.prepare("SELECT id FROM users WHERE phone='0998000501'").get();
  assert.equal(row.status, 'cancelled'); assert.equal(row.cancelled_by, u2.id);
  const coachNotif = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_cancelled_by_member' ORDER BY id DESC LIMIT 1").get(cu.lastInsertRowid);
  assert.ok(coachNotif && coachNotif.body.includes('同行乙'), coachNotif && coachNotif.body);
  const mate = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_cancelled_by_companion' ORDER BY id DESC LIMIT 1").get(u1.id);
  assert.ok(mate && mate.body.includes('同行乙') && mate.body.includes('Coach U'), mate && mate.body);
});
expect('主客人取消 → 同行收 booking_cancelled_by_companion', () => {
  const r2 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(10), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '同行乙', phone: '0998000502' } });
  cancelBookingAnon({ bookingId: r2.id, phone: '0998000501', name: '主客甲' });
  const u2 = db.prepare("SELECT id FROM users WHERE phone='0998000502'").get();
  const mate = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_cancelled_by_companion' ORDER BY id DESC LIMIT 1").get(u2.id);
  assert.ok(mate && mate.body.includes('主客甲'), mate && mate.body);
});
expect('1on2 不帶同行 → member2_id NULL、companionName null', () => {
  const r3 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(11), name: '主客甲', phone: '0998000501', sessionType: '1on2' });
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(r3.id).member2_id, null);
  assert.equal(r3.companionName, null);
});

console.log('[booking-anon test] done');
