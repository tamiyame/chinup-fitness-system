# LINE 通知開關＋本月推播額度進度條 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台 LINE 管理頁籤能用總開關＋16 個事件項目控制 LINE 推播（部署即全關），並以遊戲血條顯示本月免費推播額度剩餘與重置時間。

**Architecture:** 新檔 `lineNotifyPolicy.js` 持有項目目錄（type → item）與 `app_settings` 讀寫；`notifications.js` 的 `notify()` 與重試器各加一個判定點（關閉＝只記錄／標 permanent）。額度來自 LINE 官方兩支查詢端點（`lineClient.js` 加 GET 包裝）＋新檔 `lineQuota.js` 推算重置時間；`server.js` 加三支 admin 端點；`admin.html`／`admin.js` 在 LINE 頁籤加兩個區塊。

**Tech Stack:** Node ESM + node:sqlite、Express、vanilla JS 前端、plain-node assert 測試（`expect(label, fn)` 慣例）。

**Spec:** `docs/superpowers/specs/2026-09-08-line-notify-toggles-design.md`

## Global Constraints

- 設定 key：`line_notify_master`（未設定＝**OFF**）、`line_notify_<item_key>`（未設定＝ON）；值 `'1'`／`'0'`。
- 有效判定：`master ON && item ON`；type 不在目錄（`registered_confirmed`、`registered_waitlisted`、`promoted`、`registration_cancelled`、`course_confirmed`）→ 只受總開關管。
- `lineNotifyPolicy.js` **不得 import `discountService.js`**（模組循環）；`ApiError` 從 `./registration.js` import，只在函式呼叫時使用（間接循環 registration → notifications → 本檔 對「呼叫時取用」安全）。
- 關閉時 `notify()` 走既有 `deliverConsole`（`channel='console'`、`status='sent'`）；重試器對關閉的 LINE 列 `updateFailedPermanent.run('line_notify_off', row.id)`。
- 綁定回覆（reply API）與 email 通道不受影響；`notifications.js` 其餘一行不動。
- 額度端點回應形狀（LINE 官方）：`GET /v2/bot/message/quota` → `{ type: 'none'|'limited', value? }`；`GET /v2/bot/message/quota/consumption` → `{ totalUsage }`。重置＝台灣本地「當月最後一天 23:00:00」（LINE 以 UTC+9 每月 1 日 00:00 重置）。
- 後台 CSS 一律放 `public/admin.html` inline；開關與血條方角（`border-radius:0`）；天藍用 `var(--brand-500)`、警示 `var(--warn-fg)`、危險 `var(--err-fg)`、髮絲線 `var(--line)`、墨色 `var(--ink)`、灰字 `var(--ink-mute)`（皆為 `colors_and_type.css` 既有 token）。
- 單元測試一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴，**絕不對 `data/app.db` 跑**；API 測試需 running server，跑完 `npm run seed`。
- 全程繁體中文註解與 UI 文案；commit 訊息繁體中文，結尾附 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/services/lineNotifyPolicy.js`（新） | 項目目錄常數、`isLineNotifyEnabled(type)`、`getLineNotifyState()`、`setLineNotifyState()` |
| `src/services/notifications.js`（改） | `notify()` 與 `processFailedNotifications()` 各加一個判定 |
| `src/services/lineClient.js`（改） | `_get()`、`getQuota()`、`getQuotaConsumption()`（mock-aware） |
| `src/services/lineQuota.js`（新） | `nextQuotaResetLocal()` 純函式、`getLineQuotaStatus()` |
| `src/server.js`（改） | `GET/PATCH /api/admin/line-notify`、`GET /api/admin/line-quota` |
| `public/admin.html`（改） | LINE 頁籤兩個新 section＋inline CSS |
| `public/admin.js`（改） | `loadLineNotify`／`renderLineNotify`／`patchLineNotify`、`loadLineQuota`／`renderLineQuota` |
| `tests/line-notify-policy.test.js`（新） | 目錄、預設、讀寫、判定、`notify()` 走向、重試器 |
| `tests/line-quota.test.js`（新） | 重置推算、mock client、狀態組裝 |
| `tests/line-notify-api.test.js`（新） | 三支端點：形狀、寫入、400、401、403 |
| `tests/notifications-flow.test.js`（改） | 開頭把總開關設 ON |
| `package.json`（改） | `test` 鏈加兩檔、`test:api` 鏈加一檔 |

---

### Task 1: 項目目錄與設定讀寫（`lineNotifyPolicy.js`）

**Files:**
- Create: `src/services/lineNotifyPolicy.js`
- Test: `tests/line-notify-policy.test.js`（本任務只寫目錄／預設／讀寫／判定四段；Task 2 再追加 `notify()` 與重試器段）

**Interfaces:**
- Consumes: `db`, `tx` from `../db/connection.js`；`ApiError(status, code)` from `./registration.js`；`app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`。
- Produces（Task 2／4／5 依賴）：
  - `export const LINE_NOTIFY_GROUPS` — `[{ key, label, items: [{ key, label, recipients, types: string[] }] }]`
  - `export function isLineNotifyEnabled(type: string): boolean`
  - `export function getLineNotifyState(): { master: boolean, groups: [{ key, label, items: [{ key, label, recipients, enabled: boolean }] }] }`
  - `export function setLineNotifyState({ master?: boolean, items?: Record<string, boolean> }): 同 getLineNotifyState()`（驗證失敗丟 `ApiError(400, code)`，不寫入）

- [ ] **Step 1: 寫失敗測試**

建立 `tests/line-notify-policy.test.js`：

```js
// LINE 通知開關：目錄完整性、預設值、讀寫驗證、isLineNotifyEnabled；
// 後段（Task 2 追加）驗 notify() 走向與重試器。fresh DB、LINE_MOCK=1。
process.env.LINE_MOCK = '1';
import assert from 'node:assert/strict';
import { db, offsetLocal } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { LINE_NOTIFY_GROUPS, isLineNotifyEnabled, getLineNotifyState, setLineNotifyState } from '../src/services/lineNotifyPolicy.js';
import { notify, processFailedNotifications } from '../src/services/notifications.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function throwsApi(fn, status, code) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert(err, 'expected throw');
  assert.equal(err.status, status);
  assert.equal(err.code, code);
}
const clearSettings = () => db.exec("DELETE FROM app_settings WHERE key LIKE 'line_notify_%'");
const allItems = () => LINE_NOTIFY_GROUPS.flatMap((g) => g.items);

// 31 種現役推播模板（2026-09-08 盤點；legacy 4 種＋已停用會員 course_confirmed 不在內）
const ACTIVE_TYPES = [
  'booking_created', 'booking_confirmed', 'booking_recurring_created', 'booking_recurring_created_coach',
  'booking_payment_received', 'booking_rescheduled', 'booking_rescheduled_coach',
  'booking_cancelled_by_coach', 'booking_cancelled_by_shop', 'booking_refunded',
  'booking_cancelled_by_member', 'booking_cancelled_by_shop_coach',
  'payment_received', 'course_registered_coach', 'course_registered_coach_batch',
  'course_registered_admin', 'course_registered_admin_batch',
  'group_promoted', 'course_waitlisted_coach', 'course_promoted_coach',
  'course_member_cancelled_coach', 'course_member_leave_coach',
  'course_confirmed_coach', 'course_cancelled_coach', 'course_cancelled',
  'group_order_refunded', 'package_low_sessions', 'group_last_session',
  'gcal_move_rejected', 'gcal_delete_cancelled', 'period_rollover_admin',
];

