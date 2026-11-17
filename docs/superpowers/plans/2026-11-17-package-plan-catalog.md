# 套裝方案價目表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台多一個「方案」頁籤（套裝方案價目表），兩個「新增方案」入口改成先選套裝、保留自訂；價目表為空時一切與現在相同。

**Architecture:** 新資料表 `package_plans`＋一個存在 `app_settings` 的版本計數器，由新服務檔 `packagePlanService.js` 讀寫；`createPackage` 多收 `fromPlan`，為 `true` 時用當下價目表核價並在 `customer_packages.from_plan` 記下開立方式。前端新增兩個不依賴其他模組的檔案：`package-plan-picker.js`（兩個入口共用的選法）與 `package-plan-table.js`（價目表編輯的純邏輯），純邏輯部分用 node 測。

**Tech Stack:** Node 24（`node:sqlite`）、Express、原生 ES module 前端（無打包）、測試是 `tests/*.test.js` 的 node 腳本。

**Spec:** `docs/superpowers/specs/2026-11-17-package-plan-catalog-design.md`。版面：設計畫布 https://claude.ai/artifact/MdbBPAYBc76j4ZSHx5PxHV 的 C 排。

## Global Constraints

- 只在這個 worktree 工作：`/Users/ryansheu/projects/chinup-worktrees/package-plans`，分支 `feat/package-plan-catalog`。不要 `cd` 到主專案，不要 push，不要開 PR。
- 每個指令前先 `export PATH=/Users/ryansheu/.local/bin:$PATH`（Node 在這裡）。
- 不新增任何套件。
- 資料庫只新增：一張新表、一個可空欄位。不改、不刪既有資料與欄位。
- 上限與錯誤碼照規格逐字：組合最多 60、堂數 1–200、每堂單價 1–1,000,000；`invalid_plans`、`invalid_session_type`、`invalid_total`、`invalid_unit_price`、`duplicate_plan`（400）；`plans_changed`、`plan_not_available`、`plan_price_changed`（409）。
- 價目表為空（或讀取失敗）時，兩個「新增方案」入口的畫面、送出的內容必須與改動前相同：不帶 `fromPlan`。
- 畫面文字照本計畫逐字（全形引號、全形括號、破折號照抄）。
- 註解與測試標籤用繁體中文；程式識別字用英文。
- 測試寫法照現有檔案：`import assert from 'node:assert/strict'`、`expect(label, fn)` 小工具、失敗時 `process.exitCode = 1`。測試與示範資料一律虛構（不得出現真實姓名、電話）。
- 新的服務層測試用獨立的暫存資料庫（`process.env.DB_PATH` 指到 `os.tmpdir()`，照 `tests/online-single.test.js` 開頭的寫法），不碰共用的 `data/app.db`。
- 跑完整 `npm test` 之前先 `rm -f data/app.db data/app.db-wal data/app.db-shm`（同一個資料庫連跑兩輪會有既有的外鍵殘留失敗，與本功能無關）。改動前的基準：`npm test` 結束碼 0、1107 個 ✓、0 個 ✗。
- commit 訊息用繁體中文，最後一行必須一字不差是 `Co-Authored-By: Claude <noreply@anthropic.com>`（不帶型號、不加其他署名）。
- 外觀照 `DESIGN.md`：單一天藍強調色（`#0ea5e9`、深 `#0284c7`、淡底 `#f0f9ff`）、髮絲線 `#e5e7eb`、數字用 Archivo＋`font-variant-numeric: tabular-nums`、輸入框字級 16px、不用 emoji 當圖示。沿用頁面上現有的類別（`.form-input`、`.form-select`、`.btn`、`.btn-primary`、`.btn-ghost`、`.a-sec-head`、`.section-title`、`.a-sec-line`、`.subtle`、`.empty-state`），不引入新的視覺語彙。
- 本機預覽（做畫面的 task 用）：`rm -f data/app.db data/app.db-wal data/app.db-shm && npm run seed`，再 `PORT=3100 LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 npm start`（背景執行）。管理者帳密在 `src/db/seed.js`（只在本機 `localhost:3100` 使用，不要貼進回報）。Playwright 可用 `createRequire('/Users/ryansheu/.npm/_npx/5c6d8c4f680fcd0a/node_modules/x.js')('playwright')` 載入。做完要關掉自己開的伺服器。

## Review Focus

規格沒有逐條寫、但使用者一定會碰到的情況。每一條都已在對應 task 加上測試或檢查：

1. 價目表格子裡打「1,400」「 1400 」或全形數字「１４００」→ 應該被當成 1400，不是報錯（Task 6 `parseAmount`）。
2. 連點兩下「儲存價目表」→ 第二下不能送出（否則第二個請求拿舊版本，會跳出假的「已被改過」）（Task 6）。連點「建立方案」→ 不能開出兩筆（Task 7）。
3. 開著選法表單時價目表被整張清空，使用者改用自訂開方案 → 不能被記成「例外」：`fromPlan` 不送（Task 5 `selectionOf`）。
4. 版本用數字或字串送都要認；沒帶版本一律當成對不上（Task 2）。
5. 開著表單時所選的套裝被移除 → 伺服器回 `plan_not_available`，畫面重取價目表後原本的選取要清掉，使用者重新點（Task 5 `withPlans`、Task 7）。

---

### Task 1: 資料庫——`package_plans` 表與 `customer_packages.from_plan`

**Files:**
- Modify: `src/db/schema.js`（`customer_packages` 建表語句加一欄；其後新增 `package_plans`）
- Modify: `src/db/connection.js`（「2026-11-14 線上單堂方案」那段之後補欄位）
- Create: `tests/package-plan-migration.test.js`
- Modify: `package.json`（`test` 指令鏈最後接上新測試）

**Interfaces:**
- Produces：資料表 `package_plans(id, session_type, total_sessions, unit_price)`，`UNIQUE(session_type, total_sessions)`；欄位 `customer_packages.from_plan`（`INTEGER`，可空，只接受 0／1）。

- [ ] **Step 1: 寫失敗的測試** `tests/package-plan-migration.test.js`

```js
// 套裝方案價目表：既有資料庫升級（新表 package_plans、customer_packages 補 from_plan）。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dbPath = join(tmpdir(), `package-plan-mig-${process.pid}.db`);
const freshPath = join(tmpdir(), `package-plan-fresh-${process.pid}.db`);
for (const p of [dbPath, freshPath]) for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-migration test] start');

// 改動前的 customer_packages（有 source、沒有 from_plan）＋一筆舊資料；沒有 package_plans 表
const old = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
old.exec(`
CREATE TABLE customer_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK (session_type IN ('1on1','1on2')),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  remaining_sessions INTEGER NOT NULL CHECK (remaining_sessions >= 0),
  amount INTEGER,
  expires_at TEXT,
  note TEXT,
  discount_code TEXT,
  source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'online')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
