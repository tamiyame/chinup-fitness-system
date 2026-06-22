# 我的課表客戶自助綁定 LINE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓客戶在「我的課表」查詢後，從 navbar 自助產生 LINE 綁定碼並依手機號碼綁定。

**Architecture:** 後端新增公開端點 `POST /api/public/line/bind-code`（驗名＋role 守門＋已綁定 409＋限流，重用既有 `generateBindCode`），並讓 `getPublicSchedule` 多回三態 `line_bound`。前端在 my-schedule 的 navbar `#auth-bar` 依 `line_bound` 注入「綁定 LINE」按鈕／「✓ 已綁定 LINE」標記，點按鈕開彈窗顯示 6 碼＋官方 LINE 連結＋說明。

**Tech Stack:** Node.js ESM、node:sqlite；前端原生 ES module（my-schedule.js import 自 app.js）。API 測試為純 node script（需啟動帶 mock 的 server）。

**Spec:** `docs/superpowers/specs/2026-06-19-customer-line-bind-design.md`

---

## File Structure
- **Modify** `src/services/lineBindingService.js` — 新增 `requestPublicBindCode({phone,name})`＋3 個 import。
- **Modify** `src/services/groupOrderService.js` — `getPublicSchedule` 回傳加 `line_bound`。
- **Modify** `src/server.js` — `lineBindLimiter`＋公開路由＋擴充 lineBindingService import。
- **Modify** `public/my-schedule.html` — `<style>` 加 `.ms-line-*`/`.lb-*` 樣式；`</body>` 前加綁定彈窗骨架。
- **Modify** `public/my-schedule.js` — import `getToken`；`state.lineBound`；`renderLineNav`/`openLineBindModal`/`closeLineBindModal`；接進 `doLookup`/`showForm`/init。
- **Create** `tests/public-line-bind-api.test.js`；**Modify** `package.json`（test:api）。
- **Delete**（收尾）`public/_mock_my_schedule_line.html`。

---

## Task 1: 後端 — 公開產碼端點 + line_bound + API 測試

**Files:**
- Modify: `src/services/lineBindingService.js`
- Modify: `src/services/groupOrderService.js` (`getPublicSchedule`, ~516-519)
- Modify: `src/server.js` (import ~71-76、limiter ~99、route after `/api/public/my` ~883)
- Create: `tests/public-line-bind-api.test.js`
- Modify: `package.json` (`test:api`)

- [ ] **Step 1: 建立失敗測試 `tests/public-line-bind-api.test.js`**

