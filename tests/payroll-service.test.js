// 薪資計算 service：期別解析/預設期/邊界/級距回溯/折扣/無單價/取消排除/團課規則/教練清單/設定生效。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/services/discountService.js');
const { periodRange, defaultPeriod, computePayroll } = await import('../src/services/payrollService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payroll-service test] start');

// ── 清理本測試資料（範圍鎖 2031 年，避免碰其他測試）──
db.exec(`
  DELETE FROM registrations WHERE session_id IN (SELECT id FROM course_sessions WHERE start_at LIKE '2031-%');
  DELETE FROM group_order_refunds WHERE order_id IN (SELECT id FROM group_orders WHERE customer_name LIKE 'PR%');
  DELETE FROM group_orders WHERE customer_name LIKE 'PR%';
  DELETE FROM course_sessions WHERE start_at LIKE '2031-%';
  DELETE FROM course_templates WHERE name LIKE 'PR測試%';
  DELETE FROM bookings WHERE start_at LIKE '2031-%';
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pr-%'));
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
  DELETE FROM users WHERE email LIKE 'pr-%';
`);

// ── 期別工具 ──
expect('periodRange：2031-02 → 2031-01-06 ~ 2031-02-06（不含）', () => {
  const r = periodRange('2031-02');
  assert.equal(r.lo, '2031-01-06T00:00:00');
  assert.equal(r.hi, '2031-02-06T00:00:00');
  assert.equal(r.displayStart, '2031-01-06');
  assert.equal(r.displayEnd, '2031-02-05');
});
expect('periodRange：1 月跨年', () => {
  const r = periodRange('2031-01');
  assert.equal(r.lo, '2030-12-06T00:00:00');
  assert.equal(r.hi, '2031-01-06T00:00:00');
});
expect('periodRange：格式不合 → invalid_period', () => {
  assert.throws(() => periodRange('2031-13'), /invalid_period/);
  assert.throws(() => periodRange('2031/02'), /invalid_period/);
  assert.throws(() => periodRange(''), /invalid_period/);
});
expect('defaultPeriod：日≤5 當月、≥6 次月、12月跨年', () => {
  assert.equal(defaultPeriod('2026-07-03T10:00:00'), '2026-07');
  assert.equal(defaultPeriod('2026-07-05T23:59:59'), '2026-07');
  assert.equal(defaultPeriod('2026-07-06T00:00:00'), '2026-08');
  assert.equal(defaultPeriod('2026-12-10T08:00:00'), '2027-01');
});

// ── 建測試資料 ──
const uid = (name, email) => Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?,?,'user',NULL)").run(name, email).lastInsertRowid);
const cuid = (email) => Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練帳','"+email+"','coach')").run().lastInsertRowid);
const mkCoach = (email, name, active) => Number(db.prepare('INSERT INTO coaches (user_id, display_name, is_active) VALUES (?,?,?)').run(cuid(email), name, active).lastInsertRowid);

const coachA = mkCoach('pr-a@x.com', 'PR教練A', 1);   // 一對一主角
const coachB = mkCoach('pr-b@x.com', 'PR教練B', 1);   // 團課主角
const coachC = mkCoach('pr-c@x.com', 'PR教練C', 0);   // 停用、無資料 → 不列
const coachD = mkCoach('pr-d@x.com', 'PR教練D', 0);   // 停用、有資料 → 列出
const m1 = uid('PR會員一', 'pr-m1@x.com');
const m2 = uid('PR會員二', 'pr-m2@x.com');

