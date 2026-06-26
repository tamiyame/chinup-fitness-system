# 後台「LINE 管理」頁籤 + 合併總覽到課程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台新增「LINE 管理」頁籤（列全部使用者綁定狀況、可逐人解除綁定），並把「總覽」內容併入「課程」頁。

**Architecture:** 後端加一支 admin per-user 解綁端點（重用既有 `unbindByUserId`）。前端在 `admin.html`/`admin.js` 新增「LINE 管理」頁籤＋面板，重用既有 `allUsers`（同一份 `/api/admin/users` fetch）渲染綁定表、搜尋+篩選、解綁。另把「總覽」面板內容搬進「課程」面板最下方、移除總覽頁籤、預設開課程頁。

**Tech Stack:** Express + node:sqlite（後端）、Vanilla JS ESM（`public/admin.js`）、`public/admin.html`、node:test（api 測試）。

## Global Constraints

- LINE 管理列出**全部使用者**（含教練/管理者），每列標角色徽章；列出含封存者（加「已封存」徽章+淡化）。
- 清單要**搜尋（姓名/電話）＋ 狀態篩選（全部／已綁／未綁）**。
- 解除綁定只清 `line_user_id`+綁定碼（重用 `unbindByUserId`），**不代產新碼、不呼叫 LINE 平台、不做帳號合併**。
- 解綁端點 `requireAdmin`（非 admin → 403）。
- 「總覽」內容（統計卡＋備份列）移到「課程」頁**最下方**；移除「總覽」頁籤；**預設開啟分頁改「課程」**。
- 回應/UI 文案繁體中文；前端輸出全程 `escapeHtml`（沿用既有）。
- 不動：LINE webhook/`consumeCode`/公開綁定流程/`resetAllLineBindings`/其他頁籤與功能。

---

## 既有程式碼錨點（實作者必讀）

`src/server.js`：
- `unbindByUserId` 已 import（行 77），DELETE /api/my/line 在用（行 224）：`unbindByUserId(userId)` 清該 user 的 `line_user_id`+`line_bind_code`+`line_bind_expires_at`（void）。
- `db` 在 server.js 全域可用（如行 208 `db.prepare(...)`）。`requireAdmin` middleware 既有。
- 既有 admin LINE 端點：`app.post('/api/admin/line/reset-all', requireAdmin, ...)`（行 542–544）。**新端點緊接其後加。**
- `GET /api/admin/users`（行 530）回所有 user 含 `id,name,email,phone,role,is_admin,has_google,line_user_id,birthday,address,archived_at,created_at`。

`public/admin.html`：
- 頁籤列 `#admin-tabs`（行 280–287）：`<button data-atab="overview" class="tab tab-active">總覽</button>` … `<button data-atab="notifs" class="tab">通知</button>`。
- 總覽面板 `#apanel-overview`（行 289–309）：統計卡 `<section class="grid ...">`（含 `#stat-templates` 等）＋備份列 `<section class="card mb-10 flex ...">`（含 `#backup-summary`/`#btn-backup-manage`），面板於行 309 `</div>` 收尾。
- 課程面板 `#apanel-courses`（行 310 開、課程分類+課程範本兩 section，於行 331 `</div>` 收尾）。
- 會員面板搜尋範本（行 374–386）：`#user-search`（search input）＋`#show-archived`（checkbox）＋`#users-table`。
- notifs 面板 `#apanel-notifs`（行 573–582，於行 582 `</div>` 收尾）；行 586 起為 `<!-- Modal -->`。**新面板 `#apanel-line` 插在行 582 之後、586 之前。**

