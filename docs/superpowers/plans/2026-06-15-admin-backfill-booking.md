# 管理者補登過去預約 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓管理者在預約頁解鎖「上週」按鈕、回看過去日期，並對過去時段補登（靜默、預設已核對、可改價）的預約；一般使用者行為完全不變。

**Architecture:** 後端在 `computeAvailableSlots` 加 `includePast`（僅管理者經 `GET /api/coaches/:id/availability?backfill=1` 觸發），過去時段不套容量/重疊/緩衝/視窗過濾；補登寫入走獨立 `createBackfillBooking` + `POST /api/admin/bookings/backfill`（`requireAdmin`、強制 `startAt < now`、標記已付款、不發通知/不建日曆/不套折扣）。前端依 `getUser().is_admin` 解鎖週次、依每個 slot 的 `past` 旗標切換補登彈窗。

**Tech Stack:** Node.js（ESM）、Express 4、node:sqlite、原生前端 JS（無框架）、測試為純 node 腳本（`node tests/x.test.js`）。

**參考設計：** `docs/superpowers/specs/2026-06-15-admin-backfill-booking-design.md`

**重要慣例：**
- 永不 `git add -A`（未追蹤的 test.db / data/ / _design/ / scripts/ / *.md 雜項要排除）；每個 commit 明確列出檔案。
- commit 訊息結尾：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 已在分支 `feat/admin-backfill-booking`。

---

## File Structure

- `src/services/availabilityService.js`（修改）— `computeAvailableSlots` 加 `includePast`；過去時段輸出 `past:true`，未來輸出 `past:false`。
- `src/services/bookingService.js`（修改）— 新增 `createBackfillBooking`。
- `src/server.js`（修改）— `GET /api/coaches/:id/availability` 加 `backfill` 參數（管理者限定）；新增 `POST /api/admin/bookings/backfill`；import `createBackfillBooking`。
- `public/coaches.html`（修改）— 補登橫幅、金額列、備註列；折扣列/Email 列加 wrapper id。
- `public/coaches.js`（修改）— `isAdmin`、解鎖上週、`loadSlots` 帶 backfill、`renderTimegrid` 補登標籤、補登彈窗變體、補登送出。
- `public/style.css`（修改）— `.timeslot.slot-past` 樣式。
- `tests/admin-backfill.test.js`（新增）— 單元測試（availability + service）。
- `tests/admin-backfill-api.test.js`（新增）— 端點測試（需伺服器）。
- `package.json`（修改）— 把兩個新測試掛進 `test` / `test:api`。

---

## Task 1: 後端 `computeAvailableSlots` 支援 `includePast`

**Files:**
- Modify: `src/services/availabilityService.js:129-201`
- Test: `tests/admin-backfill.test.js`（本任務先寫 availability 段）

- [ ] **Step 1: 寫失敗測試（availability includePast）**

Create `tests/admin-backfill.test.js`：

```js
// 管理者補登：computeAvailableSlots includePast + createBackfillBooking。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, computeAvailableSlots } from '../src/services/availabilityService.js';
import { createBackfillBooking } from '../src/services/bookingService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-backfill test] start');

// 清理（本測試用 email/phone 前綴 abf-）
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0956%'); DELETE FROM users WHERE email LIKE 'abf-%' OR phone LIKE '0956%'");

// 兩位教練：cPast 測過去、cFut 測未來回歸（避免 dow 規則互相干擾）
const uPast = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABF PastCoach','abf-p@x.com','coach')").run().lastInsertRowid);
const cPast = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABF-P', 1)").run(uPast).lastInsertRowid);
const uFut = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABF FutCoach','abf-f@x.com','coach')").run().lastInsertRowid);
const cFut = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABF-F', 1)").run(uFut).lastInsertRowid);

const past = new Date(Date.now() - 7*86400000);
const pastDate = fmtDate(past);
addRule({ coachId: cPast, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });

expect('includePast 預設 false → 過去日期 0 slot', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate });
  assert.equal(s.length, 0);
});
expect('includePast=true → 過去日期 9 slot、皆 past:true', () => {
  const s = computeAvailableSlots({ coachId: cPast, fromDate: pastDate, toDate: pastDate, includePast: true });
  assert.equal(s.length, 9);
  assert.ok(s.every(x => x.past === true));
  assert.ok(s.some(x => x.start === `${pastDate}T10:00:00`));
});

const fut = new Date(Date.now() + 7*86400000);
const futDate = fmtDate(fut);
addRule({ coachId: cFut, dayOfWeek: fut.getDay(), startTime: '09:00', endTime: '12:00', effectiveFrom: '2000-01-01' });
expect('未來日期：includePast 不改變結果、皆 past:false', () => {
  const a = computeAvailableSlots({ coachId: cFut, fromDate: futDate, toDate: futDate });
  const b = computeAvailableSlots({ coachId: cFut, fromDate: futDate, toDate: futDate, includePast: true });
  assert.equal(a.length, b.length);
  assert.ok(a.length >= 1);
  assert.ok(b.every(x => x.past === false));
});

console.log('[admin-backfill test] availability section done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/admin-backfill.test.js`
Expected: FAIL —「過去日期 9 slot」失敗（目前回 0），且 `past` 欄位為 undefined。