const addBooking = ({ coach = coachA, member = m1, startAt, orig = 1000, disc = null, status = 'confirmed', type = '1on1', pkg = null }) =>
  db.prepare(`INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type, original_amount, discount_amount, package_id)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(coach, member, startAt, startAt.slice(0, 11) + String(Number(startAt.slice(11, 13)) + 1).padStart(2, '0') + startAt.slice(13), status, type, orig, disc, pkg);

// 邊界：期外兩筆、期內兩端
addBooking({ startAt: '2031-01-05T23:00:00' });                  // 前一期 → 不算
addBooking({ startAt: '2031-02-06T00:00:00' });                  // 下一期 → 不算
addBooking({ startAt: '2031-01-06T00:00:00' });                  // 期內（下界）
addBooking({ startAt: '2031-02-05T21:00:00' });                  // 期內（上界日）
// 折扣（1對2）：2000-200=1800
addBooking({ startAt: '2031-01-07T10:00:00', orig: 2000, disc: 200, type: '1on2' });
// 無單價：計0、unpriced+1
addBooking({ startAt: '2031-01-08T10:00:00', orig: null, member: m2 });
// 取消：不算
addBooking({ startAt: '2031-01-09T10:00:00', status: 'cancelled' });
// 停用教練 D 一筆 → 需列出
addBooking({ coach: coachD, startAt: '2031-01-10T10:00:00', orig: 1500 });

const find = (r, id) => r.coaches.find((c) => c.coachId === id);

expect('邊界與彙總：A=4堂（2×1000+1800+0）、取消/期外排除、unpriced=1', () => {
  const r = computePayroll({ period: '2031-02' });
  const a = find(r, coachA);
  assert.equal(a.oneOnOne.sessions, 4);
  assert.equal(a.oneOnOne.revenue, 3800);
  assert.equal(a.oneOnOne.unpriced, 1);
  assert.equal(a.oneOnOne.pct, 50);                       // 4 ≤ 40
  assert.equal(a.oneOnOne.salary, 1900);
  assert.equal(a.oneOnOne.details.length, 4);
  const d1on2 = a.oneOnOne.details.find((d) => d.sessionType === '1on2');
  assert.equal(d1on2.amount, 1800);
  assert.equal(d1on2.source, 'walkin');
});
expect('教練清單：啟用0堂列出、停用有資料列出、停用無資料不列', () => {
  const r = computePayroll({ period: '2031-02' });
  assert.ok(find(r, coachB));                              // 啟用、0 堂
  assert.equal(find(r, coachB).oneOnOne.sessions, 0);
  assert.ok(find(r, coachD));                              // 停用、有資料
  assert.equal(find(r, coachD).isActive, 0);
  assert.equal(find(r, coachC), undefined);                // 停用、無資料
});

// ── 級距（用設定門檻縮小到 5，避免灌 41 筆）──
setSetting('payroll_tier_threshold', '5');
expect('級距：恰=門檻 → 低比例', () => {
  addBooking({ startAt: '2031-01-11T10:00:00' });          // A 第 5 堂（confirmed）
  const a = find(computePayroll({ period: '2031-02' }), coachA);
  assert.equal(a.oneOnOne.sessions, 5);
  assert.equal(a.oneOnOne.pct, 50);
});
expect('級距：>門檻 → 全部堂數回溯高比例', () => {
  addBooking({ startAt: '2031-01-12T10:00:00' });          // A 第 6 堂
  const a = find(computePayroll({ period: '2031-02' }), coachA);
  assert.equal(a.oneOnOne.sessions, 6);
  assert.equal(a.oneOnOne.pct, 60);
  assert.equal(a.oneOnOne.salary, Math.round(a.oneOnOne.revenue * 0.6));
});
expect('級距比例設定生效（pctHigh 70）', () => {
  setSetting('payroll_pct_high', '70');
  const a = find(computePayroll({ period: '2031-02' }), coachA);
  assert.equal(a.oneOnOne.pct, 70);
});
setSetting('payroll_tier_threshold', '40');                // 還原
setSetting('payroll_pct_high', '60');

// ── 團課 ──
const tplId = Number(db.prepare(`
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence,
    cycle_start_date, cycle_end_date, price_per_session, coach_id)
  VALUES ('PR測試團課', 1, 10, 1, '19:00', 'weekly', '2031-01-01', '2031-03-01', 400, ?)`).run(coachB).lastInsertRowid);
const mkSession = (startAt, status = 'open', coach = coachB) => Number(db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
  VALUES (?,?,?,?,?,?,?)`).run(tplId, startAt.slice(0, 10), startAt, startAt.slice(0, 11) + '20:00:00', startAt, status, coach).lastInsertRowid);
const mkReg = (sessionId, userId, { status = 'confirmed', amountDue = 400, onLeave = 0 } = {}) =>
  db.prepare('INSERT INTO registrations (session_id, user_id, status, amount_due, on_leave) VALUES (?,?,?,?,?)')
    .run(sessionId, userId, status, amountDue, onLeave);

const gm = [];
for (let i = 0; i < 5; i++) gm.push(uid(`PR團員${i}`, `pr-g${i}@x.com`));
const s1 = mkSession('2031-01-13T19:00:00');
mkReg(s1, gm[0]); mkReg(s1, gm[1]);                              // 2 名 confirmed ×400
mkReg(s1, gm[2], { onLeave: 1 });                                 // 請假 → 排除
mkReg(s1, gm[3], { status: 'cancelled' });                        // 取消 → 排除
mkReg(s1, gm[4], { amountDue: null });                            // NULL → 回退範本價 400
const s2 = mkSession('2031-01-20T19:00:00', 'cancelled');
mkReg(s2, gm[0]);                                                 // 取消場次 → 整場排除
mkSession('2031-02-10T19:00:00');                                 // 期外場次 → 排除

