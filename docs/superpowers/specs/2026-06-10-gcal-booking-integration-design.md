# Google Calendar 整合 + 時段容量限制 設計規格

日期：2026-06-10
狀態：已與業主確認設計決策，待實作

## 1. 目標

1對1 預約成立時，系統自動在店家 Google 日曆建立活動；店家在日曆上手動建立的活動可反向封鎖可預約時段（雙向同步）。顧客預約時可選填 Email 收確認信。同時導入「全店時段容量上限」：以整點小時桶計算，每桶最多 3 人（後台可調）。

### 已確認的設計決策

| 決策點 | 結論 |
|---|---|
| 日曆歸屬 | 單一店家日曆，calendar ID 存 `app_settings`，後台可編輯；留空 = 日曆同步整體關閉 |
| freebusy 角色 | 雙向完整版：手動日曆活動會濾掉可約時段＋送出預約時做最終檢查；Google 故障 fail-open |
| 確認信 | Email 選填，有填才寄 |
| 寄信機制 | Gmail API + 一次性 OAuth 授權（refresh token 存環境變數），不引入 nodemailer |
| 容量模型 | 瞬時人數上限，**以整點切桶**（9–10、10–11…）；詳見 §5 |
| 授權方式 | Calendar 用 Service Account（不用 googleapis 套件，node:crypto RS256 + fetch）；Gmail 用 OAuth refresh token |

### 範圍外（明確不做）

- 取消通知信（只做預約確認信）
- 把顧客 email 加為日曆活動邀請對象（Service Account 無網域委派做不到，這正是確認信存在的原因）
- 團體課程寫入日曆、團課計入容量（假設團課與 1對1 空間獨立；未來需要再加）
- 既有 LINE 通知流程改動（三方通知已上線，維持不動）

## 2. 授權架構（兩條獨立路徑）

### 2.1 Calendar — Service Account

- 環境變數 `GCAL_SERVICE_ACCOUNT_JSON`：完整 SA JSON 金鑰。以 `{` 開頭視為原始 JSON，否則當 base64 解碼（Railway 多行值兩種都支援）。
- 以 `node:crypto` `createSign('RSA-SHA256')` 簽 JWT（`iss`=client_email, `scope`=`https://www.googleapis.com/auth/calendar`, `aud`=`https://oauth2.googleapis.com/token`, 1 小時效期），POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` 換 access token，**記憶體快取至到期前 5 分鐘**。
- 零新依賴，比照 `lineClient.js` 風格：never-throws、回傳 `{ok, error}`、`GCAL_MOCK=1` 時短路（測試離線）。

### 2.2 Gmail — OAuth refresh token（沿用現有 GOOGLE_CLIENT_ID/SECRET）

- 一次性授權流程（admin-only）：
  - `POST /api/admin/gmail-auth/start`（requireAdmin，fetch 呼叫）→ 回 `{url}`（Google 同意畫面：scope `https://www.googleapis.com/auth/gmail.send`、`access_type=offline`、`prompt=consent`、`redirect_uri={PUBLIC_URL}/api/admin/gmail-auth/callback`、隨機 state 存記憶體 Map 比照現有 `oauthStates`，TTL 10 分鐘）。前端 `window.location = url`。
  - `GET /api/admin/gmail-auth/callback`：驗 state → 換 code → **HTML 頁一次性顯示 refresh token**，提示業主自行貼到 Railway `GMAIL_REFRESH_TOKEN`。**不落 DB、不寫檔**（符合「prod 機密業主自行操作」原則）。
- 寄信時：refresh token 換 access token（記憶體快取），POST `gmail/v1/users/me/messages/send`，body 為 base64url 的 RFC822 訊息（`MIME-Version`/`Content-Type: text/html; charset=UTF-8`、Subject 用 RFC2047 UTF-8 B-encoding）。
- `GMAIL_MOCK=1` 短路供測試。

### 2.3 功能開關（互相獨立、各自降級）

- 日曆同步啟用 = `GCAL_SERVICE_ACCOUNT_JSON` 已設 **且** `app_settings.gcal_calendar_id` 非空。
- 寄信啟用 = `GMAIL_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID/SECRET` 都已設。
- 任一未設：功能靜默停用（boot 時 log 一次），預約主流程完全不受影響。

