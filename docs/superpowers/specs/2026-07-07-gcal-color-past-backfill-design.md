# 日曆配色回補過去預約 — 設計規格

- 日期：2026-07-07
- 狀態：業主要求（PR #90 補色僅涵蓋未來，回補歷史時間塊）

## 目標

把石墨灰配色回補到**過去**的非管理者教練事件（PR #90 只補了未來）。

## 做法（只動 `src/services/gcalSync.js`＋測試）

- reconcile 內加第二個一次性步驟 `pastColorBackfillOnce(nowStr)`，flag key `gcal_color_backfill_past_done`：
  - 撈「`start_at < now`、confirmed、`gcal_event_id IS NOT NULL`、教練非管理者」，id 游標分批（LIMIT 200）同輪跑完。
  - **每筆直接 `updateEvent(calId, eventIdForBooking(id), buildEventBody(id))`**——不走 `syncBookingUpdate`：
    - 404（事件曾被人手動刪除）→ **跳過**，不重建（避免復活歷史已刪事件）、不清 `gcal_event_id`。
    - 其他失敗 → log 後跳過（歷史純外觀，不進自癒迴圈）。
  - 全部掃完設 flag；之後每次 reconcile 只剩一次 getSetting。
- 取消的預約 `gcal_event_id` 已為 NULL，自然排除；比整合上線（2026-06-12）更早的預約本來就沒有事件，同樣自然排除。

## 測試（擴充 `tests/gcal-coach-color.test.js`）

1. 過去堂（非管理者、有 event_id）→ updateEvent 被呼叫且 body 帶 `colorId '8'`；管理者過去堂、取消堂、event_id NULL 不碰。
2. `__mockUpdateQueue` 注入 404 → 該筆跳過：**無 insertEvent**、`gcal_event_id` 不變、其餘筆照補、flag 照設。
3. flag 冪等：再跑 reconcile 零新呼叫。
4. 既有未來補色（PR #90）行為不受影響。
