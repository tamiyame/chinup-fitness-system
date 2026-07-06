// 方案單價：修正單價（回寫已登錄堂）＋消耗欄位（completed/upcoming_sessions）＋我的課表統計（stats）。
// 資料鎖 2034 年（避免未來某天變成「過去」造成 flaky）；測試資料一律用 'up-%' email 前綴。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const {
  createPackage, getPackage, listPackagesForMember, archivePackage, updateUnitPrice,
} = await import('../src/services/packageService.js');
const { getPublicSchedule } = await import('../src/services/groupOrderService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[package-unit-price test] start');

const PAST = '2020-01-01';
const FUT = '2034-06-15'; // 資料鎖 2034 年：遠在未來，避免隨真實時間流逝變成「過去」

const clean = () => db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'up-%');
  DELETE FROM point_transactions WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'up-%') OR actor_id IN (SELECT id FROM users WHERE email LIKE 'up-%');
  DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'up-%');
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'up-%') OR coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'up-%'));
  DELETE FROM course_templates WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'up-%'));
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'up-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'up-%');
  DELETE FROM users WHERE email LIKE 'up-%';
`);
clean();

const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('單價客','up-m@x.com','user','0993000001')").run().lastInsertRowid);
const cu = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('單價教練','up-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, '單價教練',1)").run(cu).lastInsertRowid);

// ------------------------------------------------------------------
// 案例 1+2：updateUnitPrice
// ------------------------------------------------------------------
let pkgId, bidPast1, bidPast2, bidFut, bidCancelled;
expect('updateUnitPrice：改 amount、清 discount_code、回寫全部 confirmed 堂(含過去)、cancelled 不動、rewrittenBookings 計數正確', () => {
  const p = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 10, amount: 9999 });
  db.prepare("UPDATE customer_packages SET discount_code='X' WHERE id=?").run(p.id);
  pkgId = p.id;

  bidPast1 = Number(db.prepare(
    "INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id,original_amount) VALUES (?,?,?,?, 'confirmed','1on1', ?, 999)"
  ).run(coachId, mid, `${PAST}T09:00:00`, `${PAST}T10:00:00`, pkgId).lastInsertRowid);
  bidPast2 = Number(db.prepare(
    "INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id,original_amount) VALUES (?,?,?,?, 'confirmed','1on1', ?, 999)"
  ).run(coachId, mid, `${PAST}T11:00:00`, `${PAST}T12:00:00`, pkgId).lastInsertRowid);
  bidFut = Number(db.prepare(
    "INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id,original_amount) VALUES (?,?,?,?, 'confirmed','1on1', ?, 999)"
  ).run(coachId, mid, `${FUT}T09:00:00`, `${FUT}T10:00:00`, pkgId).lastInsertRowid);
  bidCancelled = Number(db.prepare(
    "INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id,original_amount,cancelled_at) VALUES (?,?,?,?, 'cancelled','1on1', ?, 999, '2020-01-01T00:00:00')"
  ).run(coachId, mid, `${FUT}T11:00:00`, `${FUT}T12:00:00`, pkgId).lastInsertRowid);

  const r = updateUnitPrice({ packageId: pkgId, unitPrice: 1500 });
  assert.equal(r.ok, true);
  assert.equal(r.amount, 15000);
  assert.equal(r.unitPrice, 1500);
  assert.equal(r.rewrittenBookings, 3);

  const pkg = getPackage(pkgId);
  assert.equal(pkg.amount, 15000);
  assert.equal(pkg.discount_code, null);

  for (const bid of [bidPast1, bidPast2, bidFut]) {
    assert.equal(db.prepare('SELECT original_amount FROM bookings WHERE id=?').get(bid).original_amount, 1500);
  }
  assert.equal(db.prepare('SELECT original_amount FROM bookings WHERE id=?').get(bidCancelled).original_amount, 999); // cancelled 不動
});

expect('updateUnitPrice：unitPrice=0 合法（amount=0、無堂可回寫→rewrittenBookings=0）；-1/1.5/\'x\' → invalid_unit_price；查無方案 → package_not_found', () => {
  const p2 = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 5 });
  const r0 = updateUnitPrice({ packageId: p2.id, unitPrice: 0 });
  assert.equal(r0.ok, true);
  assert.equal(r0.amount, 0);
  assert.equal(r0.unitPrice, 0);
  assert.equal(r0.rewrittenBookings, 0);
  assert.equal(getPackage(p2.id).amount, 0);

  assert.throws(() => updateUnitPrice({ packageId: p2.id, unitPrice: -1 }), /invalid_unit_price/);
  assert.throws(() => updateUnitPrice({ packageId: p2.id, unitPrice: 1.5 }), /invalid_unit_price/);
  assert.throws(() => updateUnitPrice({ packageId: p2.id, unitPrice: 'x' }), /invalid_unit_price/);
  assert.throws(() => updateUnitPrice({ packageId: 999999999, unitPrice: 100 }), /package_not_found/);
});

// ------------------------------------------------------------------
// 案例 3：listPackagesForMember 消耗欄位
// ------------------------------------------------------------------
expect('listPackagesForMember：completed_sessions/upcoming_sessions 正確；無預約方案兩欄=0；includeArchived 含作廢列且欄位存在', () => {
  const rows = listPackagesForMember(mid);
  const row = rows.find((r) => r.id === pkgId);
  assert.ok(row, '應找到案例1的方案');
  assert.equal(row.completed_sessions, 2); // bidPast1 + bidPast2
  assert.equal(row.upcoming_sessions, 1);  // bidFut

  const noBookingPkg = createPackage({ memberId: mid, sessionType: '1on2', totalSessions: 3 });
  const row2 = listPackagesForMember(mid).find((r) => r.id === noBookingPkg.id);
  assert.ok(row2);
  assert.equal(row2.completed_sessions, 0);
  assert.equal(row2.upcoming_sessions, 0);

  const arch = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 2 });
  archivePackage(arch.id);
  assert.ok(!listPackagesForMember(mid).some((r) => r.id === arch.id)); // 預設排除作廢
  const withArch = listPackagesForMember(mid, { includeArchived: true });
  const archRow = withArch.find((r) => r.id === arch.id);
  assert.ok(archRow, 'includeArchived 應含作廢列');
  assert.ok('completed_sessions' in archRow && 'upcoming_sessions' in archRow);
  assert.equal(archRow.completed_sessions, 0);
  assert.equal(archRow.upcoming_sessions, 0);
});

// ------------------------------------------------------------------
// 案例 4：我的課表 stats（getPublicSchedule）
// ------------------------------------------------------------------
expect('getPublicSchedule stats：one_done/group_done/leave_count/one_upcoming 正確；group_upcoming 與既有 group_remaining 同值', () => {
  const cu2 = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('單價統計教練','up-c2@x.com','coach')").run().lastInsertRowid);
  const coach2Id = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, '單價統計教練',1)").run(cu2).lastInsertRowid);
  const su = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('統計客','up-sched@x.com','user','0993009999')").run().lastInsertRowid);

  // 個別課：confirmed 過去2、未來1
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type) VALUES (?,?,?,?, 'confirmed','1on1')")
    .run(coach2Id, su, '2020-03-01T09:00:00', '2020-03-01T10:00:00');
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type) VALUES (?,?,?,?, 'confirmed','1on1')")
    .run(coach2Id, su, '2020-03-01T11:00:00', '2020-03-01T12:00:00');
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type) VALUES (?,?,?,?, 'confirmed','1on1')")
    .run(coach2Id, su, `${FUT}T09:00:00`, `${FUT}T10:00:00`);

  // 團課：1 confirmed 過去(非請假)、1 請假(過去)、1 pending(未來)、1 confirmed 過去但場次已取消
  const tid = Number(db.prepare(
    `INSERT INTO course_templates (name,min_capacity,max_capacity,day_of_week,start_time,duration_minutes,recurrence,cycle_start_date,cycle_end_date,registration_deadline_hours,status,price_per_session,coach_id)
     VALUES ('單價統計課',1,10,3,'10:00',60,'weekly','2020-01-01','2099-01-01',24,'published',500,?)`
  ).run(coach2Id).lastInsertRowid);
  const mkSession = (day, status) => Number(db.prepare(
    'INSERT INTO course_sessions (template_id,session_date,start_at,end_at,registration_deadline,status,coach_id) VALUES (?,?,?,?,?,?,?)'
  ).run(tid, day, `${day}T10:00:00`, `${day}T11:00:00`, `${day}T09:00:00`, status, coach2Id).lastInsertRowid);
  const sessDone = mkSession('2020-04-01', 'open');
  const sessLeave = mkSession('2020-04-02', 'open');
  const sessPending = mkSession(FUT, 'open');
  const sessCancelled = mkSession('2020-04-03', 'cancelled');

  const insReg = db.prepare('INSERT INTO registrations (session_id,user_id,status,on_leave) VALUES (?,?,?,?)');
  insReg.run(sessDone, su, 'confirmed', 0);
  insReg.run(sessLeave, su, 'confirmed', 1);
  insReg.run(sessPending, su, 'pending', 0);
  insReg.run(sessCancelled, su, 'confirmed', 0);

  const result = getPublicSchedule({ phone: '0993009999', name: '統計客' });
  assert.ok(result.stats);
  assert.equal(result.stats.one_done, 2);
  assert.equal(result.stats.group_done, 1);      // 請假/pending/場次取消都不計
  assert.equal(result.stats.leave_count, 1);
  assert.equal(result.stats.one_upcoming, 1);
  assert.equal(result.stats.one_upcoming, result.one_on_one_remaining);
  assert.equal(result.stats.group_upcoming, result.group_remaining);
});

clean();
console.log('[package-unit-price test] done');
