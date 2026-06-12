import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { findOrCreateUserByPhone, getUserByPhoneAndName } from './userService.js';
import { notify, notifyAdmins, fmtDateForLine } from './notifications.js';
import { generateBindCode } from './lineBindingService.js';
import { applyDiscountTx, releaseRedemption, getOneOnOnePriceByType, getLineOfficialUrl } from './discountService.js';
import { assertBookableTx } from './availabilityService.js';
import { sendPaymentConfirmedEmail } from './emailService.js';

const START_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, note, session_type)
  VALUES (?, ?, ?, ?, ?, ?)
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
  ORDER BY b.created_at DESC, b.id DESC
`);

const getCoachStmt = db.prepare('SELECT * FROM coaches WHERE id = ?');
const getUserNameStmt = db.prepare('SELECT name FROM users WHERE id = ?');

const listPendingPaymentStmt = db.prepare(`
  SELECT b.id, b.start_at, b.session_type, b.created_at,
         b.original_amount, b.discount_amount, b.discount_code,
         u.name AS member_name, u.phone AS member_phone,
         c.display_name AS coach_display_name
  FROM bookings b
  JOIN users u ON u.id = b.member_id
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.status = 'confirmed' AND b.paid_at IS NULL
  ORDER BY b.created_at DESC, b.id DESC
