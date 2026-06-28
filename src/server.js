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
  listPendingPaymentBookings as svcListPendingPaymentBookings,
  confirmBookingPayment as svcConfirmBookingPayment,
  listConfirmedPayments as svcListConfirmedPayments,
  cancelBookingAdmin as svcCancelBookingAdmin,
  refundBookingAdmin as svcRefundBookingAdmin,
  confirmBookingPaymentGroup as svcConfirmBookingPaymentGroup,
  cancelBookingAdminGroup as svcCancelBookingAdminGroup,
  refundBookingGroupAdmin as svcRefundBookingGroupAdmin,
  previewCoachRegister as svcPreviewRegister,
  createCoachRegister as svcCreateRegister,
  rescheduleBooking as svcRescheduleBooking,
  reassignBooking as svcReassignBooking,
  cancelCoachGroup as svcCancelCoachGroup,
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
  refundGroupOrder as svcRefundGroupOrder,
} from './services/groupOrderService.js';
import { listActiveCoaches as svcListActive, saveAvatar as svcSaveAvatar } from './services/coachService.js';
import {
  login as authLogin,
  logout as authLogout,
  changePassword as authChangePassword,
  userFromToken,
  ensureInitialAdmin,
  findOrCreateGoogleUser,
  loginAsGoogleUser,
  createCoachAccount,
} from './services/auth.js';
import { randomBytes } from 'node:crypto';
import { startScheduler } from './scheduler.js';
import { verifySignature, replyOrLog } from './services/lineClient.js';
import {
  consumeCode,
  unbindByLineUserId,
  resetAllLineBindings,
  generateBindCode,
  unbindByUserId,
  requestPublicBindCode,
} from './services/lineBindingService.js';
import { runBackup, listBackups, safeBackupPath } from './services/backupService.js';
import { createReadStream } from 'node:fs';
import { createRateLimiter } from './middleware/rateLimit.js';
import { validateDiscount, getOneOnOnePrice, getOneOnTwoPrice, getOneOnOnePriceByType, listDiscountCodes, createDiscountCode, updateDiscountCode, deleteDiscountCode, getSetting, setSetting, getBankInfo, getLineOfficialUrl, getGcalCalendarId, getBookingHourlyCapacity, getGroupOrderExpiryHours, listActiveDiscountCodes } from './services/discountService.js';
import { isValidPhone, findOrCreateUserByPhone } from './services/userService.js';
import { syncBookingCreate, syncBookingCancel } from './services/gcalSync.js';
import {
  createPackage as svcCreatePackage,
  listPackagesForMember as svcListPackages,
  adjustRemaining as svcAdjustRemaining,
  archivePackage as svcArchivePackage,
  restorePackage as svcRestorePackage,
} from './services/packageService.js';
import { getCoachWeek as svcGetCoachWeek, searchCustomers as svcSearchCustomers } from './services/coachCalendarService.js';
import { sendBookingConfirmation } from './services/emailService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
// Railway / 任何 reverse proxy 後面要設 trust proxy 才能從 X-Forwarded-For 取真 client IP（rate limiter 需要）
app.set('trust proxy', 1);

// Login: 30 / 15min — 業界 brute-force 防禦的 lenient end（嚴格端是 5–10），考量到
//   (a) 同辦公室 / 同網路使用者共用 NAT 出口 IP
//   (b) test suite 連跑時容易誤觸
//   選 30 仍然把暴力破解速率壓到 120/小時，配合 scrypt 雜湊已足夠
const loginLimiter = createRateLimiter({ name: 'login', windowMs: 15 * 60_000, max: 30 });
const changePwLimiter = createRateLimiter({ name: 'change-password', windowMs: 15 * 60_000, max: 20 });
// 公開預約：20/min/IP——正常顧客一分鐘約 1-2 筆綽綽有餘；同時壓住
// freebusy 放大（不同日期參數可繞過 60s 快取打到 Google API）與濫用 email 確認信
const bookingLimiter = createRateLimiter({ name: 'public-booking', windowMs: 60_000, max: 20 });
const lineBindLimiter = createRateLimiter({ name: 'public-line-bind', windowMs: 60_000, max: 10 });
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

