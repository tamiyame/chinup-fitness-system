import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const PHONE_RE = /^\d{8,15}$/;
export function validatePhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

const getByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const insertUser = db.prepare(
  "INSERT INTO users (name, phone, email, password_hash, role, notification_preference) VALUES (?, ?, NULL, NULL, 'user', 'email')"
);
const getById = db.prepare('SELECT * FROM users WHERE id = ?');

/**
 * 用電話找帳號；找到就回（姓名不覆蓋，首次為準），找不到就建。
 * 包在 tx 內以避免同電話並發雙插（idx_users_phone 也會擋）。
 */
export function findOrCreateUserByPhone({ phone, name }) {
  if (!validatePhone(phone)) throw new ApiError(400, 'invalid_phone');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  return tx(() => {
    const existing = getByPhone.get(phone);
    if (existing) return existing;
    try {
      const info = insertUser.run(name.trim(), phone);
      return getById.get(info.lastInsertRowid);
    } catch (e) {
      // 並發下另一請求先插了同電話 → 重查
      if (String(e.message).includes('UNIQUE')) return getByPhone.get(phone);
      throw e;
    }
  });
}

/** 查詢用：電話完全相符 + 姓名 trim/大小寫不敏感相符。找不到回 null。 */
export function getUserByPhoneAndName({ phone, name }) {
  if (!validatePhone(phone) || !name || !name.trim()) return null;
  const u = getByPhone.get(phone);
  if (!u || !u.name) return null;
  return u.name.trim().toLowerCase() === name.trim().toLowerCase() ? u : null;
}
