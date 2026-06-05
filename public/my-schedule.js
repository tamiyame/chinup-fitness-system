import { api, fmtDate, toast, bootPublic, escapeHtml } from './app.js';

// Public phone+name lookup — no login required.
const LS_PHONE = 'chinup.my.phone';
const LS_NAME  = 'chinup.my.name';

await bootPublic();

const state = {
  items: [],
  filter: 'all',
  pastOpen: false,
  creds: null,  // { phone, name } after successful lookup
  one_on_one_remaining: 0,
  group_remaining: 0,
};

// ── Lookup form ──────────────────────────────────────────────────────────────

function getForm() {
  return {
    phoneEl: document.getElementById('lookup-phone'),
    nameEl:  document.getElementById('lookup-name'),
    btnEl:   document.getElementById('lookup-btn'),
    errEl:   document.getElementById('lookup-error'),
  };
}

function autoFillForm() {
  const { phoneEl, nameEl } = getForm();
  const savedPhone = localStorage.getItem(LS_PHONE) || '';
  const savedName  = localStorage.getItem(LS_NAME)  || '';
  if (savedPhone) phoneEl.value = savedPhone;
  if (savedName)  nameEl.value  = savedName;
  return { savedPhone, savedName };
}

async function doLookup(phone, name) {
  const { errEl, btnEl } = getForm();
  errEl.style.display = 'none';
  btnEl.disabled = true;
  btnEl.textContent = '查詢中…';
  try {
    const data = await api('/api/public/my', {
      method: 'POST',
      body: { phone, name },
    });
    // Save credentials
    localStorage.setItem(LS_PHONE, phone);
    localStorage.setItem(LS_NAME, name);
    state.creds = { phone, name };
    state.items = data.items ?? [];
    state.one_on_one_remaining = data.one_on_one_remaining ?? 0;
    state.group_remaining = data.group_remaining ?? 0;
    showResults();
    render();
  } catch (e) {
    if (e.status === 403) {
      errEl.textContent = '查無資料，請確認電話與姓名';
      errEl.style.display = 'block';
    } else {
      errEl.textContent = `查詢失敗：${e.message}`;
      errEl.style.display = 'block';
    }
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = '查詢';
  }
}

function bindLookupForm() {
  const { btnEl, phoneEl, nameEl } = getForm();
  btnEl.addEventListener('click', async () => {
    const rawPhone = phoneEl.value.trim();
    const name     = nameEl.value.trim();
    if (!rawPhone || !name) {
      const { errEl } = getForm();
      errEl.textContent = '請輸入電話與姓名';
      errEl.style.display = 'block';
      return;
    }
    const phone = rawPhone.replace(/\D/g, '');
    await doLookup(phone, name);
  });

  // Submit on Enter key in either input
  [phoneEl, nameEl].forEach(el => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnEl.click();
    });
  });
}

function showResults() {
  document.getElementById('lookup-section').style.display = 'none';
  document.getElementById('results-section').style.display = 'block';
}

function showForm() {
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('lookup-section').style.display = 'block';
  state.creds = null;
  state.items = [];
}

// ── Card rendering ───────────────────────────────────────────────────────────

function dateBlock(start_at) {
  const dt = new Date(start_at);
  const d  = String(dt.getDate()).padStart(2, '0');
  const m  = String(dt.getMonth() + 1).padStart(2, '0');
  return `
    <div class="text-center px-3 py-2 rounded-lg" style="background:var(--brand-50);min-width:64px;">
      <div class="text-2xl font-bold" style="color:var(--brand-700);line-height:1;">${d}</div>
      <div class="text-xs mt-1" style="color:var(--brand-700)">${dt.getFullYear()}/${m}</div>
    </div>
  `;
}

/**
 * Derive a status label and badge class for an item.
 * Booking: confirmed → 已確認, cancelled → 已取消
 * Registration:
 *   confirmed  → 已確認
 *   waitlisted → 候補中
 *   pending (no order_id) → 待付款
 *   pending (has order_id) → 已遞補待付款
 *   cancelled  → 已取消
 *   rejected   → 未開課
 */
