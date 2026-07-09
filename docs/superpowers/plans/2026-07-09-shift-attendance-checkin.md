# 駐場打卡與時薪整合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教練掃館內 QR → `/checkin` 頁 GPS 打卡 → 依固定週班表自動計時數 → 月結乘各自時薪併入後台「薪資計算」頁籤。

**Architecture:** 新增 `coach_shifts`（固定週班表，含生效起迄）與 `shift_attendance`（出席紀錄，起訖/時數快照＋軟刪註銷）兩表與 `coaches.hourly_rate` 欄位；新 service `src/services/shiftService.js` 集中班表比對、打卡、補登、註銷、期別彙總；`payrollService.computePayroll` 併入 shift 區塊；教練端獨立輕量頁 `/checkin`，管理端全部收在既有薪資頁籤。

**Tech Stack:** Node 24 ESM、Express、`node:sqlite`（DatabaseSync）、無前端框架（原生 JS 靜態頁）、測試為 `assert/strict` 純腳本。

**Spec:** `docs/superpowers/specs/2026-07-09-shift-attendance-checkin-design.md`（本計畫的唯一需求來源）

## Global Constraints

- 分支：`feature/shift-attendance-checkin`（已存在，spec 已 commit 於其上）。每個 Task 結尾 commit，訊息結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 全系統時間＝台北牆鐘字串 `'YYYY-MM-DDTHH:mm:ss'`（`nowLocal()`，prod 容器 `TZ=Asia/Taipei`）；日期字串 `'YYYY-MM-DD'`、時間字串 `'HH:MM'`。禁止使用 UTC ISO（`toISOString()`）當本地日期。
- 錯誤一律 `throw new ApiError(status, code, detail?)`（`import { ApiError } from './registration.js'`）；HTTP 端點由既有 `asyncHandler`/`handleError` 統一轉 JSON `{ error, detail }`。
- 身分驗證＝`Authorization: Bearer <token>`，前端 token 存 `localStorage['chinup.token']`；登入頁支援 `?redirect=` 導回。
- **打卡端點不得使用 `resolveCoach`**（防管理者代選身分打卡）；一律 `loadCoachForUser(req, res)`。
- DB 慣例：prepared statements 宣告在 service 模組頂層；schema 加在 `src/db/schema.js` 的 `SCHEMA` 字串（`CREATE TABLE IF NOT EXISTS`）；既有 DB 欄位遷移用 `src/db/connection.js` 的 `addColumnIfMissing`（冪等）。
- 測試慣例：`assert/strict` + `expect(label, fn)` helper + `console.log('[x test] start/done')`；測試資料用專屬 email 前綴（本 feature：service 測試 `shs-`、API 測試 `ckn-`／`sha-`）並在開頭 FK-safe 清理；日期用遠年份 `2032-*`（2031 已被 payroll 測試佔用）。`npm test` 會清洗 `data/app.db`，跑完要 re-seed 才能預覽。
- API 測試打 `BASE=http://localhost:3000`，server 需以 `LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1` 啟動、DB 已 seed（admin 帳號 `admin@chinup.local` / `admin1234`）。
- 不新增任何 npm 依賴。註解與 UI 文案一律繁體中文。
- YAGNI 邊界（spec「刻意不做」）：無 LINE 通知、無拍照佐證、無動態 QR、無上下班起訖打卡、無時薪歷史快照。

---

### Task 1: Schema migration — 兩張新表＋`coaches.hourly_rate`

**Files:**
- Modify: `src/db/schema.js`（`SCHEMA` 字串內、`coach_availability_exceptions` 區塊之後）
- Modify: `src/db/connection.js`（檔尾 `2026-07-08 教練行事曆顏色` 遷移區塊之後）
- Test: `tests/shift-migration.test.js`（新檔）

**Interfaces:**
- Consumes: 既有 `addColumnIfMissing(table, column, definition)`（connection.js）
- Produces: 資料表 `coach_shifts`、`shift_attendance`（欄位如下 DDL）、`coaches.hourly_rate INTEGER`。後續所有 Task 依賴這份 DDL 的欄位名。

- [ ] **Step 1: 寫失敗測試**

建立 `tests/shift-migration.test.js`：

```js
// 駐場打卡 migration：新表/新欄存在、重跑冪等。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { SCHEMA } = await import('../src/db/schema.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[shift-migration test] start');

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

expect('coach_shifts 表存在且欄位齊全', () => {
  const c = cols('coach_shifts');
  for (const k of ['id','coach_id','day_of_week','start_time','end_time','effective_from','effective_to','created_at']) assert.ok(c.includes(k), k);
});
expect('shift_attendance 表存在且欄位齊全', () => {
  const c = cols('shift_attendance');
  for (const k of ['id','coach_id','shift_id','work_date','start_time','end_time','hours','source',
    'checked_in_at','lat','lng','accuracy','distance_m','created_by','voided_at','voided_by','note','created_at']) assert.ok(c.includes(k), k);
});
expect('coaches.hourly_rate 欄位存在', () => assert.ok(cols('coaches').includes('hourly_rate')));
expect('SCHEMA 重跑冪等（不丟錯）', () => db.exec(SCHEMA));
expect('UNIQUE(coach_id, work_date, shift_id) 存在', () => {
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shift_attendance'").get();
  assert.match(idx.sql, /UNIQUE\s*\(\s*coach_id\s*,\s*work_date\s*,\s*shift_id\s*\)/i);
});
console.log('[shift-migration test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/shift-migration.test.js`
Expected: `✗ coach_shifts 表存在…`（PRAGMA 回空）、exitCode 1

- [ ] **Step 3: 實作 schema**

`src/db/schema.js` — 在 `coach_availability_exceptions` 的 CREATE TABLE 區塊結束（`);` 之後、`CREATE TABLE IF NOT EXISTS customer_packages` 之前）插入：

```sql
-- 駐場固定週班表（時薪計酬的排班；可預約時段是另一張 coach_availability_rules，勿混用）
CREATE TABLE IF NOT EXISTS coach_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_coach_shifts_coach ON coach_shifts(coach_id);

-- 駐場出席紀錄：起訖/時數為打卡當下快照（改班表不影響歷史）；voided_at 軟刪（薪資排除、留檔）。
CREATE TABLE IF NOT EXISTS shift_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id),
  shift_id INTEGER REFERENCES coach_shifts(id) ON DELETE SET NULL,
  work_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  hours REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('checkin','manual')),
  checked_in_at TEXT,
  lat REAL, lng REAL, accuracy REAL, distance_m INTEGER,
  created_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(coach_id, work_date, shift_id)
);
CREATE INDEX IF NOT EXISTS idx_shift_attendance_date ON shift_attendance(work_date);
```

`src/db/connection.js` — 在 `addColumnIfMissing('coaches', 'color', 'TEXT');` 之後加：

```js
// ── 2026-07-09 駐場打卡與時薪 ──
// coaches.hourly_rate：駐場時薪（元/小時）。NULL=不參與駐場薪資。即時制（計算當下取現值，不存歷史）。
addColumnIfMissing('coaches', 'hourly_rate', 'INTEGER');
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/shift-migration.test.js`
Expected: 全部 `✓`、`[shift-migration test] done`

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.js src/db/connection.js tests/shift-migration.test.js
git commit -m "feat: 駐場打卡 schema（coach_shifts/shift_attendance/hourly_rate）"
```

---

### Task 2: shiftService — 班表 CRUD 與日期比對

**Files:**
- Create: `src/services/shiftService.js`
- Test: `tests/shift-service.test.js`（新檔）
- Modify: `package.json`（`test` 鏈尾端）

**Interfaces:**
- Consumes: `db, nowLocal, tx`（`../db/connection.js`）、`ApiError`（`./registration.js`）
- Produces（後續 Task 依賴的精確簽名；shift 列為 DB 原始 snake_case row）:
  - `hoursBetween(startTime, endTime): number` — `'09:00','11:00' → 2`
  - `listShifts(coachId = null): row[]` — 無參數＝全教練
  - `getShift(id): row | undefined`
  - `createShift({ coachId, dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo = null }): row`
  - `updateShift(id, { startTime, endTime, effectiveFrom, effectiveTo }): row` — 局部更新，`undefined`＝不動、`effectiveTo: null`＝清空
  - `deleteShift(id): void` — 不存在丟 404 `shift_not_found`
  - `shiftsForDate(coachId, dateStr): row[]` — 該日 dow＋生效區間過濾，`start_time` 升冪
  - 錯誤碼：`invalid_day_of_week`、`invalid_time_range`、`invalid_effective_range`、`shift_not_found`

- [ ] **Step 1: 寫失敗測試**

建立 `tests/shift-service.test.js`：

```js
// 駐場 shiftService：班表 CRUD/日期比對/打卡/補登/註銷/期別彙總。資料鎖 2032 年與 shs- 前綴。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/services/discountService.js');
const {
  hoursBetween, listShifts, getShift, createShift, updateShift, deleteShift, shiftsForDate,
} = await import('../src/services/shiftService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[shift-service test] start');

// ── FK-safe 清理（attendance → shifts → coaches → users）──
db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'shs-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'shs-%'));
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'shs-%');
  DELETE FROM users WHERE email LIKE 'shs-%';
  DELETE FROM app_settings WHERE key LIKE 'checkin_%';
`);
function mkCoach(tag) {
  const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES (?,?,'coach')").run(tag, `shs-${tag}@x.com`).lastInsertRowid);
  return Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, ?, 1)").run(uid, tag).lastInsertRowid);
}
const cA = mkCoach('A');

// ── 基本工具與 CRUD ──
expect('hoursBetween 09:00–11:00 → 2；08:00–09:30 → 1.5', () => {
  assert.equal(hoursBetween('09:00', '11:00'), 2);
  assert.equal(hoursBetween('08:00', '09:30'), 1.5);
});

const D = '2032-03-03';                                  // 測試基準日
const DOW = new Date(D + 'T00:00:00').getDay();          // 依執行環境推導，不硬編
const s1 = createShift({ coachId: cA, dayOfWeek: DOW, startTime: '09:00', endTime: '11:00', effectiveFrom: '2032-01-01' });
expect('createShift 回傳完整列', () => {
  assert.equal(s1.coach_id, cA); assert.equal(s1.start_time, '09:00'); assert.equal(s1.effective_to, null);
});
expect('createShift 驗證：dow 7 → invalid_day_of_week', () => {
  assert.throws(() => createShift({ coachId: cA, dayOfWeek: 7, startTime: '09:00', endTime: '10:00', effectiveFrom: '2032-01-01' }),
    (e) => e.code === 'invalid_day_of_week');
});
expect('createShift 驗證：end ≤ start → invalid_time_range', () => {
  assert.throws(() => createShift({ coachId: cA, dayOfWeek: DOW, startTime: '11:00', endTime: '09:00', effectiveFrom: '2032-01-01' }),
    (e) => e.code === 'invalid_time_range');
});
expect('createShift 驗證：effective_to < effective_from → invalid_effective_range', () => {
  assert.throws(() => createShift({ coachId: cA, dayOfWeek: DOW, startTime: '09:00', endTime: '10:00', effectiveFrom: '2032-05-01', effectiveTo: '2032-04-01' }),
    (e) => e.code === 'invalid_effective_range');
});

expect('shiftsForDate：生效區間內命中、區間外不命中', () => {
  assert.equal(shiftsForDate(cA, D).length, 1);
  const ended = createShift({ coachId: cA, dayOfWeek: DOW, startTime: '14:00', endTime: '15:00', effectiveFrom: '2032-01-01', effectiveTo: '2032-03-02' });
  const future = createShift({ coachId: cA, dayOfWeek: DOW, startTime: '16:00', endTime: '17:00', effectiveFrom: '2032-03-04' });
  assert.equal(shiftsForDate(cA, D).length, 1);          // ended/future 都不算
  assert.deepEqual(shiftsForDate(cA, '2032-03-10').map((s) => s.start_time), ['09:00', '16:00']);  // 下週三：future 生效
  deleteShift(ended.id); deleteShift(future.id);
});
expect('updateShift 局部更新 + effective_to 清空', () => {
  const u = updateShift(s1.id, { effectiveTo: '2032-12-31' });
  assert.equal(u.effective_to, '2032-12-31');
  assert.equal(updateShift(s1.id, { effectiveTo: null }).effective_to, null);
});
expect('deleteShift 不存在 → shift_not_found', () => {
  assert.throws(() => deleteShift(999999), (e) => e.code === 'shift_not_found');
});
expect('listShifts(coachId) 只回該教練', () => {
  assert.ok(listShifts(cA).every((s) => s.coach_id === cA));
  assert.ok(listShifts().length >= 1);
});
console.log('[shift-service test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/shift-service.test.js`
Expected: import 失敗（`Cannot find module .../shiftService.js`）

