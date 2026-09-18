# 一對二教練課「同行客人」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一對二教練課可選填第二位同行客人（姓名＋電話），兩位都能在我的課表查到同一筆預約、都能取消、都收會員端通知；三條入口（公開預約、教練登錄、後台編輯）都能填／改。

**Architecture:** `bookings` 加一欄 `member2_id`（同行客人 user id，可空、只限 1對2）；所有守則與通知鏡射集中在 `bookingService.js`（`resolveCompanion*`／`partyLabel`／`notifyCustomers` 三個小 helper）；讀模型（我的課表、週曆、待核對／已核對、gcal、email）各 LEFT JOIN 一次 `users u2` 取同行名；前端三個入口各加一個選填欄位／搜尋框。

**Tech Stack:** Node ESM + node:sqlite、Express、vanilla JS 前端、plain-node assert 測試（`expect(label, fn)` 慣例）。

**Spec:** `docs/superpowers/specs/2026-09-18-booking-companion-design.md`

## Global Constraints

- `bookings.member2_id INTEGER REFERENCES users(id)`（可空）；`schema.js` CREATE TABLE 加欄、`connection.js` `addColumnIfMissing('bookings', 'member2_id', 'INTEGER REFERENCES users(id)')`。只允許 `session_type = '1on2'` 有值。
- 錯誤碼（所有入口共用）：非 1對2 帶同行 → 400 `companion_not_allowed`；同行＝主客人（同 id 或同電話）→ 400 `companion_same_person`；同行 id 不存在或非 `user` → 404 `companion_not_found`；公開頁姓名／電話只填其一或電話格式不合 → 400 `invalid_companion`；員工電話 → 409 `phone_unavailable`（沿用 `findOrCreateUserByPhone`）。
- 會員端通知鏡射（主客人＋同行各一則）：`booking_confirmed`、`booking_rescheduled`、`booking_cancelled_by_coach`、`booking_cancelled_by_shop`、`booking_recurring_created`。只給主客人：`booking_payment_received`、`booking_refunded`、續購提醒。
- 新模板 `booking_cancelled_by_companion`（寄給另一位客人）：subject `同行取消預約 - {{coach_display_name}}`、body `⚠️ 您與 {{other_name}} 同行的 {{coach_display_name}} 教練課（{{start_at}}）已由 {{other_name}} 取消，此堂課不會進行。`；`lineNotifyPolicy` 歸入 `booking_cancel_member` 項目。
- 員工端通知的 `member_name`：有同行時為 `主客人＋同行`（全形 `＋`）——`booking_created`（教練＋管理者）、`booking_cancelled_by_shop_coach`、`booking_rescheduled_coach`、`booking_recurring_created_coach`；`booking_cancelled_by_member` 的 `member_name`＝取消者本人。
- 我的課表：查詢 `(member_id = ? OR member2_id = ?)`；每筆 booking 多回 `is_companion`（boolean）與 `companion_name`（**對方**的名字或 null）；`paid`／`can_cancel` 兩種身分同規則。
- 取消：`cancelBookingAnon` 擁有權為 `member_id` 或 `member2_id`；整筆取消、回補方案、釋放折扣；教練收 `booking_cancelled_by_member`（取消者名）、另一位客人收 `booking_cancelled_by_companion`。
- 顯示名：教練週曆名牌、編輯彈窗、後台待核對／已核對卡片、gcal summary（`1對2教練課 教練×主客人＋同行`）、email 確認信「同行客人」列。
- 單元測試一律 `DB_PATH="$(mktemp -d)/t.db"` 前綴，**絕不對 `data/app.db` 跑**；API 測試需 running server（實作者自起 port），跑完 `npm run seed`。
- 全程繁體中文註解與文案；commit 訊息繁體中文，結尾附兩行 trailer：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 與 `Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE`。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/db/schema.js`、`src/db/connection.js` | 新欄與遷移 |
| `src/services/bookingService.js` | 同行守則 helper、建立／取消／改期／改客人／登錄／設定同行、員工端名字標籤、通知鏡射 |
| `src/services/notifications.js`、`src/services/lineNotifyPolicy.js` | 新模板＋開關目錄 |
| `src/services/groupOrderService.js`（`getPublicSchedule`） | 我的課表兩種身分查詢 |
| `src/services/coachCalendarService.js`、`bookingService.js` 三個列表、`gcalSync.js`、`emailService.js` | 讀模型帶同行名 |
| `src/server.js` | 公開預約 body、教練登錄 body、新 PATCH companion 端點 |
| `public/coaches.html`／`coaches.js`、`public/coach.js`、`public/admin.js`、`public/my-schedule.js` | 三入口 UI、名牌、卡片、課表卡 |
| tests | `booking-anon`、`coach-register`、`booking-edit`、`discount-migration`、`line-notify-policy` 追加；新檔 `booking-companion-schedule.test.js`、`booking-companion-api.test.js` |

---

### Task 1: 資料欄、同行守則、公開建立與客人取消、通知模板

**Files:**
- Modify: `src/db/schema.js`（`bookings` CREATE TABLE，`package_id` 欄之後）
- Modify: `src/db/connection.js`（既有 `addColumnIfMissing('bookings', 'discount_amount', 'INTEGER')` 之後）
- Modify: `src/services/bookingService.js`（`insertBookingStmt`、`createBookingCore`、`createBookingAnon`、`cancelBookingAnon`、`cancelBookingFromGcal`；新增 helper）
- Modify: `src/services/notifications.js`（`booking_cancelled_by_coach` 模板之前加新模板）
- Modify: `src/services/lineNotifyPolicy.js:16`
- Test: `tests/booking-anon.test.js`（檔尾 `console.log('[booking-anon test] done')` 之前追加）、`tests/discount-migration.test.js:46` 之後、`tests/line-notify-policy.test.js` `ACTIVE_TYPES`

**Interfaces:**
- Consumes: `findOrCreateUserByPhone`、`getUserByPhoneAndName`（userService）、`notify`／`notifyAdmins`／`fmtDateForLine`。
- Produces（Task 2–4 依賴）：
  - `createBookingCore({ coach, memberId, startAt, note, sessionType, silent, enforceAvailability, member2Id = null })`
  - `createBookingAnon({ …, companion = null })`，`companion = { name, phone } | null`；回傳多 `companionName: string | null`
  - `cancelBookingAnon({ bookingId, phone, name })`：同行亦可取消
  - `cancelBookingFromGcal(id)` 回傳多 `companionName`
  - 內部 helper（同檔其他函式用）：`resolveCompanionById({ companionId, memberId, sessionType })`、`resolveCompanionByPhone({ companion, memberId, memberPhone, sessionType })`、`partyLabel(b)`、`notifyCustomers(b, type, vars)`

- [ ] **Step 1: 追加失敗測試**

(a) `tests/booking-anon.test.js`：檔尾 `console.log('[booking-anon test] done');` **之前**追加：

```js
// ── 1對2 同行客人 ────────────────────────────────────────────────────────
const staffPhoneUser = db.prepare("INSERT INTO users (name,email,password_hash,role,phone) VALUES ('員工丙','anon-bk-staff@x.com',?,'coach','0998000777')").run(hashPassword('x'));
const rc = createBookingAnon({ coachId: coach.id, startAt: futureLocal(8), name: '主客甲', phone: '0998000501', sessionType: '1on2',
  companion: { name: '同行乙', phone: '0998000502' } });
