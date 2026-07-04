# Google 日曆反向同步（拉回） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每分鐘用 syncToken 增量輪詢 Google 日曆，把人為異動拉回系統：移動→合法套用改時段（通知客人）／不合法退回（LINE 通知教練）；刪除→自動取消未來堂（回補堂數＋通知管理者、不通知客人）；過去堂一律不理；衝突 DB 贏。

**Architecture:** `gcalClient` 加 `listEvents`/`updateEvent`（零依賴、never-throws、GCAL_MOCK 佇列 seam）；新 `src/services/gcalPull.js`（token 泵＋事件分類器）；`bookingService` 加對客人靜默的 `cancelBookingFromGcal`；`notifications` 加兩則模板；scheduler 加每分鐘 cron；`buildEventBody` 描述文案更新。無 schema 遷移（token 存 app_settings、setSetting upsert）。

**Tech Stack:** Node.js ESM + node:sqlite + 原生 fetch；node-cron；repo 慣例 script 式測試（GCAL_MOCK=1）。

**Spec:** `docs/superpowers/specs/2026-07-04-gcal-pull-sync-design.md`（政策與分類器規則以 spec 為準）

## Global Constraints

- **DB 是唯一事實來源**：套用不了的日曆異動一律退回（事件改回 DB 時間）；退回**成功才**通知教練（失敗只 log、下個 tick 自然重試，不洗版）。
- **過去堂保護**：`b.start_at <= nowLocal()` 的預約，移動與刪除一律忽略（不回補、不退回、不通知）。
- **回聲防護**：事件時間==DB → no-op；已取消預約收到 cancelled 事件 → no-op。
- 刪除→取消：**客人與教練都不發通知**，僅 `notifyAdmins`；回補方案（`refundPackageForBooking`）＋釋放折扣（`releaseRedemption`）＋`cancel_reason='gcal_event_deleted'`＋`gcal_event_id=NULL`。
- 合法移動 = 未來堂＋新起點在未來＋整點起（epoch `% 3600000 === 0`，台灣為整時偏移故等價於台北整點且秒/毫秒必為 0）＋時長恰 60 分鐘；套用走既有 `rescheduleBooking`（含撞課檢查與客人通知）。
- Token 存 `app_settings` key `gcal_sync_token`，值 `JSON {calId, token}`；calId 不符或無 token → 基準同步（`timeMin=現在−1天`、`showDeleted=true`）；HTTP 410 → 清 token 重基準（同一 tick 內最多重試一次）。
- 每 tick 最多 10 頁、每頁 `maxResults=250`；`_pullRunning` boolean 防重疊。
- `ApiError` 的錯誤碼在 `e.message`（如 `'slot_taken'`）。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 單一任務只跑該任務測試檔；完整套件留 controller 收尾（`npm test` 後要 `node src/db/seed-demo.js` 重種）。

---

### Task 1: gcalClient 擴充（listEvents / updateEvent ＋ mock seam）

**Files:**
- Modify: `src/services/gcalClient.js`
- Test: `tests/gcal-pull-client.test.js`（新檔）
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/gcal-pull-client.test.js`）

**Interfaces:**
- Produces: `listEvents(calendarId, params) → { ok, items, nextPageToken, nextSyncToken }`（失敗回 `{ ok:false, status, error }`，410 由 status 辨識）；`updateEvent(calendarId, eventId, event) → { ok }`（PUT，body 併 `status:'confirmed'`）；`export const __mockListQueue = []`（GCAL_MOCK=1 時 listEvents 依序 shift，空佇列回 `{ ok:true, items:[], nextPageToken:null, nextSyncToken:'mock-token' }`）。

- [ ] **Step 1: gcalClient.js 檔頂 `__mockCalls` 旁加佇列 export**

```js
export const __mockListQueue = []; // 測試專用：GCAL_MOCK=1 時 listEvents 依序 shift 假回應
```

- [ ] **Step 2: 檔尾加兩個函式**

```js
/** 列事件（反向同步用）。params 為 query 物件（syncToken/pageToken/timeMin/showDeleted/maxResults…）。
 *  回 { ok, items, nextPageToken, nextSyncToken }；410（syncToken 過期）由 status 辨識。 */
