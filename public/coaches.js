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

// ── 工具函式 ──────────────────────────────────────────────────────────────────

/** 取中文字符串第一個字（正確處理多位元組）*/
function firstChar(name) {
  if (!name) return '?';
  return Array.from(name)[0];
}

/** 將 ISO datetime 格式化為 miniSlot 顯示用的日期行（如「6/2 二」）與時間行（如「10:00」）*/
function fmtMiniSlot(iso) {
  const d = new Date(iso);
  const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
  const md = `${d.getMonth() + 1}/${d.getDate()} ${DOW_SHORT[d.getDay()]}`;
  const tm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { md, tm };
}

/** 將 ISO datetime 格式化為時間字串（如「10:00」）*/
function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 將 ISO datetime 取出 YYYY-MM-DD 鍵值（本地時區）*/
function isoToDateKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 產生方向A 卡片頭像 HTML */
function avatarHtml(coach, size = 'card') {
  // size: 'card'（62px）| 'detail'（54px）
  const cls = size === 'detail' ? 'detail-av' : 'ccard-avatar';
  const fbCls = size === 'detail' ? 'detail-av-fallback' : 'ccard-avatar-fallback';
  if (coach.avatar_path) {
    return `<div class="${cls}"><img src="/avatars/${escapeHtml(coach.avatar_path)}" alt=""></div>`;
  }
  return `<div class="${cls}"><span class="${fbCls}">${escapeHtml(firstChar(coach.display_name))}</span></div>`;
}

