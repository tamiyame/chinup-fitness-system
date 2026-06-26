# 方案顯示到「課全上完」才消失 + 卡片三數字 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客人「我的方案」持續顯示直到該方案所有課上完(已結束)才消失，卡片顯示 共/已上完/尚餘。

**Architecture:** 後端新增 `packageService.listScheduleViewPackages(memberId, now)`（用 `bookings.package_id` 統計 completed/upcoming，顯示條件＝有未來課或嚴格有效），`getPublicSchedule` 改用它並換投影欄位。前端 `my-schedule.js` 卡片改三數字。只影響客人端我的課表顯示；無 schema 變更。

**Tech Stack:** node:sqlite + Express（後端）、Vanilla JS ESM（`public/my-schedule.js`）、node:test。

## Global Constraints

- **只影響客人端「我的課表」(`getPublicSchedule`) 顯示**；後台登錄/改方案選單與所有扣抵路徑仍用嚴格 `listValidPackagesForMember`（`remaining_sessions>0`）——**不得更動**。
- 顯示條件（per package，非作廢）：`upcoming>0` **或**（`remaining_sessions>0` 且未過期）。全部上完(`completed==total` 且無 upcoming)＝已結束→不顯示。
- `completed`＝該方案 confirmed 預約且 `start_at < now`；`upcoming`＝confirmed 且 `start_at >= now`（與既有 `is_past = start_at < now` 一致）。
- 投影**安全欄位**：`{ session_type, total_sessions, completed_sessions, remaining_sessions(=total−completed), expires_at }`（移除 `used_sessions`；`remaining_sessions` 在此投影重新定義為「尚餘＝共−已上完」，只供我的課表卡片）。不洩 amount/id/discount_code/member_id。
- 卡片：meta「已上完 X · 共 N 堂」、進度條＝completed/total、右側大字＝remaining_sessions(尚餘)、標籤「尚餘」。
- 無 schema 變更；不改扣抵/回補。
- **既有兩支方案測試斷言舊投影、且用 `deductOne` 無實際 bookings → 本 PR 依 spec 決策一併遷移到新語意（插入真實 bookings 驅動 completed/upcoming）。** 這是刻意的行為變更，非「改測試遷就」。

---

## 既有程式碼錨點（實作者必讀）

`src/services/packageService.js`：
- 行 1：`import { db, tx, nowLocal } from '../db/connection.js';`；`todayLocal()`（行 8）。
- 行 71–83：`listValidPackagesForMember`（嚴格，**不動**）。**新函式加在其後。**

`src/services/groupOrderService.js`：
- 行 7：`import { listValidPackagesForMember } from './packageService.js';`（**改成 import `listScheduleViewPackages`**；確認 `listValidPackagesForMember` 在本檔僅此處用——是）。
- `getPublicSchedule` 內 `now = nowLocal()` 已存在；行 517–522：
  ```js
  const packages = listValidPackagesForMember(user.id).map((p) => ({
    session_type: p.session_type,
    total_sessions: p.total_sessions,
    used_sessions: p.total_sessions - p.remaining_sessions,
    remaining_sessions: p.remaining_sessions,
    expires_at: p.expires_at,
  }));
  ```

`public/my-schedule.js`：
- render() 方案卡片（行 ~362、376–386）：用 `used_sessions`/`remaining_sessions` 畫 pk-meta「已登錄 X · 共 N 堂」/ pk-bar(used/total) / pk-remain「剩餘」。CSS `pk-*` 在 `my-schedule.html`（**不需改 CSS**，僅文字與數值來源變）。

`bookings`（schema:201–226）：`coach_id NOT NULL`,`member_id NOT NULL`,`start_at/end_at NOT NULL`(CHECK start<end),`status IN(confirmed,cancelled)`,`session_type IN(1on1,1on2)`,`package_id`(nullable FK)。
測試需 coach：`SELECT id FROM coaches ORDER BY id LIMIT 1`（seed 保證有）。FK：刪 customer_packages 前須先刪參照它的 bookings。

---

## File Structure
- **Modify `src/services/packageService.js`**（Task 1）：加 `listScheduleViewPackages`。
- **Modify `src/services/groupOrderService.js`**（Task 1）：import + packages 改用新函式。
- **Modify `tests/my-schedule-packages.test.js`**（Task 1，遷移）+ **`tests/my-schedule-packages-api.test.js`**（Task 1，遷移）。
- **Modify `public/my-schedule.js`**（Task 2）：卡片三數字。

---

### Task 1: 後端 listScheduleViewPackages + getPublicSchedule + 遷移測試

