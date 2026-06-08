import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { db, tx } from './db/connection.js';
import {
  createTemplate, editTemplate, listTemplates, getTemplate,
  listOpenSessions, listRegistrationsBySession, setSessionOpen,
  processDeadlines, processReminders,
} from './services/courseService.js';
import { ApiError } from './services/registration.js';
import {
  createCoach as svcCreateCoach,
  getCoach as svcGetCoach,
  getCoachByUser as svcGetCoachByUser,
  listAllCoaches as svcListAllCoaches,
  setCoachActive as svcSetCoachActive,
  updateCoach as svcUpdateCoach,
} from './services/coachService.js';
import {
  addRule as svcAddRule,
  listRules as svcListRules,
  deleteRule as svcDeleteRule,
  addException as svcAddException,
  listExceptions as svcListExceptions,
  deleteException as svcDeleteException,
  computeAvailableSlots as svcComputeSlots,
} from './services/availabilityService.js';
import {
  listCoachBookings as svcListCoachBookings,
  cancelBooking as svcCancelBooking,
  createBookingAnon as svcCreateBookingAnon,
  cancelBookingAnon as svcCancelBookingAnon,
} from './services/bookingService.js';
import {
  createGroupOrder as svcCreateGroupOrder,
  confirmGroupOrder as svcConfirmGroupOrder,
  cancelGroupOrder as svcCancelGroupOrder,
  cancelRegistrationPublic as svcCancelRegPublic,
  takeLeavePublic as svcTakeLeavePublic,
  expirePendingOrders as svcExpireOrders,
  getPublicGroupCourses as svcPublicCourses,
  getPublicSchedule as svcPublicSchedule,
  listPendingOrders as svcListPendingOrders,
} from './services/groupOrderService.js';
import { listActiveCoaches as svcListActive, saveAvatar as svcSaveAvatar } from './services/coachService.js';
import {
  login as authLogin,
  logout as authLogout,
  userFromToken,
  ensureInitialAdmin,
  findOrCreateGoogleUser,
  loginAsGoogleUser,
  createCoachAccount,
} from './services/auth.js';
import { randomBytes } from 'node:crypto';
import { startScheduler } from './scheduler.js';
import { verifySignature, reply as lineReply } from './services/lineClient.js';
import {
  consumeCode,
  unbindByLineUserId,
  resetAllLineBindings,
} from './services/lineBindingService.js';
import { runBackup, listBackups, safeBackupPath } from './services/backupService.js';
import { createReadStream } from 'node:fs';
import { createRateLimiter } from './middleware/rateLimit.js';
import { validateDiscount, getOneOnOnePrice, getOneOnTwoPrice, getOneOnOnePriceByType, listDiscountCodes, createDiscountCode, updateDiscountCode, deleteDiscountCode, getSetting, setSetting, getBankInfo, getLineOfficialUrl } from './services/discountService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
// Railway / 任何 reverse proxy 後面要設 trust proxy 才能從 X-Forwarded-For 取真 client IP（rate limiter 需要）
app.set('trust proxy', 1);

