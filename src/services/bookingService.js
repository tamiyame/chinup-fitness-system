import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { findOrCreateUserByPhone, getUserByPhoneAndName } from './userService.js';
import { notify, notifyAdmins, fmtDateForLine } from './notifications.js';
import { generateBindCode } from './lineBindingService.js';
import { applyDiscountTx, releaseRedemption, getOneOnOnePriceByType, getLineOfficialUrl } from './discountService.js';
import { assertBookableTx, computeAvailableSlots } from './availabilityService.js';
import { sendPaymentConfirmedEmail, sendRecurringConfirmation } from './emailService.js';

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
  SELECT b.id, b.start_at, b.session_type, b.created_at, b.recurring_group_id,
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
function createBookingCore({ coach, memberId, startAt, note, sessionType = '1on1', silent = false }) {
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
  if (memberRow && !silent) {  // silent：循環預約逐堂不通知（由呼叫端發一則摘要）
    const startFmt = fmtDateForLine(startAt);
    notify({ userId: coach.user_id, sessionId: null, type: 'booking_created',
      vars: { member_name: memberRow.name, start_at: startFmt } });
    notify({ userId: memberId, sessionId: null, type: 'booking_confirmed',
      vars: { coach_display_name: coach.display_name, start_at: startFmt } });
    // 加掛：店家管理者廣播（第三人稱、中性，沿用 booking_created 文案）
    notifyAdmins({ type: 'booking_created', excludeUserIds: [memberId, coach.user_id], vars: { member_name: memberRow.name, start_at: startFmt } });
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

export function cancelBooking({ bookingId, actorUserId, isCoach = false, reason = null, adminOnBehalf = false }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.status === 'cancelled') throw new ApiError(409, 'already_cancelled');

    const coach = getCoachStmt.get(b.coach_id);

    if (isCoach) {
      if (!coach) throw new ApiError(404, 'coach_not_found');
      // adminOnBehalf：管理者代理該教練取消，跳過「擁有權」檢查（route 已驗證 is_admin + coachId 相符）
      if (!adminOnBehalf && coach.user_id !== actorUserId) throw new ApiError(403, 'forbidden');
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
      // adminOnBehalf 視為教練取消：通知會員「教練取消」
      const isCoachCancel = adminOnBehalf || actorUserId === coach.user_id;
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

/** admin 取消「已收款」的教練課預約並退款（已核對匯款卡片長按）。
 *  金流由店家線下退回，系統記錄 refunded_at/by；已取消但已收款者也可單純補退款紀錄。 */
export function refundBookingAdmin({ bookingId, actorId }) {
  return tx(() => {
    const b = getBookingStmt.get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (!b.paid_at) throw new ApiError(409, 'not_paid');
    if (b.refunded_at) throw new ApiError(409, 'already_refunded');
    const wasConfirmed = b.status === 'confirmed';
    if (wasConfirmed) {
      cancelBookingStmt.run(nowLocal(), actorId, '取消並退款', bookingId);
      releaseRedemption({ kind: 'booking', refId: bookingId });
    }
    db.prepare('UPDATE bookings SET refunded_at=?, refunded_by=? WHERE id=?').run(nowLocal(), actorId, bookingId);
    const coach = getCoachStmt.get(b.coach_id);
    if (coach) {
      const amount = b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null;
      notify({ userId: b.member_id, sessionId: null, type: 'booking_refunded',
        vars: { coach_display_name: coach.display_name, start_at: fmtDateForLine(b.start_at),
                amount_text: amount != null ? `（NT$${amount}）` : '' } });
    }
    return { ok: true, cancelled: wasConfirmed };
  });
}

export function listMemberBookings(memberId) {
  return listMemberStmt.all(memberId);
}

export function listCoachBookings(coachId) {
  return listCoachStmt.all(coachId);
}

/** 後台「待核對匯款」：未核對的教練課預約（含應收金額）。
 *  循環預約（recurring_group_id 非空）同一次送出的集中成一個 group 項目（一張卡）。 */
export function listPendingPaymentBookings() {
  const rows = listPendingPaymentStmt.all().map((b) => ({
    ...b,
    final_amount: b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null,
  }));
  const out = [];
  const groups = new Map(); // group_id → group 項目（保持首見位置 = created_at 新→舊）
  for (const b of rows) {
    if (!b.recurring_group_id) { out.push(b); continue; }
    let g = groups.get(b.recurring_group_id);
    if (!g) {
      g = {
        group: true, group_id: b.recurring_group_id, created_at: b.created_at,
        member_name: b.member_name, member_phone: b.member_phone,
        coach_display_name: b.coach_display_name, session_type: b.session_type,
        sessions: [], total_amount: 0, discount_code: b.discount_code,
      };
      groups.set(b.recurring_group_id, g);
      out.push(g);
    }
    g.sessions.push({ id: b.id, start_at: b.start_at, final_amount: b.final_amount });
    if (b.final_amount != null) g.total_amount += b.final_amount;
  }
  for (const g of groups.values()) g.sessions.sort((a, b2) => (a.start_at < b2.start_at ? -1 : 1));
  return out;
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
  const bookingRows = db.prepare(`
    SELECT 'booking' AS type, b.id, b.recurring_group_id, u.name AS customer_name, u.phone AS customer_phone,
           CASE WHEN b.original_amount IS NULL THEN NULL
                ELSE b.original_amount - COALESCE(b.discount_amount, 0) END AS amount,
           b.start_at AS detail, b.session_type, b.paid_at, b.refunded_at, pu.name AS paid_by_name
    FROM bookings b
    JOIN users u ON u.id = b.member_id
    LEFT JOIN users pu ON pu.id = b.paid_by
    WHERE b.paid_at IS NOT NULL
    ORDER BY b.paid_at DESC LIMIT 200
  `).all();
  // 循環預約同 group 合併一列（金額加總、退款狀態彙整；部分退款另標示）
  const bookings = [];
  const bGroups = new Map();
  for (const r of bookingRows) {
    if (!r.recurring_group_id) { bookings.push(r); continue; }
    let g = bGroups.get(r.recurring_group_id);
    if (!g) {
      g = { type: 'booking_group', id: r.recurring_group_id, customer_name: r.customer_name,
            customer_phone: r.customer_phone, amount: 0, session_type: r.session_type,
            count: 0, refunded_count: 0, first_at: r.detail, detail: '',
            paid_at: r.paid_at, paid_by_name: r.paid_by_name, refunded_at: null };
      bGroups.set(r.recurring_group_id, g);
      bookings.push(g);
    }
    g.count += 1;
    if (r.amount != null) g.amount += r.amount;
    if (r.refunded_at) g.refunded_count += 1;
    if (r.detail < g.first_at) g.first_at = r.detail;
    if (r.paid_at > g.paid_at) g.paid_at = r.paid_at;
  }
  for (const g of bGroups.values()) {
    g.detail = `${g.count} 堂（首堂 ${g.first_at.slice(5, 16).replace('T', ' ').replace('-', '/')}）`;
    if (g.refunded_count === g.count) g.refunded_at = g.paid_at; // 全退款 → 標已退款
    g.partial_refund = g.refunded_count > 0 && g.refunded_count < g.count;
  }
  // 團課改以 paid_at 為準（退款後 status 變 cancelled，但對帳清單仍要保留紀錄）
  const orders = db.prepare(`
    SELECT 'group_order' AS type, o.id, o.customer_name, o.customer_phone,
           o.total_amount AS amount,
           (SELECT COUNT(*) FROM registrations r WHERE r.order_id = o.id AND r.amount_due IS NOT NULL) || ' 場次' AS detail,
           NULL AS session_type, o.paid_at, o.refunded_at, pu.name AS paid_by_name
    FROM group_orders o
    LEFT JOIN users pu ON pu.id = o.paid_by
    WHERE o.paid_at IS NOT NULL
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

// ─────────────────────────────────────────────────────────────────────
// 循環預約（教練/管理者限定；spec: docs/superpowers/specs/2026-06-12-recurring-bookings-design.md）
// ─────────────────────────────────────────────────────────────────────

const RECURRING_FREQS = ['daily', 'weekly', 'monthly', 'custom'];

function _validateRecurringParams({ startAt, sessionType, frequency, intervalDays, count }) {
  if (typeof startAt !== 'string' || !START_AT_RE.test(startAt)) throw new ApiError(400, 'invalid_start_at');
  if (sessionType !== '1on1' && sessionType !== '1on2') throw new ApiError(400, 'invalid_session_type');
  if (!RECURRING_FREQS.includes(frequency)) throw new ApiError(400, 'invalid_frequency');
  if (frequency === 'custom' && (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 90)) {
    throw new ApiError(400, 'invalid_interval');
  }
  if (!Number.isInteger(count) || count < 2 || count > 52) throw new ApiError(400, 'invalid_count');
}

/** occurrence 清單（含首堂）。monthly 以首堂「日」為準，當月無此日 → reason:'no_date'（不順延）。 */
export function recurringOccurrences({ startAt, frequency, intervalDays = null, count }) {
  const [datePart, timePart] = startAt.split('T');
  const [y0, m0, d0] = datePart.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const out = [];
  for (let k = 0; k < count; k++) {
    if (frequency === 'monthly') {
      const totalM = (m0 - 1) + k;
      const y = y0 + Math.floor(totalM / 12);
      const m = (totalM % 12) + 1;
      const probe = new Date(y, m - 1, d0);
      const label = `${y}-${pad(m)}-${pad(d0)}T${timePart}`;
      // 該月無此日（如 2/31）→ Date 會 roll 到下月 → 標記跳過
      if (probe.getMonth() !== m - 1) { out.push({ startAt: label, reason: 'no_date' }); continue; }
      out.push({ startAt: label });
    } else {
      const step = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : intervalDays;
      const d = new Date(`${datePart}T00:00:00`);
      d.setDate(d.getDate() + step * k);
      out.push({ startAt: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${timePart}` });
    }
  }
  return out;
}

