# 固定時段＋指派教練（Gym Slots Assignment）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台駐場班表從「每位教練各自維護」翻轉為「館方固定上班時段 → 指派教練」，指派時自動展開成既有 `coach_shifts` 列，打卡／出席／薪資核心零改動。

**Architecture:** 新增 `gym_slots` 表（時段實體）＋`coach_shifts.slot_id` 連結欄；指派＝交易內展開一列 `coach_shifts`（複製時段參數），時段修改同交易連動旗下教練列；既有資料開機冪等歸組。後台 UI 改為時段卡片＋教練 chips＋精簡時薪列。

**Tech Stack:** Node 24 ESM、Express、`node:sqlite`、原生 JS 靜態頁、`assert/strict` 測試腳本。

**Spec:** `docs/superpowers/specs/2026-07-09-gym-slots-assignment-design.md`（唯一需求來源）

## Global Constraints

- 分支：`feature/gym-slots-assignment`（已存在，spec 已 commit）。每 Task 結尾 commit，訊息結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **核心不變式：`/checkin` 打卡、出席快照、補登、註銷、`computePayroll` 一行不改**；既有 `/api/admin/shifts` 端點保留不拆。既有全部測試必須保持綠燈。
- 時間＝台北牆鐘字串；日期 `'YYYY-MM-DD'`、時間 `'HH:MM'`；錯誤 `throw new ApiError(status, code, detail?)`；prepared statements 宣告在 service 模組頂層；註解與 UI 文案繁體中文。
- 新錯誤碼：`slot_not_found`、`coach_already_in_slot`、`coach_not_in_slot`；時段欄位驗證重用既有 `validateShiftFields`（`invalid_day_of_week`／`invalid_time_range`／`invalid_effective_range`）。
- `PATCH /api/admin/slots/:id` **不允許改 `day_of_week`**（service 的 updateSlot 沒有 dayOfWeek 參數）。
- CASCADE 一律在 service 層以交易顯式實作（既有 DB 的 `slot_id` 為 ALTER 加欄、REFERENCES 無強制力）。
- 測試慣例：`assert/strict`＋`expect(label, fn)`＋`[x test] start/done` 標記；本 feature 用 email 前綴 `gsl-`（service）／`sla-`（API）、遠年份 **2033**（2031/2032 已被既有測試佔用）、API 測試專屬 `X-Forwarded-For: 10.99.7.3`。
- API 測試前置（沿用已修正口徑）：`node src/db/seed-demo.js` ＋ server 帶 `LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id`。`role=user` 帳號不能登入（閘門），測試身分用 admin（`admin@chinup.local`/`admin1234`）與自建 coach（可登入）。
- `npm test` 會清洗 `data/app.db`，跑完要 `node src/db/seed-demo.js` 再預覽。不新增任何 npm 依賴。

---

### Task 1: Schema — `gym_slots`＋`coach_shifts.slot_id`＋歸組 migration

**Files:**
- Modify: `src/db/schema.js`（`coach_availability_exceptions` 區塊之後、既有 `coach_shifts` CREATE 之前插入 `gym_slots`；`coach_shifts` CREATE 加 `slot_id` 欄）
- Modify: `src/db/connection.js`（`2026-07-09 駐場打卡與時薪` 區塊（`addColumnIfMissing('coaches', 'hourly_rate', 'INTEGER');`，約 249 行）之後）
- Test: `tests/gym-slots.test.js`（新檔）
- Modify: `package.json`（`test` 鏈尾端）

**Interfaces:**
- Consumes: 既有 `addColumnIfMissing`；`coach_shifts` 既有欄位。
- Produces: `gym_slots` 表（`id, day_of_week, start_time, end_time, effective_from, effective_to, created_at`）；`coach_shifts.slot_id INTEGER`（fresh DB 帶 `REFERENCES gym_slots(id) ON DELETE CASCADE`）；`backfillGymSlots(): number`（connection.js 具名匯出，回傳本次建立的時段數；開機自動呼叫一次）。

- [ ] **Step 1: 寫失敗測試**

建立 `tests/gym-slots.test.js`：

```js
// 固定時段＋指派：schema/歸組 migration/slots service。資料鎖 2033 年與 gsl- 前綴。
import assert from 'node:assert/strict';
const { db, backfillGymSlots } = await import('../src/db/connection.js');
const { createShift } = await import('../src/services/shiftService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gym-slots test] start');

// ── FK-safe 清理（attendance → shifts → slots → coaches → users）──
db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gsl-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gsl-%'));
  DELETE FROM gym_slots WHERE effective_from LIKE '2033-%';   -- 只掃本測試年份，勿全域掃孤兒時段（無教練時段是合法狀態）
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gsl-%');
  DELETE FROM users WHERE email LIKE 'gsl-%';
`);
function mkCoach(tag) {
  const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES (?,?,'coach')").run(tag, `gsl-${tag}@x.com`).lastInsertRowid);
  return Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, ?, 1)").run(uid, tag).lastInsertRowid);
}
const cA = mkCoach('A');
const cB = mkCoach('B');

// ── schema ──
expect('gym_slots 表存在且欄位齊全', () => {
  const cols = db.prepare('PRAGMA table_info(gym_slots)').all().map((c) => c.name);
  for (const k of ['id','day_of_week','start_time','end_time','effective_from','effective_to','created_at']) assert.ok(cols.includes(k), k);
});
expect('coach_shifts.slot_id 欄位存在', () => {
  assert.ok(db.prepare('PRAGMA table_info(coach_shifts)').all().map((c) => c.name).includes('slot_id'));
});