## 3. 資料模型變更（全部 additive，`addColumnIfMissing` 開機遷移）

| 表 | 變更 | 用途 |
|---|---|---|
| `bookings` | `+ gcal_event_id TEXT` | 「日曆上已有事件」旗標；建立成功寫入、刪除成功清空；reconcile cron 依此補建/補刪 |
| `bookings` | `+ customer_email TEXT` | 確認信收件位址。**不寫 `users.email`**（那是員工登入識別、有 UNIQUE partial index，寫顧客 email 會撞鍵） |
| `notifications` | `+ recipient TEXT` | email 通知的收件位址（LINE 通知此欄 NULL），重試時直接取用 |
| `app_settings` | `+ 'gcal_calendar_id'`（seed `''`） | 店家日曆 ID；空 = 同步關閉 |
| `app_settings` | `+ 'booking_hourly_capacity'`（seed `'3'`） | 每小時桶容量上限，後台可編輯（驗證 1–99 整數） |
| `notifications.channel` | 新值 `'email'`（無 CHECK 約束，免遷移） | 重用既有 5/15/45 分退避重試機制 |

## 4. 新模組（src/services/）

| 檔案 | 職責 |
|---|---|
| `googleAuth.js` | SA JWT 簽章換 token、refresh token 換 token，兩者皆記憶體快取；金鑰解析（raw/base64） |
| `gcalClient.js` | `freeBusy(calendarId, fromISO, toISO)`、`insertEvent(calendarId, event)`（帶決定性 id，409 時改走 `events.update` 復活）、`deleteEvent(calendarId, eventId)`（404/410 視為成功）；`GCAL_MOCK` 開關 |
| `gmailClient.js` | `sendMail({to, subject, html})`；RFC822 組裝；`GMAIL_MOCK` 開關 |
| `gcalSync.js` | 事件 body 組裝、`syncBookingCreate(bookingId)` / `syncBookingCancel(bookingId)`（fire-after-commit 呼叫）、`reconcile()`（cron）、freebusy busy 區間 → 台北牆鐘區間轉換、60 秒 freebusy 記憶體快取 |

## 5. 容量限制（hour-bucket 模型）

**規則**（業主已確認）：
- 每筆預約固定 60 分鐘；1對1 佔 1 人、1對2 佔 2 人。
- 全天以整點切桶（…14–15、15–16…）。**全店跨教練**：每桶內「時間上重疊到該桶」的 confirmed 預約人數加總 ≤ 容量上限（預設 3，`booking_hourly_capacity`）。
- 跨桶的非整點預約（如 14:30–15:30）**同時佔用兩個桶**的名額。
- 範例：A、B 兩組 1對1 在 14:00–15:00、C 一組 1對1 在 14:30–15:30 → 14–15 桶 = 3（滿）、15–16 桶 = 1（C）→ 14:00/14:30 開頭不可約，15:00 開頭還可約 2 人。

**演算法**：
```
units(b)   = b.session_type === '1on2' ? 2 : 1
buckets(s,e) = 所有與 [s,e) 重疊的 [H:00, H+1:00) 小時桶（跨日以日期+小時為 key）
load(B)    = Σ units(b)  for confirmed b 且 [b.start_at, b.end_at) ∩ B ≠ ∅（不分教練）
slot 可約  ⇔ ∀B ∈ buckets(slot): load(B) + units(新預約) ≤ capacity
remain(slot) = min over B ∈ buckets(slot) of (capacity − load(B))
```

**回應形狀變更**：`GET /api/coaches/:id/availability` 與 `GET /api/coach/me/availability-preview` 從 `string[]` 改為 `{ start: 'YYYY-MM-DDTHH:MM:SS', remain: number }[]`（remain ≥ 1 才列出）。前端：選 1對2 時，`remain < 2` 的時段灰掉不可選；切換方案時就地重濾快取。

**順手修正既有缺陷**：同教練撞期目前只擋「start_at 完全相等」（exact match），非對齊視窗可能造成同教練重疊預約。升級為**區間重疊**判定（slot 與該教練任何 confirmed 預約重疊即不可約）。

## 6. 預約送出驗證管線（POST /api/public/bookings、authed 路徑同）

