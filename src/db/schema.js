// Single source of truth for schema DDL. Used by connection.js to auto-apply
// on startup (idempotent) and by migrate.js CLI for explicit runs.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  password_hash TEXT,
  google_id TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  is_admin INTEGER NOT NULL DEFAULT 0,
  notification_preference TEXT NOT NULL DEFAULT 'email',
  line_user_id TEXT,
  line_bind_code TEXT,
  line_bind_expires_at TEXT,
  birthday TEXT,
  address TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS course_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS course_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  min_capacity INTEGER NOT NULL,
  max_capacity INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  recurrence TEXT NOT NULL CHECK(recurrence IN ('weekly','monthly','bimonthly','quarterly','semiannual')),
  cycle_start_date TEXT NOT NULL,
  cycle_end_date TEXT NOT NULL,
  registration_deadline_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','archived')),
  price_per_session INTEGER NOT NULL DEFAULT 0,
  coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  refunded_at TEXT,
  refunded_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  discount_code TEXT,
  discount_amount INTEGER,
  original_amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_orders_status ON group_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_group_orders_member ON group_orders(member_id);

CREATE TABLE IF NOT EXISTS course_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES course_templates(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  registration_deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','confirmed','cancelled','completed')),
  is_open INTEGER NOT NULL DEFAULT 1,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  waitlist_count INTEGER NOT NULL DEFAULT 0,
  coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  UNIQUE(template_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_sessions_start ON course_sessions(start_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON course_sessions(status);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','waitlisted','cancelled','rejected')),
  position INTEGER,
  order_id INTEGER REFERENCES group_orders(id),
  amount_due INTEGER,
  on_leave INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reg_session_status ON registrations(session_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES course_sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  recipient TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  specialty TEXT,
  bio TEXT,
  avatar_path TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_availability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);

CREATE TABLE IF NOT EXISTS coach_availability_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('leave', 'extra')),
  start_time TEXT,
  end_time TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (type = 'leave' OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time))
);

-- 館方固定上班時段（老闆先建時段、再指派教練；指派展開成 coach_shifts 列）
CREATE TABLE IF NOT EXISTS gym_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);

-- 駐場固定週班表（時薪計酬的排班；可預約時段是另一張 coach_availability_rules，勿混用）
CREATE TABLE IF NOT EXISTS coach_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  slot_id INTEGER REFERENCES gym_slots(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_coach_shifts_coach ON coach_shifts(coach_id);

-- 駐場出席紀錄：起訖/時數為打卡當下快照（改班表不影響歷史）；voided_at 軟刪（薪資排除、留檔）。
CREATE TABLE IF NOT EXISTS shift_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id),
  shift_id INTEGER REFERENCES coach_shifts(id) ON DELETE SET NULL,
  work_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  hours REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('checkin','manual')),
  checked_in_at TEXT,
  lat REAL, lng REAL, accuracy REAL, distance_m INTEGER,
  created_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(coach_id, work_date, shift_id)
);
CREATE INDEX IF NOT EXISTS idx_shift_attendance_date ON shift_attendance(work_date);

CREATE TABLE IF NOT EXISTS customer_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK (session_type IN ('1on1','1on2')),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  remaining_sessions INTEGER NOT NULL CHECK (remaining_sessions >= 0),
  amount INTEGER,
  expires_at TEXT,
  note TEXT,
  discount_code TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_packages_member ON customer_packages(member_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  session_type TEXT NOT NULL DEFAULT '1on1' CHECK (session_type IN ('1on1', '1on2')),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  note TEXT,
  discount_code TEXT,
  discount_amount INTEGER,
  original_amount INTEGER,
  gcal_event_id TEXT,
  customer_email TEXT,
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  refunded_at TEXT,
  refunded_by INTEGER REFERENCES users(id),
  recurring_group_id INTEGER,
  package_id INTEGER REFERENCES customer_packages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_at < end_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_coach_start_confirmed
  ON bookings(coach_id, start_at) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_coach_status ON bookings(coach_id, status);
CREATE INDEX IF NOT EXISTS idx_availability_rules_coach ON coach_availability_rules(coach_id);
CREATE INDEX IF NOT EXISTS idx_availability_exceptions_coach_date ON coach_availability_exceptions(coach_id, exception_date);

CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  max_uses INTEGER,
  per_phone_limit INTEGER,
  min_amount INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discount_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES discount_codes(id),
  phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('group_order','booking')),
  ref_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_code ON discount_redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_code_phone ON discount_redemptions(code_id, phone);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('one_on_one_price', '1500');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('one_on_two_price', '2000');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('bank_info', '合作金庫 (006) 0640765-607824 戶名：許秉毅');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('line_official_url', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('line_official_id', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('gcal_calendar_id', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('booking_hourly_capacity', '3');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('group_order_expiry_hours', '72');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_tier_threshold', '40');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_pct_low', '50');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_pct_high', '60');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_group_pct', '50');

CREATE TABLE IF NOT EXISTS point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pool TEXT NOT NULL CHECK (pool IN ('one_on_one', 'group')),
  amount INTEGER NOT NULL,
  note TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN (
    'admin_grant',
    'booking_deduct',
    'booking_refund',
    'registration_deduct',
    'registration_refund',
    'session_refund'
  )),
  related_booking_id INTEGER REFERENCES bookings(id),
  related_session_id INTEGER REFERENCES course_sessions(id),
  related_registration_id INTEGER REFERENCES registrations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount != 0)
);

CREATE INDEX IF NOT EXISTS idx_point_tx_member_pool ON point_transactions(member_id, pool);
CREATE INDEX IF NOT EXISTS idx_point_tx_created ON point_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_point_tx_booking ON point_transactions(related_booking_id);
CREATE INDEX IF NOT EXISTS idx_point_tx_registration ON point_transactions(related_registration_id);

CREATE TABLE IF NOT EXISTS renewal_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('package','group')),
  member_id INTEGER NOT NULL REFERENCES users(id),
  ref_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_reminders_key ON renewal_reminders(kind, member_id, ref_id);

CREATE TABLE IF NOT EXISTS group_order_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES group_orders(id) ON DELETE CASCADE,
  registration_id INTEGER REFERENCES registrations(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  refunded_at TEXT NOT NULL,
  refunded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_order_refunds_order ON group_order_refunds(order_id);
`;

// Indexes for Phase 3C columns are kept OUT of the SCHEMA string so that
// existing DBs (whose columns are added later via addColumnIfMissing) can
// create the indexes AFTER migrations run. Fresh DBs get the indexes
// from PHASE_3C_INDEXES on first boot after the columns are created via
// the CREATE TABLE blocks above.
export const PHASE_3C_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id
  ON users(line_user_id) WHERE line_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_retry
  ON notifications(status, next_retry_at) WHERE status = 'failed';
`;
