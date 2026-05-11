import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertTxStmt = db.prepare(`
  INSERT INTO point_transactions
    (member_id, pool, amount, note, actor_id, source,
     related_booking_id, related_session_id, related_registration_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getBalanceStmt = db.prepare(
  'SELECT COALESCE(SUM(amount), 0) AS balance FROM point_transactions WHERE member_id = ? AND pool = ?'
);

const POOLS = ['one_on_one', 'group'];
const SOURCES = ['admin_grant', 'booking_deduct', 'booking_refund',
                 'registration_deduct', 'registration_refund', 'session_refund'];

export function recordTransaction({
  memberId, pool, amount, note, actorId, source,
  relatedBookingId = null, relatedSessionId = null, relatedRegistrationId = null,
}) {
  if (!memberId) throw new ApiError(400, 'missing_member_id');
  if (!POOLS.includes(pool)) throw new ApiError(400, 'invalid_pool');
  if (!Number.isInteger(amount) || amount === 0) throw new ApiError(400, 'invalid_amount');
  if (!note || !note.trim()) throw new ApiError(400, 'missing_note');
  if (!actorId) throw new ApiError(400, 'missing_actor_id');
  if (!SOURCES.includes(source)) throw new ApiError(400, 'invalid_source');

  return tx(() => {
    insertTxStmt.run(memberId, pool, amount, note.trim(), actorId, source,
                     relatedBookingId, relatedSessionId, relatedRegistrationId);
    const balance = getBalanceStmt.get(memberId, pool).balance;
    if (balance < 0) throw new ApiError(409, 'insufficient_points', { balance });
    return { balance };
  });
}

export function getBalance(memberId, pool) {
  return getBalanceStmt.get(memberId, pool).balance;
}

export function getBalances(memberId) {
  return {
    one_on_one: getBalance(memberId, 'one_on_one'),
    group: getBalance(memberId, 'group'),
  };
}

export function adminGrant({ memberId, pool, amount, note, adminId }) {
  return recordTransaction({
    memberId, pool, amount, note, actorId: adminId, source: 'admin_grant',
  });
}

const listTxStmt = db.prepare(`
  SELECT pt.*, actor.name AS actor_name
  FROM point_transactions pt
  JOIN users actor ON actor.id = pt.actor_id
  WHERE pt.member_id = ?
  ORDER BY pt.created_at DESC, pt.id DESC
  LIMIT ?
`);

const listTxByPoolStmt = db.prepare(`
  SELECT pt.*, actor.name AS actor_name
  FROM point_transactions pt
  JOIN users actor ON actor.id = pt.actor_id
  WHERE pt.member_id = ? AND pt.pool = ?
  ORDER BY pt.created_at DESC, pt.id DESC
  LIMIT ?
`);

export function listTransactionsForAdmin(memberId, { pool = null, limit = 100 } = {}) {
  if (pool) {
    if (!POOLS.includes(pool)) throw new ApiError(400, 'invalid_pool');
    return listTxByPoolStmt.all(memberId, pool, limit);
  }
  return listTxStmt.all(memberId, limit);
}