現況缺陷：API 完全不驗證 `startAt` 合法性（繞過前端可預約任意時間）。新管線：

1. **格式檢查**（既有）＋ `email` 有給則驗格式（`xx@yy.zz` 寬鬆 regex），`startAt` 必須是 `YYYY-MM-DDTHH:MM:00` 牆鐘字串。
2. **路由層（async，tx 外）**：重算該教練該日可約時段（含 freebusy + 容量），`startAt` 不在清單或 `remain < units` → `409 slot_unavailable`。freebusy 取得失敗 → fail-open（退回純 DB 檢查，log warning）。
3. **tx 內（BEGIN IMMEDIATE，同步、純 DB）**：重查容量與同教練區間重疊 → 不過則丟 `slot_unavailable`。SQLite 單寫者特性使此檢查無競態。UNIQUE(coach_id, start_at) 索引保留為最後兜底（409 `slot_taken` 語意不變）。
4. **commit 後（比照 notify() 慣例，不 await、不持鎖）**：既有三方 LINE 通知 → `syncBookingCreate`（建日曆事件）→ 有 email 則寄確認信。

前端把 `slot_unavailable` 對應為「該時段已額滿或不可預約，請重新選擇時段」並自動重新載入時段。

## 7. 日曆事件生命週期（冪等設計）

- **事件 ID 決定性產生**：`'chinupbk' + String(booking.id).padStart(9,'0')`（符合 Calendar id 的 base32hex 字元集）。重試不產生重複事件、write-back 遺失也找得回、取消時不靠 DB 也刪得掉。
- **建立**：`summary` = `{1對1|1對2}教練課 {教練名}×{顧客名}`；`description` = 電話／方案／折後金額（含折扣碼）／預約編號／「系統自動建立」；`start/end` = `{dateTime: 'YYYY-MM-DDTHH:MM:SS+08:00', timeZone: 'Asia/Taipei'}`；**`transparency: 'transparent'`**。
  - transparency 是關鍵：系統建的事件顯示為「有空」，freebusy 只會抓到店家**手動建立**（預設「忙碌」）的活動 → 自家預約不會誤鎖其他教練的同時段；店家想讓某手動活動不擋預約，把它改成「有空」即可。
  - insert 收到 409（id 已存在，含被手動刪除後的 cancelled id）→ 改呼叫 `events.update` 同 body + `status:'confirmed'`（復活）。
  - 成功 → `UPDATE bookings SET gcal_event_id`。
- **取消**（顧客匿名取消 `cancelBookingAnon` ＋ 教練緊急取消 `cancelBooking` 兩條路徑）：commit 後 `deleteEvent`；404/410 視為成功；成功後清空 `gcal_event_id`。
- **Reconcile cron**（5 分鐘，比照 `_retryRunning` 布林防重入，僅在同步啟用時跑，單輪上限 20 筆）：
  - 補建：`status='confirmed' AND start_at >= now AND gcal_event_id IS NULL`
  - 補刪：`status='cancelled' AND gcal_event_id IS NOT NULL`
  - 副作用（刻意的）：功能上線後 5 分鐘內，**既有的未來預約會自動補建到日曆**。
- Google 完全故障：預約照常成立，事件由 cron 事後補齊。

## 8. 確認信

- 表單新增「Email（選填）」；有填 → 存 `bookings.customer_email` → commit 後寄送。
- 內容（zh-TW，簡單 HTML）：顧客稱呼、教練、時間 `YYYY/MM/DD (週X) HH:MM–HH:MM`、方案 1對1/1對2、折後金額（有折扣碼則註明）、匯款資訊（`bank_info`）、官方 LINE（`line_official_url` 非空才放）、取消方式（`{PUBLIC_URL}/my-schedule.html`，姓名＋電話查詢）。寄件顯示名稱用前台品牌名（實作時從前台取一致字串）。
- **失敗重試**：寄送結果寫 `notifications`（channel `'email'`、recipient、渲染後 subject/body），失敗走既有 5/15/45 分退避；`processFailedNotifications` 依 channel 分流（line → LINE push、email → `gmailClient.sendMail`）。
- 成功頁有填 email 時顯示「確認信將寄至 {email}，未收到請檢查垃圾信件匣」。

## 9. UI 變更

