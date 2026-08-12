// 改時段 / 改客人方案 service：成功、衝突、權限、退舊扣新、rollback。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createPackage, getPackage, deductOne } = await import('../src/services/packageService.js');
const { rescheduleBooking, reassignBooking, cancelCoachGroup } = await import('../src/services/bookingService.js');
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
expect('cancelCoachGroup：循環群組(含過去)全部取消、回補堂數、回 cancelled', () => {
  const p=createPackage({memberId:m1,sessionType:'1on1',totalSessions:10,amount:10000});
  deductOne(p.id); deductOne(p.id); deductOne(p.id); // 剩7
  const G=7001;
  const mkG=(s,e)=>Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id,paid_at,recurring_group_id) VALUES (?,?,?,?, '1on1', ?, '2026-06-24T00:00:00', ?)").run(coach,m1,s,e,p.id,G).lastInsertRowid);
  const past=mkG('2000-01-01T09:00:00','2000-01-01T10:00:00');
  const future=mkG(`${D}T08:00:00`,`${D}T09:00:00`);
  const before=getPackage(p.id).remaining_sessions; // 7
  const nMemBefore=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop'").get(m1).c;
  const nCoachBefore=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop_coach'").get(cu).c;
  const r=cancelCoachGroup({ bookingId:future, actorUserId:cu, isAdmin:false });
  assert.deepEqual([...r.cancelled].sort((a,b)=>a-b),[past,future].sort((a,b)=>a-b));
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(past).status,'cancelled');
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(future).status,'cancelled');
  assert.equal(getPackage(p.id).remaining_sessions, before+2); // 兩筆都回補
  // 彙整：取消 2 筆 → member 只新增 1 則通知；actor 為教練本人 → coach 通知不新增
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop'").get(m1).c, nMemBefore+1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop_coach'").get(cu).c, nCoachBefore);
});
expect('cancelCoachGroup：非該教練的一般教練 → 403；範圍鎖教練不誤殺他教練同 group', () => {
  const G2=7002;
  const mine=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,recurring_group_id) VALUES (?,?,?,?, '1on1', ?)").run(coach,m1,`${D}T07:00:00`,`${D}T08:00:00`,G2).lastInsertRowid);
  const other=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,recurring_group_id) VALUES (?,?,?,?, '1on1', ?)").run(coach2,m1,`${D}T07:30:00`,`${D}T08:30:00`,G2).lastInsertRowid);
  assert.throws(()=>cancelCoachGroup({ bookingId:mine, actorUserId:cu2, isAdmin:false }),/forbidden/); // cu2 非該筆教練
  const mNB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop'").get(m1).c;
  const cNB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop_coach'").get(cu).c;
  const r=cancelCoachGroup({ bookingId:mine, actorUserId:admin, isAdmin:true });           // 管理者代理
  assert.deepEqual(r.cancelled,[mine]);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(other).status,'confirmed'); // 他教練不受影響
  // 管理者代理 → member 1 則 + 該教練(cu) 1 則
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop'").get(m1).c, mNB+1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop_coach'").get(cu).c, cNB+1);
});
expect('cancelCoachGroup：無 recurring_group_id → 只取消這一筆', () => {
  const single=mkBk(m2,'23');
  const r=cancelCoachGroup({ bookingId:single, actorUserId:cu, isAdmin:false });
  assert.deepEqual(r.cancelled,[single]);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(single).status,'cancelled');
});
expect('cancelCoachGroup：群組已全取消 → 409 already_cancelled', () => {
  const G3=7003;
  const bid=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,status,cancelled_at,recurring_group_id) VALUES (?,?,?,?, '1on1','cancelled','2026-01-01T00:00:00', ?)").run(coach,m1,`${D}T06:00:00`,`${D}T07:00:00`,G3).lastInsertRowid);
  assert.throws(()=>cancelCoachGroup({ bookingId:bid, actorUserId:cu, isAdmin:false }),/already_cancelled/);
});
expect('reschedule 教練本人改期 → 客人通知+1、教練 booking_rescheduled_coach 零新增', () => {
  const bid=mkBk(m1,'10');
  const mB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled'").get(m1).c;
  const cB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T19:00:00`, actorUserId:cu, isAdmin:false });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled'").get(m1).c, mB+1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c, cB);
});
expect('reschedule 管理者代改 → 教練+1、body 含會員名與新舊時段', () => {
  const bid=mkBk(m1,'14');
  const cB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T21:00:00`, actorUserId:admin, isAdmin:true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c, cB+1);
  const row=db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach' ORDER BY id DESC").get(cu);
  assert.ok(row.body.includes('be客1'));
  assert.ok(row.body.includes('14:00')); // 舊時段
  assert.ok(row.body.includes('21:00')); // 新時段
});
expect('reschedule actorUserId=null（gcal 拖拉路徑同參數）→ 教練+1', () => {
  const bid=mkBk(m2,'22');
  const cB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T05:00:00`, actorUserId:null, isAdmin:true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c, cB+1);
});
clean();
console.log('[booking-edit test] done');
