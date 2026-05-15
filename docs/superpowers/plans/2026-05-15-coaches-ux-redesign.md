# /coaches.html UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/coaches.html` `view-list` as a two-section accordion-style list — a pinned "你最近的教練" pre-expanded card for returning members on top, with the full coach list below where each card lazily reveals bio + a 7-day slot preview when tapped. The existing `view-detail` / `view-confirm` flows stay intact.

**Architecture:** Backend gets one new read-only endpoint (`GET /api/my/recent-coach`) that joins through `bookingService`; everything else is pure front-end. CSS classes are orphan-added first so the markup/JS rewrite can land atomically without a fragile intermediate state.

**Tech Stack:** Node 24 ESM + Express + `node:sqlite` + vanilla JS modules + Tailwind CDN + custom `public/style.css`.

**Spec:** `docs/superpowers/specs/2026-05-15-coaches-ux-redesign-design.md` (commit `aed98b0`)

**Branch:** `feature/coaches-ux-redesign` (already created off main; spec already committed)

---

## File Structure

| File | Responsibility | Touch type |
|------|---------------|------------|
| `src/services/bookingService.js` | New prepared statement + `getMostRecentCoachForUser(userId)` exported helper that joins `bookings` × `coaches` and returns the latest non-cancelled coach for a member, with `session_date` for the days-ago calculation | Append helper |
| `src/server.js` | New `GET /api/my/recent-coach` route (`requireUser`, always 200 — non-member roles get `{coach:null}`); compute `days_ago` server-side | Insert one route |
| `public/style.css` | New visual tokens: `.ccard`, `.ccard.pinned`, `.ccard-avatar`, `.ccard-avatar-fallback`, `.ccard-body`, `.ccard-name`, `.ccard-spec`, `.ccard-chev`, `.ccard-expand`, `.slot-chip`, `.slot-chip-more`, `.book-cta`, `.section-recent-label`, `.section-recent-meta` | Append a `Coaches list` block |
| `public/coaches.html` | Replace the `view-list` block's inner markup (h1 stays; old `#coach-list` grid removed; two new `<section>`s for recent + all) | Modify ~3 lines |
| `public/coaches.js` | Full rewrite of `loadCoachList` + new accordion state machine + slot cache + recent-coach fetch; `openCoach`, `loadSlots`, `openConfirm`, and the confirm-button handler stay untouched | Rewrite top half of file |

Tasks 1–3 each ship orphan-but-shippable changes (helper unused, route returns data nobody reads yet, CSS not referenced yet). Task 4 wires them together — it's the substantial task and needs the spec + code quality reviewer pair per the workflow.

---

## Task 1: backend — `getMostRecentCoachForUser` helper in `bookingService.js`

**Files:**
- Modify: `src/services/bookingService.js` (append a prepared stmt + an exported function)

This task ships an unused helper. Verification is mechanical (read the diff). Task 2 wires it in.

- [ ] **Step 1: Read the file** to confirm the surrounding pattern. The other prepared statements live around `bookingService.js:6-36`, the `import { db }` etc. are at the top, exports follow the prepared statements.

- [ ] **Step 2: Append the prepared statement** at the end of the prepared-statement block (immediately after the existing `const getUserNameStmt = ...` line, around `bookingService.js:36`). Insert exactly:

```js
// Returns the member's most recent non-cancelled 1-on-1 booking and the coach
// data joined through. ORDER includes start_time so multi-booking same-day is
// deterministic. Filtered to is_active coaches — a deactivated coach should
// not surface as "your recent coach".
const getMostRecentBookingWithCoachStmt = db.prepare(`
  SELECT
    b.session_date         AS session_date,
    c.id                   AS coach_id,
    c.display_name         AS coach_display_name,
    c.specialty            AS coach_specialty,
    c.bio                  AS coach_bio,
    c.avatar_path          AS coach_avatar_path
  FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.user_id = ?
    AND b.status != 'cancelled'
    AND c.is_active = 1
  ORDER BY b.session_date DESC, b.start_time DESC
  LIMIT 1
`);
```

- [ ] **Step 3: Append the exported function** at the bottom of the file (after the last `export function` block). Insert exactly:

```js
/**
 * Returns the most recent non-cancelled 1-on-1 coach for a member.
 *
 * Used by `GET /api/my/recent-coach` to surface a "你最近的教練" pinned card.
 * "Most recent" = the booking with the latest (session_date, start_time);
 * future-dated bookings count, cancelled ones don't. Coaches who have been
 * deactivated (`is_active = 0`) are filtered out so the card never points
 * to someone you can't actually book.
 *
 * @param {number} userId
 * @returns {{
 *   coach: { id: number, display_name: string, specialty: string|null,
 *            bio: string|null, avatar_path: string|null } | null,
 *   last_session_date: string | null,
 *   days_ago: number | null,
 * }}
 */
export function getMostRecentCoachForUser(userId) {
  const row = getMostRecentBookingWithCoachStmt.get(userId);
  if (!row) return { coach: null, last_session_date: null, days_ago: null };

  // session_date is stored as 'YYYY-MM-DD' (per Phase 1 schema). Compare in
  // local-midnight days to avoid timezone drift between server clock and the
  // stored date.
  const sessionMidnight = new Date(`${row.session_date}T00:00:00`);
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysAgo = Math.floor((todayMidnight - sessionMidnight) / 86400000);

  return {
    coach: {
      id: row.coach_id,
      display_name: row.coach_display_name,
      specialty: row.coach_specialty,
      bio: row.coach_bio,
      avatar_path: row.coach_avatar_path,
    },
    last_session_date: row.session_date,
    days_ago: daysAgo, // negative = future-dated booking
  };
}
```

- [ ] **Step 4: Boot-smoke** — confirm the file still parses by starting the server briefly:

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
node --env-file-if-exists=.env src/server.js &
SERVER_PID=$!
sleep 1
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 200
kill $SERVER_PID 2>/dev/null
```

If the server fails to boot, the new export has a syntax error — fix before commit.

- [ ] **Step 5: Commit**

```bash
git add src/services/bookingService.js
git commit -m "$(cat <<'EOF'
feat(coaches): bookingService.getMostRecentCoachForUser helper

Adds a read-only query that returns a member's most recent
non-cancelled 1-on-1 coach plus the booking's session_date and a
days_ago integer. Future-dated bookings return negative days_ago.
Deactivated coaches are filtered out so the helper never points
to someone the caller can't actually book again.

Helper is unused at this commit — Task 2 will expose it via a
new /api/my/recent-coach route.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: backend — `GET /api/my/recent-coach` route

**Files:**
- Modify: `src/server.js` (insert one route + one import)