`);

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
function createBookingCore({ coach, memberId, startAt, note, sessionType = '1on1' }) {
  const endAt = addMinutes(startAt, 60);
  // 同教練重疊 / 全店容量（tx 內、純 DB → 無競態）。UNIQUE index 仍為最後兜底。
  assertBookableTx({ coachId: coach.id, startAt, endAt, units: sessionType === '1on2' ? 2 : 1 });
  let bookingId;
  try {
    const info = insertBookingStmt.run(coach.id, memberId, startAt, endAt, note, sessionType);
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
    // 加掛：店家管理者廣播（第三人稱、中性，沿用 booking_created 文案）
    notifyAdmins({ type: 'booking_created', excludeUserId: memberId, vars: { member_name: memberRow.name, start_at: startFmt } });
  }
  return { id: bookingId, startAt, endAt };
}

export function createBooking({ coachId, memberId, startAt, note = null }) {
  if (!coachId || !memberId || !startAt) throw new ApiError(400, 'missing_fields');
  if (typeof startAt !== 'string' || !START_AT_RE.test(startAt)) throw new ApiError(400, 'invalid_start_at');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => createBookingCore({ coach, memberId, startAt, note }));
}

export function createBookingAnon({ coachId, startAt, name, phone, note = null, discountCode = null, sessionType = '1on1', email = null }) {
  if (!coachId || !startAt) throw new ApiError(400, 'missing_fields');
  if (sessionType !== '1on1' && sessionType !== '1on2') throw new ApiError(400, 'invalid_session_type');
  if (typeof startAt !== 'string' || !START_AT_RE.test(startAt)) throw new ApiError(400, 'invalid_start_at');
  if (email != null && email !== '' && !EMAIL_RE.test(email)) throw new ApiError(400, 'invalid_email');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });
    const r = createBookingCore({ coach, memberId: user.id, startAt, note, sessionType });
    // 綁定碼只發給一般會員（縱深防禦：Fix A 已擋員工電話，這裡再保險一次）。
    if (user.role === 'user' && !user.line_user_id) r.lineBindCode = generateBindCode(user.id).code;
    r.lineOfficialUrl = getLineOfficialUrl();
    const subtotal = getOneOnOnePriceByType(sessionType);
    let originalAmount = subtotal, discountAmount = null, discountCode_ = null, finalAmount = subtotal;
    const applied = applyDiscountTx({ code: discountCode, phone, subtotal, kind: 'booking', refId: r.id });
    if (applied) { discountAmount = applied.discountAmount; discountCode_ = applied.discountCode; finalAmount = applied.finalTotal; }
    db.prepare('UPDATE bookings SET original_amount=?, discount_amount=?, discount_code=?, customer_email=? WHERE id=?')
      .run(originalAmount, discountAmount, discountCode_, (email || null), r.id);
    r.sessionType = sessionType;
    r.customerEmail = email || null;
    r.originalAmount = originalAmount; r.discountAmount = discountAmount; r.discountCode = discountCode_; r.finalAmount = finalAmount;
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
    releaseRedemption({ kind: 'booking', refId: bookingId });

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
    releaseRedemption({ kind: 'booking', refId: bookingId });
    const coach = getCoachStmt.get(b.coach_id);
    const memberRow = getUserNameStmt.get(b.member_id);
    if (coach && memberRow) {
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_member',
        vars: { member_name: memberRow.name, start_at: fmtDateForLine(b.start_at) } });
    }
    return { ok: true };
  });
}

/** admin 於後台取消教練課預約（待核對匯款卡片的「取消預約」）。
 *  與顧客/教練取消同語意：釋放折扣、時段釋出；通知會員＋該教練。 */
export function cancelBookingAdmin({ bookingId, actorId, reason = null }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');
    cancelBookingStmt.run(nowLocal(), actorId, reason, bookingId);
    releaseRedemption({ kind: 'booking', refId: bookingId });
    const coach = getCoachStmt.get(b.coach_id);
    const memberRow = getUserNameStmt.get(b.member_id);
    if (coach && memberRow) {
      const startFmt = fmtDateForLine(b.start_at);
      notify({ userId: b.member_id, sessionId: null, type: 'booking_cancelled_by_shop',
        vars: { coach_display_name: coach.display_name, start_at: startFmt,
                reason_suffix: reason ? `（原因：${reason}）` : '' } });
      // 不通知取消操作者本人（admin 可能同時就是該教練）
      if (coach.user_id !== actorId) {
        notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_shop_coach',
          vars: { member_name: memberRow.name, start_at: startFmt } });
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

/** 後台「待核對匯款」：未核對的教練課預約（含應收金額）。 */
export function listPendingPaymentBookings() {
  return listPendingPaymentStmt.all().map((b) => ({
    ...b,
    final_amount: b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null,
  }));
}

/** admin 核對教練課款項：寫 paid_at/paid_by，通知會員（LINE＋email）。 */
export function confirmBookingPayment({ bookingId, actorId }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'booking_cancelled');
    if (b.paid_at) throw new ApiError(409, 'already_paid');
    db.prepare('UPDATE bookings SET paid_at=?, paid_by=? WHERE id=?').run(nowLocal(), actorId, bookingId);
    const coach = getCoachStmt.get(b.coach_id);
    if (coach) {
      notify({ userId: b.member_id, sessionId: null, type: 'booking_payment_received',
        vars: { coach_display_name: coach.display_name, start_at: fmtDateForLine(b.start_at) } });
    }
    sendPaymentConfirmedEmail(bookingId); // async fire-and-forget（無 email 自動略過）
    return { ok: true };
  });
}

/** 後台「已核對匯款」：教練課＋團課訂單合併，paid_at 新→舊，最多 50 筆。 */
export function listConfirmedPayments() {
  const bookings = db.prepare(`
    SELECT 'booking' AS type, b.id, u.name AS customer_name, u.phone AS customer_phone,
           CASE WHEN b.original_amount IS NULL THEN NULL
                ELSE b.original_amount - COALESCE(b.discount_amount, 0) END AS amount,
           b.start_at AS detail, b.session_type, b.paid_at, pu.name AS paid_by_name
    FROM bookings b
    JOIN users u ON u.id = b.member_id
    LEFT JOIN users pu ON pu.id = b.paid_by
    WHERE b.paid_at IS NOT NULL
    ORDER BY b.paid_at DESC LIMIT 50
  `).all();
  const orders = db.prepare(`
    SELECT 'group_order' AS type, o.id, o.customer_name, o.customer_phone,
           o.total_amount AS amount,
           (SELECT COUNT(*) FROM registrations r WHERE r.order_id = o.id AND r.status = 'confirmed') || ' 場次' AS detail,
           NULL AS session_type, o.paid_at, pu.name AS paid_by_name
    FROM group_orders o
    LEFT JOIN users pu ON pu.id = o.paid_by
    WHERE o.status = 'paid'
    ORDER BY o.paid_at DESC LIMIT 50
  `).all();
  return [...bookings, ...orders]
    .sort((a, b) => (a.paid_at < b.paid_at ? 1 : a.paid_at > b.paid_at ? -1 : 0))
    .slice(0, 50);
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
