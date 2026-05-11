// 核心流程驗證 — 一對一預約模組
import { db } from '../src/db/connection.js';
import {
  createCoach, listActiveCoaches, getCoach, updateCoach, setCoachActive,
} from '../src/services/coachService.js';
import {
  addRule, listRules, deleteRule,
  addException, listExceptions, deleteException,
} from '../src/services/availabilityService.js';
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

// --- Case 2: availability rules + exceptions CRUD ---

console.log('[case 2] availability rules + exceptions');

const r1 = addRule({ coachId: c1.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2026-05-01' });
const r2 = addRule({ coachId: c1.id, dayOfWeek: 1, startTime: '14:00', endTime: '17:00', effectiveFrom: '2026-05-01' });
expect('coach can have two rules on same day', () => {
  const rules = listRules(c1.id);
  assert.equal(rules.length, 2);
});

expect('addRule rejects start >= end', () => {
  assert.throws(() => addRule({ coachId: c1.id, dayOfWeek: 2, startTime: '10:00', endTime: '09:00' }), /invalid_time|CHECK/);
});

deleteRule({ coachId: c1.id, ruleId: r1.id });
expect('after delete, only one rule remains', () => assert.equal(listRules(c1.id).length, 1));

expect('cannot delete another coach rule', () => {
  // Create a second coach, try to delete c1's rule using its id
  const u2 = makeUser('coach-test-2@chinup.local', '李教練');
  const c2 = createCoach({ userId: u2, displayName: '李教練' });
  assert.throws(() => deleteRule({ coachId: c2.id, ruleId: r2.id }), /forbidden|not_found/);
});

const ex1 = addException({ coachId: c1.id, exceptionDate: '2026-05-13', type: 'leave', note: '個人事務' });
const ex2 = addException({ coachId: c1.id, exceptionDate: '2026-05-18', type: 'extra', startTime: '10:00', endTime: '13:00' });
expect('two exceptions stored', () => assert.equal(listExceptions(c1.id).length, 2));

expect('extra exception requires times', () => {
  assert.throws(() => addException({ coachId: c1.id, exceptionDate: '2026-05-20', type: 'extra' }), /missing_time|CHECK/);
});

deleteException({ coachId: c1.id, exceptionId: ex1.id });
expect('after delete, one exception remains', () => assert.equal(listExceptions(c1.id).length, 1));