// Login: 30 / 15min — 業界 brute-force 防禦的 lenient end（嚴格端是 5–10），考量到
//   (a) 同辦公室 / 同網路使用者共用 NAT 出口 IP
//   (b) test suite 連跑時容易誤觸
//   選 30 仍然把暴力破解速率壓到 120/小時，配合 scrypt 雜湊已足夠
const loginLimiter = createRateLimiter({ name: 'login', windowMs: 15 * 60_000, max: 30 });
app.use(express.json({
  limit: '3mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Phase 3A · /my-schedule unification: redirect legacy URLs + serve canonical path
app.get('/my.html', (req, res) => res.redirect(301, '/my-schedule'));
app.get('/my-bookings.html', (req, res) => res.redirect(301, '/my-schedule'));
app.get('/line.html', (req, res) => res.redirect(301, '/my-schedule'));
app.get('/my-schedule', (req, res) =>
  res.sendFile(resolve(__dirname, '../public/my-schedule.html'))
);

app.use(express.static(resolve(__dirname, '../public')));
app.use('/avatars', express.static(resolve(__dirname, '../data/avatars'), { maxAge: '7d' }));

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

function requireCoach(req, res, next) {
  requireUser(req, res, () => {
    if (!['coach', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'coach_only' });
    }
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
app.post('/api/auth/login', loginLimiter, asyncHandler((req, res) => {
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
    // Only admin/coach may log in (members use the public phone+name flow).
    if (user.role === 'user') return res.redirect('/login.html?err=user_login_disabled');
    const session = loginAsGoogleUser(user);

    // Pass token back via URL fragment (not query) so it doesn't hit logs
    const landing = ['admin', 'owner'].includes(user.role) ? '/admin.html' : '/coach.html';
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

  // Wrap in transaction. Several FKs reference course_sessions / registrations
  // without ON DELETE SET NULL (point_transactions added by Phase 2; notifications
  // pre-existing). Null those refs first so the template cascade doesn't trip
  // a FOREIGN KEY constraint.
  tx(() => {
    db.prepare(`
      UPDATE notifications SET session_id = NULL
      WHERE session_id IN (SELECT id FROM course_sessions WHERE template_id = ?)
    `).run(id);
    db.prepare(`
      UPDATE point_transactions SET related_session_id = NULL
      WHERE related_session_id IN (SELECT id FROM course_sessions WHERE template_id = ?)
    `).run(id);
    db.prepare(`
      UPDATE point_transactions SET related_registration_id = NULL
      WHERE related_registration_id IN (
        SELECT r.id FROM registrations r
        JOIN course_sessions s ON s.id = r.session_id
        WHERE s.template_id = ?
      )
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

// 手動開放/關閉單一場次（is_open）。關閉 → 報名頁隱藏且不可報名，現有報名不動。
app.patch('/api/admin/sessions/:id', requireAdmin, asyncHandler((req, res) => {
  const { is_open } = req.body || {};
  if (typeof is_open !== 'boolean') return res.status(400).json({ error: 'invalid_is_open' });
  res.json(setSessionOpen(Number(req.params.id), is_open));
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
  const trimmed = name.trim();

  // Check for any existing row (including old soft-deleted active=0 rows so
  // admins can re-create a name they previously removed).
  const existing = db.prepare('SELECT id, active FROM course_categories WHERE name = ?').get(trimmed);
  if (existing && existing.active === 1) {
    return res.status(409).json({ error: 'name_exists' });
  }
  if (existing) {
    db.prepare(
      'UPDATE course_categories SET active = 1, description = ?, sort_order = ? WHERE id = ?'
    ).run(description || null, Number(sort_order) || 0, existing.id);
    return res.status(200).json({ id: existing.id, name: trimmed, reactivated: true });
  }

  const info = db.prepare(
    'INSERT INTO course_categories (name, description, sort_order) VALUES (?, ?, ?)'
  ).run(trimmed, description || null, Number(sort_order) || 0);
  res.status(201).json({ id: info.lastInsertRowid, name: trimmed });
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
  // Hard delete — matches admin expectation ("delete means gone"). Templates
  // store the category name as a plain string, so removal never orphans them.
  const info = db.prepare('DELETE FROM course_categories WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'category_not_found' });
  res.json({ ok: true });
}));

// --- User management ---
// Admin + owner can see the roster. Only owner can change roles.
app.get('/api/admin/users', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.notification_preference,
           (u.google_id IS NOT NULL) AS has_google, u.line_user_id, u.created_at
    FROM users u
    ORDER BY u.id ASC
  `).all();
  res.json(rows);
}));

// 管理用：清空所有使用者的 LINE 綁定（含教練/管理者），讓全體重新綁定。
app.post('/api/admin/line/reset-all', requireAdmin, asyncHandler((req, res) => {
  res.json(resetAllLineBindings());
}));

app.patch('/api/admin/users/:id/role', requireOwner, asyncHandler((req, res) => {
  const targetId = Number(req.params.id);
  const { role } = req.body || {};
  if (!['user', 'coach', 'admin', 'owner'].includes(role)) {
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

// --- One-on-one: admin coach management ---

app.post('/api/admin/coaches/account', requireAdmin, asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  const r = createCoachAccount({ email, password, name });
  res.status(201).json({ user_id: r.user.id, coach_pending: true });
}));

app.get('/api/admin/coaches', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.name AS user_name, u.email AS user_email
    FROM coaches c JOIN users u ON u.id = c.user_id
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();
  res.json(rows);
}));

app.post('/api/admin/coaches', requireAdmin, asyncHandler((req, res) => {
  const { user_id, display_name, specialty, bio, sort_order } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'missing_user_id' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  if (svcGetCoachByUser(user.id)) return res.status(409).json({ error: 'coach_exists' });

  tx(() => {
    db.prepare("UPDATE users SET role = 'coach' WHERE id = ?").run(user.id);
    svcCreateCoach({
      userId: user.id,
      displayName: display_name || user.name,
      specialty,
      bio,
      sortOrder: sort_order || 0,
    });
  });
  const created = svcGetCoachByUser(user.id);
  res.status(201).json(created);
}));

app.patch('/api/admin/coaches/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const { display_name, specialty, bio, sort_order, is_active } = req.body || {};
  const existing = svcGetCoach(id);
  if (!existing) return res.status(404).json({ error: 'coach_not_found' });
  svcUpdateCoach(id, { displayName: display_name, specialty, bio, sortOrder: sort_order });
  if (typeof is_active === 'boolean' || is_active === 0 || is_active === 1) {
    svcSetCoachActive(id, !!is_active);
  }
  res.json(svcGetCoach(id));
}));

app.delete('/api/admin/coaches/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const coach = svcGetCoach(id);
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });

  tx(() => {
    svcSetCoachActive(id, false);
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(coach.user_id);
  });
  res.json({ ok: true, demoted_user_id: coach.user_id });
}));

function loadCoachForUser(req, res) {
  const coach = svcGetCoachByUser(req.user.id);
  if (!coach) {
    res.status(404).json({ error: 'coach_record_not_found' });
    return null;
  }
  return coach;
}

// --- One-on-one: coach self-service ---

app.get('/api/coach/me', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(coach);
}));

