import { api, fmtDate, dow, toast, getUser, escapeHtml, renderAuthBar } from './app.js';

const $ = (id) => document.getElementById(id);
const DOW_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
let me = null;
let isAdmin = false;
let selectedCoachId = null; // admin 代選的教練 id；null = 自己/未選

// admin 代選教練時，GET/DELETE 用的 querystring；非 admin 或未選 → 空字串（落回 self）
function coachQuery() {
  return (isAdmin && selectedCoachId != null) ? `?coachId=${selectedCoachId}` : '';
}
// admin 代選教練時，POST/PATCH body 補上 coachId
function withCoach(body) {
  return (isAdmin && selectedCoachId != null) ? { ...body, coachId: selectedCoachId } : body;
}
// admin 尚未選教練（且自己沒有教練檔案）→ 顯示提示、不打 API
function needsCoachSelection() { return isAdmin && selectedCoachId == null; }
const PICK_PROMPT = '<p class="text-slate-500">請先從上方選擇教練</p>';

function refreshPendingBanner() {
  const banner = $('pending-banner');
  if (!banner) return;
  banner.classList.toggle('hidden', !(me && !me.is_active));
}

// 班表時間欄：下拉只給 10 分為單位（00/10/20/30/40/50），呈現像 Google Calendar 的小捲動框；
// 手動仍可打精確分鐘（送出/離開焦點時正規化為 HH:MM）。原生時間欄/ datalist 的下拉高度無法自訂，故自製。
const TIME10_OPTIONS = Array.from({ length: 24 * 6 }, (_, i) =>
  `${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`);
