// 管理者於過去日期預約（校正/補登記）：computeAvailableSlots includePast。
// 過去時段「比照正常預約」——僅放行過去/緩衝時間過濾，容量/重疊照常檢查。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, computeAvailableSlots } from '../src/services/availabilityService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-backfill test] start');

db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'abf-%'); DELETE FROM users WHERE email LIKE 'abf-%'");

const uPast = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABF PastCoach','abf-p@x.com','coach')").run().lastInsertRowid);
const cPast = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABF-P', 1)").run(uPast).lastInsertRowid);
const uFut = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABF FutCoach','abf-f@x.com','coach')").run().lastInsertRowid);
const cFut = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABF-F', 1)").run(uFut).lastInsertRowid);

const past = new Date(Date.now() - 7*86400000);
const pastDate = fmtDate(past);
addRule({ coachId: cPast, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });
const pastStart = `${pastDate}T10:00:00`;

expect('includePast 預設 false → 過去日期 0 slot', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate });
  assert.equal(s.length, 0);
});
expect('includePast=true → 過去日期含 10:00、past:true、remain 為數值', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate, includePast: true });
  assert.equal(s.length, 9);
  const hit = s.find(x => x.start === pastStart);
  assert.ok(hit);
  assert.equal(hit.past, true);
  assert.equal(typeof hit.remain, 'number');
  assert.ok(hit.remain >= 1);
});

// 容量/重疊「比照正常」：同教練該過去時段已有 confirmed 預約 → 該時段被排除（教練不可同時帶兩堂）
db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type) VALUES (?,?,?,?, 'confirmed','1on1')")
  .run(cPast, uPast, pastStart, `${pastDate}T11:00:00`);
expect('includePast=true：同教練過去時段已被預約 → 該時段排除（重疊照常檢查）', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate, includePast: true });
  assert.ok(!s.some(x => x.start === pastStart));
  assert.ok(s.some(x => x.start === `${pastDate}T11:00:00`)); // 相鄰時段仍在
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

db.exec(`DELETE FROM bookings WHERE coach_id IN (${cPast}, ${cFut}); DELETE FROM coaches WHERE id IN (${cPast}, ${cFut}); DELETE FROM users WHERE id IN (${uPast}, ${uFut}) OR email LIKE 'abf-%'`);
console.log('[admin-backfill test] done');
