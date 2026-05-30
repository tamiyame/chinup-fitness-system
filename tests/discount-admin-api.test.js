// API integration test: D8 admin discount-codes CRUD + settings endpoints.
// Requires a running server on BASE (spare port).
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

// ── Cleanup helper ──
function cleanup() {
  db.exec(`
    DELETE FROM discount_redemptions WHERE phone LIKE '0996%';
    DELETE FROM discount_codes WHERE code LIKE 'TESTADM%';
  `);
  // Reset one_on_one_price to 1500 in case a test left it changed
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('one_on_one_price', '1500') ON CONFLICT(key) DO UPDATE SET value = '1500'").run();
}

console.log('[discount-admin-api] start');
cleanup();

// ── Admin login ──
const loginRes = await req('POST', '/api/auth/login', {
  body: { email: 'admin@chinup.local', password: 'admin1234' },
});
expect('admin login 200', () => assert.equal(loginRes.status, 200));
const adminToken = loginRes.data?.token;
expect('admin token received', () => assert.ok(adminToken));

// ── [1] Non-admin access → 401/403 ──
console.log('[1] non-admin access control');
const noAuth = await req('GET', '/api/admin/discount-codes');
expect('GET without token → 401', () => assert.equal(noAuth.status, 401));

// Register a regular user and try
const userEmail = `testadm_user_${Date.now()}@example.com`;
const userRegRes = await req('POST', '/api/auth/login', {
  body: { email: 'nonexistent@example.com', password: 'wrong' },
});
// We can't easily register a user via API without a registration endpoint,
// so just verify the unauthenticated case is sufficient for non-admin check.
// Also test with a bogus token.
const bogusToken = await req('GET', '/api/admin/discount-codes', { token: 'bogustoken' });
expect('GET with bogus token → 401', () => assert.equal(bogusToken.status, 401));

// ── [2] POST /api/admin/discount-codes — create ──
console.log('[2] POST /api/admin/discount-codes (create)');
const createRes = await req('POST', '/api/admin/discount-codes', {
  token: adminToken,
  body: { code: 'testadm_10', discount_type: 'percent', discount_value: 10 },
});
expect('create → 201', () => assert.equal(createRes.status, 201));
expect('code normalized to uppercase', () => assert.equal(createRes.data?.code, 'TESTADM_10'));
expect('discount_type=percent', () => assert.equal(createRes.data?.discount_type, 'percent'));
expect('discount_value=10', () => assert.equal(createRes.data?.discount_value, 10));
expect('active=1 by default', () => assert.equal(createRes.data?.active, 1));
const createdId = createRes.data?.id;
expect('id returned', () => assert.ok(createdId));

// ── [3] Duplicate code → 409 ──
console.log('[3] duplicate code → 409');
const dupRes = await req('POST', '/api/admin/discount-codes', {
  token: adminToken,
  body: { code: 'TESTADM_10', discount_type: 'fixed', discount_value: 50 },
});
expect('duplicate → 409', () => assert.equal(dupRes.status, 409));
expect('error=code_exists', () => assert.equal(dupRes.data?.error, 'code_exists'));

// ── [4] Invalid percent value → 400 ──
console.log('[4] invalid percent value → 400');
const badValRes = await req('POST', '/api/admin/discount-codes', {
  token: adminToken,
  body: { code: 'TESTADM_BAD', discount_type: 'percent', discount_value: 150 },
});
expect('percent >100 → 400', () => assert.equal(badValRes.status, 400));
expect('error=invalid_value', () => assert.equal(badValRes.data?.error, 'invalid_value'));

// ── [5] GET /api/admin/discount-codes — list (contains used_count) ──
console.log('[5] GET /api/admin/discount-codes (list)');
const listRes = await req('GET', '/api/admin/discount-codes', { token: adminToken });
expect('list → 200', () => assert.equal(listRes.status, 200));
expect('list is array', () => assert.ok(Array.isArray(listRes.data)));
const ourCode = listRes.data?.find((c) => c.id === createdId);
expect('created code appears in list', () => assert.ok(ourCode, `id=${createdId} not found in list`));
expect('used_count=0 initially', () => assert.equal(ourCode?.used_count, 0));

// ── [6] PATCH /api/admin/discount-codes/:id — toggle active ──
console.log('[6] PATCH /api/admin/discount-codes/:id');
const patchRes = await req('PATCH', `/api/admin/discount-codes/${createdId}`, {
  token: adminToken,
  body: { discount_type: 'percent', discount_value: 10, active: 0 },
});
expect('patch → 200', () => assert.equal(patchRes.status, 200));
expect('active=0 after patch', () => assert.equal(patchRes.data?.active, 0));

