import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { getPublicGroupCourses } from '../src/services/groupOrderService.js';

function reset() {
  db.exec(`
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dt(days, time) { return `${dstr(days)}T${time}`; }

console.log('[group-public-past test] start');
reset();

const tpl = createTemplate({
  name: '灰列班', min_capacity: 1, max_capacity: 3,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(50),
  registration_deadline_hours: 1, price_per_session: 500,
});
const sess = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').all(tpl.templateId);
assert.ok(sess.length >= 6, `need >= 6 sessions, got ${sess.length}`);
const [s1, s2, s3, s4, s5, s6] = sess;

// s1 過去已成班（已結束）；s2 過去流課（未開課）；s3 未來已成班（已截止）；
// s4 未來 open 但暫停（隱藏）；s5 可報名；s6 未來 open 但截止時間已過（deadline 空窗）
const upd = db.prepare('UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=?, status=?, is_open=? WHERE id=?');
upd.run(dstr(-7), dt(-7, '19:00:00'), dt(-7, '20:00:00'), dt(-7, '18:00:00'), 'confirmed', 1, s1.id);
upd.run(dstr(-14), dt(-14, '19:00:00'), dt(-14, '20:00:00'), dt(-14, '18:00:00'), 'cancelled', 1, s2.id);
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(s3.id);
db.prepare("UPDATE course_sessions SET is_open=0 WHERE id=?").run(s4.id);
db.prepare('UPDATE course_sessions SET registration_deadline=? WHERE id=?').run(dt(-1, '18:00:00'), s6.id);

const t = getPublicGroupCourses().find((x) => x.id === tpl.templateId);
expect('範本仍列出（尚有可報名場次）', () => assert.ok(t));
const by = Object.fromEntries(t.sessions.map((s) => [s.id, s]));

expect('過去已成班 → ended、不可選', () => { assert.equal(by[s1.id].state, 'ended'); assert.equal(by[s1.id].selectable, false); });
expect('過去流課 → not_held', () => assert.equal(by[s2.id].state, 'not_held'));
expect('未來已成班 → deadline_passed', () => assert.equal(by[s3.id].state, 'deadline_passed'));
expect('未來暫停中 → 完全隱藏', () => assert.equal(by[s4.id], undefined));
expect('可報名場次 selectable=true / state=selectable', () => { assert.equal(by[s5.id].selectable, true); assert.equal(by[s5.id].state, 'selectable'); });
expect('截止已過但尚未判定 → deadline_passed、不可選', () => { assert.equal(by[s6.id].state, 'deadline_passed'); assert.equal(by[s6.id].selectable, false); });
expect('排序時間升冪（過去在前）', () => {
  const starts = t.sessions.map((s) => s.start_at);
  assert.deepEqual(starts, [...starts].sort());
});
expect('灰色列仍帶容量資訊', () => { assert.equal(typeof by[s1.id].occupied, 'number'); assert.equal(by[s1.id].max_capacity, 3); });

// 全數不可選 → 範本不列出
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE template_id=? AND status='open'").run(tpl.templateId);
expect('無可報名場次的範本不列出', () => {
  assert.equal(getPublicGroupCourses().find((x) => x.id === tpl.templateId), undefined);
});

console.log('[group-public-past test] done');