// 管理者 = 有管理者標籤的教練（is_admin=1）。標籤的不變式由寫入端保證只落在 coach 上。
function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'admin_only' });
    next();
  });
}

function requireCoach(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'coach') return res.status(403).json({ error: 'coach_only' });
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

// 修改密碼（登入頁）：需 email + 目前密碼 + 新密碼；限流；僅可登入帳號可改。
app.post('/api/auth/change-password', changePwLimiter, asyncHandler((req, res) => {
  const { email, currentPassword, newPassword } = req.body || {};
  if (!email || !currentPassword || !newPassword) return res.status(400).json({ error: 'missing_fields' });
  authChangePassword({ email, currentPassword, newPassword });
  res.json({ ok: true });
}));

app.get('/api/auth/me', requireUser, (req, res) => {
  res.json(req.user);
});

// --- 員工自助綁定 LINE（登入即可用：教練/管理者/owner）---
const getMyLineStmt = db.prepare('SELECT line_user_id FROM users WHERE id = ?');
app.get('/api/my/line', requireUser, (req, res) => {
  const row = getMyLineStmt.get(req.user.id);
  res.json({ bound: !!(row && row.line_user_id), line_official_url: getLineOfficialUrl() });
});
app.post('/api/my/line/bind-code', requireUser, asyncHandler((req, res) => {
  // 已綁定者不再發碼（前端本就會隱藏發碼按鈕，這裡是直接呼叫 API 的防線）。
  // 想換綁需先 DELETE 解除，與 consumeCode 的 1 帳號↔1 LINE 守門一致。
  const existing = getMyLineStmt.get(req.user.id);
  if (existing && existing.line_user_id) {
    return res.status(409).json({ error: 'already_bound' });
  }
  const { code, expires_at } = generateBindCode(req.user.id);
  res.json({ code, expires_at, line_official_url: getLineOfficialUrl() });
}));
app.delete('/api/my/line', requireUser, (req, res) => {
  unbindByUserId(req.user.id);
  res.json({ ok: true });
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
    const landing = user.is_admin ? '/admin.html' : '/coach.html';
    res.redirect(`${landing}#token=${session.token}`);
  } catch (e) {
    console.error('[google] callback error:', e);
    res.redirect('/login.html?err=google_callback_error');
  }
});

// ── Gmail 寄信授權（一次性）──────────────────────────────────────────
// 後台按鈕 → start 取授權 URL → Google 同意 → callback 一次性顯示 refresh token，
// 由業主自行貼到 Railway 環境變數 GMAIL_REFRESH_TOKEN（不落 DB、不寫檔）。
const gmailAuthStates = new Map();
app.post('/api/admin/gmail-auth/start', requireAdmin, (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'google_not_configured' });
  const state = randomBytes(16).toString('hex');
  gmailAuthStates.set(state, Date.now());
  for (const [k, ts] of gmailAuthStates) {
    if (Date.now() - ts > 10 * 60 * 1000) gmailAuthStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: gmailRedirectUri(req),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

function gmailRedirectUri(req) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/api/admin/gmail-auth/callback`;
  return `${req.protocol}://${req.get('host')}/api/admin/gmail-auth/callback`;
}

