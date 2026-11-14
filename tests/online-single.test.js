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

// ── 退款 ──
const refund = (id) => bk.refundBookingAdmin({ bookingId: id, actorId: admin });
expect('已付款未取消 → 退款：取消預約、記退款、方案作廢、釋放折扣碼用量', () => {
  const o = online({ code: 'OS100', paid: true }); const r = refund(o.id);
  assert.deepEqual([r.cancelled, B(o.id).status, !!B(o.id).refunded_at, !!P(o.packageId).archived_at, uses(o.id)], [true, 'cancelled', true, true, 0]);
});
expect('已付款已取消（保留 1 堂）→ 退款：方案作廢', () => {
  const o = online({ paid: true }); adminCancel(o.id); const r = refund(o.id);
  assert.deepEqual([r.cancelled, !!B(o.id).refunded_at, !!P(o.packageId).archived_at], [false, true, true]);
});
expect('保留的 1 堂已被改約 → 原筆不能退；改約後那筆退款後，原筆也不能再退', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId);
  throwsCode(() => refund(o.id), 409, 'credit_in_use');
  refund(nid);
  throwsCode(() => refund(o.id), 409, 'package_closed');
  assert.equal(B(o.id).refunded_at, null);
});
expect('改約後那筆只取消：兩筆之中退了一筆，另一筆不能再退', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId); adminCancel(nid);
  refund(o.id);
  throwsCode(() => refund(nid), 409, 'package_closed');
});
expect('未付款不能退；教練開立的方案退款行為不變', () => {
  throwsCode(() => refund(online().id), 409, 'not_paid');
  const m = member(); const ten = tenPack(m); refund(register(m, ten.id));
  assert.deepEqual([P(ten.id).remaining_sessions, P(ten.id).archived_at], [10, null]);
});
expect('整批退款（循環散客）：已改約的那堂跳過並回報，其餘照退；都不能退 → already_refunded', () => {
  const m = member(); const [a, b, c] = [1, 2, 3].map(() => online({ memberId: m, paid: true }));
  db.prepare('UPDATE bookings SET recurring_group_id = ? WHERE id IN (?, ?, ?)').run(a.id, a.id, b.id, c.id);
  adminCancel(b.id); register(m, b.packageId);
  const r = bk.refundBookingGroupAdmin({ groupId: a.id, actorId: admin });
  assert.deepEqual([r.refunded, r.skipped, [...r.cancelled].sort((x, y) => x - y)], [2, [b.id], [a.id, c.id]]);
  assert.deepEqual([B(b.id).refunded_at, P(b.packageId).archived_at, !!P(a.packageId).archived_at, !!P(c.packageId).archived_at], [null, null, true, true]);
  throwsCode(() => bk.refundBookingGroupAdmin({ groupId: a.id, actorId: admin }), 409, 'already_refunded');
});

// ── 改客人／方案 ──
const reassign = (bookingId, memberId, packageId) => bk.reassignBooking({ bookingId, newMemberId: memberId, newPackageId: packageId, actorUserId: admin, isAdmin: true });
expect('未付款的線上單堂改掛到別的客人：成功、原單堂方案作廢、折扣碼用量釋放', () => {
  const o = online({ code: 'OS100' }); const m2 = member(); const ten = tenPack(m2);
  reassign(o.id, m2, ten.id);
  assert.deepEqual([B(o.id).package_id, B(o.id).member_id, !!P(o.packageId).archived_at, uses(o.id), P(ten.id).remaining_sessions], [ten.id, m2, true, 0, 9]);
});
expect('未付款的線上單堂改掛到同一位客人之後才買的同類型方案：不被「舊方案先用」誤擋', () => {
  const m = member(); const o = online({ memberId: m }); const ten = tenPack(m);   // 單堂方案的 id 比 10 堂方案小
  reassign(o.id, m, ten.id);
  assert.equal(B(o.id).package_id, ten.id); assert.ok(P(o.packageId).archived_at);
});
expect('已付款的線上單堂不能改掛（同客人、別的客人、不同類型）', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); const m2 = member();
  const targets = [[m, tenPack(m).id], [m2, tenPack(m2).id], [m, tenPack(m, { sessionType: '1on2' }).id]];
  for (const [mm, pid] of targets) throwsCode(() => reassign(o.id, mm, pid), 409, 'paid_online_single');
  assert.deepEqual([B(o.id).package_id, P(o.packageId).remaining_sessions, P(o.packageId).archived_at], [o.packageId, 0, null]);
});
expect('用保留的 1 堂改約出來的預約也不能改掛', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId); const m2 = member();
  throwsCode(() => reassign(nid, m2, tenPack(m2).id), 409, 'paid_online_single');
});

