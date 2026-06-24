// getPublicSchedule.packages：只回有效方案、used=total-remaining、安全欄位、無方案→[]。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { createPackage, deductOne, archivePackage } = await import('../src/services/packageService.js');
const { getPublicSchedule } = await import('../src/services/groupOrderService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[my-schedule-packages test] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'msp-%'); DELETE FROM users WHERE email LIKE 'msp-%'");
clean();
const u=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('陳筱蘋','msp-m@x.com','user','0994000001')").run().lastInsertRowid);

expect('無方案 → packages 為 []', () => {
  const r = getPublicSchedule({ phone: '0994000001', name: '陳筱蘋' });
  assert.deepEqual(r.packages, []);
});
expect('有效方案：總/已登錄(=扣抵)/剩餘 + 只含安全欄位', () => {
  const p = createPackage({ memberId: u, sessionType: '1on1', totalSessions: 10, amount: 15000, expiresAt: '2099-12-31' });
  deductOne(p.id); deductOne(p.id); deductOne(p.id); // 已登錄 3 → 剩 7
  const r = getPublicSchedule({ phone: '0994000001', name: '陳筱蘋' });
  assert.equal(r.packages.length, 1);
  const pk = r.packages[0];
  assert.equal(pk.session_type, '1on1');
  assert.equal(pk.total_sessions, 10);
  assert.equal(pk.used_sessions, 3);
  assert.equal(pk.remaining_sessions, 7);
  assert.equal(pk.expires_at, '2099-12-31');
  // 安全：不洩 amount/discount_code/id/member_id
  assert.ok(!('amount' in pk) && !('discount_code' in pk) && !('id' in pk) && !('member_id' in pk));
});
expect('用罄/過期/作廢方案不出現', () => {
  clean(); const u2=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('陳筱蘋','msp-m@x.com','user','0994000001')").run().lastInsertRowid);
  const used = createPackage({ memberId: u2, sessionType: '1on1', totalSessions: 1 }); deductOne(used.id); // 剩0
  const expired = createPackage({ memberId: u2, sessionType: '1on2', totalSessions: 5, expiresAt: '2000-01-01' });
  const arch = createPackage({ memberId: u2, sessionType: '1on1', totalSessions: 5 }); archivePackage(arch.id);
  const valid = createPackage({ memberId: u2, sessionType: '1on2', totalSessions: 8 });
  const r = getPublicSchedule({ phone: '0994000001', name: '陳筱蘋' });
  assert.equal(r.packages.length, 1);
  assert.equal(r.packages[0].session_type, '1on2');
  assert.equal(r.packages[0].total_sessions, 8);
});
clean();
console.log('[my-schedule-packages test] done');
