# 教練課付款狀態流 + 視窗無上限 + 教練列表排序 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教練課兩階段付款狀態（待確認→已核對）＋ 預約日期無上限 ＋ 教練後台列表新→舊排序。

**Architecture:** `bookings.paid_at/paid_by` 鏡像 `group_orders` 同名欄位；status 不變（佔時段/容量/gcal 全不動）。Admin 三個新端點掛在既有 group-orders admin 路由旁；後台「待核對匯款」合併兩種款項、新增「已核對匯款」唯讀區塊。通知沿用 notifications/LINE/email 既有機制。

**Tech Stack:** 同主專案（Node 24 ESM、Express 4、node:sqlite、vanilla JS）。

**Spec:** `docs/superpowers/specs/2026-06-12-booking-payment-flow-design.md`

**分支：** `feat/booking-payment-flow`（已存在）。每 Task 結尾 commit，message 結尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。⚠️ 不要 `git add -A`（有不入庫的 untracked 檔）。

**API 測試 server：** `LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id PORT=3100 node src/server.js`，`BASE=http://localhost:3100`。

---

### Task 1: 視窗無上限 + 教練列表排序 + paid_at/paid_by 遷移

**Files:**
- Modify: `src/services/availabilityService.js`、`src/services/bookingService.js`（listCoachStmt）
- Modify: `src/db/schema.js`、`src/db/connection.js`
- Test: `tests/payment-flow-base.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/payment-flow-base.test.js`：

```js
// 視窗無上限 + 教練列表 created_at 排序 + paid_at/paid_by 欄位與 backfill 語意。
import assert from 'node:assert/strict';
import { db, nowLocal } from '../src/db/connection.js';
import { addRule, computeAvailableSlots } from '../src/services/availabilityService.js';
import { listCoachBookings } from '../src/services/bookingService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payment-flow-base test] start');
db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'pfb-%'");

const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('PFB Coach','pfb-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'PFB', 1)").run(uid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('客','pfb-m@x.com','user')").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const dateAt = (days) => { const d = new Date(Date.now() + days*86400000); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };

// 規則覆蓋所有星期（任何遠期日期都有班表）
for (let dow = 0; dow <= 6; dow++) addRule({ coachId, dayOfWeek: dow, startTime: '09:00', endTime: '12:00' });

expect('視窗無上限：+400 天仍有 slot（預設）', () => {
  const far = dateAt(400);
  const s = computeAvailableSlots({ coachId, fromDate: far, toDate: far });
  assert.ok(s.length > 0);
});
expect('bookingWindowDays 參數仍可限縮（30 → +400 天無 slot）', () => {
  const far = dateAt(400);
  const s = computeAvailableSlots({ coachId, fromDate: far, toDate: far, bookingWindowDays: 30 });
  assert.equal(s.length, 0);
});

// paid_at / paid_by 欄位存在
const cols = db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);
expect('bookings.paid_at 存在', () => assert.ok(cols.includes('paid_at')));
expect('bookings.paid_by 存在', () => assert.ok(cols.includes('paid_by')));

// backfill 語意（直接驗證遷移 UPDATE 的條件式，於 fixture 列重現）：
// 過去場次 → paid、未來場次 → NULL
const insB = db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'confirmed')");
const past = Number(insB.run(coachId, mid, '2020-01-01T10:00:00', '2020-01-01T11:00:00').lastInsertRowid);
const fut  = Number(insB.run(coachId, mid, `${dateAt(10)}T10:00:00`, `${dateAt(10)}T11:00:00`).lastInsertRowid);
db.prepare("UPDATE bookings SET paid_at = created_at WHERE status='confirmed' AND paid_at IS NULL AND start_at < ?").run(nowLocal());
expect('backfill：過去場次 → paid_at=created_at', () => {
  const r = db.prepare('SELECT paid_at, created_at FROM bookings WHERE id=?').get(past);
  assert.ok(r.paid_at && r.paid_at === r.created_at);
});
expect('backfill：未來場次 → paid_at NULL（進待核對）', () => {
  assert.equal(db.prepare('SELECT paid_at FROM bookings WHERE id=?').get(fut).paid_at, null);
});

// 教練列表排序：created_at 新→舊（同秒以 id 決勝）
expect('listCoachBookings 以 created_at DESC, id DESC', () => {
  const list = listCoachBookings(coachId);
  assert.equal(list[0].id, fut);   // 後插入者在前（同 created_at 秒級時 id 較大者在前）
  assert.equal(list[1].id, past);
});

db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'pfb-%'");
console.log('[payment-flow-base test] done');
```