// ── 後台動作限制、改單價 ──
expect('線上單堂不能調整堂數、不能還原', () => {
  const o = online();
  throwsCode(() => pkg.adjustRemaining({ packageId: o.packageId, remaining: 1 }), 409, 'online_single_readonly');
  adminCancel(o.id);   // 未付款取消 → 已作廢
  throwsCode(() => pkg.restorePackage(o.packageId), 409, 'online_single_readonly');
});
expect('有未取消預約的線上單堂不能直接作廢', () => {
  const o = online({ paid: true });
  throwsCode(() => pkg.archivePackage(o.packageId, admin), 409, 'has_active_booking');
  assert.deepEqual([B(o.id).status, P(o.packageId).archived_at], ['confirmed', null]);
});
expect('保留的 1 堂可以作廢：不取消預約、釋放折扣碼用量、之後不能退款', () => {
  const o = online({ code: 'OS100', paid: true }); adminCancel(o.id);
  const r = pkg.archivePackage(o.packageId, admin);
  assert.deepEqual([r.cancelledBookingIds, !!r.archived_at, uses(o.id)], [[], true, 0]);
  throwsCode(() => refund(o.id), 409, 'package_closed');
});
expect('改單價：線上單堂的折扣一併清除並釋放用量，薪資＝新單價', () => {
  const o = online({ code: 'OS100' });
  pkg.updateUnitPrice({ packageId: o.packageId, unitPrice: 1200 });
  const b = B(o.id);
  assert.deepEqual([b.original_amount, b.discount_amount, b.discount_code, uses(o.id), P(o.packageId).amount, P(o.packageId).discount_code, payDetail(o.startAt, o.id).amount],
    [1200, null, null, 0, 1200, null, 1200]);
});
expect('改單價：保留的 1 堂改價後，改約的那堂用新價', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  pkg.updateUnitPrice({ packageId: o.packageId, unitPrice: 1000 });
  const c = B(o.id);   // 保留那堂背後已取消的原筆也一併改正
  assert.deepEqual([P(o.packageId).amount, c.status, c.original_amount, c.discount_amount, c.discount_code], [1000, 'cancelled', 1000, null, null]);
  assert.equal(B(register(m, o.packageId)).original_amount, 1000);
});
expect('教練開立的方案：調整、作廢連動取消、還原都照舊', () => {
  const m = member(); const ten = tenPack(m); const rid = register(m, ten.id);
  assert.equal(pkg.adjustRemaining({ packageId: ten.id, remaining: 5 }).remaining_sessions, 5);
  assert.deepEqual(pkg.archivePackage(ten.id, admin).cancelledBookingIds, [rid]);
  assert.equal(pkg.restorePackage(ten.id).archived_at, null);
});

// ── 線上預約實際流程（createBookingAnon）──
const book = (extra = {}) => { seq++; const phone = `0977${pad(seq, 6)}`; const name = `線上客${seq}`;
  return { ...bk.createBookingAnon({ coachId, startAt: slot(), name, phone, ...extra }), phone, name }; };
expect('線上預約送出 → 自動建一堂方案並掛上；回傳內容不多出欄位', () => {
  const r = book(); const b = B(r.id); const p = P(b.package_id);
  assert.equal(b.paid_at, null);
  assert.deepEqual([p.source, p.total_sessions, p.remaining_sessions, p.amount, p.member_id], ['online', 1, 0, 1500, b.member_id]);
  assert.equal('packageId' in r, false);
});
expect('有折扣碼；一對二有同行客人', () => {
  const r = book({ discountCode: 'OS100' }); const p = P(B(r.id).package_id);
  assert.deepEqual([p.amount, p.discount_code, uses(r.id)], [1400, 'OS100', 1]);
  seq++; const r2 = book({ sessionType: '1on2', companion: { name: `同行${seq}`, phone: `0978${pad(seq, 6)}` } }); const b2 = B(r2.id);
  assert.ok(b2.member2_id);
  assert.deepEqual([P(b2.package_id).session_type, P(b2.package_id).amount, P(b2.package_id).member_id], ['1on2', 2000, b2.member_id]);
});
expect('整段流程：預約→核對→客人取消（保留 1 堂）→教練改約→退款；原筆不能再退', () => {
  const r = book(); const b = B(r.id);
  bk.confirmBookingPayment({ bookingId: r.id, actorId: admin });
  bk.cancelBookingAnon({ bookingId: r.id, phone: r.phone, name: r.name });
  assert.equal(pkg.getPackage(b.package_id).is_valid, true);
  refund(register(b.member_id, b.package_id));
  assert.ok(P(b.package_id).archived_at);
  throwsCode(() => refund(r.id), 409, 'package_closed');
});
expect('限用一次的折扣碼：已付款取消後還保留 1 堂時不能再用同一個碼；退款後才釋放', () => {
  createDiscountCode({ code: 'OSONCE', discount_type: 'fixed', discount_value: 100, per_phone_limit: 1 });
  const r = book({ discountCode: 'OSONCE' });
  bk.confirmBookingPayment({ bookingId: r.id, actorId: admin });
  bk.cancelBookingAnon({ bookingId: r.id, phone: r.phone, name: r.name });
  const again = () => bk.createBookingAnon({ coachId, startAt: slot(), name: r.name, phone: r.phone, discountCode: 'OSONCE' });
  throwsCode(again, 409, 'per_phone_exhausted');
  refund(r.id);
  assert.ok(again().id);
});

