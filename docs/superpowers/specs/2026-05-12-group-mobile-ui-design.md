# Phase 3B · Group Class Mobile UI Redesign

**Date:** 2026-05-12
**Branch:** `feature/group-mobile-ui`
**Phase:** 3B of 3 (Phase 3 split into 3A unified my-schedule · 3B mobile UI · 3C LINE/Push)
**Status:** Draft for review

---

## 1. Goal

Redesign the group-class session card on `index.html` for mobile (<768px) so members on phones (320–390px viewports) can scan capacity, see status at a glance, and tap a comfortable touch-target to register. Desktop (≥768px) appearance remains unchanged.

## 2. In Scope

- `public/index.html` 團課列表頁的**手機版**（<768px）session card 重設計
- `public/courses.js` 的 `card()` render 函式：產生新的 mobile-optimized markup（雙版本 markup 模式）
- `public/style.css` 新增 mobile-specific CSS rules (~90 lines)
- 涵蓋五種卡片狀態：`open` / `warn` / `full` / `mine-confirmed` / `mine-waitlisted`
- `.day-group summary`（accordion 標題）的 mobile padding / font 調整
- Accordion summary 內 `.course-meta` 在 mobile 拿掉 `👥 N–M 人` 容量範圍
- 「已報名」狀態從 disabled button 改成 banner-link 連到 `/my-schedule`

## 3. Out of Scope

- 桌面 (≥768px) 視覺：**完全不動**
- 後端 / API / schema：**零變動**
- Hero 區塊、navbar、accordion 結構：保留現狀
- 「🏋️ 預約一對一」全寬 CTA（首屏頂端）：保留現狀
- `my-schedule` 頁、`coaches` 頁、`coach` 頁的卡片：不在此 phase
- 點數扣款 / 候補 promotion / refund 邏輯：保留現狀
- 前端自動化測試框架：不引入

## 4. Architecture

純前端 CSS + JS 修改。同一個 `<article class="card">` wrapper 內輸出兩份 markup（mobile + desktop），用 Tailwind responsive utilities（`md:hidden` / `hidden md:block`）控制顯示。

```
┌─────────────────────────────────────────────┐
│ <article class="card" data-session-id="…">  │
│   ┌───────────────────────────────────────┐ │
│   │ <div class="md:hidden">               │ │
│   │   {cardMobile()} ← 新 markup          │ │
│   │ </div>                                │ │
│   ├───────────────────────────────────────┤ │
│   │ <div class="hidden md:block">         │ │
│   │   {cardDesktop()} ← 既有 markup       │ │
│   │ </div>                                │ │
│   └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

兩份 markup 同時存在 DOM，但 CSS 確保任一時刻只有一份可見。Click handler `querySelectorAll('.register-btn')` 會抓到兩個，但只有可見那個會收到 click event，不需特別處理。

## 5. Card Layout（Mobile）

```
┌──────────────────────────────────────┐
│ ┌────┐  剩 2 位          [開放 badge] │
│ │ 13 │  ━━━━━━━━━━━━━━━━━━           │  ← row 1
│ │週三 │  截止 5/12 19:00              │
│ │19:00│                              │
│ └────┘                                │
│ ┌──────────────────────────────────┐ │
│ │       立即報名                    │ │  ← row 2: 全寬 action
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

- Card padding：12px（mobile）/ 20px（desktop, 既有保留）
- Row 1 左：日期 chip（min-width 54px）顯示 `{日}` 大字 + `{週X} {HH:MM}` 小字
- Row 1 右（flex:1）：「剩 N 位」/「已額滿」+ capacity bar + 截止時間
- Row 2：全寬 action（高 36–38px touch target）

## 6. Five States

| 狀態 | 觸發條件 | 主資訊（左/中欄） | Action 區 |
|---|---|---|---|
| **open** | 未報名 AND 剩 > 2 位 | 🟢「剩 N 位」+ 綠色 bar（填充%）+「截止 …」小字 | 全寬 primary：`立即報名` |
| **warn** | 未報名 AND 剩 1–2 位 | 🟠「⚡ 剩 N 位」+ 橘色 bar +「截止 …」 | 全寬 primary：`立即報名` |
| **full** | 未報名 AND 剩 = 0 | 🔴「已額滿」+ 紅 bar (100%) + 「候補 N 位」小字（無候補時省略）+「截止 …」 | 全寬 amber：`進入候補` |
| **mine-confirmed** | `my.status === 'confirmed'` | 🟢「✓ 已報名（正取）」+ 灰 bar（capacity fill）+「截止 …」 | 全寬連結 banner：`✓ 已報名（正取）· 至我的課表 →` |
| **mine-waitlisted** | `my.status === 'waitlisted'` | 🟠「⏳ 候補第 N 位」+ 灰 bar +「截止 …」 | 全寬連結 banner：`⏳ 候補第 N 位 · 至我的課表 →` |

