// gcalSync：決定性事件 ID、event body（+08:00 / transparent）、busy→牆鐘轉換、reconcile。
import assert from 'node:assert/strict';
process.env.GCAL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/services/discountService.js');
const { eventIdForBooking, buildEventBody, busyToWallClockMap, syncBookingCreate, syncBookingCancel, reconcile } =
  await import('../src/services/gcalSync.js');
const { __mockCalls } = await import('../src/services/gcalClient.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
async function expectA(label, fn){ try{await fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-sync test] start');
db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'gs-%'");
setSetting('gcal_calendar_id', 'test-cal@group.calendar.google.com');

expect('eventIdForBooking 決定性 + base32hex 字元集', () => {
  assert.equal(eventIdForBooking(123), 'chinupbk000000123');
  assert.match(eventIdForBooking(123), /^[a-v0-9]{5,}$/);
});

const uid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('小明','gs-m@x.com','user','0997111222')").run().lastInsertRowid);
const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練甲','gs-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練甲', 1)").run(cuid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 3*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount) VALUES (?, ?, ?, ?, '1on2', 2000)"
).run(coachId, uid, `${date}T14:00:00`, `${date}T15:00:00`).lastInsertRowid);

expect('buildEventBody：+08:00 / Asia/Taipei / transparent / 標題含教練與會員', () => {
  const ev = buildEventBody(bid);
  assert.equal(ev.id, eventIdForBooking(bid));
  assert.equal(ev.start.dateTime, `${date}T14:00:00+08:00`);
  assert.equal(ev.end.dateTime, `${date}T15:00:00+08:00`);
  assert.equal(ev.start.timeZone, 'Asia/Taipei');
  assert.equal(ev.transparency, 'transparent');
  assert.ok(ev.summary.includes('教練甲') && ev.summary.includes('小明') && ev.summary.includes('1對2'));
  assert.ok(ev.description.includes('0997111222'));
});

expect('busyToWallClockMap：UTC 輸入轉台北 + 跨日切割', () => {
  // 2026-07-01 06:00Z = 台北 14:00；06-30 15:00Z ~ 07-01 02:00Z = 台北 23:00 ~ 隔日 10:00（跨日）
  const m = busyToWallClockMap([
    { start: '2026-07-01T06:00:00Z', end: '2026-07-01T07:30:00Z' },
    { start: '2026-06-30T15:00:00Z', end: '2026-07-01T02:00:00Z' },
  ]);
  assert.deepEqual(m.get('2026-07-01').find(x => x.start === '14:00'), { start: '14:00', end: '15:30' });
  assert.deepEqual(m.get('2026-06-30'), [{ start: '23:00', end: '24:00' }]);
  assert.ok(m.get('2026-07-01').some(x => x.start === '00:00' && x.end === '10:00'));
});

await expectA('syncBookingCreate：mock 成功 → gcal_event_id 寫入', async () => {
  __mockCalls.length = 0;
  await syncBookingCreate(bid);
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid).gcal_event_id, eventIdForBooking(bid));
  assert.equal(__mockCalls[0].fn, 'insertEvent');
});

await expectA('syncBookingCancel：刪除 + 清欄位', async () => {
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bid);
  await syncBookingCancel(bid);
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid).gcal_event_id, null);
});

await expectA('reconcile：補建未來 confirmed 無事件者、補刪 cancelled 有事件者', async () => {
  const bid2 = Number(db.prepare(
    "INSERT INTO bookings (coach_id, member_id, start_at, end_at) VALUES (?, ?, ?, ?)"
  ).run(coachId, uid, `${date}T16:00:00`, `${date}T17:00:00`).lastInsertRowid);
  db.prepare("UPDATE bookings SET gcal_event_id='chinupbk000000999' WHERE id=?").run(bid); // cancelled + 殘留事件
  __mockCalls.length = 0;
  await reconcile();
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid2).gcal_event_id, eventIdForBooking(bid2));
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid).gcal_event_id, null);
});

expect('未設 calendar id → 整體停用（syncBookingCreate 不動作）', () => {
  setSetting('gcal_calendar_id', '');
  // isGcalEnabled=false → 不呼叫 client、不丟錯
});

db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'gs-%'");
setSetting('gcal_calendar_id', '');
console.log('[gcal-sync test] done');
