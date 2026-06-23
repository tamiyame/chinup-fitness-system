// expandRecurrence 純函式：每天/週/月/年、自訂間隔、週幾、結束(count/date)、no_date、上限。
import assert from 'node:assert/strict';
const { expandRecurrence } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[recurrence-expand test] start');
const days = (arr) => arr.map(o => o.startAt);

expect('daily count=3', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-02T10:00:00','2026-07-03T10:00:00']);
});
expect('daily interval=2 count=3', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', interval:2, end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-03T10:00:00','2026-07-05T10:00:00']);
});
expect('weekly count=3（同星期）', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'weekly', end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-08T10:00:00','2026-07-15T10:00:00']);
});
expect('weekly byWeekday 一三五（2026-07-01 為週三）count=4', () => {
  // 1=一,3=三,5=五；自起始日當週起，每週的 一三五（>=起始日）
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'weekly', byWeekday:[1,3,5], end:{type:'count',count:4} });
  // 2026-07-01(三),07-03(五),07-06(一),07-08(三)
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-03T10:00:00','2026-07-06T10:00:00','2026-07-08T10:00:00']);
});
expect('weekly byWeekday interval=2（每兩週一三五）', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'weekly', interval:2, byWeekday:[1,3,5], end:{type:'count',count:4} });
  // 第0週(07/01三起):07-01,07-03 → 跳過第1週 → 第2週(07/13一起):07-13,07-15
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-03T10:00:00','2026-07-13T10:00:00','2026-07-15T10:00:00']);
});
expect('monthly count=3（同日）', () => {
  const o = expandRecurrence({ startAt:'2026-01-15T09:00:00', frequency:'monthly', end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-01-15T09:00:00','2026-02-15T09:00:00','2026-03-15T09:00:00']);
});
expect('monthly 31 日 → 2/4/6 月 no_date', () => {
  const o = expandRecurrence({ startAt:'2026-01-31T09:00:00', frequency:'monthly', end:{type:'count',count:3} });
  assert.equal(o[0].reason, undefined);
  assert.equal(o[1].reason, 'no_date'); // 2026-02-31 不存在
});
expect('yearly count=2', () => {
  const o = expandRecurrence({ startAt:'2026-03-01T09:00:00', frequency:'yearly', end:{type:'count',count:2} });
  assert.deepEqual(days(o), ['2026-03-01T09:00:00','2027-03-01T09:00:00']);
});
expect('yearly 2/29 閏年 → 平年 no_date', () => {
  const o = expandRecurrence({ startAt:'2028-02-29T09:00:00', frequency:'yearly', end:{type:'count',count:2} });
  assert.equal(o[1].reason, 'no_date'); // 2029-02-29 不存在
});
expect('end=date（含當日）', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'date',date:'2026-07-03'} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-02T10:00:00','2026-07-03T10:00:00']);
});
expect('驗證：頻率錯/間隔錯/end 錯/count 越界', () => {
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'x', end:{type:'count',count:2} }), /invalid_frequency/);
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', interval:0, end:{type:'count',count:2} }), /invalid_interval/);
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'count',count:0} }), /invalid_count/);
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'bad'} }), /invalid_end/);
  assert.throws(() => expandRecurrence({ startAt:'bad', frequency:'daily', end:{type:'count',count:2} }), /invalid_start_at/);
});
console.log('[recurrence-expand test] done');
