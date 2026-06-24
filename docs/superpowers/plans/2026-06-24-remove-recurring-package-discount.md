# PR4：移除公開頁循環 + 方案建立加折扣碼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 移除公開預約頁的舊「循環預約（員工排課）」（含後端端點/service/測試）；在兩處「方案建立」表單加折扣碼下拉（記碼＋存折扣後金額、不限用量）。

**Architecture:** 純移除舊循環（UI＋路由＋舊 service 函式＋舊測試），保留新登錄循環(expandRecurrence/createCoachRegister)與群組付款操作；折扣＝`customer_packages.discount_code` 新欄 + discountService 兩個新 helper + createPackage 套用 + coach 端點 + 兩處前端下拉。

**Tech Stack:** Node ESM、Express、node:sqlite；前端 vanilla JS。

## Global Constraints
- 例外 `ApiError(status, code)`；交易 `tx`；遷移 `addColumnIfMissing` + schema.js。
- **保留（勿刪）**：`recurring_group_id`、`expandRecurrence`、`createCoachRegister`/`previewCoachRegister`、`rescheduleBooking`/`reassignBooking`、群組操作（`confirmBookingPaymentGroup`/`cancelBookingAdminGroup`/`refundBookingGroupAdmin`）、`listPendingPaymentBookings`/`listConfirmedPayments`、`computeAvailableSlots`/`assertBookableTx`。
- **僅移除舊公開頁循環**：`RECURRING_FREQS`/`_validateRecurringParams`/`recurringOccurrences`/`_occurrenceAvailable`/`previewRecurringBookings`/`createRecurringBookings` + 其路由 + 公開頁 UI/JS + 2 支舊測試。
- 折扣：**不限用量、不記 redemption**；`quoteDiscount` 仍驗 active＋效期。折後金額存 `customer_packages.amount`，碼存 `discount_code`。
- 測試：unit 掛 `test`、api 掛 `test:api`；`expect()` 不 throw → 掃 `✗`。`npm test` 清 demo → 收尾重 seed。繁中 UI。

## File Structure
- `src/server.js` — 刪 2 recurring 路由+import；加 `GET /api/coach/discount-codes`、`POST /api/coach/packages` 收 discountCode。
- `src/services/bookingService.js` — 刪 6 個舊循環函式/常數 + 清孤兒 import `sendRecurringConfirmation`。
- `src/services/discountService.js` — 加 `listActiveDiscountCodes`/`quoteDiscount`。
- `src/services/packageService.js` — createPackage 加 `discountCode`。
- `src/db/schema.js` + `src/db/connection.js` — `customer_packages.discount_code`。
- `public/coaches.html` / `public/coaches.js` — 移除循環 UI/JS。
- `public/coach.js` / `public/admin.js` — 方案建立表單加折扣下拉。
- 測試：刪 `tests/recurring-booking.test.js`、`tests/recurring-booking-api.test.js`；新增 `tests/package-discount.test.js`(unit)、`tests/package-discount-api.test.js`(api)。
- `package.json` — 移除 2 行、加 2 行。

---

## Task 1：移除舊循環後端（路由 + service + 測試）

**Files:** Modify `src/server.js`、`src/services/bookingService.js`、`package.json`；Delete `tests/recurring-booking.test.js`、`tests/recurring-booking-api.test.js`。

**Interfaces:** Removes: `POST /api/bookings/recurring/preview|`、`/api/bookings/recurring`；bookingService 的 `RECURRING_FREQS`/`_validateRecurringParams`/`recurringOccurrences`/`_occurrenceAvailable`/`previewRecurringBookings`/`createRecurringBookings`。保留其餘全部。

- [ ] **Step 1：刪 server.js 的 2 條 recurring 路由**

刪除整段（**約 1057-1087**，以文字錨點為準：`// ─── 循環預約（教練/管理者限定...` 註解起，到 `app.post('/api/bookings/recurring', ...)` route 結束的 `}));`）——即 `app.post('/api/bookings/recurring/preview', ...)` 與 `app.post('/api/bookings/recurring', ...)` 兩個 route 與其上方註解。**務必保留其正上方的 `DELETE /api/bookings/:id` 路由（約 1005-1055，教練/管理者取消用，編輯彈窗也靠它）**——別誤刪。

- [ ] **Step 2：刪 server.js import 的兩行**

