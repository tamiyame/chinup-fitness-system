# 期課雙月期別自動續開 — 設計規格

- 日期：2026-08-25
- 狀態：業主已核可設計

## 背景

團課範本（`course_templates`）存固定的 `cycle_start_date`／`cycle_end_date`，場次在建立／編輯範本時一次展開完，沒有「期」的概念、沒有自動續開。業主的課表實務上以**雙月為一期**（1–2、3–4、5–6、7–8、9–10、11–12 月），每期結束前得手動把每個範本的結束日改到下期月底，客人才有下期可報。

公開頁（PR #103）目前回傳完整週期含灰色歷史，期末時客人要捲過整期已結束場次才看到可報名的。

## 目標（業主拍板）

1. **自動續期**：進入每期「最後一週」時，系統自動把有開啟自動續期的範本延長到下期月底並補齊場次，客人可直接報下期。
2. **公開頁窗口**：不分期中期末，只列「本週週一起」的場次；本週已上完的仍灰色顯示。進入最後一週後自然變成「本週剩餘＋下期全部」。
3. 自動續期發生時通知管理者一則 LINE。

### 業主定義的規則

- **期別**：固定日曆雙月。`periodOf(ymd)` → `{ start: 奇數月 1 日, end: 偶數月最後一天 }`。
- **最後一週（開放下期的日期）**：`錨點 = 期末最後一天 − 7 天`；錨點若非週一，往前推到該週（週一～週日）的週一。
  - 驗算：2026-08 → 08/24；2026-10 → 10/19；2026-12 → 12/21；2027-02 → 02/15；2027-04 → 04/19；2027-06 → 06/21。
- **續期範圍**：範本新增 `auto_renew` 開關（預設開）。關閉的範本本期剩餘場次照常顯示到期末，只是不續。

## 變更點

### 1. Schema／遷移（`src/db/schema.js`、`src/db/connection.js`）

- `course_templates` 加欄位 `auto_renew INTEGER NOT NULL DEFAULT 1`（schema.js CREATE TABLE 加欄；connection.js `addColumnIfMissing('course_templates', 'auto_renew', 'INTEGER NOT NULL DEFAULT 1')` 供既有 DB 升級）。
- 一次性回填（緊接在 addColumnIfMissing 之後）：以 `app_settings` 的 `auto_renew_backfill_done` 當旗標——值不是 `'1'` 才執行 `UPDATE course_templates SET auto_renew = CASE WHEN cycle_end_date >= ? THEN 1 ELSE 0 END`（參數為 JS 端 `nowLocal().slice(0, 10)`，不用 SQLite `date('now')` 以免時區歧義），然後寫旗標 `'1'`。守門是為了不在每次開機覆蓋業主之後的手動設定。效果：現行五門課（結束 8/31）＝開，早已結束的舊範本＝關，不會在下次換期被翻出來。全新 DB（測試）沒有範本，回填無事、旗標照寫。

### 2. 期別純函式（新檔 `src/services/period.js`）

純函式獨立成檔（不 import DB，測試不開 DB）；DB 工作在下一節的 `periodService.js`。全部以 `YYYY-MM-DD` 字串進出、UTC 日期運算（與 `schedule.js` 同法），不碰 DB：

- `periodOf(ymd)` → `{ start, end }`。
- `nextPeriod(period)` → 下一個雙月 `{ start, end }`。
- `periodOpenDate(period)` → 該期開放下期的日期（上述錨點規則）。
- `targetEndFor(today)` → `today >= periodOpenDate(periodOf(today))` ? `nextPeriod(...).end` : `periodOf(today).end`。
- `periodLabel(period)` → `'9–10 月'`（跨年時 `'2027 年 1–2 月'` 不需要，期別永不跨年）。
- `weekStartMonday(ymd)` → 該週週一的 `YYYY-MM-DD`。

### 3. 自動續期工作（新檔 `src/services/periodService.js`，`rolloverTemplates(today = nowLocal().slice(0, 10))`）

- 選取：`SELECT * FROM course_templates WHERE status = 'published' AND auto_renew = 1 AND cycle_end_date < ?`（`targetEnd`）。
- 對每筆，同一交易內：`UPDATE course_templates SET cycle_end_date = targetEnd WHERE id = ?`；`expandTemplate({ ...t, cycle_end_date: targetEnd })` 後逐筆 `INSERT OR IGNORE INTO course_sessions (...)`（與 `courseService.insertSession` 同欄位、帶 `t.coach_id`；`UNIQUE(template_id, session_date)` 保證冪等），計數 `info.changes`。`cycle_start_date` 不動。
- 回傳 `{ targetEnd, extended: [{ id, name, added }] }`。
- 通知：`extended.length > 0` 時 `notifyAdmins({ type: 'period_rollover_admin', vars: { period_label, summary } })` 一則；`summary` = `'綜合體能(週三) 9 場、基礎重量訓練(週二) 9 場'`（以 `、` 串接，added=0 的也列出方便對帳）。通知在交易提交之後發。
- 觸發：
  - `src/scheduler.js` 加每日 `'5 0 * * *'`（`{ timezone: 'Asia/Taipei' }`）cron。
  - `startScheduler()` 開頭同步呼叫一次 `rolloverTemplates()`（開機自癒；今天已過 8/24，merge 部署後開機即把 9–10 月開出）。
  - 兩處都 try/catch 記 `[scheduler] period rollover` log，與其他 cron 同款。

### 4. 公開頁窗口（`src/services/groupOrderService.js` `getPublicGroupCourses`）

- 場次查詢加 `AND session_date >= ?`，參數 `weekStartMonday(now.slice(0, 10))`。其餘（暫停隱藏、`selectable`／`state`、「至少一個 selectable 才列範本」）**一行不動**。
- 前端 `public/group.js` 零改動：「N 場」＝列出場數、全選只計 selectable＋未滿，語意本就相對於回傳清單。