/** 將 specialty 字串切成標籤陣列（以「、，,／/」或空白分割）*/
function specialtyTags(specialty) {
  if (!specialty) return [];
  // 以全形逗號、半形逗號、頓號、斜線、全形斜線、空白切分
  const parts = specialty.split(/[、，,／/\s]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [specialty.trim()].filter(Boolean);
}

/** 產生方向A 手風琴卡片 HTML */
function cardHtml(coach, { expanded = false } = {}) {
  const tags = specialtyTags(coach.specialty)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join('');

  return `
    <div class="ccard${expanded ? ' expanded' : ''}"
         role="button"
         tabindex="0"
         data-coach-id="${coach.id}"
         aria-expanded="${expanded ? 'true' : 'false'}">
      ${avatarHtml(coach, 'card')}
      <div class="ccard-body">
        <div class="ccard-name">${escapeHtml(coach.display_name)}</div>
        ${tags ? `<div class="ccard-tags">${tags}</div>` : ''}
      </div>
      <div class="ccard-go" aria-hidden="true">›</div>
    </div>
  `;
}

/** 展開面板骨架：bio + 載入中的 slot-area + CTA */
function expandSkeletonHtml(coach) {
  return `
    ${coach.bio ? `<div class="bioA">${escapeHtml(coach.bio)}</div>` : ''}
    <div class="slotlabel">最近可預約</div>
    <div class="slot-area" data-coach-id="${coach.id}">
      <div class="slot-empty">載入中…</div>
    </div>
    <button type="button" class="ctaA" data-coach-id="${coach.id}">預約 ${escapeHtml(coach.display_name)}</button>
  `;
}

/** 渲染展開面板（設定 class + innerHTML + 綁定 CTA）*/
function renderExpand(targetEl, coach) {
  targetEl.className = 'ccard-expand';
  targetEl.innerHTML = expandSkeletonHtml(coach);
  // CTA 點擊 → 前往詳細頁（openCoach）
  const cta = targetEl.querySelector('.ctaA');
  cta.addEventListener('click', () => openCoach(coach.id));
}

/** 將可預約 slots 渲染成橫向 miniSlot 卡片（前 3 個）+ 「看更多」*/
function renderSlotsInto(slotArea, slots, coachId) {
  if (slots.length === 0) {
    slotArea.innerHTML = '<div class="slot-empty">目前無可預約時段</div>';
    return;
  }

  // 前 3 個 miniSlot
  const miniCards = slots.slice(0, 3).map((s) => {
    const { md, tm } = fmtMiniSlot(s);
    return `
      <div class="miniSlot" role="button" tabindex="0"
           data-slot="${escapeHtml(s)}" data-coach-id="${coachId}">
        <div class="md">${escapeHtml(md)}</div>
        <div class="tm">${escapeHtml(tm)}</div>
      </div>
    `;
  }).join('');

  // 「看更多 ›」假卡（點擊 → openCoach）
  const moreCard = `
    <div class="miniSlot-more" role="button" tabindex="0" data-coach-id="${coachId}">看更多 ›</div>
  `;

  slotArea.innerHTML = `<div class="miniSlots">${miniCards}${moreCard}</div>`;

  // miniSlot 點擊 → 直接開 modal
  slotArea.querySelectorAll('.miniSlot[data-slot]').forEach((el) => {
    const trigger = () => {
      const coach = allCoachesById.get(Number(el.dataset.coachId));
      if (coach) openBookingModal(coach, el.dataset.slot);
    };
    el.addEventListener('click', trigger);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
    });
  });

  // 「看更多」點擊 → openCoach
  const moreEl = slotArea.querySelector('.miniSlot-more');
  const moreTrigger = () => openCoach(coachId);
  moreEl.addEventListener('click', moreTrigger);
  moreEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); moreTrigger(); }
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

  // 詳細頁教練標頭：頭像（圓角方形）+ 名字 + 專長標籤
  const tags = specialtyTags(currentCoach.specialty)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join('');
  det.innerHTML = `
    <div class="detail-head">
      ${avatarHtml(currentCoach, 'detail')}
      <div>
        <div class="detail-name">${escapeHtml(currentCoach.display_name)}</div>
        <div class="detail-spec">${tags || escapeHtml(currentCoach.specialty || '')}</div>
      </div>
    </div>
    ${currentCoach.bio ? `<p class="text-sm" style="color:var(--ink-soft);line-height:1.6;white-space:pre-line;margin-bottom:8px">${escapeHtml(currentCoach.bio)}</p>` : ''}
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

// ── 日期選擇狀態（詳細頁）────────────────────────────────────────────────────
let selectedDateKey = null;   // 目前選中的日期鍵值（YYYY-MM-DD）
let weekSlotsByDate = {};     // { 'YYYY-MM-DD': [iso, ...] }

/** 依日期鍵值渲染時段卡 grid */
function renderTimegrid(dateKey) {
  selectedDateKey = dateKey;
  const grid = $('slot-grid');
  const dayHead = $('slot-day-head');
  grid.innerHTML = '';

  const slots = weekSlotsByDate[dateKey] || [];

  // 更新日期標頭
  if (dateKey && slots.length >= 0) {
    const d = new Date(dateKey + 'T00:00:00');
    const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
    dayHead.style.display = 'flex';
    dayHead.innerHTML = `${d.getMonth() + 1}/${d.getDate()} 週${DOW_SHORT[d.getDay()]}<small>· ${slots.length} 個時段</small>`;
  } else {
    dayHead.style.display = 'none';
  }

  if (slots.length === 0) {
    grid.innerHTML = '<div class="timegrid-empty">此日無可預約時段</div>';
    return;
  }

  for (const s of slots) {
    const el = document.createElement('div');
    el.className = 'timeslot';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.dataset.slot = s;
    el.innerHTML = `<div class="t-main">${escapeHtml(fmtTime(s))}</div><div class="t-sub">60 分鐘</div>`;
    // 點擊時段卡 → 直接開 modal（不停留 sel 狀態，modal 開啟即有 UI 回饋）
    const trigger = () => openBookingModal(currentCoach, s);
    el.addEventListener('click', trigger);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trigger(); }
    });
    grid.appendChild(el);
  }
}

/** 渲染日期 rail，並預選第一個有 slot 的日期 */
function renderDayRail(from, to, allSlots) {
  const rail = $('day-rail');
  rail.innerHTML = '';

  // 建立日期 → slots 的 map
  weekSlotsByDate = {};
  for (const s of allSlots) {
    const key = isoToDateKey(s);
    if (!weekSlotsByDate[key]) weekSlotsByDate[key] = [];
    weekSlotsByDate[key].push(s);
  }

  // 由 from 到 to 逐日建立 daypill
  const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const startD = new Date(fy, fm - 1, fd);
  const endD = new Date(ty, tm - 1, td);

  // 找第一個有 slot 的日期，預設選它
  let firstWithSlot = null;
  const pills = [];

  for (let cur = new Date(startD); cur <= endD; cur.setDate(cur.getDate() + 1)) {
    const yyyy = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const hasSlot = !!(weekSlotsByDate[key] && weekSlotsByDate[key].length > 0);
    if (hasSlot && !firstWithSlot) firstWithSlot = key;

    const pill = document.createElement('div');
    pill.className = 'daypill' + (hasSlot ? '' : ' empty');
    pill.dataset.dateKey = key;
    pill.innerHTML = `
      <div class="dow">${DOW_SHORT[cur.getDay()]}</div>
      <div class="dnum">${cur.getDate()}</div>
      <div class="ddot"></div>
    `;

    if (hasSlot) {
      // 可點擊的 daypill
      pill.setAttribute('role', 'button');
      pill.setAttribute('tabindex', '0');
      const selectDay = (k) => {
        // 取消其他 sel
        rail.querySelectorAll('.daypill.sel').forEach((p) => p.classList.remove('sel'));
        pill.classList.add('sel');
        renderTimegrid(k);
      };
      pill.addEventListener('click', () => selectDay(key));
      pill.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectDay(key); }
      });
    }

    rail.appendChild(pill);
    pills.push({ key, pill, hasSlot });
  }

  // 預選第一個有 slot 的日期
  if (firstWithSlot) {
    const target = pills.find((p) => p.key === firstWithSlot);
    if (target) target.pill.classList.add('sel');
    renderTimegrid(firstWithSlot);
  } else {
    // 全無時段
    $('slot-day-head').style.display = 'none';
    $('slot-grid').innerHTML = '<div class="timegrid-empty">本週沒有可預約時段</div>';
  }
}

async function loadSlots() {
  const { from, to } = weekRange(weekOffset);
  $('week-label').textContent = `${from} ~ ${to}`;

  // 清空舊內容
  const rail = $('day-rail');
  const grid = $('slot-grid');
  const dayHead = $('slot-day-head');
  rail.innerHTML = '';
  grid.innerHTML = '';
  dayHead.style.display = 'none';

  const slots = await api(`/api/coaches/${currentCoach.id}/availability?from=${from}&to=${to}`);

  // 渲染日期 rail（含 timegrid）
  renderDayRail(from, to, slots);
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
      const min = err.data?.detail?.min_amount;
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
  // 從詳細頁 timegrid 移除已被預約的時段卡（.timeslot[data-slot]）
  const grid = $('slot-grid');
  if (grid) {
    grid.querySelectorAll('[data-slot]').forEach((el) => {
      if (el.dataset.slot === slotIso) el.remove();
    });
  }
  // 同步從 weekSlotsByDate 快取移除，避免重新選日後仍出現
  if (slotIso && weekSlotsByDate) {
    const key = isoToDateKey(slotIso);
    if (weekSlotsByDate[key]) {
      weekSlotsByDate[key] = weekSlotsByDate[key].filter((s) => s !== slotIso);
      // 若移除後此日無時段，更新 daypill 為 .empty
      if (weekSlotsByDate[key].length === 0) {
        const rail = $('day-rail');
        if (rail) {
          const pill = rail.querySelector(`.daypill[data-date-key="${key}"]`);
          if (pill) pill.classList.add('empty');
        }
      }
    }
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