- **coaches.html / coaches.js**：預約彈窗加 Email 選填欄；slot 快取改存 `{start, remain}` 物件；1對2 時 `remain<2` 的時段不可選、切換方案就地重濾；`slot_unavailable` 錯誤處理＋自動刷新時段。
- **admin.html / admin.js（設定分頁）**：新增「Google 日曆 ID」文字欄、「每小時容量上限」數字欄（PATCH /api/admin/settings 既有 validate-all-then-write 模式）；「Gmail 寄信授權」按鈕（fetch start → 跳轉同意畫面）。
- **coach.js**：availability-preview 改用新回應形狀。

## 10. 時區修正（搭便車）

- Dockerfile 加 `ENV TZ=Asia/Taipei`；`.env.example` 補 `TZ`；業主在 Railway 補同名變數保險。
- boot 時 log `server timezone + 當下時間` 一行，部署後可目視驗證。
- 既有資料不受影響（牆鐘字串都來自使用者輸入）；修正的是 `nowLocal()` 的「現在」基準（2 小時緩衝、過去時段過濾在 UTC 容器上原本歪 8 小時）。
- 邊界轉換鐵則：對 Google 送 `+08:00` RFC3339；收到的 busy 區間轉回台北牆鐘字串再進系統；**全程禁用 `Date.toISOString()`**。

## 11. 測試計畫（離線，GCAL_MOCK/GMAIL_MOCK）

- 容量單元測試：整點對齊、跨桶（14:30–15:30 佔兩桶）、1對2=2 人、恰好滿 3 邊界、remain 計算、跨日桶 key。
- 同教練區間重疊（升級後）判定。
- 驗證管線 API 測試：off-grid `startAt` → 409、容量滿 → 409、freebusy busy 蓋住 → 409、email 格式錯 → 400、email 正常入庫。
- gcalClient：JWT 簽章（測試金鑰對 + `crypto.verify` 驗簽）、決定性事件 id、RFC3339 ↔ 牆鐘轉換（含 `Z` 與 `+08:00` 輸入）、busy→區間切日。
- gmailClient：RFC822 組裝（UTF-8 subject）、mock 短路。
- email 通知列：channel/recipient 正確、重試分流。
- **既有測試影響**：booking 相關測試會被新驗證管線擋下，需補建教練可用時段規則（rules）後再下單；逐一修整。

## 12. 部署與業主設定清單

程式側：additive 遷移 + Dockerfile TZ；照慣例**部署前備份 prod DB**。

業主側（Google Cloud Console，沿用現有專案）：
1. 啟用 **Google Calendar API** 與 **Gmail API**。
2. 建立 Service Account → 下載 JSON 金鑰 → Railway 設 `GCAL_SERVICE_ACCOUNT_JSON`。
3. 店家 Google 日曆「設定與共用」→ 與特定使用者共用 → 加 SA 的 email，權限「**進行變更**」。
4. OAuth 用戶端加 redirect URI `{prod}/api/admin/gmail-auth/callback`；**OAuth 同意畫面發布為「正式版」**（測試模式 refresh token 7 天過期；`gmail.send` 為受限 scope，未驗證會出警告頁，自己帳號點「進階→繼續」即可）。
5. 後台按「Gmail 寄信授權」→ 取得 refresh token → Railway 設 `GMAIL_REFRESH_TOKEN`。
6. 後台設定分頁填「Google 日曆 ID」→ 同步即啟用（5 分鐘內未來既有預約自動補建）。
7. Railway 補 `TZ=Asia/Taipei`。

## 13. 風險與假設

- 團課不計入容量、不寫日曆（空間獨立假設；業主如要納入另開需求）。
- freebusy fail-open：Google 故障期間手動封鎖可能漏擋（可接受，預約主流程優先）。
- Gmail 個人帳號約 500 封/日，小型場館綽綽有餘；未來量大換 Resend/SendGrid 時只需改寫 `gmailClient.sendMail` 一個函式。
- LINE push 免費額度 1000 則/月不變（本案不新增 LINE 訊息）。
- 單副本假設沿用（token 快取、state Map、cron 防重入都在記憶體）。
- 店家手動改動系統建立的事件（搬時間、改標題）**不會**反向改 DB 預約；DB 是唯一事實來源，reconcile 只看「存在/不存在」。
