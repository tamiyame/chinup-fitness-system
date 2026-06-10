# Google Calendar 整合 + 時段容量限制 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1對1 預約自動寫入店家 Google 日曆（雙向 freebusy）、Email 選填確認信（Gmail API）、全店小時桶容量上限（預設 3 人）。

**Architecture:** 零新依賴（native fetch + node:crypto，比照 lineClient.js）。Calendar 走 Service Account JWT；Gmail 走 OAuth refresh token。容量/重疊檢查在 availabilityService（同步、純 DB），freebusy 由路由層 async 預取注入。日曆事件用決定性 ID 冪等，5 分鐘 reconcile cron 兜底。Email 重試重用 notifications 表既有退避機制。

**Tech Stack:** Node 24 ESM、Express 4、node:sqlite、node-cron、Google Calendar API v3、Gmail API v1。

**Spec:** `docs/superpowers/specs/2026-06-10-gcal-booking-integration-design.md`（本計畫的權威需求來源）

**分支：** `feat/gcal-booking-integration`（已存在）。每個 Task 結尾 commit；commit message 結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

**全域注意：**
- 所有 DB 時間是「無時區台北牆鐘字串」`YYYY-MM-DDTHH:MM:SS`，**禁用 `Date.toISOString()`**。固定格式下字串字典序＝時間序，可直接比較。
- `npm test` 會清掉本機 `data/app.db` 的 demo 資料（已知行為）。
- 跑 `npm run test:api` 前要先起 server：`LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js`，測試用 `BASE=http://localhost:3100`。
- 既有測試 `tests/flow.test.js` 的「第二場次 action=cancelled」是已知日期相依 flaky，與本案無關。

---

### Task 1: DB 遷移 + app_settings 新 key + 設定 accessors

**Files:**
- Modify: `src/db/schema.js`（bookings/notifications 欄位 + 2 個 settings seed）
- Modify: `src/db/connection.js`（addColumnIfMissing ×3）
- Modify: `src/services/discountService.js`（2 個 accessor）
- Test: `tests/gcal-migration.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/gcal-migration.test.js`：

```js
// gcal 整合遷移：新欄位 + settings seed + accessor 預設值
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { getBookingHourlyCapacity, getGcalCalendarId } from '../src/services/discountService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-migration test] start');

const bCols = db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);
expect('bookings.gcal_event_id 存在', () => assert(bCols.includes('gcal_event_id')));
expect('bookings.customer_email 存在', () => assert(bCols.includes('customer_email')));
const nCols = db.prepare('PRAGMA table_info(notifications)').all().map(c=>c.name);
expect('notifications.recipient 存在', () => assert(nCols.includes('recipient')));
expect('settings: gcal_calendar_id seed 為空字串', () => {
  const r = db.prepare("SELECT value FROM app_settings WHERE key='gcal_calendar_id'").get();
  assert(r && r.value === '');
});
expect('settings: booking_hourly_capacity seed 為 3', () => {
  const r = db.prepare("SELECT value FROM app_settings WHERE key='booking_hourly_capacity'").get();
  assert(r && r.value === '3');
});
expect('getBookingHourlyCapacity() 預設 3', () => assert.equal(getBookingHourlyCapacity(), 3));
expect('getGcalCalendarId() 預設空字串', () => assert.equal(getGcalCalendarId(), ''));
console.log('[gcal-migration test] done');
```

- [ ] **Step 2: 跑測試確認失敗** — `node tests/gcal-migration.test.js`，預期 ✗（欄位不存在、import 失敗）。
- [ ] **Step 3: schema.js** — bookings CREATE TABLE 的 `original_amount INTEGER,` 之後加：

```sql
  gcal_event_id TEXT,
  customer_email TEXT,
```

notifications CREATE TABLE 的 `last_error TEXT,` 之後加一行 `recipient TEXT,`。檔尾 app_settings 四個 seed 之後加：

```sql
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('gcal_calendar_id', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('booking_hourly_capacity', '3');
```

- [ ] **Step 4: connection.js** — 在 `2026-06-09 角色/權限重構` 區塊之後、`defaultCategories` 之前加：

```js
// ── 2026-06-10 Google Calendar 整合 + 容量限制 ──
// gcal_event_id：「日曆上已有事件」旗標（建立成功寫入、刪除成功清空，reconcile 依此補建/補刪）。
// customer_email：確認信收件位址（不寫 users.email——那是員工登入識別且有 UNIQUE partial index）。
// notifications.recipient：email 通知收件位址（LINE 通知為 NULL），重試時直接取用。
addColumnIfMissing('bookings', 'gcal_event_id', 'TEXT');
addColumnIfMissing('bookings', 'customer_email', 'TEXT');
addColumnIfMissing('notifications', 'recipient', 'TEXT');
```

（settings seed 走 schema.js 的 `INSERT OR IGNORE`，每次開機都會執行，舊 DB 自動補上。）

- [ ] **Step 5: discountService.js** — 檔尾 `getLineOfficialUrl` 之後加：

```js
export function getGcalCalendarId() { return getSetting('gcal_calendar_id') || ''; }
// 每小時桶容量上限（全店跨教練）。非法值（NaN/<1）退回預設 3。
export function getBookingHourlyCapacity() {
  const n = parseInt(getSetting('booking_hourly_capacity') || '3', 10);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}
```

- [ ] **Step 6: 跑測試確認通過** — `node tests/gcal-migration.test.js` 全 ✓；把它加進 package.json `test` script 串列尾端（`&& node tests/gcal-migration.test.js`）。
- [ ] **Step 7: Commit** — `git add src/db/schema.js src/db/connection.js src/services/discountService.js tests/gcal-migration.test.js package.json` → `feat: gcal/容量 遷移欄位與設定 keys`

---

### Task 2: 容量演算法 + 同教練區間重疊 + 新回應形狀（availabilityService）

**Files:**
- Modify: `src/services/availabilityService.js`
- Test: `tests/capacity.test.js`（新）
- Modify: `tests/availability-leave.test.js`、`tests/booking-flow.test.js`（適配新形狀）

**規格重點**（spec §5）：`computeAvailableSlots` 回傳 `[{ start, remain }]`；新增可選參數 `externalBusy`；同教練撞期從 exact-match 升級為區間重疊；全店小時桶容量 `load(B)+units ≤ capacity`，`remain = min(capacity − load(B))`，跨桶預約佔兩桶。另外輸出同步檢查 `assertBookableTx`（給 Task 3 的 tx 內用）。

- [ ] **Step 1: 寫失敗測試** `tests/capacity.test.js`：

```js
// 全店小時桶容量：1對1=1人、1對2=2人、非整點佔兩桶、remain 計算、assertBookableTx。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule, computeAvailableSlots, assertBookableTx } from '../src/services/availabilityService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[capacity test] start');
db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'cap-%'");

function mkCoach(tag){
  const uid = Number(db.prepare(`INSERT INTO users (name,email,role) VALUES ('C${tag}','cap-${tag}@x.com','coach')`).run().lastInsertRowid);
  return Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, ?, 1)").run(uid, 'C'+tag).lastInsertRowid);
}
const cA = mkCoach('a'), cB = mkCoach('b'), cC = mkCoach('c'), cD = mkCoach('d');
// FK：bookings.member_id 需存在的 user
const memberId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('客','cap-m@x.com','user')").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 3*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId: cD, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });
const ins = db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type) VALUES (?, ?, ?, ?, ?)");

// 業主範例：A、B 兩組 1對1 在 14:00–15:00、C 在 14:30–15:30
ins.run(cA, memberId, `${date}T14:00:00`, `${date}T15:00:00`, '1on1');
ins.run(cB, memberId, `${date}T14:00:00`, `${date}T15:00:00`, '1on1');
ins.run(cC, memberId, `${date}T14:30:00`, `${date}T15:30:00`, '1on1');

const slots = () => computeAvailableSlots({ coachId: cD, fromDate: date, toDate: date });
const at = hh => slots().find(s => s.start === `${date}T${hh}:00`);

expect('14:00 桶滿（3 人）→ 不在清單', () => assert.equal(at('14:00'), undefined));
expect('15:00 → remain 2（C 跨桶佔 1）', () => assert.equal(at('15:00')?.remain, 2));
expect('16:00 → remain 3', () => assert.equal(at('16:00')?.remain, 3));
expect('回傳物件形狀 {start, remain}', () => {
  const s = slots()[0];
  assert(typeof s.start === 'string' && typeof s.remain === 'number');
});

// 1對2 = 2 人：15:00 再加一組 1對2 → 15 桶 = 1+2 = 3 滿
ins.run(cA, memberId, `${date}T15:00:00`, `${date}T16:00:00`, '1on2');
expect('1對2 佔 2 人 → 15:00 桶滿', () => assert.equal(at('15:00'), undefined));
expect('16:00 不受影響 remain 3', () => assert.equal(at('16:00')?.remain, 3));

// assertBookableTx：容量滿 → slot_full；同教練重疊 → slot_taken
expect('assertBookableTx 容量滿 → slot_full', () => assert.throws(
  () => assertBookableTx({ coachId: cD, startAt: `${date}T14:00:00`, endAt: `${date}T15:00:00`, units: 1 }), /slot_full/));
expect('assertBookableTx 同教練重疊（14:30 vs A 的 14:00–15:00）→ slot_taken', () => assert.throws(
  () => assertBookableTx({ coachId: cA, startAt: `${date}T14:30:00`, endAt: `${date}T15:30:00`, units: 1 }), /slot_taken/));
expect('assertBookableTx 16:00 cD 可約 → 不丟', () => assertBookableTx({ coachId: cD, startAt: `${date}T16:00:00`, endAt: `${date}T17:00:00`, units: 1 }));

// externalBusy：手動日曆活動封鎖
expect('externalBusy 10:00–11:30 → 10:00/11:00 消失、12:00 在', () => {
  const eb = new Map([[date, [{ start: '10:00', end: '11:30' }]]]);
  const s = computeAvailableSlots({ coachId: cD, fromDate: date, toDate: date, externalBusy: eb });
  assert(!s.some(x => x.start === `${date}T10:00:00`));
  assert(!s.some(x => x.start === `${date}T11:00:00`));
  assert(s.some(x => x.start === `${date}T12:00:00`));
});

// 同教練重疊（slot 計算路徑）：cD 自己 09:30–10:30 有約（手插非對齊單）→ 09:00/10:00 都消失
db.exec("DELETE FROM bookings");
ins.run(cD, memberId, `${date}T09:30:00`, `${date}T10:30:00`, '1on1');
expect('同教練區間重疊 → 09:00 與 10:00 都不可約', () => {
  const s = slots();
  assert(!s.some(x => x.start === `${date}T09:00:00`));
  assert(!s.some(x => x.start === `${date}T10:00:00`));
  assert(s.some(x => x.start === `${date}T11:00:00`));
});

db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'cap-%'");
console.log('[capacity test] done');
```

