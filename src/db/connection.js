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
// 2026-06 會員管理：生日/地址 + 軟刪除(封存)
addColumnIfMissing('users', 'birthday', 'TEXT');
addColumnIfMissing('users', 'address', 'TEXT');
addColumnIfMissing('users', 'archived_at', 'TEXT');
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

// ── 2026-06-09 角色/權限重構：移除 owner、管理者改為「教練的權限標籤」 ──
// role 收斂為 user/coach；is_admin 標籤取代 admin/owner。
// 既有 admin/owner → role='coach' + is_admin=1；無教練檔案者補一筆未啟用(is_active=0)，
// 故不會出現在 coaches.html 公開清單，但能登入後台管理。
// 冪等：偵測訊號為「存在 role IN (admin,owner) 的列」，遷移後已無 → 重跑 no-op。
addColumnIfMissing('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
const legacyStaff = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','owner')").all();
if (legacyStaff.length) {
  const promote = db.prepare("UPDATE users SET role='coach', is_admin=1 WHERE id=?");
  const hasCoach = db.prepare('SELECT id FROM coaches WHERE user_id=?');
  const insCoach = db.prepare('INSERT INTO coaches (user_id, display_name) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const u of legacyStaff) {
      promote.run(u.id);
      if (!hasCoach.get(u.id)) insCoach.run(u.id, (u.name && u.name.trim()) || '管理者');
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  console.log(`[migrate] roles redesign: ${legacyStaff.length} admin/owner → coach+is_admin`);
}

// ── 2026-06-10 Google Calendar 整合 + 容量限制 ──
// gcal_event_id：「日曆上已有事件」旗標（建立成功寫入、刪除成功清空，reconcile 依此補建/補刪）。
// customer_email：確認信收件位址（不寫 users.email——那是員工登入識別且有 UNIQUE partial index）。
// notifications.recipient：email 通知收件位址（LINE 通知為 NULL），重試時直接取用。
addColumnIfMissing('bookings', 'gcal_event_id', 'TEXT');
addColumnIfMissing('bookings', 'customer_email', 'TEXT');
addColumnIfMissing('notifications', 'recipient', 'TEXT');

// ── 2026-06-12 取消並退款（已核對款項的逆向操作）──
// refunded_at/refunded_by：退款紀錄（金流由店家線下匯回，系統只記錄）。已退款項目保留在「已核對匯款」清單供對帳。
addColumnIfMissing('bookings', 'refunded_at', 'TEXT');
addColumnIfMissing('bookings', 'refunded_by', 'INTEGER REFERENCES users(id)');
addColumnIfMissing('group_orders', 'refunded_at', 'TEXT');
addColumnIfMissing('group_orders', 'refunded_by', 'INTEGER REFERENCES users(id)');

// ── 2026-06-12 循環預約 ──
// recurring_group_id：同一串循環預約存「首堂 booking id」（供未來整串操作；本版僅落資料）。
addColumnIfMissing('bookings', 'recurring_group_id', 'INTEGER');

// ── 2026-06-24 方案（套餐）系統 ──
// customer_packages 表由 SCHEMA 的 CREATE TABLE IF NOT EXISTS 建立（含既有 DB）。
// bookings.package_id：扣抵來源方案（NULL=非方案預約）。取消預約時回補該方案 1 堂。
addColumnIfMissing('bookings', 'package_id', 'INTEGER REFERENCES customer_packages(id)');
addColumnIfMissing('customer_packages', 'discount_code', 'TEXT');

// ── 2026-06-12 教練課付款狀態流 ──
// paid_at NULL=待核對、非 NULL=已核對（鏡像 group_orders.paid_at/paid_by；status 不變，佔時段/容量照舊）。
// 一次性 backfill（偵測訊號=欄位不存在）：上線當下過去場次視為已核對、未來場次留 NULL 進待核對（業主決策）。
const bkPayCols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (!bkPayCols.includes('paid_at')) {
  db.exec('ALTER TABLE bookings ADD COLUMN paid_at TEXT');
  db.exec('ALTER TABLE bookings ADD COLUMN paid_by INTEGER REFERENCES users(id)');
  const { changes } = db.prepare(
    "UPDATE bookings SET paid_at = created_at WHERE status='confirmed' AND paid_at IS NULL AND start_at < ?"
  ).run(nowLocal());
  console.log(`[migrate] bookings.paid_at/paid_by added; ${changes} past bookings backfilled as paid`);
}

// ── 2026-07-08 教練行事曆顏色 ──
// coaches.color：登錄預約「全部教練」週曆的教練配色（Google 日曆官方 24 色盤其一），NULL=預設（維持現行藍色）。
addColumnIfMissing('coaches', 'color', 'TEXT');

// ── 2026-07-09 駐場打卡與時薪 ──
// coaches.hourly_rate：駐場時薪（元/小時）。NULL=不參與駐場薪資。即時制（計算當下取現值，不存歷史）。
addColumnIfMissing('coaches', 'hourly_rate', 'INTEGER');

// ── 2026-07-09 固定時段＋指派教練 ──
// coach_shifts.slot_id：所屬館方時段（gym_slots）。ALTER 加欄的 REFERENCES 實際具強制力
// （node:sqlite 實測：非法插入被拒、CASCADE 有效）；service 層仍顯式連動，作為語意自我文件化與雙保險。
addColumnIfMissing('coach_shifts', 'slot_id', 'INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE');

// ── 2026-08-25 期課雙月期別自動續開 ──
// course_templates.auto_renew：1=每期最後一週自動延長到下期末並補場次（預設）；0=不續（本期剩餘場次照常）。
// 一次性回填（app_settings 旗標守門，只做一次、不覆蓋業主之後的手動設定）：
// 升級當下仍在效期內（結束日 ≥ 今天）的範本視為續開中 → 1；早已結束的舊範本 → 0，避免下次換期被翻出來。
addColumnIfMissing('course_templates', 'auto_renew', 'INTEGER NOT NULL DEFAULT 1');
{
  const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'auto_renew_backfill_done'").get();
  if (flag?.value !== '1') {
    const { changes } = db.prepare(
      'UPDATE course_templates SET auto_renew = CASE WHEN cycle_end_date >= ? THEN 1 ELSE 0 END'
    ).run(nowLocal().slice(0, 10));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('auto_renew_backfill_done', '1')").run();
    if (changes) console.log(`[migrate] course_templates.auto_renew backfilled for ${changes} templates`);
  }
}

/** 歸組 backfill：slot_id IS NULL 的既有班表按（星期＋起訖＋生效起迄）分組建 gym_slots 並回填。
 *  冪等（無 NULL 列＝no-op）。回傳本次建立的時段數。
 *  一次性 legacy 歸組；不與既有時段合併（重跑只處理新的 NULL 列）。 */
export function backfillGymSlots() {
  const orphans = db.prepare('SELECT * FROM coach_shifts WHERE slot_id IS NULL ORDER BY id ASC').all();
  if (!orphans.length) return 0;
  const insertSlot = db.prepare('INSERT INTO gym_slots (day_of_week, start_time, end_time, effective_from, effective_to) VALUES (?, ?, ?, ?, ?)');
  const setSlot = db.prepare('UPDATE coach_shifts SET slot_id = ? WHERE id = ?');
  const groups = new Map();
  for (const r of orphans) {
    const key = [r.day_of_week, r.start_time, r.end_time, r.effective_from, r.effective_to ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let created = 0;
  db.exec('BEGIN');
  try {
    for (const rows of groups.values()) {
      const r0 = rows[0];
      const slotId = Number(insertSlot.run(r0.day_of_week, r0.start_time, r0.end_time, r0.effective_from, r0.effective_to).lastInsertRowid);
      created++;
      for (const r of rows) setSlot.run(slotId, r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  console.log(`[migrate] gym_slots 歸組：${orphans.length} 列班表 → ${created} 個時段`);
  return created;
}
backfillGymSlots();

// NOTE: initial role bootstrap has run in production.
// Removed because the guard `role='user'` made demoted accounts get
// re-promoted on every boot — owners' role changes weren't sticky.
// Going forward, roles are managed exclusively through the /api/admin/users
// endpoint by the owner.

// NOTE: default course-category seeding removed (2026-08-08). The old
// INSERT OR IGNORE block re-created the six starter categories on every
// boot after the owner deleted them — same resurrection bug as the role
// bootstrap above. Categories are owner-managed via the admin UI only;
// nothing in code or tests depends on any category existing.

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
