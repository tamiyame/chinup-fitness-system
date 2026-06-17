# 管理者於教練後台代選教練檢視／編輯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `is_admin` 的教練在「教練後台」用標題旁下拉選任一已啟用教練，下方三分頁帶出該教練資料並可直接修改（含 coach-flavored 代取消）。

**Architecture:** 後端新增單一 `resolveCoach(req,res)`，當 `req.user.is_admin` 且帶 `coachId`（GET/DELETE 走 query、POST/PATCH 走 body）時改解析該教練，否則沿用 self（`loadCoachForUser`）；service 層零改動（本就吃明確 coachId）。預約取消在既有 `cancelBooking` 加 `adminOnBehalf` 旗標跳過擁有權檢查並強制 coach-flavored 通知。前端 coach.js 先抓 `/api/auth/me` 決定是否顯示下拉，並把 `coachQuery()`/`coachId` 串接所有 `/api/coach/me*` 與取消呼叫。

**Tech Stack:** Node.js ESM、Express 4、node:sqlite；前端原生 ES module（public/app.js 的 `api()`）；測試為純 node script（`node tests/x.test.js`，api 測試需先啟動帶 mock 的 server）。

**Spec:** `docs/superpowers/specs/2026-06-17-admin-coach-console-switcher-design.md`

---

## File Structure

- **Modify** `src/server.js`
  - 新增 `resolveCoach(req,res)`（放在 `loadCoachForUser` 之後，約 696 行後）。
  - 把 11 支 `/api/coach/me/*` handler 內的 `loadCoachForUser(req, res)` 換成 `resolveCoach(req, res)`（700–791）。
  - 改 `DELETE /api/bookings/:id`（922–939）支援 admin 代理（coach-flavored）。
- **Modify** `src/services/bookingService.js`
  - `cancelBooking` 加 `adminOnBehalf` 參數（140–182）。
- **Modify** `public/coach.html`
  - 標題與新下拉 `#coach-picker` 包進同一 flex 列（205–206 間）。
- **Modify** `public/coach.js`
  - 模組狀態＋`coachQuery()`/`withCoach()`/`needsCoachSelection()`/`refreshPendingBanner()`/`setupCoachPicker()`/`onCoachChange()`；改 `init()`、三個 render 與所有寫入呼叫帶 coachId。
- **Create** `tests/admin-coach-switch-api.test.js`（Task 1 的 API 測試）。
- **Create** `tests/admin-coach-cancel-api.test.js`（Task 2 的 API 測試）。
- **Modify** `package.json`
  - 把兩個新 api 測試加進 `test:api` script。

**啟動 api 測試用 server（每次跑 api 測試前）：**
```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
# 等 1-2 秒讓它 listen 於 :3000，跑完測試後 kill 該背景程序
```

---

## Task 1: 後端 `resolveCoach` — admin 可代選教練讀寫 11 支 self 端點

**Files:**
- Modify: `src/server.js:689-791`
- Create: `tests/admin-coach-switch-api.test.js`
- Modify: `package.json:13`

- [ ] **Step 1: 寫失敗測試 `tests/admin-coach-switch-api.test.js`**

```js
// 管理者代選教練讀寫 /api/coach/me*：admin 帶 coachId 操作他人教練；
// 非 admin 帶 coachId 被忽略（落回自己）；壞 coachId → 404。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[admin-coach-switch-api test] start');
// FK-safe 清理（notifications → bookings → coaches → users）
db.exec(`
  DELETE FROM coach_availability_rules WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'acsw-%'));
  DELETE FROM coach_availability_exceptions WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'acsw-%'));
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'acsw-%');
  DELETE FROM users WHERE email LIKE 'acsw-%';
