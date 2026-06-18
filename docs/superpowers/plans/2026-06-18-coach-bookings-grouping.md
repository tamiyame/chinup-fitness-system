# 教練後台「我的預約」依客人分組可收合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教練後台「我的預約」把同一客人多堂個別課收合成可展開的群組卡，提升易讀性。

**Architecture:** 純前端。`coach.html` 的 Nike overlay `<style>` 加 `.bk-*` 樣式；`coach.js` 重寫 `renderBookings()` 依 `member_id` 分組、收合一列＋常駐下一堂、依下一堂排序、展開列出全部堂、聚焦淡化、保留展開狀態。後端/API 不動。

**Tech Stack:** 原生 ES module（`public/coach.js` import 自 `app.js`）；資料來自 `GET /api/coach/me/bookings`（回 `b.*` 含 member_id/start_at/status/session_type/paid_at/cancel_reason ＋ member_name）。無前端測試框架 → 以 `node --check` + grep + 人工瀏覽器煙霧驗證。

**Spec:** `docs/superpowers/specs/2026-06-18-coach-bookings-grouping-design.md`

---

## File Structure
- **Modify** `public/coach.html` — 在 Nike overlay `<style>`（`</style>` 之前）新增 `.bk-*` 群組卡樣式。
- **Modify** `public/coach.js` — 新增 `expandedMembers` 模組狀態、`fmtSlot`/`statusDot` helper、`onCoachChange` 清空展開狀態、重寫 `renderBookings()`。
- **Delete**（收尾）`public/_mock_coach_bookings.html` — 暫存預覽檔，不進版控。

---

## Task 1: coach.html — 新增群組卡 CSS

**Files:** Modify `public/coach.html`

- [ ] **Step 1: 在 coach.html 的 `<style>` 區塊結尾（`</style>` 之前）插入以下 CSS**

```css
/* ── 我的預約：客人分組可收合卡（緊湊 + 聚焦淡化）── */
#bk-list .bk-group{ border:1px solid var(--line); border-radius:9px; background:#fff; margin-bottom:6px; position:relative; overflow:hidden; transition:opacity .18s ease; }
#bk-list .bk-group::before{ content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--brand-600); }
#bk-list .bk-group.is-allpast::before{ background:var(--line); }
#bk-list.has-open .bk-group:not(.open){ opacity:.4; }
#bk-list.has-open .bk-group:not(.open):hover{ opacity:.72; }
.bk-head{ display:flex; align-items:center; gap:10px; padding:8px 12px 8px 15px; cursor:pointer; user-select:none; min-height:42px; }
.bk-toggle:hover{ background:#fafdff; }
.bk-single .bk-head{ cursor:default; }
.bk-id{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1; min-width:0; }
.bk-name{ font-family:"Noto Sans TC",sans-serif; font-weight:900; font-size:14px; letter-spacing:-.01em; }
.bk-sep{ width:3px; height:3px; border-radius:50%; background:var(--line); flex:none; }
.bk-next-d{ font-family:"Archivo",sans-serif; font-weight:700; font-size:12.5px; font-variant-numeric:tabular-nums; letter-spacing:.02em; color:var(--ink-soft); }
.bk-count{ font-family:"Archivo",sans-serif; font-weight:800; font-size:11px; letter-spacing:.02em; color:var(--brand-700); background:var(--brand-50); border:1px solid var(--brand-100); border-radius:999px; padding:2px 8px; white-space:nowrap; }
.bk-chev{ color:var(--ink-mute); transition:transform .15s ease; flex:none; }
.bk-group.open .bk-chev{ transform:rotate(90deg); }
.bk-body{ border-top:1px solid var(--line); padding:2px 12px 4px 15px; }
.bk-group:not(.open) .bk-body{ display:none; }
.bk-sess{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); }
.bk-sess:last-child{ border-bottom:0; }
.bk-sess-when{ font-family:"Archivo",sans-serif; font-weight:700; font-size:13px; font-variant-numeric:tabular-nums; letter-spacing:.02em; color:var(--ink-strong); display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.bk-cancel{ font-family:"Archivo",sans-serif; font-weight:700; font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--err-fg); border:1px solid var(--line); border-radius:7px; padding:5px 10px; background:#fff; white-space:nowrap; min-height:32px; }
.bk-cancel:hover{ border-color:var(--err-fg); }
```

