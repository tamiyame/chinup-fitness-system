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

const weekBookings = db.prepare(`
  SELECT b.id, b.start_at, b.end_at, b.session_type, b.package_id, u.name AS member_name
  FROM bookings b JOIN users u ON u.id = b.member_id
  WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.start_at ASC
`);
const weekGroupSessions = db.prepare(`
  SELECT s.id, s.start_at, s.end_at, t.name
  FROM course_sessions s JOIN course_templates t ON t.id = s.template_id
  WHERE s.coach_id = ? AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  ORDER BY s.start_at ASC
`);

/** 某教練自 start（週一）起 7 天的：個別課預約 + 團課場次 + 班表可預約時段。 */
export function getCoachWeek({ coachId, start }) {
  if (!YYYYMMDD.test(start)) throw new ApiError(400, 'invalid_start');
  const endExclusive = addDays(start, 7); // [start, start+7) 的 00:00
  const lo = `${start}T00:00:00`, hi = `${endExclusive}T00:00:00`;
  const bookings = weekBookings.all(coachId, lo, hi);
  const groupSessions = weekGroupSessions.all(coachId, lo, hi);
  // 班表可預約時段（含過去，供整週底色；reuse 既有邏輯）
  const availableSlots = computeAvailableSlots({ coachId, fromDate: start, toDate: addDays(start, 6), externalBusy: null, includePast: true });
  return { weekStart: start, bookings, groupSessions, availableSlots };
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