`);
old.prepare("INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, note) VALUES (1, '1on1', 10, 7, 14000, '舊方案')").run();
old.close();

process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');
const insPlan = (type, total, unit) => db.prepare('INSERT INTO package_plans (session_type, total_sessions, unit_price) VALUES (?, ?, ?)').run(type, total, unit);

expect('既有資料表補上 from_plan，舊資料是 NULL、其他欄位不變', () => {
  assert.ok(db.prepare('PRAGMA table_info(customer_packages)').all().some((c) => c.name === 'from_plan'));
  const r = db.prepare('SELECT * FROM customer_packages WHERE id = 1').get();
  assert.equal(r.from_plan, null);
  assert.equal(r.remaining_sessions, 7);
  assert.equal(r.amount, 14000);
  assert.equal(r.note, '舊方案');
  assert.equal(r.source, 'staff');
});
expect('from_plan 只接受 0／1／NULL', () => {
  assert.throws(() => db.prepare('UPDATE customer_packages SET from_plan = 2 WHERE id = 1').run(), /CHECK/);
  db.prepare('UPDATE customer_packages SET from_plan = 1 WHERE id = 1').run();
  db.prepare('UPDATE customer_packages SET from_plan = 0 WHERE id = 1').run();
  db.prepare('UPDATE customer_packages SET from_plan = NULL WHERE id = 1').run();
});
expect('package_plans 表存在；同類型同堂數不能重複，不同類型可以', () => {
  insPlan('1on1', 10, 1400);
  assert.throws(() => insPlan('1on1', 10, 1500), /UNIQUE/);
  insPlan('1on2', 10, 1900);
});
expect('package_plans 的 CHECK：類型、堂數 > 0、單價 > 0', () => {
  assert.throws(() => insPlan('group', 10, 1400), /CHECK/);
  assert.throws(() => insPlan('1on1', 0, 1400), /CHECK/);
  assert.throws(() => insPlan('1on1', 20, 0), /CHECK/);
});

// 另開行程再開一次同一個資料庫（重複開機）＋開一個全新的資料庫
const connUrl = new URL('../src/db/connection.js', import.meta.url).href;
const boot = (path, body) => execFileSync(process.execPath, ['--input-type=module', '-e',
  `const { db } = await import(${JSON.stringify(connUrl)}); ${body}`], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
expect('升級過的資料庫重複開機不出錯，資料還在', () => {
  const out = boot(dbPath, "console.log(db.prepare('SELECT COUNT(*) AS c FROM package_plans').get().c);");
  assert.equal(out.trim(), '2');
});
expect('全新資料庫的 customer_packages 也有 from_plan、也有 package_plans 表', () => {
  const out = boot(freshPath, "console.log(db.prepare('PRAGMA table_info(customer_packages)').all().some((c) => c.name === 'from_plan'), !!db.prepare(\"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'package_plans'\").get());");
  assert.equal(out.trim(), 'true true');
});

db.close();
for (const p of [dbPath, freshPath]) for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
console.log('[package-plan-migration test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/package-plan-migration.test.js`
Expected: 有 ✗（`no such table: package_plans`、找不到 `from_plan`），結束碼非 0。

- [ ] **Step 3: 改 `src/db/schema.js`**

`customer_packages` 的建表語句在 `source` 那行後面加 `from_plan INTEGER CHECK (from_plan IN (0, 1)),`。在 `idx_customer_packages_member` 索引之後新增：

```sql
CREATE TABLE IF NOT EXISTS package_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_type TEXT NOT NULL CHECK (session_type IN ('1on1','1on2')),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  UNIQUE (session_type, total_sessions)
);
```

- [ ] **Step 4: 改 `src/db/connection.js`**

在 `addColumnIfMissing('customer_packages', 'source', …)` 與其索引之後加一段（附一行註解說明三種值：1 照價目表開、0 有套裝可選卻選自訂、NULL 舊資料／線上單堂／開立當下沒有套裝可選）：

```js
addColumnIfMissing('customer_packages', 'from_plan', 'INTEGER CHECK (from_plan IN (0, 1))');
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node tests/package-plan-migration.test.js`
Expected: 全部 ✓，結束碼 0。

- [ ] **Step 6: 接進 `npm test` 並跑整套**

