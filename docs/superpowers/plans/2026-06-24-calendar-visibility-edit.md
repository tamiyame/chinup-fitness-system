# PR3：登錄行事曆 角色可見範圍 + 預約編輯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 一般教練只看自己的預約、管理者看全部教練；點已登錄預約可取消/改時段/改客人或方案。

**Architecture:** `getCoachWeek` 加管理者「全部教練」模式（含 coach_name）；新 `rescheduleBooking`/`reassignBooking`（bookingService）+ 2 個 PATCH 端點；取消沿用既有 `DELETE /api/bookings/:id`。前端登錄分頁自有「全部教練」選擇器（不動共用下拉）+ 預約格可點開編輯彈窗。

**Tech Stack:** Node ESM、Express、node:sqlite；前端 vanilla JS。

## Global Constraints
- 例外 `throw new ApiError(status, code)`（`./registration.js`）。交易 `tx(fn)`；時間 `nowLocal()`；整點格式 `START_AT_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/`。
- 編輯/取消權限：`requireCoach`；service 內 `!isAdmin` 時 booking 的 coach.user_id 必須 = actorUserId（403 forbidden）。管理者可改任一教練的預約。
- `all=1`（全部教練）**僅管理者**有效；非管理者忽略、落回自己。
- 改時段/改客人後以 `syncBookingCancel(id).then(()=>syncBookingCreate(id))` 刷新 gcal 事件（決定性 event id；GCAL_MOCK 下 no-op）。
- 方案守門沿用 PR1/PR2：reassign 的新方案須屬新客人且有效；扣抵原子、tx rollback 還原。
- **不動共用 `#coach-picker`**（我的預約/班表/個人資料需單一教練）；「全部教練」選擇器只在登錄分頁。
- 測試：unit 掛 `test`、api 掛 `test:api`（起 server，`LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1`）；`expect()` 不 throw → 掃 `✗`；清理 bookings 前先刪 notifications（FK）。`npm test` 清 demo → 收尾重 seed。繁中 UI。

## File Structure
- `src/services/coachCalendarService.js` — getCoachWeek 加 `all` + bookings 補 coach_id/coach_name/paid_at/discount_code。
- `src/services/bookingService.js` — 新 `rescheduleBooking`/`reassignBooking`。
- `src/services/notifications.js` — 加 `booking_rescheduled` 模板。
- `src/server.js` — 改 `GET /api/coach/week`（all）；加 `PATCH /api/coach/bookings/:id/reschedule`、`.../reassign`。
- `public/coach.js` — 登錄分頁 reg-coach-picker（全部教練）+ renderRegister 全覽 + 編輯彈窗。
- `public/coach.html` — 編輯彈窗骨架。
- `public/style.css` — 編輯彈窗 + 多教練/淡色格樣式。
- 測試：`tests/coach-week-all.test.js`、`tests/booking-edit.test.js`（unit）；`tests/booking-edit-api.test.js`（api）。

---

## Task 1：getCoachWeek 全部教練模式 + 週端點 all

**Files:** Modify `src/services/coachCalendarService.js`、`src/server.js`；Create `tests/coach-week-all.test.js`；Modify `package.json`(test)。

**Interfaces:**
- Produces: `getCoachWeek({coachId, start, all=false})` → `{weekStart, all, bookings:[{id,coach_id,coach_name,start_at,end_at,session_type,package_id,paid_at,discount_code,member_name}], groupSessions:[{id,coach_id?,coach_name?,start_at,end_at,name}], availableSlots}`。`all=true`＝所有教練；availableSlots = coachId 有給才算、否則 `[]`。端點 `GET /api/coach/week?start=&all=1&coachId=`（all 僅管理者）。

- [ ] **Step 1：改 `src/services/coachCalendarService.js` 的查詢與 getCoachWeek**

