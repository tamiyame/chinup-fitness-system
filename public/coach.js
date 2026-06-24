import { api, fmtDate, dow, toast, getUser, escapeHtml, renderAuthBar } from './app.js';

const $ = (id) => document.getElementById(id);
const DOW_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
let me = null;
let isAdmin = false;
let selectedCoachId = null; // admin 代選的教練 id；null = 自己/未選
const expandedMembers = new Set(); // 展開中的客人 member_id（重繪時保留展開狀態）

// admin 代選教練時，GET/DELETE 用的 querystring；非 admin 或未選 → 空字串（落回 self）
function coachQuery() {
  return (isAdmin && selectedCoachId != null) ? `?coachId=${selectedCoachId}` : '';
}
// admin 代選教練時，POST/PATCH body 補上 coachId
function withCoach(body) {
  return (isAdmin && selectedCoachId != null) ? { ...body, coachId: selectedCoachId } : body;
}
// 登錄/預覽目標教練：管理者用登錄分頁選的（非 all）；一般教練落回自己（後端 resolveCoach）
function regTargetBody(body) {
  return (isAdmin && regViewCoachId && regViewCoachId !== 'all') ? { ...body, coachId: Number(regViewCoachId) } : body;
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
  expandedMembers.clear(); // 換教練重新開始
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
  if (name === 'register') renderRegister();
  // 登錄分頁用自己的「全部教練」選擇器；隱藏共用下拉避免混淆。共用下拉只給管理者 →
  // 非管理者完全不碰（否則 toggle(class,false) 會把本該隱藏的空下拉顯示出來）。
  const sharedPicker = $('coach-picker');
  if (isAdmin && sharedPicker) sharedPicker.classList.toggle('hidden', name === 'register');
}

// '2026-06-21T17:00:00' → '06/21 17:00'（緊湊、省年）
function fmtSlot(startAt) {
  return String(startAt || '').slice(5, 16).replace('T', ' ').replace('-', '/');
}
function statusDot(b) {
  return b.paid_at ? '<span class="nk-dot ok">已確認</span>' : '<span class="nk-dot warn">待確認</span>';
}