// ── 歸組 migration ──
expect('backfill：同參數多教練列併一時段、不同參數各自成段、重跑 no-op', () => {
  // createShift 走舊路徑（slot_id NULL）→ 模擬升級前資料
  createShift({ coachId: cA, dayOfWeek: 3, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-01-01' });
  createShift({ coachId: cB, dayOfWeek: 3, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-01-01' });
  createShift({ coachId: cA, dayOfWeek: 5, startTime: '18:00', endTime: '20:00', effectiveFrom: '2033-01-01' });
  const created = backfillGymSlots();
  assert.equal(created, 2);                                    // 兩組 → 兩個時段
  const orphans = db.prepare("SELECT COUNT(*) AS c FROM coach_shifts WHERE slot_id IS NULL").get().c;
  assert.equal(orphans, 0);
  const wed = db.prepare("SELECT DISTINCT slot_id FROM coach_shifts WHERE coach_id IN (?, ?) AND day_of_week = 3").all(cA, cB);
  assert.equal(wed.length, 1);                                 // A、B 共用同一時段
  assert.equal(backfillGymSlots(), 0);                         // 冪等
});
console.log('[gym-slots test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/gym-slots.test.js`
Expected: import 失敗（`backfillGymSlots` 未匯出）或 PRAGMA 斷言失敗

- [ ] **Step 3: 實作**

(a) `src/db/schema.js` — 在 `coach_availability_exceptions` 區塊結束後、「-- 駐場固定週班表」註解之前插入：

```sql
-- 館方固定上班時段（老闆先建時段、再指派教練；指派展開成 coach_shifts 列）
CREATE TABLE IF NOT EXISTS gym_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);
```

(b) 同檔 `coach_shifts` 的 CREATE TABLE：在 `effective_to TEXT,` 之後加一行（fresh DB 直接帶欄與 FK）：

```sql
  slot_id INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE,
```

(c) `src/db/connection.js` — `addColumnIfMissing('coaches', 'hourly_rate', 'INTEGER');` 之後加：

```js
// ── 2026-07-09 固定時段＋指派教練 ──
// coach_shifts.slot_id：所屬館方時段（gym_slots）。ALTER 加欄的 REFERENCES 無強制力
// （比照 bookings.session_type 對 CHECK 的處理），CASCADE 由 service 層交易顯式實作。
addColumnIfMissing('coach_shifts', 'slot_id', 'INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE');

/** 歸組 backfill：slot_id IS NULL 的既有班表按（星期＋起訖＋生效起迄）分組建 gym_slots 並回填。
 *  冪等（無 NULL 列＝no-op）。回傳本次建立的時段數。 */
export function backfillGymSlots() {
  const orphans = db.prepare('SELECT * FROM coach_shifts WHERE slot_id IS NULL ORDER BY id ASC').all();
  if (!orphans.length) return 0;
  const insertSlot = db.prepare('INSERT INTO gym_slots (day_of_week, start_time, end_time, effective_from, effective_to) VALUES (?, ?, ?, ?, ?)');
  const setSlot = db.prepare('UPDATE coach_shifts SET slot_id = ? WHERE id = ?');
  const groups = new Map();
  for (const r of orphans) {
    const key = [r.day_of_week, r.start_time, r.end_time, r.effective_from, r.effective_to ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let created = 0;
  db.exec('BEGIN');
  try {
    for (const rows of groups.values()) {
      const r0 = rows[0];
      const slotId = Number(insertSlot.run(r0.day_of_week, r0.start_time, r0.end_time, r0.effective_from, r0.effective_to).lastInsertRowid);
      created++;
      for (const r of rows) setSlot.run(slotId, r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  console.log(`[migrate] gym_slots 歸組：${orphans.length} 列班表 → ${created} 個時段`);
  return created;
}
backfillGymSlots();
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/gym-slots.test.js` → 全部 `✓`
Run: `node tests/shift-service.test.js && node tests/shift-migration.test.js` → 既有測試仍綠（createShift 走舊路徑不受影響）

- [ ] **Step 5: 掛進 test 鏈＋Commit**

`package.json` 的 `"test"` 尾端（`node tests/shift-service.test.js` 之後）追加 ` && node tests/gym-slots.test.js`。

```bash
git add src/db/schema.js src/db/connection.js tests/gym-slots.test.js package.json
git commit -m "feat: gym_slots 表＋coach_shifts.slot_id＋開機歸組 migration"
```

---

### Task 2: shiftService — 時段 CRUD 與指派

**Files:**
- Modify: `src/services/shiftService.js`（檔尾追加一節；prepared statements 置於該節開頭的模組層）
- Modify: `tests/gym-slots.test.js`（`console.log('[gym-slots test] done')` 之前插入）

**Interfaces:**
- Consumes: 既有 `validateShiftFields`、`getShiftStmt`、`deleteShiftStmt`、`tx`、`ApiError`；Task 1 的 `gym_slots`／`slot_id`。
- Produces（Task 3/4 依賴；slot row 為 snake_case、coaches 內嵌為 camelCase）:
  - `listSlots(): Array<slotRow & { coaches: [{ coachId, displayName, shiftId }] }>`（`day_of_week, start_time` 升冪；coaches 按 displayName 升冪）
  - `getSlot(id): row | undefined`
  - `createSlot({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo = null }): row`
  - `updateSlot(id, { startTime, endTime, effectiveFrom, effectiveTo }): row` — 局部更新、**無 dayOfWeek 參數**、`effectiveTo: null` 清空；交易內連動 `UPDATE coach_shifts WHERE slot_id`
  - `deleteSlot(id): void` — 交易內顯式連動刪旗下教練列；404 `slot_not_found`
  - `assignCoach(slotId, coachId): shiftRow` — 404 `slot_not_found`、409 `coach_already_in_slot`；展開列複製時段參數＋掛 `slot_id`
  - `unassignCoach(slotId, coachId): void` — 404 `coach_not_in_slot`

- [ ] **Step 1: 寫失敗測試**

在 `tests/gym-slots.test.js` 的 done log 之前插入：

```js
// ── slots service ──
const { listSlots, getSlot, createSlot, updateSlot, deleteSlot, assignCoach, unassignCoach } =
  await import('../src/services/shiftService.js');
const { manualAttendance } = await import('../src/services/shiftService.js');

const s1 = createSlot({ dayOfWeek: 2, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-02-01' });
expect('createSlot 回傳完整列＋驗證重用', () => {
  assert.equal(s1.day_of_week, 2); assert.equal(s1.effective_to, null);
  assert.throws(() => createSlot({ dayOfWeek: 7, startTime: '09:00', endTime: '10:00', effectiveFrom: '2033-02-01' }),
    (e) => e.code === 'invalid_day_of_week');
  assert.throws(() => createSlot({ dayOfWeek: 2, startTime: '11:00', endTime: '09:00', effectiveFrom: '2033-02-01' }),
    (e) => e.code === 'invalid_time_range');
});
expect('assignCoach 展開列：複製時段參數＋掛 slot_id；重複 → 409', () => {
  const row = assignCoach(s1.id, cA);
  assert.equal(row.coach_id, cA); assert.equal(row.slot_id, s1.id);
  assert.equal(row.day_of_week, 2); assert.equal(row.start_time, '09:00'); assert.equal(row.effective_from, '2033-02-01');
  assert.throws(() => assignCoach(s1.id, cA), (e) => e.status === 409 && e.code === 'coach_already_in_slot');
  assert.throws(() => assignCoach(999999, cA), (e) => e.code === 'slot_not_found');
});
expect('listSlots 內嵌教練＋排序', () => {
  assignCoach(s1.id, cB);
  const list = listSlots();
  const mine = list.find((s) => s.id === s1.id);
  assert.deepEqual(mine.coaches.map((c) => c.displayName), ['A', 'B']);
  assert.ok('coachId' in mine.coaches[0] && 'shiftId' in mine.coaches[0]);
  const keys = list.map((s) => s.day_of_week * 10000 + Number(s.start_time.replace(':', '')));
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
});
expect('updateSlot 連動旗下教練列、歷史出席快照不變、不可改星期（無此參數）', () => {
  const shiftRow = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ? AND coach_id = ?').get(s1.id, cA);
  const att = manualAttendance({ coachId: cA, workDate: '2033-02-08', shiftId: shiftRow.id, createdBy: 1 });  // manual 補登不驗日期星期（既有行為）
  const u = updateSlot(s1.id, { startTime: '10:00', endTime: '12:00' });
  assert.equal(u.start_time, '10:00');
  const rows = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ?').all(s1.id);
  assert.ok(rows.every((r) => r.start_time === '10:00' && r.end_time === '12:00'));
  assert.equal(db.prepare('SELECT start_time FROM shift_attendance WHERE id = ?').get(att.id).start_time, '09:00');  // 快照
  assert.equal(updateSlot(s1.id, { effectiveTo: '2033-12-31' }).effective_to, '2033-12-31');
  assert.equal(updateSlot(s1.id, { effectiveTo: null }).effective_to, null);
  assert.throws(() => updateSlot(999999, { startTime: '08:00' }), (e) => e.code === 'slot_not_found');
});
expect('unassignCoach 刪列、出席鏈不斷（shift_id 變 NULL、快照仍在）', () => {
  unassignCoach(s1.id, cA);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM coach_shifts WHERE slot_id = ? AND coach_id = ?').get(s1.id, cA).c, 0);
  const att = db.prepare("SELECT * FROM shift_attendance WHERE coach_id = ? AND work_date = '2033-02-08'").get(cA);
  assert.equal(att.shift_id, null); assert.equal(att.hours, 2);   // ON DELETE SET NULL＋快照保帳
  assert.throws(() => unassignCoach(s1.id, cA), (e) => e.code === 'coach_not_in_slot');
});
expect('deleteSlot 連動刪旗下教練列', () => {
  const s2 = createSlot({ dayOfWeek: 6, startTime: '08:00', endTime: '10:00', effectiveFrom: '2033-02-01' });
  assignCoach(s2.id, cB);
  deleteSlot(s2.id);
  assert.equal(getSlot(s2.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM coach_shifts WHERE slot_id = ?').get(s2.id).c, 0);
  assert.throws(() => deleteSlot(s2.id), (e) => e.code === 'slot_not_found');
});
```

（測試開頭清理已在 Task 1 建立；`manualAttendance` 需要 `users` id=1——在清理區塊後補與 `tests/shift-service.test.js` **完全相同**的一行：`db.prepare("INSERT OR IGNORE INTO users (id, name, email, role) VALUES (1, 'Test', 'test@example.com', 'user')").run();`。**不要**用 `gsl-` 前綴 email——那會讓本檔清理刪掉 id=1，而其他測試檔的 `shift_attendance.created_by=1` 會以 FK 擋下刪除、整個清理炸掉。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/gym-slots.test.js` → `createSlot` 未匯出

- [ ] **Step 3: 實作（`shiftService.js` 檔尾追加）**

```js
// ── 館方固定時段（gym_slots）＋指派展開 ──
// 指派＝在交易中展開一列 coach_shifts（複製時段參數、掛 slot_id）；時段修改連動旗下教練列。
// CASCADE 顯式實作（既有 DB 的 slot_id 無強制 FK）。規則見 2026-07-09-gym-slots-assignment-design.md。

const listSlotsStmt = db.prepare('SELECT * FROM gym_slots ORDER BY day_of_week ASC, start_time ASC');
const getSlotStmt = db.prepare('SELECT * FROM gym_slots WHERE id = ?');
const insertSlotStmt = db.prepare('INSERT INTO gym_slots (day_of_week, start_time, end_time, effective_from, effective_to) VALUES (?, ?, ?, ?, ?)');
const updateSlotStmt = db.prepare('UPDATE gym_slots SET start_time = ?, end_time = ?, effective_from = ?, effective_to = ? WHERE id = ?');
const deleteSlotStmt = db.prepare('DELETE FROM gym_slots WHERE id = ?');
const slotCoachesStmt = db.prepare(`
  SELECT cs.id AS shift_id, cs.coach_id, c.display_name
  FROM coach_shifts cs JOIN coaches c ON c.id = cs.coach_id
  WHERE cs.slot_id = ? ORDER BY c.display_name ASC
`);
const slotShiftForCoachStmt = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ? AND coach_id = ?');
const updateSlotShiftsStmt = db.prepare('UPDATE coach_shifts SET start_time = ?, end_time = ?, effective_from = ?, effective_to = ? WHERE slot_id = ?');
const deleteSlotShiftsStmt = db.prepare('DELETE FROM coach_shifts WHERE slot_id = ?');
const insertShiftForSlotStmt = db.prepare(`
  INSERT INTO coach_shifts (coach_id, day_of_week, start_time, end_time, effective_from, effective_to, slot_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/** 時段清單（星期、開始時間升冪），內嵌已指派教練（displayName 升冪）。 */
export function listSlots() {
  return listSlotsStmt.all().map((s) => ({
    ...s,
    coaches: slotCoachesStmt.all(s.id).map((r) => ({ coachId: r.coach_id, displayName: r.display_name, shiftId: r.shift_id })),
  }));
}
export function getSlot(id) { return getSlotStmt.get(id); }

export function createSlot({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo = null }) {
  validateShiftFields({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo });
  const info = insertSlotStmt.run(dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo);
  return getSlotStmt.get(Number(info.lastInsertRowid));
}

/** 局部更新（不可改星期——要換星期＝結束或刪除後重建）；交易內連動旗下教練列。 */
export function updateSlot(id, { startTime, endTime, effectiveFrom, effectiveTo } = {}) {
  const cur = getSlotStmt.get(id);
  if (!cur) throw new ApiError(404, 'slot_not_found');
  const next = {
    dayOfWeek: cur.day_of_week,
    startTime: startTime !== undefined ? startTime : cur.start_time,
    endTime: endTime !== undefined ? endTime : cur.end_time,
    effectiveFrom: effectiveFrom !== undefined ? effectiveFrom : cur.effective_from,
    effectiveTo: effectiveTo !== undefined ? effectiveTo : cur.effective_to,
  };
  validateShiftFields(next);
  return tx(() => {
    updateSlotStmt.run(next.startTime, next.endTime, next.effectiveFrom, next.effectiveTo, id);
    updateSlotShiftsStmt.run(next.startTime, next.endTime, next.effectiveFrom, next.effectiveTo, id);
    return getSlotStmt.get(id);
  });
}

/** 刪除誤建時段；交易內顯式連動刪旗下教練列。 */
export function deleteSlot(id) {
  tx(() => {
    const info = deleteSlotStmt.run(id);
    if (info.changes === 0) throw new ApiError(404, 'slot_not_found');
    deleteSlotShiftsStmt.run(id);
  });
}

/** 指派教練：展開一列 coach_shifts（複製時段參數＋掛 slot_id）。 */
export function assignCoach(slotId, coachId) {
  const slot = getSlotStmt.get(slotId);
  if (!slot) throw new ApiError(404, 'slot_not_found');
  return tx(() => {
    if (slotShiftForCoachStmt.get(slotId, coachId)) throw new ApiError(409, 'coach_already_in_slot');
    const info = insertShiftForSlotStmt.run(coachId, slot.day_of_week, slot.start_time, slot.end_time,
      slot.effective_from, slot.effective_to, slotId);
    return getShiftStmt.get(Number(info.lastInsertRowid));
  });
}

/** 移除指派：刪展開列（歷史出席已快照且 shift_id ON DELETE SET NULL，帳不受影響）。 */
export function unassignCoach(slotId, coachId) {
  const row = slotShiftForCoachStmt.get(slotId, coachId);
  if (!row) throw new ApiError(404, 'coach_not_in_slot');
  deleteShiftStmt.run(row.id);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/gym-slots.test.js` → 全部 `✓`
Run: `node tests/shift-service.test.js && node tests/payroll-service.test.js` → 既有仍綠

- [ ] **Step 5: Commit**

```bash
git add src/services/shiftService.js tests/gym-slots.test.js
git commit -m "feat: shiftService 時段 CRUD 與指派展開（連動更新/顯式 CASCADE）"
```

---

### Task 3: Admin API — 六端點

**Files:**
- Modify: `src/server.js`（import 行擴充；`/api/admin/attendance/:id/void` 路由（約 1341–1344 行）之後插入）
- Test: `tests/slot-admin-api.test.js`（新檔）
- Modify: `package.json`（`test:api` 鏈尾端）

**Interfaces:**
- Consumes: Task 2 全部 service 函式；既有 `requireAdmin`、`asyncHandler`、`svcGetCoach`。
- Produces: 六端點（見下表），全部 `requireAdmin`。

| 端點 | 回應 |
|---|---|
| `GET /api/admin/slots` | `listSlots()` 陣列 |
| `POST /api/admin/slots` | 新 slot row |
| `PATCH /api/admin/slots/:id` | 更新後 slot row（`effective_to` 用 `in` 運算子區分「未提供」與「null 清空」） |
| `DELETE /api/admin/slots/:id` | `{ ok: true }` |
| `POST /api/admin/slots/:id/coaches` | 展開的 shift row（教練不存在 404 `coach_not_found`） |
| `DELETE /api/admin/slots/:id/coaches/:coachId` | `{ ok: true }` |

- [ ] **Step 1: 寫失敗測試**

建立 `tests/slot-admin-api.test.js`：

```js
// 時段＋指派 API：權限/CRUD/指派/錯誤碼。server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.3' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[slot-admin-api test] start');

db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%'));
  DELETE FROM gym_slots WHERE effective_from LIKE '2033-%';   -- 只掃本測試年份，勿全域掃孤兒時段（無教練時段是合法狀態）
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%');
  DELETE FROM users WHERE email LIKE 'sla-%';
`);
const cUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('SLA教練','sla-c@x.com','coach',?)").run(hashPassword('slapass123')).lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'SLA-C', 1)").run(cUid).lastInsertRowid);

const admin = (await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } })).data?.token;
const coach = (await req('POST', '/api/auth/login', { body: { email: 'sla-c@x.com', password: 'slapass123' } })).data?.token;
expect('登入成功', () => { assert.ok(admin); assert.ok(coach); });

