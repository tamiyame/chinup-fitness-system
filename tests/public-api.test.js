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

console.log('[public-api test] done');
