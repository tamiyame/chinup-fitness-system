import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

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

console.log('[admin-group-reg test] done');
