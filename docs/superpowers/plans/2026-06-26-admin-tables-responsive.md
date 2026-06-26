# 後台表格自適應手機寬度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台共用表格 `.data-table` 在手機寬度（<768px）重排成堆疊卡，桌機外觀不變。

**Architecture:** 純前端。**CSS 加在 `public/admin.html` 的 inline `<style>`**（它在載入 style.css 之後又重定義了 `.data-table`，故重排規則必須放這裡才不會被同特異度的 overlay 蓋掉）；`public/admin.js` 在 4 個用 `.data-table` 的 render 的每個 `<td>` 加 `data-label`，並把「會員 Email/手機」雙 div 包 `.cell-stack`、「課程分類 操作」雙按鈕包 `.row-actions`，讓它們在 flex 堆疊卡內仍正確排版。桌機（≥768px）不受影響。

**Tech Stack:** Vanilla JS ESM（`public/admin.js`）、CSS（`public/admin.html` inline `<style>`）。後端不動。

## Global Constraints

- **純前端**：只改 `public/admin.html` 與 `public/admin.js`；不改 `public/style.css`、不改 `src/**`、不動測試、不新增套件。
- **CSS 放在 `admin.html` inline `<style>`**（非 style.css）：admin.html 在 inline style 重定義了 `.data-table td`（border）與 `.data-table tr:hover td`（background），media query 不加特異度、同特異度時較晚出現者勝出 → 規則必須在 admin.html、且**排在它既有 `.data-table` 規則之後**才會生效。
- 自適應**套用到所有後台 `.data-table` 表格**（通知/會員/LINE/課程分類共 4 處）。
- 斷點沿用 app 既有 **768px**（`@media (max-width:767px)`）。
- 做法＝手機**重排成堆疊卡**（非水平捲動）；**桌機外觀完全不變**（`data-label`/`.cell-stack`/`.row-actions` 在桌機無作用）。
- 不碰備份彈窗表（`<table class="w-full text-sm">`，非 `.data-table`）。
- 文案繁體中文；既有 `escapeHtml` 不動（只加屬性/包 wrapper，不改值）。

---

## 既有程式碼錨點（實作者必讀）

`public/admin.html`（inline `<style>`，於行 12 載入 style.css 之後生效）：
- `.data-table` overlay 規則：行 93-104（`.data-table th`(94) / `.data-table td{border-bottom:1px solid var(--line)}`(100) / `.data-table tr:hover td{background:var(--brand-50)}`(101) / `.data-table .font-medium`(102) / `.data-table td.subtle`(104)）。**本 PR 的重排 `@media` 區塊新增在行 104 之後、行 106 `/* 備份 modal ... */` 之前。**
- CSS 變數：`--line`、`--ink-mute`、`--brand-50` 於 :root 既有。
- 4 個表格容器外層皆為 `<div class="card p-0 overflow-hidden">`（會員/LINE/課程分類）或 `#notifs`（通知，`max-h-96 overflow-auto`）。

`public/admin.js`（4 個用 `.data-table` 的 render；只在 `<td>` 加 `data-label`＋2 處包 wrapper，值不動）：
- `loadNotifs()` 通知表 td：行 101-105（5 td）。
- `renderUserRow()` 會員表 td：行 520-528（6 td；Email/手機格含兩個 `<div>`）。
- `renderLineTable()` LINE 表 td：行 593-598（6 td；未綁定時操作格為空字串）。
- `loadCategories()` 課程分類表 td：行 908-914（4 td；操作格含兩顆 `<button>`）。

---

## File Structure

- **Modify `public/admin.html`**（inline `<style>` 行 104 後）：新增 `@media (max-width:767px)` 重排規則。
- **Modify `public/admin.js`**：4 render 的 `<td>` 加 `data-label`；會員 Email/手機格包 `.cell-stack`；課程分類操作格包 `.row-actions`。

單一交付單元（表格 RWD）：CSS 與 markup 相依，合併為一個 Task。

---

### Task 1: 後台表格 RWD（admin.html CSS 重排 + admin.js 4 表 data-label/wrapper）

**Files:**
- Modify: `public/admin.html`（inline `<style>` 行 104 後新增 @media 區塊）
- Modify: `public/admin.js`（loadNotifs / renderUserRow / renderLineTable / loadCategories）