- [ ] **Step 2: 跑測試確認失敗** — `node tests/payment-flow-base.test.js`（+400 天無 slot、欄位不存在、排序錯）。
- [ ] **Step 3: availabilityService.js** — 刪除 `export const BOOKING_WINDOW_DAYS = 30;` 那行（先 `grep -rn BOOKING_WINDOW_DAYS src tests public` 確認只有本檔引用；若 tests 有 import 一併調整）。`computeAvailableSlots` 簽名與視窗計算改為：

```js
export function computeAvailableSlots({ coachId, fromDate, toDate, bookingWindowDays = null, externalBusy = null }) {
```

```js
  const bufferMs = now.getTime() + BUFFER_HOURS * 3600_000;
  // bookingWindowDays=null → 預約日期無上限（預設）；傳數值可限縮（測試用）
  const windowEndMs = bookingWindowDays == null ? Infinity : now.getTime() + bookingWindowDays * 86400_000;
```

（既有 `if (slotMs > windowEndMs) return false;` 對 Infinity 永為 false，不用動。）JSDoc 同步更新一句。
- [ ] **Step 4: bookingService.js** — `listCoachStmt` 的 `ORDER BY b.start_at DESC` 改 `ORDER BY b.created_at DESC, b.id DESC`。
- [ ] **Step 5: schema.js** — bookings CREATE TABLE 在 `customer_email TEXT,` 之後加：

```sql
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
```

- [ ] **Step 6: connection.js** — 在 gcal 遷移區塊之後加（`nowLocal` 為 hoisted function declaration，可在定義前呼叫）：

```js
// ── 2026-06-12 教練課付款狀態流 ──
// paid_at NULL=待核對、非 NULL=已核對（鏡像 group_orders.paid_at/paid_by；status 不變，佔時段/容量照舊）。
// 一次性 backfill（偵測訊號=欄位不存在）：上線當下過去場次視為已核對、未來場次留 NULL 進待核對（業主決策）。
const bkPayCols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (!bkPayCols.includes('paid_at')) {
  db.exec('ALTER TABLE bookings ADD COLUMN paid_at TEXT');
  db.exec('ALTER TABLE bookings ADD COLUMN paid_by INTEGER REFERENCES users(id)');
  const { changes } = db.prepare(
    "UPDATE bookings SET paid_at = created_at WHERE status='confirmed' AND start_at < ?"
  ).run(nowLocal());
  console.log(`[migrate] bookings.paid_at/paid_by added; ${changes} past bookings backfilled as paid`);
}
```

- [ ] **Step 7: 跑測試** — `node tests/payment-flow-base.test.js` 全 ✓；回歸 `node tests/capacity.test.js && node tests/availability-leave.test.js && node tests/booking-flow.test.js && node tests/booking-anon.test.js` ✓。把 payment-flow-base 加進 package.json `test` 串列尾端。
- [ ] **Step 8: Commit** — `git add src/services/availabilityService.js src/services/bookingService.js src/db/schema.js src/db/connection.js tests/payment-flow-base.test.js package.json` → `feat: 預約視窗無上限 + 教練列表新到舊 + paid_at 遷移`

---

### Task 2: service 層付款核對 + 通知 + 款項確認信

**Files:**
- Modify: `src/services/bookingService.js`（三個新 export）
- Modify: `src/services/notifications.js`（新 template）
- Modify: `src/services/emailService.js`（insertNotif 泛化 + 新函式 + 既有確認信加一行）
- Test: `tests/booking-payment.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/booking-payment.test.js`：

