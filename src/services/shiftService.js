// 駐場打卡與班表：固定週班表（coach_shifts）＋出席紀錄（shift_attendance，起訖/時數快照、軟刪註銷）。
// 規則見 docs/superpowers/specs/2026-07-09-shift-attendance-checkin-design.md。
import { db, nowLocal, tx } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting } from './discountService.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** 'HH:MM' 起訖 → 小時數（REAL），如 09:00–11:00 → 2、08:00–09:30 → 1.5 */
export function hoursBetween(startTime, endTime) {
  return (toMin(endTime) - toMin(startTime)) / 60;
}

// ── 班表 CRUD ──
const listAllShiftsStmt = db.prepare('SELECT * FROM coach_shifts ORDER BY coach_id ASC, day_of_week ASC, start_time ASC');
const listCoachShiftsStmt = db.prepare('SELECT * FROM coach_shifts WHERE coach_id = ? ORDER BY day_of_week ASC, start_time ASC');
const getShiftStmt = db.prepare('SELECT * FROM coach_shifts WHERE id = ?');
const insertShiftStmt = db.prepare(`
  INSERT INTO coach_shifts (coach_id, day_of_week, start_time, end_time, effective_from, effective_to)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const shiftsForDateStmt = db.prepare(`
  SELECT * FROM coach_shifts
  WHERE coach_id = ? AND day_of_week = ?
    AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
  ORDER BY start_time ASC
`);
const updateShiftStmt = db.prepare('UPDATE coach_shifts SET start_time = ?, end_time = ?, effective_from = ?, effective_to = ? WHERE id = ?');
const deleteShiftStmt = db.prepare('DELETE FROM coach_shifts WHERE id = ?');

function validateShiftFields({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo }) {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new ApiError(400, 'invalid_day_of_week');
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '') || startTime >= endTime) throw new ApiError(400, 'invalid_time_range');
  if (!DATE_RE.test(effectiveFrom || '')) throw new ApiError(400, 'invalid_effective_range');
  if (effectiveTo != null && (!DATE_RE.test(effectiveTo) || effectiveTo < effectiveFrom)) throw new ApiError(400, 'invalid_effective_range');
}

export function listShifts(coachId = null) {
  return coachId == null ? listAllShiftsStmt.all() : listCoachShiftsStmt.all(coachId);
}
export function getShift(id) { return getShiftStmt.get(id); }

export function createShift({ coachId, dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo = null }) {
  validateShiftFields({ dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo });
  const info = insertShiftStmt.run(coachId, dayOfWeek, startTime, endTime, effectiveFrom, effectiveTo);
  return getShiftStmt.get(Number(info.lastInsertRowid));
}

/** 局部更新；undefined＝不動、effectiveTo: null＝清空。合併後整組重新驗證。 */
export function updateShift(id, { startTime, endTime, effectiveFrom, effectiveTo } = {}) {
  const cur = getShiftStmt.get(id);
  if (!cur) throw new ApiError(404, 'shift_not_found');
  const next = {
    dayOfWeek: cur.day_of_week,
    startTime: startTime !== undefined ? startTime : cur.start_time,
    endTime: endTime !== undefined ? endTime : cur.end_time,
    effectiveFrom: effectiveFrom !== undefined ? effectiveFrom : cur.effective_from,
    effectiveTo: effectiveTo !== undefined ? effectiveTo : cur.effective_to,
  };
  validateShiftFields(next);
  updateShiftStmt.run(next.startTime, next.endTime, next.effectiveFrom, next.effectiveTo, id);
  return getShiftStmt.get(id);
}

export function deleteShift(id) {
  const info = deleteShiftStmt.run(id);
  if (info.changes === 0) throw new ApiError(404, 'shift_not_found');
}

/** 某教練在某日期的有效班表（dow 相符＋生效區間涵蓋該日），start_time 升冪。 */
export function shiftsForDate(coachId, dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return shiftsForDateStmt.all(coachId, dow, dateStr, dateStr);
}