app.patch('/api/coach/me/profile', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { display_name, specialty, bio } = req.body || {};
  svcUpdateCoach(coach.id, { displayName: display_name, specialty, bio });
  res.json(svcGetCoach(coach.id));
}));

app.get('/api/coach/me/rules', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(svcListRules(coach.id));
}));

app.post('/api/coach/me/rules', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { day_of_week, start_time, end_time, effective_from, effective_to } = req.body || {};
  const result = svcAddRule({
    coachId: coach.id,
    dayOfWeek: Number(day_of_week),
    startTime: start_time,
    endTime: end_time,
    effectiveFrom: effective_from,
    effectiveTo: effective_to,
  });
  res.status(201).json(result);
}));

app.delete('/api/coach/me/rules/:id', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  svcDeleteRule({ coachId: coach.id, ruleId: Number(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/coach/me/exceptions', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(svcListExceptions(coach.id));
}));

app.post('/api/coach/me/exceptions', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { exception_date, type, start_time, end_time, note } = req.body || {};
  const result = svcAddException({
    coachId: coach.id,
    exceptionDate: exception_date,
    type,
    startTime: start_time,
    endTime: end_time,
    note,
  });
  res.status(201).json(result);
}));

app.delete('/api/coach/me/exceptions/:id', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  svcDeleteException({ coachId: coach.id, exceptionId: Number(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/coach/me/bookings', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  res.json(svcListCoachBookings(coach.id));
}));

app.get('/api/coach/me/availability-preview', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to }));
}));

app.post('/api/coach/me/avatar', requireCoach, asyncHandler((req, res) => {
  const coach = loadCoachForUser(req, res);
  if (!coach) return;
  const { avatar_base64 } = req.body || {};
  const result = svcSaveAvatar({ coachId: coach.id, base64: avatar_base64 });
  res.json(result);
}));

// --- Public (no auth): anon booking / group orders / phone lookup ---
app.get('/api/public/group-courses', asyncHandler((req, res) => {
  res.json(svcPublicCourses());
}));

app.get('/api/public/one-on-one-price', asyncHandler((req, res) => {
  // price 維持向後相容（= 1對1 單堂價）；另回傳 1對1/1對2 兩種單堂價供前端切換。
  res.json({ price: getOneOnOnePrice(), oneOnOnePrice: getOneOnOnePrice(), oneOnTwoPrice: getOneOnTwoPrice() });
}));

app.post('/api/public/discounts/validate', asyncHandler((req, res) => {
  const { code, phone, kind, sessionIds, sessionType } = req.body || {};
  let subtotal;
  if (kind === 'one_on_one') {
    // 與 /api/public/bookings 一致：非法 sessionType 直接擋下，避免報出 1對1 價、送出時才失敗
    if (sessionType != null && sessionType !== '1on1' && sessionType !== '1on2') {
      return res.status(400).json({ error: 'invalid_session_type' });
    }
    subtotal = getOneOnOnePriceByType(sessionType);
  } else {
    // group：由 sessionIds 即時加總付款場次單價（server 權威）
    const ids = (sessionIds || []).map(Number);
    subtotal = ids.reduce((sum, sid) => {
      const s = db.prepare('SELECT template_id FROM course_sessions WHERE id=?').get(sid);
      const tpl = s ? db.prepare('SELECT price_per_session FROM course_templates WHERE id=?').get(s.template_id) : null;
      return sum + (tpl ? tpl.price_per_session : 0);
    }, 0);
  }
  const v = validateDiscount({ code, phone, subtotal });
  res.json({ valid: true, discount_type: v.type, discount_value: v.value, discount_amount: v.discountAmount, original: v.subtotal, final_total: v.finalTotal });
}));

