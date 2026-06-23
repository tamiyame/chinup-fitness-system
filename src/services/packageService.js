import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';

const SESSION_TYPES = ['1on1', '1on2'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() { return nowLocal().slice(0, 10); }

// is_valid：未作廢 + 有剩 + 未過期（? = 今天）
const VALID_EXPR = `(cp.archived_at IS NULL AND cp.remaining_sessions > 0 AND (cp.expires_at IS NULL OR cp.expires_at >= ?))`;

export function getPackage(id) {
  const row = db.prepare(`SELECT cp.*, ${VALID_EXPR} AS is_valid FROM customer_packages cp WHERE cp.id = ?`)
    .get(todayLocal(), id);
  if (!row) return null;
  row.is_valid = !!row.is_valid;
  return row;
}

export function createPackage({ memberId, sessionType, totalSessions, amount = null, expiresAt = null, note = null, createdBy = null }) {
  if (!memberId) throw new ApiError(400, 'missing_member');
  if (!SESSION_TYPES.includes(sessionType)) throw new ApiError(400, 'invalid_session_type');
  const total = Number(totalSessions);
  if (!Number.isInteger(total) || total <= 0) throw new ApiError(400, 'invalid_total');
  let amt = null;
  if (amount != null && amount !== '') {
    amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 0) throw new ApiError(400, 'invalid_amount');
  }
  let exp = null;
  if (expiresAt != null && expiresAt !== '') {
    if (!DATE_RE.test(expiresAt)) throw new ApiError(400, 'invalid_expires_at');
    // regex 擋不掉不存在的日期（如 2026-13-45 / 2026-02-30）→ 用 Date round-trip 驗真實日期。
    const d = new Date(`${expiresAt}T00:00:00`);
    if (Number.isNaN(d.getTime())
      || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== expiresAt) {
      throw new ApiError(400, 'invalid_expires_at');
    }
    exp = expiresAt;
  }
  const member = db.prepare('SELECT id FROM users WHERE id = ?').get(memberId);
  if (!member) throw new ApiError(404, 'member_not_found');
  // created_at 用 nowLocal()（本地 wall-clock，與全站一致；不用 DEFAULT 的 UTC datetime('now')）。
  const info = db.prepare(
    `INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(memberId, sessionType, total, total, amt, exp, (note && note.trim()) || null, createdBy, nowLocal());
  return getPackage(Number(info.lastInsertRowid));
}

export function listPackagesForMember(memberId, { includeArchived = false } = {}) {
  const rows = db.prepare(
    `SELECT cp.*, ${VALID_EXPR} AS is_valid
       FROM customer_packages cp
      WHERE cp.member_id = ? ${includeArchived ? '' : 'AND cp.archived_at IS NULL'}
      ORDER BY (cp.archived_at IS NOT NULL) ASC,
               (cp.remaining_sessions > 0) DESC,
               (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(todayLocal(), memberId);
  for (const r of rows) r.is_valid = !!r.is_valid;
  return rows;
}

export function listValidPackagesForMember(memberId, sessionType = null) {
  const today = todayLocal();
  const params = sessionType ? [memberId, today, sessionType] : [memberId, today];
  return db.prepare(
    `SELECT cp.* FROM customer_packages cp
      WHERE cp.member_id = ?
        AND cp.archived_at IS NULL
        AND cp.remaining_sessions > 0
        AND (cp.expires_at IS NULL OR cp.expires_at >= ?)
        ${sessionType ? 'AND cp.session_type = ?' : ''}
      ORDER BY (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(...params);
}

export function adjustRemaining({ packageId, remaining, note = null }) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    const r = Number(remaining);
    if (!Number.isInteger(r) || r < 0 || r > p.total_sessions) throw new ApiError(400, 'invalid_remaining');
    const newNote = note && note.trim() ? note.trim() : null;
    db.prepare('UPDATE customer_packages SET remaining_sessions = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(r, newNote, packageId);
    return getPackage(packageId);
  });
}

export function archivePackage(packageId) {
  const p = db.prepare('SELECT id FROM customer_packages WHERE id = ?').get(packageId);
  if (!p) throw new ApiError(404, 'package_not_found');
  db.prepare('UPDATE customer_packages SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(nowLocal(), packageId);
  return getPackage(packageId);
}

export function restorePackage(packageId) {
  const p = db.prepare('SELECT id FROM customer_packages WHERE id = ?').get(packageId);
  if (!p) throw new ApiError(404, 'package_not_found');
  db.prepare('UPDATE customer_packages SET archived_at = NULL WHERE id = ?').run(packageId);
  return getPackage(packageId);
}

// 扣 1 堂：條件式 UPDATE 防併發超扣。回 true=成功；剩餘不足/作廢→false。
export function deductOne(packageId) {
  const info = db.prepare(
    `UPDATE customer_packages SET remaining_sessions = remaining_sessions - 1
      WHERE id = ? AND remaining_sessions > 0 AND archived_at IS NULL`
  ).run(packageId);
  return info.changes === 1;
}

// 回補 1 堂（取消預約）：即使已過期/作廢仍回補（堂數屬客人）。
// WHERE remaining < total → changes===1 代表「真的回補了一堂」（已滿時 changes=0、回 false），
// 契約精準，讓「不重複回補」測試不被封頂掩蓋。
export function refundOne(packageId) {
  const info = db.prepare(
    `UPDATE customer_packages SET remaining_sessions = remaining_sessions + 1
      WHERE id = ? AND remaining_sessions < total_sessions`
  ).run(packageId);
  return info.changes === 1;
}
