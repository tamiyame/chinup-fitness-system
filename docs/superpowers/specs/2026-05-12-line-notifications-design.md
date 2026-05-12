# Phase 3C · LINE Notification Integration Design

**Date:** 2026-05-12
**Branch:** `feature/line-notifications`
**Phase:** 3C of 3 (final phase of Phase 3 rollout — 3A unified my-schedule ✓, 3B group mobile UI ✓, 3C LINE notifications)
**Status:** Draft for review

---

## 1. Goal

替換 `notifications.js` stub 成真實 LINE Messaging API 整合。會員透過「加 LINE 官方帳號好友 + 傳送 6 位連帳代碼」方式 opt-in；綁定後所有現有 7 種課程通知 + 4 種新增一對一預約通知都會直接 push 到他們的 LINE。失敗的訊息自動以指數退避（5/15/45 分鐘）重試 3 次，仍失敗則標記為 `failed_permanent`。

## 2. In Scope

- LINE Messaging API 整合（用原生 `fetch`，不引入 `@line/bot-sdk`，維持 chinup zero-dep 原則）
- 新檔 `src/services/lineClient.js`：`sendMessage()` + `verifySignature()` 低階 wrapper
- 新檔 `src/services/lineBindingService.js`：`generateBindCode()` + `consumeCode()`（state machine 含 4 個 outcome）
- 重寫 `src/services/notifications.js`：保留 `notify()` 同 signature（去掉沒人用的 `channelOverride`），新增 `processFailedNotifications()` cron worker
- Schema 新增 6 欄：`users.line_user_id` (UNIQUE partial) / `users.line_bind_code` / `users.line_bind_expires_at` / `notifications.retry_count` / `notifications.next_retry_at` / `notifications.last_error`；status enum 擴成 `'sent' | 'failed' | 'failed_permanent'`
- 4 個新 HTTP endpoint：`POST /api/line/webhook`、`GET /api/my/line/binding`、`POST /api/my/line/regenerate`、`DELETE /api/my/line`
- 新前端頁 `/line.html` + `/line.js`：綁定狀態 + QR + 6 碼 + 解除綁定 UI
- 4 個新通知 template：`booking_created` / `booking_confirmed` / `booking_cancelled_by_member` / `booking_cancelled_by_coach`
- `bookingService.js` 在 createBooking / cancelBooking 內新增 4 個 notify() 呼叫點（補 Phase 1 沒寫通知的 gap）
- 擴充 `src/scheduler.js`：每 5 分鐘跑一次 retry cron
- Migration helper `addColumnIfMissing()` 在 `src/db/connection.js`，讓 ALTER TABLE 行為 idempotent
- 環境變數：`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LINE_OFFICIAL_ACCOUNT_ID` / `LINE_MOCK`（test 用）
- `package.json` 的 `start` script 加 `--env-file-if-exists=.env`
- Navbar 5 個頁面新增「🔔 LINE 通知」入口（mobile dropdown 同步）
- README 補 LINE Developers 一次性設定章節
- 兩個新 test 檔：`tests/notifications-flow.test.js`（service flow）+ `tests/line-webhook-api.test.js`（HTTP 整合）

## 3. Out of Scope

- Web Push（Safari iOS 不穩，未來 3D 再考慮）
- Real SMTP / SMS provider（已決定走 LINE-only）
- 既有 `users.notification_preference` 欄位：保留但新程式忽略，**不做 DROP COLUMN**
- 通知靜音 / 開關（解除綁定即同等效果）
- LINE Login OAuth（已選 binding-code 流程）
- LINE Flex Message（純文字夠用、3D 再升級）
- 自動偵測綁定完成（無 SSE / polling，user 手動 reload `/line.html`）
- 自動解除 user 封鎖 bot 的 LINE 帳號（403 一律走 retry path，YAGNI）
- Failed notification 的 admin UI（先用 `sqlite3` CLI 查 `notifications` table 即可）
- CHECK constraints on `notifications.status`（避免 rebuild、靠 service 層 guard）
- 前端自動化測試框架
- 修補 Phase 1+2 既有 8 個 `tests/api.test.js` 預存 failure

## 4. Architecture

