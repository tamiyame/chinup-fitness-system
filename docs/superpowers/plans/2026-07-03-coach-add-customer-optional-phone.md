# 登錄預約新增客人「電話改選填」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教練後台登錄預約「就地新增客人」電話改選填：留空可建無電話客人，之後由後台會員管理補電話。

**Architecture:** 後端在 `userService` 加 `createCustomerNoPhone`，`POST /api/coach/customers` 依「是否帶電話」分流（有→原 findOrCreateUserByPhone 不變；無→直接建 phone NULL）；前端只改登錄彈窗表單的必填擋與 placeholder。DB 不動（phone 可 NULL、唯一索引 partial）。

**Tech Stack:** Node.js ESM + Express + node:sqlite；vanilla JS 前端；repo 慣例 script 式測試。

**Spec:** `docs/superpowers/specs/2026-07-03-coach-add-customer-optional-phone-design.md`

## Global Constraints

- 有帶電話的行為**一個位元都不能變**（格式驗證／員工守門 409／封存還原／find 既有帳號）。
- 有帶電話判斷式：`phone != null && String(phone).trim() !== ''`。
- UI 文案繁體中文；電話欄 placeholder =「電話（選填，可之後再補）」。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- API 測試需 server（`LINE_MOCK=1 GOOGLE_CLIENT_ID=test-client-id npm start` 背景；admin `admin@chinup.local`/`admin1234`；DB 空先 `node src/db/seed.js`）。
- 只跑本任務測試檔；完整套件留給 controller 收尾。

---

### Task 1: 後端分流 + 前端表單 + API 測試（單一交付物）

**Files:**
- Modify: `src/services/userService.js`（`findOrCreateUserByPhone` 之後加新函式）
- Modify: `src/server.js`（`POST /api/coach/customers`，約 885–889 行）
- Modify: `public/coach.js`（`renderRegmNewCustomer`，約 926–954 行）
- Test: `tests/coach-add-customer-api.test.js`（擴充既有檔）

**Interfaces:**
- Produces: `POST /api/coach/customers` body `{name}`（無 phone）→ 200 `{id,name,phone:null}`；`{name,phone}` → 原行為。

- [ ] **Step 1: userService.js 加 `createCustomerNoPhone`（放在 `findOrCreateUserByPhone` 函式之後）**

```js
/** 無電話客人：直接新增（無電話可比對故不 find；登錄彈窗搜尋已先列同名既有客人）。之後可於後台會員管理補電話。 */
export function createCustomerNoPhone({ name }) {
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  const info = insertUser.run(name.trim(), null);
  return getById.get(info.lastInsertRowid);
}
```

- [ ] **Step 2: server.js 改 `POST /api/coach/customers` 分流**

import 區把 `createCustomerNoPhone` 併入既有 userService import；端點改為：

```js
app.post('/api/coach/customers', requireCoach, asyncHandler((req, res) => {
  const { name, phone } = req.body || {};
  // 電話選填：留空 → 建無電話客人（之後於後台會員管理補）；有帶 → 原 find-or-create（驗證/員工守門不變）
  const hasPhone = phone != null && String(phone).trim() !== '';
  const u = hasPhone ? findOrCreateUserByPhone({ name, phone }) : createCustomerNoPhone({ name });
  res.json({ id: u.id, name: u.name, phone: u.phone });
}));
```

- [ ] **Step 3: coach.js `renderRegmNewCustomer` 改選填**

電話輸入欄：

```js
      <input id="regm-newc-phone" class="form-input" placeholder="電話（選填，可之後再補）" value="${escapeHtml(phoneVal)}" inputmode="numeric" autocomplete="off" />
```

送出 handler：刪掉 `if (!phone) { toast('請填電話', 'error'); return; }`，body 改條件帶 phone：

```js
    const name = $('regm-newc-name').value.trim();
    const phone = $('regm-newc-phone').value.trim();
    if (!name) { toast('請填姓名', 'error'); return; }
    try {
      const u = await api('/api/coach/customers', { method: 'POST', body: phone ? { name, phone } : { name } });
```

（catch 內錯誤對照表不動。）

- [ ] **Step 4: 擴充 `tests/coach-add-customer-api.test.js`**

`clean()` 的 DELETE 條件加 `OR name LIKE 'CAC無話%'`：

```js
const clean = () => db.exec(`DELETE FROM users WHERE phone IN ('${PHONES.join("','")}') OR email LIKE 'cac-%' OR name LIKE 'CAC無話%'`);
```

在案例 5 之後、`clean();` 之前加：

```js
// 6) 無電話 → 200 phone:null；DB phone IS NULL、role=user
const r6 = await req('POST', '/api/coach/customers', { token, body: { name: 'CAC無話一' } });
expect('無電話建立 → 200 + phone null', () => {
  assert.equal(r6.status, 200);
  assert.ok(Number.isInteger(r6.data.id));
  assert.equal(r6.data.phone, null);
});
expect('DB phone IS NULL 且 role=user', () => {
  const u = db.prepare('SELECT phone, role FROM users WHERE id=?').get(r6.data.id);
  assert.equal(u.phone, null);
  assert.equal(u.role, 'user');
});

// 7) 空白字串電話 → 視為未帶
const r7 = await req('POST', '/api/coach/customers', { token, body: { name: 'CAC無話二', phone: '  ' } });
expect('空白電話 → 視為未帶、建立成功', () => { assert.equal(r7.status, 200); assert.equal(r7.data.phone, null); });

// 8) 兩個無電話客人並存（不合併）
expect('無電話客人不合併（不同 id）', () => assert.notEqual(r6.data.id, r7.data.id));

// 9) 無電話且缺名 → 400 missing_name
const r9 = await req('POST', '/api/coach/customers', { token, body: { name: '' } });
expect('無電話且缺名 → 400 missing_name', () => { assert.equal(r9.status, 400); assert.equal(r9.data.error, 'missing_name'); });
```

- [ ] **Step 5: 跑測試（含既有五案例回歸）**

```bash
lsof -ti:3000 | xargs kill 2>/dev/null
(LINE_MOCK=1 GOOGLE_CLIENT_ID=test-client-id npm start &)
sleep 2
node tests/coach-add-customer-api.test.js   # 預期 10 ✓（既有 6 + 新 4 段）、exit 0
node --check public/coach.js                 # 前端語法
lsof -ti:3000 | xargs kill
```

- [ ] **Step 6: Commit**

```bash
git add src/services/userService.js src/server.js public/coach.js tests/coach-add-customer-api.test.js
git commit -m "feat: 登錄預約新增客人電話改選填（無電話客人可先登錄、之後後台補）"
```

---

## 收尾（controller）

1. 全套 `npm test` ＋ server 帶環境變數跑 `npm run test:api` → 全綠；`node src/db/seed-demo.js` 重種。
2. Final review subagent（小 diff：確認有電話路徑零變化、無電話路徑安全面）。
3. Push + draft PR + preview server 給業主 smoke。