- [ ] **Step 3: 改 `computeAvailableSlots`（加 includePast）**

把 `src/services/availabilityService.js` 的函式簽名與「過濾 + 容量計算」段（約 129、174-200 行）改為：

簽名（129 行）：
```js
export function computeAvailableSlots({ coachId, fromDate, toDate, bookingWindowDays = null, externalBusy = null, includePast = false }) {
```

把原本從 `const nowStr = localWallClock(now);`（174 行）到函式結尾 `return out;`（200 行）整段替換為：

```js
  const nowStr = localWallClock(now);

  // 過去時段（補登用）：僅管理者模式納入；不套緩衝/視窗/容量/重疊過濾，
  // 但仍沿用 dedupedSlots 既有的班表規則 + 請假 + 外部忙碌過濾。
  const pastSlots = includePast ? dedupedSlots.filter(s => s <= nowStr) : [];

  const afterFilter = dedupedSlots.filter(s => {
    if (s <= nowStr) return false;
    const slotMs = new Date(s).getTime();
    if (slotMs < bufferMs) return false;
    if (slotMs > windowEndMs) return false;
    return true;
  });

  const out = [];

  // 未來時段：維持原本容量/重疊判定（行為與既有一致，附 past:false）
  if (afterFilter.length > 0) {
    const rangeStart = afterFilter[0];
    const rangeEnd = addMinutesLocal(afterFilter[afterFilter.length - 1], SLOT_DURATION_MINUTES);
    const coachIntervals = listCoachOverlapping.all(coachId, rangeEnd, rangeStart);
    const loads = bucketLoads(listAllOverlapping.all(rangeEnd, rangeStart));
    const capacity = getBookingHourlyCapacity();
    for (const s of afterFilter) {
      const e = addMinutesLocal(s, SLOT_DURATION_MINUTES);
      if (coachIntervals.some(b => s < b.end_at && e > b.start_at)) continue;
      let remain = capacity;
      for (const key of hourBuckets(s, e)) remain = Math.min(remain, capacity - (loads.get(key) || 0));
      if (remain >= 1) out.push({ start: s, remain, past: false });
    }
  }

  // 過去時段：補登模式，全列、不檢查容量/重疊（remain 設容量值僅供顯示）
  if (pastSlots.length > 0) {
    const capacity = getBookingHourlyCapacity();
    for (const s of pastSlots) out.push({ start: s, remain: capacity, past: true });
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
```

（移除原本的 `if (afterFilter.length === 0) return [];` 早退；新結構在兩段皆空時自然回 `[]`。）

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/admin-backfill.test.js`
Expected: availability 三條 `✓`。

- [ ] **Step 5: 回歸 — 既有 availability 測試不破**

Run: `node tests/availability-leave.test.js && node tests/capacity.test.js && node tests/booking-flow.test.js`
Expected: 全部既有 `✓`（新增 `past` 欄位不影響 `.map(o=>o.start)` 與 `{start,remain}` 形狀斷言）。

- [ ] **Step 6: Commit**

```bash
git add src/services/availabilityService.js tests/admin-backfill.test.js
git commit -m "feat(availability): computeAvailableSlots 支援 includePast（管理者補登）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 後端 `createBackfillBooking` service

**Files:**
- Modify: `src/services/bookingService.js`（新增 export，置於 `createBookingAnon` 之後，約 138 行後）
- Test: `tests/admin-backfill.test.js`（補 service 段）

- [ ] **Step 1: 追加失敗測試（service 段）**

在 `tests/admin-backfill.test.js` 結尾的 `console.log('[admin-backfill test] availability section done');` 之前（或之後、`[admin-backfill test] start` 之後皆可，置於檔案末尾即可）追加：