- [ ] **Step 3: 實作 `src/services/shiftService.js`（本 Task 範圍）**

```js
// 駐場打卡與班表：固定週班表（coach_shifts）＋出席紀錄（shift_attendance，起訖/時數快照、軟刪註銷）。
// 規則見 docs/superpowers/specs/2026-07-09-shift-attendance-checkin-design.md。
import { db, nowLocal, tx } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting } from './discountService.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** 'HH:MM' 起訖 → 小時數（REAL），如 09:00–11:00 → 2、08:00–09:30 → 1.5 */
export function hoursBetween(startTime, endTime) {
  return (toMin(endTime) - toMin(startTime)) / 60;
}

// ── 班表 CRUD ──
const listAllShiftsStmt = db.prepare('SELECT * FROM coach_shifts ORDER BY coach_id ASC, day_of_week ASC, start_time ASC');
const listCoachShiftsStmt = db.prepare('SELECT * FROM coach_shifts WHERE coach_id = ? ORDER BY day_of_week ASC, start_time ASC');
const getShiftStmt = db.prepare('SELECT * FROM coach_shifts WHERE id = ?');
const insertShiftStmt = db.prepare(`
  INSERT INTO coach_shifts (coach_id, day_of_week, start_time, end_time, effective_from, effective_to)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const shiftsForDateStmt = db.prepare(`
  SELECT * FROM coach_shifts
  WHERE coach_id = ? AND day_of_week = ?
    AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
  ORDER BY start_time ASC
`);

function validateShiftFields({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo }) {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new ApiError(400, 'invalid_day_of_week');
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '') || startTime >= endTime) throw new ApiError(400, 'invalid_time_range');
  if (!DATE_RE.test(effectiveFrom || '')) throw new ApiError(400, 'invalid_effective_range');
  if (effectiveTo != null && (!DATE_RE.test(effectiveTo) || effectiveTo < effectiveFrom)) throw new ApiError(400, 'invalid_effective_range');
}

export function listShifts(coachId = null) {
  return coachId == null ? listAllShiftsStmt.all() : listCoachShiftsStmt.all(coachId);
}
export function getShift(id) { return getShiftStmt.get(id); }

export function createShift({ coachId, dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo = null }) {
  validateShiftFields({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo });
  const info = insertShiftStmt.run(coachId, dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo);
  return getShiftStmt.get(Number(info.lastInsertRowid));
}

/** 局部更新；undefined＝不動、effectiveTo: null＝清空。合併後整組重新驗證。 */
export function updateShift(id, { startTime, endTime, effectiveFrom, effectiveTo } = {}) {
  const cur = getShiftStmt.get(id);
  if (!cur) throw new ApiError(404, 'shift_not_found');
  const next = {
    dayOfWeek: cur.day_of_week,
    startTime: startTime !== undefined ? startTime : cur.start_time,
    endTime: endTime !== undefined ? endTime : cur.end_time,
    effectiveFrom: effectiveFrom !== undefined ? effectiveFrom : cur.effective_from,
    effectiveTo: effectiveTo !== undefined ? effectiveTo : cur.effective_to,
  };
  validateShiftFields(next);
  db.prepare('UPDATE coach_shifts SET start_time = ?, end_time = ?, effective_from = ?, effective_to = ? WHERE id = ?')
    .run(next.startTime, next.endTime, next.effectiveFrom, next.effectiveTo, id);
  return getShiftStmt.get(id);
}

export function deleteShift(id) {
  const info = db.prepare('DELETE FROM coach_shifts WHERE id = ?').run(id);
  if (info.changes === 0) throw new ApiError(404, 'shift_not_found');
}

/** 某教練在某日期的有效班表（dow 相符＋生效區間涵蓋該日），start_time 升冪。 */
export function shiftsForDate(coachId, dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return shiftsForDateStmt.all(coachId, dow, dateStr, dateStr);
}
```

（`nowLocal`、`tx`、`getSetting` 此時尚未用到，但 Task 3/4 會用；先 import 不影響。）

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/shift-service.test.js`
Expected: 全部 `✓`

- [ ] **Step 5: 掛進 test 鏈**

`package.json` 的 `"test"` script 尾端（`node tests/coach-color.test.js` 之後）追加：

```
 && node tests/shift-migration.test.js && node tests/shift-service.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/services/shiftService.js tests/shift-service.test.js package.json
git commit -m "feat: shiftService 班表 CRUD 與日期比對"
```

---

### Task 3: shiftService — 打卡核心（GPS＋窗口＋冪等）

**Files:**
- Modify: `src/services/shiftService.js`（檔尾追加）
- Modify: `tests/shift-service.test.js`（`console.log('[shift-service test] done')` 之前插入）

**Interfaces:**
- Consumes: Task 2 全部；`getSetting`（discountService）
- Produces:
  - `haversineMeters(lat1, lng1, lat2, lng2): number`（四捨五入公尺）
  - `getCheckinConfig(): { lat, lng, radius, windowBeforeMin, configured }` — settings 鍵 `checkin_lat`/`checkin_lng`/`checkin_radius_m`(預設150)/`checkin_window_before_min`(預設30)
  - `checkIn({ coachId, lat, lng, accuracy = null, now = nowLocal() }): { attendance: row, already: boolean }` — 錯誤碼 `checkin_not_configured`(503)、`missing_location`(400)、`not_at_gym`(403, detail `{ distance_m }`)、`no_active_shift`(409)、`attendance_voided`(409)
  - `todayStatus(coachId, now = nowLocal()): { date, slots: [{ shiftId, startTime, endTime, hours, status, checkedInAt }], extras: [{ startTime, endTime, hours }] }` — status ∈ `done|voided|open|upcoming|closed`
  - attendance row 為 DB 原始 snake_case（`work_date`、`start_time`、`checked_in_at`…）

- [ ] **Step 1: 寫失敗測試**

在 `tests/shift-service.test.js` 的 `console.log('[shift-service test] done')` **之前**插入：

```js
// ── 打卡核心 ──
const { checkIn, todayStatus, haversineMeters, getCheckinConfig } = await import('../src/services/shiftService.js');
const GYM = { lat: 25.0330, lng: 121.5654 };   // 台北101 當測試館址
const FAR = { lat: 25.0478, lng: 121.5170 };   // 台北車站 ≈ 4.9km

expect('haversineMeters：同點=0、101↔北車 4~6km', () => {
  assert.equal(haversineMeters(GYM.lat, GYM.lng, GYM.lat, GYM.lng), 0);
  const d = haversineMeters(GYM.lat, GYM.lng, FAR.lat, FAR.lng);
  assert.ok(d > 4000 && d < 6000, `d=${d}`);
});
expect('未設座標 → checkin_not_configured(503)', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T09:10:00` }),
    (e) => e.status === 503 && e.code === 'checkin_not_configured');
});
setSetting('checkin_lat', String(GYM.lat));
setSetting('checkin_lng', String(GYM.lng));
expect('getCheckinConfig 預設半徑150/窗口30', () => {
  const c = getCheckinConfig();
  assert.equal(c.radius, 150); assert.equal(c.windowBeforeMin, 30); assert.equal(c.configured, true);
});
expect('缺定位 → missing_location(400)', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: NaN, lng: undefined, now: `${D}T09:10:00` }), (e) => e.code === 'missing_location');
});
expect('距離超出 → not_at_gym(403) 且 detail 帶 distance_m', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: FAR.lat, lng: FAR.lng, now: `${D}T09:10:00` }),
    (e) => e.status === 403 && e.code === 'not_at_gym' && e.detail.distance_m > 4000);
});
expect('窗口邊界：08:29 擋、08:30 過（開始前30分）', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T08:29:00` }), (e) => e.code === 'no_active_shift');
  const r = checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T08:30:00` });
  assert.equal(r.already, false);
  assert.equal(r.attendance.work_date, D); assert.equal(r.attendance.start_time, '09:00');
  assert.equal(r.attendance.hours, 2); assert.equal(r.attendance.source, 'checkin');
  assert.equal(r.attendance.distance_m, 0);
});
expect('重複打卡 → already=true 冪等回同列', () => {
  const r2 = checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T09:30:00` });
  assert.equal(r2.already, true);
});
expect('窗口尾界：11:00 可打（另一日）、11:01 擋', () => {
  const D2 = '2032-03-10';   // 下一個相同 dow
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D2}T11:01:00` }), (e) => e.code === 'no_active_shift');
  assert.equal(checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D2}T11:00:00` }).already, false);
});
expect('快照語意：改班表不影響既有出席', () => {
  updateShift(s1.id, { startTime: '10:00' });
  const row = db.prepare('SELECT * FROM shift_attendance WHERE coach_id=? AND work_date=?').get(cA, D);
  assert.equal(row.start_time, '09:00'); assert.equal(row.hours, 2);
  updateShift(s1.id, { startTime: '09:00' });   // 還原
});
expect('todayStatus：已打卡 done、無班表日空 slots', () => {
  const st = todayStatus(cA, `${D}T12:00:00`);
  assert.equal(st.date, D);
  assert.equal(st.slots.length, 1);
  assert.equal(st.slots[0].status, 'done');
  assert.equal(st.slots[0].shiftId, s1.id);
  assert.equal(todayStatus(cA, '2032-03-04T09:00:00').slots.length, 0);  // 隔天非該 dow
});
expect('todayStatus 時間狀態：upcoming/open/closed', () => {
  const D3 = '2032-03-17';
  assert.equal(todayStatus(cA, `${D3}T08:00:00`).slots[0].status, 'upcoming');
  assert.equal(todayStatus(cA, `${D3}T08:30:00`).slots[0].status, 'open');
  assert.equal(todayStatus(cA, `${D3}T11:01:00`).slots[0].status, 'closed');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/shift-service.test.js`
Expected: import 失敗（`checkIn` 未匯出）

- [ ] **Step 3: 實作（`shiftService.js` 檔尾追加）**

```js
// ── 打卡 ──

/** 兩座標球面距離（公尺，四捨五入）。 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** 打卡參數（app_settings）。座標未設定 → configured=false，打卡端點回 503。 */
export function getCheckinConfig() {
  const lat = parseFloat(getSetting('checkin_lat') ?? '');
  const lng = parseFloat(getSetting('checkin_lng') ?? '');
  const radius = parseInt(getSetting('checkin_radius_m') || '150', 10);
  const windowBeforeMin = parseInt(getSetting('checkin_window_before_min') || '30', 10);
  return { lat, lng, radius, windowBeforeMin, configured: Number.isFinite(lat) && Number.isFinite(lng) };
}

const attendanceForShiftStmt = db.prepare('SELECT * FROM shift_attendance WHERE coach_id = ? AND work_date = ? AND shift_id = ?');
const attendanceForDateStmt = db.prepare('SELECT * FROM shift_attendance WHERE coach_id = ? AND work_date = ? ORDER BY start_time ASC');
const getAttendanceStmt = db.prepare('SELECT * FROM shift_attendance WHERE id = ?');
const insertAttendanceStmt = db.prepare(`
  INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source,
    checked_in_at, lat, lng, accuracy, distance_m, created_by, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * GPS 打卡：距離驗證 → 窗口比對（[start−窗口, end]，多列命中取最早開始）→ 冪等寫入。
 * 已有未註銷紀錄 → { already: true }；已註銷 → 409 attendance_voided（重登走管理者補登）。
 */
