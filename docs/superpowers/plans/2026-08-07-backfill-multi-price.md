# 截止後補報＋補報名多選與逐人單價 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台團課補報名：未開課場次不再限「已開課後」（截止～開課窗口即可補、復活時補發教練成班通知）；補報名面板改多選客人＋逐人單價（預帶範本價可改可 0）＋整批已收款一次送出。

**Architecture:** 後端只動 `adminBackfillRegistration`（放寬擋條、選填 `price` 參數、復活通知）與路由透傳；前端整支重寫 `openBackfillPanel`（多選 state＋單價確認層＋序列送出彙整結果），按鈕條件放寬、drawer 記範本單價。既有測試中斷言舊行為的兩處測項**依 spec 翻面**。

**Tech Stack:** Node ESM + Express + node:sqlite；vanilla JS 前端；plain-node assert 測試。

**Spec:** `docs/superpowers/specs/2026-08-07-backfill-multi-price-design.md`

## Global Constraints

- Repo：`/Users/ryansheu/projects/chinup-fitness-system`（每個指令先 `cd` 進去；shell cwd 可能被重設）。分支 `feature/backfill-multi-price`（spec 已 commit `d845922`）。
- 零改動：滿額候補邏輯（滿額＋paid → `paid_requires_seat`；滿額未付 → 候補）、已報名防重、find-or-create 客人規則、`course_registered_coach` 逐筆通知、`promoteWaitlist`、公開頁、我的課表、薪資計算程式。
- 單元測試 fresh DB gate：`DB_PATH="$(mktemp -d)/t.db" node tests/admin-group-reg.test.js`——**絕不對 data/app.db 跑單元測試**。
- API 測試需 server 跑著：`LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 npm start`（跑完自己收；埠被佔先 `kill $(lsof -ti :3000)`）。API 測試會弄髒 demo DB，收尾任務會 reseed。
- **既有測項翻面是 spec 指令**（勿視為破壞測試）：unit §7「未來的未開課場次補報 → 409」與 API「未來未開課補報 → 409」兩處，依新 spec 改為可補＋復活。
- `price` 語意：選填；非 null 必須非負整數否則 `400 invalid_price`；null 沿用範本 `price_per_session`。服務層用「參數重賦值」實作（`price = price !== null ? price : tpl.price_per_session;`）以零改動下游 5 個用價點——**勿**宣告新 `const price`（與參數同名會 SyntaxError）。
- 復活通知 count 口徑＝**佔位人數**（`status IN ('confirmed','pending')`）：未付補報的首筆是 pending，若只算 confirmed 會發「共 0 人」。（Task 1 內含一行 spec 修正對齊此口徑。）
- 文案繁體中文；Commit 訊息結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 後端 — 放寬擋條＋price 參數＋復活通知（TDD，含測項翻面）

**Files:**
- Modify: `tests/admin-group-reg.test.js`（§7 一處翻面＋新增 §7c/§7d）
- Modify: `tests/admin-group-reg-api.test.js`（一處翻面＋price 透傳案例）
- Modify: `src/services/groupOrderService.js`（`adminBackfillRegistration`）
- Modify: `src/server.js`（`POST /api/admin/sessions/:id/registrations` 路由）

**Interfaces:**
- Consumes: 既有 `notifyCourseCoach`（groupOrderService 已 import）、`course_confirmed_coach` 模板。
- Produces: `adminBackfillRegistration({ …, price = null })`；路由 body 接受選填 `price`。Task 2 前端依賴：body `{ userId | name+phone, paid, price }`、錯誤碼 `invalid_price`。

- [ ] **Step 1: unit 測項翻面（§7）**

`tests/admin-group-reg.test.js` 原：

```js
  expect('未來的未開課場次補報 → 409 session_cancelled（paid/unpaid 皆擋）', () => {
    assert.throws(() => adminBackfillRegistration({ sessionId: s2, name: 'AGR-復活客', phone: '0996700001', paid: false, actorId }), /session_cancelled/);
    assert.throws(() => adminBackfillRegistration({ sessionId: s2, name: 'AGR-復活客', phone: '0996700001', paid: true, actorId }), /session_cancelled/);
  });
```

改為：

