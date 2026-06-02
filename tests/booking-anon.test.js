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

// ── 安全：匿名預約撞到「員工帳號的電話」→ 擋下、不外洩綁定碼（越權綁定修補）──
// 模擬「有電話的會員被升級成教練」：一個帶 phone 的 coach-role 帳號。
db.prepare("INSERT INTO users (name,email,phone,password_hash,role) VALUES ('Staff Coach','anon-bk-staff@x.com','0998777888',?, 'coach')").run(hashPassword('x'));
expect('book with a staff phone → 409 phone_unavailable', () => {
  try {
    createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '冒用者', phone: '0998777888' });
    assert.fail('no throw');
  } catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('staff account is NOT turned into a booking member', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM bookings b JOIN users u ON u.id=b.member_id WHERE u.phone='0998777888'").get().c;
  assert.equal(c, 0);
});
expect('staff account did NOT get a bind code issued', () => {
  const u = db.prepare("SELECT line_bind_code FROM users WHERE phone='0998777888'").get();
  assert.equal(u.line_bind_code, null);
});

console.log('[booking-anon test] done');