### 6.1 為什麼 mine-* 改成 banner-link

原版 mine-* 狀態給 `<button disabled>已加入</button>`，在手機上佔滿一行但不可點 = 浪費。改成 `<a href="/my-schedule">` 讓 user 一指跳到管理頁，可進一步取消。視覺上仍是全寬塊狀，但變成 actionable。

### 6.2 State computation

```js
function computeState(s, my) {
  if (my?.status === 'confirmed')  return 'mine-confirmed';
  if (my?.status === 'waitlisted') return 'mine-waitlisted';
  const remaining = s.max_capacity - s.confirmed_count;
  if (remaining === 0) return 'full';
  if (remaining <= 2)  return 'warn';
  return 'open';
}
```

**「剩 1–2 位 = warn」是絕對門檻、不用百分比。** 會員心理上「最後 1-2 位」是觸發報名行動的關鍵數字，跟班級總人數無關。

### 6.3 Status badge mapping

| state | badge class | badge label |
|---|---|---|
| open | `badge-open`（既有）| `開放` |
| warn | `badge-warn`（新增） | `快滿` |
| full | `badge-cancelled`（既有，紅系）| `已額滿` |
| mine-confirmed | `badge-confirmed`（既有）| `已報名` |
| mine-waitlisted | `badge-waitlisted`（既有）| `候補` |

新增的 `.badge-warn` 補齊 badge 系統（現有 `badge-waitlisted` 雖然色系一樣但語意是「候補」，避免混淆）。

## 7. Accordion Summary (`.day-group summary`) — Mobile Adjustments

| 元素 | desktop（現況保留） | mobile 覆寫 |
|---|---|---|
| `summary` padding | `18px 22px` | `14px` |
| `.day-title h3` font | `16px` | `15px` |
| `.day-title p`（description） | 自動換行 | `-webkit-line-clamp: 2`、font `12px` |
| `.course-meta` 內容 | `🗓 下次 ... ・ ⏱ N 分鐘 ・ 👥 M–N 人` | **拿掉 👥 M–N 人**，保留 `🗓 下次 ... ・ ⏱ N 分鐘` |
| `.course-meta` font | 不動 | `11px` |

### 7.1 Markup change in `renderCourseGroup()`

`.course-meta` 拆兩個版本：

```js
const metaDesktop = `🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘・👥 ${group.min_capacity}–${group.max_capacity} 人`;
const metaMobile  = `🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘`;
```

兩行輸出、用 `md:hidden` / `hidden md:block` 切換。

### 7.2 預期收益

- summary 行高從 ~88px → ~64px（節省 27%）
- description 兩行 ellipsis 不會吃掉半屏
- 整頁手機可見 course-group 數量從 ~2.5 個 → ~3.5 個

## 8. File Changes

| 路徑 | 動作 | 異動內容 |
|---|---|---|
| `public/courses.js` | Modify | `card()` 拆成 `cardMobile()` + `cardDesktop()`，包裝函式輸出雙 markup；新增 `computeState(s, my)` helper |
| `public/courses.js` | Modify | `renderCourseGroup()` 的 course-meta 拆 mobile/desktop 雙版本 |
| `public/style.css` | Modify | 末尾新增 Phase 3B mobile section（~90 行）：`.cc-*` 新 class、`.badge-warn`、`.card` mobile padding override、`.day-group summary` mobile overrides |
| `public/index.html` | 不動 | — |
| `src/` | 不動 | — |
| `tests/` | 不動 | — |

預估 diff：`courses.js` +~80 行、`style.css` +~90 行。零刪除。

## 9. New CSS Classes (in `public/style.css`)

