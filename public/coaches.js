import { api, fmtDate, dow, toast, bootPublic, escapeHtml, getUser } from './app.js';

await bootPublic();

const $ = (id) => document.getElementById(id);
const views = { list: $('view-list'), detail: $('view-detail') };
function show(name) {
  for (const v of Object.values(views)) v.classList.add('hidden');
  views[name].classList.remove('hidden');
}

let currentCoach = null;
let weekOffset = 0;
const isAdmin = !!(getUser()?.is_admin);

// ── 1v1 price（1對1 / 1對2 兩種單堂價）─────────────────────────────────────────
let priceByType = { '1on1': null, '1on2': null };
(async () => {
  try {
    const res = await api('/api/public/one-on-one-price');
    priceByType = {
      '1on1': res.oneOnOnePrice ?? res.price ?? null,
      '1on2': res.oneOnTwoPrice ?? null,
    };
  } catch (e) {
    // price display will be suppressed if load fails
  }
})();

const SESSION_TYPE_LABELS = { '1on1': '1對1', '1on2': '1對2' };

// --- Coach-list accordion + slot cache -------------------------------------

// Only one card is expanded at a time. null = nothing expanded.
let currentlyExpandedId = null;

// In-memory cache: coachId -> 物件陣列 {start, remain}（start 為 ISO datetime 字串，remain 為剩餘名額）。
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
    const { md, tm } = fmtMiniSlot(s.start);
    return `
      <div class="miniSlot" role="button" tabindex="0"
           data-slot="${escapeHtml(s.start)}" data-remain="${s.remain}" data-coach-id="${coachId}">
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
      if (coach) openBookingModal(coach, { start: el.dataset.slot, remain: Number(el.dataset.remain) });
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
    if (isAdmin || weekOffset > 0) { weekOffset--; updatePrevDisabled(); loadSlots(); }
  });
  $('next-week').addEventListener('click', () => {
    weekOffset++; updatePrevDisabled(); loadSlots();
  });
  updatePrevDisabled();
}

function updatePrevDisabled() {
  const btn = document.getElementById('prev-week');
  if (btn) btn.disabled = !isAdmin && weekOffset <= 0;
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
let weekSlotsByDate = {};     // { 'YYYY-MM-DD': [{start, remain}, ...] }

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
    el.dataset.slot = s.start;
    el.dataset.remain = s.remain;
    if (s.past) el.classList.add('slot-past');
    const sub = s.past ? '補登 · 60 分鐘' : `60 分鐘${s.remain === 1 ? ' · 剩 1 名額' : ''}`;
    el.innerHTML = `<div class="t-main">${escapeHtml(fmtTime(s.start))}</div><div class="t-sub">${sub}</div>`;
    // 點擊時段卡 → 直接開 modal（不停留 sel 狀態，modal 開啟即有 UI 回饋）
    const trigger = () => openBookingModal(currentCoach, { start: s.start, remain: s.remain, past: !!s.past });
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

  // 建立日期 → slots 的 map（存 {start, remain} 物件）
  weekSlotsByDate = {};
  for (const s of allSlots) {
    const key = isoToDateKey(s.start);
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

  const qs = `from=${from}&to=${to}` + (isAdmin ? '&backfill=1' : '');
  const slots = await api(`/api/coaches/${currentCoach.id}/availability?${qs}`);

  // 渲染日期 rail（含 timegrid）
  renderDayRail(from, to, slots);
}

$('back-to-list').addEventListener('click', () => show('list'));

// --- Booking modal ---------------------------------------------------------

let modalCoach = null;
// modalSlot 存 { start, remain } 物件（start 為 ISO datetime 字串）
let modalSlot = null;
let modalBackfill = false;
// Discount state: null or { code, discountAmount, finalTotal }
let modalAppliedDiscount = null;
// '1on1' | '1on2'，預設 1對1
let modalSessionType = '1on1';
// 循環預約（員工限定）：previewed=true 才可送出；參數變更即失效需重新預覽
let recurringState = { previewed: false, okCount: 0 };

const SESSION_TYPE_ACTIVE = ['bg-sky-500', 'text-white', 'border-sky-500'];
const SESSION_TYPE_INACTIVE = ['bg-white', 'text-slate-700', 'border-slate-300', 'hover:border-sky-400'];

// 更新單堂價顯示（依目前選的課程型態）。價格載入失敗則隱藏整列。
function refreshModalPrice() {
  // 單堂價顯示在 1對1 / 1對2 按鈕下方（兩者並列可比價）
  const s1 = document.getElementById('price-1on1');
  const s2 = document.getElementById('price-1on2');
  if (s1) s1.textContent = priceByType['1on1'] != null ? `單堂 $${priceByType['1on1'].toLocaleString()}` : '';
  if (s2) s2.textContent = priceByType['1on2'] != null ? `單堂 $${priceByType['1on2'].toLocaleString()}` : '';

  const priceRow = $('modal-price-row');
  const priceLabel = $('modal-price-label');
  const msgEl = $('modal-discount-msg');
  const price = priceByType[modalSessionType];
  const recurring = typeof recurringEnabled === 'function' && recurringEnabled();
  const n = recurring ? (recurringState.previewed ? recurringState.okCount : (Number($('recurring-count').value) || 0)) : 1;

  // 總計列：只在循環模式顯示（單筆模式單堂價已在按鈕下方，折扣金額在訊息列）
  if (!recurring || price == null || n < 1) {
    priceRow.classList.add('hidden');
    // 折扣訊息同步回單筆語意
    if (modalAppliedDiscount) {
      msgEl.textContent = `折扣套用成功：折後現場應付 $${modalAppliedDiscount.finalTotal.toLocaleString()}`;
      msgEl.style.color = '#15803d';
      msgEl.classList.remove('hidden');
    }
    return;
  }

  const baseNote = recurringState.previewed ? `${n} 堂` : `${n} 堂，以預覽結果為準`;
  let total;
  if (modalAppliedDiscount) {
    // 折扣逐堂套用：限次數的碼只折得到「剩餘可用次數」堂，其餘原價（混合計算）
    const remaining = modalAppliedDiscount.remainingUses; // null = 不限次數
    const dCount = remaining == null ? n : Math.max(0, Math.min(n, remaining));
    total = modalAppliedDiscount.finalTotal * dCount + price * (n - dCount);
    const mixNote = dCount < n ? `＝${dCount} 堂折扣＋${n - dCount} 堂原價` : '';
    priceLabel.textContent = `折後預估總計 $${total.toLocaleString()}（${baseNote}${mixNote}）`;
    // 折扣訊息金額與預估總計同步
    msgEl.textContent = `折扣套用成功：折後預估總計 $${total.toLocaleString()}`;
    msgEl.style.color = '#15803d';
    msgEl.classList.remove('hidden');
  } else {
    total = price * n;
    priceLabel.textContent = `應付總計 $${total.toLocaleString()}（${baseNote}）`;
  }
  priceRow.classList.remove('hidden');
}

// 套用選取按鈕樣式（active / inactive）。
function refreshSessionTypeButtons() {
  for (const btn of document.querySelectorAll('#modal-session-type .session-type-btn')) {
    const active = btn.dataset.type === modalSessionType;
    btn.classList.remove(...SESSION_TYPE_ACTIVE, ...SESSION_TYPE_INACTIVE);
    btn.classList.add(...(active ? SESSION_TYPE_ACTIVE : SESSION_TYPE_INACTIVE));
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// 切換課程型態：更新價格、按鈕樣式，並清掉已套用的折扣（小計改變 → 折後金額失效）。
function setSessionType(type) {
  if (type !== '1on1' && type !== '1on2') return;
  // 名額守門：剩 1 名額的時段不可選 1對2
  if (type === '1on2' && !modalBackfill && modalSlot && modalSlot.remain < 2) {
    $('modal-general-err').textContent = '此時段僅剩 1 個名額，無法選擇 1對2，請改選其他時段。';
    return;
  }
  $('modal-general-err').textContent = '';
  modalSessionType = type;
  refreshSessionTypeButtons();
  refreshModalPrice();
  // 補登模式：金額欄預設帶入該型態標準單價（切換即更新）
  if (modalBackfill) {
    $('modal-backfill-amount').value = priceByType[modalSessionType] != null ? priceByType[modalSessionType] : '';
  }
  invalidateRecurringPreview(); // 型態影響名額判定（1對2 佔 2）→ 循環預覽需重跑
  // 型態改變 → 之前算出的折扣金額不再正確，需重新套用
  if (modalAppliedDiscount) {
    modalAppliedDiscount = null;
    const msgEl = $('modal-discount-msg');
    msgEl.textContent = '課程型態已變更，請重新套用折扣碼';
    msgEl.style.color = '#b45309';
    msgEl.classList.remove('hidden');
    refreshModalPrice();
  }
}

function openBookingModal(coach, slot) {
  modalCoach = coach;
  modalSlot = slot;
  modalAppliedDiscount = null;
  modalSessionType = '1on1';

  $('modal-coach-name').textContent = coach.display_name;
  $('modal-slot-time').textContent = fmtDate(slot.start) + '（60 分鐘）';
  $('modal-name').value = '';
  $('modal-phone').value = '';
  $('modal-email').value = '';
  $('modal-name-err').textContent = '';
  $('modal-phone-err').textContent = '';
  $('modal-email-err').textContent = '';
  $('modal-general-err').textContent = '';
  $('modal-submit-btn').disabled = false;
  $('modal-submit-btn').textContent = '確認預約';

  // Reset discount fields
  $('modal-discount-code').value = '';
  $('modal-discount-msg').textContent = '';
  $('modal-discount-msg').classList.add('hidden');

  // 補登模式：依時段 past 旗標切換（不受名額/折扣限制）
  modalBackfill = !!slot.past;
  // 名額守門：剩 1 名額的時段不可選 1對2（補登模式略過）
  const btn1on2 = document.querySelector('#modal-session-type .session-type-btn[data-type="1on2"]');
  if (btn1on2) {
    const disabled = !modalBackfill && slot.remain < 2;
    btn1on2.disabled = disabled;
    btn1on2.classList.toggle('opacity-40', disabled);
    btn1on2.title = disabled ? '此時段僅剩 1 個名額' : '';
  }

  // 課程型態（預設 1對1）+ 單堂價
  refreshSessionTypeButtons();
  refreshModalPrice();

  // 循環預約（員工限定）：登入教練/管理者才顯示；補登模式一律隱藏。每次開窗重置。
  const u = getUser();
  const isStaff = !!(u && (u.role === 'coach' || u.is_admin));
  $('recurring-row').classList.toggle('hidden', !isStaff || modalBackfill);
  $('recurring-enabled').checked = false;
  $('recurring-fields').classList.add('hidden');
  $('recurring-preview-result').classList.add('hidden');
  $('recurring-preview-result').innerHTML = '';
  $('recurring-markpaid').checked = false;
  recurringState = { previewed: false, okCount: 0 };

  // 補登模式 UI：橫幅 + 金額/備註欄；隱藏折扣與 Email；改標題與按鈕文字。
  $('modal-backfill-banner').classList.toggle('hidden', !modalBackfill);
  $('modal-backfill-amount-row').classList.toggle('hidden', !modalBackfill);
  $('modal-backfill-note-row').classList.toggle('hidden', !modalBackfill);
  $('modal-discount-row').classList.toggle('hidden', modalBackfill);
  $('modal-email-row').classList.toggle('hidden', modalBackfill);
  $('modal-title').textContent = modalBackfill ? '補登過去預約' : '填寫預約資訊';
  $('modal-submit-btn').textContent = modalBackfill ? '確認補登' : '確認預約';
  if (modalBackfill) {
    $('modal-backfill-note').value = '';
    $('modal-backfill-amount').value = priceByType[modalSessionType] != null ? priceByType[modalSessionType] : '';
  }

  $('booking-modal').classList.remove('hidden');
  $('modal-name').focus();
}

// ── 循環預約 UI ──────────────────────────────────────────────────────────────
function recurringEnabled() {
  return !$('recurring-row').classList.contains('hidden') && $('recurring-enabled').checked;
}

// 參數變更 → 預覽失效，主按鈕回到「請先預覽」
function invalidateRecurringPreview() {
  recurringState = { previewed: false, okCount: 0 };
  $('recurring-preview-result').classList.add('hidden');
  $('recurring-preview-result').innerHTML = '';
  refreshRecurringSubmit();
  refreshModalPrice();
}

function refreshRecurringSubmit() {
  const btn = $('modal-submit-btn');
  if (!recurringEnabled()) {
    btn.disabled = false;
    btn.textContent = '確認預約';
    return;
  }
  if (!recurringState.previewed) {
    btn.disabled = true;
    btn.textContent = '請先預覽場次';
  } else if (recurringState.okCount === 0) {
    btn.disabled = true;
    btn.textContent = '無可建立的場次';
  } else {
    btn.disabled = false;
    btn.textContent = `確認建立 ${recurringState.okCount} 堂`;
  }
}

function recurringParams() {
  return {
    coachId: modalCoach.id,
    startAt: modalSlot.start,
    sessionType: modalSessionType,
    frequency: $('recurring-frequency').value,
    intervalDays: $('recurring-frequency').value === 'custom' ? Number($('recurring-interval').value) : null,
    count: Number($('recurring-count').value),
  };
}

function validateRecurringInputs() {
  const count = Number($('recurring-count').value);
  if (!Number.isInteger(count) || count < 2 || count > 52) {
    toast('次數需為 2–52 的整數', 'error');
    return false;
  }
  if ($('recurring-frequency').value === 'custom') {
    const iv = Number($('recurring-interval').value);
    if (!Number.isInteger(iv) || iv < 1 || iv > 90) {
      toast('間隔需為 1–90 天的整數', 'error');
      return false;
    }
  }
  return true;
}

$('recurring-enabled').addEventListener('change', () => {
  $('recurring-fields').classList.toggle('hidden', !$('recurring-enabled').checked);
  invalidateRecurringPreview();
});
$('recurring-frequency').addEventListener('change', () => {
  $('recurring-interval-row').classList.toggle('hidden', $('recurring-frequency').value !== 'custom');
  invalidateRecurringPreview();
});
$('recurring-count').addEventListener('input', invalidateRecurringPreview);
$('recurring-interval').addEventListener('input', invalidateRecurringPreview);

$('recurring-preview-btn').addEventListener('click', async () => {
  if (!validateRecurringInputs()) return;
  const btn = $('recurring-preview-btn');
  btn.disabled = true;
  btn.textContent = '預覽中…';
  try {
    const r = await api('/api/bookings/recurring/preview', { method: 'POST', body: recurringParams() });
    const okCount = r.occurrences.filter(o => o.ok).length;
    const reasonText = { no_date: '當月無此日', unavailable: '不可預約（班表/請假/已被預訂/容量/日曆封鎖）' };
    $('recurring-preview-result').innerHTML = `
      <div class="font-medium mb-1" style="color:#0369a1;">可建立 ${okCount} 堂 · 衝突 ${r.occurrences.length - okCount} 堂</div>
      ${r.occurrences.map(o => o.ok
        ? `<div style="color:#15803d;">✓ ${escapeHtml(fmtDate(o.startAt))}</div>`
        : `<div style="color:#b91c1c;">✗ ${escapeHtml(fmtDate(o.startAt))}　${reasonText[o.reason] || o.reason}</div>`).join('')}
    `;
    $('recurring-preview-result').classList.remove('hidden');
    recurringState = { previewed: true, okCount };
    refreshRecurringSubmit();
    refreshModalPrice();
  } catch (e) {
    toast(`預覽失敗：${escapeHtml(e.data?.error || e.message)}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '預覽場次';
  }
});

