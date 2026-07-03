import { api, toast, fmtDate, dow, bootAuth, escapeHtml } from '/app.js';

const user = await bootAuth({ requireAdmin: true });
// If bootAuth redirected, halt module execution so no admin content renders.
if (!user) throw new Error('__redirected_by_auth__');

const ROLE_LABEL = { owner: '擁有者', admin: '管理者', coach: '教練', user: '會員' };
const ROLE_BADGE = { owner: 'waitlisted', admin: 'confirmed', coach: 'coach', user: 'open' };

const RECURRENCE_LABEL = { weekly: '每週', monthly: '每月', bimonthly: '每兩個月', quarterly: '每季', semiannual: '每半年' };
const SESSION_STATUS_LABEL = { open: '開放', confirmed: '已成班', cancelled: '未開課', completed: '結束' };
const REG_STATUS_LABEL = { confirmed: '正取', waitlisted: '候補', pending: '待付款', cancelled: '已取消', rejected: '未開課' };

// Nike 描邊 line-icons（純呈現，取代 emoji；非人臉非 emoji；color 繼承 currentColor）
const _svg = (p) => `<svg class="nk-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  calendar: _svg('<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>'),
  clock: _svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  users: _svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.5a3 3 0 0 1 0 5.6M16.5 14.6c2.4.4 4 2.3 4 4.9"/>'),
  coach: _svg('<circle cx="12" cy="7" r="3.4"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>'),
  repeat: _svg('<path d="M4 8a6 6 0 0 1 10-2l2 2M20 8V4M20 8h-4"/><path d="M20 16a6 6 0 0 1-10 2l-2-2M4 16v4M4 16h4"/>'),
  range: _svg('<path d="M4 12h16M14 6l6 6-6 6"/>'),
  phone: _svg('<path d="M6 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4 5.7 2 2 0 0 1 6 3.5z"/>'),
  cash: _svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>'),
  dumbbell: _svg('<path d="M3 9v6M6 7.5v9M18 7.5v9M21 9v6M6 12h12"/>'),
  check: _svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  tag: _svg('<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.4"/>'),
  book: _svg('<path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2z"/><path d="M18 19.5H7a2 2 0 0 0-2 2"/>'),
};

async function loadTemplates() {
  const container = document.getElementById('templates');
  try {
    const tpls = await api('/api/admin/templates');

    let totalSessions = 0, totalRegs = 0, totalWaitlist = 0;
    for (const t of tpls) {
      const detail = await api(`/api/admin/templates/${t.id}`);
      totalSessions += detail.sessions.length;
      for (const s of detail.sessions) {
        totalRegs += s.confirmed_count;
        totalWaitlist += s.waitlist_count;
      }
    }
    document.getElementById('stat-templates').textContent = tpls.length;
    document.getElementById('stat-sessions').textContent = totalSessions;
    document.getElementById('stat-regs').textContent = totalRegs;
    document.getElementById('stat-waitlist').textContent = totalWaitlist;

    if (!tpls.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${ICO.book.replace('nk-ico', 'nk-empty-ico')}
          <p>尚無課程範本</p>
          <p class="subtle mt-1">點「＋ 新增範本」建立第一個循環課程</p>
        </div>`;
      return;
    }
    container.innerHTML = tpls.map(t => `
      <article class="card">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div class="flex-1 min-w-[260px]">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="card-title">${escapeHtml(t.name)}</h3>
              <span class="badge badge-${t.status === 'published' ? 'confirmed' : 'completed'}">${t.status === 'published' ? '已發布' : escapeHtml(t.status)}</span>
            </div>
            <p class="card-desc">${escapeHtml(t.description || '')}</p>
            <div class="meta">
              <span class="meta-item">${ICO.calendar} ${dow(t.day_of_week)} ${t.start_time}</span>
              <span class="meta-item">${ICO.clock} ${t.duration_minutes} 分</span>
              <span class="meta-item">${ICO.users} ${t.min_capacity}–${t.max_capacity} 人</span>
              <span class="meta-item">${ICO.coach} ${escapeHtml(t.coach_name || '未指定')}</span>
              <span class="meta-item">${ICO.repeat} ${RECURRENCE_LABEL[t.recurrence]}</span>
              <span class="meta-item">${ICO.range} ${t.cycle_start_date} ~ ${t.cycle_end_date}</span>
            </div>
          </div>
          <div class="flex gap-2">
            <button data-id="${t.id}" class="edit-btn btn btn-ghost btn-sm">編輯</button>
            <button data-id="${t.id}" class="view-btn btn btn-dark btn-sm">查看場次</button>
            <button data-id="${t.id}" class="del-btn btn btn-danger btn-sm">刪除</button>
          </div>
        </div>
      </article>
    `).join('');
    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', () => openEdit(Number(b.dataset.id))));
    container.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => openDrawer(Number(b.dataset.id))));
    container.querySelectorAll('.del-btn').forEach(b => b.addEventListener('click', () => deleteTemplate(Number(b.dataset.id))));
  } catch (e) {
    toast(`載入範本失敗：${e.message}`, 'error');
  }
}

