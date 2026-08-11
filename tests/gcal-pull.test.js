// gcal 反向同步：分類器矩陣（回聲/套用/退回四因/全天/過去堂連動/刪除取消/復原再刪/忽略）＋ token 泵。
process.env.GCAL_MOCK = '1';
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { setSetting, getSetting } = await import('../src/services/discountService.js');
const { __mockCalls, __mockListQueue, __mockUpdateQueue } = await import('../src/services/gcalClient.js');
const { processEvent, pullChanges } = await import('../src/services/gcalPull.js');
const { eventIdForBooking, syncBookingUpdate } = await import('../src/services/gcalSync.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const CAL = 'gp-test-cal';
console.log('[gcal-pull test] start');
const origCalId = getSetting('gcal_calendar_id') || ''; // 收尾要還原，這份 app.db 是長期共用 dev DB

// ── 清理＋建資料 ──
db.exec(`
  DELETE FROM notifications WHERE type IN ('gcal_move_rejected','gcal_delete_cancelled');
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM bookings WHERE start_at LIKE '2032-%' OR start_at LIKE '2020-%';
  DELETE FROM discount_redemptions WHERE kind='booking' AND ref_id NOT IN (SELECT id FROM bookings);
  DELETE FROM discount_codes WHERE code='GPDEL';
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM users WHERE email LIKE 'gp-%';
`);
setSetting('gcal_calendar_id', CAL);

const coachUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('GP教練','gp-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?,'GP教練',1)").run(coachUid).lastInsertRowid);
const memberId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('GP客人','gp-m@x.com','user')").run().lastInsertRowid);
const gpAdminUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('GP管理','gp-a@x.com','coach',1)").run().lastInsertRowid);
const pkgId = Number(db.prepare("INSERT INTO customer_packages (member_id,session_type,total_sessions,remaining_sessions,amount) VALUES (?,'1on1',10,4,10000)").run(memberId).lastInsertRowid);

const mkBooking = (startAt, { status = 'confirmed', pkg = null } = {}) => {
  const end = startAt.slice(0, 11) + String(Number(startAt.slice(11, 13)) + 1).padStart(2, '0') + startAt.slice(13);
  const id = Number(db.prepare(`INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,original_amount,package_id)
    VALUES (?,?,?,?,?,'1on1',1000,?)`).run(coachId, memberId, startAt, end, status, pkg).lastInsertRowid);
  db.prepare('UPDATE bookings SET gcal_event_id=? WHERE id=?').run(eventIdForBooking(id), id);
  return id;
};
const getB = (id) => db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
const evOf = (id, startIso, endIso, status = 'confirmed') =>
  ({ id: eventIdForBooking(id), status, start: { dateTime: startIso }, end: { dateTime: endIso } });
const callsOf = (fn) => __mockCalls.filter((c) => c.fn === fn);
const notifCount = (type, userId = null) => db.prepare(
  `SELECT COUNT(*) c FROM notifications WHERE type=? ${userId ? 'AND user_id=?' : ''}`
).get(...(userId ? [type, userId] : [type])).c;
const reset = () => { __mockCalls.length = 0; __mockListQueue.length = 0; __mockUpdateQueue.length = 0; };

// ── 分類器 ──
reset();
await processEvent({ id: 'someone-elses-event', status: 'confirmed' }, CAL);
await processEvent(evOf(999999999, '2032-03-01T10:00:00+08:00', '2032-03-01T11:00:00+08:00'), CAL);
expect('非系統事件／查無預約 → 忽略（零 API 呼叫）', () => assert.equal(__mockCalls.length, 0));

const bEcho = mkBooking('2032-03-01T10:00:00');
reset();
await processEvent(evOf(bEcho, '2032-03-01T10:00:00+08:00', '2032-03-01T11:00:00+08:00'), CAL);
expect('回聲（事件==DB）→ no-op', () => {
  assert.equal(__mockCalls.length, 0);
  assert.equal(getB(bEcho).start_at, '2032-03-01T10:00:00');
});

reset();
await processEvent(evOf(bEcho, '2032-03-02T14:00:00+08:00', '2032-03-02T15:00:00+08:00'), CAL);
expect('合法移動 → 套用改時段＋客人收 booking_rescheduled、不 updateEvent', () => {
  const b = getB(bEcho);
  assert.equal(b.start_at, '2032-03-02T14:00:00');
  assert.equal(b.end_at, '2032-03-02T15:00:00');
  assert.equal(callsOf('updateEvent').length, 0);
  assert.ok(notifCount('booking_rescheduled', memberId) >= 1);
});

// reschedule 後回聲守門：同一顆事件（新時間）再餵一次 processEvent，確保下一次輪詢不會
// 因時間字串格式差異誤判成「新的移動」而重複改期轟炸客人。
const rescheduledNotifsAfterMove = notifCount('booking_rescheduled', memberId);
reset();
await processEvent(evOf(bEcho, '2032-03-02T14:00:00+08:00', '2032-03-02T15:00:00+08:00'), CAL);
expect('reschedule 後回聲（同一顆事件再餵一次）→ 零 API 呼叫、通知不增加', () => {
  assert.equal(__mockCalls.length, 0);
  assert.equal(notifCount('booking_rescheduled', memberId), rescheduledNotifsAfterMove);
});

const bOther = mkBooking('2032-03-03T09:00:00');
reset();
await processEvent(evOf(bEcho, '2032-03-03T09:00:00+08:00', '2032-03-03T10:00:00+08:00'), CAL);
expect('撞課 → 退回（updateEvent 回 DB 時間）＋教練收退回通知（原因：時段衝突）', () => {
  assert.equal(getB(bEcho).start_at, '2032-03-02T14:00:00');   // 未被改
  const u = callsOf('updateEvent');
  assert.equal(u.length, 1);
  assert.equal(u[0].args.event.start.dateTime, '2032-03-02T14:00:00+08:00');
  assert.equal(notifCount('gcal_move_rejected', coachUid), 1);
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('時段衝突'));
});

reset();
await processEvent(evOf(bEcho, '2032-03-05T10:30:00+08:00', '2032-03-05T11:30:00+08:00'), CAL);
expect('非整點 → 退回（原因：整點/60分）', () => {
  assert.equal(getB(bEcho).start_at, '2032-03-02T14:00:00');
  assert.equal(callsOf('updateEvent').length, 1);
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('整點'));
});

