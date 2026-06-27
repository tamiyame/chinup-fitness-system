# 方案作廢連動取消預約 + 編輯預約來源顯示方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 方案作廢時連動取消其名下所有未取消預約；編輯預約彈窗的「來源」詳列是哪一個方案。

**Architecture:** 後端 `packageService.archivePackage` 改為交易內作廢 + inline SQL 連動取消（不依賴 bookingService，避免循環依賴），route 端逐筆 `syncBookingCancel` 刪日曆；`coachCalendarService` 的 week 查詢 LEFT JOIN `customer_packages` 多帶方案欄位，前端據此組來源字串。

**Tech Stack:** Node.js ESM + Express + node:sqlite；vanilla JS 前端；自製 `expect(label, fn)` 測試 harness（`npm test`）。

## Global Constraints

- 回應一律繁體中文；技術識別字維持原樣。
- 連動取消：範圍＝該方案所有 `status='confirmed'` 預約（含過去）；**靜默**（不發通知）；**不回補堂數**；`cancel_reason='方案作廢連動取消'`、`cancelled_by=actorId`。
- 方案標示格式：`方案登錄 · {一對一/一對二} 剩{remaining}/{total} · 建立{yyyy/mm/dd} ·「{備註}」`；建立時間用 `customer_packages.created_at` 取 `slice(0,10)` 並把 `-` 換 `/`；備註/建立時間缺值各自省略；方案欄位缺失時回退「方案登錄」。
- `packageService` 不可 import `bookingService`（後者已反向 import 前者）。
- `npm test` 會清掉 `data/app.db` 的 demo 資料；測試用 email 前綴隔離自己的資料並自行清理。
- 不改 schema、不還原已連動取消的預約、不動 `/api/coach/me/bookings` 來源顯示。

---

### Task 1: 後端 — 作廢方案連動取消預約（service + route）

**Files:**
- Modify: `src/services/packageService.js`（`archivePackage` 改寫 + 2 個 prepared stmt）
- Modify: `src/server.js:850-852`（archive route 帶 `actorId` + `syncBookingCancel` 迴圈）
- Test: `tests/package-service.test.js`（擴充）、`tests/package-api.test.js`（擴充）

**Interfaces:**
- Consumes: 既有 `getPackage(id)`、`db`、`tx`、`nowLocal`、`ApiError`；route 端既有 `svcArchivePackage`、`syncBookingCancel`、`requireCoach`、`asyncHandler`。
- Produces: `archivePackage(packageId, actorId = null)` → `{ ...getPackage(packageId), cancelledBookingIds: number[] }`。

- [ ] **Step 1: 在 `tests/package-service.test.js` 末尾（`console.log('[package-service test] done')` 之前）加失敗測試**

需要一個教練（coach 表）以建立 booking。沿用檔案既有 `mid`（客人）、`admin`（管理者 user）。在測試區塊內自建 coach 與 bookings：