> 這些 token（`--brand-600/700/50/100`、`--line`、`--ink-soft/mute/strong`、`--err-fg`）皆已定義於 `colors_and_type.css`（coach.html 已 link）。既有 `.tab-bookings-card` 規則因 markup 改變不再套用，保留不刪（惰性、零風險）。

- [ ] **Step 2: 驗證 CSS 已存在且頁面可服務**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
grep -c "#bk-list .bk-group" public/coach.html && echo "css present"
lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js >/tmp/srv-t1.log 2>&1 &
SRV=$!; sleep 2
curl -s http://localhost:3000/coach.html | grep -c "bk-count" && echo "served"
kill $SRV 2>/dev/null
```
Expected: 兩個 grep 都 ≥1。

- [ ] **Step 3: Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/coach.html
git commit -m "style(coach): 我的預約客人分組卡 CSS"
```

---

## Task 2: coach.js — 重寫 renderBookings 為分組可收合

**Files:** Modify `public/coach.js`

- [ ] **Step 1: 新增模組狀態 `expandedMembers`**

在 `public/coach.js` 的 `let selectedCoachId = null;` 之後新增一行：
```js
const expandedMembers = new Set(); // 展開中的客人 member_id（重繪時保留展開狀態）
```

- [ ] **Step 2: `onCoachChange()` 切換教練時清空展開狀態**

把 `onCoachChange` 內：
```js
  selectedCoachId = v ? Number(v) : null;
```
改為：
```js
  selectedCoachId = v ? Number(v) : null;
  expandedMembers.clear(); // 換教練重新開始
```

- [ ] **Step 3: 新增 `fmtSlot` / `statusDot` helper**

在 `renderBookings` 函式定義之前（例如 `function refreshPendingBanner(){...}` 之後）新增：
```js
// '2026-06-21T17:00:00' → '06/21 17:00'（緊湊、省年）
function fmtSlot(startAt) {
  return String(startAt || '').slice(5, 16).replace('T', ' ').replace('-', '/');
}
function statusDot(b) {
  return b.paid_at ? '<span class="nk-dot ok">已確認</span>' : '<span class="nk-dot warn">待確認</span>';
}
```

- [ ] **Step 4: 以下列完整內容取代整個 `async function renderBookings() { ... }`**

