# 登錄週曆 拖拉改時段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓教練後台「登錄預約」週曆能像 Google 行事曆般拖拉預約塊改時段，且真的呼叫既有 reschedule 端點落 DB。

**Architecture:** 純前端。在 `renderRegister()` 收尾，對每個 `.reg-bk` 預約塊綁 Pointer Events（統一桌機滑鼠＋手機觸控）。按住移動超過 8px 進入拖曳：建浮動 ghost 跟手、空整點格高亮；放開落在空格 → 呼叫 PR3 既有 `PATCH /api/coach/bookings/:id/reschedule { startAt }`（保留原教練、衝突 409、Google 日曆刷新由 route 自理），未移動＝視為點擊→開既有編輯彈窗。後端與測試不動。

**Tech Stack:** Vanilla JS（ESM，`public/coach.js`）、Pointer Events API、`public/style.css`。後端：Express + node:sqlite（本 PR 不動）。

## Global Constraints

- **純前端**：只改 `public/coach.js` 與 `public/style.css`；不改任何 `src/**`、不改任何後端 route/service、不新增後端測試。
- **重用既有端點**：改時段一律走 `PATCH /api/coach/bookings/${id}/reschedule`，body 只帶 `{ startAt }`（**不帶 coachId** → 保留該預約原本的教練）。
- **回應全繁體中文**；技術識別字（class 名、函式名、API 路徑）保持原樣。
- **裝置**：桌機滑鼠＋手機觸控都要可拖（用 Pointer Events，不用 HTML5 DnD）。
- **只搬時段**：固定 60 分鐘，不做拉邊改時長、不做拖曳邊緣自動捲動、不透過拖曳改授課教練。
- **可拖對象**：只有 `.reg-bk` 預約塊（含 `.reg-booked-other`）；團課 `.reg-gp` 不可拖。
- **放置目標**：所有空整點格 `.reg-open[data-slot]`（與編輯彈窗 reschedule 一致：任何整點皆可，不限 `.reg-avail`）。
- **無前端 DOM 測試框架**（專案零 devDeps、無 jsdom）：不為本 PR 引入測試框架；後端 reschedule 已由 `tests/booking-edit.test.js`＋`tests/booking-edit-api.test.js`（PR3）覆蓋。前端以 `node --check` ＋ 控制者親跑瀏覽器 smoke 驗證（見「驗證」段）。

---

## 既有程式碼錨點（實作者必讀）

`public/coach.js`：
- 第 1 行：`import { api, fmtDate, dow, toast, getUser, escapeHtml, renderAuthBar } from './app.js';`（`api`/`toast`/`escapeHtml` 直接可用）。
- 第 3 行：`const $ = (id) => document.getElementById(id);`
- 第 6 行：`let isAdmin = false;`（登入後設定）。
- 第 506–520 行附近：登錄分頁的模組層 `let`（`regWeekOffset`/`regViewCoachId`/`regCoachOptionsCache`/`regDiscountCodesCache`）。**本 PR 的 `let regDrag = null;` 加在這一區（緊接第 508 行 `regCoachOptionsCache` 宣告之後）。**
- `renderRegister()`（約第 540–634 行）：建週曆 grid。閉包內有 `data`（含 `data.bookings` 陣列，每筆 booking 物件有 `id/coach_id/coach_name/start_at/end_at/session_type/package_id/member_name/paid_at/discount_code`）。
- 第 624–628 行（**保持不變**）：空格登錄綁定
  ```js
  $('reg-grid').querySelectorAll('.reg-open[data-slot]').forEach(c => c.addEventListener('click', () => {
    if (!canRegister) { toast('請先於上方選擇要登錄的教練', 'error'); return; }
    openRegisterModal(c.dataset.slot);
  }));
  ```
- 第 629–633 行（**本 PR 要替換**）：原預約格點擊→編輯
  ```js
  // 預約格 → 編輯
  $('reg-grid').querySelectorAll('.reg-bk[data-bk]').forEach(c => c.addEventListener('click', () => {
    const all = data.bookings.find(b => b.id === Number(c.dataset.bk));
    if (all) openBookingEditModal(all);
  }));
  ```
