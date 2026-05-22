import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const PHONE_RE = /^\d{8,15}$/;
export function validatePhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

const getByPhone = db.prepare('SELECT id, name, phone, line_user_id FROM users WHERE phone = ?');
const insertUser = db.prepare(
  'INSERT INTO users (name, phone, role, notification_preference) VALUES (?, ?, ?, ?)'
);
const updateName = db.prepare('UPDATE users SET name = ? WHERE id = ?');

/**
 * Find user by phone or create a new one. Idempotent under concurrent calls
 * via tx() + BEGIN IMMEDIATE.
 *
 * @returns {{ userId: number, created: boolean }}
 */
export function findOrCreateUserByPhone({ phone, name }) {
  if (!validatePhone(phone)) throw new ApiError(400, 'invalid_phone');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  const trimmedName = name.trim();
  return tx(() => {
    const existing = getByPhone.get(phone);
    if (existing) {
      if (existing.name !== trimmedName) {
        updateName.run(trimmedName, existing.id);
      }
      return { userId: existing.id, created: false };
    }
    const info = insertUser.run(trimmedName, phone, 'user', 'email');
    return { userId: info.lastInsertRowid, created: true };
  });
}

export function getUserByPhone(phone) {
  if (!validatePhone(phone)) return null;
  return getByPhone.get(phone);
}
