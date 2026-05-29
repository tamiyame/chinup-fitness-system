import { api, toast, fmtDate, dow, bootAuth, escapeHtml } from '/app.js';

const user = await bootAuth({ requireAdmin: true });
// If bootAuth redirected, halt module execution so no admin content renders.
if (!user) throw new Error('__redirected_by_auth__');

const ROLE_LABEL = { owner: '擁有者', admin: '管理者', user: '會員' };
const ROLE_BADGE = { owner: 'waitlisted', admin: 'confirmed', user: 'open' };

const RECURRENCE_LABEL = { weekly: '每週', monthly: '每月', bimonthly: '每兩個月', quarterly: '每季', semiannual: '每半年' };
const SESSION_STATUS_LABEL = { open: '開放', confirmed: '已成班', cancelled: '未開課', completed: '結束' };
const REG_STATUS_LABEL = { confirmed: '正取', waitlisted: '候補', cancelled: '取消', rejected: '未開課' };

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
          <span class="empty-state-icon">📚</span>
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
              <span class="meta-item">📅 ${dow(t.day_of_week)} ${t.start_time}</span>
              <span class="meta-item">⏱ ${t.duration_minutes} 分</span>
              <span class="meta-item">👥 ${t.min_capacity}–${t.max_capacity} 人</span>
              <span class="meta-item">🔁 ${RECURRENCE_LABEL[t.recurrence]}</span>
              <span class="meta-item">🗓 ${t.cycle_start_date} ~ ${t.cycle_end_date}</span>
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
          <td class="subtle">${fmtDate(r.sent_at)}</td>
          <td>${escapeHtml(r.email)}</td>
          <td><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td>${escapeHtml(r.channel)}</td>
          <td>${escapeHtml(r.subject)}</td>
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

  for (const k of ['name','description','min_capacity','max_capacity','day_of_week','start_time','duration_minutes','registration_deadline_hours','recurrence','cycle_start_date','cycle_end_date']) {
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
          <span class="badge badge-${s.status}">${SESSION_STATUS_LABEL[s.status]}</span>
        </summary>
        <div class="px-5 pb-4" data-session-id="${s.id}">
          <div class="subtle">載入中…</div>
        </div>
      </details>`).join('');

    c.querySelectorAll('details.session-row').forEach(det => {
      det.addEventListener('toggle', async () => {
        if (!det.open) return;
        const inner = det.querySelector('[data-session-id]');
        if (inner.dataset.loaded === '1') return;
        const sid = Number(inner.dataset.sessionId);
        const list = await api(`/api/admin/sessions/${sid}/registrations`);
        if (!list.length) { inner.innerHTML = '<div class="subtle py-2">尚無人報名</div>'; inner.dataset.loaded = '1'; return; }
        inner.innerHTML = list.map(r => `
          <div class="reg-row">
            <div>
              <div class="font-medium">${escapeHtml(r.user_name)}</div>
              <div class="subtle text-xs">${escapeHtml(r.email)}</div>
            </div>
            <div class="flex items-center gap-2">
              <span class="badge badge-${r.status}">${REG_STATUS_LABEL[r.status]}</span>
              ${r.position ? `<span class="subtle text-xs">#${r.position}</span>` : ''}
            </div>
          </div>`).join('');
        inner.dataset.loaded = '1';
      });
    });
  } catch (e) {
    c.innerHTML = `<div class="text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('close-drawer').addEventListener('click', () => document.getElementById('drawer').style.display = 'none');

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

async function loadUsers() {
  const el = document.getElementById('users-table');
  const note = document.getElementById('users-note');
  const canEdit = user.role === 'owner';
  note.textContent = canEdit
    ? '你是擁有者 — 可指派其他帳號為管理者'
    : '僅擁有者可變更角色';

  try {
    const rows = await api('/api/admin/users');
    if (!rows.length) { el.innerHTML = '<div class="p-6 subtle text-center">無會員</div>'; return; }

    el.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th style="width:60px;">ID</th>
          <th>姓名</th>
          <th>Email</th>
          <th>登入方式</th>
          <th>角色</th>
          <th style="width:80px;">PT 點</th>
          <th style="width:80px;">團體 點</th>
          <th style="width:140px;">點數動作</th>
          <th>加入時間</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => renderUserRow(r, canEdit)).join('')}
        </tbody>
      </table>`;

    if (canEdit) {
      el.querySelectorAll('select.role-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
          const id = Number(sel.dataset.id);
          const newRole = sel.value;
          try {
            await api(`/api/admin/users/${id}/role`, { method: 'PATCH', body: { role: newRole } });
            toast(`已更新：${escapeHtml(sel.dataset.name)} → ${ROLE_LABEL[newRole]}`, 'success');
            loadUsers();
          } catch (err) {
            const msgs = {
              cannot_change_own_role: '不能變更自己的角色',
              last_owner: '不能降級最後一位擁有者',
              invalid_role: '無效的角色',
            };
            toast(msgs[err.data?.error] || `失敗：${err.message}`, 'error');
            sel.value = sel.dataset.original;
          }
        });
      });
    }
    el.querySelectorAll('button.grant-btn').forEach(btn => {
      btn.addEventListener('click', () => openGrantModal(Number(btn.dataset.id), btn.dataset.name));
    });
    el.querySelectorAll('button.history-btn').forEach(btn => {
      btn.addEventListener('click', () => openHistoryModal(Number(btn.dataset.id), btn.dataset.name));
    });
  } catch (e) {
    el.innerHTML = `<div class="p-6 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

function renderUserRow(r, canEdit) {
  const isSelf = r.id === user.id;
  const loginBadge = r.has_google
    ? '<span class="badge badge-confirmed" style="font-size:11px;">Google</span>'
    : '<span class="badge badge-completed" style="font-size:11px;">Email</span>';

  // Edit controls: owner can change others' roles, but not own
  const roleCell = canEdit && !isSelf
    ? `<select class="role-select form-select" style="padding:4px 8px;font-size:13px;" data-id="${r.id}" data-name="${escapeHtml(r.name)}" data-original="${r.role}">
         <option value="user" ${r.role==='user'?'selected':''}>會員</option>
         <option value="admin" ${r.role==='admin'?'selected':''}>管理者</option>
         <option value="owner" ${r.role==='owner'?'selected':''}>擁有者</option>
       </select>`
    : `<span class="badge badge-${ROLE_BADGE[r.role] || 'open'}">${ROLE_LABEL[r.role] || escapeHtml(r.role)}</span>${isSelf ? ' <span class="subtle text-xs">(你)</span>' : ''}`;

  return `
    <tr>
      <td class="subtle">#${r.id}</td>
      <td><span class="font-medium">${escapeHtml(r.name)}</span></td>
      <td class="subtle">${escapeHtml(r.email)}</td>
      <td>${loginBadge}</td>
      <td>${roleCell}</td>
      <td>${r.one_on_one_balance ?? 0}</td>
      <td>${r.group_balance ?? 0}</td>
      <td>
        <button class="btn btn-ghost btn-sm grant-btn" data-id="${r.id}" data-name="${escapeHtml(r.name)}">加點</button>
        <button class="btn btn-ghost btn-sm history-btn" data-id="${r.id}" data-name="${escapeHtml(r.name)}">歷史</button>
      </td>
      <td class="subtle">${fmtDate(r.created_at)}</td>
    </tr>`;
}

// --- Categories ---
let categoriesCache = [];

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
              <td class="subtle">#${c.sort_order}</td>
              <td><span class="font-medium">${escapeHtml(c.name)}</span></td>
              <td class="subtle">${escapeHtml(c.description || '—')}</td>
              <td>
                <button class="btn btn-ghost btn-sm cat-edit" data-id="${c.id}">編輯</button>
                <button class="btn btn-danger btn-sm cat-del" data-id="${c.id}">刪除</button>
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
  const users = await api('/api/admin/users');
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
    if (!confirm('確定降為一般用戶？歷史預約會保留，但未來不會出現在會員端')) return;
    await api(`/api/admin/coaches/${b.dataset.id}`, { method: 'DELETE' });
    loadCoachMgmt();
  }));

  const sel = document.getElementById('user-to-promote');
  sel.innerHTML = users
    .filter(u => u.role === 'user')
    .map(u => `<option value="${u.id}">${escapeHtml(u.name)}（${escapeHtml(u.email)}）</option>`)
    .join('');
}

