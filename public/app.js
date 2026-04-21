// Shared auth + API helpers.
const TOKEN_KEY = 'chinup.token';
const USER_KEY = 'chinup.user';

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

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) {
    clearAuth();
    redirectToLogin();
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

  renderAuthBar(user);
  // Pages hide <body> via inline style until auth is confirmed. Reveal now.
  document.body.style.visibility = 'visible';
  return user;
}

function renderAuthBar(user) {
  // Hide admin nav link for non-admin users
  document.querySelectorAll('a[href="/admin.html"]').forEach((el) => {
    el.style.display = ['admin', 'owner'].includes(user.role) ? '' : 'none';
  });

  const el = document.getElementById('auth-bar');
  if (!el) return;
  const badgeMap = {
    owner: '<span class="badge badge-waitlisted" style="font-size:10px;">擁有者</span>',
    admin: '<span class="badge badge-confirmed" style="font-size:10px;">管理者</span>',
    user:  '<span class="badge badge-open" style="font-size:10px;">會員</span>',
  };
  const badge = badgeMap[user.role] || badgeMap.user;
  el.innerHTML = `
    <div class="flex items-center gap-2">
      ${badge}
      <span class="text-sm font-medium">${user.name}</span>
      <span class="subtle hidden md:inline">${user.email}</span>
    </div>
    <button id="logout-btn" class="btn btn-ghost btn-sm">登出</button>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearAuth();
    location.href = '/login.html';
  });
}
