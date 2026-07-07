# Google 日曆事件配色：非管理者教練石墨灰 — 設計規格

- 日期：2026-07-07
- 狀態：業主已核可（色選 colorId 8 石墨灰）

## 目標

同步到 Google 日曆的預約事件：**非管理者教練**的時間塊帶 `colorId: '8'`（石墨灰）；**管理者**（`users.is_admin=1`）的維持日曆預設色。一眼可分「管理者自己的課 vs 其他教練的課」。

## 做法

### 1. `buildEventBody`（gcalSync.js，單一改動點）

- `getBookingFull` 查詢加 JOIN 教練帳號：`JOIN users cu ON cu.id = c.user_id`，取 `cu.is_admin AS coach_is_admin`。
- 事件 body：`coach_is_admin` 為真 → 不帶 `colorId`；否則帶 `colorId: COACH_COLOR_ID`（模組常數 `'8'`，附註解）。
- 建立（insert／409→PUT 復活）、改期（syncBookingUpdate）、反向同步退回（revertEvent）全走此函式 → 一處改全生效。
- 反向同步的回聲比對只看時間，**人工在日曆改色不會觸發退回**（色與時間解耦，安全）。

### 2. 一次性補色（既有未來事件）

- `reconcile()`（5 分鐘 cron）內加一次性步驟 `colorBackfillOnce()`：
  - `app_settings` key `gcal_color_backfill_done` 已設 → 直接 return。
  - 撈「未來、confirmed、`gcal_event_id IS NOT NULL`、教練非管理者」的預約（LIMIT 500），逐筆 `syncBookingUpdate`（PUT 全量 body 即帶新色；失敗走既有清 event_id → reconcile 補建的自癒路徑）。
  - 完成後 `setSetting('gcal_color_backfill_done', '1')`（不足 LIMIT 一次跑完；若恰達 LIMIT 不設 flag，下輪續跑）。
- 管理者的既有事件不動（本來就是預設色）。

## 範圍外

- 團體課場次（本來就不同步日曆）。
- 每教練不同色（業主選單一石墨灰）。
- 後台可調色設定（先固定常數，要改再說）。

## 測試（擴充/新檔掛 npm test 鏈，GCAL_MOCK=1）

1. `buildEventBody`：非管理者教練 → `colorId === '8'`；管理者教練 → body **無** `colorId` 屬性。
2. 補色：建管理者/非管理者教練各若干筆未來 confirmed（有 event_id）→ 跑 `reconcile()` → `updateEvent` 只對非管理者呼叫且 body 帶色；flag 已設；再跑 → 零補色呼叫（冪等）。過去堂/已取消/無 event_id 不補。
3. 既有 `gcal-sync.test.js`、`gcal-pull.test.js` 回歸（body 多欄位不得破壞既有斷言）。