expect('1on2 帶同行：member2_id 寫入、同行帳號建立、回傳 companionName', () => {
  const row = db.prepare('SELECT member_id, member2_id, session_type FROM bookings WHERE id=?').get(rc.id);
  const u2 = db.prepare("SELECT id, name, role FROM users WHERE phone='0998000502'").get();
  assert.ok(u2 && u2.role === 'user' && u2.name === '同行乙');
  assert.equal(row.member2_id, u2.id);
  assert.notEqual(row.member_id, row.member2_id);
  assert.equal(rc.companionName, '同行乙');
});
expect('教練 booking_created 的 member_name 為「主客甲＋同行乙」、同行也收 booking_confirmed', () => {
  const coachNotif = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_created' ORDER BY id DESC LIMIT 1").get(coach.user_id);
  assert.ok(coachNotif && coachNotif.body.includes('主客甲＋同行乙'), coachNotif && coachNotif.body);
  const u2 = db.prepare("SELECT id FROM users WHERE phone='0998000502'").get();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_confirmed'").get(u2.id).c, 1);
});
expect('同行電話＝主客人 → 400 companion_same_person', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '主客甲', phone: '0998000501' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'companion_same_person'); }
});
expect('1on1 帶同行 → 400 companion_not_allowed', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on1', companion: { name: '同行乙', phone: '0998000502' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'companion_not_allowed'); }
});
expect('同行只填姓名沒電話 → 400 invalid_companion', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '同行乙', phone: '' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 400); assert.equal(e.code, 'invalid_companion'); }
});
expect('同行電話是員工帳號 → 409 phone_unavailable', () => {
  try { createBookingAnon({ coachId: coach.id, startAt: futureLocal(9), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '員工丙', phone: '0998000777' } }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('無關第三者取消 → 403', () => {
  try { cancelBookingAnon({ bookingId: rc.id, phone: '0998000333', name: '阿明' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});
expect('同行取消 → 整筆取消、教練收「同行乙 取消」、主客人收 booking_cancelled_by_companion', () => {
  const res = cancelBookingAnon({ bookingId: rc.id, phone: '0998000502', name: '同行乙' });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT status, cancelled_by FROM bookings WHERE id=?').get(rc.id);
  const u2 = db.prepare("SELECT id FROM users WHERE phone='0998000502'").get();
  const u1 = db.prepare("SELECT id FROM users WHERE phone='0998000501'").get();
  assert.equal(row.status, 'cancelled'); assert.equal(row.cancelled_by, u2.id);
  const coachNotif = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_cancelled_by_member' ORDER BY id DESC LIMIT 1").get(coach.user_id);
  assert.ok(coachNotif && coachNotif.body.includes('同行乙'), coachNotif && coachNotif.body);
  const mate = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_cancelled_by_companion' ORDER BY id DESC LIMIT 1").get(u1.id);
  assert.ok(mate && mate.body.includes('同行乙') && mate.body.includes('Coach U'), mate && mate.body);
});
expect('主客人取消 → 同行收 booking_cancelled_by_companion', () => {
  const r2 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(10), name: '主客甲', phone: '0998000501', sessionType: '1on2', companion: { name: '同行乙', phone: '0998000502' } });
  cancelBookingAnon({ bookingId: r2.id, phone: '0998000501', name: '主客甲' });
  const u2 = db.prepare("SELECT id FROM users WHERE phone='0998000502'").get();
  const mate = db.prepare("SELECT body FROM notifications WHERE user_id=? AND type='booking_cancelled_by_companion' ORDER BY id DESC LIMIT 1").get(u2.id);
  assert.ok(mate && mate.body.includes('主客甲'), mate && mate.body);
});
expect('1on2 不帶同行 → member2_id NULL、companionName null', () => {
  const r3 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(11), name: '主客甲', phone: '0998000501', sessionType: '1on2' });
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(r3.id).member2_id, null);
  assert.equal(r3.companionName, null);
});
```

（`futureLocal(8..11)` 各用不同天避免撞時段；`reset()` 以 `phone LIKE '0998%'`／`email LIKE 'anon-bk-%'` 清理，新資料皆在範圍內。）

(b) `tests/discount-migration.test.js` 第 46 行之後加：

```js
expect('bookings has member2_id (同行客人)', ()=>assert(bkCols.includes('member2_id')));
```

(c) `tests/line-notify-policy.test.js` 的 `ACTIVE_TYPES` 陣列：在 `'booking_cancelled_by_coach', 'booking_cancelled_by_shop', 'booking_refunded',` 那行之後加一行 `'booking_cancelled_by_companion',`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/booking-anon.test.js 2>&1 | grep -E "✗|Error" | head`；`node tests/discount-migration.test.js 2>&1 | grep -E "✗"`；`DB_PATH="$(mktemp -d)/t.db" node tests/line-notify-policy.test.js 2>&1 | grep -E "✗"`
Expected: booking-anon 新案例 ✗（`companion` 被忽略、`member2_id` 欄不存在會直接丟 SQL 錯誤）；migration「member2_id」✗；policy「31 個現役 type 全涵蓋」✗（多了一個未對應）。

- [ ] **Step 3: schema 與遷移**

`src/db/schema.js` `bookings` 表 `package_id INTEGER REFERENCES customer_packages(id),` 之後加：

```sql
  member2_id INTEGER REFERENCES users(id),
```

`src/db/connection.js` 在 `addColumnIfMissing('bookings', 'discount_amount', 'INTEGER');` 之後加：

```js
// ── 2026-09-18 一對二同行客人（可空；只限 session_type='1on2'，守則在 bookingService）
addColumnIfMissing('bookings', 'member2_id', 'INTEGER REFERENCES users(id)');
```

- [ ] **Step 4: 通知模板與開關目錄**

`src/services/notifications.js` 在 `booking_cancelled_by_coach: {` 那個物件**之前**插入：

```js
  booking_cancelled_by_companion: {  // 寄給另一位客人（一對二同行取消了共用的預約）
    subject: '同行取消預約 - {{coach_display_name}}',
    body: '⚠️ 您與 {{other_name}} 同行的 {{coach_display_name}} 教練課（{{start_at}}）已由 {{other_name}} 取消，此堂課不會進行。',
  },
```

`src/services/lineNotifyPolicy.js` 第 16 行 `types` 改為 `['booking_cancelled_by_coach', 'booking_cancelled_by_shop', 'booking_refunded', 'booking_cancelled_by_companion']`。

- [ ] **Step 5: bookingService helper 與建立／取消**

(a) `insertBookingStmt` 改成：

```js
const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, note, session_type, member2_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
```

(b) `getUserNameStmt` 那行之後加 helper 群：

```js
const getUserBasicStmt = db.prepare('SELECT id, name, phone, role FROM users WHERE id = ?');

/** 同行守則（既有會員 id 版；教練登錄／後台編輯用）。回 users 列或 null。 */
function resolveCompanionById({ companionId, memberId, sessionType }) {
  if (companionId == null || companionId === '') return null;
  if (sessionType !== '1on2') throw new ApiError(400, 'companion_not_allowed');
  const id = Number(companionId);
  const u = Number.isInteger(id) ? getUserBasicStmt.get(id) : null;
  if (!u || u.role !== 'user') throw new ApiError(404, 'companion_not_found');
  if (u.id === Number(memberId)) throw new ApiError(400, 'companion_same_person');
  return u;
}

/** 同行守則（公開頁姓名＋電話版）：兩者皆須有值；建立或對到既有一般會員（員工電話 409）。 */
function resolveCompanionByPhone({ companion, memberId, memberPhone, sessionType }) {
  if (!companion) return null;
  const name = typeof companion.name === 'string' ? companion.name.trim() : '';
  const phone = typeof companion.phone === 'string' ? companion.phone.trim() : '';
  if (!name && !phone) return null;                        // 兩欄留白＝沒有同行
  if (sessionType !== '1on2') throw new ApiError(400, 'companion_not_allowed');
  if (!name || !phone) throw new ApiError(400, 'invalid_companion');
  if (phone === String(memberPhone)) throw new ApiError(400, 'companion_same_person');
  let u;
  try { u = findOrCreateUserByPhone({ phone, name }); }
  catch (e) { if (e instanceof ApiError && e.code === 'invalid_phone') throw new ApiError(400, 'invalid_companion'); throw e; }
  if (u.id === Number(memberId)) throw new ApiError(400, 'companion_same_person');
  return u;
}

/** 員工端通知用的客人標籤：有同行 → 「主客人＋同行」。 */
function partyLabel(b) {
  const m = getUserNameStmt.get(b.member_id)?.name || '';
  const c = b.member2_id ? getUserNameStmt.get(b.member2_id)?.name : null;
  return c ? `${m}＋${c}` : m;
}

/** 會員端通知鏡射：主客人與同行（若有）各一則同款通知。 */
function notifyCustomers(b, type, vars) {
  notify({ userId: b.member_id, sessionId: null, type, vars });
  if (b.member2_id) notify({ userId: b.member2_id, sessionId: null, type, vars });
}
```

(c) `createBookingCore`：簽名改 `function createBookingCore({ coach, memberId, startAt, note, sessionType = '1on1', silent = false, enforceAvailability = true, member2Id = null }) {`；INSERT 改 `insertBookingStmt.run(coach.id, memberId, startAt, endAt, note, sessionType, member2Id)`；通知段改成：

```js
  const memberRow = getUserNameStmt.get(memberId);
  if (memberRow && !silent) {  // silent：循環預約逐堂不通知（由呼叫端發一則摘要）
    const startFmt = fmtDateForLine(startAt);
    const label = partyLabel({ member_id: memberId, member2_id: member2Id });
    notify({ userId: coach.user_id, sessionId: null, type: 'booking_created',
      vars: { member_name: label, start_at: startFmt } });
    notifyCustomers({ member_id: memberId, member2_id: member2Id }, 'booking_confirmed',
      { coach_display_name: coach.display_name, start_at: startFmt });
    // 加掛：店家管理者廣播（第三人稱、中性，沿用 booking_created 文案）
    notifyAdmins({ type: 'booking_created', excludeUserIds: [memberId, member2Id, coach.user_id].filter(Boolean), vars: { member_name: label, start_at: startFmt } });
  }
```

(d) `createBookingAnon`：簽名加 `companion = null`；`const r = createBookingCore({ … })` 那行之前加 `const companionUser = resolveCompanionByPhone({ companion, memberId: user.id, memberPhone: phone, sessionType });`，`createBookingCore` 呼叫加 `member2Id: companionUser ? companionUser.id : null`；回傳前加 `r.companionName = companionUser ? companionUser.name : null;`。

(e) `cancelBookingAnon` 整個函式換成：

```js
export function cancelBookingAnon({ bookingId, phone, name }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    const user = getUserByPhoneAndName({ phone, name });
    const isPrimary = !!user && user.id === b.member_id;
    const isCompanion = !!user && b.member2_id != null && user.id === b.member2_id;
    if (!isPrimary && !isCompanion) throw new ApiError(403, 'forbidden');
    cancelBookingStmt.run(nowLocal(), user.id, null, bookingId);
    refundPackageForBooking(b);
    releaseRedemption({ kind: 'booking', refId: bookingId });
    const coach = getCoachStmt.get(b.coach_id);
    if (coach) {
      const startFmt = fmtDateForLine(b.start_at);
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_member',
        vars: { member_name: user.name, start_at: startFmt } });
      // 一對二：另一位客人要知道共用的這堂課被取消了
      const otherId = isPrimary ? b.member2_id : b.member_id;
      if (otherId) notify({ userId: otherId, sessionId: null, type: 'booking_cancelled_by_companion',
        vars: { other_name: user.name, coach_display_name: coach.display_name, start_at: startFmt } });
    }
    return { ok: true };
  });
}
```

(f) `cancelBookingFromGcal` 回傳物件加 `companionName: b.member2_id ? (getUserNameStmt.get(b.member2_id)?.name || '') : null`。

- [ ] **Step 6: 跑測試確認通過**

Run: 三檔同 Step 2 指令 → 全部 0 ✗；另跑 `DB_PATH="$(mktemp -d)/t.db" node tests/notifications-flow.test.js` 與 `tests/notification-dedup.test.js` 確認模板新增未破壞。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.js src/db/connection.js src/services/bookingService.js src/services/notifications.js src/services/lineNotifyPolicy.js tests/booking-anon.test.js tests/discount-migration.test.js tests/line-notify-policy.test.js
git commit -m "feat: 一對二同行客人（member2_id）— 公開建立、客人取消、同行取消通知

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 2: 員工流程（登錄、設定同行、改期／改客人／店家取消的鏡射）

**Files:**
- Modify: `src/services/bookingService.js`（`cancelBooking`、`cancelBookingAdmin`、`rescheduleBooking`、`reassignBooking`、`createCoachRegister`；新增 `setBookingCompanion`）
- Test: `tests/coach-register.test.js`（檔尾追加）、`tests/booking-edit.test.js`（檔尾追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveCompanionById`、`partyLabel`、`notifyCustomers`、`createBookingCore({ …, member2Id })`。
- Produces（Task 4 依賴）：
  - `createCoachRegister({ coachId, memberId, packageId, startAt, recurrence, actorId, companionId = null })`
  - `export function setBookingCompanion({ bookingId, companionId, actorUserId, isAdmin = false })` → `{ ok, bookingId, companionId, companionName }`
  - `reassignBooking`：新方案 1對1 或新主客人＝原同行 → `member2_id` 清 NULL，否則保留。

- [ ] **Step 1: 追加失敗測試**

(a) `tests/coach-register.test.js` 檔尾（最後一個 `expect(` 之後、若有 `console.log('[coach-register test] done')` 則在其之前）追加：

```js
// ── 一對二同行客人 ──
const mate = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('reg同行','reg-mate@x.com','user','0971000002')").run().lastInsertRowid);
expect('1on2 方案帶 companionId：循環每筆 member2_id 相同、同行收循環摘要一則', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on2', totalSessions:3 });
  const r = createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T16:00:00`, recurrence:{ frequency:'daily', interval:1, end:{ type:'count', count:2 } }, actorId: admin, companionId: mate });
  assert.equal(r.created.length, 2);
  for (const c of r.created) assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(c.id).member2_id, mate);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_recurring_created'").get(mate).c, 1);
});
expect('1on1 方案帶 companionId → 400 companion_not_allowed', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on1', totalSessions:3 });
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T18:00:00`, recurrence:null, actorId: admin, companionId: mate }), /companion_not_allowed/);
});
expect('companionId＝主客人 → 400 companion_same_person；不存在 → 404 companion_not_found', () => {
  const p = createPackage({ memberId: mid, sessionType:'1on2', totalSessions:3 });
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T19:00:00`, recurrence:null, actorId: admin, companionId: mid }), /companion_same_person/);
  assert.throws(() => createCoachRegister({ coachId, memberId: mid, packageId: p.id, startAt:`${D}T19:00:00`, recurrence:null, actorId: admin, companionId: 999999 }), /companion_not_found/);
});
```

（若該檔 `${D}` 當天 16–20 點已被前面案例佔用，改用 `D2 = D 的隔天`，同法產生。）

(b) `tests/booking-edit.test.js` 檔尾追加（`m1`、`m2`、`coach`、`cu`、`admin`、`mkBk`、`D` 皆為該檔既有變數）：

```js
// ── 一對二同行客人：設定／清除／權限；改客人方案與改期的連動 ──
const { setBookingCompanion } = await import('../src/services/bookingService.js');
const m3=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('be客3','be-m3@x.com','user','0981000003')").run().lastInsertRowid);
expect('setBookingCompanion：設定同行、新同行收 booking_confirmed', () => {
  const bid=mkBk(m1,'16',null,'1on2');
  const r=setBookingCompanion({ bookingId:bid, companionId:m2, actorUserId:cu, isAdmin:false });
  assert.equal(r.companionId, m2); assert.equal(r.companionName, 'be客2');
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(bid).member2_id, m2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_confirmed'").get(m2).c, 1);
});
expect('setBookingCompanion：換人 → 舊同行收 booking_cancelled_by_shop、清除 → member2_id NULL', () => {
  const bid=mkBk(m1,'17',null,'1on2');
  setBookingCompanion({ bookingId:bid, companionId:m2, actorUserId:cu });
  setBookingCompanion({ bookingId:bid, companionId:m3, actorUserId:cu });
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(bid).member2_id, m3);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_shop'").get(m2).c, 1);
  const r=setBookingCompanion({ bookingId:bid, companionId:null, actorUserId:cu });
  assert.equal(r.companionId, null);
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(bid).member2_id, null);
});
expect('setBookingCompanion：1on1 → 400、他教練 → 403、管理者可代', () => {
  const b1=mkBk(m1,'18');
  assert.throws(()=>setBookingCompanion({ bookingId:b1, companionId:m2, actorUserId:cu }), /companion_not_allowed/);
  const b2=mkBk(m1,'19',null,'1on2');
  assert.throws(()=>setBookingCompanion({ bookingId:b2, companionId:m2, actorUserId:cu2 }), /forbidden/);
  assert.equal(setBookingCompanion({ bookingId:b2, companionId:m2, actorUserId:admin, isAdmin:true }).companionId, m2);
});
expect('reassign：新方案 1on1 → 清同行；新主客人＝原同行 → 清同行；否則保留', () => {
  const p2=createPackage({ memberId:m2, sessionType:'1on1', totalSessions:5 });
  const b1=mkBk(m1,'20',null,'1on2'); setBookingCompanion({ bookingId:b1, companionId:m3, actorUserId:cu });
  reassignBooking({ bookingId:b1, newMemberId:m2, newPackageId:p2.id, actorUserId:cu });
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(b1).member2_id, null);
  const p3=createPackage({ memberId:m3, sessionType:'1on2', totalSessions:5 });
  const b2=mkBk(m1,'21',null,'1on2'); setBookingCompanion({ bookingId:b2, companionId:m3, actorUserId:cu });
  reassignBooking({ bookingId:b2, newMemberId:m3, newPackageId:p3.id, actorUserId:cu });
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(b2).member2_id, null);
  const p1=createPackage({ memberId:m1, sessionType:'1on2', totalSessions:5 });
  const b3=mkBk(m2,'22',null,'1on2'); setBookingCompanion({ bookingId:b3, companionId:m3, actorUserId:cu });
  reassignBooking({ bookingId:b3, newMemberId:m1, newPackageId:p1.id, actorUserId:cu });
  assert.equal(db.prepare('SELECT member2_id FROM bookings WHERE id=?').get(b3).member2_id, m3);
});
expect('reschedule：同行也收 booking_rescheduled', () => {
  const bid=mkBk(m1,'08',null,'1on2'); setBookingCompanion({ bookingId:bid, companionId:m3, actorUserId:cu });
  const before=db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled'").get(m3).c;
  rescheduleBooking({ bookingId:bid, newStartAt:`${D}T23:00:00`, actorUserId:cu, isAdmin:false });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_rescheduled'").get(m3).c, before+1);
});
```

（若 `${D}` 的 16–23 點或 08 點已被該檔前面案例用掉，改用隔天 `D2`；`mkBk` 的第二參數是小時字串。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/coach-register.test.js 2>&1 | grep -E "✗|Error" | head`；`DB_PATH="$(mktemp -d)/t.db" node tests/booking-edit.test.js 2>&1 | grep -E "✗|Error" | head`
Expected: 新案例 ✗（`companionId` 被忽略、`setBookingCompanion` 不存在）。

- [ ] **Step 3: 實作**

(a) `cancelBooking`：`if (b.member_id !== actorUserId) throw new ApiError(403, 'forbidden');` 改 `if (b.member_id !== actorUserId && b.member2_id !== actorUserId) throw new ApiError(403, 'forbidden');`；`isCoachCancel` 分支的 `notify({ userId: b.member_id, …'booking_cancelled_by_coach'… })` 改 `notifyCustomers(b, 'booking_cancelled_by_coach', { coach_display_name: coach.display_name, start_at: startFmt })`；else 分支（會員取消）`member_name: memberRow.name` 改為取消者：`member_name: getUserNameStmt.get(actorUserId)?.name || memberRow.name`，並在其後加同行通知：

```js
        const otherId = actorUserId === b.member_id ? b.member2_id : b.member_id;
        if (otherId) notify({ userId: otherId, sessionId: null, type: 'booking_cancelled_by_companion',
          vars: { other_name: getUserNameStmt.get(actorUserId)?.name || '', coach_display_name: coach.display_name, start_at: startFmt } });
```

(b) `cancelBookingAdmin`：`notify({ userId: b.member_id, … 'booking_cancelled_by_shop' … })` 改 `notifyCustomers(b, 'booking_cancelled_by_shop', { … 同 vars … })`；教練通知 `member_name: memberRow.name` 改 `member_name: partyLabel(b)`。

(c) `rescheduleBooking`：`notify({ userId: b.member_id, … 'booking_rescheduled' … })` 改 `notifyCustomers(b, 'booking_rescheduled', { coach_display_name: coach.display_name, start_at: fmtDateForLine(newStartAt) })`；教練版 `const memberName = …` 改 `const memberName = partyLabel(b);`。

(d) `reassignBooking`：UPDATE 之前算 `const keepMate = p.session_type === '1on2' && b.member2_id != null && b.member2_id !== memberId ? b.member2_id : null;`，UPDATE 語句加 `member2_id = ?`（在 `paid_by = ?` 之前），參數對應加 `keepMate`。

(e) `createCoachRegister`：簽名加 `companionId = null`；`const sessionType = p.session_type;` 之後加 `const mate = resolveCompanionById({ companionId, memberId, sessionType });`；`createBookingCore` 呼叫加 `member2Id: mate ? mate.id : null`；循環摘要：`member_name: getUserNameStmt.get(memberId)?.name || ''` 改 `member_name: partyLabel({ member_id: memberId, member2_id: mate ? mate.id : null })`，`notify({ userId: memberId, …'booking_recurring_created'… })` 改 `notifyCustomers({ member_id: memberId, member2_id: mate ? mate.id : null }, 'booking_recurring_created', summaryVars)`。

(f) 新增（放在 `reassignBooking` 之後）：

```js
/** 設定／清除一對二的同行客人（教練本人或管理者）。換人：舊同行收店家取消通知、新同行收預約成功。 */
export function setBookingCompanion({ bookingId, companionId, actorUserId, isAdmin = false }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    const coach = getCoachStmt.get(b.coach_id);
    if (!isAdmin && (!coach || coach.user_id !== actorUserId)) throw new ApiError(403, 'forbidden');
    if (b.session_type !== '1on2') throw new ApiError(400, 'companion_not_allowed');
    const next = resolveCompanionById({ companionId, memberId: b.member_id, sessionType: b.session_type });
    const nextId = next ? next.id : null;
    if ((b.member2_id ?? null) === nextId) return { ok: true, bookingId, companionId: nextId, companionName: next ? next.name : null };
    db.prepare('UPDATE bookings SET member2_id = ? WHERE id = ?').run(nextId, bookingId);
    if (coach) {
      const startFmt = fmtDateForLine(b.start_at);
      if (b.member2_id) notify({ userId: b.member2_id, sessionId: null, type: 'booking_cancelled_by_shop',
        vars: { coach_display_name: coach.display_name, start_at: startFmt, reason_suffix: '（同行名單變更）' } });
      if (nextId) notify({ userId: nextId, sessionId: null, type: 'booking_confirmed',
        vars: { coach_display_name: coach.display_name, start_at: startFmt } });
    }
    return { ok: true, bookingId, companionId: nextId, companionName: next ? next.name : null };
  });
}
```

- [ ] **Step 4: 跑測試確認通過＋完整鏈**

Run: 兩檔同 Step 2 → 0 ✗；`DB_PATH="$(mktemp -d)/t.db" npm test > /tmp/bc-chain.log 2>&1; echo exit=$?; grep -c "✗" /tmp/bc-chain.log` → `exit=0`、`0`。

- [ ] **Step 5: Commit**

```bash
git add src/services/bookingService.js tests/coach-register.test.js tests/booking-edit.test.js
git commit -m "feat: 同行客人 — 教練登錄帶同行、設定/清除同行、改期/改客人/店家取消鏡射通知

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 3: 讀模型帶同行（我的課表、週曆、待核對／已核對、gcal、email）

