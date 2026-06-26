// getPublicSchedule.packages：方案顯示到「課全上完」才消失；投影 共/已上完/尚餘(永遠≥0)、安全欄位。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { createPackage, deductOne, archivePackage, adjustRemaining } = await import('../src/services/packageService.js');
const { getPublicSchedule } = await import('../src/services/groupOrderService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[my-schedule-packages test] start');
const clean=()=>db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'msp-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'msp-%'); DELETE FROM users WHERE email LIKE 'msp-%'");
clean();
const coachId = db.prepare('SELECT id FROM coaches ORDER BY id LIMIT 1').get().id;
// 每筆 confirmed booking 需 (coach_id,start_at) 唯一（schema: bookings_coach_start_confirmed）→ 用遞增分鐘產不同 start_at。
let seq = 0;
const mkUser=()=>Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','msp-m@x.com','user','0994000001')").run().lastInsertRowid);
const mkBooking=(m,pkg,day,st='confirmed')=>{ const t=String(seq++).padStart(2,'0');
  return db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id) VALUES (?,?,?,?,?,?,?)")
    .run(coachId,m,`${day}T10:${t}:00`,`${day}T11:${t}:00`,st,'1on1',pkg); };
const PAST='2020-01-01', FUT='2099-01-01';
const sched=()=>getPublicSchedule({ phone:'0994000001', name:'方案客' });

expect('無方案 → packages 為 []', () => { mkUser(); assert.deepEqual(sched().packages, []); });

expect('全部登錄完但課在未來 → 仍顯示、已上完0、尚餘=總、安全欄位', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:4, expiresAt:'2099-12-31' });
  for(let i=0;i<4;i++){ deductOne(p.id); mkBooking(u,p.id,FUT); } // remaining=0, 4 未來課
  const pk=sched().packages;
  assert.equal(pk.length,1);
  assert.equal(pk[0].total_sessions,4);
  assert.equal(pk[0].completed_sessions,0);
  assert.equal(pk[0].remaining_sessions,4);  // upcoming4 + 未登錄0
  assert.equal(pk[0].expires_at,'2099-12-31');
  assert.ok(!('amount' in pk[0]) && !('id' in pk[0]) && !('member_id' in pk[0]) && !('used_sessions' in pk[0]) && !('discount_code' in pk[0]));
});

expect('部分已上完 → completed/尚餘正確', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:10 });
  for(let i=0;i<3;i++){ deductOne(p.id); mkBooking(u,p.id,PAST); } // 3 已上完
  for(let i=0;i<2;i++){ deductOne(p.id); mkBooking(u,p.id,FUT); }  // 2 待上 (remaining=5)
  const pk=sched().packages[0];
  assert.equal(pk.total_sessions,10);
  assert.equal(pk.completed_sessions,3);
  assert.equal(pk.remaining_sessions,7);  // upcoming2 + 未登錄5
});

expect('全部已上完 → 不出現（已結束）', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:2 });
  for(let i=0;i<2;i++){ deductOne(p.id); mkBooking(u,p.id,PAST); }
  assert.deepEqual(sched().packages, []);
});

expect('過期但有未來課→顯示(尚餘只算未來課)；過期且無未來課→不顯示', () => {
  clean(); const u=mkUser();
  const ewf=createPackage({ memberId:u, sessionType:'1on1', totalSessions:5, expiresAt:'2000-01-01' });
  deductOne(ewf.id); mkBooking(u,ewf.id,FUT);  // remaining(DB)=4 但已過期→未登錄不計
  createPackage({ memberId:u, sessionType:'1on2', totalSessions:5, expiresAt:'2000-01-01' }); // 過期無未來課
  const pk=sched().packages;
  assert.equal(pk.length,1);
  assert.equal(pk[0].session_type,'1on1');
  assert.equal(pk[0].remaining_sessions,1);  // upcoming1 + 過期未登錄0
});

expect('取消的預約不計；作廢方案不出現', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:3 });
  deductOne(p.id); mkBooking(u,p.id,FUT,'confirmed'); // 1 待上 (remaining=2)
  mkBooking(u,p.id,FUT,'cancelled');                  // 取消不計（partial index 也只管 confirmed）
  const arch=createPackage({ memberId:u, sessionType:'1on2', totalSessions:5 }); archivePackage(arch.id);
  const pk=sched().packages;
  assert.equal(pk.length,1);
  assert.equal(pk[0].completed_sessions,0);
  assert.equal(pk[0].remaining_sessions,3);  // upcoming1 + 未登錄2
});

expect('adjustRemaining 回補後再扣抵 → 尚餘≥0、不為負', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:2 });
  for(let i=0;i<2;i++){ deductOne(p.id); mkBooking(u,p.id,PAST); } // 2 已上完, remaining=0
  adjustRemaining({ packageId:p.id, remaining:2 });                // 管理者回補到 2
  deductOne(p.id); mkBooking(u,p.id,FUT);                          // 再登 1 未來課, remaining=1
  const pk=sched().packages[0];
  assert.equal(pk.completed_sessions,2);            // 過去課 2（=total，不為負）
  assert.equal(pk.remaining_sessions,2);            // upcoming1 + 未登錄1（≥0，未用 total−completed）
  assert.ok(pk.remaining_sessions >= 0);
});

clean();
console.log('[my-schedule-packages test] done');