```js
// 我的課表客戶自助綁定 LINE：公開端點 + getPublicSchedule line_bound。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[public-line-bind-api test] start');
db.exec("DELETE FROM users WHERE phone LIKE '0961%'");
const cUid = Number(db.prepare("INSERT INTO users (name,phone,role) VALUES ('PLB 客','0961000001','user')").run().lastInsertRowid);
db.prepare("INSERT INTO users (name,phone,role,line_user_id) VALUES ('PLB 已綁','0961000002','user','Ualreadybound_plb')").run();
db.prepare("INSERT INTO users (name,phone,role) VALUES ('PLB 教練','0961000003','coach')").run();

// 1) 客戶 phone+name → 200 + 6 碼 + expires_at + line_official_url；DB 寫入 line_bind_code
const ok = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000001', name: 'PLB 客' } });
expect('客戶產碼 → 200', () => assert.equal(ok.status, 200));
expect('回 6 位數 code', () => assert.match(String(ok.data.code), /^\d{6}$/));
expect('回 expires_at', () => assert.ok(ok.data.expires_at));
expect('回 line_official_url 欄位', () => assert.ok('line_official_url' in ok.data));
expect('DB 寫入 line_bind_code', () => { const r = db.prepare('SELECT line_bind_code FROM users WHERE id=?').get(cUid); assert.equal(r.line_bind_code, String(ok.data.code)); });

// 2) 錯名 → 403 not_found_or_mismatch
const wrong = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000001', name: '錯名' } });
expect('錯名 → 403 not_found_or_mismatch', () => { assert.equal(wrong.status, 403); assert.equal(wrong.data.error, 'not_found_or_mismatch'); });

// 3) 員工 phone+name → 403 not_found_or_mismatch（role 守門、中性）
const staff = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000003', name: 'PLB 教練' } });
expect('員工 → 403 not_found_or_mismatch', () => { assert.equal(staff.status, 403); assert.equal(staff.data.error, 'not_found_or_mismatch'); });

// 4) 已綁定客戶 → 409 already_bound
const bound = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000002', name: 'PLB 已綁' } });
expect('已綁定 → 409 already_bound', () => { assert.equal(bound.status, 409); assert.equal(bound.data.error, 'already_bound'); });

// 5) /api/public/my 回 line_bound（未綁定 false、已綁定 true）
const myUnbound = await req('POST', '/api/public/my', { body: { phone: '0961000001', name: 'PLB 客' } });
expect('未綁定客戶查課表 → line_bound:false', () => { assert.equal(myUnbound.status, 200); assert.equal(myUnbound.data.line_bound, false); });
const myBound = await req('POST', '/api/public/my', { body: { phone: '0961000002', name: 'PLB 已綁' } });
expect('已綁定客戶查課表 → line_bound:true', () => assert.equal(myBound.data.line_bound, true));

db.exec("DELETE FROM users WHERE phone LIKE '0961%'");
console.log('[public-line-bind-api test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js > /tmp/srv-t1.log 2>&1 &
SRV=$!; sleep 2
node tests/public-line-bind-api.test.js
kill $SRV 2>/dev/null
```
Expected: FAIL — 產碼端點不存在（404，非 200/`not_found_or_mismatch`/`already_bound`），且 `line_bound` 為 undefined（≠false/true）。掃 `✗`（harness 不丟例外）。

- [ ] **Step 3: 在 `src/services/lineBindingService.js` 新增 import 與 `requestPublicBindCode`**

在檔案頂部 import 區（`import { db, tx, nowLocal, offsetLocal } from '../db/connection.js';` 之後）加：
```js
import { getUserByPhoneAndName } from './userService.js';
import { getLineOfficialUrl } from './discountService.js';
import { ApiError } from './registration.js';
```
在檔案結尾（最後一個 export 之後）加：
```js
/**
 * 公開：客戶以 phone+name 自助產生綁定碼（我的課表頁用）。
 * 驗名 reader + role 守門（非 user 一律當查無，中性不洩員工）+ 已綁定 409。
 * 只回 { code, expires_at, line_official_url }，不回 user 列。
 */
export function requestPublicBindCode({ phone, name }) {
  const user = getUserByPhoneAndName({ phone, name });
  if (!user || user.role !== 'user') throw new ApiError(403, 'not_found_or_mismatch');
  if (user.line_user_id) throw new ApiError(409, 'already_bound');
  const { code, expires_at } = generateBindCode(user.id);
  return { code, expires_at, line_official_url: getLineOfficialUrl() };
}
```
> `ApiError` 僅在函式內 runtime 使用，與 `userService.js` 引用 `ApiError` 同模式，無 import-time cycle 風險。`generateBindCode` 為同檔既有 export，直接呼叫。

- [ ] **Step 4: 在 `src/server.js` 擴充 import + 加 limiter + 加路由**

(a) 把 lineBindingService 的 import（~71-76）的 `unbindByUserId,` 之後加一行 `requestPublicBindCode,`，使其成為：
```js
  consumeCode,
  unbindByLineUserId,
  resetAllLineBindings,
  generateBindCode,
  unbindByUserId,
  requestPublicBindCode,
} from './services/lineBindingService.js';
```
(b) 在限流器宣告區（`const bookingLimiter = ...` 那行，~99）之後加：
```js
const lineBindLimiter = createRateLimiter({ name: 'public-line-bind', windowMs: 60_000, max: 10 });
```
(c) 在 `app.post('/api/public/my', ...)`（~880-883）整段路由**之後**加：
```js
app.post('/api/public/line/bind-code', lineBindLimiter, asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(requestPublicBindCode({ phone, name }));
}));
```