export async function listEvents(calendarId, params = {}) {
  if (process.env.GCAL_MOCK === '1') {
    const result = __mockListQueue.length
      ? __mockListQueue.shift()
      : { ok: true, items: [], nextPageToken: null, nextSyncToken: 'mock-token' };
    return mock('listEvents', { calendarId, params }, result);
  }
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const qs = new URLSearchParams(params).toString();
  const r = await authedFetch(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events?${qs}`);
  if (!r.ok) return r;
  return {
    ok: true,
    items: r.data?.items || [],
    nextPageToken: r.data?.nextPageToken || null,
    nextSyncToken: r.data?.nextSyncToken || null,
  };
}

/** 更新事件（退回移動／理論復活用）。body 併 status:'confirmed'。 */
export async function updateEvent(calendarId, eventId, event) {
  if (process.env.GCAL_MOCK === '1') return mock('updateEvent', { calendarId, eventId, event });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const r = await authedFetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: JSON.stringify({ ...event, status: 'confirmed' }) }
  );
  return r.ok ? { ok: true } : r;
}
```

- [ ] **Step 3: 寫測試 `tests/gcal-pull-client.test.js`**

```js
// gcalClient 反向同步擴充：mock 佇列語意、呼叫紀錄。
process.env.GCAL_MOCK = '1';
import assert from 'node:assert/strict';
const { listEvents, updateEvent, __mockCalls, __mockListQueue } = await import('../src/services/gcalClient.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-pull-client test] start');

__mockCalls.length = 0;
__mockListQueue.push({ ok: true, items: [{ id: 'x1' }], nextPageToken: 'p2', nextSyncToken: null });
__mockListQueue.push({ ok: false, status: 410, error: 'gone' });

const r1 = await listEvents('cal-a', { timeMin: 't0', showDeleted: 'true' });
expect('佇列依序 shift（第一筆）', () => {
  assert.equal(r1.ok, true);
  assert.equal(r1.items[0].id, 'x1');
  assert.equal(r1.nextPageToken, 'p2');
});
const r2 = await listEvents('cal-a', { pageToken: 'p2' });
expect('佇列依序 shift（410）', () => { assert.equal(r2.ok, false); assert.equal(r2.status, 410); });
const r3 = await listEvents('cal-a', { syncToken: 'tk' });
expect('空佇列 → 預設空頁 + mock-token', () => {
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.items, []);
  assert.equal(r3.nextSyncToken, 'mock-token');
});
const u1 = await updateEvent('cal-a', 'chinupbk000000001', { summary: 's' });
expect('updateEvent mock ok', () => assert.equal(u1.ok, true));
expect('__mockCalls 記錄 fn 與參數', () => {
  const fns = __mockCalls.map((c) => c.fn);
  assert.deepEqual(fns, ['listEvents', 'listEvents', 'listEvents', 'updateEvent']);
  assert.equal(__mockCalls[0].args.params.timeMin, 't0');
  assert.equal(__mockCalls[3].args.eventId, 'chinupbk000000001');
});
console.log('[gcal-pull-client test] done');
```

- [ ] **Step 4: 跑測試＋掛鏈＋commit**

```bash
node tests/gcal-pull-client.test.js   # 全 ✓、exit 0
# package.json 的 test 鏈尾加 ` && node tests/gcal-pull-client.test.js`
git add src/services/gcalClient.js tests/gcal-pull-client.test.js package.json
git commit -m "feat: gcalClient 加 listEvents/updateEvent（反向同步基礎）"
```

---

### Task 2: gcalPull 反向同步核心＋佈線＋測試

**Files:**
- Create: `src/services/gcalPull.js`
- Modify: `src/services/bookingService.js`（`cancelBookingAnon` 之前加 `cancelBookingFromGcal`）
- Modify: `src/services/notifications.js`（`TEMPLATES` 加兩則）
- Modify: `src/services/gcalSync.js`（`buildEventBody` 描述文案一行）
- Modify: `src/scheduler.js`（每分鐘 cron）
- Test: `tests/gcal-pull.test.js`（新檔）
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/gcal-pull.test.js`）

**Interfaces:**
- Consumes: Task 1 `listEvents`/`updateEvent`/`__mockListQueue`；既有 `rescheduleBooking`（撞課丟 `ApiError('slot_taken')`、成功通知客人）、`deleteEvent`、`buildEventBody`、`eventIdForBooking`、`isGcalEnabled`、`getSetting`/`setSetting`/`getGcalCalendarId`、`notify`/`notifyAdmins`/`fmtDateForLine`。
- Produces: `pullChanges()`（cron 進入點）、`processEvent(ev, calId)`（exported 供測試）、`cancelBookingFromGcal(bookingId) → { ok, coachName, memberName, startAt, refunded }`。

- [ ] **Step 1: bookingService.js 加 `cancelBookingFromGcal`（放 `cancelBookingAnon` 之前）**

```js
/** gcal 刪除事件 → 自動取消（對客人與教練皆靜默；管理者通知由呼叫端 gcalPull 發）。
 *  回補方案、釋放折扣；cancel_reason 供稽核；事件已不存在故清 gcal_event_id（免 reconcile 再刪）。 */
export function cancelBookingFromGcal(bookingId) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b || b.status === 'cancelled') return { ok: false };
    const coach = getCoachStmt.get(b.coach_id);
    cancelBookingStmt.run(nowLocal(), null, 'gcal_event_deleted', bookingId);
    refundPackageForBooking(b);
    releaseRedemption({ kind: 'booking', refId: bookingId });
    db.prepare('UPDATE bookings SET gcal_event_id = NULL WHERE id = ?').run(bookingId);
    const memberRow = getUserNameStmt.get(b.member_id);
    return { ok: true, coachName: coach?.display_name || '', memberName: memberRow?.name || '',
             startAt: b.start_at, refunded: !!b.package_id };
  });
}
```

- [ ] **Step 2: notifications.js `TEMPLATES` 加兩則（既有格式 `{{var}}`）**

```js
  gcal_move_rejected: {
    subject: 'Google 日曆移動已退回',
    body: '您在 Google 日曆上移動的預約已退回：{{member_name}} {{start_at}}。原因：{{reason}}。如需改期請於系統內操作。',
  },
  gcal_delete_cancelled: {
    subject: 'Google 日曆刪除 → 預約已取消',
    body: 'Google 日曆上的事件被刪除，系統已自動取消預約：{{coach_display_name}} × {{member_name}}（{{start_at}}）{{refund_note}}。',
  },
