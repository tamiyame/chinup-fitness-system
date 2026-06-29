# 編輯預約彈窗：顯示電話 + 取消全部預約（循環群組）— 設計

**日期**：2026-06-29
**分支**：`feat/bkedit-phone-and-cancel-group`

## 目標
教練後台登錄行事曆的「編輯預約」彈窗兩項加強：
1. **顯示客人電話**：客人姓名旁加顯示電話。
2. **取消全部預約**：在「取消預約」（取消單筆）後面新增「取消全部預約」按鈕，取消這筆預約**所屬循環群組**的全部預約。

## 業主拍板決策（AskUserQuestion）
1. **範圍**＝這筆所屬的**循環群組**（`recurring_group_id` 相同的那批）；若這筆不是循環登錄則無此鈕。
2. **時間**＝**含過去全部取消**（不限未來）。
3. **跨教練**＝**只取消這筆預約的教練名下**（循環群組本來就同一教練，天然吻合；管理者可代理但仍只動該教練名下）。
4. （設計時確認）**回補堂數**：比照單筆取消，每筆取消都 `refundPackageForBooking`（含過去筆也回補）。
5. （設計時確認）**通知**：整批彙整成一則（沿用既有群組取消模板），不逐筆轟炸。

## 現況
- week 端點 `getCoachWeek`（`coachCalendarService.js`）的 `BK_COLS` 目前**沒帶** `member_phone`、`recurring_group_id`（也沒 member_id）。
- 編輯彈窗 `renderBkeditBody`（`coach.js:762`）客人行只有姓名；按鈕區 `bke-actions`（:775-779）有 改時段/改客人方案/取消預約。
- 單筆取消 `doBkCancel`（coach.js）→ `DELETE /api/bookings/:id`（admin 帶 `?coachId=` 走 adminOnBehalf）→ `cancelBooking`（回補堂數、通知對方）。
- 既有 `cancelBookingAdminGroup`（bookingService:662）依 `recurring_group_id` 取消，但**只取消 `paid_at IS NULL`（未付款）**，而方案登錄預約建立即有 `paid_at` → **不適用**，需新做。
- 既有不變量：非管理者教練只能動自己名下預約（cancelBooking:163 / reschedule:598 / reassign:620 對非 admin 一律 403）。
- bookings 有 `recurring_group_id`（schema.js:207，循環登錄 `createCoachRegister` 設定，>1 筆才設）。

## 功能一：顯示電話

### 後端 `src/services/coachCalendarService.js`
`BK_COLS` 加 `u.phone AS member_phone`（與既有 `member_name` 同一個 `JOIN users u`）。

### 前端 `public/coach.js`（`renderBkeditBody`）
客人行：
```js
<div><b>客人：</b>${escapeHtml(b.member_name)}${b.member_phone ? `　${escapeHtml(b.member_phone)}` : ''}</div>
```

## 功能二：取消全部預約（循環群組）

### 後端 `src/services/coachCalendarService.js`
`BK_COLS` 加 `b.recurring_group_id`（前端判斷按鈕顯示）。

### 後端 `src/services/bookingService.js` — 新函式
```js
export function cancelCoachGroup({ bookingId, actorUserId, isAdmin = false, reason = null }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    const coach = getCoachStmt.get(b.coach_id);
    // 授權：非管理者只能取消自己名下（與 reschedule/reassign 一致）
    if (!isAdmin && (!coach || coach.user_id !== actorUserId)) throw new ApiError(403, 'forbidden');
    // 範圍：有循環群組 → 該群組同教練全部 confirmed（含過去）；無群組 → 退化成只取消這筆
    const rows = b.recurring_group_id
      ? db.prepare("SELECT * FROM bookings WHERE recurring_group_id=? AND coach_id=? AND status='confirmed' ORDER BY start_at ASC").all(b.recurring_group_id, b.coach_id)
      : (b.status === 'confirmed' ? [b] : []);
    if (!rows.length) throw new ApiError(409, 'already_cancelled');
    const now = nowLocal();
    for (const r of rows) {
      cancelBookingStmt.run(now, actorUserId, reason, r.id);
      refundPackageForBooking(r);                       // 含過去筆也回補（業主拍板）
      releaseRedemption({ kind: 'booking', refId: r.id });
    }
    // 整批彙整通知（沿用群組取消模板）
    const memberRow = getUserNameStmt.get(rows[0].member_id);
    if (coach && memberRow) {
      const startFmt = `${fmtDateForLine(rows[0].start_at)} 起共 ${rows.length} 堂`;
      notify({ userId: rows[0].member_id, sessionId: null, type: 'booking_cancelled_by_shop',
        vars: { coach_display_name: coach.display_name, start_at: startFmt, reason_suffix: '' } });
      if (coach.user_id !== actorUserId) {
        notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_shop_coach',
          vars: { member_name: memberRow.name, start_at: startFmt } });
      }
    }
    return { ok: true, cancelled: rows.map(r => r.id) };
  });
}
```
- `getBookingStmt`/`getCoachStmt`/`getUserNameStmt`/`cancelBookingStmt`/`refundPackageForBooking`/`releaseRedemption`/`notify`/`fmtDateForLine` 皆為 bookingService 既有。
- 範圍鎖 `coach_id=b.coach_id` → 即使資料異常使群組跨教練，也只動這筆的教練名下（吻合決策三）。

