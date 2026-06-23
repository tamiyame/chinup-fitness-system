# PR2：週曆登錄預約介面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 教練後台新增「登錄預約」分頁：週一~日×整點週曆 → 點時段彈窗 → 搜尋客人 → 選方案 → 登錄（單筆或進階循環），從方案扣堂並自動標記已核對。

**Architecture:** 後端用 PR1 的 `packageService`（`deductOne`/`listValidPackagesForMember`/`getPackage`）+ 既有 `createBookingCore`（新增 `enforceAvailability` 旁路）建立 package-backed 預約；新 `expandRecurrence` 純函式展開 Google 行事曆式循環；新 4 個 `requireCoach` 端點（週彙整/客人搜尋/登錄預覽/登錄）。前端在 `coach.html`/`coach.js` 加分頁、週曆格、登錄彈窗。

**Tech Stack:** Node ESM、Express、`node:sqlite`；前端 vanilla JS（`public/app.js` 提供 `api`/`escapeHtml`）。

## Global Constraints

- 例外 `throw new ApiError(status, code)`（`./registration.js`）。交易 `tx(fn)`；時間 `nowLocal()`（`'YYYY-MM-DDTHH:MM:SS'`）。
- 預約時間格式 `START_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/`（整點：分鐘須為 00；登錄一律整點）。
- **登錄一律經有效方案**：類型須等於 `package.session_type`；方案無效/類型不符/堂數不足 → 後端擋（即使前端被繞過）。
- **任意時段**：`createBookingCore({..., enforceAvailability:false})` 跳過 `assertBookableTx`（班表/容量），僅靠 `bookings_coach_start_confirmed` UNIQUE index 擋同教練同整點（→ 409 `slot_taken`）。登錄前在 tx 內先查衝突避免先扣後失敗。
- **循環**：衝突場次跳過（不扣）；方案用罄即停（不再建立）；整批以 `recurring_group_id` 串（= 首筆 id）。
- package-backed 預約：寫 `package_id`、`paid_at=nowLocal()`、`paid_by=actorId`、`original_amount = amount==null?null:round(amount/total_sessions)`，discount 欄 NULL（沿用 `createBookingAnon` 的「建立後 UPDATE」樣式）。
- 所有端點 `requireCoach`，代選教練沿用 `resolveCoach`（GET 走 `?coachId=`、POST 走 body `coachId`）。
- 後置副作用 `syncBookingCreate(id)` 在 route 層 tx commit 後呼叫（不 await）。
- 測試：unit 掛 `test`、api 掛 `test:api`（需起 server，`LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1`）；`expect()` 不 throw → 掃 `✗`。`npm test` 清 demo 資料，預覽前重 seed（收尾處理）。
- 繁體中文 UI。

---

## File Structure

- `src/services/bookingService.js` — 改 `createBookingCore`（加 `enforceAvailability`）；新增 `expandRecurrence`（純函式，匯出）、`previewCoachRegister`、`createCoachRegister`（import `deductOne`/`getPackage` from packageService；不需 `listValidPackagesForMember`——前端用 PR1 端點列方案）。
- `src/services/coachCalendarService.js`（新）— `getCoachWeek({coachId, start})`（彙整 bookings + group sessions + availableSlots）、`searchCustomers(q)`。
- `src/server.js` — 4 端點（week / customers/search / register/preview / register）。
- `public/coach.html` — 新分頁鈕 + `#tab-register` 區塊 + 登錄彈窗骨架。
- `public/coach.js` — `renderRegister()` 週曆 + 導覽 + 彈窗（搜尋/方案/開方案/循環/預覽/送出）。
- `public/style.css` — 週曆格與彈窗樣式（`.reg-*`）。
- 測試：`tests/recurrence-expand.test.js`、`tests/coach-register.test.js`（unit）；`tests/coach-register-api.test.js`（api）。

---

## Task 1：createBookingCore 旁路 + expandRecurrence 純函式

**Files:**
- Modify: `src/services/bookingService.js`
- Create: `tests/recurrence-expand.test.js`
- Modify: `package.json`（`test` 加新檔）

**Interfaces:**
- Produces:
  - `createBookingCore({ coach, memberId, startAt, note, sessionType, silent, enforceAvailability=true })` — `enforceAvailability:false` 時跳過 `assertBookableTx`（仍保留 UNIQUE→slot_taken）。
  - `expandRecurrence({ startAt, frequency, interval=1, byWeekday=null, end }) → [{ startAt, reason? }]`（chronological；`reason:'no_date'` 表該月/年無此日）。`frequency∈{daily,weekly,monthly,yearly}`；`byWeekday` 為 `[0..6]`（0=日）僅 weekly 用；`end={type:'count',count}|{type:'date',date}`。

- [ ] **Step 1：改 `createBookingCore` 加 `enforceAvailability`**

把（bookingService.js ~79）：
```js
function createBookingCore({ coach, memberId, startAt, note, sessionType = '1on1', silent = false }) {
  const endAt = addMinutes(startAt, 60);
  // 同教練重疊 / 全店容量（tx 內、純 DB → 無競態）。UNIQUE index 仍為最後兜底。
  assertBookableTx({ coachId: coach.id, startAt, endAt, units: sessionType === '1on2' ? 2 : 1 });
```
改為：
```js
function createBookingCore({ coach, memberId, startAt, note, sessionType = '1on1', silent = false, enforceAvailability = true }) {
  const endAt = addMinutes(startAt, 60);
  // 同教練重疊 / 全店容量（tx 內、純 DB → 無競態）。UNIQUE index 仍為最後兜底。
  // enforceAvailability=false（員工手動登錄）：跳過班表/容量檢查，允許任意整點；
  // 仍靠 INSERT 的 UNIQUE(coach_id,start_at) 擋同教練同整點重複。
  if (enforceAvailability) {
    assertBookableTx({ coachId: coach.id, startAt, endAt, units: sessionType === '1on2' ? 2 : 1 });
  }
```

- [ ] **Step 2：在 `tests/recurrence-expand.test.js` 寫失敗測試**