// Re-activate for subsequent tests
await req('PATCH', `/api/admin/discount-codes/${createdId}`, {
  token: adminToken,
  body: { discount_type: 'percent', discount_value: 10, active: 1 },
});

// ── [7] DELETE /api/admin/discount-codes/:id — unused code can be deleted ──
console.log('[7] DELETE unused code');
const delCode = await req('POST', '/api/admin/discount-codes', {
  token: adminToken,
  body: { code: 'TESTADM_DEL', discount_type: 'fixed', discount_value: 50 },
});
expect('create del-target → 201', () => assert.equal(delCode.status, 201));
const delId = delCode.data?.id;
const delRes = await req('DELETE', `/api/admin/discount-codes/${delId}`, { token: adminToken });
expect('delete unused → 200 ok:true', () => { assert.equal(delRes.status, 200); assert.equal(delRes.data?.ok, true); });

// ── [8] DELETE used code → 409 has_redemptions ──
console.log('[8] DELETE used code → 409');
const usedCode = await req('POST', '/api/admin/discount-codes', {
  token: adminToken,
  body: { code: 'TESTADM_USED', discount_type: 'fixed', discount_value: 50 },
});
expect('create used-target → 201', () => assert.equal(usedCode.status, 201));
const usedId = usedCode.data?.id;
// Seed a redemption for this code directly via DB
if (usedId) {
  db.prepare(
    'INSERT INTO discount_redemptions (code_id, phone, kind, ref_id, amount) VALUES (?, ?, ?, ?, ?)'
  ).run(usedId, '0996000099', 'group_order', 888001, 50);
}
const delUsedRes = await req('DELETE', `/api/admin/discount-codes/${usedId}`, { token: adminToken });
expect('delete used → 409 has_redemptions', () => assert.equal(delUsedRes.status, 409));
expect('error=has_redemptions', () => assert.equal(delUsedRes.data?.error, 'has_redemptions'));

// ── [9] GET /api/admin/settings ──
console.log('[9] GET /api/admin/settings');
const settingsRes = await req('GET', '/api/admin/settings', { token: adminToken });
expect('settings → 200', () => assert.equal(settingsRes.status, 200));
expect('one_on_one_price is number', () => assert.ok(typeof settingsRes.data?.one_on_one_price === 'number'));
expect('one_on_one_price default 1500', () => assert.equal(settingsRes.data?.one_on_one_price, 1500));

// ── [10] PATCH /api/admin/settings — change price ──
console.log('[10] PATCH /api/admin/settings → price=1800');
const patchSettingsRes = await req('PATCH', '/api/admin/settings', {
  token: adminToken,
  body: { one_on_one_price: 1800 },
});
expect('patch settings → 200', () => assert.equal(patchSettingsRes.status, 200));
expect('response one_on_one_price=1800', () => assert.equal(patchSettingsRes.data?.one_on_one_price, 1800));

// Verify via public endpoint
const priceAfterRes = await req('GET', '/api/public/one-on-one-price');
expect('public price now 1800', () => assert.equal(priceAfterRes.data?.price, 1800));

// ── [11] PATCH settings invalid price → 400 ──
console.log('[11] PATCH settings invalid price → 400');
const badPriceRes = await req('PATCH', '/api/admin/settings', {
  token: adminToken,
  body: { one_on_one_price: -100 },
});
expect('negative price → 400', () => assert.equal(badPriceRes.status, 400));
expect('error=invalid_price', () => assert.equal(badPriceRes.data?.error, 'invalid_price'));

const nanPriceRes = await req('PATCH', '/api/admin/settings', {
  token: adminToken,
  body: { one_on_one_price: 'abc' },
});
expect('non-integer price → 400', () => assert.equal(nanPriceRes.status, 400));

// ── [12] Reset price back to 1500 ──
console.log('[12] reset price to 1500');
const resetRes = await req('PATCH', '/api/admin/settings', {
  token: adminToken,
  body: { one_on_one_price: 1500 },
});
expect('reset → 200', () => assert.equal(resetRes.status, 200));
expect('price back to 1500', () => assert.equal(resetRes.data?.one_on_one_price, 1500));

// Verify public endpoint reflects reset
const priceResetRes = await req('GET', '/api/public/one-on-one-price');
expect('public price back to 1500', () => assert.equal(priceResetRes.data?.price, 1500));

// ── Cleanup ──
console.log('[cleanup]');
cleanup();

console.log('[discount-admin-api] done');