- [ ] **Step 5: 在 `getPublicSchedule` 回傳加 `line_bound`（src/services/groupOrderService.js）**

把結尾的 return（~516-519）：
```js
  return {
    user: { name: user.name, phone: user.phone },
    items, one_on_one_remaining, group_remaining,
  };
```
改為：
```js
  return {
    user: { name: user.name, phone: user.phone },
    items, one_on_one_remaining, group_remaining,
    line_bound: user.role === 'user' ? !!user.line_user_id : null,
  };
```
> `user` 來自 `getUserByPhoneAndName`（SELECT *），含 `role` 與 `line_user_id`；此處只輸出布林/null，不洩原值或角色。

- [ ] **Step 6: 跑測試確認通過**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js > /tmp/srv-t1.log 2>&1 &
SRV=$!; sleep 2
node tests/public-line-bind-api.test.js
kill $SRV 2>/dev/null
```
Expected: 全部 ✓，結尾 `[public-line-bind-api test] done`，無 `✗`。

- [ ] **Step 7: 登錄進 `package.json` 的 `test:api`**

在 `test:api` 字串尾端（`admin-coach-cancel-api.test.js` 之後）加 ` && node tests/public-line-bind-api.test.js`。

- [ ] **Step 8: Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add src/services/lineBindingService.js src/services/groupOrderService.js src/server.js tests/public-line-bind-api.test.js package.json
git commit -m "feat(line): 我的課表客戶自助綁定公開端點 + getPublicSchedule line_bound"
```

---

## Task 2: 前端 — navbar 按鈕 + 綁定彈窗

**Files:**
- Modify: `public/my-schedule.html`
- Modify: `public/my-schedule.js`

- [ ] **Step 1: my-schedule.html — `<style>` 內（`</style>` 之前）加樣式**

```css
  /* ── LINE 綁定（navbar 按鈕 + 彈窗）── */
  .ms-line-btn{ display:inline-flex; align-items:center; gap:6px; background:#06c755; color:#fff; border:0; border-radius:8px; font-family:"Noto Sans TC",sans-serif; font-weight:700; font-size:13px; padding:7px 12px; cursor:pointer; min-height:36px; white-space:nowrap; }
  .ms-line-btn:hover{ filter:brightness(.95); }
  .ms-line-btn .ico{ width:16px; height:16px; }
  .ms-line-bound{ display:inline-flex; align-items:center; gap:6px; font-family:"Noto Sans TC",sans-serif; font-weight:700; font-size:12.5px; color:var(--ok-fg); white-space:nowrap; }
  .lb-overlay{ position:fixed; inset:0; background:rgba(15,23,42,.5); display:none; align-items:center; justify-content:center; z-index:50; padding:20px; }
  .lb-modal{ background:#fff; border-radius:16px; max-width:380px; width:100%; padding:24px; box-shadow:0 20px 50px rgba(0,0,0,.25); }
  .lb-modal h3{ font-family:"Noto Sans TC",sans-serif; font-weight:900; font-size:19px; letter-spacing:-.01em; margin-bottom:4px; }
  .lb-sub{ font-size:13px; color:var(--ink-mute); margin-bottom:18px; }
  .lb-loading{ text-align:center; color:var(--ink-mute); padding:24px 0; }
  .lb-note{ text-align:center; color:var(--ink-soft); padding:12px 0 18px; }
  .lb-code{ font-family:"Archivo",sans-serif; font-weight:900; font-size:40px; letter-spacing:.18em; text-align:center; color:var(--brand-700); background:var(--brand-50); border:1px dashed var(--brand-200,#bae6fd); border-radius:12px; padding:16px 0; font-variant-numeric:tabular-nums; }
  .lb-code-note{ text-align:center; font-size:12px; color:var(--ink-mute); margin:8px 0 18px; }
  .lb-steps{ list-style:none; padding:0; margin:0 0 18px; counter-reset:s; }
  .lb-steps li{ counter-increment:s; position:relative; padding:0 0 11px 30px; font-size:13.5px; color:var(--ink-soft); line-height:1.5; }
  .lb-steps li::before{ content:counter(s); position:absolute; left:0; top:0; width:21px; height:21px; border-radius:999px; background:var(--brand-600); color:#fff; font-family:"Archivo",sans-serif; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; }
  .lb-join{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; background:#06c755; color:#fff; border-radius:10px; font-weight:700; font-size:15px; padding:12px; text-decoration:none; margin-bottom:10px; }
  .lb-done{ display:block; width:100%; text-align:center; background:transparent; border:0; color:var(--brand-700); font-weight:700; font-size:14px; padding:8px; cursor:pointer; }
```

