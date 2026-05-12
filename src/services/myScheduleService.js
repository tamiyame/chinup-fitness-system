import { db, nowLocal } from '../db/connection.js';

const BOOKINGS_SQL = `
  SELECT b.id, b.start_at, b.end_at, b.status, b.note, b.cancel_reason,
         b.coach_id, c.display_name AS coach_display_name
  FROM bookings b
  JOIN coaches c ON c.id = b.coach_id
  WHERE b.member_id = ?
  ORDER BY b.start_at DESC
`;

const REGISTRATIONS_SQL = `
  SELECT r.id, r.status, r.position,
         s.id AS session_id, s.start_at, s.end_at, s.status AS session_status,
         t.name AS course_name, t.duration_minutes
  FROM registrations r
  JOIN course_sessions s ON s.id = r.session_id
  JOIN course_templates t ON t.id = s.template_id
  WHERE r.user_id = ?
  ORDER BY s.start_at DESC
`;

function mapBooking(b, now) {
  return {
    kind: 'booking',
    id: b.id,
    start_at: b.start_at,
    end_at: b.end_at,
    status: b.status,
    is_past: b.start_at < now,
    can_cancel: b.status === 'confirmed' && b.start_at > now,
    coach_id: b.coach_id,
    coach_display_name: b.coach_display_name,
    note: b.note,
    cancel_reason: b.cancel_reason,
    session_id: null,
    course_name: null,
    session_status: null,
    duration_minutes: null,
    position: null,
  };
}

function mapRegistration(r, now) {
  return {
    kind: 'registration',
    id: r.id,
    start_at: r.start_at,
    end_at: r.end_at,
    status: r.status,
    is_past: r.start_at < now,
    can_cancel: ['confirmed', 'waitlisted'].includes(r.status) && r.session_status === 'open',
    coach_id: null,
    coach_display_name: null,
    note: null,
    cancel_reason: null,
    session_id: r.session_id,
    course_name: r.course_name,
    session_status: r.session_status,
    duration_minutes: r.duration_minutes,
    position: r.position,
  };
}

export function listMySchedule({ userId }) {
  const now = nowLocal();
  const bookings = db.prepare(BOOKINGS_SQL).all(userId);
  const registrations = db.prepare(REGISTRATIONS_SQL).all(userId);

  const items = [
    ...bookings.map(b => mapBooking(b, now)),
    ...registrations.map(r => mapRegistration(r, now)),
  ];
  items.sort((a, b) => b.start_at.localeCompare(a.start_at));
  return items;
}
