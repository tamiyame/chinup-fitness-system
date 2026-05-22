process.env.LINE_MOCK = '1';
import { db } from '../src/db/connection.js';
import { findOrCreateUserByPhone, validatePhone } from '../src/services/userService.js';
import assert from 'node:assert/strict';

function reset() {
  db.exec("DELETE FROM users WHERE email IS NULL OR email LIKE 'test-%@local'");
}

console.log('[user-service test] start');
reset();

// validatePhone
assert.equal(validatePhone('0912345678'), true);
assert.equal(validatePhone('+886912345678'), false);
assert.equal(validatePhone('091234567'), true);   // 9 digits OK
assert.equal(validatePhone('123'), false);         // too short
assert.equal(validatePhone(''), false);
assert.equal(validatePhone('abc1234567'), false);
console.log('  ✓ validatePhone format checks');

// findOrCreateUserByPhone: new
const { userId: id1, created: c1 } = findOrCreateUserByPhone({ phone: '0911111111', name: 'Test Alice' });
assert.ok(id1 > 0);
assert.equal(c1, true);
const row1 = db.prepare('SELECT * FROM users WHERE id = ?').get(id1);
assert.equal(row1.name, 'Test Alice');
assert.equal(row1.phone, '0911111111');
assert.equal(row1.email, null);
assert.equal(row1.role, 'user');
console.log('  ✓ creates new user with NULL email');

// findOrCreateUserByPhone: existing, same name
const { userId: id2, created: c2 } = findOrCreateUserByPhone({ phone: '0911111111', name: 'Test Alice' });
assert.equal(id2, id1);
assert.equal(c2, false);
console.log('  ✓ finds existing user by phone');

// findOrCreateUserByPhone: existing, different name → update
const { userId: id3 } = findOrCreateUserByPhone({ phone: '0911111111', name: 'Test Alice 2' });
assert.equal(id3, id1);
const row3 = db.prepare('SELECT name FROM users WHERE id = ?').get(id1);
assert.equal(row3.name, 'Test Alice 2');
console.log('  ✓ updates name on existing phone');

// invalid phone throws
assert.throws(() => findOrCreateUserByPhone({ phone: '123', name: 'X' }), /invalid_phone/);
console.log('  ✓ throws on invalid phone');

reset();
console.log('[user-service test] done');
