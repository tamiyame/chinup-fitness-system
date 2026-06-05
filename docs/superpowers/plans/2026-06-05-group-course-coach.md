# 團體課程：授課教練欄位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 團體課報名頁每張課程卡片顯示授課教練名稱；後台課程範本表單可選擇授課教練。

**Architecture:** `course_templates` 新增可空的 `coach_id`（references `coaches.id`，`ON DELETE SET NULL`）。後端寫入並透過 LEFT JOIN 帶出 `coach_name`（公開 API + 後台清單）。前台卡片 meta 列附加教練名；後台表單以既有 `GET /api/admin/coaches` 填充必選下拉。教練「必填」由前台 HTML `required` 把關，後端寬鬆（coach_id 可空），故**不動任何既有測試/種子**。

**Tech Stack:** Node 24 ESM、Express 4、`node:sqlite` `DatabaseSync`、原生 fetch 前端（public/*.js）、手寫測試 runner（`expect(label, fn)` + `process.exitCode`）。

**設計來源：** `docs/superpowers/specs/2026-06-05-group-course-coach-design.md`（後端強度依後續決策改為「前台必填、後端寬鬆」）。

---

## File Structure

- `src/db/schema.js` — 全新 DB 的 `course_templates` CREATE TABLE 加 `coach_id`。
- `src/db/connection.js` — 既有 DB 以 `addColumnIfMissing` 補 `coach_id`（產線開機自動）。
- `src/services/courseService.js` — `normalize`/INSERT/UPDATE 帶 `coach_id`；`listTemplates` LEFT JOIN `coach_name`。
- `src/services/groupOrderService.js` — `getPublicGroupCourses` LEFT JOIN `coach_name`。
- `public/admin.html` — `#tpl-form` 加「授課教練」必選下拉。
- `public/admin.js` — 載入教練清單填充下拉、編輯帶出、送出帶 `coach_id`、後台清單顯示教練。
- `public/group.js` — 卡片 meta 列附加教練名。
- `tests/course-coach.test.js` — 新增：欄位存在、寫入/讀回 `coach_id`、`coach_name` 曝露、null 情形。

---

## Task 1: 資料表新增 coach_id 欄位（schema + migration）

**Files:**
- Create: `tests/course-coach.test.js`
- Modify: `src/db/schema.js:54`（course_templates 內 `price_per_session` 與 `created_at` 之間）
- Modify: `src/db/connection.js:156`（緊接 session_type migration 區塊後）

- [ ] **Step 1: 寫失敗測試（欄位存在）**

建立 `tests/course-coach.test.js`：

```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate, editTemplate, getTemplate, listTemplates } from '../src/services/courseService.js';
import { getPublicGroupCourses } from '../src/services/groupOrderService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

function reset() {
  db.exec(`
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'CoachTest%');
    DELETE FROM course_templates WHERE name LIKE 'CoachTest%';
    DELETE FROM coaches WHERE display_name LIKE 'CoachTest%';
    DELETE FROM users WHERE email LIKE 'coachtest-%';
  `);
}

console.log('[course-coach test] start');
reset();

// ── Task 1: 欄位存在 ─────────────────────────────────────────────
expect('course_templates has coach_id column', () => {
  const cols = db.prepare('PRAGMA table_info(course_templates)').all().map(c => c.name);
  assert(cols.includes('coach_id'));
});

console.log('[course-coach test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH=/tmp/coachtest.db rm -f /tmp/coachtest.db* ; DB_PATH=/tmp/coachtest.db node tests/course-coach.test.js`
Expected: 印出 `✗ course_templates has coach_id column`（欄位尚未建立），`process.exitCode=1`。

- [ ] **Step 3: 新庫 schema 加欄位**

`src/db/schema.js`，將 course_templates 的這兩行：

```js
  price_per_session INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
```

改為：

```js
  price_per_session INTEGER NOT NULL DEFAULT 0,
  coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
```

（註：`coaches` 表在本檔較後面才 CREATE，SQLite 允許 FK 前向參照，無妨。）

- [ ] **Step 4: 既有庫 migration 補欄位**

`src/db/connection.js`，在 session_type migration 區塊（`addColumnIfMissing('bookings', 'session_type', ...)`）之後，加入：

```js
// ── 2026-06-05 團體課程：授課教練 ──
// course_templates.coach_id：該課程範本的授課教練（references coaches.id）。
// 教練被刪除時自動轉為 NULL（ON DELETE SET NULL），不阻擋刪除。
// 欄位可空：舊範本為 NULL，前台不顯示教練；管理者下次編輯時於前台必選補上。
addColumnIfMissing('course_templates', 'coach_id', 'INTEGER REFERENCES coaches(id) ON DELETE SET NULL');
```

- [ ] **Step 5: 跑測試確認通過**

Run: `rm -f /tmp/coachtest.db* ; DB_PATH=/tmp/coachtest.db node tests/course-coach.test.js`
Expected: `✓ course_templates has coach_id column`，無 `✗`。

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.js src/db/connection.js tests/course-coach.test.js
git commit -m "feat(group-course): course_templates 新增 coach_id 欄位（schema + migration）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 後端寫入 coach_id 並曝露 coach_name

**Files:**
- Modify: `src/services/courseService.js`（`insertTemplate`、`updateTemplate`、`normalize`、`listTemplatesStmt`）
- Modify: `src/services/groupOrderService.js:283-289`（`getPublicGroupCourses` 範本查詢）
- Modify: `tests/course-coach.test.js`（接續 Task 1）

- [ ] **Step 1: 擴充測試（寫入 + 曝露 coach_name）**

在 `tests/course-coach.test.js` 的 `expect('course_templates has coach_id column', ...)` 之後、`console.log('[course-coach test] done')` 之前，插入：

```js
// 建一位教練（user + coach）
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('CoachTest U','coachtest-u@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'CoachTest 阿龍' });
setCoachActive(coach.id, true);

// ── Task 2: 寫入 coach_id + 曝露 coach_name ──────────────────────
const r = createTemplate({
  name: 'CoachTest 週一團課', min_capacity: 1, max_capacity: 6,
  day_of_week: 1, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: dstr(1), cycle_end_date: dstr(30),
  price_per_session: 600, coach_id: coach.id,
});
expect('coach_id stored on create', () => assert.equal(getTemplate(r.templateId).coach_id, coach.id));
expect('listTemplates exposes coach_name', () => {
  const row = listTemplates().find(t => t.id === r.templateId);
  assert.equal(row.coach_name, 'CoachTest 阿龍');
});
expect('getPublicGroupCourses exposes coach_name', () => {
  const c = getPublicGroupCourses().find(t => t.name === 'CoachTest 週一團課');
  assert(c, '應出現在公開清單（有未來場次）');
  assert.equal(c.coach_name, 'CoachTest 阿龍');
});
expect('editTemplate updates coach_id', () => {
  const cu2 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('CoachTest U2','coachtest-u2@x.com',?, 'coach')").run(hashPassword('x'));
  const coach2 = createCoach({ userId: cu2.lastInsertRowid, displayName: 'CoachTest 小美' });
  editTemplate(r.templateId, {
    name: 'CoachTest 週一團課', min_capacity: 1, max_capacity: 6,
    day_of_week: 1, start_time: '19:00', recurrence: 'weekly',
    cycle_start_date: dstr(1), cycle_end_date: dstr(30),
    price_per_session: 600, coach_id: coach2.id,
  });
  assert.equal(getTemplate(r.templateId).coach_id, coach2.id);
});
expect('null coach_id → coach_name null', () => {
  const r3 = createTemplate({
    name: 'CoachTest 無教練', min_capacity: 1, max_capacity: 6,
    day_of_week: 2, start_time: '19:00', recurrence: 'weekly',
    cycle_start_date: dstr(1), cycle_end_date: dstr(30),
  });
  const row = listTemplates().find(t => t.id === r3.templateId);
  assert.equal(row.coach_name, null);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `rm -f /tmp/coachtest.db* ; DB_PATH=/tmp/coachtest.db node tests/course-coach.test.js`
Expected: `coach_id stored on create` 等新案例 `✗`（coach_id 尚未寫入；`listTemplates`/`getPublicGroupCourses` 尚無 coach_name）。

- [ ] **Step 3: courseService 寫入 coach_id**

`src/services/courseService.js`：

(a) `insertTemplate`（檔首），欄位與 VALUES 各補 `coach_id` / `@coach_id`：

```js
const insertTemplate = db.prepare(`
  INSERT INTO course_templates
    (name, description, min_capacity, max_capacity, day_of_week, start_time,
     duration_minutes, recurrence, cycle_start_date, cycle_end_date,
     registration_deadline_hours, status, price_per_session, coach_id)
  VALUES (@name, @description, @min_capacity, @max_capacity, @day_of_week, @start_time,
          @duration_minutes, @recurrence, @cycle_start_date, @cycle_end_date,
          @registration_deadline_hours, @status, @price_per_session, @coach_id)
`);
```

(b) `updateTemplate`，在 SET 的 `price_per_session=@price_per_session` 後補 `, coach_id=@coach_id`：

```js
const updateTemplate = db.prepare(`
  UPDATE course_templates SET
    name=@name, description=@description,
    min_capacity=@min_capacity, max_capacity=@max_capacity,
    day_of_week=@day_of_week, start_time=@start_time,
    duration_minutes=@duration_minutes, recurrence=@recurrence,
    cycle_start_date=@cycle_start_date, cycle_end_date=@cycle_end_date,
    registration_deadline_hours=@registration_deadline_hours, status=@status,
    price_per_session=@price_per_session, coach_id=@coach_id
  WHERE id=@id
`);
```

(c) `normalize(t)`，在 `price_per_session` 那行後補 `coach_id`：

```js
function normalize(t) {
  return {
    name: t.name,
    description: t.description ?? '',
    min_capacity: Number(t.min_capacity),
    max_capacity: Number(t.max_capacity),
    day_of_week: Number(t.day_of_week),
    start_time: t.start_time,
    duration_minutes: Number(t.duration_minutes ?? 60),
    recurrence: t.recurrence,
    cycle_start_date: t.cycle_start_date,
    cycle_end_date: t.cycle_end_date,
    registration_deadline_hours: Number(t.registration_deadline_hours ?? 24),
    status: t.status ?? 'published',
    price_per_session: Number(t.price_per_session ?? 0),
    coach_id: (t.coach_id === undefined || t.coach_id === null || t.coach_id === '') ? null : Number(t.coach_id),
  };
}
```

（後端寬鬆：缺 coach_id 即存 NULL，不丟錯。非法非空 id 由 DB FK 擋下，但前台下拉只送有效 id。）

(d) `listTemplatesStmt`，改成 LEFT JOIN 帶 `coach_name`：

```js
const listTemplatesStmt = db.prepare(`
  SELECT t.*, c.display_name AS coach_name
  FROM course_templates t
  LEFT JOIN coaches c ON c.id = t.coach_id
  ORDER BY t.created_at DESC
`);
```

- [ ] **Step 4: groupOrderService 公開清單帶 coach_name**

`src/services/groupOrderService.js` 的 `getPublicGroupCourses`，將範本查詢：

```js
  const templates = db.prepare(`
    SELECT id, name, description, min_capacity, max_capacity, duration_minutes,
           price_per_session, recurrence, cycle_start_date, cycle_end_date
    FROM course_templates
    WHERE status = 'published'
    ORDER BY created_at DESC
  `).all();
```

改為：

```js
  const templates = db.prepare(`
    SELECT t.id, t.name, t.description, t.min_capacity, t.max_capacity, t.duration_minutes,
           t.price_per_session, t.recurrence, t.cycle_start_date, t.cycle_end_date,
           c.display_name AS coach_name
    FROM course_templates t
    LEFT JOIN coaches c ON c.id = t.coach_id
    WHERE t.status = 'published'
    ORDER BY t.created_at DESC
  `).all();
```

（其下 `.map((t) => { ... return { ...t, sessions }; })` 會自動把 `coach_name` 一併展開回傳，無需再改。）

- [ ] **Step 5: 跑測試確認通過**

Run: `rm -f /tmp/coachtest.db* ; DB_PATH=/tmp/coachtest.db node tests/course-coach.test.js`
Expected: 全部 `✓`，無 `✗`。

- [ ] **Step 6: 跑既有相關測試確認無回歸**

Run: `for t in course-price flow group-order-service discount-group my-schedule-service; do echo "== $t =="; rm -f /tmp/reg-$t.db* ; DB_PATH=/tmp/reg-$t.db node tests/$t.test.js; done`
Expected: 各檔皆無 `✗`（coach_id 寬鬆可空，既有 fixture 不傳 coach_id 仍正常）。

- [ ] **Step 7: Commit**

```bash
git add src/services/courseService.js src/services/groupOrderService.js tests/course-coach.test.js
git commit -m "feat(group-course): 後端寫入 coach_id 並以 coach_name 曝露（公開清單 + 後台清單）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 後台範本表單「授課教練」必選下拉

**Files:**
- Modify: `public/admin.html`（`#tpl-form` 內，課程名稱與課程說明之間）
- Modify: `public/admin.js`（新增 `coachesCache` + `loadCoachesForForm`、init 呼叫、`openEdit` 帶出、submit 轉型、`loadTemplates` 顯示教練）

無自動化前端測試框架；本任務以本機預覽手動 smoke 驗證（與專案既有手動驗收一致）。

- [ ] **Step 1: admin.html 加教練下拉**

在 `public/admin.html` 中，找到課程說明區塊起始：

```html
      <div>
        <label class="form-label">課程說明</label>
```

在它「之前」插入授課教練區塊：

```html
      <div>
        <label class="form-label">授課教練</label>
        <select name="coach_id" required class="form-select" id="tpl-coach-select">
          <option value="">— 請選擇授課教練 —</option>
        </select>
      </div>
```

- [ ] **Step 2: admin.js 新增 coachesCache + 載入函式**

在 `public/admin.js` 找到：

```js
// --- Categories ---
let categoriesCache = [];
```

改為（在其後加入 coachesCache 與載入函式）：

```js
// --- Categories ---
let categoriesCache = [];

// --- Coaches (for template form select) ---
let coachesCache = [];
async function loadCoachesForForm() {
  const sel = document.getElementById('tpl-coach-select');
  try {
    coachesCache = await api('/api/admin/coaches');
    if (sel) {
      const current = sel.value;
      sel.innerHTML = '<option value="">— 請選擇授課教練 —</option>' +
        coachesCache.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
      if (current) sel.value = current;
    }
  } catch (e) {
    // 教練清單載入失敗不阻斷後台其他功能
    console.error('load coaches for form failed', e);
  }
}
```

- [ ] **Step 3: admin.js init 呼叫載入**

在 `public/admin.js` 接近檔尾的初始化呼叫處，找到：

```js
loadCategories();
loadTemplates();
```

改為：

```js
loadCategories();
loadCoachesForForm();
loadTemplates();
```

- [ ] **Step 4: openEdit 帶出 coach_id**

在 `public/admin.js` 的 `openEdit`，找到欄位回填迴圈：

```js
  for (const k of ['name','description','min_capacity','max_capacity','day_of_week','start_time','duration_minutes','registration_deadline_hours','recurrence','cycle_start_date','cycle_end_date','price_per_session']) {
    if (f[k]) f[k].value = t[k] ?? '';
  }
```

於陣列末端加入 `'coach_id'`：

```js
  for (const k of ['name','description','min_capacity','max_capacity','day_of_week','start_time','duration_minutes','registration_deadline_hours','recurrence','cycle_start_date','cycle_end_date','price_per_session','coach_id']) {
    if (f[k]) f[k].value = t[k] ?? '';
  }
```

- [ ] **Step 5: submit 轉型 coach_id**

在 `public/admin.js` 的 `#tpl-form` submit handler，找到：

```js
  if (payload.price_per_session !== undefined) {
    payload.price_per_session = Number(payload.price_per_session);
  }
```

在其後加入：

```js
  if (payload.coach_id !== undefined && payload.coach_id !== '') {
    payload.coach_id = Number(payload.coach_id);
  }
```

- [ ] **Step 6: 後台範本清單顯示教練名**

在 `public/admin.js` 的 `loadTemplates` 範本卡片 meta，找到：

```js
              <span class="meta-item">👥 ${t.min_capacity}–${t.max_capacity} 人</span>
              <span class="meta-item">🔁 ${RECURRENCE_LABEL[t.recurrence]}</span>
```

於兩者之間插入教練 meta：

```js
              <span class="meta-item">👥 ${t.min_capacity}–${t.max_capacity} 人</span>
              <span class="meta-item">🧑‍🏫 ${escapeHtml(t.coach_name || '未指定')}</span>
              <span class="meta-item">🔁 ${RECURRENCE_LABEL[t.recurrence]}</span>
```

- [ ] **Step 7: 本機預覽手動 smoke**

啟動預覽（若尚未啟動）：`PORT=3000 node src/server.js`（背景）。
以管理者登入後台 `/admin`，驗證：
1. 「新增範本」表單出現「授課教練」必選下拉，列出所有教練 display_name；未選教練無法送出（瀏覽器 required 擋下）。
2. 選一位教練建立範本 → 範本清單該卡片 meta 顯示 `🧑‍🏫 教練名`。
3. 「編輯」既有範本 → 下拉正確帶出原教練（舊範本顯示 `未指定`，可選後儲存）。

- [ ] **Step 8: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat(group-course): 後台範本表單加授課教練必選下拉 + 清單顯示教練

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前台課程卡片顯示教練名

**Files:**
- Modify: `public/group.js`（`renderTemplate` 的 `.course-meta` 列）

- [ ] **Step 1: group.js meta 列附加教練名**

在 `public/group.js` 的 `renderTemplate`，找到：

```js
        <p class="course-meta">⏱ ${tpl.duration_minutes} 分鐘・👥 ${tpl.min_capacity}–${tpl.max_capacity} 人</p>
```

改為（教練名存在才附加）：

```js
        <p class="course-meta">⏱ ${tpl.duration_minutes} 分鐘・👥 ${tpl.min_capacity}–${tpl.max_capacity} 人${tpl.coach_name ? `・🧑‍🏫 教練 ${escapeHtml(tpl.coach_name)}` : ''}</p>
```

- [ ] **Step 2: 本機預覽手動 smoke**

預覽 `/group`，驗證：
1. 有指定教練的課程卡片，meta 列尾端顯示 `・🧑‍🏫 教練 XXX`。
2. 尚未指定教練的舊課程卡片，meta 列維持原樣（不顯示教練段）。

- [ ] **Step 3: Commit**

```bash
git add public/group.js
git commit -m "feat(group-course): 報名頁課程卡片 meta 顯示授課教練名

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 全套驗證 + 預覽端對端 smoke

**Files:** 無（驗證任務）

- [ ] **Step 1: 跑全套單元測試**

Run: `npm test`
Expected: 全綠（含新 `course-coach.test.js`；既有測試無回歸）。
注意：`npm test` 會清空 `data/app.db` 的 demo 資料 → 完成後重建預覽資料再驗收。

- [ ] **Step 2: 重建預覽資料庫**

Run: `node src/db/seed-demo.js`（或既有的 `scripts/setup_preview.mjs`，視當下預覽需求）。

- [ ] **Step 3: 端對端 smoke（後台建課 → 前台顯示）**

1. 後台 `/admin` 新增一個團體課範本，選定一位教練、設未來週期。
2. 前台 `/group` 確認該課程卡片 meta 顯示對應教練名。
3. 後台編輯該範本改選另一位教練 → 前台重新整理後卡片教練名同步更新。

- [ ] **Step 4: 確認 git 狀態乾淨、準備開 PR**

Run: `git status && git log --oneline origin/main..HEAD`
Expected: working tree clean；列出本功能 4 個 feature commit（+ Task 1~4）。

---

## Self-Review

**Spec coverage：**
- 前台卡片顯示教練名 → Task 2（coach_name）+ Task 4（group.js 顯示）。✓
- 後台範本表單可選教練 → Task 3（下拉 + 帶出 + 送出）。✓
- 教練名取自 `coaches.display_name` → Task 2 LEFT JOIN `c.display_name`。✓
- 「必填」→ 前台 HTML `required`（Task 3）；後端寬鬆（依決策；spec 原訂後端硬擋已調整）。✓
- 資料模型 coach_id + ON DELETE SET NULL → Task 1。✓

**Placeholder scan：** 無 TBD/TODO；每個改碼步驟皆附完整 old/new 程式碼。✓

**Type consistency：** 後端欄位 `coach_id`（snake）、回傳 `coach_name`；前端表單 `name="coach_id"`、`#tpl-coach-select`、`coachesCache`、`loadCoachesForForm` 全程一致；`getPublicGroupCourses`/`listTemplates` 皆回 `coach_name`，前端 `tpl.coach_name`/`t.coach_name` 對應。✓