app.get('/api/admin/gmail-auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    // error 參數不回顯（避免 HTML injection）；只允許白名單字元摘要進 log
    if (error) {
      console.error('[gmail-auth] consent error:', String(error).replace(/[^\w.-]/g, '').slice(0, 50));
      return res.status(400).send('授權未完成（Google 回報錯誤或您取消了授權），請回後台重新發起。');
    }
    if (!code || !state || !gmailAuthStates.has(String(state))) return res.status(400).send('授權連結無效或已過期，請回後台重新發起。');
    gmailAuthStates.delete(String(state));
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: gmailRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.refresh_token) {
      // 不印 tokens 物件——重複授權時 Google 可能回含 access_token 的部分成功內容
      console.error('[gmail-auth] token exchange failed:', `HTTP ${tokenResp.status}`, tokens?.error || (tokens?.refresh_token ? '' : 'no_refresh_token'));
      return res.status(400).send('未取得 refresh token。請確認 OAuth 同意畫面已發布正式版，並於授權時勾選同意；如先前已授權過，請至 Google 帳號「安全性→第三方存取」移除本應用程式後重試。');
    }
    res.send(`<!DOCTYPE html><html lang="zh-TW"><meta charset="UTF-8"><body style="font-family:sans-serif;max-width:640px;margin:40px auto">
<h2>Gmail 寄信授權成功</h2>
<p>請把下方 refresh token 完整複製，貼到 Railway 環境變數 <code>GMAIL_REFRESH_TOKEN</code>，存檔後服務會自動重啟生效。</p>
<p><strong>此 token 僅顯示這一次，本系統不會儲存。</strong>完成後請關閉此頁。</p>
<textarea readonly style="width:100%;height:90px;font-size:13px" onclick="this.select()">${tokens.refresh_token}</textarea>
</body></html>`);
  } catch (e) {
    console.error('[gmail-auth] callback error:', e);
    res.status(500).send('授權處理失敗，請回後台重試。');
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
    SELECT u.id, u.name, u.email, u.phone, u.role, u.is_admin, u.notification_preference,
           (u.google_id IS NOT NULL) AS has_google, u.line_user_id,
           u.birthday, u.address, u.archived_at, u.created_at
    FROM users u
    ORDER BY u.id ASC
  `).all();
  res.json(rows);
}));

// 管理用：清空所有使用者的 LINE 綁定（含教練/管理者），讓全體重新綁定。
app.post('/api/admin/line/reset-all', requireAdmin, asyncHandler((req, res) => {
  res.json(resetAllLineBindings());
}));

// 管理用：解除『單一』使用者的 LINE 綁定（清 line_user_id + 進行中的綁定碼）。冪等。
app.delete('/api/admin/users/:id/line', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, line_user_id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  const was_bound = !!u.line_user_id;
  unbindByUserId(id);
  res.json({ ok: true, was_bound });
}));

// 變更角色與管理者標籤（requireAdmin = 有管理者標籤的教練）。
// role ∈ {user, coach}；is_admin 標籤只在 coach 有效（設為 user 一律清為 0）。
// 守門：不可改自己（避免自我降權鎖死）；變更後系統至少保留 1 位管理者（last_admin）。
// 教練檔案連動：改為教練 → 既有檔案重新啟用 / 全新建未啟用；改為會員 → 停用教練檔案(保留資料)。
app.patch('/api/admin/users/:id/role', requireAdmin, asyncHandler((req, res) => {
  const targetId = Number(req.params.id);
  const { role } = req.body || {};
  if (!['user', 'coach'].includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'cannot_change_self' });

  const target = db.prepare('SELECT id, name, role, is_admin FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  // 不變式：管理者標籤只能在教練身上；設為會員自動清除標籤。整數 0/1（避免綁定布林）。
  const isAdmin = (role === 'coach' && req.body?.is_admin) ? 1 : 0;

  // last_admin 守門：若這次變更會把此人從「管理者」拿掉，需確保系統仍有其他管理者。
  if (target.is_admin && !isAdmin) {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='coach' AND is_admin=1").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'last_admin' });
  }

  tx(() => {
    db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').run(role, isAdmin, targetId);
    if (role === 'coach') {
      // 既有教練檔案 → 重新啟用；全新 → 建未啟用（待設可預約時段）。
      const c = svcGetCoachByUser(targetId);
      if (c) { if (!c.is_active) svcSetCoachActive(c.id, true); }
      else svcCreateCoach({ userId: targetId, displayName: target.name?.trim() || '教練' });
    } else if (target.role === 'coach') {
      // 教練 → 會員：停用教練檔案（保留資料與歷史預約）。
      const c = svcGetCoachByUser(targetId);
      if (c) svcSetCoachActive(c.id, false);
    }
  });
  res.json({ ok: true, id: targetId, role, is_admin: isAdmin });
}));

// 編輯會員基本資料（姓名/手機/email/生日/地址）。管理者+擁有者皆可（requireAdmin）。
// 角色等其他欄位不在此改。採「合併語意」：只更新 body 實際帶到的欄位，未帶的維持原值
// （避免漏帶某欄被清空）。email/phone 皆有唯一限制 → 衝突回 409。
app.patch('/api/admin/users/:id', requireAdmin, asyncHandler((req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  const b = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const norm = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };
  const sets = [];
  const vals = [];

  if (has('name')) {
    const name = norm(b.name);
    if (!name) return res.status(400).json({ error: 'missing_name' });
    sets.push('name = ?'); vals.push(name);
  }
  if (has('phone')) {
    const phone = norm(b.phone);
    if (phone && !/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
    if (phone && db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, targetId)) {
      return res.status(409).json({ error: 'phone_taken' });
    }
    sets.push('phone = ?'); vals.push(phone);
  }
  if (has('email')) {
    const email = norm(b.email);
    // 員工(coach/admin/owner)以 email 登入，禁止透過此編輯清空 email 把自己/同事鎖在外面。
    if (!email && target.role !== 'user') return res.status(400).json({ error: 'email_required' });
    if (email && db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, targetId)) {
      return res.status(409).json({ error: 'email_taken' });
    }
    sets.push('email = ?'); vals.push(email);
  }
  if (has('birthday')) { sets.push('birthday = ?'); vals.push(norm(b.birthday)); }
  if (has('address')) { sets.push('address = ?'); vals.push(norm(b.address)); }

  if (sets.length) {
    vals.push(targetId);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const row = db.prepare(`
    SELECT id, name, email, phone, role, is_admin, notification_preference,
           (google_id IS NOT NULL) AS has_google, line_user_id, birthday, address, archived_at, created_at
    FROM users WHERE id = ?`).get(targetId);
  res.json(row);
}));

// 軟刪除（封存）會員：只影響後台列表，不動角色/標籤/登入。管理者操作（requireAdmin）。
app.post('/api/admin/users/:id/archive', requireAdmin, asyncHandler((req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).json({ error: 'cannot_archive_self' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  db.prepare("UPDATE users SET archived_at = datetime('now') WHERE id = ?").run(targetId);
  res.json({ ok: true, id: targetId });
}));

app.post('/api/admin/users/:id/restore', requireAdmin, asyncHandler((req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  db.prepare('UPDATE users SET archived_at = NULL WHERE id = ?').run(targetId);
  res.json({ ok: true, id: targetId });
}));

// --- One-on-one: admin coach management ---

app.post('/api/admin/coaches/account', requireAdmin, asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  const r = createCoachAccount({ email, password, name });
  res.status(201).json({ user_id: r.user.id, coach_pending: true });
}));

app.get('/api/admin/coaches', requireAdmin, asyncHandler((req, res) => {
  // 只列出仍是「教練」角色者；被降為一般用戶(role=user)的舊教練檔案雖保留（供歷史預約），
  // 但不再出現在教練管理清單。
  const rows = db.prepare(`
    SELECT c.*, u.name AS user_name, u.email AS user_email
    FROM coaches c JOIN users u ON u.id = c.user_id
    WHERE u.role = 'coach'
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();
  res.json(rows);
}));