async function loadNotifs() {
  try {
    const rows = await api('/api/admin/notifications');
    const el = document.getElementById('notifs');
    if (!rows.length) { el.innerHTML = '<div class="p-6 subtle text-center">無紀錄</div>'; return; }
    el.innerHTML = '<table class="data-table"><thead><tr><th>時間</th><th>收件者</th><th>類型</th><th>通道</th><th>主旨</th></tr></thead><tbody>' +
      rows.map(r => `
        <tr>
          <td data-label="時間" class="subtle">${fmtDate(r.sent_at)}</td>
          <td data-label="收件者">${escapeHtml(r.email)}</td>
          <td data-label="類型"><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td data-label="通道">${escapeHtml(r.channel)}</td>
          <td data-label="主旨" class="cell-span">${escapeHtml(r.subject)}</td>
        </tr>`).join('') + '</tbody></table>';
  } catch (e) {
    document.getElementById('notifs').innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadBackup(file) {
  try {
    const { getToken } = await import('/app.js');
    const res = await fetch(`/api/admin/backups/${encodeURIComponent(file)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(`下載失敗：${e.message}`, 'error');
  }
}

async function loadBackupSummary() {
  const el = document.getElementById('backup-summary');
  const errEl = document.getElementById('backup-summary-error');
  if (!el) return;
  try {
    const r = await api('/api/admin/backups');
    if (r.lastError) {
      errEl.textContent = `上次備份失敗：${r.lastError}`;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    }
    if (!r.files.length) {
      el.innerHTML = '資料備份：<span class="text-gray-500">尚無備份</span>';
    } else {
      const latest = r.files[0];
      el.innerHTML = `上次備份 <span class="font-medium">${fmtDate(latest.createdAt)}</span> · 共 ${r.files.length} 份`;
    }
  } catch (e) {
    el.textContent = `資料備份：載入失敗（${e.message}）`;
  }
}

async function loadBackups() {
  const tbody = document.getElementById('backup-list');
  const errBox = document.getElementById('backup-last-error');
  try {
    const r = await api('/api/admin/backups');
    if (r.lastError) {
      errBox.textContent = `上次備份失敗：${r.lastError}`;
      errBox.classList.remove('hidden');
    } else {
      errBox.classList.add('hidden');
      errBox.textContent = '';
    }
    if (!r.files.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-gray-400">尚無備份</td></tr>';
      return;
    }
    tbody.innerHTML = r.files.map((f) => `
      <tr class="border-b">
        <td class="py-2 font-mono text-xs">${f.file}</td>
        <td class="py-2">${fmtDate(f.createdAt)}</td>
        <td class="py-2 text-right">${fmtSize(f.size)}</td>
        <td class="py-2 text-right"><button class="link" data-dl="${f.file}">下載</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', () => downloadBackup(btn.dataset.dl));
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-red-600">載入失敗：${escapeHtml(e.message)}</td></tr>`;
  }
}

function bindBackupHandlers() {
  const dlg = document.getElementById('backup-modal');
  document.getElementById('btn-backup-manage')?.addEventListener('click', () => {
    loadBackups();
    dlg?.showModal();
  });
  document.getElementById('backup-close')?.addEventListener('click', () => dlg?.close());

  const btn = document.getElementById('btn-backup-now');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '備份中…';
    try {
      const r = await api('/api/admin/backups/run', { method: 'POST' });
      if (r.ok) {
        toast(`備份完成：${r.file}`, 'success');
        loadBackups();
        loadBackupSummary();
      } else {
        toast(`備份失敗：${r.error}`, 'error');
      }
    } catch (e) {
      toast(`備份失敗：${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '立即備份';
    }
  });
}

function typeBadge(t) {
  if (t === 'course_confirmed' || t === 'registered_confirmed' || t === 'promoted') return 'confirmed';
  if (t === 'registered_waitlisted') return 'waitlisted';
  if (t === 'course_cancelled' || t === 'registration_cancelled') return 'cancelled';
  return 'open';
}
function typeLabel(t) {
  return {
    registered_confirmed: '報名成功', registered_waitlisted: '候補',
    promoted: '遞補', course_confirmed: '成班', course_cancelled: '取消',
    reminder: '提醒', registration_cancelled: '取消報名',
  }[t] || t;
}

// Modal
function openNew() {
  document.getElementById('modal-title').textContent = '新增範本';
  const f = document.getElementById('tpl-form');
  f.reset(); f.id.value = '';
  document.getElementById('modal').style.display = 'grid';
}

async function openEdit(id) {
  const t = await api(`/api/admin/templates/${id}`);
  document.getElementById('modal-title').textContent = '編輯範本';
  const f = document.getElementById('tpl-form');

  // Preserve legacy names that aren't in current categories by appending a temp option.
  const sel = document.getElementById('tpl-name-select');
  if (sel && t.name && !categoriesCache.some(c => c.name === t.name)) {
    // Remove any previously injected legacy option first
    [...sel.querySelectorAll('option[data-legacy="1"]')].forEach(o => o.remove());
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = `${t.name}（舊名稱，未列於分類）`;
    opt.dataset.legacy = '1';
    sel.appendChild(opt);
  }

  for (const k of ['name','description','min_capacity','max_capacity','day_of_week','start_time','duration_minutes','registration_deadline_hours','recurrence','cycle_start_date','cycle_end_date','price_per_session','coach_id']) {
    if (f[k]) f[k].value = t[k] ?? '';
  }
  f.id.value = t.id;
  document.getElementById('modal').style.display = 'grid';
}

function closeModal() { document.getElementById('modal').style.display = 'none'; }

document.getElementById('new-btn').addEventListener('click', openNew);
document.getElementById('cancel-btn').addEventListener('click', closeModal);
document.getElementById('cancel-btn-2').addEventListener('click', closeModal);
document.getElementById('tpl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const payload = Object.fromEntries(new FormData(f).entries());
  const id = payload.id; delete payload.id;
  if (payload.price_per_session !== undefined) {
    payload.price_per_session = Number(payload.price_per_session);
  }
  if (payload.coach_id !== undefined && payload.coach_id !== '') {
    payload.coach_id = Number(payload.coach_id);
  }
  try {
    if (id) {
      await api(`/api/admin/templates/${id}`, { method: 'PATCH', body: payload });
      toast('已更新範本', 'success');
    } else {
      const r = await api('/api/admin/templates', { method: 'POST', body: payload });
      toast(`已建立，展開 ${r.sessionsCreated} 個場次`, 'success');
    }
    closeModal();
    loadTemplates();
  } catch (err) {
    toast(`失敗：${err.data?.error || err.message}`, 'error');
  }
});

async function deleteTemplate(id) {
  let t;
  try {
    t = await api(`/api/admin/templates/${id}`);
  } catch (e) {
    toast(`載入範本失敗：${e.message}`, 'error');
    return;
  }

  const sessionCount = t.sessions.length;
  const activeRegs = t.sessions.reduce(
    (n, s) => n + (s.confirmed_count || 0) + (s.waitlist_count || 0),
    0
  );

  const lines = [
    `確定刪除課程範本「${t.name}」？`,
    '',
    '將連帶刪除：',
    `・${sessionCount} 個場次`,
    `・目前 ${activeRegs} 筆進行中的報名（含候補）`,
    '',
    '已取消 / 未開課的報名也會一併清除，無法復原。',
  ];
  if (!confirm(lines.join('\n'))) return;

  try {
    const r = await api(`/api/admin/templates/${id}`, { method: 'DELETE' });
    toast(`已刪除「${t.name}」（${r.sessionsDeleted} 場次、${r.registrationsDeleted} 報名）`, 'success');
    loadTemplates();
  } catch (e) {
    toast(`刪除失敗：${e.message}`, 'error');
  }
}

async function openDrawer(templateId) {
  const d = document.getElementById('drawer');
  const c = document.getElementById('drawer-content');
  d.style.display = 'block';
  c.innerHTML = '<div class="subtle">載入中…</div>';
  try {
    const t = await api(`/api/admin/templates/${templateId}`);
    document.getElementById('drawer-title').textContent = `${t.name}`;
    if (!t.sessions.length) { c.innerHTML = '<div class="subtle">尚無場次</div>'; return; }

    c.innerHTML = t.sessions.map(s => `
      <details class="session-row">
        <summary>
          <div>
            <div class="font-semibold">${fmtDate(s.start_at)}</div>
            <div class="subtle mt-1">正取 ${s.confirmed_count}/${t.max_capacity} · 候補 ${s.waitlist_count}</div>
          </div>
          ${s.status === 'open'
            ? `<button type="button" class="badge ${s.is_open === 0 ? 'badge-closed' : 'badge-open'} session-toggle" data-session-id="${s.id}" data-open="${s.is_open === 0 ? '0' : '1'}" title="點擊切換開放／關閉此場次">${s.is_open === 0 ? '關閉' : '開放'}</button>`
            : `<span class="badge badge-${s.status}">${SESSION_STATUS_LABEL[s.status]}</span>`}
        </summary>
        <div class="px-5 pb-4 session-roster" data-session-id="${s.id}">
          <div class="subtle">載入中…</div>
        </div>
      </details>`).join('');

    c.querySelectorAll('details.session-row').forEach(det => {
      det.addEventListener('toggle', async () => {
        if (!det.open) return;
        // 注意：summary 內的開關按鈕也帶 data-session-id，必須用 .session-roster
        // 精準選名單容器（曾因 [data-session-id] 撈到按鈕導致名單塞錯位、永遠「載入中」）。
        const inner = det.querySelector('.session-roster');
        if (inner.dataset.loaded === '1') return;
        const sid = Number(inner.dataset.sessionId);
        try {
          const list = await api(`/api/admin/sessions/${sid}/registrations`);
          if (!list.length) { inner.innerHTML = '<div class="subtle py-2">尚無人報名</div>'; inner.dataset.loaded = '1'; return; }
          inner.innerHTML = list.map(r => {
            const inactive = r.status === 'cancelled' || r.status === 'rejected';
            return `
            <div class="reg-row"${inactive ? ' style="opacity:.45"' : ''}>
              <div>
                <div class="font-medium">${escapeHtml(r.user_name)}</div>
                <div class="subtle text-xs">${escapeHtml(r.email || r.phone || '')}</div>
              </div>
              <div class="flex items-center gap-2">
                <span class="badge badge-${r.status}">${REG_STATUS_LABEL[r.status] || r.status}</span>
                ${r.position ? `<span class="subtle text-xs">#${r.position}</span>` : ''}
              </div>
            </div>`;
          }).join('');
          inner.dataset.loaded = '1';
        } catch (e) {
          // 失敗顯示錯誤並允許收合後重開重試（不標 loaded）
          inner.innerHTML = `<div class="text-red-500 py-2">名單載入失敗：${escapeHtml(e.message)}</div>`;
        }
      });
    });
  } catch (e) {
    c.innerHTML = `<div class="text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('close-drawer').addEventListener('click', () => document.getElementById('drawer').style.display = 'none');

// 切換單一場次開放/關閉（事件委派，掛一次即可；按鈕在 <summary> 內，需阻止展開）
document.getElementById('drawer-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('.session-toggle');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if (btn.disabled) return;
  const sid = Number(btn.dataset.sessionId);
  const nextOpen = btn.dataset.open !== '1'; // 目前開放 → 關閉，反之亦然
  btn.disabled = true;
  try {
    const updated = await api(`/api/admin/sessions/${sid}`, { method: 'PATCH', body: { is_open: nextOpen } });
    const open = updated.is_open === 1;
    btn.dataset.open = open ? '1' : '0';
    btn.className = `badge ${open ? 'badge-open' : 'badge-closed'} session-toggle`;
    btn.textContent = open ? '開放' : '關閉';
    toast(open ? '已開放此場次' : '已關閉此場次（報名頁將隱藏，不影響現有報名）', 'success');
  } catch (err) {
    toast(`切換失敗：${escapeHtml(err.message)}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('run-deadlines').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/jobs/process-deadlines', { method: 'POST' });
    document.getElementById('job-result').textContent = `處理了 ${r.processed.length} 個場次`;
    toast(`完成：${r.processed.length} 個場次`, 'success');
    loadTemplates(); loadNotifs();
  } catch (e) { toast(`失敗：${e.message}`, 'error'); }
});

document.getElementById('run-reminders').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/jobs/send-reminders', { method: 'POST' });
    document.getElementById('job-result').textContent = `寄出 ${r.sent.length} 組提醒`;
    toast(`完成：${r.sent.length} 組`, 'success');
    loadNotifs();
  } catch (e) { toast(`失敗：${e.message}`, 'error'); }
});

let allUsers = [];
let usersWired = false;

async function loadUsers() {
  const note = document.getElementById('users-note');
  note.textContent = '長按會員可編輯資料 / 變更角色 / 封存';

  // 一次性綁定搜尋欄 + 顯示已封存切換（靜態元素，跨重繪持續存在）
  if (!usersWired) {
    document.getElementById('user-search')?.addEventListener('input', renderUsersTable);
    document.getElementById('show-archived')?.addEventListener('change', renderUsersTable);
    document.getElementById('line-search')?.addEventListener('input', renderLineTable);
    document.getElementById('line-filter')?.addEventListener('change', renderLineTable);
    usersWired = true;
  }

  try {
    allUsers = await api('/api/admin/users');
    renderUsersTable();
    renderLineTable();
  } catch (e) {
    document.getElementById('users-table').innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

function renderUsersTable() {
  const el = document.getElementById('users-table');
  if (!el) return;
  const q = (document.getElementById('user-search')?.value || '').trim().toLowerCase();
  const showArchived = !!document.getElementById('show-archived')?.checked;

  let rows = allUsers;
  if (!showArchived) rows = rows.filter(r => !r.archived_at);
  if (q) rows = rows.filter(r =>
    (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));

  if (!rows.length) {
    el.innerHTML = `<div class="p-6 subtle text-center">${q || showArchived ? '無符合的會員' : '無會員'}</div>`;
    return;
  }

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th style="width:60px;">ID</th>
        <th>姓名</th>
        <th>Email / 手機</th>
        <th>登入方式</th>
        <th>角色</th>
        <th>加入時間</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => renderUserRow(r)).join('')}
      </tbody>
    </table>`;

  bindUserRowLongPress(el);
}

function renderUserRow(r) {
  const isSelf = r.id === user.id;
  const archived = !!r.archived_at;
  const loginBadge = r.has_google
    ? '<span class="badge badge-confirmed" style="font-size:11px;">Google</span>'
    : '<span class="badge badge-completed" style="font-size:11px;">Email</span>';

  // 角色/標籤改在長按彈窗變更；此處顯示徽章：管理者(有標籤) > 教練 > 會員
  const roleKind = r.is_admin ? 'confirmed' : (ROLE_BADGE[r.role] || 'open');
  const roleLabel = r.is_admin ? '管理者' : (ROLE_LABEL[r.role] || r.role);
  const roleCell = `<span class="badge badge-${roleKind}">${escapeHtml(roleLabel)}</span>${isSelf ? ' <span class="subtle text-xs">(你)</span>' : ''}`;

  const archBadge = archived ? ' <span class="badge badge-cancelled" style="font-size:10px;">已封存</span>' : '';

  return `
    <tr class="user-row${archived ? ' is-archived' : ''}" data-user-id="${r.id}"${archived ? ' style="opacity:0.55;"' : ''}>
      <td data-label="ID" class="subtle cell-id">#${r.id}</td>
      <td data-label="姓名" class="cell-name"><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
      <td data-label="Email / 手機" class="subtle cell-emailphone">
        <div class="cell-email hide-mobile">${escapeHtml(r.email)}</div>
        <div class="cell-phone">${escapeHtml(r.phone)}</div>
      </td>
      <td data-label="登入方式" class="hide-mobile">${loginBadge}</td>
      <td data-label="角色">${roleCell}</td>
      <td data-label="加入時間" class="subtle hide-mobile">${fmtDate(r.created_at)}</td>
    </tr>`;
}

// 長按（手機 touch / 桌機滑鼠按住約 0.5 秒）→ 開編輯彈窗。
// 起手點若落在角色下拉等互動元件則略過，讓擁有者能正常操作下拉。
function bindUserRowLongPress(container) {
  container.querySelectorAll('tr.user-row').forEach(tr => {
    const id = Number(tr.dataset.userId);
    let timer = null;
    const start = (e) => {
      if (e.target.closest('select, a, button, input, option')) return;
      timer = setTimeout(() => { timer = null; openUserEditModal(id); }, 500);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    tr.addEventListener('touchstart', start, { passive: true });
    tr.addEventListener('touchend', cancel);
    tr.addEventListener('touchmove', cancel);
    tr.addEventListener('mousedown', start);
    tr.addEventListener('mouseup', cancel);
    tr.addEventListener('mouseleave', cancel);
  });
}

function lineRoleBadge(r) {
  const kind = r.is_admin ? 'confirmed' : (ROLE_BADGE[r.role] || 'open');
  const label = r.is_admin ? '管理者' : (ROLE_LABEL[r.role] || r.role);
  return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}

function renderLineTable() {
  const el = document.getElementById('line-table');
  if (!el) return;
  const q = (document.getElementById('line-search')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('line-filter')?.value || 'all';

  let rows = allUsers || [];
  if (q) rows = rows.filter(r => (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));
  if (filter === 'bound') rows = rows.filter(r => !!r.line_user_id);
  else if (filter === 'unbound') rows = rows.filter(r => !r.line_user_id);

  if (!rows.length) { el.innerHTML = `<div class="p-6 subtle text-center">無符合的使用者</div>`; return; }

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th style="width:60px;">ID</th>
        <th>姓名</th>
        <th>角色</th>
        <th>手機</th>
        <th>LINE 綁定</th>
        <th style="width:120px;"></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const archived = !!r.archived_at;
          const archBadge = archived ? ' <span class="badge badge-cancelled" style="font-size:10px;">已封存</span>' : '';
          const bound = !!r.line_user_id;
          const statusBadge = bound
            ? '<span class="badge badge-open">已綁定</span>'
            : '<span class="badge badge-completed">未綁定</span>';
          const action = bound
            ? `<button class="btn btn-danger btn-sm" data-line-unbind="${r.id}">解除綁定</button>`
            : '';
          return `<tr${archived ? ' style="opacity:0.55;"' : ''}>
            <td data-label="ID" class="subtle cell-id">#${r.id}</td>
            <td data-label="姓名" class="cell-name"><span class="font-medium">${escapeHtml(r.name)}</span>${archBadge}</td>
            <td data-label="角色">${lineRoleBadge(r)}</td>
            <td data-label="手機" class="subtle">${escapeHtml(r.phone || '')}</td>
            <td data-label="LINE 綁定">${statusBadge}</td>
            <td data-label="操作">${action}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  el.querySelectorAll('[data-line-unbind]').forEach(btn => btn.addEventListener('click', () => doLineUnbind(Number(btn.dataset.lineUnbind))));
}

async function doLineUnbind(id) {
  const u = (allUsers || []).find(x => x.id === id);
  if (!u) return;
  if (!confirm(`確定解除「${u.name}」（${u.phone || '無電話'}）的 LINE 綁定？\n解除後請該使用者用正確號碼重新綁定。`)) return;
  try {
    await api(`/api/admin/users/${id}/line`, { method: 'DELETE' });
    u.line_user_id = null;
    toast('已解除 LINE 綁定', 'success');
    renderLineTable();
  } catch (e) {
    toast(`解除失敗：${e.data?.error || e.message}`, 'error');
  }
}

function ensureUserEditOverlay() {
  let ov = document.getElementById('user-edit-overlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'user-edit-overlay';
  ov.className = 'overlay';
  ov.style.display = 'none';
  ov.innerHTML = `
    <div class="modal-panel" style="max-width:440px;position:relative;">
      <button id="ue-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none" style="position:absolute;top:16px;right:18px;">✕</button>
      <h3 class="section-title" style="margin-bottom:16px;">編輯會員</h3>
      <div id="ue-body"></div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
  ov.querySelector('#ue-close').addEventListener('click', () => { ov.style.display = 'none'; });
  return ov;
}

function openUserEditModal(id) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  const ov = ensureUserEditOverlay();
  const body = ov.querySelector('#ue-body');
  const archived = !!u.archived_at;
  const v = (x) => escapeHtml(x ?? '');
  const fld = (label, inner) => `<div class="mb-2"><label class="subtle" style="font-size:13px;display:block;margin-bottom:2px;">${label}</label>${inner}</div>`;
  // 角色 = 會員/教練；管理者為教練身上的權限標籤。自己那列唯讀（cannot_change_self）。
  const isSelf = u.id === user.id;
  const roleField = (() => {
    if (isSelf) {
      const label = u.is_admin ? '管理者（教練）' : (ROLE_LABEL[u.role] || u.role);
      return fld('角色', `<input class="form-input" value="${escapeHtml(label)}（不可變更自己）" disabled style="margin-bottom:0;" />`);
    }
    const opts = ['user', 'coach'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
    return fld('角色',
      `<select id="ue-role" class="form-select" style="margin-bottom:0;">${opts}</select>
       <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px;cursor:pointer;" class="subtle">
         <input id="ue-admin" type="checkbox" ${u.is_admin ? 'checked' : ''} ${u.role === 'coach' ? '' : 'disabled'} /> 管理者（可管理會員/教練與角色；僅教練可勾）
       </label>`);
  })();
  body.innerHTML = `
    ${fld('姓名', `<input id="ue-name" class="form-input" value="${v(u.name)}" style="margin-bottom:0;" />`)}
    ${fld('手機', `<input id="ue-phone" class="form-input" value="${v(u.phone)}" inputmode="numeric" style="margin-bottom:0;" />`)}
    ${fld('Email', `<input id="ue-email" type="email" class="form-input" value="${v(u.email)}" style="margin-bottom:0;" />`)}
    ${fld('生日', `<input id="ue-birthday" type="date" class="form-input" value="${v(u.birthday)}" style="margin-bottom:0;" />`)}
    ${roleField}
    <div class="flex items-center justify-between gap-2" style="margin-top:14px;">
      <button id="ue-save" class="btn btn-primary btn-sm">儲存</button>
      ${archived
        ? '<button id="ue-restore" class="btn btn-ghost btn-sm">還原</button>'
        : '<button id="ue-archive" class="btn btn-danger btn-sm">封存此會員</button>'}
    </div>
    ${archived ? '<p class="subtle" style="font-size:12px;margin-top:10px;">此會員已封存（僅後台列表隱藏；本人前台仍可查詢，下次同電話預約會自動還原）。</p>' : ''}
    <div id="ue-packages" style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:12px;"></div>`;
  ov.style.display = 'grid';
  renderMemberPackages(id, body.querySelector('#ue-packages'));

  // 管理者標籤只在角色=教練時可勾；切回會員時自動取消勾選並禁用。
  const roleSel = body.querySelector('#ue-role');
  const adminChk = body.querySelector('#ue-admin');
  if (roleSel && adminChk) {
    roleSel.addEventListener('change', () => {
      if (roleSel.value === 'coach') { adminChk.disabled = false; }
      else { adminChk.checked = false; adminChk.disabled = true; }
    });
  }

  body.querySelector('#ue-save').addEventListener('click', async () => {
    const payload = {
      name: body.querySelector('#ue-name').value,
      phone: body.querySelector('#ue-phone').value,
      email: body.querySelector('#ue-email').value,
      birthday: body.querySelector('#ue-birthday').value,
    };
    const newRole = roleSel ? roleSel.value : null;
    const newAdmin = newRole === 'coach' && !!adminChk?.checked;
    const msgs = {
      email_taken: 'Email 已被其他會員使用',
      phone_taken: '手機已被其他會員使用',
      invalid_phone: '手機格式錯誤（8–15 碼數字）',
      missing_name: '姓名必填',
      email_required: '此帳號以 Email 登入，不可清空 Email',
      cannot_change_self: '不能變更自己的角色或權限',
      last_admin: '需至少保留一位管理者',
      invalid_role: '無效的角色',
    };
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: payload });
      if (roleSel && (newRole !== u.role || newAdmin !== !!u.is_admin)) {
        await api(`/api/admin/users/${id}/role`, { method: 'PATCH', body: { role: newRole, is_admin: newAdmin } });
      }
      toast('已更新會員資料', 'success');
      ov.style.display = 'none';
      await loadUsers();
    } catch (e) {
      toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
    }
  });

  const archiveBtn = body.querySelector('#ue-archive');
  if (archiveBtn) archiveBtn.addEventListener('click', async () => {
    if (!confirm(`確定封存「${u.name}」？封存後不會出現在會員列表（本人前台仍可查詢；下次同電話預約會自動還原）。`)) return;
    try {
      await api(`/api/admin/users/${id}/archive`, { method: 'POST' });
      toast('已封存', 'success');
      ov.style.display = 'none';
      await loadUsers();
    } catch (e) {
      const msgs = { cannot_archive_self: '不能封存自己' };
      toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
    }
  });

  const restoreBtn = body.querySelector('#ue-restore');
  if (restoreBtn) restoreBtn.addEventListener('click', async () => {
    try {
      await api(`/api/admin/users/${id}/restore`, { method: 'POST' });
      toast('已還原', 'success');
      ov.style.display = 'none';
      await loadUsers();
    } catch (e) { toast(`失敗：${e.message}`, 'error'); }
  });
}

const PKG_TYPE_LABEL = { '1on1': '一對一', '1on2': '一對二' };

let adminDiscountCodesCache = null; // [{code,discount_type,discount_value}]
async function getDiscountCodes() {
  if (adminDiscountCodesCache) return adminDiscountCodesCache;
  try { adminDiscountCodesCache = await api('/api/coach/discount-codes'); } catch { adminDiscountCodesCache = []; }
  return adminDiscountCodesCache;
}
function discountOptionsHtml(codes) {
  const label = (c) => c.discount_type === 'percent' ? `${c.discount_value}% 折扣` : `折抵 $${c.discount_value}`;
  return '<option value="">不使用折扣碼</option>' +
    codes.map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} — ${label(c)}</option>`).join('');
}

async function renderMemberPackages(memberId, mountEl) {
  if (!mountEl) return;
  mountEl.innerHTML = '<p class="subtle" style="font-size:12px;">載入方案中…</p>';
  let pkgs = [];
  try { pkgs = await api(`/api/coach/packages?memberId=${memberId}&includeArchived=1`); }
  catch { mountEl.innerHTML = '<p class="subtle" style="font-size:12px;color:#dc2626;">方案載入失敗</p>'; return; }

  const rowHtml = pkgs.map(p => {
    const arch = !!p.archived_at;
    const badge = arch ? '<span class="badge badge-cancelled" style="font-size:10px;">已作廢</span>'
      : p.is_valid ? '<span class="badge" style="font-size:10px;background:#dcfce7;color:#166534;">有效</span>'
      : '<span class="badge" style="font-size:10px;background:#fef9c3;color:#854d0e;">已失效</span>';
    const exp = p.expires_at ? `到期 ${escapeHtml(p.expires_at)}` : '永久';
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:13px;">
        <strong>${PKG_TYPE_LABEL[p.session_type] || escapeHtml(p.session_type)}</strong> ${p.remaining_sessions}/${p.total_sessions} 堂 ${badge}
        <div class="subtle" style="font-size:11px;">${exp}${p.amount != null ? ` · NT$${escapeHtml(String(p.amount))}` : ''}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" data-act="adjust" data-id="${p.id}" data-total="${escapeHtml(String(p.total_sessions))}" data-remaining="${escapeHtml(String(p.remaining_sessions))}">調整</button>
        ${arch
          ? `<button class="btn btn-ghost btn-sm" data-act="restore" data-id="${p.id}">還原</button>`
          : `<button class="btn btn-danger btn-sm" data-act="archive" data-id="${p.id}">作廢</button>`}
      </div>
    </div>`;
  }).join('') || '<p class="subtle" style="font-size:12px;">尚無方案</p>';

  mountEl.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:6px;">方案（套餐）</div>
    <div id="pkg-list">${rowHtml}</div>
    <details style="margin-top:8px;">
      <summary style="font-size:13px;cursor:pointer;color:#0284c7;">＋ 新增方案</summary>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">
        <select id="pkg-type" class="form-select" style="margin:0;"><option value="1on1">一對一</option><option value="1on2">一對二</option></select>
        <input id="pkg-total" class="form-input" type="number" min="1" placeholder="堂數" style="margin:0;" />
        <input id="pkg-amount" class="form-input" type="number" min="0" placeholder="金額（可空）" style="margin:0;" />
        <input id="pkg-expiry" class="form-input" type="date" style="margin:0;" />
      </div>
      <input id="pkg-note" class="form-input" placeholder="備註（可空）" style="margin:6px 0 0;" />
      <select id="pkg-discount" class="form-select" style="margin:6px 0 0;"></select>
      <button id="pkg-create" class="btn btn-primary btn-sm" style="margin-top:8px;">建立方案</button>
    </details>`;

  getDiscountCodes().then(codes => { const el = mountEl.querySelector('#pkg-discount'); if (el) el.innerHTML = discountOptionsHtml(codes); });

  // 建立
  mountEl.querySelector('#pkg-create')?.addEventListener('click', async () => {
    const total = Number(mountEl.querySelector('#pkg-total').value);
    if (!Number.isInteger(total) || total <= 0) { toast('請填正確堂數', 'error'); return; }
    const amountRaw = mountEl.querySelector('#pkg-amount').value;
    const expiry = mountEl.querySelector('#pkg-expiry').value;
    try {
      await api('/api/coach/packages', { method: 'POST', body: {
        memberId, sessionType: mountEl.querySelector('#pkg-type').value, totalSessions: total,
        amount: amountRaw === '' ? null : Number(amountRaw),
        expiresAt: expiry || null, note: mountEl.querySelector('#pkg-note').value || null,
        discountCode: mountEl.querySelector('#pkg-discount')?.value || null,
      }});
      toast('方案已建立', 'success');
      renderMemberPackages(memberId, mountEl);
    } catch (e) {
      const msgs = { invalid_total: '堂數不正確', invalid_amount: '金額不正確', invalid_expires_at: '到期日格式錯', invalid_session_type: '類型不正確' };
      toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
    }
  });

  // 調整 / 作廢 / 還原
  mountEl.querySelector('#pkg-list')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;
    try {
      if (act === 'adjust') {
        const total = Number(btn.dataset.total);
        const cur = Number(btn.dataset.remaining);
        const input = prompt(`調整剩餘堂數（0–${total}）`, String(cur));
        if (input == null) return;
        const r = Number(input);
        if (!Number.isInteger(r) || r < 0 || r > total) { toast('堂數需為 0–' + total, 'error'); return; }
        await api(`/api/coach/packages/${id}`, { method: 'PATCH', body: { remaining: r } });
        toast('已調整剩餘堂數', 'success');
      } else if (act === 'archive') {
        if (!confirm('確定作廢此方案？此方案名下所有未取消的預約將一併取消（不可復原），剩餘堂數保留紀錄。')) return;
        const r = await api(`/api/coach/packages/${id}/archive`, { method: 'POST' });
        toast(r.cancelledBookingIds?.length ? `已作廢，連動取消 ${r.cancelledBookingIds.length} 筆預約` : '已作廢', 'success');
      } else if (act === 'restore') {
        await api(`/api/coach/packages/${id}/restore`, { method: 'POST' });
        toast('已還原', 'success');
      }
      renderMemberPackages(memberId, mountEl);
    } catch (e) {
      const msgs = { invalid_remaining: '剩餘堂數超出範圍', package_not_found: '找不到方案' };
      toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
    }
  });
}

// --- Categories ---
let categoriesCache = [];

// --- Coaches (for template form select) ---
let coachesCache = [];
async function loadCoachesForForm() {
  const sel = document.getElementById('tpl-coach-select');
  try {
    coachesCache = await api('/api/admin/coaches');
    if (sel) {
      const current = sel.value;
      sel.innerHTML = '<option value="">— 請選擇授課教練 —</option>' +
        coachesCache.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
      if (current) sel.value = current;
    }
  } catch (e) {
    // 教練清單載入失敗不阻斷後台其他功能
    console.error('load coaches for form failed', e);
  }
}

async function loadCategories() {
  const el = document.getElementById('categories-table');
  try {
    categoriesCache = await api('/api/admin/categories');
    // Populate template form select
    const sel = document.getElementById('tpl-name-select');
    if (sel) {
      const current = sel.value;
      sel.innerHTML = '<option value="">— 從下方分類中選擇 —</option>' +
        categoriesCache.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
      if (current && categoriesCache.some(c => c.name === current)) sel.value = current;
    }

    if (!categoriesCache.length) {
      el.innerHTML = '<div class="p-6 subtle text-center">尚無分類，點「＋ 新增分類」</div>';
      return;
    }

    el.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th style="width:60px;">排序</th>
          <th>名稱</th>
          <th>說明</th>
          <th style="width:160px;">操作</th>
        </tr></thead>
        <tbody>
          ${categoriesCache.map(c => `
            <tr>
              <td data-label="排序" class="subtle cell-id">#${c.sort_order}</td>
              <td data-label="名稱" class="cell-name"><span class="font-medium">${escapeHtml(c.name)}</span></td>
              <td data-label="說明" class="subtle cell-span">${escapeHtml(c.description || '—')}</td>
              <td data-label="操作" class="cell-span">
                <div class="row-actions">
                  <button class="btn btn-ghost btn-sm cat-edit" data-id="${c.id}">編輯</button>
                  <button class="btn btn-danger btn-sm cat-del" data-id="${c.id}">刪除</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('.cat-edit').forEach(b => b.addEventListener('click', () => editCategory(Number(b.dataset.id))));
    el.querySelectorAll('.cat-del').forEach(b => b.addEventListener('click', () => deleteCategory(Number(b.dataset.id))));
  } catch (e) {
    el.innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

async function newCategory() {
  const name = prompt('分類名稱（例：重量訓練、TRX、HIIT）');
  if (!name || !name.trim()) return;
  const description = prompt('說明（可留空）') || '';
  try {
    await api('/api/admin/categories', { method: 'POST', body: { name: name.trim(), description } });
    toast(`已新增：${name.trim()}`, 'success');
    loadCategories();
  } catch (e) {
    const msgs = { name_exists: '此名稱已存在', missing_name: '名稱不能為空' };
    toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
  }
}

async function editCategory(id) {
  const c = categoriesCache.find(x => x.id === id);
  if (!c) return;
  const name = prompt('分類名稱', c.name);
  if (name === null) return;
  const description = prompt('說明', c.description || '') ?? c.description;
  const sort_order = prompt('排序（數字越小越前）', String(c.sort_order)) ?? c.sort_order;
  try {
    await api(`/api/admin/categories/${id}`, { method: 'PATCH', body: { name, description, sort_order } });
    toast('已更新', 'success');
    loadCategories();
  } catch (e) {
    const msgs = { name_exists: '此名稱已存在' };
    toast(msgs[e.data?.error] || `失敗：${e.message}`, 'error');
  }
}

async function deleteCategory(id) {
  const c = categoriesCache.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`確定刪除分類「${c.name}」？\n\n既有課程範本不受影響，但此名稱會從下拉選單消失。`)) return;
  try {
    await api(`/api/admin/categories/${id}`, { method: 'DELETE' });
    toast('已刪除', 'success');
    loadCategories();
  } catch (e) {
    toast(`失敗：${e.message}`, 'error');
  }
}

document.getElementById('new-cat-btn').addEventListener('click', newCategory);

// --- Coach management ---
async function loadCoachMgmt() {
  const coaches = await api('/api/admin/coaches');
  const wrap = document.getElementById('coach-mgmt-list');
  wrap.innerHTML = '';
  if (coaches.length === 0) wrap.innerHTML = '<p class="text-slate-500 text-sm">尚無教練</p>';
  for (const c of coaches) {
    const row = document.createElement('div');
    row.className = 'card flex items-center justify-between gap-3 mb-2';
    row.innerHTML = `
      <div>
        <div class="font-semibold">${escapeHtml(c.display_name)} <span class="text-xs ${c.is_active ? 'text-green-600' : 'text-amber-600'}">${c.is_active ? '啟用中' : '待啟用'}</span></div>
        <div class="text-xs text-slate-500">${escapeHtml(c.user_email)} · ${escapeHtml(c.specialty || '')}</div>
      </div>
      <div class="flex gap-2">
        <button data-id="${c.id}" data-active="${c.is_active}" class="btn btn-ghost btn-sm toggle-active">${c.is_active ? '停用' : '啟用'}</button>
        <button data-id="${c.id}" class="btn btn-danger btn-sm demote-btn">降為一般用戶</button>
      </div>
    `;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll('.toggle-active').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/admin/coaches/${b.dataset.id}`, { method: 'PATCH', body: { is_active: b.dataset.active === '0' || b.dataset.active === 'false' ? 1 : 0 } });
    loadCoachMgmt();
  }));
  wrap.querySelectorAll('.demote-btn').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('確定降為一般用戶？此教練會從教練管理清單移除；歷史預約保留，但不再出現在客人端。')) return;
    try {
      await api(`/api/admin/coaches/${b.dataset.id}`, { method: 'DELETE' });
      loadCoachMgmt();
    } catch (e) {
      toast(e.data?.error === 'cannot_change_self' ? '不能把自己降為一般用戶' : `失敗：${e.message}`, 'error');
    }
  }));
}

// --- Create coach account form ---
document.getElementById('create-coach-account-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = document.getElementById('create-coach-account-error');
  const btn = document.getElementById('create-coach-account-btn');
  errBox.classList.add('hidden');
  errBox.textContent = '';
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '建立中…';

  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api('/api/admin/coaches/account', { method: 'POST', body: { email: data.email, password: data.password, name: data.name } });
    toast('教練帳號已建立，請於下方啟用', 'success');
    form.reset();
    loadCoachMgmt();
  } catch (err) {
    const errorMsgs = {
      email_exists: '此 Email 已被使用',
      invalid_email: 'Email 格式不正確',
      password_too_short: '密碼至少需要 8 個字元',
      missing_name: '請輸入姓名',
    };
    const code = err.data?.error;
    const msg = errorMsgs[code] || `建立失敗：${err.message}`;
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    toast(msg, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
});

// --- Pending bank-transfer orders（團課訂單 + 教練課預約 合併清單） ---
async function loadPendingOrders() {
  const container = document.getElementById('pending-orders-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const [orders, bookings] = await Promise.all([
      api('/api/admin/group-orders'),
      api('/api/admin/bookings/pending'),
    ]);
    const items = [
      ...orders.map(o => ({ kind: 'order', created_at: o.created_at, o })),
      ...bookings.map(b => ({ kind: b.group ? 'booking_group' : 'booking', created_at: b.created_at, b })),
    ].sort((a, c) => (a.created_at < c.created_at ? 1 : -1)); // 新→舊
    if (!items.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${ICO.check.replace('nk-ico', 'nk-empty-ico')}
          <p>目前沒有待核對的匯款</p>
        </div>`;
      return;
    }
    container.innerHTML = items.map(it =>
      it.kind === 'order' ? orderCardHtml(it.o)
      : it.kind === 'booking_group' ? pendingBookingGroupCardHtml(it.b)
      : pendingBookingCardHtml(it.b)).join('');
    bindPendingHandlers(container);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

function orderCardHtml(o) {
  // 同名課程分組顯示（API 已按 課程名→日期 排序）：課名一行、底下列各場日期
  const groups = [];
  for (const s of o.sessions) {
    const last = groups[groups.length - 1];
    if (last && last.name === s.course_name) last.items.push(s);
    else groups.push({ name: s.course_name, items: [s] });
  }
  const sessionRows = groups.length
    ? groups.map(g => `
        <li class="subtle text-xs">
          <span class="font-medium" style="color:var(--ink-soft, #475569);">${escapeHtml(g.name)}</span>
          <ul class="list-none space-y-0.5" style="padding-left:14px;">
            ${g.items.map(s => `<li>${escapeHtml(fmtDate(s.start_at))}${s.status === 'waitlisted' ? ' <span style="color:#a16207;">（候補，遞補後另收款）</span>' : ''}</li>`).join('')}
          </ul>
        </li>`).join('')
    : '<li class="subtle text-xs">（無場次）</li>';
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(o.customer_name)}</h3>
            <span class="badge badge-confirmed">團課</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(o.customer_phone)}</span>
            <span class="meta-item">${ICO.cash} NT$${Number(o.total_amount).toLocaleString()}</span>
            <span class="meta-item">${ICO.clock} 到期 ${escapeHtml(fmtDate(o.expires_at))}</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${sessionRows}</ul>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-id="${o.id}" class="confirm-order-btn btn btn-primary btn-sm">已收款</button>
          <button data-id="${o.id}" class="cancel-order-btn btn btn-danger btn-sm">取消訂單</button>
        </div>
      </div>
    </article>`;
}

// 循環教練課：同一次送出的多堂集中一張卡（已收款/取消為整批操作）
function pendingBookingGroupCardHtml(g) {
  const label = g.session_type === '1on2' ? '1對2' : '1對1';
  const rows = g.sessions.map(s =>
    `<li class="subtle text-xs">${escapeHtml(fmtDate(s.start_at))}${s.final_amount != null ? `　$${Number(s.final_amount).toLocaleString()}` : ''}</li>`).join('');
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(g.member_name)}</h3>
            <span class="badge badge-completed">教練課 ×${g.sessions.length} 堂</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(g.member_phone || '')}</span>
            <span class="meta-item">${ICO.cash} 合計 NT$${Number(g.total_amount).toLocaleString()}${g.discount_code ? `（折扣碼 ${escapeHtml(g.discount_code)}）` : ''}</span>
            <span class="meta-item">${ICO.dumbbell} ${escapeHtml(g.coach_display_name)}（${label}）</span>
          </div>
          <ul class="list-disc list-inside space-y-0.5">${rows}</ul>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-group="${g.group_id}" class="confirm-booking-group-btn btn btn-primary btn-sm">已收款</button>
          <button data-group="${g.group_id}" class="cancel-booking-group-btn btn btn-danger btn-sm">取消預約</button>
        </div>
      </div>
    </article>`;
}

function pendingBookingCardHtml(b) {
  const label = b.session_type === '1on2' ? '1對2' : '1對1';
  const amount = b.final_amount != null
    ? `NT$${Number(b.final_amount).toLocaleString()}${b.discount_code ? `（折扣碼 ${escapeHtml(b.discount_code)}）` : ''}`
    : '—';
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex-1 min-w-[220px]">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="card-title">${escapeHtml(b.member_name)}</h3>
            <span class="badge badge-completed">教練課</span>
            <span class="badge badge-waitlisted">待核對</span>
          </div>
          <div class="meta mb-2">
            <span class="meta-item">${ICO.phone} ${escapeHtml(b.member_phone || '')}</span>
            <span class="meta-item">${ICO.cash} ${amount}</span>
            <span class="meta-item">${ICO.dumbbell} ${escapeHtml(b.coach_display_name)}（${label}）</span>
            <span class="meta-item">${ICO.clock} ${escapeHtml(fmtDate(b.start_at))}</span>
          </div>
        </div>
        <div class="flex flex-col gap-2 min-w-[110px]">
          <button data-id="${b.id}" class="confirm-booking-btn btn btn-primary btn-sm">已收款</button>
          <button data-id="${b.id}" class="cancel-booking-btn btn btn-danger btn-sm">取消預約</button>
        </div>
      </div>
    </article>`;
}

function bindPendingHandlers(container) {
  container.querySelectorAll('.confirm-order-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`確認已收到「${btn.closest('article').querySelector('.card-title').textContent}」的匯款？`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/group-orders/${btn.dataset.id}/confirm`, { method: 'POST' });
        toast('已確認收款，訂單完成', 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { order_not_found: '找不到訂單', order_cancelled: '訂單已取消' };
        toast(msgs[e.data?.error] || `確認失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.cancel-order-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定取消此訂單？已佔的名額會釋出並通知候補者。')) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/group-orders/${btn.dataset.id}/cancel`, { method: 'POST' });
        toast('已取消訂單', 'success');
        loadPendingOrders();
      } catch (e) {
        const msgs = { order_not_found: '找不到訂單', order_already_paid: '訂單已付款', forbidden: '無權操作此訂單' };
        toast(msgs[e.data?.error] || `取消失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.confirm-booking-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`確認已收到「${btn.closest('article').querySelector('.card-title').textContent}」的教練課款項？`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/bookings/${btn.dataset.id}/confirm-payment`, { method: 'POST' });
        toast('已確認收款，預約成立並已通知會員', 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { booking_not_found: '找不到預約', booking_cancelled: '預約已取消', already_paid: '此筆已核對過' };
        toast(msgs[e.data?.error] || `確認失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.confirm-booking-group-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('article').querySelector('.card-title').textContent;
      if (!confirm(`確認已收到「${name}」整批教練課款項？（卡片上所有堂數一次核對）`)) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/admin/bookings/group/${btn.dataset.group}/confirm-payment`, { method: 'POST' });
        toast(`已確認收款 ${r.confirmed} 堂，已通知會員`, 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { already_paid: '此批已全數核對過' };
        toast(msgs[e.data?.error] || `確認失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.cancel-booking-group-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('article').querySelector('.card-title').textContent;
      const reason = prompt(`取消「${name}」整批教練課預約？\n會釋出所有時段並以 LINE/系統通知顧客與教練。\n取消原因（可留空）：`);
      if (reason === null) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/admin/bookings/group/${btn.dataset.group}/cancel`, { method: 'POST', body: { reason: reason.trim() } });
        toast(`已取消 ${r.cancelled.length} 堂並通知顧客`, 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { no_pending_bookings: '此批沒有可取消的未收款預約' };
        toast(msgs[e.data?.error] || `取消失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  container.querySelectorAll('.cancel-booking-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('article').querySelector('.card-title').textContent;
      // prompt 即守門：按「取消」(null) 中止；原因可留空（不會附在通知裡）
      const reason = prompt(`取消「${name}」的教練課預約？\n會釋出時段並以 LINE/系統通知顧客與教練。\n取消原因（可留空）：`);
      if (reason === null) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/bookings/${btn.dataset.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } });
        toast('已取消預約並通知顧客', 'success');
        loadPendingOrders(); loadConfirmedPayments();
      } catch (e) {
        const msgs = { booking_not_found: '找不到預約', already_cancelled: '此預約已取消' };
        toast(msgs[e.data?.error] || `取消失敗：${e.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
}

// --- 已核對匯款（唯讀）---
async function loadConfirmedPayments() {
  const container = document.getElementById('confirmed-payments-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const list = await api('/api/admin/payments/confirmed');
    if (!list.length) {
      container.innerHTML = '<div class="subtle p-4">尚無已核對的款項</div>';
      return;
    }
    container.innerHTML = list.map(x => {
      const isBooking = x.type === 'booking';
      const isBookingGroup = x.type === 'booking_group';
      const typeBadge = isBookingGroup
        ? `<span class="badge badge-completed">教練課 ×${x.count} 堂${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
        : isBooking
          ? `<span class="badge badge-completed">教練課${x.session_type === '1on2' ? '（1對2）' : ''}</span>`
          : '<span class="badge badge-confirmed">團課</span>';
      const refundBadge = x.refunded_at
        ? '<span class="badge badge-cancelled">已退款</span>'
        : (x.partial_refund ? '<span class="badge badge-cancelled">部分退款</span>' : '');
      const detail = isBooking ? fmtDate(x.detail) : x.detail;
      return `
        <article class="card confirmed-payment-row" data-type="${x.type}" data-id="${x.id}"
                 data-name="${escapeHtml(x.customer_name)}" data-amount="${x.amount ?? ''}"
                 data-refunded="${x.refunded_at ? '1' : '0'}">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap"${x.refunded_at ? ' style="opacity:.55"' : ''}>
              <strong>${escapeHtml(x.customer_name)}</strong>
              ${typeBadge}${refundBadge}
              <span class="subtle text-sm">${escapeHtml(detail || '')}</span>
              <span class="subtle text-sm" style="display:inline-flex;align-items:center;gap:5px;">${ICO.cash.replace('class="nk-ico"', 'style="width:14px;height:14px;flex:none;"')} ${x.amount != null ? 'NT$' + Number(x.amount).toLocaleString() : '—'}</span>
            </div>
            <div class="subtle text-xs">核對 ${escapeHtml(fmtDate(x.paid_at))} · 經手 ${escapeHtml(x.paid_by_name || '—')}</div>
          </div>
        </article>`;
    }).join('');
    bindConfirmedPaymentLongPress(container);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

// 長按已核對款項卡片（手機 touch / 桌機滑鼠按住 0.5 秒）→ 取消預約並退款。
// 教練課：取消預約、釋出時段、刪日曆事件；團課：整單取消、釋名額並遞補候補
// （遞補者會出現在上方「待核對匯款」）。金流由店家線下退回，系統記錄退款時間與經手人。
function bindConfirmedPaymentLongPress(container) {
  container.querySelectorAll('.confirmed-payment-row').forEach(card => {
    let timer = null;
    const start = () => {
      timer = setTimeout(() => {
        timer = null;
        if (card.dataset.refunded === '1') { toast('此筆已退款過', 'error'); return; }
        const t = card.dataset.type;
        const label = t === 'booking' ? '教練課預約' : t === 'booking_group' ? '整批教練課預約' : '團課訂單';
        const amt = card.dataset.amount ? `NT$${Number(card.dataset.amount).toLocaleString()}` : '款項';
        const extra = t === 'group_order' ? '\n名額將釋出，候補者會遞補為新的待核對訂單。' : '\n時段將釋出。';
        if (!confirm(`取消「${card.dataset.name}」的${label}並退款 ${amt}？${extra}\n（會以 LINE/系統通知顧客；實際退款請自行匯回）`)) return;
        const url = t === 'booking' ? `/api/admin/bookings/${card.dataset.id}/refund`
          : t === 'booking_group' ? `/api/admin/bookings/group/${card.dataset.id}/refund`
          : `/api/admin/group-orders/${card.dataset.id}/refund`;
        api(url, { method: 'POST' })
          .then(() => { toast('已取消並標記退款，已通知顧客', 'success'); loadPendingOrders(); loadConfirmedPayments(); })
          .catch(e => {
            const msgs = { not_paid: '此筆尚未核對收款', already_refunded: '此筆已退款過', booking_not_found: '找不到預約', order_not_found: '找不到訂單' };
            toast(msgs[e.data?.error] || `退款失敗：${e.message}`, 'error');
          });
      }, 500);
    };
    const cancelT = () => { if (timer) { clearTimeout(timer); timer = null; } };
    card.addEventListener('touchstart', start, { passive: true });
    card.addEventListener('touchend', cancelT);
    card.addEventListener('touchmove', cancelT);
    card.addEventListener('mousedown', start);
    card.addEventListener('mouseup', cancelT);
    card.addEventListener('mouseleave', cancelT);
  });
}

document.getElementById('btn-reload-orders')?.addEventListener('click', () => { loadPendingOrders(); loadConfirmedPayments(); });

// --- Settings: 1v1 price + 匯款帳號 + 官方 LINE 連結 ---
async function loadOneOnOnePrice() {
  try {
    const r = await api('/api/admin/settings');
    const priceInput = document.getElementById('one-on-one-price');
    if (priceInput) priceInput.value = r.one_on_one_price;
    const price2Input = document.getElementById('one-on-two-price');
    if (price2Input) price2Input.value = r.one_on_two_price;
    const bankInput = document.getElementById('bank-info');
    if (bankInput) bankInput.value = r.bank_info ?? '';
    const lineInput = document.getElementById('line-official-url');
    if (lineInput) lineInput.value = r.line_official_url ?? '';
    const gcalInput = document.getElementById('gcal-calendar-id');
    if (gcalInput) gcalInput.value = r.gcal_calendar_id ?? '';
    const capInput = document.getElementById('booking-hourly-capacity');
    if (capInput) capInput.value = r.booking_hourly_capacity ?? 3;
    const expiryInput = document.getElementById('group-order-expiry-hours');
    if (expiryInput) expiryInput.value = r.group_order_expiry_hours ?? 72;
  } catch (e) {
    toast(`載入營運設定失敗：${escapeHtml(e.message)}`, 'error');
  }
}

document.getElementById('save-one-on-one-price')?.addEventListener('click', async () => {
  const input = document.getElementById('one-on-one-price');
  const price = Number(input?.value);
  if (!Number.isInteger(price) || price < 1) {
    toast('請輸入有效的金額（正整數）', 'error');
    return;
  }
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { one_on_one_price: price } });
    toast(`1對1 單堂價已更新為 NT$${price}`, 'success');
  } catch (e) {
    toast(`儲存失敗：${escapeHtml(e.message)}`, 'error');
  }
});

document.getElementById('save-one-on-two-price')?.addEventListener('click', async () => {
  const input = document.getElementById('one-on-two-price');
  const price = Number(input?.value);
  if (!Number.isInteger(price) || price < 1) {
    toast('請輸入有效的金額（正整數）', 'error');
    return;
  }
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { one_on_two_price: price } });
    toast(`1對2 單堂價已更新為 NT$${price}`, 'success');
  } catch (e) {
    toast(`儲存失敗：${escapeHtml(e.message)}`, 'error');
  }
});

document.getElementById('save-bank-line')?.addEventListener('click', async () => {
  const bank_info = (document.getElementById('bank-info')?.value || '').trim();
  const line_official_url = (document.getElementById('line-official-url')?.value || '').trim();
  const expiryHours = Number(document.getElementById('group-order-expiry-hours')?.value);
  if (!bank_info) {
    toast('請輸入匯款帳號', 'error');
    return;
  }
  if (line_official_url && !/^https?:\/\//i.test(line_official_url)) {
    toast('LINE 連結需為 http(s):// 開頭的網址', 'error');
    return;
  }
  if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 720) {
    toast('付款期限需為 1–720 的整數（小時）', 'error');
    return;
  }
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { bank_info, line_official_url, group_order_expiry_hours: expiryHours } });
    toast('收款與 LINE 設定已更新', 'success');
  } catch (e) {
    toast(`儲存失敗：${escapeHtml(e.message)}`, 'error');
  }
});

// --- Settings: Google 日曆 ID + 每小時容量 + Gmail 寄信授權 ---
document.getElementById('save-gcal-settings')?.addEventListener('click', async () => {
  const gcal_calendar_id = (document.getElementById('gcal-calendar-id')?.value || '').trim();
  const cap = Number(document.getElementById('booking-hourly-capacity')?.value);
  if (!Number.isInteger(cap) || cap < 1 || cap > 99) {
    toast('容量需為 1–99 的整數', 'error');
    return;
  }
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { gcal_calendar_id, booking_hourly_capacity: cap } });
    toast('Google 日曆與容量設定已更新', 'success');
  } catch (e) {
    toast(`儲存失敗：${escapeHtml(e.message)}`, 'error');
  }
});

document.getElementById('gmail-auth-btn')?.addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/gmail-auth/start', { method: 'POST' });
    window.location.href = r.url;
  } catch (e) {
    toast(`無法發起授權：${escapeHtml(e.message)}`, 'error');
  }
});

// --- Discount codes ---
async function loadDiscountCodes() {
  const container = document.getElementById('discount-codes-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const codes = await api('/api/admin/discount-codes');
    if (!codes.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${ICO.tag.replace('nk-ico', 'nk-empty-ico')}
          <p>尚無折扣碼</p>
          <p class="subtle mt-1">使用上方表單建立第一個折扣碼</p>
        </div>`;
      return;
    }
    container.innerHTML = codes.map(c => {
      const typeLabel = c.discount_type === 'percent' ? `減 ${c.discount_value}%` : `減 $${c.discount_value}`;
      const usageText = c.max_uses != null ? `${c.used_count}/${c.max_uses}` : `已用 ${c.used_count}`;
      const limits = [];
      if (c.valid_from || c.valid_until) {
        limits.push(`有效期：${escapeHtml(c.valid_from || '—')} ~ ${escapeHtml(c.valid_until || '—')}`);
      }
      limits.push(`使用量：${usageText}`);
      if (c.per_phone_limit != null) limits.push(`每人上限 ${c.per_phone_limit} 次`);
      if (c.min_amount != null) limits.push(`最低 NT$${c.min_amount}`);
      return `
        <article class="card" data-code-id="${c.id}">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex-1 min-w-[220px]">
              <div class="flex items-center gap-2 mb-1 flex-wrap">
                <h3 class="card-title font-mono">${escapeHtml(c.code)}</h3>
                <span class="badge badge-${c.discount_type === 'percent' ? 'confirmed' : 'waitlisted'}">${escapeHtml(typeLabel)}</span>
                <span class="badge badge-${c.active ? 'open' : 'completed'}">${c.active ? '啟用中' : '已停用'}</span>
              </div>
              <div class="meta flex-wrap">
                ${limits.map(l => `<span class="meta-item">${escapeHtml(l)}</span>`).join('')}
              </div>
              ${c.note ? `<p class="subtle text-xs mt-1">${escapeHtml(c.note)}</p>` : ''}
            </div>
            <div class="flex gap-2 flex-wrap">
              <button
                data-id="${c.id}"
                data-active="${c.active}"
                class="dc-toggle-btn btn btn-ghost btn-sm"
              >${c.active ? '停用' : '啟用'}</button>
              <button data-id="${c.id}" class="dc-edit-btn btn btn-ghost btn-sm">編輯</button>
              <button data-id="${c.id}" class="dc-del-btn btn btn-danger btn-sm">刪除</button>
            </div>
          </div>
        </article>`;
    }).join('');

    // toggle active/inactive
    container.querySelectorAll('.dc-toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const newActive = btn.dataset.active === '1' || btn.dataset.active === 'true' ? 0 : 1;
        const code = btn.closest('article');
        // collect current values from the rendered card to send full payload
        const codeData = codes.find(c => c.id === id);
        if (!codeData) return;
        try {
          await api(`/api/admin/discount-codes/${id}`, {
            method: 'PATCH',
            body: {
              discount_type: codeData.discount_type,
              discount_value: codeData.discount_value,
              active: newActive,
              valid_from: codeData.valid_from ?? '',
              valid_until: codeData.valid_until ?? '',
              max_uses: codeData.max_uses ?? '',
              per_phone_limit: codeData.per_phone_limit ?? '',
              min_amount: codeData.min_amount ?? '',
              note: codeData.note ?? '',
            },
          });
          toast(`折扣碼已${newActive ? '啟用' : '停用'}`, 'success');
          loadDiscountCodes();
        } catch (e) {
          toast(`操作失敗：${escapeHtml(e.message)}`, 'error');
        }
      });
    });

    // edit: populate form
    container.querySelectorAll('.dc-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const codeData = codes.find(c => c.id === id);
        if (!codeData) return;
        document.getElementById('discount-code-edit-id').value = id;
        document.getElementById('dc-code').value = codeData.code;
        document.getElementById('dc-code').readOnly = true;
        document.getElementById('dc-type').value = codeData.discount_type;
        document.getElementById('dc-value').value = codeData.discount_value;
        document.getElementById('dc-valid-from').value = codeData.valid_from ?? '';
        document.getElementById('dc-valid-until').value = codeData.valid_until ?? '';
        document.getElementById('dc-max-uses').value = codeData.max_uses ?? '';
        document.getElementById('dc-per-phone').value = codeData.per_phone_limit ?? '';
        document.getElementById('dc-min-amount').value = codeData.min_amount ?? '';
        document.getElementById('dc-note').value = codeData.note ?? '';
        document.getElementById('dc-submit-btn').textContent = '儲存修改';
        document.getElementById('dc-cancel-btn').classList.remove('hidden');
        document.getElementById('discount-code-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // delete
    container.querySelectorAll('.dc-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const codeData = codes.find(c => c.id === id);
        if (!codeData) return;
        if (!confirm(`確定刪除折扣碼「${codeData.code}」？此操作無法復原。`)) return;
        try {
          await api(`/api/admin/discount-codes/${id}`, { method: 'DELETE' });
          toast('已刪除折扣碼', 'success');
          loadDiscountCodes();
        } catch (e) {
          if (e.data?.error === 'has_redemptions') {
            toast('此折扣碼已被使用，請改停用', 'error');
          } else {
            toast(`刪除失敗：${escapeHtml(e.message)}`, 'error');
          }
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

// reset discount code form to create mode
function resetDiscountCodeForm() {
  document.getElementById('discount-code-edit-id').value = '';
  document.getElementById('discount-code-form').reset();
  document.getElementById('dc-code').readOnly = false;
  document.getElementById('dc-submit-btn').textContent = '建立折扣碼';
  document.getElementById('dc-cancel-btn').classList.add('hidden');
  const errBox = document.getElementById('discount-code-form-error');
  errBox.classList.add('hidden');
  errBox.textContent = '';
}

document.getElementById('dc-cancel-btn')?.addEventListener('click', resetDiscountCodeForm);

document.getElementById('discount-code-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('discount-code-form-error');
  errBox.classList.add('hidden');
  errBox.textContent = '';

  const editId = document.getElementById('discount-code-edit-id').value;
  const nz = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  const payload = {
    discount_type: document.getElementById('dc-type').value,
    discount_value: Number(document.getElementById('dc-value').value),
    active: 1,
    valid_from: document.getElementById('dc-valid-from').value || null,
    valid_until: document.getElementById('dc-valid-until').value || null,
    max_uses: nz(document.getElementById('dc-max-uses').value),
    per_phone_limit: nz(document.getElementById('dc-per-phone').value),
    min_amount: nz(document.getElementById('dc-min-amount').value),
    note: document.getElementById('dc-note').value || null,
  };

  const submitBtn = document.getElementById('dc-submit-btn');
  submitBtn.disabled = true;
  const origText = submitBtn.textContent;
  submitBtn.textContent = '處理中…';

  try {
    if (editId) {
      await api(`/api/admin/discount-codes/${editId}`, { method: 'PATCH', body: payload });
      toast('折扣碼已更新', 'success');
    } else {
      payload.code = document.getElementById('dc-code').value;
      await api('/api/admin/discount-codes', { method: 'POST', body: payload });
      toast('折扣碼已建立', 'success');
    }
    resetDiscountCodeForm();
    loadDiscountCodes();
  } catch (err) {
    const errorMsgs = {
      code_exists: '此折扣碼已存在',
      invalid_value: '折扣值無效（百分比需 1–100，定額需大於 0）',
      invalid_type: '折扣型態無效',
      invalid_limit: '限制數值無效',
      missing_code: '折扣碼不能為空',
    };
    const msg = errorMsgs[err.data?.error] || `失敗：${escapeHtml(err.message)}`;
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    toast(msg, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = origText;
  }
});

// ─── 薪資計算頁籤 ───────────────────────────────────────────
let prPeriod = null;   // 'YYYY-MM'；null=後端預設本期
let prData = null;
let prDefaultPeriod = null;
const prNT = (n) => 'NT$' + Number(n || 0).toLocaleString('zh-TW');
const prDT = (s) => `${s.slice(5, 10).replace('-', '/')} ${s.slice(11, 16)}`;   // 'MM/DD HH:MM'

function prShift(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadPayroll() {
  const box = document.getElementById('pr-table');
  box.innerHTML = '<div class="p-4 subtle">計算中…</div>';
  try {
    const q = prPeriod ? `?period=${encodeURIComponent(prPeriod)}` : '';
    prData = await api(`/api/admin/payroll${q}`);
    prPeriod = prData.period;
    if (!prDefaultPeriod && !q) prDefaultPeriod = prData.period;
    renderPayroll();
  } catch (e) {
    box.innerHTML = `<div class="p-4 text-sm" style="color:#b91c1c;">載入失敗：${escapeHtml(e.message)}</div>`;
  }
}

function renderPayroll() {
  const d = prData;
  const [py, pm] = d.period.split('-');
  document.getElementById('pr-period-label').textContent =
    `${py} 年 ${Number(pm)} 月期（${d.range.start.replace(/-/g, '/')} – ${d.range.end.replace(/-/g, '/')}）`;
  const s = d.settings;
  document.getElementById('pr-settings-summary').textContent =
    `一對一：${s.threshold} 堂（含）以內抽 ${s.pctLow}%，超過 ${s.threshold} 堂全部堂數抽 ${s.pctHigh}%；團體課固定抽 ${s.groupPct}%（不併入級距）。`;
  document.getElementById('pr-threshold').value = s.threshold;
  document.getElementById('pr-pct-low').value = s.pctLow;
  document.getElementById('pr-pct-high').value = s.pctHigh;
  document.getElementById('pr-group-pct').value = s.groupPct;

  const box = document.getElementById('pr-table');
  if (!d.coaches.length) {
    box.innerHTML = '<div class="empty-state"><p>本期沒有教練資料</p></div>';
    return;
  }
  const t = d.totals;
  box.innerHTML = `
    <table class="w-full text-sm data-table">
      <thead><tr>
        <th class="text-left p-3">教練</th>
        <th class="text-right p-3">1對1堂數</th>
        <th class="text-right p-3">1對1實收</th>
        <th class="text-right p-3">適用％</th>
        <th class="text-right p-3">1對1薪資</th>
        <th class="text-right p-3">團課人次</th>
        <th class="text-right p-3">團課實收</th>
        <th class="text-right p-3">團課薪資</th>
        <th class="text-right p-3">應發合計</th>
      </tr></thead>
      <tbody>
        ${d.coaches.map((c, i) => {
          const o = c.oneOnOne;
          const badges =
            (c.isActive ? '' : '<span class="pr-info-badge">已停用</span>') +
            (o.unpriced ? `<span class="pr-warn-badge">${o.unpriced} 堂無單價</span>` : '') +
            (o.future ? `<span class="pr-info-badge">${o.future} 堂未上課</span>` : '');
          return `
          <tr class="pr-row" data-idx="${i}">
            <td class="p-3 cell-name"><span class="font-medium">${escapeHtml(c.displayName)}</span>${badges}</td>
            <td class="p-3 text-right pr-c-sess">${o.sessions}</td>
            <td class="p-3 text-right pr-c-rev subtle">${prNT(o.revenue)}</td>
            <td class="p-3 text-right pr-c-pct">${o.pct}%</td>
            <td class="p-3 text-right pr-c-sal">${prNT(o.salary)}</td>
            <td class="p-3 text-right pr-c-ghead">${c.group.headcount}</td>
            <td class="p-3 text-right pr-c-grev subtle">${prNT(c.group.revenue)}</td>
            <td class="p-3 text-right pr-c-gsal">${prNT(c.group.salary)}</td>
            <td class="p-3 text-right pr-c-total pr-total-cell">${prNT(c.total)}</td>
          </tr>`;
        }).join('')}
        <tr class="pr-grand">
          <td class="p-3 cell-name"><span class="font-medium">全店總計</span></td>
          <td class="p-3 text-right pr-c-sess">${t.oneOnOneSessions}</td>
          <td class="p-3 text-right pr-c-rev">${prNT(t.oneOnOneRevenue)}</td>
          <td class="p-3 text-right pr-c-pct">—</td>
          <td class="p-3 text-right pr-c-sal">${prNT(t.oneOnOneSalary)}</td>
          <td class="p-3 text-right pr-c-ghead">${t.groupHeadcount}</td>
          <td class="p-3 text-right pr-c-grev">${prNT(t.groupRevenue)}</td>
          <td class="p-3 text-right pr-c-gsal">${prNT(t.groupSalary)}</td>
          <td class="p-3 text-right pr-c-total pr-total-cell">${prNT(t.total)}</td>
        </tr>
      </tbody>
    </table>`;

  box.querySelectorAll('tr.pr-row').forEach((tr) => tr.addEventListener('click', () => prToggleDetail(tr)));
}

const SRC_LABEL = { package: '方案', walkin: '散客' };
const TYPE_LABEL = { '1on1': '1對1', '1on2': '1對2' };

function prToggleDetail(tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('pr-detail-row')) { next.remove(); return; }
  tr.closest('tbody').querySelectorAll('.pr-detail-row').forEach((r) => r.remove());
  const c = prData.coaches[Number(tr.dataset.idx)];
  const o = c.oneOnOne;
  const oneRows = o.details.map((x) => `
    <tr><td>${prDT(x.startAt)}${x.future ? '<span class="pr-info-badge">未上課</span>' : ''}</td>
        <td>${escapeHtml(x.memberName)}</td>
        <td>${TYPE_LABEL[x.sessionType] || x.sessionType}·${SRC_LABEL[x.source]}</td>
        <td class="text-right">${x.unpriced ? '<span class="pr-warn-badge">無單價</span>' : prNT(x.amount)}</td></tr>`).join('');
  const grpRows = c.group.details.map((x) => `
    <tr><td>${prDT(x.startAt)}</td>
        <td>${escapeHtml(x.courseName)}</td>
        <td>${x.headcount} 人</td>
        <td class="text-right">${prNT(x.revenue)}</td></tr>`).join('');
  const row = document.createElement('tr');
  row.className = 'pr-detail-row';
  row.innerHTML = `<td colspan="9" class="cell-span"><div class="pr-detail-block">
      <h4>一對一明細（${o.sessions} 堂・實收 ${prNT(o.revenue)}）</h4>
      ${oneRows ? `<table><tbody>${oneRows}</tbody></table>` : '<div class="subtle text-sm">本期無一對一堂數</div>'}
      <h4>團體課明細（${c.group.headcount} 人次・實收 ${prNT(c.group.revenue)}）</h4>
      ${grpRows ? `<table><tbody>${grpRows}</tbody></table>` : '<div class="subtle text-sm">本期無授課團課場次</div>'}
    </div></td>`;
  tr.after(row);
}

function prExportCsv() {
  if (!prData) return;
  const rows = [['教練', '1對1堂數', '1對1實收', '適用%', '1對1薪資', '團課人次', '團課實收', '團課薪資', '應發合計']];
  for (const c of prData.coaches) {
    rows.push([c.displayName, c.oneOnOne.sessions, c.oneOnOne.revenue, c.oneOnOne.pct + '%',
      c.oneOnOne.salary, c.group.headcount, c.group.revenue, c.group.salary, c.total]);
  }
  const t = prData.totals;
  rows.push(['全店總計', t.oneOnOneSessions, t.oneOnOneRevenue, '', t.oneOnOneSalary, t.groupHeadcount, t.groupRevenue, t.groupSalary, t.total]);
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');   // BOM：Excel 中文相容
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `薪資_${prData.period}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('pr-prev').addEventListener('click', () => { prPeriod = prShift(prPeriod, -1); loadPayroll(); });
document.getElementById('pr-next').addEventListener('click', () => { prPeriod = prShift(prPeriod, 1); loadPayroll(); });
document.getElementById('pr-current').addEventListener('click', () => { prPeriod = prDefaultPeriod; loadPayroll(); });
document.getElementById('pr-export').addEventListener('click', prExportCsv);
document.getElementById('pr-settings-toggle').addEventListener('click', () => {
  document.getElementById('pr-settings-form').classList.toggle('hidden');
});
document.getElementById('pr-settings-cancel').addEventListener('click', () => {
  document.getElementById('pr-settings-form').classList.add('hidden');
  if (prData) renderPayroll();   // 還原輸入值
});
document.getElementById('pr-settings-save').addEventListener('click', async () => {
  const body = {
    payroll_tier_threshold: Number(document.getElementById('pr-threshold').value),
    payroll_pct_low: Number(document.getElementById('pr-pct-low').value),
    payroll_pct_high: Number(document.getElementById('pr-pct-high').value),
    payroll_group_pct: Number(document.getElementById('pr-group-pct').value),
  };
  try {
    await api('/api/admin/settings', { method: 'PATCH', body });
    toast('抽成設定已儲存');
    document.getElementById('pr-settings-form').classList.add('hidden');
    loadPayroll();
  } catch (e) {
    toast(`儲存失敗：${e.message}`);
  }
});

loadCategories();
loadCoachesForForm();
loadTemplates();
loadUsers();
loadNotifs();
loadCoachMgmt();
loadBackupSummary();
bindBackupHandlers();
loadPendingOrders();
loadConfirmedPayments();
loadDiscountCodes();
loadOneOnOnePrice();
loadPayroll();

// 後台分頁切換：點頁籤只顯示對應 panel（各區塊資料已於上方一次載入）。
document.querySelectorAll('#admin-tabs .tab').forEach((t) => {
  t.addEventListener('click', () => {
    const id = t.dataset.atab;
    document.querySelectorAll('#admin-tabs .tab').forEach((x) => x.classList.toggle('tab-active', x === t));
    document.querySelectorAll('[id^="apanel-"]').forEach((p) => p.classList.toggle('hidden', p.id !== `apanel-${id}`));
    window.scrollTo({ top: 0 });
  });
});

// 系統操作「?」說明彈窗。兩顆按鈕平常也會自動跑(截止=每小時整點、提醒=每天 9 點)，按鈕只是立刻跑一次。
const HELP_CONTENT = {
  deadlines: {
    title: '立即處理截止',
    html: `
      <p class="subtle mb-3">給「報名截止」的<strong>團體課程場次</strong>做成班判定。系統<strong>每小時整點</strong>也會自動跑；此按鈕只是立刻跑一次。</p>
      <ol style="padding-left:18px;list-style:decimal;line-height:1.8;">
        <li>找出「報名中」且<strong>報名截止時間已到</strong>的場次。</li>
        <li>已確認人數 <strong>≥ 最低成班人數</strong> → <strong>成班</strong>，通知學員與該堂教練「成班」。</li>
        <li>人數不足 → <strong>未開課（取消）</strong>，所有報名改未錄取、退回折扣碼使用次數，通知學員與教練「未開課」。</li>
      </ol>
      <p class="subtle" style="font-size:12px;margin-top:10px;">註：當天請假者不計入成班人數；僅適用團體課程，與 1對1 預約無關。</p>`,
  },
  reminders: {
    title: '寄送上課提醒',
    html: `
      <p class="subtle mb-3">給即將上課的學員寄提醒。系統<strong>每天早上 9 點</strong>也會自動跑；此按鈕只是立刻跑一次。</p>
      <ol style="padding-left:18px;list-style:decimal;line-height:1.8;">
        <li>找出「<strong>已成班</strong>」且 <strong>24 小時內</strong>開課的場次。</li>
        <li>對每位<strong>報名成功</strong>的學員寄「上課提醒」。</li>
      </ol>
      <p class="subtle" style="font-size:12px;margin-top:10px;">註：同一場次寄過就不再寄（不會重複/洗版）；有綁 LINE 走 LINE，否則記在系統。</p>`,
  },
};
function openHelp(key) {
  const c = HELP_CONTENT[key];
  if (!c) return;
  let ov = document.getElementById('help-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'help-overlay';
    ov.className = 'overlay';
    ov.style.display = 'none';
    ov.innerHTML = `
      <div class="modal-panel" style="max-width:460px;position:relative;">
        <button id="help-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none" style="position:absolute;top:14px;right:16px;">✕</button>
        <h3 class="section-title" id="help-title" style="margin-bottom:12px;"></h3>
        <div id="help-body" class="text-sm"></div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
    ov.querySelector('#help-close').addEventListener('click', () => { ov.style.display = 'none'; });
  }
  ov.querySelector('#help-title').textContent = c.title;
  ov.querySelector('#help-body').innerHTML = c.html;
  ov.style.display = 'grid';
}
document.querySelectorAll('.help-btn').forEach((b) => b.addEventListener('click', () => openHelp(b.dataset.help)));

