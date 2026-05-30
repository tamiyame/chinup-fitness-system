import { api, fmtDate, dow, toast, bootPublic, escapeHtml } from './app.js';

await bootPublic();

const $ = (id) => document.getElementById(id);
const views = { list: $('view-list'), detail: $('view-detail') };
function show(name) {
  for (const v of Object.values(views)) v.classList.add('hidden');
  views[name].classList.remove('hidden');
}

let currentCoach = null;
let weekOffset = 0;

// ── 1v1 price ────────────────────────────────────────────────────────────────
let oneOnOnePrice = null;
(async () => {
  try {
    const res = await api('/api/public/one-on-one-price');
    oneOnOnePrice = res.price;
  } catch (e) {
    // price display will be suppressed if load fails
  }
})();

// --- Coach-list accordion + slot cache -------------------------------------

// Only one card is expanded at a time. null = nothing expanded.
let currentlyExpandedId = null;

// In-memory cache: coachId -> Array of ISO datetime strings (slot starts).
// Cleared naturally by a full page reload; no TTL.
const slotCacheByCoach = new Map();

function firstChar(name) {
  if (!name) return '?';
  // Array.from handles multi-byte / surrogate-pair characters correctly.
  return Array.from(name)[0];
}

function fmtSlotChip(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${dow(d.getDay())} ${hh}:${min}`;
}

function avatarHtml(coach) {
  if (coach.avatar_path) {
    return `<img src="/avatars/${escapeHtml(coach.avatar_path)}" alt="">`;
  }
  return `<span class="ccard-avatar-fallback">${escapeHtml(firstChar(coach.display_name))}</span>`;
}

function cardHtml(coach, { expanded = false } = {}) {
  const classes = ['ccard'];
  if (expanded) classes.push('expanded');
  return `
    <div class="${classes.join(' ')}"
         role="button"
         tabindex="0"
         data-coach-id="${coach.id}"
         aria-expanded="${expanded ? 'true' : 'false'}">
      <div class="ccard-avatar">${avatarHtml(coach)}</div>
      <div class="ccard-body">
        <div class="ccard-name">${escapeHtml(coach.display_name)}</div>
        ${coach.specialty ? `<div class="ccard-spec">${escapeHtml(coach.specialty)}</div>` : ''}
      </div>
      <div class="ccard-chev" aria-hidden="true">▾</div>
    </div>
  `;
}

function expandSkeletonHtml(coach) {
  return `
    ${coach.bio ? `<div class="bio">${escapeHtml(coach.bio)}</div>` : ''}
    <div class="slot-label">最近可預約</div>
    <div class="slot-area" data-coach-id="${coach.id}">
      <div class="slot-empty">載入中…</div>
    </div>
    <button type="button" class="book-cta" data-coach-id="${coach.id}">預約${escapeHtml(coach.display_name)} →</button>
  `;
}

function renderExpand(targetEl, coach) {
  targetEl.className = 'ccard-expand';
  targetEl.innerHTML = expandSkeletonHtml(coach);
  const cta = targetEl.querySelector('.book-cta');
  cta.addEventListener('click', () => openCoach(coach.id));
}

function renderSlotsInto(slotArea, slots, coachId) {
  if (slots.length === 0) {
    slotArea.innerHTML = '<div class="slot-empty">目前無可預約時段</div>';
    return;
  }
  const first3 = slots.slice(0, 3)
    .map((s) => `<span class="slot-chip" role="button" tabindex="0" data-slot="${escapeHtml(s)}" data-coach-id="${coachId}">${escapeHtml(fmtSlotChip(s))}</span>`)
    .join('');
  slotArea.innerHTML = `
    <div class="slot-chips">
      ${first3}
      <span class="slot-chip slot-chip-more" role="button" tabindex="0" data-coach-id="${coachId}">看更多 →</span>
    </div>
  `;
  // Slot chips in accordion → open booking modal directly
  slotArea.querySelectorAll('.slot-chip[data-slot]').forEach((chip) => {
    const trigger = () => {
      const coach = allCoachesById.get(Number(chip.dataset.coachId));
      if (coach) openBookingModal(coach, chip.dataset.slot);
    };
    chip.addEventListener('click', trigger);
    chip.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
    });
  });
  const moreChip = slotArea.querySelector('.slot-chip-more');
  const trigger = () => openCoach(coachId);
  moreChip.addEventListener('click', trigger);
  moreChip.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
  });
}

async function ensureSlotsLoaded(coachId, slotAreaEl) {
  if (slotCacheByCoach.has(coachId)) {
    renderSlotsInto(slotAreaEl, slotCacheByCoach.get(coachId), coachId);
    return;
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 6 * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const f = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const from = f(start);
  const to = f(end);
  try {
    const slots = await api(`/api/coaches/${coachId}/availability?from=${from}&to=${to}`);
    slotCacheByCoach.set(coachId, slots);
    renderSlotsInto(slotAreaEl, slots, coachId);
  } catch (e) {
    slotAreaEl.innerHTML = '<div class="slot-empty">時段載入失敗</div>';
  }
}

// --- Accordion state ------------------------------------------------------

const allCoachesById = new Map();

function collapseCurrent() {
  if (currentlyExpandedId == null) return;
  document.querySelectorAll(`.ccard[data-coach-id="${currentlyExpandedId}"]`).forEach((cardEl) => {
    cardEl.classList.remove('expanded');
    cardEl.setAttribute('aria-expanded', 'false');
  });
  const expandEl = document.querySelector(`.ccard-expand[data-for-coach="${currentlyExpandedId}"]`);
  if (expandEl) expandEl.remove();
  currentlyExpandedId = null;
}

function expandCard(coachId) {
  const coach = allCoachesById.get(coachId);
  if (!coach) return;
  if (currentlyExpandedId === coachId) {
    collapseCurrent();
    return;
  }
  collapseCurrent();
  const cardEl = document.querySelector(`.ccard[data-coach-id="${coachId}"]`);
  if (!cardEl) return;
  cardEl.classList.add('expanded');
  cardEl.setAttribute('aria-expanded', 'true');
  const expandEl = document.createElement('div');
  expandEl.setAttribute('data-for-coach', String(coachId));
  cardEl.insertAdjacentElement('afterend', expandEl);
  renderExpand(expandEl, coach);
  currentlyExpandedId = coachId;
  ensureSlotsLoaded(coachId, expandEl.querySelector('.slot-area'));
}

function attachCardHandlers(rootEl) {
  rootEl.querySelectorAll('.ccard').forEach((cardEl) => {
    const coachId = Number(cardEl.dataset.coachId);
    const trigger = () => expandCard(coachId);
    cardEl.addEventListener('click', trigger);
    cardEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
    });
  });
}

// --- Full coach list ------------------------------------------------------

async function loadCoachList() {
  const coaches = await api('/api/coaches');
  const wrap = $('coach-list');
  wrap.innerHTML = '';

  for (const c of coaches) {
    allCoachesById.set(c.id, c);
    wrap.insertAdjacentHTML('beforeend', cardHtml(c));
  }
  attachCardHandlers(wrap);

  if (coaches.length === 0) {
    wrap.innerHTML = '<p class="text-slate-500 text-sm">目前沒有可預約的教練</p>';
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
    <button class="btn-secondary" id="prev-week">← 上週</button>
    <span id="week-label" class="font-medium"></span>
    <button class="btn-secondary" id="next-week">下週 →</button>
  `;
  $('prev-week').addEventListener('click', () => {
    if (weekOffset > 0) { weekOffset--; updatePrevDisabled(); loadSlots(); }
  });
  $('next-week').addEventListener('click', () => {
    weekOffset++; updatePrevDisabled(); loadSlots();
  });
  updatePrevDisabled();
}

