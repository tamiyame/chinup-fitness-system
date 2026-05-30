import { api, toast, fmtDate, bootPublic, escapeHtml, dow } from '/app.js';

// ── boot (soft-public: no redirect for anon) ────────────────────────────────
bootPublic();

// ── helpers ─────────────────────────────────────────────────────────────────
const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

function formatTime(dt) {
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function sessionLabel(s) {
  const dt = new Date(s.start_at);
  const dtEnd = new Date(s.end_at);
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')} 週${DOW_SHORT[dt.getDay()]} ${formatTime(dt)}–${formatTime(dtEnd)}`;
}

function $(id) { return document.getElementById(id); }

// ── state ────────────────────────────────────────────────────────────────────
// Map<sessionId, { type: 'pay'|'waitlist', session, templateName, price }>
const selected = new Map();
let allTemplates = [];  // cached API response

// ── selection helpers ─────────────────────────────────────────────────────────
function totalPay() {
  let sum = 0;
  for (const v of selected.values()) if (v.type === 'pay') sum += v.price;
  return sum;
}

function updatePriceBar() {
  const payCount = [...selected.values()].filter(v => v.type === 'pay').length;
  const waitCount = [...selected.values()].filter(v => v.type === 'waitlist').length;
  const total = totalPay();

  const bar = $('price-bar');
  const barTotal = $('price-bar-total');
  const barGo = $('price-bar-go');

  if (payCount === 0 && waitCount === 0) {
    bar.classList.add('hidden');
    $('booking-form-section').classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  barTotal.textContent = `NT$${total.toLocaleString()}`;
  barGo.disabled = false;
}

function updateOrderSummary() {
  const pays = [...selected.values()].filter(v => v.type === 'pay');
  const waits = [...selected.values()].filter(v => v.type === 'waitlist');
  const total = totalPay();

  const payHtml = pays.length === 0
    ? '<div class="text-slate-400">（尚未選擇付款場次）</div>'
    : pays.map(v => `<div>• ${escapeHtml(v.templateName)} ${escapeHtml(sessionLabel(v.session))} NT$${v.price.toLocaleString()}</div>`).join('');

  const waitHtml = waits.length > 0
    ? `<div class="font-semibold mb-1" style="color:#92400e;">候補場次</div>` +
      waits.map(v => `<div>• ${escapeHtml(v.templateName)} ${escapeHtml(sessionLabel(v.session))}</div>`).join('')
    : '';

  $('summary-pay-list').innerHTML = payHtml;
  $('summary-wait-list').innerHTML = waitHtml;
  $('summary-total').textContent = `NT$${total.toLocaleString()}`;
}

function toggleSession(sessionId, type, session, templateName, price) {
  const key = sessionId;
  if (selected.has(key)) {
    // clicking again deselects
    selected.delete(key);
  } else {
    selected.set(key, { type, session, templateName, price });
  }
  // re-render the row visual
  const row = document.querySelector(`.sess-row[data-sid="${sessionId}"]`);
  if (row) {
    if (selected.has(key)) {
      row.classList.add(type === 'pay' ? 'selected' : 'waitlist-selected');
      row.classList.remove(type === 'pay' ? 'waitlist-selected' : 'selected');
      const cb = row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = true;
    } else {
      row.classList.remove('selected', 'waitlist-selected');
      const cb = row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = false;
    }
  }
  updatePriceBar();
  updateOrderSummary();
  // sync select-all checkbox for this template
  const tpl = allTemplates.find(t => t.sessions.some(s => s.id === sessionId));
  if (tpl) syncSelectAll(tpl);
}

function syncSelectAll(tpl) {
  const cb = document.querySelector(`.select-all-cb[data-tpl="${tpl.id}"]`);
  if (!cb) return;
  const nonFull = tpl.sessions.filter(s => !s.is_full);
  const allChosen = nonFull.length > 0 && nonFull.every(s => selected.has(s.id));
  cb.checked = allChosen;
  cb.indeterminate = !allChosen && nonFull.some(s => selected.has(s.id));
}

function selectAllToggle(tpl, forceOn) {
  const nonFull = tpl.sessions.filter(s => !s.is_full);
  const shouldSelect = forceOn !== undefined ? forceOn : !nonFull.every(s => selected.has(s.id));
  for (const s of nonFull) {
    if (shouldSelect) {
      selected.set(s.id, { type: 'pay', session: s, templateName: tpl.name, price: s.price_per_session });
    } else {
      selected.delete(s.id);
    }
    const row = document.querySelector(`.sess-row[data-sid="${s.id}"]`);
    if (row) {
      if (shouldSelect) {
        row.classList.add('selected');
        row.classList.remove('waitlist-selected');
      } else {
        row.classList.remove('selected', 'waitlist-selected');
      }
      const cb = row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = shouldSelect;
    }
  }
  updatePriceBar();
  updateOrderSummary();
  syncSelectAll(tpl);
}

// ── render ────────────────────────────────────────────────────────────────────
function renderTemplate(tpl) {
  const nonFull = tpl.sessions.filter(s => !s.is_full);
  const hasNonFull = nonFull.length > 0;

  const priceLabel = tpl.price_per_session > 0
    ? `NT$${tpl.price_per_session.toLocaleString()} / 堂`
    : '免費';

  const chevron = `<svg class="day-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  const sessionCount = tpl.sessions.length;

  const sessionsHtml = tpl.sessions.map(s => renderSessionRow(s, tpl)).join('');

  const selectAllHtml = hasNonFull ? `
    <label class="select-all-row">
      <input type="checkbox" class="select-all-cb" data-tpl="${tpl.id}" style="accent-color:var(--brand-600);width:16px;height:16px;">
      全選整週期（${nonFull.length} 個開放場次）
    </label>
  ` : '';

  return `
  <details class="day-group" open>
    <summary>
      <div class="day-chip">${sessionCount}<span class="day-chip-unit">場</span></div>
      <div class="day-title">
        <h3>${escapeHtml(tpl.name)}
          <span class="badge badge-open" style="font-size:11px;margin-left:6px;">${escapeHtml(priceLabel)}</span>
        </h3>
        <p>${escapeHtml(tpl.description || '')}</p>
        <p class="course-meta">⏱ ${tpl.duration_minutes} 分鐘・👥 ${tpl.min_capacity}–${tpl.max_capacity} 人</p>
      </div>
      ${chevron}
    </summary>
    <div class="day-group-content">
      ${selectAllHtml}
      ${sessionsHtml}
    </div>
  </details>`;
}

function renderSessionRow(s, tpl) {
  const dt = new Date(s.start_at);
  const dtEnd = new Date(s.end_at);
  const dateStr = `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')} 週${DOW_SHORT[dt.getDay()]}`;
  const timeStr = `${formatTime(dt)}–${formatTime(dtEnd)}`;
  const capStr = `已佔 ${s.occupied} / 上限 ${s.max_capacity}`;
  const pct = Math.min(100, Math.round((s.occupied / s.max_capacity) * 100));

  if (s.is_full) {
    return `
    <div class="sess-row" data-sid="${s.id}" data-type="waitlist" data-tpl-id="${tpl.id}"
         data-tpl-name="${escapeHtml(tpl.name)}" data-price="${s.price_per_session}">
      <input type="checkbox" style="accent-color:#d97706;width:16px;height:16px;flex-shrink:0;" aria-label="候補">
      <div class="sess-row-info">
        <div class="sess-row-date">${escapeHtml(dateStr)}</div>
        <div class="sess-row-time">${escapeHtml(timeStr)}</div>
      </div>
      <div style="text-align:right;">
        <div class="sess-row-cap">${escapeHtml(capStr)}</div>
        <span class="badge badge-waitlisted" style="font-size:11px;margin-top:3px;display:inline-flex;">額滿·可候補</span>
      </div>
    </div>`;
  }

  return `
  <div class="sess-row" data-sid="${s.id}" data-type="pay" data-tpl-id="${tpl.id}"
       data-tpl-name="${escapeHtml(tpl.name)}" data-price="${s.price_per_session}">
    <input type="checkbox" style="accent-color:var(--brand-600);width:16px;height:16px;flex-shrink:0;" aria-label="報名">
    <div class="sess-row-info">
      <div class="sess-row-date">${escapeHtml(dateStr)}</div>
      <div class="sess-row-time">${escapeHtml(timeStr)}</div>
    </div>
    <div style="text-align:right;">
      <div class="sess-row-cap">${escapeHtml(capStr)}</div>
      <div class="cc-bar" style="width:80px;margin-top:4px;">
        <div class="cc-fill ${pct >= 100 ? 'full' : pct >= 70 ? 'warn' : 'open'}" style="width:${pct}%;"></div>
      </div>
    </div>
  </div>`;
}

// ── load courses ──────────────────────────────────────────────────────────────
async function loadCourses() {
  try {
    const templates = await api('/api/public/group-courses');
    allTemplates = templates;

    $('loading').classList.add('hidden');

    if (!templates.length) {
      $('empty').classList.remove('hidden');
      return;
    }

    const listEl = $('course-list');
    listEl.innerHTML = templates.map(t => renderTemplate(t)).join('');
    listEl.classList.remove('hidden');

    // bind click handlers on session rows
    listEl.querySelectorAll('.sess-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // don't double-fire from checkbox (let row click manage state)
        if (e.target.tagName === 'INPUT') return;
        const sid = Number(row.dataset.sid);
        const type = row.dataset.type;
        const tplName = row.dataset.tplName;
        const price = Number(row.dataset.price);
        const tplId = Number(row.dataset.tplId);
        const tpl = allTemplates.find(t => t.id === tplId);
        const session = tpl?.sessions.find(s => s.id === sid);
        if (!session) return;
        toggleSession(sid, type, session, tplName, price);
      });

      // direct checkbox click
      const cb = row.querySelector('input[type=checkbox]');
      if (cb) {
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          const sid = Number(row.dataset.sid);
          const type = row.dataset.type;
          const tplName = row.dataset.tplName;
          const price = Number(row.dataset.price);
          const tplId = Number(row.dataset.tplId);
          const tpl = allTemplates.find(t => t.id === tplId);
          const session = tpl?.sessions.find(s => s.id === sid);
          if (!session) return;

          // checkbox state after click is already toggled by browser
          if (cb.checked) {
            if (!selected.has(sid)) {
              selected.set(sid, { type, session, templateName: tplName, price });
              row.classList.add(type === 'pay' ? 'selected' : 'waitlist-selected');
            }
          } else {
            selected.delete(sid);
            row.classList.remove('selected', 'waitlist-selected');
          }
          updatePriceBar();
          updateOrderSummary();
          if (tpl) syncSelectAll(tpl);
        });
      }
    });

    // bind select-all checkboxes
    listEl.querySelectorAll('.select-all-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const tplId = Number(cb.dataset.tpl);
        const tpl = allTemplates.find(t => t.id === tplId);
        if (!tpl) return;
        selectAllToggle(tpl, cb.checked);
      });
    });

  } catch (e) {
    $('loading').classList.add('hidden');
    toast(`載入課程失敗：${e.message}`, 'error');
  }
}