純後端 + 一個新前端頁。所有業務邏輯 caller（`registration.js` / `courseService.js` / `bookingService.js`）統一呼叫 `notify({ userId, type, vars })`，由 `notifications.js` 判斷 channel 並 dispatch。LINE API 細節封裝在 `lineClient.js`，binding flow state machine 封裝在 `lineBindingService.js`。

```
業務 layer
├── registration.js (3 既有呼叫點)
├── courseService.js (3 既有呼叫點)
└── bookingService.js (4 新呼叫點)
        │
        ▼
notifications.js
  ├── notify({ userId, type, vars })  ← 統一入口
  ├── deliverLine() / deliverConsole()
  └── processFailedNotifications()    ← cron worker
        │
        ▼
lineClient.js
  ├── sendMessage(lineUserId, text)
  └── verifySignature(rawBody, sig)

HTTP layer (server.js)
├── POST /api/line/webhook            ← LINE 平台呼叫，binding 入口
├── GET  /api/my/line/binding
├── POST /api/my/line/regenerate
└── DELETE /api/my/line

scheduler.js
└── cron every 5min: processFailedNotifications()
```

## 5. Schema Changes

### 5.1 `users` 新增 3 欄

```sql
-- Canonical (in schema.js SCHEMA, for fresh DBs):
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT,
  google_id TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  notification_preference TEXT NOT NULL DEFAULT 'email',  -- DEPRECATED Phase 3C
  line_user_id TEXT,                                       -- Phase 3C
  line_bind_code TEXT,                                     -- Phase 3C
  line_bind_expires_at TEXT,                               -- Phase 3C
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id
  ON users(line_user_id) WHERE line_user_id IS NOT NULL;
```

### 5.2 `notifications` 新增 3 欄

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES course_sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'sent',  -- Phase 3C extended: 'sent' | 'failed' | 'failed_permanent'
  retry_count INTEGER NOT NULL DEFAULT 0,  -- Phase 3C
  next_retry_at TEXT,                       -- Phase 3C
  last_error TEXT,                          -- Phase 3C
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_retry
  ON notifications(status, next_retry_at) WHERE status = 'failed';