```

- [ ] **Step 3: gcalSync.js `buildEventBody` 描述末行改為**

```js
    '（chinup 系統自動建立。可直接拖動改時段：需整點起、60 分鐘、未來時段；刪除事件＝取消預約並回補堂數）',
```

- [ ] **Step 4: 寫 `src/services/gcalPull.js`**

```js
// Google 日曆反向同步（拉回）：syncToken 增量輪詢，把日曆上對系統事件的人為異動套回系統。
// 政策：衝突 DB 贏（退回＋通知教練）；刪除＝自動取消未來堂（回補、通知管理者、不通知客人）；
// 過去堂一律不理。規格：docs/superpowers/specs/2026-07-04-gcal-pull-sync-design.md
import { db, nowLocal } from '../db/connection.js';
import { getSetting, setSetting, getGcalCalendarId } from './discountService.js';
import { listEvents, updateEvent, deleteEvent } from './gcalClient.js';
import { isGcalEnabled, eventIdForBooking, buildEventBody } from './gcalSync.js';
import { rescheduleBooking, cancelBookingFromGcal } from './bookingService.js';
import { notify, notifyAdmins, fmtDateForLine } from './notifications.js';

const EV_ID_RE = /^chinupbk(\d{9})$/;
const TOKEN_KEY = 'gcal_sync_token';
const MAX_PAGES_PER_TICK = 10;