```js
async function renderBookings() {
  const wrap = $('tab-bookings');
  if (needsCoachSelection()) { wrap.innerHTML = PICK_PROMPT; return; }
  const list = await api(`/api/coach/me/bookings${coachQuery()}`);
  if (list.length === 0) { wrap.innerHTML = '<p class="text-slate-500">沒有預約</p>'; return; }

  const now = Date.now();
  const isUpcoming = (b) => b.status !== 'cancelled' && new Date(b.start_at).getTime() > now;
  const asc = (a, b) => (a.start_at < b.start_at ? -1 : 1);
  const desc = (a, b) => (a.start_at > b.start_at ? -1 : 1);

  // 依 member_id 分組
  const groups = new Map();
  for (const b of list) {
    let g = groups.get(b.member_id);
    if (!g) { g = { memberId: b.member_id, name: b.member_name, has1on2: false, gs: [] }; groups.set(b.member_id, g); }
    g.gs.push(b);
    if (b.session_type === '1on2') g.has1on2 = true;
  }

  // 每組算錨點 + 排序資料
  const cards = [];
  for (const g of groups.values()) {
    const active = g.gs.filter(b => b.status !== 'cancelled');
    const upcoming = active.filter(isUpcoming).sort(asc);
    const pastActive = active.filter(b => !isUpcoming(b)).sort(desc);
    const cancelled = g.gs.filter(b => b.status === 'cancelled').sort(desc);
    const anchor = upcoming[0] || pastActive[0] || cancelled[0];
    cards.push({ g, activeCount: active.length, hasUpcoming: upcoming.length > 0, anchor,
      ordered: [...upcoming, ...pastActive, ...cancelled] });
  }

  // 群組排序：有 upcoming 在前（錨點升冪）；無 upcoming 在後（錨點降冪）
  cards.sort((A, B) => {
    if (A.hasUpcoming !== B.hasUpcoming) return A.hasUpcoming ? -1 : 1;
    return A.hasUpcoming ? asc(A.anchor, B.anchor) : desc(A.anchor, B.anchor);
  });

  const anchorStatus = (b) => (b.status === 'cancelled'
    ? '<span class="nk-dot" style="color:var(--ink-mute)">已取消</span>' : statusDot(b));
  const sessRow = (b) => {
    const tag = b.session_type === '1on2' ? ' <span class="nk-tag">1對2</span>' : '';
    if (b.status === 'cancelled') {
      return `<div class="bk-sess is-cancelled"><span class="bk-sess-when" style="color:var(--ink-mute)">${fmtSlot(b.start_at)}${tag} · 已取消${b.cancel_reason ? `（${escapeHtml(b.cancel_reason)}）` : ''}</span></div>`;
    }
    if (!isUpcoming(b)) {
      return `<div class="bk-sess"><span class="bk-sess-when" style="color:var(--ink-mute)">${fmtSlot(b.start_at)}${tag} · 已結束</span></div>`;
    }
    return `<div class="bk-sess"><span class="bk-sess-when">${fmtSlot(b.start_at)}${tag} ${statusDot(b)}</span><button data-id="${b.id}" class="bk-cancel cancel-btn">緊急取消</button></div>`;
  };

  let html = '<div id="bk-list">';
  for (const c of cards) {
    const g = c.g;
    const allPast = c.hasUpcoming ? '' : ' is-allpast';
    const nameTag = g.has1on2 ? ' <span class="nk-tag">1對2</span>' : '';
    if (g.gs.length === 1) {
      const b = g.gs[0];
      const canCancel = isUpcoming(b);
      html += `
        <div class="bk-group bk-single${allPast}">
          <div class="bk-head">
            <div class="bk-id">
              <span class="bk-name">${escapeHtml(g.name)}</span>${nameTag}
              <span class="bk-sep"></span>
              <span class="bk-next-d">${fmtSlot(b.start_at)}</span>
              ${anchorStatus(b)}
            </div>
            ${canCancel ? `<button data-id="${b.id}" class="bk-cancel cancel-btn">緊急取消</button>` : ''}
          </div>
        </div>`;
    } else {
      const open = expandedMembers.has(g.memberId) ? ' open' : '';
      html += `
        <div class="bk-group${open}${allPast}" data-mid="${g.memberId}">
          <div class="bk-head bk-toggle">
            <div class="bk-id">
              <span class="bk-name">${escapeHtml(g.name)}</span>${nameTag}
              <span class="bk-sep"></span>
              <span class="bk-next-d">${fmtSlot(c.anchor.start_at)}</span>
              ${anchorStatus(c.anchor)}
            </div>
            <span class="bk-count">共 ${c.activeCount} 堂</span>
            <svg class="bk-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>
          </div>
          <div class="bk-body">${c.ordered.map(sessRow).join('')}</div>
        </div>`;
    }
  }
  html += '</div>';
  wrap.innerHTML = html;

  const listEl = $('bk-list');
  const syncFocus = () => listEl.classList.toggle('has-open', listEl.querySelector('.bk-group.open') != null);
  syncFocus();

  // 展開/收合（點 head；點到取消鈕不觸發）
  wrap.querySelectorAll('.bk-toggle').forEach(head => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('.cancel-btn')) return;
      const group = head.closest('.bk-group');
      const mid = Number(group.dataset.mid);
      if (group.classList.toggle('open')) expandedMembers.add(mid); else expandedMembers.delete(mid);
      syncFocus();
    });
  });

  // 緊急取消
  wrap.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const reason = prompt('取消原因（會通知會員）：');
      if (!reason) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}${coachQuery()}`, { method: 'DELETE', body: { reason } });
        toast('已取消');
        renderBookings();
      } catch (err) {
        toast(`取消失敗：${err.message}`, 'error');
      }
    });
  });
}
```

- [ ] **Step 5: 語法 + 服務驗證**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
node --check public/coach.js && echo "coach.js syntax OK"
grep -c "expandedMembers\|fmtSlot\|bk-toggle\|has-open" public/coach.js
lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js >/tmp/srv-t2.log 2>&1 &
SRV=$!; sleep 2
curl -s http://localhost:3000/coach.js | grep -c "function renderBookings" && echo "served new code"
kill $SRV 2>/dev/null
```
Expected: `coach.js syntax OK`；grep ≥4；served ≥1。