export function checkIn({ coachId, lat, lng, accuracy = null, now = nowLocal() }) {
  const cfg = getCheckinConfig();
  if (!cfg.configured) throw new ApiError(503, 'checkin_not_configured');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new ApiError(400, 'missing_location');
  const distance = haversineMeters(lat, lng, cfg.lat, cfg.lng);
  if (distance > cfg.radius) throw new ApiError(403, 'not_at_gym', { distance_m: distance });

  const workDate = now.slice(0, 10);
  const nowMin = toMin(now.slice(11, 16));
  const candidates = shiftsForDate(coachId, workDate)
    .filter((s) => nowMin >= toMin(s.start_time) - cfg.windowBeforeMin && nowMin <= toMin(s.end_time));
  if (!candidates.length) throw new ApiError(409, 'no_active_shift');
  const shift = candidates[0];

  return tx(() => {
    const existing = attendanceForShiftStmt.get(coachId, workDate, shift.id);
    if (existing) {
      if (existing.voided_at) throw new ApiError(409, 'attendance_voided');
      return { attendance: existing, already: true };
    }
    const info = insertAttendanceStmt.run(coachId, shift.id, workDate, shift.start_time, shift.end_time,
      hoursBetween(shift.start_time, shift.end_time), 'checkin', now, lat, lng, accuracy, distance, null, null);
    return { attendance: getAttendanceStmt.get(Number(info.lastInsertRowid)), already: false };
  });
}

/** /checkin 頁資料：今天各班表時段狀態 ＋ 班表外補登列（shift_id NULL）。 */
export function todayStatus(coachId, now = nowLocal()) {
  const workDate = now.slice(0, 10);
  const nowMin = toMin(now.slice(11, 16));
  const { windowBeforeMin } = getCheckinConfig();
  const attendance = attendanceForDateStmt.all(coachId, workDate);
  const byShift = new Map(attendance.filter((a) => a.shift_id != null).map((a) => [a.shift_id, a]));
  const slots = shiftsForDate(coachId, workDate).map((s) => {
    const a = byShift.get(s.id);
    let status;
    if (a) status = a.voided_at ? 'voided' : 'done';
    else if (nowMin < toMin(s.start_time) - windowBeforeMin) status = 'upcoming';
    else if (nowMin > toMin(s.end_time)) status = 'closed';
    else status = 'open';
    return { shiftId: s.id, startTime: s.start_time, endTime: s.end_time,
      hours: hoursBetween(s.start_time, s.end_time), status, checkedInAt: a?.checked_in_at ?? null };
  });
  const extras = attendance.filter((a) => a.shift_id == null && !a.voided_at)
    .map((a) => ({ startTime: a.start_time, endTime: a.end_time, hours: a.hours }));
  return { date: workDate, slots, extras };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/shift-service.test.js`
Expected: 全部 `✓`

- [ ] **Step 5: Commit**

```bash
git add src/services/shiftService.js tests/shift-service.test.js
git commit -m "feat: shiftService GPS 打卡核心（距離/窗口/冪等/todayStatus）"
```

---

### Task 4: shiftService — 補登、註銷、期別彙總

**Files:**
- Modify: `src/services/shiftService.js`（檔尾追加）
- Modify: `tests/shift-service.test.js`（done log 之前插入）

**Interfaces:**
- Consumes: Task 2/3 全部
- Produces:
  - `manualAttendance({ coachId, workDate, shiftId = null, startTime = null, endTime = null, note = null, createdBy }): row` — 帶 `shiftId`：快照班表起訖；同鍵已有未註銷 → 409 `duplicate_attendance`；已註銷 → **復原**該列（清 voided_*）。不帶 `shiftId`：自訂起訖插入（可同日多筆）。錯誤碼另有 `invalid_work_date`、`invalid_time_range`、`shift_not_found`
  - `voidAttendance(id, voidedBy): row` — 404 `attendance_not_found`、409 `already_voided`
  - `coachPeriodHours(coachId, startDate, endDate): number` — 未註銷、`work_date` 含端點
  - `shiftSummaryByCoach(startDate, endDate): Map<coachId, { hours, details[] }>` — details 元素（camelCase，payroll/後台共用）：`{ attendanceId, workDate, startTime, endTime, hours, source, checkedInAt, distanceM, note }`

- [ ] **Step 1: 寫失敗測試**

在 done log 之前插入：

```js
// ── 補登 / 註銷 / 期別彙總 ──
const { manualAttendance, voidAttendance, coachPeriodHours, shiftSummaryByCoach } = await import('../src/services/shiftService.js');
const cB = mkCoach('B');

expect('manualAttendance 套班表：快照起訖＋source=manual', () => {
  const D4 = '2032-03-24';
  const m = manualAttendance({ coachId: cA, workDate: D4, shiftId: s1.id, note: '忘打卡', createdBy: 1 });
  assert.equal(m.start_time, '09:00'); assert.equal(m.hours, 2);
  assert.equal(m.source, 'manual'); assert.equal(m.checked_in_at, null); assert.equal(m.note, '忘打卡');
});
expect('manualAttendance 同鍵未註銷 → duplicate_attendance(409)', () => {
  assert.throws(() => manualAttendance({ coachId: cA, workDate: '2032-03-24', shiftId: s1.id, createdBy: 1 }),
    (e) => e.status === 409 && e.code === 'duplicate_attendance');
});
expect('voidAttendance → 註銷；再註銷 → already_voided；不存在 → attendance_not_found', () => {
  const row = db.prepare("SELECT * FROM shift_attendance WHERE coach_id=? AND work_date='2032-03-24'").get(cA);
  const v = voidAttendance(row.id, 1);
  assert.ok(v.voided_at); assert.equal(v.voided_by, 1);
  assert.throws(() => voidAttendance(row.id, 1), (e) => e.code === 'already_voided');
  assert.throws(() => voidAttendance(999999, 1), (e) => e.code === 'attendance_not_found');
});
expect('註銷後 checkIn 被擋 attendance_voided、manualAttendance 改為復原同列', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: '2032-03-24T09:10:00' }),
    (e) => e.code === 'attendance_voided');
  const before = db.prepare("SELECT id FROM shift_attendance WHERE coach_id=? AND work_date='2032-03-24'").get(cA).id;
  const restored = manualAttendance({ coachId: cA, workDate: '2032-03-24', shiftId: s1.id, note: '復原', createdBy: 1 });
  assert.equal(restored.id, before); assert.equal(restored.voided_at, null); assert.equal(restored.note, '復原');
});
expect('manualAttendance 自訂起訖：可同日多筆、時數正確、驗證起訖', () => {
  const a = manualAttendance({ coachId: cB, workDate: '2032-03-05', startTime: '18:00', endTime: '19:30', createdBy: 1 });
  const b = manualAttendance({ coachId: cB, workDate: '2032-03-05', startTime: '20:00', endTime: '21:00', createdBy: 1 });
  assert.equal(a.hours, 1.5); assert.equal(b.shift_id, null);
  assert.throws(() => manualAttendance({ coachId: cB, workDate: '2032-03-05', startTime: '21:00', endTime: '20:00', createdBy: 1 }),
    (e) => e.code === 'invalid_time_range');
  assert.throws(() => manualAttendance({ coachId: cB, workDate: 'bad', startTime: '10:00', endTime: '11:00', createdBy: 1 }),
    (e) => e.code === 'invalid_work_date');
});
expect('期別彙總：含端點、排除註銷、多教練分組', () => {
  // 期別 2032-04 = 2032-03-06 ~ 2032-04-05。cB 端點內外各插一筆：
  manualAttendance({ coachId: cB, workDate: '2032-03-06', startTime: '09:00', endTime: '10:00', createdBy: 1 });  // 起端含
  manualAttendance({ coachId: cB, workDate: '2032-04-05', startTime: '09:00', endTime: '10:00', createdBy: 1 });  // 迄端含
  manualAttendance({ coachId: cB, workDate: '2032-04-06', startTime: '09:00', endTime: '10:00', createdBy: 1 });  // 期外
  const voided = manualAttendance({ coachId: cB, workDate: '2032-03-20', startTime: '09:00', endTime: '10:00', createdBy: 1 });
  voidAttendance(voided.id, 1);
  assert.equal(coachPeriodHours(cB, '2032-03-06', '2032-04-05'), 2);
  const m = shiftSummaryByCoach('2032-03-06', '2032-04-05');
  assert.equal(m.get(cB).hours, 2);
  assert.equal(m.get(cB).details.length, 2);
  const d = m.get(cB).details[0];
  for (const k of ['attendanceId', 'workDate', 'startTime', 'endTime', 'hours', 'source', 'checkedInAt', 'distanceM', 'note']) assert.ok(k in d, k);
  assert.ok(m.get(cA).hours >= 2);   // cA 的 2032-03-24（復原後）也在此期
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/shift-service.test.js` → `manualAttendance` 未匯出

- [ ] **Step 3: 實作（檔尾追加）**

```js
// ── 補登 / 註銷 / 期別彙總 ──

/**
 * 管理者補登。帶 shiftId：快照該班表起訖；同鍵已有未註銷列 → 409；已註銷列 → 復原（清 voided_*，
 * 覆寫 note，保留原始佐證）——與 UNIQUE(coach_id, work_date, shift_id) 相容的重登路徑。
 * 不帶 shiftId：自訂起訖直接插入（班表外加班；同日可多筆）。
 */
export function manualAttendance({ coachId, workDate, shiftId = null, startTime = null, endTime = null, note = null, createdBy }) {
  if (!DATE_RE.test(workDate || '')) throw new ApiError(400, 'invalid_work_date');
  if (shiftId != null) {
    const shift = getShiftStmt.get(shiftId);
    if (!shift || shift.coach_id !== coachId) throw new ApiError(404, 'shift_not_found');
    return tx(() => {
      const existing = attendanceForShiftStmt.get(coachId, workDate, shift.id);
      if (existing) {
        if (!existing.voided_at) throw new ApiError(409, 'duplicate_attendance');
        db.prepare('UPDATE shift_attendance SET voided_at = NULL, voided_by = NULL, note = COALESCE(?, note) WHERE id = ?')
          .run(note, existing.id);
        return getAttendanceStmt.get(existing.id);
      }
      const info = insertAttendanceStmt.run(coachId, shift.id, workDate, shift.start_time, shift.end_time,
        hoursBetween(shift.start_time, shift.end_time), 'manual', null, null, null, null, null, createdBy, note);
      return getAttendanceStmt.get(Number(info.lastInsertRowid));
    });
  }
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '') || startTime >= endTime) throw new ApiError(400, 'invalid_time_range');
  const info = insertAttendanceStmt.run(coachId, null, workDate, startTime, endTime,
    hoursBetween(startTime, endTime), 'manual', null, null, null, null, null, createdBy, note);
  return getAttendanceStmt.get(Number(info.lastInsertRowid));
}

/** 註銷（軟刪）：薪資排除、紀錄留檔。 */
export function voidAttendance(id, voidedBy) {
  const row = getAttendanceStmt.get(id);
  if (!row) throw new ApiError(404, 'attendance_not_found');
  if (row.voided_at) throw new ApiError(409, 'already_voided');
  db.prepare('UPDATE shift_attendance SET voided_at = ?, voided_by = ? WHERE id = ?').run(nowLocal(), voidedBy, id);
  return getAttendanceStmt.get(id);
}

