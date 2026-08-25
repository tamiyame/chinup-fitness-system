// 自動續期工作：窗口判定、只續 published+auto_renew、冪等、管理者通知一則。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { rolloverTemplates } from '../src/services/periodService.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
console.log('[period-rollover test] start');

db.exec(`
  DELETE FROM registrations;
  DELETE FROM group_orders;
  DELETE FROM course_sessions;
  DELETE FROM course_templates;
  DELETE FROM notifications WHERE type = 'period_rollover_admin';
  DELETE FROM users WHERE email LIKE 'pdrl-%';
`);
const adminUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('PR管理','pdrl-a@x.com','coach',1)").run().lastInsertRowid);
const adminNotifs = () => db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='period_rollover_admin'").get(adminUid).c;
const count = (id) => db.prepare('SELECT COUNT(*) c FROM course_sessions WHERE template_id=?').get(id).c;
const endOf = (id) => db.prepare('SELECT cycle_end_date e FROM course_templates WHERE id=?').get(id).e;

// 週三課、7–8 月期：7/1,8,15,22,29,8/5,12,19,26 = 9 場
const base = {
  min_capacity: 1, max_capacity: 6, day_of_week: 3, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: '2026-07-01', cycle_end_date: '2026-08-31', registration_deadline_hours: 24, price_per_session: 400,
};
const A = createTemplate({ ...base, name: 'PR續期A(週三)' });
const B = createTemplate({ ...base, name: 'PR不續B', auto_renew: 0 });
const C = createTemplate({ ...base, name: 'PR草稿C', status: 'draft' });
const D = createTemplate({ ...base, name: 'PR已延D', cycle_end_date: '2026-12-31' });
const aBefore = count(A.templateId);
const dBefore = count(D.templateId);
expect('前置：A 原有 9 場', () => assert.equal(aBefore, 9));

// 8/23：尚未進最後一週（8/24 起）
const r0 = rolloverTemplates('2026-08-23');
expect('8/23 → targetEnd=本期末 8/31、無延長', () => { assert.equal(r0.targetEnd, '2026-08-31'); assert.deepEqual(r0.extended, []); });
expect('8/23 → A 結束日不變', () => assert.equal(endOf(A.templateId), '2026-08-31'));

