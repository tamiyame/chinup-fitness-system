import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertBooking = db.prepare(`
  INSERT INTO bookings (coach_id, member_id, start_at, end_at, note)
  VALUES (?, ?, ?, ?, ?)
`);

export function createBooking({ coachId, memberId, startAt, note = null }) {
  const endAt = addMinutes(startAt, 60);
  try {
    const info = insertBooking.run(coachId, memberId, startAt, endAt, note);
    return { id: info.lastInsertRowid, startAt, endAt };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'slot_taken');
    throw e;
  }
}

function addMinutes(localTs, minutes) {
  const d = new Date(localTs);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
