# 期課雙月期別自動續開 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 進入每期（固定日曆雙月）最後一週時，自動把 `auto_renew=1` 的已發布範本延長到下期月底並補齊場次；公開頁只列本週週一起的場次。

**Architecture:** 純函式 `period.js`（期別／開放日／週一運算）→ `periodService.js` 的 `rolloverTemplates(today)` 延長範本＋`INSERT OR IGNORE` 補場次＋通知管理者，由每日 cron＋開機各跑一次（冪等）。`course_templates.auto_renew` 新欄＋一次性回填。`getPublicGroupCourses` 加一個 `session_date >= 本週週一` 過濾。

**Tech Stack:** Node ESM、node:sqlite、node-cron、plain-node assert 測試（`expect(label, fn)` 模式）。

**Spec:** `docs/superpowers/specs/2026-08-25-group-period-rollover-design.md`

## Global Constraints

- 單元測試**絕不**對 `data/app.db` 跑：一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴。
- 期別＝固定日曆雙月（1–2、3–4、5–6、7–8、9–10、11–12）。開放下期日期規則：`錨點 = 期末最後一天 − 7 天；錨點非週一則往前推到該週週一`。驗算值：2026-08→`2026-08-24`、2026-10→`2026-10-19`、2026-12→`2026-12-21`、2027-02→`2027-02-15`、2027-04→`2027-04-19`、2027-06→`2027-06-21`。
- 日期一律 `YYYY-MM-DD` 字串、UTC 運算（與 `src/services/schedule.js` 同法）；「今天」＝`nowLocal().slice(0, 10)`（容器 `TZ=Asia/Taipei`）。
- `rolloverTemplates` 選取條件精確為：`status = 'published' AND auto_renew = 1 AND cycle_end_date < targetEnd`；只改 `cycle_end_date`，`cycle_start_date` 不動；場次用 `INSERT OR IGNORE`（`UNIQUE(template_id, session_date)`）。
- 通知模板 `period_rollover_admin`：subject `'{{period_label}} 期課已開放報名'`、body `'📅 {{period_label}} 期課已自動開放報名：{{summary}}。'`；`period_label` 形如 `'9–10 月'`（en dash `–`）；`summary` 形如 `'綜合體能(週三) 9 場、基礎重量訓練(週二) 9 場'`（`、` 串接，added=0 也列）。
- `getPublicGroupCourses` 只加 `AND session_date >= ?`（本週週一）；其餘 selectable／state／暫停隱藏／範本門檻一行不動；`public/group.js` 零改動。
- 後台勾選框文字：`自動續期（每期最後一週自動開放下期場次）`；通知型別標籤 `period_rollover_admin: '期課續期'`。
- commit 訊息：繁中一行主旨，結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 期別純函式 `period.js`

**Files:**
- Create: `src/services/period.js`
- Test: `tests/period-service.test.js`（新檔）
- Modify: `package.json`（`"test"` 鏈尾端追加 `&& node tests/period-service.test.js`）

**Interfaces:**
- Consumes: 無。
- Produces（後續 Task 3／4 依賴，簽名固定）：
  - `periodOf(ymd: 'YYYY-MM-DD') → { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }`
  - `nextPeriod(period) → { start, end }`
  - `weekStartMonday(ymd) → 'YYYY-MM-DD'`
  - `periodOpenDate(period) → 'YYYY-MM-DD'`
  - `targetEndFor(today) → 'YYYY-MM-DD'`
  - `periodLabel(period) → '9–10 月'`

- [ ] **Step 1: 寫測試（RED）**

`tests/period-service.test.js`：

