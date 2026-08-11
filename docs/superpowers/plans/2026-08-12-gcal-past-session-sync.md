# Google 日曆過去堂連動（刪除→取消、移動→改期） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google 日曆上刪除／拖動系統事件時，過去堂也連動取消／改期（與系統內操作同語意），不再被守門忽略。

**Architecture:** 全部變更在反向同步分類器 `src/services/gcalPull.js` `processEvent` 的四處守門條件（刪除、全天退回、移動忽略、不可移到過去），重用既有 `cancelBookingFromGcal` / `rescheduleBooking` / `revertEvent`，服務層零改動。另一小任務更新 `gcalSync.js` 事件描述文案。

**Tech Stack:** Node ESM、node:sqlite、plain-node assert 測試（`GCAL_MOCK=1`）。

**Spec:** `docs/superpowers/specs/2026-08-12-gcal-past-session-sync-design.md`（含語意彙總表與邊界，實作前先讀）

## Global Constraints

- 單元測試**絕不**對 `data/app.db` 跑：一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴（本 repo 慣例；違反會弄髒 demo 資料）。
- 不新增依賴、不改 schema、不改 API 端點。
- 使用者可見文案一律繁體中文。
- 通知模板（`gcal_move_rejected`／`gcal_delete_cancelled`）**不新增不修改**，沿用既有。
- commit 訊息格式照 repo 慣例（繁中一行主旨），結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 過去堂守門翻轉（gcalPull.js）＋測試矩陣翻面

**Files:**
- Modify: `src/services/gcalPull.js:1-3`（檔頭政策註解）、`:67-76`（刪除分支）、`:85-88`（全天退回）、`:91`（移動忽略守門）、`:93`（不可移到過去）
- Test: `tests/gcal-pull.test.js`（翻面 `:124-133` 過去堂忽略案例、新增 fixtures 與五個案例）

**Interfaces:**
- Consumes: 既有 `cancelBookingFromGcal(bookingId)`（bookingService；守門 `status='confirmed'`、回補、清 event_id、回傳 `{ok,coachName,memberName,startAt,refunded}`）、`rescheduleBooking({bookingId,newStartAt,actorUserId:null,isAdmin:true})`（無過去堂限制）、`revertEvent(calId, b, reason)`（gcalPull 內部）。三者對過去堂原樣適用，零改動。
- Produces: `processEvent(ev, calId)` 新語意——過去堂刪除→取消；過去堂移動→驗證（整點/60分/撞課）後改期，目標可為過去或未來；僅未來堂禁止移入過去。簽名不變。

- [ ] **Step 1: 改寫測試——翻面過去堂案例、新增 fixtures**

`tests/gcal-pull.test.js` 三處修改：

(a) 檔頭註解（`:1`）改為：

```js
// gcal 反向同步：分類器矩陣（回聲/套用/退回四因/全天/過去堂連動/刪除取消/復原再刪/忽略）＋ token 泵。
```

(b) fixtures 區，在 `const memberId = …`（`:30`）之後插入一行（管理者收件的精確斷言用；`gp-%` 前綴確保頭尾清理涵蓋）：

```js
const gpAdminUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('GP管理','gp-a@x.com','coach',1)").run().lastInsertRowid);
```

(c) 把 `:124-133` 的整段（`const bPast = mkBooking('2020-06-01T10:00:00');` 到「過去堂：移動與刪除一律忽略」的 `expect` 區塊結束）**整段替換**為：