document.getElementById('promote-coach-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = Number(new FormData(e.target).get('user_id'));
  try {
    await api('/api/admin/coaches', { method: 'POST', body: { user_id: userId } });
    toast('已升為教練（待設定資料後啟用）');
    loadCoachMgmt();
  } catch (err) { toast(`錯誤：${err.message}`, 'error'); }
});

// --- Pending bank-transfer orders ---
async function loadPendingOrders() {
  const container = document.getElementById('pending-orders-list');
  if (!container) return;
  container.innerHTML = '<div class="subtle p-4">載入中…</div>';
  try {
    const orders = await api('/api/admin/group-orders');
    if (!orders.length) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">✅</span>
          <p>目前沒有待核對的匯款</p>
        </div>`;
      return;
    }
    container.innerHTML = orders.map(o => {
      const sessionRows = o.sessions.length
        ? o.sessions.map(s => `<li class="subtle text-xs">${escapeHtml(s.course_name)} @ ${escapeHtml(s.start_at)}</li>`).join('')
        : '<li class="subtle text-xs">（無場次）</li>';
      return `
        <article class="card">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex-1 min-w-[220px]">
              <div class="flex items-center gap-2 mb-1">
                <h3 class="card-title">${escapeHtml(o.customer_name)}</h3>
                <span class="badge badge-waitlisted">待核對</span>
              </div>
              <div class="meta mb-2">
                <span class="meta-item">📞 ${escapeHtml(o.customer_phone)}</span>
                <span class="meta-item">💰 NT$${Number(o.total_amount).toLocaleString()}</span>
                <span class="meta-item">⏰ 到期 ${escapeHtml(o.expires_at)}</span>
              </div>
              <ul class="list-disc list-inside space-y-0.5">${sessionRows}</ul>
            </div>
            <div class="flex flex-col gap-2 min-w-[110px]">
              <button data-id="${o.id}" class="confirm-order-btn btn btn-primary btn-sm">已收款</button>
              <button data-id="${o.id}" class="cancel-order-btn btn btn-danger btn-sm">取消訂單</button>
            </div>
          </div>
        </article>`;
    }).join('');

    container.querySelectorAll('.confirm-order-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`確認已收到「${btn.closest('article').querySelector('.card-title').textContent}」的匯款？`)) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/group-orders/${btn.dataset.id}/confirm`, { method: 'POST' });
          toast('已確認收款，訂單完成', 'success');
          loadPendingOrders();
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
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-red-500">${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('btn-reload-orders')?.addEventListener('click', loadPendingOrders);

loadCategories();
loadTemplates();
loadUsers();
loadNotifs();
loadCoachMgmt();
loadBackupSummary();
bindBackupHandlers();
loadPendingOrders();

function openGrantModal(userId, userName) {
  const dlg = document.getElementById('grant-modal');
  document.getElementById('grant-target-name').textContent = userName;
  const form = document.getElementById('grant-form');
  form.reset();
  dlg.dataset.userId = String(userId);
  dlg.showModal();
}

document.getElementById('grant-cancel').addEventListener('click', () => {
  document.getElementById('grant-modal').close();
});

document.getElementById('grant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dlg = document.getElementById('grant-modal');
  const userId = Number(dlg.dataset.userId);
  const fd = new FormData(e.target);
  try {
    await api(`/api/admin/users/${userId}/points/grant`, {
      method: 'POST',
      body: {
        pool: fd.get('pool'),
        amount: Number(fd.get('amount')),
        note: fd.get('note'),
      },
    });
    toast('加點成功', 'success');
    dlg.close();
    loadUsers();
  } catch (err) {
    const map = {
      insufficient_points: '結果餘額會 < 0，無法執行',
      invalid_amount: '金額不可為 0 或非整數',
      missing_note: '備註必填',
      invalid_pool: '池子設定錯誤',
    };
    toast(map[err.data?.error] || `加點失敗：${err.message}`, 'error');
  }
});

