import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { getPublicGroupCourses } from '../src/services/groupOrderService.js';
import { weekStartMonday } from '../src/services/period.js';

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
function ymdAdd(ymd, days) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); }

console.log('[group-public-past test] start');
reset();

const today = dstr(0);
const weekStart = weekStartMonday(today);
const beforeWeek = ymdAdd(weekStart, -1);   // 本週週一的前一天（上週日）＝窗口外

const mk = (name) => createTemplate({
  name, min_capacity: 1, max_capacity: 3,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(50),
  registration_deadline_hours: 1, price_per_session: 500,
});
const tpl = mk('灰列班');
const tpl2 = mk('灰列班2');
const sess = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').all(tpl.templateId);
assert.ok(sess.length >= 6, `need >= 6 sessions, got ${sess.length}`);
const [s0, s1, s3, s4, s5, s6] = sess;
const s2 = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').get(tpl2.templateId);

// s0 上週（窗口外，應完全不回）；s1 今天凌晨已結束（本週內，灰色 ended）；s2 第二範本今天凌晨流課（本週內，not_held）；
// s3 未來已成班（已截止）；s4 未來 open 但暫停（隱藏）；s5 可報名；s6 未來 open 但截止時間已過（deadline 空窗）
const upd = db.prepare('UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=?, status=?, is_open=? WHERE id=?');
upd.run(beforeWeek, `${beforeWeek}T19:00:00`, `${beforeWeek}T20:00:00`, `${beforeWeek}T18:00:00`, 'confirmed', 1, s0.id);
upd.run(today, `${today}T00:01:00`, `${today}T00:02:00`, `${beforeWeek}T18:00:00`, 'confirmed', 1, s1.id);
upd.run(today, `${today}T00:02:00`, `${today}T00:03:00`, `${beforeWeek}T18:00:00`, 'cancelled', 1, s2.id);
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(s3.id);
db.prepare("UPDATE course_sessions SET is_open=0 WHERE id=?").run(s4.id);
db.prepare('UPDATE course_sessions SET registration_deadline=? WHERE id=?').run(dt(-1, '18:00:00'), s6.id);

const all = getPublicGroupCourses();
const t = all.find((x) => x.id === tpl.templateId);
const t2 = all.find((x) => x.id === tpl2.templateId);
expect('範本仍列出（尚有可報名場次）', () => { assert.ok(t); assert.ok(t2); });
const by = Object.fromEntries(t.sessions.map((s) => [s.id, s]));
const by2 = Object.fromEntries(t2.sessions.map((s) => [s.id, s]));

expect('本週週一之前的場次 → 完全不回（窗口外）', () => assert.equal(by[s0.id], undefined));
expect('本週已結束（今天凌晨）→ ended、不可選', () => { assert.equal(by[s1.id].state, 'ended'); assert.equal(by[s1.id].selectable, false); });
expect('本週流課 → not_held', () => assert.equal(by2[s2.id].state, 'not_held'));
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