const periodHoursStmt = db.prepare(`
  SELECT COALESCE(SUM(hours), 0) AS h FROM shift_attendance
  WHERE coach_id = ? AND voided_at IS NULL AND work_date >= ? AND work_date <= ?
`);
export function coachPeriodHours(coachId, startDate, endDate) {
  return periodHoursStmt.get(coachId, startDate, endDate).h;
}

const periodRowsStmt = db.prepare(`
  SELECT * FROM shift_attendance
  WHERE voided_at IS NULL AND work_date >= ? AND work_date <= ?
  ORDER BY coach_id ASC, work_date ASC, start_time ASC
`);
/** 期別內全教練駐場彙總（payroll 與後台明細共用）；日期含端點。 */
export function shiftSummaryByCoach(startDate, endDate) {
  const map = new Map();
  for (const r of periodRowsStmt.all(startDate, endDate)) {
    if (!map.has(r.coach_id)) map.set(r.coach_id, { hours: 0, details: [] });
    const e = map.get(r.coach_id);
    e.hours += r.hours;
    e.details.push({ attendanceId: r.id, workDate: r.work_date, startTime: r.start_time, endTime: r.end_time,
      hours: r.hours, source: r.source, checkedInAt: r.checked_in_at, distanceM: r.distance_m, note: r.note });
  }
  return map;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/shift-service.test.js` → 全部 `✓`

- [ ] **Step 5: Commit**

```bash
git add src/services/shiftService.js tests/shift-service.test.js
git commit -m "feat: shiftService 補登/註銷/期別彙總（復原語意與 UNIQUE 相容）"
```

---

### Task 5: payrollService 整合 shift 區塊

**Files:**
- Modify: `src/services/payrollService.js`
- Modify: `tests/payroll-service.test.js`（`console.log('[payroll-service test] done')` 之前插入）

**Interfaces:**
- Consumes: `shiftSummaryByCoach(startDate, endDate)`（Task 4）
- Produces: `computePayroll()` 回傳每教練新增 `shift: { hours: number, rate: number|null, salary: number, details: [] }`；`totals` 新增 `shiftHours`、`shiftSalary`；`c.total` 與 `totals.total` 含駐場薪資。教練列入條件擴為「啟用 或 期內有任一種資料（含駐場）」。

- [ ] **Step 1: 寫失敗測試**

在 `tests/payroll-service.test.js` 的 done log 之前插入（該檔已 import `db`、`computePayroll`；期別沿用其 `2031-02`＝`2031-01-06`~`2031-02-05`）：

```js
// ── 駐場時薪整合 ──
{
  const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('PR駐場','pr-shift@x.com','coach')").run().lastInsertRowid);
  const cid = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active, hourly_rate) VALUES (?, 'PR駐場', 1, 500)").run(uid).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source, created_by)
    VALUES (?, NULL, ?, '09:00', '11:00', 2, 'manual', 1)`);
  ins.run(cid, '2031-01-10');
  ins.run(cid, '2031-02-05');            // 迄端含
  ins.run(cid, '2031-02-06');            // 期外
  const voided = Number(db.prepare(`INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source, created_by, voided_at)
    VALUES (?, NULL, '2031-01-20', '09:00', '10:00', 1, 'manual', 1, '2031-01-21T00:00:00')`).run(cid).lastInsertRowid);

  const r = computePayroll({ period: '2031-02' });
  const c = r.coaches.find((x) => x.coachId === cid);
  expect('shift 區塊：時數含端點/排除註銷、薪資=時數×時薪', () => {
    assert.equal(c.shift.hours, 4); assert.equal(c.shift.rate, 500); assert.equal(c.shift.salary, 2000);
    assert.equal(c.shift.details.length, 2);
    assert.equal(c.total, c.oneOnOne.salary + c.group.salary + 2000);
  });
  expect('totals 加總 shiftHours/shiftSalary 並計入 total', () => {
    assert.ok(r.totals.shiftHours >= 4);
    assert.ok(r.totals.shiftSalary >= 2000);
    assert.equal(r.totals.total, r.coaches.reduce((s, x) => s + x.total, 0));
  });
  db.prepare("UPDATE coaches SET hourly_rate = NULL WHERE id = ?").run(cid);
  const r2 = computePayroll({ period: '2031-02' });
  const c2 = r2.coaches.find((x) => x.coachId === cid);
  expect('hourly_rate NULL：rate=null、salary=0、時數照列', () => {
    assert.equal(c2.shift.rate, null); assert.equal(c2.shift.salary, 0); assert.equal(c2.shift.hours, 4);
  });
  expect('時薪四捨五入到元：333 × 1.5h = 500', () => {
    db.prepare("UPDATE coaches SET hourly_rate = 333, is_active = 0 WHERE id = ?").run(cid);
    db.exec(`DELETE FROM shift_attendance WHERE coach_id = ${cid}`);
    db.prepare(`INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source, created_by)
      VALUES (?, NULL, '2031-01-15', '09:00', '10:30', 1.5, 'manual', 1)`).run(cid);
    const c3 = computePayroll({ period: '2031-02' }).coaches.find((x) => x.coachId === cid);
    assert.ok(c3, '停用教練期內有駐場資料仍應列出');
    assert.equal(c3.shift.salary, 500);
  });
}
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/payroll-service.test.js` → `c.shift` undefined

- [ ] **Step 3: 實作 `payrollService.js` 修改**

1. import 加：`import { shiftSummaryByCoach } from './shiftService.js';`
2. `coachesStmt` 整句改為：`db.prepare('SELECT id, display_name, is_active, hourly_rate FROM coaches ORDER BY created_at ASC, id ASC')`
3. `byCoach` 初始化物件加：

```js
    shift: { hours: 0, rate: c.hourly_rate ?? null, salary: 0, details: [] },
```

4. 團課迴圈之後、最終彙整迴圈之前加：

```js
  const shiftMap = shiftSummaryByCoach(displayStart, displayEnd);
  for (const [coachId, s] of shiftMap) {
    const c = byCoach.get(coachId);
    if (!c) continue;
    c.shift.hours = s.hours;
    c.shift.details = s.details;
  }
```

5. 最終迴圈內，`c.group.salary = …` 之後改為：

```js
    c.shift.salary = c.shift.rate != null ? Math.round(c.shift.hours * c.shift.rate) : 0;
    c.total = o.salary + c.group.salary + c.shift.salary;
    if (c.isActive || o.sessions > 0 || c.group.details.length > 0 || c.shift.details.length > 0) coaches.push(c);
```

6. `totals` reduce 加兩鍵（初始值物件同步加 `shiftHours: 0, shiftSalary: 0`）：

```js
    shiftHours: t.shiftHours + c.shift.hours,
    shiftSalary: t.shiftSalary + c.shift.salary,
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/payroll-service.test.js` → 全部 `✓`（既有斷言不得變紅）

- [ ] **Step 5: Commit**

```bash
git add src/services/payrollService.js tests/payroll-service.test.js
git commit -m "feat: computePayroll 併入駐場時薪（shift 區塊＋totals）"
```

---

### Task 6: Coach API — `GET /api/coach/checkin/today`、`POST /api/coach/checkin`

**Files:**
- Modify: `src/server.js`
- Test: `tests/checkin-api.test.js`（新檔）
- Modify: `package.json`（`test:api` 鏈尾端）

**Interfaces:**
- Consumes: `checkIn`、`todayStatus`、`coachPeriodHours`（shiftService）；`periodRange`、`defaultPeriod`（payrollService）；既有 `requireCoach`、`loadCoachForUser`、`createRateLimiter`、`asyncHandler`
- Produces:
  - `GET /api/coach/checkin/today` → `{ date, slots, extras, period, periodHours }`（永遠本人；`coachId` query 無效）
  - `POST /api/coach/checkin` body `{ lat, lng, accuracy? }` → `{ ok: true, already, attendance }`（attendance 為 snake_case row）
  - rate limit：`checkin` 10 次/分/IP

- [ ] **Step 1: 寫失敗測試**

建立 `tests/checkin-api.test.js`：

```js
// 打卡 API：權限/未設定/距離/窗口/冪等/註銷/代選免疫。server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[checkin-api test] start');

// ── 清理與資料 ──
db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%'));
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%');
  DELETE FROM users WHERE email LIKE 'ckn-%';
  DELETE FROM app_settings WHERE key LIKE 'checkin_%';
`);
const GYM = { lat: 25.0330, lng: 121.5654 };
const cUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('CKN教練','ckn-c@x.com','coach',?)").run(hashPassword('cknpass123')).lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'CKN-C', 1)").run(cUid).lastInsertRowid);
const dUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('CKN無班','ckn-d@x.com','coach',?)").run(hashPassword('cknpass123')).lastInsertRowid);
db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'CKN-D', 1)").run(dUid);
const uUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('CKN會員','ckn-u@x.com','user',?)").run(hashPassword('cknpass123')).lastInsertRowid);
// 給 C 一條涵蓋「現在」的全日班表（測試與 server 同機同時區，牆鐘一致）
const now = new Date();
db.prepare("INSERT INTO coach_shifts (coach_id, day_of_week, start_time, end_time, effective_from) VALUES (?, ?, '00:00', '23:59', '2000-01-01')")
  .run(cId, now.getDay());

const tokC = (await req('POST', '/api/auth/login', { body: { email: 'ckn-c@x.com', password: 'cknpass123' } })).data?.token;
const tokD = (await req('POST', '/api/auth/login', { body: { email: 'ckn-d@x.com', password: 'cknpass123' } })).data?.token;
const tokU = (await req('POST', '/api/auth/login', { body: { email: 'ckn-u@x.com', password: 'cknpass123' } })).data?.token;
expect('三帳號登入成功', () => { assert.ok(tokC); assert.ok(tokD); assert.ok(tokU); });

{
  const a = await req('POST', '/api/coach/checkin', { body: GYM });
  expect('未登入 POST → 401', () => assert.equal(a.status, 401));
  const b = await req('POST', '/api/coach/checkin', { body: GYM, token: tokU });
  expect('role=user POST → 403 coach_only', () => { assert.equal(b.status, 403); assert.equal(b.data.error, 'coach_only'); });
  const c = await req('GET', '/api/coach/checkin/today', { token: tokU });
  expect('role=user GET → 403', () => assert.equal(c.status, 403));
}
{
  const r = await req('POST', '/api/coach/checkin', { body: GYM, token: tokC });
  expect('座標未設定 → 503 checkin_not_configured', () => { assert.equal(r.status, 503); assert.equal(r.data.error, 'checkin_not_configured'); });
}
db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('checkin_lat', ?), ('checkin_lng', ?)").run(String(GYM.lat), String(GYM.lng));
{
  const far = await req('POST', '/api/coach/checkin', { body: { lat: 25.0478, lng: 121.5170 }, token: tokC });
  expect('距離超出 → 403 not_at_gym + detail.distance_m', () => {
    assert.equal(far.status, 403); assert.equal(far.data.error, 'not_at_gym'); assert.ok(far.data.detail.distance_m > 1000);
  });
  const bad = await req('POST', '/api/coach/checkin', { body: {}, token: tokC });
  expect('缺座標 → 400 missing_location', () => assert.equal(bad.data.error, 'missing_location'));
  const ok = await req('POST', '/api/coach/checkin', { body: { ...GYM, accuracy: 12.5 }, token: tokC });
  expect('成功打卡 → 200，attendance 快照齊全', () => {
    assert.equal(ok.status, 200); assert.equal(ok.data.already, false);
    assert.equal(ok.data.attendance.source, 'checkin');
    assert.equal(ok.data.attendance.start_time, '00:00');
    assert.equal(ok.data.attendance.distance_m, 0);
  });
  const dup = await req('POST', '/api/coach/checkin', { body: GYM, token: tokC });
  expect('重複打卡 → 200 already=true 冪等', () => { assert.equal(dup.status, 200); assert.equal(dup.data.already, true); });
  db.prepare('UPDATE shift_attendance SET voided_at = ?, voided_by = ? WHERE id = ?')
    .run('2026-01-01T00:00:00', 1, ok.data.attendance.id);
  const voided = await req('POST', '/api/coach/checkin', { body: GYM, token: tokC });
  expect('已註銷再打 → 409 attendance_voided', () => { assert.equal(voided.status, 409); assert.equal(voided.data.error, 'attendance_voided'); });
  const noShift = await req('POST', '/api/coach/checkin', { body: GYM, token: tokD });
  expect('無班表教練 → 409 no_active_shift', () => { assert.equal(noShift.status, 409); assert.equal(noShift.data.error, 'no_active_shift'); });
}
{
  const t = await req('GET', '/api/coach/checkin/today', { token: tokC });
  expect('today 形狀：date/slots/extras/period/periodHours', () => {
    assert.equal(t.status, 200);
    assert.match(t.data.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(t.data.slots) && Array.isArray(t.data.extras));
    assert.match(t.data.period, /^\d{4}-\d{2}$/);
    assert.equal(typeof t.data.periodHours, 'number');
    assert.equal(t.data.slots[0].status, 'voided');
  });
  const im = await req('GET', `/api/coach/checkin/today?coachId=${cId}`, { token: tokD });
  expect('coachId query 無效——永遠回本人（D 無班表 slots 空）', () => {
    assert.equal(im.status, 200); assert.equal(im.data.slots.length, 0);
  });
}
console.log('[checkin-api test] done');
```

- [ ] **Step 2: 啟動 server 並跑測試確認失敗**

```bash
# 若 data/app.db 尚未 seed：npm run seed
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-server.pid"
sleep 1
node tests/checkin-api.test.js
```

Expected: 404 相關斷言失敗（路由不存在）

- [ ] **Step 3: 實作 `src/server.js`**

1. 第 97 行 import 改為：

```js
import { computePayroll, periodRange, defaultPeriod } from './services/payrollService.js';
import { checkIn as shiftCheckIn, todayStatus as shiftTodayStatus, coachPeriodHours,
  listShifts, createShift, updateShift, deleteShift, manualAttendance, voidAttendance } from './services/shiftService.js';