```

### 5.3 Migration 策略

`src/db/connection.js` 新增 helper：

```javascript
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
```

Boot 順序：
1. `db.exec(SCHEMA)` — fresh DB 直接拿到完整結構；existing DB 因為 `IF NOT EXISTS` 不影響
2. 跑 6 個 `addColumnIfMissing` 呼叫（existing DB 才實際 ALTER）
3. 跑 2 個 `CREATE INDEX IF NOT EXISTS`

兩種 DB 同 boot path 收斂到同一個 schema，無 destructive 操作。

## 6. Binding Flow

### 6.1 代碼產生

```javascript
export function generateBindCode(userId) {
  return tx(() => {
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = String(Math.floor(100000 + Math.random() * 900000));
      const dup = db.prepare('SELECT id FROM users WHERE line_bind_code = ?').get(code);
      if (!dup) break;
    }
    const expiresAt = addMinutesLocal(nowLocal(), 15);  // 15 分鐘有效
    db.prepare(
      'UPDATE users SET line_bind_code = ?, line_bind_expires_at = ? WHERE id = ?'
    ).run(code, expiresAt, userId);
    return { code, expires_at: expiresAt };
  });
}
```

碰撞極低（1M space × 同時只有少量 active code），但仍保留 10 次 retry 防禦。

### 6.2 `consumeCode(code, lineUserId)` 四個 outcome

```javascript
export function consumeCode(code, lineUserId) {
  return tx(() => {
    const user = db.prepare(
      'SELECT id, line_user_id, line_bind_expires_at FROM users WHERE line_bind_code = ?'
    ).get(code);
    if (!user) return { outcome: 'invalid_code' };
    if (!user.line_bind_expires_at || user.line_bind_expires_at < nowLocal()) {
      return { outcome: 'invalid_code' };
    }
    if (user.line_user_id) return { outcome: 'chinup_already_bound' };

    const occupier = db.prepare('SELECT id FROM users WHERE line_user_id = ?').get(lineUserId);
    if (occupier) return { outcome: 'this_line_already_bound' };

    db.prepare(`
      UPDATE users
      SET line_user_id = ?, line_bind_code = NULL, line_bind_expires_at = NULL
      WHERE id = ?
    `).run(lineUserId, user.id);

    return { outcome: 'bound', userId: user.id };
  });
}
```

### 6.3 Webhook handler

`POST /api/line/webhook`（**無 requireUser**，靠 HMAC 驗 LINE 平台簽章）：

```javascript
app.post('/api/line/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.header('X-Line-Signature'))) {
    return res.status(401).end();
  }
  const events = req.body.events || [];
  for (const event of events) {
    try {
      if (event.type === 'message' && event.message?.type === 'text') {
        handleTextMessage(event);  // async fire-and-forget
      } else if (event.type === 'follow') {
        replyWithInstructions(event.replyToken);
      } else if (event.type === 'unfollow') {
        unbindByLineUserId(event.source.userId);
      }
    } catch (e) {
      console.error('[line-webhook]', e);
    }
  }
  res.status(200).end();  // 必須 200 否則 LINE 重發
});
```

**raw body 取得：** `src/server.js` 既有 `app.use(express.json({ limit: '3mb' }))`（line 57）改成帶 `verify` callback：

```javascript
app.use(express.json({
  limit: '3mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
```

### 6.4 `handleTextMessage(event)`

```javascript
function handleTextMessage(event) {
  const text = event.message.text.trim();
  const lineUserId = event.source.userId;
  const replyToken = event.replyToken;

  if (!/^\d{6}$/.test(text)) {
    return reply(replyToken,
      '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。');
  }
  const result = consumeCode(text, lineUserId);
  switch (result.outcome) {
    case 'bound':
      return reply(replyToken, '✅ 綁定成功！日後課程通知會送到這裡。');
    case 'invalid_code':
      return reply(replyToken, '❌ 代碼無效或已過期，請回網站重新產生。');
    case 'this_line_already_bound':
      return reply(replyToken, '此 LINE 帳號已綁定其他 chinup 帳號，請先解除。');
    case 'chinup_already_bound':
      return reply(replyToken, '此 chinup 帳號已綁定其他 LINE，請先解除。');
  }
}
```

### 6.5 Reply API（不吃 push 配額）

```javascript
async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}
```

綁定相關訊息全用 reply（一次性 token、不消耗 1000/月配額）；課程通知才用 push API。

## 7. Notification Delivery

### 7.1 `notify()` 新介面

```javascript
export function notify({ userId, sessionId, type, vars = {} }) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`unknown notification type: ${type}`);
  const subject = render(tpl.subject, vars);
  const body    = render(tpl.body, vars);
  const user = getUser.get(userId);
  if (!user) return;  // 已刪除 user：silent skip

  if (user.line_user_id) {
    deliverLine({ userId, sessionId, type, subject, body, lineUserId: user.line_user_id });
  } else {
    deliverConsole({ userId, sessionId, type, subject, body });
  }
}
```

拿掉 `channelOverride` 參數（沒人用）；移除 `pref === 'both'` 雙 channel 邏輯。

### 7.2 `deliverLine()`

```javascript
async function deliverLine({ userId, sessionId, type, subject, body, lineUserId }) {
  const result = await lineClient.sendMessage(lineUserId, body);
  if (result.ok) {
    insertNotif.run({
      user_id: userId, session_id: sessionId, type,
      channel: 'line', subject, body,
      status: 'sent',
      retry_count: 0,
      next_retry_at: null,
      last_error: null,
    });
  } else {
    insertNotif.run({
      user_id: userId, session_id: sessionId, type,
      channel: 'line', subject, body,
      status: 'failed',
      retry_count: 0,
      next_retry_at: addMinutesLocal(nowLocal(), 5),
      last_error: result.error,
    });
  }
}
```

LINE 只送 `body`（不送 subject；subject 保留在 DB 用 admin debug）。

### 7.3 `lineClient.sendMessage()`

```javascript
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';

export async function sendMessage(lineUserId, text) {
  if (process.env.LINE_MOCK === '1')    return { ok: true };
  if (process.env.LINE_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, error: 'line_not_configured' };
  }
  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: 'text', text }],
      }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}
