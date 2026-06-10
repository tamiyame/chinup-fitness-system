// 特殊日期「請假」支援部分時段（時:分）+ 整天；驗證 slot 計算。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, addException, computeAvailableSlots } from '../src/services/availabilityService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[availability-leave test] start');
db.exec("DELETE FROM users WHERE email='avl-coach@x.com'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('AVL Coach','avl-coach@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'AVL', 1)").run(uid).lastInsertRowid);

const pad = (n) => String(n).padStart(2, '0');
const d = new Date(Date.now() + 3 * 86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });
const slots = () => computeAvailableSlots({ coachId, fromDate: date, toDate: date }).filter(s => s.startsWith(date));

expect('baseline 09–18 → 9 個 slot (09:00..17:00)', () => assert.equal(slots().length, 9));

// 部分時段請假 14:00–16:00
const r1 = addException({ coachId, exceptionDate: date, type: 'leave', startTime: '14:00', endTime: '16:00' });
expect('部分請假：start/end 有存', () => {
  const ex = db.prepare('SELECT start_time,end_time FROM coach_availability_exceptions WHERE id=?').get(r1.id);
  assert.equal(ex.start_time, '14:00'); assert.equal(ex.end_time, '16:00');
});
expect('部分請假 14–16 → 移除 14:00/15:00、保留 13:00/16:00、共 7', () => {
  const s = slots();
  assert.ok(!s.includes(`${date}T14:00:00`));
  assert.ok(!s.includes(`${date}T15:00:00`));
  assert.ok(s.includes(`${date}T13:00:00`));
  assert.ok(s.includes(`${date}T16:00:00`));
  assert.equal(s.length, 7);
});

// 整天請假（無時段）
db.prepare('DELETE FROM coach_availability_exceptions WHERE coach_id=?').run(coachId);
addException({ coachId, exceptionDate: date, type: 'leave' });
expect('整天請假：start_time=null', () => assert.equal(db.prepare('SELECT start_time FROM coach_availability_exceptions WHERE coach_id=?').get(coachId).start_time, null));
expect('整天請假 → 當天 0 個 slot', () => assert.equal(slots().length, 0));

// 部分請假 start>=end → 擋下
db.prepare('DELETE FROM coach_availability_exceptions WHERE coach_id=?').run(coachId);
expect('部分請假 start>=end → throw invalid_time', () => assert.throws(() => addException({ coachId, exceptionDate: date, type: 'leave', startTime: '16:00', endTime: '14:00' }), /invalid_time/));

// 加開仍要求時段
expect('加開缺時段 → throw missing_time', () => assert.throws(() => addException({ coachId, exceptionDate: date, type: 'extra' }), /missing_time/));

db.exec("DELETE FROM users WHERE email='avl-coach@x.com'");
console.log('[availability-leave test] done');
