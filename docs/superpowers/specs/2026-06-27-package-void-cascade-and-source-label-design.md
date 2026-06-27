# 方案作廢連動取消預約 + 編輯預約來源顯示方案 — 設計

**日期**：2026-06-27
**分支**：`feat/package-void-cascade-and-source-label`

## 目標

修正「客人方案」與「教練後台登錄預約行事曆」之間的兩個缺口：

1. **作廢連動取消**：管理者在後台會員資料把某個方案「作廢」時，該方案名下**所有未取消的預約**（含已過去的）要一併自動取消，不再殘留在登錄行事曆上。
2. **來源顯示方案**：編輯預約彈窗的「來源」目前只顯示「方案登錄」四個字；改成詳細列出是**哪一個方案**（因為一個客人身上可能有多個方案）。

## 現況（探查結論）

- `customer_packages` 用 `archived_at` 軟刪除作廢；無「名稱」欄位，方案以「類型(一對一/一對二) + 堂數 + 到期 + 備註」辨識。
- `archivePackage()`（`src/services/packageService.js:137`）目前**只蓋 `archived_at`，完全不動該方案名下的 `bookings`**。
- `bookings` 無 `source` 欄位；「來源」由 `package_id` 是否有值推導。
- `bookings.package_id` 連動：取消預約 `cancelBooking()` 會回補堂數（`refundPackageForBooking`）；登錄 `createCoachRegister()` 扣堂。
- 編輯彈窗來源邏輯在 `public/coach.js:756`：`b.package_id ? '方案登錄' : …`。
- 行事曆資料端點 `GET /api/coach/week` →`getCoachWeek()`（`src/services/coachCalendarService.js`）的 SQL **只帶 `package_id`，沒 JOIN `customer_packages`**，前端拿不到方案細節。
- `packageService` 已被 `bookingService` 反向 import（`refundOne/deductOne/getPackage`）→ 連動取消必須在 `packageService` 內**自帶 inline SQL**，不可從 `bookingService` import，避免循環依賴。

## 決策（已與業主確認）

1. **取消範圍**：取消該方案名下**所有 `status='confirmed'` 的預約**（含已過去的），不限未來。
2. **通知**：**靜默取消**，不發 LINE/Email。
3. **不回補堂數**：連動取消不呼叫堂數回補（堂數隨作廢方案一起消滅，作廢快照保留當下 `remaining_sessions`）。
4. **方案標示格式**：`方案登錄 · {一對一/一對二} 剩{remaining}/{total} · 建立{yyyy/mm/dd} ·「{備註}」`
   - 用**方案建立時間 `created_at`**（非到期日），格式 `yyyy/mm/dd`。
   - 備註、建立時間缺值時各自省略；若方案資料缺失（防禦）回退為「方案登錄」。
5. **還原不復原預約**：`restorePackage()` 維持只 un-archive 方案，**不**還原已連動取消的預約（非目標）。

## 功能一：作廢連動取消

### 後端 `src/services/packageService.js`

新增兩個 prepared statement（檔案層級）：

```js
const listConfirmedBookingsByPackageStmt = db.prepare(
  `SELECT id FROM bookings WHERE package_id = ? AND status = 'confirmed'`
);
const cancelBookingsByPackageStmt = db.prepare(
  `UPDATE bookings SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?
   WHERE package_id = ? AND status = 'confirmed'`
);
```

改寫 `archivePackage`（加 `actorId`、包進 `tx()`、回 `cancelledBookingIds`）：

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

- 不回補堂數、不發通知、不動 redemption（方案登錄的預約不掛折扣碼 redemption）。
- 天然冪等：對已作廢方案再呼叫 → archive UPDATE 與 cancel UPDATE 皆無命中 → `cancelledBookingIds=[]`。
- 回傳保留 `getPackage()` 全部欄位（含 `archived_at`/`is_valid`）→ 向後相容，只多一個 `cancelledBookingIds`。

### 後端 route `src/server.js`

```js
app.post('/api/coach/packages/:id/archive', requireCoach, asyncHandler((req, res) => {
  const r = svcArchivePackage(Number(req.params.id), req.user.id);
  for (const id of r.cancelledBookingIds) syncBookingCancel(id); // commit 後副作用：刪日曆事件、不 await
  res.json(r);
}));
```

（沿用既有 `for (const id of r.cancelled) syncBookingCancel(id)` 模式；`syncBookingCancel` 已 import。）