- [ ] **Step 2: 跑測試確認失敗** — `node tests/capacity.test.js`（import assertBookableTx 失敗）。
- [ ] **Step 3: 改寫 `availabilityService.js`** — 檔頭 import 加 `import { getBookingHourlyCapacity } from './discountService.js';`。把第 97-101 行的 `listConfirmedBookings`（SELECT start_at …）整段換成：

```js
// 同教練區間重疊（取代舊 exact-match）：撈出與範圍重疊的 confirmed 預約區間。
const listCoachOverlapping = db.prepare(`
  SELECT start_at, end_at FROM bookings
  WHERE coach_id = ? AND status = 'confirmed' AND start_at < ? AND end_at > ?
`);
// 全店（不分教練）confirmed 預約：小時桶容量計算用。
const listAllOverlapping = db.prepare(`
  SELECT start_at, end_at, session_type FROM bookings
  WHERE status = 'confirmed' AND start_at < ? AND end_at > ?
`);
```

`computeAvailableSlots` 改為（完整替換 120-174 行；簽名加 `externalBusy = null`，回傳物件陣列）：

```js
/**
 * Compute available 60-min slots for a coach within [fromDate, toDate] inclusive.
 * Returns [{ start: 'YYYY-MM-DDTHH:MM:SS', remain: number }] sorted ascending.
 * remain = 該時段在全店小時桶容量下還可容納的人數（min over 所佔桶）。
 * externalBusy: Map<'YYYY-MM-DD', Array<{start:'HH:MM', end:'HH:MM'}>>（Google 日曆
 * 手動活動的忙碌區間；null = 無外部封鎖）。與部分請假同一套重疊過濾。
 */
export function computeAvailableSlots({ coachId, fromDate, toDate, bookingWindowDays = BOOKING_WINDOW_DAYS, externalBusy = null }) {
  if (!YYYYMMDD.test(fromDate) || !YYYYMMDD.test(toDate)) {
    throw new ApiError(400, 'invalid_date_range');
  }

  const now = new Date();
  const bufferMs = now.getTime() + BUFFER_HOURS * 3600_000;
  const windowEndMs = now.getTime() + bookingWindowDays * 86400_000;

  const dates = enumerateDates(fromDate, toDate);
  const rawSlots = [];
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  for (const date of dates) {
    const exceptions = listExceptionsForDate.all(coachId, date);
    // 整天請假（無時段）→ 當天完全封鎖；部分時段請假 → 只扣掉重疊的 slot。
    const allDayLeave = exceptions.some(e => e.type === 'leave' && !e.start_time);
    const windows = [];
    if (!allDayLeave) {
      const dow = new Date(date + 'T00:00:00').getDay();
      const rules = listRulesForDate.all(coachId, dow, date, date);
      for (const r of rules) windows.push({ start: r.start_time, end: r.end_time });
      for (const e of exceptions) {
        if (e.type === 'extra') windows.push({ start: e.start_time, end: e.end_time });
      }
    }
    // 部分請假 + 外部（Google 日曆）忙碌區間 → 同一套重疊過濾
    const blockers = exceptions
      .filter(e => e.type === 'leave' && e.start_time && e.end_time)
      .map(e => ({ start: e.start_time, end: e.end_time }));
    if (externalBusy && externalBusy.get(date)) blockers.push(...externalBusy.get(date));
    for (const w of windows) {
      const slotStartsHH = splitWindowIntoSlots(w.start, w.end, SLOT_DURATION_MINUTES);
      for (const hh of slotStartsHH) {
        const s = toMin(hh), e = s + SLOT_DURATION_MINUTES;
        // 與任一封鎖區間重疊（slot[s,e) ∩ [bs,be) ≠ ∅）→ 封鎖
        const blocked = blockers.some(b => s < toMin(b.end) && e > toMin(b.start));
        if (!blocked) rawSlots.push(`${date}T${hh}:00`);
      }
    }
  }
  rawSlots.sort();
  // 重疊視窗（多條 rule / rule+加開蓋到同一小時）可能產生重複 slot 字串 → 去重
  const dedupedSlots = [...new Set(rawSlots)];

  const nowStr = localWallClock(now);
  const afterFilter = dedupedSlots.filter(s => {
    if (s <= nowStr) return false;
    const slotMs = new Date(s).getTime();
    if (slotMs < bufferMs) return false;
    if (slotMs > windowEndMs) return false;
    return true;
  });
  if (afterFilter.length === 0) return [];

  const rangeStart = afterFilter[0];
  const rangeEnd = addMinutesLocal(afterFilter[afterFilter.length - 1], SLOT_DURATION_MINUTES);
  // 同教練：任何重疊即不可約（教練無法同時帶兩堂）
  const coachIntervals = listCoachOverlapping.all(coachId, rangeEnd, rangeStart);
  // 全店容量：小時桶人數加總
  const loads = bucketLoads(listAllOverlapping.all(rangeEnd, rangeStart));
  const capacity = getBookingHourlyCapacity();

  const out = [];
  for (const s of afterFilter) {
    const e = addMinutesLocal(s, SLOT_DURATION_MINUTES);
    if (coachIntervals.some(b => s < b.end_at && e > b.start_at)) continue;
    let remain = capacity;
    for (const key of hourBuckets(s, e)) remain = Math.min(remain, capacity - (loads.get(key) || 0));
    if (remain >= 1) out.push({ start: s, remain });
  }
  return out;
}

/** 同步、純 DB 的最終預約檢查（在 BEGIN IMMEDIATE tx 內呼叫 → 無競態）。
 *  同教練區間重疊 → 409 slot_taken；全店小時桶容量不足 → 409 slot_full。 */
export function assertBookableTx({ coachId, startAt, endAt, units }) {
  const overlap = listCoachOverlapping.all(coachId, endAt, startAt);
  if (overlap.length) throw new ApiError(409, 'slot_taken');
  const buckets = hourBuckets(startAt, endAt);
  // 撈涵蓋所有所佔桶的預約（桶範圍 = 第一桶起點 ~ 最後桶終點）
  const spanStart = buckets[0] + ':00:00';
  const spanEnd = addMinutesLocal(buckets[buckets.length - 1] + ':00:00', 60);
  const loads = bucketLoads(listAllOverlapping.all(spanEnd, spanStart));
  const capacity = getBookingHourlyCapacity();
  for (const key of buckets) {
    if ((loads.get(key) || 0) + units > capacity) throw new ApiError(409, 'slot_full');
  }
}

/** 區間 [startAt, endAt) 重疊到的小時桶 key 列表（'YYYY-MM-DDTHH'，跨日安全）。 */
function hourBuckets(startAt, endAt) {
  const out = [];
  let cur = new Date(startAt.slice(0, 13) + ':00:00'); // floor 到整點
  const end = new Date(endAt);
  while (cur < end) {
    const pad = (n) => String(n).padStart(2, '0');
    out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}T${pad(cur.getHours())}`);
    cur = new Date(cur.getTime() + 3600_000);
  }
  return out;
}

/** 把 confirmed 預約列表攤成 Map<bucketKey, 人數加總>（1on2 佔 2 人）。 */
function bucketLoads(rows) {
  const loads = new Map();
  for (const b of rows) {
    const units = b.session_type === '1on2' ? 2 : 1;
    for (const key of hourBuckets(b.start_at, b.end_at)) {
      loads.set(key, (loads.get(key) || 0) + units);
    }
  }
  return loads;
}