把現有 `weekBookings`/`weekGroupSessions` 兩個 const 與 `getCoachWeek` 整段（檔案 14-37 行）替換為：
```js
const BK_COLS = `b.id, b.coach_id, b.start_at, b.end_at, b.session_type, b.package_id, b.paid_at, b.discount_code,
       u.name AS member_name, c.display_name AS coach_name`;
const weekBookings = db.prepare(`
  SELECT ${BK_COLS}
  FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id
  WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekAllBookings = db.prepare(`
  SELECT ${BK_COLS}
  FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id
  WHERE b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekGroupSessions = db.prepare(`
  SELECT s.id, s.coach_id, s.start_at, s.end_at, t.name, c.display_name AS coach_name
  FROM course_sessions s JOIN course_templates t ON t.id = s.template_id
  LEFT JOIN coaches c ON c.id = s.coach_id
  WHERE s.coach_id = ? AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  ORDER BY s.start_at ASC
`);
const weekAllGroupSessions = db.prepare(`
  SELECT s.id, s.coach_id, s.start_at, s.end_at, t.name, c.display_name AS coach_name
  FROM course_sessions s JOIN course_templates t ON t.id = s.template_id
  LEFT JOIN coaches c ON c.id = s.coach_id
  WHERE s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  ORDER BY s.start_at ASC
`);

/** 某教練（或 all=管理者全部教練）自 start（週一）起 7 天的：個別課預約 + 團課場次 + 班表底色。 */
export function getCoachWeek({ coachId, start, all = false }) {
  if (!YYYYMMDD.test(start)) throw new ApiError(400, 'invalid_start');
  const endExclusive = addDays(start, 7);
  const lo = `${start}T00:00:00`, hi = `${endExclusive}T00:00:00`;
  const bookings = all ? weekAllBookings.all(lo, hi) : weekBookings.all(coachId, lo, hi);
  const groupSessions = all ? weekAllGroupSessions.all(lo, hi) : weekGroupSessions.all(coachId, lo, hi);
  // 班表底色：有指定 coachId 才算（全覽未選教練 → []）。
  const availableSlots = coachId
    ? computeAvailableSlots({ coachId, fromDate: start, toDate: addDays(start, 6), externalBusy: null, includePast: true })
    : [];
  return { weekStart: start, all: !!all, bookings, groupSessions, availableSlots };
}
```

- [ ] **Step 2：改 `src/server.js` 的 `GET /api/coach/week` 路由**

把現有：
```js
app.get('/api/coach/week', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res); if (!coach) return;
  const { start } = req.query;
  res.json(svcGetCoachWeek({ coachId: coach.id, start }));
}));
```
改為：
```js
app.get('/api/coach/week', requireCoach, asyncHandler((req, res) => {
  const wantAll = (req.query.all === '1' || req.query.all === 'true') && !!req.user.is_admin;
  if (wantAll) {
    // 全部教練：coachId 可選（決定底色/登錄目標）。
    let coachId = null;
    if (req.query.coachId != null && req.query.coachId !== '') {
      const c = svcGetCoach(Number(req.query.coachId));
      if (!c) return res.status(404).json({ error: 'coach_not_found' });
      coachId = c.id;
    }
    return res.json(svcGetCoachWeek({ coachId, start: req.query.start, all: true }));
  }
  const coach = resolveCoach(req, res); if (!coach) return;
  res.json(svcGetCoachWeek({ coachId: coach.id, start: req.query.start }));
}));
```
（`svcGetCoach` 已在 server.js import；resolveCoach 也用它。）

- [ ] **Step 3：寫 unit 測試 `tests/coach-week-all.test.js`**

```js
// getCoachWeek：all 模式回所有教練 bookings(含 coach_name)；單一教練模式不變且帶 coach_name。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { getCoachWeek } = await import('../src/services/coachCalendarService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[coach-week-all test] start');
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cw-%'); DELETE FROM coaches WHERE display_name LIKE 'cw-%'; DELETE FROM users WHERE email LIKE 'cw-%'");
const pad=n=>String(n).padStart(2,'0');
const c1u=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('cw教練A','cw-c1@x.com','coach')").run().lastInsertRowid);
const c1=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'cw-A',1)").run(c1u).lastInsertRowid);
const c2u=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('cw教練B','cw-c2@x.com','coach')").run().lastInsertRowid);
const c2=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'cw-B',1)").run(c2u).lastInsertRowid);
const m=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('cw客','cw-m@x.com','user','0980000001')").run().lastInsertRowid);
const base=new Date(Date.now()+12*86400000);
const toMon=(base.getDay()===0?-6:1-base.getDay());
const mon=new Date(base.getFullYear(),base.getMonth(),base.getDate()+toMon);
const start=`${mon.getFullYear()}-${pad(mon.getMonth()+1)}-${pad(mon.getDate())}`;
const d1=`${start}T09:00:00`, d2=`${start}T10:00:00`;
db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(c1,m,d1,`${start}T10:00:00`);
db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(c2,m,d2,`${start}T11:00:00`);

expect('單一教練：只回該教練 + 帶 coach_name', () => {
  const w=getCoachWeek({coachId:c1,start});
  assert.equal(w.all,false);
  assert.ok(w.bookings.every(b=>b.coach_id===c1));
  assert.equal(w.bookings[0].coach_name,'cw-A');
  assert.ok(Array.isArray(w.availableSlots));
});
expect('all：回所有教練 bookings + coach_name', () => {
  const w=getCoachWeek({start,all:true});
  assert.equal(w.all,true);
  const ids=w.bookings.map(b=>b.coach_id);
  assert.ok(ids.includes(c1)&&ids.includes(c2));
  assert.ok(w.bookings.find(b=>b.coach_id===c2).coach_name==='cw-B');
  assert.deepEqual(w.availableSlots,[]); // all 未給 coachId → 無底色
});
expect('all + coachId：仍回全部 bookings、availableSlots 為該教練', () => {
  const w=getCoachWeek({coachId:c1,start,all:true});
  assert.ok(w.bookings.some(b=>b.coach_id===c2)); // 仍全部
  assert.ok(Array.isArray(w.availableSlots));
});
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cw-%'); DELETE FROM coaches WHERE display_name LIKE 'cw-%'; DELETE FROM users WHERE email LIKE 'cw-%'");
console.log('[coach-week-all test] done');
```

- [ ] **Step 4：跑測試**

Run: `node tests/coach-week-all.test.js` → 全 `✓`、0 `✗`。

- [ ] **Step 5：掛 `package.json` 的 `test` 末尾 `&& node tests/coach-week-all.test.js`**

- [ ] **Step 6：Commit**
```bash
git add src/services/coachCalendarService.js src/server.js tests/coach-week-all.test.js package.json
git commit -m "feat(calendar): getCoachWeek 全部教練模式 + 週端點 all（管理者全覽）"
```

---

## Task 2：rescheduleBooking + reassignBooking + 端點 + 模板

**Files:** Modify `src/services/bookingService.js`、`src/services/notifications.js`、`src/server.js`；Create `tests/booking-edit.test.js`、`tests/booking-edit-api.test.js`；Modify `package.json`(test, test:api)。

**Interfaces:**
- Consumes: `getBookingStmt`、`getCoachStmt`、`addMinutes`、`notify`、`fmtDateForLine`、`tx`、`nowLocal`、`START_AT_RE`、`ApiError`、`pkgGetPackage`、`pkgDeductOne`、`refundPackageOne`、`releaseRedemption`（皆已於 bookingService import/定義）。
- 註：reschedule 的衝突檢查僅看 bookings（不含團課場次）——與 createCoachRegister 一致（登錄本就 enforceAvailability:false 只擋同教練同整點 booking），為刻意繼承的限制非疏漏。
- Produces:
  - `rescheduleBooking({bookingId, newStartAt, actorUserId, isAdmin}) → {ok, bookingId, startAt, endAt}`
  - `reassignBooking({bookingId, newMemberId, newPackageId, actorUserId, isAdmin}) → {ok, bookingId}`
  - 端點 `PATCH /api/coach/bookings/:id/reschedule {startAt}`、`PATCH /api/coach/bookings/:id/reassign {memberId, packageId}`。

- [ ] **Step 1：`src/services/notifications.js` 加模板**

在 `booking_confirmed` 模板之後加：
```js
  booking_rescheduled: {  // 寄給會員（教練/管理者改期）
    subject: '預約時間已更新 - {{coach_display_name}}',
    body: '🔄 您與 {{coach_display_name}} 教練的課程已改至 {{start_at}}，請留意新的上課時間。',
  },
```

- [ ] **Step 2：`src/services/bookingService.js` 新增兩函式（放在 `createCoachRegister` 之後）**

```js
const clashOtherBooking = db.prepare(
  "SELECT 1 FROM bookings WHERE coach_id = ? AND start_at = ? AND status = 'confirmed' AND id <> ? LIMIT 1"
);

/** 改時段（同教練）：移動 start/end，不動 member/package/付款。權限：非管理者限本人教練。 */
export function rescheduleBooking({ bookingId, newStartAt, actorUserId, isAdmin = false }) {
  if (typeof newStartAt !== 'string' || !START_AT_RE.test(newStartAt)) throw new ApiError(400, 'invalid_start_at');
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    const coach = getCoachStmt.get(b.coach_id);
    if (!isAdmin && (!coach || coach.user_id !== actorUserId)) throw new ApiError(403, 'forbidden');
    const newEndAt = addMinutes(newStartAt, 60);
    if (clashOtherBooking.get(b.coach_id, newStartAt, bookingId)) throw new ApiError(409, 'slot_taken');
    try {
      db.prepare('UPDATE bookings SET start_at = ?, end_at = ? WHERE id = ?').run(newStartAt, newEndAt, bookingId);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
      throw e;
    }
    if (coach) notify({ userId: b.member_id, sessionId: null, type: 'booking_rescheduled',
      vars: { coach_display_name: coach.display_name, start_at: fmtDateForLine(newStartAt) } });
    return { ok: true, bookingId, startAt: newStartAt, endAt: newEndAt };
  });
}

/** 改客人/方案（同教練同時段）：退舊方案(若有)→驗新方案(屬新客人、有效)→扣新→更新欄位（轉為方案登錄、已核對）。 */
export function reassignBooking({ bookingId, newMemberId, newPackageId, actorUserId, isAdmin = false }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    const coach = getCoachStmt.get(b.coach_id);
    if (!isAdmin && (!coach || coach.user_id !== actorUserId)) throw new ApiError(403, 'forbidden');
    const memberId = Number(newMemberId);
    const p = pkgGetPackage(newPackageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    if (p.member_id !== memberId) throw new ApiError(400, 'package_member_mismatch');
    if (!p.is_valid) throw new ApiError(409, 'package_invalid');
    if (b.discount_code) releaseRedemption({ kind: 'booking', refId: bookingId }); // 釋放舊折扣碼用量（轉方案後不再套折扣；比照 cancelBooking）
    if (b.package_id) refundPackageOne(b.package_id);          // 退舊方案（+1；refundOne 封頂、best-effort）
    if (!pkgDeductOne(newPackageId)) throw new ApiError(409, 'package_depleted'); // 防禦（單執行緒下用罄方案 is_valid=false 已先擋為 package_invalid）；失敗 → tx rollback 還原退舊
    const unitPrice = p.amount != null ? Math.round(p.amount / p.total_sessions) : null;
    db.prepare(`UPDATE bookings SET member_id = ?, package_id = ?, session_type = ?, original_amount = ?,
                discount_code = NULL, discount_amount = NULL, paid_at = ?, paid_by = ? WHERE id = ?`)
      .run(memberId, newPackageId, p.session_type, unitPrice, nowLocal(), actorUserId, bookingId);
    if (coach) notify({ userId: memberId, sessionId: null, type: 'booking_confirmed',
      vars: { coach_display_name: coach.display_name, start_at: fmtDateForLine(b.start_at) } });
    return { ok: true, bookingId };
  });
}
```

- [ ] **Step 3：`src/server.js` import 與路由**

(a) 併入既有 bookingService import 區塊（`createCoachRegister as svcCreateRegister,` 之後）：
```js
  rescheduleBooking as svcRescheduleBooking,
  reassignBooking as svcReassignBooking,
```
(b) 在登錄端點（`POST /api/coach/register` route）之後加：
```js
app.patch('/api/coach/bookings/:id/reschedule', requireCoach, asyncHandler((req, res) => {
  const { startAt } = req.body || {};
  const r = svcRescheduleBooking({ bookingId: Number(req.params.id), newStartAt: startAt, actorUserId: req.user.id, isAdmin: !!req.user.is_admin });
  syncBookingCancel(r.bookingId).then(() => syncBookingCreate(r.bookingId)); // 刷新日曆事件
  res.json(r);
}));

app.patch('/api/coach/bookings/:id/reassign', requireCoach, asyncHandler((req, res) => {
  const { memberId, packageId } = req.body || {};
  const r = svcReassignBooking({ bookingId: Number(req.params.id), newMemberId: Number(memberId), newPackageId: Number(packageId), actorUserId: req.user.id, isAdmin: !!req.user.is_admin });
  syncBookingCancel(r.bookingId).then(() => syncBookingCreate(r.bookingId));
  res.json(r);
}));
```

- [ ] **Step 4：unit 測試 `tests/booking-edit.test.js`**

```js
// 改時段 / 改客人方案 service：成功、衝突、權限、退舊扣新、rollback。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createPackage, getPackage, deductOne } = await import('../src/services/packageService.js');
const { rescheduleBooking, reassignBooking } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-edit test] start');
const clean=()=>db.exec("DELETE FROM discount_redemptions WHERE code_id IN (SELECT id FROM discount_codes WHERE code LIKE 'BE%'); DELETE FROM discount_codes WHERE code LIKE 'BE%'; DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'be-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'be-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'be-%'); DELETE FROM coaches WHERE display_name LIKE 'be-%'; DELETE FROM users WHERE email LIKE 'be-%'");
clean();
const pad=n=>String(n).padStart(2,'0');
const cu=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('be教練','be-c@x.com','coach')").run().lastInsertRowid);
const coach=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'be-coach',1)").run(cu).lastInsertRowid);
const cu2=Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('be教練2','be-c2@x.com','coach')").run().lastInsertRowid);
const coach2=Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'be-coach2',1)").run(cu2).lastInsertRowid);
const m1=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('be客1','be-m1@x.com','user','0981000001')").run().lastInsertRowid);
const m2=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('be客2','be-m2@x.com','user','0981000002')").run().lastInsertRowid);
const admin=Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('be管','be-a@x.com','coach',1)").run().lastInsertRowid);
const D=`${new Date(Date.now()+13*86400000).getFullYear()}-${pad(new Date(Date.now()+13*86400000).getMonth()+1)}-${pad(new Date(Date.now()+13*86400000).getDate())}`;
const mkBk=(memberId,hh,pkgId=null,sType='1on1')=>Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id,paid_at) VALUES (?,?,?,?,?,?,?)").run(coach,memberId,`${D}T${hh}:00:00`,`${D}T${String(Number(hh)+1).padStart(2,'0')}:00:00`,sType,pkgId,pkgId?'2026-06-24T00:00:00':null).lastInsertRowid);

expect('reschedule：移到新整點、member/package 不變', () => {
  const bid=mkBk(m1,'09');
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T15:00:00`, actorUserId:cu, isAdmin:false });
  const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
  assert.equal(b.start_at,`${D}T15:00:00`); assert.equal(b.end_at,`${D}T16:00:00`); assert.equal(b.member_id,m1);
});
expect('reschedule 衝突 → 409 slot_taken', () => {
  mkBk(m2,'11'); const bid=mkBk(m1,'12');
  assert.throws(()=>rescheduleBooking({ bookingId:bid, newStartAt:`${D}T11:00:00`, actorUserId:cu, isAdmin:false }),/slot_taken/);
});
expect('reschedule 一般教練改他人預約 → 403', () => {
  const other=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(coach2,m1,`${D}T09:00:00`,`${D}T10:00:00`).lastInsertRowid);
  assert.throws(()=>rescheduleBooking({ bookingId:other, newStartAt:`${D}T18:00:00`, actorUserId:cu, isAdmin:false }),/forbidden/);
});
expect('reassign 方案↔方案：退舊+扣新+type/單價', () => {
  const pOld=createPackage({memberId:m1,sessionType:'1on1',totalSessions:5,amount:5000}); deductOne(pOld.id); // 剩4
  const pNew=createPackage({memberId:m2,sessionType:'1on2',totalSessions:10,amount:20000});                 // 剩10
  const bid=mkBk(m1,'09',pOld.id,'1on1');
  reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true });
  assert.equal(getPackage(pOld.id).remaining_sessions,5); // 退回
  assert.equal(getPackage(pNew.id).remaining_sessions,9); // 扣 1
  const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
  assert.equal(b.member_id,m2); assert.equal(b.package_id,pNew.id); assert.equal(b.session_type,'1on2');
  assert.equal(b.original_amount,2000); assert.ok(b.paid_at);
});
expect('reassign 非方案→方案：設 paid_at、清折扣、扣新', () => {
  const pNew=createPackage({memberId:m2,sessionType:'1on1',totalSessions:3,amount:3000});
  const bid=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,original_amount,discount_code,discount_amount) VALUES (?,?,?,?, '1on1', 1500,'X',100)").run(coach,m1,`${D}T13:00:00`,`${D}T14:00:00`).lastInsertRowid);
  reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true });
  const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
  assert.equal(b.package_id,pNew.id); assert.equal(b.member_id,m2); assert.equal(b.discount_code,null); assert.ok(b.paid_at);
  assert.equal(getPackage(pNew.id).remaining_sessions,2);
});
expect('reassign 方案不屬新客人 → 400', () => {
  const p=createPackage({memberId:m1,sessionType:'1on1',totalSessions:3});
  const bid=mkBk(m1,'16');
  assert.throws(()=>reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:p.id, actorUserId:admin, isAdmin:true }),/package_member_mismatch/);
});
expect('reassign 方案已用罄(is_valid=false) → 409 package_invalid，且未誤退舊', () => {
  const pOld=createPackage({memberId:m1,sessionType:'1on1',totalSessions:5}); deductOne(pOld.id); // 剩4
  const pNew=createPackage({memberId:m2,sessionType:'1on1',totalSessions:1}); deductOne(pNew.id); // 剩0 → is_valid=false
  const bid=mkBk(m1,'17',pOld.id);
  // 用罄方案 is_valid=false → reassign 在 is_valid 檢查就擋 package_invalid（早於退舊/扣新；package_depleted 為防禦、單執行緒不可達）
  assert.throws(()=>reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true }),/package_invalid/);
  assert.equal(getPackage(pOld.id).remaining_sessions,4); // 早於退舊就丟 → 未誤退
  assert.equal(getPackage(pNew.id).remaining_sessions,0);
});
expect('reschedule 已取消預約 → 409 already_cancelled', () => {
  const bid=mkBk(m1,'18');
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bid);
  assert.throws(()=>rescheduleBooking({ bookingId:bid, newStartAt:`${D}T19:00:00`, actorUserId:cu, isAdmin:false }),/already_cancelled/);
});
expect('reassign 折扣碼非方案預約 → 釋放舊折扣 redemption', () => {
  const codeId=Number(db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('BE10','percent',10,1)").run().lastInsertRowid);
  const bid=Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,original_amount,discount_code,discount_amount) VALUES (?,?,?,?, '1on1',1500,'BE10',150)").run(coach,m1,`${D}T20:00:00`,`${D}T21:00:00`).lastInsertRowid);
  db.prepare("INSERT INTO discount_redemptions (code_id,phone,kind,ref_id,amount) VALUES (?, '0981000001','booking',?,150)").run(codeId,bid);
  const pNew=createPackage({memberId:m2,sessionType:'1on1',totalSessions:3,amount:3000});
  reassignBooking({ bookingId:bid, newMemberId:m2, newPackageId:pNew.id, actorUserId:admin, isAdmin:true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM discount_redemptions WHERE kind='booking' AND ref_id=?").get(bid).c, 0); // 已釋放
});
clean();
console.log('[booking-edit test] done');
```

- [ ] **Step 5：跑 unit 測試**

Run: `node tests/booking-edit.test.js` → 全 `✓`、0 `✗`。

- [ ] **Step 6：api 測試 `tests/booking-edit-api.test.js`**

```js
// API：reschedule/reassign 端點 + 守門；week all=1 管理者 vs 非管理者。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body,token}={}){const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[booking-edit-api] start');
const clean=()=>db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'bea-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'bea-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'bea-%'); DELETE FROM users WHERE email LIKE 'bea-%'; DELETE FROM auth_sessions WHERE token LIKE 'bea-%'");
clean();
const login=await req('POST','/api/auth/login',{body:{email:'admin@chinup.local',password:'admin1234'}});
const token=login.data?.token;
expect('admin 登入',()=>assert.ok(token));
const coaches=await req('GET','/api/admin/coaches',{token});
const coachId=coaches.data.find(c=>c.is_active).id;
const m1=Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('BEA客1','bea-m1@x.com','0982000001','user')").run().lastInsertRowid);
const m2=Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('BEA客2','bea-m2@x.com','0982000002','user')").run().lastInsertRowid);
const pad=n=>String(n).padStart(2,'0'); const dd=new Date(Date.now()+14*86400000); const D=`${dd.getFullYear()}-${pad(dd.getMonth()+1)}-${pad(dd.getDate())}`;
const pkg=await req('POST','/api/coach/packages',{token,body:{memberId:m1,sessionType:'1on1',totalSessions:5,amount:7500}});
const reg=await req('POST','/api/coach/register',{token,body:{coachId,memberId:m1,packageId:pkg.data.id,startAt:`${D}T09:00:00`,recurrence:null}});
const bid=reg.data.created[0].id;
expect('登錄成功',()=>assert.equal(reg.status,201));

const rs=await req('PATCH',`/api/coach/bookings/${bid}/reschedule`,{token,body:{startAt:`${D}T16:00:00`}});
expect('改時段 → 200 + 新時段',()=>{ assert.equal(rs.status,200); assert.equal(db.prepare('SELECT start_at FROM bookings WHERE id=?').get(bid).start_at,`${D}T16:00:00`); });

const pkg2=await req('POST','/api/coach/packages',{token,body:{memberId:m2,sessionType:'1on1',totalSessions:3,amount:4500}});
const ra=await req('PATCH',`/api/coach/bookings/${bid}/reassign`,{token,body:{memberId:m2,packageId:pkg2.data.id}});
expect('改客人/方案 → 200 + 換 member/package',()=>{ assert.equal(ra.status,200); const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid); assert.equal(b.member_id,m2); assert.equal(b.package_id,pkg2.data.id); });

