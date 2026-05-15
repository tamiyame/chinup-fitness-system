# Navbar Identity + Home CTA UI Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update navbar role identity (badge-only for owner/admin/coach), redesign the home page 預約一對一 CTA from a solid bar to an outlined pill, and collapse the redundant home hero / section heading into a single section title with a description block.

**Architecture:** Three independent file changes (CSS / JS / HTML) on a single feature branch. No backend, schema, API, or test code changes. Plan order is CSS-first so the JS + HTML changes can reference final class names; manual smoke at 390px iPhone viewport is the merge gate.

**Tech Stack:** Vanilla JS (ESM) + Tailwind CDN + custom `public/style.css` + multi-page SSR.

**Spec:** `docs/superpowers/specs/2026-05-15-navbar-identity-and-home-cta-design.md` (commit `4ee7149`)

**Branch:** `feature/ui-polish-navbar-home` (already created off main, spec already committed)

---

## File Structure

| File | Responsibility | Touch type |
|------|---------------|------------|
| `public/style.css` | New visual tokens: `.badge-coach` (purple role badge), `.btn-pill-outline` (CTA), `.section-desc` (group-training intro paragraph) | Insert 3 small blocks |
| `public/app.js` | `renderAuthBar()`: add `coach` → purple badge; render `<name>` + `<email>` only for `user` role | Modify 1 function |
| `public/index.html` | Home page DOM restructure: hero loses `<p>` + `<h1>` (h1 moves down); section header swaps `<h2 class="section-title">可報名課程</h2>` for `<h1>` of the old hero copy; CTA `<a>` re-classed; new `<p class="section-desc">` added | Modify 1 section |

Each task is one file × one concern, so commits stay tightly scoped.

---

## Task 1: Add CSS tokens — `.badge-coach`, `.btn-pill-outline`, `.section-desc`

**Files:**
- Modify: `public/style.css` (3 inserts)

This task ships orphan CSS — no markup uses these classes yet. That is intentional: Task 2 and Task 3 introduce the markup that consumes them. Splitting this way keeps each commit's diff atomic and easy to revert.

- [ ] **Step 1: Insert `.badge-coach`** after `public/style.css:147` (after `.badge-rejected`, before `.badge::before`):

```css
.badge-coach { background: #f5f3ff; color: #6d28d9; border-color: #ddd6fe; }
```

- [ ] **Step 2: Insert `.btn-pill-outline`** after `public/style.css:181` (after `.btn-sm`, before the `Capacity bar` section comment):

```css

.btn-pill-outline {
  align-items: center; justify-content: center; gap: 8px;
  padding: 12px 18px;
  border-radius: var(--radius-pill);
  border: 1.5px solid #bfdbfe;
  background: #f8fbff;
  color: #1d4ed8;
  font-size: 14px; font-weight: 700;
  text-decoration: none;
  transition: background 160ms ease, border-color 160ms ease;
}
.btn-pill-outline:hover { background: #eff6ff; border-color: #93c5fd; }
```

**Deliberate omission:** no `display`, no `width`. Layout is delegated to Tailwind utilities on the `<a>` in Task 3 (`flex w-full sm:hidden`). Reason: in `public/index.html:10-12`, the Tailwind CDN `<script>` runs **before** the `<link>` to `style.css`, so style.css wins on shared properties. If `.btn-pill-outline` set `display: flex`, it would override `sm:hidden`'s `display: none` at desktop and leak the mobile-only CTA onto the desktop layout. Keeping display/width out of the class avoids that fight.

- [ ] **Step 3: Insert `.section-desc`** after `public/style.css:275` (after `.subtle`, before `.empty-state`):

```css
.section-desc {
  font-size: 13px;
  color: var(--ink-soft);
  line-height: 1.5;
  margin: 4px 0 14px;
}
```

`var(--ink-soft)` reuses an existing CSS variable so the description picks up the same muted-text tone as `.meta`, `.empty-state`, etc.

