# 我的課表帶出客人方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 客人在「我的課表」（電話＋姓名查詢）看得到自己的有效方案：類型／總堂／已登錄／剩餘（＋到期日）。

**Architecture:** `getPublicSchedule` 多回 `packages`（用 PR1 `listValidPackagesForMember`、投影安全欄位）；前端 my-schedule 加「我的方案」區塊。

**Tech Stack:** Node ESM、Express、node:sqlite；前端 vanilla JS。

## Global Constraints
- `getPublicSchedule` 沿用 `getUserByPhoneAndName`（驗名＋role 守門）；packages 只回安全欄位（session_type/total_sessions/used_sessions/remaining_sessions/expires_at），不洩 amount/discount_code/id/member_id。
- 「已登錄」used_sessions = total_sessions − remaining_sessions。只回有效方案（listValidPackagesForMember 已篩未作廢＋remaining>0＋未過期）。
- 測試純 node；`expect()` 不 throw → 掃 `✗`。`npm test` 清 demo → 收尾重 seed。繁中 UI。

## File Structure
- `src/services/groupOrderService.js` — getPublicSchedule 加 import + packages。
- `public/my-schedule.html` — 加 `#packages-section` 容器。
- `public/my-schedule.js` — state.packages + doLookup/showForm + render() 方案區塊。
- 測試：`tests/my-schedule-packages.test.js`(unit)、`tests/my-schedule-packages-api.test.js`(api)。
- `package.json` — 掛兩支測試。

---

## Task 1：後端 getPublicSchedule 回 packages + 測試

**Files:** Modify `src/services/groupOrderService.js`、`package.json`；Create `tests/my-schedule-packages.test.js`、`tests/my-schedule-packages-api.test.js`。

**Interfaces:** Produces: `getPublicSchedule(...)` 回傳物件多 `packages:[{session_type,total_sessions,used_sessions,remaining_sessions,expires_at}]`（只含有效方案）。

- [ ] **Step 1：import listValidPackagesForMember**

`src/services/groupOrderService.js` 頂部 import 區加（與既有 import 並列）：
```js
import { listValidPackagesForMember } from './packageService.js';
```
（確認無循環 import：packageService 只 import connection/registration，不 import groupOrderService。）

- [ ] **Step 2：getPublicSchedule return 加 packages**

把 return 物件：
```js
  return {
    user: { name: user.name, phone: user.phone },
    items, one_on_one_remaining, group_remaining,
    line_bound: user.role === 'user' ? !!user.line_user_id : null,
  };
```
改為：
```js
  const packages = listValidPackagesForMember(user.id).map((p) => ({
    session_type: p.session_type,
    total_sessions: p.total_sessions,
    used_sessions: p.total_sessions - p.remaining_sessions,
    remaining_sessions: p.remaining_sessions,
    expires_at: p.expires_at,
  }));
  return {
    user: { name: user.name, phone: user.phone },
    items, one_on_one_remaining, group_remaining,
    line_bound: user.role === 'user' ? !!user.line_user_id : null,
    packages,
  };
```

- [ ] **Step 3：unit 測試 `tests/my-schedule-packages.test.js`**

