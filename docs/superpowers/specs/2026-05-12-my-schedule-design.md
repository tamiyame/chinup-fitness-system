# Phase 3A · Unified /my-schedule Design Spec

**Date:** 2026-05-12
**Branch:** `feature/my-schedule`
**Phase:** 3A of 3 (Phase 3 split into 3A unified schedule · 3B group mobile UI · 3C LINE/Push)
**Status:** Draft for review

---

## 1. Goal

合併現有的兩個「我的」頁面（`my.html` 團課報名、`my-bookings.html` 一對一預約）成單一 `/my-schedule` 頁，並以時間軸 + tab 提供更直覺的「下一個要去什麼」體驗。

## 2. In Scope

- 新前端頁 `/my-schedule.html` + `/my-schedule.js`，手機優先
- 新後端 endpoint `GET /api/my/schedule`，統一格式回傳一對一與團課
- 新後端 service module `src/services/myScheduleService.js`（`schedule.js` 名稱已被 template-expansion 佔用）
- 舊頁 `public/my.html` + `public/my-bookings.html` + `public/my-bookings.js` 刪除
- 舊 URL 301 redirect 到 `/my-schedule`（`/my.html`、`/my-bookings.html` 兩條）
- 跨 page navbar 文字更新：「我的報名」+「我的一對一」合併成「我的課表」
- `public/coaches.js:159` 預約成功跳轉改 `/my-schedule`
- `public/courses.js` 兩條 comment 提到 `my.html` 改成 `my-schedule`
- 後端測試：`tests/my-schedule-api.test.js`（API 合約） + `tests/my-schedule-routing.test.js`（redirect）

## 3. Out of Scope

- 舊 `/api/my/bookings` + `/api/my/registrations` endpoint **不刪**（測試與其他可能 caller 仍在用，刪除收益低、風險高）
- 舊 `DELETE /api/bookings/:id` + `DELETE /api/registrations/:id` 維持不變
- Schema migration：本次 **無 DB 異動**
- 詳情頁 / drill-down（所有資訊在卡片上一頁顯示完）
- 過去記錄分頁（資料量目前 < 100 筆/user，YAGNI；未來爆量再加 limit/offset）
- Navbar 共用 component 抽出（每頁仍 inline navbar，只改文字）
- 手機版視覺重設計（屬於 Phase 3B）
- 真實通知整合（屬於 Phase 3C）
- 前端互動測試（chinup 既有風格無前端測試框架）

## 4. Architecture

```
[Browser] ── GET /my-schedule ──▶ [express.static] ─▶ public/my-schedule.html
                                        ↓
                            GET /api/my/schedule ─▶ [requireAuth] ─▶ [myScheduleService.listMySchedule]
                                                                            ├─▶ bookings table
                                                                            └─▶ registrations + course_sessions
                                        ↓
                                  JSON { items: [...] }

[Browser] ── GET /my.html ─────▶ 301 → /my-schedule
[Browser] ── GET /my-bookings.html ──▶ 301 → /my-schedule
```

## 5. Page Structure (Mobile-first)