```js
// ── createBackfillBooking ──
const pastStart = `${pastDate}T10:00:00`;
const r = createBackfillBooking({ coachId: cPast, startAt: pastStart, name: '補登客', phone: '0956000001', sessionType: '1on1', amount: 1500, note: '補登測試', actorId: uPast });
expect('補登：confirmed + paid_at + paid_by + 金額 + note', () => {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.id);
  assert.equal(row.status, 'confirmed');
  assert.ok(row.paid_at);
  assert.equal(row.paid_by, uPast);
  assert.equal(row.original_amount, 1500);
  assert.equal(row.discount_amount, null);
  assert.equal(row.session_type, '1on1');
  assert.equal(row.note, '補登測試');
});
expect('補登：未來 startAt → not_past', () => {
  assert.throws(() => createBackfillBooking({ coachId: cPast, startAt: `${futDate}T10:00:00`, name:'x', phone:'0956000002', amount:0, actorId: uPast }), /not_past/);
});
expect('補登：負數金額 → invalid_amount', () => {
  assert.throws(() => createBackfillBooking({ coachId: cPast, startAt: `${pastDate}T12:00:00`, name:'x', phone:'0956000003', amount:-5, actorId: uPast }), /invalid_amount/);
});
expect('補登：金額 0 合法（贈課）', () => {
  const r0 = createBackfillBooking({ coachId: cPast, startAt: `${pastDate}T11:00:00`, name:'贈課', phone:'0956000004', amount:0, actorId: uPast });
  assert.equal(db.prepare('SELECT original_amount FROM bookings WHERE id=?').get(r0.id).original_amount, 0);
});
expect('補登：同教練同時段重複 → 409 already_booked', () => {
  let err;
  try { createBackfillBooking({ coachId: cPast, startAt: pastStart, name:'重複', phone:'0956000005', amount:1500, actorId: uPast }); }
  catch (e) { err = e; }
  assert.ok(err); assert.equal(err.code, 'already_booked');
});

// 清理本測試資料
db.exec(`DELETE FROM bookings WHERE coach_id IN (${cPast}, ${cFut}); DELETE FROM coaches WHERE id IN (${cPast}, ${cFut}); DELETE FROM users WHERE id IN (${uPast}, ${uFut}) OR phone LIKE '0956%'`);
console.log('[admin-backfill test] done');
```

（同時刪掉前一個 Step 留下的 `console.log('[admin-backfill test] availability section done');` 那行，避免重複輸出。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/admin-backfill.test.js`
Expected: FAIL —「createBackfillBooking is not a function」/ import 失敗。

- [ ] **Step 3: 實作 `createBackfillBooking`**

在 `src/services/bookingService.js` 的 `createBookingAnon`（約 138 行 `}` 結尾）之後新增：

```js
/** 管理者補登「過去」時段的預約：靜默歷史紀錄。
 *  - 標記已核對（paid_at/paid_by）、記錄金額 amount（original_amount）。
 *  - 不發 LINE/Email、不建 Google 日曆、不套折扣、不檢查容量/重疊。
 *  - 強制 startAt < now（避免用此路徑繞過未來容量限制）。
 *  - 仍受 DB UNIQUE(coach_id, start_at) WHERE confirmed 約束 → 重複回 409 already_booked。 */
export function createBackfillBooking({ coachId, startAt, name, phone, sessionType = '1on1', amount, note = null, actorId }) {
  if (!coachId || !startAt) throw new ApiError(400, 'missing_fields');
  if (sessionType !== '1on1' && sessionType !== '1on2') throw new ApiError(400, 'invalid_session_type');
  if (typeof startAt !== 'string' || !START_AT_RE.test(startAt)) throw new ApiError(400, 'invalid_start_at');
  if (!Number.isInteger(amount) || amount < 0) throw new ApiError(400, 'invalid_amount');
  if (startAt >= nowLocal()) throw new ApiError(400, 'not_past');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });
    const endAt = addMinutes(startAt, 60);
    let bookingId;
    try {
      const info = insertBookingStmt.run(coach.id, user.id, startAt, endAt, note, sessionType);
      bookingId = info.lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'already_booked');
      throw e;
    }
    db.prepare('UPDATE bookings SET paid_at=?, paid_by=?, original_amount=?, discount_amount=NULL WHERE id=?')
      .run(nowLocal(), actorId, amount, bookingId);
    return { id: bookingId, startAt, endAt };
  });
}
```

（`nowLocal`、`tx`、`db` 已於檔首 import；`START_AT_RE`、`addMinutes`、`insertBookingStmt`、`getCoachStmt`、`findOrCreateUserByPhone`、`ApiError` 皆已存在。）

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/admin-backfill.test.js`
Expected: 全部 `✓`（availability 3 + service 5）。

- [ ] **Step 5: Commit**

```bash
git add src/services/bookingService.js tests/admin-backfill.test.js
git commit -m "feat(booking): createBackfillBooking — 靜默已付款補登

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 後端端點（availability backfill 參數 + 補登端點）

**Files:**
- Modify: `src/server.js`（import 區約 40-44；availability 端點 907-914；補登端點新增於 826 之前/之後的 public 區或 admin 區）
- Test: `tests/admin-backfill-api.test.js`（新增）
- Modify: `package.json`（`test` 與 `test:api` 各加一行）

- [ ] **Step 1: 寫失敗測試（端點）**

Create `tests/admin-backfill-api.test.js`：

```js
// 管理者補登端點：availability?backfill=1（admin 限定）+ POST /api/admin/bookings/backfill。
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
const pad = n => String(n).padStart(2,'0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-backfill-api test] start');
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0957%'); DELETE FROM users WHERE email LIKE 'abfa-%' OR phone LIKE '0957%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABFA Coach','abfa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABFA', 1)").run(uid).lastInsertRowid);