`);
// 目標教練 C（有 1 條班表規則）
const cUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ACSW Target','acsw-c@x.com','coach')").run().lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACSW-C', 1)").run(cUid).lastInsertRowid);
db.prepare("INSERT INTO coach_availability_rules (coach_id, day_of_week, start_time, end_time, effective_from) VALUES (?,1,'09:00','10:00','2000-01-01')").run(cId);
// 非管理者教練 D（有自己的教練檔案、0 條規則）
const dUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('ACSW NonAdmin','acsw-d@x.com','coach',0,?)").run(hashPassword('coachpass123')).lastInsertRowid);
const dId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACSW-D', 1)").run(dUid).lastInsertRowid);

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));
const dlogin = await req('POST', '/api/auth/login', { body: { email: 'acsw-d@x.com', password: 'coachpass123' } });
const dtoken = dlogin.data?.token;
expect('non-admin coach login ok', () => assert.ok(dtoken));

// admin 帶 coachId 讀 C 的 record / rules
const meC = await req('GET', `/api/coach/me?coachId=${cId}`, { token });
expect('admin coachId → 讀到 C 的 record', () => { assert.equal(meC.status, 200); assert.equal(meC.data.id, cId); });
const rulesC = await req('GET', `/api/coach/me/rules?coachId=${cId}`, { token });
expect('admin coachId → 讀到 C 的 1 條規則', () => { assert.equal(rulesC.status, 200); assert.equal(rulesC.data.length, 1); });

// admin 帶 coachId 寫入 C：新增規則 + PATCH profile
const addRuleC = await req('POST', '/api/coach/me/rules', { token, body: { coachId: cId, day_of_week: 2, start_time: '14:00', end_time: '15:00' } });
expect('admin coachId → 新增 C 的規則 201', () => assert.equal(addRuleC.status, 201));
const rulesC2 = await req('GET', `/api/coach/me/rules?coachId=${cId}`, { token });
expect('C 現在有 2 條規則（寫入落在 C）', () => assert.equal(rulesC2.data.length, 2));
const patchC = await req('PATCH', '/api/coach/me/profile', { token, body: { coachId: cId, display_name: 'ACSW-C2', specialty: '改過', bio: null } });
expect('admin coachId → PATCH C 的 profile 200', () => { assert.equal(patchC.status, 200); assert.equal(patchC.data.display_name, 'ACSW-C2'); });

// 非管理者 D 帶 coachId=C → 被忽略，只拿到自己（D 的 0 條規則，非 C 的）
const dReadC = await req('GET', `/api/coach/me/rules?coachId=${cId}`, { token: dtoken });
expect('非管理者帶 coachId 被忽略 → 拿到自己(0 條)', () => { assert.equal(dReadC.status, 200); assert.equal(dReadC.data.length, 0); });
const dMe = await req('GET', `/api/coach/me?coachId=${cId}`, { token: dtoken });
expect('非管理者帶 coachId → 仍是自己的 record', () => assert.equal(dMe.data.id, dId));

// 壞 coachId（admin）→ 404 coach_not_found
const bad = await req('GET', '/api/coach/me/rules?coachId=99999999', { token });
expect('admin 壞 coachId → 404 coach_not_found', () => { assert.equal(bad.status, 404); assert.equal(bad.data.error, 'coach_not_found'); });

db.exec(`
  DELETE FROM coach_availability_rules WHERE coach_id IN (${cId}, ${dId});
  DELETE FROM coach_availability_exceptions WHERE coach_id IN (${cId}, ${dId});
  DELETE FROM coaches WHERE id IN (${cId}, ${dId});
  DELETE FROM users WHERE id IN (${cUid}, ${dUid});
`);
console.log('[admin-coach-switch-api test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
SRV=$!; sleep 2
node tests/admin-coach-switch-api.test.js
kill $SRV
```
Expected: FAIL（`admin coachId → 讀到 C 的 record` 等：目前 `/api/coach/me?coachId=` 會回 admin 自己的 record 或 404，且寫入落在 admin 自己；非 admin 也尚無差異邏輯）。

- [ ] **Step 3: 新增 `resolveCoach`（src/server.js，緊接 `loadCoachForUser` 之後，約 696 行）**

```js
// admin 可帶 coachId（GET/DELETE 走 query、POST/PATCH 走 body）代選任一教練；
// 非 admin 一律忽略 coachId、落回自己的教練檔案。service 層仍以 coach_id 設防（縱深防護）。
function resolveCoach(req, res) {
  const wanted = req.query.coachId ?? req.body?.coachId;
  if (wanted != null && wanted !== '' && req.user.is_admin) {
    const c = svcGetCoach(Number(wanted));
    if (!c) { res.status(404).json({ error: 'coach_not_found' }); return null; }
    return c;
  }
  return loadCoachForUser(req, res);
}
```

- [ ] **Step 4: 把 11 支 handler 的 `loadCoachForUser(req, res)` 換成 `resolveCoach(req, res)`**

在 `src/server.js` 將以下各行（700–791）的 `const coach = loadCoachForUser(req, res);` 改為 `const coach = resolveCoach(req, res);`：`GET /api/coach/me`、`PATCH /api/coach/me/profile`、`GET /api/coach/me/rules`、`POST /api/coach/me/rules`、`DELETE /api/coach/me/rules/:id`、`GET /api/coach/me/exceptions`、`POST /api/coach/me/exceptions`、`DELETE /api/coach/me/exceptions/:id`、`GET /api/coach/me/bookings`、`GET /api/coach/me/availability-preview`、`POST /api/coach/me/avatar`。

> 用 replace_all 對 `const coach = loadCoachForUser(req, res);` → `const coach = resolveCoach(req, res);`。注意 `loadCoachForUser` 的「定義」與 `resolveCoach` 內部對它的「呼叫」**不要**被改名（它們是 `function loadCoachForUser` 與 `return loadCoachForUser(req, res);`，字串不同，replace_all 只會命中 `const coach = ...` 那 11 處）。