const getBookingForPull = db.prepare(`
  SELECT b.id, b.status, b.start_at, b.end_at, b.member_id, b.package_id,
         c.user_id AS coach_user_id, c.display_name AS coach_name, u.name AS member_name
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.id = ?
`);

/** RFC3339 → 台北牆鐘 'YYYY-MM-DDTHH:MM:SS'（epoch+8h 取 UTC 分量；台灣無 DST）。無效回 null。 */
function isoToTaipei(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// token 綁定日曆 ID：管理者換日曆 → token 自動失效、重建基準
function loadToken(calId) {
  try {
    const raw = getSetting(TOKEN_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.calId === calId ? o.token : null;
  } catch { return null; }
}
const saveToken = (calId, token) => setSetting(TOKEN_KEY, JSON.stringify({ calId, token }));
const clearToken = () => setSetting(TOKEN_KEY, '');

function baselineTimeMin() {
  const d = new Date(Date.now() - 86_400_000 + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00:00+08:00`;
}

/** 退回：事件改回 DB 時間；成功才通知教練（失敗只 log，下個 tick 事件仍不一致會再試，不洗版）。 */
async function revertEvent(calId, b, reason) {
  const body = buildEventBody(b.id);
  if (!body) return;
  const r = await updateEvent(calId, eventIdForBooking(b.id), body);
  if (!r.ok) { console.error('[gcal-pull] revert failed:', b.id, r.error); return; }
  notify({ userId: b.coach_user_id, sessionId: null, type: 'gcal_move_rejected',
    vars: { member_name: b.member_name, start_at: fmtDateForLine(b.start_at), reason } });
}

/** 單一事件分類與套用（基準/增量共用；冪等）。exported 供測試。 */
export async function processEvent(ev, calId) {
  const m = EV_ID_RE.exec(ev?.id || '');
  if (!m) return;                                                  // 非系統事件 → 忽略
  const b = getBookingForPull.get(Number(m[1]));
  if (!b) return;
  const now = nowLocal();

  if (ev.status === 'cancelled') {                                 // 日曆上被刪
    if (b.status === 'cancelled') return;                          // 系統自刪的回聲
    if (b.start_at <= now) return;                                 // 過去堂不理（保護薪資/歷史）
    const r = cancelBookingFromGcal(b.id);
    if (!r.ok) return;
    notifyAdmins({ type: 'gcal_delete_cancelled', vars: {
      coach_display_name: r.coachName, member_name: r.memberName,
      start_at: fmtDateForLine(r.startAt), refund_note: r.refunded ? '，方案已回補 1 堂' : '' } });
    return;
  }

  if (b.status === 'cancelled') {                                  // 已取消卻被「復原刪除」→ DB 贏，再刪
    await deleteEvent(calId, eventIdForBooking(b.id));
    return;
  }

  const evStart = ev.start?.dateTime ? isoToTaipei(ev.start.dateTime) : null;
  const evEnd = ev.end?.dateTime ? isoToTaipei(ev.end.dateTime) : null;
  if (!evStart || !evEnd) {                                        // 被改成全天/格式壞 → 退回
    if (b.start_at > now) await revertEvent(calId, b, '格式不支援（全天事件）');
    return;
  }
  if (evStart === b.start_at && evEnd === b.end_at) return;        // 與 DB 一致（回聲）

  if (b.start_at <= now) return;                                   // 過去堂的移動：完全忽略

  if (evStart <= now) return revertEvent(calId, b, '不可移到過去');
  const startMs = Date.parse(ev.start.dateTime);
  const endMs = Date.parse(ev.end.dateTime);
  if (startMs % 3600_000 !== 0 || endMs - startMs !== 3600_000) {
    return revertEvent(calId, b, '需為整點起、60 分鐘');
  }
  try {
    rescheduleBooking({ bookingId: b.id, newStartAt: evStart, actorUserId: null, isAdmin: true });
    // 成功：rescheduleBooking 已通知客人；事件時間即新 DB 時間，無需回寫
  } catch (e) {
    const reason = e?.message === 'slot_taken' ? '時段衝突' : `無法套用（${e?.message || 'unknown'}）`;
    return revertEvent(calId, b, reason);
  }
}

let _pullRunning = false; // node-cron 不序列化重疊執行（單執行緒 boolean 即安全）

/** 每分鐘 cron 進入點：無 token → 基準同步（timeMin=昨天、showDeleted）；有 → 增量；410 → 重基準一次。 */
export async function pullChanges() {
  if (_pullRunning) return;
  _pullRunning = true;
  try {
    if (!isGcalEnabled()) return;
    const calId = getGcalCalendarId();
    let token = loadToken(calId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const base = token
        ? { syncToken: token, maxResults: '250' }
        : { timeMin: baselineTimeMin(), showDeleted: 'true', maxResults: '250' };
      let pageToken = null;
      let newSyncToken = null;
      let gone = false;
      for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
        const r = await listEvents(calId, pageToken ? { ...base, pageToken } : base);
        if (!r.ok) {
          if (r.status === 410) { gone = true; break; }            // token 過期 → 重基準
          console.error('[gcal-pull] listEvents failed:', r.error);
          return;                                                  // 暫時性錯誤：下個 tick 重來
        }
        for (const ev of r.items || []) {
          try { await processEvent(ev, calId); }
          catch (e) { console.error('[gcal-pull] processEvent threw:', ev?.id, e); }
        }
        if (r.nextPageToken) { pageToken = r.nextPageToken; continue; }
        newSyncToken = r.nextSyncToken || null;
        break;                                                     // 末頁（或超頁保險）
      }
      if (gone) { clearToken(); token = null; continue; }          // 立刻重跑基準
      if (newSyncToken) saveToken(calId, newSyncToken);
      return;
    }
  } catch (e) { console.error('[gcal-pull] pullChanges threw:', e); }
  finally { _pullRunning = false; }
}
```

- [ ] **Step 5: scheduler.js 佈線（import ＋ reconcile cron 之後加）**

```js
import { pullChanges } from './services/gcalPull.js';
```

```js
  // 每 1 分鐘：Google 日曆反向同步（拉回人為異動；功能未啟用時內部直接 return）
  cron.schedule('* * * * *', async () => {
    try {
      await pullChanges();
    } catch (e) {
      console.error('[scheduler] gcal pull error:', e);
    }
  });
```

- [ ] **Step 6: 寫測試 `tests/gcal-pull.test.js`**（資料鎖 2032/2020 年、`gp-%` 前綴；GCAL_MOCK=1；結尾還原設定）

```js
// gcal 反向同步：分類器矩陣（回聲/套用/退回四因/全天/過去堂/刪除取消/復原再刪/忽略）＋ token 泵。
process.env.GCAL_MOCK = '1';
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { setSetting, getSetting } = await import('../src/services/discountService.js');
const { __mockCalls, __mockListQueue } = await import('../src/services/gcalClient.js');
const { processEvent, pullChanges } = await import('../src/services/gcalPull.js');
const { eventIdForBooking } = await import('../src/services/gcalSync.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const CAL = 'gp-test-cal';
console.log('[gcal-pull test] start');

// ── 清理＋建資料 ──
db.exec(`
  DELETE FROM notifications WHERE type IN ('gcal_move_rejected','gcal_delete_cancelled');
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM bookings WHERE start_at LIKE '2032-%' OR start_at LIKE '2020-%';
  DELETE FROM discount_redemptions WHERE kind='booking' AND ref_id NOT IN (SELECT id FROM bookings);
  DELETE FROM discount_codes WHERE code='GPDEL';
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gp-%');
  DELETE FROM users WHERE email LIKE 'gp-%';
`);
setSetting('gcal_calendar_id', CAL);

const coachUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('GP教練','gp-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?,'GP教練',1)").run(coachUid).lastInsertRowid);
const memberId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('GP客人','gp-m@x.com','user')").run().lastInsertRowid);
const pkgId = Number(db.prepare("INSERT INTO customer_packages (member_id,session_type,total_sessions,remaining_sessions,amount) VALUES (?,'1on1',10,4,10000)").run(memberId).lastInsertRowid);

const mkBooking = (startAt, { status = 'confirmed', pkg = null } = {}) => {
  const end = startAt.slice(0, 11) + String(Number(startAt.slice(11, 13)) + 1).padStart(2, '0') + startAt.slice(13);
  const id = Number(db.prepare(`INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,original_amount,package_id)
    VALUES (?,?,?,?,?,'1on1',1000,?)`).run(coachId, memberId, startAt, end, status, pkg).lastInsertRowid);
  db.prepare('UPDATE bookings SET gcal_event_id=? WHERE id=?').run(eventIdForBooking(id), id);
  return id;
};
const getB = (id) => db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
const evOf = (id, startIso, endIso, status = 'confirmed') =>
  ({ id: eventIdForBooking(id), status, start: { dateTime: startIso }, end: { dateTime: endIso } });
const callsOf = (fn) => __mockCalls.filter((c) => c.fn === fn);
const notifCount = (type, userId = null) => db.prepare(
  `SELECT COUNT(*) c FROM notifications WHERE type=? ${userId ? 'AND user_id=?' : ''}`
).get(...(userId ? [type, userId] : [type])).c;
const reset = () => { __mockCalls.length = 0; __mockListQueue.length = 0; };

// ── 分類器 ──
reset();
await processEvent({ id: 'someone-elses-event', status: 'confirmed' }, CAL);
await processEvent(evOf(999999999, '2032-03-01T10:00:00+08:00', '2032-03-01T11:00:00+08:00'), CAL);
expect('非系統事件／查無預約 → 忽略（零 API 呼叫）', () => assert.equal(__mockCalls.length, 0));

const bEcho = mkBooking('2032-03-01T10:00:00');
reset();
await processEvent(evOf(bEcho, '2032-03-01T10:00:00+08:00', '2032-03-01T11:00:00+08:00'), CAL);
expect('回聲（事件==DB）→ no-op', () => {
  assert.equal(__mockCalls.length, 0);
  assert.equal(getB(bEcho).start_at, '2032-03-01T10:00:00');
});

reset();
await processEvent(evOf(bEcho, '2032-03-02T14:00:00+08:00', '2032-03-02T15:00:00+08:00'), CAL);
expect('合法移動 → 套用改時段＋客人收 booking_rescheduled、不 updateEvent', () => {
  const b = getB(bEcho);
  assert.equal(b.start_at, '2032-03-02T14:00:00');
  assert.equal(b.end_at, '2032-03-02T15:00:00');
  assert.equal(callsOf('updateEvent').length, 0);
  assert.ok(notifCount('booking_rescheduled', memberId) >= 1);
});

const bOther = mkBooking('2032-03-03T09:00:00');
reset();
await processEvent(evOf(bEcho, '2032-03-03T09:00:00+08:00', '2032-03-03T10:00:00+08:00'), CAL);
expect('撞課 → 退回（updateEvent 回 DB 時間）＋教練收退回通知（原因：時段衝突）', () => {
  assert.equal(getB(bEcho).start_at, '2032-03-02T14:00:00');   // 未被改
  const u = callsOf('updateEvent');
  assert.equal(u.length, 1);
  assert.equal(u[0].args.event.start.dateTime, '2032-03-02T14:00:00+08:00');
  assert.equal(notifCount('gcal_move_rejected', coachUid), 1);
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('時段衝突'));
});

reset();
await processEvent(evOf(bEcho, '2032-03-05T10:30:00+08:00', '2032-03-05T11:30:00+08:00'), CAL);
expect('非整點 → 退回（原因：整點/60分）', () => {
  assert.equal(getB(bEcho).start_at, '2032-03-02T14:00:00');
  assert.equal(callsOf('updateEvent').length, 1);
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('整點'));
});

reset();
await processEvent(evOf(bEcho, '2032-03-05T10:00:00+08:00', '2032-03-05T11:30:00+08:00'), CAL);
expect('時長 90 分 → 退回', () => {
  assert.equal(getB(bEcho).start_at, '2032-03-02T14:00:00');
  assert.equal(callsOf('updateEvent').length, 1);
});

reset();
await processEvent(evOf(bEcho, '2020-01-01T10:00:00+08:00', '2020-01-01T11:00:00+08:00'), CAL);
expect('移到過去 → 退回（原因：不可移到過去）', () => {
  assert.equal(callsOf('updateEvent').length, 1);
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('不可移到過去'));
});

reset();
await processEvent({ id: eventIdForBooking(bEcho), status: 'confirmed', start: { date: '2032-03-05' }, end: { date: '2032-03-06' } }, CAL);
expect('全天事件 → 退回（格式不支援）', () => assert.equal(callsOf('updateEvent').length, 1));

const bPast = mkBooking('2020-06-01T10:00:00');
reset();
await processEvent(evOf(bPast, '2020-06-02T10:00:00+08:00', '2020-06-02T11:00:00+08:00'), CAL);
await processEvent(evOf(bPast, '', '', 'cancelled'), CAL);
expect('過去堂：移動與刪除一律忽略（預約不變、零通知、零 API）', () => {
  const b = getB(bPast);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.start_at, '2020-06-01T10:00:00');
  assert.equal(__mockCalls.length, 0);
});

// 刪除未來堂（掛方案＋折扣 redemption）
const bDel = mkBooking('2032-04-01T10:00:00', { pkg: pkgId });
const codeId = Number(db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value) VALUES ('GPDEL','fixed',100)").run().lastInsertRowid);
db.prepare("INSERT INTO discount_redemptions (code_id,phone,kind,ref_id,amount) VALUES (?,'0900000000','booking',?,100)").run(codeId, bDel);
const memberNotifsBefore = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c;
reset();
await processEvent({ id: eventIdForBooking(bDel), status: 'cancelled' }, CAL);
expect('刪除未來堂 → 取消＋回補＋釋放折扣＋清 event_id＋通知管理者、客人教練皆靜默', () => {
  const b = getB(bDel);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancel_reason, 'gcal_event_deleted');
  assert.equal(b.gcal_event_id, null);
  assert.equal(db.prepare('SELECT remaining_sessions r FROM customer_packages WHERE id=?').get(pkgId).r, 5); // 4+1
  assert.equal(db.prepare('SELECT COUNT(*) c FROM discount_redemptions WHERE kind=? AND ref_id=?').get('booking', bDel).c, 0);
  assert.ok(notifCount('gcal_delete_cancelled') >= 1);                       // 管理者（seed admin）
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c, memberNotifsBefore); // 客人零新通知
  assert.equal(notifCount('gcal_delete_cancelled', coachUid), 0);            // 教練不在管理者名單
});
reset();
await processEvent({ id: eventIdForBooking(bDel), status: 'cancelled' }, CAL);
expect('重複刪除事件（回聲）→ no-op', () => { assert.equal(__mockCalls.length, 0); assert.equal(notifCount('gcal_delete_cancelled'), 1); });

reset();
await processEvent(evOf(bDel, '2032-04-01T10:00:00+08:00', '2032-04-01T11:00:00+08:00'), CAL);
expect('已取消預約的事件被復原 → DB 贏，deleteEvent 再刪', () => assert.equal(callsOf('deleteEvent').length, 1));

// ── token 泵 ──
setSetting('gcal_sync_token', '');
reset();
__mockListQueue.push({ ok: true, items: [], nextPageToken: 'p2', nextSyncToken: null });
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokA' });
await pullChanges();
expect('無 token → 基準同步（timeMin+showDeleted、分頁）→ token 落庫（綁 calId）', () => {
  const calls = callsOf('listEvents');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.params.timeMin && calls[0].args.params.showDeleted);
  assert.equal(calls[0].args.params.syncToken, undefined);
  assert.equal(calls[1].args.params.pageToken, 'p2');
  assert.deepEqual(JSON.parse(getSetting('gcal_sync_token')), { calId: CAL, token: 'tokA' });
});
reset();
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokB' });
await pullChanges();
expect('有 token → 增量（syncToken=tokA）→ 存 tokB', () => {
  assert.equal(callsOf('listEvents')[0].args.params.syncToken, 'tokA');
  assert.equal(JSON.parse(getSetting('gcal_sync_token')).token, 'tokB');
});
reset();
__mockListQueue.push({ ok: false, status: 410, error: 'gone' });
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokC' });
await pullChanges();
expect('410 → 清 token 重基準 → 存 tokC', () => {
  const calls = callsOf('listEvents');
  assert.equal(calls[0].args.params.syncToken, 'tokB');
  assert.ok(calls[1].args.params.timeMin);
  assert.equal(JSON.parse(getSetting('gcal_sync_token')).token, 'tokC');
});
reset();
setSetting('gcal_calendar_id', 'gp-other-cal');
__mockListQueue.push({ ok: true, items: [], nextPageToken: null, nextSyncToken: 'tokD' });
await pullChanges();
expect('換日曆 → token 失效重基準（timeMin、無 syncToken）', () => {
  const calls = callsOf('listEvents');
  assert.ok(calls[0].args.params.timeMin);
  assert.equal(calls[0].args.params.syncToken, undefined);
  assert.deepEqual(JSON.parse(getSetting('gcal_sync_token')), { calId: 'gp-other-cal', token: 'tokD' });
});
reset();
setSetting('gcal_calendar_id', '');
await pullChanges();
expect('未設定日曆（isGcalEnabled=false）→ 不打 API', () => assert.equal(__mockCalls.length, 0));

// ── 還原 ──
setSetting('gcal_sync_token', '');
db.exec("DELETE FROM discount_codes WHERE code='GPDEL'");
console.log('[gcal-pull test] done');
```

- [ ] **Step 7: 跑測試＋掛鏈＋commit**

```bash
node tests/gcal-pull.test.js         # 全 ✓、exit 0
node tests/gcal-sync.test.js         # 既有寫入側回歸（buildEventBody 文案改了，若該測試斷言舊文案需同步更新並於報告說明）
# package.json 的 test 鏈尾加 ` && node tests/gcal-pull.test.js`
git add src/services/gcalPull.js src/services/bookingService.js src/services/notifications.js src/services/gcalSync.js src/scheduler.js tests/gcal-pull.test.js package.json
git commit -m "feat: Google 日曆反向同步（移動套用/退回、刪除自動取消、每分鐘輪詢）"
```

---

## 收尾（controller）

1. 全套 `npm test` ＋ server（`LINE_MOCK=1 GOOGLE_CLIENT_ID=test-client-id`）跑 `npm run test:api` → 全綠；`node src/db/seed-demo.js` 重種。
2. Final holistic review subagent（重點：金流面 refund 正確性、退回迴圈不洗版、token 泵邊界、與 reconcile/寫入側互不干擾）。
3. Push + draft PR（載明：本機無 SA 憑證、真實日曆驗證於合併部署後在 prod 操作——移動/刪除事件、等 1 分鐘；首次部署基準同步會一次性對帳既有未來事件漂移）。
