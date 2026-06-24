// 改時段 / 改客人方案 service：成功、衝突、權限、退舊扣新、rollback。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createPackage, getPackage, deductOne } = await import('../src/services/packageService.js');
const { rescheduleBooking, reassignBooking } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-edit test] start');
const clean=()=>db.exec("DELETE FROM discount_redemptions WHERE code_id IN (SELECT id FROM discount_codes WHERE code LIKE 'BE%'); DELETE FROM discount_codes WHERE code LIKE 'BE%'; DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'be-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'be-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'be-%'); DELETE FROM coaches WHERE display_name LIKE 'be-%'; DELETE FROM users WHERE email LIKE 'be-%'");
clean();
const pad=n=>String(n).padStart(2,'0');
const cu=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('be教練','be-c@x.com','coach')").run().lastInsertRowid);
const coach=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'be-coach',1)").run(cu).lastInsertRowid);
const cu2=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('be教練2','be-c2@x.com','coach')").run().lastInsertRowid);
const coach2=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'be-coach2',1)").run(cu2).lastInsertRowid);
const m1=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('be客1','be-m1@x.com','user','0981000001')").run().lastInsertRowid);
const m2=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('be客2','be-m2@x.com','user','0981000002')").run().lastInsertRowid);
const admin=Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('be管','be-a@x.com','coach',1)").run().lastInsertRowid);
const D=`${new Date(Date.now()+13*86400000).getFullYear()}-${pad(new Date(Date.now()+13*86400000).getMonth()+1)}-${pad(new Date(Date.now()+13*86400000).getDate())}`;
const mkBk=(memberId,hh,pkgId=null,sType='1on1')=>Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id,paid_at) VALUES (?,?,?,?,?,?,?)").run(coach,memberId,`${D}T${hh}:00:00`,`${D}T${String(Number(hh)+1).padStart(2,'0')}:00:00`,sType,pkgId,pkgId?'2026-06-24T00:00:00':null).lastInsertRowid);

expect('reschedule：移到新整點、member/package 不變', () => {
  const bid=mkBk(m1,'09');
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T15:00:00`, actorUserId:cu, isAdmin:false });
  const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
  assert.equal(b.start_at,`${D}T15:00:00`); assert.equal(b.end_at,`${D}T16:00:00`); assert.equal(b.member_id,m1);
});
expect('reschedule 衝突 → 409 slot_taken', () => {
  mkBk(m2,'11'); const bid=mkBk(m1,'12');
  assert.throws(()=>rescheduleBooking({ bookingId:bid, newStartAt:`${D}T11:00:00`, actorUserId:cu, isAdmin:false }),/slot_taken/);
});
expect('reschedule 一般教練改他人預約 → 403', () => {
  const other=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(coach2,m1,`${D}T09:00:00`,`${D}T10:00:00`).lastInsertRowid);
  assert.throws(()=>rescheduleBooking({ bookingId:other, newStartAt:`${D}T18:00:00`, actorUserId:cu, isAdmin:false }),/forbidden/);
});
expect('reassign 方案↔方案：退舊+扣新+type/單價', () => {
  const pOld=createPackage({memberId:m1,sessionType:'1on1',totalSessions:5,amount:5000}); deductOne(pOld.id); // 剩4
  const pNew=createPackage({memberId:m2,sessionType:'1on2',totalSessions:10,amount:20000});                 // 剩10
  const bid=mkBk(m1,'09',pOld.id,'1on1');
  reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true });
  assert.equal(getPackage(pOld.id).remaining_sessions,5); // 退回
  assert.equal(getPackage(pNew.id).remaining_sessions,9); // 扣 1
  const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
  assert.equal(b.member_id,m2); assert.equal(b.package_id,pNew.id); assert.equal(b.session_type,'1on2');
  assert.equal(b.original_amount,2000); assert.ok(b.paid_at);
});
expect('reassign 非方案→方案：設 paid_at、清折扣、扣新', () => {
  const pNew=createPackage({memberId:m2,sessionType:'1on1',totalSessions:3,amount:3000});
  const bid=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,original_amount,discount_code,discount_amount) VALUES (?,?,?,?, '1on1', 1500,'X',100)").run(coach,m1,`${D}T13:00:00`,`${D}T14:00:00`).lastInsertRowid);
  reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true });
  const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
  assert.equal(b.package_id,pNew.id); assert.equal(b.member_id,m2); assert.equal(b.discount_code,null); assert.ok(b.paid_at);
  assert.equal(getPackage(pNew.id).remaining_sessions,2);
});
expect('reassign 方案不屬新客人 → 400', () => {
  const p=createPackage({memberId:m1,sessionType:'1on1',totalSessions:3});
  const bid=mkBk(m1,'16');
  assert.throws(()=>reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:p.id, actorUserId:admin, isAdmin:true }),/package_member_mismatch/);
});
expect('reassign 方案已用罄(is_valid=false) → 409 package_invalid，且未誤退舊', () => {
  const pOld=createPackage({memberId:m1,sessionType:'1on1',totalSessions:5}); deductOne(pOld.id); // 剩4
  const pNew=createPackage({memberId:m2,sessionType:'1on1',totalSessions:1}); deductOne(pNew.id); // 剩0 → is_valid=false
  const bid=mkBk(m1,'17',pOld.id);
  // 用罄方案 is_valid=false → reassign 在 is_valid 檢查就擋 package_invalid（早於退舊/扣新；package_depleted 為防禦、單執行緒不可達）
  assert.throws(()=>reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true }),/package_invalid/);
  assert.equal(getPackage(pOld.id).remaining_sessions,4); // 早於退舊就丟 → 未誤退
  assert.equal(getPackage(pNew.id).remaining_sessions,0);
});
expect('reschedule 已取消預約 → 409 already_cancelled', () => {
  const bid=mkBk(m1,'18');
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bid);
  assert.throws(()=>rescheduleBooking({ bookingId:bid, newStartAt:`${D}T19:00:00`, actorUserId:cu, isAdmin:false }),/already_cancelled/);
});
expect('reassign 折扣碼非方案預約 → 釋放舊折扣 redemption', () => {
  const codeId=Number(db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('BE10','percent',10,1)").run().lastInsertRowid);
  const bid=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,original_amount,discount_code,discount_amount) VALUES (?,?,?,?, '1on1',1500,'BE10',150)").run(coach,m1,`${D}T20:00:00`,`${D}T21:00:00`).lastInsertRowid);
  db.prepare("INSERT INTO discount_redemptions (code_id,phone,kind,ref_id,amount) VALUES (?, '0981000001','booking',?,150)").run(codeId,bid);
  const pNew=createPackage({memberId:m2,sessionType:'1on1',totalSessions:3,amount:3000});
  reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM discount_redemptions WHERE kind='booking' AND ref_id=?").get(bid).c, 0); // 已釋放
});
clean();
console.log('[booking-edit test] done');
