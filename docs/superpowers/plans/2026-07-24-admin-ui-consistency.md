# 管理後台 8 頁籤一致性改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理後台 8 個頁籤統一為「標題列（a-sec-head）＋單卡包列（a-row 行語法）」語彙，長清單一律「前 20 筆＋載入更多」，空狀態/載入中/錯誤三態統一——功能與 JS 契約零改動。

**Architecture:** 純前端：`public/admin.html`（inline `<style>` 新增骨架 CSS＋各面板 markup 調整）＋`public/admin.js`（渲染函式輸出的 HTML 骨架改為 a-row、清單渲染拆 cache＋render 兩層以支援 limitSlice）。零後端、零 API、事件綁定方式照舊。

**Tech Stack:** vanilla JS、inline CSS（admin.html `<style>` 蓋 overlay 慣例）、無前端測試框架（驗證＝node --check＋grep 契約＋瀏覽器實測）。

**Spec:** `docs/superpowers/specs/2026-07-24-admin-ui-consistency-design.md`（業主已核可）
**共用詞彙定稿：** `.superpowers/sdd/consistency-vocab.md`（骨架 CSS／helper 逐字碼、使用規則、紅線——每個任務的實作者都必須先讀）

## Global Constraints

- **JS 契約零改動**：所有 `#id` 掛載點、`.cat-edit/.cat-del/.edit-btn/.view-btn/.del-btn/.confirm-*-btn/.cancel-*-btn/.dc-*-btn/.toggle-active/.demote-btn/[data-line-unbind]` 等按鈕 class 與 dataset、`tr.user-row` 長按、`.confirmed-payment-row` 長按與 data-*、drawer 全家（`.session-*`/`.reg-cancel`/`.backfill-panel`）、`.coach-color-*`、`.pr-*`/`.sh-*`、`td.cell-*`/`data-label` RWD 契約。
- 散卡→列**保留 `article` 元素與 `.card-title` class**（報名作業 confirm 靠 `closest('article').querySelector('.card-title')` 取姓名）。
- 只改輸出 HTML 骨架；資料流、事件綁定方式（逐鈕/委派）、API 呼叫不動。
- CSS 一律放 `admin.html` inline；`<768px` 既有 `.data-table` 卡片化 RWD 照舊。
- 文案繁體中文；不加新功能；長按/prompt/confirm/badge 假按鈕互動照舊。
- **Task 1 是同批全部後續任務的硬前置**（helper／骨架 CSS 未落檔前，其他任務執行後會 ReferenceError）；Task 1 的 CSS 必須插在 admin.html「空狀態」註解區塊**之前**（Task 9 的 `</style>` 錨點依賴此位置）。
- **Edit 一律使用任務文中的完整多行「原：」區塊**——多個短字串（`<div class="flex items-center justify-between mb-4">` ×7、`grid gap-3` ×4、`<article class="card">` ×3 等）在檔內不唯一，縮短錨點必錯。
- Commit 訊息結尾：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 三批 PR 皆 base main 序列合併：PR1＝Task 1–4、PR2＝Task 5–7＋收尾、PR3＝Task 8–10＋收尾。分支：`feature/admin-ui-consistency-1/2/3`（PR1 分支已存在、spec 已 commit）。
- 瀏覽器實測由 controller 於每批收尾統一執行；任務內驗證＝`node --check`＋grep。

---

### Task 1: 骨架 CSS＋載入更多 helper（PR1）

**Files:**
- Modify: `public/admin.html`（`<style>` 內、`/* ---------- 空狀態…` 區塊之前插入）
- Modify: `public/admin.js`（import 與 `const user` 之後、`ROLE_LABEL` 之前插入）

**Interfaces:**
- Produces（後續全部任務依賴）：CSS class `a-sec-head/a-sec-line/a-sec-tools/a-search/a-filter/a-row/a-row-main/a-row-title/a-row-sub/a-row-actions/a-more`（`a-rows` 為語意標記 class、無 CSS 規則）；JS `PAGE`、`_shownMap`、`limitSlice(key, items)`、`moreButtonHtml(key, rest)`、`bindLoadMore(container, rerender)`。

- [ ] **Step 1: admin.html 插入骨架 CSS**

在 `/* ---------- 空狀態：移除大 emoji 圖示位置，改細描邊 + 小標 ---------- */` 這行之前插入：

```css
/* ---------- 一致性骨架：區塊標題列 + 單卡包列 + 載入更多 ---------- */
.a-sec-head{ display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
.a-sec-head .section-title{ white-space:nowrap; }
.a-sec-line{ flex:1; height:1px; background:var(--line); min-width:24px; }
.a-sec-tools{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.a-sec-tools .form-input{ margin-bottom:0; }
.a-search{ max-width:240px; }
.a-filter{ max-width:140px; }

/* .a-rows 為語意標記 class（清單容器），無 CSS 規則 */
.a-row{ padding:14px 16px; border-bottom:1px solid var(--line); display:grid; grid-template-columns:1fr auto; gap:6px 16px; align-items:center; }
.a-row:last-child{ border-bottom:none; }
.a-row:hover{ background:var(--brand-50); }
.a-row-main{ min-width:0; }
.a-row-title{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.a-row-sub{ margin-top:4px; }
.a-row-actions{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
@media (max-width:767px){
  .a-row{ grid-template-columns:1fr; }
  .a-row-actions{ justify-content:flex-start; }
}

.a-more{ display:block; width:100%; border-top:1px solid var(--line); text-align:center; }
```

- [ ] **Step 2: admin.js 插入 helper**

Edit 的 old_string 用以下三行（含空行）以固定插入位置：

```js
if (!user) throw new Error('__redirected_by_auth__');

const ROLE_LABEL = { owner: '擁有者', admin: '管理者', coach: '教練', user: '會員' };
```

改為（在中間插入 helper）：

```js
if (!user) throw new Error('__redirected_by_auth__');

// 通用「前 N 筆＋載入更多」：純前端 slice。key 區分各清單的 shown 狀態；
// 搜尋/篩選 handler 先 _shownMap.delete(key) 再呼叫 render 即重設回 PAGE。
const PAGE = 20;
const _shownMap = new Map();
function limitSlice(key, items) {
  if (!_shownMap.has(key)) _shownMap.set(key, PAGE);
  const shown = _shownMap.get(key);
  return { visible: items.slice(0, shown), rest: Math.max(0, items.length - shown) };
}
function moreButtonHtml(key, rest) {
  if (rest <= 0) return '';
  return `<button type="button" class="btn btn-ghost a-more" data-more-key="${key}">載入更多（還有 ${rest} 筆）</button>`;
}
function bindLoadMore(container, rerender) {
  const btn = container.querySelector('[data-more-key]');
  if (btn) btn.addEventListener('click', () => {
    _shownMap.set(btn.dataset.moreKey, (_shownMap.get(btn.dataset.moreKey) || PAGE) + PAGE);
    rerender();
  });
}

const ROLE_LABEL = { owner: '擁有者', admin: '管理者', coach: '教練', user: '會員' };
```

- [ ] **Step 3: 驗證**

```bash
cd ~/projects/chinup-fitness-system && node --check public/admin.js && grep -c "a-sec-head\|\.a-row{" public/admin.html && grep -c "limitSlice\|bindLoadMore" public/admin.js
```
預期：node --check 過；兩個 grep 計數皆 ≥2。

- [ ] **Step 4: Commit**

```bash
cd ~/projects/chinup-fitness-system && git add public/admin.html public/admin.js && git commit -m "feat: 一致性骨架 CSS（a-sec-head/a-row/a-more）＋前20筆載入更多 helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 課程頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — 課程頁籤 `#apanel-courses` 內：課程分類區塊標題列（約 449-460）、課程範本區塊（約 462-469）；統計四卡、備份列、modal、drawer 一律不動
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — `loadTemplates()`（約 31-91）；`loadNotifs` 以下不動

**Interfaces:**
- Consumes（Task 1 已就位，逐字使用、不得重複定義）：CSS class `.a-sec-head` / `.a-sec-line` / `.a-sec-tools` / `.a-rows` / `.a-row` / `.a-row-main` / `.a-row-title` / `.a-row-sub` / `.a-row-actions` / `.a-more`；JS helper `limitSlice(key, items)` / `moreButtonHtml(key, rest)` / `bindLoadMore(container, rerender)`（key 用 `'templates'`）
- Produces：`renderTemplates()`（模組層純渲染函式）＋模組變數 `templatesCache`（僅本頁籤內部使用，後續任務無依賴）

**紅線提醒（詞彙 §C 全條適用）**：`#templates`、`#new-btn`、`#new-cat-btn`、`#categories-table`、`#stat-*` id 零改動；`.edit-btn` / `.view-btn` / `.del-btn` class 與 `data-id` dataset 零改動；`article` 元素與 `.card-title` 必須保留（報名作業 confirm 依賴 `closest('article').querySelector('.card-title')` 的同款語彙）；不改資料流／事件綁定方式／API 呼叫——stat 卡 N+1 迴圈照舊不動；分類表、統計卡、備份列、範本 modal、場次 drawer 全部不碰。

#### Step 1: admin.html — 「課程分類」標題列改 `a-sec-head`

只改標題列，`#categories-table` 卡包表照舊（已合規）。

原：
```html
  <!-- categories -->
  <section class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">課程分類</h2>
      <button id="new-cat-btn" class="btn btn-ghost btn-sm">＋ 新增分類</button>
    </div>
```

改為：
```html
  <!-- categories -->
  <section class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">課程分類</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <button id="new-cat-btn" class="btn btn-ghost btn-sm">＋ 新增分類</button>
      </div>
    </div>
```

#### Step 2: admin.html — 「課程範本」標題列改 `a-sec-head`＋容器加卡外框改 `a-rows`

`#templates` id 沿用，class 由 `grid gap-3` 改 `a-rows`，外面包 `<div class="card p-0 overflow-hidden">`。

原：
```html
  <!-- templates -->
  <section class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">課程範本</h2>
      <button id="new-btn" class="btn btn-primary">＋ 新增範本</button>
    </div>
    <div id="templates" class="grid gap-3"></div>
  </section>
```

改為：
```html
  <!-- templates -->
  <section class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">課程範本</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <button id="new-btn" class="btn btn-primary">＋ 新增範本</button>
      </div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="templates" class="a-rows"></div>
    </div>
  </section>
```

#### Step 3: admin.js — `loadTemplates` 拆成「抓取＋統計」與純渲染 `renderTemplates`，列改 `a-row` 骨架＋limitSlice

要點：
- 新增模組變數 `templatesCache`；`loadTemplates` 抓完 API＋算完 stat 後存 `templatesCache = tpls` 再呼叫 `renderTemplates()`——「載入更多」重繪只呼叫 `renderTemplates()`，不重打 API。既有呼叫端（初始化、儲存/刪除後刷新等處呼叫 `loadTemplates()`）語意不變、零改動。
- stat 卡 N+1 迴圈照舊留在 `loadTemplates` 內，一字不動。
- 每筆列保留 `article` 元素與 `.card-title`，class 改 `a-row`；名稱＋badge 進 `.a-row-title`；`card-desc`＋六 meta 收進 `.a-row-sub`；三顆鈕（`.edit-btn`/`.view-btn`/`.del-btn`＋`data-id`）原樣進 `.a-row-actions`。
- `limitSlice('templates', tpls)` 照詞彙 §B 呼叫模式；render 內永遠不帶 reset（本清單無搜尋/篩選，無 reset handler）。
- 空狀態已是 `.empty-state`，僅副文 class 依詞彙 §A 統一為 `subtle text-sm`；`#templates` 現行無「載入中」初始態、錯誤走 toast——照紅線 3 不改資料流、不新增。

原（整段函式）：
```js
async function loadTemplates() {
  const container = document.getElementById('templates');
  try {
    const tpls = await api('/api/admin/templates');

    let totalSessions = 0, totalRegs = 0, totalWaitlist = 0;
    for (const t of tpls) {
      const detail = await api(`/api/admin/templates/${t.id}`);
      totalSessions += detail.sessions.length;
      for (const s of detail.sessions) {
        totalRegs += s.confirmed_count;
        totalWaitlist += s.waitlist_count;
      }
    }
    document.getElementById('stat-templates').textContent = tpls.length;
    document.getElementById('stat-sessions').textContent = totalSessions;
    document.getElementById('stat-regs').textContent = totalRegs;
    document.getElementById('stat-waitlist').textContent = totalWaitlist;

    if (!tpls.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${ICO.book.replace('nk-ico', 'nk-empty-ico')}
          <p>尚無課程範本</p>
          <p class="subtle mt-1">點「＋ 新增範本」建立第一個循環課程</p>
        </div>`;
      return;
    }
    container.innerHTML = tpls.map(t => `
      <article class="card">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div class="flex-1 min-w-[260px]">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="card-title">${escapeHtml(t.name)}</h3>
              <span class="badge badge-${t.status === 'published' ? 'confirmed' : 'completed'}">${t.status === 'published' ? '已發布' : escapeHtml(t.status)}</span>
            </div>
            <p class="card-desc">${escapeHtml(t.description || '')}</p>
            <div class="meta">
              <span class="meta-item">${ICO.calendar} ${dow(t.day_of_week)} ${t.start_time}</span>
              <span class="meta-item">${ICO.clock} ${t.duration_minutes} 分</span>
              <span class="meta-item">${ICO.users} ${t.min_capacity}–${t.max_capacity} 人</span>
              <span class="meta-item">${ICO.coach} ${escapeHtml(t.coach_name || '未指定')}</span>
              <span class="meta-item">${ICO.repeat} ${RECURRENCE_LABEL[t.recurrence]}</span>
              <span class="meta-item">${ICO.range} ${t.cycle_start_date} ~ ${t.cycle_end_date}</span>
            </div>
          </div>
          <div class="flex gap-2">
            <button data-id="${t.id}" class="edit-btn btn btn-ghost btn-sm">編輯</button>
            <button data-id="${t.id}" class="view-btn btn btn-dark btn-sm">查看場次</button>
            <button data-id="${t.id}" class="del-btn btn btn-danger btn-sm">刪除</button>
          </div>
        </div>
      </article>
    `).join('');
    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', () => openEdit(Number(b.dataset.id))));
    container.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => openDrawer(Number(b.dataset.id))));
    container.querySelectorAll('.del-btn').forEach(b => b.addEventListener('click', () => deleteTemplate(Number(b.dataset.id))));
  } catch (e) {
    toast(`載入範本失敗：${e.message}`, 'error');
  }
}
```

改為（完整改後碼，含新函式）：
```js
let templatesCache = [];

