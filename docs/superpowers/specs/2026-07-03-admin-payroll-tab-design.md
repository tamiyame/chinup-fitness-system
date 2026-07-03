# 後台「薪資計算」頁籤 — 設計規格

- 日期：2026-07-03
- 狀態：已與業主確認計算規則（整月回溯級距／團課另計固定比例／參數可調／即時報表）

## 目標

在管理後台新增「薪資計算」頁籤：管理者選擇薪資週期（上月 6 號～當月 5 號），系統依每位教練在預約行事曆登載的會員堂數 × 各會員每堂實收單價計算應發薪資，並依累積堂數套用級距抽成。團體課另計、固定比例抽成。純即時報表（不存結算快照），附 CSV 匯出。

## 名詞與週期定義

- **期別（period）**：以「結算月」命名，格式 `YYYY-MM`。
  - 範圍 = 前一月 6 號 00:00（含）～ 當月 6 號 00:00（不含）。
  - 例：`2026-07` 期 = `2026-06-06T00:00` ≤ start_at < `2026-07-06T00:00`（即 6/6～7/5）。
- **預設期別**：今天日期 ≤ 5 號 → 結算月 = 當月；≥ 6 號 → 結算月 = 次月。（例：7/3 → 2026-07 期；7/10 → 2026-08 期）
- `bookings.start_at`、`course_sessions.start_at` 均為 `YYYY-MM-DDTHH:MM:00` 本地時間字串，區間用字串比較（比照 `coachCalendarService.js` 現有查詢模式）。

## 計算規則

### A. 一對一／一對二（教練預約行事曆）

- **納入**：`bookings.status = 'confirmed'` 且 `start_at` 落在期間內。已取消不算。方案登錄與散客預約都算。
- **每堂實收** = `COALESCE(original_amount, 0) − COALESCE(discount_amount, 0)`，下限 0。
  - 1對1 與 1對2 一視同仁：都以該筆 booking 的實收計（1對2 整堂如 2000，一樣減折扣）。
  - 方案登錄的 booking 建立時已寫入 `original_amount = round(方案金額 ÷ 總堂數)`，直接沿用。
- **無單價堂**：`original_amount IS NULL`（方案建立時金額留空）→ 以 0 元計入堂數與級距，另計 `unpriced` 堂數供前端顯著警告。
- **級距（整月回溯）**：當期堂數 N ≤ 門檻（預設 40）→ 全部套低比例（預設 50%）；N > 門檻 → **全部堂數**套高比例（預設 60%）。
- **一對一薪資** = `Math.round(期間實收總額 × 適用% ÷ 100)`。
- **未完課提示**：期間內 `start_at > now` 的堂數照算，另計 `future` 堂數供前端提示「本期尚有 N 堂未上課」。

### B. 團體課（另計，不併入級距門檻）

- **場次納入**：`course_sessions.coach_id = 該教練` 且 `status != 'cancelled'` 且 `start_at` 落在期間內。
- **每場營收** = Σ 該場 `registrations.status = 'confirmed'` 且 `on_leave = 0` 的報名者之 `COALESCE(amount_due, 範本 price_per_session)`。
  - 請假（`on_leave = 1`）不列入（教練實際未教到該員）。
  - `amount_due` 為報名當下實付單價（含折扣攤分）；NULL（舊資料）以範本定價補。
- **團課薪資** = `Math.round(期間團課營收總額 × 團課% ÷ 100)`，固定比例（預設 50%），不看堂數級距。

### C. 應發合計

`應發薪資 = 一對一薪資 + 團課薪資`。全店總計 = Σ 各教練。

## 可調設定（app_settings）

| key | 預設 | 驗證 |
|---|---|---|
| `payroll_tier_threshold` | `40` | 整數 0–999 |
| `payroll_pct_low` | `50` | 整數 0–100 |
| `payroll_pct_high` | `60` | 整數 0–100 |
| `payroll_group_pct` | `50` | 整數 0–100 |

- schema.js `INSERT OR IGNORE` 四筆預設值（比照既有 settings key）。
- 擴充既有 `GET /api/admin/settings` 回傳與 `PATCH /api/admin/settings` 驗證寫入（沿用「全欄位驗證通過才寫入」模式）。

## API

### GET `/api/admin/payroll?period=YYYY-MM`（requireAdmin）

- `period` 缺省 → 用預設期別；格式不合 → `400 invalid_period`。
- 回傳（一次含彙總＋逐堂明細；小店規模單次回傳即可，不做懶載入）：

