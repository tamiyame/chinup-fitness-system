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

// ── Task 3: 團課訂單彙整 + 去重 ──
const gcU = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP GCoach','ndup-gc@x.com',?, 'coach',1)").run(hashPassword('x')); // 教練兼管理者
const gcCoach = createCoach({ userId: gcU.lastInsertRowid, displayName: 'NDUP 團課教練' });
setCoachActive(gcCoach.id, true);
const gcUserId = gcU.lastInsertRowid;
const pureAdmin = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP PureAdmin','ndup-pa@x.com',?, 'coach',1)").run(hashPassword('x')).lastInsertRowid; // 純管理者（非該課教練）

const gt = createTemplate({ name: 'NDUP 綜合體能', min_capacity: 1, max_capacity: 10, day_of_week: 3, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(45), coach_id: gcCoach.id });
const sess3 = db.prepare('SELECT id, start_at FROM course_sessions WHERE template_id=? ORDER BY start_at ASC LIMIT 3').all(gt.templateId);
expect('團課測試前置：取得 3 個場次', () => assert.equal(sess3.length, 3));
const go = createGroupOrder({ name: '沈嗗', phone: '0955000002', paySessionIds: sess3.map(s => s.id) });
confirmGroupOrder({ orderId: go.orderId, actorId: pureAdmin });

expect('團課多堂：教練只收一則 course_registered_coach_batch', () => assert.equal(notifCount(gcUserId, 'course_registered_coach_batch'), 1));
expect('教練那則含「共 3 堂」與全部 3 個日期(M/D)', () => {
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='course_registered_coach_batch' ORDER BY id DESC LIMIT 1").get(gcUserId);
  assert(row.body.includes('共 3 堂'), row.body);
  for (const s of sess3) { const m=/^\d{4}-(\d{2})-(\d{2})/.exec(s.start_at); const md=`${Number(m[1])}/${Number(m[2])}`; assert(row.body.includes(md), `body 應含 ${md}: ${row.body}`); }
});
expect('教練兼管理者不再收 course_registered_admin*（去重）', () => {
  const c = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type IN ('course_registered_admin','course_registered_admin_batch')").get(gcUserId).c;
  assert.equal(c, 0);
});
expect('純管理者收一則 course_registered_admin_batch 摘要', () => assert.equal(notifCount(pureAdmin, 'course_registered_admin_batch'), 1));
expect('會員仍只收一則 payment_received', () => assert.equal(notifCount(go.memberId, 'payment_received'), 1));

// N=1 訂單 → 用單堂範本（無「共 N 堂」）
const sess1 = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC LIMIT 1 OFFSET 3').all(gt.templateId);
expect('團課測試前置：取得第 4 個場次（N=1 用）', () => assert.equal(sess1.length, 1));
const go1 = createGroupOrder({ name: '沈嗗', phone: '0955000003', paySessionIds: sess1.map(s => s.id) });
confirmGroupOrder({ orderId: go1.orderId, actorId: pureAdmin });
expect('N=1 團課：教練收單堂 course_registered_coach（非 batch）', () => assert.equal(notifCount(gcUserId, 'course_registered_coach'), 1));

console.log('[notification-dedup test] done');
