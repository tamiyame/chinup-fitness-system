# 管理者補登過去預約（解鎖「上週」按鈕）— 設計文件

- 日期：2026-06-15
- 分支：`feat/admin-backfill-booking`
- 狀態：待業主審閱

## 目標

預約頁（教練詳細頁）的「上週」按鈕目前對所有人鎖定，無法回看過去日期。需求：
**管理者登入後**可往前翻週、看到過去日期的時段，並對過去時段「補登」預約，用於校正或補登記顧客的課程資料。
**一般使用者**行為完全不變，仍不可回溯往前預約。

## 已確認的產品決策

1. **副作用**：補登「已發生的過去課程」時 **純記錄、不發任何通知與整合** — 不發 LINE／Email「預約成功」、不建立 Google 日曆事件、不套用折扣碼。
2. **付款狀態**：補登的過去預約 **直接標記為「已核對／已付款」**（`paid_at` 設值），視為已完成歷史紀錄，直接出現在顧客課程歷史，不需再人工核對。
3. **容量檢查**：補登過去時段 **完全不檢查**「同教練不重疊」與「整點桶容量上限」（記錄真實發生的狀況，允許重複／超量）。
4. **可改價**：補登彈窗的金額 **可編輯**，預設帶入該課程型態（1對1／1對2）標準單價，切換型態時更新，管理者可覆寫（允許 0 元做贈課／特例）。

## 名詞

- **補登（back-fill）**：管理者對 `startAt < now` 的過去時段建立的預約紀錄。
- **過去時段**：開始時間早於「現在」的時段；由伺服器依時間權威判定，不信任前端。

## 範圍（異動檔案）

- `public/coaches.js` — 「上週」解鎖、含過去查詢、補登時段呈現、補登彈窗變體。
- `src/services/availabilityService.js` — `computeAvailableSlots` 新增 `includePast`。
- `src/services/bookingService.js` — 新增 `createBackfillBooking`。
- `src/server.js` — `GET /api/coaches/:id/availability` 加 `backfill` 參數；新增 `POST /api/admin/bookings/backfill`。
- 對應測試檔。

## 詳細設計

### 1. 前端週次解鎖（`coaches.js`）

- `updatePrevDisabled()`：管理者（`getUser()?.is_admin` 為真）時「上週」永不 disabled；一般使用者維持 `weekOffset <= 0` 即 disabled。
- `prev-week` 點擊：管理者允許 `weekOffset` 變負（無下限）；一般使用者維持 `weekOffset > 0` 才可減。
- `openCoach()` 進入詳細頁時 `weekOffset = 0` 維持不變（預設仍從今天起算）。
- 可回溯範圍：**不設上限**。教練建檔前（早於班表規則 `effective_from`）的過去週自然無時段，顯示「此週沒有可預約時段」。

### 2. 可預約查詢加入「含過去」模式（`availabilityService.js` + `server.js`）

- `computeAvailableSlots({ ..., includePast = false })`：
  - `includePast = false`（預設）→ 行為與現狀**完全一致**（過去／緩衝／視窗過濾 + 容量／重疊排除）。
  - `includePast = true`：
    - **未來時段（`start >= now`）**：維持原本邏輯（緩衝 + 容量 + 視窗 + 重疊排除），標記 `past: false`。
    - **過去時段（`start < now`）**：列出該日班表規則產生的所有整點時段，**不做**容量／重疊排除、不套緩衝／視窗，標記 `past: true`，`remain` 回傳設定容量值（前端視為無上限）。
  - 回傳物件新增 `past` 欄位；既有 `start`／`remain` 欄位語意不變。
- `GET /api/coaches/:id/availability` 新增查詢參數 `backfill=1`：
  - **僅當 `req.user?.is_admin` 為真才生效**（呼叫 `computeAvailableSlots` 帶 `includePast: true`）。
  - 非管理者帶 `backfill=1` 一律忽略，回傳正常未來清單。
  - 前端管理者一律帶 `backfill=1`，因此任一週都能正確顯示其中的過去時段。

### 3. 補登時段的呈現與彈窗（`coaches.js`）

