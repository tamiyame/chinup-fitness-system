// 本月 LINE 推播額度：重置時間推算（純函式）、mock client、狀態組裝三種結果。
import assert from 'node:assert/strict';
import { nextQuotaResetLocal, getLineQuotaStatus } from '../src/services/lineQuota.js';
import { getQuota, getQuotaConsumption } from '../src/services/lineClient.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[line-quota test] start');

// ── nextQuotaResetLocal：當月最後一天 23:00；已過則下個月 ──
for (const [input, expected] of [
  ['2026-09-08T14:00:00', '2026-09-30T23:00:00'],
  ['2026-09-30T22:59:59', '2026-09-30T23:00:00'],
  ['2026-09-30T23:00:00', '2026-10-31T23:00:00'],
  ['2026-12-31T23:00:00', '2027-01-31T23:00:00'],
  ['2028-02-10T00:00:00', '2028-02-29T23:00:00'],
]) {
  expect(`nextQuotaResetLocal(${input}) → ${expected}`, () => assert.equal(nextQuotaResetLocal(input), expected));
}

// ── mock client ──
process.env.LINE_MOCK = '1';
const q1 = await getQuota();
const c1 = await getQuotaConsumption();
expect('LINE_MOCK=1：getQuota 回 limited 200、getQuotaConsumption 回 0', () => {
  assert.deepEqual(q1, { ok: true, data: { type: 'limited', value: 200 } });
  assert.deepEqual(c1, { ok: true, data: { totalUsage: 0 } });
});

// ── 狀態組裝 ──
const s1 = await getLineQuotaStatus();
expect('mock 1：configured、limited 200、used 0、remaining 200、pct 100、resetAt 為 23:00:00', () => {
  assert.equal(s1.configured, true);
  assert.equal(s1.limitType, 'limited');
  assert.equal(s1.limit, 200);
  assert.equal(s1.used, 0);
  assert.equal(s1.remaining, 200);
  assert.equal(s1.pct, 100);
  assert.equal(s1.error, null);
  assert.match(s1.resetAt, /^\d{4}-\d{2}-\d{2}T23:00:00$/);
  assert.match(s1.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

process.env.LINE_MOCK = 'fail';
const s2 = await getLineQuotaStatus();
expect('mock fail：configured 但 error=mock_fail、數字全 null', () => {
  assert.equal(s2.configured, true);
  assert.equal(s2.error, 'mock_fail');
  for (const k of ['limitType', 'limit', 'used', 'remaining', 'pct']) assert.equal(s2[k], null, k);
  assert.match(s2.resetAt, /T23:00:00$/);
});

delete process.env.LINE_MOCK;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
const s3 = await getLineQuotaStatus();
expect('未設定 token：configured=false、error=null', () => {
  assert.equal(s3.configured, false);
  assert.equal(s3.error, null);
  assert.equal(s3.limit, null);
});

console.log('[line-quota test] done');