於 bookingService import 區塊刪除：
```js
  previewRecurringBookings as svcPreviewRecurring,
  createRecurringBookings as svcCreateRecurring,
```

- [ ] **Step 3：刪 bookingService.js 的舊循環引擎（兩段，注意只刪舊的、保留新 expandRecurrence/register）**

(a) 刪除「`const RECURRING_FREQS = [...]` 起，到 `recurringOccurrences` 函式結束」整段（含其上方 `// ───…循環預約（教練/管理者限定；spec: docs/...2026-06-12-recurring-bookings-design.md）…` 註解 banner、`RECURRING_FREQS`、`_validateRecurringParams`、`recurringOccurrences`）。**停在** `// ── 2026-06-24 進階循環（Google 行事曆式…` 註解之前（該註解與其後 `expandRecurrence` 為**新版、保留**）。

(b) 刪除 `_occurrenceAvailable`、`previewRecurringBookings`、`createRecurringBookings` 三個函式整段（含其上方註解）。這三個在 `createCoachRegister` 之後；刪除時確認**保留** `previewCoachRegister`/`createCoachRegister`/`getValidPackageForRegister`/`hasConfirmedClash`/`rescheduleBooking`/`reassignBooking` 與檔尾的群組操作（`confirmBookingPaymentGroup`/`cancelBookingAdminGroup`/`refundBookingGroupAdmin`）。

(c) 清孤兒 import：`createRecurringBookings` 用到的 `sendRecurringConfirmation` 移除後變未用 → 把 `import { sendPaymentConfirmedEmail, sendRecurringConfirmation } from './emailService.js';` 改為 `import { sendPaymentConfirmedEmail } from './emailService.js';`（若 `sendRecurringConfirmation` 確實已無其他引用——grep 確認）。

- [ ] **Step 4：刪 2 支舊測試檔 + package.json 移除**

```bash
git rm tests/recurring-booking.test.js tests/recurring-booking-api.test.js
```
`package.json`：從 `test` 移除 ` && node tests/recurring-booking.test.js`；從 `test:api` 移除 ` && node tests/recurring-booking-api.test.js`。

- [ ] **Step 4b：遷移 `tests/booking-group-ops.test.js`（它用 `createRecurringBookings` 當 fixture 建「未付款群組」再測保留的群組操作；移除函式後會 TypeError 中斷整個 unit 套件）**

(1) import 移除 `createRecurringBookings`（line 6-7），改為：
```js
const { listPendingPaymentBookings, confirmBookingPaymentGroup,
        cancelBookingAdminGroup, refundBookingGroupAdmin, refundBookingAdmin, listConfirmedPayments } = await import('../src/services/bookingService.js');
```
(2) 在 `day` helper（約 line 19）之後，加直接建「未付款 recurring 群組」的 helper（取代 createRecurringBookings；保留 paid_at NULL 供 pending 斷言，original_amount=1500 對齊原測試）：
```js
const insBk = db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount) VALUES (?, ?, ?, ?, '1on1', 1500)");
function makeUnpaidGroup({ startOffset, time, count, name, phone }) {
  let uid = db.prepare('SELECT id FROM users WHERE phone=?').get(phone)?.id;
  if (!uid) uid = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?, ?, 'user', ?)").run(name, `bg-${phone}@x.com`, phone).lastInsertRowid);
  const hh = time.slice(0, 2); const endHh = String(Number(hh) + 1).padStart(2, '0');
  const ids = [];
  for (let k = 0; k < count; k++) {
    const ds = day(startOffset + 7 * k); // weekly = +7 天，對齊舊 recurringOccurrences
    ids.push(Number(insBk.run(coachId, uid, `${ds}T${time}:00`, `${ds}T${endHh}:00:00`).lastInsertRowid));
  }
  const groupId = ids[0];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`UPDATE bookings SET recurring_group_id=? WHERE id IN (${ph})`).run(groupId, ...ids);
  return { groupId, created: ids.map(id => ({ id })) };
}
```
(3) 取代 r1（line 22-25）：
```js
const r1 = makeUnpaidGroup({ startOffset: 7, time: '10:00', count: 3, name: '批量客', phone: '0983111222' });
```
(4) 取代 r2（line 76-79）：
```js
const r2 = makeUnpaidGroup({ startOffset: 8, time: '14:00', count: 2, name: '批量客二', phone: '0983333444' });
```
其餘斷言不動（total 4500＝3×1500、釋出時段、整批收款/取消/退款仍以 recurring_group_id 運作）。