- 過去時段卡（`past: true`）加「補登」小標籤與淡色樣式；不顯示「剩 1 名額」、不停用 1對2 選項（補登不受容量限制）。
- 點過去時段 → 開既有預約彈窗的**補登變體**：
  - 頂部橫幅：「補登模式（已發生課程，靜默記錄、不發通知、預設已付款）」。
  - **隱藏** 折扣碼欄位與循環預約區塊。
  - 欄位：顧客姓名、電話、課程型態（1對1／1對2）、**可編輯金額**、備註。
  - 金額預設 = 該型態標準單價（與現有單堂價來源一致），切換型態時更新；管理者可覆寫；允許 0。
  - 送出 → `POST /api/admin/bookings/backfill`。
- 未來時段點擊 → 維持現有正常預約流程（含折扣／循環／通知），不變。

### 4. 後端補登路徑（`bookingService.js` + `server.js`）

- 新增 `POST /api/admin/bookings/backfill`（`requireAdmin`）：
  - 驗證 `startAt` 格式（沿用 `START_AT_RE`）。
  - **強制 `startAt < now`**（伺服器端，未來時段一律 422／400，避免用補登路徑繞過未來容量限制）。
  - 驗證 `amount` 為整數且 `>= 0`；`sessionType ∈ {1on1, 1on2}`；`phone` 通過 `isValidPhone`。
  - 呼叫 `createBackfillBooking`，回 201。**不**呼叫 `syncBookingCreate`／`sendBookingConfirmation`。
- 新增 `createBackfillBooking({ coachId, startAt, name, phone, sessionType, amount, note, actorId })`：
  - `findOrCreateUserByPhone({ phone, name })`（沿用既有，含員工電話守門）。
  - `tx(() => ...)`：直接 `INSERT` 一筆 `status = 'confirmed'` 的 booking（`end_at = startAt + 60min`）；**跳過** `assertBookableTx`（不檢查重疊／容量）。
  - 設 `paid_at = now`、`paid_by = actorId`、`original_amount = amount`、`discount_amount = NULL`、`session_type`、`note`。
  - **不**發 LINE／Email、**不**建 Google 日曆、**不**套折扣碼、**不**產生 LINE 綁定碼。
  - 與 `createBookingCore` 的 `silent` 概念一致，但獨立成函式，避免污染正常預約路徑。

### 5. 安全與不變式

- 前端 `is_admin` 僅決定 UI；過去時段清單與補登寫入皆由 `requireAdmin` + 伺服器端 `startAt < now` 把關。
- 一般使用者偽造 `backfill=1` → 被忽略；直打補登端點 → 403。
- 未來預約路徑（`/api/public/bookings`、`computeAvailableSlots` 預設）**一字不改** → 零回歸風險。

### 6. 邊界情境

- 同日稍早時段：`weekOffset = 0`（今天起算）中「今天」已過的時段會以補登呈現，可補登今晨的課。
- 教練建檔前的過去週：自然無時段。
- 補登可重複／超量（依「完全不檢查」決策）。
- 金額 0：合法（贈課／特例），記為 `original_amount = 0`、已付款。

## 不在本次範圍

- 自由輸入任意（非班表規則）日期時間補登 — 列為未來可加。
- 補登紀錄的後台編輯／刪除沿用既有後台機制，本次不另做。

## 測試計畫

- **單元（availabilityService）**：`includePast=true` 對過去時段列出全部規則時段且不受容量排除；對未來時段行為與 `includePast=false` 相同；`includePast=false` 行為不變（回歸）。
- **單元（bookingService）**：`createBackfillBooking` 寫入 `status=confirmed`／`paid_at`／`paid_by`／`original_amount`／`session_type`；不觸發通知（spy／無副作用）；可重複／超量；`amount=0` 合法。
- **端點**：
  - 非管理者帶 `backfill=1` → 回正常未來清單（無 `past:true`）。
  - 非管理者直打 `POST /api/admin/bookings/backfill` → 403。
  - 管理者補登過去時段 → 201；補登未來時段 → 4xx。
  - 管理者補登成功後該預約出現在顧客 `/api/public/my` 歷史、狀態為已付款。