expect('團課：confirmed 且非請假 ×COALESCE(amount_due,範本價)、取消場次/期外排除、固定 50%', () => {
  const b = find(computePayroll({ period: '2031-02' }), coachB);
  assert.equal(b.group.headcount, 3);                       // gm0+gm1+gm4
  assert.equal(b.group.revenue, 1200);                      // 400×3
  assert.equal(b.group.pct, 50);
  assert.equal(b.group.salary, 600);
  assert.equal(b.group.details.length, 1);                  // 只有 s1
  assert.equal(b.group.details[0].courseName, 'PR測試團課');
  assert.equal(b.total, b.oneOnOne.salary + 600);
});
expect('團課比例不受一對一級距影響（groupPct 40 生效）', () => {
  setSetting('payroll_group_pct', '40');
  const b = find(computePayroll({ period: '2031-02' }), coachB);
  assert.equal(b.group.salary, 480);
});
setSetting('payroll_group_pct', '50');                      // 還原（放 expect 外，斷言失敗也保證執行）
// 零報名場次建在上面 details.length===1 斷言之後，該斷言維持不變
const s0 = mkSession('2031-01-27T19:00:00');                      // 期內、open、零報名
expect('零報名場次：列於明細（headcount=0/revenue=0）、不白計範本價營收', () => {
  const b = find(computePayroll({ period: '2031-02' }), coachB);
  const d0 = b.group.details.find((d) => d.sessionId === s0);
  assert.ok(d0);                                            // 誠實呈現：仍列於明細
  assert.equal(d0.headcount, 0);
  assert.equal(d0.revenue, 0);
  assert.equal(b.group.details.length, 2);                  // s1 + 零報名場次
  assert.equal(b.group.revenue, 1200);                      // 不因零報名場次增加
  assert.equal(b.group.salary, 600);                        // groupPct 50 維持原值
});
// ── 覆蓋補強：捨入、實收下限、future、方案來源（都掛在 coachD 上，不影響前面斷言）──
expect('salary 四捨五入（1250.5 → 1251，floor 會是 1250）', () => {
  addBooking({ coach: coachD, member: m2, startAt: '2031-01-15T10:00:00', orig: 1001 });
  const d = find(computePayroll({ period: '2031-02' }), coachD);
  assert.equal(d.oneOnOne.revenue, 2501);                   // 1500 + 1001
  assert.equal(d.oneOnOne.salary, 1251);                    // Math.round(2501 × 50%)
});
expect('折扣大於原價 → 實收下限 0', () => {
  addBooking({ coach: coachD, member: m2, startAt: '2031-01-16T10:00:00', orig: 100, disc: 200 });
  const d = find(computePayroll({ period: '2031-02' }), coachD);
  assert.equal(d.oneOnOne.sessions, 3);
  assert.equal(d.oneOnOne.revenue, 2501);                   // +0，不得為負
});
expect('future = 全部堂數（2031 皆未上課）；方案登錄 source=package', () => {
  const pkgId = Number(db.prepare(
    "INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount) VALUES (?, '1on1', 10, 9, 10000)"
  ).run(m2).lastInsertRowid);
  addBooking({ coach: coachD, member: m2, startAt: '2031-01-17T10:00:00', orig: 1000, pkg: pkgId });
  const d = find(computePayroll({ period: '2031-02' }), coachD);
  assert.equal(d.oneOnOne.future, d.oneOnOne.sessions);     // 每筆 detail 的 future 加總
  const pk = d.oneOnOne.details.find((x) => x.source === 'package');
  assert.ok(pk);
  assert.equal(pk.amount, 1000);
  assert.ok(d.oneOnOne.details.every((x) => x.future === true));
});
expect('totals = 各教練加總', () => {
  const r = computePayroll({ period: '2031-02' });
  const sum = r.coaches.reduce((s, c) => s + c.total, 0);
  assert.equal(r.totals.total, sum);
  assert.equal(r.totals.groupRevenue, r.coaches.reduce((s, c) => s + c.group.revenue, 0));
});

