import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const PHONE_RE = /^\d{8,15}$/;
export function validatePhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}
// gcal 整合：對外慣用名（同 validatePhone，僅別名匯出，不改驗證行為）
export const isValidPhone = validatePhone;

const getByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const insertUser = db.prepare(
  "INSERT INTO users (name, phone, email, password_hash, role, notification_preference) VALUES (?, ?, NULL, NULL, 'user', 'email')"
);
const getById = db.prepare('SELECT * FROM users WHERE id = ?');
const clearArchived = db.prepare('UPDATE users SET archived_at = NULL WHERE id = ?');

/**
 * 用電話找帳號；找到就回（姓名不覆蓋，首次為準），找不到就建。
 * 包在 tx 內以避免同電話並發雙插（idx_users_phone 也會擋）。
 */
export function findOrCreateUserByPhone({ phone, name }) {
  if (!validatePhone(phone)) throw new ApiError(400, 'invalid_phone');
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  return tx(() => {
    const existing = getByPhone.get(phone);
    if (existing) {
      // 安全：此電話若已屬於員工帳號（coach/admin/owner），不可被公開預約重用——
      // 否則預約會掛到員工帳號、且成功頁外洩其 LINE 綁定碼（帳號接管 / IDOR）。
      // 身份在「建立預約」時只比電話、姓名被忽略，故必須在此擋下。
      if (existing.role !== 'user') throw new ApiError(409, 'phone_unavailable');
      // 軟刪除自動還原：被封存會員的電話再次預約 → 解除封存、沿用舊帳號（歷史接回）。
      if (existing.archived_at) { clearArchived.run(existing.id); existing.archived_at = null; }
      return existing;
    }
    try {
      const info = insertUser.run(name.trim(), phone);
      return getById.get(info.lastInsertRowid);
    } catch (e) {
      // 並發下另一請求先插了同電話 → 重查（同樣套用員工守門）
      if (String(e.message).includes('UNIQUE')) {
        const u = getByPhone.get(phone);
        if (u && u.role !== 'user') throw new ApiError(409, 'phone_unavailable');
        if (u && u.archived_at) { clearArchived.run(u.id); u.archived_at = null; }
        return u;
      }
      throw e;
    }
  });
}

/** 無電話客人：直接新增（無電話可比對故不 find；登錄彈窗搜尋已先列同名既有客人）。之後可於後台會員管理補電話。 */
export function createCustomerNoPhone({ name }) {
  if (!name || !name.trim()) throw new ApiError(400, 'missing_name');
  const info = insertUser.run(name.trim(), null);
  return getById.get(info.lastInsertRowid);
}

/** 查詢用：電話完全相符 + 姓名 trim/大小寫不敏感相符。找不到回 null。 */
export function getUserByPhoneAndName({ phone, name }) {
  if (!validatePhone(phone) || !name || !name.trim()) return null;
  const u = getByPhone.get(phone);
  if (!u || !u.name) return null;
  return u.name.trim().toLowerCase() === name.trim().toLowerCase() ? u : null;
}
