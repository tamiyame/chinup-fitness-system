// 堂數即將用完提醒：方案尚餘門檻/去重/續購再提醒（發教練＋管理者）；團課最後一堂/去重（發會員）；
// 邊界（過期/作廢/全上完/候補）；一次性 10 堂方案重新檢查。
process.env.LINE_MOCK = '1';
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { processRenewalReminders, recheckTenSessionPackagesOnce } = await import('../src/services/renewalReminderService.js');
const { getLineNotifyState, setLineNotifyState } = await import('../src/services/lineNotifyPolicy.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[renewal-reminders test] start');

const NOW = '2033-01-10T12:00:00'; // 固定測試時鐘（資料鎖 2033/2020，避開其他測試）
const RECHECK_FLAG = 'renewal_recheck_10_done';
const masterBefore = getLineNotifyState().master;

// ── 清理（冪等）──
const clean = () => db.exec(`
  DELETE FROM renewal_reminders;
  DELETE FROM app_settings WHERE key = 'renewal_recheck_10_done';
  DELETE FROM notifications WHERE type IN ('package_low_sessions', 'package_low_recheck', 'group_last_session');
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
const mkCoach = (name, email, { isAdmin = 0, active = 1 } = {}) => {
  const userId = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES (?,?,'coach',?)").run(name, email, isAdmin).lastInsertRowid);
  const id = Number(db.prepare('INSERT INTO coaches (user_id,display_name,is_active) VALUES (?,?,?)').run(userId, name, active).lastInsertRowid);
  return { userId, id };
};
const { userId: coachUid, id: coachId } = mkCoach('RR教練', 'rr-c@x.com');
const coachB = mkCoach('RR教練乙', 'rr-c2@x.com');
const coachAdmin = mkCoach('RR教練管理者', 'rr-ca@x.com', { isAdmin: 1 });
const coachGone = mkCoach('RR離職教練', 'rr-c3@x.com', { active: 0 });
const adminUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('RR管理者','rr-a@x.com','coach',1)").run().lastInsertRowid);
const m1 = uid('RR一', 'rr-m1@x.com');   // 方案主角
const m2 = uid('RR二', 'rr-m2@x.com');   // 邊界方案
const m3 = uid('RR三', 'rr-m3@x.com');   // 團課主角
const m4 = uid('RR四', 'rr-m4@x.com');   // 團課 2 堂

const mkPkg = (member, { remaining, total = 10, expires = null, archived = false, type = '1on1' } = {}) =>
  Number(db.prepare(`INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, archived_at)
    VALUES (?,?,?,?,10000,?,?)`).run(member, type, total, remaining, expires, archived ? NOW : null).lastInsertRowid);
const mkBk = (member, pkg, startAt, { coach = coachId, status = 'confirmed' } = {}) => db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type, original_amount, package_id)
  VALUES (?,?,?,?,?,'1on1',1000,?)`)
  .run(coach, member, startAt, startAt.slice(0, 11) + String(Number(startAt.slice(11, 13)) + 1).padStart(2, '0') + startAt.slice(13), status, pkg);

