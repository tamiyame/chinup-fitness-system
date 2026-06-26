# 登錄預約「查無客人 → 新增客人」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教練後台登錄預約彈窗，搜尋客人查無結果時可就地新增客人（姓名+電話），建立後接入既有方案步驟。

**Architecture:** 後端加一支 `POST /api/coach/customers`（requireCoach，重用既有 `findOrCreateUserByPhone`）。前端 `coach.js` 登錄彈窗 `renderRegmBody` 的搜尋「查無客人」分支改成就地「新增客人」表單，建立成功後設 `regmCustomer` 並呼叫既有 `loadRegmPackages()`。

**Tech Stack:** Express + node:sqlite（後端）、Vanilla JS ESM（`public/coach.js`）、node:test（api 測試）。

## Global Constraints

- 新增客人只收 **姓名 + 電話**（不收 email/生日等）。
- 只動**登錄預約**彈窗（`renderRegmBody`）；「編輯預約 → 改客人」(`#bke-search`) 不動。
- 後端**重用 `findOrCreateUserByPhone`**：find-or-create（電話已存在客人→回該客人、封存自動還原、不重複建）；電話屬員工→409 `phone_unavailable`；缺名→400 `missing_name`；壞電話→400 `invalid_phone`。端點只回 `{id,name,phone}`。
- 端點 `requireCoach`（管理者=coach+is_admin 亦可）。
- 前端全欄 `escapeHtml`；文案繁體中文。

---

## 既有程式碼錨點（實作者必讀）

`src/server.js`：
- 第 84 行：`import { isValidPhone } from './services/userService.js';`（**需補 import `findOrCreateUserByPhone`**）。
- 第 875–877 行：`app.get('/api/coach/customers/search', requireCoach, asyncHandler((req, res) => { res.json(svcSearchCustomers(req.query.q)); }));`（**新 route 緊接其後加**）。`asyncHandler` 會把 service 丟的 `ApiError` 轉 HTTP（400/409）。

`src/services/userService.js`：
- `findOrCreateUserByPhone({ phone, name })`（行 22）：驗 `validatePhone`（`/^\d{8,15}$/`，否則 ApiError 400 `invalid_phone`）；name 空→400 `missing_name`；tx find-or-create role='user'；既有電話屬非 user→409 `phone_unavailable`；封存者 `clearArchived` 還原。回完整 user row（含 id/name/phone）。

