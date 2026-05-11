import { api, fmtDate, toast } from './app.js';

async function load() {
  const list = await api('/api/my/bookings');
  const wrap = document.getElementById('list');
  wrap.innerHTML = '';
  if (list.length === 0) {
    wrap.innerHTML = '<p class="text-slate-500">還沒有預約。<a class="text-sky-600" href="/coaches.html">立刻預約 →</a></p>';
    return;
  }
  for (const b of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const cancelled = b.status === 'cancelled';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold">${b.coach_display_name}</div>
          <div class="text-sm text-slate-600">${fmtDate(b.start_at)}（60 分鐘）</div>
          ${b.note ? `<div class="text-sm text-slate-500 mt-1">備註：${escapeHtml(b.note)}</div>` : ''}
          ${cancelled ? `<div class="text-sm text-red-500 mt-1">已取消${b.cancel_reason ? `（原因：${escapeHtml(b.cancel_reason)}）` : ''}</div>` : ''}
        </div>
        ${!cancelled && new Date(b.start_at) > new Date() ? `<button data-id="${b.id}" class="btn-secondary text-sm cancel-btn">取消</button>` : ''}
      </div>
    `;
    wrap.appendChild(card);
  }
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定要取消預約？')) return;
      try {
        await api(`/api/bookings/${btn.dataset.id}`, { method: 'DELETE' });
        toast('已取消');
        load();
      } catch (e) {
        toast(`取消失敗：${e.message}`, 'error');
      }
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

await load();
document.body.style.visibility = 'visible';
