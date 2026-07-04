# 堂數即將用完自動 LINE 提醒 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天 9 點掃描：1對1/1對2 方案「尚餘」≤2 堂、團課未來正取合計剩最後 1 堂 → `notify()` 提醒客人（LINE 優先），每個狀態只提醒一次（`renewal_reminders` 去重表）。

**Architecture:** 新 `src/services/renewalReminderService.js`（兩支彙總 SQL＋marker 去重＋notify）；schema 加 `renewal_reminders` 表（開機自動套用）；notifications 加兩模板；scheduler 加 9 點 cron。

**Spec:** `docs/superpowers/specs/2026-07-04-renewal-reminders-design.md`

## Global Constraints

- 尚餘口徑＝我的課表：`未來 confirmed 預約數 ＋（expires_at 為 NULL 或 ≥ 今天 ? remaining_sessions : 0）`；`0 < 尚餘 ≤ 2` 才提醒；作廢方案不掃。
- 團課：`status='confirmed'` 報名 × 未取消場次 × `start_at >= now` 合計 `== 1` 才提醒；ref 為該最後一堂 session id。
- 去重：`renewal_reminders` UNIQUE(kind, member_id, ref_id)；**先插 marker 成功才 notify**。
- 測試檔結尾必須 `DELETE FROM renewal_reminders`（整表；共用 dev DB——本檔會對其他測試殘留資料產生 marker，留著會讓其他測試檔下次清 users 時撞 FK）。
- 測試斷言一律鎖定 rr-% 自建會員（勿斷言全域計數——共用 DB 有殘留資料也可能被掃到，屬預期）。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: 去重表＋掃描服務＋模板＋排程＋測試（單一交付物）

**Files:**
- Modify: `src/db/schema.js`（`point_transactions` 表定義之後加新表）
- Create: `src/services/renewalReminderService.js`
- Modify: `src/services/notifications.js`（TEMPLATES 加兩則）
- Modify: `src/scheduler.js`（9 點 cron）
- Test: `tests/renewal-reminders.test.js`（新檔）
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/renewal-reminders.test.js`）

**Interfaces:**
- Produces: `processRenewalReminders(now?) → { packagesSent, groupSent }`；通知型別 `package_low_sessions`（vars: session_type_label, remaining）、`group_last_session`（vars: course_name, start_at）。

- [ ] **Step 1: schema.js 加表（`point_transactions` 區塊之後）**

```sql
CREATE TABLE IF NOT EXISTS renewal_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('package','group')),
  member_id INTEGER NOT NULL REFERENCES users(id),
  ref_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_reminders_key ON renewal_reminders(kind, member_id, ref_id);
```

- [ ] **Step 2: notifications.js TEMPLATES 加兩則**

```js
  package_low_sessions: {
    subject: '方案堂數提醒',
    body: '提醒您：您的{{session_type_label}}方案還剩 {{remaining}} 堂課。歡迎向教練預約續購，讓訓練不中斷！',
  },
  group_last_session: {
    subject: '團體課報名提醒',
    body: '提醒您：您報名的團體課只剩最後一堂（{{course_name}}，{{start_at}}）。歡迎繼續報名之後的場次，我們課堂上見！',
  },
```

- [ ] **Step 3: 寫 `src/services/renewalReminderService.js`**

```js
// 堂數即將用完自動提醒：方案「尚餘」≤2、團課未來正取合計剩最後 1 堂 → notify（LINE 優先）。
// 每日 9 點掃描；renewal_reminders 去重（每狀態一次）。
// 規格：docs/superpowers/specs/2026-07-04-renewal-reminders-design.md
import { db, nowLocal } from '../db/connection.js';
import { notify, fmtDateForLine } from './notifications.js';

const SESSION_LABELS = { '1on1': '1對1', '1on2': '1對2' };

// 尚餘（我的課表口徑）＝ 未來 confirmed 預約 ＋（未過期 ? 未登錄餘額 : 0）
const lowPackagesStmt = db.prepare(`
  SELECT p.id, p.member_id, p.session_type,
         COALESCE(up.cnt, 0) +
         (CASE WHEN p.expires_at IS NULL OR p.expires_at >= ? THEN p.remaining_sessions ELSE 0 END) AS still
  FROM customer_packages p
  LEFT JOIN (SELECT package_id, COUNT(*) AS cnt FROM bookings
              WHERE status = 'confirmed' AND package_id IS NOT NULL AND start_at >= ?
              GROUP BY package_id) up ON up.package_id = p.id
  WHERE p.archived_at IS NULL
`);
// 未來正取團課合計恰 1 堂者（cnt=1 時 MIN 即該唯一場次的值）
const lastGroupStmt = db.prepare(`
  SELECT r.user_id AS member_id, COUNT(*) AS cnt,
         MIN(s.start_at) AS start_at, MIN(s.id) AS session_id, MIN(t.name) AS course_name
  FROM registrations r
  JOIN course_sessions s ON s.id = r.session_id
  JOIN course_templates t ON t.id = s.template_id
  WHERE r.status = 'confirmed' AND s.status != 'cancelled' AND s.start_at >= ?
  GROUP BY r.user_id
  HAVING cnt = 1
`);
const hasMarker = db.prepare('SELECT 1 FROM renewal_reminders WHERE kind = ? AND member_id = ? AND ref_id = ? LIMIT 1');
const insertMarker = db.prepare('INSERT OR IGNORE INTO renewal_reminders (kind, member_id, ref_id) VALUES (?, ?, ?)');