`public/admin.js`：
- imports（行 1）：`api, toast, fmtDate, dow, bootAuth, escapeHtml`；`const user = await bootAuth(...)`（目前管理者）。
- `ROLE_LABEL = { owner:'擁有者', admin:'管理者', coach:'教練', user:'會員' }`、`ROLE_BADGE = { owner:'waitlisted', admin:'confirmed', coach:'coach', user:'open' }`（行 7–8）。
- `let allUsers`（會員清單快取）；`loadUsers()`（行 448–465）：`usersWired` 一次性綁搜尋/封存（行 453–457）→ `allUsers = await api('/api/admin/users')` → `renderUsersTable()`。
- 角色徽章規則（`renderUserRow`，行 508–510）：`is_admin ? '管理者'/'confirmed' : ROLE_LABEL/ROLE_BADGE[role]`。
- 頁籤切換（行 1601–1610，通用）：點 `#admin-tabs .tab` → toggle `tab-active` + 顯示對應 `#apanel-<atab>`。
- 載入時呼叫區（行 ~1588–1599）：`loadCategories()` … `loadUsers()` … `loadOneOnOnePrice()`。
- badge 樣式（`public/style.css` 145–148）：`.badge-open`（綠）、`.badge-confirmed`（藍）、`.badge-cancelled`（紅）、`.badge-completed`（灰）。

`tests/`（api 測試模式，見 `tests/member-admin-api.test.js`）：`BASE=process.env.BASE||'http://localhost:3000'`；`req(method,path,{body,token})` helper；admin 登入 `POST /api/auth/login {email:'admin@chinup.local',password:'admin1234'}`→token；coach 登入 `coach1@chinup.local/coachpass1234`（非 admin，role=coach）→測 403；以 `db.prepare` 插測試 user、email 前綴清理。`package.json` `test:api` 串接所有 api 測試。

---

## File Structure

- **Modify `src/server.js`**（Task 1）：reset-all 端點後加 `DELETE /api/admin/users/:id/line`。
- **Create `tests/admin-user-line-unbind-api.test.js`**（Task 1）+ **Modify `package.json`**（test:api 串接）。
- **Modify `public/admin.html`**（Task 2：加 LINE 頁籤+面板；Task 3：移除總覽頁籤、搬內容到課程、預設課程）。
- **Modify `public/admin.js`**（Task 2：`renderLineTable` + 解綁 + 一次性綁定 + loadUsers 加呼叫）。

任務切分：Task 1 後端（自帶 api 測試循環）；Task 2 LINE 管理前端（node --check 把關）；Task 3 合併總覽（node --check 把關）。三者各自可獨立審查。

---

### Task 1: 後端 per-user 解綁端點 + api 測試

**Files:**
- Modify: `src/server.js`（行 544 reset-all 端點之後）
- Create: `tests/admin-user-line-unbind-api.test.js`
- Modify: `package.json`（`test:api` 串接新測試）

**Interfaces:**
- Consumes（既有）：`unbindByUserId(userId)`（已 import）、`db`、`requireAdmin`、`asyncHandler`。
- Produces：`DELETE /api/admin/users/:id/line` → 200 `{ ok:true, was_bound:boolean }`；user 不存在 → 404 `{error:'user_not_found'}`；非 admin → 403。

- [ ] **Step 1：寫 api 測試（先失敗）**

建立 `tests/admin-user-line-unbind-api.test.js`：

```js
// API test: 管理者單一使用者解除 LINE 綁定（DELETE /api/admin/users/:id/line）。需 running server + seed admin/coach。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[admin-user-line-unbind-api] start');
const clean = () => db.exec("DELETE FROM users WHERE email LIKE 'lub-%'");
clean();

const adminLogin = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const adminToken = adminLogin.data?.token;
const coachLogin = await req('POST', '/api/auth/login', { body: { email: 'coach1@chinup.local', password: 'coachpass1234' } });
const coachToken = coachLogin.data?.token;

// 一位已綁定 + 一位未綁定
const boundId = Number(db.prepare("INSERT INTO users (name,email,role,line_user_id,line_bind_code,line_bind_expires_at) VALUES ('LUB Bound','lub-bound@x.com','user','Uxxx999','c1','2099-01-01T00:00:00')").run().lastInsertRowid);
const unboundId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('LUB Unbound','lub-unbound@x.com','user')").run().lastInsertRowid);

// 1) admin 解綁已綁定者 → 200 was_bound:true，DB line_user_id/code/expires 全清
const r1 = await req('DELETE', `/api/admin/users/${boundId}/line`, { token: adminToken });
expect('admin 解綁已綁定 → 200 was_bound:true', () => { assert.equal(r1.status, 200); assert.equal(r1.data.ok, true); assert.equal(r1.data.was_bound, true); });
expect('DB 綁定欄位全清空', () => {
  const u = db.prepare('SELECT line_user_id, line_bind_code, line_bind_expires_at FROM users WHERE id=?').get(boundId);
  assert.equal(u.line_user_id, null); assert.equal(u.line_bind_code, null); assert.equal(u.line_bind_expires_at, null);
});

// 2) admin 解綁未綁定者 → 200 was_bound:false（冪等）
const r2 = await req('DELETE', `/api/admin/users/${unboundId}/line`, { token: adminToken });
expect('admin 解綁未綁定 → 200 was_bound:false', () => { assert.equal(r2.status, 200); assert.equal(r2.data.was_bound, false); });

// 3) 不存在 user → 404 user_not_found
const r3 = await req('DELETE', `/api/admin/users/99999999/line`, { token: adminToken });
expect('不存在 → 404 user_not_found', () => { assert.equal(r3.status, 404); assert.equal(r3.data.error, 'user_not_found'); });

// 4) 非 admin（教練）→ 403
const r4 = await req('DELETE', `/api/admin/users/${unboundId}/line`, { token: coachToken });
expect('非 admin → 403', () => { assert.equal(r4.status, 403); });

clean();
console.log('[admin-user-line-unbind-api] done');
```