```jsonc
{
  "period": "2026-07",
  "range": { "start": "2026-06-06", "end": "2026-07-05" },   // 顯示用（含端點）
  "settings": { "threshold": 40, "pctLow": 50, "pctHigh": 60, "groupPct": 50 },
  "coaches": [
    {
      "coachId": 1, "displayName": "王教練", "isActive": 1,
      "oneOnOne": {
        "sessions": 45, "revenue": 45000, "unpriced": 2, "future": 3,
        "pct": 60, "salary": 27000,
        "details": [
          { "bookingId": 9, "startAt": "2026-06-10T10:00:00", "memberName": "陳小姐",
            "sessionType": "1on1", "source": "package",          // package | walkin
            "amount": 1000, "unpriced": false, "future": false }
        ]
      },
      "group": {
        "headcount": 30, "revenue": 12000, "pct": 50, "salary": 6000,
        "details": [
          { "sessionId": 5, "startAt": "2026-06-12T19:00:00", "courseName": "綜合體能",
            "headcount": 6, "revenue": 2400 }
        ]
      },
      "total": 33000
    }
  ],
  "totals": { "oneOnOneSessions": 0, "oneOnOneRevenue": 0, "oneOnOneSalary": 0,
              "groupHeadcount": 0, "groupRevenue": 0, "groupSalary": 0, "total": 0 }
}
```

- **教練清單**：`is_active = 1` 的全列（含 0 堂）；停用教練僅在期間內有資料時列出並標示「已停用」。排序沿用教練列表慣例（`created_at`）。
- 新增 `src/services/payrollService.js` 承載計算（`computePayroll({ period })`）；server.js 只做參數驗證與轉發。

## 前端（admin.html + admin.js）

1. **頁籤**：`#admin-tabs` 尾端（LINE 管理之後）加 `<button data-atab="payroll">薪資計算</button>`；新 `#apanel-payroll` panel。開機隨其他 panel 一次載入（比照 admin.js 現有慣例，切頁籤只切換顯示）。
2. **期別導覽列**：`◀ 上一期｜2026年7月期（06/06 – 07/05）｜下一期 ▶`＋「本期」按鈕。切換即重新抓 API。
3. **抽成設定卡**（可收合）：門檻堂數、低%、高%、團課% 四欄＋儲存（PATCH settings 後重算重繪）。
4. **教練彙總表**（`.data-table`）：
   - 欄：教練｜1對1堂數｜1對1實收｜適用%｜1對1薪資｜團課人次｜團課實收｜團課薪資｜**應發合計**。
   - 底部全店總計列。
   - 列上警示徽章：`N 堂無單價`（琥珀色）、`N 堂未上課`（灰色）。
   - 手機 <768px 沿用既有 `.data-table` 卡片化 RWD 模式（cell class＋`::before` 標籤；**CSS 放 admin.html inline** 以蓋過 overlay，比照 PR #76 教訓）。
5. **展開明細**：點教練列展開子區塊——一對一逐堂（日期時間、會員、型態 1對1/1對2、來源 方案/散客、實收，無單價/未上課標記）＋團課逐場（日期、課名、人數、營收小計）。再點收合。
6. **CSV 匯出**：前端由已載入資料產生（免新端點），內容 = 彙總表（每教練一列＋總計列），檔名 `薪資_YYYY-MM.csv`，加 UTF-8 BOM（Excel 相容）。

## 測試（node:test，比照既有 service/API 測試風格）

1. 期別邊界：6/5 23:00 不算入 7 月期、6/6 00:00 算、7/5 任意時刻算、7/6 00:00 不算。
2. 級距：恰 40 堂 → 50%；41 堂 → 全部 60%（整月回溯）。
3. 取消預約排除；折扣正確相減（含 1對2 折扣）；方案登錄單價（amount÷total_sessions）流入計算。
4. 無單價：以 0 計、堂數與 unpriced 正確。
5. 團課：只計 confirmed 報名、排除 on_leave、排除 cancelled 場次、amount_due NULL 回退範本價、固定 groupPct 不受級距影響。
6. 設定：GET 回傳預設值；PATCH 驗證（越界 400）與寫入後重算生效。
7. 權限：未登入/非管理者 401/403。

## 明確不做（YAGNI）

- 結算存檔／薪資單歷史（純即時報表；業主已確認）。
- 團課堂數併入級距門檻（業主確認團課另計固定比例）。
- 底薪、獎金、勞健保等其他薪資項目。
- 逐堂明細 CSV（v1 先彙總；明細可於頁面展開檢視）。
