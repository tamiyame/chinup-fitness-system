import { api, fmtDate, toast, bootPublic, escapeHtml, getToken } from './app.js';

// Public phone+name lookup — no login required.
const LS_PHONE = 'chinup.my.phone';
const LS_NAME  = 'chinup.my.name';

await bootPublic();

const state = {
  items: [],
  filter: 'all',
  pastOpen: false,
  creds: null,  // { phone, name } after successful lookup
  lineBound: null,  // true / false / null（非客戶或未查詢）
  one_on_one_remaining: 0,
  group_remaining: 0,
  packages: [],
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
    state.packages = data.packages ?? [];
    state.lineBound = (data.line_bound ?? null);
    showResults();
    render();
    renderLineNav();
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
  // 標題改為帶入查詢者姓名的問候語；副標（輸入提示）查詢後隱藏
  const name = state.creds?.name || '';
  const titleEl = document.getElementById('ms-title');
  if (titleEl) titleEl.textContent = name ? `嗨～${name}，歡迎回來` : '我的課表';
  const ledeEl = document.getElementById('ms-lede');
  if (ledeEl) ledeEl.style.display = 'none';
}

function showForm() {
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('lookup-section').style.display = 'block';
  const titleEl = document.getElementById('ms-title');
  if (titleEl) titleEl.textContent = '我的課表';
  const ledeEl = document.getElementById('ms-lede');
  if (ledeEl) ledeEl.style.display = '';
  state.creds = null;
  state.items = [];
  state.packages = [];
  state.lineBound = null;
  const bar = document.getElementById('auth-bar');
  if (bar) bar.innerHTML = '';
}

// ── LINE 綁定（navbar 按鈕 + 彈窗）──────────────────────────────────────────────
const LINE_SVG = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 5.64 2 10.1c0 4 3.58 7.34 8.4 7.98.33.07.78.22.89.5.1.26.06.66.03.92l-.14.86c-.04.26-.2 1.02.9.56 1.1-.46 5.9-3.48 8.06-5.95C21.4 13.3 22 11.77 22 10.1 22 5.64 17.52 2 12 2z"/></svg>';

function renderLineNav() {
  const bar = document.getElementById('auth-bar');
  if (!bar) return;
  if (getToken()) return; // 員工登入時 auth-bar 由 app.js 擁有，不覆蓋
  if (state.lineBound === false) {
    bar.innerHTML = `<button id="ms-bind-btn" class="ms-line-btn" type="button">${LINE_SVG}綁定 LINE</button>`;
    document.getElementById('ms-bind-btn').addEventListener('click', openLineBindModal);
  } else if (state.lineBound === true) {
    bar.innerHTML = '<span class="ms-line-bound">✓ 已綁定 LINE</span>';
  } else {
    bar.innerHTML = '';
  }
}

function closeLineBindModal() {
  document.getElementById('ms-line-overlay').style.display = 'none';
}

function bindDoneBtn() {
  const btn = document.getElementById('lb-done-btn');
  if (btn) btn.addEventListener('click', () => {
    closeLineBindModal();
    if (state.creds) doLookup(state.creds.phone, state.creds.name).catch(() => {});
  });
}

async function openLineBindModal() {
  const overlay = document.getElementById('ms-line-overlay');
  const body = document.getElementById('ms-line-body');
  overlay.style.display = 'flex';
  body.innerHTML = '<p class="lb-loading">產生綁定碼中…</p>';
  try {
    const data = await api('/api/public/line/bind-code', { method: 'POST', body: state.creds });
    const join = data.line_official_url
      ? `<a class="lb-join" href="${escapeHtml(data.line_official_url)}" target="_blank" rel="noopener">${LINE_SVG}點我加入官方 LINE</a>`
      : '<p class="lb-note">尚未設定官方 LINE 連結，請洽櫃台。</p>';
    body.innerHTML = `
      <div class="lb-code">${escapeHtml(String(data.code))}</div>
      <div class="lb-code-note">綁定碼 15 分鐘內有效</div>
      <ol class="lb-steps">
        <li>加入 CHINUP 官方 LINE 帳號為好友</li>
        <li>把上面的 6 位數綁定碼傳給官方帳號</li>
        <li>完成後回此處按「我綁好了」</li>
      </ol>
      ${join}
      <button class="lb-done" type="button" id="lb-done-btn">我綁好了，重新整理</button>`;
    bindDoneBtn();
  } catch (e) {
    if (e.status === 409) {
      body.innerHTML = '<p class="lb-note">此帳號已綁定 LINE。</p><button class="lb-done" type="button" id="lb-done-btn">關閉並重新整理</button>';
      bindDoneBtn();
    } else {
      closeLineBindModal();
      toast(`產生綁定碼失敗：${e.message}`, 'error');
    }
  }
}

// ── Card rendering ───────────────────────────────────────────────────────────

const DOW_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function dateBlock(start_at) {
  const dt = new Date(start_at);
  const dnum = String(dt.getDate());
  const mon = `${String(dt.getMonth() + 1).padStart(2, '0')}月`;
  return `
    <div class="sn-date">
      <span class="sn-mon">${mon}</span>
      <span class="sn-dnum">${dnum}</span>
      <span class="sn-dow">週${DOW_ZH[dt.getDay()]}</span>
    </div>
  `;
}