const wkAll=await req('GET',`/api/coach/week?all=1&start=${D}`,{token});
expect('管理者 all=1 → 回 all:true',()=>{ assert.equal(wkAll.status,200); assert.equal(wkAll.data.all,true); });

// 管理者取消（他教練的）方案預約 → 200 + 回補方案堂（編輯彈窗取消路徑）
const pkgC=await req('POST','/api/coach/packages',{token,body:{memberId:m1,sessionType:'1on1',totalSessions:4,amount:6000}});
const regC=await req('POST','/api/coach/register',{token,body:{coachId,memberId:m1,packageId:pkgC.data.id,startAt:`${D}T11:00:00`,recurrence:null}});
const cbid=regC.data.created[0].id;
const remBefore=db.prepare('SELECT remaining_sessions FROM customer_packages WHERE id=?').get(pkgC.data.id).remaining_sessions;
const del=await req('DELETE',`/api/bookings/${cbid}?coachId=${coachId}`,{token,body:{reason:'測試取消'}});
expect('管理者取消他教練方案預約 → 200 + 已取消 + 回補堂',()=>{
  assert.equal(del.status,200);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(cbid).status,'cancelled');
  assert.equal(db.prepare('SELECT remaining_sessions FROM customer_packages WHERE id=?').get(pkgC.data.id).remaining_sessions, remBefore+1);
});