reset();
await processEvent(evOf(bEcho, '2032-03-05T10:00:00+08:00', '2032-03-05T11:30:00+08:00'), CAL);
expect('時長 90 分 → 退回', () => {
  assert.equal(getB(bEcho).start_at, '2032-03-02T14:00:00');
  assert.equal(callsOf('updateEvent').length, 1);
});

reset();
await processEvent(evOf(bEcho, '2020-01-01T10:00:00+08:00', '2020-01-01T11:00:00+08:00'), CAL);
expect('移到過去 → 退回（原因：不可移到過去）', () => {
  assert.equal(callsOf('updateEvent').length, 1);
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('不可移到過去'));
});

reset();
await processEvent({ id: eventIdForBooking(bEcho), status: 'confirmed', start: { date: '2032-03-05' }, end: { date: '2032-03-06' } }, CAL);
expect('全天事件 → 退回（格式不支援）', () => assert.equal(callsOf('updateEvent').length, 1));

// ── 過去堂連動（2026-08-12 規格翻轉：刪除→取消、移動→改期，與系統內操作同語意）──
const bPastMove = mkBooking('2020-06-01T10:00:00');
const rescheduledBeforePastMove = notifCount('booking_rescheduled', memberId);
reset();
await processEvent(evOf(bPastMove, '2020-06-02T10:00:00+08:00', '2020-06-02T11:00:00+08:00'), CAL);
expect('過去堂移動→過去合法時段 → 套用改期（修正歷史）＋客人通知、不 updateEvent', () => {
  const b = getB(bPastMove);
  assert.equal(b.start_at, '2020-06-02T10:00:00');
  assert.equal(b.end_at, '2020-06-02T11:00:00');
  assert.equal(callsOf('updateEvent').length, 0);
  assert.equal(notifCount('booking_rescheduled', memberId), rescheduledBeforePastMove + 1);
});

reset();
await processEvent(evOf(bPastMove, '2032-06-01T10:00:00+08:00', '2032-06-01T11:00:00+08:00'), CAL);
expect('過去堂移動→未來合法時段 → 套用改期（延期補課）', () => {
  assert.equal(getB(bPastMove).start_at, '2032-06-01T10:00:00');
  assert.equal(callsOf('updateEvent').length, 0);
});