// 狀態色調：對應 resolveStatus 的 badge class → 運動力學版的點色
function statusTone(cls) {
  if (cls === 'badge-confirmed') return 'ok';
  if (cls === 'badge-cancelled' || cls === 'badge-rejected') return 'err';
  if (cls === 'badge-leave' || cls === 'badge-completed') return 'mute';
  return 'warn'; // waitlisted / pending（待確認/待付款/候補/已遞補待付款）
}

/**
 * Derive a status label and badge class for an item.
 * Booking: confirmed+paid → 已確認, confirmed 未核款 → 待確認, cancelled → 已取消
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
    if (item.status === 'cancelled') return { label: '已取消', cls: 'badge-cancelled' };
    if (item.status === 'confirmed') {
      // 兩階段：admin 核對款項前為「待確認」
      return item.paid
        ? { label: '已確認', cls: 'badge-confirmed' }
        : { label: '待確認', cls: 'badge-waitlisted' };
    }
    return { label: item.status, cls: 'badge-completed' };
  }
  // registration
  if (item.status === 'pending') {
    if (item.order_id) {
      return { label: '已遞補待付款', cls: 'badge-waitlisted' };
    }
    return { label: '待付款', cls: 'badge-waitlisted' };
  }
  if (item.on_leave) {
    return { label: '已請假', cls: 'badge-leave' };
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
  return `<div class="sn-pay">${parts.join(' · ')}</div>`;
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
      data-id="${item.id}">請假</button>`;
  }
  // confirmed / waitlisted
  return `<button
    class="cancel-btn btn btn-danger btn-sm"
    data-kind="registration"
    data-id="${item.id}">取消</button>`;
}

function cardHtml(item, isNext = false) {
  const isBooking = item.kind === 'booking';
  const kindLabel = isBooking
    ? (item.session_type === '1on2' ? '一對二' : '一對一')
    : '團課';

  // 一對一／一對二：教練名前綴「教練：」；團課：課程名稱
  const title = isBooking
    ? `<span class="sn-lead">教練：</span>${escapeHtml(item.coach_display_name || '—')}`
    : escapeHtml(item.course_name || '團課');

  const { label, cls } = resolveStatus(item);
  const tone = statusTone(cls);
  const cancel = cancelButton(item);

  const dt = new Date(item.start_at);
  const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const markNext = isNext && !item.is_past;

  const rowCls = 'sn-row' + (item.is_past ? ' is-past' : '') + (markNext ? ' is-next' : '');

  return `
    <div class="${rowCls}">
      ${dateBlock(item.start_at)}
      <div class="sn-body">
        <div class="sn-l1">
          <span class="sn-kind">${kindLabel}</span>
          ${markNext ? '<span class="sn-next">Next</span>' : ''}
          <span class="sn-title">${title}</span>
        </div>
        <div class="sn-l2">
          <span class="sn-time"><span class="sn-clock">${time}</span></span>
          <span class="sn-status ${tone}"><span class="sn-dot"></span>${escapeHtml(label)}</span>
        </div>
        ${paymentLine(item)}
      </div>
      ${cancel || ''}
    </div>
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

  // 我的方案（有效套餐）
  const PKG_TYPE = { '1on1': '一對一', '1on2': '一對二' };
  const pkgSec = document.getElementById('packages-section');
  if (pkgSec) {
    const pkgs = state.packages || [];
    if (pkgs.length === 0) {
      pkgSec.style.display = 'none';
      pkgSec.innerHTML = '';
    } else {
      pkgSec.style.display = 'block';
      pkgSec.innerHTML =
        '<div class="section-label">我的方案</div>' +
        pkgs.map((p) => {
          const t = PKG_TYPE[p.session_type] || escapeHtml(p.session_type);
          const exp = p.expires_at ? `（到期 ${escapeHtml(String(p.expires_at)).replace(/-/g, '/')}）` : '';
          return `<div class="pkg-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:6px;background:#f8fafc;">
            <span style="font-weight:600;">${t}</span>
            <span style="font-size:13px;color:#334155;">總 ${p.total_sessions} 堂・已登錄 ${p.used_sessions}・剩 ${p.remaining_sessions}${exp}</span>
          </div>`;
        }).join('');
    }
  }

  const filtered = filterItems(state.items, state.filter);
  // 即將到來：由近到遠（最早的在最上、標記 Next）；已結束：由新到舊
  const upcoming = filtered.filter(i => !i.is_past)
    .sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0));
  const past = filtered.filter(i => i.is_past)
    .sort((a, b) => (a.start_at > b.start_at ? -1 : a.start_at < b.start_at ? 1 : 0));

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
    upWrap.innerHTML = upcoming.map((it, i) => cardHtml(it, i === 0)).join('');
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
      pastList.style.display = 'block';
      pastList.innerHTML = past.map(it => cardHtml(it, false)).join('');
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
    : kind === 'booking'
      ? '確定要請假嗎？此堂一對一預約將被取消、名額釋出。'
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
    toast((isLeave || kind === 'booking') ? '已請假' : '已取消', 'success');
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

// 綁定彈窗：點背景關閉
const lbOverlay = document.getElementById('ms-line-overlay');
if (lbOverlay) lbOverlay.addEventListener('click', (e) => { if (e.target === lbOverlay) closeLineBindModal(); });

// Auto-fill from localStorage; auto-query if both present
const { savedPhone, savedName } = autoFillForm();
if (savedPhone && savedName) {
  const phone = savedPhone.replace(/\D/g, '');
  // Auto-query in background; don't block body reveal
  doLookup(phone, savedName).catch(() => {});
}

document.body.style.visibility = 'visible';