async function renderBookings() {
  const wrap = $('tab-bookings');
  if (needsCoachSelection()) { wrap.innerHTML = PICK_PROMPT; return; }
  const list = await api(`/api/coach/me/bookings${coachQuery()}`);
  if (list.length === 0) { wrap.innerHTML = '<p class="text-slate-500">沒有預約</p>'; return; }

  const now = Date.now();
  const isUpcoming = (b) => b.status !== 'cancelled' && new Date(b.start_at).getTime() > now;
  const asc = (a, b) => (a.start_at < b.start_at ? -1 : 1);
  const desc = (a, b) => (a.start_at > b.start_at ? -1 : 1);

  // 依 member_id 分組
  const groups = new Map();
  for (const b of list) {
    let g = groups.get(b.member_id);
    if (!g) { g = { memberId: b.member_id, name: b.member_name, has1on2: false, gs: [] }; groups.set(b.member_id, g); }
    g.gs.push(b);
    if (b.session_type === '1on2') g.has1on2 = true;
  }

  // 每組算錨點 + 排序資料
  const cards = [];
  for (const g of groups.values()) {
    const active = g.gs.filter(b => b.status !== 'cancelled');
    const upcoming = active.filter(isUpcoming).sort(asc);
    const pastActive = active.filter(b => !isUpcoming(b)).sort(desc);
    const cancelled = g.gs.filter(b => b.status === 'cancelled').sort(desc);
    const anchor = upcoming[0] || pastActive[0] || cancelled[0];
    cards.push({ g, activeCount: active.length, hasUpcoming: upcoming.length > 0, anchor,
      ordered: [...upcoming, ...pastActive, ...cancelled] });
  }

  // 群組排序：有 upcoming 在前（錨點升冪）；無 upcoming 在後（錨點降冪）
  cards.sort((A, B) => {
    if (A.hasUpcoming !== B.hasUpcoming) return A.hasUpcoming ? -1 : 1;
    return A.hasUpcoming ? asc(A.anchor, B.anchor) : desc(A.anchor, B.anchor);
  });

  const anchorStatus = (b) => (b.status === 'cancelled'
    ? '<span class="nk-dot" style="color:var(--ink-mute)">已取消</span>' : statusDot(b));
  const sessRow = (b) => {
    const tag = b.session_type === '1on2' ? ' <span class="nk-tag">1對2</span>' : '';
    if (b.status === 'cancelled') {
      return `<div class="bk-sess is-cancelled"><span class="bk-sess-when" style="color:var(--ink-mute)">${fmtSlot(b.start_at)}${tag} · 已取消${b.cancel_reason ? `（${escapeHtml(b.cancel_reason)}）` : ''}</span></div>`;
    }
    if (!isUpcoming(b)) {
      return `<div class="bk-sess"><span class="bk-sess-when" style="color:var(--ink-mute)">${fmtSlot(b.start_at)}${tag} · 已結束</span></div>`;
    }
    return `<div class="bk-sess"><span class="bk-sess-when">${fmtSlot(b.start_at)}${tag} ${statusDot(b)}</span><button data-id="${b.id}" class="bk-cancel cancel-btn">緊急取消</button></div>`;
  };

  let html = '<div id="bk-list">';
  for (const c of cards) {
    const g = c.g;
    const allPast = c.hasUpcoming ? '' : ' is-allpast';
    const nameTag = g.has1on2 ? ' <span class="nk-tag">1對2</span>' : '';
    if (g.gs.length === 1) {
      const b = g.gs[0];
      const canCancel = isUpcoming(b);
      html += `
        <div class="bk-group bk-single${allPast}">
          <div class="bk-head">
            <div class="bk-id">
              <span class="bk-name">${escapeHtml(g.name)}</span>${nameTag}
              <span class="bk-sep"></span>
              <span class="bk-next-d">${fmtSlot(b.start_at)}</span>
              ${anchorStatus(b)}
            </div>
            ${canCancel ? `<button data-id="${b.id}" class="bk-cancel cancel-btn">緊急取消</button>` : ''}
          </div>
        </div>`;
    } else {
      const open = expandedMembers.has(g.memberId) ? ' open' : '';
      html += `
        <div class="bk-group${open}${allPast}" data-mid="${g.memberId}">
          <div class="bk-head bk-toggle">
            <div class="bk-id">
              <span class="bk-name">${escapeHtml(g.name)}</span>${nameTag}
              <span class="bk-sep"></span>
              <span class="bk-next-d">${fmtSlot(c.anchor.start_at)}</span>
              ${anchorStatus(c.anchor)}
            </div>
            <span class="bk-count">共 ${c.activeCount} 堂</span>
            <svg class="bk-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>
          </div>
          <div class="bk-body">${c.ordered.map(sessRow).join('')}</div>
        </div>`;
    }
  }
  html += '</div>';
  wrap.innerHTML = html;

  const listEl = $('bk-list');
  const syncFocus = () => listEl.classList.toggle('has-open', listEl.querySelector('.bk-group.open') != null);
  syncFocus();

  // 展開/收合（點 head；點到取消鈕不觸發）
  wrap.querySelectorAll('.bk-toggle').forEach(head => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('.cancel-btn')) return;
      const group = head.closest('.bk-group');
      const mid = Number(group.dataset.mid);
      if (group.classList.toggle('open')) expandedMembers.add(mid); else expandedMembers.delete(mid);
      syncFocus();
    });
  });

  // 緊急取消
  wrap.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const reason = prompt('取消原因（會通知會員）：');
      if (!reason) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}${coachQuery()}`, { method: 'DELETE', body: { reason } });
        toast('已取消');
        renderBookings();
      } catch (err) {
        toast(`取消失敗：${err.message}`, 'error');
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

// 登錄預約：週曆狀態
let regWeekOffset = 0; // 0=本週
let regViewCoachId = 'all'; // 管理者登錄分頁檢視：'all' 或 coachId 字串；一般教練不使用
let regCoachOptionsCache = null; // 教練選單 options HTML 快取（避免每次重繪重撈 /api/admin/coaches）
const REG_HOUR_MIN = 7, REG_HOUR_MAX = 21; // 預設顯示 07:00–21:00（slot 起點）；資料超出此範圍時動態擴充，避免藏到預約
const REG_DOW = ['一','二','三','四','五','六','日'];

function regWeekRange(offset) {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7);
  const dow = base.getDay();
  const toMonday = dow === 0 ? -6 : 1 - dow;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + toMonday);
  const pad = (n) => String(n).padStart(2, '0');
  const fk = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dates = []; for (let i = 0; i < 7; i++) { const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); dates.push(fk(d)); }
  return { start: fk(start), dates };
}

async function renderRegister() {
  const panel = $('tab-register');
  const { start, dates } = regWeekRange(regWeekOffset);
  // 工具列（管理者多一個「全部教練」選擇器）
  let pickerHtml = '';
  if (isAdmin) {
    pickerHtml = `<select id="reg-coach-picker" class="border rounded p-1 text-sm" style="width:auto;"></select>`;
  }
  panel.innerHTML = `
    <div class="reg-toolbar">
      <button id="reg-prev" class="btn-secondary reg-navbtn">← 上一週</button>
      <button id="reg-today" class="btn-secondary reg-navbtn">本週</button>
      <button id="reg-next" class="btn-secondary reg-navbtn">下一週 →</button>
      ${pickerHtml}
      <span id="reg-range" class="reg-range"></span>
    </div>
    <div id="reg-grid" class="reg-grid-wrap"><p class="subtle">載入中…</p></div>`;
  $('reg-prev').onclick = () => { regWeekOffset--; renderRegister(); };
  $('reg-next').onclick = () => { regWeekOffset++; renderRegister(); };
  $('reg-today').onclick = () => { regWeekOffset = 0; renderRegister(); };
  $('reg-range').textContent = `${dates[0].slice(5).replace('-', '/')} – ${dates[6].slice(5).replace('-', '/')}`;

  // 管理者：填充教練選擇器（全部教練 + 各 active coach）
  if (isAdmin) {
    const picker = $('reg-coach-picker');
    if (!regCoachOptionsCache) {
      let opts = '<option value="all">全部教練</option>';
      try {
        const all = await api('/api/admin/coaches');
        opts += all.filter(c => c.is_active).map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
      } catch {}
      regCoachOptionsCache = opts;
    }
    picker.innerHTML = regCoachOptionsCache;
    picker.value = regViewCoachId;
    picker.onchange = () => { regViewCoachId = picker.value; renderRegister(); };
  }

  // 取週資料
  let data;
  try {
    let url;
    if (isAdmin) url = `/api/coach/week?all=1&start=${start}` + (regViewCoachId !== 'all' ? `&coachId=${regViewCoachId}` : '');
    else url = `/api/coach/week?start=${start}`;
    data = await api(url);
  } catch (e) { $('reg-grid').innerHTML = `<p class="subtle" style="color:#dc2626;">載入失敗：${escapeHtml(e.message)}</p>`; return; }

  const slotKey = (iso) => iso.slice(0, 13);
  // 多教練同格 → 陣列
  const bookByKey = new Map(); for (const b of data.bookings || []) { const k = slotKey(b.start_at); (bookByKey.get(k) || bookByKey.set(k, []).get(k)).push(b); }
  const grpByKey = new Map(); for (const g of data.groupSessions || []) { const k = slotKey(g.start_at); (grpByKey.get(k) || grpByKey.set(k, []).get(k)).push(g); }
  const avail = new Set((data.availableSlots || []).map(s => slotKey(s.start)));
  const isAll = isAdmin && regViewCoachId === 'all';
  const targetCoachId = isAdmin ? (regViewCoachId !== 'all' ? Number(regViewCoachId) : null) : null;
  const canRegister = !isAdmin || targetCoachId != null;

  // 動態時段
  const hourOf = (iso) => Number(String(iso).slice(11, 13));
  let hMin = REG_HOUR_MIN, hMax = REG_HOUR_MAX;
  for (const b of data.bookings || []) { hMin = Math.min(hMin, hourOf(b.start_at)); hMax = Math.max(hMax, hourOf(b.start_at)); }
  for (const g of data.groupSessions || []) { hMin = Math.min(hMin, hourOf(g.start_at)); hMax = Math.max(hMax, hourOf(g.start_at)); }
  for (const s of data.availableSlots || []) { hMin = Math.min(hMin, hourOf(s.start)); hMax = Math.max(hMax, hourOf(s.start)); }
  const hours = []; for (let h = hMin; h <= hMax; h++) hours.push(h);

  const head = `<div class="reg-cell reg-head reg-timecol"></div>` +
    dates.map((d, i) => `<div class="reg-cell reg-head">${REG_DOW[i]}<br><span class="reg-date">${d.slice(5).replace('-', '/')}</span></div>`).join('');
  let rows = '';
  for (const h of hours) {
    const hh = String(h).padStart(2, '0');
    rows += `<div class="reg-cell reg-timecol">${hh}:00</div>`;
    for (const d of dates) {
      const iso = `${d}T${hh}:00:00`; const key = `${d}T${hh}`;
      const bks = bookByKey.get(key) || []; const gps = grpByKey.get(key) || [];
      if (bks.length || gps.length) {
        let inner = bks.map(b => {
          const tag = b.session_type === '1on2' ? '1對2' : '1對1';
          const other = targetCoachId != null && b.coach_id !== targetCoachId;
          const coachLbl = (isAll || other) ? `<span class="reg-sub">· ${escapeHtml(b.coach_name || '')}</span>` : '';
          return `<div class="reg-bk${other ? ' reg-booked-other' : ''}" data-bk="${b.id}">${escapeHtml(b.member_name)} <span class="reg-sub">${tag}</span>${coachLbl}</div>`;
        }).join('');
        inner += gps.map(g => `<div class="reg-gp">${escapeHtml(g.name)} <span class="reg-sub">團課${isAll ? '· ' + escapeHtml(g.coach_name || '') : ''}</span></div>`).join('');
        rows += `<div class="reg-cell reg-multi">${inner}</div>`;
      } else {
        const cls = (canRegister && avail.has(key)) ? 'reg-open reg-avail' : 'reg-open';
        rows += `<div class="reg-cell ${cls}" data-slot="${iso}">＋</div>`;
      }
    }
  }
  $('reg-grid').innerHTML = `<div class="reg-grid">${head}${rows}</div>`;
  // 空格登錄
  $('reg-grid').querySelectorAll('.reg-open[data-slot]').forEach(c => c.addEventListener('click', () => {
    if (!canRegister) { toast('請先於上方選擇要登錄的教練', 'error'); return; }
    openRegisterModal(c.dataset.slot);
  }));
  // 預約格 → 編輯
  $('reg-grid').querySelectorAll('.reg-bk[data-bk]').forEach(c => c.addEventListener('click', () => {
    const all = data.bookings.find(b => b.id === Number(c.dataset.bk));
    if (all) openBookingEditModal(all);
  }));
}

// Task 4 取代；先 stub 避免 ReferenceError
function openBookingEditModal(booking) { console.log('[edit] booking', booking.id); }

let regmSlot = null;       // 'YYYY-MM-DDTHH:00:00'
let regmCustomer = null;   // {id,name,phone}
let regmPackages = [];     // 該客人有效方案
let regmPackageId = null;  // 選中方案

const PKG_TYPE = { '1on1': '一對一', '1on2': '一對二' };
function regmClose() { $('regm-overlay').style.display = 'none'; regmCustomer = null; regmPackages = []; regmPackageId = null; }

function openRegisterModal(startAtISO) {
  regmSlot = startAtISO; regmCustomer = null; regmPackages = []; regmPackageId = null;
  const ov = $('regm-overlay'); ov.style.display = 'grid';
  $('regm-close').onclick = regmClose;
  ov.onclick = (e) => { if (e.target === ov) regmClose(); };
  renderRegmBody();
}

function regmSlotLabel(iso) { return iso.slice(0, 16).replace('T', ' ').replace(/-/g, '/'); }

function renderRegmBody() {
  const body = $('regm-body');
  body.innerHTML = `
    <p class="regm-slot">時段：<strong>${escapeHtml(regmSlotLabel(regmSlot))}</strong>（60 分鐘）</p>
    <label class="regm-label">搜尋客人（姓名或電話）</label>
    <input id="regm-search" class="form-input regm-input" placeholder="輸入姓名或電話…" autocomplete="off" />
    <div id="regm-results" class="regm-results"></div>
    <div id="regm-picked"></div>`;
  const search = $('regm-search');
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    const q = search.value.trim();
    if (!q) { $('regm-results').innerHTML = ''; return; }
    t = setTimeout(async () => {
      try {
        const list = await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`);
        $('regm-results').innerHTML = list.length
          ? list.map(u => `<div class="regm-result" data-id="${u.id}" data-name="${escapeHtml(u.name)}" data-phone="${escapeHtml(u.phone || '')}">${escapeHtml(u.name)} <span class="regm-sub">${escapeHtml(u.phone || '')}</span></div>`).join('')
          : '<div class="regm-sub" style="padding:6px;">查無客人</div>';
        $('regm-results').querySelectorAll('.regm-result').forEach(r => r.addEventListener('click', () => {
          regmCustomer = list.find(u => u.id === Number(r.dataset.id));
          $('regm-results').innerHTML = ''; search.value = regmCustomer.name;
          loadRegmPackages();
        }));
      } catch (e) { $('regm-results').innerHTML = `<div class="regm-sub" style="color:#dc2626;padding:6px;">${escapeHtml(e.message)}</div>`; }
    }, 250);
  });
}