function resolveStatus(item) {
  if (item.kind === 'booking') {
    const labels = { confirmed: '已確認', cancelled: '已取消' };
    const cls    = { confirmed: 'badge-confirmed', cancelled: 'badge-cancelled' };
    return {
      label: labels[item.status] || item.status,
      cls:   cls[item.status]    || 'badge-completed',
    };
  }
  // registration
  if (item.status === 'pending') {
    if (item.order_id) {
      return { label: '已遞補待付款', cls: 'badge-waitlisted' };
    }
    return { label: '待付款', cls: 'badge-waitlisted' };
  }
  if (item.on_leave) {
    return { label: '請假', cls: 'badge-completed' };
  }
  const labels = {
    confirmed:  '已確認',
    waitlisted: '候補中',
    cancelled:  '已取消',
    rejected:   '未開課',
  };
  const cls = {
    confirmed:  'badge-confirmed',
    waitlisted: 'badge-waitlisted',
    cancelled:  'badge-cancelled',
    rejected:   'badge-rejected',
  };
  return {
    label: labels[item.status] || item.status,
    cls:   cls[item.status]    || 'badge-completed',
  };
}

function paymentLine(item) {
  if (item.kind !== 'registration' || item.status !== 'pending') return '';
  const parts = [];
  if (item.order_total != null) {
    // Show discounted order total; append discount amount if applicable
    let payable = `應付 $${escapeHtml(String(item.order_total))}`;
    if (item.order_discount != null && item.order_discount > 0) {
      payable += `（已折 $${escapeHtml(String(item.order_discount))}）`;
    }
    parts.push(payable);
  } else if (item.amount_due != null) {
    parts.push(`金額：${escapeHtml(String(item.amount_due))} 元`);
  }
  if (item.order_expires_at) {
    parts.push(`請於 ${escapeHtml(fmtDate(item.order_expires_at))} 前匯款`);
  }
  if (parts.length === 0) return '';
  return `<div class="text-sm text-amber-600 mt-1">${parts.join('　')}</div>`;
}

function cancelButton(item) {
  // Pending unpaid group order: offer 放棄此訂單 while the session is still upcoming.
  // The backend reports can_cancel=false for pending registrations (they are abandoned via the
  // group-orders route, NOT the registration route), so this must be checked before the guard.
  if (item.kind === 'registration' && item.status === 'pending' && item.order_id && !item.is_past) {
    return `<button
      class="cancel-btn btn btn-danger btn-sm"
      data-kind="group-order"
      data-order-id="${item.order_id}">放棄此訂單</button>`;
  }
  // 已付款團課 → 今日請假（標記請假、釋名額、不退款、不取消訂單）
  if (item.kind === 'registration' && item.can_leave) {
    return `<button
      class="cancel-btn btn btn-danger btn-sm"
      data-kind="leave"
      data-id="${item.id}">今日請假</button>`;
  }
  if (!item.can_cancel) return '';
  if (item.kind === 'booking') {
    return `<button
      class="cancel-btn btn btn-danger btn-sm"
      data-kind="booking"
      data-id="${item.id}">取消</button>`;
  }
  // confirmed / waitlisted
  return `<button
    class="cancel-btn btn btn-danger btn-sm"
    data-kind="registration"
    data-id="${item.id}">取消</button>`;
}

function cardHtml(item) {
  const kindPill = item.kind === 'booking'
    ? `<span class="pill-kind pill-1on1">🏋️ ${item.session_type === '1on2' ? '一對二' : '一對一'}</span>`
    : '<span class="pill-kind pill-group">👥 團課</span>';

  const title = item.kind === 'booking'
    ? (item.coach_display_name || '教練')
    : (item.course_name || '團課');

  const { label, cls } = resolveStatus(item);

  return `
    <article class="card${item.is_past ? ' past-card' : ''}">
      <div class="flex items-center gap-4">
        ${dateBlock(item.start_at)}
        <div class="flex-1 min-w-0">
          <div class="mb-1">${kindPill}</div>
          <h3 class="card-title">${escapeHtml(title)}</h3>
          <div class="meta">
            <span class="meta-item"><span class="meta-icon">🕐</span> ${escapeHtml(fmtDate(item.start_at))}</span>
          </div>
          <div class="flex items-center gap-2 mt-2 flex-wrap">
            <span class="badge ${escapeHtml(cls)}">${escapeHtml(label)}</span>
          </div>
          ${paymentLine(item)}
        </div>
        <div class="flex-shrink-0">
          ${cancelButton(item)}
        </div>
      </div>
    </article>
  `;
}

// ── Render ───────────────────────────────────────────────────────────────────

function filterItems(items, filter) {
  if (filter === 'all') return items;
  return items.filter(i => i.kind === filter);
}