- [ ] **Step 4: Visual sanity check**

```bash
node --env-file-if-exists=.env src/server.js &
```

Then in a browser (or just visual inspection of the file): open `http://localhost:3000/`. The home page should look **completely unchanged** because no markup references the new classes yet. If the page looks different at all, something else got modified — back out and re-check.

Stop the server (`kill %1`) before next task.

- [ ] **Step 5: Commit**

```bash
git add public/style.css
git commit -m "$(cat <<'EOF'
style(ui): add .badge-coach, .btn-pill-outline, .section-desc

Orphan CSS introduced ahead of the markup changes in renderAuthBar
(Task 2) and public/index.html (Task 3). Each token is scoped:

  - .badge-coach: purple variant for the 教練 role badge, matching
    the existing colored .badge-* family pattern
  - .btn-pill-outline: outlined pill button — full-width flex link,
    replaces the solid-blue btn-primary look used for the home
    "預約一對一" mobile CTA
  - .section-desc: muted intro paragraph used under a section heading

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: navbar role identity in `renderAuthBar`

**Files:**
- Modify: `public/app.js:144-176` (the `badgeMap` block and the `innerHTML` template inside `renderAuthBar`)

This change is exercised by every page that loads `app.js` (six pages), but the change itself is contained to one function.

- [ ] **Step 1: Extend `badgeMap` with `coach`** in `public/app.js`, replacing lines 144-148:

```js
  const badgeMap = {
    owner: '<span class="badge badge-waitlisted" style="font-size:10px;">擁有者</span>',
    admin: '<span class="badge badge-confirmed" style="font-size:10px;">管理者</span>',
    coach: '<span class="badge badge-coach" style="font-size:10px;">教練</span>',
    user:  '<span class="badge badge-open" style="font-size:10px;">會員</span>',
  };
  const badge = badgeMap[user.role] || badgeMap.user;
```

The fallback `|| badgeMap.user` is preserved as a defence against unknown future roles.

- [ ] **Step 2: Gate points-pill fetch behind `isMember`** — replace lines 152-166 (the `if (user.role === 'user') { ... }` block) with:

```js
  const isMember = user.role === 'user';

  // Fetch points balance for members only
  let pillHtml = '';
  if (isMember) {
    try {
      const bal = await api('/api/my/points/balance');
      const low = bal.one_on_one <= 0 || bal.group <= 0;
      pillHtml = `
        <span class="badge ${low ? 'badge-cancelled' : 'badge-confirmed'}"
              title="${low ? '某池餘額為 0，請聯絡管理員儲值' : '剩餘點數'}"
              style="font-size:10px; margin-right:8px;">
          PT ${bal.one_on_one} · 團 ${bal.group}
        </span>`;
    } catch {
      pillHtml = '';
    }
  }
```

The only substantive change is hoisting `isMember` to a const so it can also drive the name-render branch in the next step.

- [ ] **Step 3: Branch name + email render on `isMember`** — replace lines 168-176 (the `el.innerHTML = ...` template) with:

```js
  // Only members see name + email — owner/admin/coach are identified by their role badge.
  const nameHtml = isMember
    ? `<span class="text-sm font-medium">${escapeHtml(user.name)}</span>
       <span class="subtle hidden md:inline">${escapeHtml(user.email)}</span>`
    : '';

  el.innerHTML = `
    <div class="flex items-center gap-2">
      ${pillHtml}
      ${badge}
      ${nameHtml}
    </div>
    <button id="logout-btn" class="btn btn-ghost btn-sm">登出</button>
  `;
