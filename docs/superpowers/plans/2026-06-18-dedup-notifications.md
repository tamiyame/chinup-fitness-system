# 修正 LINE 通知重複 + 團課逐堂發送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓「教練兼管理者」不再對同一事件收兩則通知，且一張團課訂單（多日期）只發一則彙整通知。

**Architecture:** (1) `notifyAdmins` 支援排除多個 user id；(2) 1對1 建單的管理者廣播排除帶課教練；(3) 團課確認收款改為「整張訂單彙整」——依教練/課程分組，每位教練一則「你帶的」、非教練管理者每門課一則摘要，並把教練 user_id 從廣播排除。新增兩個彙整版範本與一個 M/D 日期 helper。

**Tech Stack:** Node.js ESM、node:sqlite。通知為 console/LINE 雙通道；測試為純 in-process node script（測試使用者未綁 LINE → 走 console 通道、同步寫入 `notifications` 表，可直接查表計數，無需 server 或 LINE_MOCK）。

**Spec:** `docs/superpowers/specs/2026-06-18-dedup-notifications-design.md`

---

## File Structure

- **Modify** `src/services/notifications.js`
  - `notifyAdmins`：新增 `excludeUserIds` 陣列參數（與既有 `excludeUserId` 合併；向後相容）。
  - 新增範本 `course_registered_coach_batch`、`course_registered_admin_batch`（放在 `course_registered_admin` 之後）。
- **Modify** `src/services/bookingService.js`
  - `createBookingCore` 的管理者廣播（約第 99 行）排除 `coach.user_id`。
- **Modify** `src/services/groupOrderService.js`
  - `confirmGroupOrder`：把逐場通知（約第 192–204 行）改為整單彙整；新增模組級 `getCoachUserIdStmt` 與 `fmtMD` helper。
- **Create** `tests/notification-dedup.test.js`（in-process；Task 1 建立、Task 2/3 追加）。
- **Modify** `package.json`：把新測試加進 `test`（unit）script。

**重要前置事實（已查證）：**
- `notify({userId,sessionId,type,vars})` 對未知 type 會 `throw`（notifications.js:242）→ 故彙整範本必須在團課改動前先加（Task 1 在 Task 3 前）。
- 測試使用者未綁 LINE → `notify` 走 `deliverConsole`（同步、in-tx、寫入 `notifications` channel='console' status='sent'），可直接查表。
- 既有測試不需改：`admin-notify-broadcast.test.js`/`group-coach-notify.test.js` 用單場訂單（N=1 仍用單堂範本）且其教練非管理者（排除無作用）；`course-coach-notify.test.js` 走 legacy `register()` + `notifyCourseCoach`（本計畫不動）。Task 4 仍會全套回歸確認。

---

## Task 1: `notifyAdmins` 支援多重排除 + 新增彙整範本

**Files:**
- Modify: `src/services/notifications.js`
- Create: `tests/notification-dedup.test.js`
- Modify: `package.json`

- [ ] **Step 1: 建立測試檔 `tests/notification-dedup.test.js`（含表頭 + Task 1 案例）**

```js
// 通知去重 + 團課訂單彙整（一筆訂單一則、教練兼管理者不重複）
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate } from '../src/services/courseService.js';
import { createBookingAnon } from '../src/services/bookingService.js';
import { createGroupOrder, confirmGroupOrder } from '../src/services/groupOrderService.js';
import { notify, notifyAdmins } from '../src/services/notifications.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function futureLocal(days, hh=10){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`;}
const notifCount = (userId, type) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(userId, type).c;

function reset() {
  db.exec(`
    DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%');
    DELETE FROM group_orders WHERE customer_phone LIKE '0955%';
    DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%');
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%');
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'NDUP%');
    DELETE FROM course_templates WHERE name LIKE 'NDUP%';
    DELETE FROM coaches WHERE display_name LIKE 'NDUP%';
    DELETE FROM users WHERE email LIKE 'ndup-%' OR phone LIKE '0955%';
  `);
}

