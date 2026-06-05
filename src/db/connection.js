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

// ── 2026-05-30 discount codes migration ──
addColumnIfMissing('group_orders', 'discount_code', 'TEXT');
addColumnIfMissing('group_orders', 'discount_amount', 'INTEGER');
addColumnIfMissing('group_orders', 'original_amount', 'INTEGER');
addColumnIfMissing('bookings', 'discount_code', 'TEXT');
addColumnIfMissing('bookings', 'discount_amount', 'INTEGER');
addColumnIfMissing('bookings', 'original_amount', 'INTEGER');

// ── 2026-05-31 單一場次手動開放/關閉 ──
// is_open=0 → 該場次從報名頁隱藏且不可報名（status 維持 open，可隨時切回）。
addColumnIfMissing('course_sessions', 'is_open', 'INTEGER NOT NULL DEFAULT 1');

// ── 2026-06-02 1對1 / 1對2 課程型態 ──
// session_type 記錄該預約是 1對1 還是 1對2，供後台對帳與教練辨識。
// 舊資料一律視為 '1on1'（ALTER ADD COLUMN 的 DEFAULT 會填入既有列）。
// 注意：SQLite 無法用 ALTER ADD COLUMN 附加 CHECK，故既有 DB 此欄無 DB 層 CHECK
// （全新 DB 由 schema.js 帶 CHECK in ('1on1','1on2')）。值的正確性由 app 層把關：
// createBookingAnon 寫入前驗證、createBooking 一律走 '1on1' 預設，無其他寫入路徑。
addColumnIfMissing('bookings', 'session_type', "TEXT NOT NULL DEFAULT '1on1'");

// ── 2026-06-05 團體課程：授課教練 ──
// course_templates.coach_id：該課程範本的授課教練（references coaches.id）。
// 教練被刪除時自動轉為 NULL（ON DELETE SET NULL），不阻擋刪除。
// 欄位可空：舊範本為 NULL，前台不顯示教練；管理者下次編輯時於前台必選補上。
addColumnIfMissing('course_templates', 'coach_id', 'INTEGER REFERENCES coaches(id) ON DELETE SET NULL');

// course_sessions.coach_id：場次層冗餘快取（展開時從範本複製），推播該堂課教練時免 join 回範本。
// 首次加欄位時一次性回填：既有場次從所屬範本複製 coach_id（範本無教練則維持 NULL）。
const csCols = db.prepare('PRAGMA table_info(course_sessions)').all().map((c) => c.name);
if (!csCols.includes('coach_id')) {
  db.exec('ALTER TABLE course_sessions ADD COLUMN coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL');
  db.exec('UPDATE course_sessions SET coach_id = (SELECT coach_id FROM course_templates WHERE id = course_sessions.template_id) WHERE coach_id IS NULL');
  console.log('[migrate] course_sessions.coach_id added + backfilled from templates');
}

// ── 2026-06-05 團課「今日請假」──
// registrations.on_leave：已付款(confirmed)會員針對某場次請假的標記。
// on_leave=1 的報名不佔名額（occupiedStmt / processDeadlines 皆排除），等同釋出座位。
// 不退款、不取消訂單；status 維持 'confirmed'（避免動到 status 的 CHECK 約束）。
addColumnIfMissing('registrations', 'on_leave', 'INTEGER NOT NULL DEFAULT 0');

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