**Files:**
- Modify: `src/services/packageService.js`（行 83 後）
- Modify: `src/services/groupOrderService.js`（行 7 import；行 517–522 packages）
- Modify: `tests/my-schedule-packages.test.js`（整檔遷移）
- Modify: `tests/my-schedule-packages-api.test.js`（整檔遷移）

**Interfaces:**
- Consumes（既有）：`db`、`nowLocal`、`bookings.package_id`、`createPackage`/`deductOne`/`archivePackage`（測試用）。
- Produces：`listScheduleViewPackages(memberId, now)` → `[{ session_type, total_sessions, completed_sessions, remaining_sessions, expires_at }]`（remaining_sessions＝total−completed）。

- [ ] **Step 1：遷移單元測試（先失敗）— 整檔覆寫 `tests/my-schedule-packages.test.js`**

```js
// getPublicSchedule.packages：方案顯示到「課全上完」才消失；投影 共/已上完/尚餘(=共-已上完)、安全欄位。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { createPackage, deductOne, archivePackage } = await import('../src/services/packageService.js');
const { getPublicSchedule } = await import('../src/services/groupOrderService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[my-schedule-packages test] start');
const clean=()=>db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'msp-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'msp-%'); DELETE FROM users WHERE email LIKE 'msp-%'");
clean();
const coachId = db.prepare('SELECT id FROM coaches ORDER BY id LIMIT 1').get().id;
const PAST='2020-01-01T10:00:00', PASTE='2020-01-01T11:00:00';
const FUT='2099-01-01T10:00:00', FUTE='2099-01-01T11:00:00';
const mkUser=()=>Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','msp-m@x.com','user','0994000001')").run().lastInsertRowid);
const mkBooking=(m,pkg,s,e,st='confirmed')=>db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id) VALUES (?,?,?,?,?,?,?)").run(coachId,m,s,e,st,'1on1',pkg);
const sched=()=>getPublicSchedule({ phone:'0994000001', name:'方案客' });

expect('無方案 → packages 為 []', () => { mkUser(); assert.deepEqual(sched().packages, []); });

expect('全部登錄完但課在未來 → 仍顯示、已上完0、尚餘=總、安全欄位', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:4, expiresAt:'2099-12-31' });
  for(let i=0;i<4;i++){ deductOne(p.id); mkBooking(u,p.id,FUT,FUTE); } // remaining=0, 4 未來課
  const pk=sched().packages;
  assert.equal(pk.length,1);
  assert.equal(pk[0].total_sessions,4);
  assert.equal(pk[0].completed_sessions,0);
  assert.equal(pk[0].remaining_sessions,4);
  assert.equal(pk[0].expires_at,'2099-12-31');
  assert.ok(!('amount' in pk[0]) && !('id' in pk[0]) && !('member_id' in pk[0]) && !('used_sessions' in pk[0]) && !('discount_code' in pk[0]));
});

expect('部分已上完 → completed/尚餘正確', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:10 });
  for(let i=0;i<3;i++){ deductOne(p.id); mkBooking(u,p.id,PAST,PASTE); } // 3 已上完
  for(let i=0;i<2;i++){ deductOne(p.id); mkBooking(u,p.id,FUT,FUTE); }   // 2 待上
  const pk=sched().packages[0];
  assert.equal(pk.total_sessions,10);
  assert.equal(pk.completed_sessions,3);
  assert.equal(pk.remaining_sessions,7);
});

expect('全部已上完 → 不出現（已結束）', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:2 });
  for(let i=0;i<2;i++){ deductOne(p.id); mkBooking(u,p.id,PAST,PASTE); }
  assert.deepEqual(sched().packages, []);
});

expect('過期但有未來課→顯示；過期且無未來課→不顯示', () => {
  clean(); const u=mkUser();
  const ewf=createPackage({ memberId:u, sessionType:'1on1', totalSessions:5, expiresAt:'2000-01-01' });
  deductOne(ewf.id); mkBooking(u,ewf.id,FUT,FUTE);
  createPackage({ memberId:u, sessionType:'1on2', totalSessions:5, expiresAt:'2000-01-01' }); // 過期無未來課
  const pk=sched().packages;
  assert.equal(pk.length,1);
  assert.equal(pk[0].session_type,'1on1');
});

expect('取消的預約不計；作廢方案不出現', () => {
  clean(); const u=mkUser();
  const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:3 });
  deductOne(p.id); mkBooking(u,p.id,FUT,FUTE,'confirmed'); // 1 待上
  mkBooking(u,p.id,FUT,FUTE,'cancelled');                  // 取消不計
  const arch=createPackage({ memberId:u, sessionType:'1on2', totalSessions:5 }); archivePackage(arch.id);
  const pk=sched().packages;
  assert.equal(pk.length,1);
  assert.equal(pk[0].completed_sessions,0);
  assert.equal(pk[0].remaining_sessions,3);
});

clean();
console.log('[my-schedule-packages test] done');
```