function closeBookingModal() {
  $('booking-modal').classList.add('hidden');
  modalCoach = null;
  modalSlot = null;
  modalAppliedDiscount = null;
  modalBackfill = false;
}

$('modal-close-btn').addEventListener('click', closeBookingModal);
$('booking-modal').addEventListener('click', (ev) => {
  if (ev.target === $('booking-modal')) closeBookingModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeBookingModal();
});

// ── 課程型態切換（1對1 / 1對2）──────────────────────────────────────────────────
$('modal-session-type').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.session-type-btn');
  if (btn) setSessionType(btn.dataset.type);
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
      body: { kind: 'one_on_one', code, phone: rawPhone, sessionType: modalSessionType },
    });
    modalAppliedDiscount = { code: code.toUpperCase(), discountAmount: result.discount_amount, finalTotal: result.final_total, remainingUses: result.remaining_uses ?? null };
    refreshModalPrice(); // 訊息（單筆：折後現場應付／循環：折後預估總計）由此統一寫入
  } catch (err) {
    modalAppliedDiscount = null;
    refreshModalPrice();
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
  $('modal-email-err').textContent = '';
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
  const emailVal = $('modal-email').value.trim();
  if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
    $('modal-email-err').textContent = 'Email 格式不正確';
    hasErr = true;
  }
  if (hasErr) return;

  const btn = $('modal-submit-btn');
  btn.disabled = true;
  const btnText = btn.textContent;
  btn.textContent = '送出中…';

  // ── 補登模式：走管理者端點（靜默、預設已付款）──
  if (modalBackfill) {
    const amount = Number($('modal-backfill-amount').value);
    if (!Number.isInteger(amount) || amount < 0) {
      $('modal-general-err').textContent = '金額需為 0 或正整數';
      btn.disabled = false; btn.textContent = btnText;
      return;
    }
    try {
      const body = { coachId: modalCoach.id, startAt: modalSlot.start, name: nameVal, phone: phoneNormalized, sessionType: modalSessionType, amount };
      const noteVal = $('modal-backfill-note').value.trim();
      if (noteVal) body.note = noteVal;
      await api('/api/admin/bookings/backfill', { method: 'POST', body });
      const bookedCoach = modalCoach;
      closeBookingModal();
      toast('補登成功', 'success');
      slotCacheByCoach.delete(bookedCoach.id);
      if (currentCoach && !views.detail.classList.contains('hidden')) loadSlots();
    } catch (e) {
      btn.disabled = false; btn.textContent = btnText;
      const errCode = e.data?.error;
      if (errCode === 'already_booked') $('modal-general-err').textContent = '此教練該時段已有一筆預約紀錄。';
      else if (errCode === 'not_past') $('modal-general-err').textContent = '只能補登過去的時段。';
      else if (errCode === 'invalid_amount') $('modal-general-err').textContent = '金額需為 0 或正整數';
      else if (errCode === 'invalid_phone') $('modal-phone-err').textContent = e.data?.detail || '電話格式不正確';
      else if (errCode === 'missing_name') $('modal-name-err').textContent = '請輸入姓名';
      else if (errCode === 'phone_unavailable') $('modal-phone-err').textContent = '此電話號碼為員工帳號，無法用於補登。';
      else $('modal-general-err').textContent = `補登失敗：${e.message}`;
    }
    return;
  }

  // ── 循環模式：走員工端點（需先預覽）──
  if (recurringEnabled()) {
    try {
      if (!recurringState.previewed || recurringState.okCount === 0) throw new Error('請先預覽場次');
      const body = {
        ...recurringParams(),
        name: nameVal, phone: phoneNormalized,
        markPaid: $('recurring-markpaid').checked,
      };
      if (emailVal) body.email = emailVal;
      if (modalAppliedDiscount) body.discountCode = modalAppliedDiscount.code;
      const result = await api('/api/bookings/recurring', { method: 'POST', body });
      const bookedCoach = modalCoach;
      closeBookingModal();
      showRecurringSuccessView(result, bookedCoach);
      slotCacheByCoach.delete(bookedCoach.id);
      if (currentCoach && !views.detail.classList.contains('hidden')) loadSlots();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = btnText;
      const msgs = { all_conflicted: '所有場次都衝突，請調整起始時段、頻率或次數後重新預覽',
                     invalid_count: '次數需為 2–52', invalid_interval: '間隔需為 1–90 天',
                     invalid_frequency: '頻率參數錯誤', invalid_phone: '電話格式不正確' };
      $('modal-general-err').textContent = msgs[e.data?.error] || `建立失敗：${e.message}`;
    }
    return;
  }

  try {
    const bookingBody = { coachId: modalCoach.id, startAt: modalSlot.start, name: nameVal, phone: phoneNormalized, sessionType: modalSessionType };
    if (emailVal) bookingBody.email = emailVal;
    if (modalAppliedDiscount) bookingBody.discountCode = modalAppliedDiscount.code;
    const result = await api('/api/public/bookings', {
      method: 'POST',
      body: bookingBody,
    });
    // Success — 先存下 modal 狀態，closeBookingModal() 會把 modalCoach/modalSlot 清成 null
    const bookedCoach = modalCoach;
    const bookedSlot = modalSlot.start;
    closeBookingModal();
    showSuccessView(result, bookedCoach, bookedSlot);

    // Remove the booked slot from the detail grid if visible
    removeSlotFromGrid(bookedSlot);
    // Invalidate accordion cache for this coach
    slotCacheByCoach.delete(bookedCoach.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '確認預約';
    const errCode = e.data?.error;
    if (errCode === 'slot_taken') {
      $('modal-general-err').textContent = '此時段剛被預約走了，請選其他時段。';
      // Remove this slot from the grid so user doesn't try again
      removeSlotFromGrid(modalSlot?.start);
      slotCacheByCoach.delete(modalCoach?.id);
    } else if (errCode === 'slot_unavailable' || errCode === 'slot_full') {
      $('modal-general-err').textContent = '此時段已額滿或不可預約，請重新選擇時段。';
      removeSlotFromGrid(modalSlot?.start);
      slotCacheByCoach.delete(modalCoach?.id);
      if (currentCoach && !views.detail.classList.contains('hidden')) loadSlots();
    } else if (errCode === 'invalid_email') {
      $('modal-email-err').textContent = 'Email 格式不正確';
    } else if (errCode === 'invalid_phone') {
      $('modal-phone-err').textContent = e.data?.detail || '電話格式不正確';
    } else if (errCode === 'missing_name') {
      $('modal-name-err').textContent = '請輸入姓名';
    } else if (errCode === 'missing_phone') {
      $('modal-phone-err').textContent = '請輸入電話';
    } else if (errCode === 'phone_unavailable') {
      $('modal-phone-err').textContent = '此電話號碼無法用於線上預約，請確認號碼是否正確。';
    } else if (errCode === 'coach_not_found' || errCode === 'coach_inactive') {
      $('modal-general-err').textContent = '教練目前無法預約，請重新整理頁面。';
    } else {
      $('modal-general-err').textContent = `預約失敗：${e.message}`;
    }
  }
});

