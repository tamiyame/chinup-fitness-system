// 期別純函式：固定日曆雙月、開放下期日期規則、本週週一。不碰 DB。
import assert from 'node:assert/strict';
import { periodOf, nextPeriod, weekStartMonday, periodOpenDate, targetEndFor, periodLabel } from '../src/services/period.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
console.log('[period-service test] start');

expect('periodOf 2026-08-25 → 7/1~8/31', () => assert.deepEqual(periodOf('2026-08-25'), { start: '2026-07-01', end: '2026-08-31' }));
expect('periodOf 2026-09-01 → 9/1~10/31', () => assert.deepEqual(periodOf('2026-09-01'), { start: '2026-09-01', end: '2026-10-31' }));
expect('periodOf 2027-01-15 → 1/1~2/28', () => assert.deepEqual(periodOf('2027-01-15'), { start: '2027-01-01', end: '2027-02-28' }));
expect('periodOf 閏年 2028-02-10 → end 2/29', () => assert.equal(periodOf('2028-02-10').end, '2028-02-29'));
expect('periodOf 12/31 → 11/1~12/31', () => assert.deepEqual(periodOf('2026-12-31'), { start: '2026-11-01', end: '2026-12-31' }));

expect('nextPeriod 7–8 → 9–10', () => assert.deepEqual(nextPeriod({ start: '2026-07-01', end: '2026-08-31' }), { start: '2026-09-01', end: '2026-10-31' }));
expect('nextPeriod 11–12 → 隔年 1–2', () => assert.deepEqual(nextPeriod({ start: '2026-11-01', end: '2026-12-31' }), { start: '2027-01-01', end: '2027-02-28' }));

expect('weekStartMonday 週二 2026-08-25 → 08-24', () => assert.equal(weekStartMonday('2026-08-25'), '2026-08-24'));
expect('weekStartMonday 週一 → 自身', () => assert.equal(weekStartMonday('2026-08-24'), '2026-08-24'));
expect('weekStartMonday 週日 2026-08-30 → 08-24', () => assert.equal(weekStartMonday('2026-08-30'), '2026-08-24'));

const open = (ymd) => periodOpenDate(periodOf(ymd));
expect('periodOpenDate 2026-08 → 08-24（錨點 8/24 即週一）', () => assert.equal(open('2026-08-01'), '2026-08-24'));
expect('periodOpenDate 2026-10 → 10-19（錨點 10/24 週六往前）', () => assert.equal(open('2026-10-01'), '2026-10-19'));
expect('periodOpenDate 2026-12 → 12-21（錨點 12/24 週四往前）', () => assert.equal(open('2026-12-01'), '2026-12-21'));
expect('periodOpenDate 2027-02 → 02-15（錨點 2/21 週日往前）', () => assert.equal(open('2027-02-01'), '2027-02-15'));
expect('periodOpenDate 2027-04 → 04-19', () => assert.equal(open('2027-04-01'), '2027-04-19'));
expect('periodOpenDate 2027-06 → 06-21', () => assert.equal(open('2027-06-01'), '2027-06-21'));

expect('targetEndFor 8/23 → 本期末 8/31', () => assert.equal(targetEndFor('2026-08-23'), '2026-08-31'));
expect('targetEndFor 8/24 → 下期末 10/31', () => assert.equal(targetEndFor('2026-08-24'), '2026-10-31'));
expect('targetEndFor 8/31 → 10/31', () => assert.equal(targetEndFor('2026-08-31'), '2026-10-31'));
expect('targetEndFor 9/1（期中）→ 10/31', () => assert.equal(targetEndFor('2026-09-01'), '2026-10-31'));
expect('targetEndFor 12/21 → 隔年 2/28', () => assert.equal(targetEndFor('2026-12-21'), '2027-02-28'));

expect('periodLabel 9–10 月', () => assert.equal(periodLabel({ start: '2026-09-01', end: '2026-10-31' }), '9–10 月'));
expect('periodLabel 11–12 月', () => assert.equal(periodLabel({ start: '2026-11-01', end: '2026-12-31' }), '11–12 月'));

console.log('[period-service test] done');