- [ ] **Step 2: my-schedule.html — `</body>` 之前（`<div id="toast" ...>` 之後、`<script ...>` 之前）加彈窗骨架**

```html
<div id="line-bind-overlay" class="lb-overlay">
  <div class="lb-modal">
    <h3>綁定 LINE 接收課程通知</h3>
    <p class="lb-sub">綁定後，預約／取消／成班等通知會直接傳到你的 LINE。</p>
    <div id="line-bind-body"></div>
  </div>
</div>
```

- [ ] **Step 3: my-schedule.js — import 補 `getToken`**

把第 1 行：
```js
import { api, fmtDate, toast, bootPublic, escapeHtml } from './app.js';
```
改為：
```js
import { api, fmtDate, toast, bootPublic, escapeHtml, getToken } from './app.js';
```

- [ ] **Step 4: my-schedule.js — `state` 加 `lineBound`**

把 `state` 物件（~9-16）的 `creds: null,` 之後加一行 `lineBound: null,`（三態：true/false/null）。

- [ ] **Step 5: my-schedule.js — `doLookup` 成功時存 lineBound + 渲染 navbar**

在 `doLookup` 成功區塊，把：
```js
    state.group_remaining = data.group_remaining ?? 0;
    showResults();
    render();
```
改為：
```js
    state.group_remaining = data.group_remaining ?? 0;
    state.lineBound = (data.line_bound ?? null);
    showResults();
    render();
    renderLineNav();
```

- [ ] **Step 6: my-schedule.js — `showForm` 清掉 navbar 與 lineBound**

把 `showForm` 結尾：
```js
  state.creds = null;
  state.items = [];
}
```
改為：
```js
  state.creds = null;
  state.items = [];
  state.lineBound = null;
  const bar = document.getElementById('auth-bar');
  if (bar) bar.innerHTML = '';
}
```

- [ ] **Step 7: my-schedule.js — 新增 navbar 渲染 + 彈窗函式**

