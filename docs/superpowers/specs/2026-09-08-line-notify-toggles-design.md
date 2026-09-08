# LINE 通知開關（總開關＋16 項目）＋本月推播額度進度條 — 設計規格

- 日期：2026-09-08
- 狀態：業主已核可設計（開關部分）；額度進度條為同日追加需求，併同一支 PR

## 背景

所有 LINE 推播只走 `src/services/notifications.js` 的 `notify()` 一個入口：收件人有綁 LINE 就推播、沒綁就只寫紀錄（console 通道）。2026-08-20 起 LINE 官方帳號免費方案的月推播額度用完，之後的推播全部 429（`chinup_line_quota_429`），業主要求：

1. **先把 LINE 通知全部關掉**（升級方案前不再推）。
2. 後台「LINE 管理」頁籤加一個區塊，用 ON／OFF 控制 LINE 通知：**總開關（全關／全開）＋個別項目開關**。項目依 8/5 整理的「LINE 通知事件全圖」設計，業主選定顆粒度＝**依事件分 3 組 16 項**（非逐模板、非只分收件人）。
3. 同頁籤再加一個**遊戲風格的進度條**，看得到本月免費推播額度還剩多少、以及何時重置。

現役推播模板 31 種（8/5 之後：#120 移除會員成班＋上課提醒；#119 加 `booking_rescheduled_coach`；#124 加 `period_rollover_admin`）。綁定碼的對話回覆走 reply API（不算推播額度）、email 確認信走 gmail，兩者**不在本案範圍**。

## 目標

- 部署當下 LINE 推播即全關，不需人工操作。
- 後台可個別開關 16 個事件項目，也可一鍵全開／全關。
- 關閉時通知仍寫進後台「通知紀錄」（看得到系統本來要送什麼），只是不推 LINE。
- 關閉期間的通知，開回來**不補送**。
- 後台一眼看到「本月還剩幾則、幾天後重置」，數字直接來自 LINE 官方 API（含從 LINE Official Account Manager 手動群發的用量）。

## 變更點

### 1. 設定儲存（`app_settings`，無 schema 變更）

| key | 值 | 未設定時 |
|---|---|---|
| `line_notify_master` | `'1'` / `'0'` | **OFF**（＝部署即全關） |
| `line_notify_<item_key>` | `'1'` / `'0'` | ON |

「有效」判定：`master === ON && item === ON`。項目未設定視為 ON，所以打開總開關後、沒特別關的項目都會送。

### 2. 項目目錄與判定（新檔 `src/services/lineNotifyPolicy.js`）

**不得 import `discountService.js`**（它 import `registration.js` → `notifications.js`，會和本檔被 `notifications.js` import 形成循環）。直接用 `db` 準備自己的 `SELECT value FROM app_settings WHERE key = ?` 與 `INSERT ... ON CONFLICT(key) DO UPDATE` 語句。

匯出：

- `LINE_NOTIFY_GROUPS`：目錄常數（下表），形狀 `[{ key, label, items: [{ key, label, recipients, types: [] }] }]`。
- `isLineNotifyEnabled(type)` → boolean：master OFF → false；type 對應到某項目 → 該項目值（未設定＝ON）；type 不在目錄（legacy 4 種＋已停用的會員 `course_confirmed`）→ true（只受總開關管）。
- `getLineNotifyState()` → `{ master: boolean, groups: [{ key, label, items: [{ key, label, recipients, enabled }] }] }`（不含 `types`，前端不需要）。
- `setLineNotifyState({ master, items })`：`master` 若提供必須是 boolean，否則 `ApiError(400, 'invalid_line_notify_master')`；`items` 若提供必須是物件、每個 key 必須是目錄內的項目 key，否則 `ApiError(400, 'invalid_line_notify_item')`；每個值必須是 boolean，否則 `ApiError(400, 'invalid_line_notify_value')`。先全部驗證再於 `tx()` 內寫入，回傳 `getLineNotifyState()`。`ApiError` 從 `./registration.js` 取：這會形成間接循環（registration → notifications → 本檔 → registration），但 `ApiError` 只在函式呼叫時取用、`isLineNotifyEnabled` 是函式宣告（hoisted），三個模組頂層都不互相取值，對 ESM 評估順序安全。

