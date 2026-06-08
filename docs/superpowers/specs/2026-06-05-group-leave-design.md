# 團課「今日請假」— 設計文件

日期：2026-06-05　分支：`feat/group-leave`（從 `main` 開出）

## 目標
my-schedule 頁的團課項目，依付款狀態切換動作按鈕：
- **待付款**（pending）：維持「放棄此訂單」（整筆 group-order 放棄，現況不變）。
- **已付款**（confirmed）：按鈕改為「**今日請假**」——把該場次標為請假，**不取消訂單**。

範圍：只做**團課**（registrations）；1對1 bookings 不在此次。

## 已確認的語意決策
- 請假 = **釋出名額並遞補候補**、**不退款**、**不取消訂單**、**不可逆**（v1）、**通知該堂課教練**。

## 資料模型
`registrations` 新增 `on_leave INTEGER NOT NULL DEFAULT 0`（status 維持 `'confirmed'`，避免動到 status 的 CHECK 約束）。
- `src/db/schema.js`：registrations CREATE TABLE 加欄位。
- `src/db/connection.js`：`addColumnIfMissing('registrations','on_leave','INTEGER NOT NULL DEFAULT 0')`。

## 名額語意（關鍵）
on_leave 的報名**不佔名額**（等同已釋出）：
- `groupOrderService.occupiedStmt`：條件加 `AND r.on_leave = 0`。
- `courseService.processDeadlines` 成班人數計算（`COUNT(*) … status='confirmed'`）加 `AND on_leave = 0`。
- 釋出後呼叫既有 `promoteWaitlist(sessionId)` 遞補（沿用，會發候補遞補通知 + 教練遞補通知）。

## 後端
新增 `takeLeavePublic({ registrationId, phone, name })`（`groupOrderService.js`）：
1. `getReg`；不存在 → 404 `registration_not_found`。
2. 本人驗證：`getUserByPhoneAndName` + `ownerMatches` + `user.id === reg.user_id`，否則 403 `forbidden`（與 cancelRegistrationPublic 同規格）。
3. `reg.status !== 'confirmed'` → 409 `not_confirmed`（只有已付款可請假；pending 走放棄、waitlisted 走取消）。
4. `reg.on_leave` 已為 1 → 409 `already_on_leave`。
5. 場次：不存在/cancelled → 409 `session_unavailable`；`nowLocal() >= session.start_at` → 409 `session_started`（開課前才可請假）。
6. `UPDATE registrations SET on_leave = 1 WHERE id = ?`（不改 status、不退款、不動 order）。
7. `promoteWaitlist(reg.session_id)`（釋名額後遞補）。
8. `notifyCourseCoach({ coachId: session.coach_id, sessionId, type:'course_member_leave_coach', vars:{ member_name:user.name, course_name:tpl.name, start_at:session.start_at } })`。

文案（`notifications.js` TEMPLATES 新增）：
```
course_member_leave_coach: {
  subject: '會員請假 - {{course_name}}',
  body: '🏖️ {{member_name}} 請假，不會出席你帶的「{{course_name}}」（{{start_at}}）。',
},
```

路由（`server.js`）：`POST /api/public/registrations/:id/leave`，body `{ phone, name }` → `svcTakeLeavePublic`。

## getPublicSchedule 回傳調整（registration 映射）
- 多回 `on_leave: !!r.on_leave`。
- 多回 `can_leave: r.status==='confirmed' && !r.on_leave && r.session_status==='open' && r.start_at > now`。
- `can_cancel` 加 `&& !r.on_leave`（已請假不再顯示取消）。
- `group_remaining` 計算排除 on_leave（`status==='confirmed' && !is_past && !on_leave`）。

## 前端 `public/my-schedule.js`
- `resolveStatus`：registration 若 `confirmed && on_leave` → label「請假」、badge `badge-completed`（灰）。
- `cancelButton`：
  - pending + order_id + !is_past → 放棄此訂單（不變）。
  - **`item.can_leave` → 「今日請假」按鈕**（`data-kind="leave" data-id`）。
  - 其餘 `!can_cancel` → 無按鈕；booking → 取消；registration(候補中) → 取消。
- `handleCancel`：新增 `kind==='leave'` → `POST /api/public/registrations/${id}/leave`；確認文案「確定要請假嗎？此堂將標為請假且不退費。」；錯誤碼對應（not_confirmed/session_started 等）友善訊息。

## 測試
新增 `tests/group-leave.test.js`：
- 已付款報名 → takeLeavePublic → `on_leave=1`、status 仍 `confirmed`、訂單未取消。
- 釋名額：請假後該場 `sessionOccupied` 減一；有候補者 → 被遞補（status pending + 通知）。
- 通知教練：coach user 收到 `course_member_leave_coach`。
- 本人驗證：錯姓名/電話 → 403。
- 非 confirmed（pending/waitlisted）→ 409 `not_confirmed`；重複請假 → 409 `already_on_leave`；開課後 → 409 `session_started`。
- `getPublicSchedule`：on_leave 項回 `on_leave=true`、`can_leave=false`、`can_cancel=false`；`group_remaining` 不含 on_leave。
- 回歸：未請假流程不受影響。
併入 `npm test`；最後跑多代理對抗式審查。

## 非目標
- 不做 1對1 請假、不做退款/補課/改期、不可取消請假（v1）。