// 非管理者教練 all=1 → 落回自己（all:false）；管理者 gate 不放行非管理者全覽
const ncoach=db.prepare("SELECT u.id AS uid FROM users u JOIN coaches c ON c.user_id=u.id WHERE u.role='coach' AND u.is_admin=0 AND c.is_active=1 LIMIT 1").get();
if (ncoach) {
  const ntok='bea-ctok-'+ncoach.uid;
  db.prepare("INSERT OR REPLACE INTO auth_sessions (token,user_id,expires_at) VALUES (?,?, '2099-01-01T00:00:00')").run(ntok,ncoach.uid);
  const wkNon=await req('GET',`/api/coach/week?all=1&start=${D}`,{token:ntok});
  expect('非管理者教練 all=1 → all:false（落回自己）',()=>{ assert.equal(wkNon.status,200); assert.equal(wkNon.data.all,false); });
  db.prepare("DELETE FROM auth_sessions WHERE token=?").run(ntok);
}

// role=user 連 requireCoach 都過不了 → 403 coach_only（非「all 落回自己」邏輯）
const utok='bea-token-'+m1;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token,user_id,expires_at) VALUES (?,?, '2099-01-01T00:00:00')").run(utok,m1);
const wkUser=await req('GET',`/api/coach/week?all=1&start=${D}`,{token:utok});
expect('role=user 取週端點 → 403 coach_only',()=>assert.equal(wkUser.status,403));
db.prepare("DELETE FROM auth_sessions WHERE token=?").run(utok);

