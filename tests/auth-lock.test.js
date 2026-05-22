// Verify user-role accounts cannot login after Phase 4 lock
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

const r1 = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ email: 'user1@chinup.local', password: 'pass1234' })
});
assert.equal(r1.status, 403);
console.log('  ✓ user-role login blocked');

const r2 = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ email: 'admin@chinup.local', password: 'admin1234' })
});
assert.equal(r2.status, 200);
console.log('  ✓ admin login still works');