async function loadTemplates() {
  try {
    const tpls = await api('/api/admin/templates');

    let totalSessions = 0, totalRegs = 0, totalWaitlist = 0;
    for (const t of tpls) {
      const detail = await api(`/api/admin/templates/${t.id}`);
      totalSessions += detail.sessions.length;
      for (const s of detail.sessions) {
        totalRegs += s.confirmed_count;
        totalWaitlist += s.waitlist_count;
      }
    }
    document.getElementById('stat-templates').textContent = tpls.length;
    document.getElementById('stat-sessions').textContent = totalSessions;
    document.getElementById('stat-regs').textContent = totalRegs;
    document.getElementById('stat-waitlist').textContent = totalWaitlist;

    templatesCache = tpls;
    renderTemplates();
  } catch (e) {
    toast(`載入範本失敗：${e.message}`, 'error');
  }
}

function renderTemplates() {
  const container = document.getElementById('templates');
  const tpls = templatesCache;
  if (!tpls.length) {
    container.innerHTML = `
      <div class="empty-state">
        ${ICO.book.replace('nk-ico', 'nk-empty-ico')}
        <p>尚無課程範本</p>
        <p class="subtle text-sm">點「＋ 新增範本」建立第一個循環課程</p>
      </div>`;
    return;
  }
  const { visible, rest } = limitSlice('templates', tpls);
  container.innerHTML = visible.map(t => `
    <article class="a-row">
      <div class="a-row-main">
        <div class="a-row-title">
          <h3 class="card-title">${escapeHtml(t.name)}</h3>
          <span class="badge badge-${t.status === 'published' ? 'confirmed' : 'completed'}">${t.status === 'published' ? '已發布' : escapeHtml(t.status)}</span>
        </div>
        <div class="a-row-sub">
          <p class="card-desc">${escapeHtml(t.description || '')}</p>
          <div class="meta">
            <span class="meta-item">${ICO.calendar} ${dow(t.day_of_week)} ${t.start_time}</span>
            <span class="meta-item">${ICO.clock} ${t.duration_minutes} 分</span>
            <span class="meta-item">${ICO.users} ${t.min_capacity}–${t.max_capacity} 人</span>
            <span class="meta-item">${ICO.coach} ${escapeHtml(t.coach_name || '未指定')}</span>
            <span class="meta-item">${ICO.repeat} ${RECURRENCE_LABEL[t.recurrence]}</span>
            <span class="meta-item">${ICO.range} ${t.cycle_start_date} ~ ${t.cycle_end_date}</span>
          </div>
        </div>
      </div>
      <div class="a-row-actions">
        <button data-id="${t.id}" class="edit-btn btn btn-ghost btn-sm">編輯</button>
        <button data-id="${t.id}" class="view-btn btn btn-dark btn-sm">查看場次</button>
        <button data-id="${t.id}" class="del-btn btn btn-danger btn-sm">刪除</button>
      </div>
    </article>
  `).join('') + moreButtonHtml('templates', rest);
  container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', () => openEdit(Number(b.dataset.id))));
  container.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => openDrawer(Number(b.dataset.id))));
  container.querySelectorAll('.del-btn').forEach(b => b.addEventListener('click', () => deleteTemplate(Number(b.dataset.id))));
  bindLoadMore(container, () => renderTemplates());
}
```

#### Step 4: 驗證

```bash
node --check /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期：無輸出、exit 0。

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
grep -c 'class="a-sec-head"' public/admin.html
grep -c 'class="a-rows"' public/admin.html
grep -B1 'id="templates"' public/admin.html
grep -c '<article class="a-row">' public/admin.js
grep -c '<article class="card">' public/admin.js
```
預期依序：`2`（課程分類＋課程範本；Task 1 只加 CSS 不加 markup，此時全檔僅此兩處）；`1`；前一行為 `<div class="card p-0 overflow-hidden">` 且 `#templates` 行為 `<div id="templates" class="a-rows"></div>`；`1`；`0`。

```bash
grep -c 'class="edit-btn' public/admin.js
grep -c 'class="view-btn' public/admin.js
grep -c 'class="del-btn' public/admin.js
grep -c "querySelectorAll('.edit-btn')" public/admin.js
grep -c "limitSlice('templates'" public/admin.js
grep -c "moreButtonHtml('templates'" public/admin.js
grep -c 'templatesCache' public/admin.js
grep -c 'id="new-btn"' public/admin.html
grep -c 'id="new-cat-btn"' public/admin.html
```
預期依序：`1`、`1`、`1`（dc- 前綴另計不受影響）、`1`、`1`、`1`、`3`（宣告＋寫入＋讀取）、`1`、`1`。

```bash
grep -n 'card-title' public/admin.js | grep 'a-row' ; grep -A2 'class="a-row-title"' public/admin.js | grep -c 'card-title'
```
預期：後者 `1`（`.card-title` 保留於列名稱元素上，紅線 2 契約完好）。

#### Step 5: Commit

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html public/admin.js
git commit -m "$(cat <<'EOF'
後台課程頁籤一致性改版：範本散卡改單卡包列＋載入更多、標題列統一 a-sec-head

- 課程分類/課程範本兩區塊標題列改 a-sec-head（髮絲尾線＋a-sec-tools 收鈕）
- #templates 容器加 card p-0 外框、class 改 a-rows；loadTemplates 渲染改 a-row 骨架
  （article＋.card-title 保留、六 meta 收 a-row-sub、edit/view/del 鈕進 a-row-actions）
- loadTemplates 拆出 renderTemplates 純渲染＋templatesCache 模組快取；
  範本清單套 limitSlice key=templates，載入更多重繪不重打 API；stat 統計迴圈照舊
- 分類表/統計卡/備份列/modal/drawer 零改動；JS 契約（id/class/dataset）零改動

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 報名作業頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — `#apanel-orders` 面板（行 490–525：待核對匯款／已核對匯款／系統操作 三區塊）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — 行 1294–1324 `loadPendingOrders`、行 1326–1423 三個卡片 html 函式（`orderCardHtml`/`pendingBookingGroupCardHtml`/`pendingBookingCardHtml`）、行 1524–1566 `loadConfirmedPayments`。**行 1425–1522 `bindPendingHandlers` 與行 1568–1602 `bindConfirmedPaymentLongPress` 零改動**（重繪後重綁機制照舊：render 尾端呼叫既有 bind 函式）。

**Interfaces:**
- Consumes（Task 1 已放入檔案）：CSS `.a-sec-head` / `.a-sec-line` / `.a-sec-tools` / `.a-rows` / `.a-row` / `.a-row-main` / `.a-row-title` / `.a-row-sub` / `.a-row-actions` / `.a-more`、既有 `.empty-state`；JS `limitSlice` / `moreButtonHtml` / `bindLoadMore`（key 用 `'pending'`、`'confirmed'`）。
- Produces：無對外介面。新增模組內部變數 `pendingCache` / `confirmedCache` 與函式 `renderPendingOrders()` / `renderConfirmedPayments()`（僅本頁籤自用）。

**紅線提醒**：`article` 元素與 `.card-title` 必留（confirm 對話框靠 `closest('article').querySelector('.card-title')` 取姓名）；`.confirm-order-btn/.cancel-order-btn/.confirm-booking-btn/.cancel-booking-btn/.confirm-booking-group-btn/.cancel-booking-group-btn` class 與 dataset 零改動；`.confirmed-payment-row` class 與全部 `data-*` 零改動；本頁籤無搜尋/篩選，故無 reset 呼叫點——render 內一律 `limitSlice(key, items)` 不帶 reset（詞彙 §B 定案）；載入中/錯誤/空狀態三態照詞彙 §A 統一寫法。

---

**Step 1：讀取兩檔相關段落**

用 Read 讀 `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html`（行 480–530）與 `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js`（行 1290–1610），確認下列各步「原」與現行碼逐字一致後才動手。

---

**Step 2：admin.html — 待核對匯款區改 a-sec-head＋清單容器包卡**

原：

```html
  <!-- pending bank-transfer orders -->
  <section id="pending-orders" class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">待核對匯款</h2>
      <button id="btn-reload-orders" class="btn btn-ghost btn-sm">↻ 重新整理</button>
    </div>
    <div id="pending-orders-list" class="grid gap-3"></div>
  </section>
```

改為：

```html
  <!-- pending bank-transfer orders -->
  <section id="pending-orders" class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">待核對匯款</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <button id="btn-reload-orders" class="btn btn-ghost btn-sm">↻ 重新整理</button>
      </div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="pending-orders-list" class="a-rows"></div>
    </div>
  </section>
```

---

**Step 3：admin.html — 已核對匯款區改 a-sec-head＋清單容器包卡**

原：

```html
  <!-- confirmed payments（已核對匯款，唯讀） -->
  <section id="confirmed-payments" class="mb-10">
    <h2 class="section-title mb-3">已核對匯款</h2>
    <p class="subtle text-sm mb-3" style="margin-top:-6px;">長按卡片可「取消預約並退款」（團課會釋出名額並遞補候補）</p>
    <div id="confirmed-payments-list" class="grid gap-3"></div>
  </section>
```

改為（提示文案逐字保留，不改）：

```html
  <!-- confirmed payments（已核對匯款，唯讀） -->
  <section id="confirmed-payments" class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">已核對匯款</h2>
      <span class="a-sec-line"></span>
    </div>
    <p class="subtle text-sm mb-3" style="margin-top:-6px;">長按卡片可「取消預約並退款」（團課會釋出名額並遞補候補）</p>
    <div class="card p-0 overflow-hidden">
      <div id="confirmed-payments-list" class="a-rows"></div>
    </div>
  </section>
```

---

**Step 4：admin.html — 系統操作標題改 a-sec-head（卡片內容照舊）**

原：

```html
  <!-- ops -->
  <section class="mb-10">
    <h2 class="section-title mb-4">系統操作</h2>
    <div class="card">
```

改為：

```html
  <!-- ops -->
  <section class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">系統操作</h2>
      <span class="a-sec-line"></span>
    </div>
    <div class="card">
```

---

**Step 5：驗證 admin.html**

```bash
sed -n '/id="apanel-orders"/,/id="apanel-members"/p' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html | grep -c "a-sec-head"
```
預期輸出：`3`

```bash
sed -n '/id="apanel-orders"/,/id="apanel-members"/p' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html | grep -c 'class="a-rows"'
```
預期輸出：`2`

```bash
sed -n '/id="apanel-orders"/,/id="apanel-members"/p' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html | grep -c "grid gap-3"
```
預期輸出：`0`

```bash
grep -c 'id="btn-reload-orders"\|id="pending-orders-list"\|id="confirmed-payments-list"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
```
預期輸出：`3`（三個 id 掛載點全數保留）

---

**Step 6：admin.js — `loadPendingOrders` 拆成 載入＋`renderPendingOrders`（key=`'pending'`）**

原（整段函式含頭上註解）：

```js
// --- Pending bank-transfer orders（團課訂單 + 教練課預約 合併清單） ---
async function loadPendingOrders() {
  const container = document.getElementById('pending-orders-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const [orders, bookings] = await Promise.all([
      api('/api/admin/group-orders'),
      api('/api/admin/bookings/pending'),
    ]);
    const items = [
      ...orders.map(o => ({ kind: 'order', created_at: o.created_at, o })),
      ...bookings.map(b => ({ kind: b.group ? 'booking_group' : 'booking', created_at: b.created_at, b })),
    ].sort((a, c) => (a.created_at < c.created_at ? 1 : -1)); // 新→舊
    if (!items.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${ICO.check.replace('nk-ico', 'nk-empty-ico')}
          <p>目前沒有待核對的匯款</p>
        </div>`;
      return;
    }
    container.innerHTML = items.map(it =>
      it.kind === 'order' ? orderCardHtml(it.o)
      : it.kind === 'booking_group' ? pendingBookingGroupCardHtml(it.b)
      : pendingBookingCardHtml(it.b)).join('');
    bindPendingHandlers(container);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}
```

改為（載入中/錯誤改詞彙 §A 統一寫法；空狀態沿用既有 `.empty-state` 不動文案；資料流與 API 呼叫零改動）：

```js
// --- Pending bank-transfer orders（團課訂單 + 教練課預約 合併清單） ---
let pendingCache = [];
async function loadPendingOrders() {
  const container = document.getElementById('pending-orders-list');
  if (!container) return;
  container.innerHTML = '<div class="p-6 subtle text-center">載入中…</div>';
  try {
    const [orders, bookings] = await Promise.all([
      api('/api/admin/group-orders'),
      api('/api/admin/bookings/pending'),
    ]);
    pendingCache = [
      ...orders.map(o => ({ kind: 'order', created_at: o.created_at, o })),
      ...bookings.map(b => ({ kind: b.group ? 'booking_group' : 'booking', created_at: b.created_at, b })),
    ].sort((a, c) => (a.created_at < c.created_at ? 1 : -1)); // 新→舊
    renderPendingOrders();
  } catch (e) {
    container.innerHTML = `<div class="p-6 text-red-500 text-center">${escapeHtml(e.message)}</div>`;
  }
}

