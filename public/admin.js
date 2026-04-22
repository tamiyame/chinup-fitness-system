import { api, toast, fmtDate, dow, bootAuth } from '/app.js';

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
              <h3 class="card-title">${t.name}</h3>
              <span class="badge badge-${t.status === 'published' ? 'confirmed' : 'completed'}">${t.status === 'published' ? '已發布' : t.status}</span>
            </div>
            <p class="card-desc">${t.description || ''}</p>
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
          <td>${r.email}</td>
          <td><span class="badge badge-${typeBadge(r.type)}">${typeLabel(r.type)}</span></td>
          <td>${r.channel}</td>
          <td>${r.subject}</td>
        </tr>`).join('') + '</tbody></table>';
  } catch (e) {
    document.getElementById('notifs').innerHTML = `<div class="p-6 text-red-500">${e.message}</div>`;
  }
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
              <div class="font-medium">${r.user_name}</div>
              <div class="subtle text-xs">${r.email}</div>
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
    c.innerHTML = `<div class="text-red-500">${e.message}</div>`;
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
            toast(`已更新：${sel.dataset.name} → ${ROLE_LABEL[newRole]}`, 'success');
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
  } catch (e) {
    el.innerHTML = `<div class="p-6 text-red-500">${e.message}</div>`;
  }
}

function renderUserRow(r, canEdit) {
  const isSelf = r.id === user.id;
  const loginBadge = r.has_google
    ? '<span class="badge badge-confirmed" style="font-size:11px;">Google</span>'
    : '<span class="badge badge-completed" style="font-size:11px;">Email</span>';

  // Edit controls: owner can change others' roles, but not own
  const roleCell = canEdit && !isSelf
    ? `<select class="role-select form-select" style="padding:4px 8px;font-size:13px;" data-id="${r.id}" data-name="${r.name}" data-original="${r.role}">
         <option value="user" ${r.role==='user'?'selected':''}>會員</option>
         <option value="admin" ${r.role==='admin'?'selected':''}>管理者</option>
         <option value="owner" ${r.role==='owner'?'selected':''}>擁有者</option>
       </select>`
    : `<span class="badge badge-${ROLE_BADGE[r.role] || 'open'}">${ROLE_LABEL[r.role] || r.role}</span>${isSelf ? ' <span class="subtle text-xs">(你)</span>' : ''}`;

  return `
    <tr>
      <td class="subtle">#${r.id}</td>
      <td><span class="font-medium">${r.name}</span></td>
      <td class="subtle">${r.email}</td>
      <td>${loginBadge}</td>
      <td>${roleCell}</td>
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
    el.innerHTML = `<div class="p-6 text-red-500">${e.message}</div>`;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

loadCategories();
loadTemplates();
loadUsers();
loadNotifs();
