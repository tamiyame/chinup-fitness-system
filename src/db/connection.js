import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SCHEMA } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '../../data/app.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Auto-apply schema on connection open. Idempotent (CREATE TABLE IF NOT EXISTS).
// Ensures services' top-level `db.prepare(...)` statements have tables available.
db.exec(SCHEMA);

// In-place migrations for schema evolution. Each step must be idempotent so
// running against a fresh DB or an older DB both end in the same state.
function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

if (!columnExists('users', 'google_id')) {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
}
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL'
);

// NOTE: initial role bootstrap has run in production.
// Removed because the guard `role='user'` made demoted accounts get
// re-promoted on every boot — owners' role changes weren't sticky.
// Going forward, roles are managed exclusively through the /api/admin/users
// endpoint by the owner.

// 本地 wall-clock 時間字串：與 schedule.js 儲存格式一致。
export function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function offsetLocal(ms) {
  const d = new Date(Date.now() + ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 手動 transaction 包裝。node:sqlite 尚未內建 transaction API。
// 使用 IMMEDIATE 以避免寫入競態 (serialise writes)。
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}