### 5. 後台（`public/admin.html`、`public/admin.js`、`src/services/courseService.js`）

- 範本表單「週期起始／結束」列下方加：`<label><input type="checkbox" name="auto_renew" checked> 自動續期（每期最後一週自動開放下期場次）</label>`。
- `admin.js`：`openNew` 預設勾；`openEdit` 設 `f.auto_renew.checked = t.auto_renew !== 0`；submit 組 payload 時 `payload.auto_renew = f.auto_renew.checked ? 1 : 0`（FormData 對未勾 checkbox 不帶 key，須明確補）。
- 範本卡 meta 多一個 `<span class="meta-item">${ICO.repeat} 自動續期</span>`（`auto_renew` 為 1 才顯示；重用既有 icon，不新增）。
- `courseService.js`：`normalize` 加 `auto_renew: (t.auto_renew === undefined || t.auto_renew === null) ? 1 : (Number(t.auto_renew) ? 1 : 0)`；`insertTemplate`／`updateTemplate` 加該欄。`editTemplate` 既有「刪未來無報名場次後重展」行為不動——它用範本上的日期，延長後仍一致。

### 6. 通知模板（`src/services/notifications.js`）

```js
period_rollover_admin: {  // 寄給管理者（自動續期完成）
  subject: '{{period_label}} 期課已開放報名',
  body: '📅 {{period_label}} 期課已自動開放報名：{{summary}}。',
},
```

後台通知紀錄型別標籤表（`admin.js` 既有物件）加 `period_rollover_admin: '期課續期'`。

## 邊角（明訂）

- 業主手動把結束日改到超過 targetEnd（如 12/31）→ `cycle_end_date < targetEnd` 不成立，排程跳過、不回退。
- 業主把結束日改到本期中途（想提早收）而 `auto_renew` 仍開 → 隔日排程就會補回本期末（`auto_renew=1` 的語意＝結束日恆 ≥ targetEnd），最後一週再延到下期末；想收課須關開關。後台勾選框文字已說明，不另加提示。
- 非 weekly 的 recurrence（monthly 等）同樣延長＋重展；月節拍展開只取每月第一個 day_of_week，延長只會新增未來月份。
- 範本 `status='draft'`／`'archived'` 不續。
- 伺服器某天沒跑：隔日 cron 或下次開機補上，結果相同（冪等）。
- 公開頁窗口對「本週」的計算以伺服器本地時間（容器 `TZ=Asia/Taipei`）；週一 00:00 起上週場次消失。
- API 測試鏈若載入 `startScheduler`，開機 rollover 對測試 DB 執行：無範本或不在窗口內＝無事，在窗口內＝延長測試範本——既有 API 測試不斷言範本結束日，無影響（實作時以完整鏈驗證）。

## 測試

- 新檔 `tests/period-service.test.js`（純函式，不碰 DB；加入 `package.json` 測試鏈）：
  - `periodOf`：`2026-08-25` → `{2026-07-01, 2026-08-31}`；`2026-09-01` → `{2026-09-01, 2026-10-31}`；`2027-01-15` → `{2027-01-01, 2027-02-28}`；`2028-02-10` → end `2028-02-29`（閏年）。
  - `periodOpenDate`：六組驗算值（08/24、10/19、12/21、02/15、04/19、06/21）。
  - `targetEndFor`：`2026-08-23` → `2026-08-31`；`2026-08-24` → `2026-10-31`；`2026-09-01` → `2026-10-31`。
  - `weekStartMonday`：`2026-08-25`（週二）→ `2026-08-24`；`2026-08-24` → 自身；`2026-08-30`（週日）→ `2026-08-24`。
- 新檔 `tests/period-rollover.test.js`（fresh DB、console 通道、加入測試鏈）：
  - 三個範本：A published+auto_renew（結束 8/31）、B published+auto_renew=0、C draft+auto_renew；`rolloverTemplates('2026-08-24')` → 只 A 延到 `2026-10-31`、A 新增場次數 = 9–10 月該週幾的次數、B/C 不動；管理者 `period_rollover_admin` 恰 1 筆（delta）。
  - 同日再跑 → `extended` 空、場次數不變、通知不再增加。
  - `rolloverTemplates('2026-08-23')` 對全新範本 → 不動。
  - 範本結束日已是 `2026-12-31` → 不動。
- `tests/group-public-past.test.js`：既有 s1（`dstr(-7)`）、s2（`dstr(-14)`）必然落在本週週一之前，會從回傳消失——改成不依賴星期幾的日期：s1＝**今天** `00:01:00` confirmed（已過、必在本週；同範本同日只能一筆，受 `UNIQUE(template_id, session_date)` 限制）、s2＝另建第二個範本的今天 `00:02:00` cancelled 場次；再加 s0＝`weekStartMonday(today)` 前一天 confirmed。斷言 s0 不回、s1 回 `ended`、s2 回 `not_held`。其餘 s3–s6 未來場次不動。
- 既有 `tests/migration.test.js` 舊 schema 升級後 `PRAGMA table_info(course_templates)` 含 `auto_renew`。
- 完整 unit 鏈（`DB_PATH="$(mktemp -d)/t.db" npm test`）＋開機煙測（fresh DB＋mocks 起伺服器打 `/api/health`，同時驗 scheduler import 無誤且開機 rollover 不炸）。

## 範圍外（YAGNI）

- 後台「立即開放下期」手動按鈕（開機＋每日排程已涵蓋）。
- 提前天數可調（業主選固定規則）。
- 客人端「下期已開放」推播。
- 期別以外的自訂週期（例如三個月一期）。