- [ ] **Step 5: 跑測試確認通過**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
SRV=$!; sleep 2
node tests/admin-coach-switch-api.test.js
kill $SRV
```
Expected: 全部 ✓，輸出 `[admin-coach-switch-api test] done`，無 ✗。

- [ ] **Step 6: 把新測試加進 `package.json` 的 `test:api`**

在 `package.json:13` 的 `test:api` 字串尾端（`admin-backfill-api.test.js` 之後）加上：
` && node tests/admin-coach-switch-api.test.js`

- [ ] **Step 7: Commit**

```bash
git add src/server.js tests/admin-coach-switch-api.test.js package.json
git commit -m "feat(coach): admin 可帶 coachId 代選教練讀寫 /api/coach/me*（resolveCoach）"
```

---

## Task 2: 後端 admin 代取消預約（coach-flavored）

**Files:**
- Modify: `src/services/bookingService.js:140-182`
- Modify: `src/server.js:922-939`
- Create: `tests/admin-coach-cancel-api.test.js`
- Modify: `package.json:13`

- [ ] **Step 1: 寫失敗測試 `tests/admin-coach-cancel-api.test.js`**

```js
// 管理者代教練取消未來預約 = coach-flavored：會員收到 booking_cancelled_by_coach、需 reason。
// 非管理者(非擁有教練)帶 coachId 取消 → 403；coachId 與 booking 不符 → 403；缺 reason → 400。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
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

console.log('[admin-coach-cancel-api test] start');
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'accx-%');
  DELETE FROM bookings WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'accx-%'));
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'accx-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'accx-%');
  DELETE FROM users WHERE email LIKE 'accx-%';
`);
// 目標教練 C、會員 M、未來預約 b
const cUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ACCX Coach','accx-c@x.com','coach')").run().lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACCX-C', 1)").run(cUid).lastInsertRowid);
const mUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ACCX Member','accx-m@x.com','user')").run().lastInsertRowid);
// 另一位非管理者教練 D（用來測 403）
const dUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('ACCX Other','accx-d@x.com','coach',0,?)").run(hashPassword('coachpass123')).lastInsertRowid);
db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACCX-D', 1)").run(dUid);

const future = new Date(Date.now() + 3*86400000);
const startAt = `${fmtDate(future)}T10:00:00`;
const endAt = `${fmtDate(future)}T11:00:00`;
function makeBooking() {
  return Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type) VALUES (?,?,?,?,'confirmed','1on1')")
    .run(cId, mUid, startAt, endAt).lastInsertRowid);
}

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));
const dlogin = await req('POST', '/api/auth/login', { body: { email: 'accx-d@x.com', password: 'coachpass123' } });
const dtoken = dlogin.data?.token;

// 缺 reason → 400
const b1 = makeBooking();
const noReason = await req('DELETE', `/api/bookings/${b1}?coachId=${cId}`, { token, body: {} });
expect('admin 代取消缺 reason → 400 missing_reason', () => { assert.equal(noReason.status, 400); assert.equal(noReason.data.error, 'missing_reason'); });

// admin 帶相符 coachId + reason → 200，會員收到 booking_cancelled_by_coach
const b2 = makeBooking();
const ok = await req('DELETE', `/api/bookings/${b2}?coachId=${cId}`, { token, body: { reason: '教練臨時有事' } });
expect('admin 代取消 → 200', () => assert.equal(ok.status, 200));
expect('預約已取消', () => { const row = db.prepare('SELECT status, cancel_reason FROM bookings WHERE id=?').get(b2); assert.equal(row.status, 'cancelled'); assert.equal(row.cancel_reason, '教練臨時有事'); });
expect('會員收到 booking_cancelled_by_coach', () => {
  const n = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_coach'").get(mUid);
  assert.ok(n.c >= 1);
});

// coachId 與 booking.coach_id 不符（admin）→ 不視為代理 → 403
const b3 = makeBooking();
const mismatch = await req('DELETE', `/api/bookings/${b3}?coachId=999999`, { token, body: { reason: 'x' } });
expect('admin coachId 不符 → 403 forbidden', () => assert.equal(mismatch.status, 403));

// 非管理者(非擁有教練 D)帶 coachId=C 取消 → 403
const b4 = makeBooking();
const dCancel = await req('DELETE', `/api/bookings/${b4}?coachId=${cId}`, { token: dtoken, body: { reason: 'x' } });
expect('非管理者非擁有者代取消 → 403 forbidden', () => assert.equal(dCancel.status, 403));

db.exec(`
  DELETE FROM notifications WHERE user_id IN (${mUid}, ${cUid}, ${dUid});
  DELETE FROM bookings WHERE coach_id = ${cId};
  DELETE FROM coaches WHERE user_id IN (${cUid}, ${dUid});
  DELETE FROM users WHERE email LIKE 'accx-%';
`);
console.log('[admin-coach-cancel-api test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
SRV=$!; sleep 2
node tests/admin-coach-cancel-api.test.js
kill $SRV
```
Expected: FAIL（admin 非擁有教練 → 目前 `actorIsCoach=false` → 走會員分支 → 403，所以「admin 代取消 → 200」會失敗）。

- [ ] **Step 3: `cancelBooking` 加 `adminOnBehalf` 參數（src/services/bookingService.js:140-182）**

把整個 `cancelBooking` 換成：

