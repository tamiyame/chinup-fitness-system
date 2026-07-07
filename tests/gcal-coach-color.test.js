// gcalSync 教練配色：非管理者教練石墨灰（colorId '8'）＋既有未來事件一次性補色（reconcile）。
process.env.GCAL_MOCK = '1';
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { getSetting, setSetting } = await import('../src/services/discountService.js');
const { eventIdForBooking, buildEventBody, reconcile } = await import('../src/services/gcalSync.js');
const { __mockCalls } = await import('../src/services/gcalClient.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
async function expectA(label, fn){ try{await fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-coach-color test] start');

const CAL = 'gc-test-cal';
const origCalId = getSetting('gcal_calendar_id') || ''; // 收尾還原，這份 app.db 是長期共用 dev DB
const callsOf = (fn) => __mockCalls.filter((c) => c.fn === fn);
const reset = () => { __mockCalls.length = 0; };

// ── 清理（開頭防呆：上次若中斷殘留）＋ 設定 ──
function cleanupFixtures() {
  db.exec(`
    DELETE FROM bookings WHERE coach_id IN (SELECT c.id FROM coaches c JOIN users u ON u.id = c.user_id WHERE u.email LIKE 'gc-%');
    DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gc-%');
    DELETE FROM users WHERE email LIKE 'gc-%';
  `);
}
cleanupFixtures();
setSetting('gcal_calendar_id', CAL);
setSetting('gcal_color_backfill_done', '');

// startAt 格式 'YYYY-MM-DDTHH:MM:SS'，本檔固定用到的時數（09~12）不跨日，簡單 +1 小時即可。
function plusHour(startAt) {
  const hh = Number(startAt.slice(11, 13));
  return startAt.slice(0, 11) + String(hh + 1).padStart(2, '0') + startAt.slice(13);
}

// ── fixtures：一個非管理者教練、一個管理者教練、一個客人 ──
const coachUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('GC教練','gc-c@x.com','coach',0)").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?,'GC教練',1)").run(coachUid).lastInsertRowid);
const adminUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('GC管理者','gc-a@x.com','coach',1)").run().lastInsertRowid);
const adminCoachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?,'GC管理者',1)").run(adminUid).lastInsertRowid);
const memberId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('GC客人','gc-m@x.com','user')").run().lastInsertRowid);

function mkBooking(coachIdArg, startAt, withEvent = false) {
  const endAt = plusHour(startAt);
  const id = Number(db.prepare(`
    INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount)
    VALUES (?, ?, ?, ?, '1on1', 1000)
  `).run(coachIdArg, memberId, startAt, endAt).lastInsertRowid);
  if (withEvent) db.prepare('UPDATE bookings SET gcal_event_id = ? WHERE id = ?').run(eventIdForBooking(id), id);
  return id;
}

// ── 案例 1／2：buildEventBody 配色 ──
const bNonAdmin = mkBooking(coachId, '2035-08-03T09:00:00');
expect('非管理者教練 booking → buildEventBody.colorId 為石墨灰 8', () => {
  assert.equal(buildEventBody(bNonAdmin).colorId, '8');
});

const bAdmin = mkBooking(adminCoachId, '2035-08-03T10:00:00');
expect('管理者教練 booking → body 不帶 colorId（沿用日曆預設色）', () => {
  assert.equal('colorId' in buildEventBody(bAdmin), false);
});

// ── 案例 3：一次性補色（reconcile） ──
const futA = mkBooking(coachId, '2035-08-01T10:00:00', true);          // 非管理者、未來、有 event_id → 應補色
const futB = mkBooking(coachId, '2035-08-01T11:00:00', true);          // 同上
const adminFut = mkBooking(adminCoachId, '2035-08-01T10:00:00', true); // 管理者、未來、有 event_id → 不應補色
const pastFix = mkBooking(coachId, '2020-01-01T10:00:00', true);       // 非管理者、過去、有 event_id → 不應補色（日期濾除）
const futNullEvent = mkBooking(coachId, '2035-08-01T12:00:00');        // 非管理者、未來、event_id NULL → 被既有 selToCreate 撿去 insertEvent（非補色路徑，但預期發生，見下方說明）

setSetting('gcal_color_backfill_done', ''); // 確保本輪會真的跑補色（清 flag）
reset();
await expectA('reconcile：跑一次性補色（不拋錯）', async () => { await reconcile(); });

expect('reconcile 補色：恰 2 筆 updateEvent，且都帶石墨灰 colorId（僅限「非管理者＋未來＋已有 event_id」）', () => {
  const upd = callsOf('updateEvent');
  assert.equal(upd.length, 2);
  assert.deepEqual(upd.map((c) => c.args.eventId).sort(), [eventIdForBooking(futA), eventIdForBooking(futB)].sort());
  for (const c of upd) assert.equal(c.args.event.colorId, '8');
});

// 注意：reconcile 既有的 selToCreate 會把「confirmed 且 event_id NULL 且未來」的堂撿去 insertEvent——
// futNullEvent 屬於這種情況，觸發 insertEvent 屬預期（非本次補色新加的邏輯），故與 updateEvent 分開斷言。
expect('reconcile：event_id NULL 的未來非管理者堂由既有 selToCreate 撿去 insertEvent，colorId 依然正確帶入', () => {
  const ins = callsOf('insertEvent').find((c) => c.args.event.id === eventIdForBooking(futNullEvent));
  assert.ok(ins, 'insertEvent 應被呼叫於 futNullEvent');
  assert.equal(ins.args.event.colorId, '8');
  assert.equal(
    db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(futNullEvent).gcal_event_id,
    eventIdForBooking(futNullEvent)
  );
});

expect('reconcile 補色：管理者未來事件不補色（未出現在 updateEvent／insertEvent 呼叫名單）', () => {
  const touched = [...callsOf('updateEvent'), ...callsOf('insertEvent')].some(
    (c) => (c.args.eventId || c.args.event?.id) === eventIdForBooking(adminFut)
  );
  assert.equal(touched, false);
});

expect('reconcile 補色：非管理者過去事件不補色（日期濾除，未出現在 updateEvent 呼叫名單）', () => {
  assert.equal(callsOf('updateEvent').some((c) => c.args.eventId === eventIdForBooking(pastFix)), false);
});

expect('reconcile 補色：跑完設定 backfill flag（下次不再重跑）', () => {
  assert.equal(getSetting('gcal_color_backfill_done'), '1');
});

// ── 案例 4：flag 已設 → 再跑一次 reconcile 應為冪等，不再新增 updateEvent ──
reset();
await expectA('reconcile：flag 已設後再次呼叫（冪等，不拋錯）', async () => { await reconcile(); });
expect('reconcile：flag 已設 → 新增 updateEvent 呼叫數為 0（冪等）', () => {
  assert.equal(callsOf('updateEvent').length, 0);
});

// ── 還原（這份 app.db 是長期共用 dev DB：flag／calendar id 設定與本檔建立的 gc-% 資料都要清乾淨）──
setSetting('gcal_color_backfill_done', '');
setSetting('gcal_calendar_id', origCalId);
cleanupFixtures();
console.log('[gcal-coach-color test] done');
