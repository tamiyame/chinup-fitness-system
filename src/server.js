import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db, tx } from './db/connection.js';
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

app.delete('/api/admin/templates/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const tpl = db.prepare('SELECT name FROM course_templates WHERE id = ?').get(id);
  if (!tpl) return res.status(404).json({ error: 'template_not_found' });

  const sessionCount = db.prepare('SELECT COUNT(*) AS c FROM course_sessions WHERE template_id = ?').get(id).c;
  const regCount = db.prepare(`
    SELECT COUNT(*) AS c FROM registrations r
    JOIN course_sessions s ON s.id = r.session_id
    WHERE s.template_id = ?
  `).get(id).c;

  // Wrap in transaction. Existing DBs may have notifications.session_id with
  // no ON DELETE SET NULL (pre-existing FK) — manually null the refs first so
  // the cascade doesn't trip a FOREIGN KEY constraint.
  tx(() => {
    db.prepare(`
      UPDATE notifications SET session_id = NULL
      WHERE session_id IN (SELECT id FROM course_sessions WHERE template_id = ?)
    `).run(id);
    // FK cascade: course_sessions.template_id ON DELETE CASCADE
    //             registrations.session_id   ON DELETE CASCADE
    db.prepare('DELETE FROM course_templates WHERE id = ?').run(id);
  });

  console.log(`[admin] template #${id} '${tpl.name}' deleted by user ${req.user.id} (${sessionCount} sessions, ${regCount} regs)`);
  res.json({ ok: true, sessionsDeleted: sessionCount, registrationsDeleted: regCount });
}));

app.get('/api/admin/sessions/:id/registrations', requireAdmin, asyncHandler((req, res) => {
  res.json(listRegistrationsBySession(Number(req.params.id)));
}));

// --- Course categories ---
app.get('/api/admin/categories', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(
    'SELECT * FROM course_categories WHERE active = 1 ORDER BY sort_order ASC, id ASC'
  ).all();
  res.json(rows);
}));

app.post('/api/admin/categories', requireAdmin, asyncHandler((req, res) => {
  const { name, description, sort_order } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'missing_name' });
  try {
    const info = db.prepare(
      'INSERT INTO course_categories (name, description, sort_order) VALUES (?, ?, ?)'
    ).run(name.trim(), description || null, Number(sort_order) || 0);
    res.status(201).json({ id: info.lastInsertRowid, name: name.trim() });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'name_exists' });
    throw e;
  }
}));

app.patch('/api/admin/categories/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM course_categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'category_not_found' });
  const { name, description, sort_order } = req.body || {};
  try {
    db.prepare(
      'UPDATE course_categories SET name = ?, description = ?, sort_order = ? WHERE id = ?'
    ).run(
      (name ?? existing.name).trim(),
      description ?? existing.description,
      sort_order !== undefined ? Number(sort_order) : existing.sort_order,
      id
    );
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'name_exists' });
    throw e;
  }
}));

app.delete('/api/admin/categories/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  // Soft-delete via active=0 so existing templates keep working even if their
  // category is hidden from the creation dropdown.
  db.prepare('UPDATE course_categories SET active = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
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
