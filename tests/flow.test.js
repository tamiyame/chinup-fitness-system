// 核心流程驗證（不經 HTTP，直接呼叫 service）
import { db, nowLocal, offsetLocal } from '../src/db/connection.js';
import { createTemplate, processDeadlines, listRegistrationsBySession } from '../src/services/courseService.js';
import { register, cancelRegistration } from '../src/services/registration.js';
import assert from 'node:assert/strict';

function reset() {
  db.exec("DELETE FROM notifications; DELETE FROM registrations; DELETE FROM course_sessions; DELETE FROM course_templates;");
}

function userIds(n) {
  return db.prepare("SELECT id FROM users WHERE role = 'user' ORDER BY id LIMIT ?").all(n).map(r => r.id);
}

function expect(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    console.log(`  ✗ ${label}`);
    console.error(e);
    process.exitCode = 1;
  }
}

console.log('[flow test] start');
reset();

// --- Case 1: 範本展開 ---
// 每月第一個週三，週期 2026-05 到 2026-10，共 6 個月
const t1 = createTemplate({
  name: 'TRX 週三班',
  description: '核心訓練',
  min_capacity: 3,
  max_capacity: 5,
  day_of_week: 3,          // 週三
  start_time: '19:00',
  duration_minutes: 60,
  recurrence: 'monthly',
  cycle_start_date: '2026-05-01',
  cycle_end_date: '2026-10-31',
  registration_deadline_hours: 24,
});
console.log('[case 1] template expansion');
expect('應展開 6 個場次', () => assert.equal(t1.sessionsCreated, 6));

const sessions = db.prepare("SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at").all(t1.templateId);
expect('每場次日期為週三', () => {
  for (const s of sessions) {
    const d = new Date(s.start_at);
    assert.equal(d.getUTCDay(), 3, `session ${s.session_date} is not Wed`);
  }
});
expect('場次狀態為 open', () => sessions.forEach(s => assert.equal(s.status, 'open')));

// --- Case 2: 報名滿額 → 候補 ---
// 為了繞過 registration_deadline，把第一個 session 改為未來日期
const firstSessionId = sessions[0].id;
const futureStart = offsetLocal(48 * 60 * 60 * 1000);
const futureEnd = offsetLocal(49 * 60 * 60 * 1000);
const futureDeadline = offsetLocal(24 * 60 * 60 * 1000);
db.prepare("UPDATE course_sessions SET start_at = ?, end_at = ?, registration_deadline = ? WHERE id = ?")
  .run(futureStart, futureEnd, futureDeadline, firstSessionId);

const [u1, u2, u3, u4, u5, u6, u7] = userIds(7);

console.log('[case 2] register up to max then overflow');
const r1 = register({ sessionId: firstSessionId, userId: u1 });
const r2 = register({ sessionId: firstSessionId, userId: u2 });
const r3 = register({ sessionId: firstSessionId, userId: u3 });
const r4 = register({ sessionId: firstSessionId, userId: u4 });
const r5 = register({ sessionId: firstSessionId, userId: u5 });
const r6 = register({ sessionId: firstSessionId, userId: u6 });
const r7 = register({ sessionId: firstSessionId, userId: u7 });

expect('前 5 位為 confirmed', () => [r1, r2, r3, r4, r5].forEach(r => assert.equal(r.status, 'confirmed')));
expect('第 6 位為 waitlisted position=1', () => { assert.equal(r6.status, 'waitlisted'); assert.equal(r6.position, 1); });
expect('第 7 位為 waitlisted position=2', () => { assert.equal(r7.status, 'waitlisted'); assert.equal(r7.position, 2); });

const s = db.prepare('SELECT * FROM course_sessions WHERE id = ?').get(firstSessionId);
expect('confirmed_count=5 / waitlist_count=2', () => {
  assert.equal(s.confirmed_count, 5);
  assert.equal(s.waitlist_count, 2);
});

// --- Case 3: 重複報名應拒絕 ---
console.log('[case 3] duplicate register');
expect('重複報名 throw already_registered', () => {
  assert.throws(() => register({ sessionId: firstSessionId, userId: u1 }), /already_registered/);
});

// --- Case 4: 取消正取 → 候補遞補 ---
console.log('[case 4] cancel confirmed promotes waitlist[0]');
cancelRegistration({ registrationId: r1.registrationId, userId: u1 });
const r6After = db.prepare('SELECT * FROM registrations WHERE id = ?').get(r6.registrationId);
const r7After = db.prepare('SELECT * FROM registrations WHERE id = ?').get(r7.registrationId);
expect('r6 變 confirmed', () => assert.equal(r6After.status, 'confirmed'));
expect('r7 仍 waitlisted 且 position=1', () => {
  assert.equal(r7After.status, 'waitlisted');
  assert.equal(r7After.position, 1);
});

// --- Case 5: 截止處理 - 達下限 → 成立 ---
console.log('[case 5] processDeadlines: meet minimum → confirmed');
// 把 deadline 調到過去
db.prepare("UPDATE course_sessions SET registration_deadline = ? WHERE id = ?")
  .run(offsetLocal(-1000), firstSessionId);
const dl1 = processDeadlines();
expect('processDeadlines 回傳 confirmed 動作', () => {
  const entry = dl1.find(x => x.sessionId === firstSessionId);
  assert.equal(entry.action, 'confirmed');
});
const sAfter = db.prepare('SELECT status FROM course_sessions WHERE id = ?').get(firstSessionId);
expect('場次狀態為 confirmed', () => assert.equal(sAfter.status, 'confirmed'));

// --- Case 6: 截止處理 - 未達下限 → 取消 ---
console.log('[case 6] processDeadlines: below minimum → cancelled');
const secondSessionId = sessions[1].id;
const pastDeadline = offsetLocal(-1000);
const pastStart = offsetLocal(3600 * 1000);
db.prepare("UPDATE course_sessions SET registration_deadline = ?, start_at = ?, end_at = ? WHERE id = ?")
  .run(pastDeadline, pastStart, pastStart, secondSessionId);

// 僅 2 人報名，低於 min_capacity=3  … 但 deadline 已過，register 會拒絕
// 改用直接插入 registrations 繞過 deadline 檢查
const insertReg = db.prepare(
  "INSERT INTO registrations (session_id, user_id, status, position, registered_at) VALUES (?, ?, 'confirmed', NULL, datetime('now'))"
);
insertReg.run(secondSessionId, u1);
insertReg.run(secondSessionId, u2);
db.prepare("UPDATE course_sessions SET confirmed_count = 2 WHERE id = ?").run(secondSessionId);

const dl2 = processDeadlines();
expect('第二場次 action=cancelled', () => {
  const entry = dl2.find(x => x.sessionId === secondSessionId);
  assert.equal(entry.action, 'cancelled');
});
const s2After = db.prepare('SELECT status FROM course_sessions WHERE id = ?').get(secondSessionId);
expect('場次狀態為 cancelled', () => assert.equal(s2After.status, 'cancelled'));

// --- Case 7: 通知紀錄齊全 ---
console.log('[case 7] notification log');
const notifCount = db.prepare("SELECT COUNT(*) AS c FROM notifications").get().c;
expect('通知筆數 > 10', () => assert(notifCount > 10, `only ${notifCount}`));

console.log(`\n[flow test] done (${notifCount} notifications logged)`);