function removeSlotFromGrid(slotStart) {
  // 從詳細頁 timegrid 移除已被預約的時段卡（.timeslot[data-slot]）；slotStart 為 ISO datetime 字串
  const grid = $('slot-grid');
  if (grid) {
    grid.querySelectorAll('[data-slot]').forEach((el) => {
      if (el.dataset.slot === slotStart) el.remove();
    });
  }
  // 同步從 weekSlotsByDate 快取移除，避免重新選日後仍出現
  if (slotStart && weekSlotsByDate) {
    const key = isoToDateKey(slotStart);
    if (weekSlotsByDate[key]) {
      weekSlotsByDate[key] = weekSlotsByDate[key].filter((s) => s.start !== slotStart);
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

// --- Recurring success view --------------------------------------------------

// 循環預約建立結果：逐堂清單（建立/跳過）、總額、付款狀態、（未綁定）LINE 綁定碼
function showRecurringSuccessView(result, coach) {
  const successEl = $('view-success');
  const coachName = escapeHtml(coach?.display_name ?? '');
  const reasonText = { no_date: '當月無此日', unavailable: '不可預約' };
  const createdRows = result.created.map(c =>
    `<div style="color:#15803d;">✓ ${escapeHtml(fmtDate(c.startAt))}　$${escapeHtml(String(c.finalAmount ?? ''))}</div>`).join('');
  const skippedRows = (result.skipped || []).map(o =>
    `<div style="color:#b91c1c;">✗ ${escapeHtml(fmtDate(o.startAt))}　${reasonText[o.reason] || escapeHtml(o.reason)}（已跳過，可日後手動補建）</div>`).join('');

  let lineHtml = '';
  if (result.lineBindCode) {
    const joinBtn = result.lineOfficialUrl
      ? `<a href="${escapeHtml(result.lineOfficialUrl)}" target="_blank" rel="noopener noreferrer" class="line-join-btn">加入官方 LINE</a>`
      : '';
    lineHtml = `
      <div class="card bg-green-50 border border-green-200 mt-4 p-4 text-sm text-center">
        <p class="text-green-800">想收上課提醒與通知？加入官方 LINE 並貼入這組綁定碼：</p>
        ${joinBtn}
        <p class="text-xl font-bold text-green-700 my-2 tracking-widest">${escapeHtml(result.lineBindCode)}</p>
        <p class="text-green-600">（15 分鐘內有效）</p>
      </div>`;
  }

  successEl.innerHTML = `
    <div class="text-center py-6">
      <div class="text-5xl mb-4">✅</div>
      <h1 class="page-title">已建立 ${result.created.length} 堂循環預約</h1>
      <div class="card mt-4 mb-2 text-left text-sm">
        <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${coachName}</strong></div>
        <div class="mb-2" style="max-height:220px;overflow-y:auto;">${createdRows}${skippedRows}</div>
        <div class="mt-2"><span class="text-slate-500">合計</span><br>
          <strong style="font-size:20px;color:var(--brand-700, #0369a1);">$${escapeHtml(String(result.totalAmount ?? 0))}</strong>
          <span class="text-slate-500 text-sm">（${result.markPaid ? '已收款' : '待核對款項'}）</span>
        </div>
      </div>
      ${lineHtml}
      <div class="mt-6 flex flex-col gap-3">
        <a href="/my-schedule" class="btn-primary text-center block">查我的預約</a>
        <a href="/" class="btn-secondary text-center block">回首頁</a>
      </div>
    </div>
  `;
  for (const v of Object.values(views)) v.classList.add('hidden');
  successEl.classList.remove('hidden');
}

// --- Success view ----------------------------------------------------------

function showSuccessView(bookingResult, coach = modalCoach, slot = modalSlot) {
  const successEl = $('view-success');
  const coachName = escapeHtml(coach?.display_name ?? '');
  const slotTime = escapeHtml(fmtDate(slot ?? bookingResult.startAt));

  let lineHtml = '';
  if (bookingResult.lineBindCode) {
    const joinBtn = bookingResult.lineOfficialUrl
      ? `<a href="${escapeHtml(bookingResult.lineOfficialUrl)}" target="_blank" rel="noopener noreferrer" class="line-join-btn">加入官方 LINE</a>`
      : '';
    lineHtml = `
      <div class="card bg-green-50 border border-green-200 mt-4 p-4 text-sm text-center">
        <p class="text-green-800">想收上課提醒與通知？加入官方 LINE 並貼入這組綁定碼：</p>
        ${joinBtn}
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

  // 有填 email 時顯示確認信提示
  const emailLine = bookingResult.customerEmail
    ? `<div class="mt-2 text-sm text-slate-500">確認信將寄至 ${escapeHtml(bookingResult.customerEmail)}（未收到請檢查垃圾信件匣）</div>` : '';

  successEl.innerHTML = `
    <div class="text-center py-6">
      <div class="text-5xl mb-4">✅</div>
      <h1 class="page-title">預約成功！</h1>
      <div class="card mt-4 mb-2 text-left">
        <div class="mb-2"><span class="text-slate-500">教練</span><br><strong>${coachName}</strong></div>
        <div class="mb-2"><span class="text-slate-500">時間</span><br><strong>${slotTime}</strong></div>
        <div><span class="text-slate-500">課程型態</span><br><strong>${escapeHtml(SESSION_TYPE_LABELS[bookingResult.sessionType] ?? '1對1')}</strong></div>
        ${paymentHtml}
        ${emailLine}
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