/** 單一 occurrence 可建立？＝與單筆公開預約相同管線（班表/請假/緩衝/容量/重疊/freebusy）。
 *  includePast（限管理者）：放行過去日期的場次（容量/重疊仍照常檢查）。 */
function _occurrenceAvailable({ coachId, startAt, units, externalBusy, includePast = false }) {
  const date = startAt.slice(0, 10);
  const slots = computeAvailableSlots({ coachId, fromDate: date, toDate: date, externalBusy, includePast });
  const hit = slots.find((s) => s.start === startAt);
  return !!(hit && hit.remain >= units);
}

/** 預覽：逐場回 { startAt, ok, reason? }，不寫任何東西。 */
export function previewRecurringBookings({ coachId, startAt, sessionType = '1on1', frequency, intervalDays = null, count, externalBusy = null, includePast = false }) {
  _validateRecurringParams({ startAt, sessionType, frequency, intervalDays, count });
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  const units = sessionType === '1on2' ? 2 : 1;
  const occurrences = recurringOccurrences({ startAt, frequency, intervalDays, count }).map((o) => {
    if (o.reason) return { startAt: o.startAt, ok: false, reason: o.reason };
    return _occurrenceAvailable({ coachId, startAt: o.startAt, units, externalBusy, includePast })
      ? { startAt: o.startAt, ok: true }
      : { startAt: o.startAt, ok: false, reason: 'unavailable' };
  });
  return { occurrences };
}

