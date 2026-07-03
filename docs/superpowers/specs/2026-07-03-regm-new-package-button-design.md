# 登錄彈窗「新增方案」按鈕＋方案下拉顯示單價 — 設計規格

- 日期：2026-07-03
- 狀態：業主已核可設計

## 目標

教練後台「登錄預約」彈窗：客人方案快用完時，教練可**當場開新方案**（目前只有客人完全無有效方案時才會出現開方案表單）；方案下拉選項加顯**單價**。

## 行為規則（純前端，`public/coach.js` + `public/style.css`；後端 API 不動）

### 1.「＋ 新增方案」按鈕（`renderRegmPicked` 有方案分支）

- 「選擇方案」label 右側加 `＋ 新增方案` 按鈕（`btn-secondary btn-sm`），同列 flex 排版（新 CSS class `.regm-pkg-head`，加在 style.css regm 區塊）。
- 點擊展開／再點收合開方案表單（型態/堂數/金額/到期/折扣碼/建立——與無方案狀態**同一張**表單，抽共用 helper：`regmNewPkgFormHtml()` 產 HTML、`bindRegmNewPkgForm(onCreated)` 綁事件）。
- 建立成功 → `loadRegmPackages(newPkg.id)` 重載並**自動選取新方案**、表單隨重繪收合、toast「方案已建立」。
- `POST /api/coach/packages` 回 201＋新方案物件（含 `id`），直接取用。

### 2. 自動選取（`loadRegmPackages` 加參數）

- `loadRegmPackages(selectId = null)`：`selectId` 存在且在有效清單內 → 選它；否則維持原邏輯（第一個）。
- `renderRegmPicked` 渲染 select 後先 `sel.value = String(regmPackageId)`（存在才設）再綁 onchange，避免現行「一律回到第一個選項」蓋掉指定值。

### 3. 下拉選項顯示單價

- 格式：`一對二・剩 1/1・單價 NT$2,000・到期 2026-08-01`（到期照舊有才顯示）。
- 單價 = `Math.round(amount ÷ total_sessions)`，`toLocaleString('zh-TW')` 千分位——與登錄扣抵寫入 `original_amount`、薪資計算同一口徑。
- `amount` 為 null → 顯示 `・無單價`（提醒教練該方案沒填金額；薪資頁會警示）。

### 4. 無方案狀態

- 維持現狀：表單直接顯示（改用共用 helper 產生，行為不變），建立成功後 `loadRegmPackages(newPkg.id)`。

## 範圍外（YAGNI）

- 編輯預約彈窗（`#bke-*`）的方案選單與流程不動。
- 後端 API、方案列表排序不動。

## 驗證

- 純前端：`node --check public/coach.js` ＋ Playwright 實測（登入 → coach.html → 點空格開登錄彈窗 → 選有方案客人：下拉含「單價 NT$」字樣；點「＋ 新增方案」展開表單 → 建立 → 下拉自動選到新方案；無方案客人表單直出照舊；0 console error）。
- 既有 `test:api` 迴歸（後端未動，應全綠）。
