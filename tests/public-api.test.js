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

// Need an open session — find one via /api/sessions
const sessRes = await fetch(BASE + '/api/sessions');
const sessions = await sessRes.json();
const openSess = sessions.find((s) => s.status === 'open' && s.confirmed_count < s.max_capacity);
assert.ok(openSess, 'need at least one open session');

// anon registration
{
  const r = await req('POST', '/api/public/registrations', {
    sessionId: openSess.id,
    name: 'Anon Reg', phone: '0977555666',
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.registrationId);
  assert.ok(['confirmed','waitlisted'].includes(r.data.status));
  assert.ok(r.data.lineBindCode);  // new user
  console.log('  ✓ anon registration succeeds');
}

// double-register same phone same session
{
  const r = await req('POST', '/api/public/registrations', {
    sessionId: openSess.id,
    name: 'Anon Reg', phone: '0977555666',
  });
  assert.equal(r.status, 409);
  console.log('  ✓ duplicate registration → 409');
}

// fetch my bookings + registrations by phone (use the phone from earlier anon booking)
{
  const r = await fetch(BASE + '/api/public/my?phone=0988111222');
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.user.phone, '0988111222');
  assert.ok(Array.isArray(data.bookings));
  assert.ok(Array.isArray(data.registrations));
  assert.ok(data.bookings.length >= 1);
  console.log('  ✓ my-by-phone returns bookings');
}

// unknown phone
{
  const r = await fetch(BASE + '/api/public/my?phone=0000000000');
  assert.equal(r.status, 404);
  console.log('  ✓ unknown phone → 404');
}

// invalid phone
{
  const r = await fetch(BASE + '/api/public/my?phone=abc');
  assert.equal(r.status, 400);
  console.log('  ✓ invalid phone → 400');
}

// DELETE /api/public/bookings/:id
{
  const myAgain = await (await fetch(BASE + '/api/public/my?phone=0988111222')).json();
  const bookingId = myAgain.bookings[0].id;

  // wrong phone (existing user, doesn't own booking) → 403
  {
    const r = await fetch(BASE + `/api/public/bookings/${bookingId}?phone=0988999000`, { method: 'DELETE' });
    assert.equal(r.status, 403);
    console.log('  ✓ wrong phone cancel → 403');
  }

  // correct phone → 200
  {
    const r = await fetch(BASE + `/api/public/bookings/${bookingId}?phone=0988111222`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    console.log('  ✓ correct phone cancel → 200');
  }

  // double cancel → 409
  {
    const r = await fetch(BASE + `/api/public/bookings/${bookingId}?phone=0988111222`, { method: 'DELETE' });
    assert.equal(r.status, 409);
    console.log('  ✓ double cancel → 409');
  }
}

console.log('[public-api test] done');
