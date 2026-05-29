import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { login, hashPassword } from '../src/services/auth.js';
import { ApiError } from '../src/services/registration.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
db.exec("DELETE FROM users WHERE email IN ('lock-user@x.com','lock-admin@x.com')");
db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('U','lock-user@x.com',?, 'user')").run(hashPassword('pass1234'));
db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('A','lock-admin@x.com',?, 'admin')").run(hashPassword('pass1234'));

console.log('[auth-lock test] start');
expect('user role blocked → 403 user_login_disabled', () => {
  try { login({ email:'lock-user@x.com', password:'pass1234' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); assert.equal(e.code, 'user_login_disabled'); }
});
expect('admin still logs in', () => {
  const r = login({ email:'lock-admin@x.com', password:'pass1234' });
  assert(r.token);
});
console.log('[auth-lock test] done');