const past = new Date(Date.now() - 7*86400000);
const pastDate = fmtDate(past);
addRule({ coachId, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });
const pastStart = `${pastDate}T10:00:00`;

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

// 非管理者（無 token）帶 backfill=1 → 忽略，無 past slot
const avNoAuth = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`);
expect('無 token + backfill=1 → 過去日期空清單', () => {
  assert.equal(avNoAuth.status, 200);
  assert.equal(avNoAuth.data.length, 0);
});

// 管理者帶 backfill=1 → 看到過去 slot（past:true）
const avAdmin = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`, { token });
expect('admin + backfill=1 → 過去 slot past:true', () => {
  assert.equal(avAdmin.status, 200);
  assert.ok(avAdmin.data.some(s => s.start === pastStart && s.past === true));
});

// 補登端點需 admin
const bfNoAuth = await req('POST', '/api/admin/bookings/backfill', { body: { coachId, startAt: pastStart, name:'補登客', phone:'0957000001', sessionType:'1on1', amount:1500 } });
expect('無 token 補登 → 401', () => assert.equal(bfNoAuth.status, 401));

// 未來 startAt → not_past
const futStart = `${fmtDate(new Date(Date.now()+7*86400000))}T10:00:00`;
const bfFut = await req('POST', '/api/admin/bookings/backfill', { token, body: { coachId, startAt: futStart, name:'未來', phone:'0957000002', sessionType:'1on1', amount:1500 } });
expect('未來 startAt 補登 → 400 not_past', () => { assert.equal(bfFut.status, 400); assert.equal(bfFut.data.error, 'not_past'); });

// 負數金額 → invalid_amount
const bfNeg = await req('POST', '/api/admin/bookings/backfill', { token, body: { coachId, startAt: pastStart, name:'x', phone:'0957000003', sessionType:'1on1', amount:-1 } });
expect('負數金額 → 400 invalid_amount', () => { assert.equal(bfNeg.status, 400); assert.equal(bfNeg.data.error, 'invalid_amount'); });

// 成功補登
const bfOk = await req('POST', '/api/admin/bookings/backfill', { token, body: { coachId, startAt: pastStart, name:'補登客', phone:'0957000001', sessionType:'1on1', amount:1500, note:'API 補登' } });
expect('補登成功 201', () => assert.equal(bfOk.status, 201));
const bid = bfOk.data?.id;

// 出現在顧客課表、paid=true
const my = await req('POST', '/api/public/my', { body: { phone: '0957000001', name: '補登客' } });
expect('補登預約出現在課表且 paid=true', () => {
  const item = my.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.ok(item); assert.equal(item.paid, true);
});