在 `showForm()` 函式（~105-114）之後插入：
```js
// ── LINE 綁定（navbar 按鈕 + 彈窗）──────────────────────────────────────────────
const LINE_SVG = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 5.64 2 10.1c0 4 3.58 7.34 8.4 7.98.33.07.78.22.89.5.1.26.06.66.03.92l-.14.86c-.04.26-.2 1.02.9.56 1.1-.46 5.9-3.48 8.06-5.95C21.4 13.3 22 11.77 22 10.1 22 5.64 17.52 2 12 2z"/></svg>';

function renderLineNav() {
  const bar = document.getElementById('auth-bar');
  if (!bar) return;
  if (getToken()) return; // 員工登入時 auth-bar 由 app.js 擁有，不覆蓋
  if (state.lineBound === false) {
    bar.innerHTML = `<button id="ms-bind-btn" class="ms-line-btn" type="button">${LINE_SVG}綁定 LINE</button>`;
    document.getElementById('ms-bind-btn').addEventListener('click', openLineBindModal);
  } else if (state.lineBound === true) {
    bar.innerHTML = '<span class="ms-line-bound">✓ 已綁定 LINE</span>';
  } else {
    bar.innerHTML = '';
  }
}

function closeLineBindModal() {
  document.getElementById('line-bind-overlay').style.display = 'none';
}

function bindDoneBtn() {
  const btn = document.getElementById('lb-done-btn');
  if (btn) btn.addEventListener('click', () => {
    closeLineBindModal();
    if (state.creds) doLookup(state.creds.phone, state.creds.name).catch(() => {});
  });
}

async function openLineBindModal() {
  const overlay = document.getElementById('line-bind-overlay');
  const body = document.getElementById('line-bind-body');
  overlay.style.display = 'flex';
  body.innerHTML = '<p class="lb-loading">產生綁定碼中…</p>';
  try {
    const data = await api('/api/public/line/bind-code', { method: 'POST', body: state.creds });
    const join = data.line_official_url
      ? `<a class="lb-join" href="${escapeHtml(data.line_official_url)}" target="_blank" rel="noopener">${LINE_SVG}點我加入官方 LINE</a>`
      : '<p class="lb-note">尚未設定官方 LINE 連結，請洽櫃台。</p>';
    body.innerHTML = `
      <div class="lb-code">${escapeHtml(String(data.code))}</div>
      <div class="lb-code-note">綁定碼 15 分鐘內有效</div>
      <ol class="lb-steps">
        <li>加入 CHINUP 官方 LINE 帳號為好友</li>
        <li>把上面的 6 位數綁定碼傳給官方帳號</li>
        <li>完成後回此處按「我綁好了」</li>
      </ol>
      ${join}
      <button class="lb-done" type="button" id="lb-done-btn">我綁好了，重新整理</button>`;
    bindDoneBtn();
  } catch (e) {
    if (e.status === 409) {
      body.innerHTML = '<p class="lb-note">此帳號已綁定 LINE。</p><button class="lb-done" type="button" id="lb-done-btn">關閉並重新整理</button>';
      bindDoneBtn();
    } else {
      closeLineBindModal();
      toast(`產生綁定碼失敗：${e.message}`, 'error');
    }
  }
}
```

- [ ] **Step 8: my-schedule.js — init 區綁定彈窗背景關閉**

在 init 區（`document.getElementById('change-lookup-btn')...` 那段，~429-431）之後加：
```js
// 綁定彈窗：點背景關閉
const lbOverlay = document.getElementById('line-bind-overlay');
if (lbOverlay) lbOverlay.addEventListener('click', (e) => { if (e.target === lbOverlay) closeLineBindModal(); });
```

- [ ] **Step 9: 語法 + 服務驗證**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
node --check public/my-schedule.js && echo "my-schedule.js syntax OK"
grep -c "renderLineNav\|openLineBindModal\|line-bind-overlay\|lineBound" public/my-schedule.js
lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js > /tmp/srv-t2.log 2>&1 &
SRV=$!; sleep 2
curl -s http://localhost:3000/my-schedule | grep -c 'id="line-bind-overlay"' && echo "overlay served"
curl -s http://localhost:3000/my-schedule.js | grep -c "renderLineNav" && echo "js served"
kill $SRV 2>/dev/null
```
Expected: `my-schedule.js syntax OK`；grep ≥4；overlay served ≥1；js served ≥1。

- [ ] **Step 10: Commit**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
git add public/my-schedule.html public/my-schedule.js
git commit -m "feat(line): 我的課表 navbar 客戶綁定 LINE 按鈕 + 彈窗"
```

---

## Task 3: 瀏覽器煙霧測試 + 清理 + 回歸 + 收尾

**Files:** Delete `public/_mock_my_schedule_line.html`