- 第 634 行：`renderRegister()` 的右大括號 `}`。**控制器函式群加在此括號之後、第 636 行 `let bkeditBooking = null;` 之前。**
- `openBookingEditModal(booking)`（第 639 行）：傳入 booking 物件即開編輯彈窗（tap 沿用）。
- reschedule 呼叫範例（編輯彈窗內，第 698 行）：`await api(\`/api/coach/bookings/${b.id}/reschedule\`, { method: 'PATCH', body: { startAt } });`；錯誤碼對應 `e.data?.error`（第 700 行可參考）。

`public/style.css`：
- 第 1159 行：`.reg-open{color:#cbd5e1;cursor:pointer;border:1px dashed #e2e8f0;}`
- 第 1166–1169 行：
  ```css
  .reg-bk{background:#dbeafe;color:#1e3a8a;font-size:11px;border-radius:4px;padding:2px 4px;cursor:pointer;text-align:left;width:100%;}
  .reg-bk:hover{background:#bfdbfe;}
  .reg-booked-other{background:#eef2f7;color:#64748b;}
  .reg-booked-other:hover{background:#e2e8f0;}
  ```
- 第 1170 行：`.reg-gp{...}`。**本 PR 的拖曳樣式加在第 1170 行之後、第 1172 行 `/* 登錄彈窗 */` 註解之前。**
- 色彩 token（`:root`，第 1–6 行附近）：`--brand-50: #f0f9ff;`、`--brand-600: #0ea5e9;`（拖曳高亮沿用）。

---

## File Structure

- **Modify `public/style.css`**：在第 1170 行後新增 5 條拖曳樣式（cursor/touch-action、來源塊淡化、目標格高亮、浮動 ghost）。
- **Modify `public/coach.js`**：
  - 第 508 行後新增 `let regDrag = null;`。
  - 第 634 行後新增拖曳控制器函式群（`bindBookingDrag`/`onRegPointerMove`/`onRegPointerUp`/`onRegPointerCancel`/`regClearDropHover`/`regDragCleanup`/`doDragReschedule`）。
  - 第 629–633 行的 `.reg-bk` click 綁定替換為 `bindBookingDrag`。

只有一個交付單元（拖曳改時段功能），CSS 與 JS 相依、無法各自獨立驗收，故合併為單一 Task。

---

### Task 1: 登錄週曆拖拉改時段（CSS + Pointer 控制器 + 重接綁定）

**Files:**
- Modify: `public/style.css`（第 1170 行後）
- Modify: `public/coach.js`（第 508 行後加狀態；第 634 行後加控制器；第 629–633 行替換綁定）

**Interfaces:**
- Consumes（既有，來自 `./app.js` import 與模組內）：`api(url,{method,body})`（throw 時 `e.data.error` 帶後端錯誤碼、`e.message` 為訊息）、`toast(msg,type)`、`escapeHtml`、`$`、`isAdmin`、`renderRegister()`、`openBookingEditModal(booking)`。
- Produces（本 PR 新增，模組內互相呼叫，外部不依賴）：`let regDrag`、`bindBookingDrag(el, booking)`、`onRegPointerMove(e)`、`onRegPointerUp(e)`、`onRegPointerCancel(e)`、`regClearDropHover()`、`regDragRemoveListeners(el)`、`regDragCleanup()`、`async doDragReschedule(bookingId, startAt)`。

- [ ] **Step 1：加 CSS 拖曳樣式**

在 `public/style.css` 第 1170 行 `.reg-gp{...}` 之後、第 1172 行 `/* 登錄彈窗 */` 之前，插入：

```css
/* 拖拉改時段 */
.reg-bk{touch-action:none;cursor:grab;}
.reg-bk:active{cursor:grabbing;}
.reg-bk-dragging{opacity:.4;}
.reg-drop-hover{outline:2px dashed var(--brand-600);outline-offset:-2px;background:var(--brand-50);}
.reg-drag-ghost{position:fixed;left:0;top:0;pointer-events:none;z-index:9999;background:#dbeafe;color:#1e3a8a;font-size:11px;border-radius:6px;padding:4px 8px;box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:.95;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;}
```

