import { db } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getBookingHourlyCapacity } from './discountService.js';

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
    // 請假：兩個時間都給 → 部分時段請假（驗證）；否則 → 整天請假（null）
    if (startTime && endTime) {
      validateTimes(startTime, endTime);
    } else {
      startTime = null;
      endTime = null;
    }
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

// 同教練區間重疊（取代舊 exact-match）：撈出與範圍重疊的 confirmed 預約區間。
const listCoachOverlapping = db.prepare(`
  SELECT start_at, end_at FROM bookings
  WHERE coach_id = ? AND status = 'confirmed' AND start_at < ? AND end_at > ?
`);
// 全店（不分教練）confirmed 預約：小時桶容量計算用。
const listAllOverlapping = db.prepare(`
  SELECT start_at, end_at, session_type FROM bookings
  WHERE status = 'confirmed' AND start_at < ? AND end_at > ?
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
 * Returns [{ start: 'YYYY-MM-DDTHH:MM:SS', remain: number }] sorted ascending.
 * remain = 該時段在全店小時桶容量下還可容納的人數（min over 所佔桶）。
 * externalBusy: Map<'YYYY-MM-DD', Array<{start:'HH:MM', end:'HH:MM'}>>（Google 日曆
 * 手動活動的忙碌區間；null = 無外部封鎖）。與部分請假同一套重疊過濾。
 */
export function computeAvailableSlots({ coachId, fromDate, toDate, bookingWindowDays = BOOKING_WINDOW_DAYS, externalBusy = null }) {
  if (!YYYYMMDD.test(fromDate) || !YYYYMMDD.test(toDate)) {
    throw new ApiError(400, 'invalid_date_range');
  }

  const now = new Date();
  const bufferMs = now.getTime() + BUFFER_HOURS * 3600_000;
  const windowEndMs = now.getTime() + bookingWindowDays * 86400_000;

  const dates = enumerateDates(fromDate, toDate);
  const rawSlots = [];
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  for (const date of dates) {
    const exceptions = listExceptionsForDate.all(coachId, date);
    // 整天請假（無時段）→ 當天完全封鎖；部分時段請假 → 只扣掉重疊的 slot。
    const allDayLeave = exceptions.some(e => e.type === 'leave' && !e.start_time);
    const windows = [];
    if (!allDayLeave) {
      const dow = new Date(date + 'T00:00:00').getDay();
      const rules = listRulesForDate.all(coachId, dow, date, date);
      for (const r of rules) windows.push({ start: r.start_time, end: r.end_time });
      for (const e of exceptions) {
        if (e.type === 'extra') windows.push({ start: e.start_time, end: e.end_time });
      }
    }
    // 部分請假 + 外部（Google 日曆）忙碌區間 → 同一套重疊過濾
    const blockers = exceptions
      .filter(e => e.type === 'leave' && e.start_time && e.end_time)
      .map(e => ({ start: e.start_time, end: e.end_time }));
    if (externalBusy && externalBusy.get(date)) blockers.push(...externalBusy.get(date));
    for (const w of windows) {
      const slotStartsHH = splitWindowIntoSlots(w.start, w.end, SLOT_DURATION_MINUTES);
      for (const hh of slotStartsHH) {
        const s = toMin(hh), e = s + SLOT_DURATION_MINUTES;
        // 與任一封鎖區間重疊（slot[s,e) ∩ [bs,be) ≠ ∅）→ 封鎖
        const blocked = blockers.some(b => s < toMin(b.end) && e > toMin(b.start));
        if (!blocked) rawSlots.push(`${date}T${hh}:00`);
      }
    }
  }
  rawSlots.sort();
  // 重疊視窗（多條 rule / rule+加開蓋到同一小時）可能產生重複 slot 字串 → 去重
  const dedupedSlots = [...new Set(rawSlots)];

  const nowStr = localWallClock(now);
  const afterFilter = dedupedSlots.filter(s => {
    if (s <= nowStr) return false;
    const slotMs = new Date(s).getTime();
    if (slotMs < bufferMs) return false;
    if (slotMs > windowEndMs) return false;
    return true;
  });
  if (afterFilter.length === 0) return [];

  const rangeStart = afterFilter[0];
  const rangeEnd = addMinutesLocal(afterFilter[afterFilter.length - 1], SLOT_DURATION_MINUTES);
  // 同教練：任何重疊即不可約（教練無法同時帶兩堂）
  const coachIntervals = listCoachOverlapping.all(coachId, rangeEnd, rangeStart);
  // 全店容量：小時桶人數加總
  const loads = bucketLoads(listAllOverlapping.all(rangeEnd, rangeStart));
  const capacity = getBookingHourlyCapacity();

  const out = [];
  for (const s of afterFilter) {
    const e = addMinutesLocal(s, SLOT_DURATION_MINUTES);
    if (coachIntervals.some(b => s < b.end_at && e > b.start_at)) continue;
    let remain = capacity;
    for (const key of hourBuckets(s, e)) remain = Math.min(remain, capacity - (loads.get(key) || 0));
    if (remain >= 1) out.push({ start: s, remain });
  }
  return out;
}

/** 同步、純 DB 的最終預約檢查（在 BEGIN IMMEDIATE tx 內呼叫 → 無競態）。
 *  同教練區間重疊 → 409 slot_taken；全店小時桶容量不足 → 409 slot_full。 */
export function assertBookableTx({ coachId, startAt, endAt, units }) {
  const overlap = listCoachOverlapping.all(coachId, endAt, startAt);
  if (overlap.length) throw new ApiError(409, 'slot_taken');
  const buckets = hourBuckets(startAt, endAt);
  // 撈涵蓋所有所佔桶的預約（桶範圍 = 第一桶起點 ~ 最後桶終點）
  const spanStart = buckets[0] + ':00:00';
  const spanEnd = addMinutesLocal(buckets[buckets.length - 1] + ':00:00', 60);
  const loads = bucketLoads(listAllOverlapping.all(spanEnd, spanStart));
  const capacity = getBookingHourlyCapacity();
  for (const key of buckets) {
    if ((loads.get(key) || 0) + units > capacity) throw new ApiError(409, 'slot_full');
  }
}

/** 區間 [startAt, endAt) 重疊到的小時桶 key 列表（'YYYY-MM-DDTHH'，跨日安全）。 */
function hourBuckets(startAt, endAt) {
  const out = [];
  let cur = new Date(startAt.slice(0, 13) + ':00:00'); // floor 到整點
  const end = new Date(endAt);
  while (cur < end) {
    const pad = (n) => String(n).padStart(2, '0');
    out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}T${pad(cur.getHours())}`);
    cur = new Date(cur.getTime() + 3600_000);
  }
  return out;
}

/** 把 confirmed 預約列表攤成 Map<bucketKey, 人數加總>（1on2 佔 2 人）。 */
function bucketLoads(rows) {
  const loads = new Map();
  for (const b of rows) {
    const units = b.session_type === '1on2' ? 2 : 1;
    for (const key of hourBuckets(b.start_at, b.end_at)) {
      loads.set(key, (loads.get(key) || 0) + units);
    }
  }
  return loads;
}

/** 牆鐘字串 + 分鐘（跨日安全，與 bookingService.addMinutes 同邏輯）。 */
function addMinutesLocal(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
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