app.post('/api/public/bookings', asyncHandler((req, res) => {
  const { coachId, startAt, name, phone, note, discountCode, sessionType } = req.body || {};
  const r = svcCreateBookingAnon({ coachId: Number(coachId), startAt, name, phone, note: note || null, discountCode: discountCode || null, sessionType: sessionType || '1on1' });
  res.status(201).json(r);
}));

app.post('/api/public/group-orders', asyncHandler((req, res) => {
  const { name, phone, paySessionIds, waitlistSessionIds, discountCode } = req.body || {};
  const r = svcCreateGroupOrder({
    name, phone,
    paySessionIds: (paySessionIds || []).map(Number),
    waitlistSessionIds: (waitlistSessionIds || []).map(Number),
    discountCode: discountCode || null,
  });
  res.status(201).json(r);
}));

app.post('/api/public/my', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcPublicSchedule({ phone, name }));
}));

app.delete('/api/public/bookings/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcCancelBookingAnon({ bookingId: Number(req.params.id), phone, name }));
}));

app.delete('/api/public/registrations/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcCancelRegPublic({ registrationId: Number(req.params.id), phone, name }));
}));

// 團課「今日請假」：已付款場次標為請假（釋名額遞補、不退款、不取消訂單）
app.post('/api/public/registrations/:id/leave', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcTakeLeavePublic({ registrationId: Number(req.params.id), phone, name }));
}));

app.delete('/api/public/group-orders/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(svcCancelGroupOrder({ orderId: Number(req.params.id), phone, name }));
}));

// --- One-on-one: public + member endpoints ---

app.get('/api/coaches', asyncHandler((req, res) => {
  res.json(svcListActive());
}));

app.get('/api/coaches/:id', asyncHandler((req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach || !coach.is_active) return res.status(404).json({ error: 'coach_not_found' });
  res.json(coach);
}));

app.get('/api/coaches/:id/availability', asyncHandler((req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach || !coach.is_active) return res.status(404).json({ error: 'coach_not_found' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to }));
}));

// Kept for coach 緊急取消 (coach has a token; member login is disabled).
app.delete('/api/bookings/:id', requireUser, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'booking_not_found' });

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(booking.coach_id);
  const actorIsCoach = coach && coach.user_id === req.user.id;
  const { reason } = req.body || {};

  svcCancelBooking({
    bookingId: id,
    actorUserId: req.user.id,
    isCoach: actorIsCoach,
    reason: actorIsCoach ? (reason || null) : null,
  });
  res.json({ ok: true });
}));

// ─── Phase 3C · LINE notification endpoints ───

app.post('/api/line/webhook', (req, res) => {
  // Verify HMAC signature (LINE_MOCK=1 bypasses inside verifySignature)
  if (!verifySignature(req.rawBody, req.header('X-Line-Signature'))) {
    return res.status(401).end();
  }

  const events = Array.isArray(req.body?.events) ? req.body.events : [];

  for (const event of events) {
    try {
      if (event.type === 'message' && event.message?.type === 'text') {
        handleLineTextMessage(event);
      } else if (event.type === 'follow') {
        lineReply(event.replyToken, '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。')
          .catch((e) => console.error('[line follow reply]', e));
      } else if (event.type === 'unfollow') {
        unbindByLineUserId(event.source?.userId);
      }
    } catch (e) {
      console.error('[line-webhook event handler]', e);
    }
  }

  // Always 200 so LINE doesn't retry
  res.status(200).end();
});

function handleLineTextMessage(event) {
  const text = (event.message?.text || '').trim();
  const lineUserId = event.source?.userId;
  const replyToken = event.replyToken;
  if (!lineUserId || !replyToken) return;

  if (!/^\d{6}$/.test(text)) {
    lineReply(replyToken, '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。')
      .catch((e) => console.error('[line nonmatch reply]', e));
    return;
  }

  const result = consumeCode(text, lineUserId);
  let msg;
  switch (result.outcome) {
    case 'bound':
      msg = '✅ 綁定成功！日後課程通知會送到這裡。';
      break;
    case 'invalid_code':
      msg = '❌ 代碼無效或已過期，請回網站重新產生。';
      break;
    case 'this_line_already_bound':
      msg = '此 LINE 帳號已綁定其他 chinup 帳號，請先解除。';
      break;
    case 'chinup_already_bound':
      msg = '此 chinup 帳號已綁定其他 LINE，請先解除。';
      break;
    default:
      msg = '處理中發生問題，請稍後再試。';
  }
  lineReply(replyToken, msg).catch((e) => console.error('[line bind reply]', e));
}

