# 過去「未開課」場次可補報名（補報即復活）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理者可在「過去、被判未開課(cancelled)」的團課場次補報名；首筆補報成功即把場次復活為「已成班」(confirmed)，薪資／客人統計／公開頁三口徑自然導出。未來的未開課維持 409。

**Architecture:** 後端只動 `adminBackfillRegistration` 兩處（擋點放寬＋成功後復活 UPDATE，同交易內）；前端 `admin.js` 五處小改（按鈕條件／meta 存 status／hint 分支／成功後就地換徽章／錯誤文案）。薪資（`payrollService` 排除 cancelled）、客人已上課統計、公開頁 state 推導全都依 `course_sessions.status` 自然放行，**零改動**。

**Tech Stack:** Node ESM + node:sqlite（DatabaseSync）、Express、vanilla JS 前端、plain-node assert 測試腳本。

**Spec:** `docs/superpowers/specs/2026-07-13-backfill-not-held-revive-design.md`（業主已核可）
**Branch:** `feature/backfill-not-held-revive`（已存在，spec 已 commit `f26609b`，base = main `2a81cbf`）

## Global Constraints

- 所有時間比較用 `nowLocal()` 回傳的 `YYYY-MM-DDTHH:MM:SS` 字串做字典序比較；service 內禁用 `Date`／UTC（測試 fixture 可用 `Date` 算相對日期，比照既有測試）。
- 錯誤一律 `throw new ApiError(status, 'code')`，code 會同時出現在 `e.message` 與 API 回應 `{error: code}`。
- 使用者可見文案一律繁體中文。
- 測試是 plain node 腳本：`node tests/<file>.test.js`，`✗` 時 `process.exitCode=1`。**跑測試一律用 fresh DB**：`DB_PATH="$(mktemp -d)/t.db" node tests/<file>.test.js`（絕不能對 `data/app.db` 跑，會清掉 demo 資料）。
- 每個 commit 訊息結尾加：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- `course_sessions.status` 值域：`open / confirmed / cancelled / completed`（`completed` 無任何寫入點，勿使用）。復活**只能設 `confirmed`**，設回 `open` 會被下一輪 `processDeadlines`（撈 `status='open' AND registration_deadline <= now`）再判死。

---

### Task 1: 後端「補報即復活」＋ service 測試 §7

**Files:**
- Modify: `src/services/groupOrderService.js`（`adminBackfillRegistration`，約 438–515 行）
- Test: `tests/admin-group-reg.test.js`（imports、`reset()`、檔尾新增 §7）

**Interfaces:**
- Consumes: 既有 `adminBackfillRegistration({sessionId,userId,name,phone,paid,actorId})`、`adminCancelRegistration({registrationId,actorId})`、`getPublicGroupCourses()`、`computePayroll({period})`（皆已存在，簽名不變）。
- Produces: 行為變更——過去 cancelled 場次補報回 `{ok,registrationId,orderId,status}` 且場次 status 變 `confirmed`；未來 cancelled 維持 throw `ApiError(409,'session_cancelled')`。Task 2/3 依賴此行為。

- [ ] **Step 1: 寫失敗測試（§7）**

`tests/admin-group-reg.test.js` 三處修改。

(1) import 區——把 `getPublicGroupCourses` 加進 groupOrderService import、新增 payroll import：

```js
// 原：
import {
  createGroupOrder, confirmGroupOrder, refundGroupOrder, promoteWaitlist, sessionOccupied,
  adminBackfillRegistration, adminCancelRegistration,
} from '../src/services/groupOrderService.js';
import { listConfirmedPayments } from '../src/services/bookingService.js';
// 改為：
import {
  createGroupOrder, confirmGroupOrder, refundGroupOrder, promoteWaitlist, sessionOccupied,
  adminBackfillRegistration, adminCancelRegistration, getPublicGroupCourses,
} from '../src/services/groupOrderService.js';
import { listConfirmedPayments } from '../src/services/bookingService.js';
import { computePayroll } from '../src/services/payrollService.js';
```

(2) `reset()`——users 刪除前先清本測試建立的教練（否則 coaches.user_id FK 擋刪）：

```js
// 原（reset() 內最後兩行）：
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%');
    DELETE FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%';
// 改為：
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%');
    DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%');
    DELETE FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%';
```

(3) 檔尾 `console.log('[admin-group-reg test] done');` **之前**插入整節 §7（電話段 `0996 7xxxxx`，與 §2–§6 不撞）：