**項目目錄（3 組 16 項）**

| group key／label | item key | label | recipients | types |
|---|---|---|---|---|
| `one_on_one`／一對一教練課 | `booking_new` | 新預約 | 教練＋管理者 | `booking_created` |
| | `booking_confirmed_member` | 預約成功 | 會員 | `booking_confirmed` |
| | `booking_recurring` | 循環登錄排定 | 會員摘要＋教練 | `booking_recurring_created`, `booking_recurring_created_coach` |
| | `booking_payment` | 款項已確認 | 會員 | `booking_payment_received` |
| | `booking_reschedule` | 改期 | 會員＋教練 | `booking_rescheduled`, `booking_rescheduled_coach` |
| | `booking_cancel_member` | 預約取消／退款 | 會員 | `booking_cancelled_by_coach`, `booking_cancelled_by_shop`, `booking_refunded` |
| | `booking_cancel_coach` | 預約取消 | 教練 | `booking_cancelled_by_member`, `booking_cancelled_by_shop_coach` |
| `group`／團體課程 | `group_payment` | 匯款已收到 | 會員 | `payment_received` |
| | `group_registered_staff` | 新報名 | 教練＋管理者 | `course_registered_coach`, `course_registered_coach_batch`, `course_registered_admin`, `course_registered_admin_batch` |
| | `group_waitlist` | 候補與遞補 | 候補會員＋教練 | `group_promoted`, `course_waitlisted_coach`, `course_promoted_coach` |
| | `group_member_cancel_coach` | 會員取消／請假 | 教練 | `course_member_cancelled_coach`, `course_member_leave_coach` |
| | `group_session_outcome` | 成班／未開課判定 | 教練＋未開課會員 | `course_confirmed_coach`, `course_cancelled_coach`, `course_cancelled` |
| | `group_refund` | 訂單退款 | 會員 | `group_order_refunded` |
| `system`／排程與系統 | `renewal_reminder` | 續購提醒 | 會員 | `package_low_sessions`, `group_last_session` |
| | `gcal_sync` | Google 日曆同步 | 教練退回＋管理者取消 | `gcal_move_rejected`, `gcal_delete_cancelled` |
| | `period_rollover` | 期課續期 | 管理者 | `period_rollover_admin` |

每個 type 只能屬於一個項目；31 種現役模板全部涵蓋。

### 3. 攔截點（`src/services/notifications.js`）

- `notify()`：`if (user.line_user_id && isLineNotifyEnabled(type)) deliverLine(...) else deliverConsole(...)`。其餘（模板渲染、deleted user 略過、notifyCourseCoach／notifyAdmins 沿用 notify）一行不動。關閉時的紀錄與未綁定者相同：`channel='console'`、`status='sent'`，後台通知紀錄「通道」欄顯示 console。
- `processFailedNotifications()`：LINE 通道的到期列在呼叫 `sendMessage` 之前先檢查 `isLineNotifyEnabled(row.type)`；為 false 就 `updateFailedPermanent.run('line_notify_off', row.id)` 並 `continue`。email 通道列不受影響。

### 4. API（`src/server.js`，緊接既有 `/api/admin/settings` 之後）

```js
app.get('/api/admin/line-notify', requireAdmin, asyncHandler((req, res) => {
  res.json(getLineNotifyState());
}));
app.patch('/api/admin/line-notify', requireAdmin, asyncHandler((req, res) => {
  res.json(setLineNotifyState(req.body || {}));
}));
```

不併入 `/api/admin/settings`（那份 payload 是扁平設定值；本案要帶目錄結構）。

### 5. 後台 UI（`public/admin.html`、`public/admin.js`）

`#apanel-line` 內、既有「LINE 綁定管理」section **之前**新增一個 section：