/** 牆鐘字串 + 分鐘（跨日安全，與 bookingService.addMinutes 同邏輯）。 */
function addMinutesLocal(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
```

- [ ] **Step 4: 適配既有測試** — `tests/availability-leave.test.js` 第 17 行的 slots helper 改為：

```js
const slots = () => computeAvailableSlots({ coachId, fromDate: date, toDate: date }).map(o => o.start).filter(s => s.startsWith(date));
```

`tests/booking-flow.test.js`：找到呼叫 `computeAvailableSlots` 之處，凡把回傳值當字串陣列用（`includes`/相等比較）一律先 `.map(o => o.start)`（讀檔確認具體行）。

- [ ] **Step 5: 跑測試** — `node tests/capacity.test.js && node tests/availability-leave.test.js && node tests/booking-flow.test.js` 全 ✓。把 capacity.test.js 加進 package.json `test` script。
- [ ] **Step 6: Commit** — `feat: 全店小時桶容量 + 同教練區間重疊 + slot remain`

---

### Task 3: createBookingCore 接 assertBookableTx + customer_email 存儲

**Files:**
- Modify: `src/services/bookingService.js`
- Modify: `src/services/userService.js`（匯出 phone 驗證）
- Test: `tests/booking-anon.test.js`（補 3 個 case）

- [ ] **Step 1: 寫失敗測試** — `tests/booking-anon.test.js` 檔尾（最後一行 console.log 之前）加：

```js
// ── gcal 整合：email 存儲 + 容量守門（tx 內 assertBookableTx）──
const rE = createBookingAnon({ coachId: coach.id, startAt: futureLocal(6, 9), name: '小信', phone: '0998000222', email: 'mail@example.com' });
expect('email 寫入 bookings.customer_email', () => {
  assert.equal(db.prepare('SELECT customer_email FROM bookings WHERE id=?').get(rE.id).customer_email, 'mail@example.com');
});
expect('email 格式錯 → 400 invalid_email', () => {
  assert.throws(() => createBookingAnon({ coachId: coach.id, startAt: futureLocal(6, 12), name: '壞信', phone: '0998000333', email: 'not-an-email' }), /invalid_email/);
});
expect('startAt 格式錯 → 400 invalid_start_at', () => {
  assert.throws(() => createBookingAnon({ coachId: coach.id, startAt: 'garbage', name: 'x', phone: '0998000444' }), /invalid_start_at/);
});
// 容量：同一小時三組（不同教練）滿 3 → 第四組 slot_full
const cu2 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach V','anon-bk-coach2@x.com','x','coach')").run();
const coach2 = createCoach({ userId: cu2.lastInsertRowid, displayName: 'Coach V' });
setCoachActive(coach2.id, true);
const cu3 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach W','anon-bk-coach3@x.com','x','coach')").run();
const coach3 = createCoach({ userId: cu3.lastInsertRowid, displayName: 'Coach W' });
setCoachActive(coach3.id, true);
const capSlot = futureLocal(8, 14);
createBookingAnon({ coachId: coach.id,  startAt: capSlot, name: '甲', phone: '0998000555' });
createBookingAnon({ coachId: coach2.id, startAt: capSlot, name: '乙', phone: '0998000666' });
createBookingAnon({ coachId: coach3.id, startAt: capSlot, name: '丙', phone: '0998000777' });
const cu4 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Coach X','anon-bk-coach4@x.com','x','coach')").run();
const coach4 = createCoach({ userId: cu4.lastInsertRowid, displayName: 'Coach X' });
setCoachActive(coach4.id, true);
expect('全店同小時第 4 組 → 409 slot_full', () => {
  assert.throws(() => createBookingAnon({ coachId: coach4.id, startAt: capSlot, name: '丁', phone: '0998000888' }), /slot_full/);
});
```

注意 reset() 的 DELETE users 條件已涵蓋 `anon-bk-%`，新教練 email 沿用該 prefix。
- [ ] **Step 2: 跑測試確認失敗** — `node tests/booking-anon.test.js`。
- [ ] **Step 3: userService.js** — 在 PHONE 正則附近補匯出（讀檔對齊現有寫法）：

```js
export function isValidPhone(phone) { return typeof phone === 'string' && PHONE_RE.test(phone); }
```

（`PHONE_RE` 為既有 `^\d{8,15}$` 常數；若命名不同以實際為準。）
- [ ] **Step 4: bookingService.js** —
  - import 行加 `assertBookableTx`：`import { assertBookableTx } from './availabilityService.js';`
  - 檔頭常數區加：

```js
const START_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

  - `createBookingCore` 開頭（`const endAt = ...` 之後、INSERT 之前）加：

```js
  // 同教練重疊 / 全店容量（tx 內、純 DB → 無競態）。UNIQUE index 仍為最後兜底。
  assertBookableTx({ coachId: coach.id, startAt, endAt, units: sessionType === '1on2' ? 2 : 1 });
```

  - `createBookingAnon` 簽名加 `email = null`；開頭驗證區（`invalid_session_type` 檢查後）加：

```js
  if (typeof startAt !== 'string' || !START_AT_RE.test(startAt)) throw new ApiError(400, 'invalid_start_at');
  if (email != null && email !== '' && !EMAIL_RE.test(email)) throw new ApiError(400, 'invalid_email');
```

  - 金額 UPDATE 改為一併寫 email：

```js
    db.prepare('UPDATE bookings SET original_amount=?, discount_amount=?, discount_code=?, customer_email=? WHERE id=?')
      .run(originalAmount, discountAmount, discountCode_, (email || null), r.id);
```

  - `createBooking`（authed 路徑）開頭也加 `START_AT_RE` 檢查（同 400 invalid_start_at）。
- [ ] **Step 5: 跑測試** — `node tests/booking-anon.test.js && node tests/booking-flow.test.js && node tests/flow.test.js && node tests/discount-booking.test.js` ✓（flaky case 除外）。若 discount-booking/booking-flow 內有同教練同時段或 3+ 重疊的安排被新檢查擋下，調整該測試的時間錯開（保持原測試意圖）。
- [ ] **Step 6: Commit** — `feat: 預約 tx 內容量/重疊守門 + customer_email`

---

### Task 4: googleAuth.js + gcalClient.js（零依賴 Google client）

**Files:**
- Create: `src/services/googleAuth.js`
- Create: `src/services/gcalClient.js`
- Test: `tests/google-auth.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/google-auth.test.js`：

```js
// SA JWT 簽章正確性（本地 keypair 驗簽，不打網路）+ 金鑰解析（raw / base64）。
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { _buildJwt, _parseServiceAccountJson } from '../src/services/googleAuth.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[google-auth test] start');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'svc@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

const jwt = _buildJwt(sa, 1750000000);
const [h, c, sig] = jwt.split('.');
expect('JWT 三段式', () => assert.equal(jwt.split('.').length, 3));
expect('header alg RS256', () => assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256'));
expect('claims iss/scope/aud/exp 正確', () => {
  const cl = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(cl.iss, sa.client_email);
  assert.equal(cl.scope, 'https://www.googleapis.com/auth/calendar');
  assert.equal(cl.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(cl.iat, 1750000000);
  assert.equal(cl.exp, 1750003600);
});
expect('RS256 簽章可用公鑰驗證', () => {
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')));
});
expect('金鑰解析：raw JSON', () => assert.equal(_parseServiceAccountJson('{"client_email":"a@b.c"}').client_email, 'a@b.c'));
expect('金鑰解析：base64', () => {
  const b64 = Buffer.from('{"client_email":"x@y.z"}').toString('base64');
  assert.equal(_parseServiceAccountJson(b64).client_email, 'x@y.z');
});
expect('金鑰解析：壞輸入 → null', () => assert.equal(_parseServiceAccountJson('not json'), null));
console.log('[google-auth test] done');
```

- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 寫 `src/services/googleAuth.js`**（完整檔案）：

```js
// Google OAuth2 token 取得（零 npm 依賴，native fetch + node:crypto）。
// 兩條互相獨立的路徑：
//   Service Account JWT（Calendar）— GCAL_SERVICE_ACCOUNT_JSON（raw JSON 或 base64）
//   OAuth refresh token（Gmail）   — GMAIL_REFRESH_TOKEN + GOOGLE_CLIENT_ID/SECRET
// 比照 lineClient.js：never-throws、回傳 { ok, ... }；GCAL_MOCK / GMAIL_MOCK 短路。
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const b64url = (s) => Buffer.from(s).toString('base64url');

export function _parseServiceAccountJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw.trim(), 'base64').toString('utf8');
  try {
    const obj = JSON.parse(text);
    return obj && obj.client_email && obj.private_key ? obj : (obj && obj.client_email ? obj : null);
  } catch { return null; }
}

export function _buildJwt(sa, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(sa.private_key).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

async function fetchToken(params) {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return { ok: false, error: `token HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    return { ok: true, token: data.access_token, expiresIn: data.expires_in || 3600 };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}

// 記憶體快取（單副本假設，到期前 5 分鐘換新）
let _saCache = null;    // { token, expMs }
let _gmailCache = null; // { token, expMs }