db.exec(`DELETE FROM bookings WHERE coach_id = ${coachId}; DELETE FROM coaches WHERE id = ${coachId}; DELETE FROM users WHERE id = ${uid} OR phone LIKE '0957%'`);
console.log('[admin-backfill-api test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

先啟動測試伺服器（背景）：
```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js &
```
Run: `BASE=http://localhost:3100 node tests/admin-backfill-api.test.js`
Expected: FAIL —「admin + backfill=1 → 過去 slot past:true」與補登相關條目失敗（端點尚未實作，補登端點回 404）。

- [ ] **Step 3a: import `createBackfillBooking`**

`src/server.js` 約 44 行的 bookingService import 區塊內（與 `createRecurringBookings as svcCreateRecurring,` 同一個 `} from './services/bookingService.js';` 區塊）新增一行：

```js
  createBackfillBooking as svcCreateBackfillBooking,
```

- [ ] **Step 3b: availability 端點加 backfill 參數**

把 `src/server.js:907-914` 的 availability handler 改為：

```js
app.get('/api/coaches/:id/availability', asyncHandler(async (req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach || !coach.is_active) return res.status(404).json({ error: 'coach_not_found' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  // 管理者可帶 backfill=1 看過去時段（補登用）；非管理者一律忽略。
  const requester = userFromToken(getTokenFromReq(req));
  const includePast = req.query.backfill === '1' && !!requester?.is_admin;
  const externalBusy = await getExternalBusySafe(from, to);
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to, externalBusy, includePast }));
}));
```

（`userFromToken` 已 import；`getTokenFromReq` 為 server.js 內既有區域函式。）

- [ ] **Step 3c: 新增補登端點**

在 `src/server.js` 的 `app.delete('/api/bookings/:id', ...)`（約 917 行）之前，新增：

```js
// 管理者補登過去預約（解鎖「上週」後的回填）。靜默、預設已核對、可改價。
app.post('/api/admin/bookings/backfill', requireAdmin, asyncHandler((req, res) => {
  const { coachId, startAt, name, phone, sessionType, amount, note } = req.body || {};
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid_phone', detail: '電話需為 8-15 碼數字' });
  const r = svcCreateBackfillBooking({
    coachId: Number(coachId),
    startAt,
    name,
    phone,
    sessionType: sessionType || '1on1',
    amount: Number(amount),
    note: note || null,
    actorId: req.user.id,
  });
  res.status(201).json(r);
}));
```

（`isValidPhone`、`requireAdmin`、`asyncHandler` 皆已存在。）

- [ ] **Step 4: 重啟伺服器、跑測試確認通過**

```bash
kill %1 2>/dev/null; LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js &
```
Run: `BASE=http://localhost:3100 node tests/admin-backfill-api.test.js`
Expected: 全部 `✓`。

- [ ] **Step 5: 掛進 package.json 測試腳本**

`package.json`：
- `"test"` 字串結尾（`... && node tests/booking-group-ops.test.js`）後追加 ` && node tests/admin-backfill.test.js`。
- `"test:api"` 字串結尾（`... && node tests/recurring-booking-api.test.js`）後追加 ` && node tests/admin-backfill-api.test.js`。

- [ ] **Step 6: Commit**

```bash
git add src/server.js tests/admin-backfill-api.test.js package.json
git commit -m "feat(api): availability backfill 參數 + POST /api/admin/bookings/backfill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 前端 — 補登彈窗 markup（`coaches.html`）

**Files:**
- Modify: `public/coaches.html`（modal 內：83-172）

- [ ] **Step 1: 在 modal 內容區頂部加補登橫幅**

把 `public/coaches.html:88` 的 `<div class="p-4" style="overflow-y:auto;...">` 之後、`<div class="card bg-slate-50 mb-4 text-sm">`（89 行）之前，插入：

```html
      <div id="modal-backfill-banner" class="hidden mb-3 rounded-lg px-3 py-2 text-xs" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;">
        補登模式：此為已發生的課程，將靜默記錄、不發通知、預設標記已付款。
      </div>
```

- [ ] **Step 2: 折扣列與 Email 列加 wrapper id（供補登模式隱藏）**

`public/coaches.html:150` 的 Email `<label class="block mb-3">` 改為帶 id：
```html
      <label id="modal-email-row" class="block mb-3">
```

`public/coaches.html:160` 的折扣 `<div class="mb-3">` 改為帶 id：
```html
      <div id="modal-discount-row" class="mb-3">
```

- [ ] **Step 3: 加金額列與備註列（補登限定）**

在 `public/coaches.html` 折扣列 `</div>`（166 行）之後、`<span id="modal-general-err" ...>`（168 行）之前，插入：

```html
      <label id="modal-backfill-amount-row" class="block mb-3 hidden">
        <span class="text-sm font-medium text-slate-700">金額（可修改，0 表示贈課）</span>
        <input id="modal-backfill-amount" type="number" min="0" step="1" inputmode="numeric" class="mt-1 w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" placeholder="例：1500">
      </label>
      <label id="modal-backfill-note-row" class="block mb-3 hidden">
        <span class="text-sm font-medium text-slate-700">備註（選填）</span>
        <input id="modal-backfill-note" type="text" class="mt-1 w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" placeholder="例：6/3 已完成課程，補登紀錄">
      </label>
```

- [ ] **Step 4: 視覺檢查（手動）**

不需自動測試。確認 markup 正確（無未閉合標籤）。後續 JS 任務會驅動顯示/隱藏。

- [ ] **Step 5: Commit**

```bash
git add public/coaches.html
git commit -m "feat(ui): 預約彈窗加補登橫幅/金額/備註欄與折扣Email wrapper id

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 前端 — 補登邏輯（`coaches.js` + `style.css`）

**Files:**
- Modify: `public/coaches.js`（13、290-318、331-364、439-455、532-604、791-900）
- Modify: `public/style.css`（append `.timeslot.slot-past`）

- [ ] **Step 1: 加 `isAdmin` 模組常數**

`public/coaches.js:13` 的 `let weekOffset = 0;` 之後新增一行：
```js
const isAdmin = !!(getUser()?.is_admin);
```

- [ ] **Step 2: 解鎖「上週」按鈕（管理者）**

把 `public/coaches.js:297-299` 的 prev-week handler：
```js
  $('prev-week').addEventListener('click', () => {
    if (weekOffset > 0) { weekOffset--; updatePrevDisabled(); loadSlots(); }
  });
```
改為：
```js
  $('prev-week').addEventListener('click', () => {
    if (isAdmin || weekOffset > 0) { weekOffset--; updatePrevDisabled(); loadSlots(); }
  });
```

把 `public/coaches.js:306-309` 的 `updatePrevDisabled`：
```js
function updatePrevDisabled() {
  const btn = document.getElementById('prev-week');
  if (btn) btn.disabled = weekOffset <= 0;
}
```
改為：
```js
function updatePrevDisabled() {
  const btn = document.getElementById('prev-week');
  if (btn) btn.disabled = !isAdmin && weekOffset <= 0;
}
```

- [ ] **Step 3: `loadSlots` 帶 backfill（管理者）**

把 `public/coaches.js:451` 的：
```js
  const slots = await api(`/api/coaches/${currentCoach.id}/availability?from=${from}&to=${to}`);
```
改為：
```js
  const qs = `from=${from}&to=${to}` + (isAdmin ? '&backfill=1' : '');
  const slots = await api(`/api/coaches/${currentCoach.id}/availability?${qs}`);
```

- [ ] **Step 4: `renderTimegrid` 補登標籤 + 傳遞 past**

把 `public/coaches.js:353-357`：
```js
    el.dataset.slot = s.start;
    el.dataset.remain = s.remain;
    el.innerHTML = `<div class="t-main">${escapeHtml(fmtTime(s.start))}</div><div class="t-sub">60 分鐘${s.remain === 1 ? ' · 剩 1 名額' : ''}</div>`;
    // 點擊時段卡 → 直接開 modal（不停留 sel 狀態，modal 開啟即有 UI 回饋）
    const trigger = () => openBookingModal(currentCoach, { start: s.start, remain: s.remain });
```
改為：
```js
    el.dataset.slot = s.start;
    el.dataset.remain = s.remain;
    if (s.past) el.classList.add('slot-past');
    const sub = s.past ? '補登 · 60 分鐘' : `60 分鐘${s.remain === 1 ? ' · 剩 1 名額' : ''}`;
    el.innerHTML = `<div class="t-main">${escapeHtml(fmtTime(s.start))}</div><div class="t-sub">${sub}</div>`;
    // 點擊時段卡 → 直接開 modal（不停留 sel 狀態，modal 開啟即有 UI 回饋）
    const trigger = () => openBookingModal(currentCoach, { start: s.start, remain: s.remain, past: !!s.past });
```

- [ ] **Step 5: 加 `modalBackfill` 狀態**

`public/coaches.js:463` 的 `let modalSlot = null;` 之後新增：
```js
let modalBackfill = false;
```

- [ ] **Step 6: `openBookingModal` 補登變體**

把 `public/coaches.js:578-585` 的 1對2 名額守門：
```js
  // 名額守門：剩 1 名額的時段不可選 1對2
  const btn1on2 = document.querySelector('#modal-session-type .session-type-btn[data-type="1on2"]');
  if (btn1on2) {
    const disabled = slot.remain < 2;
    btn1on2.disabled = disabled;
    btn1on2.classList.toggle('opacity-40', disabled);
    btn1on2.title = disabled ? '此時段僅剩 1 個名額' : '';
  }
```
改為（補登模式不受名額限制）：
```js
  // 補登模式：依時段 past 旗標切換（不受名額/折扣限制）
  modalBackfill = !!slot.past;
  // 名額守門：剩 1 名額的時段不可選 1對2（補登模式略過）
  const btn1on2 = document.querySelector('#modal-session-type .session-type-btn[data-type="1on2"]');
  if (btn1on2) {
    const disabled = !modalBackfill && slot.remain < 2;
    btn1on2.disabled = disabled;
    btn1on2.classList.toggle('opacity-40', disabled);
    btn1on2.title = disabled ? '此時段僅剩 1 個名額' : '';
  }
```

把 `public/coaches.js:591-600`（循環列顯示 + 重置）：
```js
  // 循環預約（員工限定）：登入教練/管理者才顯示；每次開窗重置（後端 requireCoach 強制）
  const u = getUser();
  const isStaff = !!(u && (u.role === 'coach' || u.is_admin));
  $('recurring-row').classList.toggle('hidden', !isStaff);
  $('recurring-enabled').checked = false;
  $('recurring-fields').classList.add('hidden');
  $('recurring-preview-result').classList.add('hidden');
  $('recurring-preview-result').innerHTML = '';
  $('recurring-markpaid').checked = false;
  recurringState = { previewed: false, okCount: 0 };
```
改為：
```js
  // 循環預約（員工限定）：登入教練/管理者才顯示；補登模式一律隱藏。每次開窗重置。
  const u = getUser();
  const isStaff = !!(u && (u.role === 'coach' || u.is_admin));
  $('recurring-row').classList.toggle('hidden', !isStaff || modalBackfill);
  $('recurring-enabled').checked = false;
  $('recurring-fields').classList.add('hidden');
  $('recurring-preview-result').classList.add('hidden');
  $('recurring-preview-result').innerHTML = '';
  $('recurring-markpaid').checked = false;
  recurringState = { previewed: false, okCount: 0 };

  // 補登模式 UI：橫幅 + 金額/備註欄；隱藏折扣與 Email；改標題與按鈕文字。
  $('modal-backfill-banner').classList.toggle('hidden', !modalBackfill);
  $('modal-backfill-amount-row').classList.toggle('hidden', !modalBackfill);
  $('modal-backfill-note-row').classList.toggle('hidden', !modalBackfill);
  $('modal-discount-row').classList.toggle('hidden', modalBackfill);
  $('modal-email-row').classList.toggle('hidden', modalBackfill);
  $('modal-title').textContent = modalBackfill ? '補登過去預約' : '填寫預約資訊';
  $('modal-submit-btn').textContent = modalBackfill ? '確認補登' : '確認預約';
  if (modalBackfill) {
    $('modal-backfill-note').value = '';
    $('modal-backfill-amount').value = priceByType[modalSessionType] != null ? priceByType[modalSessionType] : '';
  }
```

- [ ] **Step 7: 切換型態時更新補登金額**

把 `public/coaches.js:540-543`（`setSessionType` 內）：
```js
  modalSessionType = type;
  refreshSessionTypeButtons();
  refreshModalPrice();
  invalidateRecurringPreview(); // 型態影響名額判定（1對2 佔 2）→ 循環預覽需重跑
```
改為：
```js
  modalSessionType = type;
  refreshSessionTypeButtons();
  refreshModalPrice();
  // 補登模式：金額欄預設帶入該型態標準單價（切換即更新）
  if (modalBackfill) {
    $('modal-backfill-amount').value = priceByType[modalSessionType] != null ? priceByType[modalSessionType] : '';
  }
  invalidateRecurringPreview(); // 型態影響名額判定（1對2 佔 2）→ 循環預覽需重跑
```

並把 `public/coaches.js:535` 的 1對2 守門條件（`setSessionType` 開頭）：
```js
  if (type === '1on2' && modalSlot && modalSlot.remain < 2) {
```
改為：
```js
  if (type === '1on2' && !modalBackfill && modalSlot && modalSlot.remain < 2) {
```

- [ ] **Step 8: `closeBookingModal` 重置 modalBackfill**

把 `public/coaches.js:704-709`：
```js
function closeBookingModal() {
  $('booking-modal').classList.add('hidden');
  modalCoach = null;
  modalSlot = null;
  modalAppliedDiscount = null;
}
```
改為：
```js
function closeBookingModal() {
  $('booking-modal').classList.add('hidden');
  modalCoach = null;
  modalSlot = null;
  modalAppliedDiscount = null;
  modalBackfill = false;
}
```

- [ ] **Step 9: 送出處理 — 補登分支**

在 `public/coaches.js` 送出 handler 內，於 `// ── 循環模式：走員工端點（需先預覽）──` 區塊（825 行 `if (recurringEnabled()) {`）之前插入補登分支：

```js
  // ── 補登模式：走管理者端點（靜默、預設已付款）──
  if (modalBackfill) {
    const amount = Number($('modal-backfill-amount').value);
    if (!Number.isInteger(amount) || amount < 0) {
      $('modal-general-err').textContent = '金額需為 0 或正整數';
      btn.disabled = false; btn.textContent = btnText;
      return;
    }
    try {
      const body = { coachId: modalCoach.id, startAt: modalSlot.start, name: nameVal, phone: phoneNormalized, sessionType: modalSessionType, amount };
      const noteVal = $('modal-backfill-note').value.trim();
      if (noteVal) body.note = noteVal;
      await api('/api/admin/bookings/backfill', { method: 'POST', body });
      const bookedCoach = modalCoach;
      closeBookingModal();
      toast('補登成功', 'success');
      slotCacheByCoach.delete(bookedCoach.id);
      if (currentCoach && !views.detail.classList.contains('hidden')) loadSlots();
    } catch (e) {
      btn.disabled = false; btn.textContent = btnText;
      const errCode = e.data?.error;
      if (errCode === 'already_booked') $('modal-general-err').textContent = '此教練該時段已有一筆預約紀錄。';
      else if (errCode === 'not_past') $('modal-general-err').textContent = '只能補登過去的時段。';
      else if (errCode === 'invalid_amount') $('modal-general-err').textContent = '金額需為 0 或正整數';
      else if (errCode === 'invalid_phone') $('modal-phone-err').textContent = e.data?.detail || '電話格式不正確';
      else if (errCode === 'missing_name') $('modal-name-err').textContent = '請輸入姓名';
      else if (errCode === 'phone_unavailable') $('modal-phone-err').textContent = '此電話號碼為員工帳號，無法用於補登。';
      else $('modal-general-err').textContent = `補登失敗：${e.message}`;
    }
    return;
  }

```

（`btnText` 已於同 handler 上方 `const btnText = btn.textContent;` 取得；`toast` 已 import。）

- [ ] **Step 10: `.slot-past` 樣式**

在 `public/style.css` 結尾追加：
```css
/* 補登（過去）時段卡：淡琥珀虛線框，與一般可預約時段區別 */
.timeslot.slot-past { border-style: dashed; border-color: #fcd34d; background: #fffdf5; }
.timeslot.slot-past .t-sub { color: #b45309; }
```

- [ ] **Step 11: 手動煙霧測試（見下方 Smoke Test 區）**

- [ ] **Step 12: Commit**

```bash
git add public/coaches.js public/style.css
git commit -m "feat(ui): 管理者解鎖上週並對過去時段補登（含可改價彈窗）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 全測試回歸 + 手動煙霧 + 草稿 PR

- [ ] **Step 1: 跑單元測試全集**

Run: `npm test`
Expected: 全綠（含新 `admin-backfill.test.js`）。
（注意：`npm test` 會清掉 `data/app.db` demo 資料，測試後若要預覽需 `npm run seed`。）

- [ ] **Step 2: 跑 API 測試全集**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js &
sleep 1
BASE=http://localhost:3100 npm run test:api
kill %1 2>/dev/null
```
Expected: 全綠（含新 `admin-backfill-api.test.js`）。

- [ ] **Step 3: 手動煙霧（Smoke Test）**

```bash
npm run seed   # 還原 demo 資料
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js &
```
瀏覽器（管理者登入 admin@chinup.local / admin1234，於 `/coaches.html`）：
1. 進入任一教練詳細頁 → 「上週」按鈕**可點**（管理者）。
2. 連點「上週」回到過去某週 → 過去日期出現時段卡、標示「補登」、虛線框。
3. 點過去時段 → 彈窗標題「補登過去預約」、顯示琥珀橫幅、金額欄帶入單價、無折扣/Email 欄、無循環選項。
4. 切 1對2 → 金額更新為 1對2 單價；改金額為 0 可送出。
5. 填姓名+電話 → 「確認補登」→ toast「補登成功」，時段卡消失（已建單）。
6. 用該電話到 `/my-schedule` 查詢 → 出現該預約、狀態為已付款/已核對。
7. 開無痕視窗（未登入，一般使用者）進同教練頁 → 「上週」**仍 disabled**，看不到過去時段。

收尾：`kill %1`。

- [ ] **Step 4: push + 開草稿 PR**

```bash
git push -u origin feat/admin-backfill-booking
```
用 `gh`／API 開 **draft** PR：標題「管理者補登過去預約（解鎖上週按鈕）」，body 摘要四項決策 + 測試結果，結尾：
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 5: 等業主人工煙霧驗收後再合併**（依專案慣例 manual-smoke gate；合併前務必先 `git push` 任何 review 修正 commit）。

---

## Self-Review（對照 spec）

- **解鎖上週（管理者）/一般使用者不變**：Task 5 Step 2（`updatePrevDisabled`/prev handler 用 `isAdmin`）+ Smoke Step 1/7。✓
- **includePast 可預約查詢（管理者限定）**：Task 1（service）+ Task 3 Step 3b（端點 `backfill=1` 且 `is_admin`）+ api 測試「無 token → 空」。✓
- **過去時段呈現（補登標籤、不顯示剩餘、1對2 不停用）**：Task 5 Step 4/6。✓
- **補登彈窗：姓名/電話/型態/可改價/備註，隱藏折扣+循環**：Task 4 + Task 5 Step 6/7。✓
- **純記錄不發通知/不建日曆/不套折扣**：Task 2（`createBackfillBooking` 不呼叫 notify/gcal/discount）；reconcile 只處理 `start_at >= now` → 過去不建事件（已驗證）。✓
- **預設已核對**：Task 2（`paid_at`/`paid_by`）+ api 測試 paid=true。✓
- **完全不檢查容量/重疊**：Task 2（不呼叫 `assertBookableTx`）；唯 DB UNIQUE(coach,start) 仍擋精確重複 → 回 409 already_booked（已於 spec 範圍外但合理保留，測試涵蓋）。✓
- **可改價（含 0）**：Task 4 金額欄 + Task 2 `amount` 驗證 + 測試 amount=0。✓
- **安全：startAt<now 伺服器強制、requireAdmin、前端旗標僅 UI**：Task 2（not_past）+ Task 3（requireAdmin / 端點忽略非 admin backfill）+ api 測試 401/not_past。✓
- **零回歸**：Task 1 Step 5 跑既有 availability/capacity/booking-flow；`includePast=false` 為預設、未來路徑不變。✓

**Placeholder scan**：無 TBD/TODO；每個 code step 均含完整程式碼。
**Type/名稱一致性**：`includePast`、`createBackfillBooking`、`svcCreateBackfillBooking`、`modalBackfill`、`past`、`amount`、錯誤碼（`not_past`/`invalid_amount`/`already_booked`/`phone_unavailable`）在 service/endpoint/前端/測試間一致。