```

**絕不 throw**——失敗用 return value 回，由 `deliverLine` 寫 failed row。

### 7.4 `verifySignature()`

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody, signatureHeader) {
  if (process.env.LINE_MOCK === '1') return true;  // 測試 bypass
  if (!signatureHeader || !process.env.LINE_CHANNEL_SECRET) return false;
  const expected = createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### 7.5 Retry Worker

```javascript
const BACKOFF_MINUTES = [5, 15, 45];  // retry 1, 2, 3 等待時間
const MAX_RETRIES = 3;

export async function processFailedNotifications() {
  const due = db.prepare(`
    SELECT id, user_id, session_id, type, body, retry_count
    FROM notifications
    WHERE status = 'failed' AND next_retry_at <= ?
    ORDER BY next_retry_at ASC
    LIMIT 100
  `).all(nowLocal());

  for (const row of due) {
    const user = getUser.get(row.user_id);
    if (!user?.line_user_id) {
      db.prepare(`UPDATE notifications SET status='failed_permanent', next_retry_at=NULL WHERE id=?`)
        .run(row.id);
      continue;
    }
    const result = await lineClient.sendMessage(user.line_user_id, row.body);
    if (result.ok) {
      db.prepare(`UPDATE notifications SET status='sent', next_retry_at=NULL, last_error=NULL WHERE id=?`)
        .run(row.id);
    } else {
      const newRetryCount = row.retry_count + 1;
      if (newRetryCount > MAX_RETRIES) {
        db.prepare(`UPDATE notifications SET status='failed_permanent', next_retry_at=NULL, last_error=? WHERE id=?`)
          .run(result.error, row.id);
      } else {
        const nextAt = addMinutesLocal(nowLocal(), BACKOFF_MINUTES[newRetryCount - 1]);
        db.prepare(`UPDATE notifications SET retry_count=?, next_retry_at=?, last_error=? WHERE id=?`)
          .run(newRetryCount, nextAt, result.error, row.id);
      }
    }
  }
}
```

### 7.6 Scheduler 整合

```javascript
// src/scheduler.js (既有 cron jobs 不動，新增一行)
import { processFailedNotifications } from './services/notifications.js';

cron.schedule('*/5 * * * *', async () => {
  try { await processFailedNotifications(); }
  catch (e) { console.error('[cron] processFailedNotifications failed:', e); }
});
```

獨立 try/catch、不拖累其他 cron。

## 8. New Templates (4 for 1-on-1 bookings)

```javascript
booking_created: {  // 寄給教練
  subject: '新一對一預約 - {{member_name}}',
  body: '🏋️ {{member_name}} 預約了 {{start_at}} 的一對一課程。',
},
booking_confirmed: {  // 寄給會員
  subject: '一對一預約成功 - {{coach_display_name}}',
  body: '✅ 已成功預約 {{coach_display_name}} 教練的 {{start_at}} 課程。',
},
booking_cancelled_by_member: {  // 寄給教練
  subject: '會員取消預約 - {{member_name}}',
  body: '⚠️ {{member_name}} 取消了 {{start_at}} 的一對一預約。',
},
booking_cancelled_by_coach: {  // 寄給會員
  subject: '教練取消預約 - {{coach_display_name}}',
  body: '⚠️ {{coach_display_name}} 教練取消了你 {{start_at}} 的預約，點數已退回。',
},
```

`fmtDateForLine(s)` helper：`2026-05-20T14:00:00` → `5/20（週三）14:00`。

### 8.1 `bookingService` 呼叫點

`createBooking()` 成功後：
```javascript
notify({
  userId: coach.user_id,
  sessionId: null,
  type: 'booking_created',
  vars: { member_name: member.name, start_at: fmtDateForLine(start_at) },
});
notify({
  userId: memberId,
  sessionId: null,
  type: 'booking_confirmed',
  vars: { coach_display_name: coach.display_name, start_at: fmtDateForLine(start_at) },
});
```

`cancelBooking()` 成功後，依 `cancelled_by` 判斷：
```javascript
const isCoachCancel = booking.cancelled_by === coach.user_id;
if (isCoachCancel) {
  notify({ userId: booking.member_id, type: 'booking_cancelled_by_coach', vars: {...} });
} else {
  notify({ userId: coach.user_id, type: 'booking_cancelled_by_member', vars: {...} });
}
```

`sessionId` 對 booking 通知為 `null`（1-on-1 沒有 session 概念）。

## 9. Binding UI (`/line.html` + `/line.js`)

### 9.1 未綁定狀態

- Hero: 🔔 LINE 通知 / 「綁定後課程通知會直接送到你的 LINE」
- Step 1: 顯示 QR `<img src="/line-qr.png">` + 文字連結 `https://line.me/R/ti/p/${LINE_OFFICIAL_ACCOUNT_ID}`
- Step 2: 大字 6 位代碼 + 「複製代碼」按鈕 + 「重新產生」按鈕 + 「有效時間：14:35 前」
- Step 3: 提示「Bot 回綁定成功後重新整理本頁」（不自動 poll）