```js
// 期別純函式：固定日曆雙月、開放下期日期規則、本週週一。不碰 DB。
import assert from 'node:assert/strict';
import { periodOf, nextPeriod, weekStartMonday, periodOpenDate, targetEndFor, periodLabel } from '../src/services/period.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
console.log('[period-service test] start');

expect('periodOf 2026-08-25 → 7/1~8/31', () => assert.deepEqual(periodOf('2026-08-25'), { start: '2026-07-01', end: '2026-08-31' }));
expect('periodOf 2026-09-01 → 9/1~10/31', () => assert.deepEqual(periodOf('2026-09-01'), { start: '2026-09-01', end: '2026-10-31' }));
expect('periodOf 2027-01-15 → 1/1~2/28', () => assert.deepEqual(periodOf('2027-01-15'), { start: '2027-01-01', end: '2027-02-28' }));
expect('periodOf 閏年 2028-02-10 → end 2/29', () => assert.equal(periodOf('2028-02-10').end, '2028-02-29'));
expect('periodOf 12/31 → 11/1~12/31', () => assert.deepEqual(periodOf('2026-12-31'), { start: '2026-11-01', end: '2026-12-31' }));

expect('nextPeriod 7–8 → 9–10', () => assert.deepEqual(nextPeriod({ start: '2026-07-01', end: '2026-08-31' }), { start: '2026-09-01', end: '2026-10-31' }));
expect('nextPeriod 11–12 → 隔年 1–2', () => assert.deepEqual(nextPeriod({ start: '2026-11-01', end: '2026-12-31' }), { start: '2027-01-01', end: '2027-02-28' }));

expect('weekStartMonday 週二 2026-08-25 → 08-24', () => assert.equal(weekStartMonday('2026-08-25'), '2026-08-24'));
expect('weekStartMonday 週一 → 自身', () => assert.equal(weekStartMonday('2026-08-24'), '2026-08-24'));
expect('weekStartMonday 週日 2026-08-30 → 08-24', () => assert.equal(weekStartMonday('2026-08-30'), '2026-08-24'));

const open = (ymd) => periodOpenDate(periodOf(ymd));
expect('periodOpenDate 2026-08 → 08-24（錨點 8/24 即週一）', () => assert.equal(open('2026-08-01'), '2026-08-24'));
expect('periodOpenDate 2026-10 → 10-19（錨點 10/24 週六往前）', () => assert.equal(open('2026-10-01'), '2026-10-19'));
expect('periodOpenDate 2026-12 → 12-21（錨點 12/24 週四往前）', () => assert.equal(open('2026-12-01'), '2026-12-21'));
expect('periodOpenDate 2027-02 → 02-15（錨點 2/21 週日往前）', () => assert.equal(open('2027-02-01'), '2027-02-15'));
expect('periodOpenDate 2027-04 → 04-19', () => assert.equal(open('2027-04-01'), '2027-04-19'));
expect('periodOpenDate 2027-06 → 06-21', () => assert.equal(open('2027-06-01'), '2027-06-21'));

expect('targetEndFor 8/23 → 本期末 8/31', () => assert.equal(targetEndFor('2026-08-23'), '2026-08-31'));
expect('targetEndFor 8/24 → 下期末 10/31', () => assert.equal(targetEndFor('2026-08-24'), '2026-10-31'));
expect('targetEndFor 8/31 → 10/31', () => assert.equal(targetEndFor('2026-08-31'), '2026-10-31'));
expect('targetEndFor 9/1（期中）→ 10/31', () => assert.equal(targetEndFor('2026-09-01'), '2026-10-31'));
expect('targetEndFor 12/21 → 隔年 2/28', () => assert.equal(targetEndFor('2026-12-21'), '2027-02-28'));

expect('periodLabel 9–10 月', () => assert.equal(periodLabel({ start: '2026-09-01', end: '2026-10-31' }), '9–10 月'));
expect('periodLabel 11–12 月', () => assert.equal(periodLabel({ start: '2026-11-01', end: '2026-12-31' }), '11–12 月'));

console.log('[period-service test] done');
```

- [ ] **Step 2: 跑測試確認 RED**

Run: `cd /Users/ryansheu/projects/chinup-fitness-system && node tests/period-service.test.js`
Expected: 匯入失敗（`Cannot find module '../src/services/period.js'`），exit ≠ 0。

- [ ] **Step 3: 實作 `src/services/period.js`**

```js
// 期課雙月期別：純日期運算，不碰 DB。
// 日期一律 YYYY-MM-DD 字串、以 UTC 計算（與 schedule.js 同法，避免 DST／時區偏移）。
// 期別固定為日曆雙月：1–2、3–4、5–6、7–8、9–10、11–12 月。

function parse(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

/** 該日所屬期別 { start: 奇數月 1 日, end: 偶數月最後一天 }。 */
export function periodOf(ymd) {
  const d = parse(ymd);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();            // 0-based
  const startM0 = m0 - (m0 % 2);         // 偶數索引＝奇數月（0=1月、2=3月…）
  return {
    start: fmt(new Date(Date.UTC(y, startM0, 1))),
    end: fmt(new Date(Date.UTC(y, startM0 + 2, 0))),   // 下下月第 0 天＝偶數月最後一天
  };
}

/** 下一個期別。 */
export function nextPeriod(period) {
  return periodOf(fmt(addDays(parse(period.end), 1)));
}

/** 該日所在週（週一～週日）的週一。 */
export function weekStartMonday(ymd) {
  const d = parse(ymd);
  const back = (d.getUTCDay() + 6) % 7;  // 週一=0 … 週日=6
  return fmt(addDays(d, -back));
}

/** 該期「開放下期報名」的日期：錨點＝期末 − 7 天；錨點非週一則往前推到該週週一。 */
export function periodOpenDate(period) {
  return weekStartMonday(fmt(addDays(parse(period.end), -7)));
}

/** 今天應保證範本開到哪一天：已進最後一週 → 下期末，否則本期末。 */
export function targetEndFor(today) {
  const p = periodOf(today);
  return today >= periodOpenDate(p) ? nextPeriod(p).end : p.end;
}

/** 期別顯示：'9–10 月'（en dash）。期別永不跨年，不帶年份。 */
export function periodLabel(period) {
  const sm = parse(period.start).getUTCMonth() + 1;
  const em = parse(period.end).getUTCMonth() + 1;
  return `${sm}–${em} 月`;
}
```

