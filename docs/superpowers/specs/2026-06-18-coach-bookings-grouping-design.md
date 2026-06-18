# 教練後台「我的預約」依客人分組 + 可收合 — 設計文件

> 日期：2026-06-18
> 範圍：純前端（`public/coach.js` 的 `renderBookings` + `public/coach.html` 的 Nike overlay `<style>`）。後端不動。

## 問題
教練後台「我的預約」目前每筆預約一張卡，同一客人多堂個別課時卡片暴增、需長捲動，難讀難用（業主附截圖：許秀禎 3 堂、張簡碧玲 9 堂…全平鋪）。

## 已拍板決策（業主）
1. 同一客人 **≥2 堂 → 收合成一張群組卡**；收合時壓成**一列**：`姓名 · 下一堂日期 · 狀態 …… 共 N 堂 ›`。
2. **常駐顯示「最近一堂」**（收合時也看得到下一堂）。
3. 群組**依「下一堂最接近今天」由近到遠排序**。
4. 過去/未來**不分區**（混在一起，照現狀，只是改成分組）。
5. **點開某客人時，其餘客人卡片淡化**以聚焦。
6. 密度走「緊湊」版（已視覺確認的 mock）。

## 架構（純前端）
- 資料來源不變：`GET /api/coach/me/bookings{coachQuery()}` → 回 `b.*`（含 `id, member_id, start_at, status, session_type, paid_at, cancel_reason, note`）＋ `member_name`。**API、後端、其他流程皆不動。**
- 改 `renderBookings()`：先把清單**依 `member_id` 分組**，每組產生一張群組卡；其餘函式（`init`/`coachQuery`/`needsCoachSelection`/`onCoachChange` 等）維持。
- 樣式：在 `coach.html` 既有 `<style>`（Nike overlay）內新增 `.bk-*` 類別（沿用既有設計 token：天空藍細條、Archivo tabular 數字、`.nk-dot` 狀態點、`.nk-tag` 1對2）。既有 `.tab-bookings-card` 規則因 markup 改變而不再套用，保留不刪（惰性、零風險）。

## 分組 / 排序 / 錨點邏輯
對每位 `member_id` 的預約集合 `gs`：
- **active** = `status !== 'cancelled'`；**upcoming** = active 且 `new Date(start_at) > now`；**past** = active 且非 upcoming；**cancelled** = `status==='cancelled'`。
- **錨點（下一堂）** = upcoming 中最早者；若無 upcoming，則 past 中最近者（此時整張卡 `.is-allpast`、左條轉灰）；若連 past 都無（只剩 cancelled），錨點 = 最近的 cancelled。
- **共 N 堂** = `active.length`（不含已取消）。
- **群組內 body 排序**（展開時）：upcoming 升冪（最早在前）→ past 降冪（最近在前）→ cancelled 降冪（最後、灰字）。
- **群組之間排序**：有 upcoming 的群組在前，依錨點日期**升冪**（越接近今天越上面）；無 upcoming 的群組在後，依錨點日期**降冪**。

## 卡片型態
- **群組（active ≥ 2）**：收合 head 一列 = `姓名 [1對2 if 該客有1對2] · {fmtSlot(錨點)} {狀態點} …… 共 N 堂 ›`；點 head 展開 body，列出全部堂（每列：`{fmtSlot} [1對2] {狀態點}` + 該堂「緊急取消」鈕）。
  - 「1對2」標：客人**任一**堂為 `1on2` 時，姓名旁顯示一次；每個 body 列再依該堂 `session_type` 顯示自己的標。
  - body 內 past 列：灰字、尾標「· 已結束」、**無**緊急取消鈕；cancelled 列：灰字、標「· 已取消（原因）」、無鈕。
- **型態判定以該客人預約「總筆數」`gs.length` 為準**：
  - `gs.length === 1` → 渲染為單列（`.bk-single`）= `姓名 · {fmtSlot} {狀態點}` ＋（upcoming 且非 cancelled 時）緊急取消鈕；無膠囊/箭頭、head 不可點。past/cancelled 的單筆 → 單列、灰、無鈕。
  - `gs.length >= 2` → 群組卡（可收合），即使其中含已取消（展開可看），避免資訊遺失。「共 N 堂」仍只算 active。

## 收合與聚焦
- **預設收合**：群組卡預設不展開。
- **展開狀態保留**：模組級 `const expandedMembers = new Set()`（存 member_id）。點 head → toggle 該 member_id 並 toggle `.open`、同步更新容器聚焦狀態。`renderBookings()` 重繪時，對 member_id ∈ `expandedMembers` 的群組補上 `.open`（取消某堂後重繪不會把展開的組收起）。
- **切換教練**：`onCoachChange()` 內清空 `expandedMembers`（換教練重新開始）。
- **聚焦淡化**：群組列表外層容器 `#bk-list`；有任一 `.bk-group.open` 時，對容器加 class `has-open`（JS 切換，不用 CSS `:has()` 以求相容）。CSS：`#bk-list.has-open .bk-group:not(.open){ opacity:.4 }`，hover 時回 `.72`，`.bk-group{ transition:opacity .18s }`。每次 toggle 後重算：`listEl.classList.toggle('has-open', listEl.querySelector('.bk-group.open') != null)`。

## 日期格式
新增 `fmtSlot(startAt)`：`'2026-06-21T17:00:00' → '06/21 17:00'`（`startAt.slice(5,16).replace('T',' ').replace('-','/')`）。用於錨點與 body 列（省年、緊湊）。狀態：`paid_at ? 已確認(.nk-dot ok) : 待確認(.nk-dot warn)`。

## 取消行為（不變）
每個 body 列／單列的「緊急取消」沿用現行：`prompt('取消原因（會通知會員）：')` → `DELETE /api/bookings/{id}{coachQuery()}` body `{reason}` → 成功 toast → `renderBookings()` 重繪（`expandedMembers` 保留展開狀態）。

## 邊界情況
- 客人全部已過：群組仍顯示、`.is-allpast` 灰條、錨點為最近一堂、排在有 upcoming 的群組之後。
- 同一客人混 1對1/1對2：姓名旁出現一次「1對2」標（只要有任一堂是），各 body 列顯示各自的標。
- `member_name` 顯示一律 `escapeHtml`。
- 空清單：沿用現行「沒有預約」。
- 管理者用下拉切教練：分組同樣適用（共用 renderBookings）；切換時清空展開狀態。

## 測試
無前端測試框架 → **人工瀏覽器煙霧測試**（實作後由控制端用瀏覽器驗證）：啟動 server、以 admin 登入、選有多堂客人的教練 →
1. 同一客人 ≥2 堂收合成一列、顯示「下一堂 + 共 N 堂」、依下一堂排序。
2. 點開 → 列出全部堂、其餘卡片淡化；再點收合、淡化解除。
3. 展開狀態下對某堂「緊急取消」→ 重繪後該組仍展開、堂數/排序更新。
4. 單堂客人為一列、直接可取消。
5. 一般教練（非 admin）登入同樣正常；admin 切換教練後展開狀態重置。
不需 server 的部分：`node --check public/coach.js`、`grep` 確認 markup/類別。

## 清理
實作完成前移除暫存預覽檔 `public/_mock_coach_bookings.html`（不進版控）。

## 不做（YAGNI）
- 不動後端/API/通知/其他分頁。
- 不做過去↔未來分區（業主選不分區）。
- 不用 CSS `:has()`（改 JS 切 class 求相容）。
- 不加搜尋/篩選。