- [ ] **Step 2：跑測試確認失敗**

先啟動 server（背景）：`PORT=3000 node src/server.js &`（若尚未跑）。先確保有 seed：`node src/db/seed-demo.js`。
Run: `node tests/admin-user-line-unbind-api.test.js`
Expected: FAIL — 解綁端點不存在，`DELETE /api/admin/users/:id/line` 會落到既有路由或 404 fallback，`r1.status` 非 200（測試 ✗）。

- [ ] **Step 3：實作端點**

在 `src/server.js` 的 `app.post('/api/admin/line/reset-all', ...)`（行 542–544）區塊**之後**插入：

```js
// 管理用：解除『單一』使用者的 LINE 綁定（清 line_user_id + 進行中的綁定碼）。冪等。
app.delete('/api/admin/users/:id/line', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, line_user_id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  const was_bound = !!u.line_user_id;
  unbindByUserId(id);
  res.json({ ok: true, was_bound });
}));
```

- [ ] **Step 4：跑測試確認通過**

Run: `node tests/admin-user-line-unbind-api.test.js`
Expected: PASS（4 個 ✓，無 ✗）。

> 注意：`npm test` / 跑測試會清掉本機 `data/app.db` 共用資料；smoke 前需 `node src/db/seed-demo.js` 重新 seed。勿與其他背景跑測試的工作並行。

- [ ] **Step 5：把新測試串進 `package.json` 的 `test:api`**

把 `test:api` 結尾的 `&& node tests/my-schedule-packages-api.test.js` 之後接上 ` && node tests/admin-user-line-unbind-api.test.js`（即新測試加在 test:api 鏈最後）。

- [ ] **Step 6：Commit**

```bash
git add src/server.js tests/admin-user-line-unbind-api.test.js package.json
git commit -m "feat: admin 單一使用者 LINE 解綁端點 DELETE /api/admin/users/:id/line"
```

---

### Task 2: 前端「LINE 管理」頁籤

**Files:**
- Modify: `public/admin.html`（`#admin-tabs` 末端加按鈕；行 582 後加 `#apanel-line` 面板）
- Modify: `public/admin.js`（`renderLineTable` + 解綁 + 一次性綁定 + `loadUsers` 加呼叫）

**Interfaces:**
- Consumes：`allUsers`（既有，`/api/admin/users` 結果）、`api`/`toast`/`escapeHtml`/`fmtDate`/`user`、`ROLE_LABEL`/`ROLE_BADGE`、`DELETE /api/admin/users/:id/line`（Task 1）。
- Produces：`renderLineTable()`（依 `#line-search`+`#line-filter` 過濾 `allUsers` 畫 `#line-table`）、`doLineUnbind(id)`、`lineRoleBadge(r)`。搜尋/篩選監聽掛在既有 `usersWired` 一次性區塊（不另開旗標）。

- [ ] **Step 1：admin.html — 加「LINE 管理」頁籤按鈕**

在 `#admin-tabs`（行 287）`<button data-atab="notifs" class="tab" style="white-space:nowrap;">通知</button>` **之後**、`</div>`（行 288）之前插入：