> 註：第 1166 行 `.reg-bk{...cursor:pointer;...}` 原有 `cursor:pointer` 仍在，但因本區塊在其後、且 `.reg-bk{cursor:grab;}` 後出現，grab 會覆蓋 pointer；`touch-action:none` 讓觸控按住塊時不捲頁（快速 tap 仍可開編輯）。

- [ ] **Step 2：加模組狀態 `regDrag`**

在 `public/coach.js` 第 508 行 `let regCoachOptionsCache = null; ...` 那一行之後（登錄分頁 `let` 區），新增一行：

```js
let regDrag = null; // 拖拉改時段中的狀態：{ id, booking, srcEl, startX, startY, pointerId, moved, ghost, dropSlot }
```

- [ ] **Step 3：加拖曳控制器函式群**

在 `public/coach.js` 第 634 行 `renderRegister()` 的右大括號 `}` 之後、第 636 行 `let bkeditBooking = null;` 之前，插入下列完整程式碼（原樣）：

```js
// ===== 登錄週曆：拖拉改時段（Pointer Events，桌機滑鼠＋手機觸控）=====
function regClearDropHover() {
  document.querySelectorAll('.reg-drop-hover').forEach(c => c.classList.remove('reg-drop-hover'));
}

function regDragRemoveListeners(el) {
  el.removeEventListener('pointermove', onRegPointerMove);
  el.removeEventListener('pointerup', onRegPointerUp);
  el.removeEventListener('pointercancel', onRegPointerCancel);
}

function regDragCleanup() {
  if (!regDrag) return;
  if (regDrag.ghost) regDrag.ghost.remove();
  if (regDrag.srcEl) regDrag.srcEl.classList.remove('reg-bk-dragging');
  regClearDropHover();
  regDrag = null;
}

// 對單一預約塊綁定 pointerdown：tap → 開編輯彈窗；拖過閾值 → 改時段
function bindBookingDrag(el, booking) {
  el.addEventListener('pointerdown', (e) => {
    if (regDrag) return;                       // 已有拖曳進行中（多指）→ 忽略
    if (!e.isPrimary) return;                  // 只認主要指標
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 滑鼠只認左鍵
    regDrag = {
      id: booking.id, booking, srcEl: el,
      startX: e.clientX, startY: e.clientY, pointerId: e.pointerId,
      moved: false, ghost: null, dropSlot: null,
    };
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.addEventListener('pointermove', onRegPointerMove);
    el.addEventListener('pointerup', onRegPointerUp);
    el.addEventListener('pointercancel', onRegPointerCancel);
  });
}

function onRegPointerMove(e) {
  if (!regDrag) return;
  const dx = e.clientX - regDrag.startX, dy = e.clientY - regDrag.startY;
  if (!regDrag.moved) {
    if (Math.hypot(dx, dy) < 8) return;        // 未過閾值 → 仍可能是 tap
    regDrag.moved = true;
    regDrag.srcEl.classList.add('reg-bk-dragging');
    const g = document.createElement('div');
    g.className = 'reg-drag-ghost';
    g.textContent = regDrag.srcEl.textContent;
    document.body.appendChild(g);
    regDrag.ghost = g;
  }
  e.preventDefault();
  regDrag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const cell = (under && under.closest) ? under.closest('.reg-open[data-slot]') : null;
  regClearDropHover();
  if (cell) { cell.classList.add('reg-drop-hover'); regDrag.dropSlot = cell.dataset.slot; }
  else { regDrag.dropSlot = null; }
}

function onRegPointerUp(e) {
  if (!regDrag) return;
  const d = regDrag;
  regDragRemoveListeners(d.srcEl);
  try { d.srcEl.releasePointerCapture(e.pointerId); } catch {}
  if (!d.moved) {                              // 沒移動 = 點擊 → 開編輯彈窗
    regDragCleanup();
    openBookingEditModal(d.booking);
    return;
  }
  const slot = d.dropSlot;
  regDragCleanup();
  if (slot) doDragReschedule(d.id, slot);     // 落在空格 → 改時段；否則無動作（自動還原）
}

function onRegPointerCancel(e) {
  if (!regDrag) return;
  regDragRemoveListeners(regDrag.srcEl);
  try { regDrag.srcEl.releasePointerCapture(e.pointerId); } catch {}
  regDragCleanup();
}

async function doDragReschedule(bookingId, startAt) {
  try {
    await api(`/api/coach/bookings/${bookingId}/reschedule`, { method: 'PATCH', body: { startAt } });
    toast('已改期', 'success');
  } catch (e) {
    const m = { slot_taken: '該時段已被預約', forbidden: '無權限改此預約', invalid_start_at: '時間格式錯', already_cancelled: '預約已取消' };
    toast(m[e.data?.error] || `改期失敗：${e.message}`, 'error');
  }
  renderRegister();                            // 成功＝移到新格；失敗＝視覺還原
}
```