const noAuth=await req('PATCH',`/api/coach/bookings/${bid}/reschedule`,{body:{startAt:`${D}T17:00:00`}});
expect('未登入改時段 → 401',()=>assert.equal(noAuth.status,401));
clean();
console.log('[booking-edit-api] done');
```

- [ ] **Step 7：掛測試 + 起 server 跑 api**

`package.json`：`test` 末尾加 `&& node tests/booking-edit.test.js`；`test:api` 末尾加 `&& node tests/booking-edit-api.test.js`。
Run:
```bash
(LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 PORT=3000 node src/server.js & SRV=$!; sleep 1.5; node tests/booking-edit-api.test.js; kill $SRV)
```
Expected 全 `✓`、0 `✗`（admin 登入失敗 → `npm run seed && node src/db/seed-demo.js` 再跑）。

- [ ] **Step 8：Commit**
```bash
git add src/services/bookingService.js src/services/notifications.js src/server.js tests/booking-edit.test.js tests/booking-edit-api.test.js package.json
git commit -m "feat(calendar): rescheduleBooking/reassignBooking + 端點 + 改期通知模板"
```

---

## Task 3：前端 全部教練選擇器 + renderRegister 全覽

**Files:** Modify `public/coach.js`、`public/style.css`。

**Interfaces:** Consumes `api`/`escapeHtml`/`toast`/`$`/`isAdmin`/`coachQuery`；`GET /api/coach/week`。Produces 登錄分頁全覽 + 預約格可點 `openBookingEditModal(booking)`（Task 4 實作；本任務先 stub）。

- [ ] **Step 1：`coach.js` 加狀態（在 `let regWeekOffset = 0;` 附近）**
```js
let regViewCoachId = 'all'; // 管理者登錄分頁檢視：'all' 或 coachId 字串；一般教練不使用
let regCoachOptionsCache = null; // 教練選單 options HTML 快取（避免每次重繪重撈 /api/admin/coaches）
```

- [ ] **Step 2：`coach.js` `switchTab` 切到 register 時隱藏共用下拉**

把 `switchTab` 內 `if (name === 'register') renderRegister();` 改為：
```js
  if (name === 'register') renderRegister();
  // 登錄分頁用自己的「全部教練」選擇器；隱藏共用下拉避免混淆。共用下拉只給管理者 →
  // 非管理者完全不碰（否則 toggle(class,false) 會把本該隱藏的空下拉顯示出來）。
  const sharedPicker = $('coach-picker');
  if (isAdmin && sharedPicker) sharedPicker.classList.toggle('hidden', name === 'register');
