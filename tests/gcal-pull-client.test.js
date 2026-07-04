// gcalClient 反向同步擴充：mock 佇列語意、呼叫紀錄。
process.env.GCAL_MOCK = '1';
import assert from 'node:assert/strict';
const { listEvents, updateEvent, __mockCalls, __mockListQueue } = await import('../src/services/gcalClient.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-pull-client test] start');

__mockCalls.length = 0;
__mockListQueue.push({ ok: true, items: [{ id: 'x1' }], nextPageToken: 'p2', nextSyncToken: null });
__mockListQueue.push({ ok: false, status: 410, error: 'gone' });

const r1 = await listEvents('cal-a', { timeMin: 't0', showDeleted: 'true' });
expect('佇列依序 shift（第一筆）', () => {
  assert.equal(r1.ok, true);
  assert.equal(r1.items[0].id, 'x1');
  assert.equal(r1.nextPageToken, 'p2');
});
const r2 = await listEvents('cal-a', { pageToken: 'p2' });
expect('佇列依序 shift（410）', () => { assert.equal(r2.ok, false); assert.equal(r2.status, 410); });
const r3 = await listEvents('cal-a', { syncToken: 'tk' });
expect('空佇列 → 預設空頁 + mock-token', () => {
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.items, []);
  assert.equal(r3.nextSyncToken, 'mock-token');
});
const u1 = await updateEvent('cal-a', 'chinupbk000000001', { summary: 's' });
expect('updateEvent mock ok', () => assert.equal(u1.ok, true));
expect('__mockCalls 記錄 fn 與參數', () => {
  const fns = __mockCalls.map((c) => c.fn);
  assert.deepEqual(fns, ['listEvents', 'listEvents', 'listEvents', 'updateEvent']);
  assert.equal(__mockCalls[0].args.params.timeMin, 't0');
  assert.equal(__mockCalls[3].args.eventId, 'chinupbk000000001');
});
console.log('[gcal-pull-client test] done');
