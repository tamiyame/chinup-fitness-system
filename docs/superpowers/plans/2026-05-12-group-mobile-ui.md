# Phase 3B · Group Class Mobile UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `index.html`'s group-class session card for mobile (<768px) — cuts redundant title/description, uses "剩 N 位" capacity label with green/amber/red gradient, full-width touch-target action. Five states. Desktop ≥768px unchanged.

**Architecture:** Pure frontend. Dual-markup pattern: same `<article class="card">` wrapper holds both a mobile inner block (`.md:hidden`) and a desktop inner block (`.hidden md:block`). New CSS classes prefixed `cc-`. Mobile media query overrides existing `.card` / `.day-group summary` paddings and fonts. Zero backend / schema / API changes.

**Tech Stack:** Vanilla JS (ES modules) + Tailwind CDN utilities + chinup's existing `style.css` design tokens.

**Spec reference:** `docs/superpowers/specs/2026-05-12-group-mobile-ui-design.md`

**Branch:** `feature/group-mobile-ui` (already checked out, base commit `c476293` is the spec commit)

**Review pattern:** Per user preference, all three tasks below are non-trivial frontend redesigns and warrant per-task spec + quality review. The final holistic review checks integration across viewports.

---

## File Structure

**Modified files (2):**

| Path | Responsibility |
|---|---|
| `public/style.css` | Append ~95 lines of Phase 3B CSS: `cc-*` mobile-only classes, `.badge-warn`, `.btn-warn`, mobile media-query overrides for `.card` padding + `.day-group summary` padding + `.day-title h3/p` + `.course-meta` |
| `public/courses.js` | Refactor `card(s, my)` → wrapper that outputs dual markup; add `computeState(s, my)` helper, `cardMobile(s, my, state)`, rename existing inner to `cardDesktop(s, my)`. Modify `renderCourseGroup()` to emit dual `course-meta` lines |

**Zero changes elsewhere.** No backend (`src/`), no tests (`tests/`), no schema, no other public/ files.

---

## Pre-flight check

- [ ] **Step 0a: Confirm branch**

Run: `git branch --show-current`
Expected: `feature/group-mobile-ui`

- [ ] **Step 0b: Confirm spec is committed**

Run: `git log --oneline -3`
Expected: HEAD includes `c476293 docs: add Phase 3B design spec for group class mobile UI`

- [ ] **Step 0c: Confirm server is up + DB is seeded**

Run:
```bash
curl -s -o /dev/null -w "server: %{http_code}\n" http://localhost:3000/api/health
sqlite3 data/app.db "SELECT 'user1 reg:' AS k, COUNT(*) FROM registrations WHERE user_id = (SELECT id FROM users WHERE email='user1@chinup.local') UNION ALL SELECT 'user2 reg:', COUNT(*) FROM registrations WHERE user_id = (SELECT id FROM users WHERE email='user2@chinup.local') AND status='confirmed' UNION ALL SELECT 'user8 wait:', COUNT(*) FROM registrations WHERE user_id = (SELECT id FROM users WHERE email='user8@chinup.local') AND status='waitlisted';"
```

Expected:
- server: 200
- user1 reg: 0 (user1 only has a 1-on-1 booking, no group regs)
- user2 reg: 2 (TRX + HIIT, both confirmed)
- user8 wait: 1 (TRX waitlisted)

If the DB looks wrong (e.g. counts zero across the board because flow tests wiped it), re-seed:
```bash
rm -f data/app.db data/app.db-shm data/app.db-wal
node src/db/migrate.js
node src/db/seed-demo.js
SERVER_PID=$(lsof -ti :3000 2>/dev/null); [ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
```

---

## Task 1: Add Phase 3B CSS to `public/style.css`

**Files:**
- Modify: `public/style.css` (append at end of file)

No automated tests — pure CSS additions. Verification is manual: file parses, page still loads, desktop visuals unchanged.

- [ ] **Step 1.1: Append Phase 3B CSS section**

Append this exact block at the end of `public/style.css` (after the existing `.nav-link-mobile.active` rule):

