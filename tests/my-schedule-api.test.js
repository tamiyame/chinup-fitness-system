// HTTP API 整合測試 — Phase 3A unified /my-schedule
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function loginAs(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[my-schedule-api test] start');

// 1. 401 when unauthenticated
const noAuth = await req('GET', '/api/my/schedule');
expect('401 without token', () => assert.equal(noAuth.status, 401));
expect('error=unauthenticated', () => assert.equal(noAuth.data.error, 'unauthenticated'));

// 2. Existing seed user — user1@chinup.local should have at least 1 booking from seed-demo
const user1 = await loginAs('user1@chinup.local', 'pass1234');
const resp1 = await req('GET', '/api/my/schedule', { token: user1.token });
expect('200 OK', () => assert.equal(resp1.status, 200));
expect('items is array', () => assert(Array.isArray(resp1.data.items)));
expect('user1 has >= 1 item', () => assert(resp1.data.items.length >= 1));

const item = resp1.data.items[0];
expect('item has kind', () => assert(['booking', 'registration'].includes(item.kind)));
expect('item has start_at', () => assert(typeof item.start_at === 'string' && item.start_at.length >= 19));
expect('item has is_past boolean', () => assert.equal(typeof item.is_past, 'boolean'));
expect('item has can_cancel boolean', () => assert.equal(typeof item.can_cancel, 'boolean'));

// Verify actual is_past value: user1's seeded booking is 14 days in the future
const bookingFromSeed = resp1.data.items.find(x => x.kind === 'booking');
if (bookingFromSeed) {
  expect('seeded future booking is_past=false', () => assert.equal(bookingFromSeed.is_past, false));
  expect('seeded future booking can_cancel=true', () => assert.equal(bookingFromSeed.can_cancel, true));
}

// 3. Sorted DESC by start_at
if (resp1.data.items.length >= 2) {
  const a = resp1.data.items[0].start_at;
  const b = resp1.data.items[1].start_at;
  expect('sorted DESC', () => assert(a >= b));
}

// 4. user2 — has group registrations from seed-demo, no 1-on-1 booking
const user2 = await loginAs('user2@chinup.local', 'pass1234');
const resp2 = await req('GET', '/api/my/schedule', { token: user2.token });
expect('user2 200', () => assert.equal(resp2.status, 200));
const hasReg = resp2.data.items.some(x => x.kind === 'registration');
expect('user2 has at least 1 registration', () => assert(hasReg));

// 5. User isolation — user2's items must not share any (kind, id) with user1's items
const u1Keys = new Set(resp1.data.items.map(x => `${x.kind}:${x.id}`));
const u2Overlap = resp2.data.items.filter(x => u1Keys.has(`${x.kind}:${x.id}`));
expect('user2 items share no (kind, id) with user1', () => assert.equal(u2Overlap.length, 0));

// 6. Booking item shape — registration-only fields null
const bookingItem = resp1.data.items.find(x => x.kind === 'booking');
if (bookingItem) {
  expect('booking session_id=null', () => assert.equal(bookingItem.session_id, null));
  expect('booking course_name=null', () => assert.equal(bookingItem.course_name, null));
  expect('booking coach_display_name truthy', () => assert(bookingItem.coach_display_name));
}

// 7. Registration item shape — booking-only fields null
const regItem = resp2.data.items.find(x => x.kind === 'registration');
if (regItem) {
  expect('reg coach_id=null', () => assert.equal(regItem.coach_id, null));
  expect('reg note=null', () => assert.equal(regItem.note, null));
  expect('reg course_name truthy', () => assert(regItem.course_name));
}

// 8. Waitlisted registration carries position
// seed-demo registers 8 users to TRX (max=6), so users 7 and 8 land on waitlist.
// Try user8 first; fall back to user7.
let waitlistedUser = null;
for (const email of ['user8@chinup.local', 'user7@chinup.local']) {
  const tok = await loginAs(email, 'pass1234');
  const r = await req('GET', '/api/my/schedule', { token: tok.token });
  const wl = r.data.items.find(x => x.kind === 'registration' && x.status === 'waitlisted');
  if (wl) { waitlistedUser = { email, item: wl }; break; }
}
expect('found a waitlisted user from seed', () => assert(waitlistedUser, 'no waitlisted reg in seed — check seed-demo'));
if (waitlistedUser) {
  expect('waitlisted item position is a positive number',
    () => assert(typeof waitlistedUser.item.position === 'number' && waitlistedUser.item.position > 0));
  expect('waitlisted item can_cancel=true (session still open)',
    () => assert.equal(waitlistedUser.item.can_cancel, true));
}

console.log('[my-schedule-api test] done');
