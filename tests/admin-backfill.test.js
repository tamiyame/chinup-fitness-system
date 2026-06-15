// 管理者補登：computeAvailableSlots includePast + createBackfillBooking。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, computeAvailableSlots } from '../src/services/availabilityService.js';
import { createBackfillBooking } from '../src/services/bookingService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-backfill test] start');

// 清理（本測試用 email/phone 前綴 abf-）
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0956%'); DELETE FROM users WHERE email LIKE 'abf-%' OR phone LIKE '0956%'");

// 兩位教練：cPast 測過去、cFut 測未來回歸（避免 dow 規則互相干擾）
const uPast = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABF PastCoach','abf-p@x.com','coach')").run().lastInsertRowid);
const cPast = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABF-P', 1)").run(uPast).lastInsertRowid);
const uFut = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABF FutCoach','abf-f@x.com','coach')").run().lastInsertRowid);
const cFut = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABF-F', 1)").run(uFut).lastInsertRowid);

const past = new Date(Date.now() - 7*86400000);
const pastDate = fmtDate(past);
addRule({ coachId: cPast, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });

expect('includePast 預設 false → 過去日期 0 slot', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate });
  assert.equal(s.length, 0);
});
expect('includePast=true → 過去日期 9 slot、皆 past:true', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate, includePast: true });
  assert.equal(s.length, 9);
  assert.ok(s.every(x => x.past === true));
  assert.ok(s.some(x => x.start === `${pastDate}T10:00:00`));
});

const fut = new Date(Date.now() + 7*86400000);
const futDate = fmtDate(fut);
addRule({ coachId: cFut, dayOfWeek: fut.getDay(), startTime: '09:00', endTime: '12:00', effectiveFrom: '2000-01-01' });
expect('未來日期：includePast 不改變結果、皆 past:false', () => {
  const a = computeAvailableSlots({ coachId: cFut, fromDate: futDate, toDate: futDate });
  const b = computeAvailableSlots({ coachId: cFut, fromDate: futDate, toDate: futDate, includePast: true });
  assert.equal(a.length, b.length);
  assert.ok(a.length >= 1);
  assert.ok(b.every(x => x.past === false));
});

// ── createBackfillBooking ──
const pastStart = `${pastDate}T10:00:00`;
const notifBefore = db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c;
const r = createBackfillBooking({ coachId: cPast, startAt: pastStart, name: '補登客', phone: '0956000001', sessionType: '1on1', amount: 1500, note: '補登測試', actorId: uPast });
expect('補登：confirmed + paid_at + paid_by + 金額 + note', () => {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.id);
  assert.equal(row.status, 'confirmed');
  assert.ok(row.paid_at);
  assert.equal(row.paid_by, uPast);
  assert.equal(row.original_amount, 1500);
  assert.equal(row.discount_amount, null);
  assert.equal(row.session_type, '1on1');
  assert.equal(row.note, '補登測試');
});
expect('補登：不產生任何通知（靜默）', () => {
  const after = db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c;
  assert.equal(after, notifBefore);
});
expect('補登：未來 startAt → not_past', () => {
  assert.throws(() => createBackfillBooking({ coachId: cPast, startAt: `${futDate}T10:00:00`, name:'x', phone:'0956000002', amount:0, actorId: uPast }), /not_past/);
});
expect('補登：負數金額 → invalid_amount', () => {
  assert.throws(() => createBackfillBooking({ coachId: cPast, startAt: `${pastDate}T12:00:00`, name:'x', phone:'0956000003', amount:-5, actorId: uPast }), /invalid_amount/);
});
expect('補登：金額 0 合法（贈課）', () => {
  const r0 = createBackfillBooking({ coachId: cPast, startAt: `${pastDate}T11:00:00`, name:'贈課', phone:'0956000004', amount:0, actorId: uPast });
  assert.equal(db.prepare('SELECT original_amount FROM bookings WHERE id=?').get(r0.id).original_amount, 0);
});
expect('補登：同教練同時段重複 → 409 already_booked', () => {
  let err;
  try { createBackfillBooking({ coachId: cPast, startAt: pastStart, name:'重複', phone:'0956000005', amount:1500, actorId: uPast }); }
  catch (e) { err = e; }
  assert.ok(err); assert.equal(err.code, 'already_booked');
});

// 清理本測試資料
db.exec(`DELETE FROM bookings WHERE coach_id IN (${cPast}, ${cFut}); DELETE FROM coaches WHERE id IN (${cPast}, ${cFut}); DELETE FROM users WHERE id IN (${uPast}, ${uFut}) OR phone LIKE '0956%'`);
console.log('[admin-backfill test] done');
