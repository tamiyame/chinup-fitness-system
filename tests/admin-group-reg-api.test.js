// admin 補報名/取消 API：權限守門＋端到端（補報→roster→取消→部分退款）。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

console.log('[admin-group-reg-api test] start');
// 冪等清理：先清子表（group_orders.member_id 無 cascade 會擋 users 刪除），頭尾雙清比照 refund-api
function cleanup() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0995%');
    DELETE FROM group_orders WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0995%');
    DELETE FROM users WHERE phone LIKE '0995%';
  `);
}
cleanup();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const tplRes = await req('POST', '/api/admin/templates', { token, body: {
  name: 'AGRAPI班', min_capacity: 1, max_capacity: 3,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(20),
  registration_deadline_hours: 1, price_per_session: 600,
} });
expect('範本建立 201', () => assert.equal(tplRes.status, 201));
const tplId = tplRes.data.templateId;
const tpl = await req('GET', `/api/admin/templates/${tplId}`, { token });
const sid = tpl.data.sessions[0].id;

const noAuth = await req('POST', `/api/admin/sessions/${sid}/registrations`, { body: { name: 'x', paid: false } });
expect('無 token 補報 → 401', () => assert.equal(noAuth.status, 401));

const bf = await req('POST', `/api/admin/sessions/${sid}/registrations`, { token, body: { name: 'AGRAPI客', phone: '0995000001', paid: true } });
expect('補報（已收款）→ 201 confirmed', () => { assert.equal(bf.status, 201); assert.equal(bf.data.status, 'confirmed'); assert.ok(bf.data.orderId); });

const roster = await req('GET', `/api/admin/sessions/${sid}/registrations`, { token });
const row = roster.data.find((r) => r.phone === '0995000001');
expect('roster 出現該客人且帶 order_paid_at', () => { assert.ok(row); assert.equal(row.status, 'confirmed'); assert.ok(row.order_paid_at); });

const dup = await req('POST', `/api/admin/sessions/${sid}/registrations`, { token, body: { name: 'AGRAPI客', phone: '0995000001', paid: false } });
expect('重複補報 → 409', () => assert.equal(dup.status, 409));

const noAuthCancel = await req('POST', `/api/admin/registrations/${row.id}/cancel`);
expect('無 token 取消 → 401', () => assert.equal(noAuthCancel.status, 401));

const cxl = await req('POST', `/api/admin/registrations/${row.id}/cancel`, { token, body: { refundAmount: 200 } });
expect('取消＋部分退款 200', () => assert.equal(cxl.status, 200));
expect('退款明細寫入 200 元', () => {
  const r = db.prepare('SELECT amount FROM group_order_refunds WHERE registration_id=?').get(row.id);
  assert.equal(r.amount, 200);
});
const roster2 = await req('GET', `/api/admin/sessions/${sid}/registrations`, { token });
expect('roster 顯示已取消', () => assert.equal(roster2.data.find((r) => r.id === row.id).status, 'cancelled'));

// 收尾：刪測試範本（cascade 清 sessions/regs；refunds.registration_id → NULL）
const del = await req('DELETE', `/api/admin/templates/${tplId}`, { token });
expect('範本刪除 ok（refund 列 ON DELETE SET NULL 不擋 cascade）', () => assert.equal(del.status, 200));

cleanup();
console.log('[admin-group-reg-api test] done');