// 註：「由現有 user 升級為教練」已移除（會員管理彈窗改角色=教練即可，且會自動建/啟用教練檔案）。

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

// 降為一般用戶：role→user（連帶清除管理者標籤）+ 停用教練檔案(保留供歷史預約)。
// 該人 role 變 user 後即從教練管理清單(WHERE u.role='coach')消失。
app.delete('/api/admin/coaches/:id', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const coach = svcGetCoach(id);
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  if (coach.user_id === req.user.id) return res.status(400).json({ error: 'cannot_change_self' });

  tx(() => {
    svcSetCoachActive(id, false);
    db.prepare("UPDATE users SET role = 'user', is_admin = 0 WHERE id = ?").run(coach.user_id);
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

// admin 可帶 coachId（GET/DELETE 走 query、POST/PATCH 走 body）代選任一教練；
// 非 admin 一律忽略 coachId、落回自己的教練檔案。service 層仍以 coach_id 設防（縱深防護）。
function resolveCoach(req, res) {
  const wanted = req.query.coachId ?? req.body?.coachId;
  if (wanted != null && wanted !== '' && req.user.is_admin) {
    const c = svcGetCoach(Number(wanted));
    if (!c) { res.status(404).json({ error: 'coach_not_found' }); return null; }
    return c;
  }
  return loadCoachForUser(req, res);
}

// --- One-on-one: coach self-service ---

app.get('/api/coach/me', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  res.json(coach);
}));

app.patch('/api/coach/me/profile', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  const { display_name, specialty, bio } = req.body || {};
  svcUpdateCoach(coach.id, { displayName: display_name, specialty, bio });
  res.json(svcGetCoach(coach.id));
}));