- [ ] **Step 1: Update the bookingService import** in `src/server.js`. Find the existing line that imports from `./services/bookingService.js` (a single grep'able line, near the top of the file) — it currently imports the createBooking / cancelBooking / list* functions. Append `getMostRecentCoachForUser` to that import list. Example (the prefix may differ — read the file first):

```js
import {
  createBooking as svcCreateBooking,
  cancelBooking as svcCancelBooking,
  listMemberBookings as svcListMemberBookings,
  listCoachBookings as svcListCoachBookings,
  getMostRecentCoachForUser as svcGetMostRecentCoachForUser,
} from './services/bookingService.js';
```

Use the existing alias convention (`svc*`) — match the pattern used for `createBooking` etc. in the surrounding code.

- [ ] **Step 2: Insert the new route** in `src/server.js`. Find the existing block of `/api/my/*` routes (around `src/server.js:272-285` — the `app.get('/api/my/registrations', ...)` and adjacent lines). Insert the new route immediately after the last `/api/my/*` route in that contiguous block:

```js
// Returns the requester's most recent non-cancelled 1-on-1 coach so the
// /coaches page can surface a "你最近的教練" pinned card. Always 200 with
// { coach: null } for non-members or members with no booking history — that
// lets the front-end use a single "if (coach) renderSection()" branch.
app.get('/api/my/recent-coach', requireUser, asyncHandler((req, res) => {
  if (req.user.role !== 'user') {
    return res.json({ coach: null, last_session_date: null, days_ago: null });
  }
  res.json(svcGetMostRecentCoachForUser(req.user.id));
}));
```

- [ ] **Step 3: Smoke-test with curl** — full path: cancel local DB users you don't want to test with, log in as a seeded member, hit the endpoint:

```bash
cd /Users/ryansheu/projects/chinup-fitness-system
node --env-file-if-exists=.env src/server.js &
SERVER_PID=$!
sleep 1

# Login as a seed member (per src/db/seed-demo.js). user1 has booking history.
TOKEN=$(curl -sS -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user1@chinup.local","password":"user1234"}' \
  | /Users/ryansheu/.local/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.token||"")})')

echo "=== As member (user1) ==="
curl -sS http://localhost:3000/api/my/recent-coach -H "Authorization: Bearer $TOKEN"
echo ""

# Login as admin — expect { coach: null }
ATOKEN=$(curl -sS -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@chinup.local","password":"admin1234"}' \
  | /Users/ryansheu/.local/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.token||"")})')

echo "=== As admin ==="
curl -sS http://localhost:3000/api/my/recent-coach -H "Authorization: Bearer $ATOKEN"
echo ""

# Unauthenticated → expect 401
echo "=== No auth ==="
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/my/recent-coach

kill $SERVER_PID 2>/dev/null
```

Expected behavior:

- Member (user1): if seeded with 1-on-1 booking history, returns `{ coach: {...}, last_session_date: "YYYY-MM-DD", days_ago: <int> }`. If no booking history, returns all-nulls.
- Admin: returns `{ coach: null, last_session_date: null, days_ago: null }`.
- No auth: HTTP 401.

If the member case returns null and you expected data, check `data/app.db`'s `bookings` table — the local seed may not include 1-on-1 bookings; that's OK for this smoke (the route correctness is what we're verifying). You can manually insert one for the smoke step in Task 4.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "$(cat <<'EOF'
feat(api): GET /api/my/recent-coach endpoint

Exposes bookingService.getMostRecentCoachForUser as a read-only
route gated by requireUser. Non-member roles (admin/owner/coach)
get { coach: null } at HTTP 200 — keeps the front-end branch
single ("if (data.coach) renderPinned()") instead of mixing 403
handling into the success path.

No schema change. Reuses the existing bookings × coaches join.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CSS — coach card / accordion / slot chip tokens

**Files:**
- Modify: `public/style.css` (append a `Coaches list` block at end of file)

Orphan CSS — no markup uses these yet. Task 4 introduces both the HTML and the JS that consume them in one atomic commit.

- [ ] **Step 1: Append at the very end of `public/style.css`**:

```css

/* ============ Coaches list (accordion) ============ */
.ccard {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease;
}
.ccard:hover { border-color: rgba(56, 189, 248, 0.4); }
.ccard:focus-visible {
  outline: 2px solid var(--brand-600);
  outline-offset: 2px;
}
.ccard.pinned {
  border-color: #fcd34d;
  background: #fffefb;
}
.ccard.pinned:hover { border-color: #f59e0b; }

.ccard-avatar {
  width: 44px; height: 44px;
  border-radius: 50%;
  background: #e2e8f0;
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.ccard-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ccard-avatar-fallback {
  color: #475569;
  font-weight: 700;
  font-size: 18px;
  line-height: 1;
  user-select: none;
}

.ccard-body { flex: 1; min-width: 0; }
.ccard-name {
  font-weight: 700; color: var(--ink); font-size: 14px;
  line-height: 1.3;
}
.ccard-spec {
  font-size: 12px; color: var(--ink-soft); margin-top: 2px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ccard-chev { color: #94a3b8; font-size: 18px; flex-shrink: 0; transition: transform 160ms ease; }
.ccard.expanded .ccard-chev { transform: rotate(180deg); }

.ccard-expand {
  background: #f8fafc;
  border: 1px solid var(--line);
  border-top: none;
  border-radius: 0 0 14px 14px;
  padding: 12px 14px 14px;
  margin: -1px 0 8px;   /* -1px pulls expand panel flush against card border */
  font-size: 12px;
}
.ccard.pinned + .ccard-expand {
  border-color: #fcd34d;
}
.ccard-expand .bio {
  color: var(--ink-soft);
  line-height: 1.5;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-line;
}
.ccard-expand .slot-label {
  font-size: 11px;
  color: var(--ink-soft);
  font-weight: 600;
  margin-bottom: 6px;
}
.ccard-expand .slot-empty {
  font-size: 12px;
  color: var(--ink-mute);
  margin-bottom: 12px;
}

.slot-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.slot-chip {
  background: white; border: 1px solid var(--line);
  padding: 4px 10px; border-radius: 8px; font-size: 11px;
  color: var(--ink);
  white-space: nowrap;
}
.slot-chip-more { color: var(--brand-700); border-color: #bae6fd; }

.book-cta {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%;
  padding: 9px;
  border-radius: 10px;
  background: var(--brand-600);
  color: white;
  font-weight: 700; font-size: 13px;
  text-decoration: none;
  border: none;
  cursor: pointer;
  transition: background 160ms ease;
}
.book-cta:hover { background: var(--brand-700); }

.section-recent-label {
  font-size: 11px; font-weight: 700; color: var(--ink-soft);
  letter-spacing: 0.08em; text-transform: uppercase;
  margin: 4px 0 8px;
  display: flex; align-items: center; gap: 8px;
}
.section-recent-label .ago-badge {
  background: #fffbeb; color: #a16207; border: 1px solid #fcd34d;
  font-size: 10px; padding: 2px 6px; border-radius: 999px;
  text-transform: none; letter-spacing: 0; font-weight: 600;
}

.section-all-label {
  font-size: 11px; font-weight: 700; color: var(--ink-soft);
  letter-spacing: 0.08em; text-transform: uppercase;
  margin: 18px 0 8px;
}
```

- [ ] **Step 2: Visual sanity-check** — boot the server and confirm nothing broke (orphan CSS shouldn't affect existing pages):

```bash
node --env-file-if-exists=.env src/server.js &
SERVER_PID=$!
sleep 1
curl -sS -o /dev/null -w "/ %{http_code}\n/coaches.html %{http_code}\n" http://localhost:3000/ http://localhost:3000/coaches.html
# expect: 200 / 200
kill $SERVER_PID 2>/dev/null
```

`/coaches.html` should still render the OLD layout (Task 4 hasn't run yet).

- [ ] **Step 3: Commit**

```bash
git add public/style.css
git commit -m "$(cat <<'EOF'
style(coaches): add accordion-list visual tokens

Adds the .ccard family (.ccard, .ccard.pinned, .ccard-avatar,
.ccard-body, .ccard-name, .ccard-spec, .ccard-chev, .ccard-expand)
plus .slot-chip / .slot-chip-more, .book-cta, .section-recent-label
(with .ago-badge), and .section-all-label. All used by the redesigned
/coaches view-list in the next task.

Orphan CSS at this commit — no markup references these yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: HTML + JS — `view-list` rewrite (the substantial one)

**Files:**
- Modify: `public/coaches.html` (replace 2 lines of `view-list` markup)
- Modify: `public/coaches.js` (rewrite top half: imports + new helpers + new `loadCoachList` + new accordion / slot-cache state)

This is the only task that needs both spec compliance and code quality reviewers after the implementer reports DONE.

- [ ] **Step 1: Update `view-list` markup** in `public/coaches.html`. Find the existing block (around lines 49-52):

```html
  <div id="view-list">
    <h1 class="page-title">選擇教練</h1>
    <div id="coach-list" class="grid sm:grid-cols-2 md:grid-cols-3 gap-4"></div>
  </div>
```

Replace it with:

```html
  <div id="view-list">
    <h1 class="page-title">選擇教練</h1>

    <section id="recent-section" class="hidden">
      <div class="section-recent-label">
        <span>你最近的教練</span>
        <span id="recent-ago" class="ago-badge"></span>
      </div>
      <div id="recent-card"></div>
      <div id="recent-expand"></div>
    </section>

    <section id="all-section">
      <div class="section-all-label">全部教練</div>
      <div id="coach-list"></div>
    </section>
  </div>
```

Notes:
- `#recent-section` starts hidden; JS reveals it only if `recent-coach.coach !== null`.
- `#coach-list` keeps the same id (so any cached external link still resolves) but loses the grid classes — accordion list is single-column.
- `#recent-card` + `#recent-expand` are two separate containers so the expand panel can sit visually flush below the card without nesting `<div>`s inside the clickable card itself.

- [ ] **Step 2: Rewrite the top half of `public/coaches.js`**. Open the file and locate the block from line 1 (`import` line) through line 37 (`}` closing `loadCoachList`). The bottom half (`openCoach`, `renderSlotControls`, `updatePrevDisabled`, `weekRange`, `loadSlots`, `openConfirm`, back-button handlers, `confirm-btn` handler, and the final `loadCoachList()` call) is **unchanged**. Replace lines 1-37 (and ONLY lines 1-37) with:

```js
import { api, fmtDate, dow, toast, refreshAuthBar, escapeHtml } from './app.js';

const $ = (id) => document.getElementById(id);
const views = { list: $('view-list'), detail: $('view-detail'), confirm: $('view-confirm') };
function show(name) {
  for (const v of Object.values(views)) v.classList.add('hidden');
  views[name].classList.remove('hidden');
}

let currentCoach = null;
let currentSlot = null;
let weekOffset = 0;

// --- Coach-list accordion + slot cache -------------------------------------

// Only one card is expanded at a time. null = nothing expanded.
let currentlyExpandedId = null;

// In-memory cache: coachId -> Array of ISO datetime strings (slot starts).
// Cleared naturally by a full page reload; no TTL.
const slotCacheByCoach = new Map();

function firstChar(name) {
  if (!name) return '?';
  // Array.from handles multi-byte / surrogate-pair characters correctly.
  return Array.from(name)[0];
}

function fmtSlotChip(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${dow(d.getDay())} ${hh}:${min}`;
}

function relativeDays(daysAgo) {
  if (daysAgo === 0) return '今天';
  if (daysAgo > 0) return `${daysAgo} 天前`;
  return `${-daysAgo} 天後`;
}

function next7DaysRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 6 * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const f = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: f(start), to: f(end) };
}

function avatarHtml(coach) {
  if (coach.avatar_path) {
    return `<img src="/avatars/${escapeHtml(coach.avatar_path)}" alt="">`;
  }
  return `<span class="ccard-avatar-fallback">${escapeHtml(firstChar(coach.display_name))}</span>`;
}

function cardHtml(coach, { pinned = false, expanded = false } = {}) {
  const classes = ['ccard'];
  if (pinned) classes.push('pinned');
  if (expanded) classes.push('expanded');
  return `
    <div class="${classes.join(' ')}"
         role="button"
         tabindex="0"
         data-coach-id="${coach.id}"
         aria-expanded="${expanded ? 'true' : 'false'}">
      <div class="ccard-avatar">${avatarHtml(coach)}</div>
      <div class="ccard-body">
        <div class="ccard-name">${escapeHtml(coach.display_name)}</div>
        ${coach.specialty ? `<div class="ccard-spec">${escapeHtml(coach.specialty)}</div>` : ''}
      </div>
      <div class="ccard-chev" aria-hidden="true">▾</div>
    </div>
  `;
}

function expandSkeletonHtml(coach) {
  return `
    ${coach.bio ? `<div class="bio">${escapeHtml(coach.bio)}</div>` : ''}
    <div class="slot-label">最近可預約</div>
    <div class="slot-area" data-coach-id="${coach.id}">
      <div class="slot-empty">載入中…</div>
    </div>
    <a href="#" class="book-cta" data-coach-id="${coach.id}">預約${escapeHtml(coach.display_name)} →</a>
  `;
}

function renderExpand(targetEl, coach) {
  targetEl.className = 'ccard-expand';
  targetEl.innerHTML = expandSkeletonHtml(coach);
  // Wire book CTA — same destination as "看更多 →" chip: openCoach() jumps to view-detail.
  const cta = targetEl.querySelector('.book-cta');
  cta.addEventListener('click', (ev) => {
    ev.preventDefault();
    openCoach(coach.id);
  });
}

function renderSlotsInto(slotArea, slots, coachId) {
  if (slots.length === 0) {
    slotArea.innerHTML = '<div class="slot-empty">目前無可預約時段</div>';
    return;
  }
  const first3 = slots.slice(0, 3)
    .map((s) => `<span class="slot-chip">${escapeHtml(fmtSlotChip(s))}</span>`)
    .join('');
  slotArea.innerHTML = `
    <div class="slot-chips">
      ${first3}
      <span class="slot-chip slot-chip-more" role="button" tabindex="0" data-coach-id="${coachId}">看更多 →</span>
    </div>
  `;
  const moreChip = slotArea.querySelector('.slot-chip-more');
  const trigger = () => openCoach(coachId);
  moreChip.addEventListener('click', trigger);
  moreChip.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
  });
}

