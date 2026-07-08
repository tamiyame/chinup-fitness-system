# 駐場打卡與時薪整合（Shift Attendance Check-in）設計

日期：2026-07-09
狀態：已與業主端需求確認，待實作

## 背景與目標

三位教練會在固定的時間到館駐場，按時薪計酬。現況是教練手寫出席時數、老闆月底人工加總乘時薪，費工且無在場佐證。目標：教練到場「掃牆上 QR code → 按一下」即完成出席登記，系統依固定班表自動計時數，月結直接併入後台既有「薪資計算」頁籤。

## 已確認的需求決策

1. **對象**：chinup 既有教練（已有帳號與登入能力），時薪駐場與課薪並存。
2. **在場佐證等級**：防「人不在場卻遠端打卡」。GPS 定位驗證即可；不防蓄意假定位、不防代打（同事拿走本人手機兼登入帳號才可能代打，超出本次威脅模型）。
3. **計時規則**：班表時段制——後台預設固定週班表（如週三 09:00–11:00），到場在窗口內打一次卡即計入該時段完整時數；遲到早退等例外由老闆後台調整。
4. **呈現**：併入後台「薪資計算」頁籤，同一期別口徑（前月 6 日～當月 5 日），同一份 CSV。
5. **時薪**：每位教練各自一個時薪欄位，後台可調。
6. **方案**：現場固定列印 QR code 作為入口＋打卡當下 GPS 在場驗證（自建、零硬體、零月費）。動態 QR 平板（佐證更硬但要養設備）與現成打卡服務（與薪資頁籤不整合）皆評估後不採。

## 資料模型

### `coaches.hourly_rate`（新欄位）

整數（元/小時），`addColumnIfMissing('coaches', 'hourly_rate', 'INTEGER')`。`NULL` = 不參與駐場時薪，薪資頁籤不顯示該教練的駐場欄位。比照既有薪資參數「即時制」哲學：計算當下取現值、不存歷史快照，調薪在期別交界操作。

### `coach_shifts`（新表：固定週班表）

鏡射 `coach_availability_rules` 形狀（src/db/schema.js:147）：

```sql
CREATE TABLE IF NOT EXISTS coach_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,          -- 'HH:MM'
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,      -- 'YYYY-MM-DD'
  effective_to TEXT,                 -- NULL = 持續有效
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);
```

一列＝一個連續時段（09:00–11:00 就是一列 2 小時，不拆成兩個整點）。支援預排未來變更：「結束班表」＝填 `effective_to`，而非刪列；刪除保留給誤建。

### `shift_attendance`（新表：出席紀錄）

一列＝某教練某天出席某時段。起訖與時數**快照**寫入——班表日後改動不影響已發生的紀錄。

```sql
CREATE TABLE IF NOT EXISTS shift_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id),
  shift_id INTEGER REFERENCES coach_shifts(id) ON DELETE SET NULL,
  work_date TEXT NOT NULL,           -- 'YYYY-MM-DD'（台北牆鐘）
  start_time TEXT NOT NULL,          -- 快照
  end_time TEXT NOT NULL,            -- 快照
  hours REAL NOT NULL,               -- 快照（(end-start)/60，如 2.0）
  source TEXT NOT NULL CHECK (source IN ('checkin','manual')),
  checked_in_at TEXT,                -- 打卡時刻（manual 為 NULL）
  lat REAL, lng REAL, accuracy REAL, distance_m INTEGER,  -- GPS 佐證留檔
  created_by INTEGER REFERENCES users(id),  -- manual 補登者
  voided_at TEXT,                    -- 註銷（軟刪，薪資排除、紀錄保留）
  voided_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(coach_id, work_date, shift_id)   -- 同時段防重複打卡
);
CREATE INDEX IF NOT EXISTS idx_shift_attendance_date ON shift_attendance(work_date);
```

