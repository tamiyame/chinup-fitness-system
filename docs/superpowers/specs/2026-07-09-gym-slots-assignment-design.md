# 駐場班表改「固定時段＋指派教練」（Gym Slots Assignment）設計

日期：2026-07-09
狀態：設計已確認，待實作
前作：`2026-07-09-shift-attendance-checkin-design.md`（駐場打卡與時薪整合，PR #94 已 merge）

## 背景與目標

館方的上班時段是固定的（如週三 09:00–11:00），需要的操作是「在時段裡安排教練」，而非「替每位教練各自維護班表」。後台設定模型從「教練 → 各自班表」翻轉為「**固定上班時段 → 指派教練**」：老闆先建立時段，再把教練加進去，教練直接打卡。

**核心不變式：打卡、出席快照、補登、註銷、薪資計算完全不動**——它們照舊讀 `coach_shifts`；本次改動只在後台設定層（時段實體＋指派展開）。採**純時段模式**：後台不再提供個別教練專屬班表入口，臨時例外用既有「補登自訂起訖」。

## 方案（已選 C：時段實體＋指派即展開）

- A（純前端虛擬時段）淘汰：空時段無法先於教練存在，違反「先設時段再加人」。
- B（完全正規化、廢 coach_shifts）淘汰：重焊剛驗證上線的核心，行為零增益。
- **C**：新增 `gym_slots` 表＋`coach_shifts.slot_id` 連結欄。指派＝在交易中自動展開一列 `coach_shifts`（複製時段參數）；時段修改連動更新旗下教練列。

## 資料模型

### `gym_slots`（新表，加入 `schema.js` 的 `SCHEMA`）

```sql
CREATE TABLE IF NOT EXISTS gym_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,          -- 'HH:MM'
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,      -- 'YYYY-MM-DD'
  effective_to TEXT,                 -- NULL = 持續有效
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);
```

### `coach_shifts.slot_id`（新欄）

雙軌（比照 `users.is_admin` 前例）：**全新 DB** 由 SCHEMA 的 `coach_shifts` CREATE TABLE 直接帶 `slot_id INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE` 欄（`gym_slots` 的 CREATE 置於 `coach_shifts` 之前）；**既有 DB** 用 `addColumnIfMissing('coach_shifts', 'slot_id', 'INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE')`（ALTER 加欄的 REFERENCES 實際具強制力——node:sqlite 實測：非法插入被拒、CASCADE 有效；service 層仍在交易中顯式連動，作為語意自我文件化與雙保險，不依賴單一層）。

### 語意（service 層，全部在 `tx()` 內）

| 操作 | 行為 |
|---|---|
| 建立時段 | INSERT `gym_slots`（驗證同 createShift：dow/時間/生效區間） |
| 加入教練 | 該教練已在此時段（有 `slot_id=? AND coach_id=?` 的列）→ 409 `coach_already_in_slot`；否則 INSERT `coach_shifts`（複製時段的 dow/起訖/生效起迄、掛 `slot_id`） |
| 移除教練 | DELETE 該列 `coach_shifts`（歷史出席已快照且 `shift_attendance.shift_id` ON DELETE SET NULL，帳不受影響；未來打不了卡＝移除目的） |
| 修改時段 | UPDATE `gym_slots` ＋ 同交易 UPDATE `coach_shifts` SET 同欄位 WHERE `slot_id=?`（歷史出席受快照保護） |
| 結束時段 | ＝修改時段填 `effective_to`（連動） |
| 刪除時段（誤建） | DELETE `gym_slots` ＋ 同交易 DELETE `coach_shifts` WHERE `slot_id=?`（顯式刪除，不依賴 DB CASCADE——見上） |

行為調整（最終審查）：checkIn 增加同日同起訖未註銷出席的冪等防護，杜絕移除→重加後重打卡的雙倍計薪。

### 既有資料歸組（開機冪等 migration，`connection.js`）

