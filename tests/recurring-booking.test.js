// 循環預約：occurrence 計算、preview 狀態、create 跳過衝突、markPaid、摘要通知、折扣逐堂、recurring_group_id。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
process.env.GMAIL_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const { recurringOccurrences, previewRecurringBookings, createRecurringBookings } = await import('../src/services/bookingService.js');
const { addRule, addException } = await import('../src/services/availabilityService.js');
const { createDiscountCode } = await import('../src/services/discountService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[recurring-booking test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM discount_redemptions; DELETE FROM discount_codes WHERE code='RECUR10'; DELETE FROM coach_availability_rules; DELETE FROM coach_availability_exceptions; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'rc-%' OR phone LIKE '0986%'");

// ── occurrence 計算 ──
expect('weekly：+7 天 ×4', () => {
  const o = recurringOccurrences({ startAt: '2026-07-06T15:00:00', frequency: 'weekly', count: 4 });
  assert.deepEqual(o.map(x => x.startAt), ['2026-07-06T15:00:00', '2026-07-13T15:00:00', '2026-07-20T15:00:00', '2026-07-27T15:00:00']);
});
expect('daily：+1 天', () => {
  const o = recurringOccurrences({ startAt: '2026-07-30T10:00:00', frequency: 'daily', count: 3 });
  assert.deepEqual(o.map(x => x.startAt), ['2026-07-30T10:00:00', '2026-07-31T10:00:00', '2026-08-01T10:00:00']);
});
expect('custom：每 3 天', () => {
  const o = recurringOccurrences({ startAt: '2026-07-01T10:00:00', frequency: 'custom', intervalDays: 3, count: 3 });
  assert.deepEqual(o.map(x => x.startAt), ['2026-07-01T10:00:00', '2026-07-04T10:00:00', '2026-07-07T10:00:00']);
});
expect('monthly：每月同日、31 號遇短月標記 no_date 不順延', () => {
  const o = recurringOccurrences({ startAt: '2026-08-31T10:00:00', frequency: 'monthly', count: 4 });
  assert.equal(o[0].startAt, '2026-08-31T10:00:00');
  assert.equal(o[1].reason, 'no_date');  // 9 月無 31
  assert.equal(o[2].startAt, '2026-10-31T10:00:00');
  assert.equal(o[3].reason, 'no_date');  // 11 月無 31
});

// ── fixtures：教練（週一～日 09:00-18:00 班表）──
const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練循','rc-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練循', 1)").run(cuid).lastInsertRowid);
const operator = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('排課管理','rc-a@x.com','coach',1)").run().lastInsertRowid);
for (let dow = 0; dow <= 6; dow++) addRule({ coachId, dayOfWeek: dow, startTime: '09:00', endTime: '18:00' });
const pad = n => String(n).padStart(2,'0');
const day = (d) => { const x = new Date(Date.now() + d*86400000); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`; };
const base = `${day(7)}T10:00:00`;

// ── 參數驗證 ──
expect('count 超界 → invalid_count', () => {
  assert.throws(() => previewRecurringBookings({ coachId, startAt: base, frequency: 'weekly', count: 53 }), /invalid_count/);
});
expect('custom 無 intervalDays → invalid_interval', () => {
  assert.throws(() => previewRecurringBookings({ coachId, startAt: base, frequency: 'custom', count: 4 }), /invalid_interval/);
});

// ── preview：第二週教練請假 → 該場 unavailable ──
addException({ coachId, exceptionDate: day(14), type: 'leave' });
expect('preview：請假週標 unavailable、其餘 ok', () => {
  const r = previewRecurringBookings({ coachId, startAt: base, frequency: 'weekly', count: 3 });
  assert.deepEqual(r.occurrences.map(o => o.ok), [true, false, true]);
  assert.equal(r.occurrences[1].reason, 'unavailable');
});

// ── create：跳過請假週、其餘建立；markPaid；group id；折扣逐堂 ──
createDiscountCode({ code: 'RECUR10', discount_type: 'percent', discount_value: 10 });
let result;
expect('create：建 2 跳 1、totalAmount 折後加總', () => {
  result = createRecurringBookings({
    coachId, startAt: base, name: '循環客', phone: '0986111222', email: 'rc@example.com',
    frequency: 'weekly', count: 3, markPaid: true, discountCode: 'RECUR10', actorId: operator,
  });
  assert.equal(result.created.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'unavailable');
  assert.equal(result.markPaid, true);
  // 1500 → 10% off = 1350 ×2
  assert.equal(result.created[0].finalAmount, 1350);
  assert.equal(result.totalAmount, 2700);
});
expect('recurring_group_id = 首筆 id、全部已核對（經手=操作者）', () => {
  const rows = db.prepare('SELECT id, recurring_group_id, paid_at, paid_by, discount_code FROM bookings WHERE recurring_group_id = ?').all(result.groupId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.recurring_group_id === result.groupId && r.paid_at && r.paid_by === operator && r.discount_code === 'RECUR10'));
});
expect('通知摘要：會員/教練/管理者各一則、無逐堂 booking_created', () => {
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_created'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_recurring_created'").get().c, 1);
  // 教練本人恰一則；操作者（被 exclude）零則。共用 DB 可能有其他管理者收到廣播，不驗總數。
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_recurring_created_coach' AND user_id=?").get(cuid).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='booking_recurring_created_coach' AND user_id=?").get(operator).c, 0);
});
await new Promise(r => setTimeout(r, 50));
expect('摘要 email：一封、收件人正確', () => {
  const rows = db.prepare("SELECT * FROM notifications WHERE type='booking_recurring_email'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, 'rc@example.com');
  assert.ok(rows[0].body.includes('共 2 堂') || rows[0].subject.includes('共 2 堂'));
});

// ── 全衝突 → 409、不建立 ──
expect('全衝突 → 409 all_conflicted、無新預約', () => {
  const before = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
  assert.throws(() => createRecurringBookings({
    coachId, startAt: `${day(7)}T05:00:00`, name: '無效', phone: '0986333444',
    frequency: 'weekly', count: 2, actorId: operator,
  }), /all_conflicted/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bookings').get().c, before);
});

// ── 既有預約佔用（同教練重疊）＋請假 → 同參數再建一輪全衝突 ──
expect('既有預約佔用 → 重複建立全衝突 409', () => {
  assert.throws(() => createRecurringBookings({
    coachId, startAt: base, name: '第二人', phone: '0986555666',
    frequency: 'weekly', count: 3, actorId: operator,
  }), /all_conflicted/);
});

db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM discount_redemptions; DELETE FROM discount_codes WHERE code='RECUR10'; DELETE FROM coach_availability_rules; DELETE FROM coach_availability_exceptions; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'rc-%' OR phone LIKE '0986%'");
console.log('[recurring-booking test] done');
