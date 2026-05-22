import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SCHEMA, PHASE_3C_INDEXES } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '../../data/app.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Auto-apply schema on connection open. Idempotent (CREATE TABLE IF NOT EXISTS).
// Ensures services' top-level `db.prepare(...)` statements have tables available.
db.exec(SCHEMA);

// Unified helper for idempotent column additions. Used for both legacy
// migrations and Phase 3C column additions below.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Legacy migration: google_id column added after initial schema was deployed.
addColumnIfMissing('users', 'google_id', 'TEXT');
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL'
);

// Phase 3C: idempotent column additions for existing DBs.
// Fresh DBs already have these columns from the CREATE TABLE above,
// so the PRAGMA check finds them and skips the ALTER.
addColumnIfMissing('users', 'line_user_id', 'TEXT');
addColumnIfMissing('users', 'line_bind_code', 'TEXT');
addColumnIfMissing('users', 'line_bind_expires_at', 'TEXT');
addColumnIfMissing('notifications', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('notifications', 'next_retry_at', 'TEXT');
addColumnIfMissing('notifications', 'last_error', 'TEXT');

// Phase 4: drop NOT NULL on users.email if it's still NOT NULL.
// SQLite can't ALTER COLUMN — use the official "table rebuild" recipe.
function migrateUsersEmailNullable() {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const emailCol = cols.find((c) => c.name === 'email');
  if (!emailCol || emailCol.notnull === 0) return;  // already nullable
  console.log('[migration] rebuilding users table to drop NOT NULL on email');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      DROP VIEW IF EXISTS member_point_balance;
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT,
        password_hash TEXT,
        google_id TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        notification_preference TEXT NOT NULL DEFAULT 'email',
        line_user_id TEXT,
        line_bind_code TEXT,
        line_bind_expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, name, email, phone, password_hash, google_id, role,
                             notification_preference, line_user_id, line_bind_code,
                             line_bind_expires_at, created_at)
        SELECT id, name, email, phone, password_hash, google_id, role,
               notification_preference, line_user_id, line_bind_code,
               line_bind_expires_at, created_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
        ON users(google_id) WHERE google_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
        ON users(phone) WHERE phone IS NOT NULL;
      CREATE VIEW member_point_balance AS
      SELECT
        u.id AS member_id,
        u.name,
        u.email,
        COALESCE(SUM(CASE WHEN pt.pool = 'one_on_one' THEN pt.amount ELSE 0 END), 0) AS one_on_one_balance,
        COALESCE(SUM(CASE WHEN pt.pool = 'group' THEN pt.amount ELSE 0 END), 0) AS group_balance
      FROM users u
      LEFT JOIN point_transactions pt ON pt.member_id = u.id
      WHERE u.role = 'user'
      GROUP BY u.id;
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateUsersEmailNullable();

db.exec(PHASE_3C_INDEXES);

// NOTE: initial role bootstrap has run in production.
// Removed because the guard `role='user'` made demoted accounts get
// re-promoted on every boot — owners' role changes weren't sticky.
// Going forward, roles are managed exclusively through the /api/admin/users
// endpoint by the owner.

// Seed default course categories on first boot. Uses INSERT OR IGNORE so
// deletions by the admin don't re-appear and re-runs are no-ops.
const defaultCategories = [
  { name: '重量訓練', description: '肌力與阻力訓練', sort_order: 10 },
  { name: 'TRX',    description: '懸吊阻力訓練',    sort_order: 20 },
  { name: 'HIIT',   description: '高強度間歇訓練',  sort_order: 30 },
  { name: '綜合體能', description: '多元體能訓練',   sort_order: 40 },
  { name: '瑜伽',    description: '流動瑜伽與伸展', sort_order: 50 },
  { name: '核心訓練', description: '核心穩定與控制', sort_order: 60 },
];
const insertCat = db.prepare(
  'INSERT OR IGNORE INTO course_categories (name, description, sort_order) VALUES (?, ?, ?)'
);
for (const c of defaultCategories) {
  insertCat.run(c.name, c.description, c.sort_order);
}

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
// 支援巢狀呼叫：內層 tx() 不會開新 transaction，直接執行並由外層管理提交／回滾。
let _txDepth = 0;
export function tx(fn) {
  if (_txDepth > 0) {
    // Already inside a transaction — run fn() directly; outer tx handles commit/rollback.
    return fn();
  }
  _txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    _txDepth--;
  }
}