async function openHistoryModal(userId, userName) {
  const dlg = document.getElementById('history-modal');
  document.getElementById('history-target-name').textContent = userName;
  dlg.dataset.userId = String(userId);
  await loadHistory(userId, '');
  dlg.showModal();
}

document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-modal').close();
});

document.getElementById('history-pool-filter').addEventListener('change', async (e) => {
  const userId = Number(document.getElementById('history-modal').dataset.userId);
  await loadHistory(userId, e.target.value);
});

async function loadHistory(userId, pool) {
  const list = document.getElementById('history-list');
  list.innerHTML = '載入中...';
  const qs = pool ? `?pool=${pool}&limit=100` : '?limit=100';
  try {
    const rows = await api(`/api/admin/users/${userId}/points/transactions${qs}`);
    if (!rows.length) { list.innerHTML = '<div class="subtle">無紀錄</div>'; return; }
    list.innerHTML = rows.map(r => {
      const sign = r.amount > 0 ? `+${r.amount}` : String(r.amount);
      const color = r.amount > 0 ? 'color:#15803d' : 'color:#b91c1c';
      return `<div style="padding:4px 0; border-bottom:1px solid #f0f0f0;">
        <span style="color:#666;">${r.created_at}</span>
        &nbsp;<span style="${color}; font-weight:600;">${sign}</span>
        &nbsp;<span style="color:#666;">[${r.pool}]</span>
        &nbsp;<span style="color:#888;">${r.source}</span>
        &nbsp;${escapeHtml(r.note)}
        &nbsp;<span style="color:#888;">by ${escapeHtml(r.actor_name)}</span>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:red;">載入失敗：${escapeHtml(err.message)}</div>`;
  }
}