console.log('[notification-dedup test] start');
reset();

// ── Task 1: notifyAdmins excludeUserIds + 彙整範本 ──
const a1 = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP A1','ndup-a1@x.com',?, 'coach',1)").run(hashPassword('x')).lastInsertRowid;
const a2 = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP A2','ndup-a2@x.com',?, 'coach',1)").run(hashPassword('x')).lastInsertRowid;
notifyAdmins({ type: 'booking_created', excludeUserIds: [a1], vars: { member_name: 'X', start_at: '7/1' } });
expect('notifyAdmins excludeUserIds 排除 a1', () => assert.equal(notifCount(a1, 'booking_created'), 0));
expect('notifyAdmins 仍送達 a2', () => assert.equal(notifCount(a2, 'booking_created'), 1));

expect('course_registered_coach_batch 範本渲染（共 N 堂 + 日期清單 + 你帶的）', () => {
  notify({ userId: a2, sessionId: null, type: 'course_registered_coach_batch',
    vars: { member_name: '王', course_name: 'NDUP測試課', count: 2, date_list: '7/1、7/8' } });
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='course_registered_coach_batch' ORDER BY id DESC LIMIT 1").get(a2);
  assert(row && row.body.includes('共 2 堂') && row.body.includes('7/1、7/8') && row.body.includes('你帶的'), row && row.body);
});
expect('course_registered_admin_batch 範本渲染（中性、無「你帶的」）', () => {
  notify({ userId: a2, sessionId: null, type: 'course_registered_admin_batch',
    vars: { member_name: '王', course_name: 'NDUP測試課', count: 2, date_list: '7/1、7/8' } });
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='course_registered_admin_batch' ORDER BY id DESC LIMIT 1").get(a2);
  assert(row && row.body.includes('共 2 堂') && !row.body.includes('你帶的'), row && row.body);
});