```
┌────────────────────────────────┐
│ navbar  CHINUP  [PT N · 團 M] │
│         課程 | 我的課表 | …    │
├────────────────────────────────┤
│ <hero>                         │
│   📋 Personal                  │
│   我的課表                      │
│   一對一 + 團課，依時間排序      │
├────────────────────────────────┤
│ [Tab] 全部 │ 一對一 │ 團課     │  sticky, segmented control
├────────────────────────────────┤
│  📅  即將到來                   │  section header (hidden if empty)
│  ┌──────────────────────────┐  │
│  │ <Card upcoming×n>        │  │
│  └──────────────────────────┘  │
│  …                              │
│  ─────────────────────────     │
│  ▶ 過去記錄（n）                │  collapsed by default; click toggles ▼
│                                │
│  （展開後）                     │
│  ┌──────────────────────────┐  │
│  │ <Card past×n, muted>     │  │  opacity .7, grey badges
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

### Tab 行為

- 三個 tab：`全部` / `一對一` / `團課`
- 載入時抓一次完整資料（過去 + 未來），tab 切換**只重新渲染**，不再 fetch
- 切 tab 時，過去區塊的 expand state 保留
- Tab 用既有 `style.css` 的 segmented control 或新增 `tab-bar` class

### 過去記錄展開

- 預設摺疊，按鈕 `▶ 過去記錄（12）`
- Click toggle，展開後 `▼ 過去記錄（12）`
- Tab 篩選會即時更新計數（例：選「一對一」後 `過去記錄（4）`）
- 過去筆數為 0 時整個展開區塊不顯示

### 空狀態

| 情境 | 顯示 |
|---|---|
| 完全沒記錄（過去 + 未來都空） | `📭 還沒有任何預約` + `[瀏覽課程]` + `[預約一對一]` 兩顆按鈕 |
| 未來空、過去有 | `本週沒有預約` placeholder + 過去區塊正常顯示 |
| Tab 篩選後未來空 | `「一對一」沒有未來預約` + 對應的 [預約一對一] / [瀏覽課程] CTA |

## 6. Card Design

兩種卡片共用同一個 component，差異欄位用條件渲染。

| 欄位 | `kind=booking` | `kind=registration` |
|---|---|---|
| 類型 pill | 🏋️ 一對一（藍） | 👥 團課（粉） |
| 主標題 | `coach_display_name` | `course_name` |
| 副資訊 1 | `60 分鐘` | `XX 分鐘`（session 時長） |
| 副資訊 2 | 備註 `note`（若有） | 候補位 `候補 #N`（若 waitlisted） |
| 狀態 badge | `confirmed` / `cancelled` | `confirmed` / `waitlisted` / `cancelled` / `rejected`（未開課） |
| Cancel 按鈕 | 條件：`status='confirmed' AND start_at > now` | 條件：`status IN ('confirmed','waitlisted') AND session_status='open'` |

**`can_cancel` 由後端計算後直接放在 response**，前端只看 boolean，不重新跑邏輯。

**Cancel 行為**：點按鈕 → confirm dialog → 依 `kind` 呼叫 `DELETE /api/bookings/:id` 或 `DELETE /api/registrations/:id` → toast → reload 整頁。

## 7. API Contract

### `GET /api/my/schedule`

**Auth:** required（`requireUser` middleware；401 時回 `{ error: 'unauthenticated' }`）

**Query params:** none

**Response 200:**

```jsonc
{
  "items": [
    {
      "kind": "booking",                // "booking" | "registration"
      "id": 17,
      "start_at": "2026-05-21T14:00:00",
      "end_at":   "2026-05-21T15:00:00",
      "status":   "confirmed",
      "is_past":  false,                // 後端比 nowLocal() 算好
      "can_cancel": true,               // 後端依 §6 條件算好

      // booking-only（registration 時為 null）
      "coach_id": 1,
      "coach_display_name": "王教練",
      "note": "想練腿",
      "cancel_reason": null,

      // registration-only（booking 時為 null）
      "session_id": null,
      "course_name": null,
      "session_status": null,           // open|confirmed|cancelled|completed
      "duration_minutes": null,
      "position": null                  // 候補位
    }
  ]
}
```

**排序：** `ORDER BY start_at DESC`（最近的未來排最前面、再往過去走）

> **Why DESC：** 未來的東西「下一個」會在最上面 — 通常是離 now 最近的未來預約，user 進來最關心的就是這個。

**Error responses:**
- 401 `{ "error": "unauthenticated" }` — 未登入
- 500 `{ "error": "internal_error" }` — DB 例外（前端整頁 retry）

## 8. Server Module

### `src/services/myScheduleService.js`（新檔）

