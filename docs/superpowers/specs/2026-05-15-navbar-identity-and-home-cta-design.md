# UI 微調：Navbar 身分顯示 + 首頁 1-on-1 CTA + 首頁層級重整

**Date**: 2026-05-15
**Author**: brainstorm with user
**Scope**: front-end only, no backend / schema / API changes
**Files touched**: `public/app.js`, `public/style.css`, `public/index.html`

---

## 1. 動機

User 從 mobile 截圖指出兩處 UI 問題：

1. Navbar 上「管理者」role badge 緊接著姓名「Administrator」，視覺重複（badge 文字 ≈ 姓名）。
2. 首頁的「🏋️ 預約一對一」按鈕是大塊實心藍 bar、emoji-heavy，明顯不符合頁面其他元素（軟圓角白卡 + 淡藍 accent + 輪廓 pill）的設計語言。

對話過程也帶出兩個延伸發現：

3. 既有 bug：`renderAuthBar` 的 `badgeMap` 沒有 `coach` 分支，登入的教練 fallthrough 顯示成「會員」badge。
4. 首頁 hero 描述「由專業教練設計的循環課表…」其實是團體訓練專屬文案，目前放在 hero 但邏輯上應該是「可報名課程」section 的開場白；hero h1「找到適合你的團體訓練課程」和 section 標題「可報名課程」也語意重複。

四點一併在這次調整解決。

## 2. 設計決策（已經由 visual mockup 與使用者逐一確認）

### 2.1 Navbar 身分顯示（option C）

| 角色 | 顯示 | 說明 |
|------|------|------|
| owner | `[擁有者]` badge | 不顯示姓名 |
| admin | `[管理者]` badge | 不顯示姓名 |
| coach | `[教練]` badge | 不顯示姓名（**新增** badge map 條目，修正既有 bug） |
| user (會員) | `[PT N · 團 M]` pill + `[會員]` badge + 姓名 | 維持現狀（姓名 + 點數），會員是「我登入了沒」最強需求的群體 |

Email 仍維持 `hidden md:inline`（mobile 不顯示、desktop 才顯示）—— 但因為 owner/admin/coach 現在連姓名都不顯示，email 對他們也一併移除。

### 2.2 Coach role badge 配色

既有 6 個 `.badge-*` 沒有適合教練的中性色（紅 = 取消、灰 = 完成、綠 = 已給會員、藍 = 已給管理者、琥珀 = 已給擁有者）。新增 1 個 badge 變體：

```css
.badge-coach { background: #f5f3ff; color: #6d28d9; border-color: #ddd6fe; }
```

紫色族群明顯區別於既有四個角色色，不會跟 booking 狀態 badge 混淆。

### 2.3 首頁 1-on-1 CTA（option A：輪廓 pill）

* **樣式**：輪廓藥丸，淡藍底 `#f8fbff` / 藍邊 `#bfdbfe` / 藍字 `#1d4ed8` / `border-radius: 999px` / `1.5px` 邊框 / `padding: 12px 18px` / `font-weight: 700` / `font-size: 14px`
* **內容**：`🏋️ 預約一對一教練課 →`（保留 emoji、文字略擴充使更明確、加 `→` 箭頭暗示外連）
* **寬度**：mobile 撐滿（`block w-full`）
* **可見性**：維持 `block sm:hidden`，**只在 mobile 顯示**（desktop navbar 已有「一對一預約」連結，不需要重複）
* **位置**：頁面 eyebrow 下方、合併標題上方（見 2.4）

新增 CSS class：`.btn-pill-outline` 收納 padding / border / radius / 顏色（取此名是因為跟既有的 `.btn-primary` / `.btn-ghost` / `.btn-dark` / `.btn-danger` 同族群但屬「輪廓藥丸」變體）。

### 2.4 首頁層級重整

**新順序**：

```
[eyebrow 💪 2026 Spring Program]
[1-on-1 CTA pill]                          ← mobile 才顯示
[h1: 找到適合你的團體訓練課程   共 N 場]   ← 合併原 hero h1 + 原 section title
[description 由專業教練設計的循環課表…]
[course cards]
```

具體變更：

* **移除** 原 hero `<p>由專業教練設計的循環課表…</p>` —— 它是團課專屬文案
* **移除** 原 section heading `<h2 class="section-title">可報名課程</h2>` —— 與 h1 語意重複
* **移除** 原 h1 的 `<br>` 換行，並縮小字級讓「找到適合你的團體訓練課程」一行內裝得下；新尺寸 `22px`、`font-weight: 800`、`white-space: nowrap`
* **降階** h1 到 section 開頭：與「共 N 場」並列同一列（沿用既有 `.section-title` row 結構），同時是頁面 h1 也是 section heading
* **新增** description `<p>` 在合併標題正下方、course cards 上方：沿用原文「由專業教練設計的循環課表，每月開課、彈性報名。額滿自動進入候補、成班與否都會通知你。」
* **新增** description 的 CSS class：`.section-desc`，`font-size: 13px / color: #475569 / line-height: 1.5 / margin: 0 0 14px`

