import { db, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';

export function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

const getCodeStmt = db.prepare('SELECT * FROM discount_codes WHERE code = ?');
const countUsesStmt = db.prepare('SELECT COUNT(*) AS c FROM discount_redemptions WHERE code_id = ?');
const countPhoneUsesStmt = db.prepare('SELECT COUNT(*) AS c FROM discount_redemptions WHERE code_id = ? AND phone = ?');

export function computeDiscount(type, value, subtotal) {
  let discountAmount = type === 'percent' ? Math.floor((subtotal * value) / 100) : Math.min(value, subtotal);
  if (discountAmount < 0) discountAmount = 0;
  return { discountAmount, finalTotal: Math.max(0, subtotal - discountAmount) };
}

function todayLocal() { return nowLocal().slice(0, 10); } // 'YYYY-MM-DD'

/** 純驗證不寫入。丟 ApiError 各錯誤碼。回 { codeId, code, type, value, discountAmount, finalTotal, subtotal }。 */
export function validateDiscount({ code, phone, subtotal }) {
  const norm = normalizeCode(code);
  if (!norm) throw new ApiError(400, 'invalid_code');
  const c = getCodeStmt.get(norm);
  if (!c) throw new ApiError(404, 'invalid_code');
  if (!c.active) throw new ApiError(409, 'code_inactive');
  const today = todayLocal();
  if (c.valid_from && today < c.valid_from) throw new ApiError(409, 'code_not_started');
  if (c.valid_until && today > c.valid_until) throw new ApiError(409, 'code_expired');
  if (c.min_amount != null && subtotal < c.min_amount) throw new ApiError(409, 'below_min_amount', { min_amount: c.min_amount });
  if (c.max_uses != null && countUsesStmt.get(c.id).c >= c.max_uses) throw new ApiError(409, 'code_exhausted');
  if (c.per_phone_limit != null && phone && countPhoneUsesStmt.get(c.id, phone).c >= c.per_phone_limit) {
    throw new ApiError(409, 'per_phone_exhausted');
  }
  const { discountAmount, finalTotal } = computeDiscount(c.discount_type, c.discount_value, subtotal);
  return { codeId: c.id, code: c.code, type: c.discount_type, value: c.discount_value, discountAmount, finalTotal, subtotal };
}

const insertRedemption = db.prepare(
  'INSERT INTO discount_redemptions (code_id, phone, kind, ref_id, amount) VALUES (?, ?, ?, ?, ?)'
);
const deleteRedemption = db.prepare('DELETE FROM discount_redemptions WHERE kind = ? AND ref_id = ?');

/** 在 caller 的 tx() 內呼叫：重新 validate（含用量上限即時 COUNT）→ 記 redemption。
 *  code 為空 → 回 null（不套用）。回 { discountCode, discountAmount, finalTotal, originalAmount }。 */
export function applyDiscountTx({ code, phone, subtotal, kind, refId }) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const v = validateDiscount({ code: norm, phone, subtotal });
  insertRedemption.run(v.codeId, phone, kind, refId, v.discountAmount);
  return { discountCode: v.code, discountAmount: v.discountAmount, finalTotal: v.finalTotal, originalAmount: subtotal };
}

export function releaseRedemption({ kind, refId }) {
  deleteRedemption.run(kind, refId);
}

export function listDiscountCodes() {
  return db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC, id DESC').all()
    .map((c) => ({ ...c, used_count: countUsesStmt.get(c.id).c }));
}

function validateCodeFields({ discount_type, discount_value, max_uses, per_phone_limit, min_amount }) {
  if (!['percent', 'fixed'].includes(discount_type)) throw new ApiError(400, 'invalid_type');
  const val = Number(discount_value);
  if (!Number.isInteger(val) || val < 1 || (discount_type === 'percent' && val > 100)) throw new ApiError(400, 'invalid_value');
  for (const v of [max_uses, per_phone_limit, min_amount]) {
    if (v != null && v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0)) throw new ApiError(400, 'invalid_limit');
  }
  return val;
}
const nz = (v) => (v == null || v === '' ? null : Number(v));   // nullable int
const nstr = (v) => (v == null || v === '' ? null : String(v)); // nullable string

export function createDiscountCode(f) {
  const code = normalizeCode(f.code);
  if (!code) throw new ApiError(400, 'missing_code');
  const val = validateCodeFields(f);
  if (getCodeStmt.get(code)) throw new ApiError(409, 'code_exists');
  const info = db.prepare(`INSERT INTO discount_codes
    (code, discount_type, discount_value, active, valid_from, valid_until, max_uses, per_phone_limit, min_amount, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      code, f.discount_type, val, f.active === 0 || f.active === false ? 0 : 1,
      nstr(f.valid_from), nstr(f.valid_until), nz(f.max_uses), nz(f.per_phone_limit), nz(f.min_amount), nstr(f.note));
  return db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(info.lastInsertRowid);
}

export function updateDiscountCode(id, f) {
  const c = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
  if (!c) throw new ApiError(404, 'not_found');
  const merged = { discount_type: f.discount_type ?? c.discount_type, discount_value: f.discount_value ?? c.discount_value,
    max_uses: f.max_uses, per_phone_limit: f.per_phone_limit, min_amount: f.min_amount };
  const val = validateCodeFields(merged);
  db.prepare(`UPDATE discount_codes SET discount_type=?, discount_value=?, active=?, valid_from=?, valid_until=?,
    max_uses=?, per_phone_limit=?, min_amount=?, note=? WHERE id=?`).run(
    merged.discount_type, val, f.active === 0 || f.active === false ? 0 : 1,
    nstr(f.valid_from), nstr(f.valid_until), nz(f.max_uses), nz(f.per_phone_limit), nz(f.min_amount), nstr(f.note), id);
  return db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
}

export function deleteDiscountCode(id) {
  const c = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
  if (!c) throw new ApiError(404, 'not_found');
  if (countUsesStmt.get(id).c > 0) throw new ApiError(409, 'has_redemptions');
  db.prepare('DELETE FROM discount_codes WHERE id = ?').run(id);
  return { ok: true };
}

const getSettingStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
export function getSetting(key) { const r = getSettingStmt.get(key); return r ? r.value : null; }
export function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
export function getOneOnOnePrice() { return parseInt(getSetting('one_on_one_price') || '1500', 10); }
export function getOneOnTwoPrice() { return parseInt(getSetting('one_on_two_price') || '2000', 10); }
// 依課程型態取單堂價：'1on2' → 1對2 價，其餘（含 '1on1'/undefined）→ 1對1 價。
export function getOneOnOnePriceByType(sessionType) {
  return sessionType === '1on2' ? getOneOnTwoPrice() : getOneOnOnePrice();
}

const DEFAULT_BANK_INFO = '合作金庫 (006) 0640765-607824 戶名：許秉毅';
export function getBankInfo() { return getSetting('bank_info') || process.env.BANK_INFO || DEFAULT_BANK_INFO; }
export function getLineOfficialUrl() { return getSetting('line_official_url') || ''; }
export function getGcalCalendarId() { return getSetting('gcal_calendar_id') || ''; }
// 每小時桶容量上限（全店跨教練）。非法值（NaN/<1）退回預設 3。
export function getBookingHourlyCapacity() {
  const n = parseInt(getSetting('booking_hourly_capacity') || '3', 10);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}