// ── 駐場時薪整合 ──
{
  const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('PR駐場','pr-shift@x.com','coach')").run().lastInsertRowid);
  const cid = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active, hourly_rate) VALUES (?, 'PR駐場', 1, 500)").run(uid).lastInsertRowid);
  // created_by 用本段自建的 uid（硬編 1 在累積 DB 無 users.id=1 時會 FK 失敗）
  const ins = db.prepare(`INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source, created_by)
    VALUES (?, NULL, ?, '09:00', '11:00', 2, 'manual', ?)`);
  ins.run(cid, '2031-01-10', uid);
  ins.run(cid, '2031-02-05', uid);       // 迄端含
  ins.run(cid, '2031-02-06', uid);       // 期外
  const voided = Number(db.prepare(`INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source, created_by, voided_at)
    VALUES (?, NULL, '2031-01-20', '09:00', '10:00', 1, 'manual', ?, '2031-01-21T00:00:00')`).run(cid, uid).lastInsertRowid);

  const r = computePayroll({ period: '2031-02' });
  const c = r.coaches.find((x) => x.coachId === cid);
  expect('shift 區塊：時數含端點/排除註銷、薪資=時數×時薪', () => {
    assert.equal(c.shift.hours, 4); assert.equal(c.shift.rate, 500); assert.equal(c.shift.salary, 2000);
    assert.equal(c.shift.details.length, 2);
    assert.equal(c.total, c.oneOnOne.salary + c.group.salary + 2000);
  });
  expect('totals 加總 shiftHours/shiftSalary 並計入 total', () => {
    assert.ok(r.totals.shiftHours >= 4);
    assert.ok(r.totals.shiftSalary >= 2000);
    assert.equal(r.totals.total, r.coaches.reduce((s, x) => s + x.total, 0));
  });
  db.prepare("UPDATE coaches SET hourly_rate = NULL WHERE id = ?").run(cid);
  const r2 = computePayroll({ period: '2031-02' });
  const c2 = r2.coaches.find((x) => x.coachId === cid);
  expect('hourly_rate NULL：rate=null、salary=0、時數照列', () => {
    assert.equal(c2.shift.rate, null); assert.equal(c2.shift.salary, 0); assert.equal(c2.shift.hours, 4);
  });
  expect('時薪四捨五入到元：333 × 1.5h = 500', () => {
    db.prepare("UPDATE coaches SET hourly_rate = 333, is_active = 0 WHERE id = ?").run(cid);
    db.exec(`DELETE FROM shift_attendance WHERE coach_id = ${cid}`);
    db.prepare(`INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source, created_by)
      VALUES (?, NULL, '2031-01-15', '09:00', '10:30', 1.5, 'manual', ?)`).run(cid, uid);
    const c3 = computePayroll({ period: '2031-02' }).coaches.find((x) => x.coachId === cid);
    assert.ok(c3, '停用教練期內有駐場資料仍應列出');
    assert.equal(c3.shift.salary, 500);
  });
}

console.log('[payroll-service test] done');