app.get('/api/coach/me/rules', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  res.json(svcListRules(coach.id));
}));

app.post('/api/coach/me/rules', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
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
  const coach = resolveCoach(req, res);
  if (!coach) return;
  svcDeleteRule({ coachId: coach.id, ruleId: Number(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/coach/me/exceptions', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  res.json(svcListExceptions(coach.id));
}));

app.post('/api/coach/me/exceptions', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
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
  const coach = resolveCoach(req, res);
  if (!coach) return;
  svcDeleteException({ coachId: coach.id, exceptionId: Number(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/coach/me/bookings', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  res.json(svcListCoachBookings(coach.id));
}));

app.get('/api/coach/me/availability-preview', requireCoach, asyncHandler(async (req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  // 一對一不卡 Google 行事曆忙碌時段：只看教練班表（externalBusy=null）。
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to, externalBusy: null }));
}));

app.post('/api/coach/me/avatar', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res);
  if (!coach) return;
  const { avatar_base64 } = req.body || {};
  const result = svcSaveAvatar({ coachId: coach.id, base64: avatar_base64 });
  res.json(result);
}));

// --- 方案（套餐）：教練/管理者管理客人方案 ---
app.post('/api/coach/packages', requireCoach, asyncHandler((req, res) => {
  const { memberId, sessionType, totalSessions, amount, expiresAt, note, discountCode } = req.body || {};
  res.status(201).json(svcCreatePackage({ memberId: Number(memberId), sessionType, totalSessions, amount, expiresAt, note, discountCode, createdBy: req.user.id }));
}));

app.get('/api/coach/discount-codes', requireCoach, asyncHandler((req, res) => {
  res.json(listActiveDiscountCodes());
}));

app.get('/api/coach/packages', requireCoach, asyncHandler((req, res) => {
  const memberId = Number(req.query.memberId);
  if (!memberId) return res.status(400).json({ error: 'missing_member' });
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  res.json(svcListPackages(memberId, { includeArchived }));
}));

app.patch('/api/coach/packages/:id', requireCoach, asyncHandler((req, res) => {
  const { remaining, note } = req.body || {};
  if (remaining == null) return res.status(400).json({ error: 'missing_remaining' });
  res.json(svcAdjustRemaining({ packageId: Number(req.params.id), remaining, note: note ?? null }));
}));

// 作廢會連動取消該方案名下（可跨教練）所有預約並刪日曆事件 → 守門用 requireAdmin（合法入口本就只有後台會員管理）。
// restore 對稱改 requireAdmin 保持一致。create/GET/PATCH 仍 requireCoach（登錄流程要用）。
app.post('/api/coach/packages/:id/archive', requireAdmin, asyncHandler((req, res) => {
  const r = svcArchivePackage(Number(req.params.id), req.user.id);
  for (const id of r.cancelledBookingIds) syncBookingCancel(id); // commit 後副作用：刪日曆事件、不 await
  res.json(r);
}));

app.post('/api/coach/packages/:id/restore', requireAdmin, asyncHandler((req, res) => {
  res.json(svcRestorePackage(Number(req.params.id)));
}));

