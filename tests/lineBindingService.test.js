// Phase 3C · lineBindingService flow verification
import assert from 'node:assert/strict';
import { db, nowLocal, offsetLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { generateBindCode, consumeCode, unbindByLineUserId } from '../src/services/lineBindingService.js';

function reset() {
  db.exec(`DELETE FROM users WHERE email LIKE 'line-bind-test-%';`);
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

function createMember(name, email) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')"
  ).run(name, email, hashPassword('pass1234'));
  return info.lastInsertRowid;
}

console.log('[line-binding test] start');
reset();

const userA = createMember('A', 'line-bind-test-a@chinup.local');
const userB = createMember('B', 'line-bind-test-b@chinup.local');

// --- generateBindCode ---
const gen = generateBindCode(userA);
expect('code is 6-digit string', () => assert(/^\d{6}$/.test(gen.code)));
expect('expires_at is future', () => assert(gen.expires_at > nowLocal()));
const aRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userA);
expect('code written to user', () => assert.equal(aRow.line_bind_code, gen.code));
expect('expires_at written to user', () => assert.equal(aRow.line_bind_expires_at, gen.expires_at));

// --- consumeCode: invalid code ---
const r1 = consumeCode('000000', 'Uinvalid');
expect('unknown code → invalid_code', () => assert.equal(r1.outcome, 'invalid_code'));

// --- consumeCode: expired ---
db.prepare("UPDATE users SET line_bind_expires_at = ? WHERE id = ?")
  .run('2020-01-01T00:00:00', userA);
const r2 = consumeCode(gen.code, 'Uexpired');
expect('expired code → invalid_code', () => assert.equal(r2.outcome, 'invalid_code'));

// Restore A with a fresh code
const gen2 = generateBindCode(userA);

// --- consumeCode: bound (happy path) ---
const r3 = consumeCode(gen2.code, 'Ulinea-real');
expect('happy → outcome=bound', () => assert.equal(r3.outcome, 'bound'));
const aAfter = db.prepare('SELECT * FROM users WHERE id = ?').get(userA);
expect('line_user_id written', () => assert.equal(aAfter.line_user_id, 'Ulinea-real'));
expect('bind_code cleared', () => assert.equal(aAfter.line_bind_code, null));
expect('bind_expires_at cleared', () => assert.equal(aAfter.line_bind_expires_at, null));

// --- consumeCode: chinup_already_bound ---
const gen3 = generateBindCode(userA);  // A is already bound; try to bind again
const r4 = consumeCode(gen3.code, 'Uanother');
expect('already-bound chinup → chinup_already_bound', () => assert.equal(r4.outcome, 'chinup_already_bound'));

// --- consumeCode: this_line_already_bound ---
const gen4 = generateBindCode(userB);
const r5 = consumeCode(gen4.code, 'Ulinea-real');  // same LINE that bound A
expect('LINE-ID taken → this_line_already_bound', () => assert.equal(r5.outcome, 'this_line_already_bound'));

// --- unbindByLineUserId ---
unbindByLineUserId('Ulinea-real');
const aAfterUnbind = db.prepare('SELECT * FROM users WHERE id = ?').get(userA);
expect('unbind clears line_user_id', () => assert.equal(aAfterUnbind.line_user_id, null));

// --- unbindByLineUserId on unknown id is no-op ---
unbindByLineUserId('Unone');
expect('unbind unknown is no-op', () => assert(true));

console.log('[line-binding test] done');