// ── 團課實收：訂單折扣依定價比例分攤到每位報名者（教練抽成以實收計）──
{
  const coachE = mkCoach('pr-e@x.com', 'PR教練E', 1);
  const mkTpl = (name, price) => Number(db.prepare(`
    INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence,
      cycle_start_date, cycle_end_date, price_per_session, coach_id)
    VALUES (?, 1, 20, 2, '19:00', 'weekly', '2031-01-01', '2031-03-01', ?, ?)`).run(name, price, coachE).lastInsertRowid);
  const tE1 = mkTpl('PR測試折扣團課', 400);
  const tE2 = mkTpl('PR測試折扣團課高價', 800);
  const mkSess = (tpl, startAt) => Number(db.prepare(`
    INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
    VALUES (?,?,?,?,?,'open',?)`).run(tpl, startAt.slice(0, 10), startAt, startAt.slice(0, 11) + '20:00:00', startAt, coachE).lastInsertRowid);
  const e1 = mkSess(tE1, '2031-01-14T19:00:00');
  const e2 = mkSess(tE1, '2031-01-21T19:00:00');
  const e3 = mkSess(tE2, '2031-01-15T19:00:00');
  const e4 = mkSess(tE1, '2031-01-28T19:00:00');
  const e5 = mkSess(tE1, '2031-02-04T19:00:00');
  const om = [];
  for (let i = 0; i < 8; i++) om.push(uid(`PR訂單員${i}`, `pr-o${i}@x.com`));
  // 已付款訂單：original_amount = 各場定價加總、discount_amount = 折扣額、total_amount = 實付
  const mkOrder = (memberId, original, discount) => Number(db.prepare(`
    INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, status, expires_at, paid_at, discount_code, discount_amount, original_amount)
    VALUES (?, 'PR訂單', '0900000000', ?, 'paid', '2031-01-01T00:00:00', '2031-01-02T00:00:00', ?, ?, ?)`)
    .run(memberId, original - (discount ?? 0), discount == null ? null : 'PRCODE', discount, original).lastInsertRowid);
  const mkOReg = (sessionId, userId, orderId, amountDue, { status = 'confirmed', onLeave = 0 } = {}) =>
    db.prepare('INSERT INTO registrations (session_id, user_id, status, order_id, amount_due, on_leave) VALUES (?,?,?,?,?,?)')
      .run(sessionId, userId, status, orderId, amountDue, onLeave);

  const o1 = mkOrder(om[0], 800, 80);   mkOReg(e1, om[0], o1, 400); mkOReg(e2, om[0], o1, 400);   // 9 折 → 各 360
  const o2 = mkOrder(om[1], 800, 100);  mkOReg(e1, om[1], o2, 400); mkOReg(e2, om[1], o2, 400);   // 定額折 100 → 各 350
  const o3 = mkOrder(om[2], 800, 200);  mkOReg(e1, om[2], o3, 400); mkOReg(e2, om[2], o3, 400);   // 每堂固定 300 → 各 300
  const o4 = mkOrder(om[3], 1200, 100); mkOReg(e1, om[3], o4, 400); mkOReg(e3, om[3], o4, 800);   // 混價：折 100 依 400:800 分攤 → 367 / 733
  const o5 = mkOrder(om[4], 400, null); mkOReg(e4, om[4], o5, 400);                                 // 無折扣 → 400
  const o6 = mkOrder(om[5], 800, 80);   mkOReg(e4, om[5], o6, 400); mkOReg(e5, om[5], o6, 400, { status: 'cancelled' }); // 付款後取消 e5 並退款 → e4 仍 360
  db.prepare("INSERT INTO group_order_refunds (order_id, amount, refunded_at) VALUES (?, 400, '2031-01-25T00:00:00')").run(o6);
  db.prepare('INSERT INTO registrations (session_id, user_id, status, amount_due) VALUES (?,?,?,?)').run(e4, om[6], 'confirmed', 400); // 無訂單（舊資料）→ 400
  const o7 = mkOrder(om[7], 400, 40);   mkOReg(e4, om[7], o7, 400, { onLeave: 1 });               // 請假 → 不計（實收與折扣都不計）

  const r = computePayroll({ period: '2031-02' });
  const c = r.coaches.find((x) => x.coachId === coachE);
  const det = (sid) => c.group.details.find((d) => d.sessionId === sid);
  expect('9 折／定額／每堂固定：每位實收 = 定價 − 依定價比例分攤的折扣（e1：360+350+300+367）', () => {
    assert.equal(det(e1).headcount, 4);
    assert.equal(det(e1).revenue, 1377);
    assert.equal(det(e1).discount, 223);          // 40+50+100+33
    assert.equal(det(e2).headcount, 3);
    assert.equal(det(e2).revenue, 1010);          // 360+350+300
    assert.equal(det(e2).discount, 190);
  });
  expect('混價訂單：折扣依 400:800 分攤（高價場 733、折 67）', () => {
    assert.equal(det(e3).headcount, 1);
    assert.equal(det(e3).revenue, 733);
    assert.equal(det(e3).discount, 67);
  });
  expect('無折扣訂單／舊資料無訂單 → 定價；付款後取消另一場不影響本場；請假不計', () => {
    assert.equal(det(e4).headcount, 3);           // o5 + o6 + 舊資料（請假不計）
    assert.equal(det(e4).revenue, 1160);          // 400 + 360 + 400
    assert.equal(det(e4).discount, 40);
    assert.equal(det(e5).headcount, 0);           // 已取消
    assert.equal(det(e5).revenue, 0);
    assert.equal(det(e5).discount, 0);
  });
  expect('教練團課實收與薪資以實收計（4280 × 50% = 2140）', () => {
    assert.equal(c.group.headcount, 11);
    assert.equal(c.group.revenue, 4280);          // 1377+1010+733+1160
    assert.equal(c.group.pct, 50);
    assert.equal(c.group.salary, 2140);
  });
}
console.log('[payroll-service test] group-discount done');
