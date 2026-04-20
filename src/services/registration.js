import { db, tx, nowLocal } from '../db/connection.js';
import { notify } from './notifications.js';

export class ApiError extends Error {
  constructor(status, code, detail = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// 查詢語句（preparedStatement 重用）
const getSession = db.prepare('SELECT * FROM course_sessions WHERE id = ?');
const getTemplate = db.prepare('SELECT * FROM course_templates WHERE id = ?');
const getExistingReg = db.prepare(
  "SELECT * FROM registrations WHERE session_id = ? AND user_id = ? AND status IN ('confirmed','waitlisted')"
);
const insertReg = db.prepare(
  'INSERT INTO registrations (session_id, user_id, status, position) VALUES (?, ?, ?, ?)'
);
const updateSessionCounts = db.prepare(
  'UPDATE course_sessions SET confirmed_count = ?, waitlist_count = ? WHERE id = ?'
);
const getConfirmedCount = db.prepare(
  "SELECT COUNT(*) AS c FROM registrations WHERE session_id = ? AND status = 'confirmed'"
);
const getWaitlistQueue = db.prepare(
  "SELECT * FROM registrations WHERE session_id = ? AND status = 'waitlisted' ORDER BY registered_at ASC, id ASC"
);
const updateRegStatus = db.prepare('UPDATE registrations SET status = ?, position = ? WHERE id = ?');

function recalcAndSave(sessionId) {
  const confirmed = db
    .prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id = ? AND status = 'confirmed'")
    .get(sessionId).c;
  const waitlist = db
    .prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id = ? AND status = 'waitlisted'")
    .get(sessionId).c;
  updateSessionCounts.run(confirmed, waitlist, sessionId);
  return { confirmed, waitlist };
}

function renumberWaitlist(sessionId) {
  const queue = getWaitlistQueue.all(sessionId);
  const update = db.prepare("UPDATE registrations SET position = ? WHERE id = ?");
  queue.forEach((r, idx) => update.run(idx + 1, r.id));
}

export function register({ sessionId, userId }) {
  return tx(() => {
    const session = getSession.get(sessionId);
    if (!session) throw new ApiError(404, 'session_not_found');
    if (session.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
    if (session.status === 'completed') throw new ApiError(409, 'session_completed');

    if (nowLocal() > session.registration_deadline) throw new ApiError(409, 'registration_closed');

    const existing = getExistingReg.get(sessionId, userId);
    if (existing) throw new ApiError(409, 'already_registered');

    const tpl = getTemplate.get(session.template_id);
    const confirmed = getConfirmedCount.get(sessionId).c;

    let status, position;
    if (confirmed < tpl.max_capacity) {
      status = 'confirmed';
      position = null;
    } else {
      status = 'waitlisted';
      position = session.waitlist_count + 1;
    }

    const info = insertReg.run(sessionId, userId, status, position);
    recalcAndSave(sessionId);

    const vars = {
      course_name: tpl.name,
      start_at: session.start_at,
      position,
    };
    notify({
      userId,
      sessionId,
      type: status === 'confirmed' ? 'registered_confirmed' : 'registered_waitlisted',
      vars,
    });

    return { registrationId: info.lastInsertRowid, status, position };
  });
}

export function cancelRegistration({ registrationId, userId }) {
  return tx(() => {
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registrationId);
    if (!reg) throw new ApiError(404, 'registration_not_found');
    if (reg.user_id !== userId) throw new ApiError(403, 'forbidden');
    if (reg.status === 'cancelled') throw new ApiError(409, 'already_cancelled');

    const session = getSession.get(reg.session_id);
    const tpl = getTemplate.get(session.template_id);

    const wasConfirmed = reg.status === 'confirmed';
    updateRegStatus.run('cancelled', null, reg.id);

    notify({
      userId,
      sessionId: session.id,
      type: 'registration_cancelled',
      vars: { course_name: tpl.name, start_at: session.start_at },
    });

    // 若原為正取且場次未取消，候補第一位遞補
    if (wasConfirmed && session.status !== 'cancelled') {
      const queue = getWaitlistQueue.all(session.id);
      if (queue.length > 0) {
        const next = queue[0];
        updateRegStatus.run('confirmed', null, next.id);
        notify({
          userId: next.user_id,
          sessionId: session.id,
          type: 'promoted',
          vars: { course_name: tpl.name, start_at: session.start_at },
        });
      }
    }

    recalcAndSave(session.id);
    renumberWaitlist(session.id);

    return { ok: true };
  });
}
