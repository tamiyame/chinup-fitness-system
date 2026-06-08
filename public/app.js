// Shared auth + API helpers.
const TOKEN_KEY = 'chinup.token';
const USER_KEY = 'chinup.user';

// HTML escape — for inserting untrusted user-supplied strings into innerHTML.
// Use textContent instead if you're just setting plain text on one element.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function redirectToLogin() {
  location.href = `/login.html?redirect=${encodeURIComponent(location.pathname)}`;
}

export async function api(path, { method = 'GET', body, redirectOn401 = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) {
    clearAuth();
    // 公開頁（bootPublic）以 redirectOn401:false 探測登入狀態：殘留過期 token 只清掉、
    // 不把匿名訪客導去登入頁。其餘呼叫維持原本「401 → 導登入」行為。
    if (redirectOn401) redirectToLogin();
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
export function dow(n) { return `週${DOW[n]}`; }

// 頁面啟動時：確認身份；若是 admin-only 頁面且不是 admin，導向 home
// Consume OAuth callback: `/#token=xxx` → save to storage, clean URL.
function consumeOAuthHash() {
  if (!location.hash.startsWith('#token=')) return;
  const token = decodeURIComponent(location.hash.slice(7));
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    // remove hash without triggering reload
    history.replaceState(null, '', location.pathname + location.search);
  }
}
consumeOAuthHash();

function bindMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const panel = document.getElementById('nav-mobile');
  if (!toggle || !panel) return;

  function close() {
    panel.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  }
  function open() {
    panel.classList.remove('hidden');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) open(); else close();
  });
  panel.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !toggle.contains(e.target)) close();
  });
  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 768px)').matches) close();
  });
}
bindMobileNav();

export async function bootAuth({ requireAdmin = false } = {}) {
  const token = getToken();
  if (!token) { redirectToLogin(); return null; }

  let user;
  try {
    user = await api('/api/auth/me');
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    return null;
  }

  if (requireAdmin && !['admin', 'owner'].includes(user.role)) {
    location.href = '/';
    return null;
  }

  await renderAuthBar(user);
  // Pages hide <body> via inline style until auth is confirmed. Reveal now.
  document.body.style.visibility = 'visible';
  return user;
}

// Soft public init: show auth bar if logged in; do nothing (no redirect) for anonymous visitors.
export async function bootPublic() {
  const token = getToken();
  if (!token) {
    // No token — anonymous visitor. Just reveal the body and return.
    document.body.style.visibility = 'visible';
    return null;
  }
  let user;
  try {
    user = await api('/api/auth/me', { redirectOn401: false });
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // Token invalid/expired — treat as anonymous, no redirect (api 已清掉殘留 token).
    document.body.style.visibility = 'visible';
    return null;
  }
  await renderAuthBar(user);
  document.body.style.visibility = 'visible';
  return user;
}

export async function renderAuthBar(user) {
  // Show admin nav link only for admin/owner — toggle via .admin-only class
  const showAdmin = ['admin', 'owner'].includes(user.role);
  document.querySelectorAll('.admin-only').forEach((el) => {
    if (showAdmin) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });

  // Show coach nav link only for coach (not admin/owner)
  const showCoach = user.role === 'coach';
  document.querySelectorAll('.coach-only').forEach((el) => {
    if (showCoach) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });

  const el = document.getElementById('auth-bar');
  if (!el) return;
  const badgeMap = {
    owner: '<span class="badge badge-waitlisted" style="font-size:10px;">擁有者</span>',
    admin: '<span class="badge badge-confirmed" style="font-size:10px;">管理者</span>',
    coach: '<span class="badge badge-coach" style="font-size:10px;">教練</span>',
    user:  '<span class="badge badge-open" style="font-size:10px;">會員</span>',
  };
  const badge = badgeMap[user.role] || badgeMap.user;

  // Only admin/owner/coach can be logged in now (members use the public phone+name flow),
  // so identity is just the role badge — no points pill, no name/email line.
  el.innerHTML = `
    <div class="flex items-center gap-2">
      ${badge}
    </div>
    <button id="line-bind-btn" class="btn btn-ghost btn-sm">綁定 LINE</button>
    <button id="logout-btn" class="btn btn-ghost btn-sm">登出</button>
  `;
  document.getElementById('line-bind-btn').addEventListener('click', openLineBindModal);
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearAuth();
    location.href = '/login.html';
  });
}