/** 建立循環預約：tx 內逐場重驗、跳過衝突、可建立者逐堂建立（silent）＋逐堂折扣；
 *  markPaid → 全部直接標已核對（經手人=操作者）。摘要通知各一則。 */
export function createRecurringBookings({ coachId, startAt, name, phone, email = null, sessionType = '1on1',
  frequency, intervalDays = null, count, markPaid = false, discountCode = null, actorId, externalBusy = null, includePast = false }) {
  _validateRecurringParams({ startAt, sessionType, frequency, intervalDays, count });
  if (email != null && email !== '' && !EMAIL_RE.test(email)) throw new ApiError(400, 'invalid_email');
  const coach = getCoachStmt.get(coachId);
  if (!coach) throw new ApiError(404, 'coach_not_found');
  if (!coach.is_active) throw new ApiError(409, 'coach_inactive');
  const units = sessionType === '1on2' ? 2 : 1;
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });
    const created = [];
    const skipped = [];
    for (const o of recurringOccurrences({ startAt, frequency, intervalDays, count })) {
      if (o.reason) { skipped.push({ startAt: o.startAt, reason: o.reason }); continue; }
      if (!_occurrenceAvailable({ coachId, startAt: o.startAt, units, externalBusy, includePast })) {
        skipped.push({ startAt: o.startAt, reason: 'unavailable' });
        continue;
      }
      const r = createBookingCore({ coach, memberId: user.id, startAt: o.startAt, note: null, sessionType, silent: true });
      // 金額＋折扣：逐堂套用、與單堂語意一致。額度用罄（總量/每人上限）→ 該堂回
      // 原價、不中斷整批（spec）；其餘錯誤（無效碼/停用/過期）照樣拋出讓操作者知道。
      const subtotal = getOneOnOnePriceByType(sessionType);
      let originalAmount = subtotal, discountAmount = null, discountCode_ = null, finalAmount = subtotal;
      let applied = null;
      try {
        applied = applyDiscountTx({ code: discountCode, phone, subtotal, kind: 'booking', refId: r.id });
      } catch (e) {
        if (!(e instanceof ApiError) || !['code_exhausted', 'per_phone_exhausted'].includes(e.code)) throw e;
      }
      if (applied) { discountAmount = applied.discountAmount; discountCode_ = applied.discountCode; finalAmount = applied.finalTotal; }
      db.prepare('UPDATE bookings SET original_amount=?, discount_amount=?, discount_code=?, customer_email=? WHERE id=?')
        .run(originalAmount, discountAmount, discountCode_, (email || null), r.id);
      created.push({ id: r.id, startAt: o.startAt, finalAmount });
    }
    if (!created.length) throw new ApiError(409, 'all_conflicted', { skipped });

    const groupId = created[0].id;
    const ids = created.map((c) => c.id);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE bookings SET recurring_group_id = ? WHERE id IN (${ph})`).run(groupId, ...ids);
    if (markPaid) {
      db.prepare(`UPDATE bookings SET paid_at = ?, paid_by = ? WHERE id IN (${ph})`).run(nowLocal(), actorId, ...ids);
    }

    // 摘要通知（不逐堂轟炸）
    const freqText = frequency === 'daily' ? '每日' : frequency === 'weekly' ? '每週'
      : frequency === 'monthly' ? '每月' : `每 ${intervalDays} 天`;
    const summaryVars = {
      count: created.length, coach_display_name: coach.display_name,
      member_name: user.name, freq_text: freqText, first_at: fmtDateForLine(created[0].startAt),
    };
    notify({ userId: user.id, sessionId: null, type: 'booking_recurring_created', vars: summaryVars });
    if (coach.user_id !== actorId) {
      notify({ userId: coach.user_id, sessionId: null, type: 'booking_recurring_created_coach', vars: summaryVars });
    }
    notifyAdmins({ type: 'booking_recurring_created_coach', excludeUserId: actorId, vars: summaryVars });
    if (email) sendRecurringConfirmation(groupId); // fire-and-forget（無 email 自動略過）

    const result = {
      created, skipped, groupId, markPaid: !!markPaid,
      totalAmount: created.reduce((sum, c) => sum + (c.finalAmount || 0), 0),
    };
    if (user.role === 'user' && !user.line_user_id) result.lineBindCode = generateBindCode(user.id).code;
    result.lineOfficialUrl = getLineOfficialUrl();
    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────
// 循環預約「整批」操作（待核對/已核對卡片以 recurring_group_id 集中一張卡）
// ─────────────────────────────────────────────────────────────────────

/** 整批核對收款：group 內所有未收款預約 → 已核對；會員 LINE 摘要一則。 */
export function confirmBookingPaymentGroup({ groupId, actorId }) {
  return tx(() => {
    const rows = db.prepare(
      "SELECT * FROM bookings WHERE recurring_group_id=? AND status='confirmed' AND paid_at IS NULL ORDER BY start_at ASC"
    ).all(groupId);
    if (!rows.length) throw new ApiError(409, 'already_paid');
    const ph = rows.map(() => '?').join(',');
    db.prepare(`UPDATE bookings SET paid_at=?, paid_by=? WHERE id IN (${ph})`).run(nowLocal(), actorId, ...rows.map(r => r.id));
    const coach = getCoachStmt.get(rows[0].coach_id);
    if (coach) {
      notify({ userId: rows[0].member_id, sessionId: null, type: 'booking_payment_received',
        vars: { coach_display_name: coach.display_name, start_at: `${fmtDateForLine(rows[0].start_at)} 起共 ${rows.length} 堂` } });
    }
    return { ok: true, confirmed: rows.length };
  });
}

/** 整批取消（待核對卡片）：只取消「未收款」的預約；已收款的留在已核對卡走退款。 */
export function cancelBookingAdminGroup({ groupId, actorId, reason = null }) {
  return tx(() => {
    const rows = db.prepare(
      "SELECT * FROM bookings WHERE recurring_group_id=? AND status='confirmed' AND paid_at IS NULL ORDER BY start_at ASC"
    ).all(groupId);
    if (!rows.length) throw new ApiError(409, 'no_pending_bookings');
    for (const b of rows) {
      cancelBookingStmt.run(nowLocal(), actorId, reason, b.id);
      releaseRedemption({ kind: 'booking', refId: b.id });
    }
    const coach = getCoachStmt.get(rows[0].coach_id);
    const memberRow = getUserNameStmt.get(rows[0].member_id);
    if (coach && memberRow) {
      const startFmt = `${fmtDateForLine(rows[0].start_at)} 起共 ${rows.length} 堂`;
      notify({ userId: rows[0].member_id, sessionId: null, type: 'booking_cancelled_by_shop',
        vars: { coach_display_name: coach.display_name, start_at: startFmt,
                reason_suffix: reason ? `（原因：${reason}）` : '' } });
      if (coach.user_id !== actorId) {
        notify({ userId: coach.user_id, sessionId: null, type: 'booking_cancelled_by_shop_coach',
          vars: { member_name: memberRow.name, start_at: startFmt } });
      }
    }
    return { ok: true, cancelled: rows.map(r => r.id) };
  });
}

/** 整批取消並退款（已核對卡片長按）：group 內已收款未退款者全數退款（必要時取消）。 */
export function refundBookingGroupAdmin({ groupId, actorId }) {
  return tx(() => {
    const rows = db.prepare(
      "SELECT * FROM bookings WHERE recurring_group_id=? AND paid_at IS NOT NULL AND refunded_at IS NULL ORDER BY start_at ASC"
    ).all(groupId);
    if (!rows.length) throw new ApiError(409, 'already_refunded');
    const now = nowLocal();
    const cancelled = [];
    let total = 0;
    for (const b of rows) {
      if (b.status === 'confirmed') {
        cancelBookingStmt.run(now, actorId, '取消並退款', b.id);
        releaseRedemption({ kind: 'booking', refId: b.id });
        cancelled.push(b.id);
      }
      db.prepare('UPDATE bookings SET refunded_at=?, refunded_by=? WHERE id=?').run(now, actorId, b.id);
      if (b.original_amount != null) total += b.original_amount - (b.discount_amount || 0);
    }
    const coach = getCoachStmt.get(rows[0].coach_id);
    if (coach) {
      notify({ userId: rows[0].member_id, sessionId: null, type: 'booking_refunded',
        vars: { coach_display_name: coach.display_name,
                start_at: `${fmtDateForLine(rows[0].start_at)} 起共 ${rows.length} 堂`,
                amount_text: total > 0 ? `（NT$${total}）` : '' } });
    }
    return { ok: true, refunded: rows.length, cancelled };
  });
}
