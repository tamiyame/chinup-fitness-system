# 登錄預約「全部教練」週曆：每位教練指定顏色 — 設計規格

- 日期：2026-07-08
- 狀態：業主明確指示（含 Google 日曆 24 色範本截圖；取代本檔第一版的灰階方案）

## 目標

登錄預約週曆**只在「全部教練」模式**下，把每位教練的一對一時間塊塗成該教練的指定色；顏色由**管理者在後台教練管理指定**，色卡採 **Google 日曆官方 24 色**。單教練模式與教練個人視角**不改**（維持現行藍色）。未指定顏色的教練在全覽中也維持現行藍色（＝「預設」）。

## 色卡（Google Calendar API 官方日曆色盤，依截圖兩列排序）

```js
// 第一列 13 色 + 第二列 11 色（名稱為 Google 官方色名）
export const COACH_COLORS = [
  '#AD1457', // Radicchio
  '#D81B60', // Cherry Blossom
  '#E67C73', // Flamingo
  '#D50000', // Tomato
  '#F4511E', // Tangerine
  '#EF6C00', // Pumpkin
  '#F09300', // Mango
  '#F6BF26', // Banana
  '#E4C441', // Citron
  '#C0CA33', // Avocado
  '#7CB342', // Pistachio
  '#0B8043', // Basil
  '#33B679', // Sage
  '#009688', // Eucalyptus
  '#039BE5', // Peacock
  '#4285F4', // Cobalt
  '#7986CB', // Lavender
  '#3F51B5', // Blueberry
  '#B39DDB', // Wisteria
  '#9E69AF', // Amethyst
  '#8E24AA', // Grape
  '#795548', // Cocoa
  '#616161', // Graphite
  '#A79B8E', // Birch
];
```

## 資料模型

- `coaches.color TEXT`（NULL＝預設）。schema.js CREATE TABLE 加欄位；connection.js 用既有 `addColumnIfMissing('coaches', 'color', 'TEXT')` 遷移既有 DB（Railway 開機自動套用）。

## 後端

- `coachService`：色卡常數 `COACH_COLORS` export；管理者更新教練的 service（PATCH `/api/admin/coaches/:id` 路徑）接受 `color`——值必須在 COACH_COLORS 內或 `null`/`''`（清除→NULL），否則 400 `invalid_color`。`GET /api/admin/coaches` 回傳含 `color`（現查詢若非 `SELECT *` 需補欄位）。
- `coachCalendarService` 的 `BK_COLS` 加 `c.color AS coach_color`（weekBookings／weekAllBookings 共用，一處改）。附加欄位零破壞。

## 前端

### 後台教練管理（admin.js `loadCoachMgmt`）

- 每列左側加一顆**顏色圓點鈕**（顯示現色；未指定顯示空心「預設」圈）。
- 點擊在該列下方展開色卡面板：24 色圓點（兩列排版比照截圖，當前色打勾）＋「預設」按鈕；點選 → `PATCH { color }`（預設送 `null`）→ toast → 重載列表。再點顏色鈕收合。

### 登錄預約週曆（coach.js）

- **僅 `isAll`（全部教練）模式**：`b.coach_color` 存在 → 該塊 inline `background` 用該色、文字白色（加 class `reg-bk-colored` 讓內部 `.reg-sub`（型態/教練名小字）改半透明白，維持對比）。
- 未指定色的教練、單教練模式、非管理者視角：完全不變。
- 團課塊（`.reg-gp`）不動（紫色＋「團課」標籤本身已是類型區分）。
- 拖曳改期／編輯彈窗行為不受影響（邏輯繫於 `data-bk`）。

## 範圍外

- Google 日曆同步端配色不變（PR #90/91 的「管理者預設＋非管理者石墨灰」照舊——兩邊用途不同：gcal 是「誰的課」二分、系統全覽是「哪位教練」多分）。
- 自訂色（非 24 色盤）、每客人配色。

## 測試

1. **service**（新 `tests/coach-color.test.js`，npm test 鏈）：PATCH color 合法值寫入；非法值（`#123456`、`red`）400 `invalid_color`；`null` 與 `''` 清除為 NULL；GET 回傳含 color；週資料（getCoachWeek all 模式）bookings 含 `coach_color` 且值正確、未設色為 NULL。
2. **Playwright**：後台指定王教練一個顏色 → 登錄預約全覽模式該教練塊帶該背景色、未設色教練塊維持預設樣式；切單教練模式 → 不帶色；0 pageerror。