function render() {
  // Summary line
  const summaryEl = document.getElementById('remaining-summary');
  summaryEl.textContent =
    `1對1 剩 ${state.one_on_one_remaining} 堂 · 團體 剩 ${state.group_remaining} 堂`;

  const filtered = filterItems(state.items, state.filter);
  const upcoming = filtered.filter(i => !i.is_past);
  const past     = filtered.filter(i =>  i.is_past);

  // Upcoming
  const upWrap  = document.getElementById('upcoming-list');
  const upEmpty = document.getElementById('upcoming-empty');
  if (upcoming.length === 0) {
    upWrap.innerHTML = '';
    upEmpty.style.display = 'block';
    const msgEl = document.getElementById('upcoming-empty-msg');
    if (state.items.length === 0) {
      msgEl.textContent = '還沒有任何預約';
    } else if (state.filter === 'booking') {
      msgEl.textContent = '「一對一」沒有未來預約';
    } else if (state.filter === 'registration') {
      msgEl.textContent = '「團課」沒有未來預約';
    } else {
      msgEl.textContent = '沒有即將到來的預約';
    }
  } else {
    upEmpty.style.display = 'none';
    upWrap.innerHTML = upcoming.map(cardHtml).join('');
  }

  // Past
  const pastWrap  = document.getElementById('past-toggle-wrap');
  const pastList  = document.getElementById('past-list');
  const pastCount = document.getElementById('past-count');
  const pastCaret = document.getElementById('past-caret');

  if (past.length === 0) {
    pastWrap.style.display = 'none';
  } else {
    pastWrap.style.display = 'block';
    pastCount.textContent = past.length;
    pastCaret.textContent = state.pastOpen ? '▼' : '▶';
    if (state.pastOpen) {
      pastList.style.display = 'grid';
      pastList.innerHTML = past.map(cardHtml).join('');
    } else {
      pastList.style.display = 'none';
      pastList.innerHTML = '';
    }
  }

  // Bind cancel buttons
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCancel(btn));
  });
}

// ── Cancel ───────────────────────────────────────────────────────────────────

async function handleCancel(btn) {
  const kind    = btn.dataset.kind;
  const id      = btn.dataset.id;
  const orderId = btn.dataset.orderId;
  const isLeave = kind === 'leave';

  const confirmMsg = isLeave
    ? '確定要請假嗎？此堂將標為「請假」、不退費，名額會釋出給候補。'
    : '確定要取消嗎？';
  if (!confirm(confirmMsg)) return;

  let url, method = 'DELETE';
  if (kind === 'booking') {
    url = `/api/public/bookings/${id}`;
  } else if (kind === 'registration') {
    url = `/api/public/registrations/${id}`;
  } else if (kind === 'group-order') {
    url = `/api/public/group-orders/${orderId}`;
  } else if (kind === 'leave') {
    url = `/api/public/registrations/${id}/leave`;
    method = 'POST';
  } else {
    toast('未知操作類型', 'error');
    return;
  }

  try {
    await api(url, { method, body: state.creds });
    toast(isLeave ? '已請假' : '已取消', 'success');
    // Re-run lookup to refresh
    await doLookup(state.creds.phone, state.creds.name);
  } catch (e) {
    if (isLeave) {
      const m = {
        session_started: '課程已開始，無法請假',
        not_confirmed: '此項目目前無法請假',
        already_on_leave: '此堂已請假',
        forbidden: '驗證失敗，請重新查詢',
      };
      toast(m[e.data?.error] || `請假失敗：${e.message}`, 'error');
    } else {
      toast(`取消失敗：${e.message}`, 'error');
    }
  }
}

// ── Tab + past toggle ────────────────────────────────────────────────────────

function bindTabs() {
  document.querySelectorAll('#tab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      render();
    });
  });
}

function bindPastToggle() {
  document.getElementById('past-toggle').addEventListener('click', () => {
    state.pastOpen = !state.pastOpen;
    render();
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

bindLookupForm();
bindTabs();
bindPastToggle();

// "換帳號" button in results area
document.getElementById('change-lookup-btn').addEventListener('click', () => {
  showForm();
});

// Auto-fill from localStorage; auto-query if both present
const { savedPhone, savedName } = autoFillForm();
if (savedPhone && savedName) {
  const phone = savedPhone.replace(/\D/g, '');
  // Auto-query in background; don't block body reveal
  doLookup(phone, savedName).catch(() => {});
}

document.body.style.visibility = 'visible';