function updatePrevDisabled() {
  const btn = document.getElementById('prev-week');
  if (btn) btn.disabled = weekOffset <= 0;
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
    btn.dataset.slot = s;  // so removeSlotFromGrid can drop it after a successful booking
    const d = new Date(s);
    btn.textContent = `${d.getMonth() + 1}/${d.getDate()}（${dow(d.getDay())[1]}）${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    btn.addEventListener('click', () => openBookingModal(currentCoach, s));
    grid.appendChild(btn);
  }
}

$('back-to-list').addEventListener('click', () => show('list'));

// --- Booking modal ---------------------------------------------------------

let modalCoach = null;
let modalSlot = null;
// Discount state: null or { code, discountAmount, finalTotal }
let modalAppliedDiscount = null;

function openBookingModal(coach, slotIso) {
  modalCoach = coach;
  modalSlot = slotIso;
  modalAppliedDiscount = null;

  $('modal-coach-name').textContent = coach.display_name;
  $('modal-slot-time').textContent = fmtDate(slotIso) + '（60 分鐘）';
  $('modal-name').value = '';
  $('modal-phone').value = '';
  $('modal-name-err').textContent = '';
  $('modal-phone-err').textContent = '';
  $('modal-general-err').textContent = '';
  $('modal-submit-btn').disabled = false;
  $('modal-submit-btn').textContent = '確認預約';

  // Reset discount fields
  $('modal-discount-code').value = '';
  $('modal-discount-msg').textContent = '';
  $('modal-discount-msg').classList.add('hidden');

  // Show single-session price
  const priceRow = $('modal-price-row');
  const priceLabel = $('modal-price-label');
  if (oneOnOnePrice != null) {
    priceLabel.textContent = `單堂 $${oneOnOnePrice.toLocaleString()}`;
    priceRow.classList.remove('hidden');
  } else {
    priceRow.classList.add('hidden');
  }

  $('booking-modal').classList.remove('hidden');
  $('modal-name').focus();
}

function closeBookingModal() {
  $('booking-modal').classList.add('hidden');
  modalCoach = null;
  modalSlot = null;
  modalAppliedDiscount = null;
}

$('modal-close-btn').addEventListener('click', closeBookingModal);
$('booking-modal').addEventListener('click', (ev) => {
  if (ev.target === $('booking-modal')) closeBookingModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeBookingModal();
});

// ── Discount apply handler ────────────────────────────────────────────────────
$('modal-apply-discount').addEventListener('click', async () => {
  const code = $('modal-discount-code').value.trim();
  const msgEl = $('modal-discount-msg');
  msgEl.classList.add('hidden');
  msgEl.textContent = '';
  modalAppliedDiscount = null;

  if (!code) {
    msgEl.textContent = '請輸入折扣碼';
    msgEl.style.color = '#b91c1c';
    msgEl.classList.remove('hidden');
    return;
  }

  const rawPhone = $('modal-phone').value.replace(/\D/g, '');
  if (!rawPhone) {
    msgEl.textContent = '請先填寫電話號碼再套用折扣碼';
    msgEl.style.color = '#b91c1c';
    msgEl.classList.remove('hidden');
    return;
  }

  const applyBtn = $('modal-apply-discount');
  applyBtn.disabled = true;
  applyBtn.textContent = '套用中…';

  try {
    const result = await api('/api/public/discounts/validate', {
      method: 'POST',
      body: { kind: 'one_on_one', code, phone: rawPhone },
    });
    modalAppliedDiscount = { code: code.toUpperCase(), discountAmount: result.discount_amount, finalTotal: result.final_total };
    msgEl.textContent = `折扣套用成功：折後現場應付 $${result.final_total.toLocaleString()}`;
    msgEl.style.color = '#15803d';
    msgEl.classList.remove('hidden');
  } catch (err) {
    modalAppliedDiscount = null;
    const errCode = err.data?.error;
    let msg;
    if (errCode === 'invalid_code') {
      msg = '折扣碼無效，請確認後重試';
    } else if (errCode === 'code_inactive') {
      msg = '此折扣碼目前已停用';
    } else if (errCode === 'code_expired') {
      msg = '此折扣碼已過期';
    } else if (errCode === 'code_not_started') {
      msg = '此折扣碼尚未開始使用';
    } else if (errCode === 'below_min_amount') {
      const min = err.data?.min_amount;
      msg = `訂單金額未達折扣碼最低消費 $${min != null ? min.toLocaleString() : ''}`;
    } else if (errCode === 'code_exhausted') {
      msg = '此折扣碼已達使用上限';
    } else if (errCode === 'per_phone_exhausted') {
      msg = '此折扣碼每人使用次數已達上限';
    } else {
      msg = `折扣碼套用失敗：${escapeHtml(err.message)}`;
    }
    msgEl.textContent = msg;
    msgEl.style.color = '#b91c1c';
    msgEl.classList.remove('hidden');
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = '套用';
  }
});

$('modal-submit-btn').addEventListener('click', async () => {
  const nameVal = $('modal-name').value.trim();
  const phoneRaw = $('modal-phone').value.trim();
  const phoneNormalized = phoneRaw.replace(/\D/g, '');

  // Clear previous errors
  $('modal-name-err').textContent = '';
  $('modal-phone-err').textContent = '';
  $('modal-general-err').textContent = '';

  // Client-side validation
  let hasErr = false;
  if (!nameVal) {
    $('modal-name-err').textContent = '請輸入姓名';
    hasErr = true;
  }
  if (!phoneNormalized) {
    $('modal-phone-err').textContent = '請輸入電話';
    hasErr = true;
  }
  if (hasErr) return;

  const btn = $('modal-submit-btn');
  btn.disabled = true;
  btn.textContent = '送出中…';

  try {
    const bookingBody = { coachId: modalCoach.id, startAt: modalSlot, name: nameVal, phone: phoneNormalized };
    if (modalAppliedDiscount) bookingBody.discountCode = modalAppliedDiscount.code;
    const result = await api('/api/public/bookings', {
      method: 'POST',
      body: bookingBody,
    });
    // Success
    closeBookingModal();
    showSuccessView(result);

    // Remove the booked slot from the detail grid if visible
    removeSlotFromGrid(modalSlot);
    // Invalidate accordion cache for this coach
    slotCacheByCoach.delete(modalCoach.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '確認預約';
    const errCode = e.data?.error;
    if (errCode === 'slot_taken') {
      $('modal-general-err').textContent = '此時段剛被預約走了，請選其他時段。';
      // Remove this slot from the grid so user doesn't try again
      removeSlotFromGrid(modalSlot);
      slotCacheByCoach.delete(modalCoach?.id);
    } else if (errCode === 'invalid_phone') {
      $('modal-phone-err').textContent = e.data?.detail || '電話格式不正確';
    } else if (errCode === 'missing_name') {
      $('modal-name-err').textContent = '請輸入姓名';
    } else if (errCode === 'missing_phone') {
      $('modal-phone-err').textContent = '請輸入電話';
    } else if (errCode === 'coach_not_found' || errCode === 'coach_inactive') {
      $('modal-general-err').textContent = '教練目前無法預約，請重新整理頁面。';
    } else {
      $('modal-general-err').textContent = `預約失敗：${e.message}`;
    }
  }
});

function removeSlotFromGrid(slotIso) {
  // Remove from the detail view grid
  const grid = $('slot-grid');
  if (grid) {
    grid.querySelectorAll('button').forEach((btn) => {
      // Check by slot ISO text match via data or by re-building the label
      if (btn.dataset.slot === slotIso) btn.remove();
    });
  }
}

// --- Success view ----------------------------------------------------------

function showSuccessView(bookingResult) {
  const successEl = $('view-success');
  const coachName = escapeHtml(modalCoach?.display_name ?? '');
  const slotTime = escapeHtml(fmtDate(modalSlot ?? bookingResult.startAt));

  let lineHtml = '';
  if (bookingResult.lineBindCode) {
    lineHtml = `
      <div class="card bg-green-50 border border-green-200 mt-4 p-4 text-sm">
        <p class="text-green-800">想收 LINE 通知？加官方帳號並貼這組碼：</p>
        <p class="text-xl font-bold text-green-700 my-2 tracking-widest">${escapeHtml(bookingResult.lineBindCode)}</p>
        <p class="text-green-600">（15 分鐘內有效）</p>
      </div>
    `;
  }

  let paymentHtml;
  if (bookingResult.discountAmount) {
    paymentHtml = `
      <div class="mt-3 text-sm text-slate-600">原價：$${escapeHtml(String(bookingResult.originalAmount))}</div>
      <div class="text-sm" style="color:#15803d;">折扣：−$${escapeHtml(String(bookingResult.discountAmount))}${bookingResult.discountCode ? ` (${escapeHtml(bookingResult.discountCode)})` : ''}</div>
      <div class="mt-1"><span class="text-slate-500 text-sm">折後現場應付（現場收費）</span><br>
        <strong style="font-size:20px;color:var(--brand-700, #0369a1);">$${escapeHtml(String(bookingResult.finalAmount))}</strong>
      </div>
    `;
  } else if (bookingResult.finalAmount != null) {
    paymentHtml = `
      <div class="mt-2"><span class="text-slate-500 text-sm">現場應付（現場收費）</span><br>
        <strong style="font-size:20px;color:var(--brand-700, #0369a1);">$${escapeHtml(String(bookingResult.finalAmount))}</strong>
      </div>
    `;
  } else {
    paymentHtml = '';
  }

  successEl.innerHTML = `
    <div class="text-center py-6">
      <div class="text-5xl mb-4">✅</div>
      <h1 class="page-title">預約成功！</h1>
      <div class="card mt-4 mb-2 text-left">
        <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${coachName}</strong></div>
        <div><span class="text-slate-500">時間</span><br><strong>${slotTime}</strong></div>
        ${paymentHtml}
      </div>
      ${lineHtml}
      <div class="mt-6 flex flex-col gap-3">
        <a href="/my-schedule" class="btn-primary text-center block">查我的預約</a>
        <a href="/" class="btn-secondary text-center block">回首頁</a>
      </div>
    </div>
  `;

  // Show success view (not in the views map — show manually)
  for (const v of Object.values(views)) v.classList.add('hidden');
  successEl.classList.remove('hidden');
}

await loadCoachList();
document.body.style.visibility = 'visible';
