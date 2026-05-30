// API integration test: D7 discount public endpoints.
// Requires a running server.  Spare port is passed via BASE env var.
// Seeds discount codes directly via SQL (D8 admin endpoints not yet implemented).
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

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

function dstr(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Cleanup helper ──
function cleanup() {
  db.exec(`
    DELETE FROM discount_redemptions WHERE phone LIKE '0995%';
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0995%');
    DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0995%');
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0995%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0995%';
    DELETE FROM users WHERE phone LIKE '0995%';
    DELETE FROM discount_codes WHERE code LIKE 'TESTAPI%';
  `);
}

console.log('[discount-api] start');
cleanup(); // clean any previous partial run

// ── Seed discount codes directly via SQL ──
db.prepare(`INSERT OR IGNORE INTO discount_codes (code, discount_type, discount_value, active)
  VALUES ('TESTAPI10', 'percent', 10, 1)`).run();
db.prepare(`INSERT OR IGNORE INTO discount_codes (code, discount_type, discount_value, active, valid_until)
  VALUES ('TESTAPI_EXP', 'fixed', 100, 1, '2000-01-01')`).run();

// ── Admin login ──
const loginRes = await req('POST', '/api/auth/login', {
  body: { email: 'admin@chinup.local', password: 'admin1234' },
});
expect('admin login 200', () => assert.equal(loginRes.status, 200));
const adminToken = loginRes.data?.token;
expect('admin token received', () => assert.ok(adminToken));

// ── [1] GET /api/public/one-on-one-price ──
console.log('[1] GET /api/public/one-on-one-price');
const priceRes = await req('GET', '/api/public/one-on-one-price');
expect('200', () => assert.equal(priceRes.status, 200));
expect('price=1500', () => assert.equal(priceRes.data?.price, 1500));

// ── [2] POST /api/public/discounts/validate — kind=one_on_one ──
console.log('[2] validate one_on_one discount');
const v1v1 = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI10', phone: '0995001001', kind: 'one_on_one' },
});
expect('200', () => assert.equal(v1v1.status, 200));
expect('valid=true', () => assert.equal(v1v1.data?.valid, true));
expect('discount_type=percent', () => assert.equal(v1v1.data?.discount_type, 'percent'));
expect('discount_value=10', () => assert.equal(v1v1.data?.discount_value, 10));
expect('original=1500', () => assert.equal(v1v1.data?.original, 1500));
expect('discount_amount=150 (floor 10% of 1500)', () => assert.equal(v1v1.data?.discount_amount, 150));
expect('final_total=1350', () => assert.equal(v1v1.data?.final_total, 1350));

// ── [3] POST /api/public/discounts/validate — kind=group with sessionIds ──
console.log('[3] create template + validate group discount');

// Create a price=500 template via admin so we have real session IDs
const startDate = new Date(); startDate.setDate(startDate.getDate() + 3);
const dayOfWeek = startDate.getDay();
const tplRes = await req('POST', '/api/admin/templates', {
  token: adminToken,
  body: {
    name: 'TESTAPI班',
    description: 'test discount api',
    min_capacity: 1, max_capacity: 10,
    day_of_week: dayOfWeek,
    start_time: '14:00',
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

// Fetch sessions for template
const coursesRes = await req('GET', '/api/public/group-courses');
expect('public courses 200', () => assert.equal(coursesRes.status, 200));
const ourTpl = coursesRes.data?.find((t) => t.id === templateId);
expect('our template in public list', () => assert.ok(ourTpl, 'template not found in public courses'));
const sid1 = ourTpl?.sessions?.[0]?.id;
const sid2 = ourTpl?.sessions?.[1]?.id;
expect('at least 2 open sessions for group validate test', () => assert.ok(sid1 && sid2, `sid1=${sid1} sid2=${sid2}`));

// Validate group: 2 sessions × 500 = 1000; 10% off → discount=100, final=900
const vGroup = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI10', phone: '0995001002', kind: 'group', sessionIds: [sid1, sid2] },
});
expect('200', () => assert.equal(vGroup.status, 200));
expect('valid=true', () => assert.equal(vGroup.data?.valid, true));
expect('original=1000 (2×500)', () => assert.equal(vGroup.data?.original, 1000));
expect('discount_amount=100', () => assert.equal(vGroup.data?.discount_amount, 100));
expect('final_total=900', () => assert.equal(vGroup.data?.final_total, 900));

// ── [4] Validate error paths ──
console.log('[4] validate error paths');

// Invalid code → 404
const vInvalid = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI_NOPE', phone: '0995001003', kind: 'one_on_one' },
});
expect('invalid code → 404', () => assert.equal(vInvalid.status, 404));
expect('error=invalid_code', () => assert.equal(vInvalid.data?.error, 'invalid_code'));