- [ ] **Step 4: 跑測試確認 GREEN**

Run: `node tests/period-service.test.js`
Expected: 全部 ✓、exit 0。

- [ ] **Step 5: 加入測試鏈**

`package.json` `"test"` 字串最尾端（`node tests/quote-service.test.js` 之後）追加 ` && node tests/period-service.test.js`。

Run: `grep -c 'node tests/period-service.test.js"' package.json`
Expected: `1`（鏈尾端緊接結尾引號）。

- [ ] **Step 6: Commit**

```bash
git add src/services/period.js tests/period-service.test.js package.json
git commit -m "期課期別純函式：雙月期別、開放下期日期、本週週一

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `auto_renew` 欄位、一次性回填、範本服務讀寫

**Files:**
- Modify: `src/db/schema.js:59`（`course_templates` CREATE TABLE，`coach_id` 行之後加欄）
- Modify: `src/db/connection.js`（`addColumnIfMissing('coach_shifts', 'slot_id', …)` 那行之後、`/** 歸組 backfill` 註解之前，加遷移區塊）
- Modify: `src/services/courseService.js:7-15`（insertTemplate）、`:23-33`（updateTemplate）、`:47-64`（normalize）
- Test: `tests/migration.test.js`（`tplCols` 段加兩斷言）、`tests/course-coach.test.js`（檔尾加三斷言）

**Interfaces:**
- Consumes: `nowLocal()`（`src/db/connection.js:302`，function declaration 提升，可在遷移區塊使用）。
- Produces: `course_templates.auto_renew INTEGER NOT NULL DEFAULT 1`；`createTemplate`／`editTemplate` payload 接受 `auto_renew`（缺值→1、truthy→1、否則 0）；`app_settings.auto_renew_backfill_done`。

- [ ] **Step 1: 寫測試（RED）**

(a) `tests/migration.test.js`：在 `expect('course_templates has price_per_session', …)` 之後加：

```js
expect('course_templates has auto_renew', () => assert(tplCols.includes('auto_renew')));
expect('auto_renew 回填：結束日 ≥ 今天的舊範本 = 1、旗標已寫', () => {
  assert.equal(db.prepare("SELECT auto_renew FROM course_templates WHERE name='Old Class'").get().auto_renew, 1);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='auto_renew_backfill_done'").get()?.value, '1');
});
```

（該檔舊 DB 已插入 `Old Class` 結束日 `2026-12-31`，升級當下 ≥ 今天 → 應為 1。）

(b) `tests/course-coach.test.js`：在最後一行 `console.log('[course-coach test] done')` 之前加：

```js
// ── auto_renew 讀寫 ────────────────────────────────────────────
const arDefault = createTemplate({
  name: 'CoachTest 續期預設', min_capacity: 1, max_capacity: 6, day_of_week: 2, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(30), price_per_session: 0,
});
expect('createTemplate 缺 auto_renew → 1', () => assert.equal(getTemplate(arDefault.templateId).auto_renew, 1));
const arOff = createTemplate({
  name: 'CoachTest 續期關', min_capacity: 1, max_capacity: 6, day_of_week: 2, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(30), price_per_session: 0, auto_renew: 0,
});
expect('createTemplate auto_renew=0 → 0', () => assert.equal(getTemplate(arOff.templateId).auto_renew, 0));
editTemplate(arOff.templateId, { ...getTemplate(arOff.templateId), auto_renew: 1 });
expect('editTemplate 可翻回 1', () => assert.equal(getTemplate(arOff.templateId).auto_renew, 1));
```

（`getTemplate` 回傳含 `sessions` 等額外欄位，`editTemplate` 的 `normalize` 只挑已知欄位，直接展開傳入無妨；`price_per_session: 0` 為必要——`normalize` 對 undefined 給 0，但顯式給更清楚。）

- [ ] **Step 2: 跑測試確認 RED**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/migration.test.js; DB_PATH="$(mktemp -d)/t.db" node tests/course-coach.test.js`
Expected: migration 兩新斷言 ✗（無欄位）；course-coach 三新斷言 ✗（`auto_renew` undefined）。

- [ ] **Step 3: schema 加欄**

`src/db/schema.js` `course_templates` 表，`coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,` 之後插入一行：

```sql
  auto_renew INTEGER NOT NULL DEFAULT 1,
```

- [ ] **Step 4: connection.js 遷移＋一次性回填**

在 `addColumnIfMissing('coach_shifts', 'slot_id', 'INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE');` 之後、`/** 歸組 backfill` 註解之前插入：

```js
// ── 2026-08-25 期課雙月期別自動續開 ──
// course_templates.auto_renew：1=每期最後一週自動延長到下期末並補場次（預設）；0=不續（本期剩餘場次照常）。
// 一次性回填（app_settings 旗標守門，只做一次、不覆蓋業主之後的手動設定）：
// 升級當下仍在效期內（結束日 ≥ 今天）的範本視為續開中 → 1；早已結束的舊範本 → 0，避免下次換期被翻出來。
addColumnIfMissing('course_templates', 'auto_renew', 'INTEGER NOT NULL DEFAULT 1');
{
  const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'auto_renew_backfill_done'").get();
  if (flag?.value !== '1') {
    const { changes } = db.prepare(
      'UPDATE course_templates SET auto_renew = CASE WHEN cycle_end_date >= ? THEN 1 ELSE 0 END'
    ).run(nowLocal().slice(0, 10));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('auto_renew_backfill_done', '1')").run();
    if (changes) console.log(`[migrate] course_templates.auto_renew backfilled for ${changes} templates`);
  }
}
```

（`app_settings` 由 `db.exec(SCHEMA)` 在檔案開頭建立，此處必存在；`nowLocal` 為同檔 function declaration，可提前使用。）

- [ ] **Step 5: courseService 讀寫欄位**

`src/services/courseService.js`：

(a) `insertTemplate` 欄位列與 VALUES 各加 `auto_renew`：

```js
const insertTemplate = db.prepare(`
  INSERT INTO course_templates
    (name, description, min_capacity, max_capacity, day_of_week, start_time,
     duration_minutes, recurrence, cycle_start_date, cycle_end_date,
     registration_deadline_hours, status, price_per_session, coach_id, auto_renew)
  VALUES (@name, @description, @min_capacity, @max_capacity, @day_of_week, @start_time,
          @duration_minutes, @recurrence, @cycle_start_date, @cycle_end_date,
          @registration_deadline_hours, @status, @price_per_session, @coach_id, @auto_renew)
`);
```

(b) `updateTemplate` 的 SET 列 `price_per_session=@price_per_session, coach_id=@coach_id` 改為 `price_per_session=@price_per_session, coach_id=@coach_id, auto_renew=@auto_renew`。

(c) `normalize` 回傳物件在 `coach_id: …` 之後加：

```js
    // 自動續期：缺值視為開（與欄位預設一致）；後台勾選框送 1/0。
    auto_renew: (t.auto_renew === undefined || t.auto_renew === null) ? 1 : (Number(t.auto_renew) ? 1 : 0),
```

- [ ] **Step 6: 跑測試確認 GREEN**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/migration.test.js && DB_PATH="$(mktemp -d)/t.db" node tests/course-coach.test.js`
Expected: 全部 ✓、exit 0。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.js src/db/connection.js src/services/courseService.js tests/migration.test.js tests/course-coach.test.js
git commit -m "course_templates.auto_renew 欄位＋一次性回填＋範本服務讀寫

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `rolloverTemplates` 自動續期工作、通知模板、排程掛載

**Files:**
- Create: `src/services/periodService.js`
- Modify: `src/services/notifications.js`（TEMPLATES 物件，`course_cancelled` 區塊之後加模板）
- Modify: `src/scheduler.js`（import＋開機呼叫＋每日 cron）
- Modify: `public/admin.js:278-284`（`typeLabel` 加標籤）
- Test: `tests/period-rollover.test.js`（新檔）、`package.json` 測試鏈追加

**Interfaces:**
- Consumes: Task 1 `period.js` 的 `periodOf`、`periodLabel`、`targetEndFor`；Task 2 的 `auto_renew` 欄；既有 `expandTemplate`（`src/services/schedule.js`）、`notifyAdmins({ type, vars })`（`src/services/notifications.js:310`）、`db`／`tx`／`nowLocal`（`src/db/connection.js`）。
- Produces: `rolloverTemplates(today?: 'YYYY-MM-DD') → { targetEnd: string, extended: Array<{ id: number, name: string, added: number }> }`。

- [ ] **Step 1: 寫測試（RED）**

`tests/period-rollover.test.js`：

```js
// 自動續期工作：窗口判定、只續 published+auto_renew、冪等、管理者通知一則。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { rolloverTemplates } from '../src/services/periodService.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
console.log('[period-rollover test] start');

db.exec(`
  DELETE FROM registrations;
  DELETE FROM group_orders;
  DELETE FROM course_sessions;
  DELETE FROM course_templates;
  DELETE FROM notifications WHERE type = 'period_rollover_admin';
  DELETE FROM users WHERE email LIKE 'pr-%';
`);
const adminUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('PR管理','pr-a@x.com','coach',1)").run().lastInsertRowid);
const adminNotifs = () => db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='period_rollover_admin'").get(adminUid).c;
const count = (id) => db.prepare('SELECT COUNT(*) c FROM course_sessions WHERE template_id=?').get(id).c;
const endOf = (id) => db.prepare('SELECT cycle_end_date e FROM course_templates WHERE id=?').get(id).e;

// 週三課、7–8 月期：7/1,8,15,22,29,8/5,12,19,26 = 9 場
const base = {
  min_capacity: 1, max_capacity: 6, day_of_week: 3, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: '2026-07-01', cycle_end_date: '2026-08-31', registration_deadline_hours: 24, price_per_session: 400,
};
const A = createTemplate({ ...base, name: 'PR續期A(週三)' });
const B = createTemplate({ ...base, name: 'PR不續B', auto_renew: 0 });
const C = createTemplate({ ...base, name: 'PR草稿C', status: 'draft' });
const D = createTemplate({ ...base, name: 'PR已延D', cycle_end_date: '2026-12-31' });
const aBefore = count(A.templateId);
const dBefore = count(D.templateId);
expect('前置：A 原有 9 場', () => assert.equal(aBefore, 9));

// 8/23：尚未進最後一週（8/24 起）
const r0 = rolloverTemplates('2026-08-23');
expect('8/23 → targetEnd=本期末 8/31、無延長', () => { assert.equal(r0.targetEnd, '2026-08-31'); assert.deepEqual(r0.extended, []); });
expect('8/23 → A 結束日不變', () => assert.equal(endOf(A.templateId), '2026-08-31'));

// 8/24：進最後一週
const n0 = adminNotifs();
const r1 = rolloverTemplates('2026-08-24');
expect('8/24 → targetEnd=下期末 10/31', () => assert.equal(r1.targetEnd, '2026-10-31'));
expect('只延 A', () => assert.deepEqual(r1.extended.map((e) => e.id), [A.templateId]));
expect('A 結束日延到 10/31、起始日不動', () => {
  const t = db.prepare('SELECT cycle_start_date s, cycle_end_date e FROM course_templates WHERE id=?').get(A.templateId);
  assert.equal(t.e, '2026-10-31'); assert.equal(t.s, '2026-07-01');
});
// 9–10 月週三：9/2,9,16,23,30,10/7,14,21,28 = 9 場
expect('A 新增 9 場（added 與實際列數一致）', () => { assert.equal(r1.extended[0].added, 9); assert.equal(count(A.templateId), aBefore + 9); });
expect('新場次 status=open、最後一場 10/28', () => {
  const last = db.prepare('SELECT session_date, status FROM course_sessions WHERE template_id=? ORDER BY start_at DESC LIMIT 1').get(A.templateId);
  assert.equal(last.session_date, '2026-10-28'); assert.equal(last.status, 'open');
});
expect('B（auto_renew=0）不動', () => { assert.equal(endOf(B.templateId), '2026-08-31'); assert.equal(count(B.templateId), 9); });
expect('C（draft）不動', () => { assert.equal(endOf(C.templateId), '2026-08-31'); assert.equal(count(C.templateId), 9); });
expect('D（已到 12/31）不動', () => { assert.equal(endOf(D.templateId), '2026-12-31'); assert.equal(count(D.templateId), dBefore); });
expect('管理者通知恰 1 則', () => assert.equal(adminNotifs() - n0, 1));
expect('通知內容含期別與摘要', () => {
  const row = db.prepare("SELECT subject, body FROM notifications WHERE user_id=? AND type='period_rollover_admin' ORDER BY id DESC LIMIT 1").get(adminUid);
  assert.equal(row.subject, '9–10 月 期課已開放報名');
  assert.equal(row.body, '📅 9–10 月 期課已自動開放報名：PR續期A(週三) 9 場。');
});

// 冪等
const r2 = rolloverTemplates('2026-08-24');
expect('同日重跑 → 無延長、場次數不變、通知不增', () => {
  assert.deepEqual(r2.extended, []); assert.equal(count(A.templateId), aBefore + 9); assert.equal(adminNotifs() - n0, 1);
});
expect('9/1（期中）重跑 → 不動', () => assert.deepEqual(rolloverTemplates('2026-09-01').extended, []));

// 下一期窗口
const r3 = rolloverTemplates('2026-10-19');
expect('10/19 → A 延到 12/31、B 仍 8/31', () => {
  assert.equal(r3.targetEnd, '2026-12-31'); assert.equal(endOf(A.templateId), '2026-12-31'); assert.equal(endOf(B.templateId), '2026-08-31');
});
expect('10/19 → D 已在 12/31 不列入 extended', () => assert.ok(!r3.extended.some((e) => e.id === D.templateId)));

// 期中補回：auto_renew=1 但結束日被手動改到期中 → 隔日補回本期末
db.prepare("UPDATE course_templates SET cycle_end_date='2026-11-15' WHERE id=?").run(A.templateId);
const r4 = rolloverTemplates('2026-11-05');
expect('11/5 期中、A 結束日 11/15 → 補回 12/31', () => { assert.equal(r4.targetEnd, '2026-12-31'); assert.equal(endOf(A.templateId), '2026-12-31'); });

console.log('[period-rollover test] done');
```

- [ ] **Step 2: 跑測試確認 RED**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/period-rollover.test.js`
Expected: 匯入失敗（無 `periodService.js`），exit ≠ 0。

- [ ] **Step 3: 通知模板**

`src/services/notifications.js` TEMPLATES 物件，在 `course_cancelled: { … },` 區塊之後加：

```js
  period_rollover_admin: {  // 寄給管理者（期課自動續期完成；每次續期一則）
    subject: '{{period_label}} 期課已開放報名',
    body: '📅 {{period_label}} 期課已自動開放報名：{{summary}}。',
  },
```

- [ ] **Step 4: 實作 `src/services/periodService.js`**

```js
// 期課雙月期別自動續期：進最後一週把 auto_renew 範本延到下期末並補場次。冪等，每日 cron＋開機各跑一次。
import { db, tx, nowLocal } from '../db/connection.js';
import { expandTemplate } from './schedule.js';
import { notifyAdmins } from './notifications.js';
import { periodOf, periodLabel, targetEndFor } from './period.js';

// 選取條件：已發布、有開自動續期、結束日還沒到目標（本期末或下期末）
const selectDue = db.prepare(`
  SELECT * FROM course_templates
  WHERE status = 'published' AND auto_renew = 1 AND cycle_end_date < ?
  ORDER BY id ASC
`);
const extendTemplate = db.prepare('UPDATE course_templates SET cycle_end_date = ? WHERE id = ?');
// 與 courseService.insertSession 同欄位；UNIQUE(template_id, session_date) 讓重展開只補新場次
const insertSession = db.prepare(`
  INSERT OR IGNORE INTO course_sessions
    (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
  VALUES (?, ?, ?, ?, ?, 'open', ?)
`);

/**
 * 把該續的範本延長到 targetEndFor(today) 並補場次。
 * @returns {{ targetEnd: string, extended: Array<{ id: number, name: string, added: number }> }}
 */
