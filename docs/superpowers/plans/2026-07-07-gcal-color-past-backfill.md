# 日曆配色回補過去預約 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 石墨灰回補到過去的非管理者事件（直接 PUT、404/失敗跳過不重建、不清 event_id；flag 一次性）。

**Spec:** `docs/superpowers/specs/2026-07-07-gcal-color-past-backfill-design.md`

## Global Constraints

- 過去堂**不得**走 `syncBookingUpdate`（其 404→insert 會復活已刪歷史事件、失敗會清 event_id）——用 `updateEvent` 直接 PUT、失敗只 log。
- flag key：`gcal_color_backfill_past_done`。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: gcalSync 過去補色＋測試

**Files:**
- Modify: `src/services/gcalSync.js`（`colorBackfillOnce` 之後）
- Modify: `tests/gcal-coach-color.test.js`（追加案例）

- [ ] **Step 1: gcalSync.js 加過去補色（`colorBackfillOnce` 之後）**

```js
const PAST_BACKFILL_KEY = 'gcal_color_backfill_past_done';
const selPastColorBackfill = db.prepare(`
  SELECT b.id FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  JOIN users cu ON cu.id = c.user_id
  WHERE b.status = 'confirmed' AND b.gcal_event_id IS NOT NULL
    AND b.start_at < ? AND cu.is_admin = 0 AND b.id > ?
  ORDER BY b.id ASC LIMIT 200
`);

/** 一次性：石墨灰回補「過去」的非管理者事件（業主 2026-07-07 要求）。
 *  直接 PUT：404（曾被手動刪）→ 跳過不重建、不清 event_id（避免復活歷史已刪事件）；
 *  其他失敗只 log（歷史純外觀，不進自癒迴圈）。 */
async function pastColorBackfillOnce(nowStr) {
  if (getSetting(PAST_BACKFILL_KEY)) return;
  const calId = getGcalCalendarId();
  let lastId = 0;
  for (;;) {
    const rows = selPastColorBackfill.all(nowStr, lastId);
    for (const r of rows) {
      const body = buildEventBody(r.id);
      if (!body) continue;
      const res = await updateEvent(calId, body.id, body);
      if (!res.ok && res.status !== 404) console.error('[gcal] past color backfill failed:', r.id, res.error);
    }
    if (rows.length < 200) break;
    lastId = rows[rows.length - 1].id;
  }
  setSetting(PAST_BACKFILL_KEY, '1');
}
```

`reconcile()` 內、`colorBackfillOnce(nowStr)` 呼叫之後加 `await pastColorBackfillOnce(nowStr);`。（`updateEvent` 已在 import；若未 import 併入。）

- [ ] **Step 2: 測試追加（沿用檔內 fixtures 風格；清 `gcal_color_backfill_past_done` flag 於開頭與結尾）**

案例（照 spec 四點）：過去非管理者 2 筆有 event_id → updateEvent×2 帶 colorId '8'；管理者過去堂／取消堂／event_id NULL 不碰；`__mockUpdateQueue.push({ok:false,status:404})` 讓第一筆 404 → 無 insertEvent、該筆 `gcal_event_id` 不變、第二筆照補、flag 照設；再跑 reconcile 零新呼叫；未來補色既有案例維持全綠。

- [ ] **Step 3: 跑測試＋commit**

```bash
node tests/gcal-coach-color.test.js && node tests/gcal-sync.test.js && node tests/gcal-pull.test.js
git add src/services/gcalSync.js tests/gcal-coach-color.test.js
git commit -m "feat: 日曆配色回補過去預約（直接 PUT、404 跳過不復活歷史事件）"
```