```js
export function cancelBooking({ bookingId, actorUserId, isCoach = false, reason = null, adminOnBehalf = false }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');

    const coach = getCoachStmt.get(b.coach_id);

    if (isCoach) {
      if (!coach) throw new ApiError(404, 'coach_not_found');
      // adminOnBehalf：管理者代理該教練取消，跳過「擁有權」檢查（route 已驗證 is_admin + coachId 相符）
      if (!adminOnBehalf && coach.user_id !== actorUserId) throw new ApiError(403, 'forbidden');
      if (!reason || !reason.trim()) throw new ApiError(400, 'missing_reason');
    } else {
      if (b.member_id !== actorUserId) throw new ApiError(403, 'forbidden');
    }

    cancelBookingStmt.run(nowLocal(), actorUserId, reason, bookingId);
    releaseRedemption({ kind: 'booking', refId: bookingId });

    // Phase 3C: notify the OTHER party (the one who didn't cancel)
    const memberRow = getUserNameStmt.get(b.member_id);
    if (coach && memberRow) {
      const startFmt = fmtDateForLine(b.start_at);
      // adminOnBehalf 視為教練取消：通知會員「教練取消」
      const isCoachCancel = adminOnBehalf || actorUserId === coach.user_id;
      if (isCoachCancel) {
        notify({
          userId: b.member_id,
          sessionId: null,
          type: 'booking_cancelled_by_coach',
          vars: { coach_display_name: coach.display_name, start_at: startFmt },
        });
      } else {
        notify({
          userId: coach.user_id,
          sessionId: null,
          type: 'booking_cancelled_by_member',
          vars: { member_name: memberRow.name, start_at: startFmt },
        });
      }
    }

    return { ok: true };
  });
}
```

- [ ] **Step 4: `DELETE /api/bookings/:id` 支援 admin 代理（src/server.js:922-939）**

把整個 handler 換成：

```js
app.delete('/api/bookings/:id', requireUser, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'booking_not_found' });

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(booking.coach_id);
  const ownerIsCoach = coach && coach.user_id === req.user.id;
  // 管理者代理：is_admin + 帶的 coachId 與本筆預約的教練相符（且自己不是該教練）
  const wantedCoachId = req.query.coachId ?? req.body?.coachId;
  const adminOnBehalf = !!req.user.is_admin && !ownerIsCoach
    && wantedCoachId != null && wantedCoachId !== ''
    && Number(wantedCoachId) === booking.coach_id;
  const actorIsCoach = ownerIsCoach || adminOnBehalf;
  const { reason } = req.body || {};

  svcCancelBooking({
    bookingId: id,
    actorUserId: req.user.id,
    isCoach: actorIsCoach,
    reason: actorIsCoach ? (reason || null) : null,
    adminOnBehalf,
  });
  syncBookingCancel(id); // commit 後副作用、不 await（失敗交 reconcile 兜底）
  res.json({ ok: true });
}));
```

- [ ] **Step 5: 跑測試確認通過**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
SRV=$!; sleep 2
node tests/admin-coach-cancel-api.test.js
kill $SRV
```
Expected: 全部 ✓，輸出 `[admin-coach-cancel-api test] done`，無 ✗。

- [ ] **Step 6: 回歸既有取消測試（確保教練本人取消不變）**

```bash
node tests/booking-flow.test.js
```
Expected: 既有教練取消相關測試仍 PASS（`cancelBooking` 新增參數有預設值、原路徑不變）。

- [ ] **Step 7: 把新測試加進 `package.json` 的 `test:api`**

在 `test:api` 字串尾端加上：
` && node tests/admin-coach-cancel-api.test.js`

- [ ] **Step 8: Commit**

```bash
git add src/services/bookingService.js src/server.js tests/admin-coach-cancel-api.test.js package.json
git commit -m "feat(coach): 管理者代教練取消預約（coach-flavored，會員收到教練取消通知）"
```

---

## Task 3: 前端 — 教練下拉 + coach.js 串接 coachId

**Files:**
- Modify: `public/coach.html`（標題列）
- Modify: `public/coach.js`（整檔，多函式相依）

- [ ] **Step 1: coach.html — 把標題與下拉包進同一 flex 列**

把（約 205–206 行）：
```html
  <div class="nk-kicker">COACH · 教練後台</div>
  <h1 class="page-title">教練後台</h1>
```
改成：
```html
  <div class="nk-kicker">COACH · 教練後台</div>
  <div class="flex items-center gap-4 flex-wrap mb-1">
    <h1 class="page-title">教練後台</h1>
    <select id="coach-picker" class="border rounded p-2 text-sm hidden" style="width:auto;"></select>
  </div>
```

- [ ] **Step 2: coach.js — 換成下列完整內容**

把 `public/coach.js` 整檔換成（僅在原檔基礎上：加模組狀態與 helper、改 `init`、三個 render 函式開頭加守門並把所有 `/api/coach/me*` 與取消呼叫帶上 coachId；其餘原樣保留）：

```js
import { api, fmtDate, dow, toast, getUser, escapeHtml, renderAuthBar } from './app.js';

const $ = (id) => document.getElementById(id);
const DOW_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
let me = null;
let isAdmin = false;
let selectedCoachId = null; // admin 代選的教練 id；null = 自己/未選

// admin 代選教練時，GET/DELETE 用的 querystring；非 admin 或未選 → 空字串（落回 self）
function coachQuery() {
  return (isAdmin && selectedCoachId != null) ? `?coachId=${selectedCoachId}` : '';
}
// admin 代選教練時，POST/PATCH body 補上 coachId
function withCoach(body) {
  return (isAdmin && selectedCoachId != null) ? { ...body, coachId: selectedCoachId } : body;
}
// admin 尚未選教練（且自己沒有教練檔案）→ 顯示提示、不打 API
function needsCoachSelection() { return isAdmin && selectedCoachId == null; }
const PICK_PROMPT = '<p class="text-slate-500">請先從上方選擇教練</p>';

