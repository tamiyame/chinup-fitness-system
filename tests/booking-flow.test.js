// 核心流程驗證 — 一對一預約模組
import { db } from '../src/db/connection.js';
import {
  createCoach, listActiveCoaches, getCoach, updateCoach, setCoachActive,
} from '../src/services/coachService.js';
import assert from 'node:assert/strict';

function reset() {
  db.exec(`
    DELETE FROM bookings;
    DELETE FROM coach_availability_exceptions;
    DELETE FROM coach_availability_rules;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'coach-test-%';
  `);
}

function makeUser(email, name = 'Test') {
  const info = db.prepare(
    "INSERT INTO users (name, email, role, notification_preference) VALUES (?, ?, 'coach', 'email')"
  ).run(name, email);
  return info.lastInsertRowid;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[booking-flow test] start');
reset();

// --- Case 1: coachService basics ---
console.log('[case 1] coach CRUD');
const u1 = makeUser('coach-test-1@chinup.local', '王教練');
const c1 = createCoach({
  userId: u1,
  displayName: '王教練',
  specialty: '增肌減脂',
  bio: '10 年經驗',
});
expect('createCoach returns id', () => assert(c1.id));
expect('new coach is_active=0 (pending)', () => {
  const row = getCoach(c1.id);
  assert.equal(row.is_active, 0);
});
expect('listActiveCoaches excludes pending', () => {
  assert.equal(listActiveCoaches().length, 0);
});

setCoachActive(c1.id, true);
expect('after activation, appears in list', () => {
  const list = listActiveCoaches();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c1.id);
});

updateCoach(c1.id, { specialty: '增肌減脂 · 體態雕塑', bio: 'updated' });
expect('updateCoach applies fields', () => {
  const row = getCoach(c1.id);
  assert.equal(row.specialty, '增肌減脂 · 體態雕塑');
  assert.equal(row.bio, 'updated');
});

expect('duplicate user_id rejected', () => {
  assert.throws(() => createCoach({ userId: u1, displayName: 'dup' }), /UNIQUE|coach_exists/);
});
