# /coaches.html UX 重新設計

**Date**: 2026-05-15
**Author**: brainstorm with user
**Scope**: front-end `public/coaches.html` + `public/coaches.js` + `public/style.css`，後端新增 1 個 read-only endpoint
**Files touched**: `public/coaches.html`、`public/coaches.js`、`public/style.css`、`src/server.js`、`src/services/bookingService.js`（新增一個查詢 helper）

---

## 1. 動機

User 從 mobile 截圖指出 `/coaches.html` 教練卡片爆寬到畫面外，順帶要求重新設計這個頁面的 UX。Brainstorm 確認後決定走「serve 新客 + 老客」雙場景，並以「老客 fast re-book」當主軸提升回流體驗。

延伸發現：

* 既有 bug：`<button class="card flex…">` 在 grid cell 裡因 `<button>` 預設 `min-width: min-content`（含 specialty 長字串）撐爆寬度，內層 `<div class="min-w-0 truncate">` 也救不回來
* 空 avatar 用 `👤` unicode 在白色圈圈裡視覺薄弱，跟有照片的教練（如阿莫教練）視覺權重落差大、看起來像「資料不全」
* `bio` 欄位在 schema 已存在多月但前端從未使用
* `specialty` 長字串目前是單行 `truncate`，會在中間裁掉（如「肌力與體能訓練 / 運動表現訓練 / 運動能力檢測與訓練諮詢」被截斷）

這次一次處理。

## 2. 設計決策（brainstorm 已逐項與 user 確認）

### 2.1 頁面結構

```
[navbar 不變]
[<h1>選擇教練</h1>]

[section: 你最近的教練]                 ← 只對 user 角色 + 有預約紀錄顯示
  └─ pinned card（預設展開）

[section: 全部教練]                     ← 永遠顯示（含「最近的那位」也再次出現）
  └─ coach card × N（accordion, 一次一張展開）
```

`view-detail` 與 `view-confirm` 兩個既有 view **完全不動**，只重做 `view-list`。

### 2.2 「你最近的教練」section

* **顯示條件**：登入者 role = `user`，且 `bookings` 表有至少一筆 `user_id = me AND status != 'cancelled'` 的 1-on-1 booking
* **資料來源**：上述條件下 `ORDER BY session_date DESC, start_time DESC LIMIT 1` 取那筆 booking 的 `coach_id`
  * 註：「最後一筆」**不分過去或未來** —— 未來已預約的也算最近，因為老客往往是「下週還要一堂、先看看再多預約一個」
  * 已 cancelled 的 booking 完全排除
* **預設展開**：頁面載入即可見 bio + slot chips + 「預約 XX 教練 →」按鈕（zero click 可預約）
* **「X 天前」badge**：以那筆 booking 的 `session_date` 為基準算 `Math.floor((today - session_date) / 86400)` 天；若為負值（未來預約）顯示「X 天後」
* **黃色 accent**：pinned card 邊框與 expand 區延伸用 `#fcd34d`（與 `.badge-waitlisted` 的琥珀同族色，視覺上代表「特別」）
* **avatar**：與全部教練 list 同款邏輯（見 2.4）
* **role = `admin` / `coach` / `owner`、或 user 無預約紀錄**：整個 section 完全隱藏（連 `<h2>你最近的教練</h2>` 都不渲染）

### 2.3 「全部教練」section

* `<h2>全部教練</h2>`（新增）
* `/api/coaches` 結果原封展示（已照 `sort_order ASC, id ASC`）
* **每張卡片預設收合**：avatar + display_name + specialty(line-clamp-2) + chevron `▾`
* **Accordion**：點任一張展開時，先把目前展開的那張收起（client-side state；單一 `currentlyExpandedId`）。點擊整張卡片（包含 chevron、avatar、name 任一點）= 切換展開狀態；同 ID 再點一次 = 收起，`currentlyExpandedId = null`
  * 「你最近的教練」那張預設展開時 = `currentlyExpandedId = recent_coach_id`；user 點下面任一張 → top 那張收起、下面那張展開
* **展開內容**：與 top card 同款（bio + slot chips + 「預約 XX 教練 →」按鈕）
* **slot fetch**：lazy。展開該張時才 fire `/api/coaches/:id/availability?from=today&to=today+7d`；用 in-memory `Map<coachId, slotsArray>` cache，二次展開同一張不重抓（cache 不過期，頁面 reload 自然清空 —— 對小規模、低頻次的場景足夠）
* **不含 filter、search、specialty chip 分類**（已確認）