function refreshPendingBanner() {
  const banner = $('pending-banner');
  if (!banner) return;
  banner.classList.toggle('hidden', !(me && !me.is_active));
}

// 班表時間欄：下拉只給 10 分為單位（00/10/20/30/40/50），呈現像 Google Calendar 的小捲動框；
// 手動仍可打精確分鐘（送出/離開焦點時正規化為 HH:MM）。原生時間欄/ datalist 的下拉高度無法自訂，故自製。
const TIME10_OPTIONS = Array.from({ length: 24 * 6 }, (_, i) =>
  `${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`);
function normTime(v) {
  v = (v || '').trim();
  if (!v) return '';
  let h, m;
  if (v.includes(':')) { const p = v.split(':'); h = p[0]; m = p[1]; }
  else { const d = v.replace(/\D/g, ''); if (d.length <= 2) { h = d; m = '0'; } else { h = d.slice(0, d.length - 2); m = d.slice(-2); } }
  h = parseInt(h, 10); m = parseInt(m, 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return v; // 無法解析 → 原樣，交後端擋
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
const TIME10_ATTRS = 'type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" autocomplete="off" data-time10';

// 自訂時間下拉（固定高度小框、可捲動）。掛在 body 以免被父層裁切。
function attachTimeDropdown(input) {
  const dd = document.createElement('div');
  dd.className = 'time-dd';
  dd.style.display = 'none';
  document.body.appendChild(dd);
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = `${r.left}px`;
    dd.style.top = `${r.bottom + 2}px`;
    dd.style.width = `${r.width}px`;
  };
  const show = () => {
    const digits = input.value.replace(/\D/g, '');
    const opts = TIME10_OPTIONS.filter(t => !digits || t.replace(':', '').startsWith(digits));
    if (!opts.length) { dd.style.display = 'none'; return; } // 打精確分鐘(非10單位) → 不顯示
    dd.innerHTML = opts.map(t => `<div class="time-dd-opt" data-v="${t}">${t}</div>`).join('');
    position();
    dd.style.display = 'block';
    // 捲到目前值附近（沒值則 08:00）
    const anchor = dd.querySelector(`[data-v="${normTime(input.value)}"]`) || dd.querySelector('[data-v="08:00"]');
    if (anchor) dd.scrollTop = Math.max(0, anchor.offsetTop - dd.clientHeight / 2);
  };
  const hide = () => { dd.style.display = 'none'; };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('blur', () => setTimeout(() => { if (input.value.trim()) input.value = normTime(input.value); hide(); }, 150));
  dd.addEventListener('mousedown', (e) => {
    const o = e.target.closest('.time-dd-opt');
    if (!o) return;
    e.preventDefault(); // 保持 input 焦點、避免先觸發 blur
    input.value = o.dataset.v;
    hide();
  });
  window.addEventListener('scroll', () => { if (dd.style.display !== 'none') position(); }, true);
  window.addEventListener('resize', () => { if (dd.style.display !== 'none') position(); });
}

async function init() {
  // 先取真正的使用者（含 is_admin），決定是否顯示教練下拉。
  const authUser = await api('/api/auth/me').catch(() => ({ role: 'coach' }));
  isAdmin = !!authUser.is_admin;

  if (isAdmin) {
    await setupCoachPicker(); // 顯示+填入下拉，預設選自己（若有教練檔案）
  } else {
    try {
      me = await api('/api/coach/me');
    } catch (e) {
      if (e.status === 404) { location.href = '/'; return; }
      throw e;
    }
  }

  refreshPendingBanner();
  await renderAuthBar(authUser);

  // Tab switching
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  await renderBookings();
  document.body.style.visibility = 'visible';
}

// admin：建立教練下拉。只列已啟用教練；若自己的教練檔案未啟用也補進清單以支援「預設選自己」。
async function setupCoachPicker() {
  const picker = $('coach-picker');
  let self = null;
  try { self = await api('/api/coach/me'); } catch (e) { if (e.status !== 404) throw e; }

  const all = await api('/api/admin/coaches');
  const active = all.filter(c => c.is_active);
  if (self && !active.some(c => c.id === self.id)) active.unshift(self);

  picker.innerHTML = '<option value="">— 請選擇教練 —</option>' +
    active.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}${c.is_active ? '' : '（未啟用）'}</option>`).join('');

  if (self) {
    selectedCoachId = self.id;
    me = self;
    picker.value = String(self.id);
  } else {
    selectedCoachId = null;
    me = null;
  }
  picker.classList.remove('hidden');
  picker.addEventListener('change', onCoachChange);
}

async function onCoachChange() {
  const v = $('coach-picker').value;
  selectedCoachId = v ? Number(v) : null;
  me = (selectedCoachId == null) ? null : await api(`/api/coach/me${coachQuery()}`);
  refreshPendingBanner();
  switchTab('bookings'); // 切回第一個分頁並重渲染
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('tab-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'bookings') renderBookings();
  if (name === 'availability') renderAvailability();
  if (name === 'profile') renderProfile();
}

async function renderBookings() {
  const wrap = $('tab-bookings');
  if (needsCoachSelection()) { wrap.innerHTML = PICK_PROMPT; return; }
  const list = await api(`/api/coach/me/bookings${coachQuery()}`);
  if (list.length === 0) { wrap.innerHTML = '<p class="text-slate-500">沒有預約</p>'; return; }
  wrap.innerHTML = '';
  for (const b of list) {
    const card = document.createElement('div');
    const cancelled = b.status === 'cancelled';
    card.className = `card mb-3 tab-bookings-card${cancelled ? ' is-cancelled' : ''}`;
    // 付款狀態：admin 核款後「已確認」，否則「待確認」（已取消不顯示）；Nike 用狀態小圓點 + 色字
    const payBadge = cancelled ? '' : (b.paid_at
      ? ' <span class="nk-dot ok align-middle">已確認</span>'
      : ' <span class="nk-dot warn align-middle">待確認</span>');
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold flex items-center gap-2 flex-wrap">${escapeHtml(b.member_name)}${b.session_type === '1on2' ? ' <span class="nk-tag">1對2</span>' : ''}${payBadge}</div>
          <div class="text-sm bk-when">${fmtDate(b.start_at)}</div>
          ${b.note ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(b.note)}</div>` : ''}
          ${cancelled ? `<div class="text-sm text-red-500 mt-1">已取消${b.cancel_reason ? `（${escapeHtml(b.cancel_reason)}）` : ''}</div>` : ''}
        </div>
        ${!cancelled && new Date(b.start_at) > new Date() ? `<button data-id="${b.id}" class="btn-secondary text-sm cancel-btn">緊急取消</button>` : ''}
      </div>
    `;
    wrap.appendChild(card);
  }
  wrap.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const reason = prompt('取消原因（會通知會員）：');
      if (!reason) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}${coachQuery()}`, { method: 'DELETE', body: { reason } });
        toast('已取消');
        renderBookings();
      } catch (e) {
        toast(`取消失敗：${e.message}`, 'error');
      }
    });
  });
}

