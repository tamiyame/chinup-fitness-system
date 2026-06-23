# 教練後台 方案系統 + 週曆登錄預約 — 設計文件

> 日期：2026-06-24
> 範圍：兩個子專案／兩個 PR。PR1＝方案（套餐／堂數）系統；PR2＝週曆登錄預約介面（建立在 PR1 之上）。
> 業主已於 brainstorming 拍板所有關鍵決策（見下「已拍板決策」）。

## 問題

教練／管理者目前只能在「公開預約頁」用單筆或舊版循環建立一對一預約，且系統**沒有「方案／套餐」概念**（無「客人擁有 N 堂、預約時扣抵」）。業主要：
1. 在 `coach.html`「個人資料」分頁後新增「登錄預約」分頁，呈現類 Google 行事曆的「週一～週日 × 整點」週曆。
2. 點整點時段 → 彈窗 → 搜尋客人 → 帶出該客人的方案（如一對一/一對二各 10 堂）→ 在該時段登錄並從方案扣 1 堂。
3. 可設 Google 行事曆式循環（每天/週/月/年 + 自訂：單位×間隔、週幾、結束日或發生 N 次後）。

## 背景（已查證，含 file:line）

- **分頁結構**：`public/coach.html:235-243` 三個分頁 `bookings`(我的預約) / `availability`(可預約時段) / `profile`(個人資料)；切換邏輯 `public/coach.js:148-154` `switchTab(name)`（內含 `if (name==='profile') renderProfile()` 等）。新分頁加 `data-tab="register"`＋`#tab-register` 區塊＋`renderRegister()`。
- **方案概念：不存在**。`src/db/schema.js` 無任何 package/credit/remaining 欄位。`bookings`(schema.js:170-194) 僅有 `session_type`('1on1'/'1on2')、`original_amount`/`discount_amount`/`discount_code`、`paid_at`/`paid_by`、`refunded_at`、`recurring_group_id`、`gcal_event_id` 等。折扣系統(`discountService.js`)只有一次性折扣碼，無剩餘堂數追蹤。**方案＋扣堂為全新子系統**。
- **單筆預約建立**：`src/services/bookingService.js` `createBookingCore({coach, memberId, startAt, note, sessionType})`（核心：寫 bookings、Google Calendar、通知）；`createBookingAnon(...)`(bookingService.js:113-138) 包一層做 findOrCreateUserByPhone＋定價＋折扣。
- **舊循環**：`bookingService.js:416-551`。`RECURRING_FREQS=['daily','weekly','monthly','custom']`；`recurringOccurrences({startAt,frequency,intervalDays,count})`；結束條件**只有 count**(2-52)，**無**結束日期、**無**週幾選擇、**無**每年。端點 `POST /api/bookings/recurring/preview`、`POST /api/bookings/recurring`(server.js:969-997)。前端 UI 在公開頁 `public/coaches.html:93-129` + `public/coaches.js`。**此舊流程維持不動。**
- **客人搜尋：無專用端點**。`GET /api/admin/users`(server.js:520-529) 回全部使用者（不分頁不搜尋）。`findOrCreateUserByPhone`/`getUserByPhoneAndName`(`src/services/userService.js`) 為電話身份解析。
- **班表**：`coach_availability_rules`(週迴圈規則：day_of_week 0-6、start_time、end_time、effective_from/to)＋`coach_availability_exceptions`(請假 leave／加開 extra)(schema.js:146-168)。端點 `/api/coach/me/rules`、`/api/coach/me/exceptions`。
- **管理者代選教練**：`server.js:702-710` `resolveCoach(req,res)`（只有 `req.user.is_admin` 才認 `coachId`，否則落回本人）；前端 `coach.js:10-17` `coachQuery()`（GET 加 `?coachId=`）/`withCoach(body)`（POST 補 `coachId`）。
- **團體課場次**：`course_sessions`（有 `coach_id`），可查某教練某週的場次疊加到週曆。
- **整點桶容量**：gcal 整合導入的每小時容量限制（一對一已改不讀 freebusy、只看班表）。本功能登錄走「任何時間都能點」，**略過**容量限制，只靠 `bookings` 的 partial unique index（同教練同整點 confirmed 唯一）擋重複。

## 已拍板決策（業主，brainstorming 2026-06-24）