```js
// ── §7 過去未開課場次補登（補報即復活）────────────────────────
reset();
{
  // 佈景：cycle +1..+20 天、每週一場 → 3 場（約 +2/+9/+16）。
  // s1 → 過去＋cancelled（主角）；s2 → 未來＋cancelled（409 對照）；s3 維持未來 open（讓範本仍出現在公開頁）。
  const tpl = createTemplate({
    name: 'AGR-復活班', min_capacity: 1, max_capacity: 3,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(20),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const [s1, s2] = ss;
  agePast(s1);
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id IN (?, ?)").run(s1, s2);
  const actorId = Number(db.prepare("INSERT INTO users (name, role) VALUES ('AGR-操作者', 'user')").run().lastInsertRowid);
  const sessionStatus = (id) => db.prepare('SELECT status FROM course_sessions WHERE id=?').get(id).status;
  const pubSession = (id) => {
    const t = getPublicGroupCourses().find((x) => x.id === tpl.templateId);
    return t ? t.sessions.find((x) => x.id === id) : null;
  };

  expect('未來的未開課場次補報 → 409 session_cancelled（paid/unpaid 皆擋）', () => {
    assert.throws(() => adminBackfillRegistration({ sessionId: s2, name: 'AGR-復活客', phone: '0996700001', paid: false, actorId }), /session_cancelled/);
    assert.throws(() => adminBackfillRegistration({ sessionId: s2, name: 'AGR-復活客', phone: '0996700001', paid: true, actorId }), /session_cancelled/);
  });

  expect('復活前：公開頁該場 state=not_held', () => {
    const s = pubSession(s1);
    assert.ok(s, '範本應仍在公開頁（s3 selectable）');
    assert.equal(s.state, 'not_held');
    assert.equal(s.selectable, false);
  });

  let r1;
  expect('過去未開課＋未付補報 → pending 單＋場次復活成已成班', () => {
    r1 = adminBackfillRegistration({ sessionId: s1, name: 'AGR-復活客', phone: '0996700001', paid: false, actorId });
    assert.equal(r1.status, 'pending');
    assert.ok(r1.orderId);
    assert.equal(sessionStatus(s1), 'confirmed');
    const o = db.prepare('SELECT status, total_amount FROM group_orders WHERE id=?').get(r1.orderId);
    assert.equal(o.status, 'pending');
    assert.equal(o.total_amount, 500);
  });

  expect('復活後：公開頁該場 state=ended（非 not_held、不可選）', () => {
    const s = pubSession(s1);
    assert.equal(s.state, 'ended');
    assert.equal(s.selectable, false);
  });

  expect('取消唯一一筆補報 → 整單取消、場次維持已成班不回退', () => {
    adminCancelRegistration({ registrationId: r1.registrationId, actorId });
    assert.equal(db.prepare('SELECT status FROM group_orders WHERE id=?').get(r1.orderId).status, 'cancelled');
    assert.equal(sessionStatus(s1), 'confirmed');
  });
}

// ── §7b 原 rejected 客人重補（同列 reactivate）＋已收款補報計入薪資 ──
{
  const coachUserId = Number(db.prepare("INSERT INTO users (name, role) VALUES ('AGR-教練', 'coach')").run().lastInsertRowid);
  const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'AGR-教練', 1)").run(coachUserId).lastInsertRowid);
  const tpl = createTemplate({
    name: 'AGR-薪資班', min_capacity: 1, max_capacity: 3,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(8),
    registration_deadline_hours: 1, price_per_session: 600, coach_id: coachId,
  });
  const sid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').get(tpl.templateId).id;
  // 客人先正常報名（pending），再模擬 processDeadlines 判未開課：reg→rejected、場次 cancelled。
  // 場次改「固定過去日」2020-01-10 → 薪資期別 2020-02（2020-01-06 ~ 2020-02-06）可做確定性斷言。
  const oC = createGroupOrder({ name: 'AGR-丙', phone: '0996700002', paySessionIds: [sid], waitlistSessionIds: [] });
  const oldRegId = db.prepare('SELECT id FROM registrations WHERE session_id=? AND user_id=?').get(sid, oC.memberId).id;
  db.prepare("UPDATE registrations SET status='rejected' WHERE id=?").run(oldRegId);
  db.prepare("UPDATE course_sessions SET session_date='2020-01-10', start_at='2020-01-10T19:00:00', end_at='2020-01-10T20:00:00', registration_deadline='2020-01-10T18:00:00', status='cancelled' WHERE id=?").run(sid);

  let r;
  expect('原 rejected 客人已收款補報 → 同列 reactivate＋confirmed＋獨立已核對單＋復活', () => {
    r = adminBackfillRegistration({ sessionId: sid, userId: oC.memberId, paid: true, actorId: oC.memberId });
    assert.equal(r.registrationId, oldRegId);   // 同一列復原，不重複列（UNIQUE(session_id,user_id)）
    assert.equal(r.status, 'confirmed');
    assert.notEqual(r.orderId, oC.orderId);     // 獨立 paid 單，不掛回原 pending 單
    const o = db.prepare('SELECT status, paid_at FROM group_orders WHERE id=?').get(r.orderId);
    assert.equal(o.status, 'paid');
    assert.ok(o.paid_at);
    assert.equal(db.prepare('SELECT status FROM course_sessions WHERE id=?').get(sid).status, 'confirmed');
  });

  expect('復活場次計入薪資（期別 2020-02：headcount 1、revenue 600、明細含該場）', () => {
    const pr = computePayroll({ period: '2020-02' });
    const c = pr.coaches.find((x) => x.coachId === coachId);
    assert.ok(c, '教練應出現在薪資清單');
    assert.equal(c.group.headcount, 1);
    assert.equal(c.group.revenue, 600);
    assert.ok(c.group.details.some((d) => d.sessionId === sid));
  });
}
```