**Interfaces:**
- Consumes（既有）：`.data-table` 類別、`--line`/`--ink-mute` 變數、各 render 既有結構。
- Produces：`.data-table` 在 <768px 的堆疊卡樣式（含 `.cell-stack`/`.row-actions` 輔助類）；4 表 `<td>` 的 `data-label` 屬性。無新函式，外部不依賴。

- [ ] **Step 1：admin.html — 加手機重排 CSS（放在 inline `<style>` 既有 `.data-table` 規則之後）**

在 `public/admin.html` inline `<style>` 的 `.data-table td.subtle{ font-variant-numeric:tabular-nums; }`（行 104）**之後**、`/* 備份 modal 內表格同步 Nike 化 */`（行 106）之前，插入：

```css

/* 後台表格手機(<768px)重排成堆疊卡（桌機不受影響；放在 .data-table overlay 之後以勝出） */
@media (max-width: 767px) {
  .data-table thead { display: none; }
  .data-table, .data-table tbody { display: block; width: 100%; }
  .data-table tr {
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px 12px;
    margin: 10px;
    background: #fff;
  }
  .data-table td {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border: 0;
    border-bottom: 1px solid #f1f5f9;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .data-table tr:last-child td { border-bottom: 1px solid #f1f5f9; }
  .data-table tr td:last-child { border-bottom: none; }
  .data-table td:empty { display: none; }
  .data-table td::before {
    content: attr(data-label);
    flex: 0 0 auto;
    text-align: left;
    white-space: nowrap;
    color: var(--ink-mute);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .data-table tr:hover td { background: transparent; }
  .data-table .cell-stack { display: flex; flex-direction: column; align-items: flex-end; min-width: 0; }
  .data-table .row-actions { display: flex; gap: 8px; }
}
```

> 重點：此區塊**必須在 admin.html**（且在行 104 之後）——`.data-table td{border-bottom}` 與 `.data-table tr:hover td{background}` 是 admin.html overlay 定義的，放 style.css 會被蓋掉。`tr:last-child td` 先恢復內部分隔線、`tr td:last-child` 再去掉每張卡末格底線（兩者同特異度、後者較晚 → 卡末格無線、其餘有線）。`td:empty` 隱藏空操作格（LINE 未綁定列）。

- [ ] **Step 2：admin.js — 通知表 td 加 data-label（loadNotifs，行 101-105）**

把：
```js
          <td class="subtle">${fmtDate(r.sent_at)}</td>
          <td>${escapeHtml(r.email)}</td>
          <td><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td>${escapeHtml(r.channel)}</td>
          <td>${escapeHtml(r.subject)}</td>
```
改為：
```js
          <td data-label="時間" class="subtle">${fmtDate(r.sent_at)}</td>
          <td data-label="收件者">${escapeHtml(r.email)}</td>
          <td data-label="類型"><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td data-label="通道">${escapeHtml(r.channel)}</td>
          <td data-label="主旨">${escapeHtml(r.subject)}</td>
```

- [ ] **Step 3：admin.js — 會員表 td 加 data-label + Email/手機包 .cell-stack（renderUserRow，行 520-528）**

把：
```js
      <td class="subtle">#${r.id}</td>
      <td><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
      <td class="subtle">
        <div>${escapeHtml(r.email)}</div>
        <div style="font-size:12px;opacity:0.7;margin-top:2px;">${escapeHtml(r.phone)}</div>
      </td>
      <td>${loginBadge}</td>
      <td>${roleCell}</td>
      <td class="subtle">${fmtDate(r.created_at)}</td>
```
改為：
```js
      <td data-label="ID" class="subtle">#${r.id}</td>
      <td data-label="姓名"><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
      <td data-label="Email / 手機" class="subtle">
        <div class="cell-stack">
          <div>${escapeHtml(r.email)}</div>
          <div style="font-size:12px;opacity:0.7;margin-top:2px;">${escapeHtml(r.phone)}</div>
        </div>
      </td>
      <td data-label="登入方式">${loginBadge}</td>
      <td data-label="角色">${roleCell}</td>
      <td data-label="加入時間" class="subtle">${fmtDate(r.created_at)}</td>
```
（桌機下 `.cell-stack` 無樣式，仍是兩個 block div 上下排列，外觀不變。）

- [ ] **Step 4：admin.js — LINE 表 td 加 data-label（renderLineTable，行 593-598）**