1. **方案系統＝打造完整版**（記剩餘堂數、自動扣抵/回補）。
2. **方案建立**：後台手動開，**視為已付款**。
3. **類型扣抵**：方案類型必須與預約類型相符（1on1 方案只能用於 1on1）。
4. **多方案**：客人可同時擁有多個；扣抵預設挑「最早到期 → 最早建立」，彈窗可手動改選。
5. **有效期限**：可設到期日（可留空＝永久）；過期不可扣。
6. **週曆疊加顯示**：既有個別課預約 ＋ 團體課場次 ＋ 班表可預約時段底色（三者皆要）。
7. **可點範圍**：任何整點都能點（不受班表限制），只擋同教練同時段重複。
8. **無符合方案的客人**：**擋住**，要求先開方案（彈窗內可開）。
9. **循環堂數不足**：**只建立到方案用罄為止**，其餘場次不建立。
10. **方案管理位置**：登錄彈窗內可即時開方案 ＋ 會員管理長按彈窗新增「方案」區塊（檢視/新增/調整剩餘/作廢）。
11. （業主同意的小決策）登錄建立的預約**沿用既有預約通知**給客人；登錄**略過整點桶容量限制**。

---

## PR1 — 方案系統

### 資料模型

**新表 `customer_packages`**
```sql
CREATE TABLE IF NOT EXISTS customer_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK (session_type IN ('1on1','1on2')),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  remaining_sessions INTEGER NOT NULL CHECK (remaining_sessions >= 0),
  amount INTEGER,                         -- 方案總金額（視為已付款；可為 NULL）
  expires_at TEXT,                        -- 'YYYY-MM-DD'；NULL = 永久
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT                        -- 作廢（軟刪除），不再可用於扣抵
);
CREATE INDEX IF NOT EXISTS idx_customer_packages_member ON customer_packages(member_id);
```

**`bookings` 加欄**
```sql
ALTER TABLE bookings ADD COLUMN package_id INTEGER REFERENCES customer_packages(id);
```
（migration 於開機 schema 套用；prod volume DB 在 boot 跑 → 採 `ADD COLUMN`，向後相容。）

### 「有效方案」定義
`archived_at IS NULL` AND `remaining_sessions > 0` AND (`expires_at IS NULL` OR `expires_at >= 今天`)。

### Service：`src/services/packageService.js`（新檔）
- `createPackage({ memberId, sessionType, totalSessions, amount=null, expiresAt=null, note=null, createdBy })` → 驗證（type、totalSessions>0、expiresAt 格式或空）；`remaining_sessions = total_sessions`；回新列。
- `listPackagesForMember(memberId, { includeArchived=false })` → 該客人方案（預設排除作廢），含計算欄位 `is_valid`（依上方定義）。
- `listValidPackagesForMember(memberId, sessionType=null)` → 只回有效方案；給定 sessionType 則再篩類型；排序「最早到期(NULL 視為最遠) → 最早建立」。供登錄彈窗使用。
- `adjustRemaining({ packageId, remaining, actorId, reason=null })` → 手動校正剩餘堂數（夾在 0..total）；寫入 note 或另記（簡化：直接更新 remaining，附 note）。
- `archivePackage(packageId)` / `restorePackage(packageId)` → 作廢/還原。
- `deductOne(packageId, tx?)` → 在交易內 `remaining_sessions = remaining_sessions - 1`，**條件式更新**（`WHERE id=? AND remaining_sessions>0`，回傳是否成功）；失敗（剩 0）→ 由呼叫端決定（登錄流程：停止）。
- `refundOne(packageId, tx?)` → `remaining_sessions = MIN(remaining_sessions + 1, total_sessions)`（取消預約回補；即使方案已過期/作廢仍回補，因為堂數是客人的）。

### 與預約的整合（PR1 即先接好回補，扣抵在 PR2 用）
- `createBookingCore` 增加可選參數 `packageId`：若有，寫入 `bookings.package_id`、設 `paid_at=now`、`paid_by=actorId`、`original_amount = round(package.amount / package.total_sessions)`（amount 為 NULL 則 original_amount 為 NULL）、discount 欄位皆 NULL。**扣堂由呼叫端（登錄 service）負責**，以利在循環中控制「用罄即停」。
- `cancelBooking`（既有）：取消時若 `booking.package_id` 非空 → 呼叫 `refundOne(package_id)` 回補。