// --- 登錄預約：週曆彙整 / 客人搜尋 / 預覽 / 建立 ---
app.get('/api/coach/week', requireCoach, asyncHandler((req, res) => {
  const wantAll = (req.query.all === '1' || req.query.all === 'true') && !!req.user.is_admin;
  if (wantAll) {
    // 全部教練：coachId 可選（決定底色/登錄目標）。
    let coachId = null;
    if (req.query.coachId != null && req.query.coachId !== '') {
      const c = svcGetCoach(Number(req.query.coachId));
      if (!c) return res.status(404).json({ error: 'coach_not_found' });
      coachId = c.id;
    }
    return res.json(svcGetCoachWeek({ coachId, start: req.query.start, all: true }));
  }
  const coach = resolveCoach(req, res); if (!coach) return;
  res.json(svcGetCoachWeek({ coachId: coach.id, start: req.query.start }));
}));

app.get('/api/coach/customers/search', requireCoach, asyncHandler((req, res) => {
  res.json(svcSearchCustomers(req.query.q));
}));

app.post('/api/coach/customers', requireCoach, asyncHandler((req, res) => {
  const { name, phone } = req.body || {};
  const u = findOrCreateUserByPhone({ name, phone });
  res.json({ id: u.id, name: u.name, phone: u.phone });
}));

app.post('/api/coach/register/preview', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res); if (!coach) return;
  const { memberId, packageId, startAt, recurrence } = req.body || {};
  res.json(svcPreviewRegister({ coachId: coach.id, memberId: Number(memberId), packageId: Number(packageId), startAt, recurrence: recurrence || null }));
}));

app.post('/api/coach/register', requireCoach, asyncHandler((req, res) => {
  const coach = resolveCoach(req, res); if (!coach) return;
  const { memberId, packageId, startAt, recurrence } = req.body || {};
  const r = svcCreateRegister({ coachId: coach.id, memberId: Number(memberId), packageId: Number(packageId), startAt, recurrence: recurrence || null, actorId: req.user.id });
  for (const c of r.created) syncBookingCreate(c.id); // commit 後副作用
  res.status(201).json(r);
}));

app.patch('/api/coach/bookings/:id/reschedule', requireCoach, asyncHandler((req, res) => {
  const { startAt } = req.body || {};
  const r = svcRescheduleBooking({ bookingId: Number(req.params.id), newStartAt: startAt, actorUserId: req.user.id, isAdmin: !!req.user.is_admin });
  syncBookingCancel(r.bookingId).then(() => syncBookingCreate(r.bookingId)); // 刷新日曆事件
  res.json(r);
}));

app.patch('/api/coach/bookings/:id/reassign', requireCoach, asyncHandler((req, res) => {
  const { memberId, packageId } = req.body || {};
  const r = svcReassignBooking({ bookingId: Number(req.params.id), newMemberId: Number(memberId), newPackageId: Number(packageId), actorUserId: req.user.id, isAdmin: !!req.user.is_admin });
  syncBookingCancel(r.bookingId).then(() => syncBookingCreate(r.bookingId));
  res.json(r);
}));

// 取消全部預約：取消該筆所屬循環群組（同教練、含過去）的全部預約。requireCoach + service 內擁有權守門。
app.post('/api/coach/bookings/:id/cancel-group', requireCoach, asyncHandler((req, res) => {
  const { reason } = req.body || {};
  const r = svcCancelCoachGroup({ bookingId: Number(req.params.id), actorUserId: req.user.id, isAdmin: !!req.user.is_admin, reason: (reason || '').trim() || null });
  for (const id of r.cancelled) syncBookingCancel(id); // commit 後副作用：逐筆刪日曆事件、不 await
  res.json(r);
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
  res.json({ valid: true, discount_type: v.type, discount_value: v.value, discount_amount: v.discountAmount, original: v.subtotal, final_total: v.finalTotal, remaining_uses: v.remainingUses });
}));