// ── price bar scroll-to-form ──────────────────────────────────────────────────
$('price-bar-go').addEventListener('click', () => {
  updateOrderSummary();
  const sec = $('booking-form-section');
  sec.classList.remove('hidden');
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── form submit ───────────────────────────────────────────────────────────────
$('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('form-error');
  errEl.classList.add('hidden');

  const name = $('f-name').value.trim();
  const rawPhone = $('f-phone').value.replace(/\D/g, '');

  if (!name) { errEl.textContent = '請填寫姓名'; errEl.classList.remove('hidden'); return; }
  if (!rawPhone) { errEl.textContent = '請填寫電話'; errEl.classList.remove('hidden'); return; }

  const paySessionIds = [...selected.values()].filter(v => v.type === 'pay').map(v => v.session.id);
  const waitlistSessionIds = [...selected.values()].filter(v => v.type === 'waitlist').map(v => v.session.id);

  if (paySessionIds.length === 0 && waitlistSessionIds.length === 0) {
    errEl.textContent = '請至少勾選一個場次';
    errEl.classList.remove('hidden');
    return;
  }

  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = '送出中…';

  try {
    const result = await api('/api/public/group-orders', {
      method: 'POST',
      body: { name, phone: rawPhone, paySessionIds, waitlistSessionIds },
    });
    showSuccess(result);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '確認報名並送出';

    if (err.status === 409 && err.data?.error === 'sessions_full') {
      const fullIds = err.data?.detail?.fullSessionIds || [];
      const labels = fullIds.map(id => {
        for (const tpl of allTemplates) {
          const s = tpl.sessions.find(ss => ss.id === id);
          if (s) return `${escapeHtml(tpl.name)} ${escapeHtml(sessionLabel(s))}`;
        }
        return `場次 #${id}`;
      });
      errEl.innerHTML = `下列場次已額滿，請改候補或取消勾選後再送：<br>` +
        labels.map(l => `• ${l}`).join('<br>');
      errEl.classList.remove('hidden');
      // highlight the full sessions
      for (const id of fullIds) {
        const row = document.querySelector(`.sess-row[data-sid="${id}"]`);
        if (row) row.style.borderColor = '#ef4444';
      }
    } else if (err.status === 400 && err.data?.error === 'no_sessions_selected') {
      errEl.textContent = '請至少勾選一個場次';
      errEl.classList.remove('hidden');
    } else if (err.status === 409 && err.data?.error === 'already_registered') {
      const sid = err.data?.detail?.sessionId;
      let label = `場次 #${sid}`;
      for (const tpl of allTemplates) {
        const s = tpl.sessions.find(ss => ss.id === sid);
        if (s) { label = `${tpl.name} ${sessionLabel(s)}`; break; }  // textContent sink → no escape (avoids double-escape)
      }
      errEl.textContent = `您已報名過此場次：${label}`;
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = `送出失敗：${escapeHtml(err.message)}`;
      errEl.classList.remove('hidden');
    }
  }
});

// ── success view ──────────────────────────────────────────────────────────────
function showSuccess(result) {
  // hide everything else
  $('booking-form-section').classList.add('hidden');
  $('course-list').classList.add('hidden');
  $('price-bar').classList.add('hidden');

  const sv = $('success-view');

  // order info
  const expiresStr = fmtDate(result.expiresAt);
  $('success-order-info').innerHTML = `
    <div class="mb-2">
      <span class="subtle">訂單編號</span><br>
      <strong style="font-size:18px;">#${escapeHtml(String(result.orderId))}</strong>
    </div>
    <div>
      <span class="subtle">應付金額</span><br>
      <strong style="font-size:22px;color:var(--brand-700);">NT$${result.total.toLocaleString()}</strong>
    </div>
    <div class="mt-3 text-sm" style="color:#b91c1c;">
      請於 <strong>${escapeHtml(expiresStr)}</strong> 前完成匯款，逾期訂單將自動取消。
    </div>
  `;

  // bank info
  $('success-bank-info').innerHTML = `
    <div class="text-sm font-semibold mb-1" style="color:var(--ink-mute);">匯款帳號</div>
    <strong>${escapeHtml(result.bankInfo)}</strong>
    <div class="text-xs mt-2" style="color:var(--ink-mute);">匯款後請保留收據，等待管理員確認後課程即生效。</div>
  `;

  // waitlist sessions
  if (result.waitlisted && result.waitlisted.length > 0) {
    const waitEl = $('success-waitlist');
    const labels = result.waitlisted.map(id => {
      for (const tpl of allTemplates) {
        const s = tpl.sessions.find(ss => ss.id === id);
        if (s) return `${escapeHtml(tpl.name)} ${escapeHtml(sessionLabel(s))}`;
      }
      return `場次 #${id}`;
    });
    waitEl.innerHTML = `<div class="font-semibold mb-1">候補場次</div>` +
      labels.map(l => `<div>• ${l}</div>`).join('');
    waitEl.classList.remove('hidden');
  }

  // LINE bind code
  if (result.lineBindCode) {
    const lineEl = $('success-line-box');
    lineEl.innerHTML = `
      <p class="text-sm" style="color:#166534;">想收 LINE 通知？加官方帳號並貼入這組碼：</p>
      <div class="line-code">${escapeHtml(result.lineBindCode)}</div>
      <p class="text-xs" style="color:#16a34a;">（15 分鐘內有效）</p>
    `;
    lineEl.classList.remove('hidden');
  }

  sv.style.display = 'block';
  sv.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── init ──────────────────────────────────────────────────────────────────────
loadCourses();