async function ensureSlotsLoaded(coachId, slotAreaEl) {
  if (slotCacheByCoach.has(coachId)) {
    renderSlotsInto(slotAreaEl, slotCacheByCoach.get(coachId), coachId);
    return;
  }
  const { from, to } = next7DaysRange();
  try {
    const slots = await api(`/api/coaches/${coachId}/availability?from=${from}&to=${to}`);
    slotCacheByCoach.set(coachId, slots);
    renderSlotsInto(slotAreaEl, slots, coachId);
  } catch (e) {
    slotAreaEl.innerHTML = '<div class="slot-empty">時段載入失敗</div>';
  }
}

// --- Accordion state ------------------------------------------------------

const allCoachesById = new Map();

function collapseCurrent() {
  if (currentlyExpandedId == null) return;
  // Find whichever card (top section or list) currently shows the expand.
  document.querySelectorAll(`.ccard[data-coach-id="${currentlyExpandedId}"]`).forEach((cardEl) => {
    cardEl.classList.remove('expanded');
    cardEl.setAttribute('aria-expanded', 'false');
  });
  const expandEl = document.querySelector(`.ccard-expand[data-for-coach="${currentlyExpandedId}"]`);
  if (expandEl) expandEl.remove();
  currentlyExpandedId = null;
}