`package.json` 的 `test` 指令鏈最後加 ` && node tests/package-plan-migration.test.js`。
Run: `rm -f data/app.db data/app.db-wal data/app.db-shm && npm test > /tmp/pp-t1.log 2>&1; echo "exit=$?"; grep -c '✗' /tmp/pp-t1.log`
Expected: `exit=0`、✗ 為 0。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.js src/db/connection.js tests/package-plan-migration.test.js package.json
git commit -m "feat(db): 套裝方案價目表資料表與 from_plan 欄位"
```
（訊息最後一行照 Global Constraints 加署名，以下各 task 相同。）

---

### Task 2: 價目表服務 `packagePlanService.js`

**Files:**
- Create: `src/services/packagePlanService.js`
- Create: `tests/package-plan-service.test.js`
- Modify: `package.json`（`test` 鏈最後接上）

**Interfaces:**
- Consumes：Task 1 的 `package_plans` 表；`getSetting`／`setSetting`（`src/services/discountService.js`）、`tx`（`src/db/connection.js`）、`ApiError`（`src/services/registration.js`，欄位 `status`、`code`）。
- Produces（Task 3、4 使用）：

```js
/** 一筆套裝：{ sessionType: '1on1'|'1on2', totalSessions: number, unitPrice: number } */
export function getPlanTable()                       // → { version: string, plans: Plan[] }，plans 依堂數小到大、同堂數 '1on1' 在前
export function replacePlanTable({ version, plans }) // → 與 getPlanTable() 相同形狀（新版本）；錯誤丟 ApiError
export function findPlan(sessionType, totalSessions) // → Plan | null
```

版本的做法（本計畫決定）：`app_settings` 的 `package_plans_version`，內容是整數字串，沒有這筆設定時視為 `'0'`；每次成功儲存加 1。比對時把送來的值轉成字串再比（數字 `3` 與字串 `'3'` 視為相同）；型別不是字串或數字一律算對不上。

- [ ] **Step 1: 寫失敗的測試** `tests/package-plan-service.test.js`

```js
// 套裝方案價目表 service：讀取、整張取代、版本、驗證。用獨立的暫存資料庫。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `package-plan-svc-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');
const { getPlanTable, replacePlanTable, findPlan } = await import('../src/services/packagePlanService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };
console.log('[package-plan-service test] start');

const A = { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 };
const B = { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 };
const C = { sessionType: '1on1', totalSessions: 20, unitPrice: 1300 };
const D = { sessionType: '1on1', totalSessions: 5, unitPrice: 1450 };
const save = (plans) => replacePlanTable({ version: getPlanTable().version, plans });

expect('空表：plans 是空陣列、版本是非空字串', () => {
  const t = getPlanTable();
  assert.deepEqual(t.plans, []);
  assert.equal(typeof t.version, 'string');
  assert.ok(t.version.length > 0);
});
expect('儲存後依堂數小到大、同堂數一對一在前；版本改變；回傳與 getPlanTable 相同', () => {
  const v0 = getPlanTable().version;
  const r = replacePlanTable({ version: v0, plans: [C, B, A, D] });
  assert.deepEqual(r.plans, [D, A, B, C]);
  assert.notEqual(r.version, v0);
  assert.deepEqual(getPlanTable(), r);
});
expect('findPlan：有就回那一筆，沒有回 null', () => {
  assert.deepEqual(findPlan('1on2', 10), B);
  assert.equal(findPlan('1on2', 20), null);
});
expect('整張取代：沒送的組合消失', () => {
  assert.deepEqual(save([A]).plans, [A]);
  assert.equal(findPlan('1on2', 10), null);
});
expect('同一個版本存第二次 → 409 plans_changed，內容是第一次存的', () => {
  const v = getPlanTable().version;
  replacePlanTable({ version: v, plans: [A, B] });
  throwsCode(() => replacePlanTable({ version: v, plans: [C] }), 409, 'plans_changed');
  assert.deepEqual(getPlanTable().plans, [A, B]);
});
expect('沒帶版本、版本不是字串或數字 → 409 plans_changed，內容不變', () => {
  for (const bad of [undefined, null, {}, [], true]) throwsCode(() => replacePlanTable({ version: bad, plans: [C] }), 409, 'plans_changed');
  assert.deepEqual(getPlanTable().plans, [A, B]);
});
expect('版本用數字送也認', () => {
  const v = getPlanTable().version;
  assert.deepEqual(replacePlanTable({ version: Number(v), plans: [A, B] }).plans, [A, B]);
});
expect('版本對不上時不檢查內容：先回 plans_changed', () => {
  throwsCode(() => replacePlanTable({ version: 'nope', plans: 'x' }), 409, 'plans_changed');
});

// 驗證錯誤：整批不存，內容與版本都不變（此時表裡是 [A, B]）
const bad = (plans, code) => { const before = getPlanTable();
  throwsCode(() => replacePlanTable({ version: before.version, plans }), 400, code);
  assert.deepEqual(getPlanTable(), before); };
const many = (n) => Array.from({ length: n }, (_, i) => ({ sessionType: i % 2 ? '1on2' : '1on1', totalSessions: Math.floor(i / 2) + 1, unitPrice: 1000 }));
expect('plans 不是陣列 → invalid_plans', () => { bad(undefined, 'invalid_plans'); bad('x', 'invalid_plans'); bad({}, 'invalid_plans'); });
expect('項目不是物件 → invalid_plans', () => { bad([null], 'invalid_plans'); bad([A, 'x'], 'invalid_plans'); });
expect('超過 60 筆 → invalid_plans', () => bad(many(61), 'invalid_plans'));
expect('類型不對 → invalid_session_type', () => { bad([{ ...A, sessionType: 'group' }], 'invalid_session_type'); bad([{ totalSessions: 10, unitPrice: 1400 }], 'invalid_session_type'); });
expect('堂數 0、201、1.5、字串 → invalid_total', () => { for (const t of [0, 201, 1.5, '10', null]) bad([A, { ...C, totalSessions: t }], 'invalid_total'); });
expect('單價 0、1000001、1.5、字串 → invalid_unit_price', () => { for (const u of [0, 1000001, 1.5, '1400', null]) bad([A, { ...C, unitPrice: u }], 'invalid_unit_price'); });
expect('同類型同堂數出現兩次 → duplicate_plan', () => bad([A, B, { ...A, unitPrice: 1500 }], 'duplicate_plan'));
expect('剛好 60 筆、邊界值（堂數 1 與 200、單價 1 與 1000000）可以存', () => {
  assert.equal(save(many(60)).plans.length, 60);
  const edge = [{ sessionType: '1on1', totalSessions: 1, unitPrice: 1 }, { sessionType: '1on2', totalSessions: 200, unitPrice: 1000000 }];
  assert.deepEqual(save(edge).plans, edge);
});
expect('空陣列合法：清空價目表，版本照樣前進', () => {
  const v = getPlanTable().version;
  const r = save([]);
  assert.deepEqual(r.plans, []);
  assert.notEqual(r.version, v);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[package-plan-service test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/package-plan-service.test.js`
Expected: 匯入 `packagePlanService.js` 失敗（`ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 3: 實作 `src/services/packagePlanService.js`**

三個匯出照 Interfaces。`replacePlanTable` 整個包在 `tx()` 裡，順序固定：①核版本（對不上丟 `ApiError(409, 'plans_changed')`）→ ②驗證（照測試的錯誤碼；`totalSessions`、`unitPrice` 必須是 JSON 數字且為整數，字串不收）→ ③寫入（刪掉全部再插入，或比對後增刪改，自行決定）→ ④版本加 1 → 回傳 `getPlanTable()`。上限寫成檔案開頭的常數：`MAX_PLANS = 60`、`MAX_SESSIONS = 200`、`MAX_UNIT_PRICE = 1000000`。

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/package-plan-service.test.js`
Expected: 全部 ✓，結束碼 0。

- [ ] **Step 5: 接進 `npm test`、Commit**

`package.json` 的 `test` 鏈最後加 ` && node tests/package-plan-service.test.js`。

```bash
git add src/services/packagePlanService.js tests/package-plan-service.test.js package.json
git commit -m "feat(plans): 套裝方案價目表服務（讀取、整張取代、版本）"
```

---

### Task 3: `createPackage` 接受 `fromPlan`

**Files:**
- Modify: `src/services/packageService.js`（`createPackage`）
- Create: `tests/package-from-plan.test.js`
- Modify: `package.json`（`test` 鏈最後接上）

**Interfaces:**
- Consumes：Task 2 的 `findPlan(sessionType, totalSessions)`、`replacePlanTable`、`getPlanTable`。
- Produces：`createPackage({ …現有參數, fromPlan })`。`fromPlan` 為 `undefined`／`null` → `from_plan` 存 `NULL`；`false` → `0`；`true` → 核價後存 `1`；其他值 → `ApiError(400, 'invalid_from_plan')`。回傳的方案物件帶 `from_plan`。

- [ ] **Step 1: 寫失敗的測試** `tests/package-from-plan.test.js`

```js
// 開會員方案帶 fromPlan：核價、from_plan 三種值、既有行為不變。用獨立的暫存資料庫。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `package-from-plan-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
process.env.LINE_MOCK = '1'; process.env.GMAIL_MOCK = '1'; process.env.GCAL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const pkg = await import('../src/services/packageService.js');
const { getPlanTable, replacePlanTable } = await import('../src/services/packagePlanService.js');
const { createDiscountCode } = await import('../src/services/discountService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };
console.log('[package-from-plan test] start');

const m = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('套裝客','pfp-m@x.com','user','0967000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('套裝管','pfp-a@x.com','coach',1)").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '套裝教練', 1)").run(admin).lastInsertRowid);
const setPlans = (plans) => replacePlanTable({ version: getPlanTable().version, plans });
const count = () => db.prepare('SELECT COUNT(*) AS c FROM customer_packages').get().c;
const mk = (extra) => pkg.createPackage({ memberId: m, sessionType: '1on1', totalSessions: 10, createdBy: admin, ...extra });
setPlans([{ sessionType: '1on1', totalSessions: 10, unitPrice: 1400 }, { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 }]);
createDiscountCode({ code: 'PFP500', discount_type: 'fixed', discount_value: 500 });

expect('fromPlan:true 且金額＝單價×堂數 → 建立，from_plan = 1', () => {
  const p = mk({ amount: 14000, fromPlan: true });
  assert.equal(p.amount, 14000);
  assert.equal(p.from_plan, 1);
  assert.equal(p.remaining_sessions, 10);
});
expect('fromPlan:true 加折扣碼 → 以折前總額核價、入帳是折後總額，from_plan = 1', () => {
  const p = mk({ amount: 14000, fromPlan: true, discountCode: 'PFP500' });
  assert.equal(p.amount, 13500);
  assert.equal(p.discount_code, 'PFP500');
  assert.equal(p.from_plan, 1);
});
expect('價目表沒有那個組合 → 409 plan_not_available，沒有新增方案', () => {
  const n = count();
  throwsCode(() => mk({ totalSessions: 20, amount: 28000, fromPlan: true }), 409, 'plan_not_available');
  assert.equal(count(), n);
});
expect('金額對不上或沒帶 → 409 plan_price_changed，沒有新增方案', () => {
  const n = count();
  throwsCode(() => mk({ amount: 15000, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ amount: null, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ fromPlan: true }), 409, 'plan_price_changed');
  assert.equal(count(), n);
});
expect('基本欄位先檢查：類型錯仍是 400 invalid_session_type', () => {
  throwsCode(() => mk({ sessionType: 'x', amount: 14000, fromPlan: true }), 400, 'invalid_session_type');
});
expect('fromPlan:false → from_plan = 0，其餘與不帶時相同', () => {
  const p = mk({ totalSessions: 8, amount: 12000, fromPlan: false });
  assert.equal(p.from_plan, 0);
  assert.equal(p.amount, 12000);
  assert.equal(p.total_sessions, 8);
  assert.equal(p.remaining_sessions, 8);
});
expect('不帶 fromPlan（或 null）→ from_plan 是 NULL', () => {
  assert.equal(mk({ amount: 15000 }).from_plan, null);
  assert.equal(mk({ amount: 15000, fromPlan: null }).from_plan, null);
});
expect('不帶 fromPlan、單價留空 → 無單價方案；帶了折扣碼也略過', () => {
  const p = mk({ amount: null, discountCode: 'PFP500' });
  assert.equal(p.amount, null);
  assert.equal(p.discount_code, null);
  assert.equal(p.from_plan, null);
});
expect('fromPlan 不是布林 → 400 invalid_from_plan，沒有新增方案', () => {
  const n = count();
  for (const v of ['true', 1, 0, 'false']) throwsCode(() => mk({ amount: 14000, fromPlan: v }), 400, 'invalid_from_plan');
  assert.equal(count(), n);
});
expect('改價目表後，先前開出的方案金額不變', () => {
  const p = mk({ amount: 14000, fromPlan: true });
  setPlans([{ sessionType: '1on1', totalSessions: 10, unitPrice: 1600 }]);
  assert.equal(pkg.getPackage(p.id).amount, 14000);
  assert.equal(pkg.getPackage(p.id).from_plan, 1);
  throwsCode(() => mk({ amount: 14000, fromPlan: true }), 409, 'plan_price_changed');
  assert.equal(mk({ amount: 16000, fromPlan: true }).from_plan, 1);
});
expect('線上單堂方案的 from_plan 是 NULL', () => {
  const b = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount) VALUES (?, ?, '2099-01-05T10:00:00', '2099-01-05T11:00:00', '1on1', 1500)").run(coachId, m).lastInsertRowid);
  const id = pkg.createOnlineSingleForBooking(b);
  assert.equal(db.prepare('SELECT from_plan FROM customer_packages WHERE id = ?').get(id).from_plan, null);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[package-from-plan test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/package-from-plan.test.js`
Expected: 多個 ✗（`from_plan` 是 `undefined`／`null` 而不是 1、沒有丟 409）。

- [ ] **Step 3: 改 `createPackage`**

簽名加 `fromPlan`。檢查順序：現有的會員、類型、堂數、金額格式、到期日、會員存在檢查全部照舊 → `fromPlan` 型別（非 `undefined`／`null`／布林 → `invalid_from_plan`）→ `fromPlan === true` 時用 `findPlan` 核價（查不到 `plan_not_available`；折扣**前**的金額不等於 `unitPrice × 堂數` 或沒帶 → `plan_price_changed`）→ 現有的折扣碼處理 → `INSERT` 多寫 `from_plan`。`createOnlineSingleForBooking` 不動。

- [ ] **Step 4: 跑測試確認通過，並確認既有方案測試沒壞**

Run: `node tests/package-from-plan.test.js && rm -f data/app.db data/app.db-wal data/app.db-shm && node tests/package-service.test.js && node tests/package-discount.test.js && node tests/package-old-first.test.js && node tests/package-unit-price.test.js`
Expected: 全部 ✓，結束碼 0。

- [ ] **Step 5: 接進 `npm test`、Commit**

`package.json` 的 `test` 鏈最後加 ` && node tests/package-from-plan.test.js`。

```bash
git add src/services/packageService.js tests/package-from-plan.test.js package.json
git commit -m "feat(packages): 開方案可帶 fromPlan，照價目表核價並記下開立方式"
```

---

### Task 4: 路由

**Files:**
- Modify: `src/server.js`（匯入、兩條新路由、`POST /api/coach/packages` 多傳 `fromPlan`）
- Create: `tests/package-plan-api.test.js`
- Modify: `package.json`（`test:api` 鏈最後接上）

**Interfaces:**
- Consumes：`getPlanTable`、`replacePlanTable`（Task 2）；`createPackage` 的 `fromPlan`（Task 3）；現有的 `requireCoach`、`requireAdmin`、`asyncHandler`。
- Produces（Task 6、7 的前端使用）：
  - `GET /api/coach/package-plans`（`requireCoach`）→ `{ version, plans }`
  - `PUT /api/admin/package-plans`（`requireAdmin`）內文 `{ version, plans }` → `{ version, plans }`
  - `POST /api/coach/packages` 內文多收 `fromPlan`，原樣傳給 `createPackage`

- [ ] **Step 1: 寫失敗的測試** `tests/package-plan-api.test.js`

需要跑著的伺服器與種子管理者（照 `tests/package-api.test.js`、`tests/package-unit-price-api.test.js` 的寫法：`BASE` 環境變數、`req()` 小工具、直接用 `db` 塞資料、非管理者教練用 `auth_sessions` 塞一個 token）。開頭與結尾都要清掉自己建的資料（`users.email LIKE 'ppapi-%'` 的方案、登入紀錄、使用者）並把價目表還原成空的（用 API 存一份空陣列）。要驗的項目：

```
未登入：GET → 401；PUT → 401
非管理者教練：GET → 200 且回 { version, plans }；PUT → 403，error = 'admin_only'
管理者 PUT { version, plans: [1on1 10 堂 1400、1on2 10 堂 1900] } → 200；接著 GET 的 plans 與版本和 PUT 回傳相同
拿舊版本再 PUT → 409，error = 'plans_changed'；GET 的內容不變
PUT 不帶內文 → 409 plans_changed
PUT 版本正確但有一筆單價是 0 → 400，error = 'invalid_unit_price'；GET 的內容不變
POST /api/coach/packages { fromPlan: true, sessionType: '1on1', totalSessions: 10, amount: 14000 } → 201，from_plan = 1、amount = 14000
同上但 amount: 15000 → 409，error = 'plan_price_changed'
同上但 totalSessions: 20、amount: 28000 → 409，error = 'plan_not_available'
POST { fromPlan: false, totalSessions: 8, amount: 12000 } → 201，from_plan = 0
POST 不帶 fromPlan → 201，from_plan = null
非管理者教練 POST { fromPlan: true, … 14000 } → 201（教練可以照價目表開方案）
```

- [ ] **Step 2: 起伺服器、跑測試確認失敗**

```bash
rm -f data/app.db data/app.db-wal data/app.db-shm && npm run seed
PORT=3100 LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 npm start   # 背景執行
BASE=http://localhost:3100 node tests/package-plan-api.test.js
```
Expected: 新路由回 404，多個 ✗。

- [ ] **Step 3: 改 `src/server.js`**

匯入 `getPlanTable as svcGetPlanTable, replacePlanTable as svcReplacePlanTable`。兩條新路由放在「方案（套餐）」那一區、`POST /api/coach/packages` 附近：`GET` 直接回 `svcGetPlanTable()`；`PUT` 從 `req.body || {}` 取 `version`、`plans` 傳給 `svcReplacePlanTable`。`POST /api/coach/packages` 解構多取 `fromPlan` 並傳下去。

- [ ] **Step 4: 重啟伺服器、跑測試確認通過**

重啟後 Run: `BASE=http://localhost:3100 node tests/package-plan-api.test.js && BASE=http://localhost:3100 node tests/package-api.test.js && BASE=http://localhost:3100 node tests/package-discount-api.test.js`
Expected: 全部 ✓。做完關掉伺服器。

- [ ] **Step 5: 接進 `test:api`、Commit**

`package.json` 的 `test:api` 鏈最後加 ` && node tests/package-plan-api.test.js`。

```bash
git add src/server.js tests/package-plan-api.test.js package.json
git commit -m "feat(api): 套裝方案價目表端點，開方案接受 fromPlan"
```

---

### Task 5: 共用選法模組 `package-plan-picker.js`

**Files:**
- Create: `public/package-plan-picker.js`
- Modify: `public/style.css`（檔尾新增 `.pp-*` 樣式；`admin.html` 與 `coach.html` 都載入這份樣式表）
- Create: `tests/package-plan-picker.test.js`
- Modify: `package.json`（`test` 鏈最後接上）

**Interfaces:**
- 這個檔案不匯入任何模組，匯入時不碰 `document`／`window`（node 才能直接匯入測試）。
- Produces（Task 7 使用）：

```js
// 純邏輯
// state：{ sessionType: '1on1'|'1on2', choice: null | number | 'custom', customTotal: string, customUnit: string }
export function optionsForType(plans, sessionType)   // → [{ totalSessions, unitPrice }]，堂數小到大
export function initialState(plans)                   // → state；sessionType '1on1'；該類型有套裝 → choice null，沒有 → 'custom'
export function withType(state, plans, sessionType)   // → 新 state：choice 是 'custom' 就維持（輸入保留）；否則新類型有套裝 → null、沒有 → 'custom'
export function withPlans(state, plans)               // → 新 state（價目表重取後）：'custom' 維持；否則一律清成 null；該類型沒有套裝 → 'custom'
export function selectionOf(state, plans)             // → { ok: false, message } | { ok: true, sessionType, totalSessions, unitPrice, fromPlan }
export function calcTextOf(state, plans, hasDiscount) // → string
export function packageFields(sel)                    // → { sessionType, totalSessions, amount }，fromPlan 不是 undefined 時多帶 fromPlan

// 畫面
export function mountPlanPicker(container, { plans, hasDiscount, onChange })
//   hasDiscount: () => boolean（外面的折扣碼下拉目前有沒有選）；onChange: () => void（選取或輸入改變後呼叫）
//   → { selection(): 同 selectionOf, refresh(): 重畫試算文字, setPlans(plans): 換價目表並重畫 }
```

`selectionOf` 的規則：
- `choice === null` → `{ ok: false, message: '請先選堂數' }`
- `choice` 是數字：在 `optionsForType` 裡找到 → `{ ok: true, …, unitPrice, fromPlan: true }`；找不到 → 同 `choice === null`
- `choice === 'custom'`：堂數不是正整數 → `'請填正確堂數'`；單價不是空字串且不是 0 以上整數 → `'單價需為 0 以上整數'`；通過 → `unitPrice` 是數字或 `null`（留空），`fromPlan` 在 `plans.length > 0` 時是 `false`、否則 `undefined`

`calcTextOf`（文字與現有表單逐字相同）：
- 選了套裝，或自訂且堂數、單價都有效：`` `${堂數} 堂 × NT$${單價千分位} ＝ 總額 NT$${總額千分位}` ``，`hasDiscount` 為真時後面接 `（套用折扣碼後以折後總額入帳）`。千分位用 `toLocaleString('zh-TW')`。
- 自訂且單價留空：`未填單價 → 建立為「無單價」方案`
- 其他：空字串

`packageFields`：`amount` 是 `unitPrice === null ? null : unitPrice * totalSessions`。

- [ ] **Step 1: 寫失敗的測試** `tests/package-plan-picker.test.js`

```js
// 「新增方案」選法的純邏輯（public/package-plan-picker.js，不需要瀏覽器）。
import assert from 'node:assert/strict';
const pp = await import('../public/package-plan-picker.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-picker test] start');

const plans = [
  { sessionType: '1on1', totalSessions: 20, unitPrice: 1300 },
  { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 },
  { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 },
];
const only1on1 = plans.filter((p) => p.sessionType === '1on1');

expect('optionsForType：只給該類型、堂數小到大', () => {
  assert.deepEqual(pp.optionsForType(plans, '1on1'), [{ totalSessions: 10, unitPrice: 1400 }, { totalSessions: 20, unitPrice: 1300 }]);
  assert.deepEqual(pp.optionsForType(only1on1, '1on2'), []);
});
expect('initialState：一對一、堂數不預選；一對一沒有套裝時直接是自訂', () => {
  assert.deepEqual(pp.initialState(plans), { sessionType: '1on1', choice: null, customTotal: '', customUnit: '' });
  assert.equal(pp.initialState([plans[2]]).choice, 'custom');
});
expect('沒選堂數 → 請先選堂數', () => {
  assert.deepEqual(pp.selectionOf(pp.initialState(plans), plans), { ok: false, message: '請先選堂數' });
});
expect('選套裝 → 帶價目表的單價、fromPlan true', () => {
  const s = { ...pp.initialState(plans), choice: 10 };
  assert.deepEqual(pp.selectionOf(s, plans), { ok: true, sessionType: '1on1', totalSessions: 10, unitPrice: 1400, fromPlan: true });
  assert.deepEqual(pp.packageFields(pp.selectionOf(s, plans)), { sessionType: '1on1', totalSessions: 10, amount: 14000, fromPlan: true });
});
expect('切換類型：原本選套裝 → 清掉；新類型沒有套裝 → 自訂', () => {
  const s = { ...pp.initialState(plans), choice: 10 };
  assert.equal(pp.withType(s, plans, '1on2').choice, null);
  assert.equal(pp.withType(s, plans, '1on2').sessionType, '1on2');
  assert.equal(pp.withType(s, only1on1, '1on2').choice, 'custom');
});
expect('切換類型：原本是自訂 → 維持自訂、輸入保留', () => {
  const s = { sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '1500' };
  assert.deepEqual(pp.withType(s, plans, '1on2'), { sessionType: '1on2', choice: 'custom', customTotal: '8', customUnit: '1500' });
});
expect('自訂：有效 → fromPlan false；單價留空 → unitPrice null、amount null', () => {
  const s = { sessionType: '1on2', choice: 'custom', customTotal: '8', customUnit: '1500' };
  assert.deepEqual(pp.selectionOf(s, plans), { ok: true, sessionType: '1on2', totalSessions: 8, unitPrice: 1500, fromPlan: false });
  const blank = pp.selectionOf({ ...s, customUnit: '' }, plans);
  assert.equal(blank.unitPrice, null);
  assert.deepEqual(pp.packageFields(blank), { sessionType: '1on2', totalSessions: 8, amount: null, fromPlan: false });
  assert.equal(pp.selectionOf({ ...s, customUnit: '0' }, plans).unitPrice, 0);
});
expect('自訂：堂數或單價不合格', () => {
  const s = { sessionType: '1on1', choice: 'custom', customTotal: '', customUnit: '' };
  for (const t of ['', '0', '-1', '1.5', 'abc']) assert.deepEqual(pp.selectionOf({ ...s, customTotal: t }, plans), { ok: false, message: '請填正確堂數' });
  for (const u of ['-1', '1.5', 'abc']) assert.deepEqual(pp.selectionOf({ ...s, customTotal: '8', customUnit: u }, plans), { ok: false, message: '單價需為 0 以上整數' });
});
expect('價目表是空的時候選自訂 → 不帶 fromPlan', () => {
  const sel = pp.selectionOf({ sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '1500' }, []);
  assert.equal(sel.fromPlan, undefined);
  assert.deepEqual(pp.packageFields(sel), { sessionType: '1on1', totalSessions: 8, amount: 12000 });
});
expect('withPlans：選過的套裝一律清掉；自訂維持；該類型沒有套裝了 → 自訂', () => {
  const chosen = { ...pp.initialState(plans), choice: 10 };
  assert.equal(pp.withPlans(chosen, plans).choice, null);
  assert.equal(pp.withPlans(chosen, [plans[2]]).choice, 'custom');
  const custom = { sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '' };
  assert.deepEqual(pp.withPlans(custom, plans), custom);
});
expect('選的套裝已不在價目表上 → 視同沒選', () => {
  assert.deepEqual(pp.selectionOf({ ...pp.initialState(plans), choice: 30 }, plans), { ok: false, message: '請先選堂數' });
});
expect('calcTextOf：文字與現有表單相同', () => {
  const chosen = { ...pp.initialState(plans), choice: 10 };
  assert.equal(pp.calcTextOf(chosen, plans, false), '10 堂 × NT$1,400 ＝ 總額 NT$14,000');
  assert.equal(pp.calcTextOf(chosen, plans, true), '10 堂 × NT$1,400 ＝ 總額 NT$14,000（套用折扣碼後以折後總額入帳）');
  assert.equal(pp.calcTextOf(pp.initialState(plans), plans, false), '');
  const custom = { sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '1500' };
  assert.equal(pp.calcTextOf(custom, plans, false), '8 堂 × NT$1,500 ＝ 總額 NT$12,000');
  assert.equal(pp.calcTextOf({ ...custom, customUnit: '' }, plans, false), '未填單價 → 建立為「無單價」方案');
  assert.equal(pp.calcTextOf({ ...custom, customTotal: '' }, plans, false), '');
});
console.log('[package-plan-picker test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node tests/package-plan-picker.test.js`
Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 實作純邏輯，跑測試到全過**

Run: `node tests/package-plan-picker.test.js`
Expected: 全部 ✓。

- [ ] **Step 4: 實作 `mountPlanPicker` 與樣式**

畫進 `container` 的結構（由上到下）：小標「類型」→ 兩顆並排按鈕「一對一」「一對二」→ 小標「堂數」→ 一排選項（每顆 `${n} 堂`，最後一顆「自訂」）→ 自訂輸入區（「堂數」「每堂單價（可空）」兩個 `.form-input`，`type="number"`、`inputmode="numeric"`，只在選自訂時顯示）→ 試算文字。

- 按鈕都是 `<button type="button">`；兩組各自 `role="radiogroup"`＋`aria-label`，每顆 `role="radio"`＋`aria-checked`。
- 選取樣式（照畫布 C）：未選 `border: 1px solid #d1d5db; background: #fff; color: #475569; font-weight: 700`；已選 `border-color: transparent; background: #f0f9ff; box-shadow: inset 0 0 0 2px #0ea5e9; color: #0c4a6e; font-weight: 900`。高度至少 44px、圓角 8px、字 15px、Archivo＋tabular-nums。類型兩顆平分寬度；堂數選項 `flex-wrap`、間距 6–8px。鍵盤焦點用全站的 focus ring（`0 0 0 3px rgba(56,189,248,0.15)`）。
- 小標沿用 13px／600 的表單標籤樣式；試算文字 12px、`#64748b`。
- 類別一律 `pp-` 開頭，寫在 `public/style.css` 檔尾，不改既有規則。
- 事件：點類型 → `withType`；點選項 → 改 `choice`；自訂輸入 → 改 `customTotal`／`customUnit`；每次都重畫並呼叫 `onChange()`。重畫時不要讓正在輸入的自訂欄位失去焦點（只更新需要變的部分，或重畫後還原焦點與游標）。
- `setPlans(plans)` → `withPlans` 後重畫。

- [ ] **Step 5: 接進 `npm test`、Commit**

`package.json` 的 `test` 鏈最後加 ` && node tests/package-plan-picker.test.js`。
Run: `node tests/package-plan-picker.test.js`（全 ✓）。畫面部分在 Task 7 接上後才看得到，這個 task 不必開瀏覽器。

```bash
git add public/package-plan-picker.js public/style.css tests/package-plan-picker.test.js package.json
git commit -m "feat(ui): 新增方案的共用選法模組（類型／堂數／自訂）"
```

---

### Task 6: 後台「方案」頁籤

**Files:**
- Create: `public/package-plan-table.js`（價目表編輯的純邏輯，不匯入任何模組、匯入時不碰 `document`）
- Create: `tests/package-plan-table.test.js`
- Modify: `public/admin.html`（頁籤按鈕、`#apanel-plans` 面板、inline CSS 新增 `.pl-*`）
- Modify: `public/admin.js`（載入、繪製、新增列、儲存、衝突處理、頁籤切換時重取）
- Modify: `package.json`（`test` 鏈最後接上）

**Interfaces:**
- Consumes：`GET /api/coach/package-plans`、`PUT /api/admin/package-plans`（Task 4）。
- Produces：

```js
// public/package-plan-table.js
// row：{ total: number|string, isNew: boolean, p1on1: string, p1on2: string }（已儲存的列 total 是數字；新增的列是輸入框裡的字串）
export function parseAmount(text)     // '' 或全空白 → null；'1,400'、' 1400 '、'１４００' → 1400；其他（小數、負號、文字）→ NaN
export function rowsFromPlans(plans)  // → row[]，堂數小到大，isNew false，價格字串帶千分位（'1,400'），沒有的組合是 ''
export function plansFromRows(rows)   // → { ok: true, plans } | { ok: false, rowIndex, field: 'total'|'1on1'|'1on2', message }
```

`plansFromRows` 依列的順序檢查，遇到第一個錯就回傳：
- 新增的列堂數與兩個價格都空白 → 略過這一列。
- 新增的列有價格但堂數空白 → `field: 'total'`、`'請先填堂數'`。
- 堂數（`parseAmount` 後）不是 1–200 的整數 → `field: 'total'`、`'堂數要填 1–200 的整數'`。
- 堂數與前面某一列相同 → 後面那列 `field: 'total'`、`'這個堂數已經有了'`。
- 價格不是空白且不是 1–1,000,000 的整數 → 該格（`'1on1'` 或 `'1on2'`）、`'每堂單價要填 1–1,000,000 的整數'`。
- 全部通過 → `plans` 只含有價格的組合，依堂數小到大、同堂數 `'1on1'` 在前。組合超過 60 → `rowIndex: -1`、`field: 'total'`、`'最多 60 個組合'`。

- [ ] **Step 1: 寫失敗的測試** `tests/package-plan-table.test.js`

```js
// 價目表編輯的純邏輯（public/package-plan-table.js，不需要瀏覽器）。
import assert from 'node:assert/strict';
const pt = await import('../public/package-plan-table.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-table test] start');

const plans = [
  { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 },
  { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 },
  { sessionType: '1on1', totalSessions: 30, unitPrice: 1200 },
];

expect('parseAmount：空白 → null；千分位、前後空白、全形數字都認', () => {
  assert.equal(pt.parseAmount(''), null);
  assert.equal(pt.parseAmount('   '), null);
  assert.equal(pt.parseAmount('1,400'), 1400);
  assert.equal(pt.parseAmount(' 1400 '), 1400);
  assert.equal(pt.parseAmount('１４００'), 1400);
  assert.equal(pt.parseAmount('0'), 0);
});
expect('parseAmount：小數、負號、文字 → NaN', () => {
  for (const t of ['14.5', '-5', 'abc', '1e3', '１４００元']) assert.ok(Number.isNaN(pt.parseAmount(t)), t);
});
expect('rowsFromPlans：一列一種堂數、小到大、價格帶千分位、沒有的組合留空', () => {
  assert.deepEqual(pt.rowsFromPlans(plans), [
    { total: 10, isNew: false, p1on1: '1,400', p1on2: '1,900' },
    { total: 30, isNew: false, p1on1: '1,200', p1on2: '' },
  ]);
  assert.deepEqual(pt.rowsFromPlans([]), []);
});
expect('plansFromRows：來回一致', () => {
  assert.deepEqual(pt.plansFromRows(pt.rowsFromPlans(plans)), { ok: true, plans: [plans[0], plans[1], plans[2]] });
});
expect('清空一格 → 那個組合不在結果裡；清空一整列 → 那個堂數不在結果裡', () => {
  const rows = pt.rowsFromPlans(plans);
  rows[0].p1on2 = '';
  rows[1].p1on1 = '';
  assert.deepEqual(pt.plansFromRows(rows), { ok: true, plans: [plans[0]] });
});
expect('新增一列：填了堂數與價格 → 併入並排序', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: ' 20 ', isNew: true, p1on1: '1300', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows).plans.map((p) => `${p.sessionType}:${p.totalSessions}:${p.unitPrice}`),
    ['1on1:10:1400', '1on2:10:1900', '1on1:20:1300', '1on1:30:1200']);
});
expect('新增的列全空白 → 略過；只填堂數沒填價格 → 沒有組合', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: '', isNew: true, p1on1: '', p1on2: '' }, { total: '50', isNew: true, p1on1: '', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows), { ok: true, plans });
});
expect('新增的列有價格沒堂數 → 請先填堂數', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: '', isNew: true, p1on1: '1300', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 2, field: 'total', message: '請先填堂數' });
});
expect('堂數不合格', () => {
  for (const t of ['0', '201', '1.5', 'abc']) {
    const rows = [{ total: t, isNew: true, p1on1: '1300', p1on2: '' }];
    assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 0, field: 'total', message: '堂數要填 1–200 的整數' });
  }
});
expect('堂數重複 → 指到後面那一列', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: '10', isNew: true, p1on1: '', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 2, field: 'total', message: '這個堂數已經有了' });
});
expect('價格不合格 → 指到那一格', () => {
  const rows = pt.rowsFromPlans(plans);
  rows[1].p1on2 = '0';
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 1, field: '1on2', message: '每堂單價要填 1–1,000,000 的整數' });
  rows[1].p1on2 = '';
  rows[0].p1on1 = '1000001';
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 0, field: '1on1', message: '每堂單價要填 1–1,000,000 的整數' });
  rows[0].p1on1 = '一千';
  assert.equal(pt.plansFromRows(rows).field, '1on1');
});
expect('邊界值可以：堂數 1 與 200、單價 1 與 1,000,000', () => {
  const rows = [{ total: '1', isNew: true, p1on1: '1', p1on2: '' }, { total: '200', isNew: true, p1on1: '', p1on2: '1,000,000' }];
  assert.deepEqual(pt.plansFromRows(rows).plans, [
    { sessionType: '1on1', totalSessions: 1, unitPrice: 1 }, { sessionType: '1on2', totalSessions: 200, unitPrice: 1000000 }]);
});
expect('超過 60 個組合 → 最多 60 個組合', () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ total: String(i + 1), isNew: true, p1on1: '1000', p1on2: '1000' }));
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: -1, field: 'total', message: '最多 60 個組合' });
});
console.log('[package-plan-table test] done');
```

- [ ] **Step 2: 跑測試確認失敗 → 實作 `public/package-plan-table.js` → 跑到全過**

Run: `node tests/package-plan-table.test.js`
Expected: 先 `ERR_MODULE_NOT_FOUND`，實作後全部 ✓。

- [ ] **Step 3: `public/admin.html`**

- 頁籤列在「會員」按鈕後面加 `<button data-atab="plans" class="tab" style="white-space:nowrap;">方案</button>`。
- 在 `#apanel-members` 面板結束之後、`#apanel-discounts` 之前加面板 `<div id="apanel-plans" class="tab-panel hidden">`，內容由上到下：
  1. `.a-sec-head`：標題「套裝方案價目表」＋`.a-sec-line`。
  2. 說明（`.subtle`）：`直接在格子裡打每堂單價，總價自動算。有填價格的組合，才會出現在會員的「新增方案」。`
  3. 衝突提示 `#plans-conflict`（預設 `hidden`，`role="alert"`）：文字 `價目表已經在別的地方被改過，請重新載入後再修改。`＋按鈕 `#plans-reload`「重新載入」。
  4. 表格容器 `#plans-table`。
  5. 動作列：`#plans-add-row`「＋ 新增堂數」（`.btn.btn-ghost`）、`#plans-save`「儲存價目表」（`.btn.btn-primary`）、`#plans-dirty`「有未儲存的變更」（`.subtle`，預設 `hidden`）。
  6. 說明（12px）：`價格留空＝不提供這個組合；一整列都留空再儲存，這個堂數就會移除。改價只影響之後新開的方案，已經開給會員的不會變。`
- 樣式 `.pl-*` 加在 `admin.html` 的 inline `<style>`（後台專用樣式都放這裡）。表格照畫布 C：三欄格線 `150px minmax(0,1fr) minmax(0,1fr)`（手機 `58px minmax(0,1fr) minmax(0,1fr)`）、髮絲線分隔、表頭「堂數／一對一／一對二」；堂數用 Archivo 大字＋小字「堂」；每個價格格子是「NT$」前綴＋輸入框（`type="text"`、`inputmode="numeric"`、字級 16px、Archivo 800、`aria-label` 如「一對一 10 堂的每堂單價」、placeholder `留空＝不提供`），下方小字 `共 NT$14,000` 或 `不提供`。錯誤的格子加 `aria-invalid="true"` 與紅色邊框。390px 寬不得出現橫向捲動。

- [ ] **Step 4: `public/admin.js`**

從 `/package-plan-table.js` 匯入三個函式。新增：

```js
let planTable = { version: '0', plans: [] };  // 伺服器最後一次回的內容
let planRows = [];                             // 畫面上的列（row 見 package-plan-table.js）
let plansDirty = false;
let plansSaving = false;
async function loadPackagePlans()   // GET → 更新三個狀態 → renderPackagePlans()；失敗用 toast 顯示、表格位置顯示載入失敗
function renderPackagePlans()       // 依 planRows 重畫 #plans-table；沒有任何列 → .empty-state「還沒有套裝方案。按「＋ 新增堂數」開始建立。」
async function savePackagePlans()   // plansFromRows → 錯誤就 toast(message, 'error')、標出並聚焦那一格；通過就 PUT
```

行為：
- 開機時在既有的 `load…()` 清單加上 `loadPackagePlans()`。
- 輸入時即時更新該格下方的「共 NT$…／不提供」，設 `plansDirty = true` 並顯示 `#plans-dirty`。更新小字不要重畫整張表（輸入中的格子不能失焦）。
- 「＋ 新增堂數」：`planRows` 加 `{ total: '', isNew: true, p1on1: '', p1on2: '' }`，重畫後聚焦新列的堂數輸入框（`type="text"`、`inputmode="numeric"`、placeholder `堂數`）。已儲存的列堂數是文字。
- 儲存中 `plansSaving` 為真時，`#plans-save` 設 `disabled`，再點不送出。
- `PUT` 成功：用回傳更新 `planTable`、`planRows = rowsFromPlans(plans)`、`plansDirty = false`、隱藏 `#plans-dirty` 與 `#plans-conflict`、`toast('價目表已儲存', 'success')`、重畫。
- `PUT` 回 `plans_changed`（`e.data?.error`）：顯示 `#plans-conflict`，不改畫面上的輸入。「重新載入」→ `loadPackagePlans()`（會清掉未儲存的修改並隱藏提示）。
- 其他錯誤：`toast` 顯示（伺服器的 400 錯誤碼對應到與 `plansFromRows` 相同的中文訊息；其餘 `失敗：${e.message}`）。
- 頁籤切換的監聽器裡：切到 `plans` 且 `!plansDirty` 時呼叫 `loadPackagePlans()`。

- [ ] **Step 5: 接進 `npm test`，本機實際操作**

`package.json` 的 `test` 鏈最後加 ` && node tests/package-plan-table.test.js`。照 Global Constraints 起本機預覽，用 Playwright 以管理者登入 `/admin.html`，在 1280px 與 390px 各做一次並截圖：點「方案」頁籤 → 空狀態 → 新增堂數 10、填 1,400／1,900 → 儲存 → 重新整理後內容還在 → 清空一格再儲存，該格顯示「不提供」→ 新增一列填重複的堂數，儲存被擋、那一格被標出 → 清空一整列再儲存，那一列消失。另開第二個頁面模擬舊視窗：第一頁改價儲存後，第二頁（未重新整理）改另一格再儲存 → 出現衝突提示、第一頁存的價格還在；按「重新載入」後看到最新內容。確認 `page.on('pageerror')` 沒有任何錯誤、390px 沒有橫向捲動。截圖路徑寫進回報。

- [ ] **Step 6: Commit**

```bash
git add public/package-plan-table.js tests/package-plan-table.test.js public/admin.html public/admin.js package.json
git commit -m "feat(admin): 「方案」頁籤——套裝方案價目表"
```

---

### Task 7: 兩個「新增方案」入口接上選法

**Files:**
- Modify: `public/admin.js`（`renderMemberPackages` 的「＋ 新增方案」）
- Modify: `public/coach.js`（`loadRegmPackages`、`regmNewPkgFormHtml`、`bindRegmNewPkgForm`）
- Modify: `public/style.css`（只在需要讓選法在兩欄格線裡佔滿整列時加規則）

**Interfaces:**
- Consumes：`mountPlanPicker`、`packageFields`（Task 5，`admin.js` 從 `/package-plan-picker.js`、`coach.js` 從 `./package-plan-picker.js` 匯入）；`GET /api/coach/package-plans`、`POST /api/coach/packages` 的 `fromPlan`（Task 4）。

兩個入口同一套規則：

- 取價目表：`api('/api/coach/package-plans')` 取 `.plans`；失敗一律當成空陣列（不擋開方案、不跳錯誤）。後台：`renderMemberPackages` 每次執行時與會員方案清單一起取。教練彈窗：`loadRegmPackages` 每次執行時一起取，存在模組層變數（例如 `regmPlans`）。
- **價目表是空的**：表單的 HTML、欄位 id、事件、送出內容與改動前完全相同（不帶 `fromPlan`）。把現有程式原封不動留在這個分支裡。
- **價目表有內容**：表單由上到下是 選法（`mountPlanPicker` 畫進一個容器，試算文字在選法裡面）→ 到期日與折扣碼並排 → 備註（只有後台有）→「建立方案」。到期日、折扣碼、備註、按鈕沿用原本的 id 與類別（後台 `pkg-expiry`／`pkg-discount`／`pkg-note`／`pkg-create`；教練彈窗 `regm-np-expiry`／`regm-np-discount`／`regm-np-create`）。這個分支不再有原本的類型下拉、堂數、單價輸入框與外層的試算文字元素。
- 折扣碼下拉改變時呼叫選法的 `refresh()`；`hasDiscount` 回傳下拉目前有沒有值。
- 按「建立方案」：`selection()` 不 ok → `toast(message, 'error')`；ok → 送 `{ memberId, ...packageFields(sel), expiresAt, discountCode }`（後台多帶 `note`）。請求進行中按鈕設 `disabled`、結束後恢復（兩個分支都要，避免連點開出兩筆）。
- 成功：與改動前相同（後台 `toast('方案已建立', 'success')` 後重畫會員方案區；教練彈窗 `toast` 後呼叫 `onCreated(pkg)`）。
- 伺服器回 `plan_price_changed` 或 `plan_not_available`：`toast('價目表剛更新過，請重新選擇', 'error')`，重新取價目表；新的價目表有內容 → 選法 `setPlans(plans)`（到期日、折扣碼、備註保留）；變成空的 → 整個表單重畫成舊表單。
- 其他錯誤訊息照各入口原本的處理。

- [ ] **Step 1: 改 `public/admin.js`**

- [ ] **Step 2: 改 `public/coach.js`**

`renderRegmPicked` 裡兩處用到表單的地方（客人沒有可用方案時直接出現；有方案時在 `#regm-np-box` 裡）都要是同一套。`.regm-newpkg` 是兩欄格線：選法容器要佔滿整列（`grid-column: 1 / -1`）。

- [ ] **Step 3: 本機實際操作（1280px 與 390px 各一次，截圖）**

照 Global Constraints 起本機預覽。教練頁需要一位啟用中的教練：種子管理者沒有啟用的教練檔案時，直接在本機資料庫把它設成啟用（或新增一筆 `coaches`）。逐項確認：

後台會員彈窗（`/admin.html` →「會員」→ 長按或點開一位會員 →「＋ 新增方案」）：
1. 價目表為空：表單與改動前相同（類型下拉、堂數、每堂單價（可空）、到期日、備註、折扣碼、試算文字、建立方案）；照舊開出一筆方案，資料庫裡 `from_plan` 是 `NULL`。
2. 用 API 或「方案」頁籤存入一對一 10／20 堂、一對二 10 堂後重開彈窗：出現類型兩顆按鈕與堂數選項，沒有任何一顆堂數被選；直接按建立 → 「請先選堂數」。
3. 點「10 堂」→ 試算「10 堂 × NT$1,400 ＝ 總額 NT$14,000」；選折扣碼後文字多出括號那段；建立成功，`from_plan = 1`、金額正確。
4. 點「自訂」→ 出現堂數與每堂單價輸入框；填 8、1500 建立 → `from_plan = 0`；單價留空 → 建立「無單價」方案。
5. 切到「一對二」→ 選項換成一對二的；切到沒有套裝的類型時只剩「自訂」且已選上。
6. 停在選了「10 堂」的畫面，另外用 API 把一對一 10 堂改成 1,500，再按建立 → 「價目表剛更新過，請重新選擇」、沒有開出方案、選項已更新且沒有任何一顆被選、到期日與備註還在。

教練登錄彈窗（`/coach.html` →「登錄預約」→ 點一個時段 → 選客人）：同樣的 1–6（沒有備註欄）；客人沒有可用方案、與有方案時按「＋ 新增方案」兩種進入方式都要看。另外以非管理者的教練身分登入做一次第 3 項。

確認 `pageerror` 為 0、390px 沒有橫向捲動。截圖路徑寫進回報。

- [ ] **Step 4: 跑整套測試**

Run: `rm -f data/app.db data/app.db-wal data/app.db-shm && npm test > /tmp/pp-t7.log 2>&1; echo "exit=$?"; grep -c '✓' /tmp/pp-t7.log; grep -c '✗' /tmp/pp-t7.log`
Expected: `exit=0`、✗ 為 0、✓ 比基準的 1107 多（新增的五個測試檔）。

- [ ] **Step 5: Commit**

```bash
git add public/admin.js public/coach.js public/style.css
git commit -m "feat(ui): 新增方案改成先選套裝，保留自訂"
```

---

## 收尾（主控執行，不派工）

1. 整個分支的最後審查（對照規格與本計畫）。
2. 全新資料庫跑 `npm test`，與基準比對；起伺服器逐檔跑方案相關的 API 測試（`package-plan-api`、`package-api`、`package-discount-api`、`package-unit-price-api`、`online-single-api`、`coach-register-api`、`coach-add-customer-api`），與 main 逐檔比對。
3. 自己在瀏覽器把規格「測試」一節的前端清單走一遍（1280px 與 390px）。
4. 推上分支、開 draft PR、準備本機預覽給業主看。業主說 merge 才合併。
