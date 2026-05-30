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