async function renderAvailability() {
  if (needsCoachSelection()) { $('tab-availability').innerHTML = PICK_PROMPT; return; }
  const [rules, exceptions] = await Promise.all([
    api(`/api/coach/me/rules${coachQuery()}`),
    api(`/api/coach/me/exceptions${coachQuery()}`),
  ]);

  $('tab-availability').innerHTML = `
    <details open class="mb-5">
      <summary class="section-title cursor-pointer" style="margin-bottom:10px;">每週基底班表</summary>
      <div id="rule-list" class="space-y-2 mb-4"></div>
      <details class="card mb-2">
        <summary class="font-semibold cursor-pointer">+ 新增規則</summary>
      <form id="rule-form" class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select name="day_of_week" class="border rounded p-2 text-sm">
          ${DOW_LABELS.map((l, i) => `<option value="${i}">${l}</option>`).join('')}
        </select>
        <input ${TIME10_ATTRS} name="start_time" class="border rounded p-2 text-sm">
        <input ${TIME10_ATTRS} name="end_time" class="border rounded p-2 text-sm">
        <button class="btn-primary text-sm">加入</button>
      </form>
      </details>
    </details>

    <details open class="mb-2">
      <summary class="section-title cursor-pointer" style="margin-bottom:10px;">特殊日期（請假 / 加開）</summary>
      <div id="exception-list" class="space-y-2 mb-4"></div>
      <details class="card">
        <summary class="font-semibold cursor-pointer">+ 標記例外</summary>
      <form id="exception-form" class="mt-3 space-y-2">
        <div class="flex gap-2">
          <input type="date" name="exception_date" required class="border rounded p-2 text-sm flex-1">
          <select name="type" class="border rounded p-2 text-sm">
            <option value="leave">請假</option>
            <option value="extra">加開</option>
          </select>
        </div>
        <label class="flex items-center gap-2 text-sm" id="ex-allday-wrap">
          <input type="checkbox" id="ex-allday" checked> 整天
        </label>
        <div class="flex gap-2 hidden" id="ex-times">
          <input ${TIME10_ATTRS} name="start_time" class="border rounded p-2 text-sm flex-1">
          <input ${TIME10_ATTRS} name="end_time" class="border rounded p-2 text-sm flex-1">
        </div>
        <input type="text" name="note" placeholder="備註（選填）" class="border rounded p-2 text-sm w-full">
        <button class="btn-primary text-sm w-full">加入</button>
      </form>
      </details>
    </details>
  `;

  // 重繪時先移除舊的下拉浮層（避免殘留），再為每個時間欄掛自訂下拉 + 正規化。
  document.querySelectorAll('.time-dd').forEach(el => el.remove());
  document.querySelectorAll('#tab-availability input[data-time10]').forEach(attachTimeDropdown);

  const ruleList = $('rule-list');
  if (rules.length === 0) ruleList.innerHTML = '<p class="text-slate-500 text-sm">還沒設定班表</p>';
  for (const r of rules) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between p-2 border rounded av-row';
    row.innerHTML = `<span class="av-text">${DOW_LABELS[r.day_of_week]} ${r.start_time}–${r.end_time}</span>
      <button data-id="${r.id}" class="text-red-500 text-sm rule-del">刪除</button>`;
    ruleList.appendChild(row);
  }
  ruleList.querySelectorAll('.rule-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/rules/${b.dataset.id}${coachQuery()}`, { method: 'DELETE' });
    renderAvailability();
  }));

  $('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const start = normTime(fd.get('start_time'));
    const end = normTime(fd.get('end_time'));
    if (!start || !end) { toast('請選擇起訖時間', 'error'); return; }
    try {
      await api('/api/coach/me/rules', {
        method: 'POST',
        body: withCoach({ day_of_week: Number(fd.get('day_of_week')), start_time: start, end_time: end }),
      });
      toast('已加入');
      renderAvailability();
    } catch (err) {
      const m = { invalid_time: '結束時間需晚於開始', invalid_time_format: '時間格式錯誤' };
      toast(m[err.data?.error] || `錯誤：${err.message}`, 'error');
    }
  });

  const exList = $('exception-list');
  if (exceptions.length === 0) exList.innerHTML = '<p class="text-slate-500 text-sm">沒有特殊日期</p>';
  for (const ex of exceptions) {
    const row = document.createElement('div');
    // 狀態小圓點 + 色字（取代 🟡🟢）：請假=琥珀菱形點、加開=綠色圓點
    const tag = ex.type === 'leave'
      ? (ex.start_time
          ? `<span class="nk-dot amber">請假 ${ex.start_time}–${ex.end_time}</span>`
          : '<span class="nk-dot amber">請假（整天）</span>')
      : `<span class="nk-dot green">加開 ${ex.start_time}–${ex.end_time}</span>`;
    row.className = 'flex items-center justify-between p-2 border rounded av-row';
    row.innerHTML = `<span class="av-text flex items-center gap-2 flex-wrap">${ex.exception_date} · ${tag}${ex.note ? ` · ${escapeHtml(ex.note)}` : ''}</span>
      <button data-id="${ex.id}" class="text-red-500 text-sm ex-del">刪除</button>`;
    exList.appendChild(row);
  }
  exList.querySelectorAll('.ex-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/exceptions/${b.dataset.id}${coachQuery()}`, { method: 'DELETE' });
    renderAvailability();
  }));

  // 表單切換：加開 → 一律顯示時段、無「整天」；請假 → 顯示「整天」勾選框，
  // 勾「整天」時隱藏時段（整天請假），取消勾選則指定時段（部分請假）。
  const exTypeSel = $('exception-form').querySelector('[name=type]');
  const exAllday = $('ex-allday');
  function syncExceptionForm() {
    const isLeave = exTypeSel.value === 'leave';
    $('ex-allday-wrap').classList.toggle('hidden', !isLeave);
    const showTimes = !isLeave || !exAllday.checked;
    $('ex-times').classList.toggle('hidden', !showTimes);
  }
  exTypeSel.addEventListener('change', syncExceptionForm);
  exAllday.addEventListener('change', syncExceptionForm);
  syncExceptionForm();

  $('exception-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const type = fd.get('type');
    const allDay = type === 'leave' && exAllday.checked;
    const start_time = allDay ? null : (normTime(fd.get('start_time')) || null);
    const end_time = allDay ? null : (normTime(fd.get('end_time')) || null);
    if (!allDay && (!start_time || !end_time)) { toast('請選擇起訖時間', 'error'); return; }
    try {
      await api('/api/coach/me/exceptions', {
        method: 'POST',
        body: withCoach({ exception_date: fd.get('exception_date'), type, start_time, end_time, note: fd.get('note') || null }),
      });
      toast('已加入');
      renderAvailability();
    } catch (err) {
      const m = { invalid_time: '結束時間需晚於開始', invalid_time_format: '時間格式錯誤', missing_time: '請選擇起訖時間' };
      toast(m[err.data?.error] || `錯誤：${err.message}`, 'error');
    }
  });
}