```javascript
import { db } from '../db/connection.js';
import { nowLocal } from '../db/connection.js';

export function listMySchedule({ userId }) {
  const now = nowLocal();

  const bookings = db.prepare(`
    SELECT b.id, b.start_at, b.end_at, b.status, b.note, b.cancel_reason,
           b.coach_id, c.display_name AS coach_display_name
    FROM bookings b
    JOIN coaches c ON c.id = b.coach_id
    WHERE b.member_id = ?
    ORDER BY b.start_at DESC
  `).all(userId);

  const registrations = db.prepare(`
    SELECT r.id, r.status, r.position,
           s.id AS session_id, s.start_at, s.end_at, s.status AS session_status,
           t.name AS course_name, t.duration_minutes
    FROM registrations r
    JOIN course_sessions s ON s.id = r.session_id
    JOIN course_templates t ON t.id = s.template_id
    WHERE r.user_id = ?
    ORDER BY s.start_at DESC
  `).all(userId);

  const items = [
    ...bookings.map(b => ({
      kind: 'booking',
      id: b.id,
      start_at: b.start_at,
      end_at: b.end_at,
      status: b.status,
      is_past: b.start_at < now,
      can_cancel: b.status === 'confirmed' && b.start_at > now,
      coach_id: b.coach_id,
      coach_display_name: b.coach_display_name,
      note: b.note,
      cancel_reason: b.cancel_reason,
      session_id: null, course_name: null, session_status: null,
      duration_minutes: null, position: null,
    })),
    ...registrations.map(r => ({
      kind: 'registration',
      id: r.id,
      start_at: r.start_at,
      end_at: r.end_at,
      status: r.status,
      is_past: r.start_at < now,
      can_cancel: ['confirmed', 'waitlisted'].includes(r.status) && r.session_status === 'open',
      coach_id: null, coach_display_name: null, note: null, cancel_reason: null,
      session_id: r.session_id,
      course_name: r.course_name,
      session_status: r.session_status,
      duration_minutes: r.duration_minutes,
      position: r.position,
    })),
  ];

  items.sort((a, b) => b.start_at.localeCompare(a.start_at));
  return items;
}
```

### `src/server.js` 異動

```javascript
// 在 express.static middleware 之前（line 58 附近）：

// 301 redirect 舊 URL
app.get('/my.html', (req, res) => res.redirect(301, '/my-schedule'));
app.get('/my-bookings.html', (req, res) => res.redirect(301, '/my-schedule'));

// /my-schedule canonical URL → static HTML
app.get('/my-schedule', (req, res) =>
  res.sendFile(resolve(__dirname, '../public/my-schedule.html'))
);

// 新 API endpoint（與其他 /api/my/* 同區段註冊）
app.get('/api/my/schedule', requireUser, (req, res) => {
  try {
    const items = listMySchedule({ userId: req.user.id });
    res.json({ items });
  } catch (e) {
    console.error('[GET /api/my/schedule]', e);
    res.status(500).json({ error: 'internal_error' });
  }
});
```

## 9. Frontend Module

### `public/my-schedule.html`（新檔）

- 沿用既有 navbar / hero / style.css 設計語言
- 一個 `<div id="tab-bar">`、`<div id="upcoming">`、`<div id="past-toggle">`、`<div id="past">`
- 載入時 `body { visibility: hidden }` 慣例 → 渲染完才 `visible`

### `public/my-schedule.js`（新檔）

```javascript
import { api, fmtDate, toast, bootAuth } from './app.js';

const state = {
  items: [],
  filter: 'all',     // 'all' | 'booking' | 'registration'
  pastOpen: false,
};

async function load() {
  const { items } = await api('/api/my/schedule');
  state.items = items;
  render();
}

function render() {
  // 1. filter by state.filter (kind === filter or 'all')
  // 2. split by is_past
  // 3. render upcoming list
  // 4. render past toggle (count + ▶/▼)
  // 5. if pastOpen: render past list
  // 6. update empty states
  // 7. attach cancel handlers
}

function bindTabs() { /* segmented control click → state.filter = ...; render() */ }
function bindPastToggle() { /* click → state.pastOpen = !state.pastOpen; render() */ }

async function handleCancel(item) {
  if (!confirm('確定要取消？')) return;
  const url = item.kind === 'booking'
    ? `/api/bookings/${item.id}`
    : `/api/registrations/${item.id}`;
  try {
    await api(url, { method: 'DELETE' });
    toast('已取消');
    load();
  } catch (e) {
    toast(`取消失敗：${e.message}`, 'error');
  }
}
```