```js
  expect('未來（截止後）的未開課場次補報 → 可補＋復活成已成班（截止～開課窗口）', () => {
    const rf = adminBackfillRegistration({ sessionId: s2, name: 'AGR-窗口客', phone: '0996700003', paid: false, actorId });
    assert.equal(rf.status, 'pending');
    assert.equal(sessionStatus(s2), 'confirmed');
  });
```

- [ ] **Step 2: unit 新增 §7c（復活通知）與 §7d（price）**

插入位置：`// ── §7b 原 rejected 客人重補（同列 reactivate）＋已收款補報計入薪資 ──` 該行**之前**，插入以下整段：

```js
// ── §7c 復活通知：截止後（未開課、未開始）復活 → 教練成班通知；過去復活維持靜默 ──
reset();
{
  const coachUserId = Number(db.prepare("INSERT INTO users (name, role) VALUES ('AGR-通知教練', 'coach')").run().lastInsertRowid);
  const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'AGR-通知教練', 1)").run(coachUserId).lastInsertRowid);
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理5', 'agr-admin5@x.com', 'coach', 1)").run().lastInsertRowid);
  const tpl = createTemplate({
    name: 'AGR-通知班', min_capacity: 1, max_capacity: 3,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(15),
    registration_deadline_hours: 1, price_per_session: 500, coach_id: coachId,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const [sPast, sFuture] = ss;
  agePast(sPast);
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id IN (?, ?)").run(sPast, sFuture);
  const confirmNotifs = (sid) => db.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE session_id=? AND type='course_confirmed_coach' AND user_id=?"
  ).get(sid, coachUserId).c;

  expect('截止後未開課補報復活 → 教練收到一則成班通知（count=佔位人數）', () => {
    adminBackfillRegistration({ sessionId: sFuture, name: 'AGR-窗口甲', phone: '0996700011', paid: false, actorId });
    assert.equal(db.prepare('SELECT status FROM course_sessions WHERE id=?').get(sFuture).status, 'confirmed');
    assert.equal(confirmNotifs(sFuture), 1);
    const n = db.prepare("SELECT body FROM notifications WHERE session_id=? AND type='course_confirmed_coach' AND user_id=?").get(sFuture, coachUserId);
    assert.match(n.body, /1 人/);
  });

  expect('復活後再補第二人 → 不再重發成班通知', () => {
    adminBackfillRegistration({ sessionId: sFuture, name: 'AGR-窗口乙', phone: '0996700012', paid: false, actorId });
    assert.equal(confirmNotifs(sFuture), 1);
  });

  expect('過去未開課補報復活 → 維持靜默（無成班通知）', () => {
    adminBackfillRegistration({ sessionId: sPast, name: 'AGR-窗口丙', phone: '0996700013', paid: false, actorId });
    assert.equal(db.prepare('SELECT status FROM course_sessions WHERE id=?').get(sPast).status, 'confirmed');
    assert.equal(confirmNotifs(sPast), 0);
  });
}

// ── §7d 逐人單價：price 覆寫／0 元／未帶沿用範本價／非法值 ──
reset();
{
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理6', 'agr-admin6@x.com', 'coach', 1)").run().lastInsertRowid);
  const tpl = createTemplate({
    name: 'AGR-單價班', min_capacity: 1, max_capacity: 6,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(8),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const sid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').get(tpl.templateId).id;
  const regPrice = (registrationId) => db.prepare('SELECT amount_due FROM registrations WHERE id=?').get(registrationId).amount_due;
  const orderTotal = (orderId) => db.prepare('SELECT total_amount, original_amount, status FROM group_orders WHERE id=?').get(orderId);

  expect('paid＋price 350 → 已核對單金額 350、reg 價 350', () => {
    const r = adminBackfillRegistration({ sessionId: sid, name: 'AGR-價甲', phone: '0996700021', paid: true, actorId, price: 350 });
    assert.equal(r.status, 'confirmed');
    const o = orderTotal(r.orderId);
    assert.equal(o.status, 'paid');
    assert.equal(o.total_amount, 350);
    assert.equal(o.original_amount, 350);
    assert.equal(regPrice(r.registrationId), 350);
  });

  expect('unpaid＋price 0 → 待付單金額 0、reg 價 0', () => {
    const r = adminBackfillRegistration({ sessionId: sid, name: 'AGR-價乙', phone: '0996700022', paid: false, actorId, price: 0 });
    assert.equal(r.status, 'pending');
    assert.equal(orderTotal(r.orderId).total_amount, 0);
    assert.equal(regPrice(r.registrationId), 0);
  });

  expect('未帶 price → 沿用範本價 500', () => {
    const r = adminBackfillRegistration({ sessionId: sid, name: 'AGR-價丙', phone: '0996700023', paid: true, actorId });
    assert.equal(orderTotal(r.orderId).total_amount, 500);
    assert.equal(regPrice(r.registrationId), 500);
  });

  expect('price 非法（負數/小數/字串）→ 400 invalid_price 且不建立客人', () => {
    for (const bad of [-1, 1.5, '300']) {
      assert.throws(() => adminBackfillRegistration({ sessionId: sid, name: 'AGR-價丁', phone: '0996700024', paid: true, actorId, price: bad }), /invalid_price/);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE name='AGR-價丁'").get().c, 0);
  });
}

```