// Expired code → 409
const vExpired = await req('POST', '/api/public/discounts/validate', {
  body: { code: 'TESTAPI_EXP', phone: '0995001003', kind: 'one_on_one' },
});
expect('expired code → 409', () => assert.equal(vExpired.status, 409));
expect('error=code_expired', () => assert.equal(vExpired.data?.error, 'code_expired'));

// ── [5] POST /api/public/group-orders with discountCode → 201, total=折後 ──
console.log('[5] POST /api/public/group-orders with discountCode');
let createdOrderId;
const goRes = await req('POST', '/api/public/group-orders', {
  body: {
    name: 'API折客',
    phone: '0995001010',
    paySessionIds: [sid1, sid2],
    waitlistSessionIds: [],
    discountCode: 'TESTAPI10',
  },
});
expect('group-order with discount → 201', () => assert.equal(goRes.status, 201));
expect('orderId returned', () => assert.ok(goRes.data?.orderId));
expect('total = 900 (折後)', () => assert.equal(goRes.data?.total, 900));
expect('originalAmount = 1000', () => assert.equal(goRes.data?.originalAmount, 1000));
expect('discountAmount = 100', () => assert.equal(goRes.data?.discountAmount, 100));
expect('discountCode = TESTAPI10', () => assert.equal(goRes.data?.discountCode, 'TESTAPI10'));
if (goRes.data?.orderId) createdOrderId = goRes.data.orderId;

// ── [6] POST /api/public/group-orders with invalid discountCode → error ──
console.log('[6] POST /api/public/group-orders invalid discountCode');
const goInvalid = await req('POST', '/api/public/group-orders', {
  body: {
    name: 'API無碼',
    phone: '0995001011',
    paySessionIds: [sid1],
    waitlistSessionIds: [],
    discountCode: 'TESTAPI_NOPE',
  },
});
expect('group-order with invalid discount → 4xx', () =>
  assert.ok(goInvalid.status >= 400 && goInvalid.status < 500, `got ${goInvalid.status}`));

// ── [7] POST /api/public/bookings with discountCode → 201 折後 ──
console.log('[7] POST /api/public/bookings with discountCode');
// Need an active coach.
const coachesRes = await req('GET', '/api/coaches');
expect('coaches list 200', () => assert.equal(coachesRes.status, 200));
const activeCoach = Array.isArray(coachesRes.data) && coachesRes.data[0];
if (activeCoach) {
  const futureStart = (() => {
    const d = new Date(); d.setDate(d.getDate() + 7);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T11:00:00`;
  })();
  const bkRes = await req('POST', '/api/public/bookings', {
    body: {
      coachId: activeCoach.id,
      startAt: futureStart,
      name: 'API折預',
      phone: '0995001020',
      discountCode: 'TESTAPI10',
    },
  });
  // 201 = booking placed with discount; 409 = slot taken (tolerated in CI)
  expect('booking with discount → 201 or 409(slot)', () =>
    assert.ok([201, 409].includes(bkRes.status), `got ${bkRes.status}: ${JSON.stringify(bkRes.data)}`));
  if (bkRes.status === 201) {
    expect('booking id returned', () => assert.ok(bkRes.data?.id));
    expect('booking originalAmount = 1500', () => assert.equal(bkRes.data?.originalAmount, 1500));
    expect('booking discountAmount = 150', () => assert.equal(bkRes.data?.discountAmount, 150));
    expect('booking finalAmount = 1350', () => assert.equal(bkRes.data?.finalAmount, 1350));
  }
} else {
  console.log('  (skip booking test — no active coach available)');
}

// ── Cleanup ──
console.log('[cleanup]');
// Cancel the group order so redemptions are released before deleting code
if (createdOrderId) {
  await req('DELETE', `/api/public/group-orders/${createdOrderId}`, {
    body: { phone: '0995001010', name: 'API折客' },
  });
}
// Delete test template (admin)
if (templateId) {
  await req('DELETE', `/api/admin/templates/${templateId}`, { token: adminToken });
}
// Final DB cleanup
cleanup();

console.log('[discount-api] done');