```

`escapeHtml()` is already imported (per the security hardening pass in PR #7/#8) — no import change needed.

- [ ] **Step 4: Manual smoke — login as four roles, check navbar**

Start the dev server:
```bash
node --env-file-if-exists=.env src/server.js &
```

Local seeded users (per `src/db/seed-demo.js`):
- owner: `admin@chinup.local / admin1234` — expect amber `[擁有者]` badge, no name, no email
- admin: create via `/admin.html → 會員管理` if absent, OR temporarily seed; expect blue `[管理者]` badge, no name
- coach: `coach1@chinup.local / coach1234` — expect **purple** `[教練]` badge (not green 會員), no name
- member: `user1@chinup.local / user1234` — expect points pill + green `[會員]` badge + 「USER 1」name + email on desktop only

Click through to `admin.html`, `coach.html`, `coaches.html`, `my-schedule.html`, `line.html` for each role to confirm the navbar reflects the change everywhere `app.js` runs. Logout works as before.

Stop the server before next task.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "$(cat <<'EOF'
feat(ui): role-only navbar for owner/admin/coach; add coach badge

Updates renderAuthBar() so the role badge is the sole identity
marker for non-member roles, dropping the user.name + user.email
spans that produced the "管理者 Administrator" redundancy.

Also adds the missing `coach` entry to badgeMap — coaches were
previously falling through to the default 會員 (green) badge.

Members keep the full points-pill + badge + name + email line
because they're the group that most needs "am I logged in, as
whom" feedback in the navbar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: home page hierarchy + CTA restyle

**Files:**
- Modify: `public/index.html:51-62` (hero + start of the courses section, including the existing CTA `<a>` and section header `<div>`)

- [ ] **Step 1: Collapse hero — drop `<h1>` and `<p>`** — replace `public/index.html:51-55`:

```html
  <section class="hero">
    <span class="hero-eyebrow">💪 2026 Spring Program</span>
  </section>
```

The `<section class="hero">` wrapper stays (spec section 2.4 decision (a)) so the `.hero` padding still gives the eyebrow breathing room consistent with admin/my-schedule/line pages.

- [ ] **Step 2: Restructure CTA + section header + description** — replace `public/index.html:57-62` (everything from `<a href="/coaches.html"` through `</div>` after `count-badge`):

```html
  <section class="pb-16">
    <a href="/coaches.html" class="btn-pill-outline flex w-full sm:hidden mb-4">
      <span>🏋️</span>
      <span>預約一對一教練課</span>
      <span aria-hidden="true">→</span>
    </a>
    <div class="flex items-center justify-between mb-2 gap-3">
      <h1 class="text-[22px] font-extrabold leading-tight whitespace-nowrap text-slate-900">找到適合你的團體訓練課程</h1>
      <span id="count-badge" class="subtle"></span>
    </div>
    <p class="section-desc">由專業教練設計的循環課表，每月開課、彈性報名。額滿自動進入候補、成班與否都會通知你。</p>
```

Key changes:
- CTA: `btn-primary w-full block sm:hidden text-center` → `btn-pill-outline flex w-full sm:hidden mb-4`. The `flex w-full` Tailwind utilities supply layout (so `sm:hidden`'s `display: none` can still win at desktop — see Task 1 Step 2 note). The `.btn-pill-outline` class supplies the visual chrome. Content broken into 3 `<span>` (icon, label, arrow) for clean flex spacing. Arrow is `aria-hidden="true"` because it's decorative.
- Section header: `<h2 class="section-title">可報名課程</h2>` → `<h1 class="text-[22px] font-extrabold ...">找到適合你的團體訓練課程</h1>`. Tailwind arbitrary value `text-[22px]` matches the JIT-compiled CDN. `whitespace-nowrap` is the one-line guarantee.
- `mb-4` on the header row drops to `mb-2` because the description directly below provides the rhythm.
- `gap-3` added to the flex row so the `共 N 場` count doesn't crowd a long heading on narrow viewports.
- New `<p class="section-desc">` carries the moved hero copy verbatim.

- [ ] **Step 3: Manual smoke — 390px mobile viewport**

```bash
node --env-file-if-exists=.env src/server.js &
```

In a 390px Chrome devtools viewport (iPhone 14), open `http://localhost:3000/`:

1. Eyebrow `💪 2026 SPRING PROGRAM` renders unchanged.
2. CTA pill: light-blue background, blue border, content `🏋️ 預約一對一教練課 →` centered, full-width.
3. Heading row: `找到適合你的團體訓練課程` on **one line** (no wrap) at ~22px bold; `共 19 場` right-aligned, same row.
4. Description paragraph (small grey text) directly below.
5. Course cards begin below description with normal spacing.
6. CTA click → navigates to `/coaches.html`.

- [ ] **Step 4: Manual smoke — desktop ≥ 768px**

Resize viewport to ~1280px:
1. CTA is **hidden** (`sm:hidden`).
2. Heading + count layout same structure, just wider; `whitespace-nowrap` doesn't bite because the line fits comfortably.
3. Eyebrow + heading + description column reads normally.

Stop the server.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
feat(home): collapse hero into section heading; restyle 1-on-1 CTA

Three coupled changes on the home page driven by the redundancy
between the marketing h1 "找到適合你的團體訓練課程" and the literal
section title "可報名課程" (which were saying the same thing):

  - Drop the hero <h1> and <p>; the hero <section> now wraps only
    the eyebrow pill.
  - Promote the old hero copy to the section heading at 22px (one
    line, whitespace-nowrap), replacing the h2.section-title — the
    heading row keeps `共 N 場` on the right.
  - Move the team-training description out of hero into a new
    <p class="section-desc"> sitting between the heading row and
    the course cards.
  - Restyle the mobile-only 預約一對一 link from the solid btn-primary
    bar to the lighter btn-pill-outline, matching the hero-eyebrow
    visual family.

Mobile-only visibility on the CTA is preserved (sm:hidden); desktop
users continue to navigate via the navbar 「一對一預約」 link.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Push branch + open draft PR

**Files:** none (git remote operation)

- [ ] **Step 1: Push branch with upstream tracking**

```bash
git push -u origin feature/ui-polish-navbar-home
```