**Files:**
- Modify: `src/services/groupOrderService.js`（`getPublicSchedule` bookings 查詢與 map）
- Modify: `src/services/coachCalendarService.js`（`BK_COLS`、`weekBookings`、`weekAllBookings`）
- Modify: `src/services/bookingService.js`（`listCoachStmt`、`listPendingPaymentStmt`＋`listPendingPaymentBookings` group、`listConfirmedPayments` bookingRows＋group）
- Modify: `src/services/gcalSync.js`（`getBookingFull`、`buildEventBody`）
- Modify: `src/services/emailService.js`（第一個 `getBookingFull`、`_buildConfirmationHtml` 的 `rows`）
- Test: 新檔 `tests/booking-companion-schedule.test.js`；`package.json` `test` 鏈尾加 `&& node tests/booking-companion-schedule.test.js`

**Interfaces:**
- Consumes: Task 1／2 的 `createBookingAnon({…, companion})`、`cancelBookingAnon`、`setBookingCompanion`。
- Produces（Task 5 依賴）：
  - `getPublicSchedule` 每筆 booking 多 `is_companion: boolean`、`companion_name: string | null`
  - 週曆 booking 多 `member2_id`、`companion_name`、`companion_phone`
  - 待核對 item／group、已核對 row／group 多 `companion_name`
  - `listCoachBookings` 列多 `companion_name`
  - gcal summary `1對2教練課 教練×主客人＋同行`、description 多行 `同行：X（電話）`；email 多列「同行客人」