```js
// expandRecurrence 純函式：每天/週/月/年、自訂間隔、週幾、結束(count/date)、no_date、上限。
import assert from 'node:assert/strict';
const { expandRecurrence } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[recurrence-expand test] start');
const days = (arr) => arr.map(o => o.startAt);

expect('daily count=3', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-02T10:00:00','2026-07-03T10:00:00']);
});
expect('daily interval=2 count=3', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', interval:2, end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-03T10:00:00','2026-07-05T10:00:00']);
});
expect('weekly count=3（同星期）', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'weekly', end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-08T10:00:00','2026-07-15T10:00:00']);
});
expect('weekly byWeekday 一三五（2026-07-01 為週三）count=4', () => {
  // 1=一,3=三,5=五；自起始日當週起，每週的 一三五（>=起始日）
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'weekly', byWeekday:[1,3,5], end:{type:'count',count:4} });
  // 2026-07-01(三),07-03(五),07-06(一),07-08(三)
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-03T10:00:00','2026-07-06T10:00:00','2026-07-08T10:00:00']);
});
expect('weekly byWeekday interval=2（每兩週一三五）', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'weekly', interval:2, byWeekday:[1,3,5], end:{type:'count',count:4} });
  // 第0週(07/01三起):07-01,07-03 → 跳過第1週 → 第2週(07/13一起):07-13,07-15
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-03T10:00:00','2026-07-13T10:00:00','2026-07-15T10:00:00']);
});
expect('monthly count=3（同日）', () => {
  const o = expandRecurrence({ startAt:'2026-01-15T09:00:00', frequency:'monthly', end:{type:'count',count:3} });
  assert.deepEqual(days(o), ['2026-01-15T09:00:00','2026-02-15T09:00:00','2026-03-15T09:00:00']);
});
expect('monthly 31 日 → 2/4/6 月 no_date', () => {
  const o = expandRecurrence({ startAt:'2026-01-31T09:00:00', frequency:'monthly', end:{type:'count',count:3} });
  assert.equal(o[0].reason, undefined);
  assert.equal(o[1].reason, 'no_date'); // 2026-02-31 不存在
});
expect('yearly count=2', () => {
  const o = expandRecurrence({ startAt:'2026-03-01T09:00:00', frequency:'yearly', end:{type:'count',count:2} });
  assert.deepEqual(days(o), ['2026-03-01T09:00:00','2027-03-01T09:00:00']);
});
expect('yearly 2/29 閏年 → 平年 no_date', () => {
  const o = expandRecurrence({ startAt:'2028-02-29T09:00:00', frequency:'yearly', end:{type:'count',count:2} });
  assert.equal(o[1].reason, 'no_date'); // 2029-02-29 不存在
});
expect('end=date（含當日）', () => {
  const o = expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'date',date:'2026-07-03'} });
  assert.deepEqual(days(o), ['2026-07-01T10:00:00','2026-07-02T10:00:00','2026-07-03T10:00:00']);
});
expect('驗證：頻率錯/間隔錯/end 錯/count 越界', () => {
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'x', end:{type:'count',count:2} }), /invalid_frequency/);
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', interval:0, end:{type:'count',count:2} }), /invalid_interval/);
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'count',count:0} }), /invalid_count/);
  assert.throws(() => expandRecurrence({ startAt:'2026-07-01T10:00:00', frequency:'daily', end:{type:'bad'} }), /invalid_end/);
  assert.throws(() => expandRecurrence({ startAt:'bad', frequency:'daily', end:{type:'count',count:2} }), /invalid_start_at/);
});
console.log('[recurrence-expand test] done');
```

- [ ] **Step 3：跑測試確認失敗（expandRecurrence 未定義）**

Run: `node tests/recurrence-expand.test.js` → 失敗（not a function）。

- [ ] **Step 4：在 `bookingService.js` 新增 `expandRecurrence`（放在既有 `recurringOccurrences` 之後）**

