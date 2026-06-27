// getCoachWeek：all 模式回所有教練 bookings(含 coach_name)；單一教練模式不變且帶 coach_name。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { getCoachWeek } = await import('../src/services/coachCalendarService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[coach-week-all test] start');
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cw-%'); DELETE FROM coaches WHERE display_name LIKE 'cw-%'; DELETE FROM users WHERE email LIKE 'cw-%'");
const pad=n=>String(n).padStart(2,'0');
const c1u=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('cw教練A','cw-c1@x.com','coach')").run().lastInsertRowid);
const c1=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'cw-A',1)").run(c1u).lastInsertRowid);
const c2u=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('cw教練B','cw-c2@x.com','coach')").run().lastInsertRowid);
const c2=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'cw-B',1)").run(c2u).lastInsertRowid);
const m=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('cw客','cw-m@x.com','user','0980000001')").run().lastInsertRowid);
const base=new Date(Date.now()+12*86400000);
const toMon=(base.getDay()===0?-6:1-base.getDay());
const mon=new Date(base.getFullYear(),base.getMonth(),base.getDate()+toMon);
const start=`${mon.getFullYear()}-${pad(mon.getMonth()+1)}-${pad(mon.getDate())}`;
const d1=`${start}T09:00:00`, d2=`${start}T10:00:00`;
db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(c1,m,d1,`${start}T10:00:00`);
db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(c2,m,d2,`${start}T11:00:00`);

expect('單一教練：只回該教練 + 帶 coach_name', () => {
  const w=getCoachWeek({coachId:c1,start});
  assert.equal(w.all,false);
  assert.ok(w.bookings.every(b=>b.coach_id===c1));
  assert.equal(w.bookings[0].coach_name,'cw-A');
  assert.ok(Array.isArray(w.availableSlots));
});
expect('all：回所有教練 bookings + coach_name', () => {
  const w=getCoachWeek({start,all:true});
  assert.equal(w.all,true);
  const ids=w.bookings.map(b=>b.coach_id);
  assert.ok(ids.includes(c1)&&ids.includes(c2));
  assert.ok(w.bookings.find(b=>b.coach_id===c2).coach_name==='cw-B');
  assert.deepEqual(w.availableSlots,[]); // all 未給 coachId → 無底色
});
expect('all + coachId：仍回全部 bookings、availableSlots 為該教練', () => {
  const w=getCoachWeek({coachId:c1,start,all:true});
  assert.ok(w.bookings.some(b=>b.coach_id===c2)); // 仍全部
  assert.ok(Array.isArray(w.availableSlots));
});
expect('week：方案預約帶 pkg_* 欄位、非方案預約為 null', () => {
  const pid = Number(db.prepare("INSERT INTO customer_packages (member_id,session_type,total_sessions,remaining_sessions,note,created_at) VALUES (?, '1on1',10,7,'測試備註','2026-01-12 08:00:00')").run(m).lastInsertRowid);
  const d3=`${start}T11:00:00`;
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id) VALUES (?,?,?,?, '1on1', ?)").run(c1,m,d3,`${start}T12:00:00`,pid);
  const w=getCoachWeek({coachId:c1,start});
  const pb=w.bookings.find(b=>b.package_id===pid);
  assert.ok(pb);
  assert.equal(pb.pkg_session_type,'1on1');
  assert.equal(pb.pkg_remaining,7);
  assert.equal(pb.pkg_total,10);
  assert.equal(pb.pkg_created_at,'2026-01-12 08:00:00');
  assert.equal(pb.pkg_note,'測試備註');
  const nb=w.bookings.find(b=>b.package_id==null);
  assert.ok(nb);
  assert.equal(nb.pkg_session_type,null);
  assert.equal(nb.pkg_total,null);
});

db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cw-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cw-%'); DELETE FROM coaches WHERE display_name LIKE 'cw-%'; DELETE FROM users WHERE email LIKE 'cw-%'");
console.log('[coach-week-all test] done');