- [ ] **Step 1: 寫失敗測試**

建立 `tests/booking-companion-schedule.test.js`：

```js
// 一對二同行客人：我的課表兩種身分、週曆／待核對／gcal／email 讀模型帶同行名。fresh DB、LINE_MOCK=1。
process.env.LINE_MOCK = '1';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createBookingAnon, cancelBookingAnon, listPendingPaymentBookings, listCoachBookings } from '../src/services/bookingService.js';
import { getPublicSchedule } from '../src/services/groupOrderService.js';
import { getCoachWeek } from '../src/services/coachCalendarService.js';
import { buildEventBody } from '../src/services/gcalSync.js';
import { _buildConfirmationHtml } from '../src/services/emailService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function futureLocal(days, hh = 10) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`; }
console.log('[booking-companion-schedule test] start');
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0989%' OR email LIKE 'bcs-%');
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0989%') OR member2_id IN (SELECT id FROM users WHERE phone LIKE '0989%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'bcs-%');
  DELETE FROM users WHERE phone LIKE '0989%' OR email LIKE 'bcs-%';
`);
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('教練甲','bcs-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: '教練甲' });
setCoachActive(coach.id, true);
const startAt = futureLocal(7, 11);
const r = createBookingAnon({ coachId: coach.id, startAt, name: '王小明', phone: '0989000001', sessionType: '1on2', companion: { name: '陳小華', phone: '0989000002' }, email: 'bcs-mail@x.com' });

expect('主客人我的課表：列出該筆、is_companion=false、companion_name=陳小華', () => {
  const s = getPublicSchedule({ phone: '0989000001', name: '王小明' });
  const it = s.items.find((x) => x.kind === 'booking' && x.id === r.id);
  assert.ok(it); assert.equal(it.is_companion, false); assert.equal(it.companion_name, '陳小華'); assert.equal(it.can_cancel, true);
});
expect('同行我的課表：列出同一筆、is_companion=true、companion_name=王小明', () => {
  const s = getPublicSchedule({ phone: '0989000002', name: '陳小華' });
  const it = s.items.find((x) => x.kind === 'booking' && x.id === r.id);
  assert.ok(it); assert.equal(it.is_companion, true); assert.equal(it.companion_name, '王小明'); assert.equal(it.can_cancel, true);
  assert.equal(s.stats.one_upcoming, 1);
});
expect('週曆：booking 帶 member2_id／companion_name／companion_phone', () => {
  const day = startAt.slice(0, 10);
  const monday = (() => { const d = new Date(`${day}T00:00:00`); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; })();
  const w = getCoachWeek({ coachId: coach.id, start: monday });
  const b = w.bookings.find((x) => x.id === r.id);
  assert.ok(b); assert.equal(b.companion_name, '陳小華'); assert.equal(b.companion_phone, '0989000002'); assert.ok(b.member2_id);
});
expect('待核對匯款與教練預約列表帶 companion_name', () => {
  const p = listPendingPaymentBookings().find((x) => x.id === r.id);
  assert.ok(p); assert.equal(p.companion_name, '陳小華');
  const c = listCoachBookings(coach.id).find((x) => x.id === r.id);
  assert.ok(c); assert.equal(c.companion_name, '陳小華');
});
expect('gcal 事件：summary 含「王小明＋陳小華」、description 含同行行', () => {
  const ev = buildEventBody(r.id);
  assert.ok(ev.summary.includes('王小明＋陳小華'), ev.summary);
  assert.ok(ev.description.includes('同行：陳小華（0989000002）'), ev.description);
});
expect('email 確認信含「同行客人」列', () => {
  const html = _buildConfirmationHtml(r.id);
  assert.ok(html.includes('同行客人') && html.includes('陳小華'));
});
expect('無同行的 1on2：companion_name null、gcal summary 無「＋」', () => {
  const r2 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(8, 11), name: '王小明', phone: '0989000001', sessionType: '1on2' });
  const s = getPublicSchedule({ phone: '0989000001', name: '王小明' });
  const it = s.items.find((x) => x.kind === 'booking' && x.id === r2.id);
  assert.equal(it.companion_name, null); assert.equal(it.is_companion, false);
  assert.ok(!buildEventBody(r2.id).summary.includes('＋'));
});
expect('同行取消後兩邊都不再列出', () => {
  cancelBookingAnon({ bookingId: r.id, phone: '0989000002', name: '陳小華' });
  const a = getPublicSchedule({ phone: '0989000001', name: '王小明' }).items.find((x) => x.kind === 'booking' && x.id === r.id);
  const b = getPublicSchedule({ phone: '0989000002', name: '陳小華' }).items.find((x) => x.kind === 'booking' && x.id === r.id);
  assert.equal(a, undefined); assert.equal(b, undefined);
});
console.log('[booking-companion-schedule test] done');
```