```js
// 付款核對 service：守門、清單、通知列、款項確認信。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
process.env.GMAIL_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const { confirmBookingPayment, listPendingPaymentBookings, listConfirmedPayments } = await import('../src/services/bookingService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-payment test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM group_orders; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bp-%'");

const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練丙','bp-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練丙', 1)").run(cuid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('王小付','bp-m@x.com','user','0995777888')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('管理者','bp-a@x.com','coach',1)").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 5*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, discount_amount, discount_code, customer_email) VALUES (?, ?, ?, ?, '1on1', 1500, 100, 'TEST', 'pay@example.com')"
).run(coachId, mid, `${date}T10:00:00`, `${date}T11:00:00`).lastInsertRowid);

expect('pending 清單含該預約（final_amount=1400）', () => {
  const list = listPendingPaymentBookings();
  const row = list.find(x => x.id === bid);
  assert.ok(row);
  assert.equal(row.final_amount, 1400);
  assert.equal(row.member_name, '王小付');
  assert.equal(row.coach_display_name, '教練丙');
});

expect('confirm：寫 paid_at/paid_by', () => {
  const r = confirmBookingPayment({ bookingId: bid, actorId: admin });
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT paid_at, paid_by FROM bookings WHERE id=?').get(bid);
  assert.ok(row.paid_at);
  assert.equal(row.paid_by, admin);
});

expect('confirm 後不在 pending 清單', () => {
  assert.ok(!listPendingPaymentBookings().some(x => x.id === bid));
});

expect('重複 confirm → 409 already_paid', () => {
  assert.throws(() => confirmBookingPayment({ bookingId: bid, actorId: admin }), /already_paid/);
});
expect('不存在 → 404', () => {
  assert.throws(() => confirmBookingPayment({ bookingId: 999999, actorId: admin }), /booking_not_found/);
});
expect('已取消 → 409 booking_cancelled', () => {
  const b2 = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'cancelled')").run(coachId, mid, `${date}T14:00:00`, `${date}T15:00:00`).lastInsertRowid);
  assert.throws(() => confirmBookingPayment({ bookingId: b2, actorId: admin }), /booking_cancelled/);
});

expect('LINE 通知列：booking_payment_received（寄會員）', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_payment_received' AND user_id=?").get(mid);
  assert.ok(n);
  assert.ok(n.body.includes('教練丙'));
});

// email 是 fire-and-forget async → 等一拍再查
await new Promise(r => setTimeout(r, 50));
expect('款項確認信：notifications email/console 列（recipient 正確）', () => {
  const n = db.prepare("SELECT * FROM notifications WHERE type='booking_payment_email' AND user_id=?").get(mid);
  assert.ok(n);
  assert.equal(n.recipient, 'pay@example.com');
});

expect('listConfirmedPayments：教練課＋團課合併、按 paid_at DESC', () => {
  db.prepare("INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, status, expires_at, paid_at, paid_by) VALUES (?, '團客', '0995111222', 900, 'paid', ?, ?, ?)")
    .run(mid, nowLocal(), '2099-01-01T00:00:00', admin);
  const list = listConfirmedPayments();
  assert.equal(list[0].type, 'group_order');           // paid_at 2099 在最前
  assert.ok(list.some(x => x.type === 'booking' && x.id === bid));
  const b = list.find(x => x.type === 'booking' && x.id === bid);
  assert.equal(b.paid_by_name, '管理者');
  assert.equal(b.amount, 1400);
});

db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM group_orders; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'bp-%'");
console.log('[booking-payment test] done');
```

- [ ] **Step 2: 跑測試確認失敗**（import 失敗）。
- [ ] **Step 3: notifications.js** — TEMPLATES 的 1on1 區塊（booking_cancelled_by_coach 之後）加：

```js
  booking_payment_received: {  // 寄給會員（admin 核對教練課款項後）
    subject: '款項已確認 - {{coach_display_name}}',
    body: '✅ 已收到您的款項，{{coach_display_name}} 教練 {{start_at}} 的課程預約確認成立，期待見到您！',
  },
```

- [ ] **Step 4: emailService.js** —
  1. `insertNotif` 泛化（type 改為參數）：