- [ ] **Step 2: 跑測試確認紅**

```bash
cd ~/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/admin-group-reg.test.js
```

預期：§1–§6 全 ✓；§7 中「未來 409」「復活前 not_held」✓（既有行為），其餘 5 個 ✗（`session_cancelled` 被 throw / r1 undefined 連鎖）。exit code 非 0。

- [ ] **Step 3: 實作（`src/services/groupOrderService.js` 四處）**

(1) JSDoc 補一行（函式上方註解塊）：

```js
// 原：
 *  不支援折扣碼；只通知教練（業主定案）。 */
// 改為：
 *  不支援折扣碼；只通知教練（業主定案）。
 *  未開課(cancelled)：過去場次可補登，首筆成功即復活為「已成班」（薪資/統計/公開頁自然導出）；未來維持 409。 */
```

(2) 擋點放寬（注意：`if (s.status === 'cancelled') throw ...` 這行在檔內不唯一，old_string 必須帶下面完整四行上下文）：

```js
// 原：
    const s = getSession.get(sessionId);
    if (!s) throw new ApiError(404, 'session_not_found');
    if (s.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
    const tpl = getTemplate.get(s.template_id);
// 改為：
    const s = getSession.get(sessionId);
    if (!s) throw new ApiError(404, 'session_not_found');
    const now = nowLocal();
    // 未開課場次：過去可補登（補報即復活，見下）；未來維持不可補（業主定案：流課是未知數，要等時間過了才知道）
    if (s.status === 'cancelled' && s.start_at > now) throw new ApiError(409, 'session_cancelled');
    const tpl = getTemplate.get(s.template_id);
```

(3) 移除後面重複的 `now` 宣告（`now` 已提前到擋點，擋點與 `isPast` 用同一瞬間）：

```js
// 原：
    const now = nowLocal();
    const isPast = s.start_at <= now;
    const price = tpl.price_per_session;
// 改為：
    const isPast = s.start_at <= now;
    const price = tpl.price_per_session;
```

(4) 主路徑建立報名後、通知前，插入復活 UPDATE（同交易內，原子）：

```js
// 原：
    let regId;
    if (dup) { reactivateReg.run(regStatus, orderId, price, dup.id); regId = dup.id; }
    else regId = insertReg.run(sessionId, user.id, regStatus, orderId, price).lastInsertRowid;

    notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_registered_coach',
// 改為：
    let regId;
    if (dup) { reactivateReg.run(regStatus, orderId, price, dup.id); regId = dup.id; }
    else regId = insertReg.run(sessionId, user.id, regStatus, orderId, price).lastInsertRowid;

    // 補報即復活：原判未開課的過去場次，首筆補報成功即恢復「已成班」——薪資/客人統計/公開頁三口徑自然導出
    if (s.status === 'cancelled') db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(sessionId);

    notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_registered_coach',
```

注意：滿額候補分支（waitlisted）在此之前已 return——但過去的 cancelled 場次原報名全是 `rejected`（不佔名額），首筆補報不可能滿額，不會走到候補分支；不需在候補分支加復活。

- [ ] **Step 4: 跑測試確認綠**

```bash
cd ~/projects/chinup-fitness-system && DB_PATH="$(mktemp -d)/t.db" node tests/admin-group-reg.test.js
```

預期：全部 ✓（§1–§6 共 34＋§7 共 7），exit code 0。

- [ ] **Step 5: 跑鄰近受影響套件（fresh DB）**