（`getPublicSchedule` 回傳物件含 `items`／`stats`——實作時以該函式實際回傳鍵為準；若 `getCoachWeek` 的 `start` 參數格式非週一日期，改用該函式文件註明的格式。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `DB_PATH="$(mktemp -d)/t.db" node tests/booking-companion-schedule.test.js 2>&1 | grep -E "✗|Error" | head`
Expected: 「同行我的課表」（查不到）、companion_name／summary／email 各案 ✗。

- [ ] **Step 3: 實作**

(a) `groupOrderService.getPublicSchedule` bookings 查詢改：

```js
  const bookings = db.prepare(`
    SELECT b.id, b.start_at, b.end_at, b.status, b.session_type, b.paid_at, b.member_id, b.member2_id,
           c.display_name AS coach_display_name, u1.name AS member_name, u2.name AS member2_name
    FROM bookings b JOIN coaches c ON c.id = b.coach_id
    JOIN users u1 ON u1.id = b.member_id
    LEFT JOIN users u2 ON u2.id = b.member2_id
    WHERE (b.member_id = ? OR b.member2_id = ?) AND b.status != 'cancelled' ORDER BY b.start_at DESC
  `).all(user.id, user.id).map((b) => ({
    kind: 'booking', id: b.id, start_at: b.start_at, end_at: b.end_at,
    status: b.status, session_type: b.session_type, coach_display_name: b.coach_display_name,
    paid: !!b.paid_at,
    is_past: b.start_at < now,
    can_cancel: b.status === 'confirmed' && b.start_at > now,
    is_companion: b.member2_id === user.id,                                   // 查詢者是同行
    companion_name: b.member2_id === user.id ? b.member_name : (b.member2_name || null), // 對方的名字
  }));
```

(b) `coachCalendarService.js`：`BK_COLS` 尾端加 `, b.member2_id, u2.name AS companion_name, u2.phone AS companion_phone`；`weekBookings` 與 `weekAllBookings` 的 `FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id` 之後各加 `LEFT JOIN users u2 ON u2.id = b.member2_id`。

(c) `bookingService.js`：
- `listCoachStmt`：SELECT 加 `, u2.name AS companion_name`，`JOIN users u ON u.id = b.member_id` 後加 `LEFT JOIN users u2 ON u2.id = b.member2_id`。
- `listPendingPaymentStmt`：SELECT 加 `, u2.name AS companion_name`（`u.phone AS member_phone,` 之後），`JOIN users u ON u.id = b.member_id` 後加 `LEFT JOIN users u2 ON u2.id = b.member2_id`；`listPendingPaymentBookings` 的 group 物件加 `companion_name: b.companion_name,`。
- `listConfirmedPayments` bookingRows SQL：`u.name AS customer_name, u.phone AS customer_phone,` 之後加 `u2.name AS companion_name,`；`JOIN users u ON u.id = b.member_id` 後加 `LEFT JOIN users u2 ON u2.id = b.member2_id`；group 物件加 `companion_name: r.companion_name,`。

