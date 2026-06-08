// 團課「今日請假」：標記 on_leave、釋名額遞補候補、不退款不取消訂單、通知教練、本人驗證。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate } from '../src/services/courseService.js';
import { createGroupOrder, confirmGroupOrder, takeLeavePublic, getPublicSchedule, sessionOccupied } from '../src/services/groupOrderService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lv-%' OR phone LIKE '0966%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0966%';
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lv-%' OR phone LIKE '0966%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'LV%');
    DELETE FROM course_templates WHERE name LIKE 'LV%';
    DELETE FROM coaches WHERE display_name LIKE 'LV%';
    DELETE FROM users WHERE email LIKE 'lv-%' OR phone LIKE '0966%';
  `);
}

console.log('[group-leave test] start');
reset();

// 教練 D（收請假/遞補通知）+ admin（確認匯款）
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('LV 教練','lv-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'LV 教練D' });
setCoachActive(coach.id, true);
const coachUserId = cu.lastInsertRowid;
const adminId = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('LV Admin','lv-admin@x.com',?, 'admin')").run(hashPassword('x')).lastInsertRowid;
const coachNotif = (type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(coachUserId, type).c;

// 範本（教練 D，max 1 以製造候補）
const tpl = createTemplate({ name: 'LV 團課', min_capacity: 1, max_capacity: 1, day_of_week: 3, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(60), coach_id: coach.id });
const futureSessions = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at DESC').all(tpl.templateId);
const sMain = futureSessions[0];   // 主測：請假釋名額遞補
const sStart = futureSessions[1];  // 開課後請假測試（之後改 start_at 為過去）

// 甲：付款確認(confirmed) on sMain；乙：候補 on sMain
const oA = createGroupOrder({ name: '甲', phone: '0966000001', paySessionIds: [sMain.id] });
confirmGroupOrder({ orderId: oA.orderId, actorId: adminId });
const oB = createGroupOrder({ name: '乙', phone: '0966000002', waitlistSessionIds: [sMain.id] });
const regA = db.prepare("SELECT id FROM registrations WHERE user_id=? AND session_id=?").get(oA.memberId, sMain.id);
const regB = db.prepare("SELECT id FROM registrations WHERE user_id=? AND session_id=?").get(oB.memberId, sMain.id);

expect('請假前：sMain 佔用=1（甲）', () => assert.equal(sessionOccupied(sMain.id), 1));

// ── 本人驗證 ──
expect('錯姓名請假 → 403 forbidden', () => {
  try { takeLeavePublic({ registrationId: regA.id, phone: '0966000001', name: '錯人' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});
// ── 非 confirmed（乙為候補）→ 409 not_confirmed ──
expect('候補者請假 → 409 not_confirmed', () => {
  try { takeLeavePublic({ registrationId: regB.id, phone: '0966000002', name: '乙' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'not_confirmed'); }
});

// ── 核心：甲請假 ──
const res = takeLeavePublic({ registrationId: regA.id, phone: '0966000001', name: '甲' });
expect('takeLeavePublic 回 ok', () => assert.equal(res.ok, true));
expect('甲：on_leave=1、status 仍 confirmed', () => {
  const r = db.prepare('SELECT status, on_leave FROM registrations WHERE id=?').get(regA.id);
  assert.equal(r.status, 'confirmed'); assert.equal(r.on_leave, 1);
});
expect('甲的訂單未被取消（仍 paid）', () => {
  assert.equal(db.prepare('SELECT status FROM group_orders WHERE id=?').get(oA.orderId).status, 'paid');
});
expect('請假後名額釋出 → 乙被遞補（waitlisted → pending）', () => {
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(regB.id).status, 'pending');
});
expect('教練收到 course_member_leave_coach', () => assert.equal(coachNotif('course_member_leave_coach'), 1));
expect('教練收到 course_promoted_coach（乙遞補）', () => assert.equal(coachNotif('course_promoted_coach'), 1));

// ── 重複請假 → 409 already_on_leave ──
expect('重複請假 → 409 already_on_leave', () => {
  try { takeLeavePublic({ registrationId: regA.id, phone: '0966000001', name: '甲' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'already_on_leave'); }
});

// ── 開課後不可請假 → 409 session_started ──
const oC = createGroupOrder({ name: '丙', phone: '0966000003', paySessionIds: [sStart.id] });
confirmGroupOrder({ orderId: oC.orderId, actorId: adminId });
const regC = db.prepare("SELECT id FROM registrations WHERE user_id=? AND session_id=?").get(oC.memberId, sStart.id);
db.prepare("UPDATE course_sessions SET start_at='2000-01-01T19:00:00' WHERE id=?").run(sStart.id);
expect('開課後請假 → 409 session_started', () => {
  try { takeLeavePublic({ registrationId: regC.id, phone: '0966000003', name: '丙' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'session_started'); }
});

// ── getPublicSchedule：甲的請假項 + 剩餘堂數 ──
expect('getPublicSchedule：甲請假項 on_leave=true / can_leave=false / can_cancel=false', () => {
  const sched = getPublicSchedule({ phone: '0966000001', name: '甲' });
  const item = sched.items.find(i => i.kind === 'registration' && i.session_id === sMain.id);
  assert(item, '應找到甲在 sMain 的報名');
  assert.equal(item.on_leave, true);
  assert.equal(item.can_leave, false);
  assert.equal(item.can_cancel, false);
});
expect('getPublicSchedule：請假場次不計入 group_remaining', () => {
  const sched = getPublicSchedule({ phone: '0966000001', name: '甲' });
  // 甲只有 sMain 一筆 confirmed 但已請假 → 剩餘團課應為 0
  assert.equal(sched.group_remaining, 0);
});

console.log('[group-leave test] done');
