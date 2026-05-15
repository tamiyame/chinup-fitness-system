import { api, fmtDate, dow, toast, refreshAuthBar, escapeHtml, getUser } from './app.js';

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
    <button type="button" class="book-cta" data-coach-id="${coach.id}">預約${escapeHtml(coach.display_name)} →</button>
  `;
}

function renderExpand(targetEl, coach) {
  targetEl.className = 'ccard-expand';
  targetEl.innerHTML = expandSkeletonHtml(coach);
  const cta = targetEl.querySelector('.book-cta');
  cta.addEventListener('click', () => openCoach(coach.id));
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
  if (currentlyExpandedId === coachId) {
    collapseCurrent();
    return;
  }
  collapseCurrent();
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
  // Skip silently for logged-out visitors — the pinned section needs an
  // authenticated user. Hitting /api/my/recent-coach would 401, which the
  // shared api() helper escalates into a forced redirect to /login.
  if (!getUser()) return;
  let data;
  try {
    data = await api('/api/my/recent-coach');
  } catch {
    return; // silent — section stays hidden
  }
  if (!data || !data.coach) return;

  const section = $('recent-section');
  section.classList.remove('hidden');

  $('recent-ago').textContent = relativeDays(data.days_ago ?? 0);

  allCoachesById.set(data.coach.id, data.coach);

  // Render the pinned card AND its expand panel as true siblings inside
  // #recent-mount so the generic accordion logic (collapseCurrent /
  // expandCard) handles the pinned card identically to bottom-list cards.
  const mount = $('recent-mount');
  mount.innerHTML = cardHtml(data.coach, { pinned: true, expanded: true });
  attachCardHandlers(mount);

  const cardEl = mount.querySelector('.ccard');
  const expandEl = document.createElement('div');
  expandEl.setAttribute('data-for-coach', String(data.coach.id));
  cardEl.insertAdjacentElement('afterend', expandEl);
  renderExpand(expandEl, data.coach);

  currentlyExpandedId = data.coach.id;
  ensureSlotsLoaded(data.coach.id, expandEl.querySelector('.slot-area'));

  // Dedupe: the same coach was just rendered in #coach-list by loadCoachList.
  // Keeping only the pinned instance avoids two confusing UX gotchas:
  //  - clicking the bottom duplicate triggers a collapse-only path (since
  //    currentlyExpandedId already matches), making the pinned collapse out
  //    of viewport with no visible feedback;
  //  - after collapsing pinned, clicking the bottom duplicate would re-expand
  //    next to the pinned (first querySelector match), not where the user
  //    clicked.
  const bottomDup = $('coach-list').querySelector(`.ccard[data-coach-id="${data.coach.id}"]`);
  if (bottomDup) bottomDup.remove();
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

  // Recent section runs after the list so its data-coach-id matches a card
  // already in the DOM; if the recent coach is also in the list, collapsing
  // the pinned one finds both elements via querySelectorAll.
  await loadRecentSection();
}

async function openCoach(id) {
  weekOffset = 0;
  currentCoach = await api(`/api/coaches/${id}`);
  const det = $('coach-detail');
  det.innerHTML = `
    <div class="flex items-center gap-4 mb-3">
      <div class="w-16 h-16 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
        ${currentCoach.avatar_path ? `<img src="/avatars/${currentCoach.avatar_path}" class="w-full h-full object-cover">` : ''}
      </div>
      <div>
        <h1 class="text-xl font-bold">${escapeHtml(currentCoach.display_name)}</h1>
        <div class="text-sm text-slate-500">${escapeHtml(currentCoach.specialty || '')}</div>
      </div>
    </div>
    ${currentCoach.bio ? `<p class="text-sm text-slate-700 whitespace-pre-line">${escapeHtml(currentCoach.bio)}</p>` : ''}
  `;
  show('detail');
  renderSlotControls();
  await loadSlots();
}

function renderSlotControls() {
  const ctrls = $('slot-controls');
  ctrls.innerHTML = `
    <button class="btn-secondary" id="prev-week">← 上週</button>
    <span id="week-label" class="font-medium"></span>
    <button class="btn-secondary" id="next-week">下週 →</button>
  `;
  $('prev-week').addEventListener('click', () => {
    if (weekOffset > 0) { weekOffset--; updatePrevDisabled(); loadSlots(); }
  });
  $('next-week').addEventListener('click', () => {
    weekOffset++; updatePrevDisabled(); loadSlots();
  });
  updatePrevDisabled();
}

function updatePrevDisabled() {
  const btn = document.getElementById('prev-week');
  if (btn) btn.disabled = weekOffset <= 0;
}

function weekRange(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const f = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: f(start), to: f(end) };
}

async function loadSlots() {
  const { from, to } = weekRange(weekOffset);
  $('week-label').textContent = `${from} ~ ${to}`;
  const slots = await api(`/api/coaches/${currentCoach.id}/availability?from=${from}&to=${to}`);
  const grid = $('slot-grid');
  grid.innerHTML = '';
  if (slots.length === 0) {
    grid.innerHTML = '<p class="col-span-full text-slate-500 text-sm">本週沒有可預約時段</p>';
    return;
  }
  for (const s of slots) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary text-sm';
    const d = new Date(s);
    btn.textContent = `${d.getMonth() + 1}/${d.getDate()}（${dow(d.getDay())[1]}）${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    btn.addEventListener('click', () => openConfirm(s));
    grid.appendChild(btn);
  }
}

async function openConfirm(slotStr) {
  currentSlot = slotStr;
  const d = new Date(slotStr);
  $('confirm-summary').innerHTML = `
    <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${escapeHtml(currentCoach.display_name)}</strong></div>
    <div><span class="text-slate-500">時間</span><br><strong>${fmtDate(slotStr)}（60 分鐘）</strong></div>
  `;
  $('note').value = '';

  // Phase 2: check balance, disable confirm button if 0
  try {
    const bal = await api('/api/my/points/balance');
    const btn = $('confirm-btn');
    if (bal.one_on_one <= 0) {
      btn.disabled = true;
      btn.textContent = '點數不足，無法預約';
      btn.classList.add('opacity-50');
      let hint = document.getElementById('balance-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'balance-hint';
        hint.className = 'text-sm text-red-500 mt-2';
        btn.parentNode.insertBefore(hint, btn.nextSibling);
      }
      hint.textContent = '目前一對一餘額 0 點，請聯絡管理員儲值。';
    } else {
      btn.disabled = false;
      btn.textContent = '確認預約';
      btn.classList.remove('opacity-50');
      const hint = document.getElementById('balance-hint');
      if (hint) hint.remove();
    }
  } catch {} // silent — if balance fetch fails, still let them try; backend will block

  show('confirm');
}

$('back-to-list').addEventListener('click', () => show('list'));
$('back-to-detail').addEventListener('click', () => show('detail'));

$('confirm-btn').addEventListener('click', async () => {
  try {
    const note = $('note').value.trim();
    const result = await api('/api/bookings', {
      method: 'POST',
      body: { coach_id: currentCoach.id, start_at: currentSlot, note: note || null },
    });
    toast('預約成功！', 'success');
    await refreshAuthBar();
    setTimeout(() => location.href = '/my-schedule', 700);
  } catch (e) {
    if (e.data?.error === 'slot_taken') {
      toast('此時段剛被預約走了', 'error');
    } else if (e.data?.error === 'insufficient_points') {
      toast('點數不足，請聯絡管理員', 'error');
    } else {
      toast(`預約失敗：${e.message}`, 'error');
    }
  }
});

await loadCoachList();
document.body.style.visibility = 'visible';