// 8/24：進最後一週
const n0 = adminNotifs();
const r1 = rolloverTemplates('2026-08-24');
expect('8/24 → targetEnd=下期末 10/31', () => assert.equal(r1.targetEnd, '2026-10-31'));
expect('只延 A', () => assert.deepEqual(r1.extended.map((e) => e.id), [A.templateId]));
expect('A 結束日延到 10/31、起始日不動', () => {
  const t = db.prepare('SELECT cycle_start_date s, cycle_end_date e FROM course_templates WHERE id=?').get(A.templateId);
  assert.equal(t.e, '2026-10-31'); assert.equal(t.s, '2026-07-01');
});
// 9–10 月週三：9/2,9,16,23,30,10/7,14,21,28 = 9 場
expect('A 新增 9 場（added 與實際列數一致）', () => { assert.equal(r1.extended[0].added, 9); assert.equal(count(A.templateId), aBefore + 9); });
expect('新場次 status=open、最後一場 10/28', () => {
  const last = db.prepare('SELECT session_date, status FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(A.templateId);
  assert.equal(last.session_date, '2026-10-28'); assert.equal(last.status, 'open');
});
expect('B（auto_renew=0）不動', () => { assert.equal(endOf(B.templateId), '2026-08-31'); assert.equal(count(B.templateId), 9); });
expect('C（draft）不動', () => { assert.equal(endOf(C.templateId), '2026-08-31'); assert.equal(count(C.templateId), 9); });
expect('D（已到 12/31）不動', () => { assert.equal(endOf(D.templateId), '2026-12-31'); assert.equal(count(D.templateId), dBefore); });
expect('管理者通知恰 1 則', () => assert.equal(adminNotifs() - n0, 1));
expect('通知內容含期別與摘要', () => {
  const row = db.prepare("SELECT subject, body FROM notifications WHERE user_id=? AND type='period_rollover_admin' ORDER BY id DESC LIMIT 1").get(adminUid);
  assert.equal(row.subject, '9–10 月 期課已開放報名');
  assert.equal(row.body, '📅 9–10 月 期課已自動開放報名：PR續期A(週三) 9 場。');
});

// 冪等
const r2 = rolloverTemplates('2026-08-24');
expect('同日重跑 → 無延長、場次數不變、通知不增', () => {
  assert.deepEqual(r2.extended, []); assert.equal(count(A.templateId), aBefore + 9); assert.equal(adminNotifs() - n0, 1);
});
expect('9/1（期中）重跑 → 不動', () => assert.deepEqual(rolloverTemplates('2026-09-01').extended, []));

// 下一期窗口
const r3 = rolloverTemplates('2026-10-19');
expect('10/19 → A 延到 12/31、B 仍 8/31', () => {
  assert.equal(r3.targetEnd, '2026-12-31'); assert.equal(endOf(A.templateId), '2026-12-31'); assert.equal(endOf(B.templateId), '2026-08-31');
});
expect('10/19 → D 已在 12/31 不列入 extended', () => assert.ok(!r3.extended.some((e) => e.id === D.templateId)));

// 期中補回：auto_renew=1 但結束日被手動改到期中 → 隔日補回本期末
db.prepare("UPDATE course_templates SET cycle_end_date='2026-11-15' WHERE id=?").run(A.templateId);
const r4 = rolloverTemplates('2026-11-05');
expect('11/5 期中、A 結束日 11/15 → 補回 12/31', () => { assert.equal(r4.targetEnd, '2026-12-31'); assert.equal(endOf(A.templateId), '2026-12-31'); });

// F4：非週規律（monthly）續期覆蓋。monthly=每月第一個週三 → 7/1,8/5 = 2 場（起始）
const M = createTemplate({ ...base, name: 'PR月課M(週三)', recurrence: 'monthly' });
expect('前置：M 原有 2 場（monthly 首週三）', () => assert.equal(count(M.templateId), 2));
const r5 = rolloverTemplates('2026-08-24');
expect('M 隨續期延到 10/31', () => assert.equal(endOf(M.templateId), '2026-10-31'));
expect('M 新增恰 2 場（9/2, 10/7 首週三），累計 4 場', () => {
  const mEntry = r5.extended.find((e) => e.id === M.templateId);
  assert.ok(mEntry);
  assert.equal(mEntry.added, 2);
  assert.equal(count(M.templateId), 4);
});
expect('M 場次日期依序為 7/1,8/5,9/2,10/7', () => {
  const dates = db.prepare('SELECT session_date FROM course_sessions WHERE template_id=? ORDER BY session_date ASC').all(M.templateId).map((r) => r.session_date);
  assert.deepEqual(dates, ['2026-07-01', '2026-08-05', '2026-09-02', '2026-10-07']);
});

// F1：重展開跳過過去日期。範本曾停用/草稿許久後重新發布 auto_renew，
// 若場次全被清空（空洞），re-expand 不應把「今天以前」的空洞補成 open 場次
// （否則會被 processDeadlines 逐一判過期取消並逐場通知教練）。
const E = createTemplate({ ...base, name: 'PR空洞E(週三)' });
db.prepare('DELETE FROM course_sessions WHERE template_id=?').run(E.templateId);
expect('前置：E 場次已清空模擬空洞', () => assert.equal(count(E.templateId), 0));
const r6 = rolloverTemplates('2026-10-05');
expect('10/5（期中週一）→ targetEnd=10/31、E 結束日延到 10/31', () => {
  assert.equal(r6.targetEnd, '2026-10-31');
  assert.equal(endOf(E.templateId), '2026-10-31');
});
expect('E 只補今天(10/5)起的場次：10/7,10/14,10/21,10/28 共 4 場，過去空洞不回填', () => {
  const eEntry = r6.extended.find((e) => e.id === E.templateId);
  assert.ok(eEntry);
  assert.equal(eEntry.added, 4);
  assert.equal(count(E.templateId), 4);
  const earliest = db.prepare('SELECT MIN(session_date) d FROM course_sessions WHERE template_id=?').get(E.templateId).d;
  assert.equal(earliest, '2026-10-07');
});

console.log('[period-rollover test] done');
