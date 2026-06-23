// 方案 service：建立/有效判定/排序/扣抵/回補/校正/作廢。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const {
  createPackage, getPackage, listPackagesForMember, listValidPackagesForMember,
  adjustRemaining, archivePackage, restorePackage, deductOne, refundOne,
} = await import('../src/services/packageService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[package-service test] start');
db.exec("DELETE FROM point_transactions WHERE related_booking_id IS NOT NULL; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM users WHERE email LIKE 'pk-%'");

const pad = n => String(n).padStart(2,'0');
const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','pk-m@x.com','user','0961000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('管理者','pk-a@x.com','coach',1)").run().lastInsertRowid);

// 結構：欄位/表存在
expect('schema：customer_packages 表與 bookings.package_id 存在', () => {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_packages'").get());
  assert.ok(db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name).includes('package_id'));
});

expect('createPackage：remaining=total、is_valid、回欄位', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 10, amount: 15000, createdBy: admin });
  assert.equal(p.total_sessions, 10);
  assert.equal(p.remaining_sessions, 10);
  assert.equal(p.session_type, '1on1');
  assert.equal(p.amount, 15000);
  assert.equal(p.is_valid, true);
});

expect('createPackage：類型錯/堂數錯/金額錯/日期錯 → 400', () => {
  assert.throws(() => createPackage({ memberId: mid, sessionType: 'x', totalSessions: 5 }), /invalid_session_type/);
  assert.throws(() => createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 0 }), /invalid_total/);
  assert.throws(() => createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, amount: -1 }), /invalid_amount/);
  assert.throws(() => createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, expiresAt: '2026/01/01' }), /invalid_expires_at/);
});

expect('createPackage：客人不存在 → 404', () => {
  assert.throws(() => createPackage({ memberId: 999999, sessionType: '1on1', totalSessions: 5 }), /member_not_found/);
});

expect('有效判定：過期 / 用罄 / 作廢 三種失效', () => {
  const expired = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 3, expiresAt: '2000-01-01' });
  assert.equal(getPackage(expired.id).is_valid, false);
  const used = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 1 });
  assert.equal(deductOne(used.id), true);
  assert.equal(getPackage(used.id).is_valid, false); // remaining=0
  const arch = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 3 });
  archivePackage(arch.id);
  assert.equal(getPackage(arch.id).is_valid, false);
});

expect('listValidPackagesForMember：類型篩選 + 排序（最早到期先）', () => {
  db.exec("DELETE FROM customer_packages WHERE member_id="+mid);
  const noExp = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });           // 永久
  const farExp = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, expiresAt: '2099-12-31' });
  const soonExp = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5, expiresAt: '2099-01-01' });
  const other = createPackage({ memberId: mid, sessionType: '1on2', totalSessions: 5 });
  const v1on1 = listValidPackagesForMember(mid, '1on1');
  assert.equal(v1on1.length, 3);
  assert.equal(v1on1[0].id, soonExp.id);   // 最早到期在前
  assert.equal(v1on1[2].id, noExp.id);     // 永久(NULL)排最後
  assert.ok(!v1on1.some(p => p.id === other.id)); // 類型篩掉 1on2
  assert.equal(listValidPackagesForMember(mid, '1on2').length, 1);
  assert.equal(listValidPackagesForMember(mid).length, 4); // 不給類型 → 全有效
});

expect('deductOne：扣到 0 後再扣 → false（原子）', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 2 });
  assert.equal(deductOne(p.id), true);
  assert.equal(deductOne(p.id), true);
  assert.equal(deductOne(p.id), false);
  assert.equal(getPackage(p.id).remaining_sessions, 0);
});

expect('refundOne：+1 不超過 total', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 2 });
  deductOne(p.id); deductOne(p.id);
  assert.equal(refundOne(p.id), true);
  assert.equal(getPackage(p.id).remaining_sessions, 1);
  refundOne(p.id);
  assert.equal(getPackage(p.id).remaining_sessions, 2); // 已滿
  refundOne(p.id);
  assert.equal(getPackage(p.id).remaining_sessions, 2); // 仍封頂
});

expect('adjustRemaining：夾在 0..total，越界 → 400', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  assert.equal(adjustRemaining({ packageId: p.id, remaining: 3 }).remaining_sessions, 3);
  assert.throws(() => adjustRemaining({ packageId: p.id, remaining: 6 }), /invalid_remaining/);
  assert.throws(() => adjustRemaining({ packageId: p.id, remaining: -1 }), /invalid_remaining/);
});

expect('archive/restore：切換 archived_at 與 is_valid', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  archivePackage(p.id);
  assert.ok(getPackage(p.id).archived_at);
  assert.equal(getPackage(p.id).is_valid, false);
  restorePackage(p.id);
  assert.equal(getPackage(p.id).archived_at, null);
  assert.equal(getPackage(p.id).is_valid, true);
});

expect('listPackagesForMember：預設排除作廢、includeArchived 含作廢', () => {
  db.exec("DELETE FROM customer_packages WHERE member_id="+mid);
  const a = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  const b = createPackage({ memberId: mid, sessionType: '1on2', totalSessions: 5 });
  archivePackage(b.id);
  assert.equal(listPackagesForMember(mid).length, 1);
  assert.equal(listPackagesForMember(mid, { includeArchived: true }).length, 2);
});

db.exec("DELETE FROM point_transactions WHERE related_booking_id IS NOT NULL; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM users WHERE email LIKE 'pk-%'");
console.log('[package-service test] done');
