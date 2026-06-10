// 全店小時桶容量：1對1=1人、1對2=2人、非整點佔兩桶、remain 計算、assertBookableTx。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, computeAvailableSlots, assertBookableTx } from '../src/services/availabilityService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[capacity test] start');
db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'cap-%'");

function mkCoach(tag){
  const uid = Number(db.prepare(`INSERT INTO users (name,email,role) VALUES ('C${tag}','cap-${tag}@x.com','coach')`).run().lastInsertRowid);
  return Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, ?, 1)").run(uid, 'C'+tag).lastInsertRowid);
}
const cA = mkCoach('a'), cB = mkCoach('b'), cC = mkCoach('c'), cD = mkCoach('d');
// FK：bookings.member_id 需存在的 user
const memberId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('客','cap-m@x.com','user')").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 3*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId: cD, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });
const ins = db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type) VALUES (?, ?, ?, ?, ?)");

// 業主範例：A、B 兩組 1對1 在 14:00–15:00、C 在 14:30–15:30
ins.run(cA, memberId, `${date}T14:00:00`, `${date}T15:00:00`, '1on1');
ins.run(cB, memberId, `${date}T14:00:00`, `${date}T15:00:00`, '1on1');
ins.run(cC, memberId, `${date}T14:30:00`, `${date}T15:30:00`, '1on1');

const slots = () => computeAvailableSlots({ coachId: cD, fromDate: date, toDate: date });
const at = hh => slots().find(s => s.start === `${date}T${hh}:00`);

expect('14:00 桶滿（3 人）→ 不在清單', () => assert.equal(at('14:00'), undefined));
expect('15:00 → remain 2（C 跨桶佔 1）', () => assert.equal(at('15:00')?.remain, 2));
expect('16:00 → remain 3', () => assert.equal(at('16:00')?.remain, 3));
expect('回傳物件形狀 {start, remain}', () => {
  const s = slots()[0];
  assert(typeof s.start === 'string' && typeof s.remain === 'number');
});

// 1對2 = 2 人：15:00 再加一組 1對2 → 15 桶 = 1+2 = 3 滿
ins.run(cA, memberId, `${date}T15:00:00`, `${date}T16:00:00`, '1on2');
expect('1對2 佔 2 人 → 15:00 桶滿', () => assert.equal(at('15:00'), undefined));
expect('16:00 不受影響 remain 3', () => assert.equal(at('16:00')?.remain, 3));

// assertBookableTx：容量滿 → slot_full；同教練重疊 → slot_taken
expect('assertBookableTx 容量滿 → slot_full', () => assert.throws(
  () => assertBookableTx({ coachId: cD, startAt: `${date}T14:00:00`, endAt: `${date}T15:00:00`, units: 1 }), /slot_full/));
expect('assertBookableTx 同教練重疊（14:30 vs A 的 14:00–15:00）→ slot_taken', () => assert.throws(
  () => assertBookableTx({ coachId: cA, startAt: `${date}T14:30:00`, endAt: `${date}T15:30:00`, units: 1 }), /slot_taken/));
expect('assertBookableTx 16:00 cD 可約 → 不丟', () => assertBookableTx({ coachId: cD, startAt: `${date}T16:00:00`, endAt: `${date}T17:00:00`, units: 1 }));

// externalBusy：手動日曆活動封鎖
expect('externalBusy 10:00–11:30 → 10:00/11:00 消失、12:00 在', () => {
  const eb = new Map([[date, [{ start: '10:00', end: '11:30' }]]]);
  const s = computeAvailableSlots({ coachId: cD, fromDate: date, toDate: date, externalBusy: eb });
  assert(!s.some(x => x.start === `${date}T10:00:00`));
  assert(!s.some(x => x.start === `${date}T11:00:00`));
  assert(s.some(x => x.start === `${date}T12:00:00`));
});

// 同教練重疊（slot 計算路徑）：cD 自己 09:30–10:30 有約（手插非對齊單）→ 09:00/10:00 都消失
db.exec("DELETE FROM bookings");
ins.run(cD, memberId, `${date}T09:30:00`, `${date}T10:30:00`, '1on1');
expect('同教練區間重疊 → 09:00 與 10:00 都不可約', () => {
  const s = slots();
  assert(!s.some(x => x.start === `${date}T09:00:00`));
  assert(!s.some(x => x.start === `${date}T10:00:00`));
  assert(s.some(x => x.start === `${date}T11:00:00`));
});

db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'cap-%'");
console.log('[capacity test] done');
