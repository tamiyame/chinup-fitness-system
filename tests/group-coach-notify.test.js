// 教練通知 — 真實團體訂單路徑（createGroupOrder → confirm → cancel → 遞補）
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate } from '../src/services/courseService.js';
import { createGroupOrder, confirmGroupOrder, cancelRegistrationPublic } from '../src/services/groupOrderService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '091100099%' OR email LIKE 'gcn-%');
    DELETE FROM group_orders WHERE customer_phone LIKE '091100099%';
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gcn-%' OR phone LIKE '091100099%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'GCN%');
    DELETE FROM course_templates WHERE name LIKE 'GCN%';
    DELETE FROM coaches WHERE display_name LIKE 'GCN%';
    DELETE FROM users WHERE email LIKE 'gcn-%' OR phone LIKE '091100099%';
  `);
}

console.log('[group-coach-notify test] start');
reset();

// 教練 D + admin
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('GCN D','gcn-d@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'GCN 教練D' });
setCoachActive(coach.id, true);
const coachUserId = cu.lastInsertRowid;
const adminId = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('GCN Admin','gcn-admin@x.com',?, 'admin')").run(hashPassword('x')).lastInsertRowid;

const coachNotif = (type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(coachUserId, type).c;

// 範本（指定教練 D，max 1 以便製造候補）
const rt = createTemplate({ name: 'GCN 團課', min_capacity: 1, max_capacity: 1, day_of_week: 3, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(45), coach_id: coach.id });
const sD = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(rt.templateId);
expect('場次帶有教練 D 的 coach_id', () => assert.equal(sD.coach_id, coach.id));

// 1) 下單（未付款 pending）→ 教練「不應」收到新報名通知
const o1 = createGroupOrder({ name: '王小明', phone: '0911000991', paySessionIds: [sD.id] });
expect('未付款下單時教練尚未收到 course_registered_coach', () => assert.equal(coachNotif('course_registered_coach'), 0));

// 2) admin 核對匯款 → confirmed → 教練收到新報名
confirmGroupOrder({ orderId: o1.orderId, actorId: adminId });
expect('核對匯款後教練收到 course_registered_coach', () => assert.equal(coachNotif('course_registered_coach'), 1));

// 3) 場次已滿 → 第二人候補 → 教練收到候補通知
const o2 = createGroupOrder({ name: '李小華', phone: '0911000992', waitlistSessionIds: [sD.id] });
expect('有人候補→教練收到 course_waitlisted_coach', () => assert.equal(coachNotif('course_waitlisted_coach'), 1));

// 4) 王小明取消正取 → 教練收到會員取消 + 候補遞補（李小華）→ 教練收到遞補
const reg1 = db.prepare("SELECT id FROM registrations WHERE user_id=? AND session_id=? AND status='confirmed'").get(o1.memberId, sD.id);
cancelRegistrationPublic({ registrationId: reg1.id, phone: '0911000991', name: '王小明' });
expect('會員取消→教練收到 course_member_cancelled_coach', () => assert.equal(coachNotif('course_member_cancelled_coach'), 1));
expect('候補遞補→教練收到 course_promoted_coach', () => assert.equal(coachNotif('course_promoted_coach'), 1));

console.log('[group-coach-notify test] done');
