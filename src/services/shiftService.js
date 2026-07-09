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

// ── 打卡 ──

/** 兩座標球面距離（公尺，四捨五入）。 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** 打卡參數（app_settings）。座標未設定 → configured=false，打卡端點回 503。 */
export function getCheckinConfig() {
  const lat = parseFloat(getSetting('checkin_lat') ?? '');
  const lng = parseFloat(getSetting('checkin_lng') ?? '');
  const radius = parseInt(getSetting('checkin_radius_m') || '150', 10);
  const windowBeforeMin = parseInt(getSetting('checkin_window_before_min') || '30', 10);
  return { lat, lng, radius, windowBeforeMin, configured: Number.isFinite(lat) && Number.isFinite(lng) };
}

const attendanceForShiftStmt = db.prepare('SELECT * FROM shift_attendance WHERE coach_id = ? AND work_date = ? AND shift_id = ?');
const attendanceForDateStmt = db.prepare('SELECT * FROM shift_attendance WHERE coach_id = ? AND work_date = ? ORDER BY start_time ASC');
const getAttendanceStmt = db.prepare('SELECT * FROM shift_attendance WHERE id = ?');
const insertAttendanceStmt = db.prepare(`
  INSERT INTO shift_attendance (coach_id, shift_id, work_date, start_time, end_time, hours, source,
    checked_in_at, lat, lng, accuracy, distance_m, created_by, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * GPS 打卡：距離驗證 → 窗口比對（[start−窗口, end]，多列命中取最早開始）→ 冪等寫入。
 * 已有未註銷紀錄 → { already: true }；已註銷 → 409 attendance_voided（重登走管理者補登）。
 */
export function checkIn({ coachId, lat, lng, accuracy = null, now = nowLocal() }) {
  const cfg = getCheckinConfig();
  if (!cfg.configured) throw new ApiError(503, 'checkin_not_configured');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new ApiError(400, 'missing_location');
  const distance = haversineMeters(lat, lng, cfg.lat, cfg.lng);
  if (distance > cfg.radius) throw new ApiError(403, 'not_at_gym', { distance_m: distance });

  const workDate = now.slice(0, 10);
  const nowMin = toMin(now.slice(11, 16));
  const candidates = shiftsForDate(coachId, workDate)
    .filter((s) => nowMin >= toMin(s.start_time) - cfg.windowBeforeMin && nowMin <= toMin(s.end_time));
  if (!candidates.length) throw new ApiError(409, 'no_active_shift');
  const shift = candidates[0];

  return tx(() => {
    const existing = attendanceForShiftStmt.get(coachId, workDate, shift.id);
    if (existing) {
      if (existing.voided_at) throw new ApiError(409, 'attendance_voided');
      return { attendance: existing, already: true };
    }
    const info = insertAttendanceStmt.run(coachId, shift.id, workDate, shift.start_time, shift.end_time,
      hoursBetween(shift.start_time, shift.end_time), 'checkin', now, lat, lng, accuracy, distance, null, null);
    return { attendance: getAttendanceStmt.get(Number(info.lastInsertRowid)), already: false };
  });
}

/** /checkin 頁資料：今天各班表時段狀態 ＋ 班表外補登列（shift_id NULL）。 */
export function todayStatus(coachId, now = nowLocal()) {
  const workDate = now.slice(0, 10);
  const nowMin = toMin(now.slice(11, 16));
  const { windowBeforeMin } = getCheckinConfig();
  const attendance = attendanceForDateStmt.all(coachId, workDate);
  const byShift = new Map(attendance.filter((a) => a.shift_id != null).map((a) => [a.shift_id, a]));
  const slots = shiftsForDate(coachId, workDate).map((s) => {
    const a = byShift.get(s.id);
    let status;
    if (a) status = a.voided_at ? 'voided' : 'done';
    else if (nowMin < toMin(s.start_time) - windowBeforeMin) status = 'upcoming';
    else if (nowMin > toMin(s.end_time)) status = 'closed';
    else status = 'open';
    return { shiftId: s.id, startTime: s.start_time, endTime: s.end_time,
      hours: hoursBetween(s.start_time, s.end_time), status, checkedInAt: a?.checked_in_at ?? null };
  });
  const extras = attendance.filter((a) => a.shift_id == null && !a.voided_at)
    .map((a) => ({ startTime: a.start_time, endTime: a.end_time, hours: a.hours }));
  return { date: workDate, slots, extras };
}

// ── 補登 / 註銷 / 期別彙總 ──

const restoreAttendanceStmt = db.prepare('UPDATE shift_attendance SET voided_at = NULL, voided_by = NULL, note = COALESCE(?, note) WHERE id = ?');
const voidAttendanceStmt = db.prepare('UPDATE shift_attendance SET voided_at = ?, voided_by = ? WHERE id = ?');

/**
 * 管理者補登。帶 shiftId：快照該班表起訖；同鍵已有未註銷列 → 409；已註銷列 → 復原（清 voided_*，
 * 覆寫 note，保留原始佐證）——與 UNIQUE(coach_id, work_date, shift_id) 相容的重登路徑。
 * 不帶 shiftId：自訂起訖直接插入（班表外加班；同日可多筆）。
 */
export function manualAttendance({ coachId, workDate, shiftId = null, startTime = null, endTime = null, note = null, createdBy }) {
  if (!DATE_RE.test(workDate || '')) throw new ApiError(400, 'invalid_work_date');
  if (shiftId != null) {
    const shift = getShiftStmt.get(shiftId);
    if (!shift || shift.coach_id !== coachId) throw new ApiError(404, 'shift_not_found');
    return tx(() => {
      const existing = attendanceForShiftStmt.get(coachId, workDate, shift.id);
      if (existing) {
        if (!existing.voided_at) throw new ApiError(409, 'duplicate_attendance');
        restoreAttendanceStmt.run(note, existing.id);
        return getAttendanceStmt.get(existing.id);
      }
      const info = insertAttendanceStmt.run(coachId, shift.id, workDate, shift.start_time, shift.end_time,
        hoursBetween(shift.start_time, shift.end_time), 'manual', null, null, null, null, null, createdBy, note);
      return getAttendanceStmt.get(Number(info.lastInsertRowid));
    });
  }
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '') || startTime >= endTime) throw new ApiError(400, 'invalid_time_range');
  const info = insertAttendanceStmt.run(coachId, null, workDate, startTime, endTime,
    hoursBetween(startTime, endTime), 'manual', null, null, null, null, null, createdBy, note);
  return getAttendanceStmt.get(Number(info.lastInsertRowid));
}

/** 註銷（軟刪）：薪資排除、紀錄留檔。 */
export function voidAttendance(id, voidedBy) {
  const row = getAttendanceStmt.get(id);
  if (!row) throw new ApiError(404, 'attendance_not_found');
  if (row.voided_at) throw new ApiError(409, 'already_voided');
  voidAttendanceStmt.run(nowLocal(), voidedBy, id);
  return getAttendanceStmt.get(id);
}

const periodHoursStmt = db.prepare(`
  SELECT COALESCE(SUM(hours), 0) AS h FROM shift_attendance
  WHERE coach_id = ? AND voided_at IS NULL AND work_date >= ? AND work_date <= ?
`);
export function coachPeriodHours(coachId, startDate, endDate) {
  return periodHoursStmt.get(coachId, startDate, endDate).h;
}

const periodRowsStmt = db.prepare(`
  SELECT * FROM shift_attendance
  WHERE voided_at IS NULL AND work_date >= ? AND work_date <= ?
  ORDER BY coach_id ASC, work_date ASC, start_time ASC
`);
/** 期別內全教練駐場彙總（payroll 與後台明細共用）；日期含端點。 */
export function shiftSummaryByCoach(startDate, endDate) {
  const map = new Map();
  for (const r of periodRowsStmt.all(startDate, endDate)) {
    if (!map.has(r.coach_id)) map.set(r.coach_id, { hours: 0, details: [] });
    const e = map.get(r.coach_id);
    e.hours += r.hours;
    e.details.push({ attendanceId: r.id, workDate: r.work_date, startTime: r.start_time, endTime: r.end_time,
      hours: r.hours, source: r.source, checkedInAt: r.checked_in_at, distanceM: r.distance_m, note: r.note });
  }
  return map;
}