### 2.4 共用 card 元件設計

| 元素 | 邏輯 |
|------|------|
| Avatar | `avatar_path` 有值 → `<img>`；沒值 → `<div>` + display_name 第 1 個字元（中文姓氏或全名首字）在 `slate-200` 圓圈內、深色字 |
| Name | `font-weight: 700, size: 14px`，不 truncate |
| Specialty | `line-clamp-2`（CSS：`-webkit-line-clamp: 2; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden`）。`null` 或空字串 → 整行省略 |
| Chevron | `▾` 灰色，點擊整張卡片切換展開狀態 |
| Pinned 加飾（僅 top section）| 卡片 + expand 區都 border-color `#fcd34d`，背景 `#fffefb` |

展開後內容：

| 元素 | 邏輯 |
|------|------|
| Bio | `line-clamp-3` 截尾。`null` / 空字串 → 整段省略，直接跳 slot 區 |
| Slot label「最近可預約」| 永遠顯示，灰底小字 |
| Slot chips | 取未來 7 天內 distinct slot（最早 **最多** 3 個，依時間升冪），每 chip 顯示 `MM/DD 週X HH:MM`（用 `app.js` 既有 `fmtDate` + `dow` helper 合併產生，如 `05/19 週二 10:00`）；無論前 3 個還是不足 3 個，**永遠**在最後加一個「看更多 →」chip 跳 detail view。chips 本身**顯示用**，點擊不做任何事（不跳特定 slot 確認頁）—— 預約動作集中在底下 `預約 XX 教練 →` 按鈕，避免多條進入點增加實作複雜度。|
| Slot 空狀態 | 未來 7 天無可預約 slot（陣列長度 0）→ chip 區整段換成「目前無可預約時段」灰字，**不顯示**任何 chip（包括「看更多」）。`預約 XX 教練 →` 按鈕仍渲染（user 可跳 detail 看更遠週次） |
| Book 按鈕 | `<a href="/coaches.html#detail-${id}">預約 XX 教練 →</a>` 跳既有 `view-detail`（同 page 內 view 切換）；slot 空時依然存在（讓 user 跳去看更遠週次） |

### 2.5 既有 bug 一併修

新 markup 用 `<div role="button" tabindex="0" data-coach-id="…" class="ccard">…</div>` 取代 `<button class="card flex…">`，繞開 `<button>` 預設 `min-content` 行為。同步：

* 鍵盤可及性：`Enter` / `Space` 觸發展開（跟 `<button>` 行為一致），呼叫同一個 handler
* 不再 `flex` + grid 混用：list container 改純 `flex flex-col gap-2`（不用 grid），因為 mobile 永遠 1 欄、desktop ≥768px 也維持 1 欄即可（資訊密度足夠，2-col 反而讓 expand panel 看起來不平衡）

## 3. 後端變更

### 3.1 新 endpoint `GET /api/my/recent-coach`

* **路徑**：`src/server.js` 新增一行 route，要 `requireUser`（非 user role 直接 403 或回 `{ coach: null }`，後者前端較好處理 —— **採後者**：role !== 'user' 仍回 200 + `{ coach: null }`，讓前端統一以「null = 隱藏 section」邏輯處理）
* **回應**：
  ```json
  {
    "coach": { "id": 2, "display_name": "阿莫教練", "specialty": "中高齡訓練...", "bio": "…", "avatar_path": "…" } | null,
    "last_session_date": "2026-05-03" | null,
    "days_ago": 12 | null
  }
  ```
* **查詢**：在 `src/services/bookingService.js` 新增 helper：
  ```js
  const getMostRecentNonCancelledBookingStmt = db.prepare(`
    SELECT b.coach_id, b.session_date, c.id, c.display_name, c.specialty, c.bio, c.avatar_path
    FROM bookings b
    JOIN coaches c ON c.id = b.coach_id
    WHERE b.user_id = ?
      AND b.status != 'cancelled'
      AND c.is_active = 1
    ORDER BY b.session_date DESC, b.start_time DESC
    LIMIT 1
  `);
  ```
  * `c.is_active = 1` 過濾：教練被停用 → 視同無紀錄
* **`days_ago` 計算**：server-side 用 `Math.floor((todayMs - sessionDateMs) / 86400000)`；未來預約值為負（前端負值改顯示「X 天後」）

### 3.2 沒有 schema 變更

