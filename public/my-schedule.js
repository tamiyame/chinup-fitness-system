import { api, fmtDate, toast, bootAuth, escapeHtml } from './app.js';

const user = await bootAuth();
if (!user) throw new Error('__redirected_by_auth__');

const state = {
  items: [],
  filter: 'all',
  pastOpen: false,
};

const LABEL_BOOKING_STATUS = { confirmed: '已預約', cancelled: '已取消' };
const LABEL_REG_STATUS = { confirmed: '正取', waitlisted: '候補', cancelled: '已取消', rejected: '未開課' };

function dateBlock(start_at) {
  const dt = new Date(start_at);
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `
    <div class="text-center px-3 py-2 rounded-lg" style="background:var(--brand-50);min-width:64px;">
      <div class="text-2xl font-bold" style="color:var(--brand-700);line-height:1;">${d}</div>
      <div class="text-xs mt-1" style="color:var(--brand-700)">${dt.getFullYear()}/${m}</div>
    </div>
  `;
}

function statusBadge(item) {
  if (item.kind === 'booking') {
    const label = LABEL_BOOKING_STATUS[item.status] || item.status;
    return `<span class="badge badge-${item.status}">${label}</span>`;
  }
  const label = LABEL_REG_STATUS[item.status] || item.status;
  return `<span class="badge badge-${item.status}">${label}</span>`;
}

function cardHtml(item) {
  const kindPill = item.kind === 'booking'
    ? '<span class="pill-kind pill-1on1">🏋️ 一對一</span>'
    : '<span class="pill-kind pill-group">👥 團課</span>';
  const title = item.kind === 'booking' ? item.coach_display_name : item.course_name;
  const duration = item.kind === 'booking' ? 60 : (item.duration_minutes || 60);
  const positionTag = (item.kind === 'registration' && item.position)
    ? `<span class="subtle ml-2">候補 #${item.position}</span>` : '';
  const noteLine = (item.kind === 'booking' && item.note)
    ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(item.note)}</div>` : '';
  const cancelReasonLine = (item.kind === 'booking' && item.cancel_reason)
    ? `<div class="text-sm text-red-500 mt-1">原因：${escapeHtml(item.cancel_reason)}</div>` : '';
  const cancelBtn = item.can_cancel
    ? `<button data-id="${item.id}" data-kind="${item.kind}" class="cancel-btn btn btn-danger btn-sm">取消</button>`
    : '';

  return `
    <article class="card">
      <div class="flex items-center gap-4">
        ${dateBlock(item.start_at)}
        <div class="flex-1">
          <div class="mb-1">${kindPill}</div>
          <h3 class="card-title">${escapeHtml(title || '')}</h3>
          <div class="meta">
            <span class="meta-item"><span class="meta-icon">🕐</span> ${fmtDate(item.start_at)}（${duration} 分鐘）</span>
          </div>
          <div class="flex items-center gap-2 mt-2 flex-wrap">
            ${statusBadge(item)}
            ${positionTag}
          </div>
          ${noteLine}
          ${cancelReasonLine}
        </div>
        ${cancelBtn}
      </div>
    </article>
  `;
}

function filterItems(items, filter) {
  if (filter === 'all') return items;
  return items.filter(i => i.kind === filter);
}

function render() {
  const filtered = filterItems(state.items, state.filter);
  const upcoming = filtered.filter(i => !i.is_past);
  const past     = filtered.filter(i =>  i.is_past);

  const upWrap = document.getElementById('upcoming-list');
  const upEmpty = document.getElementById('upcoming-empty');
  const upEmptyIcon = document.getElementById('upcoming-empty-icon');
  const upEmptyMsg = document.getElementById('upcoming-empty-msg');
  const upEmptyCtas = document.getElementById('upcoming-empty-ctas');

  if (upcoming.length === 0) {
    upWrap.innerHTML = '';
    upEmpty.style.display = 'block';
    const totallyEmpty = state.items.length === 0;
    const hasOnlyPast  = state.filter === 'all' && !totallyEmpty && past.length > 0;
    if (totallyEmpty) {
      upEmptyIcon.style.display = 'inline-block';
      upEmptyMsg.textContent = '還沒有任何預約';
      upEmptyCtas.style.display = 'flex';
    } else if (hasOnlyPast) {
      upEmptyIcon.style.display = 'none';
      upEmptyMsg.textContent = '本週沒有預約';
      upEmptyCtas.style.display = 'none';
    } else if (state.filter === 'booking') {
      upEmptyIcon.style.display = 'none';
      upEmptyMsg.textContent = '「一對一」沒有未來預約';
      upEmptyCtas.style.display = 'flex';
    } else {
      upEmptyIcon.style.display = 'none';
      upEmptyMsg.textContent = '「團課」沒有未來預約';
      upEmptyCtas.style.display = 'flex';
    }
  } else {
    upEmpty.style.display = 'none';
    upWrap.innerHTML = upcoming.map(cardHtml).join('');
  }

  const pastWrap = document.getElementById('past-toggle-wrap');
  const pastList = document.getElementById('past-list');
  const pastCount = document.getElementById('past-count');
  const pastCaret = document.getElementById('past-caret');

  if (past.length === 0) {
    pastWrap.style.display = 'none';
  } else {
    pastWrap.style.display = 'block';
    pastCount.textContent = past.length;
    pastCaret.textContent = state.pastOpen ? '▼' : '▶';
    if (state.pastOpen) {
      pastList.style.display = 'grid';
      pastList.innerHTML = past.map(cardHtml).join('');
    } else {
      pastList.style.display = 'none';
      pastList.innerHTML = '';
    }
  }

  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCancel(Number(btn.dataset.id), btn.dataset.kind));
  });
}

async function handleCancel(id, kind) {
  if (!confirm('確定要取消嗎？')) return;
  const url = kind === 'booking' ? `/api/bookings/${id}` : `/api/registrations/${id}`;
  try {
    await api(url, { method: 'DELETE' });
    toast('已取消', 'success');
    await load();
  } catch (e) {
    toast(`取消失敗：${e.message}`, 'error');
  }
}

function bindTabs() {
  document.querySelectorAll('#tab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      render();
    });
  });
}

function bindPastToggle() {
  document.getElementById('past-toggle').addEventListener('click', () => {
    state.pastOpen = !state.pastOpen;
    render();
  });
}

async function load() {
  try {
    const { items } = await api('/api/my/schedule');
    state.items = items ?? [];
    hideLoadError();
    render();
  } catch (e) {
    showLoadError(e);
  }
}

function showLoadError(e) {
  document.getElementById('main-section').style.display = 'none';
  const errBox = document.getElementById('load-error');
  errBox.style.display = 'block';
  document.getElementById('load-error-msg').textContent = `載入失敗：${e.message}`;
  toast(`載入失敗：${e.message}`, 'error');
}

function hideLoadError() {
  document.getElementById('main-section').style.display = '';
  document.getElementById('load-error').style.display = 'none';
}

document.getElementById('load-error-retry').addEventListener('click', async () => {
  hideLoadError();
  await load();
});

bindTabs();
bindPastToggle();
await load();
document.body.style.visibility = 'visible';