```html
<section class="pb-10">
  <div class="a-sec-head">
    <h2 class="section-title">LINE 通知開關</h2>
    <span class="a-sec-line"></span>
    <div class="a-sec-tools">
      <button id="ln-all-on" class="btn btn-ghost btn-sm" type="button">全部開啟</button>
      <button id="ln-all-off" class="btn btn-ghost btn-sm" type="button">全部關閉</button>
      <button id="ln-master" class="ln-switch" type="button" aria-pressed="false" aria-label="LINE 通知總開關">OFF</button>
    </div>
  </div>
  <p id="ln-note" class="subtle text-sm mb-3"></p>
  <div class="card p-0 overflow-hidden"><div id="ln-items"></div></div>
</section>
```

- **開關元件 `.ln-switch`**（CSS 放 admin.html inline，與其他後台 CSS 同處；方角、One-Sky）：`border:1px solid var(--line)`、白底、`color:var(--ink-mute)`、Archivo 12px 字重 800、`letter-spacing:.08em`、`padding:3px 10px`、`min-width:52px`、`border-radius:0`；`.ln-switch.on`：`background:var(--brand)`、`border-color:var(--brand)`、白字；文字 `ON`／`OFF` 隨狀態切換，`aria-pressed` 同步。`--brand`／`--line`／`--ink-mute` 為 admin.html 既有 token（實作時以檔內實際名稱為準）。
- **清單**：`#ln-items` 依 `groups` 渲染，每組一個標題列（`.ln-group-head`：組 label，12px 大寫字距同 `.pr-detail-block h4` 風格）＋每項一列 `.ln-row`（flex，左：項目 label 粗體＋下方 `recipients` 小字 `subtle text-sm`；右：`.ln-switch`，`data-ln-item="<key>"`）；列間髮絲線。
- **總開關 OFF 時**：`#ln-items` 加 `opacity:.55`，`#ln-note` 顯示「總開關關閉中：所有 LINE 推播暫停，以下項目設定會在開啟後生效。」；ON 時顯示「關閉的項目不推 LINE，但仍會留在通知紀錄。」。清單在 OFF 時**仍可點**（先配置好再開）。
- **行為**：`loadLineNotify()`（`GET /api/admin/line-notify` → `renderLineNotify(state)`）在 admin.js 啟動載入鏈與 `loadUsers()` 同處呼叫一次；每次點擊（總開關／單項／全部開啟／全部關閉）先樂觀更新畫面，再 `PATCH`，失敗 `toast(…, 'error')` 並以伺服器回傳或重新 GET 還原。「全部開啟／全部關閉」送 `items` 全部 16 個 key（不動 master）。全部關閉前 `confirm('確定關閉全部 16 個項目？')`。
- 不改既有「LINE 綁定管理」section、`renderLineTable`、`doLineUnbind`。

### 6. 通知紀錄

不改。關閉時的列與未綁定者一致（通道 console）。

### 7. 本月推播額度進度條

**資料來源（LINE 官方文件已確認，`docs/en/reference/messaging-api` 2026-09 版）**

| 端點 | 回應 | 備註 |
|---|---|---|
| `GET https://api.line.me/v2/bot/message/quota` | `{ "type": "limited", "value": 200 }` 或 `{ "type": "none" }` | 本月可發總數（免費＋加購）；`none`＝未設上限 |
| `GET https://api.line.me/v2/bot/message/quota/consumption` | `{ "totalUsage": 123 }` | 本月已發；**近似值**；含 LINE Official Account Manager 手動群發 |

兩支都用 `Authorization: Bearer {channel access token}`、速率限制 2,000 次/秒、不消耗推播額度。月度統計 LINE 一律以 **UTC+9（日本時間）** 計（文件中所有日期參數皆註明 Timezone: UTC+9），免費額度**每月 1 日 00:00（UTC+9）重置**＝台灣時間**當月最後一天 23:00**。

**`src/services/lineClient.js`** 加兩個 mock-aware 的 GET 包裝（沿用 `_post` 的 mock／未設定／錯誤處理邏輯，抽一個 `_get(url)`）：

