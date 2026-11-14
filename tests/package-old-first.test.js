// 舊方案先用：同一位客人、同類型（1對1／1對2）裡，還可用的方案要從最早買的那筆開始登錄。
// use_first_id＝要先用完的那筆方案 id（自己就是該用的那筆 → null）；登錄／預覽／改指定方案選到較新的 → 409 older_package_first。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createPackage, getPackage, listPackagesForMember, archivePackage, deductOne } = await import('../src/services/packageService.js');
const { previewCoachRegister, createCoachRegister, reassignBooking } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[package-old-first test] start');

const clean = () => db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pof-%');
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pof-%')
     OR coach_id IN (SELECT c.id FROM coaches c JOIN users u ON u.id = c.user_id WHERE u.email LIKE 'pof-%');
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pof-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pof-%');
  DELETE FROM users WHERE email LIKE 'pof-%';
`);
clean();

const pad = (n) => String(n).padStart(2, '0');
let seq = 0;
const member = () => { seq++; return Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?,?,'user',?)").run(`pof客${seq}`, `pof-m${seq}@x.com`, `09730000${pad(seq)}`).lastInsertRowid); };
const cu = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('pof教練','pof-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'pof-coach', 1)").run(cu).lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('pof管','pof-a@x.com','coach',1)").run().lastInsertRowid);
const pkg = (memberId, opts = {}) => createPackage({ memberId, sessionType: '1on1', totalSessions: 10, amount: 15000, ...opts });
// 每次取一個不重複的未來整點（同教練不可撞時段）
const day0 = new Date(Date.now() + 40 * 86400000);
let slotN = 0;
const slot = () => { const d = new Date(day0.getTime() + Math.floor(slotN / 10) * 86400000); const h = 8 + (slotN % 10); slotN++;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:00:00`; };
const yesterday = (() => { const d = new Date(Date.now() - 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();
const register = (memberId, packageId, recurrence = null) => createCoachRegister({ coachId, memberId, packageId, startAt: slot(), recurrence, actorId: admin });
const throwsCode = (fn, status, code) => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`);
  assert.equal(err.code, code); assert.equal(err.status, status);
  return err;
};
const firstIds = (memberId) => Object.fromEntries(listPackagesForMember(memberId).map((p) => [p.id, p.use_first_id]));

// ── use_first_id（getPackage／listPackagesForMember）──
expect('只有一筆方案 → use_first_id 為 null', () => {
  const m = member(); const a = pkg(m);
  assert.equal(getPackage(a.id).use_first_id, null);
  assert.deepEqual(firstIds(m), { [a.id]: null });
});
expect('同類型兩筆都有堂數 → 較晚買的那筆指向較早買的', () => {
  const m = member(); const a = pkg(m); const b = pkg(m);
  assert.equal(getPackage(a.id).use_first_id, null);
  assert.equal(getPackage(b.id).use_first_id, a.id);
  assert.deepEqual(firstIds(m), { [a.id]: null, [b.id]: a.id });
});
expect('不同類型互不影響（1對1 舊、1對2 新 → 兩筆都可用）', () => {
  const m = member(); const a = pkg(m); const b = pkg(m, { sessionType: '1on2' });
  assert.deepEqual(firstIds(m), { [a.id]: null, [b.id]: null });
  assert.equal(getPackage(b.id).use_first_id, null);
});
expect('三筆同類型 → 後兩筆都指向最早買的那筆', () => {
  const m = member(); const a = pkg(m); const b = pkg(m); const c = pkg(m);
  assert.deepEqual(firstIds(m), { [a.id]: null, [b.id]: a.id, [c.id]: a.id });
});
expect('較早買的已用完 → 較晚買的可用', () => {
  const m = member(); const a = pkg(m, { totalSessions: 1 }); const b = pkg(m);
  assert.equal(getPackage(b.id).use_first_id, a.id);
  deductOne(a.id);
  assert.equal(getPackage(b.id).use_first_id, null);
  assert.equal(firstIds(m)[b.id], null);
});
expect('較早買的已作廢／已過期 → 不擋較晚買的', () => {
  const m1 = member(); const a1 = pkg(m1); const b1 = pkg(m1);
  archivePackage(a1.id);
  assert.equal(getPackage(b1.id).use_first_id, null);
  const m2 = member(); const a2 = pkg(m2); const b2 = pkg(m2);
  db.prepare('UPDATE customer_packages SET expires_at = ? WHERE id = ?').run(yesterday, a2.id);
  assert.equal(getPackage(b2.id).use_first_id, null);
  assert.equal(firstIds(m2)[b2.id], null);
});
expect('別的客人的方案不算', () => {
  const m1 = member(); pkg(m1); const m2 = member(); const b = pkg(m2);
  assert.equal(getPackage(b.id).use_first_id, null);
});
expect('自己已不可用（用完）的方案 → use_first_id 為 null', () => {
  const m = member(); const a = pkg(m); const b = pkg(m, { totalSessions: 1 });
  deductOne(b.id);
  assert.equal(getPackage(b.id).is_valid, false);
  assert.equal(getPackage(b.id).use_first_id, null);
  assert.equal(firstIds(m)[b.id], null);
  assert.equal(getPackage(a.id).use_first_id, null);
});

// ── 登錄／預覽 ──
expect('登錄選到較晚買的方案 → 409 older_package_first，兩筆都不扣', () => {
  const m = member(); const a = pkg(m); const b = pkg(m);
  const err = throwsCode(() => register(m, b.id), 409, 'older_package_first');
  assert.equal(err.detail.useFirstId, a.id);
  assert.equal(getPackage(a.id).remaining_sessions, 10);
  assert.equal(getPackage(b.id).remaining_sessions, 10);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bookings WHERE member_id = ?').get(m).c, 0);
});
expect('預覽選到較晚買的方案 → 一樣 409 older_package_first', () => {
  const m = member(); pkg(m); const b = pkg(m);
  throwsCode(() => previewCoachRegister({ coachId, memberId: m, packageId: b.id, startAt: slot(), recurrence: null }), 409, 'older_package_first');
});
expect('先登錄較早買的；用完之後較晚買的才可以登錄', () => {
  const m = member(); const a = pkg(m, { totalSessions: 1 }); const b = pkg(m);
  assert.equal(register(m, a.id).created.length, 1);
  assert.equal(getPackage(a.id).remaining_sessions, 0);
  assert.equal(register(m, b.id).created.length, 1);
  assert.equal(getPackage(b.id).remaining_sessions, 9);
});
expect('循環登錄不自動接續：舊方案剩 1 堂排 3 次 → 只建 1 堂，新方案不動', () => {
  const m = member(); const a = pkg(m, { totalSessions: 1 }); const b = pkg(m);
  const r = register(m, a.id, { frequency: 'weekly', end: { type: 'count', count: 3 } });
  assert.equal(r.created.length, 1);
  assert.equal(getPackage(a.id).remaining_sessions, 0);
  assert.equal(getPackage(b.id).remaining_sessions, 10);
});
expect('不同類型的較新方案可以直接登錄', () => {
  const m = member(); pkg(m); const b = pkg(m, { sessionType: '1on2' });
  assert.equal(register(m, b.id).created.length, 1);
});

// ── 改指定客人／方案 ──
const bookingRow = (id) => db.prepare('SELECT member_id, package_id FROM bookings WHERE id = ?').get(id);
expect('改指定方案：把舊方案的預約改到較新的方案 → 409（退回後舊方案又有堂數），資料不變', () => {
  const m = member(); const a = pkg(m, { totalSessions: 1 }); const b = pkg(m);
  const bid = register(m, a.id).created[0].id;          // 舊方案用完，新方案此時可用
  throwsCode(() => reassignBooking({ bookingId: bid, newMemberId: m, newPackageId: b.id, actorUserId: admin, isAdmin: true }), 409, 'older_package_first');
  assert.equal(getPackage(a.id).remaining_sessions, 0);
  assert.equal(getPackage(b.id).remaining_sessions, 10);
  assert.equal(bookingRow(bid).package_id, a.id);
});
expect('改指定方案：改給別的客人時選到他較晚買的方案 → 409；選最早買的 → 成功', () => {
  const m1 = member(); const src = pkg(m1);
  const bid = register(m1, src.id).created[0].id;
  const m2 = member(); const a = pkg(m2); const b = pkg(m2);
  throwsCode(() => reassignBooking({ bookingId: bid, newMemberId: m2, newPackageId: b.id, actorUserId: admin, isAdmin: true }), 409, 'older_package_first');
  assert.equal(getPackage(src.id).remaining_sessions, 9);
  assert.equal(bookingRow(bid).member_id, m1);
  reassignBooking({ bookingId: bid, newMemberId: m2, newPackageId: a.id, actorUserId: admin, isAdmin: true });
  assert.deepEqual({ ...bookingRow(bid) }, { member_id: m2, package_id: a.id });
  assert.equal(getPackage(src.id).remaining_sessions, 10);
  assert.equal(getPackage(a.id).remaining_sessions, 9);
});

clean();
console.log('[package-old-first test] done');