```js
const insertNotif = db.prepare(`
  INSERT INTO notifications (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error, recipient)
  VALUES (?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)
`);
```

  既有 `sendBookingConfirmation` 內三處 `insertNotif.run(b.member_id, ...)` 改為帶入 `'booking_email_confirmation'` 作第二參數（其餘參數順延）。
  2. `_buildConfirmationHtml` 在「如需取消…」段落之後加一行：

```js
  <p style="color:#64748b;font-size:14px">款項核對完成後會再寄送確認通知。</p>
```

  3. 檔尾新增：

```js
/** admin 核對款項後呼叫（fire-and-forget）。無 customer_email 自動略過。 */
export async function sendPaymentConfirmedEmail(bookingId) {
  try {
    const b = getBookingFull.get(bookingId);
    if (!b || !b.customer_email) return;
    const final = b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null;
    const [date, time] = b.start_at.split('T');
    const subject = `款項確認｜${b.start_at.slice(5, 10).replace('-', '/')} ${b.start_at.slice(11, 16)} ${b.coach_name} 教練`;
    const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="color:#15803d">款項已確認，預約成立</h2>
  <p>${esc(b.member_name)} 您好，我們已收到您的款項${final != null ? `（NT$${final.toLocaleString()}）` : ''}，以下預約確認成立：</p>
  <p><strong>${esc(b.coach_name)}</strong> 教練｜${esc(date.replace(/-/g, '/'))} ${esc(time.slice(0, 5))}｜${b.session_type === '1on2' ? '1對2' : '1對1'}</p>
  <p style="color:#94a3b8;font-size:12px">此信由系統自動發送，請勿直接回覆。</p>
</div>`;
    if (!isGmailConfigured()) {
      insertNotif.run(b.member_id, 'booking_payment_email', 'console', subject, html, 'sent', null, null, b.customer_email);
      console.log(`[email→console] payment-confirmed booking=${bookingId} to=${b.customer_email}`);
      return;
    }
    const r = await sendMail({ to: b.customer_email, subject, html });
    if (r.ok) {
      insertNotif.run(b.member_id, 'booking_payment_email', 'email', subject, html, 'sent', null, null, b.customer_email);
    } else {
      insertNotif.run(b.member_id, 'booking_payment_email', 'email', subject, html, 'failed', offsetLocal(5 * 60_000), r.error, b.customer_email);
    }
  } catch (e) { console.error('[email] sendPaymentConfirmedEmail threw:', e); }
}
```

- [ ] **Step 5: bookingService.js** — import 區加 `import { sendPaymentConfirmedEmail } from './emailService.js';`（emailService 不 import bookingService，無循環），prepared statements 區加 pending 查詢，檔尾（listCoachBookings 之後）加三個 export：

```js
const listPendingPaymentStmt = db.prepare(`
  SELECT b.id, b.start_at, b.session_type, b.created_at,
         b.original_amount, b.discount_amount, b.discount_code,
         u.name AS member_name, u.phone AS member_phone,
         c.display_name AS coach_display_name
  FROM bookings b
  JOIN users u ON u.id = b.member_id
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.status = 'confirmed' AND b.paid_at IS NULL
  ORDER BY b.created_at DESC, b.id DESC
`);

/** 後台「待核對匯款」：未核對的教練課預約（含應收金額）。 */
export function listPendingPaymentBookings() {
  return listPendingPaymentStmt.all().map((b) => ({
    ...b,
    final_amount: b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null,
  }));
}

/** admin 核對教練課款項：寫 paid_at/paid_by，通知會員（LINE＋email）。 */
export function confirmBookingPayment({ bookingId, actorId }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'booking_cancelled');
    if (b.paid_at) throw new ApiError(409, 'already_paid');
    db.prepare('UPDATE bookings SET paid_at=?, paid_by=? WHERE id=?').run(nowLocal(), actorId, bookingId);
    const coach = getCoachStmt.get(b.coach_id);
    if (coach) {
      notify({ userId: b.member_id, sessionId: null, type: 'booking_payment_received',
        vars: { coach_display_name: coach.display_name, start_at: fmtDateForLine(b.start_at) } });
    }
    sendPaymentConfirmedEmail(bookingId); // async fire-and-forget（無 email 自動略過）
    return { ok: true };
  });
}