### 前端 `public/admin.js`（`renderMemberPackages` 的 archive 分支）

- 確認字改為連動警告：
  `'確定作廢此方案？此方案名下所有未取消的預約將一併取消（不可復原），剩餘堂數保留紀錄。'`
- 捕捉回傳、toast 帶取消筆數：
  ```js
  const r = await api(`/api/coach/packages/${id}/archive`, { method: 'POST' });
  toast(r.cancelledBookingIds?.length ? `已作廢，連動取消 ${r.cancelledBookingIds.length} 筆預約` : '已作廢', 'success');
  ```

## 功能二：編輯預約來源顯示方案

### 後端 `src/services/coachCalendarService.js`

`BK_COLS` 加 5 欄、兩條 week query 加 `LEFT JOIN customer_packages`：

```js
const BK_COLS = `b.id, b.coach_id, b.start_at, b.end_at, b.session_type, b.package_id, b.paid_at, b.discount_code,
       u.name AS member_name, c.display_name AS coach_name,
       cp.session_type AS pkg_session_type, cp.remaining_sessions AS pkg_remaining,
       cp.total_sessions AS pkg_total, cp.created_at AS pkg_created_at, cp.note AS pkg_note`;
```

`weekBookings` / `weekAllBookings` 的 FROM 後各加：
`LEFT JOIN customer_packages cp ON cp.id = b.package_id`

（LEFT JOIN：非方案預約 `package_id` 為 NULL → pkg_* 全 NULL；additive，不影響既有欄位/排序。）

### 前端 `public/coach.js`

新增 helper（放在 `renderBkeditBody` 附近；可引用稍後宣告的 `PKG_TYPE`，因僅執行期呼叫）：

```js
function pkgSourceLabel(b) {
  if (!b.pkg_session_type) return '方案登錄';
  const t = PKG_TYPE[b.pkg_session_type] || b.pkg_session_type;
  const created = b.pkg_created_at ? ` · 建立${String(b.pkg_created_at).slice(0, 10).replace(/-/g, '/')}` : '';
  const note = b.pkg_note ? ` ·「${escapeHtml(b.pkg_note)}」` : '';
  return `方案登錄 · ${escapeHtml(t)} 剩${escapeHtml(String(b.pkg_remaining))}/${escapeHtml(String(b.pkg_total))}${created}${note}`;
}
```

`renderBkeditBody` 第 756 行改：
```js
const source = b.package_id ? pkgSourceLabel(b) : (b.discount_code ? `折扣碼 ${escapeHtml(b.discount_code)}` : '一般預約');
```

## 測試

- **`tests/package-service.test.js`（擴充）**：
  - 作廢方案會把名下所有 confirmed 預約改 cancelled（含過去時段）、設 `cancel_reason='方案作廢連動取消'` 與 `cancelled_by`。
  - **不回補堂數**：作廢前後該方案 `remaining_sessions` 不變。
  - 不動其他方案、不動已 cancelled 的預約。
  - 回傳含 `cancelledBookingIds`（陣列、內容正確）。
  - 冪等：再次作廢 → `cancelledBookingIds=[]`。
  - 還原不還原預約（預約仍為 cancelled）。
- **`tests/package-api.test.js`（擴充）**：`POST /api/coach/packages/:id/archive` 200、回 `cancelledBookingIds`、DB 中對應 booking 變 cancelled。
- **`tests/coach-week-all.test.js`（擴充）**：`getCoachWeek` 對方案預約回 `pkg_session_type/pkg_remaining/pkg_total/pkg_created_at/pkg_note`；非方案預約這些為 null。

## 影響檔案

- `src/services/packageService.js`（archivePackage 改寫 + 2 stmt）
- `src/server.js`（archive route 帶 actorId + syncBookingCancel 迴圈）
- `src/services/coachCalendarService.js`（BK_COLS + 2 JOIN）
- `public/admin.js`（confirm 文案 + toast 筆數）
- `public/coach.js`（pkgSourceLabel + 第 756 行）
- `tests/package-service.test.js`、`tests/package-api.test.js`、`tests/coach-week-all.test.js`

## 非目標

- 不改方案 schema（不加名稱欄位）。
- 不還原連動取消的預約（restore 只 un-archive 方案）。
- 不改「我的預約」分組列表（`/api/coach/me/bookings`）的來源顯示；本次只動登錄行事曆編輯彈窗。
- 不改其他取消流程的回補行為。