console.log('[line-notify-policy test] start');
clearSettings();

// ── 目錄 ──
expect('3 組 16 項、項目 key 唯一', () => {
  assert.equal(LINE_NOTIFY_GROUPS.length, 3);
  assert.deepEqual(LINE_NOTIFY_GROUPS.map((g) => g.key), ['one_on_one', 'group', 'system']);
  const items = allItems();
  assert.equal(items.length, 16);
  assert.equal(new Set(items.map((i) => i.key)).size, 16);
});
expect('每個 type 只屬一個項目、31 個現役 type 全涵蓋、無多餘', () => {
  const all = allItems().flatMap((i) => i.types);
  assert.equal(new Set(all).size, all.length);
  for (const t of ACTIVE_TYPES) assert(all.includes(t), `missing ${t}`);
  assert.equal(all.length, ACTIVE_TYPES.length);
});

// ── 預設 ──
expect('預設：總開關 OFF、項目全 ON、state 不帶 types', () => {
  const s = getLineNotifyState();
  assert.equal(s.master, false);
  assert.equal(s.groups.length, 3);
  for (const g of s.groups) for (const i of g.items) {
    assert.equal(i.enabled, true);
    assert.equal(i.types, undefined);
    assert.equal(typeof i.label, 'string');
    assert.equal(typeof i.recipients, 'string');
  }
});
expect('預設 isLineNotifyEnabled 全 false（含 legacy type）', () => {
  assert.equal(isLineNotifyEnabled('booking_created'), false);
  assert.equal(isLineNotifyEnabled('registered_confirmed'), false);
});

// ── 讀寫 ──
expect('setLineNotifyState({ master: true }) → 現役與 legacy 皆 true', () => {
  const s = setLineNotifyState({ master: true });
  assert.equal(s.master, true);
  assert.equal(isLineNotifyEnabled('booking_created'), true);
  assert.equal(isLineNotifyEnabled('registered_confirmed'), true);
});
expect('關單一項目只影響該項目的 type', () => {
  const s = setLineNotifyState({ items: { booking_new: false } });
  const item = s.groups.flatMap((g) => g.items).find((i) => i.key === 'booking_new');
  assert.equal(item.enabled, false);
  assert.equal(isLineNotifyEnabled('booking_created'), false);
  assert.equal(isLineNotifyEnabled('booking_confirmed'), true);
  assert.equal(isLineNotifyEnabled('registered_confirmed'), true);
});
expect('總開關 OFF 蓋過項目 ON（項目值仍存 1）', () => {
  setLineNotifyState({ master: false, items: { booking_new: true } });
  assert.equal(isLineNotifyEnabled('booking_created'), false);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'line_notify_booking_new'").get().value, '1');
});

// ── 驗證 ──
expect('未知項目 key → 400 invalid_line_notify_item，且整包不寫入', () => {
  throwsApi(() => setLineNotifyState({ master: true, items: { nope: true } }), 400, 'invalid_line_notify_item');
  assert.equal(getLineNotifyState().master, false);
});
expect('master 非 boolean → 400 invalid_line_notify_master', () => {
  throwsApi(() => setLineNotifyState({ master: 'yes' }), 400, 'invalid_line_notify_master');
});
expect('項目值非 boolean → 400 invalid_line_notify_value', () => {
  throwsApi(() => setLineNotifyState({ items: { booking_new: 1 } }), 400, 'invalid_line_notify_value');
});
expect('items 非物件 → 400 invalid_line_notify_item', () => {
  throwsApi(() => setLineNotifyState({ items: ['booking_new'] }), 400, 'invalid_line_notify_item');
});
expect('空物件 → 不動、回傳目前狀態', () => {
  const s = setLineNotifyState({});
  assert.equal(s.master, false);
});

