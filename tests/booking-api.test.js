// HTTP API 整合測試 — 一對一預約
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

console.log('[booking-api test] start');

const ownerAuth = await loginAs('admin@chinup.local', 'admin1234');
const member1 = await loginAs('user1@chinup.local', 'pass1234');
const member2 = await loginAs('user2@chinup.local', 'pass1234');

// --- 1. Self-signup as coach ---
console.log('[1] self-signup as coach');
const signupEmail = `test-coach-${Date.now()}@chinup.local`;
const signup = await req('POST', '/api/auth/register', {
  body: { email: signupEmail, password: 'testpass1234', name: 'Test 教練', as_coach: true },
});
expect('201 created', () => assert.equal(signup.status, 201));
expect('user.role = coach', () => assert.equal(signup.data.user.role, 'coach'));
expect('pending_coach = true', () => assert.equal(signup.data.pending_coach, true));
const coachToken = signup.data.token;

// --- 2. Coach is invisible to members until activated ---
console.log('[2] pending coach hidden from public');
const publicList1 = await req('GET', '/api/coaches');
expect('200 ok', () => assert.equal(publicList1.status, 200));
const pendingCoachInList = (publicList1.data || []).find(c => c.display_name === 'Test 教練');
expect('pending coach not in public list', () => assert.equal(pendingCoachInList, undefined));

// --- 3. Coach without active record can hit /api/coach/me ---
const meRes = await req('GET', '/api/coach/me', { token: coachToken });
expect('coach can fetch self', () => assert.equal(meRes.status, 200));
expect('is_active=0 before activation', () => assert.equal(meRes.data.is_active, 0));
const coachId = meRes.data.id;

// --- 4. Admin activates ---
console.log('[4] admin activates');
const activate = await req('PATCH', `/api/admin/coaches/${coachId}`, {
  token: ownerAuth.token,
  body: { is_active: true, specialty: '測試專長' },
});
expect('200 ok', () => assert.equal(activate.status, 200));
expect('is_active=1 after PATCH', () => assert.equal(activate.data.is_active, 1));

// --- 5. Coach now appears publicly ---
const publicList2 = await req('GET', '/api/coaches');
expect('active coach in public list', () => assert(publicList2.data.find(c => c.id === coachId)));

// --- 6. Coach sets availability ---
console.log('[6] coach sets rules');
const today = new Date();
const dow = (today.getDay() + 2) % 7;  // pick a day not today to avoid past-slot edge case
const ruleResp = await req('POST', '/api/coach/me/rules', {
  token: coachToken,
  body: { day_of_week: dow, start_time: '09:00', end_time: '12:00', effective_from: '2000-01-01' },
});
expect('rule 201', () => assert.equal(ruleResp.status, 201));

// --- 7. Member fetches availability ---
console.log('[7] member fetches availability');
const pad = (n) => String(n).padStart(2, '0');
const target = new Date(today);
while (target.getDay() !== dow) target.setDate(target.getDate() + 1);
const dateStr = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
const slotsRes = await req('GET', `/api/coaches/${coachId}/availability?from=${dateStr}&to=${dateStr}`, { token: member1.token });
expect('200 ok', () => assert.equal(slotsRes.status, 200));
expect('has 3 slots', () => assert.equal(slotsRes.data.length, 3));

// --- 8. Member books a slot ---
const slotToBook = slotsRes.data[0];
const book = await req('POST', '/api/bookings', { token: member1.token, body: { coach_id: coachId, start_at: slotToBook } });
expect('book 201', () => assert.equal(book.status, 201));
const bookingId = book.data.id;

// --- 9. Booked slot disappears from availability ---
const slotsRes2 = await req('GET', `/api/coaches/${coachId}/availability?from=${dateStr}&to=${dateStr}`, { token: member1.token });
expect('one fewer slot after booking', () => assert.equal(slotsRes2.data.length, 2));

// --- 10. Double-book rejected ---
const double = await req('POST', '/api/bookings', { token: member2.token, body: { coach_id: coachId, start_at: slotToBook } });
expect('double-book 409', () => assert.equal(double.status, 409));
expect('error=slot_taken', () => assert.equal(double.data.error, 'slot_taken'));

// --- 11. Member cancels their booking ---
const cancel = await req('DELETE', `/api/bookings/${bookingId}`, { token: member1.token });
expect('cancel 200', () => assert.equal(cancel.status, 200));

// --- 12. Cancelled slot is bookable again ---
const slotsRes3 = await req('GET', `/api/coaches/${coachId}/availability?from=${dateStr}&to=${dateStr}`, { token: member1.token });
expect('slot back after cancel', () => assert.equal(slotsRes3.data.length, 3));

// --- 13. Member cannot cancel another member's booking ---
const book2 = await req('POST', '/api/bookings', { token: member1.token, body: { coach_id: coachId, start_at: slotToBook } });
const forbidden = await req('DELETE', `/api/bookings/${book2.data.id}`, { token: member2.token });
expect('cross-member cancel 403', () => assert.equal(forbidden.status, 403));

// --- 14. Coach emergency cancel requires reason ---
const cancelNoReason = await req('DELETE', `/api/bookings/${book2.data.id}`, { token: coachToken });
expect('coach cancel without reason 400', () => assert.equal(cancelNoReason.status, 400));

const cancelWithReason = await req('DELETE', `/api/bookings/${book2.data.id}`, { token: coachToken, body: { reason: '臨時生病' } });
expect('coach cancel with reason 200', () => assert.equal(cancelWithReason.status, 200));

// --- 15. Coach role required for /api/coach/me ---
const memberCallsCoach = await req('GET', '/api/coach/me', { token: member1.token });
expect('member -> /api/coach/me = 403', () => assert.equal(memberCallsCoach.status, 403));

// --- 16. Non-admin cannot manage coaches ---
const memberAdmin = await req('GET', '/api/admin/coaches', { token: member1.token });
expect('member -> /api/admin/coaches = 403', () => assert.equal(memberAdmin.status, 403));

console.log('[booking-api test] done');
