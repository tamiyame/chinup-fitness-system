import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { findOrCreateUserByPhone, getUserByPhoneAndName } from './userService.js';
import { notify, fmtDateForLine } from './notifications.js';
import { generateBindCode } from './lineBindingService.js';

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
const getUserNameStmt = db.prepare('SELECT name FROM users WHERE id = ?');

// Returns the member's most recent non-cancelled 1-on-1 booking and the coach
// data joined through. ORDER by start_at so multi-booking same-day is
// deterministic. Filtered to is_active coaches — a deactivated coach should
// not surface as "your recent coach".
const getMostRecentBookingWithCoachStmt = db.prepare(`
  SELECT
    b.start_at             AS start_at,
    c.id                   AS coach_id,
    c.display_name         AS coach_display_name,
    c.specialty            AS coach_specialty,
    c.bio                  AS coach_bio,
    c.avatar_path          AS coach_avatar_path
  FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.member_id = ?
    AND b.status != 'cancelled'
    AND c.is_active = 1
  ORDER BY b.start_at DESC
  LIMIT 1
`);

// 核心建單：寫 bookings + 通知教練/會員。不碰點數。
function createBookingCore({ coach, memberId, startAt, note }) {
  const endAt = addMinutes(startAt, 60);
  let bookingId;
  try {
    const info = insertBookingStmt.run(coach.id, memberId, startAt, endAt, note);
    bookingId = info.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
    throw e;
  }
  const memberRow = getUserNameStmt.get(memberId);
  if (memberRow) {
    const startFmt = fmtDateForLine(startAt);
    notify({ userId: coach.user_id, sessionId: null, type: 'booking_created',
      vars: { member_name: memberRow.name, start_at: startFmt } });
    notify({ userId: memberId, sessionId: null, type: 'booking_confirmed',
      vars: { coach_display_name: coach.display_name, start_at: startFmt } });
  }
  return { id: bookingId, startAt, endAt };
}

export function createBooking({ coachId, memberId, startAt, note = null }) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => createBookingCore({ coach, memberId, startAt, note }));
}

export function createBookingAnon({ coachId, startAt, name, phone, note = null }) {
  if (!coachId || !startAt) throw new ApiError(400, 'missing_fields');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });
    const r = createBookingCore({ coach, memberId: user.id, startAt, note });
    if (!user.line_user_id) r.lineBindCode = generateBindCode(user.id).code;
    return r;
  });
}

export function cancelBooking({ bookingId, actorUserId, isCoach = false, reason = null }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');

    const coach = getCoachStmt.get(b.coach_id);

    if (isCoach) {
      if (!coach || coach.user_id !== actorUserId) throw new ApiError(403, 'forbidden');
      if (!reason || !reason.trim()) throw new ApiError(400, 'missing_reason');
    } else {
      if (b.member_id !== actorUserId) throw new ApiError(403, 'forbidden');
    }

    cancelBookingStmt.run(nowLocal(), actorUserId, reason, bookingId);

    // Phase 3C: notify the OTHER party (the one who didn't cancel)
    const memberRow = getUserNameStmt.get(b.member_id);
    if (coach && memberRow) {
      const startFmt = fmtDateForLine(b.start_at);
      const isCoachCancel = actorUserId === coach.user_id;
      if (isCoachCancel) {
        notify({
          userId: b.member_id,
          sessionId: null,
          type: 'booking_cancelled_by_coach',
          vars: { coach_display_name: coach.display_name, start_at: startFmt },
        });
      } else {
        notify({
          userId: coach.user_id,
          sessionId: null,
          type: 'booking_cancelled_by_member',
          vars: { member_name: memberRow.name, start_at: startFmt },
        });
      }
    }

    return { ok: true };
  });
}

export function cancelBookingAnon({ bookingId, phone, name }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    const user = getUserByPhoneAndName({ phone, name });
    if (!user || user.id !== b.member_id) throw new ApiError(403, 'forbidden');
    cancelBookingStmt.run(nowLocal(), user.id, null, bookingId);
    const coach = getCoachStmt.get(b.coach_id);
    const memberRow = getUserNameStmt.get(b.member_id);
    if (coach && memberRow) {
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_member',
        vars: { member_name: memberRow.name, start_at: fmtDateForLine(b.start_at) } });
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

/**
 * Returns the most recent non-cancelled 1-on-1 coach for a member.
 *
 * Used by `GET /api/my/recent-coach` to surface a "你最近的教練" pinned card.
 * "Most recent" = the booking with the latest start_at;
 * future-dated bookings count, cancelled ones don't. Coaches who have been
 * deactivated (`is_active = 0`) are filtered out so the card never points
 * to someone you can't actually book.
 *
 * @param {number} userId
 * @returns {{
 *   coach: { id: number, display_name: string, specialty: string|null,
 *            bio: string|null, avatar_path: string|null } | null,
 *   last_session_date: string | null,
 *   days_ago: number | null,
 * }}
 */
export function getMostRecentCoachForUser(userId) {
  const row = getMostRecentBookingWithCoachStmt.get(userId);
  if (!row) return { coach: null, last_session_date: null, days_ago: null };

  // start_at is stored as 'YYYY-MM-DDTHH:MM:SS' (ISO string format). Extract
  // the date part and compare in local-midnight days to avoid timezone drift
  // between server clock and the stored timestamp.
  const dateStr = row.start_at.split('T')[0]; // 'YYYY-MM-DD'
  const sessionMidnight = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysAgo = Math.floor((todayMidnight - sessionMidnight) / 86400000);

  return {
    coach: {
      id: row.coach_id,
      display_name: row.coach_display_name,
      specialty: row.coach_specialty,
      bio: row.coach_bio,
      avatar_path: row.coach_avatar_path,
    },
    last_session_date: dateStr,
    days_ago: daysAgo, // negative = future-dated booking
  };
}

function addMinutes(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