```css

/* ============================================================
 * Phase 3B · Group class mobile UI (only effective at <768px)
 * ============================================================ */

/* Mobile-only overrides on existing classes */
@media (max-width: 767px) {
  .card { padding: 12px; }
  .day-group summary { padding: 14px; }
  .day-title h3 { font-size: 15px; }
  .day-title p {
    font-size: 12px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .course-meta { font-size: 11px; }
}

/* Mobile course-card layout (rendered inside .md:hidden wrapper) */
.cc-row1 { display: flex; gap: 12px; align-items: center; }
.cc-date-chip {
  background: #f1f5f9;
  border-radius: 8px;
  padding: 8px 10px;
  text-align: center;
  min-width: 54px;
}
.cc-date-chip .cc-d {
  font-size: 22px;
  font-weight: 800;
  line-height: 1;
  color: var(--brand-700);
}
.cc-date-chip .cc-t {
  font-size: 10px;
  color: var(--ink-mute);
  margin-top: 3px;
  display: block;
}
.cc-cap { flex: 1; min-width: 0; }
.cc-cap-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}
.cc-remaining { font-size: 14px; font-weight: 700; }
.cc-remaining.open             { color: #047857; }
.cc-remaining.warn             { color: #a16207; }
.cc-remaining.full             { color: #b91c1c; }
.cc-remaining.mine-confirmed   { color: #047857; }
.cc-remaining.mine-waitlisted  { color: #a16207; }

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

/* New button variant for "進入候補" — amber, signals waitlist not confirmation */
.btn-warn { background: #d97706; color: white; }
.btn-warn:hover { background: #b45309; transform: translateY(-1px); }
```

- [ ] **Step 1.2: Verify CSS parses + page still loads**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/style.css
curl -s http://localhost:3000/style.css | wc -c
curl -s -o /dev/null -w "/: %{http_code}\n" http://localhost:3000/
```

Expected:
- style.css: 200
- byte count: roughly 2000+ bytes larger than before (~95 lines added)
- /: 200

- [ ] **Step 1.3: Quick desktop sanity check**

Open `http://localhost:3000/` in a desktop-width browser (or curl-fetch the HTML and verify CSS doesn't break the existing markup). The page should look identical to before — `.cc-*` classes are not yet used by any markup so they have no effect; mobile media queries don't apply at desktop width.

This is a quick implementer self-check, not a blocking smoke test (the formal smoke test is at Task 3).

- [ ] **Step 1.4: Commit**