```

（admin 端 import 供 Task 7 使用，一次加齊。）

2. 限流器區（`lineBindLimiter` 宣告之後）加：

```js
const checkinLimiter = createRateLimiter({ name: 'checkin', windowMs: 60_000, max: 10 });
```

3. 教練自助區（`/api/coach/me` 路由群之後、`// --- Public group courses` 之前）加：

```js
// --- 駐場打卡（永遠本人：刻意不走 resolveCoach，管理者代登記走後台補登留稽核）---
app.get('/api/coach/checkin/today', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const status = shiftTodayStatus(coach.id);
  const period = defaultPeriod();
  const { displayStart, displayEnd } = periodRange(period);
  const periodHours = Math.round(coachPeriodHours(coach.id, displayStart, displayEnd) * 100) / 100;
  res.json({ ...status, period, periodHours });
}));

app.post('/api/coach/checkin', checkinLimiter, requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { lat, lng, accuracy } = req.body || {};
  const result = shiftCheckIn({ coachId: coach.id, lat: Number(lat), lng: Number(lng),
    accuracy: accuracy == null ? null : Number(accuracy) });
  res.json({ ok: true, already: result.already, attendance: result.attendance });
}));
```

注意：`Number(undefined)` 是 `NaN`，`checkIn` 內以 `Number.isFinite` 擋 → `missing_location`，不需在路由重複驗證。

- [ ] **Step 4: 重啟 server、跑測試確認通過**

```bash
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-server.pid")
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-server.pid"
sleep 1
node tests/checkin-api.test.js
```

Expected: 全部 `✓`

- [ ] **Step 5: 掛進 test:api 鏈**

`package.json` 的 `"test:api"` 尾端（`package-unit-price-api.test.js` 之後）追加：

```
 && node tests/checkin-api.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/server.js tests/checkin-api.test.js package.json
git commit -m "feat: 教練打卡 API（today/checkin，rate limit，代選免疫）"
```

---

### Task 7: Admin API — 班表 CRUD、時薪、補登/註銷、settings 鍵、payroll 回應

**Files:**
- Modify: `src/server.js`（admin payroll 路由區之後；settings handler）
- Modify: `src/services/coachService.js`（僅當 `listAllCoaches` 未含 `hourly_rate` 時）
- Test: `tests/shift-admin-api.test.js`（新檔）
- Modify: `tests/payroll-api.test.js`（done log 之前）
- Modify: `package.json`（`test:api` 鏈尾端）

**Interfaces:**
- Consumes: Task 2/4 service 函式、既有 `requireAdmin`、`svcGetCoach`（server.js 已 import 的 coachService `getCoach`）、settings PATCH handler
- Produces:
  - `GET /api/admin/shifts?coachId=` → row[]；`POST /api/admin/shifts` body `{ coach_id, day_of_week, start_time, end_time, effective_from, effective_to? }` → row
  - `PATCH /api/admin/shifts/:id` body `{ start_time?, end_time?, effective_from?, effective_to? }`（`effective_to: null` 清空）→ row；`DELETE /api/admin/shifts/:id` → `{ ok: true }`
  - `PATCH /api/admin/coaches/:id/hourly-rate` body `{ hourly_rate: int|null }`（0–100000）→ coach row
  - `POST /api/admin/attendance` body `{ coach_id, work_date, shift_id? | start_time+end_time, note? }` → row；`POST /api/admin/attendance/:id/void` → row
  - `GET/PATCH /api/admin/settings` 增鍵：`checkin_lat`（''｜-90~90）、`checkin_lng`（''｜-180~180）、`checkin_radius_m`（int 10–5000）、`checkin_window_before_min`（int 0–240）
  - `GET /api/admin/coaches` 每列含 `hourly_rate`

- [ ] **Step 1: 寫失敗測試**

建立 `tests/shift-admin-api.test.js`：

```js
// 駐場後台 API：班表 CRUD/時薪/補登/註銷/settings 驗證/權限。server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.2' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[shift-admin-api test] start');

db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%'));
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%');
  DELETE FROM users WHERE email LIKE 'sha-%';
`);
const cUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('SHA教練','sha-c@x.com','coach',?)").run(hashPassword('shapass123')).lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'SHA-C', 1)").run(cUid).lastInsertRowid);

const admin = (await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } })).data?.token;
const coach = (await req('POST', '/api/auth/login', { body: { email: 'sha-c@x.com', password: 'shapass123' } })).data?.token;
expect('登入成功', () => { assert.ok(admin); assert.ok(coach); });

// ── 權限 ──
{
  const r = await req('POST', '/api/admin/shifts', { token: coach, body: { coach_id: cId, day_of_week: 3, start_time: '09:00', end_time: '11:00', effective_from: '2032-01-01' } });
  expect('非管理者 → 403', () => assert.equal(r.status, 403));
}
// ── 班表 CRUD ──
let shiftId;
{
  const r = await req('POST', '/api/admin/shifts', { token: admin, body: { coach_id: cId, day_of_week: 3, start_time: '09:00', end_time: '11:00', effective_from: '2032-01-01' } });
  expect('新增班表 → 200 完整列', () => { assert.equal(r.status, 200); assert.equal(r.data.day_of_week, 3); shiftId = r.data.id; });
  const bad = await req('POST', '/api/admin/shifts', { token: admin, body: { coach_id: cId, day_of_week: 3, start_time: '11:00', end_time: '09:00', effective_from: '2032-01-01' } });
  expect('起訖顛倒 → 400 invalid_time_range', () => { assert.equal(bad.status, 400); assert.equal(bad.data.error, 'invalid_time_range'); });
  const ghost = await req('POST', '/api/admin/shifts', { token: admin, body: { coach_id: 999999, day_of_week: 3, start_time: '09:00', end_time: '11:00', effective_from: '2032-01-01' } });
  expect('coach 不存在 → 404 coach_not_found', () => assert.equal(ghost.data.error, 'coach_not_found'));
  const list = await req('GET', `/api/admin/shifts?coachId=${cId}`, { token: admin });
  expect('列表含新列', () => { assert.equal(list.status, 200); assert.ok(list.data.some((s) => s.id === shiftId)); });
  const patch = await req('PATCH', `/api/admin/shifts/${shiftId}`, { token: admin, body: { effective_to: '2032-06-30' } });
  expect('PATCH 結束日 → 200', () => assert.equal(patch.data.effective_to, '2032-06-30'));
  const clear = await req('PATCH', `/api/admin/shifts/${shiftId}`, { token: admin, body: { effective_to: null } });
  expect('PATCH effective_to null 清空', () => assert.equal(clear.data.effective_to, null));
}
// ── 時薪 ──
{
  const bad = await req('PATCH', `/api/admin/coaches/${cId}/hourly-rate`, { token: admin, body: { hourly_rate: 'abc' } });
  expect('非整數時薪 → 400 invalid_hourly_rate', () => assert.equal(bad.data.error, 'invalid_hourly_rate'));
  const ok = await req('PATCH', `/api/admin/coaches/${cId}/hourly-rate`, { token: admin, body: { hourly_rate: 480 } });
  expect('設時薪 480 → 200 回 coach 列', () => { assert.equal(ok.status, 200); assert.equal(ok.data.hourly_rate, 480); });
  const clear = await req('PATCH', `/api/admin/coaches/${cId}/hourly-rate`, { token: admin, body: { hourly_rate: null } });
  expect('時薪 null 清空', () => assert.equal(clear.data.hourly_rate, null));
  const coaches = await req('GET', '/api/admin/coaches', { token: admin });
  expect('GET /api/admin/coaches 每列含 hourly_rate 鍵', () => assert.ok(coaches.data.every((c) => 'hourly_rate' in c)));
}
// ── 補登 / 註銷 ──
let attId;
{
  const m = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-03', shift_id: shiftId, note: '補' } });
  expect('套班表補登 → 200 快照 09:00–11:00/2h', () => {
    assert.equal(m.status, 200); assert.equal(m.data.hours, 2); assert.equal(m.data.source, 'manual'); attId = m.data.id;
  });
  const dup = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-03', shift_id: shiftId } });
  expect('重複補登 → 409 duplicate_attendance', () => assert.equal(dup.data.error, 'duplicate_attendance'));
  const v = await req('POST', `/api/admin/attendance/${attId}/void`, { token: admin });
  expect('註銷 → 200 voided_at 有值', () => assert.ok(v.data.voided_at));
  const v2 = await req('POST', `/api/admin/attendance/${attId}/void`, { token: admin });
  expect('再註銷 → 409 already_voided', () => assert.equal(v2.data.error, 'already_voided'));
  const restore = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-03', shift_id: shiftId, note: '復原' } });
  expect('已註銷補登 → 復原同列', () => { assert.equal(restore.data.id, attId); assert.equal(restore.data.voided_at, null); });
  const custom = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-04', start_time: '18:00', end_time: '19:30' } });
  expect('自訂起訖補登 → 1.5h、shift_id null', () => { assert.equal(custom.data.hours, 1.5); assert.equal(custom.data.shift_id, null); });
}
// ── settings ──
{
  const bad = await req('PATCH', '/api/admin/settings', { token: admin, body: { checkin_lat: 999 } });
  expect('lat 999 → 400 invalid_checkin_lat', () => assert.equal(bad.data.error, 'invalid_checkin_lat'));
  const bad2 = await req('PATCH', '/api/admin/settings', { token: admin, body: { checkin_radius_m: 5 } });
  expect('radius 5 → 400 invalid_checkin_radius_m', () => assert.equal(bad2.data.error, 'invalid_checkin_radius_m'));
  const prev = (await req('GET', '/api/admin/settings', { token: admin })).data;
  const ok = await req('PATCH', '/api/admin/settings', { token: admin, body: { checkin_lat: 25.0330, checkin_lng: 121.5654, checkin_radius_m: 200, checkin_window_before_min: 20 } });
  expect('合法 checkin 參數 → payload 回填', () => {
    assert.equal(ok.data.checkin_lat, '25.033'); assert.equal(ok.data.checkin_radius_m, 200); assert.equal(ok.data.checkin_window_before_min, 20);
  });
  // 還原，避免影響其他 API 測試
  await req('PATCH', '/api/admin/settings', { token: admin, body: {
    checkin_lat: prev.checkin_lat === '' ? '' : Number(prev.checkin_lat),
    checkin_lng: prev.checkin_lng === '' ? '' : Number(prev.checkin_lng),
    checkin_radius_m: prev.checkin_radius_m, checkin_window_before_min: prev.checkin_window_before_min } });
}
// ── 班表刪除殿後（attendance FK SET NULL）──
{
  const del = await req('DELETE', `/api/admin/shifts/${shiftId}`, { token: admin });
  expect('刪除班表 → 200 ok', () => assert.deepEqual(del.data, { ok: true }));
  const gone = await req('DELETE', `/api/admin/shifts/${shiftId}`, { token: admin });
  expect('再刪 → 404 shift_not_found', () => assert.equal(gone.data.error, 'shift_not_found'));
}
console.log('[shift-admin-api test] done');
```

同時在 `tests/payroll-api.test.js` 的 done log 之前加：

```js
expect('coaches 元素含 shift 區塊、totals 含 shiftHours/shiftSalary', () => {
  const c = r0.data.coaches[0];
  if (c) { assert.ok(c.shift && 'hours' in c.shift && 'rate' in c.shift && 'salary' in c.shift && Array.isArray(c.shift.details)); }
  assert.equal(typeof r0.data.totals.shiftHours, 'number');
  assert.equal(typeof r0.data.totals.shiftSalary, 'number');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/shift-admin-api.test.js`（server 沿用 Task 6 起的背景行程）
Expected: 404/驗證斷言失敗

- [ ] **Step 3: 實作**

(a) `src/server.js` — `/api/admin/payroll` 路由之後加：

```js
// --- Admin: 駐場班表 / 時薪 / 出席補登與註銷 ---
app.get('/api/admin/shifts', requireAdmin, asyncHandler((req, res) => {
  const coachId = req.query.coachId ? Number(req.query.coachId) : null;
  res.json(listShifts(coachId));
}));

app.post('/api/admin/shifts', requireAdmin, asyncHandler((req, res) => {
  const b = req.body || {};
  const coach = svcGetCoach(Number(b.coach_id));
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  res.json(createShift({ coachId: coach.id, dayOfWeek: Number(b.day_of_week), startTime: b.start_time,
    endTime: b.end_time, effectiveFrom: b.effective_from, effectiveTo: b.effective_to ?? null }));
}));

app.patch('/api/admin/shifts/:id', requireAdmin, asyncHandler((req, res) => {
  const b = req.body || {};
  res.json(updateShift(Number(req.params.id), {
    startTime: b.start_time, endTime: b.end_time, effectiveFrom: b.effective_from,
    effectiveTo: 'effective_to' in b ? b.effective_to : undefined,
  }));
}));

app.delete('/api/admin/shifts/:id', requireAdmin, asyncHandler((req, res) => {
  deleteShift(Number(req.params.id));
  res.json({ ok: true });
}));

// 時薪：整數 0–100000，null/'' 清空（該教練不參與駐場薪資）。
app.patch('/api/admin/coaches/:id/hourly-rate', requireAdmin, asyncHandler((req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  const raw = req.body?.hourly_rate;
  let v = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 100000) return res.status(400).json({ error: 'invalid_hourly_rate' });
  }
  db.prepare('UPDATE coaches SET hourly_rate = ?, updated_at = ? WHERE id = ?').run(v, nowLocal(), coach.id);
  res.json(svcGetCoach(coach.id));
}));

