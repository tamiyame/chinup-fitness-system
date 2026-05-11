import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertRuleStmt = db.prepare(`
  INSERT INTO coach_availability_rules (coach_id, day_of_week, start_time, end_time, effective_from, effective_to)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listRulesStmt = db.prepare(`
  SELECT * FROM coach_availability_rules
  WHERE coach_id = ?
  ORDER BY day_of_week ASC, start_time ASC
`);
const getRuleStmt = db.prepare('SELECT * FROM coach_availability_rules WHERE id = ?');
const deleteRuleStmt = db.prepare('DELETE FROM coach_availability_rules WHERE id = ? AND coach_id = ?');

const insertExceptionStmt = db.prepare(`
  INSERT INTO coach_availability_exceptions (coach_id, exception_date, type, start_time, end_time, note)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listExceptionsStmt = db.prepare(`
  SELECT * FROM coach_availability_exceptions
  WHERE coach_id = ?
  ORDER BY exception_date ASC
`);
const deleteExceptionStmt = db.prepare('DELETE FROM coach_availability_exceptions WHERE id = ? AND coach_id = ?');

const HHMM = /^\d{2}:\d{2}$/;
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

function validateTimes(startTime, endTime) {
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) throw new ApiError(400, 'invalid_time_format');
  if (startTime >= endTime) throw new ApiError(400, 'invalid_time');
}

export function addRule({ coachId, dayOfWeek, startTime, endTime, effectiveFrom = null, effectiveTo = null }) {
  if (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6) throw new ApiError(400, 'invalid_day_of_week');
  validateTimes(startTime, endTime);
  const from = effectiveFrom || todayLocal();
  if (!YYYYMMDD.test(from)) throw new ApiError(400, 'invalid_effective_from');
  if (effectiveTo && !YYYYMMDD.test(effectiveTo)) throw new ApiError(400, 'invalid_effective_to');
  const info = insertRuleStmt.run(coachId, dayOfWeek, startTime, endTime, from, effectiveTo);
  return { id: info.lastInsertRowid };
}

export function listRules(coachId) {
  return listRulesStmt.all(coachId);
}

export function deleteRule({ coachId, ruleId }) {
  const rule = getRuleStmt.get(ruleId);
  if (!rule) throw new ApiError(404, 'rule_not_found');
  if (rule.coach_id !== coachId) throw new ApiError(403, 'forbidden');
  deleteRuleStmt.run(ruleId, coachId);
  return { ok: true };
}

export function addException({ coachId, exceptionDate, type, startTime = null, endTime = null, note = null }) {
  if (!YYYYMMDD.test(exceptionDate)) throw new ApiError(400, 'invalid_exception_date');
  if (!['leave', 'extra'].includes(type)) throw new ApiError(400, 'invalid_type');
  if (type === 'extra') {
    if (!startTime || !endTime) throw new ApiError(400, 'missing_time');
    validateTimes(startTime, endTime);
  } else {
    startTime = null;
    endTime = null;
  }
  const info = insertExceptionStmt.run(coachId, exceptionDate, type, startTime, endTime, note);
  return { id: info.lastInsertRowid };
}

export function listExceptions(coachId) {
  return listExceptionsStmt.all(coachId);
}

export function deleteException({ coachId, exceptionId }) {
  const info = deleteExceptionStmt.run(exceptionId, coachId);
  if (info.changes === 0) throw new ApiError(404, 'exception_not_found');
  return { ok: true };
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- Configuration (Phase 1 constants) ---
export const SLOT_DURATION_MINUTES = 60;
export const BUFFER_HOURS = 2;
export const BOOKING_WINDOW_DAYS = 30;

const listConfirmedBookings = db.prepare(`
  SELECT start_at FROM bookings
  WHERE coach_id = ? AND status = 'confirmed'
    AND start_at >= ? AND start_at <= ?
`);

const listRulesForDate = db.prepare(`
  SELECT * FROM coach_availability_rules
  WHERE coach_id = ?
    AND day_of_week = ?
    AND effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?)
`);

const listExceptionsForDate = db.prepare(`
  SELECT * FROM coach_availability_exceptions
  WHERE coach_id = ? AND exception_date = ?
`);

/**
 * Compute available 60-min slots for a coach within [fromDate, toDate] inclusive.
 * Returns local wall-clock strings 'YYYY-MM-DDTHH:MM:SS' sorted ascending.
 */
export function computeAvailableSlots({ coachId, fromDate, toDate }) {
  if (!YYYYMMDD.test(fromDate) || !YYYYMMDD.test(toDate)) {
    throw new ApiError(400, 'invalid_date_range');
  }

  const now = new Date();
  const bufferMs = now.getTime() + BUFFER_HOURS * 3600_000;

  const dates = enumerateDates(fromDate, toDate);
  const rawSlots = [];
  for (const date of dates) {
    const exceptions = listExceptionsForDate.all(coachId, date);
    const hasLeave = exceptions.some(e => e.type === 'leave');
    const windows = [];
    if (!hasLeave) {
      const dow = new Date(date + 'T00:00:00').getDay();
      const rules = listRulesForDate.all(coachId, dow, date, date);
      for (const r of rules) windows.push({ start: r.start_time, end: r.end_time });
      for (const e of exceptions) {
        if (e.type === 'extra') windows.push({ start: e.start_time, end: e.end_time });
      }
    }
    for (const w of windows) {
      const slotStartsHH = splitWindowIntoSlots(w.start, w.end, SLOT_DURATION_MINUTES);
      for (const hh of slotStartsHH) rawSlots.push(`${date}T${hh}:00`);
    }
  }
  rawSlots.sort();

  const nowStr = localWallClock(now);
  const afterFilter = rawSlots.filter(s => {
    if (s <= nowStr) return false;
    const slotMs = new Date(s).getTime();
    if (slotMs < bufferMs) return false;
    return true;
  });
  if (afterFilter.length === 0) return [];

  const minSlot = afterFilter[0];
  const maxSlot = afterFilter[afterFilter.length - 1];
  const booked = new Set(
    listConfirmedBookings.all(coachId, minSlot, maxSlot).map(b => b.start_at)
  );
  return afterFilter.filter(s => !booked.has(s));
}

function enumerateDates(fromDate, toDate) {
  const out = [];
  let cur = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  while (cur <= end) {
    const pad = (n) => String(n).padStart(2, '0');
    out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
    cur = new Date(cur.getTime() + 86400_000);
  }
  return out;
}

function splitWindowIntoSlots(startHHMM, endHHMM, durationMin) {
  const [sH, sM] = startHHMM.split(':').map(Number);
  const [eH, eM] = endHHMM.split(':').map(Number);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;
  const out = [];
  for (let m = startMin; m + durationMin <= endMin; m += durationMin) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    out.push(`${hh}:${mm}`);
  }
  return out;
}

function localWallClock(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
