import { api, toast, fmtDate, bootAuth, getUser } from '/app.js';

const user = await bootAuth();
if (!user) throw new Error('__redirected_by_auth__');

const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

async function load() {
  const uid = getUser();
  const list = document.getElementById('sessions');
  const empty = document.getElementById('empty');
  const badge = document.getElementById('count-badge');
  if (!list) return;

  try {
    const sessions = await api('/api/sessions');
    let myRegs = [];
    if (uid) {
      try { myRegs = await api('/api/my/registrations'); } catch {}
    }
    // Only active registrations (confirmed/waitlisted) should dim the register button.
    // Cancelled/rejected regs remain in history (visible in my.html) but must not
    // prevent re-registering on the courses page.
    const mySet = new Map(
      myRegs
        .filter(r => r.status === 'confirmed' || r.status === 'waitlisted')
        .map(r => [r.session_id, r])
    );

    if (!sessions.length) {
      empty.style.display = 'block'; list.innerHTML = '';
      badge.textContent = '';
      return;
    }
    empty.style.display = 'none';
    badge.textContent = `共 ${sessions.length} 場`;

    // Group by course template (= "course type"). Sessions API already
    // sorts by start_at ASC so the first entry in each group is the nearest.
    const groups = new Map();
    for (const s of sessions) {
      const key = s.template_id;
      if (!groups.has(key)) {
        groups.set(key, {
          name: s.name,
          description: s.description,
          min_capacity: s.min_capacity,
          max_capacity: s.max_capacity,
          duration_minutes: s.duration_minutes,
          sessions: [],
        });
      }
      groups.get(key).sessions.push(s);
    }

    // Order courses by next-upcoming session so soonest shows first.
    const ordered = [...groups.values()].sort(
      (a, b) => new Date(a.sessions[0].start_at) - new Date(b.sessions[0].start_at)
    );

    list.innerHTML = ordered.map((g) => renderCourseGroup(g, mySet)).join('');

    list.querySelectorAll('.register-btn').forEach(btn => {
      btn.addEventListener('click', () => handleRegister(Number(btn.dataset.sessionId)));
    });
  } catch (e) {
    toast(`載入失敗：${e.message}`, 'error');
  }
}

function renderCourseGroup(group, mySet) {
  const next = group.sessions[0]; // sorted asc by start_at
  const nextDt = new Date(next.start_at);
  const nextLabel = `${String(nextDt.getMonth() + 1).padStart(2, '0')}/${String(nextDt.getDate()).padStart(2, '0')} 週${DOW_SHORT[nextDt.getDay()]} ${next.start_at.slice(11, 16)}`;

  // Mark group as "fully booked" if every session is at/over max capacity
  const anyOpen = group.sessions.some((s) => s.confirmed_count < s.max_capacity);
  const hotBadge = !anyOpen
    ? '<span class="badge badge-waitlisted" style="font-size:11px;">全數額滿</span>'
    : '';

  const chevron = `<svg class="day-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  return `
  <details class="day-group">
    <summary>
      <div class="day-chip">${group.sessions.length}<span class="day-chip-unit">場</span></div>
      <div class="day-title">
        <h3>${group.name} ${hotBadge}</h3>
        <p>${group.description || ''}</p>
        <p class="course-meta">🗓 下次 ${nextLabel}・⏱ ${group.duration_minutes} 分鐘・👥 ${group.min_capacity}–${group.max_capacity} 人</p>
      </div>
      ${chevron}
    </summary>
    <div class="day-group-content">
      ${group.sessions.map((s) => card(s, mySet.get(s.id))).join('')}
    </div>
  </details>`;
}

function card(s, my) {
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
  <article class="card">
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
  </article>`;
}

function monthLabel(dt) {
  return `${dt.getFullYear()} / ${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function formatTime(dt) {
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

async function handleRegister(sessionId) {
  if (!getUser()) return toast('請先選擇登入身分', 'error');
  try {
    const r = await api(`/api/sessions/${sessionId}/register`, { method: 'POST' });
    toast(r.status === 'confirmed' ? '🎉 報名成功（正取）' : `已進候補 第 ${r.position} 位`, 'success');
    load();
  } catch (e) {
    toast(e.data?.error === 'already_registered' ? '您已報名過' : `報名失敗：${e.message}`, 'error');
  }
}

load();

// Refresh when navigating back from bfcache (e.g. user cancels on my.html
// then hits browser Back) so the register button reflects current state.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) load();
});
