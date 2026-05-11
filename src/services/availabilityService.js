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
