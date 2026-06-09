// §3.2.1 管理者廣播：新 1對1 預約 + 團課確認匯款 時，admin/owner 也收到第三人稱通知。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate } from '../src/services/courseService.js';
import { createBookingAnon, createBooking } from '../src/services/bookingService.js';
import { createGroupOrder, confirmGroupOrder } from '../src/services/groupOrderService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function futureLocal(days, hh=10){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`;}

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'anb-%' OR phone LIKE '0944%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0944%';
    DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'anb-%' OR phone LIKE '0944%');
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'anb-%' OR phone LIKE '0944%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'ANB%');
    DELETE FROM course_templates WHERE name LIKE 'ANB%';
    DELETE FROM coaches WHERE display_name LIKE 'ANB%';
    DELETE FROM users WHERE email LIKE 'anb-%' OR phone LIKE '0944%';
  `);
}

console.log('[admin-notify-broadcast test] start');
reset();

const adminId = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('ANB Admin','anb-admin@x.com',?, 'coach', 1)").run(hashPassword('x')).lastInsertRowid;
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('ANB Coach','anb-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'ANB 教練' });
setCoachActive(coach.id, true);
const coachUserId = cu.lastInsertRowid;

const adminNotif = (type) => db.prepare('SELECT body FROM notifications WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 1').get(adminId, type);

// ── 1對1：管理者收到 booking_created（第三人稱，含報名者姓名）──
createBookingAnon({ coachId: coach.id, startAt: futureLocal(5), name: '測試客甲', phone: '0944000001' });
expect('1對1 預約 → 管理者收到 booking_created', () => {
  const n = adminNotif('booking_created');
  assert(n, '管理者應收到 1對1 通知');
  assert(n.body.includes('測試客甲'), '應第三人稱含報名者姓名');
});
expect('1對1 → 教練仍收到、會員仍收到（無回歸）', () => {
  assert(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='booking_created'").get(coachUserId), '教練應收到');
  const member = db.prepare("SELECT id FROM users WHERE phone='0944000001'").get();
  assert(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='booking_confirmed'").get(member.id), '會員應收到');
});

// ── 團課：確認匯款 → 管理者收到 course_registered_admin（中性、不含「你帶的」）──
const t = createTemplate({ name: 'ANB 團課', min_capacity: 1, max_capacity: 5, day_of_week: 1, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40), coach_id: coach.id });
const s = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(t.templateId);
const o = createGroupOrder({ name: '測試客乙', phone: '0944000002', paySessionIds: [s.id] });
expect('團課下單時 → 管理者尚未收到（要等確認匯款）', () => {
  assert.equal(adminNotif('course_registered_admin'), undefined);
});
confirmGroupOrder({ orderId: o.orderId, actorId: adminId });
expect('團課確認匯款 → 管理者收到 course_registered_admin', () => {
  const n = adminNotif('course_registered_admin');
  assert(n, '管理者應收到團課通知');
  assert(n.body.includes('測試客乙') && n.body.includes('ANB 團課'), '含報名者姓名 + 課名');
  assert(!n.body.includes('你帶的'), '不應出現教練專屬字眼「你帶的」');
});
expect('團課 → 教練仍收 course_registered_coach、會員仍收 payment_received（無回歸）', () => {
  assert(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='course_registered_coach'").get(coachUserId), '教練應收到');
  assert(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='payment_received'").get(o.memberId), '會員應收到');
});

// ── 排除本人：管理者若自己是報名者，不應收到第三人稱廣播（只收第二人稱確認）──
const adminId2 = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('ANB Admin2','anb-admin2@x.com',?, 'coach', 1)").run(hashPassword('x')).lastInsertRowid;
createBooking({ coachId: coach.id, memberId: adminId2, startAt: futureLocal(6) });
expect('管理者本人報名 → 收到第二人稱 booking_confirmed', () => {
  assert(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='booking_confirmed'").get(adminId2), '本人應收確認');
});
expect('管理者本人報名 → 不誤發第三人稱 booking_created 給本人（excludeUserId）', () => {
  assert(!db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='booking_created'").get(adminId2), '不應誤發第三人稱給本人');
});

console.log('[admin-notify-broadcast test] done');