(d) `gcalSync.js` `getBookingFull`：SELECT 加 `, u2.name AS companion_name, u2.phone AS companion_phone`，`JOIN users u ON u.id = b.member_id` 後加 `LEFT JOIN users u2 ON u2.id = b.member2_id`；`buildEventBody`：`lines` 陣列在 `電話：` 那行之後加 `b.companion_name ? \`同行：${b.companion_name}（${b.companion_phone || '-'}）\` : null,`；summary 改 `` `${label}教練課 ${b.coach_name}×${b.member_name}${b.companion_name ? '＋' + b.companion_name : ''}` ``。

(e) `emailService.js` 第一個 `getBookingFull`（第 8–12 行）SELECT 加 `, u2.name AS companion_name`，`JOIN users u ON u.id = b.member_id` 後加 `LEFT JOIN users u2 ON u2.id = b.member2_id`；`_buildConfirmationHtml` 的 `rows` 在 `['方案', label],` 之後加 `b.companion_name ? ['同行客人', b.companion_name] : null,`（陣列尾已有 `.filter(Boolean)`）。

- [ ] **Step 4: 跑測試確認通過＋相鄰測試**

Run: 本檔 0 ✗；另跑 `gcal-sync`、`email-confirmation`、`booking-payment`、`my-schedule-service`、`coach-week-all` 五檔（皆 temp DB）確認 0 ✗；`package.json` `test` 鏈尾加 `&& node tests/booking-companion-schedule.test.js`。

- [ ] **Step 5: Commit**

```bash
git add src/services/groupOrderService.js src/services/coachCalendarService.js src/services/bookingService.js src/services/gcalSync.js src/services/emailService.js tests/booking-companion-schedule.test.js package.json
git commit -m "feat: 同行客人讀模型 — 我的課表雙身分、週曆/待核對/已核對/gcal/email 帶同行名

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 4: API（公開預約 body、教練登錄 body、設定同行端點）＋ API 測試

**Files:**
- Modify: `src/server.js`（import 區 `cancelBookingAnon as svcCancelBookingAnon,` 之後加 `setBookingCompanion as svcSetBookingCompanion,`；`POST /api/public/bookings`；`POST /api/coach/register`；新 `PATCH /api/coach/bookings/:id/companion` 放在 `reassign` 端點之後）
- Test: 新檔 `tests/booking-companion-api.test.js`；`package.json` `test:api` 鏈尾加 `&& node tests/booking-companion-api.test.js`

**Interfaces:**
- Consumes: Task 1 `createBookingAnon({…, companion})` 回 `companionName`；Task 2 `createCoachRegister({…, companionId})`、`setBookingCompanion`；Task 3 `getPublicSchedule` 的 `is_companion`。
- Produces（Task 5 依賴）：
  - `POST /api/public/bookings` body 多 `companionName`、`companionPhone`；回應多 `companionName`；400 `invalid_companion`／`companion_not_allowed`／`companion_same_person`、409 `phone_unavailable`
  - `POST /api/coach/register` body 多 `companionId`
  - `PATCH /api/coach/bookings/:id/companion` body `{ companionId: number | null }` → `{ ok, bookingId, companionId, companionName }`

- [ ] **Step 1: 寫失敗測試**

建立 `tests/booking-companion-api.test.js`（需 running server）：

```js
// API：一對二同行客人 — 公開預約帶同行、只填其一 400、我的課表雙身分、同行取消、教練設定同行端點。
// 需先起 server：LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3456 node src/server.js；BASE=http://localhost:3456
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { addRule } from '../src/services/availabilityService.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.8.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-companion-api test] start');
const clean = () => db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0986%' OR email LIKE 'bca-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0986%') OR member2_id IN (SELECT id FROM users WHERE phone LIKE '0986%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0986%'); DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'bca-%'); DELETE FROM users WHERE phone LIKE '0986%' OR email LIKE 'bca-%'");
clean();
const PW = hashPassword('bcapw1234');
const cuid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('BCA教練','bca-c@x.com','coach',0,?)").run(PW).lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BCA', 1)").run(cuid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 6*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });
const coachLogin = await req('POST', '/api/auth/login', { body: { email: 'bca-c@x.com', password: 'bcapw1234' } });
const coachToken = coachLogin.data?.token;
expect('前置：教練 token', () => assert.equal(coachLogin.status, 200));

try {
  const half = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '主客', phone: '0986000001', sessionType: '1on2', companionName: '同行' } });
  expect('只填同行姓名 → 400 invalid_companion', () => { assert.equal(half.status, 400); assert.equal(half.data?.error, 'invalid_companion'); });
  const not2 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '主客', phone: '0986000001', sessionType: '1on1', companionName: '同行', companionPhone: '0986000002' } });
  expect('1on1 帶同行 → 400 companion_not_allowed', () => { assert.equal(not2.status, 400); assert.equal(not2.data?.error, 'companion_not_allowed'); });
  const ok = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '主客', phone: '0986000001', sessionType: '1on2', companionName: '同行', companionPhone: '0986000002' } });
  expect('1on2 帶同行 → 201、回 companionName', () => { assert.equal(ok.status, 201); assert.equal(ok.data?.companionName, '同行'); });
  const bid = ok.data?.id;
  const myMate = await req('POST', '/api/public/my', { body: { phone: '0986000002', name: '同行' } });
  expect('同行查我的課表 → 該筆 is_companion=true、companion_name=主客', () => {
    assert.equal(myMate.status, 200);
    const it = (myMate.data.items || []).find((x) => x.kind === 'booking' && x.id === bid);
    assert.ok(it); assert.equal(it.is_companion, true); assert.equal(it.companion_name, '主客');
  });
  const myMain = await req('POST', '/api/public/my', { body: { phone: '0986000001', name: '主客' } });
  expect('主客查我的課表 → companion_name=同行', () => {
    const it = (myMain.data.items || []).find((x) => x.kind === 'booking' && x.id === bid);
    assert.ok(it); assert.equal(it.is_companion, false); assert.equal(it.companion_name, '同行');
  });
  const del = await req('DELETE', `/api/public/bookings/${bid}`, { body: { phone: '0986000002', name: '同行' } });
  expect('同行取消 → 200 ok', () => { assert.equal(del.status, 200); assert.equal(del.data?.ok, true); });

  // 教練端：先建一筆 1on2（無同行），再用端點設定／清除
  const ok2 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T11:00:00`, name: '主客', phone: '0986000001', sessionType: '1on2' } });
  const bid2 = ok2.data?.id;
  const mateId = Number(db.prepare("SELECT id FROM users WHERE phone='0986000002'").get().id);
  const set = await req('PATCH', `/api/coach/bookings/${bid2}/companion`, { token: coachToken, body: { companionId: mateId } });
  expect('PATCH companion 設定 → 200、companionName', () => { assert.equal(set.status, 200); assert.equal(set.data?.companionId, mateId); assert.equal(set.data?.companionName, '同行'); });
  const clr = await req('PATCH', `/api/coach/bookings/${bid2}/companion`, { token: coachToken, body: { companionId: null } });
  expect('PATCH companion 清除 → 200、companionId null', () => { assert.equal(clr.status, 200); assert.equal(clr.data?.companionId, null); });
  const noauth = await req('PATCH', `/api/coach/bookings/${bid2}/companion`, { body: { companionId: mateId } });
  expect('PATCH companion 未登入 → 401', () => assert.equal(noauth.status, 401));
  const ok3 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T12:00:00`, name: '主客', phone: '0986000001', sessionType: '1on1' } });
  const bad = await req('PATCH', `/api/coach/bookings/${ok3.data?.id}/companion`, { token: coachToken, body: { companionId: mateId } });
  expect('對 1on1 設定同行 → 400 companion_not_allowed', () => { assert.equal(bad.status, 400); assert.equal(bad.data?.error, 'companion_not_allowed'); });
} finally {
  clean();
}
console.log('[booking-companion-api test] done');
```

- [ ] **Step 2: 起測試伺服器、跑測試確認失敗**

`LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3456 node --env-file-if-exists=.env src/server.js > /tmp/bca-server.log 2>&1 &`（server 與 test 都用預設 `data/app.db`）；`BASE=http://localhost:3456 node tests/booking-companion-api.test.js 2>&1 | grep -E "✗|done"`
Expected: 「只填同行姓名 → 400」（實際 201）、`companionName` 缺、同行查不到、PATCH 404 等 ✗。

