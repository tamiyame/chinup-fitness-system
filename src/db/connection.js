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

db.exec(PHASE_3C_INDEXES);

// ── 2026-05 anon-booking redesign migration ──────────────────────────
// (a) group_orders 表（SCHEMA 已含 CREATE IF NOT EXISTS，這裡確保舊 DB 也有；
//     必須在 registrations rebuild 之前存在，因 registrations FK 指向它)
// (b) registrations: 加 pending 狀態 + order_id/amount_due → 整表 rebuild
// (c) users: email DROP NOT NULL → 整表 rebuild（同時 DROP 已棄用的 view）
// (d) course_templates.price_per_session
// 偵測訊號各自獨立，重跑為 no-op (idempotent)。

// (b) registrations rebuild — 以 order_id 欄位是否存在當偵測訊號
const regCols = db.prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);
if (!regCols.includes('order_id')) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE registrations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','waitlisted','cancelled','rejected')),
        position INTEGER,
        order_id INTEGER REFERENCES group_orders(id),
        amount_due INTEGER,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, user_id)
      )`);
    db.exec(`
      INSERT INTO registrations_new (id, session_id, user_id, status, position, registered_at)
      SELECT id, session_id, user_id, status, position, registered_at FROM registrations`);
    db.exec('DROP TABLE registrations');
    db.exec('ALTER TABLE registrations_new RENAME TO registrations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_reg_session_status ON registrations(session_id, status)');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[migrate] registrations rebuilt (pending status + order_id/amount_due)');
}

// (c) users email nullable — 以 email 欄 notnull 旗標當偵測訊號
const emailCol = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
if (emailCol && emailCol.notnull === 1) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec('DROP VIEW IF EXISTS member_point_balance');
    db.exec(`
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
      )`);
    db.exec(`
      INSERT INTO users_new (id, name, email, phone, password_hash, google_id, role,
        notification_preference, line_user_id, line_bind_code, line_bind_expires_at, created_at)
      SELECT id, name, email, phone, password_hash, google_id, role,
        notification_preference, line_user_id, line_bind_code, line_bind_expires_at, created_at
      FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id ON users(line_user_id) WHERE line_user_id IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[migrate] users rebuilt (email nullable, view dropped)');
}

// 確保 view 在已是 nullable 的 DB 也被移除（rebuild 分支沒跑到時）
db.exec('DROP VIEW IF EXISTS member_point_balance');

// (d) price_per_session
addColumnIfMissing('course_templates', 'price_per_session', 'INTEGER NOT NULL DEFAULT 0');

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