- [ ] **Step 3: API 測項翻面＋price 案例**

`tests/admin-group-reg-api.test.js` 原：

```js
const futureCancelled = await req('POST', `/api/admin/sessions/${sidFuture}/registrations`, { token, body: { name: 'AGRAPI復活客', phone: '0995000002', paid: false } });
expect('未來未開課補報 → 409 session_cancelled', () => { assert.equal(futureCancelled.status, 409); assert.equal(futureCancelled.data.error, 'session_cancelled'); });
```

改為：

```js
const futureCancelled = await req('POST', `/api/admin/sessions/${sidFuture}/registrations`, { token, body: { name: 'AGRAPI復活客', phone: '0995000002', paid: false } });
expect('未來（截止後）未開課補報 → 201 且復活', () => {
  assert.equal(futureCancelled.status, 201);
  assert.equal(db.prepare('SELECT status FROM course_sessions WHERE id=?').get(sidFuture).status, 'confirmed');
});

const priced = await req('POST', `/api/admin/sessions/${sidFuture}/registrations`, { token, body: { name: 'AGRAPI價客', phone: '0995000003', paid: true, price: 250 } });
expect('price 透傳 → 已核對單金額 250', () => {
  assert.equal(priced.status, 201);
  const o = db.prepare('SELECT total_amount FROM group_orders WHERE id=?').get(priced.data.orderId);
  assert.equal(o.total_amount, 250);
});
```

- [ ] **Step 4: 跑測試確認失敗**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/admin-group-reg.test.js
```

Expected: §7 翻面案與 §7c/§7d 標 ✗（409 session_cancelled 仍在、price 參數不存在）。（API 檔此步不用跑，實作後一起跑。）

- [ ] **Step 5: 服務實作（四處編輯）**

`src/services/groupOrderService.js`：

編輯 1——簽名，原：

```js
export function adminBackfillRegistration({ sessionId, userId = null, name = null, phone = null, paid = false, actorId }) {
```

改為：

```js
export function adminBackfillRegistration({ sessionId, userId = null, name = null, phone = null, paid = false, actorId, price = null }) {
```

編輯 2——移除未來擋，原：

```js
    // 未開課場次：過去可補登（補報即復活，見下）；未來維持不可補（業主定案：流課是未知數，要等時間過了才知道）
    if (s.status === 'cancelled' && s.start_at > now) throw new ApiError(409, 'session_cancelled');
```

改為：

```js
    // 未開課場次一律可補（cancelled 必然截止判定已過、非未知數；補報即復活，見下）
```

編輯 3——price 解析（參數重賦值、零改下游），原：

```js
    const isPast = s.start_at <= now;
    const price = tpl.price_per_session;
```

改為：

```js
    const isPast = s.start_at <= now;
    if (price !== null && (!Number.isInteger(price) || price < 0)) throw new ApiError(400, 'invalid_price');
    price = price !== null ? price : tpl.price_per_session;
```

編輯 4——復活通知，原：

```js
    // 補報即復活：原判未開課的過去場次，首筆補報成功即恢復「已成班」——薪資/客人統計/公開頁三口徑自然導出
    if (s.status === 'cancelled') db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(sessionId);
```

改為：

```js
    // 補報即復活：原判未開課場次，首筆補報成功即恢復「已成班」——薪資/客人統計/公開頁三口徑自然導出。
    // 尚未開始（截止～開課窗口）時補發教練成班通知（教練在截止時已收過「未開成」，須知道課回來了）；過去場次維持靜默。
    if (s.status === 'cancelled') {
      db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(sessionId);
      if (!isPast) {
        const count = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id=? AND status IN ('confirmed','pending')").get(sessionId).c;
        notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_confirmed_coach',
          vars: { course_name: tpl.name, start_at: s.start_at, count } });
      }
    }