{
  const r = await req('POST', '/api/admin/slots', { token: coach, body: { day_of_week: 2, start_time: '09:00', end_time: '11:00', effective_from: '2033-03-01' } });
  expect('非管理者 → 403', () => assert.equal(r.status, 403));
}
let slotId;
{
  const r = await req('POST', '/api/admin/slots', { token: admin, body: { day_of_week: 2, start_time: '09:00', end_time: '11:00', effective_from: '2033-03-01' } });
  expect('新增時段 → 200 完整列', () => { assert.equal(r.status, 200); assert.equal(r.data.day_of_week, 2); slotId = r.data.id; });
  const bad = await req('POST', '/api/admin/slots', { token: admin, body: { day_of_week: 2, start_time: '11:00', end_time: '09:00', effective_from: '2033-03-01' } });
  expect('起訖顛倒 → 400 invalid_time_range', () => assert.equal(bad.data.error, 'invalid_time_range'));
}
{
  const ghost = await req('POST', `/api/admin/slots/${slotId}/coaches`, { token: admin, body: { coach_id: 999999 } });
  expect('教練不存在 → 404 coach_not_found', () => assert.equal(ghost.data.error, 'coach_not_found'));
  const ok = await req('POST', `/api/admin/slots/${slotId}/coaches`, { token: admin, body: { coach_id: cId } });
  expect('指派 → 200 展開列（slot_id/參數複製）', () => {
    assert.equal(ok.status, 200); assert.equal(ok.data.slot_id, slotId);
    assert.equal(ok.data.coach_id, cId); assert.equal(ok.data.start_time, '09:00');
  });
  const dup = await req('POST', `/api/admin/slots/${slotId}/coaches`, { token: admin, body: { coach_id: cId } });
  expect('重複指派 → 409 coach_already_in_slot', () => assert.equal(dup.data.error, 'coach_already_in_slot'));
  const list = await req('GET', '/api/admin/slots', { token: admin });
  expect('列表內嵌教練', () => {
    const mine = list.data.find((s) => s.id === slotId);
    assert.deepEqual(mine.coaches.map((c) => c.coachId), [cId]);
  });
}
{
  const patch = await req('PATCH', `/api/admin/slots/${slotId}`, { token: admin, body: { start_time: '10:00', end_time: '12:00', effective_to: '2033-06-30' } });
  expect('PATCH 連動 → 200，教練列同步', () => {
    assert.equal(patch.data.start_time, '10:00'); assert.equal(patch.data.effective_to, '2033-06-30');
    const row = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ? AND coach_id = ?').get(slotId, cId);
    assert.equal(row.start_time, '10:00'); assert.equal(row.effective_to, '2033-06-30');
  });
  const clear = await req('PATCH', `/api/admin/slots/${slotId}`, { token: admin, body: { effective_to: null } });
  expect('effective_to null 清空', () => assert.equal(clear.data.effective_to, null));
}
{
  const un = await req('DELETE', `/api/admin/slots/${slotId}/coaches/${cId}`, { token: admin });
  expect('移除指派 → 200 ok', () => assert.deepEqual(un.data, { ok: true }));
  const un2 = await req('DELETE', `/api/admin/slots/${slotId}/coaches/${cId}`, { token: admin });
  expect('再移除 → 404 coach_not_in_slot', () => assert.equal(un2.data.error, 'coach_not_in_slot'));
  const del = await req('DELETE', `/api/admin/slots/${slotId}`, { token: admin });
  expect('刪除時段 → 200 ok', () => assert.deepEqual(del.data, { ok: true }));
  const del2 = await req('DELETE', `/api/admin/slots/${slotId}`, { token: admin });
  expect('再刪 → 404 slot_not_found', () => assert.equal(del2.data.error, 'slot_not_found'));
}
console.log('[slot-admin-api test] done');
```

- [ ] **Step 2: 起 server 跑測試確認失敗**

```bash
node src/db/seed-demo.js
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.pid"
sleep 1
node tests/slot-admin-api.test.js
```

Expected: 404 相關斷言失敗（路由不存在）。（`$CLAUDE_JOB_DIR` 未設時改用 `/tmp`。）

- [ ] **Step 3: 實作 `src/server.js`**

(a) shiftService import 行（約 98–100 行）追加：`listSlots, createSlot, updateSlot, deleteSlot, assignCoach, unassignCoach`。

(b) `/api/admin/attendance/:id/void` 路由之後插入：

```js
// --- Admin: 固定上班時段（gym_slots）＋指派教練 ---
app.get('/api/admin/slots', requireAdmin, asyncHandler((req, res) => {
  res.json(listSlots());
}));