app.post('/api/admin/attendance', requireAdmin, asyncHandler((req, res) => {
  const b = req.body || {};
  const coach = svcGetCoach(Number(b.coach_id));
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  res.json(manualAttendance({ coachId: coach.id, workDate: b.work_date,
    shiftId: b.shift_id != null ? Number(b.shift_id) : null,
    startTime: b.start_time ?? null, endTime: b.end_time ?? null,
    note: b.note ?? null, createdBy: req.user.id }));
}));

app.post('/api/admin/attendance/:id/void', requireAdmin, asyncHandler((req, res) => {
  res.json(voidAttendance(Number(req.params.id), req.user.id));
}));
```

前置確認：server.js 內 coachService 的 `getCoach` 匯入別名（既有代碼用 `svcGetCoach`）與 `nowLocal`、`db` 是否已 import（demote 路由已用到 `db`/`tx`；`nowLocal` 若未 import，從 `./db/connection.js` 的 import 行補上）。

(b) settings handler：payroll 參數 for-loop 之後加：

```js
  // 駐場打卡參數：座標可空字串（=未設定，打卡回 503）；半徑/窗口為整數範圍。
  for (const [key, min, max] of [['checkin_lat', -90, 90], ['checkin_lng', -180, 180]]) {
    if (b[key] !== undefined) {
      const s = String(b[key]).trim();
      if (s === '') { writes.push([key, '']); continue; }
      const v = Number(s);
      if (!Number.isFinite(v) || v < min || v > max) return res.status(400).json({ error: `invalid_${key}` });
      writes.push([key, String(v)]);
    }
  }
  for (const [key, min, max] of [['checkin_radius_m', 10, 5000], ['checkin_window_before_min', 0, 240]]) {
    if (b[key] !== undefined) {
      const n = Number(b[key]);
      if (!Number.isInteger(n) || n < min || n > max) return res.status(400).json({ error: `invalid_${key}` });
      writes.push([key, String(n)]);
    }
  }
```

`settingsPayload()` 加四鍵：

```js
    checkin_lat: getSetting('checkin_lat') || '',
    checkin_lng: getSetting('checkin_lng') || '',
    checkin_radius_m: Number(getSetting('checkin_radius_m') || '150'),
    checkin_window_before_min: Number(getSetting('checkin_window_before_min') || '30'),
```

(c) `coachService.listAllCoaches`：檢視其 SELECT——若是 `SELECT c.*, …` 已自帶 `hourly_rate`，不用改；若逐欄列舉，加 `c.hourly_rate`。

- [ ] **Step 4: 重啟 server、跑兩個測試確認通過**

```bash
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-server.pid")
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-server.pid"
sleep 1
node tests/shift-admin-api.test.js && node tests/payroll-api.test.js
```

Expected: 全部 `✓`

- [ ] **Step 5: 掛進 test:api 鏈**

`"test:api"` 尾端再追加：

```
 && node tests/shift-admin-api.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/services/coachService.js tests/shift-admin-api.test.js tests/payroll-api.test.js package.json
git commit -m "feat: 駐場後台 API（班表/時薪/補登/註銷/settings 打卡參數）"
```

---

### Task 8: 前端 — `/checkin` 打卡頁

**Files:**
- Create: `public/checkin.html`
- Create: `public/checkin.js`
- Modify: `src/server.js`（`/my-schedule` pretty-URL 區塊之後）

**Interfaces:**
- Consumes: `GET /api/coach/checkin/today`、`POST /api/coach/checkin`（Task 6 形狀）；`localStorage['chinup.token']`；`login.html?redirect=` 導回
- Produces: 使用者可達的 `/checkin` 頁（QR code 的目的地）

- [ ] **Step 1: 加 pretty-URL 路由**

`src/server.js` 的 `/my-schedule` sendFile 路由之後加：

```js
app.get('/checkin', (req, res) =>
  res.sendFile(resolve(__dirname, '../public/checkin.html'))
);
```

- [ ] **Step 2: 建立 `public/checkin.html`**

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>到場打卡 | CHIN UP</title>
  <link rel="stylesheet" href="/colors_and_type.css">
  <link rel="stylesheet" href="/style.css">
  <style>
    .ck-wrap{ max-width:420px; margin:0 auto; padding:24px 16px 48px; }
    .ck-card{ background:#fff; border-radius:16px; padding:20px; box-shadow:0 2px 12px rgba(15,23,42,.06); }
    .ck-date{ font-weight:800; font-size:1.05rem; }
    .ck-slot{ display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #eef2f7; font-size:.95rem; }
    .ck-slot:last-child{ border-bottom:none; }
    .ck-chip{ font-size:.75rem; padding:2px 8px; border-radius:999px; background:#eef2f7; color:#475569; white-space:nowrap; }
    .ck-chip.done{ background:#dcfce7; color:#166534; }
    .ck-chip.open{ background:#dbeafe; color:#1d4ed8; }
    .ck-btn{ width:100%; margin-top:16px; padding:14px 0; border:none; border-radius:12px; background:#0284c7; color:#fff; font-size:1.05rem; font-weight:800; cursor:pointer; }
    .ck-btn:disabled{ opacity:.5; cursor:default; }
    .ck-msg{ margin-top:12px; font-size:.9rem; line-height:1.5; }
    .ck-msg.ok{ color:#166534; }
    .ck-msg.err{ color:#b91c1c; }
    .ck-period{ margin-top:14px; font-size:.8rem; color:#64748b; text-align:center; }
  </style>
</head>
<body>
  <div class="ck-wrap">
    <div class="ck-card">
      <div class="ck-date" id="ck-date">載入中…</div>
      <div id="ck-slots"></div>
      <button class="ck-btn" id="ck-punch">到場打卡</button>
      <div class="ck-msg" id="ck-msg"></div>
      <div class="ck-period" id="ck-period"></div>
    </div>
  </div>
  <script src="/checkin.js"></script>
</body>
</html>
```

- [ ] **Step 3: 建立 `public/checkin.js`**

```js
// 到場打卡頁：掃館內 QR 進入。身分沿用 chinup.token；按打卡時取 GPS，由後端驗證在館內＋班表窗口。
const token = localStorage.getItem('chinup.token');
if (!token) location.replace('/login.html?redirect=' + encodeURIComponent('/checkin'));

const $ = (id) => document.getElementById(id);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const STATUS_CHIP = {
  done: ['已打卡 ✓', 'done'],
  open: ['可打卡', 'open'],
  upcoming: ['尚未開放', ''],
  closed: ['已結束', ''],
  voided: ['已註銷', ''],
};
const ERR_TEXT = {
  not_at_gym: (d) => `你似乎不在館內${d?.distance_m != null ? `（距離約 ${d.distance_m} 公尺）` : ''}，請到館內再打卡。`,
  no_active_shift: () => '現在沒有可打卡的班表時段，請於時段開始前再試。',
  attendance_voided: () => '此時段紀錄已被註銷，請聯繫管理者補登。',
  checkin_not_configured: () => '打卡尚未設定完成，請通知管理者到後台「薪資計算」填寫館址座標。',
  missing_location: () => '未取得定位，請重試。',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    location.replace('/login.html?redirect=' + encodeURIComponent('/checkin'));
    throw new Error('unauthenticated');
  }
  if (!res.ok) { const e = new Error(data?.error || String(res.status)); e.data = data; throw e; }
  return data;
}

function msg(text, cls) { const el = $('ck-msg'); el.textContent = text; el.className = 'ck-msg ' + (cls || ''); }

function render(d) {
  const dt = new Date(d.date + 'T00:00:00');
  $('ck-date').textContent = `${d.date.replace(/-/g, '/')}（週${WEEK[dt.getDay()]}）`;
  const rows = d.slots.map((s) => {
    const [label, cls] = STATUS_CHIP[s.status] || [s.status, ''];
    return `<div class="ck-slot"><span>${s.startTime}–${s.endTime}（${s.hours} 小時）</span><span class="ck-chip ${cls}">${label}</span></div>`;
  }).concat(d.extras.map((x) =>
    `<div class="ck-slot"><span>${x.startTime}–${x.endTime}（${x.hours} 小時）</span><span class="ck-chip done">補登 ✓</span></div>`
  ));
  $('ck-slots').innerHTML = rows.join('') || '<div class="ck-slot"><span>今天沒有你的班表時段</span></div>';
  $('ck-period').textContent = `本期（${d.period}）已累計 ${d.periodHours} 小時`;
}

async function load() {
  try { render(await api('/api/coach/checkin/today')); }
  catch (e) {
    if (e.data?.error === 'coach_only') { $('ck-date').textContent = '此頁僅供教練使用'; $('ck-punch').disabled = true; }
    else msg('載入失敗：' + (e.data?.error || e.message), 'err');
  }
}

$('ck-punch').addEventListener('click', () => {
  const btn = $('ck-punch');
  btn.disabled = true;
  msg('取得定位中…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const r = await api('/api/coach/checkin', { method: 'POST', body: {
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } });
      const a = r.attendance;
      msg(`${r.already ? '本時段已打卡 ✓' : '已記錄'}：${a.work_date.replace(/-/g, '/')} ${a.start_time}–${a.end_time}（${a.hours} 小時）`, 'ok');
      load();
    } catch (e) {
      msg((ERR_TEXT[e.data?.error] || (() => '打卡失敗：' + (e.data?.error || e.message)))(e.data?.detail), 'err');
    } finally { btn.disabled = false; }
  }, (err) => {
    btn.disabled = false;
    msg(err.code === err.PERMISSION_DENIED
      ? '無法取得定位：請允許此網站使用「位置」權限後重試（iPhone：設定 > Safari > 位置；Android：網址列鎖頭 > 權限 > 位置）。'
      : '定位失敗，請確認手機定位服務已開啟後重試。', 'err');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
});

load();
```

