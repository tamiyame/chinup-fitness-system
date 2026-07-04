# Google 日曆反向同步（拉回） — 設計規格

- 日期：2026-07-04
- 狀態：業主已核可設計與三項政策

## 目標

現況為寫入側單向同步（預約異動 → 寫 Google 日曆）。本功能加入**反向拉回**：Google 日曆上對系統事件（`chinupbk` 前綴）的人為異動，每分鐘增量拉回系統——

- **拖動改時間** → 合法就套用「改時段」（通知客人）；不合法就把事件改回 DB 時間並 **LINE 通知該預約的教練**。
- **刪除事件** → **自動取消**該筆未來預約（回補堂數＋釋放折扣碼），**通知管理者、不通知客人**（業主拍板）。
- 其他（改標題內文、店家手動建立的非系統事件、日曆上直接新增事件）→ 忽略。

**衝突時 DB 贏**：日曆異動是「提案」，套用不了就退回。DB 仍是唯一事實來源。

## 業主政策（已拍板）

1. 刪除事件＝自動取消：回補堂數＋通知管理者、**不通知客人**。
2. 被退回的移動：LINE 通知該預約的教練。
3. 輪詢頻率：**每 1 分鐘**（node-cron；API 用量 ~1.5k/日，遠低於配額）。

## 機制：syncToken 增量輪詢

- Calendar API `events.list` 的 `syncToken` 機制：首次「基準同步」全量列出並取得 token；之後每次只回異動的事件。
- **不做 webhook**（需網域驗證＋channel 續訂，且仍需 syncToken 拉內容；分鐘級延遲已足夠）。
- Token 存 `app_settings`：key `gcal_sync_token`，值為 JSON `{"calId":"…","token":"…"}`——**綁定日曆 ID**，管理者換日曆時 token 自動失效重建基準。無 schema 遷移（setSetting upsert 即可，無需 INSERT OR IGNORE 預設）。
- **基準同步**：`timeMin = 現在−1天`（RFC3339 +08:00）、`showDeleted=true`、`maxResults=250`、逐頁 `nextPageToken`；每一頁的 items 也走同一個分類器處理（冪等——與 DB 一致即 no-op；順便修復啟用前已存在的未來事件漂移）；最後一頁的 `nextSyncToken` 落庫。timeMin 限制會被 token 記住，之後增量只回該範圍事件（過去事件的異動自然不可見，符合「過去堂一律不理」）。
- **增量同步**：`events.list?syncToken=…` 逐頁處理、末頁 token 落庫。HTTP **410 GONE**（token 過期）→ 清 token、立刻重跑基準同步（含漂移修復）。
- 每 tick 最多 10 頁（失控保險；未拉完下個 tick 從原 token 重來，冪等）。
- 併發防護：模組級 `_pullRunning` boolean（比照 reconcile）。
- `isGcalEnabled()` 為 false → 直接 return。

## 事件分類器（`processEvent(ev)`，基準與增量共用）

依序判定（`now = nowLocal()`）：

1. `ev.id` 不符 `/^chinupbk\d{9}$/` → **忽略**（店家手動事件、外部事件）。
2. `bookingId = Number(ev.id.slice(8))`，查預約（含 coach、member）。查無 → 忽略。
3. **`ev.status === 'cancelled'`（日曆上被刪）**：
   - 預約已 `cancelled` → no-op（系統自己刪的回聲）。
   - 預約 `start_at <= now`（過去堂）→ **忽略**（不回補已上課堂數，保護薪資口徑）。
   - 否則 → `cancelBookingFromGcal(bookingId)`（見下）＋ `notifyAdmins(type:'gcal_delete_cancelled')`。
4. **事件存在（active）**：
   - 預約已 `cancelled` 但事件是 active（gcal「復原刪除」把事件救回）→ **DB 贏**：`deleteEvent` 再刪一次，不通知。
   - 解析 `ev.start.dateTime`/`ev.end.dateTime` 為台北牆鐘（重用 `taipeiParts`，改為 export；含秒）。**無 `dateTime`（被改成全天事件）→ 視為不合法移動**走退回。
   - 事件時間 == 預約 `start_at`/`end_at` → no-op（回聲；含系統改期後的狀態）。
   - **不同 → 移動提案**，合法性檢查（全過才套用）：
     a. 預約是未來堂（`b.start_at > now`）；過去堂 → **完全忽略**（不退回不通知，日曆歷史隨他）。
     b. 新起點在未來（`newStartAt > now`），否則退回（原因「不可移到過去」）。
     c. 整點：新起點 `分:秒 == 00:00`，否則退回（原因「需為整點起、60 分鐘」）。
     d. 時長恰 60 分鐘（`end − start == 3600 秒`），否則退回（同上原因）。
   - **套用**：`rescheduleBooking({ bookingId, newStartAt, actorUserId: null, isAdmin: true })`——重用既有改時段（撞課檢查、UNIQUE 防護、通知客人 `booking_rescheduled`）。丟 `slot_taken` → 退回（原因「時段衝突」）。套用成功後事件時間已與 DB 一致，不需回寫。
   - **退回**：`updateEvent(calId, eventId, buildEventBody(bookingId))` 把事件改回 DB 時間；**成功後**才 `notify` 該預約教練（`type:'gcal_move_rejected'`，vars：member_name／start_at（DB 原時段，fmtDateForLine）／reason）。updateEvent 失敗 → 只 log，下個 tick 事件仍與 DB 不一致會再試（通知只在退回成功那次發，不洗版；教練再移一次爛位置則屬新事件、再通知屬正確行為）。

## `cancelBookingFromGcal(bookingId)`（bookingService 新函式）

比照 `cancelBooking` 的 tx 內容但**對客人靜默**：