export async function getCalendarToken() {
  if (process.env.GCAL_MOCK) return { ok: true, token: 'mock-gcal-token' };
  const sa = _parseServiceAccountJson(process.env.GCAL_SERVICE_ACCOUNT_JSON);
  if (!sa || !sa.private_key) return { ok: false, error: 'gcal_not_configured' };
  if (_saCache && Date.now() < _saCache.expMs - 5 * 60_000) return { ok: true, token: _saCache.token };
  const jwt = _buildJwt(sa, Math.floor(Date.now() / 1000));
  const r = await fetchToken({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
  if (r.ok) _saCache = { token: r.token, expMs: Date.now() + r.expiresIn * 1000 };
  return r;
}

export async function getGmailToken() {
  if (process.env.GMAIL_MOCK) return { ok: true, token: 'mock-gmail-token' };
  const { GMAIL_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GMAIL_REFRESH_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return { ok: false, error: 'gmail_not_configured' };
  }
  if (_gmailCache && Date.now() < _gmailCache.expMs - 5 * 60_000) return { ok: true, token: _gmailCache.token };
  const r = await fetchToken({
    grant_type: 'refresh_token',
    refresh_token: GMAIL_REFRESH_TOKEN,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
  });
  if (r.ok) _gmailCache = { token: r.token, expMs: Date.now() + r.expiresIn * 1000 };
  return r;
}

export function isGmailConfigured() {
  return !!process.env.GMAIL_MOCK ||
    !!(process.env.GMAIL_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
```

- [ ] **Step 4: 寫 `src/services/gcalClient.js`**（完整檔案）：

```js
// Google Calendar API v3 thin wrapper（零 npm 依賴）。
// never-throws、回傳 { ok, ... }。GCAL_MOCK=1 → 成功並記錄到 __mockCalls（測試檢查用）；
// GCAL_MOCK='fail' → { ok:false }。
import { getCalendarToken } from './googleAuth.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
export const __mockCalls = []; // 測試專用：GCAL_MOCK=1 時記錄 { fn, args }

async function authedFetch(url, options = {}) {
  const t = await getCalendarToken();
  if (!t.ok) return { ok: false, status: 0, error: t.error };
  try {
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text().catch(() => '');
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${String(text).slice(0, 200)}`, data };
  } catch (e) {
    return { ok: false, status: 0, error: `network: ${e.message}` };
  }
}

function mock(fn, args, result = { ok: true }) {
  __mockCalls.push({ fn, args });
  return result;
}

/** freebusy 查詢。timeMin/timeMax 為 RFC3339（含 +08:00）。回 { ok, busy: [{start,end}] }（RFC3339）。 */
export async function freeBusy(calendarId, timeMin, timeMax) {
  if (process.env.GCAL_MOCK === '1') return mock('freeBusy', { calendarId, timeMin, timeMax }, { ok: true, busy: [] });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const r = await authedFetch(`${BASE}/freeBusy`, {
    method: 'POST',
    body: JSON.stringify({ timeMin, timeMax, timeZone: 'Asia/Taipei', items: [{ id: calendarId }] }),
  });
  if (!r.ok) return r;
  const cal = r.data?.calendars?.[calendarId];
  if (cal?.errors?.length) return { ok: false, error: `freebusy: ${JSON.stringify(cal.errors).slice(0, 200)}` };
  return { ok: true, busy: cal?.busy || [] };
}

/** 建立事件（冪等：body.id 為決定性 ID）。409（ID 已存在/曾被刪）→ 改走 update 復活。 */
export async function insertEvent(calendarId, event) {
  if (process.env.GCAL_MOCK === '1') return mock('insertEvent', { calendarId, event });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const cal = encodeURIComponent(calendarId);
  const r = await authedFetch(`${BASE}/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(event) });
  if (r.ok) return { ok: true };
  if (r.status === 409) {
    const u = await authedFetch(`${BASE}/calendars/${cal}/events/${encodeURIComponent(event.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...event, status: 'confirmed' }),
    });
    return u.ok ? { ok: true } : u;
  }
  return r;
}

/** 刪除事件。404/410（已不存在）視為成功。 */
export async function deleteEvent(calendarId, eventId) {
  if (process.env.GCAL_MOCK === '1') return mock('deleteEvent', { calendarId, eventId });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const r = await authedFetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
  if (r.ok || r.status === 404 || r.status === 410) return { ok: true };
  return r;
}
```

- [ ] **Step 5: 跑測試** — `node tests/google-auth.test.js` ✓；加進 package.json `test`。
- [ ] **Step 6: Commit** — `feat: 零依賴 Google auth（SA JWT/refresh token）+ Calendar client`

---

### Task 5: gcalSync.js（事件生命週期 + busy 轉換 + reconcile）+ scheduler

**Files:**
- Create: `src/services/gcalSync.js`
- Modify: `src/scheduler.js`
- Test: `tests/gcal-sync.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/gcal-sync.test.js`：

```js
// gcalSync：決定性事件 ID、event body（+08:00 / transparent）、busy→牆鐘轉換、reconcile。
import assert from 'node:assert/strict';
process.env.GCAL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/services/discountService.js');
const { eventIdForBooking, buildEventBody, busyToWallClockMap, syncBookingCreate, syncBookingCancel, reconcile } =
  await import('../src/services/gcalSync.js');
const { __mockCalls } = await import('../src/services/gcalClient.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
async function expectA(label, fn){ try{await fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-sync test] start');
db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'gs-%'");
setSetting('gcal_calendar_id', 'test-cal@group.calendar.google.com');

expect('eventIdForBooking 決定性 + base32hex 字元集', () => {
  assert.equal(eventIdForBooking(123), 'chinupbk000000123');
  assert.match(eventIdForBooking(123), /^[a-v0-9]{5,}$/);
});

const uid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('小明','gs-m@x.com','user','0997111222')").run().lastInsertRowid);
const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練甲','gs-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練甲', 1)").run(cuid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 3*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount) VALUES (?, ?, ?, ?, '1on2', 2000)"
).run(coachId, uid, `${date}T14:00:00`, `${date}T15:00:00`).lastInsertRowid);

expect('buildEventBody：+08:00 / Asia/Taipei / transparent / 標題含教練與會員', () => {
  const ev = buildEventBody(bid);
  assert.equal(ev.id, eventIdForBooking(bid));
  assert.equal(ev.start.dateTime, `${date}T14:00:00+08:00`);
  assert.equal(ev.end.dateTime, `${date}T15:00:00+08:00`);
  assert.equal(ev.start.timeZone, 'Asia/Taipei');
  assert.equal(ev.transparency, 'transparent');
  assert.ok(ev.summary.includes('教練甲') && ev.summary.includes('小明') && ev.summary.includes('1對2'));
  assert.ok(ev.description.includes('0997111222'));
});

expect('busyToWallClockMap：UTC 輸入轉台北 + 跨日切割', () => {
  // 2026-07-01 06:00Z = 台北 14:00；06-30 15:00Z ~ 07-01 02:00Z = 台北 23:00 ~ 隔日 10:00（跨日）
  const m = busyToWallClockMap([
    { start: '2026-07-01T06:00:00Z', end: '2026-07-01T07:30:00Z' },
    { start: '2026-06-30T15:00:00Z', end: '2026-07-01T02:00:00Z' },
  ]);
  assert.deepEqual(m.get('2026-07-01').find(x => x.start === '14:00'), { start: '14:00', end: '15:30' });
  assert.deepEqual(m.get('2026-06-30'), [{ start: '23:00', end: '24:00' }]);
  assert.ok(m.get('2026-07-01').some(x => x.start === '00:00' && x.end === '10:00'));
});

await expectA('syncBookingCreate：mock 成功 → gcal_event_id 寫入', async () => {
  __mockCalls.length = 0;
  await syncBookingCreate(bid);
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid).gcal_event_id, eventIdForBooking(bid));
  assert.equal(__mockCalls[0].fn, 'insertEvent');
});

await expectA('syncBookingCancel：刪除 + 清欄位', async () => {
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bid);
  await syncBookingCancel(bid);
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid).gcal_event_id, null);
});

await expectA('reconcile：補建未來 confirmed 無事件者、補刪 cancelled 有事件者', async () => {
  const bid2 = Number(db.prepare(
    "INSERT INTO bookings (coach_id, member_id, start_at, end_at) VALUES (?, ?, ?, ?)"
  ).run(coachId, uid, `${date}T16:00:00`, `${date}T17:00:00`).lastInsertRowid);
  db.prepare("UPDATE bookings SET gcal_event_id='chinupbk000000999' WHERE id=?").run(bid); // cancelled + 殘留事件
  __mockCalls.length = 0;
  await reconcile();
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid2).gcal_event_id, eventIdForBooking(bid2));
  assert.equal(db.prepare('SELECT gcal_event_id FROM bookings WHERE id=?').get(bid).gcal_event_id, null);
});

expect('未設 calendar id → 整體停用（syncBookingCreate 不動作）', () => {
  setSetting('gcal_calendar_id', '');
  // isGcalEnabled=false → 不呼叫 client、不丟錯
});

db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'gs-%'");
setSetting('gcal_calendar_id', '');
console.log('[gcal-sync test] done');
```

- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 寫 `src/services/gcalSync.js`**（完整檔案）：

```js
// Google 日曆同步層：事件生命週期（冪等）、freebusy busy → 台北牆鐘、reconcile 兜底。
// DB 是唯一事實來源；日曆寫入失敗不影響預約（cron 補齊）。
import { db } from '../db/connection.js';
import { getGcalCalendarId } from './discountService.js';
import { freeBusy, insertEvent, deleteEvent } from './gcalClient.js';

const SESSION_LABELS = { '1on1': '1對1', '1on2': '1對2' };

export function isGcalEnabled() {
  if (!getGcalCalendarId()) return false;
  return !!process.env.GCAL_MOCK || !!process.env.GCAL_SERVICE_ACCOUNT_JSON;
}

/** 決定性事件 ID（Calendar id 限 base32hex：a-v0-9、長度≥5）。'chinupbk' 全字元合法。 */
export function eventIdForBooking(bookingId) {
  return 'chinupbk' + String(bookingId).padStart(9, '0');
}

const getBookingFull = db.prepare(`
  SELECT b.*, c.display_name AS coach_name, u.name AS member_name, u.phone AS member_phone
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.id = ?
`);
const setEventId = db.prepare('UPDATE bookings SET gcal_event_id = ? WHERE id = ?');

/** 組事件 body。transparency='transparent'（顯示「有空」）是關鍵：freebusy 只會
 *  抓到店家手動建立（預設忙碌）的活動，系統自己的預約不會誤鎖其他教練的同時段。 */
export function buildEventBody(bookingId) {
  const b = getBookingFull.get(bookingId);
  if (!b) return null;
  const label = SESSION_LABELS[b.session_type] || '1對1';
  const amount = b.original_amount != null
    ? (b.discount_amount ? b.original_amount - b.discount_amount : b.original_amount)
    : null;
  const lines = [
    `電話：${b.member_phone || '-'}`,
    `方案：${label}`,
    amount != null ? `金額：$${amount}${b.discount_code ? `（折扣碼 ${b.discount_code}）` : ''}` : null,
    `預約編號：#${b.id}`,
    '（chinup 系統自動建立，請勿手動修改；改動不會回寫系統）',
  ].filter(Boolean);
  return {
    id: eventIdForBooking(b.id),
    summary: `${label}教練課 ${b.coach_name}×${b.member_name}`,
    description: lines.join('\n'),
    start: { dateTime: `${b.start_at}+08:00`, timeZone: 'Asia/Taipei' },
    end: { dateTime: `${b.end_at}+08:00`, timeZone: 'Asia/Taipei' },
    transparency: 'transparent',
  };
}

/** 預約成立後呼叫（commit 後、不 await）。失敗交給 reconcile cron。 */
export async function syncBookingCreate(bookingId) {
  try {
    if (!isGcalEnabled()) return;
    const body = buildEventBody(bookingId);
    if (!body) return;
    const r = await insertEvent(getGcalCalendarId(), body);
    if (r.ok) setEventId.run(body.id, bookingId);
    else console.error('[gcal] insertEvent failed:', bookingId, r.error);
  } catch (e) { console.error('[gcal] syncBookingCreate threw:', e); }
}

/** 取消後呼叫（commit 後、不 await）。用決定性 ID，gcal_event_id 遺失也刪得掉。 */
export async function syncBookingCancel(bookingId) {
  try {
    if (!isGcalEnabled()) return;
    const r = await deleteEvent(getGcalCalendarId(), eventIdForBooking(bookingId));
    if (r.ok) setEventId.run(null, bookingId);
    else console.error('[gcal] deleteEvent failed:', bookingId, r.error);
  } catch (e) { console.error('[gcal] syncBookingCancel threw:', e); }
}

// ── freebusy → 台北牆鐘區間 ───────────────────────────────────────────
// 不依賴伺服器 TZ：epoch + 8h 後取 UTC 分量 = 台北牆鐘（台灣無 DST）。
function taipeiParts(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    ms: d.getTime(),
  };
}

/** RFC3339 busy 區間 → Map<'YYYY-MM-DD', [{start:'HH:MM', end:'HH:MM'}]>（跨日切割；
 *  迄於翌日 00:00 的段落以 end='24:00' 表示，與 slot 過濾的 toMin 相容）。 */
export function busyToWallClockMap(busyList) {
  const map = new Map();
  const push = (date, start, end) => {
    if (start === end) return;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({ start, end });
  };
  for (const b of busyList || []) {
    let s = taipeiParts(b.start);
    const e = taipeiParts(b.end);
    while (s.date < e.date) {
      push(s.date, s.hhmm, '24:00');
      const next = new Date(s.ms);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      s = { date: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`, hhmm: '00:00', ms: next.getTime() };
    }
    push(e.date, s.hhmm, e.hhmm);
  }
  return map;
}

// 60 秒 freebusy 快取（單副本假設）
const _fbCache = new Map(); // key → { at, value }
const FB_TTL_MS = 60_000;

/** 路由層用：取 [fromDate, toDate]（含）之外部忙碌區間。停用或失敗 → null（fail-open）。 */
export async function getExternalBusySafe(fromDate, toDate) {
  try {
    if (!isGcalEnabled()) return null;
    const calId = getGcalCalendarId();
    const key = `${calId}|${fromDate}|${toDate}`;
    const hit = _fbCache.get(key);
    if (hit && Date.now() - hit.at < FB_TTL_MS) return hit.value;
    // timeMax 用 toDate 翌日 00:00（+08:00）
    const d = new Date(toDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    const nextDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const r = await freeBusy(calId, `${fromDate}T00:00:00+08:00`, `${nextDate}T00:00:00+08:00`);
    if (!r.ok) { console.error('[gcal] freebusy failed (fail-open):', r.error); return null; }
    const value = busyToWallClockMap(r.busy);
    _fbCache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) { console.error('[gcal] getExternalBusySafe threw (fail-open):', e); return null; }
}

// ── reconcile cron ────────────────────────────────────────────────────
const selToCreate = db.prepare(`
  SELECT id FROM bookings
  WHERE status = 'confirmed' AND gcal_event_id IS NULL AND start_at >= ?
  ORDER BY start_at ASC LIMIT 20
`);
const selToDelete = db.prepare(`
  SELECT id FROM bookings
  WHERE status = 'cancelled' AND gcal_event_id IS NOT NULL
  ORDER BY id ASC LIMIT 20
`);

let _reconcileRunning = false; // node-cron 不序列化重疊執行（單執行緒 boolean 即安全）

export async function reconcile() {
  if (_reconcileRunning) return;
  _reconcileRunning = true;
  try {
    if (!isGcalEnabled()) return;
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    for (const row of selToCreate.all(nowStr)) await syncBookingCreate(row.id);
    for (const row of selToDelete.all()) await syncBookingCancel(row.id);
  } finally { _reconcileRunning = false; }
}
```

- [ ] **Step 4: scheduler.js** — import 加 `import { reconcile } from './services/gcalSync.js';`，backup cron 之前加：

```js
  // 每 5 分鐘：Google 日曆 reconcile（補建/補刪；功能未啟用時內部直接 return）
  cron.schedule('*/5 * * * *', async () => {
    try {
      await reconcile();
    } catch (e) {
      console.error('[scheduler] gcal reconcile error:', e);
    }
  });
```

- [ ] **Step 5: 跑測試** — `node tests/gcal-sync.test.js` ✓；加進 package.json `test`。
- [ ] **Step 6: Commit** — `feat: gcal 同步層（冪等事件/busy 轉換/reconcile cron）`

---

### Task 6: 路由驗證管線 + availability 端點注入 freebusy + cancel hooks

**Files:**
- Modify: `src/server.js`（POST /api/public/bookings、2 個 availability 端點、2 個 cancel 端點）
- Modify: `tests/discount-api.test.js`（補 rule）
- Test: `tests/booking-validate-api.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/booking-validate-api.test.js`：

```js
// 預約送出驗證管線（API 層）：off-grid 409、email 入庫、invalid_email 400。
// 需先起 server：LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule } from '../src/services/availabilityService.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-validate-api test] start');

db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0997%'); DELETE FROM users WHERE phone LIKE '0997%' OR email LIKE 'bv-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('BV Coach','bv-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BV', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 4*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });

const av = await req('GET', `/api/coaches/${coachId}/availability?from=${date}&to=${date}`);
expect('availability 回 {start, remain} 物件陣列', () => {
  assert.equal(av.status, 200);
  assert(Array.isArray(av.data) && av.data.length > 0);
  assert(typeof av.data[0].start === 'string' && typeof av.data[0].remain === 'number');
});

const offGrid = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T05:00:00`, name: '越界', phone: '0997000111' } });
expect('班表外時段 → 409 slot_unavailable', () => {
  assert.equal(offGrid.status, 409);
  assert.equal(offGrid.data.error, 'slot_unavailable');
});

const badEmail = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '壞信', phone: '0997000222', email: 'oops' } });
expect('email 格式錯 → 400 invalid_email', () => {
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.data.error, 'invalid_email');
});