async function loadRegmPackages() {
  const picked = $('regm-picked');
  picked.innerHTML = '<p class="regm-sub">載入方案中…</p>';
  let all = [];
  try { all = await api(`/api/coach/packages?memberId=${regmCustomer.id}`); }
  catch (e) { picked.innerHTML = `<p class="regm-sub" style="color:#dc2626;">${escapeHtml(e.message)}</p>`; return; }
  regmPackages = all.filter(p => p.is_valid);
  regmPackageId = regmPackages.length ? regmPackages[0].id : null;
  renderRegmPicked();
}

function renderRegmPicked() {
  const picked = $('regm-picked');
  if (!regmPackages.length) {
    picked.innerHTML = `
      <div class="regm-nopkg">此客人沒有可用方案，請先開一個：</div>
      <div class="regm-newpkg">
        <select id="regm-np-type" class="form-select"><option value="1on1">一對一</option><option value="1on2">一對二</option></select>
        <input id="regm-np-total" class="form-input" type="number" min="1" placeholder="堂數" />
        <input id="regm-np-amount" class="form-input" type="number" min="0" placeholder="金額（可空）" />
        <input id="regm-np-expiry" class="form-input" type="date" />
        <button id="regm-np-create" class="btn-primary">建立方案</button>
      </div>`;
    $('regm-np-create').onclick = async () => {
      const total = Number($('regm-np-total').value);
      if (!Number.isInteger(total) || total <= 0) { toast('請填正確堂數', 'error'); return; }
      const amt = $('regm-np-amount').value;
      try {
        await api('/api/coach/packages', { method: 'POST', body: { memberId: regmCustomer.id, sessionType: $('regm-np-type').value, totalSessions: total, amount: amt === '' ? null : Number(amt), expiresAt: $('regm-np-expiry').value || null } });
        toast('方案已建立', 'success'); loadRegmPackages();
      } catch (e) { toast(`建立失敗：${e.message}`, 'error'); }
    };
    return;
  }
  const opts = regmPackages.map(p => `<option value="${p.id}">${PKG_TYPE[p.session_type] || escapeHtml(p.session_type)}・剩 ${escapeHtml(String(p.remaining_sessions))}/${escapeHtml(String(p.total_sessions))}${p.expires_at ? '・到期 ' + escapeHtml(p.expires_at) : ''}</option>`).join('');
  picked.innerHTML = `
    <label class="regm-label">選擇方案</label>
    <select id="regm-pkg" class="form-select">${opts}</select>
    <label class="regm-check"><input id="regm-rec-on" type="checkbox" /> 開啟循環</label>
    <div id="regm-rec" class="regm-rec hidden">
      <div class="regm-rec-row">
        <select id="regm-freq" class="form-select">
          <option value="daily">每天</option><option value="weekly" selected>每週</option>
          <option value="monthly">每月</option><option value="yearly">每年</option><option value="custom">自訂</option>
        </select>
      </div>
      <div id="regm-custom" class="regm-rec-row hidden">
        <span>每</span><input id="regm-interval" class="form-input regm-num" type="number" min="1" value="1" />
        <select id="regm-unit" class="form-select"><option value="weekly">週</option><option value="daily">天</option><option value="monthly">月</option><option value="yearly">年</option></select>
      </div>
      <div id="regm-weekdays" class="regm-weekdays hidden"></div>
      <div class="regm-rec-row">
        <label class="regm-radio"><input type="radio" name="regm-end" value="count" checked /> 共</label>
        <input id="regm-count" class="form-input regm-num" type="number" min="1" max="52" value="4" /> 次
        <label class="regm-radio"><input type="radio" name="regm-end" value="date" /> 到</label>
        <input id="regm-enddate" class="form-input" type="date" disabled />
      </div>
    </div>
    <div id="regm-preview" class="regm-preview"></div>
    <div class="regm-actions">
      <button id="regm-preview-btn" class="btn-secondary">預覽</button>
      <button id="regm-submit" class="btn-primary">確認登錄</button>
    </div>`;
  $('regm-pkg').onchange = () => { regmPackageId = Number($('regm-pkg').value); };
  regmPackageId = Number($('regm-pkg').value);
  // 週幾勾選（預設循環起始日的星期）
  const wdWrap = $('regm-weekdays');
  wdWrap.innerHTML = ['一','二','三','四','五','六','日'].map((lab, i) => {
    const val = i === 6 ? 0 : i + 1; // 一=1…六=6, 日=0
    return `<label class="regm-wd"><input type="checkbox" value="${val}" /> ${lab}</label>`;
  }).join('');
  const toggleRec = () => $('regm-rec').classList.toggle('hidden', !$('regm-rec-on').checked);
  $('regm-rec-on').onchange = toggleRec;
  $('regm-freq').onchange = () => {
    const custom = $('regm-freq').value === 'custom';
    $('regm-custom').classList.toggle('hidden', !custom);
    $('regm-weekdays').classList.toggle('hidden', !(custom && $('regm-unit').value === 'weekly'));
  };
  $('regm-unit').onchange = () => $('regm-weekdays').classList.toggle('hidden', !($('regm-freq').value === 'custom' && $('regm-unit').value === 'weekly'));
  document.querySelectorAll('input[name="regm-end"]').forEach(r => r.onchange = () => {
    const isDate = document.querySelector('input[name="regm-end"]:checked').value === 'date';
    $('regm-enddate').disabled = !isDate; $('regm-count').disabled = isDate;
  });
  $('regm-preview-btn').onclick = doRegmPreview;
  $('regm-submit').onclick = doRegmSubmit;
}