### 9.2 已綁定狀態

- ✓ 已綁定 LINE
- 「解除綁定」按鈕

### 9.3 QR 圖片

Admin 在 LINE Developers Console 下載 QR PNG → 放到 `public/line-qr.png`（`.gitignore`'d）。README 指引。

若檔案不存在：UI 顯示「請聯絡管理員設定 QR」訊息。

### 9.4 Navbar 整合

5 個既有 navbar 頁面（index / admin / coach / coaches / my-schedule）+ 新增的 line.html，共 6 個頁面的 navbar 都加入：

```html
<a href="/line.html" class="nav-link">🔔 LINE 通知</a>
```

桌面 + mobile dropdown 都加。位置：在「我的課表」跟「管理後台」之間。

## 10. HTTP Endpoints

### 10.1 `GET /api/my/line/binding`

**Auth:** `requireUser`
**Response 200:**
```jsonc
// 未綁：
{
  "bound": false,
  "code": "873214",
  "expires_at": "2026-05-12T14:35:00",
  "official_account_id": "@chinup"
}
// 已綁：
{
  "bound": true,
  "official_account_id": "@chinup"
}
```
未綁且無 code（或已過期）會自動產一組。

### 10.2 `POST /api/my/line/regenerate`

**Auth:** `requireUser`
**Response 200:** `{ code, expires_at }`
強制覆蓋產新碼。

### 10.3 `DELETE /api/my/line`

**Auth:** `requireUser`
**Response 200:** `{ ok: true }`
`UPDATE users SET line_user_id=NULL, line_bind_code=NULL, line_bind_expires_at=NULL WHERE id=?`。

### 10.4 `POST /api/line/webhook`

**Auth:** 無（HMAC 驗）
**Response 200/401:**
- HMAC 失敗 → 401
- 合法 → 200（即使內部 event 處理失敗也回 200，防 LINE 平台無限重發）

## 11. Environment Variables

| Var | Required | Purpose |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | prod | Push API 認證 |
| `LINE_CHANNEL_SECRET` | prod | Webhook 簽章驗證 |
| `LINE_OFFICIAL_ACCOUNT_ID` | prod | 顯示在綁定頁的 friend URL |
| `LINE_MOCK` | test/dev | `'1'`=always succeed, `'fail'`=always fail |

讀取方式：直接 `process.env`，無 dotenv 套件。`package.json` 的 `start` script 加 `--env-file-if-exists=.env`。

Missing env 時行為：
- Token/Secret 缺 → `lineClient` return failed → 走 retry path（不在啟動時 crash）
- OfficialAccountID 缺 → UI 顯示「請聯絡管理員」訊息

## 12. Tests

### 12.1 `tests/notifications-flow.test.js`（新檔，flow 風格）

設 `LINE_MOCK=1` 在 setup。涵蓋：

- Template render（含新 4 個 booking template）
- `generateBindCode()`：產 6 位、寫入 user、15 分鐘 expiry
- `consumeCode()` 四個 outcome：`bound` / `invalid_code` / `chinup_already_bound` / `this_line_already_bound`
- `notify()` mock 模式寫 `status='sent'`
- `LINE_MOCK=fail` 寫 `status='failed'` + `retry_count=0` + `next_retry_at = now+5min`
- `processFailedNotifications`：退避策略 5→15→45→permanent
- `processFailedNotifications`：user 已解除綁定 → `failed_permanent`
- Booking 流程觸發 4 個新通知正確 inserted

### 12.2 `tests/line-webhook-api.test.js`（新檔，HTTP 整合）