// （Task 2 在此之後追加 notify() 走向與重試器段）
console.log('[line-notify-policy test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/line-notify-policy.test.js`
Expected: 匯入失敗 `Cannot find module '.../lineNotifyPolicy.js'`

- [ ] **Step 3: 寫實作**

建立 `src/services/lineNotifyPolicy.js`：

```js
// LINE 推播開關：總開關＋依事件分 3 組 16 項。所有 LINE 推播共用 notify() 一個入口，
// 本檔只回答「這個 type 現在可不可以推 LINE」（關閉時 notify() 走只記錄路徑）。
// 設定存 app_settings：line_notify_master（未設定＝OFF）、line_notify_<item>（未設定＝ON）。
// 不 import discountService.js：它經 registration.js → notifications.js 回頭 import 本檔會循環，
// 語句自備。ApiError 只在函式呼叫時取用，經 registration.js 的間接循環對此安全。
import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

export const LINE_NOTIFY_GROUPS = [
  { key: 'one_on_one', label: '一對一教練課', items: [
    { key: 'booking_new', label: '新預約', recipients: '教練＋管理者', types: ['booking_created'] },
    { key: 'booking_confirmed_member', label: '預約成功', recipients: '會員', types: ['booking_confirmed'] },
    { key: 'booking_recurring', label: '循環登錄排定', recipients: '會員摘要＋教練', types: ['booking_recurring_created', 'booking_recurring_created_coach'] },
    { key: 'booking_payment', label: '款項已確認', recipients: '會員', types: ['booking_payment_received'] },
    { key: 'booking_reschedule', label: '改期', recipients: '會員＋教練', types: ['booking_rescheduled', 'booking_rescheduled_coach'] },
    { key: 'booking_cancel_member', label: '預約取消／退款', recipients: '會員', types: ['booking_cancelled_by_coach', 'booking_cancelled_by_shop', 'booking_refunded'] },
    { key: 'booking_cancel_coach', label: '預約取消', recipients: '教練', types: ['booking_cancelled_by_member', 'booking_cancelled_by_shop_coach'] },
  ] },
  { key: 'group', label: '團體課程', items: [
    { key: 'group_payment', label: '匯款已收到', recipients: '會員', types: ['payment_received'] },
    { key: 'group_registered_staff', label: '新報名', recipients: '教練＋管理者', types: ['course_registered_coach', 'course_registered_coach_batch', 'course_registered_admin', 'course_registered_admin_batch'] },
    { key: 'group_waitlist', label: '候補與遞補', recipients: '候補會員＋教練', types: ['group_promoted', 'course_waitlisted_coach', 'course_promoted_coach'] },
    { key: 'group_member_cancel_coach', label: '會員取消／請假', recipients: '教練', types: ['course_member_cancelled_coach', 'course_member_leave_coach'] },
    { key: 'group_session_outcome', label: '成班／未開課判定', recipients: '教練＋未開課會員', types: ['course_confirmed_coach', 'course_cancelled_coach', 'course_cancelled'] },
    { key: 'group_refund', label: '訂單退款', recipients: '會員', types: ['group_order_refunded'] },
  ] },
  { key: 'system', label: '排程與系統', items: [
    { key: 'renewal_reminder', label: '續購提醒', recipients: '會員', types: ['package_low_sessions', 'group_last_session'] },
    { key: 'gcal_sync', label: 'Google 日曆同步', recipients: '教練退回＋管理者取消', types: ['gcal_move_rejected', 'gcal_delete_cancelled'] },
    { key: 'period_rollover', label: '期課續期', recipients: '管理者', types: ['period_rollover_admin'] },
  ] },
];

const MASTER_KEY = 'line_notify_master';
const itemSettingKey = (itemKey) => `line_notify_${itemKey}`;

const TYPE_TO_ITEM = new Map();
const ITEM_KEYS = new Set();
for (const g of LINE_NOTIFY_GROUPS) {
  for (const it of g.items) {
    ITEM_KEYS.add(it.key);
    for (const t of it.types) TYPE_TO_ITEM.set(t, it.key);
  }
}

const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function readFlag(key, fallback) {
  const row = getStmt.get(key);
  return row ? row.value === '1' : fallback;
}
const isMasterOn = () => readFlag(MASTER_KEY, false);
const isItemOn = (itemKey) => readFlag(itemSettingKey(itemKey), true);

/** 該通知 type 現在可否推 LINE。不在目錄的 type（legacy／已停用模板）只受總開關管。 */
export function isLineNotifyEnabled(type) {
  if (!isMasterOn()) return false;
  const itemKey = TYPE_TO_ITEM.get(type);
  return itemKey ? isItemOn(itemKey) : true;
}

export function getLineNotifyState() {
  return {
    master: isMasterOn(),
    groups: LINE_NOTIFY_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.map((it) => ({ key: it.key, label: it.label, recipients: it.recipients, enabled: isItemOn(it.key) })),
    })),
  };
}

/** 先全部驗證再一次寫入（同 /api/admin/settings 的「全通過才寫」原則）。 */
export function setLineNotifyState({ master, items } = {}) {
  const writes = [];
  if (master !== undefined) {
    if (typeof master !== 'boolean') throw new ApiError(400, 'invalid_line_notify_master');
    writes.push([MASTER_KEY, master ? '1' : '0']);
  }
  if (items !== undefined) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw new ApiError(400, 'invalid_line_notify_item');
    for (const [key, value] of Object.entries(items)) {
      if (!ITEM_KEYS.has(key)) throw new ApiError(400, 'invalid_line_notify_item');
      if (typeof value !== 'boolean') throw new ApiError(400, 'invalid_line_notify_value');
      writes.push([itemSettingKey(key), value ? '1' : '0']);
    }
  }
  tx(() => { for (const [k, v] of writes) setStmt.run(k, v); });
  return getLineNotifyState();
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/line-notify-policy.test.js`
Expected: 全部 ✓（12 項），無 ✗

- [ ] **Step 5: Commit**

```bash
git add src/services/lineNotifyPolicy.js tests/line-notify-policy.test.js
git commit -m "feat: LINE 通知開關目錄與設定讀寫（lineNotifyPolicy）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `notify()` 與重試器的判定點

**Files:**
- Modify: `src/services/notifications.js:9-11`（import）、`:286`（notify 判定）、`:356-363`（重試器 LINE 分支）
- Modify: `tests/line-notify-policy.test.js`（檔尾追加兩段）
- Modify: `tests/notifications-flow.test.js:42`（`reset();` 之後）
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/line-notify-policy.test.js`）

**Interfaces:**
- Consumes: `isLineNotifyEnabled(type)` from `./lineNotifyPolicy.js`（Task 1）；既有 `deliverLine`／`deliverConsole`／`updateFailedPermanent`。
- Produces: 無新介面；行為＝關閉時 `notify()` 寫 console 列、重試器把關閉的 LINE 列標 `failed_permanent`／`line_notify_off`。

- [ ] **Step 1: 追加失敗測試**

在 `tests/line-notify-policy.test.js` 的 `// （Task 2 在此之後追加…）` 那行**取代**為：

```js
// ── notify() 走向（會員有綁 LINE；LINE_MOCK=1 推播必成功）──
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lnp-%');
  DELETE FROM users WHERE email LIKE 'lnp-%';
`);
const member = Number(db.prepare(
  "INSERT INTO users (name, email, password_hash, role, line_user_id) VALUES ('LNP Member', 'lnp-member@x.com', ?, 'user', ?)"
).run(hashPassword('x'), 'Ulnp' + Date.now()).lastInsertRowid);
const tick = () => new Promise((r) => setImmediate(r));
const lastRow = (type) => db.prepare(
  'SELECT channel, status, last_error FROM notifications WHERE user_id = ? AND type = ? ORDER BY id DESC LIMIT 1'
).get(member, type);
const ROLL_VARS = { period_label: '9–10 月', summary: 'LNP 課 9 場' };

setLineNotifyState({ master: false });
notify({ userId: member, sessionId: null, type: 'period_rollover_admin', vars: ROLL_VARS });
await tick();
expect('總開關 OFF：有綁 LINE 仍寫 console 列（只記錄）', () => {
  const r = lastRow('period_rollover_admin');
  assert.equal(r.channel, 'console');
  assert.equal(r.status, 'sent');
});

setLineNotifyState({ master: true, items: { period_rollover: false } });
notify({ userId: member, sessionId: null, type: 'period_rollover_admin', vars: ROLL_VARS });
await tick();
expect('總開關 ON、項目 OFF：console 列', () => assert.equal(lastRow('period_rollover_admin').channel, 'console'));

setLineNotifyState({ items: { period_rollover: true } });
notify({ userId: member, sessionId: null, type: 'period_rollover_admin', vars: ROLL_VARS });
await tick();
expect('ON／ON：line 列 sent（mock）', () => {
  const r = lastRow('period_rollover_admin');
  assert.equal(r.channel, 'line');
  assert.equal(r.status, 'sent');
});

// ── 重試器：關閉期間到期的 LINE 失敗列 → failed_permanent／line_notify_off，不補送 ──
const insertFailed = () => Number(db.prepare(`
  INSERT INTO notifications (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, NULL, 'booking_created', 'line', 'LNP', 'LNP body', 'failed', 0, ?, 'HTTP 429')
`).run(member, offsetLocal(-60 * 1000)).lastInsertRowid);
const rowOf = (id) => db.prepare('SELECT status, last_error FROM notifications WHERE id = ?').get(id);

setLineNotifyState({ master: false });
const f1 = insertFailed();
await processFailedNotifications();
expect('總開關 OFF：到期失敗列 → failed_permanent / line_notify_off', () => {
  assert.equal(rowOf(f1).status, 'failed_permanent');
  assert.equal(rowOf(f1).last_error, 'line_notify_off');
});

