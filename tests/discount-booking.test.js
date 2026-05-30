import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createBookingAnon, cancelBookingAnon, cancelBooking } from '../src/services/bookingService.js';
import { getOneOnOnePrice } from '../src/services/discountService.js';

function reset() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0992%' OR email LIKE 'dbk-%@%');
    DELETE FROM discount_redemptions WHERE phone LIKE '0992%';
    DELETE FROM bookings WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'dbk-%@%'));
    DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'dbk-%@%');
    DELETE FROM users WHERE phone LIKE '0992%' OR email LIKE 'dbk-%@%';
    DELETE FROM discount_codes WHERE code LIKE 'TESTDBK%';
  `);
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

function futureLocal(days, hh = 10) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:00:00`;
}

console.log('[discount-booking] start');
reset();

// Seed: active coach
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach DBK','dbk-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'Coach DBK' });
setCoachActive(coach.id, true);

// Seed: fixed-200 discount code
db.prepare(`INSERT INTO discount_codes (code, discount_type, discount_value, active)
  VALUES ('TESTDBK200', 'fixed', 200, 1)`).run();

const price = getOneOnOnePrice(); // e.g. 1500

// ── Test 1: createBookingAnon with discountCode ──
let discountBookingId;
expect('createBookingAnon with discountCode: returns discount fields', () => {
  const r = createBookingAnon({
    coachId: coach.id, startAt: futureLocal(3),
    name: '折客', phone: '0992000001',
    discountCode: 'TESTDBK200',
  });
  discountBookingId = r.id;
  assert(r.id, 'id should exist');
  assert.equal(r.originalAmount, price, `originalAmount should be ${price}`);
  assert.equal(r.discountAmount, 200, 'discountAmount should be 200');
  assert.equal(r.discountCode, 'TESTDBK200', 'discountCode should be set');
  assert.equal(r.finalAmount, price - 200, `finalAmount should be ${price - 200}`);
});

expect('DB bookings row has correct discount fields', () => {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(discountBookingId);
  assert.equal(row.original_amount, price);
  assert.equal(row.discount_amount, 200);
  assert.equal(row.discount_code, 'TESTDBK200');
});

expect('discount_redemptions row exists for the booking', () => {
  const row = db.prepare(`
    SELECT dr.* FROM discount_redemptions dr
    JOIN discount_codes dc ON dc.id = dr.code_id
    WHERE dr.kind='booking' AND dr.ref_id=? AND dc.code='TESTDBK200'
  `).get(discountBookingId);
  assert(row, 'redemption row should exist');
  assert.equal(row.amount, 200);
  assert.equal(row.phone, '0992000001');
});

// ── Test 2: cancelBookingAnon releases the redemption ──
expect('cancelBookingAnon releases the redemption', () => {
  const res = cancelBookingAnon({ bookingId: discountBookingId, phone: '0992000001', name: '折客' });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT * FROM discount_redemptions WHERE kind=? AND ref_id=?')
    .get('booking', discountBookingId);
  assert.equal(row, undefined, 'redemption row should be deleted after cancel');
  // usage count for code should be 0
  const codeRow = db.prepare("SELECT id FROM discount_codes WHERE code='TESTDBK200'").get();
  const count = db.prepare('SELECT COUNT(*) AS c FROM discount_redemptions WHERE code_id=?').get(codeRow.id).c;
  assert.equal(count, 0, 'usage count should be 0 after release');
});

// ── Test 3: createBookingAnon without discountCode → discount_* NULL ──
let noDiscountBookingId;
expect('createBookingAnon without discountCode: discount_* NULL', () => {
  const r = createBookingAnon({
    coachId: coach.id, startAt: futureLocal(4),
    name: '無折', phone: '0992000002',
  });
  noDiscountBookingId = r.id;
  assert.equal(r.originalAmount, price, `originalAmount should be ${price}`);
  assert.equal(r.discountAmount, null, 'discountAmount should be null');
  assert.equal(r.discountCode, null, 'discountCode should be null');
  assert.equal(r.finalAmount, price, `finalAmount should be ${price}`);
});

expect('DB bookings row: no discount, original_amount=price, discount_* NULL', () => {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(noDiscountBookingId);
  assert.equal(row.original_amount, price);
  assert.equal(row.discount_amount, null);
  assert.equal(row.discount_code, null);
});

// ── Test 4: invalid discountCode → throws, tx rollback ──
expect('invalid discountCode → throws, tx rollback, no booking written', () => {
  const before = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone='0992000003')").get().c;
  try {
    createBookingAnon({
      coachId: coach.id, startAt: futureLocal(5),
      name: '錯碼', phone: '0992000003',
      discountCode: 'TESTDBK_NOPE',
    });
    assert.fail('should have thrown');
  } catch (e) {
    assert(e.status === 404 || e.status === 409 || e.status === 400, `expected ApiError, got status=${e.status}`);
  }
  const after = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone='0992000003')").get().c;
  assert.equal(after, before, 'no booking should be written on invalid code (tx rollback)');
});

// ── Test 5: cancelBooking (logged-in/coach path) releases the redemption ──
let coachCancelBookingId;
expect('cancelBooking (coach path) releases the redemption', () => {
  const r = createBookingAnon({
    coachId: coach.id, startAt: futureLocal(6),
    name: '折教客', phone: '0992000005',
    discountCode: 'TESTDBK200',
  });
  coachCancelBookingId = r.id;
  // sanity: redemption present before cancel
  const before = db.prepare('SELECT * FROM discount_redemptions WHERE kind=? AND ref_id=?')
    .get('booking', coachCancelBookingId);
  assert(before, 'redemption should exist before cancel');

  const res = cancelBooking({ bookingId: coachCancelBookingId, actorUserId: cu.lastInsertRowid, isCoach: true, reason: 'x' });
  assert.equal(res.ok, true);

  const after = db.prepare('SELECT * FROM discount_redemptions WHERE kind=? AND ref_id=?')
    .get('booking', coachCancelBookingId);
  assert.equal(after, undefined, 'redemption row should be deleted after coach cancel');
});

// ── Cleanup ──
reset();
console.log('[discount-booking] done');
