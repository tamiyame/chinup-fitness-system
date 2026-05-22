import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: {'Content-Type':'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: res.status, data };
}

console.log('[public-api test] start');

// lookup unknown phone
{
  const r = await req('POST', '/api/public/users/lookup', { phone: '0999000111' });
  assert.equal(r.status, 200);
  assert.equal(r.data.exists, false);
  console.log('  ✓ lookup unknown phone → exists:false');
}

// lookup known phone (seed user1 phone = '0900000001' per seed.js)
{
  const r = await req('POST', '/api/public/users/lookup', { phone: '0900000001' });
  assert.equal(r.status, 200);
  assert.equal(r.data.exists, true);
  assert.equal(r.data.name, '會員1');
  console.log('  ✓ lookup known phone → exists:true with name');
}

// invalid phone
{
  const r = await req('POST', '/api/public/users/lookup', { phone: '123' });
  assert.equal(r.status, 400);
  console.log('  ✓ invalid phone → 400');
}

// Need an active coach — fetch /api/coaches (public)
const coachesRes = await fetch(BASE + '/api/coaches');
const coaches = await coachesRes.json();
const coach = coaches[0];
assert.ok(coach, 'need at least one active coach in seed');

// startAt: tomorrow 14:00 local
const tomorrow = new Date(Date.now() + 86400000);
const startAt = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T14:00:00`;

// anon booking with new phone
{
  const r = await req('POST', '/api/public/bookings', {
    coachId: coach.id, startAt,
    name: 'Test Anon', phone: '0988111222',
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.bookingId);
  assert.equal(r.data.startAt, startAt);
  assert.ok(r.data.lineBindCode);  // new user, not bound, should get code
  console.log('  ✓ anon booking creates user + booking + bind code');
}

// repeat with same phone, different name → reuse + update name
{
  const startAt2 = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T15:00:00`;
  const r = await req('POST', '/api/public/bookings', {
    coachId: coach.id, startAt: startAt2,
    name: 'Test Anon Renamed', phone: '0988111222',
  });
  assert.equal(r.status, 200);
  // name in DB should be updated — verify via lookup
  const look = await req('POST', '/api/public/users/lookup', { phone: '0988111222' });
  assert.equal(look.data.name, 'Test Anon Renamed');
  console.log('  ✓ same phone reuses user, updates name');
}

// slot collision
{
  const r = await req('POST', '/api/public/bookings', {
    coachId: coach.id, startAt,
    name: 'Other Person', phone: '0988999000',
  });
  assert.equal(r.status, 409);
  console.log('  ✓ slot collision → 409');
}

// missing fields
{
  const r = await req('POST', '/api/public/bookings', { coachId: coach.id });
  assert.equal(r.status, 400);
  console.log('  ✓ missing fields → 400');
}

console.log('[public-api test] done');
