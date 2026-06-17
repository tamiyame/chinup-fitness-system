// 通知去重 + 團課訂單彙整（一筆訂單一則、教練兼管理者不重複）
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate } from '../src/services/courseService.js';
import { createBookingAnon } from '../src/services/bookingService.js';
import { createGroupOrder, confirmGroupOrder } from '../src/services/groupOrderService.js';
import { notify, notifyAdmins } from '../src/services/notifications.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function futureLocal(days, hh=10){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`;}
const notifCount = (userId, type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(userId, type).c;

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0955%';
    DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%');
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'NDUP%');
    DELETE FROM course_templates WHERE name LIKE 'NDUP%';
    DELETE FROM coaches WHERE display_name LIKE 'NDUP%';
    DELETE FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%';
  `);
}

console.log('[notification-dedup test] start');
reset();

// ── Task 1: notifyAdmins excludeUserIds + 彙整範本 ──
const a1 = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP A1','ndup-a1@x.com',?, 'coach',1)").run(hashPassword('x')).lastInsertRowid;
const a2 = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP A2','ndup-a2@x.com',?, 'coach',1)").run(hashPassword('x')).lastInsertRowid;
notifyAdmins({ type: 'booking_created', excludeUserIds: [a1], vars: { member_name: 'X', start_at: '7/1' } });
expect('notifyAdmins excludeUserIds 排除 a1', () => assert.equal(notifCount(a1, 'booking_created'), 0));
expect('notifyAdmins 仍送達 a2', () => assert.equal(notifCount(a2, 'booking_created'), 1));

expect('course_registered_coach_batch 範本渲染（共 N 堂 + 日期清單 + 你帶的）', () => {
  notify({ userId: a2, sessionId: null, type: 'course_registered_coach_batch',
    vars: { member_name: '王', course_name: 'NDUP測試課', count: 2, date_list: '7/1、7/8' } });
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='course_registered_coach_batch' ORDER BY id DESC LIMIT 1").get(a2);
  assert(row && row.body.includes('共 2 堂') && row.body.includes('7/1、7/8') && row.body.includes('你帶的'), row && row.body);
});
expect('course_registered_admin_batch 範本渲染（中性、無「你帶的」）', () => {
  notify({ userId: a2, sessionId: null, type: 'course_registered_admin_batch',
    vars: { member_name: '王', course_name: 'NDUP測試課', count: 2, date_list: '7/1、7/8' } });
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='course_registered_admin_batch' ORDER BY id DESC LIMIT 1").get(a2);
  assert(row && row.body.includes('共 2 堂') && !row.body.includes('你帶的'), row && row.body);
});

// ── Task 2: 1對1 — 教練兼管理者只收一則 booking_created ──
const caU = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP CoachAdmin','ndup-ca@x.com',?, 'coach',1)").run(hashPassword('x'));
const caCoach = createCoach({ userId: caU.lastInsertRowid, displayName: 'NDUP 教練兼管理' });
setCoachActive(caCoach.id, true);
const caUserId = caU.lastInsertRowid;
createBookingAnon({ coachId: caCoach.id, startAt: futureLocal(5), name: '客A', phone: '0955000001' });
expect('1對1：教練兼管理者只收一則 booking_created（去重）', () => assert.equal(notifCount(caUserId, 'booking_created'), 1));
const m1on1 = db.prepare("SELECT id FROM users WHERE phone='0955000001'").get();
expect('1對1：會員仍收一則 booking_confirmed', () => assert.equal(notifCount(m1on1.id, 'booking_confirmed'), 1));

console.log('[notification-dedup test] done');
