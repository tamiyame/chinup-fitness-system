// 續報下期 API：權限守門＋端到端（最後一堂補報→renewal 資訊→續報→已續報→重複 409）。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db, nowLocal } from '../src/db/connection.js';
import { periodOf, nextPeriod, periodLabel } from '../src/services/period.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.9.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }

console.log('[group-renew-api test] start');
function cleanup() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0984%');
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0984%');
    DELETE FROM group_orders WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0984%');
    DELETE FROM users WHERE phone LIKE '0984%';
  `);
}
cleanup();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

// 本期＝下一期、下期＝下下期 → 全部在未來
const P1 = nextPeriod(periodOf(nowLocal().slice(0, 10)));
const P2 = nextPeriod(P1);
const tplRes = await req('POST', '/api/admin/templates', { token, body: {
  name: 'RNWAPI班', min_capacity: 1, max_capacity: 6,
  day_of_week: 2, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: P1.start, cycle_end_date: P2.end,
  registration_deadline_hours: 2, price_per_session: 450,
} });
expect('範本建立 201', () => assert.equal(tplRes.status, 201));
const tplId = tplRes.data.templateId;
const tpl = await req('GET', `/api/admin/templates/${tplId}`, { token });
const p1 = tpl.data.sessions.filter((s) => s.session_date <= P1.end);
const p2Count = tpl.data.sessions.length - p1.length;
const lastSid = p1[p1.length - 1].id;

const noAuthGet = await req('GET', `/api/admin/sessions/${lastSid}/renewal`);
expect('無 token GET renewal → 401', () => assert.equal(noAuthGet.status, 401));
const noAuthPost = await req('POST', `/api/admin/sessions/${lastSid}/renewal`, { body: { userId: 1 } });
expect('無 token POST renewal → 401', () => assert.equal(noAuthPost.status, 401));

const notLast = await req('GET', `/api/admin/sessions/${p1[0].id}/renewal`, { token });
expect('非最後一堂 → eligible false', () => assert.deepEqual(notLast.data, { eligible: false }));

const bf = await req('POST', `/api/admin/sessions/${lastSid}/registrations`, { token, body: { name: 'RNWAPI客', phone: '0984100001', paid: true } });
expect('最後一堂補報（已收款）→ 201', () => assert.equal(bf.status, 201));
const roster = await req('GET', `/api/admin/sessions/${lastSid}/registrations`, { token });
const userId = roster.data.find((r) => r.phone === '0984100001').user_id;

const info = await req('GET', `/api/admin/sessions/${lastSid}/renewal`, { token });
expect('最後一堂 → eligible、下期標籤／場數／單價、尚無人續報', () => {
  assert.equal(info.status, 200);
  assert.equal(info.data.eligible, true);
  assert.equal(info.data.periodLabel, periodLabel(P2));
  assert.equal(info.data.sessionCount, p2Count);
  assert.equal(info.data.pricePerSession, 450);
  assert.deepEqual(info.data.renewedUserIds, []);
});

const rn = await req('POST', `/api/admin/sessions/${lastSid}/renewal`, { token, body: { userId } });
expect('續報 → 201、待付款單金額＝場數×單價', () => {
  assert.equal(rn.status, 201);
  assert.ok(rn.data.orderId);
  assert.equal(rn.data.payCount, p2Count);
  assert.equal(rn.data.total, p2Count * 450);
});
const pending = await req('GET', '/api/admin/group-orders', { token });
expect('待核對匯款清單出現這張單', () => {
  assert.equal(pending.status, 200);
  assert.ok(pending.data.some((o) => o.id === rn.data.orderId));
});
const info2 = await req('GET', `/api/admin/sessions/${lastSid}/renewal`, { token });
expect('續報後 renewedUserIds 含該客人', () => assert.deepEqual(info2.data.renewedUserIds, [userId]));
const again = await req('POST', `/api/admin/sessions/${lastSid}/renewal`, { token, body: { userId } });
expect('重複續報 → 409 already_renewed', () => { assert.equal(again.status, 409); assert.equal(again.data.error, 'already_renewed'); });
const missing = await req('POST', `/api/admin/sessions/${lastSid}/renewal`, { token, body: {} });
expect('沒帶 userId → 404 user_not_found', () => { assert.equal(missing.status, 404); assert.equal(missing.data.error, 'user_not_found'); });

cleanup();
const del = await req('DELETE', `/api/admin/templates/${tplId}`, { token });
expect('範本刪除 ok', () => assert.equal(del.status, 200));
console.log('[group-renew-api test] done');