- [ ] **Step 2: Open draft PR via GitHub API**

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -sS -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -d "$(cat <<'EOF'
{
  "title": "UI polish: navbar role identity + home 1-on-1 CTA + heading merge",
  "head": "feature/ui-polish-navbar-home",
  "base": "main",
  "draft": true,
  "body": "## Summary\n\n- Navbar: owner/admin/coach show role badge only (drop name + email); coach now gets a purple `.badge-coach` (fixes existing fallthrough to 會員)\n- Home: 預約一對一 CTA redesigned from solid-blue full-width bar to outlined pill (`.btn-pill-outline`), mobile-only kept\n- Home: collapse redundant hero h1 + section h2 into a single 22px section heading; move team-training description below it; introduce `.section-desc`\n\n## Test plan\n\n- [ ] Login as owner → amber 擁有者 badge, no name, no email (mobile + desktop, navbar across all 6 pages)\n- [ ] Login as admin → blue 管理者 badge, no name, no email\n- [ ] Login as coach → **purple** 教練 badge (not green 會員), no name\n- [ ] Login as member → points pill + green 會員 badge + name + email (email desktop-only)\n- [ ] Home @ 390px: eyebrow → outlined CTA pill → 22px one-line heading + count → description → cards\n- [ ] Home @ ≥768px: CTA hidden, layout otherwise identical structure\n- [ ] CTA click → /coaches.html\n- [ ] Other 5 pages (admin, coach, coaches, my-schedule, line) navbar shows no regression\n\n## Design refs\n\n- Spec: `docs/superpowers/specs/2026-05-15-navbar-identity-and-home-cta-design.md`\n- Plan: `docs/superpowers/plans/2026-05-15-navbar-identity-and-home-cta.md`\n\n## Deviations from spec\n\n- None at time of PR open.\n"
}
EOF
)"
```

Record the returned PR number and URL.

---

## Task 5: Manual mobile smoke test (USER gate)

**Files:** none — user runs the test plan from the PR body in a 390px viewport.

This is the merge gate per the user's workflow preferences. The agent does not advance past this until the user reports back.

- [ ] **Step 1:** User runs through the PR Test plan checklist
- [ ] **Step 2:** If bugs found, file them as follow-up subagent tasks against the same branch, fix, push, re-smoke
- [ ] **Step 3:** When all checks pass, proceed to Task 6

---

## Task 6: Final holistic code-review (sonnet subagent)

**Files:** none — review-only

- [ ] **Step 1: Dispatch a sonnet code-review subagent** with this prompt:

> Holistically review the diff on `feature/ui-polish-navbar-home` against `main`. Spec at `docs/superpowers/specs/2026-05-15-navbar-identity-and-home-cta-design.md`. Look specifically for:
>
> 1. CSS layering: `.btn-pill-outline` deliberately omits `display`/`width` (style.css loads after Tailwind CDN, so it would override `sm:hidden`). The `<a>` uses `flex w-full sm:hidden` for layout. Verify that at desktop ≥640px the CTA actually disappears (i.e. `sm:hidden` wins over the `flex` utility), and that at mobile the pill renders as a flex row centered with `gap-2` between icon / label / arrow.
> 2. `renderAuthBar` branching: does the `nameHtml = isMember ? ... : ''` correctly drop both `<span>`s for non-members, including the desktop email? Any race / null-name issues if `user.name` is empty string?
> 3. Accessibility: heading hierarchy is now h1 (page) → no other h1s on the page. Acceptable, but confirm no other page-level h1 on index.html. The CTA arrow is `aria-hidden`; the surrounding `<span>` chain still presents readable text content.
> 4. XSS: `escapeHtml()` is still applied to all user-controlled fields (`user.name`, `user.email`). Confirm.
> 5. Regression risk on the 5 other pages that load `app.js`: any place that depended on `user.name` appearing in the navbar DOM? (Search for queries against `#auth-bar`'s name span.)
>
> Return: blockers / important / nits, no rewriting.

- [ ] **Step 2: Address any Blocker / Important findings** with focused commits on the same branch, push, mark resolved
- [ ] **Step 3:** Nit findings — judgement call, fix if cheap, defer otherwise

---

## Task 7: Merge + cleanup

**Files:** none (git + GitHub API)

- [ ] **Step 1: Flip PR from draft to ready**

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
PR_NODE_ID=$(curl -sS -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls/<PR_NUM> | \
  /Users/ryansheu/.local/bin/node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).node_id))')
curl -sS -X POST \
  -H "Authorization: bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/graphql \
  -d "{\"query\":\"mutation { markPullRequestReadyForReview(input: {pullRequestId: \\\"$PR_NODE_ID\\\"}) { pullRequest { isDraft } } }\"}"
```

- [ ] **Step 2: Merge via API (squash)**

```bash
curl -sS -X PUT \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls/<PR_NUM>/merge \
  -d '{"merge_method":"squash"}'
```

- [ ] **Step 3: Delete the remote + local branch**

```bash
git checkout main
git pull --ff-only origin main
git push origin --delete feature/ui-polish-navbar-home
git branch -D feature/ui-polish-navbar-home
```

- [ ] **Step 4: Confirm Railway auto-deploy picked up the new commit** (check Railway dashboard or `https://<railway-url>/` shows the updated UI)

---

## Notes for the implementer

- All three tasks are pure front-end. No Node restarts strictly required between edits since this isn't a build step, but a fresh hard-reload (`Cmd+Shift+R`) clears the Tailwind CDN cache.
- The visual companion server (if still running from brainstorm) lives at `.superpowers/brainstorm/` and is fine to leave running or stop with `scripts/stop-server.sh`.
- The earlier untracked `scripts/send-test-push.js` (LINE push test script) and `docs/reports/` are NOT part of this branch and should remain untracked.