- [ ] **Step 4：重接 `.reg-bk` 綁定（click → 拖曳控制器）**

在 `public/coach.js` 把第 629–633 行：

```js
  // 預約格 → 編輯
  $('reg-grid').querySelectorAll('.reg-bk[data-bk]').forEach(c => c.addEventListener('click', () => {
    const all = data.bookings.find(b => b.id === Number(c.dataset.bk));
    if (all) openBookingEditModal(all);
  }));
```

替換為：

```js
  // 預約格 → 拖拉改時段（tap 仍開編輯彈窗）
  $('reg-grid').querySelectorAll('.reg-bk[data-bk]').forEach(c => {
    const booking = data.bookings.find(b => b.id === Number(c.dataset.bk));
    if (booking) bindBookingDrag(c, booking);
  });
```

> 空格登錄綁定（第 624–628 行）**保持不變**。

- [ ] **Step 5：語法檢查**

Run: `node --check public/coach.js`
Expected: 無輸出、exit 0（語法正確）。CSS 無語法檢查工具，靠人工/瀏覽器 smoke 確認。

- [ ] **Step 6：Commit**

```bash
git add public/coach.js public/style.css
git commit -m "feat: 登錄週曆拖拉改時段（Pointer Events，落 reschedule）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 驗證（控制者親跑，非 subagent 任務）

實作 Task 1 並通過 task review 後，由控制者執行瀏覽器 smoke（本機 `npm start` + Chrome MCP；登入教練/管理者帳號）：

1. **桌機滑鼠拖曳改時段**：登錄分頁，將某預約塊用滑鼠拖到同教練的空整點格 → 放開 → toast「已改期」、塊出現在新格、舊格變空。重新整理頁面後仍在新格（確認落 DB）。可另以 API/`GET /api/coach/week` 或 DB 查該 booking `start_at` 已更新。
2. **觸控拖曳**：Chrome DevTools 裝置模擬（或 dispatch `PointerEvent` with `pointerType:'touch'`）down→move(過 8px)→up 於目標空格 → 同樣落 DB。
3. **衝突還原**：拖到同教練已被佔用的時段（落在非空格 → 本就不可放，無動作）；或併發情境下後端回 409 → toast「該時段已被預約」且塊回原位（renderRegister 還原）。
4. **tap 回歸**：快速點一下預約塊（未移動）→ 開既有編輯彈窗（改時段/改客人/取消三鈕在）。
5. **空格登錄回歸**：點空格 → 開登錄彈窗（一般教練在全覽時點空格仍提示「請先選教練」）。
6. **全覽拖曳（管理者）**：切「全部教練」，拖任一教練的塊到空格 → 改期成功且**保留原教練**（重繪後塊仍標該教練、coach_name 不變）。
7. 控制台無錯誤；錄一小段 GIF 供業主預覽。

> 拖曳互動無對應前端單元測試框架（專案無 jsdom）；reschedule 後端行為已由 PR3 `tests/booking-edit.test.js`＋`tests/booking-edit-api.test.js` 覆蓋，本 PR 不重測、不新增後端測試。

## 不做（YAGNI）
- 不拉邊改時長（固定 60 分）。
- 不做拖曳邊緣自動捲動（v1 在可視範圍內拖放）。
- 不透過拖曳改授課教練（body 不帶 coachId，保留原教練）。
- 團課塊 `.reg-gp` 不可拖。
- 不改任何後端 route/service/測試。
- 不引入 jsdom/前端測試框架。
