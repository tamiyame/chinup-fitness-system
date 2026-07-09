// 駐場打卡 migration：新表/新欄存在、重跑冪等。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { SCHEMA } = await import('../src/db/schema.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[shift-migration test] start');

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

expect('coach_shifts 表存在且欄位齊全', () => {
  const c = cols('coach_shifts');
  for (const k of ['id','coach_id','day_of_week','start_time','end_time','effective_from','effective_to','created_at']) assert.ok(c.includes(k), k);
});
expect('shift_attendance 表存在且欄位齊全', () => {
  const c = cols('shift_attendance');
  for (const k of ['id','coach_id','shift_id','work_date','start_time','end_time','hours','source',
    'checked_in_at','lat','lng','accuracy','distance_m','created_by','voided_at','voided_by','note','created_at']) assert.ok(c.includes(k), k);
});
expect('coaches.hourly_rate 欄位存在', () => assert.ok(cols('coaches').includes('hourly_rate')));
expect('SCHEMA 重跑冪等（不丟錯）', () => db.exec(SCHEMA));
expect('UNIQUE(coach_id, work_date, shift_id) 存在', () => {
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shift_attendance'").get();
  assert.match(idx.sql, /UNIQUE\s*\(\s*coach_id\s*,\s*work_date\s*,\s*shift_id\s*\)/i);
});
console.log('[shift-migration test] done');