function renderPendingOrders() {
  const container = document.getElementById('pending-orders-list');
  if (!container) return;
  if (!pendingCache.length) {
    container.innerHTML = `
      <div class="empty-state">
        ${ICO.check.replace('nk-ico', 'nk-empty-ico')}
        <p>目前沒有待核對的匯款</p>
      </div>`;
    return;
  }
  const { visible, rest } = limitSlice('pending', pendingCache);
  container.innerHTML = visible.map(it =>
    it.kind === 'order' ? orderCardHtml(it.o)
    : it.kind === 'booking_group' ? pendingBookingGroupCardHtml(it.b)
    : pendingBookingCardHtml(it.b)).join('') + moreButtonHtml('pending', rest);
  bindPendingHandlers(container);
  bindLoadMore(container, () => renderPendingOrders());
}
```

---

**Step 7：admin.js — `orderCardHtml` 卡→a-row（函式上半 groups/sessionRows 計算不動，只改 return 模板）**

原：

```js
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(o.customer_name)}</h3>
            <span class="badge badge-confirmed">團課</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(o.customer_phone)}</span>
            <span class="meta-item">${ICO.cash} NT$${Number(o.total_amount).toLocaleString()}</span>
            <span class="meta-item">${ICO.clock} 到期 ${escapeHtml(fmtDate(o.expires_at))}</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${sessionRows}</ul>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-id="${o.id}" class="confirm-order-btn btn btn-primary btn-sm">已收款</button>
          <button data-id="${o.id}" class="cancel-order-btn btn btn-danger btn-sm">取消訂單</button>
        </div>
      </div>
    </article>`;
```

改為：

```js
  return `
    <article class="a-row">
      <div class="a-row-main">
        <div class="a-row-title">
          <h3 class="card-title">${escapeHtml(o.customer_name)}</h3>
          <span class="badge badge-confirmed">團課</span>
          <span class="badge badge-waitlisted">待核對</span>
        </div>
        <div class="a-row-sub">
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(o.customer_phone)}</span>
            <span class="meta-item">${ICO.cash} NT$${Number(o.total_amount).toLocaleString()}</span>
            <span class="meta-item">${ICO.clock} 到期 ${escapeHtml(fmtDate(o.expires_at))}</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${sessionRows}</ul>
        </div>
      </div>
      <div class="a-row-actions">
        <button data-id="${o.id}" class="confirm-order-btn btn btn-primary btn-sm">已收款</button>
        <button data-id="${o.id}" class="cancel-order-btn btn btn-danger btn-sm">取消訂單</button>
      </div>
    </article>`;
```

---

**Step 8：admin.js — `pendingBookingGroupCardHtml` 卡→a-row（函式上半 label/rows 計算不動，只改 return 模板）**

原：

```js
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(g.member_name)}</h3>
            <span class="badge badge-completed">教練課 ×${g.sessions.length} 堂</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(g.member_phone || '')}</span>
            <span class="meta-item">${ICO.cash} 合計 NT$${Number(g.total_amount).toLocaleString()}${g.discount_code ? `（折扣碼 ${escapeHtml(g.discount_code)}）` : ''}</span>
            <span class="meta-item">${ICO.dumbbell} ${escapeHtml(g.coach_display_name)}（${label}）</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${rows}</ul>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-group="${g.group_id}" class="confirm-booking-group-btn btn btn-primary btn-sm">已收款</button>
          <button data-group="${g.group_id}" class="cancel-booking-group-btn btn btn-danger btn-sm">取消預約</button>
        </div>
      </div>
    </article>`;
```

改為：

```js
  return `
    <article class="a-row">
      <div class="a-row-main">
        <div class="a-row-title">
          <h3 class="card-title">${escapeHtml(g.member_name)}</h3>
          <span class="badge badge-completed">教練課 ×${g.sessions.length} 堂</span>
          <span class="badge badge-waitlisted">待核對</span>
        </div>
        <div class="a-row-sub">
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(g.member_phone || '')}</span>
            <span class="meta-item">${ICO.cash} 合計 NT$${Number(g.total_amount).toLocaleString()}${g.discount_code ? `（折扣碼 ${escapeHtml(g.discount_code)}）` : ''}</span>
            <span class="meta-item">${ICO.dumbbell} ${escapeHtml(g.coach_display_name)}（${label}）</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${rows}</ul>
        </div>
      </div>
      <div class="a-row-actions">
        <button data-group="${g.group_id}" class="confirm-booking-group-btn btn btn-primary btn-sm">已收款</button>
        <button data-group="${g.group_id}" class="cancel-booking-group-btn btn btn-danger btn-sm">取消預約</button>
      </div>
    </article>`;
```

---

**Step 9：admin.js — `pendingBookingCardHtml` 卡→a-row（函式上半 label/amount 計算不動，只改 return 模板；此卡無場次 ul，meta 去掉尾端 `mb-2`）**

原：

```js
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(b.member_name)}</h3>
            <span class="badge badge-completed">教練課</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(b.member_phone || '')}</span>
            <span class="meta-item">${ICO.cash} ${amount}</span>
            <span class="meta-item">${ICO.dumbbell} ${escapeHtml(b.coach_display_name)}（${label}）</span>
            <span class="meta-item">${ICO.clock} ${escapeHtml(fmtDate(b.start_at))}</span>
          </div>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-id="${b.id}" class="confirm-booking-btn btn btn-primary btn-sm">已收款</button>
          <button data-id="${b.id}" class="cancel-booking-btn btn btn-danger btn-sm">取消預約</button>
        </div>
      </div>
    </article>`;
```

改為：

```js
  return `
    <article class="a-row">
      <div class="a-row-main">
        <div class="a-row-title">
          <h3 class="card-title">${escapeHtml(b.member_name)}</h3>
          <span class="badge badge-completed">教練課</span>
          <span class="badge badge-waitlisted">待核對</span>
        </div>
        <div class="a-row-sub">
          <div class="meta">
            <span class="meta-item">${ICO.phone} ${escapeHtml(b.member_phone || '')}</span>
            <span class="meta-item">${ICO.cash} ${amount}</span>
            <span class="meta-item">${ICO.dumbbell} ${escapeHtml(b.coach_display_name)}（${label}）</span>
            <span class="meta-item">${ICO.clock} ${escapeHtml(fmtDate(b.start_at))}</span>
          </div>
        </div>
      </div>
      <div class="a-row-actions">
        <button data-id="${b.id}" class="confirm-booking-btn btn btn-primary btn-sm">已收款</button>
        <button data-id="${b.id}" class="cancel-booking-btn btn btn-danger btn-sm">取消預約</button>
      </div>
    </article>`;
```

---

**Step 10：admin.js — `loadConfirmedPayments` 拆成 載入＋`renderConfirmedPayments`（key=`'confirmed'`）＋列改 a-row＋空狀態統一**

原（整段函式含頭上註解）：