```js
// getPublicSchedule.packages：只回有效方案、used=total-remaining、安全欄位、無方案→[]。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { createPackage, deductOne, archivePackage } = await import('../src/services/packageService.js');
const { getPublicSchedule } = await import('../src/services/groupOrderService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[my-schedule-packages test] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'msp-%'); DELETE FROM users WHERE email LIKE 'msp-%'");
clean();
const u=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('陳筱蘋','msp-m@x.com','user','0994000001')").run().lastInsertRowid);

expect('無方案 → packages 為 []', () => {
  const r = getPublicSchedule({ phone: '0994000001', name: '陳筱蘋' });
  assert.deepEqual(r.packages, []);
});
expect('有效方案：總/已登錄(=扣抵)/剩餘 + 只含安全欄位', () => {
  const p = createPackage({ memberId: u, sessionType: '1on1', totalSessions: 10, amount: 15000, expiresAt: '2099-12-31' });
  deductOne(p.id); deductOne(p.id); deductOne(p.id); // 已登錄 3 → 剩 7
  const r = getPublicSchedule({ phone: '0994000001', name: '陳筱蘋' });
  assert.equal(r.packages.length, 1);
  const pk = r.packages[0];
  assert.equal(pk.session_type, '1on1');
  assert.equal(pk.total_sessions, 10);
  assert.equal(pk.used_sessions, 3);
  assert.equal(pk.remaining_sessions, 7);
  assert.equal(pk.expires_at, '2099-12-31');
  // 安全：不洩 amount/discount_code/id/member_id
  assert.ok(!('amount' in pk) && !('discount_code' in pk) && !('id' in pk) && !('member_id' in pk));
});
expect('用罄/過期/作廢方案不出現', () => {
  clean(); const u2=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('陳筱蘋','msp-m@x.com','user','0994000001')").run().lastInsertRowid);
  const used = createPackage({ memberId: u2, sessionType: '1on1', totalSessions: 1 }); deductOne(used.id); // 剩0
  const expired = createPackage({ memberId: u2, sessionType: '1on2', totalSessions: 5, expiresAt: '2000-01-01' });
  const arch = createPackage({ memberId: u2, sessionType: '1on1', totalSessions: 5 }); archivePackage(arch.id);
  const valid = createPackage({ memberId: u2, sessionType: '1on2', totalSessions: 8 });
  const r = getPublicSchedule({ phone: '0994000001', name: '陳筱蘋' });
  assert.equal(r.packages.length, 1);
  assert.equal(r.packages[0].session_type, '1on2');
  assert.equal(r.packages[0].total_sessions, 8);
});
clean();
console.log('[my-schedule-packages test] done');
```

- [ ] **Step 4：跑 unit**

Run: `node tests/my-schedule-packages.test.js` → 全 `✓`、0 `✗`。

- [ ] **Step 5：api 測試 `tests/my-schedule-packages-api.test.js`**

```js
// API：POST /api/public/my 回 packages（公開端點，無 token）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createPackage, deductOne } from '../src/services/packageService.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body}={}){const r=await fetch(BASE+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[my-schedule-packages-api] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'mspa-%'); DELETE FROM users WHERE email LIKE 'mspa-%'");
clean();
const u=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','mspa-m@x.com','user','0995000001')").run().lastInsertRowid);
const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:6, amount:9000 }); deductOne(p.id); // 已登錄1 剩5
const r=await req('POST','/api/public/my',{body:{phone:'0995000001',name:'方案客'}});
expect('回 packages：total6/used1/remaining5、不含 amount',()=>{
  assert.equal(r.status,200);
  assert.ok(Array.isArray(r.data.packages) && r.data.packages.length===1);
  const pk=r.data.packages[0];
  assert.equal(pk.total_sessions,6); assert.equal(pk.used_sessions,1); assert.equal(pk.remaining_sessions,5);
  assert.ok(!('amount' in pk));
});
clean();
console.log('[my-schedule-packages-api] done');
```

- [ ] **Step 6：掛 package.json（test 末加 `&& node tests/my-schedule-packages.test.js`；test:api 末加 `&& node tests/my-schedule-packages-api.test.js`）+ 起 server 跑 api**

```bash
node tests/my-schedule-packages.test.js
(LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 PORT=3000 node src/server.js & SRV=$!; sleep 1.5; node tests/my-schedule-packages-api.test.js; kill $SRV)
```
Expected 全 `✓`、0 `✗`。

- [ ] **Step 7：Commit**
```bash
git add src/services/groupOrderService.js tests/my-schedule-packages.test.js tests/my-schedule-packages-api.test.js package.json
git commit -m "feat(my-schedule): getPublicSchedule 回客人有效方案（總/已登錄/剩餘）"
```

