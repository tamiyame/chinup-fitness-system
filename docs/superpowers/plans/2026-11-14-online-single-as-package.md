# 線上單堂轉方案（第一階段） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客人線上自己預約的一對一／一對二單堂課，每一筆都有一張「一堂的方案」：新預約自動建立、舊資料開機時一次補齊，後台會員方案區看得到單堂卡，取消／退款／改掛／薪資／續購提醒／舊方案先用都依規格處理。

**Architecture:** `customer_packages` 加 `source`（`staff`／`online`）區分來源；線上單堂方案是預約的鏡像（共 1 堂、剩 0 或 1）。建立與關閉集中在 `packageService.js` 兩個函式（線上預約與補登共用同一個建立函式）；取消時的分流集中在 `bookingService.js` 一個函式，八條取消路徑都改呼叫它。先把規則全部做完並用測試夾具驗證，最後才在 `createBookingAnon` 打開「自動建方案」，中間每個 task 的全套測試都維持綠燈。

**Tech Stack:** Node ESM + node:sqlite、Express、vanilla JS 前端、plain-node assert 測試（`expect(label, fn)` 慣例）。

**Spec:** `docs/superpowers/specs/2026-11-14-online-single-as-package-design.md`（實作前先讀完；本計畫只寫規格沒有決定的事）

**範圍：** 只做規格的第一階段。第二階段（後台「方案」獨立頁籤）等版面選定後另排計畫，本計畫不碰。整個第一階段一張 PR。

## Global Constraints

- 欄位：`source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'online'))`；索引：`CREATE INDEX IF NOT EXISTS idx_bookings_package ON bookings(package_id)`（要在 `package_id` 欄位確定存在之後才建）。
- 線上單堂方案固定值：`total_sessions = 1`、`remaining_sessions` 只會是 0 或 1、`created_by`／`expires_at`／`note` 為 NULL、`amount`＝`original_amount − discount_amount`（`original_amount` 是 NULL → `amount` 也是 NULL；折到 0 元 → `amount` 是 0，不是 NULL）。
- 錯誤碼（HTTP 一律 409）與前端文字：
  - `package_closed`：「這堂已經退款或已作廢」
  - `credit_in_use`：「這堂已經改約，請對改約後的那一堂退款」
  - `paid_online_single`：「這堂線上預約已付款，不能直接改客人或方案。要改請先取消（會保留 1 堂），或由管理者退款。」
  - `has_active_booking`：「這堂還有未取消的預約，請先取消預約」
  - `online_single_readonly`：「線上單堂方案不能調整堂數或還原」
- 顯示文字：卡片狀態「已預約／已上完／保留 1 堂／已取消／已作廢」；付款狀態「待核對／已核對／已退款」；標記「線上單堂」；教練端來源「線上預約」或「線上預約 · 折扣碼 X」；取消確認加註「（已付款，會保留 1 堂可改約）」（教練開立的方案維持「（將回補 1 堂方案）」，未付款的線上單堂不加註）。
- 薪資明細來源：線上單堂仍是 `'walkin'`（散客）；金額算法 `max(0, original_amount − discount_amount)` 不動。
- `app_settings` 鍵：`online_single_backfill_done`（`'1'`）、`online_single_backfill_summary`（JSON：`{ created, members, at, snapshot }`）。
- 補登與任何新程式都不呼叫通知；補登不改預約的任何欄位（只寫 `package_id`）。
- `package_id` 為 NULL 的預約永遠要能正常取消、計薪、顯示，不能假設一定有方案。
- 不新增顏色、不新增資料表、不改線上預約的回傳內容與客人看到的畫面。
- 執行環境：Node 在 `/Users/ryansheu/.local/bin`，指令前加 `PATH=/Users/ryansheu/.local/bin:$PATH`。全套測試一律用暫存資料庫：`DB_PATH="$(mktemp -d)/t.db" npm test`，**絕不對 `data/app.db` 跑**；結果用 `grep -c '✓'`／`grep -c '✗'` 數。基準（`main` `9ccf4ad`）：992 ✓、0 ✗。
- 前端沒有單元測試：改完要實際開本機站，用 Playwright 點過才算驗證（`createRequire('/Users/ryansheu/.npm/_npx/5c6d8c4f680fcd0a/node_modules/')` 載入 `playwright`）；驗證腳本與截圖放在 worktree 以外的暫存資料夾，不進版控。本機站：`DB_PATH=<暫存> npm run seed` 後 `DB_PATH=<同一個> PORT=<自選> LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js`，用 seed 的本機管理者帳號登入。
- 註解、文案、commit 訊息都用繁體中文；commit 訊息結尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。每個 task 一個 commit，不直接動 `main`。

## Review Focus

規格沒有逐條寫、但實際使用最可能出事的五種情況；每一條都已在對應 task 加了測試。

1. 補登在開機時出錯（快照寫不出來、資料異常、程式丟例外）→ 伺服器仍要正常開機、資料一筆都不能寫到一半，下次開機再試。（Task 9）
2. 折扣碼把價格折到 0 元 → 方案金額要存 0，不能被當成「沒有金額」存成 NULL。（Task 1）
3. 一對二的同行客人取消還沒付款的線上預約 → 主客人那張單堂方案要一起作廢，不能留下可用的 1 堂。（Task 3）
4. 舊的循環散客整批退款時，其中一堂保留的 1 堂已經被改約 → 其餘照退、那一堂跳過並回報，不重複退、也不整批擋下。（Task 4）
5. 還沒付款的線上預約被教練改掛到別的方案 → 原本那張單堂方案名下沒有任何預約，會員方案區仍要正常顯示，不能壞掉。（Task 8、Task 10）

## 計畫裡補的判斷

規格「留給實作者決定」的項目，以及排計畫時多決定的事：

- 一張 PR，不拆兩張（規則與建立互相依賴；拆開只會多一輪預覽與合併）。
- 建立函式 `createOnlineSingleForBooking(bookingId)` 放 `packageService.js`，線上預約與補登共用。
- 取消分流放 `bookingService.js` 的 `settleCancelledBooking(b)`，取代現有的 `refundPackageForBooking(b)` 加 `releaseRedemption(...)`。
- 補登放 `src/services/onlineSingleBackfill.js`，`server.js` 在 `app.listen` 之前呼叫。函式不丟例外（開機不能因補登失敗而掛掉）。沒有任何要補的預約時不做快照，直接記完成。
- 快照檔名 `pre-online-single-YYYYMMDD-HHMMSS.db`，放在既有的備份資料夾。這個檔名不符合每週備份的命名，所以不會被輪替刪掉，也不會出現在後台備份清單。
- 整批退款遇到不能退的列（已作廢、已改約）：跳過並在回傳加 `skipped`，不整批擋下。
- 單堂卡的狀態 `single.state` 由後端算（可以寫測試），前端只負責對照文字。
- 預約被改掛走、名下沒有預約的線上單堂方案：卡片狀態「已取消」，內容寫「預約已改到其他方案」。
- 順序：規則先做、最後才打開自動建方案，讓每個 task 結束時全套測試都是綠的。

已知、這次不處理：客人已付款後自己取消，再自己上網重新預約，會產生一筆新的待核對單堂；原本保留的那 1 堂只能由教練在登錄預約時使用（規格規則 2、5 的結果）。管理者在會員方案區會同時看到「保留 1 堂」與新的單堂卡。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/db/schema.js` | `customer_packages` 的 `CREATE TABLE` 加 `source` |
| `src/db/connection.js` | 既有資料庫補 `source` 欄位、建 `idx_bookings_package` |
| `src/services/packageService.js` | 建立／關閉線上單堂方案、後台動作限制、改單價清折扣、客人端排除、`single` 資料、summary |
| `src/services/bookingService.js` | 取消分流、退款與改掛規則、線上預約掛上建立函式 |
| `src/services/payrollService.js`、`renewalReminderService.js`、`coachCalendarService.js` | 讀取端認得來源 |
| `src/services/backupService.js` | `runNamedSnapshot`（不被輪替的快照） |
| `src/services/onlineSingleBackfill.js`（新） | 一次性補登 |
| `src/server.js` | 開機呼叫補登、`GET /api/admin/packages/summary` |
| `public/admin.js` | 會員方案區單堂卡、退款／作廢、錯誤訊息 |
| `public/coach.js` | 來源文字、取消確認、下拉加註、改掛錯誤訊息 |
| `tests/online-single-migration.test.js`（新） | 既有資料庫升級後有欄位與索引 |
| `tests/online-single.test.js`（新） | 服務層全部規則，獨立暫存資料庫；Task 1–8 逐步往下加 |
| `tests/online-single-backfill.test.js`（新） | 補登，獨立暫存資料庫 |
| `tests/online-single-api.test.js`（新） | 走 HTTP 的整段流程（`test:api` 鏈） |
| `package.json` | 新測試加進 `test`／`test:api` |

---

### Task 1: 資料庫欄位與索引＋建立／關閉線上單堂方案

**Files:**
- Modify: `src/db/schema.js:220-233`、`src/db/connection.js:270-271`、`src/services/packageService.js`、`package.json`
- Create: `tests/online-single-migration.test.js`、`tests/online-single.test.js`

**Interfaces:**
- Produces（`packageService.js`）：
  - `createOnlineSingleForBooking(bookingId, { createdAt = nowLocal() } = {}) → number`（方案 id）。自己包 `tx()`（可巢狀）。找不到預約 → `ApiError(404, 'booking_not_found')`；預約已有方案 → `ApiError(409, 'booking_has_package')`。
  - `closeOnlineSinglePackage(packageId) → boolean`。不是線上單堂方案（或找不到）→ 不動、回 `false`；否則寫 `archived_at`（已作廢則不改時間）、釋放名下所有預約的折扣碼用量、回 `true`。不取消預約、不通知。
- Produces（測試夾具，`tests/online-single.test.js` 檔頭，後面每個 task 都用）：`member()`、`phoneOf(id)`、`nameOf(id)`、`coachId`、`coachUser`、`admin`、`slot()`、`pastSlot()`、`rawBooking(opts)`、`online(opts)`、`tenPack(memberId, opts)`、`register(memberId, packageId, startAt)`、`P(id)`、`B(id)`、`uses(bookingId)`、`throwsCode(fn, status, code)`。

- [ ] **Step 1: 寫升級測試 `tests/online-single-migration.test.js`**

先用 `new DatabaseSync(path, { enableForeignKeyConstraints: false })` 在暫存檔建一張「改動前」的 `customer_packages`（把目前 `schema.js:220-233` 的 DDL 原樣抄進測試）並插入一筆 `(member_id 1, '1on1', 10, 10)`，關閉後設 `process.env.DB_PATH` 再 `import('../src/db/connection.js')`。斷言：

```js
expect('既有資料表補上 source，舊資料預設 staff', () => {
  assert.ok(db.prepare('PRAGMA table_info(customer_packages)').all().some((c) => c.name === 'source'));
  assert.equal(db.prepare('SELECT source FROM customer_packages WHERE id = 1').get().source, 'staff');
});
expect('source 只接受 staff／online', () => {
  assert.throws(() => db.prepare("UPDATE customer_packages SET source = 'bogus' WHERE id = 1").run(), /CHECK/);
});
expect('bookings(package_id) 有索引', () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_bookings_package'").get());
});
```

- [ ] **Step 2: 建 `tests/online-single.test.js`，寫檔頭夾具與本 task 的測試**

```js
// 線上單堂方案：建立、取消、退款、改掛、後台動作限制、連動。
// 用獨立的暫存資料庫（不碰共用資料庫），不必清資料，全域查詢結果可預期。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `online-single-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
process.env.LINE_MOCK = '1'; process.env.GMAIL_MOCK = '1'; process.env.GCAL_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const pkg = await import('../src/services/packageService.js');
const bk = await import('../src/services/bookingService.js');
const { applyDiscountTx, createDiscountCode } = await import('../src/services/discountService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[online-single test] start');

