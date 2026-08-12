# 改期成功通知該堂教練 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改期成功後（系統內改期＋Google 拖拉共用的 `rescheduleBooking`）通知該堂教練，系統內排除操作者本人。

**Architecture:** 一則新通知模板＋`rescheduleBooking` 尾端一個條件通知，兩個既有呼叫端（server.js 帶操作者 id、gcalPull.js 帶 null）零改動。

**Tech Stack:** Node ESM、node:sqlite、plain-node assert 測試（LINE_MOCK/GCAL_MOCK）。

**Spec:** `docs/superpowers/specs/2026-08-13-reschedule-coach-notify-design.md`（語意矩陣是驗收基準）

## Global Constraints

- 單元測試**絕不**對 `data/app.db` 跑：一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴。
- 不新增依賴、不改 schema、不改 API 端點；客人通知 `booking_rescheduled` 與退回通知 `gcal_move_rejected` 行為零改動。
- 使用者可見文案繁體中文。
- 通知計數斷言一律 delta 模式（先記 before-count），不做絕對值。
- commit 訊息：繁中一行主旨，結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 新模板＋rescheduleBooking 教練通知＋兩入口測試

**Files:**
- Modify: `src/services/notifications.js`（TEMPLATES，`booking_rescheduled` 區塊之後插入一則）
- Modify: `src/services/bookingService.js:608-630`（`rescheduleBooking`）
- Test: `tests/booking-edit.test.js`（檔尾 `clean();` 之前插入三案例）、`tests/gcal-pull.test.js`（兩個移動套用案例補教練 delta 斷言）

**Interfaces:**
- Consumes: 既有 `notify()`、`fmtDateForLine()`（bookingService 已 import）；`rescheduleBooking` 的 `actorUserId` 參數（server.js:953 帶 `req.user.id`、gcalPull.js:99 帶 `null`——兩處皆不改）。
- Produces: 通知 type `booking_rescheduled_coach`（vars：`member_name`、`old_start_at`、`start_at`）。無後續任務。

- [ ] **Step 1: 寫測試（兩檔）**

(a) `tests/booking-edit.test.js`：在檔尾 `clean();`（`:126`）**之前**插入：

```js
expect('reschedule 教練本人改期 → 客人通知+1、教練 booking_rescheduled_coach 零新增', () => {
  const bid=mkBk(m1,'10');
  const mB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled'").get(m1).c;
  const cB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T19:00:00`, actorUserId:cu, isAdmin:false });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled'").get(m1).c, mB+1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c, cB);
});
expect('reschedule 管理者代改 → 教練+1、body 含會員名與新舊時段', () => {
  const bid=mkBk(m1,'14');
  const cB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T21:00:00`, actorUserId:admin, isAdmin:true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c, cB+1);
  const row=db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach' ORDER BY id DESC").get(cu);
  assert.ok(row.body.includes('be客1'));
  assert.ok(row.body.includes('14:00')); // 舊時段
  assert.ok(row.body.includes('21:00')); // 新時段
});
expect('reschedule actorUserId=null（gcal 拖拉路徑同參數）→ 教練+1', () => {
  const bid=mkBk(m2,'22');
  const cB=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T05:00:00`, actorUserId:null, isAdmin:true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled_coach'").get(cu).c, cB+1);
});
```

（時段挑選依據：`coach` 名下 confirmed 起點目前佔 09/11/12/13/15/16/17/19/20/21，其中 19/21 為前兩案例的目標；本三案例用 10、14、22 起點、19/21/05 目標，彼此與既有案例皆不撞。`admin`、`m1`、`m2`、`cu` fixtures 檔內現成。）

(b) `tests/gcal-pull.test.js` 兩處補教練 delta：

「合法移動 → 套用改時段」案例（`reset();` 後、`await processEvent(evOf(bEcho, '2032-03-02T14:00:00+08:00', …)` 那段）：在 `reset();` 之前加一行 before-count，expect 內加一行斷言：

```js
const coachReschedBefore = notifCount('booking_rescheduled_coach', coachUid);
```

expect 區塊內（既有四個 assert 之後）加：

```js
  assert.equal(notifCount('booking_rescheduled_coach', coachUid), coachReschedBefore + 1);
```

「過去堂移動→過去合法時段」案例（`bPastMove` 第一段）：比照辦理，在該案例的 `reset();` 之前加：

```js
const coachReschedBeforePastMove = notifCount('booking_rescheduled_coach', coachUid);
```

expect 內加：

```js
  assert.equal(notifCount('booking_rescheduled_coach', coachUid), coachReschedBeforePastMove + 1);
```

（檔尾清理已涵蓋：`coachUid` 是 `gp-%` 使用者，通知按 user_id 清。）

- [ ] **Step 2: 跑測試確認 RED**

Run: `cd /Users/ryansheu/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/booking-edit.test.js; DB_PATH="$(mktemp -d)/t.db" node tests/gcal-pull.test.js`
Expected: booking-edit 案例 2、3 ✗（`booking_rescheduled_coach` 零筆）、gcal-pull 兩個補了 delta 的案例 ✗；booking-edit 案例 1 本來就綠（回歸守門，RED 以案例 2、3 與 gcal delta 為準）；其餘既有案例 ✓。

- [ ] **Step 3: 實作**

(a) `src/services/notifications.js`：`booking_rescheduled` 模板區塊（`:57-60`）**之後、`booking_cancelled_by_member` 之前**插入：

```js
  booking_rescheduled_coach: {  // 寄給教練（改期成功；系統內改期排除操作者本人、gcal 拖拉一律發）
    subject: '預約時間已更新 - {{member_name}}',
    body: '🔄 {{member_name}} 的一對一預約已從 {{old_start_at}} 改至 {{start_at}}。',
  },
```

(b) `src/services/bookingService.js` `rescheduleBooking`：

`if (b.status === 'cancelled') throw …` 之後加一行（UPDATE 前留存原時段；`b` 是 UPDATE 前讀出的列）：

```js
    const oldStartAt = b.start_at; // 原時段（教練版通知用；勿在 UPDATE 後重讀）
```

既有客人通知（`if (coach) notify({ userId: b.member_id, … type: 'booking_rescheduled', … });`）**之後、`return` 之前**加：

```js
    if (coach && coach.user_id !== actorUserId) {  // 教練版：排除操作者本人（gcal 拖拉 actorUserId=null → 恆發）
      const memberRow = db.prepare('SELECT name FROM users WHERE id = ?').get(b.member_id);
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_rescheduled_coach',
        vars: { member_name: memberRow.name, old_start_at: fmtDateForLine(oldStartAt), start_at: fmtDateForLine(newStartAt) } });
    }
```

- [ ] **Step 4: 跑兩個測試檔確認 GREEN**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/booking-edit.test.js; DB_PATH="$(mktemp -d)/t.db" node tests/gcal-pull.test.js`
Expected: 全部 ✓、兩檔 exit 0。

- [ ] **Step 5: 跑完整 unit 測試鏈**

Run: `DB_PATH="$(mktemp -d)/t.db" npm test`
Expected: 全過（尤其 `tests/notifications-flow.test.js`、`tests/booking-flow.test.js` 等碰通知的檔案零回歸）。

- [ ] **Step 6: Commit**

```bash
git add src/services/notifications.js src/services/bookingService.js tests/booking-edit.test.js tests/gcal-pull.test.js
git commit -m "改期成功通知該堂教練（兩入口共用、系統內排除操作者本人）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