- [ ] **Step 2：跑單元測試確認失敗**

Run: `node tests/my-schedule-packages.test.js`
Expected: FAIL — getPublicSchedule 仍回舊投影（無 `completed_sessions`、含 `used_sessions`），多條 ✗。

- [ ] **Step 3：實作 `listScheduleViewPackages`（packageService.js 行 83 後）**

```js
/**
 * 我的課表顯示用：方案持續顯示直到所有課上完(已結束)。
 * now = 'YYYY-MM-DDTHH:MM:SS'。completed=該方案 confirmed 且 start_at<now；upcoming=confirmed 且 start_at>=now。
 * 顯示條件：upcoming>0 或 (remaining_sessions>0 且未過期)。投影 remaining_sessions=total−completed(尚餘)。
 */
export function listScheduleViewPackages(memberId, now) {
  const today = String(now).slice(0, 10);
  const pkgs = db.prepare(
    `SELECT * FROM customer_packages
      WHERE member_id = ? AND archived_at IS NULL
      ORDER BY (expires_at IS NULL) ASC, expires_at ASC, created_at ASC`
  ).all(memberId);
  if (!pkgs.length) return [];
  const counts = db.prepare(
    `SELECT package_id,
            SUM(CASE WHEN start_at <  ? THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN start_at >= ? THEN 1 ELSE 0 END) AS upcoming
       FROM bookings
      WHERE member_id = ? AND status = 'confirmed' AND package_id IS NOT NULL
      GROUP BY package_id`
  ).all(now, now, memberId);
  const byPkg = new Map(counts.map((c) => [c.package_id, c]));
  const out = [];
  for (const p of pkgs) {
    const c = byPkg.get(p.id) || { completed: 0, upcoming: 0 };
    const expired = p.expires_at && p.expires_at < today;
    if (!(c.upcoming > 0 || (p.remaining_sessions > 0 && !expired))) continue;
    out.push({
      session_type: p.session_type,
      total_sessions: p.total_sessions,
      completed_sessions: c.completed,
      remaining_sessions: p.total_sessions - c.completed,
      expires_at: p.expires_at,
    });
  }
  return out;
}
```

- [ ] **Step 4：改 `getPublicSchedule`（groupOrderService.js）**

行 7 import 改為：
```js
import { listScheduleViewPackages } from './packageService.js';
```
行 517–522 的 `const packages = listValidPackagesForMember(...).map(...)` 整段改為：
```js
  const packages = listScheduleViewPackages(user.id, now);
```

- [ ] **Step 5：跑單元測試確認通過**

Run: `node tests/my-schedule-packages.test.js`
Expected: PASS（全 ✓）。

- [ ] **Step 6：遷移 api 測試 — 整檔覆寫 `tests/my-schedule-packages-api.test.js`**

```js
// API：POST /api/public/my 回 packages（顯示到課全上完；投影 共/已上完/尚餘(=共-已上完)）。需 running server。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createPackage, deductOne } from '../src/services/packageService.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body}={}){const r=await fetch(BASE+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[my-schedule-packages-api] start');
const clean=()=>db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'mspa-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'mspa-%'); DELETE FROM users WHERE email LIKE 'mspa-%'");
clean();
const coachId=db.prepare('SELECT id FROM coaches ORDER BY id LIMIT 1').get().id;
const u=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','mspa-m@x.com','user','0995000001')").run().lastInsertRowid);
const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:6, amount:9000 });
const mkB=(s,e)=>db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id) VALUES (?,?,?,?,?,?,?)").run(coachId,u,s,e,'confirmed','1on1',p.id);
deductOne(p.id); mkB('2020-01-01T10:00:00','2020-01-01T11:00:00'); // 1 已上完
deductOne(p.id); mkB('2099-01-01T10:00:00','2099-01-01T11:00:00'); // 1 待上
const r=await req('POST','/api/public/my',{body:{phone:'0995000001',name:'方案客'}});
expect('回 packages：共6/已上完1/尚餘5、不含 amount/used_sessions',()=>{
  assert.equal(r.status,200);
  assert.ok(Array.isArray(r.data.packages) && r.data.packages.length===1);
  const pk=r.data.packages[0];
  assert.equal(pk.total_sessions,6);
  assert.equal(pk.completed_sessions,1);
  assert.equal(pk.remaining_sessions,5);
  assert.ok(!('amount' in pk) && !('used_sessions' in pk));
});
clean();
console.log('[my-schedule-packages-api] done');
```