```bash
cd ~/projects/chinup-fitness-system && D="$(mktemp -d)" && \
DB_PATH="$D/a.db" node tests/group-public-past.test.js && \
DB_PATH="$D/b.db" node tests/group-order-service.test.js && \
DB_PATH="$D/c.db" node tests/payroll-service.test.js
```

預期：全 ✓。（`getPublicGroupCourses`／payroll 皆零改動，此步是回歸保險。）

- [ ] **Step 6: Commit**

```bash
cd ~/projects/chinup-fitness-system && git add src/services/groupOrderService.js tests/admin-group-reg.test.js && git commit -m "feat: 過去未開課場次可補報名，首筆補報即復活為已成班

- adminBackfillRegistration 擋點放寬：cancelled 僅未來場次 409
- 首筆補報成功後同交易內 cancelled→confirmed（薪資/統計/公開頁自然導出）
- 測試 §7：未付/已收款補登、未來 409、rejected 同列 reactivate、取消不回退、公開頁 ended、薪資計入

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: API 整合測試延伸（無程式改動）

**Files:**
- Test: `tests/admin-group-reg-api.test.js`（73 行的小檔；在「// 收尾：刪測試範本」區塊**之前**插入）

**Interfaces:**
- Consumes: Task 1 的後端行為；既有路由 `POST /api/admin/sessions/:id/registrations`（requireAdmin，路由層零改動）。檔內既有 `req()`/`expect()`/`dstr()`/`cleanup()`/`token`/`tpl`（範本 cycle `dstr(1)..dstr(20)` 每週一場 → 恆為 3 場，`sessions[0]` 已被既有測試用掉，`[1]`/`[2]` 空著）。
- Produces: HTTP 層驗證——過去 cancelled 201＋復活、未來 cancelled 409。

前置：server 需在 :3000 跑著（mock 模式、對 `data/app.db`，其 seed 有 `admin@chinup.local`）。確認：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN || (cd ~/projects/chinup-fitness-system && LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 nohup node src/server.js > /tmp/chinup-server.log 2>&1 & sleep 1 && lsof -nP -iTCP:3000 -sTCP:LISTEN)
```

- [ ] **Step 1: 插入測試（紅相已在 Task 1 service 層驗過，此處為綠相整合驗證）**

在 `expect('roster 顯示已取消', ...)` 之後、`// 收尾：刪測試範本` 之前插入：

```js
// 過去未開課補登（補報即復活）＋未來未開課仍 409
const sidPast = tpl.data.sessions[1].id;
const sidFuture = tpl.data.sessions[2].id;
db.prepare("UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=?, status='cancelled' WHERE id=?")
  .run(dstr(-3), `${dstr(-3)}T19:00:00`, `${dstr(-3)}T20:00:00`, `${dstr(-3)}T18:00:00`, sidPast);
db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id=?").run(sidFuture);

const revive = await req('POST', `/api/admin/sessions/${sidPast}/registrations`, { token, body: { name: 'AGRAPI復活客', phone: '0995000002', paid: true } });
expect('過去未開課補登 → 201 confirmed', () => { assert.equal(revive.status, 201); assert.equal(revive.data.status, 'confirmed'); });
expect('場次復活成已成班', () => assert.equal(db.prepare('SELECT status FROM course_sessions WHERE id=?').get(sidPast).status, 'confirmed'));

const futureCancelled = await req('POST', `/api/admin/sessions/${sidFuture}/registrations`, { token, body: { name: 'AGRAPI復活客', phone: '0995000002', paid: false } });
expect('未來未開課補報 → 409 session_cancelled', () => { assert.equal(futureCancelled.status, 409); assert.equal(futureCancelled.data.error, 'session_cancelled'); });
```

（`0995000002` 已被檔頭/檔尾 `cleanup()` 的 `phone LIKE '0995%'` 涵蓋；範本收尾會整個刪掉，場次狀態不留殘。）

- [ ] **Step 2: 跑 API 測試**

```bash
cd ~/projects/chinup-fitness-system && node tests/admin-group-reg-api.test.js
```

預期：既有 11 個 ✓＋新 3 個 ✓，exit code 0。

- [ ] **Step 3: Commit**

