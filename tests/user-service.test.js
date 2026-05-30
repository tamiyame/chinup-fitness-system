import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { findOrCreateUserByPhone, getUserByPhoneAndName, validatePhone } from '../src/services/userService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec("DELETE FROM users WHERE phone LIKE '0999%'");
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[user-service test] start');
reset();

// validatePhone
expect('accepts 8-15 digits', () => assert.equal(validatePhone('0999000111'), true));
expect('rejects with dashes', () => assert.equal(validatePhone('0999-000-111'), false));
expect('rejects too short', () => assert.equal(validatePhone('099'), false));

// create
const u1 = findOrCreateUserByPhone({ phone: '0999000111', name: '小明' });
expect('creates user', () => assert(u1.id));
expect('role=user', () => assert.equal(u1.role, 'user'));
expect('email null', () => assert.equal(u1.email, null));

// reuse + name NOT overwritten
const u2 = findOrCreateUserByPhone({ phone: '0999000111', name: '改名了' });
expect('reuses same id', () => assert.equal(u2.id, u1.id));
expect('name unchanged (first-write-wins)', () => assert.equal(u2.name, '小明'));

// invalid phone
expect('invalid phone throws 400', () => {
  try { findOrCreateUserByPhone({ phone: 'abc', name: 'x' }); assert.fail('no throw'); }
  catch (e) { assert(e instanceof ApiError); assert.equal(e.status, 400); }
});

// getUserByPhoneAndName: trim + case-insensitive
expect('lookup matches trimmed/case', () => {
  const got = getUserByPhoneAndName({ phone: '0999000111', name: '  小明 ' });
  assert(got && got.id === u1.id);
});
expect('lookup wrong name → null', () =>
  assert.equal(getUserByPhoneAndName({ phone: '0999000111', name: '別人' }), null));
expect('lookup unknown phone → null', () =>
  assert.equal(getUserByPhoneAndName({ phone: '0999999999', name: 'x' }), null));

console.log('[user-service test] done');