app.get('/api/admin/notifications', requireAdmin, asyncHandler((req, res) => {
  const rows = db.prepare(`
    SELECT n.*, u.email FROM notifications n
    JOIN users u ON u.id = n.user_id
    ORDER BY n.sent_at DESC LIMIT 100
  `).all();
  res.json(rows);
}));

app.get('/api/admin/group-orders', requireAdmin, asyncHandler((req, res) => {
  res.json(svcListPendingOrders());
}));
app.post('/api/admin/group-orders/:id/confirm', requireAdmin, asyncHandler((req, res) => {
  res.json(svcConfirmGroupOrder({ orderId: Number(req.params.id), actorId: req.user.id }));
}));
app.post('/api/admin/group-orders/:id/cancel', requireAdmin, asyncHandler((req, res) => {
  const o = db.prepare('SELECT customer_phone, customer_name FROM group_orders WHERE id=?').get(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'order_not_found' });
  res.json(svcCancelGroupOrder({ orderId: Number(req.params.id), phone: o.customer_phone, name: o.customer_name }));
}));

// 手動觸發排程（用於測試 / 管理者按鈕）
app.post('/api/admin/jobs/process-deadlines', requireAdmin, asyncHandler((req, res) => {
  res.json({ processed: processDeadlines() });
}));

app.post('/api/admin/jobs/send-reminders', requireAdmin, asyncHandler((req, res) => {
  res.json({ sent: processReminders() });
}));

app.post('/api/admin/jobs/expire-orders', requireAdmin, asyncHandler((req, res) => {
  res.json(svcExpireOrders());
}));

app.get('/api/admin/backups', requireAdmin, asyncHandler((req, res) => {
  res.json(listBackups());
}));

app.post('/api/admin/backups/run', requireAdmin, asyncHandler((req, res) => {
  const r = runBackup();
  res.status(r.ok ? 200 : 500).json(r);
}));

app.get('/api/admin/backups/:file', requireAdmin, asyncHandler((req, res) => {
  const full = safeBackupPath(req.params.file);
  if (!full) return res.status(404).json({ error: 'not_found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${basename(full)}"`);
  createReadStream(full).pipe(res);
}));

// --- Admin: Discount Codes CRUD ---
app.get('/api/admin/discount-codes', requireAdmin, asyncHandler((req, res) => res.json(listDiscountCodes())));
app.post('/api/admin/discount-codes', requireAdmin, asyncHandler((req, res) => res.status(201).json(createDiscountCode(req.body || {}))));
app.patch('/api/admin/discount-codes/:id', requireAdmin, asyncHandler((req, res) => res.json(updateDiscountCode(Number(req.params.id), req.body || {}))));
app.delete('/api/admin/discount-codes/:id', requireAdmin, asyncHandler((req, res) => res.json(deleteDiscountCode(Number(req.params.id)))));

// --- Admin: Settings ---
function settingsPayload() {
  return {
    one_on_one_price: Number(getSetting('one_on_one_price') || '1500'),
    one_on_two_price: Number(getSetting('one_on_two_price') || '2000'),
    bank_info: getBankInfo(),
    line_official_url: getLineOfficialUrl(),
  };
}
app.get('/api/admin/settings', requireAdmin, asyncHandler((req, res) => {
  res.json(settingsPayload());
}));
app.patch('/api/admin/settings', requireAdmin, asyncHandler((req, res) => {
  const b = req.body || {};
  // 先驗證所有提供的欄位，全部通過才寫入，避免部分寫入造成狀態不一致
  const writes = [];
  if (b.one_on_one_price !== undefined) {
    const p = Number(b.one_on_one_price);
    if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: 'invalid_price' });
    writes.push(['one_on_one_price', String(p)]);
  }
  if (b.one_on_two_price !== undefined) {
    const p = Number(b.one_on_two_price);
    if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: 'invalid_price' });
    writes.push(['one_on_two_price', String(p)]);
  }
  if (b.bank_info !== undefined) {
    const bank = String(b.bank_info).trim();
    if (!bank) return res.status(400).json({ error: 'invalid_bank_info' });
    writes.push(['bank_info', bank]);
  }
  if (b.line_official_url !== undefined) {
    const url = String(b.line_official_url).trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid_line_url' });
    writes.push(['line_official_url', url]); // 空字串代表清除（不顯示按鈕）
  }
  tx(() => { for (const [k, v] of writes) setSetting(k, v); });
  res.json(settingsPayload());
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