```js
// ── 過去堂連動（2026-08-12 規格翻轉：刪除→取消、移動→改期，與系統內操作同語意）──
const bPastMove = mkBooking('2020-06-01T10:00:00');
reset();
await processEvent(evOf(bPastMove, '2020-06-02T10:00:00+08:00', '2020-06-02T11:00:00+08:00'), CAL);
expect('過去堂移動→過去合法時段 → 套用改期（修正歷史）＋客人通知、不 updateEvent', () => {
  const b = getB(bPastMove);
  assert.equal(b.start_at, '2020-06-02T10:00:00');
  assert.equal(b.end_at, '2020-06-02T11:00:00');
  assert.equal(callsOf('updateEvent').length, 0);
  assert.ok(notifCount('booking_rescheduled', memberId) >= 1);
});

reset();
await processEvent(evOf(bPastMove, '2032-06-01T10:00:00+08:00', '2032-06-01T11:00:00+08:00'), CAL);
expect('過去堂移動→未來合法時段 → 套用改期（延期補課）', () => {
  assert.equal(getB(bPastMove).start_at, '2032-06-01T10:00:00');
  assert.equal(callsOf('updateEvent').length, 0);
});

const bPastBad = mkBooking('2020-07-01T10:00:00');
reset();
await processEvent(evOf(bPastBad, '2020-07-01T10:30:00+08:00', '2020-07-01T11:30:00+08:00'), CAL);
expect('過去堂移動→非整點 → 退回＋教練通知（DB 贏對過去堂也成立）', () => {
  assert.equal(getB(bPastBad).start_at, '2020-07-01T10:00:00');
  const u = callsOf('updateEvent');
  assert.equal(u.length, 1);
  assert.equal(u[0].args.event.start.dateTime, '2020-07-01T10:00:00+08:00');
  const row = db.prepare("SELECT body FROM notifications WHERE type='gcal_move_rejected' AND user_id=? ORDER BY id DESC").get(coachUid);
  assert.ok(row.body.includes('整點'));
});

reset();
await processEvent({ id: eventIdForBooking(bPastBad), status: 'confirmed', start: { date: '2020-07-02' }, end: { date: '2020-07-03' } }, CAL);
expect('過去堂事件被改全天 → 退回', () => assert.equal(callsOf('updateEvent').length, 1));

const pkgPast = Number(db.prepare("INSERT INTO customer_packages (member_id,session_type,total_sessions,remaining_sessions,amount) VALUES (?,'1on1',10,4,10000)").run(memberId).lastInsertRowid);
const bPastDel = mkBooking('2020-08-01T10:00:00', { pkg: pkgPast });
const memberNotifsBeforePastDel = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c;
reset();
await processEvent({ id: eventIdForBooking(bPastDel), status: 'cancelled' }, CAL);
expect('過去堂刪除 → 取消＋回補＋清 event_id＋管理者通知、客人教練靜默', () => {
  const b = getB(bPastDel);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancel_reason, 'gcal_event_deleted');
  assert.equal(b.gcal_event_id, null);
  assert.equal(db.prepare('SELECT remaining_sessions r FROM customer_packages WHERE id=?').get(pkgPast).r, 5); // 4+1
  assert.equal(notifCount('gcal_delete_cancelled', gpAdminUid), 1); // 本案例是本檔第一次刪除事件，精確=1
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(memberId).c, memberNotifsBeforePastDel); // 客人零新通知
  assert.equal(notifCount('gcal_delete_cancelled', coachUid), 0);   // 教練非管理者，不收
});
```

注意事項：
- 這段的**位置必須保持在原 `:124-133` 處**（「刪除未來堂 bDel」區塊之前）：`notifCount('gcal_delete_cancelled', gpAdminUid) === 1` 依賴「本檔至此只發生過這一次刪除」；後面 bDel 案例的 `adminNotifsAfterDelete >= 1` 斷言不受 gpAdmin 多收一份影響。
- `bPastMove` 第二步移到 `2032-06-01`（變未來堂）後不再使用；尾端清理 `start_at LIKE '2032-%'` 涵蓋。`2020-07`／`2020-08` 由 `LIKE '2020-%'` 涵蓋，`gp-a@x.com` 由 `gp-%` 涵蓋，皆免改清理段。
- 既有「移到過去 → 退回」案例（`:112-118`，**未來堂** bEcho 移到 2020）是本次規則微調的回歸案例，**不要動它**，改完必須續過。