### 端點（server.js）
所有需 `requireCoach`（管理者亦可，沿用 resolveCoach 不需綁特定教練——方案屬客人不屬教練）。
- `POST /api/coach/packages` body `{ memberId, sessionType, totalSessions, amount?, expiresAt?, note? }` → createPackage。
- `GET /api/coach/packages?memberId=` → listPackagesForMember（含 is_valid）。
- `PATCH /api/coach/packages/:id` body `{ remaining?, note? }` → adjustRemaining。
- `POST /api/coach/packages/:id/archive`、`POST /api/coach/packages/:id/restore`。

### 前端：會員管理「方案」區塊
- 既有「會員管理」長按彈窗（`public/admin.*` 的 member edit modal）新增「方案」區塊：列出該會員方案（類型／剩餘/總／到期／狀態），按鈕「新增方案」（類型/堂數/金額/到期日/備註）、每筆可「調整剩餘」「作廢/還原」。
- （此區塊與登錄彈窗共用同一組端點。）

### PR1 測試
`tests/package-service.test.js`（unit，`npm test`）：建立/有效判定（過期、用罄、作廢三種失效）/多方案排序/deductOne 到 0 失敗/refundOne 上限不超過 total/adjustRemaining 夾值。
`tests/package-api.test.js`（`test:api`，需起 server）：POST/GET/PATCH/archive/restore 正常與守門（requireCoach）。
回歸：`bookings` 加欄不破壞既有預約測試；`cancelBooking` 對無 package_id 預約行為不變。

---

## PR2 — 週曆登錄預約介面

### 後端

**週資料彙整端點**
- `GET /api/coach/week?coachId=&start=YYYY-MM-DD`（requireCoach + resolveCoach）→ 回該教練自 `start`（週一）起 7 天的：
  - `bookings`：confirmed 的一對一/一對二（id、start_at、end_at、session_type、會員名、package_id 有無）。
  - `groupSessions`：該教練該週的團體課場次（時間、課名）。
  - `rules` / `exceptions`：班表規則與例外（供底色）。
- 純讀取彙整；前端據此畫格與疊加。

**客人搜尋端點**
- `GET /api/coach/customers/search?q=`（requireCoach）→ 以姓名或電話 LIKE 搜 `role='user'` 且未封存者，限筆數（如 20），回 `{ id, name, phone }[]`。
- 彈窗選定客人後，**沿用 PR1 的 `GET /api/coach/packages?memberId=`**（已回每筆 `is_valid`），前端篩出有效方案呈現；不另開重複端點。

**登錄建立端點（單筆 + 循環，皆走方案）**
- `POST /api/coach/register/preview` body `{ coachId?, memberId, packageId, startAt, recurrence }` → 計算場次清單，逐筆標記：`ok` / `conflict`(同教練同整點已有 confirmed) / `depleted`(方案將用罄、不建立)。**不寫入**。回 `{ occurrences:[{startAt,status}], willCreate, willDeduct, remainingAfter }`。
- `POST /api/coach/register` 同 body → 在單一交易內：
  1. 載入方案，驗證有效＋類型符合（與 booking 的 session_type＝package.session_type）。
  2. 展開循環場次（見下）。
  3. 依時間順序逐筆：conflict 跳過（不扣）；否則嘗試 `deductOne(packageId)`，成功才 `createBookingCore({..., packageId, sessionType: package.session_type, actorId})`；`deductOne` 失敗（剩 0）→ **停止後續**（用罄即停）。
  4. 同一批以新 `recurring_group_id` 串（循環時；單筆不需）。
  5. 回建立結果摘要。
- **無方案則擋住**：前端在無有效方案時不允許送出（提示開方案）；後端亦防禦（找不到有效方案 → 400）。

**循環展開：`expandRecurrence(rule, startAt)`（新函式，獨立於舊 recurringOccurrences）**
- 正規化規則：`{ frequency: 'daily'|'weekly'|'monthly'|'yearly', interval: N>=1, byWeekday: number[]|null, end: {type:'count', count} | {type:'date', date:'YYYY-MM-DD'} }`。
  - 預設（每天/週/月/年）：interval=1、byWeekday=null。自訂：可調 interval、單位、(週)byWeekday、結束條件。
  - `byWeekday` 僅 frequency='weekly' 有意義；給定時，於每個「週區間（interval 週一次）」內產生所選週幾的場次。未給定 → 用 startAt 當天的週幾。
  - `monthly`：同月日（遇該月無此日，如 31 → 標記跳過，比照舊邏輯）。`yearly`：同月同日（2/29 → 無此日跳過）。
  - 結束：`count` → 產到第 N 筆（含首筆）；`date` → 產到 ≤ date 為止（上限保護，如最多 365 筆避免爆量）。