**注意**：「hero」這個 section 在改後實際上只剩 eyebrow 一個元素。可以選擇

* (a) 保留 `<section class="hero">` 包住 eyebrow（保留語意 / class），或
* (b) 把 eyebrow 拉到 `<main>` 開頭、移除 `.hero` section

採 (a)，因為 (b) 會牽動 `.hero` 既有 CSS 與其他頁面（`my-schedule.html` 等也可能使用）的一致性，scope 內不必要。`.hero` 容器保留並只包住 eyebrow 一個子元素，視覺上仍是一個輕量 hero block，class 不改、結構不刪。

## 3. 影響範圍

| 檔案 | 變更 | 行數量估計 |
|------|------|------|
| `public/app.js` | `renderAuthBar`：badgeMap 加 `coach`；非會員角色不渲染 `name` / `email` span | ~12 行修改 |
| `public/style.css` | 新增 `.badge-coach`；新增 `.btn-pill-outline`；新增 `.section-desc`；首頁 h1 尺寸（可放在 `index.html` inline 或 style.css 內 scoped class） | ~15 行新增 |
| `public/index.html` | hero 移除 `<p>` 與 `<br>`；section 區換 h2→h1、改字級、加 description；CTA `<a>` 重新 className | ~10 行修改 |

`renderAuthBar` 是 `app.js` 的共用函式 —— 修了一次，所有載入 `app.js` 的頁面（index/admin/coach/coaches/my-schedule/line）navbar 都會跟著更新。CTA 與 hero 重整只在 `index.html`。

## 4. 不在 scope 內

* 不動 desktop navbar 上的 `nav-link` 排版、hamburger 行為、`.coach-only` gating
* 不動 `.badge` 既有六個變體（open / confirmed / cancelled / completed / waitlisted / rejected）
* 不重命名 `/coaches.html` 連結文案 —— 仍是 navbar 顯示「一對一預約」、首頁 CTA 顯示「預約一對一教練課」（兩者語意一致，文案差異可接受）
* 不動 `my-schedule.html` 第 133 行那顆 `btn btn-primary` empty-state CTA —— 它是不同情境（empty-state group + 1-on-1 二選一），維持實心藍按鈕當「主要 action」是對的
* 不動 admin/coach 的 `ROLE_LABEL` 常數（`public/admin.js`）—— 那是給 admin 後台的下拉選單用，跟 navbar 顯示是兩條獨立管道

## 5. 風險與相容性

* **沒有資料庫 / API 變更** —— 純前端調整，無 migration 風險
* **沒有 build step** —— 純 vanilla JS + Tailwind CDN + 自有 style.css，改完直接 reload 生效
* **既有測試**：`tests/api.test.js` 與此次變更無關，原有 8 個 pre-existing failure 也不會被影響或解決
* **手動煙霧測**：必須涵蓋 4 種角色（owner / admin / coach / user）登入 navbar 顯示、index 首頁 mobile（390px）+ desktop（≥768px）佈局、CTA 點擊跳 `/coaches.html`、其他 5 頁（admin/coach/coaches/my-schedule/line）navbar 沒有 regression

## 6. 驗收條件

實作完成後，下列項目全部成立才算過：

1. Owner / admin / coach 登入後 navbar 只看到對應 role badge，不見姓名、不見 email
2. Coach 登入後看到紫色「教練」badge，**不是**綠色「會員」badge
3. 會員登入後 navbar 依序顯示：points pill → 會員 badge → 姓名（mobile）；desktop 多顯示 email
4. 首頁 mobile（390px viewport）：eyebrow → 輪廓 pill CTA → h1 一行 + 共 N 場 → description → course cards
5. 首頁 desktop：與 mobile 結構一致，僅 CTA 隱藏；h1 同樣一行字級
6. CTA 點擊跳 `/coaches.html`
7. 其他 5 個共用 navbar 的頁面 mobile + desktop 都看起來正常，沒有姓名與 badge 重疊、沒有破版

---

## 7. 後續

實作交給 `writing-plans` skill 拆出 TDD-style 任務清單（這次純 UI 改動沒有 TDD test 可寫，但仍會用 plan 結構記錄每一步交付物 + 對應的 manual smoke 檢查點），合併走既有 feature branch + draft PR + 390px 手動煙霧測 gate 工作流。