```js
expect('archivePackage：連動取消名下所有 confirmed 預約、不回補、回 cancelledBookingIds', () => {
  db.exec("DELETE FROM bookings WHERE member_id="+mid+"; DELETE FROM customer_packages WHERE member_id="+mid);
  const cu = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('pk教練','pk-coach@x.com','coach')").run().lastInsertRowid);
  const cid = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'pk-coach',1)").run(cu).lastInsertRowid);
  const pkg = createPackage({ memberId: mid, sessionType: '1on1', totalSessions: 10, createdBy: admin });
  // 兩筆 confirmed（一過去一未來）+ 一筆已 cancelled，全掛同方案
  const past = Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id) VALUES (?,?,?,?,'1on1',?)").run(cid,mid,'2000-01-01T09:00:00','2000-01-01T10:00:00',pkg.id).lastInsertRowid);
  const future = Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id) VALUES (?,?,?,?,'1on1',?)").run(cid,mid,'2099-01-01T09:00:00','2099-01-01T10:00:00',pkg.id).lastInsertRowid);
  const already = Number(db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id,status,cancelled_at) VALUES (?,?,?,?,'1on1',?, 'cancelled','2026-01-01T00:00:00')").run(cid,mid,'2099-02-01T09:00:00','2099-02-01T10:00:00',pkg.id).lastInsertRowid);
  const before = getPackage(pkg.id).remaining_sessions;
  const r = archivePackage(pkg.id, admin);
  assert.deepEqual([...r.cancelledBookingIds].sort((a,b)=>a-b), [past, future].sort((a,b)=>a-b));
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(past).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(future).status, 'cancelled');
  const fr = db.prepare('SELECT cancel_reason,cancelled_by FROM bookings WHERE id=?').get(future);
  assert.equal(fr.cancel_reason, '方案作廢連動取消');
  assert.equal(fr.cancelled_by, admin);
  assert.equal(getPackage(pkg.id).remaining_sessions, before); // 不回補
  assert.ok(getPackage(pkg.id).archived_at);
});

expect('archivePackage：冪等（再作廢回空）、不動其他方案、還原不復原預約', () => {
  const r2 = archivePackage(db.prepare("SELECT id FROM customer_packages WHERE member_id="+mid+" ORDER BY id DESC LIMIT 1").get().id, admin);
  assert.deepEqual(r2.cancelledBookingIds, []);
  // 還原後預約仍 cancelled
  const pid = db.prepare("SELECT id FROM customer_packages WHERE member_id="+mid+" ORDER BY id DESC LIMIT 1").get().id;
  restorePackage(pid);
  const stillCancelled = db.prepare("SELECT COUNT(*) n FROM bookings WHERE package_id=? AND status='confirmed'").get(pid).n;
  assert.equal(stillCancelled, 0);
});

expect('archivePackage：方案不存在 → 404', () => {
  assert.throws(() => archivePackage(999999, admin), /package_not_found/);
});
```

並在測試區塊結尾補清理：

```js
db.exec("DELETE FROM bookings WHERE member_id="+mid+"; DELETE FROM coaches WHERE display_name='pk-coach'; DELETE FROM users WHERE email='pk-coach@x.com'");
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/package-service.test.js` 或 `npm test 2>&1 | grep -A2 archivePackage`
Expected: 連動取消相關案例 `✗`（現行 `archivePackage` 不取消預約、回傳非物件含 cancelledBookingIds）。

- [ ] **Step 3: 改寫 `src/services/packageService.js` 的 `archivePackage`**

在檔案上方（其他 stmt 慣例處或 `archivePackage` 之前）加：

```js
const listConfirmedBookingsByPackageStmt = db.prepare(
  `SELECT id FROM bookings WHERE package_id = ? AND status = 'confirmed' ORDER BY id ASC`
);
const cancelBookingsByPackageStmt = db.prepare(
  `UPDATE bookings SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?
   WHERE package_id = ? AND status = 'confirmed'`
);
```

把 `archivePackage` 改成：

```js
export function archivePackage(packageId, actorId = null) {
  return tx(() => {
    const p = db.prepare('SELECT id FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    db.prepare('UPDATE customer_packages SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(nowLocal(), packageId);
    const cancelledBookingIds = listConfirmedBookingsByPackageStmt.all(packageId).map((r) => r.id);
    if (cancelledBookingIds.length) {
      cancelBookingsByPackageStmt.run(nowLocal(), actorId, '方案作廢連動取消', packageId);
    }
    return { ...getPackage(packageId), cancelledBookingIds };
  });
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/package-service.test.js`
Expected: 全 `✓`（含既有「有效判定：…作廢」案例仍通過——`archivePackage(arch.id)` 單參數呼叫不受影響）。

- [ ] **Step 5: 改 `src/server.js` archive route（含 actorId + 日曆同步）**

`src/server.js:850-852` 改為（守門改 `requireAdmin`，見對抗式審查結論；restore 對稱改）：

```js
app.post('/api/coach/packages/:id/archive', requireAdmin, asyncHandler((req, res) => {
  const r = svcArchivePackage(Number(req.params.id), req.user.id);
  for (const id of r.cancelledBookingIds) syncBookingCancel(id); // commit 後副作用：刪日曆事件、不 await
  res.json(r);
}));
```

審查強化：因作廢現在會「靜默、不可逆、跨教練」連動取消預約並刪日曆，archive/restore 守門由 `requireCoach` 改 `requireAdmin`（合法入口本就 admin-only，零 UX 影響）。package-api 加非 admin 教練 →403 回歸測試。