- 回 `[{ startAt }]`（含 reason 標記如 no_date）。

### 前端：`coach.html` / `coach.js` 新「登錄預約」分頁

**週曆**
- 新分頁鈕 `登錄預約`(data-tab="register") 置於 `個人資料` 之後；`#tab-register` 區塊；`switchTab` 加 `if(name==='register') renderRegister()`。
- 週曆：頂部「← 本週 →／回今天／年月」導覽；7 欄（週一～日，欄頭日期）× 整點橫列（預設 07:00–22:00，CSS 內捲可看更早/晚或全天）。
- 疊加：個別課預約區塊（含客人名＋類型）、團體課場次（唯讀、樣式區隔）、班表可預約時段以淡底色。
- 點空白整點格 → `openRegisterModal(coachId, startAtISO)`。
- 管理者：沿用 coach-picker＋`coachQuery()`，換教練重抓週資料。

**登錄彈窗**
1. 標題顯示所點時段（月/日/星期 + HH:00）。
2. 客人搜尋框（輸入即查 `/api/coach/customers/search`，debounce）→ 結果列點選。
3. 選定客人 → 抓其有效方案；列出（一對一/一對二＋剩餘/到期），預設選「最早到期」那筆，可改選。
   - 無有效方案 → 顯示「此客人沒有可用方案」＋「開方案」表單（類型/堂數/金額/到期日/備註）→ `POST /api/coach/packages` → 重抓方案、自動選新方案。
4. 循環開關：關＝單筆；開＝顯示循環設定（頻率下拉 每天/週/月/年/自訂；自訂展開：單位＋間隔＋（週）週一～日勾選；結束：指定日期 or 發生 N 次）。
5. 「預覽」→ `POST /api/coach/register/preview` → 列出場次（ok/衝突跳過/用罄不建立）＋「將建立 X 筆、扣 X 堂、方案剩 Y」。
6. 「確認登錄」→ `POST /api/coach/register` → 成功關窗、重抓週資料、toast 摘要。

### PR2 測試
`tests/recurrence-expand.test.js`（unit）：每天/週/月/年；自訂間隔；週幾多選；結束=count 與 =date；月底 no_date、2/29 跳過；上限保護。
`tests/coach-register-api.test.js`（test:api）：單筆登錄扣 1＋自動已核對＋寫 package_id；循環扣到用罄即停；衝突場次跳過不扣；類型不符擋；無方案擋；取消回補（與 PR1 cancelBooking 整合）。
`tests/coach-week-api.test.js`（test:api）：週彙整回傳含 bookings/groupSessions/rules/exceptions、resolveCoach 代選教練。
回歸：舊 `POST /api/bookings/recurring*` 不受影響；既有預約/取消測試通過。

## 安全 / 守門
- 所有方案/週/登錄端點 `requireCoach`（管理者亦通過）；代選教練沿用 `resolveCoach`（僅 is_admin 認 coachId）。方案屬「客人」非「教練」，故方案 CRUD 不綁特定教練，但仍需員工身分。
- 客人搜尋只回 `role='user'` 未封存者的 `{id,name,phone}`（不洩員工、不洩 line/email）。
- 登錄一律經有效方案；後端防禦（類型不符/無效方案/剩餘不足）即使前端被繞過也擋。
- 扣抵/回補在單一交易內，deductOne 用條件式 UPDATE 防併發超扣。

## 不動
- 公開預約頁與其舊循環流程（`coaches.*`、`/api/bookings/recurring*`、`recurringOccurrences`）。
- 既有付款核對、折扣碼、團體課流程（僅唯讀疊加團課場次）。
- 既有 gcal 同步與通知（登錄沿用 createBookingCore 既有行為）。

## 收尾
- 實作收尾移除暫存預覽 mock（`public/_mock_register*.html`，不進版控）。

## 不做（YAGNI）
- 不存 RRULE 字串（循環直接展開成個別 bookings，比照舊作法以 recurring_group_id 串）。
- 不做方案線上販售/金流（後台手動開、視為已付）。
- 不做客人自助查方案/自助預約扣堂（僅員工後台）。
- 不改舊公開頁循環為新引擎（兩套並存；未來如要統一另開）。