setLineNotifyState({ master: true, items: { booking_new: false } });
const f2 = insertFailed();
await processFailedNotifications();
expect('項目 OFF：同樣 failed_permanent / line_notify_off', () => {
  assert.equal(rowOf(f2).status, 'failed_permanent');
  assert.equal(rowOf(f2).last_error, 'line_notify_off');
});

setLineNotifyState({ items: { booking_new: true } });
const f3 = insertFailed();
await processFailedNotifications();
expect('ON／ON：重試成功 sent', () => assert.equal(rowOf(f3).status, 'sent'));

console.log('[line-notify-policy test] done');
```

（原本檔尾的 `console.log('[line-notify-policy test] done');` 一併被取代，避免重複。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/line-notify-policy.test.js`
Expected: 前 12 項 ✓；「總開關 OFF：有綁 LINE 仍寫 console 列」✗（實際 channel 為 `line`）、「總開關 OFF：到期失敗列 → failed_permanent」✗（實際 `sent`）等。

- [ ] **Step 3: 改 `notifications.js`**

(a) import 區（第 9–11 行後）加一行：

```js
import { isLineNotifyEnabled } from './lineNotifyPolicy.js';
```

(b) `notify()` 內把

```js
  if (user.line_user_id) {
```

改成

```js
  if (user.line_user_id && isLineNotifyEnabled(type)) {
```

並把該 `if` 上方的註解補一句：`// 總開關／項目關閉時與未綁定者相同：只記錄不推播。`

(c) `processFailedNotifications()` 的 `} else {` 分支開頭（`const user = getUserById.get(row.user_id);` 之前）加：

```js
        if (!isLineNotifyEnabled(row.type)) {
          // 開關關閉期間不補送（之後開回來也不補），與 notify() 關閉時只記錄一致
          updateFailedPermanent.run('line_notify_off', row.id);
          continue;
        }
```

(d) 檔頭註解第 3–5 行的說明改為：

```js
// internally picks a delivery channel based on the user's binding state
// and the admin LINE notify switches (lineNotifyPolicy.js):
//   user.line_user_id present AND switches allow → LINE Push (via lineClient.sendMessage)
//   otherwise                                     → console.log fallback (dev / unbound / switched off)
```

- [ ] **Step 4: 跑測試確認通過**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/line-notify-policy.test.js`
Expected: 全部 ✓（18 項）

- [ ] **Step 5: 修既有 `notifications-flow.test.js`**

import 區加：

```js
import { setLineNotifyState } from '../src/services/lineNotifyPolicy.js';
```

第 42 行 `reset();` 之後加：

```js
setLineNotifyState({ master: true });  // 總開關預設 OFF；本測試驗的是 LINE 推播路徑
```

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/notifications-flow.test.js`
Expected: 全部 ✓

- [ ] **Step 6: 加入測試鏈並跑完整鏈**

`package.json` 的 `"test"` 字串結尾（`node tests/period-rollover.test.js` 之後）加 ` && node tests/line-notify-policy.test.js`。

Run: `DB_PATH="$(mktemp -d)/t.db" npm test 2>&1 | grep -E "✗|Error|done\]" | head -40`
Expected: 無 ✗、無 Error；最後一行含 `[line-notify-policy test] done`

- [ ] **Step 7: Commit**

```bash
git add src/services/notifications.js tests/line-notify-policy.test.js tests/notifications-flow.test.js package.json
git commit -m "feat: notify() 與重試器尊重 LINE 通知開關（關閉＝只記錄、不補送）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 額度查詢（`lineClient.js` GET 包裝＋`lineQuota.js`）

**Files:**
- Modify: `src/services/lineClient.js:6-7`（URL 常數）、`:11-33` 之後（新 `_get`）、`:36-46` 之後（兩個 export）
- Create: `src/services/lineQuota.js`
- Test: `tests/line-quota.test.js`
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/line-quota.test.js`）

**Interfaces:**
- Consumes: 既有 `process.env.LINE_MOCK`／`LINE_CHANNEL_ACCESS_TOKEN` 慣例；`nowLocal()` from `../db/connection.js`。
- Produces（Task 4 依賴）：
  - `lineClient.js`：`export async function getQuota(): Promise<{ ok: true, data: { type: 'none'|'limited', value?: number } } | { ok: false, error: string }>`、`export async function getQuotaConsumption(): Promise<{ ok: true, data: { totalUsage: number } } | { ok: false, error: string }>`
  - `lineQuota.js`：`export function nextQuotaResetLocal(nowLocalStr: string): string`、`export async function getLineQuotaStatus(): Promise<{ configured, limitType, limit, used, remaining, pct, resetAt, fetchedAt, error }>`

- [ ] **Step 1: 寫失敗測試**

建立 `tests/line-quota.test.js`：

```js
// 本月 LINE 推播額度：重置時間推算（純函式）、mock client、狀態組裝三種結果。
import assert from 'node:assert/strict';
import { nextQuotaResetLocal, getLineQuotaStatus } from '../src/services/lineQuota.js';
import { getQuota, getQuotaConsumption } from '../src/services/lineClient.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[line-quota test] start');

// ── nextQuotaResetLocal：當月最後一天 23:00；已過則下個月 ──
for (const [input, expected] of [
  ['2026-09-08T14:00:00', '2026-09-30T23:00:00'],
  ['2026-09-30T22:59:59', '2026-09-30T23:00:00'],
  ['2026-09-30T23:00:00', '2026-10-31T23:00:00'],
  ['2026-12-31T23:00:00', '2027-01-31T23:00:00'],
  ['2028-02-10T00:00:00', '2028-02-29T23:00:00'],
]) {
  expect(`nextQuotaResetLocal(${input}) → ${expected}`, () => assert.equal(nextQuotaResetLocal(input), expected));
}

// ── mock client ──
process.env.LINE_MOCK = '1';
const q1 = await getQuota();
const c1 = await getQuotaConsumption();
expect('LINE_MOCK=1：getQuota 回 limited 200、getQuotaConsumption 回 0', () => {
  assert.deepEqual(q1, { ok: true, data: { type: 'limited', value: 200 } });
  assert.deepEqual(c1, { ok: true, data: { totalUsage: 0 } });
});

// ── 狀態組裝 ──
const s1 = await getLineQuotaStatus();
expect('mock 1：configured、limited 200、used 0、remaining 200、pct 100、resetAt 為 23:00:00', () => {
  assert.equal(s1.configured, true);
  assert.equal(s1.limitType, 'limited');
  assert.equal(s1.limit, 200);
  assert.equal(s1.used, 0);
  assert.equal(s1.remaining, 200);
  assert.equal(s1.pct, 100);
  assert.equal(s1.error, null);
  assert.match(s1.resetAt, /^\d{4}-\d{2}-\d{2}T23:00:00$/);
  assert.match(s1.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

process.env.LINE_MOCK = 'fail';
const s2 = await getLineQuotaStatus();
expect('mock fail：configured 但 error=mock_fail、數字全 null', () => {
  assert.equal(s2.configured, true);
  assert.equal(s2.error, 'mock_fail');
  for (const k of ['limitType', 'limit', 'used', 'remaining', 'pct']) assert.equal(s2[k], null, k);
  assert.match(s2.resetAt, /T23:00:00$/);
});

delete process.env.LINE_MOCK;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
const s3 = await getLineQuotaStatus();
expect('未設定 token：configured=false、error=null', () => {
  assert.equal(s3.configured, false);
  assert.equal(s3.error, null);
  assert.equal(s3.limit, null);
});

console.log('[line-quota test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/line-quota.test.js`
Expected: 匯入失敗 `Cannot find module '.../lineQuota.js'`

