import { db, tx, nowLocal, offsetLocal } from '../db/connection.js';
import { expandTemplate, RECURRENCES } from './schedule.js';
import { notify, notifyCourseCoach } from './notifications.js';
import { ApiError } from './registration.js';
import { releaseOrderRedemptionIfInactive } from './groupOrderService.js';

const insertTemplate = db.prepare(`
  INSERT INTO course_templates
    (name, description, min_capacity, max_capacity, day_of_week, start_time,
     duration_minutes, recurrence, cycle_start_date, cycle_end_date,
     registration_deadline_hours, status, price_per_session, coach_id)
  VALUES (@name, @description, @min_capacity, @max_capacity, @day_of_week, @start_time,
          @duration_minutes, @recurrence, @cycle_start_date, @cycle_end_date,
          @registration_deadline_hours, @status, @price_per_session, @coach_id)
`);

const insertSession = db.prepare(`
  INSERT OR IGNORE INTO course_sessions
    (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
  VALUES (?, ?, ?, ?, ?, 'open', ?)
`);

const updateTemplate = db.prepare(`
  UPDATE course_templates SET
    name=@name, description=@description,
    min_capacity=@min_capacity, max_capacity=@max_capacity,
    day_of_week=@day_of_week, start_time=@start_time,
    duration_minutes=@duration_minutes, recurrence=@recurrence,
    cycle_start_date=@cycle_start_date, cycle_end_date=@cycle_end_date,
    registration_deadline_hours=@registration_deadline_hours, status=@status,
    price_per_session=@price_per_session, coach_id=@coach_id
  WHERE id=@id
`);

function validateTemplate(t) {
  const required = ['name', 'min_capacity', 'max_capacity', 'day_of_week', 'start_time', 'recurrence', 'cycle_start_date', 'cycle_end_date'];
  for (const k of required) {
    if (t[k] === undefined || t[k] === null || t[k] === '') throw new ApiError(400, `missing_${k}`);
  }
  if (t.min_capacity < 1 || t.max_capacity < t.min_capacity) throw new ApiError(400, 'invalid_capacity');
  if (!RECURRENCES.includes(t.recurrence)) throw new ApiError(400, 'invalid_recurrence');
  if (t.day_of_week < 0 || t.day_of_week > 6) throw new ApiError(400, 'invalid_day_of_week');
  if (!/^\d{2}:\d{2}$/.test(t.start_time)) throw new ApiError(400, 'invalid_start_time');
  if (t.cycle_end_date < t.cycle_start_date) throw new ApiError(400, 'invalid_cycle_dates');
}

function normalize(t) {
  return {
    name: t.name,
    description: t.description ?? '',
    min_capacity: Number(t.min_capacity),
    max_capacity: Number(t.max_capacity),
    day_of_week: Number(t.day_of_week),
    start_time: t.start_time,
    duration_minutes: Number(t.duration_minutes ?? 60),
    recurrence: t.recurrence,
    cycle_start_date: t.cycle_start_date,
    cycle_end_date: t.cycle_end_date,
    registration_deadline_hours: Number(t.registration_deadline_hours ?? 24),
    status: t.status ?? 'published',
    price_per_session: Number(t.price_per_session ?? 0),
    // 寬鬆：缺值存 NULL；非法非空值（如 Number('x')→NaN）亦落為 NULL。前台下拉保證只送有效 id，真整數壞值由 DB 外鍵擋下。
    coach_id: (t.coach_id === undefined || t.coach_id === null || t.coach_id === '') ? null : Number(t.coach_id),
  };
}

export function createTemplate(payload) {
  const t = normalize(payload);
  validateTemplate(t);
  return tx(() => {
    const info = insertTemplate.run(t);
    const templateId = info.lastInsertRowid;
    const sessions = expandTemplate(t);
    for (const s of sessions) {
      insertSession.run(templateId, s.session_date, s.start_at, s.end_at, s.registration_deadline, t.coach_id);
    }
    return {
      templateId,
      sessionsCreated: sessions.length,
    };
  });
}