- [ ] **Step 7：重啟 server 後跑 api 測試**

Node 無熱重載：`pkill -f 'node src/server.js'; sleep 1; PORT=3000 node src/server.js & sleep 2`（若無 admin/seed 先 `node src/db/seed-demo.js`）。
Run: `node tests/my-schedule-packages-api.test.js`
Expected: PASS（全 ✓）。
> 注意：跑測試會動到本機 `data/app.db`；smoke 前需重新 `node src/db/seed-demo.js`。

- [ ] **Step 8：Commit**

```bash
git add src/services/packageService.js src/services/groupOrderService.js tests/my-schedule-packages.test.js tests/my-schedule-packages-api.test.js
git commit -m "feat: 我的方案顯示到課全上完才消失（listScheduleViewPackages，投影 共/已上完/尚餘）"
```

---

### Task 2: 前端 卡片三數字

**Files:**
- Modify: `public/my-schedule.js`（render 方案卡片，行 ~362、376–386）

**Interfaces:**
- Consumes：新投影 `{ total_sessions, completed_sessions, remaining_sessions, expires_at, session_type }`（Task 1）。

- [ ] **Step 1：改卡片渲染**

把 `public/my-schedule.js` 方案卡片區塊：
```js
          const total = p.total_sessions, used = p.used_sessions, remain = p.remaining_sessions;
          const pct = total > 0 ? Math.round((used / total) * 100) : 0;
          const exp = p.expires_at ? ` · 到期 ${escapeHtml(String(p.expires_at)).replace(/-/g, '/')}` : '';
          return `<div class="pk-card">
            <div class="pk-main">
              <div class="pk-type">${t}</div>
              <div class="pk-meta">已登錄 ${used} · 共 ${total} 堂${exp}</div>
              <div class="pk-bar"><div class="pk-bar-fill" style="width:${pct}%"></div></div>
            </div>
            <div class="pk-remain"><span class="pk-rtop">剩餘</span><span class="pk-rnum">${remain}</span><span class="pk-rlabel">堂</span></div>
          </div>`;
```
改為：
```js
          const total = p.total_sessions, completed = p.completed_sessions, remain = p.remaining_sessions;
          const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
          const exp = p.expires_at ? ` · 到期 ${escapeHtml(String(p.expires_at)).replace(/-/g, '/')}` : '';
          return `<div class="pk-card">
            <div class="pk-main">
              <div class="pk-type">${t}</div>
              <div class="pk-meta">已上完 ${completed} · 共 ${total} 堂${exp}</div>
              <div class="pk-bar"><div class="pk-bar-fill" style="width:${pct}%"></div></div>
            </div>
            <div class="pk-remain"><span class="pk-rtop">尚餘</span><span class="pk-rnum">${remain}</span><span class="pk-rlabel">堂</span></div>
          </div>`;
```
並把該區塊上方註解（行 ~362）「Archivo 大字剩餘數 + 已登錄/共」更新為「Archivo 大字尚餘數 + 已上完/共（顯示到課全上完）」。

- [ ] **Step 2：語法檢查**

Run: `node --check public/my-schedule.js`
Expected: 無輸出、exit 0。

- [ ] **Step 3：Commit**

```bash
git add public/my-schedule.js
git commit -m "feat: 我的方案卡片改三數字（已上完/共/尚餘）"
```

---

## 驗證（控制者親跑，非 subagent 任務）
1. `node src/db/seed-demo.js` →（重啟 server）→ `node tests/my-schedule-packages.test.js` 與 `node tests/my-schedule-packages-api.test.js`（全 ✓）；`npm test` 綠燈。再 `node src/db/seed-demo.js` 還原。
2. 瀏覽器 smoke（建客人+方案→登錄數堂「未來」課→我的課表查詢）：方案仍在、已上完0/共N/尚餘N；把一堂改成過去(或等時間)→已上完+1、尚餘−1；全部課變過去→方案消失。後台登錄選方案仍只列 remaining>0 者（不受影響）。控制台無錯誤。
> 無前端測試框架；後端以上述遷移測試覆蓋。

## 不做（YAGNI）
- 不改嚴格 `listValidPackagesForMember` 與登錄/改方案/扣抵；無 schema 變更；不加「已結束方案」歷史清單。