/** 後台「已核對匯款」：教練課＋團課訂單合併，paid_at 新→舊，最多 50 筆。 */
export function listConfirmedPayments() {
  const bookings = db.prepare(`
    SELECT 'booking' AS type, b.id, u.name AS customer_name, u.phone AS customer_phone,
           CASE WHEN b.original_amount IS NULL THEN NULL
                ELSE b.original_amount - COALESCE(b.discount_amount, 0) END AS amount,
           b.start_at AS detail, b.session_type, b.paid_at, pu.name AS paid_by_name
    FROM bookings b
    JOIN users u ON u.id = b.member_id
    LEFT JOIN users pu ON pu.id = b.paid_by
    WHERE b.paid_at IS NOT NULL
    ORDER BY b.paid_at DESC LIMIT 50
  `).all();
  const orders = db.prepare(`
    SELECT 'group_order' AS type, o.id, o.customer_name, o.customer_phone,
           o.total_amount AS amount,
           (SELECT COUNT(*) FROM registrations r WHERE r.order_id = o.id AND r.status = 'confirmed') || ' 場次' AS detail,
           NULL AS session_type, o.paid_at, pu.name AS paid_by_name
    FROM group_orders o
    LEFT JOIN users pu ON pu.id = o.paid_by
    WHERE o.status = 'paid'
    ORDER BY o.paid_at DESC LIMIT 50
  `).all();
  return [...bookings, ...orders]
    .sort((a, b) => (a.paid_at < b.paid_at ? 1 : a.paid_at > b.paid_at ? -1 : 0))
    .slice(0, 50);
}
```

注意：`listConfirmedPayments` 的兩個查詢不能做成 module-load 期的 prepared statement 常數也可以（可重用 db.prepare 於函式內，node:sqlite 每次 prepare 成本可接受、與 listPendingOrders 既有寫法一致）。
- [ ] **Step 6: 跑測試** — `node tests/booking-payment.test.js` 全 ✓；回歸 `node tests/email-confirmation.test.js && node tests/notifications-flow.test.js && node tests/booking-anon.test.js` ✓。把 booking-payment 加進 package.json `test`。
- [ ] **Step 7: Commit** — `feat: 教練課付款核對 service + LINE/email 通知`

---

### Task 3: admin 路由 + my-schedule paid 欄位 + API 測試

**Files:**
- Modify: `src/server.js`、`src/services/groupOrderService.js`（getPublicSchedule）
- Test: `tests/booking-payment-api.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/booking-payment-api.test.js`：

```js
// 付款核對 API：pending/confirm/confirmed 三端點 + /api/public/my 的 paid 欄位。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule } from '../src/services/availabilityService.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-payment-api test] start');

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0994%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0994%'); DELETE FROM users WHERE phone LIKE '0994%' OR email LIKE 'bpa-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('BPA Coach','bpa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BPA', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 4*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

// 公開預約 → 應為待核對
const bk = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '吳小核', phone: '0994000111' } });
expect('預約 201', () => assert.equal(bk.status, 201));
const bid = bk.data?.id;

const p1 = await req('GET', '/api/admin/bookings/pending', { token });
expect('pending 清單含新預約', () => {
  assert.equal(p1.status, 200);
  assert.ok(p1.data.some(x => x.id === bid));
});
expect('未登入 pending → 401', async () => {});
const noAuth = await req('GET', '/api/admin/bookings/pending');
expect('無 token pending → 401', () => assert.equal(noAuth.status, 401));

const my1 = await req('POST', '/api/public/my', { body: { phone: '0994000111', name: '吳小核' } });
expect('我的課表：paid=false（待確認）', () => {
  const item = my1.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.ok(item);
  assert.equal(item.paid, false);
});