```

- [ ] **Step 3：`coach.js` 重寫 `renderRegister`（整段替換 514-574 行）**
```js
async function renderRegister() {
  const panel = $('tab-register');
  const { start, dates } = regWeekRange(regWeekOffset);
  // 工具列（管理者多一個「全部教練」選擇器）
  let pickerHtml = '';
  if (isAdmin) {
    pickerHtml = `<select id="reg-coach-picker" class="border rounded p-1 text-sm" style="width:auto;"></select>`;
  }
  panel.innerHTML = `
    <div class="reg-toolbar">
      <button id="reg-prev" class="btn-secondary reg-navbtn">← 上一週</button>
      <button id="reg-today" class="btn-secondary reg-navbtn">本週</button>
      <button id="reg-next" class="btn-secondary reg-navbtn">下一週 →</button>
      ${pickerHtml}
      <span id="reg-range" class="reg-range"></span>
    </div>
    <div id="reg-grid" class="reg-grid-wrap"><p class="subtle">載入中…</p></div>`;
  $('reg-prev').onclick = () => { regWeekOffset--; renderRegister(); };
  $('reg-next').onclick = () => { regWeekOffset++; renderRegister(); };
  $('reg-today').onclick = () => { regWeekOffset = 0; renderRegister(); };
  $('reg-range').textContent = `${dates[0].slice(5).replace('-', '/')} – ${dates[6].slice(5).replace('-', '/')}`;

  // 管理者：填充教練選擇器（全部教練 + 各 active coach）
  if (isAdmin) {
    const picker = $('reg-coach-picker');
    if (!regCoachOptionsCache) {
      let opts = '<option value="all">全部教練</option>';
      try {
        const all = await api('/api/admin/coaches');
        opts += all.filter(c => c.is_active).map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
      } catch {}
      regCoachOptionsCache = opts;
    }
    picker.innerHTML = regCoachOptionsCache;
    picker.value = regViewCoachId;
    picker.onchange = () => { regViewCoachId = picker.value; renderRegister(); };
  }

  // 取週資料
  let data;
  try {
    let url;
    if (isAdmin) url = `/api/coach/week?all=1&start=${start}` + (regViewCoachId !== 'all' ? `&coachId=${regViewCoachId}` : '');
    else url = `/api/coach/week?start=${start}`;
    data = await api(url);
  } catch (e) { $('reg-grid').innerHTML = `<p class="subtle" style="color:#dc2626;">載入失敗：${escapeHtml(e.message)}</p>`; return; }

  const slotKey = (iso) => iso.slice(0, 13);
  // 多教練同格 → 陣列
  const bookByKey = new Map(); for (const b of data.bookings || []) { const k = slotKey(b.start_at); (bookByKey.get(k) || bookByKey.set(k, []).get(k)).push(b); }
  const grpByKey = new Map(); for (const g of data.groupSessions || []) { const k = slotKey(g.start_at); (grpByKey.get(k) || grpByKey.set(k, []).get(k)).push(g); }
  const avail = new Set((data.availableSlots || []).map(s => slotKey(s.start)));
  const isAll = isAdmin && regViewCoachId === 'all';
  const targetCoachId = isAdmin ? (regViewCoachId !== 'all' ? Number(regViewCoachId) : null) : null;
  const canRegister = !isAdmin || targetCoachId != null;

  // 動態時段
  const hourOf = (iso) => Number(String(iso).slice(11, 13));
  let hMin = REG_HOUR_MIN, hMax = REG_HOUR_MAX;
  for (const b of data.bookings || []) { hMin = Math.min(hMin, hourOf(b.start_at)); hMax = Math.max(hMax, hourOf(b.start_at)); }
  for (const g of data.groupSessions || []) { hMin = Math.min(hMin, hourOf(g.start_at)); hMax = Math.max(hMax, hourOf(g.start_at)); }
  for (const s of data.availableSlots || []) { hMin = Math.min(hMin, hourOf(s.start)); hMax = Math.max(hMax, hourOf(s.start)); }
  const hours = []; for (let h = hMin; h <= hMax; h++) hours.push(h);

  const head = `<div class="reg-cell reg-head reg-timecol"></div>` +
    dates.map((d, i) => `<div class="reg-cell reg-head">${REG_DOW[i]}<br><span class="reg-date">${d.slice(5).replace('-', '/')}</span></div>`).join('');
  let rows = '';
  for (const h of hours) {
    const hh = String(h).padStart(2, '0');
    rows += `<div class="reg-cell reg-timecol">${hh}:00</div>`;
    for (const d of dates) {
      const iso = `${d}T${hh}:00:00`; const key = `${d}T${hh}`;
      const bks = bookByKey.get(key) || []; const gps = grpByKey.get(key) || [];
      if (bks.length || gps.length) {
        let inner = bks.map(b => {
          const tag = b.session_type === '1on2' ? '1對2' : '1對1';
          const other = targetCoachId != null && b.coach_id !== targetCoachId;
          const coachLbl = (isAll || other) ? `<span class="reg-sub">· ${escapeHtml(b.coach_name || '')}</span>` : '';
          return `<div class="reg-bk${other ? ' reg-booked-other' : ''}" data-bk="${b.id}">${escapeHtml(b.member_name)} <span class="reg-sub">${tag}</span>${coachLbl}</div>`;
        }).join('');
        inner += gps.map(g => `<div class="reg-gp">${escapeHtml(g.name)} <span class="reg-sub">團課${isAll ? '· ' + escapeHtml(g.coach_name || '') : ''}</span></div>`).join('');
        rows += `<div class="reg-cell reg-multi">${inner}</div>`;
      } else {
        const cls = (canRegister && avail.has(key)) ? 'reg-open reg-avail' : 'reg-open';
        rows += `<div class="reg-cell ${cls}" data-slot="${iso}">＋</div>`;
      }
    }
  }
  $('reg-grid').innerHTML = `<div class="reg-grid">${head}${rows}</div>`;
  // 空格登錄
  $('reg-grid').querySelectorAll('.reg-open[data-slot]').forEach(c => c.addEventListener('click', () => {
    if (!canRegister) { toast('請先於上方選擇要登錄的教練', 'error'); return; }
    openRegisterModal(c.dataset.slot);
  }));
  // 預約格 → 編輯
  $('reg-grid').querySelectorAll('.reg-bk[data-bk]').forEach(c => c.addEventListener('click', () => {
    const all = data.bookings.find(b => b.id === Number(c.dataset.bk));
    if (all) openBookingEditModal(all);
  }));
}