export function rolloverTemplates(today = nowLocal().slice(0, 10)) {
  const targetEnd = targetEndFor(today);
  const extended = tx(() => {
    const out = [];
    for (const t of selectDue.all(targetEnd)) {
      extendTemplate.run(targetEnd, t.id);
      let added = 0;
      for (const s of expandTemplate({ ...t, cycle_end_date: targetEnd })) {
        const info = insertSession.run(t.id, s.session_date, s.start_at, s.end_at, s.registration_deadline, t.coach_id);
        if (info.changes > 0) added++;
      }
      out.push({ id: t.id, name: t.name, added });
    }
    return out;
  });
  if (extended.length) {
    // 交易提交後才發；added=0 的也列出方便對帳
    notifyAdmins({
      type: 'period_rollover_admin',
      vars: {
        period_label: periodLabel(periodOf(targetEnd)),
        summary: extended.map((e) => `${e.name} ${e.added} 場`).join('、'),
      },
    });
  }
  return { targetEnd, extended };
}
```

- [ ] **Step 5: 排程掛載**

`src/scheduler.js`：

(a) import 區加一行：`import { rolloverTemplates } from './services/periodService.js';`

(b) `export function startScheduler() {` 的第一行（在「每小時整點跑截止判定」之前）加開機自癒：

```js
  // 開機先跑一次期課自動續期（伺服器停機錯過 cron 也能補上；冪等）
  try {
    const r = rolloverTemplates();
    if (r.extended.length) console.log('[scheduler] period rollover at boot:', r);
  } catch (e) {
    console.error('[scheduler] period rollover error (boot):', e);
  }
```

(c) 在「每天早上 9 點」區塊之前加每日 cron：

```js
  // 每天 00:05 (Asia/Taipei)：期課自動續期（進雙月最後一週把 auto_renew 範本延到下期末並補場次）
  cron.schedule('5 0 * * *', () => {
    try {
      const r = rolloverTemplates();
      if (r.extended.length) console.log('[scheduler] period rollover:', r);
    } catch (e) {
      console.error('[scheduler] period rollover error:', e);
    }
  }, { timezone: 'Asia/Taipei' });
```

- [ ] **Step 6: 後台通知型別標籤**

`public/admin.js` `typeLabel` 物件，`reminder: '提醒', registration_cancelled: '取消報名',` 該行之後加一行：

```js
    period_rollover_admin: '期課續期',
```

- [ ] **Step 7: 跑測試確認 GREEN＋加入測試鏈**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/period-rollover.test.js`
Expected: 全部 ✓、exit 0。

`package.json` `"test"` 尾端（`node tests/period-service.test.js` 之後）追加 ` && node tests/period-rollover.test.js`。

- [ ] **Step 8: 開機煙測（驗 scheduler import＋開機 rollover 不炸）**

```bash
SMOKE_DB="$(mktemp -d)/t.db"
DB_PATH="$SMOKE_DB" PORT=3999 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js & SRV=$!
sleep 2 && curl -sf http://localhost:3999/api/health; RC=$?
kill $SRV
echo "RC=$RC"
```

Expected: `RC=0`，且 stdout 有 `[scheduler] cron jobs registered`、無 `period rollover error`。

- [ ] **Step 9: Commit**

```bash
git add src/services/periodService.js src/services/notifications.js src/scheduler.js public/admin.js tests/period-rollover.test.js package.json
git commit -m "期課自動續期工作：最後一週延長 auto_renew 範本到下期末＋補場次＋管理者通知＋每日/開機排程

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 公開頁只列本週週一起的場次

**Files:**
- Modify: `src/services/groupOrderService.js:598-640`（`getPublicGroupCourses`）＋檔頭 import
- Test: `tests/group-public-past.test.js`（改寫 fixture）

**Interfaces:**
- Consumes: Task 1 `weekStartMonday(ymd)`。
- Produces: `getPublicGroupCourses()` 回傳每個範本的 `sessions` 只含 `session_date >= 本週週一` 者；其餘欄位／語意不變。

- [ ] **Step 1: 改寫測試（RED）**

`tests/group-public-past.test.js` 整檔改為（保留原六個狀態案例，日期改成不依賴星期幾）：

```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { getPublicGroupCourses } from '../src/services/groupOrderService.js';
import { weekStartMonday } from '../src/services/period.js';

function reset() {
  db.exec(`
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dt(days, time) { return `${dstr(days)}T${time}`; }
function ymdAdd(ymd, days) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); }

console.log('[group-public-past test] start');
reset();

const today = dstr(0);
const weekStart = weekStartMonday(today);
const beforeWeek = ymdAdd(weekStart, -1);   // 本週週一的前一天（上週日）＝窗口外

const mk = (name) => createTemplate({
  name, min_capacity: 1, max_capacity: 3,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(50),
  registration_deadline_hours: 1, price_per_session: 500,
});
const tpl = mk('灰列班');
const tpl2 = mk('灰列班2');
const sess = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').all(tpl.templateId);
assert.ok(sess.length >= 6, `need >= 6 sessions, got ${sess.length}`);
const [s0, s1, s3, s4, s5, s6] = sess;
const s2 = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').get(tpl2.templateId);

// s0 上週（窗口外，應完全不回）；s1 今天凌晨已結束（本週內，灰色 ended）；s2 第二範本今天凌晨流課（本週內，not_held）；
// s3 未來已成班（已截止）；s4 未來 open 但暫停（隱藏）；s5 可報名；s6 未來 open 但截止時間已過（deadline 空窗）
const upd = db.prepare('UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=?, status=?, is_open=? WHERE id=?');
upd.run(beforeWeek, `${beforeWeek}T19:00:00`, `${beforeWeek}T20:00:00`, `${beforeWeek}T18:00:00`, 'confirmed', 1, s0.id);
upd.run(today, `${today}T00:01:00`, `${today}T00:02:00`, `${beforeWeek}T18:00:00`, 'confirmed', 1, s1.id);
upd.run(today, `${today}T00:02:00`, `${today}T00:03:00`, `${beforeWeek}T18:00:00`, 'cancelled', 1, s2.id);
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(s3.id);
db.prepare("UPDATE course_sessions SET is_open=0 WHERE id=?").run(s4.id);
db.prepare('UPDATE course_sessions SET registration_deadline=? WHERE id=?').run(dt(-1, '18:00:00'), s6.id);

const all = getPublicGroupCourses();
const t = all.find((x) => x.id === tpl.templateId);
const t2 = all.find((x) => x.id === tpl2.templateId);
expect('範本仍列出（尚有可報名場次）', () => { assert.ok(t); assert.ok(t2); });
const by = Object.fromEntries(t.sessions.map((s) => [s.id, s]));
const by2 = Object.fromEntries(t2.sessions.map((s) => [s.id, s]));

expect('本週週一之前的場次 → 完全不回（窗口外）', () => assert.equal(by[s0.id], undefined));
expect('本週已結束（今天凌晨）→ ended、不可選', () => { assert.equal(by[s1.id].state, 'ended'); assert.equal(by[s1.id].selectable, false); });
expect('本週流課 → not_held', () => assert.equal(by2[s2.id].state, 'not_held'));
expect('未來已成班 → deadline_passed', () => assert.equal(by[s3.id].state, 'deadline_passed'));
expect('未來暫停中 → 完全隱藏', () => assert.equal(by[s4.id], undefined));
expect('可報名場次 selectable=true / state=selectable', () => { assert.equal(by[s5.id].selectable, true); assert.equal(by[s5.id].state, 'selectable'); });
expect('截止已過但尚未判定 → deadline_passed、不可選', () => { assert.equal(by[s6.id].state, 'deadline_passed'); assert.equal(by[s6.id].selectable, false); });
expect('排序時間升冪（過去在前）', () => {
  const starts = t.sessions.map((s) => s.start_at);
  assert.deepEqual(starts, [...starts].sort());
});
expect('灰色列仍帶容量資訊', () => { assert.equal(typeof by[s1.id].occupied, 'number'); assert.equal(by[s1.id].max_capacity, 3); });

// 全數不可選 → 範本不列出
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE template_id=? AND status='open'").run(tpl.templateId);
expect('無可報名場次的範本不列出', () => {
  assert.equal(getPublicGroupCourses().find((x) => x.id === tpl.templateId), undefined);
});

console.log('[group-public-past test] done');
```

- [ ] **Step 2: 跑測試確認 RED**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/group-public-past.test.js`
Expected: 「本週週一之前的場次 → 完全不回」✗（現況會回 `ended`），其餘 ✓。

- [ ] **Step 3: 實作過濾**

`src/services/groupOrderService.js`：

(a) 檔頭 import 區加：`import { weekStartMonday } from './period.js';`

(b) `getPublicGroupCourses` 內場次查詢改為（JSDoc 與註解一併更新）：

```js
/** 公開：所有「尚有可報名場次」的 published template，回本週週一起的場次（不可報名場次帶 state 供灰色顯示）。 */
export function getPublicGroupCourses() {
  const now = nowLocal();
  const weekStart = weekStartMonday(now.slice(0, 10));
  // （templates 查詢與 return templates.map 開頭不動）
    // 窗口：只回本週週一起的場次（上週以前的歷史不再列；本週已上完的仍灰色顯示）。
    // 窗口內過去/已截止/流課場次一併回傳（前端灰色顯示、不可點）。
    // 唯一仍隱藏的是「未來、open、被管理者暫停(is_open=0)」的場次（暫停＝對客人完全隱藏）。
    const sessions = db.prepare(`
      SELECT id, session_date, start_at, end_at, status, registration_deadline, is_open
      FROM course_sessions
      WHERE template_id = ? AND session_date >= ?
        AND NOT (start_at > ? AND status = 'open' AND is_open = 0)
      ORDER BY start_at ASC
    `).all(t.id, weekStart, now).map((s) => {
```

其餘（`selectable`／`state`／`filter` 範本門檻）不動。

- [ ] **Step 4: 單檔 GREEN＋完整鏈**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/group-public-past.test.js && DB_PATH="$(mktemp -d)/t.db" npm test 2>&1 | tail -5`
Expected: 單檔全 ✓；完整鏈零 ✗、exit 0。**若其他測試（`public-api`／`group-order-*`／`admin-group-*`／`discount-*`）因範本從過去週起算而少列場次失敗：調整該測試 fixture 的日期到本週內，不要放寬過濾。**

- [ ] **Step 5: Commit**

```bash
git add src/services/groupOrderService.js tests/group-public-past.test.js
git commit -m "公開頁團課只列本週週一起的場次

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 後台範本表單「自動續期」勾選＋範本卡標記

**Files:**
- Modify: `public/admin.html:1061-1064`（週期起訖列之後）
- Modify: `public/admin.js:287-292`（openNew）、`:311-313`（openEdit 欄位迴圈之後）、`:325-333`（submit payload）、`:106-107`（範本卡 meta）

**Interfaces:**
- Consumes: Task 2 的 `auto_renew` 欄（`GET /api/admin/templates` 列表與 `/:id` 皆為 `SELECT t.*`，自動帶出）；`POST`／`PATCH /api/admin/templates` 接受 `auto_renew: 0|1`。
- Produces: 無後續依賴。

- [ ] **Step 1: 表單勾選框**

`public/admin.html`，在

```html
      <div class="grid grid-cols-2 gap-4">
        <div><label class="form-label">週期起始</label><input name="cycle_start_date" type="date" required class="form-input"></div>
        <div><label class="form-label">週期結束</label><input name="cycle_end_date" type="date" required class="form-input"></div>
      </div>
```

之後插入：

```html
      <div>
        <label class="form-label flex items-center gap-2" style="cursor:pointer">
          <input name="auto_renew" type="checkbox" checked>
          自動續期（每期最後一週自動開放下期場次）
        </label>
      </div>
```

- [ ] **Step 2: admin.js 三處**

(a) `openNew`：`f.reset(); f.id.value = '';` 之後加 `f.auto_renew.checked = true;`（`reset()` 會回到 HTML 預設 checked，此行是明確保證）。

(b) `openEdit`：在 `for (const k of ['name', … 'coach_id']) { … }` 迴圈之後、`f.id.value = t.id;` 之前加：

```js
  f.auto_renew.checked = t.auto_renew !== 0;   // 舊資料缺值視為開
```

(c) submit handler：`const id = payload.id; delete payload.id;` 之後加：

```js
  payload.auto_renew = f.auto_renew.checked ? 1 : 0;   // FormData 對未勾 checkbox 不帶 key，明確補 0/1
```

- [ ] **Step 3: 範本卡 meta 標記**

`public/admin.js` 範本卡 `<span class="meta-item">${ICO.range} ${t.cycle_start_date} ~ ${t.cycle_end_date}</span>` 之後加：

```js
            ${t.auto_renew !== 0 ? `<span class="meta-item">${ICO.repeat} 自動續期</span>` : ''}
```

- [ ] **Step 4: 手動驗證（瀏覽器）**

```bash
npm run seed && PORT=3000 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js
```

開 `http://localhost:3000/admin.html` 以 seed 管理者登入 → 課程頁籤：
- 「新增範本」表單有勾選框且預設勾；
- 編輯既有範本 → 取消勾選儲存 → 範本卡「自動續期」標記消失、再編輯勾選框為未勾；
- 勾回儲存 → 標記回來。

Expected: 三步皆符合；console 無錯。

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "後台範本表單加自動續期勾選＋範本卡標記

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
