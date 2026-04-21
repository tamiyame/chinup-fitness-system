import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db } from './db/connection.js';
import {
  createTemplate, editTemplate, listTemplates, getTemplate,
  listOpenSessions, listRegistrationsBySession, listUserRegistrations,
  processDeadlines, processReminders,
} from './services/courseService.js';
import { register, cancelRegistration, ApiError } from './services/registration.js';
import {
  login as authLogin,
  logout as authLogout,
  userFromToken,
  ensureInitialAdmin,
  registerWithPassword,
  findOrCreateGoogleUser,
  loginAsGoogleUser,
} from './services/auth.js';
import { randomBytes } from 'node:crypto';
import { startScheduler } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(resolve(__dirname, '../public')));

// --- 身分驗證：從 Authorization: Bearer <token> 取 token ---
function getTokenFromReq(req) {
  const h = req.header('Authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function requireUser(req, res, next) {
  const user = userFromToken(getTokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!['admin', 'owner'].includes(req.user.role)) return res.status(403).json({ error: 'admin_only' });
    next();
  });
}

function requireOwner(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
    next();
  });
}

function asyncHandler(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.then === 'function') {
        result.catch((e) => handleError(e, res));
      }
    } catch (e) {
      handleError(e, res);
    }
  };
}

function handleError(e, res) {
  if (e instanceof ApiError) {
    return res.status(e.status).json({ error: e.code, detail: e.detail });
  }
  console.error('[server error]', e);
  return res.status(500).json({ error: 'internal', message: e.message });
}

// --- Public ---
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Auth ---
app.post('/api/auth/login', asyncHandler((req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
  const result = authLogin({ email, password });
  res.json(result);
}));

app.post('/api/auth/register', asyncHandler((req, res) => {
  const result = registerWithPassword(req.body || {});
  res.status(201).json(result);
}));

app.post('/api/auth/logout', (req, res) => {
  const token = getTokenFromReq(req);
  if (token) authLogout(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireUser, (req, res) => {
  res.json(req.user);
});

// --- Google OAuth ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// Ephemeral CSRF state store (single instance is fine for Railway 1-replica).
// Keys auto-expire after 10 min.
const oauthStates = new Map();
function rememberState(state) {
  oauthStates.set(state, Date.now());
  // cleanup expired
  for (const [k, ts] of oauthStates) {
    if (Date.now() - ts > 10 * 60 * 1000) oauthStates.delete(k);
  }
}
function consumeState(state) {
  const ok = oauthStates.has(state);
  oauthStates.delete(state);
  return ok;
}

function googleRedirectUri(req) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/api/auth/google/callback`;
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).send('Google OAuth not configured');
  const state = randomBytes(16).toString('hex');
  rememberState(state);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).send('Google OAuth not configured');
    }
    const { code, state, error } = req.query;
    if (error) return res.redirect('/login.html?err=' + encodeURIComponent(error));
    if (!code || !state) return res.redirect('/login.html?err=invalid_callback');
    if (!consumeState(state)) return res.redirect('/login.html?err=invalid_state');

    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error('[google] token exchange failed:', tokens);
      return res.redirect('/login.html?err=google_token_failed');
    }

    // Get userinfo
    const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const gu = await userResp.json();
    if (!gu.id || !gu.email) {
      console.error('[google] userinfo failed:', gu);
      return res.redirect('/login.html?err=google_userinfo_failed');
    }

    const user = findOrCreateGoogleUser({ googleId: gu.id, email: gu.email, name: gu.name });
    const session = loginAsGoogleUser(user);

    // Pass token back via URL fragment (not query) so it doesn't hit logs
    const landing = user.role === 'admin' ? '/admin.html' : '/';
    res.redirect(`${landing}#token=${session.token}`);
  } catch (e) {
    console.error('[google] callback error:', e);
    res.redirect('/login.html?err=google_callback_error');
  }
});

// --- Browse courses (any authenticated user) ---
app.get('/api/sessions', asyncHandler((req, res) => {
  res.json(listOpenSessions());
}));

app.get('/api/my/registrations', requireUser, asyncHandler((req, res) => {
  res.json(listUserRegistrations(req.user.id));
}));

app.post('/api/sessions/:id/register', requireUser, asyncHandler((req, res) => {
  const result = register({ sessionId: Number(req.params.id), userId: req.user.id });
  res.status(201).json(result);
}));

app.delete('/api/registrations/:id', requireUser, asyncHandler((req, res) => {
  const result = cancelRegistration({ registrationId: Number(req.params.id), userId: req.user.id });
  res.json(result);
}));

// --- Admin ---
app.get('/api/admin/templates', requireAdmin, asyncHandler((req, res) => {
  res.json(listTemplates());
}));

app.get('/api/admin/templates/:id', requireAdmin, asyncHandler((req, res) => {
  res.json(getTemplate(Number(req.params.id)));
}));

app.post('/api/admin/templates', requireAdmin, asyncHandler((req, res) => {
  const result = createTemplate(req.body);
  res.status(201).json(result);
}));

app.patch('/api/admin/templates/:id', requireAdmin, asyncHandler((req, res) => {
  const result = editTemplate(Number(req.params.id), req.body);
  res.json(result);
}));

app.get('/api/admin/sessions/:id/registrations', requireAdmin, asyncHandler((req, res) => {
  res.json(listRegistrationsBySession(Number(req.params.id)));
}));

// --- User management ---
// Admin + owner can see the roster. Only owner can change roles.
app.get('/api/admin/users', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT id, name, email, phone, role, notification_preference,
           (google_id IS NOT NULL) AS has_google, created_at
    FROM users ORDER BY id ASC
  `).all();
  res.json(rows);
}));

app.patch('/api/admin/users/:id/role', requireOwner, asyncHandler((req, res) => {
  const targetId = Number(req.params.id);
  const { role } = req.body || {};
  if (!['user', 'admin', 'owner'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'cannot_change_own_role' });
  }

  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  // Prevent demoting the last owner (keeps the app always recoverable).
  if (target.role === 'owner' && role !== 'owner') {
    const ownerCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'").get().c;
    if (ownerCount <= 1) return res.status(400).json({ error: 'last_owner' });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  res.json({ ok: true, id: targetId, role });
}));

app.get('/api/admin/notifications', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT n.*, u.email FROM notifications n
    JOIN users u ON u.id = n.user_id
    ORDER BY n.sent_at DESC LIMIT 100
  `).all();
  res.json(rows);
}));

// 手動觸發排程（用於測試 / 管理者按鈕）
app.post('/api/admin/jobs/process-deadlines', requireAdmin, asyncHandler((req, res) => {
  res.json({ processed: processDeadlines() });
}));

app.post('/api/admin/jobs/send-reminders', requireAdmin, asyncHandler((req, res) => {
  res.json({ sent: processReminders() });
}));

const PORT = Number(process.env.PORT || 3000);

if (process.env.NODE_ENV !== 'test') {
  // Bootstrap: migrations already applied on DB open; ensure an admin exists.
  ensureInitialAdmin();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on port ${PORT}`);
    startScheduler();
  });
}

export { app };
