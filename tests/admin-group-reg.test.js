import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import {
  createGroupOrder, confirmGroupOrder, refundGroupOrder, promoteWaitlist, sessionOccupied,
} from '../src/services/groupOrderService.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function reset() {
  db.exec(`
    DELETE FROM group_order_refunds;
    DELETE FROM discount_redemptions;
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM discount_codes WHERE code LIKE 'AGR%';
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0996%');
    DELETE FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%';
  `);
}
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dt(days, time) { return `${dstr(days)}T${time}`; }
function agePast(sessionId, daysAgo = 3) {
  db.prepare("UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=? WHERE id=?")
    .run(dstr(-daysAgo), dt(-daysAgo, '19:00:00'), dt(-daysAgo, '20:00:00'), dt(-daysAgo, '18:00:00'), sessionId);
}

console.log('[admin-group-reg test] start');

// ── §1 migration ──────────────────────────────────────────────
expect('group_order_refunds 表存在且欄位齊全', () => {
  const cols = db.prepare('PRAGMA table_info(group_order_refunds)').all().map((c) => c.name);
  for (const c of ['id', 'order_id', 'registration_id', 'amount', 'refunded_at', 'refunded_by', 'created_at']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});

// ── §2 promoteWaitlist 過去場次守門 ───────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-守門班', min_capacity: 1, max_capacity: 1,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(15),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const sid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').get(tpl.templateId).id;
  const oA = createGroupOrder({ name: 'AGR-甲', phone: '0996200001', paySessionIds: [sid], waitlistSessionIds: [] });
  const actorId = oA.memberId;
  confirmGroupOrder({ orderId: oA.orderId, actorId });
  createGroupOrder({ name: 'AGR-乙', phone: '0996200002', paySessionIds: [], waitlistSessionIds: [sid] });
  agePast(sid);

  promoteWaitlist(sid);
  expect('過去場次：直接呼叫不遞補', () => {
    const b = db.prepare("SELECT r.status FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone='0996200002' AND r.session_id=?").get(sid);
    assert.equal(b.status, 'waitlisted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders o JOIN users u ON u.id=o.member_id WHERE u.phone='0996200002'").get().c, 0);
  });

  refundGroupOrder({ orderId: oA.orderId, actorId });
  expect('過去場次：整單退款也不遞補', () => {
    const b = db.prepare("SELECT r.status FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone='0996200002' AND r.session_id=?").get(sid);
    assert.equal(b.status, 'waitlisted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders o JOIN users u ON u.id=o.member_id WHERE u.phone='0996200002'").get().c, 0);
  });
}

console.log('[admin-group-reg test] done');