```html
    <button data-atab="line" class="tab" style="white-space:nowrap;">LINE 管理</button>
```

- [ ] **Step 2：admin.html — 加 `#apanel-line` 面板**

在 `#apanel-notifs` 面板收尾 `</div>`（行 582）**之後**、`<!-- Modal -->`（行 586）之前插入：

```html
  <div id="apanel-line" class="tab-panel hidden">
  <section class="pb-16">
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
    <div class="card p-0 overflow-hidden">
      <div id="line-table"></div>
    </div>
  </section>
  </div>
```

- [ ] **Step 3：admin.js — 新增 `renderLineTable()` 與解綁處理**

在 `renderUsersTable` 函式定義之後（行 ~525 該函式結束處附近，模組層）新增以下兩個函式：

```js
function lineRoleBadge(r) {
  const kind = r.is_admin ? 'confirmed' : (ROLE_BADGE[r.role] || 'open');
  const label = r.is_admin ? '管理者' : (ROLE_LABEL[r.role] || r.role);
  return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}

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
            <td class="subtle">#${r.id}</td>
            <td><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
            <td>${lineRoleBadge(r)}</td>
            <td class="subtle">${escapeHtml(r.phone || '')}</td>
            <td>${statusBadge}</td>
            <td>${action}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  el.querySelectorAll('[data-line-unbind]').forEach(btn => btn.addEventListener('click', () => doLineUnbind(Number(btn.dataset.lineUnbind))));
}

async function doLineUnbind(id) {
  const u = (allUsers || []).find(x => x.id === id);
  if (!u) return;
  if (!confirm(`確定解除「${u.name}」（${u.phone || '無電話'}）的 LINE 綁定？\n解除後請該使用者用正確號碼重新綁定。`)) return;
  try {
    await api(`/api/admin/users/${id}/line`, { method: 'DELETE' });
    u.line_user_id = null;
    toast('已解除 LINE 綁定', 'success');
    renderLineTable();
  } catch (e) {
    toast(`解除失敗：${e.data?.error || e.message}`, 'error');
  }
}
```

- [ ] **Step 4：admin.js — `loadUsers` 內一次性綁定 LINE 搜尋/篩選 + 載入後渲染**

把 `loadUsers`（行 448–465）改為（在 `usersWired` 區塊加 LINE 綁定、try 內加 `renderLineTable()`）：

```js
async function loadUsers() {
  const note = document.getElementById('users-note');
  note.textContent = '長按會員可編輯資料 / 變更角色 / 封存';

  // 一次性綁定搜尋欄 + 顯示已封存切換（靜態元素，跨重繪持續存在）
  if (!usersWired) {
    document.getElementById('user-search')?.addEventListener('input', renderUsersTable);
    document.getElementById('show-archived')?.addEventListener('change', renderUsersTable);
    document.getElementById('line-search')?.addEventListener('input', renderLineTable);
    document.getElementById('line-filter')?.addEventListener('change', renderLineTable);
    usersWired = true;
  }

  try {
    allUsers = await api('/api/admin/users');
    renderUsersTable();
    renderLineTable();
  } catch (e) {
    document.getElementById('users-table').innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}
```

- [ ] **Step 5：語法檢查**

Run: `node --check public/admin.js`
Expected: 無輸出、exit 0。

- [ ] **Step 6：Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台 LINE 管理頁籤（列全部使用者綁定狀況+搜尋篩選+解除綁定）"
```

---

### Task 3: 合併總覽到課程

**Files:**
- Modify: `public/admin.html`（移除總覽頁籤、搬內容到課程面板最下方、預設課程）
- Modify: `public/admin.js`（驗無 overview 殘留引用；通常不需改）

**Interfaces:**
- Consumes：既有 `#apanel-courses`、統計卡/備份列 DOM（id 不變）。
- Produces：無新介面；總覽內容移入課程面板、預設分頁＝課程。

- [ ] **Step 1：admin.html — 移除「總覽」頁籤、改預設 active 為課程**