- `UNIQUE` 中 `shift_id` 為 NULL 時（manual 自訂時段）SQLite 不視為重複，故補登加班可同日多筆；掃碼路徑另在交易內以查詢防重，回應冪等。
- 註銷後若要重打卡：同一 `(coach_id, work_date, shift_id)` 已有列（含已註銷）即擋——需要重登時由管理者補登，避免 UNIQUE 衝突與帳目混淆。

### `app_settings` 新增鍵（沿用 getSetting/setSetting 與既有 settings PATCH 驗證清單模式）

| 鍵 | 預設 | 說明 |
|---|---|---|
| `checkin_lat` | （空） | 健身房緯度（貼 Google Maps 座標） |
| `checkin_lng` | （空） | 健身房經度 |
| `checkin_radius_m` | `150` | 允許打卡半徑（公尺），涵蓋室內 GPS 誤差 |
| `checkin_window_before_min` | `30` | 時段開始前多少分鐘可開始打卡 |

座標未設定時，打卡端點回明確錯誤（`checkin_not_configured`），前端顯示「請通知管理者完成打卡設定」。

## 打卡流程（教練端）

新增獨立輕量頁 `/checkin`（`public/checkin.html` + `checkin.js`，比照既有靜態頁模式：共用 fetch helper 與樣式 token）。現場貼固定列印 QR code 指向此頁。

1. 開頁檢查既有 session；未登入導 `login.html` 並於登入後導回 `/checkin`（session 7 天效期，教練約每週重登一次）。
2. `GET /api/coach/checkin/today` 取得：今天班表時段與各自狀態（已打卡 ✓／可打卡／尚未到窗口／已結束）、本期已累計時數（口徑＝`defaultPeriod()` 的當前期別，未註銷紀錄）。
3. 按「到場打卡」→ `navigator.geolocation.getCurrentPosition` → `POST /api/coach/checkin {lat, lng, accuracy}`。
4. 後端驗證順序（`requireCoach` + 既有 `rateLimit`；**不走 `resolveCoach` 代選**——打卡永遠記本人，管理者代登記一律走後台補登留稽核）：
   1. 有教練檔案；
   2. Haversine 距離（打卡座標 vs `checkin_lat/lng`）≤ `checkin_radius_m`；
   3. 以 `nowLocal()`（台北牆鐘，Dockerfile `TZ=Asia/Taipei`）找今天 `day_of_week`、生效區間涵蓋今天的班表列，且當下時間 ∈ [start − `checkin_window_before_min` 分, end]；多列同時命中取最早開始者；
   4. 該 `(coach, work_date, shift)` 尚無出席列；
   5. 寫入 `shift_attendance`（`source='checkin'`，快照起訖／時數，存 GPS 佐證與 `distance_m`）。
5. 成功回應含該時段資訊，頁面顯示「已記錄：週三 09:00–11:00（2 小時）」。

### 錯誤處理

| 情境 | 行為 |
|---|---|
| 拒絕定位權限 | 前端顯示開啟定位的簡短引導（不能打卡） |
| 距離超出半徑 | `403 not_at_gym`，顯示「你似乎不在館內（距離約 X 公尺）」，不寫入 |
| 當下無可打卡時段 | `409 no_active_shift`，顯示今天班表與各窗口時間 |
| 同時段重複打卡（既有紀錄未註銷） | 冪等：回 200 與既有紀錄，顯示「本時段已打卡 ✓」 |
| 同時段已有「已註銷」紀錄 | `409 attendance_voided`，顯示「此時段紀錄已被註銷，請聯繫管理者補登」 |
| 座標未設定 | `503 checkin_not_configured` |
| 非教練帳號 | 既有 `requireCoach` 401/403 |

`accuracy` 存檔備查、不設硬門檻。

## 後台（併入「薪資計算」頁籤）