function buildRecurrence() {
  if (!$('regm-rec-on') || !$('regm-rec-on').checked) return null;
  const freqSel = $('regm-freq').value;
  let frequency, interval = 1, byWeekday = null;
  if (freqSel === 'custom') {
    frequency = $('regm-unit').value; interval = Number($('regm-interval').value) || 1;
    if (frequency === 'weekly') {
      byWeekday = [...$('regm-weekdays').querySelectorAll('input:checked')].map(i => Number(i.value));
      if (!byWeekday.length) byWeekday = null;
    }
  } else { frequency = freqSel; }
  const endType = document.querySelector('input[name="regm-end"]:checked').value;
  const end = endType === 'date' ? { type: 'date', date: $('regm-enddate').value } : { type: 'count', count: Number($('regm-count').value) || 1 };
  return { frequency, interval, byWeekday, end };
}

async function doRegmPreview() {
  const box = $('regm-preview'); box.innerHTML = '預覽中…';
  try {
    const r = await api('/api/coach/register/preview', { method: 'POST', body: regTargetBody({ memberId: regmCustomer.id, packageId: regmPackageId, startAt: regmSlot, recurrence: buildRecurrence() }) });
    const label = { ok: '✓ 建立', conflict: '✕ 衝突跳過', no_date: '✕ 無此日', depleted: '✕ 方案用罄' };
    box.innerHTML = `<div class="regm-sub">將建立 <strong>${r.willCreate}</strong> 筆、扣 ${r.willDeduct} 堂、方案剩 ${r.remainingAfter}</div>` +
      r.occurrences.map(o => `<div class="regm-occ regm-${o.status}">${regmSlotLabel(o.startAt)} — ${label[o.status]}</div>`).join('');
  } catch (e) { box.innerHTML = `<div class="regm-sub" style="color:#dc2626;">${escapeHtml(e.data?.error || e.message)}</div>`; }
}

async function doRegmSubmit() {
  try {
    const r = await api('/api/coach/register', { method: 'POST', body: regTargetBody({ memberId: regmCustomer.id, packageId: regmPackageId, startAt: regmSlot, recurrence: buildRecurrence() }) });
    toast(`已登錄 ${r.created.length} 筆${r.skipped.length ? `（跳過 ${r.skipped.length}）` : ''}`, 'success');
    regmClose(); renderRegister();
  } catch (e) {
    const msgs = { package_invalid: '方案已失效/用罄', package_member_mismatch: '方案不屬此客人', nothing_created: '無可建立場次（全衝突或用罄）', slot_taken: '此時段已被預約' };
    toast(msgs[e.data?.error] || `登錄失敗：${e.message}`, 'error');
  }
}

await init();
