// 後台場次「正取/候補」改即時計算：getTemplate 回傳即時人數（覆蓋未被團課流程維護的快取欄位），
// 正取排除請假(on_leave)。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createTemplate, getTemplate } from '../src/services/courseService.js';
import { createGroupOrder, confirmGroupOrder, takeLeavePublic } from '../src/services/groupOrderService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

function reset() {
  // 注意：前次跑完留下的 asc-admin 會被開機遷移轉成 coach+is_admin=1，
  // 之後其他測試的管理者廣播通知會掛在他名下（notifications.user_id 無 ON DELETE）→ 先刪通知再刪 user。
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'asc-%' OR phone LIKE '0977%');
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'asc-%' OR phone LIKE '0977%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0977%';
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'ASC%');
    DELETE FROM course_templates WHERE name LIKE 'ASC%';
    DELETE FROM users WHERE email LIKE 'asc-%' OR phone LIKE '0977%';
  `);
}

console.log('[admin-session-counts test] start');
reset();

const adminId = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('ASC Admin','asc-admin@x.com',?, 'admin')").run(hashPassword('x')).lastInsertRowid;
const sessionOf = (tplId) => db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(tplId);
const countOf = (tplId, sid) => getTemplate(tplId).sessions.find((s) => s.id === sid);
function confirmMember(name, phone, sessionId) {
  const o = createGroupOrder({ name, phone, paySessionIds: [sessionId] });
  confirmGroupOrder({ orderId: o.orderId, actorId: adminId });
  return o.memberId;
}

// ── 大班（max 5）：正取即時計數 + 快取過時驗證 + 請假排除 ──
const T = createTemplate({ name: 'ASC 大班', min_capacity: 1, max_capacity: 5, day_of_week: 1, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40) });
const sT = sessionOf(T.templateId);
const A = confirmMember('甲', '0977000001', sT.id);
confirmMember('乙', '0977000002', sT.id);

expect('即時正取=2、候補=0', () => {
  const s = countOf(T.templateId, sT.id);
  assert.equal(s.confirmed_count, 2);
  assert.equal(s.waitlist_count, 0);
});
expect('快取欄位 confirmed_count 仍為 0（團課流程未維護）→ 證明採即時值', () => {
  const stored = db.prepare('SELECT confirmed_count FROM course_sessions WHERE id=?').get(sT.id).confirmed_count;
  assert.equal(stored, 0);
});

// 甲請假 → 正取即時降為 1
const regA = db.prepare('SELECT id FROM registrations WHERE user_id=? AND session_id=?').get(A, sT.id);
takeLeavePublic({ registrationId: regA.id, phone: '0977000001', name: '甲' });
expect('請假後即時正取=1（on_leave 不計入）', () => {
  assert.equal(countOf(T.templateId, sT.id).confirmed_count, 1);
});

// ── 小班（max 1）：候補即時計數 ──
const T2 = createTemplate({ name: 'ASC 小班', min_capacity: 1, max_capacity: 1, day_of_week: 2, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(40) });
const sT2 = sessionOf(T2.templateId);
confirmMember('丙', '0977000003', sT2.id);
createGroupOrder({ name: '丁', phone: '0977000004', waitlistSessionIds: [sT2.id] });
expect('即時正取=1、候補=1', () => {
  const s = countOf(T2.templateId, sT2.id);
  assert.equal(s.confirmed_count, 1);
  assert.equal(s.waitlist_count, 1);
});

console.log('[admin-session-counts test] done');