app.post('/api/admin/slots', requireAdmin, asyncHandler((req, res) => {
  const b = req.body || {};
  res.json(createSlot({ dayOfWeek: Number(b.day_of_week), startTime: b.start_time, endTime: b.end_time,
    effectiveFrom: b.effective_from, effectiveTo: b.effective_to ?? null }));
}));

app.patch('/api/admin/slots/:id', requireAdmin, asyncHandler((req, res) => {
  const b = req.body || {};
  res.json(updateSlot(Number(req.params.id), {
    startTime: b.start_time, endTime: b.end_time, effectiveFrom: b.effective_from,
    effectiveTo: 'effective_to' in b ? b.effective_to : undefined,
  }));
}));

app.delete('/api/admin/slots/:id', requireAdmin, asyncHandler((req, res) => {
  deleteSlot(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/admin/slots/:id/coaches', requireAdmin, asyncHandler((req, res) => {
  const coach = svcGetCoach(Number(req.body?.coach_id));
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  res.json(assignCoach(Number(req.params.id), coach.id));
}));

app.delete('/api/admin/slots/:id/coaches/:coachId', requireAdmin, asyncHandler((req, res) => {
  unassignCoach(Number(req.params.id), Number(req.params.coachId));
  res.json({ ok: true });
}));
```

- [ ] **Step 4: 重啟 server、跑測試確認通過**

```bash
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.pid")
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.pid"
sleep 1
node tests/slot-admin-api.test.js && node tests/shift-admin-api.test.js
```

Expected: 兩檔全 `✓`（既有 shifts API 不受影響）

- [ ] **Step 5: 掛進 test:api 鏈＋Commit**

`"test:api"` 尾端（`node tests/shift-admin-api.test.js` 之後）追加 ` && node tests/slot-admin-api.test.js`。

```bash
git add src/server.js tests/slot-admin-api.test.js package.json
git commit -m "feat: 時段＋指派 admin API（六端點）"
```

---

### Task 4: 後台 UI — 時段卡片＋教練 chips＋精簡時薪

**Files:**
- Modify: `public/admin.html`（772–773 行：「教練時薪與班表」標題＋`#sh-coaches` 容器替換）
- Modify: `public/admin.js`（1926 行起的駐場區塊：`loadShiftAdmin`／`renderShCoaches`／`#sh-coaches` 事件整段改寫）

**Interfaces:**
- Consumes: Task 3 六端點；既有 `api()`／`toast()`／`escapeHtml()`／`loadPayroll()`／`SH_WEEK`／`shToday()`；既有 `PATCH /api/admin/coaches/:id/hourly-rate`；補登表單沿用 `shShifts`（`GET /api/admin/shifts`）。
- Produces: 老闆可「建時段 → 加教練 → 教練打卡」的完整 UI。

- [ ] **Step 1: `public/admin.html` — 替換區塊**

把（772–773 行）：

```html
      <h4 class="font-bold text-sm mb-2 mt-5">教練時薪與班表</h4>
      <div id="sh-coaches"></div>
```

替換為：

```html
      <h4 class="font-bold text-sm mb-2 mt-5">上班時段</h4>
      <div class="subtle text-sm">先建立固定時段，再把教練加進去；教練掃 QR 即可打該時段的卡。</div>
      <div id="sh-slots" class="mt-2"></div>
      <div class="flex flex-wrap gap-2 mt-2 items-end text-sm">
        <select id="sh-slot-new-dow" class="form-input"></select>
        <input type="time" id="sh-slot-new-start" class="form-input">
        <input type="time" id="sh-slot-new-end" class="form-input">
        <input type="date" id="sh-slot-new-from" class="form-input" title="生效日">
        <button type="button" id="sh-slot-add" class="btn btn-primary btn-sm">新增時段</button>
      </div>

      <h4 class="font-bold text-sm mb-2 mt-5">教練時薪</h4>
      <div id="sh-rates"></div>
```

- [ ] **Step 2: `public/admin.js` — 改寫駐場區塊**

(a) 狀態行 `let shShifts = [];` 之後加 `let shSlots = [];`。

(b) `loadShiftAdmin()` 整段替換為（多抓 slots；改呼叫新 render）：

```js
async function loadShiftAdmin() {
  try {
    const [settings, coaches, slots, shifts] = await Promise.all([
      api('/api/admin/settings'), api('/api/admin/coaches'), api('/api/admin/slots'), api('/api/admin/shifts'),
    ]);
    document.getElementById('sh-lat').value = settings.checkin_lat;
    document.getElementById('sh-lng').value = settings.checkin_lng;
    document.getElementById('sh-radius').value = settings.checkin_radius_m;
    document.getElementById('sh-window').value = settings.checkin_window_before_min;
    shCoaches = coaches; shSlots = slots; shShifts = shifts;
    renderShSlots();
    renderShRates();
    renderShManualCoachOptions();
    renderShManualShiftOptions();
  } catch (e) { toast('駐場資料載入失敗：' + e.message, 'error'); }
}
```

(c) `renderShCoaches()` 函式與 `#sh-coaches` 的事件監聽器**整段刪除**，換成：

```js
function renderShSlots() {
  const box = document.getElementById('sh-slots');
  box.innerHTML = shSlots.map((s) => {
    const chips = s.coaches.map((c) => `
      <span class="sh-chip" data-coach="${c.coachId}"
        style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid #e2e8f0;border-radius:999px;background:#f8fafc;">
        ${escapeHtml(c.displayName)}<button type="button" class="sh-chip-x" style="border:none;background:none;cursor:pointer;color:#94a3b8;">✕</button>
      </span>`).join(' ');
    const addable = shCoaches.filter((c) => c.is_active && !s.coaches.some((x) => x.coachId === c.id));
    return `
    <div class="sh-slot card mb-3" data-sid="${s.id}">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <span class="font-medium">${SH_WEEK[s.day_of_week]} ${s.start_time}–${s.end_time}</span>
        <span class="text-sm subtle">自 ${s.effective_from}${s.effective_to ? '，至 ' + s.effective_to : ''}</span>
      </div>
      <div class="flex flex-wrap gap-2 mt-2 items-center text-sm">${chips || '<span class="subtle">尚未指派教練</span>'}</div>
      <div class="flex flex-wrap gap-2 mt-2 items-end text-sm">
        <select class="form-input sh-slot-coach">
          <option value="">加入教練…</option>
          ${addable.map((c) => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-ghost btn-sm sh-slot-assign">加入</button>
        <label class="text-sm">結束日
          <input type="date" class="form-input sh-slot-to" value="${s.effective_to || ''}" title="結束日（含當日；留空＝持續有效）"></label>
        <button type="button" class="btn btn-ghost btn-sm sh-slot-save">儲存</button>
        <button type="button" class="btn btn-ghost btn-sm sh-slot-del">刪除</button>
      </div>
    </div>`;
  }).join('') || '<div class="subtle text-sm">尚未建立時段</div>';
}

function renderShRates() {
  const box = document.getElementById('sh-rates');
  box.innerHTML = shCoaches.filter((c) => c.is_active).map((c) => `
    <div class="flex items-center gap-2 text-sm mb-1 sh-rate-row" data-cid="${c.id}">
      <span class="font-medium" style="min-width:96px;">${escapeHtml(c.display_name)}</span>
      時薪 <input type="number" min="0" class="form-input sh-rate" style="width:90px" value="${c.hourly_rate ?? ''}" placeholder="未設">
      <button type="button" class="btn btn-ghost btn-sm sh-rate-save">儲存</button>
    </div>`).join('') || '<div class="subtle text-sm">尚無啟用教練</div>';
}

document.getElementById('sh-slots').addEventListener('click', async (e) => {
  const card = e.target.closest('.sh-slot');
  if (!card) return;
  const sid = Number(card.dataset.sid);
  try {
    if (e.target.classList.contains('sh-slot-assign')) {
      const coachId = card.querySelector('.sh-slot-coach').value;
      if (!coachId) { toast('請先選擇教練', 'error'); return; }
      await api(`/api/admin/slots/${sid}/coaches`, { method: 'POST', body: { coach_id: Number(coachId) } });
      toast('已加入教練', 'success'); loadShiftAdmin();
    } else if (e.target.classList.contains('sh-chip-x')) {
      const chip = e.target.closest('.sh-chip');
      if (e.target.dataset.arm !== '1') {
        e.target.dataset.arm = '1'; e.target.textContent = '確認?';
        setTimeout(() => { e.target.dataset.arm = ''; e.target.textContent = '✕'; }, 3000);
        return;
      }
      await api(`/api/admin/slots/${sid}/coaches/${chip.dataset.coach}`, { method: 'DELETE' });
      toast('已移除教練（歷史出席不受影響）', 'success'); loadShiftAdmin();
    } else if (e.target.classList.contains('sh-slot-save')) {
      await api(`/api/admin/slots/${sid}`, { method: 'PATCH', body: { effective_to: card.querySelector('.sh-slot-to').value || null } });
      toast('時段已更新', 'success'); loadShiftAdmin();
    } else if (e.target.classList.contains('sh-slot-del')) {
      if (e.target.dataset.arm !== '1') {
        e.target.dataset.arm = '1'; e.target.textContent = '確認刪除？';
        setTimeout(() => { e.target.dataset.arm = ''; e.target.textContent = '刪除'; }, 3000);
        return;
      }
      await api(`/api/admin/slots/${sid}`, { method: 'DELETE' });
      toast('時段已刪除（誤建用；正常結束請填結束日）', 'success'); loadShiftAdmin();
    }
  } catch (err) {
    const msgs = { coach_already_in_slot: '該教練已在此時段', invalid_time_range: '起訖時間無效', invalid_effective_range: '生效日期無效' };
    toast(msgs[err.data?.error] || '操作失敗：' + (err.data?.error || err.message), 'error');
  }
});

document.getElementById('sh-rates').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('sh-rate-save')) return;
  const row = e.target.closest('.sh-rate-row');
  try {
    const raw = row.querySelector('.sh-rate').value.trim();
    await api(`/api/admin/coaches/${row.dataset.cid}/hourly-rate`, { method: 'PATCH', body: { hourly_rate: raw === '' ? null : Number(raw) } });
    toast('時薪已更新', 'success'); loadShiftAdmin(); loadPayroll();
  } catch (err) { toast('操作失敗：' + (err.data?.error || err.message), 'error'); }
});

document.getElementById('sh-slot-add').addEventListener('click', async () => {
  try {
    await api('/api/admin/slots', { method: 'POST', body: {
      day_of_week: Number(document.getElementById('sh-slot-new-dow').value),
      start_time: document.getElementById('sh-slot-new-start').value,
      end_time: document.getElementById('sh-slot-new-end').value,
      effective_from: document.getElementById('sh-slot-new-from').value,
    } });
    toast('時段已建立', 'success'); loadShiftAdmin();
  } catch (err) {
    const msgs = { invalid_time_range: '起訖時間無效', invalid_effective_range: '生效日期無效', invalid_day_of_week: '星期無效' };
    toast(msgs[err.data?.error] || '建立失敗：' + (err.data?.error || err.message), 'error');
  }
});

// 新增時段表單初始化（星期選項＋生效日預設今天）
document.getElementById('sh-slot-new-dow').innerHTML = SH_WEEK.map((w, i) => `<option value="${i}">${w}</option>`).join('');
document.getElementById('sh-slot-new-from').value = shToday();
```

（`renderShManualCoachOptions`／`renderShManualShiftOptions`／補登與打卡參數、QR、定位三入口——全部不動。）

- [ ] **Step 3: 驗證**

1. `node --check public/admin.js` → 通過。
2. 靜態交叉檢查：JS 內每個 `getElementById` 新目標（`sh-slots`、`sh-rates`、`sh-slot-new-*`、`sh-slot-add`）在 admin.html 都有對應 id；舊 `sh-coaches` 于兩檔皆已無殘留（`grep -n "sh-coaches" public/admin.html public/admin.js` → 空）。
3. 起 server（同 Task 3 指令）→ 瀏覽器登入後台 → 駐場出勤展開：建「週三 09:00–11:00」時段 → 加入王教練 → chip 出現；`/checkin` 用王教練登入（今天若非週三，改建今天星期的時段）→ 打卡成功 → 薪資表出現時數；chip ✕ 兩段式移除 → 重整後消失、薪資明細仍在；結束日／刪除、時薪儲存各操作一輪。
4. 完整視覺 smoke 留給人工 gate。

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台駐場改時段卡片＋指派教練＋精簡時薪 UI"
```

---

### Task 5: 全套驗證與出貨

**Files:** 無新程式；驗證與 ops。

**Interfaces:** Consumes 全部 Task。Produces: 綠色雙測試鏈、push 分支、draft PR。

- [ ] **Step 1: 全套 service 測試**

```bash
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.pid") 2>/dev/null
npm test
```

Expected: 全綠（含既有 55+ 檔——證明打卡/薪資核心未動）。

- [ ] **Step 2: 重 seed、起 server、全套 API 測試**

```bash
node src/db/seed-demo.js
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id node --env-file-if-exists=.env src/server.js > "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.log" 2>&1 &
echo $! > "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.pid"
sleep 1
npm run test:api
kill $(cat "$CLAUDE_JOB_DIR/tmp/chinup-slots-server.pid")
```

Expected: 全綠。

- [ ] **Step 3: Push＋draft PR**

```bash
git push -u origin feature/gym-slots-assignment
TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p')
curl -s -X POST https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"title":"駐場班表改固定時段＋指派教練（打卡核心零改動）","head":"feature/gym-slots-assignment","base":"main","draft":true,"body":"Spec: docs/superpowers/specs/2026-07-09-gym-slots-assignment-design.md\nPlan: docs/superpowers/plans/2026-07-09-gym-slots-assignment.md\n\n- gym_slots 時段實體＋coach_shifts.slot_id；指派＝交易內展開教練列\n- 時段修改連動旗下教練列；顯式 CASCADE；既有資料開機冪等歸組\n- 後台改時段卡片＋教練 chips＋精簡時薪列；補登/打卡參數/QR 不動\n- /checkin、出席、薪資核心零改動（既有測試全綠佐證）\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

（守慣例：之後任何 review 修正 commit 都先 `git push` 再 merge。）

- [ ] **Step 4: 交付說明**

merge 後開機 migration 自動把既有教練班表歸組成時段；老闆直接在「上班時段」卡片管理，無需人工搬遷。

---

## Self-Review（計畫對 spec 覆蓋）

- 資料模型（gym_slots／slot_id 雙軌／歸組 migration）→ Task 1。
- 語意表六項（建立/指派/移除/修改連動/結束/刪除連動）→ Task 2（service＋tests 全覆蓋，含出席鏈安全與快照驗證）。
- 六端點＋錯誤碼＋不許改星期 → Task 3（updateSlot 無 dayOfWeek 參數＝結構性保證）。
- UI 兩塊（上班時段卡片＋教練時薪）＋補登不動 → Task 4。
- 既有 `/api/admin/shifts` 保留 → 未觸碰（Task 3 Step 4 一併重跑其測試）。
- 核心零改動 → Task 5 全套綠燈佐證。
- 刻意不做（容量上限/重疊檢查/shifts 端點退場）→ 無任何 Task 涉及 ✓。