const ok = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '王小信', phone: '0997000333', email: 'ok@example.com' } });
expect('合法預約 + email → 201 且入庫', () => {
  assert.equal(ok.status, 201);
  assert.equal(db.prepare('SELECT customer_email FROM bookings WHERE id=?').get(ok.data.id).customer_email, 'ok@example.com');
});

const dup = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '撞期', phone: '0997000444' } });
expect('同教練同時段 → 409（slot_unavailable 或 slot_taken）', () => {
  assert.equal(dup.status, 409);
  assert(['slot_unavailable', 'slot_taken'].includes(dup.data.error));
});

db.exec("DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0997%' OR email LIKE 'bv-%'");
console.log('[booking-validate-api test] done');
```

- [ ] **Step 2: server.js — POST /api/public/bookings 完整替換**（740-744 行）：

```js
app.post('/api/public/bookings', asyncHandler(async (req, res) => {
  const { coachId, startAt, name, phone, note, discountCode, sessionType, email } = req.body || {};
  const type = sessionType || '1on1';
  // 檢查順序維持既有契約：coach(404/409) → phone(400) → 時段(409) → service
  const coach = svcGetCoach(Number(coachId));
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  if (!coach.is_active) return res.status(409).json({ error: 'coach_inactive' });
  if (!isValidPhone(String(phone || ''))) return res.status(400).json({ error: 'invalid_phone', detail: '電話需為 8-15 碼數字' });
  if (typeof startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(startAt)) {
    return res.status(400).json({ error: 'invalid_start_at' });
  }
  // 時段合法性（班表/請假/緩衝/視窗 + 容量 + Google freebusy）。
  // freebusy 失敗 → fail-open（getExternalBusySafe 回 null，退回純 DB 檢查）。
  const date = startAt.slice(0, 10);
  const externalBusy = await getExternalBusySafe(date, date);
  const units = type === '1on2' ? 2 : 1;
  const slots = svcComputeSlots({ coachId: coach.id, fromDate: date, toDate: date, externalBusy });
  const hit = slots.find(s => s.start === startAt);
  if (!hit || hit.remain < units) return res.status(409).json({ error: 'slot_unavailable' });

  const r = svcCreateBookingAnon({ coachId: coach.id, startAt, name, phone, note: note || null, discountCode: discountCode || null, sessionType: type, email: email || null });
  // commit 後副作用（不 await、不持鎖；比照 notify() 慣例）
  syncBookingCreate(r.id);
  if (email) sendBookingConfirmation(r.id);
  res.status(201).json(r);
}));
```

import 區補：

```js
import { isValidPhone } from './services/userService.js';
import { getExternalBusySafe, syncBookingCreate, syncBookingCancel } from './services/gcalSync.js';
import { sendBookingConfirmation } from './services/emailService.js';
```

（`sendBookingConfirmation` 於 Task 7 建立；本 Task 先建立佔位：`src/services/emailService.js` 內容只有 `export async function sendBookingConfirmation() {}` — Task 7 完整實作。）
- [ ] **Step 3: availability 端點注入 freebusy**（兩處改 async）：

```js
app.get('/api/coach/me/availability-preview', requireCoach, asyncHandler(async (req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  const externalBusy = await getExternalBusySafe(from, to);
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to, externalBusy }));
}));
```

`GET /api/coaches/:id/availability` 同樣模式（795-801 行）。
- [ ] **Step 4: cancel hooks** — `DELETE /api/public/bookings/:id`（762-765 行）改：

```js
app.delete('/api/public/bookings/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  const id = Number(req.params.id);
  const r = svcCancelBookingAnon({ bookingId: id, phone, name });
  syncBookingCancel(id); // commit 後（svcCancel 的 tx 已結束）、不 await
  res.json(r);
}));
```

`DELETE /api/bookings/:id`（教練緊急取消，804-820 行）在 `svcCancelBooking({...})` 之後、`res.json` 之前加一行 `syncBookingCancel(id);`。
- [ ] **Step 5: 修 `tests/discount-api.test.js`** — booking 區塊（~180 行起）在取得 activeCoach 之後、futureStart 預約之前，補 rule（檔頭 import 區加 `import { addRule } from '../src/services/availabilityService.js';`，並比照 staff-line-bind-api.test.js 的 `import { db } from '../src/db/connection.js';` 精神——API 測試行程可直接寫共用 DB）：

```js
if (activeCoach) {
  const d7 = new Date(); d7.setDate(d7.getDate() + 7);
  // 冪等：重跑測試不累積重複 rule
  const hasRule = db.prepare('SELECT 1 FROM coach_availability_rules WHERE coach_id=? AND day_of_week=?').get(activeCoach.id, d7.getDay());
  if (!hasRule) addRule({ coachId: activeCoach.id, dayOfWeek: d7.getDay(), startTime: '09:00', endTime: '18:00' });
}
```

- [ ] **Step 6: 跑 API 測試** — 起 server（`LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js`）後：`BASE=http://localhost:3100 node tests/booking-validate-api.test.js && BASE=http://localhost:3100 node tests/public-api.test.js && BASE=http://localhost:3100 node tests/discount-api.test.js` 全 ✓。booking-validate-api.test.js 加進 package.json `test:api`。
- [ ] **Step 7: Commit** — `feat: 預約路由驗證管線（時段合法性+freebusy）+ 取消同步 hooks`

