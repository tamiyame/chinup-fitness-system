// 管理者補登：computeAvailableSlots includePast + createBackfillBooking。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, computeAvailableSlots } from '../src/services/availabilityService.js';

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

console.log('[admin-backfill test] availability section done');