把 `#admin-tabs` 的 `<button data-atab="overview" class="tab tab-active" style="white-space:nowrap;">總覽</button>`（行 280）**整行刪除**；
並把 `<button data-atab="courses" class="tab" style="white-space:nowrap;">課程</button>`（行 281）改為帶 `tab-active`：

```html
    <button data-atab="courses" class="tab tab-active" style="white-space:nowrap;">課程</button>
```

- [ ] **Step 2：admin.html — 把總覽內容搬進課程面板最下方**

將原 `#apanel-overview`（行 289–309）內的**兩個 section**（統計卡 `<section class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">…</section>` 與備份列 `<section class="card mb-10 flex items-center gap-3">…</section>`）整段**剪下**，貼到 `#apanel-courses` 內、課程範本 section 之後（即 `#apanel-courses` 收尾 `</div>`（行 331）**之前**）。貼上的兩個 section 內容**原封不動**（所有 id 保留：`#stat-templates`/`#stat-sessions`/`#stat-regs`/`#stat-waitlist`/`#backup-summary`/`#backup-summary-error`/`#btn-backup-manage`）。

- [ ] **Step 3：admin.html — 刪除清空後的總覽面板容器**

把已被掏空的 `<div id="apanel-overview" class="tab-panel">` 與其對應 `</div>`（原行 289 與 309）刪除（含中間殘留註解），確保不留空的 `#apanel-overview`。`#apanel-courses` 仍須移除 `hidden`（預設顯示）：把 `<div id="apanel-courses" class="tab-panel hidden">`（行 310）改為 `<div id="apanel-courses" class="tab-panel">`。

- [ ] **Step 4：admin.js — 確認無 overview 殘留引用**

Run: `grep -nE "apanel-overview|data-atab=.overview.|'overview'|\"overview\"" public/admin.js`
Expected: 無輸出（admin.js 不曾硬引用 overview；頁籤切換為通用、統計/備份 loader 抓的是 `#stat-*`/`#backup-*` id，與面板位置無關）。**若有輸出**：逐處改為對應課程面板邏輯後再繼續。

- [ ] **Step 5：語法檢查 + 結構檢查**

Run: `node --check public/admin.js`
Expected: 無輸出、exit 0。
Run: `grep -c 'data-atab="overview"' public/admin.html`
Expected: `0`（總覽頁籤已移除）。
Run: `grep -c 'id="apanel-overview"' public/admin.html`
Expected: `0`（總覽面板已移除）。
Run: `grep -c 'id="stat-templates"' public/admin.html`
Expected: `1`（統計卡仍在，已搬到課程面板）。

- [ ] **Step 6：Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "refactor: 合併後台總覽到課程頁（移除總覽頁籤、統計卡+備份列移課程頁底、預設開課程）"
```

---

## 驗證（控制者親跑，非 subagent 任務）

實作三任務並各自通過 review 後，控制者執行：
1. **後端測試**：`node src/db/seed-demo.js` 後 `node tests/admin-user-line-unbind-api.test.js`（4 ✓）；並跑一次完整 `npm test`（綠燈，純加法不影響既有）。再 `node src/db/seed-demo.js` 還原 demo 資料。
2. **瀏覽器 smoke**（本機 `npm start`，管理者登入 `admin@chinup.local/admin1234`）：
   - 「LINE 管理」頁籤出現在最末；面板列出全部使用者（角色徽章、已綁/未綁、封存徽章）。
   - 搜尋姓名/電話即時過濾；狀態篩選全部/已綁/未綁正確。
   - 對一位已綁定者按「解除綁定」→ confirm → 狀態翻為「未綁定」、按鈕消失；重整後仍未綁定（DB 已清）。
   - 「總覽」頁籤已不存在；統計卡＋備份列出現在「課程」頁最下方；進後台**預設停在「課程」**；其他頁籤（報名作業/會員/教練/折扣碼/通知/LINE 管理）切換正常。
   - 控制台無錯誤。
3. （上線後，prod）用本工具解除陳怡君 id 38（0628685158）綁定，請她以 0928685158（id 12）重綁；空帳號 id 38 可封存。

## 不做（YAGNI）
- 不做批次解綁（已有 reset-all）。
- 不做解綁後代產碼/代綁、不做帳號合併。
- LINE 管理不分頁。
- 不動 LINE webhook/公開綁定/其他頁籤。
