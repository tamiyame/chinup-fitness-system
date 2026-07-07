# Google 日曆事件配色（非管理者石墨灰） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 非管理者教練的日曆事件帶 `colorId '8'`（石墨灰），管理者維持預設色；含既有未來事件一次性補色。

**Architecture:** 只動 `src/services/gcalSync.js`（getBookingFull 加 JOIN、buildEventBody 加 colorId、reconcile 加 colorBackfillOnce）＋測試。

**Spec:** `docs/superpowers/specs/2026-07-07-gcal-coach-color-design.md`

## Global Constraints

- 管理者（coach 對應 users.is_admin=1）事件 body **不得含 colorId 屬性**（非 null，是不存在）。
- 補色 flag key：`gcal_color_backfill_done`；恰達 LIMIT 500 → 不設 flag 續跑下輪。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: gcalSync 配色＋補色＋測試

**Files:**
- Modify: `src/services/gcalSync.js`
- Test: `tests/gcal-coach-color.test.js`（新檔，掛 npm test 鏈）
- Modify: `package.json`

- [ ] **Step 1: gcalSync.js — 常數、查詢、body**

模組頂（SESSION_LABELS 附近）加：

```js
const COACH_COLOR_ID = '8'; // 石墨灰：非管理者教練事件色；管理者不帶 colorId＝日曆預設色（業主 2026-07-07 拍板）
```

`getBookingFull` 查詢改為（加 coach 帳號 JOIN）：

```js
const getBookingFull = db.prepare(`
  SELECT b.*, c.display_name AS coach_name, u.name AS member_name, u.phone AS member_phone,
         cu.is_admin AS coach_is_admin
  FROM bookings b JOIN coaches c ON c.id = b.coach_id
  JOIN users u ON u.id = b.member_id
  JOIN users cu ON cu.id = c.user_id
  WHERE b.id = ?
`);
```

`buildEventBody` 的 return 物件加（transparency 之後）：

```js
    ...(b.coach_is_admin ? {} : { colorId: COACH_COLOR_ID }),
```

- [ ] **Step 2: gcalSync.js — reconcile 加一次性補色**

import 區補 `getSetting, setSetting`（併入既有 discountService import）與 `updateEvent`（若 syncBookingUpdate 已在本檔則不需）。`reconcile()` 內（isGcalEnabled 檢查之後）呼叫 `await colorBackfillOnce();`，並加函式：

```js
const BACKFILL_KEY = 'gcal_color_backfill_done';
const selColorBackfill = db.prepare(`
  SELECT b.id FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  JOIN users cu ON cu.id = c.user_id
  WHERE b.status = 'confirmed' AND b.gcal_event_id IS NOT NULL
    AND b.start_at >= ? AND cu.is_admin = 0
  ORDER BY b.start_at ASC LIMIT 500
`);

/** 一次性：把既有「未來、非管理者教練」事件 PUT 補上石墨灰（跑完設 flag；恰達 LIMIT 續跑下輪）。 */
async function colorBackfillOnce(nowStr) {
  if (getSetting(BACKFILL_KEY)) return;
  const rows = selColorBackfill.all(nowStr);
  for (const r of rows) await syncBookingUpdate(r.id);
  if (rows.length < 500) setSetting(BACKFILL_KEY, '1');
}
```

`reconcile()` 內已有 `nowStr` 組字串——把 `colorBackfillOnce(nowStr)` 放在 selToCreate 迴圈之前呼叫。

- [ ] **Step 3: 寫 `tests/gcal-coach-color.test.js`**（GCAL_MOCK=1、資料鎖 2035 年、`gc-%` 前綴；比照 gcal-pull 測試風格：清理、fixtures、__mockCalls 斷言；結尾還原 `gcal_calendar_id` 原值與清 `gcal_color_backfill_done`、清 fixtures）

案例：
1. 非管理者教練 booking → `buildEventBody(id).colorId === '8'`。
2. 管理者教練（users.is_admin=1）booking → `'colorId' in body === false`。
3. 補色：建非管理者未來 2 筆（有 event_id）＋管理者未來 1 筆（有 event_id）＋非管理者過去 1 筆＋非管理者未來但 event_id NULL 1 筆 → `setSetting('gcal_color_backfill_done','')` 清 flag → `reconcile()` → `__mockCalls` 中 `updateEvent` 恰 2 筆且 `args.event.colorId==='8'`；flag 已設。
   - 注意：reconcile 的 selToCreate 會把「confirmed 且 event_id NULL 且未來」的撿去 insertEvent——上面那筆 event_id NULL 的 fixture 會觸發 insertEvent，屬預期，斷言時把 updateEvent 與 insertEvent 分開數。
4. 再跑 `reconcile()` → 新增 updateEvent 呼叫數 0（冪等）。
5. 回歸：`node tests/gcal-sync.test.js`、`node tests/gcal-pull.test.js`、`node tests/gcal-pull-client.test.js` 全綠（body 多欄位不得破壞既有斷言；若有 deepEqual 全 body 的斷言需依實際情況更新並於報告載明）。

- [ ] **Step 4: 跑測試＋掛鏈＋commit**

```bash
node tests/gcal-coach-color.test.js
node tests/gcal-sync.test.js && node tests/gcal-pull.test.js && node tests/gcal-pull-client.test.js
# package.json test 鏈尾加 ` && node tests/gcal-coach-color.test.js`
git add src/services/gcalSync.js tests/gcal-coach-color.test.js package.json
git commit -m "feat: 日曆事件配色——非管理者教練石墨灰（含既有未來事件一次性補色）"
```

---

## 收尾（controller）

1. 全套 `npm test`＋`test:api` → 綠；re-seed demo。
2. 小型 review（sonnet）。
3. Push + draft PR（載明：部署後 5 分鐘內 reconcile 會自動補色既有未來事件；prod 驗證＝看日曆上非管理者教練的未來課變灰、管理者不變、新登錄一堂灰色）。