- [ ] **Step 4c：移除 `tests/admin-backfill-api.test.js` 的循環預覽區塊（呼叫被移除的 `/api/bookings/recurring/preview`）**

刪除這段（約 line 66-72）：
```js
// 管理者循環預覽（過去起始）→ 首堂可建立（過去場次照常驗證、容量正常）
const rprev = await req('POST', '/api/bookings/recurring/preview', { token, body: { coachId, startAt: pastStart2, sessionType:'1on1', frequency:'weekly', count: 2 } });
expect('管理者循環預覽（過去起始）→ 首堂 ok', () => {
  assert.equal(rprev.status, 200);
  const first = rprev.data.occurrences.find(o => o.startAt === pastStart2);
  assert.ok(first && first.ok === true);
});
```
其餘 backfill 測試（走 `/api/public/bookings` 的過去日期預約）保留。`pastStart2` 若僅此處用到，其定義可留（無害）或一併清。

- [ ] **Step 5：驗證無殘留引用 + 既有測試不破壞**

```bash
grep -rn "recurringOccurrences\|previewRecurringBookings\|createRecurringBookings\|_validateRecurringParams\|_occurrenceAvailable\|RECURRING_FREQS\|svcPreviewRecurring\|svcCreateRecurring\|/api/bookings/recurring" src/ tests/ ; echo "expect: no matches"
node --input-type=module -e "import('./src/services/bookingService.js').then(m=>console.log('expandRecurrence?', typeof m.expandRecurrence, 'createCoachRegister?', typeof m.createCoachRegister, 'createRecurringBookings?', typeof m.createRecurringBookings))"
```
Expected: grep 無 match（含 tests/）；`expandRecurrence? function createCoachRegister? function createRecurringBookings? undefined`。
再跑關聯 unit 確認沒壞（尤其遷移後的群組測試）：`node tests/coach-register.test.js && node tests/booking-group-ops.test.js`（全 ✓、0 ✗）。admin-backfill-api 屬 api（需起 server），併入 Task 2 收尾或最終全套 api 驗證時一起跑。

- [ ] **Step 6：Commit**
```bash
git add -A
git commit -m "feat(cleanup): 移除公開頁舊循環預約後端（路由/service/測試）"
```

---

## Task 2：折扣後端（schema + discountService + createPackage + 端點 + 測試）

**Files:** Modify `src/db/schema.js`、`src/db/connection.js`、`src/services/discountService.js`、`src/services/packageService.js`、`src/server.js`、`package.json`；Create `tests/package-discount.test.js`、`tests/package-discount-api.test.js`。

**Interfaces:**
- `listActiveDiscountCodes() → [{code, discount_type, discount_value}]`（active＋效期內）
- `quoteDiscount({code, amount}) → {code, discountAmount, finalTotal}|null`（驗 active/效期；不查用量）
- `createPackage({..., discountCode=null})`：折扣後金額存 amount、碼存 discount_code。
- `GET /api/coach/discount-codes`、`POST /api/coach/packages {..., discountCode}`。

- [ ] **Step 1：schema 加 `customer_packages.discount_code`**

`src/db/schema.js` 的 `customer_packages` CREATE 內，`note TEXT,` 之後加 `discount_code TEXT,`。
`src/db/connection.js` 於 `addColumnIfMissing('bookings', 'package_id', ...)` 之後加：
```js
addColumnIfMissing('customer_packages', 'discount_code', 'TEXT');
```

- [ ] **Step 2：discountService 加兩個 helper（用既有內部 `getCodeStmt`/`normalizeCode`/`computeDiscount`/`todayLocal`）**

