// Phase 3A · myScheduleService 流程驗證
import assert from 'node:assert/strict';
import { db, nowLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createBooking, cancelBooking } from '../src/services/bookingService.js';
import { createTemplate } from '../src/services/courseService.js';
import { register, cancelRegistration } from '../src/services/registration.js';
import { adminGrant } from '../src/services/pointService.js';
import { listMySchedule } from '../src/services/myScheduleService.js';

function reset() {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM point_transactions;
    DELETE FROM bookings;
    DELETE FROM registrations;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM coach_availability_exceptions;
    DELETE FROM coach_availability_rules;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'my-sched-test-%';
  `);
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

function createAdmin() {
  let existing = db.prepare("SELECT id FROM users WHERE role = 'owner'").get();
  if (existing) return existing.id;
  existing = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  if (existing) return existing.id;
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')"
  ).run('Admin', 'my-sched-test-admin@chinup.local', hashPassword('pass1234'));
  return info.lastInsertRowid;
}

function createCoachFor(name, email) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'coach')"
  ).run(name, email, hashPassword('pass1234'));
  const coach = createCoach({ userId: info.lastInsertRowid, displayName: name });
  setCoachActive(coach.id, true);
  return coach;
}

function futureLocal(daysAhead, hh = 10, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hh)}:${pad(mm)}:00`;
}

console.log('[my-schedule-service test] start');
reset();

const adminId = createAdmin();
const memberA = createMember('Member A', 'my-sched-test-a@chinup.local');
const memberB = createMember('Member B', 'my-sched-test-b@chinup.local');
const coach = createCoachFor('Test Coach', 'my-sched-test-coach@chinup.local');

// Seed: Member A has 1 future booking + 1 past booking (manually inserted past)
adminGrant({ memberId: memberA, pool: 'one_on_one', amount: 10, note: 'seed', adminId });
adminGrant({ memberId: memberA, pool: 'group', amount: 10, note: 'seed', adminId });

const futureBookingStart = futureLocal(7, 10, 0);
createBooking({ coachId: coach.id, memberId: memberA, startAt: futureBookingStart, note: 'future booking' });

// Inject a past booking directly via SQL (bookingService doesn't allow past)
const pastBookingStart = '2024-01-01T10:00:00';
const pastBookingEnd   = '2024-01-01T11:00:00';
db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, note) VALUES (?, ?, ?, ?, 'confirmed', 'past booking')"
).run(coach.id, memberA, pastBookingStart, pastBookingEnd);

// Empty user
console.log('[1] empty user');
const emptyItems = listMySchedule({ userId: memberB });
expect('returns array', () => assert(Array.isArray(emptyItems)));
expect('empty for new user', () => assert.equal(emptyItems.length, 0));

// Booking shape + flags
console.log('[2] booking shape');
const aItems = listMySchedule({ userId: memberA });
expect('2 items total', () => assert.equal(aItems.length, 2));
expect('sorted DESC by start_at', () => assert(aItems[0].start_at > aItems[1].start_at));

const future = aItems.find(x => x.note === 'future booking');
const past   = aItems.find(x => x.note === 'past booking');
expect('future kind=booking', () => assert.equal(future.kind, 'booking'));
expect('future is_past=false', () => assert.equal(future.is_past, false));
expect('future can_cancel=true', () => assert.equal(future.can_cancel, true));
expect('future coach_display_name', () => assert.equal(future.coach_display_name, 'Test Coach'));
expect('future session_id=null', () => assert.equal(future.session_id, null));
expect('future course_name=null', () => assert.equal(future.course_name, null));
expect('past is_past=true', () => assert.equal(past.is_past, true));
expect('past can_cancel=false', () => assert.equal(past.can_cancel, false));

// Cancelled booking can_cancel=false
console.log('[3] cancelled booking');
cancelBooking({ bookingId: future.id, actorUserId: memberA, reason: 'test' });
const afterCancel = listMySchedule({ userId: memberA }).find(x => x.id === future.id);
expect('cancelled kind=booking', () => assert.equal(afterCancel.kind, 'booking'));
expect('cancelled status=cancelled', () => assert.equal(afterCancel.status, 'cancelled'));
expect('cancelled can_cancel=false', () => assert.equal(afterCancel.can_cancel, false));

// Registration shape
console.log('[4] registration shape');
const tpl = createTemplate({
  name: 'Test Class',
  min_capacity: 1, max_capacity: 5,
  day_of_week: ((new Date()).getDay() + 3) % 7,
  start_time: '19:00', duration_minutes: 60,
  recurrence: 'weekly',
  cycle_start_date: futureLocal(1).slice(0, 10),
  cycle_end_date:   futureLocal(60).slice(0, 10),
  registration_deadline_hours: 24,
});
const session = db.prepare(
  'SELECT id, start_at FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC LIMIT 1'
).get(tpl.templateId);
register({ sessionId: session.id, userId: memberA });

const afterReg = listMySchedule({ userId: memberA });
const reg = afterReg.find(x => x.kind === 'registration');
expect('registration present', () => assert(reg));
expect('reg course_name', () => assert.equal(reg.course_name, 'Test Class'));
expect('reg session_status=open', () => assert.equal(reg.session_status, 'open'));
expect('reg duration_minutes=60', () => assert.equal(reg.duration_minutes, 60));
expect('reg can_cancel=true', () => assert.equal(reg.can_cancel, true));
expect('reg coach_id=null', () => assert.equal(reg.coach_id, null));
expect('reg note=null', () => assert.equal(reg.note, null));

// Cross-user isolation
console.log('[5] cross-user isolation');
const bItems = listMySchedule({ userId: memberB });
expect('member B sees nothing of A', () => assert.equal(bItems.length, 0));

// can_cancel=false negatives for registrations
console.log('[6] registration can_cancel negatives');

// Mark current reg as rejected → can_cancel should be false
db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?").run(reg.id);
let neg = listMySchedule({ userId: memberA }).find(x => x.kind === 'registration');
expect('rejected reg can_cancel=false', () => assert.equal(neg.can_cancel, false));

// Restore reg status and instead mark session as cancelled → can_cancel should be false
db.prepare("UPDATE registrations SET status = 'confirmed' WHERE id = ?").run(reg.id);
db.prepare("UPDATE course_sessions SET status = 'cancelled' WHERE id = ?").run(session.id);
neg = listMySchedule({ userId: memberA }).find(x => x.kind === 'registration');
expect('session_status=cancelled → reg can_cancel=false', () => assert.equal(neg.can_cancel, false));

console.log('[my-schedule-service test] done');