function expandCard(coachId) {
  const coach = allCoachesById.get(coachId);
  if (!coach) return;
  // Click on already-expanded → collapse only.
  if (currentlyExpandedId === coachId) {
    collapseCurrent();
    return;
  }
  collapseCurrent();
  // Find the card and insert the expand panel right after it.
  const cardEl = document.querySelector(`.ccard[data-coach-id="${coachId}"]`);
  if (!cardEl) return;
  cardEl.classList.add('expanded');
  cardEl.setAttribute('aria-expanded', 'true');
  const expandEl = document.createElement('div');
  expandEl.setAttribute('data-for-coach', String(coachId));
  cardEl.insertAdjacentElement('afterend', expandEl);
  renderExpand(expandEl, coach);
  currentlyExpandedId = coachId;
  ensureSlotsLoaded(coachId, expandEl.querySelector('.slot-area'));
}

function attachCardHandlers(rootEl) {
  rootEl.querySelectorAll('.ccard').forEach((cardEl) => {
    const coachId = Number(cardEl.dataset.coachId);
    const trigger = () => expandCard(coachId);
    cardEl.addEventListener('click', trigger);
    cardEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
    });
  });
}

// --- Recent-coach section -------------------------------------------------

async function loadRecentSection() {
  let data;
  try {
    data = await api('/api/my/recent-coach');
  } catch {
    return; // silent — section stays hidden
  }
  if (!data || !data.coach) return; // role != user, or no booking history

  const section = $('recent-section');
  section.classList.remove('hidden');

  // "X 天前" / "X 天後" / "今天"
  $('recent-ago').textContent = relativeDays(data.days_ago ?? 0);

  // Register this coach into the lookup so expand handler can find them.
  allCoachesById.set(data.coach.id, data.coach);

  // Render the pinned card (expanded by default).
  const cardWrap = $('recent-card');
  cardWrap.innerHTML = cardHtml(data.coach, { pinned: true, expanded: true });
  attachCardHandlers(cardWrap);

  // Render the expand panel inside the sibling container.
  const expandWrap = $('recent-expand');
  expandWrap.innerHTML = '';
  const expandEl = document.createElement('div');
  expandEl.setAttribute('data-for-coach', String(data.coach.id));
  expandWrap.appendChild(expandEl);
  renderExpand(expandEl, data.coach);
  currentlyExpandedId = data.coach.id;

  // Fire slot load for the pinned coach.
  ensureSlotsLoaded(data.coach.id, expandEl.querySelector('.slot-area'));
}