`public/coach.js`：
- `let regmCustomer = null;`（約行 845）；`PKG_TYPE`、`getDiscountCodes`、`discountOptionsHtml` 既有。
- `renderRegmBody()`（約 862–891）：搜尋 setTimeout 內—
  ```js
  const list = await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`);
  $('regm-results').innerHTML = list.length
    ? list.map(u => `<div class="regm-result" data-id="${u.id}" data-name="${escapeHtml(u.name)}" data-phone="${escapeHtml(u.phone || '')}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('')
    : '<div class="regm-sub" style="padding:6px;">查無客人</div>';
  $('regm-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', () => {
    regmCustomer = list.find(u => u.id === Number(r.dataset.id));
    $('regm-results').innerHTML = ''; search.value = regmCustomer.name;
    loadRegmPackages();
  }));
  ```
- `loadRegmPackages()`（約 893）：用 `regmCustomer.id` 抓方案 → `renderRegmPicked()`。`api`/`toast`/`escapeHtml`/`$` 可用；`api` throw 時 `e.data.error`/`e.message`。

`tests/`：api 測試模式（`tests/coach-register-api.test.js`）：`BASE` + `req(method,path,{body,token})` helper + admin 登入 `admin@chinup.local/admin1234` 取 token + `db.prepare` 直插/清理。**注意：新增客人 email=NULL，清理要用 phone（非 email）。** `package.json` `test:api` 結尾為 `... && node tests/admin-user-line-unbind-api.test.js`。

---

## File Structure
- **Modify `src/server.js`**（Task 1）：補 import + 新 route。
- **Create `tests/coach-add-customer-api.test.js`**（Task 1）+ **Modify `package.json`**（test:api 串接）。
- **Modify `public/coach.js`**（Task 2）：`renderRegmBody` 查無分支 + 新函式 `renderRegmNewCustomer`。

---

### Task 1: 後端 新增客人端點 + api 測試

**Files:**
- Modify: `src/server.js`（第 84 行 import；第 877 行後加 route）
- Create: `tests/coach-add-customer-api.test.js`
- Modify: `package.json`（test:api 串接）

**Interfaces:**
- Consumes（既有）：`findOrCreateUserByPhone({phone,name})`、`requireCoach`、`asyncHandler`、`db`。
- Produces：`POST /api/coach/customers` → 200 `{ id, name, phone }`；400 `missing_name`/`invalid_phone`；409 `phone_unavailable`。

- [ ] **Step 1：寫 api 測試（先失敗）**

建立 `tests/coach-add-customer-api.test.js`：

```js
// API test: 登錄預約 新增客人（POST /api/coach/customers）。需 running server + seed admin。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[coach-add-customer-api] start');
const PHONES = ['0973099001','0973099002','0973099003'];
const clean = () => db.exec(`DELETE FROM users WHERE phone IN ('${PHONES.join("','")}') OR email LIKE 'cac-%'`);
clean();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入', () => assert.ok(token));

// 1) 建立成功 → 200 {id,name,phone}，DB role=user
const r1 = await req('POST', '/api/coach/customers', { token, body: { name: '新客一', phone: '0973099001' } });
expect('建立成功 200 + {id,name,phone}', () => {
  assert.equal(r1.status, 200);
  assert.ok(Number.isInteger(r1.data.id));
  assert.equal(r1.data.name, '新客一');
  assert.equal(r1.data.phone, '0973099001');
});
expect('DB 為 role=user', () => {
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(r1.data.id);
  assert.equal(u.role, 'user');
});

// 2) 缺名 → 400 missing_name
const r2 = await req('POST', '/api/coach/customers', { token, body: { name: '  ', phone: '0973099009' } });
expect('缺名 → 400 missing_name', () => { assert.equal(r2.status, 400); assert.equal(r2.data.error, 'missing_name'); });

// 3) 壞電話 → 400 invalid_phone
const r3 = await req('POST', '/api/coach/customers', { token, body: { name: '阿明', phone: 'abc' } });
expect('壞電話 → 400 invalid_phone', () => { assert.equal(r3.status, 400); assert.equal(r3.data.error, 'invalid_phone'); });

// 4) 員工電話 → 409 phone_unavailable
db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('CAC教練','cac-coach@x.com','0973099003','coach')").run();
const r4 = await req('POST', '/api/coach/customers', { token, body: { name: '想冒用', phone: '0973099003' } });
expect('員工電話 → 409 phone_unavailable', () => { assert.equal(r4.status, 409); assert.equal(r4.data.error, 'phone_unavailable'); });

// 5) 既有客人電話 → find 不重複建（回同一 id、名不覆蓋）
const existId = Number(db.prepare("INSERT INTO users (name,phone,role) VALUES ('原客','0973099002','user')").run().lastInsertRowid);
const r5 = await req('POST', '/api/coach/customers', { token, body: { name: '不同名', phone: '0973099002' } });
expect('既有電話 → 回同一 id、不重複建', () => {
  assert.equal(r5.status, 200);
  assert.equal(r5.data.id, existId);
  const cnt = db.prepare("SELECT COUNT(*) c FROM users WHERE phone='0973099002'").get().c;
  assert.equal(cnt, 1);
});

clean();
console.log('[coach-add-customer-api] done');
```

- [ ] **Step 2：跑測試確認失敗**

需 running server（測試用 seed admin）。若未跑：`PORT=3000 node src/server.js & sleep 2`（先 `node src/db/seed-demo.js` 確保有 admin）。
Run: `node tests/coach-add-customer-api.test.js`
Expected: FAIL — 端點不存在，`POST /api/coach/customers` 落 404 fallback，r1.status 非 200（✗）。

- [ ] **Step 3：實作端點**

在 `src/server.js` 第 84 行 import 改為：
```js
import { isValidPhone, findOrCreateUserByPhone } from './services/userService.js';
```
在 `app.get('/api/coach/customers/search', ...)` route（約第 875–877 行）**之後**加：
```js
app.post('/api/coach/customers', requireCoach, asyncHandler((req, res) => {
  const { name, phone } = req.body || {};
  const u = findOrCreateUserByPhone({ name, phone });
  res.json({ id: u.id, name: u.name, phone: u.phone });
}));
```

- [ ] **Step 4：重啟 server 後跑測試**

Node 無熱重載，先重啟：`pkill -f 'node src/server.js'; sleep 1; PORT=3000 node src/server.js & sleep 2`
再 Run: `node tests/coach-add-customer-api.test.js`
Expected: PASS（全 ✓）。

> 注意：跑測試/重啟會動到本機 `data/app.db`；smoke 前需 `node src/db/seed-demo.js` 重新 seed。

- [ ] **Step 5：把新測試串進 `package.json` 的 `test:api`**

把 `test:api` 結尾的 `&& node tests/admin-user-line-unbind-api.test.js` 之後接上 ` && node tests/coach-add-customer-api.test.js`。

- [ ] **Step 6：Commit**

```bash
git add src/server.js tests/coach-add-customer-api.test.js package.json
git commit -m "feat: 登錄預約新增客人端點 POST /api/coach/customers（重用 findOrCreateUserByPhone）"
```

---

### Task 2: 前端 登錄彈窗「查無客人 → 新增客人」

**Files:**
- Modify: `public/coach.js`（`renderRegmBody` 查無分支 + 新函式 `renderRegmNewCustomer`）

**Interfaces:**
- Consumes：`POST /api/coach/customers`（Task 1）、`regmCustomer`、`loadRegmPackages()`、`api`/`toast`/`escapeHtml`/`$`。
- Produces：`renderRegmNewCustomer(query)`（在 `#regm-results` 畫新增客人表單並處理建立）。

- [ ] **Step 1：renderRegmBody — 查無客人改成呼叫新增表單**

在 `public/coach.js` `renderRegmBody` 的搜尋 setTimeout 內，把：
```js
        $('regm-results').innerHTML = list.length
          ? list.map(u => `<div class="regm-result" data-id="${u.id}" data-name="${escapeHtml(u.name)}" data-phone="${escapeHtml(u.phone || '')}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('')
          : '<div class="regm-sub" style="padding:6px;">查無客人</div>';
        $('regm-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', () => {
          regmCustomer = list.find(u => u.id === Number(r.dataset.id));
          $('regm-results').innerHTML = ''; search.value = regmCustomer.name;
          loadRegmPackages();
        }));