### Navbar 更新（多個檔案）

每個含 navbar 的 page（`index.html`、`admin.html`、`my-schedule.html`、`coach.html`、`coaches.html`）：

```html
<!-- BEFORE -->
<a href="/my-bookings.html" class="nav-link">我的一對一</a>
<a href="/my.html" class="nav-link">我的報名</a>

<!-- AFTER -->
<a href="/my-schedule" class="nav-link">我的課表</a>
```

## 10. Tests

### `tests/my-schedule-api.test.js`（新檔）

使用 chinup 既有 `expect(label, fn)` harness + supertest 風格的 fetch helper（沿用 `tests/api.test.js` 模式）。

| Test | Setup | Assertion |
|---|---|---|
| 401 未登入 | 不帶 token | response.status === 401 |
| 空回傳 | 新會員、無資料 | `items.length === 0` |
| 只有 1-on-1 | seed 1 booking | items[0].kind === 'booking'、欄位齊全 |
| 只有團課 | seed 1 registration | items[0].kind === 'registration'、欄位齊全 |
| 混合 + 排序 | seed 1 booking + 1 reg，start_at 不同 | items 依 start_at DESC 排 |
| is_past 標註 | 1 個過去 + 1 個未來 | is_past 各自正確 |
| can_cancel (booking) | confirmed 未來 / confirmed 過去 / cancelled 三種 | true / false / false |
| can_cancel (registration) | confirmed open / rejected / session_status=cancelled | true / false / false |
| 候補位帶出 | waitlisted registration with position=2 | items[0].position === 2 |
| 資料隔離 | userA 認證、DB 有 userB 的記錄 | userB 的不出現在 userA response |

### `tests/my-schedule-routing.test.js`（新檔）

| Test | Setup | Assertion |
|---|---|---|
| `/my.html` → 301 | GET /my.html | status 301, location `/my-schedule` |
| `/my-bookings.html` → 301 | GET /my-bookings.html | status 301, location `/my-schedule` |
| `/my-schedule` 200 | GET /my-schedule | status 200, content-type html |

### 既有測試影響

- `tests/booking-api.test.js`、`tests/booking-flow.test.js`：保持 pass（沒動 booking endpoint）
- `tests/api.test.js`：保持 pass（已知 8 個 pre-existing failures 與 Phase 3A 無關，不修，記在 Phase 3 housekeeping backlog）

## 11. Error Handling

- **後端**：try/catch wrap，console.error 留紀錄，回 `{ error: 'internal_error' }` + 500
- **前端 fetch 失敗**：整頁 error-state，「載入失敗，請重新整理」+ retry 按鈕（呼叫 `load()`）
- **單筆 cancel 失敗**：toast 顯示錯誤訊息，其他卡片不受影響、不重整列表（重 fetch 後就 OK）

## 12. Migration / Rollback

- **Schema：** 無變動
- **DB data：** 無變動
- **Rollback：** revert PR commit 即可；舊 URL 因為是 301、瀏覽器可能 cache，rollback 後使用者按舊書籤可能還是被 redirect 一段時間（瀏覽器 cache 最長半天），可接受

## 13. Open Questions

無 — 所有決策已於 brainstorm 過程確認。

## 14. References

- Phase 1 spec: `docs/superpowers/specs/2026-05-11-one-on-one-booking-design.md`
- Phase 2 spec: `docs/superpowers/specs/2026-05-12-points-system-design.md`
- 既有頁面：`public/my.html`、`public/my-bookings.html`、`public/my-bookings.js`
- 既有 API：`GET /api/my/bookings`、`GET /api/my/registrations`、`DELETE /api/bookings/:id`、`DELETE /api/registrations/:id`
- Service convention：`src/services/coachService.js`、`bookingService.js`、`courseService.js`、`pointService.js`
