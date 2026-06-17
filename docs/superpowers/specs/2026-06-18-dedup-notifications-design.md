# 修正 LINE 通知重複發送 + 團課訂單逐堂發送 — 設計文件

> 日期：2026-06-18
> 範圍：通知層（1對1 建單通知 + 團課確認收款通知 + notifyAdmins 原語），單一子系統一份 spec。

## 問題（業主回報，附 LINE 截圖）

1. **重複發送**：同一則通知對「同時是教練又是管理者」的人發兩次。
2. **團課一張訂單含多個日期 → 逐堂各發一則**（截圖：一張綜合體能(週三)訂單，5 個日期各發、且「你帶的…」與「報名了…」兩版都發）。

## 根因（已查證，附 file:line）

- **共同根因**：本專案「管理者＝教練的 is_admin 標籤」，所以帶課教練通常 `is_admin=1`。兩條流程都「直接通知教練」**＋**「廣播給所有管理者（`notifyAdmins`）」，而 `notifyAdmins` 只排除 member、**從不排除教練**（`src/services/notifications.js:278-283`，`getAdminUserIds = SELECT id FROM users WHERE is_admin=1` at :173）。教練兼管理者 → 同一事件收兩則。
- **1對1**（`src/services/bookingService.js:94,99`）：line 94 直接 `notify(booking_created)` 給 `coach.user_id`；line 99 `notifyAdmins(booking_created, excludeUserId: memberId)`。教練兼管理者 → 同一句「{name} 預約了 … 一對一課程」收兩次。
- **團課**（`src/services/groupOrderService.js:199-204`）：在 `for (const cs of confirmedSessions)` 迴圈內，每場呼叫 `notifyCourseCoach(course_registered_coach,「你帶的…」)`（:201）＋`notifyAdmins(course_registered_admin,「報名了…」)`（:203）。→ (A) N 個日期發 N×2 則；(B) 教練兼管理者每場再收「你帶的」＋「報名了」兩版。
- **已確認沒問題的**：會員端收款通知 `payment_received` 在 `confirmGroupOrder` 只發**一則**（`groupOrderService.js:185-191`，取第一場），不需動。1對1 recurring 已正確彙整成一則摘要且有排除（`bookingService.js:536-540`），不需動。legacy `register()`（`registration.js`）只有 `seed-demo.js` 用，非 prod 路徑，不動。

## 已拍板決策（業主）

1. **彙整格式**：`🏋️ {member} 報名了你帶的「{course}」共 {N} 堂（7/1、7/8、…）。`（課名＋堂數＋日期清單；日期為 `M/D` 升冪）。
2. **收件模型（1對1 與團課一致，去重）**：教練收「你帶的」**一則**；其他「非教練的管理者」收訂單摘要**一則**；教練即使也是管理者也只收一則（即把教練 user_id 從管理者廣播排除）。

## 架構

### A. 共用原語：`notifyAdmins` 支援排除多個 user id

`src/services/notifications.js` 的 `notifyAdmins` 增加 `excludeUserIds`（陣列），與既有 `excludeUserId` 合併成排除集合；向後相容（既有呼叫端只傳 `excludeUserId` 不受影響）。

```js
export function notifyAdmins({ sessionId = null, type, vars = {}, excludeUserId = null, excludeUserIds = [] }) {
  const exclude = new Set(excludeUserIds);
  if (excludeUserId != null) exclude.add(excludeUserId);
  for (const row of getAdminUserIds.all()) {
    if (exclude.has(row.id)) continue;
    notify({ userId: row.id, sessionId, type, vars });
  }
}
```

### B. 1對1 建單（`bookingService.js:99`）— Issue 1

admin 廣播改為同時排除 member 與教練：

```js
notifyAdmins({ type: 'booking_created', excludeUserIds: [memberId, coach.user_id],
  vars: { member_name: memberRow.name, start_at: startFmt } });
```

→ 教練收 line 94 那一則直接的 `booking_created`；其他非教練管理者收廣播；教練不再重複。其餘（member 的 `booking_confirmed`）不變。

### C. 團課確認收款（`groupOrderService.js:192-204`）— Issue 1＋2

把「逐場迴圈通知」改為「整張訂單彙整」。會員 `payment_received`（:185-191）保持不動。