- `getQuota()` → `{ ok: true, data: { type, value } }`；`LINE_MOCK='1'` 回 `{ ok: true, data: { type: 'limited', value: 200 } }`；`LINE_MOCK='fail'` 回 `{ ok: false, error: 'mock_fail' }`；沒 token 回 `{ ok: false, error: 'line_not_configured' }`；非 2xx 回 `{ ok: false, error: 'HTTP <status>: <body 前 200 字>' }`；網路例外回 `{ ok: false, error: 'network: …' }`。
- `getQuotaConsumption()` → `{ ok: true, data: { totalUsage } }`；mock `'1'` 回 `{ totalUsage: 0 }`；其餘同上。

**新檔 `src/services/lineQuota.js`**

- 純函式 `nextQuotaResetLocal(nowLocalStr)`：輸入台灣本地 `YYYY-MM-DDTHH:MM:SS`，回傳下一次重置的台灣本地時間字串＝「當月最後一天 23:00:00」；若 `now >= 當月最後一天 23:00:00`，回「下個月最後一天 23:00:00」（跨年自然處理；閏年用 `Date.UTC(y, m+1, 0)` 取月末）。
- `async getLineQuotaStatus()` → 
  ```js
  {
    configured: boolean,      // false = 沒 token 且非 mock（其餘欄位皆 null）
    limitType: 'limited' | 'none' | null,
    limit: number | null,     // type=none 時 null
    used: number | null,
    remaining: number | null, // max(limit - used, 0)；type=none 時 null
    pct: number | null,       // remaining / limit * 100，四捨五入到整數；type=none 時 null
    resetAt: string,          // nextQuotaResetLocal(nowLocal())
    fetchedAt: string,        // nowLocal()
    error: string | null,     // 任一端點失敗時放該 error；configured 仍 true
  }
  ```
  兩支端點 `Promise.all` 並行；任一失敗 → `error` 帶原因、數字欄位 null、`resetAt`／`fetchedAt` 照給。`line_not_configured` → `configured: false`、`error: null`。不做伺服器端快取（速率限制寬裕、後台才會呼叫）。

**API（`src/server.js`，緊接 line-notify 之後）**

```js
app.get('/api/admin/line-quota', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await getLineQuotaStatus());
}));
```

**後台 UI（`#apanel-line` 最上方、通知開關 section 之前）**

```html
<section class="pb-10">
  <div class="a-sec-head">
    <h2 class="section-title">本月推播額度</h2>
    <span class="a-sec-line"></span>
    <div class="a-sec-tools">
      <span id="lq-fetched" class="subtle text-sm"></span>
      <button id="lq-refresh" class="btn btn-ghost btn-sm" type="button">重新整理</button>
    </div>
  </div>
  <div class="card"><div id="lq-body"></div></div>
</section>
```

`renderLineQuota(q)` 依狀態渲染 `#lq-body`：

- **`configured === false`**：空狀態文字「LINE 尚未設定（缺 channel access token）」。
- **`error`**：紅字「無法取得額度：<error>」＋ `fetchedAt`。
- **`limitType === 'none'`**：「本月無上限（未設定目標則數）」＋「已發 約 <used> 則」；不畫條。
- **`limited`（主畫面，遊戲血條風格）**：
  - 左側大數字：`.lq-num`（Archivo、tabular、36px、字重 800）顯示 `remaining`，後接 `.lq-den` 小字 `/ <limit>`，上方 12px 大寫字距標籤「剩餘」。
  - 血條 `.lq-bar`：**20 格**方角 segments（flex，每格 `flex:1`、高 14px、格距 2px、`border-radius:0`），亮起格數＝`Math.round(pct / 5)`（`pct` 0 且 `remaining` 0 → 0 格；`remaining` > 0 但 `pct` < 3 → 至少亮 1 格）；亮格底色依 `pct`：≥ 50 用 `--brand`（天藍）、20–49 用 admin.html 既有 warning token、< 20 用既有 danger token；未亮格用 `--line` 髮絲線框、透明底。`role="progressbar"`、`aria-valuenow=remaining`、`aria-valuemax=limit`、`aria-label="本月剩餘推播額度"`。
  - 條下一行 `subtle text-sm`：「已發 約 <used> 則 · LINE 統計為近似值」。
  - 重置行 `.lq-reset`：「重置：<M/D>（週X）23:00 · 還有 <N> 天 <H> 小時」（`resetAt` 用既有 `fmtDate` 風格格式化；倒數＝`resetAt − 現在`，向下取整到小時；< 1 小時顯示「不到 1 小時」）；後接 12px 註解「LINE 以日本時間每月 1 日 00:00 重置」。
  - `remaining === 0`：血條全暗＋ `.lq-num` 改用 danger 色＋旁邊 `<span class="badge badge-cancelled">額度用完</span>`。