const cf = await req('POST', `/api/admin/bookings/${bid}/confirm-payment`, { token });
expect('confirm-payment 200', () => assert.equal(cf.status, 200));
const cf2 = await req('POST', `/api/admin/bookings/${bid}/confirm-payment`, { token });
expect('重複 confirm → 409 already_paid', () => {
  assert.equal(cf2.status, 409);
  assert.equal(cf2.data.error, 'already_paid');
});

const p2 = await req('GET', '/api/admin/bookings/pending', { token });
expect('confirm 後不在 pending', () => assert.ok(!p2.data.some(x => x.id === bid)));

const done = await req('GET', '/api/admin/payments/confirmed', { token });
expect('confirmed 清單含該預約（type=booking、有經手人）', () => {
  assert.equal(done.status, 200);
  const row = done.data.find(x => x.type === 'booking' && x.id === bid);
  assert.ok(row);
  assert.ok(row.paid_by_name);
});

const my2 = await req('POST', '/api/public/my', { body: { phone: '0994000111', name: '吳小核' } });
expect('我的課表：paid=true（已確認）', () => {
  const item = my2.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.equal(item.paid, true);
});

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0994%'); DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0994%' OR email LIKE 'bpa-%'");
console.log('[booking-payment-api test] done');
```

（檔內有一個空殼 expect('未登入 pending → 401', async () => {}) 為冗餘，實作時直接刪掉該行、保留下一行的實際斷言。）
- [ ] **Step 2: server.js** — 既有 `POST /api/admin/group-orders/:id/cancel` 之後加：

```js
// --- Admin: 教練課款項核對 ---
app.get('/api/admin/bookings/pending', requireAdmin, asyncHandler((req, res) => {
  res.json(svcListPendingPaymentBookings());
}));
app.post('/api/admin/bookings/:id/confirm-payment', requireAdmin, asyncHandler((req, res) => {
  res.json(svcConfirmBookingPayment({ bookingId: Number(req.params.id), actorId: req.user.id }));
}));
app.get('/api/admin/payments/confirmed', requireAdmin, asyncHandler((req, res) => {
  res.json(svcListConfirmedPayments());
}));
```

bookingService 的 import 區補：`listPendingPaymentBookings as svcListPendingPaymentBookings, confirmBookingPayment as svcConfirmBookingPayment, listConfirmedPayments as svcListConfirmedPayments`。
- [ ] **Step 3: groupOrderService.js** — `getPublicSchedule` 的 bookings SELECT 加 `b.paid_at`，map 物件加 `paid: !!b.paid_at`。
- [ ] **Step 4: 跑 API 測試** — 起 server 後 `BASE=http://localhost:3100 node tests/booking-payment-api.test.js` 全 ✓；回歸 `BASE=... node tests/booking-validate-api.test.js && BASE=... node tests/public-api.test.js && BASE=... node tests/my-schedule-routing.test.js` ✓。把新測試加進 package.json `test:api`。`node tests/my-schedule-service.test.js` 也跑（getPublicSchedule 多欄位為 additive）。
- [ ] **Step 5: Commit** — `feat: 付款核對 admin API + 我的課表 paid 狀態`

---

### Task 4: 前端（admin 合併清單 + 已核對區塊 + my-schedule/coach badge）

**Files:**
- Modify: `public/admin.html`、`public/admin.js`、`public/my-schedule.js`、`public/coach.js`

- [ ] **Step 1: admin.html** — `#pending-orders` section 的 `</section>` 之後（同一個報名作業 panel 內）加：

```html
  <section id="confirmed-payments" class="mb-10">
    <h2 class="section-title mb-3">已核對匯款</h2>
    <div id="confirmed-payments-list" class="grid gap-3"></div>
  </section>
```

（先讀檔確認 `#pending-orders` 的實際結構與 section-title 用法，對齊既有 class。）
- [ ] **Step 2: admin.js — loadPendingOrders 改為合併清單**。整段替換為（保留既有兩個 confirm/cancel handler 邏輯，加入教練課）：

