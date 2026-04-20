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
import { login as authLogin, logout as authLogout, userFromToken } from './services/auth.js';
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
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

app.post('/api/auth/logout', (req, res) => {
  const token = getTokenFromReq(req);
  if (token) authLogout(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireUser, (req, res) => {
  res.json(req.user);
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
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    startScheduler();
  });
}

export { app };