```css
/* Phase 3B · Mobile course-card redesign (only effective at < 768px) */

/* Mobile-only: tighten card padding */
@media (max-width: 767px) {
  .card { padding: 12px; }
  .day-group summary { padding: 14px; }
  .day-title h3 { font-size: 15px; }
  .day-title p { font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .course-meta { font-size: 11px; }
}

/* Mobile course-card classes (cc- prefix; only rendered inside .md:hidden wrapper) */
.cc-row1 { display: flex; gap: 12px; align-items: center; }
.cc-date-chip {
  background: #f1f5f9;
  border-radius: 8px;
  padding: 8px 10px;
  text-align: center;
  min-width: 54px;
}
.cc-date-chip .cc-d { font-size: 22px; font-weight: 800; line-height: 1; color: var(--brand-700); }
.cc-date-chip .cc-t { font-size: 10px; color: var(--ink-mute); margin-top: 3px; display: block; }
.cc-cap { flex: 1; min-width: 0; }
.cc-cap-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.cc-remaining { font-size: 14px; font-weight: 700; }
.cc-remaining.open { color: #047857; }
.cc-remaining.warn { color: #a16207; }
.cc-remaining.full { color: #b91c1c; }
.cc-remaining.mine-confirmed  { color: #047857; }
.cc-remaining.mine-waitlisted { color: #a16207; }
.cc-bar {
  height: 4px;
  background: #f1f5f9;
  border-radius: 2px;
  margin: 6px 0 4px;
  overflow: hidden;
}
.cc-fill { height: 100%; transition: width 400ms ease; }
.cc-fill.open { background: linear-gradient(90deg, #0ea5e9, #0369a1); }
.cc-fill.warn { background: linear-gradient(90deg, #fbbf24, #d97706); }
.cc-fill.full { background: linear-gradient(90deg, #ef4444, #b91c1c); }
.cc-fill.mine { background: #cbd5e1; }
.cc-deadline { font-size: 10px; color: var(--ink-mute); }
.cc-action { margin-top: 10px; }
.cc-action .btn { width: 100%; padding: 9px; font-size: 13px; }
.cc-mine-link {
  display: block;
  padding: 9px;
  border-radius: 8px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.cc-mine-link.mine-confirmed  { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.cc-mine-link.mine-waitlisted { background: #fffbeb; color: #a16207; border: 1px solid #fcd34d; }

/* New badge variant for "almost full" — distinct from waitlist amber */
.badge-warn { background: #fffbeb; color: #a16207; border-color: #fcd34d; }

/* New button variant for "進入候補" — amber, signals waitlist (not confirmation) */
.btn-warn { background: #d97706; color: white; }
.btn-warn:hover { background: #b45309; transform: translateY(-1px); }
```

## 10. JavaScript Changes (`public/courses.js`)

### 10.1 New helper

```js
function computeState(s, my) {
  if (my?.status === 'confirmed')  return 'mine-confirmed';
  if (my?.status === 'waitlisted') return 'mine-waitlisted';
  const remaining = s.max_capacity - s.confirmed_count;
  if (remaining === 0) return 'full';
  if (remaining <= 2)  return 'warn';
  return 'open';
}
```

### 10.2 Refactored `card()` (wrapper)

```js
function card(s, my) {
  const state = computeState(s, my);
  return `
    <article class="card" data-session-id="${s.id}">
      <div class="md:hidden">${cardMobile(s, my, state)}</div>
      <div class="hidden md:block">${cardDesktop(s, my)}</div>
    </article>
  `;
}
```

### 10.3 New `cardMobile(s, my, state)`