- [ ] **Step 2: 跑測試確認新案例失敗**

Run: `cd /Users/ryansheu/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/gcal-pull.test.js`
Expected: 五個新案例 ✗（守門仍忽略過去堂：預約未變、無取消、無通知），其餘既有案例 ✓，exit code 1。

- [ ] **Step 3: 實作 gcalPull.js 四處守門翻轉**

(a) 檔頭（`:1-3`）改為：

```js
// Google 日曆反向同步（拉回）：syncToken 增量輪詢，把日曆上對系統事件的人為異動套回系統。
// 政策：衝突 DB 贏（退回＋通知教練）；刪除＝自動取消（不分過去未來堂；回補、通知管理者、不通知客人）；
// 移動＝驗證後套用改期（過去堂亦連動；僅未來堂禁止移入過去）。
// 規格：docs/superpowers/specs/2026-07-04-gcal-pull-sync-design.md
//       docs/superpowers/specs/2026-08-12-gcal-past-session-sync-design.md（過去堂連動翻轉）
```

(b) 刪除分支（`:69`）：整行刪除

```js
    if (b.start_at <= now) return;                                 // 過去堂不理（保護薪資/歷史）
```

(c) 全天退回（`:85-88`）改為（過去堂同樣退回）：

```js
  if (!evStart || !evEnd) {                                        // 被改成全天/格式壞 → 退回
    await revertEvent(calId, b, '格式不支援（全天事件）');
    return;
  }
```

(d) 移動忽略守門（`:91`）：整行刪除

```js
  if (b.start_at <= now) return;                                   // 過去堂的移動：完全忽略
```

(e) 不可移到過去（`:93`）改為：

```js
  if (b.start_at > now && evStart <= now) return revertEvent(calId, b, '不可移到過去'); // 僅未來堂禁止移入過去
```

- [ ] **Step 4: 跑單檔測試確認全過**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/gcal-pull.test.js`
Expected: 全部 ✓、exit code 0（含 `:112-118` 未來堂移到過去仍退回的回歸案例）。

- [ ] **Step 5: 跑完整 unit 測試鏈**

Run: `DB_PATH="$(mktemp -d)/t.db" npm test`
Expected: 全過（整鏈共用同一顆 fresh DB，跑完即丟；**不得**省略 DB_PATH）。

- [ ] **Step 6: Commit**

```bash
git add src/services/gcalPull.js tests/gcal-pull.test.js
git commit -m "gcal 反向同步：過去堂連動（刪除→取消、移動→改期）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 事件描述文案移除「未來時段」（gcalSync.js）

**Files:**
- Modify: `src/services/gcalSync.js:44`

**Interfaces:**
- Consumes: 無（純文案；`buildEventBody` 簽名與其他行為不變）。
- Produces: 無後續任務依賴。

- [ ] **Step 1: 確認無測試斷言舊文案**

Run: `grep -rn "可直接拖動" tests/ src/`
Expected: 只有 `src/services/gcalSync.js:44` 一處。若有其他處（不應該），停下回報。

- [ ] **Step 2: 改文案**

`src/services/gcalSync.js:44`：

```js
    '（chinup 系統自動建立。可直接拖動改時段：需整點起、60 分鐘；刪除事件＝取消預約並回補堂數）',
```

（原文僅移除「、未來時段」三字＋頓號；其餘一字不動。既有事件的描述待下次寫入自然更新，不做存量回補。）

- [ ] **Step 3: 跑相關測試**

Run: `DB_PATH="$(mktemp -d)/t.db" sh -c 'node tests/gcal-sync.test.js && node tests/gcal-pull.test.js && node tests/gcal-coach-color.test.js'`
Expected: 全過。

- [ ] **Step 4: Commit**

```bash
git add src/services/gcalSync.js
git commit -m "gcal 事件描述移除「未來時段」（過去堂連動後拖動不再限未來）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
