// 安全：公開預約（1對1 + 團課）不可用「員工帳號的電話」重用，
// 否則預約會掛到員工帳號、且成功頁外洩其 LINE 綁定碼（帳號接管 / IDOR）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate } from '../src/services/courseService.js';
import { createBookingAnon } from '../src/services/bookingService.js';
import { createGroupOrder } from '../src/services/groupOrderService.js';
import { findOrCreateUserByPhone } from '../src/services/userService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function futureLocal(days, hh=10){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`;}

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'idor-%' OR phone LIKE '0955%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0955%';
    DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'idor-%' OR phone LIKE '0955%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'IDOR%');
    DELETE FROM course_templates WHERE name LIKE 'IDOR%';
    DELETE FROM coaches WHERE display_name LIKE 'IDOR%';
    DELETE FROM users WHERE email LIKE 'idor-%' OR phone LIKE '0955%';
  `);
}

const STAFF_COACH_PHONE = '0955111222';
const STAFF_ADMIN_PHONE = '0955333444';

console.log('[booking-staff-phone-idor test] start');
reset();

// 帶電話的「教練」帳號（模擬：有電話的會員被升級成教練）+ 帶電話的「管理者」
db.prepare("INSERT INTO users (name,email,phone,password_hash,role) VALUES ('IDOR 王教練','idor-coach@x.com',?,?, 'coach')").run(STAFF_COACH_PHONE, hashPassword('x'));
db.prepare("INSERT INTO users (name,email,phone,password_hash,role) VALUES ('IDOR Admin','idor-admin@x.com',?,?, 'admin')").run(STAFF_ADMIN_PHONE, hashPassword('x'));

// ── Fix A：findOrCreateUserByPhone 直接守門 ──────────────────────────
expect('教練電話 → findOrCreateUserByPhone 擋下 (409 phone_unavailable)', () => {
  try { findOrCreateUserByPhone({ phone: STAFF_COACH_PHONE, name: '冒用者' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('管理者電話 → 一樣擋下', () => {
  try { findOrCreateUserByPhone({ phone: STAFF_ADMIN_PHONE, name: '隨便' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('被擋時不建新帳號、不覆蓋員工姓名', () => {
  assert.equal(db.prepare("SELECT name FROM users WHERE phone=?").get(STAFF_COACH_PHONE).name, 'IDOR 王教練');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE name='冒用者'").get().c, 0);
});
expect('一般會員電話 → 正常建立 / 回傳 role=user 帳號', () => {
  const u = findOrCreateUserByPhone({ phone: '0955900001', name: '正常客' });
  assert.equal(u.role, 'user');
  // 同電話再次呼叫 → 回傳同一帳號（姓名以首次為準，不再被忽略外的副作用）
  const u2 = findOrCreateUserByPhone({ phone: '0955900001', name: '別名' });
  assert.equal(u2.id, u.id);
});

// ── 1對1 匿名預約：用教練電話 → 擋下、不建 booking、不外洩綁定碼 ──────────
const bu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('IDOR BookCoach','idor-bookcoach@x.com',?, 'coach')").run(hashPassword('x'));
const bcoach = createCoach({ userId: bu.lastInsertRowid, displayName: 'IDOR 帶課教練' });
setCoachActive(bcoach.id, true);
expect('1對1 用教練電話預約 → 409 phone_unavailable', () => {
  try { createBookingAnon({ coachId: bcoach.id, startAt: futureLocal(5), name: '冒用者', phone: STAFF_COACH_PHONE }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('1對1 被擋 → 教練帳號無 booking、無綁定碼外洩', () => {
  assert.equal(db.prepare("SELECT COUNT(*) c FROM bookings b JOIN users u ON u.id=b.member_id WHERE u.phone=?").get(STAFF_COACH_PHONE).c, 0);
  assert.equal(db.prepare("SELECT line_bind_code FROM users WHERE phone=?").get(STAFF_COACH_PHONE).line_bind_code, null);
});

// ── 團課：建立有未來場次的範本，用教練電話下單 → 擋下；正常會員 → 正常 ──────
const t = createTemplate({ name: 'IDOR 團課', min_capacity: 1, max_capacity: 5, day_of_week: 1, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40) });
const sess = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(t.templateId);

expect('團課用教練電話下單 → 409 phone_unavailable', () => {
  try { createGroupOrder({ name: '冒用者', phone: STAFF_COACH_PHONE, paySessionIds: [sess.id] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('團課被擋 → 教練帳號無 registration / order、無綁定碼外洩', () => {
  assert.equal(db.prepare("SELECT COUNT(*) c FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone=?").get(STAFF_COACH_PHONE).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM group_orders WHERE customer_phone=?").get(STAFF_COACH_PHONE).c, 0);
  assert.equal(db.prepare("SELECT line_bind_code FROM users WHERE phone=?").get(STAFF_COACH_PHONE).line_bind_code, null);
});
expect('團課正常會員電話 → 正常下單 + 取得綁定碼（未綁 LINE）', () => {
  const r = createGroupOrder({ name: '正常客人', phone: '0955900222', paySessionIds: [sess.id] });
  assert(r.orderId);
  assert(/^\d{6}$/.test(r.lineBindCode), '未綁 LINE 的會員應取得 6 碼綁定碼');
});

console.log('[booking-staff-phone-idor test] done');
