// 核心流程驗證 — 一對一預約模組
import { db } from '../src/db/connection.js';
import {
  createCoach, listActiveCoaches, getCoach, updateCoach, setCoachActive, saveAvatar,
} from '../src/services/coachService.js';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addRule, listRules, deleteRule,
  addException, listExceptions, deleteException,
} from '../src/services/availabilityService.js';
import { computeAvailableSlots } from '../src/services/availabilityService.js';
import {
  createBooking, cancelBooking, listMemberBookings, listCoachBookings,
} from '../src/services/bookingService.js';
import {
  recordTransaction, getBalance, getBalances,
  adminGrant, listTransactionsForAdmin,
} from '../src/services/pointService.js';
import assert from 'node:assert/strict';

const __testDir = dirname(fileURLToPath(import.meta.url));
const AVATAR_DIR = resolve(__testDir, '../data/avatars');

function reset() {
  db.exec(`
    DELETE FROM point_transactions;
    DELETE FROM bookings;
    DELETE FROM coach_availability_exceptions;
    DELETE FROM coach_availability_rules;
    DELETE FROM coaches;
    DELETE FROM users WHERE email LIKE 'coach-test-%';
    DELETE FROM users WHERE email = 'pm@chinup.local';
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

// --- Case 3: slot computation ---

console.log('[case 3] computeAvailableSlots');

reset();
const uA = makeUser('coach-test-A@chinup.local', '陳教練');
const cA = createCoach({ userId: uA, displayName: '陳教練' });
setCoachActive(cA.id, true);

// Far future rules so "past slot" and "buffer" filters don't trip
addRule({ coachId: cA.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2099-01-01' });
addRule({ coachId: cA.id, dayOfWeek: 3, startTime: '14:00', endTime: '16:00', effectiveFrom: '2099-01-01' });

// 2099-05-04 is a Monday; 2099-05-06 is a Wednesday
const slots = computeAvailableSlots({ coachId: cA.id, fromDate: '2099-05-04', toDate: '2099-05-06', bookingWindowDays: 365 * 100 });
expect('Monday expands to 3 60-min slots (09,10,11)', () => {
  const mon = slots.filter(s => s.startsWith('2099-05-04'));
  assert.deepEqual(mon, ['2099-05-04T09:00:00', '2099-05-04T10:00:00', '2099-05-04T11:00:00']);
});
expect('Wednesday expands to 2 slots (14,15)', () => {
  const wed = slots.filter(s => s.startsWith('2099-05-06'));
  assert.deepEqual(wed, ['2099-05-06T14:00:00', '2099-05-06T15:00:00']);
});
expect('Tuesday yields nothing', () => {
  assert.equal(slots.filter(s => s.startsWith('2099-05-05')).length, 0);
});

// leave exception wipes the day
addException({ coachId: cA.id, exceptionDate: '2099-05-04', type: 'leave' });
const slots2 = computeAvailableSlots({ coachId: cA.id, fromDate: '2099-05-04', toDate: '2099-05-04', bookingWindowDays: 365 * 100 });
expect('leave exception removes all slots that day', () => assert.equal(slots2.length, 0));

// extra exception adds a window
addException({ coachId: cA.id, exceptionDate: '2099-05-07', type: 'extra', startTime: '10:00', endTime: '12:00' });
const slots3 = computeAvailableSlots({ coachId: cA.id, fromDate: '2099-05-07', toDate: '2099-05-07', bookingWindowDays: 365 * 100 });
expect('extra exception adds 2 slots', () => {
  assert.deepEqual(slots3, ['2099-05-07T10:00:00', '2099-05-07T11:00:00']);
});

// effective_from honored
reset();
const uB = makeUser('coach-test-B@chinup.local', 'B 教練');
const cB = createCoach({ userId: uB, displayName: 'B' });
setCoachActive(cB.id, true);
addRule({ coachId: cB.id, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', effectiveFrom: '2099-05-10' });
const slotsBefore = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-04', toDate: '2099-05-04', bookingWindowDays: 365 * 100 });
const slotsAfter  = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-11', toDate: '2099-05-11', bookingWindowDays: 365 * 100 });
expect('rule before effective_from yields nothing', () => assert.equal(slotsBefore.length, 0));
expect('rule on/after effective_from yields slots', () => assert.equal(slotsAfter.length, 1));

// effective_to honored
addRule({ coachId: cB.id, dayOfWeek: 2, startTime: '09:00', endTime: '10:00', effectiveFrom: '2099-05-01', effectiveTo: '2099-05-05' });
const tueIn = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-05', toDate: '2099-05-05', bookingWindowDays: 365 * 100 });
const tueOut = computeAvailableSlots({ coachId: cB.id, fromDate: '2099-05-12', toDate: '2099-05-12', bookingWindowDays: 365 * 100 });
expect('Tuesday within effective_to yields slot', () => assert.equal(tueIn.length, 1));
expect('Tuesday after effective_to yields nothing', () => assert.equal(tueOut.length, 0));

// past slots filtered
addRule({ coachId: cB.id, dayOfWeek: new Date().getDay(), startTime: '00:00', endTime: '23:00', effectiveFrom: '2000-01-01' });
const today = (() => { const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; })();
const todaySlots = computeAvailableSlots({ coachId: cB.id, fromDate: today, toDate: today });
expect('today: no slots before now()', () => {
  const now = new Date();
  const nowStr = `${today}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00`;
  for (const s of todaySlots) assert(s > nowStr, `slot ${s} should be after ${nowStr}`);
});
expect('today: no slot within 2-hour buffer', () => {
  const now = Date.now();
  const buffer = now + 2 * 60 * 60 * 1000;
  for (const s of todaySlots) {
    const slotMs = new Date(s.replace(' ', 'T')).getTime();
    assert(slotMs >= buffer, `slot ${s} within 2h buffer`);
  }
});

// confirmed booking excludes the slot
reset();
const uC = makeUser('coach-test-C@chinup.local', 'C');
const cC = createCoach({ userId: uC, displayName: 'C' });
setCoachActive(cC.id, true);
addRule({ coachId: cC.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2099-01-01' });
const memberId = db.prepare("SELECT id FROM users WHERE role='user' ORDER BY id LIMIT 1").get().id;
// Phase 2 addition: seed points so createBooking doesn't fail
adminGrant({ memberId, pool: 'one_on_one', amount: 5, note: 'test seed', adminId: db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id });
createBooking({ coachId: cC.id, memberId, startAt: '2099-05-04T10:00:00' });
const slotsC = computeAvailableSlots({ coachId: cC.id, fromDate: '2099-05-04', toDate: '2099-05-04', bookingWindowDays: 365 * 100 });
expect('booked slot removed from availability', () => {
  assert.deepEqual(slotsC, ['2099-05-04T09:00:00', '2099-05-04T11:00:00']);
});

// Verify bookingWindowDays default filter
const farFutureRule = computeAvailableSlots({ coachId: cC.id, fromDate: '2099-05-04', toDate: '2099-05-04' });
expect('default window blocks far-future slots', () => assert.equal(farFutureRule.length, 0));

// --- Case 4: booking lifecycle ---

console.log('[case 4] booking lifecycle');

reset();
const uD = makeUser('coach-test-D@chinup.local', 'D');
const cD = createCoach({ userId: uD, displayName: 'D' });
setCoachActive(cD.id, true);
const [m1, m2] = db.prepare("SELECT id FROM users WHERE role='user' ORDER BY id LIMIT 2").all().map(r => r.id);
const adminIdC4 = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
adminGrant({ memberId: m1, pool: 'one_on_one', amount: 10, note: 'test seed', adminId: adminIdC4 });
adminGrant({ memberId: m2, pool: 'one_on_one', amount: 10, note: 'test seed', adminId: adminIdC4 });

const b1 = createBooking({ coachId: cD.id, memberId: m1, startAt: '2099-06-01T10:00:00', note: '想練腿' });
expect('booking created with end_at = +60min', () => assert.equal(b1.endAt, '2099-06-01T11:00:00'));

expect('double-booking same slot rejected', () => {
  assert.throws(() => createBooking({ coachId: cD.id, memberId: m2, startAt: '2099-06-01T10:00:00' }), /slot_taken/);
});

const memberList = listMemberBookings(m1);
expect('listMemberBookings returns the booking', () => {
  assert.equal(memberList.length, 1);
  assert.equal(memberList[0].id, b1.id);
  assert.equal(memberList[0].coach_display_name, 'D');
});

const coachList = listCoachBookings(cD.id);
expect('listCoachBookings returns the booking', () => {
  assert.equal(coachList.length, 1);
  assert.equal(coachList[0].member_name, db.prepare('SELECT name FROM users WHERE id = ?').get(m1).name);
});

cancelBooking({ bookingId: b1.id, actorUserId: m1, isCoach: false });
const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b1.id);
expect('cancelled: status=cancelled, cancelled_by=member, cancelled_at set', () => {
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by, m1);
  assert(row.cancelled_at);
});

expect('cannot cancel an already-cancelled booking', () => {
  assert.throws(() => cancelBooking({ bookingId: b1.id, actorUserId: m1, isCoach: false }), /already_cancelled/);
});

const b2 = createBooking({ coachId: cD.id, memberId: m2, startAt: '2099-06-01T10:00:00' });
expect('slot frees up after cancellation', () => assert(b2.id));

const b3 = createBooking({ coachId: cD.id, memberId: m1, startAt: '2099-06-02T10:00:00' });
expect('member cancelling another member booking fails', () => {
  assert.throws(() => cancelBooking({ bookingId: b3.id, actorUserId: m2, isCoach: false }), /forbidden/);
});

cancelBooking({ bookingId: b3.id, actorUserId: uD, isCoach: true, reason: '臨時生病' });
const b3Row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b3.id);
expect('coach emergency cancel records reason + cancelled_by=coach_user_id', () => {
  assert.equal(b3Row.status, 'cancelled');
  assert.equal(b3Row.cancel_reason, '臨時生病');
  assert.equal(b3Row.cancelled_by, uD);
});

expect('coach cancel requires reason', () => {
  const b4 = createBooking({ coachId: cD.id, memberId: m1, startAt: '2099-06-03T10:00:00' });
  assert.throws(() => cancelBooking({ bookingId: b4.id, actorUserId: uD, isCoach: true }), /missing_reason/);
});

// --- Case 5: avatar save ---

console.log('[case 5] avatar save');

reset();
const uE = makeUser('coach-test-E@chinup.local', 'E');
const cE = createCoach({ userId: uE, displayName: 'E' });

// 1x1 PNG
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000158a4ffae0000000049454e44ae426082', 'hex');
const result = saveAvatar({ coachId: cE.id, base64: png.toString('base64') });
expect('avatar_path returned', () => assert(result.avatar_path.endsWith('.png')));
expect('avatar file exists on disk', () => assert(existsSync(resolve(AVATAR_DIR, result.avatar_path))));

const tooBig = Buffer.alloc(3 * 1024 * 1024).toString('base64');
expect('avatar rejected if too large', () => assert.throws(() => saveAvatar({ coachId: cE.id, base64: tooBig }), /too_large/));

expect('avatar rejected if not png/jpg', () => assert.throws(() => saveAvatar({ coachId: cE.id, base64: Buffer.from('not an image').toString('base64') }), /invalid_image_type/));

// --- Case 6: pointService ---

console.log('[case 6] pointService');

reset();
const uPt1 = makeUser('coach-test-pt1@chinup.local', 'PT 測試員');
// makeUser sets role='coach'; for points testing we need a 'user' role member.
db.prepare("UPDATE users SET role='user' WHERE id = ?").run(uPt1);

const adminId = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;

const g1 = adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 10, note: 'PT 10 堂裝', adminId });
expect('adminGrant returns balance=10', () => assert.equal(g1.balance, 10));
expect('getBalance reflects insert', () => assert.equal(getBalance(uPt1, 'one_on_one'), 10));

adminGrant({ memberId: uPt1, pool: 'group', amount: 5, note: 'group 5 堂', adminId });
expect('getBalances returns both pools', () => {
  const b = getBalances(uPt1);
  assert.equal(b.one_on_one, 10);
  assert.equal(b.group, 5);
});

// Negative grant down to 0 — ok
const g2 = adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: -10, note: 'reverse', adminId });
expect('balance can hit exactly 0', () => assert.equal(g2.balance, 0));

// Negative grant pulling below 0 — throws, rolled back
expect('overdraft throws insufficient_points', () => {
  assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: -1, note: 'overdraft', adminId }),
    /insufficient_points/);
});
expect('overdraft row not persisted', () => {
  const rows = db.prepare("SELECT COUNT(*) AS c FROM point_transactions WHERE member_id = ? AND note = 'overdraft'").get(uPt1);
  assert.equal(rows.c, 0);
});
expect('balance still 0 after rollback', () => assert.equal(getBalance(uPt1, 'one_on_one'), 0));

// amount=0 rejected
expect('amount=0 rejected', () => assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 0, note: 'zero', adminId }), /invalid_amount/));

// empty note rejected
expect('empty note rejected', () => assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 1, note: '', adminId }), /missing_note/));
expect('whitespace note rejected', () => assert.throws(() => adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 1, note: '   ', adminId }), /missing_note/));

// invalid pool rejected
expect('invalid pool rejected', () => assert.throws(() => recordTransaction({ memberId: uPt1, pool: 'bad', amount: 1, note: 'x', actorId: adminId, source: 'admin_grant' }), /invalid_pool/));

// listTransactionsForAdmin
adminGrant({ memberId: uPt1, pool: 'one_on_one', amount: 3, note: 'top up', adminId });
adminGrant({ memberId: uPt1, pool: 'group', amount: 2, note: 'group top', adminId });
const allTx = listTransactionsForAdmin(uPt1);
expect('listTransactionsForAdmin returns all rows DESC', () => {
  assert(allTx.length >= 5);
  // Most recent first
  assert(allTx[0].created_at >= allTx[allTx.length - 1].created_at);
});
expect('listTransactionsForAdmin joins actor_name', () => assert(allTx[0].actor_name));
const onePool = listTransactionsForAdmin(uPt1, { pool: 'group' });
expect('pool filter applied', () => assert(onePool.every(r => r.pool === 'group')));
const limited = listTransactionsForAdmin(uPt1, { limit: 2 });
expect('limit applied', () => assert.equal(limited.length, 2));

// --- Case 7: booking + points integration ---

console.log('[case 7] booking + points');

reset();
const uPt2 = makeUser('coach-test-pt2@chinup.local', 'PT2');
const cPt2 = createCoach({ userId: uPt2, displayName: 'PT2 Coach' });
setCoachActive(cPt2.id, true);
const member = db.prepare("INSERT INTO users (name, email, role, notification_preference) VALUES ('point-mem', 'pm@chinup.local', 'user', 'email')").run().lastInsertRowid;
const ownerForTx = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get().id;
addRule({ coachId: cPt2.id, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', effectiveFrom: '2099-01-01' });

// 0 balance → createBooking throws
expect('createBooking with 0 balance throws insufficient_points', () =>
  assert.throws(() => createBooking({ coachId: cPt2.id, memberId: member, startAt: '2099-06-01T10:00:00' }), /insufficient_points/));

// Booking row NOT persisted
expect('no booking row left over from failed createBooking', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE coach_id = ?").get(cPt2.id).c;
  assert.equal(c, 0);
});

adminGrant({ memberId: member, pool: 'one_on_one', amount: 2, note: 'test seed', adminId: ownerForTx });

const bk1 = createBooking({ coachId: cPt2.id, memberId: member, startAt: '2099-06-01T10:00:00' });
expect('successful createBooking debits 1 point', () => assert.equal(getBalance(member, 'one_on_one'), 1));
expect('booking deduct row has source booking_deduct', () => {
  const row = db.prepare("SELECT * FROM point_transactions WHERE related_booking_id = ?").get(bk1.id);
  assert.equal(row.source, 'booking_deduct');
  assert.equal(row.amount, -1);
});

cancelBooking({ bookingId: bk1.id, actorUserId: member, isCoach: false });
expect('cancelBooking refunds 1 point', () => assert.equal(getBalance(member, 'one_on_one'), 2));
expect('refund row has source booking_refund', () => {
  const row = db.prepare("SELECT * FROM point_transactions WHERE related_booking_id = ? AND source = 'booking_refund'").get(bk1.id);
  assert.equal(row.amount, 1);
  assert.equal(row.actor_id, member);
});

// Coach emergency cancel: actor_id = coach.user_id, refund still goes to the member
const bk2 = createBooking({ coachId: cPt2.id, memberId: member, startAt: '2099-06-08T10:00:00' });
cancelBooking({ bookingId: bk2.id, actorUserId: uPt2, isCoach: true, reason: '臨時生病' });
const refund2 = db.prepare("SELECT * FROM point_transactions WHERE related_booking_id = ? AND source = 'booking_refund'").get(bk2.id);
expect('coach-cancel refund actor_id = coach.user_id', () => assert.equal(refund2.actor_id, uPt2));
expect('coach-cancel refund note contains reason', () => assert(refund2.note.includes('臨時生病')));
expect('coach-cancel refund still goes to member', () => assert.equal(refund2.member_id, member));