```js
// --- Pending bank-transfer orders（團課訂單 + 教練課預約 合併清單） ---
async function loadPendingOrders() {
  const container = document.getElementById('pending-orders-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const [orders, bookings] = await Promise.all([
      api('/api/admin/group-orders'),
      api('/api/admin/bookings/pending'),
    ]);
    const items = [
      ...orders.map(o => ({ kind: 'order', created_at: o.created_at, o })),
      ...bookings.map(b => ({ kind: 'booking', created_at: b.created_at, b })),
    ].sort((a, c) => (a.created_at < c.created_at ? 1 : -1)); // 新→舊
    if (!items.length) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">✅</span>
          <p>目前沒有待核對的匯款</p>
        </div>`;
      return;
    }
    container.innerHTML = items.map(it => it.kind === 'order' ? orderCardHtml(it.o) : pendingBookingCardHtml(it.b)).join('');
    bindPendingHandlers(container);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

function orderCardHtml(o) {
  const sessionRows = o.sessions.length
    ? o.sessions.map(s => `<li class="subtle text-xs">${escapeHtml(s.course_name)} @ ${escapeHtml(s.start_at)}</li>`).join('')
    : '<li class="subtle text-xs">（無場次）</li>';
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(o.customer_name)}</h3>
            <span class="badge badge-confirmed">團課</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">📞 ${escapeHtml(o.customer_phone)}</span>
            <span class="meta-item">💰 NT$${Number(o.total_amount).toLocaleString()}</span>
            <span class="meta-item">⏰ 到期 ${escapeHtml(fmtDate(o.expires_at))}</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${sessionRows}</ul>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-id="${o.id}" class="confirm-order-btn btn btn-primary btn-sm">已收款</button>
          <button data-id="${o.id}" class="cancel-order-btn btn btn-danger btn-sm">取消訂單</button>
        </div>
      </div>
    </article>`;
}

function pendingBookingCardHtml(b) {
  const label = b.session_type === '1on2' ? '1對2' : '1對1';
  const amount = b.final_amount != null
    ? `NT$${Number(b.final_amount).toLocaleString()}${b.discount_code ? `（折扣碼 ${escapeHtml(b.discount_code)}）` : ''}`
    : '—';
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(b.member_name)}</h3>
            <span class="badge badge-completed">教練課</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">📞 ${escapeHtml(b.member_phone || '')}</span>
            <span class="meta-item">💰 ${amount}</span>
            <span class="meta-item">🏋️ ${escapeHtml(b.coach_display_name)}（${label}）</span>
            <span class="meta-item">🕐 ${escapeHtml(fmtDate(b.start_at))}</span>
          </div>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-id="${b.id}" class="confirm-booking-btn btn btn-primary btn-sm">已收款</button>
        </div>
      </div>
    </article>`;
}