1. **期別報表擴充**：`computePayroll`（src/services/payrollService.js）為每位教練加 `shift: { hours, rate, salary, details[] }`；`totals` 加 `shiftHours`、`shiftSalary` 並計入 `total`。期別邊界：`work_date >= displayStart AND work_date <= displayEnd`（含端點），排除 `voided_at IS NOT NULL`。`salary = Math.round(hours × hourly_rate)`（與既有捨入慣例一致）。明細展開列出席清單：日期、時段、時數、來源（掃碼/補登）、打卡時刻、GPS 距離。CSV（admin.js 既有 BOM 慣例）加三欄：駐場時數／時薪／駐場薪資。`hourly_rate IS NULL` 的教練不顯示駐場欄位（有出席紀錄但無時薪者顯示提醒，薪資以 0 計）。
2. **駐場設定區塊**：各教練時薪編輯；班表管理（星期、起訖時間、生效起迄；「結束班表」＝填結束日）；`checkin_*` 三參數與座標編輯（沿用既有 settings PATCH 驗證清單）。
3. **例外調整**（均 `requireAdmin`）：
   - 補登：選教練＋日期＋（套用該日班表時段 或 自訂起訖），`source='manual'`、記 `created_by`；
   - 註銷：填 `voided_at/voided_by`，薪資排除、留檔可查。

## API 一覽

| 端點 | 守門 | 用途 |
|---|---|---|
| `GET /api/coach/checkin/today` | requireCoach | 今天班表＋各時段狀態＋本期累計時數 |
| `POST /api/coach/checkin` | requireCoach + rateLimit | GPS 打卡 |
| `GET /api/admin/shifts?coachId=` | requireAdmin | 班表列表 |
| `POST /api/admin/shifts` | requireAdmin | 新增班表列 |
| `PATCH /api/admin/shifts/:id` | requireAdmin | 修改／填結束日 |
| `DELETE /api/admin/shifts/:id` | requireAdmin | 刪除（誤建用） |
| `PATCH /api/admin/coaches/:id/hourly-rate` | requireAdmin | 時薪設定 |
| `POST /api/admin/attendance` | requireAdmin | 補登 |
| `POST /api/admin/attendance/:id/void` | requireAdmin | 註銷 |
| `GET /api/admin/payroll` | requireAdmin | （既有）回應擴充 shift 區塊 |
| `PATCH /api/admin/settings` | requireAdmin | （既有）驗證清單加 `checkin_*` 鍵 |

新邏輯集中於新 service `src/services/shiftService.js`（班表比對、打卡、補登、註銷、期別彙總），`payrollService.computePayroll` 呼叫其彙總函式。

## 測試

比照既有慣例：`assert/strict` 腳本、遠年份資料 namespace、串進 `package.json` 的 `test`／`test:api` 鏈。`npm test` 會清洗 `data/app.db`，測後需 re-seed。

- `shift-service.test.js`：窗口邊界（開始前 30 分、結束時刻、生效起迄、跨週界）、多時段同日、重複打卡冪等、快照語意（改班表不影響既有出席）、註銷排除薪資、補登（套班表／自訂）、期別彙總含端點日。
- `checkin-api.test.js`：未登入 401／非教練 403、座標未設定 503、距離超出 403、無時段 409、成功 200、重複 200 冪等、rate limit。
- `payroll-service.test.js` 擴充：shift 併入 per-coach 與 totals、`hourly_rate` NULL 行為、CSV 口徑由前端測不到則以 API 資料驗證。
- migration 冪等：新表／新欄重跑 no-op。

## 上線步驟

1. Merge → Railway 自動部署（migration 皆 `addColumnIfMissing`／`CREATE TABLE IF NOT EXISTS`，非破壞性）。
2. 老闆後台：填座標／半徑（預設 150m）／三位教練時薪／各自班表。
3. 產生列印用 QR code（指向 `https://chin.up.railway.app/checkin`）貼於館內。
4. 三位教練手機各登入一次（此後約每週重登一次）。

## 刻意不做（YAGNI）

- 打卡即時 LINE 通知老闆／每日彙整推播（後台隨時可查）。
- 拍照佐證、動態 QR（防代打等級，未來要升級再加；資料模型已相容——佐證欄位可擴充）。
- 上下班起訖打卡、遲到早退自動扣時（班表時段制＋老闆例外調整已覆蓋）。
- 時薪歷史快照（即時制，與既有薪資參數一致）。