1. 撈出本訂單所有 confirmed 場次（沿用既有 SELECT，加 `ORDER BY s.start_at`）：欄位 `session_id, coach_id, start_at, course_name`。
2. 依 **(coach_id, course_name)** 分組 → 每位教練每門課一則「你帶的」。
3. 依 **course_name** 分組 → 管理者每門課一則摘要。
4. 管理者廣播以 `excludeUserIds = [order.member_id, ...該訂單所有教練的 user_id]` 去重。教練 user_id 以 groupOrderService 自有的 prepared stmt 由 `coaches.id` 解析（不跨模組）。
5. 每組 N=1 用單堂範本（`course_registered_coach` / `course_registered_admin`），`start_at` 傳 **`M/D`** 格式（比現行原始 `2026-07-08T19:00:00` 美觀）；N>1 用新彙整範本（見 D），帶 `count` 與 `date_list`。
6. 跨多門課的訂單：每門課各一則（不同課無法併成同一句「共 N 堂」）；常見單一課程多日期 → 教練 1 則＋非教練管理者 1 則。

`notifyCourseCoach({ coachId, sessionId, type, vars })` 簽章不變；`sessionId` 傳該組第一個 session_id（僅作通知列記錄用）。

### D. 新增彙整範本（`notifications.js`，N>1 用；單堂範本沿用、不改文案）

```js
course_registered_coach_batch: {
  subject: '新報名 - {{course_name}}',
  body: '🏋️ {{member_name}} 報名了你帶的「{{course_name}}」共 {{count}} 堂（{{date_list}}）。',
},
course_registered_admin_batch: {
  subject: '新報名 - {{course_name}}',
  body: '🏋️ {{member_name}} 報名了「{{course_name}}」共 {{count}} 堂（{{date_list}}）。',
},
```

### E. 日期格式 helper（`groupOrderService.js` 內）

```js
// '2026-07-08T19:00:00' → '7/8'（無前導零、無年、無時間）
function fmtMD(startAt) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(startAt || '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(startAt);
}
```
`date_list = dates.map(fmtMD).join('、')`（dates 已由 SQL `ORDER BY s.start_at` 升冪）。

## 邊界情況

- **教練未設定**（`coach_id` 為空）：`notifyCourseCoach` 本就靜默略過；該組仍會進管理者摘要（course_name 分組），coachUserIds 過濾掉 null。
- **教練非管理者**：行為不變（教練收一則；廣播與其無關）。
- **無其他管理者**（一人工作室）：教練收「你帶的」一則，管理者廣播收件人為空 → 不發 → 整單就一則。
- **N=1 團課訂單**：用單堂範本＋`M/D`，文案「報名了你帶的「課程」（7/1）。」。
- **跨多課程訂單**：每門課一則（教練版依 coach+course、管理者版依 course）。

## 測試

新增 `tests/notification-dedup.test.js`（in-process，`LINE_MOCK=1`；直接呼叫 service，查 `notifications` 表計數與 body）：

1. **1對1 去重**：建立一位「教練兼管理者」(is_admin=1) 的教練 + 一位 member，呼叫 `createBooking`/`createBookingAnon` → 該教練的 `booking_created` 通知列**恰 1 筆**（修正前為 2）。
2. **團課彙整**：一張訂單含同一課程 N(=3) 場（同一教練兼管理者）→ `confirmGroupOrder` 後，該教練收到 **1 筆** `course_registered_coach_batch`，body 含全部 3 個 `M/D`、`共 3 堂`；該教練**沒有** `course_registered_admin*`（被排除）；member 仍 1 筆 `payment_received`。
3. **團課 N=1**：單場訂單 → 教練收 1 筆 `course_registered_coach`（單堂範本，body 含 `M/D`，無「共 N 堂」）。
4. **非教練管理者仍收摘要**：另建一位「純管理者（is_admin=1、非該課教練）」→ 團課確認後該管理者收到 1 筆 `course_registered_admin*`。
5. **回歸**：跑既有 `tests/course-coach-notify.test.js`、`tests/group-order-service.test.js`、`tests/notifications-flow.test.js`、`tests/booking-flow.test.js`；更新其中對「逐場/舊版」通知形狀的斷言以符合彙整後行為（實作時逐一檢視）。

## 不做（YAGNI）

- 不在 notify 原語加 idempotency/UNIQUE 欄位（本次重複是「兩個呼叫點打到同一人」，不是同一呼叫重送；加 schema 過度）。
- 不動會員端 `payment_received`（已是整單一則）、不動 recurring、不動 legacy `register()`。
- 不改 email 通道。
