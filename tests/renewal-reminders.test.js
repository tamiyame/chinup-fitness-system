// 堂數即將用完提醒：方案尚餘門檻/去重/續購再提醒；團課最後一堂/去重；邊界（過期/作廢/全上完/候補）。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { processRenewalReminders } = await import('../src/services/renewalReminderService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[renewal-reminders test] start');

const NOW = '2033-01-10T12:00:00'; // 固定測試時鐘（資料鎖 2033/2020，避開其他測試）

// ── 清理（冪等）──
const clean = () => db.exec(`
  DELETE FROM renewal_reminders;
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'rr-%');
  DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'rr-%');
  DELETE FROM course_sessions WHERE start_at LIKE '2033-%' OR start_at LIKE '2020-%';
  DELETE FROM course_templates WHERE name LIKE 'RR測試%';
  DELETE FROM bookings WHERE start_at LIKE '2033-%' OR (start_at LIKE '2020-%' AND member_id IN (SELECT id FROM users WHERE email LIKE 'rr-%'));
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'rr-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'rr-%');
  DELETE FROM users WHERE email LIKE 'rr-%';
`);
clean();

// ── 建資料 ──
const uid = (name, email) => Number(db.prepare("INSERT INTO users (name,email,role) VALUES (?,?,'user')").run(name, email).lastInsertRowid);
const coachUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('RR教練','rr-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?,'RR教練',1)").run(coachUid).lastInsertRowid);
const m1 = uid('RR一', 'rr-m1@x.com');   // 方案主角
const m2 = uid('RR二', 'rr-m2@x.com');   // 邊界方案
const m3 = uid('RR三', 'rr-m3@x.com');   // 團課主角
const m4 = uid('RR四', 'rr-m4@x.com');   // 團課 2 堂

const mkPkg = (member, { remaining, total = 10, expires = null, archived = false, type = '1on1' } = {}) =>
  Number(db.prepare(`INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, archived_at)
    VALUES (?,?,?,?,10000,?,?)`).run(member, type, total, remaining, expires, archived ? NOW : null).lastInsertRowid);
const mkBk = (member, pkg, startAt) => db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type, original_amount, package_id)
  VALUES (?,?,?,?, 'confirmed','1on1',1000,?)`)
  .run(coachId, member, startAt, startAt.slice(0, 11) + String(Number(startAt.slice(11, 13)) + 1).padStart(2, '0') + startAt.slice(13), pkg);

const notifCount = (userId, type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(userId, type).c;
const run = () => processRenewalReminders(NOW);

// ── 方案 ──
const pSafe = mkPkg(m1, { remaining: 3 });                       // 尚餘 3 → 不發
run();
expect('尚餘 3 → 不發', () => assert.equal(notifCount(m1, 'package_low_sessions'), 0));

db.prepare('UPDATE customer_packages SET remaining_sessions = 1 WHERE id = ?').run(pSafe);
mkBk(m1, pSafe, '2033-01-15T10:00:00');                          // 尚餘 = 1未登錄 + 1未來 = 2
run();
expect('尚餘 2 → 不發（門檻為 1）', () => assert.equal(notifCount(m1, 'package_low_sessions'), 0));

db.prepare('UPDATE customer_packages SET remaining_sessions = 0 WHERE id = ?').run(pSafe);   // 尚餘 = 0未登錄 + 1未來 = 1
run();
expect('尚餘 1（僅剩未來預約）→ 發一次', () => assert.equal(notifCount(m1, 'package_low_sessions'), 1));
run();
expect('再跑不重發（marker 去重）', () => assert.equal(notifCount(m1, 'package_low_sessions'), 1));

const p2 = mkPkg(m1, { remaining: 1, type: '1on2' });            // 續購新方案 尚餘 1 → 對新 ref 再發
run();
expect('續購新方案降到門檻 → 再發（不同 ref）', () => {
  assert.equal(notifCount(m1, 'package_low_sessions'), 2);
  const cnt1on2 = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='package_low_sessions' AND body LIKE '%1對2%' AND body LIKE '%1 堂%'").get(m1).c;
  assert.equal(cnt1on2, 1);   // 不依賴掃描順序，直接斷言 1對2 方案的那則存在
});

const pDone = mkPkg(m2, { remaining: 0 });                       // 全上完：remaining 0、預約皆過去 → 尚餘 0 → 不發
mkBk(m2, pDone, '2020-05-01T10:00:00');
const pExpired = mkPkg(m2, { remaining: 5, expires: '2020-01-01' });          // 過期無未來 → 尚餘 0 → 不發
const pArch = mkPkg(m2, { remaining: 1, archived: true });                     // 作廢 → 不掃
run();
expect('尚餘 0／過期／作廢 → 皆不發', () => assert.equal(notifCount(m2, 'package_low_sessions'), 0));

const pExpUp = mkPkg(m2, { remaining: 5, expires: '2020-01-01' });             // 過期但有未來預約 → 尚餘=1 → 發
mkBk(m2, pExpUp, '2033-01-20T10:00:00');
run();
expect('過期但仍有未來預約（尚餘=1）→ 發', () => assert.equal(notifCount(m2, 'package_low_sessions'), 1));

// ── 團課 ──
const tpl = Number(db.prepare(`INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence,
  cycle_start_date, cycle_end_date, price_per_session, coach_id)
  VALUES ('RR測試團課', 1, 10, 1, '19:00', 'weekly', '2033-01-01', '2033-03-01', 400, ?)`).run(coachId).lastInsertRowid);
const mkSess = (startAt, status = 'open') => Number(db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
  VALUES (?,?,?,?,?,?,?)`).run(tpl, startAt.slice(0, 10), startAt, startAt.slice(0, 11) + '20:00:00', startAt, status, coachId).lastInsertRowid);
