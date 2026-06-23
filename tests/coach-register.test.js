// 登錄 service：單筆扣堂+自動已核對+package_id+original_amount；循環用罄即停；衝突跳過；類型/方案守門。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createPackage, getPackage } = await import('../src/services/packageService.js');
const { previewCoachRegister, createCoachRegister } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[coach-register test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM coaches WHERE display_name LIKE 'reg-%'; DELETE FROM users WHERE email LIKE 'reg-%'");
const pad = n => String(n).padStart(2,'0');
const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('reg教練','reg-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'reg-coach', 1)").run(cuid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('reg客','reg-m@x.com','user','0971000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('reg管','reg-a@x.com','coach',1)").run().lastInsertRowid);
// 未來日期（避免與既有衝突）
const base = new Date(Date.now()+10*86400000);
const D = `${base.getFullYear()}-${pad(base.getMonth()+1)}-${pad(base.getDate())}`;

expect('單筆登錄：扣 1 堂、自動已核對、寫 package_id/original_amount', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:10, amount:15000 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T09:00:00`, recurrence:null, actorId: admin });
  assert.equal(r.created.length, 1);
  assert.equal(getPackage(p.id).remaining_sessions, 9);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.created[0].id);
  assert.equal(b.package_id, p.id);
  assert.ok(b.paid_at); assert.equal(b.paid_by, admin);
  assert.equal(b.session_type, '1on1');
  assert.equal(b.original_amount, 1500); // 15000/10
});
expect('不存在方案 → 404 package_not_found', () => {
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: 999999, startAt:`${D}T11:00:00`, recurrence:null, actorId: admin }), /package_not_found/);
});
expect('session_type 由方案決定（1on2 方案 → 預約 1on2）', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on2', totalSessions:5 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T11:00:00`, recurrence:null, actorId: admin });
  assert.equal(db.prepare('SELECT session_type FROM bookings WHERE id=?').get(r.created[0].id).session_type, '1on2');
});
expect('方案不屬該客人 → 擋', () => {
  const other = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('reg別','reg-x@x.com','user','0971000099')").run().lastInsertRowid);
  const p = createPackage({ memberId: other, sessionType:'1on1', totalSessions:5 });
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T12:00:00`, recurrence:null, actorId: admin }), /package_member_mismatch|invalid_package/);
});
expect('循環：方案剩餘不足 → 只建立到用罄為止', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:2 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T14:00:00`,
    recurrence:{ frequency:'daily', end:{type:'count',count:5} }, actorId: admin });
  assert.equal(r.created.length, 2);             // 只建立 2 筆（堂數 2）
  assert.equal(getPackage(p.id).remaining_sessions, 0);
  assert.ok(r.created.every(c => c));
  const grp = db.prepare('SELECT recurring_group_id FROM bookings WHERE id=?').get(r.created[0].id).recurring_group_id;
  assert.equal(grp, r.created[0].id);            // group = 首筆
});
expect('循環：衝突場次跳過不扣', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:5 });
  // 先佔一個未來時段（同教練），讓循環第二筆衝突
  const clashDay = new Date(Date.now()+20*86400000); const CD = `${clashDay.getFullYear()}-${pad(clashDay.getMonth()+1)}-${pad(clashDay.getDate())}`;
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(coachId, admin, `${CD}T08:00:00`, `${CD}T09:00:00`);
  const nextDay = new Date(clashDay.getTime()+86400000); const ND = `${nextDay.getFullYear()}-${pad(nextDay.getMonth()+1)}-${pad(nextDay.getDate())}`;
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${CD}T08:00:00`,
    recurrence:{ frequency:'daily', end:{type:'count',count:2} }, actorId: admin });
  // 第1筆衝突跳過、第2筆建立 → 扣 1
  assert.equal(r.skipped.some(s => s.reason==='conflict'), true);
  assert.equal(r.created.length, 1);
  assert.equal(getPackage(p.id).remaining_sessions, 4);
});
expect('preview：標 ok/conflict/depleted，回 willCreate/willDeduct', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:1 });
  const futureDay = new Date(Date.now()+40*86400000); const FD = `${futureDay.getFullYear()}-${pad(futureDay.getMonth()+1)}-${pad(futureDay.getDate())}`;
  const pv = previewCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${FD}T07:00:00`, recurrence:{ frequency:'daily', end:{type:'count',count:3} } });
  assert.equal(pv.occurrences.length, 3);
  assert.equal(pv.occurrences[0].status, 'ok');
  assert.equal(pv.occurrences[1].status, 'depleted'); // 方案只剩 1
  assert.equal(pv.willCreate, 1); assert.equal(pv.willDeduct, 1);
});
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM coaches WHERE display_name LIKE 'reg-%'; DELETE FROM users WHERE email LIKE 'reg-%'");
console.log('[coach-register test] done');
