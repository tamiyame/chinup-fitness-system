# 登錄預約週曆時間塊配色 — 設計規格

- 日期：2026-07-08
- 狀態：業主要求「像 Google 日曆一樣有顏色區分」——沿用 gcal 已拍板規則（PR #90）

## 目標

登錄預約週曆的一對一時間塊比照 Google 日曆配色：**管理者教練＝現行藍色**、**非管理者教練＝石墨灰**。不論檢視者是誰、單教練或全部教練模式都一致（灰＝非管理者的課，與 gcal 同一心智模型）。

## 做法

- **後端**（`coachCalendarService.js`）：`BK_COLS` 加 `JOIN users cu ON cu.id = c.user_id` 取 `cu.is_admin AS coach_is_admin`（weekBookings 與 weekAllBookings 兩支共用 BK_COLS，一處改）。附加欄位，零破壞。
- **前端**（`coach.js` 週格渲染）：`!b.coach_is_admin` → `.reg-bk` 加 modifier class `reg-bk-gray`。
- **樣式**（`style.css` reg 區塊）：`.reg-bk-gray` 底 `#e2e8f0`、字 `#475569`（呼應 gcal colorId 8 石墨灰、維持可讀性與 hover 行為）。
- **團課塊（.reg-gp）不動**（紫色維持；gcal 本來就不同步團課）。
- 拖曳改期、編輯彈窗等行為不受影響（邏輯靠 data-bk，樣式 class 純外觀）。

## 範圍外

- 每位教練不同色（業主在 gcal 配色時已選單一石墨灰，本次沿用）。
- 圖例列（兩色語意對管理者自明，YAGNI）。

## 驗證

- `tests/coach-week-all.test.js` 補斷言：week 回應 bookings 含 `coach_is_admin` 欄位且值正確（管理者教練 1／一般教練 0）。
- Playwright：全部教練模式下，非管理者教練的塊帶 `reg-bk-gray`、管理者的不帶；單教練模式同規則；0 pageerror。