- [ ] **Step 3: 改 `lineClient.js`**

(a) 第 6–7 行的 URL 常數後加：

```js
const QUOTA_URL = 'https://api.line.me/v2/bot/message/quota';
const QUOTA_CONSUMPTION_URL = 'https://api.line.me/v2/bot/message/quota/consumption';
```

(b) `_post` 函式之後加：

```js
// Internal helper: GET with bearer token. Same mock / not-configured / error
// conventions as _post. Returns { ok: true, data } on 2xx JSON, { ok: false, error } otherwise.
async function _get(url) {
  if (process.env.LINE_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, error: 'line_not_configured' };
  }
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    let data;
    try { data = await res.json(); } catch { return { ok: false, error: 'invalid_json' }; }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}
```

(c) `reply()` 之前（或 `sendMessage()` 之後）加：

```js
/**
 * 本月推播上限（免費＋加購合計）。LINE 回 { type: 'limited', value } 或 { type: 'none' }。
 * 查詢端點不消耗推播額度。LINE_MOCK=1 回固定 limited 200。
 */
export async function getQuota() {
  if (process.env.LINE_MOCK === '1') return { ok: true, data: { type: 'limited', value: 200 } };
  return _get(QUOTA_URL);
}

/**
 * 本月已發推播數（近似值，含 LINE Official Account Manager 手動群發）。
 * LINE 回 { totalUsage }。LINE_MOCK=1 回 0。
 */
export async function getQuotaConsumption() {
  if (process.env.LINE_MOCK === '1') return { ok: true, data: { totalUsage: 0 } };
  return _get(QUOTA_CONSUMPTION_URL);
}
```

- [ ] **Step 4: 建立 `lineQuota.js`**

```js
// 本月 LINE 推播額度：LINE 官方 quota／consumption 兩支查詢端點＋重置時間推算。
// LINE 月度統計以 UTC+9 計、每月 1 日 00:00 重置 ＝ 台灣時間「當月最後一天 23:00」。
import { nowLocal } from '../db/connection.js';
import { getQuota, getQuotaConsumption } from './lineClient.js';

const pad = (n) => String(n).padStart(2, '0');

// 該年月（m0 為 0-based）的重置時刻：最後一天 23:00:00（台灣本地字串）
function resetOfMonth(y, m0) {
  const lastDay = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return `${y}-${pad(m0 + 1)}-${pad(lastDay)}T23:00:00`;
}

/** 下一次額度重置的台灣本地時間（YYYY-MM-DDTHH:MM:SS）。now 已到達當月重置時刻則回下個月。 */
export function nextQuotaResetLocal(nowLocalStr) {
  const m = /^(\d{4})-(\d{2})/.exec(nowLocalStr);
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const thisMonth = resetOfMonth(y, m0);
  if (nowLocalStr < thisMonth) return thisMonth;  // 同格式字串比較即時間比較
  const next = new Date(Date.UTC(y, m0 + 1, 1));
  return resetOfMonth(next.getUTCFullYear(), next.getUTCMonth());
}

/**
 * 組裝後台額度卡需要的狀態。任一端點失敗 → error 帶原因、數字欄位 null；
 * 未設定 token → configured=false（error 仍 null）。不做快取（後台才呼叫、LINE 限制 2,000 次/秒）。
 */
export async function getLineQuotaStatus() {
  const fetchedAt = nowLocal();
  const base = {
    configured: true, limitType: null, limit: null, used: null, remaining: null, pct: null,
    resetAt: nextQuotaResetLocal(fetchedAt), fetchedAt, error: null,
  };
  const [q, c] = await Promise.all([getQuota(), getQuotaConsumption()]);
  const failed = [q, c].find((r) => !r.ok);
  if (failed) {
    if (failed.error === 'line_not_configured') return { ...base, configured: false };
    return { ...base, error: failed.error };
  }
  const used = Number(c.data?.totalUsage ?? 0);
  if (q.data?.type !== 'limited' || typeof q.data.value !== 'number') {
    return { ...base, limitType: 'none', used };
  }
  const limit = q.data.value;
  const remaining = Math.max(limit - used, 0);
  const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  return { ...base, limitType: 'limited', limit, used, remaining, pct };
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/line-quota.test.js`
Expected: 全部 ✓（9 項）

- [ ] **Step 6: 加入測試鏈、跑既有 lineClient 測試確認不破**

`package.json` 的 `"test"` 字串結尾加 ` && node tests/line-quota.test.js`。

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/lineClient.test.js && DB_PATH="$(mktemp -d)/t.db" node tests/line-quota.test.js`
Expected: 兩檔全 ✓

- [ ] **Step 7: Commit**

```bash
git add src/services/lineClient.js src/services/lineQuota.js tests/line-quota.test.js package.json
git commit -m "feat: LINE 本月推播額度查詢（quota/consumption 包裝＋重置時間推算）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Admin API 三支端點

**Files:**
- Modify: `src/server.js:74`（import 附近）、`:1544`（`/api/admin/settings` PATCH 之後）
- Test: `tests/line-notify-api.test.js`
- Modify: `package.json`（`test:api` 鏈尾加 `&& node tests/line-notify-api.test.js`）

**Interfaces:**
- Consumes: `getLineNotifyState`／`setLineNotifyState`（Task 1）、`getLineQuotaStatus`（Task 3）、既有 `requireAdmin`、`asyncHandler`、`handleError`（`ApiError` → `{ error: code }`）。
- Produces（Task 5 依賴）：
  - `GET /api/admin/line-notify` → `getLineNotifyState()` JSON
  - `PATCH /api/admin/line-notify` body `{ master?, items? }` → 同 GET；400 `{ error: 'invalid_line_notify_*' }`
  - `GET /api/admin/line-quota` → `getLineQuotaStatus()` JSON

- [ ] **Step 1: 寫失敗測試**

建立 `tests/line-notify-api.test.js`：