console.log('[notification-dedup test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/notification-dedup.test.js`
Expected: FAIL — `排除 a1`（excludeUserIds 尚未支援 → a1 仍收到，count=1≠0）與兩個範本案例（`notify` 對未知 type 丟例外 → 被 expect 捕捉成 ✗）。

- [ ] **Step 3: 改 `notifyAdmins` 支援 `excludeUserIds`（src/services/notifications.js）**

把現有：
```js
export function notifyAdmins({ sessionId = null, type, vars = {}, excludeUserId = null }) {
  for (const row of getAdminUserIds.all()) {
    // 不把第三人稱訊息發給報名本人（即使本人剛好是管理者）。
    if (excludeUserId != null && row.id === excludeUserId) continue;
    notify({ userId: row.id, sessionId, type, vars });
  }
}
```
改為：
```js
export function notifyAdmins({ sessionId = null, type, vars = {}, excludeUserId = null, excludeUserIds = [] }) {
  const exclude = new Set(excludeUserIds);
  if (excludeUserId != null) exclude.add(excludeUserId);
  for (const row of getAdminUserIds.all()) {
    // 不把第三人稱訊息發給報名本人或已收到教練版的教練（即使本人剛好是管理者）。
    if (exclude.has(row.id)) continue;
    notify({ userId: row.id, sessionId, type, vars });
  }
}
```

- [ ] **Step 4: 新增彙整範本（src/services/notifications.js）**

在 `course_registered_admin` 範本物件（`body: '🏋️ {{member_name}} 報名了「{{course_name}}」（{{start_at}}）。'` 那一塊）之後、`TEMPLATES` 物件的結尾 `};` 之前，加入：
```js
  course_registered_coach_batch: {  // 寄給教練（一張訂單多堂彙整）
    subject: '新報名 - {{course_name}}',
    body: '🏋️ {{member_name}} 報名了你帶的「{{course_name}}」共 {{count}} 堂（{{date_list}}）。',
  },
  course_registered_admin_batch: {  // 寄給管理者（一張訂單多堂彙整、中性）
    subject: '新報名 - {{course_name}}',
    body: '🏋️ {{member_name}} 報名了「{{course_name}}」共 {{count}} 堂（{{date_list}}）。',
  },
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node tests/notification-dedup.test.js`
Expected: 三個 Task 1 案例全 ✓，結尾 `[notification-dedup test] done`，無 ✗。

- [ ] **Step 6: 把新測試加進 `package.json` 的 `test`（unit）script**

在 `"test"` 字串尾端（`node tests/admin-backfill.test.js` 之後）加上：` && node tests/notification-dedup.test.js`

- [ ] **Step 7: Commit**

```bash
git add src/services/notifications.js tests/notification-dedup.test.js package.json
git commit -m "feat(notify): notifyAdmins 支援多重排除 + 團課彙整範本"
```

---

## Task 2: 1對1 建單 — 管理者廣播排除帶課教練（去重）

**Files:**
- Modify: `src/services/bookingService.js`
- Modify: `tests/notification-dedup.test.js`（追加案例）

- [ ] **Step 1: 在測試檔追加 1對1 案例（放在 `console.log('[notification-dedup test] done');` 之前）**

```js
// ── Task 2: 1對1 — 教練兼管理者只收一則 booking_created ──
const caU = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP CoachAdmin','ndup-ca@x.com',?, 'coach',1)").run(hashPassword('x'));
const caCoach = createCoach({ userId: caU.lastInsertRowid, displayName: 'NDUP 教練兼管理' });
setCoachActive(caCoach.id, true);
const caUserId = caU.lastInsertRowid;
createBookingAnon({ coachId: caCoach.id, startAt: futureLocal(5), name: '客A', phone: '0955000001' });
expect('1對1：教練兼管理者只收一則 booking_created（去重）', () => assert.equal(notifCount(caUserId, 'booking_created'), 1));
const m1on1 = db.prepare("SELECT id FROM users WHERE phone='0955000001'").get();
expect('1對1：會員仍收一則 booking_confirmed', () => assert.equal(notifCount(m1on1.id, 'booking_confirmed'), 1));
```

- [ ] **Step 2: 跑測試確認新案例失敗**

Run: `node tests/notification-dedup.test.js`
Expected: `教練兼管理者只收一則 booking_created` ✗（修正前：直接通知 + 管理者廣播都打到該教練 → count=2）。其餘仍 ✓。

- [ ] **Step 3: 修正 `createBookingCore` 的管理者廣播（src/services/bookingService.js，約第 99 行）**

把：
```js
    notifyAdmins({ type: 'booking_created', excludeUserId: memberId, vars: { member_name: memberRow.name, start_at: startFmt } });
```
改為：
```js
    notifyAdmins({ type: 'booking_created', excludeUserIds: [memberId, coach.user_id], vars: { member_name: memberRow.name, start_at: startFmt } });
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/notification-dedup.test.js`
Expected: 全 ✓（含 Task 1、Task 2 案例），無 ✗。

- [ ] **Step 5: 回歸既有 1對1 廣播測試**

Run: `node tests/admin-notify-broadcast.test.js`
Expected: 全 ✓（該測試教練非管理者、排除無副作用；管理者本人報名仍不收第三人稱）。

- [ ] **Step 6: Commit**

```bash
git add src/services/bookingService.js tests/notification-dedup.test.js
git commit -m "fix(notify): 1對1 建單管理者廣播排除帶課教練，避免教練兼管理者重複收"
```

---

## Task 3: 團課確認收款 — 整張訂單彙整 + 去重

**Files:**
- Modify: `src/services/groupOrderService.js`
- Modify: `tests/notification-dedup.test.js`（追加案例）

- [ ] **Step 1: 在測試檔追加團課案例（放在 `console.log('[notification-dedup test] done');` 之前）**

```js
// ── Task 3: 團課訂單彙整 + 去重 ──
const gcU = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP GCoach','ndup-gc@x.com',?, 'coach',1)").run(hashPassword('x')); // 教練兼管理者
const gcCoach = createCoach({ userId: gcU.lastInsertRowid, displayName: 'NDUP 團課教練' });
setCoachActive(gcCoach.id, true);
const gcUserId = gcU.lastInsertRowid;
const pureAdmin = db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('NDUP PureAdmin','ndup-pa@x.com',?, 'coach',1)").run(hashPassword('x')).lastInsertRowid; // 純管理者（非該課教練）

const gt = createTemplate({ name: 'NDUP 綜合體能', min_capacity: 1, max_capacity: 10, day_of_week: 3, start_time: '19:00', recurrence: 'weekly', cycle_start_date: dstr(2), cycle_end_date: dstr(45), coach_id: gcCoach.id });
const sess3 = db.prepare('SELECT id, start_at FROM course_sessions WHERE template_id=? ORDER BY start_at ASC LIMIT 3').all(gt.templateId);
expect('團課測試前置：取得 3 個場次', () => assert.equal(sess3.length, 3));
const go = createGroupOrder({ name: '沈嗗', phone: '0955000002', paySessionIds: sess3.map(s => s.id) });
confirmGroupOrder({ orderId: go.orderId, actorId: pureAdmin });

expect('團課多堂：教練只收一則 course_registered_coach_batch', () => assert.equal(notifCount(gcUserId, 'course_registered_coach_batch'), 1));
expect('教練那則含「共 3 堂」與全部 3 個日期(M/D)', () => {
  const row = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='course_registered_coach_batch' ORDER BY id DESC LIMIT 1").get(gcUserId);
  assert(row.body.includes('共 3 堂'), row.body);
  for (const s of sess3) { const m=/^\d{4}-(\d{2})-(\d{2})/.exec(s.start_at); const md=`${Number(m[1])}/${Number(m[2])}`; assert(row.body.includes(md), `body 應含 ${md}: ${row.body}`); }
});
expect('教練兼管理者不再收 course_registered_admin*（去重）', () => {
  const c = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type IN ('course_registered_admin','course_registered_admin_batch')").get(gcUserId).c;
  assert.equal(c, 0);
});
expect('純管理者收一則 course_registered_admin_batch 摘要', () => assert.equal(notifCount(pureAdmin, 'course_registered_admin_batch'), 1));
expect('會員仍只收一則 payment_received', () => assert.equal(notifCount(go.memberId, 'payment_received'), 1));

// N=1 訂單 → 用單堂範本（無「共 N 堂」）
const sess1 = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC LIMIT 1 OFFSET 3').all(gt.templateId);
expect('團課測試前置：取得第 4 個場次（N=1 用）', () => assert.equal(sess1.length, 1));
const go1 = createGroupOrder({ name: '沈嗗', phone: '0955000003', paySessionIds: sess1.map(s => s.id) });
confirmGroupOrder({ orderId: go1.orderId, actorId: pureAdmin });
expect('N=1 團課：教練收單堂 course_registered_coach（非 batch）', () => assert.equal(notifCount(gcUserId, 'course_registered_coach'), 1));
```

- [ ] **Step 2: 跑測試確認新案例失敗**

Run: `node tests/notification-dedup.test.js`
Expected: 團課多堂相關案例 ✗（修正前：逐場發 `course_registered_coach` × 3、且教練兼管理者另收 `course_registered_admin` × 3；沒有 batch 型別 → batch 計數=0）。

- [ ] **Step 3: 在 `groupOrderService.js` 模組頂部新增 helper 與 prepared stmt**

在檔案既有「模組級 prepared statements」附近（例如 `getTemplate`/`getSession` 宣告之後）加入：
```js
const getCoachUserIdStmt = db.prepare('SELECT user_id FROM coaches WHERE id = ?');

// '2026-07-08T19:00:00' → '7/8'（無前導零、無年、無時間）
function fmtMD(startAt) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(startAt || '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(startAt);
}
```

- [ ] **Step 4: 改寫 `confirmGroupOrder` 的逐場通知為整單彙整（src/services/groupOrderService.js）**

把現有區塊：
```js
    // 加掛：逐場通知該場次教練「新報名」（一筆訂單可能跨多場、多位教練）
    const confirmedSessions = db.prepare(`
      SELECT s.id AS session_id, s.coach_id, s.start_at, t.name AS course_name
      FROM registrations r JOIN course_sessions s ON s.id = r.session_id
      JOIN course_templates t ON t.id = s.template_id
      WHERE r.order_id = ? AND r.status = 'confirmed'
    `).all(orderId);
    for (const cs of confirmedSessions) {
      const vars = { member_name: order.customer_name, course_name: cs.course_name, start_at: cs.start_at };
      notifyCourseCoach({ coachId: cs.coach_id, sessionId: cs.session_id, type: 'course_registered_coach', vars });
      // 加掛：店家管理者廣播（中性第三人稱，不含「你帶的」）
      notifyAdmins({ sessionId: cs.session_id, type: 'course_registered_admin', excludeUserId: order.member_id, vars });
    }
```
改為：
```js
    // 加掛：整張訂單「彙整」通知教練與管理者（去重：教練收「你帶的」一則，
    // 非教練管理者每門課收摘要一則；同一人兼教練+管理者只收教練版那一則）。
    const confirmedSessions = db.prepare(`
      SELECT s.id AS session_id, s.coach_id, s.start_at, t.name AS course_name
      FROM registrations r JOIN course_sessions s ON s.id = r.session_id
      JOIN course_templates t ON t.id = s.template_id
      WHERE r.order_id = ? AND r.status = 'confirmed'
      ORDER BY s.start_at
    `).all(orderId);
    if (confirmedSessions.length) {
      const byCoachCourse = new Map(); // key: `${coach_id} ${course_name}`
      const byCourse = new Map();      // key: course_name
      for (const cs of confirmedSessions) {
        const ck = `${cs.coach_id} ${cs.course_name}`;
        if (!byCoachCourse.has(ck)) byCoachCourse.set(ck, { coachId: cs.coach_id, courseName: cs.course_name, sessionIds: [], dates: [] });
        const cg = byCoachCourse.get(ck);
        cg.sessionIds.push(cs.session_id); cg.dates.push(cs.start_at);
        if (!byCourse.has(cs.course_name)) byCourse.set(cs.course_name, { courseName: cs.course_name, dates: [] });
        byCourse.get(cs.course_name).dates.push(cs.start_at);
      }
      // 教練版（並收集所有教練 user_id，供管理者廣播排除）
      const coachUserIds = new Set();
      for (const g of byCoachCourse.values()) {
        const cuRow = getCoachUserIdStmt.get(g.coachId);
        if (cuRow) coachUserIds.add(cuRow.user_id);
        if (g.dates.length === 1) {
          notifyCourseCoach({ coachId: g.coachId, sessionId: g.sessionIds[0], type: 'course_registered_coach',
            vars: { member_name: order.customer_name, course_name: g.courseName, start_at: fmtMD(g.dates[0]) } });
        } else {
          notifyCourseCoach({ coachId: g.coachId, sessionId: g.sessionIds[0], type: 'course_registered_coach_batch',
            vars: { member_name: order.customer_name, course_name: g.courseName, count: g.dates.length, date_list: g.dates.map(fmtMD).join('、') } });
        }
      }
      // 管理者摘要版（每門課一則；排除 member + 所有帶課教練 user_id）
      const adminExclude = [order.member_id, ...coachUserIds];
      for (const g of byCourse.values()) {
        if (g.dates.length === 1) {
          notifyAdmins({ type: 'course_registered_admin', excludeUserIds: adminExclude,
            vars: { member_name: order.customer_name, course_name: g.courseName, start_at: fmtMD(g.dates[0]) } });
        } else {
          notifyAdmins({ type: 'course_registered_admin_batch', excludeUserIds: adminExclude,
            vars: { member_name: order.customer_name, course_name: g.courseName, count: g.dates.length, date_list: g.dates.map(fmtMD).join('、') } });
        }
      }
    }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node tests/notification-dedup.test.js`
Expected: 全 ✓（Task 1+2+3），無 ✗。

- [ ] **Step 6: 回歸既有團課通知測試**

Run: `node tests/group-coach-notify.test.js` 然後 `node tests/admin-notify-broadcast.test.js`
Expected: 兩者皆全 ✓（單場訂單仍走單堂範本；管理者仍收 `course_registered_admin`）。

- [ ] **Step 7: Commit**

```bash
git add src/services/groupOrderService.js tests/notification-dedup.test.js
git commit -m "fix(notify): 團課確認收款改整單彙整，去除逐堂與重複通知"
```

---

## Task 4: 全套回歸 + 收尾

**Files:** 無（驗證用）

- [ ] **Step 1: 跑單元測試套件（含新測試）**

Run: `npm test`
Expected: 全綠（注意 `npm test` 會清掉 demo 資料）。特別確認 `admin-notify-broadcast`、`group-coach-notify`、`course-coach-notify`、`group-order-service`、`group-order-tuning`、`notifications-flow`、`booking-flow`、`recurring-booking`、`notification-dedup` 皆 ✓。若有 ✗，修正後重跑。

- [ ] **Step 2: 跑需要 server 的 API 測試（與通知相關者）**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js > /tmp/srv-ndup.log 2>&1 &
SRV=$!; sleep 2
node tests/admin-group-orders.test.js
node tests/booking-payment-api.test.js
node tests/recurring-booking-api.test.js
kill $SRV 2>/dev/null
```
Expected: 無 ✗。（`gmail-auth-api.test.js` 在無 Google 憑證的本機為既有環境性失敗，與本次無關。）

- [ ] **Step 3: 重新 seed demo 資料供預覽**

```bash
npm run seed && node src/db/seed-demo.js
```
Expected: 完成。

- [ ] **Step 4: 收尾**

以 `superpowers:finishing-a-development-branch` 收尾（依業主慣例：push + squash merge 至 main → 自動部署 prod）。

---

## Self-Review

**1. Spec coverage**
- A `notifyAdmins` excludeUserIds：Task 1 ✓
- 彙整範本：Task 1 ✓
- B 1對1 排除教練：Task 2 ✓
- C 團課整單彙整（分組、N=1 單堂/N>1 batch、排除教練 user_id、跨課每門一則）：Task 3 ✓
- E `fmtMD`：Task 3 Step 3 ✓
- 會員 payment_received 不動、recurring 不動、legacy register() 不動：本計畫未觸及 ✓
- 測試（1對1 去重、團課彙整、N=1、非教練管理者收摘要、回歸）：Task 1–4 ✓

**2. Placeholder scan**：無 TBD/TODO；每步皆含可執行內容與實際斷言。✓

**3. Type/identifier consistency**
- `notifyAdmins` 新參數 `excludeUserIds`（陣列）在 Task 1 定義、Task 2/3 使用，名稱一致。✓
- 範本鍵 `course_registered_coach_batch` / `course_registered_admin_batch` 在 Task 1 定義、Task 3 使用一致；vars `count`、`date_list`、`member_name`、`course_name`、`start_at` 一致。✓
- `getCoachUserIdStmt`、`fmtMD` 在 Task 3 Step 3 定義、Step 4 使用一致。✓
- 測試 helper `notifCount`、`dstr`、`futureLocal` 在 Task 1 表頭定義、後續任務沿用。✓