- [ ] **Step 3: 加端點與 body 處理**

(a) `POST /api/public/bookings`：`const { coachId, startAt, name, phone, note, discountCode, sessionType, email } = req.body || {};` 改為多取 `companionName, companionPhone`；在 `if (!isValidPhone(phone)) …` 之後加：

```js
  // 一對二同行客人（選填）：姓名／電話要一起填；電話格式同主客人；非 1對2 不可帶
  const cName = typeof companionName === 'string' ? companionName.trim() : '';
  const cPhone = typeof companionPhone === 'string' ? companionPhone.trim() : '';
  if ((cName && !cPhone) || (!cName && cPhone)) return res.status(400).json({ error: 'invalid_companion' });
  if (cPhone && !isValidPhone(cPhone)) return res.status(400).json({ error: 'invalid_companion' });
  if (cName && type !== '1on2') return res.status(400).json({ error: 'companion_not_allowed' });
  const companion = cName ? { name: cName, phone: cPhone } : null;
```

`svcCreateBookingAnon({ … email: email || null })` 呼叫加 `, companion`。（回應物件直接回傳 `r`，已含 `companionName`；若該 route 手動挑欄位回傳，加 `companionName: r.companionName`。）

(b) `POST /api/coach/register`：`const { memberId, packageId, startAt, recurrence } = req.body || {};` 改多取 `companionId`；`svcCreateRegister({ … })` 加 `companionId: companionId == null || companionId === '' ? null : Number(companionId)`。

(c) 在 `app.patch('/api/coach/bookings/:id/reassign', …)` 區塊之後加：

```js
// 一對二同行客人：設定／清除（教練本人或管理者；service 內守門）。gcal 標題含同行名 → 刷新事件。
app.patch('/api/coach/bookings/:id/companion', requireCoach, asyncHandler((req, res) => {
  const { companionId } = req.body || {};
  const r = svcSetBookingCompanion({ bookingId: Number(req.params.id), companionId: companionId == null || companionId === '' ? null : Number(companionId), actorUserId: req.user.id, isAdmin: !!req.user.is_admin });
  syncBookingUpdate(r.bookingId);
  res.json(r);
}));
```

- [ ] **Step 4: 重啟伺服器、跑測試確認通過**

Run: 同 Step 2 → 0 ✗、印 `done`。跑完 `kill` 伺服器、`npm run seed`。`package.json` `"test:api"` 鏈尾加 ` && node tests/booking-companion-api.test.js`。

- [ ] **Step 5: Commit**

```bash
git add src/server.js tests/booking-companion-api.test.js package.json
git commit -m "feat: 同行客人 API — 公開預約 companionName/Phone、教練登錄 companionId、PATCH companion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

### Task 5: 前端（公開預約、教練登錄、編輯彈窗、週曆／後台卡片、我的課表）

**Files:**
- Modify: `public/coaches.html`（電話欄位 `</label>` 與 Email 欄位之間）、`public/coaches.js`（`setSessionType`、送出驗證與 body、`showSuccessView`、`closeBookingModal` 清欄）
- Modify: `public/coach.js`（`renderRegmPicked`／方案選擇後的同行搜尋區、`doRegmSubmit`、`renderBkeditBody`、週曆 `reg-bk` 名牌、`groups` 名字）
- Modify: `public/admin.js`（待核對卡片 ×2、已核對列、`typeLabel`）
- Modify: `public/my-schedule.js`（`cardHtml` 的 `sn-l2`）、`public/my-schedule.html`（`.sn-mate` CSS）

**Interfaces:**
- Consumes: Task 4 的 API 契約；Task 3 的欄位 `is_companion`／`companion_name`／`companion_phone`／`member2_id`。
- Produces: 無（畫面）。本任務無自動化測試；驗證＝`node --input-type=module --check` 各檔＋curl 確認頁面含新元素；瀏覽器 pass 由 controller 做。

- [ ] **Step 1: 公開預約彈窗（coaches.html／coaches.js）**

`coaches.html` 在電話欄位的 `</label>` 之後、Email 欄位 `<label class="block mb-3">` 之前插入：

```html
      <div id="modal-companion" class="mb-3 hidden">
        <span class="text-sm font-medium text-slate-700 block">同行客人（選填）</span>
        <span class="text-xs text-slate-500 block mb-1">留白也可以；填了兩位都能在「我的課表」查到這堂課</span>
        <div class="grid grid-cols-2 gap-2">
          <input id="modal-companion-name" type="text" class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" placeholder="同行姓名">
          <input id="modal-companion-phone" type="tel" inputmode="numeric" class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" placeholder="同行電話">
        </div>
        <span id="modal-companion-err" class="text-xs text-red-500 mt-1 block"></span>
      </div>
```

`coaches.js`：
- `setSessionType(type)` 內 `refreshModalPrice();` 之後加：
  ```js
  $('modal-companion').classList.toggle('hidden', type !== '1on2');
  if (type !== '1on2') { $('modal-companion-name').value = ''; $('modal-companion-phone').value = ''; $('modal-companion-err').textContent = ''; }
  ```
- 送出驗證：`$('modal-general-err').textContent = '';` 之後加 `$('modal-companion-err').textContent = '';`；email 驗證之後加：
  ```js
  const cName = $('modal-companion-name').value.trim();
  const cPhone = $('modal-companion-phone').value.replace(/\D/g, '');
  if (modalSessionType === '1on2' && ((cName && !cPhone) || (!cName && cPhone))) {
    $('modal-companion-err').textContent = '請一併填寫同行客人的姓名與電話';
    hasErr = true;
  }
  ```
  `bookingBody` 組好後：`if (modalSessionType === '1on2' && cName && cPhone) { bookingBody.companionName = cName; bookingBody.companionPhone = cPhone; }`。
- 送出失敗的錯誤對照（該 handler 的 catch 內既有 `errCode` 對照表）加：`invalid_companion: '同行客人的姓名與電話需一併填寫，電話 8–15 碼數字'`、`companion_same_person: '同行客人不可與您本人相同'`、`companion_not_allowed: '只有 1對2 可填同行客人'`；若 `phone_unavailable` 已有對照，維持。
- `showSuccessView`：`const slotTime = …` 之後加 `const mateHtml = bookingResult.companionName ? \`<div class="mt-1 text-sm text-slate-600">同行：${escapeHtml(bookingResult.companionName)}</div>\` : '';`，並在成功卡顯示教練／時間的區塊後插入 `${mateHtml}`（放在時間那行之後）。
- `closeBookingModal()`（重置欄位處）加清空三個 companion 元素與隱藏區塊。

- [ ] **Step 2: 教練登錄預約同行搜尋（coach.js）**

在 `regmPackageId` 宣告旁加 `let regmCompanion = null; // {id,name,phone}｜同行客人（1對2 方案才有）`；`regmClose()` 與開啟時（`regmSlot = startAtISO; …` 那行）都加 `regmCompanion = null;`。

在 `renderRegmPicked()`（渲染方案選單的函式）最後、方案 `<select>` 之後追加同行區塊：找到該函式內組 HTML 的位置，於方案下拉之後加：

```js
  const pkg = regmPackages.find(p => p.id === regmPackageId);
  const mateBox = document.createElement('div');
  mateBox.id = 'regm-mate';
  mateBox.style.marginTop = '8px';
  picked.appendChild(mateBox);
  renderRegmMate(pkg);
```

並新增函式（放在 `renderRegmNewCustomer` 之前）：