- `#lq-fetched` 顯示「更新於 HH:MM」。「重新整理」按鈕：`disabled` 期間文字改「更新中…」，完成後還原。
- `loadLineQuota()` 於啟動載入鏈與 `loadLineNotify()` 同處呼叫；倒數文字每 60 秒用 `setInterval` 重算（不重打 API）。
- CSS（`.lq-num`／`.lq-den`／`.lq-bar`／`.lq-seg`／`.lq-seg.on`／`.lq-reset`）放 admin.html inline。

## 邊角（明訂）

- 項目 ON、總開關 OFF → 不推。
- 總開關 ON、type 不在目錄（legacy／已停用模板）→ 推（只受總開關管）。
- 關閉期間到期的 LINE 失敗列 → `failed_permanent`／`line_notify_off`，開回來不補送；關閉期間新產生的通知寫成 console 列，也不補送。
- `notify()` 每次多 1～2 個 prepared SELECT（同步 SQLite），無需快取。
- 目前 prod 已 `failed_permanent` 的 429 列不受影響（本來就不重試）。
- 全新 DB（測試、fresh install）總開關預設 OFF：走 LINE 推播路徑的測試須自行把總開關設 ON。
- 額度數字是 LINE 回的近似值，UI 標「約」；重置時間是依 LINE 文件推算（UTC+9 月初），不是 API 回傳的值。
- 額度查詢失敗（401／網路）不影響通知開關與其他區塊；只在額度卡顯示錯誤。

## 測試

- 新檔 `tests/line-notify-policy.test.js`（fresh DB、`LINE_MOCK='1'`；開頭 `DELETE FROM app_settings WHERE key LIKE 'line_notify_%'`；加入 `package.json` 測試鏈）：
  - 預設：`getLineNotifyState().master === false`、每個 item `enabled === true`、`isLineNotifyEnabled('booking_created') === false`。
  - 目錄完整性：16 個 item key 唯一、每個 type 只出現一次、以下 31 個 type 全部對應到項目：`booking_created, booking_confirmed, booking_recurring_created, booking_recurring_created_coach, booking_payment_received, booking_rescheduled, booking_rescheduled_coach, booking_cancelled_by_coach, booking_cancelled_by_shop, booking_refunded, booking_cancelled_by_member, booking_cancelled_by_shop_coach, payment_received, course_registered_coach, course_registered_coach_batch, course_registered_admin, course_registered_admin_batch, group_promoted, course_waitlisted_coach, course_promoted_coach, course_member_cancelled_coach, course_member_leave_coach, course_confirmed_coach, course_cancelled_coach, course_cancelled, group_order_refunded, package_low_sessions, group_last_session, gcal_move_rejected, gcal_delete_cancelled, period_rollover_admin`。
  - `setLineNotifyState({ master: true })` → `isLineNotifyEnabled('booking_created') === true`；`setLineNotifyState({ items: { booking_new: false } })` → `booking_created` false、`booking_confirmed` true；`registered_confirmed`（legacy）在 master ON 時 true、master OFF 時 false。
  - 驗證：`{ items: { nope: true } }` 丟 `ApiError` status 400 `invalid_line_notify_item`；`{ master: 'yes' }` → 400 `invalid_line_notify_master`；`{ items: { booking_new: 1 } }` → 400 `invalid_line_notify_value`；失敗時不寫入任何 key。
  - `notify()` 走向（會員有 `line_user_id`）：master OFF → 該列 `channel='console'`；master ON＋`booking_confirmed_member` OFF → console；ON／ON → `channel='line'`（deliverLine 為 async，await `setImmediate` 後查）。
  - 重試器：插入 `channel='line'`、`status='failed'`、`next_retry_at` 已過、type `booking_created` 的列；master OFF 跑 `processFailedNotifications()` → `failed_permanent`、`last_error='line_notify_off'`；master ON 再插一列跑 → `sent`。