async function renderProfile() {
  if (needsCoachSelection() || !me) { $('tab-profile').innerHTML = PICK_PROMPT; return; }
  $('tab-profile').innerHTML = `
    <form id="profile-form" class="space-y-3 max-w-lg">
      <label class="block">
        <span class="text-sm text-slate-600">顯示名稱</span>
        <input name="display_name" value="${escapeAttr(me.display_name)}" class="mt-1 w-full border rounded p-2 text-sm" required>
      </label>
      <label class="block">
        <span class="text-sm text-slate-600">專長</span>
        <input name="specialty" value="${escapeAttr(me.specialty || '')}" class="mt-1 w-full border rounded p-2 text-sm" placeholder="例：增肌減脂 · 體態雕塑">
      </label>
      <label class="block">
        <span class="text-sm text-slate-600">介紹</span>
        <textarea name="bio" rows="4" class="mt-1 w-full border rounded p-2 text-sm">${escapeHtml(me.bio || '')}</textarea>
      </label>
      <div>
        <span class="text-sm text-slate-600 profile-field-label">頭像</span>
        <div class="flex items-center gap-3 mt-1">
          <div class="w-16 h-16 rounded-full bg-slate-200 overflow-hidden">
            ${me.avatar_path ? `<img src="/avatars/${me.avatar_path}" class="w-full h-full object-cover">` : ''}
          </div>
          <input type="file" id="avatar-input" accept="image/png,image/jpeg" class="text-sm">
        </div>
      </div>
      <button class="btn-primary">儲存</button>
    </form>
  `;

  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/coach/me/profile', {
        method: 'PATCH',
        body: withCoach({
          display_name: fd.get('display_name'),
          specialty: fd.get('specialty') || null,
          bio: fd.get('bio') || null,
        }),
      });
      const file = $('avatar-input').files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) { toast('頭像超過 2MB', 'error'); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          await api('/api/coach/me/avatar', { method: 'POST', body: withCoach({ avatar_base64: reader.result }) });
          toast('已儲存');
          me = await api(`/api/coach/me${coachQuery()}`);
          renderProfile();
        };
        reader.readAsDataURL(file);
      } else {
        toast('已儲存');
        me = await api(`/api/coach/me${coachQuery()}`);
      }
    } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
  });
}

