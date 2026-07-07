// gcalSync 教練配色：非管理者教練石墨灰（colorId '8'）＋既有未來事件一次性補色（reconcile）。
process.env.GCAL_MOCK = '1';
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { getSetting, setSetting } = await import('../src/services/discountService.js');
const { eventIdForBooking, buildEventBody, reconcile } = await import('../src/services/gcalSync.js');
const { __mockCalls, __mockUpdateQueue } = await import('../src/services/gcalClient.js');

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
setSetting('gcal_color_backfill_past_done', ''); // 防呆：上次若中斷殘留（沿用既有 flag 清理風格）

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
// 本區塊（案例 3/4）只測「未來」補色；過去補色（本次新功能）改在下方獨立案例測試。這裡先把過去補色
// 標記為「已完成」以隔離兩者，避免 pastFix（非管理者／過去／有 event_id）被過去補色一併撈走，
// 干擾本區塊既有斷言（「非管理者過去事件不補色」）。
setSetting('gcal_color_backfill_past_done', '1');
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

// ── 案例 5：一次性補色「過去」（pastColorBackfillOnce；業主 2026-07-07 要求，PR #90 只補了未來） ──
// 案例 3 的 pastFix（非管理者、過去、有 event_id）此刻也會被過去補色的查詢撈到；為了讓本區塊
// 「恰 2 筆」的斷言精確可控，先刪掉它、不列入本區塊觀察對象（案例 3 對它的斷言在上面已跑完，
// 此時刪除不影響前面已成立的結果）。
db.prepare('DELETE FROM bookings WHERE id = ?').run(pastFix);

const pastA = mkBooking(coachId, '2021-05-01T09:00:00', true);          // 非管理者、過去、有 event_id → 應補色
const pastB = mkBooking(coachId, '2021-05-01T10:00:00', true);          // 同上
const adminPast = mkBooking(adminCoachId, '2021-05-01T09:00:00', true); // 管理者、過去、有 event_id → 不應補色
const cancelledPast = mkBooking(coachId, '2021-05-01T11:00:00', true);  // 非管理者、過去、有 event_id，但已取消 → 不應補色
db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(cancelledPast);
// （cancelledPast 會被既有、與本次改動無關的 selToDelete 揀去呼叫 deleteEvent 並清空其 event_id——
//  屬預期的無關 side effect，不影響本區塊對 updateEvent／insertEvent 的斷言。）
const nullEventPast = mkBooking(coachId, '2021-05-01T12:00:00');        // 非管理者、過去、event_id NULL → 不應補色（也不會被既有 selToCreate 撿去，因為已是過去時段）

setSetting('gcal_color_backfill_past_done', ''); // 確保本輪會真的跑過去補色（清 flag）
__mockUpdateQueue.length = 0;                       // 防呆：先清空佇列再注入（佇列會被其他案例消耗）
__mockUpdateQueue.push({ ok: false, status: 404 }); // 讓過去補色第一筆（id 較小的 pastA）模擬 404（曾被手動刪）
reset();
await expectA('reconcile：跑一次性過去補色（不拋錯，即使中途 404）', async () => { await reconcile(); });

expect('過去補色：恰 2 筆 updateEvent，且都帶石墨灰 colorId（PUT 出去的 body 本就帶 colorId，與回應是否 404 無關）', () => {
  const upd = callsOf('updateEvent');
  assert.equal(upd.length, 2);
  assert.deepEqual(upd.map((c) => c.args.eventId).sort(), [eventIdForBooking(pastA), eventIdForBooking(pastB)].sort());
  for (const c of upd) assert.equal(c.args.event.colorId, '8');
});

expect('過去補色：第一筆 404（曾被手動刪）→ 直接跳過不重建，全程無 insertEvent 呼叫', () => {
  assert.equal(callsOf('insertEvent').length, 0);
});

expect('過去補色：404 那筆 gcal_event_id 維持不變（不清欄位，避免之後被誤判成需要復活歷史事件）', () => {
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(pastA).gcal_event_id, eventIdForBooking(pastA));
});

expect('過去補色：非 404 的第二筆（pastB）照常補色，gcal_event_id 同樣不變（過去補色從不寫回這欄，只 PUT 外觀）', () => {
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(pastB).gcal_event_id, eventIdForBooking(pastB));
});

expect('過去補色：管理者過去事件不補色（未出現在 updateEvent／insertEvent 呼叫名單）', () => {
  const touched = [...callsOf('updateEvent'), ...callsOf('insertEvent')].some(
    (c) => (c.args.eventId || c.args.event?.id) === eventIdForBooking(adminPast)
  );
  assert.equal(touched, false);
});

expect('過去補色：已取消的過去事件不補色（status 濾除，未出現在 updateEvent 呼叫名單）', () => {
  assert.equal(callsOf('updateEvent').some((c) => c.args.eventId === eventIdForBooking(cancelledPast)), false);
});

expect('過去補色：event_id 為 NULL 的過去事件不補色（也不會被既有 selToCreate 撿去，因為已是過去時段）', () => {
  const touched = [...callsOf('updateEvent'), ...callsOf('insertEvent')].some(
    (c) => (c.args.eventId || c.args.event?.id) === eventIdForBooking(nullEventPast)
  );
  assert.equal(touched, false);
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(nullEventPast).gcal_event_id, null);
});

expect('過去補色：跑完（即使中途 404）仍設定 past-backfill flag（下次不再重跑）', () => {
  assert.equal(getSetting('gcal_color_backfill_past_done'), '1');
});

// ── 案例 6：過去補色 flag 已設 → 再跑一次 reconcile 應為冪等，不再新增 updateEvent ──
__mockUpdateQueue.length = 0;
reset();
await expectA('reconcile：過去補色 flag 已設後再次呼叫（冪等，不拋錯）', async () => { await reconcile(); });
expect('reconcile：過去補色 flag 已設 → 新增 updateEvent 呼叫數為 0（冪等）', () => {
  assert.equal(callsOf('updateEvent').length, 0);
});

// ── 還原（這份 app.db 是長期共用 dev DB：flag／calendar id 設定與本檔建立的 gc-% 資料都要清乾淨）──
setSetting('gcal_color_backfill_done', '');
setSetting('gcal_color_backfill_past_done', '');
setSetting('gcal_calendar_id', origCalId);
cleanupFixtures();
console.log('[gcal-coach-color test] done');