```bash
cd ~/projects/chinup-fitness-system && git add tests/admin-group-reg-api.test.js && git commit -m "test: API 驗過去未開課補登 201＋復活、未來未開課 409

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 前端 drawer（按鈕／hint／徽章就地復活／文案）

**Files:**
- Modify: `public/admin.js`（五處：約 360、368、448–449、477–480、530–537 行）

**Interfaces:**
- Consumes: Task 1 的後端行為；既有 `drawerSessions` Map、`localNowStr()`、`SESSION_STATUS_LABEL`、`refreshSessionSummary(sid)`。`getTemplate` 的 sessions 已含 `status`/`start_at` 欄位（零後端改動）。
- Produces: 純 UI；無他人依賴。

- [ ] **Step 1: 五處編輯**

(1) drawer 場次 map 多存 `status`：

```js
// 原：
      drawerSessions.set(s.id, { start_at: s.start_at, occupied: s.occupied, max: t.max_capacity });
// 改為：
      drawerSessions.set(s.id, { start_at: s.start_at, occupied: s.occupied, max: t.max_capacity, status: s.status });
```

(2) 補報名鈕條件——非 cancelled 照舊；cancelled 只在「已過場」顯示：

```js
// 原：
            ${s.status !== 'cancelled' ? `<button type="button" class="badge badge-confirmed session-backfill" data-session-id="${s.id}" title="為客人補此場報名">補報名</button>` : ''}
// 改為：
            ${(s.status !== 'cancelled' || s.start_at <= localNowStr()) ? `<button type="button" class="badge badge-confirmed session-backfill" data-session-id="${s.id}" title="為客人補此場報名">補報名</button>` : ''}
```

(3) `openBackfillPanel` 加 `isCancelled`：

```js
// 原：
  const isPast = meta.start_at ? meta.start_at <= localNowStr() : false;
  const isFull = meta.occupied >= meta.max;
// 改為：
  const isPast = meta.start_at ? meta.start_at <= localNowStr() : false;
  const isFull = meta.occupied >= meta.max;
  const isCancelled = meta.status === 'cancelled';
```

(4) hint 分支——cancelled 優先（按鈕守門保證此時必為過去場；原報名全 rejected 不佔額，不會同時滿額）：

```js
// 原：
  if (isFull && isPast) { hint.textContent = '此場已滿且已結束，無法補報名。'; submitBtn.disabled = true; }
  else if (isFull) { hint.textContent = '此場已滿：送出後將列為候補（不收款）。'; paidCb.checked = false; paidCb.disabled = true; }
  else if (isPast) { hint.textContent = '此場已結束：補登歷史報名。'; }
// 改為：
  if (isCancelled) { hint.textContent = '此場原判未開課：補報名成功後將恢復為「已成班」（計入薪資與上課統計）。'; }
  else if (isFull && isPast) { hint.textContent = '此場已滿且已結束，無法補報名。'; submitBtn.disabled = true; }
  else if (isFull) { hint.textContent = '此場已滿：送出後將列為候補（不收款）。'; paidCb.checked = false; paidCb.disabled = true; }
  else if (isPast) { hint.textContent = '此場已結束：補登歷史報名。'; }
```

(5) 送出成功後就地復活徽章（`meta` 在 closure 內可用），並改錯誤文案：

```js
// 原：
      panel.remove();
      await reloadRoster(sid);
      refreshSessionSummary(sid);
      loadPendingOrders(); loadConfirmedPayments();
// 改為：
      panel.remove();
      await reloadRoster(sid);
      refreshSessionSummary(sid);
      if (meta.status === 'cancelled') { // 補報即復活：就地把「未開課」徽章換成「已成班」
        meta.status = 'confirmed';
        const badge = document.querySelector(`#drawer-content .session-backfill[data-session-id="${sid}"]`)?.parentElement?.querySelector('.badge-cancelled');
        if (badge) { badge.classList.replace('badge-cancelled', 'badge-confirmed'); badge.textContent = SESSION_STATUS_LABEL.confirmed; }
      }
      loadPendingOrders(); loadConfirmedPayments();
```

```js
// 原（同 catch 區塊 msgs 表內）：
session_cancelled: '未開課場次不可補報名',
// 改為：
session_cancelled: '未開課場次需過了上課時間才能補登',
```

- [ ] **Step 2: 語法檢查＋grep 驗證**

```bash
cd ~/projects/chinup-fitness-system && node --check public/admin.js && grep -c "isCancelled" public/admin.js
```

預期：`node --check` 無輸出（過）；grep 計數 = 2（宣告＋hint 分支）。

- [ ] **Step 3: Commit**

```bash
cd ~/projects/chinup-fitness-system && git add public/admin.js && git commit -m "feat: drawer 過去未開課場次顯示補報名鈕＋復活 hint／徽章就地更新

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

（瀏覽器手動驗證由 controller 於整分支終審前接手：未開課過去場出現補報名鈕、hint 文案、成功後徽章「未開課」→「已成班」、counts 刷新、未來未開課無鈕。）