把：
```js
            <td class="subtle">#${r.id}</td>
            <td><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
            <td>${lineRoleBadge(r)}</td>
            <td class="subtle">${escapeHtml(r.phone || '')}</td>
            <td>${statusBadge}</td>
            <td>${action}</td>
```
改為：
```js
            <td data-label="ID" class="subtle">#${r.id}</td>
            <td data-label="姓名"><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
            <td data-label="角色">${lineRoleBadge(r)}</td>
            <td data-label="手機" class="subtle">${escapeHtml(r.phone || '')}</td>
            <td data-label="LINE 綁定">${statusBadge}</td>
            <td data-label="操作">${action}</td>
```
（未綁定時 `action=''` → `<td data-label="操作"></td>` 為 `:empty`，由 Step 1 的 `td:empty{display:none}` 在手機隱藏。）

- [ ] **Step 5：admin.js — 課程分類 td 加 data-label + 操作雙按鈕包 .row-actions（loadCategories，行 908-914）**

把：
```js
              <td class="subtle">#${c.sort_order}</td>
              <td><span class="font-medium">${escapeHtml(c.name)}</span></td>
              <td class="subtle">${escapeHtml(c.description || '—')}</td>
              <td>
                <button class="btn btn-ghost btn-sm cat-edit" data-id="${c.id}">編輯</button>
                <button class="btn btn-danger btn-sm cat-del" data-id="${c.id}">刪除</button>
              </td>
```
改為：
```js
              <td data-label="排序" class="subtle">#${c.sort_order}</td>
              <td data-label="名稱"><span class="font-medium">${escapeHtml(c.name)}</span></td>
              <td data-label="說明" class="subtle">${escapeHtml(c.description || '—')}</td>
              <td data-label="操作">
                <div class="row-actions">
                  <button class="btn btn-ghost btn-sm cat-edit" data-id="${c.id}">編輯</button>
                  <button class="btn btn-danger btn-sm cat-del" data-id="${c.id}">刪除</button>
                </div>
              </td>
```
（`.cat-edit`/`.cat-del` class 與 `el.querySelectorAll('.cat-edit'/'.cat-del')` 綁定不變；桌機下 `.row-actions` 無樣式、兩鈕仍並排，外觀不變。）

- [ ] **Step 6：語法 + 結構檢查**

Run: `node --check public/admin.js`
Expected: 無輸出、exit 0。
Run: `grep -c 'data-label' public/admin.js`
Expected: `21`（通知 5 + 會員 6 + LINE 6 + 課程分類 4）。
Run: `grep -c 'class="cell-stack"' public/admin.js`
Expected: `1`。
Run: `grep -c 'class="row-actions"' public/admin.js`
Expected: `1`。
Run: `grep -c 'data-table thead { display: none' public/admin.html`
Expected: `1`（重排規則已加在 admin.html）。
> 註：grep 僅驗「字串存在」非「規則生效」；真正有效性閘門是控制者瀏覽器 smoke（見下）。

- [ ] **Step 7：Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台表格手機寬度自適應（.data-table <768px 重排堆疊卡 + data-label/cell-stack/row-actions）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 驗證（控制者親跑，非 subagent 任務）

實作後由控制者執行瀏覽器 smoke（本機 `npm start` + 管理者登入 `admin@chinup.local/admin1234`）：
1. **桌機寬（≥768px）**：4 表（通知/會員/LINE/課程分類）維持原本表格外觀（多欄、表頭可見、會員 Email 在上手機在下、課程分類兩鈕並排），無回歸。
2. **手機寬（<768px，DevTools 裝置模擬或縮窗）**：4 表皆重排為堆疊卡，每格「欄位名：值」、無水平溢出（長 email 會換行不裁切）；
   - 會員 Email/手機格：email 與手機**上下堆疊**靠右（非橫排）。
   - 課程分類 操作格：編輯+刪除兩鈕**相鄰**靠右。
   - LINE 表：已綁定列有「解除綁定」鈕可點；**未綁定列不顯示空的「操作」格**。
   - 卡片四周間距一致、`tr:hover` 無殘留底色（觸控）、每張卡內分隔線正常（含最後一張卡）。
3. 控制台無錯誤。

> 無前端測試框架（專案無 jsdom）；只加 CSS+屬性/wrapper、不動後端 → 不新增測試。`node --check` 為機械把關。

## 不做（YAGNI）
- 不做水平捲動方案。
- 不改桌機外觀、不改備份彈窗表、不改非 `.data-table` 面板、不改 style.css。
- 不引入套件、不動後端/測試。
