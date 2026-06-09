import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db/connection.js';
import { ApiError } from './registration.js';
import { createCoach } from './coachService.js';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  try {
    const [, nS, rS, pS, saltHex, keyHex] = stored.split('$');
    const N = Number(nS), r = Number(rS), p = Number(pS);
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const derived = scryptSync(plain, salt, expected.length, { N, r, p });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

const insertSession = db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)');
const getSession = db.prepare('SELECT * FROM auth_sessions WHERE token = ? AND expires_at > datetime(\'now\')');
const deleteSession = db.prepare('DELETE FROM auth_sessions WHERE token = ?');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByGoogleId = db.prepare('SELECT * FROM users WHERE google_id = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

function safeUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  insertSession.run(token, userId, expiresAt);
  return { token, expiresAt };
}

export function login({ email, password }) {
  const user = getUserByEmail.get(email);
  if (!user) throw new ApiError(401, 'invalid_credentials');
  if (!verifyPassword(password, user.password_hash)) throw new ApiError(401, 'invalid_credentials');
  if (user.role === 'user') throw new ApiError(403, 'user_login_disabled');
  const session = createSession(user.id);
  return { token: session.token, user: safeUser(user), expiresAt: session.expiresAt };
}

// 修改密碼：需提供 email + 目前密碼（驗證身份）+ 新密碼。僅可登入帳號(教練/管理者)可改。
// 不建立 session、不洩漏帳號是否存在（錯誤一律 invalid_credentials，與 login 一致）。
export function changePassword({ email, currentPassword, newPassword }) {
  if (typeof newPassword !== 'string' || newPassword.length < 6) throw new ApiError(400, 'weak_password');
  const user = getUserByEmail.get(email);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) throw new ApiError(401, 'invalid_credentials');
  if (user.role === 'user') throw new ApiError(403, 'user_login_disabled');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  return { ok: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerWithPassword({ email, password, name, phone, notification_preference, as_coach = false }) {
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, 'invalid_email');
  if (!password || password.length < 8) throw new ApiError(400, 'password_too_short');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');

  const existing = getUserByEmail.get(email);
  if (existing) throw new ApiError(409, 'email_exists');

  const role = as_coach ? 'coach' : 'user';

  const info = db
    .prepare(
      'INSERT INTO users (name, email, phone, password_hash, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      name.trim(),
      email.toLowerCase(),
      phone || null,
      hashPassword(password),
      role,
      notification_preference || 'email'
    );

  const userId = info.lastInsertRowid;

  if (as_coach) {
    createCoach({ userId, displayName: name.trim() });  // is_active=0; admin must activate
  }

  const user = getUserById.get(userId);
  const session = createSession(user.id);
  return { token: session.token, user: safeUser(user), expiresAt: session.expiresAt, pending_coach: as_coach };
}

export function createCoachAccount({ email, password, name }) {
  return registerWithPassword({ email, password, name, as_coach: true });
}

// Google OAuth: upsert user by google_id, else link by email, else create.
// Password is stored as a sentinel that can never match scrypt verification.
const GOOGLE_SENTINEL = 'oauth:google';

export function findOrCreateGoogleUser({ googleId, email, name }) {
  // 1. existing by google_id
  let user = getUserByGoogleId.get(googleId);
  if (user) return user;

  // 2. existing by email → link the google_id
  user = getUserByEmail.get(email);
  if (user) {
    db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
    console.log(`[auth] linked google_id to existing user: ${email}`);
    return getUserById.get(user.id);
  }

  // 3. new user
  const info = db
    .prepare(
      'INSERT INTO users (name, email, password_hash, google_id, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(name || email.split('@')[0], email.toLowerCase(), GOOGLE_SENTINEL, googleId, 'user', 'email');
  console.log(`[auth] new user via Google: ${email}`);
  return getUserById.get(info.lastInsertRowid);
}

export function loginAsGoogleUser(user) {
  // Only admin/coach may log in (members use the public phone+name flow) — mirror login().
  if (user.role === 'user') throw new ApiError(403, 'user_login_disabled');
  const session = createSession(user.id);
  return { token: session.token, user: safeUser(user), expiresAt: session.expiresAt };
}

export function logout(token) {
  deleteSession.run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const session = getSession.get(token);
  if (!session) return null;
  return safeUser(getUserById.get(session.user_id));
}

// Production boot helper: ensure at least one admin exists.
// - If ADMIN_EMAIL + ADMIN_PASSWORD env vars are set, upsert that admin.
// - Otherwise, if no admin exists yet, create a default one and print a warning.
export function ensureInitialAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Administrator';

  // 管理者 = 有管理者標籤的教練（role='coach', is_admin=1）+ 未啟用教練檔案（不顯示於公開清單）。
  const createAdmin = (nm, em, pw) => {
    const info = db.prepare(
      "INSERT INTO users (name, email, password_hash, role, is_admin, notification_preference) VALUES (?, ?, ?, 'coach', 1, 'email')"
    ).run(nm, em, hashPassword(pw));
    db.prepare('INSERT INTO coaches (user_id, display_name) VALUES (?, ?)').run(Number(info.lastInsertRowid), nm);
  };

  if (email && password) {
    const existing = getUserByEmail.get(email);
    if (!existing) {
      createAdmin(name, email, password);
      console.log(`[auth] created admin from env: ${email}`);
    }
    return;
  }

  const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!anyAdmin) {
    const defaultEmail = 'admin@chinup.local';
    const defaultPassword = 'admin1234';
    createAdmin('Administrator', defaultEmail, defaultPassword);
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║  ⚠️  DEFAULT ADMIN CREATED — change credentials!  ║');
    console.log(`  ║    Email:    ${defaultEmail.padEnd(36)}║`);
    console.log(`  ║    Password: ${defaultPassword.padEnd(36)}║`);
    console.log('  ║  Set ADMIN_EMAIL + ADMIN_PASSWORD env vars to    ║');
    console.log('  ║  override on next boot.                          ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');
  }
}