```js
/** 1對2 方案：同行客人（選填）搜尋／挑選／新增；非 1對2 隱藏並清空。 */
function renderRegmMate(pkg) {
  const box = document.getElementById('regm-mate'); if (!box) return;
  if (!pkg || pkg.session_type !== '1on2') { box.innerHTML = ''; regmCompanion = null; return; }
  if (regmCompanion) {
    box.innerHTML = `<label class="regm-label">同行客人（選填）</label>
      <div class="regm-sub">已選：<strong>${escapeHtml(regmCompanion.name)}</strong> ${escapeHtml(regmCompanion.phone || '')} <button id="regm-mate-clear" class="btn-secondary" style="margin-left:6px;">移除</button></div>`;
    $('regm-mate-clear').onclick = () => { regmCompanion = null; renderRegmMate(pkg); };
    return;
  }
  box.innerHTML = `<label class="regm-label">同行客人（選填，1對2）</label>
    <input id="regm-mate-search" class="form-input regm-input" placeholder="搜尋同行客人姓名或電話…留白可" autocomplete="off" />
    <div id="regm-mate-results" class="regm-results"></div>`;
  const search = $('regm-mate-search'); let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t); const q = search.value.trim();
    if (!q) { $('regm-mate-results').innerHTML = ''; return; }
    t = setTimeout(async () => {
      try {
        const list = (await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`)).filter(u => !regmCustomer || u.id !== regmCustomer.id);
        if (!list.length) {
          const isDigits = /^\d+$/.test(q);
          $('regm-mate-results').innerHTML = `<div style="display:grid;gap:6px;padding:6px 0;"><div class="regm-sub">查無此客人，可直接新增：</div>
            <input id="regm-mate-newname" class="form-input" placeholder="姓名" value="${escapeHtml(isDigits ? '' : q)}" autocomplete="off" />
            <input id="regm-mate-newphone" class="form-input" placeholder="電話（選填）" value="${escapeHtml(isDigits ? q : '')}" inputmode="numeric" autocomplete="off" />
            <button id="regm-mate-create" class="btn-primary">新增同行客人</button></div>`;
          $('regm-mate-create').onclick = async () => {
            const name = $('regm-mate-newname').value.trim(); const phone = $('regm-mate-newphone').value.trim();
            if (!name) { toast('請填姓名', 'error'); return; }
            try { regmCompanion = await api('/api/coach/customers', { method: 'POST', body: phone ? { name, phone } : { name } }); renderRegmMate(pkg); }
            catch (e) { const m = { missing_name: '請填姓名', invalid_phone: '電話格式須 8–15 碼數字', phone_unavailable: '此電話為員工帳號，不可用於客人' }; toast(m[e.data?.error] || `新增失敗：${e.message}`, 'error'); }
          };
          return;
        }
        $('regm-mate-results').innerHTML = list.map(u => `<div class="regm-result" data-id="${u.id}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('');
        $('regm-mate-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', () => { regmCompanion = list.find(u => u.id === Number(r.dataset.id)); renderRegmMate(pkg); }));
      } catch (e) { $('regm-mate-results').innerHTML = `<div class="regm-sub" style="color:#dc2626;padding:6px;">${escapeHtml(e.message)}</div>`; }
    }, 250);
  });
}
```

方案下拉 `sel.onchange = () => { regmPackageId = Number(sel.value); };` 改為同時 `renderRegmMate(regmPackages.find(p => p.id === regmPackageId));`。

`doRegmSubmit` 的 body 加 `companionId: regmCompanion ? regmCompanion.id : null`；錯誤對照 `msgs` 加 `companion_not_allowed: '只有 1對2 方案可加同行客人'`、`companion_same_person: '同行客人不可與主客人相同'`、`companion_not_found: '找不到同行客人'`。

- [ ] **Step 3: 編輯彈窗、週曆名牌、我的預約分組（coach.js）**

- `renderBkeditBody`：`<div><b>客人：</b>…</div>` 之後加 `${b.session_type === '1on2' ? \`<div><b>同行：</b>${b.companion_name ? escapeHtml(b.companion_name) + (b.companion_phone ? '　' + escapeHtml(b.companion_phone) : '') : '<span class="regm-sub">（無）</span>'}</div>\` : ''}`；`bke-actions` 內在「改客人/方案」之後加 `${b.session_type === '1on2' ? '<button id="bke-mate-btn" class="btn-secondary">設定同行</button>' + (b.member2_id ? '<button id="bke-mate-clear-btn" class="btn-secondary">移除同行</button>' : '') : ''}`；綁定：
  ```js
  const mb = $('bke-mate-btn'); if (mb) mb.onclick = renderBkMate;
  const mc = $('bke-mate-clear-btn'); if (mc) mc.onclick = async () => {
    try { await api(`/api/coach/bookings/${b.id}/companion`, { method: 'PATCH', body: { companionId: null } }); toast('已移除同行客人', 'success'); bkeditClose(); renderRegister(); }
    catch (e) { toast(`失敗：${e.message}`, 'error'); }
  };
  ```
- 新增 `renderBkMate()`（放在 `renderBkReassign` 之後）：搜尋框同 `renderBkReassign` 的結構（`/api/coach/customers/search`），點選結果後 `PATCH /api/coach/bookings/${b.id}/companion` body `{ companionId: picked.id }`，成功 `toast('已設定同行客人', 'success'); bkeditClose(); renderRegister();`，錯誤對照 `companion_same_person: '同行客人不可與主客人相同'`、`companion_not_allowed: '只有 1對2 可設定同行'`、`companion_not_found: '找不到此客人'`、`forbidden: '無權限'`。
- 週曆名牌：`${escapeHtml(b.member_name)} <span class="reg-sub">${tag}</span>` 改 `${escapeHtml(b.member_name)}${b.companion_name ? '＋' + escapeHtml(b.companion_name) : ''} <span class="reg-sub">${tag}</span>`。
- 「我的預約」分組（第 189 行 `name: b.member_name`）：改 `name: b.companion_name ? \`${b.member_name}＋${b.companion_name}\` : b.member_name`。

- [ ] **Step 4: 後台卡片與通知型別（admin.js）**

- 待核對單筆卡 `<h3 class="card-title">${escapeHtml(b.member_name)}</h3>` 改 `<h3 class="card-title">${escapeHtml(b.member_name)}${b.companion_name ? '＋' + escapeHtml(b.companion_name) : ''}</h3>`；循環群組卡 `${escapeHtml(g.member_name)}` 同法用 `g.companion_name`。
- 已核對列 `<strong>${escapeHtml(x.customer_name)}</strong>` 改 `<strong>${escapeHtml(x.customer_name)}${x.companion_name ? '＋' + escapeHtml(x.companion_name) : ''}</strong>`（`data-name` 維持主客人）。
- `typeLabel` 物件加 `booking_cancelled_by_companion: '同行取消',`。

- [ ] **Step 5: 我的課表卡（my-schedule.js／my-schedule.html）**

`cardHtml` 的 `sn-l2` 內、`sn-status` 之後加：

```js
          ${isBooking && item.companion_name ? `<span class="sn-mate">${item.is_companion ? `與 ${escapeHtml(item.companion_name)} 同行` : `同行：${escapeHtml(item.companion_name)}`}</span>` : ''}
```

`my-schedule.html` 在 `.sn-status.mute{…}` 之後加：

```css
  .sn-mate { font-size: 11.5px; font-weight: 600; color: var(--ink-mute); letter-spacing: .03em; }
```

- [ ] **Step 6: 語法檢查與 curl 驗證**

Run: `for f in coaches coach admin my-schedule; do node --input-type=module --check < public/$f.js && echo "$f ok"; done`；起 `LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3457 node --env-file-if-exists=.env src/server.js`，curl `/coaches.html` 含 `modal-companion-name`、`/my-schedule.html` 含 `.sn-mate`；跑完 kill。瀏覽器實測由 controller 做：公開一對二預約填同行 → 成功頁「同行：X」→ 兩支電話各自查我的課表 → 同行按「請假」→ 兩邊消失；教練登錄 1對2 方案選同行 → 週曆名牌「A＋B」→ 編輯彈窗移除同行。

- [ ] **Step 7: Commit**

```bash
git add public/coaches.html public/coaches.js public/coach.js public/admin.js public/my-schedule.js public/my-schedule.html
git commit -m "feat: 同行客人前端 — 公開預約選填欄、教練登錄/編輯同行、名牌與卡片、我的課表同行標示

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Hpn9pyajskb5iz9ZYoknCE"
```

---

## 完成後（controller 自己做）

1. `DB_PATH="$(mktemp -d)/t.db" npm test` 全綠；起測試伺服器逐檔跑相關 API 測試後 `npm run seed`。
2. 業主 localhost smoke（三入口＋我的課表雙身分＋同行取消）。
3. Draft PR → 終審 → 合併；部署後 prod 開機 `member2_id` 欄自動補上（`addColumnIfMissing`）。