- [ ] **Step 6: 在 `tests/package-api.test.js` 加 API 層測試**

依該檔既有登入/建資料慣例（先讀檔頭看它怎麼建 coach/admin session 與發 request），加一案：建立方案→建一筆掛該方案的 confirmed booking→`POST /api/coach/packages/:id/archive`→斷言 200、回應含 `cancelledBookingIds` 含該 booking、DB 中該 booking 變 `cancelled`。

- [ ] **Step 7: 跑 API 測試確認通過**

Run: `node --test tests/package-api.test.js`
Expected: 全 `✓`。

- [ ] **Step 8: Commit**

```bash
git add src/services/packageService.js src/server.js tests/package-service.test.js tests/package-api.test.js
git commit -m "feat: 方案作廢連動取消名下所有未取消預約（靜默、不回補、刪日曆）"
```

---

### Task 2: 後端 — week 查詢帶出方案欄位

**Files:**
- Modify: `src/services/coachCalendarService.js`（`BK_COLS` + `weekBookings`/`weekAllBookings` 兩條 query 加 JOIN）
- Test: `tests/coach-week-all.test.js`（擴充）

**Interfaces:**
- Consumes: 既有 `getCoachWeek({ coachId, start, all })`。
- Produces: `getCoachWeek().bookings[i]` 多帶 `pkg_session_type`、`pkg_remaining`、`pkg_total`、`pkg_created_at`、`pkg_note`（非方案預約為 null）。

- [ ] **Step 1: 在 `tests/coach-week-all.test.js` 加失敗測試**

在既有兩筆 booking 後、清理前插入：建立一個 `customer_packages`（member=m）→建一筆掛該方案的 booking（coach=c1，本週時段）→斷言 `getCoachWeek({coachId:c1,start})` 找得到該 booking 且 `pkg_session_type/pkg_remaining/pkg_total/pkg_created_at/pkg_note` 正確；另斷言原本不掛方案的 booking 這些欄位為 `null`。

```js
expect('week：方案預約帶 pkg_* 欄位、非方案預約為 null', () => {
  const pid = Number(db.prepare("INSERT INTO customer_packages (member_id,session_type,total_sessions,remaining_sessions,note,created_at) VALUES (?, '1on1',10,7,'測試備註','2026-01-12 08:00:00')").run(m).lastInsertRowid);
  const d3=`${start}T11:00:00`;
  db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id) VALUES (?,?,?,?, '1on1', ?)").run(c1,m,d3,`${start}T12:00:00`,pid);
  const w=getCoachWeek({coachId:c1,start});
  const pb=w.bookings.find(b=>b.package_id===pid);
  assert.ok(pb);
  assert.equal(pb.pkg_session_type,'1on1');
  assert.equal(pb.pkg_remaining,7);
  assert.equal(pb.pkg_total,10);
  assert.equal(pb.pkg_created_at,'2026-01-12 08:00:00');
  assert.equal(pb.pkg_note,'測試備註');
  const nb=w.bookings.find(b=>b.package_id==null);
  assert.ok(nb);
  assert.equal(nb.pkg_session_type,null);
  assert.equal(nb.pkg_total,null);
});
```

（清理：檔尾既有 `DELETE FROM bookings …` 之外，補 `DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cw-%')`。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/coach-week-all.test.js`
Expected: 新案 `✗`（`pkg_*` undefined）。

- [ ] **Step 3: 改 `src/services/coachCalendarService.js`**

`BK_COLS` 改為：

```js
const BK_COLS = `b.id, b.coach_id, b.start_at, b.end_at, b.session_type, b.package_id, b.paid_at, b.discount_code,
       u.name AS member_name, c.display_name AS coach_name,
       cp.session_type AS pkg_session_type, cp.remaining_sessions AS pkg_remaining,
       cp.total_sessions AS pkg_total, cp.created_at AS pkg_created_at, cp.note AS pkg_note`;