- [ ] **Step 6: Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/coach.js
git commit -m "feat(coach): 我的預約依客人分組可收合（含聚焦淡化、保留展開狀態）"
```

---

## Task 3: 人工瀏覽器煙霧測試 + 清理 + 收尾

**Files:** Delete `public/_mock_coach_bookings.html`（驗證用，無程式碼改動）

- [ ] **Step 1: 移除暫存預覽檔**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
rm -f public/_mock_coach_bookings.html
```

- [ ] **Step 2: 人工瀏覽器煙霧測試（由控制端執行）**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
npm run seed >/tmp/s.log 2>&1 && node src/db/seed-demo.js >>/tmp/s.log 2>&1
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js >/tmp/srv-smoke.log 2>&1 &
# 以 admin 登入取得 token 注入 localStorage（避免輸入密碼），開 /coach.html，選有多堂客人的教練
```
驗收（人工）：
1. 同一客人 ≥2 堂收合成一列＋「下一堂 + 共 N 堂」；群組依下一堂由近到遠排序。
2. 點開 → 列出全部堂、其餘卡片淡化；再點收合、淡化解除；無 console error。
3. 展開狀態下對某堂「緊急取消」→ 重繪後該組仍展開、堂數更新。
4. 單堂客人為一列、直接可取消；過去/已取消列灰字無取消鈕。
5. 一般教練（非 admin）正常；admin 切換教練後展開狀態重置。

- [ ] **Step 3: 全套回歸（確認沒動到別處）**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
npm test 2>&1 | grep -E "✗" || echo "unit suite: no ✗"
npm run seed && node src/db/seed-demo.js   # npm test 清過 demo，重 seed
```
Expected: 無 ✗（本變更純前端，不影響後端測試）。

- [ ] **Step 4: 收尾**

以 `superpowers:finishing-a-development-branch` 收尾（依慣例 push + squash merge 至 main → 自動部署 prod）。

---

## Self-Review

**1. Spec coverage**
- 依 member_id 分組：Task 2 Step 4 ✓
- 收合一列＋常駐下一堂（錨點）：Task 2（`.bk-single`/群組 head 顯示 `fmtSlot(anchor)`）✓
- 依「下一堂最接近今天」排序：Task 2（cards.sort：有 upcoming 升冪在前、無 upcoming 降冪在後）✓
- 展開列出全部堂、過去灰字無鈕、已取消可展開查看：Task 2 `sessRow` ✓
- gs.length 判定單列 vs 群組：Task 2 ✓
- 共 N 堂 = active（不含取消）：Task 2 `activeCount` ✓
- 聚焦淡化（容器 has-open class，非 :has()）：Task 1 CSS + Task 2 `syncFocus` ✓
- 保留展開狀態 / 切教練重置：Task 2 `expandedMembers` + Step 2 ✓
- fmtSlot 緊湊日期：Task 2 Step 3 ✓
- 沿用現有取消流程：Task 2（`/api/bookings/:id{coachQuery()}` + reason）✓
- 清掉暫存 mock：Task 3 Step 1 ✓
- 後端不動：全計畫無 src/ 改動 ✓

**2. Placeholder scan**：無 TBD/TODO；每步含完整 CSS/JS 與實際指令。✓

**3. Type/identifier consistency**
- CSS 類別 `bk-group/bk-head/bk-toggle/bk-single/bk-id/bk-name/bk-sep/bk-next-d/bk-count/bk-chev/bk-body/bk-sess/bk-sess-when/bk-cancel/is-allpast/is-cancelled/open/has-open` 與 Task 2 產生的 markup 一致；容器 id `bk-list` 一致。✓
- `cancel-btn` class 同時用於單列與 body 取消鈕，由同一個 cancel 監聽器處理；`data-id`/`data-mid` 命名一致。✓
- `expandedMembers`、`fmtSlot`、`statusDot`、`anchorStatus`、`isUpcoming`、`asc`/`desc` 定義與使用一致。✓
- 沿用既有 `coachQuery()`/`needsCoachSelection()`/`PICK_PROMPT`/`escapeHtml`/`toast`/`api`/`$`。✓