### 後端 route `src/server.js`
```js
app.post('/api/coach/bookings/:id/cancel-group', requireCoach, asyncHandler((req, res) => {
  const { reason } = req.body || {};
  const r = svcCancelCoachGroup({ bookingId: Number(req.params.id), actorUserId: req.user.id, isAdmin: !!req.user.is_admin, reason: (reason || '').trim() || null });
  for (const id of r.cancelled) syncBookingCancel(id); // commit 後副作用：逐筆刪日曆事件、不 await
  res.json(r);
}));
```
- `requireCoach` + service 內 isAdmin/擁有權判斷（與 reschedule/reassign route 同模式）。**不需** `?coachId=`（service 直接用 token 的 is_admin）。

### 前端 `public/coach.js`
`renderBkeditBody` 按鈕區，在「取消預約」後依 `recurring_group_id` 條件加鈕：
```js
<button id="bke-cancel-btn" class="btn-danger">取消預約</button>
${b.recurring_group_id ? '<button id="bke-cancel-group-btn" class="btn-danger">取消全部預約</button>' : ''}
```
綁定：
```js
$('bke-cancel-btn').onclick = doBkCancel;
const cg = $('bke-cancel-group-btn'); if (cg) cg.onclick = doBkCancelGroup;
```
新 handler：
```js
async function doBkCancelGroup() {
  const b = bkeditBooking;
  if (!confirm(`確定取消「${b.member_name}」這筆所屬循環的全部預約？此循環（含已過去）的所有未取消預約將一併取消，並回補方案堂數。`)) return;
  try {
    const r = await api(`/api/coach/bookings/${b.id}/cancel-group`, { method: 'POST', body: { reason: '後台取消（全部）' } });
    toast(`已取消全部預約（${r.cancelled?.length || 0} 筆）`, 'success');
    bkeditClose(); renderRegister();
  } catch (e) {
    const m = { forbidden: '無權限取消此預約', booking_not_found: '查無此預約', already_cancelled: '此循環已無可取消預約' };
    toast(m[e.data?.error] || `取消失敗：${e.data?.error || e.message}`, 'error');
  }
}
```

## 測試
- **`tests/coach-week-all.test.js`（擴充）**：week bookings 帶 `member_phone`、`recurring_group_id`。
- **`tests/booking-edit.test.js`（擴充，unit）**：`cancelCoachGroup`
  - 循環群組（含過去 + 未來）全部 confirmed → 全變 cancelled、每筆回補堂數、回 `cancelled` 含全部 id。
  - 已 cancelled 的不重複、不在回傳。
  - 非管理者教練取消他教練的群組 → 403 forbidden；管理者可取消。
  - 無 `recurring_group_id` → 只取消這一筆。
  - 範圍鎖教練：同群組若混入他教練 booking（裸 INSERT 模擬）不被取消。
- **`tests/booking-edit-api.test.js`（擴充，api）**：`POST /api/coach/bookings/:id/cancel-group` → 200 + `cancelled` + DB 變 cancelled；非該教練的一般教練 token → 403。

## 影響檔案
- `src/services/coachCalendarService.js`（BK_COLS +2 欄）
- `src/services/bookingService.js`（新 `cancelCoachGroup`）
- `src/server.js`（新 route + export 接線）
- `public/coach.js`（客人電話行 + 取消全部鈕 + handler）
- `tests/coach-week-all.test.js`、`tests/booking-edit.test.js`、`tests/booking-edit-api.test.js`

## 非目標
- 不改單筆「取消預約」行為。
- 不跨教練取消（即使管理者）。
- 不改 schema。
- 不取消團課報名（只動登錄行事曆的一對一預約群組）。
- 無 `recurring_group_id` 的單筆不顯示「取消全部預約」鈕（避免與「取消預約」重複）。