```js
// --- 已核對匯款（唯讀）---
async function loadConfirmedPayments() {
  const container = document.getElementById('confirmed-payments-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const list = await api('/api/admin/payments/confirmed');
    if (!list.length) {
      container.innerHTML = '<div class="subtle p-4">尚無已核對的款項</div>';
      return;
    }
    container.innerHTML = list.map(x => {
      const isBooking = x.type === 'booking';
      const isBookingGroup = x.type === 'booking_group';
      const typeBadge = isBookingGroup
        ? `<span class="badge badge-completed">教練課 ×${x.count} 堂${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
        : isBooking
          ? `<span class="badge badge-completed">教練課${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
          : '<span class="badge badge-confirmed">團課</span>';
      const refundBadge = x.refunded_at
        ? '<span class="badge badge-cancelled">已退款</span>'
        : (x.partial_refund ? '<span class="badge badge-cancelled">部分退款</span>' : '');
      const detail = isBooking ? fmtDate(x.detail) : x.detail;
      return `
        <article class="card confirmed-payment-row" data-type="${x.type}" data-id="${x.id}"
                 data-name="${escapeHtml(x.customer_name)}" data-amount="${x.amount ?? ''}"
                 data-refunded="${x.refunded_at ? '1' : '0'}">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap"${x.refunded_at ? ' style="opacity:.55"' : ''}>
              <strong>${escapeHtml(x.customer_name)}</strong>
              ${typeBadge}${refundBadge}
              <span class="subtle text-sm">${escapeHtml(detail || '')}</span>
              <span class="subtle text-sm" style="display:inline-flex;align-items:center;gap:5px;">${ICO.cash.replace('class="nk-ico"', 'style="width:14px;height:14px;flex:none;"')} ${x.amount != null ? 'NT$' + Number(x.amount).toLocaleString() : '—'}${x.refund_sum > 0 && !x.refunded_at ? ' · 已退 NT$' + Number(x.refund_sum).toLocaleString() : ''}</span>
            </div>
            <div class="subtle text-xs">核對 ${escapeHtml(fmtDate(x.paid_at))} · 經手 ${escapeHtml(x.paid_by_name || '—')}</div>
          </div>
        </article>`;
    }).join('');
    bindConfirmedPaymentLongPress(container);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}
```

改為（`.confirmed-payment-row` class 與全部 `data-*` 逐字保留、只把 `card` 換成 `a-row`；退款 opacity 移到 a-row-title 同效；核對時間/經手改放 `.a-row-actions` 內 subtle 字；長按綁定照舊由 render 尾端重綁）：

```js
// --- 已核對匯款（唯讀）---
let confirmedCache = [];
async function loadConfirmedPayments() {
  const container = document.getElementById('confirmed-payments-list');
  if (!container) return;
  container.innerHTML = '<div class="p-6 subtle text-center">載入中…</div>';
  try {
    confirmedCache = await api('/api/admin/payments/confirmed');
    renderConfirmedPayments();
  } catch (e) {
    container.innerHTML = `<div class="p-6 text-red-500 text-center">${escapeHtml(e.message)}</div>`;
  }
}

function renderConfirmedPayments() {
  const container = document.getElementById('confirmed-payments-list');
  if (!container) return;
  if (!confirmedCache.length) {
    container.innerHTML = `
      <div class="empty-state">
        ${ICO.check.replace('nk-ico', 'nk-empty-ico')}
        <p>尚無已核對的款項</p>
      </div>`;
    return;
  }
  const { visible, rest } = limitSlice('confirmed', confirmedCache);
  container.innerHTML = visible.map(x => {
    const isBooking = x.type === 'booking';
    const isBookingGroup = x.type === 'booking_group';
    const typeBadge = isBookingGroup
      ? `<span class="badge badge-completed">教練課 ×${x.count} 堂${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
      : isBooking
        ? `<span class="badge badge-completed">教練課${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
        : '<span class="badge badge-confirmed">團課</span>';
    const refundBadge = x.refunded_at
      ? '<span class="badge badge-cancelled">已退款</span>'
      : (x.partial_refund ? '<span class="badge badge-cancelled">部分退款</span>' : '');
    const detail = isBooking ? fmtDate(x.detail) : x.detail;
    return `
      <article class="a-row confirmed-payment-row" data-type="${x.type}" data-id="${x.id}"
               data-name="${escapeHtml(x.customer_name)}" data-amount="${x.amount ?? ''}"
               data-refunded="${x.refunded_at ? '1' : '0'}">
        <div class="a-row-main">
          <div class="a-row-title"${x.refunded_at ? ' style="opacity:.55"' : ''}>
            <strong>${escapeHtml(x.customer_name)}</strong>
            ${typeBadge}${refundBadge}
            <span class="subtle text-sm">${escapeHtml(detail || '')}</span>
            <span class="subtle text-sm" style="display:inline-flex;align-items:center;gap:5px;">${ICO.cash.replace('class="nk-ico"', 'style="width:14px;height:14px;flex:none;"')} ${x.amount != null ? 'NT$' + Number(x.amount).toLocaleString() : '—'}${x.refund_sum > 0 && !x.refunded_at ? ' · 已退 NT$' + Number(x.refund_sum).toLocaleString() : ''}</span>
          </div>
        </div>
        <div class="a-row-actions">
          <span class="subtle text-xs">核對 ${escapeHtml(fmtDate(x.paid_at))} · 經手 ${escapeHtml(x.paid_by_name || '—')}</span>
        </div>
      </article>`;
  }).join('') + moreButtonHtml('confirmed', rest);
  bindConfirmedPaymentLongPress(container);
  bindLoadMore(container, () => renderConfirmedPayments());
}
```

（註：`bindConfirmedPaymentLongPress` 只選 `.confirmed-payment-row`，`.a-more` 按鈕不會被綁到長按；「載入更多」點擊後 `bindLoadMore` 內部重呼 `renderConfirmedPayments()`，長按與載入更多都會重綁——機制與現狀一致。`#btn-reload-orders` 重新整理沿用兩個 load 函式，不重設 shown 筆數，符合詞彙 §B「僅搜尋/篩選才 reset」。）

---

**Step 11：驗證 admin.js**

```bash
node --check /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期：無輸出、exit code 0

```bash
grep -c '<article class="a-row' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`4`（待核對三型＋已核對一型）

```bash
grep -c "a-row-sub" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`3`

```bash
grep -c 'class="card-title"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`4`（與改版前相同——三張待核對卡＋範本卡，一個都不能少）

```bash
grep -c "confirm-order-btn\|cancel-order-btn" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`4`（改版前後相同）

```bash
grep -c "confirm-booking-btn\|cancel-booking-btn\|confirm-booking-group-btn\|cancel-booking-group-btn" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`8`（改版前後相同）

```bash
grep -c "confirmed-payment-row" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`2`（渲染處＋長按綁定處，改版前後相同）

```bash
grep -c "limitSlice('pending'\|limitSlice('confirmed'" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`2`

```bash
grep -c "moreButtonHtml('pending'\|moreButtonHtml('confirmed'" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`2`

```bash
grep -c "renderPendingOrders\|renderConfirmedPayments" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
```
預期輸出：`6`（各自：定義 1＋load 內呼叫 1＋bindLoadMore 箭頭 1）

```bash
sed -n '1294,1610p' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js | grep -c 'subtle p-4\|p-4 text-red-500'
```
預期輸出：`0`（本頁籤範圍內三態已全數改為 §A 統一寫法；行 1712/1837 的其他頁籤實例不在本任務範圍、不得順手改）

---

**Step 12：Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system && git add public/admin.html public/admin.js && git commit -m "$(cat <<'EOF'
後台報名作業頁籤一致性改版：a-sec-head 標題列＋單卡包列＋載入更多

- 待核對三型卡（團課訂單/教練課單堂/整批）改 a-row 骨架；article、.card-title、確認/取消鈕 class 與 dataset 全保留
- 已核對匯款列改 a-row；confirmed-payment-row class 與 data-* 保留，長按取消退款照舊
- 兩清單容器包 .card.p-0.overflow-hidden、清單容器 class 改 a-rows
- 待核對/已核對套 limitSlice（key=pending/confirmed）＋載入更多；載入中/錯誤/空狀態三態統一
- 三處區塊標題改 a-sec-head（待核對/已核對/系統操作）；系統操作卡內容照舊

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: PR1 收尾（controller 執行）

- [ ] `node --check public/admin.js`；grep 驗證紅線 class 全存在（`.edit-btn/.view-btn/.del-btn/.confirm-order-btn/.cancel-order-btn/.confirmed-payment-row/.card-title`）。
- [ ] 起 localhost（`LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js`），瀏覽器實測課程＋報名作業：分類 CRUD、範本編輯/查看場次/刪除、drawer 補報名/取消、待核對已收款/取消、已核對長按退款、載入更多、`<768px` 檢視。
- [ ] push → draft PR（base main）→ 業主/開發者過目 → merge 後才開 PR2 分支。

---

### Task 5: 會員頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — `#apanel-members` 區塊（現行 main 527–545 行；若前置任務使行號偏移，以下方「原：」逐字內容定位）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — `loadUsers` 一次性綁定區＋錯誤態（現行 633–653 行）、`renderUsersTable`（現行 655–687 行）；`renderUserRow`（689–715 行）與 `bindUserRowLongPress`（719–735 行）**零改動**

**Interfaces:**
- Consumes（Task 1 已放入檔案）：CSS `.a-sec-head`／`.a-sec-line`／`.a-sec-tools`／`.a-search`／`.a-more`；JS `limitSlice`／`moreButtonHtml`／`bindLoadMore`／`_shownMap`（本頁 key＝`'members'`，詞彙 §B 定名）；既有 `.empty-state`＋`svg.nk-empty-ico` CSS 與 `ICO.users`（admin.js 頂部 ICO 集現成鍵）。
- Produces：無。`#user-search`／`#show-archived`／`#users-note`／`#users-table`、`tr.user-row`＋`data-user-id` 長按契約全數照舊（紅線 §C-1）。

**範圍聲明**：表格欄位/列 markup（`renderUserRow`）照舊；只做「工具歸位 a-sec-tools」＋「前 20 筆載入更多」＋「三態照詞彙 §A 統一」；不加新功能、不改互動模式。

---

**Step 1：admin.html — 標題行改 `a-sec-head`，搜尋框/勾選歸位 `a-sec-tools`，`#users-note` 移為區塊下方 subtle 行**

`#user-search` 加 class `a-search` 並移除 inline style（`margin-bottom:0` 由 Task 1 的 `.a-sec-tools .form-input` 規則承接、`max-width:240px` 由 `.a-search` 承接）；label 移除 inline style；`#users-note` 由標題行右側 span 移到卡片下方，改 `<p class="subtle text-sm mt-2">`（沿用薪資頁既有寫法，非新 class；id 不變，JS `textContent` 照常運作）。

原：
```html
    <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
      <div class="flex items-center gap-3 flex-wrap">
        <h2 class="section-title">會員管理</h2>
        <input id="user-search" type="search" class="form-input" placeholder="搜尋姓名或電話…" style="max-width:240px;margin-bottom:0;" autocomplete="off" />
        <label class="subtle" style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap;">
          <input id="show-archived" type="checkbox" /> 顯示已封存
        </label>
      </div>
      <span id="users-note" class="subtle"></span>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="users-table"></div>
    </div>
```

改為：
```html
    <div class="a-sec-head">
      <h2 class="section-title">會員管理</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <input id="user-search" type="search" class="form-input a-search" placeholder="搜尋姓名或電話…" autocomplete="off" />
        <label class="subtle">
          <input id="show-archived" type="checkbox" /> 顯示已封存
        </label>
      </div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="users-table"></div>
    </div>
    <p id="users-note" class="subtle text-sm mt-2"></p>
```

---

**Step 2：admin.js — 搜尋/勾選 handler 先重設 `'members'` 分頁狀態（詞彙 §B 定案模式）**

只動這兩行；同區塊緊鄰的 `line-search`／`line-filter` 兩行屬 LINE 頁籤任務，**不碰**。

原：
```js
    document.getElementById('user-search')?.addEventListener('input', renderUsersTable);
    document.getElementById('show-archived')?.addEventListener('change', renderUsersTable);
```

改為：
```js
    document.getElementById('user-search')?.addEventListener('input', () => { _shownMap.delete('members'); renderUsersTable(); });
    document.getElementById('show-archived')?.addEventListener('change', () => { _shownMap.delete('members'); renderUsersTable(); });
```

---

**Step 3：admin.js — `loadUsers` 錯誤態補 `text-center`（詞彙 §A 錯誤態統一寫法）**

原：
```js
    document.getElementById('users-table').innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
```

改為：
```js
    document.getElementById('users-table').innerHTML = `<div class="p-6 text-red-500 text-center">${escapeHtml(e.message)}</div>`;
```

---

**Step 4：admin.js — `renderUsersTable` 套 `limitSlice('members')`＋空狀態統一**

在 filtered 陣列（`rows`）之後 slice；表格 html 用 `visible` 產生；`moreButtonHtml` 接在 table 字串之後（同在 `#users-table` 卡內）；`bindLoadMore` 重繪呼叫 `renderUsersTable`；render 內 `limitSlice` 永遠不帶 reset（重設只在 Step 2 的 handler）。素字空狀態依詞彙 §A 改 `.empty-state`：ICO 沿用 admin.js 既有 ICO 集的 `users` 鍵（會員語意；寫法逐字比照檔內既有 `ICO.book.replace('nk-ico', 'nk-empty-ico')` 模式）；空狀態文案照舊不改。`bindUserRowLongPress(el)` 照舊（作用於 visible 列即可）。

原（完整函式）：
```js
function renderUsersTable() {
  const el = document.getElementById('users-table');
  if (!el) return;
  const q = (document.getElementById('user-search')?.value || '').trim().toLowerCase();
  const showArchived = !!document.getElementById('show-archived')?.checked;

  let rows = allUsers;
  if (!showArchived) rows = rows.filter(r => !r.archived_at);
  if (q) rows = rows.filter(r =>
    (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));

  if (!rows.length) {
    el.innerHTML = `<div class="p-6 subtle text-center">${q || showArchived ? '無符合的會員' : '無會員'}</div>`;
    return;
  }

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th style="width:60px;">ID</th>
        <th>姓名</th>
        <th>Email / 手機</th>
        <th>登入方式</th>
        <th>角色</th>
        <th>加入時間</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => renderUserRow(r)).join('')}
      </tbody>
    </table>`;

  bindUserRowLongPress(el);
}
```

改為（完整函式）：
```js
function renderUsersTable() {
  const el = document.getElementById('users-table');
  if (!el) return;
  const q = (document.getElementById('user-search')?.value || '').trim().toLowerCase();
  const showArchived = !!document.getElementById('show-archived')?.checked;

  let rows = allUsers;
  if (!showArchived) rows = rows.filter(r => !r.archived_at);
  if (q) rows = rows.filter(r =>
    (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));

  if (!rows.length) {
    el.innerHTML = `
      <div class="empty-state">
        ${ICO.users.replace('nk-ico', 'nk-empty-ico')}
        <p>${q || showArchived ? '無符合的會員' : '無會員'}</p>
      </div>`;
    return;
  }

  const { visible, rest } = limitSlice('members', rows);

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th style="width:60px;">ID</th>
        <th>姓名</th>
        <th>Email / 手機</th>
        <th>登入方式</th>
        <th>角色</th>
        <th>加入時間</th>
      </tr></thead>
      <tbody>
        ${visible.map(r => renderUserRow(r)).join('')}
      </tbody>
    </table>` + moreButtonHtml('members', rest);

  bindLoadMore(el, () => renderUsersTable());
  bindUserRowLongPress(el);
}
```

---

**Step 5：驗證（詞彙 §D；任務內不用瀏覽器）**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system

node --check public/admin.js
# 預期：無輸出、exit 0

grep -n 'id="user-search"' public/admin.html
# 預期：恰 1 行，class="form-input a-search"，且該行不含 style=
grep -c 'id="user-search"[^>]*style=' public/admin.html
# 預期：0
grep -A2 'id="user-search"' public/admin.html
# 預期：後續 label 行不含 style=
grep -n 'id="users-note"' public/admin.html
# 預期：恰 1 行，<p id="users-note" class="subtle text-sm mt-2">，位於 users-table 卡片之後

grep -c "_shownMap.delete('members')" public/admin.js   # 預期：2（兩個 handler）
grep -c "limitSlice('members'" public/admin.js          # 預期：1
grep -c "moreButtonHtml('members'" public/admin.js      # 預期：1
grep -c "renderUsersTable" public/admin.js              # 預期：5（定義+loadUsers 呼叫+2 handler+bindLoadMore 重繪）

# 契約 class/選擇器仍在（紅線 §C-1）：
grep -c 'class="user-row' public/admin.js               # 預期：1（renderUserRow 照舊）
grep -c 'data-user-id' public/admin.js                  # 預期：2（與改動前相同）
grep -c 'bindUserRowLongPress' public/admin.js          # 預期：2（定義+呼叫，照舊）
grep -n "ICO.users.replace('nk-ico', 'nk-empty-ico')" public/admin.js
# 預期：恰 1 行，位於 renderUsersTable 內
```

---

**Step 6：Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html public/admin.js
git commit -m "$(cat <<'EOF'
會員頁籤一致性改版：a-sec-head 工具歸位＋前20載入更多

- 搜尋框/顯示已封存移入 .a-sec-tools（a-search 取代 inline style）
- #users-note 移為區塊下方 subtle 行（id 不變）
- renderUsersTable 套 limitSlice('members')＋moreButtonHtml＋bindLoadMore
- 搜尋/勾選 handler 先 _shownMap.delete('members') 重設分頁
- 空狀態改 .empty-state＋ICO.users、錯誤態補 text-center（三態統一）
- 表格欄位、tr.user-row 長按編輯契約零改動

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: LINE 管理頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — `#apanel-line` 區塊（現行 main 約 741–759 行）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — `loadUsers` 內 line 搜尋/篩選事件綁定（約 641–642 行）＋ `renderLineTable`（約 743–790 行）

**Interfaces:**
- Consumes（Task 1 已放入檔案，直接使用）：CSS class `.a-sec-head`、`.a-sec-line`、`.a-sec-tools`、`.a-search`、`.a-filter`、`.a-more`、`.empty-state`／`nk-empty-ico`；JS helper `limitSlice()`、`moreButtonHtml()`、`bindLoadMore()`、`_shownMap`（本頁 key＝`'line'`）
- Produces: 無

行號僅為現行 main 錨點；每個編輯以「原」逐字比對定位（本任務的原文段落與其他任務不重疊——相鄰的 639–640 行 `user-search`/`show-archived` 綁定屬會員頁任務，勿碰）。

**Step 1：admin.html — 標題列改 `a-sec-head`、搜尋/篩選歸位 `a-sec-tools`、右側說明移為標題列下方獨立 subtle 行**

原：

```html
    <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
      <div class="flex items-center gap-3 flex-wrap">
        <h2 class="section-title">LINE 綁定管理</h2>
        <input id="line-search" type="search" class="form-input" placeholder="搜尋姓名或電話…" style="max-width:240px;margin-bottom:0;" autocomplete="off" />
        <select id="line-filter" class="form-input" style="max-width:140px;margin-bottom:0;">
          <option value="all">全部</option>
          <option value="bound">已綁定</option>
          <option value="unbound">未綁定</option>
        </select>
      </div>
      <span class="subtle" style="font-size:13px;">解除綁定後，請該使用者用正確號碼重新綁定</span>
    </div>
```

改為：

```html
    <div class="a-sec-head">
      <h2 class="section-title">LINE 綁定管理</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <input id="line-search" type="search" class="form-input a-search" placeholder="搜尋姓名或電話…" autocomplete="off" />
        <select id="line-filter" class="form-input a-filter">
          <option value="all">全部</option>
          <option value="bound">已綁定</option>
          <option value="unbound">未綁定</option>
        </select>
      </div>
    </div>
    <p class="subtle text-sm mb-3">解除綁定後，請該使用者用正確號碼重新綁定</p>
```

說明：inline `style="max-width:…;margin-bottom:0;"` 由 Task 1 的 `.a-search`/`.a-filter`/`.a-sec-tools .form-input{margin-bottom:0}` 承接；`style="font-size:13px;"` 由 `text-sm` 承接（`p class="subtle text-sm mb-3"` 為後台既有慣用寫法，同 503–504 行「已核對匯款」註記）。`#line-search`、`#line-filter`、`#line-table` 三個 id 一字不改。卡包 `<div class="card p-0 overflow-hidden"><div id="line-table"></div></div>` 照舊不動。

**Step 2：admin.js — 搜尋/篩選 handler 先 `_shownMap.delete('line')` 再呼叫原 render（詞彙 §B 定案模式）**

原：

```js
    document.getElementById('line-search')?.addEventListener('input', renderLineTable);
    document.getElementById('line-filter')?.addEventListener('change', renderLineTable);
```

改為：

```js
    document.getElementById('line-search')?.addEventListener('input', () => { _shownMap.delete('line'); renderLineTable(); });
    document.getElementById('line-filter')?.addEventListener('change', () => { _shownMap.delete('line'); renderLineTable(); });
```

**Step 3：admin.js — `renderLineTable` 套 `limitSlice`（key＝`'line'`，同 members 模式）＋空狀態改詞彙 §A 統一寫法**

整個函式替換。原（743–790 行，逐字）：

```js
function renderLineTable() {
  const el = document.getElementById('line-table');
  if (!el) return;
  const q = (document.getElementById('line-search')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('line-filter')?.value || 'all';

  let rows = allUsers || [];
  if (q) rows = rows.filter(r => (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));
  if (filter === 'bound') rows = rows.filter(r => !!r.line_user_id);
  else if (filter === 'unbound') rows = rows.filter(r => !r.line_user_id);

  if (!rows.length) { el.innerHTML = `<div class="p-6 subtle text-center">無符合的使用者</div>`; return; }

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th style="width:60px;">ID</th>
        <th>姓名</th>
        <th>角色</th>
        <th>手機</th>
        <th>LINE 綁定</th>
        <th style="width:120px;"></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const archived = !!r.archived_at;
          const archBadge = archived ? ' <span class="badge badge-cancelled" style="font-size:10px;">已封存</span>' : '';
          const bound = !!r.line_user_id;
          const statusBadge = bound
            ? '<span class="badge badge-open">已綁定</span>'
            : '<span class="badge badge-completed">未綁定</span>';
          const action = bound
            ? `<button class="btn btn-danger btn-sm" data-line-unbind="${r.id}">解除綁定</button>`
            : '';
          return `<tr${archived ? ' style="opacity:0.55;"' : ''}>
            <td data-label="ID" class="subtle cell-id">#${r.id}</td>
            <td data-label="姓名" class="cell-name"><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
            <td data-label="角色">${lineRoleBadge(r)}</td>
            <td data-label="手機" class="subtle">${escapeHtml(r.phone || '')}</td>
            <td data-label="LINE 綁定">${statusBadge}</td>
            <td data-label="操作">${action}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  el.querySelectorAll('[data-line-unbind]').forEach(btn => btn.addEventListener('click', () => doLineUnbind(Number(btn.dataset.lineUnbind))));
}
```

改為：

```js
function renderLineTable() {
  const el = document.getElementById('line-table');
  if (!el) return;
  const q = (document.getElementById('line-search')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('line-filter')?.value || 'all';

  let rows = allUsers || [];
  if (q) rows = rows.filter(r => (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));
  if (filter === 'bound') rows = rows.filter(r => !!r.line_user_id);
  else if (filter === 'unbound') rows = rows.filter(r => !r.line_user_id);

  if (!rows.length) {
    el.innerHTML = `
      <div class="empty-state">
        ${ICO.users.replace('nk-ico', 'nk-empty-ico')}
        <p>無符合的使用者</p>
        <p class="subtle text-sm">調整搜尋或篩選條件後再試</p>
      </div>`;
    return;
  }

  const { visible, rest } = limitSlice('line', rows);

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th style="width:60px;">ID</th>
        <th>姓名</th>
        <th>角色</th>
        <th>手機</th>
        <th>LINE 綁定</th>
        <th style="width:120px;"></th>
      </tr></thead>
      <tbody>
        ${visible.map(r => {
          const archived = !!r.archived_at;
          const archBadge = archived ? ' <span class="badge badge-cancelled" style="font-size:10px;">已封存</span>' : '';
          const bound = !!r.line_user_id;
          const statusBadge = bound
            ? '<span class="badge badge-open">已綁定</span>'
            : '<span class="badge badge-completed">未綁定</span>';
          const action = bound
            ? `<button class="btn btn-danger btn-sm" data-line-unbind="${r.id}">解除綁定</button>`
            : '';
          return `<tr${archived ? ' style="opacity:0.55;"' : ''}>
            <td data-label="ID" class="subtle cell-id">#${r.id}</td>
            <td data-label="姓名" class="cell-name"><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
            <td data-label="角色">${lineRoleBadge(r)}</td>
            <td data-label="手機" class="subtle">${escapeHtml(r.phone || '')}</td>
            <td data-label="LINE 綁定">${statusBadge}</td>
            <td data-label="操作">${action}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` + moreButtonHtml('line', rest);

  bindLoadMore(el, () => renderLineTable());
  el.querySelectorAll('[data-line-unbind]').forEach(btn => btn.addEventListener('click', () => doLineUnbind(Number(btn.dataset.lineUnbind))));
}
```

說明：
- 列 markup（`data-label`／`cell-id`／`cell-name`／badge／`data-line-unbind`）一字不改——`.data-table` RWD 契約與紅線 §C-1 全保留；`[data-line-unbind]` 維持逐顆 `addEventListener` 綁定照舊。
- render 內 `limitSlice('line', rows)` 永遠不帶 reset；重設只發生在 Step 2 的 handler（詞彙 §B 定案）。「載入更多」點擊經 `bindLoadMore` 重呼叫 `renderLineTable()`，重繪後解綁鈕由函式尾端重新綁定，無殘留 listener 問題（innerHTML 整塊重建）。
- 空狀態由素字改詞彙 §A 統一寫法（`.empty-state`＋既有 `ICO.users` 轉 `nk-empty-ico`＋主文＋`subtle text-sm` 副文），沿用既有文案「無符合的使用者」。
- `doLineUnbind` 及其 `renderLineTable()` 回呼、`lineRoleBadge` 均不動。

**Step 4：驗證**

```bash
node --check /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：無輸出、exit 0

grep -c "_shownMap.delete('line')" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：2（input + change 兩個 handler）

grep -c "limitSlice('line'" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1

grep -c "moreButtonHtml('line'" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1

grep -c 'data-line-unbind' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：2（模板字串產出 + querySelectorAll 委派，契約 class 仍在）

grep -n 'id="line-search"\|id="line-filter"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：各 1 行，class 分別含 form-input a-search / form-input a-filter，且兩行皆不含 style=

grep -A2 'section-title">LINE 綁定管理' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：緊接 <span class="a-sec-line"></span> 與 <div class="a-sec-tools">

grep -c '<p class="subtle text-sm mb-3">解除綁定後，請該使用者用正確號碼重新綁定</p>' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：1

grep -c 'id="line-table"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：1
```

瀏覽器驗證由 controller 於本批 PR 完成後統一執行（任務內不用瀏覽器）。

**Step 5：Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html public/admin.js
git commit -m "$(cat <<'EOF'
後台 LINE 管理頁籤一致性改版：a-sec-head 標題列＋搜尋/篩選歸位 tools＋說明移 subtle 行＋前20筆載入更多

- 標題列改 .a-sec-head（section-title＋a-sec-line 尾線＋a-sec-tools），#line-search/#line-filter 去 inline style 改 a-search/a-filter
- 右側說明文字移為標題列下方獨立 subtle text-sm mb-3 行
- renderLineTable 套 limitSlice key='line'（handler _shownMap.delete 後重呼叫 render）＋moreButtonHtml/bindLoadMore
- 空狀態改統一 .empty-state（ICO.users）；[data-line-unbind] 逐顆綁定與 data-table RWD 契約零改動

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 通知頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — `#apanel-notifs` 區段（現行 main 約 730–739 行；行號僅為錨點，編輯以下方「原：」逐字匹配為準）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — `loadNotifs`（現行 main 約 93–110 行）

**Interfaces:**
- Consumes（Task 1 已放入檔案，直接使用）：CSS `.a-sec-head`／`.a-sec-line`／`.a-sec-tools`／`.a-more`（後者由 `moreButtonHtml` 產出）；JS helper `limitSlice`／`moreButtonHtml`／`bindLoadMore`，key 固定 `'notifs'`（詞彙 §B key 清單）；既有 `.empty-state` 樣式與 `ICO.check`（admin.js 頂部 `const ICO`，沿用現有 ICO、不新增 SVG）。
- Produces：無（`notifsCache`／`renderNotifs` 為 admin.js 模組內部，無其他任務依賴）。

範圍備註（照 spec §3 通知列、不擴不縮）：
- 通知頁**沒有**搜尋/篩選（YAGNI 明列「通知不加篩選」），故**不需要** reset handler；`renderNotifs` 內永遠 `limitSlice('notifs', notifsCache)` 不帶 reset，完全符合詞彙 §B 定案。
- 現行流程無「載入中」初始態，**不新增**（紅線 3：不改資料流、不加新功能）；錯誤態補 `text-center` 對齊詞彙 §A；素字空狀態「無紀錄」依 §A 改 `.empty-state` 結構（文案照舊、ICO 沿用既有 `ICO.check`）。
- 三個呼叫點 `loadNotifs()`（admin.js 約 617、626、2448 行）零改動。
- 表格模板（thead/五欄 `data-label`/`cell-span`/badge）逐字照舊，僅 `rows` 改為 `visible`。

#### Step 1：admin.html — 標題列改 a-sec-head、註記移尾側、#notifs 拿掉內捲 class

原：

```html
  <!-- notifications -->
  <section class="pb-16">
    <h2 class="section-title mb-4">通知紀錄 <span class="subtle">(最近 100 筆)</span></h2>
    <div class="card p-0 overflow-hidden">
      <div id="notifs" class="max-h-96 overflow-auto"></div>
    </div>
  </section>
```

改為：

```html
  <!-- notifications -->
  <section class="pb-16">
    <div class="a-sec-head">
      <h2 class="section-title">通知紀錄</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools"><span class="subtle text-sm">(最近 100 筆)</span></div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="notifs"></div>
    </div>
  </section>
```

（`h2` 的 `mb-4` 移除：`.a-sec-head` 自帶 `margin-bottom:16px`。`#notifs` id 保留，class 整個拿掉。）

#### Step 2：admin.js — loadNotifs 拆成 notifsCache＋renderNotifs，套 limitSlice key='notifs'

原：

```js
async function loadNotifs() {
  try {
    const rows = await api('/api/admin/notifications');
    const el = document.getElementById('notifs');
    if (!rows.length) { el.innerHTML = '<div class="p-6 subtle text-center">無紀錄</div>'; return; }
    el.innerHTML = '<table class="data-table"><thead><tr><th>時間</th><th>收件者</th><th>類型</th><th>通道</th><th>主旨</th></tr></thead><tbody>' +
      rows.map(r => `
        <tr>
          <td data-label="時間" class="subtle">${fmtDate(r.sent_at)}</td>
          <td data-label="收件者">${escapeHtml(r.email)}</td>
          <td data-label="類型"><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td data-label="通道">${escapeHtml(r.channel)}</td>
          <td data-label="主旨" class="cell-span">${escapeHtml(r.subject)}</td>
        </tr>`).join('') + '</tbody></table>';
  } catch (e) {
    document.getElementById('notifs').innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}
```

改為（完整改後段落；列模板字串內部縮排逐字保留，輸出 HTML 位元組不變）：

```js
let notifsCache = [];

async function loadNotifs() {
  try {
    notifsCache = await api('/api/admin/notifications');
    renderNotifs();
  } catch (e) {
    document.getElementById('notifs').innerHTML = `<div class="p-6 text-red-500 text-center">${escapeHtml(e.message)}</div>`;
  }
}

function renderNotifs() {
  const el = document.getElementById('notifs');
  if (!notifsCache.length) {
    el.innerHTML = `
      <div class="empty-state">
        ${ICO.check.replace('nk-ico', 'nk-empty-ico')}
        <p>無紀錄</p>
      </div>`;
    return;
  }
  const { visible, rest } = limitSlice('notifs', notifsCache);
  el.innerHTML = '<table class="data-table"><thead><tr><th>時間</th><th>收件者</th><th>類型</th><th>通道</th><th>主旨</th></tr></thead><tbody>' +
    visible.map(r => `
        <tr>
          <td data-label="時間" class="subtle">${fmtDate(r.sent_at)}</td>
          <td data-label="收件者">${escapeHtml(r.email)}</td>
          <td data-label="類型"><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td data-label="通道">${escapeHtml(r.channel)}</td>
          <td data-label="主旨" class="cell-span">${escapeHtml(r.subject)}</td>
        </tr>`).join('') + '</tbody></table>' + moreButtonHtml('notifs', rest);
  bindLoadMore(el, () => renderNotifs());
}
```

（呼叫模式照詞彙 §B：`limitSlice` → innerHTML 尾接 `moreButtonHtml` → `bindLoadMore(el, () => renderNotifs())`。無搜尋/篩選故無 `_shownMap.delete('notifs')` 場景。）

#### Step 3：驗證

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
node --check public/admin.js
# 預期：無輸出（exit 0）

grep -c "max-h-96" public/admin.html
# 預期：0（grep exit code 1，全檔已無此 class）

grep -n 'id="notifs"' public/admin.html
# 預期：恰 1 行，內容為 <div id="notifs"></div>（無 class）

grep -c "最近 100 筆" public/admin.html
# 預期：1（已在 a-sec-tools 內的 span.subtle.text-sm）

grep -c "limitSlice('notifs'" public/admin.js
# 預期：1

grep -c "moreButtonHtml('notifs'" public/admin.js
# 預期：1

grep -c "renderNotifs" public/admin.js
# 預期：3（function 定義＋loadNotifs 內呼叫＋bindLoadMore rerender）

grep -c "notifsCache" public/admin.js
# 預期：4（宣告＋賦值＋length 判斷＋limitSlice 引數）

grep -c 'data-label="通道"' public/admin.js
# 預期：1（通知表格列模板契約未動）

grep -c 'data-label="主旨" class="cell-span"' public/admin.js
# 預期：1（cell-span RWD 契約仍在）

grep -c "loadNotifs()" public/admin.js
# 預期：4（async function 定義行＋617/626/2448 三個呼叫點，零改動）
```

#### Step 4：Commit

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html public/admin.js
git commit -m "$(cat <<'EOF'
後台通知頁籤一致性改版：a-sec-head 標題列＋移除內捲＋前 20 筆載入更多

- #notifs 拿掉 max-h-96 overflow-auto 內捲，改一頁到底＋limitSlice('notifs') 前 20 筆＋「載入更多」
- 「(最近 100 筆)」自 h2 內移至 a-sec-head 尾側 a-sec-tools 的 subtle text-sm 字
- loadNotifs 拆 notifsCache＋renderNotifs（抓完呼叫 render）；空/錯誤態統一詞彙寫法；表格模板照舊

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7b: PR2 收尾（controller 執行）

- [ ] PR1 merge 後自 main 開 `feature/admin-ui-consistency-2`，執行 Task 5–7。
- [ ] `node --check`；grep 驗證 `tr.user-row/[data-line-unbind]/#notifs` 契約。
- [ ] 瀏覽器實測：會員搜尋/已封存篩選/長按編輯（含方案子區）、LINE 搜尋/篩選/解除綁定、通知表無內捲、三清單載入更多與搜尋重設。
- [ ] push → draft PR → 過目 → merge。

---

### Task 8: 折扣碼頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html`（折扣碼頁籤 panel：約 577–694 行，`#apanel-discounts` 內）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js`（`// --- Discount codes ---` 段：約 1708–1839 行，`loadDiscountCodes`）

**Interfaces:**
- Consumes（Task 1 已放入檔案，直接使用）：CSS class `.a-sec-head`／`.a-sec-line`／`.a-rows`／`.a-row`／`.a-row-main`／`.a-row-title`／`.a-row-sub`／`.a-row-actions`／`.a-more`、空狀態三態統一寫法；JS helper `limitSlice`／`moreButtonHtml`／`bindLoadMore`（key 用 `'discounts'`）。
- Produces：`renderDiscountCodes()`（模組內重繪函式，供 `loadDiscountCodes` 與 `bindLoadMore` 回呼使用）、模組層快取 `discountCodesCache`（現行碼**沒有** codesCache——`codes` 是 `loadDiscountCodes` 內的區域變數——故需新增，拆分方式同前面頁籤任務的「fetch 進快取＋純重繪函式」模式）。

**範圍備註（不擴不縮）：**
- 本頁籤**無搜尋/篩選**，故不需要詞彙 §B 的 reset handler（`_shownMap.delete`）；render 內永遠 `limitSlice('discounts', codes)` 不帶 reset。
- JS 契約零改動：`#discount-codes-list` 掛載點、`.dc-toggle-btn`/`.dc-edit-btn`/`.dc-del-btn` 與其 `data-id`/`data-active`、`article` 元素與 `.card-title`（`btn.closest('article')` 依賴）、逐鈕 addEventListener 綁定方式、API 呼叫、confirm 文案，全部照舊。
- 表單卡（`#discount-code-form`）內容與雜項設定卡的欄位/按鈕/inline style 皆不動，只改各卡標題元素。

---

**Step 1：admin.html — 「折扣碼管理」標題列改 `a-sec-head`（去空殼 justify-between）**

原：
```html
  <!-- discount codes -->
  <section id="discount-codes" class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">折扣碼管理</h2>
    </div>
```

改為：
```html
  <!-- discount codes -->
  <section id="discount-codes" class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">折扣碼管理</h2>
      <span class="a-sec-line"></span>
    </div>
```

（無右側工具，依詞彙 §A 規則省略 `.a-sec-tools`；`.a-sec-head` 自帶 margin-bottom:16px，故不再加 `mb-4`。）

**Step 2：admin.html — 設定卡標題「1對1 / 1對2 單堂價」`div.font-semibold`→`h3.card-title`**

原：
```html
    <!-- 1對1 / 1對2 single-session price -->
    <div class="card mb-4">
      <div class="font-semibold mb-3">1對1 / 1對2 單堂價</div>
```

改為：
```html
    <!-- 1對1 / 1對2 single-session price -->
    <div class="card mb-4">
      <h3 class="card-title mb-3">1對1 / 1對2 單堂價</h3>
```

**Step 3：admin.html — 設定卡標題「收款與 LINE 設定」`div.font-semibold`→`h3.card-title`**

原：
```html
    <!-- 收款帳號 + 官方 LINE 連結（顯示於報名成功頁）-->
    <div class="card mb-4">
      <div class="font-semibold mb-3">收款與 LINE 設定</div>
```

改為：
```html
    <!-- 收款帳號 + 官方 LINE 連結（顯示於報名成功頁）-->
    <div class="card mb-4">
      <h3 class="card-title mb-3">收款與 LINE 設定</h3>
```

**Step 4：admin.html — 設定卡標題「Google 日曆與時段容量」`div.font-semibold`→`h3.card-title`**

原：
```html
    <!-- Google 日曆整合 + 時段容量 -->
    <div class="card mb-4">
      <div class="font-semibold mb-3">Google 日曆與時段容量</div>
```

改為：
```html
    <!-- Google 日曆整合 + 時段容量 -->
    <div class="card mb-4">
      <h3 class="card-title mb-3">Google 日曆與時段容量</h3>
```

**Step 5：admin.html — 「建立折扣碼」`h3.font-semibold`→`h3.card-title`**

原：
```html
    <!-- create discount code form -->
    <div class="card mb-4">
      <h3 class="font-semibold mb-3">建立折扣碼</h3>
```

改為：
```html
    <!-- create discount code form -->
    <div class="card mb-4">
      <h3 class="card-title mb-3">建立折扣碼</h3>
```

**Step 6：admin.html — 列表容器散卡 grid→單卡包列**

`#discount-codes-list` id 保留（JS 掛載點契約），class 改 `a-rows`，外包 `.card.p-0.overflow-hidden`：

原：
```html
    <!-- discount codes list -->
    <div id="discount-codes-list" class="grid gap-3"></div>
  </section>
```

改為：
```html
    <!-- discount codes list -->
    <div class="card p-0 overflow-hidden">
      <div id="discount-codes-list" class="a-rows"></div>
    </div>
  </section>
```

**Step 7：admin.js — `loadDiscountCodes` 拆分為 fetch＋`renderDiscountCodes()`，列改 `a-row`，套 `limitSlice('discounts')`**

整段函式替換（原＝現行 `// --- Discount codes ---` 起至 `loadDiscountCodes` 結尾整個函式；三態改詞彙 §A 統一寫法；`article` 與 `.card-title` 保留；badge 進 `a-row-title`、meta 進 `a-row-sub`、三鈕進 `a-row-actions`；事件綁定程式碼逐字照舊、僅隨函式拆分改基準縮排）。

原：
```js
// --- Discount codes ---
async function loadDiscountCodes() {
  const container = document.getElementById('discount-codes-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const codes = await api('/api/admin/discount-codes');
    if (!codes.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${ICO.tag.replace('nk-ico', 'nk-empty-ico')}
          <p>尚無折扣碼</p>
          <p class="subtle mt-1">使用上方表單建立第一個折扣碼</p>
        </div>`;
      return;
    }
    container.innerHTML = codes.map(c => {
      const typeLabel = c.discount_type === 'percent' ? `減 ${c.discount_value}%` : `減 $${c.discount_value}`;
      const usageText = c.max_uses != null ? `${c.used_count}/${c.max_uses}` : `已用 ${c.used_count}`;
      const limits = [];
      if (c.valid_from || c.valid_until) {
        limits.push(`有效期：${escapeHtml(c.valid_from || '—')} ~ ${escapeHtml(c.valid_until || '—')}`);
      }
      limits.push(`使用量：${usageText}`);
      if (c.per_phone_limit != null) limits.push(`每人上限 ${c.per_phone_limit} 次`);
      if (c.min_amount != null) limits.push(`最低 NT$${c.min_amount}`);
      return `
        <article class="card" data-code-id="${c.id}">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex-1 min-w-[220px]">
              <div class="flex items-center gap-2 mb-1 flex-wrap">
                <h3 class="card-title font-mono">${escapeHtml(c.code)}</h3>
                <span class="badge badge-${c.discount_type === 'percent' ? 'confirmed' : 'waitlisted'}">${escapeHtml(typeLabel)}</span>
                <span class="badge badge-${c.active ? 'open' : 'completed'}">${c.active ? '啟用中' : '已停用'}</span>
              </div>
              <div class="meta flex-wrap">
                ${limits.map(l => `<span class="meta-item">${escapeHtml(l)}</span>`).join('')}
              </div>
              ${c.note ? `<p class="subtle text-xs mt-1">${escapeHtml(c.note)}</p>` : ''}
            </div>
            <div class="flex gap-2 flex-wrap">
              <button
                data-id="${c.id}"
                data-active="${c.active}"
                class="dc-toggle-btn btn btn-ghost btn-sm"
              >${c.active ? '停用' : '啟用'}</button>
              <button data-id="${c.id}" class="dc-edit-btn btn btn-ghost btn-sm">編輯</button>
              <button data-id="${c.id}" class="dc-del-btn btn btn-danger btn-sm">刪除</button>
            </div>
          </div>
        </article>`;
    }).join('');

    // toggle active/inactive
    container.querySelectorAll('.dc-toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const newActive = btn.dataset.active === '1' || btn.dataset.active === 'true' ? 0 : 1;
        const code = btn.closest('article');
        // collect current values from the rendered card to send full payload
        const codeData = codes.find(c => c.id === id);
        if (!codeData) return;
        try {
          await api(`/api/admin/discount-codes/${id}`, {
            method: 'PATCH',
            body: {
              discount_type: codeData.discount_type,
              discount_value: codeData.discount_value,
              active: newActive,
              valid_from: codeData.valid_from ?? '',
              valid_until: codeData.valid_until ?? '',
              max_uses: codeData.max_uses ?? '',
              per_phone_limit: codeData.per_phone_limit ?? '',
              min_amount: codeData.min_amount ?? '',
              note: codeData.note ?? '',
            },
          });
          toast(`折扣碼已${newActive ? '啟用' : '停用'}`, 'success');
          loadDiscountCodes();
        } catch (e) {
          toast(`操作失敗：${escapeHtml(e.message)}`, 'error');
        }
      });
    });

    // edit: populate form
    container.querySelectorAll('.dc-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const codeData = codes.find(c => c.id === id);
        if (!codeData) return;
        document.getElementById('discount-code-edit-id').value = id;
        document.getElementById('dc-code').value = codeData.code;
        document.getElementById('dc-code').readOnly = true;
        document.getElementById('dc-type').value = codeData.discount_type;
        document.getElementById('dc-value').value = codeData.discount_value;
        document.getElementById('dc-valid-from').value = codeData.valid_from ?? '';
        document.getElementById('dc-valid-until').value = codeData.valid_until ?? '';
        document.getElementById('dc-max-uses').value = codeData.max_uses ?? '';
        document.getElementById('dc-per-phone').value = codeData.per_phone_limit ?? '';
        document.getElementById('dc-min-amount').value = codeData.min_amount ?? '';
        document.getElementById('dc-note').value = codeData.note ?? '';
        document.getElementById('dc-submit-btn').textContent = '儲存修改';
        document.getElementById('dc-cancel-btn').classList.remove('hidden');
        document.getElementById('discount-code-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // delete
    container.querySelectorAll('.dc-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const codeData = codes.find(c => c.id === id);
        if (!codeData) return;
        if (!confirm(`確定刪除折扣碼「${codeData.code}」？此操作無法復原。`)) return;
        try {
          await api(`/api/admin/discount-codes/${id}`, { method: 'DELETE' });
          toast('已刪除折扣碼', 'success');
          loadDiscountCodes();
        } catch (e) {
          if (e.data?.error === 'has_redemptions') {
            toast('此折扣碼已被使用，請改停用', 'error');
          } else {
            toast(`刪除失敗：${escapeHtml(e.message)}`, 'error');
          }
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}
```

改為：
```js
// --- Discount codes ---
let discountCodesCache = [];

async function loadDiscountCodes() {
  const container = document.getElementById('discount-codes-list');
  if (!container) return;
  container.innerHTML = '<div class="p-6 subtle text-center">載入中…</div>';
  try {
    discountCodesCache = await api('/api/admin/discount-codes');
    renderDiscountCodes();
  } catch (e) {
    container.innerHTML = `<div class="p-6 text-red-500 text-center">${escapeHtml(e.message)}</div>`;
  }
}

function renderDiscountCodes() {
  const container = document.getElementById('discount-codes-list');
  if (!container) return;
  const codes = discountCodesCache;
  if (!codes.length) {
    container.innerHTML = `
      <div class="empty-state">
        ${ICO.tag.replace('nk-ico', 'nk-empty-ico')}
        <p>尚無折扣碼</p>
        <p class="subtle text-sm">使用上方表單建立第一個折扣碼</p>
      </div>`;
    return;
  }
  const { visible, rest } = limitSlice('discounts', codes);
  container.innerHTML = visible.map(c => {
    const typeLabel = c.discount_type === 'percent' ? `減 ${c.discount_value}%` : `減 $${c.discount_value}`;
    const usageText = c.max_uses != null ? `${c.used_count}/${c.max_uses}` : `已用 ${c.used_count}`;
    const limits = [];
    if (c.valid_from || c.valid_until) {
      limits.push(`有效期：${escapeHtml(c.valid_from || '—')} ~ ${escapeHtml(c.valid_until || '—')}`);
    }
    limits.push(`使用量：${usageText}`);
    if (c.per_phone_limit != null) limits.push(`每人上限 ${c.per_phone_limit} 次`);
    if (c.min_amount != null) limits.push(`最低 NT$${c.min_amount}`);
    return `
      <article class="a-row" data-code-id="${c.id}">
        <div class="a-row-main">
          <div class="a-row-title">
            <h3 class="card-title font-mono">${escapeHtml(c.code)}</h3>
            <span class="badge badge-${c.discount_type === 'percent' ? 'confirmed' : 'waitlisted'}">${escapeHtml(typeLabel)}</span>
            <span class="badge badge-${c.active ? 'open' : 'completed'}">${c.active ? '啟用中' : '已停用'}</span>
          </div>
          <div class="a-row-sub">
            <div class="meta flex-wrap">
              ${limits.map(l => `<span class="meta-item">${escapeHtml(l)}</span>`).join('')}
            </div>
            ${c.note ? `<p class="subtle text-xs mt-1">${escapeHtml(c.note)}</p>` : ''}
          </div>
        </div>
        <div class="a-row-actions">
          <button
            data-id="${c.id}"
            data-active="${c.active}"
            class="dc-toggle-btn btn btn-ghost btn-sm"
          >${c.active ? '停用' : '啟用'}</button>
          <button data-id="${c.id}" class="dc-edit-btn btn btn-ghost btn-sm">編輯</button>
          <button data-id="${c.id}" class="dc-del-btn btn btn-danger btn-sm">刪除</button>
        </div>
      </article>`;
  }).join('') + moreButtonHtml('discounts', rest);
  bindLoadMore(container, () => renderDiscountCodes());

  // toggle active/inactive
  container.querySelectorAll('.dc-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const newActive = btn.dataset.active === '1' || btn.dataset.active === 'true' ? 0 : 1;
      const code = btn.closest('article');
      // collect current values from the rendered card to send full payload
      const codeData = codes.find(c => c.id === id);
      if (!codeData) return;
      try {
        await api(`/api/admin/discount-codes/${id}`, {
          method: 'PATCH',
          body: {
            discount_type: codeData.discount_type,
            discount_value: codeData.discount_value,
            active: newActive,
            valid_from: codeData.valid_from ?? '',
            valid_until: codeData.valid_until ?? '',
            max_uses: codeData.max_uses ?? '',
            per_phone_limit: codeData.per_phone_limit ?? '',
            min_amount: codeData.min_amount ?? '',
            note: codeData.note ?? '',
          },
        });
        toast(`折扣碼已${newActive ? '啟用' : '停用'}`, 'success');
        loadDiscountCodes();
      } catch (e) {
        toast(`操作失敗：${escapeHtml(e.message)}`, 'error');
      }
    });
  });

  // edit: populate form
  container.querySelectorAll('.dc-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const codeData = codes.find(c => c.id === id);
      if (!codeData) return;
      document.getElementById('discount-code-edit-id').value = id;
      document.getElementById('dc-code').value = codeData.code;
      document.getElementById('dc-code').readOnly = true;
      document.getElementById('dc-type').value = codeData.discount_type;
      document.getElementById('dc-value').value = codeData.discount_value;
      document.getElementById('dc-valid-from').value = codeData.valid_from ?? '';
      document.getElementById('dc-valid-until').value = codeData.valid_until ?? '';
      document.getElementById('dc-max-uses').value = codeData.max_uses ?? '';
      document.getElementById('dc-per-phone').value = codeData.per_phone_limit ?? '';
      document.getElementById('dc-min-amount').value = codeData.min_amount ?? '';
      document.getElementById('dc-note').value = codeData.note ?? '';
      document.getElementById('dc-submit-btn').textContent = '儲存修改';
      document.getElementById('dc-cancel-btn').classList.remove('hidden');
      document.getElementById('discount-code-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // delete
  container.querySelectorAll('.dc-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const codeData = codes.find(c => c.id === id);
      if (!codeData) return;
      if (!confirm(`確定刪除折扣碼「${codeData.code}」？此操作無法復原。`)) return;
      try {
        await api(`/api/admin/discount-codes/${id}`, { method: 'DELETE' });
        toast('已刪除折扣碼', 'success');
        loadDiscountCodes();
      } catch (e) {
        if (e.data?.error === 'has_redemptions') {
          toast('此折扣碼已被使用，請改停用', 'error');
        } else {
          toast(`刪除失敗：${escapeHtml(e.message)}`, 'error');
        }
      }
    });
  });
}
```

（拆分要點：三態統一為詞彙 §A 寫法——載入中 `p-6 subtle text-center`、錯誤 `p-6 text-red-500 text-center` 移入 `loadDiscountCodes` 的 catch、空狀態副文 `subtle text-sm`；`.join('')` 後串 `moreButtonHtml('discounts', rest)`、緊接 `bindLoadMore(container, () => renderDiscountCodes())`；三個 dc-* 綁定區塊逐字保留（含未使用的 `const code = btn.closest('article')` 與註解），僅基準縮排從 try 內 4 空格降為函式內 2 空格；mutation 成功後仍呼叫 `loadDiscountCodes()` 重新抓取。）

**Step 8：驗證**

```bash
node --check /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：無輸出（exit 0）