/** 每日掃描（cron 9:00）。回 { packagesSent, groupSent } 供 log。 */
export function processRenewalReminders(now = nowLocal()) {
  const today = String(now).slice(0, 10);
  let packagesSent = 0, groupSent = 0;

  for (const p of lowPackagesStmt.all(today, now)) {
    if (!(p.still > 0 && p.still <= 2)) continue;
    if (hasMarker.get('package', p.member_id, p.id)) continue;
    if (!insertMarker.run('package', p.member_id, p.id).changes) continue;
    notify({ userId: p.member_id, sessionId: null, type: 'package_low_sessions',
      vars: { session_type_label: SESSION_LABELS[p.session_type] || p.session_type, remaining: p.still } });
    packagesSent++;
  }

  for (const g of lastGroupStmt.all(now)) {
    if (hasMarker.get('group', g.member_id, g.session_id)) continue;
    if (!insertMarker.run('group', g.member_id, g.session_id).changes) continue;
    notify({ userId: g.member_id, sessionId: g.session_id, type: 'group_last_session',
      vars: { course_name: g.course_name, start_at: fmtDateForLine(g.start_at) } });
    groupSent++;
  }

  return { packagesSent, groupSent };
}
```

- [ ] **Step 4: scheduler.js 佈線（import ＋ 既有 9 點提醒 cron 之後加）**

```js
import { processRenewalReminders } from './services/renewalReminderService.js';
```

```js
  // 每天早上 9 點：堂數即將用完提醒（方案尚餘≤2／團課剩最後1堂；每狀態只提醒一次）
  cron.schedule('0 9 * * *', () => {
    try {
      const r = processRenewalReminders();
      if (r.packagesSent || r.groupSent) console.log('[scheduler] renewal reminders sent:', r);
    } catch (e) {
      console.error('[scheduler] renewal reminder error:', e);
    }
  });
```

- [ ] **Step 5: 寫測試 `tests/renewal-reminders.test.js`**

```js
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
expect('尚餘 2（未登錄1＋未來預約1）→ 發一次', () => assert.equal(notifCount(m1, 'package_low_sessions'), 1));
run();
expect('再跑不重發（marker 去重）', () => assert.equal(notifCount(m1, 'package_low_sessions'), 1));

const p2 = mkPkg(m1, { remaining: 2, type: '1on2' });            // 續購新方案 尚餘 2 → 對新 ref 再發
run();
expect('續購新方案降到門檻 → 再發（不同 ref）', () => {
  assert.equal(notifCount(m1, 'package_low_sessions'), 2);
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='package_low_sessions' ORDER BY id DESC").get(m1);
  assert.ok(row.body.includes('1對2') && row.body.includes('2 堂'));
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

expect('marker 表（kind, member, ref）語意', () => {
  const c = db.prepare("SELECT COUNT(*) c FROM renewal_reminders WHERE kind='group' AND member_id=?").get(m3).c;
  assert.equal(c, 2);   // s1 一次、s2 一次
});

clean(); // 含 DELETE FROM renewal_reminders（整表：本檔可能對共用 DB 殘留資料產生 marker，留著會讓其他測試清 users 撞 FK）
console.log('[renewal-reminders test] done');
```

- [ ] **Step 6: 跑測試＋掛鏈＋commit**

```bash
node tests/renewal-reminders.test.js   # 全 ✓、exit 0
# package.json 的 test 鏈尾加 ` && node tests/renewal-reminders.test.js`
git add src/db/schema.js src/services/renewalReminderService.js src/services/notifications.js src/scheduler.js tests/renewal-reminders.test.js package.json
git commit -m "feat: 堂數即將用完自動提醒（方案尚餘≤2／團課剩最後1堂，每日9點、每狀態一次）"
```

---

## 收尾（controller）

1. 全套 `npm test`＋server 跑 `test:api` → 全綠；`node src/db/seed-demo.js` 重種。
2. Final review subagent（重點：掃描 SQL 口徑與我的課表一致、去重/FK、洗版防護、對共用 DB 殘留的容忍）。
3. Push + draft PR + 說明（首次上線 9 點會對「現況已低於門檻」的方案/團課各發一輪提醒——屬預期的一次性補發）。