app.post('/api/public/bookings', bookingLimiter, asyncHandler(async (req, res) => {
  const { coachId, startAt, name, phone, note, discountCode, sessionType, email } = req.body || {};
  const type = sessionType || '1on1';
  // 檢查順序維持既有契約：coach(404/409) → phone(400) → 時段(409) → service
  const coach = svcGetCoach(Number(coachId));
  if (!coach) return res.status(404).json({ error: 'coach_not_found' });
  if (!coach.is_active) return res.status(409).json({ error: 'coach_inactive' });
  // phone 不做正規化：與 service 的 findOrCreateUserByPhone 同一套驗證（驗原始字串），
  // route 過 ⇔ service 過，不會出現「route 過、service 擋」的不一致。
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid_phone', detail: '電話需為 8-15 碼數字' });
  if (typeof startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(startAt)) {
    return res.status(400).json({ error: 'invalid_start_at' });
  }
  // 時段合法性（班表/請假/緩衝/視窗 + 容量）。一對一不卡 Google 行事曆忙碌時段：
  // 只要教練班表有開放即可預約，externalBusy=null。
  const date = startAt.slice(0, 10);
  const externalBusy = null;
  const units = type === '1on2' ? 2 : 1;
  // 管理者可於過去日期預約（校正/補登記）：放行過去時段，容量/重疊仍照常檢查。
  // 非管理者/匿名 → includePast=false → 過去時段不在清單 → 仍擋下（slot_unavailable）。
  const includePast = !!userFromToken(getTokenFromReq(req))?.is_admin;
  const slots = svcComputeSlots({ coachId: coach.id, fromDate: date, toDate: date, externalBusy, includePast });
  const hit = slots.find(s => s.start === startAt);
  if (!hit || hit.remain < units) return res.status(409).json({ error: 'slot_unavailable' });

  const r = svcCreateBookingAnon({ coachId: coach.id, startAt, name, phone, note: note || null, discountCode: discountCode || null, sessionType: type, email: email || null });
  // commit 後副作用（不 await、不持鎖；比照 notify() 慣例）
  syncBookingCreate(r.id);
  if (email) sendBookingConfirmation(r.id);
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

app.post('/api/public/line/bind-code', lineBindLimiter, asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  res.json(requestPublicBindCode({ phone, name }));
}));

app.delete('/api/public/bookings/:id', asyncHandler((req, res) => {
  const { phone, name } = req.body || {};
  const id = Number(req.params.id);
  const r = svcCancelBookingAnon({ bookingId: id, phone, name });
  syncBookingCancel(id); // commit 後（svcCancel 的 tx 已結束）、不 await
  res.json(r);
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

app.get('/api/coaches/:id/availability', asyncHandler(async (req, res) => {
  const coach = svcGetCoach(Number(req.params.id));
  if (!coach || !coach.is_active) return res.status(404).json({ error: 'coach_not_found' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'missing_range' });
  // 管理者可帶 backfill=1 看過去時段（補登用）；非管理者一律忽略。
  const requester = userFromToken(getTokenFromReq(req));
  const includePast = req.query.backfill === '1' && !!requester?.is_admin;
  // 一對一不卡 Google 行事曆忙碌時段：只看教練班表（externalBusy=null）。
  res.json(svcComputeSlots({ coachId: coach.id, fromDate: from, toDate: to, externalBusy: null, includePast }));
}));

// Kept for coach 緊急取消 (coach has a token; member login is disabled).
app.delete('/api/bookings/:id', requireUser, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'booking_not_found' });

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(booking.coach_id);
  const ownerIsCoach = coach && coach.user_id === req.user.id;
  // 管理者代理：is_admin + 帶的 coachId 與本筆預約的教練相符（且自己不是該教練）
  const wantedCoachId = req.query.coachId ?? req.body?.coachId;
  const adminOnBehalf = !!req.user.is_admin && !ownerIsCoach
    && wantedCoachId != null && wantedCoachId !== ''
    && Number(wantedCoachId) === booking.coach_id;
  const actorIsCoach = ownerIsCoach || adminOnBehalf;
  const { reason } = req.body || {};

  svcCancelBooking({
    bookingId: id,
    actorUserId: req.user.id,
    isCoach: actorIsCoach,
    reason: actorIsCoach ? (reason || null) : null,
    adminOnBehalf,
  });
  syncBookingCancel(id); // commit 後副作用、不 await（失敗交 reconcile 兜底）
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
        replyOrLog(event.replyToken, '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。', 'follow')
          .catch((e) => console.error('[line follow reply threw]', e));
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
    replyOrLog(replyToken, '哈囉！請從 chinup 網站的 LINE 通知頁複製 6 位數綁定碼，貼到這裡。', 'nonmatch')
      .catch((e) => console.error('[line nonmatch reply threw]', e));
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
  replyOrLog(replyToken, msg, 'bind').catch((e) => console.error('[line bind reply threw]', e));
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

// --- Admin: 教練課款項核對 ---
app.get('/api/admin/bookings/pending', requireAdmin, asyncHandler((req, res) => {
  res.json(svcListPendingPaymentBookings());
}));
app.post('/api/admin/bookings/:id/confirm-payment', requireAdmin, asyncHandler((req, res) => {
  res.json(svcConfirmBookingPayment({ bookingId: Number(req.params.id), actorId: req.user.id }));
}));
app.get('/api/admin/payments/confirmed', requireAdmin, asyncHandler((req, res) => {
  res.json(svcListConfirmedPayments());
}));
app.post('/api/admin/bookings/:id/cancel', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body || {};
  const r = svcCancelBookingAdmin({ bookingId: id, actorId: req.user.id, reason: (reason || '').trim() || null });
  syncBookingCancel(id); // commit 後（svc 的 tx 已結束）、不 await
  res.json(r);
}));
// 取消並退款（已核對匯款卡片長按）：教練課／團課訂單
app.post('/api/admin/bookings/:id/refund', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const r = svcRefundBookingAdmin({ bookingId: id, actorId: req.user.id });
  if (r.cancelled) syncBookingCancel(id); // 有實際取消才刪日曆事件（不 await）
  res.json(r);
}));
app.post('/api/admin/group-orders/:id/refund', requireAdmin, asyncHandler((req, res) => {
  res.json(svcRefundGroupOrder({ orderId: Number(req.params.id), actorId: req.user.id }));
}));
// 循環教練課「整批」操作（卡片以 recurring_group_id 集中一張）
app.post('/api/admin/bookings/group/:groupId/confirm-payment', requireAdmin, asyncHandler((req, res) => {
  res.json(svcConfirmBookingPaymentGroup({ groupId: Number(req.params.groupId), actorId: req.user.id }));
}));
app.post('/api/admin/bookings/group/:groupId/cancel', requireAdmin, asyncHandler((req, res) => {
  const { reason } = req.body || {};
  const r = svcCancelBookingAdminGroup({ groupId: Number(req.params.groupId), actorId: req.user.id, reason: (reason || '').trim() || null });
  for (const id of r.cancelled) syncBookingCancel(id); // 逐堂刪日曆事件（不 await）
  res.json(r);
}));
app.post('/api/admin/bookings/group/:groupId/refund', requireAdmin, asyncHandler((req, res) => {
  const r = svcRefundBookingGroupAdmin({ groupId: Number(req.params.groupId), actorId: req.user.id });
  for (const id of r.cancelled) syncBookingCancel(id);
  res.json(r);
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
    gcal_calendar_id: getGcalCalendarId(),
    booking_hourly_capacity: getBookingHourlyCapacity(),
    group_order_expiry_hours: getGroupOrderExpiryHours(),
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
  if (b.gcal_calendar_id !== undefined) {
    const v = String(b.gcal_calendar_id).trim();
    writes.push(['gcal_calendar_id', v]); // 空字串 = 關閉日曆同步
  }
  if (b.booking_hourly_capacity !== undefined) {
    const n = Number(b.booking_hourly_capacity);
    if (!Number.isInteger(n) || n < 1 || n > 99) return res.status(400).json({ error: 'invalid_capacity' });
    writes.push(['booking_hourly_capacity', String(n)]);
  }
  if (b.group_order_expiry_hours !== undefined) {
    const n = Number(b.group_order_expiry_hours);
    if (!Number.isInteger(n) || n < 1 || n > 720) return res.status(400).json({ error: 'invalid_expiry_hours' });
    writes.push(['group_order_expiry_hours', String(n)]);
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
    console.log(`[server] tz=${Intl.DateTimeFormat().resolvedOptions().timeZone} now=${new Date().toString()}`);
    startScheduler();
  });
}

export { app };