grep -n 'card-title mb-3' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html | grep -c '單堂價\|收款與 LINE 設定\|Google 日曆與時段容量\|建立折扣碼'
# 預期：4

! grep -q '<div class="font-semibold mb-3">' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html && ! grep -q '<h3 class="font-semibold mb-3">建立折扣碼</h3>' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html && echo OK-titles
# 預期：OK-titles（折扣碼頁籤是全檔僅有的 div.font-semibold mb-3 三處；教練頁的「建立教練帳號」是 mb-1 不受影響）

grep -A2 '<h2 class="section-title">折扣碼管理</h2>' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：後續行含 <span class="a-sec-line"></span>；且上一行（grep -B1 查看）為 <div class="a-sec-head">

grep -n 'id="discount-codes-list"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：恰 1 行，該行含 class="a-rows"，且無 grid gap-3

# JS 契約與 helper 套用
grep -c 'dc-toggle-btn\|dc-edit-btn\|dc-del-btn' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：6（模板 3 行＋querySelectorAll 3 行）

grep -c '<article class="a-row" data-code-id' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1

grep -c 'class="card-title font-mono"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1（.card-title 保留於 article 內）

grep -c "limitSlice('discounts'" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1

grep -c "moreButtonHtml('discounts'" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1

grep -c 'bindLoadMore(container, () => renderDiscountCodes())' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：1