於 `releaseRedemption` 之後加：
```js
/** 下拉用：active 且在效期內的折扣碼（只回 code/type/value）。 */
export function listActiveDiscountCodes() {
  const today = todayLocal();
  return db.prepare(`
    SELECT code, discount_type, discount_value FROM discount_codes
    WHERE active = 1
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_until IS NULL OR valid_until >= ?)
    ORDER BY code ASC
  `).all(today, today);
}

/** 方案折扣報價：驗 active＋效期，算折扣（**不查用量上限**，方案不限用量）。空碼→null。 */
export function quoteDiscount({ code, amount }) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const c = getCodeStmt.get(norm);
  if (!c) throw new ApiError(404, 'invalid_code');
  if (!c.active) throw new ApiError(409, 'code_inactive');
  const today = todayLocal();
  if (c.valid_from && today < c.valid_from) throw new ApiError(409, 'code_not_started');
  if (c.valid_until && today > c.valid_until) throw new ApiError(409, 'code_expired');
  const { discountAmount, finalTotal } = computeDiscount(c.discount_type, c.discount_value, amount);
  return { code: c.code, discountAmount, finalTotal };
}
```
（若 `db` 未在 discountService 頂層 import，沿用既有 import；`computeDiscount`/`getCodeStmt`/`normalizeCode`/`todayLocal` 皆為該檔內既有符號。）

- [ ] **Step 3：packageService.createPackage 加 discountCode**

import 區加 `import { quoteDiscount } from './discountService.js';`。
在 `createPackage` 算出 `amt`（原價）之後、INSERT 之前加：
```js
  let discountCodeStored = null;
  // 僅在「有填金額」時才套折扣：amt==null（金額留空）→ 略過，不存碼、不把金額變成 0。
  if (discountCode != null && String(discountCode).trim() !== '' && amt != null) {
    const q = quoteDiscount({ code: discountCode, amount: amt });
    if (q) { amt = q.finalTotal; discountCodeStored = q.code; }
  }
```
函式簽名加 `discountCode = null`；INSERT 欄位與值加入 `discount_code`：
```js
  const info = db.prepare(
    `INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, note, created_by, created_at, discount_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(memberId, sessionType, total, total, amt, exp, (note && note.trim()) || null, createdBy, nowLocal(), discountCodeStored);
```
（其餘 createPackage 行為不變；getPackage 回傳會自然帶 discount_code 欄。）

- [ ] **Step 4：server.js 端點**

import 區把 discountService import 加上 `listActiveDiscountCodes`（與既有 discountService named import 並列）。
在方案路由區（`app.post('/api/coach/packages', ...)` 附近）：
(a) 既有 `POST /api/coach/packages` 的 body 解構加 `discountCode`，傳入 svcCreatePackage：
```js
  const { memberId, sessionType, totalSessions, amount, expiresAt, note, discountCode } = req.body || {};
  res.status(201).json(svcCreatePackage({ memberId: Number(memberId), sessionType, totalSessions, amount, expiresAt, note, discountCode, createdBy: req.user.id }));
```
(b) 新增：
```js
app.get('/api/coach/discount-codes', requireCoach, asyncHandler((req, res) => {
  res.json(listActiveDiscountCodes());
}));
```

- [ ] **Step 5：unit 測試 `tests/package-discount.test.js`**

```js
// 方案折扣：quoteDiscount 計算/守門；createPackage 套用折扣+記碼。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { quoteDiscount, listActiveDiscountCodes } = await import('../src/services/discountService.js');
const { createPackage } = await import('../src/services/packageService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[package-discount test] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pd-%'); DELETE FROM users WHERE email LIKE 'pd-%'; DELETE FROM discount_codes WHERE code LIKE 'PD%'");
clean();
const m=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('PD客','pd-m@x.com','user','0991000001')").run().lastInsertRowid);
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDPCT','percent',10,1)").run();   // 10% off
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDFIX','fixed',500,1)").run();    // -500
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active,max_uses) VALUES ('PDLIM','percent',50,1,0)").run(); // 用量上限 0
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDOFF','percent',10,0)").run();   // 停用
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active,valid_until) VALUES ('PDEXP','percent',10,1,'2000-01-01')").run(); // 過期