export function editTemplate(id, payload) {
  const t = normalize(payload);
  validateTemplate(t);
  return tx(() => {
    const existing = db.prepare('SELECT * FROM course_templates WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'template_not_found');
    updateTemplate.run({ ...t, id });
    // 只重新展開「尚未開始 且 尚無報名」的場次
    db.prepare(`
      DELETE FROM course_sessions
      WHERE template_id = ? AND start_at > ?
        AND id NOT IN (SELECT DISTINCT session_id FROM registrations WHERE session_id IS NOT NULL)
    `).run(id, nowLocal());
    const sessions = expandTemplate(t);
    let added = 0;
    for (const s of sessions) {
      const info = insertSession.run(id, s.session_date, s.start_at, s.end_at, s.registration_deadline, t.coach_id);
      if (info.changes > 0) added++;
    }
    // 範本教練若變更，同步所有「未來場次」的冗餘 coach_id（含已有報名、未被重新展開者）。
    db.prepare('UPDATE course_sessions SET coach_id = ? WHERE template_id = ? AND start_at > ?').run(t.coach_id, id, nowLocal());
    return { templateId: id, sessionsAdded: added };
  });
}

const listTemplatesStmt = db.prepare(`
  SELECT t.*, c.display_name AS coach_name
  FROM course_templates t
  LEFT JOIN coaches c ON c.id = t.coach_id
  ORDER BY t.created_at DESC
`);
const listSessionsForTemplate = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC');
// 即時計算用：confirmed_count/waitlist_count 快取欄位未被團課訂單流程維護（只剩舊 register() 流程在更新），
// 後台顯示一律改用即時計數。正取排除請假(on_leave)。
const liveConfirmedCount = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id = ? AND status = 'confirmed' AND on_leave = 0");
const liveWaitlistCount = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id = ? AND status = 'waitlisted'");

export function listTemplates() {
  return listTemplatesStmt.all();
}

export function getTemplate(id) {
  const t = db.prepare('SELECT * FROM course_templates WHERE id = ?').get(id);
  if (!t) throw new ApiError(404, 'template_not_found');
  // 即時計算正取/候補人數（覆蓋可能過時的快取欄位）。
  t.sessions = listSessionsForTemplate.all(id).map((s) => ({
    ...s,
    confirmed_count: liveConfirmedCount.get(s.id).c,
    waitlist_count: liveWaitlistCount.get(s.id).c,
  }));
  return t;
}

/**
 * 手動開放/關閉「單一場次」的報名（is_open）。
 * 關閉（is_open=0）→ 該場次從報名頁隱藏、不可報名；現有報名不受影響，可隨時切回開放。
 * 僅適用 status='open' 的場次（已成班/未開課/結束等狀態不可切換）。
 */
export function setSessionOpen(sessionId, isOpen) {
  return tx(() => {
    const s = db.prepare('SELECT * FROM course_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new ApiError(404, 'session_not_found');
    if (s.status !== 'open') throw new ApiError(409, 'session_not_toggleable');
    const next = isOpen ? 1 : 0;
    db.prepare('UPDATE course_sessions SET is_open = ? WHERE id = ?').run(next, sessionId);
    return { ...s, is_open: next };
  });
}

export function listOpenSessions() {
  return db.prepare(`
    SELECT s.*, t.name, t.description, t.min_capacity, t.max_capacity, t.duration_minutes
    FROM course_sessions s
    JOIN course_templates t ON t.id = s.template_id
    WHERE s.status = 'open' AND s.start_at > ?
    ORDER BY s.start_at ASC
  `).all(nowLocal());
}

export function listRegistrationsBySession(sessionId) {
  return db.prepare(`
    SELECT r.*, u.name AS user_name, u.email, u.phone
    FROM registrations r
    JOIN users u ON u.id = r.user_id
    WHERE r.session_id = ?
    ORDER BY
      CASE r.status WHEN 'confirmed' THEN 0 WHEN 'waitlisted' THEN 1 ELSE 2 END,
      r.registered_at ASC
  `).all(sessionId);
}

export function listUserRegistrations(userId) {
  return db.prepare(`
    SELECT r.*, s.start_at, s.end_at, s.status AS session_status, t.name AS course_name
    FROM registrations r
    JOIN course_sessions s ON s.id = r.session_id
    JOIN course_templates t ON t.id = s.template_id
    WHERE r.user_id = ?
    ORDER BY s.start_at ASC
  `).all(userId);
}

// 截止判定：管理者或排程觸發
export function processDeadlines() {
  const dueSessions = db.prepare(`
    SELECT s.*, t.name AS course_name, t.min_capacity
    FROM course_sessions s
    JOIN course_templates t ON t.id = s.template_id
    WHERE s.status = 'open' AND s.registration_deadline <= ?
  `).all(nowLocal());

  const results = [];
  for (const s of dueSessions) {
    tx(() => {
      const confirmed = db
        .prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id = ? AND status = 'confirmed' AND on_leave = 0")
        .get(s.id).c;

      if (confirmed >= s.min_capacity) {
        db.prepare("UPDATE course_sessions SET status = 'confirmed' WHERE id = ?").run(s.id);
        const regs = db.prepare("SELECT user_id FROM registrations WHERE session_id = ? AND status = 'confirmed' AND on_leave = 0").all(s.id);
        for (const r of regs) {
          notify({ userId: r.user_id, sessionId: s.id, type: 'course_confirmed', vars: { course_name: s.course_name, start_at: s.start_at } });
        }
        notifyCourseCoach({ coachId: s.coach_id, sessionId: s.id, type: 'course_confirmed_coach', vars: { course_name: s.course_name, start_at: s.start_at, count: regs.length } });
        results.push({ sessionId: s.id, action: 'confirmed', count: regs.length });
      } else {
        db.prepare("UPDATE course_sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
        const regs = db.prepare("SELECT user_id, id, order_id FROM registrations WHERE session_id = ? AND status IN ('confirmed','waitlisted','pending') AND on_leave = 0").all(s.id);
        const upd = db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?");
        for (const r of regs) {
          upd.run(r.id);
          notify({ userId: r.user_id, sessionId: s.id, type: 'course_cancelled', vars: { course_name: s.course_name, start_at: s.start_at } });
        }
        notifyCourseCoach({ coachId: s.coach_id, sessionId: s.id, type: 'course_cancelled_coach', vars: { course_name: s.course_name, start_at: s.start_at } });
        // Release discount redemptions for any orders left with no remaining active regs.
        const affectedOrderIds = [...new Set(regs.map((r) => r.order_id).filter((oid) => oid != null))];
        for (const oid of affectedOrderIds) releaseOrderRedemptionIfInactive(oid);
        results.push({ sessionId: s.id, action: 'cancelled', count: regs.length });
      }
    });
  }
  return results;
}

// 上課前 24h 提醒
export function processReminders() {
  const now = nowLocal();
  const in24h = offsetLocal(24 * 60 * 60 * 1000);

  const sessions = db.prepare(`
    SELECT s.*, t.name AS course_name
    FROM course_sessions s
    JOIN course_templates t ON t.id = s.template_id
    WHERE s.status = 'confirmed'
      AND s.start_at BETWEEN ? AND ?
  `).all(now, in24h);

  const sent = [];
  for (const s of sessions) {
    const already = db.prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE session_id = ? AND type = 'reminder'"
    ).get(s.id).c;
    if (already > 0) continue;

    const regs = db.prepare("SELECT user_id FROM registrations WHERE session_id = ? AND status = 'confirmed'").all(s.id);
    for (const r of regs) {
      notify({ userId: r.user_id, sessionId: s.id, type: 'reminder', vars: { course_name: s.course_name, start_at: s.start_at } });
    }
    sent.push({ sessionId: s.id, count: regs.length });
  }
  return sent;
}