// ── 員工自助綁定 LINE（auth bar 按鈕 → 彈窗）──────────────────────────────
function ensureLineBindOverlay() {
  let overlay = document.getElementById('line-bind-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'line-bind-overlay';
  overlay.className = 'overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:420px; position:relative; text-align:center;">
      <button id="line-bind-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none" style="position:absolute; top:18px; right:20px;">✕</button>
      <h3 class="section-title" style="margin-bottom:16px;">綁定 LINE 通知</h3>
      <div id="line-bind-body"><p class="subtle">載入中…</p></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
  overlay.querySelector('#line-bind-close').addEventListener('click', () => { overlay.style.display = 'none'; });
  return overlay;
}

async function openLineBindModal() {
  ensureLineBindOverlay().style.display = 'grid';
  await renderLineBindBody();
}

async function renderLineBindBody() {
  const body = document.getElementById('line-bind-body');
  body.innerHTML = '<p class="subtle">載入中…</p>';
  let s;
  try { s = await api('/api/my/line'); }
  catch (e) { body.innerHTML = `<p style="color:#dc2626;">載入失敗：${escapeHtml(e.message)}</p>`; return; }
  if (s.bound) {
    body.innerHTML = `
      <p class="mb-4">✅ 此帳號<strong>已綁定 LINE</strong>，會收到通知。</p>
      <button id="line-unbind-btn" class="btn btn-danger btn-sm">解除綁定</button>`;
    document.getElementById('line-unbind-btn').addEventListener('click', async () => {
      if (!confirm('確定要解除 LINE 綁定嗎？解除後將不再收到 LINE 通知。')) return;
      try { await api('/api/my/line', { method: 'DELETE' }); toast('已解除綁定', 'success'); await renderLineBindBody(); }
      catch (e) { toast(`解除失敗：${e.message}`, 'error'); }
    });
  } else {
    body.innerHTML = `
      <p class="subtle mb-3">尚未綁定。點下方產生綁定碼，加入官方 LINE 後把碼傳給它即可完成。</p>
      <button id="line-gen-btn" class="btn btn-primary btn-sm">產生綁定碼</button>`;
    document.getElementById('line-gen-btn').addEventListener('click', genBindCode);
  }
}

async function genBindCode() {
  const body = document.getElementById('line-bind-body');
  body.innerHTML = '<p class="subtle">產生中…</p>';
  let r;
  try { r = await api('/api/my/line/bind-code', { method: 'POST' }); }
  catch (e) { body.innerHTML = `<p style="color:#dc2626;">產生失敗：${escapeHtml(e.message)}</p>`; return; }
  const lineBtn = r.line_official_url
    ? `<a href="${escapeHtml(r.line_official_url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="margin-top:8px;">點我加入官方 LINE</a>`
    : '<p class="subtle" style="margin-top:8px;">（尚未設定官方 LINE 連結，請先搜尋官方帳號加好友）</p>';
  body.innerHTML = `
    <p class="subtle mb-2">綁定碼（15 分鐘內有效）：</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:6px;text-align:center;background:var(--brand-50);border-radius:10px;padding:14px;">${escapeHtml(r.code)}</div>
    <ol class="subtle" style="margin-top:12px;list-style:none;padding-left:0;line-height:1.8;">
      <li>加入官方 LINE 帳號為好友</li>
      <li>把上面 6 碼傳給官方帳號</li>
      <li>完成後回此處按「我綁好了」</li>
    </ol>
    ${lineBtn}
    <div style="margin-top:14px;"><button id="line-done-btn" class="btn btn-dark btn-sm">我綁好了，重新整理</button></div>`;
  document.getElementById('line-done-btn').addEventListener('click', renderLineBindBody);
}

export async function refreshAuthBar() {
  const user = getUser();
  if (!user) return;
  await renderAuthBar(user);
}