- 守門：預約存在、`status='confirmed'`（否則丟 409/404 由呼叫端吞掉當 no-op）。
- `cancelBookingStmt.run(nowLocal(), null, 'gcal_event_deleted', bookingId)`（cancelled_by=NULL、reason 供稽核）。
- `refundPackageForBooking(b)`（回補堂數）＋ `releaseRedemption({kind:'booking', refId})`（釋放折扣碼）。
- **不發任何 notify**（客人與教練都不發；管理者通知由呼叫端 gcalPull 發 notifyAdmins）。
- `UPDATE bookings SET gcal_event_id = NULL`（事件已不存在；避免 reconcile 再去刪一次）。
- 回傳 `{ ok, coachName, memberName, startAt, refunded }`（refunded＝有 package_id 才 true）供管理者通知文案。

## 通知模板（notifications.js `TEMPLATES` 新增兩則）

```
gcal_move_rejected:（發給該預約教練）
  subject: 'Google 日曆移動已退回'
  body: '您在 Google 日曆上移動的預約已退回：{{member_name}} {{start_at}}。原因：{{reason}}。如需改期請於系統內操作。'

gcal_delete_cancelled:（notifyAdmins，中性第三人稱）
  subject: 'Google 日曆刪除 → 預約已取消'
  body: 'Google 日曆上的事件被刪除，系統已自動取消預約：{{coach_display_name}} × {{member_name}}（{{start_at}}）{{refund_note}}。'
  // refund_note：'，方案已回補 1 堂' 或 ''
```

## gcalClient 擴充（維持零依賴、never-throws 風格）

- `listEvents(calendarId, params)`：GET `/calendars/{id}/events?…`（params 物件轉 query string）。回 `{ ok, items, nextPageToken, nextSyncToken, status }`；410 → `{ ok:false, status:410, … }` 讓上層辨識。
- `updateEvent(calendarId, eventId, body)`：PUT `/calendars/{id}/events/{eventId}`（body 含 `status:'confirmed'` 以支援理論上的復活場景）。
- `GCAL_MOCK='1'`：兩者記錄到 `__mockCalls`；`listEvents` 從新的可設定佇列 `__mockListQueue`（export，測試 push 假回應）shift 取回應，佇列空 → `{ ok:true, items:[], nextSyncToken:'mock-token' }`。`GCAL_MOCK='fail'` → `{ ok:false }`。

## 事件描述文案更新（buildEventBody）

`（chinup 系統自動建立，請勿手動修改；改動不會回寫系統）` 改為：
`（chinup 系統自動建立。可直接拖動改時段：需整點起、60 分鐘、未來時段；刪除事件＝取消預約並回補堂數）`

## 排程（scheduler.js）

```
每 1 分鐘：cron '* * * * *' → pullChanges()（gcalPull；未啟用時內部直接 return）
```

既有 5 分鐘 reconcile（補建/補刪）不動，與 pull 互為冪等兜底。

## 邊界與保護（彙總）

- **回聲防護**：一律「與 DB 比對、相同即跳過」；系統自身的寫入在下次輪詢天然 no-op。
- **過去堂保護**：過去預約的移動與刪除一律忽略（薪資、歷史不受日曆整理影響）。
- **換日曆**：token 綁 calId，換日曆自動重建基準。
- **多實例**：沿用現有單副本假設（Railway 單實例）。
- **首次部署**：基準同步會把「啟用前日曆上已被人動過的未來事件」套用或退回一次（含教練通知）——屬正確的一次性對帳，PR 說明中載明。
- **本機 smoke 限制**：本機無 SA 憑證，實際日曆行為以單元測試（GCAL_MOCK 佇列）驗證；真實環境驗證於合併部署後在 prod 日曆操作（移動一顆事件、等 1 分鐘）。

## 測試（tests/gcal-pull.test.js，掛 `npm test` 鏈；GCAL_MOCK=1）

分類器矩陣（直接呼叫 processEvent／pullChanges，資料鎖 2032 年、`gp-%` 前綴）：

1. 非 chinupbk id → 忽略；查無預約 → 忽略。
2. 回聲：事件時間==DB → no-op；已取消預約收到 cancelled 事件 → no-op。
3. 移動套用：未來堂、整點、60 分、無衝突 → 預約改期、客人收 `booking_rescheduled`、不呼叫 updateEvent。
4. 移動退回四因：撞課／非整點／非 60 分／移到過去 → updateEvent 被呼叫（body 時間=DB）、教練收 `gcal_move_rejected`（原因字串正確）、預約不變。
5. 全天事件（無 dateTime）→ 退回。
6. 過去堂：移動→完全忽略（無 updateEvent、無通知）；刪除→忽略（預約仍 confirmed、堂數不回補）。
7. 刪除未來堂：預約 cancelled、`cancel_reason='gcal_event_deleted'`、方案 remaining +1、折扣 redemption 釋放、`gcal_event_id` 清空、管理者收 `gcal_delete_cancelled`、**客人無任何通知**、教練無通知。
8. 已取消預約的事件被復原（active）→ deleteEvent 被呼叫。
9. Token 泵：無 token → 基準（listEvents 收到 timeMin/showDeleted 參數）→ token 落庫（含 calId）；有 token → 增量（收到 syncToken 參數）；410 → 清 token 重基準；calId 變更 → 重基準。
10. `isGcalEnabled()` false → pullChanges 不打 API。

## 範圍外（YAGNI）

- 日曆上直接新增事件 → 不建預約、不當忙碌區塊（PR #59 已定調不讀 freebusy 擋預約）。
- Webhook 推播、per-教練日曆、事件標題/描述的人為編輯回寫。
- 過去預約的任何回寫。