```js
// API test: LINE 通知開關 GET/PATCH ＋ 本月額度 GET（需 running server）。
// 自建測試管理者(is_admin=1)與教練(is_admin=0)；跑前快照 line_notify_* 設定、跑完還原。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  // 獨立假 IP：避免整條 test:api 鏈共用預設 IP 撞 login 限流
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const itemOf = (state, key) => state.groups.flatMap((g) => g.items).find((i) => i.key === key);

console.log('[line-notify-api test] start');
const clean = () => db.exec("DELETE FROM users WHERE email LIKE 'lnapi-%'");
clean();
const PW = hashPassword('lnapipw1234');
db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('LNAPI Admin','lnapi-admin@x.com','coach',1,?)").run(PW);
db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('LNAPI Coach','lnapi-coach@x.com','coach',0,?)").run(PW);
const adminLogin = await req('POST', '/api/auth/login', { body: { email: 'lnapi-admin@x.com', password: 'lnapipw1234' } });
const adminToken = adminLogin.data?.token;
const coachLogin = await req('POST', '/api/auth/login', { body: { email: 'lnapi-coach@x.com', password: 'lnapipw1234' } });
const coachToken = coachLogin.data?.token;
expect('前置：admin / coach token 取得', () => { assert.equal(adminLogin.status, 200); assert.equal(coachLogin.status, 200); });

const snapshot = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'line_notify_%'").all();
function restore() {
  db.exec("DELETE FROM app_settings WHERE key LIKE 'line_notify_%'");
  const ins = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
  for (const r of snapshot) ins.run(r.key, r.value);
}

try {
  db.exec("DELETE FROM app_settings WHERE key LIKE 'line_notify_%'");

  const g0 = await req('GET', '/api/admin/line-notify', { token: adminToken });
  expect('GET 200：master false、3 組 16 項、欄位齊', () => {
    assert.equal(g0.status, 200);
    assert.equal(g0.data.master, false);
    assert.equal(g0.data.groups.length, 3);
    const items = g0.data.groups.flatMap((g) => g.items);
    assert.equal(items.length, 16);
    for (const i of items) {
      assert.equal(typeof i.key, 'string'); assert.equal(typeof i.label, 'string');
      assert.equal(typeof i.recipients, 'string'); assert.equal(i.enabled, true);
    }
  });

  const p1 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { master: true } });
  expect('PATCH master:true → master true', () => { assert.equal(p1.status, 200); assert.equal(p1.data.master, true); });

  const p2 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { items: { booking_new: false } } });
  expect('PATCH 單項 false → 該項 false、其餘 true、master 不動', () => {
    assert.equal(p2.status, 200);
    assert.equal(p2.data.master, true);
    assert.equal(itemOf(p2.data, 'booking_new').enabled, false);
    assert.equal(itemOf(p2.data, 'booking_confirmed_member').enabled, true);
  });

  const p3 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { items: { nope: true } } });
  expect('PATCH 未知 key → 400 invalid_line_notify_item', () => { assert.equal(p3.status, 400); assert.equal(p3.data.error, 'invalid_line_notify_item'); });
  const p4 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { master: 'yes' } });
  expect('PATCH master 非 boolean → 400 invalid_line_notify_master', () => { assert.equal(p4.status, 400); assert.equal(p4.data.error, 'invalid_line_notify_master'); });

  const u1 = await req('GET', '/api/admin/line-notify');
  expect('GET 未登入 → 401', () => assert.equal(u1.status, 401));
  const c1 = await req('GET', '/api/admin/line-notify', { token: coachToken });
  expect('GET 教練（非管理者）→ 403', () => assert.equal(c1.status, 403));
  const c2 = await req('PATCH', '/api/admin/line-notify', { token: coachToken, body: { master: false } });
  expect('PATCH 教練 → 403', () => assert.equal(c2.status, 403));

  const q1 = await req('GET', '/api/admin/line-quota', { token: adminToken });
  expect('GET line-quota 200：configured boolean、resetAt 23:00:00、fetchedAt 字串', () => {
    assert.equal(q1.status, 200);
    assert.equal(typeof q1.data.configured, 'boolean');
    assert.match(q1.data.resetAt, /T23:00:00$/);
    assert.equal(typeof q1.data.fetchedAt, 'string');
  });
  const q2 = await req('GET', '/api/admin/line-quota');
  expect('GET line-quota 未登入 → 401', () => assert.equal(q2.status, 401));
} finally {
  restore();
  clean();
}
console.log('[line-notify-api test] done');
```

- [ ] **Step 2: 啟動測試伺服器、跑測試確認失敗**

另開終端（或背景）：`LINE_MOCK=1 NODE_ENV=development PORT=3000 node --env-file-if-exists=.env src/server.js`（若 3000 已有本機 dev server 在跑，直接用它）。

Run: `node tests/line-notify-api.test.js`
Expected: GET 200 那項 ✗（實際 404）、PATCH 各項 ✗、line-quota ✗；401／403 項可能因既有 404 順序而 ✗ 或 ✓。

- [ ] **Step 3: 加端點**

`src/server.js` import 區（第 74 行 `lineClient.js` 那行之後）加：

```js
import { getLineNotifyState, setLineNotifyState } from './services/lineNotifyPolicy.js';
import { getLineQuotaStatus } from './services/lineQuota.js';
```

`app.patch('/api/admin/settings', …)` 區塊結束（`}));` 第 1544 行）之後加：

```js
// --- Admin: LINE 通知開關（總開關＋16 項目）與本月推播額度 ---
app.get('/api/admin/line-notify', requireAdmin, asyncHandler((req, res) => {
  res.json(getLineNotifyState());
}));
app.patch('/api/admin/line-notify', requireAdmin, asyncHandler((req, res) => {
  res.json(setLineNotifyState(req.body || {}));
}));
app.get('/api/admin/line-quota', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await getLineQuotaStatus());
}));
```

- [ ] **Step 4: 重啟伺服器、跑測試確認通過**

Run: `node tests/line-notify-api.test.js`
Expected: 全部 ✓（11 項）

- [ ] **Step 5: 加入 `test:api` 鏈、開機煙測**

`package.json` 的 `"test:api"` 字串結尾加 ` && node tests/line-notify-api.test.js`。

開機煙測（fresh DB、確認 import 無循環炸裂）：
`DB_PATH="$(mktemp -d)/t.db" LINE_MOCK=1 PORT=3999 node src/server.js & sleep 2; curl -s localhost:3999/api/health; kill %1`
Expected: 回 `{"ok":true…}` 之類 200 JSON、伺服器 log 無 ReferenceError。

- [ ] **Step 6: Commit**

```bash
git add src/server.js tests/line-notify-api.test.js package.json
git commit -m "feat: admin API — LINE 通知開關 GET/PATCH 與本月額度 GET

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 後台 UI（額度血條＋通知開關）

**Files:**
- Modify: `public/admin.html:297`（`.session-toggle:hover` 之後加 CSS）、`:853-854`（`#apanel-line` 開頭加兩個 section）
- Modify: `public/admin.js:988`（`doLineUnbind` 之後加兩組函式）、`:2704`（啟動鏈 `loadUsers();` 之後加兩行）

**Interfaces:**
- Consumes: `GET/PATCH /api/admin/line-notify`、`GET /api/admin/line-quota`（Task 4）；既有 `api()`、`toast()`、`escapeHtml()`（已 import 自 `/app.js`）、`.a-sec-head`／`.a-sec-tools`／`.card`／`.btn btn-ghost btn-sm`／`.badge badge-cancelled`／`.subtle text-sm`。
- Produces: 無（頁面行為）。

