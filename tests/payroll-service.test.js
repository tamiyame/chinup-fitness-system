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
  DELETE FROM course_sessions WHERE start_at LIKE '2031-%';
  DELETE FROM course_templates WHERE name LIKE 'PR測試%';
  DELETE FROM bookings WHERE start_at LIKE '2031-%';
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
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
  setSetting('payroll_group_pct', '50');                    // 還原
});
expect('totals = 各教練加總', () => {
  const r = computePayroll({ period: '2031-02' });
  const sum = r.coaches.reduce((s, c) => s + c.total, 0);
  assert.equal(r.totals.total, sum);
  assert.equal(r.totals.groupRevenue, r.coaches.reduce((s, c) => s + c.group.revenue, 0));
});
console.log('[payroll-service test] done');