function escapeAttr(s) { return escapeHtml(s); }

await init();
```

- [ ] **Step 3: 手動煙霧測試（沒有前端測試框架，靠手動驗證）**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
SRV=$!; sleep 2
echo "open http://localhost:3000/login.html → 以 admin@chinup.local / admin1234 登入 → /coach.html"
# 驗收（人工）：
# 1) 標題右側出現下拉，預設選中自己；切到別位已啟用教練 → 三分頁帶出該教練資料。
# 2) 在該教練底下新增/刪除班表規則、標記例外、改個人資料、緊急取消未來預約都成功且落在該教練。
# 3) 以一般教練（非 admin）登入 → 看不到下拉，行為與改版前一致（只能管自己）。
# 完成後：
kill $SRV
```
Expected: 上述 1–3 全部符合。

- [ ] **Step 4: Commit**

```bash
git add public/coach.html public/coach.js
git commit -m "feat(coach): 教練後台標題旁下拉，管理者可代選教練檢視/編輯"
```

---

## Task 4: 全套回歸 + 收尾

**Files:** 無（驗證用）

- [ ] **Step 1: 跑單元測試套件**

```bash
npm test
```
Expected: 全綠（注意：`npm test` 會清掉 demo 資料，跑完需重新 seed 才能預覽）。

- [ ] **Step 2: 啟動 server 跑 api 測試套件**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js &
SRV=$!; sleep 2
npm run test:api
kill $SRV
```
Expected: 全綠（含新加的 `admin-coach-switch-api` 與 `admin-coach-cancel-api`）。`gmail-auth-api.test.js` 在無 Google OAuth 憑證的本機環境為既有環境性失敗，可忽略（非本次改動造成）。

- [ ] **Step 3: 重新 seed demo 資料供預覽**

```bash
npm run seed && node src/db/seed-demo.js
```
Expected: demo 資料重建完成。

- [ ] **Step 4: Commit（若有 seed 衍生變更則略過；本步通常無檔案變更）**

無檔案變更則跳過。最終以 `superpowers:finishing-a-development-branch` 收尾（draft PR + 手動煙霧測試 gate）。

---

## Self-Review

**1. Spec coverage**
- 決策①可改三項：Task 1（profile/rules/exceptions 讀寫）+ Task 2（取消）+ Task 3（前端三分頁）✓
- 決策②下拉只列已啟用＋自己例外：Task 3 `setupCoachPicker`（`filter(c=>c.is_active)` + 補自己）✓
- 決策③代取消 coach-flavored：Task 2（`adminOnBehalf` → `booking_cancelled_by_coach`、需 reason）✓
- 決策④預設顯示自己：Task 3（`setupCoachPicker` 預設 `self.id`；無檔案→空狀態不導回）✓
- 決策⑤下拉位置（標題右側同列）：Task 3 Step 1 ✓
- 後端單一 resolver、零 service 改動：Task 1 ✓
- 安全（只認 is_admin、非 admin 忽略、壞 id 404）：Task 1 測試涵蓋 ✓
- 邊界（coachId 不符不視為代理、缺 reason 400、非擁有者 403）：Task 2 測試涵蓋 ✓

**2. Placeholder scan**：無 TBD/TODO；每段程式皆為完整可執行內容；測試含實際斷言。✓

**3. Type/identifier consistency**
- `resolveCoach`/`loadCoachForUser`/`svcGetCoach` 名稱一致；`coachId` 參數在 server 端讀 `req.query.coachId ?? req.body?.coachId`、前端以 `coachQuery()`(query) 與 `withCoach()`(body) 對應，GET/DELETE↔query、POST/PATCH↔body 一致。✓
- `cancelBooking` 新增 `adminOnBehalf`（預設 false），route 傳入名稱一致；通知 type `booking_cancelled_by_coach` 與既有一致。✓
- 前端 `me`/`isAdmin`/`selectedCoachId`/`needsCoachSelection`/`refreshPendingBanner`/`setupCoachPicker`/`onCoachChange` 跨函式引用一致。✓
