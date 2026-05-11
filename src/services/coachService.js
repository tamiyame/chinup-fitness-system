import { db } from '../db/connection.js';
import { ApiError } from './registration.js';

const insertCoach = db.prepare(`
  INSERT INTO coaches (user_id, display_name, specialty, bio, avatar_path, is_active, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getCoachStmt = db.prepare('SELECT * FROM coaches WHERE id = ?');
const getCoachByUserId = db.prepare('SELECT * FROM coaches WHERE user_id = ?');
const listAllStmt = db.prepare('SELECT * FROM coaches ORDER BY sort_order ASC, id ASC');
const listActiveStmt = db.prepare(
  'SELECT * FROM coaches WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
);
const setActiveStmt = db.prepare(
  "UPDATE coaches SET is_active = ?, updated_at = datetime('now') WHERE id = ?"
);

export function createCoach({ userId, displayName, specialty = null, bio = null, avatarPath = null, sortOrder = 0 }) {
  if (!userId) throw new ApiError(400, 'missing_user_id');
  if (!displayName || !displayName.trim()) throw new ApiError(400, 'missing_display_name');
  try {
    const info = insertCoach.run(userId, displayName.trim(), specialty, bio, avatarPath, 0, sortOrder);
    return { id: info.lastInsertRowid };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'coach_exists');
    throw e;
  }
}

export function getCoach(id) {
  return getCoachStmt.get(id) || null;
}

export function getCoachByUser(userId) {
  return getCoachByUserId.get(userId) || null;
}

export function listAllCoaches() {
  return listAllStmt.all();
}

export function listActiveCoaches() {
  return listActiveStmt.all();
}

export function setCoachActive(id, active) {
  const info = setActiveStmt.run(active ? 1 : 0, id);
  if (info.changes === 0) throw new ApiError(404, 'coach_not_found');
  return { ok: true };
}

const UPDATABLE = ['display_name', 'specialty', 'bio', 'avatar_path', 'sort_order'];
export function updateCoach(id, fields) {
  const current = getCoachStmt.get(id);
  if (!current) throw new ApiError(404, 'coach_not_found');
  const snake = {
    display_name: fields.displayName ?? fields.display_name,
    specialty: fields.specialty,
    bio: fields.bio,
    avatar_path: fields.avatarPath ?? fields.avatar_path,
    sort_order: fields.sortOrder ?? fields.sort_order,
  };
  const cols = [], vals = [];
  for (const k of UPDATABLE) {
    if (snake[k] !== undefined) {
      cols.push(`${k} = ?`);
      vals.push(snake[k]);
    }
  }
  if (cols.length === 0) return { ok: true, unchanged: true };
  cols.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE coaches SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true };
}
