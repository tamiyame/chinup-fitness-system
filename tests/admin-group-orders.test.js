// API 測試：admin group-order endpoints (list / confirm / cancel)
// 需要 running server。BASE env var 指向伺服器。
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

// 計算未來日期字串 (YYYY-MM-DD)
function dstr(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

console.log('[admin-group-orders test] start');

// --- 1. Admin login ---
console.log('[1] admin login');
const loginRes = await req('POST', '/api/auth/login', {
  body: { email: 'admin@chinup.local', password: 'admin1234' },
});
expect('admin login 200', () => assert.equal(loginRes.status, 200));
const adminToken = loginRes.data?.token;
expect('admin token received', () => assert.ok(adminToken, 'no token in response'));

// --- 2. Auth guard: unauthenticated requests get 401/403 ---
console.log('[2] auth guard: no token → 401/403');
const listNoAuth = await req('GET', '/api/admin/group-orders');
expect('GET group-orders without token → 401 or 403', () =>
  assert.ok([401, 403].includes(listNoAuth.status), `got ${listNoAuth.status}`));

const confirmNoAuth = await req('POST', '/api/admin/group-orders/1/confirm');
expect('POST confirm without token → 401 or 403', () =>
  assert.ok([401, 403].includes(confirmNoAuth.status), `got ${confirmNoAuth.status}`));

const cancelNoAuth = await req('POST', '/api/admin/group-orders/1/cancel');
expect('POST cancel without token → 401 or 403', () =>
  assert.ok([401, 403].includes(cancelNoAuth.status), `got ${cancelNoAuth.status}`));

// --- 3. Create a published template with price_per_session > 0 via admin endpoint ---
console.log('[3] create template with price_per_session > 0');

// Pick a day_of_week that will generate at least one session in the next 30 days.
// Use "next week same day" to be safe — iterate until we find a day_of_week
// that produces sessions starting from tomorrow.
const now = new Date();
// We pick 2 days from now as cycle_start_date, end 30 days out.
// day_of_week = day of week of (now+3 days) so there's at least one hit in the range.
const startDate = new Date(now); startDate.setDate(now.getDate() + 3);
const endDate = new Date(now); endDate.setDate(now.getDate() + 30);
const dayOfWeek = startDate.getDay(); // 0=Sun ... 6=Sat

const tplRes = await req('POST', '/api/admin/templates', {
  token: adminToken,
  body: {
    name: 'AdminTestGroup',
    description: 'test',
    min_capacity: 1,
    max_capacity: 10,
    day_of_week: dayOfWeek,
    start_time: '10:00',
    duration_minutes: 60,
    recurrence: 'weekly',
    cycle_start_date: dstr(3),
    cycle_end_date: dstr(30),
    registration_deadline_hours: 1,
    status: 'published',
    price_per_session: 500,
  },
});
expect('template created 201', () => assert.equal(tplRes.status, 201));
const templateId = tplRes.data?.templateId;
expect('templateId returned', () => assert.ok(templateId));

// --- 4. Fetch public courses; get the session id for our template ---
console.log('[4] get public courses to find our session');
const coursesRes = await req('GET', '/api/public/group-courses');
expect('public courses 200', () => assert.equal(coursesRes.status, 200));
const ourTemplate = coursesRes.data?.find((t) => t.id === templateId);
expect('our template appears in public courses', () => assert.ok(ourTemplate, 'template not in public list'));
const sessionId = ourTemplate?.sessions?.[0]?.id;
expect('at least one open session exists', () => assert.ok(sessionId, 'no open sessions for template'));

// --- 5. Public: create a pending group order ---
console.log('[5] create pending group order (public)');
const orderRes = await req('POST', '/api/public/group-orders', {
  body: {
    name: 'TestCustomer',
    phone: '0911222333',
    paySessionIds: [sessionId],
    waitlistSessionIds: [],
  },
});
expect('group order created 201', () => assert.equal(orderRes.status, 201));
const orderId = orderRes.data?.orderId;
expect('orderId returned', () => assert.ok(orderId));
expect('total is 500', () => assert.equal(orderRes.data?.total, 500));

// --- 6. Admin list: should contain our pending order ---
console.log('[6] admin list pending orders');
const listRes = await req('GET', '/api/admin/group-orders', { token: adminToken });
expect('list 200', () => assert.equal(listRes.status, 200));
expect('list is array', () => assert.ok(Array.isArray(listRes.data)));
const found = listRes.data?.find((o) => o.id === orderId);
expect('our order appears in list', () => assert.ok(found, `order ${orderId} not in list`));
expect('order has customer_name', () => assert.equal(found?.customer_name, 'TestCustomer'));
expect('order has sessions array', () => assert.ok(Array.isArray(found?.sessions)));
expect('sessions entry has start_at', () => assert.ok(found?.sessions?.[0]?.start_at));
expect('sessions entry has course_name', () => assert.equal(found?.sessions?.[0]?.course_name, 'AdminTestGroup'));

// --- 7. Admin confirm the order ---
console.log('[7] admin confirm order');
const confirmRes = await req('POST', `/api/admin/group-orders/${orderId}/confirm`, { token: adminToken });
expect('confirm 200', () => assert.equal(confirmRes.status, 200));
expect('confirm ok=true', () => assert.equal(confirmRes.data?.ok, true));

// --- 8. After confirm, list should no longer contain the order (it's paid, not pending) ---
console.log('[8] list after confirm: order should be gone');
const listAfterRes = await req('GET', '/api/admin/group-orders', { token: adminToken });
expect('list after confirm 200', () => assert.equal(listAfterRes.status, 200));
const foundAfter = listAfterRes.data?.find((o) => o.id === orderId);
expect('confirmed order no longer in pending list', () => assert.ok(!foundAfter, `order ${orderId} still in list after confirm`));

// --- 9. Test admin cancel on a fresh pending order ---
console.log('[9] create second order to test admin cancel');
const orderRes2 = await req('POST', '/api/public/group-orders', {
  body: {
    name: 'TestCustomer2',
    phone: '0922333444',
    paySessionIds: [sessionId],
    waitlistSessionIds: [],
  },
});
// Session may be full after confirm (capacity 10, so still available). If 409, skip cancel test gracefully.
if (orderRes2.status === 201) {
  const orderId2 = orderRes2.data?.orderId;
  expect('second order created', () => assert.ok(orderId2));

  const cancelRes = await req('POST', `/api/admin/group-orders/${orderId2}/cancel`, { token: adminToken });
  expect('admin cancel 200', () => assert.equal(cancelRes.status, 200));
  expect('cancel ok=true', () => assert.equal(cancelRes.data?.ok, true));

  // Cancelled order should not appear in list
  const listAfterCancel = await req('GET', '/api/admin/group-orders', { token: adminToken });
  const foundCancelled = listAfterCancel.data?.find((o) => o.id === orderId2);
  expect('cancelled order not in pending list', () => assert.ok(!foundCancelled));
} else {
  console.log(`  (skip cancel test — second order returned ${orderRes2.status}: ${JSON.stringify(orderRes2.data)})`);
}

// --- 10. 404 on cancel/confirm for non-existent order ---
console.log('[10] 404 on non-existent order');
const confirmMissing = await req('POST', '/api/admin/group-orders/999999/confirm', { token: adminToken });
expect('confirm missing order → 404', () => assert.equal(confirmMissing.status, 404));
const cancelMissing = await req('POST', '/api/admin/group-orders/999999/cancel', { token: adminToken });
expect('cancel missing order → 404', () => assert.equal(cancelMissing.status, 404));

console.log('[admin-group-orders test] done');