- [ ] **Step 1: 移除暫存 mock**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
rm -f public/_mock_my_schedule_line.html
```

- [ ] **Step 2: 人工瀏覽器煙霧測試（由控制端執行）**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
npm run seed >/tmp/s.log 2>&1 && node src/db/seed-demo.js >>/tmp/s.log 2>&1
# 建一個已知 phone+name 的測試客戶（若 seed 無）：
node --input-type=module -e "import {db} from './src/db/connection.js'; db.exec(\"DELETE FROM users WHERE phone='0962000001'\"); db.prepare(\"INSERT INTO users (name,phone,role) VALUES ('煙霧客','0962000001','user')\").run(); console.log('seeded smoke customer');"
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js >/tmp/srv-smoke.log 2>&1 &
# 開 /my-schedule，輸入 0962000001 / 煙霧客 查詢
```
驗收（人工，瀏覽器）：
1. 查詢後 navbar 右側出現綠色「綁定 LINE」按鈕。
2. 點按鈕 → 彈窗顯示 6 碼＋「15 分鐘內有效」＋（有設定時）「點我加入官方 LINE」＋3 步驟；點背景關閉。
3. 模擬已綁定（DB 設該 user `line_user_id`）後重查 → navbar 變「✓ 已綁定 LINE」；按鈕不再出現。
4. 無 console error。

- [ ] **Step 3: 全套回歸**

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
npm test 2>&1 | grep -E "✗" || echo "unit suite: no ✗"
lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node src/server.js >/tmp/srv-reg.log 2>&1 &
SRV=$!; sleep 2
node tests/public-api.test.js 2>&1 | grep -E "✗|done"
node tests/my-schedule-routing.test.js 2>&1 | grep -E "✗|done"
node tests/public-line-bind-api.test.js 2>&1 | grep -E "✗|done"
kill $SRV 2>/dev/null
npm run seed && node src/db/seed-demo.js   # npm test 清過 demo，重 seed
```
Expected: 無 `✗`；三個 api 測試皆 `done`。（`gmail-auth-api` 在無 Google 憑證的本機為既有環境性失敗，與本次無關，不在上列。）

- [ ] **Step 4: 收尾**

以 `superpowers:finishing-a-development-branch` 收尾：push + squash merge 至 main（自動部署 prod）→ 同步 main、刪分支、重新 seed。

---

## Self-Review

**1. Spec coverage**
- 新公開端點（驗名＋role 守門＋已綁定 409＋限流＋只回三欄）：Task 1 Step 3-4 ✓
- `getPublicSchedule` 三態 `line_bound`：Task 1 Step 5 ✓
- navbar 注入按鈕/標記（`getToken` 守門、三態）：Task 2 Step 7（renderLineNav）✓
- 彈窗（6 碼＋15 分＋官方連結／未設定提示＋3 步驟＋我綁好了重查）：Task 2 Step 7（openLineBindModal）✓
- 重新查詢清空 navbar：Task 2 Step 6 ✓
- 不動共用 resolver / 員工流程 / 預約成功頁 / webhook：本計畫未觸及 ✓
- 測試（5 案例）＋登錄 test:api：Task 1 Step 1,7 ✓
- 移除暫存 mock：Task 3 Step 1 ✓

**2. Placeholder scan**：無 TBD/TODO；每步含完整 JS/CSS/HTML 與實際指令、斷言。✓

**3. Type/identifier consistency**
- `requestPublicBindCode` 定義（lineBindingService）↔ import（server.js）↔ 路由呼叫一致。✓
- 回傳鍵 `code`/`expires_at`/`line_official_url` 在端點、測試、前端 `openLineBindModal` 一致。✓
- `line_bound`（三態）在 getPublicSchedule、測試、`state.lineBound`、`renderLineNav` 一致。✓
- DOM id `auth-bar`（既有）/`line-bind-overlay`/`line-bind-body`/`ms-bind-btn`/`lb-done-btn` 與 CSS 類別 `ms-line-btn`/`ms-line-bound`/`lb-overlay`/`lb-modal`/`lb-code`/`lb-steps`/`lb-join`/`lb-done` 在 html 與 js 一致。✓
- 沿用既有 `api`/`toast`/`escapeHtml`/`getToken`/`doLookup`/`state.creds`。✓
