import { api, fmtDate, dow, toast, getUser, escapeHtml, renderAuthBar } from './app.js';

const $ = (id) => document.getElementById(id);
const DOW_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
let me = null;

async function init() {
  try {
    me = await api('/api/coach/me');
  } catch (e) {
    if (e.status === 404) { location.href = '/'; return; }
    throw e;
  }
  if (!me.is_active) $('pending-banner').classList.remove('hidden');

  // 渲染右上角身份列（含「綁定 LINE」按鈕）。coach.html 走 /api/coach/me 驗證、不經 bootAuth；
  // 取真正的使用者(含 is_admin)來渲染，讓「教練兼管理者」也能看到管理者徽章與管理後台連結。
  const authUser = await api('/api/auth/me').catch(() => ({ role: 'coach' }));
  await renderAuthBar(authUser);

  // Tab switching
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  await renderBookings();
  document.body.style.visibility = 'visible';
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('tab-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'bookings') renderBookings();
  if (name === 'availability') renderAvailability();
  if (name === 'profile') renderProfile();
}

async function renderBookings() {
  const list = await api('/api/coach/me/bookings');
  const wrap = $('tab-bookings');
  if (list.length === 0) { wrap.innerHTML = '<p class="text-slate-500">沒有預約</p>'; return; }
  wrap.innerHTML = '';
  for (const b of list) {
    const card = document.createElement('div');
    card.className = 'card mb-3';
    const cancelled = b.status === 'cancelled';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold">${escapeHtml(b.member_name)}${b.session_type === '1on2' ? ' <span class="text-xs font-medium text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 align-middle">1對2</span>' : ''}</div>
          <div class="text-sm text-slate-600">${fmtDate(b.start_at)}</div>
          ${b.note ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(b.note)}</div>` : ''}
          ${cancelled ? `<div class="text-sm text-red-500 mt-1">已取消${b.cancel_reason ? `（${escapeHtml(b.cancel_reason)}）` : ''}</div>` : ''}
        </div>
        ${!cancelled && new Date(b.start_at) > new Date() ? `<button data-id="${b.id}" class="btn-secondary text-sm cancel-btn">緊急取消</button>` : ''}
      </div>
    `;
    wrap.appendChild(card);
  }
  wrap.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const reason = prompt('取消原因（會通知會員）：');
      if (!reason) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}`, { method: 'DELETE', body: { reason } });
        toast('已取消');
        renderBookings();
      } catch (e) {
        toast(`取消失敗：${e.message}`, 'error');
      }
    });
  });
}

async function renderAvailability() {
  const [rules, exceptions] = await Promise.all([
    api('/api/coach/me/rules'),
    api('/api/coach/me/exceptions'),
  ]);

  $('tab-availability').innerHTML = `
    <h2 class="section-title">每週基底班表</h2>
    <div id="rule-list" class="space-y-2 mb-4"></div>
    <details class="card mb-6">
      <summary class="font-semibold cursor-pointer">+ 新增規則</summary>
      <form id="rule-form" novalidate class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select name="day_of_week" class="border rounded p-2 text-sm">
          ${DOW_LABELS.map((l, i) => `<option value="${i}">${l}</option>`).join('')}
        </select>
        <input type="time" name="start_time" step="600" class="border rounded p-2 text-sm">
        <input type="time" name="end_time" step="600" class="border rounded p-2 text-sm">
        <button class="btn-primary text-sm">加入</button>
      </form>
    </details>

    <h2 class="section-title">特殊日期（請假 / 加開）</h2>
    <div id="exception-list" class="space-y-2 mb-4"></div>
    <details class="card">
      <summary class="font-semibold cursor-pointer">+ 標記例外</summary>
      <form id="exception-form" novalidate class="mt-3 space-y-2">
        <div class="flex gap-2">
          <input type="date" name="exception_date" required class="border rounded p-2 text-sm flex-1">
          <select name="type" class="border rounded p-2 text-sm">
            <option value="leave">請假</option>
            <option value="extra">加開</option>
          </select>
        </div>
        <label class="flex items-center gap-2 text-sm" id="ex-allday-wrap">
          <input type="checkbox" id="ex-allday" checked> 整天
        </label>
        <div class="flex gap-2 hidden" id="ex-times">
          <input type="time" name="start_time" step="600" class="border rounded p-2 text-sm flex-1">
          <input type="time" name="end_time" step="600" class="border rounded p-2 text-sm flex-1">
        </div>
        <input type="text" name="note" placeholder="備註（選填）" class="border rounded p-2 text-sm w-full">
        <button class="btn-primary text-sm w-full">加入</button>
      </form>
    </details>
  `;

  const ruleList = $('rule-list');
  if (rules.length === 0) ruleList.innerHTML = '<p class="text-slate-500 text-sm">還沒設定班表</p>';
  for (const r of rules) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between p-2 border rounded';
    row.innerHTML = `<span>${DOW_LABELS[r.day_of_week]} ${r.start_time}–${r.end_time}</span>
      <button data-id="${r.id}" class="text-red-500 text-sm rule-del">刪除</button>`;
    ruleList.appendChild(row);
  }
  ruleList.querySelectorAll('.rule-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/rules/${b.dataset.id}`, { method: 'DELETE' });
    renderAvailability();
  }));

  $('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const start = fd.get('start_time');
    const end = fd.get('end_time');
    if (!start || !end) { toast('請選擇起訖時間', 'error'); return; }
    try {
      await api('/api/coach/me/rules', {
        method: 'POST',
        body: { day_of_week: Number(fd.get('day_of_week')), start_time: start, end_time: end },
      });
      toast('已加入');
      renderAvailability();
    } catch (err) {
      const m = { invalid_time: '結束時間需晚於開始', invalid_time_format: '時間格式錯誤' };
      toast(m[err.data?.error] || `錯誤：${err.message}`, 'error');
    }
  });

  const exList = $('exception-list');
  if (exceptions.length === 0) exList.innerHTML = '<p class="text-slate-500 text-sm">沒有特殊日期</p>';
  for (const ex of exceptions) {
    const row = document.createElement('div');
    const tag = ex.type === 'leave'
      ? (ex.start_time ? `🟡 請假 ${ex.start_time}–${ex.end_time}` : '🟡 請假（整天）')
      : `🟢 加開 ${ex.start_time}–${ex.end_time}`;
    row.className = 'flex items-center justify-between p-2 border rounded';
    row.innerHTML = `<span>${ex.exception_date} · ${tag}${ex.note ? ` · ${escapeHtml(ex.note)}` : ''}</span>
      <button data-id="${ex.id}" class="text-red-500 text-sm ex-del">刪除</button>`;
    exList.appendChild(row);
  }
  exList.querySelectorAll('.ex-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/exceptions/${b.dataset.id}`, { method: 'DELETE' });
    renderAvailability();
  }));

  // 表單切換：加開 → 一律顯示時段、無「整天」；請假 → 顯示「整天」勾選框，
  // 勾「整天」時隱藏時段（整天請假），取消勾選則指定時段（部分請假）。
  const exTypeSel = $('exception-form').querySelector('[name=type]');
  const exAllday = $('ex-allday');
  function syncExceptionForm() {
    const isLeave = exTypeSel.value === 'leave';
    $('ex-allday-wrap').classList.toggle('hidden', !isLeave);
    const showTimes = !isLeave || !exAllday.checked;
    $('ex-times').classList.toggle('hidden', !showTimes);
  }
  exTypeSel.addEventListener('change', syncExceptionForm);
  exAllday.addEventListener('change', syncExceptionForm);
  syncExceptionForm();

  $('exception-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const type = fd.get('type');
    const allDay = type === 'leave' && exAllday.checked;
    const start_time = allDay ? null : (fd.get('start_time') || null);
    const end_time = allDay ? null : (fd.get('end_time') || null);
    if (!allDay && (!start_time || !end_time)) { toast('請選擇起訖時間', 'error'); return; }
    try {
      await api('/api/coach/me/exceptions', {
        method: 'POST',
        body: { exception_date: fd.get('exception_date'), type, start_time, end_time, note: fd.get('note') || null },
      });
      toast('已加入');
      renderAvailability();
    } catch (err) {
      const m = { invalid_time: '結束時間需晚於開始', invalid_time_format: '時間格式錯誤', missing_time: '請選擇起訖時間' };
      toast(m[err.data?.error] || `錯誤：${err.message}`, 'error');
    }
  });
}