本任務無自動化測試（純前端、無測試框架），驗證方式為 Step 5 的 localhost 手動檢查清單；後端邏輯已由 Task 1–4 覆蓋。

- [ ] **Step 1: `admin.html` 加兩個 section**

把

```html
  <div id="apanel-line" class="tab-panel hidden">
  <section class="pb-16">
    <div class="a-sec-head">
      <h2 class="section-title">LINE 綁定管理</h2>
```

改成

```html
  <div id="apanel-line" class="tab-panel hidden">
  <section class="pb-10">
    <div class="a-sec-head">
      <h2 class="section-title">本月推播額度</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <span id="lq-fetched" class="subtle text-sm"></span>
        <button id="lq-refresh" class="btn btn-ghost btn-sm" type="button">重新整理</button>
      </div>
    </div>
    <div class="card"><div id="lq-body"><p class="subtle">載入中…</p></div></div>
  </section>

  <section class="pb-10">
    <div class="a-sec-head">
      <h2 class="section-title">LINE 通知開關</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <button id="ln-all-on" class="btn btn-ghost btn-sm" type="button">全部開啟</button>
        <button id="ln-all-off" class="btn btn-ghost btn-sm" type="button">全部關閉</button>
        <button id="ln-master" class="ln-switch" type="button" aria-pressed="false" aria-label="LINE 通知總開關">OFF</button>
      </div>
    </div>
    <p id="ln-note" class="subtle text-sm mb-3"></p>
    <div class="card p-0 overflow-hidden"><div id="ln-items" class="ln-items"></div></div>
  </section>

  <section class="pb-16">
    <div class="a-sec-head">
      <h2 class="section-title">LINE 綁定管理</h2>
```

- [ ] **Step 2: `admin.html` 加 CSS**

在 `.session-toggle:hover{ … }` 那行之後加：

```css
/* ---------- LINE 管理：通知開關 + 本月額度血條（方角、One-Sky） ---------- */
.ln-switch{
  font-family:"Archivo","Noto Sans TC",sans-serif; font-weight:800; font-size:12px; letter-spacing:.08em;
  border:1px solid var(--line); border-radius:0; background:var(--surface); color:var(--ink-mute);
  padding:3px 10px; min-width:52px; line-height:1.4; cursor:pointer;
}
.ln-switch:hover{ border-color:var(--ink-mute); }
.ln-switch.on{ background:var(--brand-500); border-color:var(--brand-500); color:var(--brand-900); }
.ln-switch:disabled{ opacity:.5; cursor:default; }
.ln-group-head{ font-size:12px; font-weight:800; letter-spacing:.06em; color:var(--ink-mute); padding:12px 16px 6px; border-top:1px solid var(--line); }
.ln-group-head:first-child{ border-top:0; }
.ln-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 16px; border-top:1px solid var(--line); }
.ln-row .ln-label{ font-weight:600; }
.ln-items.off{ opacity:.55; }
.lq-wrap{ display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
.lq-kicker{ font-size:11px; font-weight:800; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-mute); }
.lq-num{ font-family:"Archivo",sans-serif; font-weight:800; font-size:36px; line-height:1; font-variant-numeric:tabular-nums; color:var(--ink); }
.lq-num.danger{ color:var(--err-fg); }
.lq-den{ font-family:"Archivo",sans-serif; font-weight:700; font-size:14px; color:var(--ink-mute); margin-left:4px; }
.lq-bar{ display:flex; gap:2px; flex:1; min-width:220px; }
.lq-seg{ flex:1; height:14px; border:1px solid var(--line); background:transparent; }
.lq-seg.on{ background:var(--brand-500); border-color:var(--brand-500); }
.lq-seg.on.warn{ background:var(--warn-fg); border-color:var(--warn-fg); }
.lq-seg.on.danger{ background:var(--err-fg); border-color:var(--err-fg); }
.lq-reset{ margin-top:10px; }
```

（`--brand-900` 為 `colors_and_type.css` 既有 token，facade CTA 同款「天藍底深藍字」。）

- [ ] **Step 3: `admin.js` 加通知開關函式**

在 `doLineUnbind` 函式定義結束之後加：

```js
// ── LINE 通知開關（總開關 + 16 項目）──
let lnState = null;
let lnWired = false;
const lnAllItemKeys = () => (lnState?.groups || []).flatMap((g) => g.items.map((i) => i.key));

function lnSwitchHtml(on, attrs = '') {
  return `<button type="button" class="ln-switch${on ? ' on' : ''}" aria-pressed="${on}" ${attrs}>${on ? 'ON' : 'OFF'}</button>`;
}

function renderLineNotify() {
  const el = document.getElementById('ln-items');
  const master = document.getElementById('ln-master');
  const note = document.getElementById('ln-note');
  if (!el || !master || !note || !lnState) return;
  master.classList.toggle('on', lnState.master);
  master.setAttribute('aria-pressed', String(lnState.master));
  master.textContent = lnState.master ? 'ON' : 'OFF';
  note.textContent = lnState.master
    ? '關閉的項目不推 LINE，但仍會留在通知紀錄。'
    : '總開關關閉中：所有 LINE 推播暫停，以下項目設定會在開啟後生效。';
  el.classList.toggle('off', !lnState.master);
  el.innerHTML = lnState.groups.map((g) => `
    <div class="ln-group-head">${escapeHtml(g.label)}</div>
    ${g.items.map((it) => `
      <div class="ln-row">
        <div>
          <div class="ln-label">${escapeHtml(it.label)}</div>
          <div class="subtle text-sm">${escapeHtml(it.recipients)}</div>
        </div>
        ${lnSwitchHtml(it.enabled, `data-ln-item="${it.key}"`)}
      </div>`).join('')}`).join('');
  el.querySelectorAll('[data-ln-item]').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.lnItem;
    const cur = lnState.groups.flatMap((g) => g.items).find((i) => i.key === key);
    if (cur) patchLineNotify({ items: { [key]: !cur.enabled } });
  }));
}

// 樂觀更新：先照 body 改本地狀態重繪，PATCH 失敗再還原
function lnApplyLocal(state, body) {
  return {
    master: body.master ?? state.master,
    groups: state.groups.map((g) => ({
      ...g,
      items: g.items.map((it) => ({ ...it, enabled: body.items && it.key in body.items ? body.items[it.key] : it.enabled })),
    })),
  };
}

async function patchLineNotify(body) {
  if (!lnState) return;
  const prev = lnState;
  lnState = lnApplyLocal(prev, body);
  renderLineNotify();
  try {
    lnState = await api('/api/admin/line-notify', { method: 'PATCH', body });
    renderLineNotify();
  } catch (e) {
    lnState = prev;
    renderLineNotify();
    toast(`儲存失敗：${e.message}`, 'error');
  }
}

async function loadLineNotify() {
  if (!lnWired) {
    document.getElementById('ln-master')?.addEventListener('click', () => { if (lnState) patchLineNotify({ master: !lnState.master }); });
    document.getElementById('ln-all-on')?.addEventListener('click', () => {
      patchLineNotify({ items: Object.fromEntries(lnAllItemKeys().map((k) => [k, true])) });
    });
    document.getElementById('ln-all-off')?.addEventListener('click', () => {
      if (!lnState) return;
      if (!confirm(`確定關閉全部 ${lnAllItemKeys().length} 個項目？`)) return;
      patchLineNotify({ items: Object.fromEntries(lnAllItemKeys().map((k) => [k, false])) });
    });
    lnWired = true;
  }
  try {
    lnState = await api('/api/admin/line-notify');
    renderLineNotify();
  } catch (e) {
    const el = document.getElementById('ln-items');
    if (el) el.innerHTML = `<div class="p-6 text-red-500 text-center">${escapeHtml(e.message)}</div>`;
  }
}
```