```js
function cardMobile(s, my, state) {
  const dt = new Date(s.start_at);
  const dayLabel = `週${DOW_SHORT[dt.getDay()]}`;
  const remaining = s.max_capacity - s.confirmed_count;
  const pct = Math.min(100, Math.round((s.confirmed_count / s.max_capacity) * 100));

  // Remaining label per state
  const remainingLabel = (() => {
    if (state === 'mine-confirmed')  return '✓ 已報名（正取）';
    if (state === 'mine-waitlisted') return `⏳ 候補第 ${my.position} 位`;
    if (state === 'full') return '已額滿';
    if (state === 'warn') return `⚡ 剩 ${remaining} 位`;
    return `剩 ${remaining} 位`;
  })();

  // Badge per state
  const badgeMap = {
    open:               { cls: 'badge-open',       label: '開放' },
    warn:               { cls: 'badge-warn',       label: '快滿' },
    full:               { cls: 'badge-cancelled',  label: '已額滿' },
    'mine-confirmed':   { cls: 'badge-confirmed',  label: '已報名' },
    'mine-waitlisted':  { cls: 'badge-waitlisted', label: '候補' },
  };
  const badge = badgeMap[state];
  const badgeHtml = `<span class="badge ${badge.cls}">${badge.label}</span>`;

  // Bar fill class + width (pct already caps at 100 via Math.min in the prior line)
  const fillCls = state.startsWith('mine-') ? 'mine' : state;
  const fillWidth = pct;

  // Sub-deadline line
  const waitlistInfo = (state === 'full' && s.waitlist_count > 0)
    ? `候補 ${s.waitlist_count} 位 · ` : '';
  const deadline = `${waitlistInfo}截止 ${fmtDate(s.registration_deadline)}`;

  // Action area
  let actionHtml;
  if (state === 'mine-confirmed') {
    actionHtml = `<a href="/my-schedule" class="cc-mine-link mine-confirmed">✓ 已報名（正取）· 至我的課表 →</a>`;
  } else if (state === 'mine-waitlisted') {
    actionHtml = `<a href="/my-schedule" class="cc-mine-link mine-waitlisted">⏳ 候補第 ${my.position} 位 · 至我的課表 →</a>`;
  } else if (state === 'full') {
    actionHtml = `<button data-session-id="${s.id}" class="register-btn btn btn-warn">進入候補</button>`;
  } else {
    actionHtml = `<button data-session-id="${s.id}" class="register-btn btn btn-primary">立即報名</button>`;
  }

  return `
    <div class="cc-row1">
      <div class="cc-date-chip">
        <div class="cc-d">${String(dt.getDate()).padStart(2, '0')}</div>
        <span class="cc-t">${dayLabel} ${formatTime(dt)}</span>
      </div>
      <div class="cc-cap">
        <div class="cc-cap-head">
          <span class="cc-remaining ${state}">${remainingLabel}</span>
          ${badgeHtml}
        </div>
        <div class="cc-bar"><div class="cc-fill ${fillCls}" style="width:${fillWidth}%"></div></div>
        <div class="cc-deadline">${deadline}</div>
      </div>
    </div>
    <div class="cc-action">${actionHtml}</div>
  `;
}
```

### 10.4 `cardDesktop(s, my)` = 現有 `card()` 的 inner 內容

原封不動搬入，只是抽出函式名。

### 10.5 `renderCourseGroup()` course-meta 雙版本

```js
const metaDesktop = `🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘・👥 ${group.min_capacity}–${group.max_capacity} 人`;
const metaMobile  = `🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘`;

// 在 summary 內：
//   <p class="course-meta hidden md:block">${metaDesktop}</p>
//   <p class="course-meta md:hidden">${metaMobile}</p>
```

## 11. Test Plan

無自動化前端測試（chinup 既有風格無前端測試框架）。

**手動 smoke** 在四個 viewport：

| Viewport | 驗收重點 |
|---|---|
| 320px (iPhone SE) | 5 種狀態卡片不溢出橫向；touch target ≥ 36px；accordion summary 不擠變形 |
| 390px (iPhone 14) | 同上，視覺寬鬆度合理 |
| 768px (iPad portrait) | breakpoint 切換點：desktop markup 出現、mobile markup 隱藏，無 FOUC |
| 1024px+ (desktop) | 跟 main 一致，無回歸 |

**功能驗收：**
- 5 種狀態都能正確顯示（用 admin 後台 / seed-demo 製造對應 session）
- 點 mobile「立即報名」/「進入候補」會觸發 `POST /api/sessions/:id/register`（同桌面邏輯）
- 點「已報名 · 至我的課表 →」會跳到 `/my-schedule`
- accordion 展開/收合動畫正常
- pageshow（bfcache 回上一頁）會 re-fetch（既有行為保留）

**回歸測試：** 既有 `tests/my-schedule-*`、`tests/booking-*` 都不應受影響，繼續綠燈。

## 12. Error Handling

- 純前端 render，無新 API call → 不需新 error path
- 既有 `handleRegister()` 的 error toast 邏輯沿用（`already_registered` / `insufficient_points` / generic）

## 13. Migration / Rollback

- **Schema：** 無變動
- **DB data：** 無變動
- **Rollback：** revert PR 單 commit 即可。CSS / JS 改動純前端，瀏覽器自動載入新版（CDN cache 最長 5 分鐘左右視 Cache-Control 而定）

## 14. Open Questions

無 — 所有決策已於 brainstorm 過程確認（含視覺 mockup 對照）。

## 15. References

- Phase 3A spec: `docs/superpowers/specs/2026-05-12-my-schedule-design.md`
- 現有 markup：`public/index.html`、`public/courses.js` (`card()`, `renderCourseGroup()`)
- 現有 styles：`public/style.css` (`.card`, `.day-group`, `.badge-*`, `.capacity-bar`)
- Tailwind responsive utilities：`md:hidden` / `hidden md:block` (md breakpoint = 768px)