```js
// ── 2026-06-24 進階循環（Google 行事曆式；PR2 登錄用，獨立於舊 recurringOccurrences）──
const REC_FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const REC_MAX_OCCURRENCES = 366; // 上限保護（含 no_date）

/** 展開循環為 occurrence 清單（chronological）。
 *  rule: { frequency, interval=1, byWeekday=[0..6]|null（0=日，僅 weekly）, end:{type:'count',count}|{type:'date',date} }
 *  monthly/yearly 遇無此日 → { startAt, reason:'no_date' }（不順延）。count 計入 no_date。 */
export function expandRecurrence({ startAt, frequency, interval = 1, byWeekday = null, end }) {
  if (typeof startAt !== 'string' || !START_AT_RE.test(startAt)) throw new ApiError(400, 'invalid_start_at');
  if (!REC_FREQS.includes(frequency)) throw new ApiError(400, 'invalid_frequency');
  const iv = Number(interval);
  if (!Number.isInteger(iv) || iv < 1 || iv > 52) throw new ApiError(400, 'invalid_interval');
  if (!end || (end.type !== 'count' && end.type !== 'date')) throw new ApiError(400, 'invalid_end');
  let maxCount = REC_MAX_OCCURRENCES, endDate = null;
  if (end.type === 'count') {
    maxCount = Number(end.count);
    if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > REC_MAX_OCCURRENCES) throw new ApiError(400, 'invalid_count');
  } else {
    endDate = end.date;
    if (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new ApiError(400, 'invalid_end_date');
  }
  const [datePart, timePart] = startAt.split('T'); // timePart='HH:MM:00'
  const [y0, m0, d0] = datePart.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const within = (label) => (endDate ? label.slice(0, 10) <= endDate : true);
  const out = [];
  const push = (label, reason) => { out.push(reason ? { startAt: label, reason } : { startAt: label }); };

  if (frequency === 'daily' || (frequency === 'weekly' && !byWeekday)) {
    const stepDays = frequency === 'daily' ? iv : iv * 7;
    for (let k = 0; out.length < maxCount; k++) {
      const d = new Date(`${datePart}T00:00:00`);
      d.setDate(d.getDate() + stepDays * k);
      const label = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${timePart}`;
      if (!within(label)) break;
      push(label);
      if (k > REC_MAX_OCCURRENCES) break;
    }
  } else if (frequency === 'weekly') {
    // byWeekday：以「起始日當週的週一」為 anchor，每 iv 週為一個 block，block 內取選定週幾(>=起始日)。
    const wd = [...new Set(byWeekday)].filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort((a, b) => a - b);
    if (!wd.length) throw new ApiError(400, 'invalid_byweekday');
    const start = new Date(`${datePart}T00:00:00`);
    const dow = start.getDay(); // 0=日
    const toMonday = dow === 0 ? -6 : 1 - dow;
    const anchorMonday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + toMonday);
    for (let b = 0; out.length < maxCount; b++) {
      const blockMonday = new Date(anchorMonday.getFullYear(), anchorMonday.getMonth(), anchorMonday.getDate() + b * iv * 7);
      let pushedBeyondEnd = false;
      for (const d of wd) {
        const offset = d === 0 ? 6 : d - 1; // 週一=0 … 週日=6
        const date = new Date(blockMonday.getFullYear(), blockMonday.getMonth(), blockMonday.getDate() + offset);
        if (date < start) continue; // 第一個 block 內早於起始日的略過
        const label = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${timePart}`;
        if (!within(label)) { pushedBeyondEnd = true; break; }
        push(label);
        if (out.length >= maxCount) break;
      }
      if (pushedBeyondEnd) break;
      if (b > REC_MAX_OCCURRENCES) break;
    }
  } else { // monthly / yearly
    for (let k = 0; out.length < maxCount; k++) {
      let y, m;
      if (frequency === 'monthly') { const t = (m0 - 1) + iv * k; y = y0 + Math.floor(t / 12); m = (t % 12) + 1; }
      else { y = y0 + iv * k; m = m0; }
      const probe = new Date(y, m - 1, d0);
      const label = `${y}-${pad(m)}-${pad(d0)}T${timePart}`;
      if (!within(label)) break;
      if (probe.getMonth() !== m - 1) push(label, 'no_date'); // 該月/年無此日
      else push(label);
      if (k > REC_MAX_OCCURRENCES) break;
    }
  }
  return out.slice(0, maxCount);
}
```

- [ ] **Step 5：跑測試確認通過**

Run: `node tests/recurrence-expand.test.js` → 全 `✓`、0 `✗`。

- [ ] **Step 6：掛進 `package.json` 的 `test`（末尾加 `&& node tests/recurrence-expand.test.js`）**

- [ ] **Step 7：Commit**

```bash
git add src/services/bookingService.js tests/recurrence-expand.test.js package.json
git commit -m "feat(register): createBookingCore enforceAvailability 旁路 + expandRecurrence 純函式"
```

---

## Task 2：登錄 service（previewCoachRegister / createCoachRegister）

**Files:**
- Modify: `src/services/bookingService.js`（import packageService；新增兩函式）
- Create: `tests/coach-register.test.js`
- Modify: `package.json`（`test` 加新檔）

**Interfaces:**
- Consumes: `expandRecurrence`、`createBookingCore`、`getCoachStmt`、`getUserNameStmt`、`notify`、`fmtDateForLine`、`tx`、`nowLocal`、`ApiError`；`deductOne`/`getPackage`（packageService）。
- **刻意決策**：登錄不檢查 `coach.is_active`（管理者代選可對任一可解析教練補登/排課，含未啟用教練；沿用 admin-backfill 精神，異於 createBookingAnon 的 coach_inactive 擋）。`no_date` 為 spec 三狀態(ok/conflict/depleted)外的第 4 狀態（monthly/yearly 無此日，前端有對應標籤）。
- Produces:
  - `previewCoachRegister({ coachId, memberId, packageId, startAt, recurrence }) → { occurrences:[{startAt,status}], willCreate, willDeduct, remainingAfter }`（status∈ok/conflict/no_date/depleted）。不寫入。
  - `createCoachRegister({ coachId, memberId, packageId, startAt, recurrence, actorId }) → { created:[{id,startAt}], skipped:[{startAt,reason}], groupId|null, deducted, remainingAfter }`。

- [ ] **Step 1：在 `bookingService.js` import 區加** `import { deductOne as pkgDeductOne, getPackage as pkgGetPackage } from './packageService.js';`（與既有 `refundOne as refundPackageOne` 同檔，合併同一行亦可）。

- [ ] **Step 2：在 `tests/coach-register.test.js` 寫失敗測試**

```js
// 登錄 service：單筆扣堂+自動已核對+package_id+original_amount；循環用罄即停；衝突跳過；類型/方案守門。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { createPackage, getPackage } = await import('../src/services/packageService.js');
const { previewCoachRegister, createCoachRegister } = await import('../src/services/bookingService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[coach-register test] start');
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM coaches WHERE display_name LIKE 'reg-%'; DELETE FROM users WHERE email LIKE 'reg-%'");
const pad = n => String(n).padStart(2,'0');
const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('reg教練','reg-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'reg-coach', 1)").run(cuid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('reg客','reg-m@x.com','user','0971000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('reg管','reg-a@x.com','coach',1)").run().lastInsertRowid);
// 未來日期（避免與既有衝突）
const base = new Date(Date.now()+10*86400000);
const D = `${base.getFullYear()}-${pad(base.getMonth()+1)}-${pad(base.getDate())}`;

expect('單筆登錄：扣 1 堂、自動已核對、寫 package_id/original_amount', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:10, amount:15000 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T09:00:00`, recurrence:null, actorId: admin });
  assert.equal(r.created.length, 1);
  assert.equal(getPackage(p.id).remaining_sessions, 9);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.created[0].id);
  assert.equal(b.package_id, p.id);
  assert.ok(b.paid_at); assert.equal(b.paid_by, admin);
  assert.equal(b.session_type, '1on1');
  assert.equal(b.original_amount, 1500); // 15000/10
});
expect('不存在方案 → 404 package_not_found', () => {
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: 999999, startAt:`${D}T11:00:00`, recurrence:null, actorId: admin }), /package_not_found/);
});
expect('session_type 由方案決定（1on2 方案 → 預約 1on2）', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on2', totalSessions:5 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T11:00:00`, recurrence:null, actorId: admin });
  assert.equal(db.prepare('SELECT session_type FROM bookings WHERE id=?').get(r.created[0].id).session_type, '1on2');
});
expect('方案不屬該客人 → 擋', () => {
  const other = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('reg別','reg-x@x.com','user','0971000099')").run().lastInsertRowid);
  const p = createPackage({ memberId: other, sessionType:'1on1', totalSessions:5 });
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T12:00:00`, recurrence:null, actorId: admin }), /package_member_mismatch|invalid_package/);
});
expect('循環：方案剩餘不足 → 只建立到用罄為止', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:2 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T14:00:00`,
    recurrence:{ frequency:'daily', end:{type:'count',count:5} }, actorId: admin });
  assert.equal(r.created.length, 2);             // 只建立 2 筆（堂數 2）
  assert.equal(getPackage(p.id).remaining_sessions, 0);
  assert.ok(r.created.every(c => c)); 
  const grp = db.prepare('SELECT recurring_group_id FROM bookings WHERE id=?').get(r.created[0].id).recurring_group_id;
  assert.equal(grp, r.created[0].id);            // group = 首筆
});
expect('循環：衝突場次跳過不扣', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:5 });
  // 先佔一個未來時段（同教練），讓循環第二筆衝突
  const clashDay = new Date(Date.now()+20*86400000); const CD = `${clashDay.getFullYear()}-${pad(clashDay.getMonth()+1)}-${pad(clashDay.getDate())}`;
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(coachId, admin, `${CD}T08:00:00`, `${CD}T09:00:00`);
  const nextDay = new Date(clashDay.getTime()+86400000); const ND = `${nextDay.getFullYear()}-${pad(nextDay.getMonth()+1)}-${pad(nextDay.getDate())}`;
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${CD}T08:00:00`,
    recurrence:{ frequency:'daily', end:{type:'count',count:2} }, actorId: admin });
  // 第1筆衝突跳過、第2筆建立 → 扣 1
  assert.equal(r.skipped.some(s => s.reason==='conflict'), true);
  assert.equal(r.created.length, 1);
  assert.equal(getPackage(p.id).remaining_sessions, 4);
});
expect('preview：標 ok/conflict/depleted，回 willCreate/willDeduct', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:1 });
  const futureDay = new Date(Date.now()+40*86400000); const FD = `${futureDay.getFullYear()}-${pad(futureDay.getMonth()+1)}-${pad(futureDay.getDate())}`;
  const pv = previewCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${FD}T07:00:00`, recurrence:{ frequency:'daily', end:{type:'count',count:3} } });
  assert.equal(pv.occurrences.length, 3);
  assert.equal(pv.occurrences[0].status, 'ok');
  assert.equal(pv.occurrences[1].status, 'depleted'); // 方案只剩 1
  assert.equal(pv.willCreate, 1); assert.equal(pv.willDeduct, 1);
});
db.exec("DELETE FROM notifications; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM coaches WHERE display_name LIKE 'reg-%'; DELETE FROM users WHERE email LIKE 'reg-%'");
console.log('[coach-register test] done');
```

- [ ] **Step 3：跑測試確認失敗（函式未定義）**

Run: `node tests/coach-register.test.js` → 失敗。

- [ ] **Step 4：在 `bookingService.js` 新增兩函式（放在 `expandRecurrence` 之後）**

```js
const getValidPackageForRegister = (packageId, memberId) => {
  const p = pkgGetPackage(packageId);
  if (!p) throw new ApiError(404, 'package_not_found');
  if (p.member_id !== memberId) throw new ApiError(400, 'package_member_mismatch');
  if (!p.is_valid) throw new ApiError(409, 'package_invalid'); // 已作廢/用罄/過期
  return p;
};

const hasConfirmedClash = db.prepare(
  "SELECT 1 FROM bookings WHERE coach_id = ? AND start_at = ? AND status = 'confirmed' LIMIT 1"
);

/** 把 recurrence（null=單筆 / 物件=循環）展開成 occurrence 清單（含 reason）。 */
function _registerOccurrences({ startAt, recurrence }) {
  if (!recurrence) return [{ startAt }];
  return expandRecurrence({ startAt, ...recurrence });
}

