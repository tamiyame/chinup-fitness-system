import { db } from '../db/connection.js';
import { ApiError } from './registration.js';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __serviceDir = dirname(fileURLToPath(import.meta.url));
const AVATAR_DIR = resolve(__serviceDir, '../../data/avatars');
mkdirSync(AVATAR_DIR, { recursive: true });

/** Google 日曆官方 24 色盤（登錄預約全覽的教練配色；順序照後台色卡排版）。 */
export const COACH_COLORS = [
  '#AD1457', // Radicchio
  '#D81B60', // Cherry Blossom
  '#E67C73', // Flamingo
  '#D50000', // Tomato
  '#F4511E', // Tangerine
  '#EF6C00', // Pumpkin
  '#F09300', // Mango
  '#F6BF26', // Banana
  '#E4C441', // Citron
  '#C0CA33', // Avocado
  '#7CB342', // Pistachio
  '#0B8043', // Basil
  '#33B679', // Sage
  '#009688', // Eucalyptus
  '#039BE5', // Peacock
  '#4285F4', // Cobalt
  '#7986CB', // Lavender
  '#3F51B5', // Blueberry
  '#B39DDB', // Wisteria
  '#9E69AF', // Amethyst
  '#8E24AA', // Grape
  '#795548', // Cocoa
  '#616161', // Graphite
  '#A79B8E', // Birch
];

const MAX_BYTES = 2 * 1024 * 1024;
const MAGIC = {
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
};

function detectKind(buf) {
  if (buf.length >= 4 && buf[0] === MAGIC.png[0] && buf[1] === MAGIC.png[1]) return 'png';
  if (buf.length >= 3 && buf[0] === MAGIC.jpg[0] && buf[1] === MAGIC.jpg[1] && buf[2] === MAGIC.jpg[2]) return 'jpg';
  return null;
}

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

const UPDATABLE = ['display_name', 'specialty', 'bio', 'avatar_path', 'sort_order', 'color'];
export function updateCoach(id, fields) {
  const current = getCoachStmt.get(id);
  if (!current) throw new ApiError(404, 'coach_not_found');
  // color：undefined=不動；null/'' = 清除；其餘須在 COACH_COLORS 內
  let color = fields.color;
  if (color !== undefined) {
    color = color === '' ? null : color;
    if (color !== null && !COACH_COLORS.includes(color)) throw new ApiError(400, 'invalid_color');
  }
  const snake = {
    display_name: fields.displayName ?? fields.display_name,
    specialty: fields.specialty,
    bio: fields.bio,
    avatar_path: fields.avatarPath ?? fields.avatar_path,
    sort_order: fields.sortOrder ?? fields.sort_order,
    color,
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

export function saveAvatar({ coachId, base64 }) {
  if (typeof base64 !== 'string') throw new ApiError(400, 'invalid_avatar');
  const m = base64.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  const payload = m ? m[2] : base64;
  let buf;
  try { buf = Buffer.from(payload, 'base64'); }
  catch { throw new ApiError(400, 'invalid_base64'); }
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new ApiError(413, 'avatar_too_large');
  const kind = detectKind(buf);
  if (!kind) throw new ApiError(400, 'invalid_image_type');

  const filename = `${coachId}-${randomBytes(8).toString('hex')}.${kind}`;
  const fullPath = resolve(AVATAR_DIR, filename);
  writeFileSync(fullPath, buf);

  const current = getCoachStmt.get(coachId);
  if (current && current.avatar_path) {
    const old = resolve(AVATAR_DIR, current.avatar_path);
    try { if (existsSync(old)) unlinkSync(old); } catch (e) { console.warn('[avatar] failed to delete old', e.message); }
  }

  updateCoach(coachId, { avatarPath: filename });
  return { avatar_path: filename };
}