// --- Full coach list ------------------------------------------------------

async function loadCoachList() {
  const coaches = await api('/api/coaches');
  const wrap = $('coach-list');
  wrap.innerHTML = '';

  for (const c of coaches) {
    allCoachesById.set(c.id, c);
    wrap.insertAdjacentHTML('beforeend', cardHtml(c));
  }
  attachCardHandlers(wrap);

  if (coaches.length === 0) {
    wrap.innerHTML = '<p class="text-slate-500 text-sm">目前沒有可預約的教練</p>';
  }

  // Recent section runs in parallel and may re-add the expand panel for one
  // of these cards if the recent coach is also in the list (which they
  // typically are — recent coach is always shown again here so user can pick
  // a different coach without scrolling logic).
  await loadRecentSection();
}
```

Important: do **not** modify anything from `async function openCoach(id) {` (currently `coaches.js:39`) onward. Those functions and the final `await loadCoachList(); document.body.style.visibility = 'visible';` block stay byte-for-byte the same.

- [ ] **Step 3: Headless sanity** — the implementer subagent runs this short smoke; the full browser walkthrough happens later in Task 6 (user-driven):

```bash
node --env-file-if-exists=.env src/server.js &
SERVER_PID=$!
sleep 1
echo "=== /coaches.html HTTP 200? ==="
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/coaches.html
echo "=== coaches.js parses (no syntax error)? ==="
curl -sS http://localhost:3000/coaches.js | /Users/ryansheu/.local/bin/node --check 2>&1 | head -5 || echo "syntax error — must fix before commit"
echo "=== new markup containers present? ==="
curl -sS http://localhost:3000/coaches.html | grep -cE 'id="recent-section"|id="recent-card"|id="recent-expand"|id="all-section"'
kill $SERVER_PID 2>/dev/null
```

Expected: 200 status, no syntax error, 4 grep hits. If any fails, fix before committing.

- [ ] **Step 4: Commit**

```bash
git add public/coaches.html public/coaches.js
git commit -m "$(cat <<'EOF'
feat(coaches): pinned recent coach + accordion list with slot preview

Rewrites the /coaches view-list:

  - New <section id="recent-section"> at top: pinned card for the
    member's most recent non-cancelled 1-on-1 coach, pre-expanded
    with bio + 7-day slot chip preview + "預約 X 教練 →" CTA. Hidden
    when the request is from a non-member or returns no coach.
  - New <section id="all-section"> below: full coaches list as a
    single-column accordion. One card expanded at a time; clicking
    the same card again collapses it.
  - Each card uses <div role="button" tabindex="0"> so keyboard
    Enter/Space toggle works without inheriting <button>'s
    min-content sizing bug that caused the original overflow.
  - Empty avatars now render display_name's first character in a
    slate-200 circle instead of the generic 👤 unicode.
  - specialty uses line-clamp-2 instead of single-line truncate, so
    long strings wrap to a second line instead of being clipped mid-
    character.
  - Slots are lazy-fetched per coach and cached in-memory; pinned
    coach fetches eagerly on page load.
  - "看更多 →" chip and "預約 X 教練 →" button both route to the
    existing openCoach()/view-detail flow — no detail-view changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: push branch + open draft PR

**Files:** none

- [ ] **Step 1: Push branch with upstream tracking**

```bash
git push -u origin feature/coaches-ux-redesign
```

- [ ] **Step 2: Open draft PR**

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -sS -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  --data-binary @<(cat <<'EOF'
{
  "title": "/coaches.html UX redesign: pinned recent coach + accordion list",
  "head": "feature/coaches-ux-redesign",
  "base": "main",
  "draft": true,
  "body": "## Summary\n\n- New top section `你最近的教練` pre-expanded for returning members (hidden if no booking history or non-member role)\n- Full coach list reworked as a single-column accordion; one card expanded at a time, lazy slot fetch with in-memory cache\n- Each card uses `<div role=\"button\">` to escape `<button>`'s min-content overflow bug; specialty uses `line-clamp-2` instead of single-line truncate\n- Empty-avatar shows `display_name` first char in a slate-200 circle (not generic 👤)\n- New backend endpoint `GET /api/my/recent-coach` (read-only, joins `bookings` × `coaches`, non-member roles get `{coach:null}` at 200)\n- Zero schema migration; `view-detail` / `view-confirm` flow untouched\n\n## Test plan (390px iPhone viewport)\n\n- [ ] Login as member with 1-on-1 booking history → top section visible, pinned card pre-expanded with bio / chips / book button\n- [ ] Member with no booking history → top section hidden\n- [ ] Login as owner / admin / coach → top section hidden\n- [ ] Click a card in the full list → expand below; same card again → collapse\n- [ ] Click a different card → previous collapses, new one expands\n- [ ] `看更多 →` chip and `預約 X 教練 →` button both jump to detail view\n- [ ] Coach with no `bio` → bio paragraph omitted, no placeholder\n- [ ] Coach with no future slots in 7 days → `目前無可預約時段` shown, book button still present\n- [ ] Coach with no avatar → first character of display_name in slate-200 circle\n- [ ] Long specialty (秉毅(Ryan)'s entry) → wraps to 2 lines, no horizontal overflow\n- [ ] Keyboard Tab walks through cards; Enter / Space toggles expand\n- [ ] Index / admin / coach / my-schedule / line pages unaffected\n\n## Design refs\n\n- Spec: `docs/superpowers/specs/2026-05-15-coaches-ux-redesign-design.md`\n- Plan: `docs/superpowers/plans/2026-05-15-coaches-ux-redesign.md`\n\n## Deviations from spec\n\n- None at time of PR open.\n"
}
EOF
)" | /Users/ryansheu/.local/bin/node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); console.log("PR_NUMBER:", j.number); console.log("PR_URL:", j.html_url); console.log("PR_NODE_ID:", j.node_id);})'
```

Save the PR number + node_id for Task 8.

---

## Task 6: USER manual 390px mobile smoke test (merge gate)

**Files:** none — user runs the PR Test plan in a 390px Chrome devtools viewport.

The agent does not advance past this until the user reports back. Per workflow_preferences, this is the merge gate.

- [ ] **Step 1:** User starts the dev server (`npm start`), opens `http://localhost:3000/coaches.html` in 390px iPhone viewport
- [ ] **Step 2:** User walks through the PR Test plan checklist (12 items)
- [ ] **Step 3:** If bugs found, controller dispatches fix subagents on the same branch
- [ ] **Step 4:** When all green, proceed to Task 7

---

## Task 7: final holistic code review (Opus subagent)

**Files:** none — review only

- [ ] **Step 1: Dispatch an Opus holistic reviewer** with this prompt:

> Review the cumulative diff of `feature/coaches-ux-redesign` vs `main`. Spec at `docs/superpowers/specs/2026-05-15-coaches-ux-redesign-design.md`. Verify:
>
> 1. **`/api/my/recent-coach` correctness**: role gating (non-member → `coach:null` at 200), days_ago math (negative = future, 0 = today, positive = past), `is_active = 1` filter on the JOIN, the query is parameterized (no SQL injection), the returned coach object has no fields beyond what the front-end needs.
> 2. **DOM / accordion correctness**: `currentlyExpandedId` correctly tracks both top-section and list-section cards (they share `data-coach-id`); collapsing removes ALL matching `.ccard.expanded` (the recent coach also appearing in the list shouldn't desync); the expand panel is correctly removed before being re-added; ARIA attributes (`role="button" tabindex="0" aria-expanded`) flip in sync with class state.
> 3. **Slot cache lifecycle**: cache key is coachId only; doesn't cache stale data across page reloads (cache is in-memory and dies with the page — confirmed); no double-fetch race when user clicks the same card twice quickly.
> 4. **XSS**: all user-controlled fields (`display_name`, `specialty`, `bio`, `avatar_path`) pass through `escapeHtml()`; the `<img src="/avatars/${escapeHtml(coach.avatar_path)}">` interpolation is safe (escapeHtml encodes quote chars so attribute injection is prevented).
> 5. **Layout regression**: at desktop ≥768px, does the accordion list look reasonable (single column was an intentional design call, not a missed responsive breakpoint)? On 320px viewports does specialty `line-clamp-2` still hold (no horizontal overflow)?
> 6. **detail-view bridge**: `openCoach(coachId)` is still callable with the same signature from both the "看更多 →" chip and the "預約 X 教練 →" button; the existing back-button flow (`#back-to-list`) returns to the new view-list correctly with state preserved (cards still rendered, no re-fetch needed).
> 7. **Cumulative bytes**: ~250 added / ~80 removed across 5 files. Confirm no unintentional touches outside scope (e.g. `app.js`, other HTMLs, `package.json`).
> 8. **Pre-existing bug check**: was the `<button class="card flex…">` overflow bug actually fixed, or did the new markup happen to dodge it while leaving the root cause untouched somewhere else? (Answer should be: fixed by switching to `<div role="button">` which doesn't carry `<button>`'s min-content sizing rule.)
>
> Return: Critical / Important / Nit findings, with file:line refs. APPROVE | NEEDS FIXES.

- [ ] **Step 2: Address Critical / Important findings**, commit on same branch, push, mark resolved
- [ ] **Step 3: Nit findings** — fix-if-cheap, otherwise defer

---

## Task 8: merge + cleanup

**Files:** none — git + GitHub API operations

- [ ] **Step 1: Flip draft → ready for review**

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -sS -X POST \
  -H "Authorization: bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/graphql \
  --data-binary @<(cat <<EOF
{"query":"mutation { markPullRequestReadyForReview(input: {pullRequestId: \"<PR_NODE_ID>\"}) { pullRequest { isDraft state } } }"}
EOF
)
```

Substitute `<PR_NODE_ID>` with the value returned in Task 5 Step 2.

- [ ] **Step 2: Squash merge**

```bash
curl -sS -X PUT \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls/<PR_NUM>/merge \
  -d '{"merge_method":"squash"}' | /Users/ryansheu/.local/bin/node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); console.log("merged:", j.merged, "sha:", j.sha)})'
