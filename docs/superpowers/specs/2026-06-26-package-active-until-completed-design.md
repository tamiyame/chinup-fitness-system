# 方案顯示到「課全上完」才消失 + 卡片三數字 — 設計文件

> 日期：2026-06-26
> 範圍：單一 PR。後端 `packageService` 新函式 + `getPublicSchedule` 改用它；前端 `my-schedule` 卡片改三數字。無 schema 變更。
> 業主已拍板（見「已拍板決策」），並已預覽卡片新版同意。

## 問題
客人「我的方案」(`getPublicSchedule`) 只列 `is_valid` 方案（`remaining_sessions > 0`）。教練把堂數**全部登錄(扣抵)完**後 `remaining_sessions=0` → 方案立即從「我的方案」消失，即使那些課都還沒上。客人查不到自己其實還有課要上。

## 已拍板決策（業主，2026-06-26）
1. 「我的方案」要持續顯示，**直到該方案所有課都「已結束(上完)」才消失**（remaining=0 不影響顯示，只要還有未上完的課就持續列出）。
2. **只影響客人端「我的課表」顯示**；後台登錄/改方案選單仍用嚴格 `remaining_sessions>0`（才扣得到）。
3. 卡片顯示三數字：**共(total) / 已上完(completed) / 尚餘(=共−已上完)**；右側大字＝尚餘、左側 meta＝「已上完 X · 共 N 堂」、進度條＝已上完比例。

## 背景（已查證，含 file:line）
- `packageService.js`：`VALID_EXPR`（行 11）＝`archived_at IS NULL AND remaining_sessions>0 AND (expires_at IS NULL OR expires_at>=?今天)`；`listValidPackagesForMember`（行 71，**嚴格**，用於登錄/改方案選單與目前的我的方案）；`deductOne`(登錄扣)/`refundOne`(取消回補)。`db` 已 import。
- `groupOrderService.getPublicSchedule`（我的課表）：`now = nowLocal()`（'YYYY-MM-DDTHH:MM:SS'）；bookings 取 `status != 'cancelled'`、`is_past = start_at < now`；目前 `packages = listValidPackagesForMember(user.id).map(p => ({session_type,total_sessions,used_sessions:total−remaining,remaining_sessions,expires_at}))`。`nowLocal` 已 import。
- `bookings.package_id`（schema:208，FK→customer_packages，nullable）＝該預約扣的方案。登錄(`createCoachRegister`)、改方案(`reassign`) 設定；取消→`status='cancelled'`＋`refundOne`（回補 remaining）。
- 前端 `my-schedule.js` `render()`（行 ~362-388）：`#packages-section`，每方案 `.pk-card`（pk-type / pk-meta「已登錄 X · 共 N 堂」/ pk-bar fill=used/total / pk-remain「剩餘 / remaining / 堂」）。CSS `pk-*` 於 `my-schedule.html`（行 146-157）。
- 既有測試：`tests/my-schedule-packages.test.js`（unit, getPublicSchedule packages 投影）、`tests/my-schedule-packages-api.test.js`（api）。

## 架構

### 後端
**新 `packageService.listScheduleViewPackages(memberId, now)`**（now＝'YYYY-MM-DDTHH:MM:SS' 字串）：
- 取該會員**未作廢**方案（`archived_at IS NULL`）。
- 一支 grouped 查詢統計每方案的 confirmed 預約：
  ```sql
  SELECT package_id,
         SUM(CASE WHEN start_at <  ? THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN start_at >= ? THEN 1 ELSE 0 END) AS upcoming
  FROM bookings
  WHERE member_id = ? AND status = 'confirmed' AND package_id IS NOT NULL
  GROUP BY package_id
  ```
  （`completed`＝已結束/上完；`upcoming`＝已登錄待上。`<`／`>=` 與既有 `is_past = start_at < now` 一致。）
- **顯示條件**（per package）：`upcoming > 0` **OR**（`remaining_sessions > 0` AND 未過期）。即「嚴格有效 ∪ 還有未來課」。全部上完(`completed==total`、`upcoming==0`)＝已結束→排除；過期且無未來課→排除。
- 投影**安全欄位**：`{ session_type, total_sessions, completed_sessions: completed, remaining_sessions: total_sessions − completed, expires_at }`。`remaining_sessions` 在此投影**重新定義為「尚餘(尚未上完)」＝共−已上完**（此投影只供我的課表卡片消費）。不洩 amount/id/discount_code/member_id。
- 排序沿用：未過期/早到期優先、再 created_at。

**`getPublicSchedule`**：把 `packages = listValidPackagesForMember(...).map(...)` 改為 `packages = listScheduleViewPackages(user.id, now)`。其餘（bookings/regs/items/remaining 計數）不動。

### 前端（`my-schedule.js` + `my-schedule.html`）
- 卡片改用新投影：
  - pk-meta：`已上完 ${completed_sessions} · 共 ${total_sessions} 堂${expires_at?…}`
  - pk-bar fill：`completed_sessions / total_sessions * 100`%
  - pk-remain 大字：`remaining_sessions`（＝尚餘），標籤 `pk-rtop` 文案改「**尚餘**」
- `#packages-section` 顯示/隱藏邏輯不變（`packages.length` 決定）；只要後端有回就顯示。

## 安全/權限
- 投影只回安全欄位（同 PR5 慣例）。`getPublicSchedule` 身份驗證(phone+name)不變。

## 不動
- `listValidPackagesForMember`（嚴格）與所有登錄/改方案/coach 方案清單路徑（coach register/reassign 走 `GET /api/coach/packages`＝`listPackagesForMember`，前端以 `p.is_valid` 過濾，is_valid 內含 `remaining_sessions>0`）——與 `getPublicSchedule` 無關，**不受本 PR 影響**。
- `deductOne`/`refundOne`/扣抵時機、schema、其他頁面。

## 測試
- `tests/my-schedule-packages.test.js` **改寫/遷移**（既有斷言的舊投影 used_sessions==3 等屬刻意行為變更，一併移除；不另開新檔）：建會員+方案+真實 bookings(不同狀態)，驗 `getPublicSchedule.packages`：
  - 全部登錄完(remaining=0)但預約都在**未來** → 方案仍出現，`completed_sessions=0`、`remaining_sessions=total`。
  - 部分已上完 → `completed_sessions`/`remaining_sessions(=total−completed)` 正確。
  - 全部已上完(預約都過去) → 方案**不出現**（已結束）。
  - 過期且無未來課 → 不出現；過期但有未來課 → 出現。
  - 取消的預約不計入 completed/upcoming。
- `tests/my-schedule-packages-api.test.js` **改寫/遷移**：api 回傳含上述新欄位/情境（移除舊 used_sessions 斷言）。
- 前端 `node --check public/my-schedule.js`；瀏覽器 smoke（建方案→登錄未來課→我的課表查詢→方案仍在、尚餘正確；課過去後→消失）。

## 不做（YAGNI）
- 不改後台登錄/改方案選單邏輯、不改扣抵/回補。
- 不加方案「已結束」歷史列表（只是不顯示）。
- 無 schema 變更。