const bPastBad = mkBooking('2020-07-01T10:00:00');
reset();
await processEvent(evOf(bPastBad, '2020-07-01T10:30:00+08:00', '2020-07-01T11:30:00+08:00'), CAL);
expect('過去堂移動→非整點 → 退回＋教練通知（DB 贏對過去堂也成立）', () => {
  assert.equal(getB(bPastBad).start_at, '2020-07-01T10:00:00');
  const u = callsOf('updateEvent');
  assert.equal(u.length, 1);
  assert.equal(u[0].args.event.start.dateTime, '2020-07-01T10:00:00+08:00');
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('整點'));
});

reset();
await processEvent({ id: eventIdForBooking(bPastBad), status: 'confirmed', start: { date: '2020-07-02' }, end: { date: '2020-07-03' } }, CAL);
expect('過去堂事件被改全天 → 退回', () => assert.equal(callsOf('updateEvent').length, 1));

const pkgPast = Number(db.prepare("INSERT INTO customer_packages (member_id,session_type,total_sessions,remaining_sessions,amount) VALUES (?,'1on1',10,4,10000)").run(memberId).lastInsertRowid);
const bPastDel = mkBooking('2020-08-01T10:00:00', { pkg: pkgPast });
const memberNotifsBeforePastDel = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c;
reset();
await processEvent({ id: eventIdForBooking(bPastDel), status: 'cancelled' }, CAL);
expect('過去堂刪除 → 取消＋回補＋清 event_id＋管理者通知、客人教練靜默', () => {
  const b = getB(bPastDel);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancel_reason, 'gcal_event_deleted');
  assert.equal(b.gcal_event_id, null);
  assert.equal(db.prepare('SELECT remaining_sessions r FROM customer_packages WHERE id=?').get(pkgPast).r, 5); // 4+1
  assert.equal(notifCount('gcal_delete_cancelled', gpAdminUid), 1); // 本案例是本檔第一次刪除事件，精確=1
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c, memberNotifsBeforePastDel); // 客人零新通知
  assert.equal(notifCount('gcal_delete_cancelled', coachUid), 0);   // 教練非管理者，不收
});

// 刪除未來堂（掛方案＋折扣 redemption）
const bDel = mkBooking('2032-04-01T10:00:00', { pkg: pkgId });
const codeId = Number(db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value) VALUES ('GPDEL','fixed',100)").run().lastInsertRowid);
db.prepare("INSERT INTO discount_redemptions (code_id,phone,kind,ref_id,amount) VALUES (?,'0900000000','booking',?,100)").run(codeId, bDel);
const memberNotifsBefore = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c;
let adminNotifsAfterDelete;
reset();
await processEvent({ id: eventIdForBooking(bDel), status: 'cancelled' }, CAL);
expect('刪除未來堂 → 取消＋回補＋釋放折扣＋清 event_id＋通知管理者、客人教練皆靜默', () => {
  const b = getB(bDel);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancel_reason, 'gcal_event_deleted');
  assert.equal(b.gcal_event_id, null);
  assert.equal(db.prepare('SELECT remaining_sessions r FROM customer_packages WHERE id=?').get(pkgId).r, 5); // 4+1
  assert.equal(db.prepare('SELECT COUNT(*) c FROM discount_redemptions WHERE kind=? AND ref_id=?').get('booking', bDel).c, 0);
  // 管理者通知筆數不鎖死為 1：共用 dev DB 累積了其他測試留下的 is_admin=1 帳號（非本測試污染，見報告）；
  // 用 >=1 確認「有發」，並記錄基準供下一步「重複刪除→無新通知」比對。
  adminNotifsAfterDelete = notifCount('gcal_delete_cancelled');
  assert.ok(adminNotifsAfterDelete >= 1);                                    // 管理者（至少含 seed admin）
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c, memberNotifsBefore); // 客人零新通知
  assert.equal(notifCount('gcal_delete_cancelled', coachUid), 0);            // 教練不在管理者名單
});
reset();
await processEvent({ id: eventIdForBooking(bDel), status: 'cancelled' }, CAL);
expect('重複刪除事件（回聲）→ no-op', () => { assert.equal(__mockCalls.length, 0); assert.equal(notifCount('gcal_delete_cancelled'), adminNotifsAfterDelete); });

reset();
await processEvent(evOf(bDel, '2032-04-01T10:00:00+08:00', '2032-04-01T11:00:00+08:00'), CAL);
expect('已取消預約的事件被復原 → DB 贏，deleteEvent 再刪', () => assert.equal(callsOf('deleteEvent').length, 1));