expect('quoteDiscount percent：10000 → 9000', () => { assert.equal(quoteDiscount({code:'PDPCT',amount:10000}).finalTotal, 9000); });
expect('quoteDiscount fixed：10000 → 9500', () => { assert.equal(quoteDiscount({code:'PDFIX',amount:10000}).finalTotal, 9500); });
expect('quoteDiscount 不受 max_uses 限制（PDLIM 仍可報價）', () => { assert.equal(quoteDiscount({code:'PDLIM',amount:10000}).finalTotal, 5000); });
expect('quoteDiscount 停用 → 409', () => assert.throws(()=>quoteDiscount({code:'PDOFF',amount:10000}),/code_inactive/));
expect('quoteDiscount 過期 → 409', () => assert.throws(()=>quoteDiscount({code:'PDEXP',amount:10000}),/code_expired/));
expect('quoteDiscount 空碼 → null', () => assert.equal(quoteDiscount({code:'',amount:10000}),null));
expect('listActiveDiscountCodes 含 active、不含停用/過期', () => {
  const codes=listActiveDiscountCodes().map(c=>c.code);
  assert.ok(codes.includes('PDPCT')&&codes.includes('PDFIX')&&codes.includes('PDLIM'));
  assert.ok(!codes.includes('PDOFF')&&!codes.includes('PDEXP'));
});
expect('createPackage percent 碼 → amount 折後 + discount_code 記入', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000,discountCode:'PDPCT'});
  assert.equal(p.amount,13500); assert.equal(p.discount_code,'PDPCT');
});
expect('createPackage fixed 碼 → 折抵', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000,discountCode:'PDFIX'});
  assert.equal(p.amount,14500); assert.equal(p.discount_code,'PDFIX');
});
expect('createPackage 無碼 → amount 原值、discount_code null', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000});
  assert.equal(p.amount,15000); assert.equal(p.discount_code,null);
});
expect('createPackage 停用碼 → 擋', () => assert.throws(()=>createPackage({memberId:m,sessionType:'1on1',totalSessions:5,amount:5000,discountCode:'PDOFF'}),/code_inactive/));
clean();
console.log('[package-discount test] done');
```

- [ ] **Step 6：api 測試 `tests/package-discount-api.test.js`**

```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body,token}={}){const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[package-discount-api] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pda-%'); DELETE FROM users WHERE email LIKE 'pda-%'; DELETE FROM discount_codes WHERE code LIKE 'PDA%'");
clean();
const login=await req('POST','/api/auth/login',{body:{email:'admin@chinup.local',password:'admin1234'}});
const token=login.data?.token; expect('admin 登入',()=>assert.ok(token));
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDAPCT','percent',20,1)").run();
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDAOFF','percent',20,0)").run();
const m=Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('PDA客','pda-m@x.com','0992000001','user')").run().lastInsertRowid);
const codes=await req('GET','/api/coach/discount-codes',{token});
expect('GET discount-codes 回 active、不含停用',()=>{ assert.equal(codes.status,200); const cs=codes.data.map(c=>c.code); assert.ok(cs.includes('PDAPCT')&&!cs.includes('PDAOFF')); });
const未登入=await req('GET','/api/coach/discount-codes',{});
expect('未登入 → 401',()=>assert.equal(未登入.status,401));
const c=await req('POST','/api/coach/packages',{token,body:{memberId:m,sessionType:'1on1',totalSessions:10,amount:10000,discountCode:'PDAPCT'}});
expect('建立方案帶折扣碼 → amount 折後 8000 + discount_code',()=>{ assert.equal(c.status,201); assert.equal(c.data.amount,8000); assert.equal(c.data.discount_code,'PDAPCT'); });
clean();
console.log('[package-discount-api] done');
```

- [ ] **Step 7：掛 package.json（test 末加 `&& node tests/package-discount.test.js`；test:api 末加 `&& node tests/package-discount-api.test.js`）+ 跑測試**

```bash
node tests/package-discount.test.js
(LINE_MOCK=1 GMAIL_MOCK=1 GCAL_MOCK=1 PORT=3000 node src/server.js & SRV=$!; sleep 1.5; node tests/package-discount-api.test.js; kill $SRV)
```
Expected 全 `✓`、0 `✗`（admin 登入失敗 → 重 seed 再跑）。

- [ ] **Step 8：Commit**
```bash
git add -A
git commit -m "feat(package): 方案建立支援折扣碼（discount_code 欄 + quoteDiscount + 端點）"
```

---

## Task 3：移除公開頁循環前端（coaches.html / coaches.js）

**Files:** Modify `public/coaches.html`、`public/coaches.js`。

- [ ] **Step 1：coaches.html 刪兩個循環區塊（非連續，務必保留中間的 card 收尾 `</div>`）**

`#recurring-row` 巢狀在一個 `<div class="card ...">`（約 line 90 開、line 100 `</div>` 收，該 card 還包著要保留的教練/時段資訊 91-92）。**兩段分開刪、別連續刪掉 line 100 的 `</div>`**：
1. 刪 `<!-- 員工限定：循環預約... -->` 註解 + `#recurring-row` div（約 93-99），**保留** line 100 的 `</div>`（card 收尾）與 91-92。
2. 刪 `<!-- 循環預約設定（勾選後展開）-->` 註解 + `#recurring-fields` div（約 101/102-129）。
其餘預約彈窗欄位（姓名/電話/Email/折扣/型態）保留。（可順手清 line 82 提到「循環預約/預覽展開」的過時註解。）

- [ ] **Step 2：coaches.js 刪除循環狀態與整段循環 UI**

刪除：
- `let recurringState = { previewed: false, okCount: 0 };`（482）。
- 「`// ── 循環預約 UI ──…`」整段：`recurringEnabled`、`invalidateRecurringPreview`、`refreshRecurringSubmit`、`recurringParams`、`validateRecurringInputs`、4 個 `$('recurring-*')` event listener、`$('recurring-preview-btn')` click handler（約 619-715）。
- `showRecurringSuccessView` 函式（約 943-…，整個函式）。

- [ ] **Step 3：coaches.js 簡化 `refreshModalPrice`（移除循環分支）整段替換為**

```js
function refreshModalPrice() {
  const s1 = document.getElementById('price-1on1');
  const s2 = document.getElementById('price-1on2');
  if (s1) s1.textContent = priceByType['1on1'] != null ? `單堂 $${priceByType['1on1'].toLocaleString()}` : '';
  if (s2) s2.textContent = priceByType['1on2'] != null ? `單堂 $${priceByType['1on2'].toLocaleString()}` : '';
  const priceRow = $('modal-price-row');
  const msgEl = $('modal-discount-msg');
  priceRow.classList.add('hidden'); // 單筆模式不顯示總計列
  if (modalAppliedDiscount) {
    msgEl.textContent = `折扣套用成功：折後現場應付 $${modalAppliedDiscount.finalTotal.toLocaleString()}`;
    msgEl.style.color = '#15803d';
    msgEl.classList.remove('hidden');
  }
}
```

- [ ] **Step 4：coaches.js `setSessionType` 移除 `invalidateRecurringPreview();` 那行（556）**

- [ ] **Step 5：coaches.js `openBookingModal` 移除循環重置區塊（604-613）**

刪除「`// 循環預約（員工限定）…`」起到 `recurringState = { previewed: false, okCount: 0 };` 的整段（含 `getUser()`/`isStaff`/`$('recurring-*')` 重置）。其後 `$('booking-modal').classList.remove('hidden'); $('modal-name').focus();` 保留。

- [ ] **Step 6：coaches.js 送出處理移除循環分支**

刪除 submit handler 內「`// ── 循環模式：走員工端點…` `if (recurringEnabled()) { … return; }`」整段（838-863）。保留其後單筆 `POST /api/public/bookings` 流程。

- [ ] **Step 7：驗證**

```bash
node --check public/coaches.js
grep -c "recurring" public/coaches.js public/coaches.html
```
Expected：`node --check` OK；`recurring` 計數 0（兩檔皆 0；若有殘留註解請一併清）。

- [ ] **Step 8：Commit**
```bash
git add public/coaches.html public/coaches.js
git commit -m "feat(cleanup): 移除公開頁循環預約 UI（改由教練後台登錄排課）"
```

---

## Task 4：折扣下拉前端（登錄彈窗 + 會員管理方案區塊）

**Files:** Modify `public/coach.js`、`public/admin.js`。

**Interfaces:** Consumes `GET /api/coach/discount-codes`、`POST /api/coach/packages {discountCode}`。

- [ ] **Step 1：coach.js 加 active 折扣碼快取 + 取用 helper（放在模組頂部變數區，如 regCoachOptionsCache 附近）**

```js
let regDiscountCodesCache = null; // [{code,discount_type,discount_value}]
async function getDiscountCodes() {
  if (regDiscountCodesCache) return regDiscountCodesCache;
  try { regDiscountCodesCache = await api('/api/coach/discount-codes'); } catch { regDiscountCodesCache = []; }
  return regDiscountCodesCache;
}
function discountOptionsHtml(codes) {
  const label = (c) => c.discount_type === 'percent' ? `${c.discount_value}% 折扣` : `折抵 $${c.discount_value}`;
  return '<option value="">不使用折扣碼</option>' +
    codes.map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} — ${label(c)}</option>`).join('');
}
```

- [ ] **Step 2：coach.js `renderRegmPicked` 的「開方案」表單加折扣下拉**

在無方案分支的新方案表單（`#regm-np-type`/`#regm-np-total`/`#regm-np-amount`/`#regm-np-expiry` 那組）內，於到期日後加一個下拉容器，並在 render 後填充：
- 表單 HTML 內加：`<select id="regm-np-discount" class="form-select"></select>`（放在 grid 內或其後）。
- 在設定該表單事件處之前/後，填充：
```js
  getDiscountCodes().then(codes => { const el = document.getElementById('regm-np-discount'); if (el) el.innerHTML = discountOptionsHtml(codes); });
```
- `#regm-np-create` 的 POST body 加 `discountCode: document.getElementById('regm-np-discount')?.value || null`。

