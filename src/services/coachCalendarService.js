import { db } from '../db/connection.js';
import { ApiError } from './registration.js';
import { computeAvailableSlots } from './availabilityService.js';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const BK_COLS = `b.id, b.coach_id, b.start_at, b.end_at, b.session_type, b.package_id, b.paid_at, b.discount_code,
       u.name AS member_name, c.display_name AS coach_name`;
const weekBookings = db.prepare(`
  SELECT ${BK_COLS}
  FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id
  WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekAllBookings = db.prepare(`
  SELECT ${BK_COLS}
  FROM bookings b JOIN users u ON u.id = b.member_id JOIN coaches c ON c.id = b.coach_id
  WHERE b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekGroupSessions = db.prepare(`
  SELECT s.id, s.coach_id, s.start_at, s.end_at, t.name, c.display_name AS coach_name
  FROM course_sessions s JOIN course_templates t ON t.id = s.template_id
  LEFT JOIN coaches c ON c.id = s.coach_id
  WHERE s.coach_id = ? AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  ORDER BY s.start_at ASC
`);
const weekAllGroupSessions = db.prepare(`
  SELECT s.id, s.coach_id, s.start_at, s.end_at, t.name, c.display_name AS coach_name
  FROM course_sessions s JOIN course_templates t ON t.id = s.template_id
  LEFT JOIN coaches c ON c.id = s.coach_id
  WHERE s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  ORDER BY s.start_at ASC
`);

/** 某教練（或 all=管理者全部教練）自 start（週一）起 7 天的：個別課預約 + 團課場次 + 班表底色。 */
export function getCoachWeek({ coachId, start, all = false }) {
  if (!YYYYMMDD.test(start)) throw new ApiError(400, 'invalid_start');
  const endExclusive = addDays(start, 7);
  const lo = `${start}T00:00:00`, hi = `${endExclusive}T00:00:00`;
  const bookings = all ? weekAllBookings.all(lo, hi) : weekBookings.all(coachId, lo, hi);
  const groupSessions = all ? weekAllGroupSessions.all(lo, hi) : weekGroupSessions.all(coachId, lo, hi);
  // 班表底色：有指定 coachId 才算（全覽未選教練 → []）。
  const availableSlots = coachId
    ? computeAvailableSlots({ coachId, fromDate: start, toDate: addDays(start, 6), externalBusy: null, includePast: true })
    : [];
  return { weekStart: start, all: !!all, bookings, groupSessions, availableSlots };
}

const searchCustomersStmt = db.prepare(`
  SELECT id, name, phone FROM users
  WHERE role = 'user' AND archived_at IS NULL AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
  ORDER BY name ASC LIMIT 20
`);
/** 客人搜尋（姓名或電話 LIKE，跳脫 %/_）。只回 id/name/phone。 */
export function searchCustomers(q) {
  const term = String(q || '').trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  return searchCustomersStmt.all(like, like);
}