// ── syncBookingUpdate（Important 1 修復：改期/改派單一 PUT 原子刷新，避免「刪→建」窗口被 pull 誤判為刪除） ──
const bUpd = mkBooking('2032-05-01T10:00:00');
reset();
await syncBookingUpdate(bUpd);
expect('syncBookingUpdate 成功 → 單一 updateEvent（無 delete/insert）、事件時間與 DB 一致、gcal_event_id 維持', () => {
  assert.equal(__mockCalls.length, 1);
  assert.equal(callsOf('updateEvent').length, 1);
  assert.equal(callsOf('deleteEvent').length, 0);
  assert.equal(callsOf('insertEvent').length, 0);
  assert.equal(callsOf('updateEvent')[0].args.event.start.dateTime, getB(bUpd).start_at + '+08:00');
  assert.equal(getB(bUpd).gcal_event_id, eventIdForBooking(bUpd));
});

reset();
__mockUpdateQueue.push({ ok: false, status: 404 });
await syncBookingUpdate(bUpd);
expect('syncBookingUpdate 404（事件不存在）→ 補建 insertEvent、gcal_event_id 為事件 id', () => {
  assert.equal(__mockCalls.length, 2);
  assert.equal(__mockCalls[0].fn, 'updateEvent');
  assert.equal(__mockCalls[1].fn, 'insertEvent');
  assert.equal(getB(bUpd).gcal_event_id, eventIdForBooking(bUpd));
});

reset();
__mockUpdateQueue.push({ ok: false, status: 500, error: 'x' });
await syncBookingUpdate(bUpd);
expect('syncBookingUpdate 其他失敗 → 清 gcal_event_id 交 reconcile 補正', () => {
  assert.equal(getB(bUpd).gcal_event_id, null);
});

// ── token 泵 ──
setSetting('gcal_sync_token', '');
reset();
__mockListQueue.push({ ok: true, items: [], nextPageToken: 'p2', nextSyncToken: null });
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokA' });
await pullChanges();
expect('無 token → 基準同步（timeMin+showDeleted、分頁）→ token 落庫（綁 calId）', () => {
  const calls = callsOf('listEvents');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.params.timeMin && calls[0].args.params.showDeleted);
  assert.equal(calls[0].args.params.syncToken, undefined);
  assert.equal(calls[1].args.params.pageToken, 'p2');
  assert.deepEqual(JSON.parse(getSetting('gcal_sync_token')), { calId: CAL, token: 'tokA' });
});
reset();
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokB' });
await pullChanges();
expect('有 token → 增量（syncToken=tokA）→ 存 tokB', () => {
  assert.equal(callsOf('listEvents')[0].args.params.syncToken, 'tokA');
  assert.equal(JSON.parse(getSetting('gcal_sync_token')).token, 'tokB');
});
reset();
__mockListQueue.push({ ok: false, status: 410, error: 'gone' });
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokC' });
await pullChanges();
expect('410 → 清 token 重基準 → 存 tokC', () => {
  const calls = callsOf('listEvents');
  assert.equal(calls[0].args.params.syncToken, 'tokB');
  assert.ok(calls[1].args.params.timeMin);
  assert.equal(JSON.parse(getSetting('gcal_sync_token')).token, 'tokC');
});
reset();
setSetting('gcal_calendar_id', 'gp-other-cal');
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokD' });
await pullChanges();
expect('換日曆 → token 失效重基準（timeMin、無 syncToken）', () => {
  const calls = callsOf('listEvents');
  assert.ok(calls[0].args.params.timeMin);
  assert.equal(calls[0].args.params.syncToken, undefined);
  assert.deepEqual(JSON.parse(getSetting('gcal_sync_token')), { calId: 'gp-other-cal', token: 'tokD' });
});
reset();
setSetting('gcal_calendar_id', '');
await pullChanges();
expect('未設定日曆（isGcalEnabled=false）→ 不打 API', () => assert.equal(__mockCalls.length, 0));

// ── 還原（這份 app.db 是長期共用 dev DB：token/calendar id 設定與本檔建立的 gp-% 資料都要清乾淨）──
setSetting('gcal_sync_token', '');
setSetting('gcal_calendar_id', origCalId);
db.exec(`
  DELETE FROM notifications WHERE type IN ('gcal_move_rejected','gcal_delete_cancelled');
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM bookings WHERE start_at LIKE '2032-%' OR start_at LIKE '2020-%';
  DELETE FROM discount_redemptions WHERE kind='booking' AND ref_id NOT IN (SELECT id FROM bookings);
  DELETE FROM discount_codes WHERE code='GPDEL';
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM users WHERE email LIKE 'gp-%';
`);
console.log('[gcal-pull test] done');