- [ ] **Step 3：admin.js `renderMemberPackages` 的「新增方案」表單加折扣下拉**

admin.js 第 1 行已 `import { api, ..., escapeHtml } from '/app.js'`（**勿再加重複 helper，會 redeclare**）。在 admin.js 加 Step 1 的兩個新 helper（`getDiscountCodes`/`discountOptionsHtml`，admin.js 需自己一份，用既有 import 的 api/escapeHtml）。在新增方案 `<details>` 表單（`#pkg-type`/`#pkg-total`/`#pkg-amount`/`#pkg-expiry`/`#pkg-note`）加 `<select id="pkg-discount" class="form-select"></select>`；**沿用該檔的 `mountEl.querySelector` scoped 寫法**：render 後以 `getDiscountCodes().then(codes => { const el = mountEl.querySelector('#pkg-discount'); if (el) el.innerHTML = discountOptionsHtml(codes); })` 填充；`#pkg-create` 的 POST body 加 `discountCode: mountEl.querySelector('#pkg-discount')?.value || null`。

- [ ] **Step 4：驗證** `node --check public/coach.js && node --check public/admin.js`。瀏覽器 smoke 於收尾統一做。

- [ ] **Step 5：Commit**
```bash
git add public/coach.js public/admin.js
git commit -m "feat(package): 方案建立彈窗折扣碼下拉（兩處表單；灰字標 %/定額）"
```