grep -c "getElementById('discount-codes-list')" /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：2（loadDiscountCodes＋renderDiscountCodes 各一）
```

（瀏覽器實測由 controller 於本批 PR 完成後統一執行，本任務不開瀏覽器。）

**Step 9：Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html public/admin.js
git commit -m "$(cat <<'EOF'
折扣碼頁籤一致性改版：標題統一 card-title/a-sec-head、列表散卡改單卡包列＋載入更多

- 三張設定卡＋建立折扣碼標題統一 h3.card-title
- 折扣碼管理標題列改 a-sec-head（髮絲尾線）
- 列表 #discount-codes-list 改 .card.p-0 內 a-rows；article/.card-title 與 dc-* 按鈕契約零改動
- loadDiscountCodes 拆 fetch＋renderDiscountCodes，套 limitSlice key=discounts；三態統一寫法

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 教練頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — 教練頁籤區塊（現行 695–729：`#apanel-coaches` 內標題列、`#coach-mgmt-list`、建立教練帳號卡）＋ inline `<style>` 尾端（現行 391–398：backfill-panel 區塊之後、`</style>` 之前）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — `loadCoachMgmt()`（現行 1197–1256；只改渲染段 1197–1229 與插入載入更多兩行，事件綁定段 1230–1255 零改動）
- `/Users/ryansheu/projects/chinup-fitness-system/public/style.css` — 「後台教練色卡」全段刪除（現行 1173–1181，含註解與 `@media`）