---

### Task 7: gmailClient + emailService（確認信）+ notifications email channel 重試

**Files:**
- Create: `src/services/gmailClient.js`
- Modify: `src/services/emailService.js`（Task 6 的佔位 → 完整實作）
- Modify: `src/services/notifications.js`（selectDueFailed 撈 channel/recipient/subject；retry 分流）
- Test: `tests/email-confirmation.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/email-confirmation.test.js`：

```js
// 確認信：RFC822 組裝、寄送→notifications(email) 列、失敗退避、retry 分流。
import assert from 'node:assert/strict';
process.env.GMAIL_MOCK = '1';
const { db, nowLocal, offsetLocal } = await import('../src/db/connection.js');
const { _buildRawMessage } = await import('../src/services/gmailClient.js');
const { sendBookingConfirmation, _buildConfirmationHtml } = await import('../src/services/emailService.js');
const { processFailedNotifications } = await import('../src/services/notifications.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
async function expectA(label, fn){ try{await fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[email-confirmation test] start');
db.exec("DELETE FROM notifications WHERE channel='email'; DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'em-%' OR phone='0996123123'");

expect('RFC822：Subject RFC2047、To、HTML base64、base64url 輸出', () => {
  const raw = _buildRawMessage({ to: 'a@b.c', subject: '預約確認', html: '<b>哈囉</b>' });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(decoded.includes('To: a@b.c'));
  assert.ok(decoded.includes(`Subject: =?UTF-8?B?${Buffer.from('預約確認').toString('base64')}?=`));
  assert.ok(decoded.includes('Content-Type: text/html; charset=UTF-8'));
  assert.ok(decoded.includes(Buffer.from('<b>哈囉</b>').toString('base64')));
});

const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練乙','em-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練乙', 1)").run(cuid).lastInsertRowid);
const uid = Number(db.prepare("INSERT INTO users (name,role,phone) VALUES ('陳小美','user','0996123123')").run().lastInsertRowid);
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, discount_amount, discount_code, customer_email) VALUES (?, ?, '2026-07-01T14:00:00', '2026-07-01T15:00:00', '1on1', 1500, 100, 'TEST', 'mei@example.com')"
).run(coachId, uid).lastInsertRowid);

expect('HTML 內容含教練/時間/折後金額/匯款資訊', () => {
  const html = _buildConfirmationHtml(bid);
  assert.ok(html.includes('教練乙'));
  assert.ok(html.includes('2026/07/01'));
  assert.ok(html.includes('14:00'));
  assert.ok(html.includes('1,400') || html.includes('1400'));
  assert.ok(html.includes('合作金庫'));
});

await expectA('GMAIL_MOCK=1 寄送 → notifications channel=email status=sent + recipient', async () => {
  await sendBookingConfirmation(bid);
  const row = db.prepare("SELECT * FROM notifications WHERE channel='email' AND user_id=? ORDER BY id DESC").get(uid);
  assert.ok(row);
  assert.equal(row.status, 'sent');
  assert.equal(row.recipient, 'mei@example.com');
  assert.equal(row.type, 'booking_email_confirmation');
});

await expectA('GMAIL_MOCK=fail → failed + next_retry_at；retry（mock 復原）→ sent', async () => {
  process.env.GMAIL_MOCK = 'fail';
  await sendBookingConfirmation(bid);
  const row = db.prepare("SELECT * FROM notifications WHERE channel='email' AND status='failed' AND user_id=?").get(uid);
  assert.ok(row && row.next_retry_at);
  process.env.GMAIL_MOCK = '1';
  db.prepare("UPDATE notifications SET next_retry_at=? WHERE id=?").run(offsetLocal(-60_000), row.id);
  await processFailedNotifications();
  assert.equal(db.prepare('SELECT status FROM notifications WHERE id=?').get(row.id).status, 'sent');
});

db.exec("DELETE FROM notifications WHERE channel='email'; DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'em-%' OR phone='0996123123'");
console.log('[email-confirmation test] done');
```

- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 寫 `src/services/gmailClient.js`**（完整檔案）：

```js
// Gmail API v1 寄信 wrapper（零 npm 依賴）。GMAIL_MOCK=1 → 成功；'fail' → 失敗。
// From 預設省略（Gmail 自動帶授權帳號）；要顯示名稱可設 GMAIL_FROM（如
// "CHINUP Performance <gym@gmail.com>"，位址必須是授權帳號本人或其別名）。
import { getGmailToken } from './googleAuth.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export function _buildRawMessage({ to, subject, html }) {
  const subjB64 = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const headers = [];
  if (process.env.GMAIL_FROM) headers.push(`From: ${process.env.GMAIL_FROM}`);
  headers.push(
    `To: ${to}`,
    `Subject: ${subjB64}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  );
  const msg = headers.join('\r\n') + '\r\n\r\n' + Buffer.from(html).toString('base64');
  return Buffer.from(msg).toString('base64url');
}

