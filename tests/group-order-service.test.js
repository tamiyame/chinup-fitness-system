import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { createGroupOrder, sessionOccupied, BANK_INFO } from '../src/services/groupOrderService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec(`
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM users WHERE phone LIKE '0997%';
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function dstr(days) { const d=new Date(); d.setDate(d.getDate()+days); const p=(n)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }

console.log('[group-order-service test] start');
reset();

// 建一個 cap=2、price=500 的 template（產生數個 future sessions）
const tpl = createTemplate({
  name: 'TRX班', min_capacity: 1, max_capacity: 2,
  day_of_week: ((new Date()).getDay()+2)%7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(60),
  registration_deadline_hours: 1, price_per_session: 500,
});
const sessions = db.prepare("SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC").all(tpl.templateId);
const s1 = sessions[0].id, s2 = sessions[1].id;

// 建單：選 2 場（都有空）
const o1 = createGroupOrder({ name: '甲', phone: '0997000001', paySessionIds: [s1, s2], waitlistSessionIds: [] });
expect('order created', () => assert(o1.orderId));
expect('total = 2*500', () => assert.equal(o1.total, 1000));
expect('bankInfo present', () => assert(o1.bankInfo && o1.bankInfo === BANK_INFO));
expect('expiresAt present', () => assert(typeof o1.expiresAt === 'string'));
expect('2 pending registrations', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE order_id=? AND status='pending'").get(o1.orderId).c;
  assert.equal(c, 2);
});
expect('s1 occupied = 1', () => assert.equal(sessionOccupied(s1), 1));

// 第二位填滿 s1（cap=2 → 還有 1 位）
const o2 = createGroupOrder({ name: '乙', phone: '0997000002', paySessionIds: [s1], waitlistSessionIds: [] });
expect('s1 occupied = 2 (full)', () => assert.equal(sessionOccupied(s1), 2));

// 第三位選 s1（已滿）走 pay → 整批 409 fullSessionIds
expect('pay full session → 409 with fullSessionIds', () => {
  try { createGroupOrder({ name: '丙', phone: '0997000003', paySessionIds: [s1], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.deepEqual(e.detail.fullSessionIds, [s1]); }
});

// 第三位改 waitlist s1 → waitlisted reg、不佔名額、無金額
const o3 = createGroupOrder({ name: '丙', phone: '0997000003', paySessionIds: [], waitlistSessionIds: [s1] });
expect('waitlist order has no payment', () => assert.equal(o3.total, 0));
expect('waitlisted reg created', () => {
  const r = db.prepare("SELECT * FROM registrations WHERE session_id=? AND status='waitlisted'").get(s1);
  assert(r && r.order_id === null && r.amount_due === null);
});
expect('waitlist does NOT change occupied', () => assert.equal(sessionOccupied(s1), 2));

// 重複報名同場 → 409 already_registered
expect('duplicate → 409', () => {
  try { createGroupOrder({ name: '甲', phone: '0997000001', paySessionIds: [s2], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); }
});

console.log('[group-order-service part1] done');