```

Substitute `<PR_NUM>` with the number returned in Task 5 Step 2.

- [ ] **Step 3: Pull main, delete branches**

```bash
git checkout main
git pull --ff-only origin main
git push origin --delete feature/coaches-ux-redesign
git branch -D feature/coaches-ux-redesign
git log --oneline -3
```

- [ ] **Step 4: Verify Railway deploy** — wait ~2-3 min for build, then:

```bash
curl -sS -I https://chinup-fitness-system-production-0834.up.railway.app/coaches.html | head -5
curl -sS https://chinup-fitness-system-production-0834.up.railway.app/coaches.js | grep -c 'currentlyExpandedId'   # expect 1+
curl -sS https://chinup-fitness-system-production-0834.up.railway.app/style.css | grep -c '\.ccard\b'              # expect 1+
```

If all three return positive values, deploy is live.

---

## Notes for the implementer

- All ES modules use top-level await pattern already (see `coaches.js:171`). No bundler / build step — edits go live on the next browser hard-reload.
- `data/app.db` may not include 1-on-1 bookings by default. If Task 2's smoke comes back with `coach: null` for a member, manually insert a row via `node` REPL or trust Task 4's browser smoke once you can book through the UI.
- The untracked `scripts/send-test-push.js` and `docs/reports/` are NOT part of this branch. Do not `git add` them.
- The hero-collapse / navbar work from PR #9 (commit `6648d25`) is the new baseline. Don't accidentally revert `index.html` or `app.js`.