`bookings`、`coaches` 表都已有需要的欄位。Phase 1 + 2 + 3C 已建立的索引足夠（`bookings(user_id, status)` 含 covering case；若效能有疑可在後續觀察期加 `(user_id, status, session_date DESC)` composite，**這個 PR 不加**）。

## 4. 影響檔案

| 檔案 | 變更 |
|------|------|
| `public/coaches.html` | `view-list` 區塊完全重寫；`view-detail` / `view-confirm` 不動；navbar 不動 |
| `public/coaches.js` | `loadCoachList` 重寫；新增 accordion state、slot 抓取與 cache、recent-coach 抓取與 render；`openCoach` 等 detail-view 函式不動 |
| `public/style.css` | 新增 `.ccard`、`.ccard-pinned`、`.ccard-expand`、`.slot-chip`、`.ccard-avatar-fallback` 等 class 族群（約 50 行）；既有 `.card` 與 `.section-title` 不動（其他頁面還用） |
| `src/server.js` | 新增 1 個 route handler |
| `src/services/bookingService.js` | 新增 1 個 prepared statement + 1 個 export function `getMostRecentCoachForUser(userId)` |

預估 ~250 行加 / ~80 行刪。

## 5. 不在 scope

* `view-detail`（教練詳情頁的 slot grid + week 導覽 + 確認預約頁）—— 既有 UX 維持不動
* `coaches` 表 schema、`specialty` 字串結構、`bio` 編輯介面（admin / coach 後台輸入 bio 的 UI 若還沒有，屬另一個 PR）
* 全頁 filter / search / 分類（user 確認都不要）
* 多名「最近教練」（user 確認只 pin 1 位）
* admin 端「sort_order」管理介面 —— 既有 admin 後台已可改
* `view-detail` 本身的 UX 改進（slot grid 視覺、確認頁文案）

## 6. 風險與相容性

* **零 schema migration**：純前端 + 1 個 read-only endpoint，不動既有資料
* **既有測試**：`tests/api.test.js` 有 8 個 pre-existing 失敗（chinup_project memory 已記）—— 本 PR 不負責修；新 endpoint 也不寫測試（純讀取，已 join 既有表，邏輯簡單）
* **rate limit**：登入後讀取，不需特別套 `/api/auth/*` 的 rate limit。可比照 `/api/my/*` 既有 endpoint
* **XSS**：所有 user-controlled 欄位（`display_name`、`specialty`、`bio`）都會經過 `escapeHtml()` —— 既有 `public/coaches.js` 已 import 該函式（PR #7/#8 hardening 已普及）
* **效能**：頁面載入時最多 fire 3 個 request（`/api/coaches`、`/api/my/recent-coach`、recent coach 的 7-day availability）。Lazy expand 每次 1 個 request、有 client cache。對 6\~15 位教練的小健身房規模沒壓力
* **可及性**：`<div role="button" tabindex="0">` 必須監聽 `keydown` Enter / Space。確認 implementation 有做

## 7. 驗收條件

實作完後下列皆需成立才能合 PR：

1. 截圖那個 overflow bug 消失（specialty 長字串走 line-clamp-2 換行，卡片從不爆寬到畫面外）
2. 登入會員（有 1-on-1 booking 紀錄）打開 `/coaches.html`：頂部「你最近的教練」section 顯示、預設展開、slot chips 載入、按「預約 XX 教練 →」跳 detail view
3. 同會員把那唯一一筆 booking 取消後 reload：「你最近的教練」section 完全消失
4. 登入 owner / admin / coach 角色打開 `/coaches.html`：**不**顯示「你最近的教練」section
5. 全部教練 list 點任一張：accordion 展開，slot chips 載入；再點別張 → 前一張自動收起
6. 教練無 bio：bio 段落直接省略（不見「（尚未填寫）」之類 placeholder）
7. 教練未來 7 天無 slot：chip 區改顯「目前無可預約時段」灰字；「預約 →」按鈕仍可點
8. 教練無照片：avatar 圓圈顯示中文姓氏首字（非 `👤`）
9. 鍵盤 Tab 可走到每張卡、Enter / Space 切換展開
10. 其他 5 頁（index / admin / coach / my-schedule / line）的 navbar 與內容不受影響

## 8. 後續

實作交給 `writing-plans` skill 拆 TDD-style 任務清單，沿用既有 feature branch + draft PR + 390px 手動煙霧測 gate + 最終 holistic review 工作流。