- 無 signature → 401（解 `LINE_MOCK` 跑此 case）
- 合法 events → 200
- message event 含正確代碼 → DB `users.line_user_id` 更新
- message event 含錯誤代碼 → DB 未綁、無異常
- unfollow event → 自動解除綁定
- `GET /api/my/line/binding` 未綁 → 回 code + expires_at
- `GET /api/my/line/binding` 已綁 → 回 `bound: true`
- `POST /api/my/line/regenerate` → 拿新 code、舊 code 失效
- `DELETE /api/my/line` → `line_user_id` 清空

### 12.3 既有 `tests/booking-flow.test.js`（修改）

Setup 加 `process.env.LINE_MOCK = '1'`，補 1-2 個斷言確認 booking 通知 row 寫入。

### 12.4 既有測試應全綠

`my-schedule-api`、`my-schedule-routing`、`booking-api`、`my-schedule-service` 不受影響。

`tests/api.test.js` 8 個 pre-existing failure 不在本 phase 範圍。

## 13. Error Handling

| 情境 | 行為 |
|---|---|
| user 未綁 LINE | `deliverConsole` 寫 `channel='console', status='sent'` + console.log；不發 LINE 也不報錯 |
| LINE API 4xx/5xx | 寫 `status='failed', retry_count=0, next_retry_at=+5min`；cron 自動 retry |
| LINE API timeout / 網路錯 | 同上 |
| token / secret env 未設 | `lineClient` return `{ ok: false, error: 'line_not_configured' }`；走 retry path；admin 設好後 cron 自動續送 |
| Retry 3 次仍失敗 | `status='failed_permanent', next_retry_at=NULL`；不再 retry |
| Webhook signature 不合 | 401，不解析 body |
| Webhook event 解析失敗 | `console.error` log，但 HTTP 回 200（防 LINE 重發） |
| user 封鎖 bot（push API 回 403）| 走 retry path，3 次後 `failed_permanent`（3D 可加自動解綁邏輯） |
| Reply token 過期 | LINE API 回 400，記錄不重要、不影響 user 體驗 |

## 14. Migration / Rollback

- **Schema:** 純加欄位 + index，backward-compatible，無 destructive 操作
- **DB data:** 既有 row `notifications.status='sent'` / `users.notification_preference='email'` 全保留，新 query 不依賴舊欄位
- **Rollback:** revert PR commit 即可；新欄位仍在 DB 但無 reader（無害）
- **Deploy on Railway:**
  1. `git push` → Railway auto-deploy
  2. boot 時 `addColumnIfMissing` 自動加欄位
  3. 設環境變數 + 上傳 `line-qr.png`
  4. 在 LINE Console 設 webhook URL
  5. 用 admin 帳號到 `/line.html` 自測綁定成功才 broadcast 給會員

## 15. README Additions

新增章節 `## Phase 3C: LINE 通知設定`，內容含：

1. 註冊 LINE Developers + Create Provider + Create Messaging API Channel（一次性）
2. 取得三個值：Channel Access Token、Channel Secret、Basic ID
3. 設 webhook URL：`https://<domain>/api/line/webhook`
4. 開「Use webhook」、關「Auto-reply messages」、關「Greeting messages」
5. 下載 QR PNG → `public/line-qr.png`（gitignore'd）
6. 設環境變數（本地 `.env` / Railway dashboard）
7. Smoke test 步驟：用 admin 帳號自綁定
8. `LINE_MOCK=1` dev 模式說明

## 16. Open Questions

無 — 所有決策已於 brainstorm 過程確認。

## 17. References

- 既有 stub：`src/services/notifications.js`
- 既有呼叫點：`src/services/registration.js`、`src/services/courseService.js`（無 `src/services/bookingService.js` 呼叫——是 Phase 1 留下的 gap）
- 既有 scheduler：`src/scheduler.js`（用 `node-cron`）
- 既有 schema：`src/db/schema.js`、`src/db/connection.js`
- Phase 3A spec: `docs/superpowers/specs/2026-05-12-my-schedule-design.md`
- Phase 3B spec: `docs/superpowers/specs/2026-05-12-group-mobile-ui-design.md`
- LINE Messaging API: https://developers.line.biz/en/reference/messaging-api/
- LINE webhook signature: https://developers.line.biz/en/reference/messaging-api/#signature-validation
