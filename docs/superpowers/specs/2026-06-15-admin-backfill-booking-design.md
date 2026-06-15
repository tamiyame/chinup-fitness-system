# 管理者於過去日期預約（解鎖「上週」按鈕）— 設計文件

- 日期：2026-06-15
- 分支：`feat/admin-backfill-booking`
- 狀態：已實作；草稿 PR #56；待業主煙霧驗收

> **設計修訂（2026-06-15）**：初版採「特製補登路徑」（靜默／預設已核對／不檢容量／可手動改價／獨立端點）。
> 業主後續決定「**整體功能與正常預約相同**，差別只在管理者可選過去日期，且折扣碼與循環預約皆可用」，
> 故改為下方的最終設計：**管理者用正常預約流程預約過去日期**，特製補登路徑已全數移除。

## 目標

預約頁（教練詳細頁）的「上週」按鈕目前對所有人鎖定，無法回看過去日期。需求：
**管理者登入後**可往前翻週、看到過去日期的時段，並對過去時段預約（用於校正或補登記顧客課程資料）。
**一般使用者**行為完全不變，仍不可回溯往前預約。

## 已確認的產品決策（最終）

「**完全比照正常預約，差別只在管理者可選過去日期**」：

1. **通知**：會發 LINE／Email 通知（與正常預約相同）。業主已知悉「對已發生課程也會發『預約成功』通知給顧客」。
2. **付款狀態**：走正常流程（1對1 為待核對；循環依 `markPaid` 勾選）。
3. **容量／重疊**：**照常檢查**（整點桶容量上限 + 同教練不重疊）。
4. **金額**：用系統單價＋折扣碼，**無手動改價**。
5. **折扣碼、循環預約**：與正常預約一樣可用。

## 名詞

- **過去時段**：開始時間早於「現在」的時段；由伺服器依時間 + `is_admin` 權威判定，不信任前端。

## 範圍（異動檔案）

- `public/coaches.js` — 「上週」解鎖（管理者）、查詢帶 `backfill=1`、過去時段卡加「補登」標籤；過去時段沿用**正常**預約彈窗。
- `src/services/availabilityService.js` — `computeAvailableSlots` 新增 `includePast`。
- `src/services/bookingService.js` — 循環函式（`previewRecurringBookings`／`createRecurringBookings`／`_occurrenceAvailable`）加 `includePast`。
- `src/server.js` — availability 加 `backfill` 參數；`/api/public/bookings` 與循環端點放行管理者過去日期。
- `public/style.css` — `.timeslot.slot-past` 樣式。
- 對應測試檔。

## 詳細設計

### 1. 前端週次解鎖（`coaches.js`）

- `const isAdmin = !!(getUser()?.is_admin)`（bootPublic 後）。
- `updatePrevDisabled()`：`btn.disabled = !isAdmin && weekOffset <= 0`（管理者「上週」永不 disabled）。
- `prev-week` 點擊：`if (isAdmin || weekOffset > 0)` 才減 `weekOffset`（管理者可變負、無下限）。
- `loadSlots()`：管理者時查詢帶 `&backfill=1`。
- 可回溯範圍不設上限；教練建檔前（早於班表規則 `effective_from`）的週自然無時段。

### 2. 可預約查詢加入「含過去」模式（`availabilityService.js` + `server.js`）

- `computeAvailableSlots({ ..., includePast = false })`：
  - `includePast = false`（預設）→ 行為與現狀**完全一致**。
  - `includePast = true` → **略過「過去／緩衝」時間過濾**；且對**過去日期**忽略班表規則的 `effective_from`（規則「建檔生效日」常晚於課程實際發生日 → 否則更早的過去日期會產不出時段、外觀像只能回幾週；仍尊重 `effective_to`）。容量／重疊／請假／外部忙碌判定與正常時段**完全相同**（即「比照正常、放行過去日期、過去班表全開」）。
  - 每筆回傳 `past = (start <= now)`（供前端顯示「補登」標籤）；`remain` 為真實剩餘容量。
- `GET /api/coaches/:id/availability` 加 `backfill=1`：僅當 `userFromToken(...)?.is_admin` 為真才帶 `includePast: true`；非管理者／匿名一律忽略。

### 3. 過去時段的呈現與彈窗（`coaches.js`）

- 過去時段卡加 `.slot-past` 樣式 + 「補登」字樣（淡琥珀虛線）。
- 點過去時段 → 開**正常**預約彈窗（折扣碼、循環預約對員工/管理者照常顯示；1對2 名額守門用真實 `remain`）。
- 送出 → 正常端點 `/api/public/bookings`（單筆）或 `/api/bookings/recurring`（循環）。

### 4. 後端放行管理者過去日期（`server.js` + `bookingService.js`）

- `POST /api/public/bookings`（匿名端點）：以可選 token 解析 `includePast = !!userFromToken(getTokenFromReq(req))?.is_admin`，傳入時段重驗 `svcComputeSlots`。管理者 → 過去時段在清單中 → 放行（容量仍由清單 `remain` + tx 內 `assertBookableTx` 檢查）；匿名／非管理者 → 過去時段不在清單 → 409 `slot_unavailable`。其餘流程（折扣／通知／待核對／gcal）皆正常。
- 循環 `preview`／`create`（`requireCoach`）：傳 `includePast: !!req.user.is_admin` → `_occurrenceAvailable` → `computeAvailableSlots`。管理者可排過去場次；非管理者教練維持未來限定。容量/重疊照常。
- **無**特製補登 service／端點（已移除）。

### 5. 安全與不變式

- 前端 `is_admin` 僅決定 UI；放行過去時段與過去預約寫入皆由伺服器端 `userFromToken(...)?.is_admin` / `req.user.is_admin` 把關。竄改 localStorage 無效（伺服器以真實 token 重判）。
- 容量／重疊在 route 重驗 + tx 內 `assertBookableTx` 雙層把關 → 管理者亦不可超量。
- `includePast=false`（預設）路徑邏輯不變 → 對所有既有呼叫端零回歸。

### 6. 邊界情境

- 同日稍早時段：`weekOffset = 0` 中「今天」已過的時段亦標記過去、可預約。
- 過去時段若已被預約（同教練重疊）→ 排除／重複預約回 409（容量/重疊照常）。
- 循環起始為過去：逐場照常驗證（過去場次受 includePast 放行、容量照常）。

## 不在本次範圍

- 自由輸入任意（非班表規則）日期時間 — 列為未來可加。
- 補登紀錄的後台編輯／刪除沿用既有後台機制。

## 測試計畫

- **單元（availabilityService）**：`includePast=true` 過去時段回傳且 `past:true`、`remain` 為真實值；同教練過去時段已被預約 → 排除（容量/重疊照常）；未來時段 includePast 不改變結果；`includePast=false` 行為不變（回歸）。
- **端點**：
  - 管理者 `backfill=1` → 過去 slot（`past:true`、`remain` 數值）；匿名／非管理者 `backfill=1` → 無過去時段。
  - 匿名用 `/api/public/bookings` 預約過去時段 → 409；管理者 → 201（待核對、出現在 `/api/public/my`、`paid=false`）。
  - 管理者重複預約同一過去時段 → 409（容量/重疊照常）。
  - 管理者循環預覽（過去起始）→ 首堂可建立。