```

`src/server.js` 路由，原：

```js
  const { userId, name, phone, paid } = req.body || {};
  res.status(201).json(svcAdminBackfillReg({
    sessionId: Number(req.params.id),
    userId: userId != null ? Number(userId) : null,
    name: name != null ? String(name) : null,
    phone: phone != null ? String(phone) : null,
    paid: paid === true,
    actorId: req.user.id,
  }));
```

改為：

```js
  const { userId, name, phone, paid, price } = req.body || {};
  res.status(201).json(svcAdminBackfillReg({
    sessionId: Number(req.params.id),
    userId: userId != null ? Number(userId) : null,
    name: name != null ? String(name) : null,
    phone: phone != null ? String(phone) : null,
    paid: paid === true,
    actorId: req.user.id,
    price: price != null ? Number(price) : null,
  }));
```

- [ ] **Step 6: 跑測試確認通過**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/admin-group-reg.test.js
cd /Users/ryansheu/projects/chinup-fitness-system && kill $(lsof -ti :3000) 2>/dev/null; LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 npm start &  # 等 2 秒起來
cd /Users/ryansheu/projects/chinup-fitness-system && node tests/admin-group-reg-api.test.js
```

Expected: 兩檔全 ✓、exit 0。跑完 `kill $(lsof -ti :3000)`。

- [ ] **Step 7: Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system && git add tests/admin-group-reg.test.js tests/admin-group-reg-api.test.js src/services/groupOrderService.js src/server.js
git commit -m "feat: 截止後未開課可補報（復活補發教練成班通知）＋補報名選填 price"
```

---

### Task 2: 前端 — 補報名面板多選＋單價層＋整批送出

**Files:**
- Modify: `public/admin.js`（模組變數、openDrawer、場次列按鈕條件、整支 `openBackfillPanel` 重寫）
- Modify: `public/admin.html`（面板 CSS 追加）

**Interfaces:**
- Consumes: Task 1 的 body `{ userId | name+phone, paid, price }` 與錯誤碼 `invalid_price`；既有 `drawerSessions`、`reloadRoster`、`refreshSessionSummary`、`loadPendingOrders`、`loadConfirmedPayments`、`SESSION_STATUS_LABEL`、`api`、`toast`、`escapeHtml`、`localNowStr`。
- Produces: 無（終端 UI）。

- [ ] **Step 1: 模組變數＋openDrawer 記範本單價**

原（admin.js 384-385）：

```js
let drawerTemplateId = null;
const drawerSessions = new Map(); // sid → { start_at, occupied, max, status }
```

改為：

```js
let drawerTemplateId = null;
let drawerPricePerSession = 0; // 補報名單價層的預設值（開 drawer 時記下範本單堂價）
const drawerSessions = new Map(); // sid → { start_at, occupied, max, status }
```

原（openDrawer 內）：

```js
    const t = await api(`/api/admin/templates/${templateId}`);
    document.getElementById('drawer-title').textContent = `${t.name}`;
```

改為：

```js
    const t = await api(`/api/admin/templates/${templateId}`);
    drawerPricePerSession = Number(t.price_per_session ?? 0);
    document.getElementById('drawer-title').textContent = `${t.name}`;
```

- [ ] **Step 2: 場次列按鈕一律顯示**

原（admin.js 414，注意前導 12 空格）：

```js
            ${(s.status !== 'cancelled' || s.start_at <= localNowStr()) ? `<button type="button" class="badge badge-confirmed session-backfill" data-session-id="${s.id}" title="為客人補此場報名">補報名</button>` : ''}
```

改為：

```js
            <button type="button" class="badge badge-confirmed session-backfill" data-session-id="${s.id}" title="為客人補此場報名">補報名</button>