const mkReg = (sess, user, status = 'confirmed') =>
  db.prepare('INSERT INTO registrations (session_id, user_id, status, amount_due) VALUES (?,?,?,400)').run(sess, user, status);

const s1 = mkSess('2033-01-17T19:00:00');
const s2 = mkSess('2033-01-24T19:00:00');
mkReg(s1, m4); mkReg(s2, m4);                                    // m4：未來 2 堂 → 不發
mkReg(s1, m3);                                                    // m3：未來 1 堂 → 發
mkReg(mkSess('2020-06-01T19:00:00'), m3);                         // 過去場次不計
mkReg(mkSess('2033-01-31T19:00:00', 'cancelled'), m3);            // 取消場次不計
mkReg(s2, m2, 'waitlisted');                                      // 候補不計 → m2 未來正取 0 → 不發
run();
expect('團課合計剩 1 堂 → 發一次（含課名/時間）；2 堂/候補/過去/取消場次不發', () => {
  assert.equal(notifCount(m3, 'group_last_session'), 1);
  assert.equal(notifCount(m4, 'group_last_session'), 0);
  assert.equal(notifCount(m2, 'group_last_session'), 0);
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='group_last_session'").get(m3);
  assert.ok(row.body.includes('RR測試團課'));
});
run();
expect('團課再跑不重發', () => assert.equal(notifCount(m3, 'group_last_session'), 1));

mkReg(s2, m3);                                                    // m3 再報 1 堂 → 合計 2 → 不觸發
run();
expect('補報名後合計 2 堂 → 不再發', () => assert.equal(notifCount(m3, 'group_last_session'), 1));
db.prepare("UPDATE registrations SET status='cancelled' WHERE session_id=? AND user_id=?").run(s1, m3); // 取消 s1 → 只剩 s2
run();
expect('降回 1 堂且最後一堂換場次（新 ref）→ 再發', () => assert.equal(notifCount(m3, 'group_last_session'), 2));

expect('教練（員工）不收任何續約提醒', () => {
  assert.equal(notifCount(coachUid, 'package_low_sessions'), 0);
  assert.equal(notifCount(coachUid, 'group_last_session'), 0);
});
expect('marker 表（kind, member, ref）語意', () => {
  const c = db.prepare("SELECT COUNT(*) c FROM renewal_reminders WHERE kind='group' AND member_id=?").get(m3).c;
  assert.equal(c, 2);   // s1 一次、s2 一次
});

clean(); // 含 DELETE FROM renewal_reminders（整表：本檔可能對共用 DB 殘留資料產生 marker，留著會讓其他測試清 users 撞 FK）
console.log('[renewal-reminders test] done');