async function renderProfile() {
  $('tab-profile').innerHTML = `
    <form id="profile-form" class="space-y-3 max-w-lg">
      <label class="block">
        <span class="text-sm text-slate-600">顯示名稱</span>
        <input name="display_name" value="${escapeAttr(me.display_name)}" class="mt-1 w-full border rounded p-2 text-sm" required>
      </label>
      <label class="block">
        <span class="text-sm text-slate-600">專長</span>
        <input name="specialty" value="${escapeAttr(me.specialty || '')}" class="mt-1 w-full border rounded p-2 text-sm" placeholder="例：增肌減脂 · 體態雕塑">
      </label>
      <label class="block">
        <span class="text-sm text-slate-600">介紹</span>
        <textarea name="bio" rows="4" class="mt-1 w-full border rounded p-2 text-sm">${escapeHtml(me.bio || '')}</textarea>
      </label>
      <div>
        <span class="text-sm text-slate-600">頭像</span>
        <div class="flex items-center gap-3 mt-1">
          <div class="w-16 h-16 rounded-full bg-slate-200 overflow-hidden">
            ${me.avatar_path ? `<img src="/avatars/${me.avatar_path}" class="w-full h-full object-cover">` : ''}
          </div>
          <input type="file" id="avatar-input" accept="image/png,image/jpeg" class="text-sm">
        </div>
      </div>
      <button class="btn-primary">儲存</button>
    </form>
  `;

  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/coach/me/profile', {
        method: 'PATCH',
        body: {
          display_name: fd.get('display_name'),
          specialty: fd.get('specialty') || null,
          bio: fd.get('bio') || null,
        },
      });
      const file = $('avatar-input').files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) { toast('頭像超過 2MB', 'error'); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          await api('/api/coach/me/avatar', { method: 'POST', body: { avatar_base64: reader.result } });
          toast('已儲存');
          me = await api('/api/coach/me');
          renderProfile();
        };
        reader.readAsDataURL(file);
      } else {
        toast('已儲存');
        me = await api('/api/coach/me');
      }
    } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
  });
}

function escapeAttr(s) { return escapeHtml(s); }

await init();