```

- [ ] **Step 3: 整支重寫 `openBackfillPanel`**

原＝`function openBackfillPanel(sid) {` 起、至 `document.getElementById('close-drawer')` 行**之前**的整支函式（含結尾 `}`；用 Read 取現行全文作為 Edit 的 old_string）。改為（完整新函式，逐字）：

```js
function openBackfillPanel(sid) {
  const inner = document.querySelector(`#drawer-content .session-roster[data-session-id="${sid}"]`);
  if (!inner) return;
  const det = inner.closest('details');
  det.open = true;
  document.querySelectorAll('.backfill-panel').forEach(p => p.remove()); // 同時只開一個
  const meta = drawerSessions.get(sid) || {};
  const isPast = meta.start_at ? meta.start_at <= localNowStr() : false;
  const isFull = meta.occupied >= meta.max;
  const isCancelled = meta.status === 'cancelled';

  const panel = document.createElement('div');
  panel.className = 'backfill-panel';
  panel.dataset.sessionId = sid;
  panel.innerHTML = `
    <div class="font-semibold mb-2">補報名</div>
    <div class="bf-mode-search">
      <input type="search" class="form-input bf-search" placeholder="搜尋既有客人（姓名或電話）…" autocomplete="off">
      <div class="bf-results"></div>
      <button type="button" class="btn btn-ghost btn-sm bf-show-new">＋ 新增客人</button>
    </div>
    <div class="bf-mode-new" style="display:none;">
      <input type="text" class="form-input bf-name" placeholder="姓名（必填）">
      <input type="tel" class="form-input bf-phone" placeholder="電話（選填，之後可於會員管理補）">
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary btn-sm bf-new-confirm">加入</button>
        <button type="button" class="btn btn-ghost btn-sm bf-show-search">← 改搜尋既有客人</button>
      </div>
    </div>
    <div class="bf-price-layer" style="display:none;">
      <div class="bf-price-name font-semibold"></div>
      <label class="subtle text-sm">單價（可改，0＝免費）
        <input type="number" class="form-input bf-price-input" min="0" step="1" inputmode="numeric">
      </label>
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary btn-sm bf-price-ok">確認</button>
        <button type="button" class="btn btn-ghost btn-sm bf-price-cancel">取消</button>
      </div>
    </div>
    <div class="bf-chips"></div>
    <label class="bf-paid-row"><input type="checkbox" class="bf-paid"> 已收款（直接列入已核對匯款，套用整批）</label>
    <div class="bf-hint subtle text-xs"></div>
    <div class="flex gap-2 mt-2">
      <button type="button" class="btn btn-primary btn-sm bf-submit" disabled>送出補報名</button>
      <button type="button" class="btn btn-ghost btn-sm bf-close">關閉</button>
    </div>
    <div class="bf-batch-result text-xs"></div>`;
  inner.parentNode.insertBefore(panel, inner);

  const hint = panel.querySelector('.bf-hint');
  const paidCb = panel.querySelector('.bf-paid');
  const submitBtn = panel.querySelector('.bf-submit');
  if (isCancelled) { hint.textContent = '此場原判未開課：補報名成功後將恢復為「已成班」（計入薪資與上課統計）。'; }
  else if (isFull && isPast) { hint.textContent = '此場已滿且已結束，無法補報名。'; submitBtn.disabled = true; }
  else if (isFull) { hint.textContent = '此場已滿：送出後將列為候補（不收款）。'; paidCb.checked = false; paidCb.disabled = true; }
  else if (isPast) { hint.textContent = '此場已結束：補登歷史報名。'; }

  // 多選狀態：selected = [{ key, userId?, name, phone?, price }]
  const selected = [];
  let pendingCandidate = null; // 單價確認層的當前候選 { userId? , name, phone? }
  const candidateKey = (c) => c.userId != null ? `u${c.userId}` : `n|${c.name}|${c.phone || ''}`;

  const priceLayer = panel.querySelector('.bf-price-layer');
  const priceInput = panel.querySelector('.bf-price-input');
  const chipsEl = panel.querySelector('.bf-chips');
  const resultEl = panel.querySelector('.bf-batch-result');

  function renderChips() {
    chipsEl.innerHTML = selected.map((c, i) =>
      `<span class="bf-chip">${escapeHtml(c.name)} NT$${c.price}<button type="button" data-i="${i}" aria-label="移除">✕</button></span>`
    ).join('');
    chipsEl.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      selected.splice(Number(b.dataset.i), 1);
      renderChips();
    }));
    submitBtn.textContent = selected.length ? `送出補報名（${selected.length} 位）` : '送出補報名';
    if (!(isFull && isPast)) submitBtn.disabled = selected.length === 0;
  }

  function openPriceLayer(candidate) {
    pendingCandidate = candidate;
    panel.querySelector('.bf-price-name').textContent = candidate.name;
    priceInput.value = String(drawerPricePerSession);
    priceLayer.style.display = '';
    priceInput.focus();
    priceInput.select();
  }

  panel.querySelector('.bf-price-ok').addEventListener('click', () => {
    const v = Number(priceInput.value);
    if (!Number.isInteger(v) || v < 0) { toast('單價需為 0 或正整數', 'error'); return; }
    const cand = { ...pendingCandidate, price: v, key: candidateKey(pendingCandidate) };
    if (selected.some(c => c.key === cand.key)) { toast('此客人已在本批名單中', 'error'); priceLayer.style.display = 'none'; return; }
    selected.push(cand);
    pendingCandidate = null;
    priceLayer.style.display = 'none';
    panel.querySelector('.bf-search').value = '';
    panel.querySelector('.bf-name').value = '';
    panel.querySelector('.bf-phone').value = '';
    renderChips();
  });
  panel.querySelector('.bf-price-cancel').addEventListener('click', () => {
    pendingCandidate = null;
    priceLayer.style.display = 'none';
  });

  panel.querySelector('.bf-show-new').addEventListener('click', () => {
    panel.querySelector('.bf-mode-search').style.display = 'none';
    panel.querySelector('.bf-mode-new').style.display = '';
  });
  panel.querySelector('.bf-show-search').addEventListener('click', () => {
    panel.querySelector('.bf-mode-new').style.display = 'none';
    panel.querySelector('.bf-mode-search').style.display = '';
  });
  panel.querySelector('.bf-new-confirm').addEventListener('click', () => {
    const name = panel.querySelector('.bf-name').value.trim();
    const phone = panel.querySelector('.bf-phone').value.trim();
    if (!name) { toast('請填寫姓名', 'error'); return; }
    openPriceLayer({ name, phone: phone || null });
  });
  panel.querySelector('.bf-close').addEventListener('click', () => panel.remove());

  let searchTimer = null;
  const resultsEl = panel.querySelector('.bf-results');
  panel.querySelector('.bf-search').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    const q = ev.target.value.trim();
    if (!q) { resultsEl.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const list = await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`);
        resultsEl.innerHTML = list.length
          ? list.map(u => `<button type="button" class="bf-result" data-user-id="${u.id}" data-name="${escapeHtml(u.name)}">${escapeHtml(u.name)}<span class="subtle text-xs">　${escapeHtml(u.phone || '無電話')}</span></button>`).join('')
          : '<div class="subtle text-xs" style="padding:6px 8px;">查無客人，可點「＋ 新增客人」</div>';
        resultsEl.querySelectorAll('.bf-result').forEach(btn => btn.addEventListener('click', () => {
          resultsEl.innerHTML = '';
          openPriceLayer({ userId: Number(btn.dataset.userId), name: btn.dataset.name });
        }));
      } catch { resultsEl.innerHTML = '<div class="text-red-500 text-xs">搜尋失敗</div>'; }
    }, 250);
  });

  const ERR_MSGS = { already_registered: '已報名過本場次', session_full: '此場已滿（過去場次不可候補）', paid_requires_seat: '已滿場次只能候補，不能標已收款', phone_unavailable: '此電話屬員工帳號', invalid_phone: '電話格式不正確（8–15 碼數字）', missing_name: '缺姓名', user_not_found: '找不到此客人', invalid_price: '單價需為 0 或正整數' };

  submitBtn.addEventListener('click', async () => {
    if (!selected.length) return;
    const paid = paidCb.checked;
    submitBtn.disabled = true;
    const lines = [];
    let okCount = 0;
    const remaining = [];
    for (const c of selected) {
      const body = c.userId != null
        ? { userId: c.userId, paid, price: c.price }
        : { name: c.name, phone: c.phone, paid, price: c.price };
      try {
        const r = await api(`/api/admin/sessions/${sid}/registrations`, { method: 'POST', body });
        okCount += 1;
        const label = r.status === 'waitlisted' ? '已滿→候補' : paid ? '已核對' : '待核對匯款';
        lines.push(`<div class="ok">✓ ${escapeHtml(c.name)}：${label}</div>`);
      } catch (e) {
        remaining.push(c);
        lines.push(`<div class="bad">✕ ${escapeHtml(c.name)}：${ERR_MSGS[e.data?.error] || escapeHtml(e.message)}</div>`);
      }
    }
    resultEl.innerHTML = lines.join('');
    selected.length = 0;
    selected.push(...remaining);
    renderChips();
    submitBtn.disabled = selected.length === 0;
    if (okCount > 0) {
      toast(remaining.length ? `補報名完成 ${okCount} 位、失敗 ${remaining.length} 位（見面板逐人結果）` : `補報名完成（${okCount} 位）`, remaining.length ? 'error' : 'success');
      await reloadRoster(sid);
      refreshSessionSummary(sid);
      if (meta.status === 'cancelled') { // 補報即復活：就地把「未開課」徽章換成「已成班」
        meta.status = 'confirmed';
        const badge = document.querySelector(`#drawer-content .session-backfill[data-session-id="${sid}"]`)?.parentElement?.querySelector('.badge-cancelled');
        if (badge) { badge.classList.replace('badge-cancelled', 'badge-confirmed'); badge.textContent = SESSION_STATUS_LABEL.confirmed; }
      }
      loadPendingOrders(); loadConfirmedPayments();
    } else if (remaining.length) {
      toast('補報名全部失敗，見面板逐人結果', 'error');
    }
  });
}
```

- [ ] **Step 4: admin.html 面板 CSS 追加**

原（admin.html，`.bf-paid-row` 規則行）：

```css
.bf-paid-row { display: flex; align-items: center; gap: 6px; font-size: 14px; margin: 4px 0; }
```

改為（保留原行，其後追加）：

```css
.bf-paid-row { display: flex; align-items: center; gap: 6px; font-size: 14px; margin: 4px 0; }
.bf-price-layer { border: 1px solid #bae6fd; background: #f0f9ff; padding: 10px; margin: 6px 0; }
.bf-price-layer .form-input { margin: 4px 0 8px; }
.bf-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #e2e8f0; background: #fff; padding: 3px 8px; margin: 0 6px 6px 0; font-size: 13px; }
.bf-chip button { border: 0; background: transparent; cursor: pointer; color: #64748b; font-size: 14px; line-height: 1; padding: 0; }
.bf-batch-result { margin-top: 6px; }
.bf-batch-result .ok { color: #15803d; }
.bf-batch-result .bad { color: #dc2626; }
```

- [ ] **Step 5: 驗證**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system && node --check public/admin.js
cd /Users/ryansheu/projects/chinup-fitness-system && grep -c "session-backfill" public/admin.js   # 期望 3（渲染 1＋委派 1＋復活徽章 1）
cd /Users/ryansheu/projects/chinup-fitness-system && grep -c "bf-price-layer\|bf-chip\b" public/admin.html   # 期望 ≥2
```

- [ ] **Step 6: Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system && git add public/admin.js public/admin.html
git commit -m "feat: 補報名面板多選客人＋逐人單價確認層＋整批送出（含未開課場次鈕一律顯示）"
```

---

### Task 3: 收尾 — 全測試、瀏覽器實測、draft PR（controller 執行）

- [ ] Step 1: `cd /Users/ryansheu/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" npm test` 全綠。
- [ ] Step 2: server（mocks）跑著，`node tests/admin-group-reg-api.test.js` 綠。
- [ ] Step 3: 瀏覽器實測（localhost、admin 登入）：未開課場次（含未開始的）補報名鈕出現；多選流（搜尋選人→單價層預帶可改→已選膠囊×移除→＋新增客人入列→整批已收款→一次送出 N 位→逐人結果）；重複選同人擋；price 0；部分失敗（先讓一人已報名）彙整顯示且失敗者留名單；復活徽章就地翻新＋教練通知（通知頁 course_confirmed_coach 列）。
- [ ] Step 4: `npm run seed`（API 測試與實測弄髒 demo DB）。
- [ ] Step 5: push＋draft PR（title「後台補報名：截止後可補＋多選客人與逐人單價」，body 摘要 spec 決策＋測試證據＋smoke 清單），待業主 smoke 後 merge。

**Expected 完成態:** 分支上 spec＋2 個 feature commit；draft PR open；業主 smoke 後 merge 自動部署 prod。