---

## Task 2：前端 我的課表「我的方案」區塊

**Files:** Modify `public/my-schedule.html`、`public/my-schedule.js`。

**Interfaces:** Consumes `data.packages`（Task 1）。

- [ ] **Step 1：my-schedule.html 加 `#packages-section` 容器**

把（line 250-252）：
```html
    <!-- Remaining counts banner -->
    <div id="remaining-summary" class="remaining-banner">
      1對1 剩 0 堂 · 團體 剩 0 堂
    </div>
```
之後加：
```html
    <!-- 我的方案（有效套餐） -->
    <div id="packages-section" style="display:none;margin:12px 0;"></div>
```

- [ ] **Step 2：my-schedule.js state 加 packages**

把 `state` 物件的 `group_remaining: 0,` 之後加 `packages: [],`。

- [ ] **Step 3：doLookup 設 state.packages**

在 `state.group_remaining = data.group_remaining ?? 0;` 之後加：
```js
    state.packages = data.packages ?? [];
```

- [ ] **Step 4：showForm 重置清空（state.items=[] 附近）**

在 `state.items = [];`（showForm 內）之後加 `state.packages = [];`。

- [ ] **Step 5：render() 渲染方案區塊（在 summary line 之後、filtered 之前）**

在 `render()` 內、設定 `summaryEl.textContent = ...` 之後，加：
```js
  // 我的方案（有效套餐）
  const PKG_TYPE = { '1on1': '一對一', '1on2': '一對二' };
  const pkgSec = document.getElementById('packages-section');
  if (pkgSec) {
    const pkgs = state.packages || [];
    if (pkgs.length === 0) {
      pkgSec.style.display = 'none';
      pkgSec.innerHTML = '';
    } else {
      pkgSec.style.display = 'block';
      pkgSec.innerHTML =
        '<div class="section-label">我的方案</div>' +
        pkgs.map((p) => {
          const t = PKG_TYPE[p.session_type] || escapeHtml(p.session_type);
          const exp = p.expires_at ? `（到期 ${escapeHtml(String(p.expires_at)).replace(/-/g, '/')}）` : '';
          return `<div class="pkg-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:6px;background:#f8fafc;">
            <span style="font-weight:600;">${t}</span>
            <span style="font-size:13px;color:#334155;">總 ${p.total_sessions} 堂・已登錄 ${p.used_sessions}・剩 ${p.remaining_sessions}${exp}</span>
          </div>`;
        }).join('');
    }
  }
```
（`escapeHtml` 確認已自 app.js import；my-schedule.js 既有使用 escapeHtml 於 cardHtml。`total_sessions`/`used_sessions`/`remaining_sessions` 為 DB 整數，直接內插無 XSS 風險。）

- [ ] **Step 6：驗證** `node --check public/my-schedule.js`（無語法錯）。瀏覽器 smoke 收尾統一做。

- [ ] **Step 7：Commit**
```bash
git add public/my-schedule.html public/my-schedule.js
git commit -m "feat(my-schedule): 我的課表顯示有效方案（總/已登錄/剩餘）"
```

---

## Self-Review（plan 作者自檢）
**Spec 覆蓋**：後端 packages 投影（Task1）+ 前端方案區塊（Task2）。只回/只顯示有效方案、used=total−remaining、不洩金額——皆對齊 spec。
**Placeholder**：無；改碼步驟皆附完整碼與錨點。
**型別一致**：`getPublicSchedule.packages[]`（Task1）欄位 session_type/total_sessions/used_sessions/remaining_sessions/expires_at ↔ Task2 render 使用一致。`listValidPackagesForMember` 已存在（PR1），回 cp.* 含這些欄位。
**待最終審查特別看**：(a) 無循環 import（groupOrderService→packageService 單向）；(b) packages 只投影安全欄位（測試斷言 !('amount' in pk)）；(c) render 方案區塊在無方案時隱藏、escapeHtml 用於 session_type 後備。