/** 寄一封 HTML 信。回傳 { ok } 或 { ok:false, error }，never throws。 */
export async function sendMail({ to, subject, html }) {
  if (process.env.GMAIL_MOCK === '1') return { ok: true };
  if (process.env.GMAIL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const t = await getGmailToken();
  if (!t.ok) return { ok: false, error: t.error };
  try {
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: _buildRawMessage({ to, subject, html }) }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}
```

- [ ] **Step 4: `src/services/emailService.js` 完整實作**：

```js
// 1對1 預約確認信。寄送結果寫 notifications（channel='email'）重用既有退避重試。
// Gmail 未設定（無 refresh token）→ 比照 LINE console fallback：寫 console 列、不報錯。
import { db, offsetLocal } from '../db/connection.js';
import { sendMail } from './gmailClient.js';
import { isGmailConfigured } from './googleAuth.js';
import { getBankInfo, getLineOfficialUrl } from './discountService.js';

const getBookingFull = db.prepare(`
  SELECT b.*, c.display_name AS coach_name, u.name AS member_name
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.id = ?
`);
const insertNotif = db.prepare(`
  INSERT INTO notifications (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error, recipient)
  VALUES (?, NULL, 'booking_email_confirmation', ?, ?, ?, ?, 0, ?, ?, ?)
`);

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function _buildConfirmationHtml(bookingId) {
  const b = getBookingFull.get(bookingId);
  if (!b) return null;
  const [date, time] = b.start_at.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const label = b.session_type === '1on2' ? '1對2' : '1對1';
  const final = b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null;
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const lineUrl = getLineOfficialUrl();
  const rows = [
    ['教練', b.coach_name],
    ['時間', `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（週${dow}）${time.slice(0, 5)}–${b.end_at.split('T')[1].slice(0, 5)}`],
    ['方案', label],
    final != null ? ['現場應付', `$${final.toLocaleString()}${b.discount_code ? `（已套用折扣碼 ${esc(b.discount_code)}）` : ''}`] : null,
    ['匯款資訊', getBankInfo()],
  ].filter(Boolean);
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="color:#0369a1">CHINUP Performance 預約確認</h2>
  <p>${esc(b.member_name)} 您好，已為您完成以下預約：</p>
  <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap">${k}</td><td style="padding:6px 0"><strong>${esc(v)}</strong></td></tr>`).join('')}
  </table>
  <p style="color:#64748b;font-size:14px">如需取消，請至 <a href="${esc(publicUrl)}/my-schedule">我的課表</a> 以姓名＋電話查詢後操作。</p>
  ${lineUrl ? `<p style="font-size:14px"><a href="${esc(lineUrl)}">加入官方 LINE</a> 可收上課提醒與最新通知。</p>` : ''}
  <p style="color:#94a3b8;font-size:12px">此信由系統自動發送，請勿直接回覆。</p>
</div>`;
}

/** 預約成立後呼叫（commit 後、不 await）。 */
export async function sendBookingConfirmation(bookingId) {
  try {
    const b = getBookingFull.get(bookingId);
    if (!b || !b.customer_email) return;
    const subject = `預約確認｜${b.start_at.slice(5, 10).replace('-', '/')} ${b.start_at.slice(11, 16)} ${b.coach_name} 教練`;
    const html = _buildConfirmationHtml(bookingId);
    if (!isGmailConfigured()) {
      // 未設定 Gmail → console fallback（與 LINE 未綁定同精神），測試/未啟用環境不產生 failed 列
      insertNotif.run(b.member_id, 'console', subject, html, 'sent', null, null, b.customer_email);
      console.log(`[email→console] booking=${bookingId} to=${b.customer_email} ${subject}`);
      return;
    }
    const r = await sendMail({ to: b.customer_email, subject, html });
    if (r.ok) {
      insertNotif.run(b.member_id, 'email', subject, html, 'sent', null, null, b.customer_email);
    } else {
      insertNotif.run(b.member_id, 'email', subject, html, 'failed', offsetLocal(5 * 60_000), r.error, b.customer_email);
    }
  } catch (e) { console.error('[email] sendBookingConfirmation threw:', e); }
}
```

注意：測試環境 `GMAIL_MOCK=1` 時 `isGmailConfigured()` 回 true（googleAuth 已涵蓋），會走 email channel ✓。
- [ ] **Step 5: notifications.js retry 分流** —
  - `selectDueFailed` SQL 的 SELECT 欄位加 `channel, subject, recipient`。
  - `processFailedNotifications` 迴圈改為：

```js
    for (const row of due) {
      let result;
      if (row.channel === 'email') {
        if (!row.recipient) { updateFailedPermanent.run('no_recipient', row.id); continue; }
        result = await sendEmailRetry(row);
      } else {
        const user = getUserById.get(row.user_id);
        if (!user?.line_user_id) {
          // user removed binding (or was deleted) → no point retrying
          updateFailedPermanent.run('user_not_bound', row.id);
          continue;
        }
        result = await sendMessage(user.line_user_id, row.body);
      }

      if (result.ok) {
        updateSent.run(row.id);
      } else {
        const newRetryCount = row.retry_count + 1;
        if (newRetryCount > MAX_RETRIES) {
          updateFailedPermanent.run(result.error, row.id);
        } else {
          updateFailedAgain.run(newRetryCount, nextBackoffAt(newRetryCount), result.error, row.id);
        }
      }
    }
```

  - 檔尾加（避免循環 import 用動態載入；emailService 不 import notifications，其實可直接靜態 import gmailClient——採後者）：檔頭加 `import { sendMail as sendGmail } from './gmailClient.js';`，並加：

```js
async function sendEmailRetry(row) {
  return sendGmail({ to: row.recipient, subject: row.subject || '通知', html: row.body || '' });
}
```

- [ ] **Step 6: 跑測試** — `node tests/email-confirmation.test.js && node tests/notifications-flow.test.js` ✓；前者加進 package.json `test`。
- [ ] **Step 7: Commit** — `feat: Gmail 確認信 + notifications email channel 重試`

---

### Task 8: Gmail OAuth 一次性授權路由（admin）

**Files:**
- Modify: `src/server.js`（2 個路由，放在既有 Google OAuth 區塊之後）
- Test: `tests/gmail-auth-api.test.js`（新）

- [ ] **Step 1: 寫失敗測試** `tests/gmail-auth-api.test.js`（API 測試，比照 member-admin-api 的 admin 登入模式——讀檔對齊既有 login helper 寫法）：

```js
// Gmail 授權路由：start 需 admin、回授權 URL；callback 壞 state → 400。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gmail-auth-api test] start');

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const noAuth = await req('POST', '/api/admin/gmail-auth/start');
expect('未登入 start → 401', () => assert.equal(noAuth.status, 401));

const start = await req('POST', '/api/admin/gmail-auth/start', { token });
expect('start 回授權 URL（gmail.send + offline + consent）', () => {
  assert.equal(start.status, 200);
  assert.ok(String(start.data.url).includes('accounts.google.com'));
  assert.ok(String(start.data.url).includes(encodeURIComponent('https://www.googleapis.com/auth/gmail.send')));
  assert.ok(String(start.data.url).includes('access_type=offline'));
  assert.ok(String(start.data.url).includes('prompt=consent'));
});

const badCb = await req('GET', '/api/admin/gmail-auth/callback?code=x&state=bogus');
expect('callback 壞 state → 400', () => assert.equal(badCb.status, 400));
console.log('[gmail-auth-api test] done');
```

（若測試環境 admin 密碼非預設，依 member-admin-api.test.js 的既有作法取得 token。）
- [ ] **Step 2: server.js 路由**（Google OAuth callback 區塊之後加）：

```js
// ── Gmail 寄信授權（一次性）──────────────────────────────────────────
// 後台按鈕 → start 取授權 URL → Google 同意 → callback 一次性顯示 refresh token，
// 由業主自行貼到 Railway 環境變數 GMAIL_REFRESH_TOKEN（不落 DB、不寫檔）。
const gmailAuthStates = new Map();
app.post('/api/admin/gmail-auth/start', requireAdmin, (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'google_not_configured' });
  const state = randomBytes(16).toString('hex');
  gmailAuthStates.set(state, Date.now());
  for (const [k, ts] of gmailAuthStates) {
    if (Date.now() - ts > 10 * 60 * 1000) gmailAuthStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: gmailRedirectUri(req),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

function gmailRedirectUri(req) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/api/admin/gmail-auth/callback`;
  return `${req.protocol}://${req.get('host')}/api/admin/gmail-auth/callback`;
}

app.get('/api/admin/gmail-auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`授權失敗：${String(error)}`);
    if (!code || !state || !gmailAuthStates.has(String(state))) return res.status(400).send('授權連結無效或已過期，請回後台重新發起。');
    gmailAuthStates.delete(String(state));
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: gmailRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.refresh_token) {
      console.error('[gmail-auth] token exchange failed:', tokens);
      return res.status(400).send('未取得 refresh token。請確認 OAuth 同意畫面已發布正式版，並於授權時勾選同意；如先前已授權過，請至 Google 帳號「安全性→第三方存取」移除本應用程式後重試。');
    }
    res.send(`<!DOCTYPE html><html lang="zh-TW"><meta charset="UTF-8"><body style="font-family:sans-serif;max-width:640px;margin:40px auto">
<h2>Gmail 寄信授權成功</h2>
<p>請把下方 refresh token 完整複製，貼到 Railway 環境變數 <code>GMAIL_REFRESH_TOKEN</code>，存檔後服務會自動重啟生效。</p>
<p><strong>此 token 僅顯示這一次，本系統不會儲存。</strong>完成後請關閉此頁。</p>
<textarea readonly style="width:100%;height:90px;font-size:13px" onclick="this.select()">${tokens.refresh_token}</textarea>
</body></html>`);
  } catch (e) {
    console.error('[gmail-auth] callback error:', e);
    res.status(500).send('授權處理失敗，請回後台重試。');
  }
});
```

- [ ] **Step 3: 跑 API 測試** — `BASE=http://localhost:3100 node tests/gmail-auth-api.test.js` ✓；加進 `test:api`。
- [ ] **Step 4: Commit** — `feat: Gmail 一次性授權路由（refresh token 不落地）`

---

### Task 9: settings API + admin UI（日曆 ID / 容量 / Gmail 授權鈕）

**Files:**
- Modify: `src/server.js`（settingsPayload + PATCH 驗證）
- Modify: `public/admin.html`、`public/admin.js`
- Modify: `tests/member-admin-api.test.js` 不動；新斷言加進 `tests/gmail-auth-api.test.js` 或新 `tests/settings-gcal-api.test.js`（擇後者，小檔）

- [ ] **Step 1: 寫失敗測試** `tests/settings-gcal-api.test.js`：

```js
// settings 新 key：gcal_calendar_id / booking_hourly_capacity 驗證與寫入。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[settings-gcal-api test] start');
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const g0 = await req('GET', '/api/admin/settings', { token });
expect('GET 含 gcal_calendar_id 與 booking_hourly_capacity', () => {
  assert.equal(g0.status, 200);
  assert.ok('gcal_calendar_id' in g0.data);
  assert.ok('booking_hourly_capacity' in g0.data);
});
const p1 = await req('PATCH', '/api/admin/settings', { token, body: { gcal_calendar_id: 'abc@group.calendar.google.com', booking_hourly_capacity: 4 } });
expect('PATCH 寫入成功', () => {
  assert.equal(p1.status, 200);
  assert.equal(p1.data.gcal_calendar_id, 'abc@group.calendar.google.com');
  assert.equal(p1.data.booking_hourly_capacity, 4);
});
const pBad = await req('PATCH', '/api/admin/settings', { token, body: { booking_hourly_capacity: 0 } });
expect('容量 0 → 400', () => assert.equal(pBad.status, 400));
// 還原（避免影響其他測試/環境）
await req('PATCH', '/api/admin/settings', { token, body: { gcal_calendar_id: '', booking_hourly_capacity: 3 } });
console.log('[settings-gcal-api test] done');
```

- [ ] **Step 2: server.js** — `settingsPayload()` 加兩行：

```js
    gcal_calendar_id: getGcalCalendarId(),
    booking_hourly_capacity: getBookingHourlyCapacity(),
```

（import 區補 `getGcalCalendarId, getBookingHourlyCapacity`，沿用 discountService 既有 import 行。）PATCH handler 的 `line_official_url` 區塊之後加：

```js
  if (b.gcal_calendar_id !== undefined) {
    const v = String(b.gcal_calendar_id).trim();
    writes.push(['gcal_calendar_id', v]); // 空字串 = 關閉日曆同步
  }
  if (b.booking_hourly_capacity !== undefined) {
    const n = Number(b.booking_hourly_capacity);
    if (!Number.isInteger(n) || n < 1 || n > 99) return res.status(400).json({ error: 'invalid_capacity' });
    writes.push(['booking_hourly_capacity', String(n)]);
  }
```

- [ ] **Step 3: admin.html** — 「收款與 LINE 設定」卡片之後加：

```html
    <!-- Google 日曆整合 + 時段容量 -->
    <div class="card mb-4">
      <div class="font-semibold mb-3">Google 日曆與時段容量</div>
      <label class="form-label" for="gcal-calendar-id">Google 日曆 ID（留空 = 關閉日曆同步；日曆需先共用給 Service Account「進行變更」）</label>
      <input id="gcal-calendar-id" type="text" class="form-input mb-3" style="width:100%;" placeholder="xxx@group.calendar.google.com 或 Gmail 位址">
      <div class="flex items-center gap-3 flex-wrap mb-3">
        <label class="form-label mb-0" for="booking-hourly-capacity">每小時容量上限（全店、跨教練；1對2 佔 2 名額）</label>
        <input id="booking-hourly-capacity" type="number" min="1" max="99" step="1" class="form-input" style="width:90px;" placeholder="3">
      </div>
      <div class="flex items-center gap-3 flex-wrap">
        <button id="save-gcal-settings" class="btn btn-primary btn-sm">儲存</button>
        <button id="gmail-auth-btn" class="btn btn-secondary btn-sm">Gmail 寄信授權</button>
      </div>
      <p class="text-xs text-slate-500 mt-2">「Gmail 寄信授權」會開啟 Google 同意畫面，完成後頁面會顯示 refresh token，請自行貼到 Railway 環境變數 GMAIL_REFRESH_TOKEN。</p>
    </div>
```

