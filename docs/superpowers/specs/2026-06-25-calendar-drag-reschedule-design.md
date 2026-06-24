# 登錄週曆 拖拉改時段（像 Google 行事曆）— 設計文件

> 日期：2026-06-25
> 範圍：單一 PR，**純前端**（coach.js 拖曳控制器 + CSS）。重用 PR3 既有 `PATCH /api/coach/bookings/:id/reschedule`，後端不動。
> 業主已於 brainstorming 拍板（見「已拍板決策」）。

## 問題
登錄預約的週曆目前只能「點預約塊→編輯彈窗→選日期+整點」改時段。業主要像 Google 行事曆：直接**拖拉預約塊**到新時段，且**真的連動落 DB**（reschedule）。

## 背景（已查證，含 file:line）
- 週曆 `renderRegister()`（`public/coach.js`）以 CSS grid 畫格：空格 `.reg-open[data-slot="YYYY-MM-DDTHH:00:00"]`（點擊→登錄，僅 `canRegister` 時，否則 toast）；預約塊 `.reg-bk[data-bk="<id>"]`（點擊→`openBookingEditModal`）；團課 `.reg-gp`（唯讀）；多筆同格 `.reg-multi`。click 綁定：`reg-open` → 登錄、`reg-bk` → 編輯（coach.js:625-633）。
- reschedule 端點（PR3）：`PATCH /api/coach/bookings/:id/reschedule { startAt }`（`requireCoach`，server.js:883）→ `rescheduleBooking`（同教練、`!isAdmin` 須本人教練否則 403、衝突 `clashOtherBooking`/UNIQUE→409 `slot_taken`、保留 member/package/付款、改 start/end+60、通知 `booking_rescheduled`）；route 後置 `syncBookingCancel(id).then(()=>syncBookingCreate(id))` 刷新 gcal。
- `data.bookings` 在 renderRegister 內可查（編輯彈窗即用 `data.bookings.find(b=>b.id===…)`）；`api`/`toast`/`escapeHtml`/`$` 在 coach.js 可用。

## 已拍板決策（業主，brainstorming 2026-06-25）
1. **桌機 + 手機觸控都可拖** → 用 **Pointer Events**（統一 mouse/touch/pen），非 HTML5 DnD（觸控不支援）。
2. **全覽（全部教練）也可拖，保留原教練**（拖曳只改時間、不改授課教練；後端守門：一般教練只能拖自己的、管理者任一）。
3. **只搬時段**（固定 60 分，不拉邊改時長）。
4. （小決策）**不做邊緣自動捲動**（v1 在可視範圍內拖放）；不透過拖曳改授課教練。

## 架構（純前端，coach.js + CSS）

### 拖曳控制器（Pointer Events）
- 在 `renderRegister` 收尾，對每個 `.reg-bk[data-bk]` 綁 `pointerdown`（取代原本的 `.reg-bk` click 綁定——tap 與 drag 在 pointer 流程內統一判斷）。
- 狀態機（模組層 `regDrag` 物件或閉包）：
  - `pointerdown`：記 startX/Y、bookingId、來源元素；`el.setPointerCapture(e.pointerId)`；尚未進入拖曳（先當可能是 tap）。
  - `pointermove`：位移 > **8px** → 進入拖曳模式：
    - 建浮動 ghost（clone 來源塊文字、`position:fixed`、跟隨 `e.clientX/Y`、`pointer-events:none`、`z-index` 高）。
    - 來源塊加 `.reg-bk-dragging`（半透明）。
    - `document.elementFromPoint(x,y)` 找游標下元素 → 最近的 `.reg-open[data-slot]` → 加 `.reg-drop-hover` 高亮（換格時移除舊高亮）。
  - `pointerup`：
    - 若**未進入拖曳**（位移 < 8px）＝ tap → `openBookingEditModal(該 booking)`（行為不變）。
    - 若已拖曳：取游標下 `.reg-open[data-slot]`；有 → `doDragReschedule(bookingId, slot)`；無（落非空格/格外）→ 取消（清 ghost、復原）。
  - `pointercancel`：清理、復原。
- `touch-action: none` 設在 `.reg-bk`（觸控時按住塊不會捲頁；快速 tap 仍開編輯）。其餘頁面照常可捲。

### 落 DB
- `doDragReschedule(bookingId, startAt)`：
  ```js
  try { await api(`/api/coach/bookings/${bookingId}/reschedule`, { method:'PATCH', body:{ startAt } });
        toast('已改期', 'success'); renderRegister(); }
  catch (e) { const m={ slot_taken:'該時段已被預約', forbidden:'無權限改此預約', invalid_start_at:'時間格式錯', already_cancelled:'預約已取消' };
              toast(m[e.data?.error] || `改期失敗：${e.message}`, 'error'); renderRegister(); }
  ```
  保留原教練（reschedule 用 booking 自身 coach；body 不帶 coachId）。成功/失敗都 `renderRegister()` 重繪（失敗＝視覺還原）。

### CSS（my-schedule 無關；加在 coach 載入的 style.css 或 coach.html `<style>`）
- `.reg-bk{ touch-action:none; cursor:grab; }` `.reg-bk:active{ cursor:grabbing; }`
- `.reg-bk-dragging{ opacity:.4; }`
- `.reg-drop-hover{ outline:2px dashed var(--brand-600); outline-offset:-2px; background:var(--brand-50); }`
- `.reg-drag-ghost{ position:fixed; pointer-events:none; z-index:9999; background:#dbeafe; color:#1e3a8a; font-size:11px; border-radius:6px; padding:4px 8px; box-shadow:0 6px 20px rgba(0,0,0,.18); opacity:.95; }`

### 與既有點擊的關係
- `.reg-bk`：改由 pointer 流程處理（tap→編輯、drag→reschedule）；**移除**原 `.reg-bk` 的 `click` 綁定避免 drag 後誤觸發編輯。
- `.reg-open`：click→登錄（不變）；同時作為拖曳放置目標（drag 時以 elementFromPoint 命中，不靠 click）。
- 團課 `.reg-gp`：不綁拖曳（唯讀）。

## 安全/守門
- reschedule 後端守門沿用 PR3（`requireCoach`＋`!isAdmin` 須本人教練→403；衝突→409）。前端拖曳不繞過：一般教練拖他人預約後端會 403→toast 還原。
- 拖曳保留原教練（不送 coachId），不會誤改授課教練。

## 不動
- reschedule 端點/service（PR3）；編輯彈窗（tap 仍開）；登錄/編輯/全覽/方案等其他功能；團課。

## 測試
- 後端 reschedule 已有測試（PR3 `booking-edit*`），不重測。
- 前端拖曳：瀏覽器 smoke（dispatch PointerEvent down→move(過閾值)→up 於目標空格）→ 斷言：預約塊移到新格、`GET /api/coach/week`/DB 該 booking start_at 已更新；衝突情境（拖到同教練已佔時段）→ toast slot_taken 且 start_at 不變。tap（未移動）→ 開編輯彈窗。
- 回歸：點擊登錄/編輯仍正常；`node --check public/coach.js`。

## 收尾
- 瀏覽器 smoke（含一段拖曳示範截圖/GIF 給業主預覽）；移除任何暫存 mock。

## 不做（YAGNI）
- 不拉邊改時長（固定 60 分）。
- 不做拖曳邊緣自動捲動（v1 可視範圍內拖放）。
- 不透過拖曳改授課教練（保留原教練）。
- 團課塊不可拖。
- 不改後端。