function bindPendingHandlers(container) {
  container.querySelectorAll('.confirm-order-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`確認已收到「${btn.closest('article').querySelector('.card-title').textContent}」的匯款？`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/group-orders/${btn.dataset.id}/confirm`, { method: 'POST' });
        toast('已確認收款，訂單完成', 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { order_not_found: '找不到訂單', order_cancelled: '訂單已取消' };
        toast(msgs[e.data?.error] || `確認失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.cancel-order-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定取消此訂單？已佔的名額會釋出並通知候補者。')) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/group-orders/${btn.dataset.id}/cancel`, { method: 'POST' });
        toast('已取消訂單', 'success');
        loadPendingOrders();
      } catch (e) {
        const msgs = { order_not_found: '找不到訂單', order_already_paid: '訂單已付款', forbidden: '無權操作此訂單' };
        toast(msgs[e.data?.error] || `取消失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.confirm-booking-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`確認已收到「${btn.closest('article').querySelector('.card-title').textContent}」的教練課款項？`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/bookings/${btn.dataset.id}/confirm-payment`, { method: 'POST' });
        toast('已確認收款，預約成立並已通知會員', 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { booking_not_found: '找不到預約', booking_cancelled: '預約已取消', already_paid: '此筆已核對過' };
        toast(msgs[e.data?.error] || `確認失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
}

// --- 已核對匯款（唯讀）---
async function loadConfirmedPayments() {
  const container = document.getElementById('confirmed-payments-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const list = await api('/api/admin/payments/confirmed');
    if (!list.length) {
      container.innerHTML = '<div class="subtle p-4">尚無已核對的款項</div>';
      return;
    }
    container.innerHTML = list.map(x => {
      const isBooking = x.type === 'booking';
      const typeBadge = isBooking
        ? `<span class="badge badge-completed">教練課${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
        : '<span class="badge badge-confirmed">團課</span>';
      const detail = isBooking ? fmtDate(x.detail) : x.detail;
      return `
        <article class="card">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap">
              <strong>${escapeHtml(x.customer_name)}</strong>
              ${typeBadge}
              <span class="subtle text-sm">${escapeHtml(detail || '')}</span>
              <span class="subtle text-sm">💰 ${x.amount != null ? 'NT$' + Number(x.amount).toLocaleString() : '—'}</span>
            </div>
            <div class="subtle text-xs">核對 ${escapeHtml(fmtDate(x.paid_at))} · 經手 ${escapeHtml(x.paid_by_name || '—')}</div>
          </div>
        </article>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}
```

「重新整理」鈕改一鍵雙載：

```js
document.getElementById('btn-reload-orders')?.addEventListener('click', () => { loadPendingOrders(); loadConfirmedPayments(); });
```

並找到初始載入呼叫 `loadPendingOrders()` 之處（grep），在旁邊補 `loadConfirmedPayments();`。
注意：`x.paid_at` 是 group_orders（nowLocal 牆鐘）與 bookings（nowLocal）一致格式，`fmtDate` 可直接吃；訂單的 `created_at`/教練課 `created_at` 都是 SQLite UTC `datetime('now')` 字串，混排比較一致 ✓。
- [ ] **Step 3: my-schedule.js** — `resolveStatus` 的 booking 分支整段替換：

```js
  if (item.kind === 'booking') {
    if (item.status === 'cancelled') return { label: '已取消', cls: 'badge-cancelled' };
    if (item.status === 'confirmed') {
      // 兩階段：admin 核對款項前為「待確認」
      return item.paid
        ? { label: '已確認', cls: 'badge-confirmed' }
        : { label: '待確認', cls: 'badge-waitlisted' };
    }
    return { label: item.status, cls: 'badge-completed' };
  }
```

（檔頭 JSDoc 註解同步更新一句。）
- [ ] **Step 4: coach.js** — `renderBookings` 卡片的姓名列加付款 badge：`cancelled` 宣告之後加

```js
    const payBadge = cancelled ? '' : (b.paid_at
      ? ' <span class="text-xs font-medium text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 align-middle">已確認</span>'
      : ' <span class="text-xs font-medium text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 align-middle">待確認</span>');
```

並在 innerHTML 的 1對2 badge 之後插入 `${payBadge}`。
- [ ] **Step 5: 驗證** — `node --check public/admin.js && node --check public/my-schedule.js && node --check public/coach.js`；起 server 確認 `/admin.html`、`/my-schedule`、`/coach.html` 皆 200。
- [ ] **Step 6: Commit** — `feat: 後台待核對合併教練課 + 已核對匯款區塊 + 前台付款狀態 badge`

---

### Task 5: 全測試 + 收尾

- [ ] **Step 1:** `npm test` 全綠（含新加的 payment-flow-base、booking-payment）。
- [ ] **Step 2:** 起 server 跑 `BASE=http://localhost:3100 npm run test:api` 全綠（含 booking-payment-api）。
- [ ] **Step 3:** `npm run seed && node src/db/seed-demo.js` 重建 demo 資料。
- [ ] **Step 4:** 若 Step 1-2 有非本分支造成的殘留型失敗，比照既有 reset 模式補刪（紀錄於回報）。
- [ ] **Step 5:** 無需額外 commit（除非 Step 4 動到測試檔 → `test: ...` commit）。

---

## 完成後（主流程處理）
最終整合審查（正確性＋安全各一）→ draft PR → 業主瀏覽器煙測 → merge → prod 驗證（既有未來場次會出現在待核對清單，業主人工核一輪）。