- [ ] **Step 4: `admin.js` 加額度血條函式**

緊接上一步的程式之後加：

```js
// ── 本月推播額度（遊戲血條：20 格、每格 5%）──
let lqState = null;
let lqWired = false;
const LQ_DOW = ['日', '一', '二', '三', '四', '五', '六'];

// 'YYYY-MM-DDTHH:MM:SS'（伺服器台灣本地字串）→ 瀏覽器本地 Date
function lqParseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

function lqResetText(resetAt) {
  const d = lqParseLocal(resetAt);
  if (!d) return '';
  const diffMs = d.getTime() - Date.now();
  const hours = Math.floor(diffMs / 3600000);
  const countdown = diffMs < 3600000 ? '不到 1 小時' : `還有 ${Math.floor(hours / 24)} 天 ${hours % 24} 小時`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `重置：${d.getMonth() + 1}/${d.getDate()}（週${LQ_DOW[d.getDay()]}）${hh}:${mm} · ${countdown}`;
}

function renderLineQuota() {
  const el = document.getElementById('lq-body');
  const fetched = document.getElementById('lq-fetched');
  if (!el || !lqState) return;
  const q = lqState;
  if (fetched) fetched.textContent = q.fetchedAt ? `更新於 ${q.fetchedAt.slice(11, 16)}` : '';
  if (!q.configured) { el.innerHTML = '<p class="subtle">LINE 尚未設定（缺 channel access token）</p>'; return; }
  if (q.error) { el.innerHTML = `<p class="text-red-500">無法取得額度：${escapeHtml(q.error)}</p>`; return; }
  const resetLine = `<div class="lq-reset subtle text-sm">${escapeHtml(lqResetText(q.resetAt))} <span style="font-size:12px;">· LINE 以日本時間每月 1 日 00:00 重置</span></div>`;
  if (q.limitType === 'none') {
    el.innerHTML = `<p>本月無上限（未設定目標則數）</p><p class="subtle text-sm">已發 約 ${q.used} 則</p>${resetLine}`;
    return;
  }
  const tone = q.pct >= 50 ? '' : (q.pct >= 20 ? ' warn' : ' danger');
  let lit = Math.round(q.pct / 5);
  if (q.remaining > 0 && lit === 0) lit = 1;   // 還有剩就至少亮一格
  if (q.remaining === 0) lit = 0;
  const segs = Array.from({ length: 20 }, (_, i) => `<div class="lq-seg${i < lit ? ' on' + tone : ''}"></div>`).join('');
  const empty = q.remaining === 0;
  el.innerHTML = `
    <div class="lq-wrap">
      <div>
        <div class="lq-kicker">剩餘</div>
        <span class="lq-num${empty ? ' danger' : ''}">${q.remaining}</span><span class="lq-den">/ ${q.limit}</span>
        ${empty ? ' <span class="badge badge-cancelled">額度用完</span>' : ''}
      </div>
      <div class="lq-bar" role="progressbar" aria-valuenow="${q.remaining}" aria-valuemin="0" aria-valuemax="${q.limit}" aria-label="本月剩餘推播額度">${segs}</div>
    </div>
    <div class="subtle text-sm" style="margin-top:8px;">已發 約 ${q.used} 則 · LINE 統計為近似值</div>
    ${resetLine}`;
}

async function loadLineQuota() {
  const btn = document.getElementById('lq-refresh');
  if (!lqWired) {
    btn?.addEventListener('click', () => loadLineQuota());
    setInterval(() => { if (lqState) renderLineQuota(); }, 60 * 1000);  // 倒數每分鐘重算，不重打 API
    lqWired = true;
  }
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  try {
    lqState = await api('/api/admin/line-quota');
    renderLineQuota();
  } catch (e) {
    const el = document.getElementById('lq-body');
    if (el) el.innerHTML = `<p class="text-red-500">無法取得額度：${escapeHtml(e.message)}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新整理'; }
  }
}
```

- [ ] **Step 5: 接上啟動載入鏈**

`admin.js` 啟動區 `loadUsers();` 那行之後加：

```js
loadLineNotify();
loadLineQuota();
```

- [ ] **Step 6: localhost 手動檢查**

啟動：`LINE_MOCK=1 node --env-file-if-exists=.env src/server.js`（demo DB；若沒有管理者先 `npm run seed`），瀏覽器開 `http://localhost:3000/admin.html`（登入 demo 管理者 `admin@chinup.local` / `admin1234`），點「LINE 管理」頁籤，逐項確認：

1. 額度卡：大數字 `200 / 200`、20 格全亮天藍、「已發 約 0 則」、「重置：M/D（週X）23:00 · 還有 N 天 H 小時」、右上「更新於 HH:MM」；按「重新整理」期間鈕文字變「更新中…」後還原。
2. 開關卡：總開關顯示 OFF、清單淡化、註解為「總開關關閉中…」；三組標題（一對一教練課／團體課程／排程與系統）共 16 列，每列有名稱＋收件人＋ON 開關。
3. 點總開關 → 立即變 ON（天藍）、清單不再淡化、註解換句；重新整理頁面仍 ON（已寫入）。
4. 點任一項目 → 變 OFF；重新整理仍 OFF。「全部關閉」跳 confirm，確定後 16 項全 OFF；「全部開啟」16 項全 ON。
5. 手機寬度（<768px）：a-sec-head 工具列換行不溢出、血條至少 220px 寬可換行到第二列。
6. 在 DevTools 把 `LINE_MOCK` 情境換掉不可行，改用 `curl -H "Authorization: Bearer <token>" localhost:3000/api/admin/line-quota` 確認 JSON 與畫面一致即可。

- [ ] **Step 7: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台 LINE 管理加通知開關（總開關＋16 項）與本月額度血條

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 完成後（controller 自己做）

1. `DB_PATH="$(mktemp -d)/t.db" npm test` 全綠；起測試伺服器跑 `npm run test:api` 全綠後 `npm run seed`。
2. 業主 localhost smoke（LINE 頁籤兩個新區塊）。
3. Draft PR → 終審 → 合併；合併部署後 prod 總開關即為 OFF（未設定＝OFF），額度卡顯示真實剩餘。