**Interfaces:**
- Consumes（Task 1 已放進檔案，直接使用）：CSS class `.a-sec-head` / `.a-sec-line` / `.a-rows` / `.a-row` / `.a-row-main` / `.a-row-title` / `.a-row-sub` / `.a-row-actions` / `.a-more`；JS helper `limitSlice` / `moreButtonHtml` / `bindLoadMore`（key＝`'coaches'`）
- Consumes（codebase 既有）：`.badge` / `.badge-open` / `.badge-waitlisted`（style.css 既有）、`.card-title`、`.empty-state`＋`nk-empty-ico` 寫法、`ICO.dumbbell`（admin.js 既有 ICO 表）
- Produces：無（不新增任何 class／函式）

**紅線提醒（詞彙 §C 全部適用）**：`#coach-mgmt-list` id、`.toggle-active` / `.demote-btn`（含 `data-id` / `data-active`）、`.coach-color-dot` / `.coach-color-panel`（含 `dataset.for`）/ `.coach-color-grid` / `.coach-color-opt`（含 `data-color`）/ `.coach-color-default` 家族全部零改動；`.coach-color-panel` 仍為列的兄弟節點（插在 `.a-row` 後、`.a-rows` 內），互斥展開 handler 一行不動；每筆列原本就是 `div`（非 `article`），維持 `div`；本頁無搜尋/篩選，`limitSlice` 不需 reset handler；`loadCoachMgmt` 原本即無「載入中/錯誤」渲染（await 後直接繪），不新增；只改輸出 HTML 骨架，不改資料流、逐鈕綁定方式、API 呼叫。

---

#### Step 1: admin.html — 教練管理標題列改 `a-sec-head`、`#coach-mgmt-list` 包卡改 `a-rows`

原：

```html
  <section id="coach-mgmt" class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">教練管理</h2>
    </div>
    <div id="coach-mgmt-list"></div>
```

改為：

```html
  <section id="coach-mgmt" class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">教練管理</h2>
      <span class="a-sec-line"></span>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="coach-mgmt-list" class="a-rows"></div>
    </div>
```

（本頁無右側工具，依詞彙 §A 省略 `.a-sec-tools`。）

#### Step 2: admin.html — 建立教練帳號卡標題 `h3.font-semibold` → `h3.card-title`

原：

```html
    <div class="card mt-4">
      <h3 class="font-semibold mb-1">建立教練帳號</h3>
```

改為：

```html
    <div class="card mt-4">
      <h3 class="card-title mb-1">建立教練帳號</h3>
```

#### Step 3: admin.html — coach-color CSS 全段搬入 inline `<style>`（backfill-panel 區塊之後、`</style>` 之前，逐字自 style.css 搬入）

原：

```html
.bf-paid-row { display: flex; align-items: center; gap: 6px; font-size: 14px; margin: 4px 0; }
</style>
```

改為：

```html
.bf-paid-row { display: flex; align-items: center; gap: 6px; font-size: 14px; margin: 4px 0; }

/* 後台教練色卡 */
.coach-color-dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none;cursor:pointer;}
.coach-color-dot.coach-color-none{background:#fff;position:relative;}
.coach-color-dot.coach-color-none::after{content:"";position:absolute;inset:4px;border-radius:50%;border:2px solid #93c5fd;}
.coach-color-panel{margin:-4px 0 10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;}
.coach-color-grid{display:grid;grid-template-columns:repeat(13,26px);gap:8px;margin-bottom:10px;}
.coach-color-opt{width:26px;height:26px;border-radius:50%;border:none;cursor:pointer;color:#fff;font-size:13px;font-weight:800;line-height:1;}
.coach-color-opt:hover{transform:scale(1.15);}
@media (max-width:640px){.coach-color-grid{grid-template-columns:repeat(8,26px);}}
</style>
```

#### Step 4: style.css — 刪除「後台教練色卡」原段（含註解與 `@media`）

原：

```css
.reg-bk-colored:hover{filter:brightness(.92);}

/* 後台教練色卡 */
.coach-color-dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none;cursor:pointer;}
.coach-color-dot.coach-color-none{background:#fff;position:relative;}
.coach-color-dot.coach-color-none::after{content:"";position:absolute;inset:4px;border-radius:50%;border:2px solid #93c5fd;}
.coach-color-panel{margin:-4px 0 10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;}
.coach-color-grid{display:grid;grid-template-columns:repeat(13,26px);gap:8px;margin-bottom:10px;}
.coach-color-opt{width:26px;height:26px;border-radius:50%;border:none;cursor:pointer;color:#fff;font-size:13px;font-weight:800;line-height:1;}
.coach-color-opt:hover{transform:scale(1.15);}
@media (max-width:640px){.coach-color-grid{grid-template-columns:repeat(8,26px);}}

/* 拖拉改時段 */
```

改為：

```css
.reg-bk-colored:hover{filter:brightness(.92);}

/* 拖拉改時段 */
```

#### Step 5: admin.js — `loadCoachMgmt()` 渲染段改列語彙＋badge＋`limitSlice('coaches')`

只改「渲染段＋插入載入更多」；`wrap.querySelectorAll('.toggle-active')` 起的所有事件綁定（含色盤互斥展開）一行不動，old_string 以第一行綁定收尾保唯一。

原：

