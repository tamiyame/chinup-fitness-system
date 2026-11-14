// 線上單堂方案：建立、取消、退款、改掛、後台動作限制、連動。
// 用獨立的暫存資料庫（不碰共用資料庫），不必清資料，全域查詢結果可預期。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `online-single-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
process.env.LINE_MOCK = '1'; process.env.GMAIL_MOCK = '1'; process.env.GCAL_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const pkg = await import('../src/services/packageService.js');
const bk = await import('../src/services/bookingService.js');
const { applyDiscountTx, createDiscountCode } = await import('../src/services/discountService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[online-single test] start');

const pad = (n, w = 2) => String(n).padStart(w, '0');
let seq = 0;
const member = () => { seq++; return Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?,?,'user',?)").run(`客${seq}`, `os-m${seq}@x.com`, `0966${pad(seq, 6)}`).lastInsertRowid); };
const phoneOf = (id) => db.prepare('SELECT phone FROM users WHERE id = ?').get(id).phone;
const nameOf = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id).name;
const coachUser = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('os教練','os-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'os教練', 1)").run(coachUser).lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('os管','os-a@x.com','coach',1)").run().lastInsertRowid);
// 不重複的整點（08–17 點）：未來從 40 天後起算、過去從 40 天前起算
let fN = 0, pN = 0;
const hourAt = (base, n) => { const d = new Date(base + Math.floor(n / 10) * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(8 + (n % 10))}:00:00`; };
const slot = () => hourAt(Date.now() + 40 * 86400000, fN++);
const pastSlot = () => hourAt(Date.now() - 40 * 86400000, pN++);
const endOf = (s) => `${s.slice(0, 11)}${pad(Number(s.slice(11, 13)) + 1)}:00:00`;
const P = (id) => db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(id);
const B = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
const uses = (bookingId) => db.prepare("SELECT COUNT(*) AS c FROM discount_redemptions WHERE kind = 'booking' AND ref_id = ?").get(bookingId).c;
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };

/** 沒有方案的預約（上線前舊資料的樣子）。回 booking id。 */
const rawBooking = ({ memberId = member(), startAt = slot(), type = '1on1', original = type === '1on2' ? 2000 : 1500, member2Id = null } = {}) =>
  Number(db.prepare('INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, member2_id) VALUES (?,?,?,?,?,?,?)')
    .run(coachId, memberId, startAt, endOf(startAt), type, original, member2Id).lastInsertRowid);
/** 線上預約落地後的樣子：一筆待核對預約＋一張線上單堂方案。code＝折扣碼（真的記一筆用量）；paid＝已核對。 */
const online = ({ code = null, paid = false, ...rest } = {}) => {
  const memberId = rest.memberId ?? member(); const startAt = rest.startAt ?? slot();
  const id = rawBooking({ ...rest, memberId, startAt });
  if (code) {
    const a = applyDiscountTx({ code, phone: phoneOf(memberId), subtotal: B(id).original_amount, kind: 'booking', refId: id, qty: 1 });
    db.prepare('UPDATE bookings SET discount_amount = ?, discount_code = ? WHERE id = ?').run(a.discountAmount, a.discountCode, id);
  }
  const packageId = pkg.createOnlineSingleForBooking(id);
  if (paid) bk.confirmBookingPayment({ bookingId: id, actorId: admin });
  return { id, packageId, memberId, startAt };
};
const tenPack = (memberId, opts = {}) => pkg.createPackage({ memberId, sessionType: '1on1', totalSessions: 10, amount: 15000, ...opts });
const register = (memberId, packageId, startAt = slot()) => bk.createCoachRegister({ coachId, memberId, packageId, startAt, actorId: admin }).created[0].id;
createDiscountCode({ code: 'OS100', discount_type: 'fixed', discount_value: 100 });
createDiscountCode({ code: 'OSFREE', discount_type: 'percent', discount_value: 100 });

// ── 建立／關閉 ──
expect('建立：方案欄位照規格、預約掛上方案、預約本身不變', () => {
  const m = member(); const o = online({ memberId: m, code: 'OS100' }); const p = P(o.packageId); const b = B(o.id);
  assert.deepEqual(
    [p.member_id, p.session_type, p.total_sessions, p.remaining_sessions, p.amount, p.discount_code, p.source, p.created_by, p.expires_at, p.note, p.archived_at],
    [m, '1on1', 1, 0, 1400, 'OS100', 'online', null, null, null, null]);
  assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual([b.package_id, b.original_amount, b.discount_amount, b.discount_code, b.paid_at], [o.packageId, 1500, 100, 'OS100', null]);
});
expect('建立：一對二只替主客人建一張', () => {
  const m = member(), mate = member(); const o = online({ memberId: m, type: '1on2', member2Id: mate });
  assert.deepEqual([P(o.packageId).session_type, P(o.packageId).amount], ['1on2', 2000]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM customer_packages WHERE member_id = ?').get(mate).c, 0);
});
expect('建立：沒有定價的舊預約 → 金額 NULL；折到 0 元 → 金額是 0', () => {
  assert.equal(P(online({ original: null }).packageId).amount, null);
  assert.equal(P(online({ code: 'OSFREE' }).packageId).amount, 0);
});
expect('建立：可指定建立時間（補登用）；已有方案不能再建；找不到預約', () => {
  const id = rawBooking();
  assert.equal(P(pkg.createOnlineSingleForBooking(id, { createdAt: '2026-03-01T10:30:00' })).created_at, '2026-03-01T10:30:00');
  throwsCode(() => pkg.createOnlineSingleForBooking(id), 409, 'booking_has_package');
  throwsCode(() => pkg.createOnlineSingleForBooking(99999999), 404, 'booking_not_found');
});
expect('剩 0 堂的線上單堂不算可用，不擋同類型的 10 堂方案', () => {
  const m = member(); const o = online({ memberId: m }); const ten = tenPack(m);
  assert.equal(pkg.getPackage(o.packageId).is_valid, false);
  assert.equal(pkg.getPackage(ten.id).use_first_id, null);
});
expect('關閉：寫作廢時間、釋放折扣碼用量、不取消預約、可重複呼叫；教練開立的方案不受影響', () => {
  const o = online({ code: 'OS100' }); assert.equal(uses(o.id), 1);
  assert.equal(pkg.closeOnlineSinglePackage(o.packageId), true);
  const at = P(o.packageId).archived_at; assert.ok(at);
  assert.deepEqual([uses(o.id), B(o.id).status], [0, 'confirmed']);
  pkg.closeOnlineSinglePackage(o.packageId); assert.equal(P(o.packageId).archived_at, at);
  const ten = tenPack(member());
  assert.equal(pkg.closeOnlineSinglePackage(ten.id), false); assert.equal(P(ten.id).archived_at, null);
  bk.cancelBookingAdmin({ bookingId: o.id, actorId: admin });   // 收尾：已作廢的方案名下不留未取消的預約（Task 7 的不變量會檢查）
});

// ── 連動：讀取端 ──
const { computePayroll, defaultPeriod } = await import('../src/services/payrollService.js');
const { processRenewalReminders } = await import('../src/services/renewalReminderService.js');
const { getCoachWeek } = await import('../src/services/coachCalendarService.js');
const payDetail = (startAt, bookingId) => computePayroll({ period: defaultPeriod(startAt) }).coaches
  .find((c) => c.coachId === coachId).oneOnOne.details.find((d) => d.bookingId === bookingId);
const reminded = (packageId) => !!db.prepare("SELECT 1 FROM renewal_reminders WHERE kind = 'package' AND ref_id = ?").get(packageId);

expect('薪資：線上單堂標散客、金額＝定價−折扣；教練開立的標方案；沒有方案的舊預約標散客', () => {
  const o = online({ code: 'OS100' });
  assert.deepEqual([payDetail(o.startAt, o.id).source, payDetail(o.startAt, o.id).amount], ['walkin', 1400]);
  const m = member(); const s = slot(); assert.equal(payDetail(s, register(m, tenPack(m).id, s)).source, 'package');
  const s2 = slot(); assert.equal(payDetail(s2, rawBooking({ startAt: s2 })).source, 'walkin');
});
expect('續購提醒：10 堂剩 1 堂的客人另有未來的線上單堂 → 照樣提醒', () => {
  const m = member(); const ten = tenPack(m); pkg.adjustRemaining({ packageId: ten.id, remaining: 1 });
  online({ memberId: m });
  processRenewalReminders(nowLocal());
  assert.equal(reminded(ten.id), true);
});
expect('客人端我的方案：不含線上單堂', () => {
  const m = member(); online({ memberId: m });
  assert.deepEqual(pkg.listScheduleViewPackages(m, nowLocal()), []);
  tenPack(m); assert.equal(pkg.listScheduleViewPackages(m, nowLocal()).length, 1);
});
expect('週曆預約帶 pkg_source', () => {
  const wk = (id, s) => getCoachWeek({ coachId, start: s.slice(0, 10) }).bookings.find((x) => x.id === id);
  const o = online(); assert.equal(wk(o.id, o.startAt).pkg_source, 'online');
  const m = member(); const s = slot(); assert.equal(wk(register(m, tenPack(m).id, s), s).pkg_source, 'staff');
  const s2 = slot(); assert.equal(wk(rawBooking({ startAt: s2 }), s2).pkg_source, null);
});
expect('會員方案清單每筆帶 source', () => {
  const m = member(); online({ memberId: m }); tenPack(m);
  assert.deepEqual(pkg.listPackagesForMember(m).map((p) => p.source).sort(), ['online', 'staff']);
});

// ── 取消 ──
const CANCEL = {
  '客人取消（登入）': (o) => bk.cancelBooking({ bookingId: o.id, actorUserId: o.memberId }),
  '客人取消（查詢頁）': (o) => bk.cancelBookingAnon({ bookingId: o.id, phone: phoneOf(o.memberId), name: nameOf(o.memberId) }),
  '教練取消': (o) => bk.cancelBooking({ bookingId: o.id, actorUserId: coachUser, isCoach: true, reason: 'x' }),
  '管理者取消': (o) => bk.cancelBookingAdmin({ bookingId: o.id, actorId: admin }),
  'Google 日曆刪除': (o) => bk.cancelBookingFromGcal(o.id),
  '取消全部預約': (o) => bk.cancelCoachGroup({ bookingId: o.id, actorUserId: admin, isAdmin: true }),
};
for (const [name, cancel] of Object.entries(CANCEL)) {
  expect(`${name}・未付款 → 方案作廢`, () => {
    const o = online(); cancel(o);
    assert.ok(P(o.packageId).archived_at); assert.equal(pkg.getPackage(o.packageId).is_valid, false);
  });
  expect(`${name}・已付款 → 保留 1 堂`, () => {
    const o = online({ paid: true }); cancel(o); const p = pkg.getPackage(o.packageId);
    assert.deepEqual([p.archived_at, p.remaining_sessions, p.is_valid], [null, 1, true]);
  });
}
const adminCancel = (id) => bk.cancelBookingAdmin({ bookingId: id, actorId: admin });
expect('待核對整批取消（循環散客）：每一堂的方案各自作廢', () => {
  const m = member(); const a = online({ memberId: m }), b = online({ memberId: m });
  db.prepare('UPDATE bookings SET recurring_group_id = ? WHERE id IN (?, ?)').run(a.id, a.id, b.id);
  bk.cancelBookingAdminGroup({ groupId: a.id, actorId: admin });
  assert.ok(P(a.packageId).archived_at && P(b.packageId).archived_at);
});
expect('折扣碼用量：已付款取消仍算已用；未付款取消釋放', () => {
  const paid = online({ code: 'OS100', paid: true }); adminCancel(paid.id); assert.equal(uses(paid.id), 1);
  const unpaid = online({ code: 'OS100' }); adminCancel(unpaid.id); assert.equal(uses(unpaid.id), 0);
});
expect('教練開立的方案與沒有方案的舊預約：取消行為不變', () => {
  const m = member(); const ten = tenPack(m); adminCancel(register(m, ten.id));
  assert.deepEqual([P(ten.id).remaining_sessions, P(ten.id).archived_at], [10, null]);
  const raw = rawBooking(); adminCancel(raw); assert.equal(B(raw).status, 'cancelled');
});
expect('Google 日曆刪除：真的留下可用堂數才回報已回補', () => {
  assert.equal(bk.cancelBookingFromGcal(online().id).refunded, false);
  assert.equal(bk.cancelBookingFromGcal(online({ paid: true }).id).refunded, true);
  const m = member(); assert.equal(bk.cancelBookingFromGcal(register(m, tenPack(m).id)).refunded, true);
  assert.equal(bk.cancelBookingFromGcal(rawBooking()).refunded, false);
});
expect('一對二：同行客人取消未付款的線上預約 → 主客人的單堂方案作廢', () => {
  const m = member(), mate = member(); const o = online({ memberId: m, type: '1on2', member2Id: mate });
  bk.cancelBooking({ bookingId: o.id, actorUserId: mate });
  assert.ok(P(o.packageId).archived_at);
});
expect('舊方案先用：保留的 1 堂比之後才買的同類型方案先用；比它早買的排它前面', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  assert.equal(pkg.getPackage(tenPack(m).id).use_first_id, o.packageId);
  const m2 = member(); const earlier = tenPack(m2); const o2 = online({ memberId: m2, paid: true }); adminCancel(o2.id);
  assert.deepEqual([pkg.getPackage(o2.packageId).use_first_id, pkg.getPackage(earlier.id).use_first_id], [earlier.id, null]);
});
expect('保留的 1 堂由教練登錄改約：金額＝當初實付、已核對；再取消仍保留 1 堂', () => {
  const m = member(); const o = online({ memberId: m, code: 'OS100', paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId); const nb = B(nid);
  assert.deepEqual([nb.package_id, nb.original_amount, !!nb.paid_at, P(o.packageId).remaining_sessions], [o.packageId, 1400, true, 0]);
  adminCancel(nid);
  assert.deepEqual([P(o.packageId).remaining_sessions, P(o.packageId).archived_at], [1, null]);
});
expect('續購提醒：保留的 1 堂也不算已買新方案', () => {
  const m = member(); const ten = tenPack(m); pkg.adjustRemaining({ packageId: ten.id, remaining: 1 });
  adminCancel(online({ memberId: m, paid: true }).id);
  processRenewalReminders(nowLocal());
  assert.equal(reminded(ten.id), true);
});