/** 預覽：逐場標 ok/conflict/no_date/depleted（依方案剩餘額度）。不寫入。 */
export function previewCoachRegister({ coachId, memberId, packageId, startAt, recurrence = null }) {
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  const p = getValidPackageForRegister(packageId, memberId);
  let budget = p.remaining_sessions;
  const occ = _registerOccurrences({ startAt, recurrence });
  const occurrences = [];
  let willCreate = 0;
  for (const o of occ) {
    if (o.reason === 'no_date') { occurrences.push({ startAt: o.startAt, status: 'no_date' }); continue; }
    if (hasConfirmedClash.get(coachId, o.startAt)) { occurrences.push({ startAt: o.startAt, status: 'conflict' }); continue; }
    if (budget > 0) { budget--; willCreate++; occurrences.push({ startAt: o.startAt, status: 'ok' }); }
    else occurrences.push({ startAt: o.startAt, status: 'depleted' });
  }
  return { occurrences, willCreate, willDeduct: willCreate, remainingAfter: p.remaining_sessions - willCreate };
}

/** 建立登錄預約（單筆/循環，皆走方案）。tx 內：驗方案 → 逐場（衝突跳過、扣堂建立、用罄即停）→ 串 group。 */
export function createCoachRegister({ coachId, memberId, packageId, startAt, recurrence = null, actorId }) {
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  const isRecurring = !!recurrence;
  return tx(() => {
    const p = getValidPackageForRegister(packageId, memberId);
    const sessionType = p.session_type;
    const unitPrice = p.amount != null ? Math.round(p.amount / p.total_sessions) : null;
    const occ = _registerOccurrences({ startAt, recurrence });
    const created = [];
    const skipped = [];
    for (const o of occ) {
      if (o.reason === 'no_date') { skipped.push({ startAt: o.startAt, reason: 'no_date' }); continue; }
      if (hasConfirmedClash.get(coachId, o.startAt)) { skipped.push({ startAt: o.startAt, reason: 'conflict' }); continue; }
      if (!pkgDeductOne(packageId)) break; // 用罄即停
      const r = createBookingCore({ coach, memberId, startAt: o.startAt, note: null, sessionType, silent: isRecurring, enforceAvailability: false });
      db.prepare('UPDATE bookings SET package_id=?, paid_at=?, paid_by=?, original_amount=? WHERE id=?')
        .run(packageId, nowLocal(), actorId, unitPrice, r.id);
      created.push({ id: r.id, startAt: o.startAt });
    }
    if (!created.length) throw new ApiError(409, 'nothing_created', { skipped });
    let groupId = null;
    if (isRecurring) {
      // 多筆才串 group（循環只成 1 筆＝單筆，免群組）
      if (created.length > 1) {
        groupId = created[0].id;
        const ids = created.map(c => c.id); const ph = ids.map(() => '?').join(',');
        db.prepare(`UPDATE bookings SET recurring_group_id = ? WHERE id IN (${ph})`).run(groupId, ...ids);
      }
      // 循環摘要通知（不逐堂轟炸）；created.length>=1 一律發，避免「循環只成 1 筆 → 零通知」。
      const summaryVars = { count: created.length, coach_display_name: coach.display_name,
        member_name: getUserNameStmt.get(memberId)?.name || '', freq_text: '登錄', first_at: fmtDateForLine(created[0].startAt) };
      notify({ userId: memberId, sessionId: null, type: 'booking_recurring_created', vars: summaryVars });
      if (coach.user_id !== actorId) notify({ userId: coach.user_id, sessionId: null, type: 'booking_recurring_created_coach', vars: summaryVars });
    }
    return { created, skipped, groupId, deducted: created.length, remainingAfter: pkgGetPackage(packageId).remaining_sessions };
  });
}
```

> 註：單筆（`isRecurring=false`）時 `createBookingCore(silent:false)` 已對會員/教練/管理者發既有預約通知；循環時逐堂 silent、改發一則摘要。`groupId` 僅在循環且 >1 筆時設。

- [ ] **Step 5：跑測試確認通過**

Run: `node tests/coach-register.test.js` → 全 `✓`、0 `✗`。

- [ ] **Step 6：掛進 `package.json` 的 `test`（末尾加 `&& node tests/coach-register.test.js`）**

- [ ] **Step 7：Commit**

```bash
git add src/services/bookingService.js tests/coach-register.test.js package.json
git commit -m "feat(register): previewCoachRegister/createCoachRegister（扣堂/用罄即停/衝突跳過）"
```

---

## Task 3：端點（週彙整 / 客人搜尋 / 登錄預覽+建立）＋coachCalendarService

**Files:**
- Create: `src/services/coachCalendarService.js`
- Modify: `src/server.js`（import + 4 路由）
- Create: `tests/coach-register-api.test.js`
- Modify: `package.json`（`test:api` 加新檔）

**Interfaces:**
- Produces:
  - `getCoachWeek({ coachId, start }) → { weekStart, bookings:[{id,start_at,end_at,session_type,member_name,package_id}], groupSessions:[{id,start_at,end_at,name}], availableSlots:[{start,remain,past}] }`
  - `searchCustomers(q) → [{ id, name, phone }]`（role='user' 未封存，姓名或電話 LIKE，上限 20）
  - 端點：`GET /api/coach/week`、`GET /api/coach/customers/search`、`POST /api/coach/register/preview`、`POST /api/coach/register`。

- [ ] **Step 1：建立 `src/services/coachCalendarService.js`**

```js
import { db } from '../db/connection.js';
import { ApiError } from './registration.js';
import { computeAvailableSlots } from './availabilityService.js';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const weekBookings = db.prepare(`
  SELECT b.id, b.start_at, b.end_at, b.session_type, b.package_id, u.name AS member_name
  FROM bookings b JOIN users u ON u.id = b.member_id
  WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekGroupSessions = db.prepare(`
  SELECT s.id, s.start_at, s.end_at, t.name
  FROM course_sessions s JOIN course_templates t ON t.id = s.template_id
  WHERE s.coach_id = ? AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  ORDER BY s.start_at ASC
`);

/** 某教練自 start（週一）起 7 天的：個別課預約 + 團課場次 + 班表可預約時段。 */
export function getCoachWeek({ coachId, start }) {
  if (!YYYYMMDD.test(start)) throw new ApiError(400, 'invalid_start');
  const endExclusive = addDays(start, 7); // [start, start+7) 的 00:00
  const lo = `${start}T00:00:00`, hi = `${endExclusive}T00:00:00`;
  const bookings = weekBookings.all(coachId, lo, hi);
  const groupSessions = weekGroupSessions.all(coachId, lo, hi);
  // 班表可預約時段（含過去，供整週底色；reuse 既有邏輯）
  const availableSlots = computeAvailableSlots({ coachId, fromDate: start, toDate: addDays(start, 6), externalBusy: null, includePast: true });
  return { weekStart: start, bookings, groupSessions, availableSlots };
}

const searchCustomersStmt = db.prepare(`
  SELECT id, name, phone FROM users
  WHERE role = 'user' AND archived_at IS NULL AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
  ORDER BY name ASC LIMIT 20
`);
/** 客人搜尋（姓名或電話 LIKE，跳脫 %/_）。只回 id/name/phone。 */
export function searchCustomers(q) {
  const term = String(q || '').trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  return searchCustomersStmt.all(like, like);
}
```

- [ ] **Step 2：在 `src/server.js` 加 import**

(a) `previewCoachRegister`/`createCoachRegister` 來自 bookingService — **併入既有的 bookingService import 區塊**（`server.js:28-43`，`as svc…` 風格），在 `createRecurringBookings as svcCreateRecurring,` 那行之後加：
```js
  previewCoachRegister as svcPreviewRegister,
  createCoachRegister as svcCreateRegister,
```
(b) coachCalendarService 為新模組 — 在 packageService import 之後新增一行：
```js
import { getCoachWeek as svcGetCoachWeek, searchCustomers as svcSearchCustomers } from './services/coachCalendarService.js';
```

- [ ] **Step 3：在 `src/server.js` 方案路由（PR1，`app.post('/api/coach/packages/:id/restore'...)`）之後加 4 路由**

```js
// --- 登錄預約：週曆彙整 / 客人搜尋 / 預覽 / 建立 ---
app.get('/api/coach/week', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res); if (!coach) return;
  const { start } = req.query;
  res.json(svcGetCoachWeek({ coachId: coach.id, start }));
}));

app.get('/api/coach/customers/search', requireCoach, asyncHandler((req, res) => {
  res.json(svcSearchCustomers(req.query.q));
}));

app.post('/api/coach/register/preview', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res); if (!coach) return;
  const { memberId, packageId, startAt, recurrence } = req.body || {};
  res.json(svcPreviewRegister({ coachId: coach.id, memberId: Number(memberId), packageId: Number(packageId), startAt, recurrence: recurrence || null }));
}));

app.post('/api/coach/register', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res); if (!coach) return;
  const { memberId, packageId, startAt, recurrence } = req.body || {};
  const r = svcCreateRegister({ coachId: coach.id, memberId: Number(memberId), packageId: Number(packageId), startAt, recurrence: recurrence || null, actorId: req.user.id });
  for (const c of r.created) syncBookingCreate(c.id); // commit 後副作用
  res.status(201).json(r);
}));
```

- [ ] **Step 4：寫 api 測試 `tests/coach-register-api.test.js`**

```js
// API：週彙整 / 客人搜尋 / 登錄預覽+建立（需 running server + seed admin）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[coach-register-api] start');
const clean = () => db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'cra-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cra-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cra-%'); DELETE FROM users WHERE email LIKE 'cra-%'");
clean();
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入', () => assert.ok(token));
// 取一個已啟用教練 + 建客人 + 方案
const coaches = await req('GET', '/api/admin/coaches', { token });
const coachId = coaches.data.find(c => c.is_active).id;
const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('CRA客','cra-m@x.com','0973000001','user')").run().lastInsertRowid);
const pkg = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, sessionType: '1on1', totalSessions: 3, amount: 4500 } });
const pkgId = pkg.data.id;
const pad = n => String(n).padStart(2,'0'); const d = new Date(Date.now()+15*86400000);
const D = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

expect('客人搜尋（姓名）', async () => {});
const s = await req('GET', `/api/coach/customers/search?q=CRA`, { token });
expect('搜尋回該客人 {id,name,phone}', () => { assert.ok(s.data.some(u => u.id === mid)); assert.ok(s.data.every(u => 'phone' in u && !('email' in u))); });

const pv = await req('POST', '/api/coach/register/preview', { token, body: { coachId, memberId: mid, packageId: pkgId, startAt: `${D}T09:00:00`, recurrence: { frequency:'daily', end:{type:'count',count:5} } } });
expect('預覽：3 ok + 2 depleted（方案 3 堂）', () => {
  assert.equal(pv.status, 200);
  assert.equal(pv.data.willCreate, 3);
  assert.equal(pv.data.occurrences.filter(o=>o.status==='ok').length, 3);
  assert.equal(pv.data.occurrences.filter(o=>o.status==='depleted').length, 2);
});
const cr = await req('POST', '/api/coach/register', { token, body: { coachId, memberId: mid, packageId: pkgId, startAt: `${D}T09:00:00`, recurrence: { frequency:'daily', end:{type:'count',count:5} } } });
expect('登錄：建立 3 筆、扣到 0、群組串接', () => {
  assert.equal(cr.status, 201);
  assert.equal(cr.data.created.length, 3);
  assert.equal(cr.data.remainingAfter, 0);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(cr.data.created[0].id);
  assert.ok(b.paid_at); assert.equal(b.package_id, pkgId); assert.equal(b.original_amount, 1500);
});
const wk = await req('GET', `/api/coach/week?coachId=${coachId}&start=${D}`, { token });
expect('週彙整：含剛建立的預約 + availableSlots 陣列', () => {
  assert.equal(wk.status, 200);
  assert.ok(Array.isArray(wk.data.bookings) && wk.data.bookings.some(b => b.member_name === 'CRA客'));
  assert.ok(Array.isArray(wk.data.availableSlots));
  assert.ok(Array.isArray(wk.data.groupSessions));
});
const pv2 = await req('POST', '/api/coach/register/preview', { token, body: { coachId, memberId: mid, packageId: pkgId, startAt: `${D}T09:00:00`, recurrence: null } });
expect('方案用罄後預覽 → 409 package_invalid', () => { assert.equal(pv2.status, 409); assert.equal(pv2.data.error, 'package_invalid'); });
clean();
console.log('[coach-register-api] done');
```

- [ ] **Step 5：掛進 `package.json` 的 `test:api`（末尾加 `&& node tests/coach-register-api.test.js`）**

- [ ] **Step 6：起 server 跑 api 測試**

Run:
```bash
(LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 PORT=3000 node src/server.js & SRV=$!; sleep 1.5; node tests/coach-register-api.test.js; kill $SRV)
```
Expected: 全 `✓`、0 `✗`。（admin 登入失敗 → `npm run seed && node src/db/seed-demo.js` 再跑。）

- [ ] **Step 7：Commit**

```bash
git add src/services/coachCalendarService.js src/server.js tests/coach-register-api.test.js package.json
git commit -m "feat(register): 週彙整/客人搜尋/登錄預覽+建立 端點 + api 測試"
```

---

## Task 4：前端「登錄預約」分頁 + 週曆格

**Files:**
- Modify: `public/coach.html`（分頁鈕 + `#tab-register` 區塊）
- Modify: `public/coach.js`（`switchTab` 加 register；`renderRegister()` 週曆 + 導覽 + 疊加）
- Modify: `public/style.css`（`.reg-*` 週曆樣式）

**Interfaces:**
- Consumes: `api`、`escapeHtml`、`coachQuery()`、`$`、`selectedCoachId`；`GET /api/coach/week`。
- Produces: 週曆 UI；點空白整點格呼叫 `openRegisterModal(startAtISO)`（Task 5 實作；Task 4 先放 stub）。

- [ ] **Step 1：`public/coach.html` 加分頁鈕（在 `個人資料` 之後）**

把：
```html
  <button data-tab="profile" class="tab">個人資料</button>
</div>
```
改為：
```html
  <button data-tab="profile" class="tab">個人資料</button>
  <button data-tab="register" class="tab">登錄預約</button>
</div>
```

- [ ] **Step 2：`public/coach.html` 加 panel（在 `#tab-profile` 之後）**

把：
```html
<section id="tab-profile" class="tab-panel hidden"></section>
```
改為：
```html
<section id="tab-profile" class="tab-panel hidden"></section>
<section id="tab-register" class="tab-panel hidden"></section>
```

- [ ] **Step 3：`public/coach.js` `switchTab` 加 register 分支**

把：
```js
  if (name === 'profile') renderProfile();
}
```
改為：
```js
  if (name === 'profile') renderProfile();
  if (name === 'register') renderRegister();
}
```

- [ ] **Step 4：`public/coach.js` 新增週算 + `renderRegister()`（放在 `renderProfile` 之後、檔尾前）**

```js
// 登錄預約：週曆狀態
let regWeekOffset = 0; // 0=本週
const REG_HOUR_MIN = 7, REG_HOUR_MAX = 21; // 預設顯示 07:00–21:00（slot 起點）；資料超出此範圍時動態擴充，避免藏到預約
const REG_DOW = ['一','二','三','四','五','六','日'];

function regWeekRange(offset) {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7);
  const dow = base.getDay();
  const toMonday = dow === 0 ? -6 : 1 - dow;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + toMonday);
  const pad = (n) => String(n).padStart(2, '0');
  const fk = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dates = []; for (let i = 0; i < 7; i++) { const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); dates.push(fk(d)); }
  return { start: fk(start), dates };
}

async function renderRegister() {
  const panel = $('tab-register');
  if (selectedCoachId == null && isAdmin) { panel.innerHTML = '<p class="subtle">請先於上方選擇教練。</p>'; return; }
  const { start, dates } = regWeekRange(regWeekOffset);
  panel.innerHTML = `
    <div class="reg-toolbar">
      <button id="reg-prev" class="btn-secondary reg-navbtn">← 上一週</button>
      <button id="reg-today" class="btn-secondary reg-navbtn">本週</button>
      <button id="reg-next" class="btn-secondary reg-navbtn">下一週 →</button>
      <span id="reg-range" class="reg-range"></span>
    </div>
    <div id="reg-grid" class="reg-grid-wrap"><p class="subtle">載入中…</p></div>`;
  $('reg-prev').onclick = () => { regWeekOffset--; renderRegister(); };
  $('reg-next').onclick = () => { regWeekOffset++; renderRegister(); };
  $('reg-today').onclick = () => { regWeekOffset = 0; renderRegister(); };
  $('reg-range').textContent = `${dates[0].slice(5).replace('-', '/')} – ${dates[6].slice(5).replace('-', '/')}`;

  let data;
  try { data = await api(`/api/coach/week${coachQuery() ? coachQuery() + '&' : '?'}start=${start}`); }
  catch (e) { $('reg-grid').innerHTML = `<p class="subtle" style="color:#dc2626;">載入失敗：${escapeHtml(e.message)}</p>`; return; }

  // 索引：available slots / bookings / group sessions by 'YYYY-MM-DDTHH'
  const slotKey = (iso) => iso.slice(0, 13); // 'YYYY-MM-DDTHH'
  const avail = new Set((data.availableSlots || []).map(s => slotKey(s.start)));
  const bookByKey = new Map(); for (const b of data.bookings || []) bookByKey.set(slotKey(b.start_at), b);
  const grpByKey = new Map(); for (const g of data.groupSessions || []) grpByKey.set(slotKey(g.start_at), g);

  // 動態時段範圍：預設 07–21，但若資料（預約/團課/班表）含更早/更晚的整點則擴充，避免藏住範圍外的項目。
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
      const bk = bookByKey.get(key); const gp = grpByKey.get(key);
      if (bk) {
        const tag = bk.session_type === '1on2' ? '1對2' : '1對1';
        rows += `<div class="reg-cell reg-booked" title="${escapeHtml(bk.member_name)}">${escapeHtml(bk.member_name)}<br><span class="reg-sub">${tag}</span></div>`;
      } else if (gp) {
        rows += `<div class="reg-cell reg-group" title="${escapeHtml(gp.name)}">${escapeHtml(gp.name)}<br><span class="reg-sub">團課</span></div>`;
      } else {
        const cls = avail.has(key) ? 'reg-open reg-avail' : 'reg-open';
        rows += `<div class="reg-cell ${cls}" data-slot="${iso}">＋</div>`;
      }
    }
  }
  $('reg-grid').innerHTML = `<div class="reg-grid">${head}${rows}</div>`;
  $('reg-grid').querySelectorAll('.reg-open[data-slot]').forEach(c => {
    c.addEventListener('click', () => openRegisterModal(c.dataset.slot));
  });
}

// Task 5 會實作；先 stub 避免 ReferenceError
function openRegisterModal(startAtISO) { console.log('[register] slot', startAtISO); }
```

- [ ] **Step 5：`public/style.css` 末尾加週曆樣式**

```css
/* 登錄預約 週曆 */
.reg-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
.reg-navbtn{padding:4px 10px;font-size:13px;}
.reg-range{font-weight:600;color:#0f172a;margin-left:4px;}
.reg-grid-wrap{overflow:auto;max-height:70vh;}
.reg-grid{display:grid;grid-template-columns:56px repeat(7,minmax(64px,1fr));gap:2px;min-width:640px;}
.reg-cell{font-size:12px;border-radius:6px;padding:4px;min-height:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
.reg-head{font-weight:700;background:#f1f5f9;color:#0f172a;}
.reg-date{font-weight:400;font-size:11px;color:#64748b;}
.reg-timecol{background:#f8fafc;color:#64748b;font-variant-numeric:tabular-nums;}
.reg-open{color:#cbd5e1;cursor:pointer;border:1px dashed #e2e8f0;}
.reg-open:hover{background:#e0f2fe;color:#0284c7;border-color:#7dd3fc;}
.reg-avail{background:#f0f9ff;border-color:#bae6fd;color:#7dd3fc;}
.reg-booked{background:#dbeafe;color:#1e3a8a;font-weight:600;cursor:default;}
.reg-group{background:#f3e8ff;color:#6b21a8;cursor:default;}
.reg-sub{font-weight:400;font-size:10px;opacity:0.8;}
```

- [ ] **Step 6：驗證語法 + 瀏覽器 smoke（手動，收尾統一做）**

Run: `node --check public/coach.js`（無語法錯）。瀏覽器 smoke 於收尾：登入教練/管理者 → 登錄預約分頁 → 週曆顯示、可上/下週、既有預約與團課疊加、空格可點（暫 console.log）。

- [ ] **Step 7：Commit**

```bash
git add public/coach.html public/coach.js public/style.css
git commit -m "feat(register): 登錄預約分頁 + 週曆格（疊加預約/團課/班表底色）"
```

---

## Task 5：登錄彈窗（搜尋客人 / 選方案 / 開方案 / 循環 / 預覽 / 送出）

**Files:**
- Modify: `public/coach.html`（彈窗骨架）
- Modify: `public/coach.js`（`openRegisterModal` 實作，取代 stub）
- Modify: `public/style.css`（`.regm-*` 彈窗樣式）

**Interfaces:**
- Consumes: `api`、`escapeHtml`、`coachQuery()`、`withCoach()`、`$`、`toast`；`GET /api/coach/customers/search`、`GET /api/coach/packages?memberId=`、`POST /api/coach/packages`、`POST /api/coach/register/preview`、`POST /api/coach/register`。

- [ ] **Step 1：`public/coach.html` 在 `</body>` 前加彈窗骨架**

```html
<div id="regm-overlay" class="regm-overlay" style="display:none;">
  <div class="regm-modal" role="dialog" aria-modal="true">
    <button id="regm-close" class="regm-close" aria-label="關閉">✕</button>
    <h3 class="regm-title">登錄預約</h3>
    <div id="regm-body"></div>
  </div>
</div>
```

- [ ] **Step 2：`public/coach.js` 以實作版取代 Task 4 的 `openRegisterModal` stub**

**先刪除** Task 4 留下的 stub 兩行（避免同名函式重複宣告）：
```js
// Task 5 會實作；先 stub 避免 ReferenceError
function openRegisterModal(startAtISO) { console.log('[register] slot', startAtISO); }
```
**再插入**以下實作（同位置）：
```js
let regmSlot = null;       // 'YYYY-MM-DDTHH:00:00'
let regmCustomer = null;   // {id,name,phone}
let regmPackages = [];     // 該客人有效方案
let regmPackageId = null;  // 選中方案

const PKG_TYPE = { '1on1': '一對一', '1on2': '一對二' };
function regmClose() { $('regm-overlay').style.display = 'none'; regmCustomer = null; regmPackages = []; regmPackageId = null; }

function openRegisterModal(startAtISO) {
  regmSlot = startAtISO; regmCustomer = null; regmPackages = []; regmPackageId = null;
  const ov = $('regm-overlay'); ov.style.display = 'grid';
  $('regm-close').onclick = regmClose;
  ov.onclick = (e) => { if (e.target === ov) regmClose(); };
  renderRegmBody();
}

function regmSlotLabel(iso) { return iso.slice(0, 16).replace('T', ' ').replace(/-/g, '/'); }

function renderRegmBody() {
  const body = $('regm-body');
  body.innerHTML = `
    <p class="regm-slot">時段：<strong>${escapeHtml(regmSlotLabel(regmSlot))}</strong>（60 分鐘）</p>
    <label class="regm-label">搜尋客人（姓名或電話）</label>
    <input id="regm-search" class="form-input regm-input" placeholder="輸入姓名或電話…" autocomplete="off" />
    <div id="regm-results" class="regm-results"></div>
    <div id="regm-picked"></div>`;
  const search = $('regm-search');
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    const q = search.value.trim();
    if (!q) { $('regm-results').innerHTML = ''; return; }
    t = setTimeout(async () => {
      try {
        const list = await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`);
        $('regm-results').innerHTML = list.length
          ? list.map(u => `<div class="regm-result" data-id="${u.id}" data-name="${escapeHtml(u.name)}" data-phone="${escapeHtml(u.phone || '')}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('')
          : '<div class="regm-sub" style="padding:6px;">查無客人</div>';
        $('regm-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', () => {
          regmCustomer = { id: Number(r.dataset.id), name: r.dataset.name, phone: r.dataset.phone };
          $('regm-results').innerHTML = ''; search.value = regmCustomer.name;
          loadRegmPackages();
        }));
      } catch (e) { $('regm-results').innerHTML = `<div class="regm-sub" style="color:#dc2626;padding:6px;">${escapeHtml(e.message)}</div>`; }
    }, 250);
  });
}

async function loadRegmPackages() {
  const picked = $('regm-picked');
  picked.innerHTML = '<p class="regm-sub">載入方案中…</p>';
  let all = [];
  try { all = await api(`/api/coach/packages?memberId=${regmCustomer.id}`); }
  catch (e) { picked.innerHTML = `<p class="regm-sub" style="color:#dc2626;">${escapeHtml(e.message)}</p>`; return; }
  regmPackages = all.filter(p => p.is_valid);
  regmPackageId = regmPackages.length ? regmPackages[0].id : null;
  renderRegmPicked();
}

function renderRegmPicked() {
  const picked = $('regm-picked');
  if (!regmPackages.length) {
    picked.innerHTML = `
      <div class="regm-nopkg">此客人沒有可用方案，請先開一個：</div>
      <div class="regm-newpkg">
        <select id="regm-np-type" class="form-select"><option value="1on1">一對一</option><option value="1on2">一對二</option></select>
        <input id="regm-np-total" class="form-input" type="number" min="1" placeholder="堂數" />
        <input id="regm-np-amount" class="form-input" type="number" min="0" placeholder="金額（可空）" />
        <input id="regm-np-expiry" class="form-input" type="date" />
        <button id="regm-np-create" class="btn-primary">建立方案</button>
      </div>`;
    $('regm-np-create').onclick = async () => {
      const total = Number($('regm-np-total').value);
      if (!Number.isInteger(total) || total <= 0) { toast('請填正確堂數', 'error'); return; }
      const amt = $('regm-np-amount').value;
      try {
        await api('/api/coach/packages', { method: 'POST', body: { memberId: regmCustomer.id, sessionType: $('regm-np-type').value, totalSessions: total, amount: amt === '' ? null : Number(amt), expiresAt: $('regm-np-expiry').value || null } });
        toast('方案已建立', 'success'); loadRegmPackages();
      } catch (e) { toast(`建立失敗：${e.message}`, 'error'); }
    };
    return;
  }
  const opts = regmPackages.map(p => `<option value="${p.id}">${PKG_TYPE[p.session_type]}・剩 ${p.remaining_sessions}/${p.total_sessions}${p.expires_at ? '・到期 ' + p.expires_at : ''}</option>`).join('');
  picked.innerHTML = `
    <label class="regm-label">選擇方案</label>
    <select id="regm-pkg" class="form-select">${opts}</select>
    <label class="regm-check"><input id="regm-rec-on" type="checkbox" /> 開啟循環</label>
    <div id="regm-rec" class="regm-rec hidden">
      <div class="regm-rec-row">
        <select id="regm-freq" class="form-select">
          <option value="daily">每天</option><option value="weekly" selected>每週</option>
          <option value="monthly">每月</option><option value="yearly">每年</option><option value="custom">自訂</option>
        </select>
      </div>
      <div id="regm-custom" class="regm-rec-row hidden">
        <span>每</span><input id="regm-interval" class="form-input regm-num" type="number" min="1" value="1" />
        <select id="regm-unit" class="form-select"><option value="weekly">週</option><option value="daily">天</option><option value="monthly">月</option><option value="yearly">年</option></select>
      </div>
      <div id="regm-weekdays" class="regm-weekdays hidden"></div>
      <div class="regm-rec-row">
        <label class="regm-radio"><input type="radio" name="regm-end" value="count" checked /> 共</label>
        <input id="regm-count" class="form-input regm-num" type="number" min="1" max="52" value="4" /> 次
        <label class="regm-radio"><input type="radio" name="regm-end" value="date" /> 到</label>
        <input id="regm-enddate" class="form-input" type="date" disabled />
      </div>
    </div>
    <div id="regm-preview" class="regm-preview"></div>
    <div class="regm-actions">
      <button id="regm-preview-btn" class="btn-secondary">預覽</button>
      <button id="regm-submit" class="btn-primary">確認登錄</button>
    </div>`;
  $('regm-pkg').onchange = () => { regmPackageId = Number($('regm-pkg').value); };
  regmPackageId = Number($('regm-pkg').value);
  // 週幾勾選（預設循環起始日的星期）
  const wdWrap = $('regm-weekdays');
  wdWrap.innerHTML = ['一','二','三','四','五','六','日'].map((lab, i) => {
    const val = i === 6 ? 0 : i + 1; // 一=1…六=6, 日=0
    return `<label class="regm-wd"><input type="checkbox" value="${val}" /> ${lab}</label>`;
  }).join('');
  const toggleRec = () => $('regm-rec').classList.toggle('hidden', !$('regm-rec-on').checked);
  $('regm-rec-on').onchange = toggleRec;
  $('regm-freq').onchange = () => {
    const custom = $('regm-freq').value === 'custom';
    $('regm-custom').classList.toggle('hidden', !custom);
    $('regm-weekdays').classList.toggle('hidden', !(custom && $('regm-unit').value === 'weekly'));
  };
  $('regm-unit').onchange = () => $('regm-weekdays').classList.toggle('hidden', !($('regm-freq').value === 'custom' && $('regm-unit').value === 'weekly'));
  document.querySelectorAll('input[name="regm-end"]').forEach(r => r.onchange = () => {
    const isDate = document.querySelector('input[name="regm-end"]:checked').value === 'date';
    $('regm-enddate').disabled = !isDate; $('regm-count').disabled = isDate;
  });
  $('regm-preview-btn').onclick = doRegmPreview;
  $('regm-submit').onclick = doRegmSubmit;
}

function buildRecurrence() {
  if (!$('regm-rec-on') || !$('regm-rec-on').checked) return null;
  const freqSel = $('regm-freq').value;
  let frequency, interval = 1, byWeekday = null;
  if (freqSel === 'custom') {
    frequency = $('regm-unit').value; interval = Number($('regm-interval').value) || 1;
    if (frequency === 'weekly') {
      byWeekday = [...$('regm-weekdays').querySelectorAll('input:checked')].map(i => Number(i.value));
      if (!byWeekday.length) byWeekday = null;
    }
  } else { frequency = freqSel; }
  const endType = document.querySelector('input[name="regm-end"]:checked').value;
  const end = endType === 'date' ? { type: 'date', date: $('regm-enddate').value } : { type: 'count', count: Number($('regm-count').value) || 1 };
  return { frequency, interval, byWeekday, end };
}

async function doRegmPreview() {
  const box = $('regm-preview'); box.innerHTML = '預覽中…';
  try {
    const r = await api('/api/coach/register/preview', { method: 'POST', body: withCoach({ memberId: regmCustomer.id, packageId: regmPackageId, startAt: regmSlot, recurrence: buildRecurrence() }) });
    const label = { ok: '✓ 建立', conflict: '✕ 衝突跳過', no_date: '✕ 無此日', depleted: '✕ 方案用罄' };
    box.innerHTML = `<div class="regm-sub">將建立 <strong>${r.willCreate}</strong> 筆、扣 ${r.willDeduct} 堂、方案剩 ${r.remainingAfter}</div>` +
      r.occurrences.map(o => `<div class="regm-occ regm-${o.status}">${regmSlotLabel(o.startAt)} — ${label[o.status]}</div>`).join('');
  } catch (e) { box.innerHTML = `<div class="regm-sub" style="color:#dc2626;">${escapeHtml(e.data?.error || e.message)}</div>`; }
}

async function doRegmSubmit() {
  try {
    const r = await api('/api/coach/register', { method: 'POST', body: withCoach({ memberId: regmCustomer.id, packageId: regmPackageId, startAt: regmSlot, recurrence: buildRecurrence() }) });
    toast(`已登錄 ${r.created.length} 筆${r.skipped.length ? `（跳過 ${r.skipped.length}）` : ''}`, 'success');
    regmClose(); renderRegister();
  } catch (e) {
    const msgs = { package_invalid: '方案已失效/用罄', package_member_mismatch: '方案不屬此客人', nothing_created: '無可建立場次（全衝突或用罄）', slot_taken: '此時段已被預約' };
    toast(msgs[e.data?.error] || `登錄失敗：${e.message}`, 'error');
  }
}
```

- [ ] **Step 3：`public/style.css` 末尾加彈窗樣式**

```css
/* 登錄彈窗 */
.regm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:grid;place-items:center;padding:16px;}
.regm-modal{background:#fff;border-radius:12px;max-width:440px;width:100%;max-height:90vh;overflow-y:auto;padding:20px;position:relative;}
.regm-close{position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;}
.regm-title{font-weight:700;margin-bottom:12px;}
.regm-slot{font-size:14px;margin-bottom:10px;}
.regm-label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px;}
.regm-input{width:100%;}
.regm-results{max-height:160px;overflow-y:auto;}
.regm-result{padding:6px 8px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:14px;}
.regm-result:hover{background:#f0f9ff;}
.regm-sub{font-size:12px;color:#64748b;}
.regm-nopkg{font-size:13px;color:#b45309;margin:10px 0 6px;}
.regm-newpkg{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.regm-newpkg button{grid-column:1/-1;}
.regm-check{display:flex;align-items:center;gap:6px;margin:10px 0;font-size:14px;cursor:pointer;}
.regm-rec{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:10px;}
.regm-rec-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;}
.regm-num{width:64px;}
.regm-weekdays{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
.regm-wd{font-size:13px;display:flex;align-items:center;gap:3px;}
.regm-radio{display:flex;align-items:center;gap:4px;font-size:13px;}
.regm-preview{max-height:180px;overflow-y:auto;margin:10px 0;font-size:13px;}
.regm-occ{padding:2px 0;}
.regm-ok{color:#166534;}.regm-conflict,.regm-depleted,.regm-no_date{color:#b45309;}
.regm-actions{display:flex;gap:8px;justify-content:flex-end;}
```

- [ ] **Step 4：驗證語法**

Run: `node --check public/coach.js`（無語法錯）。

- [ ] **Step 5：瀏覽器 smoke（收尾統一做）**

教練/管理者 → 登錄預約 → 點空格 → 彈窗：搜尋客人、選方案（或開方案）、單筆送出 → 週曆出現該預約；開循環（每週/自訂週幾/結束 N 次）→ 預覽列出 ok/衝突/用罄 → 送出 → 多筆建立、方案扣堂。Console 無錯誤。

- [ ] **Step 6：Commit**

```bash
git add public/coach.html public/coach.js public/style.css
git commit -m "feat(register): 登錄彈窗（客人搜尋/方案/開方案/循環/預覽/送出）"
```

---

## Self-Review（plan 作者自檢，已執行）

**Spec 覆蓋**：登錄分頁週曆（Task4）、疊加個別課+團課+班表底色（Task3 getCoachWeek + Task4 渲染）、任意整點可點只擋同教練同時段（Task1 enforceAvailability + Task2 hasConfirmedClash + UNIQUE）、點格彈窗搜尋客人（Task3 search + Task5）、帶出方案/類型決定 session_type（Task2/Task5）、無方案擋並可彈窗內開（Task5 reuse PR1 端點）、進階循環每天/週/月/年+自訂單位/間隔/週幾/結束日或N次（Task1 expandRecurrence + Task5 UI）、預覽 ok/衝突/用罄（Task2/3/5）、循環用罄即停+衝突跳過+recurring_group_id（Task2）、package-backed 自動已核對+扣堂+取消回補（Task2 寫 paid_at；回補在 PR1 已接）。代選教練沿用 resolveCoach（Task3）。

**Placeholder 掃描**：無 TBD；每步附完整碼與插入錨點。Task4 的 `openRegisterModal` 為 stub，Task5 取代（明確標示）。

**型別一致性**：`expandRecurrence` 簽章（Task1）= Task2 `_registerOccurrences` 展開（`{frequency,interval,byWeekday,end}`）= Task5 `buildRecurrence` 產出一致。`previewCoachRegister`/`createCoachRegister`（Task2）回傳 `occurrences[].status`/`created`/`willCreate`/`remainingAfter` 與 Task3 端點、Task5 前端一致。`getCoachWeek` 回 `{bookings,groupSessions,availableSlots}` 與 Task4 渲染鍵一致。`createBookingCore` 新增 `enforceAvailability` 預設 true（不影響既有呼叫者）。

**與 spec 的刻意差異（審查後確認）**：(1) 週端點回 `availableSlots`（computeAvailableSlots）取代 spec 字面的 `rules`/`exceptions`——更貼合「班表淡底色」需求；週端點覆蓋併入 `coach-register-api.test.js`（已斷言 bookings/groupSessions/availableSlots），不另開 `coach-week-api.test.js`。(2) `no_date` 為 ok/conflict/depleted 外第 4 狀態（monthly/yearly 無此日），前端有標籤。(3) 登錄不檢查 `coach.is_active`（管理者代選可對未啟用教練補登/排課）。

**風險點待最終審查特別看**：(a) `expandRecurrence` weekly+byWeekday 的 block/interval 邊界與 end=date 終止（已自行驗算 2026-07-01=週三、interval=2 輸出正確）；(b) `createCoachRegister` 扣堂與建立的順序（先查衝突→deductOne→建立，tx 內序列化無競態；若 createBookingCore 仍丟 slot_taken 則整 tx rollback、扣堂一併還原）；(c) 前端 `/api/coach/week` 的 query 串接（coachQuery 有無 `?` 前綴的處理）。