const notifCount = (userId, type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(userId, type).c;
// 某位員工收到「關於某會員」的方案提醒幾則（訊息是第三人稱，以會員姓名比對）
const aboutCount = (userId, memberName) => db.prepare(
  "SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='package_low_sessions' AND body LIKE ?").get(userId, `%${memberName}%`).c;
const run = () => processRenewalReminders(NOW);

// ── 方案 ──
const pSafe = mkPkg(m1, { remaining: 3 });                       // 尚餘 3 → 不發
run();
expect('尚餘 3 → 不發', () => assert.equal(aboutCount(adminUid, 'RR一'), 0));

db.prepare('UPDATE customer_packages SET remaining_sessions = 1 WHERE id = ?').run(pSafe);
mkBk(m1, pSafe, '2033-01-15T10:00:00');                          // 尚餘 = 1未登錄 + 1未來 = 2
run();
expect('尚餘 2 → 不發（門檻為 1）', () => assert.equal(aboutCount(adminUid, 'RR一'), 0));

db.prepare('UPDATE customer_packages SET remaining_sessions = 0 WHERE id = ?').run(pSafe);   // 尚餘 = 0未登錄 + 1未來 = 1
run();
expect('尚餘 1（僅剩未來預約）→ 帶課教練與管理者各一則，會員不收', () => {
  assert.equal(aboutCount(coachUid, 'RR一'), 1);
  assert.equal(aboutCount(adminUid, 'RR一'), 1);
  assert.equal(notifCount(m1, 'package_low_sessions'), 0);
});
expect('訊息寫明會員、方案類型、總堂數與剩餘堂數', () => {
  const { body } = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='package_low_sessions'").get(coachUid);
  for (const part of ['RR一', '1對1', '共 10 堂', '1 堂']) assert.ok(body.includes(part), body);
});
run();
expect('再跑不重發（marker 去重）', () => {
  assert.equal(aboutCount(coachUid, 'RR一'), 1);
  assert.equal(aboutCount(adminUid, 'RR一'), 1);
});

const p2 = mkPkg(m1, { remaining: 1, type: '1on2' });            // 續購新方案 尚餘 1 → 對新 ref 再發
run();
expect('續購新方案降到門檻 → 再發（不同 ref）', () => {
  assert.equal(aboutCount(adminUid, 'RR一'), 2);
  const cnt1on2 = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='package_low_sessions' AND body LIKE '%RR一%1對2%'").get(adminUid).c;
  assert.equal(cnt1on2, 1);   // 不依賴掃描順序，直接斷言 1對2 方案的那則存在
});
expect('方案沒有任何預約（找不到教練）→ 只發管理者', () => assert.equal(aboutCount(coachUid, 'RR一'), 1));

const pDone = mkPkg(m2, { remaining: 0 });                       // 全上完：remaining 0、預約皆過去 → 尚餘 0 → 不發
mkBk(m2, pDone, '2020-05-01T10:00:00');
const pExpired = mkPkg(m2, { remaining: 5, expires: '2020-01-01' });          // 過期無未來 → 尚餘 0 → 不發
const pArch = mkPkg(m2, { remaining: 1, archived: true });                     // 作廢 → 不掃
run();
expect('尚餘 0／過期／作廢 → 皆不發', () => assert.equal(aboutCount(adminUid, 'RR二'), 0));

const pExpUp = mkPkg(m2, { remaining: 5, expires: '2020-01-01' });             // 過期但有未來預約 → 尚餘=1 → 發
mkBk(m2, pExpUp, '2033-01-20T10:00:00');
run();
expect('過期但仍有未來預約（尚餘=1）→ 發', () => assert.equal(aboutCount(adminUid, 'RR二'), 1));

// ── 收件教練 ──
const m5 = uid('RR五', 'rr-m5@x.com');   // 換過教練
const pSwitch = mkPkg(m5, { remaining: 1 });
mkBk(m5, pSwitch, '2020-05-02T10:00:00');                                     // 舊教練
mkBk(m5, pSwitch, '2020-05-09T10:00:00', { coach: coachB.id });               // 最後一筆 confirmed
mkBk(m5, pSwitch, '2020-05-16T10:00:00', { coach: coachAdmin.id, status: 'cancelled' });  // 已取消不算
run();
expect('換過教練 → 只發最後一筆 confirmed 預約的教練', () => {
  assert.equal(aboutCount(coachB.userId, 'RR五'), 1);
  assert.equal(aboutCount(coachUid, 'RR五'), 0);
});

const m6 = uid('RR六', 'rr-m6@x.com');   // 教練本身是管理者
mkBk(m6, mkPkg(m6, { remaining: 1 }), '2020-05-03T10:00:00', { coach: coachAdmin.id });
run();
expect('教練兼管理者只收一則，其他管理者照收', () => {
  assert.equal(aboutCount(coachAdmin.userId, 'RR六'), 1);
  assert.equal(aboutCount(adminUid, 'RR六'), 1);
});

const m7 = uid('RR七', 'rr-m7@x.com');   // 教練已停用
mkBk(m7, mkPkg(m7, { remaining: 1 }), '2020-05-04T10:00:00', { coach: coachGone.id });
run();
expect('教練已停用 → 不發給他，管理者照收', () => {
  assert.equal(aboutCount(coachGone.userId, 'RR七'), 0);
  assert.equal(aboutCount(adminUid, 'RR七'), 1);
});

const m8 = uid('RR八', 'rr-m8@x.com');   // 會員已封存
mkPkg(m8, { remaining: 1 });
db.prepare('UPDATE users SET archived_at = ? WHERE id = ?').run(NOW, m8);
run();
expect('會員已封存 → 不提醒', () => assert.equal(aboutCount(adminUid, 'RR八'), 0));

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

expect('團課提醒仍只發會員，教練與管理者不收', () => {
  assert.equal(notifCount(coachUid, 'group_last_session'), 0);
  assert.equal(notifCount(adminUid, 'group_last_session'), 0);
});
expect('marker 表（kind, member, ref）語意', () => {
  const c = db.prepare("SELECT COUNT(*) c FROM renewal_reminders WHERE kind='group' AND member_id=?").get(m3).c;
  assert.equal(c, 2);   // s1 一次、s2 一次
});

// ── 一次性重新檢查（10 堂方案）──
const recheckBodies = (userId) => db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='package_low_recheck'").all(userId).map((r) => r.body);
const recheck = () => recheckTenSessionPackagesOnce(NOW);
const flagSet = () => !!db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(RECHECK_FLAG);

// 共用 DB 可能有其他測試留下的方案：先全部作廢讓名單可精確斷言，最後還原
const otherPkgs = db.prepare('SELECT id FROM customer_packages WHERE archived_at IS NULL').all().map((r) => r.id);
db.prepare('UPDATE customer_packages SET archived_at = ? WHERE archived_at IS NULL').run(NOW);

const r1 = uid('RR重一', 'rr-r1@x.com');   // 10 堂、未登錄 1
const r2 = uid('RR重二', 'rr-r2@x.com');   // 10 堂、僅剩未來預約 1
mkPkg(r1, { remaining: 1 });
mkBk(r2, mkPkg(r2, { remaining: 0, type: '1on2' }), '2033-02-01T10:00:00');
mkPkg(uid('RR多堂', 'rr-r3@x.com'), { remaining: 2 });                    // 剩 2 堂
mkPkg(uid('RR五堂', 'rr-r4@x.com'), { remaining: 1, total: 5 });          // 不是 10 堂
mkPkg(uid('RR作廢', 'rr-r5@x.com'), { remaining: 1, archived: true });    // 作廢
mkPkg(uid('RR上完', 'rr-r6@x.com'), { remaining: 0 });                    // 全上完
const rGone = uid('RR封存', 'rr-r7@x.com');
mkPkg(rGone, { remaining: 1 });
db.prepare('UPDATE users SET archived_at = ? WHERE id = ?').run(NOW, rGone);
run();   // 先跑每日掃描：RR重一、RR重二 已有 marker，重新檢查仍要列入

setLineNotifyState({ master: false });
expect('LINE 關閉 → 不發、不佔旗標（等開啟後再補）', () => {
  assert.equal(recheck(), null);
  assert.equal(recheckBodies(adminUid).length, 0);
  assert.equal(flagSet(), false);
});

setLineNotifyState({ master: true });
expect('LINE 開啟 → 每位管理者一則彙總，已提醒過的方案也列入', () => {
  assert.deepEqual(recheck(), { count: 2 });
  for (const admin of [adminUid, coachAdmin.userId]) {
    const bodies = recheckBodies(admin);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /目前有 2 位客人/);
    assert.ok(bodies[0].includes('RR重一（1對1）'), bodies[0]);
    assert.ok(bodies[0].includes('RR重二（1對2）'), bodies[0]);
  }
});
expect('剩 2 堂／非 10 堂／作廢／全上完／封存會員不列入', () => {
  for (const name of ['RR多堂', 'RR五堂', 'RR作廢', 'RR上完', 'RR封存']) assert.ok(!recheckBodies(adminUid)[0].includes(name), name);
});
expect('教練與會員不收', () => {
  assert.equal(recheckBodies(coachUid).length, 0);
  assert.equal(recheckBodies(r1).length, 0);
});
expect('只發一次：再跑回 null、不重發', () => {
  assert.equal(recheck(), null);
  assert.equal(recheckBodies(adminUid).length, 1);
});