// Task 4 取代；先 stub 避免 ReferenceError
function openBookingEditModal(booking) { console.log('[edit] booking', booking.id); }
```

- [ ] **Step 4：`coach.js` 登錄目標教練改用 reg-coach-picker**

新增 helper（放在 `withCoach` 之後或 regm 區）：
```js
// 登錄/預覽目標教練：管理者用登錄分頁選的（非 all）；一般教練落回自己（後端 resolveCoach）
function regTargetBody(body) {
  return (isAdmin && regViewCoachId && regViewCoachId !== 'all') ? { ...body, coachId: Number(regViewCoachId) } : body;
}
```
把 `doRegmPreview` 內 `body: withCoach({ memberId: ... })` 改為 `body: regTargetBody({ memberId: regmCustomer.id, packageId: regmPackageId, startAt: regmSlot, recurrence: buildRecurrence() })`；`doRegmSubmit` 內同樣的 `withCoach(...)` 改為 `regTargetBody(...)`（兩處 register/preview body）。

- [ ] **Step 5：`public/style.css` 末尾加樣式**
```css
.reg-multi{align-items:stretch;gap:2px;padding:2px;}
.reg-bk{background:#dbeafe;color:#1e3a8a;font-size:11px;border-radius:4px;padding:2px 4px;cursor:pointer;text-align:left;width:100%;}
.reg-bk:hover{background:#bfdbfe;}
.reg-booked-other{background:#eef2f7;color:#64748b;}
.reg-booked-other:hover{background:#e2e8f0;}
.reg-gp{background:#f3e8ff;color:#6b21a8;font-size:11px;border-radius:4px;padding:2px 4px;text-align:left;width:100%;}
```
（移除/取代既有 `.reg-booked`/`.reg-group` 規則亦可；新類別 `.reg-bk`/`.reg-gp`/`.reg-multi` 取代之。）

- [ ] **Step 6：驗證** `node --check public/coach.js`（無語法錯）。

- [ ] **Step 7：Commit**
```bash
git add public/coach.js public/style.css
git commit -m "feat(calendar): 登錄分頁 全部教練全覽 + 預約格可點（管理者看全部、教練看自己）"
```

---

## Task 4：前端 預約編輯彈窗（取消/改時段/改客人方案）

**Files:** Modify `public/coach.html`、`public/coach.js`、`public/style.css`。

**Interfaces:** Consumes `api`/`escapeHtml`/`toast`/`$`/`isAdmin`；`DELETE /api/bookings/:id`、`PATCH /api/coach/bookings/:id/reschedule`、`.../reassign`、`GET /api/coach/customers/search`、`GET /api/coach/packages?memberId=`。取代 Task 3 的 `openBookingEditModal` stub。

- [ ] **Step 1：`coach.html` 在既有 `#regm-overlay` 區塊之後（`<script src="/coach.js">` 之前）加編輯彈窗骨架**（與既有彈窗放一起，維持慣例）
```html
<div id="bkedit-overlay" class="regm-overlay" style="display:none;">
  <div class="regm-modal" role="dialog" aria-modal="true">
    <button id="bkedit-close" class="regm-close" aria-label="關閉">✕</button>
    <h3 class="regm-title">編輯預約</h3>
    <div id="bkedit-body"></div>
  </div>
</div>
```

- [ ] **Step 2：`coach.js` 先刪除 Task 3 的 stub 兩行**
```js
// Task 4 取代；先 stub 避免 ReferenceError
function openBookingEditModal(booking) { console.log('[edit] booking', booking.id); }
```
**再插入**實作（同位置）：
```js
let bkeditBooking = null;
function bkeditClose() { $('bkedit-overlay').style.display = 'none'; bkeditBooking = null; }

function openBookingEditModal(booking) {
  bkeditBooking = booking;
  const ov = $('bkedit-overlay'); ov.style.display = 'grid';
  $('bkedit-close').onclick = bkeditClose;
  ov.onclick = (e) => { if (e.target === ov) bkeditClose(); };
  renderBkeditBody();
}

function bkSlotLabel(iso) { return String(iso).slice(0, 16).replace('T', ' ').replace(/-/g, '/'); }

function renderBkeditBody() {
  const b = bkeditBooking;
  const tag = b.session_type === '1on2' ? '1對2' : '1對1';
  const source = b.package_id ? '方案登錄' : (b.discount_code ? `折扣碼 ${escapeHtml(b.discount_code)}` : '一般預約');
  const paid = b.paid_at ? '已核對' : '待核對';
  const body = $('bkedit-body');
  body.innerHTML = `
    <div class="bke-detail">
      <div><b>客人：</b>${escapeHtml(b.member_name)}</div>
      <div><b>教練：</b>${escapeHtml(b.coach_name || '')}</div>
      <div><b>時段：</b>${bkSlotLabel(b.start_at)}（${tag}）</div>
      <div><b>付款：</b>${paid}　<b>來源：</b>${source}</div>
    </div>
    <div class="bke-actions">
      <button id="bke-resched-btn" class="btn-secondary">改時段</button>
      <button id="bke-reassign-btn" class="btn-secondary">改客人/方案</button>
      <button id="bke-cancel-btn" class="btn-danger">取消預約</button>
    </div>
    <div id="bke-panel"></div>`;
  $('bke-cancel-btn').onclick = doBkCancel;
  $('bke-resched-btn').onclick = renderBkResched;
  $('bke-reassign-btn').onclick = renderBkReassign;
}

async function doBkCancel() {
  const b = bkeditBooking;
  if (!confirm(`確定取消「${b.member_name}」${bkSlotLabel(b.start_at)} 的預約？${b.package_id ? '（將回補 1 堂方案）' : ''}`)) return;
  try {
    // 管理者取消他教練的預約：帶該預約 coach_id 走 adminOnBehalf；本人取消自己不需。
    const qs = isAdmin ? `?coachId=${b.coach_id}` : '';
    await api(`/api/bookings/${b.id}${qs}`, { method: 'DELETE', body: { reason: '後台取消' } });
    toast('已取消預約', 'success'); bkeditClose(); renderRegister();
  } catch (e) { toast(`取消失敗：${e.data?.error || e.message}`, 'error'); }
}

function renderBkResched() {
  const b = bkeditBooking;
  const day = String(b.start_at).slice(0, 10);
  const hours = []; for (let h = 6; h <= 22; h++) hours.push(String(h).padStart(2, '0'));
  $('bke-panel').innerHTML = `
    <div class="bke-sub">改到：</div>
    <div class="bke-row">
      <input id="bke-date" type="date" class="form-input" value="${day}" />
      <select id="bke-hour" class="form-select">${hours.map(h => `<option value="${h}" ${String(b.start_at).slice(11,13)===h?'selected':''}>${h}:00</option>`).join('')}</select>
      <button id="bke-resched-go" class="btn-primary">確認改期</button>
    </div>`;
  $('bke-resched-go').onclick = async () => {
    const startAt = `${$('bke-date').value}T${$('bke-hour').value}:00:00`;
    try {
      await api(`/api/coach/bookings/${b.id}/reschedule`, { method: 'PATCH', body: { startAt } });
      toast('已改期', 'success'); bkeditClose(); renderRegister();
    } catch (e) { const m = { slot_taken: '該時段已被預約', forbidden: '無權限', invalid_start_at: '時間格式錯' }; toast(m[e.data?.error] || `改期失敗：${e.message}`, 'error'); }
  };
}

function renderBkReassign() {
  const b = bkeditBooking;
  let picked = null; // {id,name,phone}
  $('bke-panel').innerHTML = `
    <div class="bke-sub">改指定客人/方案：</div>
    <input id="bke-search" class="form-input" placeholder="搜尋客人姓名或電話…" autocomplete="off" />
    <div id="bke-results" class="regm-results"></div>
    <div id="bke-pkg"></div>`;
  const search = $('bke-search'); let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t); const q = search.value.trim();
    if (!q) { $('bke-results').innerHTML = ''; return; }
    t = setTimeout(async () => {
      try {
        const list = await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`);
        $('bke-results').innerHTML = list.length ? list.map(u => `<div class="regm-result" data-id="${u.id}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('') : '<div class="regm-sub" style="padding:6px;">查無客人</div>';
        $('bke-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', async () => {
          picked = list.find(u => u.id === Number(r.dataset.id));
          $('bke-results').innerHTML = ''; search.value = picked.name;
          const all = await api(`/api/coach/packages?memberId=${picked.id}`);
          const valid = all.filter(p => p.is_valid);
          if (!valid.length) { $('bke-pkg').innerHTML = '<div class="regm-sub" style="color:#b45309;">此客人沒有可用方案，請先於會員管理或登錄彈窗開方案。</div>'; return; }
          const PT = { '1on1': '一對一', '1on2': '一對二' };
          $('bke-pkg').innerHTML = `<select id="bke-pkgsel" class="form-select">${valid.map(p => `<option value="${p.id}">${PT[p.session_type] || escapeHtml(p.session_type)}・剩 ${escapeHtml(String(p.remaining_sessions))}/${escapeHtml(String(p.total_sessions))}</option>`).join('')}</select><button id="bke-reassign-go" class="btn-primary" style="margin-top:6px;">確認改指定</button>`;
          $('bke-reassign-go').onclick = async () => {
            try {
              await api(`/api/coach/bookings/${b.id}/reassign`, { method: 'PATCH', body: { memberId: picked.id, packageId: Number($('bke-pkgsel').value) } });
              toast('已改指定客人/方案', 'success'); bkeditClose(); renderRegister();
            } catch (e) { const m = { package_invalid: '方案已失效/用罄', package_member_mismatch: '方案不屬此客人', package_depleted: '方案堂數不足', forbidden: '無權限' }; toast(m[e.data?.error] || `失敗：${e.message}`, 'error'); }
          };
        }));
      } catch (e) { $('bke-results').innerHTML = `<div class="regm-sub" style="color:#dc2626;padding:6px;">${escapeHtml(e.message)}</div>`; }
    }, 250);
  });
}
```

- [ ] **Step 3：`public/style.css` 末尾加樣式**
```css
.bke-detail{font-size:13px;line-height:1.7;margin-bottom:12px;}
.bke-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;}
.bke-sub{font-size:13px;font-weight:600;margin:8px 0 4px;}
.bke-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
```

- [ ] **Step 4：驗證** `node --check public/coach.js`；`grep -c "function openBookingEditModal" public/coach.js` 應為 1。

- [ ] **Step 5：Commit**
```bash
git add public/coach.html public/coach.js public/style.css
git commit -m "feat(calendar): 預約編輯彈窗（取消/改時段/改客人方案）"
```

---

## Self-Review（plan 作者自檢）
**Spec 覆蓋**：可見範圍（Task1 後端 all + Task3 前端 reg-coach-picker/全覽/淡色他教練）、編輯三操作（Task2 reschedule/reassign + 既有 DELETE 取消；Task4 彈窗）、範圍＝所有一對一（reschedule/reassign 對任何 booking；非方案 reassign 轉方案）、權限（service !isAdmin 驗本人；all 僅管理者；前端他教練格仍可點但後端把關）。
**Placeholder**：Task4 stub 明確「先刪再插」；Task2 unit 測試已清為乾淨版（頂部一次 import `createPackage,getPackage,deductOne`，reschedule×3 + reassign×4，無 placeholder）。
**型別一致**：getCoachWeek 回 `bookings[].{coach_id,coach_name,paid_at,discount_code,...}` ↔ Task3 渲染（coach_name 標籤、reg-bk data-bk）↔ Task4 編輯彈窗（b.coach_id 取消、b.package_id/discount_code/paid_at 顯示來源）一致。reschedule/reassign 簽章 Task2 定義 ↔ Task2 端點 ↔ Task4 呼叫一致。`regTargetBody`（Task3）取代 regm 的 `withCoach`，登錄目標＝regViewCoachId。
**待最終審查特別看**：(a) reassign 退舊→扣新→rollback 的堂數一致；(c) Task3 `bookByKey` 陣列累加寫法 `(map.get(k)||map.set(k,[]).get(k)).push(b)` 正確性；(d) 管理者全覽他教練格 `reg-booked-other` 仍可點編輯、空格全覽時不可登錄（toast）。
