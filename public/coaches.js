import { api, fmtDate, dow, toast } from './app.js';

const $ = (id) => document.getElementById(id);
const views = { list: $('view-list'), detail: $('view-detail'), confirm: $('view-confirm') };
function show(name) {
  for (const v of Object.values(views)) v.classList.add('hidden');
  views[name].classList.remove('hidden');
}

let currentCoach = null;
let currentSlot = null;
let weekOffset = 0;

async function loadCoachList() {
  const coaches = await api('/api/coaches');
  const wrap = $('coach-list');
  wrap.innerHTML = '';
  if (coaches.length === 0) {
    wrap.innerHTML = '<p class="text-slate-500">目前沒有可預約的教練</p>';
    return;
  }
  for (const c of coaches) {
    const card = document.createElement('button');
    card.className = 'card flex items-center gap-3 text-left hover:shadow-md transition';
    card.innerHTML = `
      <div class="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center overflow-hidden flex-shrink-0">
        ${c.avatar_path ? `<img src="/avatars/${c.avatar_path}" class="w-full h-full object-cover" alt="">` : '<span class="text-slate-400">👤</span>'}
      </div>
      <div class="min-w-0">
        <div class="font-semibold">${escapeHtml(c.display_name)}</div>
        <div class="text-sm text-slate-500 truncate">${escapeHtml(c.specialty || '')}</div>
      </div>
    `;
    card.addEventListener('click', () => openCoach(c.id));
    wrap.appendChild(card);
  }
}

async function openCoach(id) {
  weekOffset = 0;
  currentCoach = await api(`/api/coaches/${id}`);
  const det = $('coach-detail');
  det.innerHTML = `
    <div class="flex items-center gap-4 mb-3">
      <div class="w-16 h-16 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
        ${currentCoach.avatar_path ? `<img src="/avatars/${currentCoach.avatar_path}" class="w-full h-full object-cover">` : ''}
      </div>
      <div>
        <h1 class="text-xl font-bold">${escapeHtml(currentCoach.display_name)}</h1>
        <div class="text-sm text-slate-500">${escapeHtml(currentCoach.specialty || '')}</div>
      </div>
    </div>
    ${currentCoach.bio ? `<p class="text-sm text-slate-700 whitespace-pre-line">${escapeHtml(currentCoach.bio)}</p>` : ''}
  `;
  show('detail');
  renderSlotControls();
  await loadSlots();
}

function renderSlotControls() {
  const ctrls = $('slot-controls');
  ctrls.innerHTML = `
    <button class="btn-secondary" ${weekOffset <= 0 ? 'disabled' : ''} id="prev-week">← 上週</button>
    <span id="week-label" class="font-medium"></span>
    <button class="btn-secondary" id="next-week">下週 →</button>
  `;
  $('prev-week').addEventListener('click', () => { if (weekOffset > 0) { weekOffset--; loadSlots(); } });
  $('next-week').addEventListener('click', () => { weekOffset++; loadSlots(); });
}

function weekRange(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const f = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: f(start), to: f(end) };
}

async function loadSlots() {
  const { from, to } = weekRange(weekOffset);
  $('week-label').textContent = `${from} ~ ${to}`;
  const slots = await api(`/api/coaches/${currentCoach.id}/availability?from=${from}&to=${to}`);
  const grid = $('slot-grid');
  grid.innerHTML = '';
  if (slots.length === 0) {
    grid.innerHTML = '<p class="col-span-full text-slate-500 text-sm">本週沒有可預約時段</p>';
    return;
  }
  for (const s of slots) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary text-sm';
    const d = new Date(s);
    btn.textContent = `${d.getMonth() + 1}/${d.getDate()}（${dow(d.getDay())[1]}）${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    btn.addEventListener('click', () => openConfirm(s));
    grid.appendChild(btn);
  }
}

function openConfirm(slotStr) {
  currentSlot = slotStr;
  const d = new Date(slotStr);
  $('confirm-summary').innerHTML = `
    <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${escapeHtml(currentCoach.display_name)}</strong></div>
    <div><span class="text-slate-500">時間</span><br><strong>${fmtDate(slotStr)}（60 分鐘）</strong></div>
  `;
  $('note').value = '';
  show('confirm');
}

$('back-to-list').addEventListener('click', () => show('list'));
$('back-to-detail').addEventListener('click', () => show('detail'));

$('confirm-btn').addEventListener('click', async () => {
  try {
    const note = $('note').value.trim();
    const result = await api('/api/bookings', {
      method: 'POST',
      body: { coach_id: currentCoach.id, start_at: currentSlot, note: note || null },
    });
    toast('預約成功！', 'success');
    setTimeout(() => location.href = '/my-bookings.html', 700);
  } catch (e) {
    toast(e.data?.error === 'slot_taken' ? '此時段剛被預約走了' : `預約失敗：${e.message}`, 'error');
  }
});

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

await loadCoachList();
document.body.style.visibility = 'visible';