- [ ] **Step 4: admin.js** — `loadOneOnOnePrice()` 內補載入兩欄；`save-bank-line` handler 之後加：

```js
document.getElementById('save-gcal-settings')?.addEventListener('click', async () => {
  const gcal_calendar_id = (document.getElementById('gcal-calendar-id')?.value || '').trim();
  const cap = Number(document.getElementById('booking-hourly-capacity')?.value);
  if (!Number.isInteger(cap) || cap < 1 || cap > 99) {
    toast('容量需為 1–99 的整數', 'error');
    return;
  }
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { gcal_calendar_id, booking_hourly_capacity: cap } });
    toast('Google 日曆與容量設定已更新', 'success');
  } catch (e) {
    toast(`儲存失敗：${escapeHtml(e.message)}`, 'error');
  }
});

document.getElementById('gmail-auth-btn')?.addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/gmail-auth/start', { method: 'POST' });
    window.location.href = r.url;
  } catch (e) {
    toast(`無法發起授權：${escapeHtml(e.message)}`, 'error');
  }
});
```

`loadOneOnOnePrice` 內（lineInput 之後）：

```js
    const gcalInput = document.getElementById('gcal-calendar-id');
    if (gcalInput) gcalInput.value = r.gcal_calendar_id ?? '';
    const capInput = document.getElementById('booking-hourly-capacity');
    if (capInput) capInput.value = r.booking_hourly_capacity ?? 3;
```

- [ ] **Step 5: 跑 API 測試** — `BASE=http://localhost:3100 node tests/settings-gcal-api.test.js` ✓；加進 `test:api`。
- [ ] **Step 6: Commit** — `feat: 後台 Google 日曆/容量設定 + Gmail 授權入口`

---

### Task 10: 前端預約流程（coaches.html / coaches.js）

**Files:**
- Modify: `public/coaches.html`（email 欄位）
- Modify: `public/coaches.js`（slot 物件、1對2 名額守門、email、錯誤碼）

無自動化測試（純前端），以瀏覽器手動煙測為準（最後 Task 11 一併）。

- [ ] **Step 1: coaches.html** — 電話 label 之後（`modal-price-row` 之前）加：

```html
      <label class="block mb-3">
        <span class="text-sm font-medium text-slate-700">Email（選填，填寫將寄送預約確認信）</span>
        <input id="modal-email" type="email" inputmode="email" class="mt-1 w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" placeholder="example@email.com">
        <span id="modal-email-err" class="text-xs text-red-500 mt-1 block"></span>
      </label>
```

- [ ] **Step 2: coaches.js — slot 物件化**。API 現在回 `[{start, remain}]`：
  - 註解更新：`slotCacheByCoach` 存物件陣列。
  - `renderSlotsInto`：`slots.slice(0,3).map((s) => ...)` 內 `fmtMiniSlot(s.start)`、`data-slot="${escapeHtml(s.start)}" data-remain="${s.remain}"`；點擊 handler 改 `openBookingModal(coach, { start: el.dataset.slot, remain: Number(el.dataset.remain) })`。
  - `renderDayRail`：`isoToDateKey(s.start)`；`weekSlotsByDate[key].push(s)`（存物件）。
  - `renderTimegrid`：`el.dataset.slot = s.start; el.dataset.remain = s.remain;`、`fmtTime(s.start)`；`t-sub` 改為 `60 分鐘${s.remain === 1 ? ' · 剩 1 名額' : ''}`；trigger 改 `openBookingModal(currentCoach, { start: s.start, remain: s.remain })`。
  - `removeSlotFromGrid(slotStart)`：比較 `el.dataset.slot === slotStart`、過濾 `weekSlotsByDate[key].filter((s) => s.start !== slotStart)`。
- [ ] **Step 3: coaches.js — modal 守門 + email + 錯誤碼**：
  - `let modalSlot = null;` 註解改存 `{ start, remain }`；`openBookingModal(coach, slot)` 內 `modalSlot = slot;`、`fmtDate(slot.start)`、清空 `$('modal-email').value = ''; $('modal-email-err').textContent = '';`。
  - `setSessionType`：開頭加守門：

```js
  if (type === '1on2' && modalSlot && modalSlot.remain < 2) {
    $('modal-general-err').textContent = '此時段僅剩 1 個名額，無法選擇 1對2，請改選其他時段。';
    return;
  }
  $('modal-general-err').textContent = '';
```

  - `openBookingModal` 內 `refreshSessionTypeButtons()` 之前：1對2 鈕禁用樣式：

```js
  const btn1on2 = document.querySelector('#modal-session-type .session-type-btn[data-type="1on2"]');
  if (btn1on2) {
    const disabled = slot.remain < 2;
    btn1on2.disabled = disabled;
    btn1on2.classList.toggle('opacity-40', disabled);
    btn1on2.title = disabled ? '此時段僅剩 1 個名額' : '';
  }
```

  - submit handler：email 驗證 + 帶入 body：

```js
  const emailVal = $('modal-email').value.trim();
  if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
    $('modal-email-err').textContent = 'Email 格式不正確';
    hasErr = true;
  }
```

  body：`startAt: modalSlot.start`，加 `if (emailVal) bookingBody.email = emailVal;`。
  - 錯誤碼 mapping：`slot_taken` 分支沿用（`removeSlotFromGrid(modalSlot.start)`）；之後加：

```js
    } else if (errCode === 'slot_unavailable' || errCode === 'slot_full') {
      $('modal-general-err').textContent = '此時段已額滿或不可預約，請重新選擇時段。';
      removeSlotFromGrid(modalSlot?.start);
      slotCacheByCoach.delete(modalCoach?.id);
      if (currentCoach && !views.detail.classList.contains('hidden')) loadSlots();
    } else if (errCode === 'invalid_email') {
      $('modal-email-err').textContent = 'Email 格式不正確';
```

  - submit 成功路徑：`showSuccessView(result, bookedCoach, bookedSlot)` 的 `bookedSlot = modalSlot` 改傳 `modalSlot.start`（變數承接時 `.start`），`removeSlotFromGrid(bookedSlot)` 收字串。
  - `showSuccessView`：時間列照舊（slot 已是字串）；`paymentHtml` 之後加 email 提示：

```js
  const emailLine = bookingResult.customerEmail
    ? `<div class="mt-2 text-sm text-slate-500">確認信將寄至 ${escapeHtml(bookingResult.customerEmail)}（未收到請檢查垃圾信件匣）</div>` : '';
```

  並插入 `${emailLine}` 於 `${paymentHtml}` 之後。配套：`bookingService.createBookingAnon` 回傳值加 `r.customerEmail = email || null;`（Task 3 已動該檔者補上；若未補，於本 Task 補上並跑 `node tests/booking-anon.test.js` 確認不破）。
- [ ] **Step 4: Commit** — `feat: 前端 email 選填 + 名額顯示/1對2 守門 + 新錯誤碼`

---

### Task 11: TZ / Dockerfile / .env.example / boot log + 全測試 + 收尾

**Files:**
- Modify: `Dockerfile`、`.env.example`、`src/server.js`（boot log）

- [ ] **Step 1: Dockerfile** — `WORKDIR /app` 之後加：

```dockerfile
# 全系統時間為台北牆鐘字串；容器時區必須對齊（Node/V8 讀 TZ 不需 OS tzdata）
ENV TZ=Asia/Taipei
```

- [ ] **Step 2: .env.example** — 檔尾加：

```bash
# 伺服器時區（prod 必設；本機 macOS 已是本地時區可不設）
TZ=Asia/Taipei

# Google Calendar（Service Account JSON 金鑰：原始 JSON 或 base64 皆可）
# 日曆 ID 在後台「設定」填寫；留空 = 關閉日曆同步
GCAL_SERVICE_ACCOUNT_JSON=

# Gmail 確認信（沿用 GOOGLE_CLIENT_ID/SECRET；refresh token 由後台「Gmail 寄信授權」取得）
GMAIL_REFRESH_TOKEN=
# 寄件顯示名稱（選填，格式：CHINUP Performance <your@gmail.com>，位址須為授權帳號）
GMAIL_FROM=

# 測試用 mock 開關（離線）：GCAL_MOCK=1 GMAIL_MOCK=1 LINE_MOCK=1
```

- [ ] **Step 3: server.js boot log** — `app.listen` callback 的 `console.log` 之後加：

```js
    console.log(`[server] tz=${Intl.DateTimeFormat().resolvedOptions().timeZone} now=${new Date().toString()}`);
```

- [ ] **Step 4: 全套測試** — `npm test`（全綠，flaky case 除外）；起 server 後 `npm run test:api`（BASE=…）全綠。
- [ ] **Step 5: 重新 seed demo 資料**（`npm test` 會清掉）：`npm run seed`。
- [ ] **Step 6: Commit** — `chore: TZ=Asia/Taipei + env 範例 + boot 時區 log`

---

## 完成後（不在本計畫內、由主流程處理）

1. 開 draft PR（標題：Google Calendar 整合 + 時段容量限制；body 末尾 🤖 Generated with [Claude Code](https://claude.com/claude-code)）。
2. 本機瀏覽器手動煙測（業主 gate）：預約流程含 email、1對2 名額守門、後台設定卡、Gmail 授權鈕（到同意畫面即可）。
3. 業主 Google Cloud 設定（spec §12 清單）→ merge → Railway 部署 → prod 驗證。