// ── 會員方案區的單堂資料 ──
const single = (memberId, packageId) => pkg.listPackagesForMember(memberId, { includeArchived: true }).find((p) => p.id === packageId).single;
expect('已預約・待核對 → 核對後可退款', () => {
  const o = online(); let s = single(o.memberId, o.packageId);
  assert.deepEqual([s.state, s.pay_status, s.booking_id, s.start_at, s.coach_name, s.booking_status, s.amount, s.refundable_booking_id],
    ['booked', 'pending', o.id, o.startAt, 'os教練', 'confirmed', 1500, null]);
  bk.confirmBookingPayment({ bookingId: o.id, actorId: admin }); s = single(o.memberId, o.packageId);
  assert.deepEqual([s.pay_status, s.refundable_booking_id], ['paid', o.id]);
});
expect('已上完', () => { const o = online({ startAt: pastSlot(), paid: true }); assert.equal(single(o.memberId, o.packageId).state, 'done'); });
expect('保留 1 堂 → 改約後代表預約換成新的那筆 → 退款後已取消・已退款', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  let s = single(m, o.packageId);
  assert.deepEqual([s.state, s.pay_status, s.booking_id, s.booking_status, s.refundable_booking_id], ['credit', 'paid', o.id, 'cancelled', o.id]);
  const nid = register(m, o.packageId); s = single(m, o.packageId);
  assert.deepEqual([s.state, s.booking_id, s.refundable_booking_id], ['booked', nid, nid]);
  refund(nid); s = single(m, o.packageId);
  assert.deepEqual([s.state, s.pay_status, s.refundable_booking_id], ['cancelled', 'refunded', null]);
});
expect('未付款取消 → 已取消・待核對；作廢保留的 1 堂 → 已作廢・已核對，不能退款', () => {
  const a = online(); adminCancel(a.id);
  assert.deepEqual([single(a.memberId, a.packageId).state, single(a.memberId, a.packageId).pay_status], ['cancelled', 'pending']);
  const b = online({ paid: true }); adminCancel(b.id); pkg.archivePackage(b.packageId, admin);
  const s = single(b.memberId, b.packageId);
  assert.deepEqual([s.state, s.pay_status, s.refundable_booking_id], ['void', 'paid', null]);
});
expect('預約被改掛走、名下沒有預約的線上單堂：預約欄位都是 null、狀態已取消', () => {
  const o = online(); const m2 = member(); reassign(o.id, m2, tenPack(m2).id);
  const s = single(o.memberId, o.packageId);
  assert.deepEqual([s.booking_id, s.start_at, s.coach_name, s.booking_status, s.state, s.pay_status, s.refundable_booking_id], [null, null, null, null, 'cancelled', 'pending', null]);
});
expect('教練開立的方案沒有 single', () => { const m = member(); tenPack(m); assert.equal(pkg.listPackagesForMember(m)[0].single, undefined); });
expect('summary：各來源方案數、沒有方案的未取消預約數；還沒補登 → backfill 為 null', () => {
  const s = pkg.getPackagesSummary(); const n = (sql) => db.prepare(sql).get().c;
  assert.deepEqual([s.packages.online, s.packages.staff, s.confirmedWithoutPackage, s.backfill],
    [n("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'online'"), n("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'staff'"),
     n("SELECT COUNT(*) AS c FROM bookings WHERE status = 'confirmed' AND package_id IS NULL"), null]);
});
expect('summary：backfill 有值時解析成物件', () => {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('online_single_backfill_summary', ?)").run('{"created":3,"members":2}');
  try { assert.deepEqual(pkg.getPackagesSummary().backfill, { created: 3, members: 2 }); }
  finally { db.prepare("DELETE FROM app_settings WHERE key = 'online_single_backfill_summary'").run(); }
});
expect('summary：補登失敗原因沒有、空字串、壞 JSON → null；有值時解析成物件', () => {
  const set = (v) => db.prepare("INSERT INTO app_settings (key, value) VALUES ('online_single_backfill_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  try {
    assert.equal(pkg.getPackagesSummary().backfillError, null);
    set(''); assert.equal(pkg.getPackagesSummary().backfillError, null);
    set('{'); assert.equal(pkg.getPackagesSummary().backfillError, null);
    set('"x"'); assert.equal(pkg.getPackagesSummary().backfillError, null);
    set('{"at":"2026-11-14T09:00:00","reason":"error","error":"booking 5: x"}');
    assert.deepEqual(pkg.getPackagesSummary().backfillError, { at: '2026-11-14T09:00:00', reason: 'error', error: 'booking 5: x' });
  } finally { db.prepare("DELETE FROM app_settings WHERE key = 'online_single_backfill_error'").run(); }
});

