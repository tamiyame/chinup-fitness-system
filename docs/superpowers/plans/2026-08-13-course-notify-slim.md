# 期課通知瘦身 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 會員只在報名成功時收一次期課通知——移除成班通知（會員面）與上課提醒整組。

**Architecture:** 純移除：`processDeadlines` 成班分支拔會員迴圈；`processReminders` 連同 cron、端點、後台按鈕、模板整組刪除。教練通知與未開課通知零改動。

**Tech Stack:** Node ESM、node:sqlite、plain-node assert 測試。

**Spec:** `docs/superpowers/specs/2026-08-13-course-notify-slim-design.md`（保留清單是驗收基準，實作前先讀）

## Global Constraints

- 單元測試**絕不**對 `data/app.db` 跑：一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴。
- 未開課分支（`course_cancelled` 給會員）、教練通知（`course_confirmed_coach` 等）、renewal reminders（9:00 堂數續購提醒 cron）一行不動。
- 通知紀錄型別標籤表（admin.js `:281-282`）保留——歷史列要正確顯示。
- commit 訊息：繁中一行主旨，結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 移除會員成班通知＋上課提醒整組

**Files:**
- Modify: `src/services/courseService.js`（processDeadlines 成班分支、刪 processReminders）
- Modify: `src/scheduler.js`（import＋cron 區塊）
- Modify: `src/server.js:8`（import）、`:1284-1286`（端點）
- Modify: `src/services/notifications.js:39-42`（reminder 模板）
- Modify: `public/admin.html:580`（按鈕）
- Modify: `public/admin.js`（handler `:748-756`、說明彈窗 `reminders:` 條目、截止判定說明措辭）
- Test: `tests/course-coach-notify.test.js`（成班場景加兩斷言）

**Interfaces:**
- Consumes: 既有 `processDeadlines`（回傳值與未開課行為不變）。
- Produces: `processReminders`、`POST /api/admin/jobs/send-reminders`、`reminder` 模板自此不存在；grep 全 repo 不得殘留引用（tests 目錄無既有引用，已盤點）。

- [ ] **Step 1: 寫測試（RED 目標）**

`tests/course-coach-notify.test.js`：在 `processDeadlines();` 之後、既有兩個教練斷言（`成班→教練收到 course_confirmed_coach`）旁，加：

```js
const memberSessNotif = (uid, type, sid) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=? AND session_id=?').get(uid, type, sid).c;
expect('成班→會員不再收 course_confirmed（報名成功那次就好）', () => assert.equal(memberSessNotif(m1, 'course_confirmed', sC.id), 0));
expect('未開課→會員仍收 course_cancelled（回歸守門）', () => assert.equal(memberSessNotif(m2, 'course_cancelled', sX.id), 1));
```

（`m1`/`m2`/`sC`/`sX` 是該檔既有 fixtures：m1 報名 sC 成班課、m2 報名 sX 未開課，見 `:101-113`。）

- [ ] **Step 2: 跑測試確認 RED**

Run: `cd /Users/ryansheu/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/course-coach-notify.test.js`
Expected: 新斷言 1 ✗（成班會員現況會收到 1 筆）、新斷言 2 ✓（回歸守門本來就綠）、其餘 ✓、exit 1。

- [ ] **Step 3: 實作移除（七處）**

(a) `src/services/courseService.js` `processDeadlines` 成班分支：刪除會員迴圈（`const regs = …` 查詢**保留**，教練通知 `count: regs.length` 仍用；未開課分支一行不動）：

```js
        for (const r of regs) {
          notify({ userId: r.user_id, sessionId: s.id, type: 'course_confirmed', vars: { course_name: s.course_name, start_at: s.start_at } });
        }
```

(b) `src/services/courseService.js`：整段刪除 `processReminders` 函式（含前導註解 `// 上課前 24h 提醒`，從 `export function processReminders() {` 到對應 `}`）。

(c) `src/scheduler.js`：`:2` import 改為 `import { processDeadlines } from './services/courseService.js';`；刪除整個「每天早上 9 點寄送上課提醒」cron 區塊（`cron.schedule('0 9 * * *', …)` 中呼叫 `processReminders()` 的那一個——**同檔還有另一個 9:00 的 renewal reminders 區塊，不得誤刪**）。

(d) `src/server.js:8`：import 列移除 `processReminders,`（保留 `processDeadlines`）；刪除端點區塊：

```js
app.post('/api/admin/jobs/send-reminders', requireAdmin, asyncHandler((req, res) => {
  res.json({ sent: processReminders() });
}));
```

(e) `src/services/notifications.js:39-42`：刪除 `reminder: { … },` 模板區塊（`renewalReminderService` 用的 `package_low_sessions`/`group_last_session` 是不同模板，不動）。

(f) `public/admin.html:580`：刪除 `<button id="run-reminders" class="btn btn-dark">寄送上課提醒</button>`。

(g) `public/admin.js`：
   - 刪除 `document.getElementById('run-reminders').addEventListener(…)` 整個區塊（`:748-756`）。
   - 刪除說明彈窗物件的 `reminders: { … },` 整個成員（`:2675` 起）。
   - 截止判定說明（`:2670` 附近）把 `<li>已確認人數 <strong>≥ 最低成班人數</strong> → <strong>成班</strong>，通知學員與該堂教練「成班」。</li>` 改為 `<li>已確認人數 <strong>≥ 最低成班人數</strong> → <strong>成班</strong>，通知該堂教練「成班」（學員報名成功時已通知，不再重複）。</li>`；未開課那行**不動**。
   - 型別標籤表（`:281-282`）**保留不動**。

- [ ] **Step 4: 殘留掃描＋單檔 GREEN**

Run: `grep -rn "processReminders\|send-reminders\|run-reminders" src/ public/ tests/; DB_PATH="$(mktemp -d)/t.db" node tests/course-coach-notify.test.js`
Expected: grep 零筆；測試全 ✓ exit 0。

- [ ] **Step 5: 完整 unit 鏈＋開機煙測**

Run: `DB_PATH="$(mktemp -d)/t.db" npm test`
Expected: 全過（unit 鏈不載入 server.js/scheduler.js，所以另需開機煙測抓 import 殘留）。

Run（開機煙測，fresh DB＋mocks，絕不用 data/app.db）:
```bash
SMOKE_DB="$(mktemp -d)/t.db"
DB_PATH="$SMOKE_DB" PORT=3999 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js & SRV=$!
sleep 2 && curl -sf http://localhost:3999/api/health; RC=$?
kill $SRV
exit $RC
```
Expected: `/api/health` 回 200（RC=0），代表 server.js＋scheduler.js import 乾淨。

- [ ] **Step 6: Commit**

```bash
git add src/services/courseService.js src/scheduler.js src/server.js src/services/notifications.js public/admin.html public/admin.js tests/course-coach-notify.test.js
git commit -m "期課通知瘦身：移除會員成班通知與上課提醒整組（報名成功一次就好）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