mkPkg(r1, { remaining: 1, type: '1on2' });   // 同一人兩筆方案都符合
db.prepare('DELETE FROM app_settings WHERE key = ?').run(RECHECK_FLAG);
expect('同一位客人兩筆符合 → 兩筆都列，但只算一位', () => {
  recheck();
  const latest = recheckBodies(adminUid).at(-1);
  assert.match(latest, /目前有 2 位客人/);
  assert.ok(latest.includes('RR重一（1對1）') && latest.includes('RR重一（1對2）'), latest);
});

db.prepare('UPDATE customer_packages SET archived_at = ? WHERE archived_at IS NULL').run(NOW);
db.prepare('DELETE FROM app_settings WHERE key = ?').run(RECHECK_FLAG);
expect('沒有符合的客人 → 仍發一則告知已檢查過', () => {
  assert.deepEqual(recheck(), { count: 0 });
  assert.match(recheckBodies(adminUid).at(-1), /目前沒有/);
});

const restorePkg = db.prepare('UPDATE customer_packages SET archived_at = NULL WHERE id = ?');
for (const id of otherPkgs) restorePkg.run(id);
setLineNotifyState({ master: masterBefore });

clean(); // 含 DELETE FROM renewal_reminders（整表：本檔可能對共用 DB 殘留資料產生 marker，留著會讓其他測試清 users 撞 FK）
console.log('[renewal-reminders test] done');
