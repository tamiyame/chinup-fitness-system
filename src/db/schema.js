// Single source of truth for schema DDL. Used by connection.js to auto-apply
// on startup (idempotent) and by migrate.js CLI for explicit runs.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS course_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES course_templates(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  registration_deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','confirmed','cancelled','completed')),
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  waitlist_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(template_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_sessions_start ON course_sessions(start_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON course_sessions(status);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('confirmed','waitlisted','cancelled','rejected')),
  position INTEGER,
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

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_at < end_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_coach_start_confirmed
  ON bookings(coach_id, start_at) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_coach_status ON bookings(coach_id, status);
CREATE INDEX IF NOT EXISTS idx_availability_rules_coach ON coach_availability_rules(coach_id);
CREATE INDEX IF NOT EXISTS idx_availability_exceptions_coach_date ON coach_availability_exceptions(coach_id, exception_date);

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

CREATE VIEW IF NOT EXISTS member_point_balance AS
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
`;

export const PHASE_3C_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id
  ON users(line_user_id) WHERE line_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_retry
  ON notifications(status, next_retry_at) WHERE status = 'failed';
`;