- [ ] **Step 4: 手動驗證（geolocation 需 HTTPS 或 localhost——本機 localhost 可直接測）**

1. 重啟 server（同 Task 7 Step 4 指令）。
2. `curl -sI http://localhost:3000/checkin | head -3` → `200`、`Content-Type: text/html`。
3. 瀏覽器開 `http://localhost:3000/checkin`：未登入 → 導向 `login.html?redirect=%2Fcheckin`；以測試教練登入 → 導回打卡頁。
4. 後台先設好座標＋該教練今天的班表（可先用 Task 7 的 API 直接 curl 建）。DevTools > More tools > Sensors 把 Location 設成館址座標 → 按「到場打卡」→ 顯示「已記錄：…（2 小時）」；改成別的城市座標 → 顯示「你似乎不在館內（距離約 N 公尺）」。
5. 再按一次（原座標）→「本時段已打卡 ✓」。

- [ ] **Step 5: Commit**

```bash
git add public/checkin.html public/checkin.js src/server.js
git commit -m "feat: /checkin 打卡頁（GPS＋班表狀態＋本期累計）"
```

---

### Task 9: 前端 — 後台薪資頁籤整合（表格/明細/註銷/CSV/駐場設定/補登）

**Files:**
- Modify: `public/admin.html`（payroll 面板：CSS 標籤區＋「抽成設定」section 之後）
- Modify: `public/admin.js`（`─── 薪資計算頁籤 ───` 區塊）

**Interfaces:**
- Consumes: Task 5 payroll 回應（`c.shift`、`totals.shiftHours/shiftSalary`）、Task 7 admin API 全部、既有 `api()`/`toast()`/`escapeHtml()`/`loadPayroll()`
- Produces: 老闆單頁完成：看駐場薪資、調時薪、管班表、補登、註銷、匯 CSV

- [ ] **Step 1: `public/admin.js` — 薪資表格加三欄**

(a) `prDT` 宣告之後加 helper：

```js
const prHoursNum = (n) => Math.round((n || 0) * 100) / 100;
```

(b) `renderPayroll()` 的 `<thead>`，`<th class="text-right p-3">團課薪資</th>` 之後插入：

```html
        <th class="text-right p-3">駐場時數</th>
        <th class="text-right p-3">駐場時薪</th>
        <th class="text-right p-3">駐場薪資</th>
```

(c) 教練列 `badges` 常數加一項（`o.future ? …` 之後）：

```js
            (c.shift.hours > 0 && c.shift.rate == null ? '<span class="pr-warn-badge">駐場無時薪</span>' : '');
```

（注意原本結尾的 `;` 移到新行。）

(d) 教練列 cells，`pr-c-gsal` 那格之後插入：

```html
            <td class="p-3 text-right pr-c-shifth">${c.shift.hours ? prHoursNum(c.shift.hours) + ' 小時' : '—'}</td>
            <td class="p-3 text-right pr-c-shiftr subtle">${c.shift.rate != null ? prNT(c.shift.rate) : '—'}</td>
            <td class="p-3 text-right pr-c-shifts">${prNT(c.shift.salary)}</td>
```

(e) 總計列同位置插入：

```html
          <td class="p-3 text-right pr-c-shifth">${prHoursNum(t.shiftHours)} 小時</td>
          <td class="p-3 text-right pr-c-shiftr">—</td>
          <td class="p-3 text-right pr-c-shifts">${prNT(t.shiftSalary)}</td>
```

(f) `prToggleDetail()`：`colspan="9"` 改 `colspan="12"`；`grpRows` 宣告之後加：

```js
  const shRows = c.shift.details.map((x) => `
    <tr><td>${x.workDate.slice(5).replace('-', '/')}　${x.startTime}–${x.endTime}</td>
        <td>${prHoursNum(x.hours)} 小時</td>
        <td>${x.source === 'manual' ? '補登' : '掃碼'}${x.checkedInAt ? '・' + x.checkedInAt.slice(11, 16) + ' 到場' : ''}${x.distanceM != null ? '・距 ' + x.distanceM + 'm' : ''}${x.note ? '・' + escapeHtml(x.note) : ''}</td>
        <td class="text-right"><button class="btn btn-ghost btn-sm pr-void-btn" data-aid="${x.attendanceId}">註銷</button></td></tr>`).join('');
```

detail row 的 innerHTML 內、團體課明細之後追加：

```html
      <h4>駐場明細（${prHoursNum(c.shift.hours)} 小時${c.shift.rate != null ? '・時薪 ' + prNT(c.shift.rate) : ''}）</h4>
      ${shRows ? `<table><tbody>${shRows}</tbody></table>` : '<div class="subtle text-sm">本期無駐場出席</div>'}
```

`tr.after(row);` 之後加註銷事件（兩段式確認，避免瀏覽器原生 confirm）：

```js
  row.querySelectorAll('.pr-void-btn').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.arm !== '1') {
      btn.dataset.arm = '1'; btn.textContent = '確認註銷？';
      setTimeout(() => { btn.dataset.arm = ''; btn.textContent = '註銷'; }, 3000);
      return;
    }
    try { await api(`/api/admin/attendance/${btn.dataset.aid}/void`, { method: 'POST' }); toast('已註銷', 'success'); loadPayroll(); }
    catch (err) { toast('註銷失敗：' + (err.data?.error || err.message), 'error'); }
  }));
```

(g) `prExportCsv()`：header 陣列 `'團課薪資'` 之後插 `'駐場時數', '駐場時薪', '駐場薪資'`；每列 `c.group.salary` 之後插 `prHoursNum(c.shift.hours), c.shift.rate ?? '', c.shift.salary`；總計列 `t.groupSalary` 之後插 `prHoursNum(t.shiftHours), '', t.shiftSalary`。

- [ ] **Step 2: `public/admin.html` — RWD 標籤與駐場區塊**

(a) CSS：`#pr-table td.pr-c-total::before` 那行之前加：

```css
  #pr-table td.pr-c-shifth::before{ content:"駐場時數"; }
  #pr-table td.pr-c-shiftr::before{ content:"駐場時薪"; }
  #pr-table td.pr-c-shifts::before{ content:"駐場薪資"; }
```

(b) 「抽成設定」`</section>` 之後、「<!-- 彙總表 -->」之前插入：

```html
  <!-- 駐場出勤 -->
  <section class="card mb-6">
    <div class="flex items-center justify-between">
      <h3 class="font-bold">駐場出勤</h3>
      <button id="sh-toggle" class="btn btn-ghost btn-sm">展開</button>
    </div>
    <div class="subtle text-sm mt-1">教練掃館內 QR code（/checkin 頁）到場打卡；依固定班表計時數，乘各自時薪併入上方薪資表。</div>
    <div id="sh-body" class="hidden mt-4">
      <h4 class="font-bold text-sm mb-2">打卡參數</h4>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label class="text-sm">館址緯度
          <input id="sh-lat" class="form-input mt-1" placeholder="25.0330"></label>
        <label class="text-sm">館址經度
          <input id="sh-lng" class="form-input mt-1" placeholder="121.5654"></label>
        <label class="text-sm">允許半徑（公尺）
          <input id="sh-radius" type="number" min="10" max="5000" class="form-input mt-1"></label>
        <label class="text-sm">可提早打卡（分鐘）
          <input id="sh-window" type="number" min="0" max="240" class="form-input mt-1"></label>
      </div>
      <div class="mt-2"><button id="sh-settings-save" class="btn btn-primary btn-sm">儲存參數</button></div>

      <h4 class="font-bold text-sm mb-2 mt-5">教練時薪與班表</h4>
      <div id="sh-coaches"></div>

      <h4 class="font-bold text-sm mb-2 mt-5">補登出席</h4>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
        <label class="text-sm">教練
          <select id="sh-m-coach" class="form-input mt-1"></select></label>
        <label class="text-sm">日期
          <input id="sh-m-date" type="date" class="form-input mt-1"></label>
        <label class="text-sm">套用班表時段
          <select id="sh-m-shift" class="form-input mt-1"><option value="">自訂起訖</option></select></label>
        <label class="text-sm">自訂起訖
          <div class="flex gap-1 mt-1"><input id="sh-m-start" type="time" class="form-input"><input id="sh-m-end" type="time" class="form-input"></div></label>
        <label class="text-sm">備註
          <input id="sh-m-note" class="form-input mt-1"></label>
      </div>
      <div class="mt-2"><button id="sh-m-save" class="btn btn-primary btn-sm">補登</button></div>
    </div>
  </section>
```

- [ ] **Step 3: `public/admin.js` — 駐場管理 JS（薪資頁籤區塊尾端、`pr-settings-cancel` 監聽之後追加）**