```js
async function loadCoachMgmt() {
  const coaches = await api('/api/admin/coaches');
  const wrap = document.getElementById('coach-mgmt-list');
  wrap.innerHTML = '';
  if (coaches.length === 0) wrap.innerHTML = '<p class="text-slate-500 text-sm">尚無教練</p>';
  for (const c of coaches) {
    const row = document.createElement('div');
    row.className = 'card flex items-center justify-between gap-3 mb-2';
    row.innerHTML = `
      <div class="flex items-center gap-3">
        <button data-id="${c.id}" class="coach-color-dot${c.color ? '' : ' coach-color-none'}" title="行事曆顏色"
                style="${c.color ? `background:${escapeHtml(c.color)};` : ''}"></button>
        <div>
          <div class="font-semibold">${escapeHtml(c.display_name)} <span class="text-xs ${c.is_active ? 'text-green-600' : 'text-amber-600'}">${c.is_active ? '啟用中' : '待啟用'}</span></div>
          <div class="text-xs text-slate-500">${escapeHtml(c.user_email)} · ${escapeHtml(c.specialty || '')}</div>
        </div>
      </div>
      <div class="flex gap-2">
        <button data-id="${c.id}" data-active="${c.is_active}" class="btn btn-ghost btn-sm toggle-active">${c.is_active ? '停用' : '啟用'}</button>
        <button data-id="${c.id}" class="btn btn-danger btn-sm demote-btn">降為一般用戶</button>
      </div>
    `;
    wrap.appendChild(row);
    const panel = document.createElement('div');
    panel.className = 'coach-color-panel hidden';
    panel.dataset.for = c.id;
    panel.innerHTML = `
      <div class="coach-color-grid">
        ${COACH_COLORS.map(col => `<button class="coach-color-opt${c.color === col ? ' is-current' : ''}" data-id="${c.id}" data-color="${col}" style="background:${col};" title="${col}">${c.color === col ? '✓' : ''}</button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm coach-color-default" data-id="${c.id}">預設（不指定）</button>`;
    wrap.appendChild(panel);
  }
  wrap.querySelectorAll('.toggle-active').forEach(b => b.addEventListener('click', async () => {
```

改為：

```js
async function loadCoachMgmt() {
  const coaches = await api('/api/admin/coaches');
  const wrap = document.getElementById('coach-mgmt-list');
  wrap.innerHTML = '';
  if (coaches.length === 0) {
    wrap.innerHTML = `
      <div class="empty-state">
        ${ICO.dumbbell.replace('nk-ico', 'nk-empty-ico')}
        <p>尚無教練</p>
        <p class="subtle text-sm">請於下方建立教練帳號</p>
      </div>`;
  }
  const { visible, rest } = limitSlice('coaches', coaches);
  for (const c of visible) {
    const row = document.createElement('div');
    row.className = 'a-row';
    row.innerHTML = `
      <div class="a-row-main">
        <div class="a-row-title">
          <button data-id="${c.id}" class="coach-color-dot${c.color ? '' : ' coach-color-none'}" title="行事曆顏色"
                  style="${c.color ? `background:${escapeHtml(c.color)};` : ''}"></button>
          <span class="font-semibold">${escapeHtml(c.display_name)}</span>
          ${c.is_active ? '<span class="badge badge-open">啟用中</span>' : '<span class="badge badge-waitlisted">待啟用</span>'}
        </div>
        <div class="a-row-sub text-xs text-slate-500">${escapeHtml(c.user_email)} · ${escapeHtml(c.specialty || '')}</div>
      </div>
      <div class="a-row-actions">
        <button data-id="${c.id}" data-active="${c.is_active}" class="btn btn-ghost btn-sm toggle-active">${c.is_active ? '停用' : '啟用'}</button>
        <button data-id="${c.id}" class="btn btn-danger btn-sm demote-btn">降為一般用戶</button>
      </div>
    `;
    wrap.appendChild(row);
    const panel = document.createElement('div');
    panel.className = 'coach-color-panel hidden';
    panel.dataset.for = c.id;
    panel.innerHTML = `
      <div class="coach-color-grid">
        ${COACH_COLORS.map(col => `<button class="coach-color-opt${c.color === col ? ' is-current' : ''}" data-id="${c.id}" data-color="${col}" style="background:${col};" title="${col}">${c.color === col ? '✓' : ''}</button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm coach-color-default" data-id="${c.id}">預設（不指定）</button>`;
    wrap.appendChild(panel);
  }
  wrap.insertAdjacentHTML('beforeend', moreButtonHtml('coaches', rest));
  bindLoadMore(wrap, () => loadCoachMgmt());
  wrap.querySelectorAll('.toggle-active').forEach(b => b.addEventListener('click', async () => {
```

（要點：`limitSlice('coaches', coaches)` 永遠不帶 reset——本頁無搜尋/篩選，無 reset handler；`.a-more` 鈕以 `insertAdjacentHTML` 附掛在色盤 panel 之後、卡底；`bindLoadMore` 的 rerender 呼叫原 render `loadCoachMgmt`，符合詞彙 §B 呼叫模式；panel 建立/附掛與後續全部 `querySelectorAll` 綁定原樣保留。）

#### Step 6: 驗證

```bash
node --check /Users/ryansheu/projects/chinup-fitness-system/public/admin.js
# 預期：無輸出、exit 0

grep -c "coach-color" /Users/ryansheu/projects/chinup-fitness-system/public/style.css
# 預期：0（原段已刪光）

grep -c "coach-color" /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：8（搬入的 8 行規則；另可 grep -c "後台教練色卡" 應為 1）

grep -c 'id="coach-mgmt-list" class="a-rows"' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：1

grep -c '<h3 class="card-title mb-1">建立教練帳號</h3>' /Users/ryansheu/projects/chinup-fitness-system/public/admin.html
# 預期：1（且 grep -c '<h3 class="font-semibold mb-1">建立教練帳號' 應為 0）

sed -n '/^async function loadCoachMgmt/,/^}$/p' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js | grep -c "a-row"
# 預期：5（a-row / a-row-main / a-row-title / a-row-sub / a-row-actions 各 1 行）

sed -n '/^async function loadCoachMgmt/,/^}$/p' /Users/ryansheu/projects/chinup-fitness-system/public/admin.js | grep -c "limitSlice('coaches'"
# 預期：1

# JS 契約 class 逐一仍在（範圍限 loadCoachMgmt，行數計）：
f=/Users/ryansheu/projects/chinup-fitness-system/public/admin.js
sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "toggle-active"      # 預期：2（模板+綁定）
sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "demote-btn"         # 預期：2
sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "coach-color-dot"    # 預期：2
sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "coach-color-panel"  # 預期：3（建立+選取+互斥收合）
sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "coach-color-opt"    # 預期：2
sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "coach-color-default" # 預期：2

sed -n '/^async function loadCoachMgmt/,/^}$/p' $f | grep -c "badge-open\|badge-waitlisted"
# 預期：1（同一行三元式含兩個 badge）
```

#### Step 7: Commit

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html public/admin.js public/style.css
git commit -m "$(cat <<'EOF'
後台教練頁籤一致性改版：列表散卡改單卡包列＋狀態 badge＋載入更多；coach-color CSS 歸位 inline

- 教練管理標題列改 a-sec-head（section-title＋a-sec-line）
- #coach-mgmt-list 包 card p-0 overflow-hidden、class 改 a-rows；每教練列改 a-row（色點鈕＋姓名進 a-row-title、狀態彩字改 badge-open/badge-waitlisted、email·specialty 進 a-row-sub、toggle-active/demote-btn 進 a-row-actions）
- coach-color-panel 仍為列兄弟節點、互斥展開邏輯零改動；JS 契約 class/dataset 全保留
- 空狀態改統一 .empty-state（ICO.dumbbell）；套 limitSlice key=coaches＋moreButtonHtml＋bindLoadMore
- 建立教練帳號卡標題 h3.font-semibold→h3.card-title
- coach-color CSS 全段（含 @media）自 style.css 搬入 admin.html inline（backfill-panel 之後），style.css 原段刪除

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 薪資頁籤一致性改版

**Files:**
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.html` — `#apanel-payroll` 面板內四處（現行 main `56f5b73` 行號：期別導覽 764–777、抽成設定標題 780–784、駐場出勤標題 809–813、彙總表標題列 884–889；執行時行號可能因前面任務位移，一律以 old_string 逐字比對為準）
- `/Users/ryansheu/projects/chinup-fitness-system/public/admin.js` — **零改動**（1910–2293 薪資/駐場全段僅驗證：所有 `getElementById('pr-*')`/`getElementById('sh-*')` 掛載點於本次 HTML 改動後全數保留，無需任何 JS 編輯）

**Interfaces:**
- Consumes（Task 1 已放入 admin.html inline `<style>`）：`.a-sec-head`、`.a-sec-line`、`.a-sec-tools`；另用 admin.html 既有 `.card-title`（原生 CSS 第 72 行起，非 Task 1 新增）。
- **不使用** `limitSlice`/`moreButtonHtml`/`bindLoadMore`（本頁籤不套載入更多——教練數少，彙總表自然短）。
- Produces：無。

**範圍鎖定（spec §3 薪資列）**：只做①「抽成設定」「駐場出勤」`h3.font-bold`→`h3.card-title`、②期別標題列改 `a-sec-head`（「薪資計算」+`#pr-period-label` 保留左側，三顆導覽鈕進 `.a-sec-tools`）、③教練薪資彙總標題列改 `a-sec-head`（`#pr-export` 進 `.a-sec-tools`）。**其餘零改動**：彙總表 `.data-table`、`tr.pr-row` 明細展開、`pr-*`/`sh-*` 全家（含 `.sh-h4`、週表藥丸、chip、複合起訖膠囊）、`#pr-settings-toggle`/`#sh-toggle` collapse、兩顆 `h4.font-bold.text-sm`（打卡參數／打卡 QR code）、以及本頁三態文案（`計算中…`/`載入中…`/`本期沒有教練資料`——spec §3 判定期別/彙總已合規，不在本任務動）。不新增任何 class、不動任何 JS 資料流/事件綁定/API。

**Step 1：期別標題列改 `a-sec-head`（admin.html）**

「薪資計算」＋期別副標整組保留左側（沿用原本的無 class 包裹 `<div>`），尾線後三顆導覽鈕進 `.a-sec-tools`。所有 `#pr-*` id 與按鈕 class 逐字不動。

原：
```html
  <!-- 期別導覽 -->
  <section class="mb-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h2 class="section-title">薪資計算</h2>
        <div id="pr-period-label" class="subtle text-sm mt-1">—</div>
      </div>
      <div class="flex items-center gap-2">
        <button id="pr-prev" class="btn btn-ghost btn-sm">◀ 上一期</button>
        <button id="pr-current" class="btn btn-ghost btn-sm">本期</button>
        <button id="pr-next" class="btn btn-ghost btn-sm">下一期 ▶</button>
      </div>
    </div>
    <p class="subtle text-sm mt-2">薪資週期為上月 6 號至當月 5 號；依教練預約行事曆即時計算，非結算存檔。</p>
  </section>
```

改為：
```html
  <!-- 期別導覽 -->
  <section class="mb-6">
    <div class="a-sec-head">
      <div>
        <h2 class="section-title">薪資計算</h2>
        <div id="pr-period-label" class="subtle text-sm mt-1">—</div>
      </div>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <button id="pr-prev" class="btn btn-ghost btn-sm">◀ 上一期</button>
        <button id="pr-current" class="btn btn-ghost btn-sm">本期</button>
        <button id="pr-next" class="btn btn-ghost btn-sm">下一期 ▶</button>
      </div>
    </div>
    <p class="subtle text-sm mt-2">薪資週期為上月 6 號至當月 5 號；依教練預約行事曆即時計算，非結算存檔。</p>
  </section>
```

**Step 2：「抽成設定」卡標題 `font-bold`→`card-title`（admin.html）**

原：
```html
  <section class="card mb-6">
    <div class="flex items-center justify-between">
      <h3 class="font-bold">抽成設定</h3>
      <button id="pr-settings-toggle" class="btn btn-ghost btn-sm">編輯</button>
    </div>
```

改為：
```html
  <section class="card mb-6">
    <div class="flex items-center justify-between">
      <h3 class="card-title">抽成設定</h3>
      <button id="pr-settings-toggle" class="btn btn-ghost btn-sm">編輯</button>
    </div>
```

**Step 3：「駐場出勤」卡標題 `font-bold`→`card-title`（admin.html）**

（卡內兩顆 `<h4 class="font-bold text-sm …>` 打卡參數／打卡 QR code 與所有 `.sh-h4` 照舊不動。）

原：
```html
    <div class="flex items-center justify-between">
      <h3 class="font-bold">駐場出勤</h3>
      <button id="sh-toggle" class="btn btn-ghost btn-sm">展開</button>
    </div>
```

改為：
```html
    <div class="flex items-center justify-between">
      <h3 class="card-title">駐場出勤</h3>
      <button id="sh-toggle" class="btn btn-ghost btn-sm">展開</button>
    </div>
```

**Step 4：教練薪資彙總標題列改 `a-sec-head`，`#pr-export` 進 `.a-sec-tools`（admin.html）**

（原 `mb-4`＝16px 由 `.a-sec-head` 的 `margin-bottom:16px` 等值接手；其下 `.card.p-0.overflow-hidden`＋`#pr-table` 含「載入中…」佔位逐字不動。）

原：
```html
  <!-- 彙總表 -->
  <section class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">教練薪資彙總</h2>
      <button id="pr-export" class="btn btn-ghost btn-sm">匯出 CSV</button>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="pr-table"><div class="p-4 subtle">載入中…</div></div>
    </div>
  </section>
```

改為：
```html
  <!-- 彙總表 -->
  <section class="mb-10">
    <div class="a-sec-head">
      <h2 class="section-title">教練薪資彙總</h2>
      <span class="a-sec-line"></span>
      <div class="a-sec-tools">
        <button id="pr-export" class="btn btn-ghost btn-sm">匯出 CSV</button>
      </div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="pr-table"><div class="p-4 subtle">載入中…</div></div>
    </div>
  </section>
```

**Step 5：驗證（全部指令在 `/Users/ryansheu/projects/chinup-fitness-system` 下執行）**

```bash
grep -c '<h3 class="font-bold">' public/admin.html
# 預期：0（全檔僅薪資頁這 2 顆，皆已改 card-title）
grep -c '<h3 class="card-title">抽成設定</h3>' public/admin.html
# 預期：1
grep -c '<h3 class="card-title">駐場出勤</h3>' public/admin.html
# 預期：1
grep -c '<h4 class="font-bold text-sm' public/admin.html
# 預期：2（打卡參數／打卡 QR code 兩顆 h4 零改動）
grep -B1 'id="pr-prev"' public/admin.html | grep -c 'a-sec-tools'
# 預期：1（三顆導覽鈕已入 tools）
grep -B1 'id="pr-export"' public/admin.html | grep -c 'a-sec-tools'
# 預期：1（匯出鈕已入 tools）
grep -c 'id="pr-' public/admin.html
# 預期：15（pr-* 掛載點契約零增減）
grep -c 'id="sh-' public/admin.html
# 預期：28（sh-* 掛載點契約零增減）
grep -c 'sh-h4' public/admin.html
# 預期：6（sh-* 特化元件照舊）
grep -c 'data-more-key' public/admin.html
# 預期：0（本頁籤不套 limitSlice；HTML 靜態層無載入更多殘留）
git diff --stat -- public/admin.js
# 預期：無輸出（零 JS 改動）
node --check public/admin.js
# 預期：無輸出（通過）
```

**Step 6：Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/admin.html
git commit -m "$(cat <<'EOF'
admin 薪資頁籤一致性：期別/彙總標題列改 a-sec-head、抽成設定/駐場出勤卡標題改 card-title（零 JS 改動）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10b: PR3 收尾（controller 執行）

- [ ] PR2 merge 後自 main 開 `feature/admin-ui-consistency-3`，執行 Task 8–10。
- [ ] `node --check`；grep 驗證 `.dc-toggle-btn/.toggle-active/.demote-btn/.coach-color-dot/.pr-row/.sh-pill` 契約；確認 style.css coach-color 段已移除且 admin.html 有對應段。
- [ ] 瀏覽器實測：折扣碼建立/編輯/停用/刪除、設定卡儲存、教練停用/降級/色盤選色、薪資期別導覽/設定編輯/彙總展開/駐場展開/CSV、載入更多。
- [ ] push → draft PR → 過目 → merge。
