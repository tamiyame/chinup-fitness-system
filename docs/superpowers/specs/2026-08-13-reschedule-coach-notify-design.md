# 改期成功通知該堂教練 — 設計規格

- 日期：2026-08-13
- 狀態：業主已核可設計

## 背景

PR #118 過去堂連動上線後，業主指出：拖拉行事曆造成時間異動時「也要推播通知」。現況是系統內改期與 Google 拖拉都走同一支 `rescheduleBooking`，成功時**只通知客人**（`booking_rescheduled`）——該堂教練與管理者都不知道課移了；教練只有在移動被退回時才收到 `gcal_move_rejected`。

## 業主政策（已拍板）

1. 通知對象：**只加該堂教練**（不另通知管理者）。
2. 範圍：**兩個入口都加**（系統內改期＋Google 拖拉），延續「Google 端＝系統內同一入口」原則。
3. 排除操作者本人：系統內改期知道 `actorUserId`，教練改自己的課（含管理者兼教練改自己的課）不通知自己；Google 拖拉辨識不出拖動者（`actorUserId=null`），一律通知該堂教練。

## 變更點（零 schema、零 API、零前端改動）

1. **`src/services/notifications.js` TEMPLATES 新增一則**（比照 `booking_recurring_created_coach` 的教練版中性第三人稱、`booking_rescheduled` 的 🔄 開頭）：

```js
  booking_rescheduled_coach: {  // 寄給教練（改期成功；系統內改期排除操作者本人、gcal 拖拉一律發）
    subject: '預約時間已更新 - {{member_name}}',
    body: '🔄 {{member_name}} 的一對一預約已從 {{old_start_at}} 改至 {{start_at}}。',
  },
```

2. **`src/services/bookingService.js` `rescheduleBooking`**：
   - UPDATE 前先留存原時段 `const oldStartAt = b.start_at;`（`getBookingStmt` 已取得，勿在 UPDATE 後才讀）。
   - 補查會員姓名（目前函式內只有 `b.member_id`）：`const memberRow = db.prepare('SELECT name FROM users WHERE id = ?').get(b.member_id);`。
   - 既有客人通知之後，加教練通知：

```js
    if (coach && coach.user_id !== actorUserId) {
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_rescheduled_coach',
        vars: { member_name: memberRow.name, old_start_at: fmtDateForLine(oldStartAt), start_at: fmtDateForLine(newStartAt) } });
    }
```

   - `actorUserId=null`（gcal 拖拉）時 `coach.user_id !== null` 恆真 → 一律通知，符合政策 3。

3. 客人通知（`booking_rescheduled`）、退回通知（`gcal_move_rejected`）、`reassignBooking`（改客人/方案，時間不變）全部不動。

## 語意矩陣

| 操作 | 客人 | 該堂教練 |
|---|---|---|
| 教練系統內改自己的課 | 🔄 通知（不變） | 不通知（操作者本人） |
| 管理者系統內改某教練的課 | 🔄 通知（不變） | **新增** 🔄 通知 |
| 管理者系統內改自己兼教練的課 | 🔄 通知（不變） | 不通知（操作者本人） |
| Google 拖拉（不分過去未來堂） | 🔄 通知（不變） | **新增** 🔄 通知 |
| 移動被退回 | 無（不變） | `gcal_move_rejected`（不變） |

## 測試

- **`tests/booking-edit.test.js`**（系統內入口）三情境：
  1. 教練本人改期（`actorUserId = coach.user_id`）→ 客人通知 +1、教練 `booking_rescheduled_coach` 零筆。
  2. 管理者代改（`actorUserId = 管理者 uid、isAdmin:true`）→ 教練 +1，body 同時含舊時段與新時段字樣。
  3. `actorUserId: null, isAdmin: true`（gcal 路徑同參數）→ 教練 +1。
- **`tests/gcal-pull.test.js`**（拖拉入口）：既有「合法移動→套用」案例補教練 delta 斷言（before-count → +1，比照檔內 delta 模式）；「過去堂移動→過去合法時段」案例同樣補教練 delta +1。既有其餘案例（含退回類教練通知 `gcal_move_rejected` 計數）不得受影響。
- 通知計數一律 delta 斷言（先記 before-count），不做絕對值。

## 範圍外（YAGNI）

- 管理者稽核通知（業主拍板不要）。
- 循環預約整批改期通知彙整（拖拉本來就逐堂一筆）。
- Email/其他通道（notify 既有管道行為不變）。
