import { api, toast, fmtDate, dow, bootAuth } from '/app.js';

const user = await bootAuth({ requireAdmin: true });
if (!user) { /* redirected */ }

const RECURRENCE_LABEL = { monthly: '每月', bimonthly: '每兩個月', quarterly: '每季', semiannual: '每半年' };
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
          </div>
        </div>
      </article>
    `).join('');
    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', () => openEdit(Number(b.dataset.id))));
    container.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => openDrawer(Number(b.dataset.id))));
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

loadTemplates();
loadNotifs();