function normTime(v) {
  v = (v || '').trim();
  if (!v) return '';
  let h, m;
  if (v.includes(':')) { const p = v.split(':'); h = p[0]; m = p[1]; }
  else { const d = v.replace(/\D/g, ''); if (d.length <= 2) { h = d; m = '0'; } else { h = d.slice(0, d.length - 2); m = d.slice(-2); } }
  h = parseInt(h, 10); m = parseInt(m, 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return v; // 無法解析 → 原樣，交後端擋
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
const TIME10_ATTRS = 'type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" autocomplete="off" data-time10';

// 自訂時間下拉（固定高度小框、可捲動）。掛在 body 以免被父層裁切。
function attachTimeDropdown(input) {
  const dd = document.createElement('div');
  dd.className = 'time-dd';
  dd.style.display = 'none';
  document.body.appendChild(dd);
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = `${r.left}px`;
    dd.style.top = `${r.bottom + 2}px`;
    dd.style.width = `${r.width}px`;
  };
  const show = () => {
    const digits = input.value.replace(/\D/g, '');
    const opts = TIME10_OPTIONS.filter(t => !digits || t.replace(':', '').startsWith(digits));
    if (!opts.length) { dd.style.display = 'none'; return; } // 打精確分鐘(非10單位) → 不顯示
    dd.innerHTML = opts.map(t => `<div class="time-dd-opt" data-v="${t}">${t}</div>`).join('');
    position();
    dd.style.display = 'block';
    // 捲到目前值附近（沒值則 08:00）
    const anchor = dd.querySelector(`[data-v="${normTime(input.value)}"]`) || dd.querySelector('[data-v="08:00"]');
    if (anchor) dd.scrollTop = Math.max(0, anchor.offsetTop - dd.clientHeight / 2);
  };
  const hide = () => { dd.style.display = 'none'; };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('blur', () => setTimeout(() => { if (input.value.trim()) input.value = normTime(input.value); hide(); }, 150));
  dd.addEventListener('mousedown', (e) => {
    const o = e.target.closest('.time-dd-opt');
    if (!o) return;
    e.preventDefault(); // 保持 input 焦點、避免先觸發 blur
    input.value = o.dataset.v;
    hide();
  });
  window.addEventListener('scroll', () => { if (dd.style.display !== 'none') position(); }, true);
  window.addEventListener('resize', () => { if (dd.style.display !== 'none') position(); });
}

async function init() {
  // 先取真正的使用者（含 is_admin），決定是否顯示教練下拉。
  const authUser = await api('/api/auth/me').catch(() => ({ role: 'coach' }));
  isAdmin = !!authUser.is_admin;

  if (isAdmin) {
    try {
      await setupCoachPicker(); // 顯示+填入下拉，預設選自己（若有教練檔案）
    } catch (e) {
      toast(`載入教練清單失敗：${e.message}`, 'error');
    }
  } else {
    try {
      me = await api('/api/coach/me');
    } catch (e) {
      if (e.status === 404) { location.href = '/'; return; }
      throw e;
    }
  }

  refreshPendingBanner();
  await renderAuthBar(authUser);

  // Tab switching
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  await renderBookings();
  document.body.style.visibility = 'visible';
}

// admin：建立教練下拉。只列已啟用教練；若自己的教練檔案未啟用也補進清單以支援「預設選自己」。
async function setupCoachPicker() {
  const picker = $('coach-picker');
  let self = null;
  try { self = await api('/api/coach/me'); } catch (e) { if (e.status !== 404) throw e; }

  const all = await api('/api/admin/coaches');
  const active = all.filter(c => c.is_active);
  if (self && !active.some(c => c.id === self.id)) active.unshift(self);

  picker.innerHTML = '<option value="">— 請選擇教練 —</option>' +
    active.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}${c.is_active ? '' : '（未啟用）'}</option>`).join('');

  if (self) {
    selectedCoachId = self.id;
    me = self;
    picker.value = String(self.id);
  } else {
    selectedCoachId = null;
    me = null;
  }
  picker.classList.remove('hidden');
  picker.addEventListener('change', onCoachChange);
}

async function onCoachChange() {
  const v = $('coach-picker').value;
  selectedCoachId = v ? Number(v) : null;
  me = (selectedCoachId == null) ? null : await api(`/api/coach/me${coachQuery()}`);
  refreshPendingBanner();
  switchTab('bookings'); // 切回第一個分頁並重渲染
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('tab-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'bookings') renderBookings();
  if (name === 'availability') renderAvailability();
  if (name === 'profile') renderProfile();
}

async function renderBookings() {
  const wrap = $('tab-bookings');
  if (needsCoachSelection()) { wrap.innerHTML = PICK_PROMPT; return; }
  const list = await api(`/api/coach/me/bookings${coachQuery()}`);
  if (list.length === 0) { wrap.innerHTML = '<p class="text-slate-500">沒有預約</p>'; return; }
  wrap.innerHTML = '';
  for (const b of list) {
    const card = document.createElement('div');
    const cancelled = b.status === 'cancelled';
    card.className = `card mb-3 tab-bookings-card${cancelled ? ' is-cancelled' : ''}`;
    // 付款狀態：admin 核款後「已確認」，否則「待確認」（已取消不顯示）；Nike 用狀態小圓點 + 色字
    const payBadge = cancelled ? '' : (b.paid_at
      ? ' <span class="nk-dot ok align-middle">已確認</span>'
      : ' <span class="nk-dot warn align-middle">待確認</span>');
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold flex items-center gap-2 flex-wrap">${escapeHtml(b.member_name)}${b.session_type === '1on2' ? ' <span class="nk-tag">1對2</span>' : ''}${payBadge}</div>
          <div class="text-sm bk-when">${fmtDate(b.start_at)}</div>
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
        await api(`/api/bookings/${btn.dataset.id}${coachQuery()}`, { method: 'DELETE', body: { reason } });
        toast('已取消');
        renderBookings();
      } catch (e) {
        toast(`取消失敗：${e.message}`, 'error');
      }
    });
  });
}

async function renderAvailability() {
  if (needsCoachSelection()) { $('tab-availability').innerHTML = PICK_PROMPT; return; }
  const [rules, exceptions] = await Promise.all([
    api(`/api/coach/me/rules${coachQuery()}`),
    api(`/api/coach/me/exceptions${coachQuery()}`),
  ]);

  $('tab-availability').innerHTML = `
    <details open class="mb-5">
      <summary class="section-title cursor-pointer" style="margin-bottom:10px;">每週基底班表</summary>
      <div id="rule-list" class="space-y-2 mb-4"></div>
      <details class="card mb-2">
        <summary class="font-semibold cursor-pointer">+ 新增規則</summary>
      <form id="rule-form" class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select name="day_of_week" class="border rounded p-2 text-sm">
          ${DOW_LABELS.map((l, i) => `<option value="${i}">${l}</option>`).join('')}
        </select>
        <input ${TIME10_ATTRS} name="start_time" class="border rounded p-2 text-sm">
        <input ${TIME10_ATTRS} name="end_time" class="border rounded p-2 text-sm">
        <button class="btn-primary text-sm">加入</button>
      </form>
      </details>
    </details>

    <details open class="mb-2">
      <summary class="section-title cursor-pointer" style="margin-bottom:10px;">特殊日期（請假 / 加開）</summary>
      <div id="exception-list" class="space-y-2 mb-4"></div>
      <details class="card">
        <summary class="font-semibold cursor-pointer">+ 標記例外</summary>
      <form id="exception-form" class="mt-3 space-y-2">
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
          <input ${TIME10_ATTRS} name="start_time" class="border rounded p-2 text-sm flex-1">
          <input ${TIME10_ATTRS} name="end_time" class="border rounded p-2 text-sm flex-1">
        </div>
        <input type="text" name="note" placeholder="備註（選填）" class="border rounded p-2 text-sm w-full">
        <button class="btn-primary text-sm w-full">加入</button>
      </form>
      </details>
    </details>
  `;

  // 重繪時先移除舊的下拉浮層（避免殘留），再為每個時間欄掛自訂下拉 + 正規化。
  document.querySelectorAll('.time-dd').forEach(el => el.remove());
  document.querySelectorAll('#tab-availability input[data-time10]').forEach(attachTimeDropdown);

  const ruleList = $('rule-list');
  if (rules.length === 0) ruleList.innerHTML = '<p class="text-slate-500 text-sm">還沒設定班表</p>';
  for (const r of rules) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between p-2 border rounded av-row';
    row.innerHTML = `<span class="av-text">${DOW_LABELS[r.day_of_week]} ${r.start_time}–${r.end_time}</span>
      <button data-id="${r.id}" class="text-red-500 text-sm rule-del">刪除</button>`;
    ruleList.appendChild(row);
  }
  ruleList.querySelectorAll('.rule-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/rules/${b.dataset.id}${coachQuery()}`, { method: 'DELETE' });
    renderAvailability();
  }));

  $('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const start = normTime(fd.get('start_time'));
    const end = normTime(fd.get('end_time'));
    if (!start || !end) { toast('請選擇起訖時間', 'error'); return; }
    try {
      await api('/api/coach/me/rules', {
        method: 'POST',
        body: withCoach({ day_of_week: Number(fd.get('day_of_week')), start_time: start, end_time: end }),
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
    // 狀態小圓點 + 色字（取代 🟡🟢）：請假=琥珀菱形點、加開=綠色圓點
    const tag = ex.type === 'leave'
      ? (ex.start_time
          ? `<span class="nk-dot amber">請假 ${ex.start_time}–${ex.end_time}</span>`
          : '<span class="nk-dot amber">請假（整天）</span>')
      : `<span class="nk-dot green">加開 ${ex.start_time}–${ex.end_time}</span>`;
    row.className = 'flex items-center justify-between p-2 border rounded av-row';
    row.innerHTML = `<span class="av-text flex items-center gap-2 flex-wrap">${ex.exception_date} · ${tag}${ex.note ? ` · ${escapeHtml(ex.note)}` : ''}</span>
      <button data-id="${ex.id}" class="text-red-500 text-sm ex-del">刪除</button>`;
    exList.appendChild(row);
  }
  exList.querySelectorAll('.ex-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定刪除？')) return;
    await api(`/api/coach/me/exceptions/${b.dataset.id}${coachQuery()}`, { method: 'DELETE' });
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
    const start_time = allDay ? null : (normTime(fd.get('start_time')) || null);
    const end_time = allDay ? null : (normTime(fd.get('end_time')) || null);
    if (!allDay && (!start_time || !end_time)) { toast('請選擇起訖時間', 'error'); return; }
    try {
      await api('/api/coach/me/exceptions', {
        method: 'POST',
        body: withCoach({ exception_date: fd.get('exception_date'), type, start_time, end_time, note: fd.get('note') || null }),
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
  if (needsCoachSelection() || !me) { $('tab-profile').innerHTML = PICK_PROMPT; return; }
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
        <span class="text-sm text-slate-600 profile-field-label">頭像</span>
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
        body: withCoach({
          display_name: fd.get('display_name'),
          specialty: fd.get('specialty') || null,
          bio: fd.get('bio') || null,
        }),
      });
      const file = $('avatar-input').files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) { toast('頭像超過 2MB', 'error'); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          await api('/api/coach/me/avatar', { method: 'POST', body: withCoach({ avatar_base64: reader.result }) });
          toast('已儲存');
          me = await api(`/api/coach/me${coachQuery()}`);
          renderProfile();
        };
        reader.readAsDataURL(file);
      } else {
        toast('已儲存');
        me = await api(`/api/coach/me${coachQuery()}`);
      }
    } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
  });
}

function escapeAttr(s) { return escapeHtml(s); }

await init();