---

## Self-Review（plan 作者自檢）
**Spec 覆蓋**：A 移除（Task1 後端路由/service/測試 + Task3 前端 UI/JS）；B 折扣（Task2 schema/service/端點/測試 + Task4 兩處前端下拉）。保留新登錄循環與群組操作（Task1 明列保留、grep 驗證）。
**Placeholder**：無 TBD；刪除以函式名/區塊錨點 + 驗證指令（grep 計數）界定；折扣碼計算與守門有完整碼。
**型別一致**：`listActiveDiscountCodes`/`quoteDiscount`（Task2 service）↔ 端點（Task2 server）↔ 前端 `getDiscountCodes`/`discountOptionsHtml`（Task4）一致；`createPackage` discountCode 參數 ↔ POST body ↔ 回傳 `discount_code` 欄一致。
**受移除波及的既有測試（已納入 Task 1 遷移）**：`booking-group-ops.test.js`（原用 createRecurringBookings 當 fixture → 改 Step 4b 的 makeUnpaidGroup 直接 INSERT 群組）、`admin-backfill-api.test.js`（原呼叫 /api/bookings/recurring/preview → Step 4c 移除該區塊）。Step 5 grep 已含 tests/。

**待最終審查特別看**：(a) bookingService 刪除邊界——只刪舊 6 函式（436-472 + 683-774），保留夾在中間的 expandRecurrence/createCoachRegister/reschedule/reassign 與檔尾群組操作；(b) `sendRecurringConfirmation` 移除後無殘引用；(c) coaches.js 移除後單筆預約+折扣仍正常（refreshModalPrice/submit 簡化版）；(d) quoteDiscount 對 fixed 超過原價的處理（computeDiscount `Math.min(value,subtotal)`、finalTotal 不為負）；(e) 遷移後的 booking-group-ops 與 admin-backfill-api 全綠。