const pad = (n, w = 2) => String(n).padStart(w, '0');
let seq = 0;
const member = () => { seq++; return Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?,?,'user',?)").run(`客${seq}`, `os-m${seq}@x.com`, `0966${pad(seq, 6)}`).lastInsertRowid); };
const phoneOf = (id) => db.prepare('SELECT phone FROM users WHERE id = ?').get(id).phone;
const nameOf = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id).name;
const coachUser = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('os教練','os-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'os教練', 1)").run(coachUser).lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('os管','os-a@x.com','coach',1)").run().lastInsertRowid);
// 不重複的整點（08–17 點）：未來從 40 天後起算、過去從 40 天前起算
let fN = 0, pN = 0;
const hourAt = (base, n) => { const d = new Date(base + Math.floor(n / 10) * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(8 + (n % 10))}:00:00`; };
const slot = () => hourAt(Date.now() + 40 * 86400000, fN++);
const pastSlot = () => hourAt(Date.now() - 40 * 86400000, pN++);
const endOf = (s) => `${s.slice(0, 11)}${pad(Number(s.slice(11, 13)) + 1)}:00:00`;
const P = (id) => db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(id);
const B = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
const uses = (bookingId) => db.prepare("SELECT COUNT(*) AS c FROM discount_redemptions WHERE kind = 'booking' AND ref_id = ?").get(bookingId).c;
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };

/** 沒有方案的預約（上線前舊資料的樣子）。回 booking id。 */
const rawBooking = ({ memberId = member(), startAt = slot(), type = '1on1', original = type === '1on2' ? 2000 : 1500, member2Id = null } = {}) =>
  Number(db.prepare('INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, member2_id) VALUES (?,?,?,?,?,?,?)')
    .run(coachId, memberId, startAt, endOf(startAt), type, original, member2Id).lastInsertRowid);
/** 線上預約落地後的樣子：一筆待核對預約＋一張線上單堂方案。code＝折扣碼（真的記一筆用量）；paid＝已核對。 */
const online = ({ code = null, paid = false, ...rest } = {}) => {
  const memberId = rest.memberId ?? member(); const startAt = rest.startAt ?? slot();
  const id = rawBooking({ ...rest, memberId, startAt });
  if (code) {
    const a = applyDiscountTx({ code, phone: phoneOf(memberId), subtotal: B(id).original_amount, kind: 'booking', refId: id, qty: 1 });
    db.prepare('UPDATE bookings SET discount_amount = ?, discount_code = ? WHERE id = ?').run(a.discountAmount, a.discountCode, id);
  }
  const packageId = pkg.createOnlineSingleForBooking(id);
  if (paid) bk.confirmBookingPayment({ bookingId: id, actorId: admin });
  return { id, packageId, memberId, startAt };
};
const tenPack = (memberId, opts = {}) => pkg.createPackage({ memberId, sessionType: '1on1', totalSessions: 10, amount: 15000, ...opts });
const register = (memberId, packageId, startAt = slot()) => bk.createCoachRegister({ coachId, memberId, packageId, startAt, actorId: admin }).created[0].id;
createDiscountCode({ code: 'OS100', discount_type: 'fixed', discount_value: 100 });
createDiscountCode({ code: 'OSFREE', discount_type: 'percent', discount_value: 100 });

// ── 建立／關閉 ──
expect('建立：方案欄位照規格、預約掛上方案、預約本身不變', () => {
  const m = member(); const o = online({ memberId: m, code: 'OS100' }); const p = P(o.packageId); const b = B(o.id);
  assert.deepEqual(
    [p.member_id, p.session_type, p.total_sessions, p.remaining_sessions, p.amount, p.discount_code, p.source, p.created_by, p.expires_at, p.note, p.archived_at],
    [m, '1on1', 1, 0, 1400, 'OS100', 'online', null, null, null, null]);
  assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual([b.package_id, b.original_amount, b.discount_amount, b.discount_code, b.paid_at], [o.packageId, 1500, 100, 'OS100', null]);
});
expect('建立：一對二只替主客人建一張', () => {
  const m = member(), mate = member(); const o = online({ memberId: m, type: '1on2', member2Id: mate });
  assert.deepEqual([P(o.packageId).session_type, P(o.packageId).amount], ['1on2', 2000]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM customer_packages WHERE member_id = ?').get(mate).c, 0);
});
expect('建立：沒有定價的舊預約 → 金額 NULL；折到 0 元 → 金額是 0', () => {
  assert.equal(P(online({ original: null }).packageId).amount, null);
  assert.equal(P(online({ code: 'OSFREE' }).packageId).amount, 0);
});
expect('建立：可指定建立時間（補登用）；已有方案不能再建；找不到預約', () => {
  const id = rawBooking();
  assert.equal(P(pkg.createOnlineSingleForBooking(id, { createdAt: '2026-03-01T10:30:00' })).created_at, '2026-03-01T10:30:00');
  throwsCode(() => pkg.createOnlineSingleForBooking(id), 409, 'booking_has_package');
  throwsCode(() => pkg.createOnlineSingleForBooking(99999999), 404, 'booking_not_found');
});
expect('剩 0 堂的線上單堂不算可用，不擋同類型的 10 堂方案', () => {
  const m = member(); const o = online({ memberId: m }); const ten = tenPack(m);
  assert.equal(pkg.getPackage(o.packageId).is_valid, false);
  assert.equal(pkg.getPackage(ten.id).use_first_id, null);
});
expect('關閉：寫作廢時間、釋放折扣碼用量、不取消預約、可重複呼叫；教練開立的方案不受影響', () => {
  const o = online({ code: 'OS100' }); assert.equal(uses(o.id), 1);
  assert.equal(pkg.closeOnlineSinglePackage(o.packageId), true);
  const at = P(o.packageId).archived_at; assert.ok(at);
  assert.deepEqual([uses(o.id), B(o.id).status], [0, 'confirmed']);
  pkg.closeOnlineSinglePackage(o.packageId); assert.equal(P(o.packageId).archived_at, at);
  const ten = tenPack(member());
  assert.equal(pkg.closeOnlineSinglePackage(ten.id), false); assert.equal(P(ten.id).archived_at, null);
  bk.cancelBookingAdmin({ bookingId: o.id, actorId: admin });   // 收尾：已作廢的方案名下不留未取消的預約（Task 7 的不變量會檢查）
});
```

- [ ] **Step 3: 跑兩個測試，確認失敗**

Run: `node tests/online-single-migration.test.js; node tests/online-single.test.js`
Expected: 第一個 ✗（沒有 `source` 欄位）；第二個丟 `pkg.createOnlineSingleForBooking is not a function`。

- [ ] **Step 4: 實作**

- `schema.js`：`customer_packages` 的 `discount_code TEXT,` 下一行加 `source` 欄位（Global Constraints 的 DDL）。
- `connection.js`：在 `addColumnIfMissing('customer_packages', 'discount_code', 'TEXT');` 之後加 `addColumnIfMissing('customer_packages', 'source', ...)` 與 `db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_package ON bookings(package_id)')`，附一行日期註解（比照鄰近區塊）。
- `packageService.js`：加上兩個函式（簽名見 Interfaces）。建立時 `amount = original_amount == null ? null : Math.max(0, original_amount − (discount_amount || 0))`；關閉時用 `discountService.releaseRedemption({ kind: 'booking', refId })` 逐筆釋放該方案名下的預約。
- `package.json`：`test` 末尾加 `&& node tests/online-single-migration.test.js && node tests/online-single.test.js`。

- [ ] **Step 5: 跑測試確認通過，再跑全套**

Run: 兩個新測試 → 全 ✓。`DB_PATH="$(mktemp -d)/t.db" npm test` → ✗ 為 0，✓ ＝ 992＋本 task 新增數。

- [ ] **Step 6: Commit**（訊息：`線上單堂：方案來源欄位、預約方案索引、建立與關閉函式`）

---

### Task 2: 讀取端認得來源（薪資、續購提醒、客人端、週曆）

**Files:**
- Modify: `src/services/payrollService.js:39-45,107`、`src/services/renewalReminderService.js:1-25,47-52`、`src/services/packageService.js`（`listScheduleViewPackages`）、`src/services/coachCalendarService.js:14-19`
- Test: `tests/online-single.test.js`

**Interfaces:**
- Consumes: Task 1 的夾具與 `createOnlineSingleForBooking`。
- Produces: 週曆預約每筆多一欄 `pkg_source`（`'staff'`／`'online'`／`null`），Task 11 的前端用它；`payDetail(startAt, bookingId)` 測試小工具，Task 6 也用。

- [ ] **Step 1: 寫失敗測試（接在檔案後面）**

```js
// ── 連動：讀取端 ──
const { computePayroll, defaultPeriod } = await import('../src/services/payrollService.js');
const { processRenewalReminders } = await import('../src/services/renewalReminderService.js');
const { getCoachWeek } = await import('../src/services/coachCalendarService.js');
const payDetail = (startAt, bookingId) => computePayroll({ period: defaultPeriod(startAt) }).coaches
  .find((c) => c.coachId === coachId).oneOnOne.details.find((d) => d.bookingId === bookingId);
const reminded = (packageId) => !!db.prepare("SELECT 1 FROM renewal_reminders WHERE kind = 'package' AND ref_id = ?").get(packageId);

expect('薪資：線上單堂標散客、金額＝定價−折扣；教練開立的標方案；沒有方案的舊預約標散客', () => {
  const o = online({ code: 'OS100' });
  assert.deepEqual([payDetail(o.startAt, o.id).source, payDetail(o.startAt, o.id).amount], ['walkin', 1400]);
  const m = member(); const s = slot(); assert.equal(payDetail(s, register(m, tenPack(m).id, s)).source, 'package');
  const s2 = slot(); assert.equal(payDetail(s2, rawBooking({ startAt: s2 })).source, 'walkin');
});
expect('續購提醒：10 堂剩 1 堂的客人另有未來的線上單堂 → 照樣提醒', () => {
  const m = member(); const ten = tenPack(m); pkg.adjustRemaining({ packageId: ten.id, remaining: 1 });
  online({ memberId: m });
  processRenewalReminders(nowLocal());
  assert.equal(reminded(ten.id), true);
});
expect('客人端我的方案：不含線上單堂', () => {
  const m = member(); online({ memberId: m });
  assert.deepEqual(pkg.listScheduleViewPackages(m, nowLocal()), []);
  tenPack(m); assert.equal(pkg.listScheduleViewPackages(m, nowLocal()).length, 1);
});
expect('週曆預約帶 pkg_source', () => {
  const wk = (id, s) => getCoachWeek({ coachId, start: s.slice(0, 10) }).bookings.find((x) => x.id === id);
  const o = online(); assert.equal(wk(o.id, o.startAt).pkg_source, 'online');
  const m = member(); const s = slot(); assert.equal(wk(register(m, tenPack(m).id, s), s).pkg_source, 'staff');
  const s2 = slot(); assert.equal(wk(rawBooking({ startAt: s2 }), s2).pkg_source, null);
});
expect('會員方案清單每筆帶 source', () => {
  const m = member(); online({ memberId: m }); tenPack(m);
  assert.deepEqual(pkg.listPackagesForMember(m).map((p) => p.source).sort(), ['online', 'staff']);
});
```

- [ ] **Step 2: 跑測試，確認前四項失敗**（最後一項因為 `cp.*` 已含新欄位會直接通過，留作回歸）

Run: `node tests/online-single.test.js`

- [ ] **Step 3: 實作**

- 薪資：`bookingsStmt` `LEFT JOIN customer_packages cp ON cp.id = b.package_id`，多選 `cp.source AS pkg_source`；來源改成「有方案且不是 `online`」才是 `'package'`。
- 續購提醒：`lowPackagesStmt` 多選 `p.source`；`dueLowPackages` 算「還有堂數的方案中最大的 id」時跳過 `source === 'online'`。檔頭與函式註解補一句「線上單堂不算已買新方案」。
- 客人端：`listScheduleViewPackages` 的查詢加 `AND source <> 'online'`。
- 週曆：`BK_COLS` 加 `cp.source AS pkg_source`。

- [ ] **Step 4: 跑測試確認通過，再跑全套**（✗ 為 0）

- [ ] **Step 5: Commit**（`線上單堂：薪資、續購提醒、客人端、週曆認得方案來源`）

---

### Task 3: 取消規則

**Files:**
- Modify: `src/services/bookingService.js:27-32`（`refundPackageForBooking`）與八個呼叫點（約 `218-219`、`255-260`、`275-276`、`299-300`、`329-330`、`791-792`、`816-817`、`848-849`）
- Test: `tests/online-single.test.js`

**Interfaces:**
- Consumes: `closeOnlineSinglePackage`、`pkgGetPackage`、`refundPackageOne`、`releaseRedemption`。
- Produces（檔內私有）：`settleCancelledBooking(b) → { creditKept: boolean }`，預約從 confirmed 轉 cancelled 的當下呼叫一次，取代原本的「`refundPackageForBooking(b)`＋`releaseRedemption({ kind: 'booking', refId })`」兩行。`cancelBookingFromGcal` 回傳的 `refunded` 改用 `creditKept`。

| 預約的方案 | 預約 `paid_at` | 回補 1 堂 | 方案 | 這筆預約的折扣碼用量 | `creditKept` |
|---|---|---|---|---|---|
| 沒有 | — | — | — | 釋放 | `false` |
| `staff` | 都一樣 | 是（失敗不阻斷，維持現狀） | 不動 | 釋放 | `true` |
| `online` | NULL | 是 | `closeOnlineSinglePackage` | 由關閉一併釋放 | `false` |
| `online` | 有值 | 是 | 不動（剩 1 堂） | **不釋放** | `true` |

- [ ] **Step 1: 寫失敗測試**

```js
// ── 取消 ──
const CANCEL = {
  '客人取消（登入）': (o) => bk.cancelBooking({ bookingId: o.id, actorUserId: o.memberId }),
  '客人取消（查詢頁）': (o) => bk.cancelBookingAnon({ bookingId: o.id, phone: phoneOf(o.memberId), name: nameOf(o.memberId) }),
  '教練取消': (o) => bk.cancelBooking({ bookingId: o.id, actorUserId: coachUser, isCoach: true, reason: 'x' }),
  '管理者取消': (o) => bk.cancelBookingAdmin({ bookingId: o.id, actorId: admin }),
  'Google 日曆刪除': (o) => bk.cancelBookingFromGcal(o.id),
  '取消全部預約': (o) => bk.cancelCoachGroup({ bookingId: o.id, actorUserId: admin, isAdmin: true }),
};
for (const [name, cancel] of Object.entries(CANCEL)) {
  expect(`${name}・未付款 → 方案作廢`, () => {
    const o = online(); cancel(o);
    assert.ok(P(o.packageId).archived_at); assert.equal(pkg.getPackage(o.packageId).is_valid, false);
  });
  expect(`${name}・已付款 → 保留 1 堂`, () => {
    const o = online({ paid: true }); cancel(o); const p = pkg.getPackage(o.packageId);
    assert.deepEqual([p.archived_at, p.remaining_sessions, p.is_valid], [null, 1, true]);
  });
}
const adminCancel = (id) => bk.cancelBookingAdmin({ bookingId: id, actorId: admin });
expect('待核對整批取消（循環散客）：每一堂的方案各自作廢', () => {
  const m = member(); const a = online({ memberId: m }), b = online({ memberId: m });
  db.prepare('UPDATE bookings SET recurring_group_id = ? WHERE id IN (?, ?)').run(a.id, a.id, b.id);
  bk.cancelBookingAdminGroup({ groupId: a.id, actorId: admin });
  assert.ok(P(a.packageId).archived_at && P(b.packageId).archived_at);
});
expect('折扣碼用量：已付款取消仍算已用；未付款取消釋放', () => {
  const paid = online({ code: 'OS100', paid: true }); adminCancel(paid.id); assert.equal(uses(paid.id), 1);
  const unpaid = online({ code: 'OS100' }); adminCancel(unpaid.id); assert.equal(uses(unpaid.id), 0);
});
expect('教練開立的方案與沒有方案的舊預約：取消行為不變', () => {
  const m = member(); const ten = tenPack(m); adminCancel(register(m, ten.id));
  assert.deepEqual([P(ten.id).remaining_sessions, P(ten.id).archived_at], [10, null]);
  const raw = rawBooking(); adminCancel(raw); assert.equal(B(raw).status, 'cancelled');
});
expect('Google 日曆刪除：真的留下可用堂數才回報已回補', () => {
  assert.equal(bk.cancelBookingFromGcal(online().id).refunded, false);
  assert.equal(bk.cancelBookingFromGcal(online({ paid: true }).id).refunded, true);
  const m = member(); assert.equal(bk.cancelBookingFromGcal(register(m, tenPack(m).id)).refunded, true);
  assert.equal(bk.cancelBookingFromGcal(rawBooking()).refunded, false);
});
expect('一對二：同行客人取消未付款的線上預約 → 主客人的單堂方案作廢', () => {
  const m = member(), mate = member(); const o = online({ memberId: m, type: '1on2', member2Id: mate });
  bk.cancelBooking({ bookingId: o.id, actorUserId: mate });
  assert.ok(P(o.packageId).archived_at);
});
expect('舊方案先用：保留的 1 堂比之後才買的同類型方案先用；比它早買的排它前面', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  assert.equal(pkg.getPackage(tenPack(m).id).use_first_id, o.packageId);
  const m2 = member(); const earlier = tenPack(m2); const o2 = online({ memberId: m2, paid: true }); adminCancel(o2.id);
  assert.deepEqual([pkg.getPackage(o2.packageId).use_first_id, pkg.getPackage(earlier.id).use_first_id], [earlier.id, null]);
});
expect('保留的 1 堂由教練登錄改約：金額＝當初實付、已核對；再取消仍保留 1 堂', () => {
  const m = member(); const o = online({ memberId: m, code: 'OS100', paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId); const nb = B(nid);
  assert.deepEqual([nb.package_id, nb.original_amount, !!nb.paid_at, P(o.packageId).remaining_sessions], [o.packageId, 1400, true, 0]);
  adminCancel(nid);
  assert.deepEqual([P(o.packageId).remaining_sessions, P(o.packageId).archived_at], [1, null]);
});
expect('續購提醒：保留的 1 堂也不算已買新方案', () => {
  const m = member(); const ten = tenPack(m); pkg.adjustRemaining({ packageId: ten.id, remaining: 1 });
  adminCancel(online({ memberId: m, paid: true }).id);
  processRenewalReminders(nowLocal());
  assert.equal(reminded(ten.id), true);
});
```

- [ ] **Step 2: 跑測試，確認失敗**（未付款的各項 ✗：方案沒有作廢；折扣碼用量、日曆回報等 ✗）

- [ ] **Step 3: 實作 `settleCancelledBooking`（依上表），替換八個呼叫點，刪掉 `refundPackageForBooking`**

- [ ] **Step 4: 跑測試確認通過，再跑全套**（✗ 為 0；此時正式路徑還不會產生線上單堂方案，既有測試不應受影響）

- [ ] **Step 5: Commit**（`線上單堂：取消時未付款作廢、已付款保留 1 堂，折扣碼用量跟著方案走`）

---

### Task 4: 退款規則

**Files:**
- Modify: `src/services/bookingService.js`（`refundBookingAdmin` 約 `320-342`、`refundBookingGroupAdmin` 約 `836-866`）
- Test: `tests/online-single.test.js`

**Interfaces:**
- Consumes: `settleCancelledBooking`、`closeOnlineSinglePackage`。
- Produces: `refundBookingAdmin` 可能丟 `409 package_closed`／`409 credit_in_use`；`refundBookingGroupAdmin` 回傳多一個 `skipped: number[]`（被跳過的預約 id），`refunded` 只算真的退了的；`refund(id)` 測試小工具，後面的 task 也用。

規則（預約掛在線上單堂方案上才適用，檢查放在既有的 `not_paid`／`already_refunded` 之後）：
1. 方案已作廢 → `package_closed`。
2. 這筆預約已取消，而方案上另有一筆 `confirmed` 預約 → `credit_in_use`。
3. 其餘照現有流程，寫完 `refunded_at` 之後 `closeOnlineSinglePackage(方案 id)`。

整批退款：逐列套用 1、2，不能退的列放進 `skipped` 後跳過；沒有任何一列退成 → `409 already_refunded`；通知的堂數、金額、起始時間只用真的退了的列。

- [ ] **Step 1: 寫失敗測試**

```js
// ── 退款 ──
const refund = (id) => bk.refundBookingAdmin({ bookingId: id, actorId: admin });
expect('已付款未取消 → 退款：取消預約、記退款、方案作廢、釋放折扣碼用量', () => {
  const o = online({ code: 'OS100', paid: true }); const r = refund(o.id);
  assert.deepEqual([r.cancelled, B(o.id).status, !!B(o.id).refunded_at, !!P(o.packageId).archived_at, uses(o.id)], [true, 'cancelled', true, true, 0]);
});
expect('已付款已取消（保留 1 堂）→ 退款：方案作廢', () => {
  const o = online({ paid: true }); adminCancel(o.id); const r = refund(o.id);
  assert.deepEqual([r.cancelled, !!B(o.id).refunded_at, !!P(o.packageId).archived_at], [false, true, true]);
});
expect('保留的 1 堂已被改約 → 原筆不能退；改約後那筆退款後，原筆也不能再退', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId);
  throwsCode(() => refund(o.id), 409, 'credit_in_use');
  refund(nid);
  throwsCode(() => refund(o.id), 409, 'package_closed');
  assert.equal(B(o.id).refunded_at, null);
});
expect('改約後那筆只取消：兩筆之中退了一筆，另一筆不能再退', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId); adminCancel(nid);
  refund(o.id);
  throwsCode(() => refund(nid), 409, 'package_closed');
});
expect('未付款不能退；教練開立的方案退款行為不變', () => {
  throwsCode(() => refund(online().id), 409, 'not_paid');
  const m = member(); const ten = tenPack(m); refund(register(m, ten.id));
  assert.deepEqual([P(ten.id).remaining_sessions, P(ten.id).archived_at], [10, null]);
});
expect('整批退款（循環散客）：已改約的那堂跳過並回報，其餘照退；都不能退 → already_refunded', () => {
  const m = member(); const [a, b, c] = [1, 2, 3].map(() => online({ memberId: m, paid: true }));
  db.prepare('UPDATE bookings SET recurring_group_id = ? WHERE id IN (?, ?, ?)').run(a.id, a.id, b.id, c.id);
  adminCancel(b.id); register(m, b.packageId);
  const r = bk.refundBookingGroupAdmin({ groupId: a.id, actorId: admin });
  assert.deepEqual([r.refunded, r.skipped, [...r.cancelled].sort((x, y) => x - y)], [2, [b.id], [a.id, c.id]]);
  assert.deepEqual([B(b.id).refunded_at, P(b.packageId).archived_at, !!P(a.packageId).archived_at, !!P(c.packageId).archived_at], [null, null, true, true]);
  throwsCode(() => bk.refundBookingGroupAdmin({ groupId: a.id, actorId: admin }), 409, 'already_refunded');
});
```

- [ ] **Step 2: 跑測試，確認失敗**
- [ ] **Step 3: 實作（依上面三條規則與整批的處理）**
- [ ] **Step 4: 跑測試確認通過，再跑全套**（✗ 為 0）
- [ ] **Step 5: Commit**（`線上單堂：一張方案只能退款一次，退款後方案作廢`）

---

### Task 5: 改客人／方案規則

**Files:**
- Modify: `src/services/bookingService.js`（`reassignBooking` 約 `698-726`）
- Test: `tests/online-single.test.js`

**Interfaces:**
- Produces: `reassignBooking` 對「已付款、掛在線上單堂方案上」的預約丟 `409 paid_online_single`；`reassign(bookingId, memberId, packageId)` 測試小工具，Task 8 也用。

規則：
1. 權限檢查之後、讀新方案之前：原方案是 `online` 且這筆預約 `paid_at` 有值 → `paid_online_single`（什麼都不改）。
2. 原方案是 `online`（未付款）：照現有流程回補原方案後，立刻 `closeOnlineSinglePackage(原方案 id)`，而且要在「舊方案先用」的判斷**之前**。

- [ ] **Step 1: 寫失敗測試**

```js
// ── 改客人／方案 ──
const reassign = (bookingId, memberId, packageId) => bk.reassignBooking({ bookingId, newMemberId: memberId, newPackageId: packageId, actorUserId: admin, isAdmin: true });
expect('未付款的線上單堂改掛到別的客人：成功、原單堂方案作廢、折扣碼用量釋放', () => {
  const o = online({ code: 'OS100' }); const m2 = member(); const ten = tenPack(m2);
  reassign(o.id, m2, ten.id);
  assert.deepEqual([B(o.id).package_id, B(o.id).member_id, !!P(o.packageId).archived_at, uses(o.id), P(ten.id).remaining_sessions], [ten.id, m2, true, 0, 9]);
});
expect('未付款的線上單堂改掛到同一位客人之後才買的同類型方案：不被「舊方案先用」誤擋', () => {
  const m = member(); const o = online({ memberId: m }); const ten = tenPack(m);   // 單堂方案的 id 比 10 堂方案小
  reassign(o.id, m, ten.id);
  assert.equal(B(o.id).package_id, ten.id); assert.ok(P(o.packageId).archived_at);
});
expect('已付款的線上單堂不能改掛（同客人、別的客人、不同類型）', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); const m2 = member();
  const targets = [[m, tenPack(m).id], [m2, tenPack(m2).id], [m, tenPack(m, { sessionType: '1on2' }).id]];
  for (const [mm, pid] of targets) throwsCode(() => reassign(o.id, mm, pid), 409, 'paid_online_single');
  assert.deepEqual([B(o.id).package_id, P(o.packageId).remaining_sessions, P(o.packageId).archived_at], [o.packageId, 0, null]);
});
expect('用保留的 1 堂改約出來的預約也不能改掛', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  const nid = register(m, o.packageId); const m2 = member();
  throwsCode(() => reassign(nid, m2, tenPack(m2).id), 409, 'paid_online_single');
});
```

- [ ] **Step 2: 跑測試，確認失敗**（第二項會丟 `older_package_first`，第三、四項不會丟錯）
- [ ] **Step 3: 實作**
- [ ] **Step 4: 跑測試確認通過，再跑全套**（✗ 為 0）
- [ ] **Step 5: Commit**（`線上單堂：未付款可改掛並作廢原單堂，已付款不能改掛`）

---

### Task 6: 後台動作限制＋改單價清折扣

**Files:**
- Modify: `src/services/packageService.js`（`adjustRemaining`、`updateUnitPrice`、`archivePackage`、`restorePackage`）
- Test: `tests/online-single.test.js`

**Interfaces:**
- Produces: `adjustRemaining`／`restorePackage` 對線上單堂丟 `409 online_single_readonly`；`archivePackage` 對線上單堂：有 `confirmed` 預約 → `409 has_active_booking`，否則 `closeOnlineSinglePackage` 後回 `{ ...getPackage(id), cancelledBookingIds: [] }`；`updateUnitPrice`（所有方案）把同一批預約的 `discount_amount`、`discount_code` 清成 NULL 並釋放這些預約的折扣碼用量。

- [ ] **Step 1: 寫失敗測試**

```js
// ── 後台動作限制、改單價 ──
expect('線上單堂不能調整堂數、不能還原', () => {
  const o = online();
  throwsCode(() => pkg.adjustRemaining({ packageId: o.packageId, remaining: 1 }), 409, 'online_single_readonly');
  adminCancel(o.id);   // 未付款取消 → 已作廢
  throwsCode(() => pkg.restorePackage(o.packageId), 409, 'online_single_readonly');
});
expect('有未取消預約的線上單堂不能直接作廢', () => {
  const o = online({ paid: true });
  throwsCode(() => pkg.archivePackage(o.packageId, admin), 409, 'has_active_booking');
  assert.deepEqual([B(o.id).status, P(o.packageId).archived_at], ['confirmed', null]);
});
expect('保留的 1 堂可以作廢：不取消預約、釋放折扣碼用量、之後不能退款', () => {
  const o = online({ code: 'OS100', paid: true }); adminCancel(o.id);
  const r = pkg.archivePackage(o.packageId, admin);
  assert.deepEqual([r.cancelledBookingIds, !!r.archived_at, uses(o.id)], [[], true, 0]);
  throwsCode(() => refund(o.id), 409, 'package_closed');
});
expect('改單價：線上單堂的折扣一併清除並釋放用量，薪資＝新單價', () => {
  const o = online({ code: 'OS100' });
  pkg.updateUnitPrice({ packageId: o.packageId, unitPrice: 1200 });
  const b = B(o.id);
  assert.deepEqual([b.original_amount, b.discount_amount, b.discount_code, uses(o.id), P(o.packageId).amount, P(o.packageId).discount_code, payDetail(o.startAt, o.id).amount],
    [1200, null, null, 0, 1200, null, 1200]);
});
expect('改單價：保留的 1 堂改價後，改約的那堂用新價', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  pkg.updateUnitPrice({ packageId: o.packageId, unitPrice: 1000 });
  assert.equal(B(register(m, o.packageId)).original_amount, 1000);
});
expect('教練開立的方案：調整、作廢連動取消、還原都照舊', () => {
  const m = member(); const ten = tenPack(m); const rid = register(m, ten.id);
  assert.equal(pkg.adjustRemaining({ packageId: ten.id, remaining: 5 }).remaining_sessions, 5);
  assert.deepEqual(pkg.archivePackage(ten.id, admin).cancelledBookingIds, [rid]);
  assert.equal(pkg.restorePackage(ten.id).archived_at, null);
});
```

- [ ] **Step 2: 跑測試，確認失敗**
- [ ] **Step 3: 實作**
- [ ] **Step 4: 跑測試確認通過，再跑全套**（✗ 為 0）
- [ ] **Step 5: Commit**（`線上單堂：後台只能改單價、退款、作廢保留的 1 堂；改單價一併清折扣`）

---

### Task 7: 線上預約自動建方案＋既有測試的清資料

**Files:**
- Modify: `src/services/bookingService.js`（`createBookingAnon`，寫完金額的 `UPDATE bookings SET original_amount=…` 之後）
- Modify: 會走線上預約、清資料時沒有刪方案的既有測試：`tests/admin-backfill-api.test.js`、`admin-notify-broadcast.test.js`、`booking-admin-cancel-api.test.js`、`booking-anon.test.js`、`booking-companion-schedule.test.js`、`booking-payment-api.test.js`、`booking-staff-phone-idor.test.js`、`booking-validate-api.test.js`、`discount-api.test.js`、`discount-booking.test.js`、`notification-dedup.test.js`、`public-api.test.js`、`refund-api.test.js`
- Test: `tests/online-single.test.js`

**Interfaces:**
- Consumes: `createOnlineSingleForBooking`（Task 1）以及 Task 3–6 的全部規則。
- Produces: 之後每一筆經 `createBookingAnon` 建立的預約都有線上單堂方案。回傳物件不新增欄位。

- [ ] **Step 1: 寫失敗測試（真的走 `createBookingAnon`）**

```js
// ── 線上預約實際流程（createBookingAnon）──
const book = (extra = {}) => { seq++; const phone = `0977${pad(seq, 6)}`; const name = `線上客${seq}`;
  return { ...bk.createBookingAnon({ coachId, startAt: slot(), name, phone, ...extra }), phone, name }; };
expect('線上預約送出 → 自動建一堂方案並掛上；回傳內容不多出欄位', () => {
  const r = book(); const b = B(r.id); const p = P(b.package_id);
  assert.equal(b.paid_at, null);
  assert.deepEqual([p.source, p.total_sessions, p.remaining_sessions, p.amount, p.member_id], ['online', 1, 0, 1500, b.member_id]);
  assert.equal('packageId' in r, false);
});
expect('有折扣碼；一對二有同行客人', () => {
  const r = book({ discountCode: 'OS100' }); const p = P(B(r.id).package_id);
  assert.deepEqual([p.amount, p.discount_code, uses(r.id)], [1400, 'OS100', 1]);
  seq++; const r2 = book({ sessionType: '1on2', companion: { name: `同行${seq}`, phone: `0978${pad(seq, 6)}` } }); const b2 = B(r2.id);
  assert.ok(b2.member2_id);
  assert.deepEqual([P(b2.package_id).session_type, P(b2.package_id).amount, P(b2.package_id).member_id], ['1on2', 2000, b2.member_id]);
});
expect('整段流程：預約→核對→客人取消（保留 1 堂）→教練改約→退款；原筆不能再退', () => {
  const r = book(); const b = B(r.id);
  bk.confirmBookingPayment({ bookingId: r.id, actorId: admin });
  bk.cancelBookingAnon({ bookingId: r.id, phone: r.phone, name: r.name });
  assert.equal(pkg.getPackage(b.package_id).is_valid, true);
  refund(register(b.member_id, b.package_id));
  assert.ok(P(b.package_id).archived_at);
  throwsCode(() => refund(r.id), 409, 'package_closed');
});
expect('限用一次的折扣碼：已付款取消後還保留 1 堂時不能再用同一個碼；退款後才釋放', () => {
  createDiscountCode({ code: 'OSONCE', discount_type: 'fixed', discount_value: 100, per_phone_limit: 1 });
  const r = book({ discountCode: 'OSONCE' });
  bk.confirmBookingPayment({ bookingId: r.id, actorId: admin });
  bk.cancelBookingAnon({ bookingId: r.id, phone: r.phone, name: r.name });
  const again = () => bk.createBookingAnon({ coachId, startAt: slot(), name: r.name, phone: r.phone, discountCode: 'OSONCE' });
  throwsCode(again, 409, 'per_phone_exhausted');
  refund(r.id);
  assert.ok(again().id);
});

// ── 不變量（這一段永遠留在檔案最後；之後的 task 把測試加在它前面）──
expect('線上單堂方案都是共 1 堂、剩 0 或 1', () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'online' AND (total_sessions <> 1 OR remaining_sessions NOT IN (0, 1))").get().c, 0);
});
expect('未作廢的線上單堂方案：剩餘堂數＋未取消預約數 恆為 1（一筆錢不會對到兩堂，也不會一堂都沒有）', () => {
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM customer_packages p WHERE p.source = 'online' AND p.archived_at IS NULL
    AND p.remaining_sessions + (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id AND b.status = 'confirmed') <> 1`).get().c, 0);
});
expect('已作廢的線上單堂方案名下沒有未取消的預約', () => {
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM bookings b JOIN customer_packages p ON p.id = b.package_id
    WHERE p.source = 'online' AND p.archived_at IS NOT NULL AND b.status = 'confirmed'`).get().c, 0);
});
```

- [ ] **Step 2: 跑測試，確認失敗**（前四項 ✗：`b.package_id` 是 NULL；不變量三項是回歸防護，此時應該已經是 ✓——若不是，代表前面某個 task 的規則有洞，先查清楚再往下）

- [ ] **Step 3: 實作** — `createBookingAnon` 的交易內、金額寫入之後呼叫 `createOnlineSingleForBooking(r.id)`；不把結果放進回傳物件。

- [ ] **Step 4: 跑 `tests/online-single.test.js` 確認通過**

- [ ] **Step 5: 跑全套，修既有測試的清資料**

Run: `DB_PATH="$(mktemp -d)/t.db" npm test`，輸出存檔。上面列的 13 個檔案（以及任何出現 `FOREIGN KEY constraint failed` 的檔案），在它自己刪預約的那一行之後、刪 users 之前加一行（刪掉已經沒有預約指向的線上單堂方案，任何清除範圍都安全）：

```sql
DELETE FROM customer_packages WHERE source = 'online' AND id NOT IN (SELECT package_id FROM bookings WHERE package_id IS NOT NULL);
```

其他失敗的判斷方式：斷言的是「規格明確改變的行為」（例如已付款的線上預約取消後折扣碼用量仍在、線上預約後會員名下有一筆方案）→ 把斷言改成新規則，並在 commit 訊息列出改了哪幾條；其餘失敗都當成產品程式的錯，修程式不改測試。

Expected: ✗ 為 0。清單裡檔名是 `*-api` 的不在 `npm test` 裡，這一步只先補上那一行，實際執行留到 Task 12 的 API 測試。

- [ ] **Step 6: Commit**（`線上預約送出時自動建立一堂方案；既有測試清資料補刪線上單堂方案`）

---

### Task 8: 會員方案區的 `single` 資料＋summary 端點

**Files:**
- Modify: `src/services/packageService.js`（`listPackagesForMember`、新增 `getPackagesSummary`）、`src/server.js`（約 `885-930` 方案路由區塊旁）、`package.json`（`test:api`）
- Test: `tests/online-single.test.js`（加在「不變量」那一段之前）、Create: `tests/online-single-api.test.js`

**Interfaces:**
- Produces: `listPackagesForMember` 回傳的線上單堂列多一個 `single`（教練開立的列沒有這個鍵）：

```js
single: {
  booking_id, start_at, coach_name, booking_status,   // 代表預約：名下 confirmed 的那筆，沒有就取 id 最大的；名下沒有預約 → 四個都是 null
  pay_status,             // 名下任一筆有 refunded_at → 'refunded'；否則任一筆有 paid_at → 'paid'；否則 'pending'
  amount,                 // 方案的 amount
  state,                  // 未作廢：有 confirmed 預約 → start_at >= 現在 ? 'booked' : 'done'；沒有 → 'credit'。已作廢：pay_status 是 'paid' → 'void'，否則 'cancelled'
  refundable_booking_id,  // 方案已作廢或 pay_status 不是 'paid' → null；代表預約已付款未退款 → 它；否則名下已付款、未退款、id 最大的那筆
}
```

  名下預約用一個查詢一次取回（`WHERE b.package_id IN (…)`，`JOIN coaches` 取 `display_name`），不要每張方案查一次。
- Produces: `getPackagesSummary() → { packages: { staff, online }, confirmedWithoutPackage, backfill }`（`backfill`＝`online_single_backfill_summary` 解析後的物件，沒有就是 `null`）；`GET /api/admin/packages/summary`（`requireAdmin`）回同一個物件。

- [ ] **Step 1: 寫服務層失敗測試**

```js
// ── 會員方案區的單堂資料 ──
const single = (memberId, packageId) => pkg.listPackagesForMember(memberId, { includeArchived: true }).find((p) => p.id === packageId).single;
expect('已預約・待核對 → 核對後可退款', () => {
  const o = online(); let s = single(o.memberId, o.packageId);
  assert.deepEqual([s.state, s.pay_status, s.booking_id, s.start_at, s.coach_name, s.booking_status, s.amount, s.refundable_booking_id],
    ['booked', 'pending', o.id, o.startAt, 'os教練', 'confirmed', 1500, null]);
  bk.confirmBookingPayment({ bookingId: o.id, actorId: admin }); s = single(o.memberId, o.packageId);
  assert.deepEqual([s.pay_status, s.refundable_booking_id], ['paid', o.id]);
});
expect('已上完', () => { const o = online({ startAt: pastSlot(), paid: true }); assert.equal(single(o.memberId, o.packageId).state, 'done'); });
expect('保留 1 堂 → 改約後代表預約換成新的那筆 → 退款後已取消・已退款', () => {
  const m = member(); const o = online({ memberId: m, paid: true }); adminCancel(o.id);
  let s = single(m, o.packageId);
  assert.deepEqual([s.state, s.pay_status, s.booking_id, s.booking_status, s.refundable_booking_id], ['credit', 'paid', o.id, 'cancelled', o.id]);
  const nid = register(m, o.packageId); s = single(m, o.packageId);
  assert.deepEqual([s.state, s.booking_id, s.refundable_booking_id], ['booked', nid, nid]);
  refund(nid); s = single(m, o.packageId);
  assert.deepEqual([s.state, s.pay_status, s.refundable_booking_id], ['cancelled', 'refunded', null]);
});
expect('未付款取消 → 已取消・待核對；作廢保留的 1 堂 → 已作廢・已核對，不能退款', () => {
  const a = online(); adminCancel(a.id);
  assert.deepEqual([single(a.memberId, a.packageId).state, single(a.memberId, a.packageId).pay_status], ['cancelled', 'pending']);
  const b = online({ paid: true }); adminCancel(b.id); pkg.archivePackage(b.packageId, admin);
  const s = single(b.memberId, b.packageId);
  assert.deepEqual([s.state, s.pay_status, s.refundable_booking_id], ['void', 'paid', null]);
});
expect('預約被改掛走、名下沒有預約的線上單堂：預約欄位都是 null、狀態已取消', () => {
  const o = online(); const m2 = member(); reassign(o.id, m2, tenPack(m2).id);
  const s = single(o.memberId, o.packageId);
  assert.deepEqual([s.booking_id, s.start_at, s.coach_name, s.booking_status, s.state, s.pay_status, s.refundable_booking_id], [null, null, null, null, 'cancelled', 'pending', null]);
});
expect('教練開立的方案沒有 single', () => { const m = member(); tenPack(m); assert.equal(pkg.listPackagesForMember(m)[0].single, undefined); });
expect('summary：各來源方案數、沒有方案的未取消預約數；還沒補登 → backfill 為 null', () => {
  const s = pkg.getPackagesSummary(); const n = (sql) => db.prepare(sql).get().c;
  assert.deepEqual([s.packages.online, s.packages.staff, s.confirmedWithoutPackage, s.backfill],
    [n("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'online'"), n("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'staff'"),
     n("SELECT COUNT(*) AS c FROM bookings WHERE status = 'confirmed' AND package_id IS NULL"), null]);
});
```

- [ ] **Step 2: 寫 `tests/online-single-api.test.js`**（比照 `tests/booking-payment-api.test.js` 的檔頭：`req()`、`BASE`、seed 的管理者登入；自己的資料用 email 前綴 `osa-`、電話 `0969…`，開頭清資料時要刪 `customer_packages`）。流程與斷言：

1. `POST /api/public/bookings`（一般客人）→ 201；用 `db` 查出 `memberId`；`GET /api/coach/packages?memberId=…&includeArchived=1` → 一筆，`source === 'online'`、`single.state === 'booked'`、`single.pay_status === 'pending'`。
2. `PATCH /api/coach/packages/:id`（`{ remaining: 1 }`）→ 409 `online_single_readonly`；`POST …/restore` → 409 `online_single_readonly`；`POST …/archive` → 409 `has_active_booking`。
3. `POST /api/admin/bookings/:id/confirm-payment` → `single.pay_status === 'paid'`、`single.refundable_booking_id` 是這筆預約。
4. `POST /api/admin/bookings/:id/cancel` → `single.state === 'credit'`、`remaining_sessions === 1`。
5. `POST /api/admin/bookings/:id/refund` → 200；`single.state === 'cancelled'`、`single.pay_status === 'refunded'`；再退一次 → 409 `already_refunded`。
6. 再送一筆新的線上預約，`GET /api/coach/week?all=1&start=<那筆預約的日期>`（管理者）→ 回傳的 `bookings` 裡那一筆帶 `pkg_source === 'online'`。
7. 管理者補登過去日期（比照 `tests/admin-backfill-api.test.js` 的送法）→ 那筆預約的 `package_id` 不是 NULL。
8. `GET /api/admin/packages/summary`：帶管理者 token → 200，`packages.online`、`packages.staff`、`confirmedWithoutPackage` 都是數字；不帶 token → 401 或 403（與其他 `requireAdmin` 端點相同）。

- [ ] **Step 3: 跑服務層測試，確認失敗**（`single` 是 `undefined`、`getPackagesSummary` 不存在）
- [ ] **Step 4: 實作 `single`、`getPackagesSummary`、路由；`package.json` 的 `test:api` 末尾加 `&& node tests/online-single-api.test.js`**
- [ ] **Step 5: 跑測試**

Run: `node tests/online-single.test.js` → 全 ✓。起一個本機站（Global Constraints 的指令），`DB_PATH=<同一個> BASE=http://localhost:<port> node tests/online-single-api.test.js` → 全 ✓。全套 `npm test` → ✗ 為 0。

- [ ] **Step 6: Commit**（`線上單堂：會員方案清單附單堂資料、方案 summary 端點`）

---

### Task 9: 補登既有資料

**Files:**
- Create: `src/services/onlineSingleBackfill.js`、`tests/online-single-backfill.test.js`
- Modify: `src/services/backupService.js`、`src/server.js`（檔尾 `ensureInitialAdmin();` 之後、`app.listen` 之前）、`package.json`

**Interfaces:**
- Consumes: `createOnlineSingleForBooking(bookingId, { createdAt })`、`setSetting`／`getSetting`（`discountService.js`）、`getPackagesSummary`。
- Produces:
  - `backupService.runNamedSnapshot(name, dir = DEFAULT_DIR) → { ok: true, file, size } | { ok: false, error }`，檔名 `${name}-YYYYMMDD-HHMMSS.db`，不做輪替、不寫 `.last-error.txt`。
  - `utcToLocal(s) → string`：`'YYYY-MM-DD HH:MM:SS'`（UTC）→ 本地 `'YYYY-MM-DDTHH:MM:SS'`；已經是本地格式 → 原樣回傳；其他 → `nowLocal()`。
  - `backfillOnlineSingles({ snapshot = () => runNamedSnapshot('pre-online-single') } = {})`，**不丟例外**：
    - 旗標已是 `'1'` → `{ ran: false, reason: 'done' }`
    - 沒有要補的預約 → 不做快照，寫旗標與摘要，回 `{ ran: true, created: 0, members: 0, at, snapshot: null }`
    - 快照回 `ok: false` → `{ ran: false, reason: 'snapshot_failed' }`，不補、不寫旗標
    - 成功 → 單一交易內逐筆 `createOnlineSingleForBooking(id, { createdAt: utcToLocal(created_at) })`，同一交易寫旗標與摘要，回 `{ ran: true, created, members, at, snapshot: <檔名> }`
    - 任何例外 → 交易回滾，`{ ran: false, reason: 'error', error: <訊息> }`
  - 要補的預約＝`status = 'confirmed' AND package_id IS NULL`，依 `id` 由小到大。

- [ ] **Step 1: 寫失敗測試 `tests/online-single-backfill.test.js`**（檔頭同 `tests/online-single.test.js` 的獨立暫存資料庫寫法，檔名改 `online-single-backfill-test-…`；另外從 `node:fs` 取 `mkdtempSync`、`existsSync`，並載入 `onlineSingleBackfill.js` 的 `backfillOnlineSingles`、`utcToLocal`，`backupService.js` 的 `runNamedSnapshot`、`listBackups`、`pruneOldBackups`，`payrollService.js` 的 `computePayroll`、`defaultPeriod`，以及 `packageService.js`（`pkg`）、`bookingService.js`（`bk`））

資料（直接用 SQL 寫入，`created_at` 明確指定）：教練一位、管理者一位、會員 m1–m5。

| 代號 | 會員 | 內容 | `created_at` |
|---|---|---|---|
| A | m1 | 過去、已付款、一對一 1500 | `2026-03-01 02:30:00` |
| B | m1 | 未來、未付款、1500 折 100、折扣碼 `X` | `2026-03-02 02:30:00` |
| C | m2 | 過去、`original_amount` NULL | `2026-03-03 02:30:00` |
| D | m2 | 未來、一對二 2000、同行 m3 | `2026-03-04 02:30:00` |
| E | m3 | 已取消 | `2026-03-05 02:30:00` |
| F、G | m4 | 未來、同一個 `recurring_group_id` | `2026-03-06 02:30:00` |
| H | m5 | 用 `createPackage`＋`createCoachRegister` 建的 10 堂方案預約 | — |
| I | m5 | 未來、已付款、1500 | `garbage` |

```js
expect('時間換算', () => {
  const d = new Date('2026-03-01T02:30:00Z'); const p = (n) => String(n).padStart(2, '0');
  assert.equal(utcToLocal('2026-03-01 02:30:00'), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
  assert.equal(utcToLocal('2026-03-01T10:30:00'), '2026-03-01T10:30:00');
  assert.match(utcToLocal('garbage'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});
const pkgCount = () => db.prepare('SELECT COUNT(*) AS c FROM customer_packages').get().c;
const flag = () => db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_done'").get()?.value ?? null;
expect('快照失敗 → 不補、不寫旗標', () => {
  const before = pkgCount();
  assert.deepEqual(backfillOnlineSingles({ snapshot: () => ({ ok: false, error: 'x' }) }), { ran: false, reason: 'snapshot_failed' });
  assert.deepEqual([pkgCount(), flag()], [before, null]);
});
expect('過程丟例外 → 不往外丟、不補、不寫旗標', () => {
  const before = pkgCount();
  const r = backfillOnlineSingles({ snapshot: () => { throw new Error('boom'); } });
  assert.deepEqual([r.ran, r.reason, pkgCount(), flag()], [false, 'error', before, null]);
});
```

主流程（`snapshot` 用會計數的假函式 `() => { calls++; return { ok: true, file: 'pre-online-single-test.db', size: 1 }; }`）：

```js
const periods = [...new Set([A, B, C, D, F, G, H, I].map((id) => defaultPeriod(row(id).start_at)))];
const payroll = () => periods.map((period) => computePayroll({ period }));
const rowsNoPkg = () => db.prepare('SELECT * FROM bookings ORDER BY id').all().map(({ package_id, ...rest }) => rest);
const before = { payroll: payroll(), rows: rowsNoPkg(), notes: db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c, tenRemaining: pack(H).remaining_sessions };
const r = backfillOnlineSingles({ snapshot });
expect('補 7 筆、4 位會員，回傳與摘要一致', () => {
  assert.deepEqual([r.ran, r.created, r.members, r.snapshot, calls], [true, 7, 4, 'pre-online-single-test.db', 1]);
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(flag(), '1');
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_summary'").get().value),
    { created: 7, members: 4, at: r.at, snapshot: 'pre-online-single-test.db' });
});
expect('每筆補登的方案欄位正確', () => {
  for (const [id, amount, type] of [[A, 1500, '1on1'], [B, 1400, '1on1'], [C, null, '1on1'], [D, 2000, '1on2'], [F, 1500, '1on1'], [G, 1500, '1on1'], [I, 1500, '1on1']]) {
    const b = row(id); const p = pack(id);
    assert.deepEqual([p.source, p.total_sessions, p.remaining_sessions, p.member_id, p.session_type, p.amount, p.created_by],
      ['online', 1, 0, b.member_id, type, amount, null], `booking ${id}`);
    // 建立時間＝預約建立時間換成本地時間；I 的時間是壞資料，只要求格式正確（退回當下時間，不能讓整批補登失敗）
    if (id === I) assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    else assert.equal(p.created_at, utcToLocal(b.created_at), `booking ${id}`);
  }
  assert.equal(pack(B).discount_code, 'X');
});
expect('已取消的不補；教練開立的方案不動；預約的其他欄位一律不變', () => {
  assert.equal(row(E).package_id, null);
  assert.deepEqual([pack(H).source, pack(H).remaining_sessions], ['staff', before.tenRemaining]);
  assert.deepEqual(rowsNoPkg(), before.rows);
});
expect('薪資各期輸出與補登前完全相同；沒有新增任何通知', () => {
  assert.deepEqual(payroll(), before.payroll);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c, before.notes);
});
expect('補登後教練登錄不被單堂方案卡住；之後留下的 1 堂排在原有方案之後', () => {
  assert.equal(pkg.getPackage(pack(H).id).use_first_id, null);
  bk.cancelBookingAdmin({ bookingId: I, actorId: admin });          // I 已付款 → 保留 1 堂
  assert.equal(pkg.getPackage(pack(I).id).use_first_id, pack(H).id);
});
expect('summary：沒有方案的未取消預約為 0、補登摘要帶出', () => {
  const s = pkg.getPackagesSummary(); assert.deepEqual([s.confirmedWithoutPackage, s.backfill.created], [0, 7]);
});
expect('再跑一次 → 已完成；旗標遺失重跑 → 建立 0 筆、不再做快照', () => {
  assert.deepEqual(backfillOnlineSingles({ snapshot }), { ran: false, reason: 'done' });
  db.prepare("DELETE FROM app_settings WHERE key = 'online_single_backfill_done'").run();
  const n = pkgCount(); const again = backfillOnlineSingles({ snapshot });
  assert.deepEqual([again.ran, again.created, again.members, again.snapshot, pkgCount(), calls], [true, 0, 0, null, n, 1]);
});
expect('快照檔不會被每週備份的輪替刪掉，也不在備份清單裡', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-')); const s = runNamedSnapshot('pre-online-single', dir);
  assert.equal(s.ok, true); assert.match(s.file, /^pre-online-single-\d{8}-\d{6}\.db$/);
  pruneOldBackups(dir, 0);
  assert.equal(existsSync(join(dir, s.file)), true); assert.equal(listBackups(dir).files.length, 0);
});
```

（`row(id)`＝`SELECT * FROM bookings WHERE id = ?`；`pack(bookingId)`＝該預約 `package_id` 指向的方案列。）

- [ ] **Step 2: 跑測試，確認失敗**（模組不存在）
- [ ] **Step 3: 實作 `runNamedSnapshot`、`onlineSingleBackfill.js`**
- [ ] **Step 4: `server.js` 開機呼叫**

`ensureInitialAdmin();` 之後、`app.listen` 之前（同步執行，所以一定在開始接受請求之前跑完）：

```js
const bf = backfillOnlineSingles();
if (bf.ran) console.log(`[migrate] online single backfill: ${bf.created} bookings / ${bf.members} members${bf.snapshot ? ` (snapshot ${bf.snapshot})` : ''}`);
else if (bf.reason !== 'done') console.error(`[migrate] online single backfill skipped: ${bf.reason}${bf.error ? ` (${bf.error})` : ''}`);
```

- [ ] **Step 5: 跑測試確認通過；`package.json` 的 `test` 末尾加 `&& node tests/online-single-backfill.test.js`；跑全套**（✗ 為 0）

- [ ] **Step 6: 實際開機驗證一次**

用暫存資料庫：`npm run seed` → 用 SQL 塞兩筆 `confirmed`、沒有方案的預約（seed 沒有可用的教練或會員時一起塞）→ 啟動伺服器。Expected：log 出現 `[migrate] online single backfill: 2 bookings / …`；備份資料夾多一個 `pre-online-single-*.db`；重啟後不再出現這行。

- [ ] **Step 7: Commit**（`線上單堂：開機一次性補登既有的單堂預約（先快照、不通知、可重跑）`）

---

### Task 10: 後台會員方案區的單堂卡（`public/admin.js`）

**Files:**
- Modify: `public/admin.js`（`renderMemberPackages` 約 `1442-1570`、已核對清單長按退款約 `2118-2126`）；需要排版微調時才動 `public/admin.html` 既有的 `.pkg-*` 樣式區（約 `507-516`），不新增顏色

**Interfaces:**
- Consumes: `GET /api/coach/packages?memberId=&includeArchived=1` 的 `source` 與 `single`（Task 8）；`POST /api/admin/bookings/:id/refund`；`POST /api/coach/packages/:id/archive`；`PATCH /api/coach/packages/:id/unit-price`；整批退款回傳的 `skipped`（Task 4）。

- [ ] **Step 1: 實作單堂卡**

`p.source === 'online'` 的列改用單堂卡，其他列完全不動。結構沿用 `.pkg-row`（左欄購買日與時間照舊）：

- `.pkg-head`：`一對一`／`一對二`＋「線上單堂」（一般 `.badge`）＋狀態徽章。狀態文字與樣式：`booked` 已預約（沿用「有效」的綠色寫法）、`done` 已上完（一般 `.badge`）、`credit` 保留 1 堂（沿用「已失效」的黃色寫法）、`cancelled` 已取消與 `void` 已作廢（`badge-cancelled`）。已作廢的列照舊加 `is-arch`。
- `.pkg-stats`：`上課 YYYY/MM/DD HH:MM・<教練名>`；`single.booking_id` 是 null → 「預約已改到其他方案」。
- `.pkg-meta`：`NT$1,400 · 待核對`（`pending` 待核對／`paid` 已核對／`refunded` 已退款）；`amount` 是 null → 「無金額」。
- `.pkg-acts`（不出現「調整」「還原」）：
  - 「改單價」：方案未作廢才出現，沿用現有 `data-act="unitprice"`；確認文字改成「確定將這堂的金額改為 NT$N？原本的折扣會一併清除，薪資將依新金額計算。」
  - 「退款」：`single.refundable_booking_id` 有值才出現（`data-act="refund"`、`data-booking`）。確認文字：「退款 NT$X？」＋（狀態是已預約或已上完時）「這堂預約會一併取消、時段釋出。」＋「會記錄退款時間並通知客人；實際退款請自行匯回。退款後這張單堂方案就結束，不能再改約。」成功後 toast「已標記退款，已通知客人」並重繪方案區。
  - 「作廢」：`state === 'credit'` 才出現，沿用 `data-act="archive"`；確認文字：「作廢這 1 堂？作廢＝不退款，這 1 堂失效；不會通知客人，之後也不能再對這張方案退款。要退錢請改按「退款」。」
- 錯誤訊息對照補上：`online_single_readonly`、`has_active_booking`、`package_closed`、`credit_in_use`（文字見 Global Constraints）、`not_paid`「這堂尚未核對收款」、`already_refunded`「這堂已退款過」。

- [ ] **Step 2: 已核對清單的長按退款**

錯誤訊息對照補 `package_closed`、`credit_in_use`；整批退款成功且 `r.skipped?.length` 時，toast 改為「已退款 N 堂；另有 M 堂已改約或已結束，未處理」。

- [ ] **Step 3: 本機實際點過**

起本機站，用線上預約與後台操作做出這些卡片，Playwright 逐一確認並截圖（桌機與手機寬度各一張）：已預約・待核對（只有改單價）／已預約・已核對（改單價、退款）／保留 1 堂（改單價、退款、作廢）／已取消・已退款（沒有按鈕）／已作廢／「預約已改到其他方案」；同一位會員的 10 堂方案卡外觀與按鈕不變。動作：按退款 → 卡片變已取消・已退款；按作廢 → 變已作廢；對已預約的卡用 API 直接打作廢 → toast 是「這堂還有未取消的預約，請先取消預約」。瀏覽器 console 沒有錯誤。

- [ ] **Step 4: 跑全套測試（✗ 為 0）後 Commit**（`後台會員方案區：線上單堂卡（上課時間、教練、金額、付款狀態、退款與作廢）`）

---

### Task 11: 教練端文字（`public/coach.js`）

**Files:**
- Modify: `public/coach.js`（`pkgSourceLabel`／`renderBkeditBody` 約 `958-971`、`doBkCancel` 約 `1000-1002`、`doBkCancelGroup` 約 `1014`、改掛下拉與錯誤訊息約 `1067-1073`、登錄下拉約 `1303`）

**Interfaces:**
- Consumes: 週曆預約的 `pkg_source`、`paid_at`、`discount_code`（Task 2）；方案清單的 `source`。

- [ ] **Step 1: 實作**

- 編輯預約彈窗「來源」：`pkg_source === 'online'` →「線上預約」，有折扣碼 →「線上預約 · 折扣碼 X」；其餘照舊。
- 取消確認的加註：教練開立的方案 →「（將回補 1 堂方案）」；線上單堂且已付款 →「（已付款，會保留 1 堂可改約）」；線上單堂未付款或沒有方案 → 不加註。
- 「取消全部預約」確認文字：這筆是線上單堂時，後半句改成「此循環（含已過去）的所有未取消預約將一併取消；已付款的會各保留 1 堂可改約。」；其餘照舊。
- 兩個方案下拉（登錄彈窗、改客人／方案）：`p.source === 'online'` 的選項文字後面加「・線上單堂」。
- 改客人／方案的錯誤訊息對照補 `paid_online_single`（文字見 Global Constraints）。

- [ ] **Step 2: 本機實際點過**

Playwright 確認並截圖：線上預約的編輯彈窗來源文字（有、沒有折扣碼各一）；已付款與未付款的取消確認文字（攔 `dialog` 事件讀文字後按取消，不真的取消）；保留 1 堂的客人在登錄彈窗下拉看到「・線上單堂」；已付款的線上預約按「改客人/方案」送出 → toast 是規定文字；10 堂方案的預約各處文字不變。console 沒有錯誤。

- [ ] **Step 3: 跑全套測試（✗ 為 0）後 Commit**（`教練端：線上預約的來源、取消提示、方案下拉加註與改掛訊息`）

---

### Task 12: 收尾驗證＋開 draft PR

**Files:**
- Modify: `docs/superpowers/specs/2026-11-14-online-single-as-package-design.md`（狀態列加一行「第一階段已實作，見 plans/2026-11-14-online-single-as-package.md」）

- [ ] **Step 1: 分流點再掃一次**

Run: `grep -rn -E "package_id|pkg_|walkin|散客|方案登錄" src public --include='*.js' --include='*.html'`
逐一對照規格「連動處理」的表。已知的點：`payrollService`（來源標籤）、`renewalReminderService`、`coachCalendarService`（`BK_COLS`）、`gcalPull`（`refund_note` 用 `r.refunded`）、`packageService`、`bookingService`、`coach.js`（來源、取消確認、下拉）、`admin.js`（`SRC_LABEL`、方案區）。出現清單以外、會因為「線上預約現在有方案」而改變結果的地方 → 補測試並修正。

- [ ] **Step 2: 全套測試**

Run: `DB_PATH="$(mktemp -d)/t.db" npm test`，輸出存檔。Expected: ✗ 為 0；✓ ＝ 992＋新增數（把實際數字記下來，PR 說明要寫）。

- [ ] **Step 3: API 測試**

`test:api` 整條鏈在 `main` 上本來就有失敗，不能用整條鏈當標準。做法：分支與 `main`（另開一個暫時的 worktree）各起一個本機站（各自的暫存資料庫＋seed），逐檔跑下列檔案並比對：`online-single-api`（只有分支有）、`booking-payment-api`、`refund-api`、`booking-admin-cancel-api`、`booking-edit-api`、`coach-register-api`、`my-schedule-packages-api`、`payroll-api`、`discount-api`、`admin-backfill-api`、`public-api`、`booking-companion-api`、`booking-validate-api`、`package-api`、`package-unit-price-api`、`package-discount-api`。Expected: `online-single-api` 全 ✓；其餘每一檔的 ✗ 不比 `main` 多。跑完把暫時的 worktree 移除。

- [ ] **Step 4: 用正式資料結構的副本開機一次**

把本機示範資料庫複製一份當 `DB_PATH` 啟動分支的伺服器。Expected: 補登 log 的筆數＝啟動前 `SELECT COUNT(*) FROM bookings WHERE status='confirmed' AND package_id IS NULL` 的數字；`GET /api/admin/packages/summary` 的 `confirmedWithoutPackage` 為 0；隨手開兩位有線上預約的會員，方案區看得到單堂卡。

- [ ] **Step 5: Commit 規格狀態、push、開 draft PR**

PR 標題「線上單堂轉方案（第一階段）」。說明寫：做了什麼（對照規格八條規則）、測試數字、Review Focus 五點各自的測試位置、「計畫裡補的判斷」清單、下面的上線步驟；結尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

---

## 上線步驟（不是實作任務；由負責的人與業主一起做）

1. **合併前**：用業主已登入的後台分頁唯讀統計正式站各期薪資明細裡標「散客」的堂數與會員數（就是會補登的範圍），列給業主確認。只讀、不碰帳密，結果不留存。
2. 業主本機預覽（Task 12 Step 4 的那份副本）確認單堂卡與連動行為。
3. 業主明確說合併才合併；先 `git push` 再呼叫合併。部署開機時自動補登。
4. 上線後：部署狀態 success → 請業主開後台，用 `GET /api/admin/packages/summary` 確認補登筆數與步驟 1 一致、`confirmedWithoutPackage` 為 0；再看周善美的方案區。
5. 若開機 log 是 `backfill skipped`：網站照常運作（沒有方案的舊預約本來就能正常使用），查明原因後下次開機會再試一次。
6. 第二階段（後台「方案」頁籤）：出幾個版面給業主挑，選定後另排計畫。到時新增的 `/api/admin/packages/:id` 路由要放在 `/api/admin/packages/summary` 之後。