// ── 最終修正波：取消與改單價 ──
expect('已退款卻仍是未取消的舊預約（人工改過的資料）→ 取消時方案作廢、不留堂；卡片已取消・已退款', () => {
  const o = online({ paid: true });
  db.prepare('UPDATE bookings SET refunded_at = ?, refunded_by = ? WHERE id = ?').run('2026-03-02T12:00:00', admin, o.id);
  adminCancel(o.id);
  const p = pkg.getPackage(o.packageId); const s = single(o.memberId, o.packageId);
  assert.deepEqual([!!p.archived_at, p.is_valid, s.state, s.pay_status], [true, false, 'cancelled', 'refunded']);
});
const refundNote = (memberId) => db.prepare("SELECT body FROM notifications WHERE type = 'booking_refunded' AND user_id = ? ORDER BY id DESC").get(memberId)?.body;
expect('改單價：保留的 1 堂（1500、折扣碼 OS100）改成 1000 → 已取消的原筆一併改正、釋放用量；退款通知寫 1000', () => {
  const m = member(); const o = online({ memberId: m, code: 'OS100', paid: true }); adminCancel(o.id);
  assert.equal(uses(o.id), 1);
  const r = pkg.updateUnitPrice({ packageId: o.packageId, unitPrice: 1000 });
  const b = B(o.id);
  assert.deepEqual([r.rewrittenBookings, b.status, b.original_amount, b.discount_amount, b.discount_code, uses(o.id), P(o.packageId).amount],
    [1, 'cancelled', 1000, null, null, 0, 1000]);
  assert.equal(single(m, o.packageId).amount, 1000);
  refund(o.id);
  const body = refundNote(m);
  assert.ok(body && body.includes('NT$1000'), body); assert.ok(!body.includes('NT$1400'), body);
});
expect('改單價：教練開立的方案只回寫未取消的預約（已取消的不動）', () => {
  const m = member(); const ten = tenPack(m); const kept = register(m, ten.id); const gone = register(m, ten.id); adminCancel(gone);
  const r = pkg.updateUnitPrice({ packageId: ten.id, unitPrice: 1200 });
  assert.deepEqual([r.rewrittenBookings, B(kept).original_amount, B(gone).original_amount, P(ten.id).amount], [1, 1200, 1500, 12000]);
});
expect('改單價：已作廢的線上單堂 → 名下已取消／已退款的預約都不動', () => {
  const a = online({ code: 'OS100' }); adminCancel(a.id);          // 未付款取消 → 作廢
  const b = online({ code: 'OS100', paid: true }); refund(b.id);   // 退款 → 作廢
  for (const o of [a, b]) {
    const before = B(o.id);
    const r = pkg.updateUnitPrice({ packageId: o.packageId, unitPrice: 900 });
    assert.deepEqual([r.rewrittenBookings, B(o.id)], [0, before]);
  }
});

// ── 不變量（這一段永遠留在檔案最後；之後的 task 把測試加在它前面）──
expect('線上單堂方案都是共 1 堂、剩 0 或 1', () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'online' AND (total_sessions <> 1 OR remaining_sessions NOT IN (0, 1))").get().c, 0);
});
expect('未作廢的線上單堂方案：剩餘堂數＋未取消預約數 恆為 1（一筆錢不會對到兩堂，也不會一堂都沒有）', () => {
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM customer_packages p WHERE p.source = 'online' AND p.archived_at IS NULL
    AND p.remaining_sessions + (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id AND b.status = 'confirmed') <> 1`).get().c, 0);
});
expect('已作廢的線上單堂方案名下沒有未取消的預約', () => {
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM bookings b JOIN customer_packages p ON p.id = b.package_id
    WHERE p.source = 'online' AND p.archived_at IS NOT NULL AND b.status = 'confirmed'`).get().c, 0);
});
