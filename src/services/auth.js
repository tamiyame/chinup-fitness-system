import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

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
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

function safeUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

export function login({ email, password }) {
  const user = getUserByEmail.get(email);
  if (!user) throw new ApiError(401, 'invalid_credentials');
  if (!verifyPassword(password, user.password_hash)) throw new ApiError(401, 'invalid_credentials');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  insertSession.run(token, user.id, expiresAt);
  return { token, user: safeUser(user), expiresAt };
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
