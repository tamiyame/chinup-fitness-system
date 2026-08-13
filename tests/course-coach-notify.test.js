import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate, editTemplate, getTemplate, processDeadlines } from '../src/services/courseService.js';
import { notifyCourseCoach } from '../src/services/notifications.js';
import { register, cancelRegistration } from '../src/services/registration.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE session_id IN (SELECT id FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'CCN%'));
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ccn-%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'CCN%');
    DELETE FROM course_templates WHERE name LIKE 'CCN%';
    DELETE FROM coaches WHERE display_name LIKE 'CCN%';
    DELETE FROM users WHERE email LIKE 'ccn-%';
  `);
}

function makeCoach(tag) {
  const u = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?, 'coach')")
    .run(`CCN ${tag}`, `ccn-${tag}@x.com`, hashPassword('x'));
  const coach = createCoach({ userId: u.lastInsertRowid, displayName: `CCN ${tag}` });
  setCoachActive(coach.id, true);
  return { coachId: coach.id, userId: u.lastInsertRowid };
}

console.log('[course-coach-notify test] start');
reset();

// ── 步驟2：展開場次帶入 coach_id ───────────────────────────────────────
const A = makeCoach('A');
const B = makeCoach('B');

const r = createTemplate({
  name: 'CCN 週一團課', min_capacity: 1, max_capacity: 6,
  day_of_week: 1, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: dstr(1), cycle_end_date: dstr(40), coach_id: A.coachId,
});
expect('展開的場次全部帶 coach_id（=範本教練A）', () => {
  const rows = db.prepare('SELECT coach_id FROM course_sessions WHERE template_id = ?').all(r.templateId);
  assert(rows.length > 0, '應有場次');
  assert(rows.every(s => s.coach_id === A.coachId), `所有場次 coach_id 應為 ${A.coachId}`);
});

editTemplate(r.templateId, {
  name: 'CCN 週一團課', min_capacity: 1, max_capacity: 6,
  day_of_week: 1, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: dstr(1), cycle_end_date: dstr(40), coach_id: B.coachId,
});
expect('改範本教練→未來場次同步為教練B', () => {
  const rows = db.prepare('SELECT coach_id FROM course_sessions WHERE template_id = ?').all(r.templateId);
  assert(rows.length > 0);
  assert(rows.every(s => s.coach_id === B.coachId), `所有未來場次 coach_id 應同步為 ${B.coachId}`);
});

// ── 步驟3：notifyCourseCoach helper ───────────────────────────────────
expect('notifyCourseCoach 寫入教練 user 的 notifications（console 通道）', () => {
  notifyCourseCoach({
    coachId: A.coachId, sessionId: null, type: 'course_registered_coach',
    vars: { member_name: '測試會員', course_name: 'CCN 週一團課', start_at: '2026-06-15T19:00:00' },
  });
  const row = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'course_registered_coach' ORDER BY id DESC LIMIT 1").get(A.userId);
  assert(row, '應有教練通知列');
  assert.equal(row.channel, 'console');
  assert.equal(row.status, 'sent');
  assert(row.body.includes('測試會員') && row.body.includes('CCN 週一團課'), 'body 應含 member_name 與 course_name');
});
expect('coachId 為空 → 靜默略過（不丟錯、不寫列）', () => {
  const before = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
  notifyCourseCoach({ coachId: null, sessionId: null, type: 'course_registered_coach', vars: {} });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications').get().c, before);
});

// ── 步驟4：各事件加掛教練通知（端對端）────────────────────────────────
function makeMember(tag) {
  return db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?, 'user')")
    .run(`CCN ${tag}`, `ccn-${tag}@x.com`, hashPassword('x')).lastInsertRowid;
}
const C = makeCoach('C');
const coachNotif = (type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(C.userId, type).c;
const m1 = makeMember('m1');
const m2 = makeMember('m2');

// 報名/候補：max_capacity=1 → 第一位正取、第二位候補
const rt = createTemplate({ name: 'CCN 事件課', min_capacity: 1, max_capacity: 1, day_of_week: 3, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40), coach_id: C.coachId });
const sess = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(rt.templateId);
register({ sessionId: sess.id, userId: m1 });
register({ sessionId: sess.id, userId: m2 });
expect('新報名→教練收到 course_registered_coach', () => assert.equal(coachNotif('course_registered_coach'), 1));
expect('候補→教練收到 course_waitlisted_coach', () => assert.equal(coachNotif('course_waitlisted_coach'), 1));

const reg1 = db.prepare('SELECT id FROM registrations WHERE session_id=? AND user_id=?').get(sess.id, m1);
cancelRegistration({ registrationId: reg1.id, userId: m1 });
expect('會員取消→教練收到 course_member_cancelled_coach', () => assert.equal(coachNotif('course_member_cancelled_coach'), 1));
expect('遞補→教練收到 course_promoted_coach', () => assert.equal(coachNotif('course_promoted_coach'), 1));

// 成班 / 未開課：register 後把截止改為過去，再跑 processDeadlines
const rtC = createTemplate({ name: 'CCN 成班課', min_capacity: 1, max_capacity: 5, day_of_week: 4, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40), coach_id: C.coachId });
const sC = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(rtC.templateId);
register({ sessionId: sC.id, userId: m1 });
db.prepare("UPDATE course_sessions SET registration_deadline='2000-01-01T00:00:00' WHERE id=?").run(sC.id);

const rtX = createTemplate({ name: 'CCN 未開課', min_capacity: 2, max_capacity: 5, day_of_week: 5, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40), coach_id: C.coachId });
const sX = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(rtX.templateId);
register({ sessionId: sX.id, userId: m2 });
db.prepare("UPDATE course_sessions SET registration_deadline='2000-01-01T00:00:00' WHERE id=?").run(sX.id);

processDeadlines();
expect('成班→教練收到 course_confirmed_coach', () => assert.equal(coachNotif('course_confirmed_coach'), 1));
expect('未開課→教練收到 course_cancelled_coach', () => assert.equal(coachNotif('course_cancelled_coach'), 1));

const memberSessNotif = (uid, type, sid) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=? AND session_id=?').get(uid, type, sid).c;
expect('成班→會員不再收 course_confirmed（報名成功那次就好）', () => assert.equal(memberSessNotif(m1, 'course_confirmed', sC.id), 0));
expect('未開課→會員仍收 course_cancelled（回歸守門）', () => assert.equal(memberSessNotif(m2, 'course_cancelled', sX.id), 1));

// 守門：場次未指定教練時，事件不產生任何教練通知
const rtNo = createTemplate({ name: 'CCN 無教練課', min_capacity: 1, max_capacity: 3, day_of_week: 6, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40) });
const sNo = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(rtNo.templateId);
expect('無教練場次 coach_id 為 null', () => assert.equal(sNo.coach_id, null));
const mNo = makeMember('mno');
const coachNotifBefore = db.prepare("SELECT COUNT(*) c FROM notifications WHERE type LIKE '%_coach'").get().c;
register({ sessionId: sNo.id, userId: mNo });
expect('無教練場次報名不產生教練通知', () => assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type LIKE '%_coach'").get().c, coachNotifBefore));

console.log('[course-coach-notify test] done');
