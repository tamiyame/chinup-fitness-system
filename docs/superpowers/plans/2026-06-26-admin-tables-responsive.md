# 後台表格自適應手機寬度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台共用表格 `.data-table` 在手機寬度（<768px）重排成堆疊卡，桌機外觀不變。

**Architecture:** 純前端。`public/style.css` 加一段 `@media (max-width:767px)` 規則把 `.data-table` 重排為堆疊卡（隱藏表頭、每列一張卡、每格 flex 一行以 `td::before { content: attr(data-label) }` 顯示欄位名）；`public/admin.js` 在 4 個使用 `.data-table` 的 render 的每個 `<td>` 加 `data-label`。桌機（≥768px）不受影響。

**Tech Stack:** Vanilla JS ESM（`public/admin.js`）、CSS（`public/style.css`）。後端不動。

## Global Constraints

- **純前端**：只改 `public/style.css` 與 `public/admin.js`；不改任何 `src/**`、不動測試、不新增套件。
- 自適應**套用到所有後台 `.data-table` 表格**（通知/會員/LINE/課程分類共 4 處）。
- 斷點沿用 app 既有 **768px**（`@media (max-width:767px)`）。
- 做法＝手機**重排成堆疊卡**（非水平捲動）；**桌機外觀完全不變**（`data-label` 在桌機無作用）。
- 不碰備份彈窗表（`<table class="w-full text-sm">`，非 `.data-table`）。
- 文案繁體中文；既有 `escapeHtml` 不動（只加屬性，不改值）。

---

## 既有程式碼錨點（實作者必讀）

`public/style.css`：
- `.data-table` 定義：行 430-443（`.data-table`/`th`/`td`/`tr:last-child td`/`tr:hover td`）。
- 既有手機斷點區 `@media (max-width: 767px) { ... }`：行 499-511（結尾 `}` 在行 511）。**本 PR 的重排 CSS 新增在行 511 之後。**
- CSS 變數：`--line`、`--ink-mute` 於 `:root` 既有。

`public/admin.js`（4 個用 `.data-table` 的 render；只在 `<td>` 加 `data-label`，其餘不動）：
- `loadNotifs()` 通知表 td：行 101-105。
- `renderUserRow()` 會員表 td：行 520-528。
- `renderLineTable()` LINE 表 td：行 593-598。
- `loadCategories()` 課程分類表 td：行 908-914。

---

## File Structure

- **Modify `public/style.css`**（行 511 後）：新增 `@media (max-width:767px)` 重排規則。
- **Modify `public/admin.js`**：4 個 render 的每個 `<td>` 加 `data-label`。

單一交付單元（表格 RWD）：CSS 與 data-label 相依（CSS 沒 data-label 則堆疊無欄位名；data-label 沒 CSS 則桌機無作用），合併為一個 Task。

---

### Task 1: 後台表格 RWD（CSS 重排 + 4 表 data-label）

**Files:**
- Modify: `public/style.css`（行 511 後新增 media 區塊）
- Modify: `public/admin.js`（loadNotifs / renderUserRow / renderLineTable / loadCategories 的 `<td>`）

**Interfaces:**
- Consumes（既有）：`.data-table` 類別、`--line`/`--ink-mute` CSS 變數、各 render 既有結構。
- Produces：`.data-table` 在 <768px 的堆疊卡樣式；4 表 `<td>` 的 `data-label` 屬性。無新函式/介面，外部不依賴。

- [ ] **Step 1：CSS — 加手機重排規則**

在 `public/style.css` 既有 `@media (max-width: 767px) { ... }`（行 499-511）的結尾 `}`（行 511）**之後**新增：

```css
/* 後台表格 .data-table：手機(<768px)重排成堆疊卡（桌機不受影響） */
@media (max-width: 767px) {
  .data-table thead { display: none; }
  .data-table, .data-table tbody { display: block; width: 100%; }
  .data-table tr {
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px 12px;
    margin-bottom: 10px;
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
  }
  .data-table tr td:last-child { border-bottom: none; }
  .data-table td::before {
    content: attr(data-label);
    flex: 0 0 auto;
    text-align: left;
    color: var(--ink-mute);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .data-table tr:hover td { background: transparent; }
}
```

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

- [ ] **Step 3：admin.js — 會員表 td 加 data-label（renderUserRow，行 520-528）**

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
        <div>${escapeHtml(r.email)}</div>
        <div style="font-size:12px;opacity:0.7;margin-top:2px;">${escapeHtml(r.phone)}</div>
      </td>
      <td data-label="登入方式">${loginBadge}</td>
      <td data-label="角色">${roleCell}</td>
      <td data-label="加入時間" class="subtle">${fmtDate(r.created_at)}</td>
```

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

- [ ] **Step 5：admin.js — 課程分類表 td 加 data-label（loadCategories，行 908-914）**

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
                <button class="btn btn-ghost btn-sm cat-edit" data-id="${c.id}">編輯</button>
                <button class="btn btn-danger btn-sm cat-del" data-id="${c.id}">刪除</button>
              </td>
```

- [ ] **Step 6：語法 + 結構檢查**

Run: `node --check public/admin.js`
Expected: 無輸出、exit 0。
Run: `grep -c 'data-label' public/admin.js`
Expected: `21`（通知 5 + 會員 6 + LINE 6 + 課程分類 4）。
Run: `grep -c 'data-table thead { display: none' public/style.css`
Expected: `1`（重排規則已加）。

- [ ] **Step 7：Commit**

```bash
git add public/style.css public/admin.js
git commit -m "feat: 後台表格手機寬度自適應（.data-table <768px 重排堆疊卡 + 4 表 data-label）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 驗證（控制者親跑，非 subagent 任務）

實作後由控制者執行瀏覽器 smoke（本機 `npm start` + 管理者登入 `admin@chinup.local/admin1234`）：
1. **桌機寬（≥768px）**：4 表（通知/會員/LINE/課程分類）維持原本表格外觀（多欄、表頭可見），無回歸。
2. **手機寬（<768px，DevTools 裝置模擬或縮窗）**：4 表皆重排為堆疊卡，每格顯示「欄位名：值」，無水平溢出；LINE 表「解除綁定」鈕、課程分類「編輯/刪除」鈕可點且版面正常。
3. 控制台無錯誤。

> 拖曳/RWD 無前端測試框架（專案無 jsdom）；只加 CSS+屬性、不動後端 → 不新增測試。`node --check` 為機械把關。

## 不做（YAGNI）
- 不做水平捲動方案。
- 不改桌機外觀、不改備份彈窗表、不改非 `.data-table` 面板。
- 不引入套件、不動後端/測試。
