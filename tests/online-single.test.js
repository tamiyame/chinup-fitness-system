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
