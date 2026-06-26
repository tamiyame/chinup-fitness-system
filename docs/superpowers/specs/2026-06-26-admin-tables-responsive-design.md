# 後台表格自適應手機寬度 — 設計文件

> 日期：2026-06-26
> 範圍：單一 PR，**純前端**（`public/style.css` 一段 RWD CSS + `public/admin.js` 4 個 render 加 `data-label`）。後端不動。
> 業主已拍板：套用到**所有**後台 `.data-table` 表格。

## 問題
後台共用表格 `.data-table` 為固定多欄表格，外層 `.card p-0 overflow-hidden` 無水平捲動，手機寬度下欄位擠在一起難讀（LINE 管理表 6 欄尤甚）。

## 已拍板決策（業主，2026-06-26）
- 自適應**套用到所有後台 `.data-table` 表格**（不只 LINE 管理）。
- 做法＝手機重排成堆疊卡（非水平捲動）。斷點沿用 app 既有 **768px**（`@media (max-width:767px)`）。

## 背景（已查證，含 file:line）
- `.data-table` 定義於 `public/style.css:430-443`（th/td padding、底線、hover）。app 既有手機斷點 `@media (max-width:767px)`（style.css:499-511）。
- `.data-table` 僅 `public/admin.js` 使用，共 **4 處**（其他頁面 grep 無）：
  1. `loadNotifs()`（admin.js:98-106）通知表：時間｜收件者｜類型｜通道｜主旨。
  2. `renderUsersTable()`/`renderUserRow()`（admin.js:485-528）會員表：ID｜姓名｜Email/手機｜登入方式｜角色｜加入時間。
  3. `renderLineTable()`（admin.js:572-599）LINE 表：ID｜姓名｜角色｜手機｜LINE 綁定｜操作（操作表頭原為空）。
  4. `loadCategories()`（admin.js:898-917）課程分類表：排序｜名稱｜說明｜操作。
- 各表空狀態以 `<div>`（非表列）呈現 → 不受重排影響。
- 備份彈窗表是 `<table class="w-full text-sm">`（**非** `.data-table`）→ 不在範圍。
- CSS 變數可用：`--line`（細線）、`--ink-mute`（次要文字）。

## 架構（純前端）

### CSS（`public/style.css`，在既有 `@media (max-width:767px)` 區之後新增一段）
手機（<768px）把 `.data-table` 重排為堆疊卡：
- `.data-table thead { display:none }`；`.data-table, .data-table tbody { display:block }`。
- `.data-table tr` → 圓角細框小卡（`border:1px solid var(--line)`、`border-radius:8px`、`padding:4px 12px`、`margin-bottom:10px`、白底）。
- `.data-table td` → `display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border:0; border-bottom:1px solid #f1f5f9; text-align:right`；卡內最後一格 `tr td:last-child` 去底線。
- `.data-table td::before { content:attr(data-label) }`：左側欄位名（`var(--ink-mute)`、11px、600、uppercase、`text-align:left`、`flex:0 0 auto`）。
- `.data-table tr:hover td { background:transparent }`（觸控無 hover，避免殘留底色）。
- 桌機（≥768px）完全不受影響（`data-label` 屬性在桌機無作用）。

### JS（`public/admin.js`）
在上述 4 個 render 的**每個 `<td>`** 加 `data-label="<該欄表頭>"`（值對應 thead 文字）：
- 通知：時間/收件者/類型/通道/主旨。
- 會員：ID/姓名/Email・手機（用 `Email / 手機`）/登入方式/角色/加入時間。
- LINE：ID/姓名/角色/手機/LINE 綁定/操作（操作格表頭原空，堆疊時標「操作」）。
- 課程分類：排序/名稱/說明/操作。
桌機 DOM 與外觀不變（`data-label` 僅供手機 `::before` 取用）。

## 不動
- 桌機表格版式、後端、其他面板（折扣碼/教練/報名作業以卡片或其他結構呈現，非 `.data-table`）、備份彈窗表。
- 不引入任何套件。

## 測試
- `node --check public/admin.js`。
- 瀏覽器 smoke（控制者）：桌機寬（≥768px）4 表維持原表格外觀；手機寬（<768px）4 表皆重排為堆疊卡、每格顯示「欄位名：值」、LINE 解除綁定鈕與課程分類編輯/刪除鈕可點。
- 無前端測試框架（專案無 jsdom）→ 不新增前端單元測試；後端無關不動測試。

## 不做（YAGNI）
- 不做水平捲動方案（業主要重排自適應）。
- 不改備份彈窗表、不改桌機外觀。
- 不為非 `.data-table` 面板另做 RWD（本次只處理表格）。