```

`weekBookings` 與 `weekAllBookings` 的 FROM 子句各加一行 `LEFT JOIN customer_packages cp ON cp.id = b.package_id`：

```js
const weekBookings = db.prepare(`
  SELECT ${BK_COLS}
  FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id
  LEFT JOIN customer_packages cp ON cp.id = b.package_id
  WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekAllBookings = db.prepare(`
  SELECT ${BK_COLS}
  FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id
  LEFT JOIN customer_packages cp ON cp.id = b.package_id
  WHERE b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/coach-week-all.test.js`
Expected: 全 `✓`（既有三案不受影響）。

- [ ] **Step 5: Commit**

```bash
git add src/services/coachCalendarService.js tests/coach-week-all.test.js
git commit -m "feat: 登錄週曆預約帶出所屬方案欄位（pkg_*）供前端顯示來源"
```

---

### Task 3: 前端 — 作廢確認/toast + 編輯預約來源顯示方案

**Files:**
- Modify: `public/admin.js`（`renderMemberPackages` 的 archive 分支：confirm 文案 + 捕捉回傳 toast 筆數）
- Modify: `public/coach.js`（新增 `pkgSourceLabel` + 改 `renderBkeditBody` 第 756 行）

**Interfaces:**
- Consumes: Task 1 的 archive 回傳 `cancelledBookingIds`；Task 2 的 booking `pkg_*` 欄位；既有 `PKG_TYPE`、`escapeHtml`、`api`、`toast`。
- Produces: 純前端顯示，無下游程式依賴。

- [ ] **Step 1: 改 `public/admin.js` archive 分支**

把 `renderMemberPackages` 內：

```js
} else if (act === 'archive') {
  if (!confirm('確定作廢此方案？作廢後不可再扣抵（剩餘堂數保留紀錄）。')) return;
  await api(`/api/coach/packages/${id}/archive`, { method: 'POST' });
  toast('已作廢', 'success');
}
```

改為：

```js
} else if (act === 'archive') {
  if (!confirm('確定作廢此方案？此方案名下所有未取消的預約將一併取消（不可復原），剩餘堂數保留紀錄。')) return;
  const r = await api(`/api/coach/packages/${id}/archive`, { method: 'POST' });
  toast(r.cancelledBookingIds?.length ? `已作廢，連動取消 ${r.cancelledBookingIds.length} 筆預約` : '已作廢', 'success');
}
```

- [ ] **Step 2: 在 `public/coach.js` 新增 `pkgSourceLabel`（放 `renderBkeditBody` 上方）**

```js
function pkgSourceLabel(b) {
  if (!b.pkg_session_type) return '方案登錄';
  const t = PKG_TYPE[b.pkg_session_type] || b.pkg_session_type;
  const created = b.pkg_created_at ? ` · 建立${String(b.pkg_created_at).slice(0, 10).replace(/-/g, '/')}` : '';
  const note = b.pkg_note ? ` ·「${escapeHtml(b.pkg_note)}」` : '';
  return `方案登錄 · ${escapeHtml(t)} 剩${escapeHtml(String(b.pkg_remaining))}/${escapeHtml(String(b.pkg_total))}${created}${note}`;
}
```

- [ ] **Step 3: 改 `renderBkeditBody` 第 756 行來源邏輯**

```js
const source = b.package_id ? pkgSourceLabel(b) : (b.discount_code ? `折扣碼 ${escapeHtml(b.discount_code)}` : '一般預約');
```

- [ ] **Step 4: 全測試確認無回歸**

Run: `npm test`
Expected: 全綠（前端無自動化測試；本步只確認後端未回歸）。

- [ ] **Step 5: Commit**

```bash
git add public/admin.js public/coach.js
git commit -m "feat: 作廢方案確認/toast 連動取消筆數 + 編輯預約來源詳列所屬方案"
```

---

## Self-Review

- **Spec coverage**：功能一（service+route+admin.js+tests）= Task1+Task3；功能二（coachCalendarService+coach.js+tests）= Task2+Task3。涵蓋齊全。
- **Placeholder scan**：無 TBD/TODO；每步含實際程式碼或具體斷言。Task6 的 package-api 測試要求實作者先讀檔頭沿用既有 session 慣例（該檔案的登入輔助函式名因檔而異，故指示讀後沿用而非硬編一個可能錯的名字）。
- **Type consistency**：`archivePackage(packageId, actorId)` 回傳 `{...getPackage(), cancelledBookingIds}` 與 route/admin.js 使用一致；`pkg_*` 欄位名在 Task2 SQL、Task3 `pkgSourceLabel`、測試三處一致。