```bash
git add public/style.css
git commit -m "feat(ui): add Phase 3B mobile course-card CSS

Add cc-* class family for mobile session card layout, .badge-warn,
.btn-warn, and mobile (<768px) overrides on .card / .day-group
summary / .course-meta paddings + fonts. Classes are not yet used
by markup — courses.js refactor in next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor `public/courses.js` to emit dual markup

**Files:**
- Modify: `public/courses.js`

This is the meat of the redesign. After this task, mobile viewports see the new card; desktop sees the existing card.

- [ ] **Step 2.1: Add `computeState(s, my)` helper**

In `public/courses.js`, add this function just above the existing `function card(s, my)` (around line 109):

```javascript
function computeState(s, my) {
  if (my?.status === 'confirmed')  return 'mine-confirmed';
  if (my?.status === 'waitlisted') return 'mine-waitlisted';
  const remaining = s.max_capacity - s.confirmed_count;
  if (remaining === 0) return 'full';
  if (remaining <= 2)  return 'warn';
  return 'open';
}
```

- [ ] **Step 2.2: Rename existing `card(s, my)` to `cardDesktop(s, my)`**

The existing `card(s, my)` function (around lines 109–163) has this opening:

```javascript
function card(s, my) {
  const dt = new Date(s.start_at);
  ...
}
```

Rename to `cardDesktop`:

```javascript
function cardDesktop(s, my) {
  const dt = new Date(s.start_at);
  ...
}
```

Also remove the outer `<article class="card">...</article>` wrapper from the function body since the new top-level `card()` wrapper will own that. The function should now return only the inner content (the `<div class="flex flex-col md:flex-row gap-5">...</div>` block).

The full updated `cardDesktop` body should be:

```javascript
function cardDesktop(s, my) {
  const dt = new Date(s.start_at);
  const dayLabel = `週${DOW_SHORT[dt.getDay()]}`;
  const pct = Math.min(100, Math.round((s.confirmed_count / s.max_capacity) * 100));
  const full = s.confirmed_count >= s.max_capacity;

  let statusChip;
  if (my) {
    statusChip = my.status === 'confirmed'
      ? `<span class="badge badge-confirmed">已報名（正取）</span>`
      : `<span class="badge badge-waitlisted">候補第 ${my.position} 位</span>`;
  } else {
    statusChip = full
      ? `<span class="badge badge-waitlisted">已額滿</span>`
      : `<span class="badge badge-open">開放報名</span>`;
  }

  const action = my
    ? `<button disabled class="btn btn-ghost">已加入</button>`
    : `<button data-session-id="${s.id}" class="register-btn btn btn-primary">${full ? '進入候補' : '立即報名'}</button>`;

  return `
    <div class="flex flex-col md:flex-row gap-5">
      <!-- date block -->
      <div class="flex md:flex-col items-center md:items-center md:justify-center md:min-w-[90px] md:border-r md:border-slate-100 md:pr-5">
        <div class="text-4xl font-bold leading-none" style="letter-spacing:-0.03em;">${String(dt.getDate()).padStart(2, '0')}</div>
        <div class="ml-2 md:ml-0 md:mt-1 flex md:flex-col items-baseline md:items-center gap-1">
          <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--brand-700)">${monthLabel(dt)}</span>
          <span class="text-xs" style="color:var(--ink-mute)">${dayLabel}</span>
        </div>
      </div>
      <!-- content -->
      <div class="flex-1">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="card-title">${s.name}</h3>
            <p class="card-desc">${s.description || ''}</p>
          </div>
          ${statusChip}
        </div>
        <div class="meta">
          <span class="meta-item"><span class="meta-icon">🕐</span> ${formatTime(dt)}・${s.duration_minutes} 分鐘</span>
          <span class="meta-item"><span class="meta-icon">👥</span> ${s.confirmed_count} / ${s.max_capacity} 人（需 ${s.min_capacity} 人成班）</span>
          ${s.waitlist_count > 0 ? `<span class="meta-item" style="color:#a16207"><span class="meta-icon">⏳</span> 候補 ${s.waitlist_count} 位</span>` : ''}
        </div>
        <div class="capacity-bar"><div class="capacity-fill ${full ? 'full' : ''}" style="width:${pct}%"></div></div>
        <div class="flex items-center justify-between mt-4">
          <span class="subtle">報名截止：${fmtDate(s.registration_deadline)}</span>
          ${action}
        </div>
      </div>
    </div>
  `;
}
```

- [ ] **Step 2.3: Add `cardMobile(s, my, state)` function**

Add this function immediately after `cardDesktop`:

```javascript
function cardMobile(s, my, state) {
  const dt = new Date(s.start_at);
  const dayLabel = `週${DOW_SHORT[dt.getDay()]}`;
  const remaining = s.max_capacity - s.confirmed_count;
  const pct = Math.min(100, Math.round((s.confirmed_count / s.max_capacity) * 100));

  // Remaining-info text per state
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

  // Bar fill class + width (pct already caps at 100 via Math.min above)
  const fillCls = state.startsWith('mine-') ? 'mine' : state;
  const fillWidth = pct;

  // Sub-deadline line (waitlist info prepended on full)
  const waitlistInfo = (state === 'full' && s.waitlist_count > 0)
    ? `候補 ${s.waitlist_count} 位 · ` : '';
  const deadline = `${waitlistInfo}截止 ${fmtDate(s.registration_deadline)}`;

  // Action inner (button or link). The .cc-action wrapper is added in the return below.
  let actionInner;
  if (state === 'mine-confirmed') {
    actionInner = `<a href="/my-schedule" class="cc-mine-link mine-confirmed">✓ 已報名（正取）· 至我的課表 →</a>`;
  } else if (state === 'mine-waitlisted') {
    actionInner = `<a href="/my-schedule" class="cc-mine-link mine-waitlisted">⏳ 候補第 ${my.position} 位 · 至我的課表 →</a>`;
  } else if (state === 'full') {
    actionInner = `<button data-session-id="${s.id}" class="register-btn btn btn-warn">進入候補</button>`;
  } else {
    actionInner = `<button data-session-id="${s.id}" class="register-btn btn btn-primary">立即報名</button>`;
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
    <div class="cc-action">${actionInner}</div>
  `;
}
```

- [ ] **Step 2.4: Add wrapper `card(s, my)`**

Add this NEW function at the position where the original `card` lived (just above `cardDesktop` if you put them in declaration order; JS hoists, so order doesn't matter at runtime, but readability does):

```javascript
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

- [ ] **Step 2.5: Modify `renderCourseGroup()` for dual `course-meta`**

In `renderCourseGroup` (around line 79), find this line:

```javascript
<p class="course-meta">🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘・👥 ${group.min_capacity}–${group.max_capacity} 人</p>
```

Replace with two lines (mobile shows shorter, desktop shows full):

```javascript
<p class="course-meta hidden md:block">🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘・👥 ${group.min_capacity}–${group.max_capacity} 人</p>
<p class="course-meta md:hidden">🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘</p>
```

- [ ] **Step 2.6: Quick smoke check that page still serves**

Run:
```bash
curl -s -o /dev/null -w "/: %{http_code}\n" http://localhost:3000/
curl -s http://localhost:3000/courses.js | head -1
```

Expected:
- /: 200
- First line of courses.js is the existing `import { api, toast, ... } from '/app.js';`

If the JS has a syntax error, browser console will scream and the page won't render anything past `<main>`. The curl above doesn't catch that — the real check is opening the page in a browser, which Task 3 covers.

- [ ] **Step 2.7: Commit**

```bash
git add public/courses.js
git commit -m "feat(ui): refactor card() into dual mobile/desktop markup

Phase 3B group-class mobile redesign. New computeState() helper drives
5 states (open / warn / full / mine-confirmed / mine-waitlisted).
cardMobile() emits compact 2-row layout with '剩 N 位' label, capacity
bar with state-colored gradient, full-width action; mine-* states use
a banner-link to /my-schedule instead of a disabled button. cardDesktop()
preserves the original layout. renderCourseGroup() emits dual course-meta
lines so mobile drops the '👥 M–N 人' suffix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Manual mobile smoke verification

**Files:**
- None (verification only). Any fixes get committed with their own message.

This task is the gate. After Task 2, code is in place; this task confirms the 5 states actually render correctly in a mobile viewport.

- [ ] **Step 3.1: Confirm server is fresh**

Restart the server so any cached static files are dropped:
```bash
SERVER_PID=$(lsof -ti :3000 2>/dev/null)
[ -n "$SERVER_PID" ] && kill $SERVER_PID
sleep 1
( cd /Users/ryansheu/projects/chinup-fitness-system && nohup npm start > /tmp/chinup-server.log 2>&1 & )
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
```

Expected: 200.

- [ ] **Step 3.2: Open `http://localhost:3000/` in a browser at 390px width**

Use DevTools device emulation (iPhone 14 preset = 390×844) or a manually-resized window.

Login as `user1@chinup.local` / `pass1234`.

Expected visible states for user1:
- **TRX 週三** (next session is full, user1 not registered): `已額滿` badge, red "已額滿" text + red bar + "候補 N 位" line, amber "進入候補" full-width button
- **瑜伽 週六** (3/5 = remaining 2, user1 not registered): `快滿` badge, amber "⚡ 剩 2 位" text + amber bar, primary "立即報名" full-width button
- **HIIT 週五** (next session is full, user1 not registered): same as TRX — `已額滿`, amber button

Expected visible states for `user2@chinup.local` / `pass1234`:
- **TRX** (user2 is confirmed): `已報名` badge, green "✓ 已報名（正取）" text + grey bar, green link banner "✓ 已報名（正取）· 至我的課表 →"
- **HIIT** (user2 is confirmed): same as above

Expected visible states for `user8@chinup.local` / `pass1234`:
- **TRX** (user8 is waitlisted position 1): `候補` badge, amber "⏳ 候補第 1 位" text + grey bar, amber link banner "⏳ 候補第 1 位 · 至我的課表 →"

To see the `open` state (remaining > 2), expand any accordion past the first session — sessions 2, 3, 4… have 0 registrations because seed-demo only seeds the first session. Those sessions show `剩 6 位` (or whatever max is) with green styling.

- [ ] **Step 3.3: Verify accordion summary tightening**

While at 390px, expand the TRX accordion. The summary should:
- Have ~14px padding (visibly tighter than desktop's 18px 22px)
- Show description on 2 lines max (with `...` ellipsis if longer)
- Show course-meta as `🗓 下次 05/13 週三 19:00・⏱ 60 分鐘` (no `👥 3–6 人` at the end)

- [ ] **Step 3.4: Verify touch targets**

Hover (or DevTools-measure) the full-width action buttons. They should be ≥ 36px tall — comfortable to tap.

- [ ] **Step 3.5: Verify breakpoint transition**

Resize the browser from 390px gradually wider. At exactly 768px, the layout should switch from mobile to desktop with no flicker / FOUC.

- [ ] **Step 3.6: Verify desktop unchanged**

At 1024px+ width, the page should look identical to `main` branch. Compare visually if needed:
```bash
git stash
# screenshot at 1024px
git stash pop
# screenshot at 1024px again — should look the same
```

(Or just trust your eye — the desktop markup is byte-for-byte preserved in `cardDesktop()`.)

- [ ] **Step 3.7: Verify functional flows**

At 390px width:
- As user1, click "立即報名" on an open session → toast 報名成功, page refreshes, state changes to `mine-confirmed` banner
- As user1, click "進入候補" on a full session → toast 候補成功, state changes to `mine-waitlisted` banner
- As user1, after registering, click the green "至我的課表 →" link → navigates to `/my-schedule`

- [ ] **Step 3.8: If any issue found, fix it and commit**

```bash
# example for a typo fix
git add public/courses.js  # or style.css
git commit -m "fix(ui): <short description of what was wrong>

<Why it was wrong, what the fix is>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If no issues, nothing to commit — this task is verification only.

- [ ] **Step 3.9: Run existing test suites to confirm no regression**

```bash
node tests/my-schedule-api.test.js
node tests/my-schedule-routing.test.js
node tests/booking-api.test.js
```

Expected: all pass. (These are HTTP / data integrity tests — Phase 3B is pure frontend so they shouldn't regress, but the smoke check is cheap.)

---

## Task 4: Final holistic review

After Task 3 passes, dispatch a single holistic reviewer subagent across the entire diff `main..feature/group-mobile-ui` to catch:

- **Dual-markup consistency:** Does `cardMobile` emit equivalent semantic information to `cardDesktop`? (e.g., both should let the user register, both should show capacity, etc.)
- **State coverage:** Are all 5 states exercised by at least one path in `computeState`? Any branch missed?
- **CSS scoping:** Does any `cc-*` rule accidentally affect non-mobile markup? (They shouldn't, because cc-* only appears inside `.md:hidden` wrapper, but worth confirming.)
- **A11y:** Does the new mobile banner-link have appropriate `aria-label` or readable text? Are action buttons keyboard-focusable?
- **Tailwind consistency:** Are `md:hidden` / `hidden md:block` used consistently across the file?
- **No drift from spec §10:** Does the implementation match the spec's reference JS?

After review, hand off to user-driven mobile smoke test (which is the merge gate per `workflow_preferences` memory).

---

## What is intentionally NOT covered

Per spec §3, these are out of scope:

- Desktop (≥768px) visual changes — `cardDesktop` is preserved byte-for-byte
- Backend, API, schema, migration
- Hero, navbar, accordion structure (only the `.day-group summary` padding/font are tweaked, not the structure)
- `my-schedule`, `coaches`, `coach` page card redesigns
- Points / waitlist / refund logic
- New frontend test framework
- Inline `<style>` cleanup elsewhere
- Empty-state polish on `index.html`

## Reference

- Spec: `docs/superpowers/specs/2026-05-12-group-mobile-ui-design.md`
- Phase 3A plan (for chinup pattern reference): `docs/superpowers/plans/2026-05-12-my-schedule.md`
- Memory: `chinup_project.md`, `workflow_preferences.md`