- 新檔 `tests/line-notify-api.test.js`（`test:api` 鏈慣例：`BASE`、`X-Forwarded-For` 獨立假 IP、demo admin 登入；跑完還原 master／items）：GET 200 且 `groups` 三組共 16 項、每項含 `key/label/recipients/enabled`；PATCH `{ master: true }` 回 `master === true`；PATCH `{ items: { booking_new: false } }` 回該項 `enabled === false` 其餘不變；PATCH 未知 key → 400；未登入 → 401；教練（非管理者）→ 403（比照既有 admin API 測試取教練 token 的方式）。
- 既有 `tests/notifications-flow.test.js`：`reset()` 之後、第一個 `notify()` 之前呼叫 `setLineNotifyState({ master: true })`（因預設改 OFF，否則 LINE 路徑斷言全倒）。
- 新檔 `tests/line-quota.test.js`（不碰 DB 的純函式＋mock client；加入測試鏈）：
  - `nextQuotaResetLocal`：`'2026-09-08T14:00:00'` → `'2026-09-30T23:00:00'`；`'2026-09-30T22:59:59'` → `'2026-09-30T23:00:00'`；`'2026-09-30T23:00:00'` → `'2026-10-31T23:00:00'`；`'2026-12-31T23:00:00'` → `'2027-01-31T23:00:00'`；`'2028-02-10T00:00:00'` → `'2028-02-29T23:00:00'`。
  - `LINE_MOCK='1'`：`getQuota()` 回 `{ ok: true, data: { type: 'limited', value: 200 } }`、`getQuotaConsumption()` 回 `{ ok: true, data: { totalUsage: 0 } }`；`getLineQuotaStatus()` → `configured true`、`limit 200`、`used 0`、`remaining 200`、`pct 100`、`error null`、`resetAt` 符合 `/^\d{4}-\d{2}-\d{2}T23:00:00$/`。
  - `LINE_MOCK='fail'`：`getLineQuotaStatus()` → `configured true`、`error 'mock_fail'`、數字欄位全 null。
  - 清掉 `LINE_MOCK` 與 `LINE_CHANNEL_ACCESS_TOKEN`：→ `configured false`、`error null`。
- `tests/line-notify-api.test.js` 併測：`GET /api/admin/line-quota` 有 token → 200 且 `typeof data.configured === 'boolean'`、`typeof data.resetAt === 'string'`；無 token → 401。
- 完整 unit 鏈 `DB_PATH="$(mktemp -d)/t.db" npm test` 全綠；API 鏈跑完 `npm run seed`。

## 範圍外（YAGNI）

- 逐模板開關、依收件人角色開關（業主選了事件顆粒度）。
- 額度用完自動偵測／email 備援／後台警示（另案，見 `chinup_line_quota_429`）。
- 通知紀錄頁標示「因開關關閉未推」（與未綁定者同顯示 console 即可）。
- 每組「全部開啟／關閉」快捷鈕（區塊層級一組已足夠）。
- 額度低於門檻自動關總開關／自動通知管理者（另案，與 email 備援一起）。
- 額度歷史曲線、逐日用量（LINE 另有 delivery 端點，本案只要「現在剩多少」）。
- 額度伺服器端快取（後台才呼叫、速率限制 2,000/秒）。