```
替換為：
```js
        if (!list.length) { renderRegmNewCustomer(q); return; }
        $('regm-results').innerHTML = list.map(u => `<div class="regm-result" data-id="${u.id}" data-name="${escapeHtml(u.name)}" data-phone="${escapeHtml(u.phone || '')}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('');
        $('regm-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', () => {
          regmCustomer = list.find(u => u.id === Number(r.dataset.id));
          $('regm-results').innerHTML = ''; search.value = regmCustomer.name;
          loadRegmPackages();
        }));
```

- [ ] **Step 2：新增 `renderRegmNewCustomer` 函式**

在 `public/coach.js` `renderRegmBody` 函式的**右大括號之後**（與 `loadRegmPackages` 同層的模組函式），新增：
```js
function renderRegmNewCustomer(query) {
  const isDigits = /^\d+$/.test(query);
  const nameVal = isDigits ? '' : query;
  const phoneVal = isDigits ? query : '';
  $('regm-results').innerHTML = `
    <div style="display:grid;gap:6px;padding:6px 0;">
      <div class="regm-sub">查無此客人，可直接新增：</div>
      <input id="regm-newc-name" class="form-input" placeholder="姓名" value="${escapeHtml(nameVal)}" autocomplete="off" />
      <input id="regm-newc-phone" class="form-input" placeholder="電話" value="${escapeHtml(phoneVal)}" inputmode="numeric" autocomplete="off" />
      <button id="regm-newc-create" class="btn-primary">新增客人</button>
    </div>`;
  $('regm-newc-create').onclick = async () => {
    const name = $('regm-newc-name').value.trim();
    const phone = $('regm-newc-phone').value.trim();
    if (!name) { toast('請填姓名', 'error'); return; }
    if (!phone) { toast('請填電話', 'error'); return; }
    try {
      const u = await api('/api/coach/customers', { method: 'POST', body: { name, phone } });
      regmCustomer = u;
      $('regm-results').innerHTML = '';
      $('regm-search').value = u.name;
      loadRegmPackages();
    } catch (e) {
      const m = { missing_name: '請填姓名', invalid_phone: '電話格式須 8–15 碼數字', phone_unavailable: '此電話為員工帳號，不可用於客人' };
      toast(m[e.data?.error] || `新增失敗：${e.message}`, 'error');
    }
  };
}
```

- [ ] **Step 3：語法檢查**

Run: `node --check public/coach.js`
Expected: 無輸出、exit 0。

- [ ] **Step 4：Commit**

```bash
git add public/coach.js
git commit -m "feat: 登錄彈窗查無客人時就地新增客人（姓名+電話）接入方案步驟"
```

---

## 驗證（控制者親跑，非 subagent 任務）
1. 後端：`node src/db/seed-demo.js` →（重啟 server）→ `node tests/coach-add-customer-api.test.js`（全 ✓）；`npm test` 綠燈（純加法）。再 `node src/db/seed-demo.js` 還原。
2. 瀏覽器 smoke（管理者/教練登入 → 登錄預約 → 點空格開彈窗）：
   - 搜尋一個不存在的姓名 → 出現「新增客人」表單（姓名預填該字）→ 填電話 → 新增 → 自動帶入該客人並顯示方案步驟（無方案→可建方案）→ 完成登錄。
   - 搜尋純數字（電話）查無 → 表單電話預填、姓名空。
   - 填到員工電話 → toast「此電話為員工帳號，不可用於客人」。
   - 既有客人但用搜不到的字（例如只打名一半但拼錯）後改新增、輸入既有電話 → 回該既有客人（不重複建）。
   - 控制台無錯誤。
> 無前端測試框架（無 jsdom）→ 前端不新增單元測試；後端端點以上述 api 測試覆蓋。

## 不做（YAGNI）
- 不收 email/生日/地址；不改編輯預約改客人；不改方案/登錄後續；不引入套件。
