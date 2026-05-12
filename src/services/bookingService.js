import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { recordTransaction } from './pointService.js';
import { notify, fmtDateForLine } from './notifications.js';

const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, note)
  VALUES (?, ?, ?, ?, ?)
`);

const getBookingStmt = db.prepare('SELECT * FROM bookings WHERE id = ?');

const cancelBookingStmt = db.prepare(`
  UPDATE bookings
  SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
  WHERE id = ? AND status = 'confirmed'
`);

const listMemberStmt = db.prepare(`
  SELECT b.*, c.display_name AS coach_display_name, c.id AS coach_id
  FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.member_id = ?
  ORDER BY b.start_at DESC
`);

const listCoachStmt = db.prepare(`
  SELECT b.*, u.name AS member_name, u.email AS member_email
  FROM bookings b
  JOIN users u ON u.id = b.member_id
  WHERE b.coach_id = ?
  ORDER BY b.start_at DESC
`);

const getCoachStmt = db.prepare('SELECT * FROM coaches WHERE id = ?');

export function createBooking({ coachId, memberId, startAt, note = null }) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  const endAt = addMinutes(startAt, 60);
  return tx(() => {
    let bookingId;
    try {
      const info = insertBookingStmt.run(coachId, memberId, startAt, endAt, note);
      bookingId = info.lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
      throw e;
    }
    recordTransaction({
      memberId, pool: 'one_on_one', amount: -1,
      note: `預約 #${bookingId}`,
      actorId: memberId,
      source: 'booking_deduct',
      relatedBookingId: bookingId,
    });
    // Phase 3C: notify coach + member
    const coachRow = db.prepare(
      'SELECT c.user_id, c.display_name FROM coaches c WHERE c.id = ?'
    ).get(coachId);
    const memberRow = db.prepare('SELECT name FROM users WHERE id = ?').get(memberId);

    if (coachRow && memberRow) {
      const startFmt = fmtDateForLine(startAt);
      notify({
        userId: coachRow.user_id,
        sessionId: null,
        type: 'booking_created',
        vars: { member_name: memberRow.name, start_at: startFmt },
      });
      notify({
        userId: memberId,
        sessionId: null,
        type: 'booking_confirmed',
        vars: { coach_display_name: coachRow.display_name, start_at: startFmt },
      });
    }
    return { id: bookingId, startAt, endAt };
  });
}

export function cancelBooking({ bookingId, actorUserId, isCoach = false, reason = null }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');

    if (isCoach) {
      const coach = getCoachStmt.get(b.coach_id);
      if (!coach || coach.user_id !== actorUserId) throw new ApiError(403, 'forbidden');
      if (!reason || !reason.trim()) throw new ApiError(400, 'missing_reason');
    } else {
      if (b.member_id !== actorUserId) throw new ApiError(403, 'forbidden');
    }

    cancelBookingStmt.run(nowLocal(), actorUserId, reason, bookingId);

    const refundNote = isCoach
      ? `取消 #${bookingId}（教練：${reason}）`
      : `取消 #${bookingId}`;
    recordTransaction({
      memberId: b.member_id, pool: 'one_on_one', amount: 1,
      note: refundNote,
      actorId: actorUserId,
      source: 'booking_refund',
      relatedBookingId: bookingId,
    });

    // Phase 3C: notify the OTHER party (the one who didn't cancel)
    const coachRow2 = db.prepare(
      'SELECT c.user_id, c.display_name FROM coaches c WHERE c.id = ?'
    ).get(b.coach_id);
    const memberRow2 = db.prepare('SELECT name FROM users WHERE id = ?').get(b.member_id);

    if (coachRow2 && memberRow2) {
      const startFmt2 = fmtDateForLine(b.start_at);
      const isCoachCancel = actorUserId === coachRow2.user_id;
      if (isCoachCancel) {
        notify({
          userId: b.member_id,
          sessionId: null,
          type: 'booking_cancelled_by_coach',
          vars: { coach_display_name: coachRow2.display_name, start_at: startFmt2 },
        });
      } else {
        notify({
          userId: coachRow2.user_id,
          sessionId: null,
          type: 'booking_cancelled_by_member',
          vars: { member_name: memberRow2.name, start_at: startFmt2 },
        });
      }
    }

    return { ok: true };
  });
}

export function listMemberBookings(memberId) {
  return listMemberStmt.all(memberId);
}

export function listCoachBookings(coachId) {
  return listCoachStmt.all(coachId);
}

function addMinutes(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