```js
// ─── 駐場出勤（打卡參數 / 教練時薪與班表 / 補登） ───────────
const SH_WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
let shCoaches = [];
let shShifts = [];
const shToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function loadShiftAdmin() {
  try {
    const [settings, coaches, shifts] = await Promise.all([
      api('/api/admin/settings'), api('/api/admin/coaches'), api('/api/admin/shifts'),
    ]);
    document.getElementById('sh-lat').value = settings.checkin_lat;
    document.getElementById('sh-lng').value = settings.checkin_lng;
    document.getElementById('sh-radius').value = settings.checkin_radius_m;
    document.getElementById('sh-window').value = settings.checkin_window_before_min;
    shCoaches = coaches; shShifts = shifts;
    renderShCoaches();
    renderShManualCoachOptions();
    renderShManualShiftOptions();
  } catch (e) { toast('駐場資料載入失敗：' + e.message, 'error'); }
}

function renderShCoaches() {
  const box = document.getElementById('sh-coaches');
  const rows = shCoaches.filter((c) => c.is_active || shShifts.some((s) => s.coach_id === c.id));
  box.innerHTML = rows.map((c) => {
    const shiftRows = shShifts.filter((s) => s.coach_id === c.id).map((s) => `
      <tr data-sid="${s.id}">
        <td>${SH_WEEK[s.day_of_week]} ${s.start_time}–${s.end_time}</td>
        <td class="subtle">自 ${s.effective_from}</td>
        <td><input type="date" class="form-input sh-eff-to" value="${s.effective_to || ''}" title="結束日（含當日；留空＝持續有效）"></td>
        <td class="text-right">
          <button class="btn btn-ghost btn-sm sh-shift-save">儲存</button>
          <button class="btn btn-ghost btn-sm sh-shift-del">刪除</button>
        </td>
      </tr>`).join('');
    return `
    <div class="sh-coach card mb-3" data-cid="${c.id}">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <span class="font-medium">${escapeHtml(c.display_name)}</span>
        <span class="text-sm">時薪
          <input type="number" min="0" class="form-input sh-rate" style="width:90px" value="${c.hourly_rate ?? ''}" placeholder="未設">
          <button class="btn btn-ghost btn-sm sh-rate-save">儲存</button></span>
      </div>
      <table class="w-full text-sm mt-2"><tbody>${shiftRows}</tbody></table>
      <div class="flex flex-wrap gap-2 mt-2 items-end text-sm">
        <select class="form-input sh-new-dow">${SH_WEEK.map((w, i) => `<option value="${i}">${w}</option>`).join('')}</select>
        <input type="time" class="form-input sh-new-start">
        <input type="time" class="form-input sh-new-end">
        <input type="date" class="form-input sh-new-from" value="${shToday()}" title="生效日">
        <button class="btn btn-primary btn-sm sh-shift-add">新增班表</button>
      </div>
    </div>`;
  }).join('') || '<div class="subtle text-sm">尚無啟用教練</div>';
}

document.getElementById('sh-coaches').addEventListener('click', async (e) => {
  const card = e.target.closest('.sh-coach');
  if (!card) return;
  const cid = Number(card.dataset.cid);
  try {
    if (e.target.classList.contains('sh-rate-save')) {
      const raw = card.querySelector('.sh-rate').value.trim();
      await api(`/api/admin/coaches/${cid}/hourly-rate`, { method: 'PATCH', body: { hourly_rate: raw === '' ? null : Number(raw) } });
      toast('時薪已更新', 'success'); loadShiftAdmin(); loadPayroll();
    } else if (e.target.classList.contains('sh-shift-add')) {
      await api('/api/admin/shifts', { method: 'POST', body: {
        coach_id: cid,
        day_of_week: Number(card.querySelector('.sh-new-dow').value),
        start_time: card.querySelector('.sh-new-start').value,
        end_time: card.querySelector('.sh-new-end').value,
        effective_from: card.querySelector('.sh-new-from').value,
      } });
      toast('班表已新增', 'success'); loadShiftAdmin();
    } else if (e.target.classList.contains('sh-shift-save')) {
      const tr = e.target.closest('tr');
      await api(`/api/admin/shifts/${tr.dataset.sid}`, { method: 'PATCH', body: { effective_to: tr.querySelector('.sh-eff-to').value || null } });
      toast('班表已更新', 'success'); loadShiftAdmin();
    } else if (e.target.classList.contains('sh-shift-del')) {
      if (e.target.dataset.arm !== '1') {
        e.target.dataset.arm = '1'; e.target.textContent = '確認刪除？';
        setTimeout(() => { e.target.dataset.arm = ''; e.target.textContent = '刪除'; }, 3000);
        return;
      }
      await api(`/api/admin/shifts/${e.target.closest('tr').dataset.sid}`, { method: 'DELETE' });
      toast('班表已刪除（誤建用；正常結束班表請填結束日）', 'success'); loadShiftAdmin();
    }
  } catch (err) {
    const msgs = { invalid_time_range: '起訖時間無效', invalid_effective_range: '生效日期無效', invalid_hourly_rate: '時薪需為 0–100000 的整數' };
    toast(msgs[err.data?.error] || '操作失敗：' + (err.data?.error || err.message), 'error');
  }
});

function renderShManualCoachOptions() {
  document.getElementById('sh-m-coach').innerHTML =
    shCoaches.filter((c) => c.is_active).map((c) => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
}
function renderShManualShiftOptions() {
  const cid = Number(document.getElementById('sh-m-coach').value);
  const date = document.getElementById('sh-m-date').value;
  let opts = '<option value="">自訂起訖</option>';
  if (cid && date) {
    const dow = new Date(date + 'T00:00:00').getDay();
    opts += shShifts
      .filter((s) => s.coach_id === cid && s.day_of_week === dow && s.effective_from <= date && (!s.effective_to || s.effective_to >= date))
      .map((s) => `<option value="${s.id}">${s.start_time}–${s.end_time}</option>`).join('');
  }
  document.getElementById('sh-m-shift').innerHTML = opts;
}
document.getElementById('sh-m-coach').addEventListener('change', renderShManualShiftOptions);
document.getElementById('sh-m-date').addEventListener('change', renderShManualShiftOptions);

document.getElementById('sh-m-save').addEventListener('click', async () => {
  const shiftId = document.getElementById('sh-m-shift').value;
  const body = {
    coach_id: Number(document.getElementById('sh-m-coach').value),
    work_date: document.getElementById('sh-m-date').value,
    note: document.getElementById('sh-m-note').value.trim() || null,
  };
  if (shiftId) body.shift_id = Number(shiftId);
  else {
    body.start_time = document.getElementById('sh-m-start').value;
    body.end_time = document.getElementById('sh-m-end').value;
  }
  try {
    await api('/api/admin/attendance', { method: 'POST', body });
    toast('已補登', 'success');
    document.getElementById('sh-m-note').value = '';
    loadPayroll();
  } catch (err) {
    const msgs = { duplicate_attendance: '該時段已有出席紀錄', invalid_time_range: '起訖時間無效', invalid_work_date: '日期無效', shift_not_found: '找不到該班表' };
    toast(msgs[err.data?.error] || '補登失敗：' + (err.data?.error || err.message), 'error');
  }
});

document.getElementById('sh-settings-save').addEventListener('click', async () => {
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: {
      checkin_lat: document.getElementById('sh-lat').value.trim(),
      checkin_lng: document.getElementById('sh-lng').value.trim(),
      checkin_radius_m: Number(document.getElementById('sh-radius').value),
      checkin_window_before_min: Number(document.getElementById('sh-window').value),
    } });
    toast('打卡參數已儲存', 'success');
  } catch (err) { toast('儲存失敗：' + (err.data?.error || err.message), 'error'); }
});

document.getElementById('sh-toggle').addEventListener('click', () => {
  const body = document.getElementById('sh-body');
  body.classList.toggle('hidden');
  document.getElementById('sh-toggle').textContent = body.classList.contains('hidden') ? '展開' : '收合';
  if (!body.classList.contains('hidden')) loadShiftAdmin();
});
```

- [ ] **Step 4: 手動驗證（manual smoke）**

1. 重啟 server → 後台登入 → 薪資計算頁籤。
2. 「駐場出勤」展開：填座標/半徑/窗口 → 儲存 → 重整後值仍在。
3. 給一位教練設時薪 500、加一條今天的班表 → 用 `/checkin`（Sensors 模擬座標）打卡 → 回薪資頁重整：該教練多了「駐場時數 2 小時／NT$500／NT$1,000」，總計同步增加。
4. 點該教練列展開明細 → 駐場明細列出該筆（掃碼・HH:MM 到場・距 0m）→ 按「註銷」→「確認註銷？」→ 再按 → 列表刷新、薪資歸零。
5. 補登表單：選教練＋日期 → 時段下拉出現該日班表 → 補登 → 明細出現「補登」列；同時段再補登 → toast「該時段已有出席紀錄」。
6. 匯出 CSV → 開檔確認三個新欄位與數字。
7. 視窗縮到 <768px：新欄位有「駐場時數/時薪/薪資」卡片標籤。

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台薪資頁籤併入駐場（欄位/明細/註銷/CSV/設定/補登）"
```

---

### Task 10: 全套驗證、收尾與上線材料

**Files:**
- Modify: 無新程式；驗證與 ops
- Create: `docs/manuals/checkin-qr.png`（列印 QR，gitignore 狀態不明——若 `docs/manuals/` 未追蹤則放 `_design/` 同等未追蹤位置即可，不強求進版控）

**Interfaces:**
- Consumes: 全部 Task
- Produces: 綠色 test suite、push 的分支＋draft PR、列印用 QR、上線 checklist

- [ ] **Step 1: 停掉背景 server、跑全套 service 測試**

```bash
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-server.pid") 2>/dev/null
npm test
```

Expected: 全部檔案 `✓`（注意：`npm test` 會清洗 `data/app.db`）

- [ ] **Step 2: 重新 seed、起 server、跑全套 API 測試**

```bash
# 既有 test:api 檔需要啟用教練與 GOOGLE_CLIENT_ID（public-api/backup-api 用 seed-demo 的 fixture；gmail-auth-api 需假 client id）
node src/db/seed-demo.js
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-server.pid"
sleep 1
npm run test:api
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-server.pid")
```

Expected: 全部 `✓`

- [ ] **Step 3: 產列印 QR code（不加 repo 依賴，npx 一次性）**

```bash
npx --yes qrcode "https://chin.up.railway.app/checkin" -o checkin-qr.png -w 1024
```

輸出檔留在 repo root（未追蹤）或移到業主可拿到的地方；建議印 A5 以上貼櫃檯。

- [ ] **Step 4: Push 分支＋開 draft PR（無 gh CLI，走 REST API；PAT 在 osxkeychain）**

```bash
git push -u origin feature/shift-attendance-checkin
TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p')
curl -s -X POST https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"title":"駐場打卡與時薪整合（QR+GPS 打卡、班表時段制、併入薪資頁籤）","head":"feature/shift-attendance-checkin","base":"main","draft":true,"body":"Spec: docs/superpowers/specs/2026-07-09-shift-attendance-checkin-design.md\nPlan: docs/superpowers/plans/2026-07-09-shift-attendance-checkin.md\n\n- 教練掃館內 QR → /checkin 頁 GPS 打卡（防遠端；不走 resolveCoach 代選）\n- coach_shifts 固定週班表（生效起迄）＋ shift_attendance 快照/軟刪\n- computePayroll 併入駐場（每人時薪、同期別、CSV 三欄）\n- 後台：駐場設定/時薪/班表 CRUD/補登/註銷\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

（守 memory 慣例：之後任何 review 修正 commit 都要先 `git push` 再 merge——squash 取的是 origin HEAD。）

- [ ] **Step 5: 上線 checklist（merge 後、業主端）**

1. Merge → Railway 自動部署（migration 皆冪等非破壞）。
2. 後台 > 薪資計算 > 駐場出勤：填館址座標（Google Maps 對館址按右鍵複製座標）、半徑預設 150、窗口預設 30。
3. 設三位教練時薪＋各自固定班表。
4. 貼 QR code 到館內；三位教練手機各登入一次 `chin.up.railway.app/checkin`。
5. 首週建議：老闆每週對一次「駐場明細」，確認打卡習慣成形。

---

## Self-Review（計畫對 spec 的覆蓋檢查）

- 資料模型三件套（hourly_rate/coach_shifts/shift_attendance＋UNIQUE＋索引）→ Task 1。
- 班表生效起迄、結束＝填日期 → Task 2（service）＋ Task 7（PATCH）＋ Task 9（UI date input）。
- 打卡五步驗證、窗口 [start−30, end]、多列取最早、冪等、已註銷 409、快照、GPS 佐證留檔 → Task 3/6。
- 錯誤處理表全數 → Task 3（碼）＋ Task 8（文案，含定位權限引導）。
- 補登（套班表/自訂）、復原語意、註銷軟刪 → Task 4/7/9。
- 薪資整合（期別含端點、Math.round、totals、CSV 三欄、NULL 時薪提醒 badge、停用教練有駐場資料仍列）→ Task 5/9。
- `/api/coach/checkin/today` 本期累計（defaultPeriod 口徑）→ Task 6；`coachId` 代選免疫測試 → Task 6。
- settings 四鍵驗證與 payload → Task 7。
- rate limit → Task 6。測試慣例/遠年份/前綴清理 → 各測試檔。上線四步 → Task 10。
- 刻意不做清單未出現在任何 Task（無通知/拍照/動態QR/起訖打卡/時薪快照）✓。