`slot_id IS NULL` 的 `coach_shifts` 按（`day_of_week`, `start_time`, `end_time`, `effective_from`, `COALESCE(effective_to,'')`）分組；每組 INSERT 一個 `gym_slots` 並回填該組所有列的 `slot_id`。偵測訊號＝存在 `slot_id IS NULL` 的列 → 重跑 no-op。prod 甫上線可能無資料，dev/demo 有；此步保證任何 DB 狀態無痛升級。

## API（全部 `requireAdmin`；service 函式集中 `shiftService.js`）

| 端點 | 用途 |
|---|---|
| `GET /api/admin/slots` | 時段清單（`day_of_week, start_time` 升冪），每筆內嵌 `coaches: [{coachId, displayName, shiftId}]` |
| `POST /api/admin/slots` | 建立時段 `{day_of_week, start_time, end_time, effective_from, effective_to?}` |
| `PATCH /api/admin/slots/:id` | 修改起訖／生效起迄（`effective_to: null` 清空；連動教練列）。**不允許改 `day_of_week`**——要換星期＝結束（或刪除）後重建，避免歸屬混淆 |
| `DELETE /api/admin/slots/:id` | 刪除誤建（連動刪教練列） |
| `POST /api/admin/slots/:id/coaches` | `{coach_id}` 指派（教練不存在 404、已在時段 409） |
| `DELETE /api/admin/slots/:id/coaches/:coachId` | 移除指派（不在時段 404 `coach_not_in_slot`） |

既有 `/api/admin/shifts` 端點**保留不拆**（向後相容、既有測試照跑），UI 不再使用。新錯誤碼：`slot_not_found`、`coach_already_in_slot`、`coach_not_in_slot`；時段欄位驗證重用既有 `invalid_day_of_week`／`invalid_time_range`／`invalid_effective_range`。

## 後台 UI（薪資頁籤「駐場出勤」內；打卡參數與 QR 區不動）

原「教練時薪與班表」拆成兩塊：

1. **上班時段**：時段卡片清單——標題「週三 09:00–11:00・自 2026-07-09（｜至 YYYY-MM-DD）」；已指派教練姓名 chips（chip ✕ 兩段式確認移除）；「加入教練」下拉（僅列尚未在此時段的啟用教練，選取即指派）；結束日 date 欄＋儲存；刪除（兩段式）。底部新增時段表單：星期／起訖 time／生效日（預設今天）＋「新增時段」。
2. **教練時薪**：一行一位啟用教練（姓名＋時薪 input＋儲存），沿用既有 hourly-rate PATCH。

「補登出席」區塊不動（按教練＋日期找當日班表，指派展開的列天然適用）。互動慣例沿用：mutation 後 `loadShiftAdmin()` 全量重繪、兩段式確認鈕、`escapeHtml` 所有姓名插值、繁中文案。

## 測試

- **service**（`tests/shift-service.test.js` 擴充或新檔 `tests/gym-slots.test.js`）：建立時段驗證；指派展開列欄位正確；重複指派 409；移除刪列且出席鏈不斷（快照仍在、`shift_id` 變 NULL）；修改時段連動教練列、歷史出席不變；刪除時段連動刪列；歸組 migration：同參數多教練列併一時段、重跑 no-op。
- **API**（`tests/slot-admin-api.test.js`）：六端點權限／形狀／錯誤碼全覆蓋。
- **既有全部測試保持綠燈**＝以測試證明打卡與薪資核心未被觸動。

## 上線

merge → Railway 自動部署 → 開機 migration 自動把既有教練班表歸組成時段 → 老闆直接用時段卡片管理。無需人工資料搬遷。

## 刻意不做（YAGNI）

- 個別教練專屬班表 UI（純時段模式；臨時例外走補登自訂起訖）。
- 時段容量上限、時段重疊檢查（管理者自理；打卡端多列命中取最早開始，既有行為）。
- `/api/admin/shifts` 端點退場（保留相容）。
- 打卡端、出席、薪資任何改動。
